/**
 * test/knowledge_store_hydration.test.js — Part 4: isolated Knowledge
 * lorebook hydration validation (delivery slice §11 "Part 4" of
 * upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md, design §6.7).
 *
 * The acceptance being pinned here:
 *   - a book becomes WRITABLE only after parse → version gate → migration →
 *     validation all succeed AND the migration is durably persisted;
 *   - a store written by a NEWER MWT is refused untouched (never stamped,
 *     never partially read) — the pre-Part-4 code silently re-stamped any
 *     non-number version and kept future versions writable;
 *   - legacy chat_metadata seeds are validated BEFORE adoption; rejected
 *     records land in the book's EMBEDDED quarantine, never the live registry;
 *   - the commit + quarantine merge + flush are one critical section under
 *     the store lock; a failed flush rolls the cache back wholesale so the
 *     untouched on-disk store stays the recoverable state;
 *   - the §6.7 record contract (profileUid, source enums, normalized-name
 *     collisions, relationship targets) holds at the schema level and stays
 *     pinned to the runtime accessors it mirrors.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs, setFakeContextExtras, getFakeMeta } from './stubs/core.js';
import { getEvents } from '../core/diagnostics.js';
import { prepareStore } from '../core/schema.js';
import { STORE_SCHEMAS } from '../schema/registry.js';
import {
    REGISTRY_KEY, STATE_REGISTRY_KEY, LOREBOOK_NAME, STATE_LOREBOOK_NAME, state,
} from '../knowledge/state.js';
import {
    STORE_SENTINEL, STORE_COMMENT, isStoreEntry,
    hydrateBook, hydrateCurrentBooks, isHydrated, assertHydrated,
    readField, flushBook, getStoreQuarantineItems, resetStoreCache, peekStore,
    _clearCacheForTests,
} from '../knowledge/store.js';
import { bumpEpoch } from '../core/scope.js';
import {
    KNOWLEDGE_STORE_VERSION,
    RELATIONSHIP_SOURCE_VALUES,
    normalizeStoreKeyName,
} from '../knowledge/schema.js';
import { normalizeRegistryName } from '../knowledge/registry.js';
import { SOURCE_AUTO, SOURCE_MANUAL } from '../knowledge/relationships.js';
import { saveSettings } from '../knowledge/settings.js';

// ─── Fake world-info (same contract as test/store.test.js) ───────────────────
//
// `books` is the DISK: a non-immediate save leaves it untouched, so any code
// path that drops the `immediately` flag fails its own assertions.

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
});

/** Pull the store entry out of a fake book. */
function storeEntryOf(bookName) {
    const wi = wiFake.books.get(bookName);
    if (!wi) return null;
    return Object.values(wi.entries).find(e => isStoreEntry(e)) || null;
}

/** Install a store entry with the given data (plus the flush-time _note). */
function setBookStore(bookName, data) {
    wiFake.books.set(bookName, {
        entries: {
            0: {
                uid: 0, comment: STORE_COMMENT, key: [], disable: true,
                content: JSON.stringify({ _note: 'hint', ...data }),
            },
        },
    });
}

/** The persisted store data (parsed), or null when the book has no entry. */
function savedStoreOf(bookName) {
    const entry = storeEntryOf(bookName);
    return entry ? JSON.parse(entry.content) : null;
}

/**
 * A registry record as the v2 identity migration leaves it: the entityId is
 * generated per stamp (matched as any string) and aliases default to [].
 * Legacy-path expectations use this; current-version (unmigrated) seeds keep
 * their bare records — the fields are optional until a migration/save stamps.
 */
const stamped = record => ({ aliases: [], entityId: expect.any(String), ...record });

// ─── Hydration validation gate ────────────────────────────────────────────────

