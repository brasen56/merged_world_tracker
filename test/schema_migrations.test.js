/**
 * Part 2 tests — version manifest, migrations, and quarantine dry runs
 * (delivery slice §11 "Part 2" of
 * upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md).
 *
 * Acceptance being pinned here:
 *   - every authoritative store's real legacy shapes dry-run migrate through
 *     prepareStore() WITHOUT touching live state (pure descriptors only);
 *   - migrations are idempotent — the migrated result re-validates clean;
 *   - rejected records land in the proposed quarantine result, recoverable;
 *   - the mwt_schema_manifest container schema reads/stamps versions;
 *   - the mwt_schema_quarantine container validates and exports/imports;
 *   - every store declares a structured issue policy and never emits an
 *     undeclared code.
 */
import { describe, test, expect } from 'vitest';
import {
    POLICY_CATEGORIES,
    defineIssuePolicy,
    getPolicyCategory,
    prepareStore,
} from '../core/schema.js';
import {
    QUARANTINE_EXPORT_KIND,
    QUARANTINE_SCHEMA_VERSION,
    exportQuarantineData,
    fingerprintValue,
    importQuarantineItems,
    makeQuarantineItem,
    validateQuarantineStoreData,
} from '../core/quarantine.js';
import {
    MANIFEST_METADATA_KEY,
    MANIFEST_VERSION,
    createSchemaManifest,
    getStoredStoreVersion,
    normalizeManifest,
    stampStoreVersion,
    validateManifestData,
} from '../schema/manifest.js';
import { SCHEMA_STORE_IDS, STORE_SCHEMAS } from '../schema/registry.js';
import { backfillSnapshotIds } from '../chronicle/schema.js';

// ─── Real-world legacy fixtures (one per store) ──────────────────────────────
//
// These are the shapes pre-manifest chats actually have on disk: no version
// marker anywhere, containers possibly missing, ids backfilled on read,
// plans still stored as one text blob, receipt logs written before the tuple
// contract existed.

const LEGACY_FIXTURES = {
    worldState: {
        text: 'The harbor gates stay shut after dark.',
        autoSaveHistory: [{ text: 'Earlier state.', timestamp: 1756100000000 }],
        provenance: { schemaVersion: 1 },
    },
    chronicle: {
        // Legacy writes: a snapshot with no id at all, one with a numeric id,
        // and one already fine.
        snapshots: [
            { text: 'No id yet.' },
            { id: 42, text: 'Numeric id.' },
            { id: 'ok', text: 'Fine already.' },
        ],
    },
    knowledgeEvidence: {
        Mara: { npc: 'Mara', raw: [{ id: 'r1', claim: 'Guards the gate.', quote: '"Nobody passes."' }] },
    },
    knowledgeCounters: {
        messageCounter: 7,
        countedReceiptEvents: [
            // The REAL persisted shape (knowledge/index.js persistCounters):
            // [messageKey, cadenceCountsObject] — not an integer count.
            ['id:reply', { npc: 1, growth: 0 }],
            ['bad-tuple'],
            ['id:reply', { state: 1 }],   // duplicate key: later entry must win
            null,
            ['mu-b', 3],                  // integer shape Knowledge never wrote
        ],
    },
    storyPlanner: {
        text: '## Immediate Hooks\n- Gate guard bribe — A coin opens the harbor gate\n  1. Find a coin\n  2. Return at dusk',
    },
    interiority: {
        enabled: true,
        ledger: [{ id: 'i1', npc: 'Mara', action: 'wait', trigger: 'dawn' }],
        perMessage: { 'mu-abc': { generatedAt: 1 } },
    },
    knowledgeStore: {
        registry: { Mara: { uid: 3 } },
        relationships: {},
    },
};

/** Run one store's full v0 preparation (the dry run). */
function dryRun(id, input) {
    return prepareStore(STORE_SCHEMAS[id], input);
}

// ─── Manifest ────────────────────────────────────────────────────────────────

