/** Pure calendar structure and arithmetic. No host clock, locale, storage or ST imports. */
export const CALENDAR_VERSION = 1;
export const CALENDAR_LIMITS = Object.freeze({ months: 24, monthDays: 40, weekdays: 14, nameLength: 24 });
export const CALENDAR_SOLSTICE_HOURS = Object.freeze({
    north: Date.UTC(2000, 5, 21) / 3600000,
    south: Date.UTC(2000, 11, 21) / 3600000,
});
const MONTH_NAMES = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']);
const WEEKDAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Shared with the future tag parser; typographic apostrophes have no identity. */
export function normalizeCalendarName(value) {
    return typeof value === 'string' ? value.replace(/[‘’]/gu, "'").normalize('NFC').trim() : value;
}

function validName(value) {
    return typeof value === 'string' && [...value].length >= 1 && [...value].length <= CALENDAR_LIMITS.nameLength
        && /\p{L}/u.test(value) && /^[\p{L}\p{M} '\-]+$/u.test(value);
}

function leapYear(year) {
    return mod(year, 4) === 0 && (mod(year, 100) !== 0 || mod(year, 400) === 0);
}

/** Works for computed years <= 0 too; authoring bounds are enforced separately. */
export function calendarMonthLength(record, year, month) {
    if (!Number.isSafeInteger(year) || !Number.isInteger(month)) return null;
    if (record?.structure === 'gregorian') {
        return month >= 1 && month <= 12 ? [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] : null;
    }
    return record?.months?.[month - 1]?.days ?? null;
}

/** Authorable dates are 1–9999; arithmetic also accepts computed integer years. */
export function isCalendarDate(record, date, { authoring = true } = {}) {
    if (!object(date) || !Number.isSafeInteger(date.year) || (authoring && (date.year < 1 || date.year > 9999))) return false;
    const length = calendarMonthLength(record, date.year, date.month);
    return length !== null && Number.isInteger(date.day) && date.day >= 1 && date.day <= length;
}

/**
 * Total save-time validation for JSON-shaped input. Returns a fresh normalized
 * record on success, never mutates input.
 */
export function validateCalendarRecord(input) {
    const errors = [];
    if (!object(input)) return { valid: false, errors: ['Calendar must be an object.'], record: null };
    let record;
    try { record = JSON.parse(JSON.stringify(input)); }
    catch { return { valid: false, errors: ['Calendar must be JSON-serializable.'], record: null }; }
    if (!object(record)) return { valid: false, errors: ['Calendar must serialize to an object.'], record: null };
    if (record.version !== CALENDAR_VERSION) errors.push('version must be 1.');
    record.structure ??= 'custom';
    if (!['custom', 'gregorian'].includes(record.structure)) errors.push('structure must be custom or gregorian.');
    for (const key of ['events', 'phenomena']) {
        if (!Array.isArray(record[key])) errors.push(`${key} must be an array.`);
    }
    if (typeof record.eventsLine !== 'boolean') errors.push('eventsLine must be boolean.');
    if (record.structure === 'custom') {
        if (typeof record.dateLine !== 'boolean') errors.push('dateLine must be boolean.');
        if (!Array.isArray(record.months) || record.months.length < 1 || record.months.length > 24) {
            errors.push('Use 1–24 months.');
        } else {
            for (const month of record.months) {
                if (!object(month)) { errors.push('Each month must have a name and day count.'); continue; }
                month.name = normalizeCalendarName(month.name);
                if (!validName(month.name)) errors.push('Month names require 1–24 characters: letters, spaces, apostrophes or hyphens.');
                if (!Number.isInteger(month.days) || month.days < 1 || month.days > 40) errors.push('Month lengths must be 1–40 days.');
            }
            const names = record.months.map(month => typeof month?.name === 'string' ? month.name.toLowerCase() : null);
            if (new Set(names).size !== names.length) errors.push('Month names must be unique (case-insensitive).');
        }
        if (record.weekdays !== null) {
            if (!Array.isArray(record.weekdays) || record.weekdays.length < 2 || record.weekdays.length > 14) {
                errors.push('Use 2–14 weekdays, or null.');
            } else {
                record.weekdays = record.weekdays.map(normalizeCalendarName);
                if (!record.weekdays.every(validName)) errors.push('Invalid weekday name.');
                const names = record.weekdays.map(name => typeof name === 'string' ? name.toLowerCase() : null);
                if (new Set(names).size !== names.length) errors.push('Weekday names must be unique (case-insensitive).');
            }
        }
        record.era = normalizeCalendarName(record.era);
        if (record.era !== null && !validName(record.era)) errors.push('era must be a valid name or null.');
        if (!isCalendarDate(record, record.anchor)) errors.push('anchor must be an existing date in years 1–9999.');
        if (Array.isArray(record.weekdays) && (!Number.isInteger(record.anchor?.weekday)
            || record.anchor.weekday < 0 || record.anchor.weekday >= record.weekdays.length)) errors.push('anchor.weekday must index the weekday list.');
        if (record.weekdays === null && record.anchor?.weekday != null) errors.push('A weekday-less anchor must omit weekday or use null.');
        if (Object.hasOwn(record, 'solstice') || (object(record.anchor) && Object.hasOwn(record.anchor, 'solstice'))) errors.push('Solstice is derived from hemisphere, not stored.');
    } else if (record.structure === 'gregorian') {
        for (const key of ['months', 'weekdays', 'anchor', 'era', 'dateLine', 'solstice']) {
            if (Object.hasOwn(record, key)) errors.push(`${key} is absent in a gregorian record.`);
        }
    }
    if (Array.isArray(record.events)) {
        const ids = new Set();
        record.events.forEach((event, index) => {
            const fail = message => errors.push(`events[${index}]: ${message}`);
            if (!object(event)) { fail('Event must be an object.'); return; }
            if (typeof event.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(event.id) || ids.has(event.id)) fail('Use a unique ID (1–64 letters, digits, hyphens or underscores).');
            ids.add(event.id);
            event.name = normalizeCalendarName(event.name);
            if (!validName(event.name)) fail('Use a safe name of 1–24 characters.');
            event.durationDays ??= 1;
            if (!Number.isInteger(event.durationDays) || event.durationDays < 1 || event.durationDays > 14) fail('durationDays must be 1–14.');
            const repeat = event.repeat;
            const lunar = object(repeat) && ['new', 'full'].includes(repeat.lunar) && Object.keys(repeat).length === 1;
            const every = object(repeat) && Number.isInteger(repeat.everyYears) && repeat.everyYears >= 2 && repeat.everyYears <= 99 && Object.keys(repeat).length === 1;
            if (!['none', 'yearly'].includes(repeat) && !lunar && !every) fail('Invalid repeat.');
            if (lunar) {
                if (event.date != null) fail('Lunar events have no stored date.');
            } else if (!isCalendarDate(record, event.date)) fail('Use an existing calendar date in years 1–9999.');
        });
    }
    if (errors.length === 0 && Array.isArray(record.phenomena)) {
        if (record.phenomena.length > 16 || new Set(record.phenomena.map(rule => rule?.id)).size !== record.phenomena.length
            || !record.phenomena.every(rule => isDatedRule(record, rule))) errors.push('Invalid dated phenomena: use unique IDs, safe names/clauses, valid dates, one duration (1–400 days or 1–13 months), and none/yearly repeat (maximum 16 rules).');
    }
    return { valid: errors.length === 0, errors, record: errors.length === 0 ? record : null };
}

/** Calendar instants keep End now independent of the absolute-hours anchor. */
export function isCalendarInstant(record, value) {
    return isCalendarDate(record, value) && Number.isInteger(value.hour) && value.hour >= 0 && value.hour <= 23
        && Number.isInteger(value.minute) && value.minute >= 0 && value.minute <= 59
        && (value.second === undefined || (Number.isFinite(value.second) && value.second >= 0 && value.second < 60));
}

export function isDatedRule(record, rule) {
    const gates = { regime: ['daylight', 'twilight', 'darkness'], sky: ['clear', 'partly cloudy', 'overcast', 'foggy'],
        wind: ['calm', 'light', 'breezy', 'strong'], season: ['winter', 'spring', 'summer', 'autumn'] };
    const safe = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\r\n<>]/.test(value);
    return object(rule) && rule.shape === 'dated' && typeof rule.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rule.id)
        && safe(rule.name, 60) && safe(rule.clause, 80) && isCalendarDate(record, rule.start)
        && ['hour', 'minute', 'second'].every(key => rule.start[key] === undefined || rule.start[key] === 0)
        && ['none', 'yearly'].includes(rule.repeat)
        && ((Number.isInteger(rule.durationDays) && rule.durationDays >= 1 && rule.durationDays <= 400 && rule.durationMonths === undefined)
            || (Number.isInteger(rule.durationMonths) && rule.durationMonths >= 1 && rule.durationMonths <= 13 && rule.durationDays === undefined))
        && (rule.end === null || (isCalendarInstant(record, rule.end) && calendarDateToHours(record, rule.end) >= calendarDateToHours(record, rule.start)))
        && (rule.light === undefined || gates.regime.includes(rule.light))
        && (rule.priority === undefined || (Number.isInteger(rule.priority) && Math.abs(rule.priority) <= 100))
        && (rule.visibilityGates === undefined || (object(rule.visibilityGates) && Object.entries(rule.visibilityGates).every(([key, values]) =>
            Object.hasOwn(gates, key) && Array.isArray(values) && values.length > 0 && values.every(value => gates[key].includes(value)))))
        && rule.startGates === undefined;
}

