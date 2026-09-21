/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    getArcs, getPlanHistory, makeArc, setArcs, setPlanData, state,
} from '../story_planner/data.js';
import {
    assessNewcomerEvidence, buildReadOnlyContinuityProjection, generatePlan,
    MAX_CONTINUITY_BEATS_SHOWN, MAX_CONTINUITY_CHARS, storyPaletteProjection,
} from '../story_planner/generation.js';
import { applyScopedPlanProposal } from '../story_planner/proposals.js';
import { saveSettings } from '../story_planner/settings.js';
import { generateTargetedProposal } from '../story_planner/targeted.js';
import {
    registerSafeCharacterContextProvider, resetCoreStubs, setFakeApi, setFakeChat,
} from './stubs/core.js';

const newcomerPlan = [
    '## Horizon Arcs',
    '- [NEWCOMER:n1] The Outside Auditor — Ilyra is an independent auditor whose mandate complicates the records handoff.',
    '  1. [ENTRANCE:n1] Ilyra arrives during the handoff and freezes the transfer.',
    '  2. Mara checks Ilyra’s seal against the archive.',
].join('\n');

beforeEach(() => {
    resetCoreStubs();
    document.body.innerHTML = '';
    state.modal = document.body;
    state.contentEl = document.body;
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'phase-3d-chat' }) };
    saveSettings({ apiUrl: 'https://example.test', modelName: 'phase-3d-model' });
    setFakeChat([
        { is_user: true, name: 'User', mes: 'We compare every harbour signature against the customs archive, preserve the chain of custody, and prepare the records handoff while deciding which established witness can verify the discrepancy.' },
        { is_user: false, name: 'Mara', mes: 'The forged seal is in the ledger.' },
        { is_user: true, name: 'User', mes: 'We prepare the handoff.' },
    ]);
    registerSafeCharacterContextProvider({ listCandidates: () => [] });
});

afterEach(() => {
    delete globalThis.SillyTavern;
    vi.restoreAllMocks();
});

