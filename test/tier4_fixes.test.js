/**
 * test/tier4_fixes.test.js — Tests for the Tier 4 bug fixes.
 *
 * Covers the pure-function / data-path regressions for the low-severity batch
 * tracked in Audit_Reports/REMEDIATION_MAP.md (lines 558–560):
 *
 * - CORE-06: retryAsync invalid-input and non-Error rejection edges
 * - CHRONICLE-06: range injection open-ended semantics + reversed-range normalisation
 * - CHRONICLE-07: triggerImport catches picker/read rejections instead of an
 *   unhandled promise rejection with no status
 * - STORY-PLANNER-08: nudge marks cleared on removeArc / status transitions;
 *   reactivation resets beat-age
 * - STORY-PLANNER-09: duplicate arc ids are de-duplicated so every arc stays
 *   independently removable
 *
 * (CORE-07 is intentionally omitted — upstream source validation found no
 * production change to cover; Aikobots is out of scope.)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// CORE-06
import { retryAsync } from '../core/api.js';

// CHRONICLE-06
import { getEntriesForInjection } from '../chronicle/injection.js';

// CHRONICLE-07
import { triggerImport } from '../chronicle/import-export.js';
import { state as chronicleState } from '../chronicle/data.js';

// STORY-PLANNER-08 / -09
import {
    makeArc, sanitizeArcs, setArcs, getArcs,
    removeArc, setArcStatus, takeDueNudges, getNudgeTurns,
} from '../story_planner/data.js';

// Fake-SillyTavern stubs
import { resetCoreStubs, getFakeMeta, setPickTextFileStub } from './stubs/core.js';

beforeEach(() => resetCoreStubs());

// ─── CORE-06: retryAsync edge cases ──────────────────────────────────────────

describe('CORE-06: retryAsync invalid-input and non-Error rejection edges', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test('a negative or non-finite attempts value makes one attempt and rejects with the original error', async () => {
        // The old code ran zero loop iterations and threw `undefined`.
        for (const bad of [-1, NaN, Infinity, 'abc']) {
            const real = new Error(`boom-${bad}`);
            const fn = vi.fn().mockRejectedValue(real);
            await expect(retryAsync(bad, fn)).rejects.toBe(real);
            expect(fn).toHaveBeenCalledTimes(1);
        }
    });

    test('a non-object rejection does not mask the original error with a TypeError', async () => {
        // The old `if (err._noRetry)` threw a TypeError when err was a string/null.
        await expect(retryAsync(0, async () => { throw 'string failure'; }))
            .rejects.toBe('string failure');
        await expect(retryAsync(0, async () => { throw null; }))
            .rejects.toBeNull();
    });

    test('an object rejection carrying _noRetry is thrown immediately with no retry', async () => {
        const onRetry = vi.fn();
        const fn = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { _noRetry: true }));
        await expect(retryAsync(3, fn, { onRetry })).rejects.toThrow('nope');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(onRetry).not.toHaveBeenCalled();
    });

    test('a finite non-negative attempts value still retries on a plain Error', async () => {
        let i = 0;
        const fn = async (attempt) => {
            if (i++ === 0) throw new Error('transient');
            return attempt;
        };
        const onRetry = vi.fn();
        const p = retryAsync(2, fn, { onRetry });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBe(1);
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});

// ─── CHRONICLE-06: range injection semantics ─────────────────────────────────

describe('CHRONICLE-06: range injection open-ended semantics', () => {
    /** Seed three snapshots (Jan/Mar/Jun 2024) in range mode with given bounds. */
    function seedRange({ injectFromDate = '', injectToDate = '' } = {}) {
        const snapshots = [
            { id: 's1', text: 'Jan', createdAt: '2024-01-01T00:00:00.000Z' },
            { id: 's2', text: 'Mar', createdAt: '2024-03-01T00:00:00.000Z' },
            { id: 's3', text: 'Jun', createdAt: '2024-06-01T00:00:00.000Z' },
        ];
        getFakeMeta().session_chronicle_data = {
            snapshots, injectMode: 'range', injectFromDate, injectToDate,
        };
        return snapshots;
    }
    const ids = () => getEntriesForInjection().map(s => s.id);

    test('from-only returns everything after the bound (not empty)', () => {
        seedRange({ injectFromDate: '2024-02-01' });
        expect(ids()).toEqual(['s2', 's3']);
    });

    test('to-only returns everything before the bound (not empty)', () => {
        seedRange({ injectToDate: '2024-04-01' });
        expect(ids()).toEqual(['s1', 's2']);
    });

    test('both bounds return the entries between them', () => {
        seedRange({ injectFromDate: '2024-02-01', injectToDate: '2024-04-01' });
        expect(ids()).toEqual(['s2']);
    });

    test('a reversed range is normalised instead of injecting nothing', () => {
        seedRange({ injectFromDate: '2024-04-01', injectToDate: '2024-02-01' });
        expect(ids()).toEqual(['s2']);
    });

    test('neither bound is unbounded (all entries)', () => {
        seedRange({});
        expect(ids()).toEqual(['s1', 's2', 's3']);
    });

    test('bounds are inclusive of the boundary dates', () => {
        seedRange({ injectFromDate: '2024-03-01', injectToDate: '2024-03-01' });
        expect(ids()).toEqual(['s2']);
    });
});

