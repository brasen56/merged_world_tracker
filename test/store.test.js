/**
 * test/store.test.js — The in-lorebook data store.
 *
 * The properties worth protecting:
 *   1. The store entry can never inject into a prompt.
 *   2. A missing store adopts legacy chat_metadata (one-way migration).
 *   3. An existing store is never clobbered by a seed.
 *   4. A corrupt store does NOT read as "empty" — that would look like
 *      "no NPCs known" and rebuild the whole book as duplicates.
 *   5. Writes are refused while un-hydrated, for the same reason.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs, setFakeContextExtras, getFakeMeta } from './stubs/core.js';
import { state } from '../knowledge/state.js';
import {
    STORE_SENTINEL, STORE_COMMENT, isStoreEntry,
    hydrateBook, isHydrated, assertHydrated,
    readField, writeField,
    applyStoreToWorldInfo, flushBook, flushAll, hydrateCurrentBooks,
    _clearCacheForTests, _setCacheForTests,
} from '../knowledge/store.js';
import { saveSettings } from '../knowledge/settings.js';
import { writeToLorebook } from '../knowledge/lorebook.js';

/**
 * Minimal stand-in for ST's world-info.js.
 *
 * `loadWorldInfo` returns a deep copy, exactly like the real one does — that is
 * what forces every writer into read-modify-write and makes the interleaving
 * this store guards against actually reproducible in a test.
 *
 * `saveWorldInfo` models the part of ST that this module gets wrong if it is
 * ever forgotten: without `immediately`, the write does NOT happen. ST hands it
 * to `saveWorldDebounced`, a SINGLE module-level debounced function shared by
 * every book, whose one timer each new call clears. Saving book A and then book
 * B discards A's write outright. An immediate save additionally cancels any
 * pending debounced write, exactly as ST's `_save` does.
 *
 * `books` therefore represents the DISK. A non-immediate save leaves it
 * untouched, so any call site that drops the flag fails its own assertions.
 */
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
                // Arms the shared debounce, dropping whatever was pending.
                pending = { name, wi: structuredClone(wi) };
                return;
            }
            pending = null; // ST's _save() cancels the shared debounce first
            books.set(name, structuredClone(wi));
        },
        /** Fire the one pending debounced write, if any. */
        flushDebounce() {
            if (!pending) return;
            books.set(pending.name, pending.wi);
            pending = null;
        },
        async createNewWorldInfo(name) {
            books.set(name, { entries: {} });
            return true; // the Aikobots v4 fork returns a boolean, not the object
        },
    };
}

let wiFake;

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
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

// ─── Hydration and migration ────────────────────────────────────────────────

