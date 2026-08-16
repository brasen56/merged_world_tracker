/**
 * test/settings_provenance.test.js — Phase 4 diagnostics coverage.
 *
 * Design §I.4.6: the two precedence chains become introspectable —
 *  - resolveApiCall() (core/api.js) reports which of its 4 levels won
 *    (module profile → module custom → global profile → global custom);
 *  - getEffectiveWorldSetting() (world_state/data.js) and its Story Planner
 *    twin getEffectivePlanSetting() return { value, source } on request for
 *    the 3-level chain (per-chat override → legacy chat field → global).
 * Design §I.4.7: Interiority gains the getAutoStatus() accessor the other
 * four modules already expose.
 *
 * Provenance is the change most likely to be discovered late: the VALUE looks
 * correct while the user's mental model of WHERE it came from is wrong.
 */

import { beforeEach, describe, expect, test } from 'vitest';

// Real resolver — core/api.js is imported directly (not via the barrel), so it
// runs against the real precedence chain. `globalSettings` is passed
// explicitly to make every level deterministic.
import { resolveApiCall } from '../core/api.js';
import { resetCoreStubs, getFakeMeta, getFakeExtSettings } from './stubs/core.js';
import {
    getEffectiveWorldSetting, GLOBAL_SETTING_KEYS as WS_GLOBAL_SETTING_KEYS,
} from '../world_state/data.js';
import {
    getEffectivePlanSetting, GLOBAL_SETTING_KEYS as SP_GLOBAL_SETTING_KEYS,
} from '../story_planner/data.js';
import {
    saveSettings as saveInterioritySettings,
    incrementTurnCounter, addLedgerEntry,
} from '../interiority/data.js';

beforeEach(() => resetCoreStubs());

const CHAIN_SOURCES = /^(per-chat-override|per-chat-legacy|builtin-default|global|fallback)$/;

describe('resolveApiCall provenance (4-level chain)', () => {
    const globals = {
        connectionProfileId: 'global-profile',
        apiUrl: 'https://global.example/v1',
        apiKey: 'global-key',
        modelName: 'global-model',
        customHeaders: '',
    };

    test('level 1 — module Connection Profile wins over everything', () => {
        const r = resolveApiCall({
            moduleSettings: { connectionProfileId: 'module-profile', apiUrl: 'https://module.example', modelName: 'module-model' },
            globalSettings: globals,
        });
        expect(r.source).toBe('module-profile');
        expect(r.mode).toBe('cm');
        expect(r.settings.connectionProfileId).toBe('module-profile');
    });

    test('level 2 — module custom API beats the global profile', () => {
        const r = resolveApiCall({
            moduleSettings: { apiUrl: 'https://module.example', modelName: 'module-model', temperature: 0.7 },
            globalSettings: globals,
        });
        expect(r.source).toBe('module-custom');
        expect(r.mode).toBe('custom');
        expect(r.settings.apiUrl).toBe('https://module.example');
        expect(r.settings.temperature).toBe(0.7);
    });

    test('a partial module custom config (URL without model) does not win', () => {
        const r = resolveApiCall({
            moduleSettings: { apiUrl: 'https://module.example' },
            globalSettings: globals,
        });
        // Level 2 requires URL AND model — falls through to the global profile.
        expect(r.source).toBe('global-profile');
        expect(r.mode).toBe('cm');
        expect(r.settings.connectionProfileId).toBe('global-profile');
    });

    test('level 3 — global Connection Profile when the module is unconfigured', () => {
        const r = resolveApiCall({
            moduleSettings: { maxTokens: 1500 },
            globalSettings: globals,
        });
        expect(r.source).toBe('global-profile');
        expect(r.mode).toBe('cm');
        // Module generation params survive the merge.
        expect(r.settings.maxTokens).toBe(1500);
        expect(r.settings.connectionProfileId).toBe('global-profile');
    });

    test('level 4 — global custom API, generation params stay module-specific', () => {
        const r = resolveApiCall({
            moduleSettings: { maxTokens: 900, temperature: 0.2, customHeaders: '' },
            globalSettings: { ...globals, connectionProfileId: '' },
        });
        expect(r.source).toBe('global-custom');
        expect(r.mode).toBe('custom');
        expect(r.settings.apiUrl).toBe('https://global.example/v1');
        expect(r.settings.modelName).toBe('global-model');
        expect(r.settings.maxTokens).toBe(900);
        expect(r.settings.temperature).toBe(0.2);
    });

    test('existing return fields keep their shape (callers are unaffected)', () => {
        const r = resolveApiCall({
            moduleSettings: { apiUrl: 'https://module.example', modelName: 'module-model' },
            globalSettings: globals,
        });
        expect(r.mode).toBe('custom');
        expect(typeof r.fetchFn).toBe('function');
        expect(r.settings).toEqual({ apiUrl: 'https://module.example', modelName: 'module-model' });
    });
});

