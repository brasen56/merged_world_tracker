/**
 * world_state/delta.js — Low-cost delta refresh: patch protocol, document
 * status bookkeeping, and the delta-vs-full planning decision.
 *
 * Implements TODO §3 item F (source: Audit_Reports/Potential_Improvements.md
 * §3, "Low-cost delta mode for World State"):
 *   - parseDeltaPatch()/applyDeltaPatch() — the validated patch the model is
 *     asked to produce (### UPDATE: / ### REMOVE: / ### NO CHANGES). Parsing
 *     is STRICT: protocol-looking markers are recognized before body
 *     accumulation (inside operations too), "### NO CHANGES" mixed with any
 *     operation is rejected, content under ### REMOVE and duplicate
 *     operations for one section are rejected — none of it may leak into the
 *     document as section content.
 *   - buildDeltaSystemPrompt()/buildDeltaUserMessage() — the delta-mode
 *     prompts (a strict OVERRIDE block on top of the normal system prompt,
 *     mirroring sections.js's section-regen override).
 *   - deltaStatus bookkeeping + deriveDocumentStatus() — surfaces whether the
 *     document is fully reconciled / delta-updated / manually edited / stale
 *     relative to chat. Manual edits are detected by DIGEST COMPARISON
 *     (core/revision.js captureRevision), so every out-of-band write path
 *     (manual Save, import, revert, editor debounce persist) is covered
 *     without sprinkling hook calls at each call site.
 *     buildPartialRefreshStatus() stamps partial updates (delta patches,
 *     section regens) without ever clearing that manual signal.
 *   - planAutoRefresh() — decides whether the next scheduled refresh is a
 *     cheap delta or the periodic full reconciliation.
 *
 * Leaf-ish module — imports only data.js / settings.js (+ core) to avoid
 * circular deps with refresh.js / sections.js, which import this instead.
 * The orchestration (API call, guards, retry) lives in refresh.js.
 */

import {
    getStableHistoryEnd, captureRevision, truncateText,
} from '../core/index.js';
import {
    SECTIONS, getWorldStateText, getWorldStateData,
    extractOnlySection, replaceSection, removeSection,
} from './data.js';
import { getSettings } from './settings.js';

// ─── Settings accessors ───────────────────────────────────────────────────────

/** Delta mode is off by default (same policy as expiry/grounding). */
export function isDeltaModeEnabled() {
    return getSettings().deltaMode === true;
}

/** After this many consecutive delta (partial) updates, force a full refresh. */
export function getDeltaReconcileEvery() {
    const raw = parseInt(getSettings().deltaReconcileEvery, 10);
    if (isNaN(raw) || raw < 1) return 5;
    return raw;
}

/** The document counts as "stale relative to chat" once this many messages
 *  have arrived since the last refresh of any kind. */
export function getDeltaStaleAfterMsgs() {
    const raw = parseInt(getSettings().deltaStaleAfterMsgs, 10);
    if (isNaN(raw) || raw < 1) return 15;
    return raw;
}

// ─── Document digest + status bookkeeping ────────────────────────────────────
//
// The status record lives at chat_metadata.world_state_tracker_metadata.deltaStatus.
// The store validator passes unknown keys through unchanged, so it needs no
// schema change; backup/restore carries it as part of the store value.
//
// Shape (schemaVersion 1):
//   lastRefreshKind    — 'full' | 'delta' | null (null = never refreshed)
//   lastRefreshAtMsg   — chat length at the refresh commit
//   lastRefreshAt      — epoch ms of the refresh commit
//   deltasSinceFull    — consecutive partial updates since the last full one
//   lastRefreshDigest  — digest of the document text AS COMMITTED by that
//                        refresh; any later divergence = manual edit

const DELTA_STATUS_VERSION = 1;

/** Digest a document. Reuses the Tier-0 revision primitive (fnv-1a over a
 *  normalized value) rather than growing a second hashing helper. */
export function digestText(text) {
    return captureRevision(typeof text === 'string' ? text : '').digest;
}

