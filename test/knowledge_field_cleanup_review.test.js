import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _setCacheForTests, _clearCacheForTests } from '../knowledge/store.js';
import { getCleanupRecord, exportCleanupRecovery, importCleanupRecovery } from '../knowledge/cleanup_recovery.js';
import * as lorebook from '../knowledge/lorebook.js';
import { prepareFieldCleanup, requestFieldCleanup, applyFieldCleanup, restoreFieldCleanup, fieldCleanupPayload } from '../knowledge/field_cleanup_review.js';

const BOOK = 'Knowledge Tracker';
const original = '[Dossier] Mara | Human | keeper\nRole: Harbourmaster, checked the dock today\nVoice: A low deliberate voice\nCanon Lock: born here\nSecrets: Tier 2: hidden\n\nKnowledge Ledger:\n- gate code 4812 via witness — Day 1';
let books;
let fake;
const entry = () => books.get(BOOK).entries[7];
const proposalFor = prepared => ({ version: 1, reviewId: prepared.review.reviewId,
    fields: prepared.review.fields.map(field => ({ key: field.key, value: field.key === 'role' ? 'Harbourmaster' : 'Low voice', explanation: 'Concise', displacedDetails: 'Scene detail', ambiguity: '' })) });
const apply = prepared => applyFieldCleanup({ ...prepared, proposal: proposalFor(prepared),
    decisions: Object.fromEntries(prepared.review.fields.map(field => [field.key, { action: 'accept' }])) });

beforeEach(() => {
    resetCoreStubs(); _resetEpoch(); _clearCacheForTests();
    saveSettings({ scope: 'global', connectionProfileId: 'test-profile' });
    _setCacheForTests(BOOK, { registry: { Mara: { uid: 7, type: 'major', entityId: 'ent-1', keywords: ['Mara'] } } });
    books = new Map([[BOOK, { entries: { 7: { uid: 7, comment: 'Mara', key: ['Mara'], content: original },
        8: { uid: 8, comment: 'Other', content: 'untouched' } } }]]);
    fake = {
        async loadWorldInfo(name) { return structuredClone(books.get(name)); },
        async saveWorldInfo(name, wi) { books.set(name, structuredClone(wi)); return true; },
    };
    state.wiScript = fake; installCleanupFetch(fake);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); _clearCacheForTests(); _resetEpoch(); state.wiScript = null; });
const prepare = (keys = ['role', 'voice']) => prepareFieldCleanup({ name: 'Mara', uid: 7, keys });

