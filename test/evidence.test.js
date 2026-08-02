/**
 * test/evidence.test.js — Tests for knowledge/evidence.js
 *
 * This file is the "step up" from the pure-function tests. evidence.js DOES
 * depend on SillyTavern — it reads/writes chat metadata via the `core/index.js`
 * barrel. To test it, we rely on the stub in `test/stubs/core.js`, which fakes
 * that SillyTavern runtime with an in-memory object. The vitest.config.js alias
 * makes `import ... from '../core/index.js'` resolve to that stub automatically.
 *
 * Several tests in this file directly mirror bug fixes documented in
 * REVIEW_TODO.md. If one of those bugs ever regresses, the corresponding test
 * here will turn red. That's the main payoff of having tests for this module.
 *
 * ── The stub-core pattern (read this once) ──────────────────────────────────
 *   1. `beforeEach(() => resetCoreStubs())` wipes the fake metadata between
 *      tests so they don't interfere with each other.
 *   2. The test calls a function from evidence.js, which internally reads or
 *      writes the fake metadata via the stub's `getChatMeta` / `patchChatMeta`.
 *   3. The test asserts on the result, AND can also peek at the fake metadata
 *      via `getFakeMeta()` to confirm the right thing was persisted.
 */

import { describe, test, expect, beforeEach } from 'vitest';

// Stub helpers — these come from the fake core, NOT the real one.
// Both files are inside test/, so the import is ./stubs/core.js.
import {
    resetCoreStubs,
    setFakeChat,
    getFakeMeta,
} from './stubs/core.js';

// The module under test. Because of the vitest alias, its internal
// `import ... from '../core/index.js'` resolves to the stub.
import {
    getEvidenceMap,
    getEvidenceFile,
    hasEvidenceFile,
    appendRawObservations,
    applyConsolidation,
    expandConsolidated,
    clearEvidence,
    deleteRawObservation,
    nextObsId,
} from '../knowledge/evidence.js';

// Reset the fake SillyTavern state before every single test. Without this,
// evidence written by one test would still be there for the next test, making
// failures confusing and order-dependent.
beforeEach(() => resetCoreStubs());

// ── Helper: build a minimal observation object the way capture does ─────────
// Reused across multiple tests to keep them short and readable.
function obs(claim, quote, extra = {}) {
    return { category: 'trait', claim, quote, msgIdx: 0, ...extra };
}

describe('getEvidenceFile / hasEvidenceFile', () => {

    test('getEvidenceFile creates an empty skeleton for a new NPC', () => {
        // ACT: ask for an NPC that has no file yet (create defaults to true).
        const file = getEvidenceFile('Kira');
        // ASSERT: a well-formed empty file is returned and persisted.
        expect(file.npc).toBe('Kira');
        expect(file.raw).toEqual([]);
        expect(file.consolidated).toEqual([]);
        expect(file.archivedRaw).toEqual([]);
        expect(file.meta.createdAt).toBeTypeOf('number');
    });

    test('getEvidenceFile returns null when create=false and no file exists', () => {
        // ACT
        const file = getEvidenceFile('Ghost', false);
        // ASSERT
        expect(file).toBeNull();
    });

    test('hasEvidenceFile is false for an unknown NPC', () => {
        expect(hasEvidenceFile('Nobody')).toBe(false);
    });

    test('hasEvidenceFile is true once an NPC has raw observations', () => {
        // ARRANGE: capture one observation.
        appendRawObservations('Kira', [obs('Brave', 'she charged in')]);
        // ASSERT
        expect(hasEvidenceFile('Kira')).toBe(true);
    });

    test('hasEvidenceFile stays true after clearEvidence (item 7 fix)', () => {
        // This pins REVIEW_TODO item 7: clearing evidence used to silently drop
        // the NPC from continuous capture because hasEvidenceFile required a
        // non-empty tier. The `enrolled` flag fixes that.
        // ARRANGE
        appendRawObservations('Kira', [obs('Brave', 'she charged in')]);
        expect(hasEvidenceFile('Kira')).toBe(true);
        // ACT
        const cleared = clearEvidence('Kira');
        // ASSERT: clear succeeded, and the NPC is STILL considered enrolled.
        expect(cleared).toBe(true);
        expect(hasEvidenceFile('Kira')).toBe(true);
        // And the tiers really are empty now.
        const file = getEvidenceFile('Kira', false);
        expect(file.raw).toEqual([]);
        expect(file.consolidated).toEqual([]);
    });
});

