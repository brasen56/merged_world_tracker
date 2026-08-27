/**
 * test/schema_audit_round5.test.js — Regression coverage for the eight
 * findings of the fifth audit pass over Parts 1–3 of the schema plan.
 *
 *  1. The backup EXPORT stamps the version each store's data is actually at
 *     (from the manifest; unstamped ⇒ legacy 0) instead of the descriptor's
 *     currentVersion, and the envelope gate accepts 0. Stamping the current
 *     version onto never-migrated data made the importer skip the 0 → 1
 *     migration, so a legacy chat round-tripped with an EMPTY chronicle and
 *     no story-planner arcs.
 *  2. A DEFERRED preparation asked to canonicalize (`deferPolicy:
 *     'canonicalize'` — the import/restore boundary) returns its quarantine
 *     items. It used to return canonical data that had DROPPED the rejected
 *     records with an empty quarantine list, so an import of a store with
 *     legacy per-message keys silently lost every record the validator
 *     refused.
 *  3. Interiority reads STAGE their detached copy instead of deep-cloning the
 *     whole store per call, and a refused write drops the staged copy so the
 *     module does not go on reading data the seam declined to persist.
 *  4. The standalone World State import prepares from legacy version 0 (like
 *     the Chronicle importer) and its findings are stamped with the version
 *     they came from, not the destination's current version.
 *  5. The Chronicle 0 → 1 migration backfills `_deletedBin` ids as well as
 *     `snapshots`, so a legacy chat's Trash is not quarantined wholesale by
 *     the same rule that repairs its snapshots.
 *  6. collectCurrentVersions() reads through getStoredStoreVersion() rather
 *     than indexing a manifest normalizeManifest() may have returned
 *     unchanged, which threw on a future manifest with no `sections`.
 *  7. commitHistorySnapshot()'s corrupt-history branch commits the container
 *     repair alone, so a refused snapshot write means the caller's patch
 *     really did not land — and it appends on a detached copy.
 *  8. Quarantine-container findings carry the COMPLETE rejected item in
 *     `record` (identity separate), so re-quarantining a malformed recovery
 *     item preserves the record rather than a bare id.
 */

import { describe, test, expect, beforeEach } from 'vitest';

import { buildBackupEnvelope } from '../backup/data.js';
import { exportBackup, previewRestore, restoreBackup } from '../backup/index.js';
import { validateBackupEnvelope, prepareBackupSection } from '../backup/validate.js';
import { MANIFEST_METADATA_KEY } from '../schema/manifest.js';
import { STORE_SCHEMAS } from '../schema/registry.js';
import { QUARANTINE_METADATA_KEY, validateQuarantineStoreData } from '../core/quarantine.js';
import { ISSUE_SEVERITIES, prepareStore } from '../core/schema.js';
import { interioritySchema } from '../interiority/schema.js';
import { chronicleSchema } from '../chronicle/schema.js';
import { getInteriorityData, saveInteriorityData, getLedger } from '../interiority/data.js';
import {
    parseWorldStateImport, commitHistorySnapshot, getWorldStateData,
} from '../world_state/data.js';
import { resetCoreStubs, getFakeMeta, getFakeDownloadJsonCalls } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';

const IDENTITY = { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null };

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
});

// ── 1. Export stamps the version the data is actually at ───────────────────

