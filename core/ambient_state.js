/** Shared read-only projection for injection and user surfaces; owns no weather state. */
import { getContextSafe, getChatMeta } from './context.js';
import { injectionAllowed } from './settings.js';
import { getCurrentWorldState } from './metadata.js';
import { resolveAmbientTime } from './ambient_time.js';
import { generateAmbientConditions } from './ambient_generator.js';
import { applyAmbientPin } from './ambient_pin.js';

export function readAmbientConditions(settings, seed, type = 'normal') {
    const time = resolveAmbientTime({ messages: getContextSafe()?.chat, worldState: getCurrentWorldState(), type });
    const ambient = applyAmbientPin(generateAmbientConditions({ ...settings, seed, time }), settings.pin, time);
    return { time, ambient };
}

export function getAmbientStatus() {
    const settings = getChatMeta('mwt_ambient') || {};
    if (settings.enabled !== true) return { state: 'off' };
    if (!settings.climate || !settings.hemisphere) return { state: 'setup required' };
    if (!Number.isFinite(settings.seed)) return { state: 'ready; conditions available after first generation' };
    return { state: injectionAllowed('Ambient') ? 'enabled' : 'blocked by panic switch',
        ...readAmbientConditions(settings, settings.seed), pin: settings.pin ?? null };
}