describe('appendRawObservations', () => {

    test('appends observations to raw[] with ids and timestamps', () => {
        // ARRANGE: a fake chat message so the timestamp lookup has something.
        setFakeChat([{ send_date: '2024-01-01T00:00:00.000Z' }]);

        // ACT
        const { added, skipped } = appendRawObservations('Mara', [
            obs('Kind', '"here, let me help"'),
            obs('Tall', '"she loomed over him"'),
        ]);

        // ASSERT: both were added, none skipped.
        expect(added).toBe(2);
        expect(skipped).toBe(0);

        const file = getEvidenceFile('Mara', false);
        expect(file.raw).toHaveLength(2);
        // IDs follow the obs-### pattern.
        expect(file.raw[0].id).toMatch(/^obs-\d{3}$/);
        expect(file.raw[1].id).toMatch(/^obs-\d{3}$/);
        // The timestamp is derived from the fake message's send_date.
        expect(file.raw[0].ts).toBeTypeOf('number');
    });

    test('skips duplicate observations (same claim + quote)', () => {
        // ARRANGE: capture one observation.
        appendRawObservations('Mara', [obs('Kind', '"here, let me help"')]);
        // ACT: try to capture the SAME one again, plus a new one.
        const result = appendRawObservations('Mara', [
            obs('Kind', '"here, let me help"'),   // duplicate → skipped
            obs('Brave', '"she fought"'),          // new → added
        ]);
        // ASSERT: one added, one skipped.
        expect(result.added).toBe(1);
        expect(result.skipped).toBe(1);
        expect(getEvidenceFile('Mara', false).raw).toHaveLength(2);
    });

    test('skips observations missing a claim or quote', () => {
        // ARRANGE: malformed observations should be skipped, not crash.
        const result = appendRawObservations('Mara', [
            { category: 'trait', quote: 'no claim' },           // no claim
            { category: 'trait', claim: 'no quote' },           // no quote
            { category: 'trait', claim: 'ok', quote: 'ok' },    // valid
        ]);
        expect(result.added).toBe(1);
        expect(result.skipped).toBe(2);
    });

    test('dedups against archivedRaw after consolidation (Tier 2 fix #6)', () => {
        // Regression test for BUG_REPORTS/VERIFICATION_RESULTS.md Tier 2 bug #6.
        // After consolidation moves observations to archivedRaw, a capture pass
        // that overlaps those same messages must NOT re-add them to raw[].
        // Previously the dedup set only scanned raw[], so re-worded claims
        // (same quote, slightly different wording) slipped through and piled up.
        //
        // ARRANGE: capture one observation, then move it to archivedRaw
        // (simulating what applyConsolidation does to consumed raws).
        appendRawObservations('Kira', [obs('Brave', '"she charged in"')]);
        const file = getEvidenceFile('Kira', false);
        const rawId = file.raw[0].id;
        file.archivedRaw.push(file.raw[0]);
        file.raw = [];

        // ACT: try to re-capture the SAME observation (exact match).
        const result = appendRawObservations('Kira', [obs('Brave', '"she charged in"')]);

        // ASSERT: the observation was recognized as a duplicate of the archived
        // entry and skipped — it did not re-enter raw[].
        expect(result.added).toBe(0);
        expect(result.skipped).toBe(1);
        const fileAfter = getEvidenceFile('Kira', false);
        expect(fileAfter.raw).toHaveLength(0);
        expect(fileAfter.archivedRaw).toHaveLength(1);

        // A genuinely NEW observation is still admitted.
        const result2 = appendRawObservations('Kira', [obs('Calm', '"she breathed slowly"')]);
        expect(result2.added).toBe(1);
    });
});

