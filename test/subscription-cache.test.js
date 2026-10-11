import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubscriptionFetcher } from '../src/services/subscriptionCache.js';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { fetchSubscription, fetchSubscriptionWithFormat } from '../src/parsers/subscription/httpSubscriptionFetcher.js';
import { ProxyParser } from '../src/parsers/ProxyParser.js';
import { createHash } from 'node:crypto';

const url = 'https://airport.example.com/sub?token=secret';
const ua = 'test-agent';
const userinfo = 'upload=123; download=456; total=1024; expire=1893456000';
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

function mockFetch() {
    const fetchMock = vi.fn(async () => new Response('original content', {
        headers: { 'subscription-userinfo': userinfo }
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('subscription cache', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('retains content and userinfo for seven days without extending expiration on reads', async () => {
        const kv = new MemoryKVAdapter();
        const put = vi.spyOn(kv, 'put');
        const fetchMock = mockFetch();
        const expiresAt = Date.now() + sevenDaysMs;
        const first = await createSubscriptionFetcher({ kv })(url, ua);
        vi.advanceTimersByTime(sevenDaysMs - 1);
        const second = await createSubscriptionFetcher({ kv })(url, ua);

        expect(second).toEqual(first);
        expect(second).toEqual({ text: 'original content', subscriptionUserinfo: userinfo });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(put).toHaveBeenCalledTimes(1);
        expect(put).toHaveBeenCalledWith(
            expect.stringMatching(/^subscription:v2:[a-f0-9]{64}$/),
            JSON.stringify({ ...first, expiresAt }),
            { expirationTtl: 604800 }
        );
    });

    it('fetches and caches fresh content at the seven-day expiration boundary', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        await createSubscriptionFetcher({ kv })(url, ua);
        fetchMock.mockResolvedValueOnce(new Response('updated content'));
        vi.advanceTimersByTime(sevenDaysMs);

        expect((await createSubscriptionFetcher({ kv })(url, ua)).text).toBe('updated content');
        expect((await createSubscriptionFetcher({ kv })(url, ua)).text).toBe('updated content');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects expired snapshots even when KV still returns them', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        await createSubscriptionFetcher({ kv })(url, ua);
        const [key] = kv.store.keys();
        await kv.put(key, JSON.stringify({ text: 'expired content', expiresAt: Date.now() - 1 }));

        expect((await createSubscriptionFetcher({ kv })(url, ua)).text).toBe('original content');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rebuilds legacy snapshots without expiration metadata', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        await createSubscriptionFetcher({ kv })(url, ua);
        const [key] = kv.store.keys();
        await kv.put(key, JSON.stringify({ text: 'legacy content', subscriptionUserinfo: userinfo }));

        expect((await createSubscriptionFetcher({ kv })(url, ua)).text).toBe('original content');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(await kv.get(key)).expiresAt).toBe(Date.now() + sevenDaysMs);
        expect(kv.expirations.get(key).expireAt).toBe(Date.now() + sevenDaysMs);
    });

    it('isolates full URLs while sharing cached content across caller user agents', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        await createSubscriptionFetcher({ kv })(url, ua);
        await createSubscriptionFetcher({ kv })(url.replace('secret', 'other'), ua);
        await createSubscriptionFetcher({ kv })(url, 'different-agent');
        await createSubscriptionFetcher({ kv })(` ${url} `, ` ${ua} `);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(kv.store.size).toBe(2);
        expect(fetchMock.mock.calls.every(([, options]) => options.headers.get('User-Agent') === 'curl/7.74.0')).toBe(true);
    });

    it('does not fall back to previous UA-specific snapshots', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        const oldHash = createHash('sha256').update(JSON.stringify([url, ua])).digest('hex');
        await kv.put(`subscription:v1:${oldHash}`, JSON.stringify({
            text: 'UA-specific content',
            expiresAt: Date.now() + sevenDaysMs
        }), { expirationTtl: 604800 });

        expect((await createSubscriptionFetcher({ kv })(url, ua)).text).toBe('original content');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['subscription parser', fetchSubscription],
        ['format detector', fetchSubscriptionWithFormat],
        ['protocol dispatcher', (url, ua) => ProxyParser.parse(url, ua)]
    ])('uses the fixed UA without a cache loader in the %s', async (_name, parse) => {
        const fetchMock = mockFetch();
        await parse(url, 'mihomo/1.19.0');
        await parse(url, 'sing-box/1.14.0');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.every(([, options]) => options.headers.get('User-Agent') === 'curl/7.74.0')).toBe(true);
    });

    it('refreshes without reading the old snapshot and deduplicates within a request', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        await createSubscriptionFetcher({ kv })(url, ua);
        const get = vi.spyOn(kv, 'get');
        fetchMock.mockResolvedValueOnce(new Response('updated content'));
        const refresh = createSubscriptionFetcher({ kv, refresh: true });
        const results = await Promise.all([refresh(url, ua), refresh(url, 'different-agent')]);

        expect(results.map(result => result.text)).toEqual(['updated content', 'updated content']);
        expect(get).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][1].headers.get('Cache-Control')).toBe('no-cache');
        expect(fetchMock.mock.calls[1][1].headers.get('User-Agent')).toBe('curl/7.74.0');
        expect(await createSubscriptionFetcher({ kv })(url, ua)).toEqual({ text: 'updated content' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('starts a new seven-day lifetime after a successful refresh', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        await createSubscriptionFetcher({ kv })(url, ua);
        vi.advanceTimersByTime(sevenDaysMs - 1000);
        fetchMock.mockResolvedValueOnce(new Response('refreshed content'));
        await createSubscriptionFetcher({ kv, refresh: true })(url, ua);
        vi.advanceTimersByTime(sevenDaysMs - 1);

        expect((await createSubscriptionFetcher({ kv })(url, ua)).text).toBe('refreshed content');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(1);
        expect((await createSubscriptionFetcher({ kv })(url, ua)).text).toBe('original content');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each(['http', 'network', 'body'])('preserves the old snapshot on %s refresh failures', async (failure) => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        const original = await createSubscriptionFetcher({ kv })(url, ua);
        const [key] = kv.store.keys();
        const expiresAt = kv.expirations.get(key).expireAt;
        vi.advanceTimersByTime(1000);
        if (failure === 'http') {
            fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
        } else if (failure === 'network') {
            fetchMock.mockRejectedValueOnce(new Error('network failure'));
        } else {
            fetchMock.mockResolvedValueOnce({ ok: true, text: async () => { throw new Error('body failure'); } });
        }

        await expect(createSubscriptionFetcher({ kv, refresh: true })(url, ua)).rejects.toThrow();
        expect(await createSubscriptionFetcher({ kv })(url, ua)).toEqual(original);
        expect(kv.expirations.get(key).expireAt).toBe(expiresAt);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed first fetch', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));

        await expect(createSubscriptionFetcher({ kv })(url, ua)).rejects.toThrow('503');
        expect(kv.store.size).toBe(0);
        expect((await createSubscriptionFetcher({ kv })(url, ua)).text).toBe('original content');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(['invalid JSON', '{"text":123}', '{"text":"old","subscriptionUserinfo":false}'])('replaces corrupted cache: %s', async (stored) => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        const logger = { warn: vi.fn() };
        await createSubscriptionFetcher({ kv })(url, ua);
        const [key] = kv.store.keys();
        await kv.put(key, stored);

        expect((await createSubscriptionFetcher({ kv, logger })(url, ua)).text).toBe('original content');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(await kv.get(key)).subscriptionUserinfo).toBe(userinfo);
    });

    it.each(['get', 'put'])('keeps fetching available when KV %s fails', async (operation) => {
        const kv = new MemoryKVAdapter();
        vi.spyOn(kv, operation).mockRejectedValue(new Error('KV unavailable'));
        const logger = { warn: vi.fn() };
        mockFetch();

        expect((await createSubscriptionFetcher({ kv, logger })(url, ua)).text).toBe('original content');
        expect(logger.warn).toHaveBeenCalled();
    });

    it('deduplicates without KV while fetching again on the next conversion', async () => {
        const fetchMock = mockFetch();
        const fetcher = createSubscriptionFetcher();
        await Promise.all([fetcher(url, ua), fetcher(url, ua)]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await createSubscriptionFetcher()(url, ua);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
