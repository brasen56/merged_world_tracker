/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    addArcBeat,
    getArcs,
    getCurrentBeat,
    getCharacterContextSelection,
    getPlanHistory,
    getStoryPlanRequestPreferences,
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
import { captureScope, getFakeMeta, registerSafeCharacterContextProvider, resetCoreStubs, setFakeContextExtras } from './stubs/core.js';

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
        expect(html).toContain('Generates a reviewable route without changing this arc until you apply it.');
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
        expect(document.activeElement.value).toBe('one');
        state.modal = null;
        state.contentEl = null;
        vi.unstubAllGlobals();
    });

    test('committing a transient setup beat replaces only its row and preserves the next control', async () => {
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        const arc = makeArc({ title: 'Blank route', section: 'horizon' });
        setArcs([arc]);
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();

        document.querySelector('[data-action="beat-add"]').click();
        const draft = document.querySelector('[data-action="beat-new"]');
        expect(draft).not.toBeNull();
        expect(getArcs()[0].beats).toEqual([]);
        expect(buildInjectionBody()).not.toContain('New setup beat');

        draft.value = 'A real setup event';
        draft.dispatchEvent(new FocusEvent('blur'));
        expect(getArcs()[0].beats.map(beat => beat.text)).toEqual(['A real setup event']);
        expect(document.querySelector('[data-action="beat-new"]')).toBeNull();
        expect(document.querySelector('[data-action="beat-text"]').value).toBe('A real setup event');
        expect(document.querySelector('[data-action="beat-add"]').disabled).toBe(false);

        state.modal = null;
        state.contentEl = null;
    });

    test('committing a beat fully refreshes Ready grouping and first-beat controls', async () => {
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        const ready = makeArc({ title: 'Ready arc', beats: ['planted'], beatIndex: 1 });
        const empty = makeArc({ title: 'Empty arc', section: 'horizon' });
        setArcs([ready, empty]);
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();

        const readyEditor = document.querySelector(`[data-beat-editor-id="${ready.id}"]`);
        readyEditor.open = true;
        const readyAdd = readyEditor.querySelector('[data-action="beat-add"]');
        readyAdd.click();
        const readyDraft = readyEditor.querySelector('[data-action="beat-new"]');
        readyDraft.value = 'One more setup step';
        readyDraft.dispatchEvent(new FocusEvent('blur'));

        expect(document.querySelector(`[data-section="ready"] [data-id="${ready.id}"]`)).toBeNull();
        expect(document.querySelector(`[data-section="${ready.section}"] [data-id="${ready.id}"]`)).not.toBeNull();
        expect(document.querySelector(`[data-id="${ready.id}"] .sp-beats--ready`)).toBeNull();

        const emptyEditor = document.querySelector(`[data-beat-editor-id="${empty.id}"]`);
        emptyEditor.open = true;
        emptyEditor.querySelector('[data-action="beat-add"]').click();
        const emptyDraft = emptyEditor.querySelector('[data-action="beat-new"]');
        emptyDraft.value = 'First setup step';
        // The fallback helper is part of the regression: jsdom does not need a
        // CSS.escape implementation for this path to complete.
        vi.stubGlobal('CSS', undefined);
        emptyDraft.dispatchEvent(new FocusEvent('blur'));

        const emptyCard = document.querySelector(`[data-id="${empty.id}"]`);
        expect(emptyCard.querySelector('.sp-beats')).not.toBeNull();
        expect(emptyCard.querySelector('[data-action="beat-add"]')).not.toBeNull();
        expect(emptyCard.querySelector('[aria-describedby^="sp-generate-beats-help-"]')).toBeNull();

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

    test('a removed beat never copies its typed text into the fallback neighbor', async () => {
        const arc = makeArc({ title: 'No spill', beats: ['first', 'second'] });
        const state = await mount(arc);
        const first = document.querySelector(`[data-action="beat-text"][data-beat-id="${arc.beats[0].id}"]`);
        first.focus();
        first.value = 'unsaved typing';

        removeArcBeat(arc.id, arc.beats[0].id);
        document.querySelector('[data-action="pin"]').click();

        expect(document.activeElement.dataset.beatId).toBe(arc.beats[1].id);
        expect(document.activeElement.value).toBe('second');
        expect(getArcs()[0].beats[0].text).toBe('second');
        unmount(state);
    });
});

