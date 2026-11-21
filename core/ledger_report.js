/** DOM/storage-free report boundary. No feature-module imports or writes. */
import { parseAmount } from './ledger_amount.js';
import { quoteMatchesMessage } from './quote_match.js';
import { captureRevision } from './revision.js';
import { getLedgerReceiptIdentity, ledgerReceiptIdentities } from './ledger_message_identity.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
export const normalizeLedgerName = name => String(name ?? '').trim().toLowerCase();

export function ledgerMessageDigest(raw) {
    return captureRevision(typeof raw === 'string' ? raw : '').digest;
}

/** Accept JSONL plus whole JSON objects/arrays that models often pretty-print.
 * A broken JSONL line or array row cannot discard its valid neighbors. */
export function parseLedgerReport(block) {
    const lines = [];
    const dropped = [];
    const accept = (row, raw) => {
        if (!object(row) || !['money', 'item'].includes(row.kind) || !text(row.evidence)) dropped.push({ reason: 'parse', line: raw });
        else lines.push(row);
    };
    const source = String(block ?? '').trim();
    if (!source) return { lines, dropped };
    try {
        const parsed = JSON.parse(source);
        if (Array.isArray(parsed)) parsed.forEach(row => accept(row, JSON.stringify(row)));
        else accept(parsed, source);
        return { lines, dropped };
    } catch { /* Mixed JSONL: preserve valid lines around malformed neighbors. */ }
    for (const raw of source.split(/\r?\n/).filter(line => line.trim())) {
        try {
            accept(JSON.parse(raw), raw);
        } catch { dropped.push({ reason: 'parse', line: raw }); }
    }
    return { lines, dropped };
}

/** Run before normaliseOutput. Explicit tags are cut even with garbage inside. */
export function cutLedgerReport(raw) {
    const cleaned = String(raw ?? '').replace(/<(think|thinking|reasoning)\b[\s\S]*?<\/\1>/gi, '').trim();
    const fences = [...cleaned.matchAll(/^```([^\r\n]*)\r?\n([\s\S]*?)^```[^\S\r\n]*(?=\r?$)/gm)];
    const last = fences.at(-1);
    if (!last || cleaned.slice(last.index + last[0].length).trim()) return { text: cleaned, block: null, lines: [], dropped: [] };
    const tag = last[1].trim().toLowerCase();
    const parsed = parseLedgerReport(last[2]);
    if (tag !== 'mwt-ledger-report' && (!['json', 'jsonl', 'ledger', ''].includes(tag) || !parsed.lines.length)) {
        return { text: cleaned, block: null, lines: [], dropped: [] };
    }
    return { text: cleaned.slice(0, last.index).trimEnd(), block: last[2], ...parsed };
}

/** JSON tuples prevent delimiter collisions; status/digest/loan are not the key. */
export function ledgerProposalKey(proposal) {
    if (!object(proposal) || !text(proposal.msg?.identity)) return null;
    if (proposal.kind === 'money' && text(proposal.money?.currency) && Number.isSafeInteger(proposal.money?.amount) && proposal.money.amount !== 0) {
        return JSON.stringify([proposal.msg.identity, 'money', proposal.money.currency, proposal.money.amount]);
    }
    if (proposal.kind === 'item' && text(proposal.item?.name) && Number.isSafeInteger(proposal.item?.qtyChange) && proposal.item.qtyChange !== 0) {
        return JSON.stringify([proposal.msg.identity, 'item', normalizeLedgerName(proposal.item.name), proposal.item.qtyChange]);
    }
    return null;
}

/** Resolve against write-time ledger; only frozen records are evidence sources.
 * Returns proposal drafts: the storage caller supplies fresh IDs, never this core.
 * Invalid audit rows never suppress a fresh proposal.
 */
