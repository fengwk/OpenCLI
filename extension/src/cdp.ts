/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (resolveTabId in background.ts filters them).
 */

const attached = new Set<number>();

const tabFrameContexts = new Map<number, Map<string, number>>();
const frameTargets = new Map<string, string>();
const frameTargetKeys = new Map<string, string>();
let frameTargetCleanupRegistered = false;

// Large cap so agents stop hitting silent JSON.parse failures on real API bodies.
// See src/browser/cdp.ts CDP_RESPONSE_BODY_CAPTURE_LIMIT for the matching constant
// on the direct-CDP path. Keep in sync.
const CDP_RESPONSE_BODY_CAPTURE_LIMIT = 8 * 1024 * 1024;
const CDP_REQUEST_BODY_CAPTURE_LIMIT = 1 * 1024 * 1024;
// Stream frames can be frequent; keep per-frame payload bounded and drop oldest
// frames when the ring is full so a long agent turn cannot OOM the service worker.
const CDP_WS_FRAME_PAYLOAD_LIMIT = 1 * 1024 * 1024;
const CDP_WS_FRAME_BUFFER_LIMIT = 10_000;

type NetworkCaptureEntry = {
  kind: 'cdp';
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  requestBodyKind?: string;
  requestBodyPreview?: string;
  requestBodyFullSize?: number;
  requestBodyTruncated?: boolean;
  responseStatus?: number;
  responseContentType?: string;
  responseHeaders?: Record<string, string>;
  responsePreview?: string;
  responseBodyFullSize?: number;
  responseBodyTruncated?: boolean;
  timestamp: number;
};

type NetworkCaptureState = {
  patterns: string[];
  entries: NetworkCaptureEntry[];
  requestToIndex: Map<string, number>;
};

export type WsCaptureEntry = {
  kind: 'ws-frame';
  url: string;
  requestId: string;
  timestamp: number;
  direction: 'received' | 'sent';
  opcode: number;
  payload: string;
  payloadFullSize: number;
  payloadTruncated: boolean;
};

type WsCaptureState = {
  patterns: string[];
  entries: WsCaptureEntry[];
  /** requestId → WebSocket URL observed via Network.webSocketCreated */
  requestIdToUrl: Map<string, string>;
  /** requestIds whose Created URL failed the filter — never capture their frames */
  rejectedRequestIds: Set<string>;
  /** Frames dropped because the ring buffer was full (oldest-evicted count). */
  dropped: number;
};

export type DownloadWaitResult = {
  downloaded: boolean;
  id?: number;
  filename?: string;
  url?: string;
  finalUrl?: string;
  mime?: string;
  totalBytes?: number;
  state?: string;
  danger?: string;
  error?: string;
  elapsedMs: number;
};

const networkCaptures = new Map<number, NetworkCaptureState>();
const wsCaptures = new Map<number, WsCaptureState>();

/**
 * Default deadline for a single chrome.debugger command. chrome.debugger has
 * no timeout of its own: a page-blocking native dialog (alert/confirm/print/
 * beforeunload) makes Runtime.evaluate hang forever, wedging every later
 * command on the tab. Long enough for legitimate in-page waits (default 30s
 * plus headroom), short enough to fail before the daemon's 120s timer.
 */
const CDP_COMMAND_TIMEOUT_MS = 60_000;
/** Health-check probe deadline — a blocked probe should fail fast. */
const CDP_PROBE_TIMEOUT_MS = 2_000;

/**
 * chrome.debugger.sendCommand with a deadline. The underlying command cannot
 * be cancelled — this only unblocks the caller so the CLI gets an error
 * instead of an infinite hang.
 */
