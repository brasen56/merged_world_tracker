import { beforeEach, expect, it, vi } from 'vitest';
import { captureScope, _resetEpoch, bumpEpoch } from '../core/scope.js';
import { captureDeepConsolidationReview } from '../knowledge/deep_consolidation.js';
import { captureCleanupTarget } from '../knowledge/cleanup_commit.js';
import { createDeepConsolidationDraft, captureBatchReview, mapBatchProposal, _resetDeepConsolidationDraftsForTests } from '../knowledge/deep_consolidation_batches.js';
import { assembleDeepConsolidationDraft, handoffDeepConsolidationDraft } from '../knowledge/deep_consolidation_handoff.js';
import { originalLedgerProposal, validateLedgerProposal, patchLedgerProposal, keepLedgerOriginals, editLedgerRecord } from '../knowledge/ledger_cleanup.js';
import { saveCleanupDraft, getCleanupDraft, getPreviousCleanupDrafts, _resetCleanupDraftsForTests } from '../knowledge/cleanup_review.js';

vi.mock('../knowledge/cleanup_commit.js', () => ({ captureCleanupTarget: vi.fn() }));
const original = 'DOSSIER\r\nKnowledge Ledger:\r\n  - pin\r\n- first\r\n- second\r\n\t- ungrouped\r\n- singleton\r\n- failed A\r\n- failed B\r\n- pending A\r\n- pending B\r\n- recent';
let capture;
let draft;
beforeEach(() => {
    _resetEpoch(); _resetCleanupDraftsForTests(); _resetDeepConsolidationDraftsForTests(); vi.clearAllMocks();
    capture = { scopeKey: 'chat', bookName: 'book', name: 'Mara', uid: 7, entityId: 'entity', originalContent: original, scopeToken: captureScope() };
    const selection = captureDeepConsolidationReview(original, { throughSource: 9, pins: [1] });
    draft = createDeepConsolidationDraft(capture, { selection, groups: [
        { label: 'Merge', s: [2, 3] }, { label: 'Alone', s: [5] },
        { label: 'Failure', s: [6, 7] }, { label: 'Pending', s: [8, 9] },
    ] });
    const batch = draft.batches[0];
    const review = captureBatchReview(batch, 'old-batch-id');
    const proposal = originalLedgerProposal(review);
    proposal.records = [{ id: 'merge', text: 'first and second', sourceIds: review.sources.map(s => s.id), notes: 'merge note' }];
    proposal.pruningSuggestions = [{ sourceIds: [review.sources[1].id], reason: 'advisory only' }];
    proposal.notes = 'batch note';
    batch.status = 'accepted'; batch.result = mapBatchProposal(batch, review, proposal);
    draft.batches[2].status = 'failed';
    captureCleanupTarget.mockImplementation(async () => ({ ...capture, scopeToken: captureScope() }));
});

it('maps partial results to fresh IDs, preserves other sources exactly and uses ordinary review helpers', () => {
    const { review, proposal, decisions } = assembleDeepConsolidationDraft(draft, { ...capture }, 'fresh-full-id');
    expect(review.maxRecordChars).toBe(1200);
    expect(validateLedgerProposal(review, proposal, decisions).ok).toBe(true);
    expect(proposal.records.map(r => r.sourceIds.map(id => review.sources.find(s => s.id === id).order + 1)))
        .toEqual([[1], [2, 3], [4], [5], [6], [7], [8], [9], [10]]);
    expect(JSON.stringify(proposal)).not.toContain('old-batch-id');
    expect(proposal.pruningSuggestions).toEqual([{ sourceIds: [review.sources[2].id], reason: 'advisory only' }]);
    expect(decisions).toEqual({ removals: [] });
    const patch = patchLedgerProposal(review, proposal, decisions);
    expect(patch.replacement).toBe(original.replace('- first\r\n- second', '- first and second'));
    const merged = proposal.records[1];
    expect(editLedgerRecord(review, proposal, merged.id, 'x'.repeat(1200)).records[1].text).toHaveLength(1200);
    expect(() => editLedgerRecord(review, proposal, merged.id, 'x'.repeat(1201))).toThrow('1200-character');
    const kept = keepLedgerOriginals(review, proposal, merged.sourceIds);
    expect(patchLedgerProposal(review, kept.proposal, kept.decisions).replacement).toBe(original);
});

it('allows zero accepted batches and does not mutate the deep draft', () => {
    draft.batches[0].status = 'pending';
    const before = JSON.stringify(draft);
    const result = assembleDeepConsolidationDraft(draft, capture);
    expect(patchLedgerProposal(result.review, result.proposal).replacement).toBe(original);
    expect(JSON.stringify(draft)).toBe(before);
});

it('captures fresh, stashes before saving, and retains deep progress', async () => {
    const previous = { review: draft.selection.review, proposal: { marker: 'edited' }, decisions: { removals: [] } };
    saveCleanupDraft(capture, previous);
    const first = await handoffDeepConsolidationDraft(draft);
    expect(captureCleanupTarget).toHaveBeenCalledWith({ name: 'Mara', uid: 7 });
    expect(getPreviousCleanupDrafts(capture)[0].proposal).toBe(previous.proposal);
    expect(getCleanupDraft(capture).review).toBe(first.review);
    const second = await handoffDeepConsolidationDraft(draft);
    expect(second.review.reviewId).not.toBe(first.review.reviewId);
    expect(draft.batches[0].status).toBe('accepted');
});

it.each(['originalContent', 'entityId', 'scopeKey', 'bookName', 'name', 'uid'])('refuses changed %s without replacing the Condense draft', async field => {
    saveCleanupDraft(capture, { review: draft.selection.review, proposal: {}, decisions: { removals: [] } });
    const previous = getCleanupDraft(capture);
    captureCleanupTarget.mockResolvedValue({ ...capture, [field]: 'changed' });
    await expect(handoffDeepConsolidationDraft(draft)).rejects.toThrow('changed');
    expect(getCleanupDraft(capture)).toBe(previous);
    expect(getPreviousCleanupDrafts(capture)).toHaveLength(0);
});

it('refuses cancellation, stale scope and running drafts', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(handoffDeepConsolidationDraft(draft, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    captureCleanupTarget.mockResolvedValue(capture); bumpEpoch();
    await expect(handoffDeepConsolidationDraft(draft)).rejects.toMatchObject({ name: 'AbortError' });
    draft.running = true;
    expect(() => assembleDeepConsolidationDraft(draft, capture)).toThrow('finish');
    expect(getCleanupDraft(capture)).toBeNull();
});

it('rejects a scope switch during capture even if the returned scope token is fresh', async () => {
    captureCleanupTarget.mockImplementation(async () => {
        bumpEpoch();
        return { ...capture, scopeToken: captureScope() };
    });
    await expect(handoffDeepConsolidationDraft(draft)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getCleanupDraft(capture)).toBeNull();
});

it.each(['missing', 'duplicate', 'unknown', 'snapshot', 'length'])('revalidates accepted batches: %s', kind => {
    const batch = draft.batches[0];
    if (kind === 'missing') batch.result.records[0].s = [2];
    if (kind === 'duplicate') batch.result.records[0].s = [2, 2, 3];
    if (kind === 'unknown') batch.result.records[0].s = [2, 4];
    if (kind === 'snapshot') batch.texts[0] = '- altered';
    if (kind === 'length') batch.result.records[0].text = 'x'.repeat(1201);
    expect(() => assembleDeepConsolidationDraft(draft, capture)).toThrow();
    expect(getCleanupDraft(capture)).toBeNull();
});