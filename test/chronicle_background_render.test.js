/** @vitest-environment jsdom */
/**
 * test/chronicle_background_render.test.js — M2-18 (docs/TODO.md §0).
 *
 * A snapshot that finishes in the background must not replace the view the
 * user is working in. The first fix only skipped the render when the tab was
 * HIDDEN — the harmless case — while a VISIBLE entry editor (or preview, or
 * settings form) was still replaced, losing unsaved text.
 *
 * jsdom has no layout, so getClientRects() is always empty there and every
 * element looks invisible. That is why the first fix passed its tests: the
 * visible path never ran. The host below reports a client rect explicitly.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getFakeMeta, resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { state, saveSettings, getSnapshots, _render } from '../chronicle/data.js';
import { renderContent } from '../chronicle/render.js';
import { generateSnapshot } from '../chronicle/snapshots.js';

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

let host;

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
    setFakeChat(CHAT);
    setFakeApi(async () => CHRONICLE_ENTRY);
    saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', syncWorldState: false });
    getFakeMeta().session_chronicle_data = {
        snapshots: [{ id: 's1', text: 'An existing entry.', createdAt: '2026-01-01T00:00:00.000Z' }],
        _deletedBin: [],
    };
    Object.assign(state, {
        isGenerating: false, isMainGenerating: false, msgSinceSnapshot: 0,
        autoSnapshotRetryAt: 0, selectedSnapshotId: null, pendingSearch: '',
        consolidateMode: false, bulkDeleteMode: false,
    });
    state.countedReceiptEvents = new Map();
    document.body.innerHTML = '';
    host = document.createElement('div');
    // Visible to layout-based checks (jsdom would otherwise report none).
    host.getClientRects = () => [{ width: 100, height: 100 }];
    document.body.append(host);
    state.contentEl = host;
    // chronicle/index.js wires this registry in the real module graph.
    _render.renderContent = renderContent;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    state.contentEl = null;
    state.selectedSnapshotId = null;
    delete globalThis.SillyTavern;
    document.body.innerHTML = '';
});

function openEditor(id, unsavedText) {
    state.selectedSnapshotId = id;
    renderContent();
    const textarea = host.querySelector('#sc-editor-textarea');
    textarea.value = unsavedText;
    return textarea;
}

describe('M2-18: background completion leaves the working view alone', () => {
    test('an auto-snapshot keeps a visible editor and its unsaved text', async () => {
        const textarea = openEditor('s1', 'Unsaved edit in progress');

        const snapshot = await generateSnapshot(true);

        expect(snapshot).toBeTruthy();
        expect(getSnapshots()).toHaveLength(2);
        expect(host.querySelector('#sc-editor-textarea')).toBe(textarea);
        expect(textarea.value).toBe('Unsaved edit in progress');
        expect(state.selectedSnapshotId).toBe('s1');
    });

    test('a manual snapshot finishing while an editor is open also leaves it alone', async () => {
        const textarea = openEditor('s1', 'Still typing');

        await generateSnapshot(false);

        expect(host.querySelector('#sc-editor-textarea')).toBe(textarea);
        expect(textarea.value).toBe('Still typing');
        expect(state.selectedSnapshotId).toBe('s1');
    });

    test('an auto-snapshot refreshes a visible list without opening the new entry', async () => {
        renderContent();
        expect(host.querySelectorAll('.sc-entry')).toHaveLength(1);

        await generateSnapshot(true);

        expect(host.querySelectorAll('.sc-entry')).toHaveLength(2);
        expect(host.querySelector('#sc-editor-textarea')).toBeNull();
        expect(state.selectedSnapshotId).toBeNull();
    });

    test('a manual snapshot from the list still opens the new entry', async () => {
        renderContent();

        const snapshot = await generateSnapshot(false);

        expect(state.selectedSnapshotId).toBe(snapshot.id);
        expect(host.querySelector('#sc-editor-textarea')?.value).toBe(CHRONICLE_ENTRY);
    });

    test('a pending search re-render is dropped once the user has navigated away', () => {
        vi.useFakeTimers();
        renderContent();
        const search = host.querySelector('#sc-search-input');
        search.value = 'existing';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        // The user opens an entry before the search debounce fires.
        const textarea = openEditor('s1', 'Typed right after searching');

        vi.advanceTimersByTime(1000);

        expect(host.querySelector('#sc-editor-textarea')).toBe(textarea);
        expect(textarea.value).toBe('Typed right after searching');
    });
});