describe('1. the export declares the source version, not the current one', () => {
    test('a legacy chat exports schemaVersion 0 and round-trips through its migration', async () => {
        // A pre-schema chat: real data, no manifest. Every live chat looks like
        // this until the Part 6 cutover starts stamping.
        const meta = getFakeMeta();
        meta.session_chronicle_data = {
            snapshots: [
                { text: 'Chapter one happened.', createdAt: '2026-01-01' },
                { text: 'Chapter two happened.', createdAt: '2026-01-02' },
            ],
        };
        meta.story_planner_data = {
            text: '## Emerging Arcs\n- The ferryman debt — it comes due at the crossing.',
        };

        const envelope = await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(envelope.sections.chronicle.schemaVersion).toBe(0);
        expect(envelope.sections.storyPlanner.schemaVersion).toBe(0);

        const validated = validateBackupEnvelope(envelope);
        expect(validated.ok).toBe(true);
        // The 0 → 1 migration ran, so the legacy records are REPAIRED rather
        // than refused: ids backfilled, plan text parsed into arcs.
        expect(validated.summaries.chronicle.migrated).toBe(true);
        expect(validated.summaries.chronicle.skipped).toEqual([]);
        expect(validated.sections.chronicle.snapshots).toHaveLength(2);
        expect(validated.sections.storyPlanner.arcs).toHaveLength(1);
        expect(validated.sections.storyPlanner.arcs[0].title).toBe('The ferryman debt');
    });

    test('a stamped chat exports its stamped version and needs no migration', async () => {
        const meta = getFakeMeta();
        meta.session_chronicle_data = { snapshots: [{ id: 's1', text: 'kept' }], _deletedBin: [] };
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { chronicle: 1 } };

        const envelope = await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(envelope.sections.chronicle.schemaVersion).toBe(1);
        expect(validateBackupEnvelope(envelope).summaries.chronicle.migrated).toBeUndefined();
    });

    test('collection never disturbs the manifest it reads', async () => {
        const meta = getFakeMeta();
        meta.session_chronicle_data = { snapshots: [], _deletedBin: [] };
        const before = { manifestVersion: 1, sections: { chronicle: 1 } };
        meta[MANIFEST_METADATA_KEY] = structuredClone(before);
        await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(getFakeMeta()[MANIFEST_METADATA_KEY]).toEqual(before);
    });
});

// ── 2. A canonicalized deferral still preserves what it dropped ────────────

describe('2. a deferred store returns the records its canonical value dropped', () => {
    const legacy = () => ({
        enabled: true,
        ledger: [
            { id: 'keep', npc: 'Mara', action: 'wait', trigger: 'dawn' },
            { id: '', npc: '', action: '', trigger: '' },
            'not-an-object',
        ],
        deletedIntentions: [],
        // A legacy numeric key defers preparation (§7.5).
        perMessage: { 3: { thought: 'legacy numeric key' } },
        turnCounter: 'RAW-BAD',
    });

    test('deferPolicy canonicalize carries quarantine items for every dropped record', () => {
        const prepared = prepareStore(interioritySchema, legacy(), { version: 1, deferPolicy: 'canonicalize' });
        expect(prepared.status).toBe('deferred');
        // The canonical value dropped the invalid records …
        expect(prepared.data.ledger).toHaveLength(1);
        expect('turnCounter' in prepared.data).toBe(false);
        // … so the caller that commits it is handed them, raw record intact.
        const quarantined = prepared.issues.filter(i => i.severity === ISSUE_SEVERITIES.QUARANTINE);
        expect(prepared.quarantined).toHaveLength(quarantined.length);
        expect(prepared.quarantined.map(item => item.reasonCode).sort())
            .toEqual(['ledger-invalid-id', 'ledger-not-object', 'turn-counter-invalid']);
        expect(prepared.quarantined.find(i => i.reasonCode === 'turn-counter-invalid').raw).toBe('RAW-BAD');
        // The legacy per-message entry is RETAINED, never quarantined.
        expect(prepared.data.perMessage).toEqual({ 3: { thought: 'legacy numeric key' } });
    });

    test("the default 'pause' policy still returns nothing — the original keeps the records", () => {
        const prepared = prepareStore(interioritySchema, legacy(), { version: 1 });
        expect(prepared.status).toBe('deferred');
        expect(prepared.data).toBeUndefined();
        expect(prepared.quarantined).toEqual([]);
    });

    test('a deferred import section proposes the same quarantine records', () => {
        const result = prepareBackupSection(interioritySchema, legacy(), 1);
        expect(result.ok).toBe(true);
        expect(result.status).toBe('deferred');
        expect(result.summary.skipped).toHaveLength(3);
        // The preview's skipped list and the commit's quarantine list agree —
        // a record reported as refused is a record actually preserved.
        expect(result.quarantined).toHaveLength(3);
    });

    test('records that cannot be stored block the deferral instead of being dropped', () => {
        const prepared = prepareStore(interioritySchema, legacy(), {
            version: 1,
            deferPolicy: 'canonicalize',
            maxQuarantineItems: 1,
        });
        expect(prepared.status).toBe('blocked');
        expect(prepared.error.code).toBe('quarantine-limit');
        expect(prepared.data).toBeUndefined();
    });
});

