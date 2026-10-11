import { describe, expect, test } from 'vitest';
import { AMBIENT_MONTHS, parseAmbientDateTime, parseAmbientTimestamp, resolveAmbientTime } from '../core/ambient_time.js';

const tag = (clock = '02:30 PM', date = 'June 4, 2026') => `[In-story time: ${clock}, Thursday, ${date}]`;

describe('ambient timestamp parser', () => {
    test('accepts the canonical tag and uses timezone-independent story hours', () => {
        expect(parseAmbientTimestamp(`Narration\n${tag()}`)).toEqual({
            hours: Date.UTC(2026, 5, 4, 14, 30) / 3600000,
            year: 2026, month: 6, day: 4, hour: 14, minute: 30,
        });
    });

    test.each([
        '[In-story time: Unknown]', '[In-story time: Evening]',
        tag('Evening'), tag('02:30 PM', 'Frostfall 4, 2026'),
        tag('00:30 AM'), tag('14:30 PM'), tag('02:60 PM'),
        tag('02:30 PM', 'February 29, 2025'), tag('02:30 PM', 'April 31, 2026'),
        tag('02:30 PM', 'June 0, 2026'), tag('02:30 PM', 'June 4, 0000'),
    ])('fails closed: %s', value => {
        expect(parseAmbientTimestamp(value)).toBeNull();
    });

    test('handles noon, midnight, leap days and years below 100', () => {
        expect(parseAmbientTimestamp(tag('12:00 AM')).hour).toBe(0);
        expect(parseAmbientTimestamp(tag('12:00 PM')).hour).toBe(12);
        expect(parseAmbientDateTime('February 29, 2024', '23:59')).toMatchObject({ month: 2, day: 29 });
        expect(parseAmbientDateTime('June 4, 42', '2pm')).toMatchObject({ year: 42, hour: 14 });
        expect(parseAmbientDateTime('2026-06-04', '14:30')).toEqual(parseAmbientDateTime('Thursday, June 4, 2026', '2:30 PM'));
    });

    test('does not guess locale, relative dates, qualitative clocks or ambiguous prose', () => {
        for (const date of ['06/04/2026', 'tomorrow', 'around June 4, 2026', 'Unknown']) {
            expect(parseAmbientDateTime(date, '14:30')).toBeNull();
        }
        for (const clock of ['Evening', 'Unknown', '', 'around 2pm', '24:00', '14']) {
            expect(parseAmbientDateTime('June 4, 2026', clock)).toBeNull();
        }
        expect(parseAmbientTimestamp(null)).toBeNull();
    });

    test('supports an explicit month-name list without guessing fantasy names', () => {
        const monthNames = [...AMBIENT_MONTHS];
        monthNames[5] = 'Frostfall';
        expect(parseAmbientTimestamp(tag('02:30 PM', 'Frostfall 4, 2026'), { monthNames })).toMatchObject({ month: 6 });
    });

    test('uses the last usable tag within a message', () => {
        expect(parseAmbientTimestamp(`${tag('01:00 PM')} ${tag('03:00 PM')} [In-story time: Unknown]`).hour).toBe(15);
    });
});

describe('ambient source ladder', () => {
    const worldState = '## Current Scene\nDate: June 5, 2026\nTime: 10:00 AM\nLocation: Harbour\nPresent: None\nSituation: Waiting';

    test('prefers the latest usable message tag over World State', () => {
        const messages = [{ mes: tag('01:00 PM') }, { mes: tag('04:00 PM') }, { mes: '[In-story time: Unknown]' }];
        expect(resolveAmbientTime({ messages, worldState })).toMatchObject({ source: 'timestamp', hour: 16, messageIndex: 1 });
    });

    test('skips the old swipe clock without mutating messages', () => {
        const messages = Object.freeze([Object.freeze({ mes: tag('01:00 PM') }), Object.freeze({ mes: tag('04:00 PM') })]);
        expect(resolveAmbientTime({ messages, type: 'swipe' })).toMatchObject({ source: 'timestamp', hour: 13, messageIndex: 0 });
        expect(resolveAmbientTime({ messages, type: 'continue' }).hour).toBe(16);
    });

    test('tries the scene date/time, including a pre-parsed scene', () => {
        expect(resolveAmbientTime({ worldState })).toMatchObject({ source: 'world-state', day: 5, hour: 10 });
        expect(resolveAmbientTime({ worldState: { date: '2026-06-05', time: '10:00' } })).toMatchObject({ source: 'world-state', day: 5 });
    });

    test('falls back to count time with no invented month or host time', () => {
        const messages = ['hello', 'world'];
        expect(resolveAmbientTime({ messages, worldState: { date: 'Frostfall 4, 2026', time: 'Evening' } })).toEqual({ hours: 2, month: null, source: 'message-count' });
        expect(resolveAmbientTime({ messages, type: 'swipe', hoursPerMessage: 3 }).hours).toBe(3);
        expect(resolveAmbientTime({ messages: [], type: 'swipe' }).hours).toBe(0);
        expect(resolveAmbientTime({ messages: null }).hours).toBe(0);
        expect(() => resolveAmbientTime({ hoursPerMessage: 0 })).toThrow(RangeError);
    });
});