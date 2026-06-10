/**
 * core/modal.js — Shared modal lifecycle helpers
 *
 * Provides utilities for creating, showing, hiding, and managing
 * modal dialogs.  Used by all three modules' UI layers.
 */

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
                <h3>${title}</h3>
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

    // Escape key
    const onKey = (e) => {
        if (e.key === 'Escape' && modal.style.display !== 'none') {
            doClose();
        }
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

    if (clearAfterMs > 0) {
        setTimeout(() => {
            statusEl.style.opacity = '0';
        }, clearAfterMs);
    }
}

/**
 * Inject a button bar into the document body (for quick-access toolbar buttons).
 *
 * @param {string} id — DOM id for the bar
 * @param {Array<{id:string, label:string, title:string, onClick:Function}>} buttons
 * @returns {HTMLElement}
 */
export function injectButtonBar(id, buttons) {
    let existing = document.getElementById(id);
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = id;
    bar.className = 'mwt-button-bar';

    for (const btn of buttons) {
        const el = document.createElement('button');
        el.id = btn.id;
        el.className = 'mwt-bar-btn';
        el.title = btn.title || '';
        el.textContent = btn.label;
        el.addEventListener('click', btn.onClick);
        bar.appendChild(el);
    }

    document.body.appendChild(bar);
    return bar;
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