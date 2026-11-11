import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildGrowthApproval, growthEchoStatus } from '../knowledge/growth_lineage.js';
import { appendGrowthApprovalToBook, readGrowthHistoryContainer, readGrowthHistoryContainerFromBook,
    writeGrowthHistoryContainer, mergeGrowthHistoryIdentities, isGrowthHistoryEntry, getActiveGrowthApproval } from '../knowledge/growth_history.js';
import { resetCoreStubs } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { saveSettings } from '../knowledge/settings.js';
import { state } from '../knowledge/state.js';
import { renameEntity, mergeEntities } from '../knowledge/identity.js';
import { getRegistry, getGrowthDossierSettings } from '../knowledge/registry.js';
import { growthOwnsField } from '../knowledge/field_ownership.js';
import { validateKnowledgeStoreData } from '../knowledge/schema.js';
import '../knowledge/lorebook.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';

const BOOK = 'Knowledge Tracker';
const lines = { personality: 'Waits patiently.', voice: 'Speaks plainly.' };
const keeps = Object.entries(lines).map(([field, after]) => ({ field, action: 'keep', before: after, after, evidenceIds: [] }));
let disk;
beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
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
test('edits and additions never echo, even when all their support postdates the old line', () => {
    const later = [{ id: 'a', ts: 2000 }];
    expect(growthEchoStatus({ ...keeps[0], action: 'edit', after: 'Asks for help.', evidenceIds: ['a'] }, later, lineage)).toBe('');
    expect(growthEchoStatus({ ...keeps[0], action: 'add', before: '', evidenceIds: ['a'] }, later, lineage)).toBe('');
    expect(growthEchoStatus({ ...keeps[0], action: 'edit', after: 'Asks for help.', evidenceIds: ['a'] }, [{ id: 'a', ts: null }], lineage)).toBe('');
    expect(growthEchoStatus({ ...keeps[0], evidenceIds: ['a'] }, later, lineage)).toContain('possible echo');
});
test('a kept evidence-backed sentence keeps its support instead of becoming "no evidence"', () => {
    const sentence = 'Owns mistakes now.';
    const line = { personality: sentence, voice: '' };
    const kept = { field: 'personality', action: 'keep', before: sentence, after: sentence, evidenceIds: [] };
    const first = buildGrowthApproval({ approved: line, current: { personality: '', voice: '' }, acceptedAt: 1000,
        changes: [{ field: 'personality', action: 'add', before: '', after: sentence, evidenceIds: ['e1'] }] });
    const second = buildGrowthApproval({ approved: line, current: line, changes: [kept], previous: first, acceptedAt: 2000 });
    expect(second.changes).toEqual([{ ...kept, evidenceIds: ['e1'], firstApprovedAt: 1000 }]);
    const third = buildGrowthApproval({ approved: line, current: line, changes: [kept], previous: second, acceptedAt: 3000 });
    expect(third.changes).toEqual([{ ...kept, evidenceIds: ['e1'], firstApprovedAt: 1000 }]);
    const recited = buildGrowthApproval({ approved: line, current: line, changes: [{ ...kept, evidenceIds: ['e2'] }], previous: third, acceptedAt: 4000 });
    expect(recited.changes).toEqual([{ ...kept, evidenceIds: ['e2'], firstApprovedAt: 1000 }]);
    // Unverified original text still keeps its label through repeated keeps.
    const original = buildGrowthApproval({ approved: lines, current: lines, changes: keeps, acceptedAt: 1000 });
    const again = buildGrowthApproval({ approved: lines, current: lines, changes: keeps, previous: original, acceptedAt: 2000 });
    expect(again.changes.map(c => [c.sourceLabel, c.evidenceIds])).toEqual([
        ['from the original line, no evidence', []], ['from the original line, no evidence', []],
    ]);
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

test.each([false, true])('identity merge preserves the retained or adopted dossier baseline (adopt=%s)', async adopt => {
    const other = { personality: 'Acts impulsively.', voice: 'Shouts orders.' };
    const otherKeeps = Object.entries(other).map(([field, after]) => ({ field, action: 'keep', before: after, after, evidenceIds: ['other'] }));
    appendGrowthApprovalToBook(disk, 'mara', { approved: lines, current: lines, changes: keeps, acceptedAt: 1000 });
    appendGrowthApprovalToBook(disk, 'mary', { approved: other, current: other, changes: otherKeeps, acceptedAt: 2000 });
    if (adopt) getRegistry().Mara.uid = null;
    expect((await mergeEntities('Mara', 'Mary', { relabelEntries: false, syncBlocks: false })).ok).toBe(true);
    const history = (await readGrowthHistoryContainer()).records.mara;
    expect(history.map(r => r.acceptedAt)).toEqual([1000, 2000]);
    const baseline = getActiveGrowthApproval(history);
    expect(baseline.approved).toEqual(adopt ? other : lines);
    const selectedKeeps = adopt ? otherKeeps : keeps;
    expect(growthEchoStatus({ ...selectedKeeps[0], evidenceIds: ['later'] }, [{ id: 'later', ts: 2500 }], baseline.changes)).toContain('possible echo');
    const record = appendGrowthApprovalToBook(disk, 'mara', { approved: baseline.approved,
        current: baseline.approved, changes: selectedKeeps, acceptedAt: 3000 });
    expect(record.changes.map(c => c.firstApprovedAt)).toEqual(adopt ? [2000, 2000] : [1000, 1000]);
    expect(getActiveGrowthApproval(readGrowthHistoryContainerFromBook(disk).records.mara)).toEqual(record);
});

test('merge cap and reload retain an older active baseline and namespace the adopted lineage', async () => {
    appendGrowthApprovalToBook(disk, 'mara', { approved: lines, current: lines, changes: keeps, acceptedAt: 1000 });
    for (let i = 2; i <= 11; i++) {
        appendGrowthApprovalToBook(disk, 'mary', { approved: lines, current: lines,
            changes: keeps.map(c => ({ ...c, evidenceIds: ['obs'] })), acceptedAt: i * 1000 });
    }
    await mergeGrowthHistoryIdentities('mara', 'mary', BOOK, () => {}, 'mary');
    const history = (await readGrowthHistoryContainer()).records.mara;
    expect(history).toHaveLength(10);
    expect(history.map(r => r.acceptedAt)).toEqual([1000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000]);
    expect(getActiveGrowthApproval(history).acceptedAt).toBe(1000);
    expect(history.at(-1).changes[0].evidenceIds).toEqual(['mary::obs']);
    await writeGrowthHistoryContainer(BOOK, { mara: history });
    expect(getActiveGrowthApproval((await readGrowthHistoryContainer()).records.mara).acceptedAt).toBe(1000);
});

test.each([false, true])('merge does not borrow an inactive dossier approval when selected history is absent (adopt=%s)', async adopt => {
    appendGrowthApprovalToBook(disk, adopt ? 'mara' : 'mary', { approved: lines, current: lines, changes: keeps, acceptedAt: 1000 });
    await mergeGrowthHistoryIdentities('mara', 'mary', BOOK, () => {}, null, adopt);
    expect(getActiveGrowthApproval((await readGrowthHistoryContainer()).records.mara)).toBeNull();
});

test.each([0, 1, 2])('removals reconcile restored duplicate occurrences (%s restored)', restored => {
    const removal = { field: 'personality', action: 'remove', before: lines.personality, after: '', reason: 'evidence', evidenceIds: ['obs'] };
    const approved = { ...lines, personality: Array(1 + restored).fill(lines.personality).join(' ') };
    const changes = [keeps[0], removal, { ...removal }, keeps[1]];
    const record = buildGrowthApproval({ approved, current: { ...lines, personality: Array(3).fill(lines.personality).join(' ') }, changes });
    expect(record.changes.filter(c => c.action === 'remove')).toHaveLength(2 - restored);
    expect(record.changes.filter(c => c.after === lines.personality)).toHaveLength(1 + restored);
    expect(changes.filter(c => c.action === 'remove')).toHaveLength(2);
});

test.each(['cancel', 'save-error'])('failed identity merge restores uncapped histories (%s)', async kind => {
    for (let i = 1; i <= 10; i++) {
        for (const id of ['mara', 'mary']) {
            appendGrowthApprovalToBook(disk, id, { approved: lines, current: lines, changes: keeps, acceptedAt: i * 1000 });
        }
    }
    const original = structuredClone(readGrowthHistoryContainerFromBook(disk).records);
    state.wiScript.worldInfoCache = new Map([[BOOK, structuredClone(disk)]]);
    let first = true;
    state.wiScript.saveWorldInfo = async (_name, wi) => {
        disk = structuredClone(wi);
        if (first) {
            first = false;
            if (kind === 'cancel') bumpEpoch();
            else throw new Error('save failed after write');
        }
    };
    const result = await mergeEntities('Mara', 'Mary', { relabelEntries: false, syncBlocks: false });
    expect(result.ok).toBe(false);
    expect(Object.keys(getRegistry())).toEqual(['Mara', 'Mary']);
    expect((await readGrowthHistoryContainer()).records).toEqual(original);
});

test('rollback does not overwrite unrelated host-cache edits after a failed save', async () => {
    appendGrowthApprovalToBook(disk, 'mara', { approved: lines, current: lines, changes: keeps });
    appendGrowthApprovalToBook(disk, 'mary', { approved: lines, current: lines, changes: keeps });
    state.wiScript.worldInfoCache = new Map([[BOOK, structuredClone(disk)]]);
    let writes = 0;
    state.wiScript.saveWorldInfo = async (_name, wi) => {
        writes++;
        disk = structuredClone(wi);
        state.wiScript.worldInfoCache.get(BOOK).entries[99] = { uid: 99, content: 'Unsaved editor change' };
        throw new Error('response lost');
    };
    await expect(mergeGrowthHistoryIdentities('mara', 'mary', BOOK, () => {})).rejects.toThrow('rollback failed');
    expect(writes).toBe(1);
    expect(state.wiScript.worldInfoCache.get(BOOK).entries[99].content).toBe('Unsaved editor change');
});

test('mapped rewrites consume their source occurrence before matching duplicate output', () => {
    const record = buildGrowthApproval({ current: { ...lines, personality: 'A. B.' },
        approved: { ...lines, personality: 'B. B.' }, changes: [
            { field: 'personality', action: 'edit', before: 'A.', after: 'B.', evidenceIds: ['obs'] },
            { field: 'personality', action: 'keep', before: 'B.', after: 'B.', evidenceIds: [] }, keeps[1],
        ] });
    expect(record.changes.map(c => c.action)).toEqual(['edit', 'keep', 'keep']);
});

test('evidence-backed replacements shed baseline labels, including subsequent keeps', () => {
    const approved = { ...lines, personality: 'Asks for help.' };
    const record = buildGrowthApproval({ current: lines, approved, changes: [
        { ...keeps[0], action: 'edit', after: approved.personality, evidenceIds: ['obs'], sourceLabel: 'from the original line, no evidence' }, keeps[1],
    ] });
    expect(record.changes[0].sourceLabel).toBeUndefined();
    const next = buildGrowthApproval({ current: approved, approved, previous: record,
        changes: [{ ...record.changes[0], action: 'keep', before: approved.personality }, keeps[1]] });
    expect(next.changes[0].sourceLabel).toBeUndefined();
});

test.each([undefined, { enabled: false }, { limits: { personality: 700 } }])('dossier adoption fills missing settings, preserving survivor choices: %j', settings => {
    getRegistry().Mara.uid = null;
    getRegistry().Mara.growthDossier = settings;
    getRegistry().Mary.growthDossier = { enabled: true, limits: { personality: 1400, voice: 800 } };
    return mergeEntities('Mara', 'Mary', { relabelEntries: false, syncBlocks: false }).then(result => {
        expect(result.ok).toBe(true);
        expect(getGrowthDossierSettings('Mara')).toMatchObject({ enabled: settings?.enabled ?? true,
            limits: { personality: settings?.limits?.personality ?? 1400, voice: 800 } });
        expect(growthOwnsField('Mara', 'voice')).toBe(settings?.enabled ?? true);
        expect(validateKnowledgeStoreData({ registry: getRegistry() }).issues
            .filter(issue => issue.code === 'registry-growth-dossier-repaired')).toEqual([]);
    });
});

test('kept sentences are stored once and expand on read; legacy full changes still read', () => {
    appendGrowthApprovalToBook(disk, 'mara', { approved: lines, current: lines, changes: keeps });
    const entry = Object.values(disk.entries).find(isGrowthHistoryEntry);
    const stored = JSON.parse(entry.content);
    expect(stored.records.mara[0].changes[0]).not.toHaveProperty('before');
    expect(readGrowthHistoryContainerFromBook(disk).records.mara[0].changes[0]).toMatchObject(keeps[0]);
    stored.records.mara[0].changes[0].before = lines.personality;
    entry.content = JSON.stringify(stored);
    expect(readGrowthHistoryContainerFromBook(disk).records.mara[0].changes[0]).toMatchObject(keeps[0]);
});

test.each([null, [], {}, { changes: null }, { changes: [null] }, { changes: [{}] },
    { changes: [{ ...keeps[0], evidenceIds: 'obs' }] }, { approved: null }, { activeDossierApproval: 'yes' }])(
    'malformed approval records refuse reads and writes untouched: %j', malformed => {
        const valid = buildGrowthApproval({ current: lines, approved: lines, changes: keeps });
        const record = malformed && !Array.isArray(malformed) ? { ...valid, ...malformed } : malformed;
        // An empty object is independently malformed, rather than a patch.
        disk.entries[2] = { comment: '[MWT:growth-history]', content: JSON.stringify({ version: 1,
            records: { mara: [malformed && Object.keys(malformed).length === 0 ? malformed : record] } }) };
        const before = structuredClone(disk);
        expect(readGrowthHistoryContainerFromBook(disk)).toEqual({ ok: false, reason: 'container-records-invalid' });
        expect(() => appendGrowthApprovalToBook(disk, 'mara', { current: lines, approved: lines })).toThrow('container-records-invalid');
        expect(disk).toEqual(before);
    });

test('reviewer deletions of model keeps are audited without model evidence', () => {
    const current = { ...lines, personality: 'Waits patiently. Trusts slowly.' };
    const changes = [...keeps, { field: 'personality', action: 'keep', before: 'Trusts slowly.', after: 'Trusts slowly.', evidenceIds: ['obs'] }];
    const record = buildGrowthApproval({ approved: lines, current, changes });
    expect(record.changes.filter(c => c.action === 'remove')).toEqual([
        { field: 'personality', action: 'remove', before: 'Trusts slowly.', after: '', evidenceIds: [], sourceLabel: 'hand edit, no evidence' },
    ]);
});