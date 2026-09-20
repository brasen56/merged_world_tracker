/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test } from 'vitest';

import { prepareStore } from '../core/schema.js';
import { buildBackupEnvelope } from '../backup/data.js';
import { planRestore } from '../backup/restore.js';
import {
    getStoryPalette,
    getStoryPlanRequestPreferences,
    setPlanData,
    state,
} from '../story_planner/data.js';
import { buildUserPrompt, storyPaletteProjection } from '../story_planner/generation.js';
import {
    migrateStoryPlannerV3ToV4,
    sanitizeStoryPalette,
    sanitizeStoryPlanRequestPreferences,
    storyPlannerSchema,
} from '../story_planner/schema.js';
import { openGenerateDialog, renderContent, wireEvents } from '../story_planner/render.js';
import { getFakeMeta, resetCoreStubs } from './stubs/core.js';

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