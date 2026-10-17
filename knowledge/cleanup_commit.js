/**
 * knowledge/cleanup_commit.js — the guarded cleanup commit service
 * (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md Phase 3).
 *
 * A DEDICATED path, not a staging-acceptance shortcut: cleanup application
 * requires explicit user approval of the final validated draft and NEVER runs
 * through handleAccept / Accept All / scanAndAccept. Its guarantees:
 *
 *   CAPTURE — before generation: scope token, resolved book, stable entity id,
 *   entry uid, and the exact original content (+fingerprint) are bound
 *   together. Display names alone never identify a destination.
 *
 *   APPLY — re-verify EVERYTHING at commit time (scope, book, hydration,
 *   strict entry identity, entity id, unique destination, unchanged source),
 *   then persist-and-verify the recovery original BEFORE the target is
 *   touched, re-check the destination after that asynchronous persistence
 *   step, write through the ordinary writeToLorebook path (latest book, other
 *   entries and the embedded store preserved), and verify the replacement
 *   landed by reloading. Success is marked only after the persistence
 *   contract succeeds; anything ambiguous becomes 'outcome-uncertain' and is
 *   reconciled by reloading — a retry can neither duplicate an operation nor
 *   blindly roll back newer work.
 *
 *   RESTORE — span-aware: only the cleanup-owned span is compared and
 *   rewritten (the caller supplies the span extractor; Phase 4 wires the
 *   ledger-section one), so newer unrelated edits outside the span survive.
 *   If the touched span changed since apply, restore refuses with a conflict
 *   and offers export instead of a blind overwrite. A restore-safeguard
 *   recovery record captures the pre-restore content before the write.
 *
 * THE GUARD/WRITE INTERVAL, STATED HONESTLY: the final guards run synchronously
 * inside the writer after its last uncached load, before mutation — including
 * a check that the recovery record is IN that load, because the load is what
 * the save writes back (a record verified earlier can still be clobbered by a
 * host-cache writer before then). The save
 * remains a client-side read-modify-save — NOT a server-side compare-and-swap. Other
 * writers that can interleave: staging accepts, the World Info editor, host
 * imports/exports, relationship sync. The post-save verification step exists
 * precisely to catch a lost update: if the reloaded content is not the
 * replacement, the outcome is marked uncertain and reported, never silently
 * accepted. (Store-field writes are serialized via withStoreLock; entry
 * writes deliberately use the same unlocked load-modify-save pattern as every
 * other entry writer — nesting the lock here would deadlock the recovery
 * writes, which take it themselves.)
 */

import { captureScope } from '../core/index.js';
import { scopeStillCurrent } from '../core/scope.js';
import { state } from './state.js';
import { getLorebookName } from './scope.js';
import { writeToLorebook } from './lorebook.js';
import { normalizeRegistryName } from './registry.js';
import { getEntityId } from './identity.js';
import { findEntryUidByNpcIdentity } from './reconcile.js';
import { assertHydrated } from './store.js';
import { loadCleanupBook } from './cleanup_persistence.js';
import {
    fingerprintContent, getCleanupRecord, saveCleanupOriginal, updateCleanupRecord,
    currentCleanupScopeKey, findCleanupRecordInEntries, readCleanupRecoveryContainer,
} from './cleanup_recovery.js';

/**
 * Action ids with an apply running in this session. Overlapping applies of ONE
 * action share ONE recovery record: the attempt that lost the race used to
 * overwrite the winner's 'applied' with 'failed', leaving a landed cleanup
 * unrestorable. (saveCleanupOriginal's replaceStatuses precondition is the
 * second line: a later attempt can never reset an advanced record.)
 */
const applyInFlight = new Set();

/**
 * Prior statuses a retry of the same action may replace. Both mean the target
 * was never written: 'original-saved' is the record a crash or failed
 * 'application-pending' update leaves behind, and the status always advances
 * to 'application-pending' before the target write. A running attempt for the
 * same id is excluded by applyInFlight, not by this list.
 */
const RETRYABLE_PRIOR_STATUSES = ['failed', 'original-saved'];

// ─── Shared guards ──────────────────────────────────────────────────────────

/**
 * Strict label check for cleanup destinations: the entry's comment must be
 * the SAME normalized name. Cleanup is stricter than ordinary updates on
 * purpose — an alias adoption is fine for a scan, not for replacing bytes.
 */
