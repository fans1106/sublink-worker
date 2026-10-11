import { createHash } from 'node:crypto';

const SUBSCRIPTION_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const UPSTREAM_USER_AGENT = 'curl/7.74.0';

export async function fetchSubscriptionContent(url, { refresh = false } = {}) {
    // Stable upstream responses let clients share a snapshot without forwarding their UA.
    const headers = new Headers({ 'User-Agent': UPSTREAM_USER_AGENT });
    if (refresh) {
        headers.set('Cache-Control', 'no-cache');
    }
    const response = await fetch(url, { method: 'GET', headers });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return {
        text: await response.text(),
        subscriptionUserinfo: response.headers.get('subscription-userinfo') || undefined
    };
}

export function createSubscriptionFetcher({ kv = null, logger = console, refresh = false } = {}) {
    // Keep deduplication local to a conversion so refresh cannot reuse another request's fetch.
    const requests = new Map();

    async function load(url) {
        // UA-dependent snapshots must not become the source for the shared URL cache.
        const key = kv ? `subscription:v2:${createHash('sha256').update(url).digest('hex')}` : null;
        if (kv && !refresh) {
            try {
                const stored = await kv.get(key);
                if (stored !== null) {
                    const cached = JSON.parse(stored);
                    if (typeof cached?.text === 'string' &&
                        Number.isFinite(cached.expiresAt) && cached.expiresAt > Date.now() &&
                        (cached.subscriptionUserinfo === undefined || typeof cached.subscriptionUserinfo === 'string')) {
                        return { text: cached.text, subscriptionUserinfo: cached.subscriptionUserinfo };
                    }
                }
            } catch {
                logger.warn('Failed to read subscription cache');
            }
        }

        const result = await fetchSubscriptionContent(url, { refresh });
        if (kv) {
            try {
                // The timestamp also rejects legacy snapshots and stale KV reads after expiry.
                const cached = { ...result, expiresAt: Date.now() + SUBSCRIPTION_CACHE_TTL_SECONDS * 1000 };
                await kv.put(key, JSON.stringify(cached), { expirationTtl: SUBSCRIPTION_CACHE_TTL_SECONDS });
            } catch {
                logger.warn('Failed to write subscription cache');
            }
        }
        return result;
    }

    return (url) => {
        const trimmedUrl = url.trim();
        if (!requests.has(trimmedUrl)) {
            requests.set(trimmedUrl, load(trimmedUrl));
        }
        return requests.get(trimmedUrl);
    };
}

