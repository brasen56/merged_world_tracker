/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLedger, computeBalances, computeDebts, validateLedgerAudit, ITEM_LOG_LIMIT } from '../ledger/data.js';
import { getLedger, saveLedger } from '../ledger/store.js';
import { decideLedgerProposals, proposalSource } from '../ledger/proposals.js';
import { renderLedger, wireLedger } from '../ledger/render.js';
import { getStatus } from '../ledger/status.js';
import { ledgerMessageDigest, resolveLedgerReport } from '../core/ledger_report.js';
import { captureScope, bumpEpoch } from '../core/scope.js';
import { _resetPausedStores, pauseStore } from '../core/schema_status.js';
import { createFloatingButtonBar } from '../core/ui.js';

let ctx;
let confirmDelete;
const gold = { id: 'gold', name: 'gold', decimals: 0, badge: true };
const evidence = 'She handed Aldric thirty gold and picked up a rope.';
const proposal = (id = 'p1', extra = {}) => ({ id, kind: 'money', money: { currency: 'gold', amount: -30 },
    counterparty: 'Aldric', evidence, msg: { identity: 'id:source', digest: ledgerMessageDigest(evidence) },
    status: 'pending', harvest: 'h1', ...extra });
const itemProposal = (id, qtyChange, name = 'Rope', extra = {}) => proposal(id, { kind: 'item', item: { name, qtyChange }, ...extra });
const item = { id: 'rope', name: 'Rope', qty: 2, carried: true, note: '' };
function seed(proposals = [proposal()], extra = {}) {
    saveLedger({ ...createLedger(), currencies: [gold], transactions: [{ id: 'opening', currency: 'gold', amount: 50, kind: 'entry', note: '', date: null }], proposals, ...extra });
}
function mount() {
    document.body.innerHTML = `<button id="mwt-tab-ledger">Ledger</button><div id="root">${renderLedger()}</div>`;
    wireLedger(document.getElementById('root'), { confirmDelete });
}
function action(name, within = document) { within.querySelector(`[data-ledger-action="${name}"]`).click(); }
const status = () => document.querySelector('.mwt-ledger-status').textContent;
const inboxRow = id => document.querySelector(`[data-proposal="${id}"]`);

