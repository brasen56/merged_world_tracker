/**
 * core/metadata.js — Shared chat metadata helpers.
 */

import { getContextSafe, getChatMeta } from './context.js';

export const WORLD_STATE_METADATA_KEY = 'world_state_tracker_metadata';

export function persistChatMeta() {
    const ctx = getContextSafe();
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
    else if (ctx?.saveChatDebounced) ctx.saveChatDebounced();
}

export function patchChatMeta(key, patch, persist = true) {
    const meta = getChatMeta();
    if (!meta) return undefined;
    if (!meta[key]) meta[key] = {};
    const next = { ...meta[key], ...patch, lastUpdated: Date.now() };
    meta[key] = next;
    if (persist) persistChatMeta();
    return next;
}

export function getLatestChronicleEntry() {
    const chronicleData = getChatMeta()?.session_chronicle_data;
    if (!chronicleData?.snapshots?.length) return '';
    const sorted = [...chronicleData.snapshots].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sorted[0]?.text || '';
}

export function getCurrentWorldState() {
    return getChatMeta()?.[WORLD_STATE_METADATA_KEY]?.text || '';
}