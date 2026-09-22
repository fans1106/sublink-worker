import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

vi.mock('../src/parsers/subscription/httpSubscriptionFetcher.js', async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        fetchSubscriptionWithFormat: vi.fn()
    };
});

import { fetchSubscriptionWithFormat } from '../src/parsers/subscription/httpSubscriptionFetcher.js';
import { parseChainConfig } from '../src/chains/chainConfig.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { SurgeConfigBuilder } from '../src/builders/SurgeConfigBuilder.js';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';

const input = 'https://entry.example/sub\nhttps://exit.example/sub';
const chain = parseChainConfig(JSON.stringify({
    version: 1,
    sources: [
        { id: 'entry', line: 0, label: 'Entry' },
        { id: 'exit', line: 1, label: 'Exit' }
    ],
    links: [{ entry: 'entry', exit: 'exit' }]
}), input);

const vlessInput = [
    'vless://11111111-1111-1111-1111-111111111111@entry.example.com:443?encryption=none&security=tls&sni=entry.example.com#Entry%20VLESS',
    'vless://22222222-2222-2222-2222-222222222222@exit.example.com:443?encryption=none&security=tls&sni=exit.example.com#Exit%20VLESS'
].join('\n');
const vlessChain = parseChainConfig({
    version: 1,
    sources: [
        { id: 'entry', line: 0, label: 'Entry VLESS' },
        { id: 'exit', line: 1, label: 'Exit VLESS' }
    ],
    links: [{ entry: 'entry', exit: 'exit' }]
}, vlessInput);

const subscription = (name, server) => `
proxies:
  - name: ${name}
    type: ss
    server: ${server}
    port: 443
    cipher: aes-128-gcm
    password: secret
`;

function mockSubscriptions() {
    fetchSubscriptionWithFormat.mockImplementation(url => Promise.resolve({
        content: url.includes('entry')
            ? subscription('Entry Node', 'entry.example')
            : subscription('Exit Node', 'exit.example'),
        format: 'clash',
        url
    }));
}

describe('subscription chain proxy', () => {
    afterEach(() => vi.clearAllMocks());

    it('rejects self references and multi-hop links', () => {
        expect(() => parseChainConfig({
            version: 1,
            sources: [{ id: 'entry', line: 0 }],
            links: [{ entry: 'entry', exit: 'entry' }]
        }, input)).toThrow('Invalid chain link');

        expect(() => parseChainConfig({
            version: 1,
            sources: [
                { id: 'a', line: 0 },
                { id: 'b', line: 1 },
                { id: 'c', line: 2 }
            ],
            links: [{ entry: 'a', exit: 'b' }, { entry: 'b', exit: 'c' }]
        }, `${input}\nhttps://third.example/sub`)).toThrow('Multi-hop');
    });

    it('generates Sing-Box detour outbounds without changing original nodes', async () => {
        mockSubscriptions();
        const builder = new SingboxConfigBuilder(
            input, [], [], null, 'zh-CN', 'test-agent', false,
            false, null, null, '1.12', true, chain
        );
        await builder.build();

        const entryGroup = builder.config.outbounds.find(outbound => outbound.tag === '🔗 IN · Entry');
        const chainGroup = builder.config.outbounds.find(outbound => outbound.tag === '🔗 Entry → Exit');
        const chainedExit = builder.config.outbounds.find(outbound => outbound.tag === '[Entry → Exit] Exit Node');
        const originalExit = builder.config.outbounds.find(outbound => outbound.tag === 'Exit Node');
        const nodeSelect = builder.config.outbounds.find(outbound => outbound.tag === '🚀 节点选择');

        expect(entryGroup.outbounds).toContain('Entry Node');
        expect(chainedExit.detour).toBe(entryGroup.tag);
        expect(originalExit.detour).toBeUndefined();
        expect(chainGroup.outbounds).toContain(chainedExit.tag);
        expect(nodeSelect.outbounds).toContain(chainGroup.tag);
    });

    it('generates Mihomo dialer-proxy nodes', async () => {
        mockSubscriptions();
        const builder = new ClashConfigBuilder(
            input, [], [], null, 'zh-CN', 'test-agent', false,
            false, null, null, true, chain
        );
        const config = yaml.load(await builder.build());

        const entryGroup = config['proxy-groups'].find(group => group.name === '🔗 IN · Entry');
        const chainGroup = config['proxy-groups'].find(group => group.name === '🔗 Entry → Exit');
        const chainedExit = config.proxies.find(proxy => proxy.name === '[Entry → Exit] Exit Node');
        const originalExit = config.proxies.find(proxy => proxy.name === 'Exit Node');
        const nodeSelect = config['proxy-groups'].find(group => group.name === '🚀 节点选择');

        expect(chainedExit['dialer-proxy']).toBe(entryGroup.name);
        expect(originalExit['dialer-proxy']).toBeUndefined();
        expect(chainGroup.proxies).toContain(chainedExit.name);
        expect(nodeSelect.proxies).toContain(chainGroup.name);
    });

    it('supports VLESS URI lines as chain sources', async () => {
        const singbox = new SingboxConfigBuilder(
            vlessInput, [], [], null, 'zh-CN', 'test-agent', false,
            false, null, null, '1.12', true, vlessChain
        );
        await singbox.build();
        const singboxExit = singbox.config.outbounds.find(outbound => outbound.tag === '[Entry VLESS → Exit VLESS] Exit VLESS');
        expect(singboxExit.detour).toBe('🔗 IN · Entry VLESS');

        const clashBuilder = new ClashConfigBuilder(
            vlessInput, [], [], null, 'zh-CN', 'test-agent', false,
            false, null, null, true, vlessChain
        );
        const clash = yaml.load(await clashBuilder.build());
        const clashExit = clash.proxies.find(proxy => proxy.name === '[Entry VLESS → Exit VLESS] Exit VLESS');
        expect(clashExit['dialer-proxy']).toBe('🔗 IN · Entry VLESS');
    });

    it('generates Surge underlying-proxy policies', async () => {
        mockSubscriptions();
        const builder = new SurgeConfigBuilder(input, [], [], null, 'zh-CN', 'test-agent', false, true, chain);
        await builder.build();

        const chainedExit = builder.config.proxies.find(proxy => proxy.startsWith('[Entry → Exit] Exit Node ='));
        const originalExit = builder.config.proxies.find(proxy => proxy.startsWith('Exit Node ='));
        const nodeSelect = builder.config['proxy-groups'].find(group => group.startsWith('🚀 节点选择 ='));

        expect(chainedExit).toContain('underlying-proxy=🔗 IN · Entry');
        expect(originalExit).not.toContain('underlying-proxy=');
        expect(builder.config['proxy-groups']).toContain('🔗 Entry → Exit = select, [Entry → Exit] Exit Node');
        expect(nodeSelect).toContain('🔗 Entry → Exit');
    });

    it('rejects chain parameters on the Xray URI endpoint', async () => {
        const app = createApp({
            kv: new MemoryKVAdapter(),
            logger: console,
            config: { configTtlSeconds: 60, shortLinkTtlSeconds: null }
        });
        const url = `http://localhost/xray?config=${encodeURIComponent(input)}&chain=${encodeURIComponent(JSON.stringify(chain))}`;
        const response = await app.request(url);

        expect(response.status).toBe(400);
        expect(await response.text()).toContain('not supported');
    });
});
