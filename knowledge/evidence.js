/**
 * knowledge/evidence.js — Two-tier NPC growth evidence store (Slice 2).
 *
 * Implements the evidence file data model from NPC_GROWTH_BLUEPRINT.md:
 *
 *   {
 *     npc: "Name",
 *     raw: [ { id, category, claim, quote, msgIdx, ts, capturedAt, canon? } ],
 *     consolidated: [ { id, category, claim, sources: [rawId...], firstSeen, lastSeen, confidence } ],
 *     archivedRaw: [ ...same shape as raw, retained for audit... ],
 *     meta: { createdAt, updatedAt, lastProfileAt, lastCaptureTs }
 *   }
 *
 * Invariants enforced here (from the blueprint's non-negotiable rules):
 *
 * - **Accumulate, don't overwrite** — capture appends to `raw[]` only.
 *   Only consolidation or a user edit distills/moves evidence.
 * - **Anchoring** — every raw observation carries a quote receipt.
 * - **`ts` canonical, `msgIdx` diagnostic** — timestamps survive message
 *   deletion/edit; message indices do not.
 * - **Canon override** — user-authored canon beats all inference and survives
 *   regeneration. Canon claims are flagged on raw entries.
 *
 * Slice 3 will add the consolidation pass (raw → consolidated with back-
 * references, raw → archived). The schema and helpers are designed for it
 * from day one so no migration is needed later.
 */

import { getChatMeta, persistChatMeta, preserveQuarantinedRecords, getChat, sendDateToMs } from '../core/index.js';
import { GROWTH_EVIDENCE_KEY } from './state.js';
import { knowledgeEvidenceSchema } from './schema.js';
import { fingerprintValue } from '../core/quarantine.js';
import { clonePlainData } from '../core/schema.js';
// Part 6 write-seam pause guard. Direct import (not the barrel) so the REAL
// pause singleton is read even under the test barrel→stub alias.
import { isStoreWriteBlocked } from '../core/schema_status.js';

// ─── Evidence map (all NPCs in this chat) ─────────────────────────────────────

// ─── Staged working copy (checked-commit boundary) ────────────────────────────
//
// getEvidenceMap() hands callers a DETACHED clone of the live map, staged once
// and reused (same object) until the next commit, so the established
// mutate-then-saveEvidenceMap() programming model is unchanged — but the
// mutations land in the staged copy, never in chat metadata. saveEvidenceMap()
// validates the STAGED value and only then replaces the live one — with a
// fully DETACHED clone of the canonical value, since the validator's output
// still shares its nested objects with the staged input it validated — so a
// refused write (a fatal finding, or a quarantine container that refuses the
// records) really does leave the previous value intact: there is nothing to
// restore, because nothing was ever mutated in place, and a committed write
// leaves the staged copy and live metadata sharing no object at any depth.
//
// _stagedEvidenceBase pins the live object the copy was staged from. If the
// live value is replaced underneath us (chat switch, backup restore), a commit
// is refused rather than clobbering the replacement with stale staged data.

let _stagedEvidenceMap = null;
let _stagedEvidenceBase = undefined;

function _resetEvidenceStaging() {
    _stagedEvidenceMap = null;
    _stagedEvidenceBase = undefined;
}

/**
 * Get the evidence map for this chat: { npcName: EvidenceFile }.
 * Returns a DETACHED staged working copy (mutate, then call saveEvidenceMap()
 * to validate and commit it — mutations never touch chat metadata directly).
 *
 * The same staged object is returned until the next commit, so callers may
 * hold several references (the map, an evidence file, a nested array) across
 * several mutations and they all see each other before the save.
 *
 * @returns {Object<string, EvidenceFile>}
 */
export function getEvidenceMap() {
    const meta = getChatMeta();
    const stored = meta?.[GROWTH_EVIDENCE_KEY];
    // Only a GENUINELY ABSENT map (undefined/null) is created eagerly — that
    // write is lossless, and callers need a map to mutate before
    // saveEvidenceMap() commits it. A PRESENT-but-invalid map ('' / 0 / any
    // non-object) must survive the read untouched: replacing it here would
    // destroy the raw value before the write seam could refuse on it, so the
    // reader gets a DETACHED throwaway {} and saveEvidenceMap() keeps the
    // previous value intact.
    if (stored === undefined || stored === null) {
        if (!meta) return {};
        meta[GROWTH_EVIDENCE_KEY] = {};
    } else if (typeof stored !== 'object' || Array.isArray(stored)) {
        _resetEvidenceStaging();
        return {};
    }
    const live = meta[GROWTH_EVIDENCE_KEY];
    if (_stagedEvidenceMap !== null && _stagedEvidenceBase === live) {
        return _stagedEvidenceMap;
    }
    _stagedEvidenceMap = clonePlainData(live);
    _stagedEvidenceBase = live;
    return _stagedEvidenceMap;
}

