/**
 * knowledge/cleanup_recovery.js — durable recovery storage for reviewed
 * cleanup actions (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md Phase 3;
 * storage decision D1 and retention decision D2 in
 * docs/KNOWLEDGE_CONCISION_DECISIONS.md).
 *
 * THE CONTAINER. Cleanup originals live in a dedicated sentinel entry inside
 * the resolved Knowledge lorebook (`[MWT:cleanup-recovery]`), following the
 * `[MWT:store]` entry's production pattern: no keywords, disabled,
 * non-constant, non-vectorized, recursion-excluded — and those flags are
 * RE-ASSERTED on every write, because `constant` and `vectorized` are the
 * only two flags that bypass keyword matching (knowledge/store.js documents
 * the same reasoning for the store entry). A dedicated entry (rather than a
 * store field) isolates recovery from store hydration/migrations and only
 * re-serializes when recovery actually changes; the payload still rides every
 * whole-book save whichever entry holds it — that cost is inherent to in-book
 * storage and is why D2's controls exist.
 *
 * PERSIST-AND-VERIFY. Every write goes: serialize → save through the awaited
 * checked HTTP request → uncached disk read → byte-compare what came back. A write
 * that cannot be verified THROWS; callers treat that as "do not mutate the
 * target" (fail closed). This is strictly stronger than pushHistory (≤50
 * snapshots, quota errors swallowed), which recovery explicitly does not use.
 *
 * SCHEMA. The container JSON is `{ version, records }` where records are
 * keyed by actionId. A container written by a FUTURE version is refused
 * untouched (the embedded quarantine container's rule): no downgrade, no
 * rewrite — the user is told to upgrade.
 *
 * All container operations run under withStoreLock so recovery writes
 * serialize with store flushes; the lock does NOT make read-modify-save a
 * server-side compare-and-swap (host writers can still interleave — the
 * commit service's post-save verification exists for exactly that).
 */

import { estimateTokens } from '../core/context.js';
import { getChatScopeKey } from '../core/scope.js';
import { state } from './state.js';
import { getLorebookName } from './scope.js';
import {
    applyStoreToWorldInfo, markStoreClean, withStoreLock,
} from './store.js';
import { hostCacheConflict, loadCleanupBook, saveCleanupBook } from './cleanup_persistence.js';

// ─── Sentinels and schema ────────────────────────────────────────────────────

/** Prefix identifying the recovery container entry (comes first in the title). */
export const CLEANUP_RECOVERY_SENTINEL = '[MWT:cleanup-recovery]';

/** Full title written on the container entry (sentinel first: prefix match). */
export const CLEANUP_RECOVERY_COMMENT =
    `${CLEANUP_RECOVERY_SENTINEL} — pre-cleanup originals (0 tokens, never sent to the AI; ` +
    'delete records from the Knowledge recovery view, not here)';

/** Bumped only on a breaking change to the stored shape. */
export const CLEANUP_RECOVERY_VERSION = 1;

/** Record lifecycle. `restored` is the Phase 3 addition to the D1 list: a
 * record whose original was written back by a successful restore. */
export const CLEANUP_STATUSES = Object.freeze([
    'original-saved', 'application-pending', 'applied', 'failed', 'outcome-uncertain', 'restored',
]);

/** What kind of cleanup produced the original. `restore-safeguard` records
 * hold the pre-restore content captured before a restore write. */
export const CLEANUP_ACTION_TYPES = Object.freeze([
    'ledger-condensation', 'field-cleanup', 'restore-safeguard',
]);

/** Is this world-info entry the cleanup-recovery container? */
export function isCleanupRecoveryEntry(entry) {
    return typeof entry?.comment === 'string' && entry.comment.startsWith(CLEANUP_RECOVERY_SENTINEL);
}

/**
 * Stable content fingerprint for revision checks: FNV-1a over the bytes plus
 * the length, rendered as hex. This detects change, not forgery — it is a
 * cheap comparison key, not a cryptographic claim.
 * @param {string} content
 * @returns {string}
 */
