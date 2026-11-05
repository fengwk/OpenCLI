import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';

import {
    extractDouyinVideoId,
    MAX_SEARCH_LIMIT,
    normalizeDouyinVideoUrl,
    parseDouyinCount,
    parseSearchLimit,
    parseSearchTimeout,
    projectCard,
    projectSearchCards,
} from './search.js';

const command = getRegistry().get('douyin/search');

describe('search command timeout', () => {
    let dom;

    afterEach(() => {
        dom?.window.close();
        dom = undefined;
        vi.useRealTimers();
    });

    function browserPage(text = '') {
        dom = new JSDOM('<body></body>');
        const { document } = dom.window;
        document.body.textContent = text;
        Object.defineProperty(document.body, 'innerText', { get() { return this.textContent; } });
        return {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(script => Function(
                'document', 'HTMLElement', 'getComputedStyle', `return (${script})`,
            )(
                document, dom.window.HTMLElement, dom.window.getComputedStyle.bind(dom.window),
            )),
        };
    }

    function renderResult() {
        dom.window.document.body.innerHTML = '<ul data-e2e="scroll-list"><li>'
            + '<a href="/video/7704361492980385467"><span>搜索结果文案</span>'
            + '<span>@</span><span>作者</span></a></li></ul>';
    }

    it('accepts results rendered after 15 seconds within the single command budget', async () => {
        // Run the actual browser script: the former 15s timer would reject this page.
        vi.useFakeTimers();
        const page = browserPage();
        page.goto.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 20_000)));
        let settled = false;
        const pending = command.func(page, { query: '测试', limit: 1, timeout: 120 });
        pending.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(20_000);
        await vi.advanceTimersByTimeAsync(16_000);
        expect(settled).toBe(false);
        renderResult();
        await vi.advanceTimersByTimeAsync(500);
        await expect(pending).resolves.toMatchObject([{ desc: '搜索结果文案', author: '作者' }]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('counts navigation against the same budget and stops polling on timeout', async () => {
        // 20s navigation leaves 10s, not another full 30s; failure must stop browser work.
        vi.useFakeTimers();
        const page = browserPage();
        page.goto.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 20_000)));
        const pending = command.func(page, { query: '测试', timeout: 30 }).catch(error => error);
        await vi.advanceTimersByTimeAsync(29_999);
        let settled = false;
        pending.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ code: 'TIMEOUT' });
        expect(vi.getTimerCount()).toBe(0);
        const callsAtTimeout = page.evaluate.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(page.evaluate).toHaveBeenCalledTimes(callsAtTimeout);
    });

    it('returns already-rendered cards without scheduling a wait', async () => {
        // Warm pages should still complete on the first read.
        vi.useFakeTimers();
        const page = browserPage();
        renderResult();
        await expect(command.func(page, { query: '测试', timeout: 120 })).resolves.toHaveLength(1);
        expect(page.evaluate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not read the page if navigation has exhausted the budget', async () => {
        // A late navigation must not start another wait after the command has expired.
        vi.useFakeTimers();
        const page = browserPage();
        page.goto.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1_100)));
        const pending = command.func(page, { query: '测试', timeout: 1 }).catch(error => error);
        await vi.advanceTimersByTimeAsync(1_100);
        expect(await pending).toMatchObject({ code: 'TIMEOUT' });
        expect(page.evaluate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not report success for a browser response arriving after the deadline', async () => {
        // A slow round-trip must not turn an expired search into a late success or another poll.
        vi.useFakeTimers();
        const page = browserPage();
        renderResult();
        const read = page.evaluate.getMockImplementation();
        page.evaluate.mockImplementation(async script => {
            await new Promise(resolve => setTimeout(resolve, 1_100));
            return read(script);
        });
        const pending = command.func(page, { query: '测试', timeout: 1 }).catch(error => error);
        await vi.advanceTimersByTimeAsync(1_100);
        expect(await pending).toMatchObject({ code: 'TIMEOUT' });
        expect(page.evaluate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        ['请先登录', 'AUTH_REQUIRED'],
        ['请完成安全校验', 'AUTH_REQUIRED'],
        ['暂无相关搜索结果', 'EMPTY_RESULT'],
    ])('still exits immediately for %s', async (text, code) => {
        // A longer budget must not hide terminal login/empty states behind a wait.
        vi.useFakeTimers();
        const page = browserPage(text);
        await expect(command.func(page, { query: '测试', timeout: 120 })).rejects.toMatchObject({ code });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('validates the single timeout before browser navigation', async () => {
        // Invalid values must not create timers or navigate a user tab.
        const page = browserPage();
        expect(parseSearchTimeout(undefined)).toBe(120);
        await expect(command.func(page, { query: '测试', timeout: 0 })).rejects.toThrow('--timeout');
        expect(page.goto).not.toHaveBeenCalled();
    });
});

