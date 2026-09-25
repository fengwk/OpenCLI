import { beforeEach, describe, expect, it, vi } from 'vitest';

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1;
    static lastInstance: MockWebSocket | undefined;
    readyState = 1;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(_url: string) {
      MockWebSocket.lastInstance = this;
      queueMicrotask(() => this.emit('open'));
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    send(_message: string): void {}

    close(): void {
      this.readyState = 3;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return { MockWebSocket };
});

vi.mock('ws', () => ({
  WebSocket: MockWebSocket,
}));

import { CDPBridge, CDP_REQUEST_BODY_CAPTURE_LIMIT, CDP_SSE_CAPTURE_BYTE_BUDGET, CDP_SSE_CHUNK_BUFFER_LIMIT, CDP_SSE_CHUNK_PAYLOAD_LIMIT } from './cdp.js';
import type { SseCaptureChunk } from '../types.js';

describe('CDPBridge cookies', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('filters cookies by actual domain match instead of substring match', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockResolvedValue({
      cookies: [
        { name: 'good', value: '1', domain: '.example.com' },
        { name: 'exact', value: '2', domain: 'example.com' },
        { name: 'bad', value: '3', domain: 'notexample.com' },
      ],
    });

    const page = await bridge.connect();
    const cookies = await page.getCookies({ domain: 'example.com' });

    expect(cookies).toEqual([
      { name: 'good', value: '1', domain: '.example.com' },
      { name: 'exact', value: '2', domain: 'example.com' },
    ]);
  });

  it('exposes native input helpers on direct CDP pages', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    const send = vi.spyOn(bridge, 'send').mockResolvedValue({});

    const page = await bridge.connect();
    send.mockClear();

    expect(page.nativeType).toBeTypeOf('function');
    expect(page.nativeKeyPress).toBeTypeOf('function');
    expect(page.nativeClick).toBeTypeOf('function');
    expect(page.handleJavaScriptDialog).toBeTypeOf('function');
    expect(page.cdp).toBeTypeOf('function');

    await page.nativeType!('hello');
    await page.nativeKeyPress!('a', ['Ctrl']);
    await page.nativeClick!(10, 20);
    await page.handleJavaScriptDialog!(true, 'ok');
    await page.cdp!('Page.getLayoutMetrics', {});

    expect(send.mock.calls).toEqual([
      ['Input.insertText', { text: 'hello' }],
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 }],
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 }],
      ['Page.handleJavaScriptDialog', { accept: true, promptText: 'ok' }],
      ['Page.getLayoutMetrics', {}],
    ]);
  });

  it('captures request headers and bounded post data on direct CDP pages', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    const fullBody = 'x'.repeat(CDP_REQUEST_BODY_CAPTURE_LIMIT + 5);
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.getRequestPostData') return { postData: fullBody };
      return {};
    });

    const page = await bridge.connect();
    await page.startNetworkCapture?.();
    MockWebSocket.lastInstance?.emit('message', Buffer.from(JSON.stringify({
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'request-1',
        request: {
          method: 'POST',
          url: 'https://example.test/rsc-action/actions/pagination',
          headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
          hasPostData: true,
        },
      },
    })));

    const entries = await page.readNetworkCapture?.() as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      method: 'POST',
      requestHeaders: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      requestBodyKind: 'string',
      requestBodyFullSize: fullBody.length,
      requestBodyTruncated: true,
    });
    expect(String(entries[0].requestBodyPreview)).toHaveLength(CDP_REQUEST_BODY_CAPTURE_LIMIT);
  });

  // Draining an in-flight request must not attach its late response to a new entry.
  it('drops stale request indexes after reading an in-flight network capture', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockResolvedValue({});
    const page = await bridge.connect();
    await page.startNetworkCapture?.();

    const emit = (method: string, params: object) => MockWebSocket.lastInstance?.emit(
      'message', Buffer.from(JSON.stringify({ method, params })),
    );
    emit('Network.requestWillBeSent', {
      requestId: 'old',
      request: { method: 'GET', url: 'https://example.test/slow' },
    });
    expect(await page.readNetworkCapture?.()).toHaveLength(1);
    emit('Network.requestWillBeSent', {
      requestId: 'new',
      request: { method: 'GET', url: 'https://example.test/fast' },
    });

    expect(() => emit('Network.responseReceived', {
      requestId: 'old',
      response: { status: 404, mimeType: 'text/plain' },
    })).not.toThrow();
    emit('Network.responseReceived', {
      requestId: 'new',
      response: { status: 200, mimeType: 'application/json' },
    });
    expect(await page.readNetworkCapture?.()).toMatchObject([
      { url: 'https://example.test/fast', responseStatus: 200 },
    ]);
  });
});

