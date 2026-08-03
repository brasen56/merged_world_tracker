/**
 * knowledge/ils_compat.js — InlineSummary (ILS) de-summarize backfill helper.
 *
 * READ-ONLY resolver for ILS original messages stored in chat metadata.
 * Expands summary messages back to their verbatim originals so the growth
 * evidence capture can quote real text instead of a paraphrase.
 *
 * Implements Part B of NPC_GROWTH_BLUEPRINT.md §"Deferred: summarizer
 * robustness".
 *
 * ── Storage forms handled (verified against the fork 2026-07-23) ──
 *
 *   Current form:
 *     chatMetadata.ILS_Originals["<uuid>"] = [ …full ST message objects… ]
 *     summary msg carries: msg.extra.ILS_Data = { Ref: "<uuid>" }
 *
 *   Legacy form:
 *     msg.extra.ILS_Data = { OriginalMessages: [ …full ST message objects… ] }
 *
 *   Full ST message objects have real .mes (verbatim text) and .send_date
 *   (the canonical ts).
 *
 * ── Constraints (from the blueprint — violating these can corrupt chats) ──
 *
 *   1. READ-ONLY. Never GC, migrate, or write to ILS_Originals.
 *      GarbageCollectStore is destructive on a partial load (an unloaded
 *      message's originals look unreferenced → deleted). MWT reads; MWT must
 *      never write.
 *   2. Handle BOTH storage forms — Ref→metadata (current) AND legacy embedded
 *      OriginalMessages. Old chats still carry the embedded form.
 *   3. Recurse. Originals can contain nested summaries; full expansion to raw
 *      leaves is recursive.
 *   4. No runtime dependency on ILS being loaded. This is a direct metadata
 *      read — works even on an old summarized chat where ILS is disabled.
 *   5. Anchor ts on each original's send_date; treat msgIdx as null/synthetic
 *      under expansion — array positions are meaningless once summaries are
 *      spliced open.
 */

import { getChatMeta, sendDateToMs } from '../core/index.js';

/** Chat-metadata key where ILS stores original message arrays, keyed by UUID. */
export const ILS_ORIGINALS_KEY = 'ILS_Originals';

// ─── Detection ─────────────────────────────────────────────────────────────

/**
 * Is this message an ILS summary? (Does it carry ILS_Data?)
 *
 * @param {object} msg — a chat message object
 * @returns {boolean}
 */
export function isIlsSummary(msg) {
    return !!(msg && msg.extra && msg.extra.ILS_Data);
}

// ─── Resolution ────────────────────────────────────────────────────────────

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

/**
 * Expand ALL ILS summaries in a chat array to their leaf originals, preserving
 * non-summary messages in their original positions.
 *
 * This produces a flat message list where every summary message is replaced by
 * its expanded originals. Non-summary messages pass through unchanged.
 *
 * Used by the backfill capture path (Part B) to build a de-summarized capture
 * window. NOT used on the everyday continuous-capture path (Part A) — that
 * path skips summaries and captures only live messages.
 *
 * @param {Array<object>} chat — the chat array (read-only; not mutated)
 * @param {object} [chatMeta] — chat metadata (defaults to live getChatMeta())
 * @param {object} [opts]
 * @param {number} [opts.sinceTs] — only include messages/originals with send_date > sinceTs
 * @returns {Array<{msg:object, idx:number|null, ts:number, fromSummary:boolean}>}
 *   expanded message entries. `idx` is the chat-array index for live messages
 *   or the summary's index for expanded originals (synthetic). `ts` is the
 *   real send_date (canonical). `fromSummary` flags ILS-expanded entries.
 */
export function expandIlsSummaries(chat, chatMeta, opts = {}) {
    const meta = chatMeta || getChatMeta();
    const { sinceTs = null } = opts;
    const out = [];

    if (!Array.isArray(chat)) return out;

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;

        if (isIlsSummary(msg)) {
            // Expand the summary to its leaf originals.
            const originals = resolveIlsOriginals(msg, meta);
            for (const orig of originals) {
                if (!orig || !orig.mes) continue;
                const ts = normalizeSendDate(orig.send_date);
                // KNOWLEDGE-06: normalizeSendDate documents `0` as "ancient,
                // always included" but the old `ts <= sinceTs` filter excluded
                // any entry with ts 0 when sinceTs was also 0 (the default
                // watermark). Use strict `<` so a `0`-watermark does not
                // exclude `0`-timestamp entries, and explicitly include
                // unresolvable dates (ts 0) as "ancient" per the contract.
                if (sinceTs != null && ts !== 0 && ts < sinceTs) continue;
                out.push({
                    msg: orig,
                    idx: i,          // synthetic — points at the summary, not the original
                    ts,
                    fromSummary: true,
                });
            }
        } else {
            if (!msg.mes) continue;
            const ts = normalizeSendDate(msg.send_date);
            // KNOWLEDGE-06: same fix — strict `<` and always-include ts 0.
            if (sinceTs != null && ts !== 0 && ts < sinceTs) continue;
            out.push({
                msg,
                idx: i,
                ts,
                fromSummary: false,
            });
        }
    }
    return out;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize a SillyTavern send_date to a milliseconds timestamp.
 *
 * Delegates to the shared `sendDateToMs` helper, which is format-agnostic
 * (ISO 8601 strings from live ST, humanized strings from the Aikobots-4 fork,
 * or legacy numeric Unix timestamps). If the value is missing or unresolvable,
 * returns 0 (treated as "ancient" — always included in time-bounded windows).
 *
 * @param {number|string|undefined} sendDate
 * @returns {number} milliseconds since epoch
 */
export function normalizeSendDate(sendDate) {
    return sendDateToMs(sendDate) ?? 0;
}
