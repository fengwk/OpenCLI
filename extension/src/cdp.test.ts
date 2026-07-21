import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createChromeMock() {
  const debuggerEventListeners: Array<(source: { tabId?: number }, method: string, params: any) => void> = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const tabs = {
    get: vi.fn(async (_tabId: number) => ({
      id: 1,
      windowId: 1,
      url: 'https://x.com/home',
    })),
    onRemoved: { addListener: vi.fn((fn: (tabId: number) => void) => { tabRemovedListeners.push(fn); }) },
    onUpdated: { addListener: vi.fn() },
  };

  const debuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'ok' } };
      return {};
    }),
    onDetach: { addListener: vi.fn() },
    onEvent: { addListener: vi.fn((fn: (source: { tabId?: number }, method: string, params: any) => void) => { debuggerEventListeners.push(fn); }) },
  };

  const scripting = {
    executeScript: vi.fn(async () => [{ result: { removed: 1 } }]),
  };

  return {
    chrome: {
      tabs,
      debugger: debuggerApi,
      scripting,
      runtime: { id: 'opencli-test' },
    },
    debuggerApi,
    scripting,
    debuggerEventListeners,
    tabRemovedListeners,
  };
}

describe('cdp attach recovery', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not mutate the DOM before a successful attach', async () => {
    const { chrome, debuggerApi, scripting } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const result = await mod.evaluate(1, '1');

    expect(result).toBe('ok');
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });

  it('uses the default execution context for a frame when isolated worlds also exist', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    mod.registerFrameTracking();

    expect(debuggerEventListeners.length).toBeGreaterThanOrEqual(1);
    for (const listener of debuggerEventListeners) {
      listener(
        { tabId: 1 },
        'Runtime.executionContextCreated',
        { context: { id: 11, auxData: { frameId: 'frame-1', isDefault: false } } },
      );
      listener(
        { tabId: 1 },
        'Runtime.executionContextCreated',
        { context: { id: 22, auxData: { frameId: 'frame-1', isDefault: true } } },
      );
    }

    await mod.evaluateInFrame(1, 'document.title', 'frame-1');

    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 22 }),
    );
  });

  it('falls back to a frame target when no same-target execution context exists', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    debuggerApi.sendCommand = vi.fn(async (target: any, method: string, _params?: any) => {
      if (method === 'Target.setDiscoverTargets') return {};
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'oopif-frame', type: 'iframe', url: 'https://frame.test' }] };
      if (target?.targetId === 'oopif-frame' && method === 'Runtime.enable') return {};
      if (target?.targetId === 'oopif-frame' && method === 'Runtime.evaluate') {
        return { result: { value: 'frame-ok' } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: 'root-ok' } };
      return {};
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    mod.registerFrameTracking();

    const result = await mod.evaluateInFrame(1, 'document.title', 'oopif-frame');

    expect(result).toBe('frame-ok');
    expect(debuggerApi.attach).toHaveBeenCalledWith({ targetId: 'oopif-frame' }, '1.3');
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { targetId: 'oopif-frame' },
      'Runtime.evaluate',
      expect.any(Object),
    );
  });

});

function chromeMockForScreenshot(content: { width: number; height: number } = { width: 1024, height: 2048 }) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const debuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (_target: unknown, method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === 'Page.captureScreenshot') return { data: 'BASE64DATA' };
      if (method === 'Page.getLayoutMetrics') return { cssContentSize: content };
      return {};
    }),
    onDetach: { addListener: vi.fn() },
    onEvent: { addListener: vi.fn() },
  };
  const tabs = {
    get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://example.com' })),
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  };
  return {
    chrome: { tabs, debugger: debuggerApi, scripting: {}, runtime: { id: 'opencli-test' } },
    debuggerApi,
    calls,
  };
}

describe('cdp screenshot', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes a viewport screenshot without overriding device metrics by default', async () => {
    const { chrome, calls } = chromeMockForScreenshot();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const data = await mod.screenshot(1);

    expect(data).toBe('BASE64DATA');
    const methods = calls.map((c) => c.method);
    expect(methods).not.toContain('Emulation.setDeviceMetricsOverride');
    expect(methods).not.toContain('Emulation.clearDeviceMetricsOverride');
    expect(methods).toContain('Page.captureScreenshot');
  });

  it('overrides only width when --width is given without --full-page', async () => {
    const { chrome, calls } = chromeMockForScreenshot();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { width: 1080 });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].params).toEqual({ mobile: false, width: 1080, height: 0, deviceScaleFactor: 1 });
    expect(calls.some((c) => c.method === 'Page.getLayoutMetrics')).toBe(false);
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('overrides only height when --height is given without --full-page', async () => {
    const { chrome, calls } = chromeMockForScreenshot();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { height: 720 });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].params).toEqual({ mobile: false, width: 0, height: 720, deviceScaleFactor: 1 });
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('uses content size for fullPage screenshots without explicit dimensions', async () => {
    const { chrome, calls } = chromeMockForScreenshot({ width: 1024, height: 2048 });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { fullPage: true });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].params).toEqual({ mobile: false, width: 1024, height: 2048, deviceScaleFactor: 1 });
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('ignores --height under --full-page so the existing measure-from-content path is preserved', async () => {
    const { chrome, calls } = chromeMockForScreenshot({ width: 1024, height: 2048 });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { fullPage: true, height: 600 });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].params).toEqual({ mobile: false, width: 1024, height: 2048, deviceScaleFactor: 1 });
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('reflows at the requested width before measuring full-page height', async () => {
    // Simulate that at width=1080 the page reflows to a different content height.
    const { chrome, calls } = chromeMockForScreenshot({ width: 1080, height: 1500 });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { fullPage: true, width: 1080 });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(2);
    expect(overrides[0].params).toEqual({ mobile: false, width: 1080, height: 0, deviceScaleFactor: 1 });
    expect(overrides[1].params).toEqual({ mobile: false, width: 1080, height: 1500, deviceScaleFactor: 1 });

    const layoutBetween = calls.findIndex((c) => c.method === 'Page.getLayoutMetrics');
    const firstOverride = calls.findIndex((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(layoutBetween).toBeGreaterThan(firstOverride);
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('clears the device metrics override even when capture throws', async () => {
    const debuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_t: unknown, method: string) => {
        if (method === 'Page.captureScreenshot') throw new Error('capture-failed');
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 800, height: 600 } };
        return {};
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn() },
    };
    const chrome = {
      tabs: {
        get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://example.com' })),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
      },
      debugger: debuggerApi,
      scripting: {},
      runtime: { id: 'opencli-test' },
    };
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await expect(mod.screenshot(1, { width: 800 })).rejects.toThrow('capture-failed');

    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Emulation.clearDeviceMetricsOverride',
    );
  });
});

