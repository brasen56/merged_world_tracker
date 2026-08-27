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
    /**
     * Preparation cannot complete YET: chat-dependent work must run before the
     * store can be canonicalized. Not a fault — the store pauses (design §7.5)
     * with the original untouched, and every surface presents it as preparing,
     * never as corrupt or quarantined.
     */
    DEFER: 'defer',
});

/**
 * Build one issue record. `record` is the COMPLETE raw record/value involved
 * (design §5 acceptance): a recovery export must be able to reconstruct what
 * was rejected. `identity` is the optional display identity (id string, map
 * key, container label) shown in summaries instead of the raw payload.
 */
export function makeIssue({ code, path = [], severity, message, record = undefined, identity = undefined }) {
    return { code, path, severity, message, record, identity };
}

/** Convenience constructor for the dominant severity. */
export function quarantineIssue(code, path, message, record, identity = undefined) {
    return makeIssue({ code, path, severity: ISSUE_SEVERITIES.QUARANTINE, message, record, identity });
}

/** Convenience constructor for deterministic, semantics-preserving repairs. */
export function repairIssue(code, path, message, record = undefined, identity = undefined) {
    return makeIssue({ code, path, severity: ISSUE_SEVERITIES.REPAIR, message, record, identity });
}

/** Convenience constructor for store-level fatal problems (design §3.5). */
export function fatalIssue(code, path, message, record, identity = undefined) {
    return makeIssue({ code, path, severity: ISSUE_SEVERITIES.FATAL, message, record, identity });
}

/**
 * Convenience constructor for preparation deferrals (design §7.5). A deferral
 * is not a fatal finding: prepareStore() answers it with status 'deferred' —
 * a store-local pause pending chat-dependent work — instead of 'blocked', and
 * summaries/diagnostics present the store as preparing, not quarantined.
 */
export function deferIssue(code, path, message, record, identity = undefined) {
    return makeIssue({ code, path, severity: ISSUE_SEVERITIES.DEFER, message, record, identity });
}

// ─── Per-store issue policies (design §3.5) ──────────────────────────────────
//
// Part 2 adds a structured classification of the issue codes a store can
// emit, so runtime preparation, Diagnostics, and backup planning can decide
// what a finding MEANS without parsing message strings:
//
//   - repair     deterministic, semantics-preserving fix; data retained;
//   - record     invalid record removed from the live view; raw preserved in
//                quarantine (the dominant category today);
//   - reference  structurally valid but dangling/inconsistent; retained with
//                a finding;
//   - fatal      store-level problem; the store blocks instead of loading;
//   - defer      preparation cannot complete yet (chat-dependent work
//                pending); the store pauses with status 'deferred', the
//                original untouched, and is presented as preparing — never
//                as corrupt or quarantined (design §7.5).
//
// The lists are declarative — current validators emit only record-level
// findings, migrations only repair/quarantine ones, Interiority's legacy-key
// deferral the one defer code — but they are pinned by
// test/schema_migrations.test.js: any code a store's validator or migration
// emits must be declared in exactly one category, so the classification
// cannot drift from the rules.

export const POLICY_CATEGORIES = Object.freeze(['repair', 'record', 'reference', 'fatal', 'defer']);

/**
 * Build a frozen per-store issue policy. Unknown categories on the input are
 * ignored; each declared category becomes a frozen code list.
 */
export function defineIssuePolicy({ repair = [], record = [], reference = [], fatal = [], defer = [] } = {}) {
    return Object.freeze({
        repair: Object.freeze([...repair]),
        record: Object.freeze([...record]),
        reference: Object.freeze([...reference]),
        fatal: Object.freeze([...fatal]),
        defer: Object.freeze([...defer]),
    });
}

