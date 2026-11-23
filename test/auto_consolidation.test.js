/**
 * test/auto_consolidation.test.js — Tests for the opt-in raw-backlog manager
 * (knowledge/auto_consolidation.js) and its bookkeeping in evidence.js.
 *
 * The driver is exercised end-to-end with the stub-core pattern (see
 * test/evidence.test.js for the pattern notes): the fake API lets each test
 * decide exactly which numeric ids a "consolidator" cites, which is the whole
 * game here — uncited observations stay raw ("stayers"), and the trigger must
 * count only evidence no pass has seen, or stayers hold it open forever.
 *
 * The consolidator fakes deliberately leave observations UNCITED: a fake that
 * cites everything (or a pool smaller than one batch) is exactly what hid the
 * first draft's starvation and fire-on-every-capture bugs (2026-11-22
 * review). The "review regressions" block pins those scenarios.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetCoreStubs, setFakeApi, setFakeChat, getFakeNotifications, getFakeMeta } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { state, GROWTH_EVIDENCE_KEY } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import {
    getEvidenceFile,
    appendRawObservations,
    applyConsolidation,
    expandConsolidated,
    getRawForConsolidation,
    recordAutoConsolidationOutcome,
    readAutoConsolidationState,
    rawSeqHighWater,
    toggleCanon,
} from '../knowledge/evidence.js';
import {
    maybeRunAutoConsolidation,
    evaluateAutoConsolidation,
    backoffRequired,
    resolveThreshold,
    AUTO_CONSOLIDATION_BATCH_LIMIT,
    AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN,
} from '../knowledge/auto_consolidation.js';
import { runConsolidation } from '../knowledge/growth.js';

const BOOK = 'Knowledge Tracker';
const registryOf = names => Object.fromEntries(names.map((n, i) => [n, { uid: 7 + i, type: 'major', entityId: `ent-${n}`, aliases: [] }]));

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveSettings({
        scope: 'global',
        apiUrl: 'https://example.test',
        modelName: 'test-model',
        growthAutoConsolidationEnabled: true,
        growthAutoConsolidationThreshold: 10,
    });
    _setCacheForTests(BOOK, { registry: registryOf(['Mara']) });
    _setCacheForTests('State Tracker', { stateRegistry: {} });
    const books = new Map();
    state.wiScript = {
        books,
        async loadWorldInfo(name) { return structuredClone(books.get(name) || null); },
        async saveWorldInfo(name, wi, immediately) { if (immediately) books.set(name, structuredClone(wi)); },
    };
    installCleanupFetch(state.wiScript);
    setFakeChat([{ name: 'Mara', mes: 'Mara takes watch.', send_date: 1000 }]);
    // Default API fake: a consolidator that cites nothing (zero-yield).
    setFakeApi(() => JSON.stringify({ consolidated: [] }));
    state.consolidationInFlight.clear();
    state.autoConsolidationScanInFlight = false;
    labelSeq = 0;
});
afterEach(() => { _clearCacheForTests(); state.wiScript = null; vi.unstubAllGlobals(); });

// ── Helpers ──────────────────────────────────────────────────────────────────

let labelSeq = 0;

/** Append `count` observations whose claim text starts with `kind` (the
 *  consolidator fakes key off it: 'Strong' gets cited, 'Weak' does not). */
function seed(name, count, kind = 'Claim') {
    const batch = [];
    for (let i = 0; i < count; i++) {
        labelSeq++;
        batch.push({ category: 'trait', claim: `${kind} ${labelSeq}`, quote: `quote ${labelSeq}`, msgIdx: 0 });
    }
    return appendRawObservations(name, batch);
}

/**
 * Install a consolidator fake. `decide(lines)` receives the presented
 * [{n, text}] and returns the numeric ids ONE claim cites. Returns the list
 * of presented claim texts, one array per API call.
 */