export async function sendDebuggerCommand<T = unknown>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const commandPromise = (params === undefined
    ? chrome.debugger.sendCommand(target, method)
    : chrome.debugger.sendCommand(target, method, params)) as Promise<T>;
  // If the timeout wins the race, the command promise may still reject much
  // later (e.g. debugger detach on tab close) — swallow that on a side branch
  // so it never surfaces as an unhandled rejection in the service worker.
  commandPromise.catch(() => {});
  try {
    return await Promise.race([
      commandPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `CDP command ${method} timed out after ${Math.round(timeoutMs / 1000)}s — the page may be blocked by a native dialog (alert/confirm/print)`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

export async function ensureAttached(tabId: number, aggressiveRetry: boolean = false): Promise<void> {
  // Verify the tab URL is debuggable before attempting attach
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl(tab.url)) {
      // Invalidate cache if previously attached
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`);
    }
  } catch (e) {
    // Re-throw our own error, catch only chrome.tabs.get failures
    if (e instanceof Error && e.message.startsWith('Cannot debug tab')) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }

  if (attached.has(tabId)) {
    // Verify the debugger is still actually attached by sending a harmless command
    try {
      await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1', returnByValue: true,
      }, CDP_PROBE_TIMEOUT_MS);
      return; // Still attached and working
    } catch {
      // Stale cache entry — need to re-attach
      attached.delete(tabId);
    }
  }

  // Retry attach up to 3 times — other extensions (1Password, Playwright MCP Bridge)
  // can temporarily interfere with chrome.debugger. A short delay usually resolves it.
  // Normal commands: 2 retries, 500ms delay (fast fail for non-browser use)
  // Browser commands: 5 retries, 1500ms delay (aggressive, tolerates extension interference)
  const MAX_ATTACH_RETRIES = aggressiveRetry ? 5 : 2;
  const RETRY_DELAY_MS = aggressiveRetry ? 1500 : 500;
  let lastError = '';

  // The forced detach below fires chrome.debugger.onDetach, whose handler wipes
  // this tab's armed network/ws-capture state; detaching also disables the CDP
  // Network domain. Snapshot the capture so we can restore it after a successful
  // re-attach instead of silently dropping in-flight capture — otherwise any
  // non-navigate command that triggers a re-attach (a stale-attach health-check
  // failure during SPA navigation or third-party debugger interference) leaves
  // network-capture-read / ws-capture-read returning [] even though traffic fired.
  const preservedNetworkCapture = networkCaptures.get(tabId);
  const preservedWsCapture = wsCaptures.get(tabId);

  for (let attempt = 1; attempt <= MAX_ATTACH_RETRIES; attempt++) {
    try {
      // Force detach first to clear any stale state from other extensions
      try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
      await chrome.debugger.attach({ tabId }, '1.3');
      lastError = '';
      break; // Success
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTACH_RETRIES) {
        console.warn(`[opencli] attach attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // Re-verify tab URL before retrying (it may have changed)
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!isDebuggableUrl(tab.url)) {
            lastError = `Tab URL changed to ${tab.url} during retry`;
            break; // Don't retry if URL became un-debuggable
          }
        } catch {
          // Tab is gone — don't fail early here.
          // Later retry layers can re-resolve a fresh automation tab/window.
          lastError = `Tab ${tabId} no longer exists`;
          // Don't break; fall through to retry
        }
      }
    }
  }

  if (lastError) {
    // Log detailed diagnostics for debugging extension conflicts
    let finalUrl = 'unknown';
    let finalWindowId = 'unknown';
    try {
      const tab = await chrome.tabs.get(tabId);
      finalUrl = tab.url ?? 'undefined';
      finalWindowId = String(tab.windowId);
    } catch { /* tab gone */ }
    console.warn(`[opencli] attach failed for tab ${tabId}: url=${finalUrl}, windowId=${finalWindowId}, error=${lastError}`);

    const hint = lastError.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';
    throw new Error(`attach failed: ${lastError}${hint}`);
  }
  attached.add(tabId);

  try {
    await sendDebuggerCommand({ tabId }, 'Runtime.enable');
  } catch {
    // Some pages may not need explicit enable
  }

  // Restore network/ws capture that the re-attach (detach + onDetach) tore down.
  // The detach always disables the CDP Network domain, so re-enable it and put
  // the accumulated capture state back unconditionally. Done last (after the
  // awaits above) so it wins over the onDetach handler's delete, which fires
  // while those awaits yield to the event loop.
  if (preservedNetworkCapture || preservedWsCapture) {
    try {
      await sendDebuggerCommand({ tabId }, 'Network.enable');
      if (preservedNetworkCapture) networkCaptures.set(tabId, preservedNetworkCapture);
      if (preservedWsCapture) wsCaptures.set(tabId, preservedWsCapture);
    } catch {
      // Leave capture cleared rather than arm a half-attached Network domain;
      // the next start-capture re-arms cleanly.
    }
  }
}

export async function evaluate(
  tabId: number,
  expression: string,
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  // No retry loop here: failures carry a machine-readable errorCode (see
  // classifyExtensionError in background.ts) and the CLI decides whether a
  // NEW logical attempt is safe. ensureAttached still does its own local
  // attach retries; a debugger error mid-evaluate invalidates the attach
  // cache so the next attempt re-attaches.
  try {
    await ensureAttached(tabId, aggressiveRetry);

    const result = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs) as {
      result?: { type: string; value?: unknown; description?: string; subtype?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };

    if (result.exceptionDetails) {
      const errMsg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Eval error';
      throw new Error(errMsg);
    }

    return result.result?.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Detached') || msg.includes('Debugger is not attached') || msg.includes('Target closed')) {
      attached.delete(tabId); // Force re-attach on the next command
    }
    throw e;
  }
}

export const evaluateAsync = evaluate;

/**
 * Capture a screenshot via CDP Page.captureScreenshot.
 * Returns base64-encoded image data.
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';
  const fullPage = options.fullPage === true;
  const overrideWidth = options.width && options.width > 0 ? Math.ceil(options.width) : undefined;
  // height is ignored under fullPage so the existing measure-from-content path stays unchanged for users who pass --height alongside --full-page.
  const overrideHeight = !fullPage && options.height && options.height > 0 ? Math.ceil(options.height) : undefined;
  const needsOverride = fullPage || overrideWidth !== undefined || overrideHeight !== undefined;

  if (needsOverride) {
    // When width is set, apply it first so layout reflows before we read content size.
    if (overrideWidth !== undefined && fullPage) {
      await sendDebuggerCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: overrideWidth,
        height: 0,
        deviceScaleFactor: 1,
      });
    }
    let finalWidth = overrideWidth ?? 0;
    let finalHeight = overrideHeight ?? 0;
    if (fullPage) {
      const metrics = await sendDebuggerCommand({ tabId }, 'Page.getLayoutMetrics') as {
        contentSize?: { width: number; height: number };
        cssContentSize?: { width: number; height: number };
      };
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        if (finalWidth === 0) finalWidth = Math.ceil(size.width);
        finalHeight = Math.ceil(size.height);
      }
    }
    await sendDebuggerCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor: 1,
    });
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = await sendDebuggerCommand({ tabId }, 'Page.captureScreenshot', params) as {
      data: string; // base64-encoded
    };

    return result.data;
  } finally {
    if (needsOverride) {
      await sendDebuggerCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

/**
 * Phrase that downstream plugins (Instagram `post.js`, see `clis/instagram/
 * post.js`) match against to decide whether the selector is stale and should
 * be re-resolved. Keep this string verbatim — the contract predates this fork
 * and plugins rely on a stable substring, not a stable type.
 */
const SELECTOR_NOT_FOUND_MESSAGE_PREFIX = 'No element found matching selector:';

