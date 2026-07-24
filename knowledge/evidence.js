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
 *     meta: { createdAt, updatedAt, lastProfileAt }
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

import { getChatMeta, persistChatMeta, getChat } from '../core/index.js';
import { GROWTH_EVIDENCE_KEY } from './state.js';

// ─── Evidence map (all NPCs in this chat) ─────────────────────────────────────

/**
 * Get the evidence map for this chat: { npcName: EvidenceFile }.
 * Returns the live metadata object (mutate then call saveEvidenceMap()).
 *
 * @returns {Object<string, EvidenceFile>}
 */
export function getEvidenceMap() {
    const meta = getChatMeta();
    if (!meta[GROWTH_EVIDENCE_KEY]) meta[GROWTH_EVIDENCE_KEY] = {};
    return meta[GROWTH_EVIDENCE_KEY];
}

/**
 * Persist the evidence map to chat metadata.
 * Call after mutating the object returned by getEvidenceMap().
 */
export function saveEvidenceMap() {
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
    return !!(file && (file.raw?.length > 0 || file.consolidated?.length > 0));
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
 * Generate the next observation ID for a tier.
 * Scans both the active tier and archivedRaw (for raw) so IDs never collide
 * with archived entries that retain their original ids.
 *
 * @param {EvidenceFile} file
 * @param {'raw'|'consolidated'} tier
 * @returns {string}
 */
export function nextObsId(file, tier) {
    const prefix = tier === 'consolidated' ? 'con-' : 'obs-';
    const scan = tier === 'raw'
        ? [...(file.raw || []), ...(file.archivedRaw || [])]
        : (file.consolidated || []);
    let max = 0;
    for (const entry of scan) {
        const m = String(entry.id || '').match(/\d+$/);
        if (m) max = Math.max(max, parseInt(m[0], 10));
    }
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
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
 * @param {Array<{category:string, claim:string, quote:string, msgIdx:number|null, verified?:boolean}>} observations
 * @returns {{added: number, skipped: number}} counts
 */
export function appendRawObservations(name, observations) {
    const file = getEvidenceFile(name);
    const chat = getChat() || [];
    const existing = new Set(
        (file.raw || []).map(o => normalizeKey(o.claim, o.quote))
    );

    let added = 0;
    let skipped = 0;
    for (const obs of observations) {
        if (!obs || !obs.claim || !obs.quote) { skipped++; continue; }
        const key = normalizeKey(obs.claim, obs.quote);
        if (existing.has(key)) { skipped++; continue; }
        existing.add(key);

        const ts = extractMsgTs(chat, obs.msgIdx);
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
    if (patch.claim != null) obs.claim = String(patch.claim).trim();
    if (patch.quote != null) obs.quote = String(patch.quote).trim();
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
 * the message's send_date; if unavailable (or the index is stale), we fall
 * back to the capture time so the field is always populated.
 *
 * @param {Array} chat
 * @param {number|null} msgIdx
 * @returns {number} ms timestamp
 */
function extractMsgTs(chat, msgIdx) {
    if (msgIdx != null && msgIdx >= 0 && msgIdx < chat.length) {
        const msg = chat[msgIdx];
        // ST stores send_date as a Unix timestamp (seconds or ms depending on
        // version). Normalize to ms.
        const sd = msg?.send_date;
        if (typeof sd === 'number' && sd > 0) {
            return sd > 1e12 ? sd : sd * 1000;
        }
    }
    return Date.now();
}