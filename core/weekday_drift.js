/** Calendar tag integrity, independent of Ambient enablement and injection. */
import { getContextSafe, getChatMeta } from './context.js';
import { resolveAmbientTime } from './ambient_time.js';
import { getEpoch } from './scope.js';
import { record } from './diagnostics.js';

let previous = null;

function readTime() {
    return resolveAmbientTime({ messages: getContextSafe()?.chat, calendar: getChatMeta('mwt_calendar'),
        hemisphere: getChatMeta('mwt_ambient')?.hemisphere });
}

/** Read-only Overview projection. No tag means no warning, not an invented date. */
export function getWeekdayDriftStatus() {
    const time = readTime();
    if (time.source !== 'timestamp' || !time.weekday?.mismatch) return null;
    const { year, month, day, messageIndex, messagesAfter, weekday } = time;
    const date = time.grammar === 'custom' ? time.formattedDate
        : `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { date, messageIndex, messagesAfter, tagged: weekday.tagged, computed: weekday.computed,
        ...(time.grammar === 'custom' ? { grammar: 'custom' } : {}) };
}

/** Observe settled chat events, never rendering: repeated reads cannot flood the ring. */
export function observeWeekdayDrift() {
    const ctx = getContextSafe();
    const status = getWeekdayDriftStatus();
    const rejection = readTime().rejection;
    const epoch = getEpoch();
    const key = status ? JSON.stringify([status.date, status.messageIndex, status.tagged, status.computed]) : null;
    const duplicate = previous?.chat === ctx?.chat && previous?.epoch === epoch && previous?.key === key;
    const rejectionKey = rejection ? JSON.stringify(rejection) : null;
    const duplicateRejection = previous?.chat === ctx?.chat && previous?.epoch === epoch && previous?.rejectionKey === rejectionKey;
    previous = { chat: ctx?.chat, epoch, key, rejectionKey };
    if (status && !duplicate) {
        record({ module: 'calendar', event: status.grammar === 'custom' ? 'custom_weekday_drift' : 'gregorian_weekday_drift', level: 'warn', detail: status });
    }
    if (rejection && !duplicateRejection) record({ module: 'calendar', event: 'calendar_tag_rejected', level: 'warn', detail: rejection });
    return status;
}