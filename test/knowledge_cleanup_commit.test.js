/**
 * test/knowledge_cleanup_commit.test.js — the guarded cleanup commit service
 * (knowledge/cleanup_commit.js), Phase 3 of the Knowledge concision roadmap.
 *
 * THE PHASE 3 EXIT GATE, as tests (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_
 * PLAN.md): storage failure blocks target mutation; scope switches, stale
 * data, rename/merge mismatches, deletion, and ambiguous UIDs cannot write;
 * failures before/after recovery persistence and during target save behave
 * fail-closed; ambiguous outcomes reconcile by reloading; duplicate Apply is
 * refused; and restore handles both newer-unrelated-work (span-aware, outside
 * edits preserved) and touched-field conflicts (refused, export offered).
 *
 * Uses fake world-info storage (the test/store.test.js disk contract) — the
 * books Map is the disk, so every reload in the service under test is real.
 */

import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import * as knowledgeScope from '../knowledge/scope.js';
import { _setCacheForTests, _clearCacheForTests, isStoreEntry } from '../knowledge/store.js';
import { getCleanupRecord, updateCleanupRecord, readCleanupRecoveryContainer } from '../knowledge/cleanup_recovery.js';
import {
    captureCleanupTarget, applyCleanup, reconcileCleanupOutcome, restoreCleanup,
} from '../knowledge/cleanup_commit.js';
import {
    ledgerSpan, captureLedgerReview, originalLedgerProposal,
    patchLedgerProposal, validateLedgerReplacement,
} from '../knowledge/ledger_cleanup.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const BOOK = 'Knowledge Tracker';
const NPC = 'Mara Voss';
const OTHER = 'Derek Sandhorn';

const ORIGINAL = [
    '[Dossier] Mara Voss | Human | weathered harbourmaster',
    'Tone: brisk',
    'Role: Harbourmaster of Dusk Quay',
    'Current Agenda: Root out the smugglers.',
    '',
    'Knowledge Ledger:',
    '- smugglers use the north wharf via told — Day 5',
    '- smugglers have guild keys via witness — Day 7',
].join('\n');

const REPLACEMENT = [
    '[Dossier] Mara Voss | Human | weathered harbourmaster',
    'Tone: brisk',
    'Role: Harbourmaster of Dusk Quay',
    'Current Agenda: Root out the smugglers.',
    '',
    'Knowledge Ledger:',
    '- smugglers use the north wharf and hold guild keys via told/witness — Day 5-7',
].join('\n');

function makeFakeWorldInfo() {
    const books = new Map();
    let saveCalls = 0;
    const fake = {
        books,
        failSaveAt: null,          // saveWorldInfo throws on this call number
        failSavesFrom: null,
        afterSave: null,
        tamperAfterSave: null,     // after this save count, reads see a concurrent edit
        get saveCalls() { return saveCalls; },
        async loadWorldInfo(name) {
            const wi = books.has(name) ? structuredClone(books.get(name)) : null;
            if (wi && fake.tamperAfterSave !== null && saveCalls >= fake.tamperAfterSave && wi.entries?.[7]) {
                wi.entries[7].content += '\nLATER EDIT';
            }
            return wi;
        },
        async saveWorldInfo(name, wi, immediately = false) {
            saveCalls++;
            if (fake.failSaveAt === saveCalls || (fake.failSavesFrom !== null && saveCalls >= fake.failSavesFrom)) throw new Error('disk unavailable');
            if (!immediately) return;
            books.set(name, structuredClone(wi));
            fake.afterSave?.(saveCalls, name);
        },
        async createNewWorldInfo(name) { books.set(name, { entries: {} }); return true; },
    };
    return fake;
}

let wiFake;

function seedBook({ npcContent = ORIGINAL, npcLabel = NPC } = {}) {
    wiFake.books.set(BOOK, {
        entries: {
            7: { uid: 7, comment: npcLabel, key: [NPC], content: npcContent },
            8: { uid: 8, comment: OTHER, key: [OTHER], content: `${OTHER} | Human | harbour clerk` },
        },
    });
}

function entry7() {
    return wiFake.books.get(BOOK).entries[7];
}