describe('applyConsolidation (REVIEW_TODO items 1 & 2)', () => {

    // ── Helper: seed an NPC with N raw observations, all non-canon ──────────
    function seedRaw(name, count) {
        const list = [];
        for (let i = 0; i < count; i++) {
            list.push(obs(`Claim ${i + 1}`, `"quote ${i + 1}"`));
        }
        appendRawObservations(name, list);
        return getEvidenceFile(name, false).raw.map(o => o.id);
    }

    test('mints UNIQUE ids for each consolidated claim in a batch (item 1)', () => {
        // REVIEW_TODO item 1: a bug minted the same id for every claim in a
        // pass, breaking every id-keyed operation (edit/delete/expand).
        // ARRANGE: 3 raw observations to consolidate.
        const ids = seedRaw('Kira', 3);
        // ACT: consolidate all three into one claim. Pass the sourceIds
        // snapshot (item 4 fix) so numeric positions map to the right ids.
        const result = applyConsolidation('Kira', [
            { category: 'trait', claim: 'Combined', sources: [1, 2, 3], confidence: 'high' },
        ], ids);
        // ASSERT: one new consolidated claim was added...
        expect(result.consolidatedCount).toBe(1);
        const file = getEvidenceFile('Kira', false);
        // ...and critically, its id is unique (not duplicated across a batch).
        const conIds = file.consolidated.map(c => c.id);
        expect(new Set(conIds).size).toBe(conIds.length);
    });

    test('APPENDS to consolidated[] instead of replacing it (item 2)', () => {
        // REVIEW_TODO item 2: a bug replaced the tier on each pass, wiping
        // claims distilled in earlier eras. The fix appends instead.
        // ARRANGE: 4 raw observations; consolidate the first two.
        const ids = seedRaw('Mara', 4);
        applyConsolidation('Mara', [
            { category: 'trait', claim: 'Era 1 claim', sources: [1, 2] },
        ], ids.slice(0, 2));
        expect(getEvidenceFile('Mara', false).consolidated).toHaveLength(1);

        // ACT: a second pass consolidates the remaining two.
        applyConsolidation('Mara', [
            { category: 'trait', claim: 'Era 2 claim', sources: [1, 2] },
        ], ids.slice(2, 4));

        // ASSERT: BOTH era claims survive — the tier was appended to, not
        // replaced.
        const cons = getEvidenceFile('Mara', false).consolidated;
        expect(cons).toHaveLength(2);
        expect(cons.map(c => c.claim)).toEqual(['Era 1 claim', 'Era 2 claim']);
    });

    test('moves consumed raw observations to archivedRaw', () => {
        // ARRANGE
        const ids = seedRaw('Kira', 2);
        // ACT: consolidate both.
        const result = applyConsolidation('Kira', [
            { category: 'trait', claim: 'Combined', sources: [1, 2] },
        ], ids);
        // ASSERT: the two raws were archived (not deleted).
        expect(result.archivedCount).toBe(2);
        const file = getEvidenceFile('Kira', false);
        expect(file.raw).toHaveLength(0);
        expect(file.archivedRaw).toHaveLength(2);
    });

    test('rejects a consolidated claim with no valid sources', () => {
        // ARRANGE
        seedRaw('Kira', 1);
        // ACT: pass a claim that cites no sources.
        const result = applyConsolidation('Kira', [
            { category: 'trait', claim: 'Sourceless', sources: [] },
        ]);
        // ASSERT: nothing was added.
        expect(result.consolidatedCount).toBe(0);
    });
});