function normalizeDeltaStatus(raw) {
    if (!raw || typeof raw !== 'object') {
        return {
            schemaVersion: DELTA_STATUS_VERSION,
            lastRefreshKind: null,
            lastRefreshAtMsg: 0,
            lastRefreshAt: 0,
            deltasSinceFull: 0,
            lastRefreshDigest: '',
        };
    }
    return {
        schemaVersion: DELTA_STATUS_VERSION,
        lastRefreshKind: raw.lastRefreshKind === 'full' || raw.lastRefreshKind === 'delta' ? raw.lastRefreshKind : null,
        lastRefreshAtMsg: Number.isFinite(raw.lastRefreshAtMsg) ? raw.lastRefreshAtMsg : 0,
        lastRefreshAt: Number.isFinite(raw.lastRefreshAt) ? raw.lastRefreshAt : 0,
        deltasSinceFull: Number.isFinite(raw.deltasSinceFull) ? Math.max(0, Math.floor(raw.deltasSinceFull)) : 0,
        lastRefreshDigest: typeof raw.lastRefreshDigest === 'string' ? raw.lastRefreshDigest : '',
    };
}

export function getDeltaStatus() {
    return normalizeDeltaStatus(getWorldStateData().deltaStatus);
}

/**
 * Pure builder for the next status record. Callers include the result in the
 * SAME checked-write patch as the text, so text and status commit atomically
 * (a separate bookkeeping write could be refused and leave a stale digest).
 *
 * @param {'full'|'delta'} kind — 'delta' also covers section regeneration
 *   (a partial, LLM-driven update; counting it toward reconciliation is
 *   deliberate — cheap updates must not postpone reconciliation forever).
 * @param {string} committedText — the document exactly as it is being committed
 * @param {object} prevStatus — the previous normalized status record
 * @param {number} msgIndex — stable-history END this refresh scanned through
 *   (the message watermark). NOT chat length: the in-flight tail beyond the
 *   settled-history cutoff is never scanned and must not be stamped as seen.
 */
export function buildRefreshStatusDelta(kind, committedText, prevStatus, msgIndex) {
    const prev = normalizeDeltaStatus(prevStatus);
    return {
        schemaVersion: DELTA_STATUS_VERSION,
        lastRefreshKind: kind,
        lastRefreshAtMsg: Number.isFinite(msgIndex) ? msgIndex : 0,
        lastRefreshAt: Date.now(),
        deltasSinceFull: kind === 'full' ? 0 : prev.deltasSinceFull + 1,
        lastRefreshDigest: digestText(committedText),
    };
}

/**
 * Status stamp for a PARTIAL LLM update that splices into an existing
 * document — a delta patch (refresh.js) or a single-section regeneration
 * (sections.js).
 *
 * A partial update only reconciles the sections it touched, so it may stamp a
 * fresh digest ONLY when the incoming document already matched its previous
 * refresh digest (nothing else had manual edits pending). Otherwise the
 * previous digest is kept — including the empty legacy value — so the
 * committed document still differs from it and keeps reporting as manually
 * edited until a FULL refresh reconciles everything. The refresh kind and
 * reconciliation cadence still advance: the partial update did happen, and
 * cheap updates must not postpone reconciliation forever. The WATERMARK is
 * whatever the caller passes — delta patches stamp their scan's end, while
 * section regeneration deliberately re-stamps the PREVIOUS watermark
 * (the watermark-preservation rule: one regenerated section must not hide the
 * messages that changed the other sections from the next delta scan).
 *
 * @param {object} prevStatus — the previous normalized status record
 * @param {string} prevText — the document exactly as it was BEFORE this operation
 * @param {string} committedText — the document exactly as it is being committed
 * @param {number} msgIndex — stable-history end (message watermark) of this update
 */
export function buildPartialRefreshStatus(prevStatus, prevText, committedText, msgIndex) {
    const prev = normalizeDeltaStatus(prevStatus);
    const stamped = buildRefreshStatusDelta('delta', committedText, prev, msgIndex);
    const incomingWasReconciled = typeof prevText === 'string'
        && !!prev.lastRefreshDigest
        && digestText(prevText) === prev.lastRefreshDigest;
    return incomingWasReconciled ? stamped : { ...stamped, lastRefreshDigest: prev.lastRefreshDigest };
}