describe('getEffectiveWorldSetting provenance (World State 3-level chain)', () => {
    test('per-chat override wins and reports its source', () => {
        getFakeMeta().world_state_tracker_metadata = {
            useGlobalDefaults: false,
            settingsOverride: { autoRefreshInterval: 12 },
        };
        expect(getEffectiveWorldSetting('autoRefreshInterval', 5, { provenance: true }))
            .toEqual({ value: 12, source: 'per-chat-override' });
    });

    test('a legacy top-level chat field is labelled per-chat-legacy', () => {
        // Pre-scope-feature per-chat record: the field sits at the top level.
        getFakeMeta().world_state_tracker_metadata = { useGlobalDefaults: false, injectEnabled: false };
        expect(getEffectiveWorldSetting('injectEnabled', true, { provenance: true }))
            .toEqual({ value: false, source: 'per-chat-legacy' });
    });

    test('a local record missing the key falls to the historical default', () => {
        getFakeMeta().world_state_tracker_metadata = { useGlobalDefaults: false };
        expect(getEffectiveWorldSetting('autoRefreshInterval', 99, { provenance: true }))
            .toEqual({ value: 5, source: 'builtin-default' });
    });

    test('global mode resolves from module settings with source global', () => {
        getFakeExtSettings().mwt_world_state = { autoRefresh: true, autoRefreshInterval: 8 };
        expect(getEffectiveWorldSetting('autoRefresh', false, { provenance: true }))
            .toEqual({ value: true, source: 'global' });
    });

    test('a key absent everywhere reports the caller fallback', () => {
        expect(getEffectiveWorldSetting('notASetting', 'sentinel', { provenance: true }))
            .toEqual({ value: 'sentinel', source: 'fallback' });
    });

    test('without the provenance flag the bare value is returned (existing callers)', () => {
        getFakeExtSettings().mwt_world_state = { autoRefresh: true };
        expect(getEffectiveWorldSetting('autoRefresh', false)).toBe(true);

        getFakeMeta().world_state_tracker_metadata = { useGlobalDefaults: false, settingsOverride: { autoRefreshInterval: 12 } };
        expect(getEffectiveWorldSetting('autoRefreshInterval', 5)).toBe(12);
    });

    test('every GLOBAL_SETTING_KEYS entry resolves to a known source', () => {
        expect(WS_GLOBAL_SETTING_KEYS.length).toBeGreaterThan(0);
        for (const key of WS_GLOBAL_SETTING_KEYS) {
            const resolved = getEffectiveWorldSetting(key, undefined, { provenance: true });
            expect(resolved.source).toMatch(CHAIN_SOURCES);
            expect('value' in resolved).toBe(true);
        }
    });
});

