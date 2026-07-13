/**
 * interiority/data.js — Constants, state, settings, and data access for the
 * Interiority module.
 *
 * Leaf module (no interiority imports) — safe to import from any other
 * interiority sub-module.
 *
 * Data model (stored in chat metadata via core/metadata.js):
 *
 *   meta.mwt_interiority = {
 *     enabled: true,
 *     ledger: [
 *       { id, npc, action, trigger, since, declaredMsgIdx, manual }
 *                                                                    ↑ optional
 *     ],
 *     perMessage: {
 *       'sd-<send_date>': {
 *         reactions: [ { npc, re, thought } ],
 *         ledgerSnapshot: [ ... ],
 *         generatedAt: 1699999999,
 *       }
 *     }
 *   }
 *
 * perMessage keys are stable identifiers derived from each message's
 * `send_date` property (prefixed 'sd-'), NOT positional chat-array indices.
 * This makes thoughts immune to summarisation tools (Inline Summary) that
 * shrink the chat array. Legacy numeric keys are migrated on chat load
 * via migrateIndexKeys().
 */

import {
    getChatMeta, persistChatMeta, getUserNames,
    createSettingsManager, syncSharedConnectionSettings,
    getCurrentWorldState,
    getChat,
} from '../core/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SETTINGS_KEY = 'mwt_interiority';

/** Chat-metadata key for the interiority data (ledger + perMessage). */
export const META_KEY = 'mwt_interiority';

/** Extension-prompt injection key. */
export const INJECTION_KEY = 'mwt_interiority_injection';

/** Wrapper tag for the injected NPC intentions block. */
export const INJECTION_TAG = 'mwt_npc_intentions';

/** Max thought length (characters). */
export const MAX_THOUGHT_LENGTH = 500;

/**
 * Prefix for stable perMessage keys based on SillyTavern's `send_date`
 * property. Each message is assigned a `send_date` at creation that never
 * changes — even when Inline Summary or other summarisation tools shrink
 * the chat array. Keying perMessage by `send_date` instead of by chat
 * array index prevents thought loss and overwrites when the array shifts.
 */
const MSG_KEY_PREFIX = 'sd-';

// ─── Settings ────────────────────────────────────────────────────────────────

const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    defaults: {
        connectionProfileId: '',
        apiUrl: '',
        apiKey: '',
        modelName: '',
        maxTokens: 1500,
        temperature: 0.4,
        topP: 1.0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        customHeaders: '',
        // Mode: 'batched' (one call/turn) or 'strict' (one call per NPC)
        mode: 'batched',
        // Auto-generate on MESSAGE_RECEIVED, or manual (per-message button)
        autoMode: true,
        // Max NPCs per turn
        maxNpcs: 4,
        // Message window size (recent messages fed to the model, post-strip)
        messageWindow: 8,
        // Feature toggles — users may want only thoughts or only intentions
        generateThoughts: true,
        generateIntentions: true,
    },
    logPrefix: '[MWT:Interiority]',
});

export { getSettings, saveSettings, hasValidSettings };

export function syncGlobalSettings(patch) {
    return syncSharedConnectionSettings(getSettings, saveSettings, patch, '[MWT:Interiority]');
}

// ─── Shared mutable state ────────────────────────────────────────────────────

export const state = {
    /** @type {HTMLElement|null} Parent modal element */
    modal: null,
    /** @type {HTMLElement|null} Cached tab content element */
    contentEl: null,

    /** Whether a generation is in progress */
    isGenerating: false,

    /** Serialised promise chain so scans never race each other or the knowledge tracker */
    workQueue: Promise.resolve(),

    /** Last observed chat length, for bulk-delete adjustment */
    lastChatLength: 0,
};

// ─── Data access (chat metadata) ─────────────────────────────────────────────

/**
 * Get the interiority data object from chat metadata.
 * Creates it (with defaults) if it doesn't exist yet.
 * @returns {object}
 */
export function getInteriorityData() {
    const meta = getChatMeta();
    if (!meta[META_KEY]) {
        meta[META_KEY] = {
            enabled: true,
            ledger: [],
            perMessage: {},
        };
    }
    if (!Array.isArray(meta[META_KEY].ledger)) {
        meta[META_KEY].ledger = [];
    }
    if (!meta[META_KEY].perMessage || typeof meta[META_KEY].perMessage !== 'object') {
        meta[META_KEY].perMessage = {};
    }
    return meta[META_KEY];
}

