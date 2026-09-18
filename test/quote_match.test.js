import { describe, expect, test } from 'vitest';
import { findQuoteMatch, normalizeForMatch, quoteMatchesMessage } from '../core/quote_match.js';

describe('shared quote matching seam', () => {
    const message = { mes: '*The clerk pauses.* “The second seal is broken,” she says.' };

    test('normalizes harmless punctuation and formatting differences', () => {
        expect(normalizeForMatch('“SECOND seal!”')).toBe('second seal');
        expect(quoteMatchesMessage('the second seal is broken', null, message)).toBe(true);
    });

    test('rejects short or paraphrased receipts and snaps nearby cited indices', () => {
        const chat = [{ mes: 'Nothing relevant happens here.' }, message];
        expect(findQuoteMatch('seal broke', 1, chat)).toBe(-1);
        expect(findQuoteMatch('The clerk discovered a damaged stamp', 1, chat)).toBe(-1);
        expect(findQuoteMatch('the second seal is broken', 0, chat)).toBe(1);
    });

    test('rejects insertions, deletions, and reordered words instead of fuzzy-matching them', () => {
        const quote = 'alpha beta gamma delta epsilon zeta';
        const strict = { allowInterposition: false };
        expect(quoteMatchesMessage(quote, null, { mes: 'alpha beta gamma unrelated delta epsilon zeta' }, strict)).toBe(false);
        expect(quoteMatchesMessage(quote, null, { mes: 'alpha beta gamma epsilon zeta' }, strict)).toBe(false);
        expect(quoteMatchesMessage(quote, null, { mes: 'alpha beta delta gamma epsilon zeta' }, strict)).toBe(false);
    });

    test('preserves Knowledge matching for a verbatim quote split by a dialogue tag', () => {
        const split = { mes: '“I cannot tell you,” she whispered, “where the key is hidden.”' };
        const quote = 'I cannot tell you where the key is hidden';
        expect(quoteMatchesMessage(quote, null, split)).toBe(true);
        expect(findQuoteMatch(quote, 0, [split])).toBe(0);
        expect(findQuoteMatch(quote, 0, [split], { allowInterposition: false })).toBe(-1);
    });

    test('never treats an ILS summary paraphrase as a quotable source', () => {
        const summary = {
            mes: 'The clerk found that the second seal was broken.',
            extra: { ILS_Data: { Ref: 'stored-originals' } },
        };
        expect(quoteMatchesMessage('the second seal was broken', null, summary)).toBe(false);
        expect(findQuoteMatch('the second seal was broken', 0, [summary])).toBe(-1);
    });
});