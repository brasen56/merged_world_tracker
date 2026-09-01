/**
 * test/secondary_persistence.test.js — Part 7 of the schema validation plan
 * (SCHEMA_VALIDATION_MIGRATIONS_PLAN.md §2.2): the secondary MWT-owned
 * persistence gets validation coverage in the shared vocabulary.
 *
 *   - schema/secondary.js pure validators: float positions, kt_history
 *     records, and per-message mwt_uuid stamps;
 *   - the wiring at the seams: core/ui.js loadFloatPositions()/
 *     saveFloatPosition(), knowledge/lorebook.js getHistory()/pushHistory()
 *     (read-filter + converge-on-push), and interiority/data.js's UUID
 *     seams (malformed stamps are treated as absent / restamped).
 *
 * The policy pinned here is READ-SIDE REPAIR: validators return the
 * canonical live view, the stored raw value is left untouched (it is the
 * recovery copy), and no raw record is embedded in issues — history
 * content is user prose.
 */

import { describe, test, expect, beforeEach } from 'vitest';

import { resetCoreStubs, setFakeChat } from './stubs/core.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import {
    MESSAGE_UUID_EXTRA_KEY,
    SECONDARY_ISSUE_CODES,
    isValidMessageUuid,
    validateFloatPositions,
    validateHistoryRecords,
    validateMessageUuids,
} from '../schema/secondary.js';

const issueCodes = (issues) => issues.map((issue) => issue.code);

function freshStorage() {
    const data = {};
    globalThis.localStorage = {
        _data: data,
        getItem(key) { return key in data ? data[key] : null; },
        setItem(key, value) { data[key] = String(value); },
        removeItem(key) { delete data[key]; },
    };
    return globalThis.localStorage;
}

// ─── Pure validators ──────────────────────────────────────────────────────────

describe('validateFloatPositions (pure)', () => {
    test('valid entries pass through; invalid entries drop with findings', () => {
        const result = validateFloatPositions({
            'mwt-float-world': { left: 10, top: 20 },
            'mwt-float-bad': 'not-an-object',
            'mwt-float-nan': { left: '10', top: 20 },
            'mwt-float-infinite': { left: Infinity, top: 3 },
        });
        expect(result.data).toEqual({ 'mwt-float-world': { left: 10, top: 20 } });
        expect(result.dropped).toBe(3);
        expect(issueCodes(result.issues)).toEqual(Array(3).fill(SECONDARY_ISSUE_CODES.FLOAT_ENTRY_INVALID));
        expect(result.issues.every((issue) => issue.severity === 'quarantine')).toBe(true);
    });

    test('unknown button ids are retained with a reference finding, not dropped', () => {
        const result = validateFloatPositions(
            { 'mwt-float-ghost': { left: 1, top: 2 } },
            { allowedIds: ['mwt-float-world'] },
        );
        expect(result.data).toEqual({ 'mwt-float-ghost': { left: 1, top: 2 } });
        expect(result.dropped).toBe(0);
        expect(issueCodes(result.issues)).toEqual([SECONDARY_ISSUE_CODES.FLOAT_UNKNOWN_ID]);
        expect(result.issues[0].severity).toBe('reference');
    });

    test('a non-object root fails soft to an empty map', () => {
        for (const bad of ['[]', 5, null]) {
            const result = validateFloatPositions(bad);
            expect(result.data).toEqual({});
            expect(issueCodes(result.issues)).toEqual([SECONDARY_ISSUE_CODES.FLOAT_ROOT_NOT_OBJECT]);
        }
    });
});

describe('validateHistoryRecords (pure)', () => {
    test('valid records pass through with their shape preserved', () => {
        const result = validateHistoryRecords([
            { ts: 2, content: 'newest', msgIdx: 4 },
            { ts: 1, content: 'oldest' },
        ]);
        expect(result.data).toEqual([
            { ts: 2, content: 'newest', msgIdx: 4 },
            { ts: 1, content: 'oldest' },
        ]);
        expect(result.issues).toEqual([]);
    });

    test('malformed records are filtered with findings and no prose embedded', () => {
        const result = validateHistoryRecords([
            { ts: 1, content: 'fine', msgIdx: 0 },
            'garbage',
            { ts: 'not-a-number', content: 'bad ts' },
            { ts: 3, content: 42 },
            { ts: 4, content: 'bad idx', msgIdx: -1 },
        ]);
        expect(result.data).toEqual([{ ts: 1, content: 'fine', msgIdx: 0 }]);
        expect(issueCodes(result.issues)).toEqual(Array(4).fill(SECONDARY_ISSUE_CODES.HISTORY_RECORD_INVALID));
        // Content discipline: no record is embedded — identity is the index.
        expect(JSON.stringify(result.issues)).not.toContain('bad ts');
        expect(result.issues.every((issue) => issue.record === undefined)).toBe(true);
    });

    test('a non-array root fails soft to an empty list', () => {
        const result = validateHistoryRecords({ 0: 'nope' });
        expect(result.data).toEqual([]);
        expect(issueCodes(result.issues)).toEqual([SECONDARY_ISSUE_CODES.HISTORY_ROOT_NOT_ARRAY]);
    });
});

