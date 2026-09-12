import { beforeEach, describe, expect, test } from 'vitest';

import { resetCoreStubs, getFakeMeta, setFakeContextExtras } from './stubs/core.js';
import { getCurrentWorldStateScene } from '../core/metadata.js';
import { projectWorldState, validateWorldStateDocument } from '../core/world_state_document.js';
import { getTotalTokens } from '../world_state/index.js';
import { buildInjectionPayload } from '../world_state/injection.js';
import { saveSettings as saveWorldSettings } from '../world_state/settings.js';
import { setWorldStateData } from '../world_state/data.js';
import { stripHookSections } from '../world_state/prompts.js';
import { estimateTokens, getWorldStateFactual, getWorldStateHooks } from '../core/index.js';
import { buildUserPrompt as buildStoryPlannerPrompt } from '../story_planner/generation.js';

describe('World State Phase 5 bug fixes', () => {
    beforeEach(() => resetCoreStubs());

    beforeEach(() => {
        globalThis.SillyTavern = { getContext: () => ({
            chatMetadata: getFakeMeta(),
            globalSettings: {},
        }) };
    });

    test('does not promote fields from a recognized non-scene section into Current Scene', () => {
        getFakeMeta().world_state_tracker_metadata = {
            text: [
                '## Pending',
                'Date: A date for a future obligation',
                'Time: Tomorrow',
                'Location: The station',
                'Present: Mara',
                'Situation: The train is delayed.',
            ].join('\n'),
        };

        const scene = getCurrentWorldStateScene();

        expect(scene.section).toBeNull();
        expect(scene.date).toBeUndefined();
        expect(scene.time).toBeUndefined();
        expect(scene.present).toEqual([]);
        expect(scene.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'missing-current-scene' }),
        ]));
    });

    test('still supports heading-free legacy scene documents', () => {
        getFakeMeta().world_state_tracker_metadata = {
            text: [
                'Date: June 4, 2026',
                'Time: Evening',
                'Location: Harbour office',
                'Present: Alex',
                'Situation: Waiting for the manifest.',
            ].join('\n'),
        };

        expect(getCurrentWorldStateScene()).toMatchObject({
            date: 'June 4, 2026',
            time: 'Evening',
            location: 'Harbour office',
            present: ['Alex'],
        });
    });

    test('reads case-variant legacy fields from Current Scene only', () => {
        getFakeMeta().world_state_tracker_metadata = {
            text: [
                '## Current Scene',
                'date: June 4, 2026',
                'time: Evening',
                'location: Harbour office',
                'present: Alex, Mara',
                'situation: Waiting for the manifest.',
            ].join('\n'),
        };

        expect(getCurrentWorldStateScene()).toMatchObject({
            date: 'June 4, 2026',
            time: 'Evening',
            location: 'Harbour office',
            present: ['Alex', 'Mara'],
        });
    });

    test('does not promote case-variant fields from a recognized non-scene section', () => {
        getFakeMeta().world_state_tracker_metadata = {
            text: '## Pending\ntime: Tomorrow\npresent: Mara',
        };

        expect(getCurrentWorldStateScene().section).toBeNull();
        expect(getCurrentWorldStateScene().time).toBeUndefined();
        expect(getCurrentWorldStateScene().present).toEqual([]);
    });

    test('preserves conjunctions inside generated names while normalizing list punctuation', () => {
        for (const present of ['Lord of Blood and Bone', 'Salt and Pepper']) {
            const text = `## Current Scene\nDate: Day 3\nTime: Evening\nLocation: Hall\nPresent: ${present}\nSituation: Waiting.`;
            expect(validateWorldStateDocument(text).normalizedText).toBe(text);
        }

        const oxford = '## Current Scene\nDate: Day 3\nTime: Evening\nLocation: Hall\nPresent: Alex, Mara, and Derek\nSituation: Waiting.';
        expect(validateWorldStateDocument(oxford).normalizedText).toContain('Present: Alex, Mara, Derek');
    });

    test('tolerant scene reads split bare legacy conjunctions without changing saved text', () => {
        const text = '## Current Scene\nDate: Day 3\nTime: Evening\nLocation: Hall\nPresent: Mara and Derek\nSituation: Waiting.';
        setWorldStateData({ text });

        expect(getCurrentWorldStateScene().present).toEqual(['Mara', 'Derek']);
        expect(getFakeMeta().world_state_tracker_metadata.text).toBe(text);
    });

    test('scene fallback stays on one line and canonical strict fields win', () => {
        setWorldStateData({ text: [
            '## Current Scene',
            'Date:',
            'time: Morning',
            '  Time: Evening',
            '  Location: Harbour office',
            '  Present: Alex and Mara',
            '  Situation: Waiting.',
        ].join('\n') });

        expect(getCurrentWorldStateScene()).toMatchObject({
            date: '',
            time: 'Evening',
            location: 'Harbour office',
            present: ['Alex', 'Mara'],
        });
    });

    test('hook stripping recognizes hand-edited section casing', () => {
        const text = '## Current Scene\nDate: Day 3\n\n## plot seeds\n- A courier may arrive.';
        expect(stripHookSections(text)).not.toContain('courier');
    });

    test('projection options apply to every view and all preserves unknown sections', () => {
        const text = '## Current Scene\nDate: Day 3\n\n## Notes\nKeep this.\n\n## Plot Seeds\n- Maybe.\n\n## Pending\n- Oath.';
        expect(projectWorldState(text, { view: 'factual', sections: ['Pending'] })).toBe('## Pending\n- Oath.');
        expect(projectWorldState(text, { view: 'hooks', excludeSections: ['plot seeds'] })).toBe('');
        expect(projectWorldState(text, { view: 'all' })).toContain('## Notes');
    });

    test('Story Planner receives factual context without World State hooks', () => {
        setWorldStateData({ text: [
            '## Current Scene',
            'Date: Day 3',
            'Time: Evening',
            'Location: Hall',
            'Present: Alex',
            'Situation: Waiting.',
            '',
            '## Story Momentum',
            '- The bell may ring.',
            '',
            '## Plot Seeds',
            '- A courier may arrive.',
            '',
            '## Potential Entrances',
            '- Mara may appear.',
        ].join('\n') });

        const prompt = buildStoryPlannerPrompt('Alex waits.');
        expect(prompt).toContain('## Current Scene');
        expect(prompt).not.toContain('## Story Momentum');
        expect(prompt).not.toContain('## Plot Seeds');
        expect(prompt).not.toContain('## Potential Entrances');
    });

    test('narrator injection places every hook section under the hook header', () => {
        saveWorldSettings({ hookMode: 'passive' });
        const text = [
            '## Current Scene',
            'Date: Day 3',
            'Time: Evening',
            'Location: Hall',
            'Present: Alex',
            'Situation: Waiting.',
            '',
            '## Story Momentum',
            '- The bell may ring.',
            '',
            '## Plot Seeds',
            '- A courier may arrive.',
            '',
            '## Potential Entrances',
            '- Mara may appear.',
        ].join('\n');

        const payload = buildInjectionPayload(text);
        const hookHeader = payload.indexOf('[Narrative hooks available for this response');
        expect(hookHeader).toBeGreaterThan(payload.indexOf('## Current Scene'));
        for (const section of ['## Story Momentum', '## Plot Seeds', '## Potential Entrances']) {
            expect(payload.indexOf(section)).toBeGreaterThan(hookHeader);
        }
    });

    test.each(['off', 'passive', 'proactive', 'assertive'])('token diagnostics use the complete %s payload', (hookMode) => {
        const text = [
            '## Current Scene',
            'Date: June 4, 2026',
            'Time: Evening',
            'Location: Harbour office',
            'Present: Alex',
            'Situation: Waiting for the manifest.',
            '',
            '## Plot Seeds',
            '- A courier could arrive with a forged manifest.',
        ].join('\n');
        saveWorldSettings({ hookMode });
        setWorldStateData({ text });

        expect(getTotalTokens()).toBe(estimateTokens(buildInjectionPayload(text)));
    });

    test('token diagnostics follow structural-boundary changes too', () => {
        const text = '## Current Scene\nDate: Unknown\nTime: Evening\nLocation: Here\nPresent: Alex\nSituation: Waiting.';
        saveWorldSettings({ hookMode: 'off' });
        setWorldStateData({ text });

        setFakeContextExtras({ globalSettings: { structuralBoundaries: false } });
        expect(getTotalTokens()).toBe(estimateTokens(buildInjectionPayload(text)));
    });

    test('a heading-free legacy document produces no hook projection', () => {
        // A field-only legacy document is all factual scene data — it has no
        // hook sections. The hooks projection must return '' so that
        // buildInjectionPayload does not duplicate the full document under the
        // hook header when hook mode is not 'off'.
        const text = [
            'Date: June 4, 2026',
            'Time: Evening',
            'Location: Harbour office',
            'Present: Alex',
            'Situation: Waiting for the manifest.',
        ].join('\n');
        setWorldStateData({ text });

        expect(getWorldStateHooks()).toBe('');
    });

    test('a heading-free legacy document is not duplicated in the injection', () => {
        const text = [
            'Date: June 4, 2026',
            'Time: Evening',
            'Location: Harbour office',
            'Present: Alex',
            'Situation: Waiting for the manifest.',
        ].join('\n');
        saveWorldSettings({ hookMode: 'passive' });
        setWorldStateData({ text });

        const payload = buildInjectionPayload(text);
        // The factual body appears once; the hook block must not echo it.
        const bodyOccurrences = payload.split('Waiting for the manifest.').length - 1;
        expect(bodyOccurrences).toBe(1);
    });

    test('factual projection preserves preamble, unknown sections, and header casing', () => {
        const text = [
            'Hand-edited context.',
            '',
            '## Current scene',
            'Date: June 4, 2026',
            '',
            '## Notes',
            'Keep the lantern lit.',
            '',
            '## Plot Seeds',
            '- A courier may arrive.',
        ].join('\n');
        const factual = getWorldStateFactual(text);
        expect(factual).toContain('Hand-edited context.');
        expect(factual).toContain('## Current scene');
        expect(factual).toContain('## Notes');
        expect(factual).not.toContain('## Plot Seeds');
    });

    test('scene accessor preserves original section positions and parser issues', () => {
        const text = [
            '## Current Scene',
            'Date: June 4, 2026',
            'Date: June 5, 2026',
            'Time: Evening',
            'Location: Harbour office',
            'Present: Mara and Derek',
            'Situation: Waiting.',
            '',
            '## Notes',
            'A note.',
        ].join('\n');
        setWorldStateData({ text });
        const scene = getCurrentWorldStateScene();
        expect(scene.present).toEqual(['Mara', 'Derek']);
        expect(scene.section.start).toBe(text.indexOf('## Current Scene'));
        expect(scene.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'duplicate-scene-field' }),
            expect.objectContaining({ code: 'unknown-section' }),
        ]));
    });

    test('caps hook content independently from the factual body', () => {
        saveWorldSettings({ hookMode: 'passive' });
        const hooks = '- ' + 'x'.repeat(45000);
        const text = [
            '## Current Scene',
            'Date: June 4, 2026',
            'Time: Evening',
            'Location: Harbour office',
            'Present: Alex',
            'Situation: Waiting.',
            '',
            '## Story Momentum',
            hooks,
            '',
            '## Plot Seeds',
            hooks,
            '',
            '## Potential Entrances',
            hooks,
        ].join('\n');

        const payload = buildInjectionPayload(text);
        expect(payload.length).toBeLessThan(45000);
        expect(payload).toMatch(/truncated/i);
    });
});