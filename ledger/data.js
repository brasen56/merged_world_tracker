/** Pure Ledger rules. No host, storage, clock, locale or random dependencies. */
import { MAX_CURRENCY_DECIMALS, requireDecimals, safeNumber } from '../core/ledger_amount.js';
export { MAX_CURRENCY_DECIMALS, parseAmount } from '../core/ledger_amount.js';
export const LEDGER_VERSION = 2;
export const TRANSACTION_LIMIT = 500;
export const ITEM_LOG_LIMIT = 100;
export const TOMBSTONE_LIMIT = 300;
// Up to fifteen fractional digits; stored amounts must still be safe integers.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const safeBound = BigInt(Number.MAX_SAFE_INTEGER);

export function createLedger() {
    return { version: LEDGER_VERSION, currencies: [], transactions: [], items: [], itemLog: [], proposals: [] };
}

/** Exact, ungrouped major-unit text suitable for both display and editing. */
export function formatAmount(amount, decimals = 0) {
    requireDecimals(decimals);
    if (!Number.isSafeInteger(amount)) throw new RangeError('Amount must be a safe integer in minor units.');
    const digits = String(Math.abs(amount)).padStart(decimals + 1, '0');
    const body = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
    return `${amount < 0 ? '-' : ''}${body}`;
}

/** Compact badge in major units; Unicode minus, one decimal below 10k/10M/etc. */
export function formatCompactAmount(amount, decimals = 0) {
    const exact = formatAmount(amount, decimals);
    const magnitude = BigInt(Math.abs(amount));
    const scale = 10n ** BigInt(decimals);
    if (magnitude < 1000n * scale) return exact.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace('-', '−');
    const suffixes = ['', 'k', 'M', 'B', 'T', 'Q'];
    let unit = scale;
    let index = 0;
    while (magnitude >= unit * 1000n && index < suffixes.length - 1) { unit *= 1000n; index++; }
    let tenths = (magnitude * 10n + unit / 2n) / unit;
    // At 10+ units, round the exact value once. Rounding the already-rounded
    // tenths again would turn 10,450 into 10.5k and then 11k.
    if (tenths >= 100n) tenths = ((magnitude + unit / 2n) / unit) * 10n;
    if (tenths >= 10000n && index < suffixes.length - 1) { index++; tenths = 10n; }
    const body = tenths % 10n ? `${tenths / 10n}.${tenths % 10n}` : String(tenths / 10n);
    return `${amount < 0 ? '−' : ''}${body}${suffixes[index]}`;
}

/**
 * Non-destructive validation of the persisted shape. Unknown fields survive.
 * Exactly one badge currency is required when currencies exist. The log cap
 * is a write operation, not a validation repair; long imported logs stay intact.
 */
