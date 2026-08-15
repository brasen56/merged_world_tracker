/**
 * test/interiority_evaluated_npcs.test.js — getEvaluatedNpcNames must never
 * throw on the paths that don't report an evaluated roster.
 *
 * THE BUG (1.6.0, found before it was reported): getEvaluatedNpcNames built its
 * fallback `responseNames` as a Set, then did
 *
 *     const candidates = Array.isArray(reportedNames) ? reportedNames : responseNames;
 *     candidates.map(...)
 *
 * Only runStrictCalls returns `intentionsEvaluatedRoster`, so strict mode passed
 * an array and survived. The batched (default) and split paths pass nothing, hit
 * the Set fallback, and threw `candidates.map is not a function` — caught by the
 * generateForCurrentMessage try/catch, so every turn silently produced no
 * thoughts, no intentions, and no ledger write for the majority of users.
 *
 * These tests pin the fallback to an array and cover the wake-confirmation
 * contract that depends on it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { getEvaluatedNpcNames } from '../interiority/index.js';

beforeEach(() => {
    resetCoreStubs();
    globalThis.document = {
        dispatchEvent: vi.fn(),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
});

const ROSTER = ['Mara', 'Tomas'];

describe('getEvaluatedNpcNames — no reported roster (batched + split paths)', () => {
    test('infers the evaluated set from the response instead of throwing', () => {
        const result = { npcs: [{ name: 'Mara' }, { name: 'Tomas' }] };
        // The regression: this call passes two args, exactly as the split path
        // and the batched path (result.intentionsEvaluatedRoster === undefined) do.
        expect(getEvaluatedNpcNames(result, ROSTER)).toEqual(['Mara', 'Tomas']);
    });

    test('an explicitly undefined third argument behaves the same', () => {
        const result = { npcs: [{ name: 'Mara' }] };
        expect(getEvaluatedNpcNames(result, ROSTER, undefined)).toEqual(['Mara']);
    });

    test('returns canonical roster casing, not the model\'s casing', () => {
        const result = { npcs: [{ name: 'mara' }, { name: '  TOMAS  ' }] };
        expect(getEvaluatedNpcNames(result, ROSTER)).toEqual(['Mara', 'Tomas']);
    });

    test('drops names that are not on the roster', () => {
        const result = { npcs: [{ name: 'Mara' }, { name: 'Stranger' }] };
        expect(getEvaluatedNpcNames(result, ROSTER)).toEqual(['Mara']);
    });

    test('dedupes repeated names in the response', () => {
        const result = { npcs: [{ name: 'Mara' }, { name: 'mara' }, { name: 'Mara' }] };
        expect(getEvaluatedNpcNames(result, ROSTER)).toEqual(['Mara']);
    });
});

describe('getEvaluatedNpcNames — reported roster wins (strict path)', () => {
    test('uses reportedNames even when the response names differ', () => {
        const result = { npcs: [{ name: 'Mara' }, { name: 'Tomas' }] };
        expect(getEvaluatedNpcNames(result, ROSTER, ['Tomas'])).toEqual(['Tomas']);
    });

    test('an empty reported roster means nothing was evaluated', () => {
        const result = { npcs: [{ name: 'Mara' }] };
        expect(getEvaluatedNpcNames(result, ROSTER, [])).toEqual([]);
    });
});

describe('getEvaluatedNpcNames — malformed input is inert, never fatal', () => {
    test.each([
        ['null result', null],
        ['undefined result', undefined],
        ['no npcs key', {}],
        ['npcs is not an array', { npcs: 'Mara' }],
        ['npcs is an object', { npcs: { name: 'Mara' } }],
    ])('%s returns an empty array', (_label, result) => {
        expect(getEvaluatedNpcNames(result, ROSTER)).toEqual([]);
    });

    test('entries with missing or blank names are skipped', () => {
        const result = { npcs: [{ name: '' }, {}, null, { name: '   ' }, { name: 'Mara' }] };
        expect(getEvaluatedNpcNames(result, ROSTER)).toEqual(['Mara']);
    });

    test('an empty roster resolves nothing', () => {
        expect(getEvaluatedNpcNames({ npcs: [{ name: 'Mara' }] }, [])).toEqual([]);
    });
});

describe('the wake-confirmation contract that consumes the result', () => {
    test('the returned value is directly .map()-able by the caller', () => {
        // generateForCurrentMessage does exactly this to build the lowercase
        // Set it matches dormant-wake proposals against.
        const evaluated = getEvaluatedNpcNames({ npcs: [{ name: 'Mara' }] }, ROSTER);
        const lowered = new Set(evaluated.map(name => String(name).toLowerCase().trim()));
        expect(lowered.has('mara')).toBe(true);
        expect(lowered.has('tomas')).toBe(false);
    });
});
