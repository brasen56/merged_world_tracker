/**
 * backup/index.js — Public unified backup API.
 *
 * Binds the pure restore planner to the live chat metadata and, when present,
 * the hydrated Knowledge lorebook stores. The lorebook half is deliberately
 * flushed before metadata: it is the asynchronous, failure-prone half of a
 * restore, while metadata persistence is synchronous from the planner's point
 * of view.
 */

import {
    assertSameScope,
    captureScope,
    downloadJson,
    getChat,
    getChatIdentity,
    getChatMeta,
    getEpoch,
    persistChatMetaNow,
} from '../core/index.js';
import { collectBackup } from './collect.js';
import { backupDataEqual, cloneBackupData, METADATA_KEYS } from './data.js';
import { planRestore } from './restore.js';
import {
    getStoredStoreVersion,
    isFutureManifest,
    MANIFEST_METADATA_KEY,
    MANIFEST_VERSION,
    normalizeManifest,
    stampStoreVersion,
} from '../schema/manifest.js';
import { STORE_SCHEMAS, CHAT_METADATA_SCHEMA_IDS } from '../schema/registry.js';
import { isObject, ISSUE_SEVERITIES, prepareStore } from '../core/schema.js';
import {
    mergeQuarantineItems,
    QUARANTINE_METADATA_KEY,
    QUARANTINE_SCHEMA_VERSION,
    validateQuarantineStoreData,
} from '../core/quarantine.js';
import {
    getRegistry,
    getStateRegistry,
} from '../knowledge/registry.js';
import {
    getRelationships,
    getStances, getStanceSources,
} from '../knowledge/relationships.js';
import {
    assertHydrated,
    beginStoreTransaction,
    canMergeStoreQuarantine,
    captureStoreState,
    flushBook,
    getStoreQuarantineItems,
    isHydrated,
    isStoreEntry,
    mergeStoreQuarantineItems,
    restoreStoreState,
    STORE_VERSION,
    withStoreLock,
    _writeFieldDirect,
} from '../knowledge/store.js';
import { getLorebookName, getStateLorebookName } from '../knowledge/scope.js';
import { state as knowledgeState } from '../knowledge/state.js';
import { findDestinationEntryUid } from '../knowledge/reconcile.js';

const METADATA_SECTION_NAMES = Object.freeze(Object.keys(METADATA_KEYS));
let lastRestore = null;

/**
 * Exact replacement erases whatever the target chat currently holds, so it always
 * requires a verifiable same-chat identity — the full assertSameScope. A
 * non-destructive merge only needs the epoch to be unchanged when the build
 * cannot identify the chat: assertSameScope mints a fresh unknown nonce on every
 * getChatIdentity() call, so two unknown identities never compare equal and
 * every post-await check fails with 'identity-unknown'. That blocked every merge
 * restore on such builds even though the planner (planRestore identityPolicy)
 * already permits a reduced-scope merge. For a known identity, the identity is
 * still verified.
 *
 * @param {object} scope — token returned by captureScope()
 * @param {boolean} exact — true for exact/undo restores
 * @returns {{ ok: boolean, reason: string }}
 */
function assertRestoreScope(scope, exact) {
    if (exact) return assertSameScope(scope);
    if (!scope) return { ok: false, reason: 'no-token' };
    if (getEpoch() !== scope.epoch) return { ok: false, reason: 'epoch-changed' };
    if (scope.identity?.isUnknown === true) return { ok: true, reason: 'epoch-only-merge' };
    const current = getChatIdentity();
    if (scope.identity.key !== current.key) {
        return { ok: false, reason: current.isUnknown ? 'identity-unknown' : 'identity-changed' };
    }
    return { ok: true, reason: 'same-scope' };
}

