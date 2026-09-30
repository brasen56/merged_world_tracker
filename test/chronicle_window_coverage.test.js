/**
 * Chronicle coverage fixes — the three working-tree bugs in
 * archive/bug_reports/bugs_temp.md:
 *
 * 1. [P1] An oversized message was silently truncated: buildMessageWindow()
 *    kept the first 100k characters but generation anchored past the WHOLE
 *    message, so its remainder could never reach a later snapshot. The window
 *    now records a mid-message cut (toCharOffset) and the next generation
 *    resumes inside the message.
 * 2. [P1] Deleting the anchor skipped the next message: on an anchor miss,
 *    generation resumed at lastCovered + 1, but a deletion shifts the
 *    following message INTO lastCovered. It now resumes AT the boundary.
 * 3. [P2] A manual entry (toIndex: -1) last in the list restarted coverage at
 *    message zero on an anchor miss. The resume point is now taken from the
 *    newest snapshot with a REAL recorded range; with none, generation
 *    refuses instead of re-chronicling history.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
    resetCoreStubs, setFakeChat, setFakeApi,
} from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';

const CHRONICLE_ENTRY = [
    '## Summary',
    '- The troupe crosses the river at dusk.',
    '',
    '## Time Anchor',
    'In-world date and time at end of this period: 2026-01-01 10:00',
    'Location at end of this period: The ferry landing',
].join('\n');

describe('Chronicle coverage fixes — oversized messages, anchor deletion, manual entries', () => {
    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        // core/scope.js reads globalThis.SillyTavern directly (not the stub
        // context), so the chat id has to be seeded here for the scope guards.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        const { state } = await import('../chronicle/data.js');
        state.isGenerating = false;
        state.isMainGenerating = false;
        state.msgSinceSnapshot = 0;
        state.autoSnapshotRetryAt = 0;
    });

    // ─── Bug 1: oversized message is split, not silently truncated ────────────
    test('failed auto-snapshot preserves receipt cadence and backs off instead of resetting it', async () => {
        const { state, saveSettings, getChronicleData } = await import('../chronicle/data.js');
        const { onMessageReceived } = await import('../chronicle/index.js');
        saveSettings({ autoSnapshot: true, autoSnapshotThreshold: 1, apiUrl: 'https://example.test', modelName: 'test-model' });
        setFakeChat([
            { id: 'a', name: 'Mara', mes: 'An opening scene.' },
            { id: 'b', name: 'Mara', mes: 'Another scene.' },
            { id: 'c', name: 'User', is_user: true, mes: 'Continue.' },
            { id: 'd', name: 'Mara', mes: 'A pending reply.' },
        ]);
        let requests = 0;
        setFakeApi(() => { requests++; throw new Error('offline'); });
        await onMessageReceived({ messageIndex: 0 });
        expect(state.msgSinceSnapshot).toBe(1);
        expect(getChronicleData().msgSinceSnapshot).toBe(1);
        expect(state.countedReceiptEvents.size).toBe(1);
        expect(state.autoSnapshotRetryAt).toBe(2);
        const firstAttempts = requests;
        // A threshold of two lets the next receipt retry, but not a retry
        // loop against the same event before another message arrives.
        expect(firstAttempts).toBeGreaterThan(0);
        expect(requests).toBe(firstAttempts);
    });

    test('an oversized first message is cut mid-text and its remainder reaches the next window', async () => {
        const { buildMessageWindow } = await import('../chronicle/data.js');
        const big = 'A'.repeat(120000) + 'TAIL_MARKER_ZZZ' + 'B'.repeat(50);
        setFakeChat([{ id: 'm0', name: 'Mara', mes: big }, { id: 'm1', name: 'Mara', mes: 'after' }]);

        const first = buildMessageWindow(0, 1);
        expect(first.toIndex).toBe(0);
        expect(first.text.length).toBeLessThanOrEqual(100000);
        // The cut is recorded, and the unseen tail is behind it.
        expect(first.toCharOffset).toBeGreaterThan(0);
        expect(first.toCharOffset).toBeLessThan(big.length);
        expect(first.text).not.toContain('TAIL_MARKER_ZZZ');

        // Resuming INSIDE the message surfaces the remainder plus the next one.
        const second = buildMessageWindow(0, 1, first.toCharOffset);
        expect(second.text).toContain('TAIL_MARKER_ZZZ');
        expect(second.text).toContain('after');
        expect(second.toIndex).toBe(1);
        expect(second.toCharOffset).toBe(null);
    });

    test('a still-oversized remainder advances the cut instead of stalling', async () => {
        const { buildMessageWindow } = await import('../chronicle/data.js');
        setFakeChat([{ id: 'm0', name: 'Mara', mes: 'x'.repeat(250000) }, { id: 'm1', name: 'Mara', mes: 'after' }]);

        const first = buildMessageWindow(0, 1);
        expect(first.toIndex).toBe(0);
        expect(first.toCharOffset).toBeGreaterThan(0);

        const second = buildMessageWindow(0, 1, first.toCharOffset);
        expect(second.toIndex).toBe(0);
        expect(second.toCharOffset).toBeGreaterThan(first.toCharOffset);

        const third = buildMessageWindow(0, 1, second.toCharOffset);
        expect(third.toIndex).toBe(1);
        expect(third.toCharOffset).toBe(null);
        expect(third.text).toContain('after');
    });

    test('generation splits an oversized message across snapshots instead of dropping its tail', async () => {
        const { saveSettings, getSnapshots } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });

        const big = 'A'.repeat(120000) + 'TAIL_MARKER_ZZZ' + 'B'.repeat(50);
        setFakeChat([
            { id: 'm0', name: 'Mara', mes: big },
            { id: 'm1', name: 'Mara', mes: 'after' },
            { id: 'm2', name: 'User', is_user: true, mes: 'A user turn.' },
            { id: 'm3', name: 'Mara', mes: 'A reply.' },
        ]);

        const requests = [];
        setFakeApi(async (request) => { requests.push(request); return CHRONICLE_ENTRY; });

        await generateSnapshot();
        expect(requests[0].userContent).not.toContain('TAIL_MARKER_ZZZ');
        const partial = getSnapshots().at(-1);
        expect(partial.toIndex).toBe(0);
        expect(Number.isInteger(partial.toCharOffset)).toBe(true);
        expect(partial.toCharOffset).toBeGreaterThan(0);

        // The second generation must resume INSIDE the oversized message.
        await generateSnapshot();
        expect(requests[1].userContent).toContain('TAIL_MARKER_ZZZ');
        const completed = getSnapshots().at(-1);
        expect(completed.toIndex).toBe(1);
        expect(completed.toCharOffset).toBeUndefined();
    });

    test('a preloaded uncounted tail does not consume the only counted receipt', async () => {
        const { saveSettings, state, getChronicleData } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setFakeChat([
            { id: 'counted', name: 'Mara', mes: 'The recorded scene.' },
            { id: 'uncounted', name: 'Mara', mes: 'The uncounted tail.' },
            { id: 'user', name: 'User', is_user: true, mes: 'Question.' },
            { id: 'reply', name: 'Mara', mes: 'The latest reply.' },
        ]);
        state.msgSinceSnapshot = 1;
        state.countedReceiptEvents = new Map([['id:counted', 1]]);
        setFakeApi(async () => CHRONICLE_ENTRY);
        const snapshot = await generateSnapshot();
        expect(snapshot.toIndex).toBe(1);
        expect(state.msgSinceSnapshot).toBe(0);
        expect(getChronicleData().msgSinceSnapshot).toBe(0);
        expect(state.countedReceiptEvents.size).toBe(0);
    });

    test('a repeated counted receipt on one excluded tail message keeps every event', async () => {
        const { saveSettings, state, getChronicleData } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setFakeChat([
            { id: 'covered', name: 'Mara', mes: 'Covered scene.' },
            { id: 'user', name: 'User', is_user: true, mes: 'Question.' },
            { id: 'tail', name: 'Mara', mes: 'Uncovered reply.' },
        ]);
        state.msgSinceSnapshot = 4;
        state.countedReceiptEvents = new Map([['id:covered', 1], ['id:tail', 3]]);
        setFakeApi(async () => CHRONICLE_ENTRY);
        const snapshot = await generateSnapshot();
        expect(snapshot.toIndex).toBe(0);
        expect(state.msgSinceSnapshot).toBe(3);
        expect(getChronicleData().msgSinceSnapshot).toBe(3);
        expect(state.countedReceiptEvents).toEqual(new Map([['id:tail', 3]]));
    });

    test('deleting an uncounted row preserves cadence; deleting a counted row reverses its events', async () => {
        const { state, getChronicleData } = await import('../chronicle/data.js');
        const { onMessageDeleted } = await import('../chronicle/index.js');
        const counted = { id: 'counted', name: 'Mara', mes: 'Counted.' };
        const uncounted = { id: 'uncounted', name: 'Mara', mes: 'Preloaded.' };
        setFakeChat([counted, uncounted]);
        state.lastChatLength = 2;
        state.msgSinceSnapshot = 2;
        state.countedReceiptEvents = new Map([['id:counted', 2]]);
        setFakeChat([counted]);
        onMessageDeleted(1);
        expect(state.msgSinceSnapshot).toBe(2);
        expect(getChronicleData().countedReceiptEvents).toEqual([['id:counted', 2]]);
        setFakeChat([]);
        onMessageDeleted(0);
        expect(state.msgSinceSnapshot).toBe(0);
        expect(getChronicleData().countedReceiptEvents).toEqual([]);
    });

    test('a counted deletion during generation does not subtract a later arrival twice', async () => {
        const { saveSettings, state } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        const { onMessageDeleted } = await import('../chronicle/index.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        const covered = { id: 'covered', name: 'Mara', mes: 'Old scene.' };
        const user = { id: 'user', name: 'User', is_user: true, mes: 'Question.' };
        const removed = { id: 'removed', name: 'Mara', mes: 'Will be deleted.' };
        const tail = { id: 'tail', name: 'Mara', mes: 'New reply.' };
        setFakeChat([covered, user, removed]);
        state.lastChatLength = 3;
        state.msgSinceSnapshot = 2;
        state.countedReceiptEvents = new Map([['id:covered', 1], ['id:removed', 1]]);
        let release;
        setFakeApi(() => new Promise(resolve => { release = resolve; }));
        const pending = generateSnapshot();
        await Promise.resolve();
        setFakeChat([covered, user]);
        onMessageDeleted(2);
        setFakeChat([covered, user, tail]);
        state.msgSinceSnapshot++;
        state.countedReceiptEvents.set('id:tail', 1);
        release(CHRONICLE_ENTRY);
        await pending;
        expect(state.msgSinceSnapshot).toBe(1);
        expect(state.countedReceiptEvents).toEqual(new Map([['id:tail', 1]]));
    });

    // ─── Bug 2: deleting the anchor must not skip the next message ────────────

    test('a deleted anchor resumes AT the recorded boundary, not past the shifted-in message', async () => {
        const { saveSettings, setChronicleData, getChronicleData, getSnapshots, makeAnchor } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });

        const original = [
            { id: 'm0', name: 'Mara', mes: 'The first scene.' },
            { id: 'm1', name: 'Mara', mes: 'The boundary scene.' },
            { id: 'm2', name: 'Mara', mes: 'The next scene.' },
            { id: 'm3', name: 'Mara', mes: 'Filler one.' },
            { id: 'm4', name: 'Mara', mes: 'Filler two.' },
        ];
        setFakeChat(original);
        const anchor = makeAnchor(original[1]);
        setChronicleData({
            snapshots: [{ id: 's1', createdAt: '2026-01-01T00:00:00.000Z', text: '## Summary\n- Prior coverage.', fromIndex: 0, toIndex: 1, anchor }],
            lastAnchor: anchor,
        });

        // The anchored message is deleted; the former m2 shifts into index 1.
        setFakeChat([original[0], original[2], original[3], original[4]]);

        const requests = [];
        setFakeApi(async (request) => { requests.push(request); return CHRONICLE_ENTRY; });

        const snapshot = await generateSnapshot();
        expect(snapshot).not.toBeNull();
        // The shifted-in message must be chronicled, not skipped forever.
        expect(requests[0].userContent).toContain('The next scene.');
        expect(snapshot.fromIndex).toBe(1);
        expect(getChronicleData().anchorStale).toBe(true);
        expect(getSnapshots().at(-1).id).toBe(snapshot.id);
    });

    // ─── Bug 3: a manual entry must not restart coverage at message zero ─────

    test('a manual entry last in the list cannot restart coverage at message zero', async () => {
        const { saveSettings, setChronicleData, makeAnchor } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });

        const original = [
            { id: 'm0', name: 'Mara', mes: 'The first scene.' },
            { id: 'm1', name: 'Mara', mes: 'The boundary scene.' },
            { id: 'm2', name: 'Mara', mes: 'The next scene.' },
            { id: 'm3', name: 'Mara', mes: 'Filler one.' },
            { id: 'm4', name: 'Mara', mes: 'Filler two.' },
        ];
        setFakeChat(original);
        const anchor = makeAnchor(original[1]);
        setChronicleData({
            snapshots: [
                { id: 's1', createdAt: '2026-01-01T00:00:00.000Z', text: '## Summary\n- Prior coverage.', fromIndex: 0, toIndex: 1, anchor },
                { id: 'man', createdAt: '2026-01-02T00:00:00.000Z', text: '## Summary\n- Manual note.', fromIndex: -1, toIndex: -1, manual: true },
            ],
            lastAnchor: anchor,
        });

        setFakeChat([original[0], original[2], original[3], original[4]]);

        const requests = [];
        setFakeApi(async (request) => { requests.push(request); return CHRONICLE_ENTRY; });

        const snapshot = await generateSnapshot();
        expect(snapshot).not.toBeNull();
        // Resume from the newest REAL range (s1: toIndex 1), not the manual
        // entry's -1 — so already-covered history is not re-chronicled.
        expect(snapshot.fromIndex).toBe(1);
        expect(requests[0].userContent).toContain('The next scene.');
        expect(requests[0].userContent).not.toContain('The first scene.');
    });

    test('an anchor miss with only manual entries refuses instead of re-chronicling from zero', async () => {
        const { saveSettings, setChronicleData, getChronicleData, makeAnchor } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });

        const original = [
            { id: 'm0', name: 'Mara', mes: 'The first scene.' },
            { id: 'm1', name: 'Mara', mes: 'The boundary scene.' },
            { id: 'm2', name: 'Mara', mes: 'The next scene.' },
        ];
        setFakeChat(original);
        const anchor = makeAnchor(original[1]);
        setChronicleData({
            snapshots: [
                { id: 'man', createdAt: '2026-01-02T00:00:00.000Z', text: '## Summary\n- Manual note.', fromIndex: -1, toIndex: -1, manual: true },
            ],
            lastAnchor: anchor,
        });

        setFakeChat([original[0], original[2]]);
        const requests = [];
        setFakeApi(async (request) => { requests.push(request); return CHRONICLE_ENTRY; });

        await expect(generateSnapshot()).resolves.toBe(null);
        expect(requests).toHaveLength(0);
        expect(getChronicleData().anchorStale).toBe(true);
    });

    // ─── Condensed chats: indices shift, send times do not ───────────────────

    test('a condensed chat shorter than the recorded boundary resumes by the entry time instead of refusing forever', async () => {
        const { saveSettings, setChronicleData, getChronicleData } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        // An anchor from before anchors recorded a send time. ILS condensed
        // its boundary message (index 187) into a summary, leaving a chat far
        // shorter than that index: resuming AT it refused with "No new
        // messages to chronicle" on every attempt.
        const anchor = { id: null, msgIndex: 187, name: 'Mara', start: 'The condensed boundary.', end: 'The condensed boundary.', length: 23 };
        setChronicleData({
            snapshots: [{ id: 's1', createdAt: '2026-09-29T23:36:00.000Z', text: '## Summary\n- Prior coverage.', fromIndex: 129, toIndex: 187, anchor }],
            lastAnchor: anchor,
        });
        setFakeChat([
            { name: 'Summary', mes: 'Summary of the early chapters.', send_date: '2026-09-27T17:56:00.000Z' },
            { name: 'Summary', mes: 'Summary of the middle chapters.', send_date: '2026-09-27T17:09:00.000Z' },
            // Written after the entry: it may hold messages the entry never saw.
            { name: 'Summary', mes: 'Summary of the latest morning.', send_date: '2026-09-30T01:25:00.000Z' },
            { name: 'Mara', mes: 'The first new reply.', send_date: '2026-09-30T00:26:00.000Z' },
            { name: 'User', is_user: true, mes: 'A new question.', send_date: '2026-09-30T00:30:00.000Z' },
            { name: 'Mara', mes: 'The second new reply.', send_date: '2026-09-30T00:35:00.000Z' },
            { name: 'User', is_user: true, mes: 'Another question.', send_date: '2026-09-30T00:40:00.000Z' },
            { name: 'Mara', mes: 'The in-flight reply.', send_date: '2026-09-30T00:45:00.000Z' },
        ]);
        const requests = [];
        setFakeApi(async (request) => { requests.push(request); return CHRONICLE_ENTRY; });

        const snapshot = await generateSnapshot();
        expect(snapshot).not.toBeNull();
        expect(snapshot.fromIndex).toBe(2);
        expect(requests[0].userContent).toContain('Summary of the latest morning.');
        expect(requests[0].userContent).toContain('The first new reply.');
        expect(requests[0].userContent).toContain('The second new reply.');
        expect(requests[0].userContent).not.toContain('Summary of the early chapters.');
        expect(requests[0].userContent).not.toContain('Summary of the middle chapters.');
        expect(getChronicleData().anchorStale).toBe(true);
    });

    test('an anchor with a send time resumes by time when condensing shifted its old index', async () => {
        const { saveSettings, setChronicleData, makeAnchor } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        const at = hour => `2026-09-30T${String(hour).padStart(2, '0')}:00:00.000Z`;
        const original = [
            { name: 'Mara', mes: 'Scene one.', send_date: at(1) },
            { name: 'Mara', mes: 'Scene two.', send_date: at(2) },
            { name: 'Mara', mes: 'Scene three.', send_date: at(3) },
            { name: 'Mara', mes: 'The boundary scene.', send_date: at(4) },
            { name: 'Mara', mes: 'Uncovered one.', send_date: at(5) },
            { name: 'Mara', mes: 'Uncovered two.', send_date: at(6) },
            { name: 'Mara', mes: 'Uncovered three.', send_date: at(7) },
            { name: 'User', is_user: true, mes: 'Question.', send_date: at(8) },
            { name: 'Mara', mes: 'In flight.', send_date: at(9) },
        ];
        setFakeChat(original);
        const anchor = makeAnchor(original[3]);
        expect(anchor.sendDate).toBe(Date.parse(at(4)));
        setChronicleData({
            snapshots: [{ id: 's1', createdAt: at(5), text: '## Summary\n- Prior coverage.', fromIndex: 0, toIndex: 3, anchor }],
            lastAnchor: anchor,
        });
        // One summary replaces scenes one through four. The recorded index 3
        // is still inside the chat but now points at "Uncovered three." —
        // resuming there would skip the two replies before it forever.
        setFakeChat([{ name: 'Summary', mes: 'Summary of scenes one to four.', send_date: at(10) }, ...original.slice(4)]);
        const requests = [];
        setFakeApi(async (request) => { requests.push(request); return CHRONICLE_ENTRY; });

        const snapshot = await generateSnapshot();
        expect(snapshot).not.toBeNull();
        expect(snapshot.fromIndex).toBe(0);
        expect(requests[0].userContent).toContain('Uncovered one.');
        expect(requests[0].userContent).toContain('Uncovered two.');
        expect(requests[0].userContent).toContain('Uncovered three.');
    });

    test('counter increments with no receipt event behind them drain after a successful snapshot', async () => {
        const { saveSettings, state, getChronicleData } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setFakeChat([
            { id: 'covered', name: 'Mara', mes: 'Covered scene.' },
            { id: 'user', name: 'User', is_user: true, mes: 'Question.' },
            { id: 'tail', name: 'Mara', mes: 'Uncovered reply.' },
        ]);
        // Eleven of the thirteen increments have no event behind them. Only
        // events are ever consumed, so without the clamp the counter stayed
        // at 12 — a threshold of 12 — and every later reply re-fired.
        state.msgSinceSnapshot = 13;
        state.countedReceiptEvents = new Map([['id:covered', 1], ['id:tail', 1]]);
        setFakeApi(async () => CHRONICLE_ENTRY);
        const snapshot = await generateSnapshot();
        expect(snapshot.toIndex).toBe(0);
        expect(state.msgSinceSnapshot).toBe(1);
        expect(getChronicleData().msgSinceSnapshot).toBe(1);
        expect(state.countedReceiptEvents).toEqual(new Map([['id:tail', 1]]));
    });
});
