import { InvalidPayloadError } from '../services/errors.js';

const MAX_LINKS = 8;
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

    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sources) || !Array.isArray(parsed.links)) {
        throw new InvalidPayloadError('Invalid chain parameter structure');
    }
    if (parsed.links.length === 0 || parsed.links.length > MAX_LINKS) {
        throw new InvalidPayloadError(`Chain links must contain between 1 and ${MAX_LINKS} items`);
    }

    const lines = String(inputString || '').split(/\r?\n/);
    const sources = parsed.sources.map((source, index) => {
        const id = typeof source?.id === 'string' ? source.id.trim() : '';
        const line = source?.line;
        if (!id || !Number.isInteger(line) || line < 0 || line >= lines.length) {
            throw new InvalidPayloadError(`Invalid chain source at index ${index}`);
        }

        const value = lines[line].trim();
        if (!CHAIN_SOURCE_PATTERN.test(value)) {
            throw new InvalidPayloadError(`Chain source ${id} must reference a subscription or proxy URI line`);
        }

        return {
            id,
            line,
            value,
            label: normalizeLabel(source.label, getDefaultLabel(value, line))
        };
    });

    const sourceMap = new Map();
    sources.forEach(source => {
        if (sourceMap.has(source.id)) {
            throw new InvalidPayloadError(`Duplicate chain source id: ${source.id}`);
        }
        sourceMap.set(source.id, source);
    });

    const seenLinks = new Set();
    const entries = new Set();
    const exits = new Set();
    const links = parsed.links.map((link, index) => {
        const entry = sourceMap.get(link?.entry);
        const exit = sourceMap.get(link?.exit);
        if (!entry || !exit || entry.id === exit.id) {
            throw new InvalidPayloadError(`Invalid chain link at index ${index}`);
        }

        const key = `${entry.id}\0${exit.id}`;
        if (seenLinks.has(key)) {
            throw new InvalidPayloadError(`Duplicate chain link: ${entry.id} -> ${exit.id}`);
        }
        seenLinks.add(key);
        entries.add(entry.id);
        exits.add(exit.id);
        return { entry, exit };
    });

    for (const id of entries) {
        if (exits.has(id)) {
            throw new InvalidPayloadError('Multi-hop chain links are not supported');
        }
    }

    return { version: 1, sources, links };
}