describe('mwt_schema_manifest container (design §3.3)', () => {
    test('pins the metadata key and version', () => {
        expect(MANIFEST_METADATA_KEY).toBe('mwt_schema_manifest');
        expect(MANIFEST_VERSION).toBe(1);
    });

    test('a missing or unreadable section reads as legacy version 0', () => {
        expect(getStoredStoreVersion(createSchemaManifest(), 'chronicle')).toBe(0);
        expect(getStoredStoreVersion(undefined, 'chronicle')).toBe(0);
        expect(getStoredStoreVersion({ sections: { chronicle: 'garbage' } }, 'chronicle')).toBe(0);
    });

    test('stamp then read round-trips; unknown sections survive; input stays untouched', () => {
        const original = { manifestVersion: 1, sections: { chronicle: 1, futureStore: 9 } };
        const snapshot = JSON.stringify(original);
        const stamped = stampStoreVersion(original, 'worldState', 1);
        expect(stamped.sections.worldState).toBe(1);
        expect(stamped.sections.chronicle).toBe(1);
        // A downgrade must not destroy a newer release's markers.
        expect(stamped.sections.futureStore).toBe(9);
        expect(JSON.stringify(original)).toBe(snapshot);
    });

    test('stamping rejects malformed arguments loudly', () => {
        expect(() => stampStoreVersion({}, '', 1)).toThrow(TypeError);
        expect(() => stampStoreVersion({}, 'chronicle', 0)).toThrow(TypeError);
        expect(() => stampStoreVersion({}, 'chronicle', 1.5)).toThrow(TypeError);
    });

    test('validateManifestData canonicalizes and quarantines bad entries', () => {
        const result = validateManifestData({
            manifestVersion: 1,
            sections: { chronicle: 1, worldState: 'x', broken: 0 },
        });
        expect(result.data).toEqual({ manifestVersion: 1, sections: { chronicle: 1 } });
        expect(result.stats.added).toBe(1);
        expect(result.issues.map(issue => issue.code)).toEqual(['section-version-invalid', 'section-version-invalid']);
        expect(result.issues[0].severity).toBe('quarantine');
        // The complete raw value is recoverable from `record`; the section id
        // rides separately as the display identity.
        expect(result.issues[0].record).toBe('x');
        expect(result.issues[0].identity).toBe('worldState');
    });

    test('garbage converges on the canonical empty manifest', () => {
        expect(normalizeManifest(null)).toEqual({ manifestVersion: 1, sections: {} });
        expect(normalizeManifest('junk')).toEqual({ manifestVersion: 1, sections: {} });
        const result = validateManifestData('junk');
        expect(result.data).toEqual(createSchemaManifest());
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].code).toBe('root-not-object');
    });

    test('future manifests are refused unchanged — never downgraded or re-stamped', () => {
        const future = { manifestVersion: 2, sections: { chronicle: 1 }, extraTopLevel: 'newer-release-data' };
        // normalizeManifest refuses a future container instead of rewriting it.
        expect(normalizeManifest(future)).toBe(future);
        // Stamping onto it would silently downgrade it — an authoring bug.
        expect(() => stampStoreVersion(future, 'worldState', 1)).toThrow(/newer MWT/);
        expect(future).toEqual({ manifestVersion: 2, sections: { chronicle: 1 }, extraTopLevel: 'newer-release-data' });
        // Section markers are still read defensively.
        expect(getStoredStoreVersion(future, 'chronicle')).toBe(1);
        expect(getStoredStoreVersion(future, 'worldState')).toBe(0);
        // Validation reports a fatal finding and returns the ORIGINAL value as
        // data, so a caller that misses the finding cannot persist an empty
        // manifest over the newer release's container.
        const result = validateManifestData(future);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].code).toBe('manifest-version-future');
        expect(result.issues[0].severity).toBe('fatal');
        expect(result.data).toBe(future);
    });
});

// ─── Quarantine container + export/import ────────────────────────────────────

