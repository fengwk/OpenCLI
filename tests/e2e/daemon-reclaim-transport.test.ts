/**
 * Isolated daemon transport contract for `reclaim-adapter-tabs`.
 *
 * The production daemon binds a FIXED port (19825). To exercise the real HTTP +
 * WebSocket wiring without ever touching the developer's live daemon, this
 * suite:
 *
 *   1. picks an OS-assigned ephemeral port;
 *   2. copies the built `dist/src` tree to a throwaway temp dir and rewrites the
 *      copied `constants.js` port constant to that ephemeral port;
 *   3. symlinks the repo `node_modules` so the copied ESM daemon resolves `ws`;
 *   4. spawns the copied daemon as an independent process.
 *
 * Only the ephemeral port is ever contacted. The real 19825 daemon is never
 * started, shut down, or queried. Requires a prebuilt `dist` (the same
 * prerequisite as the other real-daemon e2e suites).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST_SRC = path.join(ROOT, 'dist', 'src');
const HEADERS = { 'X-OpenCLI': '1', 'Content-Type': 'application/json' };

type WireResult = {
  id?: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  errorHint?: string;
};

async function getEphemeralPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no ephemeral port'));
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** Copy the built daemon and re-point its fixed port constant at `port`. */
async function materializeDaemon(port: number): Promise<{ entry: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'opencli-reclaim-daemon-'));
  await cp(DIST_SRC, path.join(dir, 'src'), { recursive: true });
  // The copied ESM daemon must resolve bare specifiers (`ws`) from the repo.
  await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const constantsPath = path.join(dir, 'src', 'constants.js');
  const constants = await readFile(constantsPath, 'utf8');
  const rewritten = constants.replace(
    /DEFAULT_DAEMON_PORT\s*=\s*\d+/,
    `DEFAULT_DAEMON_PORT = ${port}`,
  );
  if (rewritten === constants) {
    throw new Error('could not rewrite DEFAULT_DAEMON_PORT in the copied constants.js');
  }
  await writeFile(constantsPath, rewritten);
  return { entry: path.join(dir, 'src', 'daemon.js'), dir };
}

/** Scripted stand-in for the Browser Bridge extension. */
class FakeExtension {
  private ws: WebSocket | null = null;
  readonly received: Array<Record<string, unknown>> = [];
  onCommand: (cmd: Record<string, unknown>) => WireResult | null = (cmd) => ({
    id: String(cmd.id),
    ok: true,
    data: { echo: cmd.action },
  });

  constructor(private readonly port: number) {}

