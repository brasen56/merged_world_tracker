/** Manual portable drafts. Imported review objects/IDs are never used. */
import { estimateTokens } from '../core/context.js';
import { captureDeepConsolidationReview } from './deep_consolidation.js';
import { normalizeDeepGroups, BATCH_MAX_SOURCES, BATCH_MAX_TOKENS } from './deep_consolidation_groups.js';
import { captureBatchReview, deepDraftMatches, retainDeepConsolidationDraft } from './deep_consolidation_batches.js';
import { assembleDeepConsolidationDraft } from './deep_consolidation_handoff.js';
import { validateLedgerProposal } from './ledger_cleanup.js';

const TYPE = 'mwt-deep-consolidation-draft';
const clone = value => JSON.parse(JSON.stringify(value));
const invalid = () => { throw new Error('Invalid deep consolidation draft file.'); };

export function exportDeepConsolidationDraft(draft) {
    return clone({ type: TYPE, version: 1, origin: draft.capture,
        throughSource: draft.throughSource, snapshot: draft.snapshot, pins: draft.pins, groups: draft.groups,
        batches: draft.batches.map(batch => ({ s: batch.s, groupIndex: batch.groupIndex,
            status: batch.status === 'running' ? (batch.failure ? 'failed' : 'pending') : batch.status,
            attempts: batch.attempts, result: batch.result, failure: batch.failure, responseFacts: batch.responseFacts })) });
}

/** Validate everything before retaining anything. A structurally valid stale
 * draft remains export-only; even its results are checked against its snapshot.
 */
export function importDeepConsolidationDraft(text, capture) {
    const file = typeof text === 'string' ? JSON.parse(text) : clone(text);
    if (!file || file.type !== TYPE || file.version !== 1 || !file.origin ||
        !['scopeKey', 'bookName', 'name', 'uid', 'entityId'].every(field => file.origin[field] === capture[field]) ||
        !Number.isInteger(file.throughSource) || file.throughSource < 1 ||
        !Array.isArray(file.snapshot) || file.snapshot.length !== file.throughSource ||
        file.snapshot.some(line => typeof line !== 'string' || /[\r\n]/.test(line)) ||
        !Array.isArray(file.pins) || !Array.isArray(file.groups) || !Array.isArray(file.batches)) invalid();
    const originalContent = 'Knowledge Ledger:\n' + file.snapshot.join('\n');
    const selection = captureDeepConsolidationReview(originalContent, { throughSource: file.throughSource, pins: file.pins });
    if (selection.review.sources.length !== file.snapshot.length || selection.review.sources.some((source, i) => source.text !== file.snapshot[i])) invalid();
    const normalized = normalizeDeepGroups(selection, { reviewId: selection.review.reviewId, groups: file.groups });
    if (JSON.stringify(normalized.groups) !== JSON.stringify(file.groups)) invalid();
    const seen = new Set();
    const batches = file.batches.map((item, index) => {
        const group = normalized.groups[item?.groupIndex];
        if (!group || !Number.isInteger(item.groupIndex) || !Array.isArray(item.s) || !item.s.length || item.s.length > BATCH_MAX_SOURCES ||
            item.s.some((n, i) => !group.s.includes(n) || seen.has(n) || (i > 0 && n <= item.s[i - 1])) ||
            !Number.isInteger(item.attempts) || item.attempts < 0 ||
            !['pending', 'failed', 'accepted', 'skipped'].includes(item.status)) invalid();
        item.s.forEach(n => seen.add(n));
        const texts = item.s.map(n => file.snapshot[n - 1]);
        const tokens = estimateTokens(texts.join('\n'));
        const skipped = item.s.length === 1;
        if ((item.status === 'skipped') !== skipped || (!skipped && tokens > BATCH_MAX_TOKENS)) invalid();
        return { id: `batch-${index + 1}`, groupIndex: item.groupIndex, label: group.label, s: [...item.s], texts, tokens,
            status: item.status, attempts: item.attempts, reason: skipped ? 'Singleton kept exact.' : item.status === 'failed' ? 'Imported failed batch; explicit retry required.' : '',
            ...(item.status === 'accepted' ? { result: clone(item.result) } : {}),
            failure: item.status === 'failed' ? clone(item.failure ?? null) : null,
            responseFacts: clone(item.responseFacts ?? null), warnings: [] };
    });
    if (normalized.groups.some(group => group.s.some(n => !seen.has(n)))) invalid();
    const draft = { capture: Object.fromEntries(['scopeKey', 'bookName', 'name', 'uid', 'entityId'].map(field => [field, capture[field]])),
        throughSource: file.throughSource, snapshot: [...file.snapshot], pins: [...selection.pinnedSourceIds.map(id => selection.review.sources.find(s => s.id === id).order + 1)],
        ...normalized, batches, running: false };
    // Fresh local reviews enforce coverage, structural rules, and the bounded
    // 1,200-character limit, even if the file supplied its own review/limit.
    assembleDeepConsolidationDraft(draft, { ...capture, originalContent });
    for (const batch of batches) {
        if (batch.status !== 'accepted') continue;
        const review = captureBatchReview(batch, `import-warnings-${batch.id}`);
        const ids = numbers => numbers.map(n => review.sources[batch.s.indexOf(n)].id);
        const proposal = { version: 1, reviewId: review.reviewId,
            records: batch.result.records.map((record, i) => ({ id: `record-${i + 1}`, text: record.text,
                sourceIds: ids(record.s), notes: record.notes })),
            pruningSuggestions: batch.result.pruningSuggestions.map(item => ({ sourceIds: ids(item.s), reason: item.reason })),
            notes: batch.result.notes };
        batch.warnings = validateLedgerProposal(review, proposal).warnings;
    }
    const matches = deepDraftMatches(draft, capture);
    retainDeepConsolidationDraft(draft);
    return { draft, matches };
}