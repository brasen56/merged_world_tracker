/**
 * Phase 4: orchestration for the reviewed single-NPC ledger condensation
 * (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md §Phase 4).
 *
 * This module owns everything between the UI and the Phase 2/3 seams:
 *   - eligibility + identity-bound capture (captureCleanupTarget + parseLedger),
 *   - the request budget (input/response envelope estimates, known-excess
 *     refusals, honest "unknown" capacity disclosure — never clipping),
 *   - the model request itself (ledger + NPC name ONLY in the payload, `[sN]`
 *     source labels out and a compact keep-list response back, manual
 *     trigger, cancellable via signal, strict parseLedgerProposal — never the
 *     lenient repair path — then expandKeepListProposal and
 *     validateLedgerProposal before any preview),
 *   - in-memory review drafts that survive modal close and scope sweeps while
 *     remaining bound to their origin (they are UI state, never prompt context),
 *   - apply/restore wrappers wiring validateLedgerReplacement and ledgerSpan
 *     into the Phase 3 commit service.
 *
 * A fresh review ID is generated for EVERY request, including regeneration
 * against identical content (Phase 2 obligation). Generation never writes the
 * live entry, and no proposal enters staging or auto-approval.
 */

import { resolveApiCall, isCancellation } from '../core/index.js';
import { estimateTokens } from '../core/context.js';
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { LEDGER_CLEANUP_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings } from './settings.js';
import { ktFetchFromApi } from './lorebook.js';
import {
    parseLedger,
    captureLedgerReview,
    parseLedgerProposal,
    validateLedgerProposal,
    LEDGER_PROPOSAL_VERSION,
    patchLedgerProposal,
    validateLedgerReplacement,
    ledgerSpan,
} from './ledger_cleanup.js';
import { captureCleanupTarget, applyCleanup, restoreCleanup, reconcileCleanupOutcome } from './cleanup_commit.js';
import { getCleanupRecord, currentCleanupScopeKey } from './cleanup_recovery.js';
import { getLorebookName } from './scope.js';

// ─── Review IDs ──────────────────────────────────────────────────────────────

