/**
 * test/knowledge_cleanup_recovery.test.js — durable cleanup recovery storage
 * (knowledge/cleanup_recovery.js), Phase 3 of the Knowledge concision roadmap
 * (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md; decisions D1/D2 in
 * docs/KNOWLEDGE_CONCISION_DECISIONS.md).
 *
 * Pins the persistence contract the commit service depends on:
 *   - the container entry is created non-injecting and SELF-REPAIRING (flags
 *     re-asserted every write — the [MWT:store] entry's pattern);
 *   - every write is persist-and-verify: a save that throws, or a save whose
 *     result cannot be read back, FAILS CLOSED;
 *   - records survive reload (the fake books map is the disk), statuses
 *     validate, and a future-version container is refused untouched;
 *   - on-disk records this build cannot validate are never silently dropped
 *     by a module write;
 *   - export/import is a validated, current-wins round trip (D2/D3).
 */

import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _setCacheForTests, _clearCacheForTests } from '../knowledge/store.js';
import {
    CLEANUP_RECOVERY_SENTINEL, CLEANUP_RECOVERY_COMMENT,
    isCleanupRecoveryEntry,
    fingerprintContent,
    validateCleanupRecordShape,
    readCleanupRecoveryContainer,
    saveCleanupOriginal, updateCleanupRecord, getCleanupRecord,
    listCleanupRecovery, cleanupRecoveryUsage,
    deleteCleanupRecords, exportCleanupRecovery, importCleanupRecovery,
    CLEANUP_RECOVERY_EXPORT_TYPE,
} from '../knowledge/cleanup_recovery.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const BOOK = 'Knowledge Tracker';
const NPC = 'Mara Voss';

function makeRecord(actionId, overrides = {}) {
    return {
        actionId,
        createdAt: '2026-10-16T12:00:00.000Z',
        bookName: BOOK,
        scopeKey: 'scope-a',
        entityName: NPC,
        entityId: 'ent-1',
        entryUid: 7,
        actionType: 'ledger-condensation',
        status: 'original-saved',
        originalContent: 'original bytes',
        approvedReplacement: 'replacement bytes',
        replacementFingerprint: fingerprintContent('replacement bytes'),
        ...overrides,
    };
}

function makeFakeWorldInfo({ failSave = null, loseWrite = false } = {}) {
    const books = new Map();
    let saveCalls = 0;
    return {
        books,
        get saveCalls() { return saveCalls; },
        async loadWorldInfo(name) { return books.has(name) ? structuredClone(books.get(name)) : null; },
        async saveWorldInfo(name, wi, immediately = false) {
            saveCalls++;
            if (failSave && saveCalls === failSave) throw new Error('disk unavailable');
            // `loseWrite` simulates ST's debounced-write loss: the save
            // "succeeds" but the disk keeps its prior state.
            if (loseWrite || !immediately) return;
            books.set(name, structuredClone(wi));
        },
        async createNewWorldInfo(name) { books.set(name, { entries: {} }); return true; },
    };
}

function findContainer(wi) {
    return Object.values(wi?.entries || {}).find(isCleanupRecoveryEntry) || null;
}

let wiFake;

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveSettings({ scope: 'global', connectionProfileId: 'test-profile' });
    _setCacheForTests(BOOK, { registry: { [NPC]: { uid: 7, type: 'major', keywords: [NPC], info: { entityId: 'ent-1' } } } });
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    _clearCacheForTests();
    state.wiScript = null;
    vi.restoreAllMocks();
});

// ─── Container creation and structure ────────────────────────────────────────

describe('cleanup recovery container', () => {
    test('first save creates the sentinel entry, structurally non-injecting', async () => {
        await saveCleanupOriginal(makeRecord('act-1'));

        const wi = wiFake.books.get(BOOK);
        const entry = findContainer(wi);
        expect(entry).toBeTruthy();
        expect(entry.comment).toBe(CLEANUP_RECOVERY_COMMENT);
        // The four locks from D1 (the [MWT:store] entry's pattern).
        expect(entry.key).toEqual([]);
        expect(entry.keysecondary).toEqual([]);
        expect(entry.disable).toBe(true);
        expect(entry.enabled).toBe(false);
        expect(entry.constant).toBe(false);
        expect(entry.vectorized).toBe(false);
        expect(entry.excludeRecursion).toBe(true);
        expect(entry.preventRecursion).toBe(true);

        const record = await getCleanupRecord('act-1');
        expect(record.originalContent).toBe('original bytes');
        expect(record.status).toBe('original-saved');
    });

    test('a tampered entry is repaired on the next write (flags re-asserted)', async () => {
        await saveCleanupOriginal(makeRecord('act-1'));
        // Simulate a user/host edit flipping the entry live.
        const wi = wiFake.books.get(BOOK);
        const entry = findContainer(wi);
        entry.disable = false;
        entry.enabled = true;
        entry.constant = true;
        entry.vectorized = true;
        entry.key = ['everything'];

        await saveCleanupOriginal(makeRecord('act-2'));
        const repaired = findContainer(wiFake.books.get(BOOK));
        expect(repaired.constant).toBe(false);
        expect(repaired.vectorized).toBe(false);
        expect(repaired.disable).toBe(true);
        expect(repaired.enabled).toBe(false);
        expect(repaired.key).toEqual([]);
        // Both records survive the repair write.
        expect(await getCleanupRecord('act-1')).toBeTruthy();
        expect(await getCleanupRecord('act-2')).toBeTruthy();
    });

    test('records survive a reload: the books map is the disk', async () => {
        await saveCleanupOriginal(makeRecord('act-1'));
        // A brand-new read goes back through loadWorldInfo — no in-memory copy.
        const read = await readCleanupRecoveryContainer(BOOK);
        expect(read.ok).toBe(true);
        expect(Object.keys(read.records)).toEqual(['act-1']);
    });
});

