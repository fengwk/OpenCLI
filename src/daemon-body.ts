/**
 * Pure HTTP body reader for the daemon — extracted from daemon.ts so it can
 * be unit-tested without starting the full HTTP server (which has global
 * side effects: socket bind, WS server, process exit handlers).
 *
 * Contract:
 *  - Drain the body up to REQUEST_BODY_LIMIT_BYTES; anything past the cap is
 *    consumed (so the socket does not stall) but discarded.
 *  - Never calls `req.destroy()` — the keep-alive socket stays usable so a
 *    well-behaved client can retry with a smaller payload on the same connection.
 *  - On `data` past the cap: switch to `too-large`, drop the buffered bytes,
 *    keep draining.
 *  - On `end`: return `ok` with the accumulated body, or `too-large` if the
 *    cap was crossed.
 *  - On `error`: return `read-error` verbatim — transport failures must NOT
 *    masquerade as 413.
 */
import type { IncomingMessage } from 'node:http';

import {
  REQUEST_BODY_LIMIT_BYTES,
  buildRequestBodyTooLargeFailure,
  classifyRequestBodySize,
  type RequestBodyTooLargeFailure,
} from './daemon-utils.js';

export type ReadBodyOutcome =
  | { kind: 'ok'; body: string; receivedBytes: number }
  | { kind: 'too-large'; failure: RequestBodyTooLargeFailure }
  | { kind: 'read-error'; error: Error };

export function readBody(req: IncomingMessage, limit: number = REQUEST_BODY_LIMIT_BYTES): Promise<ReadBodyOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overLimit = false;
    let settled = false;

    const finalize = (outcome: ReadBodyOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (overLimit) return; // drain only
      if (classifyRequestBodySize(size, limit).kind === 'too-large') {
        overLimit = true;
        chunks.length = 0; // drop — truncated, never a complete body
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (overLimit) {
        finalize({ kind: 'too-large', failure: buildRequestBodyTooLargeFailure(size, limit) });
        return;
      }
      finalize({ kind: 'ok', body: Buffer.concat(chunks).toString('utf-8'), receivedBytes: size });
    });

    req.on('error', (err) => {
      finalize({ kind: 'read-error', error: err instanceof Error ? err : new Error(String(err)) });
    });
  });
}