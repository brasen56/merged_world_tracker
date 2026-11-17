/**
 * core/presets.js — Global onboarding preset engine.
 *
 * The patches mirror docs/ONBOARDING_PRESET_PLAN.md §2.1. Omitted keys are
 * deliberately left alone, including Lite/Standard's cadence intervals.
 * No chat metadata, Ambient configuration, generation, or first-run UI here.
 * Import directly rather than from core/index.js: module settings managers
 * themselves depend on that barrel.
 */

import { getGlobalSettings, saveGlobalSettings } from './settings.js';
import { record } from './diagnostics.js';
import * as worldState from '../world_state/settings.js';
import * as chronicle from '../chronicle/data.js';
import * as knowledge from '../knowledge/settings.js';
import * as storyPlanner from '../story_planner/settings.js';
import * as interiority from '../interiority/data.js';

function makePreset(name) {
    const full = name === 'full';
    const lite = name === 'lite';
    const stores = {
        merged_world_tracker: {
            enableWorldState: true,
            enableChronicle: true,
            enableKnowledge: !lite,
            enableStoryPlanner: !lite,
            enableInteriority: !lite,
        },
        mwt_world_state: {
            detailLevel: lite ? 'minimal' : full ? 'detailed' : 'standard',
            autoRefresh: full,
            ...(full ? { autoRefreshInterval: 5 } : {}),
        },
        mwt_chronicle: {
            autoSnapshot: full,
            ...(full ? { autoSnapshotThreshold: 40 } : {}),
        },
        mwt_knowledge: {
            autoTriggerEnabled: full,
            ...(full ? { autoTriggerEveryN: 5 } : {}),
            npcAutoScanEnabled: full,
            ...(full ? { npcAutoScanEveryN: 10 } : {}),
            growthAutoCaptureEnabled: full,
            ...(full ? { growthAutoCaptureEveryN: 15 } : {}),
            relationshipAutoExtractEnabled: full,
            ...(full ? { relationshipAutoExtractEveryN: 10 } : {}),
        },
        mwt_story_planner: { autoEnabled: false },
        mwt_interiority: { autoMode: full },
    };
    for (const patch of Object.values(stores)) Object.freeze(patch);
    return Object.freeze(stores);
}

/** Immutable store-keyed patches; an absent key means "do not change". */
export const PRESETS = Object.freeze({
    lite: makePreset('lite'),
    standard: makePreset('standard'),
    full: makePreset('full'),
});

const managers = {
    merged_world_tracker: { getSettings: getGlobalSettings, saveSettings: saveGlobalSettings },
    mwt_world_state: worldState,
    mwt_chronicle: chronicle,
    mwt_knowledge: knowledge,
    mwt_story_planner: storyPlanner,
    mwt_interiority: interiority,
};

/**
 * Patch global defaults only. Explicit per-chat overrides keep precedence.
 *
 * @param {'lite'|'standard'|'full'} name
 * @returns {boolean} true when all six stores saved; false on a save failure.
 *   Saves are not transactional: earlier stores may already have persisted.
 *   Reapplying is safe and can complete a partially saved preset.
 * @throws {RangeError} for an unknown name, before reading/writing any store.
 */
export function applyPreset(name) {
    if (!Object.hasOwn(PRESETS, name)) {
        throw new RangeError(`Unknown onboarding preset: ${String(name)}`);
    }

    for (const [store, patch] of Object.entries(PRESETS[name])) {
        const manager = managers[store];
        if (!manager.saveSettings({ ...manager.getSettings(), ...patch })) return false;
    }

    record({
        level: 'info',
        module: 'onboarding',
        event: 'preset_applied',
        detail: `level applied: ${name}`,
    });
    return true;
}