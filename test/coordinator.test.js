/**
 * test/coordinator.test.js — Central generation coordinator (TODO §1 / PI §P1).
 *
 * The coordinator is the one place that knows what is in flight across all
 * five modules. The properties worth pinning here are the ones the TODO
 * item enumerates:
 *
 *   1. Per-module + global concurrency limits — one generation per module,
 *      `apiMaxConcurrent` across modules, read live from the global settings.
 *   2. Priorities — manual work jumps ahead of automatic/background work.
 *   3. Dedupe of pending (QUEUED) jobs by key.
 *   4. Cancellation — queued jobs never start; running jobs abort through
 *      the composed signal; a chat switch (epoch bump) retires stale jobs.
 *   5. Unified status — queued/running/ok/failed/cancelled, snapshot shape.
 *   6. The optional "hold background jobs while the user is generating"
 *      policy — depth-counted, double-fire safe, OFF by default.
 *
 * Plus the transport adoption contract: core/api.js routes both fetch
 * functions through submitJob, classifies triggers, forwards signals to
 * fetch(), and never retries an aborted request.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    submitJob,
    cancelWhere,
    onChatScopeChanged,
    beginUserGeneration,
    endUserGeneration,
    pumpCoordinator,
    getCoordinatorSnapshot,
    isCancellation,
    PRIORITY,
    DEFAULT_GLOBAL_LIMIT,
    MAX_GLOBAL_LIMIT,
    _resetCoordinator,
    _setCoordinatorResolvers,
} from '../core/coordinator.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { _resetDiagnostics, getEvents, getLastApiCall } from '../core/diagnostics.js';
import { fetchFromApi, fetchViaConnectionProfile, retryAsync } from '../core/api.js';
// The Connection Manager host seam (aliased in vitest.config.js) — the same
// module instance core/api.js lazy-loads, so a spy here is the wire call.
import { ConnectionManagerRequestService } from './stubs/shared.js';
import { GLOBAL_SETTINGS_DEFAULTS } from '../core/settings.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

/** Controllable promise: a job whose run() returns this gate never settles
 *  until the test says so — the only way to observe queued/running states
 *  deterministically. */
function gate() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Let every settle→pump→start microtask chain run out. */
async function settle() {
    await new Promise(r => setTimeout(r, 0));
}

/** A resolved fetch-style Response double. */
function okResponse(content = 'ok') {
    return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }),
    };
}

const SETTINGS = { apiUrl: 'https://example.test/v1', apiKey: 'k', modelName: 'test-model', maxTokens: 100 };

