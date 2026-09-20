import { beforeEach, describe, expect, test } from 'vitest';

import { getArcCount, getArcs, getPlanHistory, getStoryPlanRequestPreferences, makeArc, mergeRegeneratedArcs, parsePlanTextToArcs, setArcs, setPlanData } from '../story_planner/data.js';
import { buildSystemPrompt, buildUserPrompt, selectScopedParsedArcs, validateOutput } from '../story_planner/generation.js';
import { STORY_PLAN_SYSTEM_PROMPT } from '../story_planner/prompts.js';
import { applyScopedPlanProposal, captureTargetRevisions } from '../story_planner/proposals.js';
import { sanitizeStoryPlanRequest, validateStoryPlannerData } from '../story_planner/schema.js';
import { saveSettings } from '../story_planner/settings.js';
import {
    V3_FULL_PLAN_TEMPLATE,
    V3_REQUEST_FIXTURES,
} from './fixtures/story_planner_phase0.js';
import { resetCoreStubs } from './stubs/core.js';

beforeEach(() => {
    resetCoreStubs();
    saveSettings({ apiUrl: 'https://example.test', modelName: 'phase-0-test-model' });
});

describe('Story Planner V3 Phase 0 — synthetic request fixtures', () => {
    test('section-only fixture parses to exactly its selected section and one arc', () => {
        const arcs = parsePlanTextToArcs(V3_REQUEST_FIXTURES.sectionOnlyResponse.text);

        expect(arcs).toHaveLength(V3_REQUEST_FIXTURES.sectionOnlyResponse.arcCount);
        expect(arcs.every(arc => arc.section === 'character')).toBe(true);
    });

    test('one- and two-arc fixtures remain valid bounded synthetic outputs', () => {
        const one = parsePlanTextToArcs(V3_REQUEST_FIXTURES.sectionOnlyResponse.text);
        const two = parsePlanTextToArcs(V3_REQUEST_FIXTURES.twoArcResponse.text);

        expect(one).toHaveLength(1);
        expect(two).toHaveLength(2);
        expect(two.every(arc => arc.section === 'horizon')).toBe(true);
    });

    test('selected-subject and omitted-context fixtures preserve identity handles and reasons', () => {
        const { selectedSubjects, omittedContext } = V3_REQUEST_FIXTURES;

        expect(new Set(selectedSubjects.subjectEntityIds).size).toBe(selectedSubjects.subjectEntityIds.length);
        expect(omittedContext.includedEntityIds).not.toContain('entity-missing');
        expect(omittedContext.omittedEntityIds).toContain('entity-missing');
        expect(omittedContext.omissionReason).toBe('unavailable');
    });

    test('active-proposal newcomer fixture contains no named newcomer', () => {
        const fixture = V3_REQUEST_FIXTURES.newcomerFreeResponse;

        expect(fixture.castPolicy).toBe('propose');
        expect(fixture.namedNewcomers).toHaveLength(0);
        expect(fixture.namedParticipants).toContain('Mara');
    });

    test('full-plan compatibility fixture still uses the existing template token contract', () => {
        saveSettings({
            customSystemPrompt: V3_FULL_PLAN_TEMPLATE.system,
            customUserPrompt: V3_FULL_PLAN_TEMPLATE.user,
        });
        setPlanData({ directionHint: '' });

        const prompt = buildUserPrompt('Mara checks the ledger.');

        expect(prompt).toContain('Mara checks the ledger.');
        expect(prompt).toContain('Return the complete plan.');
        expect(prompt).not.toContain('{{chatHistory}}');
        expect(prompt).not.toContain('{{previousPlan}}');
    });
});

