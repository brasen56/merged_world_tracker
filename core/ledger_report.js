/** DOM/storage-free report boundary. No feature-module imports or writes. */
import { parseAmount } from './ledger_amount.js';
import { quoteMatchesMessage } from './quote_match.js';
import { captureRevision } from './revision.js';
import { getReceiptIdentity } from './message_identity.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
export const normalizeLedgerName = name => String(name ?? '').trim().toLowerCase();

export function ledgerMessageDigest(raw) {
    return captureRevision(typeof raw === 'string' ? raw : '').digest;
}

/** Parse JSONL independently: one broken line cannot discard its neighbors. */
export function parseLedgerReport(block) {
    const lines = [];
    const dropped = [];
    for (const raw of String(block ?? '').split(/\r?\n/).filter(line => line.trim())) {
        try {
            const row = JSON.parse(raw);
            if (!object(row) || !['money', 'item'].includes(row.kind) || !text(row.evidence)) throw new Error('Invalid report line.');
            lines.push(row);
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
    const seen = new Set(proposals.filter(row => {
        if (!object(row) || !text(row.id) || ids.has(row.id)) return false;
        ids.add(row.id);
        if (!['pending', 'accepted', 'rejected'].includes(row.status) || !text(row.evidence) || !text(row.msg?.digest)
            || (row.counterparty !== undefined && typeof row.counterparty !== 'string')) return false;
        if (row.kind === 'money') return (row.money?.loan === undefined || typeof row.money.loan === 'boolean')
            && (row.money?.loan !== true || text(row.counterparty));
        return row.kind === 'item' && (row.item?.carried === undefined || typeof row.item.carried === 'boolean');
    }).map(ledgerProposalKey).filter(Boolean));
    const window = [...(records ?? [])].sort((a, b) => a.index - b.index);
    for (const line of lines) {
        const drop = reason => dropped.push({ reason, line });
        if (!object(line) || !['money', 'item'].includes(line.kind) || !text(line.evidence)) { drop('parse'); continue; }
        const source = window.find(record => Number.isInteger(record.index) && record.index >= 0 && text(record.identity)
            && text(record.text) && text(record.digest)
            && getReceiptIdentity(chat?.[record.index]) === record.identity
            && ledgerMessageDigest(chat[record.index].mes) === record.digest
            && quoteMatchesMessage(line.evidence, null, { ...chat[record.index], mes: record.text }, { allowInterposition: false }));
        if (!source) { drop('evidence'); continue; }
        if (line.counterparty !== undefined && typeof line.counterparty !== 'string') { drop('parse'); continue; }
        const draft = { kind: line.kind, evidence: line.evidence,
            msg: { identity: source.identity, digest: source.digest }, status: 'pending' };
        if (line.counterparty !== undefined) draft.counterparty = line.counterparty;
        if (line.kind === 'money') {
            if (!text(line.currency)) { drop('currency-unresolved'); continue; }
            const currencies = ledger.currencies.filter(row => normalizeLedgerName(row.name) === normalizeLedgerName(line.currency));
            if (currencies.length !== 1) { drop(currencies.length ? 'currency-ambiguous' : 'currency-unresolved'); continue; }
            if ((line.loan !== undefined && typeof line.loan !== 'boolean') || (line.loan === true && !text(line.counterparty))) { drop('parse'); continue; }
            try {
                const amount = parseAmount(line.amount, currencies[0].decimals);
                if (!amount) throw new Error('Zero change.');
                draft.money = { currency: currencies[0].id, amount, loan: line.loan === true };
            } catch { drop('parse'); continue; }
        } else {
            let qtyChange;
            try { qtyChange = parseAmount(line.qtyChange, 0); } catch { drop('parse'); continue; }
            if (!text(line.name) || !qtyChange || (line.carried !== undefined && typeof line.carried !== 'boolean')) { drop('parse'); continue; }
            const items = ledger.items.filter(row => normalizeLedgerName(row.name) === normalizeLedgerName(line.name));
            if (items.length > 1) { drop('item-ambiguous'); continue; }
            if (!items.length && qtyChange < 0) { drop('item-unmatched'); continue; }
            draft.item = { name: items[0]?.name ?? line.name.trim(), qtyChange, carried: line.carried ?? items[0]?.carried ?? true };
        }
        const key = ledgerProposalKey(draft);
        if (seen.has(key)) { drop('duplicate'); continue; }
        seen.add(key);
        kept.push(draft);
    }
    return { proposals: kept, dropped };
}