/**
 * Save the interiority data object back to chat metadata and persist.
 * @param {object} data
 */
export function saveInteriorityData(data) {
    const meta = getChatMeta();
    meta[META_KEY] = data;
    persistChatMeta();
}

/**
 * Merge a patch into the interiority data and persist.
 * @param {object} patch
 */
export function patchInteriorityData(patch) {
    const current = getInteriorityData();
    const next = { ...current, ...patch };
    saveInteriorityData(next);
    return next;
}

// ─── Ledger helpers ──────────────────────────────────────────────────────────

/**
 * Get the current intentions ledger.
 * @returns {Array<object>}
 */
export function getLedger() {
    return getInteriorityData().ledger;
}

/**
 * Get all ledger entries for a specific NPC (case-insensitive name match).
 * @param {string} npcName
 * @returns {Array<object>}
 */
export function getLedgerEntriesForNpc(npcName) {
    if (!npcName) return [];
    const lower = npcName.toLowerCase();
    return getLedger().filter(e => String(e.npc).toLowerCase() === lower);
}

/**
 * Add a new intention to the ledger.
 * Assigns a unique id and `since` timestamp.
 * @param {object} entry - { npc, action, trigger }
 * @param {string} [since] - in-world time label
 * @param {number} [msgIdx] - message index when declared
 */
export function addLedgerEntry(entry, since, msgIdx) {
    const data = getInteriorityData();
    const id = generateEntryId();
    const fullEntry = {
        id,
        npc: String(entry.npc || 'Unknown').trim(),
        action: String(entry.action || '').trim(),
        trigger: String(entry.trigger || '').trim(),
        since: since || '',
        declaredMsgIdx: typeof msgIdx === 'number' ? msgIdx : null,
    };
    data.ledger.push(fullEntry);
    saveInteriorityData(data);
    return fullEntry;
}

/**
 * Update a single ledger entry by id (merge patch).
 * Only action, trigger, npc, and since fields are user-editable.
 * @param {string} id
 * @param {object} patch - fields to update (e.g. { action, trigger })
 * @returns {object|null} the updated entry, or null if not found
 */
export function updateLedgerEntry(id, patch) {
    if (!id) return null;
    const data = getInteriorityData();
    const entry = data.ledger.find(e => e.id === id);
    if (!entry) return null;

    if (patch.npc !== undefined) entry.npc = String(patch.npc).trim() || entry.npc;
    if (patch.action !== undefined) entry.action = String(patch.action).trim();
    if (patch.trigger !== undefined) entry.trigger = String(patch.trigger).trim();
    if (patch.since !== undefined) entry.since = String(patch.since).trim();

    saveInteriorityData(data);
    return entry;
}

/**
 * Remove ledger entries by id.
 * @param {string[]} ids
 */
export function removeLedgerEntries(ids) {
    if (!ids || !ids.length) return;
    const idSet = new Set(ids);
    const data = getInteriorityData();
    data.ledger = data.ledger.filter(e => !idSet.has(e.id));
    saveInteriorityData(data);
}

/**
 * Replace the entire ledger (e.g. on rollback).
 * @param {Array<object>} newLedger
 */
export function setLedger(newLedger) {
    patchInteriorityData({ ledger: Array.isArray(newLedger) ? newLedger : [] });
}

/**
 * Remove any ledger entries owned by the human user ({{user}} / name1).
 *
 * Migration/cleanup for chats created before the getUserNames roster fix,
 * where the porous getPlayerNames filter could let a player-named intention
 * into the ledger. Such entries are excluded from the roster now, so they
 * would never be evaluated (executed/dropped) again — they'd linger in the
 * injection forever. This purges them once, at chat load.
 *
 * @returns {boolean} true if any entries were removed
 */
export function purgeUserLedgerEntries() {
    const userNames = getUserNames({ lower: true });
    if (userNames.size === 0) return false;

    const data = getInteriorityData();
    const before = data.ledger.length;
    data.ledger = data.ledger.filter(
        e => !userNames.has(String(e.npc).toLowerCase().trim())
    );

    const removed = before - data.ledger.length;
    if (removed > 0) {
        saveInteriorityData(data);
        console.log(`[MWT:Interiority] Purged ${removed} stale user ledger entr${removed === 1 ? 'y' : 'ies'}.`);
        return true;
    }
    return false;
}

