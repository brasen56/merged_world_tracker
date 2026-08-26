/**
 * interiority/schema.js — Interiority store descriptor and record validators.
 *
 * The module-owned schema for `chat_metadata.mwt_interiority` (design
 * §3.2/§6.6). Part 1 ported the exact rules this store already had in
 * backup/validate.js onto structured issues; Part 2 adds the 0 -> 1
 * migration's PURE portion (canonical defaults) and the per-store issue
 * policy. The chat-DEPENDENT part of the legacy key migration (rewriting
 * numeric/`sd-*` perMessage keys to `mu-*` — it needs message UUIDs from the
 * live chat and a hydration guard) stays in interiority/data.js
 * migrateIndexKeys() until the hydration-path cutover (Parts 4/6); the deeper
 * Interiority checks (field size limits, tombstone-to-ledger conflicts,
 * nested snapshot shapes, message resolution — design §6.6) arrive with the
 * deep-validation pass.
 *
 * Pure by contract: imports only the shared engine; no DOM, no SillyTavern
 * runtime, no feature barrel, nothing from interiority/data.js.
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and the
 * module's own META_KEY); test/schema_parity.test.js pins them together.
 */
import {
    checkRecordList,
    deferIssue,
    defineIssuePolicy,
    defineStoreSchema,
    emptyStats,
    fatalIssue,
    isFiniteNumber,
    isNonEmptyString,
    isObject,
    mergeStats,
    quarantineIssue,
} from '../core/schema.js';

/** Canonical per-message key format: `mu-<message uuid>`. */
export const PER_MESSAGE_KEY_PATTERN = /^mu-[^\s]+$/;

/**
 * Legacy per-message key formats still pending conversion on the hydration
 * path: numeric chat-index keys ("0", "1", …) and send_date keys
 * ("sd-<send_date>"). migrateIndexKeys() in interiority/data.js rewrites both
 * to `mu-*` once the live chat is hydrated; see the deferral note in
 * validateInteriorityData().
 */
export const LEGACY_PER_MESSAGE_KEY_PATTERN = /^(sd-.+|\d+)$/;

export function checkLedgerEntry(record) {
    if (!isObject(record)) return { code: 'ledger-not-object', message: 'Ledger entry must be an object.' };
    for (const key of ['id', 'npc', 'action', 'trigger']) {
        if (!isNonEmptyString(record[key])) {
            return { code: `ledger-invalid-${key}`, message: `Ledger ${key} must be a non-empty string.` };
        }
    }
    return null;
}

export function checkTombstone(record) {
    if (!isObject(record)) return { code: 'tombstone-not-object', message: 'Deletion tombstone must be an object.' };
    if (!isNonEmptyString(record.id) || !isNonEmptyString(record.npc)) {
        return { code: 'tombstone-missing-fields', message: 'Tombstone id and npc are required.' };
    }
    if (!Array.isArray(record.actions) || record.actions.some(action => !isNonEmptyString(action))) {
        return { code: 'tombstone-actions', message: 'Tombstone actions must be string ids.' };
    }
    if (!Array.isArray(record.triggers) || record.triggers.some(trigger => !isNonEmptyString(trigger))) {
        return { code: 'tombstone-triggers', message: 'Tombstone triggers must be string ids.' };
    }
    return null;
}

/**
 * Validate ledger entries, deletion tombstones, the per-message map, and the
 * turn counter. Unknown keys pass through unchanged, exactly as before.
 *
 * Legacy perMessage keys (numeric / `sd-*`) are RETAINED, not quarantined:
 * their conversion needs the live chat (message UUIDs + the sparse-chat
 * hydration guard) and cannot run in this pure path. Removing them here would
 * empty the map before migrateIndexKeys() could rewrite it, silently losing
 * every reaction and snapshot those entries carry. Instead, preparation is
 * explicitly DEFERRED: the retained entries come with a DEFER-severity
 * `per-message-legacy-pending` issue (its own severity and policy category —
 * deliberately not FATAL), so prepareStore() returns status 'deferred' —
 * original untouched, no version stamped, nothing quarantined — until the
 * chat-dependent conversion has completed (or dropped its orphans) on the
 * hydration path. A deferred store is presented as PREPARING, never as
 * quarantined or corrupt, and its retained entries are not backup-skipped
 * records (an import accepts them); the message is user-facing and must not
 * name internal functions.
 */
