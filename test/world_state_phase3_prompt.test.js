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

const HOOK_DOCUMENT = `${FACTUAL_DOCUMENT}\n\n## Story Momentum\n- The delay may force a decision.\n\n## Plot Seeds\n- [contact] A courier could arrive with a forged manifest.\n\n## Potential Entrances\n- **Mara** [contact]: may call about the delayed shipment.`;

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

    test('names the Plot Seeds vocabulary without modelling copyable seed text', () => {
        const prompt = buildDefaultSystemPrompt('passive');

        expect(prompt).toContain('- [category] [a specific NEW event');
        expect(prompt).toContain('category is exactly one of: contact, entrance, social, institutional, opportunity, pressure, threat.');
        expect(prompt).toContain('"[event]" is not a category');
        expect(prompt).toContain('Never a recap, quote, or paraphrase of Recent Chat');
        // The old template listed one fully-written seed per category, and a
        // model could emit those sentences verbatim and still validate. The
        // vocabulary belongs in the rules; the section shows only the shape.
        expect(prompt).not.toContain('- [contact] A call');
        // The slash placeholder Potential Entrances used to carry is what
        // modelled "[contact/social]" tags in Plot Seeds.
        expect(prompt).not.toContain('[contact/social/institutional]');
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

    test('does not impose the built-in Plot Seeds tag contract on a custom prompt', async () => {
        const customPrompt = 'Return my custom World State format with the standard section headings.';
        const customDocument = `${FACTUAL_DOCUMENT}\n\n## Plot Seeds\n- A custom untagged seed.`;
        let calls = 0;
        saveSettings({ customPrompt, hookMode: 'passive' });
        setFakeApi(() => { calls++; return customDocument; });

        const updated = await refreshWorldState();

        expect(calls).toBe(1);
        expect(updated).toBe(customDocument);
    });

    test('logs the complete model output for both failed validation attempts', async () => {
        // Two sentences: a one-sentence slip is repaired into a bullet, not rejected.
        const first = `${FACTUAL_DOCUMENT}\nFirst attempt leaked narrative prose. It kept going.`;
        const retry = `${FACTUAL_DOCUMENT}\nRetry also leaked narrative prose. It kept going.`;
        let attempt = 0;
        setWorldStateData({ text: FACTUAL_DOCUMENT });
        setFakeApi(() => (++attempt === 1 ? first : retry));
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await expect(refreshWorldState()).rejects.toThrow('Model output rejected after retry');

            expect(warn).toHaveBeenCalledWith(expect.stringContaining('First attempt rejected'));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('Validation retry rejected'));
            expect(log).toHaveBeenCalledWith(expect.stringContaining(first));
            expect(log).toHaveBeenCalledWith(expect.stringContaining(retry));
            expect(getWorldStateText()).toBe(FACTUAL_DOCUMENT);
        } finally {
            log.mockRestore();
            warn.mockRestore();
            error.mockRestore();
        }
    });

    test('full refresh repairs an unbulleted one-sentence hook instead of rejecting it', async () => {
        saveSettings({ hookMode: 'passive' });
        setWorldStateData({ text: FACTUAL_DOCUMENT });
        let calls = 0;
        setFakeApi(() => {
            calls++;
            return `${FACTUAL_DOCUMENT}\n\n## Story Momentum\nThe delay may force a decision.`;
        });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            const updated = await refreshWorldState();

            expect(calls).toBe(1);
            expect(updated).toBe(`${FACTUAL_DOCUMENT}\n\n## Story Momentum\n- The delay may force a decision.`);
            expect(log).toHaveBeenCalledWith(expect.stringContaining('bulleted in ## Story Momentum: "The delay may force a decision."'));
        } finally {
            log.mockRestore();
        }
    });

    test('full refresh drops the reported [event] dialogue recap without losing the document', async () => {
        saveSettings({ hookMode: 'passive' });
        setWorldStateData({ text: FACTUAL_DOCUMENT });
        const requests = [];
        setFakeApi(request => {
            requests.push(request);
            return [
                FACTUAL_DOCUMENT,
                '',
                '## Plot Seeds',
                '- [event] "I am the manager now" is said in front of the law book tonight.',
                '- **[institutional]** The guild auditor could arrive before the delayed manifest is filed.',
            ].join('\n');
        });

        const updated = await refreshWorldState();

        // One call, not two: Plot Seeds is the most disposable section, so a
        // malformed seed must never cost the whole factual document a retry —
        // or, after a second failure, cost the refresh entirely.
        expect(requests).toHaveLength(1);
        expect(updated).toContain('- [institutional] The guild auditor could arrive');
        expect(updated).not.toContain('[event]');
        expect(updated).not.toContain('I am the manager now');
        expect(updated).toContain('Derek reported that the manifest is delayed.');
    });

    test('full refresh drops the Plot Seeds section when every seed lost its tag', async () => {
        saveSettings({ hookMode: 'passive' });
        setWorldStateData({ text: FACTUAL_DOCUMENT });
        setFakeApi(() => `${FACTUAL_DOCUMENT}\n\n## Plot Seeds\n- The guild auditor could arrive.`);

        const updated = await refreshWorldState();

        expect(updated).not.toContain('## Plot Seeds');
        expect(updated).toContain('Derek reported that the manifest is delayed.');
    });

    test('a rejected attempt tells the retry which line to fix', async () => {
        const requests = [];
        setWorldStateData({ text: FACTUAL_DOCUMENT });
        setFakeApi(request => {
            requests.push(request);
            return requests.length === 1 ? `${FACTUAL_DOCUMENT}\nDerek left. The manifest never came.` : FACTUAL_DOCUMENT;
        });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            await refreshWorldState();

            expect(requests).toHaveLength(2);
            expect(requests[1].userContent).toContain('unstructured narrative prose in ## Recent Changes: "Derek left. The manifest never came."');
            expect(getWorldStateText()).toBe(FACTUAL_DOCUMENT);
        } finally {
            log.mockRestore();
            warn.mockRestore();
        }
    });

    test('delta repairs only the section bodies it generated', async () => {
        saveSettings({ hookMode: 'passive' });
        // A bare "None" in a SAVED section is valid and must survive; the same
        // placeholder in a generated update turns that update into a removal.
        const baseline = `${FACTUAL_DOCUMENT}\n\n## Pending\n- Derek owes the manifest by dawn.\n\n## Unresolved Threads\nNone`;
        setWorldStateData({ text: baseline, deltaStatus: buildRefreshStatusDelta('full', baseline, {}, 0) });
        setFakeApi(() => [
            '### UPDATE: Pending',
            '## Pending',
            'None.',
            '### UPDATE: Story Momentum',
            '## Story Momentum',
            'The delay may force a decision.',
        ].join('\n'));
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            const updated = await refreshWorldStateDelta();

            expect(updated).not.toContain('## Pending');
            expect(updated).toContain('## Unresolved Threads\nNone');
            expect(updated).toContain('## Story Momentum\n- The delay may force a decision.');
        } finally {
            log.mockRestore();
        }
    });

    test('delta repairs a malformed Plot Seeds replacement before it becomes the next baseline', async () => {
        saveSettings({ hookMode: 'passive' });
        setWorldStateData({
            text: FACTUAL_DOCUMENT,
            deltaStatus: buildRefreshStatusDelta('full', FACTUAL_DOCUMENT, {}, 0),
        });
        const requests = [];
        setFakeApi(request => {
            requests.push(request);
            return '### UPDATE: Plot Seeds\n## Plot Seeds\n- [contact/social] A courier could arrive with a forged manifest.';
        });

        const updated = await refreshWorldStateDelta();

        // The committed document becomes the next delta's "Previous World
        // State", so repairing the generated bytes here is what stops a single
        // drifted tag from ratcheting the section into permanent degradation.
        expect(requests).toHaveLength(1);
        expect(updated).toContain('## Plot Seeds\n- [contact] A courier could arrive');
        expect(updated).not.toContain('[contact/social]');
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
        setFakeApi(value => { request = value; return '## Plot Seeds\n- [contact] A courier arrives with a forged manifest.'; });

        await regenerateSection('Plot Seeds', 5);

        expect(request.settings.temperature).toBeCloseTo(1.15);
        expect(request.systemPrompt).toContain('VARIETY MODE');
    });

    test('Plot Seeds section regeneration repairs a drifted tag', async () => {
        setFakeApi(() => '## Plot Seeds\n1. [Threat] A rival crew could move on the warehouse.');

        await regenerateSection('Plot Seeds', 5);

        expect(getWorldStateText()).toContain('- [threat] A rival crew could move on the warehouse.');
    });

    test('Plot Seeds section regeneration keeps the previous section when nothing is salvageable', async () => {
        setFakeApi(() => '## Plot Seeds\n- A courier arrives with a forged manifest.');

        await expect(regenerateSection('Plot Seeds', 5)).rejects.toThrow('no usable Plot Seeds');
        expect(getWorldStateText()).toBe(HOOK_DOCUMENT);
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