describe('Story Planner V3 Phase 0 — red boundary specifications', () => {
    test('a scoped response carries an unrelated active arc with no planted beats', () => {
        const unrelated = makeArc({
            title: 'Unrelated horizon idea',
            section: 'horizon',
            beats: ['A future witness appears.'],
        });
        const selected = makeArc({
            title: 'Selected character journey',
            section: 'character',
            beats: ['Mara notices the seal.'],
        });
        const incoming = makeArc({
            title: selected.title,
            section: selected.section,
            beats: ['Mara compares the seals.'],
        });

        // Asserted through `scope` (the Refresh target set) as the original red
        // specification did, not through `scopeSections`: an unrelated active
        // arc must survive a scoped response on the path the dialog actually
        // uses for Refresh.
        const result = mergeRegeneratedArcs([unrelated, selected], [incoming], {
            scope: new Set([selected.id]),
        });

        expect(result.arcs.map(arc => arc.id)).toEqual(expect.arrayContaining([unrelated.id, selected.id]));
    });

    test('a returned section outside the captured scope is rejected', () => {
        expect(validateOutput('## Horizon Arcs\n- Unrelated — idea', true, {
            operation: 'add', sectionKeys: ['character'], requestedCount: 1,
        })).toMatchObject({ ok: false, reason: 'response contains a section outside the requested scope' });
    });

    test('scoped prompts do not claim deferred journey ownership or cast-policy guarantees', () => {
        const prompt = buildUserPrompt('recent', '', {
            requestSpec: {
                operation: 'add', sectionKeys: ['character'], requestedCount: 2,
                subjectMode: 'selected', subjectEntityIds: ['entity-mara'], castPolicy: 'existing-only',
            },
        });

        expect(prompt).not.toContain('Selected journey subject identities');
        expect(prompt).not.toContain('Cast policy:');
    });

    // STILL RED: journey subjects are V3 Phase 2. Restored to test.fails after
    // Phase 1 retired it prematurely — Phase 1 landing did not make this pass,
    // and it must keep failing until the ownership contract lands.
    test.fails('duplicate journey subjects are rejected before persistence', () => {
        const subjects = ['entity-mara', 'entity-mara'];

        expect(new Set(subjects).size).toBe(subjects.length);
    });

    test('a user edit between response and Apply requires renewed review', () => {
        const before = makeArc({ title: 'Stable route', body: 'Original endpoint.', section: 'horizon' });
        const proposal = {
            request: { operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: [before.id] },
            previousArcs: [before],
            targetSnapshots: [before],
            targetRevisions: captureTargetRevisions([before]),
            arcs: [{ ...before, body: 'Model refresh.' }],
            reviewArcIds: [before.id],
        };
        setArcs([{ ...before, body: 'User-edited endpoint.', updatedAt: before.updatedAt + 1 }]);

        expect(applyScopedPlanProposal(proposal, getArcs()))
            .toMatchObject({ ok: false, reason: 'targets-changed', changedTargetIds: [before.id] });
        expect(getArcs()[0].body).toBe('User-edited endpoint.');
    });

    test('scoped requests accept one or two arcs and clamp counts to one through thirty', () => {
        expect(getArcCount()).toBeGreaterThanOrEqual(1);
        const request = sanitizeStoryPlanRequest({
            operation: 'add', sectionKeys: ['character'], requestedCount: 2,
        });
        expect(validateOutput('## Character Journeys\n- One — idea', true, request).ok).toBe(true);
        expect(validateOutput('## Character Journeys\n- One — idea\n- Two — idea', true, request).ok).toBe(true);
        expect(sanitizeStoryPlanRequest({ sectionKeys: ['character'], requestedCount: 999 }).requestedCount).toBe(30);
    });

    test('scoped generation uses the built-in application envelope instead of a custom full-plan template', () => {
        saveSettings({ customUserPrompt: 'CUSTOM FULL PLAN {{chatHistory}}' });
        const prompt = buildUserPrompt('recent', '', {
            requestSpec: { operation: 'add', sectionKeys: ['character'], requestedCount: 1, castPolicy: 'allowed' },
        });
        expect(prompt).toContain('<application_request>');
        expect(prompt).toContain('Selected sections: Character Journeys.');
        expect(prompt).not.toContain('CUSTOM FULL PLAN');
    });

    test('scoped system prompts contain only the selected section formats', () => {
        const prompt = buildSystemPrompt({ operation: 'add', sectionKeys: ['character'], requestedCount: 1 });
        expect(prompt).toContain('"## Character Journeys"');
        expect(prompt).toContain('## Character Journeys');
        expect(prompt).not.toContain('## Immediate Hooks');
        expect(prompt).not.toContain('## Emerging Arcs');
        expect(prompt).not.toContain('## Horizon Arcs');
        expect(prompt).not.toContain('## Unresolved Threads');
    });

    test('scoped validation rejects unknown headings instead of treating them as Emerging Arcs', () => {
        const request = { operation: 'add', sectionKeys: ['emerging'], requestedCount: 1 };
        expect(validateOutput('## Miscellaneous\n- Wrong bucket — idea', true, request))
            .toMatchObject({ ok: false, reason: 'response contains an unrecognized section heading' });
        expect(parsePlanTextToArcs('## Miscellaneous\n- Wrong bucket — idea', { strictHeadings: true })).toEqual([]);
    });

    test('Refresh rejects a duplicate row that resolves to an already accepted target id', () => {
        const target = makeArc({ title: 'Requested route', section: 'horizon' });
        const first = { ...makeArc({ title: target.title, section: target.section, body: 'First.' }), id: target.id };
        const duplicate = { ...makeArc({ title: target.title, section: target.section, body: 'Duplicate.' }), id: target.id };
        const selection = selectScopedParsedArcs([first, duplicate], {
            operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: [target.id],
        }, [target]);
        expect(selection.accepted).toEqual([first]);
        expect(selection.rejected).toEqual([duplicate]);
    });

    test('Refresh prompt separates editable targets from bounded read-only continuity', () => {
        const target = makeArc({ title: 'Editable route', section: 'horizon', body: 'May be refreshed.' });
        const unrelated = makeArc({ title: 'Unrelated journey', section: 'character', body: 'Must remain unchanged.' });
        const prompt = buildUserPrompt('recent', '', {
            requestSpec: { operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: [target.id] },
            capturedArcs: [target],
            continuityArcs: [unrelated],
        });
        expect(prompt).toContain('<previous_plan>');
        expect(prompt).toContain('Editable route');
        expect(prompt).toContain('<read_only_continuity>');
        expect(prompt).toContain('Unrelated journey');
        expect(prompt).toContain('Do not return, rename, refresh, or otherwise edit them.');
    });

    test('scoped Add carries an ordinary pending arc and excludes its exact-title recurrence', () => {
        const existing = makeArc({ title: 'Harbour pressure', section: 'horizon', beats: ['The clerk waits.'] });
        const suggestion = makeArc({ title: existing.title, section: 'horizon', body: 'A separate new angle.' });

        const result = mergeRegeneratedArcs([existing], [suggestion], {
            scopeSections: new Set(['horizon']), addOnly: true,
        });
        expect(result.arcs).toEqual([existing]);
        expect(result.addedIds).toEqual([]);
        expect(result.excludedRecurrences).toEqual([
            expect.objectContaining({ title: existing.title, status: 'active', existingArcId: existing.id }),
        ]);
        expect(result).toMatchObject({ carried: 1, matched: 0, added: 0 });
    });

    test('scoped Refresh carries every omitted target unchanged', () => {
        const returned = makeArc({ title: 'Returned target', section: 'horizon', beats: ['Old route.'] });
        const omitted = makeArc({ title: 'Omitted target', section: 'horizon', beats: ['Still pending.'] });
        const incoming = { ...makeArc({ title: returned.title, section: returned.section, body: 'Refreshed.' }), id: returned.id };

        const result = mergeRegeneratedArcs([returned, omitted], [incoming], {
            scope: new Set([returned.id, omitted.id]),
        });

        expect(result.arcs.find(arc => arc.id === omitted.id)).toEqual(omitted);
        expect(result.matchedIds).toEqual([returned.id]);
    });

    test('Refresh rejects parsed suggestions that do not resolve to captured target identities', () => {
        const target = makeArc({ title: 'Requested route', section: 'horizon' });
        const refreshed = { ...makeArc({ title: target.title, section: target.section }), id: target.id };
        const unrequested = makeArc({ title: 'Brand new route', section: 'horizon' });

        const selection = selectScopedParsedArcs([refreshed, unrequested], {
            operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: [target.id],
        }, [target]);

        expect(selection.accepted.map(arc => arc.id)).toEqual([target.id]);
        expect(selection.rejected.map(arc => arc.title)).toEqual(['Brand new route']);
    });

    test('review Apply rebases scoped changes over unrelated live edits but rejects changed targets', () => {
        const target = makeArc({ title: 'Target', body: 'Before', section: 'horizon' });
        const unrelated = makeArc({ title: 'Unrelated', body: 'Before', section: 'character' });
        const refreshed = { ...target, body: 'After', updatedAt: target.updatedAt + 1 };
        const proposal = {
            request: { operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: [target.id] },
            previousArcs: [target, unrelated], targetSnapshots: [target], targetRevisions: captureTargetRevisions([target]), arcs: [unrelated, refreshed],
        };
        const unrelatedEdit = { ...unrelated, body: 'User edit', updatedAt: unrelated.updatedAt + 1 };
        setArcs([target, unrelatedEdit]);

        expect(applyScopedPlanProposal(proposal, getArcs()).ok).toBe(true);
        expect(getArcs().find(arc => arc.id === target.id).body).toBe('After');
        expect(getArcs().find(arc => arc.id === unrelated.id).body).toBe('User edit');

        setArcs([{ ...target, body: 'Target user edit', updatedAt: target.updatedAt + 2 }, unrelated]);
        expect(applyScopedPlanProposal(proposal, getArcs())).toMatchObject({ ok: false, reason: 'targets-changed', changedTargetIds: [target.id] });
    });

    test('reviewed Add applies only generated additions and does not duplicate a live arc created during generation', () => {
        const before = makeArc({ title: 'Before', section: 'horizon' });
        const liveAddition = makeArc({ title: 'User-added live arc', section: 'character' });
        const generated = makeArc({ title: 'Generated idea', section: 'horizon' });
        const proposal = {
            request: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 1 },
            previousArcs: [before], arcs: [before, liveAddition, generated], addedArcIds: [generated.id],
        };
        setArcs([before, liveAddition]);

        expect(applyScopedPlanProposal(proposal, getArcs()).ok).toBe(true);
        expect(getArcs().map(arc => arc.id).slice(0, 2)).toEqual([before.id, liveAddition.id]);
        expect(getArcs()[2].id).not.toBe(generated.id);
    });

    test('reviewed Apply accepts only selected proposal ids and creates one fresh stored identity', () => {
        const before = makeArc({ title: 'Before', section: 'horizon' });
        const first = makeArc({ title: 'First proposal', section: 'horizon' });
        const second = makeArc({ title: 'Second proposal', section: 'horizon' });
        setArcs([before]);

        const result = applyScopedPlanProposal({
            request: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 2 },
            previousArcs: [before], arcs: [before, first, second],
            addedArcIds: [first.id, second.id], acceptedProposalIds: [second.id],
        }, getArcs());

        expect(result.ok).toBe(true);
        expect(getArcs().map(arc => arc.title)).toEqual(['Before', 'Second proposal']);
        expect(getArcs()[1].id).not.toBe(second.id);
    });

    test('all-omitted Refresh returns no-changes without consuming history', () => {
        const target = makeArc({ title: 'Unchanged target', section: 'horizon' });
        setArcs([target]);
        const result = applyScopedPlanProposal({
            request: { operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: [target.id] },
            previousArcs: [target], targetSnapshots: [target], arcs: [target], reviewArcIds: [],
        }, getArcs());

        expect(result).toMatchObject({ ok: false, reason: 'no-changes' });
        expect(getPlanHistory()).toEqual([]);
    });

    test('Apply rechecks exact-title recurrence against live storage', () => {
        const generated = makeArc({ title: 'Concurrent route', section: 'horizon' });
        const concurrent = makeArc({ title: 'Concurrent route', section: 'horizon', status: 'parked' });
        setArcs([concurrent]);

        const result = applyScopedPlanProposal({
            request: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 1 },
            previousArcs: [], arcs: [generated], addedArcIds: [generated.id],
        }, getArcs());

        expect(result).toMatchObject({ ok: false, reason: 'no-changes' });
        expect(result.excludedRecurrences).toEqual([expect.objectContaining({ title: 'Concurrent route', status: 'parked' })]);
        expect(getArcs()).toEqual([concurrent]);
    });

    test('manual request preferences are canonical, bounded, and persisted separately per chat', () => {
        const validation = validateStoryPlannerData({
            storyPlanRequestPreferences: {
                operation: 'refresh', sectionKeys: ['horizon'], subjectMode: 'selected',
                subjectEntityIds: ['npc-a'], targetArcIds: Array.from({ length: 35 }, (_, index) => `arc-${index}`),
                requestedCount: 99, castPolicy: 'existing-only',
            },
        });
        expect(validation.data.storyPlanRequestPreferences).toMatchObject({
            operation: 'refresh', sectionKeys: ['horizon'], requestedCount: 30,
        });
        expect(validation.data.storyPlanRequestPreferences.targetArcIds).toHaveLength(30);
        // Phase 2/3 fields are not persisted while nothing sets or reads them:
        // a stored castPolicy would silently contradict the palette's
        // allowNewMajorCharacters, which is what actually drives the prompt.
        expect(validation.data.storyPlanRequestPreferences).not.toHaveProperty('castPolicy');
        expect(validation.data.storyPlanRequestPreferences).not.toHaveProperty('subjectMode');
        expect(validation.data.storyPlanRequestPreferences).not.toHaveProperty('subjectEntityIds');

        setPlanData({ storyPlanRequestPreferences: validation.data.storyPlanRequestPreferences });
        expect(getStoryPlanRequestPreferences()).toEqual(validation.data.storyPlanRequestPreferences);
    });

    test('Add selection reports visible underfill and overflow counts from the final bounded request', () => {
        const one = makeArc({ title: 'One', section: 'character' });
        const two = makeArc({ title: 'Two', section: 'character' });
        const three = makeArc({ title: 'Three', section: 'character' });
        expect(selectScopedParsedArcs([one], { operation: 'add', sectionKeys: ['character'], requestedCount: 2 }))
            .toMatchObject({ accepted: [one], underfill: 1, overflow: 0 });
        expect(selectScopedParsedArcs([one, two, three], { operation: 'add', sectionKeys: ['character'], requestedCount: 2 }))
            .toMatchObject({ accepted: [one, two], underfill: 0, overflow: 1 });
    });
});

