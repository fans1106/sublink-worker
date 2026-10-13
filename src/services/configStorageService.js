import { assertConfigObject } from '../builders/helpers/configOverrides.js';
import yaml from 'js-yaml';
import { generateWebPath } from '../utils.js';
import { parseSurgeConfigInput } from '../utils/surgeConfigParser.js';
import { InvalidPayloadError, MissingDependencyError } from './errors.js';

const pendingConfigWrites = new WeakMap();
const orderedConfigPaths = new Set(['dns.nameserver-policy', 'dns.proxy-server-nameserver-policy']);

function canonicalJson(value, path = '') {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, `${path}[]`)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        // Mihomo can select different resolvers when policy keys are reordered.
        const keys = Object.keys(value);
        if (!orderedConfigPaths.has(path)) keys.sort();
        return `{${keys.map(key => {
            const field = key.endsWith('!') ? key.slice(0, -1) : key;
            return `${JSON.stringify(key)}:${canonicalJson(value[key], path ? `${path}.${field}` : field)}`;
        }).join(',')}}`;
    }
    return JSON.stringify(value);
}

async function contentConfigId(type, content) {
    const subtle = globalThis.crypto?.subtle ?? (await import('node:crypto')).webcrypto.subtle;
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(content));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return `${type}_${hash}`;
}

async function putConfigIfMissing(kv, id, content, options) {
    let pending = pendingConfigWrites.get(kv);
    if (!pending) {
        pending = new Map();
        pendingConfigWrites.set(kv, pending);
    }
    if (pending.has(id)) return pending.get(id);

    // KV has no compare-and-set; coalesce local requests to avoid concurrent writes to one key.
    const write = (async () => {
        if (await kv.get(id) == null) await kv.put(id, content, options);
    })();
    pending.set(id, write);
    try {
        await write;
    } finally {
        pending.delete(id);
        if (pending.size === 0) pendingConfigWrites.delete(kv);
    }
}

export class ConfigStorageService {
    constructor(kv, options = {}) {
        this.kv = kv;
        this.options = options;
    }

    ensureKv() {
        if (!this.kv) {
            throw new MissingDependencyError('Config storage requires a KV store');
        }
        return this.kv;
    }

    async getConfigById(configId) {
        const kv = this.ensureKv();
        const stored = await kv.get(configId);
        if (!stored) return null;
        try {
            return JSON.parse(stored);
        } catch {
            throw new InvalidPayloadError('Stored config is not valid JSON');
        }
    }

    async saveConfig(type, content, existingId) {
        if (!type) {
            throw new InvalidPayloadError('Missing config type');
        }

        const kv = this.ensureKv();
        const configString = this.serializeConfig(type, content);

        // Validate string is JSON before storing
        const parsed = JSON.parse(configString);
        if (type === 'preset') {
            const configId = existingId || `${type}_${generateWebPath(8)}`;
            await kv.put(configId, configString, undefined);
            return configId;
        }

        assertConfigObject(parsed);
        const canonicalContent = canonicalJson(parsed);
        const configId = await contentConfigId(type, canonicalContent);

        const ttlSeconds = this.options.configTtlSeconds;
        const putOptions = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
        await putConfigIfMissing(kv, configId, canonicalContent, putOptions);
        return configId;
    }

    async deleteConfigById(configId) {
        await this.ensureKv().delete(configId);
    }

    serializeConfig(type, content) {
        if (type === 'surge' && typeof content === 'string') {
            try {
                return JSON.stringify(parseSurgeConfigInput(content).configObject);
            } catch (error) {
                throw new InvalidPayloadError(`Invalid Surge config: ${error.message}`);
            }
        }
        if (type === 'clash') {
            if (typeof content === 'string' && (content.trim().startsWith('-') || content.includes(':'))) {
                const yamlConfig = yaml.load(content);
                return JSON.stringify(yamlConfig);
            }
            return typeof content === 'object' ? JSON.stringify(content) : content;
        }

        if (typeof content === 'object') {
            return JSON.stringify(content);
        }
        if (typeof content === 'string') {
            return content;
        }
        throw new InvalidPayloadError('Unsupported config content type');
    }
}
