/** Authored, random-access frequency and dated rules. Caches never record occurrences. */
import { AMBIENT_SEASONS, AMBIENT_VOCABULARY, generateAmbientConditions } from './ambient_generator.js';
import { darkerRegime, generateAmbientDaylight, isAmbientClockAhead, REGIME_RANKS } from './ambient_astronomy.js';
import { applyAmbientPin } from './ambient_pin.js';
import { datedRuleActive } from './calendar_math.js';
export { isDatedRule } from './calendar_math.js';

export const PHENOMENA_LIMITS = Object.freeze({ rules: 16, nights: 30, clauses: 3, clauseLength: 80 });
const REGIMES = ['daylight', 'twilight', 'darkness'];
const GATES = { regime: REGIMES, sky: AMBIENT_VOCABULARY.sky, wind: AMBIENT_VOCABULARY.wind, season: AMBIENT_SEASONS };
const starts = new Map();

function validGates(gates) {
    return gates === undefined || (gates !== null && typeof gates === 'object' && !Array.isArray(gates)
        && Object.entries(gates).every(([key, values]) => Object.hasOwn(GATES, key)
            && Array.isArray(values) && values.length > 0 && values.every(value => GATES[key].includes(value))));
}

export function isFrequencyRule(rule) {
    return rule !== null && typeof rule === 'object' && rule.shape === 'frequency'
        && typeof rule.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rule.id)
        && typeof rule.name === 'string' && rule.name.trim().length > 0 && rule.name.length <= 60 && !/[\r\n<>]/.test(rule.name)
        && typeof rule.clause === 'string' && rule.clause.trim().length > 0
        && rule.clause.length <= PHENOMENA_LIMITS.clauseLength && !/[\r\n<>]/.test(rule.clause)
        && Number.isFinite(rule.chance) && rule.chance >= 0 && rule.chance <= 1
        && Number.isInteger(rule.durationNights) && rule.durationNights >= 1 && rule.durationNights <= PHENOMENA_LIMITS.nights
        && Number.isFinite(rule.startHours) && (rule.endHours === null || (Number.isFinite(rule.endHours) && rule.endHours >= rule.startHours))
        && (rule.source === undefined || ['timestamp', 'world-state', 'message-count'].includes(rule.source))
        && validGates(rule.startGates) && validGates(rule.visibilityGates)
        && (rule.light === undefined || REGIMES.includes(rule.light))
        && (rule.priority === undefined || (Number.isInteger(rule.priority) && Math.abs(rule.priority) <= 100));
}

export function validateFrequencyRules(rules) {
    if (!Array.isArray(rules) || rules.length > PHENOMENA_LIMITS.rules || !rules.every(isFrequencyRule)
        || new Set(rules.map(rule => rule.id)).size !== rules.length) {
        throw new Error('Invalid frequency rules: use unique IDs, chance 0–1, duration 1–30 nights, and clauses up to 80 characters (maximum 16 rules).');
    }
}

/** Same FNV hash-below-chance test and noon-to-noon identity as aurora. */
export function frequencyStartRoll(seed, ruleId, night, chance) {
    const key = `${seed}:${ruleId}:${night}`;
    let hash = 2166136261;
    for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
    return (hash >>> 0) / 4294967296 < chance;
}

function matches(gates = {}, facts) {
    return Object.entries(gates).every(([key, values]) => values.includes(facts[key]));
}

function factsAt(hours, time, options) {
    const clock = { ...time, hours };
    const weather = applyAmbientPin(generateAmbientConditions({ ...options, time: clock }), options.pin, clock);
    const daylight = generateAmbientDaylight({ ...options, time: clock });
    return { ...weather.conditions, season: weather.season, regime: daylight.regime };
}

export function generateAmbientPhenomena({ time, phenomena = [], calendar, daylight, conditions, season, ...options }) {
    const clock = typeof time === 'number' ? { hours: time, month: 1 } : time;
    const offset = isAmbientClockAhead(options.clockAhead) ? options.clockAhead : 0;
    const night = Math.floor((clock.hours - offset - 12) / 24);
    const active = [];
    for (const rule of Array.isArray(phenomena) ? phenomena.filter(isFrequencyRule).slice(0, PHENOMENA_LIMITS.rules) : []) {
        if ((rule.source === 'message-count') !== (clock.source === 'message-count') && rule.source !== undefined) continue;
        if (clock.hours < rule.startHours || (rule.endHours !== null && clock.hours >= rule.endHours)) continue;
        for (let n = night; n > night - rule.durationNights; n--) {
            const start = Math.max(n * 24 + 21 + offset, rule.startHours);
            if (start >= (n + 1) * 24 + 12 + offset || start > clock.hours) continue;
            const key = JSON.stringify([options, rule, n, clock.source, clock.month == null]);
            if (!starts.has(key)) {
                const happened = frequencyStartRoll(options.seed ?? 0, rule.id, n, rule.chance)
                    && matches(rule.startGates, factsAt(start, clock, options));
                if (starts.size >= 512) starts.delete(starts.keys().next().value);
                starts.set(key, happened);
            }
            if (starts.get(key)) { active.push(rule); break; }
        }
    }
    for (const rule of (calendar?.phenomena ?? []).slice(0, PHENOMENA_LIMITS.rules)) {
        if (datedRuleActive(calendar, rule, clock, options)) active.push(rule);
    }
    active.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Light only ever darkens, so the darkest active override wins outright;
    // walking the priority-sorted list and replacing only on strictly darker
    // keeps priority/ID as the tie-break for whose name is shown.
    let light = null;
    for (const rule of active) {
        if (rule.light !== undefined && (light === null || REGIME_RANKS[rule.light] > REGIME_RANKS[light.light])) light = rule;
    }
    // The override is also clamped to the natural regime: a night-time rule
    // cannot lift darkness, leaving moonlight and meteors intact.
    const facts = { ...conditions, season, regime: light ? darkerRegime(light.light, daylight.regime) : daylight.regime };
    const visible = active.filter(rule => matches(rule.visibilityGates, facts));
    const shown = visible.slice(0, PHENOMENA_LIMITS.clauses);
    return { active: active.map(rule => rule.id), visible: visible.map(rule => rule.id), light,
        omitted: Math.max(0, visible.length - shown.length), description: shown.map(rule => rule.clause.trim()).join('; ') };
}