beforeEach(() => {
    _resetCoordinator();
    _resetDiagnostics();
    _resetEpoch();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ─── 1. Concurrency limits ───────────────────────────────────────────────────

describe('concurrency limits', () => {
    test('a job with free slots starts immediately and resolves with the run result', async () => {
        const handle = submitJob({ module: 'world_state', kind: 'test', run: async () => 42 });
        expect(handle.state).toBe('running');
        await expect(handle.promise).resolves.toBe(42);
        expect(handle.state).toBe('ok');
    });

    test('per-module limit 1: a second job for the same module queues until the first settles', async () => {
        const started = [];
        const g = gate();
        const j1 = submitJob({ module: 'world_state', run: () => { started.push('j1'); return g.promise; } });
        const j2 = submitJob({ module: 'world_state', run: async () => { started.push('j2'); return 'done'; } });
        expect(j1.state).toBe('running');
        expect(j2.state).toBe('queued');
        expect(started).toEqual(['j1']);
        g.resolve('value');
        await settle();
        expect(started).toEqual(['j1', 'j2']);
        await expect(j1.promise).resolves.toBe('value');
        await expect(j2.promise).resolves.toBe('done');
    });

    test('different modules run in parallel (that is the point of the global limit)', async () => {
        const g1 = gate();
        const g2 = gate();
        const j1 = submitJob({ module: 'world_state', run: () => g1.promise });
        const j2 = submitJob({ module: 'chronicle', run: () => g2.promise });
        expect(j1.state).toBe('running');
        expect(j2.state).toBe('running');
        g1.resolve(1);
        g2.resolve(2);
        await settle();
        await expect(j1.promise).resolves.toBe(1);
        await expect(j2.promise).resolves.toBe(2);
    });

    test('default global limit is 2 — a third module queues until a slot frees', async () => {
        // Default resolvers: no settings record → the documented default.
        const g1 = gate();
        const g2 = gate();
        submitJob({ module: 'world_state', run: () => g1.promise });
        submitJob({ module: 'chronicle', run: () => g2.promise });
        const j3 = submitJob({ module: 'knowledge', run: async () => 'third' });
        expect(j3.state).toBe('queued');
        expect(getCoordinatorSnapshot().limits.global).toBe(DEFAULT_GLOBAL_LIMIT);
        g1.resolve();
        await settle();
        expect(j3.state).toBe('ok');
        await expect(j3.promise).resolves.toBe('third');
    });

    test('the global limit is read live from the settings record and clamped', () => {
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 1 }) });
        expect(getCoordinatorSnapshot().limits.global).toBe(1);
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 999 }) });
        expect(getCoordinatorSnapshot().limits.global).toBe(MAX_GLOBAL_LIMIT);
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 'garbage' }) });
        expect(getCoordinatorSnapshot().limits.global).toBe(DEFAULT_GLOBAL_LIMIT);
    });

    test('pumpCoordinator() releases queued jobs after a limit is raised', async () => {
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 1 }) });
        const g1 = gate();
        submitJob({ module: 'world_state', run: () => g1.promise });
        const j2 = submitJob({ module: 'chronicle', run: async () => 'released' });
        expect(j2.state).toBe('queued');
        // The user saves a higher limit → the Settings handler calls this.
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 3 }) });
        pumpCoordinator();
        expect(j2.state).toBe('running');
        g1.resolve();
        await settle();
        await expect(j2.promise).resolves.toBe('released');
    });

    test('no head-of-line blocking: a queued job that cannot start does not stop later ones', async () => {
        // world_state occupies its module slot; a second world_state job must
        // not prevent an unrelated chronicle job from using a free global slot.
        const g1 = gate();
        submitJob({ module: 'world_state', run: () => g1.promise });
        const j2 = submitJob({ module: 'world_state', run: async () => 'ws2' });
        const j3 = submitJob({ module: 'chronicle', run: async () => 'ch' });
        expect(j2.state).toBe('queued');
        expect(j3.state).toBe('running');
        g1.resolve();
        await settle();
        expect(j2.state).toBe('ok');
    });

    test('GLOBAL_SETTINGS_DEFAULTS declares the documented coordinator settings', () => {
        expect(GLOBAL_SETTINGS_DEFAULTS.apiMaxConcurrent).toBe(2);
        expect(GLOBAL_SETTINGS_DEFAULTS.pauseBackgroundJobsDuringGeneration).toBe(false);
    });
});

// ─── 2. Priorities ───────────────────────────────────────────────────────────

describe('priority queue', () => {
    test('manual work jumps ahead of queued background work when a slot frees', async () => {
        const started = [];
        const g1 = gate();
        // Pin the global limit to 1 so only the occupier holds a slot.
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 1 }) });
        submitJob({ module: 'world_state', run: () => { started.push('occupier'); return g1.promise; } });
        const bg = submitJob({ module: 'chronicle', priority: PRIORITY.BACKGROUND, run: async () => { started.push('bg'); } });
        const manual = submitJob({ module: 'knowledge', priority: PRIORITY.MANUAL, run: async () => { started.push('manual'); } });
        expect(bg.state).toBe('queued');
        expect(manual.state).toBe('queued');
        g1.resolve();
        await settle();
        // MANUAL (0) starts before BACKGROUND (10) despite arriving later.
        expect(started).toEqual(['occupier', 'manual', 'bg']);
    });

    test('FIFO within the same priority', async () => {
        const started = [];
        const g1 = gate();
        submitJob({ module: 'world_state', run: () => g1.promise });
        submitJob({ module: 'chronicle', priority: PRIORITY.AUTO, run: async () => { started.push('a'); } });
        submitJob({ module: 'knowledge', priority: PRIORITY.AUTO, run: async () => { started.push('b'); } });
        g1.resolve();
        await settle();
        expect(started).toEqual(['a', 'b']);
    });
});

// ─── 3. Dedupe of pending jobs ───────────────────────────────────────────────

