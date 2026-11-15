/**
 * calendar/schema.js — Calendar store descriptor.
 *
 * The module-owned schema for `chat_metadata.mwt_calendar`: the user's
 * hand-authored calendar record (CALENDAR_DESIGN.md D38). Registered so that
 * backup, runtime preparation and Diagnostics enumerate it like every other
 * chat-metadata store (schema/registry.js). Before registration a backup
 * silently dropped it, and a restore could not bring it back.
 *
 * The rules are NOT restated here. `validateCalendarRecord()` in
 * core/calendar_math.js is the single owner of what a calendar record is: the
 * Calendar tab's save path (core/calendar_edit.js requireCalendarRecord) and
 * the runtime read path (core/calendar_state.js getCalendarStatus) both call
 * it. That module is a pure, import-free leaf, which is why this schema may
 * import it (test/schema_engine.test.js sweeps it with the schema files).
 *
 * An invalid but readable record is RETAINED with a reference finding,
 * never quarantined. The runtime already keeps such a record in place and
 * reports it on the Overview as "invalid calendar" with the reasons, so the
 * user can see and fix it. Quarantining it here would make the load gate
 * remove the record on first open, and a backup restore would drop a record
 * the source chat still held. Only an unreadable (non-object) root is fatal,
 * as for every other store.
 *
 * Validation checks and never canonicalizes: the accepted data is the stored
 * record unchanged. Normalization (trimmed names, defaulted durations) belongs
 * to the save path, so the load gate never rewrites a stored calendar.
 *
 * Two versions, two owners: `version: 1` INSIDE the record is the calendar
 * record format that validateCalendarRecord checks (CALENDAR_VERSION); the
 * descriptor's `currentVersion` is the store's schema version in the chat's
 * schema manifest. They move independently.
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and the
 * calendar module's own `getChatMeta('mwt_calendar')` reads);
 * test/schema_engine.test.js pins the registry against METADATA_KEYS.
 */
import {
    defineIssuePolicy,
    defineStoreSchema,
    emptyStats,
    fatalIssue,
    isObject,
    ISSUE_SEVERITIES,
    makeIssue,
} from '../core/schema.js';
import { validateCalendarRecord } from '../core/calendar_math.js';

/**
 * Validate a stored calendar record. Root type is the only fatal rule; a
 * record that fails validateCalendarRecord stays in the data with one
 * `calendar-invalid` reference finding carrying the reasons.
 */
export function validateCalendarData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(fatalIssue('root-not-object', [], 'Calendar data must be an object.', data, 'calendar'));
        return { data: {}, issues, stats };
    }
    let errors;
    try {
        const result = validateCalendarRecord(data);
        errors = result.valid ? [] : result.errors;
    } catch (error) {
        // A checker fault is a finding about this record, not a reason to
        // block the store or refuse a whole backup.
        errors = [`The calendar could not be checked (${error?.message ?? String(error)}).`];
    }
    if (errors.length > 0) {
        issues.push(makeIssue({
            code: 'calendar-invalid',
            path: [],
            severity: ISSUE_SEVERITIES.REFERENCE,
            message: `The calendar record is kept but inactive until fixed: ${errors.join(' ')}`,
            identity: 'calendar',
        }));
    }
    // One record, retained either way (a reference finding keeps its record).
    stats.added = 1;
    return { data: { ...data }, issues, stats };
}

/**
 * v0 -> v1: no shape change. A legacy (unstamped) calendar is already in the
 * only shape the Calendar module has ever written; the step exists so the
 * load gate can stamp the store at v1. A non-object root is returned untouched
 * for the fatal-root policy to block, as in every other store's migration.
 */
export function migrateCalendarV0ToV1(data) {
    if (!isObject(data)) return { data, issues: [] };
    return { data: { ...data }, issues: [] };
}

/**
 * Calendar store schema. `createDefault` is the smallest valid record (a
 * Gregorian calendar with no events, phenomena or events line). Nothing
 * writes it: an absent store stays absent, and the Calendar tab offers its
 * own starter record.
 */
export const calendarSchema = defineStoreSchema({
    id: 'calendar',
    metadataKey: 'mwt_calendar',
    currentVersion: 1,
    createDefault: () => ({ version: 1, structure: 'gregorian', eventsLine: false, events: [], phenomena: [] }),
    migrations: { 0: migrateCalendarV0ToV1 },
    validate: validateCalendarData,
    policy: defineIssuePolicy({
        fatal: ['root-not-object'],
        reference: ['calendar-invalid'],
    }),
});
