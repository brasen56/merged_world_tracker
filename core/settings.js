/**
 * core/settings.js — Shared settings management
 *
 * Provides a factory that creates getSettings / saveSettings / hasValidSettings
 * for a given settings key and defaults.  Supports:
 *   - SillyTavern extension_settings (survives backup/restore)
 *   - localStorage fallback
 *   - One-time legacy key migration
 *   - Schema/version support (schema plan §2.2 / Part 7): every stored
 *     record is validated through core/settings_schema.js in the shared
 *     core/schema.js issue vocabulary and carries a `schemaVersion` marker
 *     in storage. The marker is persistence-internal — getSettings()
 *     returns exactly the documented `{ ...defaults, ...saved }` shape.
 *     Settings fail OPEN (defaults + findings), never pausing a module:
 *     a future-version record is read as-is and never rewritten by a read.
 */

import { getContextSafe } from './context.js';
import {
    SETTINGS_SCHEMA_VERSION,
    SETTINGS_VERSION_FIELD,
    SETTINGS_ISSUE_CODES,
    validateStoredSettings,
    stripSettingsVersion,
} from './settings_schema.js';
import { recordSchemaEvent, SCHEMA_DIAGNOSTIC_EVENTS } from './schema_status.js';
import { makeIssue, ISSUE_SEVERITIES } from './schema.js';

/**
 * Create a settings manager for a specific module.
 *
 * @param {object} opts
 * @param {string} opts.settingsKey    — localStorage + extension_settings key
 * @param {string} [opts.legacyKey]    — old key to migrate from (one-time)
 * @param {object} opts.defaults       — default settings object; scalar
 *   defaults also declare the expected type of their field for validation
 * @param {object} [opts.validationDefaults] — validation-only type catalog
 *   (scalar defaults declare expected types). Defaults to `defaults`. For
 *   managers whose PUBLIC merge base must stay empty (the global accessor's
 *   absent-field precedence contract) but whose present fields still need
 *   type validation.
 * @param {boolean} [opts.resetToAbsent] — an unusable present field is
 *   dropped (reads as "not set") instead of being reset to the catalog's
 *   default value, which would materialize the field and flip the
 *   absent-field precedence. Pair with validationDefaults.
 * @param {string} opts.logPrefix      — e.g. '[Knowledge Tracker]'
 * @param {object} [opts.schema]       — schema/version support (Part 7):
 *   `{ version?: number, validate?: (raw, { defaults, currentVersion }) }`.
 *   Defaults to the shared core/settings_schema.js validator at
 *   SETTINGS_SCHEMA_VERSION, which gives every manager validation +
 *   version coverage with no per-module work.
 * @returns {{ getSettings, saveSettings, hasValidSettings, getExtSettingsRef }}
 */
// ─── Per-store schema-event dedup (§9.3) ─────────────────────────────────────
//
// Module-level singleton (the core/scope.js _epoch pattern), keyed by the
// settings KEY so every manager reading the same STORE shares one dedup set:
// two managers own the global `merged_world_tracker` record (the Settings
// tab's saver in index.js and the canonical accessor below), and one finding
// about one store must surface once per session — not once per manager.
// Cleared on page reload; reset between tests via _resetReportedSettingsIssues().
const _reportedIssueCodesByStore = new Map();

function reportedIssueCodesFor(settingsKey) {
    let set = _reportedIssueCodesByStore.get(settingsKey);
    if (!set) {
        set = new Set();
        _reportedIssueCodesByStore.set(settingsKey, set);
    }
    return set;
}

/** Test seam: reset the per-store schema-event dedup (between test cases). */
export function _resetReportedSettingsIssues() {
    _reportedIssueCodesByStore.clear();
}

