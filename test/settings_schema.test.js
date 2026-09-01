/**
 * test/settings_schema.test.js — Part 7 of the schema validation plan
 * (SCHEMA_VALIDATION_MIGRATIONS_PLAN.md §2.2 / §11):
 *
 *   1. core/settings_schema.js — the pure settings validator: version
 *      stamping, future-version refusal, type repairs against `defaults`,
 *      unknown-key retention, and the never-throw contract.
 *   2. createSettingsManager() integration — the REAL module (not the test
 *      stub): saved records carry the internal `schemaVersion` marker,
 *      getSettings() never leaks it (the `{ ...defaults, ...saved }`
 *      contract is pinned by test/tier5_regression_net.test.js), reads
 *      repair forward without touching storage, and findings surface as
 *      §9.3 diagnostic events exactly once per session per code.
 *
 * Settings fail OPEN by design (defaults + findings, nothing paused), so
 * these tests pin the fail-open behaviors a store would fail CLOSED on.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
    SETTINGS_SCHEMA_VERSION,
    SETTINGS_VERSION_FIELD,
    SETTINGS_ISSUE_CODES,
    validateStoredSettings,
    readStoredSettingsVersion,
    stripSettingsVersion,
} from '../core/settings_schema.js';
import { createSettingsManager, getGlobalSettings, injectionAllowed, _resetReportedSettingsIssues } from '../core/settings.js';
import { SCHEMA_DIAGNOSTIC_EVENTS } from '../core/schema_status.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';

const DEFAULTS = { enabled: true, depth: 4, label: 'default' };

/** Fake localStorage (the tier5_regression_net pattern). */
function freshStorage() {
    const data = {};
    globalThis.localStorage = {
        _data: data,
        getItem(key) { return key in data ? data[key] : null; },
        setItem(key, value) { data[key] = String(value); },
        removeItem(key) { delete data[key]; },
    };
    return globalThis.localStorage;
}

const issueCodes = (issues) => issues.map((issue) => issue.code);

// ─── Pure validator ───────────────────────────────────────────────────────────

