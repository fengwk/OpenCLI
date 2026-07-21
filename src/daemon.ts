/**
 * opencli micro-daemon — HTTP + WebSocket bridge between CLI and Chrome Extension.
 *
 * Architecture:
 *   CLI → HTTP POST /command → daemon → WebSocket → Extension
 *   Extension → WebSocket result → daemon → HTTP response → CLI
 *
 * Security (defense-in-depth against browser-based CSRF):
 *   1. Origin check — reject HTTP/WS from non chrome-extension:// origins
 *   2. Custom header — require X-OpenCLI header (browsers can't send it
 *      without CORS preflight, which we deny)
 *   3. No CORS headers on command endpoints — only /ping is readable from the
 *      Browser Bridge extension origin so the extension can probe daemon reachability
 *   4. Body size limit — 1 MB max to prevent OOM
 *   5. WebSocket verifyClient — reject upgrade before connection is established
 *
 * Lifecycle:
 *   - Auto-spawned by opencli on first browser command
 *   - Persistent — stays alive until explicit shutdown, SIGTERM, or uninstall
 *   - Listens on localhost:19825
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { DEFAULT_DAEMON_PORT, isIgnorableDaemonPortEnv, unsupportedDaemonPortEnvMessage } from './constants.js';
import { EXIT_CODES } from './errors.js';
import { log } from './logger.js';
import { PKG_VERSION } from './version.js';
import { DEFAULT_CONTEXT_ID } from './browser/profile.js';
import { recordExtensionVersion } from './update-check.js';
import { readBody } from './daemon-body.js';
import {
  COMMAND_RESULT_UNKNOWN_CODE,
  COMMAND_RESULT_UNKNOWN_HINT,
  PROFILE_DISCONNECTED_HINT,
  REQUEST_BODY_TOO_LARGE_STATUS,
  buildCommandDispatchFailure,
  buildCommandTimeoutFailure,
  buildExtensionDisconnectFailure,
  getResponseCorsHeaders,
  resolveProfileRoute,
} from './daemon-utils.js';
import {
  SessionLeaseRegistry,
  buildSessionBusyFailure,
  buildSessionLeaseRevokedFailure,
  buildSessionRecoveringFailure,
  getSessionLeaseKey,
  isSessionLeaseCommand,
  parseSessionLeaseKey,
  parsePidFromRunId,
  SESSION_RECOVERY_FAILED_CODE,
  type SessionLeaseRecoveryMode,
} from './session-lease.js';

const PORT = DEFAULT_DAEMON_PORT;
if (!isIgnorableDaemonPortEnv(process.env.OPENCLI_DAEMON_PORT)) {
  log.error(unsupportedDaemonPortEnvMessage(process.env.OPENCLI_DAEMON_PORT));
  process.exit(EXIT_CODES.USAGE_ERROR);
}

// ─── State ───────────────────────────────────────────────────────────

type ExtensionProfileConnection = {
  contextId: string;
  ws: WebSocket;
  extensionVersion: string | null;
  extensionCompatRange: string | null;
  lastSeenAt: number;
};

const extensionProfiles = new Map<string, ExtensionProfileConnection>();
type PendingSettler = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};
type PendingEntry = {
  contextId: string;
  action: string;
  dispatched: boolean;
  /**
   * All HTTP requests waiting on this command id. The first settler is the
   * original request; transport retries with the same id attach here instead
   * of re-dispatching, so a retry never re-executes a command that is still
   * running.
   */
  settlers: PendingSettler[];
  timer: ReturnType<typeof setTimeout>;
  /**
   * Set for lease-eligible commands: while this entry is pending, the holder
   * is alive even past the lease TTL (a single exec can outlast it), and
   * settling refreshes the lease so the TTL clock restarts cleanly.
   */
  leaseKey?: string;
  runId?: string;
  /** Recovery fenced this run; late extension results must never revive it. */
  recoveryRevoked?: boolean;
};
const pending = new Map<string, PendingEntry>();

const SESSION_RECOVERY_RESET_TIMEOUT_MS = 5_000;
const DAEMON_CAPABILITIES = ['session-lease-v1', 'session-recover-v1'] as const;

// One logical write lease per (contextId, surface, persistent site session).
// Serializes concurrent adapter write commands so a retry can't drive the same
// Chrome tab as a still-running command. Stale leases self-expire (see
// session-lease.ts).
const sessionLeases = new SessionLeaseRegistry();

/** A TTL-stale lease holder with a command still in flight is alive, not dead. */
function runHasPendingWork(runId: string): boolean {
  for (const entry of pending.values()) {
    if (entry.runId === runId) return true;
  }
  return false;
}

function pendingCountForRun(runId: string): number {
  let count = 0;
  for (const entry of pending.values()) {
    if (entry.runId === runId) count++;
  }
  return count;
}