describe('hydrateBook', () => {
    test('adopts legacy chat_metadata when the book has no store yet', () => {
        // This is the upgrade path off chat_metadata.
        return hydrateBook('Book A', { registry: { Mara: { uid: 0 } } }).then(data => {
            expect(data.registry).toEqual({ Mara: { uid: 0 } });
            expect(isHydrated('Book A')).toBe(true);
            // Seeding writes through immediately so the migration is durable.
            const entry = storeEntryOf('Book A');
            expect(entry).not.toBeNull();
            expect(JSON.parse(entry.content).registry).toEqual({ Mara: { uid: 0 } });
        });
    });

    test('does not write a store when there is nothing to migrate', async () => {
        await hydrateBook('Book A', { registry: {} });
        expect(isHydrated('Book A')).toBe(true);
        // An empty seed is not worth creating an entry for.
        expect(wiFake.books.has('Book A')).toBe(false);
    });

    test('reads an existing store back', async () => {
        await hydrateBook('Book A', { registry: { Mara: { uid: 0 } } });
        _clearCacheForTests();

        const data = await hydrateBook('Book A', {});
        expect(data.registry).toEqual({ Mara: { uid: 0 } });
    });

    test('an existing store is never overwritten by a seed', async () => {
        await hydrateBook('Book A', { registry: { Mara: { uid: 0 } } });
        _clearCacheForTests();

        // A stale chat_metadata seed must not clobber the book's own data.
        const data = await hydrateBook('Book A', { registry: { Someone: { uid: 99 } } });
        expect(data.registry).toEqual({ Mara: { uid: 0 } });
    });

    test('a corrupt store stays un-hydrated rather than reading as empty', async () => {
        wiFake.books.set('Book A', {
            entries: { 0: { uid: 0, comment: STORE_SENTINEL, content: '{not json' } },
        });

        await hydrateBook('Book A', {});
        // Treating this as {} would report every NPC as new and duplicate the book.
        expect(isHydrated('Book A')).toBe(false);
        expect(() => assertHydrated('Book A')).toThrow(/not loaded/);
    });

    test('stays un-hydrated when world-info is unavailable', async () => {
        state.wiScript = null;
        await hydrateBook('Book A', {});
        expect(isHydrated('Book A')).toBe(false);
    });

    test('KNOWLEDGE-02: a failed loadWorldInfo stays un-hydrated (no false empty)', async () => {
        // A book that exists but whose load throws must NOT be treated as a
        // brand-new book with no store. That would set hydrated=true against
        // an empty registry and rebuild the whole book as duplicates.
        wiFake.books.set('Book A', {
            entries: {
                0: { uid: 0, comment: STORE_SENTINEL, key: [], disable: true,
                     content: JSON.stringify({ version: 1, registry: { Mara: { uid: 1 } } }) },
                1: { uid: 1, comment: 'Mara', key: ['Mara'], content: 'dossier' },
            },
        });

        // Make loadWorldInfo throw on first call.
        const boom = vi.spyOn(wiFake, 'loadWorldInfo')
            .mockRejectedValueOnce(new Error('disk read error'));

        await hydrateBook('Book A', {});
        expect(isHydrated('Book A')).toBe(false);
        // assertHydrated must still throw — writes are blocked.
        expect(() => assertHydrated('Book A')).toThrow(/not loaded/);
    });
});

// ─── The store entry must never inject ──────────────────────────────────────

