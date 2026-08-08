/**
 * backup/validate.js — Pure envelope and per-record validators.
 *
 * Every function here accepts plain objects and returns plain objects. Invalid
 * records are quarantined in `skipped`; they are never silently coerced into a
 * shape that a module did not author.
 */

import {
    BACKUP_TYPE,
    FORMAT_VERSION,
    SECTION_SCHEMA_VERSION,
    KNOWLEDGE_STORE_VERSION,
} from './data.js';
import { sanitizeArcs } from '../story_planner/data.js';

const STORY_SECTIONS = new Set(['immediate', 'emerging', 'horizon', 'character', 'unresolved']);
const STORY_STATUSES = new Set(['active', 'resolved', 'dropped']);
const COUNTER_KEYS = ['messageCounter', 'npcMessageCounter', 'growthMessageCounter', 'relationshipMessageCounter'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);

function summary() {
    return { added: 0, updated: 0, skipped: [], conflicts: 0 };
}

function skip(result, record, reason) {
    result.skipped.push({ record, reason });
}

function validateList(list, label, check, key = 'id') {
    const result = summary();
    const records = [];
    if (list === undefined) return { records, ...result };
    if (!Array.isArray(list)) {
        skip(result, label, `${label} must be an array.`);
        return { records, ...result };
    }
    const seen = new Set();
    for (const record of list) {
        const reason = check(record);
        const id = record && typeof record === 'object' ? record[key] : undefined;
        const identity = id === undefined ? null : String(id);
        if (reason) {
            skip(result, identity ?? record, reason);
        } else if (identity !== null && seen.has(identity)) {
            result.conflicts++;
            skip(result, identity, `Duplicate ${key} in ${label}.`);
        } else {
            if (identity !== null) seen.add(identity);
            records.push(record);
            result.added++;
        }
    }
    return { records, ...result };
}

function validateUniqueList(list, label, check) {
    const result = summary();
    const records = [];
    if (list === undefined) return { records, ...result };
    if (!Array.isArray(list)) {
        skip(result, label, `${label} must be an array.`);
        return { records, ...result };
    }
    for (const record of list) {
        const reason = check(record);
        if (reason) skip(result, record?.id ?? record, reason);
        else {
            records.push(record);
            result.added++;
        }
    }
    return { records, ...result };
}

function validateChronicleSnapshot(record) {
    if (!isObject(record)) return 'Snapshot must be an object.';
    if (!nonEmptyString(record.id)) return 'Snapshot id must be a non-empty string.';
    if (!nonEmptyString(record.text)) return 'Snapshot text must be a non-empty string.';
    return null;
}

function validateHistoryItem(record, label) {
    if (!isObject(record)) return `${label} item must be an object.`;
    if (!nonEmptyString(record.text)) return `${label} text must be a non-empty string.`;
    if (record.timestamp !== undefined && !finiteNumber(record.timestamp)
        && typeof record.timestamp !== 'string') return `${label} timestamp is invalid.`;
    return null;
}

function validateWorldState(data) {
    const result = summary();
    if (!isObject(data)) {
        skip(result, 'worldState', 'World State data must be an object.');
        return { data: {}, ...result };
    }
    const accepted = { ...data };
    if (data.text !== undefined && typeof data.text !== 'string') {
        delete accepted.text;
        skip(result, 'text', 'World State text must be a string.');
    }
    if (data.autoSaveHistory !== undefined) {
        const history = validateList(data.autoSaveHistory, 'autoSaveHistory', r => validateHistoryItem(r, 'History'));
        accepted.autoSaveHistory = history.records;
        result.added += history.added;
        result.skipped.push(...history.skipped);
        result.conflicts += history.conflicts;
    }
    if (data.provenance !== undefined && !isObject(data.provenance)) {
        delete accepted.provenance;
        skip(result, 'provenance', 'World State provenance must be an object.');
    }
    return { data: accepted, ...result };
}

function validateChronicle(data) {
    const result = summary();
    if (!isObject(data)) {
        skip(result, 'chronicle', 'Chronicle data must be an object.');
        return { data: {}, ...result };
    }
    const accepted = { ...data };
    for (const key of ['snapshots', '_deletedBin']) {
        if (data[key] === undefined) continue;
        const checked = validateList(data[key], key, validateChronicleSnapshot);
        accepted[key] = checked.records;
        result.added += checked.added;
        result.skipped.push(...checked.skipped);
        result.conflicts += checked.conflicts;
    }
    return { data: accepted, ...result };
}