describe('mwt_schema_quarantine container and recovery export/import (design §5)', () => {
    const goodItem = makeQuarantineItem({
        store: 'chronicle',
        path: ['snapshots', 0],
        reasonCode: 'snapshot-missing-id',
        message: 'Snapshot id must be a non-empty string.',
        raw: { text: 'lost' },
    });

    test('validateQuarantineStoreData canonicalizes and reports malformed items', () => {
        const result = validateQuarantineStoreData({
            version: 1,
            items: [goodItem, 'junk', { store: '', reasonCode: 'x' }],
        });
        expect(result.data.items).toHaveLength(1);
        expect(result.stats.added).toBe(1);
        expect(result.issues.map(issue => issue.code))
            .toEqual(['item-not-object', 'item-missing-fields']);
    });

    test('export → import round-trips items and deduplicates repeats', () => {
        const payload = exportQuarantineData([goodItem, goodItem], { exportedAt: 1234 });
        expect(payload.kind).toBe(QUARANTINE_EXPORT_KIND);
        expect(payload.version).toBe(1);
        expect(payload.exportedAt).toBe(1234);
        expect(payload.items).toHaveLength(1);

        const imported = importQuarantineItems(payload);
        expect(imported.issues).toEqual([]);
        expect(imported.items).toEqual([goodItem]);
    });

    test('foreign kinds and future versions are refused untouched', () => {
        const wrongKind = importQuarantineItems({ kind: 'something-else', version: 1, items: [goodItem] });
        expect(wrongKind.items).toEqual([]);
        expect(wrongKind.issues[0].code).toBe('unknown-kind');

        const future = importQuarantineItems({ kind: QUARANTINE_EXPORT_KIND, version: 99, items: [goodItem] });
        expect(future.items).toEqual([]);
        expect(future.issues[0].code).toBe('future-version');

        const notAnObject = importQuarantineItems('junk');
        expect(notAnObject.items).toEqual([]);
        expect(notAnObject.issues[0].code).toBe('root-not-object');
    });

    test('imports keep usable items even when siblings are malformed', () => {
        const imported = importQuarantineItems({
            kind: QUARANTINE_EXPORT_KIND,
            version: 1,
            items: [goodItem, 42],
        });
        expect(imported.items).toEqual([goodItem]);
        expect(imported.issues.map(issue => issue.code)).toEqual(['item-not-object']);
    });

    test('future container versions are refused unchanged, never re-stamped', () => {
        const future = { version: 99, items: [goodItem] };
        const result = validateQuarantineStoreData(future);
        expect(result.issues.map(issue => [issue.code, issue.severity])).toEqual([['future-version', 'fatal']]);
        // The original container comes back untouched — not rewritten as
        // version 1, so nothing a newer release recorded is discarded.
        expect(result.data).toBe(future);
        expect(result.data.version).toBe(99);
        expect(result.stats.added).toBe(0);

        // Garbage versions (non-integer / non-number) are not future markers:
        // they still converge on the canonical container like any garbage.
        const garbage = validateQuarantineStoreData({ version: 'x', items: [goodItem] });
        expect(garbage.data.version).toBe(QUARANTINE_SCHEMA_VERSION);
        expect(garbage.issues).toEqual([]);
        expect(garbage.data.items).toEqual([goodItem]);
    });

    test('items without a raw record or message are refused as unrecoverable', () => {
        // { store, reasonCode } alone reconstructs nothing and dedupes on a
        // fingerprint it does not carry — it cannot enter a container.
        const hollow = { store: 'chronicle', reasonCode: 'snapshot-missing-id' };
        const container = validateQuarantineStoreData({ version: 1, items: [goodItem, hollow] });
        expect(container.data.items).toEqual([goodItem]);
        expect(container.stats.added).toBe(1);
        // §5.2 applies to quarantine's own records: the finding carries the
        // COMPLETE rejected item so a recovery export can reconstruct it, with
        // the display identity (id, or the index when there is no id) separate
        // so summaries print an identifier rather than the raw payload.
        expect(container.issues.map(issue => [issue.code, issue.record, issue.identity]))
            .toEqual([['item-unrecoverable', hollow, 1]]);

        const imported = importQuarantineItems({ kind: QUARANTINE_EXPORT_KIND, version: 1, items: [hollow, 42] });
        expect(imported.items).toEqual([]);
        expect(imported.issues.map(issue => issue.code)).toEqual(['item-unrecoverable', 'item-not-object']);
    });

    test('exports carrying incomplete objects import as refused, not as recovery data', () => {
        const payload = exportQuarantineData([{ store: 'chronicle', reasonCode: 'x' }, goodItem]);
        expect(payload.items).toHaveLength(2);
        const imported = importQuarantineItems(payload);
        expect(imported.items).toEqual([goodItem]);
        expect(imported.issues.map(issue => issue.code)).toEqual(['item-unrecoverable']);
    });

    test('derivable fields are canonicalized instead of demanded', () => {
        // No fingerprint/id/path/detectedAt/sourceVersion: every one of them is
        // safely derivable or defaultable, so the minimal recovery shape
        // (store, reasonCode, message, raw) imports as a complete item.
        const imported = importQuarantineItems({
            kind: QUARANTINE_EXPORT_KIND,
            version: 1,
            items: [{ store: 'chronicle', reasonCode: 'snapshot-missing-id', message: 'm', raw: { id: 1 } }],
        });
        expect(imported.issues).toEqual([]);
        const print = fingerprintValue({ id: 1 });
        expect(imported.items).toEqual([{
            id: `chronicle:${print}`,
            store: 'chronicle',
            path: [],
            reasonCode: 'snapshot-missing-id',
            message: 'm',
            raw: { id: 1 },
            detectedAt: expect.any(Number),
            sourceVersion: null,
            fingerprint: print,
        }]);

        // An id that disagrees with the stored fingerprint is re-derived as
        // store:fingerprint, so (store, fingerprint) dedup stays reliable.
        const again = importQuarantineItems({
            kind: QUARANTINE_EXPORT_KIND,
            version: 1,
            items: [{ ...imported.items[0], id: 'lies:about:identity' }],
        });
        expect(again.items[0].id).toBe(`chronicle:${print}`);
    });

    test('forged fingerprints cannot collide distinct raw records', () => {
        // Two DIFFERENT raw records carrying the same hand-edited fingerprint
        // and id: the canonical fingerprint must be recomputed from `raw`, or
        // mergeQuarantineItems() would silently discard the second record as
        // a duplicate of the first — losing recovery data to a forged field.
        const forged = 'deadbeef';
        const a = { ...goodItem, raw: { id: 'a' }, fingerprint: forged, id: `chronicle:${forged}` };
        const b = { ...goodItem, raw: { id: 'b' }, fingerprint: forged, id: `chronicle:${forged}` };

        const imported = importQuarantineItems({ kind: QUARANTINE_EXPORT_KIND, version: 1, items: [a, b] });
        expect(imported.items).toHaveLength(2);
        expect(imported.items.map(item => item.raw.id)).toEqual(['a', 'b']);
        expect(imported.items.map(item => item.fingerprint)).toEqual([
            fingerprintValue({ id: 'a' }),
            fingerprintValue({ id: 'b' }),
        ]);
        // The recomputed prints separate the ids too.
        expect(new Set(imported.items.map(item => item.id)).size).toBe(2);
        // Each disagreeing supplied fingerprint is reported — as a repair, not
        // a rejection: the items themselves survive with raw intact.
        expect(imported.issues.map(issue => issue.code)).toEqual(['fingerprint-mismatch', 'fingerprint-mismatch']);

        // Same guardrail through the persisted-container validator.
        const container = validateQuarantineStoreData({ version: 1, items: [a, b] });
        expect(container.data.items).toHaveLength(2);
        expect(container.stats.added).toBe(2);
        expect(container.issues.map(issue => [issue.code, issue.severity])).toEqual([
            ['fingerprint-mismatch', 'repair'],
            ['fingerprint-mismatch', 'repair'],
        ]);

        // A MATCHING supplied fingerprint is not a finding — the factory's own
        // prints round-trip silently.
        const clean = makeQuarantineItem({ store: 'chronicle', reasonCode: 'x', message: 'm', raw: { id: 'c' } });
        const roundTrip = importQuarantineItems({ kind: QUARANTINE_EXPORT_KIND, version: 1, items: [clean] });
        expect(roundTrip.issues).toEqual([]);
        expect(roundTrip.items).toEqual([clean]);
    });
});

