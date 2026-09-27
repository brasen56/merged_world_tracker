/**
 * test/chronicle_module2_review.test.js — Module 2 (Chronicle) review
 * findings (docs/TODO.md §0).
 *
 * The co-author's review asserted the chat-switch races as defects (M2-01,
 * M2-04, M2-05); per the §0 probe-test convention this file is the converted
 * regression pin of the FIXED contracts: every Chronicle await that can
 * outlive a chat switch re-asserts scope before touching store or UI state,
 * and only the owning operation (same scope) releases its busy flag.
 *
 * The mid-flight switch is simulated with bumpEpoch() — the same
 * invalidation the root CHAT_CHANGED handler performs — because the
 * metadata-swap window (ST swaps chat_metadata before emitting
 * CHAT_CHANGED) is the only window a user can actually reach.
 *
 * Harness conventions mirror test/chronicle_window_coverage.test.js
 * (stub-core + fake chat + real scope guards).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    resetCoreStubs, setFakeChat, setFakeApi, getFakeNotifications,
} from './stubs/core.js';
import { _resetEpoch, bumpEpoch } from '../core/scope.js';

const CHRONICLE_ENTRY = [
    '## Summary',
    '- The troupe crosses the river at dusk.',
    '',
    '## Time Anchor',
    'In-world date and time at end of this period: 2026-01-01 10:00',
    'Location at end of this period: The ferry landing',
].join('\n');

const CHAT = [
    { id: 'm0', name: 'Mara', mes: 'An opening scene.' },
    { id: 'm1', name: 'Mara', mes: 'The second scene.' },
    { id: 'm2', name: 'User', is_user: true, mes: 'A question.' },
    { id: 'm3', name: 'Mara', mes: 'A reply.' },
];

describe('Module 2 review — chat-switch discards (M2-01/M2-04/M2-05)', () => {
    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        // core/scope.js reads globalThis.SillyTavern directly (not the stub
        // context), so the chat id has to be seeded here for the scope guards.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(CHAT);
        const { state, _render } = await import('../chronicle/data.js');
        state.isGenerating = false;
        state.isMainGenerating = false;
        state.msgSinceSnapshot = 0;
        state.autoSnapshotRetryAt = 0;
        state.countedReceiptEvents = new Map();
        _render.renderContent = vi.fn();
        _render.showRegenerateDiff = null;
        _render.showConsolidationPreview = null;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.document;
    });

    test('generation discards a result that settles after the chat changed', async () => {
        const { state, saveSettings, setChronicleData, getSnapshots } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setChronicleData({ snapshots: [] });
        let release;
        setFakeApi(() => new Promise(resolve => { release = resolve; }));

        const work = generateSnapshot();
        bumpEpoch(); // the chat changed while the request was in flight
        release(CHRONICLE_ENTRY);
        await expect(work).resolves.toBe(null);

        // Nothing was committed to the (now current) chat's store.
        expect(getSnapshots()).toHaveLength(0);
        // M2-05: only the owning scope may release the busy flag — the
        // incoming chat's onChatChanged() owns the reset, not the stale job.
        expect(state.isGenerating).toBe(true);
    });

    test('regeneration discards at the preview-accept callback after a chat switch', async () => {
        const { state, saveSettings, setChronicleData, getSnapshots, makeAnchor, _render } = await import('../chronicle/data.js');
        const { regenerateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setChronicleData({
            snapshots: [{
                id: 's1', createdAt: '2026-01-01T00:00:00.000Z', text: 'original text',
                fromIndex: 0, toIndex: 1, anchor: makeAnchor(CHAT[1]),
            }],
            lastAnchor: makeAnchor(CHAT[1]),
        });
        let onChoice;
        _render.showRegenerateDiff = (_oldText, _newText, cb) => { onChoice = cb; };
        setFakeApi(async () => CHRONICLE_ENTRY);

        await regenerateSnapshot('s1'); // transport resolves, diff preview shown
        bumpEpoch(); // the chat changed while the diff was open
        await onChoice(true);

        // The diff preview outlives the call, so the accept callback owns its
        // own scope check — a switch during the decision must not commit.
        expect(getSnapshots()[0].text).toBe('original text');
        expect(state._lastStatusMsg).toContain('discarded');
    });

    test('consolidation discards at the preview-confirm callback after a chat switch', async () => {
        const { state, saveSettings, setChronicleData, getSnapshots, _render } = await import('../chronicle/data.js');
        const { consolidateEntries } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setChronicleData({
            snapshots: [
                { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', text: 'first entry', fromIndex: 0, toIndex: 1 },
                { id: 'b', createdAt: '2026-01-02T00:00:00.000Z', text: 'second entry', fromIndex: 2, toIndex: 3 },
            ],
        });
        let onConfirm;
        _render.showConsolidationPreview = (_entries, _prompt, cb) => { onConfirm = cb; };
        const requests = [];
        setFakeApi(async request => { requests.push(request); return CHRONICLE_ENTRY; });

        await consolidateEntries(['a', 'b']); // preview shown, no transport yet
        bumpEpoch(); // the chat changed while the preview was open
        await onConfirm('');

        // Refused at the callback's scope check — the transport never ran.
        expect(requests).toHaveLength(0);
        expect(getSnapshots().map(s => s.id)).toEqual(['a', 'b']);
        expect(state._lastStatusMsg).toContain('Chat changed during consolidation');
    });

    test('the auto-snapshot wrapper writes neither the retry gate nor a success toast after a chat switch', async () => {
        const { state, saveSettings, setChronicleData, getSnapshots } = await import('../chronicle/data.js');
        const { onMessageReceived } = await import('../chronicle/index.js');
        saveSettings({
            autoSnapshot: true, autoSnapshotThreshold: 1,
            apiUrl: 'https://example.test', modelName: 'test-model',
        });
        setChronicleData({ snapshots: [] });
        let release;
        setFakeApi(() => new Promise(resolve => { release = resolve; }));
        const notificationsBefore = getFakeNotifications().length;

        const work = onMessageReceived({ messageIndex: 0 }); // counter 1 ≥ threshold 1
        bumpEpoch(); // the chat changed while the auto-snapshot was in flight
        release(CHRONICLE_ENTRY);
        await work;

        // CHRONICLE-02: the wrapper must not update the incoming chat's retry
        // gate or announce success for the outgoing chat.
        expect(state.autoSnapshotRetryAt).toBe(0);
        expect(getSnapshots()).toHaveLength(0);
        expect(getFakeNotifications().slice(notificationsBefore)
            .some(n => n.message.includes('ready to review'))).toBe(false);
    });
});
