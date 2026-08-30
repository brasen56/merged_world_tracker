/**
 * backup/recovery.js — The §5.3 minimum recovery surface (schema plan Part 5).
 *
 * Quarantined records are never deleted and never injected; they are preserved
 * whole so they can be repaired and brought back through the normal, checked
 * path. This module is the user-facing half of that promise:
 *
 *   - collectQuarantineStatus() — the list/count of quarantined records per
 *     store (Scope & storage displays it; nothing here mutates anything);
 *   - exportRecoveryData() — the "Download recovery data" JSON action. The
 *     export carries every item's store, path, reasonCode, message, raw
 *     record, sourceVersion, detectedAt, and fingerprint — enough metadata to
 *     edit a record externally and re-import it through the validated
 *     backup/import path (a restore merges envelope.quarantine tolerantly and
 *     can never be blocked by it, backup/validate.js);
 *   - clearQuarantineData() — the explicit clear with confirmation. Console-
 *     only by design (§5.3: "preferably console-only until a mutating recovery
 *     UI is designed"): `MWT.recovery.clear({ confirm: 'CLEAR' })`. The
 *     literal token is the confirmation — a dialog could be dismissed, a typed
 *     argument cannot be fat-fingered into existence.
 *
 * Where the records live (design §5.1): chat-local stores keep theirs in the
 * `mwt_schema_quarantine` chat-metadata container; the Knowledge lorebook
 * store keeps its INSIDE each book's [MWT:store] entry (a chat-local container
 * cannot correctly own per-book records). Both are read here; both are
 * exported; the clear covers both (the embedded clear is opt-in because it
 * rewrites the lorebook store).
 *
 * Barrel imports (core/index.js) for the IO seams on purpose: under Vitest the
 * barrel is aliased to test/stubs/core.js, so downloadJson/notify land in the
 * fake capture lists the tests assert against. Schema/pause singletons are
 * imported directly, the backup/* convention.
 */

import { downloadJson, getChatMeta, notify, persistChatMeta } from '../core/index.js';
import {
    exportQuarantineData,
    QUARANTINE_METADATA_KEY,
    QUARANTINE_SCHEMA_VERSION,
    validateQuarantineStoreData,
} from '../core/quarantine.js';
import { recordSchemaEvent, SCHEMA_DIAGNOSTIC_EVENTS } from '../core/schema_status.js';
import {
    clearStoreQuarantine,
    getHydratedBooks,
    getStoreQuarantineItems,
} from '../knowledge/store.js';

// ─── Reading ─────────────────────────────────────────────────────────────────

/**
 * Read the chat-local quarantine container TOLERANTLY. This is a read for
 * display/export, not a persistence gate: a malformed container still yields
 * every item that can be read, plus a `containerIssues` count so a broken
 * container is never silently reported as fewer records than it holds.
 *
 * A container written by a NEWER MWT is the one case validation refuses to
 * rewrite: it comes back UNCHANGED (§3.5 cat 4), so `items` is not guaranteed
 * to exist or be an array. Callers therefore get an array-safe view (the
 * unreadable container reads as no items) plus an explicit `unknown` marker,
 * so a future-version container is never mistaken for an empty one — its
 * records exist, this build just cannot read them.
 *
 * @param {object} [meta] chat metadata (default: live)
 * @returns {{ present: boolean, items: object[], containerIssues: number, unknown: boolean }}
 */
export function readChatQuarantineContainer(meta = getChatMeta()) {
    const raw = meta?.[QUARANTINE_METADATA_KEY];
    if (raw === undefined || raw === null) {
        return { present: false, items: [], containerIssues: 0, unknown: false };
    }
    const validated = validateQuarantineStoreData(raw);
    const containerIssues = validated.issues.filter(
        (issue) => issue.severity === 'quarantine' || issue.severity === 'fatal',
    ).length;
    const unknown = validated.issues.some((issue) => issue.code === 'future-version');
    return {
        present: true,
        items: Array.isArray(validated.data.items) ? validated.data.items : [],
        containerIssues,
        unknown,
    };
}

