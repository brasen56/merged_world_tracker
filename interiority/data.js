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
 *       { id, npc, action, trigger, since, declaredMsgIdx,
 *         manual, turnsOpen }
 *                  ↑ optional   ↑ age in generation turns
 *     ],
 *     perMessage: {
 *       'mu-<uuid>': {
 *         reactions: [ { npc, re, thought } ],
 *         ledgerSnapshot: [ ... ],
 *         generatedAt: 1699999999,
 *       }
 *     }
 *   }
 *
 * perMessage keys are stable identifiers derived from a per-message UUID
 * that Interiority stamps into `msg.extra.mwt_uuid` (prefixed 'mu-'). This
 * is the canonical place extensions stash per-message data, and it is
 * persisted with the chat. UUIDs are used instead of `send_date` because
 * `send_date` has only minute-resolution in some ST versions — two AI
 * messages in the same minute collide, silently overwriting the first
 * message's thoughts. Legacy keys ('sd-<send_date>' or numeric indices)
 * are migrated on chat load via migrateIndexKeys().
 */

import {
    getChatMeta, persistChatMeta, getUserNames,
    createSettingsManager, syncSharedConnectionSettings,
    getCurrentWorldState,
    getChat, getContextSafe,
} from '../core/index.js';

// ─── Aikobots v4 sparse-chat detection ───────────────────────────────────────
//
// The fork moved chat storage to SQLite with bounded range reads. The client
// chat array keeps the full logical .length, but only loaded ranges are
// hydrated; older slots are holes (undefined) until a background prefetch or
// history navigation fills them. Full-array scans (orphan cleanup, key
// migration) must be deferred until the chat is fully hydrated to avoid
// mass-deleting entries that reference unhydrated messages.
//
// isChatFullyHydrated() is exported from script.js on the fork. On upstream ST
// it doesn't exist, so isChatHydrated() always returns true (fully hydrated).

let _isChatFullyHydratedFn = null;
let _isChatFullyHydratedChecked = false;

/**
 * Lazy-load and cache the fork's isChatFullyHydrated function.
 * @returns {function|null}
 */
async function getHydrationChecker() {
    if (_isChatFullyHydratedChecked) return _isChatFullyHydratedFn;
    _isChatFullyHydratedChecked = true;
    try {
        const stScript = await import('../../../../../script.js');
        if (typeof stScript?.isChatFullyHydrated === 'function') {
            _isChatFullyHydratedFn = stScript.isChatFullyHydrated;
        }
    } catch { /* upstream ST — no hydration concept */ }
    return _isChatFullyHydratedFn;
}

/**
 * Returns true if the chat is fully hydrated (all messages loaded).
 * On upstream ST (no isChatFullyHydrated export), always returns true.
 * @returns {Promise<boolean>}
 */
export async function isChatHydrated() {
    const checker = await getHydrationChecker();
    if (!checker) return true; // upstream ST — always hydrated
    try { return checker(); } catch { return true; }
}

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
 * Prefix for stable perMessage keys based on a per-message UUID that
 * Interiority stamps into `msg.extra.mwt_uuid`. This is the canonical
 * place extensions stash per-message data, and it is persisted with the
 * chat. UUIDs are used instead of `send_date` because `send_date` has
 * only minute-resolution in some ST versions — two AI messages in the
 * same minute collide, silently overwriting the first message's thoughts.
 */
const MSG_KEY_PREFIX = 'mu-';

/**
 * Legacy prefix for keys based on SillyTavern's `send_date` property.
 * Older versions of Interiority keyed perMessage entries by send_date.
 * These are migrated to 'mu-*' keys on chat load via migrateIndexKeys().
 * Kept as a recognised prefix so orphan detection and key-to-index maps
 * continue to work for chats that haven't been migrated yet.
 */
const LEGACY_SD_KEY_PREFIX = 'sd-';

/** Property name under which we store the UUID in msg.extra. */
const MSG_UUID_EXTRA_KEY = 'mwt_uuid';

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
        // Minimum number of turns an intention must survive before it
        // can be executed or dropped. Prevents models from prematurely
        // erasing intentions before their trigger arrives.
        intentionGracePeriod: 2,
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
        turnsOpen: 0,
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
        turnsOpen: 0,
    };
    data.ledger.push(fullEntry);
    saveInteriorityData(data);
    return fullEntry;
}

// ─── Age tracking & grace period ─────────────────────────────────────────────

