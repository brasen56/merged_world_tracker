/** Phase 6: harvest and expiry only. Accept/reject UI belongs to Phase 7. */
import { getChat } from '../core/context.js';
import { assertSameScope, captureScope, getChatIdentity } from '../core/scope.js';
import { isChatHydrated } from '../core/chat_hydration.js';
import { getReceiptIdentity } from '../core/message_identity.js';
import { readLedgerForReport } from '../core/ledger_refresh.js';
import { resolveLedgerReport } from '../core/ledger_report.js';
import { countLedgerDiagnostic } from '../core/diagnostics.js';
import { validateLedgerAudit, TOMBSTONE_LIMIT } from './data.js';
import { getLedger, saveLedger } from './store.js';

function notifyProposalsChanged() {
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('mwt:ledger-proposals-changed'));
}

function trimProposals(ledger, expireMissing = false) {
    const valid = new Set(validateLedgerAudit(ledger).proposals);
    const identities = expireMissing ? new Set(getChat().map(getReceiptIdentity).filter(Boolean)) : null;
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
        for (const drop of resolved.dropped) {
            countLedgerDiagnostic(`dropped:${drop.reason}`);
            if (drop.reason !== 'duplicate') console.warn(`[MWT:Ledger] Report line dropped (${drop.reason}).`);
        }
        if (!resolved.proposals.length) return;
        const used = new Set(ledger.proposals.map(row => row?.id));
        for (const proposal of resolved.proposals) {
            let id;
            do { id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; } while (used.has(id));
            used.add(id);
            ledger.proposals.push({ id, ...proposal });
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

let listeningDocument;
export function initLedgerProposals() {
    if (typeof document === 'undefined' || listeningDocument === document) return;
    listeningDocument?.removeEventListener?.('mwt:ledger-report', harvestLedgerReport);
    document.addEventListener?.('mwt:ledger-report', harvestLedgerReport);
    listeningDocument = document;
}