describe('validateMessageUuids / isValidMessageUuid (pure)', () => {
    test('the predicate accepts only non-empty strings', () => {
        expect(isValidMessageUuid('abc-123')).toBe(true);
        expect(isValidMessageUuid('')).toBe(false);
        expect(isValidMessageUuid('   ')).toBe(false);
        expect(isValidMessageUuid(123)).toBe(false);
        expect(isValidMessageUuid(null)).toBe(false);
        expect(isValidMessageUuid(undefined)).toBe(false);
    });

    test('counts unique valid stamps and reports malformed + duplicate ones', () => {
        const chat = [
            { mes: 'a', extra: { [MESSAGE_UUID_EXTRA_KEY]: 'uuid-1' } },
            { mes: 'b', extra: {} },                                  // unstamped: ignored
            { mes: 'c', extra: { [MESSAGE_UUID_EXTRA_KEY]: 123 } },    // malformed
            { mes: 'd', extra: { [MESSAGE_UUID_EXTRA_KEY]: 'uuid-1' } }, // duplicate
            { mes: 'e', extra: { [MESSAGE_UUID_EXTRA_KEY]: 'uuid-2' } },
        ];
        const result = validateMessageUuids(chat);
        expect(result.stamped).toBe(3);
        expect(issueCodes(result.issues)).toEqual([
            SECONDARY_ISSUE_CODES.MSG_UUID_INVALID,
            SECONDARY_ISSUE_CODES.MSG_UUID_DUPLICATE,
        ]);
        expect(result.issues[1].identity).toBe('uuid-1');
        expect(result.issues[1].path).toEqual(['0', '3']);
    });

    test('a non-array chat reads as zero stamps', () => {
        expect(validateMessageUuids(null)).toEqual({ issues: [], stamped: 0 });
        expect(validateMessageUuids('chat')).toEqual({ issues: [], stamped: 0 });
    });
});

// ─── Wiring: core/ui.js float positions ───────────────────────────────────────

