import { describe, expect, test } from 'vitest';
import { frequencyStartRoll, generateAmbientPhenomena, validateFrequencyRules } from '../core/ambient_phenomena.js';

const rule = { id: 'meteors', shape: 'frequency', name: 'Meteors', clause: 'meteors cross the sky',
    chance: 1, durationNights: 1, startHours: 0, endHours: null };
const base = { seed: 42, climate: 'temperate', hemisphere: 'north', manualSeason: 'winter',
    daylight: { regime: 'darkness' }, conditions: { sky: 'clear', wind: 'calm' }, season: 'winter' };
function at(hours, rules = [rule], extra = {}) {
    return generateAmbientPhenomena({ ...base, phenomena: rules, time: { hours, month: null, source: 'message-count' }, ...extra });
}

describe('frequency-shaped phenomena', () => {
    test('night identity wraps midnight, including negative hours, and expires at noon', () => {
        expect(at(20).active).toEqual([]);
        expect(at(21).active).toEqual(['meteors']);
        expect(at(35.999).active).toEqual(['meteors']);
        expect(at(36).active).toEqual([]);
        expect(at(-1, [{ ...rule, startHours: -100 }]).active).toEqual(['meteors']);
        expect(at(22, [rule], { clockAhead: 2 }).active).toEqual([]);
        expect(at(23, [rule], { clockAhead: 2 }).active).toEqual(['meteors']);
    });

    test('duration look-back includes exactly N nights, even without a new start', () => {
        const seed = Array.from({ length: 1000 }, (_, i) => i).find(value => frequencyStartRoll(value, rule.id, 0, 0.5)
            && !frequencyStartRoll(value, rule.id, 1, 0.5) && !frequencyStartRoll(value, rule.id, 2, 0.5));
        expect(seed).toBeDefined();
        const rules = [{ ...rule, chance: 0.5, durationNights: 2 }];
        expect(at(59.999, rules, { seed }).active).toEqual(['meteors']);
        expect(at(60, rules, { seed }).active).toEqual([]);
    });

    test('random access equals sequential evaluations; rewinds and rule reordering are stable', () => {
        const rules = [{ ...rule, chance: 0.35, durationNights: 3 }, { ...rule, id: 'miasma', chance: 0.6 }];
        const direct = at(2417, rules);
        for (let h = 0; h < 2417; h += 6) at(h, rules);
        expect(at(2417, rules)).toEqual(direct);
        expect(at(2417, [...rules].reverse())).toEqual(direct);
        at(99999, rules);
        expect(at(2417, rules)).toEqual(direct);
    });

    test('observed per-night chance tracks configured frequency; endpoints are exact', () => {
        let count = 0;
        for (let n = 0; n < 10000; n++) count += frequencyStartRoll(42, 'meteors', n, 0.3) ? 1 : 0;
        expect(count / 10000).toBeCloseTo(0.3, 1);
        expect(at(21, [{ ...rule, chance: 0 }]).active).toEqual([]);
        expect(at(21).active).toEqual(['meteors']);
    });

    test('start gates use historical pinned weather and sunlight; visibility uses current facts', () => {
        const pin = { startHours: 0, endHours: 100, source: 'message-count', conditions: {
            sky: 'overcast', wind: 'strong', temperature: 'cold', air: 'damp', precipitation: 'none' } };
        const gated = { ...rule, startGates: { regime: ['darkness'], wind: ['calm'], season: ['winter'] } };
        expect(at(22, [gated], { pin }).active).toEqual([]);
        expect(at(22, [{ ...gated, startGates: { wind: ['strong'] } }], { pin }).active).toEqual(['meteors']);
        const visible = { ...rule, visibilityGates: { regime: ['darkness'], sky: ['clear', 'partly cloudy'] } };
        expect(at(22, [visible], { conditions: { sky: 'overcast' } })).toMatchObject({ active: ['meteors'], visible: [], description: '' });
        expect(at(22, [visible]).description).toBe(rule.clause);
        expect(at(22, [visible], { daylight: { regime: 'daylight' } }).visible).toEqual([]);
    });

    test('new rule does not rewrite played hours; end now is exclusive and preserves past', () => {
        const added = { ...rule, startHours: 23 };
        expect(at(22, [added]).active).toEqual([]);
        expect(at(23, [added]).active).toEqual(['meteors']);
        const ended = { ...added, endHours: 25 };
        expect(at(24, [ended])).toEqual(at(24, [added]));
        expect(at(25, [ended]).active).toEqual([]);
        expect(at(23, [ended]).active).toEqual(['meteors']);
        expect(at(24, [{ ...rule, source: 'timestamp' }]).active).toEqual([]);
    });

    test('light priority is independent of visibility and output cap; effective darkness controls meteors', () => {
        const rules = [{ ...rule, visibilityGates: { regime: ['darkness'] } },
            { ...rule, id: 'b', light: 'daylight', priority: 1 }, { ...rule, id: 'a', light: 'darkness', priority: 1 },
            { ...rule, id: 'c' }, { ...rule, id: 'd' }];
        expect(at(22, rules, { daylight: { regime: 'daylight' } })).toMatchObject({ light: { id: 'a' }, omitted: 2 });
        expect(at(22, rules).visible).toContain('meteors');
        expect(at(22, rules).description.split('; ')).toHaveLength(3);
        rules[1].priority = 2;
        expect(at(22, rules).visible).not.toContain('meteors');
    });

    test('schema rejects invalid gates, unbounded work, duplicate IDs and unsafe clauses', () => {
        expect(() => validateFrequencyRules([rule])).not.toThrow();
        for (const patch of [{ durationNights: 31 }, { chance: NaN }, { startGates: { precipitation: ['none'] } },
            { clause: 'x'.repeat(81) }, { clause: '<tag>' }, { endHours: -1 }, { light: 'eclipse' }, { priority: 101 }]) {
            expect(() => validateFrequencyRules([{ ...rule, ...patch }])).toThrow();
        }
        expect(() => validateFrequencyRules([rule, rule])).toThrow();
        expect(at(22, [null, {}]).active).toEqual([]);
    });
});