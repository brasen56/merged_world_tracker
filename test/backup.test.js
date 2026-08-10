import { describe, test, expect, vi } from 'vitest';

import {
    BACKUP_TYPE,
    MAX_TRASH_SIZE,
    buildBackupEnvelope,
    backupDataEqual,
} from '../backup/data.js';
import { validateBackupEnvelope } from '../backup/validate.js';
import {
    planRestore,
    reconcileNameMap,
} from '../backup/restore.js';
import { collectBackup, getBackupChatName } from '../backup/collect.js';
import { exportBackup, getBackupFilename, previewRestore, restoreBackup, undoLastRestore, fingerprintPreview } from '../backup/index.js';
import { beforeEach, afterEach } from 'vitest';
import {
    resetCoreStubs,
    setFakeChat,
    setFakeContextExtras,
    getFakeMeta,
    getFakeDownloadJsonCalls,
} from './stubs/core.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { MWT_VERSION } from '../core/version.js';
import { _clearCacheForTests, _setCacheForTests, resetStoreCache, STORE_SENTINEL, withStoreLock, writeField } from '../knowledge/store.js';
import { getRegistry, getStateRegistry } from '../knowledge/registry.js';
import { getRelationships, getStance, getStances, getStanceSources, saveRelationships } from '../knowledge/relationships.js';
import { state as knowledgeState } from '../knowledge/state.js';

function arc(id, title = id) {
    return {
        id, title, body: 'body', section: 'emerging', status: 'active', pinned: false,
        beats: [], beatIndex: 0, turnsSinceAdvance: 0, createdAt: 1, updatedAt: 1,
    };
}

function backup(overrides = {}) {
    return buildBackupEnvelope({
        identity: { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null },
        metadata: {
            worldState: { text: 'new state', autoSaveHistory: [{ text: 'old', timestamp: 1 }] },
            chronicle: { snapshots: [{ id: 's2', text: 'new snapshot' }], _deletedBin: [] },
            knowledgeEvidence: {
                Mara: { npc: 'Mara', raw: [{ id: 'r2', claim: 'new', quote: 'quote' }], consolidated: [], archivedRaw: [] },
            },
            knowledgeCounters: { messageCounter: 3 },
            storyPlanner: { arcs: [arc('a2')] },
            interiority: {
                ledger: [{ id: 'i2', npc: 'Mara', action: 'wait', trigger: 'dawn' }],
                deletedIntentions: [], perMessage: { 'mu-2': { generatedAt: 2 } },
            },
        },
        ...overrides,
    });
}

