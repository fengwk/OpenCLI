# WebSocket Stream Capture Runtime

## Goal

Give adapters a stable way to observe **page WebSocket frames** without reloading
the tab:

```text
startWsCapture → act (send message) → readWsCapture until protocol end → return
```

This is the foundation for agent-style sites (ChatGPT, Claude web, etc.) where the
most trustworthy turn payload is the stream protocol, not DOM text.

## API

```ts
await page.startWsCapture?.(pattern?: string)  // arm; empty pattern = all URLs
const frames = await page.readWsCapture?.()    // drain buffered frames
```

Each frame:

| field | meaning |
|-------|---------|
| `kind` | always `ws-frame` |
| `url` | WebSocket URL (from `Network.webSocketCreated`) |
| `requestId` | CDP request id for the socket |
| `timestamp` | capture time (ms) |
| `direction` | `received` \| `sent` |
| `opcode` | WS opcode (`1` text, `2` binary, …) |
| `payload` | text payload, or `base64:…` for binary |
| `payloadFullSize` / `payloadTruncated` | size guards |

`pattern` is a substring filter; use `|` for OR (same as HTTP network capture).

## Semantics

- **Forward-only**: frames that already happened before `startWsCapture` are not
  replayed. Arm capture **before** the action that triggers the turn stream.
- **Persistent tab**: use `siteSession: 'persistent'` so consecutive CLI calls
  keep the same page; capture can be re-armed each turn without reload.
- **Drain-on-read**: `readWsCapture` returns and clears the buffer (requestId→URL
  map is kept so later frames still resolve URLs).
- **Limits**: per-frame payload cap 1 MiB; ring buffer max 10_000 frames (oldest
  dropped; extension logs a warning with drop count). Keep in sync between
  `extension/src/cdp.ts` and `src/browser/cdp.ts`.
- **Re-attach safe**: forced debugger re-attach restores armed WS capture and
  re-enables `Network` (same pattern as HTTP network capture).
- **Navigate**: while WS (or HTTP) capture is armed, navigation does not detach
  the debugger, so the observer survives SPA transitions when possible.
- **URL filter depends on `webSocketCreated`**: filtered capture drops frames
  whose socket URL is unknown. Long-lived sockets that were open before arming
  may never re-emit `webSocketCreated`; if filtered reads stay empty, re-arm with
  an empty pattern and filter in the adapter, or ensure the site opens a new WS
  after arm.

## Protocol surface

| layer | piece |
|-------|-------|
| Extension protocol | `ws-capture-start`, `ws-capture-read` |
| Extension CDP | `Network.webSocketCreated` / `FrameReceived` / `FrameSent` / `Closed` |
| CLI `Page` | `startWsCapture` / `readWsCapture` |
| Direct CDP path | same methods on `CDPPage` |

## Adapter recipe

```ts
const armed = await page.startWsCapture?.('chatgpt.com');
if (!armed) throw new Error('WebSocket capture unavailable; update Browser Bridge extension');

await sendPrompt(page, prompt);

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const frames = await page.readWsCapture?.() ?? [];
  for (const frame of frames) {
    if (frame.direction !== 'received') continue;
    collector.ingest(frame.payload); // site-specific protocol parser
  }
  if (collector.isComplete()) break;
  await page.sleep(0.2);
}

return collector.toResult();
```

## Non-goals

- Historical frame replay for sockets opened before arming
- Push streaming from daemon to CLI stdout (commands stay request/response)
- Full binary media pipeline over WS (binary is preview-capped)
- Replacing HTTP `startNetworkCapture` (orthogonal)

## Lifecycle & release

| Event | Behavior |
|-------|----------|
| `ws-capture-start` | Replace per-tab capture state (empty ring) + `Network.enable` |
| `ws-capture-read` | Drain frames; keep requestId→URL map for in-flight sockets |
| `ws-capture-stop` | **Delete** per-tab capture state (free ring + maps) |
| tab closed / debugger detach / non-debuggable URL | Capture state removed |

Adapters (e.g. chatgpt-agent) should call `page.stopWsCapture()` in a `finally` after each turn so persistent site sessions do not keep buffering between commands. Frame buffer is bounded (10k × 1 MiB cap), but requestId maps and `hasActiveNetworkCapture` would otherwise stay hot indefinitely.