/**
 * Every quarantined record this chat/session can see: the chat-local container
 * plus each hydrated lorebook book's embedded container (§5.1's two homes),
 * deduplicated by content fingerprint (the same record detected through both
 * homes exports once).
 *
 * @returns {object[]} quarantine items (makeQuarantineItem shape)
 */
export function collectRecoveryItems() {
    const chat = readChatQuarantineContainer();
    const embedded = [];
    for (const bookName of getHydratedBooks()) {
        // Tolerant per-book read: a book whose container this build must refuse
        // reads as no items — its records stay in the book, and the book's own
        // banner/quarantine path is what surfaces that refusal.
        embedded.push(...getStoreQuarantineItems(bookName));
    }
    const seen = new Set();
    const merged = [];
    for (const item of [...chat.items, ...embedded]) {
        const id = typeof item?.id === 'string' ? item.id : `${item?.store}:${JSON.stringify(item?.raw)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(item);
    }
    return merged;
}

/**
 * The list/count of quarantined records per store (§5.3 item 1). Read-only.
 *
 * @returns {{
 *   generatedAt: number,
 *   stores: Array<{ id: string, count: number, embedded: boolean }>,
 *   total: number,
 *   chatContainer: { present: boolean, items: number, containerIssues: number, unknown: boolean },
 *   knowledgeBooks: string[],
 * }}
 */
export function collectQuarantineStatus({ now = Date.now } = {}) {
    const chat = readChatQuarantineContainer();
    const books = getHydratedBooks();
    const perStore = new Map();
    const add = (id, embedded) => {
        const entry = perStore.get(id) ?? { id, count: 0, embedded };
        entry.count += 1;
        perStore.set(id, entry);
    };
    for (const item of chat.items) {
        if (item && typeof item === 'object') add(String(item.store ?? 'unknown'), false);
    }
    for (const bookName of books) {
        for (const item of getStoreQuarantineItems(bookName)) {
            if (item && typeof item === 'object') add(String(item.store ?? 'knowledgeStore'), true);
        }
    }
    const stores = [...perStore.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    return {
        generatedAt: now(),
        stores,
        total: stores.reduce((sum, s) => sum + s.count, 0),
        chatContainer: {
            present: chat.present,
            items: chat.items.length,
            containerIssues: chat.containerIssues,
            unknown: chat.unknown,
        },
        knowledgeBooks: books,
    };
}

// ─── Export (§5.3 — "Download recovery data") ────────────────────────────────

/**
 * Build + download the recovery export: a `mwt-quarantine-export` envelope
 * (core/quarantine.js) carrying every quarantined record this chat/session can
 * see, with the metadata needed to repair a record externally and re-import it
 * through the validated backup/import path.
 *
 * A download with ZERO records is refused with `empty: true` — a recovery file
 * that contains nothing implies recovery data exists to download, and a user
 * pressing the button after a clear would otherwise "recover" an empty box.
 *
 * A chat container written by a NEWER MWT is refused with `unreadable: true`
 * and a `message` REGARDLESS of how many readable records exist elsewhere:
 * its records cannot enter the file, and an export missing them would present
 * itself as complete while silently omitting them — the §5.3 contract says
 * EVERY quarantined record is included, so nothing is downloaded at all.
 *
 * @param {object} [options]
 * @param {boolean} [options.download=true] — download via downloadJson(); the
 *        envelope is returned either way (the console tool prints it)
 * @param {string} [options.filename]
 * @returns {{ ok: boolean, empty?: boolean, unreadable?: boolean, message?: string,
 *            exportedAt: number, count: number, filename?: string, data?: object }}
 */
export function exportRecoveryData({ download = true, filename } = {}) {
    const items = collectRecoveryItems();
    const chat = readChatQuarantineContainer();
    const exportedAt = Date.now();
    // The unreadable-container refusal runs BEFORE the zero-count check. A
    // container a newer MWT wrote (it validates back unchanged, §3.5 cat 4)
    // may hold records this build cannot read, so `items` cannot contain them
    // no matter what else it holds: Knowledge quarantine records can exist
    // alongside the unreadable chat container, and an export carrying only
    // those would download a file that looks complete while silently omitting
    // the rest. The §5.3 contract says every quarantined record is in the
    // file, so nothing is downloaded at all — and the message says how many
    // readable records were held back with it, never "nothing was rejected".
    if (chat.unknown) {
        return {
            ok: false,
            empty: true,
            unreadable: true,
            exportedAt,
            count: 0,
            message: 'Refused: the chat recovery container was written by a NEWER version of MWT, so its records cannot be read or exported by this build. They are preserved unchanged — upgrade MWT to export them, or remove the whole container with MWT.recovery.clear({ confirm: \'CLEAR\' }).'
                + (items.length > 0
                    ? ` The ${items.length} readable quarantined record(s) this build CAN see (for example the Knowledge lorebook store's) were not exported either — a recovery file missing the unreadable ones would present itself as complete.`
                    : ''),
        };
    }
    const data = exportQuarantineData(items, { exportedAt });
    if (items.length === 0) {
        return { ok: false, empty: true, exportedAt, count: 0 };
    }
    const name = filename
        || `mwt-recovery-${new Date(exportedAt).toISOString().replace(/[:.]/g, '-')}.json`;
    if (download) downloadJson(name, data);
    recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.QUARANTINED, {
        // The export event, not a new detection: count says what left the
        // machine in a recovery file.
        reasonCode: 'recovery-export',
        count: items.length,
    }, { level: 'info' });
    try {
        notify('MWT: recovery data downloaded', `${items.length} quarantined record(s) exported. Repair them outside MWT and re-import through Backup → Restore — the checked path validates them like any other data.`, 'info');
    } catch { /* never block the export on a toast */ }
    return { ok: true, exportedAt, count: items.length, filename: name, data };
}