describe('dedupe by key', () => {
    test('a submit with an equal key JOINS a queued job instead of queueing a second', async () => {
        // Fill both global slots so the keyed job stays queued.
        const g1 = gate();
        const g2 = gate();
        submitJob({ module: 'world_state', run: () => g1.promise });
        submitJob({ module: 'chronicle', run: () => g2.promise });
        let runs = 0;
        const j1 = submitJob({
            module: 'knowledge',
            key: 'knowledge:auto-update',
            run: async () => { runs += 1; return 'once'; },
        });
        const j2 = submitJob({
            module: 'knowledge',
            key: 'knowledge:auto-update',
            run: async () => { runs += 1; return 'twice'; },
        });
        expect(j2.id).toBe(j1.id); // same handle — joined, not duplicated
        expect(getCoordinatorSnapshot().queued).toHaveLength(1);
        g1.resolve();
        g2.resolve();
        await settle();
        expect(runs).toBe(1);
        await expect(j1.promise).resolves.toBe('once');
        await expect(j2.promise).resolves.toBe('once');
        // The join is visible in the diagnostics ring.
        expect(getEvents().some(e => e.event === 'job_deduped')).toBe(true);
    });

    test('dedupe never joins RUNNING work — a same-key submit while running queues a fresh job', async () => {
        let runs = 0;
        const g = gate();
        const j1 = submitJob({ module: 'world_state', key: 'k', run: () => { runs += 1; return g.promise; } });
        const j2 = submitJob({ module: 'world_state', key: 'k', run: async () => { runs += 1; return 'second'; } });
        expect(j1.state).toBe('running');
        expect(j2.state).toBe('queued'); // module slot busy → queued, NOT joined
        g.resolve('first');
        await settle();
        expect(runs).toBe(2);
        await expect(j2.promise).resolves.toBe('second');
    });

    test('different keys never dedupe', () => {
        const g1 = gate();
        const g2 = gate();
        submitJob({ module: 'world_state', run: () => g1.promise });
        submitJob({ module: 'chronicle', run: () => g2.promise });
        submitJob({ module: 'knowledge', key: 'a', run: async () => {} });
        submitJob({ module: 'knowledge', key: 'b', run: async () => {} });
        expect(getCoordinatorSnapshot().queued).toHaveLength(2);
        g1.resolve();
        g2.resolve();
    });
});

// ─── 4. Cancellation ─────────────────────────────────────────────────────────