function consolidator(decide = lines => lines.map(l => l.n)) {
    const presented = [];
    setFakeApi(request => {
        const lines = [...String(request.userContent).matchAll(/^\[(\d+)\] \[[^\]]*\] \[[^\]]*\] (.*)$/gm)]
            .map(m => ({ n: Number(m[1]), text: m[2] }));
        presented.push(lines.map(l => l.text));
        const cited = decide(lines);
        if (cited.length === 0) return JSON.stringify({ consolidated: [] });
        return JSON.stringify({ consolidated: [{ category: 'trait', claim: 'Distilled pattern', sources: cited, confidence: 'high' }] });
    });
    return presented;
}
const citeStrongOnly = lines => lines.filter(l => l.text.startsWith('Strong')).map(l => l.n);
const kindsOf = texts => texts.reduce((acc, t) => { const k = t.split(' ')[0]; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const rawKinds = name => kindsOf(getEvidenceFile(name, false).raw.map(o => o.claim));

/** Hand-built evidence file for the PURE gate tests (no persistence needed). */
function makeFile(npc, count, { watermark = 0, failures = 0, attemptHighWater, canonIds = [], expandedIds = [] } = {}) {
    const raw = [];
    for (let i = 1; i <= count; i++) {
        raw.push({
            id: `obs-${String(i).padStart(3, '0')}`, claim: `c${i}`, quote: `q${i}`,
            canon: canonIds.includes(i), ...(expandedIds.includes(i) ? { expandedAt: 1 } : {}),
        });
    }
    const autoConsolidation = { watermark, failures, lastAttemptAt: null, lastSuccessAt: null };
    if (attemptHighWater !== undefined) autoConsolidation.attemptHighWater = attemptHighWater;
    return { npc, raw, consolidated: [], archivedRaw: [], meta: { autoConsolidation } };
}

// ── Pure gate functions ──────────────────────────────────────────────────────

describe('backoffRequired', () => {
    test('no failures → no backoff (the unseen leg is the whole requirement)', () => {
        expect(backoffRequired(0)).toBe(0);
        expect(backoffRequired(-3)).toBe(0);
        expect(backoffRequired(NaN)).toBe(0);
    });

    test('doubles per consecutive failure, capped at 80', () => {
        expect(backoffRequired(1)).toBe(20);
        expect(backoffRequired(2)).toBe(40);
        expect(backoffRequired(3)).toBe(80);
        expect(backoffRequired(4)).toBe(80);
        expect(backoffRequired(10)).toBe(80);
    });
});

describe('resolveThreshold', () => {
    test('defaults to 100 for absent/invalid values', () => {
        expect(resolveThreshold({})).toBe(100);
        expect(resolveThreshold({ growthAutoConsolidationThreshold: 'abc' })).toBe(100);
    });

    test('clamps to the 10–1000 bounds and truncates', () => {
        expect(resolveThreshold({ growthAutoConsolidationThreshold: 3 })).toBe(10);
        expect(resolveThreshold({ growthAutoConsolidationThreshold: 5000 })).toBe(1000);
        expect(resolveThreshold({ growthAutoConsolidationThreshold: 55.7 })).toBe(55);
        expect(resolveThreshold({ growthAutoConsolidationThreshold: 300 })).toBe(300);
    });
});

describe('evaluateAutoConsolidation (pure gate)', () => {
    test('eligible at/above threshold with unseen evidence', () => {
        const [r] = evaluateAutoConsolidation({ A: makeFile('A', 15) }, 10);
        expect(r.eligible).toBe(true);
        expect(r.nonCanonRawCount).toBe(15);
        expect(r.unseenCount).toBe(15);
        expect(r.failures).toBe(0);
    });

    test('below threshold is not eligible even with all-new evidence', () => {
        expect(evaluateAutoConsolidation({ A: makeFile('A', 9) }, 10)[0].eligible).toBe(false);
    });

    test('stayers never count: 200 seen raws plus 5 new is below a threshold of 10', () => {
        // The first draft compared the WHOLE raw tier to the threshold, so
        // stayers alone held the trigger open and any new observation fired it.
        const file = makeFile('A', 205, { watermark: 200 });
        const [r] = evaluateAutoConsolidation({ A: file }, 10);
        expect(r.nonCanonRawCount).toBe(205);
        expect(r.unseenCount).toBe(5);
        expect(r.eligible).toBe(false);
    });

    test('canon and Expand-restored raws never count', () => {
        const [canon] = evaluateAutoConsolidation({ A: makeFile('A', 15, { canonIds: [1, 2, 3, 4, 5, 6] }) }, 10);
        expect(canon.unseenCount).toBe(9);
        expect(canon.eligible).toBe(false);
        const [expanded] = evaluateAutoConsolidation({ A: makeFile('A', 15, { expandedIds: [1, 2, 3, 4, 5, 6] }) }, 10);
        expect(expanded.unseenCount).toBe(9);
        expect(expanded.eligible).toBe(false);
    });

    test('backoff counts evidence captured since the last ATTEMPT, not the unseen pool', () => {
        // A thrown pass leaves the watermark at 0, so all 40 stay unseen; the
        // bar after one failure is 20 observations newer than the attempt.
        const blocked = makeFile('A', 40, { failures: 1, attemptHighWater: 25 });
        expect(evaluateAutoConsolidation({ A: blocked }, 10)[0]).toMatchObject({ unseenCount: 40, newSinceAttempt: 15, eligible: false });
        const ready = makeFile('A', 40, { failures: 1, attemptHighWater: 20 });
        expect(evaluateAutoConsolidation({ A: ready }, 10)[0]).toMatchObject({ newSinceAttempt: 20, eligible: true });
        const twoFailures = makeFile('A', 40, { failures: 2, attemptHighWater: 20 });
        expect(evaluateAutoConsolidation({ A: twoFailures }, 10)[0].eligible).toBe(false);
    });

    test('a container without attemptHighWater measures the backoff from the watermark', () => {
        const legacy = makeFile('A', 40, { watermark: 15, failures: 1 });
        expect(evaluateAutoConsolidation({ A: legacy }, 10)[0]).toMatchObject({ unseenCount: 25, newSinceAttempt: 25, eligible: true });
    });
});

// ── Batch selection (getRawForConsolidation) ─────────────────────────────────

describe('getRawForConsolidation selection', () => {
    test('no options presents the whole pool (manual behaviour unchanged)', () => {
        seed('Mara', 5);
        expect(getRawForConsolidation('Mara')).toHaveLength(5);
    });

    test('unseenOnly skips stayers and takes the lowest unseen ids first', () => {
        seed('Mara', 6);
        const file = getEvidenceFile('Mara', false);
        file.meta.autoConsolidation = { watermark: 3, failures: 0 };
        // Stored order no longer matches id order (Expand and merges append).
        file.raw.reverse();
        const picked = getRawForConsolidation('Mara', { unseenOnly: true, limit: 2 });
        expect(picked.map(o => o.id)).toEqual(['obs-004', 'obs-005']);
        expect(picked.map(o => o.numericId)).toEqual([1, 2]);
    });

    test('canon entries are excluded before the slice is taken', () => {
        seed('Mara', 5);
        toggleCanon('Mara', 'obs-001');
        toggleCanon('Mara', 'obs-002');
        const limited = getRawForConsolidation('Mara', { unseenOnly: true, limit: 2 });
        expect(limited.map(o => o.id)).toEqual(['obs-003', 'obs-004']);
    });
});

// ── Watermark bookkeeping (evidence.js) ──────────────────────────────────────

describe('watermark stamping', () => {
    test('a successful pass advances the watermark to the highest PRESENTED id', () => {
        seed('Mara', 4);
        // Present all 4, cite only 2 — the uncited pair were seen, so the
        // watermark covers them and they become stayers.
        const stats = applyConsolidation('Mara',
            [{ category: 'trait', claim: 'Distilled', sources: [1, 2] }],
            ['obs-001', 'obs-002', 'obs-003', 'obs-004']);
        expect(stats.consolidatedCount).toBe(1);
        expect(getEvidenceFile('Mara', false).meta.autoConsolidation.watermark).toBe(4);
    });

    test('a zero-claim answer advances the watermark too (the model saw the batch)', () => {
        seed('Mara', 4);
        recordAutoConsolidationOutcome('Mara', { ok: false });
        applyConsolidation('Mara', [{ category: 'trait', claim: 'No sources', sources: [] }],
            ['obs-001', 'obs-002', 'obs-003', 'obs-004']);
        const acState = readAutoConsolidationState(getEvidenceFile('Mara', false));
        expect(acState.watermark).toBe(4);
        // Nothing was distilled, so the failure count is not reset.
        expect(acState.failures).toBe(1);
    });

    test('the advance stops below an unseen observation the pass did not present', () => {
        seed('Mara', 4);
        // A merged id shares sequence 2 with a native one; the batch skipped it.
        getEvidenceFile('Mara', false).raw.push({ id: 'ent-bob::obs-002', claim: 'Merged', quote: 'm', canon: false });
        applyConsolidation('Mara', [{ category: 'trait', claim: 'Distilled', sources: [1] }],
            ['obs-001', 'obs-002', 'obs-003']);
        // Raising the watermark to 3 would mark the unpresented merged
        // observation as seen; it stops at 1 instead.
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false)).watermark).toBe(1);
    });

    test('a manual pass that distils something resets the automatic failure count', () => {
        seed('Mara', 4);
        recordAutoConsolidationOutcome('Mara', { ok: false });
        recordAutoConsolidationOutcome('Mara', { ok: false });
        recordAutoConsolidationOutcome('Mara', { ok: false });
        applyConsolidation('Mara', [{ category: 'trait', claim: 'Distilled', sources: [1] }], ['obs-001', 'obs-002']);
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false)).failures).toBe(0);
    });

    test('recordAutoConsolidationOutcome counts failures, resets on success, stamps the attempt high-water', () => {
        seed('Mara', 3);
        recordAutoConsolidationOutcome('Mara', { ok: false, attemptHighWater: 3 });
        recordAutoConsolidationOutcome('Mara', { ok: false, attemptHighWater: 3 });
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false))).toMatchObject({ failures: 2, attemptHighWater: 3 });
        recordAutoConsolidationOutcome('Mara', { ok: true });
        const meta = getEvidenceFile('Mara', false).meta.autoConsolidation;
        expect(meta.failures).toBe(0);
        expect(meta.lastSuccessAt).toBeTypeOf('number');
    });

    test('rawSeqHighWater scans raw and archivedRaw', () => {
        seed('Mara', 4);
        applyConsolidation('Mara', [{ category: 'trait', claim: 'Distilled', sources: [4] }], ['obs-004']);
        expect(rawSeqHighWater(getEvidenceFile('Mara', false))).toBe(4);
        expect(rawSeqHighWater(null)).toBe(0);
    });

    test('Expand stamps the restored raws, leaves the watermark alone, and the stamp persists', () => {
        seed('Mara', 4);
        applyConsolidation('Mara',
            [{ category: 'trait', claim: 'Distilled', sources: [1, 2] }],
            ['obs-001', 'obs-002', 'obs-003', 'obs-004']);
        expandConsolidated('Mara', 'con-001');
        const file = getEvidenceFile('Mara', false);
        expect(file.meta.autoConsolidation.watermark).toBe(4);
        expect(file.raw.map(o => o.id)).toEqual(['obs-003', 'obs-004', 'obs-001', 'obs-002']);
        expect(file.raw.filter(o => o.expandedAt != null).map(o => o.id)).toEqual(['obs-001', 'obs-002']);
        // Survives the checked commit (the schema keeps extra record fields).
        const committed = getFakeMeta()[GROWTH_EVIDENCE_KEY].Mara.raw;
        expect(committed.filter(o => o.expandedAt != null)).toHaveLength(2);
    });
});

