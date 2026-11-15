import { applyExtensionPromptInjection } from '../core/injection.js';
import { getGlobalSettings } from '../core/settings.js';
import { computeBalances, formatAmount, validateLedgerRecord } from './data.js';

export const EXTENSION_PROMPT_KEY = 'mwt_ledger_injection';
export const CARRIED_ITEM_LIMIT = 15;

/** No history, notes, stored items or inferred possessions enter the prompt. */
export function buildInjectionBody(ledger) {
    if (!validateLedgerRecord(ledger).valid) return '';
    const balances = computeBalances(ledger);
    const carried = ledger.items.filter(item => item.carried);
    if (!ledger.currencies.length && !carried.length) return '';
    const lines = ["Stage direction, not narration. Player character's ledger (authoritative, kept by the user):"];
    if (ledger.currencies.length) {
        lines.push(`Money: ${ledger.currencies.map(currency => `${formatAmount(balances.get(currency.id), currency.decimals)} ${currency.name}`).join(', ')}.`);
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