/**
 * knowledge/store.js — Per-lorebook data store, kept inside the lorebook.
 *
 * ── Why the store lives in the book ─────────────────────────────────────────
 * The NPC registry maps an NPC name to a lorebook UID. The registry used to
 * live in `chat_metadata` while its target lived in the lorebook — two files,
 * two save paths, two lifetimes. `core/metadata.js` documents at length what
 * that cost: if the debounced metadata save didn't flush before a reload, the
 * pointer was lost while the entry it pointed at survived, the next save saw
 * no existing UID, and a SECOND entry was created. Duplicates accumulated
 * silently. `persistChatMetaNow()` exists to mitigate exactly that.
 *
 * Keeping the registry inside the book removes the failure mode instead of
 * mitigating it: pointer and target are now the same file, written by the same
 * `saveWorldInfo` call. It also makes each book self-describing — export or
 * share a book and its registry travels with it.
 *
 * ── The entry is structurally non-injecting ─────────────────────────────────
 * The store entry uses `key: []` (no keywords) so ST's world-info system can
 * never keyword-match it, plus `disable: true` as a second line of defence.
 * This is the same "default OFF by construction, not by toggle" approach the
 * NPC Profiles lorebook already uses.
 *
 * ── The entry is visible on purpose ─────────────────────────────────────────
 * The store could hide as an extra top-level key in the book's JSON, invisible
 * to the World Info editor. Rejected twice over: format converters (card-book
 * round-trips, lorebook imports) rebuild books from `entries` and would
 * silently strip it — and losing the store IS the duplicate-entry bug. And
 * hidden data in a user's files is a trust problem, not a favour. A plainly
 * titled entry the user can open, read, and delete is the deliberate choice.
 *
 * ── Why there is a synchronous cache ────────────────────────────────────────
 * `loadWorldInfo` is async, but `getRegistry()` and friends are synchronous and
 * called from render paths all over the module. Rather than convert dozens of
 * call sites to async, the book is hydrated once (on chat change) into an
 * in-memory cache that the sync accessors read from.
 *
 * That trade has one sharp edge: reading before hydration returns an EMPTY
 * registry, and an empty registry means "no NPC is known", which is precisely
 * what causes duplicate entries. So reads are permissive (render paths must not
 * throw) but any path that CREATES an entry must call `assertHydrated()` first,
 * turning a silent data-corrupting bug into a loud, actionable error.
 */

import { getChatMeta, record } from '../core/index.js';

import {
    state, REGISTRY_KEY, STATE_REGISTRY_KEY, RELATIONSHIP_KEY,
    LOREBOOK_NAME, STATE_LOREBOOK_NAME,
} from './state.js';

/** Marks the entry that holds this book's store. Matched as a PREFIX — see isStoreEntry. */
export const STORE_SENTINEL = '[MWT:store]';

/**
 * The full title written on the store entry. The sentinel comes first so the
 * prefix match keeps working; the rest answers the question a user actually has
 * when they spot this entry in the World Info editor. Nothing about this store
 * is meant to be hidden — a plainly-labelled entry the user can open and read
 * is the point.
 */
export const STORE_COMMENT =
    `${STORE_SENTINEL} — extension bookkeeping (0 tokens, never sent to the AI)`;

/**
 * Is this world-info entry the store entry?
 *
 * Prefix match, not equality: entries written before the descriptive title was
 * added carry the bare sentinel, and the wording after the sentinel may change
 * again. Any scan that walks a book's entries (imports, audits) must use this
 * to recognise and skip the store.
 *
 * @param {object} entry — a world-info entry
 * @returns {boolean}
 */
export function isStoreEntry(entry) {
    return typeof entry?.comment === 'string' && entry.comment.startsWith(STORE_SENTINEL);
}

/** Bumped only on a breaking change to the stored shape. */
export const STORE_VERSION = 1;

