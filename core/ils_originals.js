/**
 * core/ils_originals.js — READ-ONLY resolver for InlineSummary (ILS) originals.
 *
 * Shared by Knowledge (de-summarize backfill) and Ledger (locating accepted
 * receipts whose source message was condensed). Storage forms, verified
 * against the fork 2026-07-23:
 *
 *   Current: chatMetadata.ILS_Originals["<uuid>"] = [ …full ST message objects… ]
 *            summary msg carries msg.extra.ILS_Data = { Ref: "<uuid>" }
 *   Legacy:  msg.extra.ILS_Data = { OriginalMessages: [ …full ST message objects… ] }
 *
 * Constraints (violating these can corrupt chats):
 *   1. READ-ONLY. Never GC, migrate, or write to ILS_Originals.
 *      GarbageCollectStore is destructive on a partial load.
 *   2. Handle BOTH storage forms.
 *   3. Recurse: originals can contain nested summaries.
 *   4. No runtime dependency on ILS being loaded: this is a direct metadata read.
 */

import { isIlsSummary } from './quote_match.js';

// ─── Resolution ────────────────────────────────────────────────────────────

/** Chat-metadata key where ILS stores original message arrays, keyed by UUID. */
export const ILS_ORIGINALS_KEY = 'ILS_Originals';

/**
 * Recursively resolve a summary message's original messages down to leaf
 * (non-summary) messages.
 *
 * Handles both forms:
 *   1. Current: msg.extra.ILS_Data.Ref → chatMetadata.ILS_Originals[ref]
 *   2. Legacy:  msg.extra.ILS_Data.OriginalMessages → embedded array
 *
 * Originals can themselves be summaries (nested), so we recurse until we
 * reach leaf messages. A cycle guard (visited Set of refs) prevents infinite
 * recursion if the reference graph has a cycle.
 *
 * READ-ONLY: this function never writes to chat metadata or ILS_Originals.
 *
 * @param {object} msg — the message to resolve (summary or leaf)
 * @param {object} chatMeta — the chat metadata object (for ILS_Originals lookups)
 * @param {Set<string>} [visited] — internal cycle guard (set of visited refs)
 * @returns {Array<object>} — flat array of resolved leaf message objects
 */
export function resolveIlsOriginals(msg, chatMeta, visited = new Set()) {
    // Base case: not a summary → it's a leaf. Return as-is.
    if (!isIlsSummary(msg)) {
        return msg ? [msg] : [];
    }

    const ilsData = msg.extra.ILS_Data;
    const store = chatMeta?.[ILS_ORIGINALS_KEY] || {};
    let candidates = [];

    // Form 1 (current): Ref → metadata lookup.
    // The summary message carries a UUID pointer; the actual originals live
    // in chatMetadata.ILS_Originals[uuid].
    if (ilsData.Ref && typeof ilsData.Ref === 'string') {
        if (visited.has(ilsData.Ref)) {
            console.warn(`[MWT:ILS] Cycle detected at Ref "${ilsData.Ref}" — skipping to prevent infinite recursion.`);
            return [];
        }
        // KNOWLEDGE-05: Clone the visited set before mutating so sibling
        // branches don't share state. The old code added the current Ref to a
        // single shared Set, so when one sibling branch visited Ref "X", every
        // subsequent sibling saw "X" as already visited and was silently
        // skipped — dropping valid originals from the expansion. Each branch
        // now gets its own copy, so a Ref visited in one subtree does not
        // block the same Ref from being expanded in a parallel subtree.
        visited = new Set(visited);
        visited.add(ilsData.Ref);
        const stored = store[ilsData.Ref];
        candidates = Array.isArray(stored) ? stored : [];
    }
    // Form 2 (legacy): embedded OriginalMessages array.
    // Old chats store the originals directly inside the summary message's
    // extra data, before the metadata-store migration.
    else if (Array.isArray(ilsData.OriginalMessages)) {
        // KNOWLEDGE-05: Legacy embedded arrays had no cycle guard at all, so
        // a corrupt chat whose OriginalMessages reference each other (directly
        // or transitively) caused unbounded recursion. Use object identity —
        // the array itself — as the visited key, cloned per-branch just like
        // the Ref path. This catches the "A contains B, B contains A" loop
        // without relying on string Refs that legacy messages don't have.
        if (visited.has(ilsData.OriginalMessages)) {
            console.warn('[MWT:ILS] Cycle detected in legacy OriginalMessages array — skipping to prevent infinite recursion.');
            return [];
        }
        visited = new Set(visited);
        visited.add(ilsData.OriginalMessages);
        candidates = ilsData.OriginalMessages;
    }

    // Recurse: expand any nested summaries within the candidates.
    const leaves = [];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const expanded = resolveIlsOriginals(candidate, chatMeta, visited);
        leaves.push(...expanded);
    }
    return leaves;
}