function labelMatches(entry, name) {
    const comment = String(entry?.comment ?? '').trim();
    if (!comment) return false;
    return normalizeRegistryName(comment) === normalizeRegistryName(name);
}

async function loadBookEntries(bookName = getLorebookName()) {
    if (!state.wiScript) throw new Error('world-info.js not loaded');
    if (!bookName) throw new Error('Knowledge lorebook name collision — no book resolved');
    const wi = await state.wiScript.loadWorldInfo(bookName);
    return { bookName, entries: wi?.entries || {} };
}

/**
 * Whole-content span (the default when no span extractor is supplied):
 * restore then requires the entire entry to still equal the applied
 * replacement — correct, because without span knowledge we cannot separate
 * newer unrelated edits from touched-field changes.
 */
export function wholeContentSpan(content) {
    const text = String(content ?? '');
    return { start: 0, end: text.length };
}

// ─── Capture ────────────────────────────────────────────────────────────────

/**
 * Capture the cleanup target before generation: identity bindings + the exact
 * original content. Throws on any refusal — callers surface the message.
 *
 * @param {object} opts
 * @param {string} opts.name canonical registry key of the NPC
 * @param {number} opts.uid Knowledge lorebook uid
 * @returns {Promise<{name: string, uid: number, bookName: string, entityId: string|null,
 *   scopeKey: string, scopeToken: object, originalContent: string,
 *   originalFingerprint: string, keywords: string[]}>}
 */
export async function captureCleanupTarget({ name, uid }) {
    const { bookName, entries } = await loadBookEntries();
    assertHydrated(bookName, `capture a cleanup target for "${name}"`);

    const entry = entries[uid];
    if (!entry) throw new Error(`Cleanup refused: entry uid ${uid} for "${name}" no longer exists in "${bookName}".`);
    if (!labelMatches(entry, name)) {
        throw new Error(`Cleanup refused: entry uid ${uid} is labelled "${String(entry.comment || '').trim()}", not "${name}" (rename/merge or stale uid).`);
    }
    const identity = findEntryUidByNpcIdentity(entries, name);
    if (!identity || identity.uid !== uid || identity.duplicates > 1) {
        throw new Error(`Cleanup refused: "${name}" does not resolve to exactly one destination entry (found ${identity ? `${identity.duplicates} candidate(s)` : 'none'}). Resolve duplicates first (MWT.npcs.auditDuplicates()).`);
    }

    return {
        name, uid, bookName,
        entityId: getEntityId(name),
        scopeKey: currentCleanupScopeKey(),
        scopeToken: captureScope(),
        originalContent: entry.content || '',
        originalFingerprint: fingerprintContent(entry.content || ''),
        keywords: Array.isArray(entry.key) ? entry.key : [name],
    };
}

// ─── Apply ──────────────────────────────────────────────────────────────────

function refusal(code, message, extra = {}) {
    return { ok: false, code, error: message, ...extra };
}

// Synchronous checks are repeated after each asynchronous destination reload.
function checkCapturedDestination(capture, entries) {
    const scope = scopeStillCurrent(capture.scopeToken);
    if (!scope.ok || currentCleanupScopeKey() !== capture.scopeKey) return refusal('scope-changed', 'Cleanup refused: the chat scope changed during persistence.');
    if (getLorebookName() !== capture.bookName) return refusal('book-changed', 'Cleanup refused: the resolved Knowledge book changed during persistence.');
    try {
        assertHydrated(capture.bookName, `write cleanup for "${capture.name}"`);
    } catch (err) {
        return refusal('store-not-hydrated', err.message);
    }
    const entry = entries[capture.uid];
    if (!entry) return refusal('destination-missing', 'Cleanup destination no longer exists.');
    if (!labelMatches(entry, capture.name)) return refusal('identity-mismatch', 'Cleanup destination identity changed.');
    if (getEntityId(capture.name) !== capture.entityId) return refusal('entity-changed', 'Cleanup entity identity changed.');
    const identity = findEntryUidByNpcIdentity(entries, capture.name);
    if (!identity || identity.uid !== capture.uid || identity.duplicates > 1) return refusal('destination-ambiguous', 'Cleanup destination is no longer unique.');
    return null;
}

/**
 * The recovery record must be present in the writer's FINAL load: that object
 * is what the save writes back, so a record found there lands in the same file
 * write as the mutation. Earlier verification alone is not enough — with no
 * server-side compare-and-swap, a host-cache writer can replace the book after
 * the record verified, and the mutation would then land with no recovery.
 */
