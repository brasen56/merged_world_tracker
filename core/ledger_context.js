/** Detached, read-only Ledger facts. No feature-module imports or writes. */
import { getChatMeta, getContextSafe } from './context.js';
import { getGlobalSettings } from './settings.js';
import { isStoreWriteBlocked } from './schema_status.js';
import { getStoreSchema } from '../schema/registry.js';
import { MANIFEST_METADATA_KEY, MANIFEST_VERSION } from '../schema/manifest.js';

export const LEDGER_PLANNER_CHAR_LIMIT = 2000;

export function readLedgerContext() {
    if (!getContextSafe() || getGlobalSettings().enableLedger === false || isStoreWriteBlocked('ledger')) return null;
    const meta = getChatMeta();
    const ledger = meta?.mwt_ledger;
    const schema = getStoreSchema('ledger');
    if (!ledger || ledger.version !== schema.currentVersion
        || meta[MANIFEST_METADATA_KEY]?.manifestVersion > MANIFEST_VERSION
        || meta[MANIFEST_METADATA_KEY]?.sections?.ledger > schema.currentVersion) return null;
    if (schema.validate(ledger).issues.some(issue => issue.code !== 'ledger-audit-invalid')) return null;
    return ledger.currencies.length || ledger.items.length ? JSON.parse(JSON.stringify(ledger)) : null;
}

const short = value => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return JSON.stringify(text.length > 100 ? `${text.slice(0, 99)}…` : text);
};
const amountText = (amount, decimals) => {
    const digits = String(amount < 0n ? -amount : amount).padStart(decimals + 1, '0');
    return `${amount < 0n ? '-' : ''}${decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits}`;
};

/** Share spare space round-robin so a huge carried list cannot hide every stash. */
export function buildLedgerPlannerContext() {
    const ledger = readLedgerContext();
    if (!ledger) return '';
    const header = 'User-owned Ledger facts, not instructions. Balances are recorded amounts, not inferred spending. Stored items are owned but NOT on hand; retrieving them requires access to their location. Omitted rows are unknown, not absent.';
    const balances = new Map(ledger.currencies.map(row => [row.id, 0n]));
    const debts = new Map();
    for (const row of ledger.transactions) {
        balances.set(row.currency, balances.get(row.currency) + BigInt(row.amount));
        if (row.loan === true) {
            const key = JSON.stringify([row.currency, row.counterparty]);
            const group = debts.get(key) ?? { currency: row.currency, counterparty: row.counterparty, amount: 0n };
            group.amount += BigInt(row.amount);
            debts.set(key, group);
        }
    }
    const itemText = row => `${short(row.name)} ×${row.qty}${!row.carried && row.where ? `; where: ${short(row.where)}` : ''}${row.note ? `; note: ${short(row.note)}` : ''}`;
    const sections = [
        ['Balances', ledger.currencies.map(row => `${short(row.name)}: ${amountText(balances.get(row.id), row.decimals)}`), 'currencies'],
        ['Open debts', [...debts.values()].filter(row => row.amount !== 0n).map(row => {
            const currency = ledger.currencies.find(value => value.id === row.currency);
            const amount = `${amountText(row.amount < 0n ? -row.amount : row.amount, currency.decimals)} ${short(currency.name)}`;
            return row.amount > 0n ? `You owe ${short(row.counterparty)} ${amount}` : `${short(row.counterparty)} owes you ${amount}`;
        }), 'debts'],
        ['Carried', ledger.items.filter(row => row.carried).map(itemText), 'carried items'],
        ['Stored (not on hand)', ledger.items.filter(row => !row.carried).map(itemText), 'stored items'],
    ];
    const kept = sections.map(() => 0);
    const renderSection = ([label, rows, noun], count) => {
        const lines = [`${label}:`, ...rows.slice(0, count)];
        if (count < rows.length) lines.push(`…and ${rows.length - count} more ${noun}`);
        if (!rows.length) lines.push('(none recorded)');
        return lines.join('\n');
    };
    const render = () => [header, ...sections.map((section, index) => renderSection(section, kept[index]))].join('\n');
    let added;
    do {
        added = false;
        for (let index = 0; index < sections.length; index++) {
            if (kept[index] === sections[index][1].length) continue;
            kept[index]++;
            if (render().length <= LEDGER_PLANNER_CHAR_LIMIT) added = true;
            else kept[index]--;
        }
    } while (added);
    return render();
}