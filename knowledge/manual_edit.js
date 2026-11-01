/** NPC-only manual editing persistence. No modal events or model calls belong here. */
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { state } from './state.js';
import { getLorebookName } from './scope.js';
import { getRegistryEntry, isSameNpcByName, registerEntry } from './registry.js';
import { assertHydrated, isStoreEntry, refreshWorldInfoEditor } from './store.js';
import { isCleanupRecoveryEntry } from './cleanup_recovery.js';
import { loadCleanupBook } from './cleanup_persistence.js';
import { writeToLorebook } from './lorebook.js';
import { stripRelationshipBlock, applyCurrentRelationshipBlock } from './relationships.js';

const refuse = (code, error) => ({ ok: false, code, error });
const bodyOf = content => stripRelationshipBlock(String(content ?? ''));
const normalizeNewlines = text => String(text ?? '').replace(/\r\n?/g, '\n');
const equalKeys = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The same parser is used for the field and the loaded entry's key array. */
export function parseManualKeywords(value, name) {
    const keys = (Array.isArray(value) ? value.join(',') : String(value ?? ''))
        .split(',').map(key => key.trim()).filter(Boolean);
    return keys.length ? keys : [name];
}

export function isManualEditDirty(session, body, keywords) {
    return normalizeNewlines(body) !== normalizeNewlines(session.baselineBody)
        || !equalKeys(parseManualKeywords(keywords, session.name), parseManualKeywords(session.keys, session.name));
}

function checkScope(session) {
    if (!session?.bookName || !scopeStillCurrent(session.scopeToken).ok || getLorebookName() !== session.bookName) {
        return refuse('scope-changed', 'Manual edit refused: the chat or resolved lorebook changed.');
    }
    return null;
}

function checkTarget(session, entries, checkFreshness = true) {
    const scopeError = checkScope(session);
    if (scopeError) return scopeError;
    try { assertHydrated(session.bookName, 'save a manual NPC edit'); }
    catch (err) { return refuse('not-hydrated', err.message); }
    const entry = entries[session.uid];
    if (!entry) return refuse('destination-missing', 'Manual edit refused: the entry no longer exists.');
    if (isStoreEntry(entry) || isCleanupRecoveryEntry(entry)) {
        return refuse('bookkeeping-entry', 'Manual edit refused: the target is module bookkeeping.');
    }
    if (!isSameNpcByName(entry.comment, session.name, Object.values(entries).map(candidate => candidate?.comment))) {
        return refuse('identity-mismatch', 'Manual edit refused: this uid now belongs to a different NPC.');
    }
    const registry = getRegistryEntry(session.name);
    if (!registry || registry.key !== session.name || registry.info.uid !== session.uid
        || registry.info.entityId !== session.entityId) {
        return refuse('identity-changed', 'Manual edit refused: the registry identity or entry link changed.');
    }
    if (checkFreshness && bodyOf(entry.content) !== session.baselineBody) {
        return refuse('stale-source', 'Manual edit refused: the entry changed. Reload before saving; keep or copy your draft.');
    }
    return null;
}

function snapshot(session, entry) {
    return Object.freeze({ ...session, baselineBody: bodyOf(entry.content),
        content: String(entry.content ?? ''), keys: Object.freeze([...(entry.key || [])]) });
}

/**
 * Capture identity, keys, body and destination together using an uncached read.
 * Success: { ok, session }. Refusal: { ok: false, code, error }.
 * Callers keep session immutable and retain their own draft on any refusal.
 */
export async function loadForManualEdit({ name, uid }) {
    const registry = getRegistryEntry(name);
    const session = { name: registry?.key ?? name, uid, entityId: registry?.info.entityId,
        scopeToken: captureScope(), bookName: getLorebookName() };
    if (!state.wiScript) return refuse('host-unavailable', 'world-info.js not loaded');
    if (!Number.isInteger(uid) || uid < 0) return refuse('invalid-uid', 'A valid existing NPC uid is required.');
    const scopeError = checkScope(session);
    if (scopeError) return scopeError;
    try {
        const wi = await loadCleanupBook(session.bookName);
        const guard = checkTarget(session, wi.entries, false);
        if (guard) return guard;
        return { ok: true, session: snapshot(session, wi.entries[uid]) };
    } catch (err) {
        return checkScope(session) || refuse('load-failed', err.message);
    }
}

