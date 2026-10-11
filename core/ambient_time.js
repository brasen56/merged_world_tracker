/** Pure in-story clock parsing. No host clock, locale, or persistence dependencies. */
import { readCurrentScene } from './world_state_document.js';

export const AMBIENT_MONTHS = Object.freeze([
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
]);
export const AMBIENT_HOUR_MS = 3600000;

const WEEKDAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i;

function parseClock(text) {
    const match = typeof text === 'string' ? text.trim().match(CLOCK_RE) : null;
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (minute > 59) return null;
    if (match[3]) {
        if (hour < 1 || hour > 12) return null;
        hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
    } else if (!match[2] || hour > 23) {
        return null;
    }
    return { hour, minute };
}

/**
 * Recognize English month dates or unambiguous YYYY-MM-DD, never Date.parse.
 * monthNames is an extension seam for twelve renamed Gregorian months, NOT a
 * custom calendar implementation (different month lengths remain out of v1).
 * A missing/qualitative clock returns null rather than inventing midnight.
 */
export function parseAmbientDateTime(dateText, timeText, { monthNames = AMBIENT_MONTHS } = {}) {
    if (typeof dateText !== 'string') return null;
    const clock = parseClock(timeText);
    if (!clock) return null;
    const text = dateText.trim().replace(new RegExp(`^${WEEKDAY},\\s*`, 'i'), '');
    let year;
    let month;
    let day;
    const iso = text.match(/^(\d{1,4})-(\d{2})-(\d{2})$/);
    const named = text.match(/^([^\d,]+?)\s+(\d{1,2}),\s*(\d{1,4})$/u);
    if (iso) {
        [, year, month, day] = iso.map(Number);
    } else if (named && Array.isArray(monthNames) && monthNames.length === 12) {
        year = Number(named[3]);
        month = monthNames.findIndex(name => typeof name === 'string'
            && name.toLowerCase() === named[1].trim().toLowerCase()) + 1;
        day = Number(named[2]);
    } else {
        return null;
    }
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    // setUTCFullYear avoids Date.UTC's special handling of years 0–99.
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(clock.hour, clock.minute, 0, 0);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { hours: date.getTime() / AMBIENT_HOUR_MS, year, month, day, ...clock };
}

/** Return the last usable canonical tag in a message, or null. */
export function parseAmbientTimestamp(text, options = {}) {
    if (typeof text !== 'string') return null;
    const tags = [...text.matchAll(/\[In-story time:\s*([^\]\r\n]*)\]/gi)];
    for (let index = tags.length - 1; index >= 0; index--) {
        const match = tags[index][1].match(new RegExp(`^(\\d{1,2}:\\d{2}\\s*(?:AM|PM)),\\s*${WEEKDAY},\\s*(.+)$`, 'i'));
        const parsed = match ? parseAmbientDateTime(match[2], match[1], options) : null;
        if (parsed) return parsed;
    }
    return null;
}

/**
 * Pure source ladder. Callers supply the chat and World State document/scene.
 * Swipe excludes the replaced message from BOTH tag scanning and count time.
 * Count time uses one synthetic hour per included message by default, with no
 * inferred month: the generator must use the supplied manual season instead.
 */
export function resolveAmbientTime({ messages = [], worldState = '', type = 'normal', hoursPerMessage = 1, monthNames = AMBIENT_MONTHS } = {}) {
    if (!Number.isFinite(hoursPerMessage) || hoursPerMessage <= 0) throw new RangeError('hoursPerMessage must be positive and finite.');
    const chat = Array.isArray(messages) ? messages : [];
    const count = Math.max(0, chat.length - (type === 'swipe' ? 1 : 0));
    for (let index = count - 1; index >= 0; index--) {
        const parsed = parseAmbientTimestamp(typeof chat[index] === 'string' ? chat[index] : chat[index]?.mes, { monthNames });
        if (parsed) return { ...parsed, source: 'timestamp', messageIndex: index };
    }
    const scene = typeof worldState === 'string' ? readCurrentScene(worldState) : worldState;
    const parsed = parseAmbientDateTime(scene?.date, scene?.time, { monthNames });
    if (parsed) return { ...parsed, source: 'world-state' };
    return { hours: count * hoursPerMessage, month: null, source: 'message-count' };
}