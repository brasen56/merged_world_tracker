/**
 * world_state/schema.js — World State store descriptor and record validators.
 *
 * The module-owned schema for `chat_metadata.world_state_tracker_metadata`
 * (design §3.2/§6.1 of SCHEMA_VALIDATION_MIGRATIONS_PLAN.md). Part 1 ports
 * the exact rules this store already had in backup/validate.js onto
 * structured issues; the deeper World State checks (provenance entities and
 * indexes, counters/receipt tuples, history bounds — design §6.1) and the
 * 0 -> 1 migration arrive with Part 2.
 *
 * Pure by contract: imports only the shared engine; no DOM, no SillyTavern
 * runtime, no feature barrel, nothing from world_state/data.js.
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and the
 * module's own CHAT_DATA_KEY); test/schema_parity.test.js pins them together.
 */
import {
    checkRecordList,
    defineStoreSchema,
    emptyStats,
    isFiniteNumber,
    isNonEmptyString,
    isObject,
    mergeStats,
    quarantineIssue,
} from '../core/schema.js';

/**
 * One auto-save history record. Text is the payload; timestamp may be a
 * finite number (epoch ms) or a string (legacy ISO writes) — both were valid
 * writes, so both stay readable.
 */
export function checkWorldStateHistoryItem(record, label = 'History') {
    if (!isObject(record)) return { code: 'history-not-object', message: `${label} item must be an object.` };
    if (!isNonEmptyString(record.text)) return { code: 'history-missing-text', message: `${label} text must be a non-empty string.` };
    if (record.timestamp !== undefined && !isFiniteNumber(record.timestamp) && typeof record.timestamp !== 'string') {
        return { code: 'history-invalid-timestamp', message: `${label} timestamp is invalid.` };
    }
    return null;
}

/**
 * Validate a World State section: root object, `text` type, auto-save history
 * records, and the provenance container. Unknown keys pass through
 * unchanged, exactly as before.
 */
export function validateWorldStateData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(quarantineIssue('root-not-object', [], 'World State data must be an object.', 'worldState'));
        return { data: {}, issues, stats };
    }
    const accepted = { ...data };
    if (data.text !== undefined && typeof data.text !== 'string') {
        delete accepted.text;
        issues.push(quarantineIssue('text-not-string', ['text'], 'World State text must be a string.', 'text'));
    }
    if (data.autoSaveHistory !== undefined) {
        const history = checkRecordList(
            data.autoSaveHistory,
            'autoSaveHistory',
            record => checkWorldStateHistoryItem(record, 'History'),
            { path: ['autoSaveHistory'] },
        );
        accepted.autoSaveHistory = history.records;
        mergeStats(stats, history.stats);
        issues.push(...history.issues);
    }
    if (data.provenance !== undefined && !isObject(data.provenance)) {
        delete accepted.provenance;
        issues.push(quarantineIssue('provenance-not-object', ['provenance'], 'World State provenance must be an object.', 'provenance'));
    }
    return { data: accepted, issues, stats };
}

/**
 * World State store schema. `createDefault` is the schema-canonical empty
 * value; the runtime's own on-demand defaults (settings scope, counters)
 * stay owned by world_state/data.js for now.
 */
export const worldStateSchema = defineStoreSchema({
    id: 'worldState',
    metadataKey: 'world_state_tracker_metadata',
    currentVersion: 1,
    createDefault: () => ({ text: '' }),
    migrations: {},
    validate: validateWorldStateData,
});
