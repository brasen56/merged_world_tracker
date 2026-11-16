/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderLedger, wireLedger } from '../ledger/render.js';
import { createLedger } from '../ledger/data.js';
import { getLedger, saveLedger } from '../ledger/store.js';
import { getStatus } from '../ledger/status.js';
import { createFloatingButtonBar } from '../core/ui.js';
import { bumpEpoch } from '../core/scope.js';
import { _resetPausedStores } from '../core/schema_status.js';
import { renderOverviewSnapshot } from '../dashboard/render.js';

let ctx;
let confirmDelete;
let options;
const currency = { id: 'gold', name: 'gold', decimals: 2, badge: true };
function mount(record) {
    if (record) saveLedger(record);
    document.body.innerHTML = `<div id="root">${renderLedger()}</div>`;
    wireLedger(document.getElementById('root'), options);
}
const form = (type, id = '') => document.querySelector(`form[data-ledger-form="${type}"]${id ? `[data-id="${id}"]` : ':not([data-id])'}`);
function fill(target, fields) {
    for (const [name, value] of Object.entries(fields)) {
        const control = target.elements.namedItem(name);
        if (control.type === 'checkbox') control.checked = value;
        else control.value = value;
    }
}
const submit = target => target.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const click = (target, action) => target.querySelector(`[data-ledger-action="${action}"]`).click();
const message = () => document.querySelector('.mwt-ledger-status').textContent;

