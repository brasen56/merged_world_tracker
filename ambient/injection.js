import { applyExtensionPromptInjection } from '../core/injection.js';
import { getGlobalSettings } from '../core/settings.js';
import { getInjectedSnapshot, record } from '../core/diagnostics.js';

export const EXTENSION_PROMPT_KEY = 'mwt_ambient_injection';

export function describeConditions(conditions) {
    const precipitation = conditions.precipitation === 'none' ? 'no precipitation' : conditions.precipitation;
    return `${conditions.sky}, ${conditions.temperature}, ${conditions.air} air; ${precipitation}. Wind ${conditions.wind}.`;
}

export function buildInjectionBody(ambient) {
    return `Stage direction, not narration. Ambient conditions (authoritative): ${describeConditions(ambient.conditions)} `
        + `Forecast for the next ${ambient.forecast.band.name} band only: ${describeConditions(ambient.forecast.conditions)} `
        + 'Reference when perceptually relevant; do not re-mention conditions every reply. '
        + 'Conditions shift only as in-story time advances. If this response skips ahead in time, '
        + 'keep conditions vague; they will be supplied next turn.';
}

export function applyAmbientInjection(ambient, diagnostics) {
    return applyExtensionPromptInjection({
        key: EXTENSION_PROMPT_KEY,
        body: ambient ? buildInjectionBody(ambient) : '',
        enabled: !!ambient,
        fallbackDepth: 1,
        globalRole: 'system',
        wrapperTag: 'mwt_ambient',
        useTags: getGlobalSettings().structuralBoundaries !== false,
        diagnostics,
    });
}

export function clearAmbientInjection(diagnostics = { kind: 'ambient-conditions', clearReason: 'explicit-clear' }) {
    // Record the clear event ONLY when something was actually registered.
    // Both the early GENERATION_STARTED clear and the interceptor's clear
    // land here every generation — including for users who never enable the
    // module — so unconditional events spent two of the 200 shared ring
    // entries per generation and crowded out every other module's history.
    // A no-op clear needs no event: the per-key snapshot written by the
    // apply below keeps the latest clearReason either way.
    if (getInjectedSnapshot(EXTENSION_PROMPT_KEY)?.enabled) {
        record({ module: 'ambient', event: 'ambient_injection_cleared', level: 'debug', detail: { ...diagnostics } });
    }
    return applyAmbientInjection(null, diagnostics);
}