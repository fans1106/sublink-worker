import { parseChainConfig } from '../chains/chainConfig.js';
import { InvalidPayloadError } from '../services/errors.js';
import { DEFAULT_AUTO_SELECT_INTERVAL, parseAutoSelectInterval } from '../config/autoSelectInterval.js';

const DEFAULTS = {
    input: '',
    chainEnabled: false,
    chainExitLine: '',
    selectedRules: [],
    selectedPredefinedRule: 'custom',
    customRules: [],
    groupByCountry: false,
    includeAutoSelect: true,
    autoSelectInterval: DEFAULT_AUTO_SELECT_INTERVAL,
    enableClashUI: false,
    externalController: '',
    externalUiDownloadUrl: '',
    customUA: '',
    configType: 'singbox',
    configEditor: '',
    currentConfigId: ''
};

export function normalizeFormPreset(content) {
    if (!content || content.version !== 1 || Array.isArray(content)) {
        throw new InvalidPayloadError('Invalid preset: expected version 1');
    }
    if (new TextEncoder().encode(JSON.stringify(content)).length > 256 * 1024) {
        throw new InvalidPayloadError('Preset exceeds 256 KB');
    }

    const preset = { version: 1 };
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
        const value = content[key] ?? fallback;
        if (Array.isArray(fallback) ? !Array.isArray(value) : typeof value !== typeof fallback) {
            throw new InvalidPayloadError(`Invalid preset field: ${key}`);
        }
        preset[key] = value;
    }
    if (!preset.input.trim()) {
        throw new InvalidPayloadError('Preset input must not be empty');
    }
    preset.autoSelectInterval = parseAutoSelectInterval(preset.autoSelectInterval);
    if (!['singbox', 'clash', 'surge'].includes(preset.configType)
        || !['minimal', 'balanced', 'comprehensive', 'custom'].includes(preset.selectedPredefinedRule)
        || !preset.selectedRules.every(rule => typeof rule === 'string')
        || !preset.customRules.every(rule => rule && typeof rule === 'object' && !Array.isArray(rule))) {
        throw new InvalidPayloadError('Invalid preset settings');
    }
    if (preset.chainEnabled) {
        if (preset.chainExitLine === '') {
            throw new InvalidPayloadError('Preset chain OUT source must be selected');
        }
        parseChainConfig({
            version: 2,
            exit: { line: Number(preset.chainExitLine) }
        }, preset.input);
    }
    return preset;
}