function checkRecoveryOnFinalLoad(entries, actionId, expected, message) {
    const record = findCleanupRecordInEntries(entries, actionId);
    const intact = record && Object.entries(expected).every(([key, value]) => record[key] === value);
    return intact ? null : refusal('recovery-missing', message);
}

async function tryUpdateCleanupRecord(actionId, patch, bookName) {
    try {
        await updateCleanupRecord(actionId, patch, bookName);
        return true;
    } catch (err) {
        console.warn('[MWT:Knowledge] cleanup status could not be persisted:', err?.message || err);
        return false;
    }
}

/**
 * Apply a reviewed cleanup replacement under full re-verification.
 *
 * @param {object} opts
 * @param {object} opts.capture from captureCleanupTarget
 * @param {string} opts.replacement the final user-approved replacement content
 * @param {string} opts.actionId unique action id (one per reviewed apply)
 * @param {string} [opts.actionType='ledger-condensation']
 * @param {(ctx: {original: string, replacement: string, capture: object}) => {ok: boolean, reason?: string}} [opts.validate]
 *   caller-supplied final validation (Phase 4 wires boundary/coverage/ownership);
 *   runs AFTER the stale-source check, BEFORE any persistence.
 * @returns {Promise<{ok: boolean, code?: string, error?: string, actionId?: string, uid?: number,
 *   reconciled?: boolean}>} `reconciled: true` means the save reported an error
 *   but re-reading the entry proved the replacement landed.
 */
export async function applyCleanup(opts) {
    const actionId = opts?.actionId;
    if (actionId && applyInFlight.has(actionId)) {
        return refusal('in-progress', `Cleanup refused: action "${actionId}" is already being applied.`);
    }
    if (actionId) applyInFlight.add(actionId);
    try {
        return await applyCleanupOnce(opts);
    } finally {
        if (actionId) applyInFlight.delete(actionId);
    }
}

