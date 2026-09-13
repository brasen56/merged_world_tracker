import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
    estimateTokens, getFakeMeta, resetCoreStubs, setFakeContextExtras,
} from './stubs/core.js';
import { getInjectedSnapshot } from '../core/diagnostics.js';
import {
    applyWorldStateInjection, buildInjectionPayload, buildInjectionProjection,
} from '../world_state/injection.js';
import { getTotalTokens } from '../world_state/index.js';
import { setWorldStateData } from '../world_state/data.js';
import { saveSettings } from '../world_state/settings.js';
import { HOOK_BEARING_SCENE } from './fixtures/world_state_phase0.js';

// Count tokenizer calls through the barrel: in SillyTavern each one is a real
// tokenizer run, and the floating badge builds a payload every 5 seconds.
vi.mock('./stubs/core.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, estimateTokens: vi.fn(actual.estimateTokens) };
});

const SCENE = '## Current Scene\nDate: Day 3\nTime: Evening\nLocation: Dock\nPresent: Alex\nSituation: Waiting.';
const bullets = (tag, count = 40, words = 60) => Array.from(
    { length: count }, (_, index) => `- ${`${tag}${index} `.repeat(words)}`,
).join('\n');

describe('World State Phase 6 measurement-only projection', () => {
    beforeEach(() => {
        resetCoreStubs();
        setFakeContextExtras({ setExtensionPrompt: () => {}, globalSettings: {} });
    });

    test('reports stored and injected tokens per section with factual/hook totals', () => {
        saveSettings({ hookMode: 'passive' });
        const { payload, diagnostics } = buildInjectionProjection(HOOK_BEARING_SCENE);

        expect(payload).toBe(buildInjectionPayload(HOOK_BEARING_SCENE));
        expect(diagnostics.kind).toBe('world-state-sections');
        expect(diagnostics.factual.storedTokens).toBeGreaterThan(0);
        expect(diagnostics.factual.injectedTokens).toBeGreaterThan(0);
        expect(diagnostics.hooks.storedTokens).toBeGreaterThan(0);
        expect(diagnostics.hooks.injectedTokens).toBeGreaterThan(0);
        expect(diagnostics.sections.map(row => row.sectionName)).toEqual(expect.arrayContaining([
            'Current Scene', 'Pending', 'Story Momentum', 'Plot Seeds', 'Potential Entrances',
        ]));
        expect(diagnostics.sections.every(row => row.storedTokens > 0)).toBe(true);
        expect(diagnostics.omitted).toEqual([]);
        expect(diagnostics.entries).toEqual([]);
    });

    test('reports hook sections as omitted when hook mode is off without changing factual payload', () => {
        saveSettings({ hookMode: 'off' });
        const { payload, diagnostics } = buildInjectionProjection(HOOK_BEARING_SCENE);

        expect(payload).not.toContain('## Plot Seeds');
        expect(diagnostics.hooks.injectedTokens).toBe(0);
        expect(diagnostics.omitted).toEqual(expect.arrayContaining([
            expect.objectContaining({ sectionName: 'Story Momentum', status: 'omitted', reason: 'hook mode off' }),
            expect.objectContaining({ sectionName: 'Plot Seeds', status: 'omitted', reason: 'hook mode off' }),
            expect.objectContaining({ sectionName: 'Potential Entrances', status: 'omitted', reason: 'hook mode off' }),
        ]));
    });

    test('records the report beside the exact live payload on the existing injection snapshot', () => {
        saveSettings({ hookMode: 'passive' });
        getFakeMeta().world_state_tracker_metadata = { text: HOOK_BEARING_SCENE };

        applyWorldStateInjection();

        const snapshot = getInjectedSnapshot('mwt_world_state_injection');
        expect(snapshot.payload).toBe(buildInjectionPayload(HOOK_BEARING_SCENE));
        expect(snapshot.diagnostics.kind).toBe('world-state-sections');
        expect(snapshot.diagnostics.registeredPayloadTokens).toBeGreaterThan(0);
        expect(snapshot.diagnostics.outerBudgetAction).toBe('keep');
    });

    test('marks legacy cap overflow as whole-section omissions or a partial section', () => {
        saveSettings({ hookMode: 'passive' });
        const huge = `${HOOK_BEARING_SCENE}\n\n## Notes\n${'x'.repeat(35_000)}`;
        const { diagnostics } = buildInjectionProjection(huge);
        const affected = diagnostics.sections.filter(row => row.status !== 'included');

        expect(affected.length).toBeGreaterThan(0);
        expect(affected.every(row => row.reason === 'factual character cap')).toBe(true);
        expect(diagnostics.omitted.length).toBe(affected.length);
    });

    test.each([['LF', '\n'], ['CRLF', '\r\n']])('attributes a real factual cap to exact sections (%s)', (_label, eol) => {
        saveSettings({ hookMode: 'passive' });
        const text = [
            SCENE,
            `## Recent Changes\n${bullets('recent')}`,
            `## Pending\n${bullets('pending')}`,
            `## Active Threads\n${bullets('thread')}`,
            '## Key Character States\n- **Mara**:\n  - Mood: calm',
        ].join('\n\n').replaceAll('\n', eol);
        const { diagnostics } = buildInjectionProjection(text);
        const rows = diagnostics.sections.filter(row => row.view === 'factual');

        expect(rows.map(row => [row.sectionName, row.status])).toEqual([
            ['Current Scene', 'included'],
            ['Recent Changes', 'included'],
            ['Pending', 'partial'],
            ['Active Threads', 'omitted'],
            ['Key Character States', 'omitted'],
        ]);
        const pending = rows[2];
        expect(pending.injectedTokens).toBeGreaterThan(0);
        expect(pending.injectedTokens).toBeLessThan(pending.storedTokens);
    });

    test('building the payload alone does no token counting', () => {
        saveSettings({ hookMode: 'passive' });
        estimateTokens.mockClear();

        buildInjectionPayload(HOOK_BEARING_SCENE);

        expect(estimateTokens).not.toHaveBeenCalled();
    });

    test('the token badge counts the assembled payload exactly once', () => {
        saveSettings({ hookMode: 'passive' });
        setWorldStateData({ text: HOOK_BEARING_SCENE });
        estimateTokens.mockClear();

        const total = getTotalTokens();

        expect(estimateTokens).toHaveBeenCalledTimes(1);
        expect(total).toBe(estimateTokens.mock.results[0].value);
    });
});