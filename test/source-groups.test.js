import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';
import { SurgeConfigBuilder } from '../src/builders/SurgeConfigBuilder.js';
import { CLASH_CONFIG, SING_BOX_CONFIG, SURGE_CONFIG } from '../src/config/index.js';
import { parseChainConfig } from '../src/chains/chainConfig.js';

const builders = [['Clash', ClashConfigBuilder], ['Sing-Box', SingboxConfigBuilder], ['Surge', SurgeConfigBuilder]];
const uri = (name, host) => `ss://YWVzLTEyOC1nY206cGFzcw@${host}:443#${encodeURIComponent(name)}`;

function groups(builder) {
    if (builder instanceof SingboxConfigBuilder) {
        return builder.config.outbounds.filter(outbound => ['selector', 'urltest'].includes(outbound.type))
            .map(outbound => ({ name: outbound.tag, nodes: outbound.outbounds || [], providers: outbound.providers || [] }));
    }
    if (builder instanceof ClashConfigBuilder) {
        return (builder.config['proxy-groups'] || []).map(group => ({ name: group.name, nodes: group.proxies || [], providers: group.use || [] }));
    }
    return (builder.config['proxy-groups'] || []).map(line => {
        const [name, rest] = line.split(' = ');
        return { name, nodes: rest.split(', ').slice(1).filter(value => !value.includes('=')), providers: [] };
    });
}

function findSource(builder, name) {
    return groups(builder).find(group => group.name === `📥 ${name}`);
}

