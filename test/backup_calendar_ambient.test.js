/**
 * test/backup_calendar_ambient.test.js — Calendar and Ambient in the unified
 * chat backup.
 *
 * Both stores live in chat metadata (`mwt_calendar`, `mwt_ambient`) but were
 * missing from the backup, so a backup and restore lost a hand-authored
 * calendar and re-rolled the Ambient seed (a different weather history).
 * Pinned here:
 *
 *   - each store round-trips collect → wipe → restore → re-collect unchanged
 *     (the Ambient seed exactly, zero included);
 *   - a backup made before they were registered still restores, and leaves
 *     the chat's current calendar and Ambient record untouched — by merge AND
 *     by exact restore, which removes any store the backup does not contain
 *     and must not read "older exporter never knew this store" as "remove";
 *   - undo still removes a calendar the undone restore added;
 *   - both restore as whole records (replace / keep), following World
 *     State's identity policy;
 *   - an invalid calendar travels as-is with a finding, never refused.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import {
    buildBackupEnvelope,
    getEnvelopeMetadataSections,
    LEGACY_METADATA_SECTION_KEYS,
    METADATA_KEYS,
} from '../backup/data.js';
import { validateBackupEnvelope, validateSectionWithIssues } from '../backup/validate.js';
import { planRestore } from '../backup/restore.js';
import { exportBackup, restoreBackup, undoLastRestore } from '../backup/index.js';
import { MANIFEST_METADATA_KEY } from '../schema/manifest.js';
import { resetCoreStubs, setFakeChat, setFakeContextExtras, getFakeMeta } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const IDENTITY = { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null, key: 'chat:chat-a' };

function customCalendar(patch = {}) {
    return {
        version: 1,
        structure: 'custom',
        months: [{ name: 'Highsun', days: 30 }, { name: 'Rotmonth', days: 28 }, { name: 'Harvest', days: 31 }],
        weekdays: ['Starday', 'Moonday', 'Tideday'],
        era: 'Kelen Epoch',
        anchor: { year: 1247, month: 2, day: 9, weekday: 1 },
        dateLine: true,
        eventsLine: true,
        events: [
            { id: 'fair', name: 'Harbor Fair', date: { year: 1247, month: 3, day: 2 }, durationDays: 3, repeat: 'yearly' },
            { id: 'vigil', name: 'Moon Vigil', durationDays: 1, repeat: { lunar: 'full' } },
        ],
        phenomena: [{
            id: 'eclipse', shape: 'dated', name: 'Rotmonth eclipse', clause: 'a dim eclipse veils the sun',
            start: { year: 1247, month: 2, day: 20 }, durationDays: 2, repeat: 'none', end: null, light: 'twilight',
        }],
        ...patch,
    };
}

function ambientRecord(patch = {}) {
    return {
        enabled: true,
        climate: 'temperate',
        hemisphere: 'south',
        manualSeason: 'autumn',
        variability: 0.7,
        seed: 0, // a real seed value: Number.isFinite(0) — must not be "re-rolled"
        latitude: 41,
        clockAhead: 0.5,
        moonEpochOffset: 12,
        coastal: true,
        tideRange: 'extreme',
        setupAsked: true,
        pin: null,
        phenomena: [],
        ...patch,
    };
}

/**
 * A backup exactly as a build from BEFORE Calendar/Ambient registration wrote
 * it: no calendar/ambient sections, and no `_meta.metadataSections`. Written
 * out literally so the fixture cannot drift with buildBackupEnvelope().
 */
function olderBackup(sections = {}) {
    return {
        _meta: {
            type: 'mwt-chat-backup',
            formatVersion: 1,
            createdAt: '2026-11-01T12:00:00.000Z',
            mwtVersion: '2.17.2',
            source: 'manual',
            chatName: 'Harbor',
            messageCount: 1,
            identity: { ...IDENTITY },
        },
        sections: {
            worldState: { schemaVersion: 1, data: { text: 'The harbor gates stay shut.', autoSaveHistory: [] } },
            ...sections,
        },
    };
}