/** Conservative owner liveness: only ESRCH proves a CLI run is gone. */
function isRunOwnerProcessAlive(runId: string): boolean {
  const pid = parsePidFromRunId(runId);
  return pid !== null && pid !== process.pid && !isOwnerProcessConfirmedDead(pid);
}

function sessionLeaseStatus(): Array<{
  contextId: string;
  surface: string;
  session: string;
  runId: string;
  command: string;
  pid: number | null;
  owner: string;
  startedAt: number;
  lastSeenAt: number;
  pendingCount: number;
  state: 'ACTIVE' | 'RECOVERING';
}> {
  return sessionLeases.list(Date.now(), runHasPendingWork, isRunOwnerProcessAlive).flatMap(({ key, ...holder }) => {
    const identity = parseSessionLeaseKey(key);
    if (!identity) return [];
    return [{
      ...identity,
      ...holder,
      pendingCount: pendingCountForRun(holder.runId),
    }];
  });
}

function recoveredPendingFailure(action: string): DaemonCommandFailure {
  return new DaemonCommandFailure(
    `Browser ${action} command was cancelled during session recovery; it may have completed before the reset.`,
    COMMAND_RESULT_UNKNOWN_CODE,
    COMMAND_RESULT_UNKNOWN_HINT,
    503,
  );
}

/** Fence pending work before reset so a late extension result is ignored. */
function markRunPendingForRecovery(runId: string): void {
  for (const entry of pending.values()) {
    if (entry.runId !== runId) continue;
    entry.recoveryRevoked = true;
    clearTimeout(entry.timer);
  }
}

/** Settle every old HTTP waiter as unknown after a reset attempt. */
function settleRunPendingAsUnknown(runId: string): number {
  let settled = 0;
  for (const [id, entry] of [...pending.entries()]) {
    if (entry.runId !== runId) continue;
    if (entry.dispatched) commandResultUnknownCount++;
    settlePending(id, entry, { error: recoveredPendingFailure(entry.action) });
    settled++;
  }
  return settled;
}

/** `ESRCH` proves the client process is gone; all other results are conservative. */
function isOwnerProcessConfirmedDead(pid: number | null): boolean {
  if (pid === null || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function settlePending(id: string, entry: PendingEntry, outcome: { data?: unknown; error?: Error }): void {
  clearTimeout(entry.timer);
  pending.delete(id);
  // A settling command is proof of holder liveness — restart the TTL clock so
  // an exec that outlived the TTL hands over to normal heartbeats seamlessly.
  if (entry.leaseKey && entry.runId && !entry.recoveryRevoked) {
    sessionLeases.heartbeat(entry.leaseKey, entry.runId, Date.now());
  }
  for (const settler of entry.settlers) {
    if (outcome.error) settler.reject(outcome.error);
    else settler.resolve(outcome.data);
  }
}
let commandResultUnknownCount = 0;
// Extension log ring buffer
interface LogEntry { level: string; msg: string; ts: number; }
const LOG_BUFFER_SIZE = 200;
const logBuffer: LogEntry[] = [];

class DaemonCommandFailure extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
    readonly errorHint?: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'DaemonCommandFailure';
  }
}

