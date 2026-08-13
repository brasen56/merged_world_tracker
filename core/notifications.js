/**
 * core/notifications.js — Shared notification helpers.
 */

import { record } from './diagnostics.js';

export function notify(title, message, level = 'info') {
    const type = level === 'success' ? 'success' : level === 'error' ? 'error' : 'info';
    // Map the toast level onto a diagnostics level. 'success' has no
    // diagnostics equivalent — treat it as 'info' (positive, not a fault).
    const diagLevel = level === 'error' ? 'error' : 'info';
    try {
        // Capture every toast so a faded notification is still recoverable
        // from the diagnostics ring. Wrapped so a diagnostics failure can
        // never suppress a user-facing toast.
        record({ level: diagLevel, module: 'notify', event: title, detail: { title, message } });
    } catch { /* never block the toast */ }
    try {
        if (typeof toastr !== 'undefined' && toastr?.[type]) {
            toastr[type](message, title);
        }
    } catch { /* ignore */ }
}