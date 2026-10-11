/** Per-generation orchestration. Conditions are never persisted, only the seed. */
import { getContextSafe, getChatMeta } from '../core/context.js';
import { getEpoch } from '../core/scope.js';
import { injectionAllowed } from '../core/settings.js';
import { record } from '../core/diagnostics.js';
import { readAmbientConditions } from '../core/ambient_state.js';
import { getSettings, isConfigured, ensureSeed } from './settings.js';
import { applyAmbientInjection, clearAmbientInjection, buildInjectionBody } from './injection.js';

export const TIME_JUMP_THRESHOLD_HOURS = 6;
let previousClock = null;

export function onChatChanged() {
    previousClock = null;
    clearAmbientInjection({ kind: 'ambient-conditions', clearReason: 'chat-changed' });
}

/** ST emits (type, options, dryRun); dry runs must leave the slot untouched. */
export function onGenerationStarted(type = 'normal', _options = {}, dryRun = false) {
    if (dryRun) return false;
    try {
        const ctx = getContextSafe();
        const settings = getSettings();
        const clearReason = !['normal', 'swipe', 'continue'].includes(type) ? 'generation-type-excluded'
            : !ctx ? 'host-unavailable'
                : !settings.enabled ? 'module-disabled'
                    : !isConfigured(settings) ? 'configuration-incomplete'
                        : !injectionAllowed('Ambient') ? 'global-gate-blocked' : null;
        if (clearReason) {
            const diagnostics = { kind: 'ambient-conditions', clearReason, generationType: type };
            clearAmbientInjection(diagnostics);
            return false;
        }
        const meta = getChatMeta();
        const { time, ambient } = readAmbientConditions(settings, ensureSeed(), type);
        const epoch = getEpoch();
        // Compare only clocks from the same metadata object, epoch and source.
        // Changing fallback source is not a story jump (synthetic hours have no date).
        if (previousClock?.meta === meta && previousClock.epoch === epoch && previousClock.source === time.source) {
            const deltaHours = time.hours - previousClock.hours;
            if (Math.abs(deltaHours) > TIME_JUMP_THRESHOLD_HOURS) {
                record({ module: 'ambient', event: 'ambient_time_jump', level: 'info', detail: {
                    fromHours: previousClock.hours, toHours: time.hours, deltaHours,
                    source: time.source, type, thresholdHours: TIME_JUMP_THRESHOLD_HOURS,
                } });
            }
        }
        previousClock = { meta, epoch, hours: time.hours, source: time.source };
        return applyAmbientInjection(ambient, {
            kind: 'ambient-conditions', generationType: type, timeSource: time.source, storyHours: time.hours,
            messageIndex: time.messageIndex ?? null, band: ambient.band.name, season: ambient.season, pinned: ambient.pinned,
        });
    } catch (err) {
        clearAmbientInjection({ kind: 'ambient-conditions', clearReason: 'injection-failed', generationType: type });
        record({ module: 'ambient', event: 'ambient_injection_failed', level: 'warn', detail: { message: String(err?.message || err) } });
        return false;
    }
}

export function ambientCommand(args = '') {
    const action = String(args).trim().toLowerCase();
    if (action && action !== 'reseed') return 'Usage: /wt-ambient [reseed] (alias: /wt-weather).';
    const settings = getSettings();
    if (!settings.enabled || !isConfigured(settings)) return 'Ambient Conditions is off or needs setup. Open Settings → Ambient Conditions.';
    if (!injectionAllowed('Ambient')) return 'Ambient Conditions injection is blocked by the global panic switch.';
    const { ambient } = readAmbientConditions(settings, ensureSeed(action === 'reseed'));
    if (action === 'reseed') clearAmbientInjection({ kind: 'ambient-conditions', clearReason: 'reseed' });
    return buildInjectionBody(ambient);
}