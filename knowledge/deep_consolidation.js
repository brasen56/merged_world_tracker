/**
 * Experimental preview contract (trial §3A–B). No model or persistence calls.
 * Model JSON can propose archiving; archive is a recoverable disposition,
 * never a deletion. Here it is ONLY in-memory bookkeeping: the full captured
 * original remains available, and there is deliberately no apply/write API.
 * The shipped cleanup wire and validator are not extended by this module.
 */
import { captureLedgerReview, originalLedgerProposal } from './ledger_cleanup.js';
import { LEDGER_ITEM_LIMITS, structuralRejection } from './field_contract.js';

export const DEEP_CONSOLIDATION_WIRE_VERSION = 3;
const fail = reason => ({ ok: false, reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) => object(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** Boundary and pins are 1-based ledger source numbers, NOT entry file lines.
 * Omit throughSource to select the whole ledger. Each call, including a
 * regeneration against the same content, captures a fresh review identity.
 */
export function captureDeepConsolidationReview(content, { throughSource, pins = [] } = {}) {
    const reviewId = `deep-${globalThis.crypto.randomUUID()}`;
    const review = captureLedgerReview(content, reviewId);
    return selectDeepConsolidationSources(review, { throughSource, pins });
}

/** Re-select a preview snapshot without minting a new request identity. Actual
 * generations must still use captureDeepConsolidationReview afresh.
 */
export function selectDeepConsolidationSources(review, { throughSource, pins = [] } = {}) {
    originalLedgerProposal(review);
    const boundary = throughSource ?? review.sources.length;
    if (!Number.isInteger(boundary) || boundary < 1 || boundary > review.sources.length) {
        throw new Error('The consolidation boundary must be a known ledger source number.');
    }
    if (!Array.isArray(pins) || new Set(pins).size !== pins.length ||
        pins.some(n => !Number.isInteger(n) || n < 1 || n > boundary)) {
        throw new Error('Pins must be unique source numbers at or above the selected boundary.');
    }
    return Object.freeze({
        review,
        throughSource: boundary,
        pinnedSourceIds: Object.freeze(pins.map(n => review.sources[n - 1].id)),
        eligibleSources: Object.freeze(review.sources.slice(0, boundary)),
        recentSources: Object.freeze(review.sources.slice(boundary)),
    });
}

/** Validate captured offsets and selection too, not just the model response. */
function checkSelection(selection) {
    try {
        const { review, throughSource, pinnedSourceIds, eligibleSources, recentSources } = selection;
        originalLedgerProposal(review); // existing full revision/source-table guard
        if (!Number.isInteger(throughSource) || throughSource < 1 || throughSource > review.sources.length ||
            !Array.isArray(pinnedSourceIds) || new Set(pinnedSourceIds).size !== pinnedSourceIds.length ||
            !Array.isArray(eligibleSources) || !Array.isArray(recentSources) ||
            eligibleSources.length !== throughSource || recentSources.length !== review.sources.length - throughSource ||
            [...eligibleSources, ...recentSources].some((source, i) => source !== review.sources[i]) ||
            pinnedSourceIds.some(id => !eligibleSources.some(source => source.id === id))) return fail('Invalid captured consolidation selection.');
        return { ok: true };
    } catch (_err) {
        return fail('Invalid captured consolidation review.');
    }
}

/** Request minimization seam. Recent lines never enter this payload. Pins are
 * explicitly pre-assigned to keep; they still appear once in wire.keep so
 * coverage remains explicit, never inferred from a model omission.
 */
export function buildDeepConsolidationUserContent(name, selection) {
    const check = checkSelection(selection);
    if (!check.ok) throw new Error(check.reason);
    const { review, eligibleSources, pinnedSourceIds } = selection;
    const pins = eligibleSources.filter(source => pinnedSourceIds.includes(source.id)).map(source => source.order + 1);
    return [
        `<entity>${name}</entity>`,
        `<review_id>${review.reviewId}</review_id>`,
        `<pinned_keep>${JSON.stringify(pins)}</pinned_keep>`,
        'Pinned sources are pre-assigned to keep. Include them in keep exactly once; never change, merge, or archive them.',
        '<ledger_sources>',
        ...eligibleSources.map(source => `[s${source.order + 1}] ${source.text}`),
        '</ledger_sources>',
    ].join('\n');
}

/** Expand only the experimental wire. Strict JSON parsing is provided by the
 * existing parseLedgerProposal seam; this function accepts the parsed object.
 * Groups are disjoint subject annotations, not extra ownership. No group is
 * normal and means keep exact. A changed record cannot cross subject groups.
 */
export function expandDeepConsolidationProposal(selection, wire) {
    const captured = checkSelection(selection);
    if (!captured.ok) return captured;
    if (!keys(wire, ['version', 'reviewId', 'keep', 'changed', 'archive', 'groups'], ['notes']) ||
        wire.version !== DEEP_CONSOLIDATION_WIRE_VERSION ||
        wire.reviewId !== selection.review.reviewId ||
        !['keep', 'changed', 'archive', 'groups'].every(key => Array.isArray(wire[key])) ||
        (Object.hasOwn(wire, 'notes') && typeof wire.notes !== 'string')) return fail('Invalid experimental wire format or stale review ID.');
    const sourceOf = n => Number.isInteger(n) && n >= 1 && n <= selection.throughSource
        ? selection.eligibleSources[n - 1] : null;
    const translate = numbers => Array.isArray(numbers) && numbers.length && numbers.every(n => sourceOf(n))
        ? numbers.map(n => sourceOf(n).id) : null;
    const records = [];
    for (const n of wire.keep) {
        const source = sourceOf(n);
        if (!source) return fail('Keep references an unknown or post-boundary source.');
        records.push({ id: `original:${source.id}`, text: source.text.replace(/^\s*- /, ''), sourceIds: [source.id], notes: '' });
    }
    for (const [i, changed] of wire.changed.entries()) {
        if (!keys(changed, ['s', 't'], ['n']) || !translate(changed.s)) return fail('Malformed changed record or unknown source.');
        records.push({ id: `deep:r${i + 1}`, text: changed.t, sourceIds: translate(changed.s), notes: changed.n ?? '' });
        if (Object.hasOwn(changed, 'n') && typeof changed.n !== 'string') return fail('Changed notes must be text.');
    }
    const archivedSourceIds = [];
    for (const n of wire.archive) {
        const source = sourceOf(n);
        if (!source) return fail('Archive references an unknown or post-boundary source.');
        archivedSourceIds.push(source.id);
    }
    const groups = [];
    for (const group of wire.groups) {
        if (!keys(group, ['s', 'label']) || !translate(group.s)) return fail('Malformed subject group or unknown source.');
        groups.push({ sourceIds: translate(group.s), label: group.label });
    }
    const proposal = {
        version: DEEP_CONSOLIDATION_WIRE_VERSION, reviewId: wire.reviewId,
        records, archivedSourceIds, groups, notes: wire.notes ?? '',
    };
    const check = validateDeepConsolidationProposal(selection, proposal);
    if (!check.ok) return check;
    records.sort((a, b) => Math.min(...a.sourceIds.map(id => selection.review.sources.findIndex(s => s.id === id))) -
        Math.min(...b.sourceIds.map(id => selection.review.sources.findIndex(s => s.id === id))));
    return { ok: true, proposal };
}

/** Sibling validator: each eligible source has one owner (exact, changed,
 * archived). Recent sources are outside model ownership and remain verbatim
 * in selection.recentSources, to be included in later active-budget measures.
 * Exact legacy originals may exceed 800 chars; all new/merged text may not.
 */
export function validateDeepConsolidationProposal(selection, proposal) {
    const captured = checkSelection(selection);
    if (!captured.ok) return captured;
    if (!keys(proposal, ['version', 'reviewId', 'records', 'archivedSourceIds', 'groups', 'notes']) ||
        proposal.version !== DEEP_CONSOLIDATION_WIRE_VERSION || proposal.reviewId !== selection.review.reviewId ||
        !Array.isArray(proposal.records) || !Array.isArray(proposal.archivedSourceIds) ||
        !Array.isArray(proposal.groups) || typeof proposal.notes !== 'string') return fail('Invalid experimental proposal or stale review ID.');
    const sources = new Map(selection.eligibleSources.map(source => [source.id, source]));
    const grouped = new Map();
    for (const [i, group] of proposal.groups.entries()) {
        if (!keys(group, ['sourceIds', 'label']) || !nonempty(group.label) || /[\r\n\u2028\u2029]/.test(group.label) ||
            !Array.isArray(group.sourceIds) || !group.sourceIds.length) return fail('Malformed subject group.');
        for (const id of group.sourceIds) {
            if (!sources.has(id) || grouped.has(id)) return fail('Subject groups must contain known, non-overlapping sources.');
            grouped.set(id, i);
        }
    }
    const owners = new Map();
    const recordIds = new Set();
    for (const record of proposal.records) {
        if (!keys(record, ['id', 'text', 'sourceIds', 'notes']) || !nonempty(record.id) || recordIds.has(record.id) ||
            !nonempty(record.text) || typeof record.notes !== 'string' || !Array.isArray(record.sourceIds) ||
            !record.sourceIds.length || /^\s*- /.test(record.text) || structuralRejection(record.text) ||
            record.text.trim() === '(no entries yet)') return fail('Malformed, structural, or duplicate consolidated record.');
        recordIds.add(record.id);
        const source = sources.get(record.sourceIds[0]);
        const exact = record.sourceIds.length === 1 && source && source.text.replace(/^\s*- /, '') === record.text;
        if (!exact && record.text.length > LEDGER_ITEM_LIMITS.fact) return fail(`Consolidated records must be at most ${LEDGER_ITEM_LIMITS.fact} characters; use multiple records within the group.`);
        for (const id of record.sourceIds) {
            if (!sources.has(id) || owners.has(id)) return fail('Unknown or duplicate source ownership.');
            if (!exact && (selection.pinnedSourceIds.includes(id) || !grouped.has(id))) return fail('Pinned and ungrouped sources must be kept exactly.');
            if (!exact && grouped.get(id) !== grouped.get(record.sourceIds[0])) return fail('A consolidated record cannot cross subject groups.');
            owners.set(id, exact ? 'kept' : 'changed');
        }
    }
    for (const id of proposal.archivedSourceIds) {
        if (!sources.has(id) || owners.has(id)) return fail('Unknown or duplicate archived source ownership.');
        if (selection.pinnedSourceIds.includes(id) || !grouped.has(id)) return fail('Pinned and ungrouped sources cannot be archived.');
        owners.set(id, 'archived');
    }
    const missing = [...sources.keys()].filter(id => !owners.has(id));
    if (missing.length) return { ...fail('Missing source coverage; absence never implies archiving.'), missing };
    return { ok: true };
}