/**
 * Normalize a CDP rejection into a uniform shape.
 *
 * `chrome.debugger.sendCommand` rejects with **raw objects** of the form
 * `{ code: number, message: string, data?: unknown }` rather than Error
 * instances. Passing those through `String(err)` produces `'[object Object]'`,
 * which silently breaks every downstream predicate that grepped the
 * protocol code out of the message — so the fallback path never triggered
 * even when Chrome did reject with `-32000`.
 *
 * This helper extracts `code` + `message` whether the input was an Error
 * or a raw CDP object, and always returns an Error whose `.message` is a
 * human-readable `code + message` string and whose `.code` field carries
 * the original numeric protocol code when present. Callers can throw the
 * result without losing stack frames.
 */
export function normalizeCdpError(err: unknown): Error {
  if (err instanceof Error) {
    // Best-effort: copy a raw `code` from the Error itself if some upstream
    // stage already attached one (custom adapters, Promise rejection wrappers).
    const existing = (err as Error & { code?: unknown }).code;
    if (existing !== undefined) return err;
    return err;
  }
  if (err && typeof err === 'object') {
    const obj = err as { code?: unknown; message?: unknown; data?: unknown };
    const code = obj.code;
    const message = obj.message;
    const parts: string[] = [];
    if (typeof code === 'number' || typeof code === 'string') parts.push(String(code));
    if (typeof message === 'string' && message) parts.push(message);
    let text: string;
    if (parts.length) {
      text = parts.join(' ');
    } else if (obj.data !== undefined) {
      try { text = JSON.stringify(obj.data); } catch { text = '[unserializable data]'; }
    } else {
      try { text = JSON.stringify(obj); } catch { text = '[object Object]'; }
    }
    const error = new Error(text);
    (error as Error & { code?: unknown }).code = code;
    return error;
  }
  return new Error(typeof err === 'string' ? err : String(err));
}

/**
 * True when a CDP rejection from `DOM.setFileInputFiles` indicates that the
 * call itself was rejected by Chrome's protocol layer for a node/object
 * resolution reason — i.e. the input element reference we passed is not
 * usable as-is, and a different code path (re-resolving via
 * `DOM.getDocument` + `DOM.querySelector` → bare `nodeId`) might still work.
 *
 * Strictly excludes transport / lifecycle failures: file-not-found,
 * permission errors, debugger detach, command timeouts, network errors.
 * Falling back for those would just burn another DOM round-trip without
 * ever changing the outcome — the rejection isn't about the input
 * reference at all.
 *
 * Accepts both `Error` instances and raw `{ code, message }` CDP rejection
 * objects; on raw objects the predicate keys off `code` directly so a
 * dropped/silent message doesn't suppress the fallback.
 */
export function isFileInputFallbackEligible(err: unknown): boolean {
  let msg = '';
  let code: unknown;
  if (err instanceof Error) {
    msg = err.message;
    code = (err as Error & { code?: unknown }).code;
  } else if (err && typeof err === 'object') {
    const obj = err as { code?: unknown; message?: unknown };
    code = obj.code;
    if (typeof obj.message === 'string') msg = obj.message;
  }
  if (!msg && code === undefined) return false;
  // Raw CDP code match: chrome.debugger surfaces `-32000` directly on the
  // rejection object, and some Chrome builds omit the trailing
  // "Not allowed" / "Invalid parameters" string. Treat code-only matches
  // as eligible — the predicate's job is to gate the fallback, not to
  // prove the exact protocol subreason.
  if (code === -32000) return true;
  // Message-only path: legacy Error-wrapped rejections and Chrome builds
  // that put the protocol code in `.message` instead of `.code`.
  return /-32000/.test(msg)
    && /\b(not allowed|invalid parameters|invalid parameter|object .* not .*resolved|no node with given id|could not be resolved|cannot find context)\b/i.test(msg);
}

/**
 * Set local file paths on a file input element via CDP DOM.setFileInputFiles.
 * Chrome reads the files directly from the local filesystem — no base64 /
 * DataTransfer payload has to cross the message channel or extension-CDP
 * boundary.
 *
 * Preferred path (Puppeteer / Playwright direct CDP, no native chooser):
 *   1. Runtime.evaluate returns the input element so its `objectId` is on
 *      the result envelope. We deliberately do NOT use `returnByValue: true`
 *      — the `objectId` is what lets DOM.setFileInputFiles resolve against
 *      the live DOM node on the direct path.
 *   2. DOM.describeNode({objectId}) → backendNodeId.
 *   3. DOM.setFileInputFiles({ files, objectId, backendNodeId }).
 *   4. Runtime.releaseObject({objectId}) — best-effort, releases the
 *      Runtime remote so the inspector session isn't leaked when the
 *      upload repeats.
 *
 * Compatibility fallback (only for protocol-resolution rejections, NOT for
 * file/path/permission/transport/timeout errors — those have nothing to do
 * with the input reference, so a second DOM round-trip would be wasted):
 *   1. DOM.getDocument → root.nodeId.
 *   2. DOM.querySelector({ nodeId, selector }) → input.nodeId.
 *   3. DOM.setFileInputFiles({ files, nodeId }).
 *
 * This is the bare-`nodeId` shape that Windows Chrome accepts from direct
 * CDP attachments (Puppeteer/Playwright) when the same call with
 * objectId+backendNodeId is rejected with `-32000 Not allowed` (crbug
 * 928255). Crucially, NO `Page.setInterceptFileChooserDialog` is armed,
 * NO `el.showPicker()` / `el.click()` runs in-page, and NO DataTransfer
 * fallback crosses the boundary — Chrome reads the files natively.
 *
 * Selector contract is preserved: a missing match throws the legacy
 * `"No element found matching selector: ${query}"` message verbatim (the
 * Instagram `post.js` plugin greps this string to decide whether to
 * re-resolve the upload selector — see `clis/instagram/post.js`).
 *
 * @param tabId - Target tab ID
 * @param files - Array of absolute local file paths
 * @param selector - CSS selector to find the file input (optional, defaults to first file input)
 */
