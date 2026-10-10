import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { parseAutoSelectInterval } from '../src/config/autoSelectInterval.js';

const input = [
    'ss://YWVzLTEyOC1nY206dGVzdA@entry.example:443#HK-Entry',
    'trojan://secret@exit.example:443?security=tls#US-Exit'
].join('\n');
const chain = { version: 2, exit: { line: 1 } };

describe('auto select interval', () => {
    it('renders the configurable interval on the webpage', async () => {
        const app = createApp();
        const html = await (await app.request('http://localhost/?lang=zh-CN')).text();
        expect(html).toContain('自动选择测速间隔（秒）');
        expect(html).toContain('x-model.number="autoSelectInterval"');
        expect(html).toContain('默认 3600 秒');
    });

    it('defaults to one hour and accepts only positive integer seconds', () => {
        expect(parseAutoSelectInterval()).toBe(3600);
        expect(parseAutoSelectInterval('120')).toBe(120);
        expect(parseAutoSelectInterval(1)).toBe(1);
        for (const value of ['', null, true, 0, -1, 1.5, '1m', '1e3', 'Infinity', Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => parseAutoSelectInterval(value)).toThrow('positive integer');
        }
    });

    for (const platform of ['singbox', 'clash', 'surge']) {
        for (const chained of [false, true]) {
            for (const interval of [undefined, 120]) {
                it(`${platform}: ${chained ? 'chain' : 'normal'} groups use ${interval ?? 3600} seconds`, async () => {
                    const app = createApp({ kv: new MemoryKVAdapter() });
                    const params = new URLSearchParams({ config: input, group_by_country: 'true' });
                    if (chained) params.set('chain', JSON.stringify(chain));
                    if (interval !== undefined) params.set('auto_select_interval', String(interval));
                    const response = await app.request(`http://localhost/${platform}?${params}`);
                    expect(response.status).toBe(200);
                    const seconds = interval ?? 3600;
                    let groups;
                    if (platform === 'singbox') {
                        const config = await response.json();
                        groups = config.outbounds.filter(group => group.type === 'urltest');
                        groups.forEach(group => expect(group.interval).toBe(`${seconds}s`));
                    } else if (platform === 'clash') {
                        const config = yaml.load(await response.text());
                        groups = config['proxy-groups'].filter(group => group.type === 'url-test');
                        groups.forEach(group => expect(group.interval).toBe(seconds));
                    } else {
                        groups = (await response.text()).split('\n').filter(line => line.includes(' = url-test,'));
                        groups.forEach(group => expect(group).toContain(`interval=${seconds}`));
                    }
                    expect(groups.length).toBeGreaterThanOrEqual(chained ? 2 : 1);
                });
            }
        }

        it(`${platform}: rejects invalid intervals`, async () => {
            const app = createApp({ logger: { error() {} } });
            for (const interval of ['', '0', '-1', '1.5', '1m', 'NaN', '1e3', '9007199254740992']) {
                const params = new URLSearchParams({ config: input, auto_select_interval: interval });
                const response = await app.request(`http://localhost/${platform}?${params}`);
                expect(response.status).toBe(400);
            }
        });
    }

    it('uses the same interval for generated provider health checks without changing download intervals', () => {
        const singbox = new SingboxConfigBuilder('', [], [], null, 'zh-CN', '', false, false, null, null, '1.12', true, null, 120);
        singbox.providerUrls = ['https://example.com/sub'];
        const [provider] = singbox.generateOutboundProviders();
        expect(provider.health_check.interval).toBe('120s');
        expect(provider.download_interval).toBe('24h');

        const clash = new ClashConfigBuilder('', [], [], null, 'zh-CN', '', false, false, null, null, true, null, 120);
        clash.providerUrls = ['https://example.com/sub'];
        const [clashProvider] = Object.values(clash.generateProxyProviders());
        expect(clashProvider['health-check'].interval).toBe(120);
        expect(clashProvider.interval).toBe(3600);
    });
});
