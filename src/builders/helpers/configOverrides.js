import { InvalidConfigError } from '../../services/errors.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const namedPaths = new Set(['proxies', 'proxy-groups', 'outbounds', 'inbounds', 'dns.servers', 'route.rule_set', 'outbound_providers', 'http_clients']);

export function assertConfigObject(config) {
    if (!isObject(config)) throw new InvalidConfigError('Base config must be an object');
}

export function entryName(entry) {
    return typeof entry === 'string' ? entry.split('=')[0].trim() : entry?.name ?? entry?.tag;
}

export function normalizeSurgeGroup(group) {
    if (typeof group !== 'string') return group;
    const index = group.indexOf('=');
    if (index < 1) throw new InvalidConfigError(`Invalid Surge group: ${group}`);
    const [type, ...parts] = group.slice(index + 1).split(',').map(value => value.trim());
    const result = { name: group.slice(0, index).trim(), type, proxies: [] };
    parts.forEach(part => {
        const equals = part.indexOf('=');
        if (equals < 0) result.proxies.push(part);
        else result[part.slice(0, equals).trim()] = part.slice(equals + 1).trim();
    });
    return result;
}

function cloneConfig(value) {
    if (Array.isArray(value)) return value.map(cloneConfig);
    if (!isObject(value)) return value;
    const result = {};
    Object.entries(value).forEach(([key, item]) => {
        if (unsafeKeys.has(key)) throw new InvalidConfigError(`Unsafe config key: ${key}`);
        result[key] = cloneConfig(item);
    });
    return result;
}

export function mergeConfig(base, patch, path = '', format) {
    if (Array.isArray(patch)) {
        if (!namedPaths.has(path)) return patch.map(item => mergeConfig(undefined, item, `${path}[]`, format));
        const result = Array.isArray(base) ? base.map(cloneConfig) : [];
        const seen = new Set();
        patch.forEach(rawEntry => {
            const entry = format === 'surge' && path === 'proxy-groups' ? normalizeSurgeGroup(rawEntry) : rawEntry;
            if (!(format === 'surge' && path === 'proxies') && !isObject(entry)) {
                throw new InvalidConfigError(`Expected an object in ${path}`);
            }
            if (format === 'surge' && path === 'proxies' && (typeof entry !== 'string' || (!entry.includes('=') && !entry.trimStart().startsWith('#')))) {
                throw new InvalidConfigError('Surge proxies must be INI strings');
            }
            const name = entryName(entry);
            if (!name || seen.has(name)) throw new InvalidConfigError(`Invalid or duplicate name in ${path}: ${name ?? '(unnamed)'}`);
            seen.add(name);
            const index = result.findIndex(item => entryName(item) === name);
            if (index < 0) result.push(mergeConfig(undefined, entry, `${path}[]`, format));
            else {
                const previous = format === 'surge' && path === 'proxy-groups' ? normalizeSurgeGroup(result[index]) : result[index];
                // A new type has a different schema; retaining old fields breaks client validation.
                const changedType = entry?.type !== undefined && previous?.type !== entry.type;
                result[index] = mergeConfig(changedType ? undefined : previous, entry, `${path}[]`, format);
            }
        });
        return result;
    }
    if (!isObject(patch)) return patch;
    const result = {};
    if (isObject(base)) Object.keys(base).forEach(key => {
        if (unsafeKeys.has(key)) throw new InvalidConfigError(`Unsafe config key: ${key}`);
        result[key] = cloneConfig(base[key]);
    });
    Object.entries(patch).forEach(([key, value]) => {
        if (unsafeKeys.has(key)) throw new InvalidConfigError(`Unsafe config key: ${key}`);
        if (key.endsWith('!') && isObject(value)) {
            const targetKey = key.slice(0, -1);
            if (!targetKey || unsafeKeys.has(targetKey)) throw new InvalidConfigError(`Unsafe config key: ${key}`);
            result[targetKey] = cloneConfig(value);
            return;
        }
        result[key] = mergeConfig(result[key], value, path ? `${path}.${key}` : key, format);
    });
    return result;
}