describe('Story Planner scoped review — individual acceptance', () => {
    test('a stale proposal explains the race and cannot be applied', async () => {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-review' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-review' }) });
        const target = makeArc({ title: 'Changed target', section: 'horizon' });
        const { showScopedReview } = await import('../story_planner/render.js');

        showScopedReview({
            request: { operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: [target.id] },
            scope: captureScope(), previousArcs: [target], arcs: [target], reviewArcIds: [target.id],
            stats: { added: 0, matched: 1, carried: 0, suppressedClosed: 0 }, diagnostics: {},
            stale: true, staleReason: 'A selected target changed or was deleted while this proposal was generated.',
        });

        expect(document.querySelector('.sp-proposal-stale').textContent).toMatch(/changed or was deleted/);
        expect(document.querySelector('#mwt-sp-scoped-apply').disabled).toBe(true);
        vi.unstubAllGlobals();
    });

    test('unchecking one valid proposal applies only the accepted item', async () => {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-review' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-review' }) });
        const first = makeArc({ title: 'First proposal', section: 'horizon' });
        const second = makeArc({ title: 'Second proposal', section: 'horizon' });
        const { showScopedReview } = await import('../story_planner/render.js');

        showScopedReview({
            request: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 2 },
            scope: captureScope(),
            previousArcs: [],
            arcs: [first, second],
            addedArcIds: [first.id, second.id],
            reviewArcIds: [first.id, second.id],
            stats: { added: 2, matched: 0, carried: 0, suppressedClosed: 0 },
            diagnostics: {},
        });

        const choices = [...document.querySelectorAll('input[name="mwt-sp-proposal"]')];
        expect(choices).toHaveLength(2);
        choices[0].checked = false;
        document.querySelector('#mwt-sp-scoped-apply').click();

        expect(getArcs().map(arc => arc.title)).toEqual(['Second proposal']);
        expect(getPlanHistory()).toEqual([]);
        expect(document.getElementById('mwt-sp-scoped-review-modal')).toBeNull();
        vi.unstubAllGlobals();
    });
});

