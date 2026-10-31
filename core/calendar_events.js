/** Pure event occurrences. No writes, fired flags, host clock or Ambient enable gate. */
import { calendarDayIndex, calendarDateFromDayIndex, calendarHoursToDate, calendarDateToHours,
    isCalendarDate } from './calendar_math.js';
import { LUNAR_EPOCH_HOURS, LUNAR_MONTH_DAYS, isMoonEpochOffset } from './ambient_astronomy.js';

/** Inclusive calendar-day range; lunar events use the day containing the phase instant. */
export function calendarEventOccurrences(calendar, first, last, options = {}) {
    const occurrences = [];
    for (const event of calendar.events ?? []) {
        const duration = event.durationDays ?? 1;
        const add = start => {
            if (start <= last && start + duration > first) occurrences.push({ event, start, end: start + duration });
        };
        if (event.repeat?.lunar) {
            const period = LUNAR_MONTH_DAYS * 24;
            const origin = LUNAR_EPOCH_HOURS + (isMoonEpochOffset(options.moonEpochOffset) ? options.moonEpochOffset : 0)
                + (event.repeat.lunar === 'full' ? period / 2 : 0);
            const from = calendarDateToHours(calendar, calendarDateFromDayIndex(calendar, first - duration + 1), options);
            const until = calendarDateToHours(calendar, calendarDateFromDayIndex(calendar, last + 1), options);
            for (let cycle = Math.ceil((from - origin) / period); origin + cycle * period < until; cycle++) {
                add(calendarDayIndex(calendar, calendarHoursToDate(calendar, origin + cycle * period, options)));
            }
        } else if (event.repeat === 'none') add(calendarDayIndex(calendar, event.date));
        else {
            const step = event.repeat === 'yearly' ? 1 : event.repeat.everyYears;
            const firstYear = calendarDateFromDayIndex(calendar, first - duration + 1).year;
            const lastYear = calendarDateFromDayIndex(calendar, last).year;
            // The authored year is the first occurrence. Missing Gregorian leap dates are skipped.
            let year = event.date.year + Math.max(0, Math.ceil((firstYear - event.date.year) / step)) * step;
            for (; year <= lastYear; year += step) {
                const date = { ...event.date, year };
                if (isCalendarDate(calendar, date, { authoring: false })) add(calendarDayIndex(calendar, date));
            }
        }
    }
    return occurrences.sort((a, b) => a.start - b.start || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0));
}

const count = number => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'][number] ?? String(number);

/** D32: inclusive 14-day horizon, a second mention only when both are within seven. */
export function projectCalendarEvents(calendar, today, options = {}) {
    const index = calendarDayIndex(calendar, today);
    const horizon = index + 14;
    const coverage = new Map();
    // Repetitions of the same event form one continuous interval when they
    // overlap or adjoin. Do this before ID deduplication and mention selection.
    for (const occurrence of calendarEventOccurrences(calendar, index, horizon, options)) {
        const intervals = coverage.get(occurrence.event.id) ?? [];
        const previous = intervals.at(-1);
        if (previous && occurrence.start <= previous.end) {
            previous.end = Math.max(previous.end, occurrence.end);
            previous.merged = true;
        } else intervals.push({ ...occurrence });
        coverage.set(occurrence.event.id, intervals);
    }
    const candidates = [...coverage.values()].flat().sort((a, b) => a.start - b.start
        || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0));
    const selected = [];
    for (const occurrence of candidates) {
        if (selected.some(item => item.event.id === occurrence.event.id)) continue;
        if (selected.length && (selected[0].start > index + 7 || occurrence.start > index + 7)) break;
        selected.push(occurrence);
        if (selected.length === 2) break;
    }
    const line = selected.map(({ event, start, end, merged }) => {
        if (start <= index) {
            // Coverage reaching beyond the bounded query may continue indefinitely.
            // Never advertise the last enumerated repetition as its final day.
            if (merged && end > horizon) return `${event.name} is ongoing.`;
            const remaining = end - index;
            return `${event.name} is ongoing; ${remaining === 1 ? 'today is its final day' : `${count(remaining)} days remain, including today`}.`;
        }
        const days = start - index;
        return `${event.name} begins ${days === 1 ? 'tomorrow' : `in ${count(days)} days`}.`;
    }).join(' ');
    return { events: selected, line };
}