// ─── CHRONICLE-07: triggerImport error handling ──────────────────────────────

describe('CHRONICLE-07: triggerImport catches picker/read rejections', () => {
    beforeEach(() => {
        chronicleState._lastStatusMsg = '';
        chronicleState._lastStatusLevel = '';
    });

    test('a file-read rejection sets an error status and does not reject', async () => {
        setPickTextFileStub(() => { throw new Error('disk read failed'); });
        await expect(triggerImport()).resolves.toBeUndefined();
        expect(chronicleState._lastStatusMsg).toContain('Import failed');
        expect(chronicleState._lastStatusMsg).toContain('disk read failed');
        expect(chronicleState._lastStatusLevel).toBe('error');
    });

    test('an async rejection is caught the same way', async () => {
        setPickTextFileStub(async () => { throw new Error('async fail'); });
        await expect(triggerImport()).resolves.toBeUndefined();
        expect(chronicleState._lastStatusMsg).toContain('async fail');
        expect(chronicleState._lastStatusLevel).toBe('error');
    });

    test('a quiet cancellation (empty string) stays a no-op with no error status', async () => {
        setPickTextFileStub(() => '');
        await expect(triggerImport()).resolves.toBeUndefined();
        expect(chronicleState._lastStatusLevel).not.toBe('error');
    });
});

// ─── STORY-PLANNER-08: nudge marks cleared on arc transitions ────────────────

describe('STORY-PLANNER-08: nudge marks cleared on arc removal/status transitions', () => {
    /** Seed one active arc aged to the nudge threshold and record its mark. */
    function seedAwaiting() {
        const threshold = getNudgeTurns();
        const arc = { ...makeArc({ title: 'Slow Burn', beats: ['one', 'two'] }), turnsSinceAdvance: threshold };
        setArcs([arc]);
        takeDueNudges(); // records the `${arc.id}#0` mark
        return arc;
    }

    test('removeArc clears the arc nudge mark immediately', () => {
        const arc = seedAwaiting();
        expect(Object.keys(getFakeMeta().story_planner_data.nudgeMarks)).toEqual([`${arc.id}#0`]);

        expect(removeArc(arc.id)).toBe(true);
        expect(getFakeMeta().story_planner_data.nudgeMarks).toEqual({});
    });

    test('setArcStatus resolve clears marks immediately', () => {
        const arc = seedAwaiting();
        expect(Object.keys(getFakeMeta().story_planner_data.nudgeMarks).length).toBe(1);

        setArcStatus(arc.id, 'resolved');
        expect(getFakeMeta().story_planner_data.nudgeMarks).toEqual({});
    });

    test('reactivating an arc resets beat-age and does not inherit stale marks', () => {
        const arc = seedAwaiting();
        setArcStatus(arc.id, 'resolved');
        expect(getFakeMeta().story_planner_data.nudgeMarks).toEqual({});

        setArcStatus(arc.id, 'active');
        const after = getArcs().find(a => a.id === arc.id);
        expect(after.status).toBe('active');
        // turnsSinceAdvance reset so the reopened arc counts from zero.
        expect(after.turnsSinceAdvance).toBe(0);
        expect(getFakeMeta().story_planner_data.nudgeMarks).toEqual({});
    });

    test('dropping an arc clears its marks immediately', () => {
        const arc = seedAwaiting();
        setArcStatus(arc.id, 'dropped');
        expect(getFakeMeta().story_planner_data.nudgeMarks).toEqual({});
    });
});

// ─── STORY-PLANNER-09: duplicate arc id de-duplication ───────────────────────

describe('STORY-PLANNER-09: duplicate arc ids are de-duplicated', () => {
    test('two arcs sharing an id get distinct ids so both stay independently removable', () => {
        const dupId = 'shared-id';
        const arcs = sanitizeArcs([
            { id: dupId, title: 'First', beats: ['a'] },
            { id: dupId, title: 'Second', beats: ['b'] },
        ]);
        expect(arcs).toHaveLength(2);
        expect(arcs[0].id).toBe(dupId);        // first occurrence kept
        expect(arcs[1].id).not.toBe(dupId);    // duplicate minted a fresh id

        // Both survive a setArcs round-trip and are independently removable.
        setArcs(arcs);
        expect(removeArc(arcs[0].id)).toBe(true);
        expect(getArcs().map(a => a.id)).toEqual([arcs[1].id]);
        expect(removeArc(arcs[1].id)).toBe(true);
        expect(getArcs()).toEqual([]);
    });

    test('a canonical array with unique ids passes through unchanged', () => {
        const a = makeArc({ title: 'A', beats: ['x'] });
        const b = makeArc({ title: 'B', beats: ['y'] });
        const out = sanitizeArcs([a, b]);
        expect(out.map(o => o.id)).toEqual([a.id, b.id]);
    });
});