// ── Pipeline guards (growth.js) ──────────────────────────────────────────────

describe('runConsolidation guards', () => {
    test('rejects a second pass for the same NPC while one is running or queued', async () => {
        seed('Mara', 5);
        state.consolidationInFlight.add('Mara');
        await expect(runConsolidation('Mara')).rejects.toThrow(/already running or queued/);
        state.consolidationInFlight.clear();
    });

    test('the guard is released when a pass throws, so a retry is possible', async () => {
        seed('Mara', 5);
        _setCacheForTests(BOOK, { registry: {} });
        await expect(runConsolidation('Mara')).rejects.toThrow(/not in the NPC registry/);
        expect(state.consolidationInFlight.has('Mara')).toBe(false);
    });

    test('a reply without a consolidated list throws and leaves the watermark alone', async () => {
        seed('Mara', 5);
        setFakeApi(() => JSON.stringify({ claims: [] }));
        await expect(runConsolidation('Mara')).rejects.toThrow(/no "consolidated" list/);
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false)).watermark).toBe(0);
        expect(getEvidenceFile('Mara', false).raw).toHaveLength(5);
    });
});

// ── Driver (maybeRunAutoConsolidation) ───────────────────────────────────────

describe('maybeRunAutoConsolidation', () => {
    test('disabled setting → null, no API call', async () => {
        saveSettings({ growthAutoConsolidationEnabled: false });
        const presented = consolidator();
        seed('Mara', 30);
        expect(await maybeRunAutoConsolidation()).toBeNull();
        expect(presented).toHaveLength(0);
    });

    test('below threshold → null (quiet idle check)', async () => {
        const presented = consolidator();
        seed('Mara', 9); // threshold is 10
        expect(await maybeRunAutoConsolidation()).toBeNull();
        expect(presented).toHaveLength(0);
    });

    test('a second scan while one is running is a no-op', async () => {
        seed('Mara', 15);
        state.autoConsolidationScanInFlight = true;
        const presented = consolidator();
        expect(await maybeRunAutoConsolidation()).toBeNull();
        expect(presented).toHaveLength(0);
    });

    test('eligible NPC drains: cites land, raws archive, watermark stamps, failures reset', async () => {
        consolidator();
        seed('Mara', 15);
        const result = await maybeRunAutoConsolidation();
        expect(result.npcs).toEqual(['Mara']);
        expect(result.consolidatedCount).toBe(1);
        expect(result.archivedCount).toBe(15);
        const file = getEvidenceFile('Mara', false);
        expect(file.raw).toHaveLength(0);
        expect(file.consolidated).toHaveLength(1);
        expect(file.meta.autoConsolidation.watermark).toBe(15);
        expect(file.meta.autoConsolidation.failures).toBe(0);
    });

    test('retry edge case: stayers never re-trigger, and the next pass presents only new evidence', async () => {
        // 30 raws; the consolidator cites only the first 10 → 20 stayers.
        const presented = consolidator(lines => lines.slice(0, 10).map(l => l.n));
        seed('Mara', 30);
        expect((await maybeRunAutoConsolidation()).archivedCount).toBe(10);
        expect(getEvidenceFile('Mara', false).raw).toHaveLength(20);
        expect(await maybeRunAutoConsolidation()).toBeNull();
        // One new observation is not a backlog: the threshold counts unseen evidence.
        seed('Mara', 1, 'New');
        expect(await maybeRunAutoConsolidation()).toBeNull();
        seed('Mara', 9, 'New');
        expect(await maybeRunAutoConsolidation()).not.toBeNull();
        expect(presented).toHaveLength(2);
        expect(kindsOf(presented[1])).toEqual({ New: 10 });
    });

    test('a large backlog spends at most MAX_CALLS_PER_SCAN batches, lowest ids first', async () => {
        const presented = consolidator();
        seed('Mara', 500);
        const result = await maybeRunAutoConsolidation();
        expect(presented).toHaveLength(AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN);
        expect(presented.every(p => p.length === AUTO_CONSOLIDATION_BATCH_LIMIT)).toBe(true);
        expect(result.archivedCount).toBe(AUTO_CONSOLIDATION_BATCH_LIMIT * AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN);
        expect(getEvidenceFile('Mara', false).raw.map(o => o.id)[0]).toBe('obs-451');
        // The rest waits for the next scan.
        await maybeRunAutoConsolidation();
        expect(getEvidenceFile('Mara', false).raw).toHaveLength(0);
    });

    test('the per-scan budget is shared across NPCs, round-robin', async () => {
        const names = ['A', 'B', 'C', 'D'];
        _setCacheForTests(BOOK, { registry: registryOf(names) });
        const presented = consolidator();
        for (const n of names) seed(n, 400, `${n}-obs`);
        await maybeRunAutoConsolidation();
        // 4 NPCs × 400 raw would have been 12 calls under a per-NPC-only cap.
        expect(presented).toHaveLength(AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN);
        const servedNpcs = presented.map(p => p[0].split(' ')[0]);
        expect(new Set(servedNpcs).size).toBe(AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN);
    });

    test('zero-yield pass stamps a failure, advances the watermark, and the retry presents only newer evidence', async () => {
        seed('Mara', 15, 'Old');
        const first = await maybeRunAutoConsolidation();
        expect(first.consolidatedCount).toBe(0);
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false))).toMatchObject({ watermark: 15, failures: 1, attemptHighWater: 15 });
        expect(getFakeNotifications().some(n => /found nothing to consolidate for Mara/.test(n.message))).toBe(true);
        const presented = consolidator();
        // 15 unseen clears the threshold, but the backoff bar after one
        // failure is 20 observations captured since the attempt.
        seed('Mara', 15, 'New');
        expect(await maybeRunAutoConsolidation()).toBeNull();
        seed('Mara', 5, 'New');
        const second = await maybeRunAutoConsolidation();
        expect(second.consolidatedCount).toBe(1);
        expect(kindsOf(presented[0])).toEqual({ New: 20 });
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false)).failures).toBe(0);
    });

    test('a thrown pass stamps a failure, keeps the watermark, and the retry re-presents the same batch', async () => {
        setFakeApi(() => { throw new Error('rate limited'); });
        seed('Mara', 15, 'Old');
        const result = await maybeRunAutoConsolidation();
        expect(result.consolidatedCount).toBe(0);
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false))).toMatchObject({ watermark: 0, failures: 1, attemptHighWater: 15 });
        expect(getFakeNotifications().some(n => n.level === 'error' && /Auto-consolidation failed/.test(n.message))).toBe(true);
        // No retry on the next capture without enough new evidence.
        const presented = consolidator();
        seed('Mara', 19, 'New');
        expect(await maybeRunAutoConsolidation()).toBeNull();
        seed('Mara', 1, 'New');
        await maybeRunAutoConsolidation();
        expect(kindsOf(presented[0])).toEqual({ Old: 15, New: 20 });
    });

    test('an NPC missing from the registry fails honestly (stamp + toast), others still run', async () => {
        _setCacheForTests(BOOK, { registry: registryOf(['Mara', 'Ghost']) });
        consolidator();
        seed('Mara', 15);
        seed('Ghost', 15);
        _setCacheForTests(BOOK, { registry: registryOf(['Mara']) });
        const result = await maybeRunAutoConsolidation();
        expect(result.npcs).toEqual(['Mara']);
        expect(readAutoConsolidationState(getEvidenceFile('Ghost', false)).failures).toBe(1);
        expect(getFakeNotifications().some(n => n.level === 'error' && /Ghost/.test(n.message))).toBe(true);
    });
});

