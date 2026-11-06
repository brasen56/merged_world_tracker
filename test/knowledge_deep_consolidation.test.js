import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    captureDeepConsolidationReview, buildDeepConsolidationUserContent,
    expandDeepConsolidationProposal, validateDeepConsolidationProposal,
} from '../knowledge/deep_consolidation.js';
import { originalLedgerProposal, validateLedgerProposal, parseLedgerProposal } from '../knowledge/ledger_cleanup.js';
import { expandKeepListProposal, CLEANUP_WIRE_VERSION } from '../knowledge/cleanup_review.js';
import { prepareDeepConsolidation } from '../knowledge/deep_consolidation_capture.js';
import { captureCleanupTarget } from '../knowledge/cleanup_commit.js';

vi.mock('../knowledge/cleanup_commit.js', () => ({ captureCleanupTarget: vi.fn() }));

const CONTENT = 'Mara | Human\r\nTone: brisk\n\nKnowledge Ledger:\r\n  - pin 7314\r\n\n- older fact\n- older detail\r\n- RECENT-PRIVATE\n\nOther section: untouched';
const select = (options = {}) => captureDeepConsolidationReview(CONTENT, { throughSource: 3, pins: [1], ...options });
const wireFor = selection => ({
    version: 3, reviewId: selection.review.reviewId, keep: [1],
    changed: [{ s: [2], t: 'Consolidated fact.', n: 'Subject summary.' }],
    archive: [3], groups: [{ s: [2, 3], label: 'Subject' }],
});

describe('deep consolidation capture and payload', () => {
    beforeEach(() => vi.clearAllMocks());

    it('captures identity through the existing seam with fresh IDs on regeneration, without a model or write', async () => {
        const capture = { name: 'Mara', uid: 7, bookName: 'Book', entityId: 'id', originalContent: CONTENT };
        captureCleanupTarget.mockResolvedValue(capture);
        const first = await prepareDeepConsolidation({ name: 'Mara', uid: 7, throughSource: 3, pins: [1] });
        const second = await prepareDeepConsolidation({ name: 'Mara', uid: 7, throughSource: 3, pins: [1] });
        expect(captureCleanupTarget).toHaveBeenCalledWith({ name: 'Mara', uid: 7 });
        expect(first.capture).toBe(capture);
        expect(first.selection.review.original).toBe(CONTENT);
        expect(first.selection.review.reviewId).not.toBe(second.selection.review.reviewId);
        expect(Object.isFrozen(first.selection)).toBe(true);
    });

    it('returns parser refusals and empty ledgers without making a review', async () => {
        for (const originalContent of ['not a ledger', 'Knowledge Ledger:\n- (no entries yet)']) {
            captureCleanupTarget.mockResolvedValue({ originalContent });
            const result = await prepareDeepConsolidation({ name: 'Mara', uid: 7 });
            expect(result.selection).toBeUndefined();
        }
        captureCleanupTarget.mockRejectedValue(new Error('ambiguous destination'));
        await expect(prepareDeepConsolidation({ name: 'Mara', uid: 7 })).rejects.toThrow('ambiguous');
    });

    it('excludes recent lines and dossier text from payload, states pins, and retains exact source slices', () => {
        const selection = select();
        const payload = buildDeepConsolidationUserContent('Mara', selection);
        expect(payload).toContain('<pinned_keep>[1]</pinned_keep>');
        expect(payload).toContain('[s3] - older detail');
        expect(payload).not.toMatch(/RECENT-PRIVATE|Tone:|Other section|\[s4\]/);
        expect(selection.recentSources[0].text).toBe('- RECENT-PRIVATE');
        for (const source of selection.review.sources) {
            expect(CONTENT.slice(source.start, source.end)).toBe(source.text);
        }
        expect(selection.review.sources[0].eol).toBe('\r\n');
        expect(select({ throughSource: undefined, pins: [] }).eligibleSources).toHaveLength(4);
    });

    it.each([0, -1, 1.5, 5, '3', NaN])('refuses invalid boundary %s', throughSource => {
        expect(() => select({ throughSource })).toThrow('boundary');
    });
    it.each([[0], [4], [1, 1], ['1'], null])('refuses invalid pins %j', pins => {
        expect(() => select({ pins })).toThrow('Pins');
    });
});

