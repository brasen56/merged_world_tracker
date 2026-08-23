/**
 * core/schema.js — Generic, dependency-free validation/migration engine.
 *
 * One shared contract for every authoritative MWT store (design §3–§4 of
 * upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md):
 *
 *   - a store DESCRIPTOR: id, chat-metadata key (or lorebook location),
 *     currentVersion, createDefault(), ordered migrations, validate();
 *   - a pure VALIDATION result: canonical data + structured issues + counts;
 *   - a pure PREPARATION runner: validate / migrate / block, never persist.
 *
 * Purity rules (design §3.1–§3.2): this module must not import a feature
 * module, a feature barrel, or any browser/SillyTavern API. Persistence,
 * notifications, and diagnostics belong to orchestration. The only permitted
 * import is core/quarantine.js, same layer.
 */
import { fingerprintValue, makeQuarantineItem, mergeQuarantineItems } from './quarantine.js';

// ─── Shared predicates ───────────────────────────────────────────────────────
//
// The same three guards backup/validate.js used, promoted to the shared
// vocabulary so module schemas stop redefining them.

/** A plain JSON-style object (not null, not an array). */
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A string with at least one non-whitespace character. */
export const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

/** A finite number (never NaN, Infinity, or a numeric string). */
export const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

// ─── Structured issues (design §4.3) ─────────────────────────────────────────
//
// Logic and tests key off the stable `code`; UI text and backup summaries
// derive from `message`. Paths address a record (or field) inside the store.

export const ISSUE_SEVERITIES = Object.freeze({
    /** Deterministic, semantics-preserving repair; data retained. */
    REPAIR: 'repair',
    /** Invalid record removed from the live view; raw preserved in quarantine. */
    QUARANTINE: 'quarantine',
    /** Structurally valid but dangling/inconsistent; retained with a finding. */
    REFERENCE: 'reference',
    /** Store-level problem: unreadable root, failed migration, future version. */
    FATAL: 'fatal',
});

/** Build one issue record. `record` is the complete raw record involved. */
export function makeIssue({ code, path = [], severity, message, record = undefined }) {
    return { code, path, severity, message, record };
}

/** Convenience constructor for the dominant severity. */
export function quarantineIssue(code, path, message, record) {
    return makeIssue({ code, path, severity: ISSUE_SEVERITIES.QUARANTINE, message, record });
}

// ─── Validation stats ────────────────────────────────────────────────────────
//
// `added`/`conflicts` mirror the counts the backup summaries have always
// reported, so the compatibility adapter in backup/validate.js reproduces
// them without re-walking the data. `updated` stays 0 here: deciding whether
// an accepted record updates or adds is restore planning, not validation.

export function emptyStats() {
    return { added: 0, updated: 0, conflicts: 0 };
}

export function mergeStats(target, source) {
    target.added += source.added;
    target.updated += source.updated;
    target.conflicts += source.conflicts;
    return target;
}

// ─── Record-collection helpers ───────────────────────────────────────────────
//
// Shared traversal for the store shapes every module uses: keyed record lists
// (id-deduplicated), plain record arrays, and name → record maps. They carry
// the exact accept/skip semantics the backup validators had — including which
// value represents the rejected record (its id string when it has one, the
// record itself otherwise, the map key for map entries) — so porting the
// rules onto issues changes no observable summary.
//
// A record check returns null when the record is accepted, or
// { code, message } when it is not.

export function checkRecordList(list, label, check, { key = 'id', path = [] } = {}) {
    const records = [];
    const issues = [];
    const stats = emptyStats();
    if (list === undefined) return { records, issues, stats };
    if (!Array.isArray(list)) {
        issues.push(quarantineIssue('not-an-array', [...path], `${label} must be an array.`, label));
        return { records, issues, stats };
    }
    const seen = new Set();
    for (let index = 0; index < list.length; index++) {
        const record = list[index];
        const finding = check(record);
        const id = record && typeof record === 'object' ? record[key] : undefined;
        const identity = id === undefined ? null : String(id);
        if (finding) {
            issues.push(quarantineIssue(finding.code, [...path, index], finding.message, identity ?? record));
        } else if (identity !== null && seen.has(identity)) {
            stats.conflicts++;
            issues.push(quarantineIssue('duplicate-id', [...path, index, key], `Duplicate ${key} in ${label}.`, identity));
        } else {
            if (identity !== null) seen.add(identity);
            records.push(record);
            stats.added++;
        }
    }
    return { records, issues, stats };
}

