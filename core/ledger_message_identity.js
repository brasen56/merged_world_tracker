/** Ledger receipts identify a message slot, not its currently selected swipe. */
import { getContextSafe } from './context.js';
import { getReceiptIdentity, getOrCreateReceiptIdentity } from './message_identity.js';

const SLOT_KEY = 'mwt_ledger_identity';

export function ledgerReceiptIdentities(message) {
    if (!message || typeof message !== 'object') return [];
    return [message[SLOT_KEY], getReceiptIdentity(message),
        ...(Array.isArray(message.swipe_info) ? message.swipe_info : []).map(swipe => getReceiptIdentity({ extra: swipe?.extra }))]
        .filter(identity => typeof identity === 'string' && identity.length > 0);
}

export function getLedgerReceiptIdentity(message) {
    return ledgerReceiptIdentities(message)[0] ?? null;
}

export function getOrCreateLedgerReceiptIdentity(message) {
    if (!message || typeof message !== 'object') return null;
    if (typeof message[SLOT_KEY] === 'string' && message[SLOT_KEY]) return message[SLOT_KEY];
    // Adopt existing receipts, including receipts on an inactive swipe, so
    // pending proposals and decision tombstones remain linked after upgrading.
    const identity = getLedgerReceiptIdentity(message) ?? getOrCreateReceiptIdentity(message);
    message[SLOT_KEY] = identity;
    const ctx = getContextSafe();
    if (typeof ctx?.saveChatDebounced === 'function') ctx.saveChatDebounced();
    else if (typeof ctx?.saveChat === 'function') ctx.saveChat();
    return identity;
}