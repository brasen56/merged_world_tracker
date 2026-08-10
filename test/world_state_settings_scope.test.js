/**
 * test/world_state_settings_scope.test.js — Global-vs-per-chat setting scope.
 *
 * Mirrors the story-planner coverage in test/plan.test.js: World State's
 * injectEnabled/autoRefresh/autoRefreshInterval follow the same
 * global-defaults-with-optional-per-chat-override design.
 */

import { beforeEach, describe, test, expect } from 'vitest';
import {
    isInjectionEnabled, isAutoRefreshEnabled, getAutoRefreshInterval,
    usesGlobalDefaults, setUsesGlobalDefaults, setWorldSetting,
} from '../world_state/data.js';
import { resetCoreStubs, getFakeMeta, getFakeExtSettings } from './stubs/core.js';

describe('world state settings scope', () => {
    beforeEach(() => resetCoreStubs());

    test('new chats resolve global defaults', () => {
        getFakeExtSettings().mwt_world_state = { autoRefresh: true, autoRefreshInterval: 8 };
        expect(usesGlobalDefaults()).toBe(true);
        expect(isAutoRefreshEnabled()).toBe(true);
        expect(getAutoRefreshInterval()).toBe(8);
    });

    test('chat overrides remain isolated from global defaults', () => {
        getFakeExtSettings().mwt_world_state = { autoRefresh: false };
        setUsesGlobalDefaults(false);
        setWorldSetting('autoRefresh', true);
        setWorldSetting('autoRefreshInterval', 12);
        expect(isAutoRefreshEnabled()).toBe(true);
        expect(getAutoRefreshInterval()).toBe(12);
        expect(getFakeExtSettings().mwt_world_state.autoRefresh).toBe(false);
        expect(getFakeMeta().world_state_tracker_metadata.settingsOverride).toMatchObject({ autoRefresh: true, autoRefreshInterval: 12 });
    });

    test('legacy local records use historical defaults for missing keys', () => {
        getFakeExtSettings().mwt_world_state = { injectEnabled: false, autoRefreshInterval: 20 };
        getFakeMeta().world_state_tracker_metadata = { useGlobalDefaults: false, injectEnabled: false };
        expect(isInjectionEnabled()).toBe(false);
        expect(isAutoRefreshEnabled()).toBe(false);
        expect(getAutoRefreshInterval()).toBe(5);
    });

    test('re-entering local mode snapshots the current global value, not a stale one', () => {
        // A pre-existing chat left over from before this feature: it already
        // carries a per-chat injectEnabled from the old all-local-only storage.
        getFakeMeta().world_state_tracker_metadata = { injectEnabled: false };
        getFakeExtSettings().mwt_world_state = { injectEnabled: true };
        expect(usesGlobalDefaults()).toBe(false); // legacy heuristic
        expect(isInjectionEnabled()).toBe(false);

        // Switch the chat to global defaults, then let the global value change
        // (e.g. edited from the Settings tab, or by another chat).
        setUsesGlobalDefaults(true);
        expect(isInjectionEnabled()).toBe(true);
        getFakeExtSettings().mwt_world_state.injectEnabled = false;
        expect(isInjectionEnabled()).toBe(false);

        // Opt this chat back out of global defaults. The starting point must
        // be what was just in effect (false), not the old buried record.
        setUsesGlobalDefaults(false);
        expect(isInjectionEnabled()).toBe(false);

        // And the inverse: global currently true should carry over too.
        getFakeMeta().world_state_tracker_metadata = { injectEnabled: false };
        getFakeExtSettings().mwt_world_state = { injectEnabled: true };
        setUsesGlobalDefaults(true);
        setUsesGlobalDefaults(false);
        expect(isInjectionEnabled()).toBe(true);
    });
});
