/** Pure story-sky facts. No host clock, persistence, locale or ST dependencies. */
import { AMBIENT_HOUR_MS } from './ambient_time.js';

export const AMBIENT_LATITUDES = Object.freeze({ arctic: 65, temperate: 45, mediterranean: 40, desert: 25, tropical: 10 });
export const DAYLIGHT_VOCABULARY = Object.freeze({
    daylight: 'daylight', twilight: 'civil twilight', darkness: 'darkness',
    long: 'long summer light, white-night borders', short: 'short winter day',
    ordinary: 'typical day length', golden: 'low sun, golden light',
    polarDay: 'the sun does not set; daylight through the night',
    polarNight: 'the sun will not rise today', whiteNight: 'no true darkness',
    aurora: 'aurora possible',
});
const RAD = Math.PI / 180;

export const LUNAR_MONTH_DAYS = 29.530589;
// 2000-01-06 18:14 UTC, expressed as UTC-shaped story hours since 1970.
export const LUNAR_EPOCH_HOURS = 263106 + 14 / 60;
export const MOON_PHASES = Object.freeze([
    'new', 'waxing crescent', 'first quarter', 'waxing gibbous',
    'full', 'waning gibbous', 'last quarter', 'waning crescent',
]);
export const NIGHT_BRIGHTNESS = Object.freeze({
    black: 'black night', stars: 'starlit', faint: 'faint moonlight',
    moonlit: 'moonlit', bright: 'bright moonlight, shadows cast',
});

/** One global epoch shift, not an expiring pin. Null restores the real-world epoch. */
export function moonAnchorOffset(fullMoonHours) {
    if (!Number.isFinite(fullMoonHours)) throw new RangeError('Full moon story hours must be finite.');
    return fullMoonHours - LUNAR_EPOCH_HOURS - LUNAR_MONTH_DAYS * 12;
}

export function isMoonEpochOffset(value) {
    return Number.isFinite(value)
        && Number.isFinite(new Date((LUNAR_EPOCH_HOURS + value + LUNAR_MONTH_DAYS * 12) * AMBIENT_HOUR_MS).getTime());
}

/** Shared anchored phase for moon, tides and future lunar events. */
export function lunarPhaseAt(hours, moonEpochOffset = 0) {
    if (!Number.isFinite(hours)) throw new RangeError('Story hours must be finite.');
    const offset = isMoonEpochOffset(moonEpochOffset) ? moonEpochOffset : 0;
    const age = flooredMod((hours - LUNAR_EPOCH_HOURS - offset) / 24, LUNAR_MONTH_DAYS);
    const phase = age / LUNAR_MONTH_DAYS;
    const bin = flooredMod(Math.round(phase * 8), 8);
    return { age, phase, bin, name: MOON_PHASES[bin], illumination: (1 - Math.cos(2 * Math.PI * phase)) / 2 };
}

/** Age-based heuristic only: latitude-dependent rise/set and terrain are not modeled. */
export function generateAmbientMoon({ time, moonEpochOffset = 0, clockAhead = 0, daylight, conditions = {} }) {
    const hours = typeof time === 'number' ? time : time?.hours;
    if (!Number.isFinite(hours)) throw new RangeError('Story hours must be finite.');
    if (typeof time !== 'number' && (time?.source === 'message-count' || time?.month == null)) return null;
    const lunar = lunarPhaseAt(hours, moonEpochOffset);
    const transit = flooredMod(12 + lunar.age * 0.841, 24);
    // Transit is sun time: compare the converted story clock against it, so a
    // clock running ahead of the sun sees the moon rise that much earlier.
    const offset = isAmbientClockAhead(clockAhead) ? clockAhead : 0;
    const up = Math.abs(flooredMod(hours - offset - transit + 12, 24) - 12) < 6;
    let brightness = null;
    if (daylight?.regime === 'darkness') {
        // Cloud/precipitation attenuation is qualitative, not photometry. Weather
        // pins have already been applied by the shared projection before this call.
        const transmission = { clear: 1, 'partly cloudy': 0.6, overcast: 0.08, foggy: 0.02 }[conditions.sky] ?? 0;
        const precipitation = conditions.precipitation === 'none' ? 1 : 0.3;
        const light = lunar.illumination * Number(up) * transmission * precipitation;
        brightness = light >= 0.7 ? NIGHT_BRIGHTNESS.bright : light >= 0.3 ? NIGHT_BRIGHTNESS.moonlit
            : light >= 0.05 ? NIGHT_BRIGHTNESS.faint
                : transmission >= 0.6 && conditions.precipitation === 'none' ? NIGHT_BRIGHTNESS.stars : NIGHT_BRIGHTNESS.black;
    }
    return { ...lunar, transit, up, brightness,
        description: `${lunar.name} moon${up ? '' : ' below horizon'}${brightness ? `; ${brightness}` : ''}.` };
}