function pushLog(entry: LogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

function activeProfiles(): ExtensionProfileConnection[] {
  return [...extensionProfiles.values()].filter((entry) => entry.ws.readyState === WebSocket.OPEN);
}

/** Stale defaults we already warned about — one log line per daemon lifetime. */
const staleDefaultWarned = new Set<string>();

function resolveExtensionConnection(contextId?: string, preferredContextId?: string): {
  connection?: ExtensionProfileConnection;
  errorCode?: 'extension_not_connected' | 'profile_required' | 'profile_disconnected';
  error?: string;
  errorHint?: string;
} {
  const route = resolveProfileRoute({
    requestedContextId: typeof contextId === 'string' ? contextId : undefined,
    preferredContextId: typeof preferredContextId === 'string' ? preferredContextId : undefined,
    connectedContextIds: activeProfiles().map((entry) => entry.contextId),
  });
  if (!route.ok) {
    return { errorCode: route.errorCode, error: route.error, ...(route.errorHint ? { errorHint: route.errorHint } : {}) };
  }
  if (route.fallbackFrom && !staleDefaultWarned.has(route.fallbackFrom)) {
    staleDefaultWarned.add(route.fallbackFrom);
    log.warn(
      `[daemon] Default profile "${route.fallbackFrom}" is not connected; ` +
      `using the only connected profile "${route.contextId}". Update the default with: opencli profile use <name>`,
    );
  }
  const connection = extensionProfiles.get(route.contextId);
  if (connection?.ws.readyState === WebSocket.OPEN) return { connection };
  // Connection raced away between arbitration and lookup.
  return {
    errorCode: 'profile_disconnected',
    error: `Browser profile "${route.contextId}" is not connected.`,
    errorHint: PROFILE_DISCONNECTED_HINT,
  };
}

let recoveryCommandSequence = 0;

async function resetExtensionSession(input: {
  connection: ExtensionProfileConnection;
  contextId: string;
  surface: string;
  session: string;
}): Promise<boolean> {
  const id = `session-recover-${process.pid}-${Date.now()}-${++recoveryCommandSequence}`;
  const result = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      settlePending(id, entry, {
        error: new DaemonCommandFailure(
          `Timed out waiting for the Browser Bridge to reset session "${input.session}".`,
          SESSION_RECOVERY_FAILED_CODE,
          'Keep the session fenced and retry recovery after the Browser Bridge reconnects.',
          503,
        ),
      });
    }, SESSION_RECOVERY_RESET_TIMEOUT_MS);
    const entry: PendingEntry = {
      contextId: input.contextId,
      action: 'close-window',
      dispatched: false,
      settlers: [{ resolve, reject }],
      timer,
    };
    pending.set(id, entry);
    const failBeforeDispatch = (err: unknown) => {
      if (pending.get(id) !== entry) return;
      settlePending(id, entry, {
        error: new DaemonCommandFailure(
          `Failed to dispatch Browser Bridge session reset: ${err instanceof Error ? err.message : String(err)}`,
          SESSION_RECOVERY_FAILED_CODE,
          'Keep the session fenced and retry recovery after the Browser Bridge reconnects.',
          503,
        ),
      });
    };
    try {
      input.connection.ws.send(JSON.stringify({
        id,
        action: 'close-window',
        contextId: input.contextId,
        surface: input.surface,
        session: input.session,
        siteSession: 'persistent',
      }), (err?: Error) => {
        if (err && !entry.dispatched) failBeforeDispatch(err);
      });
      entry.dispatched = true;
    } catch (err) {
      failBeforeDispatch(err);
    }
  });
  return typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === true;
}

type SessionRecoveryResponse = {
  ok: boolean;
  result: 'RECOVERED' | 'ALREADY_FREE' | 'STILL_ACTIVE' | 'OWNER_CHANGED' | 'RESET_FAILED';
  runId?: string;
  tabReset: boolean;
  cancelledPending: number;
  errorCode?: string;
  error?: string;
  errorHint?: string;
};

type SessionRecoveryInput = {
  contextId: string;
  surface: string;
  session: string;
  expectedRunId: string;
  mode: SessionLeaseRecoveryMode;
  reason?: string;
};

const recoveryInFlight = new Map<string, Promise<SessionRecoveryResponse>>();

function recoverSessionLease(input: SessionRecoveryInput): Promise<SessionRecoveryResponse> {
  const inFlightKey = `${getSessionLeaseKey(input.contextId, input.surface, input.session)}␟${input.expectedRunId}`;
  const existing = recoveryInFlight.get(inFlightKey);
  if (existing) return existing;

  const recovery = performSessionLeaseRecovery(input);
  recoveryInFlight.set(inFlightKey, recovery);
  void recovery.then(
    () => { if (recoveryInFlight.get(inFlightKey) === recovery) recoveryInFlight.delete(inFlightKey); },
    () => { if (recoveryInFlight.get(inFlightKey) === recovery) recoveryInFlight.delete(inFlightKey); },
  );
  return recovery;
}

