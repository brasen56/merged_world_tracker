/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    getArcs, getPlanHistory, makeArc, parsePlanTextToArcs, setArcs, setPlanData, state,
} from '../story_planner/data.js';
import {
    assessNewcomerEvidence, generatePlan,
} from '../story_planner/generation.js';
import { showScopedReview } from '../story_planner/render.js';
import { saveSettings } from '../story_planner/settings.js';
import { generateTargetedProposal } from '../story_planner/targeted.js';
import {
    resetCoreStubs, setFakeApi, setFakeChat,
} from './stubs/core.js';

const pairedPlan = [
    '## Horizon Arcs',
    '- [NEWCOMER:n1] The Outside Auditor — Ilyra is an independent auditor whose mandate conflicts with the established team.',
    '  1. [ENTRANCE:n1] Ilyra arrives during the records handoff and freezes the transfer.',
    '  2. Mara checks the auditor’s seal against the archive.',
].join('\n');

const establishedPlan = [
    '## Immediate Hooks',
    '- Ledger proof — Mara identifies the forged signature.',
    '- Customs witness — the established clerk confirms the archive entry.',
    '- Sealed warning — a familiar ally finds a matching counterfeit mark.',
].join('\n');

const pairedLegacyPlan = [
    pairedPlan,
    '- Existing witness — the established clerk confirms the archive entry.',
    '- Familiar warning — Mara finds the same counterfeit mark on an older record.',
].join('\n');

beforeEach(() => {
    resetCoreStubs();
    document.body.innerHTML = '';
    state.modal = document.body;
    state.contentEl = document.body;
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'phase-3c-chat' }) };
    saveSettings({ apiUrl: 'https://example.test', modelName: 'phase-3c-model' });
    setFakeChat([
        { is_user: true, name: 'User', mes: 'We compare every harbour signature against the customs archive, catalogue the counterfeit seals, interview the established clerk, and preserve the full chain of custody before deciding how to confront the discrepancy.' },
        { is_user: false, name: 'Mara', mes: 'The signatures do not match.' },
        { is_user: true, name: 'User', mes: 'We wait for the clerk.' },
    ]);
});

afterEach(() => {
    delete globalThis.SillyTavern;
    vi.restoreAllMocks();
});