describe('store entry shape', () => {
    test('has no keywords and is disabled', async () => {
        await hydrateBook('Book A', { registry: { Mara: { uid: 0 } } });
        const entry = storeEntryOf('Book A');

        // Empty keywords make injection structurally impossible; the flags are
        // a second line of defence.
        expect(entry.key).toEqual([]);
        expect(entry.disable).toBe(true);
        expect(entry.enabled).toBe(false);
    });

    test('is not constant and not vectorized', async () => {
        // Empty keywords only defeat KEYWORD matching. These two flags bypass
        // keywords entirely, so they are the ones that actually matter.
        await hydrateBook('Book A', { registry: { Mara: { uid: 0 } } });
        const entry = storeEntryOf('Book A');
        expect(entry.constant).toBe(false);
        expect(entry.vectorized).toBe(false);
    });

    test('an entry edited into an injecting state is repaired on the next write', async () => {
        await hydrateBook('Book A', { registry: { Mara: { uid: 0 } } });

        // Simulate a user (or a lossy import) turning this into a live entry
        // by every available route at once.
        const wi = await wiFake.loadWorldInfo('Book A');
        const entry = Object.values(wi.entries).find(e => isStoreEntry(e));
        entry.key = ['Mara'];
        entry.keysecondary = ['Vance'];
        entry.constant = true;
        entry.vectorized = true;
        entry.disable = false;
        entry.enabled = true;
        await wiFake.saveWorldInfo('Book A', wi, true);

        writeField('Book A', 'registry', { Mara: { uid: 1 } });
        await flushBook('Book A');

        const repaired = storeEntryOf('Book A');
        expect(repaired.key).toEqual([]);
        expect(repaired.keysecondary).toEqual([]);
        expect(repaired.constant).toBe(false);
        expect(repaired.vectorized).toBe(false);
        expect(repaired.disable).toBe(true);
        expect(repaired.enabled).toBe(false);
    });

    test('the _note hint is stripped on read, not kept as data', async () => {
        await hydrateBook('Book A', { registry: { Mara: { uid: 0 } } });
        expect(JSON.parse(storeEntryOf('Book A').content)._note).toBeTruthy();

        _clearCacheForTests();
        const data = await hydrateBook('Book A', {});
        expect(data._note).toBeUndefined();
        expect(data.registry).toEqual({ Mara: { uid: 0 } });
    });

    test('new entries carry the descriptive title, sentinel first', async () => {
        await hydrateBook('Book A', { registry: { Mara: { uid: 0 } } });
        const entry = storeEntryOf('Book A');
        expect(entry.comment).toBe(STORE_COMMENT);
        expect(entry.comment.startsWith(STORE_SENTINEL)).toBe(true);
    });

    test('a legacy bare-sentinel entry is found, not duplicated, and retitled on write', async () => {
        // Books written before the descriptive title carry the bare sentinel.
        wiFake.books.set('Book A', {
            entries: {
                0: {
                    uid: 0, comment: STORE_SENTINEL, key: [], disable: true,
                    content: JSON.stringify({ version: 1, registry: { Mara: { uid: 1 } } }),
                },
            },
        });

        const data = await hydrateBook('Book A', {});
        expect(data.registry).toEqual({ Mara: { uid: 1 } });

        writeField('Book A', 'registry', { Mara: { uid: 1 }, Bren: { uid: 2 } });
        await flushBook('Book A');

        const saved = wiFake.books.get('Book A');
        const stores = Object.values(saved.entries).filter(e => isStoreEntry(e));
        expect(stores).toHaveLength(1);
        expect(stores[0].uid).toBe(0);
        expect(stores[0].comment).toBe(STORE_COMMENT);
    });

    test('does not collide with existing entry UIDs', async () => {
        wiFake.books.set('Book A', {
            entries: {
                0: { uid: 0, comment: 'Mara', key: ['Mara'], content: 'x' },
                1: { uid: 1, comment: 'Bren', key: ['Bren'], content: 'y' },
            },
        });
        await hydrateBook('Book A', { registry: { Mara: { uid: 0 } } });

        const entry = storeEntryOf('Book A');
        expect(entry.uid).toBe(2);
        // The pre-existing entries survive.
        expect(wiFake.books.get('Book A').entries[0].comment).toBe('Mara');
    });
});

// ─── isStoreEntry ───────────────────────────────────────────────────────────

describe('isStoreEntry', () => {
    test('matches the bare sentinel and any descriptive title after it', () => {
        expect(isStoreEntry({ comment: STORE_SENTINEL })).toBe(true);
        expect(isStoreEntry({ comment: STORE_COMMENT })).toBe(true);
        expect(isStoreEntry({ comment: `${STORE_SENTINEL} anything else` })).toBe(true);
    });

    test('rejects NPC entries and malformed comments', () => {
        expect(isStoreEntry({ comment: 'Mara' })).toBe(false);
        expect(isStoreEntry({ comment: '' })).toBe(false);
        expect(isStoreEntry({ comment: null })).toBe(false);
        expect(isStoreEntry({})).toBe(false);
        expect(isStoreEntry(null)).toBe(false);
    });
});

// ─── Ghost scrub ────────────────────────────────────────────────────────────

describe('store-ghost scrub', () => {
    test('a "[MWT:store]" NPC left by a pre-fix import is removed on hydrate', async () => {
        // importFromLorebooks used to register the store entry itself as an NPC.
        wiFake.books.set('Book A', {
            entries: {
                0: {
                    uid: 0, comment: STORE_SENTINEL, key: [], disable: true,
                    content: JSON.stringify({
                        version: 1,
                        registry: {
                            Mara: { uid: 1 },
                            [STORE_SENTINEL]: { uid: 0, keywords: [STORE_SENTINEL] },
                        },
                    }),
                },
            },
        });

        const data = await hydrateBook('Book A', {});
        expect(data.registry).toEqual({ Mara: { uid: 1 } });

        // The scrub persists, so the ghost cannot come back on the next load.
        await flushBook('Book A');
        const saved = JSON.parse(storeEntryOf('Book A').content);
        expect(saved.registry).toEqual({ Mara: { uid: 1 } });
    });

    test('a ghost in a legacy chat_metadata seed is not adopted', async () => {
        const seed = {
            registry: {
                Mara: { uid: 0 },
                [STORE_SENTINEL]: { uid: 5, keywords: [STORE_SENTINEL] },
            },
        };
        const data = await hydrateBook('Book A', seed);
        expect(data.registry).toEqual({ Mara: { uid: 0 } });
    });
});