describe('Story Planner scoped review — rendered change description', () => {
    // An open review blocks the Generate dialog by design, so each test closes
    // its modal through the real API rather than leaving state.scopedReviewOpen
    // set for whatever runs next.
    afterEach(async () => {
        const { closeScopedReviewModal } = await import('../story_planner/render.js');
        closeScopedReviewModal();
        vi.unstubAllGlobals();
    });

    test('a Refresh review shows its target field diff and claims no reordering', async () => {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-review-diff' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-review-diff' }) });
        const alpha = makeArc({ title: 'Alpha', section: 'horizon' });
        const bravo = makeArc({ title: 'Bravo', section: 'horizon', body: 'Before' });
        const charlie = makeArc({ title: 'Charlie', section: 'horizon' });
        setArcs([alpha, bravo, charlie]);
        const { captureTargetRevisions } = await import('../story_planner/proposals.js');
        const { showScopedReview } = await import('../story_planner/render.js');

        showScopedReview({
            request: { operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: [bravo.id] },
            scope: captureScope(),
            previousArcs: [alpha, bravo, charlie],
            // The merge returns [...carried, ...merged], so Bravo arrives last.
            arcs: [alpha, charlie, { ...bravo, body: 'After' }],
            targetSnapshots: [bravo],
            targetRevisions: captureTargetRevisions([bravo]),
            reviewArcIds: [bravo.id],
            matchedArcIds: [bravo.id],
            stats: { added: 0, matched: 1, carried: 2, suppressedClosed: 0 },
            diagnostics: {},
        });

        const body = document.getElementById('mwt-sp-scoped-review-modal').textContent;
        // One reviewable item, and it is the target.
        expect([...document.querySelectorAll('input[name="mwt-sp-proposal"]')].map(input => input.value)).toEqual([bravo.id]);
        expect(document.querySelector('.sp-proposal-change del').textContent).toBe('Before');
        expect(document.querySelector('.sp-proposal-change ins').textContent).toBe('After');
        // The untouched arcs are not described as changes at all.
        expect(body).not.toContain('Charlie');
        expect(body).not.toContain('Alpha');

        document.querySelector('#mwt-sp-scoped-apply').click();
        expect(getArcs().map(arc => arc.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
        expect(getArcs()[1].body).toBe('After');
    });

    test('an Add review shows the proposed arc rather than a diff against nothing', async () => {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-review-add' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-review-add' }) });
        const existing = makeArc({ title: 'Alpha', section: 'horizon' });
        const proposed = makeArc({ title: 'Mara weighs the ledger', section: 'character', body: 'She must choose.', beats: ['She stalls.', 'She confesses.'] });
        setArcs([existing]);
        const { showScopedReview } = await import('../story_planner/render.js');

        showScopedReview({
            request: { operation: 'add', sectionKeys: ['character'], requestedCount: 1 },
            scope: captureScope(),
            previousArcs: [existing],
            arcs: [existing, proposed],
            addedArcIds: [proposed.id],
            reviewArcIds: [proposed.id],
            stats: { added: 1, matched: 0, carried: 1, suppressedClosed: 0 },
            diagnostics: {},
        });

        const body = document.getElementById('mwt-sp-scoped-review-modal').textContent;
        expect(body).toContain('Mara weighs the ledger');
        expect(body).toContain('She must choose.');
        expect(body).toContain('She confesses.');
        expect(body).toContain('new arc');
        expect(document.querySelector('.sp-proposal-change')).toBeNull();
    });

    test('a review shows the captured Safe Character Context coverage states', async () => {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-review-coverage' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-review-coverage' }) });
        const proposed = makeArc({ title: 'Covered journey', section: 'character' });
        const { showScopedReview } = await import('../story_planner/render.js');

        showScopedReview({
            request: { operation: 'add', sectionKeys: ['character'], requestedCount: 1 },
            scope: captureScope(), previousArcs: [], arcs: [proposed],
            addedArcIds: [proposed.id], reviewArcIds: [proposed.id],
            stats: { added: 1, matched: 0, carried: 0, suppressedClosed: 0 },
            diagnostics: {
                characterContextMode: 'selected',
                characterContextCoverage: [
                    { entityId: 'entity-mara', name: 'Mara', status: 'complete' },
                    { entityId: 'entity-ivo', name: 'Ivo', status: 'omitted-for-budget' },
                ],
            },
        });

        const coverage = document.querySelector('.sp-context-coverage-review').textContent;
        expect(coverage).toContain('Mara: Included — every populated supported field fit');
        expect(coverage).toContain('Ivo: Omitted for context budget');
    });

    test('a review explicitly reports globally disabled Knowledge coverage', async () => {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-review-disabled-coverage' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-review-disabled-coverage' }) });
        const proposed = makeArc({ title: 'Ungrounded journey', section: 'character' });
        const { showScopedReview } = await import('../story_planner/render.js');

        showScopedReview({
            request: { operation: 'add', sectionKeys: ['character'], requestedCount: 1 },
            scope: captureScope(), previousArcs: [], arcs: [proposed],
            addedArcIds: [proposed.id], reviewArcIds: [proposed.id],
            stats: { added: 1, matched: 0, carried: 0, suppressedClosed: 0 },
            diagnostics: {
                characterContextMode: 'selected',
                characterContextStatus: 'disabled',
                characterContextCoverage: [
                    { entityId: 'entity-mara', name: 'Mara', status: 'disabled' },
                    { entityId: 'entity-ivo', name: 'Ivo', status: 'disabled' },
                ],
            },
        });

        const coverage = document.querySelector('.sp-context-coverage-review').textContent;
        expect(coverage).toContain('Safe Character Context disabled for this request.');
        expect(coverage).toContain('Mara: Safe Character Context disabled');
        expect(coverage).toContain('Ivo: Safe Character Context disabled');
        expect(document.querySelector('.sp-context-coverage-review [data-coverage-status="disabled"]')).not.toBeNull();
    });

    test('a review visibly reports supporting-participant cleanup', async () => {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-review-participants' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-review-participants' }) });
        const proposed = makeArc({ title: 'Shared burden', section: 'character', primarySubjectEntityId: 'entity-mara' });
        const { showScopedReview } = await import('../story_planner/render.js');

        showScopedReview({
            request: { operation: 'add', sectionKeys: ['character'], requestedCount: 1 },
            scope: captureScope(), previousArcs: [], arcs: [proposed],
            addedArcIds: [proposed.id], reviewArcIds: [proposed.id],
            stats: { added: 1, matched: 0, carried: 0, suppressedClosed: 0 },
            diagnostics: { participantDiagnostics: ['Shared burden: duplicate supporting handles were collapsed.'] },
        });

        expect(document.querySelector('.sp-proposal-diagnostics').textContent)
            .toContain('Shared burden: duplicate supporting handles were collapsed.');
    });

    test('new Journey review shows captured owner/support labels and quantitative coverage', async () => {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-review-labels' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-review-labels' }) });
        const proposed = makeArc({
            title: 'Shared burden', section: 'character', primarySubjectEntityId: 'entity-mara',
            supportingParticipantEntityIds: ['entity-derek'],
        });
        const { showScopedReview } = await import('../story_planner/render.js');

        showScopedReview({
            request: { operation: 'add', sectionKeys: ['character'], requestedCount: 1 },
            scope: captureScope(), previousArcs: [], arcs: [proposed],
            addedArcIds: [proposed.id], reviewArcIds: [proposed.id],
            subjectCandidates: [
                { entityId: 'entity-mara', name: 'Mara', mergedEntityIds: [] },
                { entityId: 'entity-derek', name: 'Derek', mergedEntityIds: [] },
            ],
            stats: { added: 1, matched: 0, carried: 0, suppressedClosed: 0 },
            diagnostics: {
                characterContextMode: 'selected',
                characterContextCoverage: [{
                    entityId: 'entity-mara', name: 'Mara', status: 'partial',
                    records: 1, fields: 3, availableFields: 4, supportedFields: 5,
                    tokens: 42, estimated: true, isPrimarySubject: true,
                }],
            },
        });

        const review = document.querySelector('.sp-proposal-item').textContent;
        expect(review).toContain('Primary subjectMara');
        expect(review).toContain('Supporting participantsDerek');
        expect(document.querySelector('.sp-context-coverage-review').textContent)
            .toContain('1 record, 3 of 4 populated public fields included (5 supported), 42 estimated tokens');
        expect(document.querySelector('.sp-context-coverage-review [data-coverage-role="subject"]')).not.toBeNull();
    });

    test('Apply invalidates the open review when a captured subject is merged', async () => {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-review-remap' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-review-remap' }) });
        let candidates = [{ entityId: 'entity-mara', name: 'Mara', mergedEntityIds: [] }];
        registerSafeCharacterContextProvider({ listCandidates: () => candidates });
        const proposed = makeArc({ title: 'Mapped journey', section: 'character', primarySubjectEntityId: 'entity-mara' });
        const { showScopedReview } = await import('../story_planner/render.js');
        showScopedReview({
            request: { operation: 'add', sectionKeys: ['character'], requestedCount: 1 },
            scope: captureScope(), previousArcs: [], arcs: [proposed],
            addedArcIds: [proposed.id], reviewArcIds: [proposed.id],
            subjectCandidates: candidates,
            subjectIdentitySnapshot: [{ entityId: 'entity-mara' }],
            stats: { added: 1, matched: 0, carried: 0, suppressedClosed: 0 }, diagnostics: {},
        });
        candidates = [{ entityId: 'entity-survivor', name: 'Mara', mergedEntityIds: ['entity-mara'] }];

        document.querySelector('#mwt-sp-scoped-apply').click();

        expect(document.querySelector('.sp-proposal-stale').textContent).toMatch(/merged or removed/);
        expect(document.querySelector('#mwt-sp-scoped-apply').disabled).toBe(true);
        expect(getArcs()).toEqual([]);
    });
});

