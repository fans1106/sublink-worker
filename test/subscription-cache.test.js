import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubscriptionFetcher } from '../src/services/subscriptionCache.js';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';

const url = 'https://airport.example.com/sub?token=secret';
const ua = 'test-agent';
const userinfo = 'upload=123; download=456; total=1024; expire=1893456000';

function mockFetch() {
    const fetchMock = vi.fn(async () => new Response('original content', {
        headers: { 'subscription-userinfo': userinfo }
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('subscription cache', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('retains content and userinfo across requests without expiration', async () => {
        const kv = new MemoryKVAdapter();
        const put = vi.spyOn(kv, 'put');
        const fetchMock = mockFetch();
        const first = await createSubscriptionFetcher({ kv })(url, ua);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 24 * 60 * 60 * 1000);
        const second = await createSubscriptionFetcher({ kv })(url, ua);

        expect(second).toEqual(first);
        expect(second).toEqual({ text: 'original content', subscriptionUserinfo: userinfo });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(put).toHaveBeenCalledWith(expect.stringMatching(/^subscription:v1:[a-f0-9]{64}$/), JSON.stringify(first));
        expect(kv.expirations.size).toBe(0);
    });

    it('isolates full URLs and effective user agents', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        await createSubscriptionFetcher({ kv })(url, ua);
        await createSubscriptionFetcher({ kv })(url.replace('secret', 'other'), ua);
        await createSubscriptionFetcher({ kv })(url, 'different-agent');
        await createSubscriptionFetcher({ kv })(` ${url} `, ` ${ua} `);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(kv.store.size).toBe(3);
    });

    it('refreshes without reading the old snapshot and deduplicates within a request', async () => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        await createSubscriptionFetcher({ kv })(url, ua);
        const get = vi.spyOn(kv, 'get');
        fetchMock.mockResolvedValueOnce(new Response('updated content'));
        const refresh = createSubscriptionFetcher({ kv, refresh: true });
        const results = await Promise.all([refresh(url, ua), refresh(url, ua)]);

        expect(results.map(result => result.text)).toEqual(['updated content', 'updated content']);
        expect(get).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][1].headers.get('Cache-Control')).toBe('no-cache');
        expect(await createSubscriptionFetcher({ kv })(url, ua)).toEqual({ text: 'updated content' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(['http', 'network', 'body'])('preserves the old snapshot on %s refresh failures', async (failure) => {
        const kv = new MemoryKVAdapter();
        const fetchMock = mockFetch();
        const original = await createSubscriptionFetcher({ kv })(url, ua);
        if (failure === 'http') {
            fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
        } else if (failure === 'network') {
            fetchMock.mockRejectedValueOnce(new Error('network failure'));
        } else {
            fetchMock.mockResolvedValueOnce({ ok: true, text: async () => { throw new Error('body failure'); } });
        }

        await expect(createSubscriptionFetcher({ kv, refresh: true })(url, ua)).rejects.toThrow();
        expect(await createSubscriptionFetcher({ kv })(url, ua)).toEqual(original);
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
