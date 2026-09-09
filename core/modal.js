/**
 * core/modal.js — Shared modal lifecycle helpers
 *
 * Provides utilities for creating, showing, hiding, and managing
 * modal dialogs.  Used by all three modules' UI layers.
 */

import { escapeHtml } from './diff.js';

let modalShowSequence = 0;

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
        const focusedDialog = document.activeElement?.closest?.('[role="dialog"]');
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
        .filter(m => m.style.display !== 'none')
        .sort((a, b) => (a._mwtShowSequence || 0) - (b._mwtShowSequence || 0));
}

function updateModalStack() {
    const visible = visibleModals();
    const top = visible[visible.length - 1];
    visible.forEach(m => {
        const panel = m.querySelector?.('.mwt-modal-panel, .kt-history-panel');
        if (!panel) return;
        if (m === top) panel.setAttribute?.('aria-modal', 'true');
        else panel.removeAttribute?.('aria-modal');
    });
    // Make non-modal body content unavailable while the topmost dialog is open.
    if (document.body?.children) {
        [...document.body.children].forEach(child => {
            if (visible.includes(child)) child.inert = child !== top;
            else if (top) {
                if (child._mwtInertBefore === undefined) child._mwtInertBefore = !!child.inert;
                child.inert = true;
            }
            else if (child._mwtInertBefore !== undefined) {
                child.inert = child._mwtInertBefore;
                delete child._mwtInertBefore;
            }
        });
    }
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