async function performSessionLeaseRecovery(input: SessionRecoveryInput): Promise<SessionRecoveryResponse> {
  const key = getSessionLeaseKey(input.contextId, input.surface, input.session);
  const transition = sessionLeases.beginRecovery({
    key,
    expectedRunId: input.expectedRunId,
    mode: input.mode,
    pendingCount: pendingCountForRun(input.expectedRunId),
    now: Date.now(),
  });

  if (transition.result === 'ALREADY_FREE' || transition.result === 'OWNER_CHANGED') {
    return {
      ok: true,
      result: transition.result,
      ...(transition.holder ? { runId: transition.holder.runId } : {}),
      tabReset: false,
      cancelledPending: 0,
    };
  }
  if (transition.result === 'STILL_ACTIVE' && !transition.retryReset) {
    return {
      ok: true,
      result: 'STILL_ACTIVE',
      runId: input.expectedRunId,
      tabReset: false,
      cancelledPending: 0,
    };
  }
  if (input.mode === 'RECLAIM_IF_IDLE') {
    return {
      ok: true,
      result: 'RECOVERED',
      runId: input.expectedRunId,
      tabReset: false,
      cancelledPending: 0,
    };
  }

  // From here the exact run is fenced and the lease is RECOVERING. Preserve
  // pending entries until the reset attempt finishes so late results cannot
  // heartbeat or be mistaken for safe completion.
  markRunPendingForRecovery(input.expectedRunId);
  const connection = extensionProfiles.get(input.contextId);
  let tabReset = false;
  let resetError: unknown;
  if (connection?.ws.readyState === WebSocket.OPEN) {
    try {
      tabReset = await resetExtensionSession({
        connection,
        contextId: input.contextId,
        surface: input.surface,
        session: input.session,
      });
    } catch (err) {
      resetError = err;
    }
  } else {
    resetError = new Error(`Browser profile "${input.contextId}" is not connected.`);
  }

  const cancelledPending = settleRunPendingAsUnknown(input.expectedRunId);
  if (!tabReset) {
    const detail = resetError instanceof Error ? resetError.message : 'Browser Bridge did not confirm the session reset.';
    log.warn(
      `[daemon] Session recovery reset failed (context=${input.contextId}, session=${input.session}, ` +
      `runId=${input.expectedRunId}, reason=${input.reason ?? 'unspecified'}): ${detail}`,
    );
    return {
      ok: false,
      result: 'RESET_FAILED',
      runId: input.expectedRunId,
      tabReset: false,
      cancelledPending,
      errorCode: SESSION_RECOVERY_FAILED_CODE,
      error: detail,
      errorHint: 'The old run remains fenced and the lease remains RECOVERING. Retry recovery or restart only this Chrome profile.',
    };
  }
  if (!sessionLeases.completeRecovery(key, input.expectedRunId)) {
    return {
      ok: false,
      result: 'RESET_FAILED',
      runId: input.expectedRunId,
      tabReset: true,
      cancelledPending,
      errorCode: SESSION_RECOVERY_FAILED_CODE,
      error: 'Session lease ownership changed while completing recovery.',
      errorHint: 'Inspect daemon status before retrying; do not replay the original write command.',
    };
  }
  log.info(
    `[daemon] Recovered session (context=${input.contextId}, session=${input.session}, ` +
    `runId=${input.expectedRunId}, cancelledPending=${cancelledPending}, reason=${input.reason ?? 'unspecified'})`,
  );
  return {
    ok: true,
    result: 'RECOVERED',
    runId: input.expectedRunId,
    tabReset: true,
    cancelledPending,
  };
}

function registerExtensionConnection(ws: WebSocket, rawContextId: unknown): ExtensionProfileConnection {
  const contextId = typeof rawContextId === 'string' && rawContextId.trim()
    ? rawContextId.trim()
    : DEFAULT_CONTEXT_ID;
  const previous = extensionProfiles.get(contextId);
  if (previous && previous.ws !== ws) {
    previous.ws.close();
  }
  const existing = [...extensionProfiles.entries()].find(([, entry]) => entry.ws === ws);
  if (existing && existing[0] !== contextId) extensionProfiles.delete(existing[0]);

  const current = extensionProfiles.get(contextId);
  const connection: ExtensionProfileConnection = {
    contextId,
    ws,
    extensionVersion: current?.ws === ws ? current.extensionVersion : null,
    extensionCompatRange: current?.ws === ws ? current.extensionCompatRange : null,
    lastSeenAt: Date.now(),
  };
  extensionProfiles.set(contextId, connection);
  return connection;
}

