import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getFakeMeta, resetCoreStubs, setFakeChat } from './stubs/core.js';
import { buildMessageWindow, makeAnchor, resolveAnchor, restoreReceiptBookkeeping, state as chronicleState } from '../chronicle/data.js';
import { validateChronicleData } from '../chronicle/schema.js';
import { validateWorldStateData } from '../world_state/schema.js';
import { validateStoryPlannerData } from '../story_planner/schema.js';
import { validateKnowledgeCountersData } from '../knowledge/schema.js';
import { reconcileImportedUid } from '../knowledge/reconcile.js';
import { restoreReceiptMap, isPositiveReceiptCount } from '../core/schema.js';
import { _clearCacheForTests, hydrateBook, readField, resetStoreCache } from '../knowledge/store.js';
import { state as knowledgeState } from '../knowledge/state.js';
import { saveRegistry, getRegistry } from '../knowledge/registry.js';

beforeEach(() => resetCoreStubs());

describe('Tier 1 metadata and Chronicle coverage', () => {
    test('oversized history advances oldest-first without claiming later messages', () => {
        const chat = Array.from({ length: 10 }, (_, i) => ({ name: 'Mara', mes: `${i}: ${'x'.repeat(21000)}` }));
        setFakeChat(chat);
        const first = buildMessageWindow(0, 9);
        expect(first.fromIndex).toBe(0);
        expect(first.toIndex).toBe(3);
        expect(first.lastMsg).toBe(chat[3]);
        expect(first.text).toContain('0:');
        expect(first.text).not.toContain('4:');
        const second = buildMessageWindow(first.toIndex + 1, 9);
        expect(second.fromIndex).toBe(4);
        expect(second.toIndex).toBe(7);
        expect(buildMessageWindow(second.toIndex + 1, 9).toIndex).toBe(9);
    });

    test('single oversized message advances the anchor instead of stalling', () => {
        setFakeChat([{ name: 'Mara', mes: 'x'.repeat(120000) }, { name: 'Mara', mes: 'next' }]);
        const first = buildMessageWindow(0, 1);
        expect(first.toIndex).toBe(0);
        expect(first.text.length).toBeLessThanOrEqual(100000);
        expect(buildMessageWindow(1, 1).text).toContain('next');
    });

    test('edited anchor reports a miss, while last snapshot range remains available for resumption', () => {
        const chat = [{ name: 'Mara', mes: 'first' }, { name: 'Mara', mes: 'boundary' }, { name: 'Mara', mes: 'next' }];
        setFakeChat(chat);
        const anchor = makeAnchor(chat[1]);
        getFakeMeta().session_chronicle_data = { snapshots: [{ id: 's1', text: 'summary', toIndex: 1 }], lastAnchor: anchor };
        chat[1].mes = 'edited boundary';
        expect(resolveAnchor(anchor).found).toBe(false);
        expect(buildMessageWindow(getFakeMeta().session_chronicle_data.snapshots.at(-1).toIndex + 1, 2).text).toContain('next');
    });

    test('malformed snapshot character lists are repaired in both record containers', () => {
        const result = validateChronicleData({ snapshots: [{ id: 's', text: 'entry', characters: 'Mara' }], _deletedBin: [{ id: 't', text: 'trash', characters: null }] });
        expect(result.data.snapshots[0].characters).toEqual([]);
        expect(result.data._deletedBin[0].characters).toEqual([]);
        expect(result.issues.filter(issue => issue.code === 'snapshot-characters-repaired')).toHaveLength(2);
    });

    test('four schemas and the runtime reject malformed receipt tuples', () => {
        for (const validate of [validateChronicleData, validateWorldStateData, validateStoryPlannerData, validateKnowledgeCountersData]) {
            const result = validate({ countedReceiptEvents: [null, ['good', validate === validateKnowledgeCountersData ? { npc: 1 } : 2]] });
            expect(result.data.countedReceiptEvents).toHaveLength(1);
            expect(result.issues.some(issue => issue.code === 'receipt-invalid')).toBe(true);
        }
        expect([...restoreReceiptMap([null, ['ok', 1], ['bad', 0]], isPositiveReceiptCount)]).toEqual([['ok', 1]]);
        restoreReceiptBookkeeping({ countedReceiptEvents: [null, ['ok', 1]] });
        expect([...chronicleState.countedReceiptEvents]).toEqual([['ok', 1]]);
    });

    test('imported UID requires verified name and content', async () => {
        const read = async (uid, name) => name === 'Mara' ? 'Mara dossier' : 'wrong NPC';
        expect(await reconcileImportedUid(4, null, read, 'Mara')).toBeNull();
        expect(await reconcileImportedUid(4, 'wrong NPC', read, 'Mara')).toBeNull();
        expect(await reconcileImportedUid(4, 'Mara dossier', read, 'Mara')).toBe(4);
    });

    test('failed outgoing lorebook flush retains dirty data and retries without rehydrating over it', async () => {
        _clearCacheForTests();
        const books = new Map();
        let fail = false;
        knowledgeState.wiScript = {
            loadWorldInfo: async name => books.has(name) ? structuredClone(books.get(name)) : { entries: {} },
            saveWorldInfo: async (name, book) => {
                if (fail) throw new Error('disk unavailable');
                books.set(name, structuredClone(book));
            },
        };
        try {
            await hydrateBook('Knowledge Tracker');
            saveRegistry({ Mara: { uid: 3, keywords: ['Mara'] } });
            fail = true;
            expect(await resetStoreCache()).toBe(false);
            expect(readField('Knowledge Tracker', 'registry')).toHaveProperty('Mara');
            await hydrateBook('Knowledge Tracker', {}, true);
            expect(getRegistry()).toHaveProperty('Mara');
            fail = false;
            expect(await resetStoreCache()).toBe(true);
            expect(books.get('Knowledge Tracker')).toBeTruthy();
        } finally {
            _clearCacheForTests();
            knowledgeState.wiScript = null;
            vi.restoreAllMocks();
        }
    });
});