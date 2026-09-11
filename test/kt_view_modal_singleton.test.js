/** @vitest-environment jsdom */
/**
 * test/kt_view_modal_singleton.test.js — the #kt-view-modal singleton race.
 *
 * #kt-view-modal has two async open paths — the NPC dossier path
 * (openNpcViewModal, wired to .kt-npc-view) and the State Tracker path
 * (wired to .kt-state-view). The old guard ran only BEFORE each path's
 * await, and the State Tracker path had no in-flight guard at all, so two
 * overlapping loads could each pass their check and build two nodes sharing
 * the same id (two Escape handlers fighting over one close).
 *
 * These tests drive the REAL wiring (renderNpcsSubTab → click handlers) in
 * jsdom, gating the lorebook reads on deferred loadWorldInfo() promises so
 * the interleaving is controlled exactly: while either load is in flight, a
 * click on the other path must be a no-op, and only one #kt-view-modal may
 * ever exist. The shared builder additionally re-checks the DOM id at
 * construction time (createKnowledgeViewModal) as the last line of defense.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getLorebookName, getStateLorebookName } from '../knowledge/scope.js';
import { state } from '../knowledge/state.js';
import { releaseManagedInert } from '../core/modal.js';
import { renderNpcsSubTab } from '../knowledge/render.js';

const NPC = 'Mara Voss';
const NPC_UID = 1;
const TRACKER = 'Weather';
const TRACKER_UID = 9;

/** Promise the test resolves on its own schedule. */
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

let pending;
let contentEl;

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    _setCacheForTests(getLorebookName(), { registry: { [NPC]: { uid: NPC_UID, type: 'minor' } } });
    _setCacheForTests(getStateLorebookName(), { stateRegistry: { [TRACKER]: { uid: TRACKER_UID } } });

    // Gate every lorebook read: each book's loadWorldInfo() stays pending
    // until the test resolves it — exactly the await window the race lived in.
    pending = new Map();
    state.wiScript = {
        loadWorldInfo: vi.fn(book => {
            const d = deferred();
            pending.set(book, d);
            return d.promise;
        }),
    };

    contentEl = document.createElement('div');
    document.body.append(contentEl);
    state.npcsContentEl = contentEl;
});

afterEach(() => {
    document.body.innerHTML = '';
    releaseManagedInert();
    state.wiScript = null;
    state.npcsContentEl = null;
    vi.restoreAllMocks();
});

function renderTab(sub) {
    state.activeSubTab = sub;
    renderNpcsSubTab();
}

/** Let every pending microtask (the load continuations) run to completion. */
const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

function resolveBook(book, entries) {
    pending.get(book)?.resolve({ entries });
}

describe('#kt-view-modal singleton across its two async open paths', () => {
    test('a State Tracker click while an NPC dossier load is in flight is a no-op', async () => {
        renderTab('minor');
        contentEl.querySelector('.kt-npc-view').click(); // NPC path starts, awaits its book

        renderTab('state');
        contentEl.querySelector('.kt-state-view').click(); // overlapping click on the other path

        // The state path never even loaded its book — the shared in-flight
        // guard closed the window the race lived in.
        expect(state.wiScript.loadWorldInfo).toHaveBeenCalledTimes(1);

        resolveBook(getLorebookName(), { [NPC_UID]: { comment: NPC, content: 'Dossier: Mara Voss' } });
        await flushMicrotasks();

        expect(document.querySelectorAll('#kt-view-modal')).toHaveLength(1);
        expect(document.querySelector('#kt-view-modal pre').textContent).toBe('Dossier: Mara Voss');
        expect(state.wiScript.loadWorldInfo).toHaveBeenCalledTimes(1);
    });

    test('an NPC click while a State Tracker load is in flight is a no-op', async () => {
        renderTab('state');
        contentEl.querySelector('.kt-state-view').click(); // state path starts

        renderTab('minor');
        contentEl.querySelector('.kt-npc-view').click(); // overlapping click, other direction

        expect(state.wiScript.loadWorldInfo).toHaveBeenCalledTimes(1);

        resolveBook(getStateLorebookName(), { [TRACKER_UID]: { comment: `${TRACKER} tracker`, content: 'State: raining' } });
        await flushMicrotasks();

        expect(document.querySelectorAll('#kt-view-modal')).toHaveLength(1);
        expect(document.querySelector('#kt-view-modal pre').textContent).toBe('State: raining');
    });

    test('a click on either path while the view modal is already open is a no-op', async () => {
        renderTab('state');
        contentEl.querySelector('.kt-state-view').click();
        resolveBook(getStateLorebookName(), { [TRACKER_UID]: { comment: 't', content: 'State: raining' } });
        await flushMicrotasks();
        expect(document.querySelectorAll('#kt-view-modal')).toHaveLength(1);

        renderTab('minor');
        contentEl.querySelector('.kt-npc-view').click(); // modal already open

        expect(state.wiScript.loadWorldInfo).toHaveBeenCalledTimes(1); // no second load started
        expect(document.querySelectorAll('#kt-view-modal')).toHaveLength(1);
        expect(document.querySelector('#kt-view-modal pre').textContent).toBe('State: raining');
    });

    test('a double-click on the same view button loads the book once', async () => {
        renderTab('state');
        const btn = contentEl.querySelector('.kt-state-view');
        btn.click();
        btn.click(); // second click lands while the first load is in flight

        resolveBook(getStateLorebookName(), { [TRACKER_UID]: { comment: 't', content: 'State: raining' } });
        await flushMicrotasks();

        expect(state.wiScript.loadWorldInfo).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('#kt-view-modal')).toHaveLength(1);
    });
});
