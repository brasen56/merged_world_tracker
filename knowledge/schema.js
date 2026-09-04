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
 * `version` preservation, and the per-store issue policies. Part 4 completes
 * the full lorebook-store contract (design §6.7): profileUid checks,
 * relationship/stance source enums, normalized-name-collision pruning,
 * relationship-target reference findings, and the recorded [MWT:store] ghost
 * repair inside the 0 -> 1 migration that knowledge/store.js's hydration gate
 * runs before a book becomes writable.
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
    ISSUE_SEVERITIES,
    makeIssue,
    mergeStats,
    quarantineIssue,
    repairIssue,
} from '../core/schema.js';
import { validateQuarantineStoreData } from '../core/quarantine.js';

/** Chat-metadata key for the growth-evidence NPC map. */
export const EVIDENCE_META_KEY = 'knowledge_growth_evidence';

/** Chat-metadata key for the per-chat cadence counters. */
export const COUNTERS_META_KEY = 'knowledge_tracker_counters';

/** Marks the lorebook entry that holds a book's store. Matched as a PREFIX. */
export const STORE_SENTINEL = '[MWT:store]';

/**
 * Lorebook-store version — bumped only on a breaking change to the shape.
 *
 * v2 (entity identity service, TODO §1): registry records gain a stable
 * `entityId` and explicit `aliases[]`, relationship edges gain stable
 * `subjectEntityId`/`targetEntityId` pointers, and the v1 → v2 migration
 * stamps both onto existing data. Every new field stays OPTIONAL at
 * validation — a record or edge without them is legacy-shaped, never invalid —
 * while the migration (loads) and saveRegistry's stamping (runtime writes)
 * converge every store on the full shape.
 */
export const KNOWLEDGE_STORE_VERSION = 2;

/**
 * NPC-registry key normalization for the store schema's §6.7 checks: the
 * normalized-name-collision check (two keys differing only in case or
 * surrounding whitespace resolve to the same entity, so the later one is
 * ambiguous and cannot stay in the live view) and the relationship-target
 * reference check (a casing difference must not read as a dangling target).
 *
 * Must stay identical to registry.js `normalizeRegistryName()` — the
 * accessor's case-insensitive resolution step. It is duplicated here rather
 * than imported because module schemas stay pure by contract (imports only
 * core/schema.js and core/quarantine.js); test/knowledge_store_hydration.test.js
 * pins the two together so they cannot drift.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeStoreKeyName(name) {
    return String(name ?? '').toLowerCase().trim();
}

// ─── Entity identity fields (TODO §1 entity identity + alias service) ────────
//
// Registry names are DISPLAY state: the model spells them differently, users
// rename characters, and one NPC can arrive under several spellings. The
// entityId is the stable identity anchor underneath — assigned once, never
// re-derived from the name, carried across renames and merges — so edges,
// evidence, and audit trails can survive a display-name change. Aliases are
// the user-approved form of "these spellings are the same entity" (the
// resolver honors them; the heuristic given-name rule stays for unknowns).

/** Prefix every generated entity id carries. */
export const ENTITY_ID_PREFIX = 'mwt_';

/**
 * Generate a fresh canonical entity id: `mwt_<time36>_<rand>`. Uniqueness
 * within a registry is guaranteed by the caller's used-set loop
 * (ensureRegistryIdentityFields), not by entropy alone — a same-millisecond
 * registration burst shares the time component.
 *
 * @returns {string}
 */
