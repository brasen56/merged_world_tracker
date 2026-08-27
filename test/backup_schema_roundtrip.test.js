/**
 * test/backup_schema_roundtrip.test.js — Part 3 round-trip and transaction tests.
 *
 * Design §7.7 and §10.3 of SCHEMA_VALIDATION_MIGRATIONS_PLAN.md:
 *
 *   - Backup section versions are SOURCED from the schema descriptors (§3.4),
 *     and imported sections are MIGRATED from the version their wrapper
 *     declares BEFORE validation and merge planning (§7.7) — so a plan is
 *     always built against current-version canonical data.
 *   - The restore COMMIT is one transaction: section data, the schema
 *     manifest stamp, and quarantine additions land in the SAME chat-metadata
 *     object and are flushed by the SAME save (§7.3). A failed persist rolls
 *     all three back together — the manifest may never end up ahead of its
 *     data.
 *   - A full collect → validate → restore → re-collect cycle is stable
 *     (round-trip), and quarantine recovery data travels with the backup
 *     (§5.3) instead of stranding rejected records on the source chat.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { buildBackupEnvelope } from '../backup/data.js';
import { prepareBackupSection, validateBackupEnvelope } from '../backup/validate.js';
import { exportBackup, restoreBackup } from '../backup/index.js';
import { STORE_SCHEMAS } from '../schema/registry.js';
import { MANIFEST_METADATA_KEY } from '../schema/manifest.js';
import { QUARANTINE_METADATA_KEY, makeQuarantineItem } from '../core/quarantine.js';
import { defineStoreSchema, emptyStats } from '../core/schema.js';
import { triggerImport } from '../chronicle/import-export.js';
import { _render as chronicleRender, state as chronicleState } from '../chronicle/data.js';
import { parseWorldStateImport } from '../world_state/data.js';
import { importNpcs } from '../knowledge/staging.js';
import { getRegistry } from '../knowledge/registry.js';
import {
    resetCoreStubs,
    setFakeChat,
    setFakeContextExtras,
    getFakeMeta,
    getFakeDownloadJsonCalls,
    setPickTextFileStub,
} from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function arc(id, title = id) {
    return {
        id, title, body: 'body', section: 'emerging', status: 'active', pinned: false,
        beats: [], beatIndex: 0, turnsSinceAdvance: 0, createdAt: 1, updatedAt: 1,
    };
}

/** All six chat-metadata sections in canonical current-version shape. */
function canonicalMetadata() {
    return {
        worldState: { text: 'restored state', autoSaveHistory: [{ text: 'old', timestamp: 1 }] },
        chronicle: { snapshots: [{ id: 's2', text: 'restored snapshot' }], _deletedBin: [] },
        knowledgeEvidence: {
            Mara: { npc: 'Mara', raw: [{ id: 'r2', claim: 'restored', quote: 'quote' }], consolidated: [], archivedRaw: [] },
        },
        knowledgeCounters: { messageCounter: 3, countedReceiptEvents: [] },
        storyPlanner: { arcs: [arc('a2', 'Restored arc')] },
        interiority: {
            enabled: true,
            ledger: [{ id: 'i2', npc: 'Mara', action: 'wait', trigger: 'dawn' }],
            deletedIntentions: [],
            perMessage: { 'mu-2': { generatedAt: 2 } },
            turnCounter: 0,
        },
    };
}

function backupFile(overrides = {}) {
    return buildBackupEnvelope({
        identity: { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null },
        metadata: canonicalMetadata(),
        ...overrides,
    });
}

// A synthetic v2-capable descriptor: the registered stores are all at
// currentVersion 1 today, so the migration-before-validation wiring is proven
// against a descriptor that has a real version gap (v1-declared data must run
// the 1 → 2 step before the v2 validator sees it).
function syntheticV2Schema() {
    return defineStoreSchema({
        id: 'synthetic',
        metadataKey: 'synthetic_data',
        currentVersion: 2,
        createDefault: () => ({ a: true, c: [] }),
        migrations: {
            0: data => ({ data: { ...data, a: true }, issues: [] }),
            1: data => {
                const next = { ...data, c: data.b ?? [] };
                delete next.b;
                return { data: next, issues: [] };
            },
        },
        validate: data => {
            if (data === null || typeof data !== 'object' || Array.isArray(data)) {
                return { data: {}, issues: [], stats: emptyStats() };
            }
            const next = { ...data };
            delete next.b;
            return { data: next, issues: [], stats: emptyStats() };
        },
    });
}