  async connect(contextId: string, opts: { capabilities?: string[] } = {}): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ext`, {
      headers: { origin: 'chrome-extension://e2e-reclaim' },
    });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          contextId,
          version: '1.0.36',
          compatRange: '>=1.0.0',
          ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
        }));
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
    await waitFor(async () => {
      const status = await getStatus();
      return (status?.profiles ?? []).some((p: any) => p.contextId === contextId);
    }, 5_000, `daemon did not register fake extension ${contextId}`);
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
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

let PORT = 0;
let BASE = '';
let daemon: ChildProcess | null = null;
let tempDir = '';

async function getStatus(): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}/status`, { headers: HEADERS, signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function postCommand(body: Record<string, unknown>, timeoutMs = 10_000): Promise<{ status: number; result: WireResult }> {
  const res = await fetch(`${BASE}/command`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, result: (await res.json()) as WireResult };
}

async function postRecovery(body: Record<string, unknown>, timeoutMs = 10_000): Promise<{ status: number; result: WireResult }> {
  const res = await fetch(`${BASE}/session-leases/recover`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, result: (await res.json()) as WireResult };
}

let nextId = 0;
function id(prefix: string): string {
  return `reclaim-e2e-${prefix}-${process.pid}-${++nextId}`;
}

function reclaimBody(contextId: string, commandId: string, deadlineAt: number): Record<string, unknown> {
  return { id: commandId, action: 'reclaim-adapter-tabs', contextId, surface: 'adapter', deadlineAt };
}

describe('reclaim-adapter-tabs transport (isolated daemon)', () => {
  beforeAll(async () => {
    PORT = await getEphemeralPort();
    BASE = `http://127.0.0.1:${PORT}`;
    const materialized = await materializeDaemon(PORT);
    tempDir = materialized.dir;
    const env = { ...process.env };
    delete env.OPENCLI_DAEMON_PORT;
    daemon = spawn(process.execPath, [materialized.entry], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    daemon.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    try {
      await waitFor(async () => (await getStatus()) !== null, 15_000, 'isolated daemon did not start');
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}\ndaemon stderr:\n${stderr.slice(-2_000)}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (daemon) {
      try {
        await fetch(`${BASE}/shutdown`, { method: 'POST', headers: HEADERS, signal: AbortSignal.timeout(2_000) });
      } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        if (!daemon || daemon.exitCode !== null) return resolve();
        daemon.once('exit', () => resolve());
        setTimeout(() => { daemon?.kill('SIGKILL'); resolve(); }, 3_000);
      });
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('advertises the reclaim capability globally and per profile from the hello', async () => {
    const ext = new FakeExtension(PORT);
    const noCaps = new FakeExtension(PORT);
    await ext.connect('ctx-caps', { capabilities: ['adapter-tab-reclaim-v1'] });
    await noCaps.connect('ctx-nocaps');
    try {
      const status = await getStatus();
      expect(status?.capabilities).toContain('adapter-tab-reclaim-v1');
      const withCaps = status?.profiles?.find((p: any) => p.contextId === 'ctx-caps');
      const withoutCaps = status?.profiles?.find((p: any) => p.contextId === 'ctx-nocaps');
      expect(withCaps?.capabilities).toEqual(['adapter-tab-reclaim-v1']);
      expect(withoutCaps?.capabilities).toEqual([]);
    } finally {
      ext.close();
      noCaps.close();
    }
  });

  it('dispatches a sessionless reclaim with a caller deadline clamped to 5s and returns the extension data', async () => {
    const ext = new FakeExtension(PORT);
    ext.onCommand = (cmd) => ({ id: String(cmd.id), ok: true, data: { closedTabs: 2, resetTabs: 1 } });
    await ext.connect('ctx-happy', { capabilities: ['adapter-tab-reclaim-v1'] });
    try {
      const commandId = id('happy');
      const before = Date.now();
      const { status, result } = await postCommand(reclaimBody('ctx-happy', commandId, Date.now() + 60_000));
      expect(status).toBe(200);
      expect(result).toMatchObject({ id: commandId, ok: true, data: { closedTabs: 2, resetTabs: 1 } });
      expect(ext.dispatchCountFor(commandId)).toBe(1);
      const sent = ext.received.find((cmd) => cmd.id === commandId)!;
      expect(sent.action).toBe('reclaim-adapter-tabs');
      expect(sent.contextId).toBe('ctx-happy');
      expect(sent.surface).toBe('adapter');
      expect('session' in sent).toBe(false);
      const deadlineAt = sent.deadlineAt as number;
      expect(Number.isInteger(deadlineAt)).toBe(true);
      expect(deadlineAt).toBeGreaterThanOrEqual(before);
      expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 5_000);
    } finally {
      ext.close();
    }
  });

  it('rejects a profile that does not advertise the capability without dispatching', async () => {
    const ext = new FakeExtension(PORT);
    await ext.connect('ctx-unsupported');
    try {
      const commandId = id('unsupported');
      const { status, result } = await postCommand(reclaimBody('ctx-unsupported', commandId, Date.now() + 5_000));
      expect(status).toBe(409);
      expect(result).toMatchObject({ ok: false, errorCode: 'adapter_tab_reclaim_unsupported' });
      expect(ext.dispatchCountFor(commandId)).toBe(0);
    } finally {
      ext.close();
    }
  });

  it('rejects an expired deadline and malformed requests without dispatching', async () => {
    const ext = new FakeExtension(PORT);
    await ext.connect('ctx-invalid', { capabilities: ['adapter-tab-reclaim-v1'] });
    try {
      const expiredId = id('expired');
      const expired = await postCommand(reclaimBody('ctx-invalid', expiredId, Date.now() - 1));
      expect(expired.status).toBe(408);
      expect(expired.result.errorCode).toBe('reclaim_deadline_exceeded');
      expect(ext.dispatchCountFor(expiredId)).toBe(0);

      const shapeId = id('shape');
      const noContext = await postCommand({ id: shapeId, action: 'reclaim-adapter-tabs', surface: 'adapter', deadlineAt: Date.now() + 5_000 });
      expect(noContext.status).toBe(400);
      expect(noContext.result.errorCode).toBe('invalid_reclaim_request');

      const noDeadline = await postCommand({ id: shapeId, action: 'reclaim-adapter-tabs', contextId: 'ctx-invalid', surface: 'adapter' });
      expect(noDeadline.status).toBe(400);
      expect(noDeadline.result.errorCode).toBe('reclaim_failed');
      expect(ext.received).toHaveLength(0);
    } finally {
      ext.close();
    }
  });

  it('rejects a reclaim while a same-context command is pending, then admits it after the command settles', async () => {
    const ext = new FakeExtension(PORT);
    const heldId = id('held');
    ext.onCommand = (cmd) => (cmd.id === heldId ? null : { id: String(cmd.id), ok: true, data: {} });
    await ext.connect('ctx-pending', { capabilities: ['adapter-tab-reclaim-v1'] });
    try {
      const held = postCommand({ id: heldId, action: 'exec', code: '1', session: 's', surface: 'browser', contextId: 'ctx-pending' });
      await waitFor(() => ext.dispatchCountFor(heldId) === 1, 5_000, 'held command not dispatched');

      const busyId = id('busy');
      const busy = await postCommand(reclaimBody('ctx-pending', busyId, Date.now() + 5_000));
      expect(busy.status).toBe(409);
      expect(busy.result.errorCode).toBe('adapter_tabs_busy');
      expect(ext.dispatchCountFor(busyId)).toBe(0);

      ext.send({ id: heldId, ok: true, data: { released: true } });
      await held;

      const retryId = id('retry');
      const retry = await postCommand(reclaimBody('ctx-pending', retryId, Date.now() + 5_000));
      expect(retry.status).toBe(200);
      expect(retry.result.ok).toBe(true);
      expect(ext.dispatchCountFor(retryId)).toBe(1);
    } finally {
      ext.close();
    }
  });

  it('rejects a reclaim while a same-context logical write lease is held', async () => {
    const ext = new FakeExtension(PORT);
    const writeId = id('write');
    ext.onCommand = (cmd) => (cmd.id === writeId ? null : { id: String(cmd.id), ok: true, data: {} });
    await ext.connect('ctx-lease', { capabilities: ['adapter-tab-reclaim-v1'] });
    try {
      const write = postCommand({
        id: writeId,
        action: 'exec',
        code: 'window.__x = 1',
        session: 'site:lease',
        surface: 'adapter',
        siteSession: 'persistent',
        access: 'write',
        runId: 'run_999999_1_lease',
        command: 'lease-e2e',
        contextId: 'ctx-lease',
      });
      await waitFor(() => ext.dispatchCountFor(writeId) === 1, 5_000, 'held write not dispatched');
      ext.send({ id: writeId, ok: true, data: {} });
      await write;

      const commandId = id('lease-busy');
      const busy = await postCommand(reclaimBody('ctx-lease', commandId, Date.now() + 5_000));
      expect(busy.status).toBe(409);
      expect(busy.result.errorCode).toBe('adapter_tabs_busy');
      expect(ext.dispatchCountFor(commandId)).toBe(0);
    } finally {
      ext.close();
    }
  });

  it('attaches the same-id retry to the in-flight reclaim without re-dispatching', async () => {
    const ext = new FakeExtension(PORT);
    let releaseResult: (() => void) | null = null;
    const released = new Promise<void>((resolve) => { releaseResult = resolve; });
    ext.onCommand = (cmd) => {
      if (cmd.action === 'reclaim-adapter-tabs') {
        void released.then(() => ext.send({ id: String(cmd.id), ok: true, data: { closedTabs: 1, resetTabs: 0 } }));
        return null;
      }
      return { id: String(cmd.id), ok: true, data: {} };
    };
    await ext.connect('ctx-retry', { capabilities: ['adapter-tab-reclaim-v1'] });
    try {
      const commandId = id('attach');
      const first = postCommand(reclaimBody('ctx-retry', commandId, Date.now() + 5_000));
      await waitFor(() => ext.dispatchCountFor(commandId) === 1, 5_000, 'reclaim not dispatched');
      const second = postCommand(reclaimBody('ctx-retry', commandId, Date.now() + 5_000));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(ext.dispatchCountFor(commandId)).toBe(1);
      releaseResult!();
      const [a, b] = await Promise.all([first, second]);
      expect(a.result).toMatchObject({ ok: true, data: { closedTabs: 1, resetTabs: 0 } });
      expect(b.result).toMatchObject({ ok: true, data: { closedTabs: 1, resetTabs: 0 } });
      expect(ext.dispatchCountFor(commandId)).toBe(1);
    } finally {
      ext.close();
    }
  });

  it('rejects a same-id collision that targets a different context', async () => {
    const extA = new FakeExtension(PORT);
    const extB = new FakeExtension(PORT);
    extA.onCommand = (cmd) => (cmd.action === 'reclaim-adapter-tabs' ? null : { id: String(cmd.id), ok: true, data: {} });
    await extA.connect('ctx-collide-a', { capabilities: ['adapter-tab-reclaim-v1'] });
    await extB.connect('ctx-collide-b', { capabilities: ['adapter-tab-reclaim-v1'] });
    try {
      const commandId = id('collide');
      const first = postCommand(reclaimBody('ctx-collide-a', commandId, Date.now() + 5_000));
      await waitFor(() => extA.dispatchCountFor(commandId) === 1, 5_000, 'reclaim not dispatched');
      const collision = await postCommand(reclaimBody('ctx-collide-b', commandId, Date.now() + 5_000));
      expect(collision.status).toBe(409);
      expect(collision.result.errorCode).toBe('command_id_conflict');
      expect(extB.dispatchCountFor(commandId)).toBe(0);
      extA.send({ id: commandId, ok: true, data: { closedTabs: 0, resetTabs: 0 } });
      await first;
    } finally {
      extA.close();
      extB.close();
    }
  });

  it('refuses same-context browser commands (and recovery) while a reclaim is in flight, leaving other contexts free', async () => {
    const ext = new FakeExtension(PORT);
    const other = new FakeExtension(PORT);
    const reclaimId = id('guard');
    ext.onCommand = (cmd) => (cmd.action === 'reclaim-adapter-tabs' ? null : { id: String(cmd.id), ok: true, data: {} });
    await ext.connect('ctx-guard', { capabilities: ['adapter-tab-reclaim-v1'] });
    await other.connect('ctx-other', { capabilities: ['adapter-tab-reclaim-v1'] });
    try {
      const held = postCommand(reclaimBody('ctx-guard', reclaimId, Date.now() + 5_000));
      await waitFor(() => ext.dispatchCountFor(reclaimId) === 1, 5_000, 'reclaim not dispatched');

      const blockedId = id('blocked');
      const blocked = await postCommand({ id: blockedId, action: 'exec', code: '1', session: 's', surface: 'browser', contextId: 'ctx-guard' });
      expect(blocked.status).toBe(409);
      expect(blocked.result.errorCode).toBe('adapter_tabs_busy');
      expect(ext.dispatchCountFor(blockedId)).toBe(0);

      // Daemon-local lease cleanup is never gated by the maintenance guard.
      const release = await postCommand({ id: id('release'), action: 'lease-release', runId: 'run_999999_1_lease' });
      expect(release.status).toBe(200);
      expect(release.result.ok).toBe(true);

      // A different context is unaffected.
      const otherId = id('other');
      const allowed = await postCommand({ id: otherId, action: 'exec', code: '1', session: 's', surface: 'browser', contextId: 'ctx-other' });
      expect(allowed.status).toBe(200);
      expect(allowed.result.ok).toBe(true);
      expect(other.dispatchCountFor(otherId)).toBe(1);

      // Session recovery must not start its destructive close-window under a reclaim.
      const recovery = await postRecovery({
        contextId: 'ctx-guard',
        surface: 'adapter',
        session: 'site:guard',
        expectedRunId: 'run_999999_1_lease',
        mode: 'CANCEL_AND_RESET',
      });
      expect(recovery.status).toBe(503);
      expect(recovery.result.errorCode).toBe('adapter_tabs_busy');
      expect(ext.received.filter((cmd) => cmd.action === 'close-window')).toHaveLength(0);

      ext.send({ id: reclaimId, ok: true, data: { closedTabs: 0, resetTabs: 1 } });
      const finished = await held;
      expect(finished.status).toBe(200);

      // Once settled, the same context accepts commands again.
      const afterId = id('after');
      const after = await postCommand({ id: afterId, action: 'exec', code: '1', session: 's', surface: 'browser', contextId: 'ctx-guard' });
      expect(after.status).toBe(200);
      expect(ext.dispatchCountFor(afterId)).toBe(1);
    } finally {
      ext.close();
      other.close();
    }
  });

  it('times a silent extension out with reclaim_deadline_exceeded and releases the guard', async () => {
    const ext = new FakeExtension(PORT);
    ext.onCommand = (cmd) => (cmd.action === 'reclaim-adapter-tabs' ? null : { id: String(cmd.id), ok: true, data: {} });
    await ext.connect('ctx-timeout', { capabilities: ['adapter-tab-reclaim-v1'] });
    try {
      const commandId = id('timeout');
      const started = Date.now();
      const timedOut = await postCommand(reclaimBody('ctx-timeout', commandId, started + 1_200), 8_000);
      expect(timedOut.status).toBe(408);
      expect(timedOut.result.errorCode).toBe('reclaim_deadline_exceeded');
      expect(Date.now() - started).toBeLessThan(5_000);

      const afterId = id('after-timeout');
      const after = await postCommand({ id: afterId, action: 'exec', code: '1', session: 's', surface: 'browser', contextId: 'ctx-timeout' });
      expect(after.status).toBe(200);
      expect(ext.dispatchCountFor(afterId)).toBe(1);
    } finally {
      ext.close();
    }
  });
});