export async function setFileInputFiles(
  tabId: number,
  files: string[],
  selector?: string,
): Promise<void> {
  await ensureAttached(tabId);

  // DOM is needed for describeNode / setFileInputFiles and for the nodeId
  // fallback (DOM.getDocument + DOM.querySelector). We intentionally do
  // NOT enable Page — no chooser interception, no in-page picker driving.
  await sendDebuggerCommand({ tabId }, 'DOM.enable');

  const query = selector || 'input[type="file"]';

  // 1. Validate the selector strictly: it must resolve to a file input.
  //    We intentionally run this as a separate `returnByValue` evaluate so
  //    the rejection path returns a structured `{ ok, reason }` discriminator
  //    without burning an objectId on a failed resolution.
  const validation = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(query)});
      if (!el) return { ok: false, reason: 'not-found' };
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
        return { ok: false, reason: 'not-file-input', tag: el.tagName, type: el.type };
      }
      return { ok: true };
    })()`,
    returnByValue: true,
  }) as { result?: { value?: { ok: boolean; reason?: string; tag?: string; type?: string } } };

  const probe = validation.result?.value;
  if (!probe) {
    throw new Error(`${SELECTOR_NOT_FOUND_MESSAGE_PREFIX} ${query}`);
  }
  if (!probe.ok) {
    if (probe.reason === 'not-file-input') {
      throw new Error(
        `setFileInputFiles: selector "${query}" matched <${probe.tag ?? '?'} type="${probe.type ?? ''}">, expected HTMLInputElement[type=file]`,
      );
    }
    // Preserved selector-miss contract — used by Instagram post.js plugin.
    throw new Error(`${SELECTOR_NOT_FOUND_MESSAGE_PREFIX} ${query}`);
  }

  // 2. Resolve the element via a fresh Runtime.evaluate — NO returnByValue,
  // so the result envelope carries an objectId pointing at the live DOM
  // node. That objectId is what DOM.setFileInputFiles will resolve against
  // on the direct path.
  const resolveResult = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(query)})`,
  }) as { result?: { objectId?: string } };

  const objectId = resolveResult.result?.objectId;
  if (!objectId) {
    // Should be impossible after the validation step, but guard for CDP
    // implementations that strip objectId from non-DOM results.
    throw new Error(`${SELECTOR_NOT_FOUND_MESSAGE_PREFIX} ${query}`);
  }

  // 3. DOM.describeNode({objectId}) → backendNodeId. We pass both IDs to
  // DOM.setFileInputFiles because Chrome's resolver prefers the most
  // specific reference (objectId > backendNodeId > nodeId); including the
  // extras is harmless and makes the direct path work on every Chrome
  // variant we ship to.
  //
  // The describe call is wrapped because a protocol-resolution rejection
  // here (e.g. -32000 because the objectId was already detached) is exactly
  // the kind of "input reference not usable as-is" failure that the nodeId
  // fallback exists to recover from — letting it throw would burn the
  // second resolution path that side-steps it.
  let backendNodeId: number;
  try {
    const describe = await sendDebuggerCommand({ tabId }, 'DOM.describeNode', {
      objectId,
    }) as { node?: { backendNodeId?: number } };
    const resolved = describe.node?.backendNodeId;
    if (typeof resolved !== 'number') {
      await releaseRuntimeObject(tabId, objectId);
      throw new Error(
        `setFileInputFiles: DOM.describeNode returned no backendNodeId for selector "${query}"`,
      );
    }
    backendNodeId = resolved;
  } catch (e) {
    const describeErr = normalizeCdpError(e);
    await releaseRuntimeObject(tabId, objectId);
    // Transport / lifecycle failures (file not found, permission denied,
    // debugger detach, command timeout) must NOT burn another DOM
    // round-trip — the rejection isn't about the input reference.
    if (!isFileInputFallbackEligible(describeErr)) {
      throw describeErr;
    }
    // Treat describe rejection as the direct-path failure so the
    // nodeId fallback below can take over and so the eventual
    // combined error still attributes the original cause.
    return await runNodeIdFallback(tabId, files, query, describeErr);
  }

  // 4. Direct CDP path. Try it first — if the browser accepts it, we are
  // done without ever touching DOM.getDocument / DOM.querySelector, so no
  // cleanup is needed. Capture the error so the fallback branch can
  // attribute its own failure to "direct path + nodeId fallback both
  // failed".
  let directErr: Error | null = null;
  try {
    await sendDebuggerCommand({ tabId }, 'DOM.setFileInputFiles', {
      files,
      objectId,
      backendNodeId,
    });
    await releaseRuntimeObject(tabId, objectId);
    return; // success — fallback was never reached
  } catch (e) {
    directErr = normalizeCdpError(e);
  }

  // Release the direct-path objectId before fallback so the inspector
  // session isn't leaked across two resolution strategies.
  await releaseRuntimeObject(tabId, objectId);

  // Only protocol-resolution rejections qualify for the nodeId fallback.
  // Transport / lifecycle failures (file not found, permission denied,
  // debugger detach, command timeout, network error) share the same wire
  // shape but never indicate that the input reference is bad — retrying
  // them would just burn another DOM round-trip without changing the
  // outcome. The original (raw or wrapped) error must surface so the
  // caller still sees the actual cause.
  if (!isFileInputFallbackEligible(directErr)) {
    throw directErr;
  }

  // 5. nodeId fallback. Re-resolve the input element through DOM and call
  // DOM.setFileInputFiles with a bare `nodeId` — the shape Windows Chrome
  // accepts from direct CDP attachments when the objectId+backendNodeId
  // combo is rejected with `-32000 Not allowed` (crbug 928255). Failure
  // here means the input really isn't uploadable right now; report the
  // direct error AND the nodeId error so the failure is debuggable from
  // either direction.
  let nodeIdErr: Error | null = null;
  try {
    await runNodeIdFallback(tabId, files, query, null);
    return; // fallback success
  } catch (e) {
    nodeIdErr = normalizeCdpError(e);
  }

  // Both paths failed — surface both diagnostics so the operator can tell
  // whether the direct path failed because of an unsupported input
  // reference (`-32000`) or because the file really wasn't accepted.
  throw new Error(
    `setFileInputFiles: direct CDP path failed (${directErr?.message ?? 'unknown'}); ` +
    `nodeId fallback also failed (${nodeIdErr?.message ?? 'unknown'})`,
  );
}

