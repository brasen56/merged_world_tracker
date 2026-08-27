/**
 * backup/data.js — Pure unified chat-backup data model.
 *
 * This module deliberately has no SillyTavern or browser dependencies. Runtime
 * collection belongs to Phase 2a; this file only defines the versioned envelope
 * and the safe, explicit list of chat-metadata sections that may be exported.
 *
 * Part 3 (design §3.4): the per-section wrapper versions are SOURCED from the
 * registered store descriptors in schema/registry.js — one owner per shape.
 * A section exported by this build is stamped with that store's
 * `currentVersion`, and a restore migrates each section from the version its
 * wrapper declares (backup/validate.js) before validating and merge-planning.
 */

import { STORE_SCHEMAS } from '../schema/registry.js';

export const BACKUP_TYPE = 'mwt-chat-backup';
export const FORMAT_VERSION = 1;
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

/**
 * The wrapper version a section carries: the version the SOURCE data is
 * actually at, from the exporting chat's schema manifest — NOT the store's
 * current version (design §3.4 + §3.3).
 *
 * The distinction is the whole point of the marker. Until the runtime cutover
 * (Part 6) stamps the manifest, every live chat's stores are at LEGACY 0: an
 * export that stamped `currentVersion` told the importer "already migrated",
 * the import skipped `prepareStore`'s 0 → 1 step, and the v1 validator then
 * refused everything that migration exists to repair — a legacy Chronicle
 * restored with zero snapshots (every id-less record quarantined) and a legacy
 * Story Planner restored with no arcs at all.
 *
 * A missing/invalid entry falls back to the descriptor's currentVersion, which
 * keeps pure callers that have no manifest at hand (tests, the envelope
 * builder used directly) on the historical behavior — the same convention
 * `planRestore`'s `currentVersions` uses for the destination half.
 */
function sectionVersion(sectionName, versions) {
    const declared = versions?.[sectionName];
    if (Number.isInteger(declared) && declared >= 0) return declared;
    return STORE_SCHEMAS[sectionName]?.currentVersion ?? 1;
}

function section(data, sectionName, versions) {
    return {
        schemaVersion: sectionVersion(sectionName, versions),
        data: cloneBackupData(data && typeof data === 'object' ? data : {}),
    };
}

/**
 * Build an envelope from already-collected plain objects.
 *
 * `metadata` is intentionally whitelisted. Passing a complete metadata object
 * cannot accidentally export settings, legacy pointers, or unrelated keys.
 * `knowledgeStore` is optional because its runtime collection is Phase 2a.
 * `quarantine` is the optional chat-local quarantine recovery container
 * (design §5.3): recovery data rides with every backup so a restore can never
 * strand rejected records on the source chat.
 * `sectionVersions` maps each chat-metadata section to the schema version its
 * data is actually at, read from the exporting chat's manifest (missing ⇒
 * legacy 0). Omit it and each section falls back to its store's
 * currentVersion — see {@link sectionVersion}.
 */
export function buildBackupEnvelope({
    metadata = {},
    knowledgeStore,
    quarantine,
    sectionVersions = null,
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
            sections[key] = section(metadata[key], key, sectionVersions);
        }
    }
    if (knowledgeStore !== undefined) {
        const storeInput = knowledgeStore && typeof knowledgeStore === 'object' ? knowledgeStore : {};
        // The wrapper's storeVersion mirrors the embedded lorebook-store
        // version, owned by the knowledgeStore descriptor (design §3.4).
        const storeVersion = Number.isInteger(storeInput.version)
            ? storeInput.version
            : STORE_SCHEMAS.knowledgeStore.currentVersion;
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

    // Quarantine recovery data is NOT a store section (it is subsystem data
    // ABOUT the stores, like the manifest); it rides as its own top-level
    // container and is only present when the chat has quarantined records.
    const envelope = { _meta: meta, sections };
    if (quarantine !== undefined && quarantine !== null) {
        envelope.quarantine = cloneBackupData(quarantine);
    }
    return envelope;
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
