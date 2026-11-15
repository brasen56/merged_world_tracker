/**
 * ambient/schema.js — Ambient Conditions store descriptor.
 *
 * The module-owned schema for `chat_metadata.mwt_ambient`: Ambient
 * Conditions' chat-local record (AMBIENT_CONDITIONS_DESIGN.md: enabled,
 * climate, hemisphere, season, variability, the astronomy and tide inputs,
 * the pin, frequency phenomena, and the generation `seed`). Registered so
 * that backup, runtime preparation and Diagnostics enumerate it like every
 * other chat-metadata store (schema/registry.js). Before registration a
 * backup silently dropped it, and a restore re-rolled the seed, which
 * changes the chat's weather history.
 *
 * Deliberately shallow. The record is a flat settings object whose fields the
 * module validates at its own write seam (ambient/settings.js saveSettings)
 * and reads tolerantly (getSettings / getAmbientStatus fall back per field and
 * report "setup required"). The load gate runs this validator on every
 * existing chat's first open after upgrade, so a stricter field check here
 * would remove settings the module reads today. The only fatal rule is the
 * shared unreadable-root rule. The one field check is the seed, as a
 * reference finding (retained, never removed): it is the field whose loss
 * changes the story, and ensureSeed() replaces a non-number seed on the next
 * generation, so the finding says why the weather will change.
 *
 * Validation checks and never canonicalizes: the accepted data is the stored
 * record unchanged.
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and
 * ambient/settings.js SETTINGS_KEY); test/schema_engine.test.js pins the
 * registry against METADATA_KEYS.
 */
import {
    defineIssuePolicy,
    defineStoreSchema,
    emptyStats,
    fatalIssue,
    isFiniteNumber,
    isObject,
    ISSUE_SEVERITIES,
    makeIssue,
} from '../core/schema.js';

/** Validate a stored Ambient record: object root, plus a seed check. */
export function validateAmbientData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(fatalIssue('root-not-object', [], 'Ambient Conditions data must be an object.', data, 'ambient'));
        return { data: {}, issues, stats };
    }
    if (data.seed !== undefined && !isFiniteNumber(data.seed)) {
        issues.push(makeIssue({
            code: 'seed-invalid',
            path: ['seed'],
            severity: ISSUE_SEVERITIES.REFERENCE,
            message: 'The Ambient seed is not a number; a new seed (and new weather history) will be generated on the next included generation.',
            record: data.seed,
            identity: 'seed',
        }));
    }
    stats.added = 1;
    return { data: { ...data }, issues, stats };
}

/**
 * v0 -> v1: no shape change; the step lets the load gate stamp the store at
 * v1. A non-object root is returned untouched for the fatal-root policy.
 */
export function migrateAmbientV0ToV1(data) {
    if (!isObject(data)) return { data, issues: [] };
    return { data: { ...data }, issues: [] };
}

/**
 * Ambient store schema. `createDefault` is the empty record, which the
 * module reads as "disabled, not set up". Nothing writes it: an absent store
 * stays absent until the user sets Ambient up.
 */
export const ambientSchema = defineStoreSchema({
    id: 'ambient',
    metadataKey: 'mwt_ambient',
    currentVersion: 1,
    createDefault: () => ({}),
    migrations: { 0: migrateAmbientV0ToV1 },
    validate: validateAmbientData,
    policy: defineIssuePolicy({
        fatal: ['root-not-object'],
        reference: ['seed-invalid'],
    }),
});
