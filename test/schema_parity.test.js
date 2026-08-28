/**
 * Validator-parity tests — Part 1 acceptance of
 * upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md.
 *
 * backup/validate.js became a compatibility adapter over schema/registry.js.
 * These tests pin the adapter's observable behavior to the exact output the
 * pre-adapter validators produced: accepted data, added/conflicts counts, and
 * every { record, reason } skipped entry — record DISPLAY identity (id string,
 * map key, or field label; the raw rejected value only when no identity
 * exists) AND reason string — so the port onto structured issues changed no
 * user-visible summary. The complete raw record rides on the issue itself for
 * quarantine recovery; summaries never render rejected prose.
 */
import { describe, test, expect } from 'vitest';
import {
    validateBackupEnvelope,
    validateChronicle,
    validateInteriority,
    validateKnowledgeCounters,
    validateKnowledgeEvidence,
    validateKnowledgeStore,
    validateSection,
    validateStoryPlanner,
    validateWorldState,
} from '../backup/validate.js';
import { STORE_SCHEMAS } from '../schema/registry.js';

describe('validator parity — worldState', () => {
    test('keeps valid data, quarantines malformed history, preserves unknown keys', () => {
        const result = validateWorldState({
            text: 'state',
            autoSaveHistory: [{ text: 'a', timestamp: 1 }, { text: '' }, 'junk'],
            provenance: { schemaVersion: 1 },
            extra: 'kept',
        });
        expect(result).toEqual({
            data: {
                text: 'state',
                autoSaveHistory: [{ text: 'a', timestamp: 1 }],
                provenance: { schemaVersion: 1 },
                extra: 'kept',
            },
            added: 1,
            updated: 0,
            skipped: [
                { record: { text: '' }, reason: 'History text must be a non-empty string.' },
                { record: 'junk', reason: 'History item must be an object.' },
            ],
            conflicts: 0,
        });
    });

    test('root and field failures keep the legacy messages, labels, and order', () => {
        // Skipped records stay on the pre-adapter display identities — the
        // store/field labels the old validators put there. The raw rejected
        // value travels on the issue for quarantine recovery, not here.
        expect(validateWorldState(null)).toEqual({
            data: {},
            added: 0,
            updated: 0,
            conflicts: 0,
            skipped: [{ record: 'worldState', reason: 'World State data must be an object.' }],
        });
        expect(validateWorldState({ text: 5 })).toEqual({
            data: {},
            added: 0,
            updated: 0,
            conflicts: 0,
            skipped: [{ record: 'text', reason: 'World State text must be a string.' }],
        });
        expect(validateWorldState({ provenance: 3, autoSaveHistory: 'x' })).toEqual({
            // A non-array history container was replaced with [] by the old
            // validateList too — the key stays present but emptied.
            data: { autoSaveHistory: [] },
            added: 0,
            updated: 0,
            conflicts: 0,
            skipped: [
                { record: 'autoSaveHistory', reason: 'autoSaveHistory must be an array.' },
                { record: 'provenance', reason: 'World State provenance must be an object.' },
            ],
        });
    });
});

describe('validator parity — chronicle', () => {
    test('duplicate ids conflict, malformed snapshots skip, wrong containers empty out', () => {
        const result = validateChronicle({
            snapshots: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }, { id: '', text: 'z' }],
            _deletedBin: 'oops',
            lastAnchor: null,
        });
        expect(result.data).toEqual({ snapshots: [{ id: 'a', text: 'x' }], _deletedBin: [], lastAnchor: null });
        expect(result.added).toBe(1);
        expect(result.conflicts).toBe(1);
        expect(result.skipped).toEqual([
            { record: 'a', reason: 'Duplicate id in snapshots.' },
            { record: '', reason: 'Snapshot id must be a non-empty string.' },
            { record: '_deletedBin', reason: '_deletedBin must be an array.' },
        ]);
    });

    test('root failure keeps the legacy message', () => {
        expect(validateChronicle('x').skipped).toEqual([
            { record: 'chronicle', reason: 'Chronicle data must be an object.' },
        ]);
    });
});

describe('validator parity — knowledge evidence', () => {
    test('backfills npc from the map key and quarantines malformed tiers', () => {
        const result = validateKnowledgeEvidence({
            Mara: {
                npc: '',
                raw: [{ id: 'r', claim: 'c', quote: 'q' }, { id: '', claim: 'c', quote: 'q' }],
                consolidated: [{ id: 'x', claim: 'c', sources: ['r', ''] }, { id: 'y', claim: 'c' }],
                meta: 3,
            },
            '': { npc: 'x' },
        });
        expect(result.data).toEqual({
            Mara: {
                npc: 'Mara',
                raw: [{ id: 'r', claim: 'c', quote: 'q' }],
                consolidated: [{ id: 'y', claim: 'c' }],
            },
        });
        expect(result.added).toBe(2);
        expect(result.skipped).toEqual([
            { record: '', reason: 'Raw observation id must be a non-empty string.' },
            { record: 'x', reason: 'Consolidated sources must be string ids.' },
            { record: 'Mara.meta', reason: 'Evidence meta must be an object.' },
            { record: '', reason: 'Evidence file must have a non-empty NPC name and object value.' },
        ]);
    });

    test('root failure keeps the legacy message', () => {
        expect(validateKnowledgeEvidence(7).skipped).toEqual([
            { record: 'knowledgeEvidence', reason: 'Knowledge evidence must be an NPC map.' },
        ]);
    });
});

