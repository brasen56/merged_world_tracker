/**
 * diagnostics_panel/schema_status.js — Schema status for the 🗂️ Scope &
 * storage tab (design §9.1, schema plan Part 5).
 *
 * One DOM-free, read-only collector answering "what state is every store's
 * SCHEMA in right now?": stored version vs. current supported version, the
 * pure fast-gate classification (ready / prepare / blocked / unknown / absent),
 * whether a migration was persisted, the quarantined-record count, BOTH
 * Knowledge lorebook stores' (Knowledge + State Tracker books) hydration +
 * versions, and — for a blocked or
 * paused store — the SAME plain-language reason the module's own banner shows
 * (§5.4: the two surfaces read one registry and can never disagree).
 *
 * Everything O(stores): the gate classifies from the manifest marker + root
 * TYPE only (schema/gate.js — the §7.1 two-level split), and the quarantine
 * count is a container read. Deep validation stays on the Integrity tab's
 * on-demand button; nothing here walks records.
 *
 * READ-ONLY BOUNDARY (§9.1): this snapshot DISPLAYS state. Retry, repair, and
 * quarantine-clear actions live in the affected module's own tab / the
 * MWT.recovery console namespace — never in the Diagnostics panel.
 *
 * DOM-free by design (the Phase 6 health.js pattern): plain-object snapshot,
 * markup in diagnostics_panel/render.js, every dependency injectable, every
 * accessor guarded. Direct imports for core singletons (NOT the core barrel —
 * the test-only alias trap, §II.3).
 */

import { MWT_VERSION } from '../core/version.js';
import { getChatMeta } from '../core/context.js';
import { redactForReport } from '../core/redaction.js';
// Live secret VALUES for the scrub list (the integrity.js cycle pattern — safe
// because both sides only reference the other's bindings inside function
// bodies). Returns [] with no SillyTavern runtime, keeping this testable in
// Node.
import { collectKnownSecrets } from './report.js';
// The pure fast gate + the registry (§9.2's "enumerate from schema/registry.js,
// not a second list" applies here too — the row list IS the registry's).
import { runFastLoadGate } from '../schema/gate.js';
import { CHAT_METADATA_SCHEMA_IDS, STORE_SCHEMAS } from '../schema/registry.js';
import { MANIFEST_METADATA_KEY } from '../schema/manifest.js';
// The pause registry (§5.4) and the quarantine container read (§5.3).
import { getPausedStores, isPauseForCurrentScope } from '../core/schema_status.js';
import { readChatQuarantineContainer } from '../backup/recovery.js';
// The read-only book resolver (the explainBookResolution() mirror's two-book
// wrapper) — its one-owner home is knowledge/scope.js (beside the resolver it
// mirrors), shared with backup/recovery.js's §5.3 completeness guard, so this
// tab's book rows and the recovery export inspect the same books.
import { resolveKnowledgeBooks } from '../knowledge/scope.js';
import { peekStore, peekStoreData } from '../knowledge/store.js';
import { knowledgeStoreSchema } from '../knowledge/schema.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Presentation labels for the registry store ids (order = registry order). */
export const SCHEMA_STATUS_LABELS = Object.freeze({
    worldState: '🌍 World State',
    chronicle: '📜 Chronicle',
    knowledgeEvidence: '🧠 Knowledge evidence',
    knowledgeCounters: '🧠 Knowledge counters',
    storyPlanner: '🗺️ Story Planner',
    interiority: '🎭 Interiority',
    knowledgeStore: '🧠 Knowledge lorebook store',
});

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect the schema-status snapshot. Read-only, synchronous, O(stores).
 *
 * Every dependency is injectable and every accessor is individually guarded —
 * one throwing dependency degrades its own field plus an `errors` note, never
 * the snapshot (the health.js contract).
 *
 * @param {object} [deps]
 * @param {function(): number} [deps.now]
 * @param {string} [deps.version]
 * @param {function(): object} [deps.chatMeta] — live chat metadata
 * @param {function(object, object): object} [deps.gate] — runFastLoadGate
 * @param {function(): Array} [deps.pausedStores] — getPausedStores
 * @param {function(object): {items: object[]}} [deps.quarantine] — container read
 *        (readChatQuarantineContainer's { present, items[], containerIssues,
 *        unknown } shape; a bare { items } view is tolerated)
 * @param {object} [deps.knowledge] — { books(), peek(name), peekData(name), currentVersion }
 * @returns {object} the snapshot (see renderSchemaStatusSnapshot)
 */
