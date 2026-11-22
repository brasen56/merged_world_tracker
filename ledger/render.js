/** Manual, chat-local editor. All writes pass through the validated store. */
import { escapeHtml } from '../core/diff.js';
import { resolveCalendarClock } from '../core/calendar_state.js';
import { captureScope, assertSameScope } from '../core/scope.js';
import { wireTablist } from '../core/ui.js';
import { getContextSafe, getChatMeta } from '../core/context.js';
import { isStoreWriteBlocked } from '../core/schema_status.js';
import { MANIFEST_METADATA_KEY, MANIFEST_VERSION } from '../schema/manifest.js';
import { createLedger, computeBalances, computeDebts, formatAmount, parseAmount, canDeleteCurrency, validateLedgerRecord, MAX_CURRENCY_DECIMALS } from './data.js';
import { getLedger, saveLedger } from './store.js';
import { renderSettings } from './settings.js';
import { ledgerSchema } from './schema.js';
import { createLedgerSourceIndex, decideLedgerProposals, expireLedgerProposals, proposalSource } from './proposals.js';
import { validateLedgerAudit } from './data.js';

const esc = value => escapeHtml(String(value ?? ''));
/** Accepted suggestions carry a sentence or two of context as the note; the
 * summary line clips it at a word boundary and the edit form shows it whole. */
const SUMMARY_NOTE_CHARS = 120;
const summaryNote = value => value.length <= SUMMARY_NOTE_CHARS ? value
    : `${value.slice(0, SUMMARY_NOTE_CHARS).replace(/\s+\S*$/, '')}…`;
/**
 * crypto.randomUUID exists only in secure contexts (HTTPS or localhost), so a
 * phone reaching ST at http://192.168.x.x has none. getRandomValues does not
 * need a secure context; Math.random is the last resort. Duplicate IDs are
 * still refused by validation, so a collision cannot corrupt the ledger.
 */
function randomId() {
    const source = globalThis.crypto;
    if (typeof source?.randomUUID === 'function') return source.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof source?.getRandomValues === 'function') source.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
/**
 * Unsigned amount text for parseAmount. Phones set to a comma-decimal locale
 * may show only "," on the decimal keypad, so "12,50" reads as 12.50. One to
 * two digits after the comma only: "1,000" is a thousands separator in
 * English, so it stays an error rather than becoming 1.000.
 */