describe('Story Planner V3 Phase 3C — newcomer marker parsing', () => {
    test('strips a bounded same-arc pair while retaining transient proposal evidence', () => {
        const [arc] = parsePlanTextToArcs(pairedPlan, { strictHeadings: true });

        expect(arc.title).toBe('The Outside Auditor');
        expect(arc.beats.map(beat => beat.text)).toEqual([
            'Ilyra arrives during the records handoff and freezes the transfer.',
            'Mara checks the auditor’s seal against the archive.',
        ]);
        expect(JSON.stringify(arc)).not.toContain('[NEWCOMER:');
        expect(JSON.stringify(arc)).not.toContain('[ENTRANCE:');
        expect(arc._newcomerEvidence).toEqual({ handle: 'n1', entranceBeatIndex: 0 });
    });

    test.each([
        ['missing entrance', '## Horizon Arcs\n- [NEWCOMER:n1] Auditor route — Ilyra reviews the transfer.\n  1. The records arrive.', 'missing its entrance beat'],
        ['cross-arc entrance', '## Horizon Arcs\n- [NEWCOMER:n1] Auditor route — Ilyra reviews the transfer.\n- Clerk route — the clerk stalls.\n  1. [ENTRANCE:n1] Ilyra arrives.', 'missing its entrance beat'],
        ['mismatched handles', '## Horizon Arcs\n- [NEWCOMER:n1] Auditor route — Ilyra reviews the transfer.\n  1. [ENTRANCE:n2] Ilyra arrives.', 'do not match'],
        ['duplicate handle', '## Horizon Arcs\n- [NEWCOMER:n1] Auditor route — Ilyra reviews the transfer.\n  1. [ENTRANCE:n1] Ilyra arrives.\n- [NEWCOMER:n1] Courier route — Tovan brings a seal.\n  1. [ENTRANCE:n1] Tovan interrupts the handoff.', 'reused by multiple arcs'],
        ['oversized handle', `## Horizon Arcs\n- [NEWCOMER:${'n'.repeat(25)}] Auditor route — Ilyra reviews the transfer.\n  1. [ENTRANCE:${'n'.repeat(25)}] Ilyra arrives.`, 'invalid or oversized'],
        ['entrance marker on arc row', '## Horizon Arcs\n- [ENTRANCE:n1] Auditor route — Ilyra reviews the transfer.', 'only valid on setup beats'],
        ['newcomer marker on beat', '## Horizon Arcs\n- Auditor route — Ilyra reviews the transfer.\n  1. [NEWCOMER:n1] Ilyra arrives.', 'only valid on arc rows'],
        ['entrance marker on wrapped body', '## Horizon Arcs\n- Auditor route — The records remain sealed.\n    [ENTRANCE:n1] Ilyra arrives.', 'only valid on setup beats'],
        ['newcomer marker on wrapped body', '## Horizon Arcs\n- Auditor route — The records remain sealed.\n    [NEWCOMER:n1] Ilyra arrives.', 'only valid on arc rows'],
    ])('flags %s without retaining marker text', (_label, text, reason) => {
        const arcs = parsePlanTextToArcs(text, { strictHeadings: true });
        expect(arcs.some(arc => arc._newcomerMarkerError?.includes(reason))).toBe(true);
        expect(arcs.map(arc => `${arc.title} ${arc.body} ${arc.beats.map(beat => beat.text).join(' ')}`).join(' '))
            .not.toMatch(/\[(?:NEWCOMER|ENTRANCE):/);
    });

    test('policy assessment rejects marked existing-only output and reviews propose-Add underfill', () => {
        const marked = parsePlanTextToArcs(pairedPlan, { strictHeadings: true });
        expect(assessNewcomerEvidence(marked, { policy: 'existing-only' })).toMatchObject({
            ok: false,
            reason: expect.stringContaining('Established cast only'),
        });

        const unmarked = parsePlanTextToArcs('## Horizon Arcs\n- Existing route — Mara checks the archive.', { strictHeadings: true });
        expect(assessNewcomerEvidence(unmarked, { policy: 'propose' }, { reviewed: true, operation: 'add' }))
            .toMatchObject({
                ok: true,
                validCount: 0,
                unmetRequirement: true,
                message: expect.stringContaining('Unmet cast requirement'),
            });
    });

    test('does not claim marker enforcement for an unsupported custom-template contract', () => {
        const marked = parsePlanTextToArcs(pairedPlan, { strictHeadings: true });
        expect(assessNewcomerEvidence(marked, { policy: 'existing-only', supported: false }))
            .toMatchObject({
                ok: true,
                unsupported: true,
                validCount: 0,
                message: expect.stringContaining('does not support the cast-policy contract'),
            });
    });
});

describe('Story Planner V3 Phase 3C — generation boundaries and review diagnostics', () => {
    test.each([
        ['existing-only marked newcomer', 'existing-only', pairedLegacyPlan, /Established cast only/],
        ['propose Add without pair', 'propose', establishedPlan, /required a newcomer arc/],
        ['malformed pair', 'allowed', '## Immediate Hooks\n- [NEWCOMER:n1] Broken route — Ilyra waits.\n- Second route — Mara checks the door.\n- Third route — Derek checks the seal.', /missing its entrance beat/],
        ['wrapped entrance marker', 'existing-only', '## Horizon Arcs\n- Auditor route — The records remain sealed.\n    [ENTRANCE:n1] Ilyra arrives.\n- Existing witness — the clerk confirms the handoff.\n- Familiar warning — Derek checks the seal.', /only valid on setup beats/],
    ])('direct-commit %s fails after one response and writes neither arcs nor history', async (_label, castPolicy, response, error) => {
        const existing = makeArc({ title: 'Existing plan', section: 'horizon', beats: ['Keep this beat.'] });
        setArcs([existing]);
        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy } });
        const api = vi.fn(() => response);
        setFakeApi(api);

        await expect(generatePlan(true)).rejects.toThrow(error);

        expect(api).toHaveBeenCalledTimes(1);
        expect(getArcs()).toEqual([existing]);
        expect(getPlanHistory()).toHaveLength(0);
    });

    test('scoped propose Add remains reviewable when no pair is returned and shows an unmet warning', async () => {
        setFakeApi(() => '## Horizon Arcs\n- Existing route — Mara checks the archive.');
        const proposal = await generatePlan(false, {
            operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy: 'propose',
        }, { reviewOnly: true });

        expect(proposal.diagnostics).toMatchObject({
            newcomerRequirementUnmet: true,
            newcomerPolicyMessage: expect.stringContaining('Unmet cast requirement'),
        });
        expect(getArcs()).toEqual([]);
        expect(getPlanHistory()).toEqual([]);

        showScopedReview(proposal);
        expect(document.getElementById('mwt-sp-scoped-review-modal').textContent)
            .toContain('Unmet cast requirement');
        document.querySelector('#mwt-sp-scoped-discard').click();
    });

    test('scoped existing-only rejects an entrance marker hidden on a wrapped body line', async () => {
        setFakeApi(() => [
            '## Horizon Arcs',
            '- Auditor route — The records remain sealed.',
            '    [ENTRANCE:n1] Ilyra arrives.',
        ].join('\n'));

        await expect(generatePlan(false, {
            operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy: 'existing-only',
        }, { reviewOnly: true })).rejects.toThrow(/only valid on setup beats/);

        expect(getArcs()).toEqual([]);
        expect(getPlanHistory()).toEqual([]);
    });

    test('a reviewed valid pair is marker-free and reports concrete entrance coverage', async () => {
        setFakeApi(() => pairedPlan);
        const proposal = await generatePlan(false, {
            operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy: 'propose',
        }, { reviewOnly: true });

        const added = proposal.arcs.find(arc => proposal.addedArcIds.includes(arc.id));
        expect(added.title).toBe('The Outside Auditor');
        expect(JSON.stringify(added)).not.toMatch(/\[(?:NEWCOMER|ENTRANCE):/);
        expect(proposal.diagnostics).toMatchObject({
            newcomerRequirementUnmet: false,
            newcomerPolicyMessage: expect.stringContaining('paired concrete entrance beat'),
        });
        expect(proposal.diagnostics.newcomerEvidence[0]).toMatchObject({ valid: true, handle: 'n1' });
    });

    test('a newcomer on an excluded overflow arc does not satisfy the reviewed Add requirement', async () => {
        setFakeApi(() => [
            '## Horizon Arcs',
            '- Existing route — Mara checks the archive.',
            '- [NEWCOMER:n1] Overflow auditor — Ilyra disputes the transfer.',
            '  1. [ENTRANCE:n1] Ilyra interrupts the records handoff.',
        ].join('\n'));

        const proposal = await generatePlan(false, {
            operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy: 'propose',
        }, { reviewOnly: true });

        expect(proposal.diagnostics).toMatchObject({
            overflow: 1,
            newcomerRequirementUnmet: true,
            newcomerPolicyMessage: expect.stringContaining('Unmet cast requirement'),
        });
        expect(proposal.diagnostics.newcomerEvidence).toEqual([
            expect.objectContaining({ title: 'Existing route', valid: false }),
        ]);
    });
});

