/** Manual, chat-local editor. All writes pass through the validated store. */
import { escapeHtml } from '../core/diff.js';
import { resolveCalendarClock } from '../core/calendar_state.js';
import { captureScope, assertSameScope } from '../core/scope.js';
import { wireTablist } from '../core/ui.js';
import { getContextSafe, getChatMeta } from '../core/context.js';
import { isStoreWriteBlocked } from '../core/schema_status.js';
import { MANIFEST_METADATA_KEY, MANIFEST_VERSION } from '../schema/manifest.js';
import { createLedger, computeBalances, formatAmount, parseAmount, canDeleteCurrency, validateLedgerRecord, MAX_CURRENCY_DECIMALS } from './data.js';
import { getLedger, saveLedger } from './store.js';
import { renderSettings } from './settings.js';

const esc = value => escapeHtml(String(value ?? ''));
const button = (text, action = '', extra = '') => `<button type="${action ? 'button' : 'submit'}" class="mwt-btn" ${action ? `data-ledger-action="${action}"` : ''} ${extra}>${text}</button>`;
function input(name, label, value = '', extra = '') {
    return `<label class="mwt-ledger-field">${label}<input class="mwt-input" name="${name}" value="${esc(value)}" ${extra}></label>`;
}
function note(value = '') {
    return `<label class="mwt-ledger-field">Note<textarea class="mwt-input mwt-ledger-note" name="note" rows="2">${esc(value)}</textarea></label>`;
}
function currencySelect(record, selected, locked = false) {
    return `<label class="mwt-ledger-field">Currency<select class="mwt-input" name="currency" ${locked ? 'disabled' : ''}>${record.currencies.map(row => `<option value="${esc(row.id)}" ${row.id === selected ? 'selected' : ''}>${esc(row.name)}</option>`).join('')}</select></label>`;
}
function transactionForm(record, row, date) {
    const currency = record.currencies.find(value => value.id === row?.currency) ?? record.currencies[0];
    const carried = row?.kind === 'carried';
    return `<form data-ledger-form="transaction" ${row ? `data-id="${esc(row.id)}"` : ''} class="mwt-ledger-form">
        <label class="mwt-ledger-field">Direction<select class="mwt-input" name="sign"><option value="+">+ Receive</option><option value="-" ${row?.amount < 0 ? 'selected' : ''}>− Spend</option></select></label>
        ${input('amount', 'Amount', row ? formatAmount(Math.abs(row.amount), currency.decimals) : '', 'inputmode="decimal" required')}
        ${currencySelect(record, currency?.id, carried)}${note(row?.note)}
        ${carried ? '<p>Carried forward — corrected opening balance. Currency is locked; this aggregate has no single date.</p>' : input('date', 'In-story date (optional)', row ? row.date : date)}
        ${button(row ? 'Save entry' : 'Add entry', '', record.currencies.length ? '' : 'disabled')}
        ${row ? button('Delete entry', 'delete-transaction') : ''}
    </form>`;
}
function itemForm(row) {
    return `<form data-ledger-form="item" ${row ? `data-id="${esc(row.id)}"` : ''} class="mwt-ledger-form">
        ${input('name', 'Item name', row?.name, 'required')}
        <div class="mwt-ledger-quantity">${row ? button('−', 'quantity-down', 'aria-label="Decrease quantity"') : ''}
        ${input('qty', 'Quantity', row?.qty ?? 1, 'type="number" min="1" step="1" required')}
        ${row ? button('+', 'quantity-up', 'aria-label="Increase quantity"') : ''}</div>
        ${note(row?.note)}<label class="mwt-ledger-field">Location<select class="mwt-input" name="carried"><option value="true">Carried</option><option value="false" ${row?.carried === false ? 'selected' : ''}>Stored</option></select></label>
        ${button(row ? 'Save item' : 'Add item')}${row ? button('Delete item', 'delete-item') : ''}
    </form>`;
}
function currencyForm(row) {
    return `<form data-ledger-form="currency" ${row ? `data-id="${esc(row.id)}"` : ''} class="mwt-ledger-form">
        ${input('name', 'Currency name', row?.name, 'required')}
        ${input('decimals', 'Decimal places', row?.decimals ?? 0, `type="number" min="0" max="${MAX_CURRENCY_DECIMALS}" step="1" required`)}
        <label><input name="badge" type="checkbox" ${row?.badge ? 'checked' : ''}> Badge currency</label>
        ${button(row ? 'Save currency' : 'Add currency')}${row ? button('Delete currency', 'delete-currency') : ''}
    </form>`;
}

