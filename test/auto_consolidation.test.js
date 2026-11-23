/**
 * test/auto_consolidation.test.js — Tests for the opt-in raw-backlog manager
 * (knowledge/auto_consolidation.js) and its bookkeeping in evidence.js.
 *
 * The driver is exercised end-to-end with the stub-core pattern (see
 * test/evidence.test.js for the pattern notes): the fake API lets each test
 * decide exactly which numeric ids a "consolidator" cites, which is the whole
 * game for the retry-edge-case tests — uncited observations stay raw, and the
 * watermark (not the raw count) is what stops the same pool being
 * re-presented forever.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetCoreStubs, setFakeApi, setFakeChat, getFakeNotifications } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { state } from '../knowledge/state.js';
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
    toggleCanon,
} from '../knowledge/evidence.js';
import {
    maybeRunAutoConsolidation,
    evaluateAutoConsolidation,
    backoffRequired,
    resolveThreshold,
    AUTO_CONSOLIDATION_BATCH_LIMIT,
    AUTO_CONSOLIDATION_MAX_BATCHES,
} from '../knowledge/auto_consolidation.js';
import { runConsolidation } from '../knowledge/growth.js';

const BOOK = 'Knowledge Tracker';

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
    _setCacheForTests(BOOK, { registry: { Mara: { uid: 7, type: 'major', entityId: 'ent-mara', aliases: [] } } });
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
});
afterEach(() => { _clearCacheForTests(); state.wiScript = null; vi.unstubAllGlobals(); });

// ── Helpers ──────────────────────────────────────────────────────────────────

function obs(claim, quote) {
    return { category: 'trait', claim, quote, msgIdx: 0 };
}

function seedRaw(name, count, startLabel = 0) {
    const batch = [];
    for (let i = 0; i < count; i++) {
        batch.push(obs(`Claim ${startLabel + i}`, `quote ${startLabel + i}`));
    }
    return appendRawObservations(name, batch);
}

/**
 * Install an API fake whose consolidator cites the ids it was presented with.
 * `pick` selects which presented numeric ids a single claim cites (default:
 * all). Returns the array requests are recorded into.
 */
function citePresentedApi(pick = ids => ids) {
    const requests = [];
    setFakeApi(request => {
        requests.push(request);
        const ids = [...String(request.userContent).matchAll(/^\[(\d+)\]/gm)].map(m => Number(m[1]));
        const cited = pick(ids);
        if (cited.length === 0) return JSON.stringify({ consolidated: [] });
        return JSON.stringify({ consolidated: [{ category: 'trait', claim: 'Distilled pattern', sources: cited, confidence: 'high' }] });
    });
    return requests;
}

/** Hand-built evidence file for the PURE gate tests (no persistence needed). */
function makeFile(npc, count, { watermark = 0, failures = 0, canonIds = [] } = {}) {
    const raw = [];
    for (let i = 1; i <= count; i++) {
        raw.push({ id: `obs-${String(i).padStart(3, '0')}`, claim: `c${i}`, quote: `q${i}`, canon: canonIds.includes(i) });
    }
    return { npc, raw, consolidated: [], archivedRaw: [], meta: { autoConsolidation: { watermark, failures, lastAttemptAt: null, lastSuccessAt: null } } };
}

// ── Pure gate functions ──────────────────────────────────────────────────────

describe('backoffRequired', () => {
    test('no failures → any single new observation re-arms the trigger', () => {
        expect(backoffRequired(0)).toBe(1);
        expect(backoffRequired(-3)).toBe(1);
        expect(backoffRequired(NaN)).toBe(1);
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
        expect(r.newSinceWatermark).toBe(15);
        expect(r.failures).toBe(0);
    });

    test('below threshold is not eligible even with all-new evidence', () => {
        const [r] = evaluateAutoConsolidation({ A: makeFile('A', 9) }, 10);
        expect(r.eligible).toBe(false);
    });

    test('watermark blocks re-trigger: uncited stayers above threshold do not re-arm', () => {
        // The retry edge case: 20 uncited stayers remain above a threshold of
        // 10, but the pass that left them PRESENTED them (watermark 30 of 30).
        const [r] = evaluateAutoConsolidation({ A: makeFile('A', 20, { watermark: 30 }) }, 10);
        expect(r.nonCanonRawCount).toBe(20);
        expect(r.newSinceWatermark).toBe(0);
        expect(r.eligible).toBe(false);
    });

    test('canon raws never count toward either leg', () => {
        const [r] = evaluateAutoConsolidation({ A: makeFile('A', 15, { canonIds: [1, 2, 3, 4, 5, 6] }) }, 10);
        expect(r.nonCanonRawCount).toBe(9);
        expect(r.eligible).toBe(false);
    });

    test('failures raise the new-evidence bar (backoff)', () => {
        // 15 unseen observations after one failure: below the 20 bar.
        expect(evaluateAutoConsolidation({ A: makeFile('A', 15, { failures: 1 }) }, 10)[0].eligible).toBe(false);
        // 20 unseen: exactly at the bar.
        expect(evaluateAutoConsolidation({ A: makeFile('A', 20, { failures: 1 }) }, 10)[0].eligible).toBe(true);
        // Two failures: the bar is 40.
        expect(evaluateAutoConsolidation({ A: makeFile('A', 20, { failures: 2 }) }, 10)[0].eligible).toBe(false);
        expect(evaluateAutoConsolidation({ A: makeFile('A', 40, { failures: 2 }) }, 10)[0].eligible).toBe(true);
    });
});

