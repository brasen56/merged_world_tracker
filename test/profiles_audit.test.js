import { describe, expect, test, vi } from 'vitest';
import { auditNpcIdentities, auditProfiles, planProfilePrune, planProfileRelink } from '../knowledge/profiles_audit.js';

describe('shared Knowledge maintenance audits', () => {
    test('auditProfiles preserves the console row shape', async () => {
        const rows = await auditProfiles({
            listProfileEntries: async () => [
                { name: 'Mira', uid: 1, chars: 20, preview: 'short' },
                { name: 'Mira', uid: 2, chars: 40, preview: 'long' },
            ],
            getProfileUid: vi.fn(() => 1),
        });
        expect(rows).toEqual([
            { npc: 'Mira', uid: 1, referenced: true, duplicate: true, chars: 20, preview: 'short' },
            { npc: 'Mira', uid: 2, referenced: false, duplicate: true, chars: 40, preview: 'long' },
        ]);
    });

    test('prune planning keeps referenced entries and tags tied groups for review', () => {
        const result = planProfilePrune([
            { npc: 'Mira', uid: 1, chars: 20, referenced: true },
            { npc: 'Mira', uid: 2, chars: 40, referenced: false },
            { npc: 'Tied', uid: 3, chars: 10, referenced: false },
            { npc: 'Tied', uid: 4, chars: 10, referenced: false },
        ]);
        expect(result.toDelete).toEqual([{ npc: 'Mira', uid: 2, chars: 40, referenced: false, keptUid: 1 }]);
        expect(result.needsReview).toHaveLength(1);
        expect(result.needsReview[0]).toMatchObject({ reason: 'tied', npc: 'Tied' });
        expect(result.needsReview[0].rows.map((row) => row.uid)).toEqual([3, 4]);
    });

    test('prune planning keeps the largest entry when none is referenced', () => {
        const result = planProfilePrune([
            { npc: 'Tobin', uid: 5, chars: 90, referenced: false },
            { npc: 'tobin', uid: 6, chars: 30, referenced: false },
        ]);
        expect(result.toDelete).toEqual([expect.objectContaining({ uid: 6, keptUid: 5 })]);
        expect(result.needsReview).toEqual([]);
    });

    // Regression: listProfileEntries() reports a comment-less entry as name ''.
    // The pre-extraction console planner keyed on that raw '' and compared it
    // with '(unnamed)', so its guard never fired and the smaller of two unnamed
    // entries (possibly a different NPC's profile) was queued for deletion.
    test('unnamed profile entries are never pruned, even when sizes differ', async () => {
        const rows = await auditProfiles({
            listProfileEntries: async () => [
                { name: '', uid: 5, chars: 900, preview: 'first' },
                { name: '', uid: 8, chars: 400, preview: 'second' },
            ],
            getProfileUid: () => null,
        });
        const result = planProfilePrune(rows);
        expect(result.toDelete).toEqual([]);
        expect(result.needsReview).toHaveLength(1);
        expect(result.needsReview[0]).toMatchObject({ reason: 'unnamed', npc: '' });
        expect(result.needsReview[0].rows.map((row) => row.uid)).toEqual([5, 8]);
    });

    test('relink planning picks the largest candidate, newest on a size tie, and names a dangling pointer', async () => {
        const { planned, unmatched } = await planProfileRelink({
            registry: { Mira: { profileUid: null }, Tobin: { profileUid: 99 } },
            listProfileEntries: async () => [
                { name: 'Mira', uid: 1, chars: 20 },
                { name: 'Mira', uid: 2, chars: 20 },
                { name: 'Tobin', uid: 3, chars: 50 },
            ],
            resolveRegistryKey: (_registry, name) => name,
        });
        expect(planned).toEqual([
            { npc: 'Mira', registryKey: 'Mira', linkUid: 2, chars: 20, was: '(none)', otherCandidates: 1 },
            { npc: 'Tobin', registryKey: 'Tobin', linkUid: 3, chars: 50, was: '99 (dangling)', otherCandidates: 0 },
        ]);
        expect(unmatched).toEqual([]);
    });

    test('relink planning leaves a live link alone', async () => {
        const { planned } = await planProfileRelink({
            registry: { Mira: { profileUid: 1 } },
            listProfileEntries: async () => [{ name: 'Mira', uid: 1, chars: 20 }, { name: 'Mira', uid: 2, chars: 90 }],
            resolveRegistryKey: () => 'Mira',
        });
        expect(planned).toEqual([]);
    });

    test('relink planning returns registry-unmatched entries and skips unnamed ones', async () => {
        const result = await planProfileRelink({
            registry: { Mira: { profileUid: null } },
            listProfileEntries: async () => [{ name: 'Unknown', uid: 9, chars: 12 }, { name: '', uid: 10, chars: 5 }],
            resolveRegistryKey: () => null,
        });
        expect(result).toEqual({
            planned: [],
            unmatched: [{ npc: 'Unknown', entries: [{ name: 'Unknown', uid: 9, chars: 12 }] }],
        });
    });

    test('relink planning refuses an empty registry without reading the book', async () => {
        const listProfileEntries = vi.fn(async () => [{ name: 'Mira', uid: 1, chars: 1 }]);
        expect(await planProfileRelink({ registry: {}, listProfileEntries })).toEqual({ planned: [], unmatched: [] });
        expect(listProfileEntries).not.toHaveBeenCalled();
    });

    test('NPC audit marks untracked physical entries for manual review', async () => {
        const rows = await auditNpcIdentities({
            registry: {},
            auditRegistryAliases: () => [],
            resolveRegistryKey: () => null,
            listKnowledgeEntries: async () => [{ name: 'Mira', uid: 7, chars: 3, preview: 'facts' }],
        });
        expect(rows[0]).toMatchObject({ kind: 'untracked-entry', npc: 'Mira', uid: 7 });
    });

    test('NPC audit classifies alias groups, shorthand collisions and unlinked entries', async () => {
        const rows = await auditNpcIdentities({
            registry: {
                Sophie: { uid: 1, type: 'major' },
                'Sophie Simpson': { uid: 2, type: 'major' },
            },
            auditRegistryAliases: () => [
                {
                    kind: 'alias',
                    names: ['Sophie', 'Sophie Simpson'],
                    entries: [{ name: 'Sophie', uid: 1, type: 'major' }, { name: 'Sophie Simpson', uid: 2, type: 'major' }],
                },
                {
                    kind: 'ambiguous',
                    names: ['Mara', 'Mara Vance', 'Mara Chen'],
                    entries: [
                        { name: 'Mara', uid: 3, type: 'minor' },
                        { name: 'Mara Vance', uid: 4, type: 'major' },
                        { name: 'Mara Chen', uid: 5, type: 'major' },
                    ],
                },
            ],
            listKnowledgeEntries: async () => [
                { name: 'Sophie', uid: 1, chars: 10, preview: 'linked' },
                { name: 'sophie', uid: 6, chars: 8, preview: 'stray copy' },
            ],
            resolveRegistryKey: (_registry, name) => (name.toLowerCase() === 'sophie' ? 'Sophie' : null),
        });
        expect(rows.map((row) => [row.kind, row.npc, row.uid])).toEqual([
            ['registry-alias', 'Sophie', 1],
            ['registry-alias', 'Sophie Simpson', 2],
            ['ambiguous-name', 'Mara', 3],
            ['ambiguous-name', 'Mara Vance', 4],
            ['ambiguous-name', 'Mara Chen', 5],
            ['entry-not-linked', 'sophie', 6],
        ]);
        expect(rows[2].detail).toContain('NOT proven to be one NPC');
        expect(rows[5].detail).toContain('points at uid 1');
    });
});