function chromeMockForDownloads(initialItems: chrome.downloads.DownloadItem[] = []) {
  const items = new Map(initialItems.map((item) => [item.id, item]));
  const createdListeners: Array<(item: chrome.downloads.DownloadItem) => void> = [];
  const changedListeners: Array<(delta: chrome.downloads.DownloadDelta) => void> = [];
  const downloads = {
    search: vi.fn(async (query: chrome.downloads.DownloadQuery) => {
      if (typeof query.id === 'number') {
        const item = items.get(query.id);
        return item ? [item] : [];
      }
      return [...items.values()];
    }),
    onCreated: {
      addListener: vi.fn((fn: (item: chrome.downloads.DownloadItem) => void) => { createdListeners.push(fn); }),
      removeListener: vi.fn((fn: (item: chrome.downloads.DownloadItem) => void) => {
        const idx = createdListeners.indexOf(fn);
        if (idx >= 0) createdListeners.splice(idx, 1);
      }),
    },
    onChanged: {
      addListener: vi.fn((fn: (delta: chrome.downloads.DownloadDelta) => void) => { changedListeners.push(fn); }),
      removeListener: vi.fn((fn: (delta: chrome.downloads.DownloadDelta) => void) => {
        const idx = changedListeners.indexOf(fn);
        if (idx >= 0) changedListeners.splice(idx, 1);
      }),
    },
  };
  return {
    chrome: { downloads },
    downloads,
    setItem(item: chrome.downloads.DownloadItem) {
      items.set(item.id, item);
    },
    emitCreated(item: chrome.downloads.DownloadItem) {
      items.set(item.id, item);
      for (const listener of [...createdListeners]) listener(item);
    },
    emitChanged(delta: chrome.downloads.DownloadDelta) {
      for (const listener of [...changedListeners]) listener(delta);
    },
  };
}

describe('cdp download waits', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns a recent completed download matching filename or URL', async () => {
    const { chrome, downloads } = chromeMockForDownloads([
      {
        id: 7,
        filename: '/tmp/receipt.pdf',
        url: 'https://app.example/download?id=receipt',
        finalUrl: 'https://cdn.example/receipt.pdf',
        mime: 'application/pdf',
        state: 'complete',
        totalBytes: 1234,
        danger: 'safe',
        startTime: new Date().toISOString(),
      } as chrome.downloads.DownloadItem,
    ]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const result = await mod.waitForDownload('receipt', 1000);

    expect(result).toMatchObject({
      downloaded: true,
      id: 7,
      filename: '/tmp/receipt.pdf',
      state: 'complete',
    });
    expect(downloads.onCreated.removeListener).toHaveBeenCalledTimes(1);
    expect(downloads.onChanged.removeListener).toHaveBeenCalledTimes(1);
  });

  it('waits for a matching in-progress download to complete', async () => {
    const mock = chromeMockForDownloads();
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    const promise = mod.waitForDownload('invoice', 1000);
    await Promise.resolve();

    const started = {
      id: 42,
      filename: '/tmp/invoice.crdownload',
      url: 'https://app.example/invoice',
      finalUrl: 'https://app.example/invoice',
      mime: 'application/pdf',
      state: 'in_progress',
      totalBytes: 0,
      danger: 'safe',
      startTime: new Date().toISOString(),
    } as chrome.downloads.DownloadItem;
    mock.emitCreated(started);
    mock.setItem({ ...started, filename: '/tmp/invoice.pdf', state: 'complete', totalBytes: 4567 });
    mock.emitChanged({ id: 42, state: { current: 'complete', previous: 'in_progress' } } as chrome.downloads.DownloadDelta);

    await expect(promise).resolves.toMatchObject({
      downloaded: true,
      id: 42,
      filename: '/tmp/invoice.pdf',
      state: 'complete',
    });
  });
});

