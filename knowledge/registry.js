/**
 * knowledge/registry.js — NPC registry and State Tracker registry operations.
 *
 * Registries are flat { name: {...} } maps stored directly in chat metadata.
 * We assign the whole map and call persistChatMeta() rather than routing
 * through patchChatMeta(), which merges a top-level `lastUpdated` timestamp
 * into the map and corrupts name lookups / iteration.
 */

import { getChatMeta, persistChatMeta, getChat } from '../core/index.js';

import { REGISTRY_KEY, STATE_REGISTRY_KEY, state } from './state.js';

// ─── NPC Registry ────────────────────────────────────────────────────────────

export function getRegistry() {
    const meta = getChatMeta();
    if (!meta[REGISTRY_KEY]) meta[REGISTRY_KEY] = {};
    const reg = meta[REGISTRY_KEY];
    // Migration / hardening: a previous saveRegistry() routed through
    // patchChatMeta(), which merged a `lastUpdated` timestamp into this flat
    // { npcName: {...} } map. That phantom key appeared in every NPC list,
    // dropdown, and scan. Strip it once if present; persist the cleaned map.
    if (reg.lastUpdated !== undefined) {
        delete reg.lastUpdated;
        persistChatMeta();
    }
    return reg;
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

export function findOrphans() {
    const reg = getRegistry();
    return Object.keys(reg).filter(name => reg[name].uid === null || reg[name].uid === undefined);
}

export function getAllNpcNames() { return Object.keys(getRegistry()); }

// ─── State Registry ──────────────────────────────────────────────────────────

export function getStateRegistry() {
    const meta = getChatMeta();
    if (!meta[STATE_REGISTRY_KEY]) meta[STATE_REGISTRY_KEY] = {};
    const reg = meta[STATE_REGISTRY_KEY];
    // Same lastUpdated hardening as getRegistry() above.
    if (reg.lastUpdated !== undefined) {
        delete reg.lastUpdated;
        persistChatMeta();
    }
    return reg;
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