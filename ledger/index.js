/** Static user-owned context: no generation interceptor and no model calls. */
import { getChatMeta, getContextSafe } from '../core/context.js';
import { getGlobalSettings, injectionAllowed } from '../core/settings.js';
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { record } from '../core/diagnostics.js';
import { MANIFEST_VERSION, MANIFEST_METADATA_KEY } from '../schema/manifest.js';
import { ledgerSchema } from './schema.js';
import { applyLedgerInjection, clearLedgerInjection } from './injection.js';
import { validateLedgerRecord } from './data.js';
import { initLedgerProposals, expireLedgerProposals } from './proposals.js';

export { getStatus } from './status.js';

export function refreshInjection(reason = 'refresh') {
    try {
        const meta = getChatMeta();
        const clearReason = !getContextSafe() || !meta ? 'host-unavailable'
            : isStorePausedForCurrentScope('ledger') ? 'schema-paused'
                : !injectionAllowed('Ledger') ? 'global-gate-blocked'
                    : getGlobalSettings().injectLedger === false ? 'injection-disabled'
                        : meta[MANIFEST_METADATA_KEY]?.manifestVersion > MANIFEST_VERSION || meta[MANIFEST_METADATA_KEY]?.sections?.ledger > ledgerSchema.currentVersion ? 'future-version'
                            : !meta.mwt_ledger ? 'ledger-absent'
                                : !validateLedgerRecord(meta.mwt_ledger).valid ? 'ledger-invalid' : null;
        if (clearReason) return clearLedgerInjection({ kind: 'ledger', clearReason });
        return applyLedgerInjection(meta.mwt_ledger, { kind: 'ledger', reason });
    } catch (error) {
        clearLedgerInjection({ kind: 'ledger', clearReason: 'injection-failed' });
        record({ module: 'ledger', event: 'ledger_injection_failed', level: 'warn', detail: { message: String(error?.message || error) } });
        return false;
    }
}

export function onChatChanged() { expireLedgerProposals(); return refreshInjection('chat-changed'); }
export function onChatChangedWhilePaused() {
    return clearLedgerInjection({ kind: 'ledger', clearReason: 'schema-paused' });
}
export function init() { initLedgerProposals(); expireLedgerProposals(); return refreshInjection('startup'); }