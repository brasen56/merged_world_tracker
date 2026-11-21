/** Harvest, expiry and explicitly reviewed, atomic proposal decisions. */
import { getChat } from '../core/context.js';
import { assertSameScope, captureScope, getChatIdentity } from '../core/scope.js';
import { isChatHydrated } from '../core/chat_hydration.js';
import { ledgerReceiptIdentities } from '../core/ledger_message_identity.js';
import { readLedgerForReport, recordLedgerReportDrop } from '../core/ledger_refresh.js';
import { ledgerMessageDigest, resolveLedgerReport } from '../core/ledger_report.js';
import { countLedgerDiagnostic } from '../core/diagnostics.js';
import { computeBalances, diffItems, validateLedgerAudit, validateLedgerRecord, TOMBSTONE_LIMIT } from './data.js';
import { ledgerDate, ledgerId } from './audit.js';
import { getLedger, saveLedger } from './store.js';

function notifyProposalsChanged() {
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('mwt:ledger-proposals-changed'));
}

function trimProposals(ledger, expireMissing = false) {
    const valid = new Set(validateLedgerAudit(ledger).proposals);
    const identities = expireMissing ? new Set(getChat().flatMap(ledgerReceiptIdentities)) : null;
    const live = ledger.proposals.filter(row => !expireMissing || !valid.has(row) || identities.has(row.msg.identity));
    let excess = Math.max(0, live.filter(row => valid.has(row) && row.status !== 'pending').length - TOMBSTONE_LIMIT);
    return live.filter(row => !(valid.has(row) && row.status !== 'pending' && excess-- > 0));
}

export async function expireLedgerProposals() {
    try {
        const scope = captureScope();
        const hydrated = await isChatHydrated();
        if (!assertSameScope(scope).ok) return;
        const ledger = getLedger();
        if (!Array.isArray(ledger?.proposals)) return;
        const next = trimProposals(ledger, hydrated);
        if (next.length !== ledger.proposals.length) {
            saveLedger({ ...ledger, proposals: next });
            notifyProposalsChanged();
        }
    } catch (error) {
        console.warn('[MWT:Ledger] Proposal expiry refused (non-fatal):', error.message);
        countLedgerDiagnostic('expiry-refused');
    }
}

export function harvestLedgerReport(event) {
    try {
        const detail = event?.detail;
        if (!detail || !assertSameScope(detail.scope).ok || detail.chatId !== getChatIdentity().key || !readLedgerForReport()) {
            countLedgerDiagnostic('harvest-refused');
            return;
        }
        const ledger = getLedger();
        ledger.proposals ??= [];
        const resolved = resolveLedgerReport(detail.lines, {
            ledger, chat: getChat(), records: detail.records,
            proposals: validateLedgerAudit(ledger).proposals,
        });
        for (const drop of resolved.dropped) recordLedgerReportDrop(drop);
        if (!resolved.proposals.length) return;
        const used = new Set(ledger.proposals.map(row => row?.id));
        const harvest = ledgerId(ledger, 'h');
        for (const proposal of resolved.proposals) {
            let id;
            do { id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; } while (used.has(id));
            used.add(id);
            ledger.proposals.push({ id, ...proposal, harvest });
        }
        ledger.proposals = trimProposals(ledger);
        if (!assertSameScope(detail.scope).ok) throw new Error('Chat changed.');
        saveLedger(ledger);
        notifyProposalsChanged();
        void expireLedgerProposals();
        countLedgerDiagnostic('lines-kept', resolved.proposals.length);
    } catch (error) {
        console.warn('[MWT:Ledger] Proposal write refused (non-fatal):', error.message);
        countLedgerDiagnostic('harvest-refused');
    }
}

/** Look up the live slot, never a saved index. Missing sources also flag audit chips. */
export function proposalSource(proposal, chat = getChat()) {
    const index = chat.findIndex(message => ledgerReceiptIdentities(message).includes(proposal.msg.identity));
    return { index, missing: index < 0, changed: index < 0 || ledgerMessageDigest(chat[index].mes) !== proposal.msg.digest };
}

/**
 * Review a frozen selection against the latest detached ledger. No writes until
 * every row passes review. Dialog callers retry with explicit overdraft choices;
 * scope and the current record are rechecked on that retry, not held across it.
 */
