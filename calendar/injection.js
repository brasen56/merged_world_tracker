import { applyExtensionPromptInjection } from '../core/injection.js';
import { getGlobalSettings } from '../core/settings.js';

export const EXTENSION_PROMPT_KEY = 'mwt_calendar_injection';
export function resolveInjectionPlacement() {
    return { depth: { value: 1, source: 'builtin' }, role: { value: 'system', source: 'builtin' } };
}
export function applyCalendarInjection(body, diagnostics = {}) {
    return applyExtensionPromptInjection({ key: EXTENSION_PROMPT_KEY, body, enabled: !!body,
        fallbackDepth: 1, globalRole: 'system', wrapperTag: 'mwt_calendar',
        useTags: getGlobalSettings().structuralBoundaries !== false, diagnostics: { kind: 'calendar-date', ...diagnostics } });
}
export function clearCalendarInjection(diagnostics = {}) {
    return applyCalendarInjection('', diagnostics);
}