describe('validator parity — knowledge counters', () => {
    test('validates the four counters and passes other keys through', () => {
        const result = validateKnowledgeCounters({
            messageCounter: 3,
            npcMessageCounter: -1,
            countedReceiptEvents: [['k', {}]],
        });
        expect(result).toEqual({
            data: { messageCounter: 3, countedReceiptEvents: [['k', {}]] },
            added: 1,
            updated: 0,
            conflicts: 0,
            skipped: [{ record: 'npcMessageCounter', reason: 'Counter must be a finite non-negative number.' }],
        });
    });
});

describe('validator parity — story planner', () => {
    const arc = (id, extra = {}) => ({
        id,
        title: 't',
        body: 'b',
        section: 'emerging',
        status: 'active',
        pinned: false,
        beats: ['x'],
        beatIndex: 0,
        turnsSinceAdvance: 0,
        createdAt: 1,
        updatedAt: 1,
        ...extra,
    });

    test('canonicalizes accepted arcs through sanitizeArcs and skips non-objects', () => {
        const result = validateStoryPlanner({
            arcs: [arc('a'), arc('a', { beatIndex: 9 }), 'junk'],
            history: 'nope',
            settingsOverride: { keep: 1 },
        });
        expect(result.added).toBe(2);
        expect(result.conflicts).toBe(0);
        expect(result.data.arcs).toHaveLength(2);
        expect(result.data.arcs[0].id).toBe('a');
        // The duplicate arc keeps both records but gets a fresh id, and the
        // out-of-range beatIndex is clamped to beats.length — the same silent
        // canonicalization sanitizeArcs always performed.
        expect(result.data.arcs[1].id).not.toBe('a');
        expect(result.data.arcs[1].beatIndex).toBe(1);
        expect(result.data.settingsOverride).toEqual({ keep: 1 });
        expect(result.skipped).toEqual([
            { record: 'junk', reason: 'Arc must be an object.' },
            { record: 'history', reason: 'Story Planner history must be an array.' },
        ]);
    });

    test('root failure keeps the legacy message', () => {
        expect(validateStoryPlanner([]).skipped).toEqual([
            { record: 'storyPlanner', reason: 'Story Planner data must be an object.' },
        ]);
    });
});

describe('validator parity — interiority', () => {
    test('ledger, tombstones, perMessage keys, and turnCounter match legacy behavior', () => {
        const ledger = id => ({ id, npc: 'Mara', action: 'wait', trigger: 'dawn' });
        const result = validateInteriority({
            ledger: [ledger('i1'), ledger('i1'), { id: 'i2' }],
            deletedIntentions: [
                { id: 't1', npc: 'Mara', actions: [], triggers: ['tr'] },
                { id: 't2', npc: '', actions: [], triggers: [] },
            ],
            perMessage: { 'mu-1': { generatedAt: 1 }, 'bad-key': {}, 'mu-': {} },
            turnCounter: -1,
            enabled: true,
        });
        expect(result.data.ledger).toEqual([ledger('i1')]);
        expect(result.data.deletedIntentions).toEqual([{ id: 't1', npc: 'Mara', actions: [], triggers: ['tr'] }]);
        expect(result.data.perMessage).toEqual({ 'mu-1': { generatedAt: 1 } });
        expect(result.data.enabled).toBe(true);
        expect(result.data).not.toHaveProperty('turnCounter');
        expect(result.added).toBe(3);
        expect(result.conflicts).toBe(1);
        expect(result.skipped).toEqual([
            { record: 'i1', reason: 'Duplicate id in ledger.' },
            { record: 'i2', reason: 'Ledger npc must be a non-empty string.' },
            { record: 't2', reason: 'Tombstone id and npc are required.' },
            { record: 'bad-key', reason: 'perMessage keys must be mu-* and values must be objects.' },
            { record: 'mu-', reason: 'perMessage keys must be mu-* and values must be objects.' },
            { record: 'turnCounter', reason: 'Interiority turnCounter must be a finite non-negative number.' },
        ]);
    });
});