function unregisterExtensionConnection(ws: WebSocket): void {
  for (const [contextId, connection] of extensionProfiles.entries()) {
    if (connection.ws !== ws) continue;
    extensionProfiles.delete(contextId);
    for (const [id, p] of pending) {
      if (p.contextId !== contextId) continue;
      const failure = buildExtensionDisconnectFailure({
        contextId,
        action: p.action,
        dispatched: p.dispatched,
      });
      if (failure.countAsCommandResultUnknown) {
        commandResultUnknownCount++;
        log.warn(`[daemon] Command result unknown after extension disconnect (id=${id}, action=${p.action}, context=${contextId})`);
      }
      settlePending(id, p, { error: new DaemonCommandFailure(failure.message, failure.errorCode, failure.errorHint, failure.status) });
    }
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────

function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // ─── Security: Origin & custom-header check ──────────────────────
  // Block browser-based CSRF: browsers always send an Origin header on
  // cross-origin requests.  Node.js CLI fetch does NOT send Origin, so
  // legitimate CLI requests pass through.  Chrome Extension connects via
  // WebSocket (which bypasses this HTTP handler entirely).
  const origin = req.headers['origin'] as string | undefined;
  if (origin && !origin.startsWith('chrome-extension://')) {
    jsonResponse(res, 403, { ok: false, error: 'Forbidden: cross-origin request blocked' });
    return;
  }

  // CORS: do NOT send Access-Control-Allow-Origin for normal requests.
  // Only handle preflight so browsers get a definitive "no" answer.
  if (req.method === 'OPTIONS') {
    // No ACAO header → browser will block the actual request.
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';
  const pathname = url.split('?')[0];

  // Health-check endpoint — no X-OpenCLI header required.
  // Used by the extension to silently probe daemon reachability before
  // attempting a WebSocket connection (avoids uncatchable ERR_CONNECTION_REFUSED).
  // Security note: this endpoint is reachable by any client that passes the
  // origin check above (chrome-extension:// or no Origin header, e.g. curl).
  // Timing side-channels can reveal daemon presence to local processes, which
  // is an accepted risk given the daemon is loopback-only and short-lived.
  if (req.method === 'GET' && pathname === '/ping') {
    jsonResponse(res, 200, { ok: true }, getResponseCorsHeaders(pathname, origin));
    return;
  }

  // Require custom header on all other HTTP requests.  Browsers cannot attach
  // custom headers in "simple" requests, and our preflight returns no
  // Access-Control-Allow-Headers, so scripted fetch() from web pages is
  // blocked even if Origin check is somehow bypassed.
  if (!req.headers['x-opencli']) {
    jsonResponse(res, 403, { ok: false, error: 'Forbidden: missing X-OpenCLI header' });
    return;
  }

  if (req.method === 'GET' && pathname === '/status') {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    const params = new URL(url, `http://localhost:${PORT}`).searchParams;
    const requestedContextId = params.get('contextId')?.trim() || undefined;
    const route = resolveExtensionConnection(requestedContextId);
    const profiles = activeProfiles().map((profile) => ({
      contextId: profile.contextId,
      extensionConnected: true,
      extensionVersion: profile.extensionVersion ?? undefined,
      extensionCompatRange: profile.extensionCompatRange ?? undefined,
      pending: [...pending.values()].filter((entry) => entry.contextId === profile.contextId).length,
      lastSeenAt: profile.lastSeenAt,
    }));
    jsonResponse(res, 200, {
      ok: true,
      pid: process.pid,
      uptime,
      daemonVersion: PKG_VERSION,
      extensionConnected: !!route.connection,
      extensionVersion: route.connection?.extensionVersion ?? undefined,
      extensionCompatRange: route.connection?.extensionCompatRange ?? undefined,
      contextId: route.connection?.contextId ?? requestedContextId,
      profileRequired: route.errorCode === 'profile_required',
      profileDisconnected: route.errorCode === 'profile_disconnected',
      profiles,
      pending: pending.size,
      capabilities: DAEMON_CAPABILITIES,
      sessionLeases: sessionLeaseStatus(),
      commandResultUnknown: commandResultUnknownCount,
      memoryMB: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      port: PORT,
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/logs') {
    const params = new URL(url, `http://localhost:${PORT}`).searchParams;
    const level = params.get('level');
    const filtered = level
      ? logBuffer.filter(e => e.level === level)
      : logBuffer;
    jsonResponse(res, 200, { ok: true, logs: filtered });
    return;
  }

  if (req.method === 'DELETE' && pathname === '/logs') {
    logBuffer.length = 0;
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/shutdown') {
    jsonResponse(res, 200, { ok: true, message: 'Shutting down' });
    setTimeout(() => shutdown(), 100);
    return;
  }

  if (req.method === 'POST' && pathname === '/session-leases/recover') {
    try {
      const readOutcome = await readBody(req);
      if (readOutcome.kind === 'too-large') {
        jsonResponse(res, REQUEST_BODY_TOO_LARGE_STATUS, {
          ok: false,
          errorCode: readOutcome.failure.errorCode,
          error: readOutcome.failure.message,
          errorHint: readOutcome.failure.errorHint,
          receivedBytes: readOutcome.failure.receivedBytes,
          limit: readOutcome.failure.limit,
        });
        return;
      }
      if (readOutcome.kind === 'read-error') {
        jsonResponse(res, 400, {
          ok: false,
          errorCode: 'invalid_session_recovery_request',
          error: readOutcome.error.message,
        });
        return;
      }
      const body = JSON.parse(readOutcome.body) as Record<string, unknown>;
      const contextId = typeof body.contextId === 'string' ? body.contextId.trim() : '';
      const surface = typeof body.surface === 'string' ? body.surface.trim() : '';
      const session = typeof body.session === 'string' ? body.session.trim() : '';
      const expectedRunId = typeof body.expectedRunId === 'string' ? body.expectedRunId.trim() : '';
      const mode = body.mode;
      if (!contextId || surface !== 'adapter' || !session || !expectedRunId || (
        mode !== 'RECLAIM_IF_IDLE' && mode !== 'CANCEL_AND_RESET'
      )) {
        jsonResponse(res, 400, {
          ok: false,
          errorCode: 'invalid_session_recovery_request',
          error: 'contextId, surface=adapter, session, expectedRunId, and a valid recovery mode are required.',
        });
        return;
      }
      const result = await recoverSessionLease({
        contextId,
        surface,
        session,
        expectedRunId,
        mode,
        ...(typeof body.reason === 'string' && body.reason.trim()
          ? { reason: body.reason.trim().replace(/[\r\n]+/g, ' ').slice(0, 200) }
          : {}),
      });
      jsonResponse(res, result.ok ? 200 : 503, result);
    } catch (err) {
      jsonResponse(res, 400, {
        ok: false,
        errorCode: 'invalid_session_recovery_request',
        error: err instanceof Error ? err.message : 'Invalid session recovery request',
      });
    }
    return;
  }

  if (req.method === 'POST' && url === '/command') {
    try {
      const readOutcome = await readBody(req);
      if (readOutcome.kind === 'too-large') {
        // 413 carries the canonical structured failure the CLI surfaces as a
        // BrowserCommandError(request_body_too_large, retryable=false). id is
        // intentionally absent: the body was never fully parsed, so echoing a
        // truncated id back would only confuse the client's journal lookup.
        jsonResponse(res, REQUEST_BODY_TOO_LARGE_STATUS, {
          ok: false,
          errorCode: readOutcome.failure.errorCode,
          error: readOutcome.failure.message,
          errorHint: readOutcome.failure.errorHint,
          receivedBytes: readOutcome.failure.receivedBytes,
          limit: readOutcome.failure.limit,
        });
        return;
      }
      if (readOutcome.kind === 'read-error') {
        jsonResponse(res, 400, { ok: false, error: readOutcome.error.message });
        return;
      }
      const body = JSON.parse(readOutcome.body);
      if (!body.id) {
        jsonResponse(res, 400, { ok: false, error: 'Missing command id' });
        return;
      }

      // ─── Session write lease: explicit release ───────────────────────
      // Daemon-local, never dispatched to the extension. Keyed by runId alone:
      // runIds are globally unique, and re-resolving the profile route here
      // could fail (the profile may have disconnected since acquire).
      if (body.action === 'lease-release') {
        if (typeof body.runId === 'string') sessionLeases.releaseByRunId(body.runId);
        jsonResponse(res, 200, { id: body.id, ok: true });
        return;
      }

      const route = resolveExtensionConnection(
        typeof body.contextId === 'string' ? body.contextId : undefined,
        typeof body.preferredContextId === 'string' ? body.preferredContextId : undefined,
      );
      if (!route.connection) {
        jsonResponse(res, route.errorCode === 'profile_required' ? 409 : 503, {
          id: body.id,
          ok: false,
          errorCode: route.errorCode,
          error: route.error,
          ...(route.errorHint ? { errorHint: route.errorHint } : {}),
        });
        return;
      }

      // ─── Session write lease: arbitration ────────────────────────────
      // Runs AFTER profile routing (the resolved contextId is part of the
      // lease key — the same site session in two Chrome profiles drives two
      // different browsers) but BEFORE any dispatch to the extension. The
      // first write acquires, same-runId execs refresh (heartbeat), and a
      // concurrent different-runId write fails fast. Read and ephemeral
      // commands are never arbitrated.
      let leaseKey: string | undefined;
      let leaseRunId: string | undefined;
      if (isSessionLeaseCommand(body)) {
        const now = Date.now();
        const key = getSessionLeaseKey(route.connection.contextId, body.surface, body.session);
        const current = sessionLeases.peek(key);
        // SIGKILL cannot run CLI cleanup. A challenger may prove the holder's
        // PID no longer exists, then safely reclaim an idle lease or start a
        // fenced reset for pending browser work. EPERM/unknown stay busy.
        if (
          current &&
          current.runId !== body.runId &&
          current.state === 'ACTIVE' &&
          isOwnerProcessConfirmedDead(current.pid)
        ) {
          const pendingCount = pendingCountForRun(current.runId);
          if (pendingCount === 0) {
            sessionLeases.beginRecovery({
              key,
              expectedRunId: current.runId,
              mode: 'RECLAIM_IF_IDLE',
              pendingCount,
              now,
            });
          } else {
            // recoverSessionLease fences synchronously before its first await.
            void recoverSessionLease({
              contextId: route.connection.contextId,
              surface: body.surface,
              session: body.session,
              expectedRunId: current.runId,
              mode: 'CANCEL_AND_RESET',
              reason: 'owner_process_dead',
            }).catch((err) => {
              log.error(`[daemon] Orphan session recovery failed: ${err instanceof Error ? err.message : String(err)}`);
            });
            const recovering = sessionLeases.peek(key) ?? current;
            const failure = buildSessionRecoveringFailure(body.session, recovering);
            jsonResponse(res, failure.status, {
              id: body.id,
              ok: false,
              errorCode: failure.errorCode,
              error: failure.message,
              errorHint: failure.errorHint,
            });
            return;
          }
        }
        const outcome = sessionLeases.touch(key, {
          runId: body.runId,
          command: typeof body.command === 'string' && body.command ? body.command : body.action,
          owner: typeof body.owner === 'string' ? body.owner : undefined,
          now,
          // A holder past the TTL whose exec is still in flight is alive — a
          // single slow command produces no heartbeat until it settles. A live
          // CLI between commands is also retained so recovery can fence it.
          hasPendingWork: runHasPendingWork,
          isRunAlive: isRunOwnerProcessAlive,
        });
        if (!outcome.granted) {
          const failure = outcome.reason === 'revoked'
            ? buildSessionLeaseRevokedFailure(body.session)
            : outcome.reason === 'recovering'
              ? buildSessionRecoveringFailure(body.session, outcome.holder)
              : buildSessionBusyFailure(body.session, outcome.holder, now);
          if (outcome.reason !== 'revoked') {
            log.warn(
              `[daemon] Session ${key} ${outcome.reason} — rejected ${body.command ?? body.action} ` +
              `(runId=${body.runId}); held by ${outcome.holder.command} (runId=${outcome.holder.runId})`,
            );
          }
          jsonResponse(res, failure.status, {
            id: body.id,
            ok: false,
            errorCode: failure.errorCode,
            error: failure.message,
            errorHint: failure.errorHint,
          });
          return;
        }
        leaseKey = key;
        leaseRunId = body.runId;
      }

      // Absolute deadline wins over the legacy duration field: all hops share
      // one wall clock, so remaining budget absorbs queueing/transit time.
      const timeoutMs = typeof body.deadlineAt === 'number' && body.deadlineAt > 0
        ? Math.max(1000, body.deadlineAt - Date.now())
        : (typeof body.timeout === 'number' && body.timeout > 0 ? body.timeout * 1000 : 120000);

      // A transport retry of an in-flight command attaches to it instead of
      // re-dispatching — the extension is already executing this id.
      const existing = pending.get(body.id);
      if (existing) {
        const result = await new Promise<unknown>((resolve, reject) => {
          existing.settlers.push({ resolve, reject });
        });
        jsonResponse(res, 200, result);
        return;
      }

      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          const entry = pending.get(body.id);
          if (!entry) return;
          const failure = buildCommandTimeoutFailure(entry.action, timeoutMs);
          if (failure.countAsCommandResultUnknown && entry.dispatched) {
            commandResultUnknownCount++;
            log.warn(`[daemon] Command timed out after dispatch (id=${body.id}, action=${entry.action}, timeout=${timeoutMs}ms)`);
          }
          settlePending(body.id, entry, { error: new DaemonCommandFailure(failure.message, failure.errorCode, failure.errorHint, failure.status) });
        }, timeoutMs);
        const entry: PendingEntry = {
          contextId: route.connection!.contextId,
          action: typeof body.action === 'string' ? body.action : 'unknown',
          dispatched: false,
          settlers: [{ resolve, reject }],
          timer,
          ...(leaseKey && leaseRunId ? { leaseKey, runId: leaseRunId } : {}),
        };
        pending.set(body.id, entry);
        const failBeforeDispatch = (err: unknown) => {
          if (pending.get(body.id) !== entry) return;
          const failure = buildCommandDispatchFailure(entry.contextId);
          settlePending(body.id, entry, { error: new DaemonCommandFailure(failure.message, failure.errorCode, failure.errorHint, failure.status) });
          log.warn(`[daemon] Failed to dispatch command ${body.id}: ${err instanceof Error ? err.message : String(err)}`);
        };
        try {
          route.connection!.ws.send(JSON.stringify(body), (err?: Error) => {
            if (err && !entry.dispatched) failBeforeDispatch(err);
          });
          // Once ws accepts the frame, the command may execute even if the
          // result is later lost; do not downgrade later disconnects to a
          // pre-dispatch failure just because no result/ack has arrived yet.
          entry.dispatched = true;
        } catch (err) {
          failBeforeDispatch(err);
        }
      });

      jsonResponse(res, 200, result);
    } catch (err) {
      const commandFailure = err instanceof DaemonCommandFailure ? err : null;
      jsonResponse(res, commandFailure?.status ?? (err instanceof Error && err.message.includes('timeout') ? 408 : 400), {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid request',
        ...(commandFailure?.errorCode ? { errorCode: commandFailure.errorCode } : {}),
        ...(commandFailure?.errorHint ? { errorHint: commandFailure.errorHint } : {}),
      });
    }
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

// ─── WebSocket for Extension ─────────────────────────────────────────

const httpServer = createServer((req, res) => { handleRequest(req, res).catch(() => { res.writeHead(500); res.end(); }); });
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ext',
  verifyClient: ({ req }: { req: IncomingMessage }) => {
    // Block browser-originated WebSocket connections.  Browsers don't
    // enforce CORS on WebSocket, so a malicious webpage could connect to
    // ws://localhost:19825/ext and impersonate the Extension.  Real Chrome
    // Extensions send origin chrome-extension://<id>.
    const origin = req.headers['origin'] as string | undefined;
    return !origin || origin.startsWith('chrome-extension://');
  },
});

