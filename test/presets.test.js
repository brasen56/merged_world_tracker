/** Preset contract (§2.1) and real settings-manager persistence (§4). */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Keep the host-free barrel helpers, but exercise the REAL settings factory
// for all six stores (validation, legacy migration, and localStorage fallback).
vi.mock('../core/index.js', async () => ({
    ...await import('./stubs/core.js'),
    createSettingsManager: (await import('../core/settings.js')).createSettingsManager,
}));

import { PRESETS, applyPreset } from '../core/presets.js';
import { _resetReportedSettingsIssues } from '../core/settings.js';
import { SETTINGS_SCHEMA_VERSION } from '../core/settings_schema.js';
import { getEvents } from '../core/diagnostics.js';
import { getFakeExtSettings, getFakeMeta, resetCoreStubs } from './stubs/core.js';
import { getEffectiveWorldSetting } from '../world_state/data.js';
import { getEffectivePlanSetting } from '../story_planner/data.js';

// Independent transcription of every row in the design table. null means —
// (must not appear in the patch), NOT a null setting value.
const TABLE = {
    merged_world_tracker: {
        enableWorldState: [true, true, true],
        enableChronicle: [true, true, true],
        enableKnowledge: [false, true, true],
        enableStoryPlanner: [false, true, true],
        enableInteriority: [false, true, true],
    },
    mwt_world_state: {
        detailLevel: ['minimal', 'standard', 'detailed'],
        autoRefresh: [false, false, true],
        autoRefreshInterval: [null, null, 5],
    },
    mwt_chronicle: {
        autoSnapshot: [false, false, true],
        autoSnapshotThreshold: [null, null, 40],
    },
    mwt_knowledge: {
        autoTriggerEnabled: [false, false, true],
        autoTriggerEveryN: [null, null, 5],
        npcAutoScanEnabled: [false, false, true],
        npcAutoScanEveryN: [null, null, 10],
        growthAutoCaptureEnabled: [false, false, true],
        growthAutoCaptureEveryN: [null, null, 15],
        growthAutoConsolidationEnabled: [false, false, true],
        growthAutoConsolidationThreshold: [null, null, 100],
        relationshipAutoExtractEnabled: [false, false, true],
        relationshipAutoExtractEveryN: [null, null, 10],
    },
    mwt_story_planner: { autoEnabled: [false, false, false] },
    mwt_interiority: { autoMode: [false, false, true] },
};
const NAMES = ['lite', 'standard', 'full'];
let storage;
let save;

