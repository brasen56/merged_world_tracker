/**
 * core/modal.js — Shared modal lifecycle helpers
 *
 * Provides utilities for creating, showing, hiding, and managing
 * modal dialogs.  Used by all three modules' UI layers.
 */

import { escapeHtml } from './diff.js';

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
export function createModal({ id, title, content, cssClass = '', onClose = null }) {
    let existing = document.getElementById(id);
    if (existing) {
        // Clean up escape key handler before removing to prevent memory leaks
        if (existing._cleanupKeyHandler) existing._cleanupKeyHandler();
        existing.remove();
    }

    const modal = document.createElement('div');
    modal.id = id;
    modal.className = `mwt-modal ${cssClass}`.trim();
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="mwt-modal-backdrop"></div>
        <div class="mwt-modal-panel">
            <div class="mwt-modal-header">
                <h3>${escapeHtml(title)}</h3>
                <button class="mwt-modal-close" title="Close">&times;</button>
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
        modal.style.display = 'none';
    };

    closeBtn?.addEventListener('click', doClose);
    backdrop?.addEventListener('click', doClose);

    // Escape key — only close the topmost (last-shown) visible modal.
    //
    // Note: this deliberately only considers `.mwt-modal` elements, so if a
    // SillyTavern-native dialog (or any other non-MWT overlay) is open on top
    // of an MWT modal, Escape will not close the MWT modal.  This is the
    // intended behaviour: we never want to dismiss ourselves while a foreign
    // modal on top of us still requires attention.  The trade-off is that
    // pressing Escape over an MWT modal with a native dialog stacked above it
    // appears to "do nothing" from the user's perspective.
    const onKey = (e) => {
        if (e.key !== 'Escape') return;
        if (modal.style.display === 'none') return;
        // Find all visible mwt-modal elements
        const visibleModals = [...document.querySelectorAll('.mwt-modal')].filter(
            m => m.style.display !== 'none'
        );
        // Only act if THIS modal is the topmost one (last in DOM order)
        if (visibleModals.length === 0) return;
        const topmost = visibleModals[visibleModals.length - 1];
        if (topmost !== modal) return;
        doClose();
    };
    document.addEventListener('keydown', onKey);
    modal._cleanupKeyHandler = () => document.removeEventListener('keydown', onKey);

    return modal;
}

/**
 * Show a modal by id.
 */
export function showModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
}

/**
 * Hide a modal by id.
 */
export function hideModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
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