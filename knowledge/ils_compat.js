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
import { isIlsSummary } from '../core/quote_match.js';
import { ILS_ORIGINALS_KEY, resolveIlsOriginals } from '../core/ils_originals.js';

// The read-only resolver lives in core/ so Ledger can share it without a
// cross-module import; re-exported here for existing Knowledge callers.
export { isIlsSummary, ILS_ORIGINALS_KEY, resolveIlsOriginals };

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