describe('float-position wiring (core/ui.js)', () => {
    let storage;

    beforeEach(() => {
        storage = freshStorage();
        _resetDiagnostics();
    });

    test('loads the validated live view and reports the finding once', async () => {
        const { loadFloatPositions } = await import('../core/ui.js');
        storage._data.mwt_float_positions = JSON.stringify({
            'mwt-float-world': { left: 10, top: 20 },
            'mwt-float-chronicle': 'corrupt',
        });
        expect(loadFloatPositions()).toEqual({ 'mwt-float-world': { left: 10, top: 20 } });
        // The stored raw value is the recovery copy — untouched by the read.
        expect(JSON.parse(storage._data.mwt_float_positions)['mwt-float-chronicle']).toBe('corrupt');
        const quarantined = getEvents().filter((event) => event.event === 'schema_quarantined');
        expect(quarantined).toHaveLength(1);
        expect(quarantined[0].detail).toMatchObject({ store: 'mwt_float_positions' });
    });

    test('a missing key is silent; an unparseable or non-object key reports the root finding once', async () => {
        const { loadFloatPositions } = await import('../core/ui.js');
        // Nothing stored is not a finding — there is simply nothing to read.
        expect(loadFloatPositions()).toEqual({});
        expect(getEvents().filter((e) => e.detail?.store === 'mwt_float_positions')).toHaveLength(0);
        // An unparseable record (truncated quota write) reads as the FATAL
        // root result: an empty live view, with the finding surfaced — the
        // same promise settings and Knowledge edit-history already make.
        storage._data.mwt_float_positions = 'not-json';
        expect(loadFloatPositions()).toEqual({});
        // The stored raw value is the recovery copy — untouched by the read.
        expect(storage._data.mwt_float_positions).toBe('not-json');
        const root = getEvents().filter((e) => e.detail?.code === SECONDARY_ISSUE_CODES.FLOAT_ROOT_NOT_OBJECT);
        expect(root).toHaveLength(1);
        expect(root[0].event).toBe('schema_quarantined');
        expect(root[0].detail).toMatchObject({ store: 'mwt_float_positions' });
        // Once per code per session — and a stored non-object root shares the
        // code, so it cannot re-report either.
        expect(loadFloatPositions()).toEqual({});
        storage._data.mwt_float_positions = JSON.stringify('also-bad');
        expect(loadFloatPositions()).toEqual({});
        expect(getEvents().filter((e) => e.detail?.code === SECONDARY_ISSUE_CODES.FLOAT_ROOT_NOT_OBJECT)).toHaveLength(1);
    });

    test('a drag rewrite converges the key: dropped entries stay dropped', async () => {
        const { loadFloatPositions, saveFloatPosition } = await import('../core/ui.js');
        storage._data.mwt_float_positions = JSON.stringify({
            'mwt-float-world': { left: 10, top: 20 },
            'mwt-float-chronicle': 'corrupt',
        });
        saveFloatPosition('mwt-float-world', 30, 40);
        expect(JSON.parse(storage._data.mwt_float_positions)).toEqual({
            'mwt-float-world': { left: 30, top: 40 },
        });
        expect(loadFloatPositions()).toEqual({ 'mwt-float-world': { left: 30, top: 40 } });
    });

    // The event follows the finding's SEVERITY (schemaEventForSeverity). An
    // unknown-button-id entry is REFERENCE: retained, not removed — so logging
    // it as schema_quarantined would tell the user data was set aside for
    // recovery when nothing was. This test owns the FLOAT_UNKNOWN_ID code for
    // the file (the dedup Set in core/ui.js is module-level and never reset).
    test('an unknown-button-id entry is retained and reported as a repair, not a quarantine', async () => {
        const { loadFloatPositions } = await import('../core/ui.js');
        storage._data.mwt_float_positions = JSON.stringify({
            'mwt-float-world': { left: 10, top: 20 },
            'mwt-float-retired': { left: 30, top: 40 },
        });
        // Retained — dropping it would lose a position the user set.
        expect(loadFloatPositions()).toEqual({
            'mwt-float-world': { left: 10, top: 20 },
            'mwt-float-retired': { left: 30, top: 40 },
        });
        const unknown = getEvents().filter((event) => event.detail?.code === SECONDARY_ISSUE_CODES.FLOAT_UNKNOWN_ID);
        expect(unknown).toHaveLength(1);
        expect(unknown[0].event).toBe('schema_repaired');
        expect(unknown[0].detail).toMatchObject({ store: 'mwt_float_positions' });
        // Nothing was removed, so nothing may be reported as quarantined.
        expect(getEvents().some((event) => event.event === 'schema_quarantined')).toBe(false);
    });
});

// ─── Wiring: knowledge/lorebook.js edit history ───────────────────────────────

