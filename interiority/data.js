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
 *         manual, turnsOpen,
 *                  ↑ optional   ↑ age in generation turns
 *         status, wakeHint }
 *           ↑ 'active'|'dormant' (§20)   ↑ free-text wake condition
 *     ],
 *     turnCounter: 0,           ↑ incremented each generation (§20 lazy poll)
 *     deletedIntentions: [      ↑ tombstones for USER-deleted intentions
 *       { id, npc, actions: [...], triggers: [...], at }
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
    getChatMeta, persistChatMeta, preserveQuarantinedRecords, getUserNames,
    createSettingsManager, syncSharedConnectionSettings,
    getCurrentWorldState,
    getChat, getContextSafe,
} from '../core/index.js';
import { clonePlainData, prepareNextStoreValue } from '../core/schema.js';
import { interioritySchema } from './schema.js';

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

/** Max inner state line length (characters). See §18. */
export const MAX_INNER_STATE_LENGTH = 200;

/**
 * How often (in generation turns) the dormant-intentions lazy poll fires.
 * See §20 — a 100-turn wait costs ~10 micro-checks instead of 100 full
 * evaluations. The poll is always-on (dormancy strictly reduces cost); this
 * is the only knob.
 */
export const DORMANT_POLL_INTERVAL = 10;

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
        // Diagnostics (Phase 6): stamps this module's key onto API telemetry
        // (core/api.js apiModule() → captureApiCall) so per-module views — the
        // Health tab's last-run column,
        // MWT.diagnostics.lastApiCall('interiority') — actually key on it
        // instead of everything landing under 'api'.
        module: 'interiority',
        connectionProfileId: '',
        apiUrl: '',
        apiKey: '',
        modelName: '',
        maxTokens: 4000,
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
        // v2 split-call: when true AND both features are enabled, fire two
        // parallel calls (intentions + thoughts) instead of one unified call.
        // Default off = byte-identical v1 behavior. See §16.
        splitThoughts: false,
        // §21 v2 cost dials (only meaningful when splitThoughts is ON):
        // Optional separate connection profile for the thoughts (voice) call.
        // Empty = use the module connection. Lets a better model be pointed at
        // voice without paying for it on bookkeeping.
        thoughtsConnectionProfileId: '',
        // Run the (expensive) thoughts call only every N turns. 1 = every turn.
        // Intentions still run every turn; off-turns simply skip thoughts.
        thoughtsInterval: 1,
        // Restrict the rich thoughts context to NPCs that have a growth profile.
        // Unprofiled NPCs get no thought on a given turn (intentions unaffected).
        thoughtsProfiledOnly: false,
        // §20 dormant-poll interval (turns). Overridable per §21 ("the only knob").
        dormantPollInterval: 10,
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
 * Is this a usable store root (a plain object, not an array/primitive)?
 * A value that fails this test may be corrupt evidence — it is NEVER replaced
 * on the read path.
 */
