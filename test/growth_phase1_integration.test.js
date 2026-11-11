import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _clearCacheForTests, _setCacheForTests, flushAll, isStoreEntry, peekStore } from '../knowledge/store.js';
import { getEvidenceFile, saveEvidenceMap } from '../knowledge/evidence.js';
import { captureEvidence, runContinuousCapture, runIlsBackfillCapture } from '../knowledge/growth.js';
import { runNpcUpdate, runScan, enrichStagingItem } from '../knowledge/lorebook.js';
import { buildStagingItems } from '../knowledge/staging.js';
import { buildGrowthReviewContent } from '../knowledge/growth_dossier_review.js';
import { buildGrowthApproval } from '../knowledge/growth_lineage.js';
import { isInternalEntry } from '../knowledge/internal_entries.js';
import { findDestinationEntryUid } from '../knowledge/reconcile.js';
import { readGrowthHistoryContainer, writeGrowthHistoryContainer, isGrowthHistoryEntry,
    mergeGrowthHistoryRecordsUnlocked } from '../knowledge/growth_history.js';
import { collectBackup } from '../backup/collect.js';
import { validateBackupEnvelope } from '../backup/validate.js';
import { setGrowthDossierSettings } from '../knowledge/registry.js';

const BOOK = 'Knowledge Tracker';
const content = '[Dossier] Mara | Human | captain\nTone: soft\nPerceived as: kind\nVoice: old voice\nPersonality: old personality\nRole: captain\nBackground: sailor\nCanon Lock: born at sea';
const approval = acceptedAt => buildGrowthApproval({ acceptedAt,
    current: { personality: 'Patient.', voice: 'Plain.' }, approved: { personality: 'Patient.', voice: 'Plain.' } });
let books;
let requests;

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveSettings({ scope: 'global', apiUrl: 'https://example.test', modelName: 'test-model', dossierMode: true });
    _setCacheForTests(BOOK, { registry: { Mara: { uid: 7, type: 'major', entityId: 'ent-mara', aliases: [] } } });
    _setCacheForTests('State Tracker', { stateRegistry: {} });
    books = new Map([[BOOK, { entries: { 7: { uid: 7, comment: 'Mara', key: ['Mara'], content } } }]]);
    state.wiScript = {
        books,
        async loadWorldInfo(name) { return structuredClone(books.get(name) || null); },
        async saveWorldInfo(name, wi, immediately) { if (immediately) books.set(name, structuredClone(wi)); },
    };
    installCleanupFetch(state.wiScript);
    setFakeChat([0, 1, 2, 3].map(i => ({ name: 'Mara', mes: `Mara takes watch ${i}.`, send_date: 1000 + i })));
    requests = [];
    setFakeApi(request => { requests.push(request); return JSON.stringify({ observations: [] }); });
});
afterEach(() => { _clearCacheForTests(); state.wiScript = null; vi.unstubAllGlobals(); });

test.each(['scan', 'npc-update'])('compact Growth lines return to %s updates when ownership is off', async path => {
    saveSettings({ dossierMode: false, trackMainCharAsNpc: true });
    const compact = 'Mara | Human | captain\nTone: soft\nKnowledge Ledger:\n- Knows the harbour.';
    const grown = buildGrowthReviewContent(compact, 'Personality: Patient.\nVoice: Plain.');
    books.get(BOOK).entries[7].content = grown;
    expect(grown.startsWith('[Dossier]')).toBe(false);
    const fields = { tone: 'firm', personality: 'Asks for help.', voice: 'Drops formal titles.' };
    setFakeApi(request => {
        requests.push(request);
        return JSON.stringify(path === 'scan'
            ? { update_major: [{ name: 'Mara', fields, new_knowledge: [] }] }
            : { fields, new_knowledge: [] });
    });
    const update = async () => {
        if (path === 'npc-update') return (await runNpcUpdate('Mara', 7)).merged;
        const result = await runScan();
        const items = buildStagingItems(result);
        await enrichStagingItem(items[0]);
        expect(requests.at(-1).userContent).toContain('Personality: Patient.');
        return items[0].mergedContent;
    };
    setGrowthDossierSettings('Mara', { enabled: true });
    const protectedContent = await update();
    expect(protectedContent).toContain('Personality: Patient.');
    expect(protectedContent).toContain('Voice: Plain.');
    setGrowthDossierSettings('Mara', { enabled: false });
    const released = await update();
    expect(released).toContain('Personality: Asks for help.');
    expect(released).toContain('Voice: Drops formal titles.');
    expect(released).toContain('Tone: firm');
    expect(released.startsWith('[Dossier]')).toBe(false);
    expect(requests.at(-1).systemPrompt).toContain('"personality"');
    expect(requests.at(-1).systemPrompt).toContain('"voice"');
});