describe('validateStoredSettings (pure)', () => {
    test('a valid record passes through unchanged and gets stamped', () => {
        const result = validateStoredSettings(
            { enabled: false, depth: 7, label: 'x' },
            { defaults: DEFAULTS },
        );
        expect(result.status).toBe('ready');
        expect(result.storedVersion).toBe(0);
        expect(result.issues).toEqual([]);
        expect(result.data).toEqual({
            enabled: false,
            depth: 7,
            label: 'x',
            [SETTINGS_VERSION_FIELD]: SETTINGS_SCHEMA_VERSION,
        });
    });

    test('a current-version marker is accepted as-is', () => {
        const result = validateStoredSettings(
            { depth: 9, [SETTINGS_VERSION_FIELD]: 1 },
            { defaults: DEFAULTS },
        );
        expect(result.status).toBe('ready');
        expect(result.storedVersion).toBe(1);
        expect(result.data[SETTINGS_VERSION_FIELD]).toBe(1);
    });

    test('a numeric string coerces to its number default with a repair', () => {
        const result = validateStoredSettings({ depth: '7' }, { defaults: DEFAULTS });
        expect(result.data.depth).toBe(7);
        expect(issueCodes(result.issues)).toEqual([SETTINGS_ISSUE_CODES.FIELD_COERCED]);
        expect(result.issues[0].severity).toBe('repair');
    });

    test('an unusable value resets to the default with a repair', () => {
        for (const bad of ['abc', '', null, {}, Infinity]) {
            const result = validateStoredSettings({ depth: bad }, { defaults: DEFAULTS });
            expect(result.data.depth).toBe(4);
            expect(issueCodes(result.issues)).toEqual([SETTINGS_ISSUE_CODES.FIELD_RESET]);
        }
    });

    test('booleans are never coerced from strings — they reset to default', () => {
        // 'false' as a STRING is truthy; silently reading it as the VALUE
        // false would flip behavior the old data never had.
        const result = validateStoredSettings({ enabled: 'false' }, { defaults: DEFAULTS });
        expect(result.data.enabled).toBe(true);
        expect(issueCodes(result.issues)).toEqual([SETTINGS_ISSUE_CODES.FIELD_RESET]);
    });

    test('a string default stringify-coerces numbers and booleans', () => {
        const result = validateStoredSettings({ label: 5 }, { defaults: DEFAULTS });
        expect(result.data.label).toBe('5');
        expect(issueCodes(result.issues)).toEqual([SETTINGS_ISSUE_CODES.FIELD_COERCED]);
    });

    test('unknown keys are retained without findings', () => {
        const result = validateStoredSettings(
            { depth: 2, removedInV1: 'keep me' },
            { defaults: DEFAULTS },
        );
        expect(result.data.removedInV1).toBe('keep me');
        expect(result.issues).toEqual([]);
    });

    test('non-scalar defaults give no structural opinion (value retained)', () => {
        const defaults = { ...DEFAULTS, nested: { a: 1 } };
        const result = validateStoredSettings({ nested: 'whatever' }, { defaults });
        expect(result.data.nested).toBe('whatever');
        expect(result.issues).toEqual([]);
    });

    test('resetToAbsent drops unusable fields instead of materializing defaults', () => {
        // For records whose consumers distinguish present from absent (the
        // global accessor's precedence contract): 'false' as a STRING is not
        // a usable boolean, and resetting it to the catalog's `true` would
        // both flip behavior and materialize the field — so it is dropped.
        const result = validateStoredSettings(
            { enabled: 'false', depth: '7', label: 'x' },
            { defaults: DEFAULTS, resetToAbsent: true },
        );
        expect('enabled' in result.data).toBe(false);
        expect(result.data.enabled).toBeUndefined();
        // Lossless coercion and untouched valid fields are unaffected.
        expect(result.data.depth).toBe(7);
        expect(result.data.label).toBe('x');
        expect(issueCodes(result.issues)).toEqual([
            SETTINGS_ISSUE_CODES.FIELD_RESET,
            SETTINGS_ISSUE_CODES.FIELD_COERCED,
        ]);
        expect(result.issues[0].message).toMatch(/treated as not set/);
    });

    test('a malformed version marker is dropped and treated as legacy 0', () => {
        for (const bad of ['x', 1.5, -1]) {
            const result = validateStoredSettings(
                { depth: 3, [SETTINGS_VERSION_FIELD]: bad },
                { defaults: DEFAULTS },
            );
            expect(result.status).toBe('ready');
            expect(result.storedVersion).toBe(0);
            expect(result.data[SETTINGS_VERSION_FIELD]).toBe(SETTINGS_SCHEMA_VERSION);
            expect(issueCodes(result.issues)).toEqual([SETTINGS_ISSUE_CODES.VERSION_MARKER_INVALID]);
        }
    });

    test('a future version is refused: data returned untouched, no repairs, no stamp', () => {
        const raw = { depth: '7', [SETTINGS_VERSION_FIELD]: 99 };
        const result = validateStoredSettings(raw, { defaults: DEFAULTS });
        expect(result.status).toBe('future-version');
        expect(result.storedVersion).toBe(99);
        expect(result.data).toBe(raw); // the SAME record — never a copy that lost fields
        expect(issueCodes(result.issues)).toEqual([SETTINGS_ISSUE_CODES.FUTURE_VERSION]);
        expect(result.issues[0].severity).toBe('fatal');
    });

    test('non-object roots fail soft with a fatal finding and no data', () => {
        for (const bad of ['oops', 5, null, true, [1, 2]]) {
            const result = validateStoredSettings(bad, { defaults: DEFAULTS });
            expect(result.status).toBe('invalid-root');
            expect(result.data).toBeNull();
            expect(result.storedVersion).toBeNull();
            expect(issueCodes(result.issues)).toEqual([SETTINGS_ISSUE_CODES.ROOT_NOT_OBJECT]);
            expect(result.issues[0].severity).toBe('fatal');
        }
    });

    test('issues never embed the raw record (settings can carry API keys)', () => {
        const result = validateStoredSettings({ apiKey: 'sk-secret' }, { defaults: { apiKey: '' } });
        expect(result.data.apiKey).toBe('sk-secret'); // retained in DATA
        expect(result.issues).toEqual([]); // and never reported through an issue
    });
});

