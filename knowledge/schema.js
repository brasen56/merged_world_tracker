/**
 * knowledge/schema.js — Knowledge store descriptors and record validators.
 *
 * Owns the THREE Knowledge persistence shapes (design §2.1, §6.3–§6.7):
 *
 *   - evidence      `chat_metadata.knowledge_growth_evidence`
 *   - counters      `chat_metadata.knowledge_tracker_counters`
 *   - lorebook store the `[MWT:store]` entry inside each resolved book
 *
 * It is also the single owner of the lorebook-store sentinel and version —
 * knowledge/store.js imports them from here so the runtime and the registry
 * cannot drift apart.
 *
 * Part 1 scope: exact port of the backup/validate.js rules onto structured
 * issues. Deep evidence/reference checks (design §6.3), counter receipt
 * tuples (§6.4), the full lorebook-store contract (§6.7), and all migrations
 * arrive with Parts 2 and 4. Pure by contract (see core/schema.js).
 *
 * The metadataKey literals mirror backup/data.js METADATA_KEYS and the
 * module's own state.js keys; test/schema_parity.test.js pins them together.
 */
import {
    checkRecordList,
    checkRecordMap,
    defineStoreSchema,
    emptyStats,
    isFiniteNumber,
    isNonEmptyString,
    isObject,
    mergeStats,
    quarantineIssue,
} from '../core/schema.js';

/** Chat-metadata key for the growth-evidence NPC map. */
export const EVIDENCE_META_KEY = 'knowledge_growth_evidence';

/** Chat-metadata key for the per-chat cadence counters. */
export const COUNTERS_META_KEY = 'knowledge_tracker_counters';

/** Marks the lorebook entry that holds a book's store. Matched as a PREFIX. */
export const STORE_SENTINEL = '[MWT:store]';

/** Lorebook-store version — bumped only on a breaking change to the shape. */
export const KNOWLEDGE_STORE_VERSION = 1;

/** The four non-negative finite cadence counters. */
export const COUNTER_KEYS = [
    'messageCounter',
    'npcMessageCounter',
    'growthMessageCounter',
    'relationshipMessageCounter',
];

// ─── Record checks ───────────────────────────────────────────────────────────

export function checkObservation(record, label) {
    if (!isObject(record)) return { code: 'observation-not-object', message: `${label} observation must be an object.` };
    if (!isNonEmptyString(record.id)) return { code: 'observation-missing-id', message: `${label} observation id must be a non-empty string.` };
    if (!isNonEmptyString(record.claim)) return { code: 'observation-missing-claim', message: `${label} claim must be a non-empty string.` };
    if (!isNonEmptyString(record.quote)) return { code: 'observation-missing-quote', message: `${label} quote must be a non-empty string.` };
    return null;
}

export function checkConsolidated(record) {
    if (!isObject(record)) return { code: 'consolidated-not-object', message: 'Consolidated observation must be an object.' };
    if (!isNonEmptyString(record.id)) return { code: 'consolidated-missing-id', message: 'Consolidated observation id must be a non-empty string.' };
    if (!isNonEmptyString(record.claim)) return { code: 'consolidated-missing-claim', message: 'Consolidated claim must be a non-empty string.' };
    if (record.sources !== undefined && (!Array.isArray(record.sources)
        || record.sources.some(source => !isNonEmptyString(source)))) {
        return { code: 'consolidated-invalid-sources', message: 'Consolidated sources must be string ids.' };
    }
    return null;
}

// A registry/state-registry record's load-bearing field is `uid`. A null uid
// is an intentional orphan (the destination entry was deleted but the name is
// retained); a negative or fractional uid is never valid live state.
// Destination resolution later decides whether a record can be restored.
export function checkRegistryRecord(record) {
    if (!isObject(record)) return { code: 'registry-not-object', message: 'Registry entry must be an object.' };
    if (record.uid !== null && (!Number.isInteger(record.uid) || record.uid < 0)) {
        return { code: 'registry-invalid-uid', message: 'Registry entry uid must be null or a non-negative integer.' };
    }
    return null;
}

// Relationship edges are rendered by their `target` and `type`; an edge
// missing either cannot be displayed or reconciled.
export function checkRelationshipEdge(edge) {
    if (!isObject(edge)) return { code: 'relationship-not-object', message: 'Relationship edge must be an object.' };
    if (!isNonEmptyString(edge.target)) return { code: 'relationship-missing-target', message: 'Relationship edge target must be a non-empty string.' };
    if (!isNonEmptyString(edge.type)) return { code: 'relationship-missing-type', message: 'Relationship edge type must be a non-empty string.' };
    return null;
}

// ─── Evidence ────────────────────────────────────────────────────────────────

/**
 * Validate the NPC evidence map: non-empty NPC keys with object files,
 * per-tier observation records (`raw`, `consolidated`, `archivedRaw`), and
 * the per-file `meta` container. A missing/invalid `file.npc` is backfilled
 * from the map key — the same silent repair the backup path always made.
 */