// ─── Clear (§5.3 — explicit, confirmed, console-only) ────────────────────────

/** The literal confirmation token clearQuarantineData() requires. */
export const QUARANTINE_CLEAR_CONFIRM = 'CLEAR';

/**
 * Clear quarantined records. CONSOLE-ONLY by design (§5.3) until a mutating
 * recovery UI exists: call as `MWT.recovery.clear({ confirm: 'CLEAR' })`.
 *
 * Scope of the clear:
 *   - default: the chat-local `mwt_schema_quarantine` container (all
 *     chat-metadata stores' records). Pass `store` to clear only one store's
 *     items and keep the rest; an emptied container key is removed entirely.
 *     A FILTERED clear is refused (`quarantine-version-future` /
 *     `quarantine-container-invalid`) when the container's validation reports
 *     a future, fatal, or quarantine-level finding: the rewrite works from
 *     the canonical items, which can omit malformed ones, so refusing is the
 *     only way a per-store clear cannot delete other stores' records. The
 *     container is left exactly as it was; an unfiltered clear stays allowed
 *     (deleting the whole container is what was confirmed, so it is removed
 *     whole WITHOUT parsing it — even when a newer MWT wrote it and this
 *     build cannot read it). `clearedRecords` therefore counts the records
 *     this build could read; an unreadable container clears as 0 + a note.
 *   - `includeKnowledgeStore: true`: ALSO empty each hydrated book's embedded
 *     container (durably flushed through the store). Un-hydrated books hold
 *     their records untouched.
 *
 * A refused embedded container (written by a newer MWT) is left unchanged and
 * reported; the chat-local clear still proceeds — the two homes are
 * independent.
 *
 * @param {object} [options]
 * @param {string} [options.confirm] — must be the literal 'CLEAR'
 * @param {string} [options.store] — restrict the chat-local clear to one store id
 * @param {boolean} [options.includeKnowledgeStore] — also clear embedded containers
 * @returns {Promise<{ ok: boolean, reason?: string, clearedRecords: number,
 *            chatContainerCleared: boolean, knowledgeBooks: Array<object>, message?: string }>}
 */