function validateObservation(record, label) {
    if (!isObject(record)) return `${label} observation must be an object.`;
    if (!nonEmptyString(record.id)) return `${label} observation id must be a non-empty string.`;
    if (!nonEmptyString(record.claim)) return `${label} claim must be a non-empty string.`;
    if (!nonEmptyString(record.quote)) return `${label} quote must be a non-empty string.`;
    return null;
}

function validateConsolidated(record) {
    if (!isObject(record)) return 'Consolidated observation must be an object.';
    if (!nonEmptyString(record.id)) return 'Consolidated observation id must be a non-empty string.';
    if (!nonEmptyString(record.claim)) return 'Consolidated claim must be a non-empty string.';
    if (record.sources !== undefined && (!Array.isArray(record.sources)
        || record.sources.some(source => !nonEmptyString(source)))) return 'Consolidated sources must be string ids.';
    return null;
}

function validateKnowledgeEvidence(data) {
    const result = summary();
    if (!isObject(data)) {
        skip(result, 'knowledgeEvidence', 'Knowledge evidence must be an NPC map.');
        return { data: {}, ...result };
    }
    const accepted = {};
    for (const [name, file] of Object.entries(data)) {
        if (!nonEmptyString(name) || !isObject(file)) {
            skip(result, name, 'Evidence file must have a non-empty NPC name and object value.');
            continue;
        }
        const next = { ...file, npc: nonEmptyString(file.npc) ? file.npc : name };
        for (const [tier, check] of [['raw', r => validateObservation(r, 'Raw')], ['consolidated', validateConsolidated], ['archivedRaw', r => validateObservation(r, 'Archived raw')]]) {
            if (file[tier] === undefined) continue;
            const checked = validateList(file[tier], `${name}.${tier}`, check);
            next[tier] = checked.records;
            result.added += checked.added;
            result.skipped.push(...checked.skipped);
            result.conflicts += checked.conflicts;
        }
        if (file.meta !== undefined && !isObject(file.meta)) {
            delete next.meta;
            skip(result, `${name}.meta`, 'Evidence meta must be an object.');
        }
        accepted[name] = next;
    }
    return { data: accepted, ...result };
}

function validateCounters(data) {
    const result = summary();
    if (!isObject(data)) {
        skip(result, 'knowledgeCounters', 'Knowledge counters must be an object.');
        return { data: {}, ...result };
    }
    const accepted = { ...data };
    for (const key of COUNTER_KEYS) {
        if (data[key] === undefined) continue;
        if (!finiteNumber(data[key]) || data[key] < 0) {
            delete accepted[key];
            skip(result, key, 'Counter must be a finite non-negative number.');
        } else result.added++;
    }
    return { data: accepted, ...result };
}

function validateArc(record) {
    if (!isObject(record)) return 'Arc must be an object.';
    if (!nonEmptyString(record.id)) return 'Arc id must be a non-empty string.';
    if (record.title !== undefined && typeof record.title !== 'string') return 'Arc title must be a string.';
    if (record.body !== undefined && typeof record.body !== 'string') return 'Arc body must be a string.';
    if (!STORY_SECTIONS.has(record.section)) return 'Arc section is invalid.';
    if (!STORY_STATUSES.has(record.status)) return 'Arc status is invalid.';
    if (!Array.isArray(record.beats) || record.beats.some(beat => typeof beat !== 'string')) return 'Arc beats must be an array of strings.';
    if (!Number.isInteger(record.beatIndex) || record.beatIndex < 0) return 'Arc beatIndex must be a non-negative integer.';
    if (!finiteNumber(record.turnsSinceAdvance) || record.turnsSinceAdvance < 0) return 'Arc turnsSinceAdvance is invalid.';
    if (!finiteNumber(record.createdAt) || !finiteNumber(record.updatedAt)) return 'Arc timestamps must be finite numbers.';
    return null;
}

function validateStoryPlanner(data) {
    const result = summary();
    if (!isObject(data)) {
        skip(result, 'storyPlanner', 'Story Planner data must be an object.');
        return { data: {}, ...result };
    }
    const accepted = { ...data };
    if (data.arcs !== undefined) {
        const arcs = validateUniqueList(data.arcs, 'arcs', validateArc);
        accepted.arcs = sanitizeArcs(arcs.records);
        result.added += arcs.added;
        result.skipped.push(...arcs.skipped);
        result.conflicts += arcs.conflicts;
    }
    if (data.history !== undefined && !Array.isArray(data.history)) {
        delete accepted.history;
        skip(result, 'history', 'Story Planner history must be an array.');
    }
    return { data: accepted, ...result };
}

