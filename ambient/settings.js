/** Chat-local settings. Setup never silently supplies a climate. */
import { getChatMeta, getContextSafe } from '../core/context.js';
import { patchChatMeta } from '../core/metadata.js';
import { AMBIENT_CLIMATES, AMBIENT_SEASONS } from '../core/ambient_generator.js';
import { isAmbientPin } from '../core/ambient_pin.js';

export const SETTINGS_KEY = 'mwt_ambient';

export function getSettings() {
    const raw = getChatMeta(SETTINGS_KEY);
    const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        enabled: settings.enabled === true,
        climate: settings.climate,
        hemisphere: settings.hemisphere,
        manualSeason: settings.manualSeason ?? 'spring',
        variability: settings.variability ?? 0.5,
        setupAsked: settings.setupAsked === true,
        pin: settings.pin ?? null,
    };
}

export function saveSettings(patch) {
    if (!getContextSafe()) throw new Error('No active chat.');
    const next = { ...getSettings(), ...patch };
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