// ─── Field access ───────────────────────────────────────────────────────────

describe('readField / writeField', () => {
    test('readField installs the fallback so callers can mutate in place', () => {
        // The chat_metadata version returned a stable object; callers rely on
        // mutating it and then calling save.
        const first = readField('Book A', 'registry', {});
        first.Mara = { uid: 0 };
        const second = readField('Book A', 'registry', {});
        expect(second).toBe(first);
        expect(second.Mara).toEqual({ uid: 0 });
    });

    test('writeField updates the cache synchronously', () => {
        writeField('Book A', 'registry', { Mara: { uid: 3 } });
        expect(readField('Book A', 'registry')).toEqual({ Mara: { uid: 3 } });
    });

    test('separate books keep separate data', () => {
        writeField('Book A', 'registry', { Mara: { uid: 0 } });
        writeField('Book B', 'registry', { Bren: { uid: 0 } });
        expect(readField('Book A', 'registry')).toEqual({ Mara: { uid: 0 } });
        expect(readField('Book B', 'registry')).toEqual({ Bren: { uid: 0 } });
    });
});

// ─── assertHydrated ─────────────────────────────────────────────────────────

describe('assertHydrated', () => {
    test('throws with an actionable message when un-hydrated', () => {
        expect(() => assertHydrated('Book A', 'create an entry'))
            .toThrow(/refusing to create an entry/);
        expect(() => assertHydrated('Book A'))
            .toThrow(/duplicate lorebook entries/);
    });

    test('passes once hydrated', () => {
        _setCacheForTests('Book A', { registry: {} });
        expect(() => assertHydrated('Book A')).not.toThrow();
    });
});

// ─── The interleaving guard ─────────────────────────────────────────────────

describe('applyStoreToWorldInfo', () => {
    test('folds the store into a caller-loaded book', () => {
        _setCacheForTests('Book A', { registry: { Mara: { uid: 0 } } });
        const wi = { entries: { 0: { uid: 0, comment: 'Mara', key: ['Mara'], content: 'x' } } };

        expect(applyStoreToWorldInfo('Book A', wi)).toBe(true);
        const entry = Object.values(wi.entries).find(e => isStoreEntry(e));
        expect(JSON.parse(entry.content).registry).toEqual({ Mara: { uid: 0 } });
    });

    test('no-ops for a book with no cached store', () => {
        const wi = { entries: {} };
        expect(applyStoreToWorldInfo('Unknown Book', wi)).toBe(false);
        expect(Object.keys(wi.entries)).toHaveLength(0);
    });

    test('a caller save that folds in the store does not lose the new entry', async () => {
        // Reproduces the interleaving this exists to prevent: two writers doing
        // load-modify-save on the same book. Folding the store into the
        // caller's own save removes the second writer entirely.
        _setCacheForTests('Book A', { registry: {} });
        wiFake.books.set('Book A', { entries: {} });

        // Caller loads, adds an entry, folds in the store, saves.
        const wi = await wiFake.loadWorldInfo('Book A');
        wi.entries[0] = { uid: 0, comment: 'Mara', key: ['Mara'], content: 'dossier' };
        writeField('Book A', 'registry', { Mara: { uid: 0 } });
        applyStoreToWorldInfo('Book A', wi);
        await wiFake.saveWorldInfo('Book A', wi, true);

        const saved = wiFake.books.get('Book A');
        const names = Object.values(saved.entries).map(e => e.comment);
        expect(names).toHaveLength(2);
        expect(names).toEqual(expect.arrayContaining([STORE_COMMENT, 'Mara']));
        const store = Object.values(saved.entries).find(e => isStoreEntry(e));
        expect(JSON.parse(store.content).registry).toEqual({ Mara: { uid: 0 } });
    });
});