/**
 * Derive the user-facing document status (PI §3's four states, plus 'empty').
 *
 * Priority: empty → manual → stale → delta → reconciled. Manual beats stale so
 * the user never loses the signal that a refresh would build on their edits;
 * stale beats delta because staleness is the actionable fact.
 *
 * msgsSinceRefresh is null only for 'empty'/'manual' (no like-for-like
 * baseline to count from). For every digest-matched document it is a number —
 * even when the watermark itself is 0 (a valid zero watermark).
 *
 * @returns {{ kind: 'empty'|'manual'|'stale'|'delta'|'reconciled',
 *             msgsSinceRefresh: number|null, deltasSinceFull: number,
 *             lastRefreshKind: string|null, lastRefreshAtMsg: number }}
 */
export function deriveDocumentStatus({ currentMsgIndex } = {}) {
    const text = getWorldStateText();
    if (!text?.trim()) {
        return { kind: 'empty', msgsSinceRefresh: null, deltasSinceFull: 0, lastRefreshKind: null, lastRefreshAtMsg: 0 };
    }
    const st = getDeltaStatus();

    // No recorded baseline (legacy/imported document): the provenance of every
    // line is user-authored, so the honest status is "manually edited".
    if (!st.lastRefreshDigest || digestText(text) !== st.lastRefreshDigest) {
        return { kind: 'manual', msgsSinceRefresh: null, deltasSinceFull: st.deltasSinceFull, lastRefreshKind: st.lastRefreshKind, lastRefreshAtMsg: st.lastRefreshAtMsg };
    }

    // Like-for-like with the watermark stamps (refresh.js / sections.js):
    // those record the stable-history END — where the last scan actually
    // stopped — not chat length, so the in-flight tail is never counted as
    // "messages since the refresh".
    //
    // The digest matched above, so this document HAS a refresh baseline and
    // lastRefreshAtMsg is a genuine watermark — including 0, which a full
    // refresh in a short chat legitimately records (stable-history end 0).
    // A valid zero watermark: 0 must not be treated as "no watermark" (that
    // case is the missing-digest branch above); the difference is computed
    // normally so the status does go stale as settled messages accumulate.
    const msgIndex = Number.isFinite(currentMsgIndex) ? currentMsgIndex : getStableHistoryEnd();
    const msgsSinceRefresh = Math.max(0, msgIndex - st.lastRefreshAtMsg);

    if (msgsSinceRefresh >= getDeltaStaleAfterMsgs()) {
        return { kind: 'stale', msgsSinceRefresh, deltasSinceFull: st.deltasSinceFull, lastRefreshKind: st.lastRefreshKind, lastRefreshAtMsg: st.lastRefreshAtMsg };
    }
    if (st.deltasSinceFull > 0) {
        return { kind: 'delta', msgsSinceRefresh, deltasSinceFull: st.deltasSinceFull, lastRefreshKind: st.lastRefreshKind, lastRefreshAtMsg: st.lastRefreshAtMsg };
    }
    return { kind: 'reconciled', msgsSinceRefresh, deltasSinceFull: 0, lastRefreshKind: st.lastRefreshKind, lastRefreshAtMsg: st.lastRefreshAtMsg };
}

/**
 * Decide how the NEXT scheduled refresh should run.
 *
 * Delta runs only when it is safe and useful; every "no" reason routes to a
 * full refresh so the scheduled cadence never silently stalls:
 *   - disabled → full (obviously)
 *   - no document → full (a delta needs a baseline to patch)
 *   - no refresh baseline on record → full (imported/legacy document must be
 *     reconciled once before cheap updates can build on it)
 *   - manual edits since the last refresh → full (reconcile the user's edits
 *     with the chat instead of patching on top of an unverified baseline)
 *   - deltasSinceFull >= reconcileEvery → full (periodic reconciliation)
 */