describe('cancellation', () => {
    test('cancelling a queued job prevents it from ever starting', async () => {
        let ran = false;
        const g1 = gate();
        const g2 = gate();
        submitJob({ module: 'world_state', run: () => g1.promise });
        submitJob({ module: 'chronicle', run: () => g2.promise });
        const j = submitJob({ module: 'knowledge', run: async () => { ran = true; } });
        expect(j.cancel('test')).toBe(true);
        await expect(j.promise).rejects.toMatchObject({ _mwtCancelled: true });
        expect(ran).toBe(false);
        g1.resolve();
        g2.resolve();
        await settle();
        // Settled history records the cancellation, not a failure.
        const snap = getCoordinatorSnapshot();
        expect(snap.recentSettled.some(r => r.state === 'cancelled' && r.module === 'knowledge')).toBe(true);
    });

    test('cancelling a settled job is a no-op', async () => {
        const j = submitJob({ module: 'world_state', run: async () => 1 });
        await j.promise;
        expect(j.cancel()).toBe(false);
    });

    test('cancelling a running job aborts the signal the run received', async () => {
        let observedAbort = false;
        const j = submitJob({
            module: 'world_state',
            run: ({ signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    observedAbort = true;
                    const err = new Error('This operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            }),
        });
        expect(j.cancel('chat-changed')).toBe(true);
        await expect(j.promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(observedAbort).toBe(true);
        // The native AbortError is classified as a cancellation, not a failure.
        expect(getCoordinatorSnapshot().recentSettled.at(-1).state).toBe('cancelled');
    });

    test('a cancelled running job whose run RESOLVES anyway settles cancelled, never ok', async () => {
        // The Connection Manager transport cannot observe its signal
        // (sendRequest has no signal parameter), so a cancelled job's run may
        // still RESOLVE. The composed signal is the authority: the stale
        // result is discarded and the submitter sees a cancellation
        // rejection named after the real cancel reason.
        const g = gate();
        let receivedSignal = null;
        const j = submitJob({
            module: 'world_state',
            run: ({ signal }) => {
                receivedSignal = signal;
                return g.promise; // a signal-ignoring run
            },
        });
        expect(j.state).toBe('running');
        expect(j.cancel('chat-changed')).toBe(true);
        expect(receivedSignal.aborted).toBe(true);
        g.resolve('stale result'); // the wire call finishes anyway
        await expect(j.promise).rejects.toMatchObject({
            name: 'JobCancelledError',
            _mwtCancelled: true,
            message: 'Job cancelled (chat-changed)',
        });
        expect(j.state).toBe('cancelled');
        const snap = getCoordinatorSnapshot();
        expect(snap.running).toHaveLength(0);
        expect(snap.recentSettled.at(-1)).toMatchObject({ state: 'cancelled', module: 'world_state' });
        expect(snap.recentSettled.some(r => r.state === 'ok')).toBe(false);
    });

    test('an external signal cancels the job before queueing when already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const j = submitJob({ module: 'world_state', signal: ac.signal, run: async () => 'never' });
        await expect(j.promise).rejects.toMatchObject({ _mwtCancelled: true });
        // The handle must settle through the normal cancellation path — a
        // bare rejection used to leave a ghost `queued` handle that appears
        // in no snapshot and never reaches the settled history.
        expect(j.state).toBe('cancelled');
        const snap = getCoordinatorSnapshot();
        expect(snap.queued).toHaveLength(0);
        expect(snap.running).toHaveLength(0);
        const settled = snap.recentSettled.at(-1);
        expect(settled).toMatchObject({ state: 'cancelled', module: 'world_state' });
        expect(settled.endedAt).toBeTypeOf('number');
        expect(settled.error).toContain('external-signal');
    });

    test('an external signal aborts a running job (composed with the job signal)', async () => {
        const ac = new AbortController();
        const j = submitJob({
            module: 'world_state',
            signal: ac.signal,
            run: ({ signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err._mwtCancelled = true;
                    reject(err);
                });
            }),
        });
        ac.abort();
        await expect(j.promise).rejects.toMatchObject({ _mwtCancelled: true });
        expect(j.state).toBe('cancelled');
    });

    test('cancelWhere(module) retires only that module, and reports counts', async () => {
        const g1 = gate();
        const g2 = gate();
        submitJob({ module: 'world_state', run: () => g1.promise });
        submitJob({ module: 'chronicle', run: () => g2.promise });
        const q1 = submitJob({ module: 'knowledge', run: async () => 'queued-a' });
        const q2 = submitJob({ module: 'knowledge', run: async () => 'queued-b' });
        const counts = cancelWhere({ module: 'knowledge' });
        expect(counts).toEqual({ queued: 2, running: 0 });
        expect(getCoordinatorSnapshot().running).toHaveLength(2); // untouched
        // Both cancelled submissions see the marked rejection.
        await expect(q1.promise).rejects.toMatchObject({ _mwtCancelled: true });
        await expect(q2.promise).rejects.toMatchObject({ _mwtCancelled: true });
        g1.resolve();
        g2.resolve();
        await settle();
    });

    test('a chat switch (epoch bump + onChatScopeChanged) retires stale jobs only', async () => {
        // Pin the global limit to 1: the running job holds the slot, so the
        // second submit stays queued and BOTH are stale after the bump.
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 1 }) });
        const staleRunning = submitJob({
            module: 'world_state',
            run: ({ signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            }),
        });
        const staleQueued = submitJob({ module: 'knowledge', run: async () => 'stale' });
        expect(staleRunning.state).toBe('running');
        expect(staleQueued.state).toBe('queued');

        bumpEpoch(); // what the root CHAT_CHANGED handler does FIRST
        const counts = onChatScopeChanged();

        expect(counts).toEqual({ queued: 1, running: 1 });
        await expect(staleQueued.promise).rejects.toMatchObject({ _mwtCancelled: true });
        await expect(staleRunning.promise).rejects.toMatchObject({ name: 'AbortError' });
        // The fresh-epoch job submitted AFTER the switch is untouched and
        // inherits the freed slot immediately.
        const fresh = submitJob({ module: 'interiority', run: async () => 'fresh' });
        expect(fresh.state).toBe('running');
        await expect(fresh.promise).resolves.toBe('fresh');
        expect(getEvents().some(e => e.event === 'jobs_cancelled_chat_changed')).toBe(true);
    });

    test('onChatScopeChanged never lets a stale queued job START mid-sweep', async () => {
        // Two stale running jobs + one stale queued job. Aborting the first
        // running job settles→pumps; the queued stale job must be dequeued
        // BEFORE that pump, or it would start (and spend) before being
        // cancelled at its own loop turn.
        const mkAbortable = (module) => submitJob({
            module,
            run: ({ signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            }),
        });
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 2 }) });
        const r1 = mkAbortable('world_state');
        const r2 = mkAbortable('chronicle');
        let ran = false;
        const staleQueued = submitJob({ module: 'knowledge', run: async () => { ran = true; } });
        expect(staleQueued.state).toBe('queued');
        bumpEpoch();
        onChatScopeChanged();
        await expect(staleQueued.promise).rejects.toMatchObject({ _mwtCancelled: true });
        await expect(r1.promise).rejects.toMatchObject({ name: 'AbortError' });
        await expect(r2.promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(ran).toBe(false);
    });
});

// ─── 5. User-generation policy + unified status ──────────────────────────────