/**
 * Commit the staged evidence map to chat metadata.
 * Call after mutating the object returned by getEvidenceMap().
 *
 * The evidence WRITE SEAM (design §8, Part 3): the COMPLETE staged map is
 * validated by the registered knowledgeEvidence schema, and only a fully
 * successful validation (with quarantine preservation accepted) commits —
 * chat metadata is replaced wholesale, by a fully DETACHED clone of the
 * canonical value (the validator's output shares nested objects with the
 * staged input, so it must never be committed as-is). Because mutations only
 * ever landed in the staged copy, every refusal (an unreadable proposal, or a
 * quarantine container that declines the records) genuinely leaves the
 * PREVIOUS stored value intact: there is nothing that was mutated in place
 * and would need restoring. A record the schema rejects is quarantined
 * (design §5.2) out of the committed map but preserved whole in the
 * chat-local quarantine container, in the same write.
 */
export function saveEvidenceMap() {
    const meta = getChatMeta();
    const live = meta?.[GROWTH_EVIDENCE_KEY];
    // Part 6: a store paused by the runtime schema gate keeps its untouched
    // original as the recoverable state — a module write would validate the
    // unprepared value at the current version and replace it (a silent
    // downgrade for a future-version store, exactly what §12 forbids). The
    // only exception is the §7.5 privileged-preparation window.
    if (isStoreWriteBlocked(knowledgeEvidenceSchema.id)) {
        console.warn('[MWT:Knowledge] Evidence write refused — the store is paused for this chat (schema preparation); the previous value was kept.');
        _resetEvidenceStaging();
        return;
    }
    // Nothing to validate when the store does not exist yet — getEvidenceMap()
    // callers create it before mutating, and a save without a store is a no-op.
    if (!live || typeof live !== 'object' || Array.isArray(live)) {
        if (live !== undefined && live !== null) {
            console.warn('[MWT:Knowledge] Evidence write refused — the evidence map is not an object; the previous value was kept.');
        }
        persistChatMeta();
        return;
    }
    if (_stagedEvidenceMap === null || _stagedEvidenceBase !== live) {
        // Either nothing was staged since the last commit, or the live value
        // was replaced underneath us (chat switch / backup restore).
        // Committing the staged copy now would clobber that replacement with
        // stale data — refuse closed and drop the edit instead.
        if (_stagedEvidenceMap !== null) {
            console.warn('[MWT:Knowledge] Evidence write refused — the evidence map changed underneath an uncommitted edit; the edit was dropped and the current value was kept.');
            _resetEvidenceStaging();
        }
        return;
    }
    const staged = _stagedEvidenceMap;
    const validation = knowledgeEvidenceSchema.validate(staged);
    for (const issue of validation.issues) {
        console.warn(`[MWT:Knowledge] ${issue.severity}: ${issue.message}`);
    }
    if (validation.issues.some(issue => issue.severity === 'fatal')) {
        // An unreadable proposal must not be committed: leave the previous
        // (live) value intact (design §3.5 category 4). Nothing was mutated
        // in place, so metadata is already correct — but the STAGED copy still
        // holds the refused edit, and every later read returns that same
        // object. Drop it so "the previous value was kept" is true of what the
        // module reads next too, instead of the refused mutation persisting in
        // the working copy and being re-proposed on every subsequent save.
        _resetEvidenceStaging();
        return;
    }
    // §5.2: the canonical commit is only allowed to land if rejected records
    // were preserved. A refused quarantine container means they cannot be —
    // keep the live map exactly as it is instead of replacing it.
    const preserved = preserveQuarantinedRecords(knowledgeEvidenceSchema.id, validation.issues, {
        sourceVersion: knowledgeEvidenceSchema.currentVersion,
    });
    if (!preserved.ok) {
        console.warn(`[MWT:Knowledge] Evidence write refused — quarantined records could not be preserved (${preserved.reason}); the previous value was kept.`);
        // Same rule as the fatal refusal above: drop the staged copy so the
        // refused edit does not survive in what later reads hand back.
        _resetEvidenceStaging();
        return;
    }
    // CHECKED COMMIT: only now does chat metadata change — wholesale, to the
    // canonical form of the staged copy. The live value's previous contents
    // were never exposed to caller mutations, so the "previous value kept"
    // promise holds by construction.
    const canonical = validation.data;
    // The validator builds its canonical value AROUND the staged input: fresh
    // file shells, but the SAME nested objects (a file's meta container, the
    // accepted raw/consolidated records, pass-through fields). Committing it
    // directly would alias the staged graph INTO chat metadata — every later
    // caller mutation on the object getEvidenceMap() still hands out (touch()
    // stamping file.meta, an edit to a raw record, a push into a tier) would
    // land in metadata BEFORE the next validation could see or refuse it.
    // Commit a fully DETACHED clone instead, so live metadata and the staged
    // copy share no object at any depth.
    const committed = clonePlainData(canonical);
    meta[GROWTH_EVIDENCE_KEY] = committed;
    // Re-bind staging to the committed value and sync the canonical form back
    // INTO the staged map in place (top-level identity preserved). Callers
    // still holding the staged map keep the old live-object semantics: their
    // map matches what was committed, and the next mutate→save cycle stages
    // against the new base. The synced values come from the canonical
    // PROPOSAL — a dead object no reader can reach — never from `committed`,
    // so this sync cannot re-introduce aliasing with live metadata.
    for (const key of Object.keys(staged)) {
        if (!Object.prototype.hasOwnProperty.call(canonical, key)) delete staged[key];
    }
    for (const [key, value] of Object.entries(canonical)) {
        if (staged[key] === value) continue;
        let unchanged = false;
        try {
            unchanged = fingerprintValue(staged[key]) === fingerprintValue(value);
        } catch { /* unfingerprintable ⇒ treat as changed */ }
        if (!unchanged) staged[key] = value;
    }
    _stagedEvidenceBase = committed;
    persistChatMeta();
}