describe('cdp network capture survives forced re-attach', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createReattachMock() {
    const onDetachListeners: Array<(source: { tabId?: number }) => void> = [];
    let failNextHealthCheck = false;
    let networkEnableCount = 0;
    const debuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async ({ tabId }: { tabId?: number }) => {
        // Chrome fires onDetach whenever the debugger detaches from a tab.
        for (const fn of onDetachListeners) fn({ tabId });
      }),
      sendCommand: vi.fn(async (_target: unknown, method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === '1') {
          if (failNextHealthCheck) {
            failNextHealthCheck = false;
            throw new Error('Inspected target navigated or closed');
          }
          return { result: { value: '1' } };
        }
        if (method === 'Network.enable') {
          networkEnableCount += 1;
          return {};
        }
        return {};
      }),
      onDetach: { addListener: vi.fn((fn: (s: { tabId?: number }) => void) => { onDetachListeners.push(fn); }) },
      onEvent: { addListener: vi.fn() },
    };
    const tabs = {
      get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://x.com/home' })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    };
    return {
      chrome: { tabs, debugger: debuggerApi, scripting: {}, runtime: { id: 'opencli-test' } },
      debuggerApi,
      failNextHealthCheck: () => { failNextHealthCheck = true; },
      networkEnableCount: () => networkEnableCount,
    };
  }

  it('preserves armed network capture and re-enables Network across a forced re-attach', async () => {
    const mock = createReattachMock();
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    // Wire the onDetach handler that wipes networkCaptures on detach.
    mod.registerListeners();

    await mod.startNetworkCapture(1);
    expect(mod.hasActiveNetworkCapture(1)).toBe(true);
    const enablesAfterStart = mock.networkEnableCount();

    // The next ensureAttached health-check throws, forcing a detach + re-attach.
    // The detach fires onDetach (which deletes the capture) and disables the
    // Network domain — the capture must be restored, not silently dropped.
    mock.failNextHealthCheck();
    await mod.ensureAttached(1);

    expect(mod.hasActiveNetworkCapture(1)).toBe(true);
    expect(mock.networkEnableCount()).toBeGreaterThan(enablesAfterStart);
  });
});

describe('cdp network capture correctness', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createNetworkMock() {
    const onEventListeners = [];
    const debuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target, method, params) => {
        if (method === 'Runtime.evaluate' && params?.expression === '1') return { result: { value: '1' } };
        if (method === 'Network.getRequestPostData') return {}; // no override; use inline postData
        return {};
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn((fn) => { onEventListeners.push(fn); }) },
    };
    const tabs = {
      get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://x.com/home' })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    };
    const fire = async (method, params) => {
      for (const fn of onEventListeners) await fn({ tabId: 1 }, method, params);
    };
    return {
      chrome: { tabs, debugger: debuggerApi, scripting: {}, runtime: { id: 'opencli-test' } },
      fire,
    };
  }

  it('preserves the original POST body when a captured request follows a redirect', async () => {
    const mock = createNetworkMock();
    vi.stubGlobal('chrome', mock.chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1, 'api.example');

    // Initial POST with a body.
    await mock.fire('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://api.example/login', method: 'POST', postData: 'user=a&pass=b', hasPostData: true },
    });
    // The 302 target re-fires with the SAME requestId, carried via redirectResponse,
    // as a GET with no postData — this must NOT wipe the captured body.
    await mock.fire('Network.requestWillBeSent', {
      requestId: 'r1',
      redirectResponse: { status: 302, url: 'https://api.example/login' },
      request: { url: 'https://api.example/home', method: 'GET' },
    });

    const entries = await mod.readNetworkCapture(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].requestBodyPreview).toBe('user=a&pass=b');
    expect(entries[0].requestBodyKind).toBe('string');
  });

  it('does not create an orphan entry from a response after the request was drained', async () => {
    const mock = createNetworkMock();
    vi.stubGlobal('chrome', mock.chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1, 'api.example');

    await mock.fire('Network.requestWillBeSent', {
      requestId: 'r2',
      request: { url: 'https://api.example/x', method: 'GET' },
    });
    // Read drains entries + clears requestToIndex while the request is in flight.
    const first = await mod.readNetworkCapture(1);
    expect(first).toHaveLength(1);

    // Late response for the drained request must not resurrect a half-entry.
    await mock.fire('Network.responseReceived', {
      requestId: 'r2',
      response: { url: 'https://api.example/x', status: 200, mimeType: 'text/html' },
    });
    const second = await mod.readNetworkCapture(1);
    expect(second).toEqual([]);
  });
});

