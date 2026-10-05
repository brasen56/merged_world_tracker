/**
 * World State detail levels — Minimal / Standard / Detailed built-in prompts.
 *
 * The three levels share section names, the parser, and every continuity
 * rule; they differ in per-entry shape and size targets. Covered here:
 *   1. The prompt templates themselves (shape per level, shared rules).
 *   2. Every generation path (full, delta, section regen) uses the selected
 *      level, and a Custom Prompt still replaces all of them.
 *   3. The format guard: a full refresh records the prompt profile, and a
 *      delta never patches a document written in another format.
 *   4. Standard's new character fields pass the document validator.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { estimateTokens, resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { validateWorldStateDocument } from '../core/world_state_document.js';
import {
    buildDefaultSystemPrompt, DEFAULT_SYSTEM_PROMPT, HOOK_SECTIONS, detailLevelIncludesSection,
} from '../world_state/prompts.js';
import { getPromptProfile, getSettings, saveSettings } from '../world_state/settings.js';
import { getWorldStateText, setWorldStateData, state } from '../world_state/data.js';
import { refreshWorldState, refreshWorldStateDelta } from '../world_state/refresh.js';
import { regenerateSection } from '../world_state/sections.js';
import {
    buildPartialRefreshStatus, buildRefreshStatusDelta, DeltaPatchError, getDeltaStatus, planAutoRefresh,
} from '../world_state/delta.js';

const SCENE = [
    '## Current Scene',
    'Date: Unknown',
    'Time: Evening',
    'Location: Safehouse kitchen',
    'Present: Alex, Mara, Derek',
    'Situation: The group prepares to leave before curfew.',
].join('\n');

const MINIMAL_DOC = [
    SCENE,
    '',
    '## Pending',
    '- Deliver the ledger before midnight.',
    '',
    '## Key Character States',
    '- **Alex**: Sprained ankle limits running; carries the ledger.',
    '- **Mara**: Concealing the escape plan from Derek; carries the car keys.',
    '- **Derek**: Distrusts Mara; unarmed.',
].join('\n');

const STANDARD_DOC = [
    SCENE,
    '',
    '## Recent Changes',
    '- Alex sprained an ankle on the stairs.',
    '',
    '## Pending',
    '- Deliver the ledger before midnight.',
    '',
    '## Key Character States',
    '- **Alex**:',
    '  - Mood: tense',
    '  - Goal: reach the drop before midnight',
    '  - Condition: Sprained ankle; cannot run.',
    '  - Items: the ledger',
].join('\n');

function makeChat(n = 6) {
    return Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        name: i % 2 ? 'Mara' : 'Alex',
        is_user: i % 2 === 0,
        mes: `Message ${i}: Alex, Mara, and Derek prepare to leave the safehouse kitchen.`,
    }));
}

/** Seed a reconciled document as a full refresh under `profile` would leave it. */
function seedFullRefresh(text, profile) {
    setWorldStateData({ text, deltaStatus: buildRefreshStatusDelta('full', text, {}, 2, profile) });
}

// ─── 1. Templates ────────────────────────────────────────────────────────────