function clientPatch(overrides, format) {
    // Replacement markers must survive until the patch meets the generated config.
    const patch = cloneConfig(overrides);
    delete patch['prepend-rules'];
    delete patch['append-rules'];
    if (format === 'singbox' && patch.route) {
        delete patch.route['prepend-rules'];
        delete patch.route['append-rules'];
    }
    return patch;
}

export function initializeConfig(defaults, overrides, format) {
    if (overrides != null) {
        assertConfigObject(overrides);
        const arrays = format === 'singbox'
            ? ['outbounds', 'inbounds', 'outbound_providers', 'http_clients']
            : ['proxies', 'proxy-groups', 'rules'];
        arrays.push('prepend-rules', 'append-rules');
        arrays.forEach(key => {
            if (overrides[key] !== undefined && !Array.isArray(overrides[key])) throw new InvalidConfigError(`${key} must be an array`);
        });
        const objects = format === 'singbox' ? ['dns', 'route', 'experimental'] : format === 'surge' ? ['general', 'replica'] : ['dns', 'proxy-providers', 'rule-providers'];
        objects.forEach(key => {
            if (overrides[key] !== undefined && !isObject(overrides[key])) throw new InvalidConfigError(`${key} must be an object`);
        });
        if (format === 'singbox') {
            for (const [section, fields] of [['dns', ['servers', 'rules']], ['route', ['rules', 'rule_set', 'prepend-rules', 'append-rules']]]) {
                fields.forEach(key => {
                    if (overrides[section]?.[key] !== undefined && !Array.isArray(overrides[section][key])) throw new InvalidConfigError(`${section}.${key} must be an array`);
                });
            }
        }
    }
    const patch = clientPatch(overrides ?? {}, format);
    // Generated names must exist before group patches can target them without causing renaming.
    delete patch.proxies;
    delete patch['proxy-groups'];
    delete patch.outbounds;
    delete patch.rules;
    delete patch['rule-providers'];
    if (patch['proxy-providers']) {
        patch['proxy-providers'] = Object.fromEntries(Object.entries(patch['proxy-providers']).filter(([, provider]) => provider?.url !== undefined || provider?.path !== undefined || provider?.payload !== undefined));
    }
    if (patch.outbound_providers) {
        patch.outbound_providers = patch.outbound_providers.filter(provider => provider?.download_url !== undefined || provider?.path !== undefined);
    }
    if (patch.route) {
        delete patch.route.rules;
        delete patch.route.rule_set;
    }
    return mergeConfig(defaults, patch, '', format);
}

export function mergeNodeOverrides(config, overrides, format) {
    const key = format === 'singbox' ? 'outbounds' : 'proxies';
    const nodes = (overrides?.[key] ?? []).filter(entry => {
        if (format !== 'singbox') return true;
        return entry?.server !== undefined || (config.outbounds || []).some(node => node.tag === entry.tag);
    });
    config[key] = mergeConfig(config[key] ?? [], nodes, key, format);
}

export function applyConfigOverrides(config, overrides, format) {
    const source = overrides ?? {};
    const result = mergeConfig(config, clientPatch(source, format), '', format);
    const target = format === 'singbox' ? result.route : result;
    const ruleSource = format === 'singbox' ? source.route ?? {} : source;
    const prepend = ruleSource['prepend-rules'] ?? source['prepend-rules'] ?? [];
    const append = ruleSource['append-rules'] ?? source['append-rules'] ?? [];
    if (!Array.isArray(prepend) || !Array.isArray(append) || !Array.isArray(target?.rules)) {
        throw new InvalidConfigError('rules, prepend-rules and append-rules must be arrays');
    }
    const rules = [...target.rules];
    const fallbackIndex = format === 'singbox' ? -1 : rules.findIndex(rule => /^(MATCH|FINAL),/.test(rule));
    rules.splice(fallbackIndex < 0 ? rules.length : fallbackIndex, 0, ...append);
    target.rules = [...prepend, ...rules];
    return result;
}
