import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { normalizeFormPreset } from '../src/presets/formPreset.js';
import { formLogicFn } from '../src/components/formLogic.js';

const input = [
    'vless://11111111-1111-1111-1111-111111111111@entry.example:443?security=tls#Entry',
    'trojan://secret@exit.example:443?security=tls#Exit'
].join('\n');

const preset = {
    version: 1,
    input,
    chainEnabled: true,
    chainExitLine: '1',
    selectedPredefinedRule: 'custom',
    selectedRules: ['Google'],
    customRules: [{ name: 'Work', domain_suffix: ['example.com'] }],
    groupByCountry: true,
    includeAutoSelect: false,
    autoSelectInterval: 120,
    enableClashUI: true,
    externalController: '127.0.0.1:9090',
    externalUiDownloadUrl: 'https://example.com/ui.zip',
    customUA: 'test-agent',
    configType: 'singbox',
    configEditor: '{"log":{"level":"warn"}}',
    currentConfigId: ''
};

const createTestApp = (kv = new MemoryKVAdapter(), ttl = null) => createApp({
    kv, logger: console, config: { configTtlSeconds: ttl }
});

const postPreset = (app, content = preset) => app.request('http://localhost/presets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(content)
});

function browserForm(app) {
    const customRulesInput = { value: '[]' };
    const window = {
        APP_TRANSLATIONS: {},
        location: { origin: 'http://localhost', href: 'http://localhost/?configId=singbox_stale', search: '?configId=singbox_stale' },
        history: { replaceState: vi.fn() },
        dispatchEvent: vi.fn(event => { customRulesInput.value = JSON.stringify(event.detail.rules); })
    };
    const fetch = vi.fn((url, options) => app.request(`http://localhost${url}`, options));
    const document = { querySelector: () => customRulesInput };
    const CustomEvent = function (type, options) { this.type = type; this.detail = options.detail; };
    const confirm = vi.fn(() => true);
    const alert = vi.fn();
    const storage = new Map();
    const localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value))
    };
    const data = new Function('window', 'document', 'fetch', 'CustomEvent', 'confirm', 'alert', 'localStorage',
        `(${formLogicFn.toString()})(); return window.formData();`)(window, document, fetch, CustomEvent, confirm, alert, localStorage);
    data.$nextTick = async callback => callback();
    data.$watch = vi.fn();
    return { data, window, customRulesInput, fetch, confirm, alert, localStorage };
}

