import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    createLedger, validateLedgerRecord, validateLedgerAudit, computeBalances, computeDebts,
    foldTransactions, orderCarriedItems, appendItemLog, diffItems, ITEM_LOG_LIMIT, TRANSACTION_LIMIT,
} from '../ledger/data.js';
import { ledgerSchema } from '../ledger/schema.js';
import { prepareStore, prepareNextStoreValue } from '../core/schema.js';
import { buildInjectionBody } from '../ledger/injection.js';
import { cutLedgerReport, parseLedgerReport, resolveLedgerReport, ledgerProposalKey, ledgerMessageDigest } from '../core/ledger_report.js';

const currency = (id = 'gold', badge = true) => ({ id, name: id, decimals: 0, badge });
const entry = (id, amount, extra = {}) => ({ id, amount, currency: 'gold', note: '', date: null, kind: 'entry', ...extra });
const item = (id, extra = {}) => ({ id, name: id, qty: 2, carried: true, note: '', ...extra });
const ledger = (transactions = []) => ({ ...createLedger(), currencies: [currency()], transactions });
const loan = (id, amount, counterparty = 'Aldric', extra = {}) => entry(id, amount, { loan: true, counterparty, ...extra });
const evidence = 'She counted out thirty gold coins and pressed them into his palm.';
const line = { kind: 'money', currency: ' GOLD ', amount: '-30', evidence };
const chat = [{ mes: evidence, extra: { mwt_uuid: 'one' } }, { mes: evidence, extra: { mwt_uuid: 'two' } }];
const records = [{ index: 0, identity: 'uuid:one', text: evidence, digest: ledgerMessageDigest(evidence) },
    { index: 1, identity: 'uuid:two', text: evidence, digest: ledgerMessageDigest(evidence) }];
const options = extra => ({ ledger: ledger(), chat, records, ...extra });
const proposal = extra => ({ id: 'p1', kind: 'money', money: { currency: 'gold', amount: -30, loan: false },
    evidence, msg: { identity: 'uuid:one', digest: ledgerMessageDigest(evidence) }, status: 'pending', ...extra });
const log = id => ({ id, name: 'Rope', change: 'qty', detail: '2 → 1', source: 'user', date: null });

test('empty reports do not inspect chat or tombstones', () => {
    const unreadable = new Proxy([], { get() { throw new Error('Unexpected traversal'); } });
    expect(resolveLedgerReport([], options({ chat: unreadable, proposals: unreadable }))).toEqual({ proposals: [], dropped: [] });
});

test('reports index aliases once rather than rescanning chat for every tombstone', () => {
    const readSlot = vi.fn(() => 'uuid:canonical');
    const messages = Array.from({ length: 5000 }, (_, index) => ({ mes: evidence, extra: { mwt_uuid: `legacy-${index}` },
        get mwt_ledger_identity() { return readSlot(); } }));
    const tombstones = Array.from({ length: 300 }, (_, index) => proposal({ id: `p-${index}`, status: 'accepted',
        msg: { identity: `uuid:legacy-${4700 + index}`, digest: ledgerMessageDigest(evidence) } }));
    const result = resolveLedgerReport([line], options({ chat: messages, proposals: tombstones,
        records: [{ ...records[0], identity: 'uuid:canonical' }] }));
    expect(result.dropped[0].reason).toBe('duplicate');
    // One index pass, plus the live-source check and quote matcher copy.
    expect(readSlot.mock.calls.length).toBeLessThanOrEqual(5002);
});

function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

