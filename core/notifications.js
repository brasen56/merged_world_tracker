/**
 * core/notifications.js — Shared notification helpers.
 */

export function notify(title, message, level = 'info') {
    const type = level === 'success' ? 'success' : level === 'error' ? 'error' : 'info';
    try {
        if (typeof toastr !== 'undefined' && toastr?.[type]) {
            toastr[type](message, title);
        }
    } catch { /* ignore */ }
}