wss.on('connection', (ws: WebSocket) => {
  log.info('[daemon] Extension connected');

  // ── Heartbeat: ping every 15s, close if 2 pongs missed ──
  let missedPongs = 0;
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(heartbeatInterval);
      return;
    }
    if (missedPongs >= 2) {
      log.warn('[daemon] Extension heartbeat lost, closing connection');
      clearInterval(heartbeatInterval);
      ws.terminate();
      return;
    }
    missedPongs++;
    ws.ping();
  }, 15000);

  ws.on('pong', () => {
    missedPongs = 0;
  });

  ws.on('message', (data: RawData) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle hello message from extension (version handshake)
      if (msg.type === 'hello') {
        const connection = registerExtensionConnection(ws, msg.contextId);
        connection.extensionVersion = typeof msg.version === 'string' ? msg.version : null;
        connection.extensionCompatRange = typeof msg.compatRange === 'string' ? msg.compatRange : null;
        connection.lastSeenAt = Date.now();
        if (connection.extensionVersion) recordExtensionVersion(connection.extensionVersion);
        log.info(`[daemon] Extension profile connected: ${connection.contextId}`);
        return;
      }

      // Handle log messages from extension
      if (msg.type === 'log') {
        if (msg.level === 'error') log.error(`[ext] ${msg.msg}`);
        else if (msg.level === 'warn') log.warn(`[ext] ${msg.msg}`);
        else log.info(`[ext] ${msg.msg}`);
        pushLog({ level: msg.level, msg: msg.msg, ts: msg.ts ?? Date.now() });
        return;
      }

      // Application-level keepalive from the extension — WS traffic is what
      // keeps the MV3 service worker alive; nothing to do here.
      if (msg.type === 'ping') return;

      // Handle command results
      const p = pending.get(msg.id);
      if (p) {
        if (p.recoveryRevoked) {
          log.warn(`[daemon] Ignoring late result from fenced run (id=${msg.id}, action=${p.action}, runId=${p.runId})`);
          return;
        }
        settlePending(msg.id, p, { data: msg });
      }
    } catch (err) {
      // Malformed message from the extension. Surface so protocol drift /
      // version skew between daemon and extension shows up in the log
      // instead of presenting as a generic command timeout downstream.
      const sample = data.toString().slice(0, 200);
      log.warn(
        `[daemon] Ignoring malformed WS message from extension: ` +
        `${err instanceof Error ? err.message : String(err)} (first 200 chars: ${JSON.stringify(sample)})`,
      );
    }
  });

  ws.on('close', () => {
    log.info('[daemon] Extension disconnected');
    clearInterval(heartbeatInterval);
    unregisterExtensionConnection(ws);
  });

  ws.on('error', () => {
    clearInterval(heartbeatInterval);
    unregisterExtensionConnection(ws);
  });
});