beforeEach(() => {
    _resetPausedStores();
    ctx = { chatId: 'ledger-ui', chat: [], chatMetadata: {}, extensionSettings: { merged_world_tracker: {} },
        saveMetadataDebounced: vi.fn(), saveSettingsDebounced: vi.fn(), setExtensionPrompt: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
    confirmDelete = vi.fn(() => true);
    options = { confirmDelete, getSettings: () => ctx.extensionSettings.merged_world_tracker,
        saveSettings: vi.fn(patch => Object.assign(ctx.extensionSettings.merged_world_tracker, patch)), onChanged: vi.fn() };
});
afterEach(() => { document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('empty rendering is non-mutating, accessible, and every text/select control uses the MWT theme', () => {
    mount();
    expect(getLedger()).toBeNull();
    expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    for (const control of document.querySelectorAll('textarea, select, input:not([type="checkbox"])')) expect(control.classList.contains('mwt-input')).toBe(true);
    const tabs = document.querySelectorAll('[role="tab"]');
    tabs[1].click();
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[data-tab="finances"][role="tabpanel"]').hidden).toBe(true);
    const css = readFileSync('ledger/style.css', 'utf8');
    expect(css).toContain('.mwt-ledger .mwt-input');
    expect(css).toContain('background: var(--mwt-bg-light)');
    expect(css).toContain('color: var(--mwt-text)');
    // jsdom can't paint: pin the rules that make the selection and options visible.
    expect(css).toMatch(/\.mwt-ledger-tabs \.mwt-btn\[aria-selected="true"\]\s*\{[^}]*background: var\(--mwt-accent\)/);
    expect(css).toMatch(/\.mwt-ledger select\.mwt-input option\s*\{[^}]*background-color: var\(--mwt-bg-light\)/);
});

test.each([
    ['without randomUUID (plain-HTTP LAN)', real => ({ getRandomValues: bytes => real.getRandomValues(bytes) })],
    ['without any crypto', () => undefined],
])('adding works %s and IDs stay unique', (_label, makeCrypto) => {
    vi.stubGlobal('crypto', makeCrypto(globalThis.crypto));
    mount();
    fill(form('currency'), { name: 'gold', decimals: '0' }); submit(form('currency'));
    fill(form('transaction'), { amount: '5' }); submit(form('transaction'));
    fill(form('item'), { name: 'Rope', qty: '1' }); submit(form('item'));
    const record = getLedger();
    expect(message()).toBe('Item saved.');
    const ids = [record.currencies[0].id, record.transactions[0].id, record.items[0].id];
    expect(ids).toEqual([expect.stringMatching(/^c-[0-9a-f]{32}$/), expect.stringMatching(/^t-[0-9a-f]{32}$/), expect.stringMatching(/^i-[0-9a-f]{32}$/)]);
});

test('amount text: comma decimals accepted, thousands separators and signs explained', () => {
    mount({ ...createLedger(), currencies: [currency, { id: 'cp', name: 'copper', decimals: 0, badge: false }] });
    fill(form('transaction'), { amount: '12,5' }); submit(form('transaction'));
    expect(getLedger().transactions[0].amount).toBe(1250);
    fill(form('transaction'), { amount: '1,000' }); submit(form('transaction'));
    expect(message()).toContain('no thousands separators');
    fill(form('transaction'), { amount: '-5' }); submit(form('transaction'));
    expect(message()).toContain('Receive or Spend');
    fill(form('transaction'), { amount: '1.234' }); submit(form('transaction'));
    expect(message()).toBe('gold allows 2 decimal places.');
    fill(form('transaction'), { amount: '3,5', currency: 'cp' }); submit(form('transaction'));
    expect(message()).toBe('copper has no decimal places; enter a whole number.');
    expect(getLedger().transactions).toHaveLength(1);
});

test('inventory rows collapse, and saving keeps open rows and Currencies open', () => {
    mount({ ...createLedger(), currencies: [currency], items: [{ id: 'a', name: 'Rope', qty: 3, note: '', carried: true }, { id: 'b', name: 'Salve', qty: 2, note: '', carried: true }] });
    const row = id => form('item', id).closest('details');
    expect(row('a').open).toBe(false);
    row('a').open = true;
    document.querySelector('details[data-ledger-open-key="currencies"]').open = true;
    click(form('item', 'a'), 'quantity-down');
    expect(getLedger().items[0].qty).toBe(2);
    expect(row('a').open).toBe(true);
    expect(row('a').querySelector('summary').textContent).toBe('Rope ×2 · Carried');
    expect(row('b').open).toBe(false);
    expect(document.querySelector('details[data-ledger-open-key="currencies"]').open).toBe(true);
});

test('Overview names the empty states instead of "No badge currency"', () => {
    const overview = () => renderOverviewSnapshot({ ledger: { ok: true, value: getStatus() } });
    expect(overview()).toContain('No ledger yet');
    saveLedger(createLedger());
    expect(overview()).toContain('No currencies yet');
});

test('create currency, exact signed transactions, edit and confirmed delete', () => {
    mount();
    fill(form('currency'), { name: 'gold', decimals: '2' }); submit(form('currency'));
    expect(getLedger().currencies[0].badge).toBe(true);
    fill(form('transaction'), { amount: '0.10', note: '<img src=x onerror=alert(1)>', date: '14 March 1203' }); submit(form('transaction'));
    fill(form('transaction'), { amount: '0.20', sign: '-' }); submit(form('transaction'));
    expect(getStatus().balance).toBe('-0.10');
    expect(document.querySelector('img')).toBeNull();
    const id = getLedger().transactions[0].id;
    fill(form('transaction', id), { amount: '1.10' }); submit(form('transaction', id));
    expect(getStatus().balance).toBe('0.90');
    confirmDelete.mockReturnValueOnce(false);
    click(form('transaction', id), 'delete-transaction');
    expect(getLedger().transactions).toHaveLength(2);
    click(form('transaction', id), 'delete-transaction');
    expect(getLedger().transactions).toHaveLength(1);
    expect(confirmDelete).toHaveBeenLastCalledWith(expect.stringContaining('1.10 gold'));
});

test('carried aggregates lock currency and date but allow amount and note corrections', () => {
    mount({ ...createLedger(), currencies: [currency], transactions: [{ id: 't', currency: 'gold', amount: 125, note: 'Carried forward', date: null, kind: 'carried' }] });
    expect(form('transaction', 't').elements.namedItem('currency').disabled).toBe(true);
    expect(form('transaction', 't').elements.namedItem('date')).toBeNull();
    fill(form('transaction', 't'), { amount: '2.50', note: 'Correct opening purse' }); submit(form('transaction', 't'));
    expect(getLedger().transactions[0]).toMatchObject({ amount: 250, note: 'Correct opening purse', kind: 'carried', date: null });
    click(form('transaction', 't'), 'delete-transaction');
    expect(confirmDelete).toHaveBeenCalledWith(expect.stringContaining('Carried forward'));
});

test('currency decimals preserve value, reject precision loss, and refuse referenced deletion', () => {
    mount({ ...createLedger(), currencies: [currency], transactions: [{ id: 't', currency: 'gold', amount: 125, note: '', date: null, kind: 'entry' }] });
    fill(form('currency', 'gold'), { decimals: '3', name: 'credits' }); submit(form('currency', 'gold'));
    expect(getLedger().transactions[0].amount).toBe(1250);
    expect(getStatus().balance).toBe('1.250');
    fill(form('currency', 'gold'), { decimals: '1' }); submit(form('currency', 'gold'));
    expect(getLedger().currencies[0].decimals).toBe(3);
    expect(message()).toContain('fractional digits');
    click(form('currency', 'gold'), 'delete-currency');
    expect(message()).toContain('Cannot delete');
    expect(confirmDelete).not.toHaveBeenCalled();
});

test('inventory quantity zero is a confirmed removal, and carried/stored toggle saves', () => {
    mount();
    document.querySelector('[role="tab"][data-tab="inventory"]').click();
    fill(form('item'), { name: 'Rope', qty: '2', note: '50 ft' }); submit(form('item'));
    const id = getLedger().items[0].id;
    expect(document.querySelector('[role="tab"][data-tab="inventory"]').getAttribute('aria-selected')).toBe('true');
    click(form('item', id), 'quantity-down');
    expect(getLedger().items[0].qty).toBe(1);
    confirmDelete.mockReturnValueOnce(false);
    click(form('item', id), 'quantity-down');
    expect(getLedger().items[0].qty).toBe(1);
    expect(form('item', id).elements.namedItem('qty').value).toBe('1');
    fill(form('item', id), { carried: 'false' });
    form('item', id).elements.namedItem('carried').dispatchEvent(new Event('change'));
    expect(getStatus().carried).toBe(0);
    fill(form('item', id), { qty: '0' });
    form('item', id).elements.namedItem('qty').dispatchEvent(new Event('change'));
    expect(getLedger().items).toEqual([]);
});

test('stale chat and externally changed data never overwrite metadata', () => {
    mount();
    fill(form('currency'), { name: 'gold', decimals: '0' });
    bumpEpoch(); submit(form('currency'));
    expect(getLedger()).toBeNull();
    expect(message()).toContain('Chat changed');
    mount();
    saveLedger({ ...createLedger(), currencies: [currency] });
    fill(form('currency'), { name: 'silver', decimals: '0' }); submit(form('currency'));
    expect(getLedger().currencies).toHaveLength(1);
    expect(message()).toContain('Ledger changed');
});

test('invalid and future records remain unchanged and editor is disabled', () => {
    ctx.chatMetadata.mwt_ledger = { version: 99, precious: 'keep this' };
    const raw = JSON.stringify(ctx.chatMetadata);
    mount();
    expect(document.querySelector('fieldset').disabled).toBe(true);
    expect(document.querySelector('[role="alert"]').textContent).toContain('invalid');
    expect(JSON.stringify(ctx.chatMetadata)).toBe(raw);
});

test('settings strip saves global gates without creating ledger data', () => {
    mount();
    const control = document.querySelector('[data-ledger-setting="injectLedger"]');
    control.checked = false; control.dispatchEvent(new Event('change'));
    expect(options.saveSettings).toHaveBeenCalledWith({ injectLedger: false });
    expect(options.onChanged).toHaveBeenCalled();
    expect(getLedger()).toBeNull();
});

test.each(['modern', 'classic'])('floating badge, tooltip, empty/debt states and Overview link (%s)', style => {
    saveLedger({ ...createLedger(), currencies: [currency], transactions: [{ id: 't', currency: 'gold', amount: -120000, note: '', date: null, kind: 'entry' }], items: [{ id: 'i', name: 'Rope', qty: 2, note: '', carried: true }] });
    const settings = { buttonStyle: style };
    const openModal = vi.fn();
    const bar = createFloatingButtonBar({ getSettings: () => settings, saveSettings: vi.fn(), openModal,
        modules: { WorldState: {}, Chronicle: {}, Knowledge: {}, StoryPlanner: {}, Interiority: {}, Ledger: { getStatus } } });
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    bar.setupButtonBar(); bar.updateFloatTokenCounts();
    const floating = document.getElementById('mwt-float-ledger');
    expect(floating.querySelector('.mwt-float-btn-countdown').textContent).toBe('−1.2k');
    expect(floating.querySelector('.mwt-float-btn-countdown').classList.contains('mwt-float-badge--debt')).toBe(true);
    expect(floating.title).toContain('-1200.00 gold');
    expect(floating.title).toContain('1 carried items');
    expect(floating.querySelector('.mwt-float-btn-icon').textContent).toBe(style === 'classic' ? '💰 −1.2k gold' : '💰');
    floating.click(); expect(openModal).toHaveBeenCalledWith('ledger');
    const overview = renderOverviewSnapshot({ ledger: { ok: true, value: getStatus() } });
    expect(overview).toContain('-1200.00 gold');
    expect(overview).toContain('data-overview-tab="ledger"');
    saveLedger(createLedger()); bar.updateFloatTokenCounts();
    expect(floating.querySelector('.mwt-float-btn-countdown').style.display).toBe('none');
    expect(floating.querySelector('.mwt-float-btn-countdown').classList.contains('mwt-float-badge--debt')).toBe(false);
    settings.showFloatLedger = false; bar.applyButtonVisibility(); expect(floating.style.display).toBe('none');
});