function setupHost() {
    resetCoreStubs();
    _resetEpoch();
    _clearCacheForTests();
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-a' }) };
    setFakeContextExtras({ getCurrentChatId: () => 'chat-a', saveMetadata: async () => {} });
    setFakeChat([{ mes: 'hello', extra: { mwt_uuid: '1' } }]);
    _setCacheForTests('Knowledge Tracker', { registry: {}, relationships: {} });
    _setCacheForTests('State Tracker', { stateRegistry: {} });
}

function teardownHost() {
    _clearCacheForTests();
    _resetEpoch();
    delete globalThis.SillyTavern;
}

/** Preview, then confirm with the preview's token (exact restores require it). */
async function exactRestore(file) {
    const preview = await restoreBackup(file, { exact: true });
    expect(preview).toMatchObject({ ok: false, committed: false, reason: 'confirmation-required' });
    const result = await restoreBackup(file, { exact: true, confirm: true, previewToken: preview.preview.previewToken });
    return { preview: preview.preview, result };
}

// ─── Envelope coverage ───────────────────────────────────────────────────────

describe('backup envelope — calendar and ambient sections', () => {
    test('METADATA_KEYS carries both stores at their module keys', () => {
        expect(METADATA_KEYS.calendar).toBe('mwt_calendar');
        expect(METADATA_KEYS.ambient).toBe('mwt_ambient');
    });

    test('a new envelope declares every section it covers, present or not', () => {
        const envelope = buildBackupEnvelope({ metadata: { calendar: customCalendar() } });
        expect(envelope._meta.metadataSections).toEqual(Object.keys(METADATA_KEYS));
        expect(Object.keys(envelope.sections)).toEqual(['calendar']);
        expect(getEnvelopeMetadataSections(envelope)).toEqual(Object.keys(METADATA_KEYS));
    });

    test('an envelope without a declaration covers only the original six stores', () => {
        expect(getEnvelopeMetadataSections(olderBackup())).toEqual([...LEGACY_METADATA_SECTION_KEYS]);
        expect(LEGACY_METADATA_SECTION_KEYS).not.toContain('calendar');
        expect(LEGACY_METADATA_SECTION_KEYS).not.toContain('ambient');
        // Malformed declarations fall back the same way; a section actually
        // present always counts as covered; unknown names are dropped.
        const odd = olderBackup({ ambient: { schemaVersion: 1, data: ambientRecord() } });
        odd._meta.metadataSections = 'everything';
        expect(getEnvelopeMetadataSections(odd)).toEqual([...LEGACY_METADATA_SECTION_KEYS, 'ambient']);
        odd._meta.metadataSections = ['worldState', 'ledger'];
        expect(getEnvelopeMetadataSections(odd)).toEqual(['worldState', 'ambient']);
    });

    test('an invalid calendar is imported as-is with a reference finding, never refused', () => {
        const invalid = customCalendar({ months: [{ name: 'Highsun', days: 99 }] });
        const envelope = buildBackupEnvelope({ metadata: { calendar: invalid } });
        const result = validateBackupEnvelope(JSON.parse(JSON.stringify(envelope)));
        expect(result.ok).toBe(true);
        expect(result.sections.calendar).toEqual(invalid);
        expect(result.summaries.calendar.skipped).toEqual([]);
        expect(result.quarantine.calendar).toBeUndefined();

        const { issues } = validateSectionWithIssues('calendar', invalid);
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ code: 'calendar-invalid', severity: 'reference' });
        expect(issues[0].message).toContain('Month lengths must be 1–40 days.');
    });

    test('a valid calendar and ambient record validate with no findings', () => {
        expect(validateSectionWithIssues('calendar', customCalendar()).issues).toEqual([]);
        expect(validateSectionWithIssues('ambient', ambientRecord()).issues).toEqual([]);
        const seed = validateSectionWithIssues('ambient', ambientRecord({ seed: '42' })).issues;
        expect(seed).toEqual([expect.objectContaining({ code: 'seed-invalid', severity: 'reference', path: ['seed'] })]);
    });

    test('an unreadable root refuses the section instead of importing an empty one', () => {
        const envelope = olderBackup({ calendar: { schemaVersion: 1, data: 'corrupt' } });
        const result = validateBackupEnvelope(envelope);
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain('Section "calendar" could not be imported');
    });
});

