# OpenCLI Fork Notes

This document tracks **fork-only** changes on branch `dev` relative to upstream OpenCLI.
Use it when merging back to mainline or rebasing onto upstream.

**Plugin adapters** (e.g. `chatgpt-agent`) live in a separate plugin repo:

- `~/proj/my-opencli` — install with `opencli plugin install ~/proj/my-opencli`

---

## Why this fork exists

1. **Long-lived WebSocket capture** for ChatGPT protocol streams (without relying on `webSocketCreated` for already-open sockets).
2. **Hardened `setFileInput`** for Chrome debugger file chooser interception (`showPicker`, longer timeout, describeNode fallback).
3. **Repeatable CLI flags** (`Arg.repeatable`) for multi `--file a --file b`.
4. Supporting the **chatgpt-agent** plugin workflow (protocol-first turns, human-like downloads, sequential uploads).

---

## Changelog (fork)

### 2026-07-18

#### Runtime / extension

| Area | Change | Paths |
|------|--------|--------|
| WS capture | `startWsCapture` / `readWsCapture`; arm before Network.enable; empty URL pattern for dedicated tabs | `extension/src/cdp.ts`, `extension/src/protocol.ts`, `extension/src/background.ts`, `src/browser/page.ts`, `src/browser/cdp.ts`, `src/browser/daemon-client.ts`, `src/types.ts` |
| WS design note | Capture semantics & pitfalls | `docs/design/ws-stream-capture.md` |
| setFileInput | Prefer `showPicker()`, 8s chooser wait, `DOM.describeNode` backendNodeId fallback | `extension/src/cdp.ts` |
| CLI args | `Arg.repeatable` + Commander collect; manifest field | `src/registry.ts`, `src/commanderAdapter.ts`, `src/manifest-types.ts`, `src/build-manifest.ts` |

#### Adapter (plugin only — not in core `clis/`)

| Area | Change | Location |
|------|--------|----------|
| chatgpt-agent | Protocol stream ask, sequential upload, file chip download, image export | `~/proj/my-opencli/packages/chatgpt-agent` via official `opencli plugin install` |

#### Packaging

| Script | Purpose |
|--------|---------|
| `scripts/package-fork.sh` | Build CLI + extension, emit dated extension zip to repo root and `~/Downloads` |

---

## Merge checklist (into upstream)

1. **WS capture API** — review for multi-tab lease safety; document extension version bump if protocol actions are new.
2. **setFileInput** — upstream may already have partial chooser work (#2108); rebase carefully on `extension/src/cdp.ts`.
3. **`Arg.repeatable`** — low risk; useful beyond this fork.
4. **chatgpt-agent** — prefer shipping as **plugin**, not core `clis/`, unless upstream wants a first-party agent adapter.
5. Drop fork-only docs (`FORK.md`) or fold into upstream CHANGELOG when landing.

---

## Runtime requirements for chatgpt-agent plugin

| Capability | Source |
|------------|--------|
| `page.startWsCapture` / `readWsCapture` | This fork’s extension + CLI |
| `page.setFileInput` | Extension CDP (reload after package) |
| `page.waitForDownload` | Existing OpenCLI |
| `clis/chatgpt/utils.js` | Host package (plugin resolves via `host-chatgpt.js`) |

---

## Quick build / package

```bash
cd ~/proj/OpenCLI
./scripts/package-fork.sh
# → opencli-extension-*-YYYYMMDD-HHMM.zip
# → also copied to C:\Users\…\Downloads when /mnt/c is present
```

Install / reload extension from the zip or `extension-package/`.

```bash
# plugin
opencli plugin install ~/proj/my-opencli
opencli chatgpt-agent ask --help
```