describe('Part 4: hydration validation gate (§6.7)', () => {
    test('a valid current-version store hydrates and is not rewritten', async () => {
        setBookStore('Book A', { version: KNOWLEDGE_STORE_VERSION, registry: { Mara: { uid: 1 } } });
        const save = vi.spyOn(wiFake, 'saveWorldInfo');

        const data = await hydrateBook('Book A', {});

        expect(data.registry).toEqual({ Mara: { uid: 1 } });
        expect(data._note).toBeUndefined(); // stripped on read, not data
        expect(isHydrated('Book A')).toBe(true);
        // Unchanged canonical data must not be worth a save on every load —
        // that would rewrite both books on every chat change.
        expect(save).not.toHaveBeenCalled();
    });

    test('a legacy v0 store is migrated durably before it becomes writable', async () => {
        setBookStore('Book A', { registry: { Mara: { uid: 1 } } }); // no version

        const data = await hydrateBook('Book A', {});

        expect(isHydrated('Book A')).toBe(true);
        expect(data.version).toBe(KNOWLEDGE_STORE_VERSION);
        // The migration reached DISK before hydration returned — the flush is
        // awaited inside the critical section (§6.7 acceptance), not deferred.
        expect(savedStoreOf('Book A').version).toBe(KNOWLEDGE_STORE_VERSION);
        expect(savedStoreOf('Book A').registry).toEqual({ Mara: stamped({ uid: 1 }) });
        expect(getEvents({ module: 'knowledge' }).some(e => e.event === 'schema_migrated')).toBe(true);
    });

    test('invalid records are quarantined inside the book, not silently dropped', async () => {
        setBookStore('Book A', { registry: { Mara: { uid: 1 }, g: 'junk' } });

        const data = await hydrateBook('Book A', {});

        expect(isHydrated('Book A')).toBe(true);
        // The live view keeps only the valid record…
        expect(data.registry).toEqual({ Mara: stamped({ uid: 1 }) });
        // …and the rejected record is preserved whole in the book's own
        // embedded container (§5.1), persisted by the SAME save.
        const saved = savedStoreOf('Book A');
        expect(saved.quarantine.version).toBe(1);
        expect(saved.quarantine.items).toHaveLength(1);
        expect(saved.quarantine.items[0]).toMatchObject({
            store: 'knowledgeStore',
            reasonCode: 'registry-not-object',
            raw: 'junk',
        });
        expect(getStoreQuarantineItems('Book A')).toHaveLength(1);
    });

    test('a State book keeps trackers whose names differ only in case', async () => {
        // The NPC registry's collision rule must not reach the state
        // registry: its accessors are all exact-key lookups and the register
        // UI takes any trimmed name, so these are two live trackers pointing
        // at two entries. Pruning the second would stop its updates and
        // orphan its lorebook entry — the duplicate/orphan failure this store
        // exists to prevent.
        setBookStore('State Book', {
            version: KNOWLEDGE_STORE_VERSION,
            stateRegistry: {
                Weather: { uid: 1, lastUpdatedMsg: 0, lastUpdatedAt: 0, enabled: true, alwaysUpdate: false },
                weather: { uid: 7, lastUpdatedMsg: 0, lastUpdatedAt: 0, enabled: true, alwaysUpdate: false },
            },
        });
        const save = vi.spyOn(wiFake, 'saveWorldInfo');

        const data = await hydrateBook('State Book', {});

        expect(isHydrated('State Book')).toBe(true);
        expect(Object.keys(data.stateRegistry)).toEqual(['Weather', 'weather']);
        expect(data.stateRegistry.weather.uid).toBe(7);
        expect(getStoreQuarantineItems('State Book')).toEqual([]);
        expect(save).not.toHaveBeenCalled();
    });

    test('a re-hydration of canonical data adds no duplicate quarantine items', async () => {
        setBookStore('Book A', { registry: { Mara: { uid: 1 }, g: 'junk' } });
        await hydrateBook('Book A', {});

        // Simulate the next chat change: fresh cache, same (now canonical) disk.
        _clearCacheForTests();
        const data = await hydrateBook('Book A', {});

        expect(data.registry).toEqual({ Mara: stamped({ uid: 1 }) });
        expect(savedStoreOf('Book A').quarantine.items).toHaveLength(1);
    });

    test('a store written by a newer MWT is refused untouched', async () => {
        setBookStore('Book A', { version: 99, registry: { Mara: { uid: 1 } } });
        const save = vi.spyOn(wiFake, 'saveWorldInfo');

        await hydrateBook('Book A', {});

        // Pre-Part-4 this hydrated with the future version left writable.
        expect(isHydrated('Book A')).toBe(false);
        expect(() => assertHydrated('Book A', 'create an entry')).toThrow(/not loaded/);
        // Never coerced, never partially read, never rewritten.
        expect(save).not.toHaveBeenCalled();
        expect(savedStoreOf('Book A').version).toBe(99);
        expect(savedStoreOf('Book A').registry).toEqual({ Mara: { uid: 1 } });
        const events = getEvents({ module: 'knowledge' });
        expect(events.some(e => e.event === 'schema_blocked_future_version')).toBe(true);
    });

    test('a non-object store root is fatal and blocks the book', async () => {
        wiFake.books.set('Book A', {
            entries: { 0: { uid: 0, comment: STORE_SENTINEL, key: [], disable: true, content: '"just a string"' } },
        });
        const save = vi.spyOn(wiFake, 'saveWorldInfo');

        await hydrateBook('Book A', {});

        expect(isHydrated('Book A')).toBe(false);
        expect(save).not.toHaveBeenCalled();
        // The unreadable original stays exactly as it was.
        expect(storeEntryOf('Book A').content).toBe('"just a string"');
    });

    test('corrupt JSON still blocks (the pre-Part-4 fail-closed stance is unchanged)', async () => {
        setBookStore('Book A', { version: 1 });
        storeEntryOf('Book A').content = '{not json';

        await hydrateBook('Book A', {});

        expect(isHydrated('Book A')).toBe(false);
        expect(() => assertHydrated('Book A')).toThrow(/not loaded/);
    });

    test('a failed loadWorldInfo still blocks (KNOWLEDGE-02)', async () => {
        setBookStore('Book A', { version: 1, registry: { Mara: { uid: 1 } } });
        vi.spyOn(wiFake, 'loadWorldInfo').mockRejectedValueOnce(new Error('disk read error'));

        await hydrateBook('Book A', {});

        expect(isHydrated('Book A')).toBe(false);
        expect(() => assertHydrated('Book A')).toThrow(/not loaded/);
    });

    test('an invalid embedded version is quarantined once and heals on the next load', async () => {
        // The shipped policy (pinned since Part 2): a PRESENT invalid version
        // is reported by the v1 validator — the migration stamps only when it
        // is absent. The bad marker is preserved in quarantine, and the
        // following load migrates the now-versionless store up to v1.
        setBookStore('Book A', { version: 'x', registry: { Mara: { uid: 1 } } });

        const first = await hydrateBook('Book A', {});
        expect(isHydrated('Book A')).toBe(true);
        expect(first.registry).toEqual({ Mara: stamped({ uid: 1 }) });
        expect(savedStoreOf('Book A').quarantine.items[0]).toMatchObject({
            reasonCode: 'store-version-invalid',
            raw: 'x',
        });

        _clearCacheForTests();
        const second = await hydrateBook('Book A', {});
        expect(second.version).toBe(KNOWLEDGE_STORE_VERSION);
        expect(second.registry).toEqual({ Mara: stamped({ uid: 1 }) });
        const saved = savedStoreOf('Book A');
        expect(saved.version).toBe(KNOWLEDGE_STORE_VERSION);
        // One preserved record, not two — the fingerprint dedups re-detections.
        expect(saved.quarantine.items).toHaveLength(1);
    });

    test('an embedded quarantine container from a newer MWT blocks the book', async () => {
        setBookStore('Book A', {
            version: 1,
            registry: { Mara: { uid: 1 } },
            quarantine: { version: 2, items: [] },
        });
        const save = vi.spyOn(wiFake, 'saveWorldInfo');

        await hydrateBook('Book A', {});

        // §3.5 category 4 via §6.7 "cannot preserve rejected data safely":
        // refusing to downgrade the container means refusing the store.
        expect(isHydrated('Book A')).toBe(false);
        expect(save).not.toHaveBeenCalled();
        expect(savedStoreOf('Book A').quarantine.version).toBe(2);
    });
});

