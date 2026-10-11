/**
 * Pure, random-access ambient conditions. Seed ownership belongs to the caller;
 * no Math.random, host clock, chat identity, state, or feature-module imports.
 */
import { AMBIENT_HOUR_MS } from './ambient_time.js';

export const AMBIENT_SEASONS = Object.freeze(['winter', 'spring', 'summer', 'autumn']);
// Night wraps midnight: 21:00–05:00 is ONE band, including across a date boundary.
export const AMBIENT_BANDS = Object.freeze([
    Object.freeze({ name: 'dawn', hour: 5 }),
    Object.freeze({ name: 'morning', hour: 8 }),
    Object.freeze({ name: 'afternoon', hour: 12 }),
    Object.freeze({ name: 'evening', hour: 18 }),
    Object.freeze({ name: 'night', hour: 21 }),
]);

function preset(label, mean, seasonal, daily, noiseAmplitude, temperature, moisture) {
    return Object.freeze({ label, mean, seasonal, daily, noise: noiseAmplitude,
        temperature: Object.freeze(temperature), moisture: Object.freeze(moisture) });
}

/** Internal temperature values are thresholds, not narrator-facing measurements. */
export const AMBIENT_CLIMATES = Object.freeze({
    temperate: preset('Temperate', 12, 13, 4, 9, [-25, 38], [0.05, 1]),
    desert: preset('Desert', 26, 9, 12, 8, [-8, 48], [0.02, 0.55]),
    tropical: preset('Tropical', 27, 2, 3, 5, [18, 40], [0.35, 1]),
    arctic: preset('Arctic', -15, 16, 2, 7, [-40, 8], [0.05, 0.95]),
    mediterranean: preset('Mediterranean', 19, 8, 4, 6, [6, 40], [0.05, 0.95]),
});

export const AMBIENT_VOCABULARY = Object.freeze({
    sky: Object.freeze(['clear', 'partly cloudy', 'overcast', 'foggy']),
    temperature: Object.freeze(['freezing', 'cold', 'cool', 'mild', 'warm', 'hot']),
    air: Object.freeze(['dry', 'comfortable', 'damp']),
    precipitation: Object.freeze(['none', 'rain', 'heavy rain', 'snow', 'heavy snow', 'thunderstorm', 'blizzard']),
    wind: Object.freeze(['calm', 'light', 'breezy', 'strong']),
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index++) {
        value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    }
    return value >>> 0;
}

function mulberry32(seed) {
    let value = seed >>> 0;
    return () => {
        value += 0x6D2B79F5;
        let mixed = Math.imul(value ^ value >>> 15, value | 1);
        mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
        return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
    };
}

function noise(seed, channel, hours, spacing) {
    const point = Math.floor(hours / spacing);
    const fraction = hours / spacing - point;
    const smooth = fraction * fraction * (3 - 2 * fraction);
    const left = mulberry32(hash(`${seed}:${channel}:${point}`))();
    const right = mulberry32(hash(`${seed}:${channel}:${point + 1}`))();
    return left + (right - left) * smooth;
}

/** Numeric hours are UTC-shaped story hours since 1970, not wall-clock time. */
export function quantizeAmbientTime(hours) {
    if (!Number.isFinite(hours)) throw new RangeError('Ambient hours must be finite.');
    const dayStart = Math.floor(hours / 24) * 24;
    const hour = hours - dayStart;
    let index = AMBIENT_BANDS.findLastIndex(band => hour >= band.hour);
    if (index < 0) index = AMBIENT_BANDS.length - 1;
    const startHours = dayStart + AMBIENT_BANDS[index].hour - (hour < 5 ? 24 : 0);
    const next = AMBIENT_BANDS[(index + 1) % AMBIENT_BANDS.length];
    const nextHours = startHours + (next.hour - AMBIENT_BANDS[index].hour + 24) % 24;
    return { name: AMBIENT_BANDS[index].name, startHours, nextHours };
}

function settings(options) {
    if (!Object.hasOwn(AMBIENT_CLIMATES, options.climate)) throw new RangeError('An explicit ambient climate preset is required.');
    const hemisphere = options.hemisphere ?? 'north';
    const manualSeason = options.manualSeason ?? 'spring';
    const variability = options.variability ?? 0.5;
    if (!['north', 'south'].includes(hemisphere)) throw new RangeError('Hemisphere must be north or south.');
    if (!AMBIENT_SEASONS.includes(manualSeason)) throw new RangeError('Unknown manual season.');
    if (!Number.isFinite(variability) || variability < 0 || variability > 1) throw new RangeError('Variability must be between 0 and 1.');
    if (typeof options.seed !== 'number' || !Number.isFinite(options.seed)) throw new RangeError('Ambient seed must be a finite number.');
    return { ...options, hemisphere, manualSeason, variability };
}

