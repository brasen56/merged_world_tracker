/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as generation from '../story_planner/generation.js';

import {
    getStoryPlanRequestPreferences,
    getArcs,
    setPlanData,
    state,
} from '../story_planner/data.js';
import { buildSystemPrompt, buildUserPrompt, storyPaletteProjection } from '../story_planner/generation.js';
import { ARC_DESTINATION_RULE_WORLD, WORLD_PRESSURE_RULE, buildStoryPlanSystemPrompt, BEAT_PROGRESSION_RULE, PLAYER_AGENCY_RULE, STORY_GROUNDING_RULE } from '../story_planner/prompts.js';
import { openGenerateDialog, renderContent, wireEvents } from '../story_planner/render.js';
import {
    SECTIONS,
    STORY_PALETTE_EMPHASES,
    STORY_PLAN_LENS_LABELS,
    STORY_PLAN_LENSES,
    sanitizeArc,
    sanitizeStoryPlanRequest,
    sanitizeStoryPlanRequestPreferences,
} from '../story_planner/schema.js';
import { saveSettings } from '../story_planner/settings.js';
import { resetCoreStubs, getFakeMeta, setFakeApi, setFakeChat, setFakeContextExtras } from './stubs/core.js';

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

describe('Story Planner — world-pressure lens vocabulary and request envelope', () => {
    test('the lens vocabulary and its labels cover exactly the same keys', () => {
        expect([...STORY_PLAN_LENSES]).toEqual(['open', 'world-pressure']);
        for (const lens of STORY_PLAN_LENSES) {
            expect(STORY_PLAN_LENS_LABELS[lens]).toEqual(expect.any(String));
        }
    });

    test('sanitizeStoryPlanRequest accepts a known lens and normalizes anything else to open', () => {
        expect(sanitizeStoryPlanRequest({ lens: 'world-pressure', sectionKeys: ['horizon'] })).toMatchObject({ lens: 'world-pressure' });
        expect(sanitizeStoryPlanRequest({ sectionKeys: ['horizon'] })).toMatchObject({ lens: 'open' });
        expect(sanitizeStoryPlanRequest({ lens: 'confetti', sectionKeys: ['horizon'] })).toMatchObject({ lens: 'open' });
    });

    test('request preferences persist the lens and normalize an absent lens to open', () => {
        expect(sanitizeStoryPlanRequestPreferences({ lens: 'world-pressure', sectionKeys: ['emerging'] })).toMatchObject({ lens: 'world-pressure' });

        setPlanData({ storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 2, lens: 'world-pressure' } });
        expect(getStoryPlanRequestPreferences().lens).toBe('world-pressure');

        setPlanData({ storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 2 } });
        expect(getStoryPlanRequestPreferences().lens).toBe('open');
    });

    test('refresh canonicalizes the lens to open for the request while saved preferences keep it', () => {
        const refresh = { operation: 'refresh', sectionKeys: ['emerging'], targetArcIds: ['arc-1'], lens: 'world-pressure', requestedCount: 3 };
        expect(sanitizeStoryPlanRequest(refresh).lens).toBe('open');
        // The model never sees a lens on a Refresh, but the preference keeps
        // the chosen lens (and the form's count) so the next Add reopens where
        // the user left off instead of resetting to Open with one idea.
        expect(sanitizeStoryPlanRequestPreferences(refresh)).toMatchObject({ lens: 'world-pressure', requestedCount: 3 });
    });
});

