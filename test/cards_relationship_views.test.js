/** @vitest-environment jsdom */
/**
 * test/cards_relationship_views.test.js — Accessibility plan Slice 5
 * (docs/accessibility_plan.md §5 Slice 5 / §4.6 / §6.4): cards and the
 * relationship views.
 *
 * Drives the REAL render pipeline (renderNpcsSubTab →
 * renderRelationshipContent → renderRelationshipGraph →
 * wireRelationshipGraphInteractions) under jsdom, then fires the registered
 * listeners directly — click on the zoom controls, keydown on the SVG node
 * groups — per the §6 handler-contract rule (jsdom has no sequential focus
 * navigation; asserting the handler contract is the sanctioned proxy).
 *
 * §6.4 contracts covered here:
 *   - the Graph/List toggle exposes pressed state;
 *   - the list view renders the same edge set as the graph data;
 *   - the NPC/type filters are label-associated, both views re-render from
 *     the same filtered edge set, and the visible/total counts plus active
 *     filters land in a polite live-region summary;
 *   - zoom/reset controls are labeled and wired, with an announced level;
 *   - keyboard node selection with an announced selected-node summary;
 *   - card actions are real, keyboard-operable buttons under real headings.
 *
 * Not claimed (§6.5, manual QA): :focus-visible rendering, how a real screen
 * reader pronounces the summary, and real focus traversal.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getLorebookName, getStateLorebookName } from '../knowledge/scope.js';
import { updateRelationship } from '../knowledge/relationships.js';
import { state } from '../knowledge/state.js';
import { releaseManagedInert } from '../core/modal.js';
import { renderNpcsSubTab } from '../knowledge/render.js';

const NPC = 'Mara';
const NPC_UID = 1;

let contentEl;

/** Let pending microtasks (dossier-load continuations) run to completion. */
const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

function seedGraph() {
    // Three edges over three nodes: a bidirectional pair + a single edge, so
    // node summaries have both outgoing and incoming parts.
    updateRelationship('Mara', 'Jonah', 'friend', '');
    updateRelationship('Jonah', 'Mara', 'rival', '');
    updateRelationship('Mara', 'Old Pete', 'mentor', '');
    return [
        { from: 'Mara', to: 'Jonah', type: 'friend' },
        { from: 'Jonah', to: 'Mara', type: 'rival' },
        { from: 'Mara', to: 'Old Pete', type: 'mentor' },
    ];
}

function renderTab(sub) {
    state.activeSubTab = sub;
    renderNpcsSubTab();
}

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    _setCacheForTests(getLorebookName(), {});
    _setCacheForTests(getStateLorebookName(), {});
    vi.spyOn(console, 'warn').mockImplementation(() => { });

    // rAF runs synchronously so renderRelationshipGraph() (deferred to the
    // next frame by the wiring) lands inside renderNpcsSubTab().
    vi.stubGlobal('requestAnimationFrame', (cb) => cb());

    contentEl = document.createElement('div');
    document.body.append(contentEl);
    state.npcsContentEl = contentEl;
    // renderRelationshipGraph looks the svg (and the zoom controls, which
    // live in the wrap beside it) up inside state.modal.
    state.modal = document.body;
    state.relViewMode = 'graph';
    state.relFilterNpc = '';
    state.relFilterType = '';
    state._graphData = null;
});