export function renderLedger() {
    const record = getLedger() ?? createLedger();
    const meta = getChatMeta();
    const blocked = !getContextSafe() || !meta || isStoreWriteBlocked('ledger')
        || meta[MANIFEST_METADATA_KEY]?.manifestVersion > MANIFEST_VERSION
        || meta[MANIFEST_METADATA_KEY]?.sections?.ledger > 1;
    const valid = validateLedgerRecord(record).valid;
    let date = '';
    try { const time = resolveCalendarClock(); if (time.source !== 'message-count' && !time.rejection) date = time.formattedDate ?? ''; } catch { /* date is optional */ }
    const balances = valid ? computeBalances(record) : new Map();
    const body = !valid ? '<p role="alert">Ledger data is invalid or from a newer version. It has been kept unchanged. Use Diagnostics or the recovery export before editing.</p>' : `
        <details class="mwt-settings-disclosure"><summary>Currencies</summary>
            <p>Balances are exact. Changing decimal places preserves each entry’s value; changes that would lose precision are refused. A currency with transactions cannot be deleted.</p>
            ${record.currencies.map(currencyForm).join('')}${currencyForm()}
        </details>
        <div class="mwt-ledger-tabs" role="tablist" aria-label="Ledger sections">
            <button type="button" class="mwt-btn active" role="tab" data-tab="finances">Finances</button>
            <button type="button" class="mwt-btn" role="tab" data-tab="inventory">Inventory</button>
        </div>
        <section class="mwt-ledger-pane active" role="tabpanel" data-tab="finances">
            <h3>Finances</h3><ul class="mwt-ledger-balances">${record.currencies.map(row => `<li>${esc(formatAmount(balances.get(row.id), row.decimals))} ${esc(row.name)}${row.badge ? ' · badge' : ''}</li>`).join('')}</ul>
            ${record.currencies.length ? '' : '<p>Add a currency above to record money.</p>'}
            <h4>Add transaction</h4>${transactionForm(record, null, date)}<h4>Transactions · newest first</h4>
            ${record.transactions.length ? [...record.transactions].reverse().map(row => {
                const currency = record.currencies.find(value => value.id === row.currency);
                return `<details class="mwt-ledger-row"><summary>${esc(formatAmount(row.amount, currency.decimals))} ${esc(currency.name)} · ${row.kind === 'carried' ? 'Carried forward · ' : ''}${esc(row.note)}${row.date ? ` · ${esc(row.date)}` : ''}</summary>${transactionForm(record, row, date)}</details>`;
            }).join('') : '<p>No transactions yet.</p>'}
        </section>
        <section class="mwt-ledger-pane" role="tabpanel" data-tab="inventory" hidden><h3>Inventory</h3>
            <p>Only carried items are injected (up to 15 rows, with an omitted count). Unlisted possessions may still exist.</p>
            <h4>Add item</h4>${itemForm()}<h4>Items · carried first</h4>
            ${[...record.items].sort((a, b) => Number(b.carried) - Number(a.carried)).map(row => `<div class="mwt-ledger-row"><h4>${esc(row.name)} ×${row.qty} · ${row.carried ? 'Carried' : 'Stored'}</h4>${itemForm(row)}</div>`).join('') || '<p>No items yet.</p>'}
        </section>`;
    return `<section class="mwt-ledger" aria-label="Ledger"><h2><span aria-hidden="true">💰</span> Ledger</h2>
        <p>You enter it; code does the arithmetic; the narrator only reads it. Saved per chat.</p>
        ${renderSettings()}<p class="mwt-ledger-status" role="status" aria-live="polite"></p>
        ${blocked ? '<p role="alert">Ledger editing is unavailable: select an active chat, or resolve the paused/newer schema in Diagnostics.</p>' : ''}
        <fieldset class="mwt-ledger-editor" ${blocked || !valid ? 'disabled' : ''}>${body}</fieldset></section>`;
}