export function collectSchemaStatusSnapshot({
    now = Date.now,
    version = MWT_VERSION,
    chatMeta = getChatMeta,
    gate = runFastLoadGate,
    pausedStores = getPausedStores,
    quarantine = readChatQuarantineContainer,
    knowledge = {
        books: resolveKnowledgeBooks,
        peek: peekStore,
        peekData: peekStoreData,
        currentVersion: knowledgeStoreSchema.currentVersion,
    },
} = {}) {
    const errors = [];
    const call = (label, fn, fallback) => {
        try {
            const value = fn();
            return value === undefined ? fallback : value;
        } catch (err) {
            errors.push(`${label}: ${String(err?.message || err)}`);
            return fallback;
        }
    };

    /** Bare "nothing here" container view (readChatQuarantineContainer shape). */
    const emptyQuarantineView = { present: false, items: [], containerIssues: 0, unknown: false };

    const meta = call('chatMeta', () => chatMeta() ?? {}, {});
    const paused = call('pausedStores', () => (pausedStores() ?? []).filter(isPauseForCurrentScope), []);
    const pauseFor = (storeId) => paused.find((pause) => pause.store === storeId) ?? null;

    // The chat-metadata stores, enumerated from the registry (§9.1/§9.2).
    const manifest = meta[MANIFEST_METADATA_KEY];
    const storeRoots = {};
    for (const id of CHAT_METADATA_SCHEMA_IDS) {
        storeRoots[id] = meta[STORE_SCHEMAS[id].metadataKey];
    }
    const gateResult = call('gate', () => gate({ manifest, stores: storeRoots }), null) ?? {
        manifestVersion: null,
        manifestFromFuture: false,
        stores: {},
        allReady: false,
    };

    const chatQuarantine = call('quarantine', () => quarantine(meta) ?? emptyQuarantineView, emptyQuarantineView);
    // The container's OWN state rides along (§5.3): an unreadable (newer-MWT)
    // or malformed container reads as zero items, and that zero must never be
    // presented downstream as "no recovery data exists" — it is a floor, not a
    // measurement. Read defensively: an injected dep may return a bare
    // { items } view.
    const quarantineItems = Array.isArray(chatQuarantine.items) ? chatQuarantine.items : [];
    const chatQuarantineState = {
        present: chatQuarantine.present === true,
        items: quarantineItems.length,
        containerIssues: Number(chatQuarantine.containerIssues) || 0,
        unknown: chatQuarantine.unknown === true,
    };
    const quarantineCountFor = (storeId) => quarantineItems
        .filter((item) => item && typeof item === 'object' && item.store === storeId)
        .length;

    const rows = CHAT_METADATA_SCHEMA_IDS.map((id) => {
        const descriptor = STORE_SCHEMAS[id];
        const gateEntry = gateResult.stores[id] ?? {
            state: 'unknown', present: false, version: null, reason: 'gate-missing',
        };
        const pause = pauseFor(id);
        return {
            id,
            label: SCHEMA_STATUS_LABELS[id] ?? id,
            key: descriptor.metadataKey,
            present: gateEntry.present === true,
            // What the manifest stamps (null = not stamped / not applicable).
            storedVersion: gateEntry.version ?? null,
            currentVersion: descriptor.currentVersion,
            // ready | prepare | blocked | unknown (absent stores keep their
            // gate classification and render dim).
            state: gateEntry.state,
            reason: gateEntry.reason ?? null,
            // A persisted migration is exactly "the manifest stamps the
            // current version for a present store" — version 0/missing means
            // the chat is still legacy and its migration has not run.
            migrationPersisted: gateEntry.present === true
                && gateEntry.state === 'ready'
                && gateEntry.version === descriptor.currentVersion,
            quarantineCount: quarantineCountFor(id),
            paused: pause ? {
                reasonCode: pause.reasonCode,
                message: pause.message,
                since: pause.since,
            } : null,
        };
    });

    // The Knowledge lorebook store: its version lives INSIDE each book's
    // store entry (not the manifest), and its state is the cache's hydration
    // state — the gate deliberately does not cover it (schema/gate.js §7.4).
    // The store spans BOTH books (Knowledge + State Tracker): each resolved
    // book gets its own inspection, and the aggregate keeps the store-level
    // pause (one store id, §5.4) plus the scalars the console bridge prints.
    const books = call('knowledge.books', () => knowledge.books?.() ?? null, null);
    const bookRows = [];
    for (const book of (Array.isArray(books?.books) ? books.books : [])) {
        const name = typeof book?.name === 'string' && book.name ? book.name : null;
        if (!name) continue;
        const peek = call(`knowledge.peek:${name}`, () => knowledge.peek?.(name) ?? null, null);
        bookRows.push({
            book: name,
            role: book.role === 'state' ? 'state' : 'knowledge',
            present: peek !== null,
            // not-attempted (no cache slot) vs failed (slot exists, load
            // blocked) are different states — peekStore's distinction,
            // preserved verbatim.
            hydration: peek === null
                ? 'not-attempted'
                : (peek.hydrated === true ? 'loaded' : 'failed'),
            // A FAILED slot's `version` is the blank placeholder's —
            // hydrateBook never adopts the blocked source into the cache, so
            // an on-disk v99 store would otherwise render "1 / 1" beside its
            // future-version pause. The slot separately preserves the version
            // observed on disk at the failure (peekStore's observedVersion,
            // null when it could not be read); that — or null — is what a
            // failed book reports, never the placeholder.
            storedVersion: peek !== null && peek.hydrated !== true
                ? (typeof peek.observedVersion === 'number' ? peek.observedVersion : null)
                : (typeof peek?.version === 'number' ? peek.version : null),
            currentVersion: typeof knowledge.currentVersion === 'number' ? knowledge.currentVersion : null,
            quarantineCount: call(`knowledge.quarantine:${name}`, () => {
                const data = knowledge.peekData?.(name);
                const items = data?.quarantine?.items;
                return Array.isArray(items) ? items.length : 0;
            }, 0),
        });
    }
    if (bookRows.length === 0) {
        // Resolution degraded (or neither book name could be derived): keep
        // one anonymous row so the store still appears — 'not-attempted', the
        // ordinary early state, never a fault.
        bookRows.push({
            book: null,
            role: 'knowledge',
            present: false,
            hydration: 'not-attempted',
            storedVersion: null,
            currentVersion: typeof knowledge.currentVersion === 'number' ? knowledge.currentVersion : null,
            quarantineCount: 0,
        });
    }
    const knowledgePause = pauseFor('knowledgeStore');
    const primary = bookRows.find((b) => b.role === 'knowledge') ?? bookRows[0];
    const knowledgeRow = {
        id: 'knowledgeStore',
        label: SCHEMA_STATUS_LABELS.knowledgeStore,
        key: '(inside the lorebook [MWT:store] entry)',
        present: bookRows.some((b) => b.present),
        // Primary (Knowledge) book name — the console bridge prints it.
        book: primary.book,
        // One entry per resolved book — the store spans both (§5.1).
        books: bookRows,
        // Aggregate hydration for the banner/bridge: any failed book fails
        // the store; 'loaded' only when every resolved book loaded.
        hydration: bookRows.some((b) => b.hydration === 'failed') ? 'failed'
            : (bookRows.every((b) => b.hydration === 'loaded') ? 'loaded' : 'not-attempted'),
        storedVersion: primary.storedVersion,
        currentVersion: typeof knowledge.currentVersion === 'number' ? knowledge.currentVersion : null,
        quarantineCount: bookRows.reduce((sum, b) => sum + b.quarantineCount, 0),
        paused: knowledgePause ? {
            reasonCode: knowledgePause.reasonCode,
            message: knowledgePause.message,
            since: knowledgePause.since,
        } : null,
    };

    // Warnings drive the pane's verdict. A PAUSED or BLOCKED store is the
    // fail-level state (§5.4: unmistakable, never ordinary inactivity); a
    // future manifest is warn (every present store renders unknown below it).
    const warnings = [];
    for (const row of rows) {
        if (row.paused) {
            warnings.push({
                id: `store-paused:${row.id}`,
                level: 'fail',
                text: `${row.label} is PAUSED — ${row.paused.message || row.paused.reasonCode}`,
            });
        } else if (row.state === 'blocked') {
            warnings.push({
                id: `store-blocked:${row.id}`,
                level: 'fail',
                text: `${row.label} is BLOCKED (${row.reason}) — its saved data is at a version this build cannot safely read (v${row.storedVersion ?? '?'} vs supported v${row.currentVersion}). The store was left untouched. Upgrade MWT to read it.`,
            });
        }
    }
    if (knowledgeRow.paused) {
        warnings.push({
            id: 'store-paused:knowledgeStore',
            level: 'fail',
            text: `${knowledgeRow.label} is PAUSED — ${knowledgeRow.paused.message || knowledgeRow.paused.reasonCode}`,
        });
    } else {
        // One warning per FAILED book, naming the book — the store spans
        // both, and either one failing blocks Knowledge writes.
        for (const book of knowledgeRow.books) {
            if (book.hydration !== 'failed') continue;
            warnings.push({
                id: `knowledge-store-failed${book.book ? `:${book.book}` : ''}`,
                level: 'fail',
                text: `${knowledgeRow.label} failed to load${book.book ? ` ("${book.book}")` : ''} — Knowledge writes are blocked, and the module banner in its own tab carries the reason.`,
            });
        }
    }
    if (gateResult.manifestFromFuture) {
        warnings.push({
            id: 'manifest-from-future',
            level: 'warn',
            text: `This chat's schema manifest was written by a NEWER MWT, so no store's version marker can be trusted either way — every present store reads <unknown> and stays untouched until an upgrade reads it.`,
        });
    }
    // A container this build cannot fully read must never let the panel assert
    // that recovery data is absent or completely counted (§5.3's "never
    // silently reported as fewer records than it holds"). The future-version
    // container is the canonical case; a malformed container is the same
    // hazard at ZERO readable items — and at ONE OR MORE readable items the
    // malformed entries were DROPPED by validation, so the displayed count is
    // a lower bound the snapshot must not present as a total.
    if (chatQuarantineState.unknown) {
        warnings.push({
            id: 'chat-quarantine-unreadable',
            level: 'warn',
            text: `This chat's recovery (quarantine) container was written by a NEWER version of MWT, so it may hold quarantined records this build cannot read — the 0 counts in the table cannot rule them out. Nothing was deleted: the records are preserved unchanged, and upgrading MWT reads and exports them.`,
        });
    } else if (chatQuarantineState.containerIssues > 0) {
        warnings.push(chatQuarantineState.items > 0 ? {
            id: 'chat-quarantine-container-invalid',
            level: 'warn',
            text: `This chat's recovery (quarantine) container is malformed: ${chatQuarantineState.items} record(s) could be read, but entries this build could not read were dropped by validation — the counts in the table are a known minimum, and the container may hold additional unreadable records. Nothing was deleted; the container is preserved whole.`,
        } : {
            id: 'chat-quarantine-container-invalid',
            level: 'warn',
            text: `This chat's recovery (quarantine) container is malformed, so it may hold quarantined records this build could not read — the 0 counts in the table cannot rule them out. Nothing was deleted; the container is preserved whole.`,
        });
    }

    const bannerLevel = warnings.some((w) => w.level === 'fail') ? 'fail'
        : (warnings.length > 0 ? 'warn' : 'ok');

    const totals = {
        // Both Knowledge-store books count: the store spans them (§5.1), so
        // totals omit the State Tracker book's state unless aggregated here.
        stores: rows.length + knowledgeRow.books.length,
        present: rows.filter((r) => r.present).length + knowledgeRow.books.filter((b) => b.present).length,
        // A LOADED book counts as ready: hydration prepares the store through
        // the schema engine and persists any migration BEFORE the slot becomes
        // hydrated, so a loaded book is at the current version by construction
        // (an un-persistable migration blocks the load → 'failed' → blocked
        // below). That is also why `preparing` deliberately gains NO book term
        // — a book can never sit between versions. Before this fix a healthy
        // book pair rendered beside "0 ready · 0 to migrate · 0 blocked" while
        // `blocked` counted a failed book: a book could appear on the blocked
        // side of the banner but never the ready side.
        ready: rows.filter((r) => r.state === 'ready' && r.present).length
            + knowledgeRow.books.filter((b) => b.hydration === 'loaded').length,
        preparing: rows.filter((r) => r.state === 'prepare').length,
        blocked: rows.filter((r) => r.state === 'blocked').length
            + knowledgeRow.books.filter((b) => b.hydration === 'failed').length,
        paused: paused.length,
        quarantine: rows.reduce((sum, r) => sum + r.quarantineCount, 0) + knowledgeRow.quarantineCount,
    };

    return {
        generatedAt: now(),
        mwtVersion: version,
        manifestVersion: gateResult.manifestVersion,
        manifestFromFuture: gateResult.manifestFromFuture === true,
        bannerLevel,
        warnings,
        rows,
        knowledgeStore: knowledgeRow,
        // The chat container's own state (see the collector note above): the
        // per-row counts are only a floor when unknown/containerIssues say the
        // container could not be fully read.
        chatQuarantine: chatQuarantineState,
        totals,
        ...(errors.length ? { errors } : {}),
    };
}

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * Normalise a schema-status snapshot for SAFE return/render (the Phase 5
 * contract: every surface routes through core/redaction.js). The snapshot is
 * metadata by construction — ids, versions, counts, reason codes, and
 * module-authored banner messages; quarantined record CONTENT never enters it
 * (§9.2). Strings are still Rule-1b secret-scrubbed. The input is never
 * mutated; the output shares no references with it.
 *
 * @param {object} snapshot — collectSchemaStatusSnapshot() output
 * @param {object} [opts]
 * @param {boolean} [opts.includeContent=false] — accepted for signature parity
 * @param {string[]} [opts.knownSecrets] — live secret VALUES
 * @returns {object} a redacted deep copy
 */
export function redactSchemaStatusSnapshot(snapshot, { includeContent = false, knownSecrets } = {}) {
    return redactForReport(snapshot, {
        includeContent,
        knownSecrets: knownSecrets ?? collectKnownSecrets(),
    });
}
