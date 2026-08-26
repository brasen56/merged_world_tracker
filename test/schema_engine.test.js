/**
 * Engine tests for the schema subsystem — design §10.1 of
 * upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md.
 *
 * These exercise the GENERIC contracts with synthetic descriptors (migration
 * order, blocking, idempotence, no-mutation, future-version refusal,
 * quarantine dedup) plus the registry integrity and purity rules that Part 1's
 * acceptance requires. Per-store rule parity lives in
 * test/schema_parity.test.js; per-store deep rules arrive with Part 2.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    checkPlainRecordList,
    checkRecordList,
    checkRecordMap,
    defineStoreSchema,
    emptyStats,
    prepareStore,
} from '../core/schema.js';
import {
    fingerprintValue,
    makeQuarantineItem,
    mergeQuarantineItems,
    normalizeQuarantineStore,
} from '../core/quarantine.js';
import {
    CHAT_METADATA_SCHEMA_IDS,
    SCHEMA_STORE_IDS,
    STORE_SCHEMAS,
    getStoreSchema,
} from '../schema/registry.js';
import { METADATA_KEYS, SECTION_KEYS } from '../backup/data.js';
import { STORE_VERSION } from '../knowledge/store.js';

/** A minimal well-formed descriptor; every field overridable per test. */
function makeTestDescriptor({ currentVersion = 1, migrations = {}, validate } = {}) {
    return defineStoreSchema({
        id: 'synthetic',
        metadataKey: 'synthetic_metadata',
        currentVersion,
        createDefault: () => ({}),
        migrations,
        validate: validate ?? (data => ({ data, issues: [], stats: emptyStats() })),
    });
}

describe('core/schema.js — descriptor contract', () => {
    test('defineStoreSchema rejects malformed descriptors loudly', () => {
        expect(() => defineStoreSchema({})).toThrow(TypeError);
        expect(() => defineStoreSchema({ id: 'x', currentVersion: 1, createDefault: () => ({}), migrations: {}, validate: () => ({}), metadataKey: '' })).toThrow(/invalid metadataKey/);
        expect(() => defineStoreSchema({ id: 'x', currentVersion: 0, createDefault: () => ({}), migrations: {}, validate: () => ({}), metadataKey: 'k' })).toThrow(/currentVersion/);
        expect(() => defineStoreSchema({ id: 'x', currentVersion: 1, createDefault: () => ({}), migrations: {}, metadataKey: 'k' })).toThrow(/validate/);
        expect(() => defineStoreSchema({ id: 'x', currentVersion: 1, createDefault: () => ({}), validate: () => ({}), metadataKey: 'k' })).toThrow(/migrations/);
        expect(() => defineStoreSchema({ id: 'x', currentVersion: 1, migrations: {}, validate: () => ({}), metadataKey: 'k' })).toThrow(/createDefault/);
        expect(() => defineStoreSchema({ id: 'x', currentVersion: 1, createDefault: () => ({}), migrations: {}, validate: () => ({}) })).toThrow(/metadataKey or a storage location/);
    });
});