/** Each fresh render owns a scope token and an optimistic snapshot. */
export function wireLedger(root, { getSettings, saveSettings, onChanged = () => {}, confirmDelete = message => globalThis.confirm(message) } = {}) {
    const pane = root?.querySelector('.mwt-ledger');
    if (!pane || pane._ledgerWired) return;
    pane._ledgerWired = true;
    const scope = captureScope();
    const snapshot = JSON.stringify(getLedger());
    const tabs = wireTablist(pane.querySelector('[role="tablist"]'), {
        tabSelector: '[role="tab"]', panelSelector: '.mwt-ledger-pane', scope: pane,
        activeClass: 'active', idPrefix: 'mwt-ledger', orientation: 'horizontal',
    });
    const status = message => { pane.querySelector('.mwt-ledger-status').textContent = message; };
    const current = () => {
        if (!assertSameScope(scope).ok) throw new Error('Chat changed. Reopen Ledger before editing.');
        if (JSON.stringify(getLedger()) !== snapshot) throw new Error('Ledger changed. Reopen it before saving; your draft has not overwritten newer data.');
        return getLedger() ?? createLedger();
    };
    const run = action => { try { action(); } catch (error) { status(error.message); } };
    const commit = (record, message) => {
        current();
        saveLedger(record);
        const selected = tabs?.getSelectedIndex() ?? 0;
        const parent = pane.parentElement;
        pane.outerHTML = renderLedger();
        wireLedger(parent, { getSettings, saveSettings, onChanged, confirmDelete });
        const next = parent.querySelector('.mwt-ledger');
        next.querySelectorAll('[role="tab"]')[selected]?.click();
        next.querySelector('.mwt-ledger-status').textContent = message;
        onChanged();
    };
    const id = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`;
    const remove = (form, collection, message) => {
        current();
        if (!confirmDelete(message)) return false;
        const record = current();
        record[collection] = record[collection].filter(row => row.id !== form.dataset.id);
        if (collection === 'currencies' && record.currencies.length && !record.currencies.some(row => row.badge)) record.currencies[0].badge = true;
        commit(record, 'Removed.');
        return true;
    };
    pane.querySelectorAll('[data-ledger-setting]').forEach(control => control.addEventListener('change', () => run(() => {
        if (!assertSameScope(scope).ok) throw new Error('Chat changed. Reopen Ledger.');
        if (!saveSettings) throw new Error('Settings saver unavailable.');
        saveSettings({ [control.dataset.ledgerSetting]: control.checked });
        onChanged();
        status('Ledger setting saved.');
    })));
    pane.querySelectorAll('form').forEach(form => {
        const field = name => form.elements.namedItem(name);
        const saveItem = () => {
            const record = current();
            const previous = record.items.find(row => row.id === form.dataset.id);
            const qty = Number(field('qty').value);
            if (previous && field('qty').value.trim() !== '' && qty === 0) {
                if (!remove(form, 'items', `Remove item “${previous.name}”?`)) field('qty').value = previous.qty;
                return;
            }
            if (!field('qty').value.trim() || !Number.isSafeInteger(qty) || qty < 1) throw new Error('Quantity must be a whole number of at least 1.');
            const row = { ...previous, id: previous?.id ?? id('i'), name: field('name').value.trim(), qty, note: field('note').value, carried: field('carried').value === 'true' };
            if (previous) Object.assign(previous, row); else record.items.push(row);
            commit(record, 'Item saved.');
        };
        form.addEventListener('submit', event => {
            event.preventDefault();
            run(() => {
                if (form.dataset.ledgerForm === 'item') return saveItem();
                const record = current();
                if (form.dataset.ledgerForm === 'currency') {
                    const previous = record.currencies.find(row => row.id === form.dataset.id);
                    if (!field('decimals').value.trim()) throw new Error('Enter decimal places.');
                    const decimals = Number(field('decimals').value);
                    // Rescale exactly; parseAmount refuses lossy precision changes.
                    if (previous && previous.decimals !== decimals) {
                        for (const row of record.transactions.filter(value => value.currency === previous.id)) {
                            const exact = formatAmount(row.amount, previous.decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
                            row.amount = parseAmount(exact, decimals);
                        }
                    }
                    const badge = field('badge').checked || !record.currencies.length || previous?.badge === true;
                    if (field('badge').checked) record.currencies.forEach(row => { row.badge = false; });
                    const row = { ...previous, id: previous?.id ?? id('c'), name: field('name').value.trim(), decimals, badge };
                    if (previous) Object.assign(previous, row); else record.currencies.push(row);
                    return commit(record, 'Currency saved.');
                }
                const previous = record.transactions.find(row => row.id === form.dataset.id);
                const currency = record.currencies.find(row => row.id === (previous?.kind === 'carried' ? previous.currency : field('currency').value));
                if (!currency) throw new Error('Add a currency first.');
                if (!/^\d+(?:\.\d+)?$/.test(field('amount').value.trim())) throw new Error('Enter an unsigned amount; choose Receive or Spend for its direction.');
                const row = { ...previous, id: previous?.id ?? id('t'), currency: currency.id,
                    amount: parseAmount(field('sign').value + field('amount').value.trim(), currency.decimals),
                    note: field('note').value, date: previous?.kind === 'carried' ? null : field('date').value.trim() || null, kind: previous?.kind ?? 'entry' };
                if (previous) Object.assign(previous, row); else record.transactions.push(row);
                commit(record, 'Transaction saved.');
            });
        });
        if (form.dataset.ledgerForm === 'item' && form.dataset.id) {
            field('qty').addEventListener('change', () => run(saveItem));
            field('carried').addEventListener('change', () => run(saveItem));
        }
        form.querySelectorAll('[data-ledger-action]').forEach(control => control.addEventListener('click', () => run(() => {
            const record = current();
            const action = control.dataset.ledgerAction;
            if (action.startsWith('quantity-')) {
                field('qty').value = Number(field('qty').value) + (action === 'quantity-up' ? 1 : -1);
                return saveItem();
            }
            if (action === 'delete-currency') {
                if (!canDeleteCurrency(record, form.dataset.id)) throw new Error('Cannot delete a currency with transactions. Delete its transactions first.');
                return remove(form, 'currencies', `Delete currency “${field('name').value}”?`);
            }
            if (action === 'delete-item') return remove(form, 'items', `Remove item “${field('name').value}”?`);
            const row = record.transactions.find(value => value.id === form.dataset.id);
            const currency = record.currencies.find(value => value.id === row.currency);
            remove(form, 'transactions', `Delete ${row.kind === 'carried' ? 'Carried forward' : 'transaction'}? This removes ${formatAmount(row.amount, currency.decimals)} ${currency.name} from the balance.`);
        })));
    });
}