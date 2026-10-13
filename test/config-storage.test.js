import { describe, expect, it, vi, afterEach } from 'vitest';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { ConfigStorageService } from '../src/services/configStorageService.js';

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