describe('core/schema.js — prepareStore runner', () => {
    test('treats a missing or invalid version as legacy version 0', () => {
        const descriptor = makeTestDescriptor({ migrations: { 0: data => ({ ...data, seeded: true }) } });
        for (const version of [undefined, null, 0, -3, 1.5, 'nope']) {
            const result = prepareStore(descriptor, { a: 1 }, { version });
            expect(result.fromVersion).toBe(0);
            expect(result.status).toBe('migrated');
        }
    });

    test('already-current valid data is returned unchanged', () => {
        const data = { a: 1 };
        const result = prepareStore(makeTestDescriptor(), data, { version: 1 });
        expect(result.status).toBe('valid');
        expect(result.changed).toBe(false);
        expect(result.data).toEqual({ a: 1 });
        expect(result.quarantined).toEqual([]);
        expect(result.error).toBeNull();
        expect(result.fromVersion).toBe(1);
        expect(result.toVersion).toBe(1);
    });

    test('sequential multi-step migrations run in order, never jumping', () => {
        const order = [];
        const descriptor = makeTestDescriptor({
            currentVersion: 3,
            migrations: {
                0: data => { order.push('0->1'); return { ...data, v: 1 }; },
                1: data => { order.push('1->2'); return { ...data, v: 2 }; },
                2: data => { order.push('2->3'); return { ...data, v: 3 }; },
            },
        });
        const result = prepareStore(descriptor, {}, { version: 0 });
        expect(order).toEqual(['0->1', '1->2', '2->3']);
        expect(result.status).toBe('migrated');
        expect(result.fromVersion).toBe(0);
        expect(result.toVersion).toBe(3);
        expect(result.changed).toBe(true);
        expect(result.data).toEqual({ v: 3 });
    });

    test('a missing migration step blocks safely', () => {
        const descriptor = makeTestDescriptor(); // migrations: {}
        const result = prepareStore(descriptor, { a: 1 }, { version: 0 });
        expect(result.status).toBe('blocked');
        expect(result.error.code).toBe('missing-migration');
        expect(result.data).toBeUndefined();
        expect(result.original).toEqual({ a: 1 });
    });

    test('unknown future versions are refused and left unchanged', () => {
        const input = Object.freeze({ a: Object.freeze({ b: 1 }) });
        const result = prepareStore(makeTestDescriptor(), input, { version: 99 });
        expect(result.status).toBe('blocked');
        expect(result.error.code).toBe('future-version');
        expect(result.data).toBeUndefined();
        expect(result.original).toBe(input);
        // The refusal must not attempt even a read-level coercion of the data.
        expect(input).toEqual({ a: { b: 1 } });
    });

    test('a thrown migration blocks with no mutation and no partial result', () => {
        const input = { a: { b: 1 } };
        const snapshot = JSON.stringify(input);
        const descriptor = makeTestDescriptor({
            migrations: {
                0: () => { throw new Error('boom'); },
                // A second step exists; it must never run.
                1: data => ({ ...data, unreachable: true }),
            },
        });
        const result = prepareStore(descriptor, input, { version: 0, now: 5 });
        expect(result.status).toBe('blocked');
        expect(result.error.code).toBe('migration-failed');
        expect(result.error.message).toContain('boom');
        expect(result.data).toBeUndefined();
        expect(result.quarantined).toEqual([]);
        expect(JSON.stringify(input)).toBe(snapshot);
    });

    test('a thrown validator blocks with no mutation or partial result', () => {
        const input = { a: 1 };
        const descriptor = makeTestDescriptor({
            validate: () => { throw new Error('cannot read'); },
        });
        const result = prepareStore(descriptor, input, { version: 1 });
        expect(result.status).toBe('blocked');
        expect(result.error.code).toBe('validation-failed');
        expect(result.data).toBeUndefined();
        expect(input).toEqual({ a: 1 });
    });

    test('migrations receive a clone — the caller input is never mutated', () => {
        let received = null;
        const descriptor = makeTestDescriptor({
            migrations: {
                0: data => { received = data; data.touched = true; return data; },
            },
        });
        const input = { a: 1 };
        const result = prepareStore(descriptor, input, { version: 0 });
        expect(received).not.toBe(input);
        expect(input).toEqual({ a: 1 });
        expect(result.data).toEqual({ a: 1, touched: true });
        expect(result.status).toBe('migrated');
    });

    test('migration is idempotent — the migrated result re-validates clean', () => {
        const descriptor = makeTestDescriptor({
            migrations: { 0: data => ({ ...data, seeded: true }) },
        });
        const first = prepareStore(descriptor, {}, { version: 0 });
        expect(first.status).toBe('migrated');
        expect(first.changed).toBe(true);
        const second = prepareStore(descriptor, first.data, { version: 1 });
        expect(second.status).toBe('valid');
        expect(second.changed).toBe(false);
        expect(second.data).toEqual(first.data);
        expect(second.quarantined).toEqual([]);
    });

    test('quarantine-severity issues become structured recovery items', () => {
        const issue = {
            code: 'snapshot-missing-text',
            path: ['snapshots', 1],
            severity: 'quarantine',
            message: 'Snapshot text must be a non-empty string.',
            record: { id: 'bad' },
        };
        const descriptor = makeTestDescriptor({
            validate: () => ({ data: {}, issues: [issue], stats: emptyStats() }),
        });
        const result = prepareStore(descriptor, {}, { version: 1, now: 1234 });
        expect(result.status).toBe('valid');
        expect(result.quarantined).toHaveLength(1);
        expect(result.quarantined[0]).toMatchObject({
            store: 'synthetic',
            path: ['snapshots', 1],
            reasonCode: 'snapshot-missing-text',
            message: 'Snapshot text must be a non-empty string.',
            raw: { id: 'bad' },
            sourceVersion: 1,
            detectedAt: 1234,
        });
        expect(result.quarantined[0].fingerprint).toBe(fingerprintValue({ id: 'bad' }));
    });

    test('quarantine-storage failure blocks instead of losing the rejected record', () => {
        const issue = {
            code: 'bad-record',
            path: ['snapshots', 0],
            severity: 'quarantine',
            message: 'bad',
            record: { id: 'bad' },
        };
        const descriptor = makeTestDescriptor({
            validate: data => ({ data, issues: [issue], stats: emptyStats() }),
        });
        const input = { snapshots: [{ id: 'bad' }] };
        const result = prepareStore(descriptor, input, { version: 1, maxQuarantineItems: 0 });
        expect(result.status).toBe('blocked');
        expect(result.error.code).toBe('quarantine-limit');
        expect(result.data).toBeUndefined();
        // The original store still carries the record — nothing was dropped.
        expect(input).toEqual({ snapshots: [{ id: 'bad' }] });
    });

    test('migration envelope results contribute their issues', () => {
        const descriptor = makeTestDescriptor({
            migrations: {
                0: () => ({
                    data: { seeded: true },
                    issues: [{ code: 'legacy-seeded', path: [], severity: 'repair', message: 'seeded defaults' }],
                }),
            },
        });
        const result = prepareStore(descriptor, {}, { version: 0 });
        expect(result.status).toBe('migrated');
        expect(result.data).toEqual({ seeded: true });
        expect(result.issues.map(issue => issue.code)).toEqual(['legacy-seeded']);
    });

    test('per-step validation gates catch malformed migration output at the offending step', () => {
        const order = [];
        const descriptor = makeTestDescriptor({
            currentVersion: 3,
            migrations: {
                0: data => { order.push('0->1'); return { ...data, poison: true }; },
                1: data => { order.push('1->2'); return data; },
                2: data => { order.push('2->3'); return data; },
            },
            validate: data => {
                if (data.poison) throw new Error('unreadable root');
                return { data, issues: [], stats: emptyStats() };
            },
        });
        const result = prepareStore(descriptor, { a: 1 }, { version: 0 });
        expect(result.status).toBe('blocked');
        expect(result.error.code).toBe('validation-failed');
        expect(result.error.message).toContain('unreadable root');
        // Later steps never see the malformed output.
        expect(order).toEqual(['0->1']);
        expect(result.data).toBeUndefined();
    });

    test('per-step validation gates block on fatal findings before later steps run', () => {
        const order = [];
        const fatalIssue = { code: 'root-not-object', path: [], severity: 'fatal', message: 'Store data must be an object.' };
        const descriptor = makeTestDescriptor({
            currentVersion: 3,
            migrations: {
                0: data => { order.push('0->1'); return { ...data, broken: true }; },
                1: data => { order.push('1->2'); return data; },
                2: data => { order.push('2->3'); return data; },
            },
            validate: data => (data.broken
                ? { data, issues: [fatalIssue], stats: emptyStats() }
                : { data, issues: [], stats: emptyStats() }),
        });
        const input = { a: 1 };
        const result = prepareStore(descriptor, input, { version: 0 });
        expect(result.status).toBe('blocked');
        expect(result.error.code).toBe('fatal-issue');
        expect(result.error.message).toContain('root-not-object');
        expect(order).toEqual(['0->1']);
        expect(result.data).toBeUndefined();
        expect(result.quarantined).toEqual([]);
        expect(result.issues).toEqual([fatalIssue]);
        expect(input).toEqual({ a: 1 });
    });

    test('fatal validation findings at the current version block instead of returning valid data', () => {
        const fatalIssue = { code: 'root-unreadable', path: [], severity: 'fatal', message: 'Store root could not be read.' };
        const descriptor = makeTestDescriptor({
            validate: () => ({ data: {}, issues: [fatalIssue], stats: emptyStats() }),
        });
        const input = { snapshots: [] };
        const result = prepareStore(descriptor, input, { version: 1 });
        expect(result.status).toBe('blocked');
        expect(result.error.code).toBe('fatal-issue');
        expect(result.error.message).toContain('left unchanged');
        expect(result.data).toBeUndefined();
        expect(result.quarantined).toEqual([]);
        expect(result.issues).toEqual([fatalIssue]);
        expect(input).toEqual({ snapshots: [] });
    });

    test('a DEFER-severity finding pauses preparation as deferred, not blocked', () => {
        const deferFinding = {
            code: 'legacy-pending',
            path: ['perMessage'],
            severity: 'defer',
            message: 'needs a one-time compatibility update',
            record: undefined,
        };
        const descriptor = makeTestDescriptor({
            validate: data => ({ data, issues: [deferFinding], stats: emptyStats() }),
        });
        const input = { perMessage: { '4': {} } };
        const result = prepareStore(descriptor, input, { version: 1 });
        // A store-local pause pending chat-dependent work (design §7.5):
        // not a fault — no error, no canonical data, nothing quarantined,
        // original untouched, and no partial result stamped.
        expect(result.status).toBe('deferred');
        expect(result.error).toBeNull();
        expect(result.data).toBeUndefined();
        expect(result.changed).toBe(false);
        expect(result.original).toBe(input);
        expect(result.quarantined).toEqual([]);
        expect(result.issues).toEqual([deferFinding]);
        expect(input).toEqual({ perMessage: { '4': {} } });
    });

    test('a FATAL finding wins over a simultaneous DEFER finding', () => {
        const deferFinding = { code: 'legacy-pending', path: [], severity: 'defer', message: 'pending conversion' };
        const fatalFinding = { code: 'root-unreadable', path: [], severity: 'fatal', message: 'Store root could not be read.' };
        const descriptor = makeTestDescriptor({
            validate: () => ({ data: {}, issues: [deferFinding, fatalFinding], stats: emptyStats() }),
        });
        const result = prepareStore(descriptor, { a: 1 }, { version: 1 });
        expect(result.status).toBe('blocked');
        expect(result.error.code).toBe('fatal-issue');
        expect(result.issues).toEqual([deferFinding, fatalFinding]);
    });

    test('quarantine issues reported by migration steps become recovery items', () => {
        const rejected = { id: 'legacy-bad', text: '' };
        const descriptor = makeTestDescriptor({
            migrations: {
                0: data => ({
                    data: { ...data, snapshots: [{ id: 'ok', text: 'fine' }] },
                    issues: [{
                        code: 'snapshot-missing-text',
                        path: ['snapshots', 0],
                        severity: 'quarantine',
                        message: 'Snapshot text must be a non-empty string.',
                        record: rejected,
                    }],
                }),
            },
        });
        const result = prepareStore(descriptor, { snapshots: [rejected, { id: 'ok', text: 'fine' }] }, { version: 0, now: 42 });
        expect(result.status).toBe('migrated');
        expect(result.quarantined).toHaveLength(1);
        expect(result.quarantined[0]).toMatchObject({
            store: 'synthetic',
            path: ['snapshots', 0],
            reasonCode: 'snapshot-missing-text',
            message: 'Snapshot text must be a non-empty string.',
            raw: rejected,
            sourceVersion: 0,
            detectedAt: 42,
        });
        expect(result.quarantined[0].fingerprint).toBe(fingerprintValue(rejected));
    });

    test('canonicalized current-version data reports changed, then converges', () => {
        const canonicalize = data => ({
            data: { snapshots: (data.snapshots ?? []).filter(snapshot => snapshot && snapshot.text) },
            issues: [],
            stats: emptyStats(),
        });
        const input = { snapshots: [{ id: 'bad' }] };
        const first = prepareStore(makeTestDescriptor({ validate: canonicalize }), input, { version: 1 });
        expect(first.status).toBe('valid');
        // The canonicalization itself is a change, even with no migration.
        expect(first.changed).toBe(true);
        expect(first.data).toEqual({ snapshots: [] });
        // Canonical data is stable: a reload reports no change, so persistence
        // does not re-save (nor re-discover the same corruption) forever.
        const second = prepareStore(makeTestDescriptor({ validate: canonicalize }), first.data, { version: 1 });
        expect(second.status).toBe('valid');
        expect(second.changed).toBe(false);
    });

    test('provisional per-step findings are re-derived once, never duplicated', () => {
        const finding = {
            code: 'snapshot-missing-text',
            path: ['snapshots', 0],
            severity: 'quarantine',
            message: 'Snapshot text must be a non-empty string.',
            record: { id: 'bad' },
        };
        const descriptor = makeTestDescriptor({
            currentVersion: 2,
            migrations: {
                0: data => data,
                1: data => data,
            },
            validate: data => ({ data, issues: [finding], stats: emptyStats() }),
        });
        const result = prepareStore(descriptor, { snapshots: [{ id: 'bad' }] }, { version: 0 });
        expect(result.status).toBe('migrated');
        // Reported once by the current-version validation, not once per gate.
        expect(result.issues).toEqual([finding]);
        expect(result.quarantined).toHaveLength(1);
    });
});

