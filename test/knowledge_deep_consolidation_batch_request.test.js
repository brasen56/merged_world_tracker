import { beforeEach, expect, it, vi } from 'vitest';
import { captureCleanupTarget } from '../knowledge/cleanup_commit.js';
import { ktFetchFromApi } from '../knowledge/lorebook.js';
import { cleanupModelDisclosure } from '../knowledge/cleanup_review.js';
import { scopeStillCurrent } from '../core/scope.js';
import { _resetDiagnostics, getEvents, recordApiCall } from '../core/diagnostics.js';
import { captureDeepConsolidationReview } from '../knowledge/deep_consolidation.js';
import { createDeepConsolidationDraft, _resetDeepConsolidationDraftsForTests } from '../knowledge/deep_consolidation_batches.js';
import { runDeepConsolidationBatches } from '../knowledge/deep_consolidation_batch_request.js';

vi.mock('../knowledge/cleanup_commit.js', () => ({ captureCleanupTarget: vi.fn() }));
vi.mock('../knowledge/lorebook.js', () => ({ ktFetchFromApi: vi.fn() }));
vi.mock('../knowledge/settings.js', () => ({ hasValidSettings: () => true }));
vi.mock('../core/scope.js', async original => ({ ...await original(), scopeStillCurrent: vi.fn() }));
vi.mock('../knowledge/cleanup_review.js', async original => ({ ...await original(), cleanupModelDisclosure: vi.fn() }));

let capture;
let draft;
const answer = (_p, payload) => JSON.stringify({ version: 2, reviewId: /<review_id>(.*?)<\/review_id>/.exec(payload)[1], keep: [1, 2], changed: [], pruningSuggestions: [], notes: '' });
beforeEach(() => {
    vi.clearAllMocks(); _resetDiagnostics(); _resetDeepConsolidationDraftsForTests();
    scopeStillCurrent.mockReturnValue({ ok: true });
    const originalContent = 'PRIVATE DOSSIER\nKnowledge Ledger:\n- PRIVATE PIN\n  - first\n- second\n- third\n- fourth\n- PRIVATE RECENT';
    capture = { name: 'Mara', uid: 7, scopeKey: 'chat', bookName: 'book', originalContent, scopeToken: {} };
    const selection = captureDeepConsolidationReview(originalContent, { throughSource: 5, pins: [1] });
    draft = createDeepConsolidationDraft(capture, { selection, groups: [{ label: 'PRIVATE SUBJECT', s: [2, 3] }, { label: 'Other', s: [4, 5] }] });
    captureCleanupTarget.mockImplementation(async () => ({ ...capture }));
    cleanupModelDisclosure.mockReturnValue({ mode: 'custom', modelName: 'test', maxTokens: 8000 });
    ktFetchFromApi.mockImplementation(answer);
});

it('runs sequentially, validates and maps local sources, with matched private-safe diagnostics', async () => {
    let inFlight = 0;
    ktFetchFromApi.mockImplementation(async (prompt, payload, transport) => {
        expect(++inFlight).toBe(1);
        recordApiCall({ requestDiagnostics: { reviewId: 'unrelated' }, finish_reason: 'length', usage: { completion_tokens: 999 } });
        recordApiCall({ requestDiagnostics: transport.requestDiagnostics, finish_reason: 'stop', usage: { completion_tokens: 42 } });
        await Promise.resolve(); --inFlight;
        return answer(prompt, payload);
    });
    await runDeepConsolidationBatches(draft);
    expect(draft.batches.map(b => b.status)).toEqual(['accepted', 'accepted']);
    expect(draft.batches[0].result.records.map(r => r.s)).toEqual([[2], [3]]);
    expect(draft.batches[0].responseFacts).toEqual({ finishReason: 'stop', completionTokens: 42 });
    const [, payload, transport] = ktFetchFromApi.mock.calls[0];
    expect(payload).toContain('[s1]   - first');
    expect(payload).not.toMatch(/PRIVATE PIN|PRIVATE DOSSIER|PRIVATE RECENT|third|fourth/);
    expect(transport).toMatchObject({ retries: 0, trigger: 'manual', requestDiagnostics: { operation: 'deep-consolidation-batch' } });
    expect(JSON.stringify(getEvents({ module: 'knowledge' }))).not.toMatch(/PRIVATE|first|second/);
    await runDeepConsolidationBatches(draft);
    expect(ktFetchFromApi).toHaveBeenCalledTimes(2);
});

