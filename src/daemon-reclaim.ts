/**
 * Daemon-side contract for the sessionless `reclaim-adapter-tabs` command.
 *
 * The extension reclaims every adapter tab it owns (active leases, released
 * leftovers, tabs replaced by `tabs new`) while keeping the adapter window and
 * the profile/login state intact. The daemon's job here is narrow:
 *
 * - parse and bound the request (explicit context, absolute deadline);
 * - arbitrate admission against in-flight commands, logical write leases, and
 *   concurrent maintenance;
 * - parse the per-profile capabilities the extension advertises in `hello`.
 *
 * All functions are pure so the request/admission matrix is unit-testable
 * without a live daemon; the daemon wires them to the HTTP/WS transport.
 */

/** Capability a Browser Bridge profile advertises when it can reclaim adapter tabs. */
export const ADAPTER_TAB_RECLAIM_CAPABILITY = 'adapter-tab-reclaim-v1';

/** Wire action for the sessionless adapter tab reclamation command. */
export const ADAPTER_TAB_RECLAIM_ACTION = 'reclaim-adapter-tabs';

/**
 * Upper bound the daemon stamps on the caller's absolute deadline at receipt.
 * A reclaim never gets more than 5s of wall clock even if the caller asks for
 * more; a shorter caller deadline is preserved.
 */
export const RECLAIM_MAX_DEADLINE_MS = 5_000;

/** Structured failure shared by request parsing and admission. */
export type ReclaimFailure = {
  errorCode: string;
  error: string;
  errorHint: string;
  status: number;
};

export type AdmissionResult = { ok: true } | { ok: false; failure: ReclaimFailure };

/** A validated reclaim request with the daemon-stamped bounded deadline. */
export type ReclaimRequest = {
  id: string;
  contextId: string;
  /** Absolute epoch-ms deadline forwarded to the extension (already clamped). */
  deadlineAt: number;
  /** Remaining budget used for the daemon's pending timer (min remaining, no floor). */
  timeoutMs: number;
};

export type ReclaimParseResult =
  | { ok: true; request: ReclaimRequest }
  | { ok: false; failure: ReclaimFailure };

function invalidReclaimRequest(message: string): ReclaimParseResult {
  return {
    ok: false,
    failure: {
      errorCode: 'invalid_reclaim_request',
      error: message,
      errorHint: 'Send {id, action:"reclaim-adapter-tabs", contextId, surface:"adapter", deadlineAt}.',
      status: 400,
    },
  };
}

/** True for the sessionless adapter tab reclamation action. */
export function isAdapterTabReclaimAction(body: unknown): boolean {
  return !!body
    && typeof body === 'object'
    && (body as { action?: unknown }).action === ADAPTER_TAB_RECLAIM_ACTION;
}

/**
 * Parse the capability strings a Browser Bridge profile advertises in its
 * `hello` handshake. Only strings are honored (trimmed, deduplicated) — the
 * daemon never fabricates capabilities or infers them from the version.
 */
export function parseExtensionCapabilities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const capabilities: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const capability = entry.trim();
    if (!capability || capabilities.includes(capability)) continue;
    capabilities.push(capability);
  }
  return capabilities;
}

/**
 * Validate the caller's absolute deadline and clamp it to at most
 * `now + RECLAIM_MAX_DEADLINE_MS`. A missing/non-finite/non-integer value is a
 * shape error (`reclaim_failed`); a value that is not strictly in the future is
 * already expired (`reclaim_deadline_exceeded`). Never restarts the clock.
 */
export function resolveReclaimDeadline(
  raw: unknown,
  now: number,
): { ok: true; deadlineAt: number } | { ok: false; failure: ReclaimFailure } {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return {
      ok: false,
      failure: {
        errorCode: 'reclaim_failed',
        error: 'reclaim-adapter-tabs requires a finite integer absolute deadlineAt (epoch ms).',
        errorHint: 'Retry through the daemon, which stamps a bounded 5s deadline.',
        status: 400,
      },
    };
  }
  if (raw <= now) {
    return {
      ok: false,
      failure: {
        errorCode: 'reclaim_deadline_exceeded',
        error: `Adapter tab reclamation deadline (${raw}) is not in the future.`,
        errorHint: 'Retry reclaim-adapter-tabs with a fresh deadline.',
        status: 408,
      },
    };
  }
  return { ok: true, deadlineAt: Math.min(raw, now + RECLAIM_MAX_DEADLINE_MS) };
}

