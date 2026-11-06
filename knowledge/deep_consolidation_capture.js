/** Read-only identity-bound preparation for the experimental preview.
 * Call again for every request/regeneration, after selecting boundary/pins.
 * No model request, staging, recovery record, or live-entry write occurs.
 */
import { captureCleanupTarget } from './cleanup_commit.js';
import { parseLedger } from './ledger_cleanup.js';
import { captureDeepConsolidationReview } from './deep_consolidation.js';

export async function prepareDeepConsolidation({ name, uid, throughSource, pins = [] }) {
    const capture = await captureCleanupTarget({ name, uid });
    const eligibility = parseLedger(capture.originalContent);
    if (!eligibility.ok || eligibility.empty) return { capture, eligibility };
    const selection = captureDeepConsolidationReview(capture.originalContent, { throughSource, pins });
    return { capture, eligibility, selection };
}