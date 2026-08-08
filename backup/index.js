/**
 * backup/index.js — Public unified backup API.
 *
 * Phase 2a provides collection/export. Restore planning and committing remain
 * deliberately unavailable from the public barrel until Phase 2b's safety
 * rails are implemented.
 */

import { downloadJson } from '../core/index.js';
import { collectBackup } from './collect.js';

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

export { collectBackup };

/**
 * Phase 2b commit guard. Keeping this function present makes the public API
 * stable from the Phase 2a console hook onward without exposing a false
 * impression that restore writes are already implemented.
 */
export function restoreBackup() {
    throw new Error('Backup restore commit is not available until Phase 2b.');
}
