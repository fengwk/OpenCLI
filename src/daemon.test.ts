import { describe, expect, it } from 'vitest';

import {
  COMMAND_RESULT_UNKNOWN_CODE,
  COMMAND_RESULT_UNKNOWN_HINT,
  REQUEST_BODY_LIMIT_BYTES,
  REQUEST_BODY_TOO_LARGE_CODE,
  REQUEST_BODY_TOO_LARGE_HINT,
  REQUEST_BODY_TOO_LARGE_STATUS,
  buildCommandDispatchFailure,
  buildCommandTimeoutFailure,
  buildExtensionDisconnectFailure,
  buildRequestBodyTooLargeFailure,
  classifyRequestBodySize,
  commandResultUnknownMessage,
  getResponseCorsHeaders,
  resolveProfileRoute,
} from './daemon-utils.js';

describe('getResponseCorsHeaders', () => {
  it('allows the Browser Bridge extension origin to read /ping', () => {
    expect(getResponseCorsHeaders('/ping', 'chrome-extension://abc123')).toEqual({
      'Access-Control-Allow-Origin': 'chrome-extension://abc123',
      Vary: 'Origin',
    });
  });

  it('does not add CORS headers for ordinary web origins', () => {
    expect(getResponseCorsHeaders('/ping', 'https://example.com')).toBeUndefined();
  });

  it('does not add CORS headers when origin is absent', () => {
    expect(getResponseCorsHeaders('/ping')).toBeUndefined();
  });

  it('does not add CORS headers for command endpoints even from the extension origin', () => {
    expect(getResponseCorsHeaders('/command', 'chrome-extension://abc123')).toBeUndefined();
  });
});

describe('daemon command dispatch', () => {
  it('uses a distinct command_result_unknown contract for ambiguous dispatched commands', () => {
    expect(COMMAND_RESULT_UNKNOWN_CODE).toBe('command_result_unknown');
    expect(commandResultUnknownMessage('navigate')).toContain('navigate command was dispatched');
    expect(COMMAND_RESULT_UNKNOWN_HINT).toContain('Inspect the browser/session state');
    expect(COMMAND_RESULT_UNKNOWN_HINT).toContain('Do not blindly retry write commands');
  });

  it('classifies dispatched extension disconnects as command_result_unknown', () => {
    expect(buildExtensionDisconnectFailure({
      contextId: 'work',
      action: 'navigate',
      dispatched: true,
    })).toEqual({
      message: 'Browser connection dropped after the navigate command was dispatched; it may have completed.',
      errorCode: 'command_result_unknown',
      errorHint: COMMAND_RESULT_UNKNOWN_HINT,
      status: 503,
      countAsCommandResultUnknown: true,
    });
  });

  it('classifies pre-dispatch extension disconnects as profile_disconnected', () => {
    expect(buildExtensionDisconnectFailure({
      contextId: 'work',
      action: 'navigate',
      dispatched: false,
    })).toMatchObject({
      message: 'Browser profile "work" disconnected before command dispatch',
      errorCode: 'profile_disconnected',
      status: 503,
      countAsCommandResultUnknown: false,
    });
  });

  it('classifies ws.send dispatch failures as profile_disconnected', () => {
    expect(buildCommandDispatchFailure('work')).toMatchObject({
      message: 'Browser profile "work" disconnected before command dispatch',
      errorCode: 'profile_disconnected',
      status: 503,
      countAsCommandResultUnknown: false,
    });
  });

  it('routes a REQUESTED profile strictly — fails loud when offline, even with one live profile', () => {
    expect(resolveProfileRoute({ requestedContextId: 'zvypsyje', connectedContextIds: ['pavmrekj'] })).toMatchObject({
      ok: false,
      errorCode: 'profile_disconnected',
    });
    expect(resolveProfileRoute({ requestedContextId: 'pavmrekj', connectedContextIds: ['pavmrekj'] })).toEqual({
      ok: true,
      contextId: 'pavmrekj',
    });
  });

  it('uses a PREFERRED profile when connected', () => {
    expect(resolveProfileRoute({ preferredContextId: 'zvypsyje', connectedContextIds: ['zvypsyje', 'other'] })).toEqual({
      ok: true,
      contextId: 'zvypsyje',
    });
  });

  it('falls back to the only connected profile when the preferred one is stale', () => {
    expect(resolveProfileRoute({ preferredContextId: 'zvypsyje', connectedContextIds: ['pavmrekj'] })).toEqual({
      ok: true,
      contextId: 'pavmrekj',
      fallbackFrom: 'zvypsyje',
    });
  });

  it('asks the user to choose when the preferred profile is stale and multiple are connected', () => {
    const route = resolveProfileRoute({ preferredContextId: 'zvypsyje', connectedContextIds: ['a', 'b'] });
    expect(route).toMatchObject({ ok: false, errorCode: 'profile_required' });
    if (!route.ok) {
      expect(route.error).toContain('zvypsyje');
      expect(route.errorHint).toContain('opencli profile use');
    }
  });

  it('keeps the legacy no-selection behavior: single auto-use, multiple ask, none error', () => {
    expect(resolveProfileRoute({ connectedContextIds: ['only'] })).toEqual({ ok: true, contextId: 'only' });
    expect(resolveProfileRoute({ connectedContextIds: ['a', 'b'] })).toMatchObject({ ok: false, errorCode: 'profile_required' });
    expect(resolveProfileRoute({ connectedContextIds: [] })).toMatchObject({ ok: false, errorCode: 'extension_not_connected' });
    expect(resolveProfileRoute({ preferredContextId: 'gone', connectedContextIds: [] })).toMatchObject({ ok: false, errorCode: 'extension_not_connected' });
  });

  it('classifies daemon-side command timeouts as command_result_unknown with a 408', () => {
    expect(buildCommandTimeoutFailure('navigate', 120_000)).toEqual({
      message: 'Browser navigate command timed out after 120s; it may still complete in the browser.',
      errorCode: 'command_result_unknown',
      errorHint: COMMAND_RESULT_UNKNOWN_HINT,
      status: 408,
      countAsCommandResultUnknown: true,
    });
  });
});

