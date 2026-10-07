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
const vlessInput = [
    'vless://11111111-1111-1111-1111-111111111111@entry.example.com:443?security=tls#Entry%20VLESS',
    'vless://22222222-2222-2222-2222-222222222222@exit.example.com:443?security=tls#Exit%20VLESS'
].join('\n');
const vlessChain = parseChainConfig({ version: 2, exit: { line: 1, label: 'Exit VLESS' } }, vlessInput);

function mockSubscriptions(format = 'clash', overrides = '') {
    fetchSubscriptionWithFormat.mockImplementation(url => {
        const source = new URL(url).hostname.split('.')[0];
        const name = source[0].toUpperCase() + source.slice(1) + ' Node';
        return Promise.resolve({
            content: format === 'singbox' ? JSON.stringify({ outbounds: [{
                type: 'shadowsocks', tag: name, server: source + '.example',
                server_port: 443, method: 'aes-128-gcm', password: 'secret'
            }] }) : yaml.dump({ proxies: [{
                name, type: 'ss', server: source + '.example', port: 443,
                cipher: 'aes-128-gcm', password: 'secret'
            }] }) + overrides,
            format, url
        });
    });
}

describe('OUT source chain proxy', () => {
    afterEach(() => vi.clearAllMocks());

    it('validates OUT references and migrates old single-link configurations', () => {
        expect(() => parseChainConfig({ version: 2, exit: { line: 99 } }, input)).toThrow('OUT source line');
        expect(() => parseChainConfig({ version: 2, exit: { line: 0 } }, 'not a URI')).toThrow('subscription or proxy URI');
        expect(() => parseChainConfig('{', input)).toThrow('expected JSON');
        expect(() => parseChainConfig({ version: 3 }, input)).toThrow('structure');
        const legacy = {
            version: 1,
            sources: [{ id: 'a', line: 0 }, { id: 'b', line: 1, label: 'Exit' }],
            links: [{ entry: 'a', exit: 'b' }]
        };
        expect(parseChainConfig(JSON.stringify(legacy), input)).toEqual(chain);
        expect(() => parseChainConfig({ ...legacy, links: [{ entry: 'a', exit: 'a' }] }, input)).toThrow('Invalid chain link');
        expect(() => parseChainConfig({ ...legacy, links: [...legacy.links, legacy.links[0]] }, input)).toThrow('single OUT');
    });

    it('uses every non-OUT subscription as Sing-Box auto selection candidates', async () => {
        mockSubscriptions('singbox');
        const builder = new SingboxConfigBuilder(
            input, [], [], null, 'zh-CN', 'test-agent', false,
            false, null, null, '1.12', true, chain
        );
        await builder.build();
        const autoName = builder.t('outboundNames.Auto Select');
        const auto = builder.config.outbounds.find(outbound => outbound.tag === autoName);
        const entry = builder.config.outbounds.find(outbound => outbound.tag === '入口节点');
        const chainedExit = builder.config.outbounds.find(outbound => outbound.tag === '[链式代理] Exit Node');
        const originalExit = builder.config.outbounds.find(outbound => outbound.tag === 'Exit Node');
        const chainGroup = builder.config.outbounds.find(outbound => outbound.tag === '落地节点');

        expect(auto.type).toBe('urltest');
        expect(auto.outbounds).toEqual(['Entry Node', 'Third Node']);
        expect(entry.type).toBe('selector');
        expect(entry.outbounds).toEqual(['Entry Node', 'Third Node', autoName]);
        expect(chainedExit.detour).toBe(entry.tag);
        expect(originalExit.detour).toBeUndefined();
        expect(chainGroup.outbounds).toEqual([chainedExit.tag]);
        expect(builder.config.outbounds.find(outbound => outbound.tag === '🚀 节点选择').outbounds).toContain(chainGroup.tag);
        expect(builder.config.outbound_providers).toBeUndefined();
        expect(builder.config.outbounds.filter(outbound => outbound.type === 'urltest')).toHaveLength(1);
    });

    it('uses every non-OUT subscription as Mihomo auto selection candidates', async () => {
        mockSubscriptions();
        const builder = new ClashConfigBuilder(input, [], [], null, 'zh-CN', 'test-agent', false, false, null, null, true, chain);
        const config = yaml.load(await builder.build());
        const autoName = builder.t('outboundNames.Auto Select');
        const auto = config['proxy-groups'].find(group => group.name === autoName);
        const entry = config['proxy-groups'].find(group => group.name === '入口节点');
        const chainedExit = config.proxies.find(proxy => proxy.name === '[链式代理] Exit Node');

        expect(auto.type).toBe('url-test');
        expect(auto.proxies).toEqual(['Entry Node', 'Third Node']);
        expect(entry.type).toBe('select');
        expect(entry.proxies).toEqual(['Entry Node', 'Third Node', autoName]);
        expect(chainedExit['dialer-proxy']).toBe(entry.name);
        expect(config.proxies.find(proxy => proxy.name === 'Exit Node')['dialer-proxy']).toBeUndefined();
        expect(config['proxy-groups'].find(group => group.name === '落地节点').proxies).toEqual([chainedExit.name]);
        expect(config['proxy-groups'].find(group => group.name === '🚀 节点选择').proxies).toContain('落地节点');
        expect(config['proxy-providers']).toBeUndefined();
        expect(config['proxy-groups'].filter(group => group.type === 'url-test')).toHaveLength(1);
    });

    it('supports VLESS URI sources when global auto selection is disabled', async () => {
        const singbox = new SingboxConfigBuilder(
            vlessInput, [], [], null, 'zh-CN', 'test-agent', false,
            false, null, null, '1.12', false, vlessChain
        );
        await singbox.build();
        expect(singbox.config.outbounds.find(outbound => outbound.tag === '[链式代理] Exit VLESS').detour)
            .toBe('入口节点');
        expect(singbox.config.outbounds.find(outbound => outbound.tag === '入口节点').outbounds)
            .toEqual(['Entry VLESS', singbox.t('outboundNames.Auto Select')]);
        expect(singbox.config.outbounds.find(outbound => outbound.type === 'urltest').outbounds).toEqual(['Entry VLESS']);

        const clashBuilder = new ClashConfigBuilder(vlessInput, [], [], null, 'zh-CN', 'test-agent', false, false, null, null, false, vlessChain);
        const clash = yaml.load(await clashBuilder.build());
        expect(clash.proxies.find(proxy => proxy.name === '[链式代理] Exit VLESS')['dialer-proxy'])
            .toBe('入口节点');
        expect(clash['proxy-groups'].find(group => group.name === '入口节点').proxies)
            .toEqual(['Entry VLESS', clashBuilder.t('outboundNames.Auto Select')]);
        expect(clash['proxy-groups'].find(group => group.type === 'url-test').proxies).toEqual(['Entry VLESS']);
    });

    it('includes standalone URI nodes alongside IN subscriptions', async () => {
        mockSubscriptions();
        const mixedInput = input + '\n' + vlessInput.split('\n')[0];
        const builder = new ClashConfigBuilder(mixedInput, [], [], null, 'zh-CN', 'test-agent', false, false, null, null, true,
            parseChainConfig(rawChain, mixedInput));
        const config = yaml.load(await builder.build());
        expect(config['proxy-groups'].find(group => group.name === builder.t('outboundNames.Auto Select')).proxies)
            .toEqual(['Entry Node', 'Third Node', 'Entry VLESS']);
        expect(config['proxy-groups'].find(group => group.name === '入口节点').proxies)
            .toEqual(['Entry Node', 'Third Node', 'Entry VLESS', builder.t('outboundNames.Auto Select')]);
    });

    it('generates Surge OUT policies with the shared auto selection group', async () => {
        mockSubscriptions();
        const builder = new SurgeConfigBuilder(input, [], [], null, 'zh-CN', 'test-agent', false, true, chain);
        await builder.build();
        const autoName = builder.t('outboundNames.Auto Select');
        expect(builder.config.proxies.find(proxy => proxy.startsWith('[链式代理] Exit Node =')))
            .toContain('underlying-proxy=入口节点');
        expect(builder.config.proxies.find(proxy => proxy.startsWith('Exit Node ='))).not.toContain('underlying-proxy=');
        expect(builder.config['proxy-groups']).toContain('落地节点 = select, [链式代理] Exit Node');
        expect(builder.config['proxy-groups']).toContain(autoName + ' = url-test, Entry Node, Third Node, url=http://www.gstatic.com/generate_204, interval=300');
        expect(builder.config['proxy-groups']).toContain('入口节点 = select, Entry Node, Third Node, ' + autoName);
    });

    it('prevents subscription overrides from adding OUT to either IN group', async () => {
        mockSubscriptions('clash', '\nproxy-groups:\n  - name: ⚡ 自动选择\n    type: url-test\n    proxies: [Exit Node]\n  - name: 入口节点\n    type: select\n    proxies: [Exit Node]\n');
        const builder = new ClashConfigBuilder(input, [], [], null, 'zh-CN', 'test-agent', false, false, null, null, true, chain);
        const config = yaml.load(await builder.build());
        const dialer = config.proxies.find(proxy => proxy.name === '[链式代理] Exit Node')['dialer-proxy'];
        const entry = config['proxy-groups'].find(group => group.name === dialer);
        expect(entry.proxies).toEqual(['Entry Node', 'Third Node', builder.t('outboundNames.Auto Select')]);
        expect(config['proxy-groups'].find(group => group.name === entry.proxies.at(-1)).proxies)
            .toEqual(['Entry Node', 'Third Node']);
    });

    it('rejects OUT-only configurations instead of generating an empty auto selector', async () => {
        const outOnly = vlessInput.split('\n')[1];
        const builder = new ClashConfigBuilder(outOnly, [], [], null, 'zh-CN', 'test-agent', false, false, null, null, true,
            parseChainConfig({ version: 2, exit: { line: 0 } }, outOnly));
        await expect(builder.build()).rejects.toThrow('supported IN nodes');
    });

    it('rejects chain parameters on the Xray URI endpoint', async () => {
        const app = createApp({ kv: new MemoryKVAdapter(), logger: console });
        const response = await app.request('http://localhost/xray?config=' + encodeURIComponent(input) + '&chain=' + encodeURIComponent(JSON.stringify(rawChain)));
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('not supported');
    });

    it('accepts the OUT-only chain parameter on the conversion endpoint', async () => {
        mockSubscriptions();
        const app = createApp({ kv: new MemoryKVAdapter(), logger: console });
        const params = new URLSearchParams({ config: input, chain: JSON.stringify(rawChain) });
        const response = await app.request('http://localhost/clash?' + params);
        expect(response.status).toBe(200);
        const config = yaml.load(await response.text());
        const exit = config.proxies.find(proxy => proxy.name === '[链式代理] Exit Node');
        expect(config['proxy-groups'].find(group => group.name === exit['dialer-proxy']).proxies)
            .toEqual(['Entry Node', 'Third Node', '⚡ 自动选择']);
    });
});