export function resolveLedgerReport(lines, { ledger, chat, records, proposals = [] }) {
    const kept = [];
    const dropped = [];
    const ids = new Set();
    const existingByKey = new Map(proposals.filter(row => {
        if (!object(row) || !text(row.id) || ids.has(row.id)) return false;
        ids.add(row.id);
        if (!['pending', 'accepted', 'rejected'].includes(row.status) || !text(row.evidence) || !text(row.msg?.digest)
            || (row.counterparty !== undefined && typeof row.counterparty !== 'string')) return false;
        if (row.kind === 'money') return (row.money?.loan === undefined || typeof row.money.loan === 'boolean')
            && (row.money?.loan !== true || text(row.counterparty));
        return row.kind === 'item' && (row.item?.carried === undefined || typeof row.item.carried === 'boolean');
    }).map(row => {
        const message = chat?.find(candidate => ledgerReceiptIdentities(candidate).includes(row.msg.identity));
        const canonical = message ? { ...row, msg: { ...row.msg, identity: getLedgerReceiptIdentity(message) } } : row;
        return [ledgerProposalKey(canonical), row];
    }).filter(([key]) => key));
    const seen = new Set(existingByKey.keys());
    const window = [...(records ?? [])].sort((a, b) => a.index - b.index);
    for (const line of lines) {
        const drop = (reason, code, message) => dropped.push({ reason, line, ...(code ? { code, message } : {}) });
        if (!object(line) || !['money', 'item'].includes(line.kind) || !text(line.evidence)) {
            drop('parse', 'report-shape', 'Each report row needs kind "money" or "item" and a nonempty evidence quote.'); continue;
        }
        const source = window.find(record => Number.isInteger(record.index) && record.index >= 0 && text(record.identity)
            && text(record.text) && text(record.digest)
            && getLedgerReceiptIdentity(chat?.[record.index]) === record.identity
            && ledgerMessageDigest(chat[record.index].mes) === record.digest
            && quoteMatchesMessage(line.evidence, null, { ...chat[record.index], mes: record.text }, { allowInterposition: false }));
        if (!source) { drop('evidence'); continue; }
        if (line.counterparty !== undefined && typeof line.counterparty !== 'string') {
            drop('parse', 'counterparty-type', 'counterparty must be text; omit it when unknown instead of using null.'); continue;
        }
        const draft = { kind: line.kind, evidence: line.evidence,
            msg: { identity: source.identity, digest: source.digest }, status: 'pending' };
        if (line.counterparty !== undefined) draft.counterparty = line.counterparty;
        if (line.kind === 'money') {
            if (!text(line.currency)) { drop('currency-unresolved'); continue; }
            const currencies = ledger.currencies.filter(row => normalizeLedgerName(row.name) === normalizeLedgerName(line.currency));
            if (currencies.length !== 1) { drop(currencies.length ? 'currency-ambiguous' : 'currency-unresolved'); continue; }
            if (line.loan !== undefined && typeof line.loan !== 'boolean') {
                drop('parse', 'loan-type', 'loan must be true or false; omit it when unknown instead of using null.'); continue;
            }
            if (line.loan === true && !text(line.counterparty)) {
                drop('parse', 'loan-counterparty', 'A loan requires a nonempty counterparty.'); continue;
            }
            if (typeof line.amount !== 'string') {
                drop('parse', 'amount-type', 'amount must be quoted decimal text, for example "-30", rather than a JSON number.'); continue;
            }
            try {
                const amount = parseAmount(line.amount, currencies[0].decimals);
                if (!amount) { drop('parse', 'amount-zero', 'A money change must be nonzero.'); continue; }
                draft.money = { currency: currencies[0].id, amount, loan: line.loan === true };
            } catch (error) {
                drop('parse', error instanceof RangeError ? 'amount-range' : 'amount-format',
                    `${error.message} Currency allows ${currencies[0].decimals} decimal places.`); continue;
            }
        } else {
            if (typeof line.qtyChange !== 'string') {
                drop('parse', 'quantity-type', 'qtyChange must be quoted integer text, for example "-1", rather than a JSON number.'); continue;
            }
            let qtyChange;
            try { qtyChange = parseAmount(line.qtyChange, 0); } catch (error) {
                drop('parse', error instanceof RangeError ? 'quantity-range' : 'quantity-format', 'qtyChange must be an exact whole number within the safe integer range.'); continue;
            }
            if (!text(line.name)) { drop('parse', 'item-name', 'An item change requires a nonempty name.'); continue; }
            if (!qtyChange) { drop('parse', 'quantity-zero', 'An item quantity change must be nonzero.'); continue; }
            if (line.carried !== undefined && typeof line.carried !== 'boolean') {
                drop('parse', 'carried-type', 'carried must be true or false; omit it when unknown instead of using null.'); continue;
            }
            const items = ledger.items.filter(row => normalizeLedgerName(row.name) === normalizeLedgerName(line.name));
            if (items.length > 1) { drop('item-ambiguous'); continue; }
            if (!items.length && qtyChange < 0) { drop('item-unmatched'); continue; }
            draft.item = { name: items[0]?.name ?? line.name.trim(), qtyChange,
                ...(line.carried !== undefined ? { carried: line.carried } : {}) };
        }
        const key = ledgerProposalKey(draft);
        if (seen.has(key)) { drop('duplicate'); continue; }
        seen.add(key);
        kept.push(draft);
    }
    // Sign-pair contradictions (D14's no-guessing rule): the model reported one
    // transfer twice with opposite signs — the same source message, currency
    // and |amount|, quoting the same evidence. Code cannot pick a side, so both
    // drop. Two real opposite events in one message quote different evidence
    // and stay. A sign-flipped re-report whose evidence matches a stored
    // proposal (any status, D17) drops the newcomer only; the stored row was
    // already reviewable.
    const flipGroupKey = draft => JSON.stringify([draft.msg.identity, draft.money.currency, Math.abs(draft.money.amount), draft.evidence.trim()]);
    const flipKey = draft => ledgerProposalKey({ ...draft, money: { ...draft.money, amount: -draft.money.amount } });
    const groups = new Map();
    for (const draft of kept) {
        if (draft.kind !== 'money') continue;
        const group = flipGroupKey(draft);
        groups.set(group, [...(groups.get(group) ?? []), draft]);
    }
    const contradictory = new Set();
    for (const drafts of groups.values()) {
        if (drafts.length > 1 && new Set(drafts.map(draft => Math.sign(draft.money.amount))).size > 1) {
            drafts.forEach(draft => contradictory.add(draft));
        }
    }
    for (const draft of kept) {
        if (draft.kind !== 'money' || contradictory.has(draft)) continue;
        const twin = existingByKey.get(flipKey(draft));
        if (twin && twin.evidence.trim() === draft.evidence.trim()) contradictory.add(draft);
    }
    const survived = kept.filter(draft => {
        if (!contradictory.has(draft)) return true;
        dropped.push({ reason: 'contradictory', code: 'sign-pair', line: draft,
            message: 'Two lines report one transfer with opposite signs; both were dropped.' });
        return false;
    });
    return { proposals: survived, dropped };
}