/** How long to wait before flushing a dirty store back to its book. */
const FLUSH_DEBOUNCE_MS = 1200;

/**
 * bookName → { data, hydrated, dirty, timer }
 * @type {Map<string, {data: object, hydrated: boolean, dirty: boolean, timer: any}>}
 */
const _cache = new Map();

// ─── Serialization lock ─────────────────────────────────────────────────────
//
// A restore commit (capture → flush → metadata persist → rollback) and a chat-
// change cache reset both touch the same dirty slots. JS is single-threaded,
// but an `await` in the middle of one hands the event loop to the other:
// resetStoreCache() → flushAll() can flush the restore's half-written store,
// or _cache.clear() can run between a restore's flush and its rollback, leaving
// the rollback a no-op and the cancelled restore persisted on disk
// This promise chain makes those operations strictly
// sequential. `flushBook` stays a non-locking leaf so a held lock does not
// re-enter; callers that need atomicity across several flushes (flushAll,
// resetStoreCache, the restore commit) acquire the lock around their whole
// critical section.
let _storeChain = Promise.resolve();

// While a restore transaction owns the store, background
// writeField() calls are deferred so they cannot join the restore's flush
// (persisted as if they were part of it) or be erased by its rollback. The
// restore's own writes go through _writeFieldDirect, which bypasses this buffer.
// Buffered writes are applied once the lock's critical section ends
// (withStoreLock's finally), so they flush on their own afterwards.
let _storeTransaction = false;
const _deferredWrites = [];

/**
 * Mark that the current lock holder is a restore transaction. Background
 * writeField() calls are then buffered until the transaction settles. Called by
 * the restore path (backup/index.js flushKnowledgeStore).
 */
export function beginStoreTransaction() {
    _storeTransaction = true;
}

/** Apply writes buffered while a restore transaction owned the store. */
function applyDeferredWrites() {
    if (_deferredWrites.length === 0) return;
    const pending = _deferredWrites.splice(0);
    for (const { bookName, field, value } of pending) {
        const s = slot(bookName);
        s.data[field] = value;
        s.dirty = true;
        scheduleFlush(bookName);
    }
}

/**
 * Run `fn` once all prior lock holders have settled. `fn` may be async; its
 * returned promise is what the caller awaits. Rejections never break the chain
 * so one failed operation cannot wedge every later one.
 *
 * When the critical section ends, any restore transaction is closed and
 * background writes buffered during it are applied.
 *
 * @template T
 * @param {() => (T | Promise<T>)} fn
 * @returns {Promise<T>}
 */
function _withTransactionFinally(fn) {
    return async () => {
        try {
            return await fn();
        } finally {
            _storeTransaction = false;
            applyDeferredWrites();
        }
    };
}

export function withStoreLock(fn) {
    const wrapped = _withTransactionFinally(fn);
    const run = _storeChain.then(wrapped, wrapped);
    _storeChain = run.then(() => undefined, () => undefined);
    return run;
}

function blankStore() {
    return { version: STORE_VERSION };
}

function slot(bookName) {
    let entry = _cache.get(bookName);
    if (!entry) {
        entry = { data: blankStore(), hydrated: false, dirty: false, timer: null };
        _cache.set(bookName, entry);
    }
    return entry;
}

/**
 * Resolve ST's world-info module.
 *
 * state.wiScript is a TRI-STATE:
 *  - `undefined` — nobody has tried to load world-info.js yet.
 *  - an object   — lorebook.js's top-level import (or our fallback below)
 *                  succeeded; this is the live module namespace.
 *  - `null`      — an import was ATTEMPTED and FAILED.
 *
 * lorebook.js loads world-info.js as a side-effect (top-level await) and parks
 * the result on state.wiScript. But store.js cannot import lorebook.js —
 * lorebook.js already imports store.js, so the reverse would be a circular
 * dependency. A future caller that imports store.js (plus registry.js / scope.js,
 * neither of which pull in lorebook.js) without going through the knowledge
 * barrel would otherwise find state.wiScript === undefined and silently get null
 * from every hydration. The fallback below keeps store.js self-sufficient.
 *
 * Tests that want to simulate "world-info unavailable" set state.wiScript = null
 * (tried-and-failed), which this function returns directly without retrying.
 */