/** A fresh ID for EVERY generation, regenerations included (Phase 2). */
export function newReviewId() {
    return `lr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── The wire form: [sN] labels out, a keep-list response back ──────────────

/**
 * The model sees `s1`..`sN` (source order, 1-based) instead of the full
 * `${reviewId}:source:N` ids: on a long ledger the full ids alone cost
 * thousands of tokens on both sides of the request. Staleness binding is
 * unchanged — the response still echoes <review_id>, and validation runs on
 * full ids after expandKeepListProposal.
 */
export function shortSourceId(index) {
    return `s${index + 1}`;
}

/**
 * Version of the RESPONSE wire format below. It is not the proposal schema
 * version: expandKeepListProposal always produces a LEDGER_PROPOSAL_VERSION
 * proposal for the unchanged Phase 2 validator.
 */
export const CLEANUP_WIRE_VERSION = 2;

const WIRE_KEYS = ['version', 'reviewId', 'keep', 'changed', 'pruningSuggestions', 'notes'];
const CHANGED_KEYS = ['s', 't', 'n'];
const SUGGESTION_KEYS = ['s', 'r'];

/**
 * Translate the model's compact keep-list response into the Phase 2 proposal
 * shape, so validateLedgerProposal judges it unchanged. The wire form:
 *
 *   { "version": 2, "reviewId": "…", "keep": [3, 4],
 *     "changed": [{ "s": [1, 2], "t": "merged text", "n": "optional note" }],
 *     "pruningSuggestions": [{ "s": [4], "r": "reason" }], "notes": "…" }
 *
 * Sources are integers matching the `[sN]` request labels. Each `keep` number
 * becomes an exact-original record (as originalLedgerProposal builds it), so a
 * mostly-unchanged ledger costs a few tokens per line instead of a record per
 * line. "keep" and "changed" are both required: coverage stays explicit — a
 * source missing from both still fails the validator's coverage check, never
 * an implicit keep. Only integers in range for THIS review translate; unknown,
 * non-integer, out-of-range or repeated numbers, unknown fields, and shapes
 * that cannot be translated fail closed — nothing is guessed or dropped. Text,
 * notes, reasons and the review id pass through for the validator to judge.
 * Records are ordered by their earliest source.
 */
export function expandKeepListProposal(review, wire) {
    const refuse = reason => ({ ok: false, reason });
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const shown = value => (typeof value === 'string' ? `"${value.slice(0, 40)}"` : typeof value === 'number' ? String(value) : 'a non-number value');
    const unknownKey = (value, keys) => Object.keys(value).find(key => !keys.includes(key));
    if (!isObject(wire)) return refuse('The proposal must be a JSON object.');
    const extra = unknownKey(wire, WIRE_KEYS);
    if (extra !== undefined) return refuse(`The proposal has an unknown field (${shown(extra)}); nothing is guessed.`);
    if (wire.version !== CLEANUP_WIRE_VERSION) return refuse(`Unsupported proposal format version (expected ${CLEANUP_WIRE_VERSION}).`);
    if (!Array.isArray(wire.keep) || !Array.isArray(wire.changed)) return refuse('"keep" and "changed" must both be arrays; coverage is never implicit.');
    if (Object.hasOwn(wire, 'pruningSuggestions') && !Array.isArray(wire.pruningSuggestions)) return refuse('"pruningSuggestions" must be an array.');

    const sourceOf = n => (Number.isInteger(n) && n >= 1 && n <= review.sources.length ? review.sources[n - 1] : null);
    const unknownNumber = n => refuse(`The proposal references an unknown source number (${shown(n)}); source numbers are never guessed.`);
    const listed = new Set();
    const placed = [];
    const own = n => {
        const source = sourceOf(n);
        if (!source) return unknownNumber(n);
        if (listed.has(n)) return refuse(`Source ${n} is listed more than once across "keep" and "changed"; each source must appear exactly once.`);
        listed.add(n);
        return { ok: true, source };
    };

    for (const n of wire.keep) {
        const owned = own(n);
        if (!owned.ok) return owned;
        const { source } = owned;
        placed.push({ order: source.order, record: { id: `original:${source.id}`, text: source.text.replace(/^\s*- /, ''), sourceIds: [source.id], notes: '' } });
    }
    for (const [index, entry] of wire.changed.entries()) {
        if (!isObject(entry)) return refuse('Every "changed" record must be an object.');
        const extraKey = unknownKey(entry, CHANGED_KEYS);
        if (extraKey !== undefined) return refuse(`A "changed" record has an unknown field (${shown(extraKey)}); nothing is guessed.`);
        if (!Array.isArray(entry.s) || !entry.s.length) return refuse('Every "changed" record needs a non-empty "s" array of source numbers.');
        const sources = [];
        for (const n of entry.s) {
            const owned = own(n);
            if (!owned.ok) return owned;
            sources.push(owned.source);
        }
        placed.push({
            order: Math.min(...sources.map(source => source.order)),
            record: { id: `r${index + 1}`, text: entry.t, sourceIds: sources.map(source => source.id), notes: Object.hasOwn(entry, 'n') ? entry.n : '' },
        });
    }
    const pruningSuggestions = [];
    for (const entry of wire.pruningSuggestions || []) {
        if (!isObject(entry)) return refuse('Every pruning suggestion must be an object.');
        const extraKey = unknownKey(entry, SUGGESTION_KEYS);
        if (extraKey !== undefined) return refuse(`A pruning suggestion has an unknown field (${shown(extraKey)}); nothing is guessed.`);
        if (!Array.isArray(entry.s) || !entry.s.length) return refuse('Every pruning suggestion needs a non-empty "s" array of source numbers.');
        const bad = entry.s.findIndex(n => !sourceOf(n));
        if (bad >= 0) return unknownNumber(entry.s[bad]);
        // Repeats inside one suggestion translate one-to-one; the validator refuses them.
        pruningSuggestions.push({ sourceIds: entry.s.map(n => sourceOf(n).id), reason: entry.r });
    }
    placed.sort((a, b) => a.order - b.order);
    return {
        ok: true,
        proposal: {
            version: LEDGER_PROPOSAL_VERSION,
            reviewId: wire.reviewId,
            records: placed.map(item => item.record),
            pruningSuggestions,
            notes: Object.hasOwn(wire, 'notes') ? wire.notes : '',
        },
    };
}

// ─── Payload construction (the minimization seam) ────────────────────────────

/**
 * Build the model request's user content. Deliberately minimal: the NPC name,
 * the review id the proposal must echo, and the ledger lines under their
 * short source ids. No dossier fields, no chat messages, no world state, no
 * recovery originals — the disclosure panel describes exactly this payload.
 */
export function buildLedgerCleanupUserContent(name, review) {
    return [
        `<entity>${name}</entity>`,
        `<review_id>${review.reviewId}</review_id>`,
        '<ledger_sources>',
        ...review.sources.map((source, index) => `[${shortSourceId(index)}] ${source.text}`),
        '</ledger_sources>',
        '',
        '='.repeat(60),
        `Condense ${name}'s Knowledge Ledger into the reviewed proposal JSON. Every source number above must appear exactly once, in "keep" or in one "changed" record. Output only JSON.`,
    ].join('\n');
}