/**
 * Check whether an action+trigger combination already exists in the ledger
 * for a given NPC (string-match dedup, per §8 of the design).
 * @param {string} npc
 * @param {string} action
 * @param {string} trigger
 * @returns {boolean}
 */
export function hasDuplicateIntention(npc, action, trigger) {
    const lower = String(npc).toLowerCase();
    const a = String(action).trim().toLowerCase();
    const t = String(trigger).trim().toLowerCase();
    return getLedger().some(e =>
        String(e.npc).toLowerCase() === lower &&
        String(e.action).trim().toLowerCase() === a &&
        String(e.trigger).trim().toLowerCase() === t
    );
}

// ─── Manual entries (user-authored intentions) ───────────────────────────────

/**
 * Add a manually-authored intention to the ledger.
 *
 * Manual entries are tagged with `manual: true` so they can be visually
 * differentiated in the UI and preserved across swipe/edit/delete rollbacks
 * (engine-generated entries are rolled back via ledgerSnapshot; manual
 * entries are user-authored state that should survive rollback).
 *
 * @param {object} entry - { npc, action, trigger, since }
 * @returns {object} the created ledger entry
 */
export function addManualLedgerEntry(entry) {
    const data = getInteriorityData();
    const id = generateEntryId();
    const since = String(entry.since || '').trim() || getWorldTime();
    const fullEntry = {
        id,
        npc: String(entry.npc || 'Unknown').trim(),
        action: String(entry.action || '').trim(),
        trigger: String(entry.trigger || '').trim(),
        since,
        declaredMsgIdx: null,
        manual: true,
    };
    data.ledger.push(fullEntry);
    saveInteriorityData(data);
    return fullEntry;
}

/**
 * Restore a ledger snapshot while preserving manual entries.
 *
 * On swipe/edit/delete, engine-generated ledger state is rolled back to the
 * snapshot taken before that message's generation. Manual entries are
 * user-authored state — they must survive rollback so the user's intentions
 * don't silently vanish.
 *
 * Entries from the snapshot that have the same id as a current manual entry
 * are skipped (the manual entry wins, since it may have been edited).
 *
 * @param {Array<object>} snapshot - the ledger snapshot to restore
 */
export function restoreLedgerSnapshot(snapshot) {
    const current = getLedger();
    const snapIds = new Set((snapshot || []).map(e => e.id));

    // Manual entries that aren't already in the snapshot survive the rollback.
    const manualSurvivors = current.filter(
        e => e.manual === true && !snapIds.has(e.id)
    );

    const restored = [...(snapshot || []), ...manualSurvivors];
    setLedger(restored);
}

// ─── Stable message-key utilities ────────────────────────────────────────────

/**
 * Resolve a chat-array index to a stable perMessage key based on the
 * message's `send_date` property.
 *
 * SillyTavern stamps each message with `send_date` at creation time. This
 * value never changes — even when Inline Summary, bulk-delete, or any
 * other tool shrinks/reorders the chat array. Keying perMessage entries
 * by `send_date` instead of by positional index makes thoughts immune to
 * array shifts: a thought stored for message X will always be associated
 * with message X, regardless of how many messages are inserted or removed
 * before it.
 *
 * @param {number} msgIdx - chat-array index
 * @returns {string|null} stable key like 'sd-1689123456789', or null
 */
export function getMsgKeyForIndex(msgIdx) {
    if (typeof msgIdx !== 'number' || msgIdx < 0) return null;
    const chat = getChat();
    const msg = chat[msgIdx];
    if (!msg || !msg.send_date) return null;
    return `${MSG_KEY_PREFIX}${msg.send_date}`;
}

/**
 * Build a reverse-lookup map from stable msgKey → chat-array index.
 * Used by renderers that iterate perMessage keys but need the index to
 * locate the corresponding DOM element (`.mes[mesid="N"]`).
 *
 * @returns {Map<string, number>}
 */
export function buildKeyToIndexMap() {
    const chat = getChat();
    const map = new Map();
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (msg && msg.send_date) {
            map.set(`${MSG_KEY_PREFIX}${msg.send_date}`, i);
        }
    }
    return map;
}

// ─── Per-message helpers (stable-key based) ──────────────────────────────────

/**
 * Get the per-message data for a specific message key.
 * @param {string} msgKey - stable key from getMsgKeyForIndex()
 * @returns {object|null}
 */
