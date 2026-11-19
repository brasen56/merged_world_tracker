/** @vitest-environment jsdom */
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import * as fake from './stubs/core.js';

import { createLedger } from '../ledger/data.js';
import { getLedger, saveLedger } from '../ledger/store.js';
import { initLedgerProposals, expireLedgerProposals } from '../ledger/proposals.js';
import { buildLedgerRefreshSnapshot, publishLedgerReport, LEDGER_SNAPSHOT_CHAR_LIMIT } from '../core/ledger_refresh.js';
import { cutLedgerReport, ledgerMessageDigest } from '../core/ledger_report.js';
import { normaliseOutput } from '../core/api.js';
import { getLedgerDiagnostics, _resetDiagnostics } from '../core/diagnostics.js';
import { captureScope, _resetEpoch, bumpEpoch } from '../core/scope.js';
import { _resetPausedStores, pauseStore } from '../core/schema_status.js';
import { refreshWorldState, refreshWorldStateDelta, getRecentMessagesForScan } from '../world_state/refresh.js';
import { state, getWorldStateText, setWorldStateData } from '../world_state/data.js';
import { buildRefreshStatusDelta } from '../world_state/delta.js';
import { saveSettings } from '../world_state/settings.js';

const evidence = 'She paid thirty gold coins to the smith.';
const line = { kind: 'money', currency: 'gold', amount: '-30', evidence };
const report = (body, row = line, tag = 'json') => `${body}\n\n\`\`\`${tag}\n${JSON.stringify(row)}\n\`\`\``;
const doc = '## Current Scene\nDate: March 4, 2026\nTime: 09:30\nLocation: The harbour\nPresent: Alex\nSituation: Waiting.\n\n## Recent Changes\n- The ship arrived.\n\n## Key Character States\n- **Alex**:\n  - Mood: calm';
let globals;
let requests;

