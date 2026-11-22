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
        const removals = changes.filter(c => c.field === field && c.action === 'remove').slice();
        const remaining = splitGrowthSentences(current[field]);
        for (const sentence of splitGrowthSentences(approved[field])) {
            const index = available.findIndex(c => c.after === sentence);
            const source = index < 0 ? null : available.splice(index, 1)[0];
            // Consume occurrences, not a set: repeated sentences can be kept
            // and deleted independently. A model rewrite accounts for its old
            // sentence too; unmatched reviewer text carries no model evidence.
            const oldIndex = remaining.indexOf(source ? source.before : sentence);
            if (oldIndex >= 0) remaining.splice(oldIndex, 1);
            // Proposed outputs consume their occurrences first. Only unmatched
            // approved occurrences can restore a proposed removal.
            if (!source) {
                const restored = removals.findIndex(c => c.before === sentence);
                if (restored >= 0) removals.splice(restored, 1);
            }
            const priorIndex = prior.findIndex(c => c.after === sentence);
            const ancestor = priorIndex < 0 ? null : prior.splice(priorIndex, 1)[0];
            const inherited = source?.action === 'keep' && ancestor;
            // A keep re-approves the earlier sentence. When the draft cites
            // nothing new, the earlier support carries forward rather than
            // the sentence turning into "no evidence" by being kept.
            const cited = source ? [...(source.evidenceIds || [])] : [];
            const evidenceIds = cited.length || !inherited ? cited : [...(ancestor.evidenceIds || [])];
            const sourceLabel = !source ? 'hand edit, no evidence'
                : evidenceIds.length ? undefined
                    : source.sourceLabel || (inherited && ancestor.sourceLabel)
                        || (!ancestor ? 'from the original line, no evidence' : 'no evidence');
            stamped.push({ field, action: source?.action || 'edit', before: source?.before || '', after: sentence,
                evidenceIds,
                ...(sourceLabel ? { sourceLabel } : {}),
                firstApprovedAt: inherited ? (growthEvidenceTime(ancestor.firstApprovedAt) ?? acceptedAt) : acceptedAt });
        }
        for (const sentence of remaining) {
            const index = removals.findIndex(c => c.before === sentence);
            const source = index < 0 ? null : removals.splice(index, 1)[0];
            stamped.push(source ? { ...source, evidenceIds: [...(source.evidenceIds || [])] }
                : { field, action: 'remove', before: sentence, after: '', evidenceIds: [], sourceLabel: 'hand edit, no evidence' });
        }
    }
    return { acceptedAt, approved: { ...approved }, changes: stamped, ...(!previous ? { original: { ...current } } : {}) };
}

/** Only an approved, kept sentence can echo its own dossier text. Edits and
 * additions are new sentences, first approved at this acceptance, and their
 * evidence postdates the old line by construction. Missing/undated evidence
 * is neutral; any canon or older support suppresses echo.
 */
export function growthEchoStatus(change, evidence = [], lineage = []) {
    if (change.action !== 'keep' || !change.after) return '';
    const ancestor = lineage.find(c => c.field === change.field && c.after === change.after);
    const firstApproved = growthEvidenceTime(ancestor?.firstApprovedAt);
    if (firstApproved === null) return '';
    const support = evidence.filter(o => (change.evidenceIds || []).includes(o.id));
    if (!support.length || support.some(o => o.canon)) return '';
    const times = support.map(o => growthEvidenceTime(o.tier === 'consolidated' ? o.firstSeen : o.ts)).filter(t => t !== null);
    if (!times.length) return 'timing unknown';
    return times.every(t => t > firstApproved) ? 'possible echo — all dated support was written after first approval' : '';
}