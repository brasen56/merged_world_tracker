/** Phase 2's chat-local configuration seam; the setup UI ships in Phase 3. */
import { getChatMeta } from '../core/context.js';
import { AMBIENT_CLIMATES, AMBIENT_SEASONS } from '../core/ambient_generator.js';

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
    };
}

/** No implicit climate or hemisphere before the first-enable setup exists. */
export function isConfigured(settings) {
    return Object.hasOwn(AMBIENT_CLIMATES, settings.climate)
        && ['north', 'south'].includes(settings.hemisphere)
        && AMBIENT_SEASONS.includes(settings.manualSeason)
        && Number.isFinite(settings.variability)
        && settings.variability >= 0 && settings.variability <= 1;
}