/** Read-only deterministic preview data (§3D). No storage or model calls. */
import { estimateTokens } from '../core/context.js';
import { ledgerDetailWarnings, parseLedger } from './ledger_cleanup.js';
import { validateDeepConsolidationProposal } from './deep_consolidation.js';

const contentOf = source => source.text.replace(/^\s*- /, '');
const exactRecord = (record, source) => record.sourceIds.length === 1 && record.sourceIds[0] === source.id && record.text === contentOf(source);

function assertValid(selection, proposal) {
    const result = validateDeepConsolidationProposal(selection, proposal);
    if (!result.ok) throw new Error(result.reason);
}

/** Conservative lexical candidates, not semantic correction resolution. Flag
 * ALL explicit correction markers, including uncertain older ones, so a latest
 * version is not silently hidden by guessing which subject a sentence means.
 */
export function deepExactCandidates(selection) {
    return selection.review.sources.flatMap(source => {
        const reasons = [];
        if (/\p{N}/u.test(source.text)) reasons.push('number-or-code');
        if (/\b(?:code|password|passphrase|identifier|serial|token)\b/i.test(source.text)) reasons.push('code');
        if (/"[^"\r\n]+"|“[^”\r\n]+”|‘[^’\r\n]+’|(?:^|\W)'[^'\r\n]+'(?=\W|$)/u.test(source.text)) reasons.push('quoted-text');
        if (/\b(?:rumou?r|believ(?:e[sd]?|ing)|thinks?|thought|suspects?|supposedly|allegedly|unconfirmed|hearsay)\b/i.test(source.text)) reasons.push('belief-or-rumor');
        if (/\b(?:correct(?:ed|ion|s)?|actually|instead|not true|false|retract(?:ed|ion)?|supersed(?:es|ed)|no longer|rather than|turns? out|was wrong)\b/i.test(source.text)) reasons.push('correction-candidate');
        return reasons.length ? [{ sourceId: source.id, sourceNumber: source.order + 1, text: source.text, reasons }] : [];
    });
}

/** Export-ready entry text, not a live-entry replacement/commit API. Exact
 * records reuse their original slices. The recent tail (including mixed EOLs
 * and spacing) and everything outside the eligible span remain byte-identical.
 */
export function buildDeepConsolidationEntry(selection, proposal) {
    assertValid(selection, proposal);
    const { review, eligibleSources } = selection;
    const parsed = parseLedger(review.original);
    const records = [...proposal.records].sort((a, b) =>
        Math.min(...a.sourceIds.map(id => review.sources.findIndex(s => s.id === id))) -
        Math.min(...b.sourceIds.map(id => review.sources.findIndex(s => s.id === id))));
    // Preserve a keep-all response byte-for-byte, including blank separators.
    if (proposal.archivedSourceIds.length === 0 && records.length === eligibleSources.length &&
        records.every((record, i) => exactRecord(record, eligibleSources[i]))) return review.original;
    const body = records.map(record => {
        const source = eligibleSources.find(item => item.id === record.sourceIds[0]);
        return exactRecord(record, source) ? source.text : `- ${record.text}`;
    }).join(parsed.eol);
    const first = eligibleSources[0];
    const last = eligibleSources.at(-1);
    return review.original.slice(0, first.start) + body + review.original.slice(last.end);
}

/** One-click backing action for §3E: restore the source's whole owning record
 * to originals. Removing just one input from an existing summary would leave
 * unsupported prose/mappings, so a merged owner is deliberately restored as a
 * unit. Archive sources can be restored individually. Never mutate the draft.
 */
export function keepDeepSourceExact(selection, proposal, sourceId) {
    assertValid(selection, proposal);
    if (!selection.eligibleSources.some(source => source.id === sourceId)) throw new Error('Only eligible sources can be restored.');
    const owner = proposal.records.find(record => record.sourceIds.includes(sourceId));
    const restored = new Set(owner ? owner.sourceIds : [sourceId]);
    const next = {
        ...proposal,
        records: proposal.records.filter(record => record !== owner).map(record => ({ ...record, sourceIds: [...record.sourceIds] })),
        archivedSourceIds: proposal.archivedSourceIds.filter(id => !restored.has(id)),
        groups: proposal.groups.map(group => ({ ...group, sourceIds: [...group.sourceIds] })),
    };
    for (const source of selection.eligibleSources.filter(item => restored.has(item.id))) {
        next.records.push({ id: `exact:${source.id}`, text: contentOf(source), sourceIds: [source.id], notes: '' });
    }
    assertValid(selection, next);
    return next;
}

