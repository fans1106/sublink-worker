import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

vi.mock('../src/parsers/subscription/httpSubscriptionFetcher.js', async (importOriginal) => {
    const original = await importOriginal();
    return { ...original, fetchSubscriptionWithFormat: vi.fn() };
});

import { fetchSubscriptionWithFormat } from '../src/parsers/subscription/httpSubscriptionFetcher.js';
import { parseChainConfig } from '../src/chains/chainConfig.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { SurgeConfigBuilder } from '../src/builders/SurgeConfigBuilder.js';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';

const input = 'https://entry.example/sub\nhttps://exit.example/sub\nhttps://third.example/sub';
const rawChain = { version: 2, exit: { line: 1, label: 'Exit' } };
const chain = parseChainConfig(rawChain, input);
const builders = ['clash', 'singbox', 'surge'];
const uri = (name, server) => `ss://YWVzLTEyOC1nY206cGFzcw@${server}:443#${encodeURIComponent(name)}`;
const vless = (name, server) => `vless://11111111-1111-1111-1111-111111111111@${server}:443?security=tls#${encodeURIComponent(name)}`;
const customRules = [{ name: 'Custom', site_rules: ['google'], ip_rules: [], domain_suffix: [], domain_keyword: [] }];

function makeBuilder(platform, text = input, chainConfig = chain, auto = true, countries = false) {
    const args = [text, 'balanced', customRules, null, 'zh-CN', 'test-agent', countries];
    if (platform === 'singbox') return new SingboxConfigBuilder(...args, false, null, null, '1.12', auto, chainConfig);
    if (platform === 'clash') return new ClashConfigBuilder(...args, false, null, null, auto, chainConfig);
    return new SurgeConfigBuilder(...args, auto, chainConfig);
}

function mockSubscriptions(format = 'clash', overrides = '') {
    fetchSubscriptionWithFormat.mockImplementation(async url => {
        const source = new URL(url).hostname.split('.')[0];
        const proxy = { name: source[0].toUpperCase() + source.slice(1) + ' Node', type: 'ss', server: `${source}.example`, port: 443, cipher: 'aes-128-gcm', password: 'secret' };
        const proxies = source === 'exit' ? [proxy, { ...proxy, name: 'Exit Two', server: 'exit-two.example' }, proxy] : [proxy];
        return {
            content: format === 'singbox' ? JSON.stringify({ outbounds: proxies.map(p => ({
                type: 'shadowsocks', tag: p.name, server: p.server, server_port: p.port, method: p.cipher, password: p.password
            })) }) : yaml.dump({ proxies }) + overrides,
            format, url
        };
    });
}

function graph(builder) {
    if (builder instanceof SingboxConfigBuilder) {
        return {
            groups: builder.config.outbounds.filter(o => ['selector', 'urltest'].includes(o.type)).map(o => ({ name: o.tag, members: o.outbounds || [], type: o.type })),
            nodes: builder.getProxies().map(p => ({ name: p.tag, entry: p.detour, server: p.server }))
        };
    }
    if (builder instanceof ClashConfigBuilder) {
        return {
            groups: builder.config['proxy-groups'].map(g => ({ name: g.name, members: g.proxies || [], type: g.type })),
            nodes: builder.getProxies().map(p => ({ name: p.name, entry: p['dialer-proxy'], server: p.server }))
        };
    }
    return {
        groups: builder.config['proxy-groups'].map(line => {
            const [name, rest] = line.split(' = ');
            const [type, ...parts] = rest.split(', ');
            return { name, type, members: parts.filter(p => !p.includes('=')) };
        }),
        nodes: builder.getProxies().filter(p => !p.startsWith('#')).map(line => ({
            name: line.split(' = ')[0], entry: line.match(/underlying-proxy=([^,]+)/)?.[1], server: line.split(', ')[1]
        }))
    };
}

function expectValidGraph({ groups, nodes }) {
    const edges = new Map([
        ...groups.map(g => [g.name, g.members]),
        ...nodes.map(n => [n.name, n.entry ? [n.entry] : []]),
        ['DIRECT', []], ['REJECT', []]
    ]);
    expect(edges.size).toBe(groups.length + nodes.length + 2);
    const visit = (name, visiting = new Set()) => {
        expect(edges.has(name), `missing reference ${name}`).toBe(true);
        expect(visiting.has(name), `cycle through ${name}`).toBe(false);
        for (const next of edges.get(name)) visit(next, new Set([...visiting, name]));
    };
    groups.forEach(g => visit(g.name));
}