async function applyCleanupOnce({ capture, replacement, actionId, actionType = 'ledger-condensation', validate }) {
    const name = capture?.name;
    const uid = capture?.uid;
    if (!name || !Number.isInteger(uid) || typeof replacement !== 'string' || !actionId) {
        return refusal('bad-request', 'applyCleanup: capture, replacement, and actionId are required');
    }

    // 1. Scope: a chat switch after generation retires the operation.
    const scope = scopeStillCurrent(capture.scopeToken);
    if (!scope.ok) return refusal('scope-changed', `Cleanup refused: the chat changed since the proposal was generated (${scope.reason}).`);
    const bookName = getLorebookName();
    if (bookName !== capture.bookName) {
        return refusal('book-changed', `Cleanup refused: the resolved Knowledge book changed ("${capture.bookName}" → "${bookName}").`);
    }
    try {
        assertHydrated(bookName, `apply cleanup for "${name}"`);
    } catch (err) {
        return refusal('store-not-hydrated', err.message);
    }

    // 2. Destination: strict identity, entity stability, unchanged source.
    let entries;
    try {
        ({ entries } = await loadBookEntries());
    } catch (err) {
        return refusal('load-failed', err.message);
    }
    const entry = entries[uid];
    if (!entry) return refusal('destination-missing', `Cleanup refused: entry uid ${uid} for "${name}" no longer exists.`);
    if (!labelMatches(entry, name)) {
        return refusal('identity-mismatch', `Cleanup refused: entry uid ${uid} is labelled "${String(entry.comment || '').trim()}", not "${name}" (rename/merge or stale uid).`);
    }
    const entityIdNow = getEntityId(name);
    if (capture.entityId !== entityIdNow) {
        return refusal('entity-changed', `Cleanup refused: "${name}" was renamed/merged since the proposal was generated.`);
    }

    // 3. Duplicate-apply guard — BEFORE the stale-source check: after a
    //    successful apply the entry legitimately holds the replacement, which
    //    the source check would otherwise misread as staleness. An uncertain
    //    prior attempt is reconciled by reloading first — a retry must not
    //    duplicate the operation.
    const prior = await getCleanupRecord(actionId, bookName);
    if (prior) {
        if (['outcome-uncertain', 'application-pending'].includes(prior.status)) {
            const reconciled = await reconcileOutcome(actionId, { replacement, bookName });
            if (reconciled.status === 'applied') {
                return refusal('duplicate', 'Cleanup was already applied (a previous attempt reported an uncertain outcome; re-verification confirmed it landed).');
            }
            if (reconciled.status !== 'failed') {
                return refusal('outcome-uncertain', 'A previous attempt for this action left an uncertain outcome that could not be reconciled — reload the chat and retry.');
            }
        } else if (!RETRYABLE_PRIOR_STATUSES.includes(prior.status)) {
            return refusal('duplicate', `Cleanup refused: action "${actionId}" is already ${prior.status}.`, { status: prior.status });
        }
        if (prior.originalContent !== capture.originalContent) {
            return refusal('stale-source', 'Cleanup refused: this action id was captured against different source content.');
        }
    }

    const currentContent = entry.content || '';
    if (currentContent !== capture.originalContent) {
        return refusal('stale-source', 'Cleanup refused: the entry changed after the proposal was generated (a background update or manual edit). Regenerate the proposal.');
    }

    // 4. Caller-supplied final validation (boundary/coverage/ownership in
    //    Phase 4). Runs before ANY persistence.
    if (typeof validate === 'function') {
        const check = validate({ original: currentContent, replacement, capture });
        if (!check?.ok) return refusal('validation-failed', check?.reason || 'final validation failed');
    }

    // 5. Unique destination (duplicate entries make "the" target ambiguous).
    const identity = findEntryUidByNpcIdentity(entries, name);
    if (!identity || identity.uid !== uid || identity.duplicates > 1) {
        return refusal('destination-ambiguous', `Cleanup refused: "${name}" does not resolve to exactly this entry (${identity ? `${identity.duplicates} candidate(s)` : 'none'}).`);
    }

    // 6. Persist-and-verify the ORIGINAL before the target is touched. A
    //    failure here aborts with nothing mutated (fail closed).
    const record = {
        actionId,
        createdAt: new Date().toISOString(),
        bookName,
        scopeKey: capture.scopeKey,
        entityName: name,
        entityId: capture.entityId,
        entryUid: uid,
        actionType,
        status: 'original-saved',
        originalContent: capture.originalContent,
        approvedReplacement: replacement,
        replacementFingerprint: fingerprintContent(replacement),
    };
    try {
        // Only an absent or never-written (failed / original-saved) record may
        // be replaced: an attempt that advanced (pending, applied, …) is never
        // reset by a newer one.
        await saveCleanupOriginal(record, { replaceStatuses: RETRYABLE_PRIOR_STATUSES });
        await updateCleanupRecord(actionId, { status: 'application-pending' }, bookName);
    } catch (err) {
        if (err?.code === 'cleanup-record-exists') {
            return refusal('duplicate', `Cleanup refused: action "${actionId}" already has a ${err.status} recovery record.`, { status: err.status });
        }
        return refusal('recovery-persist-failed', `Cleanup refused: the recovery original could not be saved and verified — nothing was changed. (${err.message})`);
    }

    // 7. Re-check the destination AFTER the asynchronous recovery
    //    persistence: the source must still be byte-identical right before
    //    the write. This is the explicit guard→write interval (see header).
    try {
        const recheck = await loadBookEntries(bookName);
        const guard = checkCapturedDestination(capture, recheck.entries);
        if (guard) {
            await tryUpdateCleanupRecord(actionId, { status: 'failed', failedReason: guard.code }, bookName);
            return guard;
        }
        const reEntry = recheck.entries[uid];
        if (!reEntry || !labelMatches(reEntry, name) || (reEntry.content || '') !== capture.originalContent) {
            await tryUpdateCleanupRecord(actionId, { status: 'failed', failedReason: 'source-changed-during-persist' }, bookName);
            return refusal('source-changed-during-persist', 'Cleanup refused: the entry changed while the recovery original was being saved.');
        }
    } catch (err) {
        await tryUpdateCleanupRecord(actionId, { status: 'failed', failedReason: `recheck-failed: ${err.message}` }, bookName);
        return refusal('recheck-failed', err.message);
    }

    // 8. Write through the ordinary guarded writer: latest book, identity
    //    checks, store folded, awaited save. Unrelated entries and the
    //    embedded store are preserved (no generation-time snapshot).
    const write = await writeToLorebook(name, replacement, capture.keywords, uid, {
        bookName,
        beforeWrite: finalEntries => checkCapturedDestination(capture, finalEntries)
            || ((finalEntries[uid].content || '') !== capture.originalContent
                ? refusal('source-changed-during-persist', 'Cleanup refused: the entry changed before the final write.') : null)
            || checkRecoveryOnFinalLoad(finalEntries, actionId, {
                status: 'application-pending', originalContent: capture.originalContent, approvedReplacement: replacement,
            }, 'Cleanup refused: the recovery original is no longer in the book (another writer replaced it after it was saved). Nothing was changed — retry to save it again.'),
    });
    if (!write.success) {
        if (write.refusal) {
            // A guard refusal happens before any mutation: definitively failed.
            await tryUpdateCleanupRecord(actionId, { status: 'failed', failedReason: write.error }, bookName);
            return write.refusal;
        }
        // A save ERROR is ambiguous: the request may have reached the server
        // before it failed (dropped response, timeout). Marking it failed
        // blind would strand a landed replacement — retry refuses as stale,
        // restore refuses as not-applied. Reload and reconcile instead.
        await tryUpdateCleanupRecord(actionId, { status: 'outcome-uncertain', failedReason: `target save error: ${write.error}` }, bookName);
        const reconciled = await reconcileOutcome(actionId, { replacement, bookName });
        if (reconciled.status === 'applied') return { ok: true, actionId, uid, reconciled: true };
        if (reconciled.status === 'failed') {
            return refusal('target-save-failed', `Cleanup apply failed while saving: ${write.error}. Re-reading the entry confirmed it is unchanged; the recovery original is preserved.`);
        }
        return refusal('outcome-uncertain', `Cleanup outcome uncertain: saving reported an error (${write.error}) and re-reading could not settle whether the replacement landed${reconciled.detail ? ` (${reconciled.detail})` : ''}. Retry this action to reconcile it.`);
    }

    // 9. Post-save verification: reload and compare. Ambiguity is reconciled
    //    by reloading (once more) — never by assuming success.
    let landed;
    try {
        landed = await readEntryContentStrict(uid, name, bookName);
        if (landed !== replacement) landed = await readEntryContentStrict(uid, name, bookName);
    } catch (err) {
        await tryUpdateCleanupRecord(actionId, { status: 'outcome-uncertain', failedReason: `post-save verify failed: ${err.message}` }, bookName);
        return refusal('outcome-uncertain', `Cleanup outcome uncertain: the entry could not be re-read after saving (${err.message}). Retry this action to reconcile it.`);
    }
    if (landed !== replacement) {
        await tryUpdateCleanupRecord(actionId, {
            status: 'outcome-uncertain',
            failedReason: `post-save verification saw unexpected content (fingerprint ${fingerprintContent(landed)})`,
        }, bookName);
        return refusal('outcome-uncertain', 'Cleanup outcome uncertain: the save reported success but the reloaded entry does not match the replacement. Reconcile from the recovery view before retrying.');
    }
    try {
        await updateCleanupRecord(actionId, { status: 'applied', appliedAt: new Date().toISOString() }, bookName);
    } catch (err) {
        // The replacement is verified on disk; only the status lagged. The
        // record stays application-pending, which a retry reconciles.
        return refusal('outcome-uncertain', `Cleanup was applied and verified, but its recovery record could not be marked applied (${err.message}). Retry this action to reconcile it before restoring.`);
    }
    return { ok: true, actionId, uid: write.uid ?? uid };
}