describe('getEffectivePlanSetting provenance (Story Planner symmetry)', () => {
    test('per-chat override wins and reports its source', () => {
        getFakeMeta().story_planner_data = { useGlobalDefaults: false, settingsOverride: { arcCount: 18 } };
        expect(getEffectivePlanSetting('arcCount', 10, { provenance: true }))
            .toEqual({ value: 18, source: 'per-chat-override' });
    });

    test('legacy top-level field, builtin default, and global all label correctly', () => {
        getFakeMeta().story_planner_data = { useGlobalDefaults: false, injectMode: 'pinned' };
        expect(getEffectivePlanSetting('injectMode', 'all', { provenance: true }))
            .toEqual({ value: 'pinned', source: 'per-chat-legacy' });

        getFakeMeta().story_planner_data = { useGlobalDefaults: false };
        expect(getEffectivePlanSetting('autoInterval', 99, { provenance: true }))
            .toEqual({ value: 10, source: 'builtin-default' });

        // Back to global mode (no plan data) — the module settings answer.
        getFakeMeta().story_planner_data = {};
        getFakeExtSettings().mwt_story_planner = { autoEnabled: true };
        expect(getEffectivePlanSetting('autoEnabled', false, { provenance: true }))
            .toEqual({ value: true, source: 'global' });
    });

    test('without the provenance flag the bare value is returned', () => {
        getFakeExtSettings().mwt_story_planner = { injectMode: 'pinned' };
        expect(getEffectivePlanSetting('injectMode', 'all')).toBe('pinned');
    });

    test('every GLOBAL_SETTING_KEYS entry resolves to a known source', () => {
        expect(SP_GLOBAL_SETTING_KEYS.length).toBeGreaterThan(0);
        for (const key of SP_GLOBAL_SETTING_KEYS) {
            const resolved = getEffectivePlanSetting(key, undefined, { provenance: true });
            expect(resolved.source).toMatch(CHAIN_SOURCES);
            expect('value' in resolved).toBe(true);
        }
    });
});

describe('Interiority getAutoStatus (§I.4.7 parity accessor)', () => {
    function addDormantEntry() {
        return addLedgerEntry({
            npc: 'Mara', action: 'visit the market', trigger: 'harvest festival',
            status: 'dormant', wakeHint: 'harvest festival',
        }, 'day 1', 0);
    }

    test('returns null when autoMode is off (null-when-disabled contract)', async () => {
        saveInterioritySettings({ autoMode: false });
        const { getAutoStatus } = await import('../interiority/index.js');
        expect(getAutoStatus()).toBeNull();
    });

    test('reports per-turn semantics and the dormant-poll schedule', async () => {
        const { getAutoStatus } = await import('../interiority/index.js');
        expect(getAutoStatus()).toEqual({
            perTurn: true,
            counter: 0,
            interval: 10,   // default dormantPollInterval
            dormantCount: 0,
            pollDue: false, // never due with no dormant entries
        });
    });

    test('counter tracks the turn counter within the poll cycle', async () => {
        incrementTurnCounter();
        incrementTurnCounter();
        incrementTurnCounter();
        const { getAutoStatus } = await import('../interiority/index.js');
        expect(getAutoStatus().counter).toBe(3);
    });

    test('pollDue goes true only on the due turn with dormant entries present', async () => {
        addDormantEntry();
        for (let i = 0; i < 9; i++) incrementTurnCounter();
        const { getAutoStatus } = await import('../interiority/index.js');
        const status = getAutoStatus();
        expect(status.dormantCount).toBe(1);
        expect(status.pollDue).toBe(true); // (9 + 1) % 10 === 0
        expect(status.counter).toBe(9);
    });

    test('honours a custom dormantPollInterval', async () => {
        saveInterioritySettings({ dormantPollInterval: 3 });
        incrementTurnCounter();
        incrementTurnCounter();
        addDormantEntry();
        const { getAutoStatus } = await import('../interiority/index.js');
        const status = getAutoStatus();
        expect(status.interval).toBe(3);
        expect(status.pollDue).toBe(true); // (2 + 1) % 3 === 0
    });
});
