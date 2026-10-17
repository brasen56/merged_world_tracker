/**
 * test/world_info_editor_sync.test.js — keeping ST's World Info editor and
 * cache coherent with MWT's book writes.
 *
 * ST's editor holds its own copy of the selected book and saves that WHOLE
 * copy on its next edit, so every MWT save must re-render it
 * (refreshWorldInfoEditor via saveBookNow / saveCleanupBook). Cleanup writes
 * are built from disk, so they must also refuse while the host cache holds
 * unsaved state (hostCacheConflict) — a pending debounced editor save would
 * otherwise land its stale copy on top of a verified cleanup.
 */

import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { state } from '../knowledge/state.js';
import { saveBookNow, refreshWorldInfoEditor } from '../knowledge/store.js';
import { hostCacheConflict, saveCleanupBook } from '../knowledge/cleanup_persistence.js';

const BOOK = 'Knowledge Tracker';

function makeWi$({ worldNames = ['Another Book', BOOK], withReload = true } = {}) {
    const books = new Map([[BOOK, { entries: { 1: { uid: 1, comment: 'Mara', content: 'old' } } }]]);
    const events = [];
    const wi$ = {
        books,
        events,
        world_names: worldNames,
        async loadWorldInfo(name) { return books.has(name) ? structuredClone(books.get(name)) : null; },
        async saveWorldInfo(name, wi, immediately = false) {
            events.push(`save:${name}`);
            if (immediately) books.set(name, structuredClone(wi));
        },
    };
    if (withReload) wi$.reloadEditor = vi.fn(name => events.push(`reload:${name}`));
    return wi$;
}

function editorShowing(value) {
    vi.stubGlobal('document', {
        getElementById: id => (id === 'world_editor_select' ? { value } : null),
    });
}

beforeEach(() => {
    resetCoreStubs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    state.wiScript = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('saveBookNow refreshes the World Info editor', () => {
    test('re-renders the editor after the save when it shows this book', async () => {
        const wi$ = makeWi$();
        editorShowing('1'); // world_names[1] === BOOK
        await saveBookNow(wi$, BOOK, { entries: {} });
        expect(wi$.reloadEditor).toHaveBeenCalledTimes(1);
        expect(wi$.reloadEditor).toHaveBeenCalledWith(BOOK);
        expect(wi$.events).toEqual([`save:${BOOK}`, `reload:${BOOK}`]);
    });

    test('leaves the editor alone when it shows another book', async () => {
        const wi$ = makeWi$();
        editorShowing('0');
        await saveBookNow(wi$, BOOK, { entries: {} });
        expect(wi$.reloadEditor).not.toHaveBeenCalled();
    });

    test('never OPENS the book when nothing is selected, even at world_names[0]', async () => {
        // ST's own reloadEditor reads the '' placeholder as index 0.
        const wi$ = makeWi$({ worldNames: [BOOK, 'Another Book'] });
        editorShowing('');
        await saveBookNow(wi$, BOOK, { entries: {} });
        expect(wi$.reloadEditor).not.toHaveBeenCalled();
    });

    test.each([
        ['a fork without reloadEditor', () => makeWi$({ withReload: false }), () => editorShowing('1')],
        ['a fork without world_names', () => ({ ...makeWi$(), world_names: undefined }), () => editorShowing('1')],
        ['no DOM (node, headless)', () => makeWi$(), () => {}],
    ])('%s: the save still completes, no refresh attempted', async (_label, make, setup) => {
        const wi$ = make();
        setup();
        await expect(saveBookNow(wi$, BOOK, { entries: { 2: { uid: 2 } } })).resolves.toBeUndefined();
        expect(wi$.books.get(BOOK).entries[2]).toBeTruthy();
        if (typeof wi$.reloadEditor === 'function') expect(wi$.reloadEditor).not.toHaveBeenCalled();
    });

    test('a throwing reloadEditor never fails the save', async () => {
        const wi$ = makeWi$();
        wi$.reloadEditor = vi.fn(() => { throw new Error('editor exploded'); });
        editorShowing('1');
        await expect(saveBookNow(wi$, BOOK, { entries: {} })).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('editor refresh failed'), 'editor exploded');
    });

    test('refreshWorldInfoEditor tolerates a missing module', () => {
        expect(() => refreshWorldInfoEditor(null, BOOK)).not.toThrow();
    });
});

describe('saveCleanupBook refreshes only after a checked save', () => {
    test('a successful checked save updates the cache, then re-renders the editor', async () => {
        const wi$ = makeWi$();
        wi$.worldInfoCache = new Map();
        state.wiScript = wi$;
        installCleanupFetch(wi$);
        editorShowing('1');
        const wi = { entries: { 1: { uid: 1, comment: 'Mara', content: 'new' } } };
        await saveCleanupBook(BOOK, wi);
        expect(wi$.worldInfoCache.get(BOOK)).toEqual(wi);
        expect(wi$.reloadEditor).toHaveBeenCalledWith(BOOK);
    });

    test('a failed HTTP save neither touches the cache nor refreshes', async () => {
        const wi$ = makeWi$();
        wi$.worldInfoCache = new Map();
        state.wiScript = wi$;
        installCleanupFetch(wi$);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
        editorShowing('1');
        await expect(saveCleanupBook(BOOK, { entries: {} })).rejects.toThrow(/HTTP 500/);
        expect(wi$.worldInfoCache.has(BOOK)).toBe(false);
        expect(wi$.reloadEditor).not.toHaveBeenCalled();
    });
});

describe('hostCacheConflict', () => {
    const disk = { entries: { 1: { uid: 1, comment: 'Mara', content: 'old' } } };

    test.each([
        ['no world-info module', null],
        ['no cache on this host', {}],
        ['book not cached', { worldInfoCache: new Map() }],
        ['cache matches disk', { worldInfoCache: new Map([[BOOK, structuredClone(disk)]]) }],
    ])('%s → no conflict', (_label, wiScript) => {
        state.wiScript = wiScript;
        expect(hostCacheConflict(BOOK, disk)).toBeNull();
    });

    test('a cache ahead of disk (pending editor save or failed host save) refuses', () => {
        const cached = structuredClone(disk);
        cached.entries[1].content = 'typed in the World Info editor';
        state.wiScript = { worldInfoCache: new Map([[BOOK, cached]]) };
        expect(hostCacheConflict(BOOK, disk)).toMatchObject({ ok: false, code: 'host-unsaved-edits' });
        expect(hostCacheConflict(BOOK, disk).error).toContain(BOOK);
    });
});
