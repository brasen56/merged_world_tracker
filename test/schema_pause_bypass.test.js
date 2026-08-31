/**
 * test/schema_pause_bypass.test.js — Part 6 (§7.4): the manual/direct
 * generation bypass class.
 *
 * The event router declines a paused module's AUTOMATIC work, but direct
 * entry points (buttons, slash commands) reach the API-spending choke points
 * without passing the router. Before the fix, generateSnapshot() et al. read
 * the unprepared store, spent the API call, and then had their refused write
 * seam hide that the "successful" result was never saved. Every choke point
 * must refuse while its store is paused for the current scope — and spend
 * nothing doing so.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    pauseStore,
    _setScopeKeyResolver,
    _resetPausedStores,
} from '../core/schema_status.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import { _resetEpoch } from '../core/scope.js';

import { generateSnapshot, regenerateSnapshot, consolidateEntries } from '../chronicle/snapshots.js';
import { state as chronicleState } from '../chronicle/data.js';
import { generatePlan } from '../story_planner/generation.js';
import { markBeatPlanted } from '../story_planner/index.js';
import { makeArc, setArcs, getArcs } from '../story_planner/data.js';
import { triggerGenerate } from '../interiority/index.js';
import { state as interiorityState } from '../interiority/data.js';
import { refreshWorldState } from '../world_state/refresh.js';
import { regenerateSection } from '../world_state/sections.js';
import { state as worldStateState } from '../world_state/data.js';
import { saveSettings as saveWorldStateSettings } from '../world_state/settings.js';
import { triggerScan, scanAndAccept } from '../knowledge/index.js';
import {
    runPsychoanalyzeProfile,
    runGrowthProfile,
    runCaptureOnly,
    runContinuousCapture,
    runConsolidation,
    regenerateProfile,
    runIlsBackfillCapture,
    runCatchUpCapture,
    saveProfile,
} from '../knowledge/growth.js';

import { resetCoreStubs, setFakeChat, setFakeApi } from './stubs/core.js';

// ─── Shared harness ───────────────────────────────────────────────────────────

let apiCalls = [];

/** An API fake that records every spend and returns a parseable entry. */
function countingApi() {
    apiCalls = [];
    setFakeApi(() => {
        apiCalls.push(true);
        return '## Summary\n- something happened.\n\n## Open Loops\n- a debt is due.';
    });
}

async function flushInteriorityQueue() {
    await interiorityState.workQueue.catch(() => {});
    await new Promise(r => setTimeout(r, 20));
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _resetDiagnostics();
    _resetPausedStores();
    _setScopeKeyResolver(() => 'chat:pause-bypass');
    setFakeChat([{ mes: 'hi', name: 'Mara', is_user: false, extra: {}, send_date: '2026-01-01T00:00:00.000Z' }]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    _resetPausedStores();
    _setScopeKeyResolver(null);
});

// ─── Chronicle: every API-spending choke point refuses while paused ──────────

describe('Chronicle direct generation refuses while the store is paused', () => {
    test('generateSnapshot / regenerateSnapshot / consolidateEntries spend nothing and say why', async () => {
        countingApi();
        pauseStore('chronicle', { reasonCode: 'future-version', message: 'blocked' });

        await expect(generateSnapshot()).resolves.toBe(null);
        await expect(regenerateSnapshot('whatever')).resolves.toBe(undefined);
        await expect(consolidateEntries(['a', 'b'])).resolves.toBe(undefined);

        // No API call was spent, and the refusal is visible in the tab status.
        expect(apiCalls).toHaveLength(0);
        expect(chronicleState._lastStatusMsg).toContain('paused for this chat');
    });
});

// ─── Story Planner: the plan-generation choke point ───────────────────────────

describe('Story Planner generatePlan refuses while the store is paused', () => {
    test('manual throws a repairable error; auto returns null silently — no API spend', async () => {
        countingApi();
        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'blocked' });

        await expect(generatePlan(true)).resolves.toBe(null);
        await expect(generatePlan(false)).rejects.toThrow(/paused for this chat/);

        expect(apiCalls).toHaveLength(0);
    });
});

// ─── Story Planner: /wt-beat's false-success bypass (the §7.4 sibling) ───────

describe('Story Planner /wt-beat refuses while the store is paused', () => {
    test('markBeatPlanted reports the pause instead of "— planted." over a refused write', async () => {
        countingApi();
        // Seed a genuinely waiting arc BEFORE pausing — the seam refuses writes
        // while paused, so the setup has to happen first.
        const arc = { ...makeArc({ title: 'Pause Arc', beats: ['step one', 'step two'] }), turnsSinceAdvance: 3 };
        setArcs([arc]);
        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'blocked' });

        const result = markBeatPlanted(1);

        // core/commands.js prints result.message verbatim: it must name the
        // pause, not "— planted." over a write the seam never committed.
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/paused for this chat/);
        // And the store kept its previous value — the beat never advanced.
        expect(getArcs()[0].beatIndex).toBe(0);
        expect(apiCalls).toHaveLength(0);
    });

    test('the guard fires before the beat list is even read', () => {
        countingApi();
        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'blocked' });

        // No arcs exist: without the guard this returns "No arcs are waiting on
        // a setup beat." — reaching the pause message proves the check is first.
        const result = markBeatPlanted(1);
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/paused for this chat/);
    });
});

