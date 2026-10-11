import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { createSubscriptionFetcher } from '../src/services/subscriptionCache.js';
import { decodeBase64, encodeBase64 } from '../src/utils.js';

const remoteUrl = 'https://airport.example.com/sub?token=abc';
const proxyUri = (name) => `ss://YWVzLTEyOC1nY206cGFzcw@example.com:443#${name}`;
const routes = [['clash', 'c'], ['singbox', 'b'], ['surge', 's'], ['xray', 'x']];

function conversionUrl(route, config = remoteUrl) {
    const url = new URL(`/${route}`, 'http://localhost');
    url.searchParams.set('config', config);
    url.searchParams.set('ua', 'cache-test-agent');
    return url;
}

function mockSubscription() {
    let name = 'Before';
    const fetchMock = vi.fn(async () => new Response(encodeBase64(proxyUri(name)), {
        headers: { 'subscription-userinfo': `download=${name === 'Before' ? 100 : 200}` }
    }));
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, update: () => { name = 'After'; } };
}

async function responseContent(response, route) {
    const text = await response.text();
    return route === 'xray' ? decodeBase64(text) : text;
}

describe('subscription cache routes', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each(routes)('caches and refreshes %s conversions', async (route) => {
        const { fetchMock, update } = mockSubscription();
        const app = createApp({ kv: new MemoryKVAdapter() });
        const url = conversionUrl(route);
        const first = await app.request(url.href);
        expect(first.status).toBe(200);
        expect(first.headers.get('subscription-userinfo')).toBe('download=100');
        expect(await responseContent(first, route)).toContain('Before');
        update();
        url.searchParams.set('refresh', 'false');
        const cached = await app.request(url.href);
        expect(await responseContent(cached, route)).toContain('Before');
        expect(fetchMock).toHaveBeenCalledTimes(1);

        url.searchParams.set('refresh', 'true');
        const refreshed = await app.request(url.href);
        expect(refreshed.status).toBe(200);
        expect(refreshed.headers.get('Cache-Control')).toBe('no-store');
        expect(refreshed.headers.get('subscription-userinfo')).toBe('download=200');
        const content = await responseContent(refreshed, route);
        expect(content).toContain('After');
        if (route === 'surge') {
            const managedUrl = new URL(content.match(/^#!MANAGED-CONFIG (\S+)/)[1]);
            expect(managedUrl.searchParams.has('refresh')).toBe(false);
            expect(managedUrl.searchParams.get('config')).toBe(remoteUrl);
        }
        url.searchParams.delete('refresh');
        expect(await responseContent(await app.request(url.href), route)).toContain('After');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.every(([url]) => url === remoteUrl)).toBe(true);
    });

    it('shares upstream content across formats and app instances using the same KV', async () => {
        const { fetchMock } = mockSubscription();
        const kv = new MemoryKVAdapter();
        for (const [route] of routes) {
            const app = createApp({ kv });
            const response = await app.request(conversionUrl(route).href);
            expect(response.status).toBe(200);
            expect(await responseContent(response, route)).toContain('Before');
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(routes)('refreshes %s through /%s/ short links', async (route, prefix) => {
        const { fetchMock, update } = mockSubscription();
        const kv = new MemoryKVAdapter();
        const app = createApp({ kv });
        const original = conversionUrl(route);
        // Existing links may contain refresh from before it became a per-visit option.
        await kv.put('example', `${original.search}&refresh=true`);
        const plain = await app.request(`http://localhost/${prefix}/example`);
        const plainUrl = new URL(plain.headers.get('Location'));
        expect(plainUrl.searchParams.has('refresh')).toBe(false);
        await app.request(plainUrl.href);
        update();

        const redirect = await app.request(`http://localhost/${prefix}/example?refresh=true&config=ignored`);
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get('Cache-Control')).toBe('no-store');
        const target = new URL(redirect.headers.get('Location'));
        expect(target.pathname).toBe(`/${route}`);
        expect(target.searchParams.get('refresh')).toBe('true');
        expect(target.searchParams.get('config')).toBe(remoteUrl);
        expect(await responseContent(await app.request(target.href), route)).toContain('After');
        expect(await responseContent(await app.request(plainUrl.href), route)).toContain('After');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(await kv.get('example')).toBe(`${original.search}&refresh=true`);

        const noRefresh = await app.request(`http://localhost/${prefix}/example?refresh=false`);
        expect(new URL(noRefresh.headers.get('Location')).searchParams.get('refresh')).toBe('false');
    });

    it('does not persist refresh when creating a short link', async () => {
        const kv = new MemoryKVAdapter();
        const app = createApp({ kv });
        const original = conversionUrl('clash');
        original.searchParams.set('refresh', 'true');
        const response = await app.request(`http://localhost/shorten-v2?url=${encodeURIComponent(original.href)}&shortCode=example`);
        expect(response.status).toBe(200);
        const params = new URLSearchParams(await kv.get('example'));
        expect(params.has('refresh')).toBe(false);
        expect(params.get('config')).toBe(remoteUrl);
        expect(params.get('ua')).toBe('cache-test-agent');
    });

    it.each([undefined, 'true', 'false'])('resolves short links with the current refresh option: %s', async (refresh) => {
        const kv = new MemoryKVAdapter();
        const app = createApp({ kv });
        await kv.put('example', `${conversionUrl('clash').search}&refresh=true`);
        const shortUrl = new URL('/c/example', 'http://localhost');
        if (refresh !== undefined) shortUrl.searchParams.set('refresh', refresh);
        const response = await app.request(`http://localhost/resolve?url=${encodeURIComponent(shortUrl.href)}`);
        expect(response.status).toBe(200);
        const target = new URL((await response.json()).originalUrl);
        expect(target.searchParams.get('refresh')).toBe(refresh ?? null);
        expect(target.searchParams.get('config')).toBe(remoteUrl);
    });

    it('propagates refresh to nested HTTP subscriptions parsed through ProxyParser', async () => {
        const nestedUrl = 'https://airport.example.com/nested?token=def';
        let name = 'Before';
        const fetchMock = vi.fn(async (url) => new Response(url === remoteUrl ? nestedUrl : proxyUri(name)));
        vi.stubGlobal('fetch', fetchMock);
        const kv = new MemoryKVAdapter();
        const app = createApp({ kv });
        const url = conversionUrl('singbox');
        expect((await app.request(url.href)).status).toBe(200);
        expect((await createSubscriptionFetcher({ kv })(nestedUrl, 'cache-test-agent')).text).toContain('Before');
        name = 'After';
        expect((await app.request(url.href)).status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        url.searchParams.set('refresh', 'true');
        expect((await app.request(url.href)).status).toBe(200);
        expect((await createSubscriptionFetcher({ kv })(nestedUrl, 'cache-test-agent')).text).toContain('After');
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('deduplicates repeated URLs even during a hard refresh', async () => {
        const { fetchMock } = mockSubscription();
        const app = createApp({ kv: new MemoryKVAdapter() });
        const url = conversionUrl('clash', `${remoteUrl}\n${remoteUrl}`);
        url.searchParams.set('refresh', 'true');
        const response = await app.request(url.href);
        expect(response.status).toBe(200);
        expect(await responseContent(response, 'clash')).toContain('Before');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
