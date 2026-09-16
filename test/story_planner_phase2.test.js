/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
    addArcBeat,
    getArcs,
    getCurrentBeat,
    getPlanHistory,
    historyEntryToArcs,
    makeArc,
    moveArcBeat,
    removeArcBeat,
    setArcBeatState,
    setArcs,
    setPlanData,
    updateArcBeat,
} from '../story_planner/data.js';
import { buildInjectionBody } from '../story_planner/injection.js';
import { getFakeMeta, resetCoreStubs } from './stubs/core.js';

beforeEach(() => resetCoreStubs());

describe('Story Planner Phase 2 — beat editor mutations', () => {
    test('add, edit, skip, restore, plant, reorder, and delete preserve stable records', () => {
        const arc = makeArc({ title: 'Route', beats: ['first', 'second'] });
        setArcs([arc]);

        const addedArc = addArcBeat(arc.id, 'third');
        const added = addedArc.beats.find(beat => beat.text === 'third');
        updateArcBeat(arc.id, added.id, { text: 'third revised' });
        setArcBeatState(arc.id, arc.beats[0].id, 'skipped', 'Took another route');
        expect(getArcs()[0].beats[0]).toMatchObject({
            id: arc.beats[0].id,
            state: 'skipped',
            stateReason: 'Took another route',
        });
        expect(getArcs()[0].beats.filter(beat => beat.state === 'planted')).toHaveLength(0);

        setArcBeatState(arc.id, arc.beats[0].id, 'pending');
        setArcBeatState(arc.id, arc.beats[0].id, 'planted');
        moveArcBeat(arc.id, added.id, 'up');
        expect(getArcs()[0].beats.map(beat => beat.text)).toEqual(['first', 'third revised', 'second']);
        expect(getArcs()[0].beats[0].id).toBe(arc.beats[0].id);

        removeArcBeat(arc.id, added.id);
        expect(getArcs()[0].beats.map(beat => beat.id)).toEqual([arc.beats[0].id, arc.beats[1].id]);
    });

    test('pending beats cannot cross historical beats until history is restored to pending', () => {
        const arc = makeArc({ title: 'Boundary', beats: ['history', 'future'] });
        arc.beats[0] = { ...arc.beats[0], state: 'planted' };
        setArcs([arc]);

        moveArcBeat(arc.id, arc.beats[1].id, 'up');
        expect(getArcs()[0].beats.map(beat => beat.text)).toEqual(['history', 'future']);

        setArcBeatState(arc.id, arc.beats[0].id, 'pending');
        moveArcBeat(arc.id, arc.beats[1].id, 'up');
        expect(getArcs()[0].beats.map(beat => beat.text)).toEqual(['future', 'history']);
    });

    test('future edits keep age and injection stable; current edits reset age and reminder marks', () => {
        const arc = { ...makeArc({ title: 'Age', beats: ['current', 'future'] }), turnsSinceAdvance: 18 };
        setArcs([arc]);
        setPlanData({ nudgeMarks: { [`${arc.id}#${arc.beats[0].id}`]: 1 } });
        const before = buildInjectionBody();

        updateArcBeat(arc.id, arc.beats[1].id, { text: 'future revised' });
        expect(getArcs()[0].turnsSinceAdvance).toBe(18);
        expect(buildInjectionBody()).toBe(before);

        updateArcBeat(arc.id, arc.beats[0].id, { text: 'current revised' });
        expect(getArcs()[0].turnsSinceAdvance).toBe(0);
        expect(getFakeMeta().story_planner_data.nudgeMarks).toEqual({});
        expect(getCurrentBeat(getArcs()[0])).toBe('current revised');
    });

    test('each completed operation snapshots once and restores ids, order, states, and reasons exactly', () => {
        const arc = makeArc({ title: 'History', beats: ['one', 'two'] });
        arc.beats[0] = { ...arc.beats[0], state: 'skipped', stateReason: 'Not in this version' };
        setArcs([arc]);

        updateArcBeat(arc.id, arc.beats[1].id, { text: 'two revised' });
        expect(getPlanHistory()).toHaveLength(1);
        expect(historyEntryToArcs(getPlanHistory()[0])[0].beats).toEqual(arc.beats);

        moveArcBeat(arc.id, arc.beats[1].id, 'down'); // no-op at the boundary/end
        expect(getPlanHistory()).toHaveLength(1);
        addArcBeat(arc.id, 'three');
        expect(getPlanHistory()).toHaveLength(2);
    });

    test('unchanged direct edits are no-ops rather than timestamp-only history steps', () => {
        const arc = makeArc({ title: 'No-op', beats: ['same'] });
        setArcs([arc]);

        updateArcBeat(arc.id, arc.beats[0].id, { text: 'same' });
        setArcBeatState(arc.id, arc.beats[0].id, 'pending');

        expect(getPlanHistory()).toEqual([]);
        expect(getArcs()[0].beats[0]).toEqual(arc.beats[0]);
    });
});

