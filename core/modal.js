/**
 * core/modal.js — Shared modal lifecycle helpers
 *
 * Provides utilities for creating, showing, hiding, and managing
 * modal dialogs.  Used by all three modules' UI layers.
 */

import { escapeHtml } from './diff.js';
// Toast on the open-refusal paths (core/notifications.js). Direct import —
// modal.js sits below the core/index.js barrel, and notifications.js's own
// chain (diagnostics.js → scope.js) never imports back up, so this adds no
// cycle.
import { notify } from './notifications.js';

let modalShowSequence = 0;

/**
 * Every body child MWT has marked inert, mapped to the inert value the
 * element had before MWT touched it. The map is the single record of what
 * MWT owes back to the host: normal closes restore entries one by one, and
 * releaseManagedInert() can roll the whole set back in one call.
 */
const managedInert = new Map();

/**
 * Watches document.body's direct children while any MWT modal is visible.
 * Re-runs the stack sync when the set of body children changes, so overlays
 * added while a modal is open also become inert, and a modal removed by
 * anything other than the shared close path cannot strand the host in an
 * inert state. It also watches the style/hidden/class/open attributes on
 * those same direct children — foreign code hiding the active modal without
 * removing it must release the host too, and a native <dialog> popup opening
 * or closing re-ranks the stack — but attribute records are only acted on
 * when their target is a modal root or a native dialog; class churn on host
 * chrome is deliberately ignored. Null when no modal is visible.
 */
let modalDomObserver = null;

/**
 * Create a modal element and append it to document.body.
 * Returns the modal element.
 *
 * @param {object} opts
 * @param {string} opts.id         — DOM id for the modal container
 * @param {string} opts.title      — header text
 * @param {string} opts.content    — innerHTML for the modal body
 * @param {string} [opts.cssClass] — additional CSS class on the root
 * @param {Function} [opts.onClose] — called when modal is closed; return false to cancel the close
 * @returns {HTMLElement}
 */