async function getWiScript() {
    if (state.wiScript !== undefined) {
        if (state.wiScript === null) {
            // Phase 3 diagnostics (design §I.4.5, site 5): a previous import
            // attempt failed and callers are silently operating without the
            // world-info module — reads come back empty and writes are blocked.
            record({
                level: 'warn',
                module: 'knowledge',
                event: 'wi_script_unavailable',
                detail: { stage: 'previous-attempt-failed' },
            });
        }
        return state.wiScript;
    }
    try {
        state.wiScript = await import('../../../../world-info.js');
        return state.wiScript;
    } catch (err) {
        state.wiScript = null;
        console.warn('[MWT:Knowledge] store: world-info.js unavailable:', err?.message || err);
        // Phase 3 diagnostics (site 5, fresh failure) — same event as the
        // short-circuit above so the ring shows one shape for this condition.
        record({
            level: 'warn',
            module: 'knowledge',
            event: 'wi_script_unavailable',
            detail: { stage: 'import-failed', error: String(err?.message || err) },
        });
        return null;
    }
}

/** Find the store entry inside a loaded world-info object, or null. */
function findStoreEntry(wi) {
    const entries = wi?.entries;
    if (!entries) return null;
    for (const key of Object.keys(entries)) {
        if (isStoreEntry(entries[key])) return entries[key];
    }
    return null;
}

/**
 * Remove registry entries whose NAME is the store sentinel — ghosts left by
 * "Import from Lorebook" runs that predate isStoreEntry() and mistook the
 * store entry itself for an NPC.
 *
 * @param {object} data — store data, mutated in place
 * @returns {boolean} whether anything was removed
 */
function scrubStoreGhosts(data) {
    const reg = data?.registry;
    if (!reg || typeof reg !== 'object') return false;
    let removed = false;
    for (const name of Object.keys(reg)) {
        if (name.startsWith(STORE_SENTINEL)) {
            delete reg[name];
            removed = true;
        }
    }
    return removed;
}

// ─── Hydration ──────────────────────────────────────────────────────────────

/**
 * Load a book's store into the cache.
 *
 * When the book has no store entry yet, `seed` is adopted as the starting data
 * and written through immediately. That is the migration path off
 * `chat_metadata`: callers pass the legacy per-chat values, and the first
 * hydration moves them into the book. Seeding only ever happens when the book
 * has no store — an existing store is never overwritten by a seed.
 *
 * @param {string} bookName
 * @param {object} [seed] — legacy data to adopt if the book has no store yet
 * @param {boolean} [force] — re-read even if already hydrated
 * @returns {Promise<object>} the hydrated store data
 */
