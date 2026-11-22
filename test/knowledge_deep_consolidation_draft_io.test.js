import { beforeEach, expect, it } from 'vitest';
import { captureDeepConsolidationReview } from '../knowledge/deep_consolidation.js';
import { createDeepConsolidationDraft, captureBatchReview, mapBatchProposal, deepDraftMatches,
    getDeepConsolidationDraft, _resetDeepConsolidationDraftsForTests } from '../knowledge/deep_consolidation_batches.js';
import { exportDeepConsolidationDraft, importDeepConsolidationDraft } from '../knowledge/deep_consolidation_draft_io.js';
import { assembleDeepConsolidationDraft } from '../knowledge/deep_consolidation_handoff.js';
import { originalLedgerProposal, patchLedgerProposal } from '../knowledge/ledger_cleanup.js';

const originalContent = 'DOSSIER\r\nKnowledge Ledger:\r\n  - pin\r\n- first\r\n\t- second\r\n- ungrouped\r\n- recent';
let capture;
let draft;
beforeEach(() => {
    _resetDeepConsolidationDraftsForTests();
    capture = { scopeKey: 'chat', bookName: 'book', name: 'Mara', uid: 7, entityId: 'entity', originalContent };
    const selection = captureDeepConsolidationReview(originalContent, { throughSource: 4, pins: [1] });
    draft = createDeepConsolidationDraft(capture, { selection, groups: [{ label: 'Gate', s: [2, 3] }] });
    const batch = draft.batches[0];
    const review = captureBatchReview(batch, 'old-review');
    const proposal = originalLedgerProposal(review);
    proposal.records = [{ id: 'merged', text: 'first and second', sourceIds: review.sources.map(s => s.id), notes: '' }];
    batch.status = 'accepted'; batch.result = mapBatchProposal(batch, review, proposal); batch.attempts = 1;
});

it('exports only numeric source references and a protected text snapshot, without review objects', () => {
    const packet = exportDeepConsolidationDraft(draft);
    expect(packet).toMatchObject({ type: 'mwt-deep-consolidation-draft', version: 1, throughSource: 4, pins: [1] });
    expect(packet.snapshot).toEqual(['  - pin', '- first', '\t- second', '- ungrouped']);
    expect(JSON.stringify(packet)).not.toMatch(/old-review|:source:|DOSSIER|recent|scopeToken|maxRecordChars/);
    packet.snapshot[0] = 'changed';
    expect(draft.snapshot[0]).toBe('  - pin');
});

it('imports after reload against appended scans/dossier edits and hands off using the full fresh entry', () => {
    const packet = exportDeepConsolidationDraft(draft);
    _resetDeepConsolidationDraftsForTests();
    const fresh = { ...capture, originalContent: originalContent.replace('DOSSIER', 'NEW DOSSIER') + '\r\n- appended' };
    const result = importDeepConsolidationDraft(JSON.stringify(packet), fresh);
    expect(result.matches).toBe(true);
    expect(getDeepConsolidationDraft(fresh)).toBe(result.draft);
    const assembled = assembleDeepConsolidationDraft(result.draft, fresh);
    expect(patchLedgerProposal(assembled.review, assembled.proposal).replacement)
        .toBe(fresh.originalContent.replace('- first\r\n\t- second', '- first and second'));
});

it.each([
    originalContent.replace('- first', '- edited'),
    originalContent.replace('- first\r\n', ''),
    originalContent.replace('- first', '- second').replace('\t- second', '\t- first'),
    originalContent.replace('  - pin', '- pin'),
    'Knowledge Ledger:\n- only one',
    'no ledger',
])('imports changed prefixes as export-only, not partially salvageable', changedContent => {
    const packet = exportDeepConsolidationDraft(draft);
    _resetDeepConsolidationDraftsForTests();
    const fresh = { ...capture, originalContent: changedContent };
    const result = importDeepConsolidationDraft(packet, fresh);
    expect(result.matches).toBe(false);
    expect(() => assembleDeepConsolidationDraft(result.draft, fresh)).toThrow('changed');
    expect(exportDeepConsolidationDraft(result.draft).batches[0].result).toEqual(packet.batches[0].result);
});

it('compares only protected source text, not dossier, line endings, or post-boundary lines', () => {
    expect(deepDraftMatches(draft, { ...capture, originalContent: originalContent.replace(/\r\n/g, '\n').replace('DOSSIER', 'UPDATED').replace('- recent', '- changed recent') })).toBe(true);
});

it.each([
    file => { file.type = 'wrong'; },
    file => { file.version = 2; },
    file => { file.origin.scopeKey = 'other'; },
    file => { file.origin.entityId = 'other'; },
    file => { file.pins = [2]; },
    file => { file.groups[0].s = [1, 2, 3]; },
    file => { file.batches[0].s = [2, 2, 3]; },
    file => { file.batches[0].s = [2, 4]; },
    file => { file.batches = []; },
    file => { file.batches[0].result.records[0].s = [2]; },
    file => { file.batches[0].result.records[0].s = [2, 2, 3]; },
    file => { file.batches[0].result.records[0].text = 'x'.repeat(1201); },
    file => { file.batches[0].result.records[0].text = 'bad\nline'; },
    file => { file.batches[0].status = 'running'; },
    file => { file.snapshot[1] = '- first\n- injected'; },
])('rejects corrupt/untrusted imports atomically', mutate => {
    const file = exportDeepConsolidationDraft(draft); mutate(file);
    _resetDeepConsolidationDraftsForTests();
    expect(() => importDeepConsolidationDraft(file, capture)).toThrow();
    expect(getDeepConsolidationDraft(capture)).toBeNull();
});

it('ignores forged review/character limits and never overwrites an existing draft', () => {
    const file = exportDeepConsolidationDraft(draft);
    file.review = { maxRecordChars: 999999, sources: [] };
    file.batches[0].review = file.review;
    expect(() => importDeepConsolidationDraft(file, capture)).toThrow('existing');
    expect(getDeepConsolidationDraft(capture)).toBe(draft);
    _resetDeepConsolidationDraftsForTests();
    file.batches[0].result.records[0].text = 'x'.repeat(1200);
    expect(importDeepConsolidationDraft(file, capture).matches).toBe(true);
});

it('exports in-flight work as pending or failed, preserving private failures and explicit retry state', () => {
    const batch = draft.batches[0];
    batch.status = 'running';
    expect(exportDeepConsolidationDraft(draft).batches[0].status).toBe('pending');
    batch.failure = { stage: 'parse', rawResponse: 'PRIVATE RAW', reason: 'bad JSON' };
    const file = exportDeepConsolidationDraft(draft);
    expect(file.batches[0].status).toBe('failed');
    _resetDeepConsolidationDraftsForTests();
    const imported = importDeepConsolidationDraft(file, capture).draft;
    expect(imported.batches[0]).toMatchObject({ status: 'failed', failure: { rawResponse: 'PRIVATE RAW' } });
    expect(imported.running).toBe(false);
});