describe('readStoredSettingsVersion / stripSettingsVersion', () => {
    test('reads the marker without validating the rest', () => {
        expect(readStoredSettingsVersion(null)).toBeNull();
        expect(readStoredSettingsVersion('x')).toBeNull();
        expect(readStoredSettingsVersion({})).toBeNull();
        expect(readStoredSettingsVersion({ [SETTINGS_VERSION_FIELD]: 3 })).toBe(3);
        expect(readStoredSettingsVersion({ [SETTINGS_VERSION_FIELD]: 'x' })).toBeNull();
    });

    test('strips the marker from a copy, never mutating the input', () => {
        const record = { depth: 1, [SETTINGS_VERSION_FIELD]: 1 };
        const stripped = stripSettingsVersion(record);
        expect(stripped).toEqual({ depth: 1 });
        expect(record[SETTINGS_VERSION_FIELD]).toBe(1);
        expect(stripSettingsVersion('not-an-object')).toBe('not-an-object');
    });
});

// ─── createSettingsManager integration (the REAL module) ─────────────────────

describe('createSettingsManager schema/version support (Part 7)', () => {
    let storage;

    beforeEach(() => {
        storage = freshStorage();
        _resetDiagnostics();
        _resetReportedSettingsIssues();
    });

    function makeManager(overrides = {}) {
        return createSettingsManager({
            settingsKey: 'p7-test-settings',
            defaults: DEFAULTS,
            logPrefix: '[P7]',
            ...overrides,
        });
    }

    const eventsOf = (name) => getEvents().filter((event) => event.event === name);

    test('saving stamps the version into storage but never into getSettings()', () => {
        const manager = makeManager();
        expect(manager.getSettings()).toEqual({ ...DEFAULTS });
        expect(manager.saveSettings({ depth: 7 })).toBe(true);
        // The PERSISTED copy carries the internal marker…
        expect(JSON.parse(storage._data['p7-test-settings'])).toEqual({
            enabled: true,
            depth: 7,
            label: 'default',
            [SETTINGS_VERSION_FIELD]: SETTINGS_SCHEMA_VERSION,
        });
        // …but the public contract stays marker-free.
        expect(manager.getSettings()).toEqual({ enabled: true, depth: 7, label: 'default' });
    });

    test('reads repair a numeric-string field without touching storage', () => {
        storage._data['p7-test-settings'] = JSON.stringify({ depth: '7', label: 'x' });
        const manager = makeManager();
        expect(manager.getSettings()).toEqual({ enabled: true, depth: 7, label: 'x' });
        // The stored raw value is the recovery copy — unchanged by the read.
        expect(storage._data['p7-test-settings']).toBe(JSON.stringify({ depth: '7', label: 'x' }));
    });

    test('reads reset an unusable field to its default', () => {
        storage._data['p7-test-settings'] = JSON.stringify({ depth: 'not-a-number' });
        expect(makeManager().getSettings()).toEqual({ ...DEFAULTS });
    });

    test('a non-object stored root falls back to defaults and the value survives', () => {
        storage._data['p7-test-settings'] = JSON.stringify('garbage');
        expect(makeManager().getSettings()).toEqual({ ...DEFAULTS });
        expect(storage._data['p7-test-settings']).toBe(JSON.stringify('garbage'));
    });

    test('a future-version record is read as-is (fail-open) and reports the block', () => {
        const future = {
            enabled: false, depth: '9', onlyInV99: true, [SETTINGS_VERSION_FIELD]: 99,
        };
        storage._data['p7-test-settings'] = JSON.stringify(future);
        const manager = makeManager();
        expect(manager.getSettings()).toEqual({
            enabled: false, depth: '9', label: 'default', onlyInV99: true,
        });
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.BLOCKED_FUTURE_VERSION)).toHaveLength(1);
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.BLOCKED_FUTURE_VERSION)[0].detail).toMatchObject({
            store: 'p7-test-settings',
            version: SETTINGS_SCHEMA_VERSION,
        });
        // A read never rewrites it either.
        expect(JSON.parse(storage._data['p7-test-settings'])).toEqual(future);
        // A deliberate save on THIS build is the ordinary downgrade path:
        // fields are retained, the marker becomes current again.
        manager.saveSettings({ depth: 5 });
        expect(JSON.parse(storage._data['p7-test-settings'])).toEqual({
            enabled: false, depth: 5, label: 'default', onlyInV99: true,
            [SETTINGS_VERSION_FIELD]: SETTINGS_SCHEMA_VERSION,
        });
    });

    test('the legacy one-time migration writes a validated, stamped record', () => {
        storage._data['p7-legacy-settings'] = JSON.stringify({ enabled: false, depth: '6' });
        const manager = makeManager({ legacyKey: 'p7-legacy-settings' });
        expect(manager.getSettings()).toEqual({ enabled: false, depth: 6, label: 'default' });
        expect(JSON.parse(storage._data['p7-test-settings'])).toEqual({
            enabled: false, depth: 6, label: 'default',
            [SETTINGS_VERSION_FIELD]: SETTINGS_SCHEMA_VERSION,
        });
        // The legacy key itself is left in place (one-time copy, not a move).
        expect(storage._data['p7-legacy-settings']).toBeDefined();
    });

    test('findings surface once per code per session, not per hot read', () => {
        storage._data['p7-test-settings'] = JSON.stringify({ depth: 'not-a-number' });
        const manager = makeManager();
        manager.getSettings();
        manager.getSettings();
        manager.getSettings();
        const repairs = eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.REPAIRED);
        expect(repairs).toHaveLength(1);
        expect(repairs[0].detail).toMatchObject({ store: 'p7-test-settings' });
    });

    test('an unreadable record reports schema_settings_invalid once', () => {
        storage._data['p7-test-settings'] = JSON.stringify(42);
        const manager = makeManager();
        manager.getSettings();
        manager.getSettings();
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.SETTINGS_INVALID)).toHaveLength(1);
    });

    test('an unparseable (truncated JSON) record reports schema_settings_invalid and fails open', () => {
        const truncated = '{"apiUrl":"http://example.test/v1';
        storage._data['p7-test-settings'] = truncated;
        const manager = makeManager();
        expect(manager.getSettings()).toEqual({ ...DEFAULTS });
        expect(manager.getSettings()).toEqual({ ...DEFAULTS }); // deduped, not re-reported
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.SETTINGS_INVALID)).toHaveLength(1);
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.SETTINGS_INVALID)[0].detail).toMatchObject({
            store: 'p7-test-settings',
            code: SETTINGS_ISSUE_CODES.PARSE_FAILED,
        });
        // The stored raw value is the recovery copy — unchanged by the reads.
        expect(storage._data['p7-test-settings']).toBe(truncated);
    });

    test('a future-version LEGACY record is read as-is but never migrated (no silent downgrade)', () => {
        const future = { enabled: false, depth: 9, label: 'from-v99', [SETTINGS_VERSION_FIELD]: 99 };
        storage._data['p7-legacy-settings'] = JSON.stringify(future);
        const manager = makeManager({ legacyKey: 'p7-legacy-settings' });
        expect(manager.getSettings()).toEqual({ enabled: false, depth: 9, label: 'from-v99' });
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.BLOCKED_FUTURE_VERSION)).toHaveLength(1);
        // The read stamped nothing: neither the main key nor the legacy key changed.
        expect(storage._data['p7-test-settings']).toBeUndefined();
        expect(JSON.parse(storage._data['p7-legacy-settings'])).toEqual(future);
    });

    test('an unparseable LEGACY record falls back to defaults without migrating garbage', () => {
        storage._data['p7-legacy-settings'] = 'not-json{';
        const manager = makeManager({ legacyKey: 'p7-legacy-settings' });
        expect(manager.getSettings()).toEqual({ ...DEFAULTS });
        // Nothing was stamped from the unparseable record.
        expect(storage._data['p7-test-settings']).toBeUndefined();
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.SETTINGS_INVALID)).toHaveLength(1);
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.SETTINGS_INVALID)[0].detail).toMatchObject({
            code: SETTINGS_ISSUE_CODES.PARSE_FAILED,
        });
    });

    test('a schema.version override changes the stamped version', () => {
        const manager = makeManager({ schema: { version: 7 } });
        manager.saveSettings({ depth: 3 });
        expect(JSON.parse(storage._data['p7-test-settings'])[SETTINGS_VERSION_FIELD]).toBe(7);
        // A record at 7 is current for this manager — no future-version block.
        expect(manager.getSettings().depth).toBe(3);
    });

    test('a stale marker in a save patch cannot smuggle a foreign version in', () => {
        const manager = makeManager();
        manager.saveSettings({ depth: 2, [SETTINGS_VERSION_FIELD]: 42 });
        expect(JSON.parse(storage._data['p7-test-settings'])[SETTINGS_VERSION_FIELD])
            .toBe(SETTINGS_SCHEMA_VERSION);
        expect(manager.getSettings()).toEqual({ enabled: true, depth: 2, label: 'default' });
    });

    test('validationDefaults validate present fields while the public merge base stays empty', () => {
        // The global accessor's shape: an empty PUBLIC merge base (absent
        // fields must stay absent) backed by a real validation type catalog.
        storage._data['p7-test-settings'] = JSON.stringify({ enabled: 'false', depth: '6' });
        const manager = makeManager({ defaults: {}, validationDefaults: DEFAULTS, resetToAbsent: true });
        const s = manager.getSettings();
        // Present-but-malformed → absent, NOT the catalog default (true)…
        expect('enabled' in s).toBe(false);
        // …and lossless coercion still applies to present numeric strings.
        expect(s.depth).toBe(6);
        expect(s.label).toBeUndefined();
        const repaired = eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.REPAIRED);
        expect(repaired).toHaveLength(2);
        expect(repaired.map((e) => e.detail.code)).toEqual(expect.arrayContaining([
            SETTINGS_ISSUE_CODES.FIELD_RESET,
            SETTINGS_ISSUE_CODES.FIELD_COERCED,
        ]));
    });

    test('two managers on one store share the dedup: a code surfaces once total', () => {
        // index.js's Settings-tab saver and the canonical accessor both read
        // `merged_world_tracker` — one finding about one store must surface
        // once per session, not once per manager.
        storage._data['p7-shared-store'] = JSON.stringify({ depth: 'not-a-number' });
        const first = createSettingsManager({
            settingsKey: 'p7-shared-store', defaults: DEFAULTS, logPrefix: '[P7a]',
        });
        const second = createSettingsManager({
            settingsKey: 'p7-shared-store', defaults: DEFAULTS, logPrefix: '[P7b]',
        });
        first.getSettings();
        second.getSettings();
        const events = getEvents().filter((e) => e.detail?.code === SETTINGS_ISSUE_CODES.FIELD_RESET);
        expect(events).toHaveLength(1);
        expect(events[0].detail.store).toBe('p7-shared-store');
    });
});

