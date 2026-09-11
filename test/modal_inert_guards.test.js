/** @vitest-environment jsdom */
/**
 * test/modal_inert_guards.test.js — fail-safes for the managed-inert modal
 * backdrop
 *
 * core/modal.js marks every non-modal document.body child `inert` while a
 * dialog is open. That is correct modal behavior, but it must never be able
 * to strand the host in an inert state. What is pinned here:
 *
 *   - a modal removed outside the shared close path releases the page once
 *     the body watcher runs (and a remaining modal is promoted, with the
 *     page staying inert underneath it);
 *   - body children added while a modal is open become inert too;
 *   - an element that was already inert before MWT opened keeps that value
 *     when the modal closes;
 *   - a stack-sync failure fails OPEN — nothing stays inert, aria-modal
 *     claims are dropped, the visible modal stays open, the error is logged;
 *   - opening is refused while focus sits inside a foreign (non-MWT)
 *     dialog, instead of inerting that dialog; stacking on another MWT
 *     modal is unaffected; the refusal is user-visible as a toast, not
 *     console-only;
 *   - a foreign div[role="dialog"] appended while a modal is already open
 *     is spared exactly like a native popup;
 *   - attribute churn on unrelated body children (class/style toggles on
 *     host chrome) neither releases the host nor blinds the body watcher;
 *   - a native <dialog> popup (implicit dialog role) is recognized by the
 *     same guard, and a native popup opened late over an MWT modal stays
 *     live while the MWT modal demotes under it (and is promoted back when
 *     the popup closes);
 *   - an element captured by MWT and then moved off document.body is
 *     restored immediately, not retained inert;
 *   - a modal hidden by foreign code (inline style or the hidden attribute)
 *     releases the host.
 *
 * jsdom does not reflect the `inert` attribute, but the property round-trips,
 * so assertions read `.inert` directly. The MutationObserver delivers on the
 * microtask queue, so `flushObserver()` (one macrotask) always runs after it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createModal, decorateModalShell, hideModal, releaseManagedInert, showModal } from '../core/modal.js';

/** Give jsdom's (microtask-scheduled) MutationObserver a chance to deliver. */
const flushObserver = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    // Drop any open modal and roll the managed-inert bookkeeping back so one
    // test's open dialog cannot leak into the next.
    document.body.innerHTML = '';
    releaseManagedInert();
    delete globalThis.toastr; // the refusal-toast tests install a stub
    vi.restoreAllMocks();
});

