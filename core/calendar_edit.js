/** Pure authoring transforms. Month identity is its original row index, not its name. */
import { calendarDateToHours, calendarHoursToDate, isCalendarDate, validateCalendarRecord } from './calendar_math.js';

export function editCalendarMonths(record, rows, { clamp = false } = {}) {
    const next = JSON.parse(JSON.stringify(record));
    const mapping = new Map();
    rows.forEach((row, index) => {
        if (row.original != null) {
            if (!Number.isInteger(row.original) || row.original < 0 || row.original >= record.months.length || mapping.has(row.original + 1)) {
                throw new Error('Invalid or duplicate month identity.');
            }
            mapping.set(row.original + 1, index + 1);
        }
    });
    next.months = rows.map(({ name, days }) => ({ name, days }));
    const clamped = [];
    const visit = (value, path) => {
        if (!value || typeof value !== 'object') return;
        if (Number.isInteger(value.month) && Number.isInteger(value.day)) {
            const month = mapping.get(value.month);
            if (!month) throw new Error(`${path} references a removed month. Move its date before removing the month.`);
            value.month = month;
            const length = next.months[month - 1].days;
            if (value.day > length) {
                clamped.push(`${path}: day ${value.day} → ${length}`);
                if (clamp) value.day = length;
            }
        }
        for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    };
    for (const key of ['anchor', 'events', 'phenomena']) visit(next[key], key);
    return { record: next, clamped, needsClamping: clamped.length > 0 && !clamp };
}

/** Re-map dated bounds by date; synthetic bounds reset relative to the new now. */
export function restampAmbientTimes(settings, oldCalendar, newCalendar, time,
    { oldHemisphere = 'north', newHemisphere = oldHemisphere, monthMap } = {}) {
    const gregorian = { structure: 'gregorian' };
    const remap = (hours, source, start) => {
        if (hours == null) return null;
        if (source === 'message-count') return time.hours + (start == null ? 0 : hours - start);
        const date = calendarHoursToDate(oldCalendar ?? gregorian, hours, { hemisphere: oldHemisphere });
        if (monthMap && oldCalendar?.structure === 'custom') {
            const month = monthMap.get(date.month);
            if (!month) throw new Error('A stored Ambient date references a removed month. Decline re-stamping or retain that month.');
            date.month = month;
        }
        if (!isCalendarDate(newCalendar ?? gregorian, date)) throw new Error('A stored Ambient date does not exist in the new calendar. Decline re-stamping or adjust the structure.');
        return calendarDateToHours(newCalendar ?? gregorian, date, { hemisphere: newHemisphere });
    };
    if (time.month == null) throw new Error('Re-stamping needs a readable date on the new clock. Save without re-stamping, then set a custom timestamp first.');
    const next = JSON.parse(JSON.stringify(settings));
    const stamp = (item, label, allowEmpty = false) => {
        const start = item.startHours;
        item.startHours = remap(start, item.source);
        item.endHours = remap(item.endHours, item.source, start);
        item.source = time.source;
        if (!Number.isFinite(item.startHours) || (item.endHours !== null
            && (!Number.isFinite(item.endHours) || (allowEmpty ? item.endHours < item.startHours : item.endHours <= item.startHours)))) {
            throw new Error(`Re-stamping would invalidate the interval for ${label}. Decline re-stamping or adjust its dates before changing the calendar.`);
        }
    };
    if (next.pin) stamp(next.pin, 'the Ambient pin');
    for (const rule of next.phenomena ?? []) stamp(rule, `Ambient frequency rule "${rule.name ?? rule.id ?? 'unnamed'}"`, true);
    return next;
}

export function requireCalendarRecord(input) {
    const result = validateCalendarRecord(input);
    if (!result.valid) throw new Error(result.errors.join(' '));
    return result.record;
}