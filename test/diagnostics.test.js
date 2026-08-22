/**
 * test/diagnostics.test.js — Phase 0 tests for core/diagnostics.js.
 *
 * diagnostics.js is a pure in-memory module (no SillyTavern runtime), so these
 * tests drive it directly. The scope-key stamping uses an injected resolver
 * (_setScopeKeyResolver) so the chat-identity key is deterministic — the live
 * resolver mints a unique nonce per call when identity is unknown, which is
 * correct but non-deterministic.
 *
 * The notify() → record() wiring is tested against the REAL notifications.js
 * (not the stub), because that wiring only exists in the real module.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    record,
    getEvents,
    clearEvents,
    setRunStart,
    setRunResult,
    getLastRun,
    getAllLastRuns,
    clearLastRuns,
    RING_CAPACITY,
    _resetDiagnostics,
    _setScopeKeyResolver,
} from '../core/diagnostics.js';
// Real notifications.js (not the stub): the record() wiring lives there.
import { notify } from '../core/notifications.js';
import { getEpoch, bumpEpoch, _resetEpoch } from '../core/scope.js';

beforeEach(() => {
    _resetDiagnostics();
    _resetEpoch();
});

// ─── record + getEvents basics ───────────────────────────────────────────────

describe('record + getEvents', () => {
    test('records an event with ts and returns it newest-first', () => {
        record({ level: 'info', module: 'api', event: 'start', detail: { a: 1 } });
        const evts = getEvents();
        expect(evts).toHaveLength(1);
        expect(evts[0].level).toBe('info');
        expect(evts[0].module).toBe('api');
        expect(evts[0].event).toBe('start');
        expect(evts[0].detail).toEqual({ a: 1 });
        expect(typeof evts[0].ts).toBe('number');
    });

    test('getEvents returns newest first', () => {
        record({ level: 'info', module: 'm', event: 'first' });
        record({ level: 'info', module: 'm', event: 'second' });
        record({ level: 'info', module: 'm', event: 'third' });
        expect(getEvents().map(e => e.event)).toEqual(['third', 'second', 'first']);
    });

    test('an invalid level is normalized to info', () => {
        record({ level: 'panic', module: 'm', event: 'e' });
        expect(getEvents()[0].level).toBe('info');
    });

    test('record never throws on bad input, including explicit null (always-on contract)', () => {
        expect(() => record()).not.toThrow();
        expect(() => record(null)).not.toThrow();   // explicit null must not throw
        expect(() => record({})).not.toThrow();
        expect(() => record({ level: 'info' })).not.toThrow();
        // detail may be anything, including a function or undefined.
        expect(() => record({ level: 'info', detail: () => {} })).not.toThrow();
    });

    test('every event is stamped with a strictly increasing seq', () => {
        record({ level: 'info', module: 'm', event: 'one' });
        record({ level: 'info', module: 'm', event: 'two' });
        // Newest first: [two, one].
        expect(getEvents()[1].seq).toBe(1);
        expect(getEvents()[0].seq).toBe(2);
    });
});

// ─── Sequence numbers (Phase 11: collision-safe row fingerprints) ────────────

describe('event seq — the per-event-unique stamp', () => {
    // ts has millisecond resolution, so ts|epoch|module|event is NOT unique —
    // the Phase 11 log tab's row→detail fingerprint needs the monotonic seq
    // to pick the right detail for same-millisecond repeats. Pinned here at
    // the store level; the tab-level behaviour is pinned in log_tab.test.js.
    test('seq distinguishes events stamped in the same millisecond', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        try {
            record({ level: 'warn', module: 'api', event: 'burst', detail: 1 });
            record({ level: 'warn', module: 'api', event: 'burst', detail: 2 });
        } finally {
            vi.restoreAllMocks();
        }
        const [second, first] = getEvents();
        // Same millisecond by construction — every field except seq matches…
        expect(first.ts).toBe(second.ts);
        expect(first.epoch).toBe(second.epoch);
        expect(first.module).toBe(second.module);
        expect(first.event).toBe(second.event);
        // …so seq is the only thing telling them apart.
        expect(first.seq).not.toBe(second.seq);
    });

    test('seq survives eviction bookkeeping — retained events keep their stamps', () => {
        record({ level: 'debug', module: 'm', event: 'a' });
        record({ level: 'debug', module: 'm', event: 'b' });
        record({ level: 'debug', module: 'm', event: 'c' });
        expect(getEvents().map((e) => e.seq)).toEqual([3, 2, 1]);
    });
});


    test('record never throws when passed null', () => {
        expect(() => record(null)).not.toThrow();
});


// ─── Ring eviction ───────────────────────────────────────────────────────────

describe('ring capacity', () => {
    test('evicts the oldest entries once capacity is exceeded', () => {
        // Fill exactly to capacity.
        for (let i = 0; i < RING_CAPACITY; i++) {
            record({ level: 'debug', module: 'm', event: `e${i}` });
        }
        expect(getEvents()).toHaveLength(RING_CAPACITY);
        // Oldest retained is the first inserted (newest-first → last index).
        expect(getEvents()[RING_CAPACITY - 1].event).toBe('e0');

        // Overflow by three → the three oldest are evicted.
        record({ level: 'debug', module: 'm', event: 'e_new1' });
        record({ level: 'debug', module: 'm', event: 'e_new2' });
        record({ level: 'debug', module: 'm', event: 'e_new3' });

        const evts = getEvents();
        expect(evts).toHaveLength(RING_CAPACITY);
        // e0, e1, e2 evicted; oldest retained is now e3.
        expect(evts[evts.length - 1].event).toBe('e3');
        // Newest is the last recorded.
        expect(evts[0].event).toBe('e_new3');
    });
});

// ─── Filtering ───────────────────────────────────────────────────────────────

describe('getEvents filtering by level and module', () => {
    beforeEach(() => {
        record({ level: 'debug', module: 'a', event: 'a1' });
        record({ level: 'warn', module: 'a', event: 'a2' });
        record({ level: 'error', module: 'b', event: 'b1' });
        record({ level: 'info', module: 'b', event: 'b2' });
    });

    test('filters by a single level', () => {
        const warns = getEvents({ level: 'warn' });
        expect(warns).toHaveLength(1);
        expect(warns[0].event).toBe('a2');
    });

    test('filters by a list of levels', () => {
        const faults = getEvents({ level: ['warn', 'error'] });
        expect(faults.map(e => e.event).sort()).toEqual(['a2', 'b1']);
    });

    test('filters by module', () => {
        const aEvents = getEvents({ module: 'a' });
        expect(aEvents).toHaveLength(2);
        expect(aEvents.every(e => e.module === 'a')).toBe(true);
    });

    test('level and module compose', () => {
        const out = getEvents({ level: 'error', module: 'b' });
        expect(out).toHaveLength(1);
        expect(out[0].event).toBe('b1');
    });
});

describe('getEvents since filter', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test('since is an inclusive lower bound on ts', () => {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        record({ level: 'info', module: 'x', event: 'first' });   // t0
        vi.advanceTimersByTime(1000);
        record({ level: 'info', module: 'x', event: 'second' });  // t0 + 1000
        vi.advanceTimersByTime(1000);
        record({ level: 'info', module: 'x', event: 'third' });   // t0 + 2000

        // Use second's actual ts as the inclusive cutoff (the base ms is huge,
        // so an absolute small number would match everything). third and second
        // qualify; first (earlier) is excluded.
        const secondTs = getEvents()[1].ts;
        const filtered = getEvents({ since: secondTs });
        expect(filtered.map(e => e.event)).toEqual(['third', 'second']);
    });
});

// ─── clearEvents ─────────────────────────────────────────────────────────────

describe('clearEvents', () => {
    test('clears the ring without affecting last-runs', () => {
        record({ level: 'info', module: 'm', event: 'e' });
        setRunStart('m', 'manual');
        clearEvents();
        expect(getEvents()).toEqual([]);
        expect(getLastRun('m')).toBeDefined();
    });
});

// ─── Scope-key stamping ──────────────────────────────────────────────────────

describe('scope-key stamping', () => {
    test('every event is stamped with the resolved chat-identity key', () => {
        _setScopeKeyResolver(() => 'chat:abc');
        record({ level: 'info', module: 'm', event: 'e' });
        expect(getEvents()[0].scopeKey).toBe('chat:abc');
    });

    test('the key reflects the chat active when the event fired (global across switches)', () => {
        _setScopeKeyResolver(() => 'chat:one');
        record({ level: 'info', module: 'm', event: 'in-chat-one' });
        _setScopeKeyResolver(() => 'chat:two');
        record({ level: 'info', module: 'm', event: 'in-chat-two' });

        const evts = getEvents();
        expect(evts[0].scopeKey).toBe('chat:two');   // newest
        expect(evts[1].scopeKey).toBe('chat:one');   // older
    });

    test('a null key (identity unknown) is stamped, not swallowed', () => {
        _setScopeKeyResolver(() => null);
        record({ level: 'info', module: 'm', event: 'e' });
        expect(getEvents()[0].scopeKey).toBeNull();
    });

    test('the default resolver reads core/scope.js and never throws (unknown identity under Node)', () => {
        // After _resetDiagnostics() the default resolver is restored. With no
        // SillyTavern in Node, getChatIdentity returns an unknown identity —
        // its key is a non-empty string like 'unknown:N'.
        record({ level: 'info', module: 'm', event: 'e' });
        const key = getEvents()[0].scopeKey;
        expect(typeof key).toBe('string');
        expect(key.startsWith('unknown:')).toBe(true);
    });
});

// ─── Epoch stamping ──────────────────────────────────────────────────────────
//
// The epoch is the stable cross-chat correlation dimension. On unknown-identity
// builds the scopeKey differs per call, but the epoch groups events within one
// chat and flips across a switch (bumpEpoch). This is the co-author's point:
// without it, the scope key alone cannot correlate events on forks with no
// usable chat id.

describe('epoch stamping', () => {
    test('every event is stamped with the current epoch', () => {
        record({ level: 'info', module: 'm', event: 'e' });
        expect(getEvents()[0].epoch).toBe(getEpoch());
    });

    test('epoch is stable across multiple events in the same epoch', () => {
        // On unknown-identity builds the scopeKey would differ per call, but the
        // epoch gives a reliable grouping that works everywhere.
        record({ level: 'info', module: 'm', event: 'one' });
        record({ level: 'info', module: 'm', event: 'two' });
        const evts = getEvents();
        expect(evts[0].epoch).toBe(evts[1].epoch);
    });

    test('epoch advances across a bump (cross-chat-switch correlation)', () => {
        record({ level: 'info', module: 'm', event: 'before' });
        const beforeEpoch = getEvents()[0].epoch;
        bumpEpoch(); // simulates the root onChatChanged handler
        record({ level: 'info', module: 'm', event: 'after' });
        const after = getEvents()[0];
        expect(after.epoch).toBe(beforeEpoch + 1);
    });
});

// ─── Last-run map ────────────────────────────────────────────────────────────

describe('last-run map', () => {
    test('setRunStart records startedAt and trigger with null result fields', () => {
        setRunStart('world_state', 'manual');
        const run = getLastRun('world_state');
        expect(run).toBeDefined();
        expect(typeof run.startedAt).toBe('number');
        expect(run.trigger).toBe('manual');
        expect(run.finishedAt).toBeNull();
        expect(run.ok).toBeNull();
        expect(run.error).toBeNull();
        expect(run.tokensIn).toBeNull();
        expect(run.tokensOut).toBeNull();
    });

    test('setRunResult fills the outcome and preserves startedAt/trigger', () => {
        setRunStart('chronicle', 'auto');
        const startedAt = getLastRun('chronicle').startedAt;
        setRunResult('chronicle', { ok: true, tokensIn: 1200, tokensOut: 800 });
        const run = getLastRun('chronicle');
        expect(run.startedAt).toBe(startedAt);
        expect(run.trigger).toBe('auto');
        expect(run.ok).toBe(true);
        expect(run.error).toBeNull();
        expect(run.tokensIn).toBe(1200);
        expect(run.tokensOut).toBe(800);
        expect(typeof run.finishedAt).toBe('number');
        expect(run.finishedAt).toBeGreaterThanOrEqual(startedAt);
    });

    test('setRunResult records a failure with an error string', () => {
        setRunStart('knowledge', 'auto');
        setRunResult('knowledge', { ok: false, error: 'HTTP 503' });
        const run = getLastRun('knowledge');
        expect(run.ok).toBe(false);
        expect(run.error).toBe('HTTP 503');
    });

    test('setRunResult without a prior setRunStart defaults startedAt to now', () => {
        setRunResult('story_planner', { ok: true });
        const run = getLastRun('story_planner');
        expect(typeof run.startedAt).toBe('number');
        expect(run.trigger).toBeNull();
        expect(run.ok).toBe(true);
    });

    test('setRunStart resets a stale result from a previous run', () => {
        setRunStart('interiority', 'auto');
        setRunResult('interiority', { ok: true });
        expect(getLastRun('interiority').ok).toBe(true);
        // Start a new run — the prior 'ok' must not linger.
        setRunStart('interiority', 'manual');
        const run = getLastRun('interiority');
        expect(run.ok).toBeNull();
        expect(run.finishedAt).toBeNull();
        expect(run.trigger).toBe('manual');
    });

    test('getLastRun returns undefined for an unknown module', () => {
        expect(getLastRun('nope')).toBeUndefined();
    });

    test('getLastRun returns a copy that cannot mutate internal state', () => {
        setRunStart('a', 'manual');
        getLastRun('a').ok = true;            // mutate the returned copy
        expect(getLastRun('a').ok).toBeNull(); // internal state untouched
    });

    test('getAllLastRuns returns a per-module copy of all modules', () => {
        setRunStart('a', 'manual');
        setRunStart('b', 'auto');
        const all = getAllLastRuns();
        expect(Object.keys(all).sort()).toEqual(['a', 'b']);
        // Mutating a copied run must not affect internal state.
        all.a.ok = true;
        expect(getLastRun('a').ok).toBeNull();
    });

    test('clearLastRuns wipes the map without touching events', () => {
        setRunStart('a', 'manual');
        record({ level: 'info', module: 'm', event: 'e' });
        clearLastRuns();
        expect(getLastRun('a')).toBeUndefined();
        expect(getAllLastRuns()).toEqual({});
        expect(getEvents()).toHaveLength(1);
    });
});

// ─── notify() → record() wiring ──────────────────────────────────────────────

describe('notify() wiring', () => {
    test('every toast is captured into the diagnostics ring', () => {
        notify('Refresh failed', 'Connection error', 'error');
        const evts = getEvents({ module: 'notify' });
        expect(evts).toHaveLength(1);
        expect(evts[0].level).toBe('error');
        expect(evts[0].event).toBe('Refresh failed');
        expect(evts[0].detail).toEqual({ title: 'Refresh failed', message: 'Connection error' });
    });

    test('a success toast is captured at info level', () => {
        notify('Saved', 'All good', 'success');
        const evts = getEvents({ module: 'notify' });
        expect(evts).toHaveLength(1);
        expect(evts[0].level).toBe('info');
    });

    test('toastr is still invoked with the same arguments (behavior identical)', () => {
        const calls = [];
        globalThis.toastr = { info: (m, t) => calls.push({ type: 'info', m, t }) };
        try {
            notify('Title', 'Body', 'info');
            expect(calls).toEqual([{ type: 'info', m: 'Body', t: 'Title' }]);
        } finally {
            delete globalThis.toastr;
        }
    });
});
