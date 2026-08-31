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
import { triggerGenerate } from '../interiority/index.js';
import { state as interiorityState } from '../interiority/data.js';

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
