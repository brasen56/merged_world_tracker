/** Shared read-only projection for injection and user surfaces; owns no weather state. */
import { getContextSafe, getChatMeta } from './context.js';
import { injectionAllowed } from './settings.js';
import { getCurrentWorldState } from './metadata.js';
import { resolveAmbientTime } from './ambient_time.js';
import { AMBIENT_CLIMATES, AMBIENT_SEASONS, generateAmbientConditions } from './ambient_generator.js';
import { applyAmbientPin } from './ambient_pin.js';
import { generateAmbientDaylight } from './ambient_astronomy.js';

export function readAmbientConditions(settings, seed, type = 'normal') {
    const time = resolveAmbientTime({ messages: getContextSafe()?.chat, worldState: getCurrentWorldState(), type });
    const ambient = applyAmbientPin(generateAmbientConditions({ ...settings, seed, time }), settings.pin, time);
    ambient.daylight = generateAmbientDaylight({ ...settings, seed, time });
    return { time, ambient };
}

export function getAmbientStatus() {
    const settings = getChatMeta('mwt_ambient') || {};
    if (settings.enabled !== true) return { state: 'off' };
    if (!Object.hasOwn(AMBIENT_CLIMATES, settings.climate)
        || !['north', 'south'].includes(settings.hemisphere)
        || !AMBIENT_SEASONS.includes(settings.manualSeason ?? 'spring')
        || !Number.isFinite(settings.variability ?? 0.5)
        || (settings.variability ?? 0.5) < 0 || (settings.variability ?? 0.5) > 1) return { state: 'setup required' };
    if (!Number.isFinite(settings.seed)) return { state: 'ready; conditions available after first generation' };
    return { state: injectionAllowed('Ambient') ? 'enabled' : 'blocked by panic switch',
        ...readAmbientConditions(settings, settings.seed), pin: settings.pin ?? null };
}