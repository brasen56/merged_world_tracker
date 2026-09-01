/**
 * core/settings_schema.js — Versioning + validation for MWT settings records.
 *
 * Schema plan §2.2 / Part 7: the global and per-module settings kept in
 * `extension_settings` (or the localStorage fallback) are MWT-owned
 * persistence too, so they get the same treatment as the authoritative
 * stores — an explicit version marker plus validation in the shared
 * core/schema.js vocabulary — with one deliberate difference:
 *
 *   Settings are CONFIG, not chat data. A store that cannot be prepared
 *   BLOCKS its module (design §5.4); settings that cannot be read fall BACK
 *   to defaults and keep going. Every finding here is therefore advisory:
 *   the canonical record repairs forward, a future version is read as-is
 *   and never rewritten by a read, and nothing is ever destroyed.
 *
 *   For the same reason no RAW record is embedded in the issues (unlike the
 *   store validators' design §5.2 recovery copies): settings can carry API
 *   keys, an issue may reach a report surface, and there is nothing to
 *   preserve — the stored record is never removed by validation, so the
 *   storage itself is the recovery copy.
 *
 * Purity (design §3.1): this module imports only core/schema.js — no DOM,
 * no host runtime, no feature modules. Persistence stays in
 * core/settings.js.
 */
import { isObject, makeIssue, ISSUE_SEVERITIES } from './schema.js';

/** Current settings-record schema version (schema plan Part 7). */
export const SETTINGS_SCHEMA_VERSION = 1;

/** The field that carries the version marker inside a stored settings record. */
export const SETTINGS_VERSION_FIELD = 'schemaVersion';

/** Stable issue codes (design §4.3: logic keys off the code, not the message). */
export const SETTINGS_ISSUE_CODES = Object.freeze({
    ROOT_NOT_OBJECT: 'settings-root-not-object',
    // The stored value was not even parseable JSON (truncated quota write,
    // disk corruption). Reported by core/settings.js's parse seam — a parse
    // failure cannot reach the validator, so it becomes a finding there.
    PARSE_FAILED: 'settings-record-unparseable',
    FUTURE_VERSION: 'settings-future-version',
    VERSION_MARKER_INVALID: 'settings-version-marker-invalid',
    FIELD_COERCED: 'settings-field-coerced',
    FIELD_RESET: 'settings-field-reset',
});

/**
 * Validate one stored settings record.
 *
 * @param {*} raw the value found in storage (any shape — this must never throw)
 * @param {object} [options]
 * @param {object} [options.defaults] the manager's defaults object; scalar
 *   defaults declare the expected type of their field
 * @param {number} [options.currentVersion] version this build writes
 * @param {boolean} [options.resetToAbsent] an unusable present field is
 *   DROPPED (reads as "not set") instead of being reset to the catalog's
 *   default value. For records whose consumers distinguish present from
 *   absent (the global accessor's global-wins precedence contract):
 *   materializing the catalog default would flip absent→present and let a
 *   corrupt field override module-level settings.
 * @returns {{
 *   status: 'ready'|'future-version'|'invalid-root',
 *   data: (object|null),   canonical record INCLUDING the stamped version
 *                          field (the persisted shape); the raw record
 *                          itself for a future version; null for an
 *                          invalid root
 *   issues: object[],      shared-vocabulary issues (no raw record embedded)
 *   storedVersion: number|null,
 * }}
 */
