import { applyExtensionPromptInjection } from '../core/injection.js';
import { getGlobalSettings } from '../core/settings.js';
import { computeBalances, computeDebts, formatAmount, orderCarriedItems, validateLedgerRecord } from './data.js';

export const EXTENSION_PROMPT_KEY = 'mwt_ledger_injection';
export const CARRIED_ITEM_LIMIT = 15;
export const DEBT_COUNTERPARTY_LIMIT = 3;

/** No history, notes, stored items or inferred possessions enter the prompt. */
export function buildInjectionBody(ledger) {
    if (!validateLedgerRecord(ledger).valid) return '';
    const balances = computeBalances(ledger);
    const carried = orderCarriedItems(ledger.items);
    if (!ledger.currencies.length && !carried.length) return '';
    const lines = ["Stage direction, not narration. Player character's ledger (authoritative, kept by the user):"];
    if (ledger.currencies.length) {
        lines.push(`Money: ${ledger.currencies.map(currency => `${formatAmount(balances.get(currency.id), currency.decimals)} ${currency.name}`).join(', ')}.`);
    }
    const debts = computeDebts(ledger);
    if (debts.length) {
        const counterparties = [...new Set(debts.map(row => row.counterparty))];
        const visible = new Set(counterparties.slice(0, DEBT_COUNTERPARTY_LIMIT));
        const descriptions = debts.filter(row => visible.has(row.counterparty)).map(row => {
            const currency = ledger.currencies.find(candidate => candidate.id === row.currency);
            const amount = `${formatAmount(Math.abs(row.amount), currency.decimals)} ${currency.name}`;
            return row.amount > 0 ? `owes ${row.counterparty} ${amount}` : `owed ${amount} by ${row.counterparty}`;
        });
        if (counterparties.length > visible.size) descriptions.push(`…and ${counterparties.length - visible.size} more counterparties`);
        lines.push(`Debts: ${descriptions.join('; ')}. Listed loans are definite; unlisted ones may still exist.`);
    }
    if (carried.length) {
        const names = carried.slice(0, CARRIED_ITEM_LIMIT).map(item => item.name + (item.qty > 1 ? ` ×${item.qty}` : ''));
        if (carried.length > CARRIED_ITEM_LIMIT) names.push(`…and ${carried.length - CARRIED_ITEM_LIMIT} more carried items`);
        lines.push(`Carried: ${names.join('; ')}.`);
    }
    if (ledger.currencies.length) lines.push('Never state a different amount. If the character spends or receives money, narrate it; the user updates the ledger.');
    lines.push('Carried items are definitely on hand; items not listed may still exist.');
    return lines.join('\n');
}

export function applyLedgerInjection(ledger, diagnostics) {
    const body = ledger ? buildInjectionBody(ledger) : '';
    return applyExtensionPromptInjection({
        key: EXTENSION_PROMPT_KEY, body, enabled: !!body,
        fallbackDepth: 1, globalRole: 'system', wrapperTag: 'mwt_ledger',
        useTags: getGlobalSettings().structuralBoundaries !== false,
        diagnostics,
    });
}

export function clearLedgerInjection(diagnostics = { kind: 'ledger', clearReason: 'explicit-clear' }) {
    return applyLedgerInjection(null, diagnostics);
}