beforeEach(() => {
    _resetPausedStores();
    ctx = { chatId: 'phase7', chat: [{ id: 'source', mes: evidence }], chatMetadata: {},
        extensionSettings: { merged_world_tracker: {} }, saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
    confirmDelete = vi.fn(() => true);
});
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each(['accept-proposal', 'reject-proposal', 'accept-harvest', 'reject-harvest'])('%s preserves unrelated editor drafts', actionName => {
    seed(); mount();
    const transaction = document.querySelector('form[data-ledger-form="transaction"]:not([data-id])');
    const inventory = document.querySelector('form[data-ledger-form="item"]:not([data-id])');
    transaction.elements.namedItem('amount').value = '17';
    inventory.elements.namedItem('name').value = 'Unsaved pack';
    action(actionName);
    expect(transaction.isConnected).toBe(true);
    expect(inventory.isConnected).toBe(true);
    expect(transaction.elements.namedItem('amount').value).toBe('17');
    expect(inventory.elements.namedItem('name').value).toBe('Unsaved pack');
    expect(document.querySelector('[data-ledger-reload]') !== null).toBe(actionName.startsWith('accept'));
    expect(inboxRow('p1')).toBeNull();
});

test.each([undefined, true, false])('resolved picker suggestions preserve omitted carried (%s) until creation', carried => {
    seed([], { items: [{ ...item, carried: false }] });
    const ledger = getLedger();
    const line = { kind: 'item', name: 'Coiled rope', qtyChange: '1', evidence,
        ...(carried !== undefined ? { carried } : {}) };
    const resolved = resolveLedgerReport([line], { ledger, chat: ctx.chat,
        records: [{ index: 0, identity: 'id:source', text: evidence, digest: ledgerMessageDigest(evidence) }] });
    ledger.proposals = [{ id: 'p1', ...resolved.proposals[0] }];
    saveLedger(ledger); mount();
    inboxRow('p1').querySelector('[data-item-target]').value = 'rope';
    action('accept-proposal');
    expect(getLedger().items[0]).toMatchObject({ qty: 3, carried: carried ?? false });
    seed([itemProposal('new', 1, 'New rope')]);
    decideLedgerProposals(['new'], 'accepted');
    expect(getLedger().items[0].carried).toBe(true);
});

test('single acceptance writes player-signed money and source exactly once; rejection only tombstones', () => {
    seed([proposal(), proposal('p2', { money: { currency: 'gold', amount: 10 } })]);
    expect(decideLedgerProposals(['p1'], 'accepted')).toBe(true);
    expect(getLedger().transactions.at(-1)).toMatchObject({ amount: -30, counterparty: 'Aldric', source: 'p1', kind: 'entry' });
    expect(computeBalances(getLedger()).get('gold')).toBe(20);
    expect(() => decideLedgerProposals(['p1'], 'accepted')).toThrow(/changed/);
    decideLedgerProposals(['p2'], 'rejected');
    expect(getLedger().transactions).toHaveLength(2);
    expect(getLedger().proposals.map(row => row.status)).toEqual(['accepted', 'rejected']);
});

test('an overdraft batch is atomic; shortfall loan counts once and zeroes the purse', () => {
    seed([proposal(), proposal('p2')]);
    const before = getLedger();
    expect(() => decideLedgerProposals(['p1', 'p2'], 'accepted')).toThrow(/overdraft/);
    expect(getLedger()).toEqual(before);
    decideLedgerProposals(['p1', 'p2'], 'accepted', { choices: { p2: 'owed' } });
    expect(computeBalances(getLedger()).get('gold')).toBe(0);
    expect(computeDebts(getLedger())).toEqual([{ currency: 'gold', counterparty: 'Aldric', amount: 10 }]);
    expect(getLedger().transactions.at(-1)).toMatchObject({ source: 'p2', loan: true, amount: 10 });
});

test('negative balance option creates no synthetic debt; a loan cannot be counted again as a shortfall', () => {
    seed([proposal('p1', { money: { currency: 'gold', amount: -70 } })]);
    decideLedgerProposals(['p1'], 'accepted', { choices: { p1: 'accept' } });
    expect(computeBalances(getLedger()).get('gold')).toBe(-20);
    expect(computeDebts(getLedger())).toEqual([]);
    seed([proposal('p1', { money: { currency: 'gold', amount: -70, loan: true } })]);
    expect(() => decideLedgerProposals(['p1'], 'accepted', { choices: { p1: 'owed' } })).toThrow(/non-loan/);
    expect(getLedger().proposals[0].status).toBe('pending');
});

test.each([undefined, 'accept', 'owed'])('receipts reduce an existing overdraft without review or synthetic debt (choice: %s)', choice => {
    seed([proposal('p1', { money: { currency: 'gold', amount: 5 } })], {
        transactions: [{ id: 'opening', currency: 'gold', amount: -20, kind: 'entry', note: '', date: null }],
    });
    expect(decideLedgerProposals(['p1'], 'accepted', { choices: { p1: choice } })).toBe(true);
    expect(computeBalances(getLedger()).get('gold')).toBe(-15);
    expect(computeDebts(getLedger())).toEqual([]);
    expect(getLedger().transactions).toHaveLength(2);
    expect(getLedger().transactions.at(-1)).toMatchObject({ amount: 5, counterparty: 'Aldric', source: 'p1' });
    expect(getLedger().proposals[0].status).toBe('accepted');
});

test('source identity resolves its live index; swipe badges clear on return; changed accepts need confirmation', () => {
    seed();
    ctx.chat.unshift({ id: 'earlier', mes: 'Earlier.' });
    expect(proposalSource(proposal()).index).toBe(1);
    ctx.chat[1].mes = 'Nobody paid.';
    expect(proposalSource(proposal()).changed).toBe(true);
    expect(decideLedgerProposals(['p1'], 'accepted')).toBe(false);
    decideLedgerProposals(['p1'], 'accepted', { confirmSourceChange: () => true });
    expect(renderLedger()).toContain('source changed after accept');
    ctx.chat[1].mes = evidence;
    expect(renderLedger()).not.toContain('source changed after accept');
});

test('missing sources, stale scopes, changed data during confirmation and paused stores refuse without partial writes', () => {
    seed();
    ctx.chat = [];
    expect(() => decideLedgerProposals(['p1'], 'accepted')).toThrow(/unavailable/);
    ctx.chat = [{ id: 'source', mes: 'Changed' }];
    expect(() => decideLedgerProposals(['p1'], 'accepted', { confirmSourceChange: () => {
        const ledger = getLedger(); ledger.transactions[0].note = 'Newer edit'; saveLedger(ledger); return true;
    } })).toThrow(/changed/);
    expect(getLedger().transactions).toHaveLength(1);
    const scope = captureScope(); bumpEpoch();
    expect(() => decideLedgerProposals(['p1'], 'rejected', { scope })).toThrow(/Chat changed/);
    pauseStore('ledger', { reason: 'future-version' });
    expect(() => decideLedgerProposals(['p1'], 'rejected')).toThrow(/paused/);
    expect(getLedger().proposals[0].status).toBe('pending');
});

test('item picker merges mismatched names and proposal logs are attributed; zero quantity requires confirmation', () => {
    seed([itemProposal('p1', 1, 'rope (50 ft)'), itemProposal('p2', -3)], { items: [item] });
    decideLedgerProposals(['p1'], 'accepted', { itemTargets: { p1: 'rope' } });
    expect(getLedger().items).toHaveLength(1);
    expect(getLedger().items[0].qty).toBe(3);
    expect(getLedger().itemLog.at(-1)).toMatchObject({ name: 'Rope', change: 'qty', source: 'p1', detail: '2 → 3' });
    expect(decideLedgerProposals(['p2'], 'accepted')).toBe(false);
    expect(getLedger().items).toHaveLength(1);
    decideLedgerProposals(['p2'], 'accepted', { confirmRemoval: () => true });
    expect(getLedger().items).toEqual([]);
    expect(getLedger().itemLog.at(-1)).toMatchObject({ change: 'removed', source: 'p2' });
});

test('new item defaults Carried, respects Stored, and quantity overflow refuses atomically', () => {
    seed([itemProposal('p1', 1), itemProposal('p2', 2, 'Sword', { item: { name: 'Sword', qtyChange: 2, carried: false } })]);
    decideLedgerProposals(['p1', 'p2'], 'accepted');
    expect(getLedger().items.map(row => row.carried)).toEqual([true, false]);
    expect(getLedger().itemLog.map(row => row.source)).toEqual(['p1', 'p2']);
    seed([itemProposal('p1', 1)], { items: [{ ...item, qty: Number.MAX_SAFE_INTEGER }] });
    expect(() => decideLedgerProposals(['p1'], 'accepted')).toThrow(/safe integer/);
    expect(getLedger().proposals[0].status).toBe('pending');
});

test('store logs all manual item paths, keeps audit junk nonblocking and trims with an honest marker', () => {
    seed([], { items: [item], itemLog: [null] });
    let ledger = getLedger();
    Object.assign(ledger.items[0], { qty: 3, note: 'cut', carried: false, pinned: true, where: 'Inn' });
    saveLedger(ledger);
    expect(validateLedgerAudit(getLedger()).itemLog.map(row => row.change)).toEqual(['added', 'qty', 'note', 'carried', 'edited', 'edited']);
    for (let n = 0; n < ITEM_LOG_LIMIT; n++) {
        ledger = getLedger(); ledger.items[0].qty++; saveLedger(ledger);
    }
    expect(getLedger().itemLog[0]).toBeNull();
    expect(validateLedgerAudit(getLedger()).itemLog).toHaveLength(ITEM_LOG_LIMIT);
    expect(getLedger().itemLogTrimmed).toBe(true);
    expect(renderLedger()).toContain('…older changes trimmed');
    ledger = getLedger(); ledger.items = []; saveLedger(ledger);
    expect(getLedger().itemLog.at(-1).change).toBe('removed');
});

test('UI per-harvest actions do not consume other harvests; inbox live updates preserve drafts', () => {
    seed([proposal(), proposal('p2', { money: { currency: 'gold', amount: 5 } }), proposal('p3', { harvest: 'h2' })]);
    mount();
    expect(getStatus().pending).toBe(3);
    expect(document.getElementById('mwt-tab-ledger').textContent).toContain('(3)');
    const note = document.querySelector('form:not([data-id]) textarea');
    note.value = 'Unsaved draft';
    document.dispatchEvent(new CustomEvent('mwt:ledger-proposals-changed'));
    expect(note.value).toBe('Unsaved draft');
    action('accept-harvest');
    expect(getLedger().proposals.map(row => row.status)).toEqual(['accepted', 'accepted', 'pending']);
    expect(inboxRow('p3')).not.toBeNull();
    action('reject-proposal', inboxRow('p3'));
    expect(getStatus().pending).toBe(0);
});

test.each(['accept-proposal', 'accept-harvest'])('inbox refresh preserves item targets by proposal ID before %s', acceptAction => {
    seed([itemProposal('p1', 1, 'rope (50 ft)'), itemProposal('p2', 1, 'Coiled rope')], { items: [item] });
    mount();
    inboxRow('p1').querySelector('[data-item-target]').value = 'rope';
    const ledger = getLedger();
    ledger.proposals.unshift(itemProposal('p3', 1, 'New rope', { harvest: 'h2' }));
    saveLedger(ledger);
    document.dispatchEvent(new CustomEvent('mwt:ledger-proposals-changed'));
    expect(inboxRow('p1').querySelector('[data-item-target]').value).toBe('rope');
    expect(inboxRow('p2').querySelector('[data-item-target]').value).toBe('');
    expect(inboxRow('p3').querySelector('[data-item-target]').value).toBe('');
    action(acceptAction, acceptAction === 'accept-proposal' ? inboxRow('p1') : inboxRow('p1').closest('[data-harvest]'));
    expect(getLedger().items.find(row => row.id === 'rope').qty).toBe(3);
    expect(getLedger().items.some(row => row.name === 'rope (50 ft)')).toBe(false);
    expect(getLedger().proposals.find(row => row.id === 'p1').status).toBe('accepted');
    expect(getLedger().proposals.find(row => row.id === 'p3').status).toBe('pending');
});

test('inbox refresh drops an item target when the selected item no longer exists', () => {
    seed([itemProposal('p1', 1, 'rope (50 ft)')], { items: [item] });
    mount();
    inboxRow('p1').querySelector('[data-item-target]').value = 'rope';
    const ledger = getLedger();
    ledger.items = [];
    saveLedger(ledger);
    document.dispatchEvent(new CustomEvent('mwt:ledger-proposals-changed'));
    const picker = inboxRow('p1').querySelector('[data-item-target]');
    expect(picker.value).toBe('');
    expect(picker.selectedOptions[0].textContent).toBe('Create new item');
});

test('UI overdraft dialog supports cancel, negative balance, and shortfall loan', () => {
    seed([proposal('p1', { money: { currency: 'gold', amount: -70 } })]); mount();
    action('accept-proposal');
    expect(document.querySelector('[role="dialog"]').textContent).toContain('20 gold');
    action('overdraft-cancel');
    expect(getLedger().proposals[0].status).toBe('pending');
    action('accept-proposal'); action('overdraft-owed');
    expect(computeBalances(getLedger()).get('gold')).toBe(0);
    expect(document.querySelector('.mwt-ledger').textContent).toContain('You owe Aldric 20 gold');
    seed([proposal('p1', { money: { currency: 'gold', amount: -70 } })]); mount();
    action('accept-proposal'); action('overdraft-accept');
    expect(computeBalances(getLedger()).get('gold')).toBe(-20);
});

test.each(['overdraft-owed', 'overdraft-accept'])('UI reconfirms changed shortfalls before %s', choice => {
    seed([proposal('p1', { money: { currency: 'gold', amount: -70 } }),
        proposal('p2', { money: { currency: 'gold', amount: -10 } })]);
    mount();
    action('accept-proposal', inboxRow('p1'));
    expect(document.querySelector('[data-ledger-overdraft]').textContent).toContain('20 gold');
    action('accept-proposal', inboxRow('p2'));
    action(choice);
    expect(getLedger().proposals.find(row => row.id === 'p1').status).toBe('pending');
    expect(computeBalances(getLedger()).get('gold')).toBe(40);
    expect(document.querySelector('[data-ledger-overdraft]').textContent).toContain('30 gold');
    action(choice);
    expect(getLedger().proposals.find(row => row.id === 'p1').status).toBe('accepted');
    expect(computeBalances(getLedger()).get('gold')).toBe(choice === 'overdraft-owed' ? 0 : -30);
    expect(computeDebts(getLedger())).toEqual(choice === 'overdraft-owed'
        ? [expect.objectContaining({ amount: 30 })] : []);
});

test('UI picker and item pin/location fields persist with history drill-down and safe escaping', () => {
    seed([itemProposal('p1', 1, '<Rope>')], { items: [item] }); mount();
    inboxRow('p1').querySelector('[data-item-target]').value = 'rope';
    action('accept-proposal', inboxRow('p1'));
    const form = document.querySelector('form[data-ledger-form="item"][data-id="rope"]');
    form.elements.namedItem('pinned').checked = true;
    form.elements.namedItem('where').value = '<Inn chest>';
    form.elements.namedItem('carried').value = 'false';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(getLedger().items[0]).toMatchObject({ qty: 3, pinned: true, where: '<Inn chest>', carried: false });
    expect(document.querySelector('inn')).toBeNull();
    expect(document.querySelector('[data-ledger-open-key="item:rope"]').textContent).toContain('History');
    expect(getLedger().itemLog.at(-1).source).toBe('user');
});

test('UI loan checkbox validates a counterparty and repayments settle debts without treating purchases as loans', () => {
    seed([]); mount();
    const enter = (amount, sign, counterparty, loan) => {
        const form = document.querySelector('form[data-ledger-form="transaction"]:not([data-id])');
        for (const [name, value] of Object.entries({ amount, sign, counterparty })) form.elements.namedItem(name).value = value;
        form.elements.namedItem('loan').checked = loan;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    enter('10', '+', '', true);
    expect(status()).toContain('Loans require a counterparty');
    enter('10', '+', 'Aldric', true);
    expect(computeDebts(getLedger())[0].amount).toBe(10);
    enter('10', '-', 'Aldric', true);
    expect(computeDebts(getLedger())).toEqual([]);
    enter('5', '-', 'Merchant', false);
    expect(computeDebts(getLedger())).toEqual([]);
});

test('accept revalidates currency, audit rows and the latest inventory rather than trusting the prompt snapshot', () => {
    seed([proposal(), null]);
    const ledger = getLedger(); ledger.transactions = []; ledger.currencies = []; saveLedger(ledger);
    expect(() => decideLedgerProposals(['p1'], 'accepted')).toThrow(/currency no longer exists/);
    expect(() => decideLedgerProposals(['bad'], 'rejected')).toThrow(/changed/);
    decideLedgerProposals(['p1'], 'rejected');
    expect(getLedger().proposals[1]).toBeNull();
});

test('UI rescaling currency precision also rescales pending proposal amounts exactly', () => {
    seed(); mount();
    const form = document.querySelector('form[data-ledger-form="currency"][data-id="gold"]');
    form.elements.namedItem('decimals').value = '2';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(getLedger().proposals[0].money.amount).toBe(-3000);
    action('accept-proposal');
    expect(computeBalances(getLedger()).get('gold')).toBe(2000);
});

test.each([-10, 0, 10])('shortfall loan covers only this payment with opening balance %i', opening => {
    seed([proposal()], { transactions: [{ id: 'opening', currency: 'gold', amount: opening, kind: 'entry', note: '', date: null }] });
    const shortfall = String(Math.min(30, 30 - opening));
    try {
        decideLedgerProposals(['p1'], 'accepted');
        throw new Error('Expected overdraft review');
    } catch (error) {
        expect(error.overdraft.shortfall).toBe(shortfall);
    }
    decideLedgerProposals(['p1'], 'accepted', { choices: { p1: { decision: 'owed', shortfall } } });
    expect(computeDebts(getLedger())).toEqual([{ currency: 'gold', counterparty: 'Aldric', amount: Number(shortfall) }]);
    expect(computeBalances(getLedger()).get('gold')).toBe(Math.min(opening, 0));
});

test.each(['accepted', 'rejected'])('fractional %s receipts do not block currency precision changes', resolvedStatus => {
    seed([proposal('p1', { status: resolvedStatus, money: { currency: 'gold', amount: -1250 } })],
        { currencies: [{ ...gold, decimals: 2 }], transactions: [] });
    mount();
    const changePrecision = decimals => {
        const form = document.querySelector('form[data-ledger-form="currency"][data-id="gold"]');
        form.elements.namedItem('decimals').value = String(decimals);
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    changePrecision(0);
    expect(getLedger().currencies[0].decimals).toBe(0);
    expect(getLedger().proposals[0].money).toEqual({ currency: 'gold', amount: -1250, decimals: 2 });
    changePrecision(3);
    expect(getLedger().currencies[0].decimals).toBe(3);
    expect(getLedger().proposals[0].money).toEqual({ currency: 'gold', amount: -1250, decimals: 2 });
    expect(validateLedgerAudit(getLedger()).valid).toBe(true);
});

test('fractional pending suggestions still refuse lossy precision changes atomically', () => {
    seed([proposal('p1', { money: { currency: 'gold', amount: -1250 } })],
        { currencies: [{ ...gold, decimals: 2 }], transactions: [] });
    mount();
    const before = getLedger();
    const form = document.querySelector('form[data-ledger-form="currency"][data-id="gold"]');
    form.elements.namedItem('decimals').value = '0';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(getLedger()).toEqual(before);
    expect(status()).toContain('fractional digits');
});

test.each(['modern', 'classic'])('pending badges supplement rather than replace money (%s)', buttonStyle => {
    seed(); mount();
    const bar = createFloatingButtonBar({ getSettings: () => ({ buttonStyle }), saveSettings: vi.fn(), openModal: vi.fn(),
        modules: { WorldState: {}, Chronicle: {}, Knowledge: {}, StoryPlanner: {}, Interiority: {}, Ledger: { getStatus } } });
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    bar.setupButtonBar(); bar.updateFloatTokenCounts();
    const floating = document.getElementById('mwt-float-ledger');
    expect(floating.querySelector('.mwt-float-btn-countdown').textContent).toBe('50');
    expect(floating.querySelector('.mwt-ledger-pending-badge').textContent).toBe('1');
    expect(floating.title).toContain('1 pending suggestions');
    expect(document.getElementById('mwt-tab-ledger').textContent).toContain('(1)');
    decideLedgerProposals(['p1'], 'rejected'); bar.updateFloatTokenCounts();
    expect(floating.querySelector('.mwt-ledger-pending-badge').hidden).toBe(true);
    expect(floating.querySelector('.mwt-float-btn-countdown').textContent).toBe('50');
    expect(document.getElementById('mwt-tab-ledger').textContent).toBe('Ledger');
});