export function checkUniqueRecordList(list, label, check, { path = [] } = {}) {
    const records = [];
    const issues = [];
    const stats = emptyStats();
    if (list === undefined) return { records, issues, stats };
    if (!Array.isArray(list)) {
        issues.push(quarantineIssue('not-an-array', [...path], `${label} must be an array.`, label));
        return { records, issues, stats };
    }
    for (let index = 0; index < list.length; index++) {
        const record = list[index];
        const finding = check(record);
        if (finding) {
            issues.push(quarantineIssue(finding.code, [...path, index], finding.message, record?.id ?? record));
        } else {
            records.push(record);
            stats.added++;
        }
    }
    return { records, issues, stats };
}

export function checkRecordMap(map, label, check, { path = [] } = {}) {
    const data = {};
    const issues = [];
    const stats = emptyStats();
    if (!isObject(map)) {
        issues.push(quarantineIssue('not-an-object', [...path], `${label} must be an object map.`, label));
        return { data, issues, stats };
    }
    for (const [name, value] of Object.entries(map)) {
        if (!isNonEmptyString(name)) {
            issues.push(quarantineIssue('empty-key', [...path, name], `${label} keys must be non-empty strings.`, name));
            continue;
        }
        // Shape guard so maps without a record-level check keep the permissive
        // object-only behaviour they always had.
        const finding = check
            ? check(value)
            : (isObject(value) ? null : { code: 'entry-not-object', message: `${label} entry must be an object.` });
        if (finding) {
            issues.push(quarantineIssue(finding.code, [...path, name], finding.message, name));
        } else {
            data[name] = value;
            stats.added++;
        }
    }
    return { data, issues, stats };
}

// ─── Plain-data cloning ──────────────────────────────────────────────────────

/**
 * Deep-clone JSON-shaped data without structuredClone (which is not available
 * in every SillyTavern browser target). Functions and symbols are dropped
 * like JSON; circular references throw. Twin of cloneBackupData() in
 * backup/data.js, kept local so core never imports upward (design §3.2).
 */
export function clonePlainData(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') {
        return (typeof value === 'function' || typeof value === 'symbol') ? undefined : value;
    }
    if (seen.has(value)) throw new TypeError('Store data must not contain circular references.');
    seen.set(value, true);
    const result = Array.isArray(value) ? [] : {};
    for (const [key, child] of Object.entries(value)) {
        const cloned = clonePlainData(child, seen);
        if (cloned !== undefined) result[key] = cloned;
    }
    seen.delete(value);
    return result;
}

// ─── Store descriptor contract (design §4.1) ────────────────────────────────

/**
 * Validate and freeze a store descriptor. Authoring mistakes (a missing
 * validator, a non-integer version, a mislabelled metadata key) fail loudly
 * at module load — the registry imports every descriptor, so a broken one
 * cannot slip into a release silently.
 *
 * A descriptor describes ONE authoritative store:
 *
 *   {
 *     id: 'chronicle',                      // registry + manifest section id
 *     metadataKey: 'session_chronicle_data', // chat-metadata location, OR…
 *     location: { … },                      // …a lorebook location (Knowledge)
 *     currentVersion: 1,
 *     createDefault: () => ({ … }),         // canonical empty value
 *     migrations: { 0: migrateV0ToV1 },     // keyed by FROM-version
 *     validate,                             // (data) => { data, issues, stats }
 *   }
 */
export function defineStoreSchema(descriptor) {
    if (!isObject(descriptor)) throw new TypeError('A store schema descriptor must be an object.');
    if (!isNonEmptyString(descriptor.id)) throw new TypeError('A store schema descriptor needs a non-empty id.');
    if (descriptor.metadataKey === undefined) {
        if (!isObject(descriptor.location)) {
            throw new TypeError(`Store schema "${descriptor.id}" needs a metadataKey or a storage location.`);
        }
    } else if (!isNonEmptyString(descriptor.metadataKey)) {
        throw new TypeError(`Store schema "${descriptor.id}" has an invalid metadataKey.`);
    }
    if (!Number.isInteger(descriptor.currentVersion) || descriptor.currentVersion < 1) {
        throw new TypeError(`Store schema "${descriptor.id}" needs a positive integer currentVersion.`);
    }
    if (typeof descriptor.createDefault !== 'function') {
        throw new TypeError(`Store schema "${descriptor.id}" needs a createDefault() factory.`);
    }
    if (!isObject(descriptor.migrations)) {
        throw new TypeError(`Store schema "${descriptor.id}" needs a migrations object (it may be empty).`);
    }
    if (typeof descriptor.validate !== 'function') {
        throw new TypeError(`Store schema "${descriptor.id}" needs a validate() function.`);
    }
    return Object.freeze({ ...descriptor });
}

