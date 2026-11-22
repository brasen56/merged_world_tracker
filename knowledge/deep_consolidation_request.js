/** Experimental §3C request seam. No drafts, staging, recovery or writes. */
import { estimateTokens } from '../core/context.js';
import { record, getApiCalls } from '../core/diagnostics.js';
import { scopeStillCurrent } from '../core/scope.js';
import { cleanupModelDisclosure, checkCleanupBudget } from './cleanup_review.js';
import { hasValidSettings } from './settings.js';
import { ktFetchFromApi } from './lorebook.js';
import { parseLedgerProposal } from './ledger_cleanup.js';
import { prepareDeepConsolidation } from './deep_consolidation_capture.js';
import { buildDeepConsolidationUserContent, expandDeepConsolidationProposal, DEEP_CONSOLIDATION_WIRE_VERSION } from './deep_consolidation.js';
import { buildDeepConsolidationPrompt, DEEP_CONSOLIDATION_GRAMMAR } from './deep_consolidation_prompt.js';
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
    const systemPrompt = buildDeepConsolidationPrompt(selection.review.reviewId);
    const disclosure = cleanupModelDisclosure();
    const numbers = selection.eligibleSources.map(source => source.order + 1);
    const rewritable = selection.eligibleSources.filter(source => !selection.pinnedSourceIds.includes(source.id));
    const base = { version: DEEP_CONSOLIDATION_WIRE_VERSION, reviewId: selection.review.reviewId, keep: numbers, changed: [], archive: [], groups: [] };
    const rewrite = { ...base, keep: numbers.filter(n => selection.pinnedSourceIds.includes(selection.eligibleSources[n - 1].id)),
        changed: rewritable.map(source => ({ s: [source.order + 1], t: source.text.replace(/^\s*- /, '') })),
        groups: rewritable.map(source => ({ s: [source.order + 1], label: `Subject ${source.order + 1}` })),
    };
    const estimate = {
        inputTokens: estimateTokens(systemPrompt) + estimateTokens(userContent),
        systemTokens: estimateTokens(systemPrompt), userTokens: estimateTokens(userContent),
        sourceCount: numbers.length, outputAllowance: disclosure.maxTokens,
        minimumOutputTokens: estimateTokens(JSON.stringify(base)),
        rewriteAllOutputTokens: estimateTokens(JSON.stringify(rewrite)),
        contextLimit: { value: null, source: 'unknown', note: 'The resolved Knowledge endpoint context capacity is unknown.' },
        disclosure,
    };
    return { systemPrompt, userContent, estimate, budget: checkCleanupBudget(estimate) };
}

function assertCurrent(capture, signal) {
    if (signal?.aborted || !scopeStillCurrent(capture.scopeToken).ok) {
        const error = new Error('The deep consolidation request was cancelled or its scope changed.');
        error.name = 'AbortError';
        throw error;
    }
}

/** Explicit manual invocation only. Capture again on EVERY generation.
 * One paid attempt, with no transport or proposal retry. Nothing is persisted.
 */
export async function requestDeepConsolidation({ name, uid, throughSource, pins = [], activeBudget = 4000, signal, expectedCapture } = {}) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    if (expectedCapture) assertCurrent(expectedCapture, signal);
    const prepared = await prepareDeepConsolidation({ name, uid, throughSource, pins });
    const { capture, eligibility, selection } = prepared;
    assertCurrent(capture, signal);
    // Source numbers and consent refer to a specific snapshot/destination.
    // Never silently send replacement content after a scan or book switch.
    if (expectedCapture) {
        assertCurrent(expectedCapture, signal);
        if (['name', 'uid', 'bookName', 'entityId', 'originalContent'].some(key => capture[key] !== expectedCapture[key])) {
            throw new Error('The Knowledge entry or destination changed. Close and reopen the preview to review the current sources before sending.');
        }
    }
    if (!selection) throw new Error(eligibility.reason || 'No eligible ledger to consolidate.');
    const request = estimateDeepConsolidationRequest({ name: capture.name, selection, activeBudget });
    if (!request.budget.ok) {
        const error = new Error(`${request.budget.reason} ${request.budget.suggestion}`.trim());
        error.code = request.budget.code;
        throw error;
    }
    const requestDiagnostics = { operation: 'deep-consolidation', reviewId: selection.review.reviewId,
        sourceCount: request.estimate.sourceCount, outputAllowance: request.estimate.outputAllowance };
    const raw = await ktFetchFromApi(request.systemPrompt, request.userContent, { retries: 0, trigger: 'manual', signal, requestDiagnostics });
    assertCurrent(capture, signal);
    // Match the request identity, since another module can finish a call while
    // this one is in flight. Connection profiles may omit this metadata.
    const apiCall = getApiCalls().find(call => call.requestDiagnostics?.reviewId === selection.review.reviewId);
    const responseFacts = { responseChars: typeof raw === 'string' ? raw.length : 0,
        finishReason: apiCall?.finish_reason ?? null, completionTokens: apiCall?.usage?.completion_tokens ?? null };
    function rejected(stage, reason, hint = '', parsed = {}) {
        const detail = { ...requestDiagnostics, ...responseFacts, ...parsed.diagnostics, stage, reason };
        record({ module: 'knowledge', level: 'warn', event: 'deep_consolidation_rejected',
            detail });
        const error = new Error(['No preview.', reason, hint, 'See Diagnostics → Log for this rejection.',
            'No automatic retry was made. Nothing was changed.'].filter(Boolean).join(' '));
        // Only the current modal owns this private response. It never enters
        // the diagnostics ring or persistence and is downloaded on demand.
        Object.defineProperty(error, 'deepConsolidationFailure', { value: {
            ...detail, connection: request.estimate.disclosure, rawResponse: raw, error: parsed.error,
        } });
        return error;
    }
    const parsed = parseLedgerProposal(raw);
    if (!parsed.ok) {
        throw rejected('parse', parsed.reason, `The response may be malformed or truncated. The configured response allowance is ${request.estimate.outputAllowance} tokens. Check the reported finish reason and completion token count in Diagnostics → Last request. Download the failed response below to inspect the returned text.`, parsed);
    }
    const expanded = expandDeepConsolidationProposal(selection, parsed.proposal);
    if (!expanded.ok) {
        const sample = expanded.unexpectedFields?.length ? `Unexpected field names include ${expanded.unexpectedFields.map(key => JSON.stringify(key)).join(', ')}.` : '';
        throw rejected('validation', expanded.reason, sample);
    }
    const inspection = inspectDeepConsolidation(selection, expanded.proposal, { activeBudget });
    return { ...prepared, proposal: expanded.proposal, ...inspection,
        requestFacts: { prompt: request.systemPrompt, grammar: DEEP_CONSOLIDATION_GRAMMAR,
            userContent: request.userContent, estimate: request.estimate, budget: request.budget, attempt: 1,
            archivePersistence: 'none; read-only in-memory preview' } };
}
