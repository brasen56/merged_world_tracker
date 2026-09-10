/** @vitest-environment jsdom */
/**
 * test/kt_chat_change_sweep.test.js — the chat-change sweep CLOSE PATH
 * (docs/accessibility_plan.md §6.2; BUG_REPORTS/bugs_temp.md).
 *
 * Both Knowledge chat-change sweeps (knowledge/index.js onChatChanged and
 * onChatChangedWhilePaused) drop the four body-mounted kt- modals of the
 * outgoing chat. test/paused_chat_cleanup.test.js pins THAT the sweep runs
 * and which ids it targets — but against mocked document objects whose
 * "modals" have no _closeModal, so only the bare-remove fallback branch is
 * exercised. What was never pinned is the shared close path the real modals
 * take: the sweep must go through m._closeModal() so page inertness is
 * restored and the document-level Escape listener is detached BEFORE the
 * old-chat node is discarded. A bare remove() leaves the rest of the
 * application inert and leaks the keydown handler.
 *
 * These tests run the REAL knowledge/index.js handlers in jsdom against a
 * real decorated #kt-view-modal — the same markup knowledge/render.js
 * builds (createElement + className 'mwt-modal' + decorateModalShell with
 * destroyOnClose: true).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';
import * as Knowledge from '../knowledge/index.js';
import { state } from '../knowledge/state.js';
import { decorateModalShell, releaseManagedInert, showModal } from '../core/modal.js';

/** Let the fire-and-forget reloadStores() continuation of the FULL handler settle. */
const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    resetCoreStubs();
    document.body.innerHTML = '';
    // reloadStores('chat change') is fire-and-forget inside onChatChanged;
    // give its hydration a lorebook source so it settles quietly instead of
    // failing against a null host script (its failure is caught either way).
    state.wiScript = { loadWorldInfo: async () => ({ entries: {} }) };
});

afterEach(() => {
    document.body.innerHTML = '';
    releaseManagedInert();
    state.wiScript = null;
    vi.restoreAllMocks();
});

/** Build and open a #kt-view-modal exactly the way knowledge/render.js does. */
function openKtViewModal() {
    const host = document.createElement('div');
    document.body.append(host); // ordinary page content — inert while covered

    const modal = document.createElement('div');
    modal.id = 'kt-view-modal';
    modal.className = 'mwt-modal';
    modal.innerHTML = '<div class="kt-history-panel"><h3>View</h3><button class="kt-history-close">Close</button></div>';
    document.body.append(modal);
    decorateModalShell(modal, { title: 'View', destroyOnClose: true });
    showModal(modal.id);

    // Wrap (not replace) the cleanup the production code stashed on the
    // element, so the real listener removal still happens while we observe it.
    const realCleanup = modal._cleanupKeyHandler;
    expect(typeof realCleanup).toBe('function');
    const cleanupSpy = vi.fn(() => realCleanup());
    modal._cleanupKeyHandler = cleanupSpy;

    return { host, modal, cleanupSpy };
}

describe('Knowledge chat-change sweep closes through the shared path', () => {
    test('onChatChangedWhilePaused restores body inertness and detaches Escape', () => {
        const { host, modal, cleanupSpy } = openKtViewModal();
        expect(host.inert).toBe(true); // the page is inert behind the modal
        expect(modal.style.display).toBe('flex');

        Knowledge.onChatChangedWhilePaused();

        expect(cleanupSpy).toHaveBeenCalled(); // the document-level Escape listener went with it
        expect(host.inert).toBeFalsy(); // the page was released, not left inert
        expect(document.getElementById('kt-view-modal')).toBeNull(); // disposable shell dropped
    });

    test('the full onChatChanged handler sweeps the same way', async () => {
        const { host, cleanupSpy } = openKtViewModal();
        expect(host.inert).toBe(true);

        // The sweep itself is synchronous; only reloadStores() is async.
        Knowledge.onChatChanged();
        await flushMicrotasks();

        expect(cleanupSpy).toHaveBeenCalled();
        expect(host.inert).toBeFalsy();
        expect(document.getElementById('kt-view-modal')).toBeNull();
    });

    test('both sweeps drop the previous chat\'s relationship filters', async () => {
        state.relFilterNpc = 'Mara';
        state.relFilterType = 'ally';

        Knowledge.onChatChanged();
        await flushMicrotasks();

        expect(state.relFilterNpc).toBe('');
        expect(state.relFilterType).toBe('');

        state.relFilterNpc = 'Jonah';
        state.relFilterType = 'mentor';
        Knowledge.onChatChangedWhilePaused();

        expect(state.relFilterNpc).toBe('');
        expect(state.relFilterType).toBe('');
    });
});