describe('user-generation policy', () => {
    test('OFF by default: background jobs run while a user-generation window is open', async () => {
        beginUserGeneration();
        const j = submitJob({ module: 'world_state', background: true, run: async () => 'ran' });
        expect(j.state).toBe('running');
        await expect(j.promise).resolves.toBe('ran');
        endUserGeneration();
    });

    test('ON: background jobs hold while the user generates; manual work never does', async () => {
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ pauseBackgroundJobsDuringGeneration: true }) });
        beginUserGeneration();
        const bg = submitJob({ module: 'world_state', background: true, run: async () => 'bg' });
        const manual = submitJob({ module: 'chronicle', priority: PRIORITY.MANUAL, run: async () => 'manual' });
        expect(bg.state).toBe('queued');      // held
        expect(manual.state).toBe('running'); // never held
        await expect(manual.promise).resolves.toBe('manual');

        endUserGeneration();
        expect(bg.state).toBe('running');
        await expect(bg.promise).resolves.toBe('bg');
        // Hold + release are both visible in the ring.
        const names = getEvents().map(e => e.event);
        expect(names).toContain('job_held');
        expect(names).toContain('queue_resumed');
    });

    test('depth-counted: a double-fired stop event cannot wedge the gate negative', async () => {
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ pauseBackgroundJobsDuringGeneration: true }) });
        beginUserGeneration();
        // ST can fire BOTH GENERATION_STOPPED and GENERATION_ENDED for one
        // generation (BUG_REPORTS/01_core.md #4) — the depth must floor at 0.
        endUserGeneration();
        endUserGeneration();
        beginUserGeneration();
        const j = submitJob({ module: 'world_state', background: true, run: async () => 'ok' });
        expect(j.state).toBe('queued'); // still one window open
        endUserGeneration();
        expect(j.state).toBe('running');
        await expect(j.promise).resolves.toBe('ok');
    });
});

describe('unified status', () => {
    test('the snapshot is JSON-safe and carries every job dimension', async () => {
        // Pin the global limit to 1 so the second job stays queued.
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 1 }) });
        const g = gate();
        submitJob({ module: 'world_state', run: () => g.promise });
        submitJob({ module: 'chronicle', priority: PRIORITY.BACKGROUND, background: true, run: async () => {} });
        const snap = getCoordinatorSnapshot();
        expect(snap.limits).toEqual({ global: 1, perModule: 1 }); // pinned above
        expect(snap.running).toHaveLength(1);
        expect(snap.queued).toHaveLength(1);
        expect(JSON.parse(JSON.stringify(snap.running[0]))).toMatchObject({
            module: 'world_state', state: 'running', priority: PRIORITY.AUTO,
        });
        expect(snap.queued[0]).toMatchObject({ module: 'chronicle', background: true, state: 'queued' });
        g.resolve();
        await settle();
        const settled = getCoordinatorSnapshot().recentSettled;
        // The background job may also have run and settled by now — find by
        // identity instead of assuming recency order.
        expect(settled.find(r => r.module === 'world_state')).toMatchObject({ module: 'world_state', state: 'ok' });
        expect(settled.find(r => r.module === 'world_state').durationMs).toBeGreaterThanOrEqual(0);
    });

    test('a thrown error settles as failed with its message recorded', async () => {
        const j = submitJob({ module: 'world_state', run: async () => { throw new Error('boom'); } });
        await expect(j.promise).rejects.toThrow('boom');
        expect(getCoordinatorSnapshot().recentSettled.at(-1)).toMatchObject({ state: 'failed', error: 'boom' });
    });

    test('job start/settle dispatches mwt:busy-changed (the modules existing UI event)', async () => {
        // The coordinator guards on `document` so the pure module works in
        // Node; install the minimal fake the guard needs.
        const dispatched = [];
        const fakeDoc = { dispatchEvent: e => dispatched.push(e) };
        const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
        const prevDocument = globalThis.document;
        if (typeof globalThis.CustomEvent !== 'function') {
            globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
        }
        globalThis.document = fakeDoc;
        try {
            const j = submitJob({ module: 'world_state', run: async () => 1 });
            await j.promise;
            expect(dispatched.some(e => e.type === 'mwt:busy-changed')).toBe(true);
        } finally {
            if (hadDocument) globalThis.document = prevDocument;
            else delete globalThis.document;
        }
    });
});

// ─── 6. Transport adoption (core/api.js) ─────────────────────────────────────

