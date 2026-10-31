/** Shared read-only projection for injection and user surfaces; owns no weather state. */
import { getContextSafe, getChatMeta } from './context.js';
import { injectionAllowed } from './settings.js';
import { getCurrentWorldState } from './metadata.js';
import { resolveAmbientTime } from './ambient_time.js';
import { AMBIENT_CLIMATES, AMBIENT_SEASONS, generateAmbientConditions } from './ambient_generator.js';
import { applyAmbientPin } from './ambient_pin.js';
import { auroraPossible, darkerRegime, generateAmbientDaylight, generateAmbientMoon, generateAmbientTide } from './ambient_astronomy.js';
import { generateAmbientAftermath } from './ambient_aftermath.js';
import { generateAmbientPhenomena } from './ambient_phenomena.js';

export function readAmbientConditions(settings, seed, type = 'normal') {
    const time = resolveAmbientTime({ messages: getContextSafe()?.chat, worldState: getCurrentWorldState(), type,
        calendar: getChatMeta('mwt_calendar'), hemisphere: settings.hemisphere });
    const ambient = applyAmbientPin(generateAmbientConditions({ ...settings, seed, time }), settings.pin, time);
    ambient.daylight = generateAmbientDaylight({ ...settings, seed, time });
    ambient.phenomena = generateAmbientPhenomena({ ...settings, seed, time, calendar: getChatMeta('mwt_calendar'), daylight: ambient.daylight,
        conditions: ambient.conditions, season: ambient.season });
    if (ambient.phenomena.light) {
        const rule = ambient.phenomena.light;
        // Light only ever darkens: the effective regime is the darker of the
        // override and the natural one, so night stays night under any rule.
        const regime = darkerRegime(rule.light, ambient.daylight.regime);
        const aurora = auroraPossible({ seed, hours: time.hours - ambient.daylight.clockAhead,
            latitude: ambient.daylight.latitude, regime });
        // Rule name plus effective regime; the Phenomena channel carries the
        // authored clause, so no override provenance is restated (D33 rev 4).
        ambient.daylight = { ...ambient.daylight, naturalRegime: ambient.daylight.regime, regime, aurora,
            description: `${rule.name}: ${regime}${aurora ? '; aurora possible' : ''}.` };
    }
    ambient.moon = generateAmbientMoon({ ...settings, time, daylight: ambient.daylight, conditions: ambient.conditions });
    ambient.tide = generateAmbientTide({ ...settings, seed, time });
    ambient.aftermath = generateAmbientAftermath({ ...settings, seed, time });
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