describe('core/schema.js — record-collection helpers', () => {
    test('checkRecordList: stable codes/paths, duplicate conflicts, id-string records', () => {
        const check = record => (record && typeof record === 'object' && record.id ? null : { code: 'missing-id', message: 'no id' });
        const checked = checkRecordList(
            [{ id: 'a' }, { id: 'a' }, { id: '' }, 'junk'],
            'snapshots',
            check,
            { path: ['snapshots'] },
        );
        expect(checked.records).toEqual([{ id: 'a' }]);
        expect(checked.stats).toEqual({ added: 1, updated: 0, conflicts: 1 });
        // Rejected records keep their COMPLETE raw record (recoverable); the
        // display id string rides separately in `identity`.
        expect(checked.issues.map(issue => [issue.code, issue.path, issue.record, issue.identity])).toEqual([
            ['duplicate-id', ['snapshots', 1, 'id'], { id: 'a' }, 'a'],
            ['missing-id', ['snapshots', 2], { id: '' }, ''],
            ['missing-id', ['snapshots', 3], 'junk', undefined],
        ]);
        for (const issue of checked.issues) {
            expect(issue.severity).toBe('quarantine');
            expect(typeof issue.message).toBe('string');
        }
    });

    test('checkRecordList: non-array containers quarantine with the legacy message', () => {
        const checked = checkRecordList('nope', 'autoSaveHistory', () => null, { path: ['autoSaveHistory'] });
        expect(checked.records).toEqual([]);
        expect(checked.issues).toEqual([{
            code: 'not-an-array',
            path: ['autoSaveHistory'],
            severity: 'quarantine',
            message: 'autoSaveHistory must be an array.',
            record: 'nope',
            identity: 'autoSaveHistory',
        }]);
    });

    test('checkRecordList: an undefined list is accepted as empty', () => {
        expect(checkRecordList(undefined, 'arcs', () => null)).toEqual({
            records: [],
            issues: [],
            stats: { added: 0, updated: 0, conflicts: 0 },
        });
    });

    test('checkPlainRecordList: accepts duplicate ids — no dedup by design', () => {
        const check = record => (record && typeof record === 'object' && record.id ? null : { code: 'missing-id', message: 'no id' });
        const checked = checkPlainRecordList(
            [{ id: 'a' }, { id: 'a' }, 'junk'],
            'arcs',
            check,
            { path: ['arcs'] },
        );
        // The NON-deduplicating twin (renamed from checkUniqueRecordList,
        // which read backwards): repeats are the caller's canonicalizer's to
        // resolve (Story Planner's sanitizeArcs mints fresh ids), so both
        // records survive with no conflict counted.
        expect(checked.records).toEqual([{ id: 'a' }, { id: 'a' }]);
        expect(checked.stats).toEqual({ added: 2, updated: 0, conflicts: 0 });
        expect(checked.issues.map(issue => [issue.code, issue.path, issue.record, issue.identity])).toEqual([
            ['missing-id', ['arcs', 2], 'junk', undefined],
        ]);
    });

    test('checkRecordMap: empty keys, entry shapes, and permissive fallback', () => {
        const checked = checkRecordMap({ Good: { uid: 1 }, '': {}, Bad: 5 }, 'registry', null, { path: ['registry'] });
        expect(checked.data).toEqual({ Good: { uid: 1 } });
        expect(checked.stats.added).toBe(1);
        expect(checked.issues.map(issue => [issue.code, issue.path, issue.record, issue.identity])).toEqual([
            ['empty-key', ['registry', ''], {}, ''],
            ['entry-not-object', ['registry', 'Bad'], 5, 'Bad'],
        ]);
        const notMap = checkRecordMap(null, 'stances', null);
        expect(notMap.issues).toEqual([{
            code: 'not-an-object',
            path: [],
            severity: 'quarantine',
            message: 'stances must be an object map.',
            record: null,
            identity: 'stances',
        }]);
    });
});