/** Add calendar months, clamping the day to the destination month's last day. */
export function addCalendarMonths(record, date, count) {
    const months = record.structure === 'gregorian' ? 12 : record.months.length;
    const index = date.month - 1 + count;
    const year = date.year + Math.floor(index / months);
    const month = mod(index, months) + 1;
    return { year, month, day: Math.min(date.day, calendarMonthLength(record, year, month)) };
}

/** Random-access intervals, including yearly overlaps in very short calendars. */
export function datedRuleActive(record, rule, time, options = {}) {
    if (!record || time?.month == null || time.rejection || !isDatedRule(record, rule)) return false;
    if (rule.end !== null && time.hours >= calendarDateToHours(record, rule.end, options)) return false;
    const today = calendarHoursToDate(record, time.hours, options);
    const yearDays = record.structure === 'gregorian' ? 365 : record.months.reduce((sum, month) => sum + month.days, 0);
    const lookback = rule.durationDays ? Math.ceil(rule.durationDays / yearDays) : Math.ceil(rule.durationMonths / (record.structure === 'gregorian' ? 12 : record.months.length));
    const first = rule.repeat === 'yearly' ? Math.max(rule.start.year, today.year - lookback) : rule.start.year;
    const last = rule.repeat === 'yearly' ? today.year : rule.start.year;
    for (let year = first; year <= last; year++) {
        const start = { ...rule.start, year };
        if (!isCalendarDate(record, start, { authoring: false })) continue;
        const from = calendarDateToHours(record, start, options);
        const until = rule.durationDays ? from + rule.durationDays * 24
            : calendarDateToHours(record, addCalendarMonths(record, start, rule.durationMonths), options);
        if (time.hours >= from && time.hours < until) return true;
    }
    return false;
}

