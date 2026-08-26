/**
 * schema/manifest.js — The `mwt_schema_manifest` container schema and helpers.
 *
 * Design §3.3 of SCHEMA_VALIDATION_MIGRATIONS_PLAN.md: one
 * chat-metadata key records, per store, the schema version the chat's data was
 * last prepared at:
 *
 *     {
 *       "manifestVersion": 1,
 *       "sections": {
 *         "worldState": 1,
 *         "chronicle": 1,
 *         "knowledgeEvidence": 1,
 *         "knowledgeCounters": 1,
 *         "storyPlanner": 1,
 *         "interiority": 1
 *       }
 *     }
 *
 * Rules this module owns:
 *   - A MISSING section version means legacy version 0 for that store — an
 *     absent store stays absent and is never manufactured just to be stamped.
 *   - Unknown section ids are PRESERVED (a newer MWT release may have stamped
 *     them; a downgrade must not destroy their markers).
 *   - A manifest from a NEWER MWT (manifestVersion > MANIFEST_VERSION) is
 *     REFUSED UNCHANGED — the unknown-future-version guardrail, same as for
 *     store data: it may carry top-level shapes this build cannot understand,
 *     so nothing here rewrites, re-stamps, or downgrades it. Stamping onto it
 *     is an authoring bug and throws.
 *   - Garbage never blocks anything else: the manifest is bookkeeping, and
 *     normalizeManifest() converges any non-future input on the canonical
 *     shape.
 *
 * The manifest is NOT registered in schema/registry.js STORE_SCHEMAS — it is
 * subsystem metadata ABOUT the stores, not one of them. Part 6 (runtime
 * cutover) reads and stamps it; until then everything here is dry-run only.
 *
 * Pure by contract: imports only core/schema.js; no DOM, no SillyTavern
 * runtime, no feature modules.
 */
import {
    emptyStats,
    fatalIssue,
    isNonEmptyString,
    isObject,
    quarantineIssue,
    repairIssue,
} from '../core/schema.js';

/** The chat-metadata key that owns the per-chat schema manifest (design §3.3). */
export const MANIFEST_METADATA_KEY = 'mwt_schema_manifest';

/** Version of the manifest container shape itself (independent of the stores). */
export const MANIFEST_VERSION = 1;

/** The canonical empty manifest: nothing stamped yet. */
export function createSchemaManifest() {
    return { manifestVersion: MANIFEST_VERSION, sections: {} };
}

/**
 * Detect a manifest written by a NEWER MWT. Integer-only: a fractional or
 * non-number manifestVersion is garbage this build converges on the canonical
 * shape; only a strictly greater integer version is a deliberate marker from
 * a release this one cannot understand.
 */
function isFutureManifest(value) {
    return isObject(value)
        && Number.isInteger(value.manifestVersion)
        && value.manifestVersion > MANIFEST_VERSION;
}

/**
 * Coerce any persisted value to the canonical manifest shape. Section entries
 * survive only as (non-empty id, positive integer) pairs; everything else is
 * dropped on the way in rather than carried forward as corruption.
 *
 * A FUTURE manifest (manifestVersion > MANIFEST_VERSION) is refused
 * UNCHANGED — returned exactly as passed in — so callers never silently
 * downgrade a newer release's container or discard its unfamiliar top-level
 * data (the unknown-future-version guardrail, design §3.5 category 4).
 */
export function normalizeManifest(value) {
    if (isFutureManifest(value)) return value;
    const source = isObject(value) ? value : {};
    const sectionsSource = isObject(source.sections) ? source.sections : {};
    const sections = {};
    for (const [id, version] of Object.entries(sectionsSource)) {
        if (isNonEmptyString(id) && Number.isInteger(version) && version > 0) {
            sections[id] = version;
        }
    }
    return { manifestVersion: MANIFEST_VERSION, sections };
}

