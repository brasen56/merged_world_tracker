import { beforeEach, expect, it } from 'vitest';
import { captureDeepConsolidationReview } from '../knowledge/deep_consolidation.js';
import { captureLedgerReview, originalLedgerProposal, validateLedgerProposal, editLedgerRecord,
    patchLedgerProposal, keepLedgerOriginals } from '../knowledge/ledger_cleanup.js';
import { planBatches, captureBatchReview, mapBatchProposal, createDeepConsolidationDraft,
    getDeepConsolidationDraft, deepDraftMatches, _resetDeepConsolidationDraftsForTests } from '../knowledge/deep_consolidation_batches.js';
import { buildDeepBatchPrompt } from '../knowledge/deep_consolidation_batch_prompt.js';
import { estimateTokens } from '../core/context.js';

const content = texts => 'Knowledge Ledger:\n' + texts.map(text => `- ${text}`).join('\n');
const make = texts => captureDeepConsolidationReview(content(texts));
beforeEach(_resetDeepConsolidationDraftsForTests);

it('plans balanced ordered chunks without mutating input, singleton groups make no call', () => {
    const selection = make(Array.from({ length: 62 }, (_, i) => `fact ${i}`));
    const groups = [{ label: 'Gate', s: Array.from({ length: 61 }, (_, i) => 61 - i) }, { label: 'Alone', s: [62] }];
    const plan = planBatches(groups, { sources: selection.review.sources });
    expect(plan.map(batch => batch.s.length)).toEqual([20, 20, 21, 1]);
    expect(plan.flatMap(batch => batch.s)).toEqual(Array.from({ length: 62 }, (_, i) => i + 1));
    expect(plan.map(batch => batch.status)).toEqual(['pending', 'pending', 'pending', 'skipped']);
    expect(groups[0].s[0]).toBe(61);
    expect(planBatches([], { sources: [] })).toEqual([]);
});

it('enforces both caps, isolates oversized indivisible sources and rejects invalid plans', () => {
    const selection = make(['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80), 'd'.repeat(80), 'HUGE'.repeat(100)]);
    const sources = selection.review.sources;
    const groups = [{ label: 'Gate', s: [1, 2, 3, 4, 5] }];
    const maxTokens = estimateTokens(sources.slice(0, 2).map(s => s.text).join('\n'));
    const plan = planBatches(groups, { sources, maxTokens, maxSources: 3 });
    expect(plan.map(b => b.s)).toEqual([[1, 2], [3, 4], [5]]);
    expect(plan.at(-1)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('cap') });
    expect(plan.filter(b => b.status === 'pending').every(b => b.tokens <= maxTokens && b.s.length <= 3)).toBe(true);
    expect(() => planBatches(groups, { sources, maxSources: 0 })).toThrow('positive caps');
    expect(() => planBatches([{ s: [1, 1] }], { sources })).toThrow('duplicate');
});

it('copies exact text into a mini-ledger and maps local ids back to ledger numbers', () => {
    const batch = { s: [2, 9], texts: ['  - first', '\t- second'] };
    const review = captureBatchReview(batch, 'batch-test');
    expect(review.original).toBe('Knowledge Ledger:\n  - first\n\t- second');
    expect(review.sources.map(s => s.text)).toEqual(batch.texts);
    expect(Object.isFrozen(review)).toBe(true);
    expect(review.maxRecordChars).toBe(1200);
    const mapped = mapBatchProposal(batch, review, originalLedgerProposal(review));
    expect(mapped.records.map(r => r.s)).toEqual([[2], [9]]);
    expect(JSON.stringify(mapped)).not.toContain('batch-test:source');
});

it('retains scoped drafts by exact revision and excludes pins, recent and ungrouped sources', () => {
    const selection = captureDeepConsolidationReview(content(['pin', 'a', 'b', 'ungrouped', 'recent']), { throughSource: 4, pins: [1] });
    const capture = { scopeKey: 'chat', bookName: 'book', name: 'Mara', uid: 1, originalContent: selection.review.original };
    const draft = createDeepConsolidationDraft(capture, { selection, groups: [{ label: 'Gate', s: [1, 2, 3, 5] }] });
    expect(draft.batches[0].s).toEqual([2, 3]);
    expect(draft.ungrouped).toEqual([4]);
    expect(getDeepConsolidationDraft({ ...capture })).toBe(draft);
    expect(getDeepConsolidationDraft({ ...capture, scopeKey: 'other' })).toBeNull();
    expect(deepDraftMatches(draft, { ...capture })).toBe(true);
    expect(deepDraftMatches(draft, { ...capture, originalContent: capture.originalContent + '\n- scan' })).toBe(false);
});

it('opts into the bounded 1200 limit throughout helpers while keeping Condense defaults unchanged', () => {
    const original = content(['first', 'second']);
    const normal = captureLedgerReview(original, 'normal');
    expect(Object.hasOwn(normal, 'maxRecordChars')).toBe(false);
    const proposal = originalLedgerProposal(normal);
    expect(() => editLedgerRecord(normal, proposal, proposal.records[0].id, 'x'.repeat(801))).toThrow('800-character');
    const deep = captureLedgerReview(original, 'deep', { maxRecordChars: 1200 });
    const initial = originalLedgerProposal(deep);
    const edited = editLedgerRecord(deep, initial, initial.records[0].id, 'x'.repeat(1200));
    expect(patchLedgerProposal(deep, edited).ok).toBe(true);
    expect(keepLedgerOriginals(deep, edited, [deep.sources[0].id]).proposal.records[0].text).toBe('first');
    expect(() => editLedgerRecord(deep, initial, initial.records[0].id, 'x'.repeat(1201))).toThrow('1200-character');
    for (const maxRecordChars of [null, 799, 1201, 1000.5, '1200', Infinity]) {
        expect(() => captureLedgerReview(original, 'bad', { maxRecordChars })).toThrow('character limit');
        expect(validateLedgerProposal({ ...deep, maxRecordChars }, initial).ok).toBe(false);
    }
    const legacy = captureLedgerReview(content(['x'.repeat(1300)]), 'legacy');
    expect(validateLedgerProposal(legacy, originalLedgerProposal(legacy)).ok).toBe(true);
});

it('uses the Condense wire, shared tags, per-subject sizing and no whole-ledger task', () => {
    const prompt = buildDeepBatchPrompt('fresh-id');
    expect(prompt).toContain('"version":2,"reviewId":"fresh-id"');
    expect(prompt).toMatch(/1200 characters/);
    expect(prompt).toContain('500–650');
    expect(prompt).toContain('IDENTICAL provenance AND date');
    expect(prompt).not.toMatch(/active_budget|archive|"groups"/);
});