import { describe, test, expect } from 'vitest';
import { captureFieldReview, validateFieldProposal, patchFieldProposal, fieldCleanupSpans, changedFieldKeys } from '../knowledge/field_cleanup.js';

export const SOURCE = '[Dossier] Mara | Human | keeper\r\nTone: quiet\r\nRole: Harbourmaster, who checked the dock today\r\nVoice: Low and deliberate\r\nCurrent Agenda: Protect the harbour\r\nSecrets: Tier 2: gate code 4812\r\nCanon Lock: born here\r\nImage Tags: dark hair\r\n\r\nKnowledge Ledger:\r\n- Code 4812 via witness — Day 1\r\n<!-- mwt:relationships:start -->\r\nRole: Not a dossier field\r\n<!-- mwt:relationships:end -->\r\n';
// A label collision inside managed content is deliberately treated as ambiguous.
const source = SOURCE.replace('Role: Not a dossier field', 'Friend: Jo');
const makeReview = (keys = ['role', 'voice']) => captureFieldReview(source, keys, 'review-1');
const makeProposal = review => ({ version: 1, reviewId: review.reviewId, fields: review.fields.map(field => ({
    key: field.key, value: field.key === 'role' ? 'Harbourmaster' : 'Low voice',
    explanation: 'Retain established identity.', displacedDetails: 'Scene detail removed.', ambiguity: '',
})) });

