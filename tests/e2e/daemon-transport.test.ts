/**
 * Daemon transport contract E2E — the REAL daemon binary driven end to end.
 *
 * Complements browser-tabs.test.ts (fake daemon + real CLI) and
 * browser-ax-chrome.test.ts (fake daemon + real extension) with the missing
 * axis: a real `dist/src/daemon.js` process, a scripted fake extension on the
 * WebSocket side, and raw HTTP on the client side. Each test pins a
 * cross-layer contract that unit tests can only cover in isolation — the
 * exact classes of bugs that historically shipped:
 *
 * - duplicate command ids attach to the pending command (no re-dispatch)
 * - the per-command deadline produces a structured 408, not a hang
 * - extension disconnect after dispatch yields command_result_unknown
 * - a stale preferred profile falls back to the only connected profile
 * - /status resolves multi-profile ambiguity through preferredContextId
 * - graceful shutdown flushes structured 503s instead of dropping sockets
 *
 * Requires port 19825 (the fixed bridge port); lives in the e2e-fixed-port
 * project so it never runs concurrently with other fixed-port suites.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DAEMON_ENTRY = path.join(ROOT, 'dist', 'src', 'daemon.js');
const PORT = 19825;
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { 'X-OpenCLI': '1', 'Content-Type': 'application/json' };

type WireResult = {
  id?: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  errorHint?: string;
};

/** Scripted stand-in for the Browser Bridge extension. */
class FakeExtension {
  private ws: WebSocket | null = null;
  readonly received: Array<Record<string, unknown>> = [];
  /** Per-action handler; return null to stay silent (simulate a hang). */
  onCommand: (cmd: Record<string, unknown>) => WireResult | null = (cmd) => ({
    id: String(cmd.id),
    ok: true,
    data: { echo: cmd.action },
  });