export function createModal({ id, title, content, cssClass = '', onClose = null, closeOnBackdrop = true, destroyOnClose = false }) {
    const existing = document.getElementById(id);
    if (existing) {
        // Clean up escape key handler before removing to prevent memory leaks
        if (existing._cleanupKeyHandler) existing._cleanupKeyHandler();
        existing.remove();
    }

    const modal = document.createElement('div');
    modal.id = id;
    modal.className = `mwt-modal ${cssClass}`.trim();
    modal.style.display = 'none';
    const titleId = `${id}-title`;
    modal.innerHTML = `
        <div class="mwt-modal-backdrop"></div>
        <div class="mwt-modal-panel" role="dialog" aria-modal="false" aria-labelledby="${titleId}">
            <div class="mwt-modal-header">
                <h3 id="${titleId}">${escapeHtml(title)}</h3>
                <button class="mwt-modal-close" type="button" aria-label="Close ${escapeHtml(title)}" title="Close">&times;</button>
            </div>
            <div class="mwt-modal-body">${content}</div>
            <div class="mwt-modal-statusbar">
                <span class="mwt-status"></span>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Close handlers
    const closeBtn = modal.querySelector('.mwt-modal-close');
    const backdrop = modal.querySelector('.mwt-modal-backdrop');

    const doClose = () => {
        // An onClose returning exactly false cancels the close
        // (used for unsaved-changes guards).
        if (typeof onClose === 'function' && onClose() === false) return;
        closeModalElement(modal, { destroyOnClose });
    };

    closeBtn?.addEventListener('click', doClose);
    if (closeOnBackdrop) backdrop?.addEventListener('click', doClose);

    modal._installKeyHandler = () => installKeyHandler(modal, doClose);
    modal._installKeyHandler();
    modal._closeModal = doClose;
    modal._mwtModalOptions = { closeOnBackdrop, destroyOnClose };

    return modal;
}

/**
 * Show a modal by id.
 */
export function showModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (foreignDialogOwnsFocus()) {
        console.warn('[MWT:Modal] Modal open refused — focus is inside a foreign dialog.');
        // The refusal is deliberate, but to the user it is still a click that
        // did nothing — say so, not only in the console.
        notify('Merged World Tracker', 'Modal not opened — another dialog has focus. Close it first.', 'info');
        return;
    }
    if (document.activeElement && document.activeElement !== el) el._mwtOpener = document.activeElement;
    // closeModalElement removes the document handler for reusable modals;
    // install it again when the same element is shown later.
    el._installKeyHandler?.();
    el.style.display = 'flex';
    el._mwtShowSequence = ++modalShowSequence;
    updateModalStack();
    focusIntoModal(el);
}

/**
 * Hide a modal by id.
 */
export function hideModal(id) {
    const el = document.getElementById(id);
    if (el) {
        if (typeof el._closeModal === 'function') el._closeModal();
        else closeModalElement(el);
    }
}

/**
 * Emergency rollback for the managed-inert bookkeeping: restore every inert
 * value MWT changed (best effort, per element) and stop the body watcher.
 * Normal closes restore entries one by one; this rolls the whole set back.
 * It runs automatically when stack synchronization fails, and is safe to
 * call by hand from the console if a crash ever leaves the host frozen —
 * the handle is MWT.modal.releaseManagedInert(), exposed on window.MWT by
 * index.js.
 */
export function releaseManagedInert() {
    const entries = [...managedInert.entries()];
    managedInert.clear();
    disconnectModalDomObserver();
    for (const [element, wasInert] of entries) {
        try { element.inert = wasInert; } catch { /* a broken element must not block the rest */ }
    }
}

function focusIntoModal(modal) {
    const focusable = getFocusable(modal)[0];
    (focusable || modal.querySelector?.('.mwt-modal-panel'))?.focus?.();
}

function isHidden(element, { ignoreInert = false } = {}) {
    for (let current = element; current; current = current.parentElement) {
        if (current.hidden || (!ignoreInert && current.inert) || current.getAttribute?.('aria-hidden') === 'true') return true;
        if (current.style?.display === 'none' || current.style?.visibility === 'hidden') return true;
        if (current.matches?.('.mwt-tab-content:not(.active)')) return true;
        const computed = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(current)
            : null;
        if (computed?.display === 'none' || computed?.visibility === 'hidden' || computed?.visibility === 'collapse') return true;
    }
    return false;
}

function getFocusable(modal) {
    return [...(modal.querySelectorAll?.('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || [])]
        .filter(el => !el.disabled && !isHidden(el));
}

function installKeyHandler(modal, close) {
    modal._cleanupKeyHandler?.();
    const onKey = (e) => {
        const visible = visibleModals();
        if (visible[visible.length - 1] !== modal) return;
        // Native <dialog> elements carry the dialog role implicitly — the
        // selector must match the element itself, or Escape pressed inside a
        // foreign native popup would close the MWT modal underneath it.
        const focusedDialog = document.activeElement?.closest?.('[role="dialog"], dialog');
        if (focusedDialog && !modal.contains(focusedDialog)) return;
        if (e.key === 'Tab') {
            const focusable = getFocusable(modal);
            if (focusable.length) {
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault?.(); last.focus?.(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault?.(); first.focus?.(); }
            }
            return;
        }
        if (e.key !== 'Escape' || modal.style.display === 'none') return;
        if (visible[visible.length - 1] === modal) close();
    };
    document.addEventListener('keydown', onKey);
    modal._cleanupKeyHandler = () => {
        document.removeEventListener('keydown', onKey);
        modal._cleanupKeyHandler = null;
    };
}

function visibleModals() {
    return [...(document.querySelectorAll?.('.mwt-modal') || [])]
        // A modal hidden by foreign code through more than its inline display
        // (the hidden attribute, aria-hidden) is just as closed: keeping it
        // "visible" here would strand the host in an inert state.
        .filter(m => m.style.display !== 'none'
            && !m.hidden
            && m.getAttribute?.('aria-hidden') !== 'true')
        .sort((a, b) => (a._mwtShowSequence || 0) - (b._mwtShowSequence || 0));
}

function updateModalStack() {
    try {
        const visible = visibleModals();
        const top = visible[visible.length - 1];
        // An open native <dialog> body child (SillyTavern's Popup is one) is
        // a live top-layer dialog above every MWT modal, so while one is up
        // it — not MWT's topmost modal — owns the interaction. Counted only
        // while an MWT modal is visible: with none of its own dialogs open,
        // MWT owes the host no inertness at all.
        const foreignNativeOpen = !!top
            && [...(document.body?.children || [])].some(isOpenNativeDialog);
        visible.forEach(m => {
            const panel = m.querySelector?.('.mwt-modal-panel, .kt-history-panel');
            if (!panel) return;
            if (m === top && !foreignNativeOpen) panel.setAttribute?.('aria-modal', 'true');
            else panel.removeAttribute?.('aria-modal');
        });
        applyManagedInert(visible, top, foreignNativeOpen);
        syncModalDomObserver(visible);
    } catch (error) {
        failModalStackOpen(error);
    }
}

/**
 * True when focus currently sits inside a dialog MWT does not own —
 * SillyTavern's own popup, another extension's dialog. Opening a MWT modal
 * on top of that would inert the host dialog mid-interaction, so callers
 * refuse the open instead of exempting the foreign dialog from inertness.
 */
function foreignDialogOwnsFocus() {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    // Native <dialog> elements (SillyTavern's Popup is one) carry the dialog
    // role implicitly — there is no role attribute to match — so the selector
    // must match the element itself as well, or the guard below silently
    // lets MWT open on top of a focused native popup and inert it.
    const dialog = active?.closest?.('[role="dialog"], dialog');
    if (!dialog) return false;
    // Focus inside any .mwt-modal root — stacking, or the modal being opened
    // itself — is MWT's own business, not a foreign dialog.
    return !dialog.closest?.('.mwt-modal');
}

/**
 * True for a native <dialog> body child in the open state. Shown with
 * showModal() (how SillyTavern's Popup opens) it lives in the browser's top
 * layer above every MWT modal, so it is a live dialog, never background to
 * be inerted. The hasAttribute fallback keeps this working where
 * HTMLDialogElement is not implemented.
 */
function isOpenNativeDialog(element) {
    if (element?.tagName !== 'DIALOG') return false;
    return element.open === true || element.hasAttribute?.('open') === true;
}

/**
 * True for a body child MWT must treat as a live dialog it does not own and
 * never mark inert: a native <dialog> in the open state, or any other element
 * announcing the dialog role. Open-time refusal (foreignDialogOwnsFocus)
 * covers dialogs that exist before a modal opens, but one appended by foreign
 * code while a modal is already up arrives after that gate — without this
 * wider check applyManagedInert would inert it mid-interaction, the exact
 * harm the refusal exists to prevent. MWT's own .mwt-modal roots are
 * stack-managed and never match.
 */
function isLiveForeignDialog(element) {
    if (!element || element.classList?.contains?.('mwt-modal')) return false;
    return isOpenNativeDialog(element)
        || element?.matches?.('[role="dialog"]') === true;
}

/**
 * True for the only body children whose style/hidden/class/open changes can
 * re-rank the modal stack: MWT's own modal roots and native <dialog> popups.
 * Attribute mutations on every other body child are noise — SillyTavern
 * toggles classes on #sheld, #top-bar, and the drawer roots continuously,
 * and none of that may cost a full stack sync.
 */
function isWatchedAttributeTarget(target) {
    return target?.classList?.contains?.('mwt-modal') === true
        || target?.tagName === 'DIALOG';
}

/** Record element's current inert value (once), then make it inert. */
function captureManagedInert(element) {
    if (!managedInert.has(element)) managedInert.set(element, !!element.inert);
    element.inert = true;
}

/** Hand element back the inert value it had before MWT touched it (no-op when MWT never captured it). */
function restoreManagedInert(element) {
    if (!managedInert.has(element)) return;
    element.inert = managedInert.get(element);
    managedInert.delete(element);
}

/**
 * Make non-modal body content unavailable while the topmost dialog is open,
 * and hand it back when the last one closes. Background MWT modals are inert
 * too; only the top stays live. Every inert value MWT changes is recorded in
 * `managedInert` first, so releaseManagedInert() can always undo the set.
 */
function applyManagedInert(visible, top, foreignNativeOpen) {
    const children = document.body?.children;
    if (!children) return;
    for (const child of [...children]) {
        if (isLiveForeignDialog(child)) {
            // A live dialog some other script owns is never modal background —
            // an open native <dialog> popup lives in the browser's top layer,
            // and a foreign div[role="dialog"] overlay would be just as
            // unusable inerted. Restore any value captured before it became a
            // dialog, then leave it alone: MWT must neither inert a live
            // dialog nor keep bookkeeping for one.
            if (managedInert.has(child)) restoreManagedInert(child);
            continue;
        }
        if (visible.includes(child)) {
            if (child === top && !foreignNativeOpen) {
                // The topmost dialog must stay live even if an earlier stack
                // state (or a foreign script) left it inert.
                if (managedInert.has(child)) restoreManagedInert(child);
                else if (child.inert) child.inert = false;
            } else {
                // Background MWT modals are inert — and so is the topmost
                // one while a foreign native dialog covers it.
                captureManagedInert(child);
            }
        } else if (top) {
            captureManagedInert(child);
        } else {
            restoreManagedInert(child);
        }
    }
    // Elements MWT captured that are no longer direct children of body —
    // relocated by foreign code (SillyTavern moves #toast-container into an
    // opened dialog) or removed outright — are outside the modal background
    // now. Hand each one its prior inert value back immediately: a retained
    // entry would keep a moved element inert long after the last modal
    // closed, and deleting an entry without restoring leaks the value MWT
    // owes it. Covers disconnected elements too (parentElement null).
    for (const element of [...managedInert.keys()]) {
        if (element.parentElement !== document.body) restoreManagedInert(element);
    }
}

/**
 * Keep a MutationObserver on document.body's direct children alive exactly
 * while a MWT modal is visible. Besides body's childList it watches, on
 * those same direct children, the attributes through which foreign code can
 * change what is dialog and what is background: style/hidden/class on modal
 * roots (a modal hidden without being removed must release the host) and
 * open on native <dialog> popups (opening or closing one re-ranks the
 * stack). Attribute records on anything else are filtered out by
 * isWatchedAttributeTarget — the callback below explains why. MWT's own
 * inert and aria-modal writes are not in the filter and must not retrigger
 * the watcher.
 */
function syncModalDomObserver(visible) {
    const needed = visible.length > 0
        && typeof MutationObserver === 'function'
        && typeof document !== 'undefined'
        && document.body;
    if (!needed) {
        disconnectModalDomObserver();
        return;
    }
    if (!modalDomObserver) {
        modalDomObserver = new MutationObserver(records => {
            // Re-sync the stack on any watched change: overlays added while a
            // modal is open become inert; a modal removed or hidden by
            // foreign code releases everything once no MWT modal remains; a
            // native dialog opening or closing re-ranks the stack. Attribute
            // records count only on modal roots and native dialogs — class or
            // style churn on any other body child (SillyTavern toggles
            // #sheld, #top-bar, and the drawers as a matter of course) is
            // noise and must not cost a stack walk.
            const relevant = records.some(record =>
                record.addedNodes.length > 0
                || record.removedNodes.length > 0
                || (record.type === 'attributes' && isWatchedAttributeTarget(record.target)));
            if (relevant) updateModalStack();
        });
        modalDomObserver.observe(document.body, { childList: true });
    }
    // Attribute watching targets each direct child individually (a subtree
    // observer would fire on every descendant style tweak in the host UI).
    // Re-registering an already-observed child with identical options is a
    // no-op, so this both covers children added since the last sync — e.g. a
    // native popup whose later close() must be seen — and skips nothing.
    for (const child of document.body.children) {
        modalDomObserver.observe(child, {
            attributes: true,
            attributeFilter: ['style', 'hidden', 'class', 'open'],
        });
    }
}

function disconnectModalDomObserver() {
    modalDomObserver?.disconnect();
    modalDomObserver = null;
}

/**
 * Fail open: if stack synchronization throws partway through, release every
 * inert value MWT owns, drop its aria-modal claims, stop watching the body,
 * and leave the host usable. The visible modal stays open — unmanaged —
 * rather than freezing the page behind it.
 */
function failModalStackOpen(error) {
    releaseManagedInert();
    [...(document.querySelectorAll?.('.mwt-modal') || [])].forEach(m => {
        try { m.querySelector?.('.mwt-modal-panel, .kt-history-panel')?.removeAttribute?.('aria-modal'); } catch { /* best effort */ }
    });
    console.error('[MWT:Modal] Modal stack sync failed — managed inertness released so the host stays usable.', error);
}

function closeModalElement(modal, { destroyOnClose = modal._mwtModalOptions?.destroyOnClose } = {}) {
    const opener = modal._mwtOpener;
    // The stack deliberately marks the opener's body subtree inert while the
    // modal is open. Do not mistake that temporary inertness for an invalid
    // opener; updateModalStack restores it before the actual focus restore.
    const restoreToOpener = isFocusable(opener, { ignoreInert: true });
    modal._cleanupKeyHandler?.();
    modal._cleanupKeyHandler = null;
    modal.style.display = 'none';
    if (destroyOnClose) modal.remove();
    updateModalStack();
    if (restoreToOpener) opener.focus?.();
    else {
        const remaining = visibleModals().at(-1);
        if (remaining) focusIntoModal(remaining);
        else focusPageTarget(modal);
    }
}

function focusPageTarget(closedModal) {
    const pageTarget = [...(document.body?.querySelectorAll?.(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ) || [])].find(element => !closedModal?.contains(element) && isFocusable(element));
    if (pageTarget) {
        pageTarget.focus();
        return;
    }

    // The page may genuinely have no interactive controls. Make the body a
    // temporary programmatic focus target rather than calling focus() on an
    // element that merely exposes the method but cannot receive focus.
    const body = document.body;
    if (!body) return;
    body.setAttribute?.('tabindex', '-1');
    body.focus?.();
    body.removeAttribute?.('tabindex');
}

function isFocusable(element, { ignoreInert = false } = {}) {
    const nativelyFocusable = element?.matches?.('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]');
    return !!element && nativelyFocusable && element.isConnected !== false && !element.disabled
        && (!ignoreInert ? !isHidden(element) : !isHidden(element, { ignoreInert: true }))
        && typeof element.focus === 'function';
}

/**
 * Apply the shared lifecycle to an existing modal shell. Used by legacy
 * module-specific markup that cannot use createModal without changing its body.
 */
export function decorateModalShell(modal, { title = '', closeOnBackdrop = true, destroyOnClose = true, onClose = null } = {}) {
    if (!modal) return modal;
    if (foreignDialogOwnsFocus()) {
        // Refuse rather than inerting the foreign dialog the user is in.
        // Callers append the shell just before this call, so hide it — and
        // drop it, for disposable shells — leaving nothing half-open behind.
        console.warn('[MWT:Modal] Modal open refused — focus is inside a foreign dialog.');
        notify('Merged World Tracker', 'Modal not opened — another dialog has focus. Close it first.', 'info');
        modal.style.display = 'none';
        if (destroyOnClose) modal.remove?.();
        return modal;
    }
    if (document.activeElement && document.activeElement !== modal) modal._mwtOpener = document.activeElement;
    const panel = modal.querySelector?.('.mwt-modal-panel, .kt-history-panel');
    const heading = panel?.querySelector?.('h3');
    const titleId = `${modal.id}-title`;
    if (panel) {
        panel.setAttribute?.('role', 'dialog');
        panel.setAttribute?.('aria-modal', 'false');
        if (heading) {
            heading.id = heading.id || titleId;
            panel.setAttribute?.('aria-labelledby', heading.id);
        } else if (title) {
            panel.setAttribute?.('aria-label', title);
        }
    }
    const closeBtn = modal.querySelector?.('.mwt-modal-close, .kt-history-close');
    if (closeBtn) {
        closeBtn.setAttribute?.('type', 'button');
        closeBtn.setAttribute?.('aria-label', `Close${title ? ` ${title}` : ''}`);
    }
    const close = () => {
        if (typeof onClose === 'function' && onClose() === false) return;
        closeModalElement(modal, { destroyOnClose });
    };
    closeBtn?.addEventListener('click', close);
    if (closeOnBackdrop) modal.querySelector?.('.mwt-modal-backdrop, .kt-history-backdrop')?.addEventListener('click', close);
    modal._installKeyHandler = () => installKeyHandler(modal, close);
    modal._installKeyHandler();
    modal._closeModal = close;
    modal._mwtModalOptions = { closeOnBackdrop, destroyOnClose };
    modal._mwtShowSequence = ++modalShowSequence;
    updateModalStack();
    focusIntoModal(modal);
    return modal;
}

/**
 * Set the status bar text and style within a modal.
 *
 * @param {string|HTMLElement} modalIdOrEl
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} [type='info']
 * @param {number} [clearAfterMs=0] — auto-clear after this many ms (0 = no clear)
 */
export function setStatus(modalIdOrEl, message, type = 'info', clearAfterMs = 0) {
    const modal = typeof modalIdOrEl === 'string'
        ? document.getElementById(modalIdOrEl)
        : modalIdOrEl;
    if (!modal) return;

    const statusEl = modal.querySelector('.mwt-status');
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.className = `mwt-status mwt-status-${type}`;
    statusEl.style.opacity = '1';

    // CORE-03: Always cancel any previous auto-clear timer, even when the new
    // message is persistent (clearAfterMs = 0). The old code only cleared
    // inside the `if (clearAfterMs > 0)` branch, so a stale 3s timer from a
    // previous transient message would still fire and fade out the newer
    // persistent message.
    if (statusEl._clearTimer) {
        clearTimeout(statusEl._clearTimer);
        statusEl._clearTimer = null;
    }
    if (clearAfterMs > 0) {
        statusEl._clearTimer = setTimeout(() => {
            statusEl.style.opacity = '0';
            statusEl._clearTimer = null;
        }, clearAfterMs);
    }
}

/**
 * Format a date for display.
 */
export function formatDate(isoOrLocale) {
    if (!isoOrLocale) return '';
    try {
        const d = new Date(isoOrLocale);
        if (isNaN(d.getTime())) return String(isoOrLocale);
        return d.toLocaleString();
    } catch { return String(isoOrLocale); }
}