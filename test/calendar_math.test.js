import { describe, expect, test } from 'vitest';
import {
    CALENDAR_SOLSTICE_HOURS, calendarDateFromDayIndex, calendarDateToHours, calendarDayIndex,
    calendarHoursToDate, calendarMonthLength, calendarOriginHours, calendarWeekday,
    formatCalendarDate, isCalendarDate, normalizeCalendarName, validateCalendarRecord,
} from '../core/calendar_math.js';
import { generateAmbientDaylight } from '../core/ambient_astronomy.js';
import { generateAmbientConditions } from '../core/ambient_generator.js';

const names = ['Snowmoon', 'Icewind', 'Thawmoon', 'Seedmoon', 'Bloom', 'Highsun', 'Rotmonth', 'Harvest', 'Frostmoon', 'Deepnight'];
const weekdays = ['Starday', 'Oneday', 'Twoday', 'Threeday', 'Fiveday', 'Sixday'];
const custom = (patch = {}) => ({ version: 1, structure: 'custom', months: names.map(name => ({ name, days: 36 })),
    weekdays: [...weekdays], era: 'Kelen Epoch', anchor: { year: 1247, month: 6, day: 18, weekday: 3 },
    dateLine: true, eventsLine: true, events: [], phenomena: [], ...patch });
const gregorian = () => ({ version: 1, structure: 'gregorian', eventsLine: true, events: [], phenomena: [] });
const config = { climate: 'temperate', hemisphere: 'north', seed: 42, variability: 0.5 };
const season = (hours, hemisphere = 'north') => generateAmbientConditions({ ...config, hemisphere, time: { hours, month: 1 } }).season;

