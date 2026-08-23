/**
 * chronicle/schema.js — Chronicle store descriptor and record validators.
 *
 * The module-owned schema for `chat_metadata.session_chronicle_data`
 * (design §3.2/§6.2). Part 1 ports the exact rules this store already had in
 * backup/validate.js onto structured issues; the deeper Chronicle checks
 * (anchors, character lists, date/world-date parsing, trash re-cap — design
 * §6.2) and the 0 -> 1 migration (including moving the legacy id backfill
 * out of getSnapshots()) arrive with Part 2.
 *
 * SC_VERSION in chronicle/data.js is the standalone export/module version
 * and is deliberately NOT reused as the data-schema version (design §6.2).
 *
 * Pure by contract: imports only the shared engine; no DOM, no SillyTavern
 * runtime, no feature barrel, nothing from chronicle/data.js.
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and the
 * module's own CHRONICLE_KEY); test/schema_parity.test.js pins them together.
 */
import {
    checkRecordList,
    defineStoreSchema,
    emptyStats,
    isNonEmptyString,
    isObject,
    mergeStats,
    quarantineIssue,
} from '../core/schema.js';

/** One session snapshot: a stable non-empty id plus non-empty text. */
export function checkChronicleSnapshot(record) {
    if (!isObject(record)) return { code: 'snapshot-not-object', message: 'Snapshot must be an object.' };
    if (!isNonEmptyString(record.id)) return { code: 'snapshot-missing-id', message: 'Snapshot id must be a non-empty string.' };
    if (!isNonEmptyString(record.text)) return { code: 'snapshot-missing-text', message: 'Snapshot text must be a non-empty string.' };
    return null;
}

/**
 * Validate the two operational record lists (`snapshots`, `_deletedBin`).
 * Unknown keys pass through unchanged, exactly as before.
 */
export function validateChronicleData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(quarantineIssue('root-not-object', [], 'Chronicle data must be an object.', 'chronicle'));
        return { data: {}, issues, stats };
    }
    const accepted = { ...data };
    for (const key of ['snapshots', '_deletedBin']) {
        if (data[key] === undefined) continue;
        const checked = checkRecordList(data[key], key, checkChronicleSnapshot, { path: [key] });
        accepted[key] = checked.records;
        mergeStats(stats, checked.stats);
        issues.push(...checked.issues);
    }
    return { data: accepted, issues, stats };
}

/**
 * Chronicle store schema. `createDefault` is the schema-canonical empty
 * container pair; the runtime's injection/suggestion defaults stay owned by
 * chronicle/data.js (they are settings, not record containers).
 */
export const chronicleSchema = defineStoreSchema({
    id: 'chronicle',
    metadataKey: 'session_chronicle_data',
    currentVersion: 1,
    createDefault: () => ({ snapshots: [], _deletedBin: [] }),
    migrations: {},
    validate: validateChronicleData,
});