function _isStoreRoot(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ─── Staged working copy (read cache) ────────────────────────────────────────
//
// getInteriorityData() hands out a DETACHED copy so callers cannot mutate chat
// metadata before saveInteriorityData() validates. Cloning on EVERY read made
// that copy O(store) per call, and the read accessors are the hot path: a
// single getLedger() measured ~46 ms on a 400-message chat whose perMessage
// entries carry the usual per-message ledgerSnapshot (~3 MB store), and
// core/ui.js runs getTotalTokens() + getLedgerCount() — two full clones —
// every 5 seconds, with renderThoughtsList() doing 20 more and the generation
// prompt one per roster NPC. That is the whole §7.2 budget spent on copying.
//
// The copy is therefore STAGED once and reused (same object) while the live
// store it was taken from is unchanged — the same model knowledge/evidence.js
// uses, and the same shared-view semantics callers had back when reads handed
// out the live object: several held references all see each other before the
// save. A commit replaces the live object with a fresh one, so the identity
// check below invalidates the cache on its own; a chat switch does too.
let _stagedInteriority = null;
let _stagedInteriorityBase = undefined;

function _resetInteriorityStaging() {
    _stagedInteriority = null;
    _stagedInteriorityBase = undefined;
}

/**
 * A REFUSED write drops the staged copy, so "the previous value was kept" is
 * true of what the module goes on to read, not only of what is in metadata.
 *
 * Callers mutate the working copy in place and then hand it to the write seam.
 * Without this, a refusal would leave those mutations sitting in the cached
 * copy that every later read returns — the module would keep operating on data
 * the seam declined to persist and re-propose it on every subsequent save. The
 * next read re-stages from the untouched live store instead.
 */
function _refuseWrite() {
    _resetInteriorityStaging();
}

/**
 * Get the interiority data object from chat metadata, as a DETACHED working
 * copy.
 *
 * Reads never canonicalize the live store (the write seam owns that), and now
 * never HAND OUT the live object either: a fully detached deep copy means a
 * caller's mutations — nested arrays, perMessage records, scalars — cannot
 * touch chat metadata before {@link saveInteriorityData} validates the
 * proposal. This is what lets the write seam quarantine what a proposal
 * displaces: a stored turnCounter of "RAW-BAD" is still sitting in the live
 * value when incrementTurnCounter() commits 1, so the rejected raw value is
 * preserved whole (§5.2) instead of being overwritten before validation ever
 * sees it.
 *
 * What the caller gets:
 *   - a genuinely ABSENT root (undefined/null) → a DETACHED canonical default
 *     (the store is created only when a checked write commits it);
 *   - an UNREADABLE root (a string/number/array that survived in metadata) →
 *     a DETACHED default, while the stored raw value stays untouched for the
 *     write seam to refuse closed on;
 *   - a valid root → a DETACHED deep copy with invalid
 *     `ledger`/`perMessage`/`deletedIntentions` containers sanitized, so
 *     callers never crash on garbage — the live raw container values ride the
 *     next checked write into quarantine.
 *
 * Mutating the copy only sticks when it is passed back to
 * saveInteriorityData(); an unsaved mutation is simply discarded.
 *
 * The copy is STAGED, not rebuilt per call: the same object comes back while
 * the live store is unchanged, so the read accessors stay O(1) instead of
 * deep-cloning the whole store on every getLedger()/getPerMessage() (see the
 * staging comment above). A committed write installs a new live object, which
 * invalidates the cache by identity.
 *
 * @returns {object}
 */
export function getInteriorityData() {
    const raw = getChatMeta()?.[META_KEY];
    if (!_isStoreRoot(raw)) {
        _resetInteriorityStaging();
        return interioritySchema.createDefault();
    }
    if (_stagedInteriority !== null && _stagedInteriorityBase === raw) {
        return _stagedInteriority;
    }
    const working = clonePlainData(raw);
    if (!Array.isArray(working.ledger)) working.ledger = [];
    if (!_isStoreRoot(working.perMessage)) working.perMessage = {};
    if (!Array.isArray(working.deletedIntentions)) working.deletedIntentions = [];
    _stagedInteriority = working;
    _stagedInteriorityBase = raw;
    return working;
}

/**
 * Save the interiority data object back to chat metadata and persist.
 *
 * The Interiority write seam (design §8, Part 3): the COMPLETE proposed next
 * store is validated by the registered interiority schema before anything is
 * persisted. The write either commits CANONICAL data or, on a fatal root
 * problem, leaves the previous value intact. DEFER findings (legacy
 * perMessage keys pending the chat-dependent conversion, design §7.5) do NOT
 * refuse the write — the validator retained those entries, and freezing the
 * module until conversion would deadlock the conversion itself; they are
 * reported so the preparing state stays visible.
 *
 * Because reads no longer canonicalize the live store, the LIVE value is
 * validated as this write's base: a present-but-unreadable root fails closed
 * (the previous value is kept), and when the caller's proposal is a sanitized
 * view that displaces invalid live containers, those containers' schema
 * findings ride this same commit's quarantine preservation (§5.2) — the raw
 * values stay recoverable instead of being silently replaced.
 *
 * @param {object} data
 * @returns {object} the committed canonical value, or the PREVIOUS value that
 *   was kept on refusal (so callers that re-read stay correct).
 */
export function saveInteriorityData(data) {
    const meta = getChatMeta();
    if (!meta) return undefined;
    // Full-replacement seam: garbage input must never be silently swapped for
    // the schema default — that would erase the live store on a bad caller.
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        console.warn('[MWT:Interiority] Write refused — interiority data must be an object; the previous value was kept.');
        _refuseWrite();
        return meta[META_KEY];
    }
    const live = meta[META_KEY];
    const next = prepareNextStoreValue(interioritySchema, live, data);
    if (!next.ok) {
        console.warn('[MWT:Interiority] Write refused — the proposed update failed schema validation; the previous value was kept.', next.issues);
        _refuseWrite();
        return live;
    }
    for (const issue of next.issues) {
        console.warn(`[MWT:Interiority] ${issue.severity}: ${issue.message}`);
    }
    // §5.2: reads hand out a fully DETACHED working copy, so every proposal
    // displaces whatever it changed in the live value — invalid containers,
    // records, or scalars (e.g. a stored "RAW-BAD" turnCounter) still sit in
    // live metadata. Surface the live value's findings here — in the SAME
    // commit — so those raw values are quarantined (preserved whole) exactly
    // like records the validator rejects from the proposal itself. The guard
    // only skips the extra pass for an in-place save (proposal IS the live
    // object), which cannot happen through getInteriorityData() anymore but
    // is kept for safety since this seam is exported.
    let preserveIssues = next.issues;
    if (live !== data && _isStoreRoot(live)) {
        try {
            preserveIssues = [...next.issues, ...interioritySchema.validate(live).issues];
        } catch { /* a throwing validator on the live value must not block the
                     already-validated proposal; its own findings ride below */ }
    }
    // §5.2: the canonical write is only allowed to commit if its rejected
    // records were preserved. A refused quarantine container means they cannot
    // be — leave the previous value intact instead.
    const preserved = preserveQuarantinedRecords(interioritySchema.id, preserveIssues, { sourceVersion: interioritySchema.currentVersion });
    if (!preserved.ok) {
        console.warn(`[MWT:Interiority] Write refused — quarantined records could not be preserved (${preserved.reason}); the previous value was kept.`);
        _refuseWrite();
        return live;
    }
    // Commit a fully DETACHED clone. The validator builds its canonical value
    // AROUND the proposal — fresh containers, but the SAME nested records — so
    // committing `next.data` as-is would alias the caller's working copy into
    // chat metadata, and a later edit to a held ledger entry or perMessage
    // record would land in metadata before the next validation could see or
    // refuse it. (The same aliasing the evidence seam closes.) Installing a new
    // object also invalidates the read cache by identity, so the next read
    // re-stages from what was actually committed.
    const committed = clonePlainData(next.data);
    meta[META_KEY] = committed;
    persistChatMeta();
    return committed;
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
    // §20: scheduled intentions start dormant; immediate/event are active.
    if (entry.status === 'dormant') {
        fullEntry.status = 'dormant';
        fullEntry.wakeHint = String(entry.wakeHint || '').trim();
    }
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

    // Preserve the text this entry had BEFORE the user first edited it.
    //
    // hasDuplicateIntention matches action+trigger as exact strings, so
    // correcting an entry is exactly what stops the engine recognising its own
    // intention: the next generation re-proposes it from unchanged story
    // context, the strings no longer match, and the original lands again as a
    // brand-new entry beside the correction. Keeping the pre-edit text as a
    // second dedup key closes that loop.
    //
    // Recorded ONCE, on the first edit. The engine only ever re-proposes what
    // IT wrote, so a later edit must not overwrite the original with the user's
    // own intermediate wording.
    const rememberOriginal = (field) => {
        const originalField = `original${field[0].toUpperCase()}${field.slice(1)}`;
        if (entry[originalField] === undefined) entry[originalField] = entry[field];
    };
    if (patch.action !== undefined && String(patch.action).trim() !== entry.action) {
        rememberOriginal('action');
    }
    if (patch.trigger !== undefined && String(patch.trigger).trim() !== entry.trigger) {
        rememberOriginal('trigger');
    }

    if (patch.npc !== undefined) entry.npc = String(patch.npc).trim() || entry.npc;
    if (patch.action !== undefined) entry.action = String(patch.action).trim();
    if (patch.trigger !== undefined) entry.trigger = String(patch.trigger).trim();
    if (patch.since !== undefined) entry.since = String(patch.since).trim();

    // The text is now user-authored, whoever first wrote it. This is what tells
    // restoreLedgerSnapshot to keep the correction instead of reverting to the
    // engine's pre-edit wording held in the snapshot.
    entry.manual = true;

    saveInteriorityData(data);
    return entry;
}

