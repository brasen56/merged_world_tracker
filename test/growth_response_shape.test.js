/**
 * Wrong-shape replies in Growth evidence capture and the relationship extract
 * (follow-up to test/knowledge_response_shape.test.js).
 *
 * Growth is the severe case: every capture path advances its cursor once it
 * accepts a reply, and appendRawObservations advances it even when nothing is
 * added. A reply under invented keys ({"behavioral_traits": [...]}) used to
 * read as "no observations", so its messages were skipped for good — and
 * Catch Up, which loops while the cursor advances, could walk a whole history
 * that way. Pinned here: a wrong-shape reply throws BEFORE any append, the
 * cursor stays put, and the next capture re-reads the same messages.
 *
 * The relationship extract reads a fixed window (no cursor), so it gets the
 * Knowledge treatment: `{}` stays a valid "nothing", invented keys are retried
 * once with the real reason.
 *
 * The production parser is installed over the stub (setFakeParser) — see the
 * Knowledge test for why.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs, setFakeApi, setFakeChat, setFakeParser, getFakeMeta } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { parseJsonLenient as realParseJsonLenient } from '../core/api.js';
import { getEvents } from '../core/diagnostics.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import {
    getEvidenceFile, saveEvidenceMap, getCaptureCursor, setCaptureWatermark, getBackfillWatermark, hasEvidenceFile,
} from '../knowledge/evidence.js';
import {
    captureEvidence, runCaptureOnly, runContinuousCapture, runIlsBackfillCapture, runCatchUpCapture,
} from '../knowledge/growth.js';
import { runRelationshipExtract, getNpcRelationships } from '../knowledge/relationships.js';
import { GROWTH_EVIDENCE_RESPONSE, RELATIONSHIP_EXTRACT_RESPONSE, buildRetryReminder } from '../knowledge/prompts.js';
import { checkResponseShape } from '../knowledge/response_shape.js';

const BOOK = 'Knowledge Tracker';
const CONTENT = '[Dossier] Mara | Human | captain\nTone: soft\nRole: captain\nBackground: sailor';
/** The reported failure, transplanted to an evidence call. */
const INVENTED = JSON.stringify({ behavioral_traits: [{ claim: 'Stays calm', quote: 'Mara takes watch 1.' }] });
const VALID = JSON.stringify({ observations: [{ category: 'trait', claim: 'Takes the watch unasked', quote: 'Mara takes watch 1.', msgIdx: 1 }] });
const IN_FLIGHT = [{ is_system: true, mes: 'in flight' }, { is_system: true, mes: 'in flight' }];

let requests;
/** Queue fake replies; the last one repeats. */
function replies(...queue) {
    setFakeApi(request => {
        requests.push(request);
        return queue.length > 1 ? queue.shift() : queue[0];
    });
}
const rejections = () => getEvents({ module: 'knowledge' }).filter(e => e.event === 'response_shape_rejected').reverse();

