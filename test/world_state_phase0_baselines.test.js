/**
 * Phase 0 characterization coverage for docs/WORLD_STATE_IMPROVEMENT_ROADMAP.md.
 *
 * Several assertions deliberately pin unsafe CURRENT behavior. They are the
 * red/green hand-off for later phases: Phase 2 will invert the old Chronicle
 * chronology and concurrency outcomes; Phases 3-6 will change prompt size,
 * hook separation, and projection measurements.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    resetCoreStubs, setFakeApi, setFakeChat, getFakeMeta, estimateTokens,
} from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { DEFAULT_SYSTEM_PROMPT } from '../world_state/prompts.js';
import { CHRONICLE_SYSTEM_PROMPT } from '../chronicle/prompts.js';
import { buildInjectionPayload } from '../world_state/injection.js';
import {
    state as worldStateState, getWorldStateText, setWorldStateData,
} from '../world_state/data.js';
import { saveSettings as saveWorldSettings } from '../world_state/settings.js';
import {
    state as chronicleState, _render, saveSettings as saveChronicleSettings,
    setChronicleData, getSnapshots,
} from '../chronicle/data.js';
import {
    generateSnapshot, regenerateSnapshot, consolidateEntries,
} from '../chronicle/snapshots.js';
import {
    WORLD_STATE_DOCUMENTS, MINIMAL_SCENE, ANNOTATED_PRESENT_SCENE,
    PERSISTENT_INJURY_SCENE, OVERDUE_OBLIGATION_SCENE,
    UNCHANGED_SCENE_BEFORE, UNCHANGED_SCENE_REFRESH, HOOK_BEARING_SCENE,
    CHRONICLE_ANCHOR_VALUES, chronicleOutput, makeChronicleSnapshot,
} from './fixtures/world_state_phase0.js';

const CHAT = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    name: i % 2 ? 'Mara' : 'User',
    is_user: i % 2 === 0,
    mes: `Message ${i} in the harbour chronology.`,
}));

// Approximate values observed with test/stubs/core.js's deterministic fallback
// estimator on 2026-09-11. Assertions use tolerance bands so harmless prompt
// wording or estimator refinements do not turn these measurements into brittle
// snapshots, while material prompt-size changes remain visible.
const TOKEN_BASELINES = Object.freeze({
    defaultSystemPrompt: 1565,
    customSystemPrompt: 16,
    hookBearingStored: 124,
    hookOffInjected: 160,
    hookPassiveInjected: 269,
    hookOffGenerated: 124,
    hookPassiveGenerated: 124,
});

function expectNearTokenBaseline(actual, baseline, tolerance = 0.15) {
    expect(actual).toBeGreaterThanOrEqual(Math.floor(baseline * (1 - tolerance)));
    expect(actual).toBeLessThanOrEqual(Math.ceil(baseline * (1 + tolerance)));
}

function seedWorldState(text = UNCHANGED_SCENE_BEFORE) {
    setWorldStateData({ text });
}

function seedChronicle(snapshots) {
    setChronicleData({
        snapshots,
        lastAnchor: snapshots.at(-1)?.anchor ?? null,
        msgSinceSnapshot: 0,
    });
}

function getWorldStateField(label) {
    return getWorldStateText().match(new RegExp(`^${label}:\\s*(.*)$`, 'm'))?.[1];
}

describe('Phase 0 reusable World State fixtures', () => {
    test('covers every required failure-family document with stable semantic evidence', () => {
        expect(Object.keys(WORLD_STATE_DOCUMENTS)).toEqual(expect.arrayContaining([
            'minimal', 'crowded', 'annotatedPresent', 'persistentInjury',
            'overdueObligation', 'unchangedBefore', 'unchangedRefresh',
        ]));
        expect(MINIMAL_SCENE).toContain('Date: Unknown');
        expect(WORLD_STATE_DOCUMENTS.crowded.match(/^Present: (.+)$/m)?.[1].split(',')).toHaveLength(8);
        expect(ANNOTATED_PRESENT_SCENE).toMatch(/Present:.*\([^)]*,[^)]*\).*\[[^\]]*,[^\]]*\]/);
        expect(PERSISTENT_INJURY_SCENE).toMatch(/fractured left wrist remains splinted/i);
        expect(OVERDUE_OBLIGATION_SCENE).toMatch(/OVERDUE.*still owes/i);
        expect(UNCHANGED_SCENE_BEFORE).toContain('Location: Harbour office');
        expect(UNCHANGED_SCENE_REFRESH).toContain('Location: The harbour office on Customs Row');
    });

    test('covers the five required Chronicle anchor forms', () => {
        expect(CHRONICLE_ANCHOR_VALUES).toEqual([
            'June 4, 2026 2:30pm',
            'June 4, 2026 2pm',
            'June 4, 2026 late afternoon',
            'June 4, 2026 evening',
            'Unknown',
        ]);
    });
});

describe('Phase 0 prompt and token baselines', () => {
    beforeEach(() => resetCoreStubs());

    test('records generated-prompt estimates for default and custom system prompts separately', () => {
        const custom = 'Return only a compact continuity ledger using the requested headings.';
        const defaultTokens = estimateTokens(DEFAULT_SYSTEM_PROMPT);
        const customTokens = estimateTokens(custom);

        expectNearTokenBaseline(defaultTokens, TOKEN_BASELINES.defaultSystemPrompt);
        expectNearTokenBaseline(customTokens, TOKEN_BASELINES.customSystemPrompt);
        expect(customTokens).toBeLessThan(defaultTokens);
    });

    test.each([
        ['off', false],
        ['passive', true],
    ])('records the current injected estimate for hook mode %s', (hookMode, includesSeed) => {
        saveWorldSettings({ hookMode });
        const payload = buildInjectionPayload(HOOK_BEARING_SCENE);
        const storedTokens = estimateTokens(HOOK_BEARING_SCENE);
        const injectedTokens = estimateTokens(payload);

        expectNearTokenBaseline(storedTokens, TOKEN_BASELINES.hookBearingStored);
        expectNearTokenBaseline(
            injectedTokens,
            hookMode === 'off' ? TOKEN_BASELINES.hookOffInjected : TOKEN_BASELINES.hookPassiveInjected,
        );
        expect(payload.includes('The courier sends a warning')).toBe(includesSeed);
    });

    test('records that passive injection currently costs more than off', () => {
        saveWorldSettings({ hookMode: 'off' });
        const off = estimateTokens(buildInjectionPayload(HOOK_BEARING_SCENE));
        saveWorldSettings({ hookMode: 'passive' });
        const passive = estimateTokens(buildInjectionPayload(HOOK_BEARING_SCENE));

        expect(passive).toBeGreaterThan(off);
    });
});

describe('Phase 0 Chronicle chronology and concurrency reproductions', () => {
    let requests;
    let response;
    let consolidationCompletion;

    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(CHAT);
        worldStateState.wstIsRefreshing = false;
        worldStateState.autoRefreshQueued = false;
        worldStateState.autoRefreshDeferTimer = null;
        chronicleState.isGenerating = false;
        chronicleState.isMainGenerating = false;
        chronicleState.msgSinceSnapshot = 0;
        chronicleState.countedReceiptEvents = new Map();
        _render.renderContent = vi.fn();
        _render.showRegenerateDiff = (_oldText, _newText, onChoice) => onChoice(true);
        _render.showConsolidationPreview = (_entries, _prompt, onConfirm) => {
            consolidationCompletion = onConfirm('');
            return consolidationCompletion;
        };
        saveChronicleSettings({
            apiUrl: 'https://example.test', modelName: 'test-model', syncWorldState: true,
        });
        requests = [];
        consolidationCompletion = null;
        response = chronicleOutput('June 4, 2026 evening');
        setFakeApi(async request => {
            requests.push(request);
            return typeof response === 'function' ? response(request, requests.length) : response;
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        chronicleState.isGenerating = false;
        chronicleState.isMainGenerating = false;
        _render.renderContent = null;
        _render.showRegenerateDiff = null;
        _render.showConsolidationPreview = null;
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.document;
    });

    test.each([
        ['June 4, 2026 2:30pm', 'June 4, 2026', '2:30pm'],
        ['June 4, 2026 2pm', 'June 4, 2026 2pm', 'Late afternoon'],
        ['June 4, 2026 late afternoon', 'June 4, 2026 late afternoon', 'Late afternoon'],
        ['June 4, 2026 evening', 'June 4, 2026 evening', 'Late afternoon'],
        ['Unknown', 'Unknown', 'Late afternoon'],
    ])('captures current Chronicle sync outcome for anchor %s', async (anchor, expectedDate, expectedTime) => {
        seedWorldState(MINIMAL_SCENE);
        response = chronicleOutput(anchor);

        const snapshot = await generateSnapshot();

        expect(snapshot).not.toBeNull();
        expect(snapshot.text).toContain(`period: ${anchor}`);
        expect(requests).toHaveLength(1);
        expect(snapshot.fromIndex).toBe(0);
        expect(snapshot.toIndex).toBe(7);
        expect(getWorldStateField('Date')).toBe(expectedDate);
        expect(getWorldStateField('Time')).toBe(expectedTime);
        expect(getWorldStateField('Location')).toBe('Harbour office');
    });

    test('records equal generated output estimates for hook modes off and passive', async () => {
        const { refreshWorldState } = await import('../world_state/refresh.js');
        const generatedTokens = {};

        for (const hookMode of ['off', 'passive']) {
            seedWorldState(UNCHANGED_SCENE_BEFORE);
            saveWorldSettings({
                apiUrl: 'https://example.test', modelName: 'test-model', hookMode, customPrompt: '',
            });
            response = HOOK_BEARING_SCENE;
            requests = [];

            const generated = await refreshWorldState();

            expect(generated).toBe(HOOK_BEARING_SCENE);
            expect(requests).toHaveLength(1);
            expect(requests[0].systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
            generatedTokens[hookMode] = estimateTokens(generated);
            expectNearTokenBaseline(
                generatedTokens[hookMode],
                hookMode === 'off' ? TOKEN_BASELINES.hookOffGenerated : TOKEN_BASELINES.hookPassiveGenerated,
            );
            // Current baseline: hook mode affects injection, not generation.
            expect(requests[0].systemPrompt).toContain('## Plot Seeds');
        }

        expect(generatedTokens.off).toBe(generatedTokens.passive);
    });

    test('proves a custom system prompt replaces the default on the real refresh path', async () => {
        const customPrompt = 'CUSTOM WORLD STATE PROTOCOL: return the requested Markdown document only.';
        seedWorldState(UNCHANGED_SCENE_BEFORE);
        saveWorldSettings({
            apiUrl: 'https://example.test', modelName: 'test-model', customPrompt,
        });
        response = UNCHANGED_SCENE_REFRESH;
        const { refreshWorldState } = await import('../world_state/refresh.js');

        const generated = await refreshWorldState();

        expect(generated).toBe(UNCHANGED_SCENE_REFRESH);
        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).toBe(customPrompt);
        expect(requests[0].systemPrompt).not.toContain('ABSOLUTE RULES:');
    });

    test('reproduces an older-entry regeneration changing the present scene', async () => {
        const older = makeChronicleSnapshot({
            id: 'old', createdAt: '2026-06-01T00:00:00.000Z', fromIndex: 0, toIndex: 3,
            anchorValue: 'June 1, 2026 2:30pm', location: 'Old ferry landing',
        });
        const newest = makeChronicleSnapshot({
            id: 'new', createdAt: '2026-06-04T00:00:00.000Z', fromIndex: 4, toIndex: 7,
            anchorValue: 'June 4, 2026 evening', location: 'Harbour office',
        });
        seedChronicle([older, newest]);
        seedWorldState(UNCHANGED_SCENE_BEFORE);
        response = chronicleOutput('June 1, 2026 2:30pm', 'Old ferry landing');

        await regenerateSnapshot('old');

        expect(requests).toHaveLength(1);
        expect(requests[0].userContent).toContain('Message 0 in the harbour chronology.');
        expect(requests[0].userContent).toContain('Message 3 in the harbour chronology.');
        expect(requests[0].userContent).not.toContain('Message 4 in the harbour chronology.');
        // Current unsafe baseline: an accepted regeneration of an older range
        // rewinds World State. Phase 2 should invert these final assertions.
        expect(getWorldStateText()).toContain('Date: June 1, 2026');
        expect(getWorldStateText()).toContain('Time: 2:30pm');
        expect(getWorldStateText()).toContain('Location: Old ferry landing');
        expect(getSnapshots().find(s => s.id === 'new')?.toIndex).toBe(7);
    });

    test('reproduces an older-range consolidation changing the present scene', async () => {
        const first = makeChronicleSnapshot({
            id: 'first', createdAt: '2026-06-01T00:00:00.000Z', fromIndex: 0, toIndex: 1,
            anchorValue: 'June 1, 2026 2pm', location: 'Customs quay',
        });
        const second = makeChronicleSnapshot({
            id: 'second', createdAt: '2026-06-02T00:00:00.000Z', fromIndex: 2, toIndex: 3,
            anchorValue: 'June 2, 2026 late afternoon', location: 'Old ferry landing',
        });
        const newest = makeChronicleSnapshot({
            id: 'newest', createdAt: '2026-06-04T00:00:00.000Z', fromIndex: 4, toIndex: 7,
            anchorValue: 'June 4, 2026 evening', location: 'Harbour office',
        });
        seedChronicle([first, second, newest]);
        seedWorldState(UNCHANGED_SCENE_BEFORE);
        response = chronicleOutput('June 2, 2026 late afternoon', 'Old ferry landing');

        await consolidateEntries(['first', 'second']);
        await consolidationCompletion;

        expect(requests).toHaveLength(1);
        expect(requests[0].userContent).toContain(first.text);
        expect(requests[0].userContent).toContain(second.text);
        expect(requests[0].userContent).not.toContain(newest.text);
        expect(getSnapshots().some(s => s.id === 'newest' && s.toIndex === 7)).toBe(true);
        // Current unsafe baseline: consolidating [0, 3] rewinds a scene whose
        // newest Chronicle range ends at 7. Phase 2 should leave this unchanged.
        expect(getWorldStateText()).toContain('Date: June 2, 2026 late afternoon');
        expect(getWorldStateText()).toContain('Location: Old ferry landing');
    });

    test('proves a Chronicle sync can invalidate an in-flight World State refresh', async () => {
        seedWorldState(UNCHANGED_SCENE_BEFORE);
        saveWorldSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });

        let releaseRefresh;
        response = request => {
            if (request.systemPrompt === DEFAULT_SYSTEM_PROMPT) {
                return new Promise(resolve => { releaseRefresh = resolve; });
            }
            return chronicleOutput('June 4, 2026 evening', 'Harbour office');
        };
        const { refreshWorldState } = await import('../world_state/refresh.js');
        const refresh = refreshWorldState();
        await vi.waitFor(() => expect(releaseRefresh).toBeTypeOf('function'));

        const snapshot = await generateSnapshot();
        expect(snapshot).not.toBeNull();
        const refreshRequest = requests.find(request => request.systemPrompt === DEFAULT_SYSTEM_PROMPT);
        const snapshotRequest = requests.find(request => request.systemPrompt === CHRONICLE_SYSTEM_PROMPT);
        expect(refreshRequest?.userContent).toContain(UNCHANGED_SCENE_BEFORE);
        expect(snapshotRequest?.userContent).toContain(UNCHANGED_SCENE_BEFORE);
        for (const request of [refreshRequest, snapshotRequest]) {
            expect(request.userContent).toContain('Message 0 in the harbour chronology.');
            expect(request.userContent).toContain('Message 7 in the harbour chronology.');
            expect(request.userContent).not.toContain('Message 8 in the harbour chronology.');
            expect(request.userContent).not.toContain('Message 9 in the harbour chronology.');
        }
        expect(snapshot.fromIndex).toBe(0);
        expect(snapshot.toIndex).toBe(7);
        expect(getWorldStateText()).toContain('Date: June 4, 2026 evening');

        releaseRefresh(UNCHANGED_SCENE_REFRESH);
        const result = await refresh;

        // Current unsafe baseline: Chronicle's direct metadata write changes
        // the captured revision, so the already-paid refresh is discarded.
        expect(result).toBeNull();
        expect(getWorldStateText()).toContain('Date: June 4, 2026 evening');
        expect(getWorldStateText()).not.toContain('Customs Row');
        expect(getFakeMeta().world_state_tracker_metadata.text).toBe(getWorldStateText());
    });
});