describe('cdp websocket stream capture', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createWsMock() {
    const onEventListeners: Array<(source: { tabId?: number }, method: string, params: any) => void | Promise<void>> = [];
    const debuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target: unknown, method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === '1') return { result: { value: '1' } };
        return {};
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn((fn) => { onEventListeners.push(fn); }) },
    };
    const tabs = {
      get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://chatgpt.com/' })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    };
    const fire = async (method: string, params: any) => {
      for (const fn of onEventListeners) await fn({ tabId: 1 }, method, params);
    };
    return {
      chrome: { tabs, debugger: debuggerApi, scripting: {}, runtime: { id: 'opencli-test' } },
      fire,
    };
  }

  // Captures frames after start + URL filter — this is the agent stream runtime contract.
  it('captures matching websocket frames after start and drains on read', async () => {
    const mock = createWsMock();
    vi.stubGlobal('chrome', mock.chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startWsCapture(1, 'chatgpt.com');

    await mock.fire('Network.webSocketCreated', {
      requestId: 'ws1',
      url: 'wss://chatgpt.com/backend-api/conversation',
    });
    await mock.fire('Network.webSocketFrameReceived', {
      requestId: 'ws1',
      response: { opcode: 1, payloadData: '[{"type":"message"}]' },
    });
    // Unrelated host must be ignored when a filter is set.
    await mock.fire('Network.webSocketCreated', {
      requestId: 'ws2',
      url: 'wss://other.example/socket',
    });
    await mock.fire('Network.webSocketFrameReceived', {
      requestId: 'ws2',
      response: { opcode: 1, payloadData: 'noise' },
    });

    const frames = await mod.readWsCapture(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'ws-frame',
      url: 'wss://chatgpt.com/backend-api/conversation',
      requestId: 'ws1',
      direction: 'received',
      opcode: 1,
      payload: '[{"type":"message"}]',
    });

    // Second read drains empty until new frames arrive.
    await expect(mod.readWsCapture(1)).resolves.toEqual([]);
  });

  // Long-lived sockets may emit frames without webSocketCreated after Network.enable.
  it('keeps frames with unknown url when a filter is set (do not drop silently)', async () => {
    const mock = createWsMock();
    vi.stubGlobal('chrome', mock.chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startWsCapture(1, 'chatgpt.com');

    await mock.fire('Network.webSocketFrameReceived', {
      requestId: 'orphan-ws',
      response: { opcode: 1, payloadData: '[{"type":"message"}]' },
    });

    const frames = await mod.readWsCapture(1);
    expect(frames).toHaveLength(1);
    expect(frames[0].requestId).toBe('orphan-ws');
    expect(frames[0].payload).toContain('message');
  });

  it('keeps requestId→url mapping across drain so later frames still resolve', async () => {
    const mock = createWsMock();
    vi.stubGlobal('chrome', mock.chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startWsCapture(1, 'chatgpt.com');

    await mock.fire('Network.webSocketCreated', {
      requestId: 'ws1',
      url: 'wss://chatgpt.com/ws',
    });
    await mock.fire('Network.webSocketFrameReceived', {
      requestId: 'ws1',
      response: { opcode: 1, payloadData: 'a' },
    });
    await mod.readWsCapture(1);

    await mock.fire('Network.webSocketFrameReceived', {
      requestId: 'ws1',
      response: { opcode: 1, payloadData: 'b' },
    });
    const frames = await mod.readWsCapture(1);
    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toBe('b');
    expect(frames[0].url).toBe('wss://chatgpt.com/ws');
  });

  it('preserves armed ws capture across forced re-attach', async () => {
    const onDetachListeners: Array<(source: { tabId?: number }) => void> = [];
    let failNextHealthCheck = false;
    let networkEnableCount = 0;
    const onEventListeners: Array<(source: { tabId?: number }, method: string, params: any) => void | Promise<void>> = [];
    const debuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async ({ tabId }: { tabId?: number }) => {
        for (const fn of onDetachListeners) fn({ tabId });
      }),
      sendCommand: vi.fn(async (_target: unknown, method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === '1') {
          if (failNextHealthCheck) {
            failNextHealthCheck = false;
            throw new Error('Inspected target navigated or closed');
          }
          return { result: { value: '1' } };
        }
        if (method === 'Network.enable') {
          networkEnableCount += 1;
          return {};
        }
        return {};
      }),
      onDetach: { addListener: vi.fn((fn: (s: { tabId?: number }) => void) => { onDetachListeners.push(fn); }) },
      onEvent: { addListener: vi.fn((fn) => { onEventListeners.push(fn); }) },
    };
    const tabs = {
      get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://chatgpt.com/' })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    };
    vi.stubGlobal('chrome', { tabs, debugger: debuggerApi, scripting: {}, runtime: { id: 'opencli-test' } });
    const mod = await import('./cdp');
    mod.registerListeners();

    await mod.startWsCapture(1, 'chatgpt.com');
    expect(mod.hasActiveWsCapture(1)).toBe(true);
    expect(mod.hasActiveNetworkCapture(1)).toBe(true);
    const enablesAfterStart = networkEnableCount;

    // Seed a frame so restoration can be proven via buffered content.
    for (const fn of onEventListeners) {
      await fn({ tabId: 1 }, 'Network.webSocketCreated', {
        requestId: 'ws1',
        url: 'wss://chatgpt.com/ws',
      });
      await fn({ tabId: 1 }, 'Network.webSocketFrameReceived', {
        requestId: 'ws1',
        response: { opcode: 1, payloadData: 'keep-me' },
      });
    }

    failNextHealthCheck = true;
    await mod.ensureAttached(1);

    expect(mod.hasActiveWsCapture(1)).toBe(true);
    expect(networkEnableCount).toBeGreaterThan(enablesAfterStart);
    const frames = await mod.readWsCapture(1);
    expect(frames.map((f) => f.payload)).toContain('keep-me');
  });
});

describe('cdp evaluateInFrame stale context fallback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the frame target when the cached context id went stale', async () => {
    const debuggerEventListeners = [];
    const debuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (target, method, params) => {
        if (method === 'Runtime.enable') return {};
        // The cached context id is stale after the frame navigated: CDP rejects.
        if (method === 'Runtime.evaluate' && params?.contextId === 99) {
          throw new Error('Cannot find context with specified id');
        }
        if (method === 'Target.setDiscoverTargets') return {};
        if (method === 'Target.setAutoAttach') return {};
        if (method === 'Target.getTargets') {
          return { targetInfos: [{ targetId: 'stale-frame', type: 'iframe', url: 'https://frame.test' }] };
        }
        if (target?.targetId === 'stale-frame' && method === 'Runtime.evaluate') {
          return { result: { value: 'frame-ok' } };
        }
        return {};
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn((fn) => { debuggerEventListeners.push(fn); }) },
    };
    const tabs = {
      get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://x.com/home' })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    };
    vi.stubGlobal('chrome', { tabs, debugger: debuggerApi, scripting: {}, runtime: { id: 'opencli-test' } });

    const mod = await import('./cdp');
    mod.registerFrameTracking();
    // Cache a context id (99) for the frame, which then goes stale.
    for (const fn of debuggerEventListeners) {
      fn({ tabId: 1 }, 'Runtime.executionContextCreated', {
        context: { id: 99, auxData: { frameId: 'stale-frame', isDefault: true } },
      });
    }

    const result = await mod.evaluateInFrame(1, 'document.title', 'stale-frame');

    expect(result).toBe('frame-ok');
    expect(debuggerApi.attach).toHaveBeenCalledWith({ targetId: 'stale-frame' }, '1.3');
  });
});