function readAmountText(value, currency) {
    const typed = String(value ?? '').trim();
    const text = /^\d+,\d{1,2}$/.test(typed) ? typed.replace(',', '.') : typed;
    if (/^[-+−]/.test(text)) throw new Error('Enter the amount without a sign; choose Receive or Spend for its direction.');
    if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Enter digits with an optional decimal point, like 12.50, and no thousands separators.');
    if ((text.split('.')[1]?.length ?? 0) > currency.decimals) {
        throw new Error(currency.decimals
            ? `${currency.name} allows ${currency.decimals} decimal place${currency.decimals === 1 ? '' : 's'}.`
            : `${currency.name} has no decimal places; enter a whole number.`);
    }
    return text;
}
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
        ${input('counterparty', 'Counterparty (optional)', row?.counterparty)}
        <label class="mwt-ledger-check"><input name="loan" type="checkbox" ${row?.loan ? 'checked' : ''}> Loan or repayment</label>
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
        ${input('where', 'Stored where (optional)', row?.where)}
        <label class="mwt-ledger-check"><input name="pinned" type="checkbox" ${row?.pinned ? 'checked' : ''}> ★ Pinned (prioritize carried context)</label>
        ${button(row ? 'Save item' : 'Add item')}${row ? button('Delete item', 'delete-item') : ''}
    </form>`;
}
function currencyForm(row) {
    return `<form data-ledger-form="currency" ${row ? `data-id="${esc(row.id)}"` : ''} class="mwt-ledger-form">
        ${input('name', 'Currency name', row?.name, 'required')}
        ${input('decimals', 'Decimal places', row?.decimals ?? 0, `type="number" min="0" max="${MAX_CURRENCY_DECIMALS}" step="1" required`)}
        <label class="mwt-ledger-check"><input name="badge" type="checkbox" ${row?.badge ? 'checked' : ''}> Badge currency</label>
        ${button(row ? 'Save currency' : 'Add currency')}${row ? button('Delete currency', 'delete-currency') : ''}
    </form>`;
}

function renderPendingSuggestions(record) {
    const pending = validateLedgerAudit(record).proposals.filter(row => row.status === 'pending');
    const sources = createLedgerSourceIndex();
    const describe = row => {
        if (row.kind === 'item') {
            return `${row.item.qtyChange > 0 ? '+' : ''}${row.item.qtyChange} ${esc(row.item.name)}${row.item.carried === false ? ' · stored' : ''}`;
        }
        const currency = record.currencies.find(value => value.id === row.money.currency);
        return `${esc(formatAmount(row.money.amount, currency?.decimals ?? 2))} ${esc(currency?.name ?? row.money.currency)}`
            + `${row.money.loan ? ' · loan' : ''}${row.counterparty ? ` · with ${esc(row.counterparty)}` : ''}`;
    };
    const groups = new Map();
    for (const row of pending) {
        // Pre-Phase-7 proposals have no harvest receipt: keep them separate.
        const key = row.harvest || row.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return `<summary>Pending suggestions (${pending.length})</summary>
        <p>Nothing changes until you accept. Review the evidence; source-changed suggestions require confirmation.</p>
        ${[...groups].map(([key, rows]) => `<section class="mwt-ledger-harvest" data-harvest="${esc(key)}">
            <h4>Refresh suggestions</h4>${button('Accept all', 'accept-harvest')}${button('Reject all', 'reject-harvest')}
            ${rows.map(row => {
                const source = proposalSource(row, sources);
                const newItem = row.kind === 'item' && row.item.qtyChange > 0 && !record.items.some(item => item.name.trim().toLowerCase() === row.item.name.trim().toLowerCase());
                return `<article class="mwt-ledger-row" data-proposal="${esc(row.id)}">${describe(row)}
                    <span class="mwt-ledger-chip">${source.state === 'live' ? `Message #${source.index}`
                        : source.state === 'condensed' ? `Condensed into summary #${source.summaryIndex}` : 'Source unavailable'}</span>
                    ${source.changed ? '<span class="mwt-ledger-chip">source changed (source message edited)</span>' : ''}
                    <blockquote>${esc(row.evidence)}</blockquote>
                    ${row.context ? `<p class="mwt-ledger-context">Context: ${esc(row.context)}</p>` : ''}
                    ${newItem ? `<label class="mwt-ledger-field">Apply to existing item<select class="mwt-input" data-item-target><option value="">Create new item</option>${record.items.map(item => `<option value="${esc(item.id)}">${esc(item.name)} ×${item.qty}</option>`).join('')}</select></label>` : ''}
                    ${button('Accept', 'accept-proposal')}${button('Reject', 'reject-proposal')}</article>`;
            }).join('')}</section>`).join('') || '<p>No pending suggestions.</p>'}`;
}

/**
 * Word the chip by what the lookup knows: "changed" only when there is text
 * to compare. A deleted source still warns (delete + regenerate is effectively
 * a swipe); a source ILS condensed and later flattened does not.
 */
function sourceChip(record, source, sources = createLedgerSourceIndex()) {
    if (!source || source === 'user') return '';
    const proposal = validateLedgerAudit(record).proposals.find(row => row.id === source);
    const where = proposal ? sources.locate(proposal) : null;
    const label = !where ? ''
        : where.state === 'live' ? ` · message #${where.index}`
        : where.state === 'condensed' ? ` · condensed into summary #${where.summaryIndex}`
        : where.state === 'flattened' ? ' · condensed; original no longer stored'
        : ' · source deleted after accept';
    const changed = where?.changed && where.state !== 'deleted' ? ' · source changed after accept' : '';
    const warning = where?.changed ? ' mwt-ledger-chip-warning' : '';
    return `<span class="mwt-ledger-chip${warning}" data-ledger-source="${esc(source)}">from refresh${label}${changed}</span>`;
}

