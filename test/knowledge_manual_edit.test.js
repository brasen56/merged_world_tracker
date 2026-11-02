import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { state, TRACKER_SENTINEL } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import * as scope from '../knowledge/scope.js';
import { getRegistry } from '../knowledge/registry.js';
import { _setCacheForTests, _clearCacheForTests, captureStoreState } from '../knowledge/store.js';
import { getHistory, writeStateTracker, writeToLorebook } from '../knowledge/lorebook.js';
import { injectRelationshipBlock, stripRelationshipBlock, setStance } from '../knowledge/relationships.js';
import { loadForManualEdit, saveManualEdit, isManualEditDirty, parseManualKeywords } from '../knowledge/manual_edit.js';

const BOOK = 'Knowledge Tracker';
const NAME = 'Mara Voss';
const BODY = 'Mara Voss | Human | harbourmaster\nTone: brisk';
let disk, host, storage;
const entry = () => disk.entries[0];
const load = () => loadForManualEdit({ name: NAME, uid: 0 });
const save = (session, body = `${BODY}\nManual change`, keywords = NAME) => saveManualEdit({ session, body, keywords });

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _clearCacheForTests();
    saveSettings({ scope: 'global' });
    _setCacheForTests(BOOK, { registry: { [NAME]: { uid: 0, entityId: 'ent-mara', type: 'major',
        keywords: [NAME], aliases: ['The Vixen'], profileUid: 9 } } });
    disk = { entries: { 0: { uid: 0, comment: NAME, content: BODY, key: [NAME],
        keysecondary: ['port'], order: 17, disable: true, custom: { keep: true } },
    4: { uid: 4, comment: 'Other NPC', content: 'untouched', key: [] } } };
    host = { worldInfoCache: new Map(),
        loadWorldInfo: vi.fn(async () => structuredClone(disk)),
        saveWorldInfo: vi.fn(async (_name, wi) => { disk = structuredClone(wi); }),
    };
    state.wiScript = host;
    state.stagingItems = [];
    installCleanupFetch(host);
    storage = new Map();
    vi.stubGlobal('localStorage', { getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value) });
});