function validateLedgerEntry(record) {
    if (!isObject(record)) return 'Ledger entry must be an object.';
    for (const key of ['id', 'npc', 'action', 'trigger']) {
        if (!nonEmptyString(record[key])) return `Ledger ${key} must be a non-empty string.`;
    }
    return null;
}

function validateTombstone(record) {
    if (!isObject(record)) return 'Deletion tombstone must be an object.';
    if (!nonEmptyString(record.id) || !nonEmptyString(record.npc)) return 'Tombstone id and npc are required.';
    if (!Array.isArray(record.actions) || record.actions.some(action => !nonEmptyString(action))) return 'Tombstone actions must be string ids.';
    if (!Array.isArray(record.triggers) || record.triggers.some(trigger => !nonEmptyString(trigger))) return 'Tombstone triggers must be string ids.';
    return null;
}

function validateInteriority(data) {
    const result = summary();
    if (!isObject(data)) {
        skip(result, 'interiority', 'Interiority data must be an object.');
        return { data: {}, ...result };
    }
    const accepted = { ...data };
    for (const [key, check] of [['ledger', validateLedgerEntry], ['deletedIntentions', validateTombstone]]) {
        if (data[key] === undefined) continue;
        const checked = validateList(data[key], key, check);
        accepted[key] = checked.records;
        result.added += checked.added;
        result.skipped.push(...checked.skipped);
        result.conflicts += checked.conflicts;
    }
    if (data.perMessage !== undefined) {
        if (!isObject(data.perMessage)) {
            delete accepted.perMessage;
            skip(result, 'perMessage', 'Interiority perMessage must be an object map.');
        } else {
            accepted.perMessage = {};
            for (const [key, value] of Object.entries(data.perMessage)) {
                if (!/^mu-[^\s]+$/.test(key) || !isObject(value)) {
                    skip(result, key, 'perMessage keys must be mu-* and values must be objects.');
                } else {
                    accepted.perMessage[key] = value;
                    result.added++;
                }
            }
        }
    }
    if (data.turnCounter !== undefined && (!finiteNumber(data.turnCounter) || data.turnCounter < 0)) {
        delete accepted.turnCounter;
        skip(result, 'turnCounter', 'Interiority turnCounter must be a finite non-negative number.');
    }
    return { data: accepted, ...result };
}

function validateNameMap(map, label, check) {
    const result = summary();
    if (!isObject(map)) {
        skip(result, label, `${label} must be an object map.`);
        return { data: {}, ...result };
    }
    const accepted = {};
    for (const [name, value] of Object.entries(map)) {
        if (!nonEmptyString(name)) {
            skip(result, name, `${label} keys must be non-empty strings.`);
            continue;
        }
        // When no record-level check is supplied, fall back to the original
        // shape guard so non-map callers keep their permissive behaviour.
        const reason = check ? check(value) : (isObject(value) ? null : `${label} entry must be an object.`);
        if (reason) skip(result, name, reason);
        else { accepted[name] = value; result.added++; }
    }
    return { data: accepted, ...result };
}

// A registry/state-registry record's load-bearing field is `uid`. A null uid is
// an intentional orphan (the destination entry was deleted but the name is
// retained); a negative or fractional uid is never valid live state. Destination
// resolution later decides whether a record can actually be restored.
function validateRegistryRecord(record) {
    if (!isObject(record)) return 'Registry entry must be an object.';
    if (record.uid !== null && (!Number.isInteger(record.uid) || record.uid < 0)) {
        return 'Registry entry uid must be null or a non-negative integer.';
    }
    return null;
}

// Relationship edges are rendered by their `target` and `type`; an edge missing
// either cannot be displayed or reconciled, so it is quarantined.
function validateRelationshipEdge(edge) {
    if (!isObject(edge)) return 'Relationship edge must be an object.';
    if (!nonEmptyString(edge.target)) return 'Relationship edge target must be a non-empty string.';
    if (!nonEmptyString(edge.type)) return 'Relationship edge type must be a non-empty string.';
    return null;
}