function itemHistory(record, name, sources = createLedgerSourceIndex()) {
    const rows = validateLedgerAudit(record).itemLog.filter(row => !name || row.name === name);
    return `${record.itemLogTrimmed ? '<p>…older changes trimmed</p>' : ''}<ul>${[...rows].reverse().map(row => `<li>${esc(row.name)} · ${esc(row.change)}: ${esc(row.detail)}${row.date ? ` · ${esc(row.date)}` : ''} ${sourceChip(record, row.source, sources)}</li>`).join('')}</ul>${rows.length ? '' : '<p>No recorded changes.</p>'}`;
}

// A refresh updates only the inbox; open forms keep their drafts.
let previewDocument;
function updatePendingSuggestions() {
    const record = getLedger() ?? createLedger();
    if (!validateLedgerRecord(record).valid) return;
    const pending = validateLedgerAudit(record).proposals.filter(row => row.status === 'pending').length;
    const tab = document.getElementById('mwt-tab-ledger');
    if (tab) {
        let count = tab.querySelector('[data-ledger-pending-count]');
        if (!count) { count = document.createElement('span'); count.dataset.ledgerPendingCount = ''; tab.append(count); }
        count.textContent = pending ? ` (${pending})` : '';
    }
    const sources = createLedgerSourceIndex();
    document.querySelectorAll('.mwt-ledger').forEach(pane => {
        if (!pane._ledgerScope || !assertSameScope(pane._ledgerScope).ok) return;
        const preview = pane.querySelector('[data-ledger-open-key="pending"]');
        if (preview) {
            const targets = new Map([...preview.querySelectorAll('[data-item-target]')]
                .map(select => [select.closest('[data-proposal]').dataset.proposal, select.value]));
            preview.innerHTML = renderPendingSuggestions(record);
            preview.querySelectorAll('[data-item-target]').forEach(select => {
                const target = targets.get(select.closest('[data-proposal]').dataset.proposal);
                if (record.items.some(item => item.id === target)) select.value = target;
            });
        }
        pane.querySelectorAll('[data-ledger-source]').forEach(chip => { chip.outerHTML = sourceChip(record, chip.dataset.ledgerSource, sources); });
    });
}

// Showing the Ledger tab re-reads the live chat even inside an already-open
// modal (tab switches toggle `hidden`; they never rebuild the pane): expiry
// drops deleted sources (§3.4) and the digest check re-flags edited ones (D16).
const refreshPendingOnTabShow = event => {
    if (!event.target.closest?.('#mwt-tab-ledger')) return;
    expireLedgerProposals();
    refreshLedgerEditors();
};

function refreshLedgerEditors() {
    document.querySelectorAll('.mwt-ledger').forEach(pane => pane._ledgerRefresh?.());
    updatePendingSuggestions();
}

// Compare actual values, not just input events (autofill can change values too).
const formSnapshot = pane => JSON.stringify([...pane.querySelectorAll('form input, form select, form textarea')]
    .map(control => [control.value, control.checked]));

// Audit-only writes cannot collide with form edits. Each action still reads
// the latest ledger, preserving proposals/log rows added since the form opened.
const editableSnapshot = record => JSON.stringify(record && { ...record, proposals: undefined, itemLog: undefined });