// ─── Legacy seed validation ───────────────────────────────────────────────────

describe('Part 4: legacy seeds are validated before adoption (§6.7)', () => {
    test('a seed is prepared through the migration before it enters the store', async () => {
        const data = await hydrateBook('Book A', {
            registry: { Mara: { uid: 0 }, bad: { uid: -1 } },
        });

        expect(isHydrated('Book A')).toBe(true);
        // Only the valid part of the legacy chat metadata is adopted…
        expect(data.registry).toEqual({ Mara: stamped({ uid: 0 }) });
        expect(data.version).toBe(KNOWLEDGE_STORE_VERSION);
        // …and the rejected record is preserved inside the book.
        const saved = savedStoreOf('Book A');
        expect(saved.version).toBe(KNOWLEDGE_STORE_VERSION);
        expect(saved.quarantine.items[0]).toMatchObject({
            reasonCode: 'registry-invalid-uid',
            raw: { uid: -1 },
        });
    });

    test('a [MWT:store] ghost in a seed is removed as a recorded repair', async () => {
        const seed = {
            registry: {
                Mara: { uid: 0 },
                [STORE_SENTINEL]: { uid: 9, keywords: [STORE_SENTINEL] },
            },
        };
        const data = await hydrateBook('Book A', seed);

        expect(data.registry).toEqual({ Mara: stamped({ uid: 0 }) });
        expect(savedStoreOf('Book A').registry).toEqual({ Mara: stamped({ uid: 0 }) });

        // The repair is recorded by the migration (schema level).
        const prepared = prepareStore(STORE_SCHEMAS.knowledgeStore, structuredClone(seed));
        expect(prepared.status).toBe('migrated');
        const repair = prepared.issues.find(issue => issue.code === 'registry-store-ghost');
        expect(repair).toMatchObject({ severity: 'repair', identity: STORE_SENTINEL });
        expect(repair.record).toEqual({ uid: 9, keywords: [STORE_SENTINEL] });
    });

    test('an empty seed still creates no store entry, and reports no migration', async () => {
        await hydrateBook('Book A', { registry: {} });
        expect(isHydrated('Book A')).toBe(true);
        expect(wiFake.books.has('Book A')).toBe(false);
        // An empty seed reads as version 0 and comes back status 'migrated',
        // but nothing was written — announcing it would log a migration that
        // never happened for BOTH books on every chat change of a fresh
        // install or any scoped book.
        expect(getEvents({ module: 'knowledge' }).some(e => e.event === 'schema_migrated')).toBe(false);
    });
});

