/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { applyPrunePlan, applyRelinkPlan, collectGuardedMaintenanceFindings, collectMaintenanceFindings, maintenanceActions } from '../dashboard/maintenance.js';
import { renderOverviewPane, wireOverviewPane } from '../dashboard/render.js';
import { hideModal } from '../core/modal.js';
import { bumpEpoch, captureScope, _resetEpoch } from '../core/scope.js';
import { resetCoreStubs, setFakeChat } from './stubs/core.js';
import { appendRawObservations, getEvidenceMap } from '../knowledge/evidence.js';
import { addLedgerEntry, getDeletedIntentions, removeLedgerEntries } from '../interiority/data.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { saveSettings as saveKnowledgeSettings } from '../knowledge/settings.js';

// Every source stubbed and clean, so no test reaches the real stores.
const clean = {
    listProfileEntries: async () => [],
    auditProfiles: async () => [],
    planProfileRelink: async () => ({ planned: [], unmatched: [] }),
    auditNpcIdentities: async () => [],
    getRegistry: () => ({ Mira: {} }),
    getDeletedIntentions: () => [],
};

// The Phase 4 write guards route their scope checks through the real
// core/scope.js capture/assert pair, which falls back to the SillyTavern
// global when called without a context — so give it a verifiable identity
// (the test/backup.test.js precedent) and reset every module singleton
// between tests.
beforeEach(() => {
    document.body.innerHTML = '';
    resetCoreStubs();
    _clearCacheForTests();
    _resetEpoch();
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-a' }) };
});

afterEach(() => {
    // Close the tool modal while the DOM still exists so the shared modal
    // stack's body watcher disconnects instead of firing during teardown.
    hideModal('mwt-overview-tool-modal');
    _clearCacheForTests();
    _resetEpoch();
    delete globalThis.SillyTavern;
});

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
        });
        expect(findings.map((finding) => finding.kind)).toEqual([
            'duplicate-profiles', 'relink-candidates', 'npc-identity-audit',
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
        });
        expect(findings.filter((finding) => finding.kind === 'maintenance-error')).toHaveLength(3);
    });

    test('refuses to apply a prune plan when the fresh plan differs', async () => {
        const deleteEntries = vi.fn();
        const result = await applyPrunePlan({
            previewRows: [{ uid: 1, keptUid: 2 }],
            audit: async () => [],
            deleteEntries,
        });
        expect(result).toMatchObject({ ok: false });
        expect(deleteEntries).not.toHaveBeenCalled();
    });

    test('re-plans relinking and applies only an unchanged plan', async () => {
        const setUid = vi.fn();
        const flush = vi.fn(async () => true);
        const plan = vi.fn(async () => ({ planned: [{ npc: 'Mira', registryKey: 'Mira', linkUid: 4, was: '(none)' }], unmatched: [] }));
        const result = await applyRelinkPlan({
            previewRows: [{ npc: 'Mira', registryKey: 'Mira', linkUid: 4, was: '(none)' }],
            registry: { Mira: {} }, listProfileEntries: async () => [], plan, setUid, flush, bookName: 'Profiles',
        });
        expect(result).toEqual({ success: true, applied: 1 });
        expect(setUid).toHaveBeenCalledWith('Mira', 4);
        expect(flush).toHaveBeenCalledWith('Profiles');
    });
});

// ─── Phase 4 write guards ─────────────────────────────────────────────────────
// The safety paths added with the preview→confirm modals: re-plan at confirm,
// refuse on a chat switch at either checkpoint, refuse on a failed underlying
// write, and never apply a previewed plan twice (plan §5 Phase 4 acceptance).