function apply({ capture, replacement = REPLACEMENT, actionId = 'act-1', validate } = {}) {
    return applyCleanup({ capture, replacement, actionId, validate });
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _clearCacheForTests();
    saveSettings({ scope: 'global', connectionProfileId: 'test-profile' });
    _setCacheForTests(BOOK, { registry: {
        [NPC]: { uid: 7, type: 'major', keywords: [NPC], entityId: 'ent-1' },
        [OTHER]: { uid: 8, type: 'minor', keywords: [OTHER] },
    } });
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    seedBook();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    _clearCacheForTests();
    _resetEpoch();
    state.wiScript = null;
    vi.restoreAllMocks();
});

// ─── Capture ─────────────────────────────────────────────────────────────────

describe('captureCleanupTarget', () => {
    test('Phase 2 final validator gates apply and the real ledger span restores safely', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        const review = captureLedgerReview(capture.originalContent, 'integration-review');
        const proposal = originalLedgerProposal(review);
        proposal.records = [{ id: 'merged', text: 'smugglers use the north wharf and hold guild keys via told/witness — Day 5-7', sourceIds: review.sources.map(s => s.id), notes: 'Preserve both observations.' }];
        const { replacement } = patchLedgerProposal(review, proposal);
        const validate = input => validateLedgerReplacement(review, proposal, undefined, input);
        await expect(apply({ capture, replacement: replacement.replace('Tone: brisk', 'Tone: changed'), validate })).resolves.toMatchObject({ ok: false, code: 'validation-failed' });
        expect(wiFake.saveCalls).toBe(0);
        await expect(apply({ capture, replacement, validate })).resolves.toMatchObject({ ok: true });
        entry7().content = entry7().content.replace('Tone: brisk', 'Tone: newer unrelated work');
        await expect(restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan })).resolves.toMatchObject({ ok: true });
        expect(entry7().content).toBe(ORIGINAL.replace('Tone: brisk', 'Tone: newer unrelated work'));
    });

    test('binds identity, scope, entity id, and the exact original bytes', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        expect(capture.name).toBe(NPC);
        expect(capture.uid).toBe(7);
        expect(capture.bookName).toBe(BOOK);
        expect(capture.entityId).toBe('ent-1');
        expect(capture.originalContent).toBe(ORIGINAL);
        expect(capture.originalFingerprint).toBeTruthy();
        expect(capture.scopeToken).toBeTruthy();
        expect(capture.keywords).toEqual([NPC]);
    });

    test('refuses a uid labelled as another NPC (rename/merge or stale uid)', async () => {
        await expect(captureCleanupTarget({ name: NPC, uid: 8 })).rejects.toThrow(/labelled "Derek Sandhorn"/);
    });

    test('refuses ambiguous destinations — duplicate entries for the NPC', async () => {
        wiFake.books.get(BOOK).entries[9] = { uid: 9, comment: NPC, key: [NPC], content: ORIGINAL };
        await expect(captureCleanupTarget({ name: NPC, uid: 7 })).rejects.toThrow(/exactly one destination/);
    });
});

// ─── Apply: the guarded write ────────────────────────────────────────────────

