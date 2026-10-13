import { describe, expect, it, vi, afterEach } from 'vitest';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { ConfigStorageService } from '../src/services/configStorageService.js';
import yaml from 'js-yaml';

describe('saved override lifetime', () => {
    afterEach(() => vi.useRealTimers());

    it.each([
        ['clash', 'log-level: warning', { 'log-level': 'warning' }],
        ['singbox', '{"log":{"level":"warn"}}', { log: { level: 'warn' } }],
        ['surge', '{"general":{"ipv6":true}}', { general: { ipv6: true } }]
    ])('keeps %s overrides beyond the former 30-day default', async (type, content, expected) => {
        vi.useFakeTimers();
        const kv = new MemoryKVAdapter();
        const put = vi.spyOn(kv, 'put');
        const app = createApp({ kv });
        const response = await app.request('http://localhost/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, content })
        });
        expect(response.status).toBe(200);
        const id = await response.text();
        expect(put).toHaveBeenCalledWith(id, JSON.stringify(expected), undefined);

        await vi.advanceTimersByTimeAsync(60 * 24 * 60 * 60 * 1000);

        expect(await new ConfigStorageService(kv).getConfigById(id)).toEqual(expected);
    });
});

describe('saved override reuse', () => {
    it.each([
        ['clash', 'log-level: warning\ndns:\n  ipv6: false', '{"dns":{"ipv6":false},"log-level":"warning"}'],
        ['singbox', '{"log":{"level":"warn","disabled":false},"ntp":{"enabled":true}}', { ntp: { enabled: true }, log: { disabled: false, level: 'warn' } }],
        ['surge', '[General]\nipv6 = false\ntest-timeout = 0', { general: { 'test-timeout': 0, ipv6: false } }]
    ])('reuses equivalent %s content across formats and object key orders', async (type, first, second) => {
        const kv = new MemoryKVAdapter();
        const put = vi.spyOn(kv, 'put');
        const storage = new ConfigStorageService(kv);
        const id = await storage.saveConfig(type, first);
        const reused = await storage.saveConfig(type, second);
        expect(id).toMatch(new RegExp(`^${type}_[0-9a-f]{64}$`));
        expect(reused).toBe(id);
        expect(put).toHaveBeenCalledTimes(1);
        expect(await storage.getConfigById(reused)).not.toBeNull();
    });

    it('uses SHA-256 of canonical JSON for its ID', async () => {
        const storage = new ConfigStorageService(new MemoryKVAdapter());
        expect(await storage.saveConfig('clash', { b: 2, a: 1 })).toBe('clash_43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
    });

    it.each(['nameserver-policy', 'nameserver-policy!', 'proxy-server-nameserver-policy', 'proxy-server-nameserver-policy!'])('preserves %s order in storage and config IDs', async field => {
        const storage = new ConfigStorageService(new MemoryKVAdapter());
        const first = { '+.bza.edu.cn': ['10.2.0.5'], 'geosite:cn,private': ['223.5.5.5'] };
        const reversed = Object.fromEntries(Object.entries(first).reverse());
        const id = await storage.saveConfig('clash', { dns: { [field]: first, ipv6: true } });
        expect(Object.keys((await storage.getConfigById(id)).dns[field])).toEqual(Object.keys(first));
        expect(await storage.saveConfig('clash', { dns: { ipv6: true, [field]: first } })).toBe(id);
        expect(await storage.saveConfig('clash', { dns: { [field]: reversed, ipv6: true } })).not.toBe(id);
    });

    it('preserves DNS policy priority through upload, storage and subscription output', async () => {
        const app = createApp({ kv: new MemoryKVAdapter() });
        const policies = { 'zenith.test.bza.edu.cn': ['10.2.0.5'], 'geosite:cn,private': ['223.5.5.5'] };
        const saved = await app.request('http://localhost/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clash', content: yaml.dump({ dns: { 'nameserver-policy!': policies } }) })
        });
        expect(saved.status).toBe(200);
        const configId = await saved.text();
        const query = new URLSearchParams({ config: 'trojan://secret@node.example:443#Node', configId });
        const generated = await app.request(`http://localhost/clash?${query}`);
        expect(generated.status).toBe(200);
        const output = yaml.load(await generated.text());
        expect(Object.keys(output.dns['nameserver-policy'])).toEqual(Object.keys(policies));
        expect(output.dns['nameserver-policy']).toEqual(policies);
        expect(output.dns).not.toHaveProperty('nameserver-policy!');
    });

    it('preserves array order and distinguishes different values and client types', async () => {
        const storage = new ConfigStorageService(new MemoryKVAdapter());
        const variants = [
            ['clash', { dns: { nameserver: ['a', 'b'], ipv6: false }, port: 0 }],
            ['clash', { dns: { nameserver: ['b', 'a'], ipv6: false }, port: 0 }],
            ['clash', { dns: { nameserver: ['a', 'b'], ipv6: true }, port: 0 }],
            ['clash', { dns: { nameserver: ['a', 'b'], ipv6: false }, port: 1 }],
            ['singbox', { dns: { nameserver: ['a', 'b'], ipv6: false }, port: 0 }]
        ];
        const ids = await Promise.all(variants.map(([type, content]) => storage.saveConfig(type, content)));
        expect(new Set(ids).size).toBe(variants.length);
        expect(await storage.getConfigById(ids[0])).toEqual(variants[0][1]);
    });

    it('keeps old IDs and previous snapshots readable after content changes', async () => {
        const kv = new MemoryKVAdapter();
        const storage = new ConfigStorageService(kv);
        const first = { 'log-level': 'info' };
        const next = { 'log-level': 'warning' };
        await kv.put('clash_legacy', JSON.stringify(first));
        const originalId = await storage.saveConfig('clash', first);
        const nextId = await storage.saveConfig('clash', next, originalId);
        expect(nextId).not.toBe(originalId);
        expect(await storage.getConfigById(originalId)).toEqual(first);
        expect(await storage.getConfigById('clash_legacy')).toEqual(first);
        expect(await storage.getConfigById(nextId)).toEqual(next);
    });

    it('coalesces concurrent equivalent saves to one KV write across service instances', async () => {
        const kv = new MemoryKVAdapter();
        const put = vi.spyOn(kv, 'put');
        const ids = await Promise.all(Array.from({ length: 10 }, (_, index) => {
            const storage = new ConfigStorageService(kv);
            return storage.saveConfig('clash', index % 2 ? { port: 0, dns: { ipv6: false } } : { dns: { ipv6: false }, port: 0 });
        }));
        expect(new Set(ids).size).toBe(1);
        expect(put).toHaveBeenCalledTimes(1);
        expect(await new ConfigStorageService(kv).getConfigById(ids[0])).toEqual({ dns: { ipv6: false }, port: 0 });
    });

    it('allows retry after a failed write', async () => {
        const kv = new MemoryKVAdapter();
        const put = vi.spyOn(kv, 'put').mockRejectedValueOnce(new Error('KV unavailable'));
        const storage = new ConfigStorageService(kv);
        await expect(storage.saveConfig('clash', { port: 0 })).rejects.toThrow('KV unavailable');
        const id = await storage.saveConfig('clash', { port: 0 });
        expect(put).toHaveBeenCalledTimes(2);
        expect(await storage.getConfigById(id)).toEqual({ port: 0 });
    });

    it('reuses IDs through the save API and preserves old generated subscription links', async () => {
        const kv = new MemoryKVAdapter();
        const app = createApp({ kv });
        const save = content => app.request('http://localhost/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clash', content })
        });
        const first = await save('log-level: warning');
        expect(first.status).toBe(200);
        const id = await first.text();
        expect(await (await save({ 'log-level': 'warning' })).text()).toBe(id);
        const changed = await save('log-level: error');
        expect(await changed.text()).not.toBe(id);

        const params = new URLSearchParams({ config: 'trojan://secret@node.example:443#Node', configId: id });
        const generated = await app.request(`http://localhost/clash?${params}`);
        expect(generated.status).toBe(200);
        expect(await generated.text()).toContain('log-level: warning');
    });

    it('keeps configured expiration from the initial save and rebuilds after expiry', async () => {
        vi.useFakeTimers();
        try {
            const kv = new MemoryKVAdapter();
            const put = vi.spyOn(kv, 'put');
            const storage = new ConfigStorageService(kv, { configTtlSeconds: 60 });
            const id = await storage.saveConfig('clash', { port: 0 });
            await vi.advanceTimersByTimeAsync(30000);
            expect(await storage.saveConfig('clash', { port: 0 })).toBe(id);
            expect(put).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(31000);
            expect(await storage.getConfigById(id)).toBeNull();
            expect(await storage.saveConfig('clash', { port: 0 })).toBe(id);
            expect(put).toHaveBeenCalledTimes(2);
            expect(await storage.getConfigById(id)).toEqual({ port: 0 });
        } finally {
            vi.useRealTimers();
        }
    });
});