export function planAutoRefresh() {
    if (!isDeltaModeEnabled()) return { kind: 'full', reason: 'delta-mode-disabled' };
    const text = getWorldStateText();
    if (!text?.trim()) return { kind: 'full', reason: 'no-document' };
    const st = getDeltaStatus();
    if (!st.lastRefreshDigest) return { kind: 'full', reason: 'no-refresh-baseline' };
    if (digestText(text) !== st.lastRefreshDigest) return { kind: 'full', reason: 'manual-edits-since-refresh' };
    if (st.deltasSinceFull >= getDeltaReconcileEvery()) return { kind: 'full', reason: 'reconciliation-due' };
    return { kind: 'delta', reason: 'scheduled' };
}

// ─── Patch protocol ───────────────────────────────────────────────────────────
//
// The patch format is deliberately line-oriented and marker-prefixed so it can
// be parsed without JSON (the models behind this extension are far more
// reliable with plain-marker formats than with strict JSON), while still being
// strictly VALIDATABLE:
//
//   ### UPDATE: <Section Name>
//   ## <Section Name>
//   <complete replacement body for that section>
//
//   ### REMOVE: <Section Name>
//
//   ### NO CHANGES
//
// Section names must be one of the canonical SECTIONS. A body is required for
// UPDATE and should open with the section's own "## Name" header (applyDeltaPatch
// normalizes a missing header by prepending it, so a model that omits it does
// not lose the section header on splice).

export class DeltaPatchError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'DeltaPatchError';
    }
}

const OP_MARKER_RE = /^#{2,6}\s*(UPDATE|REMOVE)\s*:\s*(.+?)\s*$/;
const NO_CHANGES_RE = /^#{2,6}\s*NO CHANGES\s*$/i;
// Any other ALL-CAPS "### FOO:" marker is a protocol violation. The header of
// an UPDATE body ("## Current Scene") does not match: "Current Scene" is not
// ALL-CAPS-before-colon, and prose inside a body is only checked while no op
// is open (pre-marker preamble position).
// All three marker regexes are matched against the TRIMMED line, uniformly:
// models occasionally indent a header, and an indented "### NO CHANGES"
// parsing while an indented "### UPDATE:" died as a preamble error was an
// inconsistency.
const UNKNOWN_MARKER_RE = /^#{2,6}\s+[A-Z][A-Z ]*:/;

/** Accept a canonical section name from a marker line: case-insensitive,
 *  tolerant of surrounding **bold**, always canonicalized to the SECTIONS
 *  spelling so downstream splices match exactly. */
function canonicalSectionName(raw) {
    const cleaned = raw.trim().replace(/^\*+|\*+$/g, '').replace(/\s+/g, ' ').trim();
    return SECTIONS.find(name => name.toLowerCase() === cleaned.toLowerCase()) || null;
}

/**
 * Parse and validate a model-produced delta patch.
 *
 * @param {string} raw — the model output (already normaliseOutput'd)
 * @returns {{ ok: true, ops: Array<{type:'update'|'remove', section: string, body: string}>, noChanges: boolean }
 *          | { ok: false, reason: string }}
 */