export async function hydrateBook(bookName, seed = {}, force = false) {
    if (!bookName) return blankStore();
    const s = slot(bookName);
    if (s.hydrated && !force) return s.data;

    const wi$ = await getWiScript();
    if (!wi$) {
        // No world-info module: stay un-hydrated so write paths refuse to run
        // rather than creating duplicates against an empty registry. This is
        // reachable if ST's world-info.js is genuinely absent (both the
        // top-level import in lorebook.js and our own fallback failed) — log
        // it so the failure is never silent.
        console.warn(`[MWT:Knowledge] store: world-info.js not loaded — "${bookName}" stays un-hydrated (writes blocked).`);
        return s.data;
    }

    let wi = null;
    let loadFailed = false;
    try {
        wi = await wi$.loadWorldInfo(bookName);
    } catch (err) {
        loadFailed = true;
        console.warn(`[MWT:Knowledge] store: could not load "${bookName}":`, err?.message || err);
    }

    // KNOWLEDGE-02: A failed load must NOT fall through to the "no store entry
    // yet" branch — that would set hydrated=true against an empty registry and
    // rebuild the whole book as duplicates beside entries still on disk.
    // Mirror the corrupt-JSON stance below: stay un-hydrated and shout, so
    // assertHydrated() blocks writes until the load succeeds.
    if (loadFailed) {
        console.error(
            `[MWT:Knowledge] store: load of "${bookName}" failed — refusing to ` +
            `treat it as empty. Writes are blocked until this is resolved.`
        );
        return s.data;
    }

    const entry = findStoreEntry(wi);
    if (entry) {
        try {
            const parsed = JSON.parse(entry.content || '{}');
            s.data = (parsed && typeof parsed === 'object') ? parsed : blankStore();
            // Written on flush purely as a human-readable hint — not data.
            delete s.data._note;
            if (typeof s.data.version !== 'number') s.data.version = STORE_VERSION;
            s.hydrated = true;
            s.dirty = false;
            if (scrubStoreGhosts(s.data)) {
                console.log(`[MWT:Knowledge] store: removed a "${STORE_SENTINEL}" ghost NPC from "${bookName}".`);
                s.dirty = true;
                scheduleFlush(bookName);
            }
            return s.data;
        } catch (err) {
            // A corrupt store is the one case where we must NOT silently fall
            // back to empty — that would look like "no NPCs known" and rebuild
            // the whole book as duplicates. Stay un-hydrated and shout.
            console.error(
                `[MWT:Knowledge] store: the ${STORE_SENTINEL} entry in "${bookName}" is not valid ` +
                `JSON (${err?.message}). Refusing to treat it as empty — fix or delete that entry. ` +
                `Writes are blocked until this is resolved.`
            );
            return s.data;
        }
    }

    // No store entry yet. Adopt the legacy chat_metadata values if any were
    // supplied, then persist so the migration is durable.
    const seeded = { ...blankStore(), ...(seed || {}) };
    scrubStoreGhosts(seeded);
    s.data = seeded;
    s.hydrated = true;
    s.dirty = false;

    const hasSeedData = Object.keys(seed || {}).some(k => {
        const v = seed[k];
        return v && typeof v === 'object' && Object.keys(v).length > 0;
    });
    if (hasSeedData) {
        console.log(`[MWT:Knowledge] store: migrating legacy chat metadata into "${bookName}".`);
        await flushBook(bookName);
    }
    return s.data;
}

/** Has this book's store been loaded into the cache? */
export function isHydrated(bookName) {
    return !!_cache.get(bookName)?.hydrated;
}

/**
 * Throw unless the book's store is loaded.
 *
 * Call this before any operation that could CREATE a lorebook entry. Reading an
 * un-hydrated (empty) registry reports every NPC as unknown, which is what
 * produces duplicate entries — so this converts a silent corruption into an
 * error the user can act on.
 *
 * @param {string} bookName
 * @param {string} [context] — what the caller was trying to do
 */
export function assertHydrated(bookName, context = 'write') {
    if (isHydrated(bookName)) return;
    throw new Error(
        `Knowledge store for "${bookName}" is not loaded yet — refusing to ${context}. ` +
        `Proceeding would treat every NPC as new and create duplicate lorebook entries. ` +
        `Reopen the chat, or check the console for an earlier store-load error.`
    );
}

/**
 * Read-only peek at a book's cached store slot (Diagnostics Phase 8).
 *
 * The Scope & storage tab reports hydration + store version per book, and the
 * existing accessors cannot answer that without side effects: `readField()`
 * INSTALLS its fallback into the store data, and `hydrateBook()` performs IO.
 * This is the one read-only view — it touches nothing, flushes nothing, and
 * never creates a cache slot for a book that has not been touched.
 *
 * @param {string} bookName
 * @returns {{ hydrated: boolean, dirty: boolean, version: number|null,
 *            fields: string[] }|null} — null when the book has no cache slot
 */
