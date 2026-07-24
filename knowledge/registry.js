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
    const info = getRegistry()[name];
    const uid = info?.profileUid;
    return (uid === null || uid === undefined) ? null : uid;
}

/**
 * Set the profile lorebook UID for an NPC (after writing the profile entry).
 * @param {string} name — NPC name
 * @param {number} uid — profile lorebook UID
 */
export function setProfileUid(name, uid) {
    const reg = getRegistry();
    if (!reg[name]) return;
    reg[name].profileUid = uid;
    saveRegistry(reg);
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