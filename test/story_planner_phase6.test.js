/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildSafeCharacterContext, registerSafeCharacterContextProvider } from '../core/character_context.js';
import { sanitizeCharacterContextSelection, sanitizeStoryPalette, validateStoryPlannerData, MAX_CHARACTER_CONTEXT_ENTITY_ID_LENGTH } from '../story_planner/schema.js';
import { buildUserPrompt, generatePlan } from '../story_planner/generation.js';
import { buildTargetedUserPrompt, generateTargetedProposal } from '../story_planner/targeted.js';
import { makeArc, setArcs, setPlanData, state } from '../story_planner/data.js';
import { saveSettings } from '../story_planner/settings.js';
import { renderContent, wireEvents } from '../story_planner/render.js';
import { getEvents, getFakeMeta, resetCoreStubs, setFakeApi, setFakeChat, setFakeContextExtras } from './stubs/core.js';

beforeEach(() => {
    resetCoreStubs();
    registerSafeCharacterContextProvider(null);
    document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
    state.contentEl = document.querySelector('[data-tab="story-planner"]');
});

afterEach(() => vi.unstubAllGlobals());

describe('Story Planner Phase 6 — palette and safe character grounding', () => {
    test('full and targeted prompts share the exact palette projection', () => {
        setPlanData({ storyPalette: { emphases: ['quiet moments'], escalation: 'restrained', allowNewMajorCharacters: true } });
        const block = prompt => prompt.match(/<story_palette>[\s\S]*?<\/story_palette>/)?.[0];
        const full = block(buildUserPrompt('recent'));
        expect(full).toBeTruthy();
        expect(block(buildTargetedUserPrompt('develop', makeArc({ title: 'Repair' })))).toBe(full);
    });

    test('off mode skips the provider and does not churn diagnostics in either generation path', async () => {
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'phase-6-chat' }) });
        const buildContext = vi.fn(() => { throw new Error('off must not read Knowledge'); });
        registerSafeCharacterContextProvider({ buildContext });
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setFakeChat([
            { name: 'Mara', mes: 'Mara waits at the harbour office to discuss repairing the damaged pier. '.repeat(5) },
            { name: 'User', is_user: true, mes: 'unstable turn' },
            { name: 'Mara', mes: 'unstable reply' },
        ]);
        const arc = makeArc({ title: 'Repair', body: 'Repair the pier.', beats: ['Mara checks the timber.'] });
        setArcs([arc]);
        setFakeApi(() => '## Immediate Hooks\n- Repair — Mara offers to inspect the pier.\n- Timber — Ivo checks the spare wood.\n- Rest — Mara suggests a quiet break.');
        expect(await generatePlan()).not.toBeNull();
        setArcs([arc]);
        setFakeApi(() => JSON.stringify({ title: 'Repair', description: 'Repair the pier.', section: 'horizon', pendingBeats: ['Mara brings timber.'] }));
        expect(await generateTargetedProposal(arc.id)).not.toBeNull();
        expect(buildContext).not.toHaveBeenCalled();
        expect(getEvents().filter(event => event.event === 'safe_character_context')).toEqual([]);
    });

    test('empty dossiers are omitted; bounded structured stances count as useful context without leaking ids or private notes', async () => {
        const { buildPlannerCharacterContext, SAFE_CHARACTER_CONTEXT_MAX_RECORD_CHARS } = await import('../knowledge/planner_context.js');
        const { state: knowledgeState } = await import('../knowledge/state.js');
        const { _setCacheForTests } = await import('../knowledge/store.js');
        knowledgeState.wiScript = { loadWorldInfo: async () => ({ entries: {
            7: { uid: 7, comment: 'Mara', content: 'Mara | Human |\nSecrets: hidden motive' },
            8: { uid: 8, comment: 'Ivo', content: 'Ivo | Human |\nSecrets: another secret' },
        } }) };
        const registry = { Mara: { entityId: 'internal-mara', uid: 7 }, Ivo: { entityId: 'internal-ivo', uid: 8 } };
        const selection = { mode: 'selected', entityIds: ['internal-mara', 'internal-ivo'] };
        _setCacheForTests('Knowledge Tracker', { registry });
        expect(await buildPlannerCharacterContext(selection)).toMatchObject({ text: '', records: 0, requested: 2, omitted: 2, chars: 0, tokens: 0 });
        _setCacheForTests('Knowledge Tracker', {
            registry, stances: { Mara: 'wary', Ivo: 'hostile because of a SECRET' },
            relationships: { Mara: [{ target: 'Ivo', type: 'rival', notes: 'SECRET relationship note' }] },
        });
        const result = await buildPlannerCharacterContext(selection);
        expect(result).toMatchObject({ records: 1, requested: 2, omitted: 1 });
        expect(result.text).toBe('Character: Mara\nStance toward the player character: wary');
        expect(result.text.length).toBeLessThanOrEqual(SAFE_CHARACTER_CONTEXT_MAX_RECORD_CHARS);
        expect(result.chars).toBe(result.text.length);
        expect(result.tokens).toBe(Math.ceil(result.text.length / 4));

        _setCacheForTests('Knowledge Tracker', { registry, stances: { Mara: 'neutral' } });
        expect(await buildPlannerCharacterContext(selection)).toMatchObject({
            text: '', records: 0, requested: 2, omitted: 2, chars: 0, tokens: 0,
        });
    });

    test('coverage completeness measures projection truncation rather than total dossier size or filled field slots', async () => {
        const { buildPlannerCharacterContext, SAFE_CHARACTER_CONTEXT_PUBLIC_FIELD_COUNT } = await import('../knowledge/planner_context.js');
        const { state: knowledgeState } = await import('../knowledge/state.js');
        const { _setCacheForTests } = await import('../knowledge/store.js');
        const registry = {
            Derek: { entityId: 'npc-derek', uid: 1 },
            Ranger: { entityId: 'npc-ranger', uid: 2 },
            Verbose: { entityId: 'npc-verbose', uid: 3 },
        };
        knowledgeState.wiScript = { loadWorldInfo: async () => ({ entries: {
            1: {
                uid: 1, comment: 'Derek',
                content: `[Dossier] Derek | Human |\nRole: Magistrate\nAppearance: ${'ornate detail '.repeat(80)}\nVoice: ${'measured '.repeat(80)}\nAgenda: private plan`,
            },
            2: {
                uid: 2, comment: 'Ranger',
                content: '[Dossier] Ranger | Human |\nRole: Scout\nPersonality: Direct\nBackground: Border patrol veteran\nWhere to Find: North gate\nSecrets: private',
            },
            3: {
                uid: 3, comment: 'Verbose',
                content: `[Dossier] Verbose | Human |\nRole: ${'very long public role '.repeat(30)}\nSecrets: private`,
            },
        } }) };
        _setCacheForTests('Knowledge Tracker', { registry, stances: { Ranger: 'wary' } });

        const result = await buildPlannerCharacterContext({
            mode: 'selected', entityIds: ['npc-derek', 'npc-ranger', 'npc-verbose'],
            primarySubjectEntityIds: ['npc-derek'],
        });

        expect(SAFE_CHARACTER_CONTEXT_PUBLIC_FIELD_COUNT).toBe(5);
        expect(result.coverage.find(item => item.entityId === 'npc-derek')).toMatchObject({
            status: 'complete', fields: 1, availableFields: 1, supportedFields: 5, isPrimarySubject: true,
        });
        expect(result.coverage.find(item => item.entityId === 'npc-ranger')).toMatchObject({
            status: 'complete', fields: 5, availableFields: 5, supportedFields: 5, isPrimarySubject: false,
        });
        expect(result.coverage.find(item => item.entityId === 'npc-verbose')).toMatchObject({
            status: 'partial', fields: 1, availableFields: 1, supportedFields: 5,
        });
        expect(result.text).not.toContain('ornate detail');
        expect(result.text).not.toContain('measured');
        expect(result.text).not.toContain('private plan');
    });

    test('canonicalizes palette and entity-id selections to bounded safe values', () => {
        expect(sanitizeStoryPalette({ emphases: ['quiet moments', 'quiet moments', 'invalid'], escalation: 'invalid', allowNewMajorCharacters: 'yes' }))
            .toEqual({ emphases: ['quiet moments'], escalation: 'balanced', allowNewMajorCharacters: false });
        expect(sanitizeCharacterContextSelection({ mode: 'selected', entityIds: ['npc-a', 'npc-a', '', 'npc-b'] }))
            .toEqual({ mode: 'selected', entityIds: ['npc-a', 'npc-b'] });
    });

    test('canonicalizes Phase 6 fields at the store boundary and reports repairs', () => {
        const malformed = validateStoryPlannerData({
            storyPalette: { emphases: ['invalid'], escalation: 'invalid', allowNewMajorCharacters: 'yes' },
            characterContext: { mode: 'selected', entityIds: [`${'x'.repeat(MAX_CHARACTER_CONTEXT_ENTITY_ID_LENGTH + 20)}`, 'ok'] },
        });
        expect(malformed.data.storyPalette).toEqual({ emphases: [], escalation: 'balanced', allowNewMajorCharacters: false });
        expect(malformed.data.characterContext.entityIds[0]).toHaveLength(MAX_CHARACTER_CONTEXT_ENTITY_ID_LENGTH);
        expect(malformed.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
            'story-palette-canonicalized', 'character-context-canonicalized',
        ]));
    });

    test('default palette remains balanced while an explicit quiet/restrained palette reaches full-plan prompts', () => {
        expect(buildUserPrompt('recent')).not.toContain('<story_palette>');
        setPlanData({ storyPalette: { emphases: ['quiet moments'], escalation: 'restrained', allowNewMajorCharacters: false } });
        const prompt = buildUserPrompt('recent');
        expect(prompt).toContain('<story_palette>');
        expect(prompt).toContain('quiet moments');
        expect(prompt).toContain('restrained');
        expect(prompt).toContain('Emphasis preferences (not quotas)');
    });

    // Regression: both Phase 6 blocks were originally APPENDED to the rendered
    // template, which put them after "Output the story plan now. Begin
    // immediately with the first section heading." A tag trailing the closing
    // instruction invites the preamble validateOutput() rejects, which costs a
    // silent retry. They belong with the other grounding blocks, above it.
    test('palette and character blocks sit above the closing instruction, not after it', () => {
        setPlanData({ storyPalette: { emphases: ['quiet moments'], escalation: 'restrained', allowNewMajorCharacters: false } });
        const prompt = buildUserPrompt('recent', '', {
            characterContext: { text: 'Character: Mara\nPublic role: Harbourmaster' },
        });
        const closing = prompt.indexOf('Output the story plan now.');
        expect(closing).toBeGreaterThan(-1);
        expect(prompt.indexOf('<story_palette>')).toBeLessThan(closing);
        expect(prompt.indexOf('<safe_character_context>')).toBeLessThan(closing);
        // The closing instruction stays last — only the retry reminder may follow.
        expect(prompt.trimEnd().endsWith('Begin immediately with the first section heading.')).toBe(true);
    });

    // A custom template gets a block only where it asks for one — the same
    // contract every other token has had.
    test('custom user prompts receive the blocks only through their tokens', () => {
        setPlanData({ storyPalette: { emphases: ['mystery'], escalation: 'escalating', allowNewMajorCharacters: false } });
        const context = { characterContext: { text: 'Character: Mara' } };

        saveSettings({ customUserPrompt: 'Plan it.\n{{chatHistory}}' });
        const without = buildUserPrompt('recent', '', context);
        expect(without).not.toContain('<story_palette>');
        expect(without).not.toContain('<safe_character_context>');

        saveSettings({ customUserPrompt: 'Plan it.\n{{storyPalette}}\n{{safeCharacterContext}}\n{{chatHistory}}' });
        const withTokens = buildUserPrompt('recent', '', context);
        expect(withTokens).toContain('<story_palette>');
        expect(withTokens).toContain('<safe_character_context>');
    });

    test('safe character context is explicitly opt-in and never leaks a provider error into planning', async () => {
        expect(await buildSafeCharacterContext({ mode: 'selected', entityIds: ['npc-a'] })).toMatchObject({ text: '', records: 0 });
        registerSafeCharacterContextProvider({
            buildContext: async () => ({ text: 'Character: Mara\nPublic role: Harbourmaster', records: 1, requested: 1, omitted: 0 }),
            listCandidates: () => [{ entityId: 'npc-a', name: 'Mara' }],
        });
        setPlanData({ characterContext: { mode: 'selected', entityIds: ['npc-a'] } });
        const context = await buildSafeCharacterContext({ mode: 'selected', entityIds: ['npc-a'] });
        const prompt = buildUserPrompt('recent', '', { characterContext: context });
        expect(prompt).toContain('<safe_character_context>');
        expect(prompt).toContain('Public role: Harbourmaster');
        expect(prompt).not.toContain('Secrets:');
    });

    test('context Off reports selected Journey subjects as disabled without projecting dossier text', async () => {
        const buildContext = vi.fn(async selection => ({
            text: 'PRIVATE DOSSIER TEXT', records: 4, requested: 1, omitted: 1, chars: 20, tokens: 5, status: 'disabled',
            coverage: [{ entityId: selection.primarySubjectEntityIds[0], name: 'Mara', status: 'disabled', records: 0, fields: 0, chars: 0, tokens: 0, estimated: true }],
        }));
        registerSafeCharacterContextProvider({ buildContext });

        const result = await buildSafeCharacterContext({
            mode: 'off', entityIds: [], primarySubjectEntityIds: ['npc-a'],
        });

        expect(buildContext).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            text: '', records: 0, chars: 0, tokens: 0,
            status: 'disabled', requested: 1, omitted: 1,
        });
        expect(result.coverage).toEqual([expect.objectContaining({ entityId: 'npc-a', status: 'disabled' })]);
    });

    test('active-cast context resolves aliases to canonical registry names', async () => {
        const { buildPlannerCharacterContext } = await import('../knowledge/planner_context.js');
        const { state: knowledgeState } = await import('../knowledge/state.js');
        getFakeMeta().world_state_tracker_metadata = { text: '## Current Scene\nPresent: The Vixen\n' };
        knowledgeState.wiScript = { loadWorldInfo: async () => ({ entries: { 7: { uid: 7, comment: 'Mara Vance', content: '[Dossier] Mara Vance | Human |\nRole: Harbourmaster\nSecrets: Never share this' } } }) };
        // Registry storage is normally hydrated from the Knowledge store; inject
        // the public cache seam for this focused adapter test.
        const { _setCacheForTests } = await import('../knowledge/store.js');
        _setCacheForTests('Knowledge Tracker', {
            registry: { 'Mara Vance': { entityId: 'npc-a', uid: 7, aliases: ['The Vixen'] } },
        });
        const result = await buildPlannerCharacterContext({ mode: 'active' });
        expect(result.text).toContain('Character: Mara Vance');
        expect(result.text).not.toContain('Never share this');
    });

    test('selected context resolves an absorbed entity id through mergedFrom', async () => {
        const { buildPlannerCharacterContext } = await import('../knowledge/planner_context.js');
        const { state: knowledgeState } = await import('../knowledge/state.js');
        const { _setCacheForTests } = await import('../knowledge/store.js');
        knowledgeState.wiScript = { loadWorldInfo: async () => ({ entries: { 7: { uid: 7, comment: 'Mara', content: 'Mara | Human |\nRole: Harbourmaster' } } }) };
        _setCacheForTests('Knowledge Tracker', {
            registry: { Mara: { entityId: 'survivor', uid: 7, mergedFrom: [{ entityId: 'absorbed', name: 'Old Mara', at: 1 }] } },
        });
        const result = await buildPlannerCharacterContext({ mode: 'selected', entityIds: ['absorbed'] });
        expect(result.records).toBe(1);
        expect(result.text).toContain('Character: Mara');
    });

    test('stale selected entity ids receive per-entity unavailable coverage', async () => {
        const { buildPlannerCharacterContext } = await import('../knowledge/planner_context.js');
        const { _setCacheForTests } = await import('../knowledge/store.js');
        _setCacheForTests('Knowledge Tracker', { registry: {} });

        const result = await buildPlannerCharacterContext({ mode: 'selected', entityIds: ['entity-removed'] });

        expect(result).toMatchObject({ requested: 1, records: 0, omitted: 1 });
        expect(result.coverage).toEqual([expect.objectContaining({
            entityId: 'entity-removed', status: 'unavailable', records: 0,
        })]);
    });

    // Regression: extractDossierFieldValues matches one LINE at a time, so a
    // private field whose own value contains a newline + "Role:" was read back
    // out as a public role. formatDossierEntry omits empty fields, so there
    // need not be a real Role: line ahead of it to win the match.
    test('a private field cannot smuggle a public-looking line into the projection', async () => {
        const { buildPlannerCharacterContext, publicDossierSection } = await import('../knowledge/planner_context.js');
        const { state: knowledgeState } = await import('../knowledge/state.js');
        const { _setCacheForTests } = await import('../knowledge/store.js');
        const content = [
            '[Dossier] Mara | Human |',
            'Where to Find: the harbour office',
            'Secrets: Tier 3 (buried): she poisoned the old harbourmaster',
            'Role: THE SMUGGLED LINE',
            '',
            'Knowledge Ledger:',
            '- Role: a ledger line that also looks like a field',
        ].join('\n');
        knowledgeState.wiScript = { loadWorldInfo: async () => ({ entries: { 7: { uid: 7, comment: 'Mara', content } } }) };
        _setCacheForTests('Knowledge Tracker', { registry: { Mara: { entityId: 'npc-a', uid: 7 } } });

        const result = await buildPlannerCharacterContext({ mode: 'selected', entityIds: ['npc-a'] });
        expect(result.records).toBe(1);
        // The legitimate field above the boundary still lands.
        expect(result.text).toContain('Public location: the harbour office');
        // Nothing at or below the first private label does.
        expect(result.text).not.toContain('THE SMUGGLED LINE');
        expect(result.text).not.toContain('poisoned');
        expect(result.text).not.toContain('ledger line');

        // The cut tolerates leading whitespace the extractor's ^ anchor would not.
        expect(publicDossierSection('Role: ok\n   Secrets: hidden\nRole: sneaky')).toBe('Role: ok');
        expect(publicDossierSection(null)).toBe('');
    });

    test('disabled Knowledge provider returns an empty grounding projection', async () => {
        const { buildPlannerCharacterContext, listPlannerCharacterCandidates, resolvePlannerCharacterEntities } = await import('../knowledge/planner_context.js');
        const { state: knowledgeState } = await import('../knowledge/state.js');
        const { _setCacheForTests } = await import('../knowledge/store.js');
        setFakeContextExtras({ globalSettings: { enableKnowledge: false } });
        knowledgeState.wiScript = { loadWorldInfo: async () => { throw new Error('should not read lorebook'); } };
        _setCacheForTests('Knowledge Tracker', { registry: {
            Mara: { entityId: 'npc-a', uid: 7, mergedFrom: [{ entityId: 'npc-a-old', name: 'Old Mara', at: 1 }] },
            Ivo: { entityId: 'npc-b', uid: 8 },
        } });
        await expect(buildPlannerCharacterContext({
            mode: 'selected', entityIds: ['npc-a-old', 'npc-a', 'npc-b'], primarySubjectEntityIds: ['npc-a'],
        })).resolves.toMatchObject({
            text: '', records: 0, requested: 2, omitted: 2, chars: 0, tokens: 0,
            status: 'disabled',
            coverage: [
                expect.objectContaining({ entityId: 'npc-a', name: 'Mara', status: 'disabled' }),
                expect.objectContaining({ entityId: 'npc-b', name: 'Ivo', status: 'disabled' }),
            ],
        });
        expect(listPlannerCharacterCandidates()).toEqual([
            expect.objectContaining({ entityId: 'npc-b', name: 'Ivo' }),
            expect.objectContaining({ entityId: 'npc-a', name: 'Mara' }),
        ]);
        expect(resolvePlannerCharacterEntities(['npc-a'])).toMatchObject({
            resolved: [expect.objectContaining({ requestedEntityId: 'npc-a', entityId: 'npc-a' })],
            missing: [], available: true,
        });
    });

    test('selected primary subjects are prioritized within eligible context and disabled omissions are explicit', async () => {
        const { buildPlannerCharacterContext } = await import('../knowledge/planner_context.js');
        const { state: knowledgeState } = await import('../knowledge/state.js');
        const { _setCacheForTests } = await import('../knowledge/store.js');
        const registry = Object.fromEntries(Array.from({ length: 7 }, (_, index) => {
            const name = `NPC ${index + 1}`;
            return [name, { entityId: `npc-${index + 1}`, uid: index + 1 }];
        }));
        knowledgeState.wiScript = {
            loadWorldInfo: async () => ({
                entries: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [index + 1, {
                    uid: index + 1, comment: `NPC ${index + 1}`, content: `NPC ${index + 1} | Human |\nRole: Role ${index + 1}`,
                }])),
            }),
        };
        _setCacheForTests('Knowledge Tracker', { registry });

        const selected = await buildPlannerCharacterContext({
            mode: 'selected', entityIds: Object.values(registry).map(item => item.entityId),
            primarySubjectEntityIds: ['npc-7'],
        });
        expect(selected.text.split('\n')[0]).toBe('Character: NPC 7');
        expect(selected.coverage.find(item => item.entityId === 'npc-7')?.records).toBe(1);

        const omitted = await buildPlannerCharacterContext({
            mode: 'selected', entityIds: ['npc-1'], primarySubjectEntityIds: ['npc-7'],
        });
        expect(omitted).toMatchObject({ requested: 2, records: 1, omitted: 1 });
        expect(omitted.coverage).toContainEqual(expect.objectContaining({
            entityId: 'npc-7', name: 'NPC 7', status: 'disabled', records: 0, fields: 0, tokens: 0, estimated: true,
        }));
    });

    test('settings UI persists palette and entity-id selection per chat', () => {
        registerSafeCharacterContextProvider({
            buildContext: async () => ({ text: '', records: 0, requested: 0, omitted: 0 }),
            listCandidates: () => [{ entityId: 'npc-a', name: 'Mara' }],
        });
        state.modal = document.body;
        renderContent();
        wireEvents();
        document.querySelector('input[name="sp-palette-emphasis"][value="quiet moments"]').checked = true;
        document.querySelector('#sp-palette-escalation').value = 'restrained';
        document.querySelector('#sp-character-context-mode').value = 'selected';
        document.querySelector('#sp-character-context-ids option').selected = true;
        document.querySelector('#sp-save-settings').click();
        expect(getFakeMeta().story_planner_data.storyPalette).toMatchObject({ emphases: ['quiet moments'], escalation: 'restrained' });
        expect(getFakeMeta().story_planner_data.characterContext).toEqual({ mode: 'selected', entityIds: ['npc-a'] });
    });

    // Regression: the id list is empty whenever Knowledge is disabled or its
    // store has not hydrated, and the save handler read selectedOptions
    // unconditionally — so saving an unrelated setting wrote [] over a real
    // selection and silently made the feature a no-op with `mode` still set.
    test('saving with no candidates on screen keeps the stored selection', () => {
        setPlanData({ characterContext: { mode: 'selected', entityIds: ['npc-a', 'npc-b'] } });
        registerSafeCharacterContextProvider({
            buildContext: async () => ({ text: '', records: 0, requested: 0, omitted: 0 }),
            listCandidates: () => [],
        });
        state.modal = document.body;
        renderContent();
        wireEvents();

        // The panel says why the picker is empty rather than looking broken.
        expect(document.querySelector('#sp-character-context-ids').options.length).toBe(0);
        expect(state.contentEl.textContent).toContain('No Knowledge characters are loaded');

        document.querySelector('#sp-arc-count').value = '12';
        document.querySelector('#sp-save-settings').click();
        expect(getFakeMeta().story_planner_data.characterContext)
            .toEqual({ mode: 'selected', entityIds: ['npc-a', 'npc-b'] });
    });

    // A .mwt-label DIV is not a label: the mode select shipped with no
    // accessible name at all, unlike the id list beside it.
    test('the context-mode select and the emphasis chip group carry accessible names', () => {
        registerSafeCharacterContextProvider({
            buildContext: async () => ({ text: '', records: 0, requested: 0, omitted: 0 }),
            listCandidates: () => [{ entityId: 'npc-a', name: 'Mara' }],
        });
        state.modal = document.body;
        renderContent();

        const modeLabel = document.querySelector('label[for="sp-character-context-mode"]');
        expect(modeLabel?.textContent.trim()).toBe('Safe Character Context');
        expect(document.querySelector('#sp-character-context-ids').getAttribute('aria-label')).toBeTruthy();
        const chipGroup = document.querySelector('[role="group"][aria-label="Story palette emphasis"]');
        expect(chipGroup).not.toBeNull();
        expect(chipGroup.querySelectorAll('input[name="sp-palette-emphasis"]').length).toBe(8);
    });
});