// ── Batching (getRawForConsolidation) ────────────────────────────────────────

describe('getRawForConsolidation limit', () => {
    test('limit slices the OLDEST non-canon raws (stored order)', () => {
        seedRaw('Mara', 5);
        const limited = getRawForConsolidation('Mara', { limit: 3 });
        expect(limited.map(o => o.id)).toEqual(['obs-001', 'obs-002', 'obs-003']);
        expect(limited.map(o => o.numericId)).toEqual([1, 2, 3]);
    });

    test('no limit presents the whole pool (manual behaviour unchanged)', () => {
        seedRaw('Mara', 5);
        expect(getRawForConsolidation('Mara')).toHaveLength(5);
    });

    test('canon entries are excluded before the slice is taken', () => {
        seedRaw('Mara', 5);
        toggleCanon('Mara', 'obs-001');
        toggleCanon('Mara', 'obs-002');
        const limited = getRawForConsolidation('Mara', { limit: 2 });
        expect(limited.map(o => o.id)).toEqual(['obs-003', 'obs-004']);
    });
});

// ── Watermark bookkeeping (evidence.js) ──────────────────────────────────────

describe('watermark stamping', () => {
    test('a successful pass advances the watermark to the highest PRESENTED id', () => {
        seedRaw('Mara', 4);
        // Present all 4, cite only 2 — the watermark must still cover the
        // uncited pair: they were seen, so only NEWER evidence re-arms.
        const stats = applyConsolidation('Mara',
            [{ category: 'trait', claim: 'Distilled', sources: [1, 2] }],
            ['obs-001', 'obs-002', 'obs-003', 'obs-004']);
        expect(stats.consolidatedCount).toBe(1);
        expect(getEvidenceFile('Mara', false).meta.autoConsolidation.watermark).toBe(4);
    });

    test('a zero-yield pass does NOT advance the watermark', () => {
        seedRaw('Mara', 4);
        applyConsolidation('Mara', [{ category: 'trait', claim: 'No sources', sources: [] }],
            ['obs-001', 'obs-002', 'obs-003', 'obs-004']);
        // No container was even created by the pass itself.
        const file = getEvidenceFile('Mara', false);
        expect(file.meta.autoConsolidation).toBeUndefined();
    });

    test('recordAutoConsolidationOutcome counts failures and resets on success', () => {
        seedRaw('Mara', 1);
        recordAutoConsolidationOutcome('Mara', { ok: false });
        recordAutoConsolidationOutcome('Mara', { ok: false });
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false)).failures).toBe(2);
        recordAutoConsolidationOutcome('Mara', { ok: true });
        const meta = getEvidenceFile('Mara', false).meta.autoConsolidation;
        expect(meta.failures).toBe(0);
        expect(meta.lastSuccessAt).toBeTypeOf('number');
    });

    test('expandConsolidated lowers the watermark beneath the oldest restored id', () => {
        seedRaw('Mara', 4);
        applyConsolidation('Mara',
            [{ category: 'trait', claim: 'Distilled', sources: [1, 2] }],
            ['obs-001', 'obs-002', 'obs-003', 'obs-004']);
        expect(getEvidenceFile('Mara', false).meta.autoConsolidation.watermark).toBe(4);
        expandConsolidated('Mara', 'con-001');
        // obs-001/obs-002 returned to raw[] with their original ids; the
        // watermark drops to 0 (min restored seq 1 − 1) so the auto trigger
        // can pick the restored evidence up again.
        expect(getEvidenceFile('Mara', false).meta.autoConsolidation.watermark).toBe(0);
        expect(getEvidenceFile('Mara', false).raw.map(o => o.id)).toEqual(['obs-003', 'obs-004', 'obs-001', 'obs-002']);
    });
});

// ── Overlap guard (runConsolidation) ─────────────────────────────────────────

describe('runConsolidation in-flight guard', () => {
    test('rejects a second pass for the same NPC while one is running', async () => {
        seedRaw('Mara', 5);
        state.consolidationInFlight.add('Mara');
        await expect(runConsolidation('Mara')).rejects.toThrow(/already running/);
        state.consolidationInFlight.clear();
    });

    test('the guard is released when a pass throws, so a retry is possible', async () => {
        seedRaw('Mara', 5);
        // Registry entry missing → runConsolidation throws after the guard.
        _setCacheForTests(BOOK, { registry: {} });
        await expect(runConsolidation('Mara')).rejects.toThrow(/not in the NPC registry/);
        expect(state.consolidationInFlight.has('Mara')).toBe(false);
    });
});

// ── Driver (maybeRunAutoConsolidation) ───────────────────────────────────────