/**
 * Validate the full reclaim request at HTTP receipt. Requires an explicit
 * non-blank contextId and surface="adapter"; the id is caller-provided (the CLI
 * sends a fresh UUID per logical reclaim).
 */
export function parseReclaimRequest(body: Record<string, unknown>, now: number): ReclaimParseResult {
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return invalidReclaimRequest('reclaim-adapter-tabs requires a non-empty command id.');
  const contextId = typeof body.contextId === 'string' ? body.contextId.trim() : '';
  if (!contextId) {
    return invalidReclaimRequest('reclaim-adapter-tabs requires an explicit non-blank contextId.');
  }
  const surface = typeof body.surface === 'string' ? body.surface.trim() : '';
  if (surface !== 'adapter') {
    return invalidReclaimRequest('reclaim-adapter-tabs requires surface="adapter".');
  }
  const deadline = resolveReclaimDeadline(body.deadlineAt, now);
  if (!deadline.ok) return { ok: false, failure: deadline.failure };
  return {
    ok: true,
    request: {
      id,
      contextId,
      deadlineAt: deadline.deadlineAt,
      timeoutMs: deadline.deadlineAt - now,
    },
  };
}

/**
 * Admit (or reject) a reclaim before any dispatch.
 *
 * A reclaim is refused while the same context has an in-flight command, holds a
 * live or recovering logical write lease, or already has a reclamation in
 * flight. A profile that does not advertise the reclaim capability is refused
 * outright — capability, never version, decides.
 */
export function evaluateReclaimAdmission(input: {
  capabilitySupported: boolean;
  sameContextPendingCommands: number;
  sameContextHasLease: boolean;
  sameContextReclaiming: boolean;
}): AdmissionResult {
  if (!input.capabilitySupported) {
    return {
      ok: false,
      failure: {
        errorCode: 'adapter_tab_reclaim_unsupported',
        error: 'The connected Browser Bridge profile does not advertise adapter-tab-reclaim-v1.',
        errorHint: 'Update the Browser Bridge extension for this profile, then retry.',
        status: 409,
      },
    };
  }
  if (input.sameContextReclaiming || input.sameContextPendingCommands > 0) {
    return {
      ok: false,
      failure: {
        errorCode: 'adapter_tabs_busy',
        error: 'Another command is in flight for this browser context; the reclaim was not started.',
        errorHint: 'Wait for the in-flight command to finish, then retry reclaim-adapter-tabs.',
        status: 409,
      },
    };
  }
  if (input.sameContextHasLease) {
    return {
      ok: false,
      failure: {
        errorCode: 'adapter_tabs_busy',
        error: 'An active or recovering adapter session lease exists for this context; the reclaim was not started.',
        errorHint: 'Wait for the adapter session to be released or recovered, then retry reclaim-adapter-tabs.',
        status: 409,
      },
    };
  }
  return { ok: true };
}

/**
 * Refuse an ordinary browser command for a context while a reclamation holds
 * its maintenance guard, so nothing races the destructive tab close. Other
 * contexts are unaffected.
 */
export function evaluateBrowserCommandAdmission(input: {
  contextId: string;
  reclaiming: boolean;
}): AdmissionResult {
  if (input.reclaiming) {
    return {
      ok: false,
      failure: {
        errorCode: 'adapter_tabs_busy',
        error: `Adapter tab reclamation is in progress for browser profile "${input.contextId}"; the command was not dispatched.`,
        errorHint: 'Retry after the reclaim-adapter-tabs command finishes.',
        status: 409,
      },
    };
  }
  return { ok: true };
}
