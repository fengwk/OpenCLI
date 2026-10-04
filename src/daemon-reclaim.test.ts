import { describe, expect, it } from 'vitest';

import {
  ADAPTER_TAB_RECLAIM_ACTION,
  ADAPTER_TAB_RECLAIM_CAPABILITY,
  RECLAIM_MAX_DEADLINE_MS,
  evaluateBrowserCommandAdmission,
  evaluateReclaimAdmission,
  isAdapterTabReclaimAction,
  parseExtensionCapabilities,
  parseReclaimRequest,
  resolveReclaimDeadline,
} from './daemon-reclaim.js';

describe('isAdapterTabReclaimAction', () => {
  it('matches only the exact reclaim action', () => {
    expect(isAdapterTabReclaimAction({ action: ADAPTER_TAB_RECLAIM_ACTION })).toBe(true);
    expect(isAdapterTabReclaimAction({ action: 'exec' })).toBe(false);
    expect(isAdapterTabReclaimAction({})).toBe(false);
    expect(isAdapterTabReclaimAction(null)).toBe(false);
    expect(isAdapterTabReclaimAction('reclaim-adapter-tabs')).toBe(false);
  });
});

describe('parseExtensionCapabilities', () => {
  it('keeps only advertised non-empty strings, trimmed and deduplicated', () => {
    expect(parseExtensionCapabilities([' adapter-tab-reclaim-v1 ', 'adapter-tab-reclaim-v1', '', 42, null, 'session-lease-v1']))
      .toEqual(['adapter-tab-reclaim-v1', 'session-lease-v1']);
  });

  it('returns an empty list for a missing or non-array hello field', () => {
    expect(parseExtensionCapabilities(undefined)).toEqual([]);
    expect(parseExtensionCapabilities('adapter-tab-reclaim-v1')).toEqual([]);
    expect(parseExtensionCapabilities({ zero: true })).toEqual([]);
  });
});

describe('resolveReclaimDeadline', () => {
  const now = 1_000_000;

  it('rejects a missing or non-finite/non-integer deadline as a shape error', () => {
    for (const raw of [undefined, null, '1000', Number.NaN, Number.POSITIVE_INFINITY, 1_000.5]) {
      const result = resolveReclaimDeadline(raw, now);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.errorCode).toBe('reclaim_failed');
    }
  });

  it('rejects a deadline that is not strictly in the future', () => {
    const expired = resolveReclaimDeadline(now, now);
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.failure.errorCode).toBe('reclaim_deadline_exceeded');
      expect(expired.failure.status).toBe(408);
    }
    expect(resolveReclaimDeadline(now - 1, now).ok).toBe(false);
  });

  it('preserves a shorter deadline and clamps a farther one to now+5000', () => {
    expect(resolveReclaimDeadline(now + 1_500, now)).toEqual({ ok: true, deadlineAt: now + 1_500 });
    expect(resolveReclaimDeadline(now + 60_000, now)).toEqual({ ok: true, deadlineAt: now + RECLAIM_MAX_DEADLINE_MS });
  });
});

describe('parseReclaimRequest', () => {
  const now = 2_000_000;
  const base = { id: 'r-1', contextId: 'ctx-a', surface: 'adapter', deadlineAt: now + 2_000 };

  it('accepts a valid request and stamps a bounded remaining budget', () => {
    expect(parseReclaimRequest(base, now)).toEqual({
      ok: true,
      request: { id: 'r-1', contextId: 'ctx-a', deadlineAt: now + 2_000, timeoutMs: 2_000 },
    });
    const clamped = parseReclaimRequest({ ...base, deadlineAt: now + 60_000 }, now);
    expect(clamped).toEqual({
      ok: true,
      request: { id: 'r-1', contextId: 'ctx-a', deadlineAt: now + RECLAIM_MAX_DEADLINE_MS, timeoutMs: RECLAIM_MAX_DEADLINE_MS },
    });
  });

  it('requires a non-blank id, contextId, and surface="adapter"', () => {
    for (const body of [
      { ...base, id: '  ' },
      { ...base, contextId: '' },
      { ...base, contextId: '   ' },
      { ...base, surface: 'browser' },
      { ...base, surface: undefined },
    ]) {
      const result = parseReclaimRequest(body as Record<string, unknown>, now);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.errorCode).toBe('invalid_reclaim_request');
    }
  });

  it('propagates the deadline failure without dispatching', () => {
    const missing = parseReclaimRequest({ ...base, deadlineAt: undefined }, now);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.errorCode).toBe('reclaim_failed');

    const expired = parseReclaimRequest({ ...base, deadlineAt: now - 1 }, now);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.failure.errorCode).toBe('reclaim_deadline_exceeded');
  });
});

describe('evaluateReclaimAdmission', () => {
  const clear = {
    capabilitySupported: true,
    sameContextPendingCommands: 0,
    sameContextHasLease: false,
    sameContextReclaiming: false,
  };

  it('admits a capability-advertising, idle context', () => {
    expect(evaluateReclaimAdmission(clear)).toEqual({ ok: true });
  });

  it('rejects a profile that does not advertise the capability — no version guessing', () => {
    const result = evaluateReclaimAdmission({ ...clear, capabilitySupported: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.errorCode).toBe('adapter_tab_reclaim_unsupported');
      expect(result.failure.status).toBe(409);
    }
  });

  it('rejects while a command is pending, a reclamation is in flight, or a lease is held', () => {
    for (const override of [
      { sameContextPendingCommands: 1 },
      { sameContextReclaiming: true },
      { sameContextHasLease: true },
    ]) {
      const result = evaluateReclaimAdmission({ ...clear, ...override });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.errorCode).toBe('adapter_tabs_busy');
    }
  });
});

describe('evaluateBrowserCommandAdmission', () => {
  it('rejects an ordinary command for a context under reclamation', () => {
    const result = evaluateBrowserCommandAdmission({ contextId: 'ctx-a', reclaiming: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.errorCode).toBe('adapter_tabs_busy');
      expect(result.failure.status).toBe(409);
    }
  });

  it('admits commands for an unaffected context', () => {
    expect(evaluateBrowserCommandAdmission({ contextId: 'ctx-b', reclaiming: false })).toEqual({ ok: true });
  });
});

describe('reclaim capability constant', () => {
  it('advertises the v1 capability string the extension hello uses', () => {
    expect(ADAPTER_TAB_RECLAIM_CAPABILITY).toBe('adapter-tab-reclaim-v1');
    expect(ADAPTER_TAB_RECLAIM_ACTION).toBe('reclaim-adapter-tabs');
  });
});