// ─── Per-NPC evidence file ───────────────────────────────────────────────────

/**
 * Get the evidence file for a specific NPC, creating an empty skeleton if it
 * doesn't exist yet.
 *
 * @param {string} name — NPC name
 * @param {boolean} [create=true] — if false, return null when no file exists
 * @returns {EvidenceFile|null}
 */
export function getEvidenceFile(name, create = true) {
    const map = getEvidenceMap();
    if (!map[name] && create) {
        map[name] = {
            npc: name,
            raw: [],
            consolidated: [],
            archivedRaw: [],
            meta: { createdAt: Date.now(), updatedAt: Date.now(), lastProfileAt: null },
        };
        saveEvidenceMap();
    }
    return map[name] || null;
}

/**
 * Does this NPC have an evidence file (i.e. has growth capture been run)?
 * Used by the registry gate and to decide whether DOSSIER_UPDATE_PROMPT
 * should skip the Personality: line.
 *
 * @param {string} name — NPC name
 * @returns {boolean}
 */
export function hasEvidenceFile(name) {
    const file = getEvidenceMap()[name];
    // The `enrolled` flag keeps an NPC in the continuous-capture gate even
    // after clearEvidence() wipes its tiers to empty (item 7 fix). Without it,
    // a cleared NPC is silently dropped from background capture until the user
    // manually captures again — which is exactly when you want it running.
    return !!(file && (file.enrolled === true || file.raw?.length > 0 || file.consolidated?.length > 0));
}

/**
 * Delete an NPC's entire evidence file (all tiers + meta).
 * Used when an NPC is removed from the registry.
 *
 * @param {string} name — NPC name
 */
export function deleteEvidenceFile(name) {
    const map = getEvidenceMap();
    delete map[name];
    saveEvidenceMap();
}

/**
 * Clear ALL evidence for an NPC but keep the file skeleton (so it remains
 * "enrolled" in continuous capture). Wipes raw, consolidated, archivedRaw,
 * userOverrides, and resets both watermarks + the profile stamp. The NPC can
 * then be re-captured from scratch.
 *
 * This is the "start over for one NPC" operation.
 *
 * @param {string} name — NPC name
 * @returns {boolean} true if the file was reset
 */
export function clearEvidence(name) {
    const file = getEvidenceFile(name, false);
    if (!file) return false;
    file.raw = [];
    file.consolidated = [];
    file.archivedRaw = [];
    file.userOverrides = [];
    // Mark the NPC as enrolled so it stays in the continuous-capture gate even
    // though its tiers are now empty (item 7 fix). Clearing to re-capture from
    // scratch is precisely when you WANT background capture running.
    file.enrolled = true;
    // Preserve createdAt: this clears the file's CONTENTS, it does not re-create
    // the file. Resetting it would lose when the NPC was first enrolled and make
    // "how long has this character been tracked" unanswerable.
    file.meta = {
        createdAt: file.meta?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        lastProfileAt: null,
        lastCaptureTs: null,
        lastBackfillTs: null,
    };
    touch(file);
    return true;
}

/**
 * Clear ALL growth evidence for EVERY NPC in this chat. Wipes every file's
 * raw, consolidated, archivedRaw, userOverrides, and watermarks — a full reset
 * of the growth feature for the current chat.
 *
 * This is the "start over completely" operation.
 *
 * @returns {number} the count of NPC files reset
 */
export function clearAllEvidence() {
    const map = getEvidenceMap();
    let count = 0;
    for (const name of Object.keys(map)) {
        map[name].raw = [];
        map[name].consolidated = [];
        map[name].archivedRaw = [];
        map[name].userOverrides = [];
        // Keep all NPCs enrolled after a full reset — see clearEvidence().
        map[name].enrolled = true;
        // Preserve createdAt — see clearEvidence().
        map[name].meta = {
            createdAt: map[name].meta?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            lastProfileAt: null,
            lastCaptureTs: null,
            lastBackfillTs: null,
        };
        count++;
    }
    if (count > 0) saveEvidenceMap();
    return count;
}

/**
 * Stamp `meta.updatedAt` and persist.
 *
 * @param {EvidenceFile} file
 */
function touch(file) {
    file.meta.updatedAt = Date.now();
    saveEvidenceMap();
}

// ─── ID generation ───────────────────────────────────────────────────────────