describe('validator parity — knowledge lorebook store', () => {
    test('registry, relationships, and stances match legacy behavior including dropped unknown keys', () => {
        // Part 4 (design §6.7): stance-source values now come from the
        // provenance enum ('auto'/'manual'), so a filler string like 'seen'
        // is quarantined instead of passing through — covered separately in
        // test/knowledge_store_hydration.test.js.
        const result = validateKnowledgeStore({
            registry: { Good: { uid: 7 }, Bad: { type: 'minor' } },
            relationships: {
                Good: [{ target: 'Kira', type: 'ally' }],
                Vague: [{ target: 'Kira' }],
                NotArray: 'x',
            },
            stances: { A: 'warm', B: 3 },
            stanceSources: { A: 'manual' },
            foreign: 'dropped',
        });
        expect(result.data).toEqual({
            registry: { Good: { uid: 7 } },
            relationships: { Good: [{ target: 'Kira', type: 'ally' }], Vague: [] },
            stances: { A: 'warm' },
            stanceSources: { A: 'manual' },
        });
        expect(result.added).toBe(4);
        expect(result.skipped).toEqual([
            { record: 'Bad', reason: 'Registry entry uid must be null or a non-negative integer.' },
            // Relationship skips follow Object.entries order (Good, Vague,
            // NotArray) exactly as the old loop did.
            { record: 'Vague', reason: 'Relationship edge type must be a non-empty string.' },
            { record: 'NotArray', reason: 'Relationship values must be arrays.' },
            { record: 'B', reason: 'Stance value must be a string.' },
        ]);
    });

    test('null uids are intentional orphans and stay accepted', () => {
        const result = validateKnowledgeStore({ registry: { Ghost: { uid: null } } });
        expect(result.data.registry).toEqual({ Ghost: { uid: null } });
        expect(result.added).toBe(1);
        expect(result.skipped).toEqual([]);
    });
});

describe('adapter surface — validateSection and the envelope', () => {
    test('validateSection matches the direct validators and warns on unknown sections', () => {
        expect(validateSection('chronicle', { snapshots: [] })).toEqual(validateChronicle({ snapshots: [] }));
        expect(validateSection('interiority', { ledger: [] })).toEqual(validateInteriority({ ledger: [] }));
        expect(validateSection('weird', { a: 1 })).toEqual({
            data: {},
            added: 0,
            updated: 0,
            skipped: [],
            conflicts: 0,
            warning: 'Unknown backup section "weird" was ignored.',
        });
    });

    test('envelope version ceilings come from the registry descriptors', () => {
        const envelope = {
            _meta: { type: 'mwt-chat-backup', formatVersion: 1 },
            sections: { worldState: { schemaVersion: 2, data: {} } },
        };
        const result = validateBackupEnvelope(envelope);
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toBe('Section "worldState" version 2 is newer than supported version 1.');

        // 0 is the LEGACY marker (design §3.3), not an invalid version: the
        // gate accepts it so the 0 -> 1 migration can run on import.
        envelope.sections.worldState.schemaVersion = 0;
        expect(validateBackupEnvelope(envelope).ok).toBe(true);

        envelope.sections.worldState.schemaVersion = -1;
        expect(validateBackupEnvelope(envelope).errors[0])
            .toBe('Section "worldState" version -1 is below the earliest supported version 0.');
    });

    test('the knowledgeStore wrapper carries storeVersion and validates its data', () => {
        const envelope = {
            _meta: { type: 'mwt-chat-backup', formatVersion: 1 },
            sections: { knowledgeStore: { storeVersion: 1, data: { registry: { Good: { uid: 7 } } } } },
        };
        const result = validateBackupEnvelope(envelope);
        expect(result.ok).toBe(true);
        expect(result.sections.knowledgeStore).toEqual({ registry: { Good: { uid: 7 } } });
        expect(result.summaries.knowledgeStore.added).toBe(1);

        envelope.sections.knowledgeStore.storeVersion = 99;
        const refused = validateBackupEnvelope(envelope);
        expect(refused.ok).toBe(false);
        expect(refused.errors[0]).toBe('Section "knowledgeStore" version 99 is newer than supported version 1.');
    });

    test('a full envelope round-trips every section through the registry', () => {
        const envelope = {
            _meta: { type: 'mwt-chat-backup', formatVersion: 1 },
            sections: {
                worldState: { schemaVersion: 1, data: { text: 'state' } },
                chronicle: { schemaVersion: 1, data: { snapshots: [{ id: 's', text: 't' }] } },
                knowledgeEvidence: { schemaVersion: 1, data: { Mara: { npc: 'Mara' } } },
                knowledgeCounters: { schemaVersion: 1, data: { messageCounter: 1 } },
                storyPlanner: { schemaVersion: 1, data: { arcs: [] } },
                interiority: { schemaVersion: 1, data: { ledger: [] } },
            },
        };
        const result = validateBackupEnvelope(envelope);
        expect(result.ok).toBe(true);
        expect(result.warnings).toEqual([]);
        expect(Object.keys(result.sections).sort()).toEqual(Object.keys(STORE_SCHEMAS).filter(id => id !== 'knowledgeStore').sort());
    });
});