/**
 * Increment the turnsOpen counter for every ledger entry.
 *
 * Called once at the start of each validateAndApply cycle. This tracks
 * how many generation turns each intention has survived, enabling the
 * grace-period check that prevents models from prematurely executing
 * or dropping freshly-created intentions.
 *
 * Legacy entries (created before turnsOpen tracking was added) are
 * backfilled with a mature age (999) so existing intentions aren't
 * locked behind the newly-introduced grace period.
 */
export function incrementLedgerAges() {
    const data = getInteriorityData();
    let changed = false;
    for (const entry of data.ledger) {
        if (typeof entry.turnsOpen !== 'number') {
            // Legacy entry — treat as mature
            entry.turnsOpen = 999;
        } else {
            entry.turnsOpen++;
        }
        changed = true;
    }
    if (changed) saveInteriorityData(data);
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
 * Generate a UUID v4 string.
 * Uses crypto.randomUUID() when available, falls back to a manual
 * implementation for older browsers / non-secure contexts.
 *
 * @returns {string} UUID string
 */
function generateUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback: RFC 4122 v4 UUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Trigger a debounced save of the chat array (not just metadata).
 *
 * SillyTavern's `saveMetadataDebounced` only persists chatMetadata, not
 * the chat array itself. Since `msg.extra` lives on the message object
 * inside the chat array, stamping a UUID requires `saveChatDebounced`.
 *
 * This function is only called when we mutate `msg.extra`, not on every
 * perMessage read/write (those go through chatMetadata).
 */
function persistChat() {
    const ctx = getContextSafe();
    if (ctx?.saveChatDebounced) ctx.saveChatDebounced();
    else if (ctx?.saveChat) ctx.saveChat();
}

/**
 * Resolve a chat-array index to a stable perMessage key.
 *
 * Primary: the per-message UUID stamped in `msg.extra.mwt_uuid`. This is
 * created by {@link getOrCreateMsgKeyForIndex} and persisted with the chat.
 * UUIDs are collision-free, unlike `send_date` which has only minute
 * resolution in some ST versions.
 *
 * Fallback: `send_date` (prefixed 'sd-'), for messages that haven't had a
 * UUID stamped yet. This keeps reads working during the transition window
 * (e.g. before migration runs, or for messages created by other tools).
 *
 * @param {number} msgIdx - chat-array index
 * @returns {string|null} stable key like 'mu-<uuid>' or 'sd-<send_date>', or null
 */
export function getMsgKeyForIndex(msgIdx) {
    if (typeof msgIdx !== 'number' || msgIdx < 0) return null;
    const chat = getChat();
    const msg = chat[msgIdx];
    if (!msg) return null;
    // Primary: UUID stamped in msg.extra
    if (msg.extra?.[MSG_UUID_EXTRA_KEY]) {
        return `${MSG_KEY_PREFIX}${msg.extra[MSG_UUID_EXTRA_KEY]}`;
    }
    // Fallback: send_date (for messages not yet stamped)
    if (msg.send_date) {
        return `${LEGACY_SD_KEY_PREFIX}${msg.send_date}`;
    }
    return null;
}

/**
 * Resolve a chat-array index to a stable perMessage key, stamping a fresh
 * UUID into `msg.extra.mwt_uuid` if one doesn't exist yet.
 *
 * This is the canonical key-creation function: always use it when STORING
 * perMessage data. Read-only callers (renderers, orphan detection) should
 * use {@link getMsgKeyForIndex} instead to avoid unnecessary mutations.
 *
 * The UUID is persisted with the chat via `saveChatDebounced`, so it
 * survives reloads, Inline Summary, and any other tool that preserves
 * the chat array.
 *
 * @param {number} msgIdx - chat-array index
 * @returns {string|null} stable key like 'mu-<uuid>', or null
 */
export function getOrCreateMsgKeyForIndex(msgIdx) {
    if (typeof msgIdx !== 'number' || msgIdx < 0) return null;
    const chat = getChat();
    const msg = chat[msgIdx];
    if (!msg) return null;

    // If UUID already exists, return it (no mutation, no save)
    if (msg.extra?.[MSG_UUID_EXTRA_KEY]) {
        return `${MSG_KEY_PREFIX}${msg.extra[MSG_UUID_EXTRA_KEY]}`;
    }

    // Stamp a new UUID and persist
    const uuid = generateUuid();
    if (!msg.extra) msg.extra = {};
    msg.extra[MSG_UUID_EXTRA_KEY] = uuid;
    persistChat();

    return `${MSG_KEY_PREFIX}${uuid}`;
}

/**
 * Build a reverse-lookup map from stable msgKey → chat-array index.
 *
 * Maps BOTH 'mu-*' (UUID) and 'sd-*' (send_date) keys so that pre-migration
 * and post-migration entries can both resolve to their DOM elements.
 *
 * @returns {Map<string, number>}
 */
export function buildKeyToIndexMap() {
    const chat = getChat();
    const map = new Map();
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;
        // Primary: UUID key
        if (msg.extra?.[MSG_UUID_EXTRA_KEY]) {
            map.set(`${MSG_KEY_PREFIX}${msg.extra[MSG_UUID_EXTRA_KEY]}`, i);
        }
        // Legacy: send_date key (coexists with UUID until migration)
        if (msg.send_date) {
            map.set(`${LEGACY_SD_KEY_PREFIX}${msg.send_date}`, i);
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
 * Get all perMessage keys (stable `mu-*` or legacy `sd-*` keys), sorted
 * by generatedAt descending (newest first).
 * @returns {string[]}
 */
export function getPerMessageKeys() {
    const data = getInteriorityData();
    const entries = Object.entries(data.perMessage)
        .filter(([key, val]) =>
            (key.startsWith(MSG_KEY_PREFIX) || key.startsWith(LEGACY_SD_KEY_PREFIX)) && val
        );
    entries.sort((a, b) => (b[1].generatedAt || 0) - (a[1].generatedAt || 0));
    return entries.map(([key]) => key);
}

// ─── Migration (numeric / send_date → UUID-based keys) ───────────────────────

/**
 * Migrate old perMessage keys to stable UUID-based ('mu-*') keys.
 *
 * Handles two legacy formats:
 *
 * 1. **Numeric index keys** ("0", "1", "2", …) — the original positional
 *    scheme. For each numeric key "N", looks up chat[N], stamps a UUID via
 *    {@link getOrCreateMsgKeyForIndex}, and rewrites the key to "mu-<uuid>".
 *    If the chat no longer has a message at position N (e.g. Inline Summary
 *    already shrank the array), the entry is orphaned and dropped.
 *
 * 2. **send_date keys** ("sd-<send_date>") — the previous stable scheme.
 *    send_date has minute-resolution in some ST versions, so two messages
 *    in the same minute would collide. For each, we find the matching
 *    message, stamp a UUID, and rewrite to "mu-<uuid>".
 *
 * Keys already in "mu-*" form are left as-is. The `keyMigrationDone` flag
 * prevents redundant work on subsequent calls.
 *
 * @returns {number} count of keys migrated
 */
export async function migrateIndexKeys() {
    const data = getInteriorityData();
    if (data.keyMigrationDone) return 0;

    // Aikobots v4 sparse-chat guard: on the fork, the client chat array keeps
    // the full logical .length but only loaded ranges are hydrated. Iterating
    // the array before full hydration would make every unhydrated message look
    // absent, causing migration to drop entries that reference valid messages.
    // Defer migration until the chat is fully hydrated. On upstream ST,
    // isChatHydrated() always returns true.
    if (!(await isChatHydrated())) {
        console.log('[MWT:Interiority] Key migration deferred — chat not fully hydrated yet.');
        return 0;
    }

    const chat = getChat();
    const perMessage = data.perMessage;
    let migrated = 0;
    let dropped = 0;
    const newPerMessage = {};

    // Build a lookup from send_date → msgIdx so we can resolve 'sd-*' keys
    // without scanning the chat array for each one.
    const sendDateToIdx = new Map();
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.send_date) {
            sendDateToIdx.set(String(chat[i].send_date), i);
        }
    }

    for (const [key, val] of Object.entries(perMessage)) {
        if (key.startsWith(MSG_KEY_PREFIX)) {
            // Already in UUID form — keep as-is
            newPerMessage[key] = val;
            continue;
        }

        let msgIdx = null;

        // Resolve legacy send_date key ('sd-<send_date>')
        if (key.startsWith(LEGACY_SD_KEY_PREFIX)) {
            const sendDate = key.slice(LEGACY_SD_KEY_PREFIX.length);
            msgIdx = sendDateToIdx.has(sendDate) ? sendDateToIdx.get(sendDate) : null;
        } else {
            // Try numeric index ("0", "1", "2", …)
            const idx = Number(key);
            if (Number.isFinite(idx) && idx >= 0 && idx < chat.length) {
                msgIdx = idx;
            }
        }

        if (msgIdx != null) {
            // Stamp a UUID on the message and rewrite the key
            const newKey = getOrCreateMsgKeyForIndex(msgIdx);
            if (newKey) {
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
