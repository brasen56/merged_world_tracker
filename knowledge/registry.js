/**
 * knowledge/registry.js — NPC registry and State Tracker registry operations.
 *
 * Registries are flat { name: {...} } maps. They used to live in chat metadata,
 * which gave them a per-chat lifetime while the lorebook entries they point at
 * were global — so a new chat started from an empty registry and re-created
 * every entry as a duplicate. They now live inside the lorebook itself (see
 * store.js), which ties pointer and target to one file and one lifetime.
 *
 * These accessors stay synchronous: they read the store's in-memory cache,
 * which `hydrateCurrentBooks()` fills on chat change.
 */

import { getChat } from '../core/index.js';

import { state } from './state.js';
import { getLorebookName, getStateLorebookName } from './scope.js';
import { readField, writeField } from './store.js';

// ─── NPC Registry ────────────────────────────────────────────────────────────

export function getRegistry() {
    return readField(getLorebookName(), 'registry', {});
}

export function saveRegistry(reg) {
    // Store the flat map as-is. Nothing may merge a `lastUpdated` sibling into
    // it — callers iterate this map as { npcName: info } and a stray key would
    // be read as an NPC.
    writeField(getLorebookName(), 'registry', reg);
}

export function registerEntry(name, uid, type, keywords) {
    const reg = getRegistry();
    reg[name] = { uid, type, keywords: keywords || [name], lastUpdated: Date.now() };
    saveRegistry(reg);
}

export function isKnown(name) {
    // KNOWLEDGE-03: Route through the resolver so isKnown respects case/
    // given-name matching instead of requiring an exact key hit.
    const reg = getRegistry();
    const key = resolveRegistryKey(reg, name);
    return key != null && !!reg[key];
}

/**
 * KNOWLEDGE-03: The single accessor for looking up an NPC's registry info.
 *
 * Every boundary that needs an NPC's uid/type/keywords must go through here.
 * Direct `getRegistry()[name]` lookups silently miss when the model uses a
 * given name ("Mara") and the registry stores the full name ("Mara Vance"),
 * producing false "new NPC" proposals and duplicate lorebook entries.
 *
 * This function resolves the name through {@link resolveRegistryKey} (exact,
 * case-insensitive, then unambiguous given-name) and returns the info object
 * plus the canonical registry key it matched on.
 *
 * @param {string} name — the name to look up (model output, user input, etc.)
 * @returns {{key: string, info: object}|null} the registry entry, or null if
 *   no match (including when the name is ambiguous — fail closed)
 */
export function getRegistryEntry(name) {
    const reg = getRegistry();
    const key = resolveRegistryKey(reg, name);
    if (key == null) return null;
    const info = reg[key];
    return info ? { key, info } : null;
}

/**
 * Resolve an NPC name to its registry key.
 *
 * Registry keys and the names other modules hold are written by different
 * systems and do not agree on form. The world state `Present:` line is free
 * text from the world-state model and routinely uses given names ("Mara"),
 * while the registry is keyed on whatever the knowledge tracker first
 * recorded, often fuller ("Mara Vance"). An exact lookup silently returns
 * null for every such NPC — and callers read that as "this NPC has no entry",
 * which is a legitimate state for a genuinely new NPC, so nothing warns.
 *
 * Matching runs strictest-first:
 *   1. exact key
 *   2. case-insensitive exact
 *   3. given-name match, both directions — but ONLY when unambiguous
 *
 * Step 3 refuses to choose between two NPCs sharing a given name ("Mara
 * Vance" / "Mara Chen"). Registry entries gate access to a character's
 * dossier and secrets, so a wrong match would hand one character's private
 * material to another. No entry is always safer than the wrong entry.
 *
 * @param {object} reg — the registry map ({ [npcName]: info })
 * @param {string} name — the name to resolve
 * @returns {string|null} the matching registry key, or null
 */
export function resolveRegistryKey(reg, name) {
    if (!reg) return null;
    const wanted = String(name || '').toLowerCase().trim();
    if (!wanted) return null;

    // 1. Exact hit — cheap path. hasOwnProperty, not `reg[name] !== undefined`:
    // a bare lookup would match inherited keys ("constructor", "toString").
    if (Object.prototype.hasOwnProperty.call(reg, name)) return name;

    const keys = Object.keys(reg);

    // 2. Case-insensitive exact match.
    for (const key of keys) {
        if (key.toLowerCase().trim() === wanted) return key;
    }

    // 3. Given-name match, both directions:
    //      "Mara"       → registry "Mara Vance"
    //      "Mara Vance" → registry "Mara"
    const givenName = (s) => s.toLowerCase().trim().split(/\s+/)[0];
    const wantedGiven = givenName(wanted);
    const candidates = keys.filter(k => givenName(k) === wantedGiven);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
        console.warn(
            `[MWT:Knowledge] NPC name "${name}" is ambiguous — matches registry entries: ` +
            `${candidates.join(', ')}. Using no entry rather than risk exposing another ` +
            `character's dossier. Rename one to disambiguate.`
        );
    }
    return null;
}