// ─── §3.4 — backup versions come from the descriptors ───────────────────────

describe('Part 3 — backup envelope sources section versions from schema descriptors', () => {
    test('every section wrapper carries its store descriptor currentVersion', () => {
        const envelope = buildBackupEnvelope({
            metadata: canonicalMetadata(),
            knowledgeStore: { registry: {}, relationships: {} },
        });
        for (const [name, section] of Object.entries(envelope.sections)) {
            const schema = STORE_SCHEMAS[name];
            expect(schema, `unknown section ${name}`).toBeTruthy();
            const stamped = name === 'knowledgeStore' ? section.storeVersion : section.schemaVersion;
            expect(stamped, name).toBe(schema.currentVersion);
        }
        expect(envelope.sections.knowledgeStore.storeVersion).toBe(STORE_SCHEMAS.knowledgeStore.currentVersion);
    });

    test('a version bump in a descriptor changes the stamped wrapper version with no other edits', () => {
        // The contract Part 6+ relies on: when a store's currentVersion moves,
        // newly exported backups carry the new marker automatically because
        // data.js reads it from the registry — there is no second constant to
        // update (§3.4 replaces the old global SECTION_SCHEMA_VERSION).
        const envelope = buildBackupEnvelope({ metadata: { worldState: { text: 'x' } } });
        expect(envelope.sections.worldState.schemaVersion).toBe(STORE_SCHEMAS.worldState.currentVersion);
    });
});

// ─── §7.7 — migrate imported sections before validation/merge preview ────────

describe('Part 3 — prepareBackupSection migrates before validation', () => {
    test('runs every registered migration step between the declared and current version', () => {
        const schema = syntheticV2Schema();
        // Declared v1: only the 1 → 2 step runs (the data is already v1).
        const fromV1 = prepareBackupSection(schema, { a: true, b: ['kept'] }, 1);
        expect(fromV1.ok).toBe(true);
        expect(fromV1.status).toBe('migrated');
        expect(fromV1.data).toEqual({ a: true, c: ['kept'] });
        expect(fromV1.summary.migrated).toBe(true);
        // Declared v0 (legacy): the whole chain 0 → 1 → 2 runs in order.
        const fromV0 = prepareBackupSection(schema, { b: ['kept'] }, 0);
        expect(fromV0.ok).toBe(true);
        expect(fromV0.data).toEqual({ a: true, c: ['kept'] });
    });

    test('validation-only when the declared version is current (no migrated flag)', () => {
        const schema = syntheticV2Schema();
        const prepared = prepareBackupSection(schema, { a: true, c: [] }, 2);
        expect(prepared.ok).toBe(true);
        expect(prepared.status).toBe('valid');
        expect(prepared.summary.migrated).toBeUndefined();
    });

    test('refuses a section declared with a future version', () => {
        const schema = syntheticV2Schema();
        const prepared = prepareBackupSection(schema, { a: true }, 5);
        expect(prepared.ok).toBe(false);
        expect(prepared.error).toMatch(/could not be imported/);
    });

    test('refuses an unreadable root instead of importing an empty replacement', () => {
        const prepared = prepareBackupSection(STORE_SCHEMAS.chronicle, 'garbage', 1);
        expect(prepared.ok).toBe(false);
        expect(prepared.error).toMatch(/could not be imported/);
    });

    test('accepts a deferred section with its retained entries (interiority legacy keys)', () => {
        // §7.5: the legacy perMessage entries were RETAINED, not refused — an
        // import accepts them, and the summary reports the pause as
        // `deferred`, never as skipped/quarantined records.
        const prepared = prepareBackupSection(STORE_SCHEMAS.interiority, {
            ledger: [{ id: 'i1', npc: 'Mara', action: 'wait', trigger: 'dawn' }],
            deletedIntentions: [],
            perMessage: { 'sd-2026-01-01': { generatedAt: 1 } },
            turnCounter: 0,
        }, 1);
        expect(prepared.ok).toBe(true);
        expect(prepared.status).toBe('deferred');
        expect(prepared.data.perMessage).toEqual({ 'sd-2026-01-01': { generatedAt: 1 } });
        expect(prepared.summary.skipped).toEqual([]);
        expect(prepared.summary.deferred[0].reason).toMatch(/one-time compatibility update/);
    });
});