export function createSettingsManager({
    settingsKey, legacyKey, defaults,
    validationDefaults, resetToAbsent = false,
    logPrefix = '[MWT]', schema,
} = {}) {

    const schemaVersion = Number.isInteger(schema?.version)
        ? schema.version
        : SETTINGS_SCHEMA_VERSION;
    const validateStored = typeof schema?.validate === 'function'
        ? schema.validate
        : validateStoredSettings;
    // Validation type catalog, separate from the PUBLIC default-merging base:
    // the global accessor merges over {} (absent fields must STAY absent —
    // the global-wins precedence contract) yet still validates present fields
    // against the real field-level catalog. Everyone else validates against
    // their public defaults, exactly as before.
    const typeCatalog = validationDefaults ?? defaults;
    const reportedIssueCodes = reportedIssueCodesFor(settingsKey);

    /**
     * Validate a stored record and merge it over defaults (the PUBLIC shape —
     * the internal version marker is stripped). Non-destructive: the stored
     * value is never mutated here; repairs converge on the next save.
     */
    function readCanonical(stored) {
        const result = validateStored(stored, {
            defaults: typeCatalog,
            currentVersion: schemaVersion,
            resetToAbsent,
        });
        reportIssues(result.issues);
        if (result.status === 'invalid-root') return { ...defaults };
        return { ...defaults, ...stripSettingsVersion(result.data) };
    }

    // ─── Schema findings → §9.3 diagnostic events ────────────────────────────
    //
    // getSettings() is a hot path (every scan, render, and injection reads
    // it), so each issue code is reported at most ONCE per STORE per
    // session (shared across every manager on that store) — findings
    // converge on the next save anyway, and a per-read event would flood
    // the ring.

    function eventForIssueCode(code) {
        if (code === SETTINGS_ISSUE_CODES.FUTURE_VERSION) {
            return SCHEMA_DIAGNOSTIC_EVENTS.BLOCKED_FUTURE_VERSION;
        }
        if (code === SETTINGS_ISSUE_CODES.ROOT_NOT_OBJECT
            || code === SETTINGS_ISSUE_CODES.PARSE_FAILED) {
            // An unparseable record is as unreadable as a non-object root:
            // the module fell back to defaults (settings fail open).
            return SCHEMA_DIAGNOSTIC_EVENTS.SETTINGS_INVALID;
        }
        return SCHEMA_DIAGNOSTIC_EVENTS.REPAIRED;
    }

    function reportIssues(issues) {
        for (const issue of issues) {
            const key = issue?.code;
            if (!key || reportedIssueCodes.has(key)) continue;
            reportedIssueCodes.add(key);
            recordSchemaEvent(eventForIssueCode(key), {
                store: settingsKey,
                version: schemaVersion,
                code: key,
                reasonCode: String(issue.path?.[0] ?? key),
            });
        }
    }

    /**
     * Parse a stored settings JSON string (the localStorage paths). An
     * unparseable record — a truncated quota write, disk corruption — becomes
     * a structured FATAL finding reported (once per code, like validator
     * findings) as schema_settings_invalid, instead of falling into the outer
     * catch's bare console warning: §2.2's promise is that an unreadable
     * record is a first-class diagnostic. Content-safe by construction — no
     * raw record (settings can carry API keys) ever rides along.
     *
     * @param {string} text raw localStorage value
     * @returns {{ ok: boolean, value?: * }}
     */
    function parseStoredJson(text) {
        try {
            return { ok: true, value: JSON.parse(text) };
        } catch {
            reportIssues([makeIssue({
                code: SETTINGS_ISSUE_CODES.PARSE_FAILED,
                path: [],
                severity: ISSUE_SEVERITIES.FATAL,
                message: 'Stored settings record was not valid JSON; defaults are used instead.',
            })]);
            return { ok: false };
        }
    }

    function getExtSettingsRef() {
        try {
            const ctx = getContextSafe();
            if (ctx && ctx.extensionSettings) {
                if (!ctx.extensionSettings[settingsKey]) ctx.extensionSettings[settingsKey] = {};
                return ctx.extensionSettings[settingsKey];
            }
        } catch { /* ignore */ }
        return null;
    }

    function getSettings() {
        try {
            // Prefer SillyTavern extension_settings
            const extRef = getExtSettingsRef();
            if (extRef && Object.keys(extRef).length > 0) return readCanonical(extRef);

            // Fall back to localStorage
            const raw = localStorage.getItem(settingsKey);
            if (raw) {
                // Part 7: an unparseable record reports schema_settings_invalid
                // and fails open to defaults — it never reaches the validator.
                const parsed = parseStoredJson(raw);
                if (!parsed.ok) return { ...defaults };
                // One-time migration into extension_settings if now available
                // (the canonical, version-stamped record — same shape a save
                // would write, so the two paths cannot drift).
                if (extRef && Object.keys(extRef).length === 0) {
                    const result = validateStored(parsed.value, {
                        defaults: typeCatalog,
                        currentVersion: schemaVersion,
                        resetToAbsent,
                    });
                    reportIssues(result.issues);
                    if (result.status !== 'invalid-root') Object.assign(extRef, result.data);
                }
                return readCanonical(parsed.value);
            }

            // Check legacy key
            if (legacyKey) {
                const legacy = localStorage.getItem(legacyKey);
                if (legacy) {
                    const parsed = parseStoredJson(legacy);
                    if (!parsed.ok) return { ...defaults };
                    const result = validateStored(parsed.value, {
                        defaults: typeCatalog,
                        currentVersion: schemaVersion,
                        resetToAbsent,
                    });
                    reportIssues(result.issues);
                    const merged = result.status === 'invalid-root'
                        ? { ...defaults }
                        : { ...defaults, ...stripSettingsVersion(result.data) };
                    // §12 no-silent-downgrade: a future-version record is read
                    // as-is and a read never rewrites it — skip the one-time
                    // migration entirely (a deliberate save on THIS build is
                    // the ordinary, field-preserving downgrade path).
                    if (result.status !== 'future-version') {
                        const stamped = { ...merged, [SETTINGS_VERSION_FIELD]: schemaVersion };
                        if (extRef) Object.assign(extRef, stamped);
                        else localStorage.setItem(settingsKey, JSON.stringify(stamped));
                        console.log(`${logPrefix} Migrated settings from legacy key "${legacyKey}"`);
                    }
                    return merged;
                }
            }

            return { ...defaults };
        } catch (err) {
            console.warn(`${logPrefix} Failed to read settings:`, err);
            return { ...defaults };
        }
    }

    function saveSettings(patch) {
        try {
            // Validate the complete next record, then stamp the version into
            // the PERSISTED copy only — returned settings stay marker-free.
            // stripSettingsVersion() first: a caller spreading a stale
            // record must not smuggle a foreign version marker back in.
            const next = stripSettingsVersion({ ...getSettings(), ...patch });
            const result = validateStored(next, {
                defaults: typeCatalog,
                currentVersion: schemaVersion,
                resetToAbsent,
            });
            reportIssues(result.issues);
            const stamped = result.status === 'invalid-root'
                ? { ...next, [SETTINGS_VERSION_FIELD]: schemaVersion }
                : result.data;
            const extRef = getExtSettingsRef();
            if (extRef) {
                for (const key of Object.keys(extRef)) delete extRef[key];
                Object.assign(extRef, stamped);
                getContextSafe()?.saveSettingsDebounced?.();
            } else {
                // Only write to localStorage as a fallback when extension_settings
                // is unavailable — avoids persisting API keys in plaintext beyond
                // the extension's own storage scope (they survive uninstall otherwise).
                localStorage.setItem(settingsKey, JSON.stringify(stamped));
            }
            console.log(`${logPrefix} Settings saved`);
            return true;
        } catch (err) {
            console.warn(`${logPrefix} Failed to save settings:`, err);
            return false;
        }
    }

    function hasValidSettings() {
        const s = getSettings();
        // Connection profile bypasses custom API settings entirely.
        if (s.connectionProfileId) return true;
        // Only apiUrl + modelName are required; apiKey is optional for
        // keyless local backends (Ollama, LM Studio, llama.cpp, etc.)
        if (s.apiUrl && s.modelName) return true;
        // Fall back to the shared global settings (the main Settings tab is
        // documented as "defaults for all modules") — resolveApiCall applies
        // the same fallback when the module's own config is incomplete.
        const g = getGlobalSettings();
        if (g.connectionProfileId) return true;
        return !!(g.apiUrl && g.modelName);
    }

    return { getSettings, saveSettings, hasValidSettings, getExtSettingsRef };
}