// ─── Per-store v0 -> v1 dry runs ─────────────────────────────────────────────

describe('Part 2 migrations — every legacy fixture migrates without touching live state', () => {
    test('worldState: absent fields default; invalid values go to quarantine instead', () => {
        const result = dryRun('worldState', LEGACY_FIXTURES.worldState);
        expect(result.status).toBe('migrated');
        expect(result.toVersion).toBe(1);
        expect(result.quarantined).toEqual([]);

        const damaged = dryRun('worldState', { text: 5 });
        expect(damaged.status).toBe('migrated'); // record-level finding, not fatal
        expect(damaged.data.text).toBeUndefined();
        expect(damaged.data.autoSaveHistory).toEqual([]);
        expect(damaged.quarantined[0]).toMatchObject({
            store: 'worldState',
            reasonCode: 'text-not-string',
            raw: 5,
        });
    });

    test('chronicle: legacy ids backfill deterministically; containers default', () => {
        const result = dryRun('chronicle', LEGACY_FIXTURES.chronicle);
        expect(result.status).toBe('migrated');
        const [noId, numeric, fine] = result.data.snapshots;
        expect(noId.id).toMatch(/^legacy-0-[0-9a-f]{8}$/);
        expect(numeric.id).toBe('42');
        expect(fine.id).toBe('ok');
        expect(result.data._deletedBin).toEqual([]);
        expect(result.quarantined).toEqual([]);

        // The backfill is deterministic: same records, same ids, twice.
        const again = backfillSnapshotIds(result.data.snapshots);
        expect(again.changed).toBe(false);
        expect(again.snapshots).toEqual(result.data.snapshots);
    });

    test('knowledgeEvidence: absent tiers and meta are created per NPC file', () => {
        const result = dryRun('knowledgeEvidence', LEGACY_FIXTURES.knowledgeEvidence);
        expect(result.status).toBe('migrated');
        const file = result.data.Mara;
        for (const tier of ['raw', 'consolidated', 'archivedRaw', 'userOverrides']) {
            expect(Array.isArray(file[tier]), tier).toBe(true);
        }
        expect(file.meta).toEqual({});
        expect(file.raw).toEqual([{ id: 'r1', claim: 'Guards the gate.', quote: '"Nobody passes."' }]);
    });

    test('knowledgeCounters: absent counters default; receipt log normalizes with recovery', () => {
        const result = dryRun('knowledgeCounters', LEGACY_FIXTURES.knowledgeCounters);
        expect(result.status).toBe('migrated');
        expect(result.data.messageCounter).toBe(7);
        for (const key of ['npcMessageCounter', 'growthMessageCounter', 'relationshipMessageCounter']) {
            expect(result.data[key]).toBe(0);
        }
        // Later duplicate wins (runtime Map semantics); malformed tuples are
        // quarantined whole, never silently dropped. The REAL persisted shape
        // (a cadence counts object, e.g. { npc: 1, growth: 0 }) must survive
        // the migration — an invented integer shape must NOT.
        expect(result.data.countedReceiptEvents).toEqual([['id:reply', { state: 1 }]]);
        const reasons = result.quarantined.map(item => item.reasonCode);
        expect(reasons).toContain('receipt-invalid');
        const droppedRaw = result.quarantined
            .filter(item => item.reasonCode === 'receipt-invalid')
            .map(item => item.raw);
        expect(droppedRaw).toContainEqual(['bad-tuple']);
        expect(droppedRaw).toContainEqual(null);
        expect(droppedRaw).toContainEqual(['mu-b', 3]);
        // And the repair is visible as a declared repair-severity issue.
        expect(result.issues.some(issue => issue.code === 'receipt-duplicate' && issue.severity === 'repair')).toBe(true);
    });

    test('knowledgeStore: the embedded version is stamped when absent', () => {
        const result = dryRun('knowledgeStore', LEGACY_FIXTURES.knowledgeStore);
        expect(result.status).toBe('migrated');
        expect(result.data.version).toBe(1);
        expect(result.data.registry).toEqual({ Mara: { uid: 3 } });
    });

    test('storyPlanner: the legacy text blob becomes arcs; original text retained', () => {
        const result = dryRun('storyPlanner', LEGACY_FIXTURES.storyPlanner);
        expect(result.status).toBe('migrated');
        expect(result.data._migratedFromText).toBe(true);
        expect(result.data.text).toBe(LEGACY_FIXTURES.storyPlanner.text); // recoverable
        expect(result.data.arcs).toHaveLength(1);
        expect(result.data.arcs[0]).toMatchObject({
            title: 'Gate guard bribe',
            body: 'A coin opens the harbor gate',
            section: 'immediate',
            status: 'active',
            beats: ['Find a coin', 'Return at dusk'],
            beatIndex: 0,
        });
        expect(result.issues.some(issue => issue.code === 'plan-text-migrated')).toBe(true);

        // Already-migrated data passes through untouched.
        const current = prepareStore(STORE_SCHEMAS.storyPlanner, result.data, { version: 1 });
        expect(current.status).toBe('valid');
        expect(current.changed).toBe(false);
    });

    test('interiority: structural defaults apply; legacy keys DEFER preparation instead of being removed', () => {
        const result = dryRun('interiority', LEGACY_FIXTURES.interiority);
        expect(result.status).toBe('migrated');
        expect(result.data.turnCounter).toBe(0);
        expect(result.data.deletedIntentions).toEqual([]);
        expect(Object.keys(result.data.perMessage)).toEqual(['mu-abc']);

        // Legacy sd-*/numeric keys cannot be rewritten in the pure path — that
        // needs the live chat — so preparation is explicitly DEFERRED: the
        // store pauses (status 'deferred', NOT blocked/fatal) with the
        // original untouched and nothing quarantined, instead of the map
        // being emptied before the chat-dependent conversion could run on
        // the hydration path.
        const legacy = {
            enabled: true,
            perMessage: {
                'mu-abc': { generatedAt: 1 },
                'sd-2026-01-01': { generatedAt: 2 },
                '4': { generatedAt: 3 },
            },
        };
        const deferred = dryRun('interiority', legacy);
        expect(deferred.status).toBe('deferred');
        // A pause, not a fault: no error, no partial data, nothing stamped.
        expect(deferred.error).toBeNull();
        expect(deferred.data).toBeUndefined();
        expect(deferred.changed).toBe(false);
        expect(deferred.original).toBe(legacy);
        expect(deferred.quarantined).toEqual([]);
        const deferral = deferred.issues.find(issue => issue.code === 'per-message-legacy-pending');
        expect(deferral.severity).toBe('defer');
        // User-facing text explains the pause without naming internal functions.
        expect(deferral.message).toContain('one-time compatibility update');
        expect(deferral.message).not.toContain('migrateIndexKeys');

        // Once the chat-dependent rekey completes, the same data prepares cleanly.
        const rekeyed = {
            ...legacy,
            perMessage: { 'mu-abc': { generatedAt: 1 }, 'mu-rekey-1': { generatedAt: 2 }, 'mu-rekey-4': { generatedAt: 3 } },
        };
        const done = dryRun('interiority', rekeyed);
        expect(done.status).toBe('migrated');
        expect(done.data.perMessage).toEqual(rekeyed.perMessage);
    });

    test('a corrupt (non-object) root is refused untouched, for every store — fatal-root policy', () => {
        for (const id of SCHEMA_STORE_IDS) {
            for (const input of ['corrupt', 42, null]) {
                const result = prepareStore(STORE_SCHEMAS[id], input);
                expect(result.status, `${id}: ${JSON.stringify(input)}`).toBe('blocked');
                expect(result.error.code, id).toBe('fatal-issue');
                expect(result.error.message, id).toContain('root-not-object');
                // The unreadable original is preserved and nothing is manufactured,
                // quarantined, or stamped in its place.
                expect(result.original, id).toBe(input);
                expect(result.data, id).toBeUndefined();
                expect(result.quarantined, id).toEqual([]);
            }
        }
    });

    test('an unknown FUTURE version is still refused untouched, for every store', () => {
        for (const id of SCHEMA_STORE_IDS) {
            const input = Object.freeze({ frozen: true });
            const result = prepareStore(STORE_SCHEMAS[id], input, { version: 99 });
            expect(result.status, id).toBe('blocked');
            expect(result.error.code, id).toBe('future-version');
            expect(result.original, id).toBe(input);
        }
    });

    // ── A migration must never REPLACE a present-but-invalid container ──────
    //
    // Every migration's docstring promises that only ABSENT fields are
    // defaulted, and that a present-but-invalid value is left for the v1
    // validator to quarantine with its raw shape recoverable (design §5.2 /
    // §12). Two of them silently broke that: chronicle routed `snapshots`
    // through backfillSnapshotIds(), which coerces a non-array to [], and
    // storyPlanner treated a non-array `arcs` as "legacy" and overwrote it
    // with the text-parse result. Both then reported `changed: true` with an
    // EMPTY quarantine list — so the Part 6 cutover would have PERSISTED the
    // loss, which is the one failure this whole subsystem exists to prevent.
    //
    // Neither showed up because the policy batteries below only ever call
    // validate() directly; nothing drove these shapes through the v0
    // preparation path. This pins the rule where it broke.
    // [store, legacy input, the raw container that must reach quarantine]
    const CORRUPT_CONTAINERS = [
        ['worldState', { autoSaveHistory: 'not-a-list' }, 'not-a-list'],
        ['worldState', { provenance: 3 }, 3],
        ['chronicle', { snapshots: { a: { id: 'x', text: 'Kept.' } } }, { a: { id: 'x', text: 'Kept.' } }],
        ['chronicle', { snapshots: 'not-a-list' }, 'not-a-list'],
        ['chronicle', { _deletedBin: 'not-a-list' }, 'not-a-list'],
        ['knowledgeEvidence', { Mara: 'not-a-file' }, 'not-a-file'],
        ['knowledgeEvidence', { Mara: { raw: 'not-a-list' } }, 'not-a-list'],
        ['knowledgeCounters', { countedReceiptEvents: 'not-a-list' }, 'not-a-list'],
        ['storyPlanner', { arcs: { 0: { id: 'a1', title: 'Kept' } } }, { 0: { id: 'a1', title: 'Kept' } }],
        ['storyPlanner', { arcs: 'not-a-list' }, 'not-a-list'],
        ['storyPlanner', { history: 'not-a-list' }, 'not-a-list'],
        ['interiority', { ledger: 'not-a-list' }, 'not-a-list'],
        ['interiority', { perMessage: 'not-a-map' }, 'not-a-map'],
        ['knowledgeStore', { registry: 'not-a-map' }, 'not-a-map'],
        ['knowledgeStore', { relationships: 'not-a-map' }, 'not-a-map'],
    ];

    test.each(CORRUPT_CONTAINERS)(
        '%s: a corrupt container is quarantined by the v0 path, never replaced',
        (id, input, corrupt) => {
            const migrated = prepareStore(STORE_SCHEMAS[id], structuredClone(input), { version: 0 });
            const validated = prepareStore(STORE_SCHEMAS[id], structuredClone(input), { version: 1 });

            // The raw container survives the migration inside quarantine…
            expect(
                migrated.quarantined.map(item => fingerprintValue(item.raw)),
                `${id}: the corrupt container never reached quarantine`,
            ).toContain(fingerprintValue(corrupt));

            // …and migrating preserves everything validating alone preserves,
            // so upgrading a legacy chat can never lose more than opening an
            // already-current one.
            const keptByMigration = new Set(migrated.quarantined.map(item => fingerprintValue(item.raw)));
            for (const item of validated.quarantined) {
                expect(
                    keptByMigration.has(fingerprintValue(item.raw)),
                    `${id}: migrating dropped a "${item.reasonCode}" record that validating quarantined`,
                ).toBe(true);
            }
        },
    );
});

