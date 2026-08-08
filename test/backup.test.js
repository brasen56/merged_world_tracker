import { describe, test, expect } from 'vitest';

import {
    BACKUP_TYPE,
    MAX_TRASH_SIZE,
    buildBackupEnvelope,
} from '../backup/data.js';
import { validateBackupEnvelope } from '../backup/validate.js';
import {
    planRestore,
    reconcileNameMap,
} from '../backup/restore.js';
import { collectBackup, getBackupChatName } from '../backup/collect.js';
import { exportBackup, getBackupFilename } from '../backup/index.js';
import { beforeEach, afterEach } from 'vitest';
import {
    resetCoreStubs,
    setFakeChat,
    setFakeContextExtras,
    getFakeMeta,
} from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';

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
        expect(result.sections.knowledgeStore.data).toEqual({
            version: 1,
            registry: { Mara: { uid: 7 } },
            relationships: { Mara: [{ target: 'Kira', type: 'ally' }] },
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
        expect(getBackupChatName({ chatName: '  Named chat  ' }, { chatId: 'id' })).toBe('Named chat');
        expect(getBackupFilename(result, 123)).toBe('mwt_backup_A_Quiet_Evening_123.json');
    });
});