export function validateLedgerRecord(record) {
    const errors = [];
    const fail = (path, message) => errors.push({ path, message });
    if (!object(record)) return { valid: false, errors: [{ path: [], message: 'Ledger must be an object.' }] };
    if (record.version !== LEDGER_VERSION) fail(['version'], 'Ledger version must be 2.');
    for (const key of ['proposals', 'itemLog']) {
        if (record[key] !== undefined && !Array.isArray(record[key])) fail([key], `${key} must be an array.`);
    }
    const ids = new Set();
    for (const key of ['currencies', 'transactions', 'items']) {
        if (!Array.isArray(record[key])) { fail([key], `${key} must be an array.`); continue; }
        record[key].forEach((row, index) => {
            const path = [key, index];
            if (!object(row)) { fail(path, 'Each row must be an object.'); return; }
            if (!text(row.id) || ids.has(row.id)) fail([...path, 'id'], 'IDs must be nonempty and unique across the ledger.');
            else ids.add(row.id);
            if (key === 'currencies') {
                if (!text(row.name)) fail([...path, 'name'], 'Currency name is required.');
                if (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > MAX_CURRENCY_DECIMALS) {
                    fail([...path, 'decimals'], `Decimals must be an integer from 0 to ${MAX_CURRENCY_DECIMALS}.`);
                }
                if (typeof row.badge !== 'boolean') fail([...path, 'badge'], 'Badge must be boolean.');
            } else if (key === 'transactions') {
                if (!text(row.currency) || !Array.isArray(record.currencies) || !record.currencies.some(currency => object(currency) && currency.id === row.currency)) {
                    fail([...path, 'currency'], 'Transaction must reference an existing currency.');
                }
                if (!Number.isSafeInteger(row.amount)) fail([...path, 'amount'], 'Amount must be a safe integer in minor units.');
                if (!['entry', 'carried'].includes(row.kind)) fail([...path, 'kind'], 'Kind must be entry or carried.');
                if (row.date !== null && typeof row.date !== 'string') fail([...path, 'date'], 'Date must be text or null.');
                if (row.kind === 'carried' && row.date !== null) fail([...path, 'date'], 'Carried-forward entries have no date.');
                if (row.counterparty !== undefined && typeof row.counterparty !== 'string') fail([...path, 'counterparty'], 'Counterparty must be text.');
                if (row.loan !== undefined && typeof row.loan !== 'boolean') fail([...path, 'loan'], 'Loan must be boolean.');
                if (row.loan === true && !text(row.counterparty)) fail([...path, 'counterparty'], 'Loans require a counterparty.');
                if (row.source !== undefined && !text(row.source)) fail([...path, 'source'], 'Source must be a nonempty proposal ID.');
            } else {
                if (!text(row.name)) fail([...path, 'name'], 'Item name is required.');
                if (!Number.isSafeInteger(row.qty) || row.qty < 1) fail([...path, 'qty'], 'Quantity must be a safe integer of at least 1.');
                if (typeof row.carried !== 'boolean') fail([...path, 'carried'], 'Carried must be boolean.');
                if (row.pinned !== undefined && typeof row.pinned !== 'boolean') fail([...path, 'pinned'], 'Pinned must be boolean.');
                if (row.where !== undefined && typeof row.where !== 'string') fail([...path, 'where'], 'Storage location must be text.');
            }
            if (key !== 'currencies' && typeof row.note !== 'string') fail([...path, 'note'], 'Note must be text.');
        });
    }
    if (Array.isArray(record.currencies) && record.currencies.length && record.currencies.filter(row => row?.badge === true).length !== 1) {
        fail(['currencies'], 'Select exactly one badge currency.');
    }
    if (Array.isArray(record.transactions)) {
        const totals = new Map();
        const debts = new Map();
        for (const row of record.transactions) {
            if (!object(row) || !Number.isSafeInteger(row.amount)) continue;
            totals.set(row.currency, (totals.get(row.currency) ?? 0n) + BigInt(row.amount));
            if (row.loan === true) {
                const key = JSON.stringify([row.currency, row.counterparty]);
                debts.set(key, (debts.get(key) ?? 0n) + BigInt(row.amount));
            }
        }
        for (const [currency, total] of totals) {
            if (total > safeBound || total < -safeBound) fail(['transactions'], `Balance for ${currency} exceeds the safe integer range.`);
        }
        for (const total of debts.values()) {
            if (total > safeBound || total < -safeBound) fail(['transactions'], 'Debt net exceeds the safe integer range.');
        }
    }
    return { valid: errors.length === 0, errors };
}

function requireLedger(record) {
    const result = validateLedgerRecord(record);
    if (!result.valid) throw new TypeError(result.errors.map(error => error.message).join(' '));
}

