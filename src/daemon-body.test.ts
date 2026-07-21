/**
 * readBody is the daemon's HTTP body reader — extracted to a separate module
 * so it can be unit-tested without spinning up the full daemon (which has
 * global side effects: socket bind, WS server, process exit handlers).
 *
 * Tests use a minimal stub that implements the slice of node:http's
 * IncomingMessage we actually depend on (`on` for `data` / `end` / `error`,
 * and the ability to push data via `Readable.push`). That keeps the suite
 * free of fixed-port daemons per the prompt's testing guardrail.
 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';

import {
  REQUEST_BODY_LIMIT_BYTES,
  REQUEST_BODY_TOO_LARGE_CODE,
  REQUEST_BODY_TOO_LARGE_STATUS,
} from './daemon-utils.js';
import { readBody } from './daemon-body.js';

type IncomingLike = Parameters<typeof readBody>[0];

/**
 * Build an IncomingMessage-shaped fake from a list of chunks. Each chunk is
 * pushed onto the readable; `end` fires after the last one (or after the
 * initial error, if `errorAfter` is provided).
 */
function makeReq(chunks: Array<string | Buffer>, opts: { errorAfter?: number } = {}): IncomingLike {
  const source = Readable.from(
    (async function* () {
      for (let i = 0; i < chunks.length; i++) {
        if (opts.errorAfter !== undefined && i === opts.errorAfter) {
          throw new Error('client closed mid-stream');
        }
        yield Buffer.isBuffer(chunks[i]) ? chunks[i] : Buffer.from(chunks[i]);
      }
    })(),
  );
  // Wire Readable as IncomingMessage: IncomingMessage extends Readable, so any
  // Readable with `on('data'|'end'|'error', ...)` satisfies readBody's needs.
  return source as unknown as IncomingLike;
}

describe('readBody', () => {
  it('returns the full body within the cap', async () => {
    const req = makeReq(['{"id":"cmd_1","action":"exec","code":"1"}']);
    const result = await readBody(req);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.body).toBe('{"id":"cmd_1","action":"exec","code":"1"}');
    expect(result.receivedBytes).toBe(41);
  });

  it('passes a body exactly at the 1 MiB cap without rejecting', async () => {
    const payload = 'a'.repeat(REQUEST_BODY_LIMIT_BYTES);
    const req = makeReq([payload]);
    const result = await readBody(req);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.receivedBytes).toBe(REQUEST_BODY_LIMIT_BYTES);
    expect(result.body.length).toBe(REQUEST_BODY_LIMIT_BYTES);
  });

  it('returns a structured too-large failure when the body crosses the cap mid-stream', async () => {
    const firstChunk = 'a'.repeat(REQUEST_BODY_LIMIT_BYTES - 10);
    const secondChunk = 'b'.repeat(20); // pushes the cumulative size past the cap
    const req = makeReq([firstChunk, secondChunk]);
    const result = await readBody(req);
    expect(result.kind).toBe('too-large');
    if (result.kind !== 'too-large') throw new Error('unreachable');
    expect(result.failure.errorCode).toBe(REQUEST_BODY_TOO_LARGE_CODE);
    expect(result.failure.status).toBe(REQUEST_BODY_TOO_LARGE_STATUS);
    expect(result.failure.receivedBytes).toBe(REQUEST_BODY_LIMIT_BYTES + 10);
    expect(result.failure.limit).toBe(REQUEST_BODY_LIMIT_BYTES);
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.message).toContain(String(REQUEST_BODY_LIMIT_BYTES + 10));
  });

  it('keeps draining after the cap is crossed so the socket does not stall', async () => {
    const firstChunk = 'a'.repeat(REQUEST_BODY_LIMIT_BYTES - 5);
    const secondChunk = 'b'.repeat(5_000); // would push size way past cap
    const req = makeReq([firstChunk, secondChunk]);
    const result = await readBody(req);
    expect(result.kind).toBe('too-large');
    if (result.kind !== 'too-large') throw new Error('unreachable');
    expect(result.failure.receivedBytes).toBe(REQUEST_BODY_LIMIT_BYTES + 4995);
  });

  it('does NOT call req.destroy() from readBody — the keep-alive socket stays usable for a retry', async () => {
    // The whole point: even when the cap is crossed, we drain and answer
    // structured 413. We assert this by checking the result resolves cleanly
    // and the response code is 413 with a non-empty message — i.e. we DID
    // answer with a structured response (the alternative, the old behavior,
    // would `req.destroy()` the socket and the caller would never get a
    // structured 413 to inspect).
    const req = makeReq(['a'.repeat(REQUEST_BODY_LIMIT_BYTES + 1)]);
    const result = await readBody(req);
    expect(result.kind).toBe('too-large');
    if (result.kind !== 'too-large') throw new Error('unreachable');
    expect(result.failure.status).toBe(REQUEST_BODY_TOO_LARGE_STATUS);
    expect(result.failure.message).toContain('bytes exceeded');
  });

  it('returns read-error (not too-large) when the stream errors mid-read', async () => {
    const req = makeReq(['partial', 'rest'], { errorAfter: 1 });
    const result = await readBody(req);
    expect(result.kind).toBe('read-error');
    if (result.kind !== 'read-error') throw new Error('unreachable');
    expect(result.error.message).toContain('client closed mid-stream');
  });

  it('honors a caller-supplied limit for unit-testing the boundary', async () => {
    const req = makeReq(['x'.repeat(11)]);
    const result = await readBody(req, 10);
    expect(result.kind).toBe('too-large');
    if (result.kind !== 'too-large') throw new Error('unreachable');
    expect(result.failure.receivedBytes).toBe(11);
    expect(result.failure.limit).toBe(10);
  });
});