import { describe, expect, test } from 'vitest';
import { generateAmbientMoon, generateAmbientTide, lunarPhaseAt, LUNAR_EPOCH_HOURS, LUNAR_MONTH_DAYS, moonAnchorOffset, tideOffsetForSeed, TIDE_PERIOD_HOURS } from '../core/ambient_astronomy.js';
import { parseAmbientDateTime, resolveAmbientTime } from '../core/ambient_time.js';

const seed = 12;
const tide = (hours, patch = {}) => generateAmbientTide({ time: hours, seed, coastal: true, ...patch });
const origin = LUNAR_EPOCH_HOURS + tideOffsetForSeed(seed);

describe('Phase 9 pure tides', () => {
    test('seeded offset is bounded, deterministic and rejects nonfinite seeds', () => {
        for (const value of [-10, 0, 12, 4294967295]) {
            expect(tideOffsetForSeed(value)).toBe(tideOffsetForSeed(value));
            expect(tideOffsetForSeed(value)).toBeGreaterThanOrEqual(0);
            expect(tideOffsetForSeed(value)).toBeLessThan(TIDE_PERIOD_HOURS);
        }
        expect(tideOffsetForSeed(12)).not.toBe(tideOffsetForSeed(13));
        expect(() => tideOffsetForSeed(NaN)).toThrow(RangeError);
        expect(() => tide(NaN)).toThrow(RangeError);
    });

    test('highs follow offset + k periods, with lows halfway and exact-time rising/falling', () => {
        for (const k of [-100000, -1, 0, 1, 100000]) {
            const high = origin + k * TIDE_PERIOD_HOURS;
            expect(tide(high)).toMatchObject({ state: 'high', slack: true });
            expect(tide(high + TIDE_PERIOD_HOURS / 4)).toMatchObject({ state: 'falling', slack: false });
            expect(tide(high + TIDE_PERIOD_HOURS / 2)).toMatchObject({ state: 'low', slack: true });
            expect(tide(high + TIDE_PERIOD_HOURS * 3 / 4)).toMatchObject({ state: 'rising', slack: false });
            const next = tide(high + 0.01).nextHighHours;
            expect(next).toBeCloseTo(high + TIDE_PERIOD_HOURS, 7);
            expect(tide(next).state).toBe('high');
        }
    });

    test('slack buckets end half an hour either side of each extremum', () => {
        const width = TIDE_PERIOD_HOURS / 24;
        for (const sign of [-1, 1]) {
            expect(tide(origin + sign * (width - 0.001)).state).toBe('high');
            expect(tide(origin + sign * (width + 0.001)).slack).toBe(false);
            expect(tide(origin + TIDE_PERIOD_HOURS / 2 + sign * (width - 0.001)).state).toBe('low');
            expect(tide(origin + TIDE_PERIOD_HOURS / 2 + sign * (width + 0.001)).slack).toBe(false);
        }
    });

    test.each([0, moonAnchorOffset(parseAmbientDateTime('1850-06-01', '22:00').hours)])('symmetric two-day windows cross-check the anchored Phase 6 moon (%s)', anchor => {
        for (const [phase, modulation, name] of [[0, 'spring', 'new'], [0.25, 'neap', 'first quarter'], [0.5, 'spring', 'full'], [0.75, 'neap', 'last quarter']]) {
            const event = LUNAR_EPOCH_HOURS + anchor + phase * LUNAR_MONTH_DAYS * 24;
            expect(generateAmbientMoon({ time: event, moonEpochOffset: anchor }).name).toBe(name);
            expect(lunarPhaseAt(event, anchor).phase).toBeCloseTo(phase);
            for (const sign of [-1, 1]) {
                expect(tide(event + sign * 1.999 * 24, { moonEpochOffset: anchor }).modulation).toBe(modulation);
                expect(tide(event + sign * 2.001 * 24, { moonEpochOffset: anchor }).modulation).toBe('ordinary');
            }
        }
    });

    test('anchor translates schedule and modulation; weather reseed changes schedule, not moon', () => {
        const hours = parseAmbientDateTime('2026-10-26', '23:00').hours;
        const before = tide(hours);
        const shifted = tide(hours + 73, { moonEpochOffset: 73 });
        expect(shifted.phase).toBeCloseTo(before.phase);
        expect(shifted.modulation).toBe(before.modulation);
        expect(shifted.nextHighHours).toBeCloseTo(before.nextHighHours + 73);
        expect(tide(hours, { seed: 13 }).nextHighHours).not.toBe(before.nextHighHours);
        expect(tide(hours, { seed: 13 }).modulation).toBe(before.modulation);
        expect(tide(hours, { moonEpochOffset: NaN })).toEqual(before);
    });

    test('range changes wording only; clockAhead does not shift absolute event hours twice', () => {
        const normal = tide(origin + 3);
        for (const range of ['calm', 'normal', 'extreme']) {
            const result = tide(origin + 3, { tideRange: range });
            expect(result).toMatchObject({ state: normal.state, phase: normal.phase, nextHighHours: normal.nextHighHours });
            expect(result.range).toBe(range);
        }
        expect(tide(origin + 3, { tideRange: 'invalid' })).toEqual(normal);
        expect(tide(origin + 3, { clockAhead: 2 })).toEqual(normal);
    });

    test('calendarless and inland channels are omitted; World State calendar works', () => {
        expect(tide(origin, { coastal: false })).toBeNull();
        expect(tide(origin, { coastal: 'true' })).toBeNull();
        expect(generateAmbientTide({ time: origin })).toBeNull();
        expect(tide(origin, { time: resolveAmbientTime({ messages: ['No clock'] }) })).toBeNull();
        expect(tide(origin, { time: { hours: origin, source: 'message-count', month: 1 } })).toBeNull();
        expect(tide(origin, { time: resolveAmbientTime({ worldState: { date: '2026-10-26', time: '23:00' } }) })).not.toBeNull();
    });

    test('forecast qualifies midnight rollover and is deterministic under random access', () => {
        for (let i = 0; i < 1000; i++) {
            const hours = -1000000 + i * 1234.567;
            const result = tide(hours);
            expect(tide(hours)).toEqual(result);
            expect(result.nextHighHours).toBeGreaterThan(hours);
            expect(result.nextHighHours - hours).toBeLessThanOrEqual(TIDE_PERIOD_HOURS + 1e-8);
            expect(tide(result.nextHighHours).state).toBe('high');
            const roundedDay = Math.floor(Math.round(result.nextHighHours * 2) / 48);
            expect(result.description.includes('tomorrow')).toBe(roundedDay > Math.floor(hours / 24));
        }
    });
});