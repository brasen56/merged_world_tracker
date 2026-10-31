/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseAmbientDateTime, parseAmbientTimestamp, resolveAmbientTime } from '../core/ambient_time.js';
import { calendarDateToHours, validateCalendarRecord } from '../core/calendar_math.js';
import { readAmbientConditions } from '../core/ambient_state.js';
import { buildInjectionBody } from '../ambient/injection.js';
import { getWeekdayDriftStatus, observeWeekdayDrift } from '../core/weekday_drift.js';
import { renderOverviewSnapshot } from '../dashboard/render.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import { bumpEpoch } from '../core/scope.js';

const custom = () => ({ version: 1, structure: 'custom',
    months: ['Snowmoon', 'Icewind', 'Thawmoon', 'Seedmoon', 'Bloom', 'Highsun', 'Rotmonth', 'Harvest', 'Frostmoon', 'Deepnight']
        .map(name => ({ name, days: 36 })),
    weekdays: ['Starday', 'Oneday', 'Twoday', 'Threeday', 'Fiveday', 'Sixday'],
    era: 'Kelen Epoch', anchor: { year: 1247, month: 6, day: 18, weekday: 3 },
    dateLine: true, eventsLine: true, events: [], phenomena: [] });
const tag = (date = 'Rotmonth 3, 1247', weekday = 'Fiveday', clock = '7:42 AM') =>
    `[In-story time: ${clock}, ${weekday ? `${weekday}, ` : ''}${date}]`;
