import { generateWebPath } from '../utils.js';
import { MissingDependencyError } from './errors.js';

export class ShortLinkService {
    constructor(kv, options = {}) {
        this.kv = kv;
        this.options = options;
    }

    ensureKv() {
        if (!this.kv) {
            throw new MissingDependencyError('Short link service requires a KV store');
        }
        return this.kv;
    }

    async createShortLink(queryString, providedCode) {
        const kv = this.ensureKv();
        const shortCode = providedCode || generateWebPath();
        const ttl = this.options.shortLinkTtlSeconds;
        const putOptions = ttl ? { expirationTtl: ttl } : undefined;
        await kv.put(shortCode, normalizeShortLinkQuery(queryString), putOptions);
        return shortCode;
    }

    async resolveShortCode(code) {
        const kv = this.ensureKv();
        return kv.get(code);
    }
}

export function normalizeShortLinkQuery(queryString, refresh) {
    const params = new URLSearchParams(queryString);
    // Refresh belongs to the current visit, including for previously stored short links.
    params.delete('refresh');
    if (refresh !== undefined) {
        params.set('refresh', refresh);
    }
    const query = params.toString();
    return query ? `?${query}` : '';
}