// ─── Model disclosure + request budget ───────────────────────────────────────

/**
 * Resolved model/profile facts for the consent panel. `source` names which
 * config level won (module-profile / module-custom / global-profile /
 * global-custom). In profile modes the model NAME lives inside the profile,
 * so the panel shows the profile id instead of guessing one.
 */
export function cleanupModelDisclosure() {
    const module = getSettings();
    const resolved = resolveApiCall({ moduleSettings: module });
    const maxTokens = Number(resolved.settings?.maxTokens) || Number(module.maxTokens) || 0;
    return {
        mode: resolved.mode,
        source: resolved.source,
        connectionProfileId: resolved.settings?.connectionProfileId || module.connectionProfileId || '',
        modelName: resolved.settings?.modelName || module.modelName || '',
        // Both transports send settings.maxTokens as the response allowance.
        maxTokens,
    };
}

/**
 * The response sizes that bracket a keep-list proposal for this review, as
 * real compact wire JSON (the form the model answers in):
 *   - `keepAll` is the smallest complete answer — every source number in
 *     "keep", nothing changed. Every source must be listed, so this is the
 *     mandatory floor.
 *   - `rewriteAll` puts every source in its own "changed" record at its
 *     original wording: what the output costs if the model rewrites the whole
 *     ledger. It is a planning figure, not a ceiling — longer text or notes
 *     cost more, merges and kept lines cost less.
 * Real output lands between the two, depending on how much the model changes;
 * there is no fixed per-source record cost.
 *
 * Real strings, not a character count: a live tokenizer packs a run of one
 * repeated character far tighter than numbers and JSON punctuation, so
 * estimating a placeholder of the same length under-fires the known-excess
 * refusal.
 */
export function minimumProposalEnvelope(review) {
    const wire = (keep, changed) => JSON.stringify({ version: CLEANUP_WIRE_VERSION, reviewId: review.reviewId, keep, changed });
    return {
        keepAll: wire(review.sources.map((_source, index) => index + 1), []),
        rewriteAll: wire([], review.sources.map((source, index) => ({ s: [index + 1], t: source.text.replace(/^\s*- /, '') }))),
    };
}

/**
 * Estimate the full request/response envelope for the disclosure panel.
 * Token numbers are estimates under the shared chars/4.5 heuristic (or the
 * live tokenizer when available) — never presented as measurements. An
 * unreadable context limit stays `null` and is disclosed as unknown.
 */
