/** Read-only refresh projection and non-fatal, post-commit report handoff. */
import { getChatMeta, getContextSafe } from './context.js';
import { getGlobalSettings } from './settings.js';
import { isStoreWriteBlocked } from './schema_status.js';
import { assertSameScope } from './scope.js';
import { getStoreSchema } from '../schema/registry.js';
import { MANIFEST_METADATA_KEY, MANIFEST_VERSION } from '../schema/manifest.js';
import { countLedgerDiagnostic } from './diagnostics.js';

export const LEDGER_SNAPSHOT_ITEM_LIMIT = 40;
export const LEDGER_SNAPSHOT_CHAR_LIMIT = 4000;
export const LEDGER_REPORT_CONTRACT = `After the document or delta patch, append a separate fenced mwt-ledger-report block of JSONL (one object per line; an empty block if nothing happened). Report ONLY explicit money/item changes belonging to the player character, never NPC-to-NPC exchanges. Copy a short verbatim evidence quote from ONE recent chat message. Money: {"kind":"money","currency":"exact currency name","amount":"signed major-unit decimal text","evidence":"quote"}. Items: {"kind":"item","name":"exact item name","qtyChange":"signed integer text","evidence":"quote"}; optional carried boolean. Optional counterparty string; loan:true ONLY for explicit borrowing, lending or repayment, never purchases. Do not infer changes from the ledger snapshot or previous document. Do not put the report inside the document or patch.`;

/** No snapshot and no prompt tokens when any D28 gate is closed. */
export function readLedgerForReport() {
    const settings = getGlobalSettings();
    if (settings.enableLedger === false || settings.ledgerProposals !== true || isStoreWriteBlocked('ledger')) return null;
    const meta = getChatMeta();
    const ledger = meta?.mwt_ledger;
    const schema = getStoreSchema('ledger');
    if (!getContextSafe() || !ledger || ledger.version !== schema.currentVersion
        || meta[MANIFEST_METADATA_KEY]?.manifestVersion > MANIFEST_VERSION
        || meta[MANIFEST_METADATA_KEY]?.sections?.ledger > schema.currentVersion) return null;
    const checked = schema.validate(ledger);
    if (checked.issues.some(issue => issue.code !== 'ledger-audit-invalid')) return null;
    return ledger.currencies.length || ledger.items.length ? ledger : null;
}

/** Exact, JSON-quoted names, bounded in both count and characters. */
export function buildLedgerRefreshSnapshot() {
    const ledger = readLedgerForReport();
    if (!ledger) return '';
    const lines = ['### Ledger snapshot (reference only; not evidence)'];
    for (const [label, rows, limit] of [['Currency', ledger.currencies, Infinity], ['Item', ledger.items, LEDGER_SNAPSHOT_ITEM_LIMIT]]) {
        let kept = 0;
        for (const row of rows.slice(0, limit)) {
            const line = `${label}: ${JSON.stringify(row.name)}`;
            if (lines.join('\n').length + line.length + 100 > LEDGER_SNAPSHOT_CHAR_LIMIT) break;
            lines.push(line);
            kept++;
        }
        if (kept < rows.length) lines.push(`…and ${rows.length - kept} more ${label.toLowerCase()} names`);
    }
    return lines.join('\n');
}

/** Event dispatch and listener failures must never change refresh success. */
export function publishLedgerReport(report, records, scope, requested) {
    if (!requested || report.block === null) return;
    try {
        if (!assertSameScope(scope).ok || !readLedgerForReport()) return;
        countLedgerDiagnostic('reports-seen');
        for (const drop of report.dropped) {
            countLedgerDiagnostic(`dropped:${drop.reason}`);
            console.warn(`[MWT:Ledger] Report line dropped (${drop.reason}).`);
        }
        document.dispatchEvent(new CustomEvent('mwt:ledger-report', {
            detail: { chatId: scope.identity.key, scope, lines: report.lines, records },
        }));
    } catch (error) {
        console.warn('[MWT:Ledger] Report handoff failed (non-fatal):', error);
        countLedgerDiagnostic('harvest-refused');
    }
}