describe('applyCleanup', () => {
    test('happy path: replacement lands, everything else is preserved, record applied', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        const result = await apply({ capture });
        expect(result.ok).toBe(true);

        expect(entry7().content).toBe(REPLACEMENT);
        // Unrelated entries preserved; the embedded store folded into the save.
        expect(wiFake.books.get(BOOK).entries[8].content).toBe(`${OTHER} | Human | harbour clerk`);
        expect(Object.values(wiFake.books.get(BOOK).entries).some(isStoreEntry)).toBe(true);

        const record = await getCleanupRecord('act-1');
        expect(record.status).toBe('applied');
        expect(record.originalContent).toBe(ORIGINAL);
        expect(record.approvedReplacement).toBe(REPLACEMENT);
        expect(record.entityName).toBe(NPC);
        expect(record.entityId).toBe('ent-1');
    });

    test('storage failure during RECOVERY persistence blocks the target mutation', async () => {
        wiFake.failSaveAt = 1; // the recovery container save
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        const result = await apply({ capture });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('recovery-persist-failed');
        expect(entry7().content).toBe(ORIGINAL); // nothing mutated
        const read = await readCleanupRecoveryContainer(BOOK);
        expect(read.records).toEqual({});
    });

    test('failure during the TARGET save: recovery preserved, status failed, entry unchanged', async () => {
        wiFake.failSaveAt = 3; // recovery save (1), pending update (2), target write (3)
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        const result = await apply({ capture });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('target-save-failed');
        expect(entry7().content).toBe(ORIGINAL);
        const record = await getCleanupRecord('act-1');
        expect(record.status).toBe('failed');
        expect(record.failedReason).toContain('disk unavailable');
        expect(record.originalContent).toBe(ORIGINAL); // recovery preserved
    });

    test('a stale source (entry changed after capture) refuses before any persistence', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        entry7().content = ORIGINAL + '\n- later manual edit via witness — Day 9';
        const result = await apply({ capture });
        expect(result.code).toBe('stale-source');
        expect(wiFake.saveCalls).toBe(0);
    });

    test('a deleted destination cannot be written', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        delete wiFake.books.get(BOOK).entries[7];
        const result = await apply({ capture });
        expect(result.code).toBe('destination-missing');
        expect(wiFake.saveCalls).toBe(0);
        const read = await readCleanupRecoveryContainer(BOOK);
        expect(read.records).toEqual({});
    });

    test('a scope switch (epoch bump) retires the operation with zero writes', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        bumpEpoch();
        const result = await apply({ capture });
        expect(result.code).toBe('scope-changed');
        expect(wiFake.saveCalls).toBe(0);
    });

    test('duplicate Apply is refused; the entry is not written twice', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        expect((await apply({ capture })).ok).toBe(true);
        const again = await apply({ capture });
        expect(again.code).toBe('duplicate');
        expect(entry7().content).toBe(REPLACEMENT);
    });

    test('the caller-supplied final validation gates before persistence', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        const result = await apply({
            capture,
            validate: () => ({ ok: false, reason: 'coverage incomplete: source 3 unaccounted' }),
        });
        expect(result.code).toBe('validation-failed');
        expect(result.error).toContain('coverage incomplete');
        expect(wiFake.saveCalls).toBe(0);
        const read = await readCleanupRecoveryContainer(BOOK);
        expect(read.records).toEqual({});
    });

    test('a concurrent writer after the save yields outcome-uncertain, then reconciles to applied', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        wiFake.tamperAfterSave = 3; // reads after the target save see a "later edit"
        const result = await apply({ capture });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('outcome-uncertain');
        expect((await getCleanupRecord('act-1')).status).toBe('outcome-uncertain');

        // Reconcile by reloading: the disk actually holds replacement + later
        // edit (the save landed; another writer appended).
        wiFake.tamperAfterSave = null;
        const onDisk = entry7().content;
        expect(onDisk).toBe(REPLACEMENT + '\nLATER EDIT');
        const reconciled = await reconcileCleanupOutcome('act-1', { replacement: REPLACEMENT + '\nLATER EDIT' });
        expect(reconciled.status).toBe('applied');
        expect((await getCleanupRecord('act-1')).status).toBe('applied');
    });

    test('reconcile marks FAILED when the original never left the entry', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        expect((await apply({ capture })).ok).toBe(true);
        await updateCleanupRecord('act-1', { status: 'outcome-uncertain' });
        entry7().content = ORIGINAL; // the replacement in fact never landed
        const reconciled = await reconcileCleanupOutcome('act-1');
        expect(reconciled.status).toBe('failed');
        expect((await getCleanupRecord('act-1')).status).toBe('failed');
    });
});

// ─── Restore ─────────────────────────────────────────────────────────────────

