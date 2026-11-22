/** Chat-local manual write seam. Reads never manufacture or repair user data. */
import { getChatMeta, getContextSafe } from '../core/context.js';
import { persistChatMeta } from '../core/metadata.js';
import { clonePlainData, prepareNextStoreValue } from '../core/schema.js';
import { isStoreWriteBlocked } from '../core/schema_status.js';
import { MANIFEST_METADATA_KEY, stampStoreVersion } from '../schema/manifest.js';
import { appendItemLog, diffItems, foldTransactions, validateLedgerRecord } from './data.js';
import { ledgerDate, ledgerId } from './audit.js';
import { ledgerSchema } from './schema.js';
import { refreshInjection } from './index.js';

export const METADATA_KEY = ledgerSchema.metadataKey;

export function getLedger() {
    const value = getChatMeta(METADATA_KEY);
    return value == null ? null : clonePlainData(value);
}

/** Validate and fold before committing data + manifest together in one save. */
export function saveLedger(input, { itemChanges } = {}) {
    const meta = getChatMeta();
    if (!getContextSafe() || !meta) throw new Error('No active chat.');
    if (isStoreWriteBlocked('ledger')) throw new Error('Ledger is paused; repair or retry its schema before editing.');
    const version = meta[MANIFEST_METADATA_KEY]?.sections?.ledger;
    if (version > ledgerSchema.currentVersion) throw new Error('Ledger was written by a newer version.');
    const validation = validateLedgerRecord(input);
    if (!validation.valid) throw new Error(validation.errors.map(error => error.message).join(' '));
    const prepared = prepareNextStoreValue(ledgerSchema, meta[METADATA_KEY], clonePlainData(input));
    if (!prepared.ok) throw new Error('Ledger could not be saved; the previous value was kept.');
    let next = foldTransactions(prepared.data);
    const changes = itemChanges ?? diffItems(meta[METADATA_KEY]?.items ?? [], next.items, { date: ledgerDate() });
    for (const change of changes) {
        next = appendItemLog(next, [{ ...change, id: ledgerId(next, 'l') }]);
    }
    const manifest = stampStoreVersion(meta[MANIFEST_METADATA_KEY], 'ledger', ledgerSchema.currentVersion);
    meta[METADATA_KEY] = next;
    meta[MANIFEST_METADATA_KEY] = manifest;
    persistChatMeta();
    refreshInjection('ledger-saved');
    return clonePlainData(next);
}