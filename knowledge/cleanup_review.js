/**
 * Phase 4: orchestration for the reviewed single-NPC ledger condensation
 * (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md §Phase 4).
 *
 * This module owns everything between the UI and the Phase 2/3 seams:
 *   - eligibility + identity-bound capture (captureCleanupTarget + parseLedger),
 *   - the request budget (input/response envelope estimates, known-excess
 *     refusals, honest "unknown" capacity disclosure — never clipping),
 *   - the model request itself (ledger + NPC name ONLY in the payload, manual
 *     trigger, cancellable via signal, strict parseLedgerProposal — never the
 *     lenient repair path — and validateLedgerProposal before any preview),
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

// ─── Payload construction (the minimization seam) ────────────────────────────

/**
 * Build the model request's user content. Deliberately minimal: the NPC name,
 * the review id the proposal must echo, and the numbered ledger lines. No
 * dossier fields, no chat messages, no world state, no recovery originals —
 * the disclosure panel describes exactly this payload.
 */
export function buildLedgerCleanupUserContent(name, review) {
    return [
        `<entity>${name}</entity>`,
        `<review_id>${review.reviewId}</review_id>`,
        '<ledger_sources>',
        ...review.sources.map(source => `[${source.id}] ${source.text}`),
        '</ledger_sources>',
        '',
        '='.repeat(60),
        `Condense ${name}'s Knowledge Ledger into the reviewed proposal JSON. Every source id above must be mapped. Output only JSON.`,
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

/** Fixed JSON scaffolding every valid proposal carries regardless of content. */
const ENVELOPE_STATIC = '{"version":1,"reviewId":"","records":[],"pruningSuggestions":[],"notes":""}';
const RECORD_STATIC = '{"id":"r1","text":"x","sourceIds":[],"notes":""}';

/**
 * Lower bound on the response a VALID complete proposal needs for this review.
 * Every source id must appear in exactly one record's sourceIds and every
 * record needs non-empty single-line text; only the mapping itself is
 * mandatory, so record text is floored at one character. `oneRecord` is the
 * mathematical floor (a single record owning everything is schema-valid);
 * `perSource` (each source in its own minimal record) is the realistic
 * planning floor for a model that actually condenses.
 */
export function minimumProposalEnvelope(review) {
    const idChars = review.sources.reduce((sum, source) => sum + source.id.length + 3, 0);
    const staticChars = ENVELOPE_STATIC.length + RECORD_STATIC.length;
    return {
        oneRecordChars: staticChars + idChars + review.reviewId.length,
        perSourceChars: staticChars + idChars + review.reviewId.length + (RECORD_STATIC.length + 2) * Math.max(0, review.sources.length - 1),
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
        minimumOutputTokens: estimateTokens('x'.repeat(envelope.oneRecordChars)),
        planningOutputTokens: estimateTokens('x'.repeat(envelope.perSourceChars)),
        // The active chat preset and Budget override describe chat generation,
        // not the independently resolved Knowledge endpoint. Neither transport
        // currently exposes a verified context capacity for that endpoint.
        contextLimit: { value: null, source: 'unknown', note: 'The resolved Knowledge endpoint context capacity is unknown.' },
        disclosure,
    };
}

/**
 * Known-excess refusals (fail closed, never clip). Two cases are genuinely
 * KNOWN: the input plus the mathematically minimal response cannot fit a known
 * context limit, or the minimal response envelope alone cannot fit the output
 * allowance. Everything riskier (a realistic condensation not fitting) is a
 * disclosed warning instead — the request may still legitimately succeed.
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
            reason: `Even the bare mapping of all ${estimate.sourceCount} sources (ids + JSON structure, before any condensed text) exceeds the ${estimate.outputAllowance.toLocaleString()}-token output allowance.`,
            suggestion: 'Raise Max Tokens in Knowledge Tracker settings, or condense after splitting the ledger manually.',
        };
    }
    const limit = estimate.contextLimit?.value;
    if (limit && Number.isFinite(limit) && limit > 0) {
        if (estimate.inputTokens + estimate.minimumOutputTokens > limit) {
            return {
                ok: false,
                code: 'input-exceeds-context',
                reason: `The request (~${estimate.inputTokens.toLocaleString()} tokens) plus the minimal mapped response does not fit the known context limit of ${limit.toLocaleString()} tokens (${estimate.contextLimit.source}).`,
                suggestion: 'Use a model/profile with a larger context limit, or split the ledger manually.',
            };
        }
        if (estimate.inputTokens + estimate.planningOutputTokens > limit) {
            warnings.push(`The request plus a realistic proposal may exceed the ${limit.toLocaleString()}-token context limit (${estimate.contextLimit.source}) — the model may refuse or truncate.`);
        }
    } else {
        warnings.push('The resolved Knowledge endpoint context capacity is unknown and not provider-verified; the active chat context limit and Budget override do not establish its capacity.');
    }
    if (estimate.ledgerTokens > estimate.outputAllowance) {
        warnings.push(`The ledger (~${estimate.ledgerTokens.toLocaleString()} tokens) is larger than the ${estimate.outputAllowance.toLocaleString()}-token output allowance. A complete mapped proposal may not fit — expect a truncation refusal rather than a clipped result.`);
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

// A throwaway id shaped like newReviewId()'s output (same length class) so the
// source-id character accounting in the envelope estimate matches the real
// request without minting a real review.
const ESTIMATE_REVIEW_ID = 'lr-0000000000000-00000000';

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
 * (no repair, no preamble stripping), then validateLedgerProposal — an
 * invalid or incomplete proposal never reaches a preview. Bounded to the
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
        const validation = validateLedgerProposal(review, parsed.proposal);
        if (!validation.ok) {
            lastError = new Error(validation.reason);
            console.warn(`[MWT:Knowledge] ledger cleanup proposal failed validation (attempt ${attempt}): ${validation.reason}`);
            if (attempt < 2) continue;
            throw new Error(`The proposal failed validation and was discarded: ${validation.reason}`);
        }
        return { review, proposal: parsed.proposal, warnings: validation.warnings };
    }
    /* c8 ignore next -- the loop always returns or throws */
    throw new Error(lastError?.message || 'The ledger cleanup request did not produce a proposal.');
}

// ─── Review drafts (in-memory, origin-bound, never prompt context) ──────────

const cleanupDrafts = new Map();
const previousCleanupDrafts = new Map();

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

/** Move the current draft to the export-only slot (before a regeneration). */
export function stashPreviousCleanupDraft(capture) {
    const key = draftKey(capture);
    const current = cleanupDrafts.get(key);
    if (current) {
        previousCleanupDrafts.set(key, current);
        cleanupDrafts.delete(key);
    }
    return current;
}

export function getPreviousCleanupDraft(capture) {
    return previousCleanupDrafts.get(draftKey(capture)) || null;
}

/** A consumed draft (successful apply) no longer offers to resume; the
 *  recovery record owns the history from here. */
export function clearCleanupDraft(capture) {
    cleanupDrafts.delete(draftKey(capture));
    previousCleanupDrafts.delete(draftKey(capture));
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