describe('cleanup persistence race guards', () => {
    test.each([
        ['scope-changed', () => bumpEpoch()],
        ['book-changed', () => vi.spyOn(knowledgeScope, 'getLorebookName').mockReturnValue('Another Knowledge Book')],
        ['identity-mismatch', () => { entry7().comment = 'Someone Else'; }],
        ['entity-changed', () => {
            _setCacheForTests(BOOK, { registry: { [NPC]: { uid: 7, entityId: 'ent-new', keywords: [NPC] } } });
        }],
        ['destination-ambiguous', () => {
            wiFake.books.get(BOOK).entries[99] = { ...entry7(), uid: 99 };
        }],
    ])('Apply refuses %s introduced during original persistence', async (code, change) => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        wiFake.afterSave = (count) => { if (count === 1) change(); };
        const result = await apply({ capture });
        expect(result).toMatchObject({ ok: false, code });
        expect(entry7().content).toBe(ORIGINAL);
        expect((await getCleanupRecord('act-1', BOOK)).status).toBe('failed');
    });

    test('persistent status-save failure returns uncertain and pending reconciles after recovery', async () => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        wiFake.failSavesFrom = 4;
        await expect(apply({ capture })).resolves.toMatchObject({ ok: false, code: 'outcome-uncertain' });
        expect(entry7().content).toBe(REPLACEMENT);
        expect((await getCleanupRecord('act-1')).status).toBe('application-pending');
        await expect(reconcileCleanupOutcome('act-1')).resolves.toMatchObject({ status: 'outcome-uncertain' });
        wiFake.failSavesFrom = null;
        await expect(reconcileCleanupOutcome('act-1')).resolves.toEqual({ status: 'applied' });
        await expect(apply({ capture })).resolves.toMatchObject({ code: 'duplicate' });
    });

    test.each([
        ['replacement', REPLACEMENT, 'applied'],
        ['original', ORIGINAL, 'failed'],
        ['other edit', 'new manual content', 'outcome-uncertain'],
    ])('pending record reconciles against %s bytes after reload', async (_label, content, status) => {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        await apply({ capture });
        await updateCleanupRecord('act-1', { status: 'application-pending' });
        entry7().content = content;
        await expect(reconcileCleanupOutcome('act-1')).resolves.toMatchObject({ status });
    });
});