export function fingerprintContent(content) {
    const text = String(content ?? '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a-${hash.toString(16)}-${text.length}`;
}

/**
 * Validate one recovery record's shape (pure).
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateCleanupRecordShape(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { ok: false, reason: 'record is not an object' };
    }
    if (typeof record.actionId !== 'string' || !record.actionId) return { ok: false, reason: 'missing actionId' };
    if (typeof record.createdAt !== 'string' || !record.createdAt) return { ok: false, reason: 'missing createdAt' };
    if (typeof record.bookName !== 'string' || !record.bookName) return { ok: false, reason: 'missing bookName' };
    if (typeof record.entityName !== 'string' || !record.entityName) return { ok: false, reason: 'missing entityName' };
    if (!Number.isInteger(record.entryUid) || record.entryUid < 0) return { ok: false, reason: 'missing/invalid entryUid' };
    if (!CLEANUP_ACTION_TYPES.includes(record.actionType)) return { ok: false, reason: `unknown actionType "${record.actionType}"` };
    if (!CLEANUP_STATUSES.includes(record.status)) return { ok: false, reason: `unknown status "${record.status}"` };
    if (typeof record.originalContent !== 'string') return { ok: false, reason: 'missing originalContent' };
    if (record.status === 'applied' && typeof record.approvedReplacement !== 'string') {
        return { ok: false, reason: 'applied record missing approvedReplacement' };
    }
    return { ok: true };
}

/** Parse + validate the raw container content. Future versions refuse whole. */
function parseContainer(rawContent) {    // An absent container is the normal pre-cleanup state, not corruption.
    if (rawContent === undefined || rawContent === null || rawContent === '') {
        return { ok: true, version: CLEANUP_RECOVERY_VERSION, records: {}, issues: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(rawContent);
    } catch {
        return { ok: false, reason: 'container-json-invalid', issues: [] };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'container-root-invalid', issues: [] };
    }
    if (parsed.version !== CLEANUP_RECOVERY_VERSION) {
        return { ok: false, reason: 'future-version', observedVersion: parsed.version, issues: [] };
    }
    const records = (parsed.records && typeof parsed.records === 'object' && !Array.isArray(parsed.records))
        ? parsed.records
        : {};
    // Records that fail shape validation are REPORTED, never silently dropped:
    // the listing surfaces them as unreadable and they are preserved on disk.
    const issues = [];
    const valid = {};
    for (const [actionId, record] of Object.entries(records)) {
        const check = validateCleanupRecordShape(record);
        if (check.ok) valid[actionId] = record;
        else issues.push({ actionId, reason: check.reason });
    }
    return { ok: true, version: parsed.version, records: valid, invalid: records, issues };
}

/** Tolerant raw parse (null on absent/unparseable) — used by the write path. */
function parseRawContainer(rawContent) {
    if (rawContent === undefined || rawContent === null || rawContent === '') return null;
    try {
        const parsed = JSON.parse(rawContent);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch {
        return null;
    }
}

// ─── Container I/O (all persist-and-verify, all under the store lock) ───────

async function loadBook(wiScript, bookName) {
    let wi = await loadCleanupBook(bookName);
    if (!wi || !wi.entries) {
        if (typeof wiScript.createNewWorldInfo === 'function') {
            await wiScript.createNewWorldInfo(bookName);
        }
        wi = await loadCleanupBook(bookName);
        if (!wi || !wi.entries) wi = { entries: {} };
    }
    return wi;
}

function findContainerEntry(wi) {
    return Object.values(wi.entries || {}).find(isCleanupRecoveryEntry) || null;
}

/**
 * Find one valid record in an ALREADY-LOADED book's entries (pure, sync).
 * The commit service runs this inside the writer's final guard: that load is
 * the object the writer saves back, so a record found here lands in the same
 * file write as the target mutation.
 * @returns {object|null} null when the container is absent, unreadable, or
 *   does not hold a valid record for actionId
 */
export function findCleanupRecordInEntries(entries, actionId) {
    const entry = findContainerEntry({ entries });
    if (!entry) return null;
    const parsed = parseContainer(entry.content);
    if (!parsed.ok) return null;
    return parsed.records[actionId] ?? null;
}

/**
 * Read the recovery container (read-only).
 * @returns {Promise<{ok: boolean, reason?: string, version?: number,
 *   records?: Record<string, object>, issues?: Array<{actionId, reason}>}>}
 *   `ok:false` means the container cannot be read safely (corrupt or future
 *   version) — callers must fail closed and never rewrite it.
 */
export async function readCleanupRecoveryContainer(bookName = getLorebookName()) {
    if (!bookName) return { ok: false, reason: 'no-book' };
    if (!state.wiScript) return { ok: false, reason: 'world-info-not-loaded' };
    try {
        const wi = await loadCleanupBook(bookName);
        const entry = wi ? findContainerEntry(wi) : null;
        const parsed = parseContainer(entry?.content);
        if (!parsed.ok) return parsed;
        return { ok: true, version: parsed.version, records: parsed.records, rawRecords: parsed.invalid || {}, storedActionIds: Object.keys(parsed.invalid || {}), issues: parsed.issues || [] };
    } catch (err) {
        return { ok: false, reason: `read-failed: ${err.message}` };
    }
}

/**
 * Write the container: serialize → save (awaited) → RELOAD → byte-verify.
 * Non-injecting flags are (re-)asserted every write. Throws on any failure —
 * fail closed; a failed write leaves the book's prior state in place.
 *
 * @param {string} bookName
 * @param {Record<string, object>} records keyed by actionId (validated first)
 * @param {object} [opts]
 * @param {boolean} [opts.skipUnchanged] skip disk round trip when the serialized
 *   container is byte-identical to what is already stored (default true)
 */
export async function writeCleanupRecoveryContainer(bookName, records, { skipUnchanged = true } = {}) {
    return withStoreLock(() => writeCleanupRecoveryContainerUnlocked(bookName, records, { skipUnchanged }));
}

// Caller must hold withStoreLock across its complete read/modify/write transaction.
async function writeCleanupRecoveryContainerUnlocked(bookName, records, { skipUnchanged = true, deleted = [] } = {}) {
    if (!bookName) throw new Error('cleanup recovery: no Knowledge book resolved');
    if (!state.wiScript) throw new Error('cleanup recovery: world-info.js not loaded');
    const validated = {};
    for (const [actionId, record] of Object.entries(records || {})) {
        const check = validateCleanupRecordShape({ ...record, actionId });
        if (!check.ok) throw new Error(`cleanup recovery: refusing to write record "${actionId}" — ${check.reason}`);
        validated[actionId] = record;
    }

    const wi = await loadBook(state.wiScript, bookName);
    let entry = findContainerEntry(wi);

    // Never overwrite a container this build cannot understand (the
    // embedded quarantine container's rule: no downgrade, no rewrite).
    const existingRaw = parseRawContainer(entry?.content);
    if (existingRaw !== null && Number.isInteger(existingRaw.version)
        && existingRaw.version > CLEANUP_RECOVERY_VERSION) {
        throw new Error(`cleanup recovery: container version ${existingRaw.version} is newer than this build supports (${CLEANUP_RECOVERY_VERSION}) — refusing to overwrite. Upgrade MWT.`);
    }
    // Missing records are not deletions. Preserve all existing records, including
    // unreadable ones; only an explicit deletion removes a record.
    const merged = { ...existingRaw?.records, ...validated };
    for (const actionId of deleted) delete merged[actionId];
    const content = JSON.stringify({ version: CLEANUP_RECOVERY_VERSION, records: merged });

    if (entry && skipUnchanged && entry.content === content) return { unchanged: true };

    // This write is built from disk: refuse while the host holds unsaved
    // state for the book, or its pending save would delete the container.
    const conflict = hostCacheConflict(bookName, wi);
    if (conflict) throw new Error(conflict.error);

    if (!entry) {
        const uids = Object.keys(wi.entries).map(Number).filter(n => Number.isInteger(n));
        const newUid = uids.length > 0 ? Math.max(...uids) + 1 : 0;
        entry = {
            uid: newUid,
            // Structurally non-injecting, mirroring the [MWT:store] entry:
            // no keywords, disabled, and the only two flags that bypass
            // keyword matching (constant, vectorized) hard-false.
            key: [], keysecondary: [], comment: CLEANUP_RECOVERY_COMMENT, content,
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
        // Re-assert the non-injecting flags on EVERY write — a user edit
        // or a lossy host import may have flipped them live.
        entry.key = [];
        entry.keysecondary = [];
        entry.constant = false;
        entry.vectorized = false;
        entry.disable = true;
        entry.enabled = false;
        entry.comment = CLEANUP_RECOVERY_COMMENT;
    }
    applyStoreToWorldInfo(bookName, wi);
    await saveCleanupBook(bookName, wi);

    // VERIFY: reload and byte-compare. An awaited save that cannot be
    // read back has NOT satisfied the persistence contract.
    const reloaded = await loadCleanupBook(bookName);
    const verified = findContainerEntry(reloaded || {});
    if (!verified || verified.content !== content) {
        throw new Error('cleanup recovery: persistence could not be verified (reload mismatch)');
    }
    markStoreClean(bookName);
    return { unchanged: false };
}

// ─── Record lifecycle ────────────────────────────────────────────────────────

/**
 * Save (upsert) a recovery record with persist-and-verify. Called by the
 * commit service BEFORE any target mutation; a throw means "do not apply".
 *
 * @param {object} record — see validateCleanupRecordShape; status starts at
 *   'original-saved' for new cleanup actions
 * @param {object} [opts]
 * @param {string[]} [opts.replaceStatuses] when given, an existing record for
 *   this actionId (readable or not) is replaced only if its status is listed;
 *   otherwise the save throws with err.code 'cleanup-record-exists' and writes
 *   nothing. Checked under the store lock, so a new apply attempt can never
 *   reset a record another attempt has advanced ('applied' → 'original-saved').
 * @returns {Promise<{actionId: string}>}
 */
export async function saveCleanupOriginal(record, { replaceStatuses } = {}) {
    const bookName = record?.bookName || getLorebookName();
    if (!bookName) throw new Error('cleanup recovery: no Knowledge book resolved');
    return withStoreLock(async () => {
        const read = await readCleanupRecoveryContainer(bookName);
        if (!read.ok) throw new Error(`cleanup recovery: container unreadable (${read.reason}) — refusing to save`);
        if (Array.isArray(replaceStatuses) && read.storedActionIds.includes(record.actionId)) {
            const existingStatus = read.records[record.actionId]?.status ?? 'unreadable';
            if (!replaceStatuses.includes(existingStatus)) {
                const err = new Error(`cleanup recovery: action "${record.actionId}" already has a ${existingStatus} record — refusing to overwrite it`);
                err.code = 'cleanup-record-exists';
                err.status = existingStatus;
                throw err;
            }
        }
        const records = { ...read.records, [record.actionId]: { ...record, bookName } };
        await writeCleanupRecoveryContainerUnlocked(bookName, records);
        return { actionId: record.actionId };
    });
}

/**
 * Apply a status/fingerprint patch to one record (persist-and-verify).
 * @param {string} actionId
 * @param {object} patch — merged over the stored record
 */
export async function updateCleanupRecord(actionId, patch, bookName = getLorebookName()) {
    return withStoreLock(async () => {
        const read = await readCleanupRecoveryContainer(bookName);
        if (!read.ok) throw new Error(`cleanup recovery: container unreadable (${read.reason}) — refusing update`);
        const existing = read.records[actionId];
        if (!existing) throw new Error(`cleanup recovery: no record "${actionId}" to update`);
        const next = { ...existing, ...patch };
        const check = validateCleanupRecordShape(next);
        if (!check.ok) throw new Error(`cleanup recovery: patch would invalidate "${actionId}" — ${check.reason}`);
        await writeCleanupRecoveryContainerUnlocked(bookName, { ...read.records, [actionId]: next });
        return next;
    });
}

/** Fetch one record (or null). */
export async function getCleanupRecord(actionId, bookName = getLorebookName()) {
    const read = await readCleanupRecoveryContainer(bookName);
    if (!read.ok) return null;
    return read.records[actionId] ?? null;
}

/**
 * List recovery records for the UI/diagnostics surface (D2: no silent
 * eviction — deletion is explicit and user-driven).
 * @returns {Promise<{ok: boolean, reason?: string, records?: Array<object>, issues?: Array}>}
 */
export async function listCleanupRecovery() {
    const read = await readCleanupRecoveryContainer();
    if (!read.ok) return read;
    const records = Object.values(read.records)
        .map(record => ({
            ...record,
            // Sizes are estimates under the documented chars/4.5 heuristic —
            // never presented as a tokenizer measurement (D4b).
            estimatedTokens: estimateTokens(record.originalContent) + estimateTokens(record.approvedReplacement || ''),
        }))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return { ok: true, version: read.version, records, issues: read.issues || [] };
}

/** Container usage summary: record count plus estimated token size (D2). */
export async function cleanupRecoveryUsage() {
    const listed = await listCleanupRecovery();
    if (!listed.ok) return listed;
    return {
        ok: true,
        count: listed.records.length,
        estimatedTokens: listed.records.reduce((sum, r) => sum + (r.estimatedTokens || 0), 0),
        issues: listed.issues,
    };
}

/**
 * Explicitly delete recovery records (D2). Consequences are the caller's to
 * state; this function only refuses unreadable containers.
 * @param {string[]} actionIds
 * @returns {Promise<{deleted: string[], missing: string[]}>}
 */
export async function deleteCleanupRecords(actionIds) {
    const bookName = getLorebookName();
    return withStoreLock(async () => {
        const read = await readCleanupRecoveryContainer(bookName);
        if (!read.ok) throw new Error(`cleanup recovery: container unreadable (${read.reason}) — refusing to delete`);
        const wanted = new Set(Array.isArray(actionIds) ? actionIds : [actionIds]);
        const records = {};
        const deleted = [];
        const missing = [];
        for (const actionId of read.storedActionIds) if (wanted.has(actionId)) deleted.push(actionId);
        for (const [actionId, record] of Object.entries(read.records)) if (!wanted.has(actionId)) records[actionId] = record;
        for (const actionId of wanted) if (!deleted.includes(actionId)) missing.push(actionId);
        if (deleted.length > 0) await writeCleanupRecoveryContainerUnlocked(bookName, records, { deleted });
        return { deleted, missing };
    });
}

// ─── Export / import (D2/D3: a labeled, versioned, validated round trip) ─────

export const CLEANUP_RECOVERY_EXPORT_TYPE = 'mwt-cleanup-recovery';

/**
 * Export records as a clearly labeled JSON payload (all records by default).
 * @param {string[]} [actionIds]
 * @returns {Promise<{type: string, version: number, exportedAt: string, bookName: string, records: object}>}
 */
export async function exportCleanupRecovery(actionIds) {
    const read = await readCleanupRecoveryContainer();
    if (!read.ok) throw new Error(`cleanup recovery: container unreadable (${read.reason}) — refusing to export`);
    const wanted = actionIds ? new Set(Array.isArray(actionIds) ? actionIds : [actionIds]) : null;
    const records = {};
    for (const [actionId, record] of Object.entries(read.rawRecords)) {
        if (!wanted || wanted.has(actionId)) records[actionId] = record;
    }
    return {
        type: CLEANUP_RECOVERY_EXPORT_TYPE,
        version: CLEANUP_RECOVERY_VERSION,
        exportedAt: new Date().toISOString(),
        bookName: getLorebookName(),
        records,
    };
}

/**
 * Import records from an export payload. Current-wins on actionId collisions
 * (the stored record is kept); unknown/unreadable payloads reject whole with
 * no partial writes. Records are re-stamped for the CURRENT book so an import
 * from another book's export lands where the user imported it.
 *
 * @param {object} payload — parsed JSON from exportCleanupRecovery
 * @returns {Promise<{added: string[], kept: string[], rejected: string[]}>}
 */
export async function importCleanupRecovery(payload) {
    if (!payload || typeof payload !== 'object' || payload.type !== CLEANUP_RECOVERY_EXPORT_TYPE) {
        throw new Error('cleanup recovery import: not an MWT cleanup-recovery export');
    }
    if (payload.version !== CLEANUP_RECOVERY_VERSION) {
        throw new Error(`cleanup recovery import: unsupported version ${payload.version} (expected ${CLEANUP_RECOVERY_VERSION})`);
    }
    const bookName = getLorebookName();
    return withStoreLock(async () => {
        const read = await readCleanupRecoveryContainer(bookName);
        if (!read.ok) throw new Error(`cleanup recovery: container unreadable (${read.reason}) — refusing import`);
        const records = { ...read.records };
        const added = [];
        const kept = [];
        const rejected = [];
        for (const [actionId, record] of Object.entries(payload.records || {})) {
            const candidate = { ...record, actionId, bookName };
            const check = validateCleanupRecordShape(candidate);
            if (!check.ok) { rejected.push(`${actionId} (${check.reason})`); continue; }
            if (read.storedActionIds.includes(actionId)) kept.push(actionId);
            else added.push(actionId);
            // Current-wins: an existing record is never overwritten by an import.
            if (!read.storedActionIds.includes(actionId)) records[actionId] = candidate;
        }
        if (added.length > 0) await writeCleanupRecoveryContainerUnlocked(bookName, records);
        return { added, kept, rejected };
    });
}

/** The scope key stamped onto records captured in the current chat scope. */
export function currentCleanupScopeKey() {
    return getChatScopeKey();
}