export function parseDeltaPatch(raw) {
    if (!raw || !raw.trim()) return { ok: false, reason: 'empty patch' };

    // Models occasionally wrap structured output in a code fence even when
    // told not to; strip one outer fence rather than failing on it.
    let cleaned = raw.trim();
    const fence = cleaned.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
    if (fence) cleaned = fence[1].trim();

    const lines = cleaned.split('\n');
    const ops = [];
    const seenSections = new Set();
    let current = null;
    let sawNoChanges = false;
    let sawContent = false; // any op or NO CHANGES marker seen

    const pushCurrent = () => {
        if (!current) return;
        ops.push(current);
        current = null;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        const marker = trimmed.match(OP_MARKER_RE);
        if (marker) {
            pushCurrent();
            const section = canonicalSectionName(marker[2]);
            if (!section) return { ok: false, reason: `unknown section "${marker[2].trim()}"` };
            if (seenSections.has(section)) {
                return { ok: false, reason: `duplicate operation for section "${section}" — merge them into a single operation` };
            }
            seenSections.add(section);
            current = {
                type: marker[1].toUpperCase() === 'UPDATE' ? 'update' : 'remove',
                section,
                bodyLines: [],
            };
            sawContent = true;
            continue;
        }
        if (NO_CHANGES_RE.test(trimmed)) {
            // "### NO CHANGES" is a whole-response marker. Mixed with ANY
            // operation — before one, between two, or inside an open body —
            // it is malformed output and must never be spliced into the
            // document as section content.
            if (current || ops.length > 0) {
                return { ok: false, reason: '"### NO CHANGES" mixed with update/remove operations' };
            }
            sawNoChanges = true;
            sawContent = true;
            continue;
        }
        if (UNKNOWN_MARKER_RE.test(trimmed)) {
            // Protocol-looking ALL-CAPS markers are recognized BEFORE body
            // accumulation — inside an operation as well as outside — so a
            // stray "### DELETE:" (or any other invented marker) can never
            // leak into the document as section content.
            return { ok: false, reason: `unknown patch marker "${trimmed.slice(0, 40)}"` };
        }
        if (current) {
            if (current.type === 'remove' && trimmed) {
                return { ok: false, reason: `"### REMOVE: ${current.section}" must not carry content below it` };
            }
            current.bodyLines.push(line);
        } else if (trimmed) {
            return { ok: false, reason: `unexpected text before the first marker: "${trimmed.slice(0, 40)}"` };
        }
    }
    pushCurrent();

    if (!sawContent) return { ok: false, reason: 'no patch operations found' };
    if (sawNoChanges && ops.length > 0) {
        return { ok: false, reason: '"### NO CHANGES" mixed with update/remove operations' };
    }

    // Final validation pass: every op must be well-formed.
    for (const op of ops) {
        if (op.type === 'remove' && op.section === 'Current Scene') {
            return { ok: false, reason: '"Current Scene" cannot be removed — update it instead' };
        }
        if (op.type === 'update' && !op.bodyLines.join('\n').trim()) {
            return { ok: false, reason: `UPDATE for "${op.section}" has an empty body` };
        }
    }

    return {
        ok: true,
        ops: ops.map(op => ({ type: op.type, section: op.section, body: op.bodyLines.join('\n').trim() })),
        noChanges: sawNoChanges && ops.length === 0,
    };
}

/** Does this body already open with the section's own header line? */
function bodyHasSectionHeader(body, sectionName) {
    const first = body.split('\n')[0]?.trim() || '';
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^#{1,6}\\s*\\*{0,2}${escaped}\\*{0,2}\\s*$`, 'i').test(first);
}

/** Insert a section the document does NOT currently have, at its canonical
 *  position in SECTIONS order — before the first present section that FOLLOWS
 *  it. replaceSection() appends a missing section at the document's end, so a
 *  delta that re-adds a previously-omitted section would otherwise drift out
 *  of canonical order until the next full reconciliation. A name outside
 *  SECTIONS (parseDeltaPatch already rejects those; defensive only) still
 *  appends at the end, where any unknown-to-the-template section belongs. */