/** Fields the user can edit from the panel — the ones their edit owns. */
const USER_EDITED_FIELDS = ['npc', 'action', 'trigger', 'since', 'originalAction', 'originalTrigger'];

/**
 * Remove ledger entries by id.
 *
 * @param {string[]} ids
 * @param {object} [opts]
 * @param {boolean} [opts.tombstone=false] - record a tombstone so the entry
 *   cannot come back. Set ONLY for user-initiated deletions — see
 *   {@link getDeletedIntentions} for why the engine's own removals must not.
 */
export function removeLedgerEntries(ids, { tombstone = false } = {}) {
    if (!ids || !ids.length) return;
    const idSet = new Set(ids);
    const data = getInteriorityData();
    const removed = data.ledger.filter(e => idSet.has(e.id));
    data.ledger = data.ledger.filter(e => !idSet.has(e.id));
    if (tombstone && removed.length > 0) _tombstone(data, removed);
    saveInteriorityData(data);
}

// ─── Deletion tombstones ─────────────────────────────────────────────────────
//
// Deleting an intention used to leave no trace, and two things brought it
// straight back:
//
//   1. hasDuplicateIntention only ever consulted the LIVE ledger. Once the
//      entry was gone there was nothing left to match, so the next generation
//      re-proposed it from story context that had not changed and it landed as
//      a brand-new entry. Scheduled entries showed it worst — they sit in the
//      ledger for many turns, so they get many more chances.
//   2. restoreLedgerSnapshot restored every entry in the snapshot verbatim. A
//      swipe or message edit whose snapshot predated the deletion resurrected
//      the entry immediately, id, `since` and all — no new generation needed.
//
// This module already holds the principle that user-authored state survives a
// rollback: `manual` entries survive, and USER_EDITED_FIELDS win the merge. A
// deletion is the same kind of statement and was the one that did not stick.
//
// Only USER deletions are tombstoned. The engine's own removals (executed,
// dropped) are lifecycle events, not refusals — an NPC who calls Dorothy today
// may well decide to call her again next week, and tombstoning that would
// quietly make the intention unrepeatable for the rest of the chat.

/** Cap on retained tombstones. Oldest are dropped first. */
const MAX_TOMBSTONES = 200;

const _normIntent = v => String(v ?? '').trim().toLowerCase();

/**
 * The action/trigger strings an entry should be matched on: its current text
 * plus, if the user edited it, the text the engine originally wrote. Triggers
 * are still recorded for completeness, but {@link isIntentionDeleted} now keys
 * only on NPC + action, so a deletion blocks the substantive intention the user
 * rejected even if the engine rewords the trigger when re-proposing it.
 */