describe('request body cap', () => {
  // Single source of truth — keep the public constant in sync with the
  // expected 1 MiB cap so future drift is caught at unit-test time.
  it('keeps the limit at 1 MiB', () => {
    expect(REQUEST_BODY_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it('classifies a body exactly at the cap as ok (strict >)', () => {
    expect(classifyRequestBodySize(REQUEST_BODY_LIMIT_BYTES)).toEqual({
      kind: 'ok',
      receivedBytes: REQUEST_BODY_LIMIT_BYTES,
      limit: REQUEST_BODY_LIMIT_BYTES,
    });
  });

  it('classifies a body one byte over the cap as too-large', () => {
    expect(classifyRequestBodySize(REQUEST_BODY_LIMIT_BYTES + 1)).toEqual({
      kind: 'too-large',
      receivedBytes: REQUEST_BODY_LIMIT_BYTES + 1,
      limit: REQUEST_BODY_LIMIT_BYTES,
    });
  });

  it('classifies an empty body as ok', () => {
    expect(classifyRequestBodySize(0)).toEqual({ kind: 'ok', receivedBytes: 0, limit: REQUEST_BODY_LIMIT_BYTES });
  });

  it('builds a structured 413 failure with received bytes and limit surfaced in the message and hint', () => {
    const failure = buildRequestBodyTooLargeFailure(REQUEST_BODY_LIMIT_BYTES + 1024);
    expect(failure).toMatchObject({
      ok: false,
      errorCode: REQUEST_BODY_TOO_LARGE_CODE,
      errorHint: REQUEST_BODY_TOO_LARGE_HINT,
      status: REQUEST_BODY_TOO_LARGE_STATUS,
      receivedBytes: REQUEST_BODY_LIMIT_BYTES + 1024,
      limit: REQUEST_BODY_LIMIT_BYTES,
      retryable: false,
    });
    expect(failure.message).toContain(String(REQUEST_BODY_LIMIT_BYTES + 1024));
    expect(failure.message).toContain(String(REQUEST_BODY_LIMIT_BYTES));
    // Hint must be actionable — naming the native file-input path keeps the
    // contract aligned with the page-side setFileInputFiles work.
    expect(REQUEST_BODY_TOO_LARGE_HINT).toContain('1 MiB');
    expect(REQUEST_BODY_TOO_LARGE_HINT).toContain('base64');
    expect(REQUEST_BODY_TOO_LARGE_HINT).toContain('upload --file');
  });

  it('always marks the failure as non-retryable so the CLI never re-posts the same oversized body', () => {
    expect(buildRequestBodyTooLargeFailure(2_000_000).retryable).toBe(false);
    expect(buildRequestBodyTooLargeFailure(2_000_000, 1024).retryable).toBe(false);
  });

  it('uses 413 as the structured HTTP status (RFC 7231 §6.5.11)', () => {
    expect(REQUEST_BODY_TOO_LARGE_STATUS).toBe(413);
    expect(REQUEST_BODY_TOO_LARGE_CODE).toBe('request_body_too_large');
  });
});
