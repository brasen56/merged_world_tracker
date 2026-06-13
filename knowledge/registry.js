/**
 * knowledge/registry.js — NPC registry and State Tracker registry operations.
 *
 * Registries are stored in chat metadata via core/patchChatMeta.
 */

import { getChatMeta, patchChatMeta, getChat } from '../core/index.js';

import { REGISTRY_KEY, STATE_REGISTRY_KEY, state } from './state.js';

// ─── NPC Registry ────────────────────────────────────────────────────────────

export function getRegistry() {
    const meta = getChatMeta();
    if (!meta[REGISTRY_KEY]) meta[REGISTRY_KEY] = {};
    return meta[REGISTRY_KEY];
}

export function saveRegistry(reg) {
    patchChatMeta(REGISTRY_KEY, reg);
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
    return meta[STATE_REGISTRY_KEY];
}

export function saveStateRegistry(reg) {
    patchChatMeta(STATE_REGISTRY_KEY, reg);
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