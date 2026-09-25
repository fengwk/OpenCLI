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

import { CDPBridge, CDP_REQUEST_BODY_CAPTURE_LIMIT, CDP_SSE_CHUNK_BUFFER_LIMIT, CDP_SSE_CHUNK_PAYLOAD_LIMIT } from './cdp.js';
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
});
