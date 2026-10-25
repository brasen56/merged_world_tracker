/** Chat-local settings. Setup never silently supplies a climate. */
import { getChatMeta, getContextSafe } from '../core/context.js';
import { patchChatMeta } from '../core/metadata.js';
import { AMBIENT_CLIMATES, AMBIENT_SEASONS } from '../core/ambient_generator.js';
import { isAmbientPin } from '../core/ambient_pin.js';
import { isAmbientClockAhead, isMoonEpochOffset } from '../core/ambient_astronomy.js';

export const SETTINGS_KEY = 'mwt_ambient';

export function getSettings() {
    const raw = getChatMeta(SETTINGS_KEY);
    const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        enabled: settings.enabled === true,
        climate: settings.climate,
        hemisphere: settings.hemisphere,
        latitude: settings.latitude ?? null,
        clockAhead: settings.clockAhead ?? 0,
        moonEpochOffset: settings.moonEpochOffset ?? null,
        manualSeason: settings.manualSeason ?? 'spring',
        variability: settings.variability ?? 0.5,
        setupAsked: settings.setupAsked === true,
        pin: settings.pin ?? null,
    };
}

export function saveSettings(patch) {
    if (!getContextSafe()) throw new Error('No active chat.');
    const next = { ...getSettings(), ...patch };
    if (Object.hasOwn(patch, 'latitude') && patch.latitude !== null
        && (!Number.isFinite(patch.latitude) || patch.latitude < 0 || patch.latitude > 90)) throw new Error('Latitude must be a magnitude between 0 and 90, or blank for the climate default.');
    if (Object.hasOwn(patch, 'clockAhead') && !isAmbientClockAhead(patch.clockAhead)) throw new Error('Clock ahead must be 0–2 hours in half-hour steps.');
    if (Object.hasOwn(patch, 'moonEpochOffset') && patch.moonEpochOffset !== null
        && !isMoonEpochOffset(patch.moonEpochOffset)) throw new Error('Moon anchor must resolve to a valid story date and time.');
    if ((next.enabled || Object.hasOwn(patch, 'climate')) && !isConfigured(next)) throw new Error('Choose a valid climate, hemisphere, season and variability first.');
    if (Object.hasOwn(patch, 'pin') && patch.pin !== null && !isAmbientPin(patch.pin)) throw new Error('Invalid ambient pin.');
    const saved = patchChatMeta(SETTINGS_KEY, patch);
    if (next.enabled) ensureSeed();
    return saved;
}

export function ensureSeed(reseed = false) {
    const seed = getChatMeta(SETTINGS_KEY)?.seed;
    if (!reseed && Number.isFinite(seed)) return seed;
    if (!getContextSafe()) throw new Error('No active chat.');
    const next = Math.floor(Math.random() * 4294967296);
    patchChatMeta(SETTINGS_KEY, { seed: next });
    return next;
}

/** No implicit climate or hemisphere before the first-enable setup exists. */
export function isConfigured(settings) {
    return Object.hasOwn(AMBIENT_CLIMATES, settings.climate)
        && ['north', 'south'].includes(settings.hemisphere)
        && AMBIENT_SEASONS.includes(settings.manualSeason)
        && Number.isFinite(settings.variability)
        && settings.variability >= 0 && settings.variability <= 1;
}