describe('restoreCleanup', () => {
    async function appliedCapture() {
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        const result = await apply({ capture });
        expect(result.ok).toBe(true);
        return capture;
    }

    test('preserves an outside-span edit made while saving the safeguard and safeguards the latest version', async () => {
        await appliedCapture();
        const nextSave = wiFake.saveCalls + 1;
        wiFake.afterSave = (count) => {
            if (count === nextSave) entry7().content = entry7().content.replace('Tone: brisk', 'Tone: NEW MANUAL EDIT');
        };
        const result = await restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan });
        expect(result.ok).toBe(true);
        expect(entry7().content).toBe(ORIGINAL.replace('Tone: brisk', 'Tone: NEW MANUAL EDIT'));
        const read = await readCleanupRecoveryContainer(BOOK);
        const safeguards = Object.values(read.records).filter(r => r.actionType === 'restore-safeguard');
        expect(safeguards.some(r => r.originalContent === REPLACEMENT.replace('Tone: brisk', 'Tone: NEW MANUAL EDIT'))).toBe(true);
    });

    test.each(['span-conflict', 'scope-changed', 'destination-ambiguous'])('Restore refuses %s introduced during safeguard persistence', async (code) => {
        await appliedCapture();
        const nextSave = wiFake.saveCalls + 1;
        wiFake.afterSave = (count) => {
            if (count !== nextSave) return;
            if (code === 'scope-changed') bumpEpoch();
            else if (code === 'destination-ambiguous') wiFake.books.get(BOOK).entries[99] = { ...entry7(), uid: 99 };
            else entry7().content += '\n- new ledger edit';
        };
        await expect(restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan })).resolves.toMatchObject({ ok: false, code });
        expect(entry7().content).toBe(code === 'span-conflict' ? `${REPLACEMENT}\n- new ledger edit` : REPLACEMENT);
        expect((await getCleanupRecord('act-1')).status).toBe('applied');
    });

    test('restores only the cleanup-owned span; newer unrelated edits survive', async () => {
        await appliedCapture();
        // A newer, unrelated edit OUTSIDE the ledger span after the cleanup.
        entry7().content = entry7().content.replace('Tone: brisk', 'Tone: brisk and dry');

        const result = await restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan });
        expect(result.ok).toBe(true);
        const expected = [
            '[Dossier] Mara Voss | Human | weathered harbourmaster',
            'Tone: brisk and dry',                       // newer unrelated edit kept
            'Role: Harbourmaster of Dusk Quay',
            'Current Agenda: Root out the smugglers.',
            '',
            'Knowledge Ledger:',
            '- smugglers use the north wharf via told — Day 5',  // original span back
            '- smugglers have guild keys via witness — Day 7',
        ].join('\n');
        expect(entry7().content).toBe(expected);

        // The record is restored, and a pre-restore safeguard was captured.
        expect((await getCleanupRecord('act-1')).status).toBe('restored');
        const container = await readCleanupRecoveryContainer(BOOK);
        const safeguard = Object.values(container.records).find(r => r.actionType === 'restore-safeguard');
        expect(safeguard).toBeTruthy();
        expect(safeguard.originalContent).toContain('Tone: brisk and dry');
    });

    test('a touched-span change since apply is a conflict: refused, export offered', async () => {
        await appliedCapture();
        // A later LEDGER edit — inside the cleanup-owned span.
        entry7().content = entry7().content
            .replace('— Day 5-7', '— Day 5-7')
            + '\n- newer ledger fact via witness — Day 9';

        const result = await restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('span-conflict');
        expect(result.conflict.exportable).toBe(true);
        expect(entry7().content).toContain('newer ledger fact'); // refused — untouched
        expect((await getCleanupRecord('act-1')).status).toBe('applied');
    });

    test('deletion: destination missing refuses and offers the export', async () => {
        await appliedCapture();
        delete wiFake.books.get(BOOK).entries[7];
        const result = await restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan });
        expect(result.code).toBe('destination-missing');
        expect(result.conflict.exportable).toBe(true);
        // The recovery original is still held.
        expect((await getCleanupRecord('act-1')).originalContent).toBe(ORIGINAL);
    });

    test('rename: an entry relabelled to another NPC refuses', async () => {
        await appliedCapture();
        entry7().comment = 'Someone Else';
        const result = await restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan });
        expect(result.code).toBe('identity-mismatch');
        expect(entry7().content).toBe(REPLACEMENT); // untouched
    });

    test('merge/rename: a changed stable entity id refuses', async () => {
        await appliedCapture();
        _setCacheForTests(BOOK, { registry: {
            [NPC]: { uid: 7, type: 'major', keywords: [NPC], entityId: 'ent-2' },
            [OTHER]: { uid: 8, type: 'minor', keywords: [OTHER] },
        } });
        const result = await restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan });
        expect(result.code).toBe('entity-changed');
    });

    test('a scope mismatch (different chat/scope) refuses', async () => {
        await appliedCapture();
        const container = await readCleanupRecoveryContainer(BOOK);
        const wi = wiFake.books.get(BOOK);
        const entry = Object.values(wi.entries).find(e => e.comment?.startsWith('[MWT:cleanup-recovery]'));
        const parsed = JSON.parse(entry.content);
        parsed.records['act-1'].scopeKey = 'a-different-scope';
        entry.content = JSON.stringify(parsed);
        expect(container.ok).toBe(true);

        const result = await restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan });
        expect(result.code).toBe('scope-changed');
        expect(entry7().content).toBe(REPLACEMENT);
    });

    test('without a span extractor the whole entry must match — outside edits conflict', async () => {
        await appliedCapture();
        entry7().content = entry7().content.replace('Tone: brisk', 'Tone: brisk and dry');
        const result = restoreCleanup({ actionId: 'act-1' }); // default: whole content
        await expect(result).resolves.toMatchObject({ ok: false, code: 'span-conflict' });
    });

    test('only applied cleanups restore; unknown actions report clearly', async () => {
        await expect(restoreCleanup({ actionId: 'missing' })).resolves.toMatchObject({ code: 'unknown-action' });
        // A failed record (never applied) is not restorable.
        wiFake.failSaveAt = 3;
        const capture = await captureCleanupTarget({ name: NPC, uid: 7 });
        await apply({ capture });
        await expect(restoreCleanup({ actionId: 'act-1', spanOf: ledgerSpan }))
            .resolves.toMatchObject({ code: 'not-applied' });
    });
});
