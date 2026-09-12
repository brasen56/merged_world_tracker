/** Phase 3 compact default prompt, hook generation, and Variety boundaries. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import {
    buildDefaultSystemPrompt, HOOK_SECTIONS, stripHookSections,
} from '../world_state/prompts.js';
import { buildInjectionPayload } from '../world_state/injection.js';
import { saveSettings } from '../world_state/settings.js';
import { getWorldStateText, setWorldStateData, state } from '../world_state/data.js';
import { refreshWorldState, refreshWorldStateDelta } from '../world_state/refresh.js';
import { regenerateSection } from '../world_state/sections.js';
import { buildRefreshStatusDelta } from '../world_state/delta.js';
import { render } from '../world_state/render.js';

const FACTUAL_DOCUMENT = [
    '## Current Scene',
    'Date: June 4, 2026',
    'Time: Evening',
    'Location: Harbour office',
    'Present: Alex, Derek',
    'Situation: Alex waits for Derek to deliver the manifest.',
    '',
    '## Recent Changes',
    '- Derek reported that the manifest is delayed.',
].join('\n');

const HOOK_DOCUMENT = `${FACTUAL_DOCUMENT}\n\n## Story Momentum\n- The delay may force a decision.\n\n## Plot Seeds\n- A courier could arrive with a forged manifest.\n\n## Potential Entrances\n- **Mara** [contact]: may call about the delayed shipment.`;

describe('Phase 3 built-in prompt', () => {
    test('uses compactness targets, sparse character states, durable retention, and exact unchanged scene fields', () => {
        const prompt = buildDefaultSystemPrompt('passive');

        expect(prompt).toContain('Target roughly 600–800 words');
        expect(prompt).toContain('copy its value EXACTLY, byte-for-byte');
        expect(prompt).toContain('use sparse blocks');
        expect(prompt).toContain('A passed deadline makes an existing obligation overdue');
        expect(prompt).toContain('until a change is established');
        expect(prompt).toContain('no fact in this category would cause a continuity error');
        expect(prompt).not.toContain('Under 2000 words');
        expect(prompt).not.toContain('EVERY field completed');
        expect(prompt).not.toContain('"none" if nothing notable');
    });

    test('omits all hook headings only when hook mode is off', () => {
        const off = buildDefaultSystemPrompt('off');
        const passive = buildDefaultSystemPrompt('passive');

        for (const section of HOOK_SECTIONS) {
            expect(off).not.toContain(`## ${section}`);
            expect(passive).toContain(`## ${section}`);
        }
    });

    test('strips complete hook sections without affecting factual continuity', () => {
        const stripped = stripHookSections(HOOK_DOCUMENT);

        expect(stripped).toBe(FACTUAL_DOCUMENT);
        for (const section of HOOK_SECTIONS) expect(stripped).not.toContain(section);
    });

    test('hook stripping is line-anchored and preserves CRLF factual bytes', () => {
        const factual = `${FACTUAL_DOCUMENT}\n- Alex mentioned ## Plot Seeds as a document heading.`.replaceAll('\n', '\r\n');
        const source = `${factual}\r\n\r\n## Plot Seeds\r\n- A courier could arrive.\r\n`;

        expect(stripHookSections(source)).toBe(factual);
        expect(stripHookSections(factual)).toBe(factual);
    });
});

describe('Phase 3 hook-mode write and injection boundaries', () => {
    beforeEach(() => {
        resetCoreStubs();
        state.wstIsRefreshing = false;
        globalThis.document = { dispatchEvent: vi.fn() };
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'phase3-hooks' }) };
        setFakeChat([{ name: 'Alex', is_user: true, mes: 'We are waiting in the harbour office.' }]);
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', customPrompt: '', hookMode: 'off' });
    });

    afterEach(() => { delete globalThis.document; delete globalThis.SillyTavern; state.wstIsRefreshing = false; });

    test('removes hook sections from built-in generation before committing', async () => {
        let request;
        setWorldStateData({ text: HOOK_DOCUMENT });
        setFakeApi(value => { request = value; return HOOK_DOCUMENT; });

        await refreshWorldState();

        expect(getWorldStateText()).toBe(FACTUAL_DOCUMENT);
        expect(request.settings.maxTokens).toBe(2000);
        for (const section of HOOK_SECTIONS) {
            expect(request.systemPrompt).not.toContain(`## ${section}`);
            expect(request.userContent).not.toContain(`## ${section}`);
        }
    });

    test('keeps a custom prompt as a complete replacement and does not reject it for length', async () => {
        const customPrompt = 'Return my World State Markdown format exactly.';
        const longDocument = [
            '## Current Scene',
            'Date: Unknown',
            'Time: Evening',
            'Location: Harbour office',
            'Present: Alex',
            `Situation: ${'continuity '.repeat(900).trim()}`,
        ].join('\n');
        let request;
        saveSettings({ customPrompt });
        setFakeApi(value => { request = value; return longDocument; });

        const updated = await refreshWorldState();

        expect(updated).toBe(longDocument);
        expect(request.systemPrompt).toBe(customPrompt);
        expect(request.systemPrompt).not.toContain('600–800 words');
    });

    test('removes legacy hook sections from injection when hook mode is off', () => {
        expect(buildInjectionPayload(HOOK_DOCUMENT)).toContain('## Current Scene');
        for (const section of HOOK_SECTIONS) expect(buildInjectionPayload(HOOK_DOCUMENT)).not.toContain(section);
    });

    test('removes a hook section added by a delta patch before committing', async () => {
        const baseline = FACTUAL_DOCUMENT;
        setWorldStateData({
            text: baseline,
            deltaStatus: buildRefreshStatusDelta('full', baseline, {}, 0),
        });
        setFakeApi(() => '### UPDATE: Plot Seeds\n## Plot Seeds\n- A courier could arrive with a forged manifest.');

        const updated = await refreshWorldStateDelta();

        expect(updated).toBe(FACTUAL_DOCUMENT);
        expect(getWorldStateText()).toBe(FACTUAL_DOCUMENT);
    });

    test('cleans legacy hooks when a hook-free delta reports no factual changes', async () => {
        let request;
        setWorldStateData({
            text: HOOK_DOCUMENT,
            deltaStatus: buildRefreshStatusDelta('full', HOOK_DOCUMENT, {}, 0),
        });
        setFakeApi(value => { request = value; return '### NO CHANGES'; });

        const updated = await refreshWorldStateDelta();

        expect(updated).toBe(FACTUAL_DOCUMENT);
        expect(getWorldStateText()).toBe(FACTUAL_DOCUMENT);
        for (const section of HOOK_SECTIONS) {
            expect(request.systemPrompt).not.toContain(`## ${section}`);
            expect(request.userContent).not.toContain(`## ${section}`);
        }
    });

    test('removes a manually regenerated hook section before committing', async () => {
        setWorldStateData({ text: FACTUAL_DOCUMENT });
        setFakeApi(() => '## Plot Seeds\n- A courier could arrive with a forged manifest.');

        const updated = await regenerateSection('Plot Seeds', 5);

        expect(updated).toBe(FACTUAL_DOCUMENT);
        expect(getWorldStateText()).toBe(FACTUAL_DOCUMENT);
    });

    test('omits legacy hooks from factual section-regeneration context', async () => {
        let request;
        setWorldStateData({ text: HOOK_DOCUMENT });
        setFakeApi(value => { request = value; return '## Pending\n- The manifest is overdue.'; });

        await regenerateSection('Pending', 5);

        expect(request.systemPrompt).not.toContain('VARIETY MODE');
        for (const section of HOOK_SECTIONS) expect(request.userContent).not.toContain(`## ${section}`);
    });

    test('disables hook options and factual Variety in the rendered controls', () => {
        const html = render();

        expect(html.match(/data-hook-section="true" disabled/g)).toHaveLength(HOOK_SECTIONS.length);
        expect(html).toMatch(/id="ws-variety-slider"[^>]*disabled/);
        expect(html).toContain('>Not used</span>');
    });
});

describe('Phase 3 Variety boundary', () => {
    beforeEach(() => {
        resetCoreStubs();
        state.wstIsRefreshing = false;
        globalThis.document = { dispatchEvent: vi.fn() };
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'phase3-variety' }) };
        setFakeChat([{ name: 'Alex', is_user: true, mes: 'The manifest remains delayed.' }]);
        setWorldStateData({ text: HOOK_DOCUMENT });
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', temperature: 0.3, hookMode: 'passive' });
    });

    afterEach(() => { delete globalThis.document; delete globalThis.SillyTavern; state.wstIsRefreshing = false; });

    test('does not add creative instructions or a temperature boost to factual section regeneration', async () => {
        let request;
        setFakeApi(value => { request = value; return '## Pending\n- The manifest is due tonight.'; });

        await regenerateSection('Pending', 5);

        expect(request.settings.temperature).toBe(0.3);
        expect(request.systemPrompt).not.toContain('VARIETY MODE');
    });

    test('retains creative instructions and the temperature boost for hook sections', async () => {
        let request;
        setFakeApi(value => { request = value; return '## Plot Seeds\n- A courier arrives with a forged manifest.'; });

        await regenerateSection('Plot Seeds', 5);

        expect(request.settings.temperature).toBeCloseTo(1.15);
        expect(request.systemPrompt).toContain('VARIETY MODE');
    });

    test('keeps factual retry prompts free of creative instructions', async () => {
        const requests = [];
        saveSettings({ groundingEnabled: true, groundingMode: 'strict' });
        setFakeApi(request => {
            requests.push(request);
            return requests.length === 1
                ? '## Pending\n- **Zyx** demands the manifest.'
                : '## Pending\n- The manifest remains delayed.';
        });

        await regenerateSection('Pending', 5);

        expect(requests).toHaveLength(2);
        for (const request of requests) expect(request.systemPrompt).not.toContain('VARIETY MODE');
    });
});