describe('detail level prompt templates', () => {
    beforeEach(() => resetCoreStubs());

    test('Detailed is the default, the fallback for unknown values, and DEFAULT_SYSTEM_PROMPT', () => {
        const detailed = buildDefaultSystemPrompt('passive', 'detailed');

        expect(buildDefaultSystemPrompt('passive')).toBe(detailed);
        expect(buildDefaultSystemPrompt('passive', 'verbose')).toBe(detailed);
        expect(DEFAULT_SYSTEM_PROMPT).toBe(detailed);
        expect(getSettings().detailLevel).toBe('detailed');
    });

    test.each(['minimal', 'standard', 'detailed'])('%s keeps every shared continuity rule', (level) => {
        const prompt = buildDefaultSystemPrompt('off', level);

        // Current Scene contract and the document anchor are level-independent.
        expect(prompt).toContain('Your output MUST begin with the exact text "## Current Scene"');
        expect(prompt).toContain('copy its value EXACTLY, byte-for-byte');
        // Smaller levels repeat less; they never forget more.
        expect(prompt).toContain('A passed deadline makes an existing obligation overdue');
        expect(prompt).toContain('Injuries, impairments, possessions, meaningful negative states, and other persistent facts remain');
        expect(prompt).toContain('Preserve meaningful negative facts such as "unarmed"');
        expect(prompt).toContain('Each fact has ONE home');
        expect(prompt).toContain('Route each fact to the FIRST home that fits');
        expect(prompt).toContain('Never drop an unresolved obligation, injury, possession, or meaningful negative fact just to fit.');
        expect(prompt).toContain('Item rule: list an item only if forgetting it would cause a continuity error');
        expect(prompt).toContain('Never list ordinary clothing, accessories, or incidental props.');
        expect(prompt).toContain('Do NOT invent anything not supported');
        for (const section of ['Off-Screen', 'Pending', 'Active Threads', 'Unresolved Threads', 'World Pressures', 'Key Character States']) {
            expect(prompt).toContain(`## ${section}`);
        }
    });

    test.each(['minimal', 'standard', 'detailed'])('%s adds hook sections only when hook mode is on', (level) => {
        const off = buildDefaultSystemPrompt('off', level);
        const passive = buildDefaultSystemPrompt('passive', level);

        for (const section of HOOK_SECTIONS) {
            expect(off).not.toContain(`## ${section}`);
            expect(passive).toContain(`## ${section}`);
        }
    });

    test('Minimal: one line per character, no Recent Changes, smallest target', () => {
        const prompt = buildDefaultSystemPrompt('off', 'minimal');

        expect(prompt).not.toContain('## Recent Changes');
        expect(prompt).not.toContain('Recent Changes records');
        expect(prompt).toContain('- **Name**: [condition and limits; continuity-critical items;');
        expect(prompt).toContain('write ONE line per character');
        expect(prompt).toContain('Omit routine mood, posture, clothing, and inferred goals.');
        expect(prompt).toContain('Minimal means less repetition, not less memory');
        expect(prompt).toContain('Target roughly 250–400 words');
        expect(prompt).not.toContain('  - Mood:');
    });

    test('Standard: four short fields, Condition replaces status/constraint, mid target', () => {
        const prompt = buildDefaultSystemPrompt('off', 'standard');

        expect(prompt).toContain('## Recent Changes');
        expect(prompt).toContain('  - Mood: [one or two words]');
        expect(prompt).toContain('  - Goal: [what they want right now, under 10 words]');
        expect(prompt).toContain('  - Condition: [injuries, impairments, restraints, or other hard limits');
        expect(prompt).toContain('  - Items: [up to 4 continuity-critical items');
        expect(prompt).toContain('Target roughly 400–550 words');
        for (const dropped of ['Notable status:', 'Immediate pressure:', 'Key constraint:', 'Worn / Significant Items:']) {
            expect(prompt).not.toContain(dropped);
        }
    });

    test('Detailed: the original six-field blocks and 600–800 target, now with the item rule', () => {
        const prompt = buildDefaultSystemPrompt('off', 'detailed');

        for (const field of ['Mood:', 'Current goal:', 'Notable status:', 'Immediate pressure:', 'Key constraint:', 'Worn / Significant Items:']) {
            expect(prompt).toContain(`  - ${field}`);
        }
        expect(prompt).toContain('Target roughly 600–800 words');
        expect(prompt).toContain('State each fact under one field only.');
        // The phrase models read as "list every garment" is gone.
        expect(prompt).not.toContain('continuity-relevant clothing and carried/significant objects');
    });

    test('smaller levels cost fewer prompt tokens', () => {
        const [minimal, standard, detailed] = ['minimal', 'standard', 'detailed']
            .map(level => estimateTokens(buildDefaultSystemPrompt('passive', level)));

        expect(minimal).toBeLessThan(standard);
        expect(standard).toBeLessThan(detailed);
    });

    test('detailLevelIncludesSection reports Minimal\'s dropped section only', () => {
        expect(detailLevelIncludesSection('minimal', 'Recent Changes')).toBe(false);
        expect(detailLevelIncludesSection('minimal', 'Key Character States')).toBe(true);
        expect(detailLevelIncludesSection('standard', 'Recent Changes')).toBe(true);
        expect(detailLevelIncludesSection('detailed', 'Recent Changes')).toBe(true);
        expect(detailLevelIncludesSection(undefined, 'Recent Changes')).toBe(true);
    });

    test('getPromptProfile reports the level, or custom when a Custom Prompt is set', () => {
        expect(getPromptProfile({ detailLevel: 'minimal', customPrompt: '' })).toBe('minimal');
        expect(getPromptProfile({ detailLevel: 'bogus' })).toBe('detailed');
        expect(getPromptProfile({ detailLevel: 'minimal', customPrompt: '  My format.  ' })).toBe('custom');
        expect(getPromptProfile({ detailLevel: 'minimal', customPrompt: '   ' })).toBe('minimal');
    });
});

