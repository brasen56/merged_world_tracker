/**
 * test/chronicle_prompt_closing.test.js — local-model follow-up (tester
 * report, 2026-10-24).
 *
 * Chronicle sent its instructions as the system prompt, then up to 100k
 * characters of chat with nothing after the transcript. A small local model
 * lost the instructions and continued the roleplay instead of writing an
 * entry; the empty-response reminder never fired because the output was not
 * empty.
 *
 * 1. Every Chronicle request now ends with a closing instruction — the same
 *    divider + instruction every other module that sends chat already uses.
 * 2. The message-window budget is a setting ("Max chat per entry", default
 *    and ceiling 100k) so local-model users can lower it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getFakeMeta, resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import {
    state, saveSettings, getSettings, getSnapshots, _render, buildMessageWindow,
    clampWindowChars, getWindowChars, WINDOW_CHARS_DEFAULT, WINDOW_CHARS_MIN,
} from '../chronicle/data.js';
import { CHRONICLE_CLOSING, CONSOLIDATE_CLOSING, buildChronicleUserContent } from '../chronicle/prompts.js';
import { consolidateEntries, generateSnapshot, regenerateSnapshot } from '../chronicle/snapshots.js';

const ENTRY = [
    '## Summary',
    '- The troupe crosses the river at dusk.',
    '',
    '## Time Anchor',
    'In-world date and time at end of this period: 2026-01-01 10:00',
    'Location at end of this period: The ferry landing',
].join('\n');

const message = (i, length = 40) => ({ id: `m${i}`, name: 'Mara', mes: `m${i} `.padEnd(length, 'x') });

/** A settled chat: the stable-history end drops the trailing user+reply pair. */
function settledChat(body) {
    return [
        ...body,
        { id: 'u', name: 'User', is_user: true, mes: 'A user turn.' },
        { id: 'r', name: 'Mara', mes: 'A pending reply.' },
    ];
}

let requests;

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
    globalThis.document = { dispatchEvent: vi.fn() };
    requests = [];
    setFakeApi(async (request) => { requests.push(request); return ENTRY; });
    saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', syncWorldState: false });
    Object.assign(state, {
        isGenerating: false, isMainGenerating: false,
        msgSinceSnapshot: 0, autoSnapshotRetryAt: 0, selectedSnapshotId: null,
    });
    _render.renderContent = vi.fn();
    _render.showRegenerateDiff = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.SillyTavern;
    delete globalThis.document;
});

describe('every Chronicle request ends with a closing instruction', () => {
    test('the closing restates the format contract', () => {
        expect(CHRONICLE_CLOSING).toContain('"## Summary"');
        expect(CHRONICLE_CLOSING).toMatch(/Do NOT continue the roleplay/);
        expect(CONSOLIDATE_CLOSING).toContain('"## Summary"');
    });

    test('the user turn runs World State → messages → closing', () => {
        const content = buildChronicleUserContent('Mara: The ferry leaves.', '## Current Scene\nThe landing.');
        const ws = content.indexOf('Current World State:');
        const messages = content.indexOf('Messages to chronicle:\nMara: The ferry leaves.');
        const closing = content.indexOf(CHRONICLE_CLOSING);
        expect(ws).toBe(0);
        expect(messages).toBeGreaterThan(ws);
        expect(closing).toBeGreaterThan(messages);
        expect(content.endsWith(CHRONICLE_CLOSING)).toBe(true);
    });

    test('without World State the block is omitted, not left empty', () => {
        const content = buildChronicleUserContent('Mara: The ferry leaves.');
        expect(content).not.toContain('Current World State');
        expect(content.startsWith('Messages to chronicle:\n')).toBe(true);
        expect(content.endsWith(CHRONICLE_CLOSING)).toBe(true);
    });

    test('generate: the last text after the transcript is the closing, not a chat turn', async () => {
        setFakeChat(settledChat([message(0), message(1)]));

        await generateSnapshot();

        expect(requests).toHaveLength(1);
        const { userContent } = requests[0];
        expect(userContent.endsWith(CHRONICLE_CLOSING)).toBe(true);
        expect(userContent.indexOf('Mara: m1')).toBeLessThan(userContent.indexOf(CHRONICLE_CLOSING));
        expect(getSnapshots()).toHaveLength(1);
    });

    test('generate: the empty-response reminder follows the closing', async () => {
        setFakeChat(settledChat([message(0)]));
        let call = 0;
        setFakeApi(async (request) => { requests.push(request); return call++ === 0 ? '' : ENTRY; });

        await generateSnapshot();

        expect(requests).toHaveLength(2);
        const retry = requests[1].userContent;
        expect(retry).toContain(CHRONICLE_CLOSING);
        expect(retry.indexOf(CHRONICLE_CLOSING)).toBeLessThan(retry.indexOf('[REMINDER:'));
        expect(retry.trimEnd().endsWith(']')).toBe(true);
    });

    test('regenerate ends with the closing too', async () => {
        setFakeChat([message(0), message(1), message(2)]);
        getFakeMeta().session_chronicle_data = {
            snapshots: [{ id: 's1', text: 'Original summary.', createdAt: '2026-01-01T00:00:00.000Z', fromIndex: 0, toIndex: 2 }],
            _deletedBin: [],
        };

        await regenerateSnapshot('s1');

        expect(requests).toHaveLength(1);
        expect(requests[0].userContent.endsWith(CHRONICLE_CLOSING)).toBe(true);
    });

    test('consolidate: the previewed (editable) prompt and the request both end with the closing', async () => {
        getFakeMeta().session_chronicle_data = {
            snapshots: [
                { id: 's1', text: ENTRY, createdAt: '2026-01-01T00:00:00.000Z', fromIndex: 0, toIndex: 1 },
                { id: 's2', text: ENTRY, createdAt: '2026-01-02T00:00:00.000Z', fromIndex: 2, toIndex: 3 },
            ],
            _deletedBin: [],
        };
        let previewPrompt = null;
        let confirm = null;
        _render.showConsolidationPreview = (_entries, prompt, onConfirm) => { previewPrompt = prompt; confirm = onConfirm; };

        await consolidateEntries(['s1', 's2']);
        expect(previewPrompt.endsWith(CONSOLIDATE_CLOSING)).toBe(true);
        expect(previewPrompt.indexOf('SOURCE ENTRY 1')).toBeLessThan(previewPrompt.indexOf(CONSOLIDATE_CLOSING));

        await confirm(previewPrompt);
        expect(requests).toHaveLength(1);
        expect(requests[0].userContent.endsWith(CONSOLIDATE_CLOSING)).toBe(true);
    });
});

