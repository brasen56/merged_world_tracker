/**
 * knowledge/registry.js — NPC registry and State Tracker registry operations.
 *
 * Registries are flat { name: {...} } maps stored directly in chat metadata.
 * We assign the whole map and call persistChatMeta() rather than routing
 * through patchChatMeta(), which is reserved for structured (non-flat) data.
 */

import { getChatMeta, persistChatMeta, getChat } from '../core/index.js';

import { REGISTRY_KEY, STATE_REGISTRY_KEY, state } from './state.js';

// ─── NPC Registry ────────────────────────────────────────────────────────────

export function getRegistry() {
    const meta = getChatMeta();
    if (!meta[REGISTRY_KEY]) meta[REGISTRY_KEY] = {};
    return meta[REGISTRY_KEY];
}

export function saveRegistry(reg) {
    // Set the flat map directly — do NOT route through patchChatMeta(), which
    // would merge a `lastUpdated` sibling into the map and corrupt lookups.
    const meta = getChatMeta();
    meta[REGISTRY_KEY] = reg;
    persistChatMeta();
}

export function registerEntry(name, uid, type, keywords) {
    const reg = getRegistry();
    reg[name] = { uid, type, keywords: keywords || [name], lastUpdated: Date.now() };
    saveRegistry(reg);
}

export function isKnown(name) { return !!getRegistry()[name]; }

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
    const meta = getChatMeta();
    if (!meta[STATE_REGISTRY_KEY]) meta[STATE_REGISTRY_KEY] = {};
    return meta[STATE_REGISTRY_KEY];
}

export function saveStateRegistry(reg) {
    // Set the flat map directly — same rationale as saveRegistry().
    const meta = getChatMeta();
    meta[STATE_REGISTRY_KEY] = reg;
    persistChatMeta();
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