describe('applyPrunePlan write guards', () => {
    const previewRows = [{ npc: 'Mira', uid: 2, keptUid: 1 }];
    const auditRows = [
        { npc: 'Mira', uid: 1, chars: 10, referenced: true, duplicate: true },
        { npc: 'Mira', uid: 2, chars: 10, referenced: false, duplicate: true },
    ];

    test('refuses when the chat changed before the confirm, before any re-plan', async () => {
        const audit = vi.fn(async () => auditRows);
        const deleteEntries = vi.fn();
        const scopeToken = captureScope();
        bumpEpoch(); // the user switched chats while the preview sat open
        const result = await applyPrunePlan({ previewRows, audit, deleteEntries, scopeToken });
        expect(result).toEqual({ ok: false, reason: 'The chat changed. Review a fresh preview before applying.' });
        expect(audit).not.toHaveBeenCalled();
        expect(deleteEntries).not.toHaveBeenCalled();
    });

    test('refuses when the chat changes during the re-plan, before deleting', async () => {
        const audit = vi.fn(async () => { bumpEpoch(); return auditRows; });
        const deleteEntries = vi.fn(async () => ({ success: true }));
        const result = await applyPrunePlan({ previewRows, audit, deleteEntries, scopeToken: captureScope() });
        expect(result).toEqual({ ok: false, reason: 'The chat changed. Review a fresh preview before applying.' });
        expect(deleteEntries).not.toHaveBeenCalled();
    });

    test('applies a still-matching plan under an unchanged scope', async () => {
        const deleteEntries = vi.fn(async () => ({ success: true, deleted: 1 }));
        const result = await applyPrunePlan({
            previewRows,
            audit: async () => auditRows,
            plan: () => ({ toDelete: previewRows }),
            deleteEntries,
            scopeToken: captureScope(),
        });
        expect(result).toMatchObject({ ok: true });
        expect(deleteEntries).toHaveBeenCalledWith([2]);
    });

    test('surfaces a failed delete result with its error, or a fallback reason', async () => {
        const deps = { previewRows, audit: async () => auditRows, plan: () => ({ toDelete: previewRows }) };
        const refused = await applyPrunePlan({ ...deps, deleteEntries: async () => ({ ok: false, error: 'book locked' }) });
        expect(refused).toEqual({ ok: false, reason: 'book locked' });
        const silent = await applyPrunePlan({ ...deps, deleteEntries: async () => ({ success: false }) });
        expect(silent).toEqual({ ok: false, reason: 'Profile entries could not be deleted.' });
    });
});

describe('applyRelinkPlan write guards', () => {
    const previewRows = [{ npc: 'Mira', registryKey: 'Mira', linkUid: 4, was: '(none)' }];
    const base = { registry: { Mira: {} }, listProfileEntries: async () => [], bookName: 'Profiles' };
    const freshPlan = async () => ({ planned: previewRows, unmatched: [] });

    test('refuses when the chat changed before the confirm', async () => {
        const plan = vi.fn(freshPlan);
        const scopeToken = captureScope();
        bumpEpoch();
        const result = await applyRelinkPlan({ ...base, previewRows, plan, scopeToken });
        expect(result).toEqual({ ok: false, reason: 'The chat changed. Review a fresh preview before applying.' });
        expect(plan).not.toHaveBeenCalled();
    });

    test('refuses when the chat changes during the re-plan', async () => {
        const plan = vi.fn(async () => { bumpEpoch(); return { planned: previewRows, unmatched: [] }; });
        const setUid = vi.fn(() => true);
        const result = await applyRelinkPlan({ ...base, previewRows, plan, setUid, flush: async () => true, scopeToken: captureScope() });
        expect(result).toEqual({ ok: false, reason: 'The chat changed. Review a fresh preview before applying.' });
        expect(setUid).not.toHaveBeenCalled();
    });

    test('applies the unchanged plan under an unchanged scope', async () => {
        const setUid = vi.fn(() => true);
        const flush = vi.fn(async () => true);
        const result = await applyRelinkPlan({ ...base, previewRows, plan: freshPlan, setUid, flush, scopeToken: captureScope() });
        expect(result).toEqual({ success: true, applied: 1 });
        expect(setUid).toHaveBeenCalledWith('Mira', 4);
        expect(flush).toHaveBeenCalledWith('Profiles');
    });

    test('stops at the first registry write that fails, without flushing', async () => {
        const setUid = vi.fn(() => false);
        const flush = vi.fn(async () => true);
        const result = await applyRelinkPlan({ ...base, previewRows, plan: freshPlan, setUid, flush });
        expect(result).toEqual({ ok: false, reason: 'Could not record the profile link for Mira.' });
        expect(flush).not.toHaveBeenCalled();
    });

    test('reports a failed lorebook flush', async () => {
        const result = await applyRelinkPlan({ ...base, previewRows, plan: freshPlan, setUid: () => true, flush: async () => false });
        expect(result).toEqual({ ok: false, reason: 'The Knowledge lorebook could not be saved.' });
    });
});