// ─── Flush failure and rollback ───────────────────────────────────────────────

describe('Part 4: flush failure rolls the hydration back (§6.7 acceptance)', () => {
    test('a failed migration flush leaves the old recoverable state', async () => {
        setBookStore('Book A', { registry: { Mara: { uid: 1 }, g: 'junk' } });
        vi.spyOn(wiFake, 'saveWorldInfo').mockRejectedValueOnce(new Error('disk full'));

        await hydrateBook('Book A', {});

        // Writable only after DURABLE persistence: the flush failed, so the
        // book stays un-hydrated and writes are blocked.
        expect(isHydrated('Book A')).toBe(false);
        expect(() => assertHydrated('Book A')).toThrow(/not loaded/);
        // The cache serves nothing half-migrated…
        expect(readField('Book A', 'registry', {})).toEqual({});
        // …and the on-disk original is untouched (the fake only writes on a
        // resolved save), so nothing was lost either way.
        expect(savedStoreOf('Book A')).toMatchObject({ registry: { Mara: { uid: 1 }, g: 'junk' } });
        expect(savedStoreOf('Book A').version).toBeUndefined();
        expect(getEvents({ module: 'knowledge' }).some(e => e.event === 'schema_persist_failed')).toBe(true);

        // Disk is back: the idempotent migration re-runs and lands cleanly,
        // quarantining the junk record exactly once.
        const data = await hydrateBook('Book A', {});
        expect(isHydrated('Book A')).toBe(true);
        expect(data.registry).toEqual({ Mara: stamped({ uid: 1 }) });
        expect(savedStoreOf('Book A').quarantine.items).toHaveLength(1);
    });

    test('a failed seed-adoption flush adopts nothing writable', async () => {
        const meta = getFakeMeta();
        meta[REGISTRY_KEY] = { Mara: { uid: 4 } };
        vi.spyOn(wiFake, 'saveWorldInfo').mockRejectedValueOnce(new Error('disk full'));

        await hydrateBook('Book A', { registry: { Mara: { uid: 4 } } });

        expect(isHydrated('Book A')).toBe(false);
        // No store entry was written, and the legacy seed is still intact.
        expect(storeEntryOf('Book A')).toBeNull();
        expect(meta[REGISTRY_KEY]).toEqual({ Mara: { uid: 4 } });

        const data = await hydrateBook('Book A', { registry: meta[REGISTRY_KEY] });
        expect(isHydrated('Book A')).toBe(true);
        expect(data.registry).toEqual({ Mara: stamped({ uid: 4 }) });
        expect(savedStoreOf('Book A').registry).toEqual({ Mara: stamped({ uid: 4 }) });
    });

    test('a cache reset landing mid-hydration abandons instead of reporting failure', async () => {
        setBookStore('Book A', { registry: { Mara: { uid: 1 } } }); // v0 → would persist

        // Hold the read open so resetStoreCache() takes the lock first — the
        // way a second chat change overlaps the first one's reloadStores().
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const realLoad = wiFake.loadWorldInfo.bind(wiFake);
        vi.spyOn(wiFake, 'loadWorldInfo').mockImplementationOnce(async name => {
            await held;
            return realLoad(name);
        });

        const hydration = hydrateBook('Book A', {});
        await resetStoreCache();   // retires the slot this hydration captured
        release();
        await hydration;

        // The retired slot must not be mistaken for a failed save: flushBook()
        // resolves its slot from the cache, so it would have found nothing and
        // reported a persistence failure for a store that was never at risk.
        expect(getEvents({ module: 'knowledge' }).some(e => e.event === 'schema_persist_failed')).toBe(false);
        expect(console.error).not.toHaveBeenCalled();
        // Nothing was committed against the retired slot, and the disk
        // original is untouched.
        expect(isHydrated('Book A')).toBe(false);
        expect(savedStoreOf('Book A').version).toBeUndefined();

        // The hydration that follows the reset does the work instead.
        const data = await hydrateBook('Book A', {});
        expect(isHydrated('Book A')).toBe(true);
        expect(data.version).toBe(KNOWLEDGE_STORE_VERSION);
        expect(savedStoreOf('Book A').version).toBe(KNOWLEDGE_STORE_VERSION);
        expect(savedStoreOf('Book A').registry).toEqual({ Mara: stamped({ uid: 1 }) });
    });

    test('a chat switch between the two book hydrations aborts the stale orchestration', async () => {
        // Chat A: the knowledge book is healthy, and the chat still carries a
        // legacy state seed waiting to be adopted by the State book.
        setBookStore(LOREBOOK_NAME, { version: 1, registry: { Mara: { uid: 1 } } });
        getFakeMeta()[STATE_REGISTRY_KEY] = { Weather: { uid: 7 } };

        // Park the FIRST book's load; while it is pending the chat switches,
        // exactly as the root CHAT_CHANGED handler orders it: bumpEpoch()
        // invalidates in-flight scope tokens FIRST, then Knowledge's
        // fire-and-forget reloadStores() runs resetStoreCache() (its own
        // hydration would follow).
        let releaseLoad;
        let announce;
        const entered = new Promise((resolve) => { announce = resolve; });
        const gate = new Promise((resolve) => { releaseLoad = resolve; });
        const realLoad = wiFake.loadWorldInfo.bind(wiFake);
        wiFake.loadWorldInfo = async (name) => {
            if (name === LOREBOOK_NAME) {
                announce();
                await gate;
            }
            return realLoad(name);
        };

        const pending = hydrateCurrentBooks();
        await entered;                 // the knowledge hydration is parked on its load
        bumpEpoch();                   // the root handler's first statement
        await resetStoreCache();       // …then the reload's cache retirement
        releaseLoad();
        await pending;

        // The stale orchestration was abandoned BETWEEN the books: the State
        // book was never hydrated — no slot was created, the previous chat's
        // legacy seed was never adopted, nothing was written to disk.
        expect(peekStore(STATE_LOREBOOK_NAME)).toBeNull();
        expect(storeEntryOf(STATE_LOREBOOK_NAME)).toBeNull();
        expect(wiFake.books.has(STATE_LOREBOOK_NAME)).toBe(false);
        expect(getEvents({ module: 'knowledge' }).some(e => e.event === 'schema_hydration_abandoned')).toBe(true);

        // The new chat's own reload does the work under the fresh scope — the
        // seed is adopted by the NEW invocation, not the stale one.
        await hydrateCurrentBooks();
        expect(isHydrated(LOREBOOK_NAME)).toBe(true);
        expect(isHydrated(STATE_LOREBOOK_NAME)).toBe(true);
        expect(savedStoreOf(STATE_LOREBOOK_NAME).stateRegistry).toEqual({ Weather: { uid: 7 } });
    });

    test('a failed force re-read restores the previously good hydrated slot', async () => {
        setBookStore('Book A', { version: 1, registry: { Mara: { uid: 1 } } });
        await hydrateBook('Book A', {});
        const reg = readField('Book A', 'registry');
        reg.Bren = { uid: 2 };
        await flushBook('Book A');
        expect(savedStoreOf('Book A').registry).toEqual({ Mara: stamped({ uid: 1 }), Bren: { uid: 2 } });

        // The book on disk is externally replaced by a v0 store whose flush
        // will fail: the rollback must leave the last durable state live and
        // WRITABLE, not strand an un-writable book.
        setBookStore('Book A', { registry: { Mara: { uid: 1 } } });
        vi.spyOn(wiFake, 'saveWorldInfo').mockRejectedValueOnce(new Error('disk full'));

        await hydrateBook('Book A', {}, true /* force */);

        expect(isHydrated('Book A')).toBe(true);
        expect(readField('Book A', 'registry')).toEqual({ Mara: stamped({ uid: 1 }), Bren: { uid: 2 } });
        // The disk original is untouched for the next retry.
        expect(savedStoreOf('Book A').version).toBeUndefined();
    });
});

