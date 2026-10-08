import { beforeEach, describe, expect, test } from 'vitest';

import { buildSystemPrompt } from '../story_planner/generation.js';
import {
    ARC_DESTINATION_RULE,
    BEAT_PROGRESSION_RULE,
    PLAYER_AGENCY_RULE,
    STORY_GROUNDING_RULE,
    STORY_PLAN_SYSTEM_PROMPT,
    TARGETED_ARC_SYSTEM_PROMPT,
    TARGETED_OPERATION_INSTRUCTIONS,
} from '../story_planner/prompts.js';
import { SECTIONS } from '../story_planner/schema.js';
import { saveSettings } from '../story_planner/settings.js';
import { resetCoreStubs } from './stubs/core.js';

// V3 Phase 5 — arc quality. These tests pin WIRING and SCOPE only: which
// prompts carry the shared rules, and that no request is told about a section
// it did not select. A prompt containing a phrase does not demonstrate model
// behavior (roadmap §6.1); the behavioral acceptance is the §6.2 host matrix.

beforeEach(() => {
    resetCoreStubs();
    saveSettings({ apiUrl: 'https://example.test', modelName: 'arc-quality-test-model' });
});

const scoped = sectionKeys => buildSystemPrompt({ operation: 'add', sectionKeys, requestedCount: 1 });

describe('Story Planner V3 Phase 5 — arc quality prompt wiring', () => {
    test('the built-in full-plan prompt carries both shared rules and the hook exemption', () => {
        const prompt = buildSystemPrompt(null);
        expect(prompt).toBe(STORY_PLAN_SYSTEM_PROMPT);
        expect(prompt).toContain(ARC_DESTINATION_RULE);
        expect(prompt).toContain(BEAT_PROGRESSION_RULE);
        expect(prompt).toContain('An Immediate Hook can simply name a live opening');
    });

    test('a scoped request without hooks carries both rules but never names an unselected section', () => {
        for (const keys of [['character'], ['horizon'], ['emerging', 'unresolved']]) {
            const prompt = scoped(keys);
            expect(prompt).toContain(ARC_DESTINATION_RULE);
            expect(prompt).toContain(BEAT_PROGRESSION_RULE);
            expect(prompt).not.toContain('Immediate Hook');
        }
        expect(scoped(['character'])).not.toContain('Horizon Arcs');
    });

    test('a Hooks-only request gets neither rule — hooks need no setup and no turning point', () => {
        const prompt = scoped(['immediate']);
        expect(prompt).not.toContain(ARC_DESTINATION_RULE);
        expect(prompt).not.toContain(BEAT_PROGRESSION_RULE);
        expect(prompt).not.toContain('SETUP BEATS');
        expect(prompt).toContain('naming the central shift it introduces');
    });

    test('a mixed request with hooks exempts hooks from the destination rule', () => {
        const prompt = scoped(['immediate', 'character']);
        expect(prompt).toContain(ARC_DESTINATION_RULE);
        expect(prompt).toContain('An Immediate Hook can simply name a live opening');
        expect(prompt).toContain('EXCEPT those under "Immediate Hooks"');
    });

    test('beats build toward the turning point without performing it', () => {
        // Ready Now surfaces the description as the payoff once setup is
        // complete; a beat that performs the climax leaves Ready nothing to do.
        expect(STORY_PLAN_SYSTEM_PROMPT).toContain('build toward the arc\'s turning point');
        expect(BEAT_PROGRESSION_RULE).toContain('Stop short of the turning point');
    });

    test('targeted operations share the same rules rather than a second copy', () => {
        expect(TARGETED_ARC_SYSTEM_PROMPT).toContain(ARC_DESTINATION_RULE);
        expect(TARGETED_ARC_SYSTEM_PROMPT).toContain(BEAT_PROGRESSION_RULE);
    });

    test('Develop defines a stronger arc; the endpoint-preserving operations still preserve it', () => {
        expect(TARGETED_OPERATION_INSTRUCTIONS.develop).toContain('concrete turning point');
        expect(TARGETED_OPERATION_INSTRUCTIONS.develop).toContain('each beat changes the situation');
        // Rework and setup keep the stored description whatever the model
        // returns (targeted.js rebuilds it from the source arc; pinned in
        // story_planner_phase4.test.js). Their instructions must keep saying so.
        expect(TARGETED_OPERATION_INSTRUCTIONS.rework).toContain('description/endpoint, and section exactly');
        expect(TARGETED_OPERATION_INSTRUCTIONS.setup).toContain('description/endpoint, and section exactly');
    });
});

// Phase 5 follow-up (2026-10 Direction Hint trials). Same discipline as above:
// wiring and scope only. Whether models now put NPCs in front of {{user}}, or
// stop merging unrelated threads, is a live-generation question.
describe('Story Planner V3 Phase 5 follow-up — agency permission and grounding', () => {
    test('every built-in planner prompt carries the shared agency and grounding rules', () => {
        const prompts = [
            buildSystemPrompt(null),
            scoped(['character']),
            scoped(['horizon', 'emerging']),
            // Hooks have no beats, but a hook can still put words in {{user}}'s mouth.
            scoped(['immediate']),
            TARGETED_ARC_SYSTEM_PROMPT,
        ];
        for (const prompt of prompts) {
            expect(prompt).toContain(PLAYER_AGENCY_RULE);
            expect(prompt).toContain(STORY_GROUNDING_RULE);
        }
    });

    test('the agency rule grants NPC initiative and forbids assuming the answer', () => {
        expect(PLAYER_AGENCY_RULE).toContain('NPCs may still initiate with {{user}}');
        expect(PLAYER_AGENCY_RULE).toContain('never write a later beat that assumes {{user}} accepted');
    });

    test('the full-plan prompt states agency once instead of repeating prohibitions', () => {
        // The repeated bans are what read as "keep {{user}} out of the beats".
        expect(STORY_PLAN_SYSTEM_PROMPT).not.toContain('STRICTLY FORBIDDEN');
        expect(STORY_PLAN_SYSTEM_PROMPT).not.toContain('Never write a beat that requires {{user}}');
        expect(STORY_PLAN_SYSTEM_PROMPT.split(PLAYER_AGENCY_RULE)).toHaveLength(2);
    });

    test('the destination names the encounter without staging it', () => {
        expect(ARC_DESTINATION_RULE).toContain('Name the encounter but do not stage it');
        expect(ARC_DESTINATION_RULE).toContain('In one or two sentences');
    });

    test('a Character Journeys request no longer describes journeys as plot-free', () => {
        const hint = SECTIONS.find(section => section.key === 'character').hint;
        expect(hint).not.toContain('rather than a plot');
        expect(scoped(['character'])).toContain(hint);
    });
});
