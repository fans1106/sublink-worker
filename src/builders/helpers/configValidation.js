import { InvalidConfigError } from '../../services/errors.js';
import { entryName, normalizeSurgeGroup } from './configOverrides.js';

const fail = message => { throw new InvalidConfigError(message); };
const list = value => value === undefined ? [] : Array.isArray(value) ? value : fail('Expected a config array');
const refs = value => value === undefined ? [] : Array.isArray(value) ? value : [value];

function uniqueEntries(entries, label) {
    const names = new Set();
    entries.forEach(entry => {
        const name = entryName(entry);
        if (!name || names.has(name)) fail(`Invalid or duplicate ${label}: ${name ?? '(unnamed)'}`);
        names.add(name);
    });
    return names;
}

function requireReference(names, reference, label) {
    if (reference !== undefined && !names.has(reference)) fail(`Unknown ${label}: ${reference}`);
}

function checkCycles(graph, label) {
    const visited = new Set();
    const visiting = new Set();
    const visit = name => {
        if (visiting.has(name)) fail(`Circular ${label} reference: ${name}`);
        if (visited.has(name)) return;
        visiting.add(name);
        (graph.get(name) ?? []).forEach(visit);
        visiting.delete(name);
        visited.add(name);
    };
    graph.forEach((_, name) => visit(name));
}

function visitRules(rules, callback) {
    list(rules).forEach(rule => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('Expected a rule object');
        callback(rule);
        if (rule.rules !== undefined) visitRules(rule.rules, callback);
    });
}

function splitRule(rule) {
    if (typeof rule !== 'string') fail('Expected a rule string');
    let depth = 0;
    let start = 0;
    const fields = [];
    for (let index = 0; index < rule.length; index++) {
        if (rule[index] === '(') depth++;
        if (rule[index] === ')') depth--;
        if (rule[index] === ',' && depth === 0) {
            fields.push(rule.slice(start, index).trim());
            start = index + 1;
        }
    }
    fields.push(rule.slice(start).trim());
    return fields;
}

export function validateConfigReferences(config, format, version) {
    const singbox = format === 'singbox';
    const surge = format === 'surge';
    const nodes = list(singbox ? config.outbounds : config.proxies)
        .filter(node => typeof node !== 'string' || !node.trimStart().startsWith('#'));
    const groups = singbox ? [] : list(config['proxy-groups']).map(group => surge ? normalizeSurgeGroup(group) : group);
    const names = uniqueEntries([...nodes, ...groups], 'proxy/group name');
    if (!singbox) ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'].forEach(name => names.add(name));
    const providers = singbox
        ? uniqueEntries(list(config.outbound_providers), 'provider tag')
        : new Set(Object.keys(config['proxy-providers'] ?? {}));
    const graph = new Map();
    [...nodes, ...groups].forEach(entry => {
        const name = entryName(entry);
        if (typeof entry !== 'string' && !entry?.type) fail(`Missing proxy/group type: ${name}`);
        const group = singbox ? ['selector', 'urltest'].includes(entry.type) : groups.includes(entry);
        const members = group ? list(singbox ? entry.outbounds : entry.proxies) : [];
        const uses = group ? list(singbox ? entry.providers : entry.use) : [];
        uses.forEach(provider => requireReference(providers, provider, 'proxy provider'));
        if (group && members.length === 0 && uses.length === 0 && !(surge && entry['policy-path'])) {
            fail(`Empty proxy group: ${name}`);
        }
        members.forEach(member => {
            // Remote provider members are only known when the client downloads the provider.
            if (uses.length === 0) requireReference(names, member, 'proxy/group');
        });
        const detour = typeof entry === 'string'
            ? entry.match(/(?:,\s*)underlying-proxy=([^,]+)/)?.[1]?.trim()
            : singbox ? entry.detour : entry['dialer-proxy'];
        requireReference(names, detour, 'proxy detour');
        graph.set(name, [...members.filter(member => names.has(member)), ...refs(detour)]);
    });
    checkCycles(graph, 'proxy/group');

    if (!singbox) {
        const ruleProviders = new Set(Object.keys(config['rule-providers'] ?? {}));
        list(config.rules).forEach(rule => {
            if (typeof rule === 'string' && rule.trimStart().startsWith('#')) return;
            const fields = splitRule(rule);
            if (fields.length < 2) fail(`Invalid rule: ${rule}`);
            const target = [...fields].reverse().find(field => !['no-resolve', 'extended-matching', 'pre-matching'].includes(field));
            requireReference(names, target, 'rule target');
            if (!surge && fields[0] === 'RULE-SET') requireReference(ruleProviders, fields[1], 'rule provider');
        });
        return;
    }

    const ruleSets = uniqueEntries(list(config.route?.rule_set), 'rule-set tag');
    const validateRule = rule => {
        requireReference(names, rule.outbound, 'rule outbound');
        refs(rule.rule_set).forEach(tag => requireReference(ruleSets, tag, 'rule-set'));
    };
    visitRules(config.route?.rules, validateRule);
    requireReference(names, config.route?.final, 'route final');
    const servers = list(config.dns?.servers);
    const dnsNames = uniqueEntries(servers, 'DNS server tag');
    requireReference(dnsNames, config.dns?.final, 'DNS final');
    const resolverName = resolver => typeof resolver === 'object' ? resolver?.server : resolver;
    requireReference(dnsNames, resolverName(config.route?.default_domain_resolver), 'DNS resolver');
    const dnsGraph = new Map();
    servers.forEach(server => {
        if (version === '1.11' && server.type !== undefined) fail('sing-box 1.11 requires legacy DNS servers with address');
        if (version !== '1.11' && (server.address !== undefined || !server.type)) fail('sing-box 1.12+ requires typed DNS servers');
        const resolver = resolverName(server.domain_resolver ?? server.address_resolver);
        requireReference(dnsNames, resolver, 'DNS resolver');
        requireReference(names, server.detour, 'DNS detour');
        dnsGraph.set(server.tag, refs(resolver));
    });
    checkCycles(dnsGraph, 'DNS');
    visitRules(config.dns?.rules, rule => {
        validateRule(rule);
        requireReference(dnsNames, rule.server, 'DNS rule server');
    });
    const httpClients = uniqueEntries(list(config.http_clients), 'HTTP client tag');
    if (version !== '1.14' && (httpClients.size || config.route?.default_http_client !== undefined)) {
        fail('HTTP clients require sing-box 1.14+');
    }
    requireReference(httpClients, config.route?.default_http_client, 'HTTP client');
    list(config.http_clients).forEach(client => requireReference(names, client.detour, 'HTTP client detour'));
    list(config.route?.rule_set).forEach(ruleSet => {
        requireReference(names, ruleSet.download_detour, 'rule-set download detour');
        requireReference(httpClients, ruleSet.http_client, 'rule-set HTTP client');
    });
    nodes.forEach(node => requireReference(dnsNames, resolverName(node.domain_resolver), 'outbound DNS resolver'));
    list(config.inbounds).forEach(inbound => requireReference(dnsNames, resolverName(inbound.domain_resolver), 'inbound DNS resolver'));
    requireReference(names, config.ntp?.detour, 'NTP detour');
    requireReference(names, config.experimental?.clash_api?.external_ui_download_detour, 'UI download detour');
    list(config.outbound_providers).forEach(provider => requireReference(names, provider.download_detour, 'provider download detour'));
    if (version === '1.11' && providers.size) fail('Outbound providers require sing-box 1.12+');
}