describe('Phase 10 record schema and save-time validation', () => {
    test('both structures round-trip JSON; defaults custom without mutating input', () => {
        for (const record of [custom(), gregorian()]) {
            const result = validateCalendarRecord(record);
            expect(result).toEqual({ valid: true, errors: [], record });
            expect(result.record).not.toBe(record);
            expect(result.record.events).not.toBe(record.events);
        }
        const input = custom();
        delete input.structure;
        expect(validateCalendarRecord(input).record.structure).toBe('custom');
        expect(input.structure).toBeUndefined();
    });

    test('normalizes apostrophes, whitespace and Unicode; accepts international names', () => {
        const record = custom({ era: '  L’Ère  ', weekdays: ['火曜日', 'Lune’s Day'] });
        record.months[0].name = '  L‘Été  ';
        record.anchor.weekday = 1;
        const normalized = validateCalendarRecord(record).record;
        expect(normalized).toMatchObject({ era: "L'Ère", weekdays: ['火曜日', "Lune's Day"] });
        expect(normalized.months[0]).toEqual({ name: "L'Été", days: 36 });
        expect(record.months[0].name).toBe('  L‘Été  ');
        expect(normalizeCalendarName('E\u0301té')).toBe('Été');
    });

    test.each([
        null, undefined, [], 1, 'calendar', {},
        custom({ version: 2 }), custom({ structure: 'lunar' }),
        custom({ months: [] }), custom({ months: Array(25).fill({ name: 'Moon', days: 30 }) }),
        custom({ months: [null] }), custom({ months: [{ name: 'Moon', days: 0 }] }),
        custom({ months: [{ name: 'Moon', days: 41 }] }), custom({ months: [{ name: 'Moon', days: 2.5 }] }),
        custom({ weekdays: [] }), custom({ weekdays: ['Onlyday'] }), custom({ weekdays: Array(15).fill('Day') }),
        custom({ weekdays: ['Day', 'day'] }), custom({ weekdays: null, anchor: { year: 1247, month: 6, day: 18, weekday: 0 } }),
        custom({ anchor: null }), custom({ anchor: { year: 0, month: 6, day: 18, weekday: 3 } }),
        custom({ anchor: { year: 10000, month: 6, day: 18, weekday: 3 } }),
        custom({ anchor: { year: 1247, month: 11, day: 1, weekday: 3 } }),
        custom({ anchor: { year: 1247, month: 6, day: 37, weekday: 3 } }),
        custom({ anchor: { year: 1247, month: 6, day: 18, weekday: 6 } }),
        custom({ anchor: { year: 1247, month: 6, day: 18, weekday: -1 } }),
        custom({ anchor: { year: 1247, month: 6, day: 18, weekday: 1.5 } }),
        custom({ dateLine: 'true' }), custom({ eventsLine: 1 }), custom({ events: null }), custom({ phenomena: {} }),
        custom({ solstice: 123 }), gregorianWith('months', []), gregorianWith('anchor', {}),
        gregorianWith('weekdays', null), gregorianWith('era', null), gregorianWith('dateLine', false),
    ])('invalid input fails closed without throwing (%#)', record => {
        expect(() => validateCalendarRecord(record)).not.toThrow();
        expect(validateCalendarRecord(record)).toMatchObject({ valid: false, record: null });
        expect(validateCalendarRecord(record).errors.length).toBeGreaterThan(0);
    });

    test.each(['', '   ', 'Moon1', 'Moon,', '[Moon]', '<Moon>', 'Moon\nDay', 'Moon\tDay', 'Moon/Day', '🌙', '-\' ', 'A'.repeat(25)])('rejects unsafe name %j', name => {
        const record = custom();
        record.months[0].name = name;
        expect(validateCalendarRecord(record).valid).toBe(false);
        expect(validateCalendarRecord(custom({ era: name })).valid).toBe(false);
        expect(validateCalendarRecord(custom({ weekdays: [name, 'Otherday'] })).valid).toBe(false);
    });

    test('duplicates normalize case and apostrophes first', () => {
        const record = custom();
        record.months[0].name = 'Moon’s Rest';
        record.months[1].name = "MOON'S REST";
        expect(validateCalendarRecord(record).valid).toBe(false);
    });

    test('bounds are inclusive; weekday-less anchor omits weekday', () => {
        for (const count of [1, 24]) {
            const record = custom({ months: Array.from({ length: count }, (_, index) => ({ name: `Moon ${String.fromCharCode(65 + index)}`, days: index % 2 ? 40 : 1 })),
                anchor: { year: 1, month: 1, day: 1 }, weekdays: null, era: null });
            expect(validateCalendarRecord(record).valid).toBe(true);
            record.anchor = { year: 9999, month: count, day: record.months[count - 1].days, weekday: null };
            expect(validateCalendarRecord(record).valid).toBe(true);
        }
    });

    test('cyclic/non-JSON inputs fail without throwing', () => {
        const record = custom();
        record.events.push(record);
        expect(validateCalendarRecord(record).valid).toBe(false);
        expect(validateCalendarRecord({ toJSON: () => null }).valid).toBe(false);
        expect(validateCalendarRecord({ ...custom(), version: 1n }).valid).toBe(false);
    });
});

function gregorianWith(key, value) { return { ...gregorian(), [key]: value }; }

