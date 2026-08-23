/**
 * interiority/schema.js — Interiority store descriptor and record validators.
 *
 * The module-owned schema for `chat_metadata.mwt_interiority` (design
 * §3.2/§6.6). Part 1 ports the exact rules this store already had in
 * backup/validate.js onto structured issues; the deeper Interiority checks
 * (field size limits, tombstone-to-ledger conflicts, nested snapshot shapes,
 * message resolution — design §6.6) and the 0 -> 1 migration (numeric/`sd-*`
 * to `mu-*` key migration out of the module initializer) arrive with Part 2.
 *
 * Pure by contract: imports only the shared engine; no DOM, no SillyTavern
 * runtime, no feature barrel, nothing from interiority/data.js.
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and the
 * module's own META_KEY); test/schema_parity.test.js pins them together.
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

/** Canonical per-message key format: `mu-<message uuid>`. */
export const PER_MESSAGE_KEY_PATTERN = /^mu-[^\s]+$/;

export function checkLedgerEntry(record) {
    if (!isObject(record)) return { code: 'ledger-not-object', message: 'Ledger entry must be an object.' };
    for (const key of ['id', 'npc', 'action', 'trigger']) {
        if (!isNonEmptyString(record[key])) {
            return { code: `ledger-invalid-${key}`, message: `Ledger ${key} must be a non-empty string.` };
        }
    }
    return null;
}

export function checkTombstone(record) {
    if (!isObject(record)) return { code: 'tombstone-not-object', message: 'Deletion tombstone must be an object.' };
    if (!isNonEmptyString(record.id) || !isNonEmptyString(record.npc)) {
        return { code: 'tombstone-missing-fields', message: 'Tombstone id and npc are required.' };
    }
    if (!Array.isArray(record.actions) || record.actions.some(action => !isNonEmptyString(action))) {
        return { code: 'tombstone-actions', message: 'Tombstone actions must be string ids.' };
    }
    if (!Array.isArray(record.triggers) || record.triggers.some(trigger => !isNonEmptyString(trigger))) {
        return { code: 'tombstone-triggers', message: 'Tombstone triggers must be string ids.' };
    }
    return null;
}

/**
 * Validate ledger entries, deletion tombstones, the per-message map, and the
 * turn counter. Unknown keys pass through unchanged, exactly as before.
 */
export function validateInteriorityData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(quarantineIssue('root-not-object', [], 'Interiority data must be an object.', 'interiority'));
        return { data: {}, issues, stats };
    }
    const accepted = { ...data };
    for (const [key, check] of [['ledger', checkLedgerEntry], ['deletedIntentions', checkTombstone]]) {
        if (data[key] === undefined) continue;
        const checked = checkRecordList(data[key], key, check, { path: [key] });
        accepted[key] = checked.records;
        mergeStats(stats, checked.stats);
        issues.push(...checked.issues);
    }
    if (data.perMessage !== undefined) {
        if (!isObject(data.perMessage)) {
            delete accepted.perMessage;
            issues.push(quarantineIssue('per-message-not-object', ['perMessage'], 'Interiority perMessage must be an object map.', 'perMessage'));
        } else {
            accepted.perMessage = {};
            for (const [key, value] of Object.entries(data.perMessage)) {
                if (!PER_MESSAGE_KEY_PATTERN.test(key) || !isObject(value)) {
                    issues.push(quarantineIssue('per-message-entry', ['perMessage', key], 'perMessage keys must be mu-* and values must be objects.', key));
                } else {
                    accepted.perMessage[key] = value;
                    stats.added++;
                }
            }
        }
    }
    if (data.turnCounter !== undefined && (!isFiniteNumber(data.turnCounter) || data.turnCounter < 0)) {
        delete accepted.turnCounter;
        issues.push(quarantineIssue('turn-counter-invalid', ['turnCounter'], 'Interiority turnCounter must be a finite non-negative number.', 'turnCounter'));
    }
    return { data: accepted, issues, stats };
}

/**
 * Interiority store schema. `createDefault` mirrors the runtime's on-demand
 * defaults from interiority/data.js getInteriorityData().
 */
export const interioritySchema = defineStoreSchema({
    id: 'interiority',
    metadataKey: 'mwt_interiority',
    currentVersion: 1,
    createDefault: () => ({ enabled: true, ledger: [], deletedIntentions: [], perMessage: {} }),
    migrations: {},
    validate: validateInteriorityData,
});
