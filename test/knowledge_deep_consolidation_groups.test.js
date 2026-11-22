import { describe, expect, it } from 'vitest';
import { captureDeepConsolidationReview } from '../knowledge/deep_consolidation.js';
import { buildDeepGroupingPrompt, buildDeepGroupingUserContent, normalizeDeepGroups, groupDeepSourcesByPosition,
    moveDeepGroupingSource, measureDeepGroup } from '../knowledge/deep_consolidation_groups.js';

const selection = () => captureDeepConsolidationReview('PRIVATE\nKnowledge Ledger:\n- pin\n- gate\n- correction\n- alone\n- RECENT', { throughSource: 4, pins: [1] });
const normalize = (s, groups) => normalizeDeepGroups(s, { reviewId: s.review.reviewId, groups });

describe('v2 subject groups', () => {
    it('sends only non-pinned eligible sources, with original ledger numbers', () => {
        const s = selection();
        const text = buildDeepGroupingUserContent('Mara', s);
        expect(text).toContain('[s2] - gate');
        expect(text).not.toMatch(/PRIVATE|RECENT|\[s1\]|\[s5\]|active_budget/);
        expect(buildDeepGroupingPrompt(s.review.reviewId)).toMatch(/SUBJECT.*person, faction, place, or secret/s);
        expect(buildDeepGroupingPrompt(s.review.reviewId)).toContain('Keep corrections');
    });

    it('normalizes invalid numbers, overlaps, labels and containers without rejecting', () => {
        const s = selection();
        const result = normalize(s, [
            { label: '  Gate\n' + 'x'.repeat(100), s: [3, 2, 1, 5, 999, 2.5, '4', 2] },
            { label: 'duplicate', s: [3] }, null, { s: 'bad' }, { label: '', s: [4] },
        ]);
        expect(result.ok).toBe(true);
        expect(result.groups.map(g => g.s)).toEqual([[2, 3], [4]]);
        expect(result.groups[0].label).toHaveLength(80);
        expect(result.groups[0].label).not.toMatch(/[\r\n]/);
        expect(result.groups[1].label).toBe('Subject');
        expect(result.normalization).toEqual({ ignoredNumbers: 5, duplicates: 2, emptyGroups: 1, labelsAdjusted: 2, malformedGroups: 2 });
        expect(result.ungrouped).toEqual([]);
        expect(normalizeDeepGroups(s, { reviewId: s.review.reviewId, version: 999, groups: {} })).toMatchObject({ ok: true, groups: [], ungrouped: [2, 3, 4] });
        expect(normalizeDeepGroups(s, { reviewId: 'wrong', groups: [] }).ok).toBe(false);
    });

    it('keeps omissions ungrouped and moves immutably, dropping emptied groups', () => {
        const s = selection();
        const original = normalize(s, [{ label: 'Gate', s: [2] }, { label: 'Other', s: [3] }]);
        expect(original.ungrouped).toEqual([4]);
        const next = moveDeepGroupingSource(s, original.groups, 2, 1);
        expect(next.groups).toEqual([{ label: 'Other', s: [2, 3] }]);
        expect(original.groups[0].s).toEqual([2]);
        expect(moveDeepGroupingSource(s, next.groups, 3, -1).ungrouped).toEqual([3, 4]);
        expect(() => moveDeepGroupingSource(s, next.groups, 1, 0)).toThrow('non-pinned');
        expect(() => moveDeepGroupingSource(s, next.groups, 2, 9)).toThrow('existing group');
    });

    it('falls back to consecutive groups of 30 and projects singleton/token caps', () => {
        const s = captureDeepConsolidationReview('Knowledge Ledger:\n' + Array.from({ length: 64 }, (_, i) => `- fact ${i}`).join('\n'), { throughSource: 63, pins: [2, 31] });
        const result = groupDeepSourcesByPosition(s);
        expect(result.groups.map(g => g.s.length)).toEqual([30, 30, 1]);
        expect(result.groups.flatMap(g => g.s)).not.toContain(2);
        expect(result.groups.flatMap(g => g.s)).not.toContain(64);
        expect(measureDeepGroup(s, result.groups[0])).toMatchObject({ sourceCount: 30, estimatedBatches: 1, keptExact: false });
        expect(measureDeepGroup(s, result.groups[2])).toMatchObject({ estimatedBatches: 0, keptExact: true });
        const huge = captureDeepConsolidationReview('Knowledge Ledger:\n- ' + 'x'.repeat(14000) + '\n- small');
        expect(measureDeepGroup(huge, { s: [1, 2] }).estimatedBatches).toBe(2);
    });
});