/**
 * Create an id generator for a tier, seeded once from the file's current
 * contents and incrementing on its own thereafter.
 *
 * Required whenever a BATCH of entries is built into a side array before being
 * written back to the file. {@link nextObsId} re-derives the next number by
 * scanning the stored tier, so it only advances once an entry has actually
 * landed in `file`. A loop that assigns ids while building off-file would hand
 * every entry in the batch the SAME id — and every id-keyed operation
 * (edit/delete/expand) then hits all of its siblings at once.
 *
 * @param {EvidenceFile} file
 * @param {'raw'|'consolidated'} tier
 * @returns {() => string} call to get each successive id
 */
function obsIdSequence(file, tier) {
    const prefix = tier === 'consolidated' ? 'con-' : 'obs-';
    const scan = tier === 'raw'
        ? [...(file.raw || []), ...(file.archivedRaw || [])]
        : (file.consolidated || []);
    let max = 0;
    for (const entry of scan) {
        const m = String(entry.id || '').match(/\d+$/);
        if (m) max = Math.max(max, parseInt(m[0], 10));
    }
    return () => `${prefix}${String(++max).padStart(3, '0')}`;
}

/**
 * Generate the next observation ID for a tier.
 * Scans both the active tier and archivedRaw (for raw) so IDs never collide
 * with archived entries that retain their original ids.
 *
 * Only correct for one id at a time, against the file's CURRENT state. To mint
 * several ids before writing any of them back, use {@link obsIdSequence}.
 *
 * @param {EvidenceFile} file
 * @param {'raw'|'consolidated'} tier
 * @returns {string}
 */
export function nextObsId(file, tier) {
    return obsIdSequence(file, tier)();
}

// ─── Capture: append to raw[] ────────────────────────────────────────────────

/**
 * Append captured observations to the raw tier. This is the ONLY write path
 * for capture — it never touches consolidated[] and never overwrites.
 *
 * Each incoming observation is stamped with an id, ts (from the cited message,
 * canonical for retrieval), and capturedAt (when the capture ran).
 *
 * Duplicate-suppression: observations whose normalized claim+quote already
 * exist in raw[] are skipped, so re-running capture on the same window doesn't
 * pile up identical receipts.
 *
 * @param {string} name — NPC name
 * @param {Array<{category:string, claim:string, quote:string, msgIdx:number|null, verified?:boolean, ts?:number}>} observations
 * @returns {{added: number, skipped: number}} counts
 */
export function appendRawObservations(name, observations) {
    const file = getEvidenceFile(name);
    const chat = getChat() || [];
    // Dedup against BOTH raw[] and archivedRaw[]. After consolidation moves
    // observations to archivedRaw, a capture pass that overlaps those same
    // messages would re-add them to raw[] — re-worded claims slip past the
    // string-based key and pile up as near-duplicates. Including the archive
    // in the dedup set prevents that resurrection.
    const existing = new Set(
        [...(file.raw || []), ...(file.archivedRaw || [])].map(o => normalizeKey(o.claim, o.quote))
    );

    let added = 0;
    let skipped = 0;
    for (const obs of observations) {
        if (!obs || !obs.claim || !obs.quote) { skipped++; continue; }
        const key = normalizeKey(obs.claim, obs.quote);
        if (existing.has(key)) { skipped++; continue; }
        existing.add(key);

        // Prefer an explicit ts when available (e.g. from ILS backfill, where
        // the msgIdx is a synthetic expanded-array index, not a live one).
        // Otherwise extract from the live chat by index as usual.
        const ts = (typeof obs.ts === 'number' && Number.isFinite(obs.ts))
            ? obs.ts
            : extractMsgTs(chat, obs.msgIdx);
        file.raw.push({
            id: nextObsId(file, 'raw'),
            category: validCategory(obs.category),
            claim: String(obs.claim).trim(),
            quote: String(obs.quote).trim(),
            msgIdx: typeof obs.msgIdx === 'number' ? obs.msgIdx : null,
            ts,
            capturedAt: Date.now(),
            verified: obs.verified === true,
            canon: false,
        });
        added++;
    }

    if (added > 0) touch(file);
    return { added, skipped };
}

// ─── Raw observation CRUD (user edits) ───────────────────────────────────────

/**
 * Update a raw observation's claim or quote text. Editing does not change its
 * id or ts. Used by the Evidence Editor.
 *
 * @param {string} name — NPC name
 * @param {string} id — observation id (e.g. "obs-001")
 * @param {{claim?:string, quote?:string, category?:string}} patch
 * @returns {boolean} true if updated
 */