describe('transport adoption — fetchFromApi routes through the coordinator', () => {
    test('fetch() receives a real AbortSignal derived from the job + caller signals', async () => {
        let seenSignal = null;
        globalThis.fetch = vi.fn(async (_url, opts) => {
            seenSignal = opts.signal;
            return okResponse('payload');
        });
        const ac = new AbortController();
        const out = await fetchFromApi({
            systemPrompt: 's', userContent: 'u', settings: SETTINGS, retries: 0, trigger: 'manual', signal: ac.signal,
        });
        expect(out).toBe('payload');
        expect(seenSignal).toBeTruthy();
        expect(seenSignal.aborted).toBe(false);
    });

    test('aborting mid-flight rejects, is classified cancelled, and is NOT retried', async () => {
        let attempts = 0;
        globalThis.fetch = vi.fn((_url, opts) => new Promise((_res, rej) => {
            attempts += 1;
            opts.signal.addEventListener('abort', () => {
                const err = new Error('This operation was aborted');
                err.name = 'AbortError';
                rej(err);
            });
        }));
        const ac = new AbortController();
        const pending = fetchFromApi({
            systemPrompt: 's', userContent: 'u', settings: SETTINGS, retries: 2, trigger: 'manual', signal: ac.signal,
        });
        await settle();
        expect(attempts).toBe(1);
        ac.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(attempts).toBe(1); // an abort is never retried
        // The Last-request capture reads it as cancelled, not failed.
        const cap = getLastApiCall('api');
        expect(cap).toBeTruthy();
        expect(cap).toMatchObject({ ok: false, errorClass: 'cancelled' });
    });

    test('trigger classification: automatic triggers are background work held by the policy', async () => {
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ pauseBackgroundJobsDuringGeneration: true }) });
        globalThis.fetch = vi.fn(async () => okResponse('late'));
        beginUserGeneration();
        const pending = fetchFromApi({ systemPrompt: 's', userContent: 'u', settings: SETTINGS, retries: 0, trigger: 'auto' });
        await settle();
        expect(globalThis.fetch).not.toHaveBeenCalled(); // held
        endUserGeneration();
        await expect(pending).resolves.toBe('late');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test('trigger classification: manual/absent triggers are foreground work, never held', async () => {
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ pauseBackgroundJobsDuringGeneration: true }) });
        globalThis.fetch = vi.fn(async () => okResponse('now'));
        beginUserGeneration();
        await expect(fetchFromApi({ systemPrompt: 's', userContent: 'u', settings: SETTINGS, retries: 0, trigger: 'manual' })).resolves.toBe('now');
        await expect(fetchFromApi({ systemPrompt: 's', userContent: 'u', settings: SETTINGS, retries: 0 })).resolves.toBe('now');
        endUserGeneration();
    });

    test('trigger classification: slash_command (/wt-thoughts) is foreground work, never held', async () => {
        // A slash command is explicit user intent — interiority's TRIGGER
        // table groups MANUAL and SLASH_COMMAND as "force, UNGATED" — so it
        // must not be held by the pause policy while a generation is open.
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ pauseBackgroundJobsDuringGeneration: true }) });
        globalThis.fetch = vi.fn(async () => okResponse('now'));
        beginUserGeneration();
        await expect(fetchFromApi({ systemPrompt: 's', userContent: 'u', settings: SETTINGS, retries: 0, trigger: 'slash_command' })).resolves.toBe('now');
        endUserGeneration();
    });
});

describe('transport adoption — per-module serialization + chat-switch retirement', () => {
    test('the per-module limit serializes two parallel calls from the same module', async () => {
        const gates = [gate(), gate()];
        let call = 0;
        globalThis.fetch = vi.fn(() => {
            const idx = call;
            call += 1;
            return gates[idx].promise.then(() => okResponse('done'));
        });
        const p1 = fetchFromApi({ systemPrompt: 's', userContent: '1', settings: { ...SETTINGS, module: 'chronicle' }, retries: 0 });
        const p2 = fetchFromApi({ systemPrompt: 's', userContent: '2', settings: { ...SETTINGS, module: 'chronicle' }, retries: 0 });
        await settle();
        // Only ONE outbound call from the module at a time.
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        gates[0].resolve();
        await settle();
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        gates[1].resolve();
        await expect(p1).resolves.toBe('done');
        await expect(p2).resolves.toBe('done');
    });

    test('a chat switch retires a HELD auto call instead of ever sending it', async () => {
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ pauseBackgroundJobsDuringGeneration: true }) });
        globalThis.fetch = vi.fn(async () => okResponse('should-not-send'));
        beginUserGeneration();
        const pending = fetchFromApi({ systemPrompt: 's', userContent: 'u', settings: SETTINGS, retries: 0, trigger: 'auto' });
        await settle();
        bumpEpoch();
        onChatScopeChanged();
        await expect(pending).rejects.toMatchObject({ _mwtCancelled: true });
        expect(globalThis.fetch).not.toHaveBeenCalled();
        endUserGeneration();
    });
});