/**
 * nodeId resolution + DOM.setFileInputFiles.
 *
 * Re-runs DOM.getDocument + DOM.querySelector against the original CSS
 * selector and calls DOM.setFileInputFiles with a bare `nodeId`. When
 * `directErr` is provided and the fallback itself rejects, the rejection is
 * re-wrapped with both diagnostics so the combined error attributed the
 * failure to "direct path + nodeId fallback both failed". When `directErr`
 * is null, the rejection (if any) is rethrown as-is so the caller can wrap
 * it.
 */
async function runNodeIdFallback(
  tabId: number,
  files: string[],
  query: string,
  directErr: Error | null,
): Promise<void> {
  try {
    const doc = await sendDebuggerCommand({ tabId }, 'DOM.getDocument') as {
      root?: { nodeId?: number };
    };
    const rootNodeId = doc?.root?.nodeId;
    if (typeof rootNodeId !== 'number') {
      throw new Error('DOM.getDocument returned no root.nodeId');
    }
    const queried = await sendDebuggerCommand({ tabId }, 'DOM.querySelector', {
      nodeId: rootNodeId,
      selector: query,
    }) as { nodeId?: number };
    const inputNodeId = queried?.nodeId;
    if (typeof inputNodeId !== 'number' || inputNodeId <= 0) {
      // Re-use the legacy selector-miss contract so Instagram post.js
      // (and any other plugin that greps for it) keeps working even when
      // the failure originates from the fallback path.
      throw new Error(`${SELECTOR_NOT_FOUND_MESSAGE_PREFIX} ${query}`);
    }
    await sendDebuggerCommand({ tabId }, 'DOM.setFileInputFiles', {
      files,
      nodeId: inputNodeId,
    });
    return; // fallback success
  } catch (e) {
    if (directErr === null) throw e;
    const fbErr = e instanceof Error ? e : normalizeCdpError(e);
    throw new Error(
      `setFileInputFiles: direct CDP path failed (${directErr.message}); ` +
      `nodeId fallback also failed (${fbErr.message})`,
    );
  }
}

/**
 * Best-effort release of a Runtime remote object. Failures are swallowed —
 * a stale handle is harmless compared to failing an upload that already
 * succeeded on the direct path.
 */
async function releaseRuntimeObject(tabId: number, objectId: string): Promise<void> {
  if (!objectId) return;
  try {
    await sendDebuggerCommand({ tabId }, 'Runtime.releaseObject', { objectId });
  } catch {
    // already gone — no-op
  }
}

function matchesDownloadPattern(item: chrome.downloads.DownloadItem, pattern: string): boolean {
  if (!pattern) return true;
  const haystack = [
    item.filename,
    item.url,
    item.finalUrl,
    item.mime,
  ].filter(Boolean).join('\n').toLowerCase();
  return haystack.includes(pattern.toLowerCase());
}

function downloadResult(item: chrome.downloads.DownloadItem, startedAt: number): DownloadWaitResult {
  return {
    downloaded: item.state === 'complete',
    id: item.id,
    filename: item.filename,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    totalBytes: item.totalBytes,
    state: item.state,
    danger: item.danger,
    error: item.error,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function waitForDownload(pattern: string = '', timeoutMs: number = 30000): Promise<DownloadWaitResult> {
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);

  return await new Promise<DownloadWaitResult>((resolve) => {
    let done = false;
    const inProgressIds = new Set<number>();
    const finish = (result: DownloadWaitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(result);
    };

    const inspectById = async (id: number) => {
      const items = await chrome.downloads.search({ id });
      const item = items[0];
      if (!item || !matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };

    const onCreated = (item: chrome.downloads.DownloadItem) => {
      if (!matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(item.id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (!delta.id) return;
      if (!inProgressIds.has(delta.id) && !delta.filename && !delta.url) return;
      if (delta.filename?.current || delta.url?.current) {
        void inspectById(delta.id);
        return;
      }
      if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
        void inspectById(delta.id);
      }
    };
    const timer = setTimeout(() => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: `No download matched "${pattern || '*'}" within ${timeout}ms`,
        elapsedMs: Date.now() - startedAt,
      });
    }, timeout);

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);

    void chrome.downloads.search({
      limit: 50,
      orderBy: ['-startTime'],
      startedAfter: new Date(startedAt - Math.max(timeout, 1000)).toISOString(),
    }).then((recent) => {
      if (done) return;
      const completed = recent.find((item) => item.state === 'complete' && matchesDownloadPattern(item, pattern));
      if (completed) {
        finish(downloadResult(completed, startedAt));
        return;
      }
      for (const item of recent) {
        if (item.state === 'in_progress' && matchesDownloadPattern(item, pattern)) inProgressIds.add(item.id);
      }
    }).catch((err) => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

function frameTargetKey(tabId: number, frameId: string): string {
  return `${tabId}:${frameId}`;
}

function registerFrameTargetCleanup(): void {
  if (frameTargetCleanupRegistered) return;
  frameTargetCleanupRegistered = true;
  chrome.debugger.onEvent.addListener((_source, method, params: any) => {
    if (method === 'Target.detachedFromTarget') {
      const targetId = String(params?.targetId || '');
      clearFrameTarget(targetId);
    }
  });
}

function clearFrameTarget(targetId: string): void {
  if (!targetId) return;
  const key = frameTargetKeys.get(targetId);
  if (key) frameTargets.delete(key);
  frameTargetKeys.delete(targetId);
}

async function ensureFrameTarget(
  tabId: number,
  frameId: string,
  aggressiveRetry: boolean = false,
  targetUrl?: string,
): Promise<string> {
  registerFrameTargetCleanup();
  await ensureAttached(tabId, aggressiveRetry);
  const key = frameTargetKey(tabId, frameId);
  const existing = frameTargets.get(key);
  if (existing) return existing;

  await sendDebuggerCommand({ tabId }, 'Target.setDiscoverTargets', { discover: true }).catch(() => {});
  await sendDebuggerCommand({ tabId }, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'iframe', exclude: false }],
  }).catch(() => {});
  const targetId = await resolveFrameTargetId(tabId, frameId, targetUrl);
  try {
    await chrome.debugger.attach({ targetId } as chrome.debugger.Debuggee, '1.3');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('Another debugger is already attached')) throw err;
  }
  frameTargets.set(key, targetId);
  frameTargetKeys.set(targetId, key);
  return targetId;
}

