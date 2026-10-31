import { getChatMeta, getContextSafe } from '../core/context.js';
import { persistChatMeta } from '../core/metadata.js';
import { requireCalendarRecord, restampAmbientTimes } from '../core/calendar_edit.js';
import { resolveCalendarClock } from '../core/calendar_state.js';
import { record } from '../core/diagnostics.js';
import { clearCalendarInjection } from './injection.js';

export function getCalendar() { return getChatMeta('mwt_calendar') ?? null; }
export function saveCalendar(input, { restamp = false, monthMap } = {}) {
    const meta = getChatMeta();
    if (!getContextSafe() || !meta) throw new Error('No active chat.');
    const next = input === null ? null : requireCalendarRecord(input);
    const ambient = restamp && meta.mwt_ambient
        ? restampAmbientTimes(meta.mwt_ambient, getCalendar(), next, resolveCalendarClock(next),
            { oldHemisphere: meta.mwt_ambient.hemisphere ?? 'north', monthMap }) : null;
    if (next) meta.mwt_calendar = next;
    else delete meta.mwt_calendar;
    if (ambient) meta.mwt_ambient = ambient;
    persistChatMeta();
    clearCalendarInjection({ clearReason: 'calendar-saved' });
    record({ module: 'calendar', event: 'calendar_saved', level: 'info', detail: { structure: next?.structure ?? null, restamped: !!ambient } });
    return next;
}
export function exportCalendar() { return JSON.stringify(getCalendar(), null, 2); }
export function importCalendar(json, options) { return saveCalendar(JSON.parse(json), options); }

export function buildPresetSnippet(calendar) {
    if (calendar?.structure !== 'custom') return 'Use Gregorian In-story time timestamps.';
    return `Use this timestamp form: [In-story time: HH:MM (AM/PM), ${calendar.weekdays ? '<Weekday>, ' : ''}<Month> D, YYYY].\n`
        + `Months in order: ${calendar.months.map(month => `${month.name}: ${month.days} days`).join('; ')}.\n`
        + (calendar.weekdays ? `Weekdays in order: ${calendar.weekdays.join(', ')}.\n` : 'This calendar has no weekdays.\n')
        + 'Days have 24 hours. Advance dates only as story time advances; carry excess days into the next month and increment the year after the last month. Use the authoritative calendar dates when supplied.';
}