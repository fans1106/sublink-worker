import { createHash } from 'node:crypto';

export async function fetchSubscriptionContent(url, userAgent, { refresh = false } = {}) {
    const headers = new Headers();
    if (userAgent) {
        headers.set('User-Agent', userAgent);
    }
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

    async function load(url, userAgent, identity) {
        const key = kv ? `subscription:v1:${createHash('sha256').update(identity).digest('hex')}` : null;
        if (kv && !refresh) {
            try {
                const stored = await kv.get(key);
                if (stored !== null) {
                    const cached = JSON.parse(stored);
                    if (typeof cached?.text === 'string' &&
                        (cached.subscriptionUserinfo === undefined || typeof cached.subscriptionUserinfo === 'string')) {
                        return cached;
                    }
                }
            } catch {
                logger.warn('Failed to read subscription cache');
            }
        }

        const result = await fetchSubscriptionContent(url, userAgent, { refresh });
        if (kv) {
            try {
                // Subscription snapshots stay valid until an explicit refresh replaces them.
                await kv.put(key, JSON.stringify(result));
            } catch {
                logger.warn('Failed to write subscription cache');
            }
        }
        return result;
    }

    return (url, userAgent) => {
        const trimmedUrl = url.trim();
        const effectiveUserAgent = userAgent ? new Headers({ 'User-Agent': userAgent }).get('User-Agent') : '';
        const identity = JSON.stringify([trimmedUrl, effectiveUserAgent]);
        if (!requests.has(identity)) {
            requests.set(identity, load(trimmedUrl, effectiveUserAgent, identity));
        }
        return requests.get(identity);
    };
}

