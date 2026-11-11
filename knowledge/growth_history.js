/** Durable, never-injected Growth approval history. */
import { getLorebookName } from './scope.js';
import { applyStoreToWorldInfo, beginStoreTransaction, markStoreClean, withStoreLock } from './store.js';
import { hostCacheConflict, loadCleanupBook, saveCleanupBook } from './cleanup_persistence.js';
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { buildGrowthApproval, growthEvidenceTime } from './growth_lineage.js';

/** Mutates only the caller's book snapshot, so dossier and history save atomically. */
export function appendGrowthApprovalToBook(wi, entityId, input) {
    const read = readGrowthHistoryContainerFromBook(wi);
    if (!read.ok) throw new Error(`Growth history: refusing approval (${read.reason})`);
    const history = read.records[entityId] || [];
    const record = buildGrowthApproval({ ...input, previous: history.at(-1) || null });
    putGrowthHistoryInBook(wi, { ...read.records, [entityId]: [...history, record].slice(-GROWTH_HISTORY_CAP) });
    return record;
}

export function putGrowthHistoryInBook(wi, records) {
    wi.entries ||= {};
    let entry = Object.values(wi.entries).find(isGrowthHistoryEntry);
    if (!entry) {
        const uid = Math.max(-1, ...Object.keys(wi.entries).map(Number).filter(Number.isInteger)) + 1;
        entry = { uid, displayIndex: uid, order: 100, position: 0, addMemo: true };
        wi.entries[uid] = entry;
    }
    const content = JSON.stringify({ version: GROWTH_HISTORY_VERSION, records });
    Object.assign(entry, {
        comment: `${GROWTH_HISTORY_SENTINEL} Growth approval history`, content,
        key: [], keysecondary: [], enabled: false, disable: true, constant: false,
        vectorized: false, selective: false, excludeRecursion: true, preventRecursion: true,
    });
    return content;
}

/** Date-ordered identity fold. Called before removing the absorbed registry id. */
export function mergeGrowthHistoryIdentities(keepId, mergeId, bookName, assertCurrent, evidenceNamespace = null) {
    return withStoreLock(async () => {
        assertCurrent();
        const read = await readGrowthHistoryContainer(bookName);
        assertCurrent();
        if (!read.ok) throw new Error(`Growth history merge refused (${read.reason})`);
        if (!read.records[mergeId]?.length) return;
        const incoming = read.records[mergeId].map(record => ({ ...record,
            changes: (record.changes || []).map(change => ({ ...change,
                evidenceIds: (change.evidenceIds || []).map(id => evidenceNamespace ? `${evidenceNamespace}::${id}` : id),
            })),
        }));
        const combined = [...(read.records[keepId] || []), ...incoming]
            .sort((a, b) => (growthEvidenceTime(a.acceptedAt) || 0) - (growthEvidenceTime(b.acceptedAt) || 0))
            .slice(-GROWTH_HISTORY_CAP);
        await mergeGrowthHistoryRecordsUnlocked({ [keepId]: combined, [mergeId]: [] }, bookName, { replace: true, assertCurrent });
        assertCurrent();
    });
}

export const GROWTH_HISTORY_SENTINEL = '[MWT:growth-history]';
export const GROWTH_HISTORY_VERSION = 1;
export const GROWTH_HISTORY_CAP = 10;

export function isGrowthHistoryEntry(entry) {
    return typeof entry?.comment === 'string' && entry.comment.startsWith(GROWTH_HISTORY_SENTINEL);
}

export function readGrowthHistoryContainerFromBook(wi) {
    const entries = Object.values(wi?.entries || {}).filter(isGrowthHistoryEntry);
    if (entries.length > 1) return { ok: false, reason: 'duplicate-containers' };
    const entry = entries[0];
    if (!entry) return { ok: true, version: GROWTH_HISTORY_VERSION, records: {} };
    let parsed;
    try { parsed = JSON.parse(entry.content); } catch { return { ok: false, reason: 'container-json-invalid' }; }
    if (parsed?.version !== GROWTH_HISTORY_VERSION) return { ok: false, reason: 'unsupported-version' };
    if (!parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)
        || Object.values(parsed.records).some(records => !Array.isArray(records))) {
        return { ok: false, reason: 'container-records-invalid' };
    }
    return { ok: true, version: parsed.version, records: parsed.records };
}

export async function readGrowthHistoryContainer(bookName = getLorebookName()) {
    if (!bookName) return { ok: false, reason: 'no-book' };
    return readGrowthHistoryContainerFromBook(await loadCleanupBook(bookName));
}

/** Merge by entityId, current-wins on import. Never downgrade unreadable data. */
export async function mergeGrowthHistoryRecordsUnlocked(records, bookName = getLorebookName(), {
    assertCurrent = () => {}, replace = false,
} = {}) {
    assertCurrent();
    if (!bookName) throw new Error('Growth history: no Knowledge book');
    const wi = await loadCleanupBook(bookName) || { entries: {} };
    assertCurrent();
    const read = readGrowthHistoryContainerFromBook(wi);
    if (!read.ok) throw new Error(`Growth history: refusing write (${read.reason})`);
    const incoming = readGrowthHistoryContainerFromBook({ entries: { 0: {
        comment: GROWTH_HISTORY_SENTINEL, content: JSON.stringify({ version: GROWTH_HISTORY_VERSION, records }),
    } } });
    if (!incoming.ok) throw new Error('Growth history: invalid records');
    const merged = replace ? { ...read.records, ...records } : { ...records, ...read.records };
    for (const [id, history] of Object.entries(merged)) merged[id] = history.slice(-GROWTH_HISTORY_CAP);
    const conflict = hostCacheConflict(bookName, wi);
    if (conflict) throw new Error(conflict.error);
    const content = putGrowthHistoryInBook(wi, merged);
    assertCurrent();
    // Caller holds the store lock. Buffer ordinary synchronous writes until
    // that lock settles so clean-marking covers only the snapshot saved here.
    beginStoreTransaction();
    applyStoreToWorldInfo(bookName, wi);
    await saveCleanupBook(bookName, wi);
    const reloaded = await loadCleanupBook(bookName);
    const verified = readGrowthHistoryContainerFromBook(reloaded);
    if (!verified.ok || Object.values(reloaded?.entries || {}).find(isGrowthHistoryEntry)?.content !== content) {
        throw new Error('Growth history: persistence could not be verified');
    }
    markStoreClean(bookName);
    return { ok: true };
}

export function writeGrowthHistoryContainer(bookName, records, options = {}) {
    const scope = captureScope();
    const assertCurrent = options.assertCurrent || (() => {
        if (!scopeStillCurrent(scope).ok || getLorebookName() !== bookName) {
            throw new Error('Growth history: chat scope or Knowledge book changed');
        }
    });
    return withStoreLock(() => mergeGrowthHistoryRecordsUnlocked(records, bookName, { ...options, assertCurrent, replace: true }));
}