/**
 * The stored schema version for one store id: a positive integer, or 0 when
 * the section is missing/unreadable — which the preparation runner treats as
 * legacy version 0 (design §4.2). Read defensively so a refused future
 * manifest (whose `sections` shape this build does not know) yields markers
 * only for entries that actually look like positive integers.
 */
export function getStoredStoreVersion(manifest, id) {
    const normalized = normalizeManifest(manifest);
    const sections = isObject(normalized?.sections) ? normalized.sections : {};
    const version = sections[id];
    return Number.isInteger(version) && version > 0 ? version : 0;
}

/**
 * Return a NEW manifest with one store's version stamped. Pure: the input is
 * never modified. Throws on malformed arguments — stamping a wrong version is
 * an authoring bug, not data corruption, and must fail loudly. Stamping onto
 * a FUTURE manifest also throws: the rewrite would downgrade it to the
 * current MANIFEST_VERSION and discard whatever the newer release recorded;
 * such a manifest must be refused unchanged, not re-stamped.
 */
export function stampStoreVersion(manifest, id, version) {
    if (!isNonEmptyString(id)) throw new TypeError('A manifest section id must be a non-empty string.');
    if (!Number.isInteger(version) || version < 1) throw new TypeError('A manifest section version must be a positive integer.');
    if (isFutureManifest(manifest)) {
        throw new TypeError(`Cannot stamp a schema manifest from a newer MWT (manifestVersion ${manifest.manifestVersion} > ${MANIFEST_VERSION}); it was left unchanged.`);
    }
    const next = normalizeManifest(manifest);
    next.sections[id] = version;
    return next;
}

/**
 * Validate a persisted manifest container (same `{ data, issues, stats }`
 * contract as every store validator). Non-future input is canonically
 * re-stamped with the current MANIFEST_VERSION; invalid entries are
 * quarantined with their raw value preserved in the issue record.
 *
 * A FUTURE manifest is refused unchanged: a fatal `manifest-version-future`
 * issue is reported and the ORIGINAL value is returned as `data` so a caller
 * that ignores the finding cannot persist an empty manifest over a newer
 * release's container (the downgrade this rule exists to prevent).
 */
export function validateManifestData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(quarantineIssue('root-not-object', [], 'Schema manifest must be an object.', data, MANIFEST_METADATA_KEY));
        return { data: createSchemaManifest(), issues, stats };
    }
    if (isFutureManifest(data)) {
        issues.push(fatalIssue(
            'manifest-version-future',
            ['manifestVersion'],
            `Manifest version ${data.manifestVersion} is newer than the supported version ${MANIFEST_VERSION}; the manifest was left unchanged.`,
            data.manifestVersion,
            'manifestVersion',
        ));
        return { data, issues, stats };
    }
    if (data.manifestVersion !== undefined && data.manifestVersion !== MANIFEST_VERSION) {
        issues.push(repairIssue(
            'manifest-version-invalid',
            ['manifestVersion'],
            `Manifest version must be ${MANIFEST_VERSION}; it was re-stamped.`,
            data.manifestVersion,
            'manifestVersion',
        ));
    }
    let sectionsSource = data.sections;
    if (data.sections === undefined) {
        sectionsSource = {};
    } else if (!isObject(data.sections)) {
        issues.push(quarantineIssue('sections-not-object', ['sections'], 'Manifest sections must be an object map.', data.sections, 'sections'));
        sectionsSource = {};
    }
    const sections = {};
    for (const [id, version] of Object.entries(sectionsSource)) {
        if (isNonEmptyString(id) && Number.isInteger(version) && version > 0) {
            sections[id] = version;
            stats.added++;
        } else {
            issues.push(quarantineIssue(
                'section-version-invalid',
                ['sections', id],
                'Manifest section versions must be positive integers.',
                version,
                id,
            ));
        }
    }
    return { data: { manifestVersion: MANIFEST_VERSION, sections }, issues, stats };
}