export function validateKnowledgeEvidenceData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(quarantineIssue('root-not-object', [], 'Knowledge evidence must be an NPC map.', 'knowledgeEvidence'));
        return { data: {}, issues, stats };
    }
    const accepted = {};
    for (const [name, file] of Object.entries(data)) {
        if (!isNonEmptyString(name) || !isObject(file)) {
            issues.push(quarantineIssue('evidence-file-invalid', [name], 'Evidence file must have a non-empty NPC name and object value.', name));
            continue;
        }
        const next = { ...file, npc: isNonEmptyString(file.npc) ? file.npc : name };
        for (const [tier, check] of [
            ['raw', record => checkObservation(record, 'Raw')],
            ['consolidated', checkConsolidated],
            ['archivedRaw', record => checkObservation(record, 'Archived raw')],
        ]) {
            if (file[tier] === undefined) continue;
            const checked = checkRecordList(file[tier], `${name}.${tier}`, check, { path: [name, tier] });
            next[tier] = checked.records;
            mergeStats(stats, checked.stats);
            issues.push(...checked.issues);
        }
        if (file.meta !== undefined && !isObject(file.meta)) {
            delete next.meta;
            issues.push(quarantineIssue('evidence-meta-not-object', [name, 'meta'], 'Evidence meta must be an object.', `${name}.meta`));
        }
        accepted[name] = next;
    }
    return { data: accepted, issues, stats };
}

// ─── Counters ────────────────────────────────────────────────────────────────

/**
 * Validate the four cadence counters. Other keys (including the persisted
 * `countedReceiptEvents`) pass through unchanged, exactly as before.
 */
export function validateKnowledgeCountersData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(quarantineIssue('root-not-object', [], 'Knowledge counters must be an object.', 'knowledgeCounters'));
        return { data: {}, issues, stats };
    }
    const accepted = { ...data };
    for (const key of COUNTER_KEYS) {
        if (data[key] === undefined) continue;
        if (!isFiniteNumber(data[key]) || data[key] < 0) {
            delete accepted[key];
            issues.push(quarantineIssue('counter-invalid', [key], 'Counter must be a finite non-negative number.', key));
        } else {
            stats.added++;
        }
    }
    return { data: accepted, issues, stats };
}

// ─── Lorebook store ──────────────────────────────────────────────────────────

/**
 * Validate a lorebook store's registry maps, relationship edges, and stance
 * maps. Only known fields survive — an unknown top-level key is dropped
 * rather than merged into a book, exactly as before.
 */
export function validateKnowledgeStoreData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(quarantineIssue('root-not-object', [], 'Knowledge store data must be an object.', 'knowledgeStore'));
        return { data: {}, issues, stats };
    }
    const accepted = {};
    for (const key of ['registry', 'stateRegistry']) {
        if (data[key] === undefined) continue;
        const checked = checkRecordMap(data[key], key, checkRegistryRecord, { path: [key] });
        accepted[key] = checked.data;
        mergeStats(stats, checked.stats);
        issues.push(...checked.issues);
    }
    if (data.relationships !== undefined) {
        if (!isObject(data.relationships)) {
            issues.push(quarantineIssue('relationships-not-object', ['relationships'], 'Relationships must be an object map.', 'relationships'));
        } else {
            accepted.relationships = {};
            for (const [name, edges] of Object.entries(data.relationships)) {
                if (!Array.isArray(edges)) {
                    issues.push(quarantineIssue('relationships-not-array', ['relationships', name], 'Relationship values must be arrays.', name));
                } else {
                    accepted.relationships[name] = [];
                    for (let index = 0; index < edges.length; index++) {
                        const finding = checkRelationshipEdge(edges[index]);
                        if (finding) {
                            issues.push(quarantineIssue(finding.code, ['relationships', name, index], finding.message, name));
                        } else {
                            accepted.relationships[name].push(edges[index]);
                            stats.added++;
                        }
                    }
                }
            }
        }
    }
    for (const [key, label] of [['stances', 'Stance'], ['stanceSources', 'Stance source']]) {
        if (data[key] === undefined) continue;
        const checked = checkRecordMap(
            data[key],
            label,
            value => (typeof value === 'string' ? null : { code: 'stance-not-string', message: `${label} value must be a string.` }),
            { path: [key] },
        );
        accepted[key] = checked.data;
        mergeStats(stats, checked.stats);
        issues.push(...checked.issues);
    }
    return { data: accepted, issues, stats };
}

// ─── Descriptors ─────────────────────────────────────────────────────────────

export const knowledgeEvidenceSchema = defineStoreSchema({
    id: 'knowledgeEvidence',
    metadataKey: EVIDENCE_META_KEY,
    currentVersion: 1,
    createDefault: () => ({}),
    migrations: {},
    validate: validateKnowledgeEvidenceData,
});

export const knowledgeCountersSchema = defineStoreSchema({
    id: 'knowledgeCounters',
    metadataKey: COUNTERS_META_KEY,
    currentVersion: 1,
    createDefault: () => ({
        messageCounter: 0,
        npcMessageCounter: 0,
        growthMessageCounter: 0,
        relationshipMessageCounter: 0,
        countedReceiptEvents: [],
    }),
    migrations: {},
    validate: validateKnowledgeCountersData,
});

export const knowledgeStoreSchema = defineStoreSchema({
    id: 'knowledgeStore',
    // Not a chat-metadata key: this store lives in the [MWT:store] entry of
    // each resolved lorebook (design §4.1 — lorebook stores use a location).
    location: Object.freeze({ kind: 'lorebook-entry', entryCommentPrefix: STORE_SENTINEL }),
    currentVersion: KNOWLEDGE_STORE_VERSION,
    createDefault: () => ({ version: KNOWLEDGE_STORE_VERSION }),
    migrations: {},
    validate: validateKnowledgeStoreData,
});
