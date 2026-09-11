/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test } from 'vitest';
import { renderMaintenanceFindings, renderOverviewSnapshot, wireOverviewPane } from '../dashboard/render.js';

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

const noFindings = async () => ({ ok: true, value: [] });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const maintenanceHost = (root) => root.querySelector('[data-overview-maintenance]');

/** Mount the pane inside a stand-in modal root and wire it with stubbed collectors. */
function mountPane(options = {}) {
    const root = document.createElement('div');
    root.innerHTML = `<button id="mwt-tab-knowledge"></button><div class="mwt-tab-content" data-tab="overview">${renderOverviewSnapshot(snapshot())}</div>`;
    document.body.append(root);
    wireOverviewPane(root, { collect: () => snapshot(), collectMaintenance: noFindings, ...options });
    return root;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('Overview pane', () => {
    test('renders status cards and human-readable counts', () => {
        document.body.innerHTML = renderOverviewSnapshot(snapshot());
        expect(document.querySelector('.mwt-overview')).not.toBeNull();
        expect(document.body.textContent).toContain('3 items pending staging');
        expect(document.body.textContent).toContain('1 beat overdue');
        expect(document.body.querySelector('.mwt-overview-error')).toBeNull();
    });

    test('keeps a broken cell local to its card', () => {
        document.body.innerHTML = renderOverviewSnapshot(snapshot({ beats: { ok: false, error: 'beat store unavailable' } }));
        expect(document.body.textContent).toContain('beat store unavailable');
        expect(document.body.textContent).toContain('Knowledge');
        expect(document.body.querySelectorAll('.mwt-overview-card')).toHaveLength(9);
    });

    test('deep links and refresh re-render in place', () => {
        const root = mountPane({ collect: () => snapshot({ staging: { ok: true, value: 9 } }) });
        root.querySelector('[data-overview-tab="knowledge"]').click();
        expect(root.querySelector('#mwt-tab-knowledge').dataset.clicked).toBeUndefined();
        root.querySelector('#mwt-tab-knowledge').addEventListener('click', () => root.querySelector('#mwt-tab-knowledge').dataset.clicked = 'yes');
        root.querySelector('[data-overview-tab="knowledge"]').click();
        expect(root.querySelector('#mwt-tab-knowledge').dataset.clicked).toBe('yes');
        root.querySelector('#mwt-overview-refresh').click();
        expect(root.textContent).toContain('9 items pending staging');
    });

    test('refresh keeps keyboard focus on the refresh control', () => {
        const root = mountPane();
        root.querySelector('#mwt-overview-refresh').focus();
        root.querySelector('#mwt-overview-refresh').click();
        const refreshed = root.querySelector('#mwt-overview-refresh');
        expect(refreshed.isConnected).toBe(true);
        expect(document.activeElement).toBe(refreshed);
    });
});

describe('Overview maintenance wiring', () => {
    test('drops deleted intentions from findings and keeps them in Tools', async () => {
        const root = mountPane({
            collectMaintenance: async () => ({ ok: true, value: [] }),
            collectTools: () => ({ evidenceNames: [], deletionCount: 2 }),
        });
        await flush();
        expect(maintenanceHost(root).querySelector('.mwt-overview-maintenance')).toBeNull();
        expect(root.querySelector('.mwt-overview-tools').textContent).toContain('Clear deleted intentions (2)');
    });

    test('a clean audit leaves only the one-line clean state', async () => {
        const root = mountPane();
        await flush();
        expect(maintenanceHost(root).querySelector('.mwt-overview-maintenance')).toBeNull();
        expect(maintenanceHost(root).querySelector('.mwt-overview-maintenance-clean')).toBeNull();
    });

    test('a failed maintenance collection renders its own status line', async () => {
        const root = mountPane({ collectMaintenance: async () => ({ ok: false, error: 'audit exploded' }) });
        await flush();
        const status = maintenanceHost(root).querySelector('.mwt-overview-maintenance-error');
        expect(status.getAttribute('role')).toBe('status');
        expect(status.textContent).toContain('audit exploded');
        expect(root.querySelectorAll('.mwt-overview-card')).toHaveLength(9);
    });

    test('a superseded maintenance result never overwrites a newer one', async () => {
        const pending = [];
        const root = mountPane({ collectMaintenance: () => new Promise((resolve) => pending.push(resolve)) });
        root.querySelector('#mwt-overview-refresh').click();
        expect(pending).toHaveLength(2);
        pending[1]({ ok: true, value: [] });
            pending[0]({ ok: true, value: [] });
        await flush();
        expect(maintenanceHost(root).textContent).toBe('');
        expect(maintenanceHost(root).querySelector('.mwt-overview-maintenance')).toBeNull();
    });
});

describe('Maintenance findings', () => {
    test('a clean audit hides Findings', () => {
        document.body.innerHTML = renderMaintenanceFindings([]);
        expect(document.body.textContent).toBe('');
        expect(document.querySelector('.mwt-overview-maintenance')).toBeNull();
    });

    test('duplicate profiles name the prunable NPCs and list each hand-review case', () => {
        document.body.innerHTML = renderMaintenanceFindings([{
            kind: 'duplicate-profiles', count: 3, entries: 6, pruneCount: 1, prunableNpcs: ['Mira'],
            review: [{ reason: 'unnamed', npc: '', count: 2 }, { reason: 'tied', npc: 'Tied', count: 2 }],
            command: 'MWT.profiles.pruneDuplicates()', rows: [],
        }]);
        expect(document.body.textContent).toContain('1 extra entry can be pruned automatically (Mira).');
        const review = [...document.querySelectorAll('.mwt-overview-review li')].map((li) => li.textContent);
        expect(review).toEqual([
            'Review by hand: 2 entries with no NPC name — they may belong to different characters.',
            'Review by hand: Tied — 2 entries of identical size, none linked to the registry.',
        ]);
    });

    test('relink explains the duplicate caveat and lists unmatched profiles for review', () => {
        document.body.innerHTML = renderMaintenanceFindings([{
            kind: 'relink-candidates', count: 3, relinkNpcs: ['Mira', 'Tobin'], withOtherCandidates: 1,
            unmatched: [{ npc: 'Ghost', count: 1 }], command: 'MWT.profiles.relink()', rows: [],
        }]);
        const text = document.body.textContent;
        expect(text).toContain('2 profiles can be relinked to their NPC (Mira, Tobin).');
        expect(text).toContain('1 NPC also has duplicate entries — check duplicates before relinking.');
        expect(text).not.toContain('needs manual review');
        expect(document.querySelector('.mwt-overview-review').textContent).toContain('Ghost — no NPC registry record');
    });

    test('long hand-review lists are capped', () => {
        document.body.innerHTML = renderMaintenanceFindings([{
            kind: 'relink-candidates', count: 8, relinkNpcs: [], withOtherCandidates: 0,
            unmatched: Array.from({ length: 8 }, (_, i) => ({ npc: `Ghost ${i}`, count: 1 })),
            command: 'MWT.profiles.relink()', rows: [],
        }]);
        const items = [...document.querySelectorAll('.mwt-overview-review li')].map((li) => li.textContent);
        expect(items).toHaveLength(6);
        expect(items.at(-1)).toContain('and 3 more');
    });

    test('identity findings summarize by kind without dumping entry previews', () => {
        const rows = Array.from({ length: 12 }, (_, i) => ({
            kind: 'untracked-entry', npc: `NPC ${i}`, detail: `in book, no registry record (40 chars: "secret preview ${i}")`,
        }));
        rows.push({ kind: 'ambiguous-name', npc: 'Mara', detail: 'shorthand collision' });
        document.body.innerHTML = renderMaintenanceFindings([{
            kind: 'npc-identity-audit', count: 13, byKind: { 'untracked-entry': 12, 'ambiguous-name': 1 },
            registryEmpty: false, command: 'MWT.npcs.auditDuplicates()', rows,
        }]);
        const text = document.body.textContent;
        expect(text).toContain('12 untracked entries · 1 ambiguous name.');
        expect(text).toContain('Involves NPC 0, NPC 1, NPC 2 and 10 more.');
        expect(text).toContain('not proven to be one character');
        expect(text).toContain('MWT.npcs.auditDuplicates()');
        expect(text).not.toContain('secret preview');
        expect(text).not.toContain('registry for this chat is empty');
    });

    test('an empty registry carries the console re-adopt guidance', () => {
        document.body.innerHTML = renderMaintenanceFindings([{
            kind: 'npc-identity-audit', count: 1, byKind: { 'untracked-entry': 1 }, registryEmpty: true,
            command: 'MWT.npcs.auditDuplicates()', rows: [{ kind: 'untracked-entry', npc: 'Mira' }],
        }]);
        expect(document.body.textContent).toContain('The NPC registry for this chat is empty');
        expect(document.body.textContent).toContain('From Lorebooks');
    });

    test('audit errors and unknown kinds stay truthful', () => {
        document.body.innerHTML = renderMaintenanceFindings([
            { kind: 'maintenance-error', source: 'profile audit', error: 'book unreadable' },
            { kind: 'something-new', count: 2, command: 'MWT.future()' },
        ]);
        const text = document.body.textContent;
        expect(text).toContain('profile audit — unavailable: book unreadable');
        expect(text).toContain('Maintenance finding — 2 findings.');
        expect(text).not.toContain('Deleted intentions');
    });
});