afterEach(() => {
    _clearCacheForTests();
    _resetEpoch();
    state.wiScript = null;
    state.stagingItems = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('snapshots skip writes that leave the body unchanged', () => {
    test('a keyword-only save stores no snapshot and reports none lost', async () => {
        const { session } = await load();
        const result = await save(session, BODY, 'port');
        expect(result).toMatchObject({ ok: true, historyLost: false, keywords: ['port'] });
        expect(entry().key).toEqual(['port']);
        expect(getHistory(0, BOOK)).toEqual([]);
    });

    test('a state tracker write snapshots only when its text changes', async () => {
        entry().comment = `${TRACKER_SENTINEL} Mara`;
        entry().content = 'Day 1';
        await writeStateTracker(0, 'Mara', 'Day 1');
        expect(getHistory(0, 'State Tracker')).toEqual([]);
        await writeStateTracker(0, 'Mara', 'Day 2');
        expect(getHistory(0, 'State Tracker').map(record => record.content)).toEqual(['Day 1']);
    });
});

describe('manual edit service', () => {
    test('uid zero success preserves metadata, snapshots before overwrite and returns disk content', async () => {
        const { session } = await load();
        expect(session).toMatchObject({ name: NAME, uid: 0, entityId: 'ent-mara', bookName: BOOK, baselineBody: BODY, keys: [NAME] });
        host.saveWorldInfo.mockImplementation(async (_name, wi) => {
            expect(getHistory(0, BOOK)[0].content).toBe(BODY);
            disk = structuredClone(wi);
        });
        const result = await save(session);
        expect(result).toMatchObject({ ok: true, content: entry().content, keywords: [NAME] });
        expect(entry()).toMatchObject({ order: 17, disable: true, keysecondary: ['port'], custom: { keep: true } });
        expect(disk.entries[4].content).toBe('untouched');
        expect(getRegistry()[NAME]).toMatchObject({ profileUid: 9, entityId: 'ent-mara', type: 'major' });
        expect(host.worldInfoCache.get(BOOK)).toEqual(disk);
    });

    test.each(['The Vixen', 'Mara'])('accepts alias-labelled entry %s', async label => {
        entry().comment = label;
        const { session } = await load();
        expect(session).toBeDefined();
        expect((await save(session)).ok).toBe(true);
        expect(entry().comment).toBe(NAME);
    });

    test.each(['missing', 'store', 'recovery', 'label', 'body', 'hydration', 'scope', 'book', 'entity', 'uid'])('final guard refuses %s without history or mutation', async kind => {
        const { session } = await load();
        const fetchDisk = globalThis.fetch;
        vi.stubGlobal('fetch', async (path, options) => {
            if (path === '/api/worldinfo/get') {
                if (kind === 'missing') delete disk.entries[0];
                if (kind === 'store') entry().comment = '[MWT:store]';
                if (kind === 'recovery') entry().comment = '[MWT:cleanup-recovery]';
                if (kind === 'label') entry().comment = 'Another NPC';
                if (kind === 'body') entry().content += '\nbackground';
                if (kind === 'hydration') _clearCacheForTests();
                if (kind === 'scope') bumpEpoch();
                if (kind === 'book') vi.spyOn(scope, 'getLorebookName').mockReturnValue('Other book');
                if (kind === 'entity') getRegistry()[NAME].entityId = 'replacement';
                if (kind === 'uid') getRegistry()[NAME].uid = 4;
            }
            return fetchDisk(path, options);
        });
        expect((await save(session)).ok).toBe(false);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(getHistory(0, BOOK)).toEqual([]);
    });

    test('cache conflict refuses before mutation or history', async () => {
        const { session } = await load();
        host.worldInfoCache.set(BOOK, { entries: {} });
        expect(await save(session)).toMatchObject({ ok: false, code: 'host-unsaved-edits' });
        expect(entry().content).toBe(BODY);
        expect(getHistory(0, BOOK)).toEqual([]);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('CRLF no-op and parsed-key no-op perform no write', async () => {
        entry().content = BODY.replaceAll('\n', '\r\n');
        const { session } = await load();
        expect(isManualEditDirty(session, BODY, ` , ${NAME}, `)).toBe(false);
        expect(await save(session, BODY, ` ${NAME}, `)).toMatchObject({ ok: true, noOp: true });
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(getHistory(0, BOOK)).toEqual([]);
        expect(isManualEditDirty(session, `${BODY}\nrestored version`, NAME)).toBe(true);
    });

    test.each(['', ' \r\n\t', injectRelationshipBlock('', 'graph only')])('rejects blank body %j', async body => {
        const { session } = await load();
        expect(await save(session, body)).toMatchObject({ ok: false, code: 'empty-body' });
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test.each(['port, harbour, ', ' , '])('keyword-only save %j synchronizes registry and every pending NPC proposal', async keywords => {
        // Empty field falls back to NAME: make that a real keyword change.
        if (!keywords.includes('port')) entry().key = ['old'];
        const actualSession = (await load()).session;
        state.stagingItems = [{ uid: 0, type: 'major' }, { uid: 0, type: 'minor' },
            { uid: 0, type: 'state', keywords: ['state'] }, { uid: 4, type: 'major', keywords: ['other'] }];
        const result = await save(actualSession, BODY, keywords);
        const expected = keywords.includes('port') ? ['port', 'harbour'] : [NAME];
        expect(result.ok).toBe(true);
        expect(entry().key).toEqual(expected);
        expect(getRegistry()[NAME].keywords).toEqual(expected);
        expect(state.stagingItems.map(item => item.keywords)).toEqual([expected, expected, ['state'], ['other']]);
        expect(entry().content).toBe(BODY);
        expect(parseManualKeywords('', NAME)).toEqual([NAME]);
    });

    test('relationship-only background update does not conflict; graph replaces draft and disk blocks', async () => {
        entry().content = injectRelationshipBlock(BODY, 'old graph');
        const { session } = await load();
        expect(session.baselineBody).toBe(BODY);
        entry().content = injectRelationshipBlock(BODY, 'background graph');
        const result = await save(session, injectRelationshipBlock(`${BODY}\nchange`, 'untrusted draft graph'));
        expect(result.ok).toBe(true);
        expect(entry().content).toBe(`${BODY}\nchange`); // empty live graph removes the block
    });

    test('cleanup checked writes still preserve keys unless explicitly opted in', async () => {
        expect((await writeToLorebook(NAME, 'cleanup', ['replace'], 0, { bookName: BOOK, beforeWrite: () => null })).success).toBe(true);
        expect(entry().key).toEqual([NAME]);
    });

    test.each(['unchanged', 'landed', 'different', 'unreadable'])('lost response reconciles %s honestly', async outcome => {
        const { session } = await load();
        const fetchDisk = globalThis.fetch;
        let failed = false;
        vi.stubGlobal('fetch', async (path, options) => {
            if (path === '/api/worldinfo/edit') {
                if (outcome !== 'unchanged') await fetchDisk(path, options);
                if (outcome === 'different') entry().content += '\nconcurrent';
                failed = true;
                throw new Error('lost response');
            }
            if (failed && outcome === 'unreadable') throw new Error('offline');
            return fetchDisk(path, options);
        });
        const result = await save(session);
        if (outcome === 'landed') {
            expect(result).toMatchObject({ ok: true, reconciled: true });
            expect(host.worldInfoCache.get(BOOK)).toEqual(disk);
            expect(captureStoreState([BOOK]).get(BOOK).dirty).toBe(true);
        } else {
            expect(result).toMatchObject({ ok: false, code: outcome === 'unchanged' ? 'save-failed' : 'outcome-uncertain' });
            expect(host.worldInfoCache.has(BOOK)).toBe(false);
        }
        expect(getHistory(0, BOOK)[0].content).toBe(BODY);
    });

    test('HTTP failure on keyword-only save is unchanged, not false success, and retry works', async () => {
        const { session } = await load();
        const fetchDisk = globalThis.fetch;
        vi.stubGlobal('fetch', async (path, options) => path === '/api/worldinfo/edit'
            ? { ok: false, status: 503 } : fetchDisk(path, options));
        expect(await save(session, BODY, 'new key')).toMatchObject({ ok: false, code: 'save-failed' });
        expect(entry().key).toEqual([NAME]);
        vi.stubGlobal('fetch', fetchDisk);
        expect((await save(session, BODY, 'new key')).ok).toBe(true);
    });

    test('reconciliation compares stripped sent body, not whitespace-bearing draft', async () => {
        const { session } = await load();
        setStance(NAME, 'friendly');
        const fetchDisk = globalThis.fetch;
        vi.stubGlobal('fetch', async (path, options) => {
            const response = await fetchDisk(path, options);
            if (path === '/api/worldinfo/edit') throw new Error('lost response');
            return response;
        });
        const body = `${BODY}\nchanged  \n\n`;
        const result = await save(session, body);
        expect(result).toMatchObject({ ok: true, reconciled: true, content: entry().content });
        expect(stripRelationshipBlock(result.content)).toBe(body.trim());
    });

    test('uses the latest graph even when it changes during the final disk load', async () => {
        const { session } = await load();
        const fetchDisk = globalThis.fetch;
        vi.stubGlobal('fetch', async (path, options) => {
            const response = await fetchDisk(path, options);
            if (path === '/api/worldinfo/get') setStance(NAME, 'wary');
            return response;
        });
        expect((await save(session)).ok).toBe(true);
        expect(entry().content).toContain('Stance toward {{user}}: wary.');
    });

    test.each(['host', 'uid', 'load', 'identity'])('load refuses %s failure', async kind => {
        if (kind === 'host') state.wiScript = null;
        if (kind === 'uid') expect(await loadForManualEdit({ name: NAME, uid: null })).toMatchObject({ ok: false, code: 'invalid-uid' });
        if (kind === 'load') host.loadWorldInfo.mockRejectedValue(new Error('offline'));
        if (kind === 'identity') entry().comment = 'Unrelated';
        if (kind !== 'uid') expect((await load()).ok).toBe(false);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('reconciled success refreshes the active host editor', async () => {
        const { session } = await load();
        host.world_names = [BOOK];
        host.reloadEditor = vi.fn();
        vi.stubGlobal('document', { getElementById: () => ({ value: '0' }) });
        const fetchDisk = globalThis.fetch;
        vi.stubGlobal('fetch', async (path, options) => {
            const response = await fetchDisk(path, options);
            if (path === '/api/worldinfo/edit') throw new Error('lost response');
            return response;
        });
        expect((await save(session)).ok).toBe(true);
        expect(host.reloadEditor).toHaveBeenCalledWith(BOOK);
    });

    test.each(['load', 'save', 'reconcile'])('scope switch during %s never updates new-chat registry or pending items', async stage => {
        const session = stage === 'load' ? null : (await load()).session;
        const fetchDisk = globalThis.fetch;
        let saving = false;
        vi.stubGlobal('fetch', async (path, options) => {
            const response = await fetchDisk(path, options);
            if (path === '/api/worldinfo/edit') saving = true;
            if ((stage === 'load' && path === '/api/worldinfo/get')
                || (stage === 'save' && saving) || (stage === 'reconcile' && saving && path === '/api/worldinfo/get')) {
                bumpEpoch();
                _setCacheForTests(BOOK, { registry: { NewChat: { uid: 0, keywords: ['safe'] } } });
                state.stagingItems = [{ uid: 0, type: 'major', keywords: ['safe'] }];
            }
            if (stage === 'reconcile' && path === '/api/worldinfo/edit') throw new Error('lost response');
            return response;
        });
        const result = stage === 'load' ? await load() : await save(session, `${BODY}\nchange`, 'new key');
        expect(result).toMatchObject({ ok: false, code: 'scope-changed' });
        expect(getRegistry().NewChat.keywords).toEqual(['safe']);
        expect(state.stagingItems[0].keywords).toEqual(['safe']);
        if (stage === 'load') expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('verification never returns an unverified draft echo', async () => {
        const { session } = await load();
        host.saveWorldInfo.mockImplementation(async (_name, wi) => {
            disk = structuredClone(wi);
            entry().content = 'another writer won';
        });
        expect(await save(session)).toMatchObject({ ok: false, code: 'outcome-uncertain' });
        expect(stripRelationshipBlock(session.content)).toBe(BODY);
    });
});