test.each([null, { ...approval(1), changes: [null] }])('backup validation refuses malformed history without changing its source: %j', async record => {
    const envelope = await collectBackup();
    envelope.growthHistory = { version: 1, records: { 'ent-mara': [record] } };
    const before = structuredClone(envelope);
    const checked = validateBackupEnvelope(envelope);
    expect(checked.growthHistory).toBeUndefined();
    expect(checked.warnings.some(warning => warning.includes('Growth history'))).toBe(true);
    expect(envelope).toEqual(before);
});

describe('capture leaf rule', () => {
    test.each(['manual', 'continuous', 'backfill'])('%s context excludes all four identity lines, keeps facts and canon', async path => {
        if (path === 'manual') await captureEvidence('Mara', 7);
        if (path === 'continuous') await runContinuousCapture('Mara', { minMessages: 1 });
        if (path === 'backfill') await runIlsBackfillCapture('Mara');
        expect(requests).toHaveLength(1);
        const context = requests[0].userContent.match(/<existing_context>([^]*?)<\/existing_context>/)?.[1];
        expect(context).toBeTypeOf('string');
        expect(context).not.toMatch(/^(?:Tone|Perceived as|Voice|Personality):/m);
        expect(context).toContain('Role: captain');
        expect(context).toContain('Background: sailor');
        expect(context).toContain('Canon Lock: born at sea');
    });
});

test('upgrade: existing evidence and an untouched switch protect Personality during single-NPC update', async () => {
    getEvidenceFile('Mara').enrolled = true;
    saveEvidenceMap();
    setFakeApi(() => JSON.stringify({ fields: { personality: 'Replacement personality', voice: 'New voice', role: 'admiral' } }));
    const result = await runNpcUpdate('Mara', 7);
    expect(result.merged).toContain('Personality: old personality');
    expect(result.merged).toContain('Voice: New voice');
    expect(result.merged).toContain('Role: admiral');
});

test.each([true, false])('single-NPC update honors explicit switch=%s despite evidence', async enabled => {
    getEvidenceFile('Mara').enrolled = true;
    saveEvidenceMap();
    setGrowthDossierSettings('Mara', { enabled });
    setFakeApi(() => JSON.stringify({ fields: { personality: 'New personality', voice: 'New voice', role: 'admiral' } }));
    const result = await runNpcUpdate('Mara', 7);
    expect(result.merged).toContain(`Personality: ${enabled ? 'old personality' : 'New personality'}`);
    expect(result.merged).toContain(`Voice: ${enabled ? 'old voice' : 'New voice'}`);
    expect(result.merged).toContain('Role: admiral');
});