describe('Part 3 — validateBackupEnvelope reports import quarantine and recovery data', () => {
    test('per-section quarantine records ride in result.quarantine with raw records preserved', () => {
        const file = backupFile();
        file.sections.chronicle.data.snapshots.push({ id: 'bad', text: '' });
        const result = validateBackupEnvelope(file);
        expect(result.ok).toBe(true);
        expect(result.sections.chronicle.snapshots).toHaveLength(1);
        expect(result.summaries.chronicle.skipped).toHaveLength(1);
        // §5.2: the COMPLETE raw record is preserved for recovery, not just
        // the display identity.
        expect(result.quarantine.chronicle).toHaveLength(1);
        expect(result.quarantine.chronicle[0].raw).toEqual({ id: 'bad', text: '' });
        expect(result.quarantine.chronicle[0].store).toBe('chronicle');
    });

    test('envelope quarantine recovery data is accepted and never blocks the import', () => {
        const file = backupFile({
            quarantine: {
                version: 1,
                items: [{
                    id: 'chronicle:deadbeef',
                    store: 'chronicle',
                    path: ['snapshots'],
                    reasonCode: 'snapshot-missing-text',
                    message: 'Snapshot text must be a non-empty string.',
                    raw: { id: 'x', text: '' },
                    detectedAt: 1,
                    sourceVersion: 1,
                    fingerprint: 'deadbeef',
                }],
            },
        });
        const result = validateBackupEnvelope(file);
        expect(result.ok).toBe(true);
        expect(result.recovery.items).toHaveLength(1);
        expect(result.recovery.items[0].raw).toEqual({ id: 'x', text: '' });
    });

    test('malformed recovery data warns but does not refuse the restore', () => {
        const file = backupFile({ quarantine: { kind: 'something-else' } });
        const result = validateBackupEnvelope(file);
        expect(result.ok).toBe(true);
        expect(result.warnings.some(warning => warning.match(/Quarantine recovery data/))).toBe(true);
        expect(result.recovery.items).toEqual([]);
    });
});

// ─── Round-trip + transaction (integration) ──────────────────────────────────