export function updateRawObservation(name, id, patch) {
    const file = getEvidenceFile(name, false);
    if (!file) return false;
    const obs = (file.raw || []).find(o => o.id === id);
    if (!obs) return false;
    // KNOWLEDGE-07: Compute the COMPLETE proposed observation BEFORE mutating,
    // so a failed validation (empty field or collision) leaves the stored
    // observation untouched. The previous implementation set obs.claim first
    // and then returned false on an invalid quote/collision, leaving a
    // partial mutation behind.
    const proposedClaim = patch.claim != null ? String(patch.claim).trim() : obs.claim;
    const proposedQuote = patch.quote != null ? String(patch.quote).trim() : obs.quote;
    if (!proposedClaim) return false; // empty claim rejected
    if (!proposedQuote) return false; // empty quote rejected
    // Check the combined proposed claim+quote against every OTHER raw
    // observation (and the archive) so an edit can't shadow a different entry.
    const collides = [...(file.raw || []), ...(file.archivedRaw || [])].some(o =>
        o.id !== id && normalizeKey(o.claim, o.quote) === normalizeKey(proposedClaim, proposedQuote)
    );
    if (collides) {
        console.warn(`[MWT:Knowledge] updateRawObservation rejected: claim+quote collides with an existing observation.`);
        return false;
    }
    // All checks passed — commit the mutation now.
    obs.claim = proposedClaim;
    obs.quote = proposedQuote;
    if (patch.category != null) obs.category = validCategory(patch.category);
    touch(file);
    return true;
}

/**
 * Delete a raw observation from raw[]. If it has been consolidated (referenced
 * by a consolidated entry's sources[]), the back-reference is also removed so
 * it doesn't dangle. The observation is NOT moved to archivedRaw (archive only
 * happens via consolidation in Slice 3) — a user delete is a true delete.
 *
 * @param {string} name — NPC name
 * @param {string} id — observation id
 * @returns {boolean} true if deleted
 */
export function deleteRawObservation(name, id) {
    const file = getEvidenceFile(name, false);
    if (!file) return false;
    const before = (file.raw || []).length;
    file.raw = (file.raw || []).filter(o => o.id !== id);
    if (file.raw.length === before) return false;

    // Clean up dangling back-references in consolidated entries.
    for (const con of (file.consolidated || [])) {
        if (Array.isArray(con.sources)) {
            con.sources = con.sources.filter(s => s !== id);
        }
    }
    touch(file);
    return true;
}

/**
 * Toggle the canon flag on a raw observation. Canon claims are user-authored,
 * authoritative, and outrank inference during profile generation.
 *
 * @param {string} name — NPC name
 * @param {string} id — observation id
 * @param {boolean} [value] — if omitted, toggles
 * @returns {boolean} the new canon value, or null if not found
 */
export function toggleCanon(name, id, value) {
    const file = getEvidenceFile(name, false);
    if (!file) return null;
    const obs = (file.raw || []).find(o => o.id === id);
    if (!obs) return null;
    obs.canon = value != null ? !!value : !obs.canon;
    touch(file);
    return obs.canon;
}

// ─── Consolidation: raw → consolidated (Slice 3) ──────────────────────────────

/**
 * Get the raw observations for a consolidation pass, formatted with numeric
 * IDs as the model expects them. Canon-flagged observations are marked so the
 * consolidator knows they're authoritative.
 *
 * Only non-canon observations are returned for consolidation — canon claims
 * are user-authored authoritative facts that should not be distilled away.
 * They remain in raw[] and are passed to the profile generator separately.
 *
 * @param {string} name — NPC name
 * @returns {Array<{numericId:number, id:string, category:string, claim:string, quote:string, canon:boolean}>}
 */
export function getRawForConsolidation(name) {
    const file = getEvidenceFile(name, false);
    if (!file) return [];
    return (file.raw || [])
        .filter(o => !o.canon) // canon stays raw, never consolidated away
        .map((o, i) => ({
            numericId: i + 1,
            id: o.id,
            category: validCategory(o.category),
            claim: o.claim,
            quote: o.quote,
            canon: !!o.canon,
        }));
}

/**
 * Apply a consolidation pass: APPEND the distilled entries to consolidated[]
 * and move the raw observations they consumed to archivedRaw[].
 *
 * Raw observations NOT cited by any new consolidated entry stay in raw[] —
 * the user can re-consolidate later or leave them as-is. This preserves the
 * "accumulate, don't overwrite" principle: consolidation only moves what it
 * actually distilled.
 *
 * The tier is APPENDED to, never replaced. Each pass only ever sees the raw
 * observations captured since the last one (consumed raws are archived out of
 * the pool), so overwriting the tier would delete the claims distilled from
 * every earlier era of the chat. Those claims are also the only way back to
 * their sources — the raws they cite live in archivedRaw, which the profile
 * generator never reads directly and Expand can only reach through the citing
 * entry. Appending is what makes consolidation repeatable rather than a
 * one-shot that silently forgets the character's past.
 *
 * @param {string} name — NPC name
 * @param {Array<{category:string, claim:string, sources:number[], confidence?:string}>} consolidated — from the API
 * @returns {{consolidatedCount:number, archivedCount:number, totalConsolidated:number}}
 *   `consolidatedCount` counts the claims ADDED by this pass;
 *   `totalConsolidated` is the size of the tier afterwards.
 */
