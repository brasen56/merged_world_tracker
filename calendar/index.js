import { getCalendarStatus } from '../core/calendar_state.js';
import { record } from '../core/diagnostics.js';
import { applyCalendarInjection, clearCalendarInjection } from './injection.js';

const TYPES = ['normal', 'swipe', 'continue', 'regenerate'];
export function onChatChanged() { clearCalendarInjection({ clearReason: 'chat-changed' }); }
export function prepareGeneration(type = 'normal', _options = {}, dryRun = false) {
    if (!dryRun) clearCalendarInjection({ clearReason: TYPES.includes(type) ? 'prompt-history-pending' : 'generation-type-excluded' });
}
export function onGenerationStarted(type = 'normal', _options = {}, dryRun = false, clockType = type) {
    if (dryRun) return false;
    if (!TYPES.includes(type)) return clearCalendarInjection({ clearReason: 'generation-type-excluded' });
    try {
        const status = getCalendarStatus(clockType);
        return applyCalendarInjection(status.body, { generationType: type, clearReason: status.reason ?? status.state,
            timeSource: status.time?.source, storyHours: status.time?.hours });
    } catch (error) {
        clearCalendarInjection({ clearReason: 'injection-failed' });
        record({ module: 'calendar', event: 'calendar_injection_failed', level: 'warn', detail: { message: error.message } });
        return false;
    }
}
export function generationInterceptor(_messages, _contextSize, _abort, type = 'normal') {
    return onGenerationStarted(type, {}, false, type === 'swipe' ? 'swipe' : 'normal');
}
export function calendarCommand(args = '') {
    if (String(args).trim()) return 'Usage: /wt-calendar (edit the calendar in the Calendar tab).';
    const status = getCalendarStatus();
    return status.body || `Calendar: ${status.reason ?? status.state}`;
}