function confirmed(session, entry, reconciled = false) {
    const guard = checkScope(session);
    if (guard) return { ...guard, persisted: true };
    // registerEntry merges metadata and marks the store dirty. On reconciled
    // success never clear that flag: later registry changes may not be on disk.
    const registry = getRegistryEntry(session.name);
    if (!registry || registry.info.uid !== session.uid || registry.info.entityId !== session.entityId) {
        return { ...refuse('identity-changed', 'The write landed, but the registry identity changed. Reload the entry.'), persisted: true };
    }
    const keys = [...(entry.key || [])];
    registerEntry(session.name, session.uid, registry.info.type, keys);
    for (const item of state.stagingItems) {
        // stagingItems contains pending proposals; accepted/dismissed ones are removed.
        if (item.uid === session.uid && item.type !== 'state') item.keywords = [...keys];
    }
    return { ok: true, reconciled, content: String(entry.content ?? ''), keywords: keys,
        session: snapshot(session, entry) };
}

/**
 * Refusals and uncertain outcomes never consume or mutate the caller's draft/session.
 * Success returns verified content/keywords and a replacement session baseline.
 * noOp performs no I/O; reconciled means disk proved a failed response had landed.
 * persisted/uncertain on scope refusals describe the old-scope write, not permission
 * to update the current UI. The caller must not apply old-scope results.
 */
export async function saveManualEdit({ session, body, keywords }) {
    const scopeError = checkScope(session);
    if (scopeError) return scopeError;
    if (!bodyOf(body).trim()) return refuse('empty-body', 'Entry content cannot be empty.');
    if (!isManualEditDirty(session, body, keywords)) {
        return { ok: true, noOp: true, content: session.content, keywords: [...session.keys], session };
    }
    const keys = parseManualKeywords(keywords, session.name);
    let content;
    let guardPassed = false;
    const write = await writeToLorebook(session.name, () => {
        content = applyCurrentRelationshipBlock(session.name, bodyOf(body));
        return content;
    }, keys, session.uid, {
        bookName: session.bookName, writeKeywords: true,
        beforeWrite: entries => {
            const guard = checkTarget(session, entries);
            guardPassed = !guard;
            return guard;
        },
    });
    if (write.refusal) return write.refusal;
    const switched = checkScope(session);
    if (switched) return { ...switched, persisted: write.success, uncertain: !write.success && guardPassed };
    if (!write.success && !guardPassed) return refuse('load-failed', write.error);
    try {
        const wi = await loadCleanupBook(session.bookName);
        const afterRead = checkScope(session);
        if (afterRead) return { ...afterRead, uncertain: true };
        const guard = checkTarget(session, wi.entries, false);
        if (guard) return { ...guard, uncertain: true };
        const entry = wi.entries[session.uid];
        // Use the exact sent content, not the draft: managed block stripping
        // can trim whitespace. Keys distinguish failed keyword-only writes.
        if (bodyOf(entry.content) === bodyOf(content) && equalKeys(entry.key, keys)) {
            if (!write.success) {
                state.wiScript?.worldInfoCache?.set(session.bookName, structuredClone(wi));
                refreshWorldInfoEditor(state.wiScript, session.bookName);
            }
            return confirmed(session, entry, !write.success);
        }
        if (!write.success && bodyOf(entry.content) === session.baselineBody && equalKeys(entry.key, session.keys)) {
            return refuse('save-failed', `Save failed; disk confirms the entry is unchanged. Your draft can be retried. ${write.error}`);
        }
    } catch (err) {
        const changed = checkScope(session);
        if (changed) return { ...changed, uncertain: true };
        return { ...refuse('outcome-uncertain', `Save outcome uncertain: ${err.message}. Keep or copy your draft.`), uncertain: true };
    }
    return { ...refuse('outcome-uncertain', 'Save outcome uncertain: disk differs from the sent edit. Keep or copy your draft.'), uncertain: true };
}