export function inspectDeepConsolidation(selection, proposal, { activeBudget = 4000 } = {}) {
    assertValid(selection, proposal);
    if (!Number.isInteger(activeBudget) || activeBudget < 1) throw new Error('Active budget must be a positive integer token goal.');
    const entryText = buildDeepConsolidationEntry(selection, proposal);
    const activeBody = parseLedger(entryText).body;
    const warnings = [];
    for (const source of selection.eligibleSources) {
        const record = proposal.records.find(item => item.sourceIds.includes(source.id));
        if (record && exactRecord(record, source)) continue;
        const disposition = record ? 'changed' : 'archived';
        for (const warning of ledgerDetailWarnings([source], activeBody)) {
            warnings.push({ ...warning, sourceId: source.id, sourceNumber: source.order + 1, recordId: record?.id ?? null, disposition });
        }
        // The shared heuristic finds digit-bearing identifiers and candidate
        // names. Also check explicitly introduced codes without digits and
        // quoted wording (including lower-case passphrases).
        const codes = [...source.text.matchAll(/\b(?:code|password|passphrase|identifier|serial|token)\s*(?:(?:is|was)\s+|[:=]\s*)?["“‘']?([\p{L}\p{N}_]+(?:[-./:][\p{L}\p{N}_]+)*)/giu)].map(match => match[1]);
        const quotes = [...source.text.matchAll(/"([^"\r\n]+)"|“([^”\r\n]+)”|‘([^’\r\n]+)’|(?:^|\W)'([^'\r\n]+)'(?=\W|$)/gu)].map(match => match.slice(1).find(Boolean));
        for (const detail of new Set([...codes, ...quotes])) {
            const retained = codes.includes(detail)
                ? (activeBody.match(/[\p{L}\p{N}_]+(?:[-./:][\p{L}\p{N}_]+)*/gu) || []).some(token => token.toLocaleLowerCase() === detail.toLocaleLowerCase())
                : activeBody.toLocaleLowerCase().includes(detail.toLocaleLowerCase());
            if (!retained && !warnings.some(warning => warning.sourceId === source.id && warning.detail === detail)) {
                warnings.push({ kind: 'detail-not-retained', detail, detailType: codes.includes(detail) ? 'code' : 'quoted-text',
                    sourceId: source.id, sourceNumber: source.order + 1, recordId: record?.id ?? null, disposition });
            }
            if (codes.includes(detail)) {
                for (const warning of warnings.filter(item => item.sourceId === source.id && item.detail === detail)) warning.detailType = 'code';
            }
        }
        warnings.push({ kind: 'semantic-review', sourceId: source.id, sourceNumber: source.order + 1,
            recordId: record?.id ?? null, disposition,
            message: 'Check attribution, provenance, belief vs fact, chronology, corrections and unresolved obligations. Lexical retention anywhere in the active text is not proof of continuity.' });
    }
    // High-signal numbers/codes first; candidate names (including sentence starts)
    // are intentionally noisy and case-insensitive, matching the public heuristic.
    const rank = warning => warning.kind === 'detail-not-retained' ? (/\p{N}/u.test(warning.detail) || warning.detailType === 'code' ? 0 : 1) : 2;
    warnings.sort((a, b) => rank(a) - rank(b));
    const exactCandidates = deepExactCandidates(selection).map(candidate => ({ ...candidate,
        canKeepExact: selection.eligibleSources.some(source => source.id === candidate.sourceId) &&
            !proposal.records.some(record => exactRecord(record, selection.review.sources[candidate.sourceNumber - 1])),
    }));
    const grouped = new Set(proposal.groups.flatMap(group => group.sourceIds));
    const pinned = new Set(selection.pinnedSourceIds);
    const ungrouped = selection.eligibleSources.filter(source => !grouped.has(source.id));
    const mandatory = new Set([...pinned, ...ungrouped.map(source => source.id),
        ...selection.recentSources.map(source => source.id), ...exactCandidates.map(candidate => candidate.sourceId)]);
    const tokenText = sources => sources.map(source => source.text).join('\n');
    const beforeTokens = estimateTokens(parseLedger(selection.review.original).body);
    const afterTokens = estimateTokens(activeBody);
    const share = sources => ({ sourceCount: sources.length, tokens: estimateTokens(tokenText(sources)),
        sourceShare: sources.length / selection.review.sources.length,
        tokenShare: beforeTokens ? estimateTokens(tokenText(sources)) / beforeTokens : 0 });
    const floorTokens = estimateTokens(tokenText(selection.review.sources.filter(source => mandatory.has(source.id))));
    const warningCounts = {};
    for (const warning of warnings) warningCounts[warning.kind] = (warningCounts[warning.kind] || 0) + 1;
    return {
        entryText, warnings, exactCandidates,
        archiveOnlyDetails: warnings.filter(warning => warning.disposition === 'archived' && warning.kind === 'detail-not-retained'),
        measurements: { estimated: true, beforeTokens, afterTokens, activeBudget, overBudget: afterTokens > activeBudget,
            floorTokens, floorExceedsBudget: floorTokens > activeBudget,
            floorPolicy: 'Exact-by-default candidates + pins + ungrouped + recent originals, unioned once; excludes all other summaries. A lexical mandatory-exact baseline, not a proven semantic minimum.',
            pinned: share(selection.eligibleSources.filter(source => pinned.has(source.id))),
            ungrouped: share(ungrouped), recent: share(selection.recentSources),
            warningCount: warnings.length, warningCounts },
    };
}