/**
 * backup/validate.js — Compatibility adapter over the schema registry.
 *
 * The per-section validation rules MOVED to each module's schema owner
 * (world_state/schema.js, chronicle/schema.js, knowledge/schema.js,
 * story_planner/schema.js, interiority/schema.js) behind schema/registry.js —
 * one owner per store, shared by backup, runtime loading, and imports
 * (design §3.2/§8 of SCHEMA_VALIDATION_MIGRATIONS_PLAN.md). Every function
 * here accepts plain objects and returns plain objects; invalid records are
 * quarantined in `skipped`, never silently coerced.
 *
 * This file keeps the historical backup-facing surface:
 *   - accepted/skipped summaries ({ added, updated, skipped, conflicts }) for
 *     restore planning and the Diagnostics integrity collector;
 *   - validateSection / validateBackupEnvelope as the envelope gate.
 *
 * Part 3 (design §7.7) makes the IMPORT path a full preparation:
 * prepareBackupSection() runs each section's registered migrations from the
 * version its wrapper declares, then validates at the current version — so a
 * merge/replace preview is always planned against current-version canonical
 * data, whatever version the backup was exported at.
 *
 * Do not add new validation rules here — add them to a module schema.
 * `skipped` entries are derived from quarantine-severity issues; the reason
 * strings are the issues' messages and the records are the issues' display
 * identities, kept identical to the previous implementation so summaries do
 * not churn.
 */
import { BACKUP_TYPE, FORMAT_VERSION } from './data.js';
import { STORE_SCHEMAS, getStoreSchema } from '../schema/registry.js';
import { ISSUE_SEVERITIES, prepareStore } from '../core/schema.js';
import { importQuarantineItems } from '../core/quarantine.js';

/**
 * Adapt a module-schema validation result to the backup summary shape.
 * Quarantine-severity issues become the skipped list in detection order;
 * FATAL store-level findings (an unreadable root) ride along so the summary
 * never hides a section this build refused to canonicalize. Repair/reference
 * findings stay out of it, exactly as before.
 *
 * DEFER findings (preparation paused pending chat-dependent work) are kept
 * OUT of `skipped`: the entries they describe were retained — not refused —
 * and a backup import accepts them, so counting them as skipped would both
 * double-report the same data and misrender a preparing store as a corrupt
 * one. They ride a separate `deferred` list, present ONLY when a deferral
 * exists so clean sections keep the exact historical summary shape; live
 * surfaces use it to present the store as "preparing".
 *
 * Skipped records keep the pre-adapter DISPLAY contract: the issue's
 * `identity` (id string, map key, field label) when one exists, with the raw
 * rejected value only as the fallback — summaries and the restore preview
 * render identifiers, never rejected prose. The complete `issue.record` stays
 * on the issue, where quarantine creation (prepareStore) reads it.
 */
function toBackupSummary(validation) {
    const deferred = validation.issues
        .filter(issue => issue.severity === ISSUE_SEVERITIES.DEFER)
        .map(issue => ({ record: issue.identity ?? issue.record, reason: issue.message }));
    return {
        added: validation.stats.added,
        // Validators never merge; "updated" is decided by restore planning.
        updated: 0,
        skipped: validation.issues
            .filter(issue => issue.severity === ISSUE_SEVERITIES.QUARANTINE || issue.severity === ISSUE_SEVERITIES.FATAL)
            .map(issue => ({ record: issue.identity ?? issue.record, reason: issue.message })),
        conflicts: validation.stats.conflicts,
        ...(deferred.length > 0 ? { deferred } : {}),
    };
}

function validateSectionData(id, data) {
    const validation = STORE_SCHEMAS[id].validate(data);
    return { data: validation.data, ...toBackupSummary(validation) };
}

// ─── Compatibility exports ───────────────────────────────────────────────────
//
// The same section names and result shapes the restore planner, the
// Diagnostics integrity collector, and the tests have consumed since backup
// Phase 1. Each one delegates to its registered module schema.

export function validateWorldState(data) { return validateSectionData('worldState', data); }

export function validateChronicle(data) { return validateSectionData('chronicle', data); }

export function validateKnowledgeEvidence(data) { return validateSectionData('knowledgeEvidence', data); }

export function validateCounters(data) { return validateSectionData('knowledgeCounters', data); }

export function validateStoryPlanner(data) { return validateSectionData('storyPlanner', data); }

export function validateInteriority(data) { return validateSectionData('interiority', data); }

export function validateKnowledgeStore(data) { return validateSectionData('knowledgeStore', data); }

export { validateCounters as validateKnowledgeCounters };

/**
 * Validate one named backup section. Unknown sections are ignored with a
 * warning; their data never enters the restore plan.
 */
export function validateSection(name, data) {
    const schema = getStoreSchema(name);
    if (!schema) {
        return { data: {}, added: 0, updated: 0, skipped: [], conflicts: 0, warning: `Unknown backup section "${name}" was ignored.` };
    }
    return validateSectionData(schema.id, data);
}

// ─── Import preparation (design §7.7, Part 3) ────────────────────────────────