export function renderLedger() {
    expireLedgerProposals();
    const record = getLedger() ?? createLedger();
    const meta = getChatMeta();
    const blocked = !getContextSafe() || !meta || isStoreWriteBlocked('ledger')
        || meta[MANIFEST_METADATA_KEY]?.manifestVersion > MANIFEST_VERSION
        || meta[MANIFEST_METADATA_KEY]?.sections?.ledger > ledgerSchema.currentVersion;
    const valid = validateLedgerRecord(record).valid;
    let date = '';
    try { const time = resolveCalendarClock(); if (time.source !== 'message-count' && !time.rejection) date = time.formattedDate ?? ''; } catch { /* date is optional */ }
    const balances = valid ? computeBalances(record) : new Map();
    const sources = createLedgerSourceIndex();
    const body = !valid ? '<p role="alert">Ledger data is invalid or from a newer version. It has been kept unchanged. Use Diagnostics or the recovery export before editing.</p>' : `
        <details data-ledger-open-key="pending" open>${renderPendingSuggestions(record)}</details>
        <details class="mwt-settings-disclosure" data-ledger-open-key="currencies"><summary>Currencies</summary>
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
            <h4>Debts</h4><p>Loans only; counterparty names match exactly. Repay with an opposite-sign loan entry.</p>
            <ul>${computeDebts(record).map(debt => {
                const currency = record.currencies.find(row => row.id === debt.currency);
                return `<li>${debt.amount > 0 ? `You owe ${esc(debt.counterparty)}` : `${esc(debt.counterparty)} owes you`} ${esc(formatAmount(Math.abs(debt.amount), currency.decimals))} ${esc(currency.name)}</li>`;
            }).join('') || '<li>No open recorded debts.</li>'}</ul>
            <h4>Add transaction</h4>${transactionForm(record, null, date)}<h4>Transactions · newest first</h4>
            ${record.transactions.length ? [...record.transactions].reverse().map(row => {
                const currency = record.currencies.find(value => value.id === row.currency);
                return `<details class="mwt-ledger-row"><summary>${esc(formatAmount(row.amount, currency.decimals))} ${esc(currency.name)} · ${row.kind === 'carried' ? 'Carried forward · ' : ''}${esc(summaryNote(row.note))}${row.date ? ` · ${esc(row.date)}` : ''}${sourceChip(record, row.source, sources)}</summary>${transactionForm(record, row, date)}</details>`;
            }).join('') : '<p>No transactions yet.</p>'}
        </section>
        <section class="mwt-ledger-pane" role="tabpanel" data-tab="inventory" hidden><h3>Inventory</h3>
            <p>Only carried items are injected (up to 15 rows, with an omitted count). Unlisted possessions may still exist.</p>
            <h4>Add item</h4>${itemForm()}<h4>Items · carried first</h4>
            ${[...record.items].sort((a, b) => Number(b.carried) - Number(a.carried) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))).map(row => `<details class="mwt-ledger-row" data-ledger-open-key="item:${esc(row.id)}"><summary>${esc(row.name)} ×${row.qty} · ${row.carried ? 'Carried' : 'Stored'}${row.pinned ? ' · ★' : ''}${!row.carried && row.where ? ` · ${esc(row.where)}` : ''}</summary>${itemForm(row)}<details><summary>History</summary>${itemHistory(record, row.name, sources)}</details></details>`).join('') || '<p>No items yet.</p>'}
            <details data-ledger-open-key="recent-changes"><summary>Recent item changes</summary>${itemHistory(record, undefined, sources)}</details>
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
    pane._ledgerScope = scope;
    if (previewDocument !== document) {
        previewDocument?.removeEventListener('mwt:ledger-proposals-changed', updatePendingSuggestions);
        previewDocument?.removeEventListener('mwt:ledger-changed', refreshLedgerEditors);
        previewDocument?.removeEventListener('click', refreshPendingOnTabShow);
        document.addEventListener('mwt:ledger-proposals-changed', updatePendingSuggestions);
        document.addEventListener('mwt:ledger-changed', refreshLedgerEditors);
        document.addEventListener('click', refreshPendingOnTabShow);
        previewDocument = document;
    }
    const snapshot = editableSnapshot(getLedger());
    const draftSnapshot = formSnapshot(pane);
    const tabs = wireTablist(pane.querySelector('[role="tablist"]'), {
        tabSelector: '[role="tab"]', panelSelector: '.mwt-ledger-pane', scope: pane,
        activeClass: 'active', idPrefix: 'mwt-ledger', orientation: 'horizontal',
    });
    const status = message => { pane.querySelector('.mwt-ledger-status').textContent = message; };
    const current = () => {
        if (!assertSameScope(scope).ok) throw new Error('Chat changed. Reopen Ledger before editing.');
        if (editableSnapshot(getLedger()) !== snapshot) throw new Error('Ledger changed. Reopen it before saving; your draft has not overwritten newer data.');
        return getLedger() ?? createLedger();
    };
    const run = action => { try { action(); } catch (error) { status(error.message); } };
    const rebuild = message => {
        const selected = tabs?.getSelectedIndex() ?? 0;
        // The stepper and Carried/Stored autosave from inside a collapsed
        // row, so the re-render must not close the row being worked on.
        const open = new Set([...pane.querySelectorAll('details[open][data-ledger-open-key]')].map(row => row.dataset.ledgerOpenKey));
        const parent = pane.parentElement;
        pane.outerHTML = renderLedger();
        wireLedger(parent, { getSettings, saveSettings, onChanged, confirmDelete });
        const next = parent.querySelector('.mwt-ledger');
        next.querySelectorAll('details[data-ledger-open-key]').forEach(row => { row.open = open.has(row.dataset.ledgerOpenKey); });
        next.querySelectorAll('[role="tab"]')[selected]?.click();
        next.querySelector('.mwt-ledger-status').textContent = message;
    };
    pane._ledgerRefresh = () => {
        if (!assertSameScope(scope).ok || editableSnapshot(getLedger()) === snapshot) return;
        if (formSnapshot(pane) === draftSnapshot && !pane.querySelector('[data-ledger-overdraft]')) {
            rebuild('Ledger updated.');
            return;
        }
        if (pane.querySelector('[data-ledger-reload]')) return;
        const notice = document.createElement('div');
        notice.setAttribute('role', 'alert');
        notice.textContent = 'Ledger changed. Your unsaved draft is preserved. Reload before saving. ';
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'mwt-btn';
        reload.dataset.ledgerReload = '';
        reload.textContent = 'Reload Ledger';
        reload.addEventListener('click', () => run(() => {
            if (!assertSameScope(scope).ok) throw new Error('Chat changed. Reopen Ledger before editing.');
            if (!confirmDelete('Reload Ledger and discard unsaved Ledger drafts?')) return;
            if (!assertSameScope(scope).ok) throw new Error('Chat changed. Reopen Ledger before editing.');
            rebuild('Ledger reloaded.');
        }));
        notice.append(reload);
        pane.querySelector('.mwt-ledger-editor').before(notice);
    };
    const commit = (record, message) => {
        current();
        saveLedger(record);
        rebuild(message);
        onChanged();
    };
    const id = prefix => `${prefix}-${randomId()}`;
    // Delegation survives inbox-only refreshes without discarding editor drafts.
    pane.addEventListener('click', event => {
        const control = event.target.closest('[data-ledger-action]');
        const action = control?.dataset.ledgerAction;
        if (!['accept-proposal', 'reject-proposal', 'accept-harvest', 'reject-harvest'].includes(action)) return;
        run(() => {
            // Decisions read and validate the latest store independently of
            // stale editor drafts, which still cannot overwrite newer data.
            if (!assertSameScope(scope).ok) throw new Error('Chat changed. Reopen Ledger before editing.');
            const selection = control.closest(action.endsWith('harvest') ? '[data-harvest]' : '[data-proposal]');
            const ids = action.endsWith('harvest') ? [...selection.querySelectorAll('[data-proposal]')].map(row => row.dataset.proposal) : [selection.dataset.proposal];
            const itemTargets = Object.fromEntries([...selection.querySelectorAll('[data-item-target]')].map(select => [select.closest('[data-proposal]').dataset.proposal, select.value]));
            const choices = {};
            const review = () => {
                try {
                    if (!assertSameScope(scope).ok) throw new Error('Chat changed. Reopen Ledger before editing.');
                    const saved = decideLedgerProposals(ids, action.startsWith('accept') ? 'accepted' : 'rejected', {
                        scope, choices, itemTargets,
                        confirmSourceChange: () => confirmDelete('The source message changed. Accept this suggestion anyway?'),
                        confirmRemoval: item => confirmDelete(`Remove item “${item.name}”? This suggestion reduces its quantity to zero or below.`),
                    });
                    if (!saved) return;
                    // Rejections only change the inbox. Accepted edits follow
                    // the same stale-editor/draft protection as external writes.
                    const parent = pane.parentElement;
                    pane._ledgerRefresh();
                    if (pane.isConnected) status('Suggestions reviewed.');
                    else parent?.querySelector('.mwt-ledger-status')?.replaceChildren('Suggestions reviewed.');
                    onChanged();
                } catch (error) {
                    if (!error.overdraft) throw error;
                    pane.querySelector('[data-ledger-overdraft]')?.remove();
                    const { proposal, shortfall } = error.overdraft;
                    const record = getLedger();
                    const currency = record.currencies.find(row => row.id === proposal.money.currency);
                    const dialog = document.createElement('div');
                    dialog.className = 'mwt-ledger-overdraft';
                    dialog.dataset.ledgerOverdraft = '';
                    dialog.setAttribute('role', 'dialog');
                    dialog.setAttribute('aria-label', 'Overdraft warning');
                    const amount = Number(shortfall);
                    const text = Number.isSafeInteger(amount) ? formatAmount(amount, currency.decimals) : shortfall + ' minor units';
                    dialog.innerHTML = `<h4>Overdraft warning</h4><p>This would leave a shortfall of ${esc(text)} ${esc(currency.name)}.</p>
                        ${button('Cancel', 'overdraft-cancel')}${button('Accept with negative balance', 'overdraft-accept')}
                        ${proposal.counterparty?.trim() && !proposal.money.loan ? button(`Accept, and record the shortfall as owed to ${esc(proposal.counterparty)}`, 'overdraft-owed') : ''}`;
                    pane.querySelector('.mwt-ledger-editor').prepend(dialog);
                    dialog.querySelectorAll('button').forEach(choice => choice.addEventListener('click', () => run(() => {
                        const decision = choice.dataset.ledgerAction.replace('overdraft-', '');
                        dialog.remove();
                        if (decision === 'cancel') return;
                        choices[proposal.id] = { decision, shortfall };
                        review();
                    })));
                    dialog.querySelector('button').focus();
                }
            };
            review();
        });
    });
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
            const row = { ...previous, id: previous?.id ?? id('i'), name: field('name').value.trim(), qty, note: field('note').value, carried: field('carried').value === 'true', pinned: field('pinned').checked, where: field('where').value.trim() };
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
                        // Pending amounts must remain exactly actionable. Resolved
                        // receipts retain historical precision for audit/dedupe.
                        for (const proposal of validateLedgerAudit(record).proposals.filter(row => row.kind === 'money' && row.money.currency === previous.id)) {
                            if (proposal.status !== 'pending') {
                                proposal.money.decimals ??= previous.decimals;
                                continue;
                            }
                            const exact = formatAmount(proposal.money.amount, previous.decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
                            proposal.money.amount = parseAmount(exact, decimals);
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
                const amount = readAmountText(field('amount').value, currency);
                const row = { ...previous, id: previous?.id ?? id('t'), currency: currency.id,
                    amount: parseAmount(field('sign').value + amount, currency.decimals),
                    note: field('note').value, date: previous?.kind === 'carried' ? null : field('date').value.trim() || null, kind: previous?.kind ?? 'entry',
                    counterparty: field('counterparty').value.trim(), loan: field('loan').checked };
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
    updatePendingSuggestions();
}
