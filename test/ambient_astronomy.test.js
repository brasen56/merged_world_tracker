import { describe, expect, test } from 'vitest';
import { AMBIENT_LATITUDES, auroraPossible, flooredMod, generateAmbientDaylight, roundSkyTime, solarCrossings } from '../core/ambient_astronomy.js';
import { parseAmbientDateTime } from '../core/ambient_time.js';
import { generateAmbientConditions } from '../core/ambient_generator.js';

const config = { climate: 'temperate', hemisphere: 'north', manualSeason: 'spring', variability: 0.5, seed: 42 };
const at = (date, clock = '12:00', patch = {}) => generateAmbientDaylight({ ...config, time: parseAmbientDateTime(date, clock), ...patch });

describe('Phase 5 pure sun-time astronomy', () => {
    test.each([
        [51.5, '2026-06-21', '20:19', null],
        [47.6, '2026-08-15', '19:06', null],
        [0, '2026-03-21', '18:04', null],
        [0, '2026-06-21', '18:04', null],
        [0, '2026-12-21', '18:04', null],
        [55, '2026-07-15', '20:24', '21:16'],
        [55, '2026-12-21', '15:35', '16:21'],
        [45, '2026-08-15', '19:01', null],
        [68, '2026-12-01', '12:58', null],
    ])('%s° on %s matches the design solar anchors', (latitude, date, sunset, civilDusk) => {
        const sky = at(date, '12:00', { latitude });
        const numeric = text => Number(text.slice(0, 2)) + Number(text.slice(3)) / 60;
        expect(Math.abs(sky.sunset - numeric(sunset)) * 60).toBeLessThanOrEqual(10);
        if (civilDusk) expect(Math.abs(sky.civilDusk - numeric(civilDusk)) * 60).toBeLessThanOrEqual(10);
    });

    test.each(['2026-05-27', '2026-06-21', '2026-07-17'])('68°N polar day on %s', date => {
        const sky = at(date, '00:00', { latitude: 68 });
        expect(sky).toMatchObject({ polarDay: true, regime: 'daylight', dayLength: 24, sunrise: null, sunset: null });
        expect(sky.description).toContain('sun does not set');
    });
    test.each(['2026-12-08', '2026-12-21', '2026-01-03'])('68°N polar night on %s', date => {
        const sky = at(date, '12:00', { latitude: 68 });
        expect(sky).toMatchObject({ polarNight: true, dayLength: 0, sunrise: null, sunset: null });
        expect(sky.description).toContain('sun will not rise');
    });
    test.each(['2026-05-26', '2026-07-18', '2026-12-01', '2026-01-04'])('68°N has sunrise and sunset outside the polar windows: %s', date => {
        expect(at(date, '12:00', { latitude: 68 })).toMatchObject({ polarDay: false, polarNight: false });
    });

    test('exact time fixes summer night and winter afternoon band contradictions', () => {
        const summerTime = parseAmbientDateTime('2026-07-15', '21:00');
        const summer = generateAmbientDaylight({ ...config, time: summerTime, latitude: 55 });
        expect(generateAmbientConditions({ ...config, time: summerTime }).band.name).toBe('night');
        expect(summer.regime).toBe('twilight');
        expect(summer.description).toContain('civil dusk ends around 21:30');
        const winterTime = parseAmbientDateTime('2026-12-21', '16:30');
        expect(generateAmbientConditions({ ...config, time: winterTime }).band.name).toBe('afternoon');
        expect(generateAmbientDaylight({ ...config, time: winterTime, latitude: 55 }).regime).toBe('darkness');
        expect(at('2026-12-21', '15:00', { latitude: 55 }).regime).toBe('daylight');
    });

    test.each([55, 60])('August at 17:00 is daylight at %s°N', latitude => {
        const sky = at('2026-08-15', '17:00', { latitude });
        expect(sky.regime).toBe('daylight');
        expect(sky.description).toContain('sunset around');
    });

    test.each(['north', 'south'])('manual season is local, not double-inverted in %s', hemisphere => {
        const proxy = manualSeason => generateAmbientDaylight({ ...config, time: { hours: 17, month: null }, latitude: 60, hemisphere, manualSeason });
        expect(proxy('summer').dayClass).toBe('long');
        expect(proxy('winter').dayClass).toBe('short');
        expect(proxy('summer').description).toContain('seasonal proxy.');
        expect(proxy('summer').description).not.toContain('no calendar clock');
        expect(proxy('summer').dayLength).toBe(generateAmbientDaylight({ ...config, time: { hours: 17, month: null }, latitude: 60, manualSeason: 'summer' }).dayLength);
    });

    test('calendar southern hemisphere reverses the seasons', () => {
        expect(at('2026-06-21', '12:00', { latitude: 60, hemisphere: 'south' }).dayClass).toBe('short');
        expect(at('2026-12-21', '12:00', { latitude: 60, hemisphere: 'south' }).dayClass).toBe('long');
    });

    test('clockAhead converts the story clock to sun time, not just stated times', () => {
        const sunTime = at('2026-07-15', '21:00', { latitude: 55 });
        const oneHourAhead = at('2026-07-15', '21:00', { latitude: 55, clockAhead: 1 });
        expect(sunTime).toMatchObject({ regime: 'twilight', clockAhead: 0 });
        expect(sunTime.description).toContain('civil dusk ends around 21:30');
        // A clock one hour ahead of the sun sees the same 21:00 an hour earlier
        // in sun time: golden daylight before a 21:30 sunset, not dusk. The
        // stated time must never sit in the future of the regime it comes from.
        expect(oneHourAhead).toMatchObject({ regime: 'daylight', clockAhead: 1,
            dayLength: sunTime.dayLength, declination: sunTime.declination });
        expect(oneHourAhead.description).toContain('golden');
        expect(oneHourAhead.description).toContain('sunset around 21:30');
    });

    test('clockAhead resolves the real-place zone and DST gap end to end', () => {
        // Live smoke-test repro: 2000-08-24 19:09 at 39.1°N. In sun time the
        // sun set at 18:39; on a real civil clock ~1 h ahead it sets ~19:39.
        const clock = parseAmbientDateTime('2000-08-24', '19:09');
        const sunFrame = generateAmbientDaylight({ ...config, time: clock, latitude: 39.1 });
        expect(sunFrame.regime).toBe('darkness');
        expect(sunFrame.description).toContain('sunset around 18:30');
        const civilFrame = generateAmbientDaylight({ ...config, time: clock, latitude: 39.1, clockAhead: 1 });
        expect(civilFrame.regime).toBe('daylight');
        expect(civilFrame.description).toContain('sunset around 19:30');
    });

    test('rounding and modulo work before 1970 and across midnight', () => {
        expect(flooredMod(-1, 24)).toBe(23);
        expect(roundSkyTime(23.8, 1)).toBe('01:00');
        expect(roundSkyTime(-0.2)).toBe('00:00');
        expect(at('1850-08-15', '17:00', { latitude: 60 }).regime).toBe('daylight');
    });

    test.each(Object.entries(AMBIENT_LATITUDES))('%s derives latitude %s on read', (climate, latitude) => {
        expect(at('2026-08-15', '12:00', { climate })).toMatchObject({ latitude, isDefault: true });
        expect(at('2026-08-15', '12:00', { climate, latitude: 0 })).toMatchObject({ latitude: 0, isDefault: false });
    });

    test('three regimes have exact boundaries and empty regimes are first-class', () => {
        const noon = at('2026-08-15', '12:00', { latitude: 45 });
        const day = Math.floor(parseAmbientDateTime('2026-08-15', '12:00').hours / 24) * 24;
        const regime = hour => generateAmbientDaylight({ ...config, latitude: 45, time: { hours: day + hour, month: 8 } }).regime;
        expect(regime(noon.sunset - 0.001)).toBe('daylight');
        expect(regime(noon.sunset + 0.001)).toBe('twilight');
        expect(regime(noon.civilDusk + 0.001)).toBe('darkness');
        expect(at('2026-06-21', '00:00', { latitude: 61 })).toMatchObject({ regime: 'twilight', noDarkness: true, aurora: false });
        expect(at('2026-12-21', '12:00', { latitude: 70 })).toMatchObject({ regime: 'twilight', polarNight: true });
        expect(solarCrossings(90, 23.44).state).toBe('always-above');
        expect(solarCrossings(90, -23.44).state).toBe('always-below');
        expect(solarCrossings(90, -3).state).toBe('always-below');
        expect(solarCrossings(90, -3, -6).state).toBe('always-above');
    });

    test('auroras are deterministic, per-night, latitude-scaled, and darkness-only', () => {
        let high = 0;
        let low = 0;
        for (let seed = 0; seed < 1000; seed++) {
            const input = { seed, hours: 23, latitude: 65, regime: 'darkness' };
            const result = auroraPossible(input);
            expect(auroraPossible({ ...input, hours: 25 })).toBe(result);
            expect(auroraPossible({ ...input, regime: 'twilight' })).toBe(false);
            expect(auroraPossible({ ...input, latitude: 49 })).toBe(false);
            high += Number(result);
            low += Number(auroraPossible({ ...input, latitude: 55 }));
        }
        expect(high).toBeGreaterThan(low);
        expect(low).toBeGreaterThan(0);
    });
});