// ─── Fail-closed persistence ─────────────────────────────────────────────────

describe('cleanup recovery persistence is fail-closed', () => {
    test('a save that throws rejects the whole operation — nothing half-written', async () => {
        wiFake = makeFakeWorldInfo({ failSave: 1 });
        state.wiScript = wiFake;
        await expect(saveCleanupOriginal(makeRecord('act-1'))).rejects.toThrow(/disk unavailable|verify/i);
        const wi = wiFake.books.get(BOOK);
        expect(findContainer(wi)).toBeNull();
    });

    test('a write that cannot be read back is a failure, not a success', async () => {
        // ST's classic silent loss: save "succeeds", the disk never changed.
        wiFake = makeFakeWorldInfo({ loseWrite: true });
        state.wiScript = wiFake;
        await expect(saveCleanupOriginal(makeRecord('act-1'))).rejects.toThrow(/verified/i);
    });

    test('an invalid record shape is refused before any disk write', async () => {
        await expect(saveCleanupOriginal(makeRecord('act-1', { status: 'bogus-status' })))
            .rejects.toThrow(/status/);
        expect(wiFake.saveCalls).toBe(0);
    });
});

// ─── Status transitions, listing, retention ──────────────────────────────────

describe('cleanup recovery records', () => {
    test('status transitions persist and validate', async () => {
        await saveCleanupOriginal(makeRecord('act-1'));
        await updateCleanupRecord('act-1', { status: 'application-pending' });
        expect((await getCleanupRecord('act-1')).status).toBe('application-pending');
        await updateCleanupRecord('act-1', { status: 'applied', appliedAt: '2026-10-16T12:05:00.000Z' });
        const applied = await getCleanupRecord('act-1');
        expect(applied.status).toBe('applied');
        expect(applied.appliedAt).toBe('2026-10-16T12:05:00.000Z');

        await expect(updateCleanupRecord('act-1', { status: 'not-a-status' })).rejects.toThrow(/invalidate/);
        await expect(updateCleanupRecord('missing-id', { status: 'applied' })).rejects.toThrow(/no record/);
    });

    test('listing sorts by creation and reports estimated sizes; usage sums them', async () => {
        await saveCleanupOriginal(makeRecord('act-1'));
        await saveCleanupOriginal(makeRecord('act-2', {
            createdAt: '2026-10-16T11:00:00.000Z',
            originalContent: 'x'.repeat(450),
        }));
        const listed = await listCleanupRecovery();
        expect(listed.ok).toBe(true);
        expect(listed.records.map(r => r.actionId)).toEqual(['act-2', 'act-1']);
        // Estimates: 450 chars → 100 tokens under the documented 4.5 heuristic.
        expect(listed.records.find(r => r.actionId === 'act-2').estimatedTokens).toBeGreaterThanOrEqual(100);

        const usage = await cleanupRecoveryUsage();
        expect(usage.ok).toBe(true);
        expect(usage.count).toBe(2);
        expect(usage.estimatedTokens).toBeGreaterThan(0);
    });

    test('invalid on-disk records are reported by the listing and preserved by writes', async () => {
        await saveCleanupOriginal(makeRecord('act-1'));
        // Hand-inject a record this build considers malformed.
        const wi = wiFake.books.get(BOOK);
        const entry = findContainer(wi);
        const parsed = JSON.parse(entry.content);
        parsed.records['act-broken'] = { actionId: 'act-broken', status: 'garbage' };
        entry.content = JSON.stringify(parsed);

        const listed = await listCleanupRecovery();
        expect(listed.records.map(r => r.actionId)).toEqual(['act-1']);
        expect(listed.issues).toEqual([{ actionId: 'act-broken', reason: expect.stringContaining('createdAt') }]);

        // A module write must NOT drop the broken record from disk.
        await saveCleanupOriginal(makeRecord('act-3'));
        const after = JSON.parse(findContainer(wiFake.books.get(BOOK)).content);
        expect(after.records['act-broken']).toEqual({ actionId: 'act-broken', status: 'garbage' });
        expect(after.records['act-3']).toBeTruthy();
    });

    test('explicit deletion removes only the named records (D2: no silent eviction)', async () => {
        await saveCleanupOriginal(makeRecord('act-1'));
        await saveCleanupOriginal(makeRecord('act-2'));
        const result = await deleteCleanupRecords(['act-1', 'nope']);
        expect(result.deleted).toEqual(['act-1']);
        expect(result.missing).toEqual(['nope']);
        expect(await getCleanupRecord('act-1')).toBeNull();
        expect(await getCleanupRecord('act-2')).toBeTruthy();
    });

    test('a future-version container is refused untouched — no downgrade, no rewrite', async () => {
        wiFake.books.set(BOOK, {
            entries: {
                99: { uid: 99, comment: CLEANUP_RECOVERY_SENTINEL, content: JSON.stringify({ version: 99, records: { x: {} } }) },
            },
        });
        const read = await readCleanupRecoveryContainer(BOOK);
        expect(read.ok).toBe(false);
        expect(read.reason).toBe('future-version');
        await expect(saveCleanupOriginal(makeRecord('act-1'))).rejects.toThrow(/future|newer|container unreadable/i);
        // The raw container was not rewritten.
        const entry = findContainer(wiFake.books.get(BOOK));
        expect(JSON.parse(entry.content).version).toBe(99);
    });
});

