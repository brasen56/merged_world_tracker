/**
 * core/metadata.js — Shared chat metadata helpers.
 */

import { getContextSafe, getChatMeta } from './context.js';
import { collectQuarantineItems } from './schema.js';
import {
    mergeQuarantineItems,
    validateQuarantineStoreData,
    QUARANTINE_METADATA_KEY,
} from './quarantine.js';

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
export async function persistChatMetaNow({ strict = false } = {}) {
    const ctx = getContextSafe();
    if (typeof ctx?.saveMetadata === 'function') {
        try {
            await ctx.saveMetadata();
            return;
        } catch (err) {
            // A transactional caller (e.g. a backup restore) MUST learn that the
            // durable write failed so it can roll back. High-frequency pointer
            // writers keep the resilient fallback by default.
            if (strict) throw err;
            console.warn('[MWT] Immediate metadata save failed — falling back to debounced save.', err);
        }
    } else if (strict) {
        // The durable API is unavailable. A strict caller's correctness depends on
        // the write being awaited before it proceeds — the whole store-before-
        // metadata ordering in a backup restore exists precisely to guarantee
        // this. A missing `saveMetadata` does not throw, so without this guard the
        // call falls through to the debounced save and returns normally, leaving a
        // strict caller to believe the write is durable when it is only queued —
        // and `restoreBackup` to report `committed: true` on a restore a reload
        // could still lose. Refuse rather than silently downgrading the guarantee.
        throw new Error('Strict metadata persistence is not available: the host does not expose an immediate saveMetadata API.');
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

/**
 * Merge the quarantine records from a module WRITE SEAM (design §8, Part 3)
 * into the chat-local quarantine container, so a record the schema rejects on
 * write is preserved exactly like one rejected at load (design §5.2) instead
 * of being silently dropped from the canonical value.
 *
 * Deduplication is by content fingerprint: re-detecting the same bad record
 * on every subsequent write merges as a duplicate instead of appending. The
 * container is MERGED, never replaced — records already quarantined in this
 * chat always survive.
 *
 * A container written by a NEWER MWT (a future `version`) is REFUSED
 * UNCHANGED: the tolerant normalizer would re-stamp it as the current version
 * and the merge would silently downgrade it — destroying whatever that
 * release recorded (the unknown-future-version guardrail, design §3.5
 * category 4, same rule as quarantine imports). A container whose persisted
 * shape produced NON-REPAIR findings (a malformed root/items list, or items
 * the checker rejected as unrecoverable) is refused for the same reason:
 * merging into the canonical form would overwrite the container and silently
 * delete exactly the records quarantine exists to keep. Repair findings (a
 * recomputed fingerprint) preserve the raw record and never block.
 *
 * Refusal is a FAILED WRITE, not a warning: the caller committed to preserving
 * the rejected records (design §5.2 — "commit canonical data or leave the
 * previous value intact"), and canonical data whose rejected records cannot be
 * stored must not be committed. Callers therefore leave the previous store
 * value untouched when `ok` is false.
 *
 * @param {string} storeId registered store id (e.g. 'chronicle')
 * @param {object[]} issues issues from prepareNextStoreValue()/prepareStore()
 * @param {object} [options]
 * @param {number|null} [options.sourceVersion] schema version the store data
 *   was at when the record was rejected (write seams write current version)
 * @returns {{ ok: boolean, stored: number, reason?: string, message?: string }}
 *   `stored` is how many quarantine records the container holds after the
 *   merge; `ok: false` means NOTHING was merged and the caller must leave the
 *   previous store value intact (the container was refused, so the rejected
 *   records cannot be preserved in this write). No-op successes (no issues, no
 *   metadata, no quarantine-severity findings) return `ok: true, stored: 0`.
 */
export function preserveQuarantinedRecords(storeId, issues, { sourceVersion = null } = {}) {
    if (!Array.isArray(issues) || issues.length === 0) return { ok: true, stored: 0 };
    const meta = getChatMeta();
    if (!meta) return { ok: true, stored: 0 };
    const items = collectQuarantineItems(storeId, issues, { sourceVersion, detectedAt: Date.now() });
    if (items.length === 0) return { ok: true, stored: 0 };
    // Validate (not normalize) the persisted container: this is a persistence
    // path, so the refusal rules apply before any merge. An ABSENT container
    // (undefined/null) is the normal pre-quarantine state, not corruption —
    // the first merge creates it.
    const rawContainer = meta[QUARANTINE_METADATA_KEY];
    const existing = validateQuarantineStoreData(rawContainer);
    const futureIssue = existing.issues.find(issue => issue.code === 'future-version');
    if (futureIssue) {
        console.warn(`[MWT] ${futureIssue.message} Quarantine records detected by this write were NOT merged; the write must be refused so they are not lost. Upgrade MWT to preserve them.`);
        return { ok: false, stored: 0, reason: 'quarantine-version-future', message: futureIssue.message };
    }
    // Any other non-repair finding on a PRESENT container means part of it
    // could not be preserved in its canonical form (a malformed root/items
    // list, or rejected unrecoverable items). Merging would replace the
    // container with the canonical one and silently delete those records —
    // refuse instead.
    const lossyIssue = rawContainer === undefined || rawContainer === null
        ? undefined
        : existing.issues.find(issue => issue.severity === 'quarantine' || issue.severity === 'fatal');
    if (lossyIssue) {
        const message = `The chat quarantine container is malformed (${lossyIssue.message}) It was left unchanged; merging into it would delete the records it still holds.`;
        console.warn(`[MWT] ${message}`);
        return { ok: false, stored: 0, reason: 'quarantine-container-invalid', message };
    }
    const merged = mergeQuarantineItems(existing.data.items, items);
    meta[QUARANTINE_METADATA_KEY] = { version: existing.data.version, items: merged };
    return { ok: true, stored: merged.length };
}

export function getCurrentWorldState() {
    return getChatMeta()?.[WORLD_STATE_METADATA_KEY]?.text || '';
}