describe('unified backup Phase 1 pure core', () => {
    test('builds a whitelisted, versioned envelope and clones source data', () => {
        const metadata = { worldState: { text: 'state' }, secretSettings: { apiKey: 'do-not-export' } };
        const result = buildBackupEnvelope({ metadata, identity: { chatId: 'chat-a' }, mwtVersion: '1.4.23' });
        expect(result._meta.type).toBe(BACKUP_TYPE);
        expect(result._meta.formatVersion).toBe(1);
        expect(result._meta.mwtVersion).toBe('1.4.23');
        expect(result.sections.worldState.data).toEqual({ text: 'state' });
        expect(result.sections.secretSettings).toBeUndefined();
        expect(result.sections.knowledgeEvidence).toBeUndefined();
        metadata.worldState.text = 'changed after export';
        expect(result.sections.worldState.data.text).toBe('state');
    });

    test('rejects wrong type and unknown-high versions before section validation', () => {
        expect(validateBackupEnvelope({ _meta: { type: 'world-state-archive', formatVersion: 1 }, sections: {} }).ok).toBe(false);
        const future = backup();
        future._meta.formatVersion = 2;
        const result = validateBackupEnvelope(future);
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/newer than the supported version/);
    });

    test('quarantines malformed records while retaining valid records', () => {
        const file = backup();
        file.sections.chronicle.data.snapshots.push({ id: 'bad', text: '' });
        file.sections.interiority.data.ledger.push({ id: 'bad' });
        const result = validateBackupEnvelope(file);
        expect(result.ok).toBe(true);
        expect(result.sections.chronicle.snapshots).toHaveLength(1);
        expect(result.sections.interiority.ledger).toHaveLength(1);
        expect(result.summaries.chronicle.skipped).toHaveLength(1);
        expect(result.summaries.interiority.skipped).toHaveLength(1);
    });

    test('rejects zero and negative format versions as invalid', () => {
        const zero = backup();
        zero._meta.formatVersion = 0;
        expect(validateBackupEnvelope(zero).errors[0]).toMatch(/not a positive integer/);

        const negative = backup();
        negative._meta.formatVersion = -3;
        const negativeResult = validateBackupEnvelope(negative);
        expect(negativeResult.ok).toBe(false);
        expect(negativeResult.errors[0]).toMatch(/not a positive integer/);
    });

    test('rejects zero and negative section schema versions as invalid', () => {
        const file = backup();
        file.sections.worldState.schemaVersion = 0;
        const result = validateBackupEnvelope(file);
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/not a positive integer/);
    });

    test('quarantines registry records without a numeric uid and relationship edges missing fields', () => {
        const file = backup({
            knowledgeStore: {
                registry: { Good: { uid: 7 }, Bad: { type: 'minor' } },
                relationships: {
                    Good: [{ target: 'Kira', type: 'ally' }],
                    Vague: [{ target: 'Kira' }],
                },
                stateRegistry: { Weather: { uid: 3 } },
            },
        });
        const result = validateBackupEnvelope(file);
        expect(result.ok).toBe(true);
        expect(result.sections.knowledgeStore.registry).toEqual({ Good: { uid: 7 } });
        expect(result.sections.knowledgeStore.stateRegistry).toEqual({ Weather: { uid: 3 } });
        expect(result.sections.knowledgeStore.relationships.Good).toHaveLength(1);
        expect(result.sections.knowledgeStore.relationships.Vague).toEqual([]);
        expect(result.summaries.knowledgeStore.skipped.map(s => s.record)).toEqual(
            expect.arrayContaining(['Bad', 'Vague']),
        );
    });

    test('accepts orphan null UIDs but rejects negative and fractional UIDs', () => {
        const file = backup({
            knowledgeStore: {
                registry: {
                    Orphan: { uid: null },
                    Fresh: { uid: 0 },
                    Neg: { uid: -1 },
                    Frac: { uid: 1.5 },
                },
                relationships: {},
                stateRegistry: {},
            },
        });
        const result = validateBackupEnvelope(file);
        expect(result.ok).toBe(true);
        expect(result.sections.knowledgeStore.registry).toEqual({
            Orphan: { uid: null },
            Fresh: { uid: 0 },
        });
        expect(result.summaries.knowledgeStore.skipped.map(s => s.record)).toEqual(
            expect.arrayContaining(['Neg', 'Frac']),
        );
    });

    test('validates and quarantines malformed stances and stance sources', () => {
        const file = backup({
            knowledgeStore: {
                registry: {},
                relationships: {},
                stances: { Mara: 'wary', Bad: 42 },
                stanceSources: { Mara: 'manual', Ghost: null },
                stateRegistry: {},
            },
        });
        const result = validateBackupEnvelope(file);
        expect(result.ok).toBe(true);
        expect(result.sections.knowledgeStore.stances).toEqual({ Mara: 'wary' });
        expect(result.sections.knowledgeStore.stanceSources).toEqual({ Mara: 'manual' });
        expect(result.summaries.knowledgeStore.skipped.map(s => s.record)).toEqual(
            expect.arrayContaining(['Bad', 'Ghost']),
        );
    });

    test('plans merge without overwriting current append-only records and re-caps trash', () => {
        const importedTrash = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, text: `trash ${i}` }));
        const file = backup({ metadata: { chronicle: { snapshots: [{ id: 's2', text: 'new' }], _deletedBin: importedTrash } } });
        const result = planRestore(file, {
            chronicle: { snapshots: [{ id: 's2', text: 'user edit' }], _deletedBin: [] },
        });
        expect(result.ok).toBe(true);
        expect(result.plan.sections.chronicle.snapshots[0].text).toBe('user edit');
        expect(result.plan.sections.chronicle._deletedBin).toHaveLength(MAX_TRASH_SIZE);
        expect(result.summary.chronicle.conflicts).toBe(1);
        expect(result.summary.chronicle.updated).toBe(1);
    });

    test('does not replace a current section with an empty payload', () => {
        const file = backup({ metadata: { worldState: {} } });
        const result = planRestore(file, {
            worldState: { text: 'mature state', provenance: { entities: { Mara: {} } } },
        });

        expect(result.plan.sections.worldState).toEqual({
            text: 'mature state', provenance: { entities: { Mara: {} } },
        });
        expect(result.summary.worldState.skipped[0].reason).toMatch(/Empty replace payload/);
    });

    test('preserves merge scalars and reports protected session settings', () => {
        const file = backup({
            metadata: {
                chronicle: {
                    snapshots: [], injectEnabled: true, injectCount: 9,
                    lastAnchor: { msgIndex: 9 }, msgSinceSnapshot: 9,
                },
                interiority: { enabled: false, turnCounter: 999, ledger: [], deletedIntentions: [] },
            },
        });
        const result = planRestore(file, {
            chronicle: {
                snapshots: [], injectEnabled: false, injectCount: 2,
                lastAnchor: { msgIndex: 2 }, msgSinceSnapshot: 2,
            },
            interiority: { enabled: true, turnCounter: 4, ledger: [], deletedIntentions: [] },
        });

        expect(result.plan.sections.chronicle).toMatchObject({
            injectEnabled: false, injectCount: 2,
            lastAnchor: { msgIndex: 9 }, msgSinceSnapshot: 9,
        });
        expect(result.plan.sections.interiority).toMatchObject({ enabled: true, turnCounter: 4 });
        expect(result.summary.chronicle.skipped).toHaveLength(2);
        expect(result.summary.interiority.skipped).toHaveLength(2);
    });

    test('merges Story Planner arcs by id instead of replacing the current plan', () => {
        const file = backup({ metadata: { storyPlanner: { arcs: [arc('a2', 'Backup arc')] } } });
        const result = planRestore(file, {
            storyPlanner: { arcs: [arc('a1', 'Arc I wrote today')] },
        });

        expect(result.plan.sections.storyPlanner.arcs.map(item => item.id)).toEqual(['a1', 'a2']);
        expect(result.summary.storyPlanner.added).toBe(1);
    });

    test('skips perMessage on identity mismatch and reports resolution count', () => {
        const result = planRestore(backup(), { interiority: { perMessage: {} } }, {
            currentIdentity: { chatId: 'chat-b', isUnknown: false },
            currentMessageIds: ['mu-2'],
        });
        expect(result.sameChat).toBe(false);
        expect(result.plan.sections.interiority.perMessage).toEqual({});
        expect(result.summary.interiority.perMessage).toEqual({
            imported: 1, resolved: 1, sameChat: false, messageIds: ['mu-2'],
        });
    });

    test('reconciles new names without trusting source-local UIDs', () => {
        const result = reconcileNameMap(
            { Mara: { uid: 7 } },
            { Mara: { uid: 99 }, Kira: { uid: 12 } },
        );
        expect(result.data.Mara).toEqual({ uid: 7 });
        expect(result.data.Kira).toEqual({ uid: null });
        expect(result.summary.conflicts).toBe(1);
    });
});

describe('unified backup Phase 2a collection/export', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        _clearCacheForTests();
        globalThis.SillyTavern = {
            getContext: () => ({ getCurrentChatId: () => 'chat-a' }),
        };
        setFakeContextExtras({
            getCurrentChatId: () => 'chat-a',
            chatName: 'A Quiet Evening',
        });
        setFakeChat([{ mes: 'hello' }, { mes: 'goodbye' }]);
        _setCacheForTests('Knowledge Tracker', {
            registry: { Mara: { uid: 7 } },
            relationships: { Mara: [{ target: 'Kira', type: 'ally' }] },
        });
        _setCacheForTests('State Tracker', {
            stateRegistry: { Weather: { uid: 3 } },
        });
    });

    afterEach(() => {
        _clearCacheForTests();
        _resetEpoch();
        delete globalThis.SillyTavern;
    });

    test('collects present metadata sections and the hydrated store without secrets', async () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'state' };
        getFakeMeta().session_chronicle_data = { snapshots: [{ id: 's1', text: 'entry' }] };
        getFakeMeta().unrelated_settings = { apiKey: 'secret' };

        const result = await collectBackup({ mwtVersion: '1.4.23' });

        expect(Object.keys(result.sections)).toEqual([
            'worldState', 'chronicle', 'knowledgeStore',
        ]);
        expect(result.sections.worldState.data).toEqual({ text: 'state' });
        expect(result.sections.knowledgeStore.storeVersion).toBe(1);
        // The store version is carried by the wrapper
        // (storeVersion) only — it is NOT duplicated inside `data`.
        expect(result.sections.knowledgeStore.data).toEqual({
            registry: { Mara: { uid: 7 } },
            relationships: { Mara: [{ target: 'Kira', type: 'ally' }] },
            stances: {},
            stanceSources: {},
            stateRegistry: { Weather: { uid: 3 } },
        });
        expect(result._meta.chatName).toBe('A Quiet Evening');
        expect(result._meta.messageCount).toBe(2);
        expect(result._meta.identity.chatId).toBe('chat-a');
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    test('detaches collected data and can export without downloading', async () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'before' };
        const result = await exportBackup({ download: false });

        getFakeMeta().world_state_tracker_metadata.text = 'after';
        expect(result.sections.worldState.data.text).toBe('before');
        // Production exports must identify their writer; only explicit callers
        // (tests, console) may override the version.
        expect(result._meta.mwtVersion).toBe(MWT_VERSION);
        expect(getBackupChatName({ chatName: '  Named chat  ' }, { chatId: 'id' })).toBe('Named chat');
        expect(getBackupFilename(result, 123)).toBe('mwt_backup_A_Quiet_Evening_123.json');
    });
});