// The prompt-shape halves of these contracts run against generatePlan in
// test/generation_commit_races.test.js, which already has the API harness.
describe('Story Planner V3 Phase 1 — scoped prompt and validation contracts', () => {
    test('bullet-formatted beats do not inflate the reviewable arc count', () => {
        const request = { operation: 'add', sectionKeys: ['character'], requestedCount: 1 };
        // One arc whose beats came back as dashes rather than the numbered
        // format. This is one arc, not four, and must not warn as an overflow.
        const text = '## Character Journeys\n- Mara faces the audit — she must choose.\n  - She stalls.\n  - She confesses.\n  - The board reacts.';
        expect(validateOutput(text, true, request)).toEqual({ ok: true });
    });

    test('a scoped request never names a section it did not select', () => {
        const prompt = buildSystemPrompt({ operation: 'add', sectionKeys: ['character'], requestedCount: 1 });
        // Not just the "## " heading form: naming Immediate Hooks in the beat
        // rules invites the model to emit a heading the validator then rejects.
        expect(prompt).not.toContain('Immediate Hooks');
        expect(prompt).not.toContain('Horizon Arcs');
        expect(prompt).toContain('SETUP BEATS');
        // An Immediate-Hooks-only request is the inverse: no beats are wanted.
        const hooksOnly = buildSystemPrompt({ operation: 'add', sectionKeys: ['immediate'], requestedCount: 1 });
        expect(hooksOnly).not.toContain('SETUP BEATS');
        expect(hooksOnly).toContain('Immediate Hooks');
    });

    test('the legacy full-plan prompt is unchanged by scoped section selection', () => {
        expect(buildSystemPrompt(null)).toBe(STORY_PLAN_SYSTEM_PROMPT);
        expect(STORY_PLAN_SYSTEM_PROMPT).toContain('Immediate Hooks');
        expect(STORY_PLAN_SYSTEM_PROMPT).toContain('Horizon Arcs');
    });
});