function validateKnowledgeStore(data) {
    const result = summary();
    if (!isObject(data)) {
        skip(result, 'knowledgeStore', 'Knowledge store data must be an object.');
        return { data: {}, ...result };
    }
    const accepted = {};
    for (const key of ['registry', 'stateRegistry']) {
        if (data[key] === undefined) continue;
        const checked = validateNameMap(data[key], key, validateRegistryRecord);
        accepted[key] = checked.data;
        result.added += checked.added;
        result.skipped.push(...checked.skipped);
    }
    if (data.relationships !== undefined) {
        if (!isObject(data.relationships)) skip(result, 'relationships', 'Relationships must be an object map.');
        else {
            accepted.relationships = {};
            for (const [name, edges] of Object.entries(data.relationships)) {
                if (!Array.isArray(edges)) skip(result, name, 'Relationship values must be arrays.');
                else {
                    accepted.relationships[name] = [];
                    for (const edge of edges) {
                        const reason = validateRelationshipEdge(edge);
                        if (reason) {
                            skip(result, name, reason);
                        } else {
                            accepted.relationships[name].push(edge);
                            result.added++;
                        }
                    }
                }
            }
        }
    }
    for (const [key, label] of [['stances', 'Stance'], ['stanceSources', 'Stance source']]) {
        if (data[key] === undefined) continue;
        const checked = validateNameMap(data[key], label, value =>
            typeof value === 'string' ? null : `${label} value must be a string.`);
        accepted[key] = checked.data;
        result.added += checked.added;
        result.skipped.push(...checked.skipped);
    }
    return { data: accepted, ...result };
}

const SECTION_VALIDATORS = {
    worldState: validateWorldState,
    chronicle: validateChronicle,
    knowledgeEvidence: validateKnowledgeEvidence,
    knowledgeCounters: validateCounters,
    storyPlanner: validateStoryPlanner,
    interiority: validateInteriority,
    knowledgeStore: validateKnowledgeStore,
};

export function validateSection(name, data) {
    const validator = SECTION_VALIDATORS[name];
    if (!validator) return { data: {}, ...summary(), warning: `Unknown backup section "${name}" was ignored.` };
    return validator(data);
}

/**
 * Validate the envelope and all known sections. Unknown sections are ignored
 * with warnings; unknown-high versions refuse the entire import.
 */
export function validateBackupEnvelope(envelope, { maxFormatVersion = FORMAT_VERSION } = {}) {
    const result = { ok: false, errors: [], warnings: [], sections: {}, summaries: {} };
    if (!isObject(envelope)) {
        result.errors.push('Backup must be a JSON object.');
        return result;
    }
    const meta = envelope._meta;
    if (!isObject(meta) || meta.type !== BACKUP_TYPE) {
        result.errors.push(`Unrecognized backup type; expected "${BACKUP_TYPE}".`);
        return result;
    }
    if (!Number.isInteger(meta.formatVersion)) {
        result.errors.push('Backup formatVersion must be an integer.');
        return result;
    }
    if (meta.formatVersion < 1) {
        result.errors.push(`Backup formatVersion ${meta.formatVersion} is not a positive integer; the earliest supported version is 1.`);
        return result;
    }
    if (meta.formatVersion > maxFormatVersion) {
        result.errors.push(`Backup formatVersion ${meta.formatVersion} is newer than the supported version ${maxFormatVersion}.`);
        return result;
    }
    if (!isObject(envelope.sections)) {
        result.errors.push('Backup sections must be an object.');
        return result;
    }
    for (const [name, wrapped] of Object.entries(envelope.sections)) {
        if (!SECTION_VALIDATORS[name]) {
            result.warnings.push(`Unknown backup section "${name}" was ignored.`);
            continue;
        }
        if (!isObject(wrapped)) {
            result.errors.push(`Section "${name}" must be an object.`);
            continue;
        }
        const version = name === 'knowledgeStore' ? wrapped.storeVersion : wrapped.schemaVersion;
        const maxVersion = name === 'knowledgeStore' ? KNOWLEDGE_STORE_VERSION : SECTION_SCHEMA_VERSION;
        if (!Number.isInteger(version)) {
            result.errors.push(`Section "${name}" has no valid version field.`);
            continue;
        }
        if (version < 1) {
            result.errors.push(`Section "${name}" version ${version} is not a positive integer; the earliest supported version is 1.`);
            continue;
        }
        if (version > maxVersion) {
            result.errors.push(`Section "${name}" version ${version} is newer than supported version ${maxVersion}.`);
            continue;
        }
        const checked = validateSection(name, wrapped.data);
        result.sections[name] = checked.data;
        result.summaries[name] = {
            added: checked.added,
            updated: checked.updated,
            skipped: checked.skipped,
            conflicts: checked.conflicts,
        };
    }
    result.ok = result.errors.length === 0;
    return result;
}

export { validateWorldState, validateChronicle, validateKnowledgeEvidence, validateCounters as validateKnowledgeCounters, validateStoryPlanner, validateInteriority, validateKnowledgeStore };