async function resolveFrameTargetId(tabId: number, frameId: string, targetUrl?: string): Promise<string> {
  const result = await sendDebuggerCommand({ tabId }, 'Target.getTargets').catch(() => null) as
    | { targetInfos?: Array<{ targetId?: string; id?: string; type?: string; url?: string }> }
    | null;
  const targets = result?.targetInfos ?? [];
  const frameTarget = targets.find((candidate) => {
    const candidateId = candidate.targetId || candidate.id;
    return candidate.type === 'iframe'
      && (
        candidateId === frameId
        || (!!targetUrl && candidate.url === targetUrl)
      );
  });
  const targetId = frameTarget?.targetId || frameTarget?.id;
  if (targetId) return targetId;
  const candidates = targets
    .filter((target) => target.type === 'iframe')
    .map((target) => `${target.targetId || target.id || '?'} ${target.url || ''}`)
    .join('; ');
  throw new Error(`No iframe target found for frame ${frameId}${targetUrl ? ` (${targetUrl})` : ''}. Candidates: ${candidates || 'none'}`);
}

export async function sendCommandInFrameTarget(
  tabId: number,
  frameId: string,
  method: string,
  params: Record<string, unknown> = {},
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
  targetUrl?: string,
): Promise<unknown> {
  const targetId = await ensureFrameTarget(tabId, frameId, aggressiveRetry, targetUrl);
  const target = { targetId } as chrome.debugger.Debuggee;
  return sendDebuggerCommand(target, method, params, timeoutMs);
}

export async function insertText(
  tabId: number,
  text: string,
): Promise<void> {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, 'Input.insertText', { text });
}

export function registerFrameTracking(): void {
  registerFrameTargetCleanup();
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (!tabId) return;

    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      if (!context?.auxData?.frameId || context.auxData.isDefault !== true) return;
      const frameId = context.auxData.frameId as string;
      if (!tabFrameContexts.has(tabId)) {
        tabFrameContexts.set(tabId, new Map());
      }
      tabFrameContexts.get(tabId)!.set(frameId, context.id);
    }

    if (method === 'Runtime.executionContextDestroyed') {
      const ctxId = params.executionContextId;
      const contexts = tabFrameContexts.get(tabId);
      if (contexts) {
        for (const [fid, cid] of contexts) {
          if (cid === ctxId) { contexts.delete(fid); break; }
        }
      }
    }

    if (method === 'Runtime.executionContextsCleared') {
      tabFrameContexts.delete(tabId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabFrameContexts.delete(tabId);
  });
}

export async function getFrameTree(tabId: number): Promise<any> {
  await ensureAttached(tabId);
  return sendDebuggerCommand({ tabId }, 'Page.getFrameTree');
}