beforeEach(() => {
    resetCoreStubs();
    setFakeParser(realParseJsonLenient);
    _clearCacheForTests();
    saveSettings({ scope: 'global', apiUrl: 'https://example.test', modelName: 'test-model', dossierMode: true });
    _setCacheForTests(BOOK, {
        registry: {
            Mara: { uid: 7, type: 'major', entityId: 'ent-mara', aliases: [] },
            Tam: { uid: 8, type: 'major', entityId: 'ent-tam', aliases: [] },
        },
    });
    _setCacheForTests('State Tracker', { stateRegistry: {} });
    const books = new Map([[BOOK, { entries: {
        7: { uid: 7, comment: 'Mara', key: ['Mara'], content: CONTENT },
        8: { uid: 8, comment: 'Tam', key: ['Tam'], content: '[Dossier] Tam | Human | deckhand' },
    } }]]);
    state.wiScript = {
        books,
        async loadWorldInfo(name) { return structuredClone(books.get(name) || null); },
        async saveWorldInfo(name, wi, immediately) { if (immediately) books.set(name, structuredClone(wi)); },
    };
    installCleanupFetch(state.wiScript);
    setFakeChat([...[0, 1, 2, 3].map(i => ({ name: 'Mara', mes: `Mara takes watch ${i}.`, send_date: 1000 + i })), ...IN_FLIGHT]);
    requests = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    _clearCacheForTests();
    state.wiScript = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ─── The specs ───────────────────────────────────────────────────────────────

describe('specs', () => {
    test.each([['GROWTH_EVIDENCE_RESPONSE', GROWTH_EVIDENCE_RESPONSE], ['RELATIONSHIP_EXTRACT_RESPONSE', RELATIONSHIP_EXTRACT_RESPONSE]])(
        '%s names every key its shape check accepts', (_name, spec) => {
            for (const key of spec.keys) expect(spec.reminder).toContain(`"${key}"`);
        });

    test('evidence: the list is required and `{}` is refused (a wrong accept skips messages for good)', () => {
        expect(checkResponseShape({ observations: [] }, GROWTH_EVIDENCE_RESPONSE).ok).toBe(true);
        expect(checkResponseShape({}, GROWTH_EVIDENCE_RESPONSE).code).toBe('empty');
        expect(checkResponseShape({ observations: null }, GROWTH_EVIDENCE_RESPONSE))
            .toMatchObject({ ok: false, code: 'missing_array', reason: 'the response had no "observations" list' });
        expect(checkResponseShape({ observations: {} }, GROWTH_EVIDENCE_RESPONSE).code).toBe('missing_array');
    });

    test('relationships: `{}` stays a valid "nothing qualifies" (fixed window, no cursor)', () => {
        expect(checkResponseShape({}, RELATIONSHIP_EXTRACT_RESPONSE).ok).toBe(true);
        expect(checkResponseShape({ relationships: [] }, RELATIONSHIP_EXTRACT_RESPONSE).code).toBe('wrong_keys');
    });
});

// ─── Growth: the cursor never moves past an unread reply ─────────────────────

describe('continuous capture', () => {
    beforeEach(() => setCaptureWatermark('Mara', 999000, 0));

    test('a wrong-shape reply throws before the append: cursor and evidence untouched', async () => {
        getEvidenceFile('Mara');
        const before = getCaptureCursor('Mara');
        replies(INVENTED);
        await expect(runContinuousCapture('Mara', { minMessages: 1 })).rejects.toThrow(
            /^Wrong reply shape — the response used the top-level key "behavioral_traits" instead of "observations"; nothing was captured and these messages will be read again next time$/,
        );
        expect(getCaptureCursor('Mara')).toEqual(before);
        expect(getEvidenceFile('Mara').raw).toHaveLength(0);
        expect(requests[0].userContent.endsWith(GROWTH_EVIDENCE_RESPONSE.reminder)).toBe(true);
        // No retry loop of its own, so no attempt number in the event.
        expect(rejections()[0].detail).toEqual({
            op: 'growth_continuous_capture', code: 'wrong_keys', keyCount: 1, keys: ['behavioral_traits'],
        });
    });

    test('the next capture re-reads the same messages and lands them', async () => {
        replies(INVENTED);
        await expect(runContinuousCapture('Mara', { minMessages: 1 })).rejects.toThrow(/Wrong reply shape/);
        replies(VALID);
        const result = await runContinuousCapture('Mara', { minMessages: 1 });
        expect(requests).toHaveLength(2);
        expect(requests[1].userContent).toBe(requests[0].userContent);
        expect(result.added).toBe(1);
        expect(getCaptureCursor('Mara')).toMatchObject({ ts: 1003000, index: 3 });
    });

    test('`{}` is refused too; a real empty list still advances as before', async () => {
        replies('{}');
        await expect(runContinuousCapture('Mara', { minMessages: 1 })).rejects.toThrow(/the response was an empty JSON object/);
        expect(getCaptureCursor('Mara')).toMatchObject({ ts: 999000, index: 0 });
        replies(JSON.stringify({ observations: [] }));
        await runContinuousCapture('Mara', { minMessages: 1 });
        expect(getCaptureCursor('Mara')).toMatchObject({ ts: 1003000, index: 3 });
    });

    test('Catch Up stops at the wrong-shape batch instead of walking the history', async () => {
        setFakeChat([
            ...Array.from({ length: 30 }, (_, i) => ({ name: 'Mara', mes: `Mara takes watch ${i}.`, send_date: 1000 + i })),
            ...IN_FLIGHT,
        ]);
        const backfillBefore = getBackfillWatermark('Mara');
        replies(INVENTED);
        const result = await runCatchUpCapture('Mara');
        // Backfill walks the de-summarized history (plain messages included),
        // so each phase makes one call, stops on it, and keeps its cursor.
        expect(result).toMatchObject({ stoppedOnError: true, backfillBatches: 0, liveBatches: 0, added: 0 });
        expect(result.errors).toEqual([
            expect.stringMatching(/^Backfill batch 1: Wrong reply shape/),
            expect.stringMatching(/^Live batch 1: Wrong reply shape/),
        ]);
        expect(requests).toHaveLength(2);
        expect(getBackfillWatermark('Mara')).toBe(backfillBefore);
        expect(getCaptureCursor('Mara')).toMatchObject({ ts: 999000, index: 0 });
    });
});

describe('ILS backfill', () => {
    beforeEach(() => {
        getFakeMeta().ILS_Originals = { restored: [
            { name: 'Mara', mes: 'Mara quietly folds the sails before anyone asks.', send_date: 1000 },
            { name: 'Mara', mes: 'Mara takes charge of the watch.', send_date: 1001 },
        ] };
        setFakeChat([{ mes: 'Summary of the voyage.', send_date: 5000, extra: { ILS_Data: { Ref: 'restored' } } }, ...IN_FLIGHT]);
    });

    test('a wrong-shape reply leaves lastBackfillTs where it was, and the retry re-reads the batch', async () => {
        const before = getBackfillWatermark('Mara');
        replies(INVENTED);
        await expect(runIlsBackfillCapture('Mara')).rejects.toThrow(/^Wrong reply shape/);
        expect(getBackfillWatermark('Mara')).toBe(before);
        expect(rejections()[0].detail.op).toBe('growth_backfill');

        replies(JSON.stringify({ observations: [{ category: 'trait', claim: 'Acts unasked', quote: 'Mara quietly folds the sails before anyone asks.', msgIdx: 0 }] }));
        const result = await runIlsBackfillCapture('Mara');
        expect(requests[1].userContent).toBe(requests[0].userContent);
        expect(result.added).toBe(1);
        expect(getBackfillWatermark('Mara')).toBeGreaterThan(before ?? 0);
    });
});

describe('manual capture', () => {
    test('captureEvidence refuses a wrong-shape reply', async () => {
        replies(INVENTED);
        await expect(captureEvidence('Mara', 7)).rejects.toThrow(/^Wrong reply shape/);
        expect(rejections()[0].detail.op).toBe('growth_capture');
    });

    test('a first capture with an existing evidence file no longer seeds the cursor past unread messages', async () => {
        getEvidenceFile('Mara').enrolled = true;
        saveEvidenceMap();
        expect(hasEvidenceFile('Mara')).toBe(true);
        replies(INVENTED);
        await expect(runCaptureOnly('Mara')).rejects.toThrow(/^Wrong reply shape/);
        expect(getCaptureCursor('Mara')).toBeNull();
    });
});

// ─── Relationships: retried with the real reason ─────────────────────────────

describe('relationship extract', () => {
    // relationships.js asserts strict scope identity after the API call;
    // without a resolvable chat id every identity is "unknown" and the result
    // is discarded as "chat changed" before the shape is ever read.
    beforeEach(() => vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'chat-rel' }) }));

    test('invented keys are retried with the reason, and the retry applies', async () => {
        replies(
            JSON.stringify({ relationships: [{ from: 'Mara', to: 'Tam', type: 'ally' }] }),
            JSON.stringify({ edges: [{ from: 'Mara', to: 'Tam', type: 'ally', notes: 'share the watch' }], stances: [] }),
        );
        const result = await runRelationshipExtract();
        expect(requests).toHaveLength(2);
        expect(requests[0].userContent.endsWith(RELATIONSHIP_EXTRACT_RESPONSE.reminder)).toBe(true);
        expect(requests[1].userContent.endsWith(buildRetryReminder(
            'the response used the top-level key "relationships" instead of "edges" and "stances"', RELATIONSHIP_EXTRACT_RESPONSE,
        ))).toBe(true);
        expect(result.edgesAdded).toBe(1);
        expect(getNpcRelationships('Mara')).toEqual([expect.objectContaining({ target: 'Tam', type: 'ally' })]);
        expect(rejections()[0].detail).toMatchObject({ op: 'relationship_extract', attempt: 1, keys: ['relationships'] });
    });

    test('two wrong-shape replies fail loudly', async () => {
        replies(JSON.stringify({ relationships: [] }));
        await expect(runRelationshipExtract()).rejects.toThrow(/did not return the expected JSON after 2 attempts/);
        expect(requests).toHaveLength(2);
    });

    test('`{}` is still a one-call "nothing qualifies"', async () => {
        replies('{}');
        const result = await runRelationshipExtract();
        expect(requests).toHaveLength(1);
        expect(result.edgesAdded).toBe(0);
        expect(rejections()).toHaveLength(0);
    });
});
