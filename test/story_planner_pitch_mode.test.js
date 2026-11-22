/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as generation from '../story_planner/generation.js';

import { getArcs, getStoryPlanRequestPreferences, setPlanData, state } from '../story_planner/data.js';
import { assessNewcomerEvidence, buildSystemPrompt, buildUserPrompt, storyPaletteProjection } from '../story_planner/generation.js';
import { ARC_DESTINATION_RULE, ARC_DESTINATION_RULE_WORLD, PITCH_VARIETY_RULE, buildStoryPlanSystemPrompt } from '../story_planner/prompts.js';
import { openGenerateDialog } from '../story_planner/render.js';
import { sanitizeArc, sanitizeStoryPlanRequest, sanitizeStoryPlanRequestPreferences } from '../story_planner/schema.js';
import { saveSettings } from '../story_planner/settings.js';
import { resetCoreStubs, setFakeApi, setFakeChat, setFakeContextExtras } from './stubs/core.js';

beforeEach(() => {
    resetCoreStubs();
    document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
    state.modal = document.body;
    state.contentEl = document.querySelector('[data-tab="story-planner"]');
});

afterEach(() => {
    document.querySelector('#mwt-sp-scoped-discard')?.click();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Story Planner — pitch mode request envelope', () => {
    test('pitchOnly is carried on Add, dropped on Refresh, and absent when off', () => {
        expect(sanitizeStoryPlanRequest({ operation: 'add', sectionKeys: ['horizon'], pitchOnly: true }).pitchOnly).toBe(true);
        expect(sanitizeStoryPlanRequest({ operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: ['a'], pitchOnly: true })).not.toHaveProperty('pitchOnly');
        expect(sanitizeStoryPlanRequest({ operation: 'add', sectionKeys: ['horizon'] })).not.toHaveProperty('pitchOnly');
        // Only a literal true turns it on: the request is rebuilt from a form.
        expect(sanitizeStoryPlanRequest({ operation: 'add', sectionKeys: ['horizon'], pitchOnly: 'yes' })).not.toHaveProperty('pitchOnly');
    });

    test('preferences keep the choice across a Refresh and stay canonical when it was never set', () => {
        expect(sanitizeStoryPlanRequestPreferences({ operation: 'refresh', sectionKeys: ['emerging'], targetArcIds: ['a'], pitchOnly: true }).pitchOnly).toBe(true);
        // A preference object saved before pitch mode existed must round-trip
        // unchanged, or loading it raises a canonicalization repair issue.
        const legacy = sanitizeStoryPlanRequestPreferences({ operation: 'add', sectionKeys: ['emerging'], requestedCount: 2 });
        expect(legacy).not.toHaveProperty('pitchOnly');
        expect(JSON.stringify(sanitizeStoryPlanRequestPreferences(legacy))).toBe(JSON.stringify(legacy));
    });
});

describe('Story Planner — pitch mode prompts', () => {
    test('the default prompt is unchanged when pitch mode is off', () => {
        for (const sections of [null, ['immediate'], ['horizon'], ['immediate', 'character']]) {
            for (const lens of ['open', 'world-pressure']) {
                expect(buildStoryPlanSystemPrompt(sections, lens, { pitchOnly: false })).toBe(buildStoryPlanSystemPrompt(sections, lens));
                expect(buildStoryPlanSystemPrompt(sections, lens)).not.toContain(PITCH_VARIETY_RULE);
            }
        }
    });

    test('a pitch prompt asks for descriptions without beats and keeps the destination rule', () => {
        const pitch = buildStoryPlanSystemPrompt(['emerging', 'horizon'], 'open', { pitchOnly: true });
        expect(pitch).toContain('This request is for pitches only.');
        expect(pitch).toContain(PITCH_VARIETY_RULE);
        expect(pitch).toContain(ARC_DESTINATION_RULE);
        expect(pitch).not.toContain('SETUP BEATS');
        // Examples keep their descriptions and lose every beat line.
        expect(pitch).toContain('- The Harbor Lease — ');
        expect(pitch).toContain('- The Spare Room — ');
        expect(pitch).not.toMatch(/^\s+\d+\.\s/m);
    });

    test('the world lens and a Hooks-only request both take pitch mode', () => {
        const world = buildStoryPlanSystemPrompt(['horizon'], 'world-pressure', { pitchOnly: true });
        expect(world).toContain(ARC_DESTINATION_RULE_WORLD);
        expect(world).toContain('- The Night Ferry — ');
        expect(world).not.toMatch(/^\s+\d+\.\s/m);

        const hooks = buildStoryPlanSystemPrompt(['immediate'], 'open', { pitchOnly: true });
        expect(hooks).toContain(PITCH_VARIETY_RULE);
        expect(hooks).not.toContain('SETUP BEATS');
    });

    test('buildSystemPrompt and the user envelope route the flag', () => {
        const request = { operation: 'add', sectionKeys: ['emerging'], requestedCount: 6, pitchOnly: true };
        expect(buildSystemPrompt(request)).toBe(buildStoryPlanSystemPrompt(['emerging'], 'open', { pitchOnly: true }));
        const user = buildUserPrompt('recent story text', '', { requestSpec: request });
        expect(user).toContain('Pitch 6 distinct new arcs across the selected sections: name and description only, no setup beats.');
        expect(user).not.toContain('Propose exactly up to');
    });

    test('the pitch palette drops the beat-level escalation and marker contract', () => {
        const palette = { emphases: ['mystery'], escalation: 'balanced', castPolicy: 'propose' };
        const text = storyPaletteProjection(palette, 'propose', 'open', { pitchOnly: true });
        expect(text).toContain('Emphasis preferences (not quotas): mystery.');
        expect(text).toContain('at least one pitch should turn on a distinct recurring or major newcomer');
        expect(text).toContain('Do not emit [NEWCOMER:*] or [ENTRANCE:*] proposal markers in a pitch.');
        expect(text).not.toContain('work against the destination');
        expect(text).not.toContain('[ENTRANCE:n1]');
        expect(storyPaletteProjection({ ...palette, escalation: 'escalating' }, 'existing-only', 'open', { pitchOnly: true }))
            .toContain('Escalation preference: escalating.');
    });

    test('newcomer evidence is not required of a pitch under the active-proposal policy', () => {
        const result = assessNewcomerEvidence([{ title: 'A pitch' }], { policy: 'propose' }, { operation: 'add', pitchOnly: true });
        expect(result).toMatchObject({ ok: true, validCount: 0 });
        expect(result.unmetRequirement).toBeUndefined();
    });
});

