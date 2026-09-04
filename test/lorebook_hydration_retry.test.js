/**
 * test/lorebook_hydration_retry.test.js — TODO §6 "Lorebook hydration
 * failure/retry behavior": the RETRY half of KNOWLEDGE-02.
 *
 * test/knowledge_store_hydration.test.js pins that a failed load blocks
 * (fail-closed) and test/tier5_regression_net.test.js pins the same for a
 * permanently-failing loader. What this file adds is what happens on the
 * NEXT attempt — the behavior the pause banner's Retry (and a chat switch,
 * which re-runs the orchestration) depends on:
 *
 *   - a TRANSIENT load failure heals: the retry hydrates the real on-disk
 *     store, never a rebuild-from-empty;
 *   - repeated failures keep failing closed (a retry can never degrade into
 *     adopting the seed as an "empty" book);
 *   - the two-book orchestration (hydrateCurrentBooks) tolerates ONE book
 *     failing — the other still hydrates — and a later run heals the failed
 *     book;
 *   - the failure breadcrumb (peekStore observedVersion) is null — no on-disk
 *     version could be observed — which the banner renders as "unknown", not
 *     a made-up version.
 *
 * Harness mirrors test/knowledge_store_hydration.test.js (same fake
 * world-info contract: `books` is the DISK).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { _resetPausedStores, isStorePausedForCurrentScope } from '../core/schema_status.js';
import { LOREBOOK_NAME, STATE_LOREBOOK_NAME, state } from '../knowledge/state.js';
import {
    STORE_COMMENT,
    hydrateBook, hydrateCurrentBooks, isHydrated, assertHydrated,
    peekStore, peekStoreData, _clearCacheForTests,
} from '../knowledge/store.js';
import { KNOWLEDGE_STORE_VERSION } from '../knowledge/schema.js';
import { saveSettings } from '../knowledge/settings.js';

function makeFakeWorldInfo() {
    const books = new Map();
    let pending = null;
    return {
        books,
        async loadWorldInfo(name) {
            return books.has(name) ? structuredClone(books.get(name)) : null;
        },
        async saveWorldInfo(name, wi, immediately = false) {
            if (!immediately) {
                pending = { name, wi: structuredClone(wi) };
                return;
            }
            pending = null;
            books.set(name, structuredClone(wi));
        },
        flushDebounce() {
            if (!pending) return;
            books.set(pending.name, pending.wi);
            pending = null;
        },
        async createNewWorldInfo(name) {
            books.set(name, { entries: {} });
            return true;
        },
    };
}

let wiFake;

beforeEach(() => {
    resetCoreStubs();
    _resetPausedStores();
    _clearCacheForTests();
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    saveSettings({ scope: 'global' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    _clearCacheForTests();
    state.wiScript = null;
    vi.restoreAllMocks();
});

/** Install a store entry with the given data (same shape as the hydration suite). */
function setBookStore(bookName, data) {
    wiFake.books.set(bookName, {
        entries: {
            0: {
                uid: 0, comment: STORE_COMMENT, key: [], disable: true,
                content: JSON.stringify(data),
            },
        },
    });
}

describe('hydrateBook retry after a transient load failure', () => {
    test('a failed load blocks and records the pause; the retry hydrates the REAL store', async () => {
        setBookStore('Book A', { version: KNOWLEDGE_STORE_VERSION, registry: { Mara: { uid: 1 } } });
        vi.spyOn(wiFake, 'loadWorldInfo').mockRejectedValueOnce(new Error('transient read error'));

        await hydrateBook('Book A', {});
        expect(isHydrated('Book A')).toBe(false);
        expect(() => assertHydrated('Book A')).toThrow(/not loaded/);
        // The failure is VISIBLE, not just silent emptiness.
        expect(isStorePausedForCurrentScope('knowledgeStore')).toBe(true);
        // The breadcrumb: no on-disk version could be observed.
        expect(peekStore('Book A')).toMatchObject({ hydrated: false, observedVersion: null });

        // The retry (what the pause banner's Retry runs): the load succeeds
        // and the book hydrates from the store that was on disk all along.
        const second = await hydrateBook('Book A', {});
        expect(isHydrated('Book A')).toBe(true);
        expect(second.registry).toMatchObject({ Mara: { uid: 1 } });
        expect(() => assertHydrated('Book A')).not.toThrow();
    });

    test('repeated failures keep failing closed — the seed is never adopted as an empty book', async () => {
        // No book on disk at all; every load rejects (e.g. the WI file is
        // locked). Two attempts, both blocked — a retry must not degrade into
        // the KNOWLEDGE-02 "hydrate an empty store beside the real entries"
        // failure mode.
        const load = vi.spyOn(wiFake, 'loadWorldInfo').mockRejectedValue(new Error('disk down'));
        const seed = { registry: { Mara: { uid: 0 } } };

        await hydrateBook('Book A', seed);
        await hydrateBook('Book A', seed);

        expect(load).toHaveBeenCalledTimes(2); // the retry really re-attempted
        expect(isHydrated('Book A')).toBe(false);
        expect(() => assertHydrated('Book A')).toThrow(/not loaded/);
        // Nothing was written: no book was created and the seed never entered
        // the slot's data.
        expect(wiFake.books.has('Book A')).toBe(false);
        expect(peekStoreData('Book A').registry ?? {}).toEqual({});
    });
});

describe('hydrateCurrentBooks retry orchestration', () => {
    test('one failing book does not block the other, and a later run heals it', async () => {
        setBookStore(LOREBOOK_NAME, { version: KNOWLEDGE_STORE_VERSION, registry: { Mara: { uid: 1 } } });
        setBookStore(STATE_LOREBOOK_NAME, { version: KNOWLEDGE_STORE_VERSION, stateRegistry: { Weather: { uid: 7 } } });

        // Only the State book's load fails this time (e.g. its file is locked).
        const realLoad = wiFake.loadWorldInfo;
        const load = vi.spyOn(wiFake, 'loadWorldInfo').mockImplementation(async (name) => {
            if (name === STATE_LOREBOOK_NAME) throw new Error('state book read error');
            return realLoad.call(wiFake, name);
        });

        await hydrateCurrentBooks();

        expect(isHydrated(LOREBOOK_NAME)).toBe(true);   // the healthy book hydrated…
        expect(isHydrated(STATE_LOREBOOK_NAME)).toBe(false); // …the failing one did NOT fake it
        // Partial hydration must NOT resume the store: the knowledgeStore id
        // spans BOTH books, so one book healing cannot clear the pause the
        // other book's block raised (store.js — "the store resumes only when
        // both are healthy"). A regression that resumed after the first book
        // would leave the user's writes silently unblocked against a
        // half-loaded store.
        expect(isStorePausedForCurrentScope('knowledgeStore')).toBe(true);

        // A later orchestration run (chat switch, or Retry in the banner)
        // with the load healed brings the failed book back.
        load.mockRestore();
        await hydrateCurrentBooks();

        expect(isHydrated(LOREBOOK_NAME)).toBe(true);
        expect(isHydrated(STATE_LOREBOOK_NAME)).toBe(true);
        // …and only now does the pause come down (the banner's Retry owns
        // exactly this transition).
        expect(isStorePausedForCurrentScope('knowledgeStore')).toBe(false);
        // And it is the REAL store, not a rebuild.
        const stateBook = peekStoreData(STATE_LOREBOOK_NAME);
        expect(stateBook.stateRegistry).toMatchObject({ Weather: { uid: 7 } });
    });
});