describe('entry-only field cleanup orchestration and recovery', () => {
    test('payload contains selected values only, not chat, ledger, secrets, canon or recovery', async () => {
        const prepared = await prepare(['role']);
        const payload = fieldCleanupPayload(prepared.capture, prepared.review);
        expect(JSON.parse(payload).fields).toEqual([{ key: 'role', value: 'Harbourmaster, checked the dock today' }]);
        for (const excluded of ['4812', 'Tier 2', 'born here', 'A low deliberate voice', 'recent_messages', 'originalContent']) expect(payload).not.toContain(excluded);
        vi.spyOn(lorebook, 'ktFetchFromApi').mockResolvedValue(JSON.stringify(proposalFor(prepared)));
        expect((await requestFieldCleanup(prepared)).fields).toHaveLength(1);
        expect(lorebook.ktFetchFromApi).toHaveBeenCalledWith(expect.any(String), payload, expect.objectContaining({ retries: 0, trigger: 'manual' }));
        expect(entry().content).toBe(original);
    });
    test.each(['{"version":1', '```json\n{}\n```', '{}'])('strict malformed/incomplete response refuses without writing: %s', raw => {
        return (async () => {
            const prepared = await prepare();
            const request = vi.spyOn(lorebook, 'ktFetchFromApi').mockResolvedValue(raw);
            await expect(requestFieldCleanup(prepared)).rejects.toThrow();
            expect(request).toHaveBeenCalledTimes(1);
            expect(entry().content).toBe(original);
        })();
    });
    test('cancelled and stale requests never retry or write', async () => {
        const prepared = await prepare();
        const request = vi.spyOn(lorebook, 'ktFetchFromApi');
        const controller = new AbortController(); controller.abort();
        await expect(requestFieldCleanup(prepared, { signal: controller.signal })).rejects.toThrow('cancelled');
        bumpEpoch('test');
        await expect(requestFieldCleanup(prepared)).rejects.toThrow('chat changed');
        expect(request).not.toHaveBeenCalled();
        expect((await apply(prepared)).ok).toBe(false);
    });
    test('late request success after scope switch is refused', async () => {
        const prepared = await prepare();
        vi.spyOn(lorebook, 'ktFetchFromApi').mockImplementation(async () => { bumpEpoch('test'); return JSON.stringify(proposalFor(prepared)); });
        await expect(requestFieldCleanup(prepared)).rejects.toThrow('chat changed');
        expect(entry().content).toBe(original);
    });
    test('model errors preserve live content', async () => {
        const prepared = await prepare();
        vi.spyOn(lorebook, 'ktFetchFromApi').mockRejectedValue(new Error('provider failed'));
        await expect(requestFieldCleanup(prepared)).rejects.toThrow('provider failed');
        expect(entry().content).toBe(original);
    });
    test('ownership changes refuse at Apply', async () => {
        const prepared = await prepare();
        _setCacheForTests(BOOK, { registry: { Mara: { uid: 7, type: 'major', entityId: 'ent-1', growthDossier: { enabled: true } } } });
        expect((await apply(prepared)).ok).toBe(false);
        expect(entry().content).toBe(original);
        await expect(prepare(['voice'])).rejects.toThrow('owned by Growth');
    });
    test('stale source refuses; recovery storage failure blocks mutation', async () => {
        const prepared = await prepare();
        entry().content += '\nnewer';
        expect((await apply(prepared)).ok).toBe(false);
        entry().content = original;
        vi.spyOn(fake, 'saveWorldInfo').mockRejectedValue(new Error('disk failed'));
        expect((await apply(prepared)).code).toBe('recovery-persist-failed');
        expect(entry().content).toBe(original);
    });
    test('ownership changing while recovery is persisted refuses at the final writer guard', async () => {
        const prepared = await prepare();
        const save = fake.saveWorldInfo.bind(fake);
        vi.spyOn(fake, 'saveWorldInfo').mockImplementation(async (...args) => {
            const result = await save(...args);
            _setCacheForTests(BOOK, { registry: { Mara: { uid: 7, type: 'major', entityId: 'ent-1', growthDossier: { enabled: true } } } });
            return result;
        });
        expect((await apply(prepared)).ok).toBe(false);
        expect(entry().content).toBe(original);
    });
    test('multi-field apply, duplicate retry, export/import and restore preserve newer unrelated work', async () => {
        const prepared = await prepare();
        const result = await apply(prepared);
        expect(result.ok).toBe(true);
        expect((await apply(prepared)).ok).toBe(true);
        expect((await getCleanupRecord(result.actionId)).actionType).toBe('field-cleanup');
        const exported = await exportCleanupRecovery();
        expect((await importCleanupRecovery(exported)).rejected).toEqual([]);
        entry().content = entry().content.replace('born here', 'new canon').replace('gate code 4812', 'gate code 9988');
        expect((await restoreFieldCleanup(result.actionId)).ok).toBe(true);
        expect(entry().content).toBe(original.replace('born here', 'new canon').replace('gate code 4812', 'gate code 9988'));
        expect(books.get(BOOK).entries[8].content).toBe('untouched');
    });
    test('touched field conflict refuses restore', async () => {
        const result = await apply(await prepare());
        entry().content = entry().content.replace('Role: Harbourmaster', 'Role: Captain');
        expect((await restoreFieldCleanup(result.actionId)).code).toBe('span-conflict');
        expect(entry().content).toContain('Role: Captain');
    });
});