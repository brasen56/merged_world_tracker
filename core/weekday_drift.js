/** Gregorian tag integrity, independent of Ambient enablement and injection. */
import { getContextSafe } from './context.js';
import { resolveAmbientTime } from './ambient_time.js';
import { getEpoch } from './scope.js';
import { record } from './diagnostics.js';

let previous = null;

/** Read-only Overview projection. No tag means no warning, not an invented date. */
export function getWeekdayDriftStatus() {
    const time = resolveAmbientTime({ messages: getContextSafe()?.chat });
    if (time.source !== 'timestamp' || !time.weekday.mismatch) return null;
    const { year, month, day, messageIndex, messagesAfter, weekday } = time;
    const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { date, messageIndex, messagesAfter, tagged: weekday.tagged, computed: weekday.computed };
}

/** Observe settled chat events, never rendering: repeated reads cannot flood the ring. */
export function observeWeekdayDrift() {
    const ctx = getContextSafe();
    const status = getWeekdayDriftStatus();
    const epoch = getEpoch();
    const key = status ? JSON.stringify([status.date, status.messageIndex, status.tagged, status.computed]) : null;
    const duplicate = previous?.chat === ctx?.chat && previous?.epoch === epoch && previous?.key === key;
    previous = { chat: ctx?.chat, epoch, key };
    if (status && !duplicate) {
        record({ module: 'calendar', event: 'gregorian_weekday_drift', level: 'warn', detail: status });
    }
    return status;
}