beforeEach(() => {
    fake.resetCoreStubs();
    _resetEpoch();
    _resetPausedStores();
    _resetDiagnostics();
    globals = { enableLedger: true, ledgerProposals: true };
    fake.setFakeContextExtras({ globalSettings: globals });
    fake.setFakeChat(Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, name: 'Alex', mes: evidence })));
    vi.stubGlobal('SillyTavern', { getContext: () => ({ ...fake.getContextSafe(),
        extensionSettings: { merged_world_tracker: globals }, getCurrentChatId: () => 'phase6' }) });
    state.wstIsRefreshing = false;
    state.autoRefreshQueued = false;
    state.modal = null;
    saveSettings({ apiUrl: 'http://example.test', modelName: 'test', groundingEnabled: false });
    const ledger = createLedger();
    ledger.currencies.push({ id: 'gold', name: 'gold', decimals: 0, badge: true });
    saveLedger(ledger);
    initLedgerProposals();
    requests = [];
    fake.setFakeApi(async request => { requests.push(request); return report(doc); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    state.wstIsRefreshing = false;
    if (state.autoRefreshDeferTimer) clearTimeout(state.autoRefreshDeferTimer);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

test('cuts before REAL normalization; the JSON fence would otherwise replace the document', () => {
    expect(normaliseOutput(report(doc))).not.toContain('## Current Scene');
    expect(normaliseOutput(cutLedgerReport(report(doc)).text)).toBe(doc);
});

test('full refresh commits a clean document, freezes identities, and only persists pending proposals', async () => {
    expect(await refreshWorldState()).toBe(doc);
    expect(getWorldStateText()).toBe(doc);
    expect(getLedger().transactions).toEqual([]);
    expect(getLedger().proposals).toHaveLength(1);
    expect(getLedger().proposals[0]).toMatchObject({ status: 'pending', money: { amount: -30, currency: 'gold' }, msg: { identity: 'id:m0' } });
    expect(requests[0].userContent).toContain('Ledger snapshot');
    expect(getLedgerDiagnostics()).toMatchObject({ 'reports-seen': 1, 'lines-kept': 1, 'refreshes:with-report': 1 });
});

test('only the successful retry report is harvested; snapshot stays frozen across a ledger edit', async () => {
    fake.setFakeApi(async request => {
        requests.push(request);
        if (requests.length === 1) {
            const ledger = getLedger();
            ledger.items.push({ id: 'rope', name: 'NEW MID-CALL ITEM', qty: 1, carried: true, note: '' });
            saveLedger(ledger);
            return report('bad document', { ...line, amount: '-99' });
        }
        return report(doc);
    });
    await refreshWorldState();
    expect(requests).toHaveLength(2);
    expect(requests[1].userContent).not.toContain('NEW MID-CALL ITEM');
    expect(getLedger().proposals.map(row => row.money.amount)).toEqual([-30]);
    expect(getLedgerDiagnostics()['validation-failures:with-report']).toBe(1);
});

test('failed refresh harvests nothing', async () => {
    fake.setFakeApi(async () => report('bad document'));
    await expect(refreshWorldState()).rejects.toThrow(/rejected/i);
    expect(getLedger().proposals).toEqual([]);
});

test('scope switch during generation discards both the document and proposals', async () => {
    fake.setFakeApi(async () => { bumpEpoch(); return report(doc); });
    expect(await refreshWorldState()).toBeNull();
    expect(getLedger().proposals).toEqual([]);
});

test.each(['enableLedger', 'ledgerProposals'])('closed %s gate adds no prompt tokens and ignores unsolicited reports', async key => {
    globals[key] = false;
    expect(buildLedgerRefreshSnapshot()).toBe('');
    await refreshWorldState();
    expect(requests[0].userContent).not.toContain('Ledger snapshot');
    expect(requests[0].systemPrompt).not.toContain('mwt-ledger-report');
    expect(getLedger().proposals).toEqual([]);
    expect(getWorldStateText()).toBe(doc);
});

test('delta NO CHANGES and patch output both harvest only after their commit', async () => {
    await refreshWorldState();
    fake.setFakeChat([...fake.getChat(), { id: 'new', name: 'Alex', mes: evidence }, { id: 'tail', mes: 'tail' }]);
    fake.setFakeApi(async () => report('### NO CHANGES', { ...line, amount: '-20' }));
    expect(await refreshWorldStateDelta()).toBe(doc);
    expect(getLedger().proposals).toHaveLength(2);
    fake.setFakeChat([...fake.getChat(), { id: 'next', name: 'Alex', mes: evidence }, { id: 'tail2', mes: 'tail' }]);
    fake.setFakeApi(async () => report('### REMOVE: Recent Changes', { ...line, amount: '-10' }));
    expect(await refreshWorldStateDelta()).not.toContain('## Recent Changes');
    expect(getLedger().proposals).toHaveLength(3);
});

test('a refused listener write never turns a committed refresh into a failure', async () => {
    const broken = new CustomEvent('mwt:ledger-report', { detail: { scope: captureScope(), chatId: 'chat:phase6', lines: null, records: [] } });
    expect(() => document.dispatchEvent(broken)).not.toThrow();
    expect(getLedgerDiagnostics()['harvest-refused']).toBe(1);
    expect(await refreshWorldState()).toBe(doc);
});

test('a paused Ledger refuses the post-commit handoff without failing World State', async () => {
    const refuse = () => pauseStore('ledger', { message: 'test refusal' });
    document.addEventListener('mwt:ledger-report', refuse, { capture: true, once: true });
    expect(await refreshWorldState()).toBe(doc);
    expect(getLedger().proposals).toEqual([]);
    expect(getLedgerDiagnostics()['harvest-refused']).toBe(1);
});

test('a refused World State commit harvests nothing', async () => {
    fake.setFakeApi(async () => { pauseStore('worldState', { message: 'test refusal' }); return report(doc); });
    expect(await refreshWorldState()).toBeNull();
    expect(getLedger().proposals).toEqual([]);
});

test('catch-up chunks carry their own records and only harvest committed passes', async () => {
    saveSettings({ deltaMode: true, maxScanMessages: 2 });
    setWorldStateData({ text: doc, deltaStatus: buildRefreshStatusDelta('full', doc, {}, 0, 'detailed') });
    fake.setFakeChat(Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, name: 'Alex', mes: `${evidence} ${'x'.repeat(11000)}` })));
    expect(await refreshWorldState()).toBe(doc);
    const proposals = getLedger().proposals;
    expect(proposals.map(row => row.msg.identity)).toEqual(['id:m0', 'id:m1', 'id:m2', 'id:m3']);
});

