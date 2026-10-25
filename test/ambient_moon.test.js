import { describe, expect, test } from 'vitest';
import { generateAmbientDaylight, generateAmbientMoon, isMoonEpochOffset, lunarPhaseAt, LUNAR_EPOCH_HOURS, LUNAR_MONTH_DAYS, moonAnchorOffset, MOON_PHASES, NIGHT_BRIGHTNESS } from '../core/ambient_astronomy.js';
import { parseAmbientDateTime, resolveAmbientTime } from '../core/ambient_time.js';

const clear = { sky: 'clear', precipitation: 'none' };
const full = parseAmbientDateTime('2026-10-24', '21:00').hours;
const offset = moonAnchorOffset(full);
const moon = (hours, patch = {}) => generateAmbientMoon({ time: hours, moonEpochOffset: offset,
    daylight: { regime: 'darkness' }, conditions: clear, ...patch });

describe('Phase 6 pure lunar astronomy', () => {
    test('epoch is the specified UTC-shaped story instant', () => {
        expect(LUNAR_EPOCH_HOURS).toBe(parseAmbientDateTime('2000-01-06', '18:14').hours);
        expect(lunarPhaseAt(LUNAR_EPOCH_HOURS)).toMatchObject({ age: 0, phase: 0, bin: 0, name: 'new', illumination: 0 });
    });

    // NASA GSFC greatest-eclipse instants, converted from TD using each row's
    // delta-T and rounded to UT minutes; centered bins are insensitive to seconds.
    // https://eclipse.gsfc.nasa.gov/SEcat5/SE2001-2100.html
    // https://eclipse.gsfc.nasa.gov/LEcat5/LE2001-2100.html
    const eclipses = [
        ['2024-04-08', '18:17', 'new'], ['2025-03-14', '06:59', 'full'],
        ['2025-09-07', '18:12', 'full'], ['2026-03-03', '11:34', 'full'],
        ['2026-08-12', '17:46', 'new'],
    ];
    test.each(eclipses)('eclipse %s %s bins as %s', (date, clock, name) => {
        expect(lunarPhaseAt(parseAmbientDateTime(date, clock).hours).name).toBe(name);
    });
    test('floor bins regress four of the five eclipse anchors', () => {
        const failures = eclipses.filter(([date, clock, name]) => {
            const { phase } = lunarPhaseAt(parseAmbientDateTime(date, clock).hours);
            return MOON_PHASES[Math.floor(phase * 8)] !== name;
        });
        expect(failures).toHaveLength(4);
    });
    test('independent full-moon almanac spot check is within one day, away from bin edges', () => {
        // NASA GSFC phase table: January 9, 2001, 20:24 UT.
        // https://eclipse.gsfc.nasa.gov/phase/phase2001gmt.html
        const result = lunarPhaseAt(parseAmbientDateTime('2001-01-09', '20:24').hours);
        expect(result.name).toBe('full');
        expect(Math.abs(result.age - LUNAR_MONTH_DAYS / 2)).toBeLessThanOrEqual(1);
    });
    test('pre-1970 dates and 10k sampled times are valid, deterministic and bounded', () => {
        expect(MOON_PHASES).toContain(lunarPhaseAt(parseAmbientDateTime('1850-06-01', '22:00').hours).name);
        for (let index = 0; index < 10000; index++) {
            const hours = -2000000 + index * 401.37;
            const result = moon(hours);
            expect(moon(hours)).toEqual(result);
            expect(MOON_PHASES).toContain(result.name);
            expect(result.age).toBeGreaterThanOrEqual(0);
            expect(result.age).toBeLessThan(LUNAR_MONTH_DAYS);
            expect(result.illumination).toBeGreaterThanOrEqual(0);
            expect(result.illumination).toBeLessThanOrEqual(1);
        }
    });
    test('centered bins wrap symmetrically around new and full', () => {
        for (const [phase, name] of [[0, 'new'], [0.5, 'full'], [1, 'new']]) {
            for (const delta of [-1, 0, 1]) {
                expect(lunarPhaseAt(LUNAR_EPOCH_HOURS + (phase * LUNAR_MONTH_DAYS + delta) * 24).name).toBe(name);
            }
        }
    });
    test('phase remains stable through a representative night, not artificially frozen at bin edges', () => {
        expect(new Set(Array.from({ length: 10 }, (_, hour) => moon(full + hour).name))).toEqual(new Set(['full']));
        const edge = LUNAR_EPOCH_HOURS + LUNAR_MONTH_DAYS * 24 / 16;
        expect(lunarPhaseAt(edge - 0.01).name).toBe('new');
        expect(lunarPhaseAt(edge + 0.01).name).toBe('waxing crescent');
    });
    test.each([[0.25, 2, false], [0.75, 22, false], [0.5, 20, true]])('moon-up at phase %s and hour %s is %s', (phase, hour, up) => {
        const hours = Math.floor(full / 24) * 24 + hour;
        const moonEpochOffset = hours - LUNAR_EPOCH_HOURS - phase * LUNAR_MONTH_DAYS * 24;
        expect(moon(hours, { moonEpochOffset }).up).toBe(up);
    });
    test('anchor rewrites past and future coherently and is independent of weather seed or clock offset', () => {
        expect(moon(full)).toMatchObject({ name: 'full', illumination: 1, up: true });
        expect(moon(full - 3 * 24).name).toBe('waxing gibbous');
        expect(moon(full + 3 * 24).name).toBe('waning gibbous');
        expect(lunarPhaseAt(full + LUNAR_MONTH_DAYS * 24, offset).phase).toBeCloseTo(0.5);
        expect(moon(full, { seed: 999, clockAhead: 2 })).toEqual(moon(full));
        expect(isMoonEpochOffset(offset)).toBe(true);
        expect(isMoonEpochOffset(Infinity)).toBe(false);
        expect(lunarPhaseAt(full, NaN)).toEqual(lunarPhaseAt(full));
        expect(() => lunarPhaseAt(NaN)).toThrow(RangeError);
        expect(() => moonAnchorOffset(NaN)).toThrow(RangeError);
    });
    test('brightness is gated by exact darkness, moon-up and pinned weather', () => {
        expect(moon(full).brightness).toBe(NIGHT_BRIGHTNESS.bright);
        expect(moon(full, { conditions: { sky: 'partly cloudy', precipitation: 'none' } }).brightness).toBe(NIGHT_BRIGHTNESS.moonlit);
        expect(moon(full, { conditions: { sky: 'overcast', precipitation: 'none' } }).brightness).toBe(NIGHT_BRIGHTNESS.faint);
        expect(moon(full, { conditions: { sky: 'overcast', precipitation: 'rain' } }).brightness).toBe(NIGHT_BRIGHTNESS.black);
        expect(moon(full + 12).brightness).toBe(NIGHT_BRIGHTNESS.stars);
        for (const regime of ['daylight', 'twilight']) expect(moon(full, { daylight: { regime } }).brightness).toBeNull();
        const time = parseAmbientDateTime('2026-06-21', '00:00');
        const daylight = generateAmbientDaylight({ time, latitude: 61 });
        const newMoonOffset = time.hours - LUNAR_EPOCH_HOURS;
        expect(daylight.noDarkness).toBe(true);
        const whiteNight = moon(time.hours, { moonEpochOffset: newMoonOffset, daylight });
        expect(whiteNight.name).toBe('new');
        expect(whiteNight.brightness).toBeNull();
        expect(whiteNight.description).not.toContain('black night');
    });
    test('calendar timestamps and World State work; fabricated message-count time is omitted', () => {
        expect(moon(full, { time: resolveAmbientTime({ messages: ['No date'] }) })).toBeNull();
        expect(moon(full, { time: { hours: full, month: 10, source: 'message-count' } })).toBeNull();
        const time = resolveAmbientTime({ worldState: { date: '2026-10-24', time: '18:00' } });
        expect(time.source).toBe('world-state');
        expect(moon(full, { time }).name).toBe('full');
    });
});