/** Random-access recent weather and seasonal firsts. No log or persistence.
 * History deliberately follows today's settings, including the stored pin.
 */
import { generateAmbientConditions, quantizeAmbientTime } from './ambient_generator.js';
import { applyAmbientPin, isAmbientPin } from './ambient_pin.js';
import { AMBIENT_HOUR_MS } from './ambient_time.js';

const crossingCache = new Map();
const SNOW = new Set(['snow', 'heavy snow', 'blizzard']);

function conditionsAt(hours, time, options) {
    const clock = { ...time, hours };
    return applyAmbientPin(generateAmbientConditions({ ...options, time: clock }), options.pin, clock).conditions;
}

// Include the band already in progress at the left edge. Pin boundaries are
// real changes too, even when the user pinned midway through a weather band.
function sampleHours(start, end, pin) {
    const points = new Set([start]);
    let next = quantizeAmbientTime(start).nextHours;
    while (next <= end) {
        points.add(next);
        next = quantizeAmbientTime(next).nextHours;
    }
    if (isAmbientPin(pin)) {
        for (const hours of [pin.startHours, pin.endHours]) {
            if (hours !== null && hours > start && hours <= end) points.add(hours);
        }
    }
    return [...points].sort((a, b) => a - b);
}

function when(hours, day) {
    const band = quantizeAmbientTime(hours);
    // The night band spans midnight, including pin transitions before dawn.
    if (band.name === 'night' && band.startHours < day) return 'last night';
    return `${Math.floor(hours / 24) * 24 < day ? 'yesterday' : 'today'} ${band.name}`;
}

function weather(conditions) {
    return conditions.precipitation === 'none' ? conditions.sky : conditions.precipitation;
}

function recentSummary(time, options) {
    // Anchor to the weather band, rather than sliding the window every minute.
    const end = quantizeAmbientTime(time.hours).startHours;
    const start = end - 24;
    const points = sampleHours(start, time.hours, options.pin);
    const runs = [];
    for (const hours of points) {
        const conditions = conditionsAt(hours, time, options);
        const label = weather(conditions);
        if (runs.at(-1)?.label !== label) runs.push({ hours, label,
            wet: conditions.precipitation !== 'none' });
    }
    const current = runs.at(-1);
    if (runs.length === 1) return `${current.label} throughout the past day`;
    const day = Math.floor(time.hours / 24) * 24;
    // Keep the latest precipitation episode even if several dry-sky changes
    // followed it; otherwise a cloud change could erase yesterday's rain.
    const previous = runs.slice(0, -1).findLast(run => run.wet) ?? runs.at(-2);
    return `${current.label} since ${when(current.hours, day)}; previously ${previous.label}`;
}

function seasonStart(day) {
    const date = new Date(day * AMBIENT_HOUR_MS);
    const month = date.getUTCMonth();
    const startMonth = Math.floor((month + 1) / 3) * 3 - 1;
    date.setUTCDate(1);
    date.setUTCMonth(startMonth);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime() / AMBIENT_HOUR_MS;
}

function seasonalCrossings(day, time, options) {
    // Defaults normalized; every input affecting historical weather/pins is in
    // the key. Sky settings and UI state cannot invalidate weather history.
    const key = JSON.stringify([options.seed, day, options.climate, options.hemisphere ?? 'north',
        options.variability ?? 0.5, time.source === 'message-count', isAmbientPin(options.pin) ? options.pin : null]);
    if (crossingCache.has(key)) return crossingCache.get(key);
    const start = seasonStart(day);
    // Midnight still belongs to yesterday's night weather band. Dawn selects
    // the calendar day's season without shifting the actual crossing times.
    const season = generateAmbientConditions({ ...options, time: { ...time, hours: day + 5 } }).season;
    const firsts = new Map();
    let previous = conditionsAt(start - 1 / 60, time, options);
    // Full-day results may be cached, but callers only see crossings whose
    // exact time has passed. No afternoon snow is announced in the morning.
    for (const hours of sampleHours(start, day + 24, options.pin)) {
        if (hours >= day + 24) break;
        const current = conditionsAt(hours, time, options);
        if (season === 'autumn' && current.temperature === 'freezing' && !firsts.has('frost')) firsts.set('frost', hours);
        if (['autumn', 'winter'].includes(season) && SNOW.has(current.precipitation) && !firsts.has('snow')) firsts.set('snow', hours);
        if (season === 'spring' && previous.temperature === 'freezing' && current.temperature !== 'freezing' && !firsts.has('thaw')) firsts.set('thaw', hours);
        previous = current;
    }
    const result = [...firsts].map(([kind, hours]) => ({ kind, hours }));
    // Disposable bounded memoization, never a fired-once record. Eviction and
    // chat switches cannot change the result of a direct evaluation or rewind.
    if (crossingCache.size >= 64) crossingCache.delete(crossingCache.keys().next().value);
    crossingCache.set(key, result);
    return result;
}

/** Calendar-less clocks retain recent weather, but cannot claim seasonal firsts. */
export function generateAmbientAftermath({ time, ...options }) {
    const clock = typeof time === 'number' ? { hours: time, month: 1 } : time;
    const summary = recentSummary(clock, options);
    const day = Math.floor(clock.hours / 24) * 24;
    const crossings = clock.month == null ? [] : seasonalCrossings(day, clock, options)
        .filter(event => event.hours >= day && event.hours <= clock.hours)
        .map(event => ({ ...event, description: `first ${event.kind} today ${quantizeAmbientTime(event.hours).name}` }));
    return { summary, crossings, description: `${summary}${crossings.length ? `; ${crossings.map(event => event.description).join('; ')}` : ''}.` };
}