// ─── Preparation runner (design §4.2) ───────────────────────────────────────

/**
 * Apply one migration step. A step may return the next data value directly,
 * an envelope `{ data, issues }` (its issues are retained), or nothing (the
 * previous value is kept). Migration steps stay pure; persistence belongs to
 * orchestration.
 */
function applyMigrationStep(step, data, issues) {
    const returned = step(data);
    if (returned === undefined || returned === null) return data;
    if (isObject(returned) && ('data' in returned || 'issues' in returned)) {
        if (Array.isArray(returned.issues)) issues.push(...returned.issues);
        return returned.data;
    }
    return returned;
}

/**
 * Convert quarantine-severity issues into recovery items. Part 1 captures the
 * same raw value the backup summaries kept; Part 2's migrations widen this to
 * the complete record (design §5.2) as the deep validators land.
 */
function collectQuarantineItems(storeId, issues, { sourceVersion, detectedAt }) {
    const items = [];
    for (const issue of issues) {
        if (issue?.severity !== ISSUE_SEVERITIES.QUARANTINE) continue;
        items.push(makeQuarantineItem({
            store: storeId,
            path: issue.path,
            reasonCode: issue.code,
            message: issue.message,
            raw: issue.record,
            sourceVersion,
            detectedAt,
        }));
    }
    return items;
}

/**
 * Run one validation pass, rethrowing a validator error tagged
 * 'validation-failed' (unless it already carries a code) so the runner's
 * catch reports it uniformly wherever it happens: at a per-step gate or at
 * the current version.
 */
function runValidation(descriptor, data) {
    try {
        return descriptor.validate(data);
    } catch (error) {
        const wrapped = new Error(error?.message ?? String(error));
        wrapped.code = error?.code ?? 'validation-failed';
        throw wrapped;
    }
}

/** The first FATAL-severity issue in a list, or null (design §3.5 category 4). */
function findFatalIssue(issues) {
    for (const issue of issues ?? []) {
        if (issue?.severity === ISSUE_SEVERITIES.FATAL) return issue;
    }
    return null;
}

/** Build the tagged error that turns a fatal finding into a blocked result. */
function makeFatalBlock(descriptor, fatalIssue) {
    const error = new Error(
        `Store "${descriptor.id}" validation reported a fatal problem `
        + `(${fatalIssue.code ?? 'unknown'}): ${fatalIssue.message ?? 'unreadable store'}; `
        + 'the original data was left unchanged.',
    );
    error.code = 'fatal-issue';
    return error;
}

/**
 * Structural (key-order-independent) equality via the quarantine fingerprint.
 * Unfingerprintable payloads (e.g. circular references) count as changed:
 * persistence must err toward saving, never toward skipping a repair.
 */
function isUnchangedData(before, after) {
    try {
        return fingerprintValue(before) === fingerprintValue(after);
    } catch {
        return false;
    }
}

/**
 * Pure preparation runner (design §4.2). Validates (and, once migrations
 * exist, migrates) one store's data, returning a stable result shape:
 *
 *   {
 *     status: 'valid' | 'migrated' | 'blocked',
 *     data,          // canonical live data; undefined when blocked
 *     original,      // the untouched caller input
 *     fromVersion, toVersion, changed,
 *     issues: [], quarantined: [], error: null | { code, message },
 *   }
 *
 * Contract:
 *   - A missing/invalid `version` option means legacy version 0.
 *   - A version NEWER than the descriptor's is refused untouched (category 4,
 *     design §3.5) — never coerced, never partially read.
 *   - Migrations run sequentially (0 -> 1 -> 2); a missing step blocks.
 *   - Input is cloned before any migration; caller data is never mutated and
 *     a blocked run leaves no partial result.
 *   - The validator runs after EVERY migration step and again at the current
 *     version (design §4.2), so malformed output is caught at the step that
 *     produced it instead of flowing into later steps undetected. A per-step
 *     pass is a gate: it keeps the step's own output (intermediate shapes
 *     stay owned by their migration functions, which may return `{ data,
 *     issues }` envelopes) and its non-fatal findings are provisional — the
 *     current-version validation owns canonicalization and reporting.
 *   - Any FATAL-severity finding, from a migration envelope or a validation
 *     pass, blocks the store with error code 'fatal-issue'; the original
 *     data is left untouched (design §3.5 category 4).
 *   - Quarantine records are built from the combined migration and validation
 *     issue lists, so a record a migration step rejects stays recoverable
 *     exactly like one the validator rejects (design §5.2).
 *   - Quarantine additions that cannot be stored (an explicit
 *     `maxQuarantineItems` ceiling models storage quota, design §5.2) block
 *     the store instead of losing the rejected record.
 *   - The runner is idempotent: canonical current-version data produces
 *     `valid`, no changes, and quarantine callers can dedup by fingerprint.
 *     `changed` is true whenever a migration ran OR validation returned data
 *     differing from the input, so persistence saves canonicalized repairs
 *     once instead of skipping them and rediscovering the same corruption.
 *
 * The version is passed in, not read from the data: chat-metadata stores keep
 * their version in the manifest, the Knowledge lorebook store inside the
 * store itself — reading either is orchestration's job.
 */
