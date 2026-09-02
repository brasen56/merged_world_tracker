/**
 * test/restore_quarantine_integrity.test.js — Regression coverage for the
 * nine first-round integrity fixes:
 *
 *   1. planRestore re-prepares every COMPLETED section (merges can copy
 *      malformed records out of the current store; keep/skip returns the
 *      current value wholesale) and the commit stamps only sections the
 *      restore canonically rewrote.
 *   2. A restore PREFLIGHTS the destination manifest before any write, and
 *      every metadata mutation/bookkeeping step runs inside the
 *      rollback-guarded block.
 *   3. prepareNextStoreValue fails closed on a present non-object root
 *      instead of substituting the canonical default.
 *   4. preserveQuarantinedRecords refuses (never downgrades) a future-version
 *      chat quarantine container.
 *   5. Knowledge quarantine findings are committed INSIDE the affected
 *      lorebook store(s), never the chat-local container (§5.1).
 *   6. A future-version chat quarantine container refuses the restore
 *      unchanged before any transaction write.
 *   7. parseWorldStateImport returns its schema findings so the import commit
 *      can preserve the rejected raw values (§5.2).
 *   8. A refused Knowledge NPC import record is quarantined inside the
 *      affected lorebook store; the import blocks if preserving fails.
 *   9. (test/schema_perf_harness.test.js — the harness itself now enforces
 *      the §7.2 migration budget with a p95 tail, not the median.)
 *
 * Round 2 (the later four bugs):
 *
 *  10. A blocked CURRENT preparation (fatal root, future declared version)
 *      makes the section unwritable immediately — the merge helpers can no
 *      longer normalize the raw value into a valid replacement.
 *  11. A DEFERRED completed value (Interiority legacy per-message keys) is
 *      retained but never stamped current, and the commit withholds any
 *      existing stamp (§7.5).
 *  12. A malformed chat quarantine container refuses the restore at preflight
 *      and at commit (same writable-container rule), instead of being
 *      replaced by the canonical merge.
 *  13. The World State import uses a checked write: a refused store write
 *      reports failure and keeps the previous value instead of "Imported.".
 *
 * Round 3 (four later bugs):
 *
 *  14. Exact planning preserves the planner's blocked destination sections —
 *      no overwrite, no removal — and derives deferral solely from the exact
 *      value being committed, so a clean exact replacement is stamped even
 *      when the outgoing store was deferred.
 *  15. History capture no longer mutates the stored array before validation:
 *      the snapshot and the requested text change commit in ONE checked
 *      patch (commitHistorySnapshot), a malformed stored history cannot
 *      throw, and a refused write leaves the retained store untouched.
 *  16. A blocked section's merge summary reports zero prospective counts —
 *      the preview describes the actual write plan, never an addition that
 *      cannot occur.
 *
 * Round 4 (three later bugs):
 *
 *  17. The World State import passes the archive's schema findings INTO the
 *      checked commit, so the destination is validated before the quarantine
 *      container is touched: a refused import mutates neither the store nor
 *      the container, and a committed one preserves the rejected records in
 *      the same write. (The regenerateSection checked-commit fix from the
 *      same round is covered in test/remediation_followups.test.js.)
 *  18. A removal-only blocked section (present only in the destination, so
 *      the merge planner never examined it) keeps its refusal reason in the
 *      exact summary's skipped list.
 *
 * Round 5 (two later bugs):
 *
 *  19. The Chronicle import uses a checked write carrying the import file's
 *      findings: a refused store write mutates neither the store, the
 *      quarantine container, nor module/UI state, and never reports success;
 *      a committed one preserves the refused snapshots in the same write.
 *  20. Interiority reads no longer canonicalize live metadata (a falsey
 *      invalid root or an invalid ledger/perMessage/deletedIntentions
 *      container is never repaired in place), and the checked write
 *      quarantines the raw values it displaces or fails closed on an
 *      unreadable root. Chronicle and Knowledge evidence reads initialize
 *      only genuinely-absent roots under the same rule.
 *
 * Round 7 (completing the evidence staged-commit fix):
 *
 *  21. A committed evidence write stays fully DETACHED from the staged copy:
 *      the validator's canonical output shares its nested objects (file meta
 *      containers, accepted records) with the staged input, so the commit
 *      writes a detached clone and never aliases the staged graph into chat
 *      metadata — held staged references (a file's meta, a raw record, a
 *      tier) cannot reach metadata before the next save validates them.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { buildBackupEnvelope } from '../backup/data.js';
import { exportBackup, previewRestore, restoreBackup } from '../backup/index.js';
import { MANIFEST_METADATA_KEY } from '../schema/manifest.js';
import { STORE_SCHEMAS } from '../schema/registry.js';
import { QUARANTINE_METADATA_KEY } from '../core/quarantine.js';
import { prepareNextStoreValue } from '../core/schema.js';
import { preserveQuarantinedRecords } from '../core/index.js';
import {
    parseWorldStateImport, getWorldStateText, setWorldStateData, setWorldStateDataChecked,
    pushToHistory, commitHistorySnapshot,
} from '../world_state/data.js';
import { worldStateSchema } from '../world_state/schema.js';
import { importNpcs } from '../knowledge/staging.js';
import { getRegistry } from '../knowledge/registry.js';
import { getEvidenceMap, saveEvidenceMap } from '../knowledge/evidence.js';
import { triggerImport } from '../chronicle/import-export.js';
import { _render as chronicleRender, state as chronicleState, getChronicleData, setChronicleDataChecked } from '../chronicle/data.js';
import {
    getInteriorityData, addLedgerEntry, addManualLedgerEntry, getLedger, getDeletedIntentions,
    incrementTurnCounter,
} from '../interiority/data.js';
import {
    _clearCacheForTests,
    _setCacheForTests,
    getStoreQuarantineContainerStatus,
    getStoreQuarantineItems,
} from '../knowledge/store.js';
import { state as knowledgeState } from '../knowledge/state.js';
import {
    resetCoreStubs,
    setFakeChat,
    setFakeContextExtras,
    getFakeMeta,
    setPickTextFileStub,
} from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';

const IDENTITY = { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null };
// identityMatches() (backup/index.js) compares the stable `key`, so exact
// restores need the same-chat identity that getChatIdentity() resolves for
// the stubbed chat id 'chat-a'.
const SAME_CHAT_IDENTITY = { ...IDENTITY, key: 'chat:chat-a' };

function backupFile(overrides = {}) {
    return buildBackupEnvelope({
        identity: IDENTITY,
        metadata: {
            chronicle: { snapshots: [{ id: 's1', text: 'incoming snapshot' }], _deletedBin: [] },
        },
        ...overrides,
    });
}

function fakeWorldInfo() {
    return {
        loadWorldInfo: async () => ({ entries: {} }),
        saveWorldInfo: async () => {},
    };
}

describe('restore/quarantine integrity fixes', () => {
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

    // ── Bug 1: the completed plan is revalidated ───────────────────────────

    test('a merge quarantines malformed records copied from the CURRENT store and stamps the section', async () => {
        getFakeMeta().session_chronicle_data = {
            snapshots: [
                { id: 'keep', text: 'current snapshot' },
                { id: 'bad', text: '' },
            ],
            _deletedBin: [],
        };

        const result = await restoreBackup(backupFile(), { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The malformed CURRENT record was quarantined out of the merged
        // section (previously it survived the merge and was stamped v1)…
        const data = getFakeMeta().session_chronicle_data;
        expect(data.snapshots.map(snapshot => snapshot.id)).toEqual(['keep', 's1']);
        // …and preserved whole in the chat-local quarantine the SAME commit
        // wrote (§5.2) — nothing was silently dropped.
        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(items).toHaveLength(1);
        expect(items[0].store).toBe('chronicle');
        expect(items[0].raw).toEqual({ id: 'bad', text: '' });
        // The finding is visible in the preview, not swallowed.
        expect(result.preview.summary.chronicle.skipped.some(skip => /snapshot/i.test(skip.reason))).toBe(true);
        // The section the restore canonically rewrote IS stamped.
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.chronicle)
            .toBe(STORE_SCHEMAS.chronicle.currentVersion);
    });

    test('a keep-mode section that makes no canonical change is written no manifest stamp', async () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'current state', autoSaveHistory: [] };
        const file = backupFile({
            metadata: {
                chronicle: { snapshots: [{ id: 's1', text: 'incoming snapshot' }], _deletedBin: [] },
                worldState: { text: 'backup state' },
            },
        });

        const result = await restoreBackup(file, { confirm: true, modes: { worldState: 'keep' } });
        expect(result).toMatchObject({ ok: true, committed: true });

        expect(getFakeMeta().world_state_tracker_metadata.text).toBe('current state');
        const sections = getFakeMeta()[MANIFEST_METADATA_KEY].sections;
        // The canonically rewritten section is stamped…
        expect(sections.chronicle).toBe(STORE_SCHEMAS.chronicle.currentVersion);
        // …the keep/skip no-op section is NOT: the manifest may never claim a
        // version for data this restore never prepared.
        expect(sections.worldState).toBeUndefined();
    });

    test('a fatal keep/skip current root is left unwritten and unstamped (fail closed)', async () => {
        getFakeMeta().world_state_tracker_metadata = 'CORRUPT ROOT';
        const file = backupFile({
            metadata: {
                chronicle: { snapshots: [{ id: 's1', text: 'incoming snapshot' }], _deletedBin: [] },
                worldState: { text: 'backup state' },
            },
        });

        const result = await restoreBackup(file, { confirm: true, modes: { worldState: 'keep' } });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The unreadable root survived untouched — no fresh canonical store
        // was committed over it, and no stamp claims a version for it. Keep
        // mode no longer even inspects the kept value (repairing it would be
        // an integrity repair the preview never offered), so the summary
        // reports only that the section was kept.
        expect(getFakeMeta().world_state_tracker_metadata).toBe('CORRUPT ROOT');
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.worldState).toBeUndefined();
        expect(result.preview.summary.worldState.skipped
            .some(skip => /not replaced \(keep\)/.test(skip.reason))).toBe(true);
        // The other sections still restored (a kept store blocks only
        // itself, §3.5).
        expect(getFakeMeta().session_chronicle_data.snapshots).toHaveLength(1);
    });

    // ── Keep/skip never writes the section ────────────────────

    test('keep mode leaves an invalid field in the kept section untouched — no repair, no quarantine, no stamp', async () => {
        getFakeMeta().world_state_tracker_metadata = {
            text: 'current state',
            autoSaveHistory: 'garbage-not-an-array',
        };
        const file = backupFile({
            metadata: {
                worldState: { text: 'backup state' },
            },
        });

        const result = await restoreBackup(file, { confirm: true, modes: { worldState: 'keep' } });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The kept value is EXACTLY as stored — the invalid autoSaveHistory
        // was not removed, nothing was quarantined, and no manifest stamp
        // claims a version for it. Integrity repair is a separate operation.
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({
            text: 'current state',
            autoSaveHistory: 'garbage-not-an-array',
        });
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toBeUndefined();
        expect(getFakeMeta()[MANIFEST_METADATA_KEY]?.sections?.worldState).toBeUndefined();
    });

    // ── The destination half is migrated before merging ───────

    test('a legacy v0 Chronicle snapshot is migrated (deterministic id) instead of quarantined', async () => {
        // A legacy destination: no manifest stamp ⇒ version 0, and its
        // snapshot predates the id requirement.
        getFakeMeta().session_chronicle_data = {
            snapshots: [{ text: 'legacy snapshot without an id' }],
            _deletedBin: [],
        };

        const result = await restoreBackup(backupFile(), { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The legacy snapshot was MIGRATED — its deterministic backfilled id
        // let it survive the merge as a live record…
        const snapshots = getFakeMeta().session_chronicle_data.snapshots;
        expect(snapshots).toHaveLength(2);
        const legacy = snapshots.find(snapshot => snapshot.text === 'legacy snapshot without an id');
        expect(legacy?.id).toMatch(/^legacy-0-/);
        // …instead of being quarantined inactive with the wrong sourceVersion.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toBeUndefined();
        // The migration the restore persisted IS a canonical write: stamped.
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.chronicle)
            .toBe(STORE_SCHEMAS.chronicle.currentVersion);
    });

    // ── Bug 2: destination manifest preflight ──────────────────────────────

    test('a future-version destination manifest refuses the restore unchanged before any write', async () => {
        const futureManifest = { manifestVersion: 2, sections: { worldState: 1 } };
        getFakeMeta()[MANIFEST_METADATA_KEY] = structuredClone(futureManifest);
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };
        _setCacheForTests('Knowledge Tracker', { registry: { Mara: { uid: 7 } }, relationships: {} });

        const result = await restoreBackup(backupFile(), { confirm: true });

        expect(result).toMatchObject({ ok: false, committed: false, reason: 'manifest-version-future' });
        expect(result.warning).toMatch(/newer than the supported version/);
        // Nothing was written: manifest intact, metadata intact, store intact.
        expect(getFakeMeta()[MANIFEST_METADATA_KEY]).toEqual(futureManifest);
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'current state' });
        expect(getRegistry().Mara).toEqual({ uid: 7 });
    });

    // ── Bug 6: destination quarantine container preflight ──────────────────

    test('a future-version chat quarantine container refuses a quarantine-merging restore unchanged (no downgrade)', async () => {
        const futureContainer = {
            version: 9,
            items: [{
                id: 'chronicle:deadbeef', store: 'chronicle', reasonCode: 'x',
                message: 'from a newer MWT', raw: { future: true }, detectedAt: 1,
                sourceVersion: null, fingerprint: 'deadbeef',
            }],
        };
        getFakeMeta()[QUARANTINE_METADATA_KEY] = structuredClone(futureContainer);
        // The import itself carries an invalid record (a snapshot with empty
        // text), so the plan MUST merge into the chat-local quarantine
        // container to preserve it — that is the restore the refusal guards.
        const file = backupFile({
            metadata: {
                chronicle: {
                    snapshots: [
                        { id: 's1', text: 'ok snapshot' },
                        { id: 'bad', text: '' },
                    ],
                    _deletedBin: [],
                },
            },
        });

        const result = await restoreBackup(file, { confirm: true });

        expect(result).toMatchObject({ ok: false, committed: false, reason: 'quarantine-version-future' });
        // The container was left EXACTLY as found — not normalized, not
        // re-stamped v1, its records not merged into.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toEqual(futureContainer);
        // The restore never reached the metadata writes.
        expect(getFakeMeta().session_chronicle_data).toBeUndefined();
    });

    test('a clean restore is not blocked by an unrelated future chat quarantine container', async () => {
        const futureContainer = {
            version: 9,
            items: [{
                id: 'chronicle:deadbeef', store: 'chronicle', reasonCode: 'x',
                message: 'from a newer MWT', raw: { future: true }, detectedAt: 1,
                sourceVersion: null, fingerprint: 'deadbeef',
            }],
        };
        getFakeMeta()[QUARANTINE_METADATA_KEY] = structuredClone(futureContainer);
        // A clean backup: no quarantine additions, so the plan never writes
        // the chat-local container and the future container cannot be
        // downgraded by this restore.
        const result = await restoreBackup(backupFile(), { confirm: true });

        expect(result).toMatchObject({ ok: true, committed: true });
        // The restore committed its sections…
        expect(getFakeMeta().session_chronicle_data.snapshots.map(snapshot => snapshot.id)).toEqual(['s1']);
        // …while the unrelated future container stayed EXACTLY as found.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toEqual(futureContainer);
    });

    // ── Bug 5: Knowledge quarantine ownership ──────────────────────────────

    test('Knowledge quarantine findings land inside the affected lorebook stores, not chat metadata', async () => {
        knowledgeState.wiScript = fakeWorldInfo();
        const file = backupFile({
            metadata: {},
            knowledgeStore: {
                version: 1,
                registry: { Mara: { uid: -1 } },
                stateRegistry: { Stronghold: { uid: -2 } },
            },
        });

        const result = await restoreBackup(file, { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });

        // Registry findings → the Knowledge Tracker book's embedded container…
        const knowledgeItems = getStoreQuarantineItems('Knowledge Tracker');
        expect(knowledgeItems).toHaveLength(1);
        expect(knowledgeItems[0].store).toBe('knowledgeStore');
        expect(knowledgeItems[0].reasonCode).toBe('registry-invalid-uid');
        expect(knowledgeItems[0].raw).toEqual({ uid: -1 });
        expect(knowledgeItems[0].path[0]).toBe('registry');
        // …stateRegistry findings → the State Tracker book…
        const stateItems = getStoreQuarantineItems('State Tracker');
        expect(stateItems).toHaveLength(1);
        expect(stateItems[0].raw).toEqual({ uid: -2 });
        expect(stateItems[0].path[0]).toBe('stateRegistry');
        // …and the chat-local container owns NONE of them (§5.1: a shared
        // global/scoped book cannot be owned by one chat).
        const chatItems = getFakeMeta()[QUARANTINE_METADATA_KEY]?.items || [];
        expect(chatItems.filter(item => item.store === 'knowledgeStore')).toEqual([]);

        // Round trip: a backup exported after the restore carries the books'
        // embedded recovery records in its knowledgeStore section (§5.3).
        const envelope = await exportBackup({ download: false });
        const exported = envelope.sections.knowledgeStore.data.quarantine?.items || [];
        expect(exported).toHaveLength(2);
    });

    test('a future quarantine container inside a destination book refuses the restore before any write', async () => {
        knowledgeState.wiScript = fakeWorldInfo();
        // A container written by a newer MWT already sits in the destination
        // book's store entry.
        _setCacheForTests('Knowledge Tracker', {
            registry: {},
            relationships: {},
            quarantine: { version: 9, items: [] },
        });
        const file = backupFile({
            metadata: {},
            knowledgeStore: { version: 1, registry: { Mara: { uid: -1 } } },
        });

        // The restore can never reach the flush: the PRE-RESTORE backup
        // export aborts visibly first — a backup built from a
        // refused book container would silently omit its recovery records.
        // Either way the restore is refused with NOTHING written.
        await expect(restoreBackup(file, { confirm: true })).rejects.toThrow(/cannot be read safely/);

        // The book's container was left untouched and the finding was never
        // merged anywhere.
        expect(getStoreQuarantineItems('Knowledge Tracker')).toEqual([]);
        const chatItems = getFakeMeta()[QUARANTINE_METADATA_KEY]?.items || [];
        expect(chatItems).toEqual([]);
        // The registry finding never reached the book.
        expect(getRegistry()).toEqual({});
    });

    // ── Malformed embedded recovery data is never overwritten

    test('a malformed embedded container refuses the merge and leaves the book untouched', async () => {
        knowledgeState.wiScript = fakeWorldInfo();
        // The container's items list is garbage: canonicalizing it to
        // `[]` would DELETE the raw value, so the merge must refuse whole.
        _setCacheForTests('Knowledge Tracker', {
            registry: {},
            relationships: {},
            quarantine: { version: 1, items: 'garbage-not-an-array' },
        });
        const file = JSON.stringify({
            version: 1,
            entries: { 'Broken uid': { uid: -3, type: 'minor', keywords: ['Broken uid'] } },
        });
        setPickTextFileStub(async () => file);

        await importNpcs();

        // The import blocked (preserving the refused record failed)…
        expect(knowledgeState._lastKtStatusMsg).toMatch(/Import failed/);
        // …and the book's malformed container is still refused — nothing was
        // canonicalized over its raw value, the chat container stayed empty,
        // and the record never entered the registry.
        expect(getStoreQuarantineContainerStatus('Knowledge Tracker')).toEqual({ ok: false, reason: 'quarantine-container-invalid' });
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toBeUndefined();
        expect(getRegistry()['Broken uid']).toBeUndefined();
    });

    // ── Recovery data ownership follows the store ─────────────

    test('recovery records for the Knowledge store ride the lorebook flush, never the chat container', async () => {
        knowledgeState.wiScript = fakeWorldInfo();
        // A backup written by the earlier implementation: its envelope-level
        // recovery container still carries Knowledge-store records (they were
        // chat-owned back then) alongside genuinely chat-local ones.
        const knowledgeRecovery = {
            id: 'knowledgeStore:0000abcd', store: 'knowledgeStore',
            path: ['registry', 'Mara'], reasonCode: 'registry-invalid-uid',
            message: 'legacy backup refused this record', raw: { uid: -9 },
            detectedAt: 1, sourceVersion: 1, fingerprint: '0000abcd',
        };
        const chatRecovery = {
            id: 'chronicle:0000beef', store: 'chronicle',
            path: ['snapshots'], reasonCode: 'snapshot-missing-text',
            message: 'legacy backup refused this snapshot', raw: { id: 'x', text: '' },
            detectedAt: 1, sourceVersion: 1, fingerprint: '0000beef',
        };
        const file = backupFile({
            metadata: {},
            knowledgeStore: undefined,
            quarantine: { version: 1, items: [knowledgeRecovery, chatRecovery] },
        });

        const result = await restoreBackup(file, { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The Knowledge-store recovery record landed INSIDE the book (its
        // book-owning home, §5.1)…
        const bookItems = getStoreQuarantineItems('Knowledge Tracker');
        expect(bookItems.some(item => item.store === 'knowledgeStore' && item.raw.uid === -9)).toBe(true);
        // …the chat-local record reached the chat container…
        const chatItems = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(chatItems.some(item => item.store === 'chronicle')).toBe(true);
        // …and the chat container owns NO Knowledge-store records.
        expect(chatItems.filter(item => item.store === 'knowledgeStore')).toEqual([]);
    });

    // ── Exports never silently omit refused recovery data ──────

    test('an export aborts visibly when a book holds a refused quarantine container', async () => {
        _setCacheForTests('Knowledge Tracker', {
            registry: {},
            relationships: {},
            quarantine: { version: 9, items: [] },
        });
        // getStoreQuarantineItems reads a refused container as "no items" —
        // the export must not build an incomplete backup from that.
        await expect(exportBackup({ download: false }))
            .rejects.toThrow(/cannot be read safely \(quarantine-version-future\)/);
    });

    // ── Bug 7: World State import findings stay recoverable ────────────────

    test('parseWorldStateImport returns its findings and the rejected raw value is preservable in the same commit', () => {
        const archive = JSON.stringify({
            _meta: { type: 'world-state-archive', version: '1.0' },
            data: { text: 'imported world state', autoSaveHistory: 'garbage' },
        });
        const result = parseWorldStateImport(archive);
        expect(result.ok).toBe(true);
        expect(result.kind).toBe('text');
        expect(result.text).toBe('imported world state');
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].code).toBe('not-an-array');
        expect(result.issues[0].record).toBe('garbage');

        // The caller (world_state/render.js importWorldState) preserves the
        // rejected raw value in the SAME import commit — mirrored here.
        const stored = preserveQuarantinedRecords(worldStateSchema.id, result.issues, {
            sourceVersion: worldStateSchema.currentVersion,
        });
        expect(stored).toMatchObject({ ok: true, stored: 1 });
        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(items).toHaveLength(1);
        expect(items[0].store).toBe('worldState');
        expect(items[0].raw).toBe('garbage');
    });

    // ── Bug 8: Knowledge NPC import quarantines refused records ────────────

    test('a refused Knowledge import record is quarantined inside the lorebook store, not chat metadata', async () => {
        const file = JSON.stringify({
            version: 1,
            type: 'knowledge_tracker',
            entries: {
                'Valid NPC': { uid: null, type: 'minor', keywords: ['Valid NPC'] },
                'Broken uid': { uid: -3, type: 'minor', keywords: ['Broken uid'] },
            },
        });
        setPickTextFileStub(async () => file);

        await importNpcs();

        // The valid record imported; the refused one never entered the registry…
        expect(getRegistry()['Valid NPC']).toBeTruthy();
        expect(getRegistry()['Broken uid']).toBeUndefined();
        // …but was preserved whole INSIDE the Knowledge lorebook store (§5.1)…
        const items = getStoreQuarantineItems('Knowledge Tracker');
        expect(items).toHaveLength(1);
        expect(items[0].store).toBe('knowledgeStore');
        expect(items[0].reasonCode).toBe('registry-invalid-uid');
        expect(items[0].raw).toEqual({ uid: -3, type: 'minor', keywords: ['Broken uid'] });
        expect(items[0].path).toEqual(['registry', 'Broken uid']);
        // …not in the chat-local container.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toBeUndefined();
    });

    test('the Knowledge import blocks when refused records cannot be preserved', async () => {
        // No hydrated store: preserving must fail, and the whole import
        // aborts rather than losing the record.
        _clearCacheForTests();
        const file = JSON.stringify({
            version: 1,
            entries: { 'Broken uid': { uid: -3 } },
        });
        setPickTextFileStub(async () => file);

        await importNpcs();

        expect(knowledgeState._lastKtStatusMsg).toMatch(/Import failed/);
        expect(getRegistry()['Broken uid']).toBeUndefined();
        expect(getStoreQuarantineItems('Knowledge Tracker')).toEqual([]);
    });

    // ── Quarantined records are not double-reported ────────────

    test('a refused import record is not also reported as already tracked', async () => {
        knowledgeState.wiScript = fakeWorldInfo();
        const file = JSON.stringify({
            version: 1,
            entries: { 'Broken uid': { uid: -3, type: 'minor', keywords: ['Broken uid'] } },
        });
        setPickTextFileStub(async () => file);

        await importNpcs();

        // One refused record ⇒ one report: "invalid record(s) quarantined",
        // never "already tracked" for the same entry.
        const msg = knowledgeState._lastKtStatusMsg;
        expect(msg).toMatch(/Imported 0 NPC\(s\)\./);
        expect(msg).toMatch(/1 invalid record\(s\) quarantined/);
        expect(msg).not.toMatch(/already tracked/);
    });

    // ── Round 2, bug 1: a blocked CURRENT preparation blocks the section ────

    test('a merge restore leaves a section whose CURRENT root is unreadable unwritten and unstamped', async () => {
        getFakeMeta().session_chronicle_data = 'CORRUPT ROOT';
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };
        const file = backupFile({
            metadata: {
                chronicle: { snapshots: [{ id: 's1', text: 'incoming snapshot' }], _deletedBin: [] },
                worldState: { text: 'backup state' },
            },
        });

        const result = await restoreBackup(file, { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The unreadable chronicle root survived untouched. Previously the
        // merge helpers normalized the raw value (objectOrEmpty) into a valid
        // replacement, and the completed-value revalidation happily committed
        // it over the unreadable store.
        expect(getFakeMeta().session_chronicle_data).toBe('CORRUPT ROOT');
        // No manifest stamp claims a version for the unwritten section…
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.chronicle).toBeUndefined();
        // …the refusal is surfaced in the preview…
        expect(result.preview.summary.chronicle.skipped
            .some(skip => /Chronicle data must be an object/.test(skip.reason))).toBe(true);
        // …and the unrelated section still restored (§3.5: a blocked store
        // blocks only itself).
        expect(getFakeMeta().world_state_tracker_metadata.text).toBe('backup state');
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.worldState)
            .toBe(STORE_SCHEMAS.worldState.currentVersion);
    });

    test('a merge restore refuses a section whose manifest version is from the future (no silent downgrade)', async () => {
        // A hand-edited (or newer-release) manifest declares chronicle v99;
        // this build supports v1. The current half must refuse preparation.
        getFakeMeta()[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { chronicle: 99 } };
        getFakeMeta().session_chronicle_data = { snapshots: [{ id: 'keep', text: 'current snapshot' }], _deletedBin: [] };

        const result = await restoreBackup(backupFile(), { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The future-version section was left exactly as stored…
        expect(getFakeMeta().session_chronicle_data.snapshots).toHaveLength(1);
        expect(getFakeMeta().session_chronicle_data.snapshots[0].id).toBe('keep');
        // …and its manifest stamp still declares 99 — the restore neither
        // downgraded the data nor re-stamped it current.
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.chronicle).toBe(99);
        // The refusal names the future version in the preview.
        expect(result.preview.summary.chronicle.skipped
            .some(skip => /version 99/.test(skip.reason))).toBe(true);
    });

    // ── Round 2, bug 2: deferred Interiority is retained but never stamped ──

    test('deferred Interiority data is retained but never stamped; an existing stamp is withheld', async () => {
        // The chat already carries a current stamp for interiority — the
        // restore must REMOVE it when the committed value is newly deferred,
        // or the privileged conversion would never run (§7.5).
        getFakeMeta()[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { interiority: 1 } };
        const file = backupFile({
            metadata: {
                interiority: {
                    enabled: true,
                    ledger: [],
                    deletedIntentions: [],
                    perMessage: { 'sd-legacy-key': { reactions: [] } },
                    turnCounter: 0,
                },
            },
        });

        const result = await restoreBackup(file, { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The legacy per-message key was RETAINED (an import accepts deferred
        // entries; §7.5 permits retaining deferred data)…
        expect(getFakeMeta().mwt_interiority.perMessage).toHaveProperty('sd-legacy-key');
        // …but the section was NOT stamped current: it is excluded from the
        // canonical sections and tracked as deferred instead…
        expect(result.preview.plan.canonicalSections).not.toContain('interiority');
        expect(result.preview.plan.deferredSections).toContain('interiority');
        // …and the pre-existing stamp was withheld, not left behind to claim
        // the conversion already ran.
        expect(Object.prototype.hasOwnProperty.call(
            getFakeMeta()[MANIFEST_METADATA_KEY].sections, 'interiority')).toBe(false);
        // The preview presents the store as preparing, not as skipped.
        expect(result.preview.summary.interiority.deferred
            .some(entry => /legacy message key/.test(entry.reason))).toBe(true);
    });

    // ── Round 2, bug 3: malformed quarantine containers refuse the restore ──

    test('a malformed chat quarantine container refuses the restore before any write', async () => {
        // The import carries a refused snapshot, so the commit must merge into
        // the chat-local container — which is malformed. Merging into the
        // canonical form would replace the raw container and lose its recovery
        // evidence; preflight and commit share the writable-container rule.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: 'garbage-not-an-array' };
        const file = backupFile({
            metadata: {
                chronicle: { snapshots: [{ id: 'bad', text: '' }], _deletedBin: [] },
            },
        });

        const result = await restoreBackup(file, { confirm: true });
        expect(result).toMatchObject({ ok: false, committed: false, reason: 'quarantine-container-invalid' });
        expect(result.warning).toMatch(/malformed/);

        // The malformed raw container survived untouched…
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY])
            .toEqual({ version: 1, items: 'garbage-not-an-array' });
        // …and no section data was committed.
        expect(getFakeMeta().session_chronicle_data).toBeUndefined();
    });
});

// ── Pure write-seam helpers (bugs 3 and 4) + Round 3 regressions ──────────────

describe('write-seam fail-closed helpers', () => {
    beforeEach(() => {
        resetCoreStubs();
        // Round 3: the exact-restore regressions below live here too, and they
        // need the same environment the restore path sees (chat identity,
        // saveMetadata, message ids) — the pure helper tests above never
        // consult it, so this is additive for them.
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

    test('prepareNextStoreValue fails closed on a present non-object root instead of substituting the default', () => {
        const bad = prepareNextStoreValue(worldStateSchema, 'CORRUPT ROOT', { text: 'patch' });
        expect(bad.ok).toBe(false);
        expect(bad.changed).toBe(false);
        // The PREVIOUS value is returned — not a manufactured default the
        // caller could commit over the unreadable original.
        expect(bad.data).toBe('CORRUPT ROOT');
        expect(bad.issues[0].severity).toBe('fatal');
        expect(bad.issues[0].code).toBe('root-not-object');

        // A genuinely ABSENT store still starts from the canonical default.
        const fresh = prepareNextStoreValue(worldStateSchema, undefined, { text: 'hello' });
        expect(fresh.ok).toBe(true);
        expect(fresh.data.text).toBe('hello');
        expect(fresh.data.autoSaveHistory).toEqual([]);
    });

    test('setWorldStateData preserves an unreadable current root instead of committing a fresh store', () => {
        getFakeMeta().world_state_tracker_metadata = 'CORRUPT ROOT';
        setWorldStateData({ text: 'patched' });
        expect(getFakeMeta().world_state_tracker_metadata).toBe('CORRUPT ROOT');
    });

    test('preserveQuarantinedRecords never downgrades a future-version container', () => {
        const futureContainer = {
            version: 9,
            items: [{
                id: 'chronicle:deadbeef', store: 'chronicle', reasonCode: 'x',
                message: 'from a newer MWT', raw: { keep: true }, detectedAt: 1,
                sourceVersion: null, fingerprint: 'deadbeef',
            }],
        };
        getFakeMeta()[QUARANTINE_METADATA_KEY] = structuredClone(futureContainer);

        const issues = [{
            severity: 'quarantine',
            code: 'text-not-string',
            path: ['text'],
            message: 'World State text must be a string.',
            record: 7,
        }];
        expect(preserveQuarantinedRecords('worldState', issues))
            .toMatchObject({ ok: false, stored: 0, reason: 'quarantine-version-future' });
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toEqual(futureContainer);
    });

    test('preserveQuarantinedRecords refuses a malformed present container instead of canonicalizing it away', () => {
        // A present-but-invalid container: merging into the canonical (empty)
        // form would overwrite the raw value and delete the records it holds.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: 'garbage-not-an-array' };
        const issues = [{
            severity: 'quarantine',
            code: 'text-not-string',
            path: ['text'],
            message: 'World State text must be a string.',
            record: 7,
        }];
        expect(preserveQuarantinedRecords('worldState', issues))
            .toMatchObject({ ok: false, stored: 0, reason: 'quarantine-container-invalid' });
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toEqual({ version: 1, items: 'garbage-not-an-array' });
    });

    test('preserveQuarantinedRecords still merges into a current-version container', () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [] };
        const issues = [{
            severity: 'quarantine',
            code: 'text-not-string',
            path: ['text'],
            message: 'World State text must be a string.',
            record: 7,
        }];
        expect(preserveQuarantinedRecords('worldState', issues))
            .toMatchObject({ ok: true, stored: 1 });
        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(items).toHaveLength(1);
        expect(items[0].raw).toBe(7);
        expect(items[0].store).toBe('worldState');
    });

    test('preserveQuarantinedRecords creates the container on first write from an absent one', () => {
        // Absent ≠ malformed: the normal pre-quarantine state must not refuse.
        const issues = [{
            severity: 'quarantine',
            code: 'text-not-string',
            path: ['text'],
            message: 'World State text must be a string.',
            record: 7,
        }];
        expect(preserveQuarantinedRecords('worldState', issues))
            .toMatchObject({ ok: true, stored: 1 });
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY].items).toHaveLength(1);
    });

    // ── Round 2, bug 4: the World State import uses a checked write ─────────

    test('a checked World State write reports refusal and keeps the previous value', () => {
        // The write quarantines the invalid autoSaveHistory, and the chat
        // quarantine container is malformed — preservation refuses, so the
        // write must fail closed instead of the UI reporting "Imported." over
        // the untouched store.
        getFakeMeta().world_state_tracker_metadata = { text: 'previous state', autoSaveHistory: 'garbage-not-an-array' };
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: 'garbage-not-an-array' };

        const refused = setWorldStateDataChecked({ text: 'imported state' });
        expect(refused.ok).toBe(false);
        expect(refused.reason).toBe('quarantine-container-invalid');
        expect(refused.data).toEqual({ text: 'previous state', autoSaveHistory: 'garbage-not-an-array' });
        expect(getFakeMeta().world_state_tracker_metadata.text).toBe('previous state');

        // With the container repaired, the same write commits and the invalid
        // field is quarantined out (its raw value preserved) instead.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [] };
        const committed = setWorldStateDataChecked({ text: 'imported state' });
        expect(committed.ok).toBe(true);
        expect(getFakeMeta().world_state_tracker_metadata.text).toBe('imported state');
        expect(getFakeMeta().world_state_tracker_metadata.autoSaveHistory).toEqual([]);
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY].items).toHaveLength(1);
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY].items[0].raw).toBe('garbage-not-an-array');
    });

    // ── Round 3, bug 1: exact planning preserves blocked/deferred decisions ──

    test('an exact restore leaves a destination section the planner blocked untouched', async () => {
        getFakeMeta().session_chronicle_data = 'CORRUPT ROOT';
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };
        const file = backupFile({
            identity: SAME_CHAT_IDENTITY,
            metadata: {
                chronicle: { snapshots: [{ id: 's1', text: 'incoming snapshot' }], _deletedBin: [] },
                worldState: { text: 'backup state' },
            },
        });

        const preview = await restoreBackup(file, { exact: true });
        expect(preview.preview.ok).toBe(true);
        // The exact summary reports the refusal instead of a replacement…
        expect(preview.preview.summary.chronicle).toMatchObject({ mode: 'exact', action: 'blocked' });
        // …and the plan preserves the planner's blocked decision instead of
        // reintroducing the section from the import.
        expect(preview.preview.plan.blockedSections).toContain('chronicle');
        expect(preview.preview.plan.sections).not.toHaveProperty('chronicle');
        expect(preview.preview.plan.canonicalSections).not.toContain('chronicle');

        const result = await restoreBackup(file, { confirm: true, exact: true, previewToken: preview.preview.previewToken });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The unreadable chronicle root survived the exact restore…
        expect(getFakeMeta().session_chronicle_data).toBe('CORRUPT ROOT');
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.chronicle).toBeUndefined();
        // …while the unblocked section was still replaced exactly.
        expect(getFakeMeta().world_state_tracker_metadata.text).toBe('backup state');
    });

    test('an exact restore does not remove a blocked destination section the snapshot lacks', async () => {
        getFakeMeta().session_chronicle_data = 'CORRUPT ROOT';
        // The snapshot predates the (now unreadable) chronicle store, so a
        // naive exact restore would delete it as a removal candidate — the
        // merge planner never evaluated it because its loop only covers
        // imported sections.
        const file = backupFile({
            identity: SAME_CHAT_IDENTITY,
            metadata: { worldState: { text: 'backup state' } },
        });

        const preview = await restoreBackup(file, { exact: true });
        expect(preview.preview.plan.removeMetadataSections).not.toContain('chronicle');
        expect(preview.preview.summary.chronicle).toMatchObject({ mode: 'exact', action: 'blocked' });

        const result = await restoreBackup(file, { confirm: true, exact: true, previewToken: preview.preview.previewToken });
        expect(result).toMatchObject({ ok: true, committed: true });
        expect(getFakeMeta().session_chronicle_data).toBe('CORRUPT ROOT');
    });

    test('a clean exact replacement is stamped even when the old destination half was deferred', async () => {
        // The DESTINATION interiority still carries legacy per-message keys,
        // so the merge half of the plan defers the section. The exact write
        // replaces it wholesale with the import's clean canonical value, so
        // the stamp must land — the outgoing store's deferral is irrelevant.
        getFakeMeta().mwt_interiority = {
            enabled: true,
            ledger: [],
            deletedIntentions: [],
            perMessage: { 'sd-legacy-key': { reactions: [] } },
            turnCounter: 0,
        };
        const file = backupFile({
            identity: SAME_CHAT_IDENTITY,
            metadata: {
                interiority: { enabled: true, ledger: [], deletedIntentions: [], turnCounter: 7 },
            },
        });

        const preview = await restoreBackup(file, { exact: true });
        expect(preview.preview.plan.deferredSections).not.toContain('interiority');
        expect(preview.preview.plan.canonicalSections).toContain('interiority');

        const result = await restoreBackup(file, { confirm: true, exact: true, previewToken: preview.preview.previewToken });
        expect(result).toMatchObject({ ok: true, committed: true });
        expect(getFakeMeta().mwt_interiority.turnCounter).toBe(7);
        expect(getFakeMeta().mwt_interiority.perMessage).toBeUndefined();
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.interiority)
            .toBe(STORE_SCHEMAS.interiority.currentVersion);
    });

    // ── Round 3, bug 2: history capture mutates storage before validation ────

    test('a refused history snapshot leaves the stored history untouched', () => {
        getFakeMeta().world_state_tracker_metadata = {
            text: 'current',
            // Forces a quarantine finding, so the checked write attempts to
            // preserve the rejected record…
            provenance: 'NOT AN OBJECT',
            autoSaveHistory: [{ text: 'old', timestamp: 1 }],
        };
        // …into a malformed container, so it must fail closed.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: 'garbage-not-an-array' };

        const refused = pushToHistory('outgoing');
        expect(refused.ok).toBe(false);
        expect(refused.reason).toBe('quarantine-container-invalid');
        // The retained store did NOT gain the snapshot entry — the stored
        // array is the live metadata value and used to be mutated in place
        // BEFORE the checked setter ran.
        expect(getFakeMeta().world_state_tracker_metadata.autoSaveHistory)
            .toEqual([{ text: 'old', timestamp: 1 }]);
        expect(getFakeMeta().world_state_tracker_metadata.provenance).toBe('NOT AN OBJECT');
    });

    test('a malformed stored history cannot throw, and the snapshot commits canonically', () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'current', autoSaveHistory: 'CORRUPT HISTORY' };

        // Previously this threw at history.push before the UI ever reached
        // its checked write.
        const written = pushToHistory('outgoing');
        expect(written.ok).toBe(true);
        expect(getFakeMeta().world_state_tracker_metadata.autoSaveHistory)
            .toEqual([{ text: 'outgoing', timestamp: expect.any(Number) }]);
        // The malformed raw value was preserved in quarantine, not silently
        // discarded.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY].items[0].raw).toBe('CORRUPT HISTORY');
    });

    test('commitHistorySnapshot commits the snapshot and the text change in one checked patch', () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'old text', autoSaveHistory: [] };

        const written = commitHistorySnapshot('old text', { text: 'new text' });
        expect(written.ok).toBe(true);
        const data = getFakeMeta().world_state_tracker_metadata;
        expect(data.text).toBe('new text');
        expect(data.autoSaveHistory).toHaveLength(1);
        expect(data.autoSaveHistory[0].text).toBe('old text');
    });

    // ── Round 3, bug 4: a blocked section reports no phantom additions ───────

    test('a blocked section reports zero prospective counts in the merge preview', async () => {
        getFakeMeta().session_chronicle_data = 'CORRUPT ROOT';
        // One incoming snapshot: the merge itself would report added: 1, but
        // nothing from this section will be committed.
        const preview = await previewRestore(backupFile());
        expect(preview.ok).toBe(true);
        expect(preview.plan.blockedSections).toContain('chronicle');
        expect(preview.plan.sections).not.toHaveProperty('chronicle');
        expect(preview.summary.chronicle).toMatchObject({ added: 0, updated: 0, conflicts: 0 });
        // The refusal itself stays visible so the preview explains the zero.
        expect(preview.summary.chronicle.skipped.length).toBeGreaterThan(0);
    });

    // ── Round 4, bug 1: the import's quarantine merge rides the checked commit ─

    test('a refused import commit leaves the quarantine container untouched', () => {
        // The archive carries a quarantine finding (an invalid history) and
        // the destination root is unreadable, so the checked commit must
        // refuse BEFORE the archive's rejected records reach the container —
        // the old standalone preserve merged them first, mutating the
        // container of a chat whose import then reported failure.
        getFakeMeta().world_state_tracker_metadata = 'CORRUPT ROOT';
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [] };

        const result = parseWorldStateImport(JSON.stringify({
            _meta: { type: 'world-state-archive', version: '1.0' },
            data: { text: 'imported text', autoSaveHistory: 'NOT AN ARRAY' },
        }));
        expect(result.ok).toBe(true);
        expect(result.issues.length).toBeGreaterThan(0);

        // The exact call importWorldState() makes now.
        const written = commitHistorySnapshot(getWorldStateText(), { text: result.text }, { preserveIssues: result.issues });
        expect(written.ok).toBe(false);
        expect(written.reason).toBe('validation-refused');
        expect(getFakeMeta().world_state_tracker_metadata).toBe('CORRUPT ROOT');
        // Destination validation refused, so the container was never merged.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toEqual({ version: 1, items: [] });
    });

    test('a committed import preserves the rejected archive records in the same write', () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'old text', autoSaveHistory: [] };

        const result = parseWorldStateImport(JSON.stringify({
            _meta: { type: 'world-state-archive', version: '1.0' },
            data: { text: 'imported text', autoSaveHistory: 'NOT AN ARRAY' },
        }));
        expect(result.ok).toBe(true);

        // The exact call importWorldState() makes now.
        const written = commitHistorySnapshot('old text', { text: result.text }, { preserveIssues: result.issues });
        expect(written.ok).toBe(true);
        const data = getFakeMeta().world_state_tracker_metadata;
        expect(data.text).toBe('imported text');
        expect(data.autoSaveHistory[0].text).toBe('old text');
        // The archive's rejected history was preserved by the SAME commit.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY].items)
            .toEqual([expect.objectContaining({ raw: 'NOT AN ARRAY' })]);
    });

    // ── Round 4, bug 3: removal-only blocked sections keep their reason ────────

    test('a removal-only blocked section carries its refusal reason in the exact summary', async () => {
        getFakeMeta().session_chronicle_data = 'CORRUPT ROOT';
        // The snapshot predates the (now unreadable) chronicle store, so the
        // exact planner evaluates it as a removal candidate the merge planner
        // never examined.
        const file = backupFile({
            identity: SAME_CHAT_IDENTITY,
            metadata: { worldState: { text: 'backup state' } },
        });

        const preview = await restoreBackup(file, { exact: true });
        expect(preview.preview.plan.removeMetadataSections).not.toContain('chronicle');
        expect(preview.preview.summary.chronicle).toMatchObject({ mode: 'exact', action: 'blocked' });
        // §10.3: the skipped entry explains the refusal instead of leaving
        // "destination store refused" with an empty details list.
        const skipped = preview.preview.summary.chronicle.skipped;
        expect(skipped.length).toBeGreaterThan(0);
        expect(skipped[0].reason).toEqual(expect.any(String));
        expect(skipped[0].reason.length).toBeGreaterThan(0);
    });

    // ── Round 5, bug 1: the Chronicle import commits through the checked seam ──

    /** Import file with one acceptable and one refused snapshot plus a cadence
     *  counter, matching the standalone exportChronicle() shape. */
    function chronicleImportFile() {
        return JSON.stringify({
            snapshots: [
                { text: 'imported snapshot', createdAt: '2025-01-01T00:00:00.000Z' },
                { id: 'bad', createdAt: '2025-01-02T00:00:00.000Z' },
            ],
            msgSinceSnapshot: 3,
        });
    }

    test('a refused chronicle import mutates neither the store, the container, nor module/UI state', async () => {
        // The destination root is unreadable and the file carries a quarantine
        // finding, so the checked commit must refuse BEFORE the file's
        // rejected snapshot reaches the container. The old flow merged the
        // quarantine records first, then committed through the UNCHECKED
        // setter: the store kept its old value while msgSinceSnapshot moved,
        // injection was re-applied, the view rerendered, and the import
        // reported success with the stranded quarantine records still in place.
        getFakeMeta().session_chronicle_data = 'CORRUPT ROOT';
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [] };
        chronicleState.msgSinceSnapshot = 7;
        chronicleState._lastStatusMsg = '';
        chronicleState._lastStatusLevel = '';
        let renders = 0;
        chronicleRender.renderContent = () => { renders++; };

        setPickTextFileStub(async () => chronicleImportFile());
        await triggerImport();

        // The store kept its unreadable previous value…
        expect(getFakeMeta().session_chronicle_data).toBe('CORRUPT ROOT');
        // …the quarantine container was never merged (destination validated
        // first, refused — the file's rejected snapshot never reached it)…
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toEqual({ version: 1, items: [] });
        // …module/UI state never moved, and the import reported failure.
        expect(chronicleState.msgSinceSnapshot).toBe(7);
        expect(renders).toBe(0);
        expect(chronicleState._lastStatusLevel).toBe('error');
        expect(chronicleState._lastStatusMsg).toContain('refused the write');
        expect(chronicleState._lastStatusMsg).toContain('previous chronicle was kept');
    });

    test('a committed chronicle import preserves the refused snapshots in the same write', async () => {
        getFakeMeta().session_chronicle_data = {
            snapshots: [{ id: 'existing', text: 'current snapshot' }],
            _deletedBin: [],
        };
        chronicleState.msgSinceSnapshot = 7;
        chronicleState._lastStatusMsg = '';
        chronicleState._lastStatusLevel = '';
        let renders = 0;
        chronicleRender.renderContent = () => { renders++; };

        setPickTextFileStub(async () => chronicleImportFile());
        await triggerImport();

        // The canonical commit landed: the acceptable snapshot merged by its
        // deterministic id, and the imported cadence counter is in the STORE…
        const data = getFakeMeta().session_chronicle_data;
        expect(data.snapshots.map(s => s.id)).toEqual(['existing', expect.stringMatching(/^legacy-/)]);
        expect(data.msgSinceSnapshot).toBe(3);
        // …the file's refused snapshot was preserved by the SAME commit (§5.2)…
        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(items).toHaveLength(1);
        expect(items[0].store).toBe('chronicle');
        expect(items[0].raw).toMatchObject({ id: 'bad' });
        // …stamped with the version its SOURCE was at — the unversioned
        // standalone export is legacy version 0, NOT the destination's
        // current version (which would misreport where the record came from).
        expect(items[0].sourceVersion).toBe(0);
        // …and only after that confirmation did the module/UI state move and
        // the import report success (skipping the refused record).
        expect(chronicleState.msgSinceSnapshot).toBe(3);
        expect(renders).toBe(1);
        expect(chronicleState._lastStatusLevel).toBe('success');
        expect(chronicleState._lastStatusMsg).toContain('Imported 1 entries');
        expect(chronicleState._lastStatusMsg).toContain('1 skipped');
    });

    // ── Round 5, bug 2: reads never canonicalize live metadata ─────────────────

    test('an interiority read presents safe containers but never repairs the live store', () => {
        // Every container is invalid: the old accessor replaced the root and
        // each container in live metadata on the READ, destroying the raw
        // values before any write seam could quarantine them.
        getFakeMeta().mwt_interiority = { enabled: true, ledger: 'GARBAGE', perMessage: 'JUNK', deletedIntentions: 42 };

        const view = getInteriorityData();
        expect(view.ledger).toEqual([]);
        expect(view.perMessage).toEqual({});
        expect(view.deletedIntentions).toEqual([]);
        expect(getLedger()).toEqual([]);
        expect(getDeletedIntentions()).toEqual([]);

        // The live raw values survived every read untouched.
        expect(getFakeMeta().mwt_interiority)
            .toEqual({ enabled: true, ledger: 'GARBAGE', perMessage: 'JUNK', deletedIntentions: 42 });
    });

    test('a checked interiority write quarantines the raw containers it displaces', () => {
        getFakeMeta().mwt_interiority = { enabled: true, ledger: 'GARBAGE', perMessage: 'JUNK', deletedIntentions: 42 };

        // A normal mutation works off the safe view and commits canonically…
        const entry = addLedgerEntry({ npc: 'Mara', action: 'wait', trigger: 'dawn' }, 'since', 0);
        const data = getFakeMeta().mwt_interiority;
        expect(data.ledger.map(e => e.id)).toEqual([entry.id]);
        expect(data.perMessage).toEqual({});
        expect(data.deletedIntentions).toEqual([]);

        // …while the displaced raw container values were preserved whole in the
        // SAME commit (§5.2) instead of being silently erased by the read.
        const raws = getFakeMeta()[QUARANTINE_METADATA_KEY].items.map(item => item.raw);
        expect(raws).toEqual(expect.arrayContaining(['GARBAGE', 'JUNK', 42]));
    });

    test('a falsey interiority root survives reads and fails the write closed', () => {
        getFakeMeta().mwt_interiority = '';
        // The read presents the canonical defaults WITHOUT replacing the
        // stored (unreadable) root…
        expect(getInteriorityData().enabled).toBe(true);
        expect(getFakeMeta().mwt_interiority).toBe('');
        // …and the write seam refuses over it, keeping the previous value.
        addManualLedgerEntry({ npc: 'Mara', action: 'wait', trigger: 'dawn' });
        expect(getFakeMeta().mwt_interiority).toBe('');
    });

    test('an absent interiority store is created only by a committed write', () => {
        // No eager root creation on the read path anymore…
        expect(getInteriorityData().ledger).toEqual([]);
        expect(getFakeMeta().mwt_interiority).toBeUndefined();
        // …the first commit creates the canonical store through the seam.
        addLedgerEntry({ npc: 'Mara', action: 'wait', trigger: 'dawn' }, 'since', 0);
        expect(getFakeMeta().mwt_interiority).toMatchObject({
            enabled: true,
            ledger: [{ npc: 'Mara', action: 'wait', trigger: 'dawn' }],
            deletedIntentions: [],
            perMessage: {},
            turnCounter: 0,
        });
    });

    test('falsey chronicle and evidence roots are initialized only when genuinely absent', () => {
        // A PRESENT-but-falsey root is never replaced by a read — the raw
        // value stays for the write seam to fail closed on.
        getFakeMeta().session_chronicle_data = '';
        expect(getChronicleData().snapshots).toEqual([]);
        expect(getFakeMeta().session_chronicle_data).toBe('');

        getFakeMeta().knowledge_growth_evidence = '';
        expect(getEvidenceMap()).toEqual({});
        expect(getFakeMeta().knowledge_growth_evidence).toBe('');

        // A GENUINELY absent root (undefined) still initializes on read —
        // that write is lossless (nothing to preserve).
        delete getFakeMeta().session_chronicle_data;
        expect(getChronicleData()).toEqual({
            snapshots: [], lastAnchor: null, injectEnabled: false, injectCount: 2,
            injectDepth: 2, autoSuggestAfter: 40, suggestSent: false, msgSinceSnapshot: 0,
        });

        delete getFakeMeta().knowledge_growth_evidence;
        expect(getEvidenceMap()).toEqual({});
        expect(getFakeMeta().knowledge_growth_evidence).toEqual({});
    });

    // ── Round 6: detached/staged reads — rejected raw values stay recoverable ──

    test('interiority read views are fully detached from live metadata', () => {
        getFakeMeta().mwt_interiority = {
            enabled: true,
            ledger: [{ id: 'i-1', npc: 'Mara', action: 'wait', trigger: 'dawn' }],
            perMessage: {},
            deletedIntentions: [],
        };
        const before = structuredClone(getFakeMeta().mwt_interiority);

        // Mutating the working copy — nested arrays, nested maps, scalars —
        // must not touch chat metadata (the old accessor handed back the LIVE
        // object whenever the containers had valid shapes).
        const view = getInteriorityData();
        view.ledger.push({ id: 'i-2', npc: 'Kira', action: 'run', trigger: 'dusk' });
        view.perMessage['mu-x'] = { reactions: [] };
        view.turnCounter = 99;

        expect(getFakeMeta().mwt_interiority).toEqual(before);
    });

    test('an interiority write quarantines an invalid scalar it displaces in the live store', () => {
        // The reported scenario: a stored turnCounter of "RAW-BAD" was
        // overwritten IN the live store by incrementTurnCounter() before the
        // write seam validated, so validation only ever saw the repaired 1 —
        // no quarantine record, and the rejected raw value was destroyed.
        getFakeMeta().mwt_interiority = {
            enabled: true,
            ledger: [],
            perMessage: {},
            deletedIntentions: [],
            turnCounter: 'RAW-BAD',
        };

        expect(incrementTurnCounter()).toBe(1);

        // The commit repaired the counter…
        expect(getFakeMeta().mwt_interiority.turnCounter).toBe(1);
        // …and preserved the displaced raw value whole in the SAME commit
        // (§5.2), stamped with the store's current version.
        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            store: 'interiority',
            reasonCode: 'turn-counter-invalid',
            raw: 'RAW-BAD',
            sourceVersion: 1,
        });
    });

    test('evidence mutations are staged: nothing reaches metadata until the commit', () => {
        getFakeMeta().knowledge_growth_evidence = {
            Mara: { npc: 'Mara', raw: [], consolidated: [], archivedRaw: [], meta: {} },
        };
        const before = structuredClone(getFakeMeta().knowledge_growth_evidence);

        // Mutate the staged copy — the old accessor returned the live map, so
        // this edit used to be present in metadata BEFORE validation ran.
        const map = getEvidenceMap();
        map.Kira = { npc: 'Kira', raw: [], consolidated: [], archivedRaw: [], meta: {} };
        delete map.Mara;

        expect(getFakeMeta().knowledge_growth_evidence).toEqual(before);

        saveEvidenceMap();
        expect(Object.keys(getFakeMeta().knowledge_growth_evidence)).toEqual(['Kira']);
    });

    test('a refused evidence commit leaves the previous stored value intact', () => {
        getFakeMeta().knowledge_growth_evidence = {
            Mara: { npc: 'Mara', raw: [], consolidated: [], archivedRaw: [], meta: {} },
        };
        const before = structuredClone(getFakeMeta().knowledge_growth_evidence);
        // A future-version quarantine container: preservation must refuse, and
        // the commit must fail closed. Before the staged boundary existed,
        // the proposed mutation was ALREADY in the live map when the save
        // refused, so the promised "previous value kept" was impossible.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 9, items: [] };

        // The staged edit carries a quarantine finding (a file with a
        // non-object raw tier), so the commit has rejected records to
        // preserve — and cannot.
        const map = getEvidenceMap();
        map.Bad = { npc: 'Bad', raw: 'GARBAGE' };
        saveEvidenceMap();

        // The refused commit changed nothing: the previous map is intact…
        expect(getFakeMeta().knowledge_growth_evidence).toEqual(before);
        // …and the container was not downgraded.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toEqual({ version: 9, items: [] });
    });

    test('an evidence commit quarantines invalid nested evidence it replaces', () => {
        getFakeMeta().knowledge_growth_evidence = {
            Mara: { npc: 'Mara', raw: 'GARBAGE', consolidated: [], archivedRaw: [], meta: {} },
        };

        const map = getEvidenceMap();
        map.Kira = { npc: 'Kira', raw: [], consolidated: [], archivedRaw: [], meta: {} };
        saveEvidenceMap();

        // The committed map is canonical (the garbage tier is gone)…
        const committed = getFakeMeta().knowledge_growth_evidence;
        expect(Object.keys(committed).sort()).toEqual(['Kira', 'Mara']);
        expect(committed.Mara.raw).toEqual([]);
        // …and the raw value it displaced was preserved in the same write.
        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ store: 'knowledgeEvidence', raw: 'GARBAGE' });
    });

    test('a committed staged map stays fully detached from live metadata', () => {
        getFakeMeta().knowledge_growth_evidence = {
            Mara: {
                npc: 'Mara',
                raw: [{ id: 'obs-1', claim: 'calm voice', quote: '"calm"', ts: 1, msgIdx: 0 }],
                consolidated: [],
                archivedRaw: [],
                meta: {},
            },
        };
        const map = getEvidenceMap();
        map.Kira = { npc: 'Kira', raw: [], consolidated: [], archivedRaw: [], meta: {} };
        saveEvidenceMap();
        expect(Object.keys(getFakeMeta().knowledge_growth_evidence).sort()).toEqual(['Kira', 'Mara']);
        const committed = structuredClone(getFakeMeta().knowledge_growth_evidence);

        // Mutate every held-reference shape AFTER the commit: a nested meta
        // container, a raw record object, and a tier array. The validator's
        // canonical output shares these objects with the staged input it
        // validated, so committing it directly let each of these edits land
        // in chat metadata BEFORE the next save could validate them.
        const held = getEvidenceMap();
        held.Kira.meta.lastCaptureTs = 999;
        held.Mara.raw[0].claim = 'MUTATED-BEFORE-VALIDATION';
        held.Mara.raw.push({ id: 'obs-2', claim: 'second', quote: '"b"', ts: 2, msgIdx: 1 });

        expect(getFakeMeta().knowledge_growth_evidence).toEqual(committed);

        // The staged edits still commit normally once they go through the seam.
        saveEvidenceMap();
        const reloaded = getFakeMeta().knowledge_growth_evidence;
        expect(reloaded.Kira.meta.lastCaptureTs).toBe(999);
        expect(reloaded.Mara.raw.map(o => o.claim)).toEqual(['MUTATED-BEFORE-VALIDATION', 'second']);
    });

    test('a commit that canonicalizes a file does not alias the live file into the staged map', () => {
        getFakeMeta().knowledge_growth_evidence = {};
        const map = getEvidenceMap();
        // A file with a REJECTED record (missing id/quote): the commit
        // quarantines it out, so the canonical file differs from the staged
        // one and the staged map is re-synced from the canonical form.
        map.Bad = {
            npc: 'Bad',
            raw: [{ claim: 'no id, no quote' }],
            consolidated: [],
            archivedRaw: [],
            meta: {},
        };
        saveEvidenceMap();
        const committed = structuredClone(getFakeMeta().knowledge_growth_evidence);
        expect(committed.Bad.raw).toEqual([]);

        // The staged file used to BECOME the live file object at that point —
        // pushing a record wrote it straight into metadata, before validation
        // could ever see (or refuse) it.
        getEvidenceMap().Bad.raw.push({ id: 'obs-9', claim: 'late', quote: '"c"', ts: 3, msgIdx: 2 });
        expect(getFakeMeta().knowledge_growth_evidence).toEqual(committed);

        // …and the pushed record only lands through a checked commit.
        saveEvidenceMap();
        expect(getFakeMeta().knowledge_growth_evidence.Bad.raw.map(o => o.id)).toEqual(['obs-9']);
    });

    test('setChronicleDataChecked stamps domestic and imported findings with their own source versions', () => {
        getFakeMeta().session_chronicle_data = { snapshots: [], _deletedBin: [] };
        // DOMESTIC finding: the patch itself carries a garbage snapshot.
        // EXTERNAL group: findings from an unversioned standalone export
        // (prepared from legacy version 0), as the importer now sends them.
        const external = [{
            severity: 'quarantine',
            code: 'snapshot-missing-text',
            path: ['snapshots', 0],
            message: 'Snapshot text must be a non-empty string.',
            record: { id: 'legacy-bad', createdAt: 1 },
        }];
        const written = setChronicleDataChecked(
            { snapshots: [{ id: 'domestic-bad' }] },
            { preserveIssues: { issues: external, sourceVersion: 0 } },
        );
        expect(written.ok).toBe(true);

        const items = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(items).toHaveLength(2);
        // The file's rejected snapshot keeps the version its source was at…
        expect(items.find(item => item.raw?.id === 'legacy-bad'))
            .toMatchObject({ store: 'chronicle', sourceVersion: 0 });
        // …while the destination's own finding keeps the current version.
        expect(items.find(item => item.raw?.id === 'domestic-bad'))
            .toMatchObject({ store: 'chronicle', sourceVersion: 1 });
    });
});