describe('core/quarantine.js — fingerprinting and dedup', () => {
    test('fingerprints are stable across key order and distinct across content', () => {
        expect(fingerprintValue({ a: 1, b: [1, 2] })).toBe(fingerprintValue({ b: [1, 2], a: 1 }));
        expect(fingerprintValue({ a: 1 })).not.toBe(fingerprintValue({ a: 2 }));
        expect(fingerprintValue([1, 2])).not.toBe(fingerprintValue([2, 1]));
        expect(fingerprintValue('x')).toMatch(/^[0-9a-f]{8}$/);
    });

    test('quarantine fingerprinting deduplicates repeated loads', () => {
        const first = makeQuarantineItem({ store: 'chronicle', reasonCode: 'x', message: 'm', raw: { id: 1 }, detectedAt: 1 });
        const second = makeQuarantineItem({ store: 'chronicle', reasonCode: 'x', message: 'm', raw: { id: 1 }, detectedAt: 2 });
        expect(first.id).toBe(second.id);
        expect(mergeQuarantineItems([first], [second])).toHaveLength(1);
        // Same content in a different store stays distinct.
        const otherStore = makeQuarantineItem({ store: 'worldState', reasonCode: 'x', message: 'm', raw: { id: 1 } });
        expect(mergeQuarantineItems([first], [otherStore])).toHaveLength(2);
        // Genuinely different content stays distinct.
        const otherRecord = makeQuarantineItem({ store: 'chronicle', reasonCode: 'x', message: 'm', raw: { id: 2 } });
        expect(mergeQuarantineItems([first], [otherRecord])).toHaveLength(2);
    });

    test('normalizeQuarantineStore coerces garbage and dedupes on load', () => {
        expect(normalizeQuarantineStore(null)).toEqual({ version: 1, items: [] });
        expect(normalizeQuarantineStore('junk').items).toEqual([]);
        const item = makeQuarantineItem({ store: 'chronicle', reasonCode: 'x', message: 'm', raw: { id: 1 } });
        expect(normalizeQuarantineStore({ items: [item, { ...item }] }).items).toHaveLength(1);
    });
});