afterEach(() => {
    document.body.innerHTML = '';
    releaseManagedInert();
    state.modal = null;
    state.npcsContentEl = null;
    state.wiScript = null;
    state.relViewMode = 'graph';
    state.relFilterNpc = '';
    state.relFilterType = '';
    state._graphData = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Parse "x y w h" back into numbers. */
function viewBoxParts(svg) {
    return (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
}

describe('Graph/List toggle exposes pressed state (§6.4)', () => {
    test('graph mode: graph pressed, list not; the group is labeled', () => {
        seedGraph();
        renderTab('relationships');

        const group = contentEl.querySelector('.kt-rel-view-toggle');
        expect(group.getAttribute('role')).toBe('group');
        expect(group.getAttribute('aria-label')).toBe('Relationship view');

        const graphBtn = group.querySelector('[data-view="graph"]');
        const listBtn = group.querySelector('[data-view="list"]');
        expect(graphBtn.getAttribute('aria-pressed')).toBe('true');
        expect(listBtn.getAttribute('aria-pressed')).toBe('false');
    });

    test('clicking List re-renders with the pressed state moved', () => {
        seedGraph();
        renderTab('relationships');

        contentEl.querySelector('.kt-rel-view-btn[data-view="list"]').click();

        const group = contentEl.querySelector('.kt-rel-view-toggle');
        expect(group.querySelector('[data-view="graph"]').getAttribute('aria-pressed')).toBe('false');
        expect(group.querySelector('[data-view="list"]').getAttribute('aria-pressed')).toBe('true');
        // The list view actually rendered.
        expect(contentEl.querySelectorAll('.kt-rel-list .kt-rel-row[data-from]').length).toBeGreaterThan(0);
        expect(contentEl.querySelector('#kt-rel-graph')).toBeNull();
    });
});

describe('list view renders the same edge set as the graph data (§6.4)', () => {
    test('every graph edge appears as a row with its from/type/to', () => {
        const edges = seedGraph();
        state.relViewMode = 'list';
        renderTab('relationships');

        const rows = [...contentEl.querySelectorAll('.kt-rel-list .kt-rel-row[data-from]')];
        expect(rows).toHaveLength(edges.length);
        for (const row of rows) {
            const type = row.querySelector('.kt-rel-type').textContent;
            expect(
                edges.some(e => e.from === row.dataset.from && e.to === row.dataset.to && e.type === type),
                `${row.dataset.from} → ${row.dataset.to} (${type})`,
            ).toBe(true);
        }
    });

    test('the graph side summarizes the same counts as text for AT', () => {
        seedGraph();
        renderTab('relationships');

        const desc = contentEl.querySelector('#kt-rel-graph-desc');
        expect(desc.className).toContain('mwt-sr-only');
        expect(desc.textContent).toContain('3 relationships between 3 NPCs');
        // Insertion order follows the store's map, so assert types unordered.
        for (const t of ['friend', 'rival', 'mentor']) {
            expect(desc.textContent).toContain(t);
        }
        // The svg points at that summary.
        const svg = contentEl.querySelector('#kt-rel-graph');
        expect(svg.getAttribute('aria-describedby')).toBe('kt-rel-graph-desc');
    });
});

describe('labeled zoom and reset controls with an announced level (§4.6)', () => {
    test('the three controls carry accessible names', () => {
        seedGraph();
        renderTab('relationships');

        expect(contentEl.querySelector('#kt-rel-zoom-in').getAttribute('aria-label')).toBe('Zoom in');
        expect(contentEl.querySelector('#kt-rel-zoom-out').getAttribute('aria-label')).toBe('Zoom out');
        expect(contentEl.querySelector('#kt-rel-zoom-reset').getAttribute('aria-label')).toBe('Reset view');
    });

    test('zoom in narrows the viewBox centred, and the level text follows', () => {
        seedGraph();
        renderTab('relationships');
        const svg = contentEl.querySelector('#kt-rel-graph');

        contentEl.querySelector('#kt-rel-zoom-in').click();

        const [x, y, w, h] = viewBoxParts(svg);
        expect(w).toBeCloseTo(480, 6);
        expect(h).toBeCloseTo(320, 6);
        expect(x).toBeCloseTo(60, 6); // centre-anchored: (600-480)/2
        expect(y).toBeCloseTo(40, 6);
        expect(contentEl.querySelector('#kt-rel-zoom-level').textContent).toBe('Zoom 125%');
    });

    test('zoom out widens past 100% and announces it', () => {
        seedGraph();
        renderTab('relationships');
        const svg = contentEl.querySelector('#kt-rel-graph');

        contentEl.querySelector('#kt-rel-zoom-out').click();

        expect(viewBoxParts(svg)[2]).toBeCloseTo(750, 6);
        expect(contentEl.querySelector('#kt-rel-zoom-level').textContent).toBe('Zoom 80%');
    });

    test('reset restores the seeded viewBox and 100%', () => {
        seedGraph();
        renderTab('relationships');
        const svg = contentEl.querySelector('#kt-rel-graph');

        contentEl.querySelector('#kt-rel-zoom-in').click();
        contentEl.querySelector('#kt-rel-zoom-in').click();
        expect(contentEl.querySelector('#kt-rel-zoom-level').textContent).not.toBe('Zoom 100%');

        contentEl.querySelector('#kt-rel-zoom-reset').click();

        expect(svg.getAttribute('viewBox')).toBe('0 0 600 400');
        expect(contentEl.querySelector('#kt-rel-zoom-level').textContent).toBe('Zoom 100%');
    });
});

describe('zoom level announcements: discrete ops immediate, wheel gestures debounced', () => {
    afterEach(() => { vi.useRealTimers(); });

    /** jsdom-safe wheel: a plain Event with deltaY assigned (no WheelEvent
     *  constructor dependency); clientX/Y stay undefined, which only feeds
     *  the cursor-anchor x/y math — w (and therefore the level) stays finite. */
    const fireWheel = (svg, deltaY) => {
        const ev = new Event('wheel', { cancelable: true });
        ev.deltaY = deltaY;
        return svg.dispatchEvent(ev);
    };

    test('the visible level is plain text; a dedicated sr-only region announces', () => {
        seedGraph();
        renderTab('relationships');

        const visible = contentEl.querySelector('#kt-rel-zoom-level');
        expect(visible.getAttribute('role')).toBeNull();
        expect(visible.getAttribute('aria-live')).toBeNull();
        const announce = contentEl.querySelector('#kt-rel-zoom-announce');
        expect(announce).not.toBeNull();
        expect(announce.className).toContain('mwt-sr-only');
        expect(announce.getAttribute('role')).toBe('status');
        expect(announce.getAttribute('aria-live')).toBe('polite');
        expect(announce.textContent).toBe(''); // silent until something zooms
    });

    test('zoom buttons announce their level immediately', () => {
        seedGraph();
        renderTab('relationships');

        contentEl.querySelector('#kt-rel-zoom-in').click();

        expect(contentEl.querySelector('#kt-rel-zoom-level').textContent).toBe('Zoom 125%');
        expect(contentEl.querySelector('#kt-rel-zoom-announce').textContent).toBe('Zoom 125%');
    });

    test('wheel events update the visible level per event but announce once, after the gesture settles', async () => {
        seedGraph();
        renderTab('relationships');
        // Fake timers AFTER the render: useFakeTimers() also fakes rAF, and
        // the graph (plus its wheel listener) is wired inside one.
        vi.useFakeTimers();
        const svg = contentEl.querySelector('#kt-rel-graph');

        fireWheel(svg, -100);
        // The visible percentage follows immediately…
        expect(contentEl.querySelector('#kt-rel-zoom-level').textContent).toBe('Zoom 111%');
        // …while the announcement waits out the gesture (no per-notch queue).
        expect(contentEl.querySelector('#kt-rel-zoom-announce').textContent).toBe('');

        fireWheel(svg, -100);
        fireWheel(svg, -100);
        await vi.advanceTimersByTimeAsync(600);

        // ONE announcement naming the settled level (600/437.4 ≈ 137%).
        expect(contentEl.querySelector('#kt-rel-zoom-announce').textContent).toBe('Zoom 137%');
    });

    test('a button press supersedes a gesture that is still settling', async () => {
        seedGraph();
        renderTab('relationships');
        vi.useFakeTimers(); // after the rAF-driven graph wiring (see above)
        const svg = contentEl.querySelector('#kt-rel-graph');

        fireWheel(svg, -100);
        contentEl.querySelector('#kt-rel-zoom-reset').click(); // discrete op mid-gesture
        await vi.advanceTimersByTimeAsync(600);

        // The stale wheel announcement was cancelled — the reset's level stands.
        expect(contentEl.querySelector('#kt-rel-zoom-announce').textContent).toBe('Zoom 100%');
    });
});

describe('keyboard node selection with an announced summary (§4.6)', () => {
    test('nodes are focusable buttons whose names carry the edge count', () => {
        seedGraph();
        renderTab('relationships');

        const mara = contentEl.querySelector('.kt-rel-graph-node[data-name="Mara"]');
        expect(mara.getAttribute('tabindex')).toBe('0');
        expect(mara.getAttribute('role')).toBe('button');
        // friend→Jonah, mentor→Old Pete outgoing; rival←Jonah incoming = 3.
        expect(mara.getAttribute('aria-label')).toBe('Mara — 3 relationships');
    });

    test('first Enter selects and announces; Space is prevented; selection is marked', () => {
        seedGraph();
        renderTab('relationships');
        const mara = contentEl.querySelector('.kt-rel-graph-node[data-name="Mara"]');

        // Both activation keys are cancelable and the handler preventDefaults
        // them (Space would scroll the panel; Enter keeps button semantics).
        const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        expect(mara.dispatchEvent(enterEvent)).toBe(false);

        const summary = contentEl.querySelector('#kt-rel-node-summary');
        expect(summary.getAttribute('role')).toBe('status');
        expect(summary.getAttribute('aria-live')).toBe('polite');
        expect(summary.textContent).toContain('Mara: 3 relationships');
        expect(summary.textContent).toContain('outgoing: friend → Jonah, mentor → Old Pete');
        expect(summary.textContent).toContain('incoming: rival ← Jonah');
        expect(mara.getAttribute('class')).toContain('kt-rel-graph-node--selected');
        expect(mara.getAttribute('aria-current')).toBe('true');

        // Space also selects (on a different node) and is prevented.
        const jonah = contentEl.querySelector('.kt-rel-graph-node[data-name="Jonah"]');
        const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
        expect(jonah.dispatchEvent(spaceEvent)).toBe(false); // preventDefault ran
        expect(jonah.getAttribute('aria-current')).toBe('true');
        // Selection moved: the previous node lost the marker.
        expect(mara.getAttribute('aria-current')).toBeNull();
        expect(contentEl.querySelector('#kt-rel-node-summary').textContent).toContain('Jonah');
    });

    test('second Enter on the selected node opens the dossier (the pointer-click equivalent)', async () => {
        // _setCacheForTests REPLACES the whole book, so the registry must be
        // seeded BEFORE seedGraph() writes the relationships into that book.
        _setCacheForTests(getLorebookName(), {
            registry: { [NPC]: { uid: NPC_UID, type: 'minor', keywords: [NPC] } },
        });
        seedGraph();
        let resolveBook;
        state.wiScript = {
            loadWorldInfo: vi.fn(() => new Promise(r => { resolveBook = r; })),
        };
        renderTab('relationships');
        const mara = contentEl.querySelector('.kt-rel-graph-node[data-name="Mara"]');

        mara.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); // select
        mara.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); // open

        resolveBook({ entries: { [NPC_UID]: { comment: NPC, content: 'Dossier of Mara' } } });
        await flushMicrotasks();

        expect(document.querySelectorAll('#kt-view-modal')).toHaveLength(1);
        expect(document.querySelector('#kt-view-modal pre').textContent).toBe('Dossier of Mara');
        // The node stays selected — the summary survives the modal round-trip.
        expect(mara.getAttribute('aria-current')).toBe('true');
    });

    test('the hint covers the keyboard and list-view paths, not just pointer gestures', () => {
        seedGraph();
        renderTab('relationships');

        const hint = contentEl.querySelector('.kt-rel-graph-hint').textContent;
        expect(hint).toContain('Tab');
        expect(hint).toContain('Enter');
        expect(hint).toContain('List view');
        // The pointer contracts stay honoured (pinned by relationship_graph_zoom).
        expect(hint).toContain('Scroll to zoom');
        // The three keyboard-reachable zoom buttons sit right above the hint —
        // it must point at them instead of reading scroll as the only zoom.
        expect(hint).toContain('zoom buttons above');
        // Drag has no keyboard equivalent and is cosmetic-only — the hint says
        // so rather than reading as a required gesture.
        expect(hint).toContain('cosmetic');
    });
});

describe('empty states are polite live regions (§4.6)', () => {
    test('no relationships: a live-region empty state replaces the graph', () => {
        renderTab('relationships');

        const empty = contentEl.querySelector('.kt-empty');
        expect(empty).not.toBeNull();
        expect(empty.getAttribute('role')).toBe('status');
        expect(empty.textContent).toContain('No relationships tracked yet');
        expect(contentEl.querySelector('#kt-rel-graph')).toBeNull();
    });

    test('staging: the empty state is a live region too', () => {
        state.stagingItems = [];
        renderTab('staging');

        const empty = contentEl.querySelector('.kt-empty');
        expect(empty).not.toBeNull();
        expect(empty.getAttribute('role')).toBe('status');
        expect(empty.textContent).toContain('No pending proposals');
    });
});

// ─── Staging proposals: a real button, not a clickable div (§4.6) ────────────
// Regression: the proposal list was a <div> with a click handler, so the whole
// per-proposal half of the Staging workflow (select → review → edit →
// Accept/Dismiss) had no keyboard path — only the batch Accept All / Dismiss
// All buttons were reachable — and its selected state was the --active class,
// i.e. colour alone.

describe('staging proposals are keyboard-operable buttons (§4.6)', () => {
    const seedStaging = () => {
        state.stagingItems = [
            { id: 's1', name: 'Mara', type: 'minor', action: 'create' },
            { id: 's2', name: 'Jonah', type: 'major', action: 'update' },
        ];
    };

    test('each proposal is a <button>, not a clickable div, inside a labeled group', () => {
        seedStaging();
        state.activeItemId = null;
        renderTab('staging');

        const items = [...contentEl.querySelectorAll('.kt-staging-item')];
        expect(items).toHaveLength(2);
        for (const item of items) {
            expect(item.tagName).toBe('BUTTON');
            // type=button: the list sits inside the modal, and a default
            // submit button would be a live wire there.
            expect(item.getAttribute('type')).toBe('button');
            // The name comes from the badge + NPC name it already renders.
            expect(item.textContent.trim().length).toBeGreaterThan(0);
        }
        expect(items[0].textContent).toContain('Mara');
        expect(items[1].textContent).toContain('Jonah');

        const list = contentEl.querySelector('#kt-staging-list');
        expect(list.getAttribute('role')).toBe('group');
        expect(list.getAttribute('aria-label')).toBe('Pending proposals');
    });

    test('selection is exposed as aria-pressed, not by the --active class alone', () => {
        seedStaging();
        state.activeItemId = 's2';
        renderTab('staging');

        const [first, second] = [...contentEl.querySelectorAll('.kt-staging-item')];
        expect(first.getAttribute('aria-pressed')).toBe('false');
        expect(second.getAttribute('aria-pressed')).toBe('true');
        // The visual class still tracks it — the point is that it is no
        // longer the ONLY carrier of the state.
        expect(second.className).toContain('kt-staging-item--active');
        expect(first.className).not.toContain('kt-staging-item--active');
    });

    test('the detail pane names the selected proposal in a real h4', () => {
        seedStaging();
        state.activeItemId = 's1';
        renderTab('staging');

        // Same heading contract as the cards: the proposal name is an <h4>,
        // not a styled <div>, so heading navigation lands on the detail too.
        const name = contentEl.querySelector('.kt-detail-name');
        expect(name.tagName).toBe('H4');
        expect(name.textContent).toBe('Mara');
    });

    test('activating a proposal selects it and moves the pressed state', async () => {
        seedStaging();
        state.activeItemId = null;
        renderTab('staging');

        // A <button> fires click on Enter and Space natively, so the existing
        // click handler IS the keyboard path — dispatching click is the same
        // contract jsdom can assert (§6.5: real key traversal stays manual).
        contentEl.querySelectorAll('.kt-staging-item')[1].click();
        await flushMicrotasks();

        expect(state.activeItemId).toBe('s2');
        const items = [...contentEl.querySelectorAll('.kt-staging-item')];
        expect(items[0].getAttribute('aria-pressed')).toBe('false');
        expect(items[1].getAttribute('aria-pressed')).toBe('true');
        // And the detail pane followed the selection.
        expect(contentEl.querySelector('#kt-staging-detail').textContent).toContain('Jonah');
    });
});

describe('relationship filters: labeled controls and an announced summary (§4.6)', () => {
    test('the filter selects are label-associated and default to All', () => {
        seedGraph();
        renderTab('relationships');

        const npc = contentEl.querySelector('#kt-rel-filter-npc');
        const type = contentEl.querySelector('#kt-rel-filter-type');
        expect(contentEl.querySelector('label[for="kt-rel-filter-npc"]')).not.toBeNull();
        expect(contentEl.querySelector('label[for="kt-rel-filter-type"]')).not.toBeNull();
        expect(npc.value).toBe('');
        expect(type.value).toBe('');
        // Options come from the NPCs/types actually present in the edge set.
        for (const n of ['Mara', 'Jonah', 'Old Pete']) {
            expect(npc.querySelector(`option[value="${n}"]`)).not.toBeNull();
        }
        expect(type.querySelector('option[value="friend"]')).not.toBeNull();
        expect(type.querySelector('option[value="mentor"]')).not.toBeNull();
    });

    test('unfiltered: the summary is a polite live region naming the total', async () => {
        seedGraph();
        renderTab('relationships');

        const summary = contentEl.querySelector('#kt-rel-filter-summary');
        expect(summary.getAttribute('role')).toBe('status');
        expect(summary.getAttribute('aria-live')).toBe('polite');
        // The region renders empty and is populated one task later (the
        // announce-the-change, not-the-insertion contract).
        expect(summary.textContent).toBe('');
        await flushMicrotasks();
        expect(summary.textContent).toContain('Showing all 3 relationships');
    });

    test('an NPC filter narrows the graph, its summary, and the list alike', async () => {
        seedGraph();
        renderTab('relationships');

        const npc = contentEl.querySelector('#kt-rel-filter-npc');
        npc.value = 'Jonah';
        npc.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        const summary = contentEl.querySelector('#kt-rel-filter-summary');
        expect(summary.textContent).toContain('Showing 2 of 3');
        expect(summary.textContent).toContain('Jonah');
        // The graph consumed the same filtered set: Old Pete has no edges left.
        expect(contentEl.querySelector('.kt-rel-graph-node[data-name="Old Pete"]')).toBeNull();
        expect(contentEl.querySelector('.kt-rel-graph-node[data-name="Mara"]')).not.toBeNull();

        // Parity: the list view renders exactly the filtered edges.
        contentEl.querySelector('.kt-rel-view-btn[data-view="list"]').click();
        const rows = [...contentEl.querySelectorAll('.kt-rel-list .kt-rel-row[data-from]')];
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.dataset.from === 'Jonah' || row.dataset.to === 'Jonah').toBe(true);
        }
    });

    test('a type filter narrows the graph summary and the list to the same edge', async () => {
        seedGraph();
        renderTab('relationships');

        const type = contentEl.querySelector('#kt-rel-filter-type');
        type.value = 'mentor';
        type.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(contentEl.querySelector('#kt-rel-filter-summary').textContent).toContain('Showing 1 of 3');
        // The sr-only graph description follows the filtered set too.
        expect(contentEl.querySelector('#kt-rel-graph-desc').textContent).toContain('1 relationship');
        expect(contentEl.querySelectorAll('.kt-rel-graph-node')).toHaveLength(2); // Mara + Old Pete

        contentEl.querySelector('.kt-rel-view-btn[data-view="list"]').click();
        const rows = [...contentEl.querySelectorAll('.kt-rel-list .kt-rel-row[data-from]')];
        expect(rows).toHaveLength(1);
        expect(rows[0].dataset.from).toBe('Mara');
        expect(rows[0].dataset.to).toBe('Old Pete');
    });

    test('a filter matching nothing announces a filtered empty state', async () => {
        seedGraph();
        renderTab('relationships');

        const npc = contentEl.querySelector('#kt-rel-filter-npc');
        npc.value = 'Jonah';
        npc.dispatchEvent(new Event('change'));
        const type = contentEl.querySelector('#kt-rel-filter-type');
        type.value = 'mentor';
        type.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        const empty = contentEl.querySelector('.kt-empty');
        expect(empty.getAttribute('role')).toBe('status');
        expect(empty.textContent).toContain('No relationships match the current filters');
        expect(contentEl.querySelector('#kt-rel-graph')).toBeNull();
        // The summary still names the count and both active filters.
        const summary = contentEl.querySelector('#kt-rel-filter-summary').textContent;
        expect(summary).toContain('Showing 0 of 3');
        expect(summary).toContain('Jonah');
        expect(summary).toContain('mentor');
    });

    test('Clear restores the unfiltered edge set', async () => {
        seedGraph();
        renderTab('relationships');
        const npc = contentEl.querySelector('#kt-rel-filter-npc');
        npc.value = 'Jonah';
        npc.dispatchEvent(new Event('change'));

        contentEl.querySelector('#kt-rel-filter-clear').click();
        await flushMicrotasks();

        expect(contentEl.querySelector('#kt-rel-filter-summary').textContent).toContain('Showing all 3 relationships');
        expect(contentEl.querySelectorAll('.kt-rel-graph-node')).toHaveLength(3);
    });
});