export function prepareStore(descriptor, input, options = {}) {
    const {
        version,
        existingQuarantine = [],
        now = Date.now(),
        maxQuarantineItems = Number.POSITIVE_INFINITY,
    } = options;
    const currentVersion = descriptor.currentVersion;
    const fromVersion = Number.isInteger(version) && version > 0 ? version : 0;
    const result = {
        status: 'blocked',
        data: undefined,
        original: input,
        fromVersion,
        toVersion: currentVersion,
        changed: false,
        issues: [],
        quarantined: [],
        error: null,
    };

    if (fromVersion > currentVersion) {
        result.error = {
            code: 'future-version',
            message: `Store "${descriptor.id}" is version ${fromVersion}; this build supports up to ${currentVersion} and left the data unchanged.`,
        };
        return result;
    }

    const issues = [];
    let working = input;
    let migrated = false;
    let validation;
    try {
        if (fromVersion < currentVersion) {
            // Clone before migrating: a dry run must never mutate caller input,
            // and a blocked step must leave no partial result (design §4.2).
            working = clonePlainData(input);
            for (let stepFrom = fromVersion; stepFrom < currentVersion; stepFrom++) {
                const step = descriptor.migrations[stepFrom];
                if (typeof step !== 'function') {
                    const missing = new TypeError(`Store "${descriptor.id}" has no migration from version ${stepFrom}.`);
                    missing.code = 'missing-migration';
                    throw missing;
                }
                working = applyMigrationStep(step, working, issues);
                migrated = true;
                // Design §4.2: validate after every migration step so malformed
                // output is caught at the step that produced it, never flowed
                // into later steps undetected. The gate keeps the step's own
                // output and discards provisional non-fatal findings — the
                // current-version validation below re-derives and reports them
                // on the final shape instead of listing them twice.
                validation = runValidation(descriptor, working);
                const gateFatal = findFatalIssue(validation.issues);
                if (gateFatal) {
                    issues.push(...validation.issues);
                    throw makeFatalBlock(descriptor, gateFatal);
                }
            }
        }
        // Validation at the current version owns canonicalization and the
        // reported findings, migrated or not (design §4.2).
        validation = runValidation(descriptor, working);
        issues.push(...validation.issues);
        const fatal = findFatalIssue(issues);
        if (fatal) throw makeFatalBlock(descriptor, fatal);
    } catch (error) {
        result.error = { code: error?.code ?? 'migration-failed', message: error?.message ?? String(error) };
        // Blocked results still carry the issues detected before the block:
        // they explain it, and nothing here is quarantine-persisted.
        result.issues = [...issues];
        return result;
    }

    // Quarantine records come from the combined migration and validation issue
    // lists, so a record a migration step rejects stays recoverable exactly
    // like one the validator rejects (design §5.2).
    const detected = collectQuarantineItems(descriptor.id, issues, { sourceVersion: fromVersion, detectedAt: now });
    if (detected.length > 0) {
        const totalAfterMerge = mergeQuarantineItems(existingQuarantine, detected).length;
        if (totalAfterMerge > maxQuarantineItems) {
            // Design §5.2: when quarantine cannot be stored safely, the
            // original store is left untouched and the store blocks. The
            // rejected record is never dropped to make room.
            result.error = {
                code: 'quarantine-limit',
                message: `Store "${descriptor.id}" produced ${detected.length} quarantine record(s) that cannot be stored; the original data was left unchanged.`,
            };
            result.issues = [...issues];
            return result;
        }
    }

    result.status = migrated ? 'migrated' : 'valid';
    // `changed` covers canonicalization, not just migration: validation can
    // remove invalid records or normalize values at the current version, and
    // persistence must save that once instead of skipping it and
    // rediscovering the same corruption on every load.
    result.changed = migrated || !isUnchangedData(input, validation.data);
    result.data = validation.data;
    result.issues = [...issues];
    result.quarantined = detected;
    return result;
}