// ─── Flushing ───────────────────────────────────────────────────────────────

// ─── Seeding is global-only ─────────────────────────────────────────────────

describe('hydrateCurrentBooks seeding', () => {
    test('the GLOBAL book adopts legacy chat_metadata', async () => {
        saveSettings({ scope: 'global' });
        getFakeMeta().knowledge_tracker_registry = { Mara: { uid: 0 } };

        const { knowledge } = await hydrateCurrentBooks();
        expect(knowledge).toBe('Knowledge Tracker');
        expect(readField(knowledge, 'registry')).toEqual({ Mara: { uid: 0 } });
    });

    test('a SCOPED book starts empty and never adopts it', async () => {
        // The legacy registry's uids point into the GLOBAL book. Copying them
        // into a scoped book would make writeToLorebook "update" whatever
        // occupies that uid here — on a new book, the store entry itself.
        saveSettings({ scope: 'character' });
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Assistant', avatar: 'default_Assistant.png' }],
        });
        getFakeMeta().knowledge_tracker_registry = { Mara: { uid: 0 } };

        const { knowledge } = await hydrateCurrentBooks();
        expect(knowledge).toBe('Knowledge Tracker - Assistant');
        expect(readField(knowledge, 'registry')).toEqual({});
        // Nothing to migrate means no book is created either.
        expect(wiFake.books.has(knowledge)).toBe(false);
    });
});

// ─── Stale-uid guard ────────────────────────────────────────────────────────

describe('writeToLorebook stale-uid guard', () => {
    test('refuses to overwrite the store entry and creates a new one', async () => {
        saveSettings({ scope: 'global' });
        // A book whose only entry is the store, sitting at uid 0 — exactly the
        // shape a freshly created scoped book has.
        await hydrateBook('Knowledge Tracker', { registry: { Mara: { uid: 0 } } });
        expect(storeEntryOf('Knowledge Tracker').uid).toBe(0);

        // A stale registry uid of 0 points straight at the store entry.
        const result = await writeToLorebook('Mara', 'dossier text', ['Mara'], 0);

        expect(result.success).toBe(true);
        expect(result.uid).not.toBe(0);

        const saved = wiFake.books.get('Knowledge Tracker');
        const store = Object.values(saved.entries).find(e => isStoreEntry(e));
        const mara = Object.values(saved.entries).find(e => e.comment === 'Mara');

        // The store survived intact, and did not acquire keywords.
        expect(store).toBeTruthy();
        expect(store.key).toEqual([]);
        expect(store.content).not.toBe('dossier text');
        // Mara landed in her own entry.
        expect(mara).toBeTruthy();
        expect(mara.content).toBe('dossier text');
        expect(mara.uid).not.toBe(store.uid);
    });
});