function _intentionKeys(entry) {
    const actions = new Set([_normIntent(entry.action)]);
    const triggers = new Set([_normIntent(entry.trigger)]);
    if (entry.originalAction !== undefined) actions.add(_normIntent(entry.originalAction));
    if (entry.originalTrigger !== undefined) triggers.add(_normIntent(entry.originalTrigger));
    return { actions: [...actions], triggers: [...triggers] };
}

/** Record tombstones for `entries` into `data` (does not save). */
function _tombstone(data, entries) {
    if (!Array.isArray(data.deletedIntentions)) data.deletedIntentions = [];
    for (const entry of entries) {
        const { actions, triggers } = _intentionKeys(entry);
        data.deletedIntentions.push({
            id: entry.id,
            npc: _normIntent(entry.npc),
            actions,
            triggers,
            at: Date.now(),
        });
    }
    if (data.deletedIntentions.length > MAX_TOMBSTONES) {
        data.deletedIntentions = data.deletedIntentions.slice(-MAX_TOMBSTONES);
    }
}

/**
 * Every tombstone recorded in this chat.
 * @returns {Array<object>}
 */
export function getDeletedIntentions() {
    return getInteriorityData().deletedIntentions;
}

/**
 * Has the user deleted this intention?
 *
 * Matched on the SAME NPC + action only — deliberately broader than the live
 * {@link hasDuplicateIntention} check, which also keys on the trigger. The
 * trigger is free-form "when/why" prose, so the engine tends to re-propose a
 * rejected intention with the same NPC and action but a reworded trigger, and
 * the old three-way (npc + action + trigger) match let those slip straight back
 * in. The action is still the substantive part: a genuinely different action
 * for the same NPC is a different intention and still gets through.
 *
 * @param {string} npc
 * @param {string} action
 * @returns {boolean}
 */
export function isIntentionDeleted(npc, action) {
    const name = _normIntent(npc);
    const a = _normIntent(action);
    return getDeletedIntentions().some(d =>
        d.npc === name
        && Array.isArray(d.actions) && d.actions.includes(a)
    );
}

/**
 * Forget every tombstone, so previously deleted intentions may be proposed
 * again. The escape hatch for a deletion the user changes their mind about.
 *
 * @returns {number} how many tombstones were cleared
 */
export function clearDeletedIntentions() {
    const data = getInteriorityData();
    const count = data.deletedIntentions.length;
    if (count === 0) return 0;
    data.deletedIntentions = [];
    saveInteriorityData(data);
    return count;
}

/**
 * Replace the entire ledger (e.g. on rollback).
 * @param {Array<object>} newLedger
 */
export function setLedger(newLedger) {
    patchInteriorityData({ ledger: Array.isArray(newLedger) ? newLedger : [] });
}

/**
 * Remove any ledger entries owned by the human user.
 *
 * Cleanup for entries the roster filter let through. A leaked entry is worse
 * than inert: `getActiveLedger()` seeds the roster from the ledger every turn,
 * so the entry re-admits the player character to the roster indefinitely and
 * the injection keeps demanding the narrator act for the player.
 *
 * `userNames` should come from `generation.resolveUserNames()`, which widens
 * {{user}} through the knowledge registry. Called without it, this falls back
 * to the bare {{user}} name and will miss a leak that arrived under the user's
 * canonical registry name — which is exactly how they leaked in the first
 * place. This module is a leaf and cannot import the registry itself, so the
 * caller supplies the resolved set.
 *
 * @param {Set<string>|Iterable<string>} [userNames] - lower-cased user name forms
 * @returns {boolean} true if any entries were removed
 */
