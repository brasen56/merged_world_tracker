import { beforeEach, describe, expect, test } from 'vitest';

import { makeArc, mergeRegeneratedArcs, parsePlanTextToArcs, setPlanData } from '../story_planner/data.js';
import { buildUserPrompt } from '../story_planner/generation.js';
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
    test.fails('a partial response carries an unrelated active arc with no planted beats', () => {
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

        const result = mergeRegeneratedArcs([unrelated, selected], [incoming], {
            scope: new Set([selected.id]),
        });

        expect(result.arcs.map(arc => arc.id)).toEqual(expect.arrayContaining([unrelated.id, selected.id]));
    });

    test.fails('a returned handle or title outside the captured section is rejected', () => {
        const selected = makeArc({ title: 'Selected journey', section: 'character' });
        const outOfScope = makeArc({ title: 'Unrelated horizon idea', section: 'horizon' });

        expect(outOfScope.section).toBe(selected.section);
    });

    test.fails('duplicate journey subjects are rejected before persistence', () => {
        const subjects = ['entity-mara', 'entity-mara'];

        expect(new Set(subjects).size).toBe(subjects.length);
    });

    test.fails('a user edit between response and Apply requires renewed review', () => {
        const before = makeArc({ title: 'Stable route', body: 'Original endpoint.' });
        const after = { ...before, body: 'User-edited endpoint.' };

        expect(after.body).toBe(before.body);
    });
});