/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { calendarDayIndex, calendarDateFromDayIndex, calendarDateToHours, validateCalendarRecord } from '../core/calendar_math.js';
import { calendarEventOccurrences, projectCalendarEvents } from '../core/calendar_events.js';
import { buildCalendarPlannerContext, getCalendarStatus } from '../core/calendar_state.js';
import { lunarPhaseAt, moonAnchorOffset } from '../core/ambient_astronomy.js';
import { parseStoryDateTime } from '../core/calendar_state.js';
import { renderCalendarMonth } from '../calendar/events.js';
import { renderCalendarPanel } from '../calendar/render.js';
import { wireCalendarPanel } from '../calendar/panel.js';
import { saveCalendar, exportCalendar, importCalendar } from '../calendar/settings.js';
import { calendarCommand, generationInterceptor, prepareGeneration } from '../calendar/index.js';
import { renderOverviewSnapshot } from '../dashboard/render.js';
import { bumpEpoch } from '../core/scope.js';
import { getInjectedSnapshot, _resetDiagnostics } from '../core/diagnostics.js';
import { _resetBudgetEnforcementState } from '../core/budget.js';

const custom = () => ({ version: 1, structure: 'custom', months: [{ name: 'Highsun', days: 36 }, { name: 'Deepnight', days: 36 }],
    weekdays: ['Starday', 'Moonday'], era: null, anchor: { year: 1247, month: 1, day: 18, weekday: 0 },
    dateLine: true, eventsLine: true, events: [], phenomena: [] });