describe('selected-field cleanup contract', () => {
    test.each(['canon_lock', 'image_tags', 'secrets', 'descriptor', 'first_seen', 'relationships', 'unknown'])('protects %s', key => {
        expect(() => makeReview([key])).toThrow();
    });
    test('no preselected acceptance; every field needs a decision', () => {
        const review = makeReview();
        expect(() => patchFieldProposal(review, makeProposal(review), {})).toThrow('Decide');
    });
    test('selected value patch preserves all other bytes including CRLF, ledger and managed block', () => {
        const review = makeReview();
        const result = patchFieldProposal(review, makeProposal(review), { role: { action: 'accept' }, voice: { action: 'keep' } });
        expect(result).toBe(source.replace('Harbourmaster, who checked the dock today', 'Harbourmaster'));
        expect(changedFieldKeys(source, result)).toEqual(['role']);
    });
    test('edits stay in the selected value and do not relocate displaced details', () => {
        const review = makeReview(['role']);
        expect(patchFieldProposal(review, makeProposal(review), { role: { action: 'edit', value: 'Harbour keeper' } }))
            .toBe(source.replace('Harbourmaster, who checked the dock today', 'Harbour keeper'));
    });
    test.each(['\nRole: injected', 'x\r\n', 'Knowledge Ledger: stolen', '[Dossier] stolen', 'x'.repeat(401)])('refuses structural/size edit %s', value => {
        const review = makeReview(['role']);
        expect(() => patchFieldProposal(review, makeProposal(review), { role: { action: 'edit', value } })).toThrow();
    });
    test('ambiguity can only keep originals', () => {
        const review = makeReview(['role']);
        const proposal = makeProposal(review);
        proposal.fields[0].ambiguity = 'Occupation cannot be distinguished from a temporary assignment.';
        expect(() => patchFieldProposal(review, proposal, { role: { action: 'accept' } })).toThrow('ambiguous');
        expect(patchFieldProposal(review, proposal, { role: { action: 'keep' } })).toBe(source);
    });
    test.each([
        '<!--mwt:relationships:start -->',
        '<!--  mwt:relationships:end -->',
        '<!--\tMwT:ReLaTiOnShIpS:start -->',
    ])('refuses marker variant in proposals and edits: %s', value => {
        const review = makeReview(['role']);
        const proposal = makeProposal(review);
        expect(() => patchFieldProposal(review, proposal, { role: { action: 'edit', value } })).toThrow('Invalid edited');
        proposal.fields[0].value = value;
        expect(() => validateFieldProposal(review, proposal)).toThrow('managed relationship');
    });
    test.each(['\n', '\r\n', '\r'])('blank lines do not hide continuation prose (%j)', newline => {
        const content = source.replaceAll('\r\n', newline).replace(
            `Role: Harbourmaster, who checked the dock today${newline}`,
            `Role: Harbourmaster${newline} ${newline}\t${newline}continued prose${newline}`,
        );
        expect(fieldCleanupSpans(content)).not.toHaveProperty('role');
        expect(() => captureFieldReview(content, ['role'], 'r')).toThrow('ambiguous');
        expect(captureFieldReview(content, ['voice'], 'r').fields[0].value).toBe('Low and deliberate');
    });
    test.each(['\n', '\r\n', '\r'])('blank lines before recognized boundaries preserve eligibility (%j)', newline => {
        const content = source.replaceAll('\r\n', newline)
            .replace(`${newline}Voice:`, `${newline} ${newline}\t${newline}Voice:`);
        const review = captureFieldReview(content, ['role'], 'r');
        const replacement = patchFieldProposal(review, makeProposal(review), { role: { action: 'accept' } });
        expect(replacement).toBe(content.replace('Harbourmaster, who checked the dock today', 'Harbourmaster'));
        expect(changedFieldKeys(content, replacement)).toEqual(['role']);
        expect(fieldCleanupSpans(`[Dossier] Mara${newline}Role: Keeper${newline}${newline}Knowledge Ledger:`)).toHaveProperty('role');
    });
    test.each(['accept', 'edit'])('normalizes whitespace for %s rewrites without changing other bytes', action => {
        const review = makeReview(['role']);
        const proposal = makeProposal(review);
        proposal.fields[0].value = '  Harbourmaster \t';
        expect(patchFieldProposal(review, proposal, { role: { action, value: '\t Harbourmaster  ' } }))
            .toBe(source.replace('Harbourmaster, who checked the dock today', 'Harbourmaster'));
    });
    test.each(['', 'Missing context'])('over-bound exact echoes validate and preserve sibling rewrites (ambiguity: %s)', ambiguity => {
        const stored = 'A'.repeat(442) + '  ';
        const content = source.replace('Harbourmaster, who checked the dock today', stored);
        const review = captureFieldReview(content, ['role', 'voice'], 'review-drift');
        const proposal = makeProposal(review);
        proposal.fields[0] = { ...proposal.fields[0], value: stored, ambiguity };
        expect(validateFieldProposal(review, proposal)).toBe(proposal);
        expect(patchFieldProposal(review, proposal, { role: { action: ambiguity ? 'keep' : 'accept' }, voice: { action: 'accept' } }))
            .toBe(content.replace('Low and deliberate', 'Low voice'));
        if (ambiguity) expect(() => patchFieldProposal(review, proposal, { role: { action: 'accept' }, voice: { action: 'keep' } })).toThrow('ambiguous');
        else expect(patchFieldProposal(review, proposal, { role: { action: 'edit', value: stored }, voice: { action: 'keep' } })).toBe(content);
        proposal.fields[0].value = stored + 'new';
        expect(() => validateFieldProposal(review, proposal)).toThrow('bound');
        proposal.fields[0].value = stored;
        proposal.fields[0].ambiguity = '';
        expect(() => patchFieldProposal(review, proposal, { role: { action: 'edit', value: stored + 'new' }, voice: { action: 'keep' } })).toThrow('Invalid edited');
    });
    test.each(['Knowledge Ledger: ' + 'x'.repeat(442), '[Dossier] ' + 'x'.repeat(442), 'x'.repeat(442) + '\u2028injected'])('exact echoes do not bypass structural validation', stored => {
        const content = source.replace('Harbourmaster, who checked the dock today', stored);
        const review = captureFieldReview(content, ['role'], 'review-unsafe');
        const proposal = makeProposal(review);
        proposal.fields[0].value = stored;
        expect(() => validateFieldProposal(review, proposal)).toThrow();
    });
    test.each(['missing', 'duplicate', 'unknown', 'wrong-review', 'extra-key', 'bad-notes'])('rejects %s response mappings', kind => {
        const review = makeReview();
        const proposal = makeProposal(review);
        if (kind === 'missing') proposal.fields.pop();
        if (kind === 'duplicate') proposal.fields[1] = proposal.fields[0];
        if (kind === 'unknown') proposal.fields[0].key = 'canon_lock';
        if (kind === 'wrong-review') proposal.reviewId = 'other';
        if (kind === 'extra-key') proposal.removals = ['role'];
        if (kind === 'bad-notes') proposal.fields[0].displacedDetails = null;
        expect(() => validateFieldProposal(review, proposal)).toThrow();
    });
    test.each([
        source.replace('Voice:', 'Role:'),
        source.replace('Role: Harbourmaster, who checked the dock today', 'Role: Harbourmaster\r\ncontinued prose'),
        SOURCE,
    ])('refuses ambiguous field boundaries', content => {
        expect(() => captureFieldReview(content, ['role'], 'r')).toThrow();
    });
    test('recovery derivation refuses unrelated changes', () => {
        expect(() => changedFieldKeys(source, source.replace('keeper', 'different'))).toThrow();
        expect(() => fieldCleanupSpans('not a dossier')).toThrow();
    });
});