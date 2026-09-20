/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { prepareStore } from '../core/schema.js';
import { buildBackupEnvelope } from '../backup/data.js';
import { planRestore } from '../backup/restore.js';
import {
    getStoryPalette,
    getStoryPlanRequestPreferences,
    setPlanData,
    state,
} from '../story_planner/data.js';
import { buildUserPrompt, describeCastPolicyRequest, generatePlan, storyPaletteProjection } from '../story_planner/generation.js';
import {
    migrateStoryPlannerV3ToV4,
    sanitizeStoryPalette,
    sanitizeStoryPlanRequestPreferences,
    storyPlannerSchema,
} from '../story_planner/schema.js';
import { openGenerateDialog, renderContent, wireEvents } from '../story_planner/render.js';
import { saveSettings } from '../story_planner/settings.js';
import {
    getFakeMeta, registerSafeCharacterContextProvider, resetCoreStubs,
    setFakeApi, setFakeChat,
} from './stubs/core.js';

beforeEach(() => {
    resetCoreStubs();
    document.body.innerHTML = '<div class="mwt-tab-content" data-tab="story-planner"></div>';
    state.modal = document.body;
    state.contentEl = document.querySelector('[data-tab="story-planner"]');
});

describe('Story Planner V3 Phase 3A — cast policy ownership', () => {
    test.each([true, false])('v3 legacy boolean %s migrates to independent allowed policies', legacyValue => {
        const source = {
            arcs: [],
            storyPalette: {
                emphases: ['mystery'], escalation: 'restrained', allowNewMajorCharacters: legacyValue,
            },
            storyPlanRequestPreferences: {
                operation: 'refresh', sectionKeys: ['horizon'], requestedCount: 2,
                targetArcIds: ['arc-a'], subjectMode: 'any', subjectEntityIds: [],
            },
        };

        const migrated = prepareStore(storyPlannerSchema, source, { version: 3 });

        expect(migrated.status).toBe('migrated');
        expect(migrated.data.storyPalette).toEqual({
            emphases: ['mystery'], escalation: 'restrained', castPolicy: 'allowed',
        });
        expect(migrated.data.storyPalette).not.toHaveProperty('allowNewMajorCharacters');
        expect(migrated.data.storyPlanRequestPreferences).toMatchObject({
            operation: 'refresh', sectionKeys: ['horizon'], targetArcIds: ['arc-a'], castPolicy: 'allowed',
        });
    });

    test('v3 to v4 migration is pure and the v4 result validates idempotently', () => {
        const source = { arcs: [], storyPalette: { allowNewMajorCharacters: true } };
        const direct = migrateStoryPlannerV3ToV4(source);
        expect(source.storyPalette).toEqual({ allowNewMajorCharacters: true });
        expect(direct.data.storyPalette).toEqual({ emphases: [], escalation: 'balanced', castPolicy: 'allowed' });

        const current = prepareStore(storyPlannerSchema, direct.data, { version: 4 });
        expect(current.status).toBe('valid');
        expect(current.changed).toBe(false);
    });

    test('canonicalizers default both workflow-owned fields to allowed', () => {
        expect(sanitizeStoryPalette({})).toEqual({ emphases: [], escalation: 'balanced', castPolicy: 'allowed' });
        expect(sanitizeStoryPlanRequestPreferences({ sectionKeys: ['horizon'] })).toMatchObject({ castPolicy: 'allowed' });
    });

    test('manual scoped and legacy/automatic policies remain independent in storage and prompt projection', () => {
        setPlanData({
            storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'existing-only' },
            storyPlanRequestPreferences: {
                operation: 'add', sectionKeys: ['horizon'], requestedCount: 1,
                targetArcIds: [], subjectMode: 'any', subjectEntityIds: [], castPolicy: 'propose',
            },
        });

        expect(getStoryPalette().castPolicy).toBe('existing-only');
        expect(getStoryPlanRequestPreferences().castPolicy).toBe('propose');
        expect(storyPaletteProjection()).not.toContain('allows new major characters');
        expect(buildUserPrompt('recent', '', {
            requestSpec: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy: 'allowed' },
        })).toContain('allows new major characters');

        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'allowed' } });
        expect(getStoryPlanRequestPreferences().castPolicy).toBe('propose');
        expect(storyPaletteProjection()).toContain('allows new major characters');
    });

    test('settings and scoped dialog expose separate controls and save only their designated owner', () => {
        setPlanData({
            storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'existing-only' },
            storyPlanRequestPreferences: {
                operation: 'add', sectionKeys: ['horizon'], requestedCount: 1,
                targetArcIds: [], subjectMode: 'any', subjectEntityIds: [], castPolicy: 'propose',
            },
        });
        renderContent();
        wireEvents();

        expect(document.querySelector('#sp-palette-cast-policy').value).toBe('existing-only');
        openGenerateDialog();
        expect(document.querySelector('#sp-generate-cast-policy').value).toBe('propose');

        document.querySelector('#sp-palette-cast-policy').value = 'allowed';
        document.querySelector('#sp-save-settings').click();
        expect(getFakeMeta().story_planner_data.storyPalette.castPolicy).toBe('allowed');
        expect(getFakeMeta().story_planner_data.storyPlanRequestPreferences.castPolicy).toBe('propose');
    });

    test('backup replace and merge preserve both workflow-owned policies independently', () => {
        const incoming = {
            arcs: [],
            storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'existing-only' },
            storyPlanRequestPreferences: {
                operation: 'add', sectionKeys: ['horizon'], requestedCount: 1,
                targetArcIds: [], subjectMode: 'any', subjectEntityIds: [], castPolicy: 'propose',
            },
        };
        const file = buildBackupEnvelope({
            metadata: { storyPlanner: incoming },
            sectionVersions: { storyPlanner: 4 },
        });

        const replaced = planRestore(file, {}, { strategy: 'replace' }).plan.sections.storyPlanner;
        expect(replaced.storyPalette.castPolicy).toBe('existing-only');
        expect(replaced.storyPlanRequestPreferences.castPolicy).toBe('propose');

        const current = {
            arcs: [],
            storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'allowed' },
            storyPlanRequestPreferences: {
                operation: 'add', sectionKeys: ['immediate'], requestedCount: 1,
                targetArcIds: [], subjectMode: 'any', subjectEntityIds: [], castPolicy: 'allowed',
            },
        };
        const merged = planRestore(file, { storyPlanner: current }, {
            strategy: 'merge', currentVersions: { storyPlanner: 4 },
        }).plan.sections.storyPlanner;
        expect(merged.storyPalette.castPolicy).toBe('allowed');
        expect(merged.storyPlanRequestPreferences.castPolicy).toBe('allowed');
    });
});