describe('transport adoption — Connection Manager cancellation is a discard barrier', () => {
    test('a held sendRequest that resolves after cancel never reaches the caller', async () => {
        // sendRequest has no signal parameter, so the wire call cannot be
        // stopped — but its eventual result must still be discarded. Before
        // the fix the job settled `ok` and the stale content resolved the
        // caller's promise even though the chat had already switched.
        const g = gate();
        vi.spyOn(ConnectionManagerRequestService, 'sendRequest')
            .mockImplementation(() => g.promise);
        const pending = fetchViaConnectionProfile({
            systemPrompt: 's',
            userContent: 'u',
            settings: { connectionProfileId: 'profile', maxTokens: 64, module: 'chronicle' },
            retries: 0,
        });
        await settle();
        expect(ConnectionManagerRequestService.sendRequest).toHaveBeenCalledTimes(1);
        // The chat switches while the unabortable wire call is in flight.
        bumpEpoch();
        onChatScopeChanged();
        g.resolve({ content: 'STALE RESULT', finish_reason: 'stop', usage: { total_tokens: 1 } });
        await expect(pending).rejects.toMatchObject({ _mwtCancelled: true });
        const snap = getCoordinatorSnapshot();
        expect(snap.running).toHaveLength(0);
        expect(snap.recentSettled.at(-1)).toMatchObject({ state: 'cancelled', module: 'chronicle' });
        // The Last-request summary must not read this as a success either:
        // the transport checks the signal BEFORE the success capture, so a
        // response that resolved after the abort is recorded as cancelled.
        // (Buckets matter: this job runs under module 'chronicle', so the
        // lookup must name it — the default 'api' bucket is always empty
        // here and the old not.toBe(true) assertion passed vacuously.)
        const cap = getLastApiCall('chronicle');
        expect(cap).toBeTruthy();
        expect(cap).toMatchObject({ ok: false, errorClass: 'cancelled' });
    });
});

