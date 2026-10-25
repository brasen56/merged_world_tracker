/**
 * test/chronicle_entry_gate.test.js — Chronicle's structural gate (tester
 * report, 2026-10-24).
 *
 * On gemma4:e4b and Llama 3.1 3B, a first pass returned story continuation.
 * validateSnapshotOutput() flagged it, but generation saved it anyway: the
 * warning was overwritten by "Chronicle entry generated.", the anchor moved
 * past messages that were never summarized, and the continuation was
 * injected as chronicle history — a string of accepted bad entries.
 *
 * Now: output that fails the STRUCTURAL contract (no leading "## Summary", or
 * fewer than two sections) gets one retry with a reminder; a second failure
 * saves nothing. The HEURISTIC checks still only flag an entry, and that flag
 * now survives into the final status.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getFakeMeta, resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { state, saveSettings, getSnapshots, getChronicleData, _render } from '../chronicle/data.js';
import { CHRONICLE_CLOSING } from '../chronicle/prompts.js';
import { generateSnapshot, regenerateSnapshot } from '../chronicle/snapshots.js';

const ENTRY = [
    '## Summary',
    '- The troupe crosses the river at dusk.',
    '',
    '## Time Anchor',
    'In-world date and time at end of this period: 2026-01-01 10:00',
    'Location at end of this period: The ferry landing',
].join('\n');

const CONTINUATION = [
    '*Mara pulls her cloak tighter as the ferry drifts from the landing.*',
    '"We should have waited for morning," she mutters, eyes on the dark water.',
].join('\n');

const SUMMARY_ONLY = '## Summary\n- The troupe crosses the river at dusk.';

const message = (i) => ({ id: `m${i}`, name: 'Mara', mes: `Scene ${i}: the troupe travels on.` });
const SETTLED_CHAT = [
    message(0), message(1),
    { id: 'u', name: 'User', is_user: true, mes: 'A user turn.' },
    { id: 'r', name: 'Mara', mes: 'A pending reply.' },
];

let chatId;
let requests;

/** Fake model that answers each request with the next scripted output. */
function scriptApi(...outputs) {
    setFakeApi(async (request) => {
        requests.push(request);
        return outputs[Math.min(requests.length, outputs.length) - 1];
    });
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    chatId = 'chat-A';
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => chatId }) };
    globalThis.document = { dispatchEvent: vi.fn() };
    requests = [];
    saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', syncWorldState: false });
    Object.assign(state, {
        isGenerating: false, isMainGenerating: false,
        msgSinceSnapshot: 0, autoSnapshotRetryAt: 0, selectedSnapshotId: null,
        _lastStatusMsg: '', _lastStatusLevel: '',
    });
    _render.renderContent = vi.fn();
    _render.showRegenerateDiff = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setFakeChat(SETTLED_CHAT);
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.SillyTavern;
    delete globalThis.document;
});

describe('generate: structural failures are retried once, then refused', () => {
    test('a story continuation is retried with a reminder and the real entry is saved', async () => {
        scriptApi(CONTINUATION, ENTRY);

        const snapshot = await generateSnapshot();

        expect(requests).toHaveLength(2);
        const retry = requests[1].userContent;
        expect(retry.startsWith(requests[0].userContent)).toBe(true);
        expect(retry.indexOf(CHRONICLE_CLOSING)).toBeLessThan(retry.indexOf('[REMINDER:'));
        expect(retry).toMatch(/not a chronicle entry\. Output does not start with "## Summary"\./);
        expect(retry).toMatch(/Do not continue the roleplay\.\]$/);
        expect(snapshot?.text).toBe(ENTRY);
        expect(getSnapshots()).toHaveLength(1);
        expect(state._lastStatusLevel).toBe('success');
    });

    test('a second continuation saves nothing and leaves the anchor where it was', async () => {
        scriptApi(CONTINUATION, CONTINUATION);

        const snapshot = await generateSnapshot();

        expect(snapshot).toBeNull();
        expect(requests).toHaveLength(2);
        expect(getSnapshots()).toHaveLength(0);
        expect(getChronicleData().lastAnchor ?? null).toBeNull();
        expect(state._lastStatusLevel).toBe('error');
        expect(state._lastStatusMsg).toMatch(/did not return a chronicle entry \(Output does not start with "## Summary"\)\. Nothing was saved\./);
        expect(state.isGenerating).toBe(false);

        // The same messages are still uncovered, so the next run picks them up.
        scriptApi(ENTRY);
        requests = [];
        expect(await generateSnapshot()).toMatchObject({ fromIndex: 0, toIndex: 1 });
    });

    test('a "## Summary" with no second section counts as structural', async () => {
        scriptApi(SUMMARY_ONLY, ENTRY);

        await generateSnapshot();

        expect(requests).toHaveLength(2);
        expect(requests[1].userContent).toMatch(/Must contain at least two sections\./);
        expect(getSnapshots()[0].text).toBe(ENTRY);
    });

    test('a preamble before "## Summary" is stripped, not treated as a failure', async () => {
        scriptApi(`Sure! Here is the entry.\n\n${ENTRY}`);

        await generateSnapshot();

        expect(requests).toHaveLength(1);
        expect(getSnapshots()[0].text).toBe(ENTRY);
    });

    test('empty then continuation: one retry in total, then refused', async () => {
        scriptApi('', CONTINUATION, ENTRY);

        expect(await generateSnapshot()).toBeNull();

        expect(requests).toHaveLength(2);
        expect(requests[1].userContent).toMatch(/\[REMINDER: Your last response was empty\./);
        expect(getSnapshots()).toHaveLength(0);
        expect(state._lastStatusMsg).toMatch(/did not return a chronicle entry/);
    });

    test('empty twice keeps the existing "output was empty" failure', async () => {
        scriptApi('', '');

        expect(await generateSnapshot()).toBeNull();

        expect(requests).toHaveLength(2);
        expect(state._lastStatusMsg).toMatch(/Chronicle output was empty\./);
    });

    test('a chat switch during the first call stops before the retry', async () => {
        setFakeApi(async (request) => { requests.push(request); chatId = 'chat-B'; return CONTINUATION; });

        expect(await generateSnapshot()).toBeNull();

        expect(requests).toHaveLength(1);
        expect(getSnapshots()).toHaveLength(0);
    });
});