describe('"Max chat per entry" setting', () => {
    test('defaults to the old fixed 100k budget', () => {
        expect(WINDOW_CHARS_DEFAULT).toBe(100000);
        expect(getSettings().maxWindowChars).toBe(WINDOW_CHARS_DEFAULT);
        expect(getWindowChars()).toBe(WINDOW_CHARS_DEFAULT);
    });

    test('values are clamped to [min, default]; junk falls back to the default', () => {
        expect(clampWindowChars(1000)).toBe(WINDOW_CHARS_MIN);
        expect(clampWindowChars(500000)).toBe(WINDOW_CHARS_DEFAULT);
        expect(clampWindowChars(12345.7)).toBe(12345);
        expect(clampWindowChars('20000')).toBe(20000);
        expect(clampWindowChars('')).toBe(WINDOW_CHARS_DEFAULT);
        expect(clampWindowChars('abc')).toBe(WINDOW_CHARS_DEFAULT);
        expect(clampWindowChars(undefined)).toBe(WINDOW_CHARS_DEFAULT);
        expect(clampWindowChars(-5)).toBe(WINDOW_CHARS_DEFAULT);
        expect(getWindowChars({ maxWindowChars: 999999 })).toBe(WINDOW_CHARS_DEFAULT);
    });

    test('a lowered budget shortens the window and reports it incomplete', () => {
        setFakeChat(Array.from({ length: 5 }, (_, i) => message(i, 3000)));
        expect(buildMessageWindow(0, 4)).toMatchObject({ complete: true, toIndex: 4 });

        saveSettings({ maxWindowChars: 8000 });
        const window = buildMessageWindow(0, 4);
        // Each line is "Mara: " + 3000 chars; two fit in 8000, three do not.
        expect(window.toIndex).toBe(1);
        expect(window.complete).toBe(false);
        expect(window.text.length).toBeLessThanOrEqual(8000);
    });

    test('a single message over a lowered budget is cut mid-text and resumed, not dropped', () => {
        saveSettings({ maxWindowChars: WINDOW_CHARS_MIN });
        setFakeChat([{ id: 'm0', name: 'Mara', mes: 'A'.repeat(7000) + 'TAIL_MARKER' }, message(1)]);

        const first = buildMessageWindow(0, 1);
        expect(first.toIndex).toBe(0);
        expect(first.text.length).toBeLessThanOrEqual(WINDOW_CHARS_MIN);
        expect(first.text).not.toContain('TAIL_MARKER');

        const second = buildMessageWindow(0, 1, first.toCharOffset);
        expect(second.text).toContain('TAIL_MARKER');
        expect(second.toIndex).toBe(1);
    });

    test('generation records only the range the lowered budget covered; the rest goes to the next entry', async () => {
        saveSettings({ maxWindowChars: 8000 });
        setFakeChat(settledChat(Array.from({ length: 4 }, (_, i) => message(i, 3000))));

        await generateSnapshot();
        expect(getSnapshots()[0]).toMatchObject({ fromIndex: 0, toIndex: 1 });

        await generateSnapshot();
        expect(getSnapshots()[1]).toMatchObject({ fromIndex: 2, toIndex: 3 });
    });

    test('regenerate refusal points at the setting only when it was lowered', async () => {
        setFakeChat(Array.from({ length: 5 }, (_, i) => message(i, 3000)));
        getFakeMeta().session_chronicle_data = {
            snapshots: [{ id: 's1', text: 'Original summary.', createdAt: '2026-01-01T00:00:00.000Z', fromIndex: 0, toIndex: 4 }],
            _deletedBin: [],
        };

        saveSettings({ maxWindowChars: 8000 });
        await regenerateSnapshot('s1');
        expect(requests).toHaveLength(0);
        expect(state._lastStatusMsg).toMatch(/Raise "Max chat per entry"/);

        // At the default the same entry fits, so it regenerates normally.
        saveSettings({ maxWindowChars: WINDOW_CHARS_DEFAULT });
        await regenerateSnapshot('s1');
        expect(requests).toHaveLength(1);
    });

    test('at the default, an over-budget refusal does not suggest raising the setting', async () => {
        setFakeChat(Array.from({ length: 5 }, (_, i) => message(i, 30000)));
        getFakeMeta().session_chronicle_data = {
            snapshots: [{ id: 's1', text: 'Original summary.', createdAt: '2026-01-01T00:00:00.000Z', fromIndex: 0, toIndex: 4 }],
            _deletedBin: [],
        };

        await regenerateSnapshot('s1');

        expect(requests).toHaveLength(0);
        expect(state._lastStatusMsg).toMatch(/^This entry covers more chat/);
        expect(state._lastStatusMsg).not.toMatch(/Max chat per entry/);
    });
});