function seasonAt(hours, hasCalendar, config) {
    if (!hasCalendar) return { name: config.manualSeason, warmth: [-1, 0, 1, 0][AMBIENT_SEASONS.indexOf(config.manualSeason)] };
    const date = new Date(hours * AMBIENT_HOUR_MS);
    if (!Number.isFinite(date.getTime())) throw new RangeError('Ambient calendar time is outside the supported date range.');
    const month = date.getUTCMonth();
    const shifted = (month + (config.hemisphere === 'south' ? 6 : 0)) % 12;
    // Smooth seasonal baseline; coldest mid-January, warmest mid-July.
    const position = shifted + (date.getUTCDate() - 1 + date.getUTCHours() / 24) / 31;
    return { name: AMBIENT_SEASONS[Math.floor(((shifted + 1) % 12) / 3)],
        warmth: -Math.cos((position - 0.5) * Math.PI / 6) };
}

function evaluate(seedTime, hasCalendar, config) {
    const band = quantizeAmbientTime(seedTime);
    const climate = AMBIENT_CLIMATES[config.climate];
    const season = seasonAt(band.startHours, hasCalendar, config);
    const hour = ((band.startHours % 24) + 24) % 24;
    // At midpoint variability, anchors are 30h apart; range is 48h–12h.
    const spacing = 48 - 36 * config.variability;
    const fastWeight = 0.05 + 0.2 * config.variability;
    const channel = name => {
        const slow = noise(config.seed, `${name}:slow`, band.startHours, spacing);
        const fast = noise(config.seed, `${name}:fast`, band.startHours, spacing / 4);
        // Convex mix keeps the channel's possible range identical at every
        // variability, unlike adding a fast layer with slider-dependent bounds.
        return slow * (1 - fastWeight) + fast * fastWeight;
    };
    const temperature = clamp(climate.mean + climate.seasonal * season.warmth
        + climate.daily * Math.cos((hour - 15) * Math.PI / 12)
        + climate.noise * (channel('temperature') * 2 - 1), ...climate.temperature);
    let moisture = climate.moisture[0] + channel('moisture') * (climate.moisture[1] - climate.moisture[0]);
    // Mediterranean summers are drier; bounds still prevent snow by construction.
    if (config.climate === 'mediterranean') moisture = clamp(moisture - Math.max(0, season.warmth) * 0.25, ...climate.moisture);
    const wind = channel('wind');
    let precipitation = 'none';
    if (moisture >= 0.72) {
        if (temperature <= 0) precipitation = moisture > 0.87 ? (wind > 0.75 ? 'blizzard' : 'heavy snow') : 'snow';
        else if (temperature >= 22 && moisture > 0.85 && wind > 0.55) precipitation = 'thunderstorm';
        else precipitation = moisture > 0.87 ? 'heavy rain' : 'rain';
    }
    const fog = precipitation === 'none' && moisture > 0.6 && wind < 0.35 && ['night', 'dawn', 'morning'].includes(band.name);
    return {
        band, season: season.name,
        conditions: {
            sky: fog ? 'foggy' : moisture > 0.6 ? 'overcast' : moisture > 0.35 ? 'partly cloudy' : 'clear',
            temperature: temperature <= 0 ? 'freezing' : temperature < 8 ? 'cold' : temperature < 16 ? 'cool' : temperature < 22 ? 'mild' : temperature < 30 ? 'warm' : 'hot',
            air: moisture < 0.3 ? 'dry' : moisture > 0.6 ? 'damp' : 'comfortable',
            precipitation,
            wind: wind < 0.2 ? 'calm' : wind < 0.45 ? 'light' : wind < 0.75 ? 'breezy' : 'strong',
        },
    };
}

/**
 * time is either numeric story hours (Gregorian calendar), or the resolver's
 * { hours, month } result. month:null explicitly selects the manual season.
 * Returns qualitative current conditions and precisely one band of forecast.
 * It does not claim "within the hour": named bands can be several hours long.
 */
export function generateAmbientConditions({ time, ...options }) {
    const config = settings(options);
    const hours = typeof time === 'number' ? time : time?.hours;
    const hasCalendar = typeof time === 'number' || (time?.month != null);
    const current = evaluate(hours, hasCalendar, config);
    return { ...current, forecast: evaluate(current.band.nextHours, hasCalendar, config) };
}