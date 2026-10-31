/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { addCalendarMonths, calendarDateToHours, datedRuleActive, validateCalendarRecord } from '../core/calendar_math.js';
import { generateAmbientPhenomena } from '../core/ambient_phenomena.js';
import { readAmbientConditions } from '../core/ambient_state.js';
import { getCalendarStatus } from '../core/calendar_state.js';
import { editCalendarMonths, restampAmbientTimes } from '../core/calendar_edit.js';
import { renderCalendarPanel } from '../calendar/render.js';
import { renderCalendarMonth } from '../calendar/events.js';
import { wireCalendarPanel } from '../calendar/panel.js';
import { exportCalendar, importCalendar } from '../calendar/settings.js';
import { bumpEpoch } from '../core/scope.js';

const date = (year = 1247, month = 1, day = 3, hour = 0, minute = 0) => ({ year, month, day, hour, minute });
const rule = (patch = {}) => ({ id: 'eclipse', shape: 'dated', name: 'Rotmonth eclipse', clause: 'a dim eclipse veils the sun',
    start: date(), durationMonths: 1, repeat: 'yearly', end: null, light: 'twilight', priority: 10,
    visibilityGates: { regime: ['daylight', 'twilight'] }, ...patch });
const custom = () => ({ version: 1, structure: 'custom', months: [{ name: 'Rotmonth', days: 36 }, { name: 'Deepnight', days: 20 }],
    weekdays: null, era: null, anchor: { year: 1247, month: 1, day: 3 }, dateLine: true, eventsLine: true, events: [], phenomena: [rule()] });