describe('writeToLorebook KNOWLEDGE-01 identity guard', () => {
    test('refuses to overwrite a different NPC and creates a new entry', async () => {
        // KNOWLEDGE-01: a stale registry uid can point at an unrelated NPC's
        // entry. The write must NOT clobber the wrong entry — it detaches the
        // stale uid and creates a new one instead.
        saveSettings({ scope: 'global' });
        // Pre-populate the book with two real NPC entries.
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                0: { uid: 0, comment: 'Mara', key: ['Mara'], content: 'mara old' },
                1: { uid: 1, comment: 'Bren', key: ['Bren'], content: 'bren old' },
            },
        });
        // Hydrate the store directly (avoids the seed/flush round-trip).
        _setCacheForTests('Knowledge Tracker', {
            registry: { Mara: { uid: 0 }, Bren: { uid: 1 } },
        });

        // The registry says Mara→0, but suppose it went stale and points
        // Mara→1 (Bren's slot).
        const result = await writeToLorebook('Mara', 'mara dossier', ['Mara'], 1);

        expect(result.success).toBe(true);
        // A new uid was assigned — not uid 1.
        expect(result.uid).not.toBe(1);

        const saved = wiFake.books.get('Knowledge Tracker');
        // Bren's entry (uid 1) is intact, not overwritten.
        expect(saved.entries[1].comment).toBe('Bren');
        expect(saved.entries[1].content).not.toBe('mara dossier');
        // Mara got her own new entry at a different uid.
        expect(saved.entries[result.uid]).toBeTruthy();
        expect(saved.entries[result.uid].comment).toBe('Mara');
        expect(saved.entries[result.uid].content).toBe('mara dossier');
        expect(result.uid).not.toBe(1);
    });

    test('allows overwrite when the comment matches (normal update)', async () => {
        saveSettings({ scope: 'global' });
        await hydrateBook('Knowledge Tracker', {
            registry: { Mara: { uid: 0 } },
        });
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                0: { uid: 0, comment: 'Mara', key: ['Mara'], content: 'old dossier' },
            },
        });

        const result = await writeToLorebook('Mara', 'updated dossier', ['Mara'], 0);
        expect(result.success).toBe(true);
        expect(result.uid).toBe(0);
        expect(wiFake.books.get('Knowledge Tracker').entries[0].content).toBe('updated dossier');
    });

    test('allows overwrite when the existing comment is empty', async () => {
        // An entry with no comment (edge case) should not trigger the
        // identity guard — it might be a legitimately blank entry being
        // claimed for the first time.
        saveSettings({ scope: 'global' });
        await hydrateBook('Knowledge Tracker', { registry: {} });
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                0: { uid: 0, comment: '', key: ['x'], content: 'blank' },
            },
        });

        const result = await writeToLorebook('Mara', 'mara dossier', ['Mara'], 0);
        expect(result.success).toBe(true);
        expect(result.uid).toBe(0);
    });

    test('allows overwrite when the comment differs only by case/whitespace (KNOWLEDGE-01 follow-up)', async () => {
        // The identity guard now routes through normalizeRegistryName, so a
        // case or leading/trailing-whitespace gap between the lorebook comment
        // and the name is the SAME NPC — not a stale uid. The old exact-string
        // check detached a valid uid here and created a duplicate.
        saveSettings({ scope: 'global' });
        await hydrateBook('Knowledge Tracker', { registry: { Mara: { uid: 0 } } });
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                0: { uid: 0, comment: '  mara  ', key: ['mara'], content: 'old dossier' },
            },
        });

        const result = await writeToLorebook('Mara', 'updated dossier', ['Mara'], 0);
        expect(result.success).toBe(true);
        // Reused uid 0 instead of detaching and creating a new entry.
        expect(result.uid).toBe(0);
        expect(wiFake.books.get('Knowledge Tracker').entries[0].content).toBe('updated dossier');
    });
});

describe('flushBook', () => {
    test('creates the book when it does not exist', async () => {
        _setCacheForTests('New Book', { registry: { Mara: { uid: 0 } } });
        expect(await flushBook('New Book')).toBe(true);
        expect(JSON.parse(storeEntryOf('New Book').content).registry)
            .toEqual({ Mara: { uid: 0 } });
    });

    test('preserves other entries in the book', async () => {
        wiFake.books.set('Book A', {
            entries: { 0: { uid: 0, comment: 'Mara', key: ['Mara'], content: 'dossier' } },
        });
        _setCacheForTests('Book A', { registry: { Mara: { uid: 0 } } });

        await flushBook('Book A');
        expect(wiFake.books.get('Book A').entries[0].content).toBe('dossier');
    });

    test('returns false for a book with no cached store', async () => {
        expect(await flushBook('Nothing Cached')).toBe(false);
    });
});