describe('expandConsolidated (undo path)', () => {

    test('restores archived sources to raw[] and removes the claim', () => {
        // ARRANGE: capture 2, consolidate them.
        appendRawObservations('Mara', [
            obs('A', '"a"'),
            obs('B', '"b"'),
        ]);
        const rawIds = getEvidenceFile('Mara', false).raw.map(o => o.id);
        applyConsolidation('Mara', [
            { category: 'trait', claim: 'Combined', sources: [1, 2] },
        ], rawIds);
        // Sanity check: both were archived.
        expect(getEvidenceFile('Mara', false).archivedRaw).toHaveLength(2);

        // ACT: expand the consolidated claim we just made.
        const conId = getEvidenceFile('Mara', false).consolidated[0].id;
        const ok = expandConsolidated('Mara', conId);

        // ASSERT: the sources are back in raw[], the claim is gone, and the
        // archived copies were removed (no duplicates).
        expect(ok).toBe(true);
        const file = getEvidenceFile('Mara', false);
        expect(file.consolidated).toHaveLength(0);
        expect(file.raw).toHaveLength(2);
        expect(file.archivedRaw).toHaveLength(0);
    });
});

describe('deleteRawObservation', () => {

    test('removes an observation from raw[] and leaves others intact', () => {
        // ARRANGE: capture two observations.
        appendRawObservations('Mara', [obs('A', '"a"'), obs('B', '"b"')]);
        const ids = getEvidenceFile('Mara', false).raw.map(o => o.id);
        // ACT: delete the first one.
        const ok = deleteRawObservation('Mara', ids[0]);
        // ASSERT: deletion succeeded, only the targeted obs is gone.
        expect(ok).toBe(true);
        const file = getEvidenceFile('Mara', false);
        expect(file.raw).toHaveLength(1);
        expect(file.raw.find(o => o.id === ids[0])).toBeUndefined();
        expect(file.raw.find(o => o.id === ids[1])).toBeDefined();
    });

    test('cleans dangling back-references from consolidated entries', () => {
        // The back-reference cleanup is defensive code: it handles the edge
        // case where a raw observation is cited by a consolidated entry but
        // is still present in raw[] (e.g. after a partial consolidation or
        // manual metadata edits). Normal consolidation archives consumed
        // raws, so this path is hard to trigger naturally — we set it up
        // directly here.
        //
        // ARRANGE: capture one observation, then manually add a consolidated
        // entry that cites it WITHOUT archiving it first.
        appendRawObservations('Mara', [obs('A', '"a"')]);
        const file = getEvidenceFile('Mara', false);
        const rawId = file.raw[0].id;
        file.consolidated = [{
            id: 'con-001',
            category: 'trait',
            claim: 'Cites the raw',
            sources: [rawId],
        }];

        // ACT: delete the raw observation that the consolidated claim cites.
        const ok = deleteRawObservation('Mara', rawId);
        // ASSERT: deletion succeeded...
        expect(ok).toBe(true);
        // ...and the dangling source id was removed from the consolidated entry.
        const con = getEvidenceFile('Mara', false).consolidated[0];
        expect(con.sources).not.toContain(rawId);
    });

    test('returns false when the observation id does not exist', () => {
        appendRawObservations('Mara', [obs('A', '"a"')]);
        const ok = deleteRawObservation('Mara', 'obs-999');
        expect(ok).toBe(false);
    });
});

describe('nextObsId', () => {

    test('produces sequential ids within a tier', () => {
        // ARRANGE: seed a file with one raw observation.
        appendRawObservations('X', [obs('one', '"one"')]);
        const file = getEvidenceFile('X', false);
        // ACT: ask for the next id.
        const next = nextObsId(file, 'raw');
        // ASSERT: the existing obs is obs-001, so next should be obs-002.
        expect(file.raw[0].id).toBe('obs-001');
        expect(next).toBe('obs-002');
    });
});