/** Audit failures never deactivate money. Consumers use only the returned rows. */
export function validateLedgerAudit(record) {
    const errors = [];
    const result = { proposals: [], itemLog: [], errors };
    for (const key of ['proposals', 'itemLog']) {
        const ids = new Set();
        const rows = record?.[key];
        if (rows === undefined) continue;
        if (!Array.isArray(rows)) { errors.push({ path: [key], message: `${key} must be an array.` }); continue; }
        rows.forEach((row, index) => {
            let valid = object(row) && text(row.id) && !ids.has(row.id);
            if (object(row) && text(row.id)) ids.add(row.id);
            if (valid && key === 'proposals') {
                valid = ['pending', 'accepted', 'rejected'].includes(row.status) && text(row.evidence)
                    && object(row.msg) && text(row.msg.identity) && text(row.msg.digest)
                    && (row.counterparty === undefined || typeof row.counterparty === 'string');
                if (row.kind === 'money') {
                    valid = valid && object(row.money) && text(row.money.currency) && Number.isSafeInteger(row.money.amount)
                        && row.money.amount !== 0 && (row.money.loan === undefined || typeof row.money.loan === 'boolean')
                        && (row.money.loan !== true || text(row.counterparty));
                } else if (row.kind === 'item') {
                    valid = valid && object(row.item) && text(row.item.name) && Number.isSafeInteger(row.item.qtyChange)
                        && row.item.qtyChange !== 0 && (row.item.carried === undefined || typeof row.item.carried === 'boolean');
                } else valid = false;
            } else if (valid) {
                valid = row.auditRejected !== 'duplicate' && text(row.name) && ['added', 'removed', 'qty', 'note', 'carried', 'edited'].includes(row.change)
                    && typeof row.detail === 'string' && text(row.source) && (row.date === null || typeof row.date === 'string');
            }
            if (valid) result[key].push(row);
            else errors.push({ path: [key, index], message: `Malformed ${key} row skipped.` });
        });
    }
    return { ...result, valid: errors.length === 0 };
}

/** Exact free-text counterparties; positive means the player borrowed money. */
export function computeDebts(record) {
    requireLedger(record);
    const groups = new Map();
    for (const row of record.transactions) {
        if (row.loan !== true) continue;
        const key = JSON.stringify([row.currency, row.counterparty]);
        const group = groups.get(key) ?? { currency: row.currency, counterparty: row.counterparty, total: 0n };
        group.total += BigInt(row.amount);
        groups.set(key, group);
    }
    return [...groups.values()].filter(row => row.total !== 0n).map(({ total, ...row }) => ({ ...row, amount: safeNumber(total) }));
}

/** Stable partition: pin priority never makes Stored possessions on-hand. */
export function orderCarriedItems(items) {
    const carried = items.filter(row => row.carried);
    return [...carried.filter(row => row.pinned === true), ...carried.filter(row => row.pinned !== true)];
}

/** Explicit write helper. A marker survives subsequent appends; reads never trim. */
export function appendItemLog(record, entries, limit = ITEM_LOG_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Item log limit must be positive.');
    const rows = [...(record.itemLog ?? []), ...entries];
    const audit = validateLedgerAudit({ itemLog: rows });
    const invalid = new Set(audit.errors.map(error => error.path[1]));
    let remaining = audit.itemLog.length;
    const trimmedIds = new Set();
    const itemLog = rows.flatMap((row, index) => {
        if (invalid.has(index)) {
            // Preserve rejected content, but persist its status when trimming
            // removes the ID owner that previously kept it out of history.
            return [object(row) && trimmedIds.has(row.id) ? { ...row, auditRejected: 'duplicate' } : row];
        }
        if (remaining-- > limit) { trimmedIds.add(row.id); return []; }
        return [row];
    });
    return { ...record, itemLog, ...(rows.length !== itemLog.length ? { itemLogTrimmed: true } : {}) };
}

/** Diff only; callers supply IDs and the display-only date when committing. */
export function diffItems(previous, next, { source = 'user', date = null } = {}) {
    const before = new Map(previous.map(row => [row.id, row]));
    const after = new Map(next.map(row => [row.id, row]));
    const changes = [];
    const add = (row, change, detail) => changes.push({ name: row.name, change, detail, source, date });
    for (const row of previous) if (!after.has(row.id)) add(row, 'removed', `Removed ×${row.qty}`);
    for (const row of next) {
        const old = before.get(row.id);
        if (!old) { add(row, 'added', `Added ×${row.qty}`); continue; }
        for (const key of ['qty', 'note', 'carried']) {
            if (old[key] !== row[key]) add(row, key, `${old[key]} → ${row[key]}`);
        }
        for (const key of ['name', 'pinned', 'where']) {
            if ((old[key] ?? (key === 'pinned' ? false : '')) !== (row[key] ?? (key === 'pinned' ? false : ''))) {
                add(row, 'edited', `${key}: ${old[key] ?? ''} → ${row[key] ?? ''}`);
            }
        }
    }
    return changes;
}

