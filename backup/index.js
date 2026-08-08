/**
 * backup/index.js — Public unified backup API.
 *
 * Phase 2b binds the pure restore planner to the live chat metadata. Lorebook
 * store writes deliberately remain Phase 3 work; this module commits only the
 * six explicitly whitelisted chat-metadata sections.
 */

import {
    assertSameScope,
    captureScope,
    downloadJson,
    getChat,
    getChatIdentity,
    getChatMeta,
    persistChatMetaNow,
} from '../core/index.js';
import { collectBackup } from './collect.js';
import { METADATA_KEYS } from './data.js';
import { planRestore } from './restore.js';

const METADATA_SECTION_NAMES = Object.freeze(Object.keys(METADATA_KEYS));
let lastRestore = null;

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

function collectCurrentMessageIds(chat = getChat()) {
    if (!Array.isArray(chat)) return [];
    return chat
        .map(message => message?.extra?.mwt_uuid)
        .filter(uuid => typeof uuid === 'string' && uuid.length > 0)
        .map(uuid => `mu-${uuid}`);
}

function staleResult(preview, reason) {
    return {
        ok: false,
        committed: false,
        reason: 'stale-scope',
        staleReason: reason,
        preview,
    };
}

/**
 * Bind the pure dry-run planner to the currently active chat. This never
 * writes metadata, downloads a file, or touches the lorebook store.
 */
export function previewRestore(envelope, { modes = {} } = {}) {
    return planRestore(envelope, collectCurrentMetadataSections(), {
        modes,
        currentIdentity: getChatIdentity(),
        currentMessageIds: collectCurrentMessageIds(),
    });
}

/**
 * Commit a fresh restore preview after an explicit confirmation.
 *
 * A pre-restore unified backup is downloaded before the one metadata write. It
 * includes the lorebook store for recovery purposes, but that section is never
 * applied here: async store reconciliation and UID re-resolution are Phase 3.
 */
export async function restoreBackup(envelope, {
    modes = {},
    confirm = false,
} = {}) {
    const preview = previewRestore(envelope, { modes });
    if (!preview.ok) {
        return { ok: false, committed: false, reason: 'invalid-backup', preview };
    }
    if (!confirm) {
        return { ok: false, committed: false, reason: 'confirmation-required', preview };
    }

    const scope = captureScope();
    const beforeBackup = assertSameScope(scope);
    if (!beforeBackup.ok) return staleResult(preview, beforeBackup.reason);

    const preRestoreBackup = await exportBackup({
        filename: `mwt_pre_restore_${getBackupFilename({ _meta: { chatName: getChatIdentity().chatId } })}`,
    });
    const afterBackup = assertSameScope(scope);
    if (!afterBackup.ok) return staleResult(preview, afterBackup.reason);

    // Re-plan after the awaited export so a concurrent local update cannot be
    // overwritten by a stale dry run. This is also the plan that is committed.
    const commitPreview = previewRestore(envelope, { modes });
    if (!commitPreview.ok) {
        return { ok: false, committed: false, reason: 'invalid-backup', preview: commitPreview };
    }
    const beforeCommit = assertSameScope(scope);
    if (!beforeCommit.ok) return staleResult(commitPreview, beforeCommit.reason);

    const meta = getChatMeta();
    if (!meta) {
        return { ok: false, committed: false, reason: 'metadata-unavailable', preview: commitPreview };
    }
    for (const sectionName of METADATA_SECTION_NAMES) {
        if (!Object.prototype.hasOwnProperty.call(commitPreview.plan.sections, sectionName)) continue;
        meta[METADATA_KEYS[sectionName]] = commitPreview.plan.sections[sectionName];
    }
    await persistChatMetaNow();

    // The downloaded envelope is detached from live metadata by collectBackup,
    // so it is also the exact in-memory snapshot used by session-local undo.
    lastRestore = { envelope: preRestoreBackup, modes };
    return {
        ok: true,
        committed: true,
        preview: commitPreview,
        preRestoreBackup,
    };
}

/** Restore the in-memory pre-restore snapshot captured by restoreBackup(). */
export async function undoLastRestore({ confirm = false } = {}) {
    if (!lastRestore) return { ok: false, committed: false, reason: 'no-restore-to-undo' };
    return restoreBackup(lastRestore.envelope, {
        modes: lastRestore.modes,
        confirm,
    });
}

export { collectBackup };