export async function clearQuarantineData({
    confirm,
    store,
    includeKnowledgeStore = false,
} = {}) {
    if (confirm !== QUARANTINE_CLEAR_CONFIRM) {
        return {
            ok: false,
            reason: 'confirmation-required',
            clearedRecords: 0,
            chatContainerCleared: false,
            knowledgeBooks: [],
            message: `Refused: pass { confirm: '${QUARANTINE_CLEAR_CONFIRM}' } to clear quarantined records. Run MWT.recovery.status() first — clearing DELETES the only in-MWT copy of every rejected record. Export them (MWT.recovery.export()) before clearing.`,
        };
    }

    const meta = getChatMeta();
    const result = {
        ok: true,
        clearedRecords: 0,
        chatContainerCleared: false,
        knowledgeBooks: [],
    };
    let unknownContainerCleared = false;

    if (meta) {
        const raw = meta[QUARANTINE_METADATA_KEY];
        if (raw !== undefined && raw !== null) {
            if (store) {
                const validated = validateQuarantineStoreData(raw);
                // A FILTERED clear rewrites the container from its CANONICAL
                // items — but canonical validation is deliberately lossy: a
                // malformed item is reported and omitted, and a container a
                // NEWER MWT wrote comes back untouched (§3.5 cat 4). Rewriting
                // either would silently delete records that may belong to
                // OTHER stores, or downgrade a future-version container — so
                // the same findings that gate every other container write
                // (core/metadata.js, the embedded merge) gate this one.
                const futureIssue = validated.issues.find((issue) => issue.code === 'future-version');
                const lossyIssue = futureIssue
                    ? undefined
                    : validated.issues.find((issue) => issue.severity === 'quarantine' || issue.severity === 'fatal');
                const issue = futureIssue ?? lossyIssue;
                if (issue) {
                    return {
                        ok: false,
                        reason: futureIssue ? 'quarantine-version-future' : 'quarantine-container-invalid',
                        clearedRecords: 0,
                        chatContainerCleared: false,
                        knowledgeBooks: [],
                        message: `Refused: the chat quarantine container cannot be safely filtered (${issue.message}) It was left unchanged — a per-store clear rewrites the container, and records this build cannot read could be lost. Run MWT.recovery.status() and MWT.recovery.export() first, or clear everything without a store filter.`,
                    };
                }
                const keep = validated.data.items.filter((item) => item?.store !== store);
                const removed = validated.data.items.length - keep.length;
                if (keep.length === 0) {
                    delete meta[QUARANTINE_METADATA_KEY];
                } else {
                    meta[QUARANTINE_METADATA_KEY] = {
                        version: QUARANTINE_SCHEMA_VERSION,
                        items: keep,
                    };
                }
                result.clearedRecords += removed;
                result.chatContainerCleared = removed > 0;
            } else {
                // The UNFILTERED delete-all removes the confirmed container
                // WITHOUT parsing it: canonical validation returns a
                // future-version container unchanged (§3.5 cat 4), so
                // validated.data.items is not guaranteed to exist — and
                // reading the records is not needed to delete the whole thing.
                // The readable count is reported when available (0 for an
                // unreadable container — the deletion itself is what was
                // confirmed).
                const container = readChatQuarantineContainer(meta);
                unknownContainerCleared = container.unknown;
                delete meta[QUARANTINE_METADATA_KEY];
                result.clearedRecords += container.items.length;
                result.chatContainerCleared = true;
            }
            // Debounced persist is deliberate: a debounce dropped by a fast chat
            // switch leaves the records in place — the safe direction for a clear.
            persistChatMeta();
        }
    }

    if (includeKnowledgeStore) {
        for (const bookName of getHydratedBooks()) {
            const before = getStoreQuarantineItems(bookName).length;
            const cleared = await clearStoreQuarantine(bookName);
            result.knowledgeBooks.push({
                book: bookName,
                ok: cleared.ok,
                reason: cleared.reason ?? null,
                cleared: cleared.cleared,
            });
            if (cleared.ok && cleared.cleared) result.clearedRecords += before;
            if (!cleared.ok) result.ok = false;
        }
    }

    recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.QUARANTINE_CLEARED, {
        count: result.clearedRecords,
        reasonCode: store ?? 'all',
    }, { level: 'warn' });
    try {
        notify(
            'MWT: quarantine cleared',
            `${result.clearedRecords} quarantined record(s) cleared — cleared records are gone from MWT. Export first if you ever need them back.` +
            (unknownContainerCleared
                ? ' An unreadable (newer-MWT) chat recovery container was also removed whole; its records could not be read or counted by this build.'
                : ''),
            'info',
        );
    } catch { /* never block the clear on a toast */ }
    return result;
}
