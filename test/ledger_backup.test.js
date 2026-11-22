import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createLedger } from '../ledger/data.js';
import { buildBackupEnvelope, METADATA_KEYS } from '../backup/data.js';
import { validateBackupEnvelope, validateSectionWithIssues } from '../backup/validate.js';
import { planRestore } from '../backup/restore.js';
import { exportBackup, restoreBackup, undoLastRestore } from '../backup/index.js';
import { resetCoreStubs, setFakeChat, setFakeContextExtras, getFakeMeta } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';

const identity = { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null, key: 'chat:chat-a' };
const ledger = amount => ({ ...createLedger(),
    currencies: [{ id: 'c1', name: 'gold', decimals: 0, badge: true }],
    transactions: [{ id: 't1', currency: 'c1', amount, note: 'Opening purse', date: null, kind: 'entry' }],
    items: [{ id: 'i1', name: 'sword', qty: 1, carried: true, note: 'heirloom' }],
});

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _clearCacheForTests();
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-a' }) };
    setFakeContextExtras({ getCurrentChatId: () => 'chat-a', saveMetadata: async () => {} });
    setFakeChat([{ mes: 'hello', extra: { mwt_uuid: '1' } }]);
    _setCacheForTests('Knowledge Tracker', { registry: {}, relationships: {} });
    _setCacheForTests('State Tracker', { stateRegistry: {} });
});
afterEach(() => {
    _clearCacheForTests();
    _resetEpoch();
    delete globalThis.SillyTavern;
});

describe('Ledger unified backup', () => {
    test('v2 audit, loan and inventory fields survive an envelope round trip', () => {
        const record = ledger(50);
        Object.assign(record.transactions[0], { loan: true, counterparty: 'Aldric', source: 'p1' });
        Object.assign(record.items[0], { pinned: true, where: 'Inn chest' });
        record.proposals.push({ id: 'p1', kind: 'money', money: { currency: 'c1', amount: 50, loan: true },
            counterparty: 'Aldric', evidence: 'Aldric lent her fifty gold.', msg: { identity: 'uuid:one', digest: 'original' }, status: 'accepted' });
        record.itemLog.push({ id: 'l1', name: 'sword', change: 'added', detail: 'Added ×1', source: 'user', date: null });
        const file = JSON.parse(JSON.stringify(buildBackupEnvelope({ identity, metadata: { ledger: record } })));
        expect(validateBackupEnvelope(file).ok).toBe(true);
        expect(planRestore(file, {}, { currentIdentity: identity }).plan.sections.ledger).toEqual(record);
    });

    test('exports, wipes, restores and re-exports hand-entered data exactly', async () => {
        const meta = getFakeMeta();
        meta.mwt_ledger = ledger(470);
        meta.mwt_schema_manifest = { manifestVersion: 1, sections: { ledger: 2 } };
        const file = await exportBackup({ download: false });
        expect(METADATA_KEYS.ledger).toBe('mwt_ledger');
        expect(file.sections.ledger).toEqual({ schemaVersion: 2, data: ledger(470) });
        expect(file._meta.metadataSections).toContain('ledger');
        expect(validateBackupEnvelope(file).ok).toBe(true);
        delete meta.mwt_ledger;
        const result = await restoreBackup(file, { confirm: true });
        expect(result).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_ledger).toEqual(ledger(470));
        expect(meta.mwt_schema_manifest.sections.ledger).toBe(2);
        expect((await exportBackup({ download: false })).sections.ledger).toEqual(file.sections.ledger);
    });
    test('restores as a whole record, never adding balances or merging histories', () => {
        const file = buildBackupEnvelope({ identity, metadata: { ledger: ledger(50) } });
        const current = { ledger: ledger(470) };
        const replaced = planRestore(file, current, { currentIdentity: identity });
        expect(replaced.plan.sections.ledger).toEqual(ledger(50));
        const kept = planRestore(file, current, { currentIdentity: identity, modes: { ledger: 'keep' } });
        expect(kept.plan.sections.ledger).toBeUndefined();
        const unknown = planRestore(file, current, { currentIdentity: { isUnknown: true } });
        expect(unknown.plan.sections.ledger).toBeUndefined();
    });
    test('old exporter coverage cannot delete a ledger during exact restore', async () => {
        const meta = getFakeMeta();
        meta.mwt_ledger = ledger(470);
        const file = buildBackupEnvelope({ identity, metadata: {} });
        file._meta.metadataSections = file._meta.metadataSections.filter(name => name !== 'ledger');
        const preview = await restoreBackup(file, { exact: true });
        const result = await restoreBackup(file, { exact: true, confirm: true, previewToken: preview.preview.previewToken });
        expect(result).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_ledger).toEqual(ledger(470));
    });
    test('undo restores a replaced ledger', async () => {
        const meta = getFakeMeta();
        meta.mwt_ledger = ledger(470);
        const file = buildBackupEnvelope({ identity, metadata: { ledger: ledger(-40) } });
        expect(await restoreBackup(file, { confirm: true })).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_ledger).toEqual(ledger(-40));
        expect(await undoLastRestore({ confirm: true })).toMatchObject({ ok: true, committed: true });
        expect(meta.mwt_ledger).toEqual(ledger(470));
    });
    test('invalid readable data is preserved with a finding, never silently rewritten', () => {
        const invalid = ledger(0.5);
        const file = buildBackupEnvelope({ identity, metadata: { ledger: invalid } });
        const validation = validateBackupEnvelope(file);
        expect(validation.ok).toBe(true);
        expect(validation.sections.ledger).toEqual(invalid);
        expect(validateSectionWithIssues('ledger', invalid).issues.some(issue => issue.code === 'ledger-invalid')).toBe(true);
    });
});