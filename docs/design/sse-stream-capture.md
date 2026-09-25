# HTTP SSE Stream Capture Runtime

## Goal

Give adapters a stable way to observe an **HTTP `text/event-stream` response while the
stream is still open** — the server-sent-event counterpart of
[WebSocket stream capture](./ws-stream-capture.md):

```text
startSseCapture → act (send prompt) → readSseCapture until protocol end → stopSseCapture → return
```

Agent-style sites increasingly answer with SSE (`text/event-stream`) instead of a
WebSocket, where the trustworthy turn payload is the stream protocol rather than the
rendered DOM. Capture runs entirely through Chrome's `Network` CDP domain: the page's
own `fetch`/`XHR` are never patched, no request is replayed, and no request headers or
bodies are logged.

## API

```ts
const armed = await page.startSseCapture?.('chatgpt.com'); // arm; empty pattern = all URLs
const { chunks, dropped } = await page.readSseCapture?.() ?? { chunks: [], dropped: 0 };
await page.stopSseCapture?.();                             // free the buffer for this tab
```

Each drained entry is one of two shapes:

| field | meaning |
|-------|---------|
| `kind` | `sse-chunk` for stream bytes, `sse-error` for a failed stream arm |
| `url` | response URL of the stream (`Network.responseReceived.response.url`) |
| `requestId` | CDP request id of the stream |
| `timestamp` | capture time (ms) |
| `payload` | `sse-chunk` only: `base64:<base64-bytes>` stream slice |
| `payloadTruncated` | `sse-chunk` only: the slice hit the 1 MiB per-chunk cap |
| `error` | `sse-error` only: CDP failure message (e.g. unsupported method) |

`dropped` (on the read result) counts chunks the bounded ring buffer evicted since the
previous read.

`pattern` is a URL substring filter; use `|` for OR (same as HTTP/WS capture). An empty
pattern matches every URL, but only responses whose MIME type is `text/event-stream` are
ever armed.

## Ordering and bytes

Chrome keeps an SSE body buffered until `Network.streamResourceContent(requestId)` asks
for it. The response carries `bufferedData` — the already-buffered prefix — and Chrome
reports every later byte through `Network.dataReceived.data`. Both are base64 of raw
response bytes, so payloads are byte-exact and framing-preserving: concatenating decoded
chunks in order reproduces the response body.

A `dataReceived` event can reach the extension after the command was sent but before its
response arrives. Those chunks are queued and flushed **after** `bufferedData`, so decoded
order always matches wire order (buffered prefix first, then streamed chunks). Consumers
must decode each `payload` before parsing SSE framing; chunk boundaries are transport
boundaries, not SSE event boundaries.

An absent or empty `bufferedData` means Chrome had no body bytes buffered at arm time — the
common case, because `responseReceived` fires on response headers. It is not a gap in the
stream, so it produces no chunk and no `sse-error`.

## Semantics

- **Forward-only**: chunks the page consumed before `startSseCapture` are not replayed.
  Arm capture **before** the action that opens the stream.
- **`sse-error` instead of silent emptiness**: when the arm command fails — an older
  Chrome without `Network.streamResourceContent`, or a request that is no longer
  streamable — one `sse-error` entry is drained for that stream and later events for it are
  ignored. A consumer must treat `sse-error` (and `payloadTruncated`, and `dropped > 0`) as
  "this view of the stream is incomplete" and fail or retry rather than parse a partial
  turn.
- **Drain-on-read**: `readSseCapture` returns and clears the buffer, and resets `dropped`.
  Per-request state is kept so an in-flight stream still resolves its URL and ordering
  after a drain.
- **Limits**: per-chunk payload cap 1 MiB (stored truncated **and** flagged); ring buffer
  max 10_000 chunks (oldest dropped, reported through `dropped`). Keep
  `CDP_SSE_CHUNK_PAYLOAD_LIMIT` / `CDP_SSE_CHUNK_BUFFER_LIMIT` in sync between
  `extension/src/cdp.ts` and `src/browser/cdp.ts`.
- **Narrow arming**: only `responseReceived` events whose URL passes the filter and whose
  MIME type contains `text/event-stream` are armed; ordinary JSON/HTML responses never
  cost a CDP round trip.
- **Re-attach safe**: a forced debugger re-attach restores armed SSE capture and re-enables
  `Network`, exactly like HTTP/WS capture.
- **Navigate**: while SSE capture is armed, navigation does not detach the debugger, so the
  observer survives SPA transitions when possible.
- **No page-runtime patching, no request duplication**: capture is read-only with respect
  to page traffic.

## Lifecycle & release

| Event | Behavior |
|-------|----------|
| `sse-capture-start` | Replace per-tab capture state (empty ring) + `Network.enable` |
| `sse-capture-read` | Drain chunks + `dropped`; keep per-request stream state |
| `sse-capture-stop` | **Delete** per-tab capture state (ring + per-request maps) |
| `responseReceived` (matching) | Track the stream and arm `Network.streamResourceContent` once |
| `loadingFinished` / `loadingFailed` | Drop that stream's state; events arriving after it are ignored |
| tab closed / debugger detach / non-debuggable URL | Capture state removed |

Adapters should call `page.stopSseCapture()` in a `finally` after each turn so persistent
site sessions do not keep buffering between commands.

## Protocol surface

| layer | piece |
|-------|-------|
| Extension protocol | `sse-capture-start`, `sse-capture-read`, `sse-capture-stop` |
| Extension CDP | `Network.responseReceived` / `dataReceived` / `loadingFinished` / `loadingFailed` + `Network.streamResourceContent` |
| CLI `Page` | `startSseCapture` / `readSseCapture` / `stopSseCapture` |
| Direct CDP path | same methods on `CDPPage` |

## Adapter recipe

```ts
const armed = await page.startSseCapture?.('chatgpt.com');
if (!armed) throw new Error('SSE capture unavailable; update Browser Bridge extension');

await sendPrompt(page, prompt);

const deadline = Date.now() + timeoutMs;
try {
  while (Date.now() < deadline) {
    const { chunks, dropped } = await page.readSseCapture?.() ?? { chunks: [], dropped: 0 };
    if (dropped > 0) throw new Error(`SSE capture overflowed (${dropped} chunks dropped)`);
    for (const chunk of chunks) {
      if (chunk.kind === 'sse-error') throw new Error(`SSE capture failed: ${chunk.error}`);
      if (chunk.payloadTruncated) throw new Error('SSE chunk truncated');
      collector.ingest(Buffer.from(chunk.payload.slice('base64:'.length), 'base64'));
    }
    if (collector.isComplete()) break;
    await page.sleep(0.2);
  }
} finally {
  await page.stopSseCapture?.();
}
```

## Non-goals

- Replaying the part of the stream the page already consumed before arming
- Push streaming from daemon to CLI stdout (commands stay request/response)
- Parsing SSE framing for the consumer (chunks are transport slices; the adapter owns the
  protocol)
- Replacing HTTP `startNetworkCapture` or `startWsCapture` (orthogonal; all three may be
  armed together)