describe('managed inert fail-safes', () => {
    test('releases body inertness when the active modal is removed without the close path', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const modal = createModal({ id: 'mwt-removed', title: 'Removed', content: '<button>Action</button>', destroyOnClose: false });

        showModal('mwt-removed');
        expect(host.inert).toBe(true); // the feature itself: page is inert behind the dialog

        modal.remove(); // foreign code path — never went through closeModalElement
        await flushObserver();

        expect(host.inert).toBeFalsy();
    });

    test('promotes the remaining modal and keeps the page inert when the top modal is removed', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const lower = createModal({ id: 'mwt-lower', title: 'Lower', content: '<button>Lower</button>', destroyOnClose: false });
        const upper = createModal({ id: 'mwt-upper', title: 'Upper', content: '<button>Upper</button>', destroyOnClose: false });

        showModal(lower.id);
        showModal(upper.id);
        upper.remove(); // top modal vanishes outside the shared close path
        await flushObserver();

        expect(host.inert).toBe(true); // a dialog is still open…
        expect(lower.inert).toBeFalsy(); // …and the survivor is now the live top…
        expect(lower.querySelector('.mwt-modal-panel').getAttribute('aria-modal')).toBe('true');
    });

    test('inerts body children added while a modal is open', async () => {
        const modal = createModal({ id: 'mwt-late-child', title: 'Late', content: '<button>Action</button>', destroyOnClose: false });
        showModal(modal.id);

        const late = document.createElement('div');
        document.body.append(late);
        expect(late.inert).toBeFalsy(); // the watcher is asynchronous by design

        await flushObserver();
        expect(late.inert).toBe(true);

        hideModal(modal.id);
        expect(late.inert).toBeFalsy(); // and it is handed back on close
    });

    test('restores a body child that was already inert before the modal opened', () => {
        const preInert = document.createElement('div');
        preInert.inert = true; // e.g. a host overlay that was inert before MWT existed
        const live = document.createElement('div');
        document.body.append(preInert, live);

        const modal = createModal({ id: 'mwt-pre-inert', title: 'Pre', content: '<button>Action</button>', destroyOnClose: false });
        showModal(modal.id);
        expect(preInert.inert).toBe(true); // still inert (recorded as true, not assumed false)
        expect(live.inert).toBe(true);

        hideModal(modal.id);
        expect(preInert.inert).toBe(true); // restored to its OWN value…
        expect(live.inert).toBeFalsy(); // …while the untouched child goes back to normal
    });

    test('fails open when stack synchronization throws', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const healthy = document.createElement('div');
        document.body.append(healthy);
        // A hostile body child whose inert setter throws, simulating a
        // half-applied stack update.
        const hostile = document.createElement('div');
        Object.defineProperty(hostile, 'inert', {
            configurable: true,
            get() { return false; },
            set() { throw new Error('inert is readonly'); },
        });
        document.body.append(hostile);

        const modal = createModal({ id: 'mwt-fail-open', title: 'Fail', content: '<button>Action</button>', destroyOnClose: false });
        showModal(modal.id); // updateModalStack throws while inerting body children

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(healthy.inert).toBeFalsy(); // already-restored sibling is not stranded
        expect(hostile.inert).toBeFalsy();
        expect(modal.querySelector('.mwt-modal-panel').getAttribute('aria-modal')).toBeNull(); // claim dropped
        expect(modal.style.display).toBe('flex'); // fail open ≠ force-close: dialog stays visible
    });

    test('refuses to open while focus is inside a foreign dialog', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const toasts = [];
        globalThis.toastr = { info: (message, title) => toasts.push({ message, title }) };
        const foreign = document.createElement('div');
        foreign.setAttribute('role', 'dialog');
        foreign.innerHTML = '<button id="foreign-btn">Foreign action</button>';
        document.body.append(foreign);

        const modal = createModal({ id: 'mwt-refused', title: 'Refused', content: '<button>Action</button>', destroyOnClose: false });
        foreign.querySelector('#foreign-btn').focus();

        showModal(modal.id);
        expect(modal.style.display).toBe('none'); // refused…
        expect(foreign.inert).toBeFalsy(); // …so the foreign dialog was never inerted…
        expect(document.activeElement).toBe(foreign.querySelector('#foreign-btn')); // …and focus was not stolen
        expect(warnSpy).toHaveBeenCalledTimes(1);
        // The refusal is also user-visible: a click that does
        // nothing must not be console-only.
        expect(toasts).toEqual([{ message: 'Modal not opened — another dialog has focus. Close it first.', title: 'Merged World Tracker' }]);

        // Once focus leaves the foreign dialog, the same open works normally.
        // The protection is now symmetric: the foreign
        // [role=dialog] body child is spared as a live dialog, while ordinary
        // background is inerted as before.
        const plainHost = document.createElement('div');
        document.body.append(plainHost);
        const opener = document.createElement('button');
        document.body.append(opener);
        opener.focus();
        showModal(modal.id);
        expect(modal.style.display).toBe('flex');
        expect(foreign.inert).toBeFalsy(); // a [role=dialog] body child is never inerted
        expect(plainHost.inert).toBe(true); // ordinary background still is
        hideModal(modal.id);
        expect(plainHost.inert).toBeFalsy();
    });

    test('refuses a decorated hand-rolled shell while focus is inside a foreign dialog', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const toasts = [];
        globalThis.toastr = { info: (message, title) => toasts.push({ message, title }) };
        const foreign = document.createElement('div');
        foreign.setAttribute('role', 'dialog');
        foreign.innerHTML = '<button id="foreign-shell-btn">Foreign action</button>';
        document.body.append(foreign);
        foreign.querySelector('#foreign-shell-btn').focus();

        const shell = document.createElement('div');
        shell.id = 'kt-refused-shell';
        shell.className = 'mwt-modal';
        shell.innerHTML = '<div class="kt-history-panel"><h3>Shell</h3><button class="kt-history-close">Close</button></div>';
        document.body.append(shell);

        decorateModalShell(shell, { title: 'Shell', destroyOnClose: true });

        expect(shell.isConnected).toBe(false); // disposable shell: nothing half-open left behind
        expect(foreign.inert).toBeFalsy();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(toasts).toEqual([{ message: 'Modal not opened — another dialog has focus. Close it first.', title: 'Merged World Tracker' }]);
    });

    test('still stacks when focus is inside another MWT modal', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const lower = createModal({ id: 'mwt-stack-lower', title: 'Lower', content: '<button>Lower</button>', destroyOnClose: false });
        const upper = createModal({ id: 'mwt-stack-upper', title: 'Upper', content: '<button>Upper</button>', destroyOnClose: false });

        showModal(lower.id);
        showModal(upper.id); // focus is inside lower's dialog — stacking is MWT's own business

        expect(upper.style.display).toBe('flex');
        expect(lower.inert).toBe(true); // background MWT modal is inert…
        expect(upper.querySelector('.mwt-modal-panel').getAttribute('aria-modal')).toBe('true');

        hideModal(upper.id);
        expect(lower.inert).toBeFalsy(); // …and is handed back its liveness when promoted to top
        expect(lower.querySelector('.mwt-modal-panel').getAttribute('aria-modal')).toBe('true');

        hideModal(lower.id);
        expect(host.inert).toBeFalsy();
    });
});

