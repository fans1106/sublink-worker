import { InvalidPayloadError } from '../services/errors.js';

const MAX_LABEL_LENGTH = 40;
const CHAIN_SOURCE_PATTERN = /^(ss|vmess|vless|hysteria|hysteria2|hy2|trojan|tuic|anytls|https?):\/\//i;

function normalizeLabel(value, fallback) {
    const label = typeof value === 'string' ? value.trim() : '';
    const normalized = (label || fallback).replace(/[=,\r\n]/g, ' ').trim();
    if (!normalized) {
        throw new InvalidPayloadError('Chain source label must not be empty');
    }
    return normalized.slice(0, MAX_LABEL_LENGTH);
}

function getDefaultLabel(value, line) {
    const scheme = value.split('://', 1)[0].toUpperCase();
    if (/^https?:\/\//i.test(value)) {
        try {
            return new URL(value).hostname || `Source ${line + 1}`;
        } catch {
            throw new InvalidPayloadError(`Chain source at line ${line + 1} references an invalid URL`);
        }
    }

    const fragment = value.includes('#') ? value.slice(value.lastIndexOf('#') + 1) : '';
    if (fragment) {
        try {
            return decodeURIComponent(fragment);
        } catch { }
    }
    return `${scheme} ${line + 1}`;
}

export function parseChainConfig(raw, inputString) {
    if (!raw) return null;

    let parsed;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        throw new InvalidPayloadError('Invalid chain parameter: expected JSON');
    }

    // Old subscription links still identify the OUT source through their single link.
    if (parsed?.version === 1 && Array.isArray(parsed.sources) && Array.isArray(parsed.links)) {
        if (parsed.links.length !== 1) {
            throw new InvalidPayloadError('Chain config supports a single OUT source');
        }
        const link = parsed.links[0];
        const entry = parsed.sources.find(source => source?.id === link?.entry);
        const exit = parsed.sources.find(source => source?.id === link?.exit);
        if (!entry || !exit || entry.id === exit.id || entry.line === exit.line) {
            throw new InvalidPayloadError('Invalid chain link');
        }
        parsed = { version: 2, exit };
    }
    if (!parsed || parsed.version !== 2 || !parsed.exit) {
        throw new InvalidPayloadError('Invalid chain parameter structure');
    }

    const lines = String(inputString || '').split(/\r?\n/);
    const { line, label } = parsed.exit;
    if (!Number.isInteger(line) || line < 0 || line >= lines.length) {
        throw new InvalidPayloadError('Invalid chain OUT source line');
    }
    const value = lines[line].trim();
    if (!CHAIN_SOURCE_PATTERN.test(value)) {
        throw new InvalidPayloadError('Chain OUT must reference a subscription or proxy URI line');
    }
    const exit = { id: 'exit', line, value, label: normalizeLabel(label, getDefaultLabel(value, line)) };
    return { version: 2, sources: [exit], exit };
}