it.each(['parse', 'validation', 'request', 'budget'])('retains %s failures per batch without automatic retry', async stage => {
    if (stage === 'parse') ktFetchFromApi.mockResolvedValue('PRIVATE RAW');
    if (stage === 'validation') ktFetchFromApi.mockImplementation((p, u) => JSON.stringify({ ...JSON.parse(answer(p, u)), keep: [1] }));
    if (stage === 'request') ktFetchFromApi.mockRejectedValue(new Error('PRIVATE NETWORK'));
    if (stage === 'budget') cleanupModelDisclosure.mockReturnValue({ maxTokens: 1 });
    await runDeepConsolidationBatches(draft);
    expect(draft.batches.map(b => b.status)).toEqual(['failed', 'failed']);
    expect(draft.batches[0].failure.stage).toBe(stage);
    expect(draft.batches[0].attempts).toBe(1);
    expect(JSON.stringify(getEvents({ module: 'knowledge' }))).not.toMatch(/PRIVATE/);
    const previousId = draft.batches[0].reviewId;
    cleanupModelDisclosure.mockReturnValue({ maxTokens: 8000 }); ktFetchFromApi.mockImplementation(answer);
    await runDeepConsolidationBatches(draft, { mode: 'failed', batchId: draft.batches[0].id });
    expect(draft.batches.map(b => b.status)).toEqual(['accepted', 'failed']);
    expect(draft.batches[0].reviewId).not.toBe(previousId);
    await runDeepConsolidationBatches(draft, { mode: 'failed' });
    expect(draft.batches.map(b => b.status)).toEqual(['accepted', 'accepted']);
    expect(draft.batches.map(b => b.attempts)).toEqual([2, 2]);
});

it('rejects invalid coverage/identity, structural and over-limit records, but accepts 1200 chars', async () => {
    for (const wire of [
        { keep: [1, 1, 2] }, { reviewId: 'wrong' },
        { keep: [], changed: [{ s: [1, 2], t: 'x'.repeat(1201) }] },
        { keep: [], changed: [{ s: [1, 2], t: 'line\nbreak' }] },
    ]) {
        ktFetchFromApi.mockImplementation((p, u) => JSON.stringify({ ...JSON.parse(answer(p, u)), ...wire }));
        await runDeepConsolidationBatches(draft, { mode: draft.batches[0].status === 'pending' ? 'pending' : 'failed' });
        expect(draft.batches.every(b => b.status === 'failed')).toBe(true);
    }
    ktFetchFromApi.mockImplementation((p, u) => JSON.stringify({ ...JSON.parse(answer(p, u)), keep: [], changed: [{ s: [1, 2], t: 'x'.repeat(1200) }] }));
    await runDeepConsolidationBatches(draft, { mode: 'failed' });
    expect(draft.batches.every(b => b.status === 'accepted')).toBe(true);
});

it('retains accepted work on abort, ignores late responses and resumes only pending work', async () => {
    const controller = new AbortController();
    ktFetchFromApi.mockImplementationOnce(answer).mockImplementationOnce((p, u) => {
        controller.abort(); return answer(p, u);
    });
    await expect(runDeepConsolidationBatches(draft, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(draft.batches.map(b => b.status)).toEqual(['accepted', 'pending']);
    expect(draft.running).toBe(false);
    const id = draft.batches[1].reviewId;
    await runDeepConsolidationBatches(draft);
    expect(draft.batches[1].reviewId).not.toBe(id);
    expect(ktFetchFromApi).toHaveBeenCalledTimes(3);
});

it('refuses concurrent runs, changed entries, pre-aborted signals and late scope changes', async () => {
    draft.running = true;
    await expect(runDeepConsolidationBatches(draft)).rejects.toThrow('already running');
    draft.running = false;
    captureCleanupTarget.mockResolvedValueOnce({ ...capture, originalContent: 'changed' });
    await expect(runDeepConsolidationBatches(draft)).rejects.toThrow('changed');
    const controller = new AbortController(); controller.abort();
    await expect(runDeepConsolidationBatches(draft, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ktFetchFromApi).not.toHaveBeenCalled();
    ktFetchFromApi.mockImplementation((...args) => { scopeStillCurrent.mockReturnValue({ ok: false }); return answer(...args); });
    await expect(runDeepConsolidationBatches(draft)).rejects.toMatchObject({ name: 'AbortError' });
    expect(draft.batches.map(b => b.status)).toEqual(['pending', 'pending']);
});