describe('unified backup Phase 2b metadata restore', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        _clearCacheForTests();
        globalThis.SillyTavern = {
            getContext: () => ({ getCurrentChatId: () => 'chat-a' }),
        };
        setFakeContextExtras({ getCurrentChatId: () => 'chat-a' });
        setFakeChat([{ mes: 'hello', extra: { mwt_uuid: '2' } }]);
        _setCacheForTests('Knowledge Tracker', { registry: {}, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });
    });

    afterEach(() => {
        _clearCacheForTests();
        _resetEpoch();
        delete globalThis.SillyTavern;
    });

    test('previews against live metadata and resolves current per-message UUIDs', async () => {
        getFakeMeta().mwt_interiority = { ledger: [], deletedIntentions: [], perMessage: {} };
        const result = await previewRestore(backup());

        expect(result.ok).toBe(true);
        expect(result.sameChat).toBe(true);
        expect(result.summary.interiority.perMessage).toMatchObject({
            imported: 1, resolved: 1, sameChat: true,
        });
    });

    test('requires confirmation and makes no download or metadata change before it', async () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };

        const result = await restoreBackup(backup({ metadata: { worldState: { text: 'restored state' } } }));

        expect(result).toMatchObject({ ok: false, committed: false, reason: 'confirmation-required' });
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'current state' });
        expect(getFakeDownloadJsonCalls()).toEqual([]);
    });

    test('downloads a pre-restore snapshot, commits metadata, and exactly restores it on undo', async () => {
        let saveCount = 0;
        setFakeContextExtras({ saveMetadata: async () => { saveCount++; } });
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };
        getFakeMeta().unrelated_settings = { apiKey: 'must remain' };
        const file = backup({ metadata: { worldState: { text: 'restored state' } } });

        const result = await restoreBackup(file, { confirm: true });

        expect(result).toMatchObject({ ok: true, committed: true });
        expect(saveCount).toBe(1);
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'restored state' });
        expect(getFakeMeta().unrelated_settings).toEqual({ apiKey: 'must remain' });
        expect(getFakeDownloadJsonCalls()).toHaveLength(1);
        expect(getFakeDownloadJsonCalls()[0].data.sections.worldState.data).toEqual({ text: 'current state' });
        expect(getFakeDownloadJsonCalls()[0].data.sections.knowledgeStore).toBeDefined();

        const undo = await undoLastRestore({ confirm: true });
        expect(undo).toMatchObject({ ok: true, committed: true });
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'current state' });
        expect(getFakeDownloadJsonCalls()).toHaveLength(2);
    });

    test('undo removes records that merge restore added', async () => {
        getFakeMeta().session_chronicle_data = { snapshots: [{ id: 's1', text: 'current snapshot' }], _deletedBin: [] };
        const file = backup({ metadata: { chronicle: { snapshots: [{ id: 's2', text: 'restored snapshot' }], _deletedBin: [] } } });

        await restoreBackup(file, { confirm: true });
        expect(getFakeMeta().session_chronicle_data.snapshots.map(snapshot => snapshot.id)).toEqual(['s1', 's2']);

        const undo = await undoLastRestore({ confirm: true });
        expect(undo).toMatchObject({ ok: true, committed: true });
        expect(getFakeMeta().session_chronicle_data.snapshots).toEqual([{ id: 's1', text: 'current snapshot' }]);
    });

    test('refuses an invalid file without downloading or writing metadata', async () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };

        const result = await restoreBackup({ _meta: { type: 'wrong', formatVersion: 1 }, sections: {} }, { confirm: true });

        expect(result).toMatchObject({ ok: false, committed: false, reason: 'invalid-backup' });
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'current state' });
        expect(getFakeDownloadJsonCalls()).toEqual([]);
    });

    test('abandons the commit if the chat changes while creating the recovery backup', async () => {
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };
        const originalGetCurrentChatId = () => 'chat-a';
        setFakeContextExtras({
            getCurrentChatId: originalGetCurrentChatId,
            saveMetadata: async () => { throw new Error('must not save'); },
        });
        const pending = restoreBackup(backup({ metadata: { worldState: { text: 'restored state' } } }), { confirm: true });
        bumpEpoch();

        const result = await pending;

        expect(result).toMatchObject({ ok: false, committed: false, reason: 'stale-scope' });
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'current state' });
        // The async destination-aware preview now sees the scope change before
        // starting the recovery export, which is safer than creating a stale
        // backup file.
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    test('previews the Knowledge store against the hydrated destination baseline', async () => {
        _setCacheForTests('Knowledge Tracker', { registry: { Mara: { uid: 7 } }, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });
        knowledgeState.wiScript = {
            loadWorldInfo: async name => name === 'Knowledge Tracker'
                ? { entries: { 12: { uid: 12, comment: 'Kira' } } }
                : { entries: {} },
        };
        const file = backup({
            knowledgeStore: { registry: { Mara: { uid: 99 }, Kira: { uid: 12 } }, relationships: {}, stateRegistry: {} },
        });

        const result = await previewRestore(file);

        expect(result.ok).toBe(true);
        expect(result.summary.knowledgeStore).toMatchObject({ added: 1, conflicts: 1 });
        expect(result.plan.sections.knowledgeStore.registry.Mara).toEqual({ uid: 7 });
    });

    test('re-resolves store UIDs in destination books and omits missing lorebook entries', async () => {
        const books = new Map([
            ['Knowledge Tracker', { entries: {
                4: { uid: 4, comment: 'Kira', content: 'existing dossier' },
            } }],
            ['State Tracker', { entries: {
                8: { uid: 8, comment: '[Tracker] Moon', content: 'existing tracker' },
            } }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => { books.set(name, structuredClone(info)); },
            createNewWorldInfo: async name => { books.set(name, { entries: {} }); },
        };
        _setCacheForTests('Knowledge Tracker', { registry: {}, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });
        const file = backup({
            metadata: { worldState: { text: 'restored state' } },
            knowledgeStore: {
                registry: { Kira: { uid: 912, type: 'minor' }, Missing: { uid: 913, type: 'minor' } },
                relationships: { Kira: [{ target: 'Missing', type: 'ally' }] },
                stateRegistry: { Moon: { uid: 914 }, Lost: { uid: 915 } },
            },
        });

        const result = await restoreBackup(file, { confirm: true });

        expect(result).toMatchObject({ ok: true, committed: true });
        expect(getRegistry().Kira).toMatchObject({ uid: 4, type: 'minor' });
        expect(getRegistry().Missing).toBeUndefined();
        expect(getStateRegistry().Moon).toMatchObject({ uid: 8 });
        expect(getStateRegistry().Lost).toBeUndefined();
        expect(result.preview.summary.knowledgeStore.skipped).toEqual(expect.arrayContaining([
            expect.objectContaining({ record: 'Missing' }),
            expect.objectContaining({ record: 'Lost' }),
        ]));
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'restored state' });
    });

    test('reports destination omissions in the dry run before confirmation', async () => {
        knowledgeState.wiScript = {
            loadWorldInfo: async () => ({ entries: {} }),
            saveWorldInfo: async () => {},
        };
        const file = backup({
            knowledgeStore: { registry: { Missing: { uid: 99 } }, relationships: {}, stateRegistry: {} },
        });

        const preview = await previewRestore(file);
        const result = await restoreBackup(file);

        expect(preview.ok).toBe(true);
        expect(preview.plan.sections.knowledgeStore.registry.Missing).toBeUndefined();
        expect(preview.summary.knowledgeStore.skipped).toEqual(expect.arrayContaining([
            expect.objectContaining({ record: 'Missing' }),
        ]));
        expect(result).toMatchObject({ ok: false, committed: false, reason: 'confirmation-required' });
        expect(result.preview.summary.knowledgeStore.skipped).toEqual(preview.summary.knowledgeStore.skipped);
    });

    test('does not persist metadata when a lorebook-store flush fails', async () => {
        const books = new Map([
            ['Knowledge Tracker', { entries: { 4: { uid: 4, comment: 'Kira' } } }],
            ['State Tracker', { entries: { 8: { uid: 8, comment: '[Tracker] Moon' } } }],
        ]);
        const saveWorldInfo = vi.fn(async (name, info) => {
            if (name === 'State Tracker') throw new Error('disk full');
            books.set(name, structuredClone(info));
        });
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo,
            createNewWorldInfo: async name => { books.set(name, { entries: {} }); },
        };
        _setCacheForTests('Knowledge Tracker', { registry: {}, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };
        const file = backup({
            metadata: { worldState: { text: 'restored state' } },
            knowledgeStore: { registry: { Kira: { uid: 1 } }, relationships: {}, stateRegistry: { Moon: { uid: 2 } } },
        });

        const result = await restoreBackup(file, { confirm: true });

        expect(result).toMatchObject({
            ok: false,
            committed: false,
            reason: 'store-flush-failed',
            failedBooks: ['State Tracker'],
            partialCommit: true,
        });
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'current state' });
        expect(saveWorldInfo).toHaveBeenCalledWith('Knowledge Tracker', expect.any(Object), true);
        expect(getRegistry()).toEqual({});
        expect(getStateRegistry()).toEqual({});
        const restoredStore = Object.values(books.get('Knowledge Tracker').entries)
            .find(entry => String(entry.comment || '').startsWith('[MWT:store]'));
        expect(JSON.parse(restoredStore.content).registry).toEqual({});
    });

    test('rolls back flushed lorebooks when the chat switches mid-restore', async () => {
        const books = new Map([
            ['Knowledge Tracker', { entries: { 1: { uid: 1, comment: 'Kira' } } }],
            ['State Tracker', { entries: { 2: { uid: 2, comment: '[Tracker] Moon' } } }],
        ]);
        let knowledgeSaves = 0;
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => {
                books.set(name, structuredClone(info));
                // Simulate a chat switch once the first book reaches disk.
                if (name === 'Knowledge Tracker') {
                    knowledgeSaves++;
                    if (knowledgeSaves === 1) bumpEpoch();
                }
            },
            createNewWorldInfo: async name => { books.set(name, { entries: {} }); },
        };
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };
        const file = backup({
            metadata: { worldState: { text: 'restored state' } },
            knowledgeStore: {
                registry: { Kira: { uid: 1 } },
                relationships: {},
                stateRegistry: { Moon: { uid: 2 } },
            },
        });

        const result = await restoreBackup(file, { confirm: true });

        expect(result).toMatchObject({ ok: false, committed: false, reason: 'stale-scope' });
        // The flushed book is rolled back to its empty pre-restore store rather
        // than left holding the restored registry.
        expect(getRegistry()).toEqual({});
        expect(getStateRegistry()).toEqual({});
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'current state' });
        const rolledBackStore = Object.values(books.get('Knowledge Tracker').entries)
            .find(entry => String(entry.comment || '').startsWith('[MWT:store]'));
        expect(JSON.parse(rolledBackStore.content).registry).toEqual({});
    });

    test('rolls back the store and in-memory metadata when metadata persistence fails', async () => {
        const books = new Map([
            ['Knowledge Tracker', { entries: { 1: { uid: 1, comment: 'Kira' } } }],
            ['State Tracker', { entries: { 2: { uid: 2, comment: '[Tracker] Moon' } } }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => { books.set(name, structuredClone(info)); },
            createNewWorldInfo: async name => { books.set(name, { entries: {} }); },
        };
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };
        setFakeContextExtras({ saveMetadata: async () => { throw new Error('persist failed'); } });
        const file = backup({
            metadata: { worldState: { text: 'restored state' } },
            knowledgeStore: {
                registry: { Kira: { uid: 1 } },
                relationships: {},
                stateRegistry: { Moon: { uid: 2 } },
            },
        });

        const result = await restoreBackup(file, { confirm: true });

        expect(result).toMatchObject({
            ok: false,
            committed: false,
            reason: 'metadata-persist-failed',
            partialCommit: true,
            rolledBackBooks: ['Knowledge Tracker', 'State Tracker'],
        });
        // The durable lorebook flushes and the in-memory metadata are both
        // reversed to the pre-restore state.
        expect(getRegistry()).toEqual({});
        expect(getStateRegistry()).toEqual({});
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'current state' });
        const rolledBackStore = Object.values(books.get('Knowledge Tracker').entries)
            .find(entry => String(entry.comment || '').startsWith('[MWT:store]'));
        expect(JSON.parse(rolledBackStore.content).registry).toEqual({});
    });

    test('metadata persist failure is detected in strict mode (production parity)', async () => {
        // Non-strict callers (e.g. high-frequency pointer writes) must survive a
        // saveMetadata failure by falling back to a debounced save. A strict
        // caller (the backup restore) MUST see the failure so it can roll back.
        const { persistChatMetaNow } = await import('../core/index.js');
        setFakeContextExtras({ saveMetadata: async () => { throw new Error('boom'); } });
        await expect(persistChatMetaNow()).resolves.toBeUndefined();
        await expect(persistChatMetaNow({ strict: true })).rejects.toThrow('boom');
    });

    test('exact undo removes a knowledge record that the merge restore added', async () => {
        const books = new Map([
            ['Knowledge Tracker', { entries: { 5: { uid: 5, comment: 'Mara' } } }],
            ['State Tracker', { entries: {} }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => { books.set(name, structuredClone(info)); },
            createNewWorldInfo: async name => { books.set(name, { entries: {} }); },
        };
        _setCacheForTests('Knowledge Tracker', { registry: {}, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });

        // Start empty. Restore a backup that adds Mara.
        await restoreBackup(backup({
            metadata: { worldState: { text: 'restored' } },
            knowledgeStore: { registry: { Mara: { uid: 5 } }, relationships: {}, stateRegistry: {} },
        }), { confirm: true });
        expect(getRegistry().Mara).toMatchObject({ uid: 5 });

        // Undo must remove Mara — exact replacement, not a merge.
        const undo = await undoLastRestore({ confirm: true });
        expect(undo).toMatchObject({ ok: true, committed: true });
        expect(getRegistry()).toEqual({});
    });

    test('exact undo removes a stance that the merge restore added', async () => {
        const books = new Map([
            ['Knowledge Tracker', { entries: { 5: { uid: 5, comment: 'Mara' } } }],
            ['State Tracker', { entries: {} }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => { books.set(name, structuredClone(info)); },
            createNewWorldInfo: async name => { books.set(name, { entries: {} }); },
        };
        _setCacheForTests('Knowledge Tracker', {
            registry: { Mara: { uid: 5 } }, relationships: {}, stances: {}, stanceSources: {},
        });
        _setCacheForTests('State Tracker', { stateRegistry: {} });

        // Start with Mara but no stance. Restore a backup that sets a stance.
        await restoreBackup(backup({
            metadata: { worldState: { text: 'restored' } },
            knowledgeStore: {
                registry: { Mara: { uid: 5 } }, relationships: {},
                stances: { Mara: 'wary' }, stanceSources: { Mara: 'manual' },
                stateRegistry: {},
            },
        }), { confirm: true });
        expect(getStance('Mara')).toBe('wary');

        // Undo must remove the stance — exact replacement, not a merge.
        const undo = await undoLastRestore({ confirm: true });
        expect(undo).toMatchObject({ ok: true, committed: true });
        expect(getStances()).toEqual({});
        expect(getStanceSources()).toEqual({});
    });

    test('stale-scope rollback reports rollbackFailedBooks', async () => {
        const books = new Map([
            ['Knowledge Tracker', { entries: { 1: { uid: 1, comment: 'Kira' } } }],
            ['State Tracker', { entries: { 2: { uid: 2, comment: '[Tracker] Moon' } } }],
        ]);
        let knowledgeSaves = 0;
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => {
                books.set(name, structuredClone(info));
                if (name === 'Knowledge Tracker') {
                    knowledgeSaves++;
                    if (knowledgeSaves === 1) {
                        // Bump epoch after the first successful flush so the
                        // next assertSameScope detects a mid-restore switch.
                        bumpEpoch();
                    } else if (knowledgeSaves === 2) {
                        // The rollback save fails.
                        throw new Error('rollback disk error');
                    }
                }
            },
            createNewWorldInfo: async name => { books.set(name, { entries: {} }); },
        };
        getFakeMeta().world_state_tracker_metadata = { text: 'current' };
        const file = backup({
            metadata: { worldState: { text: 'restored' } },
            knowledgeStore: {
                registry: { Kira: { uid: 1 } }, relationships: {},
                stateRegistry: { Moon: { uid: 2 } },
            },
        });

        const result = await restoreBackup(file, { confirm: true });

        expect(result).toMatchObject({ ok: false, reason: 'stale-scope' });
        // The rollback failure must remain visible, not be swallowed by staleResult.
        expect(result.rollbackFailedBooks).toEqual(['Knowledge Tracker']);
        expect(result.rolledBackBooks).toEqual([]);
    });

    test('exact undo plan and summary reflect the resolved knowledge store', async () => {
        const books = new Map([
            ['Knowledge Tracker', { entries: { 4: { uid: 4, comment: 'Kira' } } }],
            ['State Tracker', { entries: {} }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => { books.set(name, structuredClone(info)); },
            createNewWorldInfo: async name => { books.set(name, { entries: {} }); },
        };
        // Ghost carries a uid that no destination entry satisfies.
        _setCacheForTests('Knowledge Tracker', { registry: { Kira: { uid: 4 }, Ghost: { uid: 99 } }, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });

        // A confirmed restore captures the live store (Kira + Ghost) as the
        // exact snapshot that undo replays.
        await restoreBackup(backup({ metadata: { worldState: { text: 'restored state' } } }), { confirm: true });

        const undo = await undoLastRestore({ confirm: false });

        expect(undo).toMatchObject({ ok: false, reason: 'confirmation-required' });
        // The plan (and therefore the confirmation summary) is the resolved
        // plan: Ghost is omitted, not carried through from the raw source.
        expect(undo.preview.plan.sections.knowledgeStore.registry.Ghost).toBeUndefined();
        expect(undo.preview.plan.sections.knowledgeStore.registry.Kira).toMatchObject({ uid: 4 });
        expect(undo.preview.summary.knowledgeStore.skipped).toEqual(expect.arrayContaining([
            expect.objectContaining({ record: 'Ghost' }),
        ]));
    });

    test('preserves a live renamed registry target during exact undo', async () => {
        const books = new Map([
            ['Knowledge Tracker', { entries: { 4: { uid: 4, comment: 'Renamed in World Info' } } }],
            ['State Tracker', { entries: {} }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => { books.set(name, structuredClone(info)); },
        };
        _setCacheForTests('Knowledge Tracker', { registry: { Mara: { uid: 4 } }, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });
        await restoreBackup(backup({ metadata: { worldState: { text: 'restored state' } } }), { confirm: true });

        const undo = await undoLastRestore({ confirm: true });

        expect(undo).toMatchObject({ ok: true, committed: true });
        expect(getRegistry().Mara).toEqual({ uid: 4 });
    });

    test('keeps exact undo summaries aligned with exact replacement', async () => {
        getFakeMeta().session_chronicle_data = { snapshots: [{ id: 's1', text: 'before' }], _deletedBin: [] };
        await restoreBackup(backup({ metadata: { chronicle: { snapshots: [{ id: 's2', text: 'after' }], _deletedBin: [] } } }), { confirm: true });

        const undo = await undoLastRestore({ confirm: false });

        expect(undo).toMatchObject({ ok: false, reason: 'confirmation-required' });
        expect(undo.preview.summary.chronicle).toMatchObject({ mode: 'exact', action: 'replaced', conflicts: 0 });
        expect(undo.preview.summary.chronicle.skipped).toEqual([]);
    });

    test('gates exact/replace restore on a verifiable same-chat identity', async () => {
        // Merge restore still reports the unavailable store when the cache is cleared.
        const file = backup({ knowledgeStore: { registry: {}, relationships: {}, stateRegistry: {} } });
        _clearCacheForTests();
        const unavailable = await restoreBackup(file, { confirm: true });
        expect(unavailable).toMatchObject({ ok: false, committed: false, reason: 'knowledge-store-unavailable' });

        const sameChatIdentity = { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null, key: 'chat:chat-a' };

        // Same-chat, known identity: exact is permitted (it clears the identity
        // gate) and is then blocked only by the unavailable store.
        const exactSameChat = await restoreBackup(
            backup({ identity: sameChatIdentity, knowledgeStore: { registry: {}, relationships: {}, stateRegistry: {} } }),
            { confirm: true, exact: true },
        );
        expect(exactSameChat).toMatchObject({ ok: false, committed: false, reason: 'knowledge-store-unavailable' });

        // Different chat: exact replacement is never permitted across chats.
        const crossChat = await restoreBackup(
            backup({ identity: { chatId: 'chat-other', isUnknown: false, characterKey: null, groupKey: null, key: 'chat:chat-other' } }),
            { confirm: true, exact: true },
        );
        expect(crossChat).toMatchObject({ ok: false, committed: false, reason: 'exact-cross-chat-blocked' });

        // Unknown identity: exact/replace is disabled entirely with a prominent warning.
        const savedSt = globalThis.SillyTavern;
        delete globalThis.SillyTavern;
        const unknownBlock = await restoreBackup(backup({ identity: sameChatIdentity }), { confirm: true, exact: true });
        expect(unknownBlock).toMatchObject({ ok: false, committed: false, reason: 'exact-identity-required' });
        expect(unknownBlock.warning).toMatch(/cannot verify chat identity/);
        globalThis.SillyTavern = savedSt;
    });

    test('uses one pre-restore filename prefix', async () => {
        await restoreBackup(backup(), { confirm: true });

        expect(getFakeDownloadJsonCalls()[0].filename).toMatch(/^mwt_pre_restore_chat-a_\d+\.json$/);
        expect(getFakeDownloadJsonCalls()[0].filename).not.toContain('mwt_backup_');
    });

    test('refuses undo after the active chat changes', async () => {
        let chatId = 'chat-a';
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => chatId }) };
        setFakeContextExtras({ getCurrentChatId: () => chatId });
        getFakeMeta().world_state_tracker_metadata = { text: 'current state' };
        await restoreBackup(backup({ metadata: { worldState: { text: 'restored state' } } }), { confirm: true });
        chatId = 'chat-b';

        const result = await undoLastRestore({ confirm: true });

        expect(result).toMatchObject({ ok: false, committed: false, reason: 'restore-origin-mismatch' });
        expect(getFakeMeta().world_state_tracker_metadata).toEqual({ text: 'restored state' });
    });
});

describe('unified backup Phase 3 hardening', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.SillyTavern = {
            getContext: () => ({ getCurrentChatId: () => 'chat-a' }),
            extensionSettings: { worldInfo: {} },
        };
        setFakeContextExtras({ getCurrentChatId: () => 'chat-a' });
    });

    afterEach(() => {
        _clearCacheForTests();
        _resetEpoch();
        delete globalThis.SillyTavern;
    });

    test('persistChatMetaNow throws in strict mode when the immediate save API is missing', async () => {
        // A missing saveMetadata used to fall through to the
        // debounced save and return normally, so a strict caller believed the
        // write was durable when it was only queued.
        const { persistChatMetaNow } = await import('../core/metadata.js');
        setFakeContextExtras({ saveMetadata: undefined });
        await expect(persistChatMetaNow({ strict: true })).rejects.toThrow(/immediate saveMetadata API/);
        // Non-strict keeps the resilient debounced fallback and does not throw.
        await expect(persistChatMetaNow({ strict: false })).resolves.toBeUndefined();
    });

    test('reuses the preview resolution instead of a third lorebook read per commit', async () => {
        // A one-book commit previously performed three
        // resolution passes (preview, commit re-plan, and a redundant resolve at
        // commit time) plus the read inside flushBook. Reusing the re-plan's
        // resolution drops the redundant pass.
        const knowledgeBook = 'Knowledge Tracker';
        const books = new Map([
            [knowledgeBook, { entries: { 4: { uid: 4, comment: 'Mara' }, 5: { uid: 5, comment: 'Kira' } } }],
            ['State Tracker', { entries: {} }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: vi.fn(async name => structuredClone(books.get(name) || { entries: {} })),
            saveWorldInfo: async (name, info) => { books.set(name, structuredClone(info)); },
        };
        _setCacheForTests(knowledgeBook, { registry: { Mara: { uid: 4 } }, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });

        await restoreBackup(backup({
            knowledgeStore: { registry: { Mara: { uid: 4 }, Kira: { uid: 5 } }, relationships: {}, stateRegistry: {} },
        }), { confirm: true });

        // Three reads: the user-facing preview resolve, the commit re-plan
        // resolve, and the one inside flushBook. (Was four pre-fix.)
        expect(knowledgeState.wiScript.loadWorldInfo).toHaveBeenCalledTimes(3);
    });
    test('refuses to commit when the confirmed preview no longer matches', async () => {
        // If the plan the user confirmed drifts before the
        // commit (here, a destination entry disappears so an NPC is newly
        // omitted), the commit must return reconfirmation-required without writing.
        const knowledgeBook = 'Knowledge Tracker';
        const books = new Map([
            [knowledgeBook, { entries: { 4: { uid: 4, comment: 'Mara' }, 5: { uid: 5, comment: 'Kira' } } }],
            ['State Tracker', { entries: {} }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => { books.set(name, structuredClone(info)); },
        };
        _setCacheForTests(knowledgeBook, { registry: { Mara: { uid: 4 } }, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });

        const file = backup({
            knowledgeStore: { registry: { Mara: { uid: 4 }, Kira: { uid: 5 } }, relationships: {}, stateRegistry: {} },
        });
        const preview = await previewRestore(file);
        expect(preview.previewToken).toEqual(fingerprintPreview(preview));
        const confirmedToken = preview.previewToken;

        // Between confirm and commit, Kira's destination entry vanishes, so the
        // omission list grows and the freshly re-planned token must differ.
        books.set(knowledgeBook, { entries: { 4: { uid: 4, comment: 'Mara' } } });

        const blocked = await restoreBackup(file, { confirm: true, previewToken: confirmedToken });
        expect(blocked).toMatchObject({ ok: false, committed: false, reason: 'reconfirmation-required' });
        // Nothing was written: Kira never reached the registry.
        expect(getRegistry().Kira).toBeUndefined();

        // Without the stale token the commit proceeds (it now simply omits Kira).
        const committed = await restoreBackup(file, { confirm: true });
        expect(committed).toMatchObject({ ok: true, committed: true });
    });

    test('serializes the restore rollback against a concurrent cache reset', async () => {
        // A real chat change bumps the epoch AND starts
        // resetStoreCache(), whose flushAll() flushes the same dirty cache the
        // restore is flushing. Before serialization that race re-persisted the
        // cancelled restore after it was supposedly rolled back.
        const knowledgeBook = 'Knowledge Tracker';
        let restoreSaveCount = 0;
        let resetPromise;
        const books = new Map([
            [knowledgeBook, { entries: { 4: { uid: 4, comment: 'Mara' }, 5: { uid: 5, comment: 'Kira' } } }],
            ['State Tracker', { entries: {} }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => {
                books.set(name, structuredClone(info));
                if (name === knowledgeBook) {
                    restoreSaveCount++;
                    if (restoreSaveCount === 1) {
                        // The first durable save is the restore's flush. A chat
                        // change fires here: bump the epoch and start the reset,
                        // which now waits for the store lock the restore holds.
                        bumpEpoch();
                        resetPromise = resetStoreCache();
                    }
                }
            },
        };
        _setCacheForTests(knowledgeBook, { registry: { Mara: { uid: 4 } }, relationships: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });

        const result = await restoreBackup(backup({
            knowledgeStore: { registry: { Mara: { uid: 4 }, Kira: { uid: 5 } }, relationships: {}, stateRegistry: {} },
        }), { confirm: true });

        await resetPromise;
        expect(result).toMatchObject({ ok: false, committed: false, reason: 'stale-scope' });

        // The rollback durably won: Kira (the cancelled restore) is not on disk,
        // the original Mara entry remains.
        const knowledgeWi = books.get(knowledgeBook);
        const storeEntry = Object.values(knowledgeWi.entries)
            .find(e => typeof e?.comment === 'string' && e.comment.startsWith(STORE_SENTINEL));
        const diskRegistry = storeEntry ? JSON.parse(storeEntry.content).registry : null;
        expect(diskRegistry).toEqual({ Mara: { uid: 4 } });
    });

    test('exact section comparison is order-insensitive', () => {
        expect(backupDataEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
        expect(backupDataEqual({ a: 1 }, { a: 2 })).toBe(false);
        expect(backupDataEqual([1, 2], [1, 2])).toBe(true);
    });
});

describe('unified backup hardening (rev 2)', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.SillyTavern = {
            getContext: () => ({ getCurrentChatId: () => 'chat-a' }),
            extensionSettings: { worldInfo: {} },
        };
        setFakeContextExtras({ getCurrentChatId: () => 'chat-a' });
    });

    afterEach(() => {
        _clearCacheForTests();
        _resetEpoch();
        delete globalThis.SillyTavern;
    });

    function setupBooks(entries = { 4: { uid: 4, comment: 'Mara' }, 5: { uid: 5, comment: 'Kira' } }) {
        const knowledgeBook = 'Knowledge Tracker';
        const books = new Map([
            [knowledgeBook, { entries: structuredClone(entries) }],
            ['State Tracker', { entries: {} }],
        ]);
        knowledgeState.wiScript = {
            loadWorldInfo: async name => structuredClone(books.get(name) || { entries: {} }),
            saveWorldInfo: async (name, info) => { books.set(name, structuredClone(info)); },
        };
        _setCacheForTests(knowledgeBook, { registry: { Mara: { uid: 4 } }, relationships: {}, stances: {}, stanceSources: {} });
        _setCacheForTests('State Tracker', { stateRegistry: {} });
        return { knowledgeBook, books };
    }

    function storeContent(books, knowledgeBook) {
        const wi = books.get(knowledgeBook);
        const entry = Object.values(wi.entries).find(e => typeof e?.comment === 'string' && e.comment.startsWith(STORE_SENTINEL));
        return entry ? JSON.parse(entry.content) : null;
    }

    test('permits an epoch-only merge restore when chat identity is unverifiable', async () => {
        // assertSameScope mints a fresh unknown nonce per call, so a merge restore
        // under an unverifiable identity used to abort as stale-scope before
        // committing. Non-destructive merge only needs the epoch.
        delete globalThis.SillyTavern; // unverifiable identity → isUnknown
        // The stub's getContextSafe still hands getChatIdentity a getCurrentChatId
        // via _contextExtras, so drop it too — both the captured scope and the
        // live identity must agree the chat is unverifiable.
        setFakeContextExtras({ getCurrentChatId: undefined });
        const { knowledgeBook, books } = setupBooks();

        const result = await restoreBackup(backup({
            knowledgeStore: { registry: { Mara: { uid: 4 }, Kira: { uid: 5 } }, relationships: {}, stateRegistry: {} },
        }), { confirm: true });

        expect(result).toMatchObject({ ok: true, committed: true });
        expect(getRegistry().Kira).toEqual({ uid: 5 });
        expect(storeContent(books, knowledgeBook).registry).toMatchObject({ Kira: { uid: 5 } });
    });

    test('an epoch bump still aborts a merge restore under unverifiable identity', async () => {
        delete globalThis.SillyTavern;
        setFakeContextExtras({ getCurrentChatId: undefined });
        const { knowledgeBook } = setupBooks();
        let saves = 0;
        const baseSave = knowledgeState.wiScript.saveWorldInfo;
        knowledgeState.wiScript.saveWorldInfo = async (name, info) => {
            if (name === knowledgeBook) { saves++; if (saves === 1) bumpEpoch(); }
            await baseSave(name, info);
        };

        const result = await restoreBackup(backup({
            knowledgeStore: { registry: { Mara: { uid: 4 }, Kira: { uid: 5 } }, relationships: {}, stateRegistry: {} },
        }), { confirm: true });

        expect(result).toMatchObject({ ok: false, committed: false, reason: 'stale-scope' });
    });

    test('a concurrent background store write is deferred, not joined or erased', async () => {
        // A background writeField() completing mid-restore used to join the
        // restore's flush (persisted as if part of it) or be erased by a rollback.
        // It is now buffered and applied once the restore settles.
        const { knowledgeBook } = setupBooks({ 4: { uid: 4, comment: 'Mara' }, 5: { uid: 5, comment: 'Kira' } });
        let restoreFlushSeen = false;
        let relationshipsAtRestoreFlush = null;
        const baseSave = knowledgeState.wiScript.saveWorldInfo;
        knowledgeState.wiScript.saveWorldInfo = async (name, info) => {
            await baseSave(name, info);
            if (name === knowledgeBook) {
                const entry = Object.values(info.entries).find(e => typeof e?.comment === 'string' && e.comment.startsWith(STORE_SENTINEL));
                const parsed = entry ? JSON.parse(entry.content) : null;
                if (parsed && parsed.relationships !== undefined && !restoreFlushSeen) {
                    restoreFlushSeen = true;
                    relationshipsAtRestoreFlush = parsed.relationships;
                    // A background relationship extraction completes mid-restore.
                    saveRelationships({ Kira: [{ target: 'Mara', type: 'ally', notes: 'bg', source: 'auto' }] });
                }
            }
        };

        const result = await restoreBackup(backup({
            knowledgeStore: { registry: { Mara: { uid: 4 }, Kira: { uid: 5 } }, relationships: {}, stateRegistry: {} },
        }), { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });

        // The restore's flush carried only its planned relationships — the
        // background Kira edge was deferred, not joined into the transaction.
        expect(restoreFlushSeen).toBe(true);
        expect(relationshipsAtRestoreFlush).toEqual({});
        // After the restore settled, the deferred background write was applied to
        // the cache (not erased by the restore): Kira's edge is present.
        expect(getRelationships()).toMatchObject({ Kira: [{ target: 'Mara', type: 'ally' }] });
    });

    test('a debounced store flush acquires the store lock', async () => {
        // The debounce timer used to call flushBook directly, outside the lock
        // It now serializes against restore transactions.
        vi.useFakeTimers();
        try {
            const knowledgeBook = 'Knowledge Tracker';
            let saveCount = 0;
            knowledgeState.wiScript = {
                loadWorldInfo: async () => ({ entries: {} }),
                saveWorldInfo: async () => { saveCount++; },
            };
            _setCacheForTests(knowledgeBook, { registry: { Mara: { uid: 4 } } });

            // Hold the lock behind a gate we control.
            let releaseLock;
            const gate = new Promise(resolve => { releaseLock = resolve; });
            const lockHolder = withStoreLock(async () => { await gate; });

            // A normal write schedules a debounced flush (1200ms timer).
            writeField(knowledgeBook, 'registry', { Bg: { uid: 9 } });
            await vi.advanceTimersByTimeAsync(2000);
            // The debounced flush is blocked behind the held lock.
            expect(saveCount).toBe(0);

            releaseLock();
            await lockHolder;
            await vi.advanceTimersByTimeAsync(0);
            // Released: the queued flush runs.
            expect(saveCount).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    test('the preview token binds to the plan and modes, not only summary counts', () => {
        // Two previews with identical added/conflict/skip counts but different
        // planned data must produce different tokens.
        const base = {
            ok: true,
            summary: { knowledgeStore: { added: 1, updated: 0, conflicts: 0, skipped: [] } },
            identityPolicy: { worldStateDefault: 'merge' },
            modes: {},
            plan: { sections: { knowledgeStore: { registry: { Mara: { uid: 4 } } } } },
        };
        const drift = {
            ...base,
            plan: { sections: { knowledgeStore: { registry: { Mara: { uid: 4 }, Kira: { uid: 5 } } } } },
        };
        expect(drift.summary).toEqual(base.summary); // same counts
        expect(fingerprintPreview(drift)).not.toBe(fingerprintPreview(base));
        expect(fingerprintPreview(base)).toBe(fingerprintPreview(base)); // stable

        // A change to modes or identity policy also changes the token.
        const modesDrift = { ...base, modes: { worldState: 'replace' } };
        expect(fingerprintPreview(modesDrift)).not.toBe(fingerprintPreview(base));
    });

    test('an exact (destructive) restore requires the preview token of an exact preview', async () => {
        setupBooks({ 4: { uid: 4, comment: 'Mara' } });
        const file = backup({
            identity: { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null, key: 'chat:chat-a' },
            knowledgeStore: { registry: { Mara: { uid: 4 } }, relationships: {}, stateRegistry: {} },
        });

        // No token: the exact commit is refused even with confirm.
        const refused = await restoreBackup(file, { confirm: true, exact: true });
        expect(refused).toMatchObject({ ok: false, committed: false, reason: 'preview-required' });

        // A merge-preview token must not authorize an exact commit (the token binds
        // to the exact kind).
        const mergePreview = await previewRestore(file);
        expect(mergePreview.ok).toBe(true);
        // The exact preview (and its token) come through the exact path the commit
        // re-plans; previewRestore(exact) only flags exactness, it does not build
        // the exact summary/token.
        const exactPreviewResult = await restoreBackup(file, { exact: true });
        expect(exactPreviewResult.preview.ok).toBe(true);
        const exactToken = exactPreviewResult.preview.previewToken;
        expect(exactToken).not.toBe(mergePreview.previewToken);

        const wrongKind = await restoreBackup(file, { confirm: true, exact: true, previewToken: mergePreview.previewToken });
        expect(wrongKind).toMatchObject({ ok: false, committed: false, reason: 'reconfirmation-required' });

        // The exact-preview token authorizes the destructive commit.
        const committed = await restoreBackup(file, { confirm: true, exact: true, previewToken: exactToken });
        expect(committed).toMatchObject({ ok: true, committed: true });
    });

    test('the knowledge store version is not duplicated inside the section data', () => {
        // storeVersion is the sole version field.
        const env = buildBackupEnvelope({
            metadata: {},
            knowledgeStore: { version: 1, registry: { Mara: { uid: 4 } } },
        });
        expect(env.sections.knowledgeStore.storeVersion).toBe(1);
        expect(env.sections.knowledgeStore.data).toEqual({ registry: { Mara: { uid: 4 } } });
        expect(env.sections.knowledgeStore.data.version).toBeUndefined();
    });

    test('an unchanged exact Knowledge restore reports "unchanged", not "replaced"', async () => {
        // The inner version used to make current-state comparison retain a version
        // the plan lacked, so an unchanged store reported "replaced"
        setupBooks({ 4: { uid: 4, comment: 'Mara' } });

        // Export the current store, then exact-preview it (the exact summary is
        // built on the exact path, so go through restoreBackup without confirm).
        const env = await collectBackup({ download: false });
        const result = await restoreBackup(env, { exact: true });
        expect(result.preview.summary.knowledgeStore).toMatchObject({ mode: 'exact', action: 'unchanged' });
    });

    test('the barrel stub rejects a missing saveMetadata in strict mode', async () => {
        // Production strict persistence rejects a missing saveMetadata; the stub
        // must match so a restore test cannot report committed:true on metadata a
        // reload would lose.
        setFakeContextExtras({ saveMetadata: undefined });
        const { persistChatMetaNow } = await import('../core/index.js');
        await expect(persistChatMetaNow({ strict: true })).rejects.toThrow(/immediate saveMetadata API/);
        // Non-strict keeps the resilient debounced fallback.
        await expect(persistChatMetaNow({ strict: false })).resolves.toBeUndefined();
    });

    test('restoreBackup rolls back when the immediate saveMetadata API is absent', async () => {
        // Integration proof: with strict persistence rejecting a missing
        // saveMetadata, a restore whose metadata cannot be durably saved rolls
        // back its already-durable lorebook flush.
        setFakeContextExtras({ saveMetadata: undefined });
        const { knowledgeBook, books } = setupBooks();

        const result = await restoreBackup(backup({
            knowledgeStore: { registry: { Mara: { uid: 4 }, Kira: { uid: 5 } }, relationships: {}, stateRegistry: {} },
            metadata: { worldState: { text: 'restored state' } },
        }), { confirm: true });

        expect(result).toMatchObject({ ok: false, committed: false, reason: 'metadata-persist-failed', partialCommit: true });
        // The lorebook flush was rolled back: Kira never reached disk.
        expect(storeContent(books, knowledgeBook).registry).toEqual({ Mara: { uid: 4 } });
        // And the in-memory metadata was not left with the restored value.
        expect(getFakeMeta().world_state_tracker_metadata?.text).not.toBe('restored state');
    });
});

