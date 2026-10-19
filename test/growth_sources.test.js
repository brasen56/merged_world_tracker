import { describe, test, expect } from 'vitest';
import { verifyGrowthObservations } from '../knowledge/growth_sources.js';

describe('Shared Growth source verification', () => {
    test.each([null, 7])('unmatched quotes retain cited provenance with live index %s', liveIndex => {
        const sources = [{ msg: { id: 'original', mes: 'I will keep my promise.', send_date: '2026-01-01' },
            promptIndex: 0, liveIndex, ts: 12345 }];
        const [result] = verifyGrowthObservations([
            { claim: 'Keeps promises', quote: 'An entirely invented quotation.', msgIdx: 0 },
        ], sources);
        expect(result).toMatchObject({ verified: false, msgIdx: liveIndex, ts: 12345, sourceIdentity: 'id:original' });
    });
    test('invalid citations do not become live-chat references', () => {
        const [result] = verifyGrowthObservations([
            { claim: 'Keeps promises', quote: 'An entirely invented quotation.', msgIdx: 99 },
        ], [{ msg: { mes: 'I will keep my promise.' }, promptIndex: 0, liveIndex: 7 }]);
        expect(result).toMatchObject({ verified: false, msgIdx: null });
        expect(result.sourceIdentity).toBeUndefined();
    });
    test('a quote match overrides an incorrect citation', () => {
        const sources = [
            { msg: { mes: 'A completely different message.' }, promptIndex: 0, liveIndex: 7 },
            { msg: { id: 'matched', mes: 'I will keep my promise.' }, promptIndex: 1, liveIndex: 8, ts: 12345 },
        ];
        expect(verifyGrowthObservations([
            { claim: 'Keeps promises', quote: 'I will keep my promise.', msgIdx: 0 },
        ], sources)[0]).toMatchObject({ verified: true, msgIdx: 8, ts: 12345, sourceIdentity: 'id:matched' });
    });
    test('recovered originals own timestamps, not the summary container', () => {
        const sources = [{ msg: { mes: 'I will keep my promise.', send_date: '2026-01-01' },
            promptIndex: 40, liveIndex: null, ts: 12345 }];
        const result = verifyGrowthObservations([{ claim: 'Keeps promises', quote: 'I will keep my promise.', msgIdx: 40 }], sources);
        expect(result[0]).toMatchObject({ verified: true, msgIdx: null, ts: 12345 });
        expect(result[0].sourceIdentity).toContain('original');
    });
    test('summary text cannot verify and absent quotes stay flagged', () => {
        const sources = [{ msg: { mes: 'I will keep my promise.', extra: { ILS_Data: {} } }, promptIndex: 0 }];
        expect(verifyGrowthObservations([{ claim: 'Keeps promises', quote: 'I will keep my promise.', msgIdx: 0 }], sources)[0].verified).toBe(false);
    });
});