describe('douyin search', () => {
    it('rejects limit above MAX_SEARCH_LIMIT', () => {
        expect(() => parseSearchLimit(MAX_SEARCH_LIMIT + 1)).toThrow(/--limit/);
    });

});

describe('parseDouyinCount', () => {
    it.each([
        ['1.9万', 19_000],
        ['3万', 30_000],
        ['4702', 4702],
        ['1,234', 1234],
        ['1.2亿', 120_000_000],
        ['', 0],
        ['unknown', 0],
        [null, 0],
        [undefined, 0],
    ])('parses %j as %i', (input, expected) => {
        expect(parseDouyinCount(input)).toBe(expected);
    });
});

describe('normalizeDouyinVideoUrl', () => {
    it.each([
        ['//www.douyin.com/video/123', 'https://www.douyin.com/video/123'],
        ['/video/123?foo=bar', 'https://www.douyin.com/video/123'],
        ['https://www.douyin.com/video/123?something', 'https://www.douyin.com/video/123'],
        ['https://evil.test/video/123', ''],
        ['https://www.douyin.com/user/video/123', ''],
        ['', ''],
        [null, ''],
    ])('normalizes %j → %j', (input, expected) => {
        expect(normalizeDouyinVideoUrl(input)).toBe(expected);
    });

    it('extracts only stable Douyin video ids', () => {
        expect(extractDouyinVideoId('https://www.douyin.com/video/123')).toBe('123');
        expect(extractDouyinVideoId('//www.douyin.com/video/456')).toBe('456');
        expect(extractDouyinVideoId('https://evil.test/video/123')).toBe('');
    });
});

describe('projectCard', () => {
    it('extracts duration/likes/desc/author by leaf-text shape, classname-agnostic', () => {
        const row = projectCard({
            url: '//www.douyin.com/video/7585120459717365001',
            leafTexts: ['合集', '03:55', '1.9万', 'Python邪修', '@', '校长', '5月前'],
        }, 0);
        expect(row).toEqual({
            rank: 1,
            desc: 'Python邪修',
            author: '校长',
            url: 'https://www.douyin.com/video/7585120459717365001',
            plays: 0,
            likes: 19000,
            comments: 0,
            shares: 0,
        });
    });

    it('returns the longest non-skipped text as desc, not the publish-date suffix', () => {
        const row = projectCard({
            url: '/video/1',
            leafTexts: ['02:00', '4702', 'hi long-text', '@', 'user', '1月前'],
        }, 0);
        expect(row.desc).toBe('hi long-text');
        expect(row.author).toBe('user');
    });

    it('strips a fused @author prefix from the desc when present', () => {
        const row = projectCard({
            url: '/video/1',
            leafTexts: ['02:00', '100', '@alice this is the caption', '@', 'alice'],
        }, 0);
        expect(row.author).toBe('alice');
        expect(row.desc).toBe('this is the caption');
    });

    it('returns safe defaults when leafTexts is missing', () => {
        const row = projectCard({ url: '/video/42', leafTexts: undefined }, 4);
        expect(row).toEqual({
            rank: 5,
            desc: '',
            author: '',
            url: 'https://www.douyin.com/video/42',
            plays: 0,
            likes: 0,
            comments: 0,
            shares: 0,
        });
    });

    it('returns rank=index+1 regardless of input', () => {
        const row = projectCard({ url: '/video/1', leafTexts: ['x'] }, 9);
        expect(row.rank).toBe(10);
    });

    it('projects cards and reports malformed rows in the returned window', () => {
        const result = projectSearchCards([
            { url: '/video/1', leafTexts: ['caption'] },
            { url: '/video/not-numeric', leafTexts: ['bad'] },
            { url: '/video/3', leafTexts: [] },
        ], 3);
        expect(result.rows).toHaveLength(1);
        expect(result.invalidCount).toBe(2);
    });

    it('does not treat metadata-only leaf text as a stable desc', () => {
        const result = projectSearchCards([
            { url: '/video/1', leafTexts: ['合集', '03:55', '1.9万', '@', '校长', '5月前'] },
        ], 1);
        expect(result.rows).toHaveLength(0);
        expect(result.invalidCount).toBe(1);
    });
});
