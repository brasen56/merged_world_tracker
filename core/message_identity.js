/**
 * core/message_identity.js — Stable, persisted chat-message identities.
 *
 * Host-provided IDs take precedence. Messages without one receive a UUID in
 * `extra.mwt_uuid`, which stays attached when SillyTavern replaces message
 * content during a swipe or edit.
 */

import { getContextSafe } from './context.js';

const UUID_KEY = 'mwt_uuid';

function generateUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Return a stable identity for a chat message, creating and persisting a UUID
 * when SillyTavern has not supplied `id` or `extra.mesid`.
 *
 * @param {object} message
 * @returns {string|null}
 */
export function getOrCreateReceiptIdentity(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.id != null && String(message.id).trim()) return `id:${message.id}`;
    if (message.extra?.mesid != null && String(message.extra.mesid).trim()) return `mesid:${message.extra.mesid}`;

    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    if (!message.extra[UUID_KEY]) {
        message.extra[UUID_KEY] = generateUuid();
        const ctx = getContextSafe();
        if (typeof ctx?.saveChatDebounced === 'function') ctx.saveChatDebounced();
        else if (typeof ctx?.saveChat === 'function') ctx.saveChat();
    }
    return `uuid:${message.extra[UUID_KEY]}`;
}