const gregorian = () => ({ version: 1, structure: 'gregorian', eventsLine: true, events: [], phenomena: [] });
const date = (year = 1247, month = 1, day = 1) => ({ year, month, day });
const event = (id, day, patch = {}) => ({ id, name: `Festival ${id}`, date: date(1247, 1, day), repeat: 'none', durationDays: 1, ...patch });
let ctx;
const el = id => document.querySelector(`#mwt-c-${id}`);
const mount = () => { document.body.innerHTML = renderCalendarPanel(); wireCalendarPanel(document.body); };
beforeEach(() => {
    bumpEpoch(); _resetDiagnostics(); _resetBudgetEnforcementState();
    ctx = { chatId: 'events', chat: [{ mes: '[In-story time: 12:00 PM, Highsun 1, 1247]' }],
        chatMetadata: { mwt_calendar: custom() }, extensionSettings: { merged_world_tracker: {} },
        saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('Phase 13 pure events', () => {
    test.each([2, 3, 5])('continuous yearly coverage has no false countdown (duration %s)', durationDays => {
        const calendar = custom(); calendar.months = [{ name: 'Highsun', days: 2 }]; calendar.anchor.day = 1;
        calendar.events = [event('feast', 1, { repeat: 'yearly', durationDays })];
        expect(validateCalendarRecord(calendar).valid).toBe(true);
        for (const day of [1, 2]) {
            const projection = projectCalendarEvents(calendar, date(1248, 1, day));
            expect(projection.line).toBe('Festival feast is ongoing.');
            expect(projection.events).toHaveLength(1);
        }
    });
    test('every-N-year coverage merges, but separated repetitions retain exact countdowns', () => {
        const calendar = custom(); calendar.months = [{ name: 'Highsun', days: 2 }]; calendar.anchor.day = 1;
        calendar.events = [event('feast', 1, { repeat: { everyYears: 2 }, durationDays: 5 })];
        expect(projectCalendarEvents(calendar, date(1249)).line).toBe('Festival feast is ongoing.');
        calendar.events[0].durationDays = 1;
        expect(projectCalendarEvents(calendar, date(1249)).line).toContain('today is its final day');
    });
    test('D32 exact inclusive bounds, second only within seven, max two and deterministic ties', () => {
        const calendar = custom();
        calendar.events = [event('a', 15), event('b', 16)];
        expect(projectCalendarEvents(calendar, date()).events.map(item => item.event.id)).toEqual(['a']);
        calendar.events = [event('b', 8), event('a', 8), event('c', 8)];
        expect(projectCalendarEvents(calendar, date()).events.map(item => item.event.id)).toEqual(['a', 'b']);
        calendar.events = [event('a', 7), event('b', 9)];
        expect(projectCalendarEvents(calendar, date()).events).toHaveLength(1);
        calendar.events = [event('a', 16)];
        expect(projectCalendarEvents(calendar, date()).line).toBe('');
    });
    test('yearly across year boundary, every N years, no occurrence before authored year', () => {
        const calendar = custom(); calendar.events = [event('a', 2, { repeat: 'yearly' })];
        expect(projectCalendarEvents(calendar, date(1247, 2, 35)).line).toContain('in three days');
        calendar.events[0].repeat = { everyYears: 3 };
        expect(projectCalendarEvents(calendar, date(1248, 1, 1)).line).toBe('');
        expect(projectCalendarEvents(calendar, date(1250, 1, 1)).line).toContain('tomorrow');
        expect(projectCalendarEvents(calendar, date(1246, 1, 1)).line).toBe('');
    });
    test('durations include today, end is exclusive, rewind restores text, no mutation', () => {
        const calendar = custom(); calendar.events = [event('a', 4, { durationDays: 3 })];
        const before = JSON.stringify(calendar);
        const original = projectCalendarEvents(calendar, date()).line;
        expect(original).toContain('in three days');
        expect(projectCalendarEvents(calendar, date(1247, 1, 4)).line).toContain('three days remain');
        expect(projectCalendarEvents(calendar, date(1247, 1, 6)).line).toContain('final day');
        expect(projectCalendarEvents(calendar, date(1247, 1, 7)).line).toBe('');
        expect(projectCalendarEvents(calendar, date()).line).toBe(original);
        expect(JSON.stringify(calendar)).toBe(before);
    });
    test('ongoing occurrences share two-mention cap including year-spanning durations', () => {
        const calendar = custom(); calendar.events = [event('a', 36, { date: date(1247, 2, 36), durationDays: 3, repeat: 'yearly' }), event('b', 3, { repeat: 'yearly' }), event('c', 4, { repeat: 'yearly' })];
        const result = projectCalendarEvents(calendar, date(1248));
        expect(result.events).toHaveLength(2); expect(result.line).toContain('two days remain');
    });
    test.each(['new', 'full'])('lunar %s uses exact phase calendar day and follows custom-date anchor', phase => {
        const calendar = custom();
        calendar.events = [{ id: 'moon', name: 'Moon Feast', repeat: { lunar: phase }, durationDays: 2 }];
        const anchor = parseStoryDateTime('Highsun 8, 1247', '21:00').hours;
        const options = { moonEpochOffset: moonAnchorOffset(anchor) };
        const occurrences = calendarEventOccurrences(calendar, 0, 71, options);
        expect(occurrences.length).toBeGreaterThan(1);
        const phaseHour = phase === 'full' ? anchor : anchor + 29.530589 * 12;
        const expected = Math.floor((phaseHour - calendarDateToHours(calendar, date())) / 24);
        expect(occurrences.some(item => item.start === expected)).toBe(true);
        expect(lunarPhaseAt(phaseHour, options.moonEpochOffset).phase).toBeCloseTo(phase === 'full' ? 0.5 : 0, 8);
        const moved = calendarEventOccurrences(calendar, 0, 71, { moonEpochOffset: options.moonEpochOffset + 72 });
        expect(moved.map(item => item.start)).not.toEqual(occurrences.map(item => item.start));
        const midnight = calendarDateToHours(calendar, date(1247, 1, 8));
        if (phase === 'full') {
            for (const [delta, day] of [[-1 / 60, 6], [1 / 60, 7]]) {
                const exact = calendarEventOccurrences(calendar, 5, 9, { moonEpochOffset: moonAnchorOffset(midnight + delta) });
                expect(exact[0].start).toBe(day);
            }
        }
    });
    test('Gregorian leap dates validate and yearly recurrence skips non-leap years', () => {
        const calendar = gregorian(); calendar.events = [event('leap', 1, { date: date(2024, 2, 29), repeat: 'yearly' })];
        expect(validateCalendarRecord(calendar).valid).toBe(true);
        expect(projectCalendarEvents(calendar, date(2025, 2, 28)).line).toBe('');
        expect(projectCalendarEvents(calendar, date(2028, 2, 28)).line).toContain('tomorrow');
        calendar.events[0].date.year = 2025;
        expect(validateCalendarRecord(calendar).valid).toBe(false);
    });
    test.each([
        { id: '' }, { name: '<script>' }, { durationDays: 0 }, { durationDays: 15 }, { repeat: { everyYears: 1 } },
        { repeat: { everyYears: 100 } }, { repeat: { lunar: 'quarter' } }, { repeat: { lunar: 'full' } }, { date: date(1247, 1, 37) },
    ])('invalid event fails closed (%j)', patch => {
        const calendar = custom(); calendar.events = [event('a', 1, patch)];
        expect(validateCalendarRecord(calendar).valid).toBe(false);
    });
    test('unique IDs, normalized names, default duration and no stored lunar date', () => {
        const calendar = custom(); calendar.events = [event('a', 1), event('a', 2)];
        expect(validateCalendarRecord(calendar).valid).toBe(false);
        calendar.events = [{ id: 'moon', name: ' Moon’s Feast ', repeat: { lunar: 'full' } }];
        expect(validateCalendarRecord(calendar).record.events[0]).toEqual({ id: 'moon', name: "Moon's Feast", repeat: { lunar: 'full' }, durationDays: 1 });
    });
});

describe('Phase 13 surfaces', () => {
    test('command, injection, planner, Overview parity; no writes, rewinds and swipe stability', async () => {
        ctx.chatMetadata.mwt_calendar.events = [event('a', 4)];
        const initial = getCalendarStatus(); const line = initial.eventsLine;
        expect(calendarCommand()).toContain(line);
        expect(buildCalendarPlannerContext()).toContain(line);
        expect(renderOverviewSnapshot({ calendar: { ok: true, value: initial } })).toContain(line);
        const { buildUserPrompt } = await import('../story_planner/generation.js');
        expect(buildUserPrompt('')).toContain(line);
        const { buildTargetedUserPrompt } = await import('../story_planner/targeted.js');
        expect(buildTargetedUserPrompt('develop', { title: 'Journey', body: '', section: 'Main', beats: [] })).toContain(line);
        prepareGeneration('normal'); generationInterceptor([], 0, () => {}, 'normal');
        expect(getInjectedSnapshot('mwt_calendar_injection').payload).toContain(initial.body);
        ctx.chat.push({ is_user: false, mes: '[In-story time: 12:00 PM, Highsun 2, 1247]' });
        prepareGeneration('swipe'); generationInterceptor([], 0, () => {}, 'swipe');
        expect(getInjectedSnapshot('mwt_calendar_injection').payload).toContain(initial.body);
        ctx.chat.pop(); expect(getCalendarStatus().eventsLine).toBe(line);
        const branch = JSON.parse(JSON.stringify(ctx.chatMetadata));
        ctx.chatMetadata = branch; expect(getCalendarStatus().eventsLine).toBe(line);
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
        ctx.extensionSettings.merged_world_tracker.injectionMasterOff = true;
        expect(buildCalendarPlannerContext()).toBe('');
    });
    test('Gregorian events, independent toggles and rejection/clockless gates', () => {
        const calendar = gregorian(); calendar.events = [event('a', 4, { date: date(2026, 6, 4) })];
        saveCalendar(calendar); ctx.chat = [{ mes: '[In-story time: 12:00 PM, Monday, June 1, 2026]' }];
        expect(calendarCommand()).toContain('in three days');
        expect(calendarCommand()).not.toContain('In-world date');
        ctx.chatMetadata.mwt_calendar.eventsLine = false; expect(getCalendarStatus().body).toBe('');
        saveCalendar(custom()); ctx.chatMetadata.mwt_calendar.events = [event('a', 4)];
        ctx.chat = [{ mes: '[In-story time: 12:00 PM, Highsun 1, 1247]' }];
        ctx.chatMetadata.mwt_calendar.dateLine = false; expect(getCalendarStatus().body).toContain('in three days');
        ctx.chat.push({ mes: '[In-story time: 12:00 PM, Highsun 37, 1247]' });
        expect(buildCalendarPlannerContext()).toBe(''); expect(getCalendarStatus().body).toBe('');
        ctx.chat = []; expect(getCalendarStatus().eventsLine).toBe('');
    });
    test.each(['custom', 'gregorian'])('panel CRUD draft/save, navigation, export/import, stale guard (%s)', structure => {
        if (structure === 'gregorian') { saveCalendar(gregorian()); ctx.chat = [{ mes: '[In-story time: 12:00 PM, Monday, June 1, 2026]' }]; }
        mount(); el('event-id').value = 'festival'; el('event-name').value = 'Lantern Festival';
        el('event-year').value = structure === 'custom' ? 1247 : 2026;
        el('event-month').value = structure === 'custom' ? 1 : 6; el('event-day').value = 4;
        el('event-duration').value = 2; el('event-apply').click();
        expect(ctx.chatMetadata.mwt_calendar.events).toEqual([]);
        expect(el('events').textContent).toContain('Lantern Festival');
        expect(el('grid').textContent.match(/Lantern Festival/g)).toHaveLength(2);
        el('grid-next').click(); expect(el('grid').textContent).not.toContain('Lantern Festival'); el('grid-prev').click();
        el('confirm').checked = true; el('save').click(); expect(ctx.chatMetadata.mwt_calendar.events).toHaveLength(1);
        el('events').querySelector('button').click(); el('event-name').value = 'Moon Festival'; el('event-apply').click(); el('save').click();
        expect(ctx.chatMetadata.mwt_calendar.events[0].name).toBe('Moon Festival');
        const json = exportCalendar(); importCalendar(json); expect(exportCalendar()).toBe(json);
        el('events').querySelectorAll('button')[1].click(); el('save').click(); expect(ctx.chatMetadata.mwt_calendar.events).toEqual([]);
        bumpEpoch(); el('event-apply').click(); expect(el('status').textContent).toContain('Chat changed');
    });
    test('panel validates dates/names, lunar controls and month-reference identity after edits', () => {
        mount(); el('event-id').value = 'moon'; el('event-name').value = '<img>'; el('event-year').value = 1247;
        el('event-apply').click(); expect(el('status').textContent).toContain('safe name'); expect(document.querySelector('img')).toBeNull();
        el('event-name').value = 'Moon Feast'; el('event-repeat').value = 'full'; el('event-repeat').dispatchEvent(new Event('change'));
        expect(el('event-year').disabled).toBe(true); el('event-apply').click();
        el('confirm').checked = true; el('save').click(); expect(ctx.chatMetadata.mwt_calendar.events[0]).not.toHaveProperty('date');
        ctx.chatMetadata.mwt_calendar.events = [event('a', 4)]; mount();
        el('months').querySelector('button:nth-of-type(2)').click();
        el('events').querySelector('button').click(); expect(el('event-month').value).toBe('2');
        el('event-apply').click(); el('confirm').checked = true; el('save').click();
        expect(ctx.chatMetadata.mwt_calendar.events[0].date.month).toBe(2);
    });
    test('open event editor follows month identity through reorder', () => {
        ctx.chatMetadata.mwt_calendar.events = [event('a', 4)]; mount();
        el('events').querySelector('button').click();
        el('months').querySelector('button:nth-of-type(2)').click();
        el('event-name').value = 'Renamed feast'; el('event-apply').click();
        el('confirm').checked = true; el('save').click();
        expect(el('status').textContent).toContain('Calendar saved');
        expect(ctx.chatMetadata.mwt_calendar.events[0]).toMatchObject({ name: 'Renamed feast', date: { month: 2, day: 4 } });
    });
    test('unsaved event date follows reorder and becomes invalid if its month is removed', () => {
        mount(); el('event-id').value = 'new'; el('event-name').value = 'New feast';
        el('event-day').value = '4';
        el('months').querySelector('button:nth-of-type(2)').click();
        expect(el('event-month').value).toBe('2');
        el('months').querySelectorAll('button')[5].click();
        expect(el('event-month').value).toBe('');
        el('event-apply').click();
        expect(el('status').textContent).toContain('Use an existing calendar date');
        expect(ctx.chatMetadata.mwt_calendar.events).toEqual([]);
    });
    test('month grid displays all events beyond horizon, duration spillover and escapes strings', () => {
        const calendar = custom(); calendar.events = [event('a', 35, { durationDays: 4, repeat: 'yearly' }), event('b', 30)];
        let html = renderCalendarMonth(calendar, date()); expect(html).toContain('Festival b');
        html = renderCalendarMonth(calendar, date(1247, 2)); expect(html.match(/Festival a/g)).toHaveLength(2);
        calendar.events[0].name = '<img src=x>'; expect(renderCalendarMonth(calendar, date())).toContain('&lt;img');
        expect(calendarDateFromDayIndex(calendar, calendarDayIndex(calendar, date()))).toEqual(date());
    });
    test('event draft rebasing retains saved month identity for Ambient re-stamping', () => {
        const calendar = ctx.chatMetadata.mwt_calendar;
        const startHours = calendarDateToHours(calendar, date(1247, 1, 4));
        ctx.chatMetadata.mwt_ambient = { hemisphere: 'north', phenomena: [{ id: 'mist', startHours, endHours: null, source: 'timestamp' }] };
        calendar.events = [event('a', 4)]; mount();
        el('months').querySelector('button:nth-of-type(2)').click();
        el('events').querySelector('button').click(); el('event-apply').click();
        el('confirm').checked = true; el('restamp').checked = true; el('save').click();
        expect(el('status').textContent).toContain('Calendar saved');
        const saved = ctx.chatMetadata.mwt_calendar;
        expect(ctx.chatMetadata.mwt_ambient.phenomena[0].startHours).toBe(calendarDateToHours(saved, date(1247, 2, 4)));
        expect(saved.events[0].date.month).toBe(2);
    });
});