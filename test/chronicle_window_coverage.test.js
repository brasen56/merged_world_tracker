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
    });

    // ─── Bug 1: oversized message is split, not silently truncated ────────────

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
});
