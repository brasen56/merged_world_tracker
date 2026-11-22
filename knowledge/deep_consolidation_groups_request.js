/** Manual grouping request only. No batch calls, drafts, recovery or writes. */
import { estimateTokens } from '../core/context.js';
import { record, getApiCalls } from '../core/diagnostics.js';
import { scopeStillCurrent } from '../core/scope.js';
import { cleanupModelDisclosure, checkCleanupBudget } from './cleanup_review.js';
import { hasValidSettings } from './settings.js';
import { ktFetchFromApi } from './lorebook.js';
import { parseLedgerProposal } from './ledger_cleanup.js';
import { prepareDeepConsolidation } from './deep_consolidation_capture.js';
import { buildDeepGroupingPrompt, buildDeepGroupingUserContent, deepGroupingSources, normalizeDeepGroups } from './deep_consolidation_groups.js';

export function estimateDeepGroupingRequest({ name, selection }) {
    const systemPrompt = buildDeepGroupingPrompt(selection.review.reviewId);
    const userContent = buildDeepGroupingUserContent(name, selection);
    const disclosure = cleanupModelDisclosure();
    const numbers = deepGroupingSources(selection).map(source => source.order + 1);
    const minimum = { version: 1, reviewId: selection.review.reviewId, groups: [{ label: 'Subject', s: numbers }] };
    const separate = { ...minimum, groups: numbers.map(n => ({ label: `Subject ${n}`, s: [n] })) };
    const estimate = { inputTokens: estimateTokens(systemPrompt) + estimateTokens(userContent),
        systemTokens: estimateTokens(systemPrompt), userTokens: estimateTokens(userContent),
        sourceCount: numbers.length, outputAllowance: disclosure.maxTokens,
        minimumOutputTokens: estimateTokens(JSON.stringify(minimum)),
        rewriteAllOutputTokens: estimateTokens(JSON.stringify(separate)),
        contextLimit: { value: null, source: 'unknown' }, disclosure };
    const budget = checkCleanupBudget(estimate);
    // The shared checker describes Condense ownership; keep its verdict while
    // presenting grouping-specific wording to avoid promising a rewrite.
    if (!budget.ok) {
        budget.reason = budget.code === 'output-envelope-exceeds-allowance'
            ? `The grouping response allowance (${estimate.outputAllowance} tokens) cannot cover the minimum complete grouping (~${estimate.minimumOutputTokens} tokens, ${numbers.length} sources).`
            : budget.reason;
        budget.suggestion = 'Raise the Knowledge Max Tokens setting, reduce the boundary, or use Group by position (no model call).';
    } else {
        budget.warnings = budget.warnings.filter(warning => !warning.includes('Keeping every line verbatim'));
        if (estimate.rewriteAllOutputTokens > estimate.outputAllowance) {
            budget.warnings.push('A response with many separate groups may exceed the allowance even though one complete group fits.');
        }
    }
    return { systemPrompt, userContent, estimate, budget };
}

function assertCurrent(capture, signal) {
    if (signal?.aborted || !scopeStillCurrent(capture.scopeToken).ok) {
        const error = new Error('The grouping request was cancelled or its scope changed.');
        error.name = 'AbortError';
        throw error;
    }
}

export async function requestDeepConsolidationGroups({ name, uid, throughSource, pins = [], signal, expectedCapture } = {}) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    if (expectedCapture) assertCurrent(expectedCapture, signal);
    const prepared = await prepareDeepConsolidation({ name, uid, throughSource, pins });
    const { capture, selection, eligibility } = prepared;
    assertCurrent(capture, signal);
    if (expectedCapture) {
        assertCurrent(expectedCapture, signal);
        if (['name', 'uid', 'bookName', 'entityId', 'originalContent'].some(key => capture[key] !== expectedCapture[key])) {
            throw new Error('The Knowledge entry or destination changed. Close and reopen the preview to review the current sources before sending.');
        }
    }
    if (!selection) throw new Error(eligibility.reason || 'No eligible ledger to group.');
    const request = estimateDeepGroupingRequest({ name: capture.name, selection });
    if (!request.estimate.sourceCount) throw new Error('All selected sources are pinned; there is nothing to send for grouping.');
    if (!request.budget.ok) throw new Error(`${request.budget.reason} ${request.budget.suggestion}`);
    const requestDiagnostics = { operation: 'deep-consolidation-groups', reviewId: selection.review.reviewId,
        sourceCount: request.estimate.sourceCount, outputAllowance: request.estimate.outputAllowance };
    const raw = await ktFetchFromApi(request.systemPrompt, request.userContent,
        { retries: 0, trigger: 'manual', signal, requestDiagnostics });
    assertCurrent(capture, signal);
    const apiCall = getApiCalls().find(call => call.requestDiagnostics?.reviewId === selection.review.reviewId);
    const responseFacts = { responseChars: typeof raw === 'string' ? raw.length : 0,
        finishReason: apiCall?.finish_reason ?? null, completionTokens: apiCall?.usage?.completion_tokens ?? null };
    const parsed = parseLedgerProposal(raw);
    const normalized = parsed.ok ? normalizeDeepGroups(selection, parsed.proposal) : parsed;
    if (!normalized.ok) {
        const detail = { ...requestDiagnostics, ...responseFacts, stage: parsed.ok ? 'identity' : 'parse', reason: normalized.reason };
        record({ module: 'knowledge', level: 'warn', event: 'deep_consolidation_groups_rejected', detail });
        const error = new Error(`No groups. ${normalized.reason} No automatic retry was made. Nothing was changed. Try Group by position without a model call.`);
        Object.defineProperty(error, 'deepConsolidationFailure', { value: {
            ...detail, connection: request.estimate.disclosure, rawResponse: raw, error: parsed.error,
        } });
        throw error;
    }
    record({ module: 'knowledge', level: 'info', event: 'deep_consolidation_groups_ready',
        detail: { ...requestDiagnostics, ...responseFacts, normalization: normalized.normalization, groupCount: normalized.groups.length } });
    return { ...prepared, ...normalized, requestFacts: { ...request, ...responseFacts, attempt: 1 } };
}