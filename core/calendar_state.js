/** Shared, read-only Calendar projection. Independent of Ambient enablement. */
import { getChatMeta, getContextSafe } from './context.js';
import { getCurrentWorldState } from './metadata.js';
import { resolveAmbientTime, parseAmbientDateTime } from './ambient_time.js';
import { calendarDayIndex, calendarDateFromDayIndex, calendarHoursToDate,
    calendarMonthLength, formatCalendarDate, validateCalendarRecord } from './calendar_math.js';
import { injectionAllowed } from './settings.js';

export function resolveCalendarClock(calendar = getChatMeta('mwt_calendar'), type = 'normal', hemisphere = getChatMeta('mwt_ambient')?.hemisphere) {
    return resolveAmbientTime({ messages: getContextSafe()?.chat, worldState: getCurrentWorldState(),
        calendar, type, hemisphere });
}

export function buildCalendarBody(calendar, time) {
    if (calendar?.structure !== 'custom' || !calendar.dateLine || time?.month == null || time.rejection) return '';
    const today = time.customDate ?? time;
    const index = calendarDayIndex(calendar, today);
    const tomorrow = calendarDateFromDayIndex(calendar, index + 1);
    const remaining = calendarMonthLength(calendar, today.year, today.month) - today.day;
    const next = calendarDateFromDayIndex(calendar, index + remaining + 1);
    const month = calendar.months[today.month - 1].name;
    const clause = remaining <= 7
        ? ` ${remaining} day${remaining === 1 ? '' : 's'} remain in ${month}; the next month is ${calendar.months[next.month - 1].name}${next.year !== today.year ? `, ${next.year}` : ''}.` : '';
    return `Stage direction, not narration. In-world date (authoritative): ${formatCalendarDate(calendar, today)}; `
        + `tomorrow is ${formatCalendarDate(calendar, tomorrow)}.${clause} `
        + 'Advance the date only as in-story time advances, using the dates stated here.';
}

export function getCalendarStatus(type = 'normal') {
    const raw = getChatMeta('mwt_calendar');
    if (!raw) return { state: 'not configured', body: '' };
    const validated = validateCalendarRecord(raw);
    if (!validated.valid) return { state: 'invalid calendar', reason: validated.errors.join(' '), body: '' };
    const calendar = validated.record;
    const time = resolveCalendarClock(calendar, type);
    const body = buildCalendarBody(calendar, time);
    const reason = time.rejection ? `Newest timestamp rejected (message #${time.rejection.messageIndex}): ${time.rejection.reason}`
        : time.month == null ? 'No dated story clock; waiting for a readable timestamp or World State date.'
            : calendar.structure !== 'custom' ? 'Gregorian calendar: date line is not used.'
                : !calendar.dateLine ? 'Date line is off.' : null;
    const date = time.month != null ? calendarHoursToDate(calendar, time.hours, { hemisphere: getChatMeta('mwt_ambient')?.hemisphere ?? 'north' }) : null;
    return { calendar, time, body: injectionAllowed('Calendar') ? body : '',
        state: injectionAllowed('Calendar') ? 'configured' : 'blocked by panic switch', reason,
        today: date ? formatCalendarDate(calendar, date) : null,
        tomorrow: date ? formatCalendarDate(calendar, calendarDateFromDayIndex(calendar, calendarDayIndex(calendar, date) + 1)) : null };
}

/** Ambient's dated inputs use the same grammar as tags, never Gregorian guessing. */
export function parseStoryDateTime(date, time, hemisphere = getChatMeta('mwt_ambient')?.hemisphere) {
    return parseAmbientDateTime(date, time, { calendar: getChatMeta('mwt_calendar'),
        hemisphere });
}

export function formatStoryDateInput(hours) {
    const calendar = getChatMeta('mwt_calendar');
    if (calendar?.structure !== 'custom') return new Date(hours * 3600000).toISOString().slice(0, 10);
    return formatCalendarDate(calendar, calendarHoursToDate(calendar, hours,
        { hemisphere: getChatMeta('mwt_ambient')?.hemisphere ?? 'north' }), { weekday: false });
}