/**
 * The extension_settings / localStorage key of the global (merged_world_tracker)
 * settings record. Duplicated as a private constant in core/context.js (which
 * cannot import this module without a context ↔ settings cycle) — keep the two
 * in sync.
 */
const GLOBAL_SETTINGS_KEY = 'merged_world_tracker';

/**
 * The REAL field-level defaults of the global settings record — the single
 * source of truth shared by the two managers that own the store:
 *   - index.js's Settings-tab manager merges them as PUBLIC defaults (the
 *     tab has always materialized every field), and
 *   - the canonical accessor below validates against them as its TYPE
 *     CATALOG while keeping its public merge base EMPTY.
 * Scalar defaults declare each field's expected type (core/settings_schema.js),
 * so a malformed present field — e.g. a hand-edited `injectionMasterOff:
 * "false"`, a truthy string that used to pass straight through and stop
 * every module with no finding — is now coerced when lossless or treated as
 * not set (see resetToAbsent below).
 */
export const GLOBAL_SETTINGS_DEFAULTS = Object.freeze({
    // Shared API defaults
    apiUrl: '',
    apiKey: '',
    modelName: '',
    maxTokens: 2000,
    temperature: 0.3,
    topP: 1.0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    customHeaders: '',
    connectionProfileId: '',
    // Newest messages to defer from ordinary tracker history scans
    recentHistoryExclude: 2,
    // Per-module injection settings
    worldStateDepth: 4,
    worldStateRole: 'system',
    chronicleDepth: 4,
    chronicleRole: 'system',
    // Structural boundaries: wrap injected blocks in XML tags for clarity
    structuralBoundaries: true,
    // Floating button visibility
    showFloatWorld: true,
    showFloatChronicle: true,
    showFloatKnowledge: true,
    showFloatStoryPlanner: true,
    showFloatInteriority: true,
    showFloatSettings: true,
    collapseFloatButtons: false,
    buttonStyle: 'modern', // 'modern' | 'classic'
    // Per-tracker enable (default on)
    enableWorldState: true,
    enableChronicle: true,
    enableKnowledge: true,
    enableStoryPlanner: true,
    enableInteriority: true,
    // Interiority injection depth/role (same neighborhood as world state)
    interiorityDepth: 1,
    interiorityRole: 'system',
    // Global "stop injecting / scanning everything" panic switch
    injectionMasterOff: false,
});