export function estimateCleanupRequest({ review, userContent }) {
    const parsed = parseLedger(review.original);
    const disclosure = cleanupModelDisclosure();
    const envelope = minimumProposalEnvelope(review);
    const inputTokens = estimateTokens(LEDGER_CLEANUP_PROMPT) + estimateTokens(userContent);
    return {
        inputTokens,
        systemTokens: estimateTokens(LEDGER_CLEANUP_PROMPT),
        userTokens: estimateTokens(userContent),
        ledgerChars: parsed.ok ? parsed.body.length : 0,
        ledgerTokens: parsed.ok ? estimateTokens(parsed.body) : 0,
        entryChars: review.original.length,
        entryTokens: estimateTokens(review.original),
        sourceCount: review.sources.length,
        outputAllowance: disclosure.maxTokens,
        // Keep-all floor and full-rewrite planning figure; the real response
        // lands between them depending on how much the model changes.
        minimumOutputTokens: estimateTokens(envelope.keepAll),
        rewriteAllOutputTokens: estimateTokens(envelope.rewriteAll),
        // The active chat preset and Budget override describe chat generation,
        // not the independently resolved Knowledge endpoint. Neither transport
        // currently exposes a verified context capacity for that endpoint.
        contextLimit: { value: null, source: 'unknown', note: 'The resolved Knowledge endpoint context capacity is unknown.' },
        disclosure,
    };
}

/**
 * Known-excess refusals (fail closed, never clip). Two cases are genuinely
 * KNOWN: the input plus the keep-all response cannot fit a known context
 * limit, or the keep-all response alone cannot fit the output allowance.
 * Everything riskier (a proposal that rewrites much of the ledger not
 * fitting) is a disclosed warning instead — how big the response gets depends
 * on how much the model changes, so the request may still legitimately succeed.
 */
export function checkCleanupBudget(estimate) {
    if (!estimate) return { ok: false, code: 'bad-request', reason: 'No request estimate available.', suggestion: '' };
    const warnings = [];
    if (estimate.outputAllowance <= 0) {
        return {
            ok: false,
            code: 'output-envelope-exceeds-allowance',
            reason: 'No output allowance is configured for the Knowledge model.',
            suggestion: 'Set a Max Tokens value in Knowledge Tracker settings.',
        };
    }
    if (estimate.minimumOutputTokens > estimate.outputAllowance) {
        return {
            ok: false,
            code: 'output-envelope-exceeds-allowance',
            reason: `Even the smallest complete answer — keeping all ${estimate.sourceCount} lines verbatim, ~${estimate.minimumOutputTokens.toLocaleString()} tokens of source numbers and JSON structure — exceeds the ${estimate.outputAllowance.toLocaleString()}-token output allowance.`,
            suggestion: 'Raise Max Tokens in Knowledge Tracker settings, or condense after splitting the ledger manually.',
        };
    }
    const limit = estimate.contextLimit?.value;
    if (limit && Number.isFinite(limit) && limit > 0) {
        if (estimate.inputTokens + estimate.minimumOutputTokens > limit) {
            return {
                ok: false,
                code: 'input-exceeds-context',
                reason: `The request (~${estimate.inputTokens.toLocaleString()} tokens) plus the smallest complete answer (every line kept verbatim) does not fit the known context limit of ${limit.toLocaleString()} tokens (${estimate.contextLimit.source}).`,
                suggestion: 'Use a model/profile with a larger context limit, or split the ledger manually.',
            };
        }
        if (estimate.inputTokens + estimate.rewriteAllOutputTokens > limit) {
            warnings.push(`The request plus a proposal that rewrites much of the ledger may exceed the ${limit.toLocaleString()}-token context limit (${estimate.contextLimit.source}) — the model may refuse or truncate.`);
        }
    } else {
        warnings.push('The resolved Knowledge endpoint context capacity is unknown and not provider-verified; the active chat context limit and Budget override do not establish its capacity.');
    }
    if (estimate.rewriteAllOutputTokens > estimate.outputAllowance) {
        warnings.push(`Keeping every line verbatim needs ~${estimate.minimumOutputTokens.toLocaleString()} output tokens, within the ${estimate.outputAllowance.toLocaleString()}-token allowance, but output grows with every line the model merges or rewrites — rewriting all of them would need ~${estimate.rewriteAllOutputTokens.toLocaleString()}. If the model changes a large share of the ledger, expect a truncation refusal rather than a clipped result.`);
    }
    return { ok: true, warnings };
}

