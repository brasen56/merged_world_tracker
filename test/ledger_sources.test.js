/** @vitest-environment jsdom */
// Phase 9 QA follow-ups: accepted rows keep a traceable source (live message
// number, ILS summary, or an honest "deleted"/"flattened" state) and carry a
// verbatim context excerpt as their note instead of a bare quote.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLedger, validateLedgerAudit } from '../ledger/data.js';
import { getLedger, saveLedger } from '../ledger/store.js';
import { createLedgerSourceIndex, decideLedgerProposals, expireLedgerProposals, proposalSource } from '../ledger/proposals.js';
import { renderLedger } from '../ledger/render.js';
import { ledgerMessageDigest, resolveLedgerReport } from '../core/ledger_report.js';
import { excerptAroundQuote, QUOTE_CONTEXT_CHAR_LIMIT } from '../core/quote_match.js';
import { resolveIlsOriginals as coreResolve } from '../core/ils_originals.js';
import { resolveIlsOriginals as knowledgeResolve, ILS_ORIGINALS_KEY } from '../knowledge/ils_compat.js';

let ctx;
const gold = { id: 'gold', name: 'gold', decimals: 0, badge: true };
const evidence = '"Forty-two even," Mara said.';
const message = 'The lantern hung behind the counter. "Forty-two even," Mara said. The smith slid it across.';
const original = (extra = {}) => ({ id: 'source', mes: message, ...extra });
const proposal = (id = 'p1', extra = {}) => ({ id, kind: 'money', money: { currency: 'gold', amount: -42 },
    counterparty: 'Mara', evidence, msg: { identity: 'id:source', digest: ledgerMessageDigest(message) },
    status: 'accepted', harvest: 'h1', ...extra });
const summary = (ilsData, mes = 'Summary: the party bought a lantern.') => ({ mes, extra: { ILS_Data: ilsData } });
function seed(proposals = [proposal()], transactions = [{ id: 't1', currency: 'gold', amount: -42, kind: 'entry', note: evidence, date: null, source: 'p1' }]) {
    saveLedger({ ...createLedger(), currencies: [gold], transactions, proposals });
}
/** ILS's current form: originals move into chat metadata behind a Ref. */
function condense(originals = [original()]) {
    ctx.chat = [summary({ Ref: 'r1' }), { id: 'later', mes: 'Later.' }];
    ctx.chatMetadata[ILS_ORIGINALS_KEY] = { r1: originals };
}
/** ILS flatten deletes everything behind the summary. */
function flatten() {
    delete ctx.chatMetadata[ILS_ORIGINALS_KEY];
    ctx.chat = [{ mes: 'Summary: the party bought a lantern.' }, { id: 'later', mes: 'Later.' }];
}
const chip = () => document.createRange().createContextualFragment(renderLedger()).querySelector('[data-ledger-source="p1"]');

