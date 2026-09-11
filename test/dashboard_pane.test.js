/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test } from 'vitest';
import { renderOverviewSnapshot, wireOverviewPane } from '../dashboard/render.js';

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
        const root = document.createElement('div');
        root.innerHTML = `<button id="mwt-tab-knowledge"></button><div class="mwt-tab-content" data-tab="overview">${renderOverviewSnapshot(snapshot())}</div>`;
        document.body.append(root);
        wireOverviewPane(root, { collect: () => snapshot({ staging: { ok: true, value: 9 } }) });
        root.querySelector('[data-overview-tab="knowledge"]').click();
        expect(root.querySelector('#mwt-tab-knowledge').dataset.clicked).toBeUndefined();
        root.querySelector('#mwt-tab-knowledge').addEventListener('click', () => root.querySelector('#mwt-tab-knowledge').dataset.clicked = 'yes');
        root.querySelector('[data-overview-tab="knowledge"]').click();
        expect(root.querySelector('#mwt-tab-knowledge').dataset.clicked).toBe('yes');
        root.querySelector('#mwt-overview-refresh').click();
        expect(root.textContent).toContain('9 items pending staging');
    });
});