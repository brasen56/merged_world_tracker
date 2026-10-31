/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildCalendarBody, getCalendarStatus, resolveCalendarClock } from '../core/calendar_state.js';
import { editCalendarMonths, restampAmbientTimes } from '../core/calendar_edit.js';
import { calendarDateToHours } from '../core/calendar_math.js';
import { lunarPhaseAt } from '../core/ambient_astronomy.js';
import { getCalendar, saveCalendar, exportCalendar, importCalendar, buildPresetSnippet } from '../calendar/settings.js';
import { renderCalendarPanel } from '../calendar/render.js';
import { wireCalendarPanel } from '../calendar/panel.js';
import { calendarCommand, generationInterceptor, onGenerationStarted, prepareGeneration, onChatChanged } from '../calendar/index.js';
import { getInjectedSnapshot, _resetDiagnostics } from '../core/diagnostics.js';
import { _resetBudgetEnforcementState } from '../core/budget.js';
import { bumpEpoch } from '../core/scope.js';
import { renderOverviewSnapshot } from '../dashboard/render.js';
import { renderAmbientSettings, wireAmbientSettings } from '../ambient/render.js';
import { saveSettings as saveAmbient } from '../ambient/settings.js';
import { createCommands } from '../core/commands.js';
import { readAmbientConditions } from '../core/ambient_state.js';
import { buildInjectionBody as ambientBody } from '../ambient/injection.js';

const custom = () => ({ version: 1, structure: 'custom', months: [{ name: 'Highsun', days: 36 }, { name: 'Deepnight', days: 36 }],
    weekdays: ['Starday', 'Moonday'], era: 'Old Era', anchor: { year: 1247, month: 1, day: 18, weekday: 0 },
    dateLine: true, eventsLine: true, events: [], phenomena: [] });