function insertSectionAtCanonicalPosition(text, sectionName, body) {
    const trimmedBody = body.trim();
    const idx = SECTIONS.indexOf(sectionName);
    for (let i = idx + 1; idx !== -1 && i < SECTIONS.length; i++) {
        if (!extractOnlySection(text, SECTIONS[i])) continue;
        // Find that section's header line and splice in front of it. The
        // boundary lookahead mirrors data.js's SECTION_NAME_BOUNDARY so a body
        // line merely mentioning the name is never matched.
        const escaped = SECTIONS[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const at = text.search(new RegExp(`(?:^|\\n)## ${escaped}(?![A-Za-z0-9_])`));
        if (at === -1) continue;
        const insertAt = text[at] === '\n' ? at + 1 : at;
        return `${text.slice(0, insertAt).trimEnd()}\n\n${trimmedBody}\n\n${text.slice(insertAt).trimStart()}`.trim();
    }
    return (text.trim() + '\n\n' + trimmedBody).trim();
}

/**
 * Apply validated ops to a document. Splicing reuses data.js's section
 * machinery (WORLD-STATE-06 line-anchored patterns), so a body line that merely
 * mentions a section name is never treated as a boundary.
 *
 * Post-conditions checked here (the "validated" in "validated patch"):
 *   - the result is non-empty, and
 *   - "## Current Scene" still exists — it is the document's anchor section
 *     and every consumer (validateOutput, injection) assumes it.
 *
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function applyDeltaPatch(currentText, ops) {
    if (!Array.isArray(ops) || ops.length === 0) return { ok: false, reason: 'no operations to apply' };

    let text = currentText || '';
    for (const op of ops) {
        if (op.type === 'update') {
            // The patch protocol asks the model to open each UPDATE body with
            // the section header; if it forgot, prepend it so replaceSection's
            // splice does not silently drop the header.
            const body = bodyHasSectionHeader(op.body, op.section)
                ? op.body.trim()
                : `## ${op.section}\n${op.body.trim()}`;
            // A MISSING section is (re-)inserted at its canonical position —
            // replaceSection would append it at the document's end, drifting
            // out of SECTIONS order until the next full reconciliation.
            text = extractOnlySection(text, op.section)
                ? replaceSection(text, op.section, body)
                : insertSectionAtCanonicalPosition(text, op.section, body);
        } else if (op.type === 'remove') {
            text = removeSection(text, op.section);
        } else {
            return { ok: false, reason: `unknown op type "${op.type}"` };
        }
    }

    const result = text.trim();
    if (!result) return { ok: false, reason: 'patch would leave an empty document' };
    if (!extractOnlySection(result, 'Current Scene')) {
        return { ok: false, reason: 'patch removed the "## Current Scene" section' };
    }
    return { ok: true, text: result };
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

/** Same budget rationale as the full refresh's PREV_STATE_BUDGET
 *  (WORLD-STATE-03): a large imported state must not blow up every prompt. */
const DELTA_PREV_BUDGET = 30000;

export function buildDeltaSystemPrompt(basePrompt) {
    return `${basePrompt}

---

OVERRIDE FOR THIS GENERATION — DELTA PATCH MODE:
- You are updating an EXISTING world state document. Everything you do NOT mention stays exactly as it is.
- Output ONLY a patch listing the sections that CHANGED since the previous world state. No other sections. No commentary.
- Patch format — use exactly these markers, one per changed section:

### UPDATE: <Section Name>
## <Section Name>
<the COMPLETE new body for that section, in its normal format per the rules above>

### REMOVE: <Section Name>
<removes that section from the document entirely>

- If NOTHING changed, output exactly:
### NO CHANGES

Rules:
- Include ONLY sections whose content actually changed since the previous world state. Do NOT restate unchanged sections.
- Each ### UPDATE body must be the FULL replacement for that section (starting with its "## <Section Name>" header line) — never a line-by-line diff, a fragment, or a summary of changes.
- Each section may appear in AT MOST ONE operation, and a "### REMOVE" line carries NO content below it.
- Use ONLY the exact section names from the system prompt above.
- NEVER use ### REMOVE on "Current Scene" — update it instead whenever date, time, location, present characters, or the situation moved on.
- Apply every core rule above (rolling snapshot, drop stale entries, no invention, no speculation, omit empty sections) to each section you output.
- Your output MUST begin with "### UPDATE:" or "### NO CHANGES" — nothing before it.`;
}

export function buildDeltaUserMessage({ prevText = '', recentText = '', reminderReason = '' } = {}) {
    const prev = truncateText(String(prevText).trim(), DELTA_PREV_BUDGET);
    const recent = String(recentText).trim() || 'No recent messages.';
    const lines = [
        '### Previous World State',
        prev || '(empty)',
        '',
        '### Recent Chat Messages',
        recent,
        '',
        '='.repeat(60),
        'Output the patch now.',
        'Begin immediately with "### UPDATE:" (or "### NO CHANGES") — no preamble.',
    ];
    if (reminderReason) {
        lines.push('');
        lines.push(`[REMINDER: Your previous attempt was rejected — ${reminderReason}. Output ONLY the patch in the exact marker format from the system prompt.]`);
    }
    return lines.join('\n');
}