async function readEntryContentStrict(uid, name, bookName = getLorebookName()) {
    const { entries } = await loadCleanupBook(bookName);
    const entry = entries[uid];
    if (!entry) throw new Error(`entry uid ${uid} disappeared`);
    if (!labelMatches(entry, name)) throw new Error(`entry uid ${uid} is no longer labelled "${name}"`);
    return entry.content || '';
}

/**
 * Reconcile a pending or outcome-uncertain record by reloading the entry: if the
 * replacement landed, mark applied; if the original is still there, mark
 * failed; otherwise stay uncertain and say so. An action whose apply is still
 * running is left alone ('in-progress'): reading the entry mid-apply would
 * mark failed a replacement that is about to land.
 * @returns {Promise<{status: string, detail?: string}>}
 */
export async function reconcileCleanupOutcome(actionId, opts = {}) {
    if (applyInFlight.has(actionId)) return { status: 'in-progress', detail: 'an apply for this action is still running' };
    return reconcileOutcome(actionId, opts);
}

async function reconcileOutcome(actionId, { replacement, bookName = getLorebookName() } = {}) {
    const record = await getCleanupRecord(actionId, bookName);
    if (!record) return { status: 'unknown', detail: 'no such record' };
    const restore = await reconcileRestore(record, bookName);
    if (restore) return restore;
    if (!['outcome-uncertain', 'application-pending'].includes(record.status)) return { status: record.status };
    let content;
    try {
        content = await readEntryContentStrict(record.entryUid, record.entityName, bookName);
    } catch (err) {
        return { status: 'outcome-uncertain', detail: err.message };
    }
    const expected = typeof replacement === 'string' ? replacement : record.approvedReplacement;
    if (expected != null && content === expected) {
        if (!await tryUpdateCleanupRecord(actionId, { status: 'applied', appliedAt: new Date().toISOString() }, bookName)) return { status: 'outcome-uncertain', detail: 'replacement landed but status could not be persisted' };
        return { status: 'applied' };
    }
    if (content === record.originalContent) {
        const failedReason = `reconciled: replacement never landed${record.failedReason ? ` (${record.failedReason})` : ''}`;
        if (!await tryUpdateCleanupRecord(actionId, { status: 'failed', failedReason }, bookName)) return { status: 'outcome-uncertain', detail: 'status could not be persisted' };
        return { status: 'failed' };
    }
    return { status: 'outcome-uncertain', detail: 'entry holds neither the replacement nor the original — manual reconciliation needed' };
}

