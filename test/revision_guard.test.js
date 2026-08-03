/**
 * test/revision_guard.test.js — Tier 0.3: document revision guards.
 *
 * Two strategies:
 * 1. Snapshot/digest: capture an immutable value's hash; compare later.
 * 2. Revision clock: monotonic counter bumped on every mutation.
 *
 * The core invariant: if the document changed between capture and commit,
 * the guard must detect it.
 */

import { describe, test, expect } from 'vitest';

import {
    defaultNormalize,
    captureRevision,
    sameRevision,
    createRevisionClock,
    decideCommit,
} from '../core/revision.js';

// ─── defaultNormalize ────────────────────────────────────────────────────────

describe('defaultNormalize', () => {
    test('produces the same output regardless of key insertion order', () => {
        const a = defaultNormalize({ a: 1, b: 2 });
        const b = defaultNormalize({ b: 2, a: 1 });
        expect(a).toBe(b);
    });

    test('normalizes null and undefined to the same value', () => {
        expect(defaultNormalize(null)).toBe(defaultNormalize(undefined));
    });

    test('handles nested objects with different key order', () => {
        const a = defaultNormalize({ outer: { x: 1, y: 2 } });
        const b = defaultNormalize({ outer: { y: 2, x: 1 } });
        expect(a).toBe(b);
    });

    test('handles arrays (order matters)', () => {
        expect(defaultNormalize([1, 2])).not.toBe(defaultNormalize([2, 1]));
    });
});

// ─── captureRevision / sameRevision (snapshot strategy) ──────────────────────

describe('captureRevision and sameRevision (snapshot strategy)', () => {
    test('returns true when the value is unchanged', () => {
        const data = { arcs: [{ title: 'A', beats: ['b1', 'b2'] }] };
        const token = captureRevision(data);
        // Same data (deep equal)
        const same = { arcs: [{ title: 'A', beats: ['b1', 'b2'] }] };
        expect(sameRevision(token, same)).toBe(true);
    });

    test('returns false when a field was edited', () => {
        const data = { arcs: [{ title: 'A' }] };
        const token = captureRevision(data);
        const edited = { arcs: [{ title: 'B' }] }; // user edited during call
        expect(sameRevision(token, edited)).toBe(false);
    });

    test('returns false when a new arc was added during the call', () => {
        const data = { arcs: [{ title: 'A' }] };
        const token = captureRevision(data);
        const added = { arcs: [{ title: 'A' }, { title: 'NEW' }] };
        expect(sameRevision(token, added)).toBe(false);
    });

    test('returns false when an arc was deleted during the call', () => {
        const data = { arcs: [{ title: 'A' }, { title: 'B' }] };
        const token = captureRevision(data);
        const deleted = { arcs: [{ title: 'A' }] };
        expect(sameRevision(token, deleted)).toBe(false);
    });

    test('handles string values (world-state text)', () => {
        const text = '## Current Situation\nThe heroes are in the tavern.';
        const token = captureRevision(text);
        expect(sameRevision(token, text)).toBe(true);
        expect(sameRevision(token, text + '\nNew line')).toBe(false);
    });

    test('sameRevision returns false for a null token', () => {
        expect(sameRevision(null, { a: 1 })).toBe(false);
    });

    test('respects a custom normalizer', () => {
        // Custom normalizer that ignores a timestamp field.
        const normalize = (v) => JSON.stringify({ text: v.text });
        const data1 = { text: 'hello', ts: 1000 };
        const data2 = { text: 'hello', ts: 2000 };
        const token = captureRevision(data1, normalize);
        // Despite different ts, the normalized form is the same.
        expect(sameRevision(token, data2, normalize)).toBe(true);
    });
});

// ─── createRevisionClock ─────────────────────────────────────────────────────

describe('createRevisionClock', () => {
    test('starts at the given initial value', () => {
        const clock = createRevisionClock(5);
        expect(clock.get()).toBe(5);
    });

    test('bump advances the counter', () => {
        const clock = createRevisionClock();
        expect(clock.bump()).toBe(1);
        expect(clock.bump()).toBe(2);
    });

    test('capture and sameAt detect no change', () => {
        const clock = createRevisionClock();
        const token = clock.capture();
        expect(clock.sameAt(token)).toBe(true);
    });

    test('capture and sameAt detect a mutation', () => {
        const clock = createRevisionClock();
        const token = clock.capture();
        clock.bump(); // simulate user edit
        expect(clock.sameAt(token)).toBe(false);
    });

    test('sameAt returns false for a null token', () => {
        const clock = createRevisionClock();
        expect(clock.sameAt(null)).toBe(false);
    });
});

// ─── decideCommit ────────────────────────────────────────────────────────────

describe('decideCommit', () => {
    test('returns commit when unchanged', () => {
        expect(decideCommit(true).action).toBe('commit');
    });

    test('returns discard when changed and rebase not available', () => {
        expect(decideCommit(false).action).toBe('discard');
    });

    test('returns rebase when changed and rebase is available', () => {
        expect(decideCommit(false, true).action).toBe('rebase');
    });

    test('returns commit when unchanged even if rebase is available', () => {
        expect(decideCommit(true, true).action).toBe('commit');
    });
});

// ─── Integration: the same-chat edit race ────────────────────────────────────

describe('integration: same-chat edit race', () => {
    test('detects that the user edited the plan while generation was in flight', () => {
        // Simulate the STORY-PLANNER-02 scenario:
        // 1. Module captures the plan before the API call.
        // 2. User edits (pins/deletes) while the call is in flight.
        // 3. After the API returns, the module checks: is the plan still the same?
        const beforeCall = { arcs: [{ title: 'A', pinned: false }] };
        const token = captureRevision(beforeCall);

        // User pins the arc during the call.
        const afterUserEdit = { arcs: [{ title: 'A', pinned: true }] };

        // After API returns: the revision changed.
        const unchanged = sameRevision(token, afterUserEdit);
        expect(unchanged).toBe(false);

        // The module decides to discard the stale result, not overwrite the
        // user's edit.
        const decision = decideCommit(unchanged, false);
        expect(decision.action).toBe('discard');
    });

    test('detects that the world state text was edited during a section regen', () => {
        // WORLD-STATE-02 scenario: section regen overwrites unrelated edits.
        const beforeCall = '## Section A\nOld content';
        const token = captureRevision(beforeCall);

        // User edits a DIFFERENT section during the call.
        const afterUserEdit = '## Section A\nOld content\n## Section B\nNew edit';

        expect(sameRevision(token, afterUserEdit)).toBe(false);
    });
});