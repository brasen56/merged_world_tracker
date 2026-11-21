/** Explicit user commands, sharing the panel's validated persistence boundary. */
import { getChatMeta, getContextSafe } from '../core/context.js';
import { getGlobalSettings } from '../core/settings.js';
import { isStoreWriteBlocked } from '../core/schema_status.js';
import { MANIFEST_METADATA_KEY, MANIFEST_VERSION } from '../schema/manifest.js';
import { createLedger, validateLedgerRecord, parseAmount, formatAmount } from './data.js';
import { getLedger, saveLedger } from './store.js';
import { ledgerDate, ledgerId } from './audit.js';

/** Quoted multi-word names; apostrophes within unquoted words stay literal. */
function tokens(input) {
    const text = String(input ?? '').trim();
    const result = [];
    let index = 0;
    while (index < text.length) {
        if (/\s/.test(text[index])) { index++; continue; }
        let value = '';
        const quote = ['"', "'"].includes(text[index]) ? text[index++] : null;
        let closed = !quote;
        while (index < text.length) {
            const char = text[index++];
            if (quote && char === quote) { closed = true; break; }
            if (!quote && /\s/.test(char)) break;
            if (quote && char === '\\' && [quote, '\\'].includes(text[index])) value += text[index++];
            else value += char;
        }
        if (!closed || (quote && index < text.length && !/\s/.test(text[index]))) throw new Error('Use matching quotes around multi-word names.');
        if (!value.trim()) throw new Error('Names and arguments cannot be empty.');
        result.push({ value, quoted: !!quote });
    }
    return result;
}

function writableLedger() {
    if (!getContextSafe() || !getChatMeta()) throw new Error('No active chat.');
    if (getGlobalSettings().enableLedger === false) throw new Error('Ledger is disabled.');
    if (isStoreWriteBlocked('ledger')) throw new Error('Ledger is paused; repair or retry its schema before editing.');
    const manifest = getChatMeta()[MANIFEST_METADATA_KEY];
    const ledger = getLedger();
    if (manifest?.manifestVersion > MANIFEST_VERSION || manifest?.sections?.ledger > 2 || ledger?.version > 2) throw new Error('Ledger was written by a newer version.');
    if (ledger && !validateLedgerRecord(ledger).valid) throw new Error('Ledger is invalid; fix it in the Ledger tab before editing.');
    return ledger ?? createLedger();
}

function commit(ledger) {
    saveLedger(ledger);
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('mwt:ledger-changed'));
}

/** Currency may be omitted only for a single-currency ledger. No implicit money creation. */
export function ledgerAddCommand(input) {
    const [amount, ...args] = tokens(input).map(token => token.value);
    if (!amount) throw new Error('Usage: /wt-ledger-add <amount> [currency] [note]. Quote multi-word currency names.');
    const ledger = writableLedger();
    if (!ledger.currencies.length) throw new Error('Add a currency in the Ledger tab first.');
    const matches = args.length ? ledger.currencies.filter(row => row.name.toLowerCase() === args[0].toLowerCase()) : [];
    if (matches.length > 1) throw new Error('Currency name is ambiguous; use the Ledger tab.');
    let currency = matches[0];
    if (currency) args.shift();
    else if (ledger.currencies.length === 1) currency = ledger.currencies[0];
    else throw new Error('Specify an existing, unambiguous currency name.');
    const value = parseAmount(amount, currency.decimals);
    if (value === 0) throw new Error('Enter a nonzero amount.');
    ledger.transactions.push({ id: ledgerId(ledger, 't'), currency: currency.id, amount: value, kind: 'entry', note: args.join(' '), date: ledgerDate() });
    commit(ledger);
    return `Recorded ${formatAmount(value, currency.decimals)} ${currency.name}.${value < 0 ? ' Negative balances are allowed; this does not record a loan.' : ''}`;
}

/** Positive additions only: destructive edits and carry/storage choices stay in the panel. */
export function itemCommand(input) {
    const args = tokens(input);
    if (!args.length) throw new Error('Usage: /wt-item <name> [qty]. Quote multi-word or numeric-ending names. Quantity defaults to 1.');
    let qty = 1;
    const last = args.at(-1);
    // Numeric-looking unquoted arguments are quantities, even when malformed.
    // Quote a numeric-ending name to keep it literal rather than guessing.
    if (args.length > 1 && !last.quoted && /^(?:[+\-−]?(?:\d|\.\d)|[+\-]?(?:NaN|Infinity)$)/i.test(last.value)) {
        const { value } = args.pop();
        if (!/^\+?\d+$/.test(value)) throw new Error('Quantity must be a positive whole number.');
        qty = Number(value);
        if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('Quantity must be a positive safe whole number.');
    }
    const name = args.map(token => token.value).join(' ').trim();
    if (!name) throw new Error('Item name is required.');
    const ledger = writableLedger();
    const matches = ledger.items.filter(row => row.name.toLowerCase() === name.toLowerCase());
    if (matches.length > 1) throw new Error('Item name is ambiguous; use the Ledger tab.');
    if (matches.length) {
        if (!Number.isSafeInteger(matches[0].qty + qty)) throw new Error('Quantity exceeds the safe integer range.');
        matches[0].qty += qty;
    } else ledger.items.push({ id: ledgerId(ledger, 'i'), name, qty, carried: true, note: '' });
    commit(ledger);
    return `Added ${name} ×${qty}.${matches[0]?.carried === false ? ' Existing item remains Stored.' : ''}`;
}