// ─── Start ───────────────────────────────────────────────────────────

httpServer.listen(PORT, '127.0.0.1', () => {
  log.info(`[daemon] Listening on http://127.0.0.1:${PORT}`);
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`[daemon] Port ${PORT} already in use — another daemon is likely running. Exiting.`);
    process.exit(EXIT_CODES.SERVICE_UNAVAIL);
  }
  log.error(`[daemon] Server error: ${err.message}`);
  process.exit(EXIT_CODES.GENERIC_ERROR);
});

// Graceful shutdown
function shutdown(): void {
  // Reject all pending requests so the CLI gets a structured response it can
  // act on instead of a socket hang-up it must treat as result-unknown.
  // Not-yet-dispatched commands get the pre-dispatch contract (safe to resend
  // anywhere); dispatched ones get `daemon_shutting_down`, which the client
  // only resends when the extension journals ids.
  for (const [id, p] of pending) {
    const failure = p.dispatched
      ? new DaemonCommandFailure(
        'Daemon shutting down before the command completed.',
        'daemon_shutting_down',
        'The daemon is being replaced; a journaling extension replays the command result on retry.',
        503,
      )
      : (() => {
        const contract = buildCommandDispatchFailure(p.contextId);
        return new DaemonCommandFailure(contract.message, contract.errorCode, contract.errorHint, contract.status);
      })();
    settlePending(id, p, { error: failure });
  }
  pending.clear();
  for (const profile of extensionProfiles.values()) profile.ws.close();
  // Let the rejection responses flush before exiting — a synchronous
  // process.exit() would kill the queued microtasks that write them.
  httpServer.close(() => process.exit(EXIT_CODES.SUCCESS));
  setTimeout(() => {
    httpServer.closeIdleConnections?.();
    setTimeout(() => process.exit(EXIT_CODES.SUCCESS), 500).unref();
  }, 100).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