// ─── Restore planning (pure) ─────────────────────────────────────────────────

describe('planRestore — calendar and ambient restore as whole records', () => {
    const fileWith = metadata => buildBackupEnvelope({ identity: IDENTITY, metadata });

    test('merge replaces the current record by default and counts it', () => {
        const incoming = customCalendar({ era: 'Second Epoch' });
        const plan = planRestore(fileWith({ calendar: incoming, ambient: ambientRecord({ seed: 7 }) }), {
            calendar: customCalendar(),
        }, { currentIdentity: IDENTITY });
        expect(plan.ok).toBe(true);
        expect(plan.plan.sections.calendar).toEqual(incoming);
        expect(plan.plan.sections.ambient).toEqual(ambientRecord({ seed: 7 }));
        expect(plan.summary.calendar).toMatchObject({ added: 0, updated: 1, skipped: [] });
        expect(plan.summary.ambient).toMatchObject({ added: 1, updated: 0, skipped: [] });
    });

    test('an identical record reports no change rather than an update', () => {
        const plan = planRestore(fileWith({ calendar: customCalendar() }), { calendar: customCalendar() },
            { currentIdentity: IDENTITY });
        expect(plan.summary.calendar).toMatchObject({ added: 0, updated: 0, skipped: [] });
    });

    test('keep mode leaves the current record out of the write plan', () => {
        const plan = planRestore(fileWith({ calendar: customCalendar({ era: 'Second Epoch' }), ambient: ambientRecord({ seed: 7 }) }), {
            calendar: customCalendar(),
            ambient: ambientRecord(),
        }, { currentIdentity: IDENTITY, modes: { calendar: 'keep', ambient: 'keep' } });
        expect(plan.plan.sections.calendar).toBeUndefined();
        expect(plan.plan.sections.ambient).toBeUndefined();
        expect(plan.plan.canonicalSections).not.toContain('calendar');
        expect(plan.summary.calendar.skipped).toEqual([{ record: 'calendar', reason: 'Section was not replaced (keep).' }]);
    });

    test('unknown identity keeps an existing record but still fills an absent one', () => {
        const unknown = { isUnknown: true };
        const plan = planRestore(fileWith({ calendar: customCalendar({ era: 'Second Epoch' }), ambient: ambientRecord({ seed: 7 }) }), {
            calendar: customCalendar(),
        }, { currentIdentity: unknown });
        expect(plan.plan.sections.calendar).toBeUndefined();
        expect(plan.plan.sections.ambient).toEqual(ambientRecord({ seed: 7 }));
        expect(plan.identityPolicy.warning).toContain('calendar or Ambient record');
    });

    test('an older backup plans no calendar or ambient write at all', () => {
        const plan = planRestore(olderBackup(), { calendar: customCalendar(), ambient: ambientRecord() },
            { currentIdentity: IDENTITY });
        expect(plan.ok).toBe(true);
        expect(plan.plan.sections.worldState).toBeTruthy();
        expect(Object.keys(plan.plan.sections)).not.toContain('calendar');
        expect(Object.keys(plan.plan.sections)).not.toContain('ambient');
    });
});

// ─── Runtime round trips and older backups ───────────────────────────────────

