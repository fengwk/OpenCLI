export type RecoverySignal = 'SIGINT' | 'SIGTERM';

type SignalProcess = {
  on(signal: RecoverySignal, listener: (signal: RecoverySignal) => void): unknown;
  removeListener(signal: RecoverySignal, listener: (signal: RecoverySignal) => void): unknown;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Give a persistent-write owner a short chance to fence/reset its session on
 * SIGINT/SIGTERM. The second signal immediately restores normal signal exit.
 */
export function installBoundedSignalRecovery(input: {
  recover: () => Promise<unknown>;
  terminate: (signal: RecoverySignal) => void;
  processRef?: SignalProcess;
  graceMs?: number;
}): () => void {
  const processRef = input.processRef ?? process;
  const graceMs = input.graceMs ?? 2_500;
  let handling = false;
  let removed = false;
  let terminated = false;

  const remove = () => {
    if (removed) return;
    removed = true;
    processRef.removeListener('SIGINT', onSignal);
    processRef.removeListener('SIGTERM', onSignal);
  };

  const onSignal = (signal: RecoverySignal) => {
    if (handling) {
      remove();
      if (!terminated) {
        terminated = true;
        input.terminate(signal);
      }
      return;
    }
    handling = true;
    void Promise.race([
      input.recover().catch(() => undefined),
      wait(graceMs),
    ]).finally(() => {
      remove();
      if (!terminated) {
        terminated = true;
        input.terminate(signal);
      }
    });
  };

  processRef.on('SIGINT', onSignal);
  processRef.on('SIGTERM', onSignal);
  return remove;
}