// ─── Scope switch ─────────────────────────────────────────────────────────────

describe('Part 4: scope switch through hydrateCurrentBooks', () => {
    test('global scope adopts legacy chat metadata into both books durably', async () => {
        const meta = getFakeMeta();
        meta[REGISTRY_KEY] = { Mara: { uid: 4 } };
        meta[STATE_REGISTRY_KEY] = { Weather: { uid: 0 } };

        const books = await hydrateCurrentBooks();

        expect(books).toEqual({ knowledge: LOREBOOK_NAME, state: STATE_LOREBOOK_NAME });
        expect(isHydrated(LOREBOOK_NAME)).toBe(true);
        expect(isHydrated(STATE_LOREBOOK_NAME)).toBe(true);
        expect(savedStoreOf(LOREBOOK_NAME)).toMatchObject({
            version: KNOWLEDGE_STORE_VERSION,
            registry: { Mara: { uid: 4 } },
        });
        expect(savedStoreOf(STATE_LOREBOOK_NAME)).toMatchObject({
            version: KNOWLEDGE_STORE_VERSION,
            stateRegistry: { Weather: { uid: 0 } },
        });
    });

    test('a scoped book never adopts the global legacy seed', async () => {
        // A scoped book must start empty: legacy chat metadata describes
        // entries in the GLOBAL books, and its uids would point into a
        // different book (see hydrateCurrentBooks).
        const meta = getFakeMeta();
        meta[REGISTRY_KEY] = { Mara: { uid: 4 } };
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara Vance', avatar: 'mara.png' }],
        });
        saveSettings({ scope: 'character' });

        const books = await hydrateCurrentBooks();

        expect(books.knowledge).not.toBe(LOREBOOK_NAME);
        expect(isHydrated(books.knowledge)).toBe(true);
        // No seed was adopted and no store entry was created for it…
        expect(readField(books.knowledge, 'registry', {})).toEqual({});
        expect(storeEntryOf(books.knowledge)).toBeNull();
        // …and the global books were not written either.
        expect(wiFake.books.has(LOREBOOK_NAME)).toBe(false);
    });

    test('after a cache reset the persisted store wins over a stale seed', async () => {
        const meta = getFakeMeta();
        meta[REGISTRY_KEY] = { Mara: { uid: 4 } };
        await hydrateCurrentBooks();
        await resetStoreCache();

        // The chat's legacy metadata changes (another chat's values): the
        // book's own store must still win — seeding happens only once.
        meta[REGISTRY_KEY] = { Someone: { uid: 99 } };
        await hydrateCurrentBooks();

        expect(readField(LOREBOOK_NAME, 'registry', {})).toEqual({ Mara: stamped({ uid: 4 }) });
    });
});