export function applyConsolidation(name, consolidated, sourceIds) {
    const file = getEvidenceFile(name, false);
    if (!file) return { consolidatedCount: 0, archivedCount: 0, totalConsolidated: 0 };
    if (!file.raw) file.raw = [];
    if (!file.consolidated) file.consolidated = [];
    if (!file.archivedRaw) file.archivedRaw = [];

    // Map numeric source IDs → raw observation ids. The numeric ID is the
    // 1-based position among non-canon raw observations (as presented to the
    // consolidator). We prefer a SNAPSHOT of the ids at presentation time
    // (threaded from consolidateEvidence via `sourceIds`) — re-deriving from
    // the current raw[] state is unsafe because the user can delete an
    // observation or toggle canon during the API round-trip, shifting every
    // position after it and archiving the wrong observations (item 4 fix).
    const numericToId = new Map();
    if (Array.isArray(sourceIds)) {
        sourceIds.forEach((id, i) => numericToId.set(i + 1, id));
    } else {
        // Fallback: re-derive from current state (used by callers that
        // don't thread the snapshot — backward compatible).
        const nonCanonRaw = file.raw.filter(o => !o.canon);
        nonCanonRaw.forEach((o, i) => numericToId.set(i + 1, o.id));
    }

    // Build the new consolidated entries with resolved source ids. Ids come
    // from a seeded sequence, not nextObsId: these entries aren't written back
    // to the file until after the loop, so a per-iteration rescan of the stored
    // tier would hand every claim in the batch the same id.
    const nextConsolidatedId = obsIdSequence(file, 'consolidated');
    const newConsolidated = [];
    const consumedRawIds = new Set();
    for (const con of consolidated) {
        if (!con || !con.claim) continue;
        const resolvedSourceIds = (Array.isArray(con.sources) ? con.sources : [])
            .map(n => numericToId.get(n))
            .filter(id => id != null);
        if (resolvedSourceIds.length === 0) continue; // a consolidated claim with no valid sources is inadmissible
        // KNOWLEDGE-08: Verify every source still exists in file.raw before
        // committing. A concurrent delete during the API round-trip would
        // leave dangling provenance — a consolidated claim pointing at a
        // source that no longer exists anywhere in the evidence file.
        const validSourceIds = resolvedSourceIds.filter(id => file.raw.some(o => o.id === id));
        if (validSourceIds.length === 0) continue; // all sources deleted during the call — inadmissible
        validSourceIds.forEach(id => consumedRawIds.add(id));

        // Compute firstSeen/lastSeen from the source observations.
        // KNOWLEDGE-08: use validSourceIds (filtered above) so timestamps
        // aren't computed from deleted observations.
        const sourceObs = validSourceIds
            .map(id => file.raw.find(o => o.id === id))
            .filter(Boolean);
        const timestamps = sourceObs.map(o => o.ts).filter(t => typeof t === 'number');
        const firstSeen = timestamps.length > 0 ? Math.min(...timestamps) : null;
        const lastSeen = timestamps.length > 0 ? Math.max(...timestamps) : null;

        newConsolidated.push({
            id: nextConsolidatedId(),
            category: validCategory(con.category),
            claim: String(con.claim).trim(),
            sources: validSourceIds,
            firstSeen,
            lastSeen,
            confidence: ['high', 'medium', 'low'].includes(con.confidence) ? con.confidence : 'medium',
        });
    }

    // Move consumed raw observations to archivedRaw (retain original ids so
    // back-references stay valid). They are NOT deleted — just archived.
    let archivedCount = 0;
    if (consumedRawIds.size > 0) {
        const toArchive = file.raw.filter(o => consumedRawIds.has(o.id));
        file.archivedRaw.push(...toArchive);
        file.raw = file.raw.filter(o => !consumedRawIds.has(o.id));
        archivedCount = toArchive.length;
    }

    // Append to the consolidated tier — see the note above on why this must
    // never be a replacement.
    file.consolidated.push(...newConsolidated);

    touch(file);
    return {
        consolidatedCount: newConsolidated.length,
        archivedCount,
        totalConsolidated: file.consolidated.length,
    };
}

/**
 * Update a consolidated claim's text or category. Editing does not change its
 * sources back-references or id.
 *
 * @param {string} name — NPC name
 * @param {string} id — consolidated entry id (e.g. "con-1")
 * @param {{claim?:string, category?:string}} patch
 * @returns {boolean} true if updated
 */
export function updateConsolidated(name, id, patch) {
    const file = getEvidenceFile(name, false);
    if (!file) return false;
    const con = (file.consolidated || []).find(c => c.id === id);
    if (!con) return false;
    if (patch.claim != null) con.claim = String(patch.claim).trim();
    if (patch.category != null) con.category = validCategory(patch.category);
    touch(file);
    return true;
}

/**
 * Delete a consolidated entry. Its source observations stay archived (they
 * were already moved during consolidation). The consolidated claim is removed
 * but NOT moved to any audit tier — it was derived, not observed.
 *
 * @param {string} name — NPC name
 * @param {string} id — consolidated entry id
 * @returns {boolean} true if deleted
 */
export function deleteConsolidated(name, id) {
    const file = getEvidenceFile(name, false);
    if (!file) return false;
    const before = (file.consolidated || []).length;
    file.consolidated = (file.consolidated || []).filter(c => c.id !== id);
    if (file.consolidated.length === before) return false;
    touch(file);
    return true;
}

/**
 * Expand a consolidated claim: restore its source observations from
 * archivedRaw back to raw[] and remove the consolidated entry. This lets the
 * user undo a consolidation that went in the wrong direction.
 *
 * @param {string} name — NPC name
 * @param {string} id — consolidated entry id
 * @returns {boolean} true if expanded
 */