describe('maintenanceActions clear tools', () => {
    test('clearAllEvidence resets every file and stays quiet with nothing registry-backed', () => {
        setFakeChat([{ send_date: '2026-01-01T00:00:00.000Z' }]);
        appendRawObservations('Mira', [{ category: 'trait', claim: 'brave', quote: '"she charged"', msgIdx: 0 }]);
        appendRawObservations('Tobin', [{ category: 'trait', claim: 'cautious', quote: '"he hesitated"', msgIdx: 1 }]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = maintenanceActions.clearAllEvidence();
        expect(result).toEqual({ ok: true, count: 2, orphaned: [] });
        expect(warn).not.toHaveBeenCalled();
        // The tiers are wiped but every NPC stays enrolled in continuous capture.
        const map = getEvidenceMap();
        expect(map.Mira.raw).toEqual([]);
        expect(map.Mira.enrolled).toBe(true);
        warn.mockRestore();
    });

    test('clearAllEvidence warns when registry-backed profiles lose their evidence', () => {
        setFakeChat([{ send_date: '2026-01-01T00:00:00.000Z' }]);
        appendRawObservations('Mira', [{ category: 'trait', claim: 'brave', quote: '"she charged"', msgIdx: 0 }]);
        saveKnowledgeSettings({ scope: 'global' });
        _setCacheForTests('Knowledge Tracker', { registry: { Mira: { profileUid: 4 } } });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = maintenanceActions.clearAllEvidence();
        expect(result).toEqual({ ok: true, count: 1, orphaned: ['Mira'] });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('UNBACKED');
        warn.mockRestore();
    });

    test('clearDeletedIntentions forgets tombstones through the shared action', () => {
        const entry = addLedgerEntry({ npc: 'Ezra', action: 'call Dorothy', trigger: 'Monday morning' }, 'day 1', 3);
        removeLedgerEntries([entry.id], { tombstone: true });
        expect(getDeletedIntentions()).toHaveLength(1);
        expect(maintenanceActions.clearDeletedIntentions()).toBe(1);
        expect(getDeletedIntentions()).toHaveLength(0);
    });
});

describe('Overview tool confirmation modals', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const modal = () => document.getElementById('mwt-overview-tool-modal');
    const confirmButton = () => modal()?.querySelector('[data-tool-confirm]');
    const statusText = () => modal()?.querySelector('.mwt-status')?.textContent || '';
    const paneOf = (root) => root.querySelector('.mwt-tab-content[data-tab="overview"]');

    const snapshot = (overrides = {}) => ({
        worldState: { ok: true, value: { kind: 'stale', msgsSinceRefresh: 3 } },
        staging: { ok: true, value: 3 },
        growthEvidence: { ok: true, value: 1 },
        beats: { ok: true, value: { awaiting: 2, overdue: 1 } },
        intentions: { ok: true, value: { active: [{ id: 1 }], dormant: [] } },
        budget: { ok: true, value: { injectedTokens: 120, contextLimit: 1000, enforce: false } },
        coordinator: { ok: true, value: { running: [], queued: [] } },
        health: { ok: true, value: { modules: [{ id: 'world_state', label: 'World State', busy: false, enabled: true }] } },
        deletedIntentions: { ok: true, value: [] },
        quarantine: { ok: true, value: { total: 0 } },
        ...overrides,
    });

    const pruneFinding = (toDelete = [{ npc: 'Mira', uid: 2, keptUid: 1 }]) => ({
        kind: 'duplicate-profiles', count: 1, entries: 2, pruneCount: toDelete.length,
        prunableNpcs: toDelete.map((row) => row.npc),
        review: toDelete.length ? [] : [{ reason: 'unnamed', npc: '', count: 2 }],
        toDelete, command: 'MWT.profiles.pruneDuplicates()', rows: toDelete,
    });

    const relinkFinding = () => ({
        kind: 'relink-candidates', count: 1, relinkNpcs: ['Mira'], withOtherCandidates: 0, unmatched: [],
        command: 'MWT.profiles.relink()',
        rows: [{ npc: 'Mira', registryKey: 'Mira', linkUid: 4, was: '(none)' }],
    });

    /** Mount the Overview pane with every Phase 4 dependency stubbed. */
    function mountOverviewPane(options = {}) {
        const collect = options.collect ?? (() => snapshot());
        const root = document.createElement('div');
        root.innerHTML = `<button id="mwt-tab-knowledge"></button><div class="mwt-tab-content" data-tab="overview">${renderOverviewPane({ collect })}</div>`;
        document.body.append(root);
        wireOverviewPane(root, {
            collect,
            collectMaintenance: async () => ({ ok: true, value: [] }),
            collectTools: () => ({ evidenceNames: [], deletionCount: 0 }),
            actions: {
                clearAllEvidence: vi.fn(async () => ({ ok: true, count: 0, orphaned: [] })),
                clearDeletedIntentions: vi.fn(() => ({ ok: true, count: 0 })),
            },
            prune: vi.fn(async () => ({ ok: true })),
            relink: vi.fn(async () => ({ success: true, applied: 1 })),
            ...options,
        });
        return root;
    }

    test('prune: confirm applies the previewed rows and auto-refreshes the pane', async () => {
        let staging = 3;
        const collect = vi.fn(() => snapshot({ staging: { ok: true, value: staging } }));
        const prune = vi.fn(async () => { staging = 9; return { ok: true }; });
        const root = mountOverviewPane({ collect, prune, collectMaintenance: async () => ({ ok: true, value: [pruneFinding()] }) });
        await flush(); // the findings host renders and wires asynchronously
        root.querySelector('[data-maintenance-action="prune"]').click();
        expect(modal().textContent).toContain('Only automatically safe duplicate entries are deleted');
        expect(confirmButton().disabled).toBe(false);
        confirmButton().click();
        await flush();
        expect(prune).toHaveBeenCalledTimes(1);
        // Applied with the previewed rows plus the scope token captured at preview time.
        expect(prune.mock.calls[0][0].previewRows).toEqual([{ npc: 'Mira', uid: 2, keptUid: 1 }]);
        expect(prune.mock.calls[0][0].scopeToken.identity.key).toBe('chat:chat-a');
        expect(statusText()).toContain('Applied');
        // One-shot: a completed confirmation cannot fire again.
        expect(confirmButton().disabled).toBe(true);
        confirmButton().click();
        expect(prune).toHaveBeenCalledTimes(1);
        // Automatic pane refresh: the pane re-rendered from a fresh collect.
        expect(collect).toHaveBeenCalledTimes(2);
        expect(paneOf(root).textContent).toContain('9 items pending staging');
    });

    test('prune: a refusal names its reason, re-enables confirm, and skips the refresh', async () => {
        const collect = vi.fn(() => snapshot());
        const prune = vi.fn(async () => ({ ok: false, reason: 'The profile book changed. Review a fresh preview before applying.' }));
        const root = mountOverviewPane({ collect, prune, collectMaintenance: async () => ({ ok: true, value: [pruneFinding()] }) });
        await flush();
        root.querySelector('[data-maintenance-action="prune"]').click();
        confirmButton().click();
        await flush();
        expect(statusText()).toContain('The profile book changed');
        expect(confirmButton().disabled).toBe(false); // refused ≠ completed — the user can retry
        expect(collect).toHaveBeenCalledTimes(1);      // no automatic refresh on refusal
        expect(paneOf(root).textContent).toContain('3 items pending staging');
    });

    test('prune: a double-click while applying applies once (busy + one-shot guards)', async () => {
        let settle;
        const prune = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
        const root = mountOverviewPane({ prune, collectMaintenance: async () => ({ ok: true, value: [pruneFinding()] }) });
        await flush();
        root.querySelector('[data-maintenance-action="prune"]').click();
        confirmButton().click();          // the busy-guard disables the control synchronously
        expect(confirmButton().disabled).toBe(true);
        confirmButton().click();          // a disabled control never dispatches the click
        expect(prune).toHaveBeenCalledTimes(1);
        settle({ ok: true });
        await flush();
        confirmButton().click();          // completed actions stay one-shot
        expect(prune).toHaveBeenCalledTimes(1);
        expect(confirmButton().disabled).toBe(true);
    });

    test('prune: hand-review-only findings preview as not actionable', async () => {
        const root = mountOverviewPane({ collectMaintenance: async () => ({ ok: true, value: [pruneFinding([])] }) });
        await flush();
        root.querySelector('[data-maintenance-action="prune"]').click();
        expect(modal().textContent).toContain('No actionable changes found');
        expect(confirmButton().disabled).toBe(true);
    });

    test('relink: confirm applies the previewed rows', async () => {
        const relink = vi.fn(async () => ({ success: true, applied: 1 }));
        const root = mountOverviewPane({ relink, collectMaintenance: async () => ({ ok: true, value: [relinkFinding()] }) });
        await flush();
        root.querySelector('[data-maintenance-action="relink"]').click();
        expect(modal().textContent).toContain('The registry pointers will be changed');
        confirmButton().click();
        await flush();
        expect(relink).toHaveBeenCalledTimes(1);
        expect(relink.mock.calls[0][0].previewRows).toEqual([{ npc: 'Mira', registryKey: 'Mira', linkUid: 4, was: '(none)' }]);
        expect(statusText()).toContain('Applied');
    });

    test('relink: a refusal surfaces its reason without a pane refresh', async () => {
        const collect = vi.fn(() => snapshot());
        const relink = vi.fn(async () => ({ ok: false, reason: 'The Knowledge lorebook could not be saved.' }));
        const root = mountOverviewPane({ collect, relink, collectMaintenance: async () => ({ ok: true, value: [relinkFinding()] }) });
        await flush();
        root.querySelector('[data-maintenance-action="relink"]').click();
        confirmButton().click();
        await flush();
        expect(statusText()).toContain('could not be saved');
        expect(collect).toHaveBeenCalledTimes(1);
    });

    test('clear-deletions: two-step confirm applies the action and refreshes the tools inventory', async () => {
        const clearDeletedIntentions = vi.fn(() => ({ ok: true, count: 2 }));
        const collectTools = vi.fn(() => ({ evidenceNames: [], deletionCount: 2 }));
        const root = mountOverviewPane({ collectTools, actions: { clearAllEvidence: vi.fn(), clearDeletedIntentions } });
        await flush(); // the tools disclosure renders and wires asynchronously
        root.querySelector('[data-maintenance-action="clear-deletions"]').click();
        await flush(); // the handler awaits the tools inventory before opening the modal
        expect(modal().textContent).toContain('2 deletion records will be cleared');
        expect(modal().textContent).toContain('These intentions may be proposed again');
        confirmButton().click();
        await flush();
        expect(clearDeletedIntentions).toHaveBeenCalledTimes(1);
        expect(statusText()).toContain('Applied');
        expect(collectTools.mock.calls.length).toBeGreaterThan(1); // the pane re-wired
    });

    test('clear-evidence: preview names the affected NPCs and warns about API cost', async () => {
        const clearAllEvidence = vi.fn(async () => ({ ok: true, count: 2, orphaned: [] }));
        const root = mountOverviewPane({
            collectTools: () => ({ evidenceNames: ['Mira', 'Tobin'], deletionCount: 0 }),
            actions: { clearAllEvidence, clearDeletedIntentions: vi.fn() },
        });
        await flush();
        root.querySelector('[data-maintenance-action="clear-evidence"]').click();
        await flush();
        expect(modal().textContent).toContain('2 NPC evidence files will be cleared');
        expect(modal().textContent).toContain('Affected NPCs: Mira, Tobin');
        expect(modal().textContent).toContain('rebuilding evidence costs API calls');
        confirmButton().click();
        await flush();
        expect(clearAllEvidence).toHaveBeenCalledTimes(1);
        expect(statusText()).toContain('Applied');
    });

    test('clear-evidence: a failed clear surfaces its reason without a refresh', async () => {
        const collect = vi.fn(() => snapshot());
        const clearAllEvidence = vi.fn(async () => ({ ok: false, reason: 'evidence store locked' }));
        const root = mountOverviewPane({
            collect,
            collectTools: () => ({ evidenceNames: ['Mira'], deletionCount: 0 }),
            actions: { clearAllEvidence, clearDeletedIntentions: vi.fn() },
        });
        await flush();
        root.querySelector('[data-maintenance-action="clear-evidence"]').click();
        await flush();
        confirmButton().click();
        await flush();
        expect(statusText()).toContain('evidence store locked');
        expect(collect).toHaveBeenCalledTimes(1);
    });

    test('clear-evidence: a chat switch while the inventory loads opens no modal at all', async () => {
        let calls = 0;
        const collectTools = async () => {
            calls += 1;
            if (calls > 1) bumpEpoch(); // the chat changed after the wiring collected
            return { evidenceNames: ['Mira'], deletionCount: 0 };
        };
        const clearAllEvidence = vi.fn();
        const root = mountOverviewPane({ collectTools, actions: { clearAllEvidence, clearDeletedIntentions: vi.fn() } });
        await flush();
        root.querySelector('[data-maintenance-action="clear-evidence"]').click();
        await flush();
        expect(modal()).toBeNull();
        expect(clearAllEvidence).not.toHaveBeenCalled();
    });

    test('clear-deletions: a chat switch between preview and confirm refuses to apply', async () => {
        const clearDeletedIntentions = vi.fn();
        const root = mountOverviewPane({
            collectTools: () => ({ evidenceNames: [], deletionCount: 2 }),
            actions: { clearAllEvidence: vi.fn(), clearDeletedIntentions },
        });
        await flush();
        root.querySelector('[data-maintenance-action="clear-deletions"]').click();
        await flush();
        bumpEpoch(); // the user switched chats while the modal sat open
        confirmButton().click();
        await flush();
        expect(clearDeletedIntentions).not.toHaveBeenCalled();
        expect(statusText()).toContain('The chat changed');
    });
});
