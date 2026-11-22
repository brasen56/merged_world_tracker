/** Assemble accepted work into an ordinary Condense draft; never write an entry. */
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { captureCleanupTarget } from './cleanup_commit.js';
import { newReviewId, saveCleanupDraft, stashPreviousCleanupDraft } from './cleanup_review.js';
import { captureLedgerReview, originalLedgerProposal, validateLedgerProposal } from './ledger_cleanup.js';
import { captureBatchReview, deepDraftMatches } from './deep_consolidation_batches.js';
import { DEEP_CONSOLIDATION_MAX_CHARS } from './deep_consolidation_limits.js';

export function assembleDeepConsolidationDraft(draft, capture, reviewId = `deep-review-${newReviewId()}`) {
    if (draft.running) throw new Error('Wait for the batch run to finish before handing off.');
    if (!deepDraftMatches(draft, capture)) throw new Error('The Knowledge entry or destination changed. This draft cannot be handed off against changed content.');
    const review = captureLedgerReview(capture.originalContent, reviewId, { maxRecordChars: DEEP_CONSOLIDATION_MAX_CHARS });
    const proposal = originalLedgerProposal(review);
    const owned = new Set();
    const records = [];
    const notes = [];
    for (const [index, batch] of draft.batches.entries()) {
        if (batch.status !== 'accepted') continue;
        if (!Array.isArray(batch.s) || !batch.s.length || new Set(batch.s).size !== batch.s.length ||
            batch.s.some((n, i) => !Number.isInteger(n) || !review.sources[n - 1] || owned.has(n) ||
                review.sources[n - 1].text !== batch.texts[i])) throw new Error('Invalid accepted batch source snapshot.');
        const mini = captureBatchReview(batch, `${reviewId}-batch-${index + 1}`);
        const mapSources = (numbers, sources) => {
            if (!Array.isArray(numbers) || numbers.some(n => !batch.s.includes(n))) throw new Error('Invalid accepted batch source mapping.');
            return numbers.map(n => sources[batch.s.indexOf(n)].id);
        };
        const mapped = (sources, targetReviewId) => ({
            version: proposal.version, reviewId: targetReviewId,
            records: batch.result.records.map((record, i) => ({ id: `batch-${index + 1}-record-${i + 1}`,
                text: record.text, sourceIds: mapSources(record.s, sources), notes: record.notes })),
            pruningSuggestions: batch.result.pruningSuggestions.map(item => ({ sourceIds: mapSources(item.s, sources), reason: item.reason })),
            notes: batch.result.notes,
        });
        // Recheck each mini-ledger so missing coverage cannot silently become an exact keep.
        const local = mapped(mini.sources, mini.reviewId);
        const check = validateLedgerProposal(mini, local);
        if (!check.ok) throw new Error(check.reason);
        const full = mapped(batch.s.map(n => review.sources[n - 1]), review.reviewId);
        records.push(...full.records);
        proposal.pruningSuggestions.push(...full.pruningSuggestions);
        if (full.notes) notes.push(full.notes);
        batch.s.forEach(n => owned.add(n));
    }
    records.push(...proposal.records.filter((_record, index) => !owned.has(index + 1)));
    const order = new Map(review.sources.map(source => [source.id, source.order]));
    records.sort((a, b) => Math.min(...a.sourceIds.map(id => order.get(id))) - Math.min(...b.sourceIds.map(id => order.get(id))));
    proposal.records = records;
    proposal.notes = notes.join('\n');
    const decisions = { removals: [] };
    const check = validateLedgerProposal(review, proposal, decisions);
    if (!check.ok) throw new Error(check.reason);
    return { review, proposal, decisions };
}

export async function handoffDeepConsolidationDraft(draft, { signal } = {}) {
    const scope = captureScope();
    const capture = await captureCleanupTarget({ name: draft.capture.name, uid: draft.capture.uid });
    if (signal?.aborted || !scopeStillCurrent(scope).ok || !scopeStillCurrent(capture.scopeToken).ok) {
        const error = new Error('Hand-off cancelled or its scope changed. The deep draft was retained.');
        error.name = 'AbortError';
        throw error;
    }
    const assembled = assembleDeepConsolidationDraft(draft, capture);
    stashPreviousCleanupDraft(capture);
    saveCleanupDraft(capture, assembled);
    return { capture, ...assembled };
}