const tag = (day = 31, month = 'Highsun', year = 1247) => ({ mes: `[In-story time: 12:00 PM, ${month} ${day}, ${year}]` });
let ctx;
const el = id => document.querySelector(`#mwt-c-${id}`);
function mount() { document.body.innerHTML = renderCalendarPanel(); wireCalendarPanel(document.body); wireCalendarPanel(document.body); }
beforeEach(() => {
    _resetDiagnostics(); _resetBudgetEnforcementState(); bumpEpoch();
    ctx = { chatId: 'calendar-test', chat: [tag()], chatMetadata: { mwt_calendar: custom() },
        extensionSettings: { merged_world_tracker: {} }, saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('Phase 12 date facts and lifecycle', () => {
    test('date, tomorrow, era omission and exact month boundary gate', () => {
        expect(calendarCommand()).toContain('5 days remain in Highsun; the next month is Deepnight');
        expect(calendarCommand()).toContain('tomorrow is Starday, Highsun 32, 1247');
        expect(calendarCommand()).not.toContain('Old Era');
        ctx.chat = [tag(28)]; expect(calendarCommand()).not.toContain('remain');
        ctx.chat = [tag(29)]; expect(calendarCommand()).toContain('7 days remain');
        ctx.chat = [tag(36, 'Deepnight')]; expect(calendarCommand()).toContain('next month is Highsun, 1248');
        const short = custom(); short.months[0].days = 6; short.anchor.day = 1;
        expect(buildCalendarBody(short, { year: 1247, month: 1, day: 1 })).toContain('5 days remain');
    });
    test('fails closed with surfaced newest-tag reason even when an older tag works', () => {
        ctx.chat.push(tag(37));
        const status = getCalendarStatus();
        expect(status.time.source).toBe('timestamp'); expect(status.body).toBe('');
        expect(status.reason).toContain('Newest timestamp rejected');
        document.body.innerHTML = renderOverviewSnapshot({ calendar: { ok: true, value: status } });
        expect(document.body.textContent).toContain(status.reason);
        ctx.chat = [tag(3, 'June')]; expect(getCalendarStatus().body).toBe('');
    });
    test('all gates, command parity, dry-run, excluded types, panic and cleanup', () => {
        onGenerationStarted();
        expect(getInjectedSnapshot('mwt_calendar_injection').payload).toBe(`<mwt_calendar>\n${calendarCommand()}\n</mwt_calendar>`);
        prepareGeneration('normal', {}, true); expect(getInjectedSnapshot('mwt_calendar_injection').enabled).toBe(true);
        prepareGeneration(); expect(getInjectedSnapshot('mwt_calendar_injection').enabled).toBe(false);
        onGenerationStarted('quiet'); expect(getInjectedSnapshot('mwt_calendar_injection').enabled).toBe(false);
        onGenerationStarted(); onChatChanged(); expect(getInjectedSnapshot('mwt_calendar_injection').enabled).toBe(false);
        ctx.extensionSettings.merged_world_tracker.injectionMasterOff = true;
        onGenerationStarted(); expect(getInjectedSnapshot('mwt_calendar_injection').enabled).toBe(false);
        ctx.extensionSettings.merged_world_tracker.injectionMasterOff = false;
        ctx.chatMetadata.mwt_calendar.dateLine = false; expect(getCalendarStatus().body).toBe('');
        delete ctx.chatMetadata.mwt_calendar; expect(getCalendarStatus().body).toBe('');
        saveCalendar(custom()); ctx.chat = []; expect(getCalendarStatus().body).toBe('');
        saveCalendar({ version: 1, structure: 'gregorian', eventsLine: true, events: [], phenomena: [] });
        expect(getCalendarStatus().body).toBe('');
    });
    test('replacement semantics and interceptor swipe stability with no writes', () => {
        ctx.chat.push({ ...tag(32), is_user: false });
        const before = JSON.stringify(ctx.chatMetadata);
        generationInterceptor([], 0, null, 'swipe'); const first = getInjectedSnapshot('mwt_calendar_injection').payload;
        generationInterceptor([], 0, null, 'swipe'); expect(getInjectedSnapshot('mwt_calendar_injection').payload).toBe(first);
        expect(first).toContain('Highsun 31');
        onGenerationStarted('regenerate'); expect(getInjectedSnapshot('mwt_calendar_injection').payload).toBe(first);
        ctx.chat.pop(); generationInterceptor([], 0, null, 'regenerate'); expect(getInjectedSnapshot('mwt_calendar_injection').payload).toBe(first);
        expect(JSON.stringify(ctx.chatMetadata)).toBe(before); expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });
    test('slash command registers and panic immediately clears calendar', () => {
        onGenerationStarted(); const register = vi.fn();
        createCommands({ registerSlashCommand: register, modules: { WorldState: {}, Chronicle: {}, Knowledge: {}, StoryPlanner: {}, Interiority: {}, Calendar: { calendarCommand } },
            saveSettings: patch => Object.assign(ctx.extensionSettings.merged_world_tracker, patch) }).setupSlashCommands();
        expect(register.mock.calls.find(([name]) => name === 'wt-calendar')[1]({}, '')).toBe(calendarCommand());
        register.mock.calls.find(([name]) => name === 'wt-inject')[1]({}, 'off');
        expect(getInjectedSnapshot('mwt_calendar_injection').enabled).toBe(false);
    });
    test('ambient body is byte-identical at the same resolved hours', () => {
        const settings = { climate: 'temperate', hemisphere: 'north', latitude: 60, variability: 0.5 };
        const customRead = readAmbientConditions(settings, 42);
        const date = new Date(customRead.time.hours * 3600000);
        const dateText = date.toISOString().slice(0, 10);
        delete ctx.chatMetadata.mwt_calendar;
        ctx.chat = [{ mes: `[In-story time: 12:00 PM, Monday, ${dateText}]` }];
        const standard = readAmbientConditions(settings, 42);
        expect(standard.time.hours).toBe(customRead.time.hours);
        expect(ambientBody(standard.ambient)).toBe(ambientBody(customRead.ambient));
    });
});

describe('Phase 12 authoring and sharing', () => {
    test('save validation and export/import preserve identity and normalized names', () => {
        const record = custom(); record.months[0].name = 'Sun’s Rest'; saveCalendar(record);
        const json = exportCalendar(); saveCalendar(null); importCalendar(json);
        expect(exportCalendar()).toBe(json); expect(getCalendar().months[0].name).toBe("Sun's Rest");
        const before = exportCalendar(); expect(() => importCalendar('{"version":2}')).toThrow();
        expect(exportCalendar()).toBe(before);
        expect(buildPresetSnippet(custom())).toContain('Highsun: 36 days; Deepnight: 36 days');
    });
    test('month identity follows insertion/reorder; all nested references clamp only explicitly', () => {
        const record = custom(); record.events = [{ date: { year: 1247, month: 2, day: 35 } }];
        record.phenomena = [{ start: { year: 1247, month: 2, day: 34 }, end: { year: 1247, month: 1, day: 20, hour: 12 } }];
        const rows = [{ original: 1, name: 'Renamed', days: 30 }, { original: null, name: 'Newmoon', days: 10 }, { original: 0, name: 'Highsun', days: 36 }];
        const pending = editCalendarMonths(record, rows); expect(pending.needsClamping).toBe(true);
        expect(record.events[0].date.month).toBe(2);
        const { record: next } = editCalendarMonths(record, rows, { clamp: true });
        expect(next.anchor.month).toBe(3); expect(next.events[0].date).toMatchObject({ month: 1, day: 30 });
        expect(next.phenomena[0].end.month).toBe(3);
        expect(() => editCalendarMonths(record, rows.slice(1))).toThrow('removed month');
    });
    test('panel roundtrip, live errors, explicit clamping, month reorder and safe text', () => {
        mount(); expect(el('year').value).toBe('1247'); expect(el('preview').textContent).toContain('derived season');
        el('confirm').checked = true; el('save').click(); expect(el('status').textContent).toContain('saved');
        const inputs = el('months').querySelectorAll('input'); inputs[0].value = '<img src=x onerror=alert(1)>';
        inputs[0].dispatchEvent(new Event('input')); el('save').click();
        expect(el('status').textContent).toContain('Month names'); expect(document.querySelector('img')).toBeNull();
        mount(); el('confirm').checked = true;
        el('months').querySelector('button:nth-of-type(2)').click();
        el('save').click(); expect(getCalendar().anchor.month).toBe(2);
        mount(); el('confirm').checked = true;
        const length = el('months').querySelectorAll('input')[3]; length.value = 10; length.dispatchEvent(new Event('input'));
        el('save').click(); expect(el('status').textContent).toContain('Clamping required');
        el('clamp').checked = true; el('save').click(); expect(getCalendar().anchor.day).toBe(10);
        el('export').click(); const json = el('json').value; el('import').click(); expect(exportCalendar()).toBe(json);
        bumpEpoch(); el('save').click(); expect(el('status').textContent).toContain('Chat changed');
    });
    test('new anchor defaults to story year, never wall-clock year', () => {
        delete ctx.chatMetadata.mwt_calendar; ctx.chat = [{ mes: '[In-story time: 12:00 PM, Thursday, June 4, 2026]' }];
        mount(); expect(el('year').value).toBe('2026');
        ctx.chat = []; mount(); expect(el('year').value).toBe('');
    });
    test.each(['shorten', 'remove'])('panel accepts a replacement anchor when its former month is edited: %s', action => {
        mount(); el('confirm').checked = true;
        el('month').value = '1'; el('day').value = '10';
        if (action === 'shorten') {
            const length = el('months').querySelectorAll('input')[1];
            length.value = '10'; length.dispatchEvent(new Event('input'));
        } else {
            el('months').querySelector('button:nth-of-type(3)').click();
        }
        el('save').click();
        expect(el('status').textContent).toContain('Calendar saved');
        const saved = getCalendar();
        expect(saved.months[saved.anchor.month - 1].name).toBe('Deepnight');
        expect(saved.anchor.day).toBe(10);
        expect(saved.months.find(month => month.name === 'Highsun')?.days).toBe(action === 'shorten' ? 10 : undefined);
        expect(el('clamp').checked).toBe(false);
    });
    test.each(['pin', 'frequency'])('month reorder refuses reversed %s bounds without changing metadata', kind => {
        const calendar = custom();
        const startHours = calendarDateToHours(calendar, { year: 1247, month: 1, day: 35 });
        const endHours = calendarDateToHours(calendar, { year: 1247, month: 2, day: 2 });
        saveAmbient({ enabled: true, climate: 'temperate', hemisphere: 'north' });
        if (kind === 'pin') {
            const conditions = readAmbientConditions(ctx.chatMetadata.mwt_ambient, 1).ambient.conditions;
            saveAmbient({ pin: { startHours, endHours, source: 'timestamp', conditions } });
        } else {
            saveAmbient({ phenomena: [{ id: 'mist', shape: 'frequency', name: 'Mist', clause: 'mist gathers',
                chance: 1, durationNights: 1, startHours, endHours, source: 'timestamp' }] });
        }
        mount(); el('confirm').checked = true; el('restamp').checked = true;
        el('months').querySelector('button:nth-of-type(2)').click();
        const before = JSON.stringify(ctx.chatMetadata);
        ctx.saveMetadataDebounced.mockClear(); el('save').click();
        expect(el('status').textContent).toMatch(/interval/i);
        expect(el('status').textContent).toMatch(/Decline re-stamping/);
        expect(JSON.stringify(ctx.chatMetadata)).toBe(before);
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });
    test('dated and synthetic re-stamping is opt-in and atomic', () => {
        const calendar = custom(); const later = custom(); later.anchor.day = 20;
        const hours = calendarDateToHours(calendar, { year: 1247, month: 1, day: 31 });
        const settings = { pin: { startHours: hours, endHours: hours + 5, source: 'timestamp' },
            phenomena: [{ startHours: 2, endHours: 8, source: 'message-count' }] };
        const mapped = restampAmbientTimes(settings, calendar, later, resolveCalendarClock(later));
        expect(mapped.pin.startHours).toBe(hours - 48); expect(mapped.pin.endHours).toBe(hours - 43);
        expect(mapped.phenomena[0].endHours - mapped.phenomena[0].startHours).toBe(6);
        ctx.chatMetadata.mwt_ambient = settings; saveCalendar(later);
        expect(ctx.chatMetadata.mwt_ambient.pin.startHours).toBe(hours);
        saveCalendar(calendar, { restamp: true }); expect(ctx.chatMetadata.mwt_ambient.pin.startHours).toBe(hours + 48);
        ctx.chat = []; const before = JSON.stringify(ctx.chatMetadata);
        expect(() => saveCalendar(later, { restamp: true })).toThrow('readable date'); expect(JSON.stringify(ctx.chatMetadata)).toBe(before);
    });
    test('Ambient custom moon and pin dates use the same calendar grammar', () => {
        saveAmbient({ enabled: true, climate: 'temperate', hemisphere: 'north', manualSeason: 'summer', variability: 0.5 });
        document.body.innerHTML = renderAmbientSettings(); wireAmbientSettings(document.body);
        const a = id => document.querySelector(`#mwt-a-${id}`);
        expect(a('moon-date').type).toBe('text');
        a('moon-date').value = 'Highsun 31, 1247'; a('moon-time').value = '12:00'; a('save').click();
        expect(ctx.chatMetadata.mwt_ambient.moonEpochOffset).not.toBeNull();
        document.body.innerHTML = renderAmbientSettings(); wireAmbientSettings(document.body);
        expect(a('moon-date').value).toMatch(/Highsun|Deepnight/);
        a('expiry').value = 'date'; a('date').value = 'Highsun 32, 1247'; a('time').value = '12:00'; a('pin').click();
        expect(ctx.chatMetadata.mwt_ambient.pin.endHours - ctx.chatMetadata.mwt_ambient.pin.startHours).toBe(24);
    });
    test('hemisphere flip offers date-preserving re-stamping, declining freezes hours', () => {
        saveAmbient({ enabled: true, climate: 'temperate', hemisphere: 'north', manualSeason: 'summer', variability: 0.5 });
        const startHours = resolveCalendarClock().hours;
        ctx.chatMetadata.mwt_ambient.phenomena = [{ id: 'mist', shape: 'frequency', name: 'Mist', clause: 'mist gathers',
            chance: 1, durationNights: 1, startHours, endHours: null, source: 'timestamp' }];
        saveAmbient({ hemisphere: 'south' });
        expect(ctx.chatMetadata.mwt_ambient.phenomena[0].startHours).toBe(startHours);
        saveAmbient({ hemisphere: 'north' }, { restamp: true });
        expect(ctx.chatMetadata.mwt_ambient.phenomena[0].startHours).toBe(startHours - 183 * 24);
    });
    test.each([false, true])('combined hemisphere and moon-anchor save uses the selected mapping (restamp: %s)', restamp => {
        saveAmbient({ enabled: true, climate: 'temperate', hemisphere: 'north' });
        document.body.innerHTML = renderAmbientSettings(); wireAmbientSettings(document.body);
        const a = id => document.querySelector(`#mwt-a-${id}`);
        a('moon-date').value = 'Highsun 31, 1247'; a('moon-time').value = '12:00'; a('save').click();
        a('hemisphere').value = 'south'; a('restamp').checked = restamp; a('save').click();
        const saved = ctx.chatMetadata.mwt_ambient;
        expect(saved.hemisphere).toBe('south');
        expect(lunarPhaseAt(resolveCalendarClock().hours, saved.moonEpochOffset).name).toBe('full');
        document.body.innerHTML = renderAmbientSettings(); wireAmbientSettings(document.body);
        expect(a('moon-date').value).toBe('Highsun 31, 1247');
        expect(a('moon-time').value).toBe('12:00');
        const offset = saved.moonEpochOffset; a('save').click();
        expect(ctx.chatMetadata.mwt_ambient.moonEpochOffset).toBeCloseTo(offset, 8);
    });
});