describe('Part 3 — restore commits data, manifest, and quarantine in one transaction', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        _clearCacheForTests();
        globalThis.SillyTavern = {
            getContext: () => ({ getCurrentChatId: () => 'chat-a' }),
        };
        setFakeContextExtras({
            getCurrentChatId: () => 'chat-a',
            saveMetadata: async () => {},
        });
        setFakeChat([{ mes: 'hello', extra: { mwt_uuid: '2' } }]);
        _setCacheForTests('Knowledge Tracker', { registry: {}, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });
    });

    afterEach(() => {
        _clearCacheForTests();
        _resetEpoch();
        delete globalThis.SillyTavern;
    });

    test('restore stamps the schema manifest for every restored section (§7.7)', async () => {
        const result = await restoreBackup(backupFile({ knowledgeStore: undefined }), { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });

        const manifest = getFakeMeta()[MANIFEST_METADATA_KEY];
        expect(manifest).toBeTruthy();
        expect(manifest.manifestVersion).toBe(1);
        for (const id of ['worldState', 'chronicle', 'knowledgeEvidence', 'knowledgeCounters', 'storyPlanner', 'interiority']) {
            expect(manifest.sections[id], id).toBe(STORE_SCHEMAS[id].currentVersion);
        }
        // The Knowledge lorebook store is NOT a manifest section — its
        // version lives inside the store itself (design §3.3).
        expect(manifest.sections.knowledgeStore).toBeUndefined();
    });

    test('collect → restore → re-collect round-trips canonical data unchanged', async () => {
        // Seed a chat whose stores are already canonical v1, export it, wipe
        // the metadata, restore, and re-export: the second envelope's sections
        // must equal the first's — the round trip is stable, and the manifest
        // stamp survives the second export path without altering data.
        const meta = getFakeMeta();
        const canonical = canonicalMetadata();
        for (const [name, value] of Object.entries(canonical)) {
            meta[STORE_SCHEMAS[name].metadataKey] = structuredClone(value);
        }
        const first = await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(Object.keys(first.sections).sort()).toEqual([
            'chronicle', 'interiority', 'knowledgeCounters', 'knowledgeEvidence', 'storyPlanner', 'worldState',
        ]);

        // Wipe every MWT key, then restore from the first envelope.
        for (const schema of Object.values(STORE_SCHEMAS)) {
            if (schema.metadataKey) delete meta[schema.metadataKey];
        }
        delete meta[MANIFEST_METADATA_KEY];

        const restored = await restoreBackup(first, { confirm: true, modes: { restoreSessionConfig: true } });
        expect(restored).toMatchObject({ ok: true, committed: true });

        const second = await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(second.sections).toEqual(first.sections);
        // The manifest stamped by the restore is still there after the second
        // export — collection never disturbs it.
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.worldState).toBe(STORE_SCHEMAS.worldState.currentVersion);
    });

    test('quarantine recovery data rides with the export and merges on restore (§5.3)', async () => {
        const meta = getFakeMeta();
        // A REAL quarantine item (fingerprint computed from the raw record, so
        // the recovery import canonicalizes it to the same id).
        const seeded = makeQuarantineItem({
            store: 'chronicle',
            path: ['snapshots'],
            reasonCode: 'snapshot-missing-text',
            message: 'Snapshot text must be a non-empty string.',
            raw: { id: 'local', text: '' },
            detectedAt: 1,
            sourceVersion: 1,
        });
        meta[QUARANTINE_METADATA_KEY] = { version: 1, items: [seeded] };
        const envelope = await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(envelope.quarantine.items).toHaveLength(1);

        // A restore of that same envelope into the chat MERGES the recovery
        // data — the locally quarantined record survives (never replaced), and
        // dedup means no growth for records the chat already holds.
        const unrelated = makeQuarantineItem({
            store: 'worldState',
            path: ['text'],
            reasonCode: 'text-not-string',
            message: 'World State text must be a string.',
            raw: 7,
            detectedAt: 2,
            sourceVersion: 1,
        });
        meta[QUARANTINE_METADATA_KEY].items.push(unrelated);
        const restored = await restoreBackup(envelope, { confirm: true });
        expect(restored).toMatchObject({ ok: true, committed: true });
        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(items.map(item => item.id).sort()).toEqual([seeded.id, unrelated.id].sort());
    });

    test('a restore that detects invalid records persists them to quarantine in the commit', async () => {
        const file = backupFile({ knowledgeStore: undefined });
        file.sections.chronicle.data.snapshots.push({ id: 'bad', text: '' });

        const restored = await restoreBackup(file, { confirm: true });
        expect(restored).toMatchObject({ ok: true, committed: true });
        // The invalid snapshot was quarantined (kept out of the live store)…
        expect(getFakeMeta().session_chronicle_data.snapshots).toHaveLength(1);
        // …and its COMPLETE raw record is recoverable from the quarantine the
        // same transaction wrote (§5.2) — nothing was silently dropped.
        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(items).toHaveLength(1);
        expect(items[0].raw).toEqual({ id: 'bad', text: '' });
        expect(restored.preview.summary.chronicle.skipped).toHaveLength(1);
    });

    test('a failed persist rolls back data, manifest, and quarantine together (§7.3)', async () => {
        // Start from a chat with existing data AND an existing manifest stamp.
        const meta = getFakeMeta();
        meta.world_state_tracker_metadata = { text: 'current state' };
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { worldState: 1 } };
        meta[QUARANTINE_METADATA_KEY] = {
            version: 1,
            items: [{
                id: 'chronicle:aaaaaaaa', store: 'chronicle', path: [], reasonCode: 'x',
                message: 'existing quarantined record', raw: { keep: true }, detectedAt: 1,
                sourceVersion: 1, fingerprint: 'aaaaaaaa',
            }],
        };
        const manifestBefore = structuredClone(meta[MANIFEST_METADATA_KEY]);
        const quarantineBefore = structuredClone(meta[QUARANTINE_METADATA_KEY]);

        // The durable write fails AFTER the in-memory commit was staged.
        setFakeContextExtras({
            getCurrentChatId: () => 'chat-a',
            saveMetadata: async () => { throw new Error('disk full'); },
        });
        const file = backupFile({ knowledgeStore: undefined });
        const restored = await restoreBackup(file, { confirm: true });

        expect(restored).toMatchObject({ ok: false, committed: false, reason: 'metadata-persist-failed' });
        // All three keys reverted together: the manifest is never left ahead
        // of its data (§7.3), and the quarantine merge did not survive a
        // write that never reached disk.
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'current state' });
        expect(getFakeMeta()[MANIFEST_METADATA_KEY]).toEqual(manifestBefore);
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toEqual(quarantineBefore);
        // A pre-restore snapshot was still downloaded before the failure.
        expect(getFakeDownloadJsonCalls()).toHaveLength(1);
    });
});

