/**
 * Per-(contextId, surface, session) write-command arbitration for the daemon.
 *
 * A long adapter write command (e.g. `chatgpt ask`, 10-20 min) is hundreds of
 * short 'exec' round-trips against ONE persistent site session. When an outer
 * agent times out and retries while the first process is still alive, both
 * processes drive the same Chrome tab, multiplying renderer load — there is no
 * arbitration at the exec level because two interleaved asks rarely have an
 * exec in flight at the same instant.
 *
 * This registry grants ONE logical write lease per (contextId, surface,
 * session) that spans the whole CLI command run. A second concurrent write
 * fails fast. A dead holder (kill -9, crash) becomes reclaimable after its
 * TTL/pending state is checked, while a process that can still be confirmed
 * alive remains observable so recovery can fence it instead of losing track of
 * an adapter between browser commands.
 *
 * The daemon is the arbiter because it is the single local process that sees
 * every CLI client; keeping the logic here (pure, no I/O) makes it testable
 * without Chrome.
 */

/** Inactivity window after which a lease is considered abandoned. */
export const SESSION_LEASE_TTL_MS = 45_000;

/** Machine-readable error code for the fast-fail busy response. */
export const SESSION_BUSY_CODE = 'session_busy';
/** A recovery owns the lease while the old browser session is being reset. */
export const SESSION_RECOVERING_CODE = 'session_recovering';
/** A fenced run tried to issue another command after recovery started. */
export const SESSION_LEASE_REVOKED_CODE = 'session_lease_revoked';
/** The browser session reset could not be confirmed. */
export const SESSION_RECOVERY_FAILED_CODE = 'session_recovery_failed';

export type SessionLeaseState = 'ACTIVE' | 'RECOVERING';
export type SessionLeaseRecoveryMode = 'RECLAIM_IF_IDLE' | 'CANCEL_AND_RESET';
export type SessionLeaseRecoveryResult = 'RECOVERED' | 'ALREADY_FREE' | 'STILL_ACTIVE' | 'OWNER_CHANGED';

export interface SessionLeaseHolder {
  /** Stable per logical CLI command run (NOT the per-exec command id). */
  runId: string;
  /** Human command name, e.g. `chatgpt ask`. */
  command: string;
  /** CLI process pid recovered from the runId, for conservative orphan detection. */
  pid: number | null;
  /** When the current holder first acquired the lease. */
  startedAt: number;
  /** Last time an exec from the holder refreshed the lease (heartbeat). */
  lastSeenAt: number;
  /** Caller-supplied ownership label for observability and recovery routing. */
  owner: string;
  /** ACTIVE normally; RECOVERING fences the old run until reset is confirmed. */
  state: SessionLeaseState;
}

/**
 * Lease key = `${contextId}␟${surface}␟${encodeURIComponent(session)}`. The
 * Chrome profile (contextId) is part of the key because a persistent site
 * session name like `site:chatgpt` is only unique WITHIN a profile — the same
 * adapter running in two profiles drives two different browsers and must never
 * self-block. The unit separator (U+241F) cannot appear in a contextId or
 * surface value; the session segment matches the extension's own lease-key
 * encoding so both layers partition sessions the same way.
 */
export function getSessionLeaseKey(contextId: string, surface: string, session: string): string {
  return `${contextId}␟${surface}␟${encodeURIComponent(session)}`;
}

/** Decode the daemon-internal key for status output; malformed keys stay hidden. */
export function parseSessionLeaseKey(key: string): { contextId: string; surface: string; session: string } | null {
  const [contextId, surface, encodedSession, ...extra] = key.split('␟');
  if (!contextId || !surface || !encodedSession || extra.length > 0) return null;
  try {
    return { contextId, surface, session: decodeURIComponent(encodedSession) };
  } catch {
    return null;
  }
}