/** Which policy category (if any) owns this code for this store. */
export function getPolicyCategory(policy, code) {
    if (!isObject(policy) || typeof code !== 'string') return null;
    for (const category of POLICY_CATEGORIES) {
        if (Array.isArray(policy[category]) && policy[category].includes(code)) return category;
    }
    return null;
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
// (id-deduplicated), plain record arrays, and name → record maps. Rejected
// entries keep their COMPLETE raw record/value in `record` (the Part 2
// acceptance rule: recovery exports must reconstruct rejected data); the
// display identity (id string, map key, container label) rides separately in
// `identity`.
//
// A record check returns null when the record is accepted, or
// { code, message } when it is not.

export function checkRecordList(list, label, check, { key = 'id', path = [] } = {}) {
    const records = [];
    const issues = [];
    const stats = emptyStats();
    if (list === undefined) return { records, issues, stats };
    if (!Array.isArray(list)) {
        issues.push(quarantineIssue('not-an-array', [...path], `${label} must be an array.`, list, label));
        return { records, issues, stats };
    }
    const seen = new Set();
    for (let index = 0; index < list.length; index++) {
        const record = list[index];
        const finding = check(record);
        const id = record && typeof record === 'object' ? record[key] : undefined;
        const identity = id === undefined ? null : String(id);
        if (finding) {
            issues.push(quarantineIssue(finding.code, [...path, index], finding.message, record, identity ?? undefined));
        } else if (identity !== null && seen.has(identity)) {
            stats.conflicts++;
            issues.push(quarantineIssue('duplicate-id', [...path, index, key], `Duplicate ${key} in ${label}.`, record, identity));
        } else {
            if (identity !== null) seen.add(identity);
            records.push(record);
            stats.added++;
        }
    }
    return { records, issues, stats };
}

/**
 * Check a record list WITHOUT id-deduplication: every record the per-record
 * check accepts is kept, duplicate ids included. This is the helper for
 * stores whose own canonicalizer resolves repeats afterwards (Story Planner's
 * sanitizeArcs() mints a fresh id for a duplicate arc id); for stores that
 * instead quarantine repeats as conflicts, checkRecordList() is the
 * deduplicating twin — the names must not be swapped.
 */
export function checkPlainRecordList(list, label, check, { path = [] } = {}) {
    const records = [];
    const issues = [];
    const stats = emptyStats();
    if (list === undefined) return { records, issues, stats };
    if (!Array.isArray(list)) {
        issues.push(quarantineIssue('not-an-array', [...path], `${label} must be an array.`, list, label));
        return { records, issues, stats };
    }
    for (let index = 0; index < list.length; index++) {
        const record = list[index];
        const finding = check(record);
        if (finding) {
            issues.push(quarantineIssue(finding.code, [...path, index], finding.message, record, record?.id ?? undefined));
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
        issues.push(quarantineIssue('not-an-object', [...path], `${label} must be an object map.`, map, label));
        return { data, issues, stats };
    }
    for (const [name, value] of Object.entries(map)) {
        if (!isNonEmptyString(name)) {
            issues.push(quarantineIssue('empty-key', [...path, name], `${label} keys must be non-empty strings.`, value, name));
            continue;
        }
        // Shape guard so maps without a record-level check keep the permissive
        // object-only behaviour they always had.
        const finding = check
            ? check(value)
            : (isObject(value) ? null : { code: 'entry-not-object', message: `${label} entry must be an object.` });
        if (finding) {
            issues.push(quarantineIssue(finding.code, [...path, name], finding.message, value, name));
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
    if (descriptor.policy !== undefined
        && (!isObject(descriptor.policy)
            || POLICY_CATEGORIES.some(category => !Array.isArray(descriptor.policy[category])))) {
        throw new TypeError(`Store schema "${descriptor.id}" has an invalid policy (expected repair/record/reference/fatal/defer arrays).`);
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
 * Convert quarantine-severity issues into recovery items. Validators capture
 * the same raw value the backup summaries always kept; Part 2's migrations
 * emit complete records (a malformed receipt tuple, a legacy plan blob) so
 * everything a migration rejects stays recoverable whole (design §5.2).
 * Shared by prepareStore() and by the module write seams (design §8): the
 * record a validator rejects at a WRITE seam is preserved exactly like one
 * rejected at load — `record` carries the COMPLETE raw value, so a recovery
 * export can reconstruct what was refused.
 *
 * An issue may carry its own integer `sourceVersion` to override the group
 * default — a single batch can then mix records from different source
 * versions (e.g. this store's findings plus an import file's findings
 * prepared from a legacy version) while staying ONE preservation call, so
 * the commit keeps a single refusal point.
 */
export function collectQuarantineItems(storeId, issues, { sourceVersion, detectedAt }) {
    const items = [];
    for (const issue of issues) {
        if (issue?.severity !== ISSUE_SEVERITIES.QUARANTINE) continue;
        items.push(makeQuarantineItem({
            store: storeId,
            path: issue.path,
            reasonCode: issue.code,
            message: issue.message,
            raw: issue.record,
            sourceVersion: Number.isInteger(issue.sourceVersion) ? issue.sourceVersion : sourceVersion,
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

/** The first DEFER-severity issue in a list, or null (design §7.5). */
function findDeferIssue(issues) {
    for (const issue of issues ?? []) {
        if (issue?.severity === ISSUE_SEVERITIES.DEFER) return issue;
    }
    return null;
}

/** Build the tagged error that turns a fatal finding into a blocked result. */
function makeFatalBlock(descriptor, issue) {
    const error = new Error(
        `Store "${descriptor.id}" validation reported a fatal problem `
        + `(${issue.code ?? 'unknown'}): ${issue.message ?? 'unreadable store'}; `
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
 *     status: 'valid' | 'migrated' | 'blocked' | 'deferred',
 *     data,          // canonical live data; undefined when blocked/deferred
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
 *   - Any DEFER-severity finding returns status 'deferred' (design §7.5): a
 *     store-local pause pending chat-dependent preparation, not a fault. The
 *     original is left untouched, nothing is quarantined or stamped, and
 *     `error` stays null — the issues explain the pause. The runtime gate
 *     must clear it through a dedicated preparation path (privileged
 *     orchestration, not the module's own queued work), then re-run
 *     preparation; a deferral must never render as corrupt or quarantined.
 *     The ONE caller that accepts deferred entries — the backup/import
 *     boundary, which retains them (design §7.7) — passes
 *     `deferPolicy: 'canonicalize'` so the canonical (retained-entries) value
 *     is returned alongside the status instead of `undefined`.
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
        deferPolicy = 'pause',
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

    // A DEFER-severity finding is a pause, not a fault (design §7.5): it names
    // chat-dependent preparation that must run before this store can be
    // canonicalized. The store stays at its current version with the original
    // untouched — nothing is quarantined, persisted, or stamped, and `error`
    // stays null — until the privileged preparation path converts the data and
    // preparation is re-run. Quarantine findings found alongside a deferral
    // are re-derived after preparation instead of being collected now.
    if (findDeferIssue(issues)) {
        result.status = 'deferred';
        result.issues = [...issues];
        // The backup/import boundary (design §7.7, §8) is the one caller that
        // ACCEPTS deferred entries: the validator retained them, so canonical
        // data exists even though runtime preparation would pause. With
        // `deferPolicy: 'canonicalize'` that canonical value rides along so a
        // restore can commit the retained records now; the runtime load gate
        // (the default 'pause') still gets the untouched original instead.
        if (deferPolicy === 'canonicalize') {
            result.data = validation.data;
            result.changed = migrated || !isUnchangedData(input, validation.data);
        }
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

// ─── Write-seam preparation (design §8, Part 3) ──────────────────────────────

/**
 * Validate the COMPLETE proposed next store value at a module write seam.
 *
 * Design §8: "For writes, validate the complete proposed next store rather
 * than only the patch. The mutation must either commit canonical data or
 * leave the previous value intact." This helper is the pure half of that
 * contract; the caller owns persistence:
 *
 *   const next = prepareNextStoreValue(schema, current, patch);
 *   if (!next.ok) return current;        // fatal — leave the previous intact
 *   commit(next.data);                   // canonical data (may drop invalid
 *                                        // records — preserve them in
 *                                        // quarantine via next.issues)
 *
 * Rules:
 *   - The next value is `{ ...current, ...patch }`; the CURRENT version's
 *     validator canonicalizes it. A genuinely ABSENT store (`undefined`/`null`
 *     — the values the metadata accessors produce for a missing key) starts
 *     from the descriptor's canonical default, so a missing store is never an
 *     excuse to skip the seam.
 *   - A PRESENT but non-object `current` (a corrupted root, e.g. a string that
 *     survived in metadata) also fails closed: it is returned untouched as
 *     `data` with a fatal root finding. Substituting the default here would
 *     return ok:true and let the caller commit a fresh canonical store over
 *     the unreadable original — destroying it without a quarantine record —
 *     which is exactly the loss the fatal-root policy exists to prevent
 *     (design §3.5 category 4).
 *   - A FATAL finding (an unreadable root) fails closed: `ok: false` with the
 *     previous value returned as `data`, so the caller can leave it intact.
 *   - DEFER findings do NOT fail a write: the validator RETAINED those
 *     entries (legacy Interiority per-message keys pending the chat-dependent
 *     conversion), and refusing the write would freeze the module. They ride
 *     along in `issues` exactly as they do for a backup import.
 *   - Quarantine-severity findings are reported in `issues`; the caller that
 *     persists the canonical result must preserve the complete rejected
 *     records (design §5.2) — `collectQuarantineItems` builds the items from
 *     these issues, or `prepareStore` does when the caller has a version.
 *
 * @param {object} descriptor registered store descriptor
 * @param {*} current the live current value of the store
 * @param {object} patch shallow patch to apply on top
 * @returns {{ ok: boolean, data: object, issues: object[], changed: boolean }}
 */
export function prepareNextStoreValue(descriptor, current, patch = {}) {
    const absent = current === undefined || current === null;
    const base = absent ? descriptor.createDefault() : current;
    if (!isObject(base)) {
        // Present-but-invalid root: fail closed with the PREVIOUS value (not a
        // manufactured default) so the caller leaves the stored value intact.
        return { ok: false, data: current, issues: [makeIssue({
            code: 'root-not-object',
            path: [],
            severity: ISSUE_SEVERITIES.FATAL,
            message: `Store "${descriptor.id}" must be an object; the previous value was kept.`,
            record: current,
            identity: descriptor.id,
        })], changed: false };
    }
    const next = isObject(patch) ? { ...base, ...patch } : base;
    let validation;
    try {
        validation = runValidation(descriptor, next);
    } catch (error) {
        // A validator that THROWS is a store-level fault: fail closed with the
        // previous value intact rather than committing anything.
        return { ok: false, data: base, issues: [makeIssue({
            code: error?.code ?? 'validation-failed',
            severity: ISSUE_SEVERITIES.FATAL,
            message: error?.message ?? String(error),
        })], changed: false };
    }
    const fatal = findFatalIssue(validation.issues);
    if (fatal) {
        return { ok: false, data: base, issues: validation.issues, changed: false };
    }
    return {
        ok: true,
        data: validation.data,
        issues: validation.issues,
        changed: !isUnchangedData(next, validation.data),
    };
}