// ─── Restore ────────────────────────────────────────────────────────────────

/** Pending safeguards also journal the exact restore write, allowing retries
 * to settle a lost response without blindly writing the original again. */
async function reconcileRestore(record, bookName) {
    const read = await readCleanupRecoveryContainer(bookName);
    if (!read.ok) return { status: 'outcome-uncertain', detail: read.reason };
    const attempts = Object.values(read.records).filter(r => r.actionType === 'restore-safeguard'
        && r.parentActionId === record.actionId && (r.status === 'application-pending'
            || (r.status === 'applied' && record.status === 'applied')));
    if (!attempts.length) return null;
    try {
        const entries = (await loadCleanupBook(bookName)).entries;
        const guard = checkCapturedDestination({ scopeToken: captureScope(), scopeKey: record.scopeKey,
            bookName, name: record.entityName, uid: record.entryUid, entityId: record.entityId }, entries);
        if (guard) return { status: 'outcome-uncertain', detail: guard.error };
        const content = entries[record.entryUid].content || '';
        for (const attempt of attempts.reverse()) {
            if (content === attempt.approvedReplacement) {
                await updateCleanupRecord(attempt.actionId, { status: 'applied', appliedAt: new Date().toISOString() }, bookName);
                await updateCleanupRecord(record.actionId, { status: 'restored', restoredAt: new Date().toISOString() }, bookName);
                return { status: 'restored', restoredContent: content };
            }
            if (content !== attempt.originalContent) return { status: 'outcome-uncertain', detail: 'entry holds neither the pre-restore content nor the restore draft' };
            await updateCleanupRecord(attempt.actionId, { status: 'failed' }, bookName);
        }
        return { status: record.status, restoreFailed: true };
    } catch (err) {
        return { status: 'outcome-uncertain', detail: err.message };
    }
}

/**
 * Restore a cleanup-owned span from a recovery record.
 *
 * Only the span is compared against the applied replacement and only the span
 * is rewritten: newer unrelated edits outside the span survive byte-for-byte.
 * A touched-span change since apply is a conflict — refused with an export
 * offer, never blindly overwritten. A restore-safeguard record captures the
 * pre-restore content before the write.
 *
 * @param {object} opts
 * @param {string} opts.actionId
 * @param {(content: string) => {start: number, end: number}|null} [opts.spanOf]
 *   span extractor (default: whole content)
 * @returns {Promise<{ok: boolean, code?: string, error?: string, conflict?: object,
 *   restoredContent?: string}>}
 */