describe('form presets', () => {
    it('stores and retrieves the complete form without a TTL', async () => {
        const kv = new MemoryKVAdapter();
        const put = vi.spyOn(kv, 'put');
        const app = createTestApp(kv, 60);
        const saved = await postPreset(app);
        expect(saved.status).toBe(200);
        const { id } = await saved.json();
        expect(id).toMatch(/^preset_[A-Za-z0-9]{8}$/);
        expect(put).toHaveBeenCalledWith(id, JSON.stringify(normalizeFormPreset(preset)), undefined);
        const response = await app.request(`http://localhost/presets/${id}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(preset);
        expect(response.headers.get('cache-control')).toBe('no-store');
        await kv.delete(id);
    });

    it('keeps presets after the configured base config TTL expires', async () => {
        vi.useFakeTimers();
        try {
            const kv = new MemoryKVAdapter();
            const app = createTestApp(kv, 60);
            const saved = await postPreset(app);
            const { id } = await saved.json();
            const baseConfig = await app.request('http://localhost/config', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'singbox', content: { log: { level: 'warn' } } })
            });
            expect(baseConfig.status).toBe(200);
            const configId = await baseConfig.text();
            expect(await kv.get(configId)).not.toBeNull();

            await vi.advanceTimersByTimeAsync(61000);

            expect(await kv.get(configId)).toBeNull();
            const response = await app.request(`http://localhost/presets/${id}`);
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(preset);
        } finally {
            vi.useRealTimers();
        }
    });

    it('updates a preset without changing its ID or setting a TTL, then deletes only that preset', async () => {
        const kv = new MemoryKVAdapter();
        const put = vi.spyOn(kv, 'put');
        const app = createTestApp(kv, 60);
        const { id } = await (await postPreset(app)).json();
        await kv.put('singbox_shared', '{"log":{"level":"warn"}}');
        const updated = { ...preset, groupByCountry: false, customUA: 'updated-agent' };
        const response = await app.request(`http://localhost/presets/${id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updated)
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id });
        expect(put).toHaveBeenLastCalledWith(id, JSON.stringify(normalizeFormPreset(updated)), undefined);
        expect(await (await app.request(`http://localhost/presets/${id}`)).json()).toEqual(updated);

        const deleted = await app.request(`http://localhost/presets/${id}`, { method: 'DELETE' });
        expect(deleted.status).toBe(204);
        expect(await kv.get('singbox_shared')).not.toBeNull();
        expect((await app.request(`http://localhost/presets/${id}`)).status).toBe(404);
        expect((await app.request(`http://localhost/presets/${id}`, { method: 'DELETE' })).status).toBe(404);
        expect((await app.request(`http://localhost/presets/${id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updated)
        })).status).toBe(404);
    });

    it('rejects invalid updates without changing the stored preset or other config IDs', async () => {
        const kv = new MemoryKVAdapter();
        const app = createTestApp(kv);
        const { id } = await (await postPreset(app)).json();
        for (const body of ['{', JSON.stringify({ ...preset, input: '' })]) {
            expect((await app.request(`http://localhost/presets/${id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body
            })).status).toBe(400);
        }
        expect(await (await app.request(`http://localhost/presets/${id}`)).json()).toEqual(preset);
        const get = vi.spyOn(kv, 'get');
        const remove = vi.spyOn(kv, 'delete');
        for (const method of ['PUT', 'DELETE']) {
            expect((await app.request('http://localhost/presets/singbox_12345678', { method })).status).toBe(400);
        }
        expect(get).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
    });

    it('validates payloads and chain sources before saving', async () => {
        const app = createTestApp();
        for (const content of [null, { version: 2 }, { ...preset, input: '' },
            { ...preset, chainExitLine: '' }, { ...preset, chainExitLine: '99' },
            { ...preset, includeAutoSelect: 'false' }, { ...preset, selectedRules: [1] },
            { ...preset, input: 'a'.repeat(256 * 1024) }]) {
            expect((await postPreset(app, content)).status).toBe(400);
        }
        expect((await app.request('http://localhost/presets', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
        })).status).toBe(400);
    });

    it('returns missing, invalid and unavailable storage errors without reading other config IDs', async () => {
        const kv = new MemoryKVAdapter();
        const get = vi.spyOn(kv, 'get');
        const app = createTestApp(kv);
        expect((await app.request('http://localhost/presets/preset_12345678')).status).toBe(404);
        get.mockClear();
        expect((await app.request('http://localhost/presets/singbox_12345678')).status).toBe(400);
        expect(get).not.toHaveBeenCalled();
        const noStorage = createTestApp(null);
        expect((await postPreset(noStorage)).status).toBe(501);
        for (const method of ['GET', 'PUT', 'DELETE']) {
            expect((await noStorage.request('http://localhost/presets/preset_12345678', { method })).status).toBe(501);
        }
    });

    it('saves and restores the browser form, including custom rules and the base config snapshot', async () => {
        const kv = new MemoryKVAdapter();
        const app = createTestApp(kv);
        const source = browserForm(app);
        Object.assign(source.data, preset);
        source.customRulesInput.value = JSON.stringify(preset.customRules);
        await source.data.savePreset();
        expect(source.data.presetError).toBe(false);
        expect(source.data.presetId).toMatch(/^preset_/);

        const restored = browserForm(app);
        restored.data.presetId = source.data.presetId;
        await restored.data.importPreset();
        expect(restored.data.presetError).toBe(false);
        expect(restored.data.getFormPreset()).toEqual({
            ...preset, currentConfigId: restored.data.currentConfigId
        });
        expect(restored.data.currentConfigId).toMatch(/^singbox_/);
        expect(restored.data.currentConfigId).not.toBe(source.data.currentConfigId);
        expect(JSON.parse(await kv.get(restored.data.currentConfigId))).toEqual({ log: { level: 'warn' } });
        expect(restored.window.dispatchEvent).toHaveBeenCalledOnce();
        expect(restored.window.history.replaceState.mock.calls.at(-1)[2]).toContain(`presetId=${source.data.presetId}`);
    });

    it('restores empty custom rules and clears an unrelated active base config', async () => {
        const app = createTestApp();
        const saved = await postPreset(app, { version: 1, input });
        const { id } = await saved.json();
        const restored = browserForm(app);
        restored.customRulesInput.value = JSON.stringify(preset.customRules);
        restored.data.currentConfigId = 'singbox_stale';
        restored.data.chainEnabled = true;
        restored.data.presetId = id;
        await restored.data.importPreset();
        expect(restored.data.presetError).toBe(false);
        expect(restored.data.chainEnabled).toBe(false);
        expect(restored.data.currentConfigId).toBe('');
        expect(restored.data.autoSelectInterval).toBe(3600);
        expect(restored.data.getFormPreset().customRules).toEqual([]);
        expect(restored.window.history.replaceState.mock.calls[0][2]).not.toContain('configId');
    });

    it('updates and deletes presets from the browser while retaining the current form', async () => {
        const app = createTestApp();
        const form = browserForm(app);
        Object.assign(form.data, preset);
        await form.data.savePreset();
        const id = form.data.presetId;
        form.data.customUA = 'changed-agent';
        await form.data.savePreset(true);
        expect(form.data.presetError).toBe(false);
        expect(form.data.presetId).toBe(id);
        expect((await (await app.request(`http://localhost/presets/${id}`)).json()).customUA).toBe('changed-agent');

        form.confirm.mockReturnValueOnce(false);
        const calls = form.fetch.mock.calls.length;
        await form.data.deletePreset();
        expect(form.fetch).toHaveBeenCalledTimes(calls);
        expect(form.data.presetId).toBe(id);
        await form.data.deletePreset();
        expect(form.data.presetError).toBe(false);
        expect(form.data.presetId).toBe('');
        expect(form.data.input).toBe(preset.input);
        expect(form.data.customUA).toBe('changed-agent');
        expect(form.window.history.replaceState.mock.calls.at(-1)[2]).not.toContain('presetId');
        expect((await app.request(`http://localhost/presets/${id}`)).status).toBe(404);
    });

    it('keeps unrelated browser state out of stored presets', () => {
        const normalized = normalizeFormPreset({ ...preset, loading: true, generatedLinks: { clash: 'old' } });
        expect(normalized).toEqual(preset);
    });

    it('defaults old presets to one hour and rejects invalid interval values', async () => {
        expect(normalizeFormPreset({ version: 1, input }).autoSelectInterval).toBe(3600);
        const app = createTestApp();
        for (const autoSelectInterval of [0, -1, 1.5, '120', Number.MAX_SAFE_INTEGER + 1]) {
            expect((await postPreset(app, { ...preset, autoSelectInterval })).status).toBe(400);
        }
    });

    it('restores the interval from browser storage and registers persistence', () => {
        const form = browserForm(createTestApp());
        form.localStorage.setItem('autoSelectInterval', 180);
        form.data.init();
        expect(form.data.autoSelectInterval).toBe(180);
        const [, persist] = form.data.$watch.mock.calls.find(([key]) => key === 'autoSelectInterval');
        persist(240);
        expect(form.localStorage.getItem('autoSelectInterval')).toBe('240');

        const invalid = browserForm(createTestApp());
        invalid.localStorage.setItem('autoSelectInterval', '-1');
        invalid.data.init();
        expect(invalid.data.autoSelectInterval).toBe(3600);
    });

    it('blocks invalid intervals before generating links or saving presets', async () => {
        const form = browserForm(createTestApp());
        form.data.input = input;
        for (const interval of ['', 0, -1, 1.5, 'abc']) {
            form.data.autoSelectInterval = interval;
            await form.data.submitForm();
            await form.data.savePreset();
        }
        expect(form.data.generatedLinks).toBeNull();
        expect(form.fetch).not.toHaveBeenCalled();
        expect(form.alert).toHaveBeenCalledTimes(10);
    });

    it('includes the interval in generated links and restores it from imported links', async () => {
        vi.useFakeTimers();
        try {
            const form = browserForm(createTestApp());
            form.data.input = input;
            form.data.autoSelectInterval = 90;
            await form.data.submitForm();
            for (const platform of ['singbox', 'clash', 'surge']) {
                const url = new URL(form.data.generatedLinks[platform]);
                expect(url.searchParams.get('auto_select_interval')).toBe('90');
                const restored = browserForm(createTestApp());
                restored.data.populateFormFromUrl(url);
                expect(restored.data.autoSelectInterval).toBe(90);
            }
            form.data.populateFormFromUrl(new URL('http://localhost/clash?config=test'));
            expect(form.data.autoSelectInterval).toBe(3600);
        } finally {
            vi.useRealTimers();
        }
    });

    it('imports old presets using their OUT source and discards the old IN selection', () => {
        const normalized = normalizeFormPreset({ ...preset, chainEntryLine: '0' });
        expect(normalized).toEqual(preset);
        expect(normalized.chainEntryLine).toBeUndefined();
    });
});