export function decideLedgerProposals(ids, status, {
    scope = captureScope(), choices = {}, itemTargets = {},
    confirmSourceChange = () => false, confirmRemoval = () => false,
} = {}) {
    if (!['accepted', 'rejected'].includes(status)) throw new Error('Unknown proposal decision.');
    if (!assertSameScope(scope).ok) throw new Error('Chat changed. Reopen Ledger.');
    const ledger = getLedger();
    if (!ledger || !validateLedgerRecord(ledger).valid) throw new Error('Ledger is unavailable.');
    const snapshot = JSON.stringify(ledger);
    const selected = [...new Set(ids)].map(id => validateLedgerAudit(ledger).proposals.find(row => row.id === id && row.status === 'pending'));
    if (!selected.length || selected.some(row => !row)) throw new Error('Suggestions changed. Review the inbox again.');
    const date = ledgerDate();
    const itemChanges = [];
    for (const proposal of selected) {
        if (status === 'accepted') {
            const source = proposalSource(proposal);
            if (source.missing) throw new Error('Source message is unavailable. Try again once chat history is loaded.');
            if (source.changed && !confirmSourceChange(proposal)) return false;
            if (proposal.kind === 'money') {
                const money = proposal.money;
                if (!ledger.currencies.some(row => row.id === money.currency)) throw new Error('Proposal currency no longer exists. Reject this suggestion.');
                const balance = BigInt(computeBalances(ledger).get(money.currency)) + BigInt(money.amount);
                const shortfall = money.amount < 0 && balance < 0n ? -balance : 0n;
                const choice = choices[proposal.id];
                const decision = typeof choice === 'object' && choice !== null ? choice.decision : choice;
                const changedShortfall = typeof choice === 'object' && choice !== null && choice.shortfall !== String(shortfall);
                if (shortfall && (!['accept', 'owed'].includes(decision) || changedShortfall)) {
                    const error = new Error('Review the overdraft before accepting.');
                    error.overdraft = { proposal, shortfall: String(shortfall) };
                    throw error;
                }
                ledger.transactions.push({ id: ledgerId(ledger, 't'), ...money, note: proposal.evidence, date, kind: 'entry',
                    ...(proposal.counterparty ? { counterparty: proposal.counterparty } : {}), source: proposal.id });
                if (shortfall && decision === 'owed') {
                    if (!proposal.counterparty?.trim() || money.loan === true) throw new Error('A shortfall loan requires a counterparty and a non-loan payment.');
                    const amount = Number(shortfall);
                    if (!Number.isSafeInteger(amount)) throw new Error('Shortfall exceeds the safe integer range.');
                    ledger.transactions.push({ id: ledgerId(ledger, 't'), currency: money.currency, amount,
                        loan: true, counterparty: proposal.counterparty, source: proposal.id,
                        note: 'Shortfall recorded as owed', date, kind: 'entry' });
                }
            } else {
                const before = ledger.items.map(row => ({ ...row }));
                const target = itemTargets[proposal.id];
                const item = target ? ledger.items.find(row => row.id === target)
                    : ledger.items.find(row => row.name.trim().toLowerCase() === proposal.item.name.trim().toLowerCase());
                if (target && !item) throw new Error('Selected item no longer exists.');
                if (!item && proposal.item.qtyChange < 0) throw new Error('Item no longer exists. Reject this suggestion.');
                if (item) {
                    const qty = item.qty + proposal.item.qtyChange;
                    if (!Number.isSafeInteger(qty)) throw new Error('Quantity exceeds the safe integer range.');
                    if (qty <= 0) {
                        if (!confirmRemoval(item, proposal)) return false;
                        ledger.items = ledger.items.filter(row => row.id !== item.id);
                    } else {
                        item.qty = qty;
                        if (proposal.item.carried !== undefined) item.carried = proposal.item.carried;
                    }
                } else ledger.items.push({ id: ledgerId(ledger, 'i'), name: proposal.item.name, qty: proposal.item.qtyChange,
                    carried: proposal.item.carried !== false, note: '' });
                itemChanges.push(...diffItems(before, ledger.items, { source: proposal.id, date }));
            }
        }
        proposal.status = status;
    }
    // Confirm callbacks may run host code; never overwrite a changed chat/store.
    if (!assertSameScope(scope).ok || JSON.stringify(getLedger()) !== snapshot) throw new Error('Ledger or chat changed. Review the inbox again.');
    ledger.proposals = trimProposals(ledger);
    saveLedger(ledger, { itemChanges });
    countLedgerDiagnostic(status === 'accepted' ? 'proposals-accepted' : 'proposals-rejected', selected.length);
    notifyProposalsChanged();
    return true;
}

let listeningDocument;
export function initLedgerProposals() {
    if (typeof document === 'undefined' || listeningDocument === document) return;
    listeningDocument?.removeEventListener?.('mwt:ledger-report', harvestLedgerReport);
    document.addEventListener?.('mwt:ledger-report', harvestLedgerReport);
    listeningDocument = document;
}