// ─── Preparation (identity-bound, no request yet) ────────────────────────────

/**
 * Capture the cleanup target and check ledger eligibility. Throws the Phase 3
 * capture refusals (missing/renamed/ambiguous destination) ready to surface;
 * an ineligible ledger is RETURNED (ok:false / empty:true) so the UI can
 * explain it without rewriting anything.
 */
export async function prepareLedgerCleanup({ name, uid }) {
    const capture = await captureCleanupTarget({ name, uid });
    return { capture, eligibility: parseLedger(capture.originalContent) };
}

// A throwaway id shaped like newReviewId()'s output (same length and mixed
// base36 characters, so a live tokenizer counts it like a real one) for the
// <review_id> line and its echo, without minting a real review.
const ESTIMATE_REVIEW_ID = 'lr-mgv0k3x9-q7f2m8zt';

/**
 * Estimate the request envelope + budget verdict for the disclosure panel,
 * BEFORE any request or consent. Uses a throwaway review shape (same id length
 * as a real one); the actual request always captures its own fresh review.
 * Returns null when the ledger is not eligible (nothing to estimate).
 */
export function estimateLedgerCleanup(capture) {
    const parsed = parseLedger(capture.originalContent);
    if (!parsed.ok || parsed.empty) return null;
    const probe = captureLedgerReview(capture.originalContent, ESTIMATE_REVIEW_ID);
    const userContent = buildLedgerCleanupUserContent(capture.name, probe);
    const estimate = estimateCleanupRequest({ review: probe, userContent });
    return { estimate, budget: checkCleanupBudget(estimate) };
}

// ─── The model request ───────────────────────────────────────────────────────

/**
 * Request one condensation proposal. Strict end to end: parseLedgerProposal
 * (no repair, no preamble stripping), then keep-list translation and
 * validateLedgerProposal — an invalid or incomplete proposal never reaches a
 * preview, and the returned proposal carries full review ids. Bounded to the
 * shared 2-attempt convention; cancellation is rethrown, never retried.
 */