function safeFilenamePart(value) {
    return String(value || 'chat')
        .replace(/[^a-z0-9_-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'chat';
}

export function getBackupFilename(envelope, now = Date.now()) {
    const label = safeFilenamePart(envelope?._meta?.chatName);
    return `mwt_backup_${label}_${now}.json`;
}

/**
 * Collect and, unless disabled, download a unified chat backup.
 *
 * `download: false` is useful for tests and console callers that want the
 * envelope in memory. Browser callers use the existing core file helper.
 */
export async function exportBackup({ download = true, filename, ...options } = {}) {
    const envelope = await collectBackup(options);
    if (download) downloadJson(filename || getBackupFilename(envelope), envelope);
    return envelope;
}

function collectCurrentMetadataSections(meta = getChatMeta()) {
    const sections = {};
    for (const [sectionName, metadataKey] of Object.entries(METADATA_KEYS)) {
        if (meta && Object.prototype.hasOwnProperty.call(meta, metadataKey)) {
            sections[sectionName] = meta[metadataKey];
        }
    }
    return sections;
}

/**
 * The schema version each chat-metadata store's data is actually at, read
 * from the destination manifest for the restore planner: the CURRENT half of
 * every merged section is prepared from its declared version so a legacy
 * destination runs its migrations instead of being quarantined by the
 * current-version validator (design §4.2/§7.7). A section the manifest has
 * not stamped is LEGACY version 0 (the manifest's own rule, schema/manifest.js).
 *
 * The Knowledge lorebook store keeps its version inside the flushed store,
 * not in the manifest; the hydrated cache always serves the book's
 * established version, so the planner can prepare that half at exactly what
 * the book holds.
 */
function collectCurrentVersions(meta = getChatMeta()) {
    const versions = {};
    for (const id of CHAT_METADATA_SCHEMA_IDS) {
        // Read through the manifest module's own accessor rather than
        // re-deriving it here. normalizeManifest() returns a FUTURE manifest
        // UNCHANGED by design (§3.5 category 4), so its `sections` may be a
        // shape this build has never seen — or absent entirely, in which case
        // indexing it threw a TypeError out of previewRestore() before
        // preflightDestinationContainers() could report the refusal the design
        // actually calls for. getStoredStoreVersion() already guards that.
        versions[id] = getStoredStoreVersion(meta?.[MANIFEST_METADATA_KEY], id);
    }
    versions.knowledgeStore = STORE_VERSION;
    return versions;
}

function hasKnowledgeStoreSection(envelope) {
    return Object.prototype.hasOwnProperty.call(envelope?.sections || {}, 'knowledgeStore');
}

function collectCurrentKnowledgeStore() {
    const knowledgeBook = getLorebookName();
    const stateBook = getStateLorebookName();
    if (!isHydrated(knowledgeBook) || !isHydrated(stateBook)) {
        return null;
    }
    const current = {
        version: STORE_VERSION,
        registry: getRegistry(),
        relationships: getRelationships(),
        stances: getStances(),
        stanceSources: getStanceSources(),
        stateRegistry: getStateRegistry(),
    };
    // Embedded per-book quarantine (design §5.1), both books merged: the
    // section the planner sees must match what the flush writes. Items carry
    // path[0] ('registry' vs 'stateRegistry') so the commit can partition
    // them back per book. Absent when no book holds recovery records — the
    // exact historical section shape.
    const quarantinedItems = mergeQuarantineItems(
        getStoreQuarantineItems(knowledgeBook),
        getStoreQuarantineItems(stateBook),
    );
    if (quarantinedItems.length > 0) {
        current.quarantine = { version: QUARANTINE_SCHEMA_VERSION, items: quarantinedItems };
    }
    return current;
}

function addKnowledgeSkip(preview, record, reason) {
    const summary = preview.summary.knowledgeStore || {
        added: 0, updated: 0, skipped: [], conflicts: 0,
    };
    preview.summary.knowledgeStore = summary;
    summary.skipped.push({ record, reason });
}

function identityMatches(a, b) {
    return a?.isUnknown === false && b?.isUnknown === false && a.key === b.key;
}

function hasLiveDestinationUid(entries, uid) {
    return uid !== null && uid !== undefined && entries?.[uid] && !isStoreEntry(entries[uid]);
}

/**
 * Partition the import's Knowledge quarantine records per destination book
 * (design §5.1): findings whose path addresses `stateRegistry` belong to the
 * State Tracker book; everything else (registry, relationships, stances,
 * stanceSources, the store itself) belongs to the Knowledge Tracker book.
 *
 * Two sources, deduplicated by content fingerprint: the incoming section's
 * EMBEDDED container (recovery records the source book already carried, which
 * the import validation canonicalized) and every fresh finding the validation
 * quarantined — including, since the plan now re-prepares the merged value,
 * records copied out of the CURRENT store that failed the current-version
 * validator.
 */
function partitionKnowledgeQuarantine(preview) {
    const embedded = preview.validation?.sections?.knowledgeStore?.quarantine;
    const items = mergeQuarantineItems([], [
        ...(isObject(embedded) && Array.isArray(embedded.items) ? embedded.items : []),
        ...(preview.validation?.quarantine?.knowledgeStore || []),
    ]);
    const knowledgeQuarantine = [];
    const stateQuarantine = [];
    for (const item of items) {
        (Array.isArray(item?.path) && item.path[0] === 'stateRegistry'
            ? stateQuarantine
            : knowledgeQuarantine).push(item);
    }
    return { knowledgeQuarantine, stateQuarantine };
}

/**
 * Resolve new registry names against the destination books. Unified backups do
 * not include lorebook text, so an unresolved name cannot be safely created;
 * it is omitted rather than persisting a null or source-local UID.
 */
async function resolveKnowledgeStorePlan(preview, scope) {
    const planned = preview.plan.sections.knowledgeStore;
    // Knowledge quarantine rides the store flush even when the plan refused
    // the section itself (§3.5 fatal): the import still owes its rejected
    // records a home inside the affected book(s).
    const { knowledgeQuarantine, stateQuarantine } = partitionKnowledgeQuarantine(preview);
    const quarantineChanged = knowledgeQuarantine.length > 0 || stateQuarantine.length > 0;
    if (!planned) {
        if (!quarantineChanged) return { ok: true, changed: false };
        const knowledgeBookOnly = getLorebookName();
        const stateBookOnly = getStateLorebookName();
        return {
            ok: true,
            changed: true,
            data: {},
            knowledgeBook: knowledgeBookOnly,
            stateBook: stateBookOnly,
            affectedBooks: [
                ...(knowledgeQuarantine.length > 0 ? [knowledgeBookOnly] : []),
                ...(stateQuarantine.length > 0 ? [stateBookOnly] : []),
            ],
            knowledgeQuarantine,
            stateQuarantine,
        };
    }
    const exact = preview.plan.exactKnowledgeStore === true;

    const knowledgeBook = getLorebookName();
    const stateBook = getStateLorebookName();
    try {
        assertHydrated(knowledgeBook, 'restore the Knowledge registry');
        assertHydrated(stateBook, 'restore the State Tracker registry');
    } catch (err) {
        return { ok: false, reason: 'knowledge-store-unavailable', error: err?.message || String(err) };
    }

    const current = collectCurrentKnowledgeStore();
    if (!current) return { ok: false, reason: 'knowledge-store-unavailable' };
    const needsNpcResolution = Object.keys(planned.registry || {}).length > 0 && (exact
        || Object.keys(planned.registry || {}).some(name => !Object.prototype.hasOwnProperty.call(current.registry, name)));
    const needsStateResolution = Object.keys(planned.stateRegistry || {}).length > 0 && (exact
        || Object.keys(planned.stateRegistry || {}).some(name => !Object.prototype.hasOwnProperty.call(current.stateRegistry, name)));
    let knowledgeInfo = null;
    let stateInfo = null;
    if (needsNpcResolution || needsStateResolution) {
        const wi$ = knowledgeState.wiScript;
        if (!wi$ || typeof wi$.loadWorldInfo !== 'function') {
            return { ok: false, reason: 'knowledge-store-unavailable' };
        }
        try {
            [knowledgeInfo, stateInfo] = await Promise.all([
                needsNpcResolution ? wi$.loadWorldInfo(knowledgeBook) : null,
                needsStateResolution ? wi$.loadWorldInfo(stateBook) : null,
            ]);
        } catch (err) {
            return { ok: false, reason: 'knowledge-store-unavailable', error: err?.message || String(err) };
        }
        const afterLoad = assertRestoreScope(scope, exact);
        if (!afterLoad.ok) return { ok: false, reason: 'stale-scope', staleReason: afterLoad.reason };
    }
    const resolved = {
        ...planned,
        registry: { ...(planned.registry || {}) },
        stateRegistry: { ...(planned.stateRegistry || {}) },
    };
    let changed = false;

    for (const [name, record] of Object.entries(resolved.registry)) {
        if (!exact && Object.prototype.hasOwnProperty.call(current.registry, name)) continue;
        const currentRecord = current.registry[name];
        const uid = exact && hasLiveDestinationUid(knowledgeInfo?.entries, currentRecord?.uid)
            ? currentRecord.uid
            : findDestinationEntryUid(knowledgeInfo?.entries, name);
        if (uid === null) {
            delete resolved.registry[name];
            addKnowledgeSkip(preview, name,
                'No matching NPC lorebook entry exists in the destination; the registry name was omitted because backup v1 excludes dossier text.');
            if (!exact && preview.summary.knowledgeStore.added > 0) preview.summary.knowledgeStore.added--;
        } else {
            resolved.registry[name] = { ...record, uid };
            changed = true;
        }
    }
    for (const [name, record] of Object.entries(resolved.stateRegistry)) {
        if (!exact && Object.prototype.hasOwnProperty.call(current.stateRegistry, name)) continue;
        const currentRecord = current.stateRegistry[name];
        const uid = exact && hasLiveDestinationUid(stateInfo?.entries, currentRecord?.uid)
            ? currentRecord.uid
            : findDestinationEntryUid(stateInfo?.entries, name, { kind: 'state' });
        if (uid === null) {
            delete resolved.stateRegistry[name];
            addKnowledgeSkip(preview, name,
                'No matching State Tracker lorebook entry exists in the destination; the registry name was omitted because backup v1 excludes tracker text.');
            if (!exact && preview.summary.knowledgeStore.added > 0) preview.summary.knowledgeStore.added--;
        } else {
            resolved.stateRegistry[name] = { ...record, uid };
            changed = true;
        }
    }

    // Relationship maps have no UID and can safely retain their normal
    // append-only merge behavior. A changed map is still a store write.
    // Quarantine additions are a store write too (§5.1/§5.2): preserving the
    // import's rejected records inside the affected book is part of the commit.
    changed = changed
        || quarantineChanged
        || JSON.stringify(current.relationships) !== JSON.stringify(resolved.relationships)
        || JSON.stringify(current.stances) !== JSON.stringify(resolved.stances)
        || JSON.stringify(current.stanceSources) !== JSON.stringify(resolved.stanceSources)
        || JSON.stringify(current.registry) !== JSON.stringify(resolved.registry)
        || JSON.stringify(current.stateRegistry) !== JSON.stringify(resolved.stateRegistry);
    const knowledgeChanged = knowledgeQuarantine.length > 0
        || JSON.stringify(current.registry) !== JSON.stringify(resolved.registry)
        || JSON.stringify(current.relationships) !== JSON.stringify(resolved.relationships)
        || JSON.stringify(current.stances) !== JSON.stringify(resolved.stances)
        || JSON.stringify(current.stanceSources) !== JSON.stringify(resolved.stanceSources);
    const stateChanged = stateQuarantine.length > 0
        || JSON.stringify(current.stateRegistry) !== JSON.stringify(resolved.stateRegistry);
    preview.plan.sections.knowledgeStore = resolved;
    const result = {
        ok: true,
        changed,
        data: resolved,
        knowledgeBook,
        stateBook,
        affectedBooks: [
            ...(knowledgeChanged ? [knowledgeBook] : []),
            ...(stateChanged ? [stateBook] : []),
        ],
        // Per-book quarantine items for the flush to merge inside the store
        // transaction (never the chat-local container — a shared book cannot
        // be owned by one chat, §5.1).
        knowledgeQuarantine,
        stateQuarantine,
    };
    // Stash the resolution on the preview so a confirming commit can reuse it
    // instead of re-resolving (a third loadWorldInfo pass). The re-plan at
    // commit time already resolves; reusing this drops one full book read per
    // commit.
    preview.knowledgeStoreCommit = result;
    return result;
}

/**
 * Restore the captured pre-flush store slots and durably flush them back, so a
 * transaction that failed after some books reached disk does not leave a
 * partial restore behind. Used by both the flush-failure and the
 * stale-scope-during-flush paths, and by the caller when a later metadata
 * persist fails.
 */
async function rollbackKnowledgeStore(beforeStore, booksToFlush) {
    restoreStoreState(beforeStore, { flushBooks: booksToFlush });
    const rolledBackBooks = [];
    const rollbackFailedBooks = [];
    for (const book of booksToFlush) {
        let rolledBack = false;
        try { rolledBack = await flushBook(book); } catch { rolledBack = false; }
        if (rolledBack) rolledBackBooks.push(book);
        else rollbackFailedBooks.push(book);
    }
    return { rolledBackBooks, rollbackFailedBooks };
}

async function flushKnowledgeStore(commit, scope, exact) {
    if (!commit.changed) return { ok: true, persistedBooks: [], beforeStore: null };
    const beforeWrite = assertRestoreScope(scope, exact);
    if (!beforeWrite.ok) return { ok: false, reason: 'stale-scope', staleReason: beforeWrite.reason };

    const beforeStore = captureStoreState(commit.affectedBooks);
    // Begin a store transaction: background writeField() calls are deferred until
    // the restore's critical section ends so they cannot join this flush (and be
    // persisted as if part of the restore) or be erased by a rollback.
    // The restore's own writes below go through the
    // non-deferring _writeFieldDirect.
    beginStoreTransaction();
    // ── Knowledge quarantine first (design §5.1/§5.2) ─────────────────────
    //
    // The import's rejected Knowledge records are preserved INSIDE the
    // affected books, in the SAME flush as the store data — atomic with it
    // and covered by the same rollback. Both books are checked BEFORE either
    // is written, so a refusal (book not loaded, or its container was written
    // by a newer MWT and must stay unchanged) fails the restore with nothing
    // written rather than leaving a half-merged transaction behind.
    const quarantineTargets = [
        [commit.knowledgeBook, commit.knowledgeQuarantine],
        [commit.stateBook, commit.stateQuarantine],
    ].filter(([, items]) => Array.isArray(items) && items.length > 0);
    for (const [book] of quarantineTargets) {
        const writable = canMergeStoreQuarantine(book);
        if (!writable.ok) {
            return {
                ok: false,
                reason: 'knowledge-quarantine-refused',
                refusedBook: book,
                refusedReason: writable.reason,
                error: `Could not preserve quarantined Knowledge records in "${book}" (${writable.reason}); the restore was cancelled before any write.`,
            };
        }
    }
    for (const [book, items] of quarantineTargets) {
        mergeStoreQuarantineItems(book, items); // writability verified above
    }
    if (commit.affectedBooks.includes(commit.knowledgeBook)) {
        if (commit.data.registry !== undefined) _writeFieldDirect(commit.knowledgeBook, 'registry', commit.data.registry);
        if (commit.data.relationships !== undefined) _writeFieldDirect(commit.knowledgeBook, 'relationships', commit.data.relationships);
        if (commit.data.stances !== undefined) _writeFieldDirect(commit.knowledgeBook, 'stances', commit.data.stances);
        if (commit.data.stanceSources !== undefined) _writeFieldDirect(commit.knowledgeBook, 'stanceSources', commit.data.stanceSources);
    }
    if (commit.affectedBooks.includes(commit.stateBook) && commit.data.stateRegistry !== undefined) {
        _writeFieldDirect(commit.stateBook, 'stateRegistry', commit.data.stateRegistry);
    }
    // Carry the store's established version rather than inventing a parallel
    // backup-only version. Both books have independent store entries.
    if (Number.isInteger(commit.data.version)) {
        for (const book of commit.affectedBooks) _writeFieldDirect(book, 'version', commit.data.version);
    }

    const persistedBooks = [];
    for (const book of commit.affectedBooks) {
        let flushed = false;
        try { flushed = await flushBook(book); } catch { flushed = false; }
        if (!flushed) {
            // An earlier book reached disk. Restore the pre-flush cache and flush
            // the persisted books back so the failed transaction leaves nothing
            // behind.
            const rollback = await rollbackKnowledgeStore(beforeStore, persistedBooks);
            return {
                ok: false,
                reason: 'store-flush-failed',
                failedBooks: [book],
                persistedBooks,
                partialCommit: persistedBooks.length > 0,
                ...rollback,
            };
        }
        persistedBooks.push(book);
        const afterFlush = assertRestoreScope(scope, exact);
        if (!afterFlush.ok) {
            // The chat changed after a book was flushed but before the rest (and
            // the metadata) landed. Undo the already-durable writes so a partial
            // restore cannot linger when the caller surfaces a stale scope.
            const rollback = await rollbackKnowledgeStore(beforeStore, persistedBooks);
            return {
                ok: false,
                reason: 'stale-scope',
                staleReason: afterFlush.reason,
                persistedBooks,
                partialCommit: persistedBooks.length > 0,
                ...rollback,
            };
        }
    }
    // Expose the pre-flush snapshot so a later failure (e.g. metadata persist)
    // can roll the store back too.
    return { ok: true, persistedBooks, beforeStore };
}

function collectCurrentMessageIds(chat = getChat()) {
    if (!Array.isArray(chat)) return [];
    return chat
        .map(message => message?.extra?.mwt_uuid)
        .filter(uuid => typeof uuid === 'string' && uuid.length > 0)
        .map(uuid => `mu-${uuid}`);
}

// A user confirms a preview, then the commit re-plans against live state. If
// the fresh plan differs from the confirmed one (e.g. the omission list grew
// because another update landed between confirm and commit), Phase 4's UI must
// re-confirm — but the API offered no pause between re-plan and commit. The
// fingerprint captures the semantic summary the user agreed to (per-section
// counts + the exact set of skipped records), so a caller can hand the
// confirmed token to restoreBackup() and the commit can refuse to write when
// the plan drifted, returning `reconfirmation-required` instead.

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function fingerprintSummary(summary) {
    if (!summary || typeof summary !== 'object') return '{}';
    const out = {};
    for (const [name, sec] of Object.entries(summary)) {
        if (!sec || typeof sec !== 'object') continue;
        const skipped = Array.isArray(sec.skipped)
            ? sec.skipped
                .map(s => ({ record: s?.record, reason: s?.reason }))
                .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
            : [];
        const entry = {
            added: sec.added ?? 0,
            updated: sec.updated ?? 0,
            conflicts: sec.conflicts ?? 0,
            skipped,
        };
        if (sec.mode !== undefined) entry.mode = sec.mode;
        if (sec.action !== undefined) entry.action = sec.action;
        if (sec.perMessage) {
            entry.perMessage = {
                imported: sec.perMessage.imported ?? 0,
                resolved: sec.perMessage.resolved ?? 0,
                sameChat: sec.perMessage.sameChat,
            };
        }
        out[name] = entry;
    }
    return stableStringify(out);
}

/**
 * Produce a stable fingerprint of a preview's summary. Two previews that would
 * land the same records with the same omissions share a token; any drift
 * (added skips, changed conflicts, a different resolved-perMessage count)
 * changes it. Public so Phase 4 UI/tests can read the token a preview carries.
 * @param {object} preview
 * @returns {string}
 */
export function fingerprintPreview(preview) {
    // Bind the token to the normalized plan, the restore modes, the resolved
    // identity policy, and the removal list — not only the summary counts. Two
    // materially different plans (different planned data, different omissions,
    // different modes, different identity handling) can share identical
    // added/conflict/skip counts, so a summary-only token could confirm a plan
    // the user never saw.
    const plan = preview?.plan;
    return stableStringify({
        kind: plan?.exactKnowledgeStore === true ? 'exact' : 'merge',
        summary: fingerprintSummary(preview?.summary),
        plan: plan?.sections ? stableStringify(plan.sections) : '{}',
        modes: stableStringify(preview?.modes || {}),
        identityPolicy: stableStringify(preview?.identityPolicy || {}),
        removals: stableStringify(plan?.removeMetadataSections || []),
    });
}

function staleResult(preview, reason, extra = {}) {
    return {
        ok: false,
        committed: false,
        reason: 'stale-scope',
        staleReason: reason,
        preview,
        ...extra,
    };
}

/**
 * Bind the dry-run planner to the currently active chat. This never writes or
 * downloads; a Knowledge-store preview reads destination lorebooks so its
 * omission report is the one the user confirms.
 */
export async function previewRestore(envelope, { modes = {}, exact = false, scope: suppliedScope = null } = {}) {
    const scope = suppliedScope || captureScope();
    const current = collectCurrentMetadataSections();
    if (hasKnowledgeStoreSection(envelope)) {
        const knowledgeStore = collectCurrentKnowledgeStore();
        if (!knowledgeStore) {
            return {
                ok: false,
                reason: 'knowledge-store-unavailable',
                validation: null,
                summary: {},
                plan: null,
            };
        }
        current.knowledgeStore = knowledgeStore;
    }
    const preview = planRestore(envelope, current, {
        modes,
        currentIdentity: getChatIdentity(),
        currentMessageIds: collectCurrentMessageIds(),
        currentVersions: collectCurrentVersions(),
        exact,
    });
    // Attach the resolved modes so fingerprintPreview can bind the token to the
    // restore options the user confirmed, not only the summary counts.
    preview.modes = modes;
    if (!preview.ok || !hasKnowledgeStoreSection(envelope)) {
        if (preview.ok) preview.previewToken = fingerprintPreview(preview);
        return preview;
    }
    if (exact) preview.plan.exactKnowledgeStore = true;
    const resolved = await resolveKnowledgeStorePlan(preview, scope);
    if (resolved.ok) {
        preview.previewToken = fingerprintPreview(preview);
        return preview;
    }
    return {
        ...preview,
        ok: false,
        reason: resolved.reason,
        staleReason: resolved.staleReason,
        error: resolved.error,
        plan: null,
    };
}

function exactSectionSummary(current, imported, sectionName, { blocked = false } = {}) {
    // §3.5: a destination section whose CURRENT half refused preparation is
    // untouchable — the exact write must neither replace it with the import
    // nor remove it, so the summary reports it as blocked instead of
    // describing a write that will not happen.
    if (blocked) {
        return { mode: 'exact', action: 'blocked', replaced: 0, removed: 0, unchanged: 0, skipped: [], conflicts: 0 };
    }
    const hasCurrent = Object.prototype.hasOwnProperty.call(current, sectionName);
    const hasImported = Object.prototype.hasOwnProperty.call(imported, sectionName);
    if (!hasImported) {
        return { mode: 'exact', action: hasCurrent ? 'removed' : 'unchanged', replaced: 0, removed: hasCurrent ? 1 : 0, unchanged: hasCurrent ? 0 : 1, skipped: [], conflicts: 0 };
    }
    const unchanged = hasCurrent && backupDataEqual(current[sectionName], imported[sectionName]);
    return { mode: 'exact', action: unchanged ? 'unchanged' : 'replaced', replaced: unchanged ? 0 : 1, removed: 0, unchanged: unchanged ? 1 : 0, skipped: [], conflicts: 0 };
}

/**
 * Would preparing this destination section as a merge CURRENT half refuse?
 * (§3.5: an unreadable root, or a manifest version from the future.) Used by
 * exact planning for removal candidates the merge planner never evaluated —
 * a blocked store may not be deleted by the exact restore either.
 *
 * Returns the refusal as display-safe skipped entries ({ record, reason }) —
 * the SAME shape the merge planner records in its summary.skipped (§10.3) —
 * or [] when the section is writable, so the caller can attach the reason to
 * the section's exact summary. The old boolean discarded prepareStore's fatal
 * issue / future-version error, leaving a removal-only blocked section
 * reported as "destination store refused" with an empty skipped-details list.
 */
function destinationSectionBlockedSkipped(sectionName, rawCurrent, currentVersions) {
    const schema = STORE_SCHEMAS[sectionName];
    if (!schema || rawCurrent === undefined || rawCurrent === null) return [];
    const declaredVersion = Number.isInteger(currentVersions?.[sectionName])
        ? currentVersions[sectionName]
        : schema.currentVersion;
    const prepared = prepareStore(schema, rawCurrent, { version: declaredVersion, deferPolicy: 'canonicalize' });
    if (prepared.status !== 'blocked') return [];
    // Same derivation as the merge planner's currentSkipped: FATAL/QUARANTINE
    // issues name the record; a store-level error (a future version blocks
    // before any issue is recorded) names the section instead.
    const skipped = prepared.issues
        .filter(issue => issue.severity === ISSUE_SEVERITIES.QUARANTINE
            || issue.severity === ISSUE_SEVERITIES.FATAL)
        .map(issue => ({ record: issue.identity ?? issue.record, reason: issue.message }));
    if (skipped.length === 0 && prepared.error) {
        skipped.push({ record: sectionName, reason: prepared.error.message });
    }
    return skipped;
}

/**
 * Undo is intentionally not another merge: a merge cannot remove records that
 * the original restore added. Rebuild the validated snapshot as an exact plan,
 * including removal of metadata sections that did not exist at capture time.
 */
async function previewExactRestore(envelope, { modes = {}, scope = null } = {}) {
    const preview = await previewRestore(envelope, { modes, exact: true, scope });
    if (!preview.ok) return preview;
    const imported = preview.validation.sections;
    const current = collectCurrentMetadataSections();
    // previewRestore already resolved the knowledge-store plan (destination UIDs
    // + omissions). The commit re-resolves the same way, so the confirmation
    // summary must be built from that resolved plan — not the raw validated
    // source, whose UIDs may not be satisfiable by any destination entry.
    const resolvedKnowledgeStore = preview.plan.sections.knowledgeStore;
    // Destination sections the merge planner REFUSED to touch (§3.5: an
    // unreadable root, a manifest version from the future). The exact write
    // must preserve the same refusal — reintroducing the section from the
    // import (or removing it, for a snapshot taken before it existed) would
    // overwrite or destroy a store the planner judged unwritable. (The
    // knowledgeStore lorebook flush governs its own blocked destination.)
    const blockedSections = (Array.isArray(preview.plan.blockedSections) ? preview.plan.blockedSections : [])
        .filter(sectionName => METADATA_SECTION_NAMES.includes(sectionName));
    // Removal candidates the merge planner never evaluated (they are absent
    // from the import, so its loop never reached them): an unreadable or
    // future-version destination must not be DELETED by the exact restore
    // either — check them with the same preparation the planner uses (§3.5).
    const currentVersions = collectCurrentVersions();
    // Removal-only blocked sections have no merge summary that could carry
    // their refusal, so their display-safe reasons are collected here and
    // attached to the exact summary below.
    const removalBlockedSkipped = {};
    for (const sectionName of METADATA_SECTION_NAMES) {
        if (blockedSections.includes(sectionName)) continue;
        if (Object.prototype.hasOwnProperty.call(imported, sectionName)) continue;
        const skipped = destinationSectionBlockedSkipped(sectionName, current[sectionName], currentVersions);
        if (skipped.length > 0) {
            blockedSections.push(sectionName);
            removalBlockedSkipped[sectionName] = skipped;
        }
    }
    const sections = {};
    for (const sectionName of METADATA_SECTION_NAMES) {
        if (blockedSections.includes(sectionName)) continue;
        if (Object.prototype.hasOwnProperty.call(imported, sectionName)) {
            sections[sectionName] = cloneBackupData(imported[sectionName]);
        }
    }
    if (Object.prototype.hasOwnProperty.call(imported, 'knowledgeStore')) {
        sections.knowledgeStore = cloneBackupData(resolvedKnowledgeStore);
    }
    // §7.5: sections whose IMPORTED value is deferred (retained legacy
    // per-message keys pending the privileged conversion). The exact write
    // replaces the section with that retained data, so it may not be stamped
    // current — and an existing stamp must be withheld.
    const exactDeferredSections = METADATA_SECTION_NAMES.filter(sectionName => {
        const entries = preview.validation.summaries[sectionName]?.deferred;
        return Array.isArray(entries) && entries.length > 0;
    });
    preview.plan = {
        ...preview.plan,
        sections,
        removeMetadataSections: METADATA_SECTION_NAMES
            .filter(sectionName => !Object.prototype.hasOwnProperty.call(imported, sectionName))
            // A blocked destination section is never removed either — removal
            // is still a write to a store the planner refused to touch.
            .filter(sectionName => !blockedSections.includes(sectionName)),
        exactKnowledgeStore: Object.prototype.hasOwnProperty.call(imported, 'knowledgeStore'),
        // Every exact write replaces the section with the import's canonical
        // data, so every written metadata section is a canonical rewrite —
        // EXCEPT one whose imported value is DEFERRED (§7.5): retained
        // legacy entries pending the privileged conversion are written but
        // never stamped current, exactly like a merge. (Blocked sections are
        // absent from `sections`, so they are neither written nor stamped.)
        canonicalSections: METADATA_SECTION_NAMES
            .filter(sectionName => Object.prototype.hasOwnProperty.call(sections, sectionName))
            .filter(sectionName => !exactDeferredSections.includes(sectionName)),
        // §7.5: deferred sections must also WITHHOLD any existing stamp the
        // same transaction. Deferral derives SOLELY from the exact value
        // actually being committed: the merge plan's deferrals describe the
        // OLD destination half, which the exact write replaces wholesale —
        // unioning them would leave a clean exact replacement unstamped
        // merely because the outgoing store contained deferred keys.
        deferredSections: exactDeferredSections
            .filter(sectionName => !blockedSections.includes(sectionName)),
    };
    for (const sectionName of METADATA_SECTION_NAMES) {
        const isBlocked = blockedSections.includes(sectionName);
        const exactSummary = exactSectionSummary(current, imported, sectionName, { blocked: isBlocked });
        // §3.5: a blocked destination's refusal reasons ride the exact summary
        // too, so the confirmation explains why the section is left untouched.
        // Merge-planner-blocked sections already carry theirs in the merge
        // preview's summary; removal-only candidates (absent from the import,
        // so the planner never examined them) take them from the destination
        // preparation above instead of reporting an unexplained refusal.
        if (isBlocked) {
            const plannerSkipped = Array.isArray(preview.summary[sectionName]?.skipped)
                ? preview.summary[sectionName].skipped
                : [];
            exactSummary.skipped = [...plannerSkipped, ...(removalBlockedSkipped[sectionName] || [])];
        }
        // §10.3 (Part 3): the exact summary must include quarantine results
        // too — records the import validation refused were kept out of the
        // snapshot data, and a preview that hides them would understate what
        // the exact restore drops.
        const importSkipped = preview.validation.summaries[sectionName]?.skipped;
        if (Array.isArray(importSkipped) && importSkipped.length > 0) {
            exactSummary.skipped = [...importSkipped, ...exactSummary.skipped];
        }
        preview.summary[sectionName] = exactSummary;
    }
    if (Object.prototype.hasOwnProperty.call(imported, 'knowledgeStore')) {
        const fullStore = collectCurrentKnowledgeStore() || {};
        // The store version lives on the section wrapper (storeVersion), not in
        // the data; exclude it so an unchanged exact
        // Knowledge restore reports "unchanged" rather than "replaced".
        // The embedded quarantine containers are excluded too: they are
        // MERGED (never replaced) inside the lorebook flush, and their item
        // order differs between the collected and planned shapes, so comparing
        // them would report a semantic no-op as "replaced".
        // Order-insensitive compare so key-order differences no longer report a
        // semantic no-op as "replaced".
        const { version: _storeVersion, quarantine: _currentQuarantine, ...currentStoreData } = fullStore;
        const { quarantine: _plannedQuarantine, ...plannedStoreData } = sections.knowledgeStore;
        const unchanged = backupDataEqual(currentStoreData, plannedStoreData);
        preview.summary.knowledgeStore = {
            mode: 'exact',
            action: unchanged ? 'unchanged' : 'replaced',
            replaced: unchanged ? 0 : 1,
            removed: 0,
            unchanged: unchanged ? 1 : 0,
            skipped: preview.summary.knowledgeStore?.skipped || [],
            conflicts: 0,
        };
    }
    // The exact summary rebuilt the per-section reports, so the token stamped by
    // previewRestore is stale. Re-stamp from the exact summary.
    preview.previewToken = fingerprintPreview(preview);
    return preview;
}

/**
 * Commit a fresh restore preview after an explicit confirmation.
 *
 * A pre-restore unified backup is downloaded before any write. Knowledge-store
 * changes are reconciled and flushed first; metadata is persisted only after
 * that failure-prone I/O succeeds.
 *
 * @param {object} envelope
 * @param {object}  options
 * @param {object}  options.modes        per-section restore modes
 * @param {boolean} options.confirm      must be true to write
 * @param {string}  [options.previewToken] fingerprint of the preview the caller
 *   confirmed; if supplied and the fresh commit plan differs, the commit returns
 *   `reconfirmation-required` without writing
 * @param {boolean} exact  internal: use the exact (undo) strategy
 */
async function restoreBackupInternal(envelope, {
    modes = {},
    confirm = false,
    previewToken,
    undo = false,
} = {}, exact = false) {
    const makePreview = exact ? previewExactRestore : previewRestore;
    const scope = captureScope();
    const preview = await makePreview(envelope, { modes, scope });
    if (!preview.ok) {
        return { ok: false, committed: false, reason: preview.reason || 'invalid-backup', preview };
    }
    if (!confirm) {
        return { ok: false, committed: false, reason: 'confirmation-required', preview };
    }
    // Exact replacement is destructive, so it requires the
    // preview token of the exact preview the user confirmed — a distinct,
    // stronger confirmation than a non-destructive merge. The undo path sets
    // `undo` to bypass this: it re-applies the captured pre-restore snapshot.
    if (exact && !undo && previewToken === undefined) {
        return {
            ok: false,
            committed: false,
            reason: 'preview-required',
            warning: 'Exact (replace) restore is destructive. Preview it first and pass the preview token it returns.',
            preview,
        };
    }

    const beforeBackup = assertRestoreScope(scope, exact);
    if (!beforeBackup.ok) return staleResult(preview, beforeBackup.reason);

    // The MANIFEST half of the destination preflight runs BEFORE the pre-restore
    // export: collectBackup() aborts on a future manifest (it cannot label the
    // chat's stores), so without this the restore would surface that thrown
    // export error instead of the designed manifest-version-future refusal —
    // and would download a snapshot for a restore that is refused anyway. The
    // quarantine-container half stays inside commitRestore, where the re-planned
    // preview decides whether the plan merges into it at all.
    const preflightMeta = getChatMeta();
    if (preflightMeta) {
        const manifestPreflight = preflightDestinationContainers(preflightMeta, { needsQuarantineMerge: false });
        if (!manifestPreflight.ok) {
            return {
                ok: false,
                committed: false,
                reason: manifestPreflight.reason,
                warning: manifestPreflight.message,
                preview,
            };
        }
    }

    const preRestoreBackup = await exportBackup({
        filename: `mwt_pre_restore_${safeFilenamePart(getChatIdentity().chatId)}_${Date.now()}.json`,
    });
    const afterBackup = assertRestoreScope(scope, exact);
    if (!afterBackup.ok) return staleResult(preview, afterBackup.reason);

    // The store write phase (re-plan → flush → metadata → rollback) is serialized
    // against cache reset/flush so a concurrent resetStoreCache() — which a real
    // chat change starts — cannot clear the cache mid-transaction and defeat the
    // rollback, re-persisting a cancelled restore.
    return withStoreLock(() => commitRestore(envelope, {
        makePreview, modes, scope, previewToken, preRestoreBackup, exact,
    }));
}

/**
 * The import's quarantine records destined for the CHAT-LOCAL container:
 * per-section findings for the chat-metadata stores plus the chat-local half
 * of the recovery items. `knowledgeStore` records are deliberately excluded —
 * they ride the lorebook flush inside the affected book(s) instead (§5.1;
 * planRestore partitioned them into validation.quarantine.knowledgeStore).
 */
function collectChatLocalImportQuarantine(preview) {
    return [
        ...Object.entries(preview.validation?.quarantine || {})
            .filter(([sectionName]) => sectionName !== 'knowledgeStore')
            .flatMap(([, items]) => items),
        ...(preview.validation?.recovery?.items || []),
    ];
}

/**
 * The writable-container rule for the chat-local quarantine container on the
 * restore's persistence paths — the SAME rule core/metadata.js
 * preserveQuarantinedRecords enforces for write seams (design §5.2): a
 * future-version container is refused unchanged (never downgraded), and a
 * PRESENT container whose persisted shape produced non-repair findings (a
 * malformed root/items list, or items the checker rejected as unrecoverable)
 * is refused too — merging into the canonical form would replace the raw
 * container and silently delete its recovery evidence. An ABSENT container is
 * the normal pre-quarantine state, and repair-only findings (a recomputed
 * fingerprint) stay writable.
 *
 * Shared by the restore preflight and the commit-time merge so the two can
 * never disagree about which containers are writable.
 *
 * @param {*} rawContainer the persisted chat-local quarantine container
 * @returns {{ ok: true, container: object } | { ok: false, reason: string, message: string }}
 */
function assessWritableQuarantineContainer(rawContainer) {
    const existing = validateQuarantineStoreData(rawContainer);
    const futureIssue = existing.issues.find(issue => issue.code === 'future-version');
    if (futureIssue) {
        return { ok: false, reason: 'quarantine-version-future', message: futureIssue.message };
    }
    const lossyIssue = rawContainer === undefined || rawContainer === null
        ? undefined
        : existing.issues.find(issue => issue.severity === ISSUE_SEVERITIES.QUARANTINE
            || issue.severity === ISSUE_SEVERITIES.FATAL);
    if (lossyIssue) {
        return {
            ok: false,
            reason: 'quarantine-container-invalid',
            message: `The chat quarantine container is malformed (${lossyIssue.message}) It was left unchanged; merging into it would delete the records it still holds.`,
        };
    }
    return { ok: true, container: existing.data };
}

/**
 * Preflight the destination chat-metadata containers a restore must write:
 * the schema manifest and the chat-local quarantine container. A container
 * written by a NEWER MWT makes the restore's bookkeeping refuse (stamping a
 * future manifest throws by design; merging into a future quarantine
 * container would downgrade it), and a PRESENT quarantine container with
 * non-repair findings refuses the same way — the canonical merge would
 * replace the malformed raw container and lose its recovery evidence — so
 * the restore is refused UNCHANGED, before any transaction write, instead of
 * failing (or corrupting) halfway through.
 *
 * The quarantine refusal applies ONLY when the plan actually needs to merge
 * chat-local quarantine records (`needsQuarantineMerge`): a clean restore
 * with no quarantine additions never touches that container, so an unrelated
 * unwritable container must not block it. The store-scoped blocking rules (the
 * manifest preflight, and the Knowledge books' own container check inside the
 * flush) are unaffected.
 *
 * @param {object} meta live chat metadata
 * @param {object} [options]
 * @param {boolean} [options.needsQuarantineMerge] whether the plan merges
 *   records into the chat-local quarantine container
 * @returns {{ ok: boolean, reason?: string, message?: string }}
 */
function preflightDestinationContainers(meta, { needsQuarantineMerge = true } = {}) {
    const manifest = meta[MANIFEST_METADATA_KEY];
    if (isFutureManifest(manifest)) {
        return {
            ok: false,
            reason: 'manifest-version-future',
            message: `Schema manifest version ${manifest.manifestVersion} is newer than the supported version `
                + `${MANIFEST_VERSION}. The restore was refused and the manifest was left unchanged — `
                + 'upgrade MWT before restoring into this chat.',
        };
    }
    if (!needsQuarantineMerge) return { ok: true };
    const writable = assessWritableQuarantineContainer(meta[QUARANTINE_METADATA_KEY]);
    if (!writable.ok) {
        return {
            ok: false,
            reason: writable.reason,
            message: `${writable.message} The restore was refused and the container was left unchanged.`,
        };
    }
    return { ok: true };
}

/**
 * The serialized write phase of a restore. Runs under the store lock acquired by
 * restoreBackupInternal, so flushAll()/resetStoreCache() cannot interleave.
 */
async function commitRestore(envelope, { makePreview, modes, scope, previewToken, preRestoreBackup, exact = false }) {
    // Re-plan after the awaited export so a concurrent local update cannot be
    // overwritten by a stale dry run. This is also the plan that is committed.
    const commitPreview = await makePreview(envelope, { modes, scope });
    if (!commitPreview.ok) {
        return { ok: false, committed: false, reason: commitPreview.reason || 'invalid-backup', preview: commitPreview };
    }
    const beforeCommit = assertRestoreScope(scope, exact);
    if (!beforeCommit.ok) return staleResult(commitPreview, beforeCommit.reason);

    // If the caller handed us the token of the preview they
    // confirmed, refuse to write when the fresh commit plan drifted (e.g. the
    // omission list grew between confirm and commit). No token ⇒ no check, so
    // existing callers and the undo path are unaffected.
    if (previewToken !== undefined && commitPreview.previewToken !== previewToken) {
        return {
            ok: false,
            committed: false,
            reason: 'reconfirmation-required',
            preview: commitPreview,
            preRestoreBackup,
        };
    }

    // ── Destination-container preflight (design §3.5 category 4) ──────────
    //
    // The manifest and the chat-local quarantine container are written by the
    // SAME transaction as the section data, but their bookkeeping can REFUSE:
    // stampStoreVersion() intentionally throws on a manifest from a newer MWT,
    // and a future quarantine container must never be normalized into the
    // current version by the merge (§5.1). Discovering either only AFTER the
    // durable Knowledge flush left metadata mutated — or the store committed —
    // with no rollback, because the transaction's guarded block had not
    // started yet. Refuse unchanged here, before any write.
    const meta = getChatMeta();
    if (!meta) {
        return { ok: false, committed: false, reason: 'metadata-unavailable', preview: commitPreview, preRestoreBackup };
    }
    const preflight = preflightDestinationContainers(meta, {
        // Bug fix: a future chat quarantine container only blocks a restore
        // whose plan actually MERGES records into that container. A clean
        // restore (no quarantine additions) never writes it, so an unrelated
        // future container must not block it — the refusal is scoped to plans
        // that would otherwise downgrade the container mid-transaction.
        needsQuarantineMerge: collectChatLocalImportQuarantine(commitPreview).length > 0,
    });
    if (!preflight.ok) {
        return {
            ok: false,
            committed: false,
            reason: preflight.reason,
            warning: preflight.message,
            preview: commitPreview,
            preRestoreBackup,
        };
    }

    // The scope was just verified at
    // beforeCommit, covering the loadWorldInfo gap that resolveKnowledgeStorePlan
    // re-checks when it runs standalone. The ?? fallback keeps callers that hand
    // in a preview without a stashed resolution correct.
    //
    // The plan is also resolved when the import carries Knowledge-store
    // QUARANTINE records without a knowledgeStore section (a recovery export,
    // or a backup written by the earlier implementation): those records ride
    // the lorebook flush into the affected book(s) (§5.1) — resolveKnowledge-
    // StorePlan handles a plan without the section as a quarantine-only commit.
    const knowledgeCommit = (hasKnowledgeStoreSection(envelope)
        || (commitPreview.validation?.quarantine?.knowledgeStore || []).length > 0)
        ? (commitPreview.knowledgeStoreCommit ?? await resolveKnowledgeStorePlan(commitPreview, scope))
        : { ok: true, changed: false };
    if (!knowledgeCommit.ok) {
        if (knowledgeCommit.reason === 'stale-scope') return staleResult(commitPreview, knowledgeCommit.staleReason);
        return { ok: false, committed: false, preview: commitPreview, preRestoreBackup, ...knowledgeCommit };
    }
    const knowledgeFlush = await flushKnowledgeStore(knowledgeCommit, scope, exact);
    if (!knowledgeFlush.ok) {
        if (knowledgeFlush.reason === 'stale-scope') {
            return staleResult(commitPreview, knowledgeFlush.staleReason, {
                partialCommit: knowledgeFlush.partialCommit,
                persistedBooks: knowledgeFlush.persistedBooks,
                rolledBackBooks: knowledgeFlush.rolledBackBooks,
                rollbackFailedBooks: knowledgeFlush.rollbackFailedBooks,
            });
        }
        return { ok: false, committed: false, preview: commitPreview, preRestoreBackup, ...knowledgeFlush };
    }

    // Snapshot the metadata values about to be overwritten so a persist failure
    // can roll them back in memory alongside the lorebook flush. A null sentinel
    // marks a key that did not yet exist (so it can be deleted again on
    // rollback). The schema manifest and the quarantine container snapshot too:
    // they are written in the SAME transaction as the section data (design
    // §7.3/§7.7) — a version marker may never survive a rollback that reverts
    // its data, or the manifest would claim a version the data no longer has.
    const transactionKeys = [
        ...METADATA_SECTION_NAMES.map(sectionName => METADATA_KEYS[sectionName]),
        MANIFEST_METADATA_KEY,
        QUARANTINE_METADATA_KEY,
    ];
    const metaBefore = {};
    for (const key of transactionKeys) {
        metaBefore[key] = Object.prototype.hasOwnProperty.call(meta, key)
            ? cloneBackupData(meta[key])
            : null;
    }
    let mutationsStaged = false;
    try {
        for (const sectionName of METADATA_SECTION_NAMES) {
            if (!Object.prototype.hasOwnProperty.call(commitPreview.plan.sections, sectionName)) continue;
            meta[METADATA_KEYS[sectionName]] = commitPreview.plan.sections[sectionName];
        }
        for (const sectionName of commitPreview.plan.removeMetadataSections || []) {
            delete meta[METADATA_KEYS[sectionName]];
        }
        // ── Same-transaction schema bookkeeping (design §7.7, Part 3) ───────
        //
        // 1. Stamp the schema manifest for every section the restore actually
        //    REWRITES with canonical data (plan.canonicalSections): the plan
        //    re-prepares each completed section (backup/restore.js), so what it
        //    carries is current-version canonical — but a keep/skip section
        //    whose canonical value equals the stored value made NO canonical
        //    change and must not be stamped; the manifest may never claim a
        //    version for data this restore never prepared. The imported
        //    sections were migrated to the CURRENT version during validation
        //    (backup/validate.js prepareBackupSection), so the manifest and the
        //    data land together in this one metadata object and are flushed by
        //    the same save — the §7.3 atomicity rule. Exact restores that
        //    REMOVE a section drop its stamp too, so the manifest never claims
        //    a version for an absent store. The Knowledge lorebook store is
        //    skipped: it keeps its embedded `version` inside the flushed store
        //    itself. A section the restore left DEFERRED (§7.5) is written but
        //    never stamped, and any EXISTING stamp is withheld (removed) in the
        //    same transaction: the manifest may not claim the privileged
        //    conversion ran on data that is still preparing.
        const stampableSections = (Array.isArray(commitPreview.plan.canonicalSections)
            ? commitPreview.plan.canonicalSections
            : METADATA_SECTION_NAMES
                .filter(sectionName => Object.prototype.hasOwnProperty.call(commitPreview.plan.sections, sectionName))
        ).filter(sectionName => METADATA_SECTION_NAMES.includes(sectionName)
            && Object.prototype.hasOwnProperty.call(commitPreview.plan.sections, sectionName));
        const deferredSections = (Array.isArray(commitPreview.plan.deferredSections)
            ? commitPreview.plan.deferredSections
            : []
        ).filter(sectionName => METADATA_SECTION_NAMES.includes(sectionName));
        if (stampableSections.length > 0
            || (commitPreview.plan.removeMetadataSections || []).length > 0
            || deferredSections.length > 0) {
            let manifest = normalizeManifest(meta[MANIFEST_METADATA_KEY]);
            for (const sectionName of stampableSections) {
                manifest = stampStoreVersion(manifest, sectionName, STORE_SCHEMAS[sectionName].currentVersion);
            }
            for (const sectionName of commitPreview.plan.removeMetadataSections || []) {
                delete manifest.sections[sectionName];
            }
            for (const sectionName of deferredSections) {
                delete manifest.sections[sectionName];
            }
            meta[MANIFEST_METADATA_KEY] = manifest;
        }
        // 2. Merge the import's CHAT-METADATA quarantine records into the
        //    chat-local container — never replace it (records already
        //    quarantined in this chat must survive a restore), and never drop
        //    the import's rejected records (design §5.2: they were refused by
        //    the same schema owner that validated the sections, so they stay
        //    recoverable here). Fingerprints dedup a record that was
        //    quarantined in both chats.
        //
        //    PARTITION first (§5.1): `knowledgeStore` findings are excluded —
        //    they belong INSIDE the affected lorebook store(s), which a shared
        //    global/scoped book makes impossible for one chat's metadata to
        //    own. They ride the lorebook flush instead
        //    (resolveKnowledgeStorePlan → flushKnowledgeStore). The same
        //    partition applies to the RECOVERY items: a recovery export or an
        //    older backup can carry store:'knowledgeStore' records, which
        //    planRestore already routed to the book flush — only genuinely
        //    chat-local records reach this merge.
        const importQuarantine = collectChatLocalImportQuarantine(commitPreview);
        if (importQuarantine.length > 0) {
            // Validate (not normalize) the persisted container: the SAME
            // writable-container rule as the preflight (and the write seams,
            // §5.2) applies on this persistence path — a future-version
            // container is refused (never downgraded), and a PRESENT container
            // with non-repair findings is refused too, because merging into
            // the canonical form would replace the malformed raw container and
            // lose its recovery evidence. The preflight above already refused
            // both, so a finding here means one appeared mid-transaction —
            // throw so the guarded block rolls everything back instead of
            // replacing it.
            const writable = assessWritableQuarantineContainer(meta[QUARANTINE_METADATA_KEY]);
            if (!writable.ok) throw new Error(writable.message);
            meta[QUARANTINE_METADATA_KEY] = {
                version: writable.container.version,
                items: mergeQuarantineItems(writable.container.items, importQuarantine),
            };
        }
        mutationsStaged = true;
        await persistChatMetaNow({ strict: true });
    } catch (err) {
        // The durable write failed, or the staged bookkeeping refused after
        // the lorebook flush. Reverse the in-memory metadata mutation and undo
        // the already-durable lorebook flush so the failed restore leaves no
        // partial commit behind — no exception in this transaction may bypass
        // the rollback.
        for (const key of transactionKeys) {
            if (metaBefore[key] === null) {
                if (Object.prototype.hasOwnProperty.call(meta, key)) delete meta[key];
            } else {
                meta[key] = metaBefore[key];
            }
        }
        const storeRollback = knowledgeFlush.persistedBooks.length > 0
            ? await rollbackKnowledgeStore(knowledgeFlush.beforeStore, knowledgeFlush.persistedBooks)
            : { rolledBackBooks: [], rollbackFailedBooks: [] };
        return {
            ok: false,
            committed: false,
            reason: mutationsStaged ? 'metadata-persist-failed' : 'metadata-commit-failed',
            partialCommit: knowledgeFlush.persistedBooks.length > 0,
            persistedBooks: knowledgeFlush.persistedBooks,
            ...storeRollback,
            error: err?.message || String(err),
            preview: commitPreview,
            preRestoreBackup,
        };
    }

    // The downloaded envelope is detached from live metadata by collectBackup,
    // so it is also the exact in-memory snapshot used by session-local undo.
    lastRestore = { envelope: preRestoreBackup, modes, identity: scope.identity };
    return {
        ok: true,
        committed: true,
        preview: commitPreview,
        preRestoreBackup,
    };
}

/** Restore a validated backup after explicit confirmation. */
export async function restoreBackup(envelope, options = {}) {
    if (options.exact === true) {
        // Exact replacement erases whatever the target chat currently holds, so it
        // is gated on a verifiable, same-chat identity. It can never run blind into
        // a chat the build cannot identify, and never across chats — that is the one
        // path that could erase the wrong chat's data.
        const current = getChatIdentity();
        if (current.isUnknown === true) {
            return {
                ok: false,
                committed: false,
                reason: 'exact-identity-required',
                warning: 'This SillyTavern build cannot verify chat identity, so exact (replace) restore is disabled. Only non-destructive merge restore is available.',
            };
        }
        if (!identityMatches(envelope?._meta?.identity, current)) {
            return { ok: false, committed: false, reason: 'exact-cross-chat-blocked' };
        }
        // Known, same-chat identity: permit exact replacement via the undo path.
        return restoreBackupInternal(envelope, options, true);
    }
    return restoreBackupInternal(envelope, options, false);
}

/** Restore the in-memory pre-restore snapshot captured by restoreBackup(). */
export async function undoLastRestore({ confirm = false } = {}) {
    if (!lastRestore) return { ok: false, committed: false, reason: 'no-restore-to-undo' };
    if (!identityMatches(lastRestore.identity, getChatIdentity())) {
        return { ok: false, committed: false, reason: 'restore-origin-mismatch' };
    }
    return restoreBackupInternal(lastRestore.envelope, {
        modes: lastRestore.modes,
        confirm,
        undo: true,
    }, true);
}

export { collectBackup };