export function validateStoredSettings(raw, {
    defaults = {},
    currentVersion = SETTINGS_SCHEMA_VERSION,
    resetToAbsent = false,
} = {}) {
    if (!isObject(raw)) {
        return {
            status: 'invalid-root',
            data: null,
            storedVersion: null,
            issues: [makeIssue({
                code: SETTINGS_ISSUE_CODES.ROOT_NOT_OBJECT,
                path: [],
                severity: ISSUE_SEVERITIES.FATAL,
                message: 'Stored settings must be a JSON object; defaults are used instead.',
            })],
        };
    }

    const issues = [];
    let storedVersion = 0;
    const marker = raw[SETTINGS_VERSION_FIELD];
    if (marker !== undefined) {
        if (Number.isInteger(marker) && marker >= 0) {
            storedVersion = marker;
        } else {
            issues.push(makeIssue({
                code: SETTINGS_ISSUE_CODES.VERSION_MARKER_INVALID,
                path: [SETTINGS_VERSION_FIELD],
                severity: ISSUE_SEVERITIES.REPAIR,
                message: 'The settings version marker was not a non-negative integer and was dropped.',
            }));
        }
    }

    if (storedVersion > currentVersion) {
        // Unknown future version: read as-is and never rewritten HERE (the
        // §12 no-silent-downgrade rule; the fail-open note in the header
        // explains why settings still load instead of pausing a module).
        return {
            status: 'future-version',
            data: raw,
            storedVersion,
            issues: [...issues, makeIssue({
                code: SETTINGS_ISSUE_CODES.FUTURE_VERSION,
                path: [SETTINGS_VERSION_FIELD],
                severity: ISSUE_SEVERITIES.FATAL,
                message: `Settings were written by a newer MWT (schema v${storedVersion} > v${currentVersion}); read as-is.`,
            })],
        };
    }

    const data = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key === SETTINGS_VERSION_FIELD) continue;
        const expected = scalarType(defaults?.[key]);
        if (expected) {
            const coerced = coerceScalar(value, expected);
            if (coerced) {
                if (coerced.changed) {
                    issues.push(makeIssue({
                        code: SETTINGS_ISSUE_CODES.FIELD_COERCED,
                        path: [key],
                        severity: ISSUE_SEVERITIES.REPAIR,
                        message: `Settings field "${key}" was stored as a ${typeof value}; coerced to a ${expected}.`,
                    }));
                }
                data[key] = coerced.value;
            } else {
                issues.push(makeIssue({
                    code: SETTINGS_ISSUE_CODES.FIELD_RESET,
                    path: [key],
                    severity: ISSUE_SEVERITIES.REPAIR,
                    message: `Settings field "${key}" was not a usable ${expected}; ${
                        resetToAbsent ? 'treated as not set' : 'reset to its default'
                    }.`,
                }));
                // resetToAbsent: this record's "default" IS absence —
                // materializing the catalog's value would flip absent→present
                // and let a corrupt field override module-level settings, so
                // the unusable field is dropped instead of defaulted.
                if (!resetToAbsent) data[key] = defaults[key];
            }
        } else {
            // No scalar default (absent, null, object, or array): retained
            // without a structural opinion. Unknown keys belong to newer or
            // older builds of the owning module and current behavior keeps
            // them — validation must not become a settings deleter.
            data[key] = value;
        }
    }
    data[SETTINGS_VERSION_FIELD] = currentVersion;
    return { status: 'ready', data, issues, storedVersion };
}

/**
 * Read the version marker off a stored record without validating anything.
 *
 * @returns {number|null} the non-negative integer marker, or null when the
 *   record is absent/has no (valid) marker — callers treat null as "legacy 0".
 */
export function readStoredSettingsVersion(raw) {
    if (!isObject(raw)) return null;
    const marker = raw[SETTINGS_VERSION_FIELD];
    return (Number.isInteger(marker) && marker >= 0) ? marker : null;
}

/**
 * Return a copy of a settings record WITHOUT the internal version marker.
 * The marker is persistence-internal: callers of getSettings() keep the
 * documented `{ ...defaults, ...saved }` contract and never see it.
 */
export function stripSettingsVersion(record) {
    if (!isObject(record)) return record;
    const copy = { ...record };
    delete copy[SETTINGS_VERSION_FIELD];
    return copy;
}

// ─── Internals ────────────────────────────────────────────────────────────────

/** The scalar type a default declares, or null for "no structural opinion". */
function scalarType(value) {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        return typeof value;
    }
    return null;
}

/**
 * Interpret a stored value as the scalar type of its default. Returns
 * `{ value, changed }` on success, or null when the value cannot be used as
 * that type (the caller then resets the field to its default):
 *   - numbers accept finite numbers and numeric strings (form inputs
 *     round-trip strings); anything else resets;
 *   - strings accept strings and stringify numbers/booleans;
 *   - booleans accept only booleans — coercing the STRING 'false' to the
 *     VALUE false would silently flip behavior old data never had.
 */
function coerceScalar(value, type) {
    if (typeof value === type) {
        // Non-finite numbers (Infinity/NaN) are not usable settings values —
        // the same isFiniteNumber rule the store validators apply.
        if (type === 'number' && !Number.isFinite(value)) return null;
        return { value, changed: false };
    }
    if (type === 'number') {
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
            return { value: Number(value), changed: true };
        }
        return null;
    }
    if (type === 'string') {
        if (typeof value === 'number' || typeof value === 'boolean') {
            return { value: String(value), changed: true };
        }
        return null;
    }
    return null;
}