/**
 * The shared canonical accessor for the global settings (schema plan §2.2).
 *
 * getGlobalSettings() used to hand consumers the RAW persisted object: no
 * root/version validation, and the persistence-internal `schemaVersion`
 * marker leaked through the accessor. It now routes through a settings
 * manager, so injection placement, panic gating (core/api.js), API fallback
 * (resolveApiCall), and diagnostics all read the canonical, validated record.
 *
 * The PUBLIC merge base is deliberately EMPTY. Consumers distinguish "the
 * user set a global value" (field present) from "not set" (field absent) —
 * every resolveInjectionPlacement() lets a present global depth override the
 * module/per-chat one, and merging type-defaults here would materialize every
 * field and silently flip that precedence. Validation is therefore separated
 * from default-merging: present fields are validated against
 * GLOBAL_SETTINGS_DEFAULTS as a type catalog (numeric strings coerce, an
 * unusable value is treated as NOT SET via resetToAbsent — dropping it keeps
 * the field absent instead of materializing a default), and index.js's
 * Settings-tab manager merges the same catalog as its public defaults, so
 * the saver and the reader can never disagree about a field's type. The
 * per-store event dedup keeps the two managers from double-reporting the
 * same finding for this store.
 */
const globalSettingsManager = createSettingsManager({
    settingsKey: GLOBAL_SETTINGS_KEY,
    defaults: {},
    validationDefaults: GLOBAL_SETTINGS_DEFAULTS,
    resetToAbsent: true,
    logPrefix: '[MWT]',
});

/**
 * Access the global (merged_world_tracker) settings — the canonical,
 * validated record (the internal schemaVersion marker never leaks). Useful
 * for modules that need to read global injection depth/role without relying
 * on window.__mwt_shared.
 *
 * @returns {object} a fresh top-level copy — never the live persisted record
 *   itself, but the copy is SHALLOW: nested objects (e.g. `bookBindings`,
 *   `activation`) are shared references into the persisted record, so copy a
 *   nested object before writing to it.
 */
export function getGlobalSettings() {
    try {
        return globalSettingsManager.getSettings();
    } catch {
        return {};
    }
}

/**
 * Is this module allowed to inject / scan right now?
 *
 * Single source of truth for the two-layer enable model:
 *   - injectionMasterOff === true  → nothing injects (panic switch)
 *   - enable<ModuleKey> === false  → that module is disabled
 *
 * @param {string} moduleKey — 'WorldState' | 'Chronicle' | 'Knowledge'
 * @returns {boolean}
 */
export function injectionAllowed(moduleKey) {
    const g = getGlobalSettings();
    if (g.injectionMasterOff) return false;               // "stop everything"
    if (g[`enable${moduleKey}`] === false) return false;  // per-tracker disable
    return true;
}

export function syncSharedConnectionSettings(getSettings, saveSettings, patch, logPrefix = '[MWT]') {
    if (!patch || (
        patch.apiUrl === undefined &&
        patch.apiKey === undefined &&
        patch.modelName === undefined &&
        patch.connectionProfileId === undefined
    )) return false;

    const current = getSettings();
    saveSettings({
        ...current,
        connectionProfileId: patch.connectionProfileId ?? current.connectionProfileId,
        apiUrl: patch.apiUrl ?? current.apiUrl,
        apiKey: patch.apiKey ?? current.apiKey,
        modelName: patch.modelName ?? current.modelName,
    });
    console.log(`${logPrefix} Synced global API settings`);
    return true;
}