describe('native dialogs and foreign modal changes', () => {
    test('refuses to open while focus is inside a native <dialog> popup (implicit dialog role)', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const toasts = [];
        globalThis.toastr = { info: (message, title) => toasts.push({ message, title }) };
        const popup = document.createElement('dialog');
        popup.className = 'popup'; // SillyTavern's Popup shell — no role attribute
        popup.innerHTML = '<button id="st-popup-btn">ST action</button>';
        document.body.append(popup);

        const modal = createModal({ id: 'mwt-native-refused', title: 'Refused', content: '<button>Action</button>', destroyOnClose: false });
        popup.querySelector('#st-popup-btn').focus();

        showModal(modal.id);
        expect(modal.style.display).toBe('none'); // refused…
        expect(popup.inert).toBeFalsy(); // …so the native popup was never inerted…
        expect(document.activeElement).toBe(popup.querySelector('#st-popup-btn')); // …and focus was not stolen
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(toasts).toEqual([{ message: 'Modal not opened — another dialog has focus. Close it first.', title: 'Merged World Tracker' }]);
    });

    test('keeps a foreign div[role="dialog"] appended while a modal is open live too', async () => {
        // the protection used to be asymmetric — open-time
        // refusal covers [role=dialog] and native <dialog> alike, but once a
        // modal was already up only the native popup was spared; a plain
        // div[role=dialog] from another extension still got inerted by
        // applyManagedInert mid-interaction.
        const host = document.createElement('div');
        document.body.append(host);
        const modal = createModal({ id: 'mwt-under-role-dialog', title: 'Under', content: '<button>Action</button>', destroyOnClose: false });
        showModal(modal.id);
        expect(host.inert).toBe(true);

        const foreign = document.createElement('div');
        foreign.setAttribute('role', 'dialog'); // no <dialog> tag, no .mwt-modal class
        foreign.innerHTML = '<button id="foreign-role-btn">Foreign action</button>';
        document.body.append(foreign);
        await flushObserver();

        expect(foreign.inert).toBeFalsy(); // live foreign dialog, never inerted…
        expect(host.inert).toBe(true); // …while ordinary background stays covered

        hideModal(modal.id);
        expect(host.inert).toBeFalsy();
        expect(foreign.inert).toBeFalsy(); // and nothing was left captured for it
    });

    test('ignores attribute churn on unrelated body children without going blind', async () => {
        // SillyTavern toggles classes (and styles) on #sheld,
        // #top-bar, and the drawer roots the whole time a modal is open. The
        // observer now filters attribute records down to modal roots and
        // native dialogs — this pins that the noise neither releases the
        // host NOR stops the watcher from reacting to a real change after it.
        const host = document.createElement('div');
        host.id = 'sheld';
        document.body.append(host);
        const modal = createModal({ id: 'mwt-churn', title: 'Churn', content: '<button>Action</button>', destroyOnClose: false });
        showModal(modal.id);
        expect(host.inert).toBe(true);

        host.classList.add('drawer-open'); // class churn on host chrome — ignored
        host.classList.remove('drawer-open');
        host.style.left = '10px'; // style churn — ignored
        host.hidden = true; // hidden churn — ignored
        host.hidden = false;
        await flushObserver();

        expect(host.inert).toBe(true); // the noise did not release the host
        expect(modal.style.display).toBe('flex');

        // The watcher is still live: a relevant attribute change — foreign
        // code hiding the modal through its inline style — must still release.
        modal.style.display = 'none';
        await flushObserver();
        expect(host.inert).toBeFalsy();
    });

    test('keeps a late native popup live and inerts the MWT modal under it', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const modal = createModal({ id: 'mwt-under-native', title: 'Under', content: '<button>Action</button>', destroyOnClose: false });

        showModal(modal.id);
        expect(host.inert).toBe(true);

        // SillyTavern appends a native popup and calls showModal() while the
        // MWT modal is open — the body watcher must not inert the live
        // top-layer dialog.
        const popup = document.createElement('dialog');
        popup.className = 'popup';
        popup.setAttribute('open', ''); // showModal() reflects this
        document.body.append(popup);
        await flushObserver();

        expect(popup.inert).toBeFalsy(); // top-layer dialog stays live…
        expect(modal.inert).toBe(true); // …and the MWT modal is background under it…
        expect(modal.querySelector('.mwt-modal-panel').getAttribute('aria-modal')).toBeNull(); // …no longer the top dialog

        // Closing the native popup (dialog.close() removes `open`) hands the
        // top spot back to the MWT modal.
        popup.removeAttribute('open');
        await flushObserver();

        expect(modal.inert).toBeFalsy();
        expect(modal.querySelector('.mwt-modal-panel').getAttribute('aria-modal')).toBe('true');
        expect(host.inert).toBe(true); // still covered by the MWT modal

        hideModal(modal.id);
        expect(host.inert).toBeFalsy();
    });

    test('hands a closed native dialog its liveness back when it is shown after capture', async () => {
        const modal = createModal({ id: 'mwt-closed-dialog', title: 'Closed', content: '<button>Action</button>', destroyOnClose: false });
        showModal(modal.id);

        // A native dialog appended while CLOSED is ordinary background…
        const popup = document.createElement('dialog');
        document.body.append(popup);
        await flushObserver();
        expect(popup.inert).toBe(true);

        // …but opening it later (showModal sets `open`) must release it —
        // it is a live top-layer dialog now, whatever MWT captured earlier.
        popup.setAttribute('open', '');
        await flushObserver();
        expect(popup.inert).toBeFalsy();
        expect(modal.inert).toBe(true); // and the MWT modal demotes under it
    });

    test('restores a captured element that foreign code moves off document.body', async () => {
        const toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        document.body.append(toastContainer);
        const modal = createModal({ id: 'mwt-moved-child', title: 'Moved', content: '<button>Action</button>', destroyOnClose: false });
        showModal(modal.id);
        expect(toastContainer.inert).toBe(true);

        // SillyTavern opens a popup and relocates its toast container into it.
        const popup = document.createElement('dialog');
        popup.setAttribute('open', '');
        document.body.append(popup);
        popup.appendChild(toastContainer); // no longer a direct body child
        await flushObserver();

        expect(toastContainer.inert).toBeFalsy(); // MWT handed back its prior value…

        hideModal(modal.id);
        expect(toastContainer.inert).toBeFalsy(); // …and it stays live after the close
    });

    test('releases the host when foreign code hides the active modal via inline style', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const modal = createModal({ id: 'mwt-style-hidden', title: 'Hidden', content: '<button>Action</button>', destroyOnClose: false });
        showModal(modal.id);
        expect(host.inert).toBe(true);

        modal.style.display = 'none'; // foreign code hides it — no close path runs
        await flushObserver();

        expect(host.inert).toBeFalsy(); // the attribute watcher noticed and released the page
    });

    test('releases the host when foreign code hides the active modal via the hidden attribute', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const modal = createModal({ id: 'mwt-attr-hidden', title: 'Hidden', content: '<button>Action</button>', destroyOnClose: false });
        showModal(modal.id);
        expect(host.inert).toBe(true);

        modal.hidden = true; // sets the hidden attribute — no close path runs
        await flushObserver();

        expect(host.inert).toBeFalsy();
    });
});