export async function evaluateInFrame(
  tabId: number,
  expression: string,
  frameId: string,
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  await ensureAttached(tabId, aggressiveRetry);

  await sendDebuggerCommand({ tabId }, 'Runtime.enable').catch(() => {});

  const contexts = tabFrameContexts.get(tabId);
  const contextId = contexts?.get(frameId);

  if (contextId !== undefined) {
    try {
      const result = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      }, timeoutMs) as {
        result?: { type: string; value?: unknown; description?: string; subtype?: string };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || 'Eval error';
        throw new Error(errMsg);
      }
      return result.result?.value;
    } catch (err) {
      // A navigated/reloaded frame invalidates its cached context id, but the
      // Runtime.executionContextDestroyed event may not have been processed
      // yet — the cache still holds the stale id and Runtime.evaluate rejects
      // with "Cannot find context with specified id". Drop the stale id and
      // fall through to the frame-target path instead of failing (evaluate()
      // likewise re-resolves on a dead context). Re-throw genuine page errors.
      const msg = String((err as { message?: string })?.message || err);
      if (!/Cannot find context|context with specified id|Execution context was destroyed/i.test(msg)) {
        throw err;
      }
      contexts?.delete(frameId);
    }
  }

  // No cached context, or the cached one went stale: resolve via the frame target.
  await sendCommandInFrameTarget(tabId, frameId, 'Runtime.enable', {}, aggressiveRetry, timeoutMs).catch(() => undefined);
  const result = await sendCommandInFrameTarget(tabId, frameId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, aggressiveRetry, timeoutMs) as {
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

function normalizeCapturePatterns(pattern?: string): string[] {
  return String(pattern || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

function shouldCaptureUrl(url: string | undefined, patterns: string[]): boolean {
  if (!url) return false;
  if (!patterns.length) return true;
  return patterns.some((pattern) => url.includes(pattern));
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[String(key)] = String(value);
  }
  return out;
}

function getOrCreateNetworkCaptureEntry(tabId: number, requestId: string, fallback?: {
  url?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
}): NetworkCaptureEntry | null {
  const state = networkCaptures.get(tabId);
  if (!state) return null;
  const existingIndex = state.requestToIndex.get(requestId);
  if (existingIndex !== undefined) {
    return state.entries[existingIndex] || null;
  }
  const url = fallback?.url || '';
  if (!shouldCaptureUrl(url, state.patterns)) return null;
  const entry: NetworkCaptureEntry = {
    kind: 'cdp',
    url,
    method: fallback?.method || 'GET',
    requestHeaders: fallback?.requestHeaders || {},
    timestamp: Date.now(),
  };
  state.entries.push(entry);
  state.requestToIndex.set(requestId, state.entries.length - 1);
  return entry;
}

export async function startNetworkCapture(
  tabId: number,
  pattern?: string,
): Promise<void> {
  await ensureAttached(tabId);
  // Arm before Network.enable so requestWillBeSent during enable is not dropped.
  networkCaptures.set(tabId, {
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestToIndex: new Map(),
  });
  await sendDebuggerCommand({ tabId }, 'Network.enable');
}

export async function readNetworkCapture(tabId: number): Promise<NetworkCaptureEntry[]> {
  const state = networkCaptures.get(tabId);
  if (!state) return [];
  const entries = state.entries.slice();
  state.entries = [];
  state.requestToIndex.clear();
  return entries;
}

/**
 * Arm WebSocket frame capture for a tab.
 * Only frames observed after this call are buffered — there is no historical replay.
 * Call before the action that triggers stream traffic (e.g. send prompt).
 */
export async function startWsCapture(
  tabId: number,
  pattern?: string,
): Promise<void> {
  await ensureAttached(tabId);
  // Arm the buffer BEFORE Network.enable. Chrome may emit webSocketCreated for
  // already-open sockets (or immediate frames) as soon as the domain is enabled;
  // setting state after enable races those events and silently drops them.
  wsCaptures.set(tabId, {
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestIdToUrl: new Map(),
    rejectedRequestIds: new Set(),
    dropped: 0,
  });
  await sendDebuggerCommand({ tabId }, 'Network.enable');
}

export async function readWsCapture(tabId: number): Promise<WsCaptureEntry[]> {
  const state = wsCaptures.get(tabId);
  if (!state) return [];
  const entries = state.entries.slice();
  state.entries = [];
  // Keep requestIdToUrl so frames that arrive after a drain still resolve URLs.
  if (state.dropped > 0) {
    // Adapter should poll more frequently if this appears in extension logs.
    console.warn(`[opencli] ws-capture dropped ${state.dropped} frame(s) on tab ${tabId} (ring full)`);
    state.dropped = 0;
  }
  return entries;
}

/**
 * Disarm WebSocket capture for a tab and free the ring buffer / request maps.
 * Safe to call when capture was never started. Does not detach the debugger
 * (HTTP network capture or later commands may still need it).
 */
export function stopWsCapture(tabId: number): void {
  wsCaptures.delete(tabId);
}

export function hasActiveWsCapture(tabId: number): boolean {
  return wsCaptures.has(tabId);
}

/** True when HTTP and/or WebSocket capture is armed (keep debugger attached). */
export function hasActiveNetworkCapture(tabId: number): boolean {
  return networkCaptures.has(tabId) || wsCaptures.has(tabId);
}

function pushWsFrame(state: WsCaptureState, entry: WsCaptureEntry): void {
  if (state.entries.length >= CDP_WS_FRAME_BUFFER_LIMIT) {
    const overflow = state.entries.length - CDP_WS_FRAME_BUFFER_LIMIT + 1;
    state.entries.splice(0, overflow);
    state.dropped += overflow;
  }
  state.entries.push(entry);
}

function encodeWsPayload(payloadData: string | undefined, opcode: number): {
  payload: string;
  payloadFullSize: number;
  payloadTruncated: boolean;
} {
  const raw = String(payloadData ?? '');
  const fullSize = raw.length;
  // opcode 1 = text, 2 = binary (CDP may still surface binary as a string)
  const isBinary = opcode === 2;
  if (isBinary) {
    // Keep a short base64-ish preview marker; full binary streaming is out of scope.
    const stored = fullSize > CDP_WS_FRAME_PAYLOAD_LIMIT
      ? raw.slice(0, CDP_WS_FRAME_PAYLOAD_LIMIT)
      : raw;
    return {
      payload: `base64:${stored}`,
      payloadFullSize: fullSize,
      payloadTruncated: fullSize > CDP_WS_FRAME_PAYLOAD_LIMIT,
    };
  }
  const truncated = fullSize > CDP_WS_FRAME_PAYLOAD_LIMIT;
  return {
    payload: truncated ? raw.slice(0, CDP_WS_FRAME_PAYLOAD_LIMIT) : raw,
    payloadFullSize: fullSize,
    payloadTruncated: truncated,
  };
}

function handleWsCaptureEvent(
  tabId: number,
  method: string,
  eventParams: Record<string, any> | undefined,
): void {
  const state = wsCaptures.get(tabId);
  if (!state) return;

  if (method === 'Network.webSocketCreated') {
    const requestId = String(eventParams?.requestId || '');
    const url = String(eventParams?.url || '');
    if (!requestId || !url) return;
    if (!shouldCaptureUrl(url, state.patterns)) {
      state.rejectedRequestIds.add(requestId);
      state.requestIdToUrl.delete(requestId);
      return;
    }
    state.rejectedRequestIds.delete(requestId);
    state.requestIdToUrl.set(requestId, url);
    return;
  }

  if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
    const requestId = String(eventParams?.requestId || '');
    if (!requestId) return;
    if (state.rejectedRequestIds.has(requestId)) return;

    const response = eventParams?.response as { opcode?: number; payloadData?: string } | undefined;
    const opcode = Number(response?.opcode ?? 1);
    // Ignore control frames (close/ping/pong).
    if (opcode >= 8) return;

    let url = state.requestIdToUrl.has(requestId) ? (state.requestIdToUrl.get(requestId) || '') : undefined;
    // After Network.enable, frames may arrive for sockets that never re-emit
    // webSocketCreated. Keep unknown requestIds (empty url) so long-lived
    // ChatGPT streams are not silently dropped.
    if (url === undefined) {
      state.requestIdToUrl.set(requestId, '');
      url = '';
    } else if (url && !shouldCaptureUrl(url, state.patterns)) {
      return;
    }

    const encoded = encodeWsPayload(response?.payloadData, opcode);
    pushWsFrame(state, {
      kind: 'ws-frame',
      url,
      requestId,
      timestamp: Date.now(),
      direction: method === 'Network.webSocketFrameReceived' ? 'received' : 'sent',
      opcode,
      payload: encoded.payload,
      payloadFullSize: encoded.payloadFullSize,
      payloadTruncated: encoded.payloadTruncated,
    });
    return;
  }

  if (method === 'Network.webSocketClosed') {
    const requestId = String(eventParams?.requestId || '');
    if (requestId) {
      state.requestIdToUrl.delete(requestId);
      state.rejectedRequestIds.delete(requestId);
    }
  }
}

function clearFrameTargetsForTab(tabId: number): void {
  for (const [key, targetId] of [...frameTargets.entries()]) {
    if (!key.startsWith(`${tabId}:`)) continue;
    frameTargets.delete(key);
    frameTargetKeys.delete(targetId);
    chrome.debugger.detach({ targetId } as chrome.debugger.Debuggee).catch(() => {});
  }
}

export async function detach(tabId: number): Promise<void> {
  clearFrameTargetsForTab(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  networkCaptures.delete(tabId);
  wsCaptures.delete(tabId);
  tabFrameContexts.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    networkCaptures.delete(tabId);
    wsCaptures.delete(tabId);
    tabFrameContexts.delete(tabId);
    clearFrameTargetsForTab(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
      attached.delete(source.tabId);
      networkCaptures.delete(source.tabId);
      wsCaptures.delete(source.tabId);
      tabFrameContexts.delete(source.tabId);
      clearFrameTargetsForTab(source.tabId);
      return;
    }
    if (source.targetId) clearFrameTarget(source.targetId);
  });
  // Invalidate attached cache when tab URL changes to non-debuggable
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await detach(tabId);
    }
  });
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;
    const eventParams = params as Record<string, any> | undefined;

    // WebSocket stream capture is independent of HTTP network capture.
    if (method.startsWith('Network.webSocket')) {
      handleWsCaptureEvent(tabId, method, eventParams);
      return;
    }

    const state = networkCaptures.get(tabId);
    if (!state) return;

    if (method === 'Network.requestWillBeSent') {
      const requestId = String(eventParams?.requestId || '');
      const request = eventParams?.request as {
        url?: string;
        method?: string;
        headers?: Record<string, unknown>;
        postData?: string;
        hasPostData?: boolean;
      } | undefined;
      const entry = getOrCreateNetworkCaptureEntry(tabId, requestId, {
        url: request?.url,
        method: request?.method,
        requestHeaders: normalizeHeaders(request?.headers),
      });
      if (!entry) return;
      // On an HTTP 30x, CDP re-fires requestWillBeSent with the SAME requestId
      // (the prior hop is carried in `redirectResponse`) for the redirect
      // target — typically a GET with no postData. Overwriting the body here
      // would wipe the original request's captured POST body, so only populate
      // the body on the initial send.
      if (!eventParams?.redirectResponse) {
        entry.requestBodyKind = request?.hasPostData ? 'string' : 'empty';
        {
          const raw = String(request?.postData || '');
          const fullSize = raw.length;
          const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
          entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
          entry.requestBodyFullSize = fullSize;
          entry.requestBodyTruncated = truncated;
        }
        try {
          const postData = await sendDebuggerCommand({ tabId }, 'Network.getRequestPostData', { requestId }) as { postData?: string };
          if (postData?.postData) {
            const raw = postData.postData;
            const fullSize = raw.length;
            const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
            entry.requestBodyKind = 'string';
            entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
            entry.requestBodyFullSize = fullSize;
            entry.requestBodyTruncated = truncated;
          }
        } catch {
          // Optional; some requests do not expose postData.
        }
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const requestId = String(eventParams?.requestId || '');
      const response = eventParams?.response as {
        url?: string;
        mimeType?: string;
        status?: number;
        headers?: Record<string, unknown>;
      } | undefined;
      // Lookup-only (like loadingFinished below): never create an entry from a
      // response. If the matching requestWillBeSent was already drained by a
      // readNetworkCapture() while the request was in flight, creating one here
      // produces an orphan half-entry with a defaulted method ('GET') and no
      // request data.
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      entry.responseStatus = response?.status;
      entry.responseContentType = response?.mimeType || '';
      entry.responseHeaders = normalizeHeaders(response?.headers);
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = String(eventParams?.requestId || '');
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      try {
        const body = await sendDebuggerCommand({ tabId }, 'Network.getResponseBody', { requestId }) as {
          body?: string;
          base64Encoded?: boolean;
        };
        if (typeof body?.body === 'string') {
          const fullSize = body.body.length;
          const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
          const stored = truncated ? body.body.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : body.body;
          entry.responsePreview = body.base64Encoded ? `base64:${stored}` : stored;
          entry.responseBodyFullSize = fullSize;
          entry.responseBodyTruncated = truncated;
        }
      } catch {
        // Optional; bodies are unavailable for some requests (e.g. uploads).
      }
    }
  });
}
