import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { parseVless } from '../src/parsers/protocols/vlessParser.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';

const baseUrl = 'vless://12345678-1234-1234-1234-123456789abc@example.com:443?security=reality&sni=example.com&pbk=public-key&sid=01234567';

describe('VLESS support-x25519mlkem768', () => {
    it('parses boolean values from VLESS URIs', () => {
        expect(parseVless(`${baseUrl}&support-x25519mlkem768=true#Enabled`).tls.reality.support_x25519mlkem768).toBe(true);
        expect(parseVless(`${baseUrl}&support-x25519mlkem768=false#Disabled`).tls.reality.support_x25519mlkem768).toBe(false);
        expect(parseVless(`${baseUrl}#Default`).tls.reality.support_x25519mlkem768).toBeUndefined();
    });

    it('emits the field in Mihomo output', async () => {
        const builder = new ClashConfigBuilder(
            `${baseUrl}&support-x25519mlkem768=true#Enabled`,
            [], [], null, 'zh-CN', 'test-agent'
        );
        const config = yaml.load(await builder.build());
        const proxy = config.proxies.find(item => item.name === 'Enabled');

        expect(proxy['reality-opts']['support-x25519mlkem768']).toBe(true);
        expect(proxy['support-x25519mlkem768']).toBeUndefined();
    });

    it('preserves the field from Clash YAML subscriptions', async () => {
        const input = `
proxies:
  - name: YAML-VLESS
    type: vless
    server: example.com
    port: 443
    uuid: 12345678-1234-1234-1234-123456789abc
    tls: true
    reality-opts:
      public-key: public-key
      short-id: 01234567
      support-x25519mlkem768: true
`;
        const builder = new ClashConfigBuilder(input, [], [], null, 'zh-CN', 'test-agent');
        const config = yaml.load(await builder.build());
        const proxy = config.proxies.find(item => item.name === 'YAML-VLESS');

        expect(proxy['reality-opts']['support-x25519mlkem768']).toBe(true);
        expect(proxy['support-x25519mlkem768']).toBeUndefined();
    });

    it('does not leak the Mihomo-only field into Sing-Box output', async () => {
        const builder = new SingboxConfigBuilder(
            `${baseUrl}&support-x25519mlkem768=true#Enabled`,
            [], [], null, 'zh-CN', 'test-agent'
        );
        await builder.build();
        const outbound = builder.config.outbounds.find(item => item.tag === 'Enabled');

        expect(outbound.tls.reality.support_x25519mlkem768).toBeUndefined();
        expect(outbound.tls.reality.public_key).toBe('public-key');
    });
});