describe('Story Planner V3 Phase 3D — newcomer continuity', () => {
    test('bounded read-only continuity includes ordinary title, body, and beats but no transient evidence', () => {
        const arc = makeArc({
            title: 'The Outside Auditor',
            body: 'Ilyra complicates the records handoff.',
            section: 'horizon',
            beats: ['Ilyra arrives during the handoff.', 'Mara checks the seal.'],
        });
        arc._newcomerHandle = 'n1';
        arc._newcomerEvidence = { handle: 'n1', entranceBeatIndex: 0 };

        const continuity = buildReadOnlyContinuityProjection([arc]);

        expect(continuity).toContain('The Outside Auditor');
        expect(continuity).toContain('Ilyra complicates the records handoff.');
        expect(continuity).toContain('[PENDING] Ilyra arrives during the handoff.');
        expect(continuity).toContain('[PENDING] Mara checks the seal.');
        expect(continuity).not.toMatch(/NEWCOMER|ENTRANCE|n1|proposal-|_newcomer/);
    });

    test('continuity reserves projection slots for pending beats before historical beats', () => {
        const arc = makeArc({
            title: 'Delayed entrance',
            section: 'horizon',
            beats: [
                'Historical one', 'Historical two', 'Historical three', 'Historical four',
                'Pending entrance',
            ],
        });
        arc.beats.slice(0, 4).forEach(beat => { beat.state = 'planted'; });

        const continuity = buildReadOnlyContinuityProjection([arc]);

        expect(continuity).toContain('[PENDING] Pending entrance');
        expect(continuity).not.toContain('[PLANTED] Historical four');
    });

    test('continuity has an arc-atomic total-character budget with an explicit omission marker', () => {
        const arcs = Array.from({ length: 30 }, (_, index) => makeArc({
            title: `Campaign arc ${index + 1} ${'T'.repeat(90)}`,
            body: `Long-running continuity ${index + 1} ${'B'.repeat(400)}`,
            section: 'horizon',
            beats: Array.from({ length: MAX_CONTINUITY_BEATS_SHOWN }, (_unused, beat) =>
                `Beat ${beat + 1} for arc ${index + 1} ${'C'.repeat(400)}`),
        }));

        const continuity = buildReadOnlyContinuityProjection(arcs);

        expect(continuity.length).toBeLessThanOrEqual(MAX_CONTINUITY_CHARS);
        expect(continuity).toMatch(/additional active arcs omitted by the 16000-character continuity budget/);
        expect(continuity.endsWith('budget.]')).toBe(true);
    });

    test('continuity budgets the escaped model-facing text, not only the raw projection', () => {
        const arcs = Array.from({ length: 30 }, (_, index) => makeArc({
            title: `Escaped arc ${index + 1} ${'&'.repeat(80)}`,
            body: '<'.repeat(400),
            section: 'horizon',
            beats: Array.from({ length: MAX_CONTINUITY_BEATS_SHOWN }, () => '&'.repeat(400)),
        }));

        const continuity = buildReadOnlyContinuityProjection(arcs);
        const escapedLength = continuity.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').length;

        expect(escapedLength).toBeLessThanOrEqual(MAX_CONTINUITY_CHARS);
        expect(continuity).toMatch(/additional active arcs omitted/);
    });

    test('continuity display tuning is independent from the newcomer entrance validation limit', () => {
        expect(MAX_CONTINUITY_BEATS_SHOWN).toBe(4);
        expect(MAX_CONTINUITY_BEATS_SHOWN).toBeGreaterThan(0);
    });

    test('an applied newcomer arc is visible with its entrance beat to the next scoped generation', async () => {
        setFakeApi(() => newcomerPlan);
        const proposal = await generatePlan(false, {
            operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy: 'propose',
        }, { reviewOnly: true });

        expect(applyScopedPlanProposal(proposal, getArcs()).ok).toBe(true);
        const stored = getArcs()[0];
        expect(JSON.stringify(stored)).not.toMatch(/NEWCOMER|ENTRANCE|_newcomer|newcomerHandle/);

        let laterPrompt = '';
        setFakeApi(request => {
            laterPrompt = request.userContent;
            return [
                '## Immediate Hooks',
                '- Archive knock — the established clerk arrives with the duplicate ledger.',
                '- Sealed warning — Mara finds the same counterfeit mark on an older record.',
                '- Customs witness — the familiar clerk confirms the archive entry.',
            ].join('\n');
        });
        await generatePlan(false, {
            operation: 'add', sectionKeys: ['immediate'], requestedCount: 1, castPolicy: 'allowed',
        }, { reviewOnly: true });

        expect(laterPrompt).toContain('<read_only_continuity>');
        expect(laterPrompt).toContain('The Outside Auditor');
        expect(laterPrompt).toContain('Ilyra is an independent auditor');
        expect(laterPrompt).toContain('Ilyra arrives during the handoff');
        const continuityBlock = laterPrompt.match(/<read_only_continuity>([\s\S]*?)<\/read_only_continuity>/)?.[1] || '';
        expect(continuityBlock).not.toMatch(/\[(?:NEWCOMER|ENTRANCE):/);
        expect(continuityBlock).not.toMatch(/proposal-|_newcomer|newcomerHandle/);
    });

    test('one palette snapshot is reused when a rejected first attempt retries', async () => {
        setPlanData({ storyPalette: { emphases: ['mystery'], escalation: 'restrained', castPolicy: 'allowed' } });
        const prompts = [];
        setFakeApi(request => {
            prompts.push(request.userContent);
            if (prompts.length === 1) {
                setPlanData({ storyPalette: { emphases: ['conflict'], escalation: 'escalating', castPolicy: 'existing-only' } });
                return 'not a story plan';
            }
            return [
                '## Immediate Hooks',
                '- Archive knock — the established clerk arrives with the duplicate ledger.',
                '- Sealed warning — Mara finds the same counterfeit mark on an older record.',
                '- Customs witness — the familiar clerk confirms the archive entry.',
            ].join('\n');
        });

        await generatePlan(false);

        expect(prompts).toHaveLength(2);
        for (const prompt of prompts) {
            expect(prompt).toContain('mystery');
            expect(prompt).toContain('restrained');
            expect(prompt).toContain('allows new major characters');
            expect(prompt).not.toContain('Emphasis preferences (not quotas): conflict');
            expect(prompt).not.toContain('Established cast only');
        }
    });

    test('rejects a newcomer entrance on beat 5 before transient placement evidence is discarded', async () => {
        setFakeApi(() => [
            '## Horizon Arcs',
            '- [NEWCOMER:n1] The Outside Auditor — Ilyra complicates the records handoff.',
            '  1. Mara verifies the transfer docket.',
            '  2. The clerk retrieves the archived seal.',
            '  3. Derek compares the witness signatures.',
            '  4. The team schedules the formal handoff.',
            '  5. [ENTRANCE:n1] Ilyra arrives and freezes the transfer.',
        ].join('\n'));

        await expect(generatePlan(false, {
            operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy: 'propose',
        }, { reviewOnly: true })).rejects.toThrow(/entrance must be within the first 4 setup beats/);
        expect(getArcs()).toEqual([]);
    });

    test('applies the same beat-4 entrance limit to targeted JSON proposals', async () => {
        const source = makeArc({ title: 'Harbour pact', section: 'horizon', beats: ['The clerk checks the seal.'] });
        setArcs([source]);
        setPlanData({ storyPalette: { emphases: [], escalation: 'restrained', castPolicy: 'propose' } });
        setFakeApi(() => JSON.stringify({
            title: source.title,
            description: 'An independent mediator complicates the pact.',
            section: 'horizon',
            newcomerHandle: 'n1',
            pendingBeats: [
                { text: 'Mara verifies the transfer docket.', entranceHandle: '' },
                { text: 'The clerk retrieves the archived seal.', entranceHandle: '' },
                { text: 'Derek compares the witness signatures.', entranceHandle: '' },
                { text: 'The team schedules the formal handoff.', entranceHandle: '' },
                { text: 'Ilyra arrives and freezes the transfer.', entranceHandle: 'n1' },
            ],
        }));

        await expect(generateTargetedProposal(source.id, 'develop'))
            .rejects.toThrow(/entrance must be within the first 4 setup beats/);
        expect(getArcs()).toEqual([source]);
    });
});

describe('Story Planner V3 Phase 3D — continuity semantics and attribution', () => {
    test('prompt guidance separates novelty from escalation and treats unregistered story characters as established', () => {
        setPlanData({ storyPalette: { emphases: [], escalation: 'escalating', castPolicy: 'propose' } });
        const projection = storyPaletteProjection();

        expect(projection).toContain('Cast novelty and plot escalation are separate choices');
        expect(projection).toContain('friends, clients, witnesses, colleagues, relatives');
        expect(projection).toContain('already evidenced in the story is established even without a Knowledge record');
        expect(projection).toContain('Registry absence is not proof that someone is new');
    });

    test('explicit proposal success does not claim that narration introduced the newcomer', () => {
        const marked = [{
            ...makeArc({ title: 'The Outside Auditor' }),
            _newcomerHandle: 'n1', _newcomerEvidence: { handle: 'n1', entranceBeatIndex: 0 },
        }];

        expect(assessNewcomerEvidence(marked, { policy: 'propose', supported: true }, { reviewed: true }))
            .toMatchObject({
                attribution: {
                    plannerOutcome: 'proposed', proposedCount: 1, narrationOutcome: 'not-evaluated',
                    message: expect.stringContaining('not evaluated or asserted'),
                },
            });
    });

    test('unmarked prose remains accepted but explicitly requires human novelty review', () => {
        const unmarked = [makeArc({ title: 'A familiar witness', body: 'Ilyra reviews the transfer.' })];

        expect(assessNewcomerEvidence(unmarked, { policy: 'existing-only', supported: true }, { reviewed: true }))
            .toMatchObject({
                ok: true,
                attribution: {
                    plannerOutcome: 'none-explicitly-marked',
                    narrationOutcome: 'not-evaluated',
                    message: expect.stringContaining('Unmarked prose still requires human review'),
                },
            });
    });

    test('targeted proposals expose planner-versus-narration attribution without durable candidate data', async () => {
        const source = makeArc({ title: 'Harbour pact', section: 'horizon', beats: ['The clerk checks the seal.'] });
        setArcs([source]);
        setPlanData({ storyPalette: { emphases: [], escalation: 'restrained', castPolicy: 'propose' } });
        setFakeApi(() => JSON.stringify({
            title: source.title,
            description: 'An independent mediator complicates the pact without escalating it.',
            section: 'horizon',
            newcomerHandle: 'n1',
            pendingBeats: [
                { text: 'Ilyra arrives to witness the handoff.', entranceHandle: 'n1' },
                { text: 'Mara verifies Ilyra’s neutral mandate.', entranceHandle: '' },
            ],
        }));

        const proposal = await generateTargetedProposal(source.id, 'develop');

        expect(proposal.newcomerEvidence.attribution).toMatchObject({
            plannerOutcome: 'proposed', proposedCount: 1, narrationOutcome: 'not-evaluated',
        });
        expect(JSON.stringify(proposal.proposedArc)).not.toMatch(/newcomerHandle|_newcomer|entranceHandle/);
    });

    test('full-plan Add does not count a newcomer on an excluded exact-title recurrence', async () => {
        const existing = makeArc({ title: 'Existing route', section: 'horizon', beats: ['The old setup.'] });
        setArcs([existing]);
        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'propose' } });
        setFakeApi(() => [
            '## Horizon Arcs',
            '- [NEWCOMER:n1] Existing route — A newcomer is incorrectly attached to a recurrence.',
            '  1. [ENTRANCE:n1] The newcomer interrupts the old route.',
        ].join('\n'));

        await expect(generatePlan(false, {
            operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy: 'propose',
        })).rejects.toThrow(/did not survive|required a newcomer/);
        expect(getPlanHistory()).toEqual([]);
        expect(getArcs()).toEqual([existing]);
    });
});