describe('cdp command deadline', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function createHangingChromeMock() {
    const { chrome, debuggerApi } = createChromeMock();
    // A page-blocking native dialog (alert/confirm) makes Runtime.evaluate
    // never resolve; every other command still works.
    debuggerApi.sendCommand = vi.fn((_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') return new Promise<never>(() => {});
      return Promise.resolve({});
    }) as typeof debuggerApi.sendCommand;
    return { chrome, debuggerApi };
  }

  it('evaluate rejects instead of hanging forever when Runtime.evaluate never resolves', async () => {
    vi.useFakeTimers();
    const { chrome } = createHangingChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const pending = mod.evaluate(1, 'alert("blocked")');
    const assertion = expect(pending).rejects.toThrow(/timed out after 60s/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('evaluate honors a caller-supplied deadline from the command timeout', async () => {
    vi.useFakeTimers();
    const { chrome } = createHangingChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const pending = mod.evaluate(1, 'alert("blocked")', false, 10_000);
    const assertion = expect(pending).rejects.toThrow(/timed out after 10s/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});

describe('cdp isFileInputFallbackEligible', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('accepts the canonical crbug 928255 Not allowed rejection', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    expect(mod.isFileInputFallbackEligible(new Error('-32000 Not allowed'))).toBe(true);
  });

  it('accepts Invalid parameters and object-not-resolved shapes', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    expect(mod.isFileInputFallbackEligible(new Error('-32000 Invalid parameters: files'))).toBe(true);
    expect(mod.isFileInputFallbackEligible(new Error('-32000 Object reference could not be resolved'))).toBe(true);
    expect(mod.isFileInputFallbackEligible(new Error('-32000 No node with given id found'))).toBe(true);
  });

  it('rejects transport / lifecycle failures (no -32000 prefix)', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    expect(mod.isFileInputFallbackEligible(new Error('File not found'))).toBe(false);
    expect(mod.isFileInputFallbackEligible(new Error('Permission denied'))).toBe(false);
    expect(mod.isFileInputFallbackEligible(new Error('Detached while handling command'))).toBe(false);
    expect(mod.isFileInputFallbackEligible(new Error('Debugger is not attached to the tab'))).toBe(false);
    expect(mod.isFileInputFallbackEligible(new Error('CDP command DOM.setFileInputFiles timed out after 60s'))).toBe(false);
  });

  it('rejects -32000 errors that are NOT about input reference resolution', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    // -32000 is the generic CDP error code; without a resolution-related
    // keyword the predicate stays strict so we do not wait 8 seconds for an
    // unrelated failure (e.g. file-not-found at the protocol level).
    expect(mod.isFileInputFallbackEligible(new Error('-32000 No such file'))).toBe(false);
  });

  it('rejects empty / non-string error messages', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    expect(mod.isFileInputFallbackEligible(new Error(''))).toBe(false);
    expect(mod.isFileInputFallbackEligible('plain string')).toBe(false);
    expect(mod.isFileInputFallbackEligible(null)).toBe(false);
  });

  // The big regression: chrome.debugger surfaces protocol rejections as raw
  // `{ code, message }` objects. Passing those through `String(err)` yields
  // `'[object Object]'`, so a message-only predicate silently breaks and
  // the fallback never runs. The new code path must key off `.code` directly.
  it('accepts raw CDP {code, message} object form (the chatgpt-agent regression)', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    expect(mod.isFileInputFallbackEligible({ code: -32000, message: 'Not allowed' })).toBe(true);
    expect(mod.isFileInputFallbackEligible({ code: -32000, message: 'Invalid parameters' })).toBe(true);
    expect(mod.isFileInputFallbackEligible({ code: -32000, message: 'Object reference could not be resolved' })).toBe(true);
  });

  it('accepts raw CDP object with code only (no message) — robust to Chrome omitting strings', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    expect(mod.isFileInputFallbackEligible({ code: -32000 })).toBe(true);
    expect(mod.isFileInputFallbackEligible({ code: -32000, message: '' })).toBe(true);
  });

  it('rejects raw CDP objects with unrelated error codes', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    expect(mod.isFileInputFallbackEligible({ code: -32601, message: 'Method not found' })).toBe(false);
    expect(mod.isFileInputFallbackEligible({ code: -32001, message: 'No such file' })).toBe(false);
  });

  it('rejects Error that carries code -32000 with unrelated message (no resolution keyword)', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    // normalizeCdpError stamps .code on the wrapped Error; the code-only
    // short-circuit must still fire even when the message lacks the
    // resolution keyword.
    const err = new Error('No such file');
    (err as Error & { code?: unknown }).code = -32000;
    expect(mod.isFileInputFallbackEligible(err)).toBe(true);
  });
});