export function purgeUserLedgerEntries(userNames = getUserNames({ lower: true })) {
    const names = userNames instanceof Set ? userNames : new Set(userNames || []);
    if (names.size === 0) return false;

    const data = getInteriorityData();
    const before = data.ledger.length;
    data.ledger = data.ledger.filter(
        e => !names.has(String(e.npc).toLowerCase().trim())
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
    const norm = v => String(v ?? '').trim().toLowerCase();

    // An entry matches on its CURRENT text or on the text it had before the
    // user edited it (see updateLedgerEntry). Without the second key, correcting
    // an auto-generated intention makes the engine re-add its own original
    // alongside the correction, forever.
    //
    // Both fields fall back to the current value when no edit was recorded, so
    // this stays an exact-string match — an unedited entry behaves exactly as
    // before, and no genuinely new intention is suppressed.
    const live = getLedger().some((e) => {
        if (String(e.npc).toLowerCase() !== lower) return false;
        const actions = new Set([norm(e.action)]);
        const triggers = new Set([norm(e.trigger)]);
        if (e.originalAction !== undefined) actions.add(norm(e.originalAction));
        if (e.originalTrigger !== undefined) triggers.add(norm(e.originalTrigger));
        return actions.has(a) && triggers.has(t);
    });
    // A deleted intention is not in the ledger to match against, so without
    // this the next generation re-proposes it as brand new. The user already
    // said no once.
    return live || isIntentionDeleted(npc, action);
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
        // §20: dormant entries don't accrue age — their trigger is not yet
        // actionable, so there is nothing to evaluate. Aging resumes on wake.
        if (entry.status === 'dormant') continue;

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
 * For an entry present in BOTH, the user's edited text wins and the engine's
 * lifecycle fields (status, wakeHint, age) are still rolled back. This is what
 * the comment here always claimed; until now the code replaced the entry
 * wholesale, so a correction made to an auto-generated intention was silently
 * reverted by the next swipe.
 *
 * @param {Array<object>} snapshot - the ledger snapshot to restore
 */
export function restoreLedgerSnapshot(snapshot) {
    const current = getLedger();
    const snapIds = new Set((snapshot || []).map(e => e.id));
    const manualById = new Map(
        current.filter(e => e.manual === true).map(e => [e.id, e]),
    );

    // An entry the user EDITED keeps its id, so it is present in the snapshot —
    // and the snapshot holds the pre-edit text. Restoring wholesale therefore
    // undid the correction silently. Field-level merge instead: the user owns
    // the text they edited, the engine still owns the lifecycle fields, so a
    // dormancy or age change made in the timeline being discarded is still
    // rolled back rather than surviving on the back of an old hand-edit.
    const restored = (snapshot || []).map((snapEntry) => {
        const edited = manualById.get(snapEntry.id);
        if (!edited) return snapEntry;
        const merged = { ...snapEntry, manual: true };
        for (const field of USER_EDITED_FIELDS) {
            if (edited[field] !== undefined) merged[field] = edited[field];
        }
        return merged;
    });

    // Manual entries that aren't in the snapshot at all survive too — they were
    // authored after it was taken, so the rollback knows nothing about them.
    const manualSurvivors = current.filter(
        e => e.manual === true && !snapIds.has(e.id),
    );

    // A snapshot taken BEFORE the user deleted an entry still contains it, so
    // restoring wholesale resurrected it verbatim — id, `since` and all — on
    // the next swipe or message edit. A deletion is user-authored state and
    // survives a rollback for the same reason a manual entry does. Matched on
    // id first (the snapshot keeps it) and on text as a fallback, so a
    // re-proposed clone that picked up a fresh id is caught too.
    const tombstonedIds = new Set(getDeletedIntentions().map(d => d.id));
    const kept = [...restored, ...manualSurvivors].filter(
        e => !tombstonedIds.has(e.id) && !isIntentionDeleted(e.npc, e.action),
    );

    setLedger(kept);
}

// ─── Dormant intentions (v2 §20 — scheduling) ─────────────────────────────────

/**
 * Get all ACTIVE ledger entries (status !== 'dormant').
 *
 * Active entries are the only entries that cost narrator attention
 * (injection) and scan evaluation (executed/dropped checks) per turn.
 * Dormant entries are excluded from both. Legacy entries (no `status`
 * field) are treated as active — the safe default per §20.
 *
 * @returns {Array<object>}
 */
export function getActiveLedger() {
    return getLedger().filter(e => e.status !== 'dormant');
}

/**
 * Get all DORMANT ledger entries (status === 'dormant').
 *
 * Dormant entries are excluded from injection and per-turn evaluation, but
 * remain visible to the thoughts call (anticipation material) and in the
 * panel under a "Scheduled" section.
 *
 * @returns {Array<object>}
 */
export function getDormantLedger() {
    return getLedger().filter(e => e.status === 'dormant');
}

/**
 * Wake a dormant ledger entry — flip it to active and stamp its age.
 *
 * Per §20: on wake, stamp `turnsOpen = max(turnsOpen, gracePeriod)`. A woken
 * entry is an old intention whose trigger is imminent; if it woke inside
 * grace, the narrator could execute it next turn and the grace gate would
 * reject the executed-mark, recreating the stale-demand loop §8's design
 * note warns about.
 *
 * @param {string} id - ledger entry id
 * @param {number} [gracePeriod=0] - the current grace period setting
 * @returns {object|null} the woken entry, or null if not found / already active
 */
export function wakeLedgerEntry(id, gracePeriod = 0) {
    if (!id) return null;
    const data = getInteriorityData();
    const entry = data.ledger.find(e => e.id === id);
    if (!entry) return null;
    if (entry.status !== 'dormant') return entry; // already active — no-op

    entry.status = 'active';
    const floor = Math.max(0, Number(gracePeriod) || 0);
    entry.turnsOpen = Math.max(entry.turnsOpen || 0, floor);
    saveInteriorityData(data);
    return entry;
}

/**
 * Set an entry dormant (manual scheduling).
 *
 * @param {string} id - ledger entry id
 * @param {string} [wakeHint] - free-text wake condition (e.g. "harvest festival")
 * @returns {object|null} the updated entry, or null if not found
 */
export function setLedgerEntryDormant(id, wakeHint) {
    if (!id) return null;
    const data = getInteriorityData();
    const entry = data.ledger.find(e => e.id === id);
    if (!entry) return null;
    entry.status = 'dormant';
    if (wakeHint !== undefined) entry.wakeHint = String(wakeHint || '').trim();
    saveInteriorityData(data);
    return entry;
}

// ─── Turn counter (§20 lazy poll scheduling) ─────────────────────────────────

/**
 * Get the generation turn counter (§20 lazy-poll scheduler).
 *
 * Incremented once per successful generation. The dormant poll fires when
 * `counter % DORMANT_POLL_INTERVAL === 0` and there are dormant entries to
 * check. Lazily initialized to 0 for chats created before §20.
 *
 * @returns {number}
 */
export function getTurnCounter() {
    return Number(getInteriorityData().turnCounter) || 0;
}

/**
 * Increment and return the turn counter.
 * @returns {number} the new counter value
 */
export function incrementTurnCounter() {
    const data = getInteriorityData();
    data.turnCounter = (Number(data.turnCounter) || 0) + 1;
    saveInteriorityData(data);
    return data.turnCounter;
}

/**
 * Restore the turn counter to a rollback value (§9 swipe/edit/delete).
 *
 * The counter increments once per applied generation — and swipes cause
 * generations, so without a rollback every swipe cycle consumed a phantom
 * turn and dragged the dormant poll forward ahead of real story time. The
 * rollback paths restore the counter captured before the invalidated turn;
 * the regeneration then re-increments it, so a swipe cycle nets to zero.
 * Because {@link isDormantPollDue} looks ahead by one, a poll that fired on
 * the discarded turn fires again on the regenerated one and re-decides its
 * wakes against the surviving content.
 *
 * @param {number} value - counter value captured before the rolled-back turn
 */
export function restoreTurnCounter(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
    const data = getInteriorityData();
    data.turnCounter = Math.floor(value);
    saveInteriorityData(data);
}

/**
 * Get the effective dormant-poll interval (turns).
 *
 * §21 makes the poll interval the only dormancy knob: it is user-configurable
 * via `settings.dormantPollInterval`, clamped to [1, 200]. Falls back to the
 * {@link DORMANT_POLL_INTERVAL} constant for chats/settings that predate the
 * knob or when the value is invalid.
 *
 * @returns {number}
 */
export function getDormantPollInterval() {
    const raw = Number(getSettings().dormantPollInterval);
    if (!Number.isFinite(raw) || raw < 1) return DORMANT_POLL_INTERVAL;
    return Math.min(200, Math.floor(raw));
}

/**
 * Check whether the dormant poll is due this turn.
 *
 * The poll fires every {@link getDormantPollInterval} turns, but only when
 * there are dormant entries to check.
 *
 * @returns {boolean}
 */
export function isDormantPollDue() {
    if (getDormantLedger().length === 0) return false;
    const interval = getDormantPollInterval();
    // INTERIORITY-03: Look ahead by 1. The counter now increments only after
    // a *successful* generation, so the upcoming turn is (counter + 1). If
    // that upcoming turn lands on a poll interval, the poll fires at the
    // start of this turn so woken entries join the roster before the main
    // call. A failed/empty/dropped turn does not advance the counter, so the
    // poll simply re-checks on the next successful turn.
    return (getTurnCounter() + 1) % interval === 0;
}

// ─── Inner state (v2 §18 — persistent affective line) ────────────────────────

/**
 * Similarity threshold for the drift backstop (§18 containment #3).
 *
 * When a returned inner_state line is at least this similar (by normalized
 * word-set overlap) to the prior line, the prior line is kept verbatim.
 * This stops the miniature telephone loop where a model rewords an
 * unchanged mood every turn — each harmless rewording is one step of drift.
 *
 * 0.8 is aggressive by design: it intentionally swallows the occasional
 * genuine small escalation (one word in fourteen). A stuck line is visible
 * (it never changes) and recoverable (✎ edit); drift is invisible until
 * the mood has quietly rewritten itself.
 */
const INNER_STATE_DRIFT_THRESHOLD = 0.8;

/**
 * Get the inner-state store from interiority metadata.
 *
 * Stored as `{ [npc]: { line, updatedAt } }`. Lazily created if absent.
 * @returns {object} the innerStates map (mutating it requires saveInteriorityData)
 */
export function getInnerStates() {
    const data = getInteriorityData();
    if (!data.innerStates || typeof data.innerStates !== 'object') {
        data.innerStates = {};
    }
    return data.innerStates;
}

/**
 * Get a single NPC's inner-state line (null if none set).
 * Case-insensitive name lookup.
 * @param {string} npcName
 * @returns {string|null}
 */
export function getInnerState(npcName) {
    if (!npcName) return null;
    const states = getInnerStates();
    // Find a case-insensitive match so "Mara"/"mara"/"MARA" resolve to one line.
    const key = _findInnerStateKey(npcName, states);
    if (key == null) return null;
    const entry = states[key];
    return entry && typeof entry.line === 'string' ? entry.line : null;
}

/**
 * Set an NPC's inner-state line unconditionally (no drift guard).
 *
 * Used by manual ✎ edits (which must bypass the drift backstop) and by
 * {@link setInnerStateGuarded} after it has decided whether to keep the prior.
 *
 * `manual` is provenance, and it is what lets {@link restoreInnerStatesSnapshot}
 * tell a user's hand-edit apart from engine output. It deliberately defaults to
 * false rather than being sticky: once the engine legitimately moves an NPC's
 * mood on, that line is engine state again, so one hand-edit must not pin the
 * NPC against every future rollback.
 *
 * @param {string} npcName
 * @param {string} line - the new line (empty string clears the state)
 * @param {object} [opts]
 * @param {boolean} [opts.manual=false] - true when the user authored this line
 */
export function setInnerState(npcName, line, { manual = false } = {}) {
    if (!npcName) return;
    const trimmed = String(line || '').slice(0, MAX_INNER_STATE_LENGTH);
    const data = getInteriorityData();
    if (!data.innerStates || typeof data.innerStates !== 'object') {
        data.innerStates = {};
    }
    // Preserve an existing key's casing if present, else use the given name.
    const key = _findInnerStateKey(npcName, data.innerStates) ?? npcName.trim();
    if (trimmed) {
        data.innerStates[key] = { line: trimmed, updatedAt: Date.now(), manual: !!manual };
    } else {
        delete data.innerStates[key];
    }
    saveInteriorityData(data);
}

/**
 * Set an NPC's inner-state line with the §18 drift backstop applied.
 *
 * If `newLine` is near-identical (word-set overlap ≥ threshold) to the
 * current line, the current line is kept **verbatim** and not overwritten.
 * This enforces rule 2 of §18's containment: "update only from this turn's
 * events; otherwise carry the prior line verbatim" — mechanically, not by
 * prompt pleading, because models reword compulsively.
 *
 * @param {string} npcName
 * @param {string} newLine - the candidate line from the thoughts call
 * @returns {string} the line that is now stored (prior if near-identical, else newLine)
 */
export function setInnerStateGuarded(npcName, newLine) {
    if (!npcName) return '';
    const candidate = String(newLine || '').trim().slice(0, MAX_INNER_STATE_LENGTH);
    const prior = getInnerState(npcName);

    if (!candidate) {
        // No candidate → default to prior (§18: "defaulted to prior when missing").
        // (prior may be null; leave store untouched.)
        return prior || '';
    }
    if (prior && _innerStateSimilarity(prior, candidate) >= INNER_STATE_DRIFT_THRESHOLD) {
        // Near-identical → keep prior verbatim (no rewording drift).
        return prior;
    }
    // Genuinely different → store the new line.
    setInnerState(npcName, candidate);
    return candidate;
}

/**
 * Snapshot the entire inner-state store for rollback (§18).
 *
 * On swipe/edit/delete, inner states are rolled back to the snapshot taken
 * before that message's generation — otherwise a swipe rolls back Mara's
 * intentions but leaves her mood from the abandoned timeline.
 *
 * @returns {object} deep copy of the current innerStates map
 */
export function getInnerStatesSnapshot() {
    const states = getInnerStates();
    return JSON.parse(JSON.stringify(states));
}

/**
 * Restore an inner-state snapshot taken by {@link getInnerStatesSnapshot},
 * preserving hand-edited lines the snapshot never contained.
 *
 * This used to full-replace the map, which quietly destroyed user work: a mood
 * the user edited by hand at message 20 was wiped by swiping message 10, because
 * the message-10 snapshot predates the edit and knows nothing about it. A
 * snapshot records what the ENGINE produced, so restoring one must not revert
 * what the USER did outside it.
 *
 * The survivor rule deliberately mirrors {@link restoreLedgerSnapshot}: only
 * manual entries the snapshot does NOT contain are rescued. An NPC present in
 * the snapshot is engine state that the rollback exists to restore, so the
 * snapshot wins there. Keeping the two rollback paths identical is the point —
 * their divergence is what produced this bug.
 *
 * @param {object|null} snapshot - the snapshot to restore (null/undefined → no-op)
 */
export function restoreInnerStatesSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const data = getInteriorityData();
    const current = (data.innerStates && typeof data.innerStates === 'object')
        ? data.innerStates
        : {};
    const restored = JSON.parse(JSON.stringify(snapshot));

    // Names are matched case-insensitively here for the same reason
    // _findInnerStateKey does it: "Mara"/"mara" are one NPC, and a casing
    // difference between the snapshot and the live map must not resurrect a
    // duplicate entry alongside the restored one.
    const snapKeys = new Set(Object.keys(restored).map(k => k.toLowerCase().trim()));
    for (const [key, entry] of Object.entries(current)) {
        if (entry?.manual === true && !snapKeys.has(key.toLowerCase().trim())) {
            restored[key] = entry;
        }
    }

    data.innerStates = restored;
    saveInteriorityData(data);
}

/**
 * Tokenize an inner-state line for set-similarity comparison.
 *
 * Lowercased, punctuation-stripped, whitespace-split word set. Stopwords
 * are NOT removed — the line is short and content words like "wary"/"loud"
 * dominate, so removing common words would shrink the sets enough to
 * destabilize the metric. Punctuation stripping lets "wary; guilt" and
 * "wary, guilt" compare as equal.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function _tokenizeInnerState(text) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(Boolean)
    );
}

/**
 * Compute the Dice coefficient (2|A∩B| / (|A|+|B|)) over the word sets of
 * two inner-state lines.
 *
 * Dice is chosen over raw Jaccard because it's numerically stable on small
 * sets (it equals Jaccard under monotone transform). Both treat reorderings
 * ("wary of Jonah; guilt louder" vs "guilt louder; wary of Jonah") as the
 * same state, which edit distance (Levenshtein) does not. This is the
 * metric the design doc (§18) specifies.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} similarity in [0,1]
 */
function _innerStateSimilarity(a, b) {
    const setA = _tokenizeInnerState(a);
    const setB = _tokenizeInnerState(b);
    if (setA.size === 0 && setB.size === 0) return 1; // both empty → identical
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const w of setA) if (setB.has(w)) inter++;
    return (2 * inter) / (setA.size + setB.size);
}