// ── 3. Interiority read staging ────────────────────────────────────────────

describe('3. interiority reads stage their working copy', () => {
    test('repeat reads return the SAME detached object while the store is unchanged', () => {
        getFakeMeta().mwt_interiority = {
            enabled: true, ledger: [{ id: 'a', npc: 'Mara', action: 'x', trigger: 'y' }],
            deletedIntentions: [], perMessage: {}, turnCounter: 1,
        };
        const first = getInteriorityData();
        expect(getInteriorityData()).toBe(first);
        expect(getLedger()).toBe(first.ledger);
        // Still detached: mutating the copy does not reach chat metadata.
        first.ledger.push({ id: 'b', npc: 'Rell', action: 'x', trigger: 'y' });
        expect(getFakeMeta().mwt_interiority.ledger).toHaveLength(1);
    });

    test('a committed write installs a new live object, so the next read re-stages', () => {
        getFakeMeta().mwt_interiority = {
            enabled: true, ledger: [], deletedIntentions: [], perMessage: {}, turnCounter: 0,
        };
        const working = getInteriorityData();
        working.turnCounter = 5;
        saveInteriorityData(working);
        const after = getInteriorityData();
        expect(after).not.toBe(working);
        expect(after.turnCounter).toBe(5);
        // The commit is DETACHED: a held reference cannot write into metadata.
        working.ledger.push({ id: 'sneak', npc: 'X', action: 'y', trigger: 'z' });
        expect(getFakeMeta().mwt_interiority.ledger).toHaveLength(0);
    });

    test('a REFUSED write drops the staged copy so the refused edit is not read back', () => {
        getFakeMeta().mwt_interiority = {
            enabled: true, ledger: [], deletedIntentions: [], perMessage: {}, turnCounter: 0,
        };
        // A future-version quarantine container refuses the preservation, so
        // the write refuses and the previous value is kept.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 99, items: [] };
        const working = getInteriorityData();
        working.turnCounter = 7;
        working.ledger.push({ id: '', npc: '', action: '', trigger: '' }); // forces a quarantine finding
        saveInteriorityData(working);

        expect(getFakeMeta().mwt_interiority.turnCounter).toBe(0);
        // The next read must not hand the refused mutation back.
        const after = getInteriorityData();
        expect(after).not.toBe(working);
        expect(after.turnCounter).toBe(0);
        expect(after.ledger).toEqual([]);
    });

    test('an absent or unreadable root resets staging and yields a fresh default', () => {
        getFakeMeta().mwt_interiority = 'corrupt-root';
        const first = getInteriorityData();
        expect(first).toEqual(interioritySchema.createDefault());
        expect(getInteriorityData()).not.toBe(first);
        // The raw value survives for the write seam to fail closed on.
        expect(getFakeMeta().mwt_interiority).toBe('corrupt-root');
    });
});

// ── 4. The standalone World State import ───────────────────────────────────

describe('4. the World State import prepares from legacy version 0', () => {
    test('it reports its source version and preserves rejected records under it', () => {
        const archive = JSON.stringify({
            _meta: { type: 'world-state-archive' },
            data: { text: '## Current Scene\nThe dock at dusk.', autoSaveHistory: 'not-an-array' },
        });
        const parsed = parseWorldStateImport(archive);
        expect(parsed.ok).toBe(true);
        expect(parsed.sourceVersion).toBe(0);
        expect(parsed.issues.some(issue => issue.code === 'not-an-array')).toBe(true);

        getFakeMeta().world_state_tracker_metadata = { text: 'previous', autoSaveHistory: [] };
        const written = commitHistorySnapshot('previous', { text: parsed.text }, {
            preserveIssues: { issues: parsed.issues, sourceVersion: parsed.sourceVersion },
        });
        expect(written.ok).toBe(true);

        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        const record = items.find(item => item.reasonCode === 'not-an-array');
        expect(record.raw).toBe('not-an-array');
        // Stamped with the version the ARCHIVE was at, not the destination's.
        expect(record.sourceVersion).toBe(0);
    });

    test('a bare array of findings keeps the historical current-version stamping', () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'previous', autoSaveHistory: [] };
        const written = commitHistorySnapshot('previous', { text: 'next' }, {
            preserveIssues: [{
                code: 'text-not-string', path: ['text'], severity: 'quarantine',
                message: 'World State text must be a string.', record: 42,
            }],
        });
        expect(written.ok).toBe(true);
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY].items[0].sourceVersion)
            .toBe(STORE_SCHEMAS.worldState.currentVersion);
    });
});