describe('CDPBridge SSE stream capture', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');
  });

  const SSE_URL = 'https://chatgpt.com/backend-api/conversation';
  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  /** Decode drained chunks back to bytes so tests assert stream content, not markers. */
  const decodeChunks = (chunks: SseCaptureChunk[]): string =>
    chunks.map((chunk) => (
      chunk.kind === 'sse-chunk'
        ? Buffer.from(chunk.payload.replace(/^base64:/, ''), 'base64').toString('utf8')
        : ''
    )).join('');
  const emit = (method: string, params: Record<string, unknown>): void => {
    MockWebSocket.lastInstance?.emit('message', Buffer.from(JSON.stringify({ method, params })));
  };
  const responseReceived = (requestId: string, url: string, mimeType: string): Record<string, unknown> => (
    { requestId, response: { url, mimeType } }
  );
  /** Arm state settles on the microtask queue; one macrotask turn flushes it. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  // The buffered prefix Chrome returns from streamResourceContent is the earliest
  // byte range, so it must precede any chunk that raced the command response.
  it('emits the buffered prefix before chunks that raced the arm command', async () => {
    const bridge = new CDPBridge();
    const arm = deferred<{ bufferedData: string }>();
    const send = vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return arm.promise;
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    // Chrome can start streaming inside the arm round trip: these bytes are
    // strictly later than the buffered prefix.
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: second\n\n') });
    arm.resolve({ bufferedData: b64('data: first\n\n') });
    await settle();

    const result = await page.readSseCapture?.();
    expect(result?.dropped).toBe(0);
    expect(result?.chunks.map((chunk) => chunk.kind)).toEqual(['sse-chunk', 'sse-chunk']);
    expect(decodeChunks(result?.chunks ?? [])).toBe('data: first\n\ndata: second\n\n');
    expect(result?.chunks[0]).toMatchObject({ url: SSE_URL, requestId: 'sse1', payloadTruncated: false });
    expect(send.mock.calls).toContainEqual([
      'Network.streamResourceContent',
      { requestId: 'sse1' },
      expect.any(Number),
    ]);
  });

  // Only text/event-stream responses may be armed: a JSON response on a matching
  // URL must not cost a CDP round trip (and must not surface an sse-error).
  it('arms only matching text/event-stream responses and splits chunks in order', async () => {
    const bridge = new CDPBridge();
    const send = vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return { bufferedData: b64('data: a\n') };
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('json1', SSE_URL, 'application/json'));
    emit('Network.responseReceived', responseReceived('other1', 'https://other.example/stream', 'text/event-stream'));
    await settle();
    expect(send.mock.calls.filter((call) => call[0] === 'Network.streamResourceContent')).toHaveLength(0);

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream; charset=utf-8'));
    await settle();
    for (const text of ['data: b\n\n', 'data: c\n\n']) {
      emit('Network.dataReceived', { requestId: 'sse1', data: b64(text) });
    }
    // Unrelated requests must never leak into the drained chunks.
    emit('Network.dataReceived', { requestId: 'json1', data: b64('{"noise":true}') });

    const { chunks } = await page.readSseCapture?.() ?? { chunks: [], dropped: 0 };
    expect(chunks).toHaveLength(3);
    expect(decodeChunks(chunks)).toBe('data: a\ndata: b\n\ndata: c\n\n');
  });

  // A Chrome without Network.streamResourceContent must fail the consumer loudly
  // instead of reporting an empty (or silently short) stream.
  it('surfaces an sse-error chunk when the arm command fails, keeping streamed bytes', async () => {
    const bridge = new CDPBridge();
    const arm = deferred<{ bufferedData: string }>();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return arm.promise;
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: raced\n\n') });
    arm.reject(new Error("'Network.streamResourceContent' wasn't found"));
    await settle();

    const first = await page.readSseCapture?.();
    expect(first?.chunks[0]).toMatchObject({
      kind: 'sse-error',
      url: SSE_URL,
      requestId: 'sse1',
      error: expect.stringContaining("wasn't found"),
    });
    // Bytes streamed to us before the failure are still delivered after it.
    expect(decodeChunks(first?.chunks.slice(1) ?? [])).toBe('data: raced\n\n');

    // The stream never started: later events for it must not accumulate noise.
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: late\n\n') });
    expect((await page.readSseCapture?.())?.chunks).toEqual([]);
  });

  // Oversized chunks are stored truncated *and* flagged so consumers can fail
  // instead of trusting a silently shortened stream.
  it('flags oversized chunks instead of truncating silently', async () => {
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return { bufferedData: b64('data: head\n') };
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    await settle();
    emit('Network.dataReceived', { requestId: 'sse1', data: 'A'.repeat(CDP_SSE_CHUNK_PAYLOAD_LIMIT + 1) });

    const chunks = ((await page.readSseCapture?.())?.chunks ?? []).filter((chunk) => chunk.kind === 'sse-chunk');
    expect(chunks[1]).toMatchObject({ kind: 'sse-chunk', payloadTruncated: true });
    expect(chunks[1].payload).toHaveLength('base64:'.length + CDP_SSE_CHUNK_PAYLOAD_LIMIT);
  });

  // A burst longer than the ring must be reported through `dropped` while the
  // newest chunks stay readable, so a slow reader cannot exhaust memory.
  it('counts dropped chunks when the ring overflows', async () => {
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return { bufferedData: b64('data: head\n') };
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    await settle();
    const overflow = 2;
    for (let i = 0; i < CDP_SSE_CHUNK_BUFFER_LIMIT + overflow - 1; i += 1) {
      emit('Network.dataReceived', { requestId: 'sse1', data: b64(`event ${i}\n`) });
    }

    const result = await page.readSseCapture?.();
    expect(result?.chunks).toHaveLength(CDP_SSE_CHUNK_BUFFER_LIMIT);
    expect(result?.dropped).toBe(overflow);
    // The buffered prefix and the first streamed chunk are the oldest entries.
    const texts = decodeChunks(result?.chunks ?? []).split('\n').filter(Boolean);
    expect(texts[0]).toBe(`event ${overflow - 1}`);
    expect(texts[texts.length - 1]).toBe(`event ${CDP_SSE_CHUNK_BUFFER_LIMIT + overflow - 2}`);
  });

  // Reading drains without losing the live stream's identity; stream end and stop
  // release per-request state so late events cannot resurrect it.
  it('drains on read, ignores chunks after stream end, and clears on stop', async () => {
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return { bufferedData: b64('data: head\n') };
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    await settle();
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: one\n') });

    const first = await page.readSseCapture?.();
    expect(decodeChunks(first?.chunks ?? [])).toBe('data: head\ndata: one\n');
    // Drain keeps request state so later chunks still resolve the stream URL.
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: two\n') });
    const second = await page.readSseCapture?.();
    expect(decodeChunks(second?.chunks ?? [])).toBe('data: two\n');
    expect(second?.chunks[0].url).toBe(SSE_URL);

    emit('Network.loadingFinished', { requestId: 'sse1' });
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: late\n') });
    expect((await page.readSseCapture?.())?.chunks).toEqual([]);

    await page.stopSseCapture?.();
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: ignored\n') });
    await expect(page.readSseCapture?.()).resolves.toEqual({ chunks: [], dropped: 0 });
  });

  /**
   * Base64 stream payload sized so one chunk stays under the per-chunk cap (its
   * marker then survives into the stored payload) while a handful of them still
   * exceed the aggregate byte budget.
   */
  const LARGE_CHUNK_RAW_LENGTH = Math.floor(CDP_SSE_CHUNK_PAYLOAD_LIMIT * 0.75) - 8;
  const largeChunkData = (marker: number): string =>
    b64(`${'A'.repeat(LARGE_CHUNK_RAW_LENGTH)}#${marker}\n`);
  const markersOf = (chunks: SseCaptureChunk[]): number[] =>
    [...decodeChunks(chunks).matchAll(/#(\d+)\n/g)].map((match) => Number(match[1]));
  const retainedBytesOf = (chunks: SseCaptureChunk[]): number =>
    chunks.reduce((sum, chunk) => sum + (chunk.kind === 'sse-chunk' ? chunk.payload.length : 0), 0);
  const largeChunkCount = (): number =>
    Math.ceil(CDP_SSE_CAPTURE_BYTE_BUDGET / CDP_SSE_CHUNK_PAYLOAD_LIMIT) + 4;
  /** Stored size of one large chunk (`base64:` + padding of the raw marker). */
  const LARGE_CHUNK_BYTES = 'base64:'.length + Math.ceil((LARGE_CHUNK_RAW_LENGTH + 4) / 3) * 4;
  // A batch that fits the budget on its own, so every read can be drop-free.
  const CHUNKS_PER_BATCH = Math.floor(CDP_SSE_CAPTURE_BYTE_BUDGET / LARGE_CHUNK_BYTES * 0.75);

  // Few large chunks (far under the count limit) must still hit the aggregate
  // byte budget: otherwise 10k × 1 MiB chunks could pin gigabytes in-process.
  it('evicts oldest chunks when a few large chunks exceed the byte budget', async () => {
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return { bufferedData: b64('data: head\n') };
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    await settle();
    const total = largeChunkCount();
    for (let i = 0; i < total; i += 1) {
      emit('Network.dataReceived', { requestId: 'sse1', data: largeChunkData(i) });
    }

    const result = await page.readSseCapture?.();
    const chunks = result?.chunks ?? [];
    const markers = markersOf(chunks);
    expect(retainedBytesOf(chunks)).toBeLessThanOrEqual(CDP_SSE_CAPTURE_BYTE_BUDGET);
    expect(result?.dropped).toBeGreaterThan(0);
    // Newest bytes stay readable, the oldest are the ones evicted, order holds.
    expect(markers[0]).toBeGreaterThan(0);
    expect(markers[markers.length - 1]).toBe(total - 1);
    expect(markers).toEqual([...markers].sort((a, b) => a - b));
  });

  // The pending arm queue is bounded by the same budget: a burst that arrives
  // while the arm command is in flight cannot grow without limit either.
  it('bounds the pending arm queue by the same byte budget', async () => {
    const bridge = new CDPBridge();
    const arm = deferred<{ bufferedData: string }>();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return arm.promise;
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    const total = largeChunkCount();
    for (let i = 0; i < total; i += 1) {
      emit('Network.dataReceived', { requestId: 'sse1', data: largeChunkData(i) });
    }
    arm.resolve({ bufferedData: b64('data: head\n') });
    await settle();

    const result = await page.readSseCapture?.();
    const chunks = result?.chunks ?? [];
    const markers = markersOf(chunks);
    expect(retainedBytesOf(chunks)).toBeLessThanOrEqual(CDP_SSE_CAPTURE_BYTE_BUDGET);
    expect(result?.dropped).toBeGreaterThan(0);
    expect(markers[markers.length - 1]).toBe(total - 1);
    expect(markers[0]).toBeGreaterThan(0);
  });

  // A drain hands bytes to the caller; they must also leave the capture budget,
  // otherwise an equally sized next batch would look like an overflow.
  it('keeps the byte budget honest across drains', async () => {
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return { bufferedData: b64('data: head\n') };
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    await settle();
    for (let batch = 0; batch < 2; batch += 1) {
      for (let i = 0; i < CHUNKS_PER_BATCH; i += 1) {
        emit('Network.dataReceived', { requestId: 'sse1', data: largeChunkData(i) });
      }
      const result = await page.readSseCapture?.();
      expect(result?.dropped).toBe(0);
      expect(markersOf(result?.chunks ?? [])).toEqual([...Array(CHUNKS_PER_BATCH).keys()]);
    }
  });

  // An abnormally ended stream never completes its protocol: the consumer gets
  // the bytes that arrived plus one failure entry, instead of waiting for its
  // own deadline. Only Chrome's error enum may surface — never URL/headers/body.
  it('reports an abnormally ended stream without echoing request data', async () => {
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return { bufferedData: b64('data: head\n') };
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    await settle();
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: one\n') });
    emit('Network.loadingFailed', {
      requestId: 'sse1',
      // Chrome reports a network error enum; even if a build ever appended the
      // URL to it, the failure entry must not echo it.
      errorText: `net::ERR_ABORTED ${SSE_URL}?token=secret-token`,
      canceled: true,
      // Chrome may attach response metadata to the event; none of it may reach
      // the failure entry.
      response: { url: SSE_URL, headers: { Authorization: 'Bearer secret-token' } },
      body: 'sensitive body',
    });

    const chunks = (await page.readSseCapture?.())?.chunks ?? [];
    expect(chunks.map((chunk) => chunk.kind)).toEqual(['sse-chunk', 'sse-chunk', 'sse-error']);
    expect(decodeChunks(chunks.slice(0, -1))).toBe('data: head\ndata: one\n');
    const failure = chunks[chunks.length - 1];
    if (failure.kind !== 'sse-error') throw new Error('expected an sse-error chunk');
    expect(failure.error).toContain('net::ERR_ABORTED');
    expect(failure.error).toContain('<url>');
    expect(failure.error).not.toContain(SSE_URL);
    expect(failure.error).not.toContain('secret-token');
    expect(failure.error).not.toContain('sensitive body');

    // A failed stream is closed: later events for it must not accumulate.
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: late\n') });
    expect((await page.readSseCapture?.())?.chunks).toEqual([]);
  });

  it('reports an in-arm stream failure after the bytes that arrived', async () => {
    const bridge = new CDPBridge();
    const arm = deferred<{ bufferedData: string }>();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.streamResourceContent') return arm.promise;
      return {};
    });

    const page = await bridge.connect();
    await page.startSseCapture?.('chatgpt.com');

    emit('Network.responseReceived', responseReceived('sse1', SSE_URL, 'text/event-stream'));
    emit('Network.dataReceived', { requestId: 'sse1', data: b64('data: raced\n\n') });
    emit('Network.loadingFailed', { requestId: 'sse1', errorText: 'net::ERR_CONNECTION_CLOSED' });
    arm.resolve({ bufferedData: b64('data: head\n') });
    await settle();

    const chunks = (await page.readSseCapture?.())?.chunks ?? [];
    expect(chunks.map((chunk) => chunk.kind)).toEqual(['sse-chunk', 'sse-chunk', 'sse-error']);
    expect(decodeChunks(chunks.slice(0, -1))).toBe('data: head\ndata: raced\n\n');
    const failure = chunks[2];
    if (failure.kind !== 'sse-error') throw new Error('expected an sse-error chunk');
    expect(failure.error).toContain('net::ERR_CONNECTION_CLOSED');
  });
});