describe('transport adoption — retryAsync honors aborts', () => {
    test('an aborted signal stops the backoff loop instead of burning another request', async () => {
        let calls = 0;
        const fn = vi.fn(async () => {
            calls += 1;
            throw new Error('transient');
        });
        const ac = new AbortController();
        const pending = retryAsync(3, fn, {
            onRetry: () => ac.abort(), // the signal aborts during the first backoff
            signal: ac.signal,
        });
        await expect(pending).rejects.toMatchObject({ _mwtCancelled: true });
        expect(calls).toBe(1); // no second wire attempt after the abort
    });

    test('a pre-aborted signal never calls fn at all', async () => {
        const ac = new AbortController();
        ac.abort();
        const fn = vi.fn(async () => 'unused');
        await expect(retryAsync(2, fn, { signal: ac.signal })).rejects.toMatchObject({ _mwtCancelled: true });
        expect(fn).not.toHaveBeenCalled();
    });

    test('an abort DURING the backoff delay rejects immediately — no timer wait, no held module slot', async () => {
        // Regression: the backoff used to be a plain setTimeout, so a
        // cancellation just after a failed attempt held the coordinator slot
        // until the whole 1/2/4/8s delay elapsed — fresh work for the same
        // module stayed queued behind a job that was already dead.
        vi.useFakeTimers();
        try {
            _setCoordinatorResolvers({ getGlobalSettings: () => ({ apiMaxConcurrent: 2 }) });
            const ac = new AbortController();
            globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }));
            const pending = fetchFromApi({
                systemPrompt: 's', userContent: 'u',
                settings: { ...SETTINGS, module: 'chronicle' },
                retries: 2,
                signal: ac.signal,
            });
            await vi.advanceTimersByTimeAsync(1); // attempt 1 fails → enters the 1s backoff
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
            // A fresh call for the same module queues behind the backoff-held job.
            globalThis.fetch.mockImplementation(async () => okResponse('fresh'));
            const followUp = fetchFromApi({
                systemPrompt: 's', userContent: 'next',
                settings: { ...SETTINGS, module: 'chronicle' },
                retries: 0,
            });
            await vi.advanceTimersByTimeAsync(1);
            expect(globalThis.fetch).toHaveBeenCalledTimes(1); // still serialized
            expect(getCoordinatorSnapshot().running).toHaveLength(1); // the dying job
            ac.abort(); // cancellation lands mid-backoff
            // (assertion attached before the abort so the rejection is never
            // momentarily unhandled while the timers flush)
            const cancelled = expect(pending).rejects.toMatchObject({ _mwtCancelled: true });
            await vi.advanceTimersByTimeAsync(0);
            await cancelled;
            // The backoff timer was cleared — the slot freed without waiting
            // the delay out, so the queued job starts immediately.
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(1);
            expect(globalThis.fetch).toHaveBeenCalledTimes(2);
            await expect(followUp).resolves.toBe('fresh');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('isCancellation — the shared quiet-discard contract', () => {
    test('recognizes the coordinator marker, native AbortError shapes, and rejects non-errors', () => {
        const marked = new Error('x');
        marked._mwtCancelled = true;
        expect(isCancellation(marked)).toBe(true);
        const native = new Error('aborted');
        native.name = 'AbortError';
        expect(isCancellation(native)).toBe(true);
        const domish = { code: 'ABORT_ERR' };
        expect(isCancellation(domish)).toBe(true);
        expect(isCancellation(new Error('plain'))).toBe(false);
        expect(isCancellation(null)).toBe(false);
        expect(isCancellation('AbortError')).toBe(false);
    });
});

// ─── 7. User-generation depth model ──────────────────────────────────────────

describe('user-generation depth — one canonical terminal per generation', () => {
    // index.js increments on GENERATION_STARTED and decrements on ONE
    // canonical terminal event (GENERATION_ENDED when event_types exposes
    // it, else GENERATION_STOPPED) instead of registering both terminals
    // behind a time-window deduper. A single event cannot double-count by
    // construction, so the deduper's failure modes (early release when a
    // slow proxy separates the STOPPED/ENDED pair past the window; permanent
    // wedge when two concurrent generations' terminals interleave with no
    // START between) cannot occur. These tests pin the coordinator-side
    // model that wiring relies on.

    test('nested windows hold background jobs until the LAST generation ends', async () => {
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ pauseBackgroundJobsDuringGeneration: true }) });
        beginUserGeneration(); // START A
        beginUserGeneration(); // START B (group-queue burst)
        const held = submitJob({ module: 'world_state', background: true, run: async () => 'bg' });
        expect(held.state).toBe('queued'); // both windows open
        endUserGeneration(); // A's canonical terminal
        expect(held.state).toBe('queued'); // B is STILL generating
        endUserGeneration(); // B's canonical terminal
        expect(held.state).toBe('running');
        await expect(held.promise).resolves.toBe('bg');
    });

    test('interleaved terminals of two concurrent generations each decrement once', () => {
        // The sequence the time-window deduper permanently wedged on: two
        // terminals close together with no START between them are DIFFERENT
        // generations ending (a quiet generation from another extension
        // finishing near the main stream's terminal), not a duplicate
        // re-fire. With one canonical terminal per generation both must
        // count — the depth reaches 0 exactly, no residual oscillation.
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ pauseBackgroundJobsDuringGeneration: true }) });
        beginUserGeneration(); // START A (the user's stream)
        beginUserGeneration(); // START B (quiet generation, another extension)
        expect(getCoordinatorSnapshot().userGeneration.depth).toBe(2);
        endUserGeneration(); // B ends first
        endUserGeneration(); // A ends moments later — NOT a duplicate
        expect(getCoordinatorSnapshot().userGeneration.depth).toBe(0);
    });

    test('a chat switch hard-resets the depth — a leaked window cannot hold jobs forever', async () => {
        // A fork can abort a generation on chat switch without ever firing
        // the terminal pair; the depth would stay elevated with nothing left
        // to unwind it. onChatScopeChanged() treats the switch as the
        // lifecycle boundary it is (recorded as a coordinator event).
        _setCoordinatorResolvers({ getGlobalSettings: () => ({ pauseBackgroundJobsDuringGeneration: true }) });
        beginUserGeneration();
        beginUserGeneration(); // leaked: no terminal will ever fire for these
        bumpEpoch();
        onChatScopeChanged();
        expect(getCoordinatorSnapshot().userGeneration.depth).toBe(0);
        expect(getEvents({ module: 'coordinator' }).some(e => e.event === 'user_generation_depth_reset')).toBe(true);
        // A fresh background job at the NEW epoch is no longer held by the
        // outgoing chat's leaked windows.
        const fresh = submitJob({ module: 'world_state', background: true, run: async () => 'bg' });
        expect(fresh.state).toBe('running');
        await expect(fresh.promise).resolves.toBe('bg');
    });
});