  async connect(contextId: string, version = '1.0.22'): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`, {
      headers: { origin: 'chrome-extension://e2e-fake-extension' },
    });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', contextId, version, compatRange: '>=1.0.0' }));
        resolve();
      });
      ws.once('error', reject);
    });
    ws.on('message', (raw) => {
      const cmd = JSON.parse(raw.toString()) as Record<string, unknown>;
      this.received.push(cmd);
      const result = this.onCommand(cmd);
      if (result) ws.send(JSON.stringify(result));
    });
    // Give the daemon a beat to register the hello before commands route.
    await waitFor(async () => {
      const status = await getStatus();
      return status?.extensionConnected === true || (status?.profiles ?? []).some((p: any) => p.contextId === contextId);
    }, 5_000, 'daemon did not register the fake extension');
  }

  dispatchCountFor(id: string): number {
    return this.received.filter((cmd) => cmd.id === id).length;
  }

  send(result: WireResult): void {
    this.ws?.send(JSON.stringify(result));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  terminate(): void {
    this.ws?.terminate();
    this.ws = null;
  }
}

async function getStatus(query = ''): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}/status${query}`, { headers: HEADERS, signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function postCommand(body: Record<string, unknown>, timeoutMs = 15_000): Promise<{ status: number; result: WireResult }> {
  const res = await fetch(`${BASE}/command`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, result: (await res.json()) as WireResult };
}

async function postRecovery(body: Record<string, unknown>, timeoutMs = 15_000): Promise<{ status: number; result: WireResult }> {
  const res = await fetch(`${BASE}/session-leases/recover`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, result: (await res.json()) as WireResult };
}

function persistentWrite(input: { id: string; runId: string; session?: string; owner?: string }): Record<string, unknown> {
  return {
    id: input.id,
    action: 'exec',
    code: 'window.__write = true',
    session: input.session ?? 'site:chatgpt-agent',
    surface: 'adapter',
    siteSession: 'persistent',
    access: 'write',
    runId: input.runId,
    command: 'chatgpt-agent ask',
    owner: input.owner ?? 'e2e-owner',
  };
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function isPortBusy(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port: PORT, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

let nextId = 0;
function cmdId(): string {
  return `e2e-transport-${process.pid}-${++nextId}`;
}

describe('daemon transport contracts (real daemon)', () => {
  let daemon: ChildProcess | null = null;
  let skipReason = '';

  beforeAll(async () => {
    if (await isPortBusy()) {
      skipReason = `Port ${PORT} is already in use; stop the local opencli daemon before running this suite`;
      if (process.env.CI === 'true') throw new Error(skipReason);
      return;
    }
    daemon = spawn(process.execPath, [DAEMON_ENTRY], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    daemon.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    try {
      await waitFor(async () => (await getStatus()) !== null, 10_000, 'daemon did not start');
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}\ndaemon stderr:\n${stderr.slice(-2_000)}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!daemon) return;
    try {
      await fetch(`${BASE}/shutdown`, { method: 'POST', headers: HEADERS, signal: AbortSignal.timeout(2_000) });
    } catch { /* daemon may already be gone */ }
    await new Promise<void>((resolve) => {
      if (!daemon || daemon.exitCode !== null) return resolve();
      daemon.once('exit', () => resolve());
      setTimeout(() => { daemon?.kill('SIGKILL'); resolve(); }, 3_000);
    });
  });

  function guard(): boolean {
    if (skipReason) {
      console.warn(`skipped — ${skipReason}`);
      return true;
    }
    return false;
  }

  it('dispatches a command to the connected extension and correlates the result', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    await ext.connect('ctx-happy');
    try {
      const id = cmdId();
      const { status, result } = await postCommand({ id, action: 'exec', code: '1 + 1', session: 's', surface: 'browser' });
      expect(status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ echo: 'exec' });
      expect(ext.dispatchCountFor(id)).toBe(1);
    } finally {
      ext.close();
    }
  });

  it('attaches a duplicate command id to the pending command instead of re-dispatching', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    ext.onCommand = (cmd) => {
      // Answer asynchronously so the duplicate arrives while pending.
      void held.then(() => ext.send({ id: String(cmd.id), ok: true, data: 'once' }));
      return null;
    };
    await ext.connect('ctx-dup');
    try {
      const id = cmdId();
      const first = postCommand({ id, action: 'navigate', url: 'https://example.com', session: 's', surface: 'browser' });
      await waitFor(() => ext.dispatchCountFor(id) === 1, 5_000, 'command was not dispatched');
      const second = postCommand({ id, action: 'navigate', url: 'https://example.com', session: 's', surface: 'browser' });
      // The duplicate must NOT reach the extension a second time.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(ext.dispatchCountFor(id)).toBe(1);
      release!();
      const [a, b] = await Promise.all([first, second]);
      expect(a.result.ok).toBe(true);
      expect(b.result.ok).toBe(true);
      expect(a.result.data).toBe('once');
      expect(b.result.data).toBe('once');
      expect(ext.dispatchCountFor(id)).toBe(1);
    } finally {
      ext.close();
    }
  });

  it('returns a structured 408 command_result_unknown when the deadline passes with no result', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    ext.onCommand = () => null; // simulate a wedged extension
    await ext.connect('ctx-deadline');
    try {
      const { status, result } = await postCommand({
        id: cmdId(),
        action: 'exec',
        code: 'while(true){}',
        session: 's',
        surface: 'browser',
        deadlineAt: Date.now() + 1_500,
      });
      expect(status).toBe(408);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('command_result_unknown');
    } finally {
      ext.close();
    }
  });

  it('reports command_result_unknown when the extension dies after dispatch', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    ext.onCommand = () => null;
    await ext.connect('ctx-dropout');
    const id = cmdId();
    const inflight = postCommand({ id, action: 'navigate', url: 'https://example.com', session: 's', surface: 'browser' });
    await waitFor(() => ext.dispatchCountFor(id) === 1, 5_000, 'command was not dispatched');
    ext.terminate(); // hard drop, as if the service worker was killed
    const { status, result } = await inflight;
    expect(status).toBe(503);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('command_result_unknown');
  });

