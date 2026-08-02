/**
 * test/relationships.test.js — The managed relationship block.
 *
 * The properties worth protecting:
 *   1. The stance line keeps its exact label. Presets match on that prefix to
 *      decide how far an NPC may push {{user}}; reword it and the gate silently
 *      stops firing, which reads as "the extension does nothing".
 *   2. Stance and edges share one block, and either one alone still produces
 *      a block — an NPC can have a stance and no relationships.
 *   3. An NPC with neither produces no block, so sync strips it rather than
 *      leaving an empty husk in the lorebook entry.
 *   4. Renames carry the stance across, or it silently reverts to inferred.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getLorebookName } from '../knowledge/scope.js';
import { USER_STANCES } from '../knowledge/state.js';
import {
    updateRelationship, removeRelationship, removeAllRelationshipsFor,
    getStance, setStance, getStances, rekeyRelationships,
    formatRelationshipBlock, injectRelationshipBlock, stripRelationshipBlock,
} from '../knowledge/relationships.js';

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    // Mark the knowledge book hydrated so writes are accepted without a
    // fake lorebook behind them; flushes then no-op with a warning.
    _setCacheForTests(getLorebookName(), {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ─── Stance ─────────────────────────────────────────────────────────────────

describe('stance toward {{user}}', () => {
    test('emits the exact label presets gate on', () => {
        setStance('Mara', 'wary');
        // If this string changes, the preset's YIELD rule stops matching.
        expect(formatRelationshipBlock('Mara')).toBe('Stance toward {{user}}: wary.');
    });

    test('stance and edges coexist, stance first', () => {
        setStance('Mara', 'caring');
        updateRelationship('Mara', 'Jonah', 'friend', 'met at work');
        expect(formatRelationshipBlock('Mara')).toBe(
            'Stance toward {{user}}: caring.\n'
            + 'Relationships: friend of Jonah (met at work).',
        );
    });

    test('edges alone still produce a block', () => {
        updateRelationship('Mara', 'Jonah', 'rival', '');
        expect(formatRelationshipBlock('Mara')).toBe('Relationships: rival of Jonah.');
    });

    test('an NPC with neither produces no block', () => {
        // Falsy return is what makes syncRelationshipsToLorebook strip instead
        // of injecting an empty block.
        expect(formatRelationshipBlock('Nobody')).toBe('');
    });

    test('clearing a stance drops only that line', () => {
        setStance('Mara', 'hostile');
        updateRelationship('Mara', 'Jonah', 'enemy', '');
        setStance('Mara', '');
        expect(getStance('Mara')).toBe('');
        expect(getStances()).not.toHaveProperty('Mara');
        expect(formatRelationshipBlock('Mara')).toBe('Relationships: enemy of Jonah.');
    });

    test('removing every edge leaves the stance line standing', () => {
        setStance('Mara', 'friendly');
        updateRelationship('Mara', 'Jonah', 'friend', '');
        removeRelationship('Mara', 'Jonah');
        expect(formatRelationshipBlock('Mara')).toBe('Stance toward {{user}}: friendly.');
    });

    test('removeAllRelationshipsFor leaves stance alone', () => {
        // Stance is cleared explicitly at the NPC-delete site, not here — this
        // pins the narrower contract the function name promises.
        setStance('Mara', 'wary');
        updateRelationship('Mara', 'Jonah', 'friend', '');
        removeAllRelationshipsFor('Mara');
        expect(getStance('Mara')).toBe('wary');
    });

    test('every enum value round-trips', () => {
        for (const s of USER_STANCES) {
            setStance('Mara', s);
            expect(getStance('Mara')).toBe(s);
            expect(formatRelationshipBlock('Mara')).toBe(`Stance toward {{user}}: ${s}.`);
        }
    });
});

// ─── Rename ─────────────────────────────────────────────────────────────────

describe('rekeyRelationships', () => {
    test('carries the stance to the new name', () => {
        setStance('Mara', 'wary');
        updateRelationship('Mara', 'Jonah', 'friend', '');
        rekeyRelationships('Mara', 'Mara Vance');
        expect(getStance('Mara')).toBe('');
        expect(getStance('Mara Vance')).toBe('wary');
        expect(formatRelationshipBlock('Mara Vance')).toBe(
            'Stance toward {{user}}: wary.\nRelationships: friend of Jonah.',
        );
    });

    test('a rename to the same name is a no-op', () => {
        setStance('Mara', 'caring');
        rekeyRelationships('Mara', 'Mara');
        expect(getStance('Mara')).toBe('caring');
    });

    test('renaming an NPC with no stance does not invent one', () => {
        updateRelationship('Mara', 'Jonah', 'friend', '');
        rekeyRelationships('Mara', 'Mara Vance');
        expect(getStances()).not.toHaveProperty('Mara Vance');
    });
});

// ─── Managed block round-trip ───────────────────────────────────────────────

describe('inject/strip round-trip', () => {
    test('a stance block replaces cleanly on re-sync', () => {
        const entry = 'Mara is a locksmith.';
        setStance('Mara', 'caring');
        const once = injectRelationshipBlock(entry, formatRelationshipBlock('Mara'));
        expect(once).toContain('Stance toward {{user}}: caring.');

        // Second sync must replace, not append — otherwise stale stances stack
        // up in the entry and the model sees two contradictory lines.
        setStance('Mara', 'hostile');
        const twice = injectRelationshipBlock(once, formatRelationshipBlock('Mara'));
        expect(twice).toContain('Stance toward {{user}}: hostile.');
        expect(twice).not.toContain('caring');
        expect(stripRelationshipBlock(twice)).toBe(entry);
    });
});
