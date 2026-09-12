/** Phase 2 Chronicle → World State synchronization boundary. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    captureRevision, captureScope, getFakeMeta, resetCoreStubs,
} from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { _resetPausedStores, pauseStore } from '../core/schema_status.js';
import { MINIMAL_SCENE } from './fixtures/world_state_phase0.js';
import { getWorldStateText, setWorldStateData, state } from '../world_state/data.js';
import { digestText, getDeltaStatus } from '../world_state/delta.js';
import {
    captureSceneAnchorBaseline, resetSceneAnchorSync, settleSceneAnchorSync, updateSceneAnchor,
} from '../world_state/scene.js';

function candidate(patch = {}) {
    return {
        dateTime: 'June 4, 2026 evening',
        location: 'Harbour office',
        source: 'generated',
        sourceId: 'newest',
        sourceRange: { from: 4, to: 7 },
        acceptedSources: [{ id: 'newest', range: { from: 4, to: 7 } }],
        scope: captureScope(),
        expectedRevision: captureRevision(getWorldStateText()),
        ...patch,
    };
}

describe('updateSceneAnchor', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        _resetPausedStores();
        resetSceneAnchorSync();
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'scene-sync-chat' }) };
        setWorldStateData({ text: MINIMAL_SCENE });
        state.wstIsRefreshing = false;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        state.wstIsRefreshing = false;
        resetSceneAnchorSync();
        _resetPausedStores();
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
    });

    test('commits a valid newest anchor while preserving a legacy document’s manual status', () => {
        const outcome = updateSceneAnchor(candidate({ dateTime: 'June 4, 2026 2pm' }));

        expect(outcome.status).toBe('applied');
        expect(getWorldStateText()).toContain('Date: June 4, 2026');
        expect(getWorldStateText()).toContain('Time: 2pm');
        const data = getFakeMeta().world_state_tracker_metadata;
        expect(data.autoSaveHistory.at(-1).text).toBe(MINIMAL_SCENE);
        expect(getDeltaStatus()).toMatchObject({ lastRefreshDigest: '', lastRefreshAtMsg: 0 });
    });

    test('preserves the refresh digest when the document has manual edits after a refresh', () => {
        const refreshed = {
            lastRefreshKind: 'full', lastRefreshAtMsg: 8, lastRefreshAt: 123,
            deltasSinceFull: 0, lastRefreshDigest: digestText(MINIMAL_SCENE),
        };
        const manuallyEdited = MINIMAL_SCENE.replace('waiting', 'quietly waiting');
        setWorldStateData({ text: manuallyEdited, deltaStatus: refreshed });

        expect(updateSceneAnchor(candidate({
            expectedRevision: captureRevision(manuallyEdited), dateTime: 'June 4, 2026 2pm',
            sourceRange: { from: 8, to: 9 }, acceptedSources: [{ id: 'newest', range: { from: 8, to: 9 } }],
        }))).toMatchObject({ status: 'applied' });

        expect(getFakeMeta().world_state_tracker_metadata.deltaStatus).toMatchObject(refreshed);
        expect(getWorldStateText()).toContain('quietly waiting');
    });

    test('permits legacy errors outside Current Scene and preserves refresh classification', () => {
        const legacy = `${MINIMAL_SCENE}\n\n## House Rules\n- Mara said, "we leave at dawn"`;
        const reconciled = {
            lastRefreshKind: 'full', lastRefreshAtMsg: 8, lastRefreshAt: 123,
            deltasSinceFull: 0, lastRefreshDigest: digestText(legacy),
        };
        setWorldStateData({ text: legacy, deltaStatus: reconciled });

        expect(updateSceneAnchor(candidate({
            expectedRevision: captureRevision(legacy), dateTime: 'June 4, 2026 2pm',
            sourceRange: { from: 8, to: 9 }, acceptedSources: [{ id: 'newest', range: { from: 8, to: 9 } }],
        }))).toMatchObject({ status: 'applied' });

        const status = getFakeMeta().world_state_tracker_metadata.deltaStatus;
        expect(status).toMatchObject({ ...reconciled, lastRefreshDigest: digestText(getWorldStateText()) });
        expect(getWorldStateText()).toContain('## House Rules');
    });

    test('updates an open editor without resetting its manual-edit session boundary', () => {
        const editor = { value: MINIMAL_SCENE };
        state.modal = { querySelector: vi.fn(() => editor) };
        state.editSessionActive = true;

        expect(updateSceneAnchor(candidate({ dateTime: 'June 4, 2026 2pm' })).status).toBe('applied');

        expect(editor.value).toBe(getWorldStateText());
        expect(state.editSessionActive).toBe(true);
        state.modal = null;
    });

    test('rejects missing ranges, old accepted ranges, old evidence, and paused stores', () => {
        expect(updateSceneAnchor(candidate({ sourceRange: null })).status).toBe('stale-source');
        expect(updateSceneAnchor(candidate({
            acceptedSources: [
                { id: 'newest', range: { from: 4, to: 7 } },
                { id: 'later', range: { from: 8, to: 9 } },
            ],
        })).status).toBe('stale-source');

        setWorldStateData({ deltaStatus: {
            lastRefreshKind: 'full', lastRefreshAtMsg: 8, lastRefreshAt: 1,
            deltasSinceFull: 0, lastRefreshDigest: digestText(MINIMAL_SCENE),
        } });
        expect(updateSceneAnchor(candidate()).reason).toBe('older-than-world-state-evidence');

        pauseStore('worldState', { reasonCode: 'test', message: 'test pause' });
        expect(updateSceneAnchor(candidate({ sourceRange: { from: 8, to: 9 } })).status).toBe('store-refused');
    });

    test('requires consolidation to include the previously newest range', () => {
        const outcome = updateSceneAnchor(candidate({
            source: 'consolidation',
            sourceRange: { from: 0, to: 3 },
            acceptedSources: [{ id: 'newest', range: { from: 0, to: 3 } }],
            previousNewestRange: { from: 4, to: 7 },
        }));
        expect(outcome).toMatchObject({ status: 'stale-source', reason: 'consolidation-does-not-include-previous-newest' });
    });

    test('preserves a compact location when Chronicle only adds description', () => {
        const outcome = updateSceneAnchor(candidate({
            dateTime: 'Unknown', location: 'The harbour office on Customs Row',
        }));
        expect(outcome.status).toBe('no-change');
        expect(getWorldStateText()).toContain('Location: Harbour office');
        expect(getWorldStateText()).toContain('Date: Unknown');
    });

    test('defers while busy and discards after a covering World State commit', () => {
        state.wstIsRefreshing = true;
        expect(updateSceneAnchor(candidate()).status).toBe('deferred');

        const refreshed = MINIMAL_SCENE.replace('Unknown', 'June 5, 2026');
        setWorldStateData({
            text: refreshed,
            deltaStatus: {
                lastRefreshKind: 'full', lastRefreshAtMsg: 8, lastRefreshAt: 2,
                deltasSinceFull: 0, lastRefreshDigest: digestText(refreshed),
            },
        });
        state.wstIsRefreshing = false;
        expect(settleSceneAnchorSync()).toMatchObject({
            status: 'stale-source', reason: 'older-than-world-state-evidence',
        });
        expect(getWorldStateText()).toBe(refreshed);
    });

    test('applies a deferred anchor newer than the completed refresh watermark', () => {
        state.wstIsRefreshing = true;
        expect(updateSceneAnchor(candidate({ sourceRange: { from: 8, to: 9 }, acceptedSources: [{ id: 'newest', range: { from: 8, to: 9 } }] }))).toMatchObject({ status: 'deferred' });

        const refreshed = MINIMAL_SCENE.replace('Unknown', 'June 5, 2026');
        setWorldStateData({
            text: refreshed,
            deltaStatus: {
                lastRefreshKind: 'full', lastRefreshAtMsg: 8, lastRefreshAt: 2,
                deltasSinceFull: 0, lastRefreshDigest: digestText(refreshed),
            },
        });
        state.wstIsRefreshing = false;

        expect(settleSceneAnchorSync()).toMatchObject({ status: 'applied' });
        expect(getWorldStateText()).toContain('Date: June 4, 2026');
        expect(getWorldStateText()).toContain('Time: Evening');
    });

    test('a deferred candidate cannot overwrite an intervening manual edit', () => {
        state.wstIsRefreshing = true;
        expect(updateSceneAnchor(candidate()).status).toBe('deferred');
        const edited = MINIMAL_SCENE.replace('waiting', 'quietly waiting');
        setWorldStateData({ text: edited });
        state.wstIsRefreshing = false;

        expect(settleSceneAnchorSync().status).toBe('user-edited');
        expect(getWorldStateText()).toBe(edited);
    });

    test('a deferred candidate cannot overwrite a manual edit persisted after a refresh', () => {
        state.wstIsRefreshing = true;
        expect(updateSceneAnchor(candidate({ sourceRange: { from: 8, to: 9 }, acceptedSources: [{ id: 'newest', range: { from: 8, to: 9 } }] })).status).toBe('deferred');
        const refreshed = MINIMAL_SCENE.replace('Unknown', 'June 5, 2026');
        setWorldStateData({
            text: refreshed,
            deltaStatus: {
                lastRefreshKind: 'full', lastRefreshAtMsg: 8, lastRefreshAt: 2,
                deltasSinceFull: 0, lastRefreshDigest: digestText(refreshed),
            },
        });
        const edited = refreshed.replace('waiting', 'quietly waiting');
        setWorldStateData({ text: edited });
        state.wstIsRefreshing = false;

        expect(settleSceneAnchorSync()).toMatchObject({ status: 'user-edited' });
        expect(getWorldStateText()).toBe(edited);
    });

    test('reports a World State refresh during a Chronicle preview as busy-superseded', () => {
        const expectedRevision = captureRevision(getWorldStateText());
        const baselineStatusSignature = captureSceneAnchorBaseline();
        const refreshed = MINIMAL_SCENE.replace('Unknown', 'June 5, 2026');
        setWorldStateData({
            text: refreshed,
            deltaStatus: {
                lastRefreshKind: 'full', lastRefreshAtMsg: 0, lastRefreshAt: 2,
                deltasSinceFull: 0, lastRefreshDigest: digestText(refreshed),
            },
        });

        expect(updateSceneAnchor(candidate({ expectedRevision, baselineStatusSignature }))).toMatchObject({
            status: 'busy-superseded', applied: false,
        });
        expect(getWorldStateText()).toBe(refreshed);
    });

    test('does not overwrite a dirty or debounce-pending editor session', () => {
        state.isDirty = true;
        expect(updateSceneAnchor(candidate()).status).toBe('user-edited');
        expect(getWorldStateText()).toBe(MINIMAL_SCENE);

        state.isDirty = false;
        state.editorPersistTimer = 1;
        expect(updateSceneAnchor(candidate()).status).toBe('user-edited');
        expect(getWorldStateText()).toBe(MINIMAL_SCENE);
        state.editorPersistTimer = null;
    });
});