export function peekStore(bookName) {
    const s = _cache.get(bookName);
    if (!s) return null;
    return {
        hydrated: s.hydrated === true,
        dirty: s.dirty === true,
        version: typeof s.data?.version === 'number' ? s.data.version : null,
        fields: Object.keys(s.data ?? {}),
    };
}

// ─── Field access ───────────────────────────────────────────────────────────

/**
 * Read a field from a book's store, installing `fallback` when it is absent.
 *
 * Installing (rather than just returning) the fallback preserves the semantics
 * of the `chat_metadata` version this replaced: `getRegistry()` returned a
 * stable object that callers could mutate in place before calling save. Handing
 * back a fresh `{}` each time would silently drop those mutations.
 *
 * Installing does NOT mark the store dirty — an empty registry is not a change
 * worth writing, and if the book is not hydrated yet the value is replaced
 * wholesale by `hydrateBook` anyway.
 *
 * Safe to call before hydration; render paths rely on that.
 */
export function readField(bookName, field, fallback = {}) {
    const s = slot(bookName);
    const value = s.data[field];
    if (value === undefined || value === null) {
        s.data[field] = fallback;
        return fallback;
    }
    return value;
}

/**
 * Write a field into a book's store and schedule a flush.
 * The in-memory value updates synchronously so sync callers see it immediately.
 *
 * While a restore transaction owns the store (beginStoreTransaction), this is
 * deferred: the write is buffered and applied once the transaction settles, so
 * it cannot join the restore's flush or be erased by its rollback
 * The restore's own writes use _writeFieldDirect.
 */
export function writeField(bookName, field, value) {
    if (_storeTransaction) {
        _deferredWrites.push({ bookName, field, value });
        return;
    }
    const s = slot(bookName);
    s.data[field] = value;
    s.dirty = true;
    scheduleFlush(bookName);
}

/**
 * Write a field bypassing the transaction buffer. Used by the restore path so
 * its own writes apply to the live cache immediately while background writes are
 * deferred. @internal
 */
export function _writeFieldDirect(bookName, field, value) {
    const s = slot(bookName);
    s.data[field] = value;
    s.dirty = true;
    scheduleFlush(bookName);
}

/**
 * Capture complete cache slots before a multi-book operation. The restore path
 * uses this to ensure a failed transaction cannot be retried later by flushAll
 * with data it already reported as not committed.
 */
export function captureStoreState(bookNames) {
    const snapshot = new Map();
    for (const bookName of bookNames) {
        const s = _cache.get(bookName);
        if (!s) continue;
        snapshot.set(bookName, {
            data: JSON.parse(JSON.stringify(s.data)),
            dirty: s.dirty,
        });
    }
    return snapshot;
}

/**
 * Restore slots captured by captureStoreState(), including their dirty state.
 * `flushBooks` marks selected restored slots dirty so callers can durably undo
 * a preceding successful write without leaking the failed transaction later.
 */
export function restoreStoreState(snapshot, { flushBooks = [] } = {}) {
    const toFlush = new Set(flushBooks);
    for (const [bookName, saved] of snapshot || []) {
        const s = _cache.get(bookName);
        if (!s) continue;
        if (s.timer) { clearTimeout(s.timer); s.timer = null; }
        s.data = JSON.parse(JSON.stringify(saved.data));
        s.dirty = saved.dirty || toFlush.has(bookName);
        if (s.dirty) scheduleFlush(bookName);
    }
}

// ─── Flushing ───────────────────────────────────────────────────────────────

function scheduleFlush(bookName) {
    const s = slot(bookName);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
        s.timer = null;
        // Serialize the debounced flush with restore transactions and cache
        // resets an unguarded flush could interleave with
        // a restore's flush/rollback and re-persist cancelled data.
        withStoreLock(() => flushBook(bookName)).catch(err => {
            console.warn(`[MWT:Knowledge] store: flush of "${bookName}" failed:`, err?.message || err);
        });
    }, FLUSH_DEBOUNCE_MS);
}