// ── Review regressions (2026-11-22) ──────────────────────────────────────────
//
// Each scenario reproduced a bug in the first draft with the consolidator
// fakes below; they are kept as-is so the bugs can't return quietly.

describe('review regressions', () => {
    beforeEach(() => saveSettings({ growthAutoConsolidationThreshold: 100 }));

    /** A manual pass that cites the Strong observations and leaves `stayers` Weak ones raw. */
    async function leaveStayers(stayers) {
        consolidator(citeStrongOnly);
        seed('Mara', 10, 'Strong');
        seed('Mara', stayers, 'Weak');
        await runConsolidation('Mara');
        expect(rawKinds('Mara')).toEqual({ Weak: stayers });
    }

    test('new evidence is not starved behind 150+ stayers', async () => {
        // First draft: every batch was the oldest 150 raws — the same 160
        // stayers — so the new evidence was never presented, retry after retry.
        await leaveStayers(160);
        const presented = consolidator(citeStrongOnly);
        seed('Mara', 100, 'Strong');
        await maybeRunAutoConsolidation();
        expect(presented).toHaveLength(1);
        expect(kindsOf(presented[0])).toEqual({ Strong: 100 });
        expect(rawKinds('Mara')).toEqual({ Weak: 160 });
    });

    test('stayers above the threshold do not fire a call on every small capture', async () => {
        // First draft: 120 stayers kept the count leg open, so each capture
        // of 3 observations fired a 123-observation call.
        await leaveStayers(120);
        const presented = consolidator(citeStrongOnly);
        for (let capture = 0; capture < 5; capture++) {
            seed('Mara', 3, 'Strong');
            expect(await maybeRunAutoConsolidation()).toBeNull();
        }
        expect(presented).toHaveLength(0);
    });

    test('a low-yield scan does not re-fire when nothing new was captured', async () => {
        // First draft: a consolidator that distilled one stayer per call
        // "succeeded", so every scan re-sent the stayers — 3 calls each, with
        // no new evidence at all.
        await leaveStayers(300);
        const presented = consolidator(lines => [lines.find(l => l.text.startsWith('Weak'))?.n].filter(Boolean));
        seed('Mara', 100, 'Strong');
        await maybeRunAutoConsolidation();
        const afterFirst = presented.length;
        expect(afterFirst).toBe(1);
        await maybeRunAutoConsolidation();
        await maybeRunAutoConsolidation();
        expect(presented).toHaveLength(afterFirst);
    });

    test('an expanded claim is not rebuilt by the next scan', async () => {
        saveSettings({ growthAutoConsolidationThreshold: 10 });
        const presented = consolidator();
        seed('Mara', 20);
        await maybeRunAutoConsolidation();
        expandConsolidated('Mara', 'con-001');
        expect(await maybeRunAutoConsolidation()).toBeNull();
        // Even when unrelated new evidence triggers a pass, the restored raws stay out of it.
        seed('Mara', 10, 'New');
        await maybeRunAutoConsolidation();
        expect(kindsOf(presented.at(-1))).toEqual({ New: 10 });
        expect(getEvidenceFile('Mara', false).raw).toHaveLength(20);
    });

    test('an expanded claim from before the feature existed (no watermark yet) is not rebuilt either', async () => {
        saveSettings({ growthAutoConsolidationThreshold: 10 });
        seed('Mara', 20);
        // A pre-feature manual pass: archived sources, but no watermark container.
        applyConsolidation('Mara', [{ category: 'trait', claim: 'Old claim', sources: [1, 2, 3] }],
            getEvidenceFile('Mara', false).raw.map(o => o.id));
        delete getEvidenceFile('Mara', false).meta.autoConsolidation;
        expandConsolidated('Mara', 'con-001');
        const presented = consolidator();
        await maybeRunAutoConsolidation();
        expect(presented).toHaveLength(1);
        expect(presented[0]).toHaveLength(17);
        expect(getEvidenceFile('Mara', false).raw.map(o => o.id)).toEqual(['obs-001', 'obs-002', 'obs-003']);
    });
});