describe('experimental wire and ownership', () => {
    it('expands all three dispositions to full IDs and leaves recent sources outside model ownership', () => {
        const selection = select();
        const result = expandDeepConsolidationProposal(selection, wireFor(selection));
        expect(result.ok).toBe(true);
        expect(result.proposal.records[0].text).toBe('pin 7314');
        expect(result.proposal.archivedSourceIds).toEqual([selection.review.sources[2].id]);
        expect(validateDeepConsolidationProposal(selection, result.proposal)).toEqual({ ok: true });
        expect(selection.review.original).toBe(CONTENT);
    });

    it('allows no groups when all sources are kept, and multiple records in one subject group', () => {
        const selection = select();
        const wire = { ...wireFor(selection), keep: [3, 1, 2], changed: [], archive: [], groups: [] };
        expect(expandDeepConsolidationProposal(selection, wire).ok).toBe(true);
        wire.keep = [1];
        wire.changed = [{ s: [2], t: 'a'.repeat(800) }, { s: [3], t: 'b'.repeat(800) }];
        wire.groups = [{ s: [2, 3], label: 'Subject' }];
        expect(expandDeepConsolidationProposal(selection, wire).ok).toBe(true);
        wire.changed[0].t += 'a';
        expect(expandDeepConsolidationProposal(selection, wire).ok).toBe(false);
    });

    const invalidCases = [
        ['stale id', w => { w.reviewId = 'stale'; }],
        ['wrong version', w => { w.version = 2; }],
        ['unknown field', w => { w.removals = []; }],
        ['missing archive', w => { delete w.archive; }],
        ['missing coverage', w => { w.archive = []; }],
        ['duplicate keep', w => { w.keep.push(1); }],
        ['duplicate archive', w => { w.archive.push(3); }],
        ['cross disposition duplicate', w => { w.archive.push(2); }],
        ['duplicate changed source', w => { w.changed[0].s.push(2); }],
        ['post boundary source', w => { w.keep.push(4); }],
        ['noninteger source', w => { w.keep = ['1']; }],
        ['out of range source', w => { w.archive = [0]; }],
        ['pin merged', w => { w.keep = []; w.changed[0].s.push(1); w.groups[0].s.push(1); }],
        ['pin archived', w => { w.keep = []; w.archive.push(1); w.groups[0].s.push(1); }],
        ['ungrouped changed', w => { w.groups = [{ s: [3], label: 'Archive' }]; }],
        ['ungrouped archive', w => { w.groups = [{ s: [2], label: 'Active' }]; }],
        ['overlapping groups', w => { w.groups.push({ s: [2], label: 'Other' }); }],
        ['unknown group source', w => { w.groups[0].s.push(4); }],
        ['empty group', w => { w.groups[0].s = []; }],
        ['empty label', w => { w.groups[0].label = ' '; }],
        ['cross-group merge', w => { w.changed[0].s.push(3); w.archive = []; w.groups = [{ s: [2], label: 'A' }, { s: [3], label: 'B' }]; }],
        ['multiline', w => { w.changed[0].t = 'fact\nother'; }],
        ['unicode newline', w => { w.changed[0].t = 'fact\u2028other'; }],
        ['structural', w => { w.changed[0].t = 'Knowledge Ledger:'; }],
        ['bullet prefix', w => { w.changed[0].t = '- fact'; }],
        ['placeholder', w => { w.changed[0].t = '(no entries yet)'; }],
        ['invalid note', w => { w.changed[0].n = null; }],
        ['unknown changed field', w => { w.changed[0].extra = true; }],
    ];
    it.each(invalidCases)('fails closed: %s', (_name, mutate) => {
        const selection = select();
        const wire = wireFor(selection);
        mutate(wire);
        expect(expandDeepConsolidationProposal(selection, wire).ok).toBe(false);
    });

    it('revalidates edited proposals and refuses forged captures', () => {
        const selection = select();
        const { proposal } = expandDeepConsolidationProposal(selection, wireFor(selection));
        proposal.archivedSourceIds.push(selection.review.sources[1].id);
        expect(validateDeepConsolidationProposal(selection, proposal).ok).toBe(false);
        const forged = { ...selection, review: { ...selection.review, original: CONTENT + '\n- forged' } };
        expect(expandDeepConsolidationProposal(forged, wireFor(selection)).ok).toBe(false);
        expect(() => buildDeepConsolidationUserContent('Mara', forged)).toThrow('Invalid');
    });

    it('allows exact overlength legacy lines without weakening the bound for new records', () => {
        const selection = captureDeepConsolidationReview(`Knowledge Ledger:\n- ${'x'.repeat(801)}`);
        expect(expandDeepConsolidationProposal(selection, {
            version: 3, reviewId: selection.review.reviewId, keep: [1], changed: [], archive: [], groups: [],
        }).ok).toBe(true);
    });

    it('uses the strict parser, never a repair path', () => {
        expect(parseLedgerProposal('{"keep":[').ok).toBe(false);
        expect(parseLedgerProposal('prose {"keep":[]}').ok).toBe(false);
    });

    it('pins the public path to v2 and refuses archive even when empty', () => {
        const { review } = select();
        expect(CLEANUP_WIRE_VERSION).toBe(2);
        expect(expandKeepListProposal(review, {
            version: 2, reviewId: review.reviewId, keep: [1, 2, 3, 4], changed: [], archive: [],
        }).ok).toBe(false);
        expect(validateLedgerProposal(review, { ...originalLedgerProposal(review), archive: [] }).ok).toBe(false);
        expect(validateLedgerProposal(review, originalLedgerProposal(review)).ok).toBe(true);
    });
});