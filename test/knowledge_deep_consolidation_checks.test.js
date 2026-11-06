import { describe, it, expect } from 'vitest';
import { captureDeepConsolidationReview, expandDeepConsolidationProposal } from '../knowledge/deep_consolidation.js';
import { inspectDeepConsolidation, keepDeepSourceExact, buildDeepConsolidationEntry, deepExactCandidates } from '../knowledge/deep_consolidation_checks.js';
import { estimateTokens } from '../core/context.js';

const original = 'Mara dossier\r\nKnowledge Ledger:\r\n  - gate code 7314 via document — Day 1\r\n\n- Believes "Ezra" left via rumor — Day 2\n- Actually the code is 8822 via witness — Day 3\r\n- RECENT 9191\n\nOther: intact';
function fixture() {
    const selection = captureDeepConsolidationReview(original, { throughSource: 3 });
    const { proposal } = expandDeepConsolidationProposal(selection, { version: 3, reviewId: selection.review.reviewId,
        keep: [], changed: [{ s: [1, 2], t: 'code 7314; Ezra left, code 8822 (via witness — Day 3)' }],
        archive: [3], groups: [{ s: [1, 2, 3], label: 'Gate' }] });
    return { selection, proposal };
}

describe('experimental deterministic guard', () => {
    it('compares archived and changed inputs to the whole active ledger, with numbers first', () => {
        const { selection, proposal } = fixture();
        const report = inspectDeepConsolidation(selection, proposal);
        expect(report.warnings.some(w => ['7314', '8822'].includes(w.detail))).toBe(false);
        expect(report.warnings.some(w => w.sourceNumber === 3 && w.kind === 'semantic-review')).toBe(true);
        const missing = report.warnings.filter(w => w.kind === 'detail-not-retained');
        expect(missing[0].detail).toMatch(/\d/);
        expect(report.measurements.beforeTokens).toBeGreaterThan(0);
        expect(report.entryText).toContain('- RECENT 9191\n\nOther: intact');
    });

    it('recognizes numbers, codes without digits, quotes, belief and explicit correction candidates', () => {
        const selection = captureDeepConsolidationReview('Knowledge Ledger:\n- password raven\n- believes ‘safe’\n- correction: actually open');
        expect(deepExactCandidates(selection).map(c => c.reasons)).toEqual([
            ['code'], ['quoted-text', 'belief-or-rumor'], ['correction-candidate'],
        ]);
    });

    it('restores a merged owner as a unit without mutating the draft, and restores archive individually', () => {
        const { selection, proposal } = fixture();
        const snapshot = JSON.stringify(proposal);
        const restored = keepDeepSourceExact(selection, proposal, selection.review.sources[0].id);
        expect(restored.records).toHaveLength(2);
        expect(restored.records.every(r => r.sourceIds.length === 1)).toBe(true);
        expect(JSON.stringify(proposal)).toBe(snapshot);
        const all = keepDeepSourceExact(selection, restored, selection.review.sources[2].id);
        expect(buildDeepConsolidationEntry(selection, all)).toBe(original);
        expect(() => keepDeepSourceExact(selection, proposal, selection.recentSources[0].id)).toThrow('eligible');
    });

    it('counts mandatory sources once; floor excess is an outcome, not refusal', () => {
        const { selection, proposal } = fixture();
        const report = inspectDeepConsolidation(selection, proposal, { activeBudget: 1 });
        expect(report.measurements.floorTokens).toBe(estimateTokens(selection.review.sources.map(s => s.text).join('\n')));
        expect(report.measurements.floorExceedsBudget).toBe(true);
        expect(report.measurements.recent.sourceCount).toBe(1);
        expect(report.exactCandidates.filter(c => c.canKeepExact)).toHaveLength(3);
    });

    it('includes pinned and ungrouped sources in the mandatory floor and reports their shares', () => {
        const selection = captureDeepConsolidationReview('Knowledge Ledger:\n- plain pin\n- plain ungrouped\n- grouped', { pins: [1] });
        const { proposal } = expandDeepConsolidationProposal(selection, { version: 3, reviewId: selection.review.reviewId,
            keep: [1, 2], changed: [], archive: [3], groups: [{ s: [3], label: 'archive s3: unneeded' }] });
        const report = inspectDeepConsolidation(selection, proposal);
        expect(report.measurements.pinned.sourceCount).toBe(1);
        expect(report.measurements.ungrouped.sourceCount).toBe(2);
        expect(report.measurements.floorTokens).toBe(estimateTokens('- plain pin\n- plain ungrouped'));
    });

    it('checks against recent text too and recomputes after edits; invalid edits fail closed', () => {
        const { selection, proposal } = fixture();
        proposal.records[0].text = '9191';
        const report = inspectDeepConsolidation(selection, proposal);
        expect(report.archiveOnlyDetails.some(w => w.detail === '8822')).toBe(true);
        proposal.records[0].text = 'bad\nline';
        expect(() => inspectDeepConsolidation(selection, proposal)).toThrow();
    });

    it('checks explicit lower-case codes and quoted wording, and handles archive-only output', () => {
        const selection = captureDeepConsolidationReview('Knowledge Ledger:\n- Alice password is raven\n- said "quiet dawn"');
        const { proposal } = expandDeepConsolidationProposal(selection, { version: 3, reviewId: selection.review.reviewId,
            keep: [], changed: [], archive: [1, 2], groups: [{ s: [1, 2], label: 'archive s1, s2: trial' }] });
        const report = inspectDeepConsolidation(selection, proposal);
        expect(report.archiveOnlyDetails[0]).toMatchObject({ detail: 'raven', detailType: 'code' });
        expect(report.archiveOnlyDetails.some(w => w.detail === 'quiet dawn')).toBe(true);
        expect(report.measurements.afterTokens).toBe(0);
        expect(report.entryText).toBe('Knowledge Ledger:\n');
        const restored = keepDeepSourceExact(selection, proposal, selection.eligibleSources[0].id);
        expect(() => keepDeepSourceExact(selection, restored, selection.eligibleSources[0].id)).not.toThrow();
    });
});