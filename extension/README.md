# OpenCLI Browser Bridge Extension

The extension connects Chrome tabs to the local OpenCLI daemon. It uses Chrome
extension APIs only as a transport and browser-control layer for explicit CLI
commands.

## Permission Notes

- `debugger`: sends CDP commands to OpenCLI-controlled or bound tabs.
- `tabs` / `tabGroups`: manages the dedicated OpenCLI automation container and
  reports selected tab metadata back to the CLI.
- `cookies`: reads cookies for browser-backed adapters that need authenticated
  fetches.
- `alarms` / `storage`: maintains Service Worker keepalive, active lease idle
  timers, and the `chrome.storage.session` target lease registry / owned adapter
  tab ID ledger (`adapterTabLedger`) across MV3 worker restarts. Startup runs a
  one-time migration that adopts tab IDs from any legacy per-tab alarms into the
  ledger and clears those alarms (cleanup only, no TTL expiry fallback).
- `downloads`: surfaces download lifecycle to `opencli browser wait download`.
  The extension observes started / in-progress / completed / failed downloads so
  the CLI can wait for a file triggered by an automation command. OpenCLI
  filters by the command's filename/URL pattern and timeout, and does not modify,
  redirect, or persist browser download history.

## Adapter Tab Lifecycle & Reclamation

- Standalone OpenCLI does not auto-expire adapter tabs: releasing an adapter
  lease only detaches the debugger and leaves the page open in the dedicated
  adapter window for later reuse.
- OpenCLI Hub schedules explicit context-scoped reclamation via the
  `reclaim-adapter-tabs` action (advertised through extension capability
  `adapter-tab-reclaim-v1`). Reclamation closes surplus owned adapter tabs and
  resets the last owned adapter tab to `about:blank` while
  keeping the window and profile/cookies intact. `persistent` (`siteSession:
  'persistent'`) and `--keep-tab` adapter tabs are not exempt when Hub reclaims
  an idle context.
- User tabs, borrowed (`bind`) tabs, `browser`-surface tabs, and tabs moved out
  of the automation window are never closed.
- Ownership survives service-worker restarts in `storage.session`, not browser
  restarts or extension reload/update. Historical orphan tabs with no remaining
  ownership evidence need manual cleanup while tasks are stopped; window
  membership alone is never sufficient to claim a user page.

Suggested Chrome Web Store justification for `downloads`:

> This extension uses `chrome.downloads` to surface download lifecycle
> (started / in-progress / completed / failed) to the OpenCLI command-line tool,
> so agents can wait for downloads triggered during an automation workflow. The
> command filters by a user-provided filename or URL pattern and timeout. We do
> not modify, redirect, or persist user download history.