export function generateEntityId() {
    return `${ENTITY_ID_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Stamp the identity fields every v2 registry record carries — `entityId` and
 * `aliases: []` — onto records that lack them, skipping non-object records
 * (the validator quarantines those whole). Idempotent: an existing entityId is
 * NEVER replaced, even if duplicated elsewhere — duplicate claims are the
 * validator's repair, not the stamper's guess.
 *
 * MUTATES the records it is given. Runtime callers pass the live map they own
 * (saveRegistry); the v1 → v2 migration copies first (see
 * migrateKnowledgeStoreV1ToV2).
 *
 * @param {object} registry — the registry map ({ [npcName]: info })
 * @param {{generate?: () => string}} [options] — test hook for deterministic ids
 * @returns {boolean} true when anything was stamped
 */
export function ensureRegistryIdentityFields(registry, { generate = generateEntityId } = {}) {
    if (!isObject(registry)) return false;
    const used = new Set();
    for (const record of Object.values(registry)) {
        if (isObject(record) && isNonEmptyString(record.entityId)) used.add(record.entityId);
    }
    let changed = false;
    for (const record of Object.values(registry)) {
        if (!isObject(record)) continue;
        if (!isNonEmptyString(record.entityId)) {
            let id = generate();
            while (used.has(id)) id = generate();
            used.add(id);
            record.entityId = id;
            changed = true;
        }
        if (!Array.isArray(record.aliases)) {
            record.aliases = [];
            changed = true;
        }
    }
    return changed;
}

/**
 * Backfill stable entity pointers onto relationship edges that lack them, from
 * the registry in the same store: a map key's edges get that NPC's
 * `subjectEntityId`, and each edge's target name resolves (exact key only)
 * to a `targetEntityId`. Never overwrites an existing pointer — the identity
 * a previous write stamped is authoritative.
 *
 * MUTATES the edges it is given (callers own the data: the migration copies
 * first, runtime callers mutate the live store then save).
 *
 * @param {object} data — the lorebook store value ({ registry, relationships, … })
 * @returns {boolean} true when any pointer was stamped
 */
export function backfillRelationshipEntityIds(data) {
    if (!isObject(data) || !isObject(data.registry) || !isObject(data.relationships)) return false;
    let changed = false;
    for (const [name, edges] of Object.entries(data.relationships)) {
        if (!Array.isArray(edges)) continue;
        const subjectId = data.registry[name]?.entityId;
        for (const edge of edges) {
            if (!isObject(edge)) continue;
            if (subjectId && !isNonEmptyString(edge.subjectEntityId)) {
                edge.subjectEntityId = subjectId;
                changed = true;
            }
            const targetId = data.registry[edge.target]?.entityId;
            if (targetId && !isNonEmptyString(edge.targetEntityId)) {
                edge.targetEntityId = targetId;
                changed = true;
            }
        }
    }
    return changed;
}

/**
 * The provenance values a relationship edge `source` or a stance-source value
 * may carry (design §6.7 source enums). An ABSENT source stays valid: a record
 * with no `source` predates provenance and reads as manual — the fail-safe
 * direction documented in relationships.js.
 *
 * Must stay in lockstep with relationships.js SOURCE_AUTO/SOURCE_MANUAL;
 * test/knowledge_store_hydration.test.js pins the two together.
 */
export const RELATIONSHIP_SOURCE_VALUES = Object.freeze(['auto', 'manual']);

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
// `profileUid` (design §6.7) is parallel: absent (never linked), null
// (unlinked), or a non-negative uid into the NPC Profiles lorebook — anything
// else is a pointer no code path could ever follow.
// Destination resolution later decides whether a record can be restored.
export function checkRegistryRecord(record) {
    if (!isObject(record)) return { code: 'registry-not-object', message: 'Registry entry must be an object.' };
    if (record.uid !== null && (!Number.isInteger(record.uid) || record.uid < 0)) {
        return { code: 'registry-invalid-uid', message: 'Registry entry uid must be null or a non-negative integer.' };
    }
    if (record.profileUid !== undefined && record.profileUid !== null
        && (!Number.isInteger(record.profileUid) || record.profileUid < 0)) {
        return { code: 'registry-invalid-profile-uid', message: 'Registry entry profileUid must be null or a non-negative integer.' };
    }
    // Entity-identity fields (TODO §1): `entityId` is the stable id that
    // survives renames/merges, `aliases` the user-approved alternate spellings
    // the resolver honors, `mergedFrom` the merge audit trail. All are OPTIONAL
    // — a record without them is legacy-shaped, never invalid — but a PRESENT
    // malformed value is a pointer no MWT build could ever have written.
    // `mergedFrom` is the deliberate exception: its shape check lives in
    // validateKnowledgeStoreData as a REPAIR (the trail is stripped, the NPC
    // stays live), because a finding here quarantines the WHOLE record — and
    // the merge writer itself can emit `entityId: null` when the absorbed
    // record predates ids, so the shape is reachable from live code.
    if (record.entityId !== undefined && !isNonEmptyString(record.entityId)) {
        return { code: 'registry-invalid-entity-id', message: 'Registry entry entityId must be a non-empty string.' };
    }
    if (record.aliases !== undefined && (!Array.isArray(record.aliases)
        || record.aliases.some(alias => !isNonEmptyString(alias)))) {
        return { code: 'registry-aliases-invalid', message: 'Registry entry aliases must be an array of non-empty strings.' };
    }
    return null;
}

// Relationship edges are rendered by their `target` and `type`; an edge
// missing either cannot be displayed or reconciled. `source` records who
// wrote the edge (design §6.7 source enums): only the exact 'auto'/'manual'
// values exist — a record with no source predates provenance and reads as
// manual, but a value outside the enum was never written by any MWT build.
export function checkRelationshipEdge(edge) {
    if (!isObject(edge)) return { code: 'relationship-not-object', message: 'Relationship edge must be an object.' };
    if (!isNonEmptyString(edge.target)) return { code: 'relationship-missing-target', message: 'Relationship edge target must be a non-empty string.' };
    if (!isNonEmptyString(edge.type)) return { code: 'relationship-missing-type', message: 'Relationship edge type must be a non-empty string.' };
    if (edge.source !== undefined && !RELATIONSHIP_SOURCE_VALUES.includes(edge.source)) {
        return { code: 'relationship-invalid-source', message: `Relationship edge source must be "auto" or "manual" (or absent).` };
    }
    // Stable entity pointers (TODO §1): the subject/target entity ids outlive
    // the display names, so a rename or merge never orphans an edge. Optional
    // for the same legacy-shaped reason as the registry's entityId.
    for (const key of ['subjectEntityId', 'targetEntityId']) {
        if (edge[key] !== undefined && !isNonEmptyString(edge[key])) {
            return { code: 'relationship-invalid-entity-id', message: 'Relationship edge entity ids must be non-empty strings.' };
        }
    }
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
 * maps (the full design §6.7 contract). Only known fields survive — an
 * unknown top-level key is dropped rather than merged into a book, exactly as
 * before. The one container field is the store's EMBEDDED QUARANTINE
 * (design §5.1): a global/scoped book is shared across chats, so its
 * recovery records must live inside the store itself, never in one chat's
 * metadata. It uses the same container shape and validator as the chat-local
 * container; a container written by a NEWER MWT is refused with a FATAL
 * finding (it blocks the store) instead of being normalized/downgraded.
 *
 * Part 4 additions: registry records carry the `profileUid` pointer contract;
 * relationship-edge and stance-source values must come from the provenance
 * enum; NPC-registry keys that collide after name normalization are
 * quarantined (the first key wins — state-registry keys are deliberately
 * exempt, see the check itself); relationship edges whose target names no
 * registry key stay in the live data with a REFERENCE finding.
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
    // Embedded quarantine container (design §5.1) — see the function comment.
    // Canonical items are kept (deduplicated); the container validator's own
    // findings ride along with their paths prefixed under 'quarantine'.
    if (data.quarantine !== undefined) {
        const checkedQuarantine = validateQuarantineStoreData(data.quarantine);
        accepted.quarantine = checkedQuarantine.data;
        for (const issue of checkedQuarantine.issues) {
            issues.push({ ...issue, path: ['quarantine', ...issue.path] });
        }
    }
    for (const key of ['registry', 'stateRegistry']) {
        if (data[key] === undefined) continue;
        const checked = checkRecordMap(data[key], key, checkRegistryRecord, { path: [key] });
        accepted[key] = checked.data;
        mergeStats(stats, checked.stats);
        issues.push(...checked.issues);
        // Normalized-name collisions (design §6.7): two keys that normalize to
        // the same name ("Mara" / "mara ") resolve to the same entity for
        // every accessor, so the second and later colliders are ambiguous.
        // The first key in insertion order wins; each loser leaves the live
        // view with its complete record preserved (§5.2).
        //
        // `registry` ONLY. The check is licensed by resolveRegistryKey()'s
        // case-insensitive step, which the NPC registry has and the STATE
        // registry does not: every state-tracker access is an exact-key
        // lookup (registry.js setStateTrackerEnabled/…/bumpStateTrackerTimestamp,
        // render.js's tracker cards), and the register UI takes a trimmed
        // free-text name with no case-insensitive dedup. "Weather" and
        // "weather" are therefore two SEPARATE trackers, each addressable and
        // each pointing at its own entry — pruning one would drop live state
        // and orphan its lorebook entry, which is the duplicate/orphan failure
        // this store exists to prevent. If the state registry ever gains a
        // case-insensitive resolver, this list grows with it.
        if (key !== 'registry') continue;
        const claimed = new Set();
        for (const name of Object.keys(accepted[key])) {
            const normalized = normalizeStoreKeyName(name);
            if (claimed.has(normalized)) {
                issues.push(quarantineIssue(
                    'registry-name-collides',
                    [key, name],
                    `"${name}" collides with another ${key} key after name normalization.`,
                    accepted[key][name],
                    name,
                ));
                delete accepted[key][name];
            } else {
                claimed.add(normalized);
            }
        }
    }
    // Entity-identity cross-checks (TODO §1 identity service). Both are
    // REPAIRS, not quarantines: the NPC record itself is fine — only the
    // identity CLAIM conflicts. Dropping the claim keeps the NPC live while
    // the identity service re-stamps a clean one on its next write.
    if (accepted.registry) {
        // Merge audit trails (TODO §1): a malformed `mergedFrom` is a REPAIR,
        // never a quarantine — the trail is the least valuable field on the
        // record, and the merge writer itself can produce the shape (the
        // absorbed record predating entity ids). The field is stripped with
        // the raw value preserved in the issue; the NPC record stays live.
        for (const [name, record] of Object.entries(accepted.registry)) {
            if (record.mergedFrom === undefined) continue;
            const validTrail = Array.isArray(record.mergedFrom)
                && record.mergedFrom.every(entry => isObject(entry)
                    && isNonEmptyString(entry.entityId)
                    && isNonEmptyString(entry.name)
                    && isFiniteNumber(entry.at));
            if (validTrail) continue;
            issues.push(repairIssue(
                'registry-merged-from-invalid',
                ['registry', name, 'mergedFrom'],
                `"${name}"'s merge audit trail (mergedFrom) was malformed and was removed; the NPC record stays live.`,
                record.mergedFrom,
                name,
            ));
            const repaired = { ...record };
            delete repaired.mergedFrom;
            accepted.registry[name] = repaired;
        }
        // Two records claiming one entityId: the first (insertion order) keeps
        // it, later claimants lose theirs — both NPCs stay live either way.
        const claimedIds = new Set();
        for (const [name, record] of Object.entries(accepted.registry)) {
            if (!isNonEmptyString(record.entityId)) continue;
            if (claimedIds.has(record.entityId)) {
                issues.push(repairIssue(
                    'registry-duplicate-entity-id',
                    ['registry', name, 'entityId'],
                    `"${name}" claimed entityId "${record.entityId}" already owned by an earlier record; the claim was dropped and can be re-stamped.`,
                    record,
                ));
                const repaired = { ...record };
                delete repaired.entityId;
                accepted.registry[name] = repaired;
            } else {
                claimedIds.add(record.entityId);
            }
        }
        // Alias collisions: an alias equal to a canonical key (normalized), to
        // the record's OWN key, or to another record's alias would make the
        // resolver's alias step ambiguous or hijack a canonical lookup. The
        // first claim wins; the loser's alias is stripped, record preserved.
        const claimedNames = new Set(Object.keys(accepted.registry).map(normalizeStoreKeyName));
        const claimedAliases = new Map();
        for (const [name, record] of Object.entries(accepted.registry)) {
            if (!Array.isArray(record.aliases) || record.aliases.length === 0) continue;
            const kept = [];
            let stripped = false;
            for (const alias of record.aliases) {
                const normalized = normalizeStoreKeyName(alias);
                if (normalized === normalizeStoreKeyName(name)
                    || claimedNames.has(normalized)
                    || claimedAliases.has(normalized)
                    || kept.some(existing => normalizeStoreKeyName(existing) === normalized)) {
                    issues.push(repairIssue(
                        'registry-alias-collision',
                        ['registry', name, 'aliases'],
                        `Alias "${alias}" on "${name}" collides with a canonical name or another alias; it was removed.`,
                        alias,
                    ));
                    stripped = true;
                } else {
                    kept.push(alias);
                    claimedAliases.set(normalized, name);
                }
            }
            if (stripped) accepted.registry[name] = { ...record, aliases: kept };
        }
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
    // Relationship targets (design §6.7): an edge whose target names no
    // registry key is dangling. It is RETAINED — a reference finding, not a
    // rejected record (design §3.5 category 3) — because the edge still
    // renders, and dropping it would lose the user's statement about their
    // story. Names compare with the accessor's case-insensitive normalization
    // (normalizeStoreKeyName), so a casing difference is not a false positive.
    // Skipped when the registry is absent (e.g. a State book): there is
    // nothing to resolve against.
    if (accepted.registry && accepted.relationships) {
        const knownNames = new Set(Object.keys(accepted.registry).map(normalizeStoreKeyName));
        for (const [name, edges] of Object.entries(accepted.relationships)) {
            for (let index = 0; index < edges.length; index++) {
                const edge = edges[index];
                if (!knownNames.has(normalizeStoreKeyName(edge.target))) {
                    issues.push(makeIssue({
                        code: 'relationship-target-unknown',
                        path: ['relationships', name, index],
                        severity: ISSUE_SEVERITIES.REFERENCE,
                        message: `Relationship target "${edge.target}" is not in the registry.`,
                        record: edge,
                        identity: name,
                    }));
                }
            }
        }
    }
    if (data.stances !== undefined) {
        // Stance text is free-form (a preset suggestion, not an enum a newer
        // build could not extend) — only its type is checked.
        const checked = checkRecordMap(
            data.stances,
            'Stance',
            value => (typeof value === 'string' ? null : { code: 'stance-not-string', message: 'Stance value must be a string.' }),
            { path: ['stances'] },
        );
        accepted.stances = checked.data;
        mergeStats(stats, checked.stats);
        issues.push(...checked.issues);
    }
    if (data.stanceSources !== undefined) {
        // Stance sources share the relationship provenance enum (design §6.7):
        // 'auto' or 'manual', with absent never occurring (setStance always
        // writes one) but tolerated as a legacy record.
        const checkedSources = checkRecordMap(
            data.stanceSources,
            'Stance source',
            value => {
                if (typeof value !== 'string') return { code: 'stance-not-string', message: 'Stance source value must be a string.' };
                if (!RELATIONSHIP_SOURCE_VALUES.includes(value)) return { code: 'stance-source-invalid', message: 'Stance source must be "auto" or "manual".' };
                return null;
            },
            { path: ['stanceSources'] },
        );
        accepted.stanceSources = checkedSources.data;
        mergeStats(stats, checkedSources.stats);
        issues.push(...checkedSources.issues);
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
 * v0 -> v1 lorebook store (design §6.7): remove registry records whose NAME is
 * the store sentinel — ghosts left by "Import from Lorebook" runs that predate
 * isStoreEntry() — as an explicitly recorded repair, then stamp the embedded
 * version only after the surviving store is canonical. A PRESENT version
 * value is never touched here — an invalid one is reported by the v1
 * validator and heals on the following load's migration.
 */
export function migrateKnowledgeStoreV0ToV1(data) {
    // Fatal-root policy (design §3.5, category 4): a non-object root is
    // returned untouched for the validation gate to block — never replaced
    // with an empty store here.
    if (!isObject(data)) return { data, issues: [] };
    const issues = [];
    const next = { ...data };
    scrubStoreGhostRecords(next, issues);
    if (next.version === undefined) next.version = KNOWLEDGE_STORE_VERSION;
    return { data: next, issues };
}

/**
 * Remove registry records whose NAME is the store sentinel — ghosts left by
 * "Import from Lorebook" runs that predate isStoreEntry() — recording each
 * removal as an explicit repair (the complete raw record preserved). Shared by
 * the v0 → v1 and v1 → v2 migrations: a v1-era book reaches the v2 chain
 * without ever running v0 → v1, and the runtime's lazy scrub only fires for
 * CURRENT-version stores, so the migration must carry the repair forward.
 */
function scrubStoreGhostRecords(next, issues) {
    if (!isObject(next.registry)) return;
    for (const name of Object.keys(next.registry)) {
        if (name.startsWith(STORE_SENTINEL)) {
            issues.push(repairIssue(
                'registry-store-ghost',
                ['registry', name],
                `Removed the "${STORE_SENTINEL}" ghost record left by a pre-fix lorebook import.`,
                next.registry[name],
                name,
            ));
            delete next.registry[name];
        }
    }
}

/**
 * v1 -> v2 lorebook store (TODO §1 entity identity service): stamp the stable
 * `entityId` + `aliases: []` onto every registry record, scrub any
 * `[MWT:store]` ghost records the v1 era could still carry (the lazy runtime
 * scrub only fires at the current version), and backfill the stable
 * `subjectEntityId`/`targetEntityId` pointers onto relationship edges from
 * those ids. Copy-on-write throughout — a migration step must never mutate its
 * input (design §4.2), so stamped records/edges are new objects even though
 * prepareStore hands the step an already-cloned working value.
 *
 * Present-but-invalid identity values are left for the v2 validator to
 * quarantine (the same discipline v0 -> v1 applies to `version`).
 */
export function migrateKnowledgeStoreV1ToV2(data) {
    // Fatal-root policy (design §3.5, category 4): a non-object root is
    // returned untouched for the validation gate to block — never replaced
    // with an empty store here.
    if (!isObject(data)) return { data, issues: [] };
    const issues = [];
    const next = { ...data };
    scrubStoreGhostRecords(next, issues);
    if (isObject(next.registry)) {
        const used = new Set();
        for (const record of Object.values(next.registry)) {
            if (isObject(record) && isNonEmptyString(record.entityId)) used.add(record.entityId);
        }
        const stamped = {};
        for (const [name, record] of Object.entries(next.registry)) {
            if (!isObject(record)) { stamped[name] = record; continue; }
            let entityId = record.entityId;
            if (!isNonEmptyString(entityId)) {
                entityId = generateEntityId();
                while (used.has(entityId)) entityId = generateEntityId();
                used.add(entityId);
            }
            stamped[name] = record.entityId === entityId && Array.isArray(record.aliases)
                ? record
                : { ...record, entityId, ...(Array.isArray(record.aliases) ? {} : { aliases: [] }) };
        }
        next.registry = stamped;
    }
    if (isObject(next.relationships)) {
        const cloned = {};
        for (const [name, edges] of Object.entries(next.relationships)) {
            cloned[name] = Array.isArray(edges)
                ? edges.map(edge => (isObject(edge) ? { ...edge } : edge))
                : edges;
        }
        next.relationships = cloned;
        backfillRelationshipEntityIds(next);
    }
    // Same version discipline as v0 -> v1: stamp only the honest transitions.
    // An absent or v1 value becomes 2; anything else (including a future
    // integer, which the gate would have refused anyway) is left for the
    // validator to report.
    if (next.version === undefined || next.version === 1) next.version = KNOWLEDGE_STORE_VERSION;
    return { data: next, issues };
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
    migrations: { 0: migrateKnowledgeStoreV0ToV1, 1: migrateKnowledgeStoreV1ToV2 },
    validate: validateKnowledgeStoreData,
    policy: defineIssuePolicy({
        fatal: [
            'root-not-object',
            // The embedded quarantine container refuses a future version with
            // a fatal finding (§3.5 cat 4) instead of being downgraded.
            'future-version',
        ],
        record: [
            'not-an-object',
            'empty-key',
            'registry-not-object',
            'registry-invalid-uid',
            'registry-invalid-profile-uid',
            'registry-invalid-entity-id',
            'registry-aliases-invalid',
            'registry-name-collides',
            'relationships-not-object',
            'relationships-not-array',
            'relationship-not-object',
            'relationship-missing-target',
            'relationship-missing-type',
            'relationship-invalid-source',
            'relationship-invalid-entity-id',
            'stance-not-string',
            'stance-source-invalid',
            'store-version-invalid',
            // Embedded-quarantine container findings (items the container
            // validator rejects stay recoverable through their issue records).
            'items-not-array',
            'item-not-object',
            'item-missing-fields',
            'item-unrecoverable',
        ],
        // §3.5 category 3: structurally valid data retained with a finding.
        reference: [
            'relationship-target-unknown',
        ],
        repair: [
            'fingerprint-mismatch',
            // The recorded [MWT:store] ghost removal (design §6.7).
            'registry-store-ghost',
            // Entity-identity repairs (TODO §1): a conflicting claim or a
            // malformed merge trail is dropped, the NPC record stays live and
            // the raw value is preserved.
            'registry-duplicate-entity-id',
            'registry-alias-collision',
            'registry-merged-from-invalid',
        ],
    }),
});