describe('cdp normalizeCdpError', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('preserves an Error instance unchanged (preserves stack trace)', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    const err = new Error('boom');
    expect(mod.normalizeCdpError(err)).toBe(err);
  });

  it('keeps an Error that already carries a .code field', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    const err = new Error('boom');
    (err as Error & { code?: unknown }).code = -32000;
    const out = mod.normalizeCdpError(err);
    expect(out).toBe(err);
    expect((out as Error & { code?: unknown }).code).toBe(-32000);
  });

  it('turns a raw {code, message} object into an Error with both fields in the message', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    const out = mod.normalizeCdpError({ code: -32000, message: 'Not allowed' });
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('-32000 Not allowed');
    expect((out as Error & { code?: unknown }).code).toBe(-32000);
  });

  it('handles a raw object with only code (no message)', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    const out = mod.normalizeCdpError({ code: -32000 });
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('-32000');
    expect((out as Error & { code?: unknown }).code).toBe(-32000);
  });

  it('handles a raw object with only message (no code)', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    const out = mod.normalizeCdpError({ message: 'Not allowed' });
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('Not allowed');
    expect((out as Error & { code?: unknown }).code).toBeUndefined();
  });

  it('serializes data when neither code nor message are present', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    const out = mod.normalizeCdpError({ data: { reason: 'no-input' } });
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('{"reason":"no-input"}');
  });

  it('falls back to a JSON dump for objects without any of code/message/data', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    const out = mod.normalizeCdpError({ weird: true });
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('{"weird":true}');
  });

  it('handles string primitives', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    expect(mod.normalizeCdpError('just a string').message).toBe('just a string');
  });

  it('handles null / undefined', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    expect(mod.normalizeCdpError(null)).toBeInstanceOf(Error);
    expect(mod.normalizeCdpError(undefined)).toBeInstanceOf(Error);
  });
});