let ctx;
beforeEach(() => {
    _resetDiagnostics(); bumpEpoch();
    ctx = { chat: [], chatMetadata: { mwt_calendar: custom() }, saveMetadataDebounced: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('Phase 11 custom calendar parsing and ladder', () => {
    test('canonical tag maps to story hours, computed weekday and formatted date', () => {
        const calendar = custom();
        const parsed = parseAmbientTimestamp(tag(), { calendar });
        expect(parsed).toMatchObject({ year: 1247, month: 7, day: 3, hour: 7, minute: 42,
            grammar: 'custom', formattedDate: 'Starday, Rotmonth 3, 1247',
            weekday: { tagged: 'Fiveday', computed: 'Starday', mismatch: true } });
        expect(parsed.hours).toBe(calendarDateToHours(calendar, { year: 1247, month: 7, day: 3, hour: 7, minute: 42 }));
    });

    test('space-bearing, international and apostrophe names, era suffix and optional weekday', () => {
        const input = custom();
        input.months[6].name = 'Lune’s Rest'; input.weekdays[0] = '月の日';
        const calendar = validateCalendarRecord(input).record;
        const options = { calendar };
        expect(parseAmbientTimestamp(tag('Lune’s Rest 3, 1247 Kelen Epoch', '月の日'), options))
            .toMatchObject({ month: 7, weekday: { mismatch: false } });
        expect(parseAmbientTimestamp(tag("lune's rest 3, 1247", ''), options)).not.toBeNull();
        calendar.weekdays = null; delete calendar.anchor.weekday;
        expect(parseAmbientTimestamp(tag("Lune's Rest 3, 1247", ''), options).weekday).toBeUndefined();
        expect(parseAmbientDateTime("Lune's Rest 3, 1247 Kelen Epoch", '23:15', options)).toMatchObject({ hour: 23, minute: 15 });
    });

    test.each(['June 3, 1247', '2026-06-03', 'Nevermonth 3, 1247', 'Rotmonth 37, 1247',
        'Rotmonth 0, 1247', 'Rotmonth 3, 0000', 'Rotmonth 3, 1247 Wrong Era'])('rejects %s without Gregorian guessing', date => {
        const calendar = custom();
        expect(parseAmbientTimestamp(tag(date), { calendar })).toBeNull();
        expect(resolveAmbientTime({ messages: [tag(date)], calendar })).toMatchObject({
            source: 'message-count', hours: 1, month: null, rejection: { messageIndex: 0, reason: expect.any(String) } });
    });

    test('transition chat skips old Gregorian tags and tries only custom World State dates', () => {
        const calendar = custom();
        const messages = [tag('June 3, 1247', 'Monday')];
        expect(resolveAmbientTime({ messages, calendar, worldState: { date: 'Rotmonth 4, 1247', time: '14:30' } }))
            .toMatchObject({ source: 'world-state', day: 4, rejection: { messageIndex: 0 } });
        expect(resolveAmbientTime({ messages, calendar, worldState: { date: 'June 4, 1247', time: '14:30' } }).source).toBe('message-count');
        expect(resolveAmbientTime({ messages: [...messages, tag()], calendar })).not.toHaveProperty('rejection');
    });

    test('newest rejection survives fallback within a message or across messages; newest valid tag clears it', () => {
        const calendar = custom();
        for (const messages of [[tag(), tag('June 3, 1247')], [`${tag()} ${tag('June 3, 1247')}`]]) {
            expect(resolveAmbientTime({ messages, calendar })).toMatchObject({ source: 'timestamp', month: 7, rejection: { reason: expect.stringContaining('Gregorian') } });
        }
        expect(resolveAmbientTime({ messages: [`${tag('June 3, 1247')} ${tag()}`], calendar })).not.toHaveProperty('rejection');
    });

    test.each(['swipe', 'regenerate'])('%s excludes replaced tags and rejection notes; rewind is deterministic', type => {
        const calendar = custom(); const messages = [{ mes: tag() }, { mes: tag('June 3, 1247') }];
        const original = JSON.stringify(messages);
        expect(resolveAmbientTime({ messages, calendar, type })).toEqual(resolveAmbientTime({ messages: messages.slice(0, 1), calendar }));
        expect(JSON.stringify(messages)).toBe(original);
    });

    test('Gregorian records preserve the legacy parser and resolver exactly', () => {
        const calendar = { version: 1, structure: 'gregorian', eventsLine: true, events: [], phenomena: [] };
        const messages = [tag('June 4, 2026', 'Thursday')];
        expect(resolveAmbientTime({ messages, calendar })).toEqual(resolveAmbientTime({ messages }));
    });
});

describe('custom drift and diagnostics', () => {
    test('unknown weekday still resolves and badges; matching and weekday-less tags stay silent', () => {
        ctx.chat = [{ mes: tag('Rotmonth 3, 1247', 'Mysteryday') }];
        const status = observeWeekdayDrift();
        expect(status).toMatchObject({ grammar: 'custom', tagged: 'Mysteryday', computed: 'Starday' });
        document.body.innerHTML = renderOverviewSnapshot({ weekdayDrift: { ok: true, value: status } });
        expect(document.body.textContent).toContain('Custom calendar weekday mismatch');
        expect(document.body.textContent).not.toContain('Gregorian');
        observeWeekdayDrift(); getWeekdayDriftStatus();
        expect(getEvents({ module: 'calendar' })).toHaveLength(1);
        expect(getEvents({ module: 'calendar' })[0].event).toBe('custom_weekday_drift');
        ctx.chat[0].mes = tag('Rotmonth 3, 1247', 'sTaRdAy');
        expect(observeWeekdayDrift()).toBeNull();
        ctx.chatMetadata.mwt_calendar.weekdays = null;
        delete ctx.chatMetadata.mwt_calendar.anchor.weekday;
        ctx.chat[0].mes = tag('Rotmonth 3, 1247', '');
        expect(observeWeekdayDrift()).toBeNull();
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });

    test('rejected tags report a deduplicated event independently of drift, without writes', () => {
        ctx.chat = [{ mes: tag('June 3, 1247') }];
        const before = JSON.stringify(ctx.chatMetadata);
        observeWeekdayDrift(); observeWeekdayDrift();
        expect(getEvents({ module: 'calendar' })).toMatchObject([{ event: 'calendar_tag_rejected', detail: { messageIndex: 0 } }]);
        ctx.chat[0].mes = tag('Rotmonth 37, 1247'); observeWeekdayDrift();
        expect(getEvents({ module: 'calendar' })).toHaveLength(2);
        bumpEpoch(); observeWeekdayDrift();
        expect(getEvents({ module: 'calendar' })).toHaveLength(3);
        expect(JSON.stringify(ctx.chatMetadata)).toBe(before);
    });
});

describe('full ambient stack and byte-identical body gate', () => {
    const settings = { enabled: true, climate: 'temperate', hemisphere: 'north', latitude: 60,
        variability: 0.5, coastal: true, seed: 42 };
    test.each(['north', 'south'])('same resolved hours yield identical ambient output in %s', hemisphere => {
        ctx.chat = [{ mes: tag('Highsun 18, 1247', 'Threeday', '9:00 PM') }];
        const fantasy = readAmbientConditions({ ...settings, hemisphere }, 42);
        const date = new Date(fantasy.time.hours * 3600000);
        ctx.chat = [{ mes: tag(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`, 'Wednesday', '9:00 PM') }];
        delete ctx.chatMetadata.mwt_calendar;
        const legacy = readAmbientConditions({ ...settings, hemisphere }, 42);
        expect(fantasy.time.hours).toBe(legacy.time.hours);
        expect(fantasy.ambient).toEqual(legacy.ambient);
        expect(buildInjectionBody(fantasy.ambient)).toBe(buildInjectionBody(legacy.ambient));
    });

    test('60°N Highsun is bright at 21:00; Deepnight follows actual sunset, moon and tides online', () => {
        ctx.chat = [{ mes: tag('Highsun 18, 1247', '', '9:00 PM') }];
        const summer = readAmbientConditions(settings, 42);
        expect(summer.ambient.daylight.regime).toBe('daylight');
        expect(summer.ambient.season).toBe('summer');
        expect(summer.ambient.moon).toBeTruthy(); expect(summer.ambient.tide).toBeTruthy();
        // The design's 15:00 darkness example is inconsistent with the shipped
        // sun: even late Deepnight still has daylight then at 60°N.
        ctx.chat[0].mes = tag('Deepnight 36, 1247', '', '3:00 PM');
        expect(readAmbientConditions(settings, 42).ambient.daylight.regime).toBe('daylight');
        ctx.chat[0].mes = tag('Deepnight 36, 1247', '', '4:30 PM');
        expect(readAmbientConditions(settings, 42).ambient.daylight.regime).toBe('darkness');
    });
});