describe('Story Planner — world-pressure system prompt', () => {
    test('the lens swaps framing, destination language, and examples without touching structure', () => {
        const open = buildStoryPlanSystemPrompt();
        const world = buildStoryPlanSystemPrompt(null, 'world-pressure');

        // Open-lens framings absent under the lens…
        expect(open).toContain('Develop established threads and cast');
        expect(open).toContain('The Harbor Lease');
        expect(open).toContain('The Spare Room');
        expect(world).not.toContain('Develop established threads and cast');
        expect(world).not.toContain('The Harbor Lease');
        expect(world).not.toContain('The Spare Room');

        // …and world-lens framings absent from the open prompt.
        expect(world).toContain('A world complication is the setting acting on the story');
        expect(world).toContain('the setting acting on the characters, not a plan aimed at particular people');
        expect(world).toContain('names the routine or expectations the development changes');
        expect(world).toContain('The Long Dry');
        expect(world).toContain('The Night Ferry');
        expect(open).not.toContain('The Night Ferry');
        expect(open).not.toContain('A world complication');
        expect(open).not.toContain('The Long Dry');

        // Structural rules and headings are identical in both lenses.
        for (const rule of [PLAYER_AGENCY_RULE, STORY_GROUNDING_RULE, BEAT_PROGRESSION_RULE]) {
            expect(world).toContain(rule);
            expect(open).toContain(rule);
        }
        for (const section of SECTIONS) {
            expect(world).toContain(`## ${section.label}`);
            expect(open).toContain(`## ${section.label}`);
        }
    });

    test('a Hooks-only request keeps the plain bullet rule but still carries the lens rules', () => {
        const hooksWorld = buildStoryPlanSystemPrompt(['immediate'], 'world-pressure');
        expect(hooksWorld).toContain('A world complication is the setting acting on the story');
        expect(hooksWorld).toContain('Arcs under "Immediate Hooks" need no setup beats');
        // Hooks carry no destination rule in either lens.
        expect(hooksWorld).not.toContain('names the routine or expectations the development changes');
        // No beats examples belong in a Hooks-only prompt.
        expect(hooksWorld).not.toContain('The Long Dry');
    });

    test('a scoped lens prompt only teaches the requested sections', () => {
        const emergingWorld = buildStoryPlanSystemPrompt(['emerging'], 'world-pressure');
        expect(emergingWorld).toContain('## Emerging Arcs');
        expect(emergingWorld).not.toContain('## Immediate Hooks');
    });

    test('world guidance avoids schemes, abstract choices, and repeated outage examples', () => {
        const world = buildStoryPlanSystemPrompt(null, 'world-pressure');
        // The boundary is general vs. targeted, not "aimed at the cast": a
        // scheme against a rival NPC, or an official reclaiming one party's
        // warehouse, must not pass as a world development.
        expect(WORLD_PRESSURE_RULE).toContain('a decision by an institution or group that applies to everyone it reaches');
        expect(WORLD_PRESSURE_RULE).toContain('a scheme, not a world development, even when the cast is not its target');
        expect(world).not.toContain('aimed at the cast');
        expect(WORLD_PRESSURE_RULE).not.toContain('If the pressure traces back to something a person wants');
        expect(WORLD_PRESSURE_RULE).toContain('escalation preference, if one is given');
        expect(ARC_DESTINATION_RULE_WORLD).toContain('"must choose between X and Y"');
        expect(ARC_DESTINATION_RULE_WORLD).toContain('"whether X or Y is the question"');
        expect(world).not.toContain('rotation tables torn out');
        expect(world).not.toContain('streetlights come on dim');
        expect(world).not.toContain('power outage');
        // Scarcity and opportunity are both valid initiating developments.
        expect(world).not.toContain('falling below the irrigation intake');
        expect(world).toContain('emergency allocation meeting');
        expect(world).toContain('seedbeds too dry to sow');
        expect(world).toContain('keep first draw when the summer cuts come');
        expect(world).toContain('bumper harvest');
        // The opportunity example is a limited, costly window at household
        // scale, not a stakeless market that resolves itself on arrival, and
        // it shares neither setting nor posted-notice beats with The Long Dry.
        expect(world).toContain('a good Saturday could win a standing café order');
        expect(world).toContain('the ferry adds a freight charge for crated goods');
        expect(world).not.toContain('The Harvest Market');
        expect(world).not.toContain('stall registration');
        expect(world).not.toContain('temporary market');
        expect(WORLD_PRESSURE_RULE).toContain('not a catastrophe or a fortune');
        expect(WORLD_PRESSURE_RULE).toContain('adverse, beneficial, or mixed');
        expect(WORLD_PRESSURE_RULE).toContain('Do not turn every opportunity into a hidden threat');
        expect(ARC_DESTINATION_RULE_WORLD).toContain('A beneficial development needs consequential options, not an invented danger');
    });
});

