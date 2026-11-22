/** Read-only projection shared by the panel, floating button and Overview. */
import { getLedger } from './store.js';
import { computeBalances, formatAmount, formatLedgerBadge, validateLedgerAudit, validateLedgerRecord } from './data.js';

export function getStatus() {
    const record = getLedger();
    if (!record) return { badge: '', currency: '', balance: '', totals: [], carried: 0, state: 'No ledger yet' };
    if (!validateLedgerRecord(record).valid) throw new Error('Ledger is invalid or from a newer version. Open Diagnostics before editing.');
    const balances = computeBalances(record);
    const currency = record.currencies.find(row => row.badge);
    return {
        badge: formatLedgerBadge(record), currency: currency?.name ?? '',
        balance: currency ? formatAmount(balances.get(currency.id), currency.decimals) : '',
        totals: record.currencies.map(row => `${formatAmount(balances.get(row.id), row.decimals)} ${row.name}`),
        carried: record.items.filter(row => row.carried).length,
        pending: validateLedgerAudit(record).proposals.filter(row => row.status === 'pending').length,
        state: 'Ready',
    };
}