  it('serves a stale preferredContextId from the only connected profile, but fails loud for a required one', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    await ext.connect('ctx-live');
    try {
      // Preference: stale default must not veto the only live profile.
      const preferred = await postCommand({
        id: cmdId(),
        action: 'exec',
        code: '1',
        session: 's',
        surface: 'browser',
        preferredContextId: 'ctx-ghost',
      });
      expect(preferred.result.ok).toBe(true);

      // Requirement: an explicit profile fails loud when offline.
      const required = await postCommand({
        id: cmdId(),
        action: 'exec',
        code: '1',
        session: 's',
        surface: 'browser',
        contextId: 'ctx-ghost',
      });
      expect(required.result.ok).toBe(false);
      expect(required.result.errorCode).toBe('profile_disconnected');
    } finally {
      ext.close();
    }
  });

  it('fences a pending writer, resets its session, and admits a new writer only after reset confirmation', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    const oldId = cmdId();
    let resetId: string | null = null;
    ext.onCommand = (cmd) => {
      if (cmd.action === 'close-window') {
        resetId = String(cmd.id);
        return null; // Hold reset open so the challenger observes RECOVERING.
      }
      if (cmd.id === oldId) return null; // Simulate an in-flight browser write.
      return { id: String(cmd.id), ok: true, data: { echo: cmd.action } };
    };
    await ext.connect('ctx-recover');
    try {
      const old = postCommand(persistentWrite({
        id: oldId,
        runId: 'run_111_1_old',
        owner: 'opencli-hub:instance:execution-old',
      }));
      await waitFor(() => ext.dispatchCountFor(oldId) === 1, 5_000, 'old writer was not dispatched');

      const before = await getStatus();
      expect(before?.capabilities).toContain('session-lease-v1');
      expect(before?.capabilities).toContain('session-recover-v1');
      expect(before?.sessionLeases).toEqual(expect.arrayContaining([
        expect.objectContaining({
          contextId: 'ctx-recover',
          session: 'site:chatgpt-agent',
          runId: 'run_111_1_old',
          owner: 'opencli-hub:instance:execution-old',
          pendingCount: 1,
          state: 'ACTIVE',
        }),
      ]));

      const recovery = postRecovery({
        contextId: 'ctx-recover',
        surface: 'adapter',
        session: 'site:chatgpt-agent',
        expectedRunId: 'run_111_1_old',
        mode: 'CANCEL_AND_RESET',
        reason: 'execution_timeout',
      });
      await waitFor(() => resetId !== null, 5_000, 'session reset was not dispatched');
      const followerRecovery = postRecovery({
        contextId: 'ctx-recover',
        surface: 'adapter',
        session: 'site:chatgpt-agent',
        expectedRunId: 'run_111_1_old',
        mode: 'CANCEL_AND_RESET',
        reason: 'duplicate_recovery_request',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ext.received.filter((cmd) => cmd.action === 'close-window')).toHaveLength(1);

      const blockedId = cmdId();
      const blocked = await postCommand(persistentWrite({ id: blockedId, runId: 'run_222_2_new' }));
      expect(blocked.status).toBe(409);
      expect(blocked.result.errorCode).toBe('session_recovering');
      expect(ext.dispatchCountFor(blockedId)).toBe(0);

      ext.send({ id: resetId!, ok: true, data: { closed: true } });
      const recovered = await recovery;
      expect(recovered.status).toBe(200);
      expect(recovered.result).toMatchObject({
        ok: true,
        result: 'RECOVERED',
        tabReset: true,
        cancelledPending: 1,
      });
      expect((await followerRecovery).result).toMatchObject({ ok: true, result: 'RECOVERED' });

      const oldResult = await old;
      expect(oldResult.status).toBe(503);
      expect(oldResult.result.errorCode).toBe('command_result_unknown');

      // It is too late for the old command to affect daemon state.
      ext.send({ id: oldId, ok: true, data: 'late old result' });
      const newId = cmdId();
      const next = await postCommand(persistentWrite({ id: newId, runId: 'run_222_2_new' }));
      expect(next.status).toBe(200);
      expect(next.result.ok).toBe(true);
      expect(ext.dispatchCountFor(newId)).toBe(1);
    } finally {
      ext.close();
    }
  });

  it('CAS-reclaims an idle lease without resetting the tab and permanently fences its old runId', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    await ext.connect('ctx-reclaim');
    try {
      const oldId = cmdId();
      const oldRunId = 'run_666_6_old';
      expect((await postCommand(persistentWrite({ id: oldId, runId: oldRunId }))).result.ok).toBe(true);

      const wrongOwner = await postRecovery({
        contextId: 'ctx-reclaim',
        surface: 'adapter',
        session: 'site:chatgpt-agent',
        expectedRunId: 'run_999_9_wrong',
        mode: 'RECLAIM_IF_IDLE',
        reason: 'owner_dead_no_pending',
      });
      expect(wrongOwner.result).toMatchObject({ ok: true, result: 'OWNER_CHANGED', tabReset: false });

      const reclaimed = await postRecovery({
        contextId: 'ctx-reclaim',
        surface: 'adapter',
        session: 'site:chatgpt-agent',
        expectedRunId: oldRunId,
        mode: 'RECLAIM_IF_IDLE',
        reason: 'owner_dead_no_pending',
      });
      expect(reclaimed.result).toMatchObject({ ok: true, result: 'RECOVERED', tabReset: false, cancelledPending: 0 });
      expect(ext.received.filter((cmd) => cmd.action === 'close-window')).toHaveLength(0);

      const oldRetry = await postCommand(persistentWrite({ id: cmdId(), runId: oldRunId }));
      expect(oldRetry.result.errorCode).toBe('session_lease_revoked');
      expect((await postCommand(persistentWrite({ id: cmdId(), runId: 'run_777_7_new' }))).result.ok).toBe(true);
    } finally {
      ext.close();
    }
  });

  it('keeps a fenced lease RECOVERING when the Browser Bridge cannot confirm reset', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    const oldId = cmdId();
    ext.onCommand = (cmd) => {
      if (cmd.action === 'close-window') return { id: String(cmd.id), ok: false, error: 'reset rejected' };
      if (cmd.id === oldId) return null;
      return { id: String(cmd.id), ok: true, data: 'unexpected' };
    };
    await ext.connect('ctx-reset-failure');
    try {
      const old = postCommand(persistentWrite({ id: oldId, runId: 'run_333_3_old' }));
      await waitFor(() => ext.dispatchCountFor(oldId) === 1, 5_000, 'old writer was not dispatched');

      const recovery = await postRecovery({
        contextId: 'ctx-reset-failure',
        surface: 'adapter',
        session: 'site:chatgpt-agent',
        expectedRunId: 'run_333_3_old',
        mode: 'CANCEL_AND_RESET',
        reason: 'execution_timeout',
      });
      expect(recovery.status).toBe(503);
      expect(recovery.result).toMatchObject({ ok: false, result: 'RESET_FAILED', errorCode: 'session_recovery_failed' });
      expect((await old).result.errorCode).toBe('command_result_unknown');

      const status = await getStatus();
      expect(status?.sessionLeases).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: 'run_333_3_old', state: 'RECOVERING', pendingCount: 0 }),
      ]));
      const challenger = await postCommand(persistentWrite({ id: cmdId(), runId: 'run_444_4_new' }));
      expect(challenger.result.errorCode).toBe('session_recovering');
    } finally {
      ext.close();
    }
  });

  it('starts fenced orphan recovery after the holder process is SIGKILLed', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const oldId = cmdId();
    let resetId: string | null = null;
    ext.onCommand = (cmd) => {
      if (cmd.action === 'close-window') {
        resetId = String(cmd.id);
        return null;
      }
      if (cmd.id === oldId) return null;
      return { id: String(cmd.id), ok: true, data: 'ok' };
    };
    await ext.connect('ctx-orphan');
    try {
      const old = postCommand(persistentWrite({ id: oldId, runId: `run_${child.pid}_old` }));
      await waitFor(() => ext.dispatchCountFor(oldId) === 1, 5_000, 'old writer was not dispatched');
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));

      const challenger = await postCommand(persistentWrite({ id: cmdId(), runId: 'run_555_5_new' }));
      expect(challenger.result.errorCode).toBe('session_recovering');
      await waitFor(() => resetId !== null, 5_000, 'orphan recovery did not dispatch reset');
      ext.send({ id: resetId!, ok: true, data: { closed: true } });
      expect((await old).result.errorCode).toBe('command_result_unknown');

      const retry = await postCommand(persistentWrite({ id: cmdId(), runId: 'run_555_5_new' }));
      expect(retry.result.ok).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      ext.close();
    }
  });

  // Windows cannot deliver a catchable POSIX SIGTERM to a child process.
  it.skipIf(process.platform === 'win32')('performs bounded SIGTERM recovery before restoring normal signal termination', async () => {
    if (guard()) return;
    const helperUrl = pathToFileURL(path.join(ROOT, 'dist', 'src', 'browser', 'session-recovery.js')).href;
    const script = `
      import { installBoundedSignalRecovery } from ${JSON.stringify(helperUrl)};
      let finish;
      const gate = new Promise((resolve) => { finish = resolve; });
      process.on('message', (message) => { if (message?.type === 'complete') finish(); });
      installBoundedSignalRecovery({
        recover: async () => { process.send?.({ type: 'recover' }); await gate; },
        terminate: (signal) => process.kill(process.pid, signal),
        graceMs: 2_500,
      });
      process.send?.({ type: 'ready' });
      setInterval(() => {}, 1_000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const messages: Array<{ type?: string }> = [];
    child.on('message', (message) => { messages.push(message as { type?: string }); });
    try {
      await waitFor(() => messages.some((message) => message.type === 'ready'), 5_000, 'signal child did not start');
      child.kill('SIGTERM');
      await waitFor(() => messages.some((message) => message.type === 'recover'), 5_000, 'SIGTERM did not start recovery');
      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      child.send?.({ type: 'complete' });
      const exited = await exitPromise;
      expect(exited.code).toBeNull();
      expect(exited.signal).toBe('SIGTERM');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('resolves /status multi-profile ambiguity through preferredContextId', async () => {
    if (guard()) return;
    const first = new FakeExtension();
    const second = new FakeExtension();
    await first.connect('ctx-status-a');
    await second.connect('ctx-status-b');
    try {
      // Two live profiles and no hint → ambiguous, the caller must pick.
      const ambiguous = await getStatus();
      expect(ambiguous?.profileRequired).toBe(true);
      expect(ambiguous?.extensionConnected).toBe(false);

      // The forwarded preference resolves the ambiguity (#2259).
      const preferred = await getStatus('?preferredContextId=ctx-status-b');
      expect(preferred?.profileRequired).toBe(false);
      expect(preferred?.contextId).toBe('ctx-status-b');
      expect(preferred?.extensionConnected).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });

  it('flushes a structured daemon_shutting_down 503 to in-flight dispatched commands on shutdown', async () => {
    if (guard()) return;
    const ext = new FakeExtension();
    ext.onCommand = () => null;
    await ext.connect('ctx-shutdown');
    const id = cmdId();
    const inflight = postCommand({ id, action: 'navigate', url: 'https://example.com', session: 's', surface: 'browser' });
    await waitFor(() => ext.dispatchCountFor(id) === 1, 5_000, 'command was not dispatched');

    await fetch(`${BASE}/shutdown`, { method: 'POST', headers: HEADERS, signal: AbortSignal.timeout(2_000) });

    // The contract under test: a structured JSON response, not a socket hang-up.
    const { status, result } = await inflight;
    expect(status).toBe(503);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('daemon_shutting_down');

    await new Promise<void>((resolve) => {
      if (!daemon || daemon.exitCode !== null) return resolve();
      daemon.once('exit', () => resolve());
      setTimeout(resolve, 3_000);
    });
    expect(daemon?.exitCode).toBe(0);
    daemon = null; // afterAll: nothing left to stop
    ext.close();
  });
});