// ─── Export / import round trip ──────────────────────────────────────────────

describe('cleanup recovery export/import', () => {
    test('export → delete → import restores the records (validated, re-stamped)', async () => {
        await saveCleanupOriginal(makeRecord('act-1'));
        await saveCleanupOriginal(makeRecord('act-2'));
        const payload = await exportCleanupRecovery();
        expect(payload.type).toBe(CLEANUP_RECOVERY_EXPORT_TYPE);
        expect(Object.keys(payload.records).sort()).toEqual(['act-1', 'act-2']);

        await deleteCleanupRecords(['act-1', 'act-2']);
        expect((await listCleanupRecovery()).records).toEqual([]);

        const result = await importCleanupRecovery(payload);
        expect(result.added.sort()).toEqual(['act-1', 'act-2']);
        expect(await getCleanupRecord('act-1')).toEqual(makeRecord('act-1'));
    });

    test('current-wins on actionId collisions; invalid records rejected without partial writes', async () => {
        await saveCleanupOriginal(makeRecord('act-1', { originalContent: 'CURRENT' }));
        const payload = await exportCleanupRecovery();
        // The payload carries the older "original bytes" version of act-1.
        payload.records['act-1'].originalContent = 'OLDER';
        payload.records['act-bad'] = { nonsense: true };

        const result = await importCleanupRecovery(payload);
        expect(result.kept).toEqual(['act-1']);
        expect(result.added).toEqual([]);
        expect(result.rejected[0]).toContain('act-bad');
        expect((await getCleanupRecord('act-1')).originalContent).toBe('CURRENT');
    });

    test('non-recovery payloads reject whole', async () => {
        await expect(importCleanupRecovery({ type: 'something-else' })).rejects.toThrow(/not an MWT/i);
        await expect(importCleanupRecovery({ type: CLEANUP_RECOVERY_EXPORT_TYPE, version: 42, records: {} })).rejects.toThrow(/version/i);
    });
});

// ─── Fingerprint and shape helpers ───────────────────────────────────────────

describe('cleanup recovery helpers', () => {
    test('fingerprint is stable for identical bytes and differs for any change', () => {
        const a = fingerprintContent('same bytes');
        expect(fingerprintContent('same bytes')).toBe(a);
        expect(fingerprintContent('same bytes ')).not.toBe(a);
        expect(fingerprintContent('same bytеs')).not.toBe(a); // different char
    });

    test('record shape validation covers the D1 required bindings', () => {
        expect(validateCleanupRecordShape(makeRecord('x')).ok).toBe(true);
        for (const bad of [
            { entryUid: 'seven' }, { status: 'nope' }, { actionType: 'nope' },
            { originalContent: 42 }, { entityName: '' },
        ]) {
            expect(validateCleanupRecordShape(makeRecord('x', bad)).ok, JSON.stringify(bad)).toBe(false);
        }
        // Applied records must carry the approved replacement.
        expect(validateCleanupRecordShape(makeRecord('x', { status: 'applied', approvedReplacement: undefined })).ok).toBe(false);
    });
});
