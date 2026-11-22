/** Display-only story date and collision-checked IDs for explicit ledger writes. */
import { resolveCalendarClock } from '../core/calendar_state.js';

export function ledgerDate() {
    try {
        const clock = resolveCalendarClock();
        return clock.source !== 'message-count' && !clock.rejection ? clock.formattedDate || null : null;
    } catch { return null; }
}

export function ledgerId(record, prefix) {
    const used = new Set(['currencies', 'transactions', 'items', 'proposals', 'itemLog']
        .flatMap(key => (record[key] ?? []).map(row => row?.id)));
    let value;
    do { value = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; } while (used.has(value));
    return value;
}