describe('Story Planner — world-pressure request routing', () => {
    test('refresh ignores a supplied lens in both system and user prompts', () => {
        const requestSpec = { operation: 'refresh', sectionKeys: ['character'], targetArcIds: ['arc-1'], lens: 'world-pressure' };
        expect(buildSystemPrompt(requestSpec)).toBe(buildStoryPlanSystemPrompt(['character']));
        const prompt = buildUserPrompt('recent story text', '', { requestSpec });
        expect(prompt).not.toContain('Focus: world complications');
        expect(prompt).not.toContain('Under this focus');
        expect(prompt).toContain('The pressure can come from another character');
    });

    test('world-focused journeys and newcomers get compatible instructions', () => {
        const prompt = buildUserPrompt('recent story text', '', {
            requestSpec: { operation: 'add', sectionKeys: ['character'], lens: 'world-pressure', castPolicy: 'propose' },
        });
        expect(prompt).toContain('pressure on the Journey subject comes from the world complication');
        expect(prompt).not.toContain('The pressure can come from another character');
        expect(prompt).toContain('never decide what {{user}} thinks, chooses, or does');
        expect(prompt).toContain('include at least one distinct recurring or major newcomer');
        expect(prompt).toContain('have them arrive because of the complication');
    });

    test('the palette defines world pressure only when selected, including legacy and scoped Open paths', () => {
        const palette = { emphases: ['world pressure'], escalation: 'balanced', castPolicy: 'allowed' };
        const definition = 'World pressure means complications imposed by the setting';
        expect(storyPaletteProjection(palette)).toContain(definition);
        expect(storyPaletteProjection(palette)).toContain('adverse, beneficial, or mixed');
        expect(storyPaletteProjection(palette)).toContain('Decisions that apply to everyone they reach qualify');
        expect(storyPaletteProjection(palette)).toContain('a plan aimed at particular people does not, even when the cast is not its target');
        expect(storyPaletteProjection({ ...palette, emphases: ['romance'] })).not.toContain(definition);
        expect(buildUserPrompt('recent story text', '', { palette })).toContain(definition);
        const open = buildUserPrompt('recent story text', '', {
            palette, requestSpec: { operation: 'add', sectionKeys: ['emerging'], lens: 'open' },
        });
        expect(open).toContain(definition);
        expect(open).not.toContain('Focus: world complications');
    });

    test('buildSystemPrompt routes the lens for scoped requests and ignores it for legacy full plans', () => {
        const scopedWorld = buildSystemPrompt({ operation: 'add', sectionKeys: ['immediate', 'emerging'], lens: 'world-pressure' });
        expect(scopedWorld).toContain('A world complication is the setting acting on the story');

        const scopedOpen = buildSystemPrompt({ operation: 'add', sectionKeys: ['immediate', 'emerging'] });
        expect(scopedOpen).not.toContain('A world complication');
        // A scoped request without a lens is exactly the open-lens prompt for
        // the same sections — the lens changes nothing until it is chosen.
        expect(scopedOpen).toBe(buildStoryPlanSystemPrompt(['immediate', 'emerging']));

        // The legacy/automatic path never carries a request envelope, so its
        // prompt is exactly the open-lens default.
        expect(buildSystemPrompt(null)).toBe(buildStoryPlanSystemPrompt());
    });

    test('the scoped user prompt carries the lens focus line inside the application envelope', () => {
        const worldRequest = buildUserPrompt('recent story text', '', {
            requestSpec: { operation: 'add', sectionKeys: ['immediate', 'emerging'], requestedCount: 2, lens: 'world-pressure' },
        });
        expect(worldRequest).toContain('<application_request>');
        expect(worldRequest).toContain('Focus: world complications');
        expect(worldRequest).toContain('the setting itself acting on the story');
        expect(worldRequest).toContain('adverse, beneficial, or mixed developments');
        expect(worldRequest).toContain('Institutions and groups may create those conditions');
        expect(worldRequest).toContain('general changes that apply to everyone they reach, not a plan aimed at particular people');
        expect(worldRequest).not.toContain('aimed at the cast');

        const openRequest = buildUserPrompt('recent story text', '', {
            requestSpec: { operation: 'add', sectionKeys: ['immediate', 'emerging'], requestedCount: 2 },
        });
        expect(openRequest).toContain('<application_request>');
        expect(openRequest).not.toContain('Focus: world complications');
    });
});