describe('kt_history wiring (knowledge/lorebook.js)', () => {
    const KEY = 'kt_history_Knowledge Tracker_7';

    beforeEach(() => {
        resetCoreStubs();
        freshStorage();
        _resetDiagnostics();
    });

    // NOTE: this event test runs FIRST in the describe on purpose — the
    // module-level once-per-code dedup in lorebook.js is not reset between
    // tests, so any earlier test touching the same codes would consume them.
    test('findings surface as schema_quarantined once per code (§9.3)', async () => {
        const { getHistory } = await import('../knowledge/lorebook.js');
        globalThis.localStorage._data[KEY] = JSON.stringify([
            'garbage',
            { ts: 1, content: 'valid old content', msgIdx: 3 },
        ]);
        expect(getHistory(7, 'Knowledge Tracker')).toEqual([{ ts: 1, content: 'valid old content', msgIdx: 3 }]);
        // Second read of the same corruption: deduplicated, not re-reported.
        expect(getHistory(7, 'Knowledge Tracker')).toEqual([{ ts: 1, content: 'valid old content', msgIdx: 3 }]);
        let quarantined = getEvents().filter((event) => event.event === 'schema_quarantined');
        expect(quarantined).toHaveLength(1);
        expect(quarantined[0].detail).toMatchObject({
            store: KEY,
            code: SECONDARY_ISSUE_CODES.HISTORY_RECORD_INVALID,
        });
        // An unparseable record reports its own root code once and reads empty.
        // (getEvents() is newest-first, so the root event is now index 0.)
        globalThis.localStorage._data[KEY] = '{"truncated';
        expect(getHistory(7, 'Knowledge Tracker')).toEqual([]);
        quarantined = getEvents().filter((event) => event.event === 'schema_quarantined');
        expect(quarantined).toHaveLength(2);
        expect(quarantined[0].detail.code).toBe(SECONDARY_ISSUE_CODES.HISTORY_ROOT_NOT_ARRAY);
        expect(quarantined[1].detail.code).toBe(SECONDARY_ISSUE_CODES.HISTORY_RECORD_INVALID);
    });

    // Regression: the dedup key must include the STORE, not just the code.
    // History keys are namespaced per book AND per uid, so deduping on the
    // code alone let the first malformed record silence every other corrupted
    // key for the whole session — which is the reporting gap the Part 7
    // wiring was added to close. Uses FRESH keys, so it is order-independent.
    test('a second corrupted history key still reports (dedup is per key + code)', async () => {
        const { getHistory } = await import('../knowledge/lorebook.js');
        const KEY_A = 'kt_history_Knowledge Tracker_21';
        const KEY_B = 'kt_history_State Tracker_21';
        globalThis.localStorage._data[KEY_A] = JSON.stringify(['garbage']);
        globalThis.localStorage._data[KEY_B] = JSON.stringify(['garbage']);
        expect(getHistory(21, 'Knowledge Tracker')).toEqual([]);
        expect(getHistory(21, 'State Tracker')).toEqual([]);

        const invalid = () => getEvents().filter(
            (event) => event.detail?.code === SECONDARY_ISSUE_CODES.HISTORY_RECORD_INVALID,
        );
        expect(invalid()).toHaveLength(2);
        expect(new Set(invalid().map((event) => event.detail.store))).toEqual(new Set([KEY_A, KEY_B]));

        // Re-reading either key is still deduplicated — the ring is not flooded.
        getHistory(21, 'Knowledge Tracker');
        getHistory(21, 'State Tracker');
        expect(invalid()).toHaveLength(2);
    });

    test('reads filter malformed records without touching the stored key', async () => {
        const { getHistory } = await import('../knowledge/lorebook.js');
        const stored = [
            { ts: 1, content: 'valid old content', msgIdx: 3 },
            'garbage',
            { ts: 'bad', content: 'bad ts' },
        ];
        globalThis.localStorage._data[KEY] = JSON.stringify(stored);
        expect(getHistory(7, 'Knowledge Tracker')).toEqual([
            { ts: 1, content: 'valid old content', msgIdx: 3 },
        ]);
        // The stored key is the recovery copy — unchanged by the read.
        expect(JSON.parse(globalThis.localStorage._data[KEY])).toEqual(stored);
        expect(getHistory(8, 'Knowledge Tracker')).toEqual([]);
    });

    test('a push converges the key: malformed records stop being copied forward', async () => {
        const { pushHistory, getHistory } = await import('../knowledge/lorebook.js');
        globalThis.localStorage._data[KEY] = JSON.stringify([
            'garbage',
            { ts: 1, content: 'valid old content', msgIdx: 3 },
        ]);
        pushHistory(7, 'fresh edit', 'Knowledge Tracker');
        const stored = JSON.parse(globalThis.localStorage._data[KEY]);
        expect(stored).toHaveLength(2);
        expect(stored[0].content).toBe('fresh edit');
        expect(stored[0].msgIdx).toBe(0); // empty fake chat
        expect(stored[1]).toEqual({ ts: 1, content: 'valid old content', msgIdx: 3 });
        expect(getHistory(7, 'Knowledge Tracker')).toEqual(stored);
    });

    test('a corrupt non-array key reads as empty history and heals on push', async () => {
        const { getHistory, pushHistory } = await import('../knowledge/lorebook.js');
        globalThis.localStorage._data[KEY] = JSON.stringify({ not: 'an array' });
        expect(getHistory(7, 'Knowledge Tracker')).toEqual([]);
        pushHistory(7, 'first good record', 'Knowledge Tracker');
        expect(JSON.parse(globalThis.localStorage._data[KEY])).toHaveLength(1);
    });
});

// ─── Wiring: interiority/data.js message-UUID seams ───────────────────────────