function requireDate(record, date) {
    if (!isCalendarDate(record, date, { authoring: false })) throw new RangeError('Invalid calendar date.');
}

/** Gregorian UTC-shaped midnight without Date.UTC's year 0–99 special case. */
function gregorianHours(date) {
    const value = new Date(0);
    value.setUTCFullYear(date.year, date.month - 1, date.day);
    value.setUTCHours(0, 0, 0, 0);
    if (!Number.isFinite(value.getTime())) throw new RangeError('Calendar date is outside the supported range.');
    return value.getTime() / 3600000;
}

/** Custom index is relative to anchor.year's start, NOT to the anchor day. */
export function calendarDayIndex(record, date) {
    requireDate(record, date);
    if (record.structure === 'gregorian') return gregorianHours(date) / 24;
    const yearDays = record.months.reduce((sum, month) => sum + month.days, 0);
    const index = (date.year - record.anchor.year) * yearDays
        + record.months.slice(0, date.month - 1).reduce((sum, month) => sum + month.days, 0) + date.day - 1;
    if (!Number.isSafeInteger(index)) throw new RangeError('Calendar day index is outside the safe integer range.');
    return index;
}

export function calendarDateFromDayIndex(record, index) {
    if (!Number.isSafeInteger(index)) throw new RangeError('Calendar day index must be a safe integer.');
    if (record.structure === 'gregorian') {
        const value = new Date(index * 86400000);
        if (!Number.isFinite(value.getTime())) throw new RangeError('Calendar day index is outside the supported range.');
        return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
    }
    const yearDays = record.months.reduce((sum, month) => sum + month.days, 0);
    const year = record.anchor.year + Math.floor(index / yearDays);
    let remaining = mod(index, yearDays);
    let month = 1;
    while (remaining >= record.months[month - 1].days) remaining -= record.months[month++ - 1].days;
    return { year, month, day: remaining + 1 };
}

