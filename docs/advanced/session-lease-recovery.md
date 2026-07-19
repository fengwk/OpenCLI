# Persistent Write Session Recovery

OpenCLI serializes adapter `write` commands that use a persistent site session,
such as `chatgpt ask` and `chatgpt-agent ask`. The daemon owns this lease; a
CLI timeout never means the browser-side write did not happen.

Recovery restores **session availability**, not the original command result.
It never replays a write command.

## Capability discovery

Do not infer recovery support from the package version. Query the local daemon:

```http
GET /status
X-OpenCLI: 1
```

Supported daemons include both capabilities:

```json
{
  "capabilities": ["session-lease-v1", "session-recover-v1"]
}
```

`sessionLeases` exposes only active or recovering holders:

```json
{
  "contextId": "profile-context-id",
  "surface": "adapter",
  "session": "site:chatgpt-agent",
  "runId": "run_123_...",
  "command": "chatgpt-agent ask",
  "pid": 123,
  "owner": "opencli-hub:instance-id:execution-id",
  "startedAt": 1780000000000,
  "lastSeenAt": 1780000005000,
  "pendingCount": 1,
  "state": "ACTIVE"
}
```

`state` is `ACTIVE` or `RECOVERING`. A `RECOVERING` holder is fenced and is
not available to another writer.

## Recovery API

```http
POST /session-leases/recover
X-OpenCLI: 1
Content-Type: application/json
```

```json
{
  "contextId": "profile-context-id",
  "surface": "adapter",
  "session": "site:chatgpt-agent",
  "expectedRunId": "run_123_...",
  "mode": "CANCEL_AND_RESET",
  "reason": "execution_timeout"
}
```

All recovery requests are compare-and-set operations. `contextId`, `surface`,
`session`, and `expectedRunId` must identify the current holder. If another
run acquired the lease first, the daemon returns `OWNER_CHANGED` and never
touches that new holder.

### Modes

| Mode | Behavior |
|---|---|
| `RECLAIM_IF_IDLE` | Reclaims only when `pendingCount` is zero. The old runId is fenced, but the tab is not reset. |
| `CANCEL_AND_RESET` | Fences the old run, sends the existing Browser Bridge `close-window` action for the exact session, settles old pending commands as unknown, then releases the daemon lease only after reset acknowledgement. |

Success responses use this envelope:

```json
{
  "ok": true,
  "result": "RECOVERED",
  "runId": "run_123_...",
  "tabReset": true,
  "cancelledPending": 1
}
```

Possible `result` values are:

```text
RECOVERED
ALREADY_FREE
STILL_ACTIVE
OWNER_CHANGED
RESET_FAILED
```

If the Browser Bridge cannot confirm reset, the daemon returns
`RESET_FAILED` with `errorCode: "session_recovery_failed"`. The old run stays
fenced and the lease stays `RECOVERING`; retry recovery after the Browser
Bridge reconnects, or restart only the affected Chrome profile. Do not release
the lease manually.

## Safety properties

Recovery always follows this order:

```text
CAS expectedRunId
  -> mark RECOVERING + revoke old runId
  -> reset the exact Extension session
  -> settle old pending commands as command_result_unknown
  -> release the daemon lease
```

A revoked runId receives `session_lease_revoked`; a challenger during reset
receives `session_recovering`. Late Browser Bridge results for a fenced pending
command are ignored. `command_result_unknown`, `command_lost`, and
`result_evicted` retain their unknown-outcome semantics and are never retried
automatically.

For a crashed CLI, a challenger may use `process.kill(pid, 0)` only to prove
`ESRCH`. It never kills an external process. A dead owner with no pending work
is reclaimed; one with pending browser work starts asynchronous
`CANCEL_AND_RESET` and the challenger receives `session_recovering`.

## CLI and Hub ownership

Persistent adapter writes automatically attempt `CANCEL_AND_RESET` on timeout,
unknown outcome, `SIGINT`, and `SIGTERM`. The original command still reports
its timeout or unknown result; it is not replayed.

Set an owner label per OpenCLI process for observability and recovery routing:

```bash
export OPENCLI_RUN_OWNER='opencli-hub:<instanceId>:<executionId>'
```

When it is unset, the owner is `cli`. Hub should use the daemon capability and
structured error codes rather than parsing human-readable stderr.

## Extension compatibility and limits

This version reuses the existing Browser Bridge `close-window` protocol; no
Extension upgrade is required solely for session recovery. `close-window`
detaches/resets the owned session tab, but it cannot undo a page-side effect
that happened before the reset. That is why every cancelled pending write is
reported as unknown rather than success or a safely retryable failure.

The run context is process-local. The standard `opencli` executable runs one
command per process; embedders that invoke concurrent browser writes in the
same Node.js process must isolate their OpenCLI runtime instances.