test.each(['absent', 'empty', 'invalid', 'paused', 'future'])('unhealthy or %s ledger adds no request', kind => {
    const meta = fake.getChatMeta();
    if (kind === 'absent') delete meta.mwt_ledger;
    if (kind === 'empty') meta.mwt_ledger = createLedger();
    if (kind === 'invalid') meta.mwt_ledger.currencies = 'bad';
    if (kind === 'paused') pauseStore('ledger', { message: 'test' });
    if (kind === 'future') meta.mwt_ledger.version = 99;
    expect(buildLedgerRefreshSnapshot()).toBe('');
});

test('expiry removes missing-source rows, caps tombstones, and preserves malformed audit rows', async () => {
    const ledger = getLedger();
    const draft = { kind: 'money', money: { currency: 'gold', amount: -1 }, evidence,
        msg: { identity: 'id:m0', digest: ledgerMessageDigest(evidence) }, status: 'accepted' };
    ledger.proposals = Array.from({ length: 305 }, (_, i) => ({ ...draft, id: `p${i}` }));
    ledger.proposals.push({ ...draft, id: 'gone', msg: { ...draft.msg, identity: 'id:gone' } }, { broken: true });
    saveLedger(ledger);
    await expireLedgerProposals();
    expect(getLedger().proposals).toHaveLength(301);
    expect(getLedger().proposals[0].id).toBe('p5');
    expect(getLedger().proposals.at(-1)).toEqual({ broken: true });
});

test('snapshot bounds and filtered window records cover only supplied evidence', () => {
    const ledger = getLedger();
    ledger.items = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, name: `Item ${i}`, qty: 1, carried: true, note: '' }));
    saveLedger(ledger);
    const snapshot = buildLedgerRefreshSnapshot();
    expect(snapshot).toContain('10 more item names');
    expect(snapshot.length).toBeLessThanOrEqual(LEDGER_SNAPSHOT_CHAR_LIMIT);
    expect(getRecentMessagesForScan({ withRecords: true }).records.map(row => row.index)).toEqual([0, 1, 2, 3]);
});

test.each(['pending', 'accepted', 'rejected'])('expiry preserves %s history until sparse slots hydrate', async status => {
    const ledger = getLedger();
    ledger.proposals = ['m0', 'm1', 'gone'].map(id => ({ id, kind: 'money',
        money: { currency: 'gold', amount: -1 }, evidence,
        msg: { identity: `id:${id}`, digest: ledgerMessageDigest(evidence) }, status }));
    saveLedger(ledger);
    delete fake.getChat()[0];
    fake.getChat()[1] = undefined;
    await expireLedgerProposals();
    expect(getLedger().proposals.map(row => row.id)).toEqual(['m0', 'm1', 'gone']);
    fake.getChat()[0] = { id: 'm0', mes: evidence };
    fake.getChat()[1] = { id: 'm1', mes: evidence };
    await expireLedgerProposals();
    expect(getLedger().proposals.map(row => row.id)).toEqual(['m0', 'm1']);
});

test('sparse history still caps tombstones without expiring pending proposals', async () => {
    const ledger = getLedger();
    const draft = { kind: 'money', money: { currency: 'gold', amount: -1 }, evidence,
        msg: { identity: 'id:unloaded', digest: ledgerMessageDigest(evidence) } };
    ledger.proposals = Array.from({ length: 305 }, (_, index) => ({ ...draft, id: `p${index}`, status: 'rejected' }));
    ledger.proposals.push({ ...draft, id: 'pending', status: 'pending' });
    saveLedger(ledger);
    delete fake.getChat()[0];
    await expireLedgerProposals();
    expect(getLedger().proposals).toHaveLength(301);
    expect(getLedger().proposals[0].id).toBe('p5');
    expect(getLedger().proposals.at(-1).id).toBe('pending');
});

test('expiry cannot act on another scope after awaiting hydration', async () => {
    const ledger = getLedger();
    ledger.proposals = [{ id: 'gone', kind: 'money', money: { currency: 'gold', amount: -1 }, evidence,
        msg: { identity: 'id:gone', digest: ledgerMessageDigest(evidence) }, status: 'pending' }];
    saveLedger(ledger);
    const expiry = expireLedgerProposals();
    bumpEpoch();
    await expiry;
    expect(getLedger().proposals).toHaveLength(1);
});