// ─── §6.7 record checks (schema level) ────────────────────────────────────────

describe('Part 4: §6.7 record checks at the schema level', () => {
    // Validate at the CURRENT version by default: these tests exercise the
    // validator's own rules, not the migrations (which stamp entity ids and
    // would flip every 'valid' status to 'migrated').
    const prepare = (data, version = KNOWLEDGE_STORE_VERSION) => prepareStore(STORE_SCHEMAS.knowledgeStore, data, { version });
    const codes = result => result.issues.map(issue => issue.code);

    test('profileUid must be absent, null, or a non-negative integer', () => {
        const ok = prepare({
            registry: {
                Mara: { uid: 1, profileUid: 3 },
                Bren: { uid: 2, profileUid: null },
                Kira: { uid: 3 },
            },
        });
        expect(ok.status).toBe('valid');
        expect(ok.issues).toEqual([]);

        const bad = prepare({ registry: { Mara: { uid: 1, profileUid: -1 }, Bren: { uid: 2, profileUid: 'x' } } });
        expect(codes(bad)).toEqual(['registry-invalid-profile-uid', 'registry-invalid-profile-uid']);
        // The complete raw records stay recoverable.
        expect(bad.quarantined.map(item => item.raw))
            .toEqual([{ uid: 1, profileUid: -1 }, { uid: 2, profileUid: 'x' }]);
    });

    test('relationship edge sources come from the provenance enum; absent stays valid', () => {
        const ok = prepare({
            registry: { Mara: { uid: 1 }, Bren: { uid: 2 } },
            relationships: {
                Mara: [
                    { target: 'Bren', type: 'ally', source: 'auto' },
                    { target: 'Bren', type: 'rival', source: 'manual' },
                    { target: 'Bren', type: 'friend' }, // predates provenance → manual
                ],
            },
        });
        expect(ok.status).toBe('valid');
        expect(ok.issues).toEqual([]);

        const bad = prepare({
            registry: { Mara: { uid: 1 } },
            relationships: { Mara: [{ target: 'Mara', type: 'ally', source: 'Auto' }] },
        });
        expect(codes(bad)).toEqual(['relationship-invalid-source']);
        expect(bad.quarantined[0].raw).toEqual({ target: 'Mara', type: 'ally', source: 'Auto' });
    });

    test('stance sources share the enum; stance text stays free-form', () => {
        const ok = prepare({
            registry: { Mara: { uid: 1 } },
            stances: { Mara: 'protective' }, // any string is a stance
            stanceSources: { Mara: 'auto' },
        });
        expect(ok.status).toBe('valid');
        expect(ok.issues).toEqual([]);

        const bad = prepare({ stanceSources: { Mara: 'seen' } });
        expect(codes(bad)).toEqual(['stance-source-invalid']);
        expect(bad.data.stanceSources).toEqual({});
        expect(bad.quarantined[0].raw).toBe('seen');
    });

    test('normalized-name collisions keep the first NPC-registry key and quarantine the rest', () => {
        const result = prepare({
            registry: { Mara: { uid: 1 }, 'mara ': { uid: 2 }, MARA: { uid: 3 } },
        });
        expect(result.data.registry).toEqual({ Mara: { uid: 1 } });
        expect(codes(result)).toEqual(['registry-name-collides', 'registry-name-collides']);
        expect(result.quarantined.map(item => item.raw)).toEqual([{ uid: 2 }, { uid: 3 }]);
    });

    test('state-registry keys that differ only in case are two separate trackers', () => {
        // The collision rule is licensed by resolveRegistryKey()'s
        // case-insensitive step, which the NPC registry has and the STATE
        // registry does not: every state-tracker access is an exact-key
        // lookup and the register UI accepts any trimmed name, so "Weather"
        // and "weather" are two live trackers pointing at two entries.
        // Pruning one would drop live state and orphan its lorebook entry.
        const result = prepare({
            stateRegistry: { Weather: { uid: 0 }, weather: { uid: 1 }, 'weather ': { uid: 2 } },
        });
        expect(result.status).toBe('valid');
        expect(result.data.stateRegistry).toEqual({
            Weather: { uid: 0 }, weather: { uid: 1 }, 'weather ': { uid: 2 },
        });
        expect(result.issues).toEqual([]);
        expect(result.quarantined).toEqual([]);
    });

    test('dangling relationship targets are retained with a reference finding', () => {
        const result = prepare({
            registry: { Mara: { uid: 1 } },
            relationships: {
                Mara: [
                    { target: 'Bren', type: 'ally' },      // not in registry
                    { target: 'mara', type: 'friend' },    // case-insensitive hit
                ],
            },
        });
        // §3.5 category 3: both edges stay in the live data…
        expect(result.data.relationships.Mara).toHaveLength(2);
        // …with exactly one finding for the dangling one.
        const finding = result.issues.find(issue => issue.code === 'relationship-target-unknown');
        expect(finding).toBeTruthy();
        expect(finding.severity).toBe('reference');
        expect(finding.record).toEqual({ target: 'Bren', type: 'ally' });
        // Reference findings reject nothing.
        expect(result.quarantined).toEqual([]);

        // No registry to resolve against (a State book): no findings at all.
        const stateBook = prepare({ relationships: { Weather: [{ target: 'Seasons', type: 'cycles' }] } });
        expect(stateBook.issues).toEqual([]);
    });

    test('the schema mirrors the runtime accessors it normalizes against', () => {
        // normalizeStoreKeyName must stay identical to the accessor's
        // normalizeRegistryName (knowledge/schema.js cannot import it — purity).
        for (const name of ['Mara Vance', '  mara  ', 'MARA', 'Ünter "Quote"', '', undefined, null, 42]) {
            expect(normalizeStoreKeyName(name)).toBe(normalizeRegistryName(name));
        }
        // The provenance enum must stay in lockstep with relationships.js.
        expect([...RELATIONSHIP_SOURCE_VALUES]).toEqual([SOURCE_AUTO, SOURCE_MANUAL]);
    });
});

