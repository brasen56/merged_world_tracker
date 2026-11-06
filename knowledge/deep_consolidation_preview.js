/** Pure preview editing/export helpers. No persistence, staging or apply API. */
import { validateDeepConsolidationProposal } from './deep_consolidation.js';
import { inspectDeepConsolidation, keepDeepSourceExact } from './deep_consolidation_checks.js';

function checked(selection, proposal) {
    const result = validateDeepConsolidationProposal(selection, proposal);
    if (!result.ok) throw new Error(result.reason);
    return proposal;
}

/** Moving a source restores its whole merged owner before changing membership.
 * Ungrouped sources must stay exact. Never strip links from surviving prose.
 */
export function moveDeepSource(selection, proposal, sourceId, groupIndex) {
    checked(selection, proposal);
    if (!Number.isInteger(groupIndex) || groupIndex < -1 || groupIndex >= proposal.groups.length) {
        throw new Error('Choose an existing group or Ungrouped.');
    }
    const next = keepDeepSourceExact(selection, proposal, sourceId);
    next.groups = next.groups.map((group, index) => ({ ...group,
        sourceIds: [...group.sourceIds.filter(id => id !== sourceId), ...(index === groupIndex ? [sourceId] : [])],
    })).filter(group => group.sourceIds.length);
    return checked(selection, next);
}

export function exportDeepTrialPacket(session) {
    const { selection, proposal, requestFacts, capture } = session;
    const report = inspectDeepConsolidation(selection, proposal, { activeBudget: session.activeBudget });
    const number = id => selection.review.sources.find(source => source.id === id).order + 1;
    // Detach the entire packet from the editable in-memory session.
    return JSON.parse(JSON.stringify({
        type: 'mwt-deep-consolidation-trial', version: 1, exportedAt: new Date().toISOString(),
        npc: { name: capture.name, uid: capture.uid, bookName: capture.bookName },
        readOnly: true, archivePersistence: 'none; originals exist only in this packet and the in-memory preview',
        originalEntry: selection.review.original, consolidatedEntry: report.entryText,
        reviewId: selection.review.reviewId, throughSource: selection.throughSource,
        pins: selection.pinnedSourceIds.map(number),
        groups: proposal.groups.map(group => ({ ...group, sourceNumbers: group.sourceIds.map(number) })),
        records: proposal.records.map(record => ({ ...record, sourceNumbers: record.sourceIds.map(number) })),
        sources: selection.review.sources.map(source => {
            const record = proposal.records.find(item => item.sourceIds.includes(source.id));
            const disposition = source.order >= selection.throughSource ? 'recent' :
                proposal.archivedSourceIds.includes(source.id) ? 'archived' :
                    record.sourceIds.length === 1 && record.text === source.text.replace(/^\s*- /, '') ? 'kept' : 'changed';
            return { sourceId: source.id, sourceNumber: source.order + 1, text: source.text,
                disposition, recordId: record?.id ?? null };
        }),
        proposal, warnings: report.warnings, archiveOnlyDetails: report.archiveOnlyDetails,
        exactCandidates: report.exactCandidates, measurements: report.measurements, requestFacts,
        limitations: 'Lexical checks are advisory, not semantic equivalence. The floor is not a proven semantic minimum. All changed/archived sources require manual continuity review.',
    }));
}