export async function requestLedgerProposal({ capture, signal } = {}) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    // Fresh review id for EVERY request, regenerations included (Phase 2).
    const review = captureLedgerReview(capture.originalContent, newReviewId());
    const userContent = buildLedgerCleanupUserContent(capture.name, review);
    const budget = checkCleanupBudget(estimateCleanupRequest({ review, userContent }));
    if (!budget.ok) {
        const err = new Error(`${budget.reason} ${budget.suggestion}`.trim());
        err.code = budget.code;
        throw err;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal?.aborted || !scopeStillCurrent(capture.scopeToken).ok) {
            const err = new Error('The cleanup request was cancelled or its scope changed.');
            err.name = 'AbortError';
            throw err;
        }
        let raw;
        try {
            const content = attempt === 1
                ? userContent
                : userContent + '\n\n[REMINDER: Your previous response was not complete strict JSON. Output ONLY the proposal JSON object — no prose, no code fences.]';
            raw = await ktFetchFromApi(LEDGER_CLEANUP_PROMPT, content, { retries: 0, trigger: 'manual', signal });
        } catch (err) {
            // An aborted call is rethrown, never retried at a fresh epoch.
            if (isCancellation(err) || err?._noRetry || signal?.aborted || !scopeStillCurrent(capture.scopeToken).ok) throw err;
            lastError = err;
            console.warn(`[MWT:Knowledge] ledger cleanup request failed (attempt ${attempt}): ${err.message}`);
            if (attempt < 2) continue;
            throw new Error(`The model request failed after 2 attempts. Last error: ${lastError?.message || 'unknown'}`);
        }
        if (signal?.aborted || !scopeStillCurrent(capture.scopeToken).ok) {
            const err = new Error('The cleanup request was cancelled or its scope changed.');
            err.name = 'AbortError';
            throw err;
        }
        const parsed = parseLedgerProposal(raw);
        if (!parsed.ok) {
            lastError = new Error(parsed.reason);
            console.warn(`[MWT:Knowledge] ledger cleanup strict parse refused the output (attempt ${attempt}): ${parsed.reason}`);
            if (attempt < 2) continue;
            throw new Error(`${parsed.reason} No preview is shown for incomplete output.`);
        }
        // The keep-list wire form back to a full-id Phase 2 proposal first; an
        // untranslatable response is a validation failure like any other
        // (same retry, same refusal).
        const expanded = expandKeepListProposal(review, parsed.proposal);
        const validation = expanded.ok ? validateLedgerProposal(review, expanded.proposal) : expanded;
        if (!validation.ok) {
            lastError = new Error(validation.reason);
            console.warn(`[MWT:Knowledge] ledger cleanup proposal failed validation (attempt ${attempt}): ${validation.reason}`);
            if (attempt < 2) continue;
            throw new Error(`The proposal failed validation and was discarded: ${validation.reason}`);
        }
        return { review, proposal: expanded.proposal, warnings: validation.warnings };
    }
    /* c8 ignore next -- the loop always returns or throws */
    throw new Error(lastError?.message || 'The ledger cleanup request did not produce a proposal.');
}

// ─── Review drafts (in-memory, origin-bound, never prompt context) ──────────

const cleanupDrafts = new Map();
/** Export-only drafts replaced by a newer proposal, newest first per origin. */
const previousCleanupDrafts = new Map();
/** How many replaced drafts stay exportable per origin (the UI states it). */
export const PREVIOUS_DRAFT_LIMIT = 5;

/** Drafts are keyed by scope + book + name + uid: bound to their origin. */
function draftKey(capture) {
    return [capture.scopeKey, capture.bookName, capture.name, String(capture.uid)].join('|');
}

/** Persist the working draft on every decision/edit so it survives any close. */
export function saveCleanupDraft(capture, { review, proposal, decisions }) {
    cleanupDrafts.set(draftKey(capture), {
        savedAt: new Date().toISOString(),
        name: capture.name,
        uid: capture.uid,
        bookName: capture.bookName,
        review, proposal, decisions,
    });
}

/** The retained draft for this origin, or null. Still resumable only when the
 *  entry content is unchanged — the caller compares against a fresh capture. */
export function getCleanupDraft(capture) {
    return cleanupDrafts.get(draftKey(capture)) || null;
}

/**
 * Move the current draft to the export-only list before a new proposal
 * replaces it. A no-op without a current draft. Earlier replaced drafts are
 * kept too (up to PREVIOUS_DRAFT_LIMIT), so a second regeneration cannot
 * silently drop the edits saved in the first.
 */
export function stashPreviousCleanupDraft(capture) {
    const key = draftKey(capture);
    const current = cleanupDrafts.get(key);
    if (current) {
        const earlier = previousCleanupDrafts.get(key) || [];
        previousCleanupDrafts.set(key, [current, ...earlier].slice(0, PREVIOUS_DRAFT_LIMIT));
        cleanupDrafts.delete(key);
    }
    return current;
}

/** The newest replaced draft for this origin, or null. */
export function getPreviousCleanupDraft(capture) {
    return getPreviousCleanupDrafts(capture)[0] || null;
}

