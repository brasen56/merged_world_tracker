/** Checked disk I/O for destructive cleanup operations. Never verify via the host cache. */
import { getContextSafe } from '../core/index.js';
import { state } from './state.js';
import { refreshWorldInfoEditor } from './store.js';

async function request(path, body) {
    const headers = getContextSafe()?.getRequestHeaders?.();
    if (!headers) throw new Error('Cleanup persistence: host request headers unavailable');
    const response = await fetch(path, {
        method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Cleanup persistence: ${path} failed (HTTP ${response.status})`);
    return response;
}

export async function loadCleanupBook(bookName) {
    const response = await request('/api/worldinfo/get', { name: bookName });
    const wi = await response.json();
    if (!wi || !wi.entries || typeof wi.entries !== 'object' || Array.isArray(wi.entries)) {
        throw new Error('Cleanup persistence: invalid book response');
    }
    return wi;
}

/**
 * Refuse a disk-based cleanup write while the host holds unsaved state for the
 * book. ST updates `worldInfoCache` at once but writes World Info editor edits
 * through a ~1s debounced save, so a cache that differs from disk means an
 * edit is still pending (or a host save failed and left the cache ahead of
 * disk). A write built from disk would drop that edit, and the pending save
 * would then land its stale copy on top — reverting the cleanup and deleting
 * the recovery container after both were verified. Run it on the final disk
 * load, with no await before the save. Whole-book comparison on purpose: the
 * pending save writes the whole book.
 *
 * @param {string} bookName
 * @param {object} diskWi — the book as just loaded from disk
 * @returns {null|{ok: false, code: string, error: string}}
 */
export function hostCacheConflict(bookName, diskWi) {
    const cache = state.wiScript?.worldInfoCache;
    if (typeof cache?.has !== 'function' || !cache.has(bookName)) return null;
    if (JSON.stringify(cache.get(bookName)) === JSON.stringify(diskWi)) return null;
    return {
        ok: false,
        code: 'host-unsaved-edits',
        error: `Cleanup refused: World Info holds unsaved changes to "${bookName}" (an edit in the World Info editor is still saving, or an earlier save failed). Nothing was changed — wait a moment and retry; if it persists, reload the page.`,
    };
}

export async function saveCleanupBook(bookName, wi) {
    await request('/api/worldinfo/edit', { name: bookName, data: wi });
    // Keep host consumers coherent, but only after the checked request succeeds.
    state.wiScript?.worldInfoCache?.set(bookName, structuredClone(wi));
    const ctx = getContextSafe();
    if (ctx?.eventSource && ctx?.eventTypes?.WORLDINFO_UPDATED) {
        await ctx.eventSource.emit(ctx.eventTypes.WORLDINFO_UPDATED, bookName, wi);
    }
    refreshWorldInfoEditor(state.wiScript, bookName);
}