describe('negative-safe day and story-hour maps', () => {
    test('custom index is anchor-year relative and origin is derived, not stored', () => {
        const record = custom();
        expect(calendarDayIndex(record, record.anchor)).toBe(197);
        expect(calendarDayIndex(record, { year: 1247, month: 1, day: 1 })).toBe(0);
        expect(calendarDayIndex(record, { year: 1246, month: 10, day: 36 })).toBe(-1);
        expect(calendarDateFromDayIndex(record, -361)).toEqual({ year: 1245, month: 10, day: 36 });
        expect(calendarOriginHours(record)).toBe(CALENDAR_SOLSTICE_HOURS.north - 197 * 24);
        expect(calendarOriginHours(gregorian())).toBe(0);
    });

    test('ten thousand deterministic sampled instants round-trip, without mutation', () => {
        const records = [custom(), custom({ months: [{ name: 'Moon', days: 1 }], anchor: { year: 1, month: 1, day: 1, weekday: 3 } }),
            custom({ months: [{ name: 'Shortmoon', days: 1 }, { name: 'Longmoon', days: 40 }, { name: 'Lastmoon', days: 7 }],
                anchor: { year: 9999, month: 2, day: 40, weekday: 3 } }), gregorian()];
        const before = JSON.stringify(records);
        for (let index = 0; index < 10000; index++) {
            const record = records[index % records.length];
            const dayIndex = ((index * 7919) % 3000000) - 1500000;
            const date = { ...calendarDateFromDayIndex(record, dayIndex), hour: index % 24, minute: index % 60 };
            const options = { hemisphere: index % 2 ? 'north' : 'south' };
            const hours = calendarDateToHours(record, date, options);
            expect(calendarHoursToDate(record, hours, options)).toMatchObject(date);
            expect(calendarDayIndex(record, date)).toBe(dayIndex);
            expect(calendarDateToHours(record, calendarHoursToDate(record, hours, options), options)).toBeCloseTo(hours, 7);
            expect(calendarHoursToDate(record, hours, options)).toEqual(calendarHoursToDate(record, hours, options));
        }
        expect(JSON.stringify(records)).toBe(before);
    });

    test.each([1, 4, 99, 100, 400, 1247, 1900, 1969, 1970, 2000, 2024, 9999])('Gregorian leap arithmetic and year %i are not Date.UTC-shifted', year => {
        const record = gregorian();
        for (const month of [1, 2, 3, 12]) {
            const date = { year, month, day: calendarMonthLength(record, year, month), hour: 23, minute: 59 };
            expect(calendarHoursToDate(record, calendarDateToHours(record, date))).toMatchObject(date);
        }
    });

    test('Gregorian leap validation, epoch and weekday', () => {
        const record = gregorian();
        for (const year of [4, 400, 2000, 2024]) expect(isCalendarDate(record, { year, month: 2, day: 29 })).toBe(true);
        for (const year of [1, 100, 1900, 2023]) expect(isCalendarDate(record, { year, month: 2, day: 29 })).toBe(false);
        expect(calendarDayIndex(record, { year: 1970, month: 1, day: 1 })).toBe(0);
        expect(calendarDateToHours(record, { year: 1969, month: 12, day: 31 })).toBe(-24);
        expect(calendarWeekday(record, 0)).toBe('Thursday');
        expect(calendarWeekday(record, -1)).toBe('Wednesday');
    });

    test('clock rollover, year 1, pre-year-1 diagnostics and sub-minute input', () => {
        const record = custom();
        const date = { year: 1, month: 1, day: 1 };
        const start = calendarDateToHours(record, date);
        expect(start).toBeLessThan(0);
        expect(calendarHoursToDate(record, start)).toMatchObject({ ...date, hour: 0, minute: 0 });
        expect(calendarHoursToDate(record, start - 1 / 60)).toMatchObject({ year: 0, month: 10, day: 36, hour: 23, minute: 59 });
        expect(formatCalendarDate(record, { year: -1, month: 1, day: 1 }, { weekday: false })).toBe('Snowmoon 1, -1');
        for (const hours of [-0.0001, -24, 0, 0.0001, 23.99999, 99999.123456]) {
            expect(calendarDateToHours(record, calendarHoursToDate(record, hours))).toBeCloseTo(hours, 7);
        }
    });

    test('invalid arithmetic inputs throw explicit range errors', () => {
        const record = custom();
        for (const hours of [NaN, Infinity, -Infinity]) expect(() => calendarHoursToDate(record, hours)).toThrow(RangeError);
        for (const index of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => calendarDateFromDayIndex(record, index)).toThrow(RangeError);
            expect(() => calendarWeekday(record, index)).toThrow(RangeError);
        }
        for (const patch of [{ month: 0 }, { month: 11 }, { day: 37 }, { day: 0 }, { hour: 24 }, { minute: 60 }, { second: 60 }, { year: 1.5 }]) {
            expect(() => calendarDateToHours(record, { ...record.anchor, ...patch })).toThrow(RangeError);
        }
        expect(() => calendarOriginHours(record, { hemisphere: 'east' })).toThrow(RangeError);
        expect(() => calendarDateFromDayIndex(gregorian(), Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    });
});

describe('weekday and formatting', () => {
    test.each(Array.from({ length: 13 }, (_, index) => index + 2))('%i-day cycle runs forward and backward through the anchor', count => {
        const record = custom({ weekdays: Array.from({ length: count }, (_, index) => `Day ${String.fromCharCode(65 + index)}`) });
        record.anchor.weekday = count - 1;
        const anchorIndex = calendarDayIndex(record, record.anchor);
        for (let offset = -100; offset <= 100; offset++) {
            const expected = ((count - 1 + offset) % count + count) % count;
            expect(calendarWeekday(record, anchorIndex + offset)).toBe(record.weekdays[expected]);
        }
        expect(validateCalendarRecord(record).valid).toBe(true);
    });

    test('weekday-less null, optional era prefix, Gregorian formatting', () => {
        const record = custom();
        expect(formatCalendarDate(record, record.anchor)).toBe('Threeday, Highsun 18, 1247');
        expect(formatCalendarDate(record, record.anchor, { era: true })).toBe('Kelen Epoch Threeday, Highsun 18, 1247');
        record.weekdays = null;
        record.anchor.weekday = null;
        expect(calendarWeekday(record, -1)).toBeNull();
        expect(formatCalendarDate(record, record.anchor)).toBe('Highsun 18, 1247');
        expect(formatCalendarDate(gregorian(), { year: 2000, month: 2, day: 29 })).toBe('Tuesday, February 29, 2000');
    });
});

describe('derived solstice and leap-aware solar drift', () => {
    test.each(['north', 'south'])('%s anchor is summer in the shipped sun and weather formulas', hemisphere => {
        const record = custom();
        const hours = calendarDateToHours(record, record.anchor, { hemisphere });
        expect(hours).toBe(CALENDAR_SOLSTICE_HOURS[hemisphere]);
        const date = new Date(hours * 3600000);
        expect([date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()]).toEqual([2000, hemisphere === 'south' ? 11 : 5, 21]);
        expect(season(hours + 12, hemisphere)).toBe('summer');
        const sky = generateAmbientDaylight({ ...config, hemisphere, latitude: 60, time: { hours: hours + 12, month: 1 } });
        // Compare with the formula's extremum sampled one day either side.
        const extremum = hemisphere === 'south' ? -23.44 : 23.44;
        const resolution = Math.abs(23.44 * (1 - Math.cos(2 * Math.PI / 365)));
        expect(Math.abs(sky.declination - extremum)).toBeLessThanOrEqual(resolution + 1e-12);
    });

    test('unset ambient defaults June and hemisphere flip shifts every custom date together', () => {
        const record = custom();
        expect(calendarDateToHours(record, record.anchor)).toBe(CALENDAR_SOLSTICE_HOURS.north);
        for (const year of [1, 1240, 1247, 1294, 9999]) {
            const date = { year, month: 6, day: 18 };
            expect(calendarDateToHours(record, date, { hemisphere: 'south' }) - calendarDateToHours(record, date))
                .toBe(CALENDAR_SOLSTICE_HOURS.south - CALENDAR_SOLSTICE_HOURS.north);
        }
    });

    test.each([354, 360, 365, 366])('%i-day calendar drifts against Gregorian leap years, not a stretched sun', yearDays => {
        const record = custom({ months: Array.from({ length: 12 }, (_, index) => ({ name: `Moon ${String.fromCharCode(65 + index)}`, days: Math.floor(yearDays / 12) + (index < yearDays % 12 ? 1 : 0) })) });
        for (const elapsed of [4, 7, 47]) {
            const hours = calendarDateToHours(record, { ...record.anchor, year: record.anchor.year + elapsed });
            const reference = Date.UTC(2000 + elapsed, 5, 21) / 3600000;
            const actualDrift = (hours - reference) / 24;
            expect(Math.abs(actualDrift - elapsed * (yearDays - 365.2425))).toBeLessThanOrEqual(1);
            if (yearDays === 354 && elapsed === 7) expect(season(hours + 12)).toBe('spring');
            if (yearDays === 354 && elapsed === 47) expect(season(hours + 12)).toBe('winter');
            if (yearDays === 365 && elapsed === 4) expect(actualDrift).toBe(-1);
        }
    });
});