// ─── Profile UID (NPC Profiles lorebook cross-reference) ─────────────────────
//
// The registry gains a `profileUid` field (parallel to `uid`) pointing at the
// NPC's entry in the "NPC Profiles" lorebook. This lets the editor cross-
// reference both entries. See NPC_GROWTH_BLUEPRINT.md §"How the two entries
// relate".

/**
 * Get the profile lorebook UID for an NPC, or null if none.
 * @param {string} name — NPC name
 * @returns {number|null}
 */
export function getProfileUid(name) {
    const reg = getRegistry();
    const key = resolveRegistryKey(reg, name);
    const info = key != null ? reg[key] : null;
    const uid = info?.profileUid;
    return (uid === null || uid === undefined) ? null : uid;
}

/**
 * Set the profile lorebook UID for an NPC (after writing the profile entry).
 *
 * Returns whether the uid was actually recorded. This used to fail silently
 * (`if (!reg[name]) return;`), which let a profile save report success while
 * recording nothing: the lorebook entry existed, the registry never pointed at
 * it, and the next save created a duplicate entry instead of overwriting.
 * A miss is now a loud, actionable warning.
 *
 * @param {string} name — NPC name
 * @param {number} uid — profile lorebook UID
 * @returns {boolean} true if recorded, false if no registry entry matched
 */
export function setProfileUid(name, uid) {
    const reg = getRegistry();
    const key = resolveRegistryKey(reg, name);
    if (key == null) {
        console.warn(
            `[MWT:Knowledge] Could not record profileUid ${uid} for "${name}" — no matching ` +
            `registry entry. The profile IS saved in the "NPC Profiles" lorebook, but nothing ` +
            `points at it, so the next save would create a duplicate. Known entries: ` +
            `${Object.keys(reg).join(', ') || '(none)'}.`
        );
        return false;
    }
    reg[key].profileUid = uid;
    saveRegistry(reg);
    return true;
}

export function findOrphans() {
    const reg = getRegistry();
    return Object.keys(reg).filter(name => reg[name].uid === null || reg[name].uid === undefined);
}

export function getAllNpcNames() { return Object.keys(getRegistry()); }

// ─── State Registry ──────────────────────────────────────────────────────────

export function getStateRegistry() {
    // Lives in the State Tracker book, alongside the entries it points at.
    return readField(getStateLorebookName(), 'stateRegistry', {});
}

export function saveStateRegistry(reg) {
    // Store the flat map as-is — same rationale as saveRegistry().
    writeField(getStateLorebookName(), 'stateRegistry', reg);
}

export function registerStateTracker(name, uid) {
    const reg = getStateRegistry();
    reg[name] = { uid, lastUpdatedMsg: 0, lastUpdatedAt: 0, enabled: true, alwaysUpdate: false };
    saveStateRegistry(reg);
}

export function unregisterStateTracker(name) {
    const reg = getStateRegistry();
    delete reg[name];
    saveStateRegistry(reg);
}

export function setStateTrackerEnabled(name, enabled) {
    const reg = getStateRegistry();
    if (reg[name]) { reg[name].enabled = enabled; saveStateRegistry(reg); }
}

export function setStateTrackerAlwaysUpdate(name, always) {
    const reg = getStateRegistry();
    if (reg[name]) { reg[name].alwaysUpdate = always; saveStateRegistry(reg); }
}

export function bumpStateTrackerTimestamp(name) {
    const reg = getStateRegistry();
    if (reg[name]) {
        reg[name].lastUpdatedMsg = getChat()?.length || 0;
        reg[name].lastUpdatedAt = Date.now();
        saveStateRegistry(reg);
    }
}

/**
 * Decrement every state tracker's `lastUpdatedMsg` by `removed`, clamped to >= 0.
 *
 * `lastUpdatedMsg` is stored as a raw chat length (`getChat()?.length`) at the
 * time of the last update. After a bulk delete shrinks the chat, that stored
 * length points past the end of the new (shorter) chat. The cooldown check
 * (`currentMsgIdx - lastUpdatedMsg < cooldownMsgs`) then keeps skipping the
 * tracker forever — the chat has to re-grow past the stale length before the
 * tracker runs again. This keeps the stored watermark aligned with the
 * shorter chat so the cooldown math stays meaningful.
 *
 * @param {number} removed — how many messages were deleted
 */
export function adjustStateTrackerLastUpdatedMsg(removed) {
    if (!Number.isFinite(removed) || removed <= 0) return;
    const reg = getStateRegistry();
    let changed = false;
    for (const name of Object.keys(reg)) {
        const cur = reg[name]?.lastUpdatedMsg;
        if (typeof cur === 'number' && cur > 0) {
            reg[name].lastUpdatedMsg = Math.max(0, cur - removed);
            changed = true;
        }
    }
    if (changed) saveStateRegistry(reg);
}