describe('filter changes keep focus and land in the live region (§4.6)', () => {
    test('the summary region renders empty and is populated a task later', async () => {
        seedGraph();
        renderTab('relationships');

        const summary = contentEl.querySelector('#kt-rel-filter-summary');
        expect(summary.textContent).toBe(''); // inserted empty…
        await flushMicrotasks();
        expect(summary.textContent).toContain('Showing all 3 relationships'); // …announced after
    });

    test('changing a filter returns focus to the replacement select', async () => {
        seedGraph();
        renderTab('relationships');

        const npc = contentEl.querySelector('#kt-rel-filter-npc');
        npc.focus();
        expect(document.activeElement).toBe(npc);
        npc.value = 'Jonah';
        npc.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        const replacement = contentEl.querySelector('#kt-rel-filter-npc');
        expect(replacement).not.toBe(npc); // the panel really re-rendered
        expect(document.activeElement).toBe(replacement); // focus came back
        expect(replacement.value).toBe('Jonah'); // value survived via selected
        expect(state.relFilterNpc).toBe('Jonah');
    });

    test('Clear keeps focus on the replacement Clear button', async () => {
        seedGraph();
        renderTab('relationships');
        const npc = contentEl.querySelector('#kt-rel-filter-npc');
        npc.value = 'Jonah';
        npc.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        const clear = contentEl.querySelector('#kt-rel-filter-clear');
        clear.focus();
        clear.click();
        await flushMicrotasks();

        expect(document.activeElement).toBe(contentEl.querySelector('#kt-rel-filter-clear'));
        expect(state.relFilterNpc).toBe('');
        expect(state.relFilterType).toBe('');
    });
});

