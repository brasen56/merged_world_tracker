/**
 * test/chronicle_regenerate_coverage.test.js — regenerate half of M2-03
 * (docs/TODO.md §0, found in the 2026-09-27 review).
 *
 * buildMessageWindow() now fills its 100k-character budget oldest-first and
 * reports the range it actually covered. generateSnapshot() records that
 * range, but regenerateSnapshot() kept the entry's ORIGINAL range while
 * summarizing only the part that fit — for a range over one window
 * (a consolidated entry, or one made before 2.10.2) the newest end was
 * silently dropped from the regenerated text. Regeneration now refuses such
 * an entry before spending a model call.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getFakeMeta, resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { state, saveSettings, getSnapshots, _render, buildMessageWindow } from '../chronicle/data.js';
import { regenerateSnapshot } from '../chronicle/snapshots.js';

const ENTRY = [
    '## Summary',
    '- The troupe crosses the river at dusk.',
    '',
    '## Time Anchor',
    'In-world date and time at end of this period: 2026-01-01 10:00',
    'Location at end of this period: The ferry landing',
].join('\n');

const message = (i, length = 40) => ({ id: `m${i}`, name: 'Mara', mes: `m${i} `.padEnd(length, 'x') });

let api;

function seedEntry(fromIndex, toIndex) {
    getFakeMeta().session_chronicle_data = {
        snapshots: [{ id: 's1', text: 'Original summary.', createdAt: '2026-01-01T00:00:00.000Z', fromIndex, toIndex }],
        _deletedBin: [],
    };
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
    globalThis.document = { dispatchEvent: vi.fn() };
    api = vi.fn(async () => ENTRY);
    setFakeApi(api);
    saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', syncWorldState: false });
    Object.assign(state, { isGenerating: false, isMainGenerating: false });
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

describe('buildMessageWindow reports whether it covered its whole range', () => {
    test('complete is false when the budget stops the window early', () => {
        setFakeChat(Array.from({ length: 5 }, (_, i) => message(i, 30000)));
        const window = buildMessageWindow(0, 4);
        expect(window.complete).toBe(false);
        expect(window.toIndex).toBeLessThan(4);
    });

    test('complete is true when every message fits', () => {
        setFakeChat(Array.from({ length: 5 }, (_, i) => message(i)));
        expect(buildMessageWindow(0, 4)).toMatchObject({ complete: true, toIndex: 4 });
    });
});

describe('regenerate refuses a range it cannot cover', () => {
    test('an entry spanning more than one window is refused before any model call', async () => {
        setFakeChat(Array.from({ length: 5 }, (_, i) => message(i, 30000)));
        seedEntry(0, 4);

        await regenerateSnapshot('s1');

        expect(api).not.toHaveBeenCalled();
        expect(_render.showRegenerateDiff).not.toHaveBeenCalled();
        expect(getSnapshots()[0].text).toBe('Original summary.');
        expect(state.isGenerating).toBe(false);
    });

    test('an entry that fits one window still regenerates', async () => {
        setFakeChat(Array.from({ length: 5 }, (_, i) => message(i)));
        seedEntry(0, 4);

        await regenerateSnapshot('s1');

        expect(api).toHaveBeenCalledTimes(1);
        expect(_render.showRegenerateDiff).toHaveBeenCalledTimes(1);
    });

    test('a stale in-flight flag on the last message does not count as lost coverage', async () => {
        // The window trims a trailing message still marked as generating; it
        // has no settled content, so the rest of the range is still whole.
        const chat = Array.from({ length: 5 }, (_, i) => message(i));
        chat[4] = { ...chat[4], extra: { gen_started: 1 } };
        setFakeChat(chat);
        seedEntry(0, 4);

        await regenerateSnapshot('s1');

        expect(api).toHaveBeenCalledTimes(1);
    });
});
