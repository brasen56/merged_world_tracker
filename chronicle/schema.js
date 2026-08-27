/**
 * chronicle/schema.js — Chronicle store descriptor and record validators.
 *
 * The module-owned schema for `chat_metadata.session_chronicle_data`
 * (design §3.2/§6.2). Part 1 ported the exact rules this store already had in
 * backup/validate.js onto structured issues; Part 2 moves the legacy snapshot
 * id backfill OUT of chronicle/data.js getSnapshots() into
 * {@link backfillSnapshotIds} (the single owner — the runtime read path keeps
 * only its persistence call), adds the 0 -> 1 migration, and the per-store
 * issue policy. The deeper Chronicle checks (anchors, character lists,
 * date/world-date parsing, trash re-cap — design §6.2) arrive with the
 * deep-validation pass.
 *
 * SC_VERSION in chronicle/data.js is the standalone export/module version
 * and is deliberately NOT reused as the data-schema version (design §6.2).
 *
 * Pure by contract: imports only the shared engine and core/quarantine.js;
 * no DOM, no SillyTavern runtime, no feature barrel, nothing from
 * chronicle/data.js.
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and the
 * module's own CHRONICLE_KEY); test/schema_parity.test.js pins them together.
 */
import {
    checkRecordList,
    defineIssuePolicy,
    defineStoreSchema,
    emptyStats,
    fatalIssue,
    isNonEmptyString,
    isObject,
    mergeStats,
} from '../core/schema.js';
import { fingerprintValue } from '../core/quarantine.js';

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
        // Fatal-root policy (design §3.5, category 4): block the store with the
        // raw value preserved instead of loading an empty one.
        issues.push(fatalIssue('root-not-object', [], 'Chronicle data must be an object.', data, 'chronicle'));
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

// ─── Migration (design §4.2 / §6.2, Part 2) ──────────────────────────────────

/**
 * Backfill missing or non-string snapshot ids — the repair chronicle/data.js
 * getSnapshots() used to own inline. ONE OWNER now: the migration runs it on
 * the v0 -> v1 path and the runtime read path calls it before persisting.
 *
 * The generated id is deterministic (`legacy-<index>-<content fingerprint>`)
 * rather than the old `legacy-<Date.now()>-<random>`: a dry-run migration and
 * the runtime repair produce the SAME id for the same record, so re-running a
 * preparation never churns ids (and never re-persists an unchanged store).
 *
 * Tolerant of a non-array argument (it yields an empty list) because the
 * runtime read path in chronicle/data.js relies on that. Deciding whether a
 * CONTAINER is valid is not this helper's job — a caller that persists its
 * output must reject a non-array itself, or the corrupt container is replaced
 * before anything can quarantine it. See migrateChronicleV0ToV1().
 *
 * `prefix` scopes the generated ids to ONE list. The trash needs its own
 * scope: `snapshots` and `_deletedBin` are separate lists that share this id
 * space, and restoring an entry from the trash matches on id, so two records
 * that happened to sit at the same index with the same content would collide
 * across the two lists. `legacy` is the historical prefix and must not change
 * — those ids are already persisted in live chats by the getSnapshots() repair.
 *
 * @param {Array} snapshots raw snapshot list
 * @param {object} [options]
 * @param {string} [options.prefix='legacy'] id namespace for the generated ids
 * @returns {{ snapshots: object[], changed: boolean }}
 */
export function backfillSnapshotIds(snapshots, { prefix = 'legacy' } = {}) {
    let changed = false;
    const fixed = (Array.isArray(snapshots) ? snapshots : []).map((snapshot, index) => {
        if (!isObject(snapshot)) return snapshot;
        if (snapshot.id === undefined || snapshot.id === null || snapshot.id === '') {
            changed = true;
            return { ...snapshot, id: `${prefix}-${index}-${fingerprintValue(snapshot)}` };
        }
        if (typeof snapshot.id !== 'string') {
            changed = true;
            return { ...snapshot, id: String(snapshot.id) };
        }
        return snapshot;
    });
    return { snapshots: fixed, changed };
}

/**
 * v0 -> v1: canonical containers plus the legacy id backfill. Only ABSENT
 * containers are defaulted — a present-but-invalid value (a non-array
 * `snapshots` or `_deletedBin`) is left for the v1 validator to quarantine
 * with its raw shape recoverable (design §12). A NON-OBJECT root is returned
 * untouched so the fatal-root policy blocks the store with the original
 * preserved instead of an empty replacement being manufactured here.
 */
export function migrateChronicleV0ToV1(data) {
    if (!isObject(data)) return { data, issues: [] };
    const next = { ...data };
    if (next.snapshots === undefined) next.snapshots = [];
    if (next._deletedBin === undefined) next._deletedBin = [];
    // Only an ARRAY is backfilled. backfillSnapshotIds() coerces anything else
    // to [], which would REPLACE a corrupt container here — before the v1
    // validator could quarantine it — and persist the loss at the Part 6
    // cutover. Left in place, `not-an-array` quarantines the raw value.
    if (Array.isArray(next.snapshots)) {
        next.snapshots = backfillSnapshotIds(next.snapshots).snapshots;
    }
    // The trash gets the SAME repair. The v1 validator checks `_deletedBin`
    // with the same per-record rule as `snapshots`, so backfilling one list and
    // not the other quarantined every id-less trash entry in a legacy chat —
    // structurally identical records, opposite outcomes, and the user's Trash
    // emptied on migration. §6.2 asks this step to re-cap the trash, not to
    // evict it. Its ids are namespaced separately (see backfillSnapshotIds).
    if (Array.isArray(next._deletedBin)) {
        next._deletedBin = backfillSnapshotIds(next._deletedBin, { prefix: 'legacy-trash' }).snapshots;
    }
    return { data: next, issues: [] };
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
    migrations: { 0: migrateChronicleV0ToV1 },
    validate: validateChronicleData,
    policy: defineIssuePolicy({
        fatal: ['root-not-object'],
        record: [
            'not-an-array',
            'duplicate-id',
            'snapshot-not-object',
            'snapshot-missing-id',
            'snapshot-missing-text',
        ],
    }),
});