describe('a failed save must stay dirty', () => {

    // THE PROPERTY: the registry is only "clean" once it is actually on disk.
    //
    // applyStoreToWorldInfo() folds the store into the caller's world-info
    // object and used to clear `dirty` right there — synchronously, BEFORE the
    // caller's await on saveWorldInfo could possibly have succeeded. A save
    // that then threw left the cache marked clean while nothing had persisted,
    // so flushAll() skipped the book and the write was gone with a console
    // warning as its only trace. Losing registry uids is the exact failure the
    // duplicate-entry guards exist to prevent.

    test('flushBook reports failure and a later flushAll still retries', async () => {
        _setCacheForTests('Book A', {});
        writeField('Book A', 'registry', { Mara: { uid: 7 } });

        // The disk is unavailable for this attempt.
        const boom = vi.spyOn(wiFake, 'saveWorldInfo')
            .mockRejectedValueOnce(new Error('disk full'));

        expect(await flushBook('Book A')).toBe(false);
        expect(boom).toHaveBeenCalledTimes(1);
        // flushBook creates the book before saving, so the book itself may
        // exist — what must NOT exist is the store entry the save would have
        // written.
        expect(storeEntryOf('Book A')).toBeNull();

        // Disk is back. The book is still dirty, so this must write it out.
        await flushAll();

        expect(JSON.parse(storeEntryOf('Book A').content).registry)
            .toEqual({ Mara: { uid: 7 } });
    });

    test('a successful save does clear dirty, so flushAll does not rewrite', async () => {
        // The other half of the property — "stay dirty on failure" must not
        // become "always dirty", or every chat change would rewrite every book.
        _setCacheForTests('Book A', {});
        writeField('Book A', 'registry', { Mara: { uid: 7 } });

        expect(await flushBook('Book A')).toBe(true);

        const after = vi.spyOn(wiFake, 'saveWorldInfo');
        await flushAll();
        expect(after).not.toHaveBeenCalled();
    });

    test('flushAll persists EVERY dirty book, not just the last one', async () => {
        // THE PROPERTY: two books flushed back to back both reach disk.
        //
        // This is the bug that lost profileUid. saveWorldInfo() without
        // `immediately` only arms ST's saveWorldDebounced — one debounced
        // function shared by every book, holding one timer. flushAll() awaits
        // the Knowledge book and then the State book, and the second call
        // cleared the first's timer, so the Knowledge registry never reached
        // disk. markStoreClean() had already run, so nothing ever retried it.
        //
        // In-session reads still looked right (ST serves them from
        // worldInfoCache), so the loss only appeared after a reload: the
        // profile entry survived in the NPC Profiles lorebook while the
        // registry pointer at it was gone, which is what made Interiority's
        // "Profiled NPCs only" filter report no profiled NPC on the roster.
        _setCacheForTests('Knowledge Tracker', {});
        _setCacheForTests('State Tracker', {});
        writeField('Knowledge Tracker', 'registry', { Mara: { uid: 7, profileUid: 3 } });
        writeField('State Tracker', 'stateRegistry', { Weather: { uid: 1 } });

        await flushAll();

        // Nothing may be left sitting in the debounce.
        wiFake.flushDebounce();

        expect(JSON.parse(storeEntryOf('Knowledge Tracker').content).registry)
            .toEqual({ Mara: { uid: 7, profileUid: 3 } });
        expect(JSON.parse(storeEntryOf('State Tracker').content).stateRegistry)
            .toEqual({ Weather: { uid: 1 } });
    });

    test('writeToLorebook leaves the store dirty when its save fails', async () => {
        // Same hazard on the NPC-write path: applyStoreToWorldInfo is called
        // just before saveWorldInfo there too.
        saveSettings({ scope: 'global' });
        const book = 'Knowledge Tracker';
        await hydrateBook(book, { registry: {} });
        writeField(book, 'registry', { Mara: { uid: 7 } });

        vi.spyOn(wiFake, 'saveWorldInfo')
            .mockRejectedValueOnce(new Error('disk full'));

        const res = await writeToLorebook('Mara', 'dossier', ['Mara'], null);
        expect(res.success).toBe(false);

        await flushAll();
        expect(JSON.parse(storeEntryOf(book).content).registry)
            .toEqual({ Mara: { uid: 7 } });
    });
});