describe('generate: heuristic findings flag the entry and survive into the final status', () => {
    test('an entry that trips a heuristic is saved, and the status says review is needed', async () => {
        const wordy = ENTRY.replace('- The troupe crosses the river at dusk.',
            '- The dialogue with the ferryman stalled.\n- A second dialogue settled the fare.\n- The last dialogue set a dawn departure.');
        scriptApi(wordy);

        await generateSnapshot();

        expect(requests).toHaveLength(1);
        expect(getSnapshots()[0].text).toBe(wordy);
        expect(state._lastStatusLevel).toBe('warning');
        expect(state._lastStatusMsg).toBe('Chronicle entry generated — review needed: Too many instances of "dialogue" — likely narrative text.');
    });

    test('a clean entry reports plain success', async () => {
        scriptApi(ENTRY);

        await generateSnapshot();

        expect(state._lastStatusLevel).toBe('success');
        expect(state._lastStatusMsg).toBe('Chronicle entry generated.');
    });
});

describe('auto-snapshot: a refused entry backs off instead of saving junk', () => {
    test('two continuations leave no entry and arm the retry back-off', async () => {
        const { onMessageReceived } = await import('../chronicle/index.js');
        saveSettings({ autoSnapshot: true, autoSnapshotThreshold: 1 });
        scriptApi(CONTINUATION, CONTINUATION);

        await onMessageReceived({ messageIndex: 0 });

        expect(requests).toHaveLength(2);
        expect(getSnapshots()).toHaveLength(0);
        expect(state.autoSnapshotRetryAt).toBeGreaterThan(state.msgSinceSnapshot);
    });
});

describe('regenerate: the same gate runs before the diff preview', () => {
    beforeEach(() => {
        getFakeMeta().session_chronicle_data = {
            snapshots: [{ id: 's1', text: 'Original summary.', createdAt: '2026-01-01T00:00:00.000Z', fromIndex: 0, toIndex: 1 }],
            _deletedBin: [],
        };
    });

    test('a continuation is retried and only the real entry reaches the preview', async () => {
        scriptApi(CONTINUATION, ENTRY);

        await regenerateSnapshot('s1');

        expect(requests).toHaveLength(2);
        expect(_render.showRegenerateDiff).toHaveBeenCalledTimes(1);
        expect(_render.showRegenerateDiff.mock.calls[0][1]).toBe(ENTRY);
    });

    test('two continuations never reach the preview and leave the entry untouched', async () => {
        scriptApi(CONTINUATION, CONTINUATION);

        await regenerateSnapshot('s1');

        expect(requests).toHaveLength(2);
        expect(_render.showRegenerateDiff).not.toHaveBeenCalled();
        expect(getSnapshots()[0].text).toBe('Original summary.');
        expect(state._lastStatusMsg).toMatch(/^Regeneration failed: The model did not return a chronicle entry/);
        expect(state.isGenerating).toBe(false);
    });
});