describe('Story Planner V3 Phase 3C — targeted proposal evidence', () => {
    test('accepts and strips paired targeted JSON evidence without creating durable fields', async () => {
        const source = makeArc({ title: 'Harbour pact', section: 'horizon', beats: ['The clerk checks the seal.'] });
        setArcs([source]);
        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'propose' } });
        setFakeApi(() => JSON.stringify({
            title: source.title,
            description: 'An independent auditor complicates the pact.',
            section: 'horizon',
            newcomerHandle: 'n1',
            pendingBeats: [
                { text: 'Ilyra interrupts the records handoff.', entranceHandle: 'n1' },
                { text: 'Mara verifies Ilyra’s mandate.', entranceHandle: '' },
            ],
        }));

        const proposal = await generateTargetedProposal(source.id, 'develop');

        expect(proposal.newcomerEvidence).toMatchObject({
            ok: true,
            validCount: 1,
            message: expect.stringContaining('paired concrete entrance beat'),
        });
        expect(proposal.proposedArc.beats.filter(beat => beat.state === 'pending').map(beat => beat.text))
            .toEqual(['Ilyra interrupts the records handoff.', 'Mara verifies Ilyra’s mandate.']);
        expect(proposal.proposedArc).not.toHaveProperty('_newcomerHandle');
        expect(proposal.proposedArc).not.toHaveProperty('_newcomerEvidence');
        expect(getPlanHistory()).toHaveLength(0);
    });

    test('reports optional targeted propose absence and rejects existing-only explicit evidence', async () => {
        const source = makeArc({ title: 'Harbour pact', section: 'horizon', beats: ['The clerk checks the seal.'] });
        setArcs([source]);
        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'propose' } });
        setFakeApi(() => JSON.stringify({
            title: source.title, description: source.body, section: source.section,
            pendingBeats: ['The clerk checks the second seal.'],
        }));
        await expect(generateTargetedProposal(source.id, 'develop')).resolves.toMatchObject({
            newcomerEvidence: { ok: true, validCount: 0, message: 'No suitable newcomer proposed for this arc request.' },
        });

        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'existing-only' } });
        setFakeApi(() => JSON.stringify({
            title: source.title, description: source.body, section: source.section,
            newcomerHandle: 'n1',
            pendingBeats: [{ text: 'Ilyra enters the office.', entranceHandle: 'n1' }],
        }));
        await expect(generateTargetedProposal(source.id, 'develop')).rejects.toThrow(/Established cast only/);
        expect(getArcs()).toEqual([source]);
        expect(getPlanHistory()).toHaveLength(0);
    });
});