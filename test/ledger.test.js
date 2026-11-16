import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    createLedger, parseAmount, formatAmount, formatCompactAmount, computeBalances,
    formatLedgerBadge, validateLedgerRecord, foldTransactions, canDeleteCurrency,
    TRANSACTION_LIMIT, MAX_CURRENCY_DECIMALS,
} from '../ledger/data.js';
import { ledgerSchema, validateLedgerData } from '../ledger/schema.js';
import { prepareStore, prepareNextStoreValue, getPolicyCategory } from '../core/schema.js';

const currency = (id = 'c1', decimals = 0, badge = true) => ({ id, name: id, decimals, badge });
const entry = (id, amount, currencyId = 'c1') => ({ id, amount, currency: currencyId, note: '', date: null, kind: 'entry' });
const ledger = (transactions = []) => ({ ...createLedger(), currencies: [currency()], transactions });

function freezeDeep(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freezeDeep);
        Object.freeze(value);
    }
    return value;
}

describe('Ledger exact amounts', () => {
    test.each([
        ['0.10', 2, 10], ['0.20', 2, 20], ['-12.34', 2, -1234],
        [' +001.2 ', 2, 120], ['0', 0, 0], ['-0.00', 2, 0],
        ['90071992547409.91', 2, Number.MAX_SAFE_INTEGER],
        ['-90071992547409.91', 2, -Number.MAX_SAFE_INTEGER],
        ['0.000000000000001', 15, 1],
    ])('parses %s with %i decimals exactly', (input, decimals, expected) => {
        expect(parseAmount(input, decimals)).toBe(expected);
        expect(parseAmount(formatAmount(expected, decimals), decimals)).toBe(expected);
    });

    test.each(['', ' ', '.', '.5', '1.', '1e2', '1,000', 'NaN', 'Infinity', '--1', '1 2', '0.001', '90071992547409.92'])('rejects %j without rounding', input => {
        expect(() => parseAmount(input, 2)).toThrow();
    });

    test('rejects numeric input, unsafe minor units and invalid decimal settings', () => {
        expect(() => parseAmount(0.1, 2)).toThrow();
        for (const decimals of [-1, 1.5, MAX_CURRENCY_DECIMALS + 1, NaN, '2']) {
            expect(() => parseAmount('1', decimals)).toThrow();
            expect(() => formatAmount(1, decimals)).toThrow();
        }
        for (const amount of [0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
            expect(() => formatAmount(amount, 2)).toThrow();
        }
        expect(() => parseAmount('1.0', 0)).toThrow();
        expect(formatAmount(1, 2)).toBe('0.01');
        expect(formatAmount(-1, 2)).toBe('-0.01');
    });

    test.each([
        [500, 0, '500'], [1200, 0, '1.2k'], [12000, 0, '12k'],
        [-40, 0, '−40'], [0, 2, '0'], [10, 2, '0.1'],
        [123450, 2, '1.2k'], [999950, 0, '1M'],
        [999999999, 0, '1B'], [Number.MAX_SAFE_INTEGER, 0, '9Q'],
        [99999, 2, '999.99'], [-1, 15, '−0.000000000000001'],
        // Rounded once from the exact value, never from rounded tenths.
        [9949, 0, '9.9k'], [9950, 0, '10k'], [10449, 0, '10k'], [10450, 0, '10k'],
        [10499, 0, '10k'], [10500, 0, '11k'], [-10450, 0, '−10k'], [1045000, 2, '10k'],
        [999499, 0, '999k'], [999500, 0, '1M'],
    ])('formats %i minor units (%i decimals) as %s', (amount, decimals, expected) => {
        expect(formatCompactAmount(amount, decimals)).toBe(expected);
    });
});

describe('Ledger balances and validation', () => {
    test('empty defaults are independent and have no badge', () => {
        const first = createLedger();
        first.items.push({});
        expect(createLedger().items).toEqual([]);
        expect(validateLedgerRecord(createLedger()).valid).toBe(true);
        expect(formatLedgerBadge(createLedger())).toBe('');
    });

    test('sums minor units, unused currencies, debt and special-key IDs', () => {
        const record = ledger([entry('t1', 10), entry('t2', 20), entry('t3', -40, '__proto__')]);
        record.currencies = [currency('c1', 2), currency('__proto__', 0, false), currency('unused', 0, false)];
        expect(computeBalances(record)).toEqual(new Map([['c1', 30], ['__proto__', -40], ['unused', 0]]));
        expect(formatLedgerBadge(record)).toBe('0.3');
        expect(canDeleteCurrency(record, 'c1')).toBe(false);
        expect(canDeleteCurrency(record, 'unused')).toBe(true);
        expect(canDeleteCurrency(record, 'missing')).toBe(false);
        expect(formatLedgerBadge(ledger())).toBe('0');
    });

    test('BigInt intermediates allow cancellation but final overflow is refused', () => {
        const record = ledger([entry('t1', Number.MAX_SAFE_INTEGER), entry('t2', 1), entry('t3', -1)]);
        expect(computeBalances(record).get('c1')).toBe(Number.MAX_SAFE_INTEGER);
        record.transactions.pop();
        expect(validateLedgerRecord(record).valid).toBe(false);
        expect(() => computeBalances(record)).toThrow();
    });

    test.each([
        record => { record.version = 2; },
        record => { record.currencies = { some: 'bad' }; },
        record => { record.transactions = null; },
        record => { record.items = {}; },
        record => { record.currencies[0].decimals = -1; },
        record => { record.currencies[0].badge = false; },
        record => { record.currencies.push(currency('c2')); },
        record => { record.currencies[0].name = ' '; },
        record => { record.transactions[0].currency = 'missing'; },
        record => { record.transactions[0].amount = 0.1; },
        record => { record.transactions[0].kind = 'automatic'; },
        record => { record.transactions[0].date = 123; },
        record => { record.transactions[0].note = null; },
        record => { record.transactions[0].id = 'c1'; },
        record => { record.transactions.push(null); },
        record => { record.items.push({ id: 'i1', name: 'Rope', qty: 0, note: '', carried: true }); },
        record => { record.items.push({ id: 'i1', name: '', qty: 1.5, note: 2, carried: 'yes' }); },
        record => { record.transactions[0].kind = 'carried'; record.transactions[0].date = 'Yesterday'; },
    ])('rejects invalid records without mutating or silently fixing them (%#)', mutate => {
        const record = ledger([entry('t1', 10)]);
        mutate(record);
        const snapshot = JSON.stringify(record);
        freezeDeep(record);
        expect(validateLedgerRecord(record).valid).toBe(false);
        expect(() => computeBalances(record)).toThrow();
        expect(JSON.stringify(record)).toBe(snapshot);
    });

    test.each([null, undefined, [], 'bad', 1])('handles invalid root %j', input => {
        expect(validateLedgerRecord(input).valid).toBe(false);
        expect(validateLedgerData(input).issues[0].severity).toBe('fatal');
    });
});

describe('Ledger fold-forward', () => {
    test('folds at 201, preserves newest entries, balances, extra fields and input', () => {
        const record = ledger(Array.from({ length: 201 }, (_, index) => entry(`t${index}`, index - 100)));
        record.items = [{ id: 'i1', name: 'Sword', qty: 1, note: '', carried: true }];
        record.extra = 'retained';
        freezeDeep(record);
        const folded = foldTransactions(record);
        expect(folded.transactions).toHaveLength(TRANSACTION_LIMIT);
        expect(folded.transactions[0]).toEqual({ ...entry('t0', -199), kind: 'carried', note: 'Carried forward' });
        expect(folded.transactions.slice(1)).toEqual(record.transactions.slice(2));
        expect(computeBalances(folded)).toEqual(computeBalances(record));
        expect(folded.items).toEqual(record.items);
        expect(folded.extra).toBe('retained');
        expect(foldTransactions(folded)).toEqual(folded);
        expect(record.transactions).toHaveLength(201);
    });

    test('multi-currency repeated folding preserves every balance, including zero sums', () => {
        let record = ledger();
        record.currencies.push(currency('c2', 2, false), currency('c3', 0, false));
        const expected = new Map(record.currencies.map(row => [row.id, 0]));
        for (let index = 0; index < 1200; index++) {
            const id = `c${index % 3 + 1}`;
            const amount = index % 2 ? 7 : -7;
            record.transactions.push(entry(`t${index}`, amount, id));
            expected.set(id, expected.get(id) + amount);
            record = foldTransactions(record, 20);
            expect(record.transactions.length).toBeLessThanOrEqual(20);
            expect(computeBalances(record)).toEqual(expected);
            expect(validateLedgerRecord(record).valid).toBe(true);
        }
        const zero = foldTransactions(ledger([entry('t1', 5), entry('t2', -5)]), 1);
        expect(zero.transactions[0].amount).toBe(0);
        expect(canDeleteCurrency(zero, 'c1')).toBe(false);
    });

    test('re-folding keeps a carried row\'s edited note; new aggregates get the default', () => {
        const carried = { ...entry('t0', 40), kind: 'carried', note: 'Corrected opening purse' };
        const record = ledger([carried, entry('t1', 5), entry('t2', 6)]);
        const folded = foldTransactions(record, 2);
        expect(folded.transactions[0]).toMatchObject({ id: 't0', amount: 45, kind: 'carried', note: 'Corrected opening purse' });
        expect(computeBalances(folded)).toEqual(computeBalances(record));
        const fresh = foldTransactions(ledger([entry('t1', 5, 'c1'), entry('t2', 6), entry('t3', 7)]), 2);
        expect(fresh.transactions[0].note).toBe('Carried forward');
    });

    test('refuses impossible caps and unsafe aggregates without mutation', () => {
        const record = ledger([entry('t1', 1), entry('t2', 2, 'c2'), entry('t3', 3)]);
        record.currencies.push(currency('c2', 0, false));
        freezeDeep(record);
        for (const limit of [0, -1, 1.5, 1, NaN]) expect(() => foldTransactions(record, limit)).toThrow();
        const overflow = ledger([entry('t1', Number.MAX_SAFE_INTEGER), entry('t2', 1), entry('t3', -1)]);
        expect(() => foldTransactions(overflow, 2)).toThrow(/safe integer/);
        expect(computeBalances(foldTransactions(overflow, 1))).toEqual(computeBalances(overflow));
    });
});

describe('Ledger schema contract and purity', () => {
    test('default, migration and current preparation are valid and idempotent', () => {
        expect(ledgerSchema.metadataKey).toBe('mwt_ledger');
        expect(ledgerSchema.validate(ledgerSchema.createDefault()).issues).toEqual([]);
        const input = freezeDeep(ledger([entry('t1', 50)]));
        const first = prepareStore(ledgerSchema, input);
        expect(first.status).toBe('migrated');
        expect(first.data).toEqual(input);
        const second = prepareStore(ledgerSchema, first.data, { version: 1 });
        expect(second.status).toBe('valid');
        expect(second.changed).toBe(false);
        expect(second.quarantined).toEqual([]);
        expect(prepareStore(ledgerSchema, input, { version: 2 }).status).toBe('blocked');
        expect(prepareStore(ledgerSchema, null, { version: 1 }).status).toBe('blocked');
    });

    test('readable invalid records are retained, findings are classified, bad roots fail writes', () => {
        const input = ledger([entry('t1', 0.5)]);
        const result = prepareStore(ledgerSchema, input, { version: 1 });
        expect(result.data).toEqual(input);
        expect(result.quarantined).toEqual([]);
        expect(result.issues.length).toBeGreaterThan(0);
        for (const issue of result.issues) expect(getPolicyCategory(ledgerSchema.policy, issue.code)).toBe('reference');
        expect(getPolicyCategory(ledgerSchema.policy, 'root-not-object')).toBe('fatal');
        expect(prepareNextStoreValue(ledgerSchema, 'bad', {}).ok).toBe(false);
        expect(prepareNextStoreValue(ledgerSchema, undefined, {}).data).toEqual(createLedger());
    });

    test('pure core has no imports; descriptor imports only shared schema and pure rules', () => {
        const source = file => readFileSync(new URL(file, import.meta.url), 'utf8');
        const imports = text => [...text.matchAll(/(?:from\s|import\s)['"]([^'"]+)['"]/g)].map(match => match[1]);
        expect(imports(source('../ledger/data.js'))).toEqual([]);
        expect(imports(source('../ledger/schema.js'))).toEqual(['../core/schema.js', './data.js']);
        for (const file of ['../ledger/data.js', '../ledger/schema.js']) {
            expect(source(file)).not.toMatch(/\b(document|window|globalThis|SillyTavern|getContext)\s*\./);
        }
    });
});