describe('Story Planner scoped generate dialog', () => {
    let alpha;
    let bravo;

    /** @param {{preselectTargets?: boolean, settings?: object, preferences?: object}} [options] */
    async function openDialog({ preselectTargets = false, settings = {}, preferences = {} } = {}) {
        document.body.innerHTML = '';
        setFakeContextExtras({ getCurrentChatId: () => 'story-planner-dialog' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'story-planner-dialog' }) });
        alpha = makeArc({ title: 'Alpha', section: 'horizon' });
        bravo = makeArc({ title: 'Bravo', section: 'horizon' });
        setArcs([alpha, bravo]);
        const { saveSettings } = await import('../story_planner/settings.js');
        saveSettings({ customSystemPrompt: '', customUserPrompt: '', ...settings });
        setPlanData({
            storyPlanRequestPreferences: {
                operation: 'refresh',
                sectionKeys: ['horizon'],
                requestedCount: 2,
                targetArcIds: preselectTargets ? [alpha.id, bravo.id] : [],
                ...preferences,
            },
        });
        const { openGenerateDialog } = await import('../story_planner/render.js');
        openGenerateDialog();
    }

    const targets = () => [...document.querySelectorAll('input[name="sp-generate-target"]')];
    const toggle = input => {
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    afterEach(() => vi.unstubAllGlobals());

    test('toggling a target keeps that checkbox and its focus', async () => {
        await openDialog({ preselectTargets: true });
        const first = targets()[0];
        first.focus();
        toggle(first);
        // The list must not be rebuilt by its own change event: replacing the
        // input drops focus to <body> and makes the list unusable by keyboard.
        expect(first.isConnected).toBe(true);
        expect(document.activeElement).toBe(first);
    });

    test('the last selected target can be cleared', async () => {
        await openDialog({ preselectTargets: true });
        expect(targets().filter(input => input.checked)).toHaveLength(2);
        // Clearing the last box must not fall back to the saved preference set
        // and silently re-check everything.
        targets().forEach(toggle);
        expect(targets().filter(input => input.checked)).toHaveLength(0);
        expect(document.querySelector('#sp-generate-summary').textContent)
            .toMatch(/No eligible active arcs are selected for refresh/);
    });

    test('changing the section set still rebuilds the eligible list', async () => {
        await openDialog();
        expect(targets()).toHaveLength(2);
        toggle(document.querySelector('input[name="sp-generate-section"][value="horizon"]'));
        expect(targets()).toHaveLength(0);
    });

    test('a whole-plan regeneration path is offered with or without custom templates', async () => {
        await openDialog();
        expect(document.querySelector('#sp-generate-legacy')).not.toBeNull();
        await openDialog({ settings: { customUserPrompt: 'CUSTOM {{chatHistory}}' } });
        expect(document.querySelector('#sp-generate-legacy')).not.toBeNull();
    });

    test('a rejected request is not remembered as the next dialog state', async () => {
        await openDialog();
        document.querySelectorAll('input[name="sp-generate-section"]').forEach(input => { input.checked = false; });
        document.querySelector('#sp-generate-submit').click();
        await Promise.resolve();
        expect(document.querySelector('#mwt-sp-generate-modal')).not.toBeNull();
        expect(getStoryPlanRequestPreferences().sectionKeys.length).toBeGreaterThan(0);
    });

    test('offers labeled Any/Selected subject controls and disables candidates in Any mode', async () => {
        registerSafeCharacterContextProvider({
            listCandidates: () => [{ entityId: 'entity-mara', name: 'Mara', mergedEntityIds: [] }],
        });
        await openDialog();
        toggle(document.querySelector('input[name="sp-generate-section"][value="character"]'));

        expect(document.querySelector('label[for="sp-subject-any"]').textContent).toContain('Any tracked character');
        expect(document.querySelector('label[for="sp-subject-selected"]').textContent).toContain('Selected characters');
        const candidate = document.querySelector('input[name="sp-generate-subject"]');
        expect(candidate.disabled).toBe(true);

        toggle(document.querySelector('#sp-subject-selected'));
        expect(candidate.disabled).toBe(false);
        expect(document.querySelector('label[for="sp-generate-subject-0"]').textContent).toContain('Mara');
    });

    test('bounds Journey subjects to the same 30-character table sent to the model', async () => {
        registerSafeCharacterContextProvider({
            listCandidates: () => Array.from({ length: 31 }, (_, index) => ({
                entityId: `entity-${String(index + 1).padStart(2, '0')}`,
                name: `Character ${String(index + 1).padStart(2, '0')}`,
                mergedEntityIds: [],
            })),
        });
        await openDialog();
        toggle(document.querySelector('input[name="sp-generate-section"][value="character"]'));

        expect(document.querySelectorAll('input[name="sp-generate-subject"]')).toHaveLength(30);
        expect(document.querySelector('#sp-generate-subject-list').textContent).toContain('Character 30');
        expect(document.querySelector('#sp-generate-subject-list').textContent).not.toContain('Character 31');
        expect(document.getElementById('mwt-sp-generate-modal').textContent).toContain('Saved selections stay visible at the top');
    });

    test('pins a saved subject beyond row 30 into view so it can be cleared', async () => {
        registerSafeCharacterContextProvider({
            listCandidates: () => Array.from({ length: 31 }, (_, index) => ({
                entityId: `entity-${String(index + 1).padStart(2, '0')}`,
                name: `Character ${String(index + 1).padStart(2, '0')}`,
                mergedEntityIds: [],
            })),
        });
        await openDialog({
            preferences: {
                operation: 'add', sectionKeys: ['character'], requestedCount: 1,
                subjectMode: 'selected', subjectEntityIds: ['entity-31'],
            },
        });

        const inputs = [...document.querySelectorAll('input[name="sp-generate-subject"]')];
        const saved = inputs.find(input => input.value === 'entity-31');
        expect(inputs).toHaveLength(30);
        expect(saved?.checked).toBe(true);
        expect(document.querySelector('label[for="sp-generate-subject-0"]').textContent).toContain('Character 31');
        expect(document.querySelector('#sp-generate-subject-list').textContent).not.toContain('Character 30');

        toggle(saved);
        expect(inputs.filter(input => input.checked)).toHaveLength(0);
        expect(document.querySelector('#sp-generate-summary').textContent).toContain('Select at least one NPC');
    });

    test('excludes unassigned Journeys from Refresh with a visible manual-assignment reason', async () => {
        const unassigned = makeArc({ title: 'Legacy journey', section: 'character' });
        await openDialog();
        setArcs([unassigned]);
        const horizon = document.querySelector('input[name="sp-generate-section"][value="horizon"]');
        const character = document.querySelector('input[name="sp-generate-section"][value="character"]');
        horizon.checked = false;
        character.checked = true;
        character.dispatchEvent(new Event('change', { bubbles: true }));

        expect(document.querySelector(`input[name="sp-generate-target"][value="${unassigned.id}"]`)).toBeNull();
        expect(document.querySelector('#sp-generate-target-list').textContent)
            .toContain('Legacy journey — assign a primary subject first.');
    });

    test('excludes Journeys whose stored owner is unavailable with a visible reason', async () => {
        registerSafeCharacterContextProvider({
            listCandidates: () => [{ entityId: 'entity-mara', name: 'Mara', mergedEntityIds: [] }],
        });
        const unavailable = makeArc({
            title: 'Missing owner journey', section: 'character',
            primarySubjectEntityId: 'entity-gone',
        });
        await openDialog();
        setArcs([unavailable]);
        const horizon = document.querySelector('input[name="sp-generate-section"][value="horizon"]');
        const character = document.querySelector('input[name="sp-generate-section"][value="character"]');
        horizon.checked = false;
        character.checked = true;
        character.dispatchEvent(new Event('change', { bubbles: true }));

        expect(document.querySelector(`input[name="sp-generate-target"][value="${unavailable.id}"]`)).toBeNull();
        expect(document.querySelector('#sp-generate-target-list').textContent)
            .toContain('primary subject is unavailable in Knowledge');
    });

    test('keeps a merged legacy owner eligible for Selected Refresh', async () => {
        registerSafeCharacterContextProvider({
            listCandidates: () => [{ entityId: 'entity-mara', name: 'Mara', mergedEntityIds: ['entity-mara-old'] }],
        });
        const journey = makeArc({ title: 'Renamed owner', section: 'character', primarySubjectEntityId: 'entity-mara-old' });
        setArcs([journey]);
        setPlanData({
            storyPlanRequestPreferences: {
                operation: 'refresh', sectionKeys: ['character'], requestedCount: 1,
                targetArcIds: [], subjectMode: 'selected', subjectEntityIds: ['entity-mara-old'],
            },
        });
        const { openGenerateDialog } = await import('../story_planner/render.js');
        openGenerateDialog();

        expect(document.querySelector('input[name="sp-generate-subject"]').checked).toBe(true);
        expect(document.querySelector(`input[name="sp-generate-target"][value="${journey.id}"]`)).not.toBeNull();
    });

    test('shows Safe Character Context coverage without coupling it to subject selection', async () => {
        registerSafeCharacterContextProvider({
            listCandidates: () => [{ entityId: 'entity-mara', name: 'Mara', mergedEntityIds: [] }],
            buildContext: async () => ({
                text: '', records: 0, requested: 1, omitted: 1, chars: 0, tokens: 0,
                coverage: [{ entityId: 'entity-mara', name: 'Mara', status: 'missing-dossier' }],
            }),
        });
        setPlanData({ characterContext: { mode: 'selected', entityIds: ['entity-mara'] } });
        await openDialog();
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('#sp-generate-context-coverage').textContent)
            .toContain('Mara: Missing dossier');
        expect(document.querySelector('#sp-subject-any').checked).toBe(true);
    });

    test('labels selected owners separately from saved context-only characters', async () => {
        const candidates = ['Derek', 'Ezra', 'Ranger'].map(name => ({
            entityId: `entity-${name.toLowerCase()}`, name, mergedEntityIds: [],
        }));
        const buildContext = vi.fn(async selection => ({
            text: '', records: selection.entityIds.length, requested: selection.entityIds.length, omitted: 0,
            coverage: candidates.filter(candidate => selection.entityIds.includes(candidate.entityId)
                || selection.primarySubjectEntityIds.includes(candidate.entityId)).map(candidate => ({
                ...candidate,
                status: 'complete', records: 1, fields: 1, availableFields: 1,
                supportedFields: 5, tokens: 17, estimated: true,
                isPrimarySubject: selection.primarySubjectEntityIds.includes(candidate.entityId),
            })),
        }));
        registerSafeCharacterContextProvider({
            listCandidates: () => candidates,
            buildContext,
        });
        setPlanData({ characterContext: { mode: 'selected', entityIds: ['entity-ranger'] } });
        await openDialog({
            preferences: {
                operation: 'add', sectionKeys: ['character'], requestedCount: 2,
                subjectMode: 'selected', subjectEntityIds: ['entity-derek', 'entity-ezra'],
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        const coverage = document.querySelector('#sp-generate-context-coverage');
        expect(coverage.querySelectorAll('[data-coverage-role="subject"]')).toHaveLength(2);
        expect(coverage.querySelectorAll('[data-coverage-role="context-only"]')).toHaveLength(1);
        expect(coverage.textContent).toContain('Ranger: Included — every populated supported field fit');
        expect(coverage.textContent).toContain('— Context only');

        const contextSources = [...document.querySelectorAll('input[name="sp-generate-context-source"]')];
        expect(contextSources.find(input => input.value === 'entity-derek')?.checked).toBe(false);
        expect(contextSources.find(input => input.value === 'entity-ezra')?.checked).toBe(false);
        expect(contextSources.find(input => input.value === 'entity-ranger')?.checked).toBe(true);

        toggle(contextSources.find(input => input.value === 'entity-derek'));
        await Promise.resolve();
        await Promise.resolve();
        expect(buildContext).toHaveBeenLastCalledWith(expect.objectContaining({
            entityIds: expect.arrayContaining(['entity-derek', 'entity-ranger']),
            primarySubjectEntityIds: ['entity-derek', 'entity-ezra'],
        }));
        expect(buildContext.mock.lastCall[0].entityIds).toHaveLength(2);
    });

    test('shows every saved context source separately so an off-screen NPC can be omitted for this request', async () => {
        const candidates = Array.from({ length: 40 }, (_, index) => ({
            entityId: `entity-${String(index + 1).padStart(2, '0')}`,
            name: index === 39 ? 'Ranger' : `Character ${String(index + 1).padStart(2, '0')}`,
            mergedEntityIds: [],
        }));
        const buildContext = vi.fn(async () => ({ text: '', records: 0, requested: 0, omitted: 0, coverage: [] }));
        registerSafeCharacterContextProvider({ listCandidates: () => candidates, buildContext });
        setPlanData({ characterContext: { mode: 'selected', entityIds: ['entity-40'] } });
        await openDialog();
        await Promise.resolve();

        const source = document.querySelector('input[name="sp-generate-context-source"][value="entity-40"]');
        expect(source?.checked).toBe(true);
        expect(source.closest('label').textContent).toContain('Ranger');

        toggle(source);
        await Promise.resolve();
        await Promise.resolve();
        expect(buildContext).toHaveBeenLastCalledWith(expect.objectContaining({ entityIds: [] }));
        expect(document.querySelector('#sp-generate-context-summary').textContent)
            .toContain('0 selected characters for this request');
    });

    test('lets an active-cast context source be omitted without changing the saved mode', async () => {
        const buildContext = vi.fn(async selection => ({
            text: '', records: 0, requested: 1, omitted: 1,
            coverage: selection.excludedEntityIds?.includes('entity-ranger') ? [] : [{
                entityId: 'entity-ranger', name: 'Ranger', status: 'missing-dossier',
                records: 0, fields: 0, isContextSource: true,
            }],
        }));
        registerSafeCharacterContextProvider({
            listCandidates: () => [{ entityId: 'entity-ranger', name: 'Ranger', mergedEntityIds: [] }],
            buildContext,
        });
        setPlanData({ characterContext: { mode: 'active', entityIds: [] } });
        await openDialog();
        await Promise.resolve();
        await Promise.resolve();

        const ranger = document.querySelector('input[name="sp-generate-context-source"][value="entity-ranger"]');
        expect(ranger?.checked).toBe(true);
        toggle(ranger);
        await Promise.resolve();
        await Promise.resolve();

        expect(buildContext).toHaveBeenLastCalledWith(expect.objectContaining({
            mode: 'active', excludedEntityIds: ['entity-ranger'],
        }));
        expect(document.querySelector('#sp-generate-context-summary').textContent)
            .toContain('active cast, 1 omitted for this request');
        expect(getCharacterContextSelection().mode).toBe('active');
    });

    test('shows globally disabled Knowledge as disabled context coverage in the dialog', async () => {
        registerSafeCharacterContextProvider({
            listCandidates: () => [
                { entityId: 'entity-mara', name: 'Mara', mergedEntityIds: [] },
                { entityId: 'entity-ivo', name: 'Ivo', mergedEntityIds: [] },
            ],
            buildContext: async () => ({
                text: '', records: 0, requested: 2, omitted: 2, chars: 0, tokens: 0,
                status: 'disabled', coverage: [
                    { entityId: 'entity-mara', name: 'Mara', status: 'disabled' },
                    { entityId: 'entity-ivo', name: 'Ivo', status: 'disabled' },
                ],
            }),
        });
        setPlanData({ characterContext: { mode: 'selected', entityIds: ['entity-mara', 'entity-ivo'] } });
        await openDialog();
        await Promise.resolve();
        await Promise.resolve();

        const coverage = document.querySelector('#sp-generate-context-coverage').textContent;
        expect(coverage).toContain('Safe Character Context disabled for this request.');
        expect(coverage).toContain('Mara: Safe Character Context disabled');
        expect(coverage).toContain('Ivo: Safe Character Context disabled');
        expect(document.querySelector('#sp-generate-context-coverage [data-coverage-status="disabled"]')).not.toBeNull();
    });
});

describe('Story Planner Journey ownership editor', () => {
    afterEach(() => vi.unstubAllGlobals());

    test('assigns primary/supporting identities and visibly retains unresolved ids', async () => {
        registerSafeCharacterContextProvider({
            listCandidates: () => [
                { entityId: 'entity-mara', name: 'Mara', mergedEntityIds: ['entity-mara-old'] },
                { entityId: 'entity-derek', name: 'Derek', mergedEntityIds: [] },
            ],
        });
        const arc = makeArc({
            title: 'Owned journey', section: 'character', primarySubjectEntityId: 'entity-mara-old',
            supportingParticipantEntityIds: ['entity-gone'],
        });
        setArcs([arc]);
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();

        const primary = document.querySelector('[data-action="primary-subject"]');
        expect(primary.value).toBe('entity-mara');
        const unresolved = document.querySelector('[data-action="supporting-participants"] option[value="entity-gone"]');
        expect(unresolved.textContent).toContain('Unresolved identity');

        primary.value = 'entity-derek';
        primary.dispatchEvent(new Event('change', { bubbles: true }));
        expect(getArcs()[0].primarySubjectEntityId).toBe('entity-derek');
        expect(getArcs()[0].supportingParticipantEntityIds).toEqual(['entity-gone']);

        state.modal = null;
        state.contentEl = null;
    });
});