describe('cdp setFileInputFiles', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  /**
   * Build a chrome.debugger mock that returns scripted CDP responses per
   * method.
   *
   * `fileInputState` controls what `document.querySelector(...)` in the
   * page returns: 'file' = real file input, 'missing' = no element,
   * 'button' = a non-file element.
   *
   * `directResult` controls what the first DOM.setFileInputFiles call
   * returns/throws:
   *   - undefined           → success (default)
   *   - { throw: new Error('-32000 Not allowed') }
   *   - { throw: { code: -32000, message: 'Not allowed' } }  (raw CDP object)
   *   - { throw: new Error('File not found') } (transport / lifecycle)
   *
   * `nodeId` controls what DOM.querySelector returns (default 12345).
   * `nodeIdSetFileResult` is the throwable for the second DOM.setFileInputFiles
   * call (the nodeId fallback), defaulting to success.
   *
   * `describeNodeResult` is the throwable for DOM.describeNode; default null
   * (success, returns backendNodeId 4242).
   */
  function createFileInputMock(opts: {
    fileInputState?: 'file' | 'missing' | 'button';
    directResult?: { throw?: unknown } | null;
    nodeId?: number | null;
    nodeIdMissing?: boolean;
    nodeIdSetFileResult?: { throw?: unknown } | null;
    describeNodeResult?: { throw?: unknown } | null;
  } = {}) {
    const state = {
      fileInputState: opts.fileInputState ?? 'file',
      directResult: opts.directResult === undefined ? null : opts.directResult,
      nodeId: opts.nodeId ?? 12345,
      nodeIdMissing: opts.nodeIdMissing ?? false,
      nodeIdSetFileResult: opts.nodeIdSetFileResult === undefined ? null : opts.nodeIdSetFileResult,
      describeNodeResult: opts.describeNodeResult ?? null,
    };
    const onEventListeners: Array<(source: { tabId?: number }, method: string, params: any) => void> = [];
    const calls: Array<{ method: string; params?: unknown }> = [];
    const onEventApi = {
      addListener: vi.fn((fn) => { onEventListeners.push(fn); }),
      removeListener: vi.fn((fn) => {
        const idx = onEventListeners.indexOf(fn);
        if (idx >= 0) onEventListeners.splice(idx, 1);
      }),
    };
    const setFileCalls = { count: 0 };
    const debuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target: unknown, method: string, params?: any) => {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          if (state.fileInputState === 'missing') {
            if (params?.returnByValue) return { result: { value: { ok: false, reason: 'not-found' } } };
            return { result: { type: 'null' } };
          }
          if (state.fileInputState === 'button') {
            if (params?.returnByValue) return { result: { value: { ok: false, reason: 'not-file-input', tag: 'BUTTON', type: 'submit' } } };
            return { result: { type: 'object', subtype: 'node', objectId: 'fake-object-id', className: 'HTMLButtonElement' } };
          }
          if (params?.returnByValue) return { result: { value: { ok: true } } };
          return { result: { type: 'object', subtype: 'node', objectId: 'fake-object-id', className: 'HTMLInputElement' } };
        }
        if (method === 'DOM.describeNode') {
          if (state.describeNodeResult) {
            throw state.describeNodeResult.throw;
          }
          return { node: { backendNodeId: 4242 } };
        }
        if (method === 'DOM.getDocument') {
          return { root: { nodeId: 1 } };
        }
        if (method === 'DOM.querySelector') {
          if (state.nodeIdMissing) return { nodeId: 0 };
          return { nodeId: state.nodeId };
        }
        if (method === 'DOM.setFileInputFiles') {
          setFileCalls.count += 1;
          if (setFileCalls.count === 1) {
            // First call: direct path (with objectId+backendNodeId).
            if (state.directResult) throw state.directResult.throw;
            return {};
          }
          // Second call: nodeId fallback.
          if (state.nodeIdSetFileResult) throw state.nodeIdSetFileResult.throw;
          return {};
        }
        if (method === 'Runtime.releaseObject') {
          return {};
        }
        return {};
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: onEventApi,
    };
    const tabs = {
      get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://example.com' })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    };
    const fireEvent = (method: string, params: any) => {
      for (const fn of onEventListeners) fn({ tabId: 1 }, method, params);
    };
    return {
      chrome: { tabs, debugger: debuggerApi, scripting: {}, runtime: { id: 'opencli-test' } },
      calls,
      fireEvent,
      state,
      setFileCalls,
    };
  }

  it('uses the direct CDP path with objectId + backendNodeId on the happy path', async () => {
    const mock = createFileInputMock();
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await mod.setFileInputFiles(1, ['/tmp/upload.bin']);

    const setFile = mock.calls.find((c) => c.method === 'DOM.setFileInputFiles');
    expect(setFile?.params).toMatchObject({
      files: ['/tmp/upload.bin'],
      objectId: 'fake-object-id',
      backendNodeId: 4242,
    });
    // No Page-domain chooser was armed on the happy path — the entire
    // Page.setInterceptFileChooserDialog surface is gone.
    expect(mock.calls.some((c) => c.method === 'Page.setInterceptFileChooserDialog')).toBe(false);
    expect(mock.calls.some((c) => c.method === 'Page.fileChooserOpened')).toBe(false);
    // nodeId fallback must not have been reached.
    expect(mock.calls.some((c) => c.method === 'DOM.getDocument')).toBe(false);
    expect(mock.calls.some((c) => c.method === 'DOM.querySelector')).toBe(false);
    // objectId is released best-effort.
    const release = mock.calls.filter((c) => c.method === 'Runtime.releaseObject');
    expect(release.length).toBeGreaterThanOrEqual(1);
    expect(release.some((c) => (c.params as { objectId?: string })?.objectId === 'fake-object-id')).toBe(true);
  });

  it('throws the legacy "No element found matching selector: <query>" message when the selector misses', async () => {
    const mock = createFileInputMock({ fileInputState: 'missing' });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await expect(mod.setFileInputFiles(1, ['/tmp/upload.bin'], '#missing-file'))
      .rejects.toThrow('No element found matching selector: #missing-file');
  });

  it('throws a precise not-file-input error when the selector matches a non-file element', async () => {
    const mock = createFileInputMock({ fileInputState: 'button' });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await expect(mod.setFileInputFiles(1, ['/tmp/upload.bin'], 'button.submit'))
      .rejects.toThrow(/selector "button\.submit" matched <BUTTON type="submit">, expected HTMLInputElement\[type=file\]/);
    // The nodeId fallback must not be armed for a validation failure.
    expect(mock.calls.some((c) => c.method === 'DOM.getDocument')).toBe(false);
    expect(mock.calls.some((c) => c.method === 'DOM.querySelector')).toBe(false);
  });

  it('falls back to nodeId when the direct path rejects as Error(-32000 Not allowed)', async () => {
    const mock = createFileInputMock({
      directResult: { throw: new Error('-32000 Not allowed') },
      nodeId: 9876,
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await mod.setFileInputFiles(1, ['/tmp/upload.bin']);

    const setFileCalls = mock.calls.filter((c) => c.method === 'DOM.setFileInputFiles');
    expect(setFileCalls).toHaveLength(2);
    // Direct call carried objectId + backendNodeId.
    expect(setFileCalls[0].params).toMatchObject({
      objectId: 'fake-object-id',
      backendNodeId: 4242,
      files: ['/tmp/upload.bin'],
    });
    // Fallback call carried a bare nodeId, no objectId / backendNodeId.
    expect(setFileCalls[1].params).toEqual({
      files: ['/tmp/upload.bin'],
      nodeId: 9876,
    });
    expect((setFileCalls[1].params as Record<string, unknown>).objectId).toBeUndefined();
    expect((setFileCalls[1].params as Record<string, unknown>).backendNodeId).toBeUndefined();

    // DOM.getDocument + DOM.querySelector were used for the fallback, no
    // Page.setInterceptFileChooserDialog was ever armed.
    expect(mock.calls.some((c) => c.method === 'DOM.getDocument')).toBe(true);
    expect(mock.calls.some((c) => c.method === 'DOM.querySelector')).toBe(true);
    expect(mock.calls.some((c) => c.method === 'Page.setInterceptFileChooserDialog')).toBe(false);
    expect(mock.calls.some((c) => c.method === 'Page.fileChooserOpened')).toBe(false);
  });

  // The headline regression: chrome.debugger surfaces protocol rejections as
  // raw `{ code, message }` objects, NOT Error instances. String() of those
  // yields `'[object Object]'`, which previously caused the predicate to
  // reject and the fallback to silently never run. This test must pass with
  // the new normalization-based predicate.
  it('falls back to nodeId when the direct path rejects as RAW CDP {code:-32000, message:"Not allowed"} object', async () => {
    const mock = createFileInputMock({
      directResult: { throw: { code: -32000, message: 'Not allowed' } },
      nodeId: 7777,
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await mod.setFileInputFiles(1, ['/tmp/upload.bin']);

    const setFileCalls = mock.calls.filter((c) => c.method === 'DOM.setFileInputFiles');
    expect(setFileCalls).toHaveLength(2);
    expect(setFileCalls[1].params).toEqual({
      files: ['/tmp/upload.bin'],
      nodeId: 7777,
    });
  });

  it('falls back to nodeId when DOM.describeNode rejects with a protocol-resolution error', async () => {
    const mock = createFileInputMock({
      describeNodeResult: { throw: { code: -32000, message: 'Object reference could not be resolved' } },
      nodeId: 5555,
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await mod.setFileInputFiles(1, ['/tmp/upload.bin']);

    const setFileCalls = mock.calls.filter((c) => c.method === 'DOM.setFileInputFiles');
    expect(setFileCalls).toHaveLength(1); // direct never reached; fallback only
    expect(setFileCalls[0].params).toEqual({ files: ['/tmp/upload.bin'], nodeId: 5555 });
  });

  it('still surfaces the original transport error when the direct path fails for non-eligible reasons', async () => {
    const mock = createFileInputMock({
      directResult: { throw: new Error('File not found') },
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await expect(mod.setFileInputFiles(1, ['/tmp/missing.bin']))
      .rejects.toThrow('File not found');

    // The nodeId fallback must NEVER run for a transport / lifecycle failure.
    expect(mock.calls.some((c) => c.method === 'DOM.getDocument')).toBe(false);
    expect(mock.calls.some((c) => c.method === 'DOM.querySelector')).toBe(false);
    expect(mock.calls.filter((c) => c.method === 'DOM.setFileInputFiles')).toHaveLength(1);
    // No chooser / page interaction ever.
    expect(mock.calls.some((c) => c.method === 'Page.setInterceptFileChooserDialog')).toBe(false);
  });

  it('surfaces the original transport error when DOM.describeNode fails for non-eligible reasons', async () => {
    const mock = createFileInputMock({
      describeNodeResult: { throw: new Error('Debugger is not attached to the tab') },
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await expect(mod.setFileInputFiles(1, ['/tmp/upload.bin']))
      .rejects.toThrow('Debugger is not attached');

    expect(mock.calls.some((c) => c.method === 'DOM.getDocument')).toBe(false);
    expect(mock.calls.some((c) => c.method === 'Page.setInterceptFileChooserDialog')).toBe(false);
  });

  it('reports BOTH direct and nodeId failures when both paths reject', async () => {
    const mock = createFileInputMock({
      directResult: { throw: new Error('-32000 Not allowed') },
      nodeIdSetFileResult: { throw: new Error('-32000 Object reference could not be resolved') },
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await expect(mod.setFileInputFiles(1, ['/tmp/upload.bin']))
      .rejects.toThrow(/direct CDP path failed.*nodeId fallback.*also failed/);

    // No chooser surface in any failure branch.
    expect(mock.calls.some((c) => c.method === 'Page.setInterceptFileChooserDialog')).toBe(false);
    expect(mock.calls.some((c) => c.method === 'Page.fileChooserOpened')).toBe(false);
  });

  it('preserves the selector-miss contract on the fallback path (Instagram post.js grep)', async () => {
    const mock = createFileInputMock({
      directResult: { throw: new Error('-32000 Not allowed') },
      nodeIdMissing: true,
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await expect(mod.setFileInputFiles(1, ['/tmp/upload.bin'], '#opencli-upload'))
      .rejects.toThrow('No element found matching selector: #opencli-upload');
  });

  it('releases the direct-path objectId before falling back (no leaked Runtime remote)', async () => {
    const mock = createFileInputMock({
      directResult: { throw: new Error('-32000 Not allowed') },
      nodeId: 8888,
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await mod.setFileInputFiles(1, ['/tmp/upload.bin']);

    // Order matters: Runtime.releaseObject for the direct-path objectId
    // must fire BEFORE the fallback DOM.setFileInputFiles, otherwise the
    // inspector session keeps the remote alive through both paths.
    const releaseIdx = mock.calls.findIndex((c) => c.method === 'Runtime.releaseObject');
    const fallbackIdx = mock.calls.findIndex(
      (c, i) => c.method === 'DOM.setFileInputFiles' && i > releaseIdx,
    );
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(fallbackIdx).toBeGreaterThan(releaseIdx);
    expect((mock.calls[releaseIdx].params as { objectId?: string })?.objectId).toBe('fake-object-id');
  });

  it('never arms Page.setInterceptFileChooserDialog across happy/fallback/failure paths', async () => {
    const cases: Array<ReturnType<typeof createFileInputMock>> = [
      createFileInputMock(),
      createFileInputMock({ directResult: { throw: new Error('-32000 Not allowed') }, nodeId: 1 }),
      createFileInputMock({ directResult: { throw: { code: -32000, message: 'Not allowed' } }, nodeId: 2 }),
      createFileInputMock({
        directResult: { throw: new Error('-32000 Not allowed') },
        nodeIdSetFileResult: { throw: new Error('still failing') },
      }),
    ];
    for (const mock of cases) {
      vi.stubGlobal('chrome', mock.chrome);
      const mod = await import('./cdp');
      try { await mod.setFileInputFiles(1, ['/tmp/upload.bin']); } catch { /* expected on the failure case */ }
      expect(mock.calls.some((c) => c.method === 'Page.setInterceptFileChooserDialog')).toBe(false);
      expect(mock.calls.some((c) => c.method === 'Page.fileChooserOpened')).toBe(false);
    }
  });

  it('forwards the original selector to the fallback DOM.querySelector', async () => {
    const mock = createFileInputMock({
      directResult: { throw: new Error('-32000 Not allowed') },
      nodeId: 4321,
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    await mod.setFileInputFiles(1, ['/tmp/upload.bin'], 'form#login input[type="file"]');

    const queried = mock.calls.find((c) => c.method === 'DOM.querySelector');
    expect(queried?.params).toMatchObject({
      nodeId: 1,
      selector: 'form#login input[type="file"]',
    });
  });
});