beforeEach(() => {
    resetCoreStubs();
    _resetReportedSettingsIssues();
    storage = new Map();
    save = vi.fn();
    vi.stubGlobal('localStorage', {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
    });
    vi.stubGlobal('SillyTavern', {
        getContext: () => ({ extensionSettings: getFakeExtSettings(), saveSettingsDebounced: save }),
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('preset table and apply contract', () => {
    test.each(NAMES)('%s matches every §2.1 row, with no extra stores or keys', name => {
        const index = NAMES.indexOf(name);
        const expected = Object.fromEntries(Object.entries(TABLE).map(([store, rows]) => [
            store,
            Object.fromEntries(Object.entries(rows)
                .filter(([, values]) => values[index] !== null)
                .map(([key, values]) => [key, values[index]])),
        ]));
        expect(PRESETS[name]).toEqual(expected);
        expect(applyPreset(name)).toBe(true);
        for (const [store, patch] of Object.entries(expected)) {
            expect(getFakeExtSettings()[store]).toMatchObject({
                ...patch, schemaVersion: SETTINGS_SCHEMA_VERSION,
            });
        }
        expect(save).toHaveBeenCalledTimes(6);
        expect(storage.size).toBe(0);
        expect(getEvents()).toEqual([expect.objectContaining({
            level: 'info', module: 'onboarding', event: 'preset_applied',
            detail: `level applied: ${name}`,
        })]);
    });

    test('the entire exported table is immutable', () => {
        expect(Object.isFrozen(PRESETS)).toBe(true);
        for (const preset of Object.values(PRESETS)) {
            expect(Object.isFrozen(preset)).toBe(true);
            for (const patch of Object.values(preset)) expect(Object.isFrozen(patch)).toBe(true);
        }
    });

    test.each(NAMES)('%s preserves unrelated settings and all chat metadata', name => {
        const ext = getFakeExtSettings();
        for (const store of Object.keys(TABLE)) {
            ext[store] = { apiKey: 'secret', modelName: 'custom', customPrompt: 'keep', extra: { nested: true } };
        }
        ext.merged_world_tracker.enableLedger = false;
        ext.merged_world_tracker.injectionMasterOff = true;
        ext.mwt_world_state.deltaMode = true;
        ext.mwt_knowledge.activation = { chatSlot: ['keep'], global: [], charAux: {} };
        const meta = getFakeMeta();
        Object.assign(meta, {
            world_state_tracker_metadata: { useGlobalDefaults: false, settingsOverride: { autoRefresh: false } },
            story_planner_data: { useGlobalDefaults: false, settingsOverride: { autoEnabled: true } },
            session_chronicle_data: { injectEnabled: false, snapshots: [{ text: 'keep' }] },
            mwt_ambient: { enabled: false, setupAsked: false },
            mwt_interiority: { turnCounter: 7, ledger: [] },
        });
        const before = JSON.stringify(meta);
        expect(applyPreset(name)).toBe(true);
        for (const store of Object.keys(TABLE)) {
            expect(ext[store]).toMatchObject({ apiKey: 'secret', modelName: 'custom', customPrompt: 'keep', extra: { nested: true } });
        }
        expect(ext.merged_world_tracker).toMatchObject({ enableLedger: false, injectionMasterOff: true });
        expect(ext.mwt_world_state.deltaMode).toBe(true);
        expect(ext.mwt_knowledge.activation.chatSlot).toEqual(['keep']);
        expect(JSON.stringify(meta)).toBe(before);
        expect(ext).not.toHaveProperty('mwt_ambient');
        expect(ext.merged_world_tracker).not.toHaveProperty('onboardingVersion');
    });

    test.each(['lite', 'standard'])('%s preserves customized intervals omitted by the table', name => {
        for (const [store, rows] of Object.entries(TABLE)) {
            getFakeExtSettings()[store] = Object.fromEntries(Object.entries(rows)
                .filter(([, values]) => values[0] === null).map(([key]) => [key, 73]));
        }
        expect(applyPreset(name)).toBe(true);
        for (const [store, rows] of Object.entries(TABLE)) {
            for (const [key, values] of Object.entries(rows)) {
                if (values[0] === null) expect(getFakeExtSettings()[store][key]).toBe(73);
            }
        }
    });

    test('preset transitions reset flags, Full restores intervals, and reapply is idempotent', () => {
        applyPreset('full');
        applyPreset('lite');
        expect(getFakeExtSettings().mwt_knowledge.autoTriggerEnabled).toBe(false);
        expect(getFakeExtSettings().mwt_interiority.autoMode).toBe(false);
        applyPreset('standard');
        expect(getFakeExtSettings().merged_world_tracker.enableKnowledge).toBe(true);
        getFakeExtSettings().mwt_world_state.autoRefreshInterval = 73;
        getFakeExtSettings().mwt_story_planner.autoEnabled = true;
        applyPreset('full');
        expect(getFakeExtSettings().mwt_world_state.autoRefreshInterval).toBe(5);
        expect(getFakeExtSettings().mwt_story_planner.autoEnabled).toBe(false);
        const before = JSON.stringify(getFakeExtSettings());
        applyPreset('full');
        expect(JSON.stringify(getFakeExtSettings())).toBe(before);
    });

    test('effective per-chat overrides survive applying global defaults', () => {
        getFakeMeta().world_state_tracker_metadata = { useGlobalDefaults: false, settingsOverride: { autoRefresh: false } };
        getFakeMeta().story_planner_data = { useGlobalDefaults: false, settingsOverride: { autoEnabled: true } };
        applyPreset('full');
        expect(getEffectiveWorldSetting('autoRefresh', true, { provenance: true }))
            .toEqual({ value: false, source: 'per-chat-override' });
        expect(getEffectivePlanSetting('autoEnabled', false, { provenance: true }))
            .toEqual({ value: true, source: 'per-chat-override' });
    });

    test.each(['unknown', 'Full', '', '__proto__', 'constructor', null, undefined])('rejects %s before any writes', name => {
        expect(() => applyPreset(name)).toThrow(RangeError);
        expect(getFakeExtSettings()).toEqual({});
        expect(save).not.toHaveBeenCalled();
        expect(getEvents()).toEqual([]);
    });

    test('uses localStorage when the host is unavailable', () => {
        vi.stubGlobal('SillyTavern', undefined);
        expect(applyPreset('standard')).toBe(true);
        for (const [store, patch] of Object.entries(PRESETS.standard)) {
            expect(JSON.parse(storage.get(store))).toMatchObject(patch);
        }
        expect(save).not.toHaveBeenCalled();
    });

    test('migrates legacy settings without losing unrelated values', () => {
        for (const key of ['world_state_settings', 'session_chronicle_settings', 'knowledge_tracker_settings']) {
            storage.set(key, JSON.stringify({ apiKey: 'legacy-secret', modelName: 'legacy-model' }));
        }
        expect(applyPreset('lite')).toBe(true);
        for (const store of ['mwt_world_state', 'mwt_chronicle', 'mwt_knowledge']) {
            expect(getFakeExtSettings()[store]).toMatchObject({ apiKey: 'legacy-secret', modelName: 'legacy-model' });
        }
    });

    test('reports failed persistence without a success event', () => {
        vi.stubGlobal('SillyTavern', undefined);
        vi.stubGlobal('localStorage', {
            getItem: () => null,
            setItem: () => { throw new Error('quota exceeded'); },
        });
        expect(applyPreset('full')).toBe(false);
        expect(getEvents()).toEqual([]);
    });
});