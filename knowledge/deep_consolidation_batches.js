/** Pure, deterministic batch planning. Numbers always refer to the full ledger. */
import { estimateTokens } from '../core/context.js';
import { BATCH_MAX_SOURCES, BATCH_MAX_TOKENS, normalizeDeepGroups } from './deep_consolidation_groups.js';
import { captureLedgerReview } from './ledger_cleanup.js';
import { DEEP_CONSOLIDATION_MAX_CHARS } from './deep_consolidation_limits.js';

/** sources is the captured ledger source table. Oversized indivisible lines
 * and singletons are explicit skipped batches, never an over-cap paid call.
 * Dynamic partitioning chooses the fewest contiguous chunks, then minimizes
 * squared source-count imbalance among partitions with that chunk count.
 */
export function planBatches(groups, { sources, maxSources = BATCH_MAX_SOURCES, maxTokens = BATCH_MAX_TOKENS } = {}) {
    if (!Number.isInteger(maxSources) || maxSources < 1 || !Number.isFinite(maxTokens) || maxTokens <= 0 || !Array.isArray(sources)) {
        throw new Error('Batch planning requires sources and positive caps.');
    }
    const seen = new Set();
    const batches = [];
    for (const [groupIndex, group] of groups.entries()) {
        const numbers = [...group.s].sort((a, b) => a - b);
        if (new Set(numbers).size !== numbers.length || numbers.some(n => !Number.isInteger(n) || !sources[n - 1] || seen.has(n))) throw new Error('Invalid or duplicate batch source number.');
        numbers.forEach(n => seen.add(n));
        const tokens = (start, end) => estimateTokens(numbers.slice(start, end).map(n => sources[n - 1].text).join('\n'));
        const fits = (start, end) => end - start <= maxSources && tokens(start, end) <= maxTokens;
        // Each prefix stores its best complete partition. Fewer calls wins;
        // equal call counts use balanced lengths, with stable tie-breaking.
        const dp = [{ chunks: [], cost: 0 }];
        for (let end = 1; end <= numbers.length; end++) {
            let best;
            for (let start = Math.max(0, end - maxSources); start < end; start++) {
                if (!dp[start] || (!fits(start, end) && end - start !== 1)) continue;
                const candidate = { chunks: [...dp[start].chunks, numbers.slice(start, end)], cost: dp[start].cost + (end - start) ** 2 };
                if (!best || candidate.chunks.length < best.chunks.length ||
                    (candidate.chunks.length === best.chunks.length && candidate.cost < best.cost)) best = candidate;
            }
            dp[end] = best;
        }
        for (const s of dp[numbers.length].chunks) {
            const texts = s.map(n => sources[n - 1].text);
            const tokenCount = estimateTokens(texts.join('\n'));
            const reason = tokenCount > maxTokens ? 'Source exceeds the ledger-token cap; kept exact.'
                : s.length === 1 ? 'Singleton kept exact.' : '';
            batches.push({ id: `batch-${batches.length + 1}`, groupIndex, label: group.label,
                s, texts, tokens: tokenCount, status: reason ? 'skipped' : 'pending', reason, attempts: 0 });
        }
    }
    return batches;
}

export function captureBatchReview(batch, reviewId) {
    return captureLedgerReview('Knowledge Ledger:\n' + batch.texts.join('\n'), reviewId,
        { maxRecordChars: DEEP_CONSOLIDATION_MAX_CHARS });
}

/** Results contain ledger numbers, not ephemeral source ids. */
export function mapBatchProposal(batch, review, proposal) {
    const numberOf = id => batch.s[review.sources.findIndex(source => source.id === id)];
    return { records: proposal.records.map(record => ({ text: record.text, s: record.sourceIds.map(numberOf), notes: record.notes })),
        pruningSuggestions: proposal.pruningSuggestions.map(item => ({ s: item.sourceIds.map(numberOf), reason: item.reason })), notes: proposal.notes };
}

const drafts = new Map();
const key = capture => [capture.scopeKey, capture.bookName, capture.name, String(capture.uid)].join('|');
export const getDeepConsolidationDraft = capture => drafts.get(key(capture)) || null;
export const clearDeepConsolidationDraft = capture => drafts.delete(key(capture));
export const _resetDeepConsolidationDraftsForTests = () => drafts.clear();

export function createDeepConsolidationDraft(capture, session) {
    const normalized = normalizeDeepGroups(session.selection, { reviewId: session.selection.review.reviewId, groups: session.groups });
    if (!normalized.ok) throw new Error(normalized.reason);
    const draft = { capture, selection: session.selection, ...normalized, running: false,
        batches: planBatches(normalized.groups, { sources: session.selection.review.sources }) };
    drafts.set(key(capture), draft);
    return draft;
}

/** Phase 2 is deliberately exact-revision-only. Append-safe resume is Phase 4. */
export function deepDraftMatches(draft, capture) {
    return ['scopeKey', 'bookName', 'name', 'uid', 'entityId', 'originalContent'].every(field => draft.capture[field] === capture[field]);
}