describe('groups by import source', () => {
    afterEach(() => vi.unstubAllGlobals());

    describe.each(builders)('%s output', (_name, Builder) => {
        it.each([false, true])('keeps remote sources separate with country grouping %s', async (groupByCountry) => {
            const first = 'https://airport.example/sub?token=first';
            const second = 'https://airport.example/sub?token=second';
            vi.stubGlobal('fetch', vi.fn(async url => new Response(url === first ? uri('HK-A', 'a.example') : uri('JP-B', 'b.example'))));
            const input = [first, second, first, uri('Manual', 'manual.example')].join('\n');
            const builder = new Builder(input, [], [], null, 'zh-CN', 'test-agent', groupByCountry);
            await builder.build();
            expect(findSource(builder, 'airport.example').nodes).toEqual(['HK-A']);
            expect(findSource(builder, 'airport.example 2').nodes).toEqual(['JP-B']);
            expect(findSource(builder, '手动节点').nodes).toEqual(['Manual']);
            expect(groups(builder).filter(group => group.name.startsWith('📥 '))).toHaveLength(3);
            const ordinary = groups(builder).find(group => group.name === builder.t('ordinaryProxy'));
            expect(ordinary.nodes).toEqual(expect.arrayContaining(builder.sourceGroupNames));
            const root = groups(builder).find(group => group.name === builder.t('outboundNames.Node Select'));
            expect(root.nodes).toContain(ordinary.name);
            expect(root.nodes.some(name => name.startsWith('📥 '))).toBe(false);
            expect(JSON.stringify(builder.config)).not.toContain('token=first');
        });

        it('tracks renamed and deduplicated nodes in the correct sources', async () => {
            const first = 'https://a.example/sub';
            const second = 'https://b.example/sub';
            const shared = uri('Shared', 'shared.example');
            vi.stubGlobal('fetch', vi.fn(async url => new Response([
                uri('Same', url === first ? 'first.example' : 'second.example'), shared
            ].join('\n'))));
            const builder = new Builder(`${first}\n${second}`, [], [], null, 'zh-CN', 'test-agent');
            await builder.build();
            expect(findSource(builder, 'a.example').nodes).toEqual(['Same', 'Shared']);
            expect(findSource(builder, 'b.example').nodes).toEqual(['Same 2', 'Shared']);
            expect(builder.getProxies()).toHaveLength(3);
        });

        it('avoids source group collisions with node names and skips empty sources', async () => {
            const first = 'https://a.example/sub';
            const empty = 'https://empty.example/sub';
            vi.stubGlobal('fetch', vi.fn(async url => new Response(url === first ? uri('📥 a.example', 'node.example') : '')));
            const builder = new Builder(`${first}\n${empty}`, [], [], null, 'zh-CN', 'test-agent');
            await builder.build();
            expect(findSource(builder, 'a.example 2').nodes).toEqual(['📥 a.example']);
            expect(findSource(builder, 'empty.example')).toBeUndefined();
        });

        it('assigns nested subscription nodes to the imported outer source', async () => {
            const outer = 'https://outer.example/sub';
            const inner = 'https://inner.example/sub';
            vi.stubGlobal('fetch', vi.fn(async url => new Response(url === outer ? inner : uri('Nested', 'nested.example'))));
            const builder = new Builder(outer, [], [], null, 'zh-CN', 'test-agent');
            await builder.build();
            expect(findSource(builder, 'outer.example').nodes).toEqual(['Nested']);
            expect(findSource(builder, 'inner.example')).toBeUndefined();
        });
    });

    it.each([['Clash', ClashConfigBuilder, true], ['Clash', ClashConfigBuilder, false], ['Sing-Box', SingboxConfigBuilder, true], ['Sing-Box', SingboxConfigBuilder, false]])('isolates each remote provider in its %s source group with auto=%s', async (_name, Builder, auto) => {
        const first = 'https://a.example/sub';
        const second = 'https://b.example/sub';
        vi.stubGlobal('fetch', vi.fn(async url => new Response(Builder === ClashConfigBuilder
            ? `proxies:\n  - {name: Node, type: ss, server: ${new URL(url).hostname}, port: 443, cipher: aes-128-gcm, password: test}\nproxy-groups:\n  - {name: Upstream Group, type: select, proxies: [Node]}`
            : JSON.stringify({ outbounds: [
                { type: 'shadowsocks', tag: 'Node', server: new URL(url).hostname, server_port: 443, method: 'aes-128-gcm', password: 'test' },
                { type: 'selector', tag: 'Upstream Group', outbounds: ['Node'] }
            ] }))));
        const args = [`${first}\n${second}\n${first}`, [], [], null, 'zh-CN', 'test-agent', false, false, null, null];
        const builder = Builder === SingboxConfigBuilder ? new Builder(...args, '1.12', auto) : new Builder(...args, auto);
        await builder.build();
        const a = findSource(builder, 'a.example');
        const b = findSource(builder, 'b.example');
        expect(a.providers).toHaveLength(1);
        expect(b.providers).toHaveLength(1);
        expect(a.providers).not.toEqual(b.providers);
        expect(a.nodes).toHaveLength(0);
        expect(groups(builder).filter(group => group.name.startsWith('📥 '))).toHaveLength(2);
        expect(groups(builder).some(group => group.name === 'Upstream Group')).toBe(false);
        const root = groups(builder).find(g => g.name === '🚀 节点选择');
        expect(root.providers).toEqual([]);
        expect(root.nodes).toContain('🌐 普通代理');
        const allNodes = groups(builder).find(g => g.name === '📋 全部节点');
        expect(allNodes.providers).toEqual(expect.arrayContaining([...a.providers, ...b.providers]));
        const fallback = groups(builder).find(g => g.name === '🐟 漏网之鱼');
        expect(fallback.providers).toEqual([]);
        expect(fallback.nodes).toEqual(expect.arrayContaining([a.name, b.name]));
        if (!auto) expect(JSON.stringify(builder.config)).not.toMatch(/"type":"url-?test"/);
    });

    it.each([
        [ClashConfigBuilder, CLASH_CONFIG, 'dns'],
        [SingboxConfigBuilder, SING_BOX_CONFIG, 'dns'],
        [SurgeConfigBuilder, SURGE_CONFIG, 'general']
    ])('preserves custom base DNS configuration for %s', async (Builder, template, field) => {
        const base = structuredClone(template);
        base[field] = { ...base[field], 'custom-marker': 'base DNS' };
        const builder = new Builder(uri('Manual', 'manual.example'), [], [], base, 'zh-CN', 'test-agent');
        await builder.build();
        expect(builder.config[field]['custom-marker']).toBe('base DNS');
    });

    it('keeps source groups out of chain entry candidates', async () => {
        const input = [uri('Entry', 'entry.example'), 'https://exit.example/sub'].join('\n');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(uri('Exit', 'exit.example'))));
        const chain = parseChainConfig({ version: 2, exit: { line: 1 } }, input);
        const builder = new ClashConfigBuilder(input, [], [], null, 'zh-CN', 'test-agent', false, false, null, null, true, chain);
        await builder.build();
        const entry = groups(builder).find(group => group.name === '🛫 入口选择');
        expect(entry.nodes).toEqual(['Entry']);
        expect(findSource(builder, 'exit.example').nodes).toEqual(['Exit']);
    });
});