// ─── Interiority: even `force` (the 💭 button / /wt-thoughts) cannot bypass ───

describe('Interiority triggerGenerate refuses while the store is paused', () => {
    test('force does not override a data-integrity stop; a breadcrumb names the pause', async () => {
        countingApi();
        pauseStore('interiority', { reasonCode: 'per-message-legacy-pending', message: 'preparing' });

        const result = await triggerGenerate(); // trigger defaults to MANUAL (force)
        await flushInteriorityQueue();

        expect(result).toBe(null);
        expect(apiCalls).toHaveLength(0);
        // The gate's decision is in the diagnostics ring, so a dead-looking
        // button is explainable from the panel.
        const blocked = getEvents().find(e => e.event === 'generation_blocked');
        expect(blocked?.detail?.reason).toBe('store-paused');
    });
});

// ─── World State: the refresh / section-regen choke points ─────────────────────

describe('World State refresh refuses while the store is paused', () => {
    test('full refresh and section regen spend nothing and say why', async () => {
        countingApi();
        saveWorldStateSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        worldStateState.wstIsRefreshing = false;
        pauseStore('worldState', { reasonCode: 'future-version', message: 'blocked' });

        // Auto declines silently (the router declines those anyway); the
        // manual button / /wt-refresh gets the repairable error.
        await expect(refreshWorldState(true)).resolves.toBe(null);
        await expect(refreshWorldState()).rejects.toThrow(/paused for this chat/);
        await expect(regenerateSection('Pending', 2)).rejects.toThrow(/paused for this chat/);

        expect(apiCalls).toHaveLength(0);
    });
});

// ─── Knowledge: the manual scan choke points ───────────────────────────────────

describe('Knowledge manual scans refuse while any module store is paused', () => {
    test('triggerScan throws and scanAndAccept writes nothing — even for a counters-only pause', async () => {
        countingApi();
        // A pause limited to the counters store must still stop the whole
        // module's work — scanAndAccept() WRITES to lorebook entries.
        pauseStore('knowledgeCounters', { reasonCode: 'future-version', message: 'blocked' });

        await expect(triggerScan()).rejects.toThrow(/paused for this chat/);
        await expect(scanAndAccept()).resolves.toEqual([]);

        expect(apiCalls).toHaveLength(0);
    });

    test('a blocked lorebook store refuses triggerScan before any state read', async () => {
        countingApi();
        pauseStore('knowledgeStore', { reasonCode: 'future-version', message: 'blocked' });

        await expect(triggerScan()).rejects.toThrow(/paused for this chat/);

        expect(apiCalls).toHaveLength(0);
    });
});

// ─── Knowledge: the Growth profiler's manual buttons (the §7.4 gap) ──────────

describe('Knowledge growth profiler refuses while any module store is paused', () => {
    test('every manual growth entry point throws before any state read or API spend', async () => {
        countingApi();
        // Growth writes through the evidence seam (saveEvidenceMap), so an
        // evidence-only pause must stop it exactly like a full-module pause.
        pauseStore('knowledgeEvidence', { reasonCode: 'future-version', message: 'blocked' });

        // 'Mara' is deliberately NOT enrolled in the registry: each call must
        // reach the PAUSE refusal, not the "not in the NPC registry" throw,
        // proving the guard fires before any state is read.
        await expect(runPsychoanalyzeProfile('Mara')).rejects.toThrow(/paused for this chat/);
        await expect(runGrowthProfile('Mara')).rejects.toThrow(/paused for this chat/);
        await expect(runCaptureOnly('Mara')).rejects.toThrow(/paused for this chat/);
        await expect(runConsolidation('Mara')).rejects.toThrow(/paused for this chat/);
        await expect(regenerateProfile('Mara')).rejects.toThrow(/paused for this chat/);
        await expect(runIlsBackfillCapture('Mara')).rejects.toThrow(/paused for this chat/);
        await expect(runCatchUpCapture('Mara')).rejects.toThrow(/paused for this chat/);
        // The lower-level continuous-capture choke point refuses the same way
        // — every capture path (Capture's delta pass, the auto cadence, Catch
        // Up) flows through it. An unenrolled NPC would return null here, so
        // the throw proves the guard fires before the registry read.
        await expect(runContinuousCapture('Mara')).rejects.toThrow(/paused for this chat/);
        // Save to Lorebook throws for the same reason — the handler's catch
        // flashes the repairable message, where a silent {success:false} would
        // read "Save failed: undefined" (result.error is never set).
        await expect(saveProfile('Mara', 'profile text')).rejects.toThrow(/paused for this chat/);

        expect(apiCalls).toHaveLength(0);
    });
});