describe('Story Planner — world-pressure generation through review and Apply', () => {
    beforeEach(() => {
        setFakeContextExtras({ getCurrentChatId: () => 'world-lens-chat' });
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'world-lens-chat' }) });
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setFakeChat([
            { name: 'Mara', mes: 'The valley growers bring their bumper harvest to the quiet village square. '.repeat(5) },
            { name: 'User', is_user: true, mes: 'Latest turn' },
            { name: 'Mara', mes: 'Latest reply' },
        ]);
        setPlanData({
            arcs: [sanitizeArc({ id: 'arc-1', title: 'Existing arrangement', body: 'A council hearing.', section: 'emerging', status: 'active', beats: ['The clerk posts a notice.'] })],
            storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'allowed' },
            storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 1, lens: 'world-pressure', targetArcIds: ['arc-1'] },
        });
    });

    test('Add retains its lens on dispatch, retry and review, then Apply preserves existing arcs', async () => {
        const existing = getArcs();
        const requests = [];
        setFakeApi(async request => {
            requests.push(request);
            return requests.length === 1 ? 'invalid output'
                : '## Emerging Arcs\n- The Harvest Market — The bumper harvest brings a temporary market with new buyers and goods.\n  1. Visiting traders arrive with tools and seeds.\n  2. The council posts stall registration.';
        });
        // Call-through spy observes the real proposal; generation is not mocked.
        const generate = vi.spyOn(generation, 'generatePlan');
        openGenerateDialog();
        document.querySelector('#sp-generate-submit').click();
        await vi.waitFor(() => expect(document.querySelector('#mwt-sp-scoped-apply')).not.toBeNull());
        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(request.systemPrompt).toContain(WORLD_PRESSURE_RULE);
            expect(request.systemPrompt).toContain(ARC_DESTINATION_RULE_WORLD);
            expect(request.userContent).toContain('Focus: world complications');
            expect(request.userContent).toContain('adverse, beneficial, or mixed developments');
        }
        expect(requests[1].userContent).toContain('[REMINDER:');
        const proposal = await generate.mock.results[0].value;
        expect(proposal.request).toMatchObject({ operation: 'add', lens: 'world-pressure' });
        expect(document.querySelector('#mwt-sp-scoped-apply').closest('[role="dialog"]').textContent).toContain('Focus: world complications');
        expect(getStoryPlanRequestPreferences().lens).toBe('world-pressure');
        expect(getArcs()).toEqual(existing);
        document.querySelector('#mwt-sp-scoped-apply').click();
        expect(getArcs()).toHaveLength(existing.length + 1);
        expect(getArcs().find(arc => arc.id === 'arc-1')).toEqual(existing[0]);
        expect(getArcs().find(arc => arc.title === 'The Harvest Market')).toMatchObject({ section: 'emerging', status: 'active' });
    });

    test('Refresh dispatch and review use Open while the saved Add lens and count survive', async () => {
        setPlanData({ storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 4, lens: 'world-pressure', targetArcIds: ['arc-1'] } });
        const requests = [];
        setFakeApi(async request => {
            requests.push(request);
            return '## Emerging Arcs\n- [ARC:arc-1] Existing arrangement — The council hearing now includes the growers.\n  1. The clerk delivers the revised notice.';
        });
        const generate = vi.spyOn(generation, 'generatePlan');
        const existing = getArcs();
        openGenerateDialog();
        document.querySelector('#sp-generate-refresh').checked = true;
        document.querySelector('#sp-generate-refresh').dispatchEvent(new Event('change'));
        document.querySelector('#sp-generate-submit').click();
        await vi.waitFor(() => expect(document.querySelector('#mwt-sp-scoped-apply')).not.toBeNull());
        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).toBe(buildStoryPlanSystemPrompt(['emerging']));
        expect(requests[0].userContent).not.toContain('Focus: world complications');
        const proposal = await generate.mock.results[0].value;
        expect(proposal.request).toMatchObject({ operation: 'refresh', lens: 'open', targetArcIds: ['arc-1'] });
        expect(getStoryPlanRequestPreferences()).toMatchObject({ lens: 'world-pressure', requestedCount: 4 });
        expect(getArcs()).toEqual(existing);
        document.querySelector('#mwt-sp-scoped-apply').click();
        expect(getArcs()).toHaveLength(existing.length);
        expect(getArcs().find(arc => arc.id === 'arc-1').body).toContain('now includes the growers');
    });
});