export function validateInteriorityData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        // Fatal-root policy (design §3.5, category 4): block the store with the
        // raw value preserved instead of loading an empty one.
        issues.push(fatalIssue('root-not-object', [], 'Interiority data must be an object.', data, 'interiority'));
        return { data: {}, issues, stats };
    }
    const accepted = { ...data };
    for (const [key, check] of [['ledger', checkLedgerEntry], ['deletedIntentions', checkTombstone]]) {
        if (data[key] === undefined) continue;
        const checked = checkRecordList(data[key], key, check, { path: [key] });
        accepted[key] = checked.records;
        mergeStats(stats, checked.stats);
        issues.push(...checked.issues);
    }
    if (data.perMessage !== undefined) {
        if (!isObject(data.perMessage)) {
            delete accepted.perMessage;
            issues.push(quarantineIssue('per-message-not-object', ['perMessage'], 'Interiority perMessage must be an object map.', data.perMessage, 'perMessage'));
        } else {
            accepted.perMessage = {};
            let legacyPending = 0;
            for (const [key, value] of Object.entries(data.perMessage)) {
                if (!isObject(value)) {
                    issues.push(quarantineIssue('per-message-entry', ['perMessage', key], 'perMessage keys must be mu-* and values must be objects.', value, key));
                } else if (LEGACY_PER_MESSAGE_KEY_PATTERN.test(key)) {
                    // Retained pending the chat-dependent conversion (see the
                    // docstring); counted with the accepted records it travels with.
                    accepted.perMessage[key] = value;
                    stats.added++;
                    legacyPending++;
                } else if (!PER_MESSAGE_KEY_PATTERN.test(key)) {
                    issues.push(quarantineIssue('per-message-entry', ['perMessage', key], 'perMessage keys must be mu-* and values must be objects.', value, key));
                } else {
                    accepted.perMessage[key] = value;
                    stats.added++;
                }
            }
            if (legacyPending > 0) {
                // Explicit preparation deferral (DEFER severity, design §7.5):
                // the store stays at its current version with the original
                // data untouched until the chat-dependent key conversion has
                // run. This is a pause, not a fault — the message is shown on
                // live user surfaces and must not name internal functions.
                issues.push(deferIssue(
                    'per-message-legacy-pending',
                    ['perMessage'],
                    `Interiority needs a one-time compatibility update before it can be used (${legacyPending} legacy message key(s) still to convert); the saved data was left unchanged.`,
                    undefined,
                    'perMessage',
                ));
            }
        }
    }
    if (data.turnCounter !== undefined && (!isFiniteNumber(data.turnCounter) || data.turnCounter < 0)) {
        delete accepted.turnCounter;
        issues.push(quarantineIssue('turn-counter-invalid', ['turnCounter'], 'Interiority turnCounter must be a finite non-negative number.', data.turnCounter, 'turnCounter'));
    }
    return { data: accepted, issues, stats };
}

// ─── Migration (design §4.2 / §6.6, Part 2) ──────────────────────────────────

/**
 * v0 -> v1: canonical structural defaults, mirroring what
 * interiority/data.js getInteriorityData() creates on demand.
 *
 * Deliberately minimal:
 *   - Only ABSENT fields are defaulted; present-but-invalid values are left
 *     for the v1 validator to quarantine with their raw records recoverable
 *     (design §12).
 *   - A NON-OBJECT root is returned untouched for the validation gate to
 *     block (fatal-root policy) — never replaced with an empty store here.
 *   - The legacy perMessage key rewrite (numeric/"0"-style and `sd-*` keys to
 *     `mu-*`) CANNOT live here: it needs the live chat array, message UUIDs,
 *     and the sparse-chat hydration guard. It remains owned by
 *     migrateIndexKeys() in interiority/data.js (compatibility call site kept
 *     in place) until the hydration-path cutover lands it behind the same
 *     schema owner as everything else. Until that conversion completes, the
 *     v1 validator defers preparation rather than dropping the legacy
 *     entries (see validateInteriorityData()).
 *
 * Pure: returns a new object; the caller's data is untouched.
 */
export function migrateInteriorityV0ToV1(data) {
    if (!isObject(data)) return { data, issues: [] };
    const next = { ...data };
    if (next.enabled === undefined) next.enabled = true;
    if (next.ledger === undefined) next.ledger = [];
    if (next.deletedIntentions === undefined) next.deletedIntentions = [];
    if (next.perMessage === undefined) next.perMessage = {};
    if (next.turnCounter === undefined) next.turnCounter = 0;
    return { data: next, issues: [] };
}

/**
 * Interiority store schema. `createDefault` mirrors the runtime's on-demand
 * defaults from interiority/data.js getInteriorityData() AND the converged
 * v1 shape — createDefault() is canonical: migrating it changes nothing.
 */
export const interioritySchema = defineStoreSchema({
    id: 'interiority',
    metadataKey: 'mwt_interiority',
    currentVersion: 1,
    createDefault: () => ({ enabled: true, ledger: [], deletedIntentions: [], perMessage: {}, turnCounter: 0 }),
    migrations: { 0: migrateInteriorityV0ToV1 },
    validate: validateInteriorityData,
    policy: defineIssuePolicy({
        fatal: [
            'root-not-object',
        ],
        // A preparation pause pending chat-dependent work (design §7.5) — the
        // store presents as preparing, never as quarantined or corrupt.
        defer: [
            'per-message-legacy-pending',
        ],
        record: [
            'not-an-array',
            'duplicate-id',
            'ledger-not-object',
            'ledger-invalid-id',
            'ledger-invalid-npc',
            'ledger-invalid-action',
            'ledger-invalid-trigger',
            'tombstone-not-object',
            'tombstone-missing-fields',
            'tombstone-actions',
            'tombstone-triggers',
            'per-message-not-object',
            'per-message-entry',
            'turn-counter-invalid',
        ],
    }),
});