describe('Ledger v2 validation and migration', () => {
    test('v1 migrates without rewriting rows, unknown fields, or existing audit arrays', () => {
        const old = { ...ledger([entry('t1', 15, { custom: 'preserved' })]), version: 1, custom: 'root' };
        delete old.proposals;
        delete old.itemLog;
        freeze(old);
        const migrated = prepareStore(ledgerSchema, old, { version: 1 });
        expect(migrated.status).toBe('migrated');
        expect(migrated.data).toEqual({ ...old, version: 2, proposals: [], itemLog: [] });
        expect(prepareStore(ledgerSchema, migrated.data, { version: 2 }).data).toEqual(migrated.data);
        expect(prepareStore(ledgerSchema, JSON.parse(JSON.stringify(migrated.data)), { version: 2 }).issues).toEqual([]);
        const enriched = { ...old, proposals: [proposal()], itemLog: [log('l1')] };
        expect(prepareStore(ledgerSchema, enriched, { version: 1 }).data).toEqual({ ...enriched, version: 2 });
    });

    test.each([
        { counterparty: 1 }, { loan: 'yes' }, { loan: true }, { loan: true, counterparty: ' ' }, { source: 1 },
    ])('rejects malformed money fields %j', extra => {
        expect(validateLedgerRecord(ledger([entry('t1', 1, extra)])).valid).toBe(false);
    });

    test('audit rows are independently skipped, retained on writes, and non-blocking', () => {
        const bad = { ...proposal(), msg: null };
        const record = ledger([loan('t1', 50)]);
        record.proposals = [bad, proposal({ id: 'p2' }), proposal({ id: 'p2' })];
        record.itemLog = [null, log('l1'), log('l1')];
        freeze(record);
        expect(validateLedgerRecord(record).valid).toBe(true);
        const audit = validateLedgerAudit(record);
        expect(audit.proposals.map(row => row.id)).toEqual(['p2']);
        expect(audit.itemLog.map(row => row.id)).toEqual(['l1']);
        expect(audit.errors).toHaveLength(4);
        expect(ledgerSchema.validate(record).issues.every(issue => issue.code === 'ledger-audit-invalid')).toBe(true);
        const saved = prepareNextStoreValue(ledgerSchema, record, record);
        expect(saved.ok).toBe(true);
        expect(saved.data).toEqual(record);
        expect(buildInjectionBody(record)).toContain('owes Aldric 50 gold');
        expect(validateLedgerRecord({ ...record, proposals: {} }).valid).toBe(false);
    });

    test('loan-net overflow is refused even if ordinary cash flow cancels it', () => {
        expect(validateLedgerRecord(ledger([loan('a', Number.MAX_SAFE_INTEGER), loan('b', 1), entry('c', -1)])).valid).toBe(false);
    });
});