beforeEach(() => {
    ctx = { chatId: 'sources', chat: [{ id: 'before', mes: 'Before.' }, original()], chatMetadata: {},
        extensionSettings: { merged_world_tracker: {} }, saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
});
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('verbatim context excerpts', () => {
    test('widens by whole sentences, earlier first, within the limit', () => {
        expect(excerptAroundQuote(message, evidence)).toBe(message);
        expect(excerptAroundQuote(message, evidence, { limit: 70 })).toBe('The lantern hung behind the counter. "Forty-two even," Mara said.');
        expect(excerptAroundQuote(message, evidence, { limit: 30 })).toBe(null);
    });

    test('finds quotes that span sentences or lines and skips non-narrative blocks', () => {
        expect(excerptAroundQuote('Mud. He paid. "Here is forty gold." She nodded.', 'paid. Here is forty', { limit: 31 }))
            .toBe('He paid. "Here is forty gold."');
        expect(excerptAroundQuote('<details><summary>Tracker</summary>Gold: 42</details>\nThe smith waited.\n"Forty-two even," Mara said.', evidence))
            .toBe('The smith waited. "Forty-two even," Mara said.');
    });

    test('returns null when the quote is missing or the excerpt adds nothing', () => {
        expect(excerptAroundQuote(message, 'thirty silver pieces')).toBe(null);
        expect(excerptAroundQuote(evidence, evidence)).toBe(null);
        expect(excerptAroundQuote('a'.repeat(QUOTE_CONTEXT_CHAR_LIMIT) + ' "Forty-two even," Mara said.', evidence)).toBe(null);
    });

    test('the resolver attaches the excerpt from the frozen record, not the live message', () => {
        const ledger = { ...createLedger(), currencies: [gold], transactions: [] };
        const chat = [{ id: 'source', mes: message }];
        const records = [{ index: 0, identity: 'id:source', text: message, digest: ledgerMessageDigest(message) }];
        const line = { kind: 'money', currency: 'gold', amount: '-42', evidence };
        expect(resolveLedgerReport([line], { ledger, chat, records }).proposals[0].context).toBe(message);
        const bare = [{ id: 'source', mes: evidence }];
        const bareRecords = [{ index: 0, identity: 'id:source', text: evidence, digest: ledgerMessageDigest(evidence) }];
        expect(resolveLedgerReport([line], { ledger, chat: bare, records: bareRecords }).proposals[0]).not.toHaveProperty('context');
    });
});

describe('accepting and reviewing with context', () => {
    test('an accepted money row uses the context as its note; resolved rows drop it', () => {
        seed([proposal('p1', { status: 'pending', context: message }), proposal('p2', { status: 'pending', context: message,
            money: { currency: 'gold', amount: -5 } }), proposal('p3', { status: 'pending', money: { currency: 'gold', amount: -7 } })],
        [{ id: 'opening', currency: 'gold', amount: 100, kind: 'entry', note: '', date: null }]);
        decideLedgerProposals(['p1', 'p3'], 'accepted');
        decideLedgerProposals(['p2'], 'rejected');
        const ledger = getLedger();
        expect(ledger.transactions.find(row => row.source === 'p1').note).toBe(message);
        expect(ledger.transactions.find(row => row.source === 'p3').note).toBe(evidence);
        ledger.proposals.forEach(row => expect(row).not.toHaveProperty('context'));
    });

    test('the inbox shows the context under the quote', () => {
        seed([proposal('p1', { status: 'pending', context: message })], []);
        expect(renderLedger()).toContain(`Context: ${message.replaceAll('"', '&quot;')}`);
    });

    test('long notes are clipped on the summary line and kept whole in the form', () => {
        const long = `${'word '.repeat(40)}end`;
        seed([], [{ id: 't1', currency: 'gold', amount: 5, kind: 'entry', note: long, date: null }]);
        const fragment = document.createRange().createContextualFragment(renderLedger());
        const row = [...fragment.querySelectorAll('.mwt-ledger-row')].find(node => node.querySelector('textarea')?.value === long);
        expect(row.querySelector('summary').textContent).toContain(`${'word '.repeat(24).trim()}…`);
        expect(row.querySelector('summary').textContent).not.toContain('end');
    });

    test('context and condensed fields are validated', () => {
        const rows = [proposal('a', { context: message }), proposal('b', { context: null }),
            proposal('c', { context: 7 }), proposal('d', { condensed: true }), proposal('e', { condensed: true, status: 'rejected' }),
            proposal('f', { condensed: false })];
        expect(validateLedgerAudit({ proposals: rows }).proposals.map(row => row.id)).toEqual(['a', 'd']);
    });
});

describe('locating accepted sources', () => {
    test('live sources report their current message number', () => {
        expect(proposalSource(proposal())).toMatchObject({ state: 'live', index: 1, missing: false, changed: false });
        ctx.chat[1] = original({ mes: 'An alternate outcome.' });
        expect(proposalSource(proposal())).toMatchObject({ state: 'live', index: 1, changed: true });
    });

    test.each([
        ['Ref', () => condense()],
        ['legacy embedded', () => { ctx.chat = [summary({ OriginalMessages: [original()] }), { id: 'later', mes: 'Later.' }]; }],
        ['nested', () => {
            ctx.chat = [{ id: 'early', mes: 'Early.' }, summary({ Ref: 'r2' })];
            ctx.chatMetadata[ILS_ORIGINALS_KEY] = { r2: [summary({ Ref: 'r1' }, 'Older summary.')], r1: [original()] };
        }],
    ])('%s ILS originals resolve to the summary that holds them', (_, setup) => {
        setup();
        const summaryIndex = ctx.chat.findIndex(row => row.extra?.ILS_Data);
        expect(proposalSource(proposal())).toMatchObject({ state: 'condensed', summaryIndex, missing: true, changed: false });
    });

    test('slot identities survive condensing, and a changed original still warns', () => {
        condense([original({ id: undefined, mwt_ledger_identity: 'uuid:slot', mwt_ledger_aliases: ['uuid:slot'] })]);
        const slot = proposal('p1', { msg: { identity: 'uuid:slot', digest: ledgerMessageDigest(message) } });
        expect(proposalSource(slot)).toMatchObject({ state: 'condensed', summaryIndex: 0, changed: false });
        condense([original({ mes: 'A swiped version.' })]);
        expect(proposalSource(proposal())).toMatchObject({ state: 'condensed', changed: true });
    });

    test('not found is "flattened" once seen condensed, otherwise "deleted"', () => {
        flatten();
        expect(proposalSource(proposal())).toMatchObject({ state: 'deleted', missing: true, changed: true });
        expect(proposalSource(proposal('p1', { condensed: true }))).toMatchObject({ state: 'flattened', missing: true, changed: false });
    });

    test('ILS originals are read only when a source is not live', () => {
        ctx.chat = [summary({ Ref: 'r1' }), original()];
        ctx.chatMetadata[ILS_ORIGINALS_KEY] = new Proxy({}, { get: () => { throw new Error('read ILS originals'); } });
        const sources = createLedgerSourceIndex();
        expect(sources.locate(proposal())).toMatchObject({ state: 'live', index: 1 });
        expect(() => sources.locate(proposal('p9', { msg: { identity: 'id:gone', digest: 'x' } }))).toThrow('read ILS originals');
    });

    test('Knowledge re-exports the same read-only resolver', () => {
        expect(knowledgeResolve).toBe(coreResolve);
    });
});

describe('expiry and chips across condense and flatten', () => {
    test('expiry remembers condensed accepted sources once, then flatten reads as condensed', async () => {
        seed([proposal(), proposal('p2', { status: 'pending', money: { currency: 'gold', amount: -1 } }),
            proposal('p3', { status: 'rejected', money: { currency: 'gold', amount: -2 } })]);
        expect(chip().textContent).toBe('from refresh · message #1');
        condense();
        await expireLedgerProposals();
        expect(getLedger().proposals.map(row => [row.id, row.condensed])).toEqual([['p1', true]]);
        expect(chip().textContent).toBe('from refresh · condensed into summary #0');
        const saves = ctx.saveMetadataDebounced.mock.calls.length;
        await expireLedgerProposals();
        expect(ctx.saveMetadataDebounced.mock.calls.length).toBe(saves);
        flatten();
        await expireLedgerProposals();
        expect(getLedger().proposals).toHaveLength(1);
        expect(chip().textContent).toBe('from refresh · condensed; original no longer stored');
        expect(chip().classList.contains('mwt-ledger-chip-warning')).toBe(false);
    });

    test('deleted and changed sources warn with accurate wording', async () => {
        seed();
        ctx.chat[1] = original({ mes: 'An alternate outcome.' });
        expect(chip().textContent).toBe('from refresh · message #1 · source changed after accept');
        expect(chip().classList.contains('mwt-ledger-chip-warning')).toBe(true);
        ctx.chat.splice(1, 1);
        await expireLedgerProposals();
        expect(chip().textContent).toBe('from refresh · source deleted after accept');
        expect(chip().classList.contains('mwt-ledger-chip-warning')).toBe(true);
        expect(getLedger().proposals[0]).not.toHaveProperty('condensed');
    });

    test('pending suggestions name the summary their source was folded into', () => {
        seed([proposal('p1', { status: 'pending' })], []);
        condense();
        expect(renderLedger()).toContain('Condensed into summary #0');
    });
});
