/**
 * knowledge/reconcile.js — Shared import/restore lorebook identity helpers.
 *
 * UIDs are local to a lorebook. These helpers deliberately resolve through the
 * destination book instead of allowing an export-local pointer into a live
 * registry.
 */

import { normalizeRegistryName, isUnambiguousNpcAlias, resolvesToSameRegistryRecord } from './registry.js';
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
 * Find the entry in a book that ALREADY carries this NPC's label.
 *
 * The duplicate-entry bug in the reported screenshot (four entries labelled
 * "Sophie", three labelled "Sophie Simpson") is not a registry fork —
 * identical labels cannot come from alias canonicalization. They come from
 * writeToLorebook's create branch, which only ever consulted the registry's
 * `uid` and never asked whether the book already held this NPC. Three paths
 * reach it with the entry sitting right there: an orphan (uid-less) registry
 * record, a registry that was empty when the scan ran, and — most often — the
 * KNOWLEDGE-01 stale-uid guard itself, which detaches the bad uid and falls
 * straight through into a create.
 *
 * Unlike {@link findDestinationEntryUid} (exact normalized label, first hit,
 * used by backup restore where strictness is the safer default), this matches
 * on the NPC identity rules and FAILS CLOSED on ambiguity:
 *   - exact-label matches win outright; the lowest uid is adopted so a book
 *     that already holds several identical labels CONVERGES on one entry
 *     instead of growing by one more on every scan;
 *   - registry-PROVEN matches (both spellings resolve to the same registry
 *     record — e.g. an entry relabelled "The Vixen" for an update that still
 *     spells the NPC "Mara" after a rename) are treated exactly like exact
 *     matches: the registry is the identity authority, so several of them are
 *     leftover duplicates of one NPC, not strangers, and the lowest uid wins;
 *   - otherwise a single heuristic alias match ("Sophie Simpson" for
 *     "Sophie") is adopted;
 *   - two or more DIFFERENT heuristic-only alias matches ("Sophie Simpson"
 *     and "Sophie Sinclair" for "Sophie") are two different people — return
 *     null and let the caller create, rather than write into a stranger's
 *     entry.
 *
 * Unlabelled and store entries are never adoptable.
 *
 * @param {object} entries — the book's `entries` map
 * @param {string} name — the NPC name about to be written
 * @returns {{uid: number, label: string, exact: boolean, duplicates: number}|null}
 */
export function findEntryUidByNpcIdentity(entries, name) {
    if (!normalizeRegistryName(name)) return null;
    const wanted = normalizeRegistryName(name);
    const labels = Object.values(entries || {}).map(entry => String(entry?.comment ?? '').trim());
    const matches = [];
    for (const [key, entry] of Object.entries(entries || {})) {
        if (isStoreEntry(entry)) continue;
        const label = String(entry?.comment ?? '').trim();
        if (!label) continue;
        // Registry-proven ("The Vixen" for "Mara" after a rename) is evidence,
        // not a heuristic — such matches join the certain tier below instead
        // of the fail-closed ambiguity rule.
        const proven = resolvesToSameRegistryRecord(label, name);
        if (!proven && !isUnambiguousNpcAlias(label, name, labels)) continue;
        const uid = Number(entry?.uid ?? key);
        if (!Number.isInteger(uid) || uid < 0) continue;
        matches.push({ uid, label, proven, exact: normalizeRegistryName(label) === wanted });
    }
    if (matches.length === 0) return null;

    // Certain tier: exact labels AND registry-proven ones, lowest uid first —
    // they provably are this NPC, so several of them are duplicate entries to
    // converge on, not strangers to refuse.
    const certain = matches
        .filter(m => m.exact || m.proven)
        .sort((a, b) => a.uid - b.uid);
    if (certain.length > 0) {
        return { uid: certain[0].uid, label: certain[0].label, exact: certain[0].exact, duplicates: certain.length };
    }
    // Heuristic-only: one candidate is an unambiguous alias; several are
    // strangers who merely share a given name.
    if (matches.length === 1) {
        return { uid: matches[0].uid, label: matches[0].label, exact: false, duplicates: 1 };
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