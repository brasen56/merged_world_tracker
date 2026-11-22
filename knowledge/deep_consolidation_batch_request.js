/** Manual sequential runner. No entry writes, automatic retries or persistence. */
import { estimateTokens } from '../core/context.js';
import { record, getApiCalls } from '../core/diagnostics.js';
import { scopeStillCurrent } from '../core/scope.js';
import { captureCleanupTarget } from './cleanup_commit.js';
import { newReviewId, buildLedgerCleanupUserContent, minimumProposalEnvelope, cleanupModelDisclosure,
    checkCleanupBudget, expandKeepListProposal } from './cleanup_review.js';
import { hasValidSettings } from './settings.js';
import { ktFetchFromApi } from './lorebook.js';
import { parseLedgerProposal, validateLedgerProposal } from './ledger_cleanup.js';
import { captureBatchReview, mapBatchProposal, deepDraftMatches } from './deep_consolidation_batches.js';
import { buildDeepBatchPrompt } from './deep_consolidation_batch_prompt.js';

function assertCurrent(capture, signal) {
    if (signal?.aborted || !scopeStillCurrent(capture.scopeToken).ok) {
        const error = new Error('Batch request cancelled or its scope changed. Accepted batches were retained.');
        error.name = 'AbortError';
        throw error;
    }
}

export function estimateDeepBatchRequest(name, batch, review = captureBatchReview(batch, 'deep-batch-estimate')) {
    const systemPrompt = buildDeepBatchPrompt(review.reviewId);
    const userContent = `<subject>${batch.label}</subject>\n` + buildLedgerCleanupUserContent(name, review);
    const disclosure = cleanupModelDisclosure();
    const envelope = minimumProposalEnvelope(review);
    const estimate = { inputTokens: estimateTokens(systemPrompt) + estimateTokens(userContent),
        sourceCount: review.sources.length, outputAllowance: disclosure.maxTokens,
        minimumOutputTokens: estimateTokens(envelope.keepAll), rewriteAllOutputTokens: estimateTokens(envelope.rewriteAll),
        contextLimit: { value: null, source: 'unknown' }, disclosure };
    return { systemPrompt, userContent, estimate, budget: checkCleanupBudget(estimate) };
}

async function requestBatch(draft, batch, capture, signal) {
    const review = captureBatchReview(batch, `deep-batch-${newReviewId()}`);
    batch.reviewId = review.reviewId;
    const diagnostics = { operation: 'deep-consolidation-batch', reviewId: review.reviewId,
        batchId: batch.id, sourceCount: batch.s.length, attempt: batch.attempts };
    let raw = null;
    let stage = 'budget';
    let parserError;
    let responseFacts = { finishReason: null, completionTokens: null };
    try {
        assertCurrent(capture, signal);
        if (!hasValidSettings()) throw new Error('No API connection configured.');
        const request = estimateDeepBatchRequest(capture.name, batch, review);
        if (!request.budget.ok) throw new Error(`${request.budget.reason} ${request.budget.suggestion}`);
        stage = 'request';
        raw = await ktFetchFromApi(request.systemPrompt, request.userContent,
            { retries: 0, trigger: 'manual', signal, requestDiagnostics: diagnostics });
        assertCurrent(capture, signal);
        const call = getApiCalls().find(item => item.requestDiagnostics?.reviewId === review.reviewId);
        responseFacts = { finishReason: call?.finish_reason ?? null, completionTokens: call?.usage?.completion_tokens ?? null };
        stage = 'parse';
        const parsed = parseLedgerProposal(raw);
        parserError = parsed.error;
        if (!parsed.ok) throw new Error(parsed.reason);
        stage = 'validation';
        const expanded = expandKeepListProposal(review, parsed.proposal);
        if (!expanded.ok) throw new Error(expanded.reason);
        const check = validateLedgerProposal(review, expanded.proposal);
        if (!check.ok) throw new Error(check.reason);
        batch.result = mapBatchProposal(batch, review, expanded.proposal);
        batch.warnings = check.warnings;
        batch.status = 'accepted';
        batch.failure = null;
        batch.reason = '';
        batch.responseFacts = responseFacts;
        record({ module: 'knowledge', level: 'info', event: 'deep_consolidation_batch_ready',
            detail: { ...diagnostics, ...responseFacts, recordCount: batch.result.records.length } });
    } catch (error) {
        // Even transports which ignore AbortSignal must not accept late data.
        assertCurrent(capture, signal);
        if (error.name === 'AbortError') throw error;
        batch.status = 'failed';
        batch.reason = error.message;
        batch.failure = { stage, reason: error.message, rawResponse: raw, error: parserError,
            reviewId: review.reviewId, ...responseFacts };
        batch.responseFacts = responseFacts;
        // Validator and native transport errors may quote private text. Log
        // only identity, counts, outcome and response metadata, never reason/raw.
        record({ module: 'knowledge', level: 'warn', event: 'deep_consolidation_batch_rejected',
            detail: { ...diagnostics, ...responseFacts, stage, responseChars: typeof raw === 'string' ? raw.length : 0 } });
    }
}

/** mode=pending never retries. mode=failed retries only the failures present at
 * invocation, optionally one batchId. An abort returns in-flight work to pending
 * (or failed for a retry), retaining all already accepted batches.
 */
export async function runDeepConsolidationBatches(draft, { signal, mode = 'pending', batchId, onProgress = () => {} } = {}) {
    if (draft.running) throw new Error('This deep draft is already running.');
    if (!['pending', 'failed'].includes(mode)) throw new Error('Choose pending batches or explicit failed-batch retry.');
    draft.running = true;
    let active;
    let previousStatus;
    try {
        // Refresh scope tokens on reopen, while requiring the same revision and
        // destination. Append-safe freshness belongs to Phase 4, not this runner.
        const capture = await captureCleanupTarget({ name: draft.capture.name, uid: draft.capture.uid });
        assertCurrent(capture, signal);
        if (!deepDraftMatches(draft, capture)) throw new Error('The Knowledge entry or destination changed. This draft cannot resume against changed content.');
        const queue = draft.batches.filter(batch => batch.status === mode && (!batchId || batch.id === batchId));
        for (const batch of queue) {
            assertCurrent(capture, signal);
            active = batch;
            previousStatus = batch.status;
            batch.status = 'running';
            batch.attempts++;
            onProgress(draft);
            await requestBatch(draft, batch, capture, signal);
            assertCurrent(capture, signal);
            active = null;
            onProgress(draft);
        }
    } finally {
        if (active?.status === 'running') active.status = previousStatus;
        draft.running = false;
        onProgress(draft);
    }
    return draft;
}