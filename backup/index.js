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
    captureStoreState,
    flushBook,
    isHydrated,
    isStoreEntry,
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

function hasKnowledgeStoreSection(envelope) {
    return Object.prototype.hasOwnProperty.call(envelope?.sections || {}, 'knowledgeStore');
}

function collectCurrentKnowledgeStore() {
    const knowledgeBook = getLorebookName();
    const stateBook = getStateLorebookName();
    if (!isHydrated(knowledgeBook) || !isHydrated(stateBook)) {
        return null;
    }
    return {
        version: STORE_VERSION,
        registry: getRegistry(),
        relationships: getRelationships(),
        stances: getStances(),
        stanceSources: getStanceSources(),
        stateRegistry: getStateRegistry(),
    };
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
 * Resolve new registry names against the destination books. Unified backups do
 * not include lorebook text, so an unresolved name cannot be safely created;
 * it is omitted rather than persisting a null or source-local UID.
 */
async function resolveKnowledgeStorePlan(preview, scope) {
    const planned = preview.plan.sections.knowledgeStore;
    if (!planned) return { ok: true, changed: false };
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
    changed = changed
        || JSON.stringify(current.relationships) !== JSON.stringify(resolved.relationships)
        || JSON.stringify(current.stances) !== JSON.stringify(resolved.stances)
        || JSON.stringify(current.stanceSources) !== JSON.stringify(resolved.stanceSources)
        || JSON.stringify(current.registry) !== JSON.stringify(resolved.registry)
        || JSON.stringify(current.stateRegistry) !== JSON.stringify(resolved.stateRegistry);
    const knowledgeChanged = JSON.stringify(current.registry) !== JSON.stringify(resolved.registry)
        || JSON.stringify(current.relationships) !== JSON.stringify(resolved.relationships)
        || JSON.stringify(current.stances) !== JSON.stringify(resolved.stances)
        || JSON.stringify(current.stanceSources) !== JSON.stringify(resolved.stanceSources);
    const stateChanged = JSON.stringify(current.stateRegistry) !== JSON.stringify(resolved.stateRegistry);
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

function exactSectionSummary(current, imported, sectionName) {
    const hasCurrent = Object.prototype.hasOwnProperty.call(current, sectionName);
    const hasImported = Object.prototype.hasOwnProperty.call(imported, sectionName);
    if (!hasImported) {
        return { mode: 'exact', action: hasCurrent ? 'removed' : 'unchanged', replaced: 0, removed: hasCurrent ? 1 : 0, unchanged: hasCurrent ? 0 : 1, skipped: [], conflicts: 0 };
    }
    const unchanged = hasCurrent && backupDataEqual(current[sectionName], imported[sectionName]);
    return { mode: 'exact', action: unchanged ? 'unchanged' : 'replaced', replaced: unchanged ? 0 : 1, removed: 0, unchanged: unchanged ? 1 : 0, skipped: [], conflicts: 0 };
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
    const sections = {};
    for (const sectionName of METADATA_SECTION_NAMES) {
        if (Object.prototype.hasOwnProperty.call(imported, sectionName)) {
            sections[sectionName] = cloneBackupData(imported[sectionName]);
        }
    }
    if (Object.prototype.hasOwnProperty.call(imported, 'knowledgeStore')) {
        sections.knowledgeStore = cloneBackupData(resolvedKnowledgeStore);
    }
    preview.plan = {
        ...preview.plan,
        sections,
        removeMetadataSections: METADATA_SECTION_NAMES
            .filter(sectionName => !Object.prototype.hasOwnProperty.call(imported, sectionName)),
        exactKnowledgeStore: Object.prototype.hasOwnProperty.call(imported, 'knowledgeStore'),
    };
    for (const sectionName of METADATA_SECTION_NAMES) {
        preview.summary[sectionName] = exactSectionSummary(current, imported, sectionName);
    }
    if (Object.prototype.hasOwnProperty.call(imported, 'knowledgeStore')) {
        const fullStore = collectCurrentKnowledgeStore() || {};
        // The store version lives on the section wrapper (storeVersion), not in
        // the data; exclude it so an unchanged exact
        // Knowledge restore reports "unchanged" rather than "replaced".
        // Order-insensitive compare so key-order differences no longer report a
        // semantic no-op as "replaced".
        const { version: _storeVersion, ...currentStoreData } = fullStore;
        const unchanged = backupDataEqual(currentStoreData, sections.knowledgeStore);
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

    // The scope was just verified at
    // beforeCommit, covering the loadWorldInfo gap that resolveKnowledgeStorePlan
    // re-checks when it runs standalone. The ?? fallback keeps callers that hand
    // in a preview without a stashed resolution correct.
    const knowledgeCommit = hasKnowledgeStoreSection(envelope)
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

    const meta = getChatMeta();
    if (!meta) {
        if (knowledgeFlush.persistedBooks.length > 0) {
            await rollbackKnowledgeStore(knowledgeFlush.beforeStore, knowledgeFlush.persistedBooks);
        }
        return { ok: false, committed: false, reason: 'metadata-unavailable', preview: commitPreview, preRestoreBackup };
    }
    // Snapshot the metadata values about to be overwritten so a persist failure
    // can roll them back in memory alongside the lorebook flush. A null sentinel
    // marks a key that did not yet exist (so it can be deleted again on rollback).
    const metaBefore = {};
    for (const sectionName of METADATA_SECTION_NAMES) {
        const key = METADATA_KEYS[sectionName];
        metaBefore[key] = Object.prototype.hasOwnProperty.call(meta, key)
            ? cloneBackupData(meta[key])
            : null;
    }
    for (const sectionName of METADATA_SECTION_NAMES) {
        if (!Object.prototype.hasOwnProperty.call(commitPreview.plan.sections, sectionName)) continue;
        meta[METADATA_KEYS[sectionName]] = commitPreview.plan.sections[sectionName];
    }
    for (const sectionName of commitPreview.plan.removeMetadataSections || []) {
        delete meta[METADATA_KEYS[sectionName]];
    }
    try {
        await persistChatMetaNow({ strict: true });
    } catch (err) {
        // Metadata never reached disk. Reverse the in-memory metadata mutation
        // and undo the already-durable lorebook flush so the failed restore
        // leaves no partial commit behind.
        for (const sectionName of METADATA_SECTION_NAMES) {
            const key = METADATA_KEYS[sectionName];
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
            reason: 'metadata-persist-failed',
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