describe('Story Planner — Generate dialog lens control', () => {
    test('refresh disables lens radios and returning to Add restores the selected lens', () => {
        setPlanData({
            arcs: [sanitizeArc({ id: 'arc-1', title: 'Dockmaster scheme', body: 'A hearing.', section: 'emerging', status: 'active', beats: [] })],
            storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], lens: 'world-pressure', targetArcIds: ['arc-1'] },
        });
        openGenerateDialog();
        const world = document.querySelector('#sp-generate-lens-world');
        const open = document.querySelector('#sp-generate-lens-open');
        const refresh = document.querySelector('#sp-generate-refresh');
        refresh.checked = true;
        refresh.dispatchEvent(new Event('change'));
        expect(world.disabled).toBe(true);
        expect(open.disabled).toBe(true);
        expect(document.getElementById('sp-generate-summary').textContent).not.toContain('Focus: world complications');
        const add = document.querySelector('#sp-generate-add');
        add.checked = true;
        add.dispatchEvent(new Event('change'));
        expect(world.disabled).toBe(false);
        expect(open.disabled).toBe(false);
        expect(world.checked).toBe(true);
        expect(document.getElementById('sp-generate-summary').textContent).toContain('Focus: world complications');
        document.querySelector('#sp-generate-cancel').click();
    });

    test('a dialog reopened for Refresh starts with lens controls disabled', () => {
        setPlanData({ storyPlanRequestPreferences: { operation: 'refresh', sectionKeys: ['emerging'], lens: 'world-pressure' } });
        openGenerateDialog();
        expect(document.querySelector('#sp-generate-lens-world').disabled).toBe(true);
        expect(document.querySelector('#sp-generate-lens-open').disabled).toBe(true);
        expect(document.getElementById('mwt-sp-generate-modal').textContent).toContain('Refresh preserves existing arc premises');
        document.querySelector('#sp-generate-cancel').click();
    });

    test('the dialog reflects the saved lens and the summary announces the focus', () => {
        setPlanData({ storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 2, lens: 'world-pressure' } });
        openGenerateDialog();

        expect(document.querySelector('#sp-generate-lens-world')?.checked).toBe(true);
        expect(document.querySelector('#sp-generate-lens-open')?.checked).toBe(false);
        expect(document.getElementById('mwt-sp-generate-modal').textContent).toContain('World complications');
        expect(document.getElementById('sp-generate-summary').textContent).toContain('Focus: world complications');

        document.querySelector('#sp-generate-cancel').click();
    });

    test('switching the lens updates the request summary live', () => {
        setPlanData({ storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 1 } });
        openGenerateDialog();

        const summary = document.getElementById('sp-generate-summary');
        expect(summary.textContent).not.toContain('Focus: world complications');

        document.querySelector('#sp-generate-lens-open').checked = false;
        document.querySelector('#sp-generate-lens-world').checked = true;
        document.querySelector('#sp-generate-lens-world').dispatchEvent(new Event('change'));
        expect(summary.textContent).toContain('Focus: world complications');

        document.querySelector('#sp-generate-cancel').click();
    });

    test('submitting a valid world-pressure request persists the lens preference', () => {
        setPlanData({ storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 1 } });
        openGenerateDialog();

        document.querySelector('#sp-generate-lens-open').checked = false;
        document.querySelector('#sp-generate-lens-world').checked = true;
        document.querySelector('#sp-generate-lens-world').dispatchEvent(new Event('change'));
        // The click handler persists preferences synchronously before the
        // first await, so no generation stub is needed for this assertion.
        document.querySelector('#sp-generate-submit').click();

        expect(getFakeMeta().story_planner_data.storyPlanRequestPreferences.lens).toBe('world-pressure');
        document.querySelector('#sp-generate-cancel').click();
    });

    test('submitting a refresh keeps the saved lens and add count', () => {
        setPlanData({
            arcs: [sanitizeArc({ id: 'arc-1', title: 'Dockmaster scheme', body: 'A hearing.', section: 'emerging', status: 'active', beats: [] })],
            storyPlanRequestPreferences: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 4, lens: 'world-pressure', targetArcIds: ['arc-1'] },
        });
        openGenerateDialog();

        document.querySelector('#sp-generate-refresh').checked = true;
        document.querySelector('#sp-generate-refresh').dispatchEvent(new Event('change'));
        // The click handler persists preferences synchronously before the
        // first await, so no generation stub is needed for this assertion.
        document.querySelector('#sp-generate-submit').click();

        expect(getFakeMeta().story_planner_data.storyPlanRequestPreferences.lens).toBe('world-pressure');
        expect(getFakeMeta().story_planner_data.storyPlanRequestPreferences.requestedCount).toBe(4);
        document.querySelector('#sp-generate-cancel').click();
    });

    test('world pressure is a palette emphasis and the settings list derives from the vocabulary', () => {
        expect(STORY_PALETTE_EMPHASES).toContain('world pressure');
        renderContent();
        wireEvents();

        const input = document.querySelector('input[name="sp-palette-emphasis"][value="world pressure"]');
        expect(input).not.toBeNull();
        input.checked = true;
        document.querySelector('#sp-save-settings').click();

        expect(getFakeMeta().story_planner_data.storyPalette.emphases).toContain('world pressure');
    });
});
