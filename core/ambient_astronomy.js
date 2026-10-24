/** Pure story-sky facts. No host clock, persistence, locale or ST dependencies. */
import { AMBIENT_HOUR_MS } from './ambient_time.js';

export const AMBIENT_LATITUDES = Object.freeze({ arctic: 65, temperate: 45, mediterranean: 40, desert: 25, tropical: 10 });
export const DAYLIGHT_VOCABULARY = Object.freeze({
    daylight: 'daylight', twilight: 'civil twilight', darkness: 'darkness',
    long: 'long summer light, white-night borders', short: 'short winter day',
    ordinary: 'daylight cycle', golden: 'low sun, golden light',
    polarDay: 'the sun does not set; daylight through the night',
    polarNight: 'the sun will not rise today', whiteNight: 'no true darkness',
    aurora: 'aurora possible',
});
const RAD = Math.PI / 180;

export function flooredMod(value, period) {
    return ((value % period) + period) % period;
}

/** Invalid optional stored values fall back safely; defaults are never persisted. */
export function resolveAmbientLatitude({ latitude, climate } = {}) {
    const isDefault = !Number.isFinite(latitude) || latitude < 0 || latitude > 90;
    return { latitude: isDefault ? (AMBIENT_LATITUDES[climate] ?? 45) : latitude, isDefault };
}

export function isAmbientClockAhead(value) {
    return Number.isFinite(value) && value >= 0 && value <= 2 && Number.isInteger(value * 2);
}

/** Crossing times in sun hours, or an explicitly empty/full above-altitude interval. */
export function solarCrossings(latitude, declination, altitude = -0.833) {
    const center = Math.sin(latitude * RAD) * Math.sin(declination * RAD);
    const amplitude = Math.cos(latitude * RAD) * Math.cos(declination * RAD);
    const threshold = Math.sin(altitude * RAD);
    // Checking extrema also handles the exact poles without dividing by zero.
    if (center - amplitude >= threshold) return { state: 'always-above', rise: null, set: null, duration: 24 };
    if (center + amplitude <= threshold) return { state: 'always-below', rise: null, set: null, duration: 0 };
    const angle = Math.acos(Math.max(-1, Math.min(1, (threshold - center) / amplitude))) / RAD;
    return { state: 'crosses', rise: 12 - angle / 15, set: 12 + angle / 15, duration: 2 * angle / 15 };
}

export function roundSkyTime(sunHours, clockAhead = 0) {
    const minutes = flooredMod(Math.round((sunHours + clockAhead) * 2) * 30, 1440);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Seeded per-night heuristic, not a geomagnetic forecast. Smoothly scales 50–65°. */
export function auroraPossible({ seed = 0, hours, latitude, regime }) {
    if (regime !== 'darkness') return false;
    const chance = Math.max(0, Math.min(1, (Math.abs(latitude) - 50) / 15)) * 0.35;
    // Noon-to-noon night identity keeps an evening and its following dawn together.
    const night = Math.floor((hours - 12) / 24);
    const key = `${seed}:aurora:${night}`;
    let hash = 2166136261;
    for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
    return (hash >>> 0) / 4294967296 < chance;
}

export function generateAmbientDaylight({ time, latitude, climate, hemisphere = 'north', manualSeason = 'spring', clockAhead = 0, seed = 0 }) {
    const hours = typeof time === 'number' ? time : time?.hours;
    if (!Number.isFinite(hours)) throw new RangeError('Story hours must be finite.');
    const hasCalendar = typeof time === 'number' || time?.month != null;
    const resolved = resolveAmbientLatitude({ latitude, climate });
    let declination;
    if (hasCalendar) {
        const date = new Date(hours * AMBIENT_HOUR_MS);
        if (!Number.isFinite(date.getTime())) throw new RangeError('Story date is outside the supported range.');
        const start = new Date(0);
        start.setUTCFullYear(date.getUTCFullYear(), 0, 1);
        start.setUTCHours(0, 0, 0, 0);
        const day = Math.floor((date.getTime() - start.getTime()) / (24 * AMBIENT_HOUR_MS)) + 1;
        declination = -23.44 * Math.cos(2 * Math.PI / 365 * (day + 10));
    } else {
        // The manual season is already local: use |latitude|, not a second south flip.
        declination = 23.44 * ({ winter: -1, spring: 0, summer: 1, autumn: 0 }[manualSeason] ?? 0);
    }
    const signedLatitude = resolved.latitude * (hasCalendar && hemisphere === 'south' ? -1 : 1);
    const sun = solarCrossings(signedLatitude, declination);
    const civil = solarCrossings(signedLatitude, declination, -6);
    const hour = flooredMod(hours, 24);
    const above = interval => interval.state === 'always-above'
        || (interval.state === 'crosses' && hour >= interval.rise && hour < interval.set);
    const regime = above(sun) ? 'daylight' : above(civil) ? 'twilight' : 'darkness';
    const dayClass = sun.duration >= 17 ? 'long' : sun.duration <= 8 ? 'short' : 'ordinary';
    const offset = isAmbientClockAhead(clockAhead) ? clockAhead : 0;
    const vocabulary = DAYLIGHT_VOCABULARY;
    const parts = [vocabulary[regime]];
    if (sun.state === 'always-above') parts.push(vocabulary.polarDay);
    else if (sun.state === 'always-below') parts.push(vocabulary.polarNight);
    else {
        parts.push(vocabulary[dayClass]);
        if (regime === 'daylight' && (hour - sun.rise < 1 || sun.set - hour < 1)) parts.push(vocabulary.golden);
        parts.push(`sunset around ${roundSkyTime(sun.set, offset)}`);
    }
    if (civil.state === 'always-above' && sun.state !== 'always-above') parts.push(vocabulary.whiteNight);
    const events = [
        ['civil dawn begins', civil.rise], ['sunrise', sun.rise],
        ['sunset', sun.set], ['civil dusk ends', civil.set],
    ].filter(([, eventHour]) => eventHour !== null && eventHour > hour).sort((a, b) => a[1] - b[1]);
    const next = events[0];
    // Do not forecast tomorrow using today's declination; the next turn recomputes.
    if (next && next[0] !== 'sunset') parts.push(`${next[0]} around ${roundSkyTime(next[1], offset)}`);
    const aurora = auroraPossible({ seed, hours, latitude: resolved.latitude, regime });
    if (aurora) parts.push(vocabulary.aurora);
    return { ...resolved, climate, hasCalendar, declination, hour, regime, dayClass,
        sunrise: sun.rise, sunset: sun.set, civilDawn: civil.rise, civilDusk: civil.set,
        dayLength: sun.duration, polarDay: sun.state === 'always-above', polarNight: sun.state === 'always-below',
        noDarkness: civil.state === 'always-above', clockAhead: offset, aurora,
        description: `${parts.join('; ')}${hasCalendar ? '' : '; seasonal proxy — no calendar clock'}.` };
}