describe('schema/registry.js — authoritative store coverage', () => {
    test('registers a descriptor for every backup section, in the same order', () => {
        expect([...SCHEMA_STORE_IDS]).toEqual([...SECTION_KEYS]);
        for (const id of SCHEMA_STORE_IDS) {
            const schema = STORE_SCHEMAS[id];
            expect(Number.isInteger(schema.currentVersion), id).toBe(true);
            expect(schema.currentVersion, id).toBeGreaterThanOrEqual(1);
            expect(typeof schema.validate, id).toBe('function');
            expect(typeof schema.createDefault, id).toBe('function');
            expect(schema.migrations, id).toBeTypeOf('object');
        }
    });

    test('chat-metadata keys match the persisted metadata keys exactly', () => {
        expect([...CHAT_METADATA_SCHEMA_IDS]).toEqual(Object.keys(METADATA_KEYS));
        for (const [id, key] of Object.entries(METADATA_KEYS)) {
            expect(STORE_SCHEMAS[id].metadataKey, id).toBe(key);
        }
    });

    test('the knowledge lorebook store uses a location, and its version matches STORE_VERSION', () => {
        expect(STORE_SCHEMAS.knowledgeStore.metadataKey).toBeUndefined();
        expect(STORE_SCHEMAS.knowledgeStore.location).toMatchObject({ kind: 'lorebook-entry', entryCommentPrefix: '[MWT:store]' });
        expect(STORE_SCHEMAS.knowledgeStore.currentVersion).toBe(STORE_VERSION);
    });

    test('store ids and metadata keys are unique', () => {
        expect(new Set(SCHEMA_STORE_IDS).size).toBe(SCHEMA_STORE_IDS.length);
        const keys = CHAT_METADATA_SCHEMA_IDS.map(id => STORE_SCHEMAS[id].metadataKey);
        expect(new Set(keys).size).toBe(keys.length);
    });

    test('getStoreSchema returns null for unknown stores instead of inventing one', () => {
        expect(getStoreSchema('worldState').id).toBe('worldState');
        expect(getStoreSchema('doesNotExist')).toBeNull();
    });

    test('descriptor defaults validate with no issues', () => {
        for (const id of SCHEMA_STORE_IDS) {
            const schema = STORE_SCHEMAS[id];
            const validation = schema.validate(schema.createDefault());
            expect(validation.issues, id).toEqual([]);
            expect(validation.stats.conflicts, id).toBe(0);
            expect(validation.data, id).toBeTypeOf('object');
        }
    });

    test('registered stores now migrate legacy (version 0) data through Part 2 migrations', () => {
        const result = prepareStore(STORE_SCHEMAS.chronicle, { snapshots: [] });
        expect(result.fromVersion).toBe(0);
        expect(result.status).toBe('migrated');
        expect(result.toVersion).toBe(1);
        expect(result.data).toEqual({ snapshots: [], _deletedBin: [] });
        // Current-version data still validates through the same runner.
        const current = prepareStore(STORE_SCHEMAS.chronicle, { snapshots: [] }, { version: 1 });
        expect(current.status).toBe('valid');
        // Every registered store has its 0 -> 1 step wired.
        for (const id of SCHEMA_STORE_IDS) {
            expect(typeof STORE_SCHEMAS[id].migrations[0], id).toBe('function');
        }
    });
});