/** Hemisphere is ambient's value at read time; unset defaults north. */
export function calendarOriginHours(record, { hemisphere = 'north' } = {}) {
    if (record.structure === 'gregorian') return 0;
    if (!['north', 'south'].includes(hemisphere)) throw new RangeError('Hemisphere must be north or south.');
    return CALENDAR_SOLSTICE_HOURS[hemisphere] - calendarDayIndex(record, record.anchor) * 24;
}

export function calendarDateToHours(record, date, options = {}) {
    const hour = date?.hour ?? 0;
    const minute = date?.minute ?? 0;
    const second = date?.second ?? 0;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError('Use hours 0–23 and minutes 0–59.');
    if (!Number.isFinite(second) || second < 0 || second >= 60) throw new RangeError('Seconds must be in [0, 60).');
    return calendarOriginHours(record, options) + calendarDayIndex(record, date) * 24 + hour + minute / 60 + second / 3600;
}

/** Retains sub-minute hours as second; no rounding across midnight boundaries. */
export function calendarHoursToDate(record, hours, options = {}) {
    if (!Number.isFinite(hours)) throw new RangeError('Story hours must be finite.');
    const elapsed = hours - calendarOriginHours(record, options);
    const index = Math.floor(elapsed / 24);
    const clock = mod(elapsed, 24);
    // Snap minute-grid round-off only, scaled to the precision of these hours.
    const rawMinutes = clock * 60;
    const tolerance = Math.max(1e-9, Math.abs(hours) * Number.EPSILON * 120,
        Math.abs(elapsed) * Number.EPSILON * 120);
    const minutes = Math.abs(rawMinutes - Math.round(rawMinutes)) < tolerance ? Math.round(rawMinutes) : rawMinutes;
    const safeMinutes = Math.min(minutes, 1440 - Number.EPSILON * 1024);
    return { ...calendarDateFromDayIndex(record, index), hour: Math.floor(safeMinutes / 60),
        minute: Math.floor(safeMinutes % 60), second: (safeMinutes - Math.floor(safeMinutes)) * 60 };
}

export function calendarWeekday(record, index) {
    if (!Number.isSafeInteger(index)) throw new RangeError('Calendar day index must be a safe integer.');
    if (record.structure === 'gregorian') return WEEKDAY_NAMES[mod(index + 4, 7)];
    if (record.weekdays === null) return null;
    return record.weekdays[mod(record.anchor.weekday + index - calendarDayIndex(record, record.anchor), record.weekdays.length)];
}

/** Date line omits era by default; era is an optional display prefix only. */
export function formatCalendarDate(record, date, { weekday = true, era = false } = {}) {
    const index = calendarDayIndex(record, date);
    const name = record.structure === 'gregorian' ? MONTH_NAMES[date.month - 1] : record.months[date.month - 1].name;
    const dayName = weekday ? calendarWeekday(record, index) : null;
    return `${era && record.era ? `${record.era} ` : ''}${dayName ? `${dayName}, ` : ''}${name} ${date.day}, ${date.year}`;
}