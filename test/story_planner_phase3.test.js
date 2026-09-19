/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test } from 'vitest';

import {
    getArcs,
    getEffectivePlanSetting,
    getPlanHistory,
    buildParkedMemoryProjection,
    historyEntryToDiffText,
    makeArc,
    mergeRegeneratedArcs,
    parkArc,
    pushPlanToHistory,
    resumeArc,
    setArcs,
    setPlanData,
    toggleArcFocused,
    toggleArcPinned,
    updateArc,
} from '../story_planner/data.js';
import { buildInjectionBody, getArcsForInjection, getInjectionHeader } from '../story_planner/injection.js';
import { getBeatStatus } from '../story_planner/index.js';
import { buildUserPrompt } from '../story_planner/generation.js';
import { getFakeExtSettings, getFakeMeta, resetCoreStubs } from './stubs/core.js';

beforeEach(() => {
    resetCoreStubs();
    document.body.innerHTML = '';
});

describe('Story Planner Phase 3 — lifecycle and injection', () => {
    test('park/resume preserves pin, focus, beats, and note while resetting reminder age', () => {
        const arc = {
            ...makeArc({ title: 'Later', beats: ['seed'], pinned: true, focused: true }),
            turnsSinceAdvance: 18,
        };
        setArcs([arc]);
        setPlanData({ nudgeMarks: { [`${arc.id}#${arc.beats[0].id}`]: 1 } });

        parkArc(arc.id);
        updateArc(arc.id, { activateWhen: 'After the winter court arrives' });
        const parked = getArcs()[0];
        expect(parked).toMatchObject({ status: 'parked', pinned: true, focused: true, turnsSinceAdvance: 18 });
        expect(getArcsForInjection()).toEqual([]);
        expect(buildInjectionBody()).toBe('');

        resumeArc(arc.id);
        expect(getArcs()[0]).toMatchObject({
            status: 'active', pinned: true, focused: true, turnsSinceAdvance: 0,
            activateWhen: 'After the winter court arrives',
        });
        expect(getFakeMeta().story_planner_data.nudgeMarks).toEqual({});
    });

    test('pin and focus are lifecycle-neutral for parked and closed arcs', () => {
        const arcs = [
            makeArc({ title: 'Parked', status: 'parked' }),
            makeArc({ title: 'Resolved', status: 'resolved' }),
            makeArc({ title: 'Dropped', status: 'dropped' }),
        ];
        setArcs(arcs);
        for (const arc of arcs) {
            toggleArcPinned(arc.id);
            toggleArcFocused(arc.id);
        }
        expect(getArcs().map(arc => arc.status)).toEqual(['parked', 'resolved', 'dropped']);
    });

    test('focused arcs sort first in All active and assertive push prefers them', () => {
        const ordinary = makeArc({ title: 'Ordinary', beats: ['one'] });
        const focused = makeArc({ title: 'Focused', beats: ['two'], focused: true });
        setArcs([ordinary, focused]);
        setPlanData({ useGlobalDefaults: false, settingsOverride: { injectMode: 'all', enforcement: 'assertive' } });

        expect(getArcsForInjection().map(arc => arc.id)).toEqual([focused.id, ordinary.id]);
        expect(getInjectionHeader()).toContain('preferring a focused arc');

        toggleArcFocused(focused.id);
        expect(getInjectionHeader()).not.toContain('preferring a focused arc');
    });

    test('All-active body keeps sections contiguous while prioritizing focused sections', () => {
        const immediate = makeArc({ title: 'Immediate ordinary', section: 'immediate', beats: ['one'] });
        const emerging = makeArc({ title: 'Emerging ordinary', section: 'emerging', beats: ['middle'] });
        const emergingSecond = makeArc({ title: 'Emerging second', section: 'emerging', beats: ['middle two'] });
        const focusedHorizon = makeArc({ title: 'Focused horizon', section: 'horizon', beats: ['two'], focused: true });
        setArcs([emerging, focusedHorizon, immediate, emergingSecond]);
        setPlanData({ useGlobalDefaults: false, settingsOverride: { injectMode: 'all' } });

        const body = buildInjectionBody();
        expect(body).toMatch(/^## Horizon Arcs\n- Focused horizon/m);
        expect(body.indexOf('Focused horizon')).toBeLessThan(body.indexOf('Immediate ordinary'));
        expect(body.match(/## Emerging Arcs/g)).toHaveLength(1);
        expect(body).toContain('Emerging ordinary');
        expect(body).toContain('Emerging second');
        expect(body).toMatch(/Immediate ordinary[\s\S]*\n\n## Emerging Arcs/);
    });

    test('generation puts focused context first and warns against re-proposing parked titles', () => {
        const ordinary = makeArc({ title: 'Ordinary immediate', section: 'immediate' });
        const focused = makeArc({ title: 'Focused horizon', section: 'horizon', focused: true, beats: ['seed'] });
        const parked = makeArc({ title: 'Shelved conspiracy', status: 'parked' });
        setArcs([ordinary, parked, focused]);

        const prompt = buildUserPrompt('recent story');
        expect(prompt).toContain('<shelved_story_ideas>');
        expect(prompt).toContain('- Shelved conspiracy');
        expect(prompt.indexOf('## Horizon Arcs')).toBeLessThan(prompt.indexOf('## Immediate Hooks'));
    });

    test('parked-title memory is bounded and regeneration cannot duplicate a parked title', () => {
        const parked = Array.from({ length: 25 }, (_, index) => ({
            ...makeArc({ title: `Shelved ${index}`, status: 'parked' }),
            updatedAt: index,
        }));
        expect(buildParkedMemoryProjection(parked).split('\n')).toHaveLength(20);

        const incoming = makeArc({ title: '  SHELVED 24!  ', body: 'The model ignored the instruction' });
        const result = mergeRegeneratedArcs(parked, [incoming]);
        expect(result.arcs).toHaveLength(25);
        expect(result.arcs.filter(arc => arc.title.includes('SHELVED 24'))).toHaveLength(0);
        expect(result.added).toBe(0);
    });

    test('regeneration retains the Resume when note on a matched active arc', () => {
        const old = makeArc({ title: 'Seasonal', activateWhen: 'When the thaw begins', beats: ['old'] });
        const fresh = makeArc({ title: 'Seasonal', body: 'Refreshed', beats: ['new'] });
        const merged = mergeRegeneratedArcs([old], [fresh]).arcs[0];
        expect(merged.activateWhen).toBe('When the thaw begins');
    });

    test('history diff is readable and omits internal arc and beat ids', () => {
        const arc = makeArc({ title: 'Readable', beats: ['A clue appears'] });
        arc.beats[0] = { ...arc.beats[0], state: 'skipped', stateReason: 'Scene moved on' };
        const text = historyEntryToDiffText({ arcs: [arc] });
        expect(text).toContain('1. [Skipped] A clue appears — Scene moved on');
        expect(text).not.toContain(arc.id);
        expect(text).not.toContain(arc.beats[0].id);
        expect(text).not.toContain('"beats"');
    });

    test('legacy active mode normalizes at global, override, and legacy-chat provenance layers', () => {
        getFakeExtSettings().mwt_story_planner = { injectMode: 'active' };
        expect(getEffectivePlanSetting('injectMode', 'all', { provenance: true }))
            .toEqual({ value: 'all', source: 'global' });

        getFakeMeta().story_planner_data = {
            useGlobalDefaults: false,
            settingsOverride: { injectMode: 'active' },
        };
        expect(getEffectivePlanSetting('injectMode', 'all', { provenance: true }))
            .toEqual({ value: 'all', source: 'per-chat-override' });

        getFakeMeta().story_planner_data = { useGlobalDefaults: false, injectMode: 'active' };
        expect(getEffectivePlanSetting('injectMode', 'all', { provenance: true }))
            .toEqual({ value: 'all', source: 'per-chat-legacy' });
    });

    test('shared status counts active/injected/focused/ready/parked without parking overdue work', () => {
        const waiting = { ...makeArc({ title: 'Waiting', beats: ['one'], focused: true }), turnsSinceAdvance: 20 };
        const ready = makeArc({ title: 'Ready', beats: ['done'], beatIndex: 1 });
        const parked = { ...makeArc({ title: 'Parked', status: 'parked', beats: ['later'], focused: true }), turnsSinceAdvance: 50 };
        setArcs([waiting, ready, parked]);

        expect(getBeatStatus()).toEqual({
            active: 2,
            injected: 2,
            focused: 1,
            ready: 1,
            parked: 1,
            awaiting: 1,
            overdue: 1,
            lastProgressCheckAt: 0,
            lastProgressSuggestions: 0,
            progressChecks: 0,
            targetedGenerations: 0,
            fullGenerations: 0,
        });
    });

    test('shared status reports zero injected arcs while injection is off', () => {
        setArcs([makeArc({ title: 'Active' })]);
        setPlanData({ useGlobalDefaults: false, settingsOverride: { injectEnabled: false } });
        expect(getBeatStatus().injected).toBe(0);
    });

    test('activateWhen is retained exactly by history snapshots', () => {
        const arc = makeArc({ title: 'Seasonal', status: 'parked', activateWhen: 'At the thaw' });
        pushPlanToHistory([arc]);
        expect(getPlanHistory()[0].arcs[0].activateWhen).toBe('At the thaw');
    });
});

describe('Story Planner Phase 3 — lifecycle presentation', () => {
    test('renders Ready first and Parked/Archive collapsed with Park/Resume actions and note', async () => {
        const active = makeArc({ title: 'Active', beats: ['next'] });
        const ready = makeArc({ title: 'Ready', beats: ['done'], beatIndex: 1 });
        const parked = makeArc({ title: 'Parked', status: 'parked', activateWhen: 'When Mara returns' });
        const closed = makeArc({ title: 'Closed', status: 'resolved' });
        setArcs([active, parked, closed, ready]);

        const { render } = await import('../story_planner/render.js');
        document.body.innerHTML = render();
        const groups = [...document.querySelectorAll('.sp-section')];
        expect(groups[0].dataset.section).toBe('ready');
        expect(document.querySelector('[data-section="parked"]').open).toBe(false);
        expect(document.querySelector('[data-section="archive"]').open).toBe(false);
        expect(document.querySelector(`[data-action="park"][data-id="${active.id}"]`)).not.toBeNull();
        expect(document.querySelector(`[data-action="resume"][data-id="${parked.id}"]`)).not.toBeNull();
        expect(document.querySelector(`[data-action="activateWhen"][data-id="${parked.id}"]`).value).toBe('When Mara returns');
    });

    test('focused-only empty state explains why both inline and in Preview', async () => {
        setArcs([makeArc({ title: 'Not focused' })]);
        setPlanData({ useGlobalDefaults: false, settingsOverride: { injectMode: 'focused' } });
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { injectionPreviewEmptyText, renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();

        expect(document.querySelector('#sp-inject-mode-help').textContent).toContain('No active arcs are focused');
        expect(injectionPreviewEmptyText()).toContain('no active arcs are focused');

        state.modal = null;
        state.contentEl = null;
    });

    test('the parked-card note autosaves on blur', async () => {
        const parked = makeArc({ title: 'Later', status: 'parked' });
        setArcs([parked]);
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();

        const note = document.querySelector('[data-action="activateWhen"]');
        note.value = 'When the city gates reopen';
        note.dispatchEvent(new FocusEvent('blur'));
        expect(getArcs()[0].activateWhen).toBe('When the city gates reopen');

        state.modal = null;
        state.contentEl = null;
    });

    test('non-empty group state survives redraw and Park/Resume open and focus their destinations', async () => {
        const active = makeArc({ title: 'Move me', beats: ['seed'] });
        const parked = makeArc({ title: 'Already parked', status: 'parked' });
        const archived = makeArc({ title: 'Archived', status: 'resolved' });
        setArcs([active, parked, archived]);
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();

        document.querySelector('[data-section="parked"]').open = true;
        document.querySelector('[data-section="archive"]').open = true;
        document.querySelector(`[data-action="pin"][data-id="${parked.id}"]`).click();
        expect(document.querySelector('[data-section="parked"]').open).toBe(true);
        expect(document.querySelector('[data-section="archive"]').open).toBe(true);

        document.querySelector(`[data-action="park"][data-id="${active.id}"]`).click();
        expect(document.querySelector('[data-section="parked"]').open).toBe(true);
        expect(document.activeElement.dataset.action).toBe('resume');
        expect(document.activeElement.dataset.id).toBe(active.id);

        document.querySelector(`[data-section="${active.section}"]`).open = false;
        document.activeElement.click();
        expect(document.querySelector(`[data-section="${active.section}"]`).open).toBe(true);
        expect(document.activeElement.dataset.action).toBe('park');
        expect(document.activeElement.dataset.id).toBe(active.id);

        state.modal = null;
        state.contentEl = null;
    });

    test('resuming a parked Ready arc opens the Ready Now group', async () => {
        const ready = makeArc({ title: 'Parked but ready', status: 'parked', beats: ['done'], beatIndex: 1 });
        setArcs([ready]);
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();

        document.querySelector(`[data-action="resume"][data-id="${ready.id}"]`).click();

        expect(document.querySelector('[data-section="ready"]').open).toBe(true);
        expect(document.querySelector('[data-section="ready"] [data-id="' + ready.id + '"]')).not.toBeNull();

        state.modal = null;
        state.contentEl = null;
    });

    test('undoing a Ready arc opens the formerly empty active section', async () => {
        const ready = makeArc({ title: 'Ready to undo', section: 'horizon', beats: ['done'], beatIndex: 1 });
        setArcs([ready]);
        document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
        const { state } = await import('../story_planner/data.js');
        state.modal = document.body;
        state.contentEl = document.querySelector('[data-tab="story-planner"]');
        const { renderContent, wireEvents } = await import('../story_planner/render.js');
        renderContent();
        wireEvents();

        document.querySelector('[data-section="horizon"]').open = false;
        document.querySelector('[data-action="beat-back"]').click();

        expect(document.querySelector('[data-section="horizon"]').open).toBe(true);
        expect(document.querySelector(`[data-action="park"][data-id="${ready.id}"]`)).not.toBeNull();
        state.modal = null;
        state.contentEl = null;
    });
});