describe('Story Planner V3 Phase 3B — explicit request construction', () => {
    test.each([
        ['existing-only', 'established cast only', 'Do not propose a new recurring or major character'],
        ['allowed', 'new characters allowed', 'there is no newcomer quota'],
        ['propose', 'actively propose new characters', 'concrete on-screen entrance'],
    ])('built-in prompts carry the %s application-owned clause', (castPolicy, label, clause) => {
        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy } });
        expect(storyPaletteProjection().toLowerCase()).toContain(label);
        expect(storyPaletteProjection()).toContain(clause);

        const scoped = buildUserPrompt('recent', '', {
            requestSpec: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy },
        });
        expect(scoped).toContain('<application_request>');
        expect(scoped).toContain(clause);
    });

    test('classifies built-in, compatible custom, incompatible custom, scoped, and targeted paths explicitly', () => {
        const palette = { emphases: [], escalation: 'balanced', castPolicy: 'existing-only' };
        expect(describeCastPolicyRequest({ palette, settings: {} })).toMatchObject({
            policy: 'existing-only', source: 'story-palette', supported: true, template: 'built-in-full',
        });
        expect(describeCastPolicyRequest({ palette, settings: { customUserPrompt: 'Plan {{storyPalette}}' } })).toMatchObject({
            supported: true, template: 'custom-compatible',
        });
        expect(describeCastPolicyRequest({ palette, settings: { customUserPrompt: 'Plan {{chatHistory}}' } })).toMatchObject({
            supported: false, template: 'custom-incompatible',
        });
        expect(describeCastPolicyRequest({
            workflow: 'manual-scoped',
            requestSpec: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 1, castPolicy: 'propose' },
            palette,
        })).toMatchObject({
            policy: 'propose', source: 'manual-request', supported: true, template: 'built-in-scoped',
        });
        expect(describeCastPolicyRequest({ workflow: 'targeted', palette, settings: { customUserPrompt: 'ignored' } })).toMatchObject({
            policy: 'existing-only', source: 'story-palette', supported: true, template: 'built-in-targeted',
        });
    });

    test('custom full templates receive policy only through the storyPalette token', () => {
        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'existing-only' } });
        saveSettings({ customUserPrompt: 'CUSTOM {{chatHistory}}' });
        expect(buildUserPrompt('recent')).not.toContain('Cast policy');

        saveSettings({ customUserPrompt: 'CUSTOM {{storyPalette}} {{chatHistory}}' });
        expect(buildUserPrompt('recent')).toContain('Cast policy — established cast only');
    });

    test('automatic generation skips a non-allowed policy with an incompatible custom template before dispatch', async () => {
        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'existing-only' } });
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', customUserPrompt: 'CUSTOM {{chatHistory}}' });
        const api = vi.fn(() => 'unused');
        setFakeApi(api);

        await expect(generatePlan(true)).resolves.toBeNull();
        expect(api).not.toHaveBeenCalled();
    });

    test('full-plan generation keeps its compatible template snapshot while character context is pending', async () => {
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'cast-policy-template-race' }) };
        setPlanData({
            storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'existing-only' },
            characterContext: { mode: 'selected', entityIds: ['entity-mara'] },
        });
        saveSettings({
            apiUrl: 'https://example.test', modelName: 'test-model',
            customSystemPrompt: 'CAPTURED SYSTEM',
            customUserPrompt: 'CAPTURED {{storyPalette}} {{chatHistory}}',
        });
        setFakeChat([
            { is_user: true, name: 'User', mes: 'We inspect the harbour ledger, compare every signature against the customs archive, and catalogue the counterfeit seals before deciding which established ally can verify the discrepancy.' },
            { is_user: false, name: 'Mara', mes: 'The seal is counterfeit.' },
            { is_user: true, name: 'User', mes: 'We compare the signatures.' },
        ]);
        let releaseContext;
        const contextPending = new Promise(resolve => { releaseContext = resolve; });
        registerSafeCharacterContextProvider({
            buildContext: () => contextPending,
            listCandidates: () => [{ entityId: 'entity-mara', name: 'Mara', mergedEntityIds: [] }],
        });
        const api = vi.fn()
            .mockReturnValueOnce('')
            .mockReturnValueOnce([
                '## Immediate Hooks',
                '- Ledger proof — Mara identifies the forged signature.',
                '- Customs witness — an established clerk confirms the archive entry.',
                '- Sealed warning — a familiar ally finds a matching counterfeit mark.',
            ].join('\n'));
        setFakeApi(api);

        const pending = generatePlan(true);
        await vi.waitFor(() => expect(releaseContext).toBeTypeOf('function'));
        saveSettings({
            customSystemPrompt: 'MUTATED SYSTEM',
            customUserPrompt: 'MUTATED {{chatHistory}}',
        });
        releaseContext({ text: 'Character: Mara', records: 1, requested: 1, omitted: 0 });

        await expect(pending).resolves.not.toBeNull();
        expect(api).toHaveBeenCalledTimes(2);
        for (const [call] of api.mock.calls) {
            expect(call).toMatchObject({ systemPrompt: 'CAPTURED SYSTEM' });
            expect(call.userContent).toContain('CAPTURED');
            expect(call.userContent).toContain('Cast policy — established cast only');
            expect(call.userContent).not.toContain('MUTATED');
        }
    });

    test('Generate dialog visibly reports an incompatible whole-plan template and offers the built-in scoped path', () => {
        setPlanData({ storyPalette: { emphases: [], escalation: 'balanced', castPolicy: 'propose' } });
        saveSettings({ customUserPrompt: 'CUSTOM {{chatHistory}}' });

        openGenerateDialog();
        const text = document.getElementById('mwt-sp-generate-modal').textContent;
        expect(text).toContain('Scoped generation uses the built-in safe request format');
        expect(text).toContain('Actively propose new characters from Story Palette');
        expect(text).toContain('cast policy is unsupported for this call');
        expect(document.querySelector('#sp-generate-submit')).not.toBeNull();
        expect(document.querySelector('#sp-generate-legacy')).not.toBeNull();
        document.querySelector('#sp-generate-cancel').click();
    });
});