// ─── Idempotence ─────────────────────────────────────────────────────────────

describe('Part 2 migrations are idempotent', () => {
    test('every migrated fixture re-validates clean at the current version', () => {
        for (const id of SCHEMA_STORE_IDS) {
            const first = dryRun(id, structuredClone(LEGACY_FIXTURES[id]));
            expect(first.status, id).toBe('migrated');
            expect(first.changed, id).toBe(true);

            const second = prepareStore(STORE_SCHEMAS[id], first.data, { version: 1 });
            expect(second.status, id).toBe('valid');
            expect(second.changed, id).toBe(false);
            expect(second.data, id).toEqual(first.data);
            expect(second.quarantined, id).toEqual([]);
        }
    });

    test('re-running the v0 migration on its own output changes nothing', () => {
        for (const id of SCHEMA_STORE_IDS) {
            const migration = STORE_SCHEMAS[id].migrations[0];
            const once = migration(structuredClone(LEGACY_FIXTURES[id]));
            const twice = migration(once.data ?? once);
            expect(twice.data ?? twice, id).toEqual(once.data ?? once);
        }
    });
});

// ─── Issue policies ──────────────────────────────────────────────────────────

const POLICY_BATTERIES = {
    worldState: [null, {}, { text: 5 }, { autoSaveHistory: 'x' }, { autoSaveHistory: ['junk', { text: '' }, { text: 'a', timestamp: {} }] }, { provenance: 3 }],
    chronicle: [null, { snapshots: 'x' }, { _deletedBin: 'x' }, { snapshots: ['junk', { id: '', text: 'x' }, { id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }],
    knowledgeEvidence: [null, { Mara: 'junk' }, { '': {} }, { Mara: { raw: 'x' } }, { Mara: { raw: [{}, { id: '', claim: '', quote: '' }] } }, { Mara: { consolidated: [{}, { id: '', claim: '' }, { id: 'c', claim: 'c', sources: [1] }] } }, { Mara: { meta: 3 } }],
    knowledgeCounters: [null, { messageCounter: -1, npcMessageCounter: 'x' }],
    storyPlanner: [null, { arcs: 'x' }, { history: 'x' }, { arcs: ['junk', { id: '' }, { id: 'a', title: 1, body: 1, section: 'nope', status: 'nope', beats: 'x', beatIndex: -1, turnsSinceAdvance: 'x', createdAt: 'x', updatedAt: 'x' }] }],
    interiority: [null, { ledger: 'x' }, { ledger: [{}, { id: 'i' }] }, { deletedIntentions: [{ id: 't', npc: 'n', actions: 'x', triggers: [1] }] }, { perMessage: 'x' }, { perMessage: { bad: {}, 'mu-': {} } }, { perMessage: { 'sd-legacy': {}, '3': {}, 'mu-ok': {} } }, { turnCounter: 'x' }],
    knowledgeStore: [null, { registry: 'x' }, { registry: { g: 'junk', b: { uid: -1 } } }, { relationships: 'x' }, { relationships: { r: 'x', s: [{ target: '' }, { target: 't' }, 'junk'] } }, { stances: { a: 3 } }, { stanceSources: { a: 3 } }, { version: 0 }, { quarantine: 'x' }, { quarantine: { version: 2 } }, { quarantine: { items: 'x' } }, { quarantine: { items: [{}, { store: 'x' }, { store: 'x', reasonCode: 'y' }] } }],
};

describe('structured record/reference/fatal policies per store (design §3.5)', () => {
    test('every registered store declares a well-formed policy', () => {
        for (const id of SCHEMA_STORE_IDS) {
            const policy = STORE_SCHEMAS[id].policy;
            expect(policy, id).toBeTruthy();
            for (const category of POLICY_CATEGORIES) {
                expect(Array.isArray(policy[category]), `${id}.${category}`).toBe(true);
            }
        }
    });

    test('policy categories never overlap', () => {
        for (const id of SCHEMA_STORE_IDS) {
            const seen = new Set();
            for (const category of POLICY_CATEGORIES) {
                for (const code of STORE_SCHEMAS[id].policy[category]) {
                    expect(seen.has(code), `${id}: "${code}" declared twice`).toBe(false);
                    seen.add(code);
                }
            }
        }
    });

    test('every code a validator or migration emits is declared in the store policy', () => {
        for (const id of SCHEMA_STORE_IDS) {
            const policy = STORE_SCHEMAS[id].policy;
            const emitted = new Set();
            for (const input of POLICY_BATTERIES[id]) {
                for (const issue of STORE_SCHEMAS[id].validate(structuredClone(input)).issues) {
                    emitted.add(issue.code);
                }
            }
            // Migration-emitted codes too (receipt cleanup, plan-text parse…).
            const migrated = STORE_SCHEMAS[id].migrations[0](structuredClone(LEGACY_FIXTURES[id]));
            if (Array.isArray(migrated.issues)) {
                for (const issue of migrated.issues) emitted.add(issue.code);
            }

            expect(emitted.size, `${id}: battery emitted nothing`).toBeGreaterThan(0);
            for (const code of emitted) {
                expect(
                    getPolicyCategory(policy, code),
                    `${id}: emitted code "${code}" is not declared in the store policy`,
                ).not.toBeNull();
            }
        }
    });

    test('defineIssuePolicy freezes its lists and getPolicyCategory classifies', () => {
        const policy = defineIssuePolicy({ record: ['a'], repair: ['b'], reference: ['c'], fatal: ['d'], defer: ['f'], junk: ['e'] });
        expect(Object.isFrozen(policy)).toBe(true);
        expect(policy.junk).toBeUndefined();
        expect(getPolicyCategory(policy, 'b')).toBe('repair');
        expect(getPolicyCategory(policy, 'f')).toBe('defer');
        expect(getPolicyCategory(policy, 'missing')).toBeNull();
        expect(getPolicyCategory(undefined, 'a')).toBeNull();
    });
});

// ─── createDefault() is migration-canonical ──────────────────────────────────
//
// A store's default must not lag what its own migration chain converges on:
// a freshly created store and a just-migrated empty one must have the same
// shape (worldState's autoSaveHistory and interiority's turnCounter used to
// exist only after migration). The invariant is generic — it holds for every
// registered store, so a future migration that adds a default must update
// createDefault() or this test names the store that drifted.

describe('createDefault() is migration-canonical (design §4.1)', () => {
    test('migrating a store\'s own default converges on the default itself', () => {
        for (const id of SCHEMA_STORE_IDS) {
            const schema = STORE_SCHEMAS[id];
            const migrated = prepareStore(schema, schema.createDefault(), { version: 0 });
            expect(migrated.status, `${id}: ${migrated.error ? migrated.error.message : ''}`).toBe('migrated');
            expect(migrated.issues, id).toEqual([]);
            expect(migrated.data, id).toEqual(schema.createDefault());
            // The default is also a fixed point at the current version:
            // re-preparing it must be a no-op.
            const current = prepareStore(schema, schema.createDefault(), { version: schema.currentVersion });
            expect(current.status, id).toBe('valid');
            expect(current.changed, id).toBe(false);
        }
    });
});