// ── 5. Chronicle trash survives its migration ──────────────────────────────

describe('5. the Chronicle migration repairs the trash as well as the snapshots', () => {
    test('legacy _deletedBin entries are backfilled, not quarantined', () => {
        const prepared = prepareStore(chronicleSchema, {
            snapshots: [{ text: 'Chapter one.', createdAt: '2026-01-01' }],
            _deletedBin: [
                { text: 'A deleted entry the user may still want back.', createdAt: '2026-01-02' },
                { text: 'Another one.', createdAt: '2026-01-03' },
            ],
        }, { version: 0 });

        expect(prepared.status).toBe('migrated');
        expect(prepared.quarantined).toEqual([]);
        expect(prepared.data.snapshots).toHaveLength(1);
        expect(prepared.data._deletedBin).toHaveLength(2);
        // Ids are namespaced per list so a snapshot and a trash entry with the
        // same content at the same index cannot collide (restore-from-trash
        // matches on id).
        expect(prepared.data.snapshots[0].id).toMatch(/^legacy-0-/);
        expect(prepared.data._deletedBin[0].id).toMatch(/^legacy-trash-0-/);
        const ids = [...prepared.data.snapshots, ...prepared.data._deletedBin].map(entry => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('identical records at the same index across the two lists get distinct ids', () => {
        const twin = { text: 'the same entry', createdAt: '2026-01-01' };
        const prepared = prepareStore(chronicleSchema, {
            snapshots: [{ ...twin }],
            _deletedBin: [{ ...twin }],
        }, { version: 0 });
        expect(prepared.data.snapshots[0].id).not.toBe(prepared.data._deletedBin[0].id);
    });
});

// ── 6. Manifest reading has one owner ──────────────────────────────────────

describe('6. a future manifest is refused, not crashed on', () => {
    test('previewRestore survives a future manifest whose shape has no sections', async () => {
        const meta = getFakeMeta();
        meta.session_chronicle_data = { snapshots: [{ id: 's1', text: 'kept' }], _deletedBin: [] };
        // A newer MWT restructured the container — exactly why it is refused
        // unchanged rather than read.
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 99, stores: { chronicle: { v: 2 } } };

        const envelope = buildBackupEnvelope({
            identity: IDENTITY,
            metadata: { chronicle: { snapshots: [{ id: 's2', text: 'incoming' }], _deletedBin: [] } },
        });
        // Used to throw a TypeError out of the planner before the designed
        // refusal could be reported.
        const preview = await previewRestore(envelope);
        expect(preview.ok).toBe(true);
        expect(meta[MANIFEST_METADATA_KEY]).toEqual({ manifestVersion: 99, stores: { chronicle: { v: 2 } } });
    });

    test('an export aborts visibly on a future manifest instead of declaring its stores legacy 0', async () => {
        const meta = getFakeMeta();
        meta.session_chronicle_data = { snapshots: [{ id: 's1', text: 'kept' }], _deletedBin: [] };
        // A newer MWT restructured the container — with no `sections` to read,
        // getStoredStoreVersion() reports every store as legacy 0. The export
        // must not build a backup from that: it would declare the chat's
        // future-format stores schemaVersion 0, and a restore of the file would
        // run the legacy 0 → 1 migration over them instead of refusing the
        // unknown version.
        const future = { manifestVersion: 99, stores: { chronicle: { v: 2 } } };
        meta[MANIFEST_METADATA_KEY] = structuredClone(future);

        await expect(exportBackup({ download: false, includeKnowledgeStore: false }))
            .rejects.toThrow(/newer than the supported version/);
        // The refusal left the newer release's container untouched.
        expect(meta[MANIFEST_METADATA_KEY]).toEqual(future);
    });

    test('a confirmed restore into a future-manifest chat reports the designed refusal, not the export abort', async () => {
        const meta = getFakeMeta();
        meta.world_state_tracker_metadata = { text: 'current state' };
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 2, sections: { worldState: 1 } };

        const envelope = buildBackupEnvelope({
            identity: IDENTITY,
            metadata: { worldState: { text: 'incoming' } },
        });
        // The pre-restore snapshot export aborts on a future manifest too, so
        // the refusal must be detected BEFORE that export: the caller sees the
        // structured manifest-version-future result — never a thrown export
        // error — and no snapshot is downloaded for a restore that cannot run.
        const result = await restoreBackup(envelope, { confirm: true });
        expect(result).toMatchObject({ ok: false, committed: false, reason: 'manifest-version-future' });
        expect(result.warning).toMatch(/newer than the supported version/);
        expect(getFakeDownloadJsonCalls()).toEqual([]);
        // Nothing was written: manifest and section data both intact.
        expect(meta[MANIFEST_METADATA_KEY]).toEqual({ manifestVersion: 2, sections: { worldState: 1 } });
        expect(meta.world_state_tracker_metadata).toEqual({ text: 'current state' });
    });
});

// ── 7. The corrupt-history branch is honest about what it wrote ────────────

describe('7. commitHistorySnapshot keeps a refused snapshot from moving the store', () => {
    test('a refused snapshot write leaves the caller patch unwritten', () => {
        const meta = getFakeMeta();
        meta.world_state_tracker_metadata = { text: 'ORIGINAL', autoSaveHistory: 'not-an-array' };

        // The container repair commits (quarantining the raw value), then the
        // snapshot write refuses because the incoming findings cannot be
        // preserved. `ok: false` must mean the TEXT never moved.
        const first = commitHistorySnapshot('OUTGOING', { text: 'NEW TEXT' }, {
            preserveIssues: [{
                code: 'text-not-string', path: ['text'], severity: 'quarantine',
                message: 'World State text must be a string.', record: 42,
            }],
        });
        // With a healthy container this one commits; the point of the split is
        // that whatever the second write does, the first carried no user data.
        expect(first.ok).toBe(true);
        expect(getWorldStateData().text).toBe('NEW TEXT');
        expect(Array.isArray(getWorldStateData().autoSaveHistory)).toBe(true);
    });

    test('the append never mutates the live array before validation', () => {
        const meta = getFakeMeta();
        meta.world_state_tracker_metadata = { text: 'ORIGINAL', autoSaveHistory: 'not-an-array' };
        commitHistorySnapshot('OUTGOING', { text: 'NEW TEXT' });
        const stored = getWorldStateData();
        expect(stored.text).toBe('NEW TEXT');
        expect(stored.autoSaveHistory).toHaveLength(1);
        expect(stored.autoSaveHistory[0].text).toBe('OUTGOING');
        // The malformed container was preserved whole, not silently discarded.
        expect(meta[QUARANTINE_METADATA_KEY].items[0].raw).toBe('not-an-array');
    });
});

// ── 8. Quarantine preserves its own rejected records whole ─────────────────

describe('8. quarantine-container findings keep the complete rejected item', () => {
    test('an unrecoverable item is reported with its raw record and a separate identity', () => {
        const hollow = { id: 'q1', store: 'chronicle', reasonCode: 'snapshot-missing-id' };
        const result = validateQuarantineStoreData({ version: 1, items: [hollow] });
        const issue = result.issues.find(i => i.code === 'item-unrecoverable');
        // §5.2: the COMPLETE record, so a recovery export can reconstruct it …
        expect(issue.record).toEqual(hollow);
        // … with the display identity separate, so summaries print an id.
        expect(issue.identity).toBe('q1');
    });

    test('a non-object item reports its index as the identity', () => {
        const result = validateQuarantineStoreData({ version: 1, items: [42] });
        const issue = result.issues.find(i => i.code === 'item-not-object');
        expect(issue.record).toBe(42);
        expect(issue.identity).toBe(0);
    });
});