describe('Debt-aware folding', () => {
    test('borrowing means you owe; purchases never create debts; repayment clears them', () => {
        const record = ledger([loan('t1', 50), entry('t2', -30, { counterparty: 'Shop' }), loan('t3', -20, 'Guild')]);
        expect(computeDebts(record)).toEqual([
            { currency: 'gold', counterparty: 'Aldric', amount: 50 }, { currency: 'gold', counterparty: 'Guild', amount: -20 },
        ]);
        const body = buildInjectionBody(record);
        expect(body).toContain('Debts: owes Aldric 50 gold; owed 20 gold by Guild.');
        expect(body).not.toContain('Shop');
        record.transactions.push(loan('t4', -50), loan('t5', 20, 'Guild'));
        expect(computeDebts(record)).toEqual([]);
        expect(buildInjectionBody(record)).not.toContain('Debts:');
    });

    test('zero-net loan history joins the plain carry and edited loan notes survive', () => {
        const record = ledger([loan('a', 50), loan('b', -50), entry('c', 7)]);
        expect(foldTransactions(record, 1).transactions).toEqual([{ ...entry('c', 7), kind: 'carried', note: 'Carried forward' }]);
        const open = ledger([loan('a', 50, 'Aldric', { kind: 'carried', note: 'Old unpaid tab', source: 'p1' }), loan('b', -20), entry('c', 7)]);
        const folded = foldTransactions(open, 2);
        expect(folded.transactions.find(row => row.loan)).toMatchObject({ amount: 30, note: 'Old unpaid tab' });
        expect(folded.transactions.every(row => row.source === undefined)).toBe(true);
        expect(computeDebts(folded)).toEqual(computeDebts(open));
        expect(foldTransactions(folded, 2)).toEqual(folded);
    });

    test('every feasible cap preserves currency balances and exact debt nets without mutation', () => {
        const record = ledger();
        record.currencies.push(currency('silver', false));
        for (let i = 0; i < 160; i++) {
            record.transactions.push(i % 3 ? loan(`t${i}`, i % 7 - 3, `Person ${i % 4}`, { currency: i % 2 ? 'gold' : 'silver' })
                : entry(`t${i}`, i % 9 - 4, { currency: i % 2 ? 'gold' : 'silver' }));
        }
        freeze(record);
        const minimum = record.currencies.length + computeDebts(record).length;
        for (let cap = minimum; cap <= record.transactions.length; cap++) {
            const folded = foldTransactions(record, cap);
            expect(folded.transactions.length).toBeLessThanOrEqual(cap);
            expect(validateLedgerRecord(folded).valid).toBe(true);
            expect(computeBalances(folded)).toEqual(computeBalances(record));
            expect(computeDebts(folded).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
                .toEqual(computeDebts(record).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
        }
        expect(TRANSACTION_LIMIT).toBe(500);
        expect(() => foldTransactions(ledger([loan('a', 1), loan('b', 2)]), 1)).toThrow(RangeError);
    });

    test('loan-only currencies get unique carry IDs and preserve debts on repeated folds', () => {
        let record = ledger();
        for (let i = 0; i < 100; i++) {
            record.transactions.push(loan(`t${i}`, i % 3 ? 1 : -1));
            record = foldTransactions(record, 2);
            expect(validateLedgerRecord(record).valid).toBe(true);
        }
        expect(computeDebts(record)[0].amount).toBe(32);
    });

    test('injection caps counterparties, not currency groups, and is honest about omissions', () => {
        const record = ledger(['A', 'B', 'C', 'D'].map((name, i) => loan(`t${i}`, 10, name)));
        record.currencies.push(currency('silver', false));
        record.transactions.push(loan('t4', -12, 'A', { currency: 'silver' }));
        const body = buildInjectionBody(record);
        expect(body.indexOf('Debts:')).toBeGreaterThan(body.indexOf('Money:'));
        expect(body).toContain('owed 12 silver by A');
        expect(body).toContain('…and 1 more counterparties');
        expect(body).not.toContain('owes D');
        expect(body).toContain('Listed loans are definite; unlisted ones may still exist.');
    });
});

describe('Inventory pure helpers', () => {
    test('pins stably win the carried cap without leaking stored items', () => {
        const items = Array.from({ length: 18 }, (_, i) => item(`i${i}`, { pinned: i >= 16, carried: i !== 17 }));
        freeze(items);
        expect(orderCarriedItems(items).slice(0, 2).map(row => row.id)).toEqual(['i16', 'i0']);
        const body = buildInjectionBody({ ...createLedger(), items });
        expect(body).toContain('Carried: i16 ×2; i0 ×2');
        expect(body).toContain('…and 2 more carried items');
        expect(body).not.toContain('i17');
    });

    test('diffs additions, removals and every user-controlled field without IDs or side effects', () => {
        const before = [item('rope'), item('gone')];
        const after = [item('rope', { qty: 1, note: 'cut', carried: false, where: 'Inn', pinned: true, name: 'Old rope' }), item('new')];
        freeze(before); freeze(after);
        const changes = diffItems(before, after, { source: 'p9', date: '14 March' });
        expect(changes.map(row => row.change)).toEqual(['removed', 'qty', 'note', 'carried', 'edited', 'edited', 'edited', 'added']);
        expect(changes.every(row => row.source === 'p9' && row.date === '14 March')).toBe(true);
        expect(diffItems(before, before)).toEqual([]);
    });

    test('ring caps valid history, records trimming, and preserves malformed stored rows', () => {
        const record = { ...createLedger(), itemLog: [null, ...Array.from({ length: ITEM_LOG_LIMIT }, (_, i) => log(`l${i}`))] };
        freeze(record);
        const next = appendItemLog(record, [log('latest')]);
        expect(next.itemLog[0]).toBe(null);
        expect(validateLedgerAudit(next).itemLog).toHaveLength(ITEM_LOG_LIMIT);
        expect(next.itemLog.at(-1).id).toBe('latest');
        expect(next.itemLogTrimmed).toBe(true);
        expect(appendItemLog(next, []).itemLogTrimmed).toBe(true);
        expect(() => appendItemLog(record, [], 0)).toThrow();
    });

    test.each([false, true])('trimmed ID owners cannot revive rejected duplicates (shared object: %s)', shared => {
        const first = log('l0');
        const duplicate = shared ? first : { ...first, detail: 'Rejected duplicate', custom: 'preserved' };
        const record = { ...createLedger(), itemLog: [first,
            ...Array.from({ length: ITEM_LOG_LIMIT }, (_, i) => log(`l${i + 1}`)), duplicate] };
        freeze(record);
        expect(validateLedgerAudit(record).itemLog).toHaveLength(ITEM_LOG_LIMIT + 1);

        const next = appendItemLog(record, []);
        const audit = validateLedgerAudit(next);
        expect(audit.itemLog.map(row => row.id)).toEqual(Array.from({ length: ITEM_LOG_LIMIT }, (_, i) => `l${i + 1}`));
        expect(audit.errors).toHaveLength(1);
        expect(next.itemLog.at(-1)).toMatchObject(duplicate);
        expect(next.itemLogTrimmed).toBe(true);

        const restored = JSON.parse(JSON.stringify(next));
        expect(validateLedgerAudit(restored).itemLog).toHaveLength(ITEM_LOG_LIMIT);
        expect(appendItemLog(restored, [])).toEqual(restored);
        const appended = appendItemLog(restored, [log('latest')]);
        expect(validateLedgerAudit(appended).itemLog.map(row => row.id)).toEqual([
            ...Array.from({ length: ITEM_LOG_LIMIT - 1 }, (_, i) => `l${i + 2}`), 'latest',
        ]);
        expect(validateLedgerAudit(appended).errors).toHaveLength(1);
    });
});

describe('Report cut, parse, evidence, resolution and dedupe', () => {
    test.each(['mwt-ledger-report', 'json', 'jsonl', 'ledger', ''])('accepts pretty JSON reports in trailing %j fences', tag => {
        for (const value of [line, [line]]) {
            const raw = `World document\n\`\`\`${tag}\n${JSON.stringify(value, null, 2)}\n\`\`\``;
            expect(cutLedgerReport(raw)).toMatchObject({ text: 'World document', lines: [line], dropped: [] });
        }
    });

    test('JSON arrays isolate bad rows and still require exact evidence and valid amounts', () => {
        const parsed = parseLedgerReport(JSON.stringify([null, { document: 'not a report' }, line, { ...line, evidence: 'An invented payment.' }, { ...line, amount: 30 }]));
        expect(parsed.lines).toHaveLength(3);
        expect(parsed.dropped.map(row => row.reason)).toEqual(['parse', 'parse']);
        const resolved = resolveLedgerReport(parsed.lines, options());
        expect(resolved.proposals).toHaveLength(1);
        expect(resolved.dropped.map(row => row.reason)).toEqual(['evidence', 'parse']);
        expect(parseLedgerReport('[]')).toEqual({ lines: [], dropped: [] });
        expect(parseLedgerReport('[[]]')).toMatchObject({ lines: [], dropped: [{ reason: 'parse' }] });
    });

    test.each(['mwt-ledger-report', 'json', 'jsonl', 'ledger', ''])('cuts trailing %j fence before normalisation', tag => {
        const raw = `<think>ignore this</think>World document\n\n\`\`\`${tag}\n${JSON.stringify(line)}\n\`\`\``;
        expect(cutLedgerReport(raw)).toMatchObject({ text: 'World document', lines: [line], dropped: [] });
        expect(cutLedgerReport(`PATCH OPS\n\`\`\`${tag}\n${JSON.stringify(line)}\n\`\`\``).text).toBe('PATCH OPS');
    });

    test.each(['json', 'jsonl', 'ledger', ''])('cuts mixed-validity trailing %j reports without losing parse drops', tag => {
        const document = '```markdown\nWorld document\n```';
        for (const block of [`${JSON.stringify(line)}\nnot json\n`, `not json\n${JSON.stringify(line)}\n`]) {
            const raw = `${document}\n\`\`\`${tag}\n${block}\`\`\``;
            expect(cutLedgerReport(raw)).toEqual({ text: document, block, lines: [line],
                dropped: [{ reason: 'parse', line: 'not json' }] });
            const nonTrailing = `${raw}\nMore document`;
            expect(cutLedgerReport(nonTrailing)).toMatchObject({ text: nonTrailing, block: null, lines: [], dropped: [] });
        }
        for (const tagName of [tag, 'text']) {
            const raw = `${document}\n\`\`\`${tagName}\n{"document":"world"}\nnot json\n\`\`\``;
            expect(cutLedgerReport(raw)).toEqual({ text: raw, block: null, lines: [], dropped: [] });
        }
    });

    test('garbage explicit reports and empty blocks are cut; unrelated document fences survive', () => {
        expect(cutLedgerReport('Doc\n```mwt-ledger-report\nnot json\n```')).toMatchObject({ text: 'Doc', lines: [], dropped: [{ reason: 'parse' }] });
        expect(cutLedgerReport('Doc\n```mwt-ledger-report\n\n```').text).toBe('Doc');
        for (const raw of ['```markdown\nWorld document\n```', '```\nWorld document\n```', 'No report']) {
            expect(cutLedgerReport(raw)).toMatchObject({ text: raw, block: null });
        }
        expect(parseLedgerReport(`${JSON.stringify(line)}\nwrong\nnull\n${JSON.stringify(line)}`)).toMatchObject({ lines: [line, line], dropped: [{ reason: 'parse' }, { reason: 'parse' }] });
    });

    test('earliest in-window live message wins, with receipt identity and raw digest', () => {
        freeze(chat); freeze(records);
        const result = resolveLedgerReport([line], options());
        expect(result.proposals[0]).toMatchObject({ money: { currency: 'gold', amount: -30, loan: false },
            msg: { identity: 'uuid:one', digest: ledgerMessageDigest(evidence) }, status: 'pending' });
        expect(result.dropped).toEqual([]);
    });

    test.each(['json', 'jsonl', 'ledger', ''])('cuts empty and valid JSON fallback fences (%j)', tag => {
        for (const body of ['', '\n', '[]', '{}', '[null]', 'null']) {
            const result = cutLedgerReport(`World document\n\`\`\`${tag}\n${body}\n\`\`\``);
            expect(result.text).toBe('World document');
            expect(result.lines).toEqual([]);
        }
    });

    test('explicit report ignores trailing chatter or unrelated fences', () => {
        for (const tail of ['Let me know if you need anything else!', '```text\nGoodbye!\n```']) {
            expect(cutLedgerReport(`World document\n\`\`\`mwt-ledger-report\n${JSON.stringify(line)}\n\`\`\`\n${tail}`))
                .toMatchObject({ text: 'World document', lines: [line] });
        }
    });

    test('an unclosed explicit report owns the rest of the output', () => {
        const row = JSON.stringify(line);
        expect(cutLedgerReport(`World document\n\`\`\`mwt-ledger-report\n${row}\n${row.slice(0, 20)}`))
            .toMatchObject({ text: 'World document', lines: [line], dropped: [{ reason: 'parse' }] });
        expect(cutLedgerReport('World document\r\n```mwt-ledger-report\r\n')).toMatchObject({ text: 'World document', lines: [] });
        expect(cutLedgerReport('World document\n``` MWT-Ledger-Report ')).toMatchObject({ text: 'World document', lines: [] });
        expect(cutLedgerReport(`\`\`\`markdown\nWorld document\n\`\`\`\n\`\`\`mwt-ledger-report\n${row}`))
            .toMatchObject({ text: '```markdown\nWorld document\n```', lines: [line] });
        // A complete report wins over a cut-off duplicate after it.
        expect(cutLedgerReport(`World document\n\`\`\`mwt-ledger-report\n${row}\n\`\`\`\n\`\`\`mwt-ledger-report\n{"kind"`))
            .toMatchObject({ text: 'World document', lines: [line], dropped: [] });
    });

    test.each(['json', 'jsonl', 'ledger', ''])('unclosed fallback %j fences are never cut', tag => {
        const raw = `World document\n\`\`\`${tag}\n${JSON.stringify(line)}`;
        expect(cutLedgerReport(raw)).toMatchObject({ text: raw, block: null });
    });

    test('counterparties are trimmed without changing case or internal spaces', () => {
        expect(resolveLedgerReport([{ ...line, loan: true, counterparty: '  Aldric the Smith \n' }], options()).proposals[0].counterparty)
            .toBe('Aldric the Smith');
        expect(resolveLedgerReport([{ ...line, loan: true, counterparty: '   ' }], options()).dropped[0].code).toBe('loan-counterparty');
    });

    test.each(['accepted', 'rejected'])('historical %s receipts dedupe by economic value after precision edits', status => {
        const record = ledger();
        const receipt = proposal({ status, money: { currency: 'gold', amount: -3000, decimals: 2 } });
        expect(resolveLedgerReport([line], options({ ledger: record, proposals: [receipt] })).dropped[0].reason).toBe('duplicate');
        expect(resolveLedgerReport([{ ...line, amount: '30' }], options({ ledger: record, proposals: [receipt] })).dropped[0].reason).toBe('contradictory');
        receipt.money.amount = -3050;
        expect(resolveLedgerReport([line], options({ ledger: record, proposals: [receipt] })).proposals).toHaveLength(1);
        record.currencies[0].decimals = 2;
        expect(resolveLedgerReport([{ ...line, amount: '-30.50' }], options({ ledger: record, proposals: [receipt] })).dropped[0].reason).toBe('duplicate');
    });

    test('historical precision is valid only on resolved receipts and within currency precision bounds', () => {
        for (const decimals of [-1, 16, 1.5, '2', null]) {
            const receipt = proposal({ status: 'rejected', money: { currency: 'gold', amount: -30, decimals } });
            expect(validateLedgerAudit({ proposals: [receipt] }).proposals).toEqual([]);
            expect(resolveLedgerReport([line], options({ proposals: [receipt] })).proposals).toHaveLength(1);
        }
        const pending = proposal({ money: { currency: 'gold', amount: -30, decimals: 0 } });
        expect(validateLedgerAudit({ proposals: [pending] }).proposals).toEqual([]);
        expect(resolveLedgerReport([line], options({ proposals: [pending] })).proposals).toHaveLength(1);
    });

    test('drops outside-window, changed, replaced, ILS, non-narrative and invented evidence', () => {
        const cases = [
            options({ records: [] }),
            options({ chat: [{ ...chat[0], mes: 'No payment happened.' }], records: [records[0]] }),
            options({ chat: [{ ...chat[0], extra: { mwt_uuid: 'replacement' } }], records: [records[0]] }),
            options({ chat: [{ ...chat[0], extra: { ...chat[0].extra, ILS_Data: {} } }], records: [records[0]] }),
            options({ chat: [{ ...chat[0], mes: `<details><summary>Tracker</summary>${evidence}</details>` }], records: [records[0]] }),
        ];
        for (const opts of cases) expect(resolveLedgerReport([line], opts).dropped[0]?.reason).toBe('evidence');
        expect(resolveLedgerReport([{ ...line, evidence: 'She paid a million dollars.' }], options()).dropped[0].reason).toBe('evidence');
    });

    test('resolves money exactly; unknown/duplicate names and malformed amounts are refused', () => {
        const record = ledger();
        record.currencies[0].decimals = 2;
        expect(resolveLedgerReport([{ ...line, amount: '12.50', loan: true, counterparty: 'Aldric' }], options({ ledger: record })).proposals[0].money.amount).toBe(1250);
        expect(resolveLedgerReport([{ ...line, currency: 'unknown' }], options()).dropped[0].reason).toBe('currency-unresolved');
        record.currencies.push({ ...currency('other', false), name: 'Gold' });
        expect(resolveLedgerReport([line], options({ ledger: record })).dropped[0].reason).toBe('currency-ambiguous');
        for (const extra of [{ amount: 3 }, { amount: '0' }, { amount: '1.1' }, { amount: '1e2' }, { loan: true }, { loan: 'yes' }]) {
            expect(resolveLedgerReport([{ ...line, ...extra }], options()).dropped[0].reason).toBe('parse');
        }
    });

    test('requires frozen evidence and digest; never falls back to live raw text', () => {
        for (const record of [
            { index: 0, identity: 'uuid:one' },
            { ...records[0], text: 'She walked home without making a purchase.' },
            { ...records[0], digest: 'wrong-revision' },
        ]) {
            expect(resolveLedgerReport([line], options({ records: [record] })))
                .toMatchObject({ proposals: [], dropped: [{ reason: 'evidence' }] });
        }
    });

    test('item decreases require an exact normalized existing name; increases can propose new items', () => {
        const report = { kind: 'item', name: ' ROPE ', qtyChange: '-1', evidence };
        const record = { ...ledger(), items: [item('i1', { name: 'Rope', carried: false })] };
        expect(resolveLedgerReport([report], options({ ledger: record })).proposals[0].item).toEqual({ name: 'Rope', qtyChange: -1 });
        expect(resolveLedgerReport([report], options()).dropped[0].reason).toBe('item-unmatched');
        expect(resolveLedgerReport([{ ...report, qtyChange: '2' }], options()).proposals[0].item).toEqual({ name: 'ROPE', qtyChange: 2 });
        expect(resolveLedgerReport([{ ...report, qtyChange: '2', carried: false }], options()).proposals[0].item.carried).toBe(false);
        expect(resolveLedgerReport([{ ...report, qtyChange: '-0.5' }], options()).dropped[0].reason).toBe('parse');
    });

    test.each(['pending', 'accepted', 'rejected'])('dedupes %s tombstones and duplicates within a harvest', status => {
        expect(resolveLedgerReport([line], options({ proposals: [proposal({ status })] }))).toMatchObject({ proposals: [], dropped: [{ reason: 'duplicate' }] });
        expect(resolveLedgerReport([line, line], options()).proposals).toHaveLength(1);
        expect(ledgerProposalKey(proposal({ status }))).toBe(ledgerProposalKey(proposal()));
        expect(ledgerProposalKey({ kind: 'item', item: { name: ' Rope ', qtyChange: 1 }, msg: { identity: 'uuid:one' } }))
            .toBe(ledgerProposalKey({ kind: 'item', item: { name: 'rope', qtyChange: 1 }, msg: { identity: 'uuid:one' } }));
        expect(ledgerProposalKey(null)).toBe(null);
    });

    test('malformed audit rows do not participate in dedupe', () => {
        for (const bad of [proposal({ status: 'stale' }), proposal({ evidence: '' }), proposal({ msg: { identity: 'uuid:one' } }),
            proposal({ money: { currency: 'gold', amount: -30, loan: true } })]) {
            expect(resolveLedgerReport([line], options({ proposals: [bad] })).proposals).toHaveLength(1);
        }
    });

    test('report boundary never imports a feature module', () => {
        const source = readFileSync(new URL('../core/ledger_report.js', import.meta.url), 'utf8');
        expect(source).not.toMatch(/from ['"]\.\.\//);
    });
});