describe('Story Planner Phase 2 — editor markup contract', () => {
    test('renders explicit states, named controls, skip reason, and deferred targeted generation', async () => {
        const arc = makeArc({ title: 'Visible route', section: 'horizon', beats: ['done', 'skipped', 'now', 'later'] });
        arc.beats[0] = { ...arc.beats[0], state: 'planted' };
        arc.beats[1] = { ...arc.beats[1], state: 'skipped', stateReason: 'No longer fits' };
        const empty = makeArc({ title: 'Manual long range', section: 'horizon' });
        setArcs([arc, empty]);
        const { render } = await import('../story_planner/render.js');
        const html = render();

        for (const state of ['Planted', 'Skipped', 'Current', 'Upcoming']) expect(html).toContain(`>${state}<`);
        expect(html).toContain('Optional skip reason');
        expect(html).toContain('data-action="beat-up"');
        expect(html).toContain('data-action="beat-delete"');
        expect(html).toContain('Generate setup beats</button>');
        expect(html).toContain('Targeted setup generation will be available with the Phase 4 proposal flow.');
    });

    test('gives every beatless arc its own generation-help id wired to its button', async () => {
        const arcs = [makeArc({ title: 'Alpha', section: 'horizon' }), makeArc({ title: 'Beta', section: 'horizon' })];
        setArcs(arcs);
        const { render } = await import('../story_planner/render.js');
        const html = render();

        for (const arc of arcs) {
            expect(html).toContain(`id="sp-generate-beats-help-${arc.id}"`);
            expect(html).toContain(`aria-describedby="sp-generate-beats-help-${arc.id}"`);
        }
        // One help element per beatless arc, never a shared duplicate id.
        const helpIds = [...html.matchAll(/id="(sp-generate-beats-help-[^"]+)"/g)].map(m => m[1]);
        expect(helpIds).toHaveLength(2);
        expect(new Set(helpIds).size).toBe(2);
    });

    test('preserves an open editor and focused row control across a list render', async () => {
        vi.stubGlobal('CSS', { escape: value => String(value).replace(/"/g, '\\"') });
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        const arc = makeArc({ title: 'Focus', beats: ['one', 'two'] });
        setArcs([arc]);
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();

        const editor = document.querySelector('.sp-beat-editor');
        editor.open = true;
        const down = document.querySelector('[data-action="beat-down"]');
        down.focus();
        down.click();

        expect(document.querySelector('.sp-beat-editor').open).toBe(true);
        expect(document.activeElement.dataset.action).toBe('beat-text');
        expect(document.activeElement.dataset.beatId).toBe(arc.beats[0].id);
        state.modal = null;
        state.contentEl = null;
        vi.unstubAllGlobals();
    });
});

describe('Story Planner Phase 2 — focus survives destructive beat actions', () => {
    async function mount(arc) {
        vi.stubGlobal('CSS', { escape: value => String(value).replace(/"/g, '\\"') });
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        setArcs([arc]);
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();
        const editor = document.querySelector('.sp-beat-editor');
        if (editor) editor.open = true;
        return state;
    }

    function unmount(state) {
        state.modal = null;
        state.contentEl = null;
        delete globalThis.confirm;
        vi.unstubAllGlobals();
    }

    test('deleting a beat hands focus to the surviving neighbor row, then the Setup beats summary', async () => {
        globalThis.confirm = () => true;
        const arc = makeArc({ title: 'Focus', beats: ['one', 'two', 'three'] });
        const state = await mount(arc);

        // Delete row 1 — focus lands on the Delete control of the beat that
        // now occupies its slot, so repeated deletes stay on one key.
        const first = document.querySelector(`[data-action="beat-delete"][data-beat-id="${arc.beats[0].id}"]`);
        first.focus();
        first.click();
        expect(document.querySelector(`[data-beat-id="${arc.beats[0].id}"]`)).toBeNull();
        expect(document.activeElement.dataset.action).toBe('beat-delete');
        expect(document.activeElement.dataset.beatId).toBe(arc.beats[1].id);

        // Deleting the last survivor has no row left — focus the summary.
        document.activeElement.click();
        expect(document.activeElement.dataset.action).toBe('beat-delete');
        expect(document.activeElement.dataset.beatId).toBe(arc.beats[2].id);
        document.activeElement.click();
        expect(getArcs()[0].beats).toHaveLength(0);
        expect(document.activeElement.matches('.sp-beat-editor > summary')).toBe(true);

        unmount(state);
    });

    test('completing the final pending beat from the strip moves focus to the Setup beats summary', async () => {
        const arc = makeArc({ title: 'Solo', beats: ['only'] });
        const state = await mount(arc);

        const done = document.querySelector('[data-action="beat-done"]');
        done.focus();
        done.click();

        // The arc is READY now — its initiating control is gone, but focus
        // lands on the arc's Setup beats summary instead of the document.
        expect(getArcs()[0].beats[0].state).toBe('planted');
        expect(document.querySelector('[data-action="beat-done"]')).toBeNull();
        expect(document.activeElement.matches('.sp-beat-editor > summary')).toBe(true);

        unmount(state);
    });
});