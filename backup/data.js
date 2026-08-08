/**
 * backup/data.js — Pure unified chat-backup data model.
 *
 * This module deliberately has no SillyTavern or browser dependencies. Runtime
 * collection belongs to Phase 2a; this file only defines the versioned envelope
 * and the safe, explicit list of chat-metadata sections that may be exported.
 */

export const BACKUP_TYPE = 'mwt-chat-backup';
export const FORMAT_VERSION = 1;
export const SECTION_SCHEMA_VERSION = 1;
export const KNOWLEDGE_STORE_VERSION = 1;
export const MAX_TRASH_SIZE = 50;

export const SECTION_KEYS = Object.freeze([
    'worldState',
    'chronicle',
    'knowledgeEvidence',
    'knowledgeCounters',
    'storyPlanner',
    'interiority',
    'knowledgeStore',
]);

/** The six chat_metadata keys. Settings and other global/localStorage data are not included. */
export const METADATA_KEYS = Object.freeze({
    worldState: 'world_state_tracker_metadata',
    chronicle: 'session_chronicle_data',
    knowledgeEvidence: 'knowledge_growth_evidence',
    knowledgeCounters: 'knowledge_tracker_counters',
    storyPlanner: 'story_planner_data',
    interiority: 'mwt_interiority',
});

const METADATA_SECTION_KEYS = Object.freeze(Object.keys(METADATA_KEYS));

/**
 * Clone JSON-shaped data without relying on structuredClone (which is not
 * available in every SillyTavern browser target). Unsupported values are not
 * expected at this boundary; functions and symbols are omitted like JSON.
 */
export function cloneBackupData(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') {
        return (typeof value === 'function' || typeof value === 'symbol') ? undefined : value;
    }
    if (seen.has(value)) throw new TypeError('Backup data must not contain circular references.');
    seen.set(value, true);
    const result = Array.isArray(value) ? [] : {};
    for (const [key, child] of Object.entries(value)) {
        const cloned = cloneBackupData(child, seen);
        if (cloned !== undefined) result[key] = cloned;
    }
    seen.delete(value);
    return result;
}

function section(data, schemaVersion = SECTION_SCHEMA_VERSION) {
    return { schemaVersion, data: cloneBackupData(data && typeof data === 'object' ? data : {}) };
}

/**
 * Build an envelope from already-collected plain objects.
 *
 * `metadata` is intentionally whitelisted. Passing a complete metadata object
 * cannot accidentally export settings, legacy pointers, or unrelated keys.
 * `knowledgeStore` is optional because its runtime collection is Phase 2a.
 */
export function buildBackupEnvelope({
    metadata = {},
    knowledgeStore,
    identity = null,
    createdAt = new Date().toISOString(),
    mwtVersion = null,
    source = 'manual',
    chatName = null,
    messageCount = null,
} = {}) {
    const sections = {};
    for (const key of METADATA_SECTION_KEYS) {
        if (Object.prototype.hasOwnProperty.call(metadata, key)
            && metadata[key] !== undefined
            && metadata[key] !== null) {
            sections[key] = section(metadata[key]);
        }
    }
    if (knowledgeStore !== undefined) {
        const storeInput = knowledgeStore && typeof knowledgeStore === 'object' ? knowledgeStore : {};
        const storeVersion = Number.isInteger(storeInput.version) ? storeInput.version : KNOWLEDGE_STORE_VERSION;
        // The store version is carried by the section wrapper (storeVersion) only.
        // Carrying it a second time inside `data` left an unchanged exact Knowledge
        // restore reporting "replaced": current-state comparison retained the inner
        // version while validation dropped it, so two equal stores compared unequal
        // The wrapper is now the sole backup version field,
        // as the design document specifies.
        const { version: _omittedVersion, ...storeData } = storeInput;
        sections.knowledgeStore = {
            storeVersion,
            data: cloneBackupData(storeData),
        };
    }

    const meta = {
        type: BACKUP_TYPE,
        formatVersion: FORMAT_VERSION,
        createdAt,
        mwtVersion,
        source,
        chatName,
        messageCount,
        identity: cloneBackupData(identity),
    };

    return { _meta: meta, sections };
}

export function getBackupSection(envelope, name) {
    return envelope?.sections?.[name] || null;
}

/**
 * Order-insensitive deep equality for backup-shaped data.
 *
 * `JSON.stringify` is key-order sensitive, so two semantically identical
 * records whose properties were serialised in a different order (e.g. an entry
 * re-imported through a different writer) compare unequal. Restore summaries
 * built on such a comparison then report "replaced" for unchanged data.
 * This walks the structure instead.
 */
export function backupDataEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
    const aArr = Array.isArray(a);
    const bArr = Array.isArray(b);
    if (aArr || bArr) {
        if (!aArr || !bArr) return false;
        if (a.length !== b.length) return false;
        return a.every((item, i) => backupDataEqual(item, b[i]));
    }
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(k => Object.prototype.hasOwnProperty.call(b, k) && backupDataEqual(a[k], b[k]));
}
