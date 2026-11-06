/** Experimental §3C request seam. No drafts, staging, recovery or writes. */
import { isCancellation } from '../core/index.js';
import { estimateTokens } from '../core/context.js';
import { scopeStillCurrent } from '../core/scope.js';
import { cleanupModelDisclosure, checkCleanupBudget } from './cleanup_review.js';
import { hasValidSettings } from './settings.js';
import { ktFetchFromApi } from './lorebook.js';
import { parseLedgerProposal } from './ledger_cleanup.js';
import { prepareDeepConsolidation } from './deep_consolidation_capture.js';
import { buildDeepConsolidationUserContent, expandDeepConsolidationProposal } from './deep_consolidation.js';
import { DEEP_CONSOLIDATION_PROMPT, DEEP_CONSOLIDATION_GRAMMAR } from './deep_consolidation_prompt.js';
import { inspectDeepConsolidation } from './deep_consolidation_checks.js';

function requestContent(name, selection, activeBudget) {
    if (!Number.isInteger(activeBudget) || activeBudget < 1) throw new Error('Active budget must be a positive integer token goal.');
    return buildDeepConsolidationUserContent(name, selection) +
        `\n<active_budget>${activeBudget} estimated active-ledger tokens, including pins and unseen recent lines. Goal only, never permission to truncate.</active_budget>`;
}

/** Reuse the public budget verdict, but count the experimental prompt and v3
 * wire, not the v2 envelope. Recent sources never enter the request estimate.
 * Keep-all is the cheapest legal disposition (other states require groups).
 */
export function estimateDeepConsolidationRequest({ name, selection, activeBudget = 4000 }) {
    const userContent = requestContent(name, selection, activeBudget);
    const disclosure = cleanupModelDisclosure();
    const numbers = selection.eligibleSources.map(source => source.order + 1);
    const rewritable = selection.eligibleSources.filter(source => !selection.pinnedSourceIds.includes(source.id));
    const base = { version: 3, reviewId: selection.review.reviewId, keep: numbers, changed: [], archive: [], groups: [] };
    const rewrite = { ...base, keep: numbers.filter(n => selection.pinnedSourceIds.includes(selection.eligibleSources[n - 1].id)),
        changed: rewritable.map(source => ({ s: [source.order + 1], t: source.text.replace(/^\s*- /, '') })),
        groups: rewritable.map(source => ({ s: [source.order + 1], label: `Subject ${source.order + 1}` })),
    };
    const estimate = {
        inputTokens: estimateTokens(DEEP_CONSOLIDATION_PROMPT) + estimateTokens(userContent),
        systemTokens: estimateTokens(DEEP_CONSOLIDATION_PROMPT), userTokens: estimateTokens(userContent),
        sourceCount: numbers.length, outputAllowance: disclosure.maxTokens,
        minimumOutputTokens: estimateTokens(JSON.stringify(base)),
        rewriteAllOutputTokens: estimateTokens(JSON.stringify(rewrite)),
        contextLimit: { value: null, source: 'unknown', note: 'The resolved Knowledge endpoint context capacity is unknown.' },
        disclosure,
    };
    return { userContent, estimate, budget: checkCleanupBudget(estimate) };
}

function assertCurrent(capture, signal) {
    if (signal?.aborted || !scopeStillCurrent(capture.scopeToken).ok) {
        const error = new Error('The deep consolidation request was cancelled or its scope changed.');
        error.name = 'AbortError';
        throw error;
    }
}

/** Explicit manual invocation only. Capture again on EVERY generation. A
 * bounded retry is also a new request with a new identity-bound capture/id;
 * cancellation and scope changes are never retried. Nothing is persisted.
 */
export async function requestDeepConsolidation({ name, uid, throughSource, pins = [], activeBudget = 4000, signal, expectedCapture } = {}) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    let origin;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (origin) assertCurrent(origin, signal);
        const prepared = await prepareDeepConsolidation({ name, uid, throughSource, pins });
        const { capture, eligibility, selection } = prepared;
        if (origin) assertCurrent(origin, signal);
        origin ??= capture;
        assertCurrent(capture, signal);
        // Source numbers and consent refer to a specific snapshot/destination.
        // Never silently send replacement content after a scan or book switch.
        const expected = expectedCapture ?? origin;
        if (expectedCapture) assertCurrent(expectedCapture, signal);
        if (['name', 'uid', 'bookName', 'entityId', 'originalContent'].some(key => capture[key] !== expected[key])) {
            throw new Error('The Knowledge entry or destination changed. Close and reopen the preview to review the current sources before sending.');
        }
        if (!selection) throw new Error(eligibility.reason || 'No eligible ledger to consolidate.');
        const request = estimateDeepConsolidationRequest({ name: capture.name, selection, activeBudget });
        if (!request.budget.ok) {
            const error = new Error(`${request.budget.reason} ${request.budget.suggestion}`.trim());
            error.code = request.budget.code;
            throw error;
        }
        try {
            const raw = await ktFetchFromApi(DEEP_CONSOLIDATION_PROMPT, request.userContent, { retries: 0, trigger: 'manual', signal });
            assertCurrent(capture, signal);
            const parsed = parseLedgerProposal(raw);
            const expanded = parsed.ok ? expandDeepConsolidationProposal(selection, parsed.proposal) : parsed;
            if (!expanded.ok) throw new Error(`The experimental proposal was discarded: ${expanded.reason}`);
            const inspection = inspectDeepConsolidation(selection, expanded.proposal, { activeBudget });
            return { ...prepared, proposal: expanded.proposal, ...inspection,
                requestFacts: { prompt: DEEP_CONSOLIDATION_PROMPT, grammar: DEEP_CONSOLIDATION_GRAMMAR,
                    userContent: request.userContent, estimate: request.estimate, budget: request.budget, attempt,
                    archivePersistence: 'none; read-only in-memory preview' } };
        } catch (error) {
            if (isCancellation(error) || error?._noRetry || signal?.aborted) throw error;
            assertCurrent(capture, signal);
            lastError = error;
        }
    }
    throw new Error(`No preview: deep consolidation failed after 2 attempts. ${lastError?.message || 'No complete proposal.'}`);
}