describe('Story Planner — pitch mode through review and Apply', () => {
    beforeEach(() => {
        setFakeContextExtras({ getCurrentChatId: () => 'pitch-chat' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'pitch-chat' }) });
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setFakeChat([
            { name: 'Mara', mes: 'The harbor crew argues about the warehouse lease while the tide comes in. '.repeat(5) },
            { name: 'User', is_user: true, mes: 'Latest turn' },
            { name: 'Mara', mes: 'Latest reply' },
        ]);
        setPlanData({
            arcs: [sanitizeArc({ id: 'arc-1', title: 'Existing arrangement', body: 'A council hearing.', section: 'emerging', status: 'active', beats: ['The clerk posts a notice.'] })],
            storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'allowed' },
            storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 3, castPolicy: 'propose', pitchOnly: true },
        });
    });

    test('pitches arrive unticked, beats and markers are dropped, and only ticked pitches are kept', async () => {
        const existing = getArcs();
        const requests = [];
        setFakeApi(async request => {
            requests.push(request);
            // The model ignores the instruction on the first pitch: it writes
            // beats and a newcomer marker with no paired entrance.
            return '## Emerging Arcs\n'
                + '- [NEWCOMER:n1] The Night Buyer — A buyer nobody knows offers cash for the lease; it builds toward the crew answering her.\n'
                + '  1. A stranger pays the harbor fee in coin.\n'
                + '  2. She asks for the lease ledger.\n'
                + '- The Missing Tally — The tally book goes missing before the audit; it builds toward the foreman accounting for it.\n'
                + '- The Low Tide — The channel silts up; it builds toward the pilots refusing the autumn fleet.';
        });
        const generate = vi.spyOn(generation, 'generatePlan');
        openGenerateDialog();
        expect(document.querySelector('#sp-generate-pitch').checked).toBe(true);
        document.querySelector('#sp-generate-submit').click();
        await vi.waitFor(() => expect(document.querySelector('#mwt-sp-scoped-apply')).not.toBeNull());

        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).toContain(PITCH_VARIETY_RULE);
        expect(requests[0].userContent).toContain('Pitch 3 distinct new arcs');

        const proposal = await generate.mock.results[0].value;
        expect(proposal.request).toMatchObject({ operation: 'add', pitchOnly: true });
        expect(proposal.diagnostics.pitchBeatsDropped).toBe(1);
        expect(proposal.diagnostics.newcomerRequirementUnmet).toBe(false);
        const added = proposal.arcs.filter(arc => proposal.addedArcIds.includes(arc.id));
        expect(added).toHaveLength(3);
        expect(added.every(arc => arc.beats.length === 0)).toBe(true);
        expect(added[0].title).toBe('The Night Buyer');

        const boxes = [...document.querySelectorAll('input[name="mwt-sp-proposal"]')];
        expect(boxes).toHaveLength(3);
        expect(boxes.some(box => box.checked)).toBe(false);
        const apply = document.querySelector('#mwt-sp-scoped-apply');
        expect(apply.textContent).toBe('Keep selected pitches');

        // Nothing ticked: nothing is saved and the review stays open.
        apply.click();
        expect(getArcs()).toEqual(existing);
        expect(document.querySelector('#mwt-sp-scoped-apply')).not.toBeNull();

        boxes[1].checked = true;
        apply.click();
        expect(getArcs()).toHaveLength(existing.length + 1);
        expect(getArcs().find(arc => arc.id === 'arc-1')).toEqual(existing[0]);
        const kept = getArcs().find(arc => arc.title === 'The Missing Tally');
        expect(kept).toMatchObject({ section: 'emerging', status: 'active' });
        expect(kept.beats).toHaveLength(0);
        expect(getArcs().some(arc => arc.title === 'The Night Buyer')).toBe(false);
        expect(getStoryPlanRequestPreferences().pitchOnly).toBe(true);
    });

    test('the pitch checkbox is disabled for Refresh and the saved choice survives it', () => {
        openGenerateDialog();
        const pitch = document.querySelector('#sp-generate-pitch');
        expect(pitch.disabled).toBe(false);
        document.querySelector('#sp-generate-refresh').checked = true;
        document.querySelector('#sp-generate-refresh').dispatchEvent(new Event('change'));
        expect(pitch.disabled).toBe(true);
        expect(document.querySelector('#sp-generate-summary').textContent).not.toContain('Pitch');
        document.querySelector('#sp-generate-add').checked = true;
        document.querySelector('#sp-generate-add').dispatchEvent(new Event('change'));
        expect(pitch.disabled).toBe(false);
        expect(document.querySelector('#sp-generate-summary').textContent).toContain('Pitch 3 new arcs (no setup beats)');
    });
});
