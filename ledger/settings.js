/** Ledger controls use the same global setting keys as the injection gates. */
import { getGlobalSettings } from '../core/settings.js';

export const LEDGER_SETTINGS = [
    ['enableLedger', 'Enable Ledger'],
    ['showFloatLedger', 'Show floating button'],
    ['injectLedger', 'Inject money and carried items'],
    ['ledgerProposals', 'Suggest ledger changes from World State refresh (local models may struggle)'],
];

export function renderSettings(settings = getGlobalSettings()) {
    return `<div class="mwt-ledger-switches">${LEDGER_SETTINGS.map(([key, label]) =>
        `<label><input type="checkbox" data-ledger-setting="${key}" ${(key === 'ledgerProposals' ? settings[key] === true : settings[key] !== false) ? 'checked' : ''}> ${label}</label>`
    ).join('')}</div>`;
}