// ─── 2 + 3. Generation paths and the format guard ────────────────────────────

describe('detail levels across generation paths', () => {
    let requests;
    let response;

    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        state.wstIsRefreshing = false;
        globalThis.document = { dispatchEvent: vi.fn() };
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'detail-levels' }) };
        setFakeChat(makeChat());
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', customPrompt: '', hookMode: 'off' });
        requests = [];
        response = '';
        setFakeApi(request => { requests.push(request); return typeof response === 'function' ? response(request) : response; });
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        state.wstIsRefreshing = false;
        delete globalThis.document;
        delete globalThis.SillyTavern;
        vi.restoreAllMocks();
    });

    test('full refresh uses the selected level and records it with the commit', async () => {
        saveSettings({ detailLevel: 'minimal' });
        response = MINIMAL_DOC;

        const updated = await refreshWorldState();

        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).toBe(buildDefaultSystemPrompt('off', 'minimal'));
        expect(updated).toBe(MINIMAL_DOC);
        expect(getDeltaStatus().promptProfile).toBe('minimal');
    });

    test('a Custom Prompt replaces every level and records "custom"', async () => {
        const customPrompt = 'Return my World State format exactly.';
        saveSettings({ detailLevel: 'minimal', customPrompt });
        response = MINIMAL_DOC;

        await refreshWorldState();

        expect(requests[0].systemPrompt).toBe(customPrompt);
        expect(getDeltaStatus().promptProfile).toBe('custom');
    });

    test('a level saved while the full refresh is in flight is not stamped onto its document', async () => {
        saveSettings({ detailLevel: 'detailed' });
        response = () => {
            saveSettings({ detailLevel: 'minimal' });
            return STANDARD_DOC;
        };

        await refreshWorldState();

        // The document came from the Detailed prompt, so the next delta must
        // still see a format change and route to a full rebuild.
        expect(getDeltaStatus().promptProfile).toBe('detailed');
    });

    test('delta and section regeneration build on the selected level', async () => {
        saveSettings({ detailLevel: 'standard' });
        seedFullRefresh(STANDARD_DOC, 'standard');
        response = '### NO CHANGES';

        await refreshWorldStateDelta();
        response = '## Pending\n- Deliver the ledger before midnight.';
        await regenerateSection('Pending');

        expect(requests).toHaveLength(2);
        expect(requests[0].systemPrompt).toContain('DELTA PATCH MODE');
        expect(requests[0].systemPrompt.startsWith(buildDefaultSystemPrompt('off', 'standard'))).toBe(true);
        expect(requests[1].systemPrompt.startsWith(buildDefaultSystemPrompt('off', 'standard'))).toBe(true);
    });

    test('partial updates carry the recorded profile forward', async () => {
        saveSettings({ detailLevel: 'standard' });
        seedFullRefresh(STANDARD_DOC, 'standard');
        response = '## Pending\n- Deliver the ledger before midnight tonight.';

        await regenerateSection('Pending');

        expect(getDeltaStatus()).toMatchObject({ lastRefreshKind: 'delta', promptProfile: 'standard' });
        const full = buildRefreshStatusDelta('full', 'x', {}, 0, 'minimal');
        expect(buildPartialRefreshStatus(full, 'x', 'y', 1).promptProfile).toBe('minimal');
    });

    test('Minimal refuses to regenerate Recent Changes before spending a call', async () => {
        saveSettings({ detailLevel: 'minimal' });
        seedFullRefresh(MINIMAL_DOC, 'minimal');

        await expect(regenerateSection('Recent Changes')).rejects.toThrow('"Recent Changes" is not part of the minimal detail level');
        expect(requests).toHaveLength(0);
    });

    test('a Custom Prompt may still regenerate Recent Changes under Minimal', async () => {
        saveSettings({ detailLevel: 'minimal', customPrompt: 'My custom World State format.' });
        setWorldStateData({ text: MINIMAL_DOC });
        response = '## Recent Changes\n- Alex sprained an ankle.';

        await regenerateSection('Recent Changes');

        expect(requests).toHaveLength(1);
        expect(getWorldStateText()).toContain('## Recent Changes');
    });

    test('planAutoRefresh routes a format change to a full refresh', () => {
        saveSettings({ deltaMode: true, detailLevel: 'minimal' });

        seedFullRefresh(STANDARD_DOC, 'detailed');
        expect(planAutoRefresh()).toEqual({ kind: 'full', reason: 'detail-level-changed' });

        saveSettings({ customPrompt: 'My custom format.' });
        seedFullRefresh(STANDARD_DOC, 'minimal');
        expect(planAutoRefresh()).toEqual({ kind: 'full', reason: 'detail-level-changed' });

        saveSettings({ customPrompt: '' });
        seedFullRefresh(MINIMAL_DOC, 'minimal');
        expect(planAutoRefresh()).toEqual({ kind: 'delta', reason: 'scheduled' });
    });

    test('a status written before detail levels existed never forces a full refresh', () => {
        saveSettings({ deltaMode: true, detailLevel: 'minimal' });
        const legacy = buildRefreshStatusDelta('full', STANDARD_DOC, {}, 2);
        delete legacy.promptProfile;
        setWorldStateData({ text: STANDARD_DOC, deltaStatus: legacy });

        expect(getDeltaStatus().promptProfile).toBeNull();
        expect(planAutoRefresh()).toEqual({ kind: 'delta', reason: 'scheduled' });

        setWorldStateData({ deltaStatus: { ...legacy, promptProfile: 'enormous' } });
        expect(getDeltaStatus().promptProfile).toBeNull();
    });

    test('a manual ⚡ Delta after a format change is declined without spending a call', async () => {
        saveSettings({ detailLevel: 'minimal' });
        seedFullRefresh(STANDARD_DOC, 'standard');

        await expect(refreshWorldStateDelta()).rejects.toThrow(DeltaPatchError);
        await expect(refreshWorldStateDelta()).rejects.toThrow('detail level changed');
        expect(requests).toHaveLength(0);
        expect(getWorldStateText()).toBe(STANDARD_DOC);
    });

    test('a scheduled delta after a format change rebuilds the whole document instead', async () => {
        saveSettings({ detailLevel: 'minimal' });
        seedFullRefresh(STANDARD_DOC, 'standard');
        response = MINIMAL_DOC;

        const updated = await refreshWorldStateDelta(true);

        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).toBe(buildDefaultSystemPrompt('off', 'minimal'));
        expect(updated).toBe(MINIMAL_DOC);
        expect(getDeltaStatus()).toMatchObject({ lastRefreshKind: 'full', promptProfile: 'minimal' });
    });
});

// ─── 4. Validator ────────────────────────────────────────────────────────────

describe('detail level documents pass the built-in contract', () => {
    test.each([
        ['minimal', MINIMAL_DOC],
        ['standard', STANDARD_DOC],
    ])('%s document validates', (_level, doc) => {
        const result = validateWorldStateDocument(doc, { mode: 'default-contract' });

        expect(result.errors).toEqual([]);
    });

    test('a Standard field line that lost its dash is not mistaken for prose', () => {
        const slipped = STANDARD_DOC
            .replace('  - Condition: Sprained ankle; cannot run.', '  Condition: Sprained ankle. Cannot run.')
            .replace('  - Items: the ledger', '  Items: The ledger and a torn map.');

        const result = validateWorldStateDocument(slipped, { mode: 'default-contract' });

        expect(result.errors).toEqual([]);
    });
});