/** Every replaced draft still exportable for this origin, newest first. */
export function getPreviousCleanupDrafts(capture) {
    return previousCleanupDrafts.get(draftKey(capture)) || [];
}

/** A consumed draft (successful apply) no longer offers to resume; the
 *  recovery record owns the history from here. */
export function clearCleanupDraft(capture) {
    cleanupDrafts.delete(draftKey(capture));
    previousCleanupDrafts.delete(draftKey(capture));
}

/** Test seam: drop every retained draft (the store is module-level state). */
export function _resetCleanupDraftsForTests() {
    cleanupDrafts.clear();
    previousCleanupDrafts.clear();
}

export const CLEANUP_DRAFT_EXPORT_TYPE = 'mwt-cleanup-review-draft';

/** Labeled, versioned export payload for downloadJson. */
export function exportCleanupDraftPayload(entry) {
    if (!entry || !entry.review) throw new Error('No cleanup draft to export.');
    return {
        type: CLEANUP_DRAFT_EXPORT_TYPE,
        version: 1,
        exportedAt: new Date().toISOString(),
        name: entry.name,
        uid: entry.uid,
        bookName: entry.bookName,
        review: entry.review,
        proposal: entry.proposal,
        decisions: entry.decisions,
    };
}

// ─── Apply / restore (Phase 3 commit service wiring) ─────────────────────────

/**
 * Apply the final user-edited draft under the full Phase 3 guard chain. The
 * validate hook requires the freshly-read original to be the captured
 * revision AND the replacement to be byte-identical to the ledger-only patch
 * recomputed from the exact (possibly user-edited) proposal + decisions.
 */
const reviewApplyAttempts = new WeakMap();

export async function applyReviewedLedgerCleanup({ capture, review, proposal, decisions }) {
    const patch = patchLedgerProposal(review, proposal, decisions);
    if (!patch.ok) return { ok: false, code: 'validation-failed', error: patch.reason };
    // A retry of the same approved bytes must reconcile the original action,
    // while an edited replacement is a distinct attempt. Retained drafts keep
    // the review object alive across modal close/reopen.
    let attempts = reviewApplyAttempts.get(review);
    if (!attempts) { attempts = new Map(); reviewApplyAttempts.set(review, attempts); }
    let actionId = attempts.get(patch.replacement);
    if (!actionId) {
        actionId = `ledger-condensation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        attempts.set(patch.replacement, actionId);
    }
    let result = await applyCleanup({
        capture,
        replacement: patch.replacement,
        actionId,
        validate: (input) => validateLedgerReplacement(review, proposal, decisions, input),
    });
    if (result?.code === 'duplicate') {
        const record = await getCleanupRecord(actionId, capture.bookName);
        if (record?.status === 'applied' && record.approvedReplacement === patch.replacement) {
            result = { ok: true, actionId, uid: capture.uid, reconciled: true };
        } else {
            // Not confirmed applied: carry the stored status so the UI never
            // claims a write that did not happen.
            result = { ...result, status: record?.status ?? result.status ?? null };
        }
    }
    return result?.ok === true ? { ...result, replacement: patch.replacement, warnings: patch.warnings } : result;
}

/** Reconcile persisted attempts after reload without generating or writing a new draft. */
export async function reconcileReviewedLedgerCleanup(actionId) {
    const scope = captureScope();
    const bookName = getLorebookName();
    const record = await getCleanupRecord(actionId, bookName);
    if (!scopeStillCurrent(scope).ok || getLorebookName() !== bookName || record?.scopeKey !== currentCleanupScopeKey()) {
        return { status: 'scope-changed', detail: 'Switch back to the originating chat to reconcile this record.' };
    }
    return reconcileCleanupOutcome(actionId, { bookName });
}

/** Restore a ledger-condensation recovery record (span-aware via ledgerSpan). */
export function restoreReviewedLedgerCleanup(actionId) {
    return restoreCleanup({ actionId, spanOf: ledgerSpan });
}
