import { describe, expect, test, vi } from 'vitest';
import { collectGuardedMaintenanceFindings, collectMaintenanceFindings } from '../dashboard/maintenance.js';

// Every source stubbed and clean, so no test reaches the real stores.
const clean = {
    listProfileEntries: async () => [],
    auditProfiles: async () => [],
    planProfileRelink: async () => ({ planned: [], unmatched: [] }),
    auditNpcIdentities: async () => [],
    getRegistry: () => ({ Mira: {} }),
    getDeletedIntentions: () => [],
};

describe('Overview maintenance findings', () => {
    test('a clean chat produces no findings', async () => {
        expect(await collectMaintenanceFindings(clean)).toEqual([]);
    });

    test('reports each non-empty audit in a stable order', async () => {
        const findings = await collectMaintenanceFindings({
            ...clean,
            auditProfiles: async () => [
                { npc: 'Mira', uid: 1, chars: 20, referenced: true, duplicate: true },
                { npc: 'Mira', uid: 2, chars: 40, referenced: false, duplicate: true },
            ],
            planProfileRelink: async () => ({ planned: [{ npc: 'Tobin', otherCandidates: 2 }], unmatched: [] }),
            auditNpcIdentities: async () => [{ kind: 'untracked-entry', npc: 'Mira' }],
            getDeletedIntentions: () => [{ id: 1 }],
        });
        expect(findings.map((finding) => finding.kind)).toEqual([
            'duplicate-profiles', 'relink-candidates', 'npc-identity-audit', 'deleted-intentions',
        ]);
    });

    test('duplicate profiles count NPC groups, not entries, and tag hand-review groups', async () => {
        const [finding] = await collectMaintenanceFindings({
            ...clean,
            auditProfiles: async () => [
                { npc: '', uid: 5, chars: 900, referenced: false, duplicate: true },
                { npc: '', uid: 8, chars: 400, referenced: false, duplicate: true },
                { npc: 'Mira', uid: 1, chars: 20, referenced: true, duplicate: true },
                { npc: 'Mira', uid: 2, chars: 40, referenced: false, duplicate: true },
                { npc: 'Tied', uid: 3, chars: 10, referenced: false, duplicate: true },
                { npc: 'Tied', uid: 4, chars: 10, referenced: false, duplicate: true },
                { npc: 'Solo', uid: 9, chars: 10, referenced: true, duplicate: false },
            ],
        });
        expect(finding).toMatchObject({
            kind: 'duplicate-profiles',
            count: 3,
            entries: 6,
            pruneCount: 1,
            prunableNpcs: ['Mira'],
            review: [
                { reason: 'unnamed', npc: '', count: 2 },
                { reason: 'tied', npc: 'Tied', count: 2 },
            ],
        });
    });

    test('relink findings separate automatic links from registry-unmatched profiles', async () => {
        const [finding] = await collectMaintenanceFindings({
            ...clean,
            planProfileRelink: async () => ({
                planned: [{ npc: 'Mira', otherCandidates: 1 }, { npc: 'Tobin', otherCandidates: 0 }],
                unmatched: [{ npc: 'Ghost', entries: [{ uid: 9 }] }],
            }),
        });
        expect(finding).toMatchObject({
            kind: 'relink-candidates',
            count: 3,
            relinkNpcs: ['Mira', 'Tobin'],
            withOtherCandidates: 1,
            unmatched: [{ npc: 'Ghost', count: 1 }],
        });
    });

    test('identity findings count by kind and flag an empty registry', async () => {
        const [finding] = await collectMaintenanceFindings({
            ...clean,
            getRegistry: () => ({}),
            auditNpcIdentities: async () => [
                { kind: 'untracked-entry', npc: 'Mira' },
                { kind: 'untracked-entry', npc: 'Tobin' },
                { kind: 'ambiguous-name', npc: 'Mara' },
            ],
        });
        expect(finding).toMatchObject({
            kind: 'npc-identity-audit',
            count: 3,
            byKind: { 'untracked-entry': 2, 'ambiguous-name': 1 },
            registryEmpty: true,
        });
    });

    test('reads the profiles book once for both profile audits', async () => {
        const listProfileEntries = vi.fn(async () => []);
        await collectMaintenanceFindings({
            ...clean,
            listProfileEntries,
            auditProfiles: async ({ listProfileEntries: list }) => { await list(); return []; },
            planProfileRelink: async ({ listProfileEntries: list }) => { await list(); return { planned: [], unmatched: [] }; },
        });
        expect(listProfileEntries).toHaveBeenCalledTimes(1);
    });

    test('guarded collector returns an isolated error finding without blanking callers', async () => {
        const result = await collectGuardedMaintenanceFindings({
            ...clean,
            auditProfiles: vi.fn(async () => { throw new Error('profile book unavailable'); }),
        });
        expect(result.ok).toBe(true);
        expect(result.value).toEqual([{
            kind: 'maintenance-error',
            source: 'profile audit',
            error: 'profile book unavailable',
        }]);
    });

    test('isolates failed audits and still returns independent findings', async () => {
        const findings = await collectMaintenanceFindings({
            ...clean,
            auditProfiles: async () => { throw new Error('profile book unavailable'); },
            planProfileRelink: async () => { throw new Error('registry unavailable'); },
            auditNpcIdentities: async () => { throw new Error('knowledge book unavailable'); },
            getDeletedIntentions: () => [{ id: 'deleted-1' }],
        });
        expect(findings.at(-1)).toMatchObject({ kind: 'deleted-intentions', count: 1 });
        expect(findings.filter((finding) => finding.kind === 'maintenance-error')).toHaveLength(3);
    });
});
