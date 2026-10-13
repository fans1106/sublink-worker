import { describe, it, expect } from 'vitest';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';
import { SurgeConfigBuilder } from '../src/builders/SurgeConfigBuilder.js';
import { parseSingboxJson, parseClashYaml, parseSurgeIni } from '../src/parsers/subscription/subscriptionContentParser.js';
import { encodeBase64 } from '../src/utils.js';

const clash = `proxies:
  - name: HK-Node
    type: ss
    server: hk.example.com
    port: 443
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: Upstream Group
    type: url-test
    proxies: []
dns:
  nameserver: [upstream-dns.example]
rules: [MATCH,Upstream Group]
`;
const singbox = JSON.stringify({
    outbounds: [
        { type: 'shadowsocks', tag: 'HK-Node', server: 'hk.example.com', server_port: 443, method: 'aes-128-gcm', password: 'test', detour: 'Upstream Group' },
        { type: 'selector', tag: 'Upstream Group', outbounds: ['HK-Node'] }
    ],
    dns: { servers: [{ tag: 'upstream-dns', server: 'upstream-dns.example' }] },
    route: { final: 'Upstream Group' }
});
const surge = `[General]
dns-server = upstream-dns.example
[Proxy]
HK-Node = ss, hk.example.com, 443, encrypt-method=aes-128-gcm, password=test
[Proxy Group]
Upstream Group = select, HK-Node
[Rule]
FINAL,Upstream Group
`;
const inputs = [['Clash', clash, parseClashYaml], ['Sing-Box', singbox, parseSingboxJson], ['Surge', surge, parseSurgeIni]];
const builders = [['Clash', ClashConfigBuilder], ['Sing-Box', SingboxConfigBuilder], ['Surge', SurgeConfigBuilder]];

describe('subscriptions import nodes only', () => {
    it.each(inputs)('%s parser discards groups, DNS and routing configuration', (_name, input, parse) => {
        const result = parse(input);
        expect(result.proxies.map(proxy => proxy.tag)).toEqual(['HK-Node']);
        expect(result.config).toBeNull();
    });

    describe.each(builders)('%s output', (_name, Builder) => {
        it.each(inputs)('imports only nodes from a %s config', async (_inputName, input) => {
            const builder = new Builder(input, [], [], null, 'zh-CN', 'test-agent');
            await builder.build();
            const output = JSON.stringify(builder.config);
            expect(output).toContain('HK-Node');
            expect(output).toContain('📥 导入配置');
            expect(output).not.toContain('Upstream Group');
            expect(output).not.toContain('upstream-dns.example');
            expect(builder.getProxies()).toHaveLength(1);
            expect(builder.getSubscriptionUserinfo()).toBeUndefined();
        });

        it('applies the same import policy to Base64 configs', async () => {
            const builder = new Builder(encodeBase64(clash), [], [], null, 'zh-CN', 'test-agent');
            await builder.build();
            expect(JSON.stringify(builder.config)).toContain('📥 导入配置');
            expect(JSON.stringify(builder.config)).not.toContain('Upstream Group');
        });
    });
});
