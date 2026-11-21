/** Ledger receipts identify a message slot, not its currently selected swipe. */
import { getContextSafe } from './context.js';
import { getReceiptIdentity, generateUuid } from './message_identity.js';

const SLOT_KEY = 'mwt_ledger_identity';
const ALIASES_KEY = 'mwt_ledger_aliases';
const DETACHED_KEY = 'mwt_ledger_detached';

export function ledgerReceiptIdentities(message) {
    if (!message || typeof message !== 'object') return [];
    const aliases = Array.isArray(message[ALIASES_KEY]) ? message[ALIASES_KEY] : legacyIdentities(message);
    return [message[SLOT_KEY], ...aliases]
        .filter(identity => typeof identity === 'string' && identity.length > 0);
}

function legacyIdentities(message) {
    return [getReceiptIdentity(message),
        ...(Array.isArray(message.swipe_info) ? message.swipe_info : []).map(swipe => getReceiptIdentity({ extra: swipe?.extra }))]
        .filter(identity => typeof identity === 'string' && identity.length > 0);
}

export function getLedgerReceiptIdentity(message) {
    return ledgerReceiptIdentities(message)[0] ?? null;
}

/** One ownership index and at most one persistence request per scan window.
 * The first slot owns a cloned key; copies must not inherit its legacy aliases. */
export function createLedgerReceiptIdentityBatch(chat = getContextSafe()?.chat ?? []) {
    const owners = new Map();
    for (const message of chat) {
        for (const identity of ledgerReceiptIdentities(message)) {
            if (!owners.has(identity)) owners.set(identity, message);
        }
    }
    let changed = false;
    return {
        getIdentity(message) {
            if (!message || typeof message !== 'object') return null;
            const known = [...new Set([...ledgerReceiptIdentities(message),
                ...(message[DETACHED_KEY] ? [] : legacyIdentities(message))])];
            const copied = message[SLOT_KEY] && owners.has(message[SLOT_KEY]) && owners.get(message[SLOT_KEY]) !== message;
            const aliases = copied ? [] : known.filter(identity => !owners.has(identity) || owners.get(identity) === message);
            let identity = aliases[0];
            if (!identity) {
                do { identity = `uuid:${generateUuid()}`; } while (owners.has(identity));
            }
            const savedAliases = [...new Set([identity, ...aliases])];
            if (copied) message[DETACHED_KEY] = true;
            if (message[SLOT_KEY] !== identity || JSON.stringify(message[ALIASES_KEY]) !== JSON.stringify(savedAliases)) {
                message[SLOT_KEY] = identity;
                message[ALIASES_KEY] = savedAliases;
                changed = true;
            }
            savedAliases.forEach(alias => owners.set(alias, message));
            return identity;
        },
        save() {
            if (!changed) return;
            changed = false;
            const ctx = getContextSafe();
            if (typeof ctx?.saveChatDebounced === 'function') ctx.saveChatDebounced();
            else if (typeof ctx?.saveChat === 'function') ctx.saveChat();
        },
    };
}

export function getOrCreateLedgerReceiptIdentity(message) {
    const batch = createLedgerReceiptIdentityBatch();
    const identity = batch.getIdentity(message);
    batch.save();
    return identity;
}