describe('restore — calendar and ambient through the real collect/restore path', () => {
    beforeEach(setupHost);
    afterEach(teardownHost);

    test('calendar round-trips collect → wipe → restore → re-collect unchanged', async () => {
        const meta = getFakeMeta();
        meta.mwt_calendar = customCalendar();
        const first = await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(first.sections.calendar.data).toEqual(customCalendar());

        delete meta.mwt_calendar;
        const restored = await restoreBackup(JSON.parse(JSON.stringify(first)), { confirm: true });
        expect(restored).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_calendar).toEqual(customCalendar());
        expect(meta[MANIFEST_METADATA_KEY].sections.calendar).toBe(1);

        const second = await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(second.sections.calendar.data).toEqual(first.sections.calendar.data);
    });

    test('ambient round-trips with its exact seed (zero included), so the weather history is kept', async () => {
        const meta = getFakeMeta();
        meta.mwt_ambient = ambientRecord();
        const first = await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(first.sections.ambient.data).toEqual(ambientRecord());

        delete meta.mwt_ambient;
        const restored = await restoreBackup(JSON.parse(JSON.stringify(first)), { confirm: true });
        expect(restored).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_ambient).toEqual(ambientRecord());
        expect(meta.mwt_ambient.seed).toBe(0);
        expect(meta[MANIFEST_METADATA_KEY].sections.ambient).toBe(1);

        const second = await exportBackup({ download: false, includeKnowledgeStore: false });
        expect(second.sections.ambient.data).toEqual(first.sections.ambient.data);
    });

    test('an older backup merge-restores and leaves the current calendar and ambient untouched', async () => {
        const meta = getFakeMeta();
        meta.mwt_calendar = customCalendar();
        meta.mwt_ambient = ambientRecord();

        const result = await restoreBackup(olderBackup(), { confirm: true });

        expect(result).toMatchObject({ ok: true, committed: true });
        expect(meta.world_state_tracker_metadata.text).toBe('The harbor gates stay shut.');
        expect(meta.mwt_calendar).toEqual(customCalendar());
        expect(meta.mwt_ambient).toEqual(ambientRecord());
        expect(result.preview.summary.calendar).toBeUndefined();
        expect(result.preview.summary.ambient).toBeUndefined();
    });

    test('an exact restore of an older backup keeps calendar and ambient (it never covered them)', async () => {
        const meta = getFakeMeta();
        meta.mwt_calendar = customCalendar();
        meta.mwt_ambient = ambientRecord();
        // A covered store the older backup lacks is still removed — the six
        // original stores keep their exact-restore semantics.
        meta.session_chronicle_data = { snapshots: [{ id: 's1', text: 'After the backup.' }], _deletedBin: [] };

        const { preview, result } = await exactRestore(olderBackup());

        expect(preview.summary.calendar).toMatchObject({ mode: 'exact', action: 'kept', removed: 0 });
        expect(preview.summary.ambient).toMatchObject({ mode: 'exact', action: 'kept', removed: 0 });
        expect(preview.summary.chronicle).toMatchObject({ mode: 'exact', action: 'removed', removed: 1 });
        expect(preview.plan.removeMetadataSections).toContain('chronicle');
        expect(preview.plan.removeMetadataSections).not.toContain('calendar');
        expect(preview.plan.removeMetadataSections).not.toContain('ambient');
        expect(result).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_calendar).toEqual(customCalendar());
        expect(meta.mwt_ambient).toEqual(ambientRecord());
        expect(meta.session_chronicle_data).toBeUndefined();
    });

    test('an exact restore of a current backup removes a calendar the source chat did not have', async () => {
        const meta = getFakeMeta();
        meta.mwt_calendar = customCalendar();
        const file = buildBackupEnvelope({ identity: IDENTITY, metadata: { ambient: ambientRecord() } });

        const { preview, result } = await exactRestore(file);

        expect(preview.summary.calendar).toMatchObject({ mode: 'exact', action: 'removed', removed: 1 });
        expect(result).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_calendar).toBeUndefined();
        expect(meta.mwt_ambient).toEqual(ambientRecord());
    });

    test('undo removes a calendar the undone restore added, and restores a replaced ambient seed', async () => {
        const meta = getFakeMeta();
        meta.mwt_ambient = ambientRecord({ seed: 11 });
        const file = buildBackupEnvelope({
            identity: IDENTITY,
            metadata: { calendar: customCalendar(), ambient: ambientRecord({ seed: 99 }) },
        });

        const restored = await restoreBackup(file, { confirm: true });
        expect(restored).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_calendar).toEqual(customCalendar());
        expect(meta.mwt_ambient.seed).toBe(99);

        const undone = await undoLastRestore({ confirm: true });
        expect(undone).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_calendar).toBeUndefined();
        expect(meta.mwt_ambient).toEqual(ambientRecord({ seed: 11 }));
    });
});