describe('OUT source chain proxy', () => {
    afterEach(() => vi.clearAllMocks());

    it('validates OUT references and migrates old single-link configurations', () => {
        expect(() => parseChainConfig({ version: 2, exit: { line: 99 } }, input)).toThrow('OUT source line');
        expect(() => parseChainConfig({ version: 2, exit: { line: 0 } }, 'not a URI')).toThrow('subscription or proxy URI');
        expect(() => parseChainConfig('{', input)).toThrow('expected JSON');
        expect(() => parseChainConfig({ version: 3 }, input)).toThrow('structure');
        const legacy = { version: 1, sources: [{ id: 'a', line: 0 }, { id: 'b', line: 1, label: 'Exit' }], links: [{ entry: 'a', exit: 'b' }] };
        expect(parseChainConfig(JSON.stringify(legacy), input)).toEqual(chain);
        expect(() => parseChainConfig({ ...legacy, links: [{ entry: 'a', exit: 'a' }] }, input)).toThrow('Invalid chain link');
        expect(() => parseChainConfig({ ...legacy, links: [...legacy.links, legacy.links[0]] }, input)).toThrow('single OUT');
    });

    describe.each(builders)('%s grouping', platform => {
        it.each([[true, true], [true, false], [false, true], [false, false]])('separates single-hop and full paths with auto=%s countries=%s', async (auto, countries) => {
            mockSubscriptions(platform === 'singbox' ? 'singbox' : 'clash');
            const builder = makeBuilder(platform, input, chain, auto, countries);
            await builder.build();
            const result = graph(builder);
            const group = name => result.groups.find(g => g.name === name);
            const node = name => result.nodes.find(n => n.name === name);
            const specials = platform === 'singbox' ? ['DIRECT'] : ['DIRECT', 'REJECT'];
            expect(result.groups[0].name).toBe('🚀 节点选择');
            expect(group('🚀 节点选择').members).toEqual(['🔗 链式代理', '🌐 普通代理', ...specials]);
            expect(group('🛫 入口选择').members).toEqual(['Entry Node', 'Third Node']);
            expect(group('📋 全部节点').members).toEqual(['Entry Node', 'Exit Node', 'Exit Two', 'Third Node']);
            expect(group('🔗 链式代理').members).toEqual(['🎯 落地 · Exit Node', '🎯 落地 · Exit Two']);
            expect(group('📥 exit.example').members).toEqual(['Exit Node', 'Exit Two']);
            const ordinary = group('🌐 普通代理').members;
            expect(ordinary).toEqual([
                ...(auto ? ['⚡ 普通自动选择'] : []), '📋 全部节点', ...builder.sourceGroupNames, ...builder.countryGroupNames
            ]);
            for (const [name, server] of [['Exit Node', 'exit.example'], ['Exit Two', 'exit-two.example']]) {
                expect(node(name).entry).toBeUndefined();
                const manual = node(`🔧 指定入口 · ${name}`);
                expect(manual.entry).toBe('🛫 入口选择');
                expect(manual.server).toBe(server);
                expect(group(`🎯 落地 · ${name}`).members).toEqual([
                    ...(auto ? [`⚡ 自动入口 · ${name}`] : []), manual.name
                ]);
                if (auto) {
                    const paths = group(`⚡ 自动入口 · ${name}`).members.map(node);
                    expect(paths.map(p => p.entry)).toEqual(['Entry Node', 'Third Node']);
                    expect(paths.every(p => p.server === server)).toBe(true);
                }
            }
            const businessMembers = ['🚀 节点选择', '🌐 普通代理', '🔗 链式代理', ...builder.sourceGroupNames, ...specials];
            expect(group('Custom').members).toEqual(businessMembers);
            expect(group('🐟 漏网之鱼').members).toEqual(businessMembers);
            expect(group(builder.t('outboundNames.Google')).members).toEqual(businessMembers);
            expect(group(builder.t('outboundNames.Location:CN')).members[0]).toBe('DIRECT');
            if (auto) {
                expect(group('⚡ 普通自动选择').members).toEqual(['Entry Node', 'Exit Node', 'Exit Two', 'Third Node']);
            } else {
                expect(result.groups.some(g => ['urltest', 'url-test'].includes(g.type))).toBe(false);
                expect(result.nodes.filter(n => n.entry)).toHaveLength(2);
            }
            expect(builder.config['proxy-providers'] ?? builder.config.outbound_providers).toBeUndefined();
            expectValidGraph(result);
        });

        it.each([true, false])('keeps the non-chain hierarchy with auto=%s', async auto => {
            const text = [uri('HK-Entry', 'hk.example'), uri('US-Exit', 'us.example')].join('\n');
            const builder = makeBuilder(platform, text, null, auto, true);
            await builder.build();
            const result = graph(builder);
            const group = name => result.groups.find(g => g.name === name);
            const specials = platform === 'singbox' ? ['DIRECT'] : ['DIRECT', 'REJECT'];
            expect(group('🚀 节点选择').members).toEqual(['🌐 普通代理', ...specials]);
            expect(group('Custom').members).toEqual(['🚀 节点选择', '🌐 普通代理', '📥 手动节点', ...specials]);
            expect(group('📋 全部节点').members).toEqual(['HK-Entry', 'US-Exit']);
            expect(group('🌐 普通代理').members).toEqual([
                ...(auto ? ['⚡ 普通自动选择'] : []), '📋 全部节点', '📥 手动节点', '🇭🇰 Hong Kong', '🇺🇸 United States'
            ]);
            expect(result.nodes.every(n => !n.entry)).toBe(true);
            expect(group('🔗 链式代理')).toBeUndefined();
            if (!auto) expect(result.groups.some(g => ['urltest', 'url-test'].includes(g.type))).toBe(false);
            expectValidGraph(result);
        });

        it('supports mixed URI inputs with auto selection disabled', async () => {
            mockSubscriptions();
            const text = [input, (platform === 'surge' ? uri : vless)('Entry URI', 'entry-uri.example')].join('\n');
            const builder = makeBuilder(platform, text, parseChainConfig(rawChain, text), false);
            await builder.build();
            expect(graph(builder).groups.find(g => g.name === '🛫 入口选择').members).toEqual(['Entry Node', 'Third Node', 'Entry URI']);
        });

        it('deduplicates repeated OUT nodes and reserves names that collide with controls', async () => {
            const text = [uri('🛫 入口选择', 'in.example'), uri('Exit', 'out.example'), uri('Exit', 'out.example'), uri('🚀 节点选择', 'second-in.example')].join('\n');
            const builder = makeBuilder(platform, text, parseChainConfig({ version: 2, exit: { line: 1 } }, text));
            await builder.build();
            const result = graph(builder);
            expect(result.groups.find(g => g.name === '🛫 入口选择 2').members).toEqual(['🛫 入口选择', '🚀 节点选择 2']);
            expect(result.groups.find(g => g.name === '🔗 链式代理').members).toEqual(['🎯 落地 · Exit']);
            expectValidGraph(result);
        });

        it('rejects OUT-only configurations', async () => {
            const text = uri('Exit', 'exit.example');
            const builder = makeBuilder(platform, text, parseChainConfig({ version: 2, exit: { line: 0 } }, text));
            await expect(builder.build()).rejects.toThrow('supported IN nodes');
        });
    });

    it.each(['clash', 'singbox'])('%s supports VLESS-only sources with auto selection disabled', async platform => {
        const text = [vless('Entry VLESS', 'entry.example'), vless('Exit VLESS', 'exit.example')].join('\n');
        const builder = makeBuilder(platform, text, parseChainConfig({ version: 2, exit: { line: 1 } }, text), false);
        await builder.build();
        const result = graph(builder);
        expect(result.nodes.find(n => n.name === '🔧 指定入口 · Exit VLESS').entry).toBe('🛫 入口选择');
        expect(result.groups.find(g => g.name === '🛫 入口选择').members).toEqual(['Entry VLESS']);
        expect(result.groups.some(g => ['urltest', 'url-test'].includes(g.type))).toBe(false);
        expectValidGraph(result);
    });

    it('discards upstream groups that try to override chain controls', async () => {
        mockSubscriptions('clash', '\nproxy-groups:\n  - {name: "🛫 入口选择", type: select, proxies: [Exit Node]}\n  - {name: "⚡ 自动入口 · Exit Node", type: url-test, proxies: [Exit Node]}\n');
        const builder = makeBuilder('clash');
        await builder.build();
        const { groups, nodes } = graph(builder);
        expect(groups.find(g => g.name === '🛫 入口选择').members).toEqual(['Entry Node', 'Third Node']);
        const paths = groups.find(g => g.name === '⚡ 自动入口 · Exit Node').members.map(name => nodes.find(n => n.name === name));
        expect(paths.map(p => p.entry)).toEqual(['Entry Node', 'Third Node']);
    });

    it('rejects chain parameters on the Xray URI endpoint', async () => {
        const app = createApp({ kv: new MemoryKVAdapter(), logger: console });
        const response = await app.request('http://localhost/xray?config=' + encodeURIComponent(input) + '&chain=' + encodeURIComponent(JSON.stringify(rawChain)));
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('not supported');
    });

    it.each(builders)('defaults to a chain path on the %s conversion endpoint', async platform => {
        mockSubscriptions(platform === 'singbox' ? 'singbox' : 'clash');
        const app = createApp({ kv: new MemoryKVAdapter(), logger: console });
        const params = new URLSearchParams({ config: input, chain: JSON.stringify(rawChain), lang: 'zh-CN' });
        const response = await app.request(`http://localhost/${platform}?${params}`);
        expect(response.status).toBe(200);
        const text = await response.text();
        if (platform === 'surge') {
            expect(text).toContain('🚀 节点选择 = select, 🔗 链式代理, 🌐 普通代理, DIRECT, REJECT');
            expect(text).toContain('FINAL,🐟 漏网之鱼');
        } else {
            const config = platform === 'clash' ? yaml.load(text) : JSON.parse(text);
            const groups = platform === 'clash' ? config['proxy-groups'] : config.outbounds;
            const root = groups.find(g => (g.name ?? g.tag) === '🚀 节点选择');
            expect((root.proxies ?? root.outbounds)[0]).toBe('🔗 链式代理');
            expect(root.use ?? root.providers).toBeUndefined();
            if (platform === 'singbox') {
                expect(config.dns.servers[0].detour).toBe('🚀 节点选择');
                expect(config.route.final).toBe('🐟 漏网之鱼');
            } else expect(config.rules.at(-1)).toBe('MATCH,🐟 漏网之鱼');
        }
    });
});
