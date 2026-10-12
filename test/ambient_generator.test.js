import { describe, expect, test } from 'vitest';
import {
    AMBIENT_BANDS, AMBIENT_CLIMATES, AMBIENT_VOCABULARY,
    generateAmbientConditions, quantizeAmbientTime,
} from '../core/ambient_generator.js';
import { resolveAmbientTime } from '../core/ambient_time.js';

const hours = (month = 6, day = 4, hour = 12) => Date.UTC(2026, month - 1, day, hour) / 3600000;
const generate = (time, options = {}) => generateAmbientConditions({ seed: 12345, climate: 'temperate', time, ...options });

describe('ambient bands and forecast', () => {
    test.each(AMBIENT_BANDS)('quantizes every moment in $name without flicker', ({ hour }) => {
        const start = hours(6, 4, hour);
        const band = quantizeAmbientTime(start);
        const expected = generate(start);
        for (let time = start; time < band.nextHours; time += 1 / 12) {
            expect(generate(time)).toEqual(expected);
        }
        expect(generate(band.nextHours).band.startHours).toBe(band.nextHours);
    });

    test('night spans midnight, including before the epoch', () => {
        expect(generate(hours(6, 4, 22))).toEqual(generate(hours(6, 5, 4)));
        expect(quantizeAmbientTime(0)).toEqual({ name: 'night', startHours: -3, nextHours: 5 });
        expect(quantizeAmbientTime(-1)).toEqual(quantizeAmbientTime(0));
    });

    test('daily warmth is monotonic across bands: afternoon peak, night trough', () => {
        // Band means over many days isolate the daily term — the only input
        // that differs systematically by band — from per-band noise draws,
        // since same-day bands share most of their noise.
        const score = { freezing: 0, cold: 1, cool: 2, mild: 3, warm: 4, hot: 5 };
        const day = offset => Date.UTC(2026, 0, 1 + offset) / 3600000;
        const samples = Object.fromEntries(AMBIENT_BANDS.map(({ name }) => [name, []]));
        for (let index = 0; index < 500; index++) {
            for (const { name, hour } of AMBIENT_BANDS) {
                samples[name].push(score[generate(day(index) + hour, { climate: 'desert', seed: index }).conditions.temperature]);
            }
        }
        const mean = name => samples[name].reduce((total, value) => total + value, 0) / samples[name].length;
        expect(mean('night')).toBeLessThan(mean('dawn'));
        expect(mean('dawn')).toBeLessThan(mean('morning'));
        expect(mean('morning')).toBeLessThan(mean('evening'));
        expect(mean('evening')).toBeLessThan(mean('afternoon'));
    });

    test('forecast is exactly the next band, even across month/year/season boundaries', () => {
        for (const time of [hours(2, 28, 22), hours(12, 31, 22), hours(6, 4, 12), -10]) {
            for (const climate of Object.keys(AMBIENT_CLIMATES)) {
                const current = generate(time, { climate });
                const { forecast: _forecast, ...next } = generate(current.band.nextHours, { climate });
                expect(current.forecast).toEqual(next);
            }
        }
    });
});