export function expandConsolidated(name, id) {
    const file = getEvidenceFile(name, false);
    if (!file) return false;
    const con = (file.consolidated || []).find(c => c.id === id);
    if (!con) return false;

    // Restore archived source observations to raw[]
    if (Array.isArray(con.sources)) {
        for (const sourceId of con.sources) {
            const archivedIdx = (file.archivedRaw || []).findIndex(o => o.id === sourceId);
            if (archivedIdx !== -1) {
                file.raw.push(file.archivedRaw[archivedIdx]);
                file.archivedRaw.splice(archivedIdx, 1);
            }
        }
    }

    // Remove the consolidated entry
    file.consolidated = (file.consolidated || []).filter(c => c.id !== id);
    touch(file);
    return true;
}

// ─── User overrides (Slice 3) ────────────────────────────────────────────────

/**
 * Get the userOverrides array from the evidence file. These are hand-edits to
 * the profile that survive regeneration — the user can pin specific prose or
 * corrections that the generator should not overwrite.
 *
 * @param {string} name — NPC name
 * @returns {Array<{id:string, text:string, addedAt:number}>}
 */
export function getUserOverrides(name) {
    const file = getEvidenceFile(name, false);
    return file?.userOverrides || [];
}

/**
 * Add a user override — a hand-edit that survives regeneration.
 *
 * @param {string} name — NPC name
 * @param {string} text — the override text
 * @returns {string|null} the new override id, or null on failure
 */
export function addUserOverride(name, text) {
    const file = getEvidenceFile(name, false);
    if (!file) return null;
    if (!file.userOverrides) file.userOverrides = [];
    const id = `usr-${String(file.userOverrides.length + 1).padStart(3, '0')}`;
    file.userOverrides.push({ id, text: String(text).trim(), addedAt: Date.now() });
    touch(file);
    return id;
}

/**
 * Update a user override's text.
 *
 * @param {string} name — NPC name
 * @param {string} id — override id
 * @param {string} text — new text
 * @returns {boolean} true if updated
 */
export function updateUserOverride(name, id, text) {
    const file = getEvidenceFile(name, false);
    if (!file || !file.userOverrides) return false;
    const ov = file.userOverrides.find(o => o.id === id);
    if (!ov) return false;
    ov.text = String(text).trim();
    touch(file);
    return true;
}

/**
 * Delete a user override.
 *
 * @param {string} name — NPC name
 * @param {string} id — override id
 * @returns {boolean} true if deleted
 */
export function deleteUserOverride(name, id) {
    const file = getEvidenceFile(name, false);
    if (!file || !file.userOverrides) return false;
    const before = file.userOverrides.length;
    file.userOverrides = file.userOverrides.filter(o => o.id !== id);
    if (file.userOverrides.length === before) return false;
    touch(file);
    return true;
}

// ─── Reading evidence for profile generation ─────────────────────────────────

/**
 * Collect the evidence to send to the profile generator.
 *
 * Order of precedence (blueprint §"How the tiers interact"):
 *   1. Consolidated entries first (stable, distilled) — when present.
 *   2. Raw entries for detail.
 *   3. Canon-flagged entries are always included and marked as canon.
 *
 * `archivedRaw` is NEVER sent to the generator — it's an audit trail.
 *
 * Returns a flat array of observation-shaped objects with a `tier` field
 * ('consolidated' | 'raw') and a `canon` flag.
 *
 * @param {string} name — NPC name
 * @returns {Array<{category:string, claim:string, quote:string, msgIdx:number|null, tier:string, canon:boolean, sources?:string[]}>}
 */
export function getEvidenceForProfile(name) {
    const file = getEvidenceFile(name, false);
    if (!file) return [];

    const out = [];

    // Consolidated first (stable, distilled). Each consolidated claim cites its
    // source observation ids; we attach the first source's quote as a
    // representative receipt so the generator still has a verbatim anchor.
    for (const con of (file.consolidated || [])) {
        const sourceObs = (con.sources || [])
            .map(sid => (file.raw || []).find(o => o.id === sid) || (file.archivedRaw || []).find(o => o.id === sid))
            .filter(Boolean);
        const quote = sourceObs.length > 0 ? sourceObs[0].quote : '';
        out.push({
            category: validCategory(con.category),
            claim: con.claim,
            quote,
            msgIdx: sourceObs.length > 0 ? sourceObs[0].msgIdx : null,
            tier: 'consolidated',
            canon: false,
            sources: con.sources || [],
            id: con.id,
        });
    }

    // Raw entries for detail.
    for (const obs of (file.raw || [])) {
        out.push({
            category: validCategory(obs.category),
            claim: obs.claim,
            quote: obs.quote,
            msgIdx: obs.msgIdx,
            tier: 'raw',
            canon: !!obs.canon,
            verified: obs.verified !== false, // carry through the verbatim flag
            id: obs.id,                       // needed by the evidence editor UI
        });
    }

    return out;
}

