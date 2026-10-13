import { describe, expect, it, vi } from 'vitest';
import { normalizeRuntime } from '../src/runtime/runtimeConfig.js';

vi.mock('ioredis', () => ({ default: class Redis {} }));

describe('createNodeRuntime', () => {
    it('defaults to no expiration after runtime normalization', async () => {
        const { createNodeRuntime } = await import('../src/runtime/node.js');
        const runtime = normalizeRuntime(createNodeRuntime({ DISABLE_MEMORY_KV: 'true' }));

        expect(runtime.config.configTtlSeconds).toBeNull();
    });

    it('preserves zero as the no-expiration config TTL', async () => {
        const { createNodeRuntime } = await import('../src/runtime/node.js');
        const runtime = createNodeRuntime({
            CONFIG_TTL_SECONDS: '0',
            DISABLE_MEMORY_KV: 'true'
        });

        expect(runtime.config.configTtlSeconds).toBe(0);
        expect(normalizeRuntime(runtime).config.configTtlSeconds).toBe(0);
    });
});
