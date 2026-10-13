import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';
import { SurgeConfigBuilder } from '../src/builders/SurgeConfigBuilder.js';
import { mergeConfig } from '../src/builders/helpers/configOverrides.js';
import { CLASH_CONFIG, SING_BOX_CONFIG } from '../src/config/index.js';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { createStableProviderName } from '../src/utils.js';
import { parseSurgeConfigInput } from '../src/utils/surgeConfigParser.js';
import { ShortLinkService } from '../src/services/shortLinkService.js';

const input = 'trojan://secret@node.example:443?security=tls#Node';
const createBuilder = (format, patch, options = {}) => {
    if (format === 'clash') return new ClashConfigBuilder(input, [], [], patch, 'zh-CN', null, false, false, options.controller);
    if (format === 'singbox') return new SingboxConfigBuilder(input, [], [], patch, 'zh-CN', null, false, false, options.controller, undefined, options.version ?? '1.12');
    return new SurgeConfigBuilder(input, [], [], patch, 'zh-CN', null, false);
};
const build = async (format, patch, options) => {
    const builder = createBuilder(format, patch, options);
    await builder.build();
    return builder;
};

describe('base config overrides', () => {
    it('preserves default DNS and generated fields with partial Clash settings', async () => {
        const patch = { 'log-level': 'warning', port: 0, dns: { ipv6: false, nameserver: ['https://dns.google/dns-query'] }, 'prepend-rules': ['DOMAIN-SUFFIX,example.com,DIRECT'] };
        const original = structuredClone(patch);
        const defaults = structuredClone(CLASH_CONFIG);
        const { config } = await build('clash', patch);
        expect(config.port).toBe(0);
        expect(config.dns.ipv6).toBe(false);
        expect(config.dns.nameserver).toEqual(patch.dns.nameserver);
        expect(config.dns['enhanced-mode']).toBe('fake-ip');
        expect(config.dns['nameserver-policy']).toEqual(CLASH_CONFIG.dns['nameserver-policy']);
        expect(config.proxies.some(proxy => proxy.name === 'Node')).toBe(true);
        expect(config.rules[0]).toBe('DOMAIN-SUFFIX,example.com,DIRECT');
        expect(config).not.toHaveProperty('prepend-rules');
        expect(patch).toEqual(original);
        expect(CLASH_CONFIG).toEqual(defaults);
    });

    it('replaces ordinary arrays with explicit empty arrays', async () => {
        const { config } = await build('clash', { dns: { nameserver: [] }, rules: [] });
        expect(config.dns.nameserver).toEqual([]);
        expect(config.rules).toEqual([]);
        expect(config['proxy-groups'].length).toBeGreaterThan(0);
    });

    it('replaces DNS policies with bang syntax and preserves priority through YAML output', async () => {
        const policies = {
            '+.bza.edu.cn': ['10.2.0.5'],
            ...CLASH_CONFIG.dns['nameserver-policy']
        };
        const patch = { dns: { 'nameserver-policy!': policies } };
        const original = structuredClone(patch);
        const defaults = structuredClone(CLASH_CONFIG);
        const builder = await build('clash', patch);
        const output = yaml.load(builder.formattedConfig);
        expect(Object.keys(output.dns['nameserver-policy'])).toEqual(Object.keys(policies));
        expect(output.dns['nameserver-policy']).toEqual(policies);
        expect(output.dns).not.toHaveProperty('nameserver-policy!');
        expect(output.dns.nameserver).toEqual(defaults.dns.nameserver);
        expect(output.dns['enhanced-mode']).toBe('fake-ip');
        expect(builder.formatConfig()).toBe(builder.formattedConfig);
        expect(patch).toEqual(original);
        expect(CLASH_CONFIG).toEqual(defaults);
    });

    it('clears object fields with empty replacement objects', async () => {
        const { config } = await build('clash', { dns: { 'nameserver-policy!': {} } });
        expect(config.dns['nameserver-policy']).toEqual({});
        expect(config.dns).not.toHaveProperty('nameserver-policy!');
        expect(config.dns.nameserver).toEqual(CLASH_CONFIG.dns.nameserver);
    });

    it('replaces an entire DNS object without retaining defaults', async () => {
        const dns = { enable: true, nameserver: ['10.2.0.5'] };
        const { config } = await build('clash', { 'dns!': dns });
        expect(config.dns).toEqual(dns);
        expect(config).not.toHaveProperty('dns!');
    });

    it('rejects unsafe replacement targets and keys inside replacement objects', () => {
        expect(() => mergeConfig({}, { 'constructor!': {} })).toThrow('Unsafe config key');
        expect(() => mergeConfig({}, JSON.parse('{"dns!":{"__proto__":{"polluted":true}}}'))).toThrow('Unsafe config key');
        expect({}.polluted).toBeUndefined();
    });

    it('merges named records, replaces changed types, and keeps empty named patches additive', () => {
        const defaults = { outbounds: [{ tag: 'A', type: 'selector', outbounds: ['DIRECT'], interrupt_exist_connections: false }] };
        expect(mergeConfig(defaults, { outbounds: [{ tag: 'A', outbounds: ['B'] }, { tag: 'B', type: 'direct' }] })).toEqual({ outbounds: [{ ...defaults.outbounds[0], outbounds: ['B'] }, { tag: 'B', type: 'direct' }] });
        expect(mergeConfig(defaults, { outbounds: [{ tag: 'A', type: 'direct' }] }).outbounds).toEqual([{ tag: 'A', type: 'direct' }]);
        expect(mergeConfig(defaults, { outbounds: [] })).toEqual(defaults);
    });

    it.each(['clash', 'singbox', 'surge'])('overrides generated groups after generation: %s', async format => {
        const group = format === 'singbox' ? { tag: '🚀 节点选择', outbounds: ['DIRECT'] } : { name: '🚀 节点选择', proxies: ['DIRECT'] };
        const patch = { [format === 'singbox' ? 'outbounds' : 'proxy-groups']: [group] };
        const builder = await build(format, patch);
        const groups = format === 'singbox' ? builder.config.outbounds : builder.config['proxy-groups'];
        expect(groups.find(item => (item.tag ?? item.name) === '🚀 节点选择')).toMatchObject(group);
        expect(groups.filter(item => (item.tag ?? item.name) === '🚀 节点选择')).toHaveLength(1);
        expect(format === 'singbox' ? groups[0].tag : builder.getGroupName?.(groups[0]) ?? groups[0].name).toBe('🚀 节点选择');
    });

    it.each(['clash', 'singbox'])('patches imported nodes and includes added nodes in generated selectors: %s', async format => {
        const nodes = format === 'clash'
            ? [{ name: 'Node', udp: false }, { name: 'Extra', type: 'trojan', server: 'extra.example', port: 443, password: 'p' }]
            : [{ tag: 'Node', tls: { insecure: true } }, { tag: 'Extra', type: 'trojan', server: 'extra.example', server_port: 443, password: 'p' }];
        const { config } = await build(format, { [format === 'clash' ? 'proxies' : 'outbounds']: nodes });
        const all = format === 'clash' ? config['proxy-groups'].find(group => group.name === '📋 全部节点') : config.outbounds.find(group => group.tag === '📋 全部节点');
        expect(all?.proxies ?? all?.outbounds).toContain('Extra');
        const node = (format === 'clash' ? config.proxies : config.outbounds).find(item => (item.name ?? item.tag) === 'Node');
        expect(node.server).toBe('node.example');
        expect(format === 'clash' ? node.udp : node.tls.insecure).toBe(format === 'clash' ? false : true);
    });

    it.each(['clash', 'singbox'])('overrides an automatic provider without reserving its name early: %s', async format => {
        const url = 'https://airport.example/sub';
        const name = createStableProviderName(url);
        const patch = format === 'clash'
            ? { 'proxy-providers': { [name]: { interval: 42 } } }
            : { outbound_providers: [{ tag: name, download_interval: '42m' }] };
        const builder = format === 'clash'
            ? new ClashConfigBuilder(url, [], [], patch, 'zh-CN')
            : new SingboxConfigBuilder(url, [], [], patch, 'zh-CN');
        const text = format === 'clash'
            ? yaml.dump({ proxies: [{ name: 'Remote', type: 'trojan', server: 'node.example', port: 443, password: 'p' }] })
            : JSON.stringify({ outbounds: [{ tag: 'Remote', type: 'trojan', server: 'node.example', server_port: 443, password: 'p' }] });
        await builder.build(async () => ({ text }));
        if (format === 'clash') {
            expect(Object.keys(builder.config['proxy-providers'])).toEqual([name]);
            expect(builder.config['proxy-providers'][name]).toMatchObject({ url, interval: 42 });
        } else {
            expect(builder.config.outbound_providers).toHaveLength(1);
            expect(builder.config.outbound_providers[0]).toMatchObject({ tag: name, download_url: url, download_interval: '42m' });
        }
        const first = structuredClone(builder.config);
        builder.formatConfig();
        expect(builder.config).toEqual(first);
    });

    it('changes a generated group type without retaining measurement fields', async () => {
        const builder = await build('clash', { 'proxy-groups': [{ name: '⚡ 普通自动选择', type: 'select', proxies: ['DIRECT'] }] });
        expect(builder.config['proxy-groups'].find(group => group.name === '⚡ 普通自动选择')).toEqual({ name: '⚡ 普通自动选择', type: 'select', proxies: ['DIRECT'] });
    });

    it('preserves Surge additional sections and adds rules from INI', async () => {
        const { configObject } = parseSurgeConfigInput('[prepend-rules]\nDOMAIN,first.example,DIRECT\n[append-rules]\nDOMAIN,last.example,DIRECT\n[Host]\nexample.com = 1.2.3.4');
        const builder = await build('surge', configObject);
        expect(builder.config.rules[0]).toBe('DOMAIN,first.example,DIRECT');
        expect(builder.config.rules.at(-2)).toBe('DOMAIN,last.example,DIRECT');
        expect(builder.formattedConfig).toContain('[Host]\nexample.com = 1.2.3.4');
        expect(builder.formattedConfig).not.toContain('[Append-Rules]');
    });

    it('merges DNS servers and selects the default template by sing-box version', async () => {
        const defaults = structuredClone(SING_BOX_CONFIG);
        const modern = await build('singbox', { ntp: { enabled: false }, dns: { servers: [{ tag: 'dns_proxy', server: '9.9.9.9', detour: 'DIRECT' }] } });
        expect(modern.config.ntp.enabled).toBe(false);
        expect(modern.config.ntp.server).toBe(SING_BOX_CONFIG.ntp.server);
        expect(modern.config.dns.servers).toHaveLength(4);
        expect(modern.config.dns.servers[0]).toMatchObject({ type: 'tcp', server: '9.9.9.9', detour: 'DIRECT' });
        expect(modern.config.inbounds).toHaveLength(2);
        const legacy = await build('singbox', { dns: { servers: [{ tag: 'dns_proxy', address: 'tls://9.9.9.9' }] } }, { version: '1.11' });
        expect(legacy.config.dns.servers[0].address).toBe('tls://9.9.9.9');
        expect(legacy.config.dns.servers[0]).not.toHaveProperty('type');
        expect(SING_BOX_CONFIG).toEqual(defaults);
    });

    it.each(['clash', 'surge'])('inserts append rules before the fallback and formats once: %s', async format => {
        const first = 'DOMAIN,first.example,DIRECT';
        const last = 'DOMAIN,last.example,DIRECT';
        const builder = await build(format, { 'prepend-rules': [first], 'append-rules': [last] });
        expect(builder.config.rules[0]).toBe(first);
        expect(builder.config.rules.at(-2)).toBe(last);
        expect(builder.config.rules.at(-1)).toMatch(/^(MATCH|FINAL),/);
        const before = structuredClone(builder.config);
        const formatted = builder.formatConfig();
        expect(builder.formatConfig()).toBe(formatted);
        expect(builder.config).toEqual(before);
        if (format === 'clash') expect(yaml.load(formatted).rules).toEqual(before.rules);
        else expect(formatted.match(/DOMAIN,last.example,DIRECT/g)).toHaveLength(1);
    });

    it('replaces rule tables and applies both additions around the explicit table', async () => {
        const { config } = await build('singbox', { route: { rules: [{ domain: ['replace.example'], outbound: 'DIRECT' }], 'prepend-rules': [{ domain: ['first.example'], outbound: 'DIRECT' }], 'append-rules': [{ domain: ['last.example'], outbound: 'DIRECT' }], final: 'DIRECT', auto_detect_interface: false } });
        expect(config.route.rules.map(rule => rule.domain[0])).toEqual(['first.example', 'replace.example', 'last.example']);
        expect(config.route.final).toBe('DIRECT');
        expect(config.route.auto_detect_interface).toBe(false);
        expect(config.route).not.toHaveProperty('append-rules');
    });

    it('merges Surge settings, string entries, and partial object groups', async () => {
        const { config, formattedConfig } = await build('surge', { general: { ipv6: true, 'test-timeout': 0 }, proxies: ['Node = trojan, overridden.example, 443, password=new', 'Extra = direct'], 'proxy-groups': ['Custom = select, DIRECT', { name: '🌐 普通代理', proxies: ['Custom'] }], rules: ['FINAL,DIRECT'] });
        expect(config.general.ipv6).toBe(true);
        expect(config.general['test-timeout']).toBe(0);
        expect(config.general['http-listen']).toBeDefined();
        expect(config.proxies.filter(proxy => proxy.startsWith('Node ='))).toEqual(['Node = trojan, overridden.example, 443, password=new']);
        expect(formattedConfig).toContain('🌐 普通代理 = select, Custom');
        expect(formattedConfig.trim().endsWith('FINAL,DIRECT')).toBe(true);
        expect(formattedConfig).not.toContain('FINAL,🐟');
    });

    it('allows an empty Surge Rule section to clear the generated table', async () => {
        const { configObject } = parseSurgeConfigInput('[Rule]');
        const builder = await build('surge', configObject);
        expect(builder.config.rules).toEqual([]);
        expect(builder.formattedConfig).not.toContain('FINAL,');
    });

    it.each(['clash', 'singbox'])('gives explicit controller query options priority: %s', async format => {
        const patch = format === 'clash' ? { 'external-controller': '127.0.0.1:9091' } : { experimental: { clash_api: { external_controller: '127.0.0.1:9091' } } };
        const { config } = await build(format, patch, { controller: '127.0.0.1:9092' });
        expect(format === 'clash' ? config['external-controller'] : config.experimental.clash_api.external_controller).toBe('127.0.0.1:9092');
    });

    it.each(['clash', 'singbox', 'surge'])('rejects missing references and group cycles: %s', async format => {
        const key = format === 'singbox' ? 'outbounds' : 'proxy-groups';
        const make = (name, members) => format === 'singbox' ? { tag: name, type: 'selector', outbounds: members } : { name, type: 'select', proxies: members };
        await expect(build(format, { [key]: [make('A', ['Missing'])] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Missing') });
        await expect(build(format, { [key]: [make('A', ['B']), make('B', ['A'])] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Circular') });
        await expect(build(format, { [key]: [make('🚀 节点选择', [])] })).rejects.toMatchObject({ status: 400 });
    });

    it('rejects DNS resolver cycles and incompatible sing-box DNS/HTTP client settings', async () => {
        await expect(build('singbox', { dns: { servers: [{ tag: 'dns_resolver', domain_resolver: 'dns_proxy' }] } })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Circular DNS') });
        await expect(build('singbox', { dns: { servers: [{ tag: 'dns_proxy', type: 'https', server: 'dns.google' }] } }, { version: '1.11' })).rejects.toMatchObject({ status: 400 });
        await expect(build('singbox', { http_clients: [{ tag: 'c', detour: 'DIRECT' }] })).rejects.toMatchObject({ status: 400 });
        await expect(build('singbox', { route: { final: 'Missing' } })).rejects.toMatchObject({ status: 400 });
    });

    it('rejects unsafe keys, duplicate records and invalid root values', async () => {
        await expect(build('clash', JSON.parse('{"__proto__":{"polluted":true}}'))).rejects.toMatchObject({ status: 400 });
        expect({}.polluted).toBeUndefined();
        await expect(build('clash', { proxies: [{ name: 'A' }, { name: 'A' }] })).rejects.toMatchObject({ status: 400 });
        await expect(build('clash', [])).rejects.toMatchObject({ status: 400 });
        await expect(build('singbox', { route: null })).rejects.toMatchObject({ status: 400 });
    });
});

describe('stored overrides through conversion routes', () => {
    it.each(['clash', 'singbox', 'surge'])('uses configId and short links with partial overrides: %s', async format => {
        const kv = new MemoryKVAdapter();
        const patch = format === 'clash' ? { 'log-level': 'warning' } : format === 'singbox' ? { log: { level: 'warn' } } : { general: { ipv6: true } };
        await kv.put(`${format}_override`, JSON.stringify(patch));
        const query = new URLSearchParams({ config: input, configId: `${format}_override` });
        await new ShortLinkService(kv).createShortLink(query.toString(), 'override');
        const app = createApp({ kv, logger: { error() {} }, config: {} });
        const response = await app.request(`http://localhost/${format}?${query}`);
        const short = await app.request(`http://localhost/${{ clash: 'c', singbox: 'b', surge: 's' }[format]}/override`);
        expect(response.status).toBe(200);
        expect(short.status).toBe(302);
        const resolved = await app.request(short.headers.get('location'));
        expect(resolved.status).toBe(200);
        const responseText = await response.text();
        const resolvedText = await resolved.text();
        if (format === 'surge') {
            expect(resolvedText.split('\n').slice(1)).toEqual(responseText.split('\n').slice(1));
        } else expect(resolvedText).toBe(responseText);
    });

    it('returns a clean 400 for invalid stored overrides and invalid uploads', async () => {
        const kv = new MemoryKVAdapter();
        await kv.put('clash_invalid', JSON.stringify({ 'proxy-groups': [{ name: '🚀 节点选择', proxies: ['Missing'] }] }));
        const app = createApp({ kv, logger: { error() {} }, config: {} });
        const res = await app.request(`http://localhost/clash?${new URLSearchParams({ config: input, configId: 'clash_invalid' })}`);
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('Missing');
        const upload = await app.request('http://localhost/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'clash', content: '[]' }) });
        expect(upload.status).toBe(400);
    });
});