describe('schema modules stay pure', () => {
    const SCHEMA_FILES = [
        'core/schema.js',
        'core/quarantine.js',
        'schema/manifest.js',
        'schema/registry.js',
        'world_state/schema.js',
        'chronicle/schema.js',
        'knowledge/schema.js',
        'story_planner/schema.js',
        'interiority/schema.js',
    ];

    test('no schema module imports a barrel, a host module, or another feature file', () => {
        let checkedImports = 0;
        for (const file of SCHEMA_FILES) {
            const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
            // core/quarantine.js is deliberately import-free; every other file
            // must have at least one allowed import for this sweep to be real.
            const specifiers = [...text.matchAll(/(?:from\s|import\s)['"]([^'"]+)['"]/g)].map(match => match[1]);
            checkedImports += specifiers.length;
            for (const specifier of specifiers) {
                expect(specifier, `${file} imports ${specifier}`).toMatch(
                    /^(\.\/quarantine\.js|\.\.\/core\/(schema|quarantine)\.js|\.\.\/(world_state|chronicle|knowledge|story_planner|interiority)\/schema\.js)$/,
                );
            }
        }
        expect(checkedImports).toBeGreaterThan(0);
    });

    test('no schema module touches DOM or SillyTavern globals', () => {
        for (const file of SCHEMA_FILES) {
            const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
            expect(text, file).not.toMatch(/\b(document|window|globalThis|SillyTavern|getContext)\s*\./);
        }
    });
});
