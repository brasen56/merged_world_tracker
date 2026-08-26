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
 *   - accepted/skipped summaries ({ added, updated, skipped, conflicts })
 *     for restore planning and the Diagnostics integrity collector;
 *   - validateSection / validateBackupEnvelope as the envelope gate.
 *
 * Do not add new validation rules here — add them to a module schema.
 * `skipped` entries are derived from quarantine-severity issues; the reason
 * strings are the issues' messages and the records are the issues' display
 * identities, kept identical to the previous implementation so summaries do
 * not churn.
 */
import { BACKUP_TYPE, FORMAT_VERSION } from './data.js';
import { STORE_SCHEMAS, getStoreSchema } from '../schema/registry.js';
import { ISSUE_SEVERITIES } from '../core/schema.js';

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

/**
 * Validate the envelope and all known sections. Unknown sections are ignored
 * with warnings; unknown-high versions refuse the entire import.
 *
 * Section version ceilings come from the registered descriptors: chat-metadata
 * sections carry `schemaVersion`, the knowledgeStore wrapper carries
 * `storeVersion` (mirroring the embedded lorebook STORE_VERSION).
 */
export function validateBackupEnvelope(envelope, { maxFormatVersion = FORMAT_VERSION } = {}) {
    const result = { ok: false, errors: [], warnings: [], sections: {}, summaries: {} };
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
        const checked = validateSection(name, wrapped.data);
        result.sections[name] = checked.data;
        result.summaries[name] = {
            added: checked.added,
            updated: checked.updated,
            skipped: checked.skipped,
            conflicts: checked.conflicts,
            // Present only when a deferral exists (see toBackupSummary): a
            // preparing store, never a quarantine count.
            ...(Array.isArray(checked.deferred) && checked.deferred.length > 0 ? { deferred: checked.deferred } : {}),
        };
    }
    result.ok = result.errors.length === 0;
    return result;
}
