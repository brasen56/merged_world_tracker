import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildGrowthApproval, growthEchoStatus } from '../knowledge/growth_lineage.js';
import { appendGrowthApprovalToBook, readGrowthHistoryContainer, readGrowthHistoryContainerFromBook,
    writeGrowthHistoryContainer, mergeGrowthHistoryIdentities, isGrowthHistoryEntry } from '../knowledge/growth_history.js';
import { resetCoreStubs } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { saveSettings } from '../knowledge/settings.js';
import { state } from '../knowledge/state.js';
import { renameEntity, mergeEntities } from '../knowledge/identity.js';
import { getRegistry } from '../knowledge/registry.js';
import '../knowledge/lorebook.js';

const BOOK = 'Knowledge Tracker';
const lines = { personality: 'Waits patiently.', voice: 'Speaks plainly.' };
const keeps = Object.entries(lines).map(([field, after]) => ({ field, action: 'keep', before: after, after, evidenceIds: [] }));
let disk;
beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveSettings({ scope: 'global' });
    _setCacheForTests(BOOK, { registry: { Mara: { uid: 0, entityId: 'mara', type: 'major', aliases: [] },
        Mary: { uid: 1, entityId: 'mary', type: 'major', aliases: [] } } });
    disk = { entries: {} };
    state.wiScript = { loadWorldInfo: async () => structuredClone(disk),
        saveWorldInfo: async (_name, wi) => { disk = structuredClone(wi); } };
    installCleanupFetch(state.wiScript);
});
afterEach(() => { _clearCacheForTests(); state.wiScript = null; vi.unstubAllGlobals(); });

test('approval stamps lineage across keep → edit, reviewer rewrites and no-evidence text', () => {
    const first = buildGrowthApproval({ approved: lines, current: lines, changes: keeps, acceptedAt: 1000 });
    const second = buildGrowthApproval({ approved: lines, current: lines, changes: keeps, previous: first, acceptedAt: 2000 });
    expect(second.changes.map(c => c.firstApprovedAt)).toEqual([1000, 1000]);
    expect(first.original).toEqual(lines);
    expect(second.original).toBeUndefined();
    const edited = { ...lines, personality: 'Asks for help.' };
    const third = buildGrowthApproval({ approved: edited, current: lines, changes: [
        { ...keeps[0], action: 'edit', after: edited.personality, evidenceIds: ['obs'] }, keeps[1],
    ], previous: second, acceptedAt: 3000 });
    expect(third.changes[0]).toMatchObject({ firstApprovedAt: 3000, evidenceIds: ['obs'] });
    const hand = buildGrowthApproval({ approved: { ...edited, voice: 'Whispers softly.' }, current: edited,
        changes: keeps, previous: third, acceptedAt: 4000 });
    expect(hand.changes[1]).toMatchObject({ firstApprovedAt: 4000, evidenceIds: [], sourceLabel: 'hand edit, no evidence' });
});

const change = { ...keeps[0], evidenceIds: ['a', 'b'] };
const lineage = [{ ...keeps[0], firstApprovedAt: 1000 }];
test.each([
    [[{ id: 'a', ts: 1001 }], 'possible echo'],
    [[{ id: 'a', ts: 1000 }], ''],
    [[{ id: 'a', ts: 999, capturedAt: 9000 }], ''],
    [[{ id: 'a', ts: 1001 }, { id: 'b', ts: 900 }], ''],
    [[{ id: 'a', ts: 1001 }, { id: 'b', ts: null }], 'possible echo'],
    [[{ id: 'a', ts: 1001 }, { id: 'b', canon: true }], ''],
    [[{ id: 'a', tier: 'consolidated', firstSeen: 900, ts: 9000 }], ''],
    [[{ id: 'a', tier: 'consolidated', firstSeen: 1001 }], 'possible echo'],
    [[{ id: 'a', ts: null, capturedAt: 9000 }], 'timing unknown'],
    [[{ id: 'a', ts: 'invalid' }], 'timing unknown'],
    [[], ''],
])('message-time echo boundary %#', (evidence, expected) => {
    const status = growthEchoStatus(change, evidence, lineage);
    if (expected) expect(status).toContain(expected);
    else expect(status).toBe('');
});
test('no-evidence, removed and unapproved sentences never echo', () => {
    expect(growthEchoStatus({ ...change, evidenceIds: [] }, [{ id: 'a', ts: 2000 }], lineage)).toBe('');
    expect(growthEchoStatus({ ...change, after: '' }, [{ id: 'a', ts: 2000 }], lineage)).toBe('');
    expect(growthEchoStatus(change, [{ id: 'a', ts: 2000 }], [])).toBe('');
});

test('durable reload, cap and flags; no localStorage writes', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    for (let i = 1; i <= 12; i++) appendGrowthApprovalToBook(disk, 'mara', { approved: lines, current: lines, changes: keeps, acceptedAt: i * 1000 });
    await writeGrowthHistoryContainer(BOOK, readGrowthHistoryContainerFromBook(disk).records);
    _clearCacheForTests();
    const read = await readGrowthHistoryContainer(BOOK);
    expect(read.records.mara).toHaveLength(10);
    expect(read.records.mara[0].acceptedAt).toBe(3000);
    expect(read.records.mara.every(r => !r.original)).toBe(true);
    expect(Object.values(disk.entries).find(isGrowthHistoryEntry)).toMatchObject({ key: [], disable: true,
        enabled: false, constant: false, vectorized: false, excludeRecursion: true, preventRecursion: true });
    expect(setItem).not.toHaveBeenCalled();
});

test('rename retains id history and merge sorts both histories then caps', async () => {
    for (let i = 1; i <= 8; i++) {
        appendGrowthApprovalToBook(disk, 'mara', { approved: lines, current: lines, changes: keeps, acceptedAt: i * 2000 });
        appendGrowthApprovalToBook(disk, 'mary', { approved: lines, current: lines, changes: keeps, acceptedAt: i * 2000 + 1000 });
    }
    expect((await renameEntity('Mara', 'Captain Mara', { relabelEntries: false, syncBlocks: false })).ok).toBe(true);
    expect(getRegistry()['Captain Mara'].entityId).toBe('mara');
    expect((await readGrowthHistoryContainer()).records.mara).toHaveLength(8);
    const result = await mergeEntities('Captain Mara', 'Mary', { relabelEntries: false, syncBlocks: false });
    expect(result.ok).toBe(true);
    const read = await readGrowthHistoryContainer();
    expect(read.records.mara.map(r => r.acceptedAt)).toEqual([8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000]);
    expect(read.records.mary).toEqual([]);
});

test('newer history version refuses approval and identity merge untouched', async () => {
    disk.entries[2] = { comment: '[MWT:growth-history]', content: '{"version":99,"records":{}}' };
    const original = structuredClone(disk);
    expect(() => appendGrowthApprovalToBook(disk, 'mara', { approved: lines, current: lines })).toThrow('unsupported-version');
    await expect(mergeGrowthHistoryIdentities('mara', 'mary', BOOK, () => {})).rejects.toThrow('unsupported-version');
    expect(disk).toEqual(original);
});