test('regex-filtered evidence is not harvested even though it remains in raw messages', async () => {
    saveSettings({ messageFilter: 'She paid thirty gold coins to the smith\\.' });
    fake.getChat().forEach(message => { message.mes = `${evidence} She walked home afterward.`; });
    await refreshWorldState();
    expect(requests[0].userContent).not.toContain(evidence);
    expect(getLedger().proposals).toEqual([]);
    expect(getLedgerDiagnostics()['dropped:evidence']).toBe(1);
});

test.each(['added quote', 'retained quote'])('mid-flight edits cannot supply a new digest: %s', async kind => {
    const original = kind === 'added quote' ? 'She walked home afterward.' : evidence;
    fake.getChat().forEach(message => { message.mes = original; });
    const records = getRecentMessagesForScan({ withRecords: true }).records;
    fake.setFakeApi(async () => {
        fake.getChat().forEach(message => { message.mes = `${evidence} Added during generation.`; });
        return report(doc);
    });
    await refreshWorldState();
    expect(getLedger().proposals).toEqual([]);
    expect(records.every(row => row.digest === ledgerMessageDigest(original))).toBe(true);
    expect(records.every(row => row.text === original && Object.isFrozen(row))).toBe(true);
});

test.each([true, false])('oversized catch-up grounds only the supplied prefix (quote supplied: %s)', async supplied => {
    saveSettings({ deltaMode: true, maxScanMessages: 2 });
    setWorldStateData({ text: doc, deltaStatus: buildRefreshStatusDelta('full', doc, {}, 0, 'detailed') });
    const raw = supplied ? `${evidence} ${'x'.repeat(21000)}` : `${'x'.repeat(21000)} ${evidence}`;
    fake.setFakeChat([{ id: 'big', name: 'Alex', mes: raw }, { id: 'next1', mes: 'She walked home.' },
        { id: 'next2', mes: 'She went to sleep.' }, { id: 'tail1', mes: 'tail' }, { id: 'tail2', mes: 'tail' }]);
    await refreshWorldState();
    expect(requests[0].userContent).toContain('leading portion only');
    expect(requests[0].userContent.includes(evidence)).toBe(supplied);
    expect(getLedger().proposals).toHaveLength(supplied ? 1 : 0);
    if (supplied) expect(getLedger().proposals[0].msg.digest).toBe(ledgerMessageDigest(raw));
});

test('handoff refuses a stale scope without dispatch', () => {
    const scope = captureScope();
    bumpEpoch();
    const spy = vi.spyOn(document, 'dispatchEvent');
    publishLedgerReport(cutLedgerReport(report(doc)), [], scope, true);
    expect(spy).not.toHaveBeenCalled();
});

test('write-time evidence and currency resolution drop changed or ambiguous claims with counters', async () => {
    fake.setFakeApi(async () => {
        fake.getChat().forEach(message => { message.mes = 'Nobody paid anything.'; });
        return report(doc);
    });
    await refreshWorldState();
    expect(getLedger().proposals).toEqual([]);
    expect(getLedgerDiagnostics()['dropped:evidence']).toBe(1);
    fake.getChat().forEach(message => { message.mes = evidence; });
    fake.setFakeApi(async () => {
        const ledger = getLedger();
        ledger.currencies.push({ id: 'other-gold', name: 'GOLD', decimals: 0, badge: false });
        saveLedger(ledger);
        return report(doc);
    });
    await refreshWorldState();
    expect(getLedger().proposals).toEqual([]);
    expect(getLedgerDiagnostics()['dropped:currency-ambiguous']).toBe(1);
});

test('malformed lines do not poison neighbors; overlapping full refreshes dedupe across harvests', async () => {
    fake.setFakeApi(async () => `${doc}\n\n\`\`\`mwt-ledger-report\nnot JSON\n${JSON.stringify(line)}\n\`\`\``);
    await refreshWorldState();
    await refreshWorldState();
    expect(getLedger().proposals).toHaveLength(1);
    expect(getLedgerDiagnostics()).toMatchObject({ 'dropped:parse': 2, 'dropped:duplicate': 1, 'lines-kept': 1 });
});