/**
 * Write the cached store into an already-loaded world-info object, in place.
 *
 * This is the one function that actually renders the store into a book, and it
 * is synchronous by design. Every code path that saves a book calls it just
 * before `saveWorldInfo`, so the store always travels with whatever else is
 * being written.
 *
 * That matters because both this module and `writeToLorebook` do
 * load-modify-save on the SAME book. Without this, the two could interleave:
 *
 *   writeToLorebook loads v1 → store flush loads v1 →
 *   writeToLorebook saves v1+entry → store flush saves v1+store
 *
 * and the last write would silently drop the entry that had just been created.
 * Folding the store into the caller's own save removes the second writer.
 *
 * No-ops when the book has no cached store, so it is always safe to call.
 *
 * @param {string} bookName
 * @param {object} wi — a loaded world-info object (mutated in place)
 * @returns {boolean} whether a store entry was written
 */
export function applyStoreToWorldInfo(bookName, wi) {
    const s = _cache.get(bookName);
    if (!s || !wi || !wi.entries) return false;

    // `_note` is written for the benefit of anyone who stumbles across this
    // entry in the World Info editor, and stripped again on read so it never
    // accumulates in the cached data.
    const content = JSON.stringify({
        _note: 'MWT bookkeeping for this lorebook (NPC registry, relationships, state '
             + 'tracker registry). Never sent to the AI: it has no keywords and is '
             + 'disabled, non-constant, and non-vectorized — and MWT re-asserts those '
             + 'flags on every save. Deleting this entry resets the registry for this '
             + 'book, which can cause duplicate entries on the next scan.',
        ...s.data,
    });
    let entry = findStoreEntry(wi);

    if (!entry) {
        const uids = Object.keys(wi.entries).map(Number).filter(n => !Number.isNaN(n));
        const newUid = uids.length > 0 ? Math.max(...uids) + 1 : 0;
        entry = {
            uid: newUid,
            // No keywords: ST's world-info can never keyword-match this entry,
            // so it is structurally impossible for it to reach the prompt.
            key: [],
            keysecondary: [],
            comment: STORE_COMMENT,
            content,
            // Belt and braces on top of the empty keyword list.
            enabled: false, disable: true, constant: false, selective: false,
            order: 100, position: 0, addMemo: true,
            group: '', groupOverride: false, groupWeight: 100,
            sticky: null, cooldown: null, delay: null,
            probability: 100, useProbability: true, depth: 4,
            selectiveLogic: 0, excludeRecursion: true, preventRecursion: true,
            delayUntilRecursion: false, scanDepth: null, caseSensitive: null,
            matchWholeWords: null, useGroupScoring: null, automationId: '',
            role: null, vectorized: false, displayIndex: newUid,
        };
        wi.entries[newUid] = entry;
    } else {
        entry.content = content;
        // Repair an entry that was edited into an injecting state — by a user
        // poking at it in the World Info editor, or by an import that
        // normalised the flags.
        //
        // An empty keyword list only defeats KEYWORD matching. Two flags bypass
        // keywords entirely and must be re-asserted every write:
        //   constant   — injects unconditionally, keywords irrelevant
        //   vectorized — retrievable by embedding similarity (Vector Storage)
        entry.key = [];
        entry.keysecondary = [];
        entry.constant = false;
        entry.vectorized = false;
        entry.disable = true;
        entry.enabled = false;
        // Keep the title canonical: upgrades entries written before the
        // descriptive title existed, and undoes partial edits. The sentinel
        // prefix is this entry's identity, so it must not drift.
        entry.comment = STORE_COMMENT;
    }

    // Cancel the pending debounced flush but do NOT clear `dirty` — that is
    // the caller's job, AFTER its save resolves (see markStoreClean).
    //
    // Cancelling the timer here is still correct and must stay eager: the whole
    // point of folding the store into the caller's save is to remove the second
    // writer, so a debounced flush firing alongside it would reintroduce the
    // interleaving this function exists to prevent. Clearing `dirty` is a
    // different claim entirely — it asserts the data reached disk, which cannot
    // be true yet, because this function is synchronous and the save it is
    // being folded into has not been awaited.
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    return true;
}