describe('ambient climate and deterministic noise', () => {
    test('same seed and clock reproduce conditions independently of lookup order across 10k times', () => {
        for (let index = 0; index < 10000; index++) {
            const time = -10000 + index * 17.3;
            const first = generate(time);
            generate(time - 9000, { seed: 42 });
            expect(generate(time)).toEqual(first);
        }
    });

    test.each([0, 0.5, 1])('desert never precipitates or snows at variability %s across 10k times', variability => {
        for (let index = 0; index < 10000; index++) {
            const result = generate(-20000 + index * 19.7, { climate: 'desert', seed: index % 31, variability });
            expect(result.conditions.precipitation).toBe('none');
            expect(result.forecast.conditions.precipitation).toBe('none');
        }
    });

    test('warm climates cannot snow, while temperate and arctic can', () => {
        // Collect and assert once: 75k expect() calls inside the loop made this
        // the slowest test in the suite and timed it out under load.
        const observed = Object.fromEntries(Object.keys(AMBIENT_CLIMATES).map(climate => [climate, new Set()]));
        const outsideVocabulary = [];
        for (const climate of Object.keys(observed)) {
            for (let index = 0; index < 3000; index++) {
                const result = generate(hours(1, 1) + index * 13, { climate });
                observed[climate].add(result.conditions.precipitation);
                for (const [key, value] of Object.entries(result.conditions)) {
                    if (!AMBIENT_VOCABULARY[key].includes(value)) outsideVocabulary.push(`${climate} ${key}=${value}`);
                }
            }
        }
        expect(outsideVocabulary).toEqual([]);
        for (const climate of ['desert', 'tropical', 'mediterranean']) {
            expect([...observed[climate]].some(value => /snow|blizzard/.test(value))).toBe(false);
        }
        expect([...observed.temperate].some(value => /snow/.test(value))).toBe(true);
        expect([...observed.arctic].some(value => /snow/.test(value))).toBe(true);
    });

    test('hemisphere swaps seasons and fallback clocks use manual season', () => {
        expect(generate(hours(1, 15)).season).toBe('winter');
        expect(generate(hours(1, 15), { hemisphere: 'south' }).season).toBe('summer');
        expect(generate(hours(7, 15)).season).toBe('summer');
        const time = resolveAmbientTime({ messages: ['hello'] });
        for (const manualSeason of ['winter', 'spring', 'summer', 'autumn']) {
            const result = generate(time, { manualSeason });
            expect(result.season).toBe(manualSeason);
            expect(result.forecast.season).toBe(manualSeason);
            const { forecast: _forecast, ...next } = generate({ ...time, hours: result.band.nextHours }, { manualSeason });
            expect(result.forecast).toEqual(next);
        }
    });

    test('variability changes frequency, not the reachable qualitative values', () => {
        const changes = [];
        const possible = [];
        for (const variability of [0, 1]) {
            let previous;
            let count = 0;
            const values = Object.fromEntries(Object.keys(AMBIENT_VOCABULARY).map(key => [key, new Set()]));
            let time = hours(1, 1);
            for (let index = 0; index < 15000; index++) {
                const result = generate(time, { variability });
                const signature = JSON.stringify(result.conditions);
                if (previous && previous !== signature) count++;
                previous = signature;
                for (const [key, value] of Object.entries(result.conditions)) values[key].add(value);
                time = result.band.nextHours;
            }
            changes.push(count);
            possible.push(Object.fromEntries(Object.entries(values).map(([key, set]) => [key, [...set].sort()])));
        }
        expect(changes[1]).toBeGreaterThan(changes[0] * 1.3);
        expect(possible[1]).toEqual(possible[0]);
    });

    test('different seeds change conditions and inputs are not mutated', () => {
        const time = Object.freeze({ hours: hours(), month: 6 });
        const options = Object.freeze({ time, climate: 'temperate', seed: 1 });
        expect(generateAmbientConditions(options)).toEqual(generateAmbientConditions(options));
        const sequences = [1, 2].map(seed => Array.from({ length: 30 }, (_, index) => generate(hours() + index * 24, { seed }).conditions));
        expect(sequences[0]).not.toEqual(sequences[1]);
    });

    test('rejects invalid settings instead of silently defaulting climate', () => {
        for (const options of [{ climate: undefined }, { climate: 'toString' }, { hemisphere: 'east' },
            { manualSeason: 'wet' }, { variability: -1 }, { variability: 2 }, { variability: NaN }, { seed: Infinity }]) {
            expect(() => generate(hours(), options)).toThrow(RangeError);
        }
        for (const time of [undefined, NaN, Infinity]) expect(() => generate(time)).toThrow(RangeError);
    });
});