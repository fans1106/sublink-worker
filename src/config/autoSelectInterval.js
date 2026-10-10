import { InvalidPayloadError } from '../services/errors.js';

export const DEFAULT_AUTO_SELECT_INTERVAL = 3600;

export function parseAutoSelectInterval(value = DEFAULT_AUTO_SELECT_INTERVAL) {
    const seconds = Number(value);
    if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(seconds) || seconds < 1) {
        throw new InvalidPayloadError('Auto select interval must be a positive integer in seconds');
    }
    return seconds;
}
