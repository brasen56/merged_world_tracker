/**
 * world_state/schema.js — World State store descriptor and record validators.
 *
 * The module-owned schema for `chat_metadata.world_state_tracker_metadata`
 * (design §3.2/§6.1 of SCHEMA_VALIDATION_MIGRATIONS_PLAN.md). Part 1 ported
 * the exact rules this store already had in backup/validate.js onto
 * structured issues; Part 2 adds the 0 -> 1 migration (canonical defaults for
 * fields the runtime already assumes) and the per-store issue policy. The
 * deeper World State checks (provenance entities and indexes, counters/receipt
 * tuples, history bounds — design §6.1) arrive with the deep-validation pass.
 *
 * Pure by contract: imports only the shared engine; no DOM, no SillyTavern
 * runtime, no feature barrel, nothing from world_state/data.js.
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and the
 * module's own CHAT_DATA_KEY); test/schema_parity.test.js pins them together.
 */
import {
    checkRecordList,
    defineIssuePolicy,
    defineStoreSchema,
    emptyStats,
    fatalIssue,
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
        // Fatal-root policy (design §3.5, category 4): an unreadable root is a
        // store-level problem — the raw value is preserved in the issue and
        // prepareStore() blocks the store instead of loading an empty one.
        issues.push(fatalIssue('root-not-object', [], 'World State data must be an object.', data, 'worldState'));
        return { data: {}, issues, stats };
    }
    const accepted = { ...data };
    if (data.text !== undefined && typeof data.text !== 'string') {
        delete accepted.text;
        issues.push(quarantineIssue('text-not-string', ['text'], 'World State text must be a string.', data.text, 'text'));
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
        issues.push(quarantineIssue('provenance-not-object', ['provenance'], 'World State provenance must be an object.', data.provenance, 'provenance'));
    }
    return { data: accepted, issues, stats };
}

// ─── Migration (design §4.2, Part 2) ─────────────────────────────────────────

/**
 * v0 -> v1: add the canonical defaults current behavior already assumes.
 *
 * Deliberately minimal and non-destructive:
 *   - Only ABSENT fields are defaulted. A present-but-invalid value (a
 *     non-string `text`, a non-array `autoSaveHistory`) is left exactly as
 *     found so the v1 validator — not the migration — rejects it into
 *     quarantine with its raw record preserved (design §12: never perform a
 *     destructive migration before the raw input is recoverable).
 *   - A NON-OBJECT root is returned untouched: the fatal-root policy (design
 *     §3.5, category 4) makes an unreadable root a store-level problem, and
 *     manufacturing an empty store here would silently erase it before the
 *     post-step validation gate can block with the original preserved.
 *   - `provenance` is never touched here; it has its own inner schemaVersion
 *     and expiry bookkeeping owned by world_state/provenance.js.
 *
 * Pure: returns a new object; the caller's data is untouched.
 */
export function migrateWorldStateV0ToV1(data) {
    if (!isObject(data)) return { data, issues: [] };
    const next = { ...data };
    if (next.text === undefined) next.text = '';
    if (next.autoSaveHistory === undefined) next.autoSaveHistory = [];
    return { data: next, issues: [] };
}

/**
 * World State store schema. `createDefault` is the schema-canonical empty
 * value — it matches what the 0 -> 1 migration converges on, so a freshly
 * created store and a just-migrated one have the same shape; the runtime's
 * own on-demand defaults (settings scope, counters) stay owned by
 * world_state/data.js for now.
 */
export const worldStateSchema = defineStoreSchema({
    id: 'worldState',
    metadataKey: 'world_state_tracker_metadata',
    currentVersion: 1,
    createDefault: () => ({ text: '', autoSaveHistory: [] }),
    migrations: { 0: migrateWorldStateV0ToV1 },
    validate: validateWorldStateData,
    policy: defineIssuePolicy({
        fatal: ['root-not-object'],
        record: [
            'text-not-string',
            'not-an-array',
            'history-not-object',
            'history-missing-text',
            'history-invalid-timestamp',
            'provenance-not-object',
        ],
    }),
});
