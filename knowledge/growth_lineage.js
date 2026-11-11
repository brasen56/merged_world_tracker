/** Pure approval provenance and message-time echo diagnostics. Never model input. */
export function splitGrowthSentences(text = '') {
    return text.trim().match(/[^]*?[.!?…](?=\s|$)|[^]+$/gu)?.map(s => s.trim()).filter(Boolean) || [];
}

const fields = ['personality', 'voice'];
export function growthEvidenceTime(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Only explicit keeps inherit lineage; reviewer rewrites have no evidence. */
export function buildGrowthApproval({ approved, current, changes = [], previous = null, acceptedAt = Date.now() }) {
    const stamped = [];
    for (const field of fields) {
        const available = changes.filter(c => c.field === field && c.after).slice();
        const prior = (previous?.changes || []).filter(c => c.field === field && c.after).slice();
        for (const sentence of splitGrowthSentences(approved[field])) {
            const index = available.findIndex(c => c.after === sentence);
            const source = index < 0 ? null : available.splice(index, 1)[0];
            const priorIndex = prior.findIndex(c => c.after === sentence);
            const ancestor = priorIndex < 0 ? null : prior.splice(priorIndex, 1)[0];
            const inherited = source?.action === 'keep' && ancestor;
            const evidenceIds = source ? [...(source.evidenceIds || [])] : [];
            const sourceLabel = !source ? 'hand edit, no evidence'
                : evidenceIds.length ? source.sourceLabel
                    : source.sourceLabel || (inherited && ancestor.sourceLabel)
                        || (!ancestor ? 'from the original line, no evidence' : 'no evidence');
            stamped.push({ field, action: source?.action || 'edit', before: source?.before || '', after: sentence,
                evidenceIds,
                ...(sourceLabel ? { sourceLabel } : {}),
                firstApprovedAt: inherited ? (growthEvidenceTime(ancestor.firstApprovedAt) ?? acceptedAt) : acceptedAt });
        }
    }
    stamped.push(...changes.filter(c => c.action === 'remove').map(c => ({ ...c, evidenceIds: [...(c.evidenceIds || [])] })));
    return { acceptedAt, approved: { ...approved }, changes: stamped, ...(!previous ? { original: { ...current } } : {}) };
}

/** Missing/undated evidence is neutral; any canon or older support suppresses echo. */
export function growthEchoStatus(change, evidence = [], lineage = []) {
    const support = evidence.filter(o => (change.evidenceIds || []).includes(o.id));
    if (!change.after || !support.length || support.some(o => o.canon)) return '';
    const times = support.map(o => growthEvidenceTime(o.tier === 'consolidated' ? o.firstSeen : o.ts)).filter(t => t !== null);
    if (!times.length) return 'timing unknown';
    const ancestor = lineage.find(c => c.field === change.field && c.after === (change.before || change.after));
    const firstApproved = growthEvidenceTime(ancestor?.firstApprovedAt);
    return firstApproved !== null && times.every(t => t > firstApproved) ? 'possible echo — all dated support was written after first approval' : '';
}