describe('mwt_uuid seam wiring (interiority/data.js)', () => {
    beforeEach(() => {
        resetCoreStubs();
        freshStorage();
        _resetDiagnostics();
    });

    test('a duplicate stamp is restamped on the later message and reported once', async () => {
        const { getMsgKeyForIndex, getOrCreateMsgKeyForIndex } = await import('../interiority/data.js');
        setFakeChat([
            { mes: 'owner', send_date: 'd1', extra: { mwt_uuid: 'shared' } },
            { mes: 'duplicate', send_date: 'd2', extra: { mwt_uuid: 'shared' } },
        ]);
        // Reads refuse to alias: only the FIRST owner is addressed by mu-shared;
        // the later duplicate falls back to send_date until it is restamped.
        expect(getMsgKeyForIndex(0)).toBe('mu-shared');
        expect(getMsgKeyForIndex(1)).toBe('sd-d2');
        // The write seam keeps the owner's stamp…
        expect(getOrCreateMsgKeyForIndex(0)).toBe('mu-shared');
        // …and restamps the later duplicate with a fresh UUID.
        const key = getOrCreateMsgKeyForIndex(1);
        expect(key).toMatch(/^mu-/);
        expect(key).not.toBe('mu-shared');
        const chat = (await import('./stubs/core.js')).getFakeChat?.() ?? null;
        expect(chat?.[1]?.extra?.[MESSAGE_UUID_EXTRA_KEY]).toBe(key.slice('mu-'.length));
        // Both messages now read back their own, distinct keys.
        expect(getMsgKeyForIndex(0)).toBe('mu-shared');
        expect(getMsgKeyForIndex(1)).toBe(key);
        // The repair surfaced exactly once (§9.3).
        const repaired = getEvents().filter((event) => event.event === 'schema_repaired');
        expect(repaired).toHaveLength(1);
        expect(repaired[0].detail).toMatchObject({ code: SECONDARY_ISSUE_CODES.MSG_UUID_DUPLICATE });
    });

    test('buildKeyToIndexMap maps a duplicate stamp to its first owner only', async () => {
        const { buildKeyToIndexMap } = await import('../interiority/data.js');
        setFakeChat([
            { mes: 'owner', send_date: 'd1', extra: { mwt_uuid: 'shared' } },
            { mes: 'duplicate', send_date: 'd2', extra: { mwt_uuid: 'shared' } },
        ]);
        const map = buildKeyToIndexMap();
        // First occurrence wins for the mu-* key…
        expect(map.get('mu-shared')).toBe(0);
        expect(map.get('sd-d1')).toBe(0);
        // …the later duplicate still resolves via its send_date.
        expect(map.get('sd-d2')).toBe(1);
    });

    test('a malformed stamp is treated as absent: read falls back, write restamps', async () => {
        const { getMsgKeyForIndex, getOrCreateMsgKeyForIndex } = await import('../interiority/data.js');
        setFakeChat([
            { mes: 'corrupt stamp', send_date: '2026-01-01', extra: { mwt_uuid: 123 } },
        ]);
        // Read-only path: refuses to trust the malformed stamp, falls back.
        expect(getMsgKeyForIndex(0)).toBe('sd-2026-01-01');
        // Canonical key-creation path: restamps over the malformed value.
        const key = getOrCreateMsgKeyForIndex(0);
        expect(key).toMatch(/^mu-/);
        const chat = (await import('./stubs/core.js')).getFakeChat?.() ?? null;
        const stampedValue = chat?.[0]?.extra?.[MESSAGE_UUID_EXTRA_KEY];
        expect(typeof stampedValue).toBe('string');
        expect(key).toBe(`mu-${stampedValue}`);
        // And the read path now trusts the restamp.
        expect(getMsgKeyForIndex(0)).toBe(key);
    });

    test('buildKeyToIndexMap never maps a malformed stamp', async () => {
        const { buildKeyToIndexMap } = await import('../interiority/data.js');
        setFakeChat([
            { mes: 'ok', send_date: 'd1', extra: { mwt_uuid: 'good-uuid' } },
            { mes: 'bad', send_date: 'd2', extra: { mwt_uuid: 42 } },
        ]);
        const map = buildKeyToIndexMap();
        expect(map.get('mu-good-uuid')).toBe(0);
        expect(map.has('mu-42')).toBe(false);
        // The legacy send_date fallback still resolves the bad-stamp message.
        expect(map.get('sd-d2')).toBe(1);
    });
});