describe('maybeRunAutoConsolidation', () => {
    test('disabled setting → null, no API call', async () => {
        saveSettings({ growthAutoConsolidationEnabled: false });
        const requests = citePresentedApi();
        seedRaw('Mara', 30);
        expect(await maybeRunAutoConsolidation()).toBeNull();
        expect(requests).toHaveLength(0);
    });

    test('below threshold → null (quiet idle check)', async () => {
        const requests = citePresentedApi();
        seedRaw('Mara', 9); // threshold is 10
        expect(await maybeRunAutoConsolidation()).toBeNull();
        expect(requests).toHaveLength(0);
    });

    test('a second scan while one is running is a no-op', async () => {
        seedRaw('Mara', 15);
        state.autoConsolidationScanInFlight = true;
        const requests = citePresentedApi();
        expect(await maybeRunAutoConsolidation()).toBeNull();
        expect(requests).toHaveLength(0);
    });

    test('eligible NPC drains: cites land, raws archive, watermark stamps, failures reset', async () => {
        citePresentedApi();
        seedRaw('Mara', 15);
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

    test('retry edge case: uncited stayers above threshold do NOT re-trigger', async () => {
        // 30 raws; the consolidator cites only the first 10 → 20 uncited
        // stay above the threshold of 10, but the pass presented all 30.
        const requests = citePresentedApi(ids => ids.slice(0, 10));
        seedRaw('Mara', 30);
        const result = await maybeRunAutoConsolidation();
        expect(result.archivedCount).toBe(10);
        expect(getEvidenceFile('Mara', false).raw).toHaveLength(20);
        // No second pass without new evidence — a naive count check would
        // have fired the same request again.
        expect(await maybeRunAutoConsolidation()).toBeNull();
        expect(requests).toHaveLength(1);
        // One genuinely-new observation re-arms the trigger.
        seedRaw('Mara', 1, 100);
        expect(await maybeRunAutoConsolidation()).not.toBeNull();
        expect(requests).toHaveLength(2);
    });

    test('bounded batches: a large backlog drains at most MAX_BATCHES per scan', async () => {
        const requests = citePresentedApi();
        seedRaw('Mara', 500);
        const result = await maybeRunAutoConsolidation();
        expect(requests).toHaveLength(AUTO_CONSOLIDATION_MAX_BATCHES);
        // 3 batches × 150 presented; 500 − 450 = 50 uncited-or-unseen left.
        expect(getEvidenceFile('Mara', false).raw).toHaveLength(500 - AUTO_CONSOLIDATION_BATCH_LIMIT * AUTO_CONSOLIDATION_MAX_BATCHES);
        expect(result.archivedCount).toBe(AUTO_CONSOLIDATION_BATCH_LIMIT * AUTO_CONSOLIDATION_MAX_BATCHES);
    });

    test('zero-yield pass stamps a failure and backs off by new-evidence count', async () => {
        setFakeApi(() => JSON.stringify({ consolidated: [] }));
        seedRaw('Mara', 15);
        const first = await maybeRunAutoConsolidation();
        expect(first.consolidatedCount).toBe(0);
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false)).failures).toBe(1);
        // The zero-yield info toast fired (failures are never silent).
        expect(getFakeNotifications().some(n => /no new claims for Mara/.test(n.message))).toBe(true);
        // 15 unseen since the (unadvanced) watermark < the 20 bar → blocked.
        expect(await maybeRunAutoConsolidation()).toBeNull();
        // 5 more observations → 20 unseen → retry happens (and now succeeds).
        citePresentedApi();
        seedRaw('Mara', 5, 100);
        const second = await maybeRunAutoConsolidation();
        expect(second.consolidatedCount).toBe(1);
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false)).failures).toBe(0);
    });

    test('a thrown pass stamps a failure and reports it', async () => {
        setFakeApi(() => { throw new Error('rate limited'); });
        seedRaw('Mara', 15);
        const result = await maybeRunAutoConsolidation();
        expect(result.consolidatedCount).toBe(0);
        expect(readAutoConsolidationState(getEvidenceFile('Mara', false)).failures).toBe(1);
        expect(getFakeNotifications().some(n => n.level === 'error' && /Auto-consolidation failed/.test(n.message))).toBe(true);
    });

    test('an NPC missing from the registry fails honestly (stamp + toast), others still run', async () => {
        _setCacheForTests(BOOK, { registry: {
            Mara: { uid: 7, type: 'major', entityId: 'ent-mara', aliases: [] },
            Ghost: { uid: 8, type: 'major', entityId: 'ent-ghost', aliases: [] },
        } });
        citePresentedApi();
        seedRaw('Mara', 15);
        seedRaw('Ghost', 15);
        _setCacheForTests(BOOK, { registry: {
            Mara: { uid: 7, type: 'major', entityId: 'ent-mara', aliases: [] },
        } });
        const result = await maybeRunAutoConsolidation();
        expect(result.npcs).toEqual(['Mara']);
        expect(readAutoConsolidationState(getEvidenceFile('Ghost', false)).failures).toBe(1);
        expect(getFakeNotifications().some(n => n.level === 'error' && /Ghost/.test(n.message))).toBe(true);
    });
});