describe('Growth history container', () => {
    test.each([false, true])('registry changes during history save stay dirty (save fails=%s)', async fails => {
        const save = state.wiScript.saveWorldInfo;
        state.wiScript.saveWorldInfo = async (...args) => {
            setGrowthDossierSettings('Mara', { enabled: false });
            if (fails) throw new Error('history save failed');
            return save(...args);
        };
        const write = writeGrowthHistoryContainer(BOOK, { 'ent-mara': [] });
        if (fails) await expect(write).rejects.toThrow('history save failed');
        else await write;
        expect(peekStore(BOOK).dirty).toBe(true);
        if (!fails) {
            const saved = Object.values(books.get(BOOK).entries).find(isStoreEntry);
            expect(JSON.parse(saved.content).registry.Mara).not.toHaveProperty('growthDossier');
        }
        state.wiScript.saveWorldInfo = save;
        await flushAll();
        const saved = Object.values(books.get(BOOK).entries).find(isStoreEntry);
        expect(JSON.parse(saved.content).registry.Mara.growthDossier.enabled).toBe(false);
        expect(peekStore(BOOK).dirty).toBe(false);
    });
    test.each([1, 2])('duplicate containers are refused by reads, writes and backup (second version=%s)', async version => {
        for (const [uid, v] of [[8, 1], [9, version]]) {
            books.get(BOOK).entries[uid] = { uid, comment: '[MWT:growth-history]',
                content: JSON.stringify({ version: v, records: { [`ent-${uid}`]: [{ approvedAt: uid }] } }) };
        }
        const before = structuredClone(books.get(BOOK));
        expect(await readGrowthHistoryContainer(BOOK)).toEqual({ ok: false, reason: 'duplicate-containers' });
        await expect(writeGrowthHistoryContainer(BOOK, {})).rejects.toThrow('duplicate-containers');
        await expect(collectBackup()).rejects.toThrow('Growth history');
        expect(books.get(BOOK)).toEqual(before);
    });
    test('reload, cap, never-inject flags, internal-entry exclusion and backup round trip', async () => {
        const records = { 'ent-mara': Array.from({ length: 12 }, (_, i) => approval(i + 1)) };
        await writeGrowthHistoryContainer(BOOK, records);
        expect((await readGrowthHistoryContainer(BOOK)).records['ent-mara']).toHaveLength(10);
        let wi = books.get(BOOK);
        let entry = Object.values(wi.entries).find(isGrowthHistoryEntry);
        expect(isInternalEntry(entry)).toBe(true);
        expect(findDestinationEntryUid({ [entry.uid]: { ...entry, key: ['Mara'] } }, 'Mara')).toBeNull();
        Object.assign(entry, { key: ['Mara'], keysecondary: ['Mara'], enabled: true, disable: false,
            constant: true, vectorized: true, excludeRecursion: false, preventRecursion: false });
        await writeGrowthHistoryContainer(BOOK, {});
        wi = books.get(BOOK);
        entry = Object.values(wi.entries).find(isGrowthHistoryEntry);
        expect(entry).toMatchObject({ key: [], keysecondary: [], enabled: false, disable: true,
            constant: false, vectorized: false, excludeRecursion: true, preventRecursion: true });
        const backup = await collectBackup();
        const checked = validateBackupEnvelope(JSON.parse(JSON.stringify(backup)));
        expect(checked.ok).toBe(true);
        expect(checked.growthHistory.records['ent-mara']).toHaveLength(10);
        delete wi.entries[entry.uid];
        await mergeGrowthHistoryRecordsUnlocked(checked.growthHistory.records, BOOK);
        expect((await readGrowthHistoryContainer(BOOK)).records).toEqual(checked.growthHistory.records);
    });
    test('future versions are refused untouched on write and backup', async () => {
        books.get(BOOK).entries[8] = { uid: 8, comment: '[MWT:growth-history]', content: '{"version":2,"records":{}}' };
        const before = structuredClone(books.get(BOOK));
        await expect(writeGrowthHistoryContainer(BOOK, {})).rejects.toThrow('unsupported-version');
        await expect(collectBackup()).rejects.toThrow('Growth history');
        expect(books.get(BOOK)).toEqual(before);
    });
    test('import is current-wins and preserves other entity histories', async () => {
        await writeGrowthHistoryContainer(BOOK, { 'ent-mara': [approval(2)] });
        await mergeGrowthHistoryRecordsUnlocked({ 'ent-mara': [approval(1)], 'ent-other': [] }, BOOK);
        expect((await readGrowthHistoryContainer(BOOK)).records).toEqual({ 'ent-mara': [approval(2)], 'ent-other': [] });
    });
    test('a lost save fails persistence verification', async () => {
        state.wiScript.saveWorldInfo = async () => {};
        await expect(writeGrowthHistoryContainer(BOOK, { 'ent-mara': [] })).rejects.toThrow('persistence could not be verified');
    });
    test('malformed records cannot replace existing history', async () => {
        await writeGrowthHistoryContainer(BOOK, { 'ent-mara': [approval(2)] });
        await expect(writeGrowthHistoryContainer(BOOK, { 'ent-mara': {} })).rejects.toThrow('invalid records');
        expect((await readGrowthHistoryContainer(BOOK)).records['ent-mara']).toEqual([approval(2)]);
    });
});