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
 * issues. Part 2 adds the 0 -> 1 migrations (canonical defaults current
 * accessors already assume; receipt-tuple normalization), the embedded-store
 * `version` preservation, and the per-store issue policies. Deep
 * evidence/reference checks (design §6.3) and full lorebook-store contract
 * checks (§6.7) arrive with Parts 3 and 4. Pure by contract (see
 * core/schema.js).
 *
 * The metadataKey literals mirror backup/data.js METADATA_KEYS and the
 * module's own state.js keys; test/schema_parity.test.js pins them together.
 */
import {
    checkRecordList,
    checkRecordMap,
    defineIssuePolicy,
    defineStoreSchema,
    emptyStats,
    fatalIssue,
    isFiniteNumber,
    isNonEmptyString,
    isObject,
    mergeStats,
    quarantineIssue,
    repairIssue,
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
        // Fatal-root policy (design §3.5, category 4): block the store with the
        // raw value preserved instead of loading an empty one.
        issues.push(fatalIssue('root-not-object', [], 'Knowledge evidence must be an NPC map.', data, 'knowledgeEvidence'));
        return { data: {}, issues, stats };
    }
    const accepted = {};
    for (const [name, file] of Object.entries(data)) {
        if (!isNonEmptyString(name) || !isObject(file)) {
            issues.push(quarantineIssue('evidence-file-invalid', [name], 'Evidence file must have a non-empty NPC name and object value.', file, name));
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
            issues.push(quarantineIssue('evidence-meta-not-object', [name, 'meta'], 'Evidence meta must be an object.', file.meta, `${name}.meta`));
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
        // Fatal-root policy (design §3.5, category 4): block the store with the
        // raw value preserved instead of loading an empty one.
        issues.push(fatalIssue('root-not-object', [], 'Knowledge counters must be an object.', data, 'knowledgeCounters'));
        return { data: {}, issues, stats };
    }
    const accepted = { ...data };
    for (const key of COUNTER_KEYS) {
        if (data[key] === undefined) continue;
        if (!isFiniteNumber(data[key]) || data[key] < 0) {
            delete accepted[key];
            issues.push(quarantineIssue('counter-invalid', [key], 'Counter must be a finite non-negative number.', data[key], key));
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
        // Fatal-root policy (design §3.5, category 4): block the store with the
        // raw value preserved instead of loading an empty one.
        issues.push(fatalIssue('root-not-object', [], 'Knowledge store data must be an object.', data, 'knowledgeStore'));
        return { data: {}, issues, stats };
    }
    const accepted = {};
    // The embedded store version is part of the shape, not a foreign key
    // (design §4.1): keep a valid one so preparation never strips what the
    // v0 -> v1 migration just stamped. An invalid one is quarantined.
    if (data.version !== undefined) {
        if (Number.isInteger(data.version) && data.version > 0) {
            accepted.version = data.version;
        } else {
            issues.push(quarantineIssue('store-version-invalid', ['version'], 'Embedded store version must be a positive integer.', data.version, 'version'));
        }
    }
    for (const key of ['registry', 'stateRegistry']) {
        if (data[key] === undefined) continue;
        const checked = checkRecordMap(data[key], key, checkRegistryRecord, { path: [key] });
        accepted[key] = checked.data;
        mergeStats(stats, checked.stats);
        issues.push(...checked.issues);
    }
    if (data.relationships !== undefined) {
        if (!isObject(data.relationships)) {
            issues.push(quarantineIssue('relationships-not-object', ['relationships'], 'Relationships must be an object map.', data.relationships, 'relationships'));
        } else {
            accepted.relationships = {};
            for (const [name, edges] of Object.entries(data.relationships)) {
                if (!Array.isArray(edges)) {
                    issues.push(quarantineIssue('relationships-not-array', ['relationships', name], 'Relationship values must be arrays.', edges, name));
                } else {
                    accepted.relationships[name] = [];
                    for (let index = 0; index < edges.length; index++) {
                        const finding = checkRelationshipEdge(edges[index]);
                        if (finding) {
                            issues.push(quarantineIssue(finding.code, ['relationships', name, index], finding.message, edges[index], name));
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

// ─── Migrations (design §4.2 / §6.3–§6.4, Part 2) ────────────────────────────

/**
 * v0 -> v1 evidence: create the tier arrays and `meta` object current
 * accessors assume (`file.raw || []`, `file.meta?.lastProfileAt`, …) when
 * ABSENT. Present-but-invalid values are left for the v1 validator to
 * quarantine with their raw records recoverable (design §12).
 */
export function migrateKnowledgeEvidenceV0ToV1(data) {
    // Fatal-root policy (design §3.5, category 4): a non-object root is
    // returned untouched for the validation gate to block — never replaced
    // with an empty store here.
    if (!isObject(data)) return { data, issues: [] };
    const next = { ...data };
    for (const [name, file] of Object.entries(next)) {
        if (!isObject(file)) continue; // quarantined whole by the v1 validator
        let changed = false;
        const patched = { ...file };
        for (const tier of ['raw', 'consolidated', 'archivedRaw', 'userOverrides']) {
            if (patched[tier] === undefined) {
                patched[tier] = [];
                changed = true;
            }
        }
        if (patched.meta === undefined) {
            patched.meta = {};
            changed = true;
        }
        if (changed) next[name] = patched;
    }
    return { data: next, issues: [] };
}

/**
 * A receipt's counts object: one marker per cadence that has seen the message
 * — 1 while it still contributes to the current cadence, 0 once the cadence
 * completed (a spent marker). The runtime (knowledge/index.js
 * onMessageReceived/persistCounters) writes EXACTLY this shape; only the
 * VALUES are constrained so a future cadence key never turns real persisted
 * receipts into quarantine.
 */
const isReceiptCounts = value => isObject(value)
    && Object.values(value).every(count => Number.isInteger(count) && count >= 0);

/**
 * v0 -> v1 counters: default absent cadence counters to 0 and normalize the
 * persisted receipt-event log into unique `[messageKey, cadenceCounts]`
 * tuples (design §6.4) — the shape persistCounters() actually writes, e.g.
 * `['id:reply', { npc: 1, growth: 0 }]`. Malformed tuples are QUARANTINED
 * (raw preserved), never silently dropped; duplicate keys keep the LAST
 * occurrence, matching the runtime Map-rebuild semantics exactly.
 *
 * A NON-OBJECT root is returned untouched for the validation gate to block
 * (fatal-root policy) — never replaced with an empty store here.
 */
export function migrateKnowledgeCountersV0ToV1(data) {
    const issues = [];
    if (!isObject(data)) return { data, issues };
    const next = { ...data };
    for (const key of COUNTER_KEYS) {
        if (next[key] === undefined) next[key] = 0;
    }
    if (next.countedReceiptEvents === undefined) {
        next.countedReceiptEvents = [];
        return { data: next, issues };
    }
    if (!Array.isArray(next.countedReceiptEvents)) {
        issues.push(quarantineIssue(
            'receipts-not-array',
            ['countedReceiptEvents'],
            'Counted receipt events must be an array of [messageKey, cadenceCounts] tuples.',
            next.countedReceiptEvents,
            'countedReceiptEvents',
        ));
        next.countedReceiptEvents = [];
        return { data: next, issues };
    }
    const cleaned = [];
    for (const tuple of next.countedReceiptEvents) {
        const valid = Array.isArray(tuple) && tuple.length === 2
            && isNonEmptyString(tuple[0])
            && isReceiptCounts(tuple[1]);
        if (!valid) {
            issues.push(quarantineIssue(
                'receipt-invalid',
                ['countedReceiptEvents'],
                'Counted receipt events must be unique [messageKey, cadenceCounts] tuples.',
                tuple,
            ));
            continue;
        }
        const staleIndex = cleaned.findIndex(([key]) => key === tuple[0]);
        if (staleIndex !== -1) {
            const [stale] = cleaned.splice(staleIndex, 1);
            issues.push(repairIssue(
                'receipt-duplicate',
                ['countedReceiptEvents'],
                `Duplicate receipt key "${tuple[0]}" was merged; the later entry was kept.`,
                stale,
            ));
        }
        cleaned.push(tuple);
    }
    next.countedReceiptEvents = cleaned;
    return { data: next, issues };
}

/**
 * v0 -> v1 lorebook store: stamp the embedded version when absent so every
 * persisted store carries its schema marker (design §4.1). A PRESENT value is
 * never touched here — an invalid one is reported by the v1 validator.
 */
export function migrateKnowledgeStoreV0ToV1(data) {
    // Fatal-root policy (design §3.5, category 4): a non-object root is
    // returned untouched for the validation gate to block — never replaced
    // with an empty store here.
    if (!isObject(data)) return { data, issues: [] };
    const next = { ...data };
    if (next.version === undefined) next.version = KNOWLEDGE_STORE_VERSION;
    return { data: next, issues: [] };
}

// ─── Descriptors ─────────────────────────────────────────────────────────────

export const knowledgeEvidenceSchema = defineStoreSchema({
    id: 'knowledgeEvidence',
    metadataKey: EVIDENCE_META_KEY,
    currentVersion: 1,
    createDefault: () => ({}),
    migrations: { 0: migrateKnowledgeEvidenceV0ToV1 },
    validate: validateKnowledgeEvidenceData,
    policy: defineIssuePolicy({
        fatal: ['root-not-object'],
        record: [
            'evidence-file-invalid',
            'not-an-array',
            'empty-key',
            'duplicate-id',
            'observation-not-object',
            'observation-missing-id',
            'observation-missing-claim',
            'observation-missing-quote',
            'consolidated-not-object',
            'consolidated-missing-id',
            'consolidated-missing-claim',
            'consolidated-invalid-sources',
            'evidence-meta-not-object',
        ],
    }),
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
    migrations: { 0: migrateKnowledgeCountersV0ToV1 },
    validate: validateKnowledgeCountersData,
    policy: defineIssuePolicy({
        repair: ['receipt-duplicate'],
        fatal: ['root-not-object'],
        record: [
            'counter-invalid',
            'receipts-not-array',
            'receipt-invalid',
        ],
    }),
});

export const knowledgeStoreSchema = defineStoreSchema({
    id: 'knowledgeStore',
    // Not a chat-metadata key: this store lives in the [MWT:store] entry of
    // each resolved lorebook (design §4.1 — lorebook stores use a location).
    location: Object.freeze({ kind: 'lorebook-entry', entryCommentPrefix: STORE_SENTINEL }),
    currentVersion: KNOWLEDGE_STORE_VERSION,
    createDefault: () => ({ version: KNOWLEDGE_STORE_VERSION }),
    migrations: { 0: migrateKnowledgeStoreV0ToV1 },
    validate: validateKnowledgeStoreData,
    policy: defineIssuePolicy({
        fatal: ['root-not-object'],
        record: [
            'not-an-object',
            'empty-key',
            'registry-not-object',
            'registry-invalid-uid',
            'relationships-not-object',
            'relationships-not-array',
            'relationship-not-object',
            'relationship-missing-target',
            'relationship-missing-type',
            'stance-not-string',
            'store-version-invalid',
        ],
    }),
});
