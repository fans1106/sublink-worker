import { describe, it, expect } from 'vitest';
import { formLogicFn } from '../src/components/formLogic.js';

describe('formLogic toString fix', () => {
  it('includes parseSurgeConfigInput definition in toString output', () => {
    const fnString = formLogicFn.toString();

    // Verify the function references parseSurgeConfigInput
    expect(fnString).toContain('parseSurgeConfigInput');

    // Verify the arrow function definitions ARE included
    expect(fnString).toMatch(/(?:const|var|let)\s+parseSurgeConfigInput\s*=/);
    expect(fnString).toMatch(/(?:const|var|let)\s+parseSurgeValue\s*=/);
    expect(fnString).toMatch(/(?:const|var|let)\s+convertSurgeIniToJson\s*=/);
  });

  it('does not contain __name calls that break in browser runtime', () => {
    const fnString = formLogicFn.toString();
    // Ensure no function declarations that esbuild would inject __name() for
    expect(fnString).not.toMatch(/^\s*function\s+parseSurgeValue\b/m);
    expect(fnString).not.toMatch(/^\s*function\s+convertSurgeIniToJson\b/m);
    expect(fnString).not.toMatch(/^\s*function\s+parseSurgeConfigInput\b/m);
  });

  it('formData() returns a valid Alpine data object', () => {
    // Simulate browser global environment using Function constructor
    const fakeWindow = { APP_TRANSLATIONS: {}, PREDEFINED_RULE_SETS: {} };
    const fn = new Function('window', '(' + formLogicFn.toString() + ')(); return window;');
    const result = fn(fakeWindow);
    const data = result.formData();
    expect(typeof data.submitForm).toBe('function');
    expect(typeof data.toggleAccordion).toBe('function');
    expect(data.showAdvanced).toBe(false);
  });

  it('serializes an OUT source without an IN selection', () => {
    const fakeWindow = { APP_TRANSLATIONS: {}, PREDEFINED_RULE_SETS: {} };
    const fn = new Function('window', '(' + formLogicFn.toString() + ')(); return window;');
    const data = fn(fakeWindow).formData();
    data.input = 'https://entry.example/sub\nhttps://exit.example/sub';
    data.chainEnabled = true;
    data.chainExitLine = '1';

    expect(data.buildChainConfig()).toEqual({
      version: 2,
      exit: { line: 1, label: 'exit.example #2' }
    });
  });

  it('lists proxy URI lines as chain sources', () => {
    const fakeWindow = { APP_TRANSLATIONS: {}, PREDEFINED_RULE_SETS: {} };
    const fn = new Function('window', '(' + formLogicFn.toString() + ')(); return window;');
    const data = fn(fakeWindow).formData();
    data.input = [
      'vless://uuid@entry.example.com:443#Entry%20VLESS',
      'trojan://secret@exit.example.com:443#Exit%20Trojan'
    ].join('\n');

    expect(data.subscriptionSources()).toEqual([
      { line: 0, label: 'Entry VLESS #1' },
      { line: 1, label: 'Exit Trojan #2' }
    ]);
  });

  it('restores the OUT source from both old and new subscription URLs', () => {
    const fakeWindow = { APP_TRANSLATIONS: {}, PREDEFINED_RULE_SETS: {} };
    const fn = new Function('window', '(' + formLogicFn.toString() + ')(); return window;');
    for (const chain of [
      { version: 2, exit: { line: 1 } },
      { version: 1, sources: [{ id: 'in', line: 0 }, { id: 'out', line: 1 }], links: [{ entry: 'in', exit: 'out' }] }
    ]) {
      const data = fn(fakeWindow).formData();
      const url = new URL('http://localhost/clash');
      url.searchParams.set('config', 'https://entry.example/sub\nhttps://exit.example/sub');
      url.searchParams.set('chain', JSON.stringify(chain));
      data.populateFormFromUrl(url);
      expect(data.chainEnabled).toBe(true);
      expect(data.chainExitLine).toBe('1');
      expect(data.buildChainConfig()).toEqual({ version: 2, exit: { line: 1, label: 'exit.example #2' } });
    }
  });
});
