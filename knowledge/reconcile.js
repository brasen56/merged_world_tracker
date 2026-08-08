/**
 * knowledge/reconcile.js — Shared import/restore lorebook identity helpers.
 *
 * UIDs are local to a lorebook. These helpers deliberately resolve through the
 * destination book instead of allowing an export-local pointer into a live
 * registry.
 */

import { normalizeRegistryName } from './registry.js';
import { isStoreEntry } from './store.js';
import { TRACKER_SENTINEL } from './state.js';

/** Find a destination entry by its stable user-visible label. */
export function findDestinationEntryUid(entries, name, { kind = 'npc' } = {}) {
    const expected = normalizeRegistryName(name);
    if (!expected) return null;
    for (const [key, entry] of Object.entries(entries || {})) {
        if (isStoreEntry(entry)) continue;
        let label = entry?.comment;
        if (kind === 'state') {
            const comment = String(label || '').trim();
            label = comment.startsWith(TRACKER_SENTINEL)
                ? comment.slice(TRACKER_SENTINEL.length).trim()
                : '';
        }
        if (normalizeRegistryName(label) !== expected) continue;
        const uid = entry?.uid ?? Number(key);
        if (Number.isInteger(Number(uid)) && Number(uid) >= 0) return Number(uid);
    }
    return null;
}

/**
 * Retain an imported UID only when it identifies the same destination content.
 * The caller supplies the read because NPC import and any future restore format
 * may resolve different books, while the safety policy remains identical.
 */
export async function reconcileImportedUid(incomingUid, exportedContent, loadContent) {
    if (incomingUid === null || incomingUid === undefined || typeof loadContent !== 'function') return null;
    try {
        const existing = await loadContent(incomingUid);
        if (existing === null) return null;
        if (exportedContent && existing.trim() !== exportedContent.trim()) return null;
        return incomingUid;
    } catch {
        return null;
    }
}