/**
 * Mark a book's store as persisted. Call ONLY after the `saveWorldInfo` that
 * carried it has resolved successfully.
 *
 * A book that stays dirty is retried by the next {@link flushAll} (chat change,
 * reload) and re-armed by the next {@link writeField}, so a transient failure
 * costs a retry rather than the data.
 *
 * @param {string} bookName
 */
export function markStoreClean(bookName) {
    const s = _cache.get(bookName);
    if (s) s.dirty = false;
}

/**
 * Save a world-info book and wait for it to actually reach disk.
 *
 * ST's `saveWorldInfo(name, data)` does NOT write when called with two
 * arguments. It refreshes `worldInfoCache` synchronously, hands the write to a
 * module-level `saveWorldDebounced`, and returns — so awaiting it proves only
 * that a timer was armed. Two consequences follow, and both silently lose
 * writes:
 *
 *   1. `saveWorldDebounced` is ONE debounced function shared by every book, and
 *      ST's `debounce()` closes over a single timer that each call clears. Save
 *      book A and then book B inside the 1s window and A's write is discarded —
 *      never retried, never logged. `flushAll()` does exactly that: it awaits
 *      the Knowledge book and then the State book back to back.
 *   2. Any immediate save anywhere in ST runs `cancelDebounce(saveWorldDebounced)`
 *      first, which drops a pending write belonging to any book. So does a page
 *      reload inside the window.
 *
 * Meanwhile `worldInfoCache` already holds the new data, so every read for the
 * rest of the session looks correct and nothing appears wrong until a reload.
 * That is what "the profile is in the NPC Profiles lorebook but the registry
 * forgot its profileUid" looks like from the outside.
 *
 * The third argument makes ST await the actual POST. That is precisely what
 * {@link markStoreClean} and every `{ success: true }` in this module already
 * claim, so it is the only call form either of them is entitled to. Forks
 * predating the flag ignore the extra argument harmlessly.
 *
 * @param {object} wi$ — ST's world-info module
 * @param {string} bookName
 * @param {object} wi — the world-info object to write
 * @returns {Promise<void>}
 */
export async function saveBookNow(wi$, bookName, wi) {
    return wi$.saveWorldInfo(bookName, wi, true);
}

/**
 * Write a book's store back into its lorebook entry, creating the book if it
 * does not exist yet.
 *
 * @param {string} bookName
 * @returns {Promise<boolean>} whether the write succeeded
 */
export async function flushBook(bookName) {
    const s = _cache.get(bookName);
    if (!s) return false;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }

    const wi$ = await getWiScript();
    if (!wi$) return false;

    let wi = null;
    try {
        wi = await wi$.loadWorldInfo(bookName);
    } catch { /* handled below */ }

    if (!wi || !wi.entries) {
        if (typeof wi$.createNewWorldInfo === 'function') {
            // The Aikobots v4 fork returns a boolean here rather than the world
            // object, so always re-load instead of trusting the return value.
            try { await wi$.createNewWorldInfo(bookName); } catch { /* fall through */ }
        }
        try { wi = await wi$.loadWorldInfo(bookName); } catch { /* fall through */ }
        if (!wi || !wi.entries) wi = { entries: {} };
    }

    applyStoreToWorldInfo(bookName, wi);

    try {
        await saveBookNow(wi$, bookName, wi);
        markStoreClean(bookName);
        return true;
    } catch (err) {
        // `dirty` deliberately stays set: flushAll() retries on the next chat
        // change, and any writeField() re-arms the debounce. Marking it clean
        // here would strand the write in memory with only this warning.
        console.warn(`[MWT:Knowledge] store: save of "${bookName}" failed (will retry):`, err?.message || err);
        return false;
    }
}