/**
 * Migrate and validate ONE backup section from the version its wrapper
 * declares, producing the current-version canonical data a merge/replace plan
 * is planned against.
 *
 * This is the import twin of the runtime load gate: the same
 * `prepareStore()` runner, the same migrations, the same quarantine records —
 * `deferPolicy: 'canonicalize'` because an import ACCEPTS deferred entries
 * (their conversion is chat-dependent and runs later, design §7.5), while a
 * blocked store (fatal root, failed migration, future version) refuses the
 * section instead of importing an empty replacement for unreadable data.
 *
 * The summary's `added` counts the ACCEPTED records of the canonical result
 * (a deterministic re-validation of canonical data — the same numbers the
 * validate-only path always reported); `skipped`/`deferred` come from the
 * preparation issues, which name every record that was rejected or retained
 * pending preparation. `migrated: true` appears only when the wrapper's
 * version was older than the store's current version, so clean imports keep
 * the exact historical summary shape.
 *
 * @param {object} schema registered store descriptor (or a test descriptor
 *   with the same contract)
 * @param {*} data the section's raw data
 * @param {number} version the version the section wrapper declares
 * @returns {{
 *   ok: boolean,
 *   data?: object,
 *   summary?: object,
 *   quarantined?: object[],
 *   status?: string,
 *   error?: string,
 * }} `ok: false` carries a single user-facing `error` string.
 */
export function prepareBackupSection(schema, data, version) {
    const prepared = prepareStore(schema, data, { version, deferPolicy: 'canonicalize' });
    if (prepared.status === 'blocked') {
        return {
            ok: false,
            status: prepared.status,
            error: `Section "${schema.id}" could not be imported: ${prepared.error?.message ?? 'preparation failed'}.`,
        };
    }
    // Deterministic stats for the canonical result — validation of already
    // canonical data re-derives the accepted-record counts (imports are a
    // triggered deep validation, design §7.1, so the second walk is fine).
    const canonical = schema.validate(prepared.data);
    const deferred = prepared.issues
        .filter(issue => issue.severity === ISSUE_SEVERITIES.DEFER)
        .map(issue => ({ record: issue.identity ?? issue.record, reason: issue.message }));
    const summary = {
        added: canonical.stats.added,
        // Validators never merge; "updated" is decided by restore planning.
        updated: 0,
        skipped: prepared.issues
            .filter(issue => issue.severity === ISSUE_SEVERITIES.QUARANTINE || issue.severity === ISSUE_SEVERITIES.FATAL)
            .map(issue => ({ record: issue.identity ?? issue.record, reason: issue.message })),
        conflicts: canonical.stats.conflicts,
        ...(deferred.length > 0 ? { deferred } : {}),
        ...(prepared.status === 'migrated' ? { migrated: true } : {}),
    };
    return {
        ok: true,
        status: prepared.status,
        data: prepared.data,
        summary,
        quarantined: prepared.quarantined,
    };
}

/**
 * Validate the envelope and all known sections. Unknown sections are ignored
 * with warnings; unknown-high versions refuse the entire import.
 *
 * Section version ceilings come from the registered descriptors: chat-metadata
 * sections carry `schemaVersion`, the knowledgeStore wrapper carries
 * `storeVersion` (mirroring the embedded lorebook STORE_VERSION). Each section
 * is MIGRATED from its declared version before validation (§7.7), so
 * `result.sections` is always current-version canonical data and per-section
 * quarantine records detected on the way in ride in `result.quarantine` for
 * the restore commit to preserve (§5.2). An envelope-level `quarantine`
 * recovery container (§5.3) is accepted through the tolerant recovery import
 * and surfaced as `result.recovery`; malformed recovery data warns but never
 * blocks a restore.
 */
export function validateBackupEnvelope(envelope, { maxFormatVersion = FORMAT_VERSION } = {}) {
    const result = { ok: false, errors: [], warnings: [], sections: {}, summaries: {}, quarantine: {} };
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
        result.errors.push('Backup must be a JSON object.');
        return result;
    }
    const meta = envelope._meta;
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || meta.type !== BACKUP_TYPE) {
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
    if (typeof envelope.sections !== 'object' || envelope.sections === null || Array.isArray(envelope.sections)) {
        result.errors.push('Backup sections must be an object.');
        return result;
    }
    for (const [name, wrapped] of Object.entries(envelope.sections)) {
        const schema = getStoreSchema(name);
        if (!schema) {
            result.warnings.push(`Unknown backup section "${name}" was ignored.`);
            continue;
        }
        if (typeof wrapped !== 'object' || wrapped === null || Array.isArray(wrapped)) {
            result.errors.push(`Section "${name}" must be an object.`);
            continue;
        }
        const version = name === 'knowledgeStore' ? wrapped.storeVersion : wrapped.schemaVersion;
        const maxVersion = schema.currentVersion;
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
        const prepared = prepareBackupSection(schema, wrapped.data, version);
        if (!prepared.ok) {
            result.errors.push(prepared.error);
            continue;
        }
        result.sections[name] = prepared.data;
        result.summaries[name] = prepared.summary;
        if (prepared.quarantined.length > 0) {
            result.quarantine[name] = prepared.quarantined;
        }
    }
    // Recovery data (§5.3): the source chat's quarantined records ride with
    // the backup. It is imported tolerantly and can never block the restore —
    // refusing a whole backup over malformed recovery data would strand the
    // user's real stores to protect bookkeeping about old rejected records.
    if (envelope.quarantine !== undefined && envelope.quarantine !== null) {
        const recovery = importQuarantineItems(envelope.quarantine);
        for (const issue of recovery.issues) {
            result.warnings.push(`Quarantine recovery data: ${issue.message}`);
        }
        result.recovery = { items: recovery.items };
    }
    result.ok = result.errors.length === 0;
    return result;
}