/** CLI runIds are `run_<pid>_<ts>_<rand>`; recover the pid for the busy hint. */
export function parsePidFromRunId(runId: string): number | null {
  const match = /^run_(\d+)_/.exec(runId);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export type SessionLeaseCommand = {
  surface?: unknown;
  siteSession?: unknown;
  access?: unknown;
  session?: unknown;
  runId?: unknown;
};

/**
 * A command is subject to lease arbitration only when it is an adapter write
 * against a persistent site session and carries the identity needed to own a
 * lease. Read commands, ephemeral sessions, and non-adapter surfaces are never
 * arbitrated — a user mid-ask must still be able to check state.
 */
export function isSessionLeaseCommand<T extends SessionLeaseCommand>(
  command: T,
): command is T & { surface: 'adapter'; siteSession: 'persistent'; access: 'write'; session: string; runId: string } {
  return (
    command.surface === 'adapter' &&
    command.siteSession === 'persistent' &&
    command.access === 'write' &&
    typeof command.session === 'string' && command.session.length > 0 &&
    typeof command.runId === 'string' && command.runId.length > 0
  );
}

export type LeaseTouchResult =
  | { granted: true; holder: SessionLeaseHolder }
  | { granted: false; reason: 'busy' | 'recovering'; holder: SessionLeaseHolder }
  | { granted: false; reason: 'revoked' };

export class SessionLeaseRegistry {
  private readonly leases = new Map<string, SessionLeaseHolder>();
  /** Keep forced-recovery fences for the daemon lifetime. */
  private readonly revokedRunIds = new Set<string>();

  constructor(private readonly ttlMs: number = SESSION_LEASE_TTL_MS) {}

  /**
   * Acquire or refresh the lease for `key`.
   *
   * - Free key, or the current holder's lease has gone stale (holder died
   *   without releasing): the caller takes it — `granted: true`.
   * - Same runId as the current holder: refresh (heartbeat) — `granted: true`.
   * - A different runId while the holder is still alive: `granted: false`, and
   *   `holder` describes who to wait for or kill.
   *
   * Liveness is TTL-based, but a TTL-stale holder with a command still in
   * flight is NOT dead — a single exec can legitimately outlast the TTL (e.g.
   * a slow navigate produces no heartbeat until it settles). `hasPendingWork`
   * lets the daemon report that, keeping the registry pure.
   */
  touch(
    key: string,
    input: {
      runId: string;
      command: string;
      owner?: string;
      now: number;
      hasPendingWork?: (runId: string) => boolean;
      isRunAlive?: (runId: string) => boolean;
    },
  ): LeaseTouchResult {
    if (this.revokedRunIds.has(input.runId)) return { granted: false, reason: 'revoked' };

    const current = this.leases.get(key);
    if (current?.state === 'RECOVERING') {
      return { granted: false, reason: 'recovering', holder: current };
    }
    const alive = current !== undefined && (
      input.now - current.lastSeenAt <= this.ttlMs ||
      input.hasPendingWork?.(current.runId) === true ||
      input.isRunAlive?.(current.runId) === true
    );
    if (current !== undefined && alive && current.runId !== input.runId) {
      return { granted: false, reason: 'busy', holder: current };
    }
    const holder: SessionLeaseHolder = current !== undefined && current.runId === input.runId
      ? { ...current, command: input.command, owner: input.owner?.trim() || current.owner, lastSeenAt: input.now }
      : {
        runId: input.runId,
        command: input.command,
        pid: parsePidFromRunId(input.runId),
        startedAt: input.now,
        lastSeenAt: input.now,
        owner: input.owner?.trim() || 'cli',
        state: 'ACTIVE',
      };
    this.leases.set(key, holder);
    return { granted: true, holder };
  }

  /**
   * Refresh the holder's liveness without acquiring: called when one of the
   * holder's in-flight commands settles, so the TTL clock restarts cleanly
   * after an exec that outlived it. A non-owner runId never resurrects or
   * steals a lease here.
   */
  heartbeat(key: string, runId: string, now: number): void {
    const current = this.leases.get(key);
    if (
      current !== undefined &&
      current.runId === runId &&
      current.state === 'ACTIVE' &&
      !this.revokedRunIds.has(runId)
    ) {
      current.lastSeenAt = now;
    }
  }

  /**
   * Release every lease held by `runId` (idempotent). Keyless on purpose: the
   * release path must not depend on re-resolving the profile route — the
   * profile may have disconnected by the time the CLI releases — and runIds
   * are globally unique, so the runId alone identifies the lease.
   */
  releaseByRunId(runId: string): void {
    for (const [key, holder] of this.leases) {
      // A late release from a fenced CLI must not bypass an unconfirmed reset.
      if (holder.runId === runId && holder.state === 'ACTIVE') this.leases.delete(key);
    }
  }

  /** Return a holder without TTL eviction; daemon recovery performs its own liveness check. */
  peek(key: string): SessionLeaseHolder | undefined {
    return this.leases.get(key);
  }

  isRevoked(runId: string): boolean {
    return this.revokedRunIds.has(runId);
  }

  /**
   * Compare-and-set recovery transition. It fences first, then either releases
   * an idle holder or leaves a RECOVERING holder for async reset completion.
   */
  beginRecovery(input: {
    key: string;
    expectedRunId: string;
    mode: SessionLeaseRecoveryMode;
    pendingCount: number;
    now: number;
  }): { result: SessionLeaseRecoveryResult; holder?: SessionLeaseHolder; retryReset?: boolean } {
    const current = this.leases.get(input.key);
    if (!current) return { result: 'ALREADY_FREE' };
    if (current.runId !== input.expectedRunId) return { result: 'OWNER_CHANGED', holder: current };
    // A previous reset may have timed out after fencing the run. Retrying the
    // reset is safe, but reclaiming it without a confirmed reset is not.
    if (current.state === 'RECOVERING') {
      return input.mode === 'CANCEL_AND_RESET'
        ? { result: 'STILL_ACTIVE', holder: current, retryReset: true }
        : { result: 'STILL_ACTIVE', holder: current };
    }
    if (input.mode === 'RECLAIM_IF_IDLE' && input.pendingCount > 0) {
      return { result: 'STILL_ACTIVE', holder: current };
    }

    this.revokedRunIds.add(input.expectedRunId);
    if (input.mode === 'RECLAIM_IF_IDLE') {
      this.leases.delete(input.key);
      return { result: 'RECOVERED', holder: current };
    }

    current.state = 'RECOVERING';
    current.lastSeenAt = input.now;
    return { result: 'RECOVERED', holder: current };
  }

  /** Delete only the exact holder that was fenced and successfully reset. */
  completeRecovery(key: string, expectedRunId: string): boolean {
    const current = this.leases.get(key);
    if (!current || current.runId !== expectedRunId || current.state !== 'RECOVERING') return false;
    this.leases.delete(key);
    return true;
  }

  /** Active holder for `key`, lazily evicting only a stale, non-live one. */
  get(key: string, now: number, isRunAlive?: (runId: string) => boolean): SessionLeaseHolder | undefined {
    const current = this.leases.get(key);
    if (current === undefined) return undefined;
    if (current.state === 'RECOVERING') return current;
    if (now - current.lastSeenAt > this.ttlMs && isRunAlive?.(current.runId) !== true) {
      this.leases.delete(key);
      return undefined;
    }
    return current;
  }

  /**
   * Snapshot of active holders for status surfaces (who owns each session).
   * Uses the same aliveness rule as `touch()`: a TTL-stale holder with a
   * command still in flight is alive, not dead, so `hasPendingWork` keeps it
   * listed. Without it, `/status` would show no holder while challengers are
   * still being rejected — misleading during a single long exec. Read-only:
   * never lazily evicts.
   */
  list(
    now: number,
    hasPendingWork?: (runId: string) => boolean,
    isRunAlive?: (runId: string) => boolean,
  ): Array<{ key: string } & SessionLeaseHolder> {
    const out: Array<{ key: string } & SessionLeaseHolder> = [];
    for (const [key, holder] of this.leases) {
      const alive = holder.state === 'RECOVERING'
        || now - holder.lastSeenAt <= this.ttlMs
        || hasPendingWork?.(holder.runId) === true
        || isRunAlive?.(holder.runId) === true;
      if (alive) out.push({ key, ...holder });
    }
    return out;
  }
}

export interface SessionBusyFailure {
  message: string;
  errorCode: string;
  errorHint: string;
  status: number;
}

export function buildSessionRecoveringFailure(session: string, holder: SessionLeaseHolder): SessionBusyFailure {
  return {
    message: `Session "${session}" is recovering from ${holder.command}; wait for the reset to complete.`,
    errorCode: SESSION_RECOVERING_CODE,
    errorHint: 'Do not retry the original write command until session recovery finishes. Read-only commands are not blocked.',
    status: 409,
  };
}

export function buildSessionLeaseRevokedFailure(session: string): SessionBusyFailure {
  return {
    message: `Session "${session}" rejected a command from a run cancelled during session recovery.`,
    errorCode: SESSION_LEASE_REVOKED_CODE,
    errorHint: 'The write outcome may be unknown. Inspect the browser/session state; do not replay the command automatically.',
    status: 409,
  };
}

/** Build the fast-fail response naming the holder, its pid, and hold time. */
export function buildSessionBusyFailure(
  session: string,
  holder: SessionLeaseHolder,
  now: number,
): SessionBusyFailure {
  const heldSeconds = Math.max(0, Math.round((now - holder.startedAt) / 1000));
  const who = holder.pid != null ? `${holder.command} (pid ${holder.pid})` : holder.command;
  const stop = 'Wait for it to finish, or have its owner request a fenced session recovery.';
  return {
    message: `Session "${session}" is busy: ${who} has been driving it for ${heldSeconds}s.`,
    errorCode: SESSION_BUSY_CODE,
    errorHint: `${stop} Read-only commands are not blocked.`,
    status: 409,
  };
}