/**
 * Find the stored key matching `npcName` case-insensitively (or null).
 * @param {string} npcName
 * @param {object} states
 * @returns {string|null}
 */
function _findInnerStateKey(npcName, states) {
    const lower = String(npcName).toLowerCase().trim();
    for (const k of Object.keys(states)) {
        if (k.toLowerCase() === lower) return k;
    }
    return null;
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
                // INTERIORITY-05: Detect a collision — two legacy keys
                // (e.g. two send_date keys pointing at the same message)
                // resolve to one UUID. The old code silently overwrote the
                // first entry with the second, losing data. Merge instead:
                // keep the newer `val` (higher generatedAt) as the primary
                // entry but preserve the displaced one under a collision key.
                if (newPerMessage[newKey]) {
                    const existing = newPerMessage[newKey];
                    const existingTs = existing.generatedAt || 0;
                    const newTs = val.generatedAt || 0;
                    if (newTs > existingTs) {
                        // Newer one wins; keep the older under a collision suffix
                        let suffix = 2;
                        while (newPerMessage[`${newKey}#col${suffix}`]) suffix++;
                        newPerMessage[`${newKey}#col${suffix}`] = existing;
                        newPerMessage[newKey] = val;
                    } else {
                        // Existing is newer; keep the new one under a collision suffix
                        let suffix = 2;
                        while (newPerMessage[`${newKey}#col${suffix}`]) suffix++;
                        newPerMessage[`${newKey}#col${suffix}`] = val;
                    }
                    console.warn(`[MWT:Interiority] Key migration collision: two legacy keys resolved to "${newKey}" — both entries preserved.`);
                } else {
                    newPerMessage[newKey] = val;
                }
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

// ─── Recent thoughts (v2 §17 — interior memory) ──────────────────────────────

/**
 * Collect an NPC's most recent thoughts from perMessage storage, returning
 * them in STORY order (newest message first), not wall-clock order.
 *
 * Used by the thoughts call (v2 §17) to feed an NPC's prior thoughts back as
 * `<recent_thoughts>` — the interior-memory input that lets worries evolve and
 * suspicions build instead of every turn generating from scratch.
 *
 * Sorts by the resolved chat-array index so that manually regenerating
 * thoughts on an old message doesn't make them the NPC's "most recent"
 * interior memory. Thoughts whose message no longer exists (no resolved
 * index) fall to the end, ordered by their `generatedAt` timestamp so the
 * ordering is still deterministic.
 *
 * @param {string} npcName - NPC name to match
 * @param {number} [count=4] - max thoughts to return
 * @returns {Array<{thought: string, type?: string, re?: string, msgIdx?: number}>}
 */
export function getRecentThoughtsForNpc(npcName, count = 4) {
    if (!npcName) return [];
    const lower = String(npcName).toLowerCase().trim();
    const keyToIndex = buildKeyToIndexMap();

    // Gather ALL matching reactions first (don't cap during collection), then
    // sort by story position and take the top `count`.
    const all = [];
    for (const [key, pm] of Object.entries(getInteriorityData().perMessage || {})) {
        if (!pm || !Array.isArray(pm.reactions)) continue;
        for (const r of pm.reactions) {
            if (String(r.npc).toLowerCase().trim() !== lower) continue;
            const idx = keyToIndex.get(key);
            all.push({
                thought: String(r.thought || ''),
                type: r.type || undefined,
                re: r.re || undefined,
                msgIdx: idx,
                // Story position: messages with no resolved index (deleted,
                // orphaned, or unhydrated) sort to the end. Use -1 so a
                // reverse-sort (newest-first) drops them last.
                _sortIdx: idx != null ? idx : -1,
                // Tiebreaker for entries sharing a story position or having none.
                _generatedAt: pm.generatedAt || 0,
            });
        }
    }

    // Sort newest-story-first. Entries with a real index sort by it (higher
    // index = newer message); entries without one sort to the end by their
    // wall-clock generation time. This keeps a manual regeneration on an old
    // message from displacing genuinely newer thoughts (item 8b fix).
    all.sort((a, b) => {
        if (a._sortIdx !== b._sortIdx) return b._sortIdx - a._sortIdx;
        return b._generatedAt - a._generatedAt;
    });

    return all.slice(0, count).map(({ _sortIdx, _generatedAt, ...rest }) => rest);
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