export function getPerMessage(msgKey) {
    if (!msgKey) return null;
    const data = getInteriorityData();
    return data.perMessage[msgKey] || null;
}

/**
 * Store per-message data (reactions + ledger snapshot) for a message key.
 * @param {string} msgKey - stable key from getMsgKeyForIndex()
 * @param {object} entry - { reactions, ledgerSnapshot, generatedAt }
 */
export function setPerMessage(msgKey, entry) {
    if (!msgKey) return;
    const data = getInteriorityData();
    data.perMessage[msgKey] = entry;
    saveInteriorityData(data);
}

/**
 * Delete per-message data for a message key.
 * Returns the deleted entry (for ledger snapshot restoration), or null.
 * @param {string} msgKey
 * @returns {object|null}
 */
export function deletePerMessage(msgKey) {
    if (!msgKey) return null;
    const data = getInteriorityData();
    const deleted = data.perMessage[msgKey] || null;
    delete data.perMessage[msgKey];
    saveInteriorityData(data);
    return deleted;
}

/**
 * Get all perMessage keys (stable `sd-*` keys), sorted by generatedAt
 * descending (newest first).
 * @returns {string[]}
 */
export function getPerMessageKeys() {
    const data = getInteriorityData();
    const entries = Object.entries(data.perMessage)
        .filter(([key, val]) => key.startsWith(MSG_KEY_PREFIX) && val);
    entries.sort((a, b) => (b[1].generatedAt || 0) - (a[1].generatedAt || 0));
    return entries.map(([key]) => key);
}

// ─── Migration (index-based → send_date-based keys) ──────────────────────────

/**
 * Migrate old numeric-index perMessage keys to stable send_date-based keys.
 *
 * For each legacy numeric key "N", looks up chat[N].send_date and rewrites
 * the key to "sd-<send_date>". If the chat no longer has a message at
 * position N (e.g. Inline Summary already shrank the array), the entry is
 * orphaned and dropped — its thoughts referenced a message that no longer
 * exists at that position, and retaining them risks future collisions.
 *
 * Safe to call repeatedly: keys already in `sd-*` form are left as-is,
 * and a `keyMigrationDone` flag prevents redundant work.
 *
 * @returns {number} count of keys migrated
 */
export function migrateIndexKeys() {
    const data = getInteriorityData();
    if (data.keyMigrationDone) return 0;

    const chat = getChat();
    const perMessage = data.perMessage;
    let migrated = 0;
    let dropped = 0;
    const newPerMessage = {};

    for (const [key, val] of Object.entries(perMessage)) {
        if (key.startsWith(MSG_KEY_PREFIX)) {
            // Already in stable form
            newPerMessage[key] = val;
            continue;
        }
        // Try to interpret as a legacy numeric index
        const idx = Number(key);
        if (Number.isFinite(idx) && idx >= 0 && idx < chat.length) {
            const msg = chat[idx];
            if (msg && msg.send_date) {
                const newKey = `${MSG_KEY_PREFIX}${msg.send_date}`;
                newPerMessage[newKey] = val;
                migrated++;
                continue;
            }
        }
        // Orphaned — can't map to any current message
        dropped++;
    }

    data.perMessage = newPerMessage;
    data.keyMigrationDone = true;
    saveInteriorityData(data);

    if (migrated > 0 || dropped > 0) {
        console.log(`[MWT:Interiority] Key migration: ${migrated} migrated, ${dropped} orphaned entr${dropped === 1 ? 'y' : 'ies'} dropped.`);
    }
    return migrated;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Generate a short unique ID for a ledger entry.
 * Format: 'i-' + base36 timestamp + 4 hex chars. The timestamp component
 * keeps ids unique across a long chat (executed/dropped matching is
 * id-based, so collisions would misroute ledger mutations).
 */
function generateEntryId() {
    return `i-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
}

/**
 * Extract the in-world time label from the world state document.
 * Looks for a `Time:` header. Returns empty string if unavailable.
 *
 * Shared between data.js (manual entry creation) and generation.js (engine
 * entry creation) so both stamp the same `since` value.
 *
 * @returns {string}
 */
export function getWorldTime() {
    const ws = getCurrentWorldState();
    if (!ws) return '';
    const m = ws.match(/^Time:\s*(.+)$/im);
    return m ? m[1].trim() : '';
}