const gregorian = () => ({ version: 1, structure: 'gregorian', eventsLine: true, events: [], phenomena: [] });
const clock = (calendar, value, options) => ({ ...value, source: 'timestamp', hours: calendarDateToHours(calendar, value, options) });
const active = (calendar, value, item = calendar.phenomena[0], options) => datedRuleActive(calendar, item, clock(calendar, value, options), options);
const facts = { seed: 42, climate: 'temperate', hemisphere: 'north', daylight: { regime: 'daylight' }, conditions: { sky: 'clear', wind: 'calm' }, season: 'summer' };
const project = (calendar, value, extra = {}) => generateAmbientPhenomena({ ...facts, calendar, time: clock(calendar, value), ...extra });
let ctx;
const el = id => document.querySelector(`#mwt-c-${id}`);
const mount = () => { document.body.innerHTML = renderCalendarPanel(); wireCalendarPanel(document.body); };
beforeEach(() => {
    bumpEpoch();
    ctx = { chatId: 'dated', chat: [{ mes: '[In-story time: 12:00 PM, Rotmonth 3, 1247]' }],
        chatMetadata: { mwt_calendar: custom() }, extensionSettings: { merged_world_tracker: {} }, saveMetadataDebounced: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('Phase 14 pure dated intervals', () => {
    test('midnight inclusive start and exclusive month end; yearly recurrence begins in authored year', () => {
        const calendar = custom();
        expect(active(calendar, date(1247, 1, 2, 23, 59))).toBe(false);
        expect(active(calendar, date())).toBe(true);
        expect(active(calendar, date(1247, 2, 2, 23, 59))).toBe(true);
        expect(active(calendar, date(1247, 2, 3))).toBe(false);
        expect(active(calendar, date(1246))).toBe(false);
        expect(active(calendar, date(1248))).toBe(true);
        expect(active(calendar, date(1248), rule({ repeat: 'none' }))).toBe(false);
    });
    test('calendar month addition clamps short destinations, crosses years, and honors Gregorian leaps', () => {
        const calendar = custom();
        expect(addCalendarMonths(calendar, date(1247, 1, 36), 1)).toEqual({ year: 1247, month: 2, day: 20 });
        expect(addCalendarMonths(calendar, date(1247, 2, 20), 1)).toEqual({ year: 1248, month: 1, day: 20 });
        expect(addCalendarMonths(gregorian(), date(2024, 1, 31), 1)).toEqual({ year: 2024, month: 2, day: 29 });
        expect(addCalendarMonths(gregorian(), date(2023, 1, 31), 1).day).toBe(28);
        const item = rule({ start: date(2024, 2, 29), durationDays: 2, durationMonths: undefined });
        expect(active(gregorian(), date(2024, 3, 1), item)).toBe(true);
        expect(active(gregorian(), date(2024, 3, 2), item)).toBe(false);
        expect(active(gregorian(), date(2025, 3, 1), item)).toBe(false);
        expect(active(gregorian(), date(2028, 2, 29), item)).toBe(true);
    });
    test('overlapping yearly intervals in short calendars and thirteen-month durations', () => {
        const calendar = custom(); calendar.months = [{ name: 'Rotmonth', days: 1 }]; calendar.anchor.day = 1;
        const item = rule({ start: date(1247, 1, 1), durationDays: 400, durationMonths: undefined });
        expect(active(calendar, date(1500, 1, 1), item)).toBe(true);
        expect(active(calendar, date(1248, 1, 1), rule({ start: date(1247, 1, 1), durationMonths: 13, repeat: 'none' }))).toBe(true);
    });
    test('End now is exclusive, preserves rewinds and follows re-anchoring and hemisphere', () => {
        const calendar = custom(); calendar.phenomena[0].end = date(1247, 1, 5, 12, 30);
        expect(active(calendar, date(1247, 1, 5, 12, 29))).toBe(true);
        expect(active(calendar, date(1247, 1, 5, 12, 30))).toBe(false);
        const end = JSON.stringify(calendar.phenomena[0].end);
        calendar.anchor.day = 10;
        for (const hemisphere of ['north', 'south']) {
            expect(active(calendar, date(1247, 1, 5, 12, 30), undefined, { hemisphere })).toBe(false);
            expect(active(calendar, date(1247, 1, 4), undefined, { hemisphere })).toBe(true);
        }
        expect(JSON.stringify(calendar.phenomena[0].end)).toBe(end);
    });
    test('validation rejects unsafe/malformed rules on both structures and duplicate IDs', () => {
        expect(validateCalendarRecord(custom()).valid).toBe(true);
        for (const patch of [{ name: '<img>' }, { clause: 'bad\nclause' }, { durationDays: 1 }, { durationMonths: 14 },
            { durationMonths: 0 }, { start: date(1247, 2, 30) }, { end: date(1246) }, { repeat: 'monthly' },
            { priority: 101 }, { light: 'bright' }, { visibilityGates: { regime: ['bad'] } }, { visibilityGates: [] }, { end: { year: 1247, month: 1, day: 4 } }, { start: date(1247, 1, 3, 12) }]) {
            const calendar = custom(); calendar.phenomena = [rule(patch)]; expect(validateCalendarRecord(calendar).valid, JSON.stringify(patch)).toBe(false);
        }
        const calendar = custom(); calendar.phenomena.push(rule()); expect(validateCalendarRecord(calendar).valid).toBe(false);
        const greg = gregorian(); greg.phenomena = [rule({ start: date(2023, 2, 29) })]; expect(validateCalendarRecord(greg).valid).toBe(false);
        greg.phenomena[0].start.year = 2024; expect(validateCalendarRecord(greg).valid).toBe(true);
        calendar.months = null; expect(validateCalendarRecord(calendar).valid).toBe(false);
    });
    test('clockless/rejected clocks inactive and evaluation never mutates authored state', () => {
        const calendar = custom(); const before = JSON.stringify(calendar);
        expect(datedRuleActive(calendar, rule(), { hours: 12, month: null })).toBe(false);
        expect(datedRuleActive(calendar, rule(), { ...clock(calendar, date()), rejection: {} })).toBe(false);
        const direct = project(calendar, date(1247, 1, 4));
        project(calendar, date(1500)); project(calendar, date(1246));
        expect(project(calendar, date(1247, 1, 4))).toEqual(direct);
        expect(JSON.stringify(calendar)).toBe(before);
    });
});

describe('shared composition and Ambient integration', () => {
    test('visibility uses effective regime, darkest wins across shapes and clauses share cap', () => {
        const calendar = custom();
        expect(project(calendar, date()).description).toContain('eclipse');
        expect(project(calendar, date(), { daylight: { regime: 'darkness' } }).description).toBe('');
        const frequency = { id: 'dark', shape: 'frequency', name: 'Dark', clause: 'dark sky', chance: 1, durationNights: 1,
            startHours: 0, endHours: null, light: 'darkness', priority: 0 };
        const result = project(calendar, date(1247, 1, 3, 23), { phenomena: [frequency] });
        expect(result.light.id).toBe('dark'); expect(result.active).toEqual(['eclipse', 'dark']);
        calendar.phenomena = Array.from({ length: 4 }, (_, i) => rule({ id: `dated${i}`, light: undefined, visibilityGates: {}, priority: 10 - i }));
        const capped = project(calendar, date(1247, 1, 3, 23), { phenomena: [frequency] });
        expect(capped.visible).toHaveLength(5); expect(capped.omitted).toBe(2);
        expect(capped.description.split('; ')).toHaveLength(3);
    });
    test('noon dims, 2 AM stays dark with moonlight intact, daylight inert, tide and phase unchanged', () => {
        const settings = { climate: 'temperate', hemisphere: 'north', variability: 0.5, latitude: 40, moonEpochOffset: 0, coastal: true };
        const read = hour => { ctx.chat[0].mes = `[In-story time: ${hour}, Rotmonth 3, 1247]`; return readAmbientConditions(settings, 42).ambient; };
        const noon = read('12:00 PM'); expect(noon.daylight.regime).toBe('twilight');
        const night = read('2:00 AM'); expect(night.daylight.regime).toBe('darkness'); expect(night.phenomena.description).toBe('');
        ctx.chatMetadata.mwt_calendar.phenomena = [];
        const natural = read('2:00 AM'); expect(night.moon).toEqual(natural.moon); expect(night.tide).toEqual(natural.tide);
        ctx.chatMetadata.mwt_calendar.phenomena = [rule({ light: 'daylight' })];
        expect(read('2:00 AM').daylight.regime).toBe('darkness');
        const day = read('12:00 PM'); expect(day.daylight.regime).toBe('daylight'); expect(day.moon.phase).toEqual(noon.moon.phase);
    });
    test('clockless notice, schedule edits rewrite history, month identity and restamping leave dated ends by date', () => {
        ctx.chat = []; expect(getCalendarStatus().reason).toContain('Dated phenomena inactive');
        const calendar = custom(); calendar.phenomena[0].end = date(1247, 1, 6, 12);
        expect(active(calendar, date())).toBe(true); calendar.phenomena[0].start.day = 4; expect(active(calendar, date())).toBe(false);
        const edited = editCalendarMonths(calendar, [{ name: 'Deepnight', days: 20, original: 1 }, { name: 'Rotmonth', days: 36, original: 0 }]).record;
        expect(edited.phenomena[0].start.month).toBe(2); expect(edited.phenomena[0].end.month).toBe(2);
        const before = JSON.stringify(edited.phenomena);
        restampAmbientTimes({ phenomena: [] }, calendar, edited, clock(edited, date(1247, 2, 4)));
        expect(JSON.stringify(edited.phenomena)).toBe(before);
    });
});

describe('dated phenomena panel', () => {
    test('draft CRUD, End now persistence/rewind, delete warning, sharing and stale scope', () => {
        mount(); expect(el('grid').textContent).toContain('Rotmonth eclipse');
        expect(document.body.textContent).toContain('Schedule edits rewrite history');
        el('phen-list').querySelectorAll('button')[1].click();
        expect(ctx.chatMetadata.mwt_calendar.phenomena[0].end).toBeNull();
        el('confirm').checked = true; el('save').click();
        expect(ctx.chatMetadata.mwt_calendar.phenomena[0].end).toMatchObject(date(1247, 1, 3, 12));
        expect(active(ctx.chatMetadata.mwt_calendar, date(1247, 1, 3, 11))).toBe(true);
        const json = exportCalendar(); importCalendar(json); expect(exportCalendar()).toBe(json);
        el('phen-list').querySelector('button').click(); el('phen-clause').value = 'an eclipse dims the day'; el('phen-apply').click(); el('save').click();
        expect(ctx.chatMetadata.mwt_calendar.phenomena[0].clause).toBe('an eclipse dims the day');
        el('phen-list').querySelectorAll('button')[2].click(); expect(el('status').textContent).toContain('Confirm deletion');
        el('phen-delete-confirm').checked = true; el('phen-list').querySelectorAll('button')[2].click(); el('save').click();
        expect(ctx.chatMetadata.mwt_calendar.phenomena).toEqual([]);
        bumpEpoch(); el('phen-apply').click(); expect(el('status').textContent).toContain('Chat changed');
    });
    test.each(['custom', 'gregorian'])('authors %s rules, validates inputs, escapes strings and keeps ends through save', structure => {
        if (structure === 'gregorian') { ctx.chatMetadata.mwt_calendar = gregorian(); ctx.chat = [{ mes: '[In-story time: 12:00 PM, June 3, 2024]' }]; }
        else ctx.chatMetadata.mwt_calendar.phenomena = [];
        mount();
        el('phen-id').value = 'new'; el('phen-name').value = '<img>'; el('phen-clause').value = 'dim sky';
        el('phen-year').value = structure === 'custom' ? 1247 : 2024;
        el('phen-apply').click(); expect(el('status').textContent).toContain('Invalid dated phenomena'); expect(document.querySelector('img')).toBeNull();
        el('phen-name').value = 'Dim sky'; el('phen-unit').value = 'durationDays'; el('phen-duration').value = 4;
        el('phen-gates').value = '{"regime":["twilight"]}'; el('phen-light').value = 'twilight'; el('phen-apply').click();
        el('confirm').checked = true; el('save').click(); expect(el('status').textContent).toContain('Calendar saved');
        expect(ctx.chatMetadata.mwt_calendar.phenomena[0]).toMatchObject({ id: 'new', durationDays: 4, light: 'twilight' });
    });
    test('grid shows duration spillover and exclusive End now date; names escaped', () => {
        const calendar = custom(); calendar.phenomena[0].name = '<img src=x>';
        // Invalid authored records are ignored rather than rendered as active.
        expect(renderCalendarMonth(calendar, date())).not.toContain('<img');
        calendar.phenomena[0].name = 'Eclipse'; calendar.phenomena[0].end = date(1247, 2, 2);
        const html = renderCalendarMonth(calendar, date(1247, 2, 1)); expect(html.match(/Eclipse/g)).toHaveLength(1);
    });
});