// ─── Standalone imports route through module schemas (§8, Part 3) ────────────

describe('Part 3 — standalone imports route through module schemas', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        _clearCacheForTests();
        globalThis.SillyTavern = {
            getContext: () => ({ getCurrentChatId: () => 'chat-a' }),
        };
        setFakeContextExtras({ getCurrentChatId: () => 'chat-a' });
        setFakeChat([{ mes: 'hello' }]);
        _setCacheForTests('Knowledge Tracker', { registry: {}, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });
        // render.js wires these in production; the import path calls them.
        chronicleRender.renderContent = () => {};
        chronicleState._lastStatusMsg = '';
        chronicleState._lastStatusLevel = '';
    });

    afterEach(() => {
        _clearCacheForTests();
        _resetEpoch();
        delete globalThis.SillyTavern;
    });

    test('Chronicle import: valid entries merge by deterministic id, invalid ones quarantine', async () => {
        getFakeMeta().session_chronicle_data = {
            snapshots: [{ id: 'existing', text: 'current snapshot' }],
            _deletedBin: [],
        };
        const file = JSON.stringify({
            snapshots: [
                { text: 'imported snapshot', createdAt: '2025-01-01T00:00:00.000Z' },
                { id: 'bad', createdAt: '2025-01-02T00:00:00.000Z' },
            ],
        });
        setPickTextFileStub(async () => file);

        await triggerImport();

        const data = getFakeMeta().session_chronicle_data;
        expect(data.snapshots).toHaveLength(2);
        expect(data.snapshots[1].text).toBe('imported snapshot');
        expect(data.snapshots[1].id).toMatch(/^legacy-/);
        expect(chronicleState._lastStatusMsg).toContain('Imported 1 entries');
        expect(chronicleState._lastStatusMsg).toContain('1 skipped');
        // The rejected record is preserved whole for recovery (§5.2).
        const items = getFakeMeta()[QUARANTINE_METADATA_KEY]?.items || [];
        expect(items).toHaveLength(1);
        expect(items[0].store).toBe('chronicle');

        // Re-importing the same file is a no-op: the deterministic ids dedup.
        setPickTextFileStub(async () => file);
        await triggerImport();
        expect(getFakeMeta().session_chronicle_data.snapshots).toHaveLength(2);
        expect(chronicleState._lastStatusMsg).toContain('Imported 0 entries');
    });

    test('World State archive import validates through the worldState schema', () => {
        const archive = JSON.stringify({
            _meta: { type: 'world-state-archive', version: '1.0' },
            data: {
                text: 'imported world state',
                // Invalid history does not block the import — the schema
                // quarantines it and only the canonical text proceeds.
                autoSaveHistory: 'garbage',
            },
        });
        const result = parseWorldStateImport(archive);
        expect(result.ok).toBe(true);
        expect(result.kind).toBe('text');
        expect(result.text).toBe('imported world state');

        // A non-string text is refused rather than coerced.
        const badArchive = JSON.stringify({
            _meta: { type: 'world-state-archive', version: '1.0' },
            data: { text: 12345 },
        });
        expect(parseWorldStateImport(badArchive).ok).toBe(false);
    });

    test('Knowledge staging import refuses registry records the schema rejects', async () => {
        const file = JSON.stringify({
            version: 1,
            type: 'knowledge_tracker',
            entries: {
                'Valid NPC': { uid: null, type: 'minor', keywords: ['Valid NPC'], content: 'dossier' },
                'Broken uid': { uid: -3, type: 'minor', keywords: ['Broken uid'] },
            },
        });
        setPickTextFileStub(async () => file);

        await importNpcs();

        const registry = getRegistry();
        expect(registry['Valid NPC']).toBeTruthy();
        expect(registry['Valid NPC'].type).toBe('minor');
        // A negative uid is never valid live state: refused whole (skip+warn),
        // never written into the registry.
        expect(registry['Broken uid']).toBeUndefined();
    });
});

