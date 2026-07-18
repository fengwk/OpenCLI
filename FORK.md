# OpenCLI Fork Notes

This document tracks **fork-only** changes on branch `dev` relative to upstream OpenCLI.
Use it when merging back to mainline or rebasing onto upstream.

**Plugin adapters** (e.g. `chatgpt-agent`) live in a separate plugin repo:

- `~/proj/my-opencli/packages/chatgpt-agent` — install with `opencli plugin install ~/proj/my-opencli/packages/chatgpt-agent`

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

#### Packaging / release

| Item | Purpose |
|------|---------|
| `scripts/package-fork.sh` | Build CLI + extension; emit versioned npm `.tgz`, extension zip, `SHA256SUMS`, `build-info.json` under `artifacts/` (or `--output-dir`) |
| `.github/workflows/fork-release.yml` | Tag `fork-v*` / manual dispatch packaging; Actions artifact upload; GitHub Release attach for tags only (no npm publish) |

**Current versions**

| Component | Version |
|-----------|---------|
| CLI (`@jackwener/opencli`) | `1.8.7-fengwk.2` |
| Extension | `1.0.24` (`compatRange`: `>=1.8.7`) |

### Auto-update policy (fork)

Fork builds (`*-fengwk.*` versions) are **not** published to upstream npm and must **not** use upstream auto-update discovery:

- CLI background update check (npm registry `@jackwener/opencli`) is disabled.
- Exit-time update notices and doctor “latest extension” cache reads from upstream GitHub Releases are disabled.
- Upgrade by installing the fork Release artifacts (`.tgz` / extension zip) from `fengwk/OpenCLI` tags `fork-v*`, not via `npm install -g @jackwener/opencli`.
- Optional override for any build: set `OPENCLI_DISABLE_UPDATE_CHECK=1|true|yes`.

---

## Merge checklist (into upstream)

1. **WS capture API** — review for multi-tab lease safety; document extension version bump if protocol actions are new.
2. **setFileInput** — upstream may already have partial chooser work (#2108); rebase carefully on `extension/src/cdp.ts`.
3. **`Arg.repeatable`** — low risk; useful beyond this fork.
4. **chatgpt-agent** — prefer shipping as **plugin**, not core `clis/`, unless upstream wants a first-party agent adapter.
5. Drop fork-only docs (`FORK.md`) or fold into upstream CHANGELOG when landing.
6. Do **not** land fork release workflow / version branding as-is without renaming.

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
npm ci
(cd extension && npm ci)

# Default output: ./artifacts/
./scripts/package-fork.sh

# Explicit output directory (CI / temp validation)
./scripts/package-fork.sh --output-dir /tmp/opencli-artifacts

# Optional Windows Downloads copy (never used by CI)
./scripts/package-fork.sh --copy-to-windows-downloads
```

Artifacts (version-based names, no timestamps):

- `jackwener-opencli-1.8.7-fengwk.2.tgz`
- `opencli-extension-v1.0.24.zip`
- `SHA256SUMS`
- `build-info.json`

```bash
# install CLI from the tarball (not npm publish)
npm install -g ./artifacts/jackwener-opencli-1.8.7-fengwk.2.tgz
opencli --version   # → 1.8.7-fengwk.2

# plugin
opencli plugin install ~/proj/my-opencli/packages/chatgpt-agent
opencli chatgpt-agent ask --help
```

### GitHub fork release

1. Ensure `package.json` version is `X` and commit any regenerated `cli-manifest.json` / `extension/dist`.
2. Tag exactly `fork-vX` (example: `fork-v1.8.7-fengwk.2`) and push the tag.
3. Workflow `Fork Release` packages, uploads the Actions artifact bundle, and attaches tgz/zip/SHA256SUMS/build-info.json to the GitHub Release.
4. Never runs `npm publish` or upstream website dispatch jobs.
