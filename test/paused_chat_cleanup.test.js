/**
 * test/paused_chat_cleanup.test.js — Part 6 (§7.4/§5.4): the paused half of
 * CHAT_CHANGED.
 *
 * index.js does not run a paused module's onChatChanged() — it would restore
 * counters and bookkeeping from the BLOCKED store value and hold them stale in
 * memory until an out-of-band repair + Retry. But skipping the handler
 * ENTIRELY also skipped its scope-INDEPENDENT cleanup: the previous chat's
 * injection stayed registered in the blocked chat, pending timers kept
 * running, and Interiority's old thought blocks stayed in the DOM. Each
 * module's onChatChangedWhilePaused() owns exactly that safe half — and must
 * do it WITHOUT one read or write of the blocked store (the counter restores
 * and persists the full handler performs are observable in chat metadata, so
 * their absence is asserted here too).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    pauseStore,
    _setScopeKeyResolver,
    _resetPausedStores,
} from '../core/schema_status.js';
import { _resetDiagnostics, getInjectedSnapshot } from '../core/diagnostics.js';
import { _resetEpoch } from '../core/scope.js';

import * as WorldState from '../world_state/index.js';
import { state as wsState, setWorldStateData, CHAT_DATA_KEY as WS_KEY } from '../world_state/data.js';
import * as Chronicle from '../chronicle/index.js';
import { state as chronicleState, CHRONICLE_KEY } from '../chronicle/data.js';
import { applyInjection as applyChronicleInjection } from '../chronicle/injection.js';
import * as StoryPlanner from '../story_planner/index.js';
import { state as spState, CHAT_DATA_KEY as SP_KEY } from '../story_planner/data.js';
import { applyPlanInjection } from '../story_planner/injection.js';
import { state as ktState, COUNTERS_META_KEY } from '../knowledge/state.js';
import * as Interiority from '../interiority/index.js';
import { state as inState } from '../interiority/data.js';

import { resetCoreStubs, setFakeChat, setFakeContextExtras, getFakeMeta } from './stubs/core.js';

// Knowledge's barrel is imported dynamically (same rule
// scan_and_accept_fail_closed.test.js follows): its import graph is the
// widest of the five modules, and the dynamic import keeps this file's
// failure surface on the cleanup paths, not on barrel load order.
const Knowledge = await import('../knowledge/index.js');

// ─── Shared harness ───────────────────────────────────────────────────────────

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _resetDiagnostics();
    _resetPausedStores();
    _setScopeKeyResolver(() => 'chat:paused-cleanup');
    globalThis.document = {
        dispatchEvent: vi.fn(),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
    setFakeChat([{ mes: 'hi', name: 'Mara', is_user: false, extra: {}, send_date: '2026-01-01T00:00:00.000Z' }]);
    // The stub's applyExtensionPromptInjection records a diagnostics snapshot
    // only when the fake context carries setExtensionPrompt (parity with the
    // real core/injection.js, which records nothing without ST available).
    setFakeContextExtras({ setExtensionPrompt: () => {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    _resetPausedStores();
    _setScopeKeyResolver(null);
});

// ─── World State ──────────────────────────────────────────────────────────────

describe('WorldState.onChatChangedWhilePaused', () => {
    test('clears the stale injection, cancels timers, and persists nothing', () => {
        // A healthy previous chat had an injection registered…
        setWorldStateData({ text: '## Current Scene\nThe market smells of rain.' });
        WorldState.applyWorldStateInjection();
        expect(getInjectedSnapshot('mwt_world_state_injection')?.enabled).toBe(true);

        // …plus pending timers from that chat.
        wsState.autoRefreshDeferTimer = setTimeout(() => {}, 10000);
        wsState.editorPersistTimer = setTimeout(() => {}, 10000);
        wsState.editSessionActive = true;
        wsState.isDirty = true;

        pauseStore('worldState', { reasonCode: 'future-version', message: 'blocked' });
        WorldState.onChatChangedWhilePaused();

        // The previous chat's injection no longer rides along…
        expect(getInjectedSnapshot('mwt_world_state_injection')).toMatchObject({ enabled: false, payload: '' });
        // …its timers are cancelled and the flags reset…
        expect(wsState.autoRefreshDeferTimer).toBeNull();
        expect(wsState.editorPersistTimer).toBeNull();
        expect(wsState.editSessionActive).toBe(false);
        expect(wsState.isDirty).toBe(false);
        // …and the blocked store was neither read for hydration nor persisted
        // (the full handler would have written autoRefreshCounter into it).
        expect(getFakeMeta()[WS_KEY].autoRefreshCounter).toBeUndefined();
    });
});

// ─── Chronicle ────────────────────────────────────────────────────────────────

describe('Chronicle.onChatChangedWhilePaused', () => {
    test('resets transient state, clears the injection, and restores no counters', () => {
        // A healthy previous chat had an injection registered…
        getFakeMeta()[CHRONICLE_KEY] = {
            injectEnabled: true, injectMode: 'recent', injectCount: 2,
            snapshots: [{ id: 's1', text: 's1', createdAt: '2026-01-01' }],
        };
        applyChronicleInjection();
        expect(getInjectedSnapshot('session_chronicle_injection')?.enabled).toBe(true);

        // …plus transient session state from that chat.
        chronicleState.selectedSnapshotId = 'abc';
        chronicleState.consolidateMode = true;
        chronicleState.consolidateBaseId = 'abc';
        chronicleState.bulkDeleteMode = true;
        chronicleState.checkedForMerge.add('abc');
        chronicleState.pendingSearch = 'market';
        chronicleState.msgSinceSnapshot = 7;

        pauseStore('chronicle', { reasonCode: 'future-version', message: 'blocked' });
        Chronicle.onChatChangedWhilePaused();

        expect(getInjectedSnapshot('session_chronicle_injection')).toMatchObject({ enabled: false, payload: '' });
        expect(chronicleState.selectedSnapshotId).toBeNull();
        expect(chronicleState.consolidateMode).toBe(false);
        expect(chronicleState.consolidateBaseId).toBeNull();
        expect(chronicleState.bulkDeleteMode).toBe(false);
        expect(chronicleState.checkedForMerge.size).toBe(0);
        expect(chronicleState.pendingSearch).toBe('');
        // The in-memory counter survives untouched (no hydration from the
        // blocked value) and nothing was persisted into the blocked store.
        expect(chronicleState.msgSinceSnapshot).toBe(7);
        expect(getFakeMeta()[CHRONICLE_KEY].msgSinceSnapshot).toBeUndefined();
    });
});

// ─── Story Planner ────────────────────────────────────────────────────────────

describe('StoryPlanner.onChatChangedWhilePaused', () => {
    test('cancels the auto-generate timer and clears the injection without counter work', () => {
        // A healthy previous chat had an injection registered…
        getFakeMeta()[SP_KEY] = { text: '## Immediate Hooks\n- [x] One arc title\n  body' };
        applyPlanInjection();
        expect(getInjectedSnapshot('mwt_story_plan_injection')?.enabled).toBe(true);

        // …plus a pending auto-generate timer from that chat.
        spState.autoTimer = setTimeout(() => {}, 10000);
        spState.autoCounter = 5;

        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'blocked' });
        StoryPlanner.onChatChangedWhilePaused();

        expect(spState.autoTimer).toBeNull();
        expect(getInjectedSnapshot('mwt_story_plan_injection')).toMatchObject({ enabled: false, payload: '' });
        // No hydration from / persist into the blocked store.
        expect(spState.autoCounter).toBe(5);
        expect(getFakeMeta()[SP_KEY].autoCounter).toBeUndefined();
    });
});

// ─── Knowledge ────────────────────────────────────────────────────────────────

describe('Knowledge.onChatChangedWhilePaused', () => {
    test('drops the previous chat\'s staging/UI state without counter hydration', () => {
        ktState.isRunning = true;
        ktState.stagingItems = [{ name: 'Mara' }];
        ktState.activeItemId = 'mara';
        ktState.activeSubTab = 'npcs';
        ktState._cachedTokenCount = 123;
        ktState.notificationEntries = { growth: [{}] };
        ktState.unreadGrowthEvidenceCount = 3;
        ktState.messageCounter = 9;

        pauseStore('knowledgeStore', { reasonCode: 'future-version', message: 'blocked' });
        Knowledge.onChatChangedWhilePaused();

        expect(ktState.isRunning).toBe(false);
        expect(ktState.stagingItems).toEqual([]);
        expect(ktState.activeItemId).toBeNull();
        expect(ktState.activeSubTab).toBe('staging');
        expect(ktState._cachedTokenCount).toBe(0);
        expect(ktState.notificationEntries).toEqual({});
        expect(ktState.unreadGrowthEvidenceCount).toBe(0);
        expect(globalThis.document.dispatchEvent).toHaveBeenCalled();
        // The in-memory counter survives untouched and the blocked counters
        // store was not written (the full handler restores + persists them).
        expect(ktState.messageCounter).toBe(9);
        expect(getFakeMeta()[COUNTERS_META_KEY]).toBeUndefined();
    });

    test('drops the previous chat\'s view AND growth modals (paused half)', () => {
        // The Growth modal is appended to document.body like the view modal
        // and otherwise survives the switch — displaying the previous chat's
        // evidence/profile, with still-live handlers that would save that old
        // profile or edit evidence against the new chat's stores.
        const viewModal = { remove: vi.fn() };
        const growthModal = { remove: vi.fn() };
        const querySelectorAll = vi.fn(() => [viewModal, growthModal]);
        globalThis.document = {
            dispatchEvent: vi.fn(),
            getElementById: () => null,
            querySelectorAll,
        };

        pauseStore('knowledgeStore', { reasonCode: 'future-version', message: 'blocked' });
        Knowledge.onChatChangedWhilePaused();

        expect(querySelectorAll).toHaveBeenCalledWith('#kt-view-modal, #kt-growth-modal, #kt-dossier-refresh-modal');
        expect(viewModal.remove).toHaveBeenCalled();
        expect(growthModal.remove).toHaveBeenCalled();
    });

    test('the FULL chat-change handler drops the growth modal too (unpaused destination chat)', async () => {
        // Same removal through onChatChanged() — the path that runs when the
        // destination chat is NOT paused, which is exactly where the stale
        // modal's handlers would fire against the new chat's stores.
        const viewModal = { remove: vi.fn() };
        const growthModal = { remove: vi.fn() };
        const querySelectorAll = vi.fn(() => [viewModal, growthModal]);
        globalThis.document = {
            dispatchEvent: vi.fn(),
            getElementById: () => null,
            querySelectorAll,
        };

        Knowledge.onChatChanged();

        expect(querySelectorAll).toHaveBeenCalledWith('#kt-view-modal, #kt-growth-modal, #kt-dossier-refresh-modal');
        expect(viewModal.remove).toHaveBeenCalled();
        expect(growthModal.remove).toHaveBeenCalled();
        // reloadStores() is fire-and-forget and fully guarded; let its tail
        // settle before the harness tears down.
        await new Promise((r) => setTimeout(r, 20));
    });
});

// ─── Interiority ──────────────────────────────────────────────────────────────

describe('Interiority.onChatChangedWhilePaused', () => {
    test('clears thought blocks and the injection without touching the blocked ledger', () => {
        const querySelectorAll = vi.fn(() => []);
        globalThis.document = {
            dispatchEvent: vi.fn(),
            getElementById: () => null,
            querySelectorAll,
        };
        inState.contentEl = { id: 'stale-content-el' };

        pauseStore('interiority', { reasonCode: 'per-message-legacy-pending', message: 'preparing' });
        Interiority.onChatChangedWhilePaused();

        // The previous chat's DOM thought blocks are cleared…
        expect(querySelectorAll).toHaveBeenCalledWith('.mwt-int-msg-thoughts');
        // …the stale content element is dropped…
        expect(inState.contentEl).toBeNull();
        // …and the applier's paused branch cleared the injection slot.
        expect(getInjectedSnapshot('mwt_interiority_injection')).toMatchObject({ enabled: false, payload: '' });
    });
});
