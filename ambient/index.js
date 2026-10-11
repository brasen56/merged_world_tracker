/** Per-generation orchestration. Conditions are never persisted, only the seed. */
import { getContextSafe, getChatMeta } from '../core/context.js';
import { patchChatMeta, getCurrentWorldState } from '../core/metadata.js';
import { getEpoch } from '../core/scope.js';
import { injectionAllowed } from '../core/settings.js';
import { record } from '../core/diagnostics.js';
import { resolveAmbientTime } from '../core/ambient_time.js';
import { generateAmbientConditions } from '../core/ambient_generator.js';
import { getSettings, isConfigured, SETTINGS_KEY } from './settings.js';
import { applyAmbientInjection, clearAmbientInjection } from './injection.js';

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
        const time = resolveAmbientTime({ messages: ctx.chat, worldState: getCurrentWorldState(), type });
        let seed = meta[SETTINGS_KEY]?.seed;
        if (!Number.isFinite(seed)) {
            seed = Math.floor(Math.random() * 4294967296);
            patchChatMeta(SETTINGS_KEY, { seed });
        }
        const ambient = generateAmbientConditions({ ...settings, seed, time });
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
            messageIndex: time.messageIndex ?? null, band: ambient.band.name, season: ambient.season,
        });
    } catch (err) {
        clearAmbientInjection({ kind: 'ambient-conditions', clearReason: 'injection-failed', generationType: type });
        record({ module: 'ambient', event: 'ambient_injection_failed', level: 'warn', detail: { message: String(err?.message || err) } });
        return false;
    }
}