export async function restoreCleanup({ actionId, spanOf }) {
    const spanOfContent = typeof spanOf === 'function' ? spanOf : wholeContentSpan;
    const scopeToken = captureScope();
    const bookName = getLorebookName();

    const record = await getCleanupRecord(actionId, bookName);
    if (!record) return refusal('unknown-action', `No recovery record "${actionId}".`);
    const reconciledRestore = await reconcileRestore(record, bookName);
    if (reconciledRestore?.status === 'restored') return { ok: true, restoredContent: reconciledRestore.restoredContent, reconciled: true };
    if (reconciledRestore?.status === 'outcome-uncertain') return refusal('restore-uncertain', `Restore outcome uncertain: ${reconciledRestore.detail}. Export the recovery records before resolving manually.`);
    if (record.status !== 'applied') {
        return refusal('not-applied', `Recovery record "${actionId}" is ${record.status} — only applied cleanups can be restored.`, { status: record.status });
    }

    // Scope and book bindings.
    const scopeKeyNow = currentCleanupScopeKey();
    if (scopeKeyNow !== record.scopeKey) {
        return refusal('scope-changed', `Restore refused: the current chat scope does not match the one this cleanup ran in ("${record.scopeKey}" → "${scopeKeyNow}"). Switch back to the originating chat.`);
    }
    if (bookName !== record.bookName) {
        return refusal('book-changed', `Restore refused: the resolved Knowledge book changed ("${record.bookName}" → "${bookName}").`);
    }
    try {
        assertHydrated(bookName, `restore cleanup for "${record.entityName}"`);
    } catch (err) {
        return refusal('store-not-hydrated', err.message);
    }

    // Destination identity (deletion / rename / merge all refuse).
    let entries;
    try {
        ({ entries } = await loadBookEntries(bookName));
    } catch (err) {
        return refusal('load-failed', err.message);
    }
    let entry = entries[record.entryUid];
    const conflictPayload = { actionId, record: { ...record, originalContent: undefined }, exportable: true };
    if (!entry) {
        return refusal('destination-missing', `Restore refused: entry uid ${record.entryUid} for "${record.entityName}" no longer exists. The recovery original can be exported instead.`, { conflict: conflictPayload });
    }
    if (!labelMatches(entry, record.entityName)) {
        return refusal('identity-mismatch', `Restore refused: entry uid ${record.entryUid} is labelled "${String(entry.comment || '').trim()}", not "${record.entityName}" (rename/merge). The recovery original can be exported instead.`, { conflict: conflictPayload });
    }
    const entityIdNow = getEntityId(record.entityName);
    if (record.entityId != null && entityIdNow != null && record.entityId !== entityIdNow) {
        return refusal('entity-changed', `Restore refused: "${record.entityName}" was renamed/merged since the cleanup was applied. The recovery original can be exported instead.`, { conflict: conflictPayload });
    }

    // Span comparison: current vs what was applied. Equal → safe to put the
    // original span back; different → touched-field conflict, refuse.
    let current = entry.content || '';
    let currentSpan = spanOfContent(current);
    const originalSpan = spanOfContent(record.originalContent);
    const appliedSpan = spanOfContent(record.approvedReplacement);
    if (!currentSpan || !originalSpan || !appliedSpan) {
        return refusal('span-not-found', 'Restore refused: the cleanup-owned section could not be located in the current entry, the original, or the replacement.', { conflict: conflictPayload });
    }
    if (current.slice(currentSpan.start, currentSpan.end) !== record.approvedReplacement.slice(appliedSpan.start, appliedSpan.end)) {
        return refusal('span-conflict', 'Restore refused: the cleanup-touched content changed after the cleanup was applied (manual edit or later update). Resolve by hand — export the recovery original from the recovery view.', { conflict: conflictPayload });
    }

    // Safeguard: capture the pre-restore content as its own recovery record
    // BEFORE writing. Failure refuses the restore write (fail closed).
    const capture = {
        scopeToken, scopeKey: record.scopeKey, bookName,
        name: record.entityName, uid: record.entryUid, entityId: record.entityId,
    };
    let safeguarded = false;
    let safeguardId = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const attemptId = `${actionId}#restore-${Date.now()}-${attempt}`;
        try {
            await saveCleanupOriginal({
                actionId: attemptId,
                createdAt: new Date().toISOString(),
                bookName,
                scopeKey: record.scopeKey,
                entityName: record.entityName,
                entityId: record.entityId,
                entryUid: record.entryUid,
                actionType: 'restore-safeguard',
                status: 'application-pending',
                originalContent: current,
                parentActionId: actionId,
                approvedReplacement: current.slice(0, currentSpan.start)
                    + record.originalContent.slice(originalSpan.start, originalSpan.end) + current.slice(currentSpan.end),
            });
        } catch (err) {
            return refusal('safeguard-failed', `Restore refused: the pre-restore safeguard could not be saved and verified — nothing was changed. (${err.message})`);
        }
        safeguardId = attemptId;
        let latest;
        try {
            latest = await loadBookEntries(bookName);
        } catch (err) {
            return refusal('load-failed', err.message);
        }
        const guard = checkCapturedDestination(capture, latest.entries);
        if (guard) {
            await tryUpdateCleanupRecord(safeguardId, { status: 'failed' }, bookName);
            return { ...guard, conflict: conflictPayload };
        }
        entry = latest.entries[record.entryUid];
        const latestContent = entry.content || '';
        const latestSpan = spanOfContent(latestContent);
        if (!latestSpan || latestContent.slice(latestSpan.start, latestSpan.end) !== record.approvedReplacement.slice(appliedSpan.start, appliedSpan.end)) {
            await tryUpdateCleanupRecord(safeguardId, { status: 'failed' }, bookName);
            return refusal('span-conflict', 'Restore refused: cleanup-touched content changed while saving the safeguard.', { conflict: conflictPayload });
        }
        if (latestContent === current) {
            currentSpan = latestSpan;
            safeguarded = true;
            break;
        }
        // Outside-span work survives, but must itself be durably safeguarded first.
        await updateCleanupRecord(safeguardId, { status: 'failed' }, bookName);
        current = latestContent;
        currentSpan = latestSpan;
    }
    if (!safeguarded) return refusal('source-changed-during-persist', 'Restore refused: the entry kept changing while safeguards were saved. Retry when editing has stopped.');

    const originalSpanText = record.originalContent.slice(originalSpan.start, originalSpan.end);
    const restored = current.slice(0, currentSpan.start) + originalSpanText + current.slice(currentSpan.end);
    const keywords = Array.isArray(entry.key) ? entry.key : [record.entityName];
    const write = await writeToLorebook(record.entityName, restored, keywords, record.entryUid, {
        bookName,
        beforeWrite: finalEntries => {
            const guard = checkCapturedDestination(capture, finalEntries);
            if (guard) return { ...guard, conflict: conflictPayload };
            // Any final-load edit requires a fresh safeguard, even outside the
            // owned span. Refuse rather than overwrite unsafeguarded work.
            if ((finalEntries[record.entryUid].content || '') !== current) {
                return refusal('source-changed-during-persist', 'Restore refused: the entry changed before the final write. Retry to safeguard the latest content.', { conflict: conflictPayload });
            }
            const missing = 'Restore refused: the pre-restore safeguard or this cleanup\'s recovery record is no longer in the book (another writer replaced it after it was saved). Nothing was changed — retry.';
            return checkRecoveryOnFinalLoad(finalEntries, safeguardId, { status: 'application-pending', originalContent: current }, missing)
                || checkRecoveryOnFinalLoad(finalEntries, actionId, { status: 'applied', originalContent: record.originalContent }, missing);
        },
    });
    if (!write.success) {
        if (write.refusal) {
            await tryUpdateCleanupRecord(safeguardId, { status: 'failed' }, bookName);
            return write.refusal;
        }
        const outcome = await reconcileRestore(record, bookName);
        if (outcome?.status === 'restored') return { ok: true, restoredContent: outcome.restoredContent, reconciled: true };
        if (outcome?.restoreFailed) return refusal('restore-save-failed', `Restore failed while saving: ${write.error}. Re-reading confirmed the entry is unchanged; recovery is preserved.`);
        return refusal('restore-uncertain', `Restore outcome uncertain after save error: ${write.error}. Retry to reconcile; recovery and the safeguard are preserved.`);
    }

    try {
        const verified = await readEntryContentStrict(record.entryUid, record.entityName, bookName);
        if (verified === restored) {
            await updateCleanupRecord(safeguardId, { status: 'applied', appliedAt: new Date().toISOString() }, bookName);
            await updateCleanupRecord(actionId, { status: 'restored', restoredAt: new Date().toISOString() }, bookName);
            return { ok: true, restoredContent: restored };
        }
        // Restore wrote but verification is ambiguous: keep the record
        // 'applied' (the original is still held) and report honestly.
        console.warn('[MWT:Knowledge] cleanup restore could not be verified after saving — entry content differs from the restored draft.');
        return refusal('restore-uncertain', 'Restore outcome uncertain: the reloaded entry does not match the restored draft. The recovery original and the pre-restore safeguard are preserved.');
    } catch (err) {
        console.warn('[MWT:Knowledge] cleanup restore could not be re-read after saving:', err?.message || err);
        return refusal('restore-uncertain', `Restore outcome uncertain: the entry could not be re-read after saving (${err.message}). The recovery original and the pre-restore safeguard are preserved.`);
    }
}