describe('cards: real headings, real buttons, native focus order (§4.6)', () => {
    test('minor NPC cards name the NPC in an h4 and act only through buttons', () => {
        _setCacheForTests(getLorebookName(), {
            registry: {
                [NPC]: { uid: NPC_UID, type: 'minor', keywords: [NPC] },
                'Old Pete': { uid: 2, type: 'minor', keywords: ['Pete'] },
            },
        });
        renderTab('minor');

        const cards = contentEl.querySelectorAll('.kt-npc-card');
        expect(cards).toHaveLength(2);
        for (const card of cards) {
            // The card itself is never interactive — no tabindex, no role.
            expect(card.tagName).toBe('DIV');
            expect(card.getAttribute('tabindex')).toBeNull();
            // The name is a real heading (h4 under the h3 modal title).
            const name = card.querySelector('.kt-npc-name');
            expect(name.tagName).toBe('H4');
            // Every action is a real, keyboard-operable <button>.
            const actions = card.querySelectorAll('.kt-npc-actions button');
            expect(actions.length).toBeGreaterThan(0);
            for (const btn of actions) expect(btn.tagName).toBe('BUTTON');
        }
    });

    test('state-tracker cards follow the same heading contract', () => {
        _setCacheForTests(getStateLorebookName(), { stateRegistry: { Weather: { uid: 9 } } });
        renderTab('state');

        const card = contentEl.querySelector('.kt-npc-card');
        expect(card).not.toBeNull();
        expect(card.querySelector('.kt-npc-name').tagName).toBe('H4');
        for (const btn of card.querySelectorAll('.kt-npc-actions button')) {
            expect(btn.tagName).toBe('BUTTON');
        }
        // The checkbox toggles keep their label associations.
        const cb = card.querySelector('.kt-state-enabled');
        expect(contentEl.querySelector(`label[for="${cb.id}"]`)).not.toBeNull();
    });

    test('empty NPC and state lists announce themselves', () => {
        renderTab('minor');
        expect(contentEl.querySelector('.kt-empty').getAttribute('role')).toBe('status');

        renderTab('state');
        expect(contentEl.querySelector('.kt-empty').getAttribute('role')).toBe('status');
    });
});