/** Map avoids special object-key hazards in user-provided currency IDs. */
export function computeBalances(record) {
    requireLedger(record);
    const totals = new Map(record.currencies.map(currency => [currency.id, 0n]));
    for (const row of record.transactions) totals.set(row.currency, totals.get(row.currency) + BigInt(row.amount));
    return new Map([...totals].map(([id, total]) => [id, safeNumber(total)]));
}

/** Empty text means there is no badge currency, not a zero balance. */
export function formatLedgerBadge(record) {
    const totals = computeBalances(record);
    const currency = record.currencies.find(row => row.badge);
    return currency ? formatCompactAmount(totals.get(currency.id), currency.decimals) : '';
}

/** Refuse currency deletion while any transactions (including zero totals) reference it. */
export function canDeleteCurrency(record, currencyId) {
    requireLedger(record);
    return record.currencies.some(row => row.id === currencyId) && !record.transactions.some(row => row.currency === currencyId);
}

/**
 * Transactions are stored oldest first (the UI reverses for display). Replace
 * the smallest possible oldest prefix with a plain carry per currency and
 * one carry per nonzero loan group, retaining the newest suffix.
 * Each aggregate keeps a consumed source row's
 * identity: no new/recycled IDs, timestamps or randomness are needed. Existing
 * carried rows participate in later folds just like entries; zero sums remain.
 * A carried row is always the oldest, so it is re-folded on every save past
 * the cap: it keeps the note the user gave it instead of being reset.
 * Impossible caps and unsafe aggregates fail without changing the caller.
 */
export function foldTransactions(record, limit = TRANSACTION_LIMIT) {
    requireLedger(record);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Transaction limit must be a positive safe integer.');
    const rows = record.transactions;
    if (rows.length <= limit) return { ...record, transactions: rows.map(row => ({ ...row })) };
    const plain = new Map();
    const loans = new Map();
    const currencies = new Map();
    const carriedGroups = () => {
        const groups = [...currencies].map(([id, first]) => plain.get(id) ?? { first, total: 0n, loan: false });
        return [...groups, ...[...loans.values()].filter(group => group.total !== 0n)];
    };
    let end = 0;
    while (end < rows.length) {
        const row = rows[end++];
        if (!currencies.has(row.currency)) currencies.set(row.currency, row);
        const groups = row.loan === true ? loans : plain;
        const key = row.loan === true ? JSON.stringify([row.currency, row.counterparty]) : row.currency;
        const group = groups.get(key) ?? { first: row, total: 0n, loan: row.loan === true };
        group.total += BigInt(row.amount);
        groups.set(key, group);
        if (carriedGroups().length + rows.length - end <= limit) break;
    }
    if (carriedGroups().length + rows.length - end > limit) throw new RangeError('Transaction limit cannot hold currencies and open debts.');
    const used = new Set();
    const reserved = new Set(carriedGroups().filter(group => group.loan || group.first.loan !== true).map(group => group.first.id));
    const carried = carriedGroups().map(({ first, total, loan }) => {
        // A loan-only currency still needs a plain zero carry. Use a distinct
        // source identity for it; never duplicate the loan aggregate's ID.
        let id = first.id;
        if (used.has(id) || (!loan && first.loan === true && total === 0n && [...loans.values()].some(g => g.first.id === id && g.total !== 0n))) {
            id = rows.slice(0, end).find(row => !reserved.has(row.id) && !used.has(row.id)).id;
        }
        used.add(id);
        const result = { ...first, id, amount: safeNumber(total), note: first.kind === 'carried' && (first.loan === true) === loan ? first.note : loan ? 'Carried forward (owed)' : 'Carried forward', date: null, kind: 'carried' };
        delete result.source;
        if (loan) result.loan = true;
        else { delete result.loan; delete result.counterparty; }
        return result;
    });
    return { ...record, transactions: [...carried, ...rows.slice(end).map(row => ({ ...row }))] };
}