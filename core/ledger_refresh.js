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
export const LEDGER_REPORT_CONTRACT = `After the document or delta patch, append a separate fenced mwt-ledger-report block of JSONL (one object per line; an empty block if nothing happened). Report ONLY explicit money/item changes belonging to the player character, never NPC-to-NPC exchanges. Copy a short verbatim evidence quote from ONE recent chat message. Money example: {"kind":"money","currency":"gold","amount":"-30","evidence":"verbatim quote"}. Item example: {"kind":"item","name":"Rope","qtyChange":"-1","evidence":"verbatim quote"}. Replace example names with exact snapshot names and quotes with actual evidence. amount and qtyChange MUST be JSON strings, with the number inside double quotes, never JSON numbers. amount uses signed major-unit decimal text without currency symbols or thousands separators, respecting the currency's decimal places. qtyChange uses signed whole-number text. Optional fields: carried boolean, counterparty string, loan boolean. Omit unknown optional fields; never use null. loan:true ONLY for explicit borrowing, lending or repayment, never purchases. Do not infer changes from the ledger snapshot or previous document. Do not put the report inside the document or patch.`;

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
            const line = `${label}: ${JSON.stringify(row.name)}${label === 'Currency' ? ` (decimal places: ${row.decimals})` : ''}`;
            if (lines.join('\n').length + line.length + 100 > LEDGER_SNAPSHOT_CHAR_LIMIT) break;
            lines.push(line);
            kept++;
        }
        if (kept < rows.length) lines.push(`…and ${rows.length - kept} more ${label.toLowerCase()} names`);
    }
    return lines.join('\n');
}

/** Keep totals free of prose; the local console carries a rejected parse row. */
export function recordLedgerReportDrop(drop) {
    countLedgerDiagnostic(`dropped:${drop.reason}`);
    if (drop.code) countLedgerDiagnostic(`dropped:${drop.reason}:${drop.code}`);
    if (drop.reason === 'duplicate') return;
    const message = `[MWT:Ledger] Report line dropped (${drop.reason}${drop.code ? `: ${drop.code}` : ''}).${drop.message ? ` ${drop.message}` : ''}`;
    if (drop.reason === 'parse') console.warn(message, drop.line);
    else console.warn(message);
}

/** Event dispatch and listener failures must never change refresh success. */
export function publishLedgerReport(report, records, scope, requested) {
    if (!requested || report.block === null) return;
    try {
        if (!assertSameScope(scope).ok || !readLedgerForReport()) return;
        countLedgerDiagnostic('reports-seen');
        for (const drop of report.dropped) recordLedgerReportDrop(drop);
        document.dispatchEvent(new CustomEvent('mwt:ledger-report', {
            detail: { chatId: scope.identity.key, scope, lines: report.lines, records },
        }));
    } catch (error) {
        console.warn('[MWT:Ledger] Report handoff failed (non-fatal):', error);
        countLedgerDiagnostic('harvest-refused');
    }
}
