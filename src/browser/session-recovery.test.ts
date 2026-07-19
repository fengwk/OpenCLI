import { describe, expect, it, vi } from 'vitest';

import { installBoundedSignalRecovery, type RecoverySignal } from './session-recovery.js';

class FakeSignalProcess {
  private readonly listeners = new Map<RecoverySignal, Set<(signal: RecoverySignal) => void>>();

  on(signal: RecoverySignal, listener: (signal: RecoverySignal) => void): void {
    const set = this.listeners.get(signal) ?? new Set();
    set.add(listener);
    this.listeners.set(signal, set);
  }

  removeListener(signal: RecoverySignal, listener: (signal: RecoverySignal) => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: RecoverySignal): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener(signal);
  }
}

describe('installBoundedSignalRecovery', () => {
  it('waits for bounded recovery before restoring normal signal termination', async () => {
    const processRef = new FakeSignalProcess();
    let complete!: () => void;
    const recovery = new Promise<void>((resolve) => { complete = resolve; });
    const recover = vi.fn(() => recovery);
    const terminate = vi.fn();
    installBoundedSignalRecovery({ recover, terminate, processRef, graceMs: 1_000 });

    processRef.emit('SIGTERM');
    expect(recover).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();

    complete();
    await new Promise((resolve) => setImmediate(resolve));
    expect(terminate).toHaveBeenCalledWith('SIGTERM');
  });

  it('terminates immediately on a second signal without launching another recovery', async () => {
    const processRef = new FakeSignalProcess();
    const recover = vi.fn(() => new Promise<void>(() => {}));
    const terminate = vi.fn();
    installBoundedSignalRecovery({ recover, terminate, processRef, graceMs: 60_000 });

    processRef.emit('SIGINT');
    processRef.emit('SIGTERM');
    await Promise.resolve();

    expect(recover).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith('SIGTERM');
  });

  it('removes listeners when the command completes normally', () => {
    const processRef = new FakeSignalProcess();
    const recover = vi.fn().mockResolvedValue(undefined);
    const terminate = vi.fn();
    const cleanup = installBoundedSignalRecovery({ recover, terminate, processRef });

    cleanup();
    processRef.emit('SIGINT');
    expect(recover).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });
});