// ─── getGlobalSettings — the shared canonical accessor (Part 7) ───────────────

describe('getGlobalSettings (canonical global-settings accessor)', () => {
    const GLOBAL_KEY = 'merged_world_tracker';
    let storage;

    beforeEach(() => {
        storage = freshStorage();
        _resetDiagnostics();
        _resetReportedSettingsIssues();
    });

    const eventsOf = (name) => getEvents().filter((event) => event.event === name);

    test('returns the validated record and never leaks the schemaVersion marker', () => {
        storage._data[GLOBAL_KEY] = JSON.stringify({
            chronicleDepth: 6,
            injectionMasterOff: true,
            [SETTINGS_VERSION_FIELD]: SETTINGS_SCHEMA_VERSION,
        });
        const g = getGlobalSettings();
        expect(g.chronicleDepth).toBe(6);
        expect(g.injectionMasterOff).toBe(true);
        // The persistence-internal marker is stripped by the canonical read.
        expect(g[SETTINGS_VERSION_FIELD]).toBeUndefined();
    });

    test('an absent record reads as {} — absent fields stay absent (precedence contract)', () => {
        // Consumers distinguish "user set a global value" from "not set"
        // (resolveInjectionPlacement's global-wins check), so the accessor
        // must NOT materialize type-defaults for unset fields.
        expect(getGlobalSettings()).toEqual({});
        expect('chronicleDepth' in getGlobalSettings()).toBe(false);
    });

    test('a non-object record falls back to {} and reports schema_settings_invalid', () => {
        storage._data[GLOBAL_KEY] = JSON.stringify(42);
        expect(getGlobalSettings()).toEqual({});
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.SETTINGS_INVALID)).toHaveLength(1);
    });

    test('a future-version record is read as-is and reports the block', () => {
        storage._data[GLOBAL_KEY] = JSON.stringify({ onlyInV99: true, [SETTINGS_VERSION_FIELD]: 99 });
        const g = getGlobalSettings();
        expect(g.onlyInV99).toBe(true);
        expect(g[SETTINGS_VERSION_FIELD]).toBeUndefined();
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.BLOCKED_FUTURE_VERSION)).toHaveLength(1);
    });

    test('an unparseable record fails open to {} with the parse finding', () => {
        storage._data[GLOBAL_KEY] = '{"truncated';
        expect(getGlobalSettings()).toEqual({});
        const invalid = eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.SETTINGS_INVALID);
        expect(invalid).toHaveLength(1);
        expect(invalid[0].detail).toMatchObject({ store: GLOBAL_KEY, code: SETTINGS_ISSUE_CODES.PARSE_FAILED });
    });

    test('a malformed present global field is dropped — injectionMasterOff: "false" no longer stops every module', () => {
        // The accessor's empty merge base used to leave validateStoredSettings
        // with NO type catalog, so the truthy STRING passed through unchanged:
        // injectionAllowed() shut down every module with no finding at all.
        storage._data[GLOBAL_KEY] = JSON.stringify({ injectionMasterOff: 'false', chronicleDepth: '6' });
        const g = getGlobalSettings();
        expect('injectionMasterOff' in g).toBe(false);
        // Lossless coercion still applies to present numeric strings.
        expect(g.chronicleDepth).toBe(6);
        expect(injectionAllowed('WorldState')).toBe(true);
        const repaired = eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.REPAIRED);
        expect(repaired).toHaveLength(2);
        expect(repaired.map((e) => e.detail.code)).toEqual(expect.arrayContaining([
            SETTINGS_ISSUE_CODES.FIELD_RESET,
            SETTINGS_ISSUE_CODES.FIELD_COERCED,
        ]));
        expect(repaired.find((e) => e.detail.code === SETTINGS_ISSUE_CODES.FIELD_RESET).detail)
            .toMatchObject({ store: GLOBAL_KEY, reasonCode: 'injectionMasterOff' });
    });

    test('a valid panic switch still blocks; absent fields stay absent (precedence contract)', () => {
        storage._data[GLOBAL_KEY] = JSON.stringify({ injectionMasterOff: true });
        expect(getGlobalSettings().injectionMasterOff).toBe(true);
        expect(injectionAllowed('Chronicle')).toBe(false);
        expect(injectionAllowed('WorldState')).toBe(false);
        // The type catalog must not materialize unset fields on the way in.
        expect('chronicleDepth' in getGlobalSettings()).toBe(false);
    });
});