export function flooredMod(value, period) {
    return ((value % period) + period) % period;
}

export const TIDE_PERIOD_HOURS = 12.4206;
export const TIDE_WINDOW_DAYS = 2;
export const TIDE_RANGES = Object.freeze({ calm: 'small tidal range', normal: 'moderate tidal range', extreme: 'large tidal range' });
export const TIDE_VOCABULARY = Object.freeze({
    high: 'high water, slack', low: 'low water, slack', rising: 'rising water', falling: 'falling water',
    spring: 'spring tide', neap: 'neap tide', ordinary: 'between spring and neap',
});

/** Fixed fictional-port interval, independent of weather channels and host randomness. */
export function tideOffsetForSeed(seed = 0) {
    if (!Number.isFinite(seed)) throw new RangeError('Ambient seed must be finite.');
    const key = `${seed}:tide`;
    let hash = 2166136261;
    for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
    return (hash >>> 0) / 4294967296 * TIDE_PERIOD_HOURS;
}

/** Internally consistent semidiurnal tides, not real-port or navigation predictions. */
export function generateAmbientTide({ time, seed = 0, coastal = false, tideRange = 'normal', moonEpochOffset = 0 }) {
    if (coastal !== true) return null;
    const hours = typeof time === 'number' ? time : time?.hours;
    if (!Number.isFinite(hours)) throw new RangeError('Story hours must be finite.');
    if (typeof time !== 'number' && (time?.source === 'message-count' || time?.month == null)) return null;
    const anchor = isMoonEpochOffset(moonEpochOffset) ? moonEpochOffset : 0;
    const offset = tideOffsetForSeed(seed);
    // Re-anchoring translates the entire schedule, not just its spring/neap label.
    const origin = LUNAR_EPOCH_HOURS + anchor + offset;
    // Tides stay on story hours; moon-up uses sun hours (hours - clockAhead).
    // Changing clockAhead therefore shifts their relative timing, not this schedule.
    const phase = flooredMod(hours - origin, TIDE_PERIOD_HOURS) / TIDE_PERIOD_HOURS;
    // One twenty-fourth of a cycle is about half an hour around each extremum.
    const slackWindow = 1 / 24;
    const state = Math.min(phase, 1 - phase) <= slackWindow ? 'high'
        : Math.abs(phase - 0.5) <= slackWindow ? 'low' : phase < 0.5 ? 'falling' : 'rising';
    const lunar = lunarPhaseAt(hours, anchor);
    const springDistance = Math.min(lunar.phase, Math.abs(lunar.phase - 0.5), 1 - lunar.phase) * LUNAR_MONTH_DAYS;
    const neapDistance = Math.min(Math.abs(lunar.phase - 0.25), Math.abs(lunar.phase - 0.75)) * LUNAR_MONTH_DAYS;
    const modulation = springDistance <= TIDE_WINDOW_DAYS ? 'spring' : neapDistance <= TIDE_WINDOW_DAYS ? 'neap' : 'ordinary';
    const range = Object.hasOwn(TIDE_RANGES, tideRange) ? tideRange : 'normal';
    const nextHighHours = origin + (Math.floor((hours - origin) / TIDE_PERIOD_HOURS) + 1) * TIDE_PERIOD_HOURS;
    // Qualify the rounded clock's day too: 23:50 rounds into tomorrow, not 00:00 today.
    const roundedHigh = Math.round(nextHighHours * 2) / 2;
    const dayDelta = Math.floor(roundedHigh / 24) - Math.floor(hours / 24);
    const day = dayDelta === 1 ? ' tomorrow' : dayDelta > 1 ? ` in ${dayDelta} days` : '';
    return { phase, offset, state, slack: state === 'high' || state === 'low', modulation, range, nextHighHours,
        description: `${TIDE_VOCABULARY[state]}; ${TIDE_VOCABULARY[modulation]}; ${TIDE_RANGES[range]}; next high water${day} around ${roundSkyTime(nextHighHours)}.` };
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
    // All astronomy reads sun time. A story clock that runs ahead of the sun
    // converts once here; regime, golden hour, next events and the declination
    // date follow the converted time, and roundSkyTime adds the offset back
    // for stated clock facts — so a stated sunset can never be in the future
    // of a regime that already calls the scene dark.
    const offset = isAmbientClockAhead(clockAhead) ? clockAhead : 0;
    const sunHours = hours - offset;
    let declination;
    if (hasCalendar) {
        const date = new Date(sunHours * AMBIENT_HOUR_MS);
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
    const sunHour = flooredMod(sunHours, 24);
    const above = interval => interval.state === 'always-above'
        || (interval.state === 'crosses' && sunHour >= interval.rise && sunHour < interval.set);
    const regime = above(sun) ? 'daylight' : above(civil) ? 'twilight' : 'darkness';
    const dayClass = sun.duration >= 17 ? 'long' : sun.duration <= 8 ? 'short' : 'ordinary';
    const vocabulary = DAYLIGHT_VOCABULARY;
    const parts = [vocabulary[regime]];
    if (sun.state === 'always-above') parts.push(vocabulary.polarDay);
    else if (sun.state === 'always-below') parts.push(vocabulary.polarNight);
    else {
        parts.push(vocabulary[dayClass]);
        if (regime === 'daylight' && (sunHour - sun.rise < 1 || sun.set - sunHour < 1)) parts.push(vocabulary.golden);
        parts.push(`sunset around ${roundSkyTime(sun.set, offset)}`);
    }
    if (civil.state === 'always-above' && sun.state !== 'always-above') parts.push(vocabulary.whiteNight);
    const events = [
        ['civil dawn begins', civil.rise], ['sunrise', sun.rise],
        ['sunset', sun.set], ['civil dusk ends', civil.set],
    ].filter(([, eventHour]) => eventHour !== null && eventHour > sunHour).sort((a, b) => a[1] - b[1]);
    const next = events[0];
    // Do not forecast tomorrow using today's declination; the next turn recomputes.
    if (next && next[0] !== 'sunset') parts.push(`${next[0]} around ${roundSkyTime(next[1], offset)}`);
    const aurora = auroraPossible({ seed, hours: sunHours, latitude: resolved.latitude, regime });
    if (aurora) parts.push(vocabulary.aurora);
    return { ...resolved, climate, hasCalendar, declination, hour: sunHour, regime, dayClass,
        sunrise: sun.rise, sunset: sun.set, civilDawn: civil.rise, civilDusk: civil.set,
        dayLength: sun.duration, polarDay: sun.state === 'always-above', polarNight: sun.state === 'always-below',
        noDarkness: civil.state === 'always-above', clockAhead: offset, aurora,
        description: `${parts.join('; ')}${hasCalendar ? '' : '; seasonal proxy'}.` };
}