/**
 * Return a summary of an NPC's evidence file for display.
 *
 * @param {string} name — NPC name
 * @returns {{raw:number, consolidated:number, archivedRaw:number, lastProfileAt:number|null}|null}
 */
export function getEvidenceSummary(name) {
    const file = getEvidenceMap()[name];
    if (!file) return null;
    return {
        raw: (file.raw || []).length,
        consolidated: (file.consolidated || []).length,
        archivedRaw: (file.archivedRaw || []).length,
        lastProfileAt: file.meta?.lastProfileAt || null,
    };
}

// ─── Capture watermark (Part A: continuous incremental capture) ──────────────
//
// `lastCaptureTs` is a high-water mark: the maximum `ts` among all messages
// processed by capture for this NPC. Continuous capture (Part A) processes
// only the delta — messages with send_date > lastCaptureTs — and appends to
// raw[]. This is summary-proof by construction: observations are distilled
// while raw messages are live, so later summarization can't touch them.
// Watermark on ts (not msgIdx) because indices are unstable across edits.

/**
 * Get the capture watermark for an NPC: the max `ts` of all messages whose
 * evidence has been captured. Returns null for a new NPC (nothing captured
 * yet), meaning a full initial window should be scanned.
 *
 * @param {string} name — NPC name
 * @returns {number|null} ms timestamp, or null if no capture has run
 */
export function getCaptureWatermark(name) {
    const file = getEvidenceFile(name, false);
    return file?.meta?.lastCaptureTs ?? null;
}

/**
 * Advance the capture watermark to the given timestamp (if it's newer than the
 * current value). Called after a successful capture pass.
 *
 * @param {string} name — NPC name
 * @param {number} ts — the max send_date among captured messages
 */
export function setCaptureWatermark(name, ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    const file = getEvidenceFile(name);
    const cur = file.meta.lastCaptureTs;
    if (cur == null || ts > cur) {
        file.meta.lastCaptureTs = ts;
        touch(file);
    }
}

// ─── Backfill watermark (Part B: ILS de-summarize backfill) ──────────────────
//
// `lastBackfillTs` is a FORWARD-WALKING cursor separate from the continuous-
// capture watermark (`lastCaptureTs`). It tracks how far through the de-
// summarized history backfill has progressed, so repeat backfill runs continue
// forward rather than re-processing the same batch.
//
// It must be separate because the two watermarks point in different directions:
// continuous capture's watermark is a high-water mark (recent ts); backfill's
// is a low-to-high cursor walking through OLD summarized history (ts << recent).
// Sharing one field would make backfill's old batch max lose to continuous's
// recent max (setCaptureWatermark is monotonic), freezing backfill in place.

/**
 * Get the backfill watermark for an NPC: the max `ts` of the de-summarized
 * messages backfill has processed. Returns null if backfill hasn't run yet.
 *
 * @param {string} name — NPC name
 * @returns {number|null} ms timestamp, or null if no backfill has run
 */
export function getBackfillWatermark(name) {
    const file = getEvidenceFile(name, false);
    return file?.meta?.lastBackfillTs ?? null;
}

/**
 * Advance the backfill watermark to the given timestamp (if newer than the
 * current value). Called after a backfill batch is processed.
 *
 * @param {string} name — NPC name
 * @param {number} ts — the max send_date among backfilled messages in this batch
 */
export function setBackfillWatermark(name, ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    const file = getEvidenceFile(name);
    if (!file.meta) file.meta = {};
    const cur = file.meta.lastBackfillTs;
    if (cur == null || ts > cur) {
        file.meta.lastBackfillTs = ts;
        touch(file);
    }
}

// ─── Profile stamp ───────────────────────────────────────────────────────────

/**
 * Stamp that a profile was generated for this NPC at the current time.
 * Called after the profile is written to the NPC Profiles lorebook.
 *
 * @param {string} name — NPC name
 */
export function stampProfileGenerated(name) {
    const file = getEvidenceFile(name);
    file.meta.lastProfileAt = Date.now();
    touch(file);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = ['trait', 'value', 'speech'];

function validCategory(cat) {
    return VALID_CATEGORIES.includes(cat) ? cat : 'trait';
}

/**
 * Build a dedup key from claim + quote (normalized) so re-running capture on
 * overlapping windows doesn't pile up identical receipts.
 */
function normalizeKey(claim, quote) {
    const n = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return `${n(claim)}\u0000${n(quote)}`;
}

/**
 * Extract the canonical timestamp from a chat message by index.
 * `ts` is canonical for retrieval (survives message deletion/edit). We prefer
 * the message's send_date (parsed via the shared, format-agnostic
 * `sendDateToMs` helper); if unavailable (or the index is stale), we fall
 * back to the capture time so the field is always populated.
 *
 * @param {Array} chat
 * @param {number|null} msgIdx
 * @returns {number} ms timestamp
 */
function extractMsgTs(chat, msgIdx) {
    if (msgIdx != null && msgIdx >= 0 && msgIdx < chat.length) {
        const ms = sendDateToMs(chat[msgIdx]?.send_date);
        if (ms != null) return ms;
    }
    return Date.now();
}