/** Flush every dirty book. Await this before anything that could lose state. */
export function flushAll() {
    // Serialize with restore transactions and cache resets.
    return withStoreLock(async () => {
        const names = [..._cache.keys()].filter(name => _cache.get(name)?.dirty);
        for (const name of names) await flushBook(name);
    });
}

/**
 * Drop all cached stores.
 *
 * Called on chat change: the next chat may resolve to different books, and a
 * stale cache would serve one book's registry for another. Flushes pending
 * writes first so nothing is lost on the way out.
 */
export function resetStoreCache() {
    // Serialize with restore transactions: a reset that
    // interleaves a restore's flush/rollback can re-persist cancelled data or
    // clear the cache mid-rollback.
    return withStoreLock(async () => {
        try {
            const names = [..._cache.keys()].filter(name => _cache.get(name)?.dirty);
            for (const name of names) await flushBook(name);
        } catch { /* best effort — still clear below */ }
        for (const s of _cache.values()) {
            if (s.timer) clearTimeout(s.timer);
        }
        _cache.clear();
    });
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Hydrate the stores for the books the current scope resolves to.
 *
 * Call this on chat change, and await it before any scan. Legacy per-chat
 * values from `chat_metadata` are passed as the seed, so a user upgrading from
 * a pre-store version has their existing registry adopted by the book on first
 * load. Once the book has a store, the seed is ignored.
 *
 * The registry and relationships live in the Knowledge book; the state registry
 * lives in the State Tracker book. Each book therefore carries the data that
 * describes its own entries and stays portable on its own.
 *
 * @returns {Promise<{ knowledge: string, state: string }>} the books hydrated
 */
export async function hydrateCurrentBooks() {
    // Imported lazily: scope.js reads module settings, which are not available
    // in every context this file may be pulled into (e.g. unit tests).
    const { getLorebookName, getStateLorebookName } = await import('./scope.js');

    const knowledgeBook = getLorebookName();
    const stateBook = getStateLorebookName();
    const meta = getChatMeta() || {};

    // Legacy chat_metadata describes entries in the GLOBAL books, so only the
    // global books may adopt it.
    //
    // Seeding a SCOPED book from it would copy a registry whose uids point into
    // a different book. `writeToLorebook` trusts a registry uid: if an entry
    // exists at that uid here it takes the update branch — so the first write
    // after switching scope would overwrite whatever happens to occupy that
    // uid in the new book. On a freshly created book that is the [MWT:store]
    // entry itself, which would be rewritten as an NPC entry complete with
    // keywords. A scoped book must start empty and build its own registry.
    const knowledgeSeed = knowledgeBook === LOREBOOK_NAME
        ? { registry: meta[REGISTRY_KEY] || {}, relationships: meta[RELATIONSHIP_KEY] || {} }
        : {};
    const stateSeed = stateBook === STATE_LOREBOOK_NAME
        ? { stateRegistry: meta[STATE_REGISTRY_KEY] || {} }
        : {};

    await hydrateBook(knowledgeBook, knowledgeSeed);
    await hydrateBook(stateBook, stateSeed);

    return { knowledge: knowledgeBook, state: stateBook };
}

/** Test seam: synchronously seed the cache without touching a lorebook. */
export function _setCacheForTests(bookName, data) {
    const s = slot(bookName);
    s.data = { ...blankStore(), ...data };
    s.hydrated = true;
    s.dirty = false;
}

/** Test seam: clear the cache without flushing. */
export function _clearCacheForTests() {
    for (const s of _cache.values()) {
        if (s.timer) clearTimeout(s.timer);
    }
    _cache.clear();
}
