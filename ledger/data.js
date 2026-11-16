/** Pure Ledger v1 rules. No host, storage, clock, locale or random dependencies. */
export const LEDGER_VERSION = 1;
export const TRANSACTION_LIMIT = 200;
// Up to fifteen fractional digits; stored amounts must still be safe integers.
export const MAX_CURRENCY_DECIMALS = 15;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const safeBound = BigInt(Number.MAX_SAFE_INTEGER);

export function createLedger() {
    return { version: LEDGER_VERSION, currencies: [], transactions: [], items: [] };
}

function requireDecimals(decimals) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_CURRENCY_DECIMALS) {
        throw new RangeError(`Currency decimals must be an integer from 0 to ${MAX_CURRENCY_DECIMALS}.`);
    }
}

function safeNumber(value) {
    if (value > safeBound || value < -safeBound) throw new RangeError('Amount exceeds the safe integer range.');
    return Number(value);
}

/** Parse user text exactly; no rounding, exponent notation or floating-point multiplication. */
export function parseAmount(input, decimals = 0) {
    requireDecimals(decimals);
    if (typeof input !== 'string') throw new TypeError('Enter an amount as decimal text.');
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(input.trim());
    if (!match || (match[3]?.length ?? 0) > decimals) throw new TypeError('Invalid amount or too many fractional digits.');
    const magnitude = BigInt(match[2] + (match[3] ?? '').padEnd(decimals, '0'));
    return safeNumber(match[1] === '-' ? -magnitude : magnitude);
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
    if (record.version !== LEDGER_VERSION) fail(['version'], 'Ledger version must be 1.');
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
            } else {
                if (!text(row.name)) fail([...path, 'name'], 'Item name is required.');
                if (!Number.isSafeInteger(row.qty) || row.qty < 1) fail([...path, 'qty'], 'Quantity must be a safe integer of at least 1.');
                if (typeof row.carried !== 'boolean') fail([...path, 'carried'], 'Carried must be boolean.');
            }
            if (key !== 'currencies' && typeof row.note !== 'string') fail([...path, 'note'], 'Note must be text.');
        });
    }
    if (Array.isArray(record.currencies) && record.currencies.length && record.currencies.filter(row => row?.badge === true).length !== 1) {
        fail(['currencies'], 'Select exactly one badge currency.');
    }
    if (Array.isArray(record.transactions)) {
        const totals = new Map();
        for (const row of record.transactions) {
            if (!object(row) || !Number.isSafeInteger(row.amount)) continue;
            totals.set(row.currency, (totals.get(row.currency) ?? 0n) + BigInt(row.amount));
        }
        for (const [currency, total] of totals) {
            if (total > safeBound || total < -safeBound) fail(['transactions'], `Balance for ${currency} exceeds the safe integer range.`);
        }
    }
    return { valid: errors.length === 0, errors };
}

function requireLedger(record) {
    const result = validateLedgerRecord(record);
    if (!result.valid) throw new TypeError(result.errors.map(error => error.message).join(' '));
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
 * the smallest possible oldest prefix with one carried row per currency,
 * retaining the newest suffix. Each aggregate keeps its first source row's
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
    const groups = new Map();
    let end = 0;
    while (end < rows.length) {
        const row = rows[end++];
        const group = groups.get(row.currency) ?? { first: row, total: 0n };
        group.total += BigInt(row.amount);
        groups.set(row.currency, group);
        if (groups.size + rows.length - end <= limit) break;
    }
    if (groups.size + rows.length - end > limit) throw new RangeError('Transaction limit cannot hold one carried entry per currency.');
    const carried = [...groups.values()].map(({ first, total }) => ({
        ...first, amount: safeNumber(total), note: first.kind === 'carried' ? first.note : 'Carried forward', date: null, kind: 'carried',
    }));
    return { ...record, transactions: [...carried, ...rows.slice(end).map(row => ({ ...row }))] };
}