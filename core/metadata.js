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

/**
 * Persist chat metadata IMMEDIATELY, awaiting the write.
 *
 * The debounced {@link persistChatMeta} is correct for high-frequency writes.
 * It is the wrong tool when the metadata being written is a POINTER to
 * something already durably stored elsewhere — e.g. the registry's
 * `profileUid`, which references an NPC Profiles lorebook entry that
 * `saveWorldInfo` has already written and awaited.
 *
 * If the debounce doesn't flush before a reload or chat switch, the pointer is
 * lost while its target survives. The next save then sees no existing uid,
 * creates a SECOND lorebook entry instead of overwriting, and the duplicates
 * accumulate silently. Pointer writes must be durable at the same moment their
 * target is.
 *
 * Falls back to the debounced save when the immediate API is unavailable.
 *
 * @returns {Promise<void>}
 */
export async function persistChatMetaNow() {
    const ctx = getContextSafe();
    try {
        if (typeof ctx?.saveMetadata === 'function') {
            await ctx.saveMetadata();
            return;
        }
    } catch (err) {
        console.warn('[MWT] Immediate metadata save failed — falling back to debounced save.', err);
    }
    persistChatMeta();
}

/**
 * Merge `patch` into the chat-metadata value at `key` and persist.
 *
 * `lastUpdated` is opt-in: it is only stamped when `stamp` is true. Flat maps
 * (e.g. the Knowledge registry and relationship map) must never carry a
 * top-level `lastUpdated` sibling, so callers default to `stamp: false`.
 *
 * @param {string}  key     metadata key
 * @param {object}  patch   object merged into the existing metadata value
 * @param {boolean} persist trigger a debounced metadata save (default true)
 * @param {boolean} stamp   also set `lastUpdated: Date.now()` (default false)
 */
export function patchChatMeta(key, patch, persist = true, stamp = false) {
    const meta = getChatMeta();
    if (!meta) return undefined;
    if (!meta[key]) meta[key] = {};
    const next = stamp
        ? { ...meta[key], ...patch, lastUpdated: Date.now() }
        : { ...meta[key], ...patch };
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