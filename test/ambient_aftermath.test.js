import { describe, expect, test } from 'vitest';
import { generateAmbientAftermath } from '../core/ambient_aftermath.js';
import { generateAmbientConditions, quantizeAmbientTime } from '../core/ambient_generator.js';
import { parseAmbientDateTime } from '../core/ambient_time.js';

const config = { seed: 12, climate: 'temperate', hemisphere: 'north', variability: 0.5 };
const hoursAt = (date, time = '12:00') => parseAmbientDateTime(date, time).hours;
const clock = hours => ({ hours, month: new Date(hours * 3600000).getUTCMonth() + 1, source: 'timestamp' });
const read = (hours, options = {}) => generateAmbientAftermath({ ...config, ...options, time: clock(hours) });
const dry = { sky: 'clear', temperature: 'mild', air: 'dry', precipitation: 'none', wind: 'calm' };
const snow = { ...dry, sky: 'overcast', temperature: 'freezing', precipitation: 'snow' };
const pinAt = (startHours, endHours, conditions) => ({ startHours, endHours, conditions, source: 'timestamp' });

describe('Phase 8 random-access aftermath', () => {
    test('deterministic direct access, rewind and within-band stability', () => {
        const hours = hoursAt('2026-10-15', '12:00');
        const original = read(hours);
        expect(read(hours + 5.99)).toEqual(original);
        read(hours + 24 * 100);
        expect(read(hours)).toEqual(original);
        expect(read(hours + 6)).toEqual(read(hours + 6));
    });

    test('names a pin transition inside the trailing window, not an invented ground effect', () => {
        const hours = hoursAt('2026-06-04');
        const pin = pinAt(hours - 18, hours + 24, { ...dry, precipitation: 'rain' });
        expect(read(hours, { pin }).summary).toBe('rain since yesterday evening; previously clear');
        expect(read(hours, { pin }).description).not.toMatch(/mud|wet ground|soft/);
        expect(read(hours + 30, { pin }).summary).not.toContain('since yesterday evening');
    });

    test.each([
        [-1, 3, 'last night'],
        [-1, 12, 'last night'],
        [1, 3, 'last night'],
        [1, 12, 'last night'],
        [4.99, 12, 'last night'],
        [5, 12, 'today dawn'],
        [21, 23, 'today night'],
    ])('night wording for a transition at %s and observation at %s', (start, now, label) => {
        const day = hoursAt('2026-06-04', '00:00');
        const pin = pinAt(day + start, null, { ...snow, precipitation: 'blizzard' });
        expect(read(day + now, { climate: 'tropical', pin }).summary)
            .toMatch(new RegExp(`^blizzard since ${label}; previously `));
    });

    test('past bands apply an expired stored pin and rewind restores it', () => {
        const hours = hoursAt('2026-06-04');
        const pin = pinAt(hours - 18, hours - 1, { ...dry, precipitation: 'blizzard' });
        const before = JSON.stringify(pin);
        expect(read(hours, { pin }).description).toContain('blizzard');
        expect(read(hours - 6, { pin }).summary).toContain('blizzard since yesterday evening');
        expect(read(hours + 48, { pin }).description).not.toContain('blizzard');
        expect(read(hours, { pin }).description).toContain('blizzard');
        expect(JSON.stringify(pin)).toBe(before);
    });

    test('pin starts and exclusive ends midway through a band are respected', () => {
        const hours = hoursAt('2026-06-04');
        const pin = pinAt(hours + 1, hours + 2, { ...dry, precipitation: 'blizzard' });
        expect(read(hours + 0.99, { pin }).description).not.toContain('blizzard');
        expect(read(hours + 1, { pin }).summary).toMatch(/^blizzard since today afternoon/);
        expect(read(hours + 2, { pin }).summary).not.toMatch(/^blizzard/);
        expect(read(hours + 2, { pin }).description).toContain('previously blizzard');
    });

    test('clockless histories use manual seasons, never claim seasonal firsts, and isolate pin clock domains', () => {
        const time = { hours: 30, month: null, source: 'message-count' };
        const options = { ...config, time, manualSeason: 'winter', pin: pinAt(0, null, snow) };
        const result = generateAmbientAftermath(options);
        expect(result.crossings).toEqual([]);
        expect(result.description).not.toContain('first');
        expect(generateAmbientAftermath({ ...options, pin: { ...options.pin, source: 'message-count' } }).summary).toBe('snow throughout the past day');
        expect(result).toEqual(generateAmbientAftermath({ ...options, pin: null }));
        expect(generateAmbientAftermath({ ...options, manualSeason: 'summer' }).summary).not.toBe(result.summary);
    });

    test('first frost and snow appear only after their crossing, expire at midnight, and restore on rewind', () => {
        const start = hoursAt('2026-09-01', '00:00');
        const pin = pinAt(start + 13, null, snow);
        const options = { climate: 'tropical', pin };
        expect(read(start + 12.99, options).crossings).toEqual([]);
        const result = read(start + 13, options);
        expect(result.crossings.map(event => event.kind)).toEqual(['frost', 'snow']);
        expect(result.description).toContain('first frost today afternoon');
        expect(read(start + 23.99, options).crossings).toEqual(result.crossings);
        expect(read(start + 24, options).crossings).toEqual([]);
        expect(read(start + 13, options)).toEqual(result);
        expect(read(start - 1, options).crossings).toEqual([]);
    });

    test('spring thaw requires a freezing predecessor and respects southern seasons and leap days', () => {
        const start = hoursAt('2028-03-01', '00:00');
        const pin = pinAt(start - 24, start + 8, snow);
        expect(read(start + 7, { climate: 'tropical', pin }).crossings).toEqual([]);
        expect(read(start + 8, { climate: 'tropical', pin }).crossings).toMatchObject([{ kind: 'thaw', hours: start + 8 }]);
        expect(read(start + 8, { climate: 'tropical', pin: null }).crossings).toEqual([]);
        const south = hoursAt('2026-03-01', '00:00');
        expect(read(south + 13, { climate: 'tropical', hemisphere: 'south', pin: pinAt(south + 13, null, snow) }).crossings.map(event => event.kind)).toEqual(['frost', 'snow']);
    });

    test('December season start crosses the year boundary without announcing a second first', () => {
        const start = hoursAt('2025-12-01', '00:00');
        const pin = pinAt(start, null, snow);
        expect(read(start + 12, { pin }).crossings.map(event => event.kind)).toEqual(['snow']);
        expect(read(hoursAt('2026-01-01'), { pin }).crossings).toEqual([]);
    });

    test('settings and pin edits invalidate memoized history, including seed, climate, variability and hemisphere', () => {
        const hours = hoursAt('2026-09-01', '18:00');
        const pin = pinAt(hours - 5, null, snow);
        const original = read(hours, { climate: 'tropical', pin });
        expect(original.crossings).toHaveLength(2);
        expect(read(hours, { climate: 'tropical', pin: { ...pin, conditions: dry } }).crossings).toEqual([]);
        for (const patch of [{ seed: 432 }, { variability: 1 }, { hemisphere: 'south' }, { climate: 'desert' }]) {
            const expected = read(hours, { ...patch, pin });
            read(hours, { seed: 98 });
            expect(read(hours, { ...patch, pin })).toEqual(expected);
        }
        expect(read(hours, { climate: 'tropical', pin })).toEqual(original);
        const summaries = new Set(Array.from({ length: 20 }, (_, seed) => read(hours, { seed }).summary));
        expect(summaries.size).toBeGreaterThan(1);
    });

    test('seasonal scan agrees with public generator at the first freezing band, not a later repeat', () => {
        const start = hoursAt('2026-09-01', '00:00');
        let first = null;
        for (let hours = start; hours < hoursAt('2026-12-01', '00:00'); hours = quantizeAmbientTime(hours).nextHours) {
            if (generateAmbientConditions({ ...config, time: clock(hours) }).conditions.temperature === 'freezing') {
                first = hours;
                break;
            }
        }
        expect(first).not.toBeNull();
        expect(read(first).crossings).toContainEqual(expect.objectContaining({ kind: 'frost', hours: first }));
        expect(read(first + 24).crossings.map(event => event.kind)).not.toContain('frost');
    });
});