/**
 * Phase 2: pure, ledger-only review contract. No host, model, or storage calls.
 *
 * Offsets are JS string offsets (slice-compatible), not UTF-8 byte offsets;
 * slicing preserves the original string, including mixed line endings. The
 * owned span runs from the first item's start to the last item's text end.
 * Heading, trailing separator/newline, and every other section stay untouched.
 *
 * Schema v1 deliberately does not support splitting a source across records.
 * Every source has exactly one owner: a proposed record OR an explicit user
 * removal supplied separately by the review controller. Model JSON can never
 * approve removals. Revalidate after every decision and again before commit.
 */

import { structuralRejection, LEDGER_ITEM_LIMITS } from './field_contract.js';

export const LEDGER_PROPOSAL_VERSION = 1;
const fail = (reason) => ({ ok: false, reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** D6 boundary parser. Unsupported boundaries fail closed, with suspect lines. */
export function parseLedger(content) {
    if (typeof content !== 'string') return fail('Entry content must be text.');
    if (/\r(?!\n)/.test(content)) return fail('Bare CR line endings are unsupported.');
    const lines = [];
    const re = /([^\r\n]*)(\r\n|\n|$)/g;
    let match;
    while ((match = re.exec(content)) && match[0].length) {
        lines.push({ text: match[1], eol: match[2], start: match.index, end: match.index + match[1].length });
    }
    const headings = lines.map((line, i) => /^knowledge ledger:/i.test(line.text.trim()) ? i : -1).filter(i => i >= 0);
    if (headings.length !== 1) return fail(`Expected exactly one Knowledge Ledger heading; found ${headings.length}.`);
    const header = lines[headings[0]];
    if (!/^knowledge ledger:$/i.test(header.text.trim())) return fail('Ledger heading has unsupported trailing text.');
    const items = [];
    let terminated = false;
    const suspectLines = [];
    for (let i = headings[0] + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.text.trim()) continue;
        if (!/^\s*- /.test(line.text)) { terminated = true; continue; }
        if (terminated) suspectLines.push(i + 1);
        else items.push({ ...line, lineNumber: i + 1 });
    }
    if (suspectLines.length) return { ...fail(`Item-shaped lines after the ledger terminator are ambiguous (lines ${suspectLines.join(', ')}).`), suspectLines };
    const placeholders = items.filter(item => item.text.trim() === '- (no entries yet)');
    if (placeholders.length && items.length !== 1) return fail('An empty-ledger placeholder mixed with records is ambiguous.');
    const empty = items.length === 0 || placeholders.length > 0;
    const start = items[0]?.start ?? header.end + header.eol.length;
    const end = items.at(-1)?.end ?? start;
    return {
        ok: true, empty, reason: empty ? 'Nothing to condense: the ledger is empty.' : undefined,
        start, end, body: content.slice(start, end), items: empty ? [] : items,
        eol: items.find(item => item.eol)?.eol || header.eol || '\n',
    };
}

/** Suitable for Phase 3 restoreCleanup({ spanOf: ledgerSpan }). */
export function ledgerSpan(content) {
    const parsed = parseLedger(content);
    return parsed.ok ? { start: parsed.start, end: parsed.end } : null;
}

/**
 * Capture a review-local immutable source table. The controller must supply a
 * fresh reviewId for EACH generation (even against identical content); never
 * reuse one for a regenerated source. Exact original content is also bound.
 */
export function captureLedgerReview(content, reviewId) {
    if (!nonempty(reviewId)) throw new Error('A fresh review ID is required.');
    const parsed = parseLedger(content);
    if (!parsed.ok || parsed.empty) throw new Error(parsed.reason);
    const sources = parsed.items.map((item, index) => Object.freeze({
        id: `${reviewId}:source:${index + 1}`, order: index,
        text: item.text, eol: item.eol, start: item.start, end: item.end,
    }));
    return Object.freeze({ reviewId, original: content, sources: Object.freeze(sources) });
}

/** Strict JSON only. The sole wrapper normalization is ONE whole JSON fence. */
export function parseLedgerProposal(text) {
    if (typeof text !== 'string') return fail('Cleanup output must be JSON text.');
    let json = text.trim();
    const fence = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/i.exec(json);
    if (fence) json = fence[1];
    try {
        const proposal = JSON.parse(json);
        if (!object(proposal)) return fail('Cleanup output must be a JSON object.');
        return { ok: true, proposal };
    } catch (_err) {
        return fail('Cleanup output is not complete strict JSON; no repair was attempted.');
    }
}

function checkReview(review) {
    if (!object(review) || !nonempty(review.reviewId) || typeof review.original !== 'string') return fail('Invalid captured review.');
    const parsed = parseLedger(review.original);
    if (!parsed.ok || parsed.empty || !Array.isArray(review.sources) || parsed.items.length !== review.sources.length) return fail('Invalid captured source table.');
    for (let i = 0; i < parsed.items.length; i++) {
        const source = review.sources[i];
        const item = parsed.items[i];
        if (!source || source.id !== `${review.reviewId}:source:${i + 1}` || source.order !== i ||
            source.text !== item.text || source.eol !== item.eol || source.start !== item.start || source.end !== item.end) return fail('Captured source table does not match the original revision.');
    }
    return parsed;
}

/**
 * Spellings of one number compare equal: thousands separators ("50,000"),
 * K suffixes ("100K") and K ranges ("75-100K" means 75K-100K). `surfaces`
 * keeps the first written form of each normalized number for display.
 */
function normalizeDetailNumbers(text, surfaces = null) {
    const thousands = value => String(Math.round(parseFloat(value) * 1000));
    const remember = (normalized, surface) => {
        if (surfaces && !surfaces.has(normalized)) surfaces.set(normalized, surface);
        return normalized;
    };
    return text
        .replace(/(\d+(?:\.\d+)?)(\s*[-\u2013\u2014]\s*)(\d+(?:\.\d+)?)[kK]\b/g,
            (_m, low, dash, high) => `${remember(thousands(low), `${low}K`)}${dash}${remember(thousands(high), `${high}K`)}`)
        .replace(/(\d+(?:\.\d+)?)[kK]\b/g, (match, value) => remember(thousands(value), match))
        .replace(/(?<![\d.])\d{1,3}(?:,\d{3})+(?!\d)/g, match => remember(match.replace(/,/g, ''), match));
}

const LEGACY_INTENT = /\b(?:plans? to|will meet|agreed to|intend(?:s)? to)\b/i;

/**
 * Advisory lexical heuristic, NOT semantic equivalence. Numbers include codes,
 * decimals, dates and alphanumeric identifiers, compared after number-spelling
 * normalization. Candidate names are Unicode capitalized words (including
 * sentence starts: deliberate false positives). Uncertainty, provenance,
 * attribution, chronology and corrections additionally receive a review
 * reminder on every merge; lexical preservation proves none of those. Legacy
 * intent/commitment lines are flagged, never deleted. Callers skip lines kept
 * exactly as written: an unchanged line cannot lose a detail or a plan.
 */
export function ledgerDetailWarnings(sources, text) {
    const surfaces = new Map();
    const original = normalizeDetailNumbers(sources.map(source => source.text).join('\n'), surfaces);
    const tokens = new Set(original.match(/[\p{L}\p{N}_]+(?:[./:-][\p{L}\p{N}_]+)*/gu) || []);
    const retained = new Set((normalizeDetailNumbers(text).match(/[\p{L}\p{N}_]+(?:[./:-][\p{L}\p{N}_]+)*/gu) || []).map(token => token.toLocaleLowerCase()));
    const missing = [...tokens].filter(token => (/\p{N}/u.test(token) || /^\p{Lu}/u.test(token)) && !retained.has(token.toLocaleLowerCase()));
    const warnings = missing.map(token => ({
        kind: 'detail-not-retained',
        detail: token.replace(/\d+(?:\.\d+)?/g, number => surfaces.get(number) ?? number),
    }));
    if (sources.length > 1) warnings.push({ kind: 'semantic-review', message: 'Check attribution, provenance, uncertainty, chronology and corrections; source coverage is not proof of equivalence. Keep originals separate if a safe merge is unsupported.' });
    for (const source of sources) {
        const intent = LEGACY_INTENT.exec(source.text);
        if (intent) {
            warnings.push({
                kind: 'legacy-intent',
                sourceId: source.id,
                phrase: intent[0],
                message: `This line records a plan or commitment ("${intent[0]}"). Check the new text still states it as unresolved, not as something that happened. This flag never authorizes deletion.`,
            });
        }
    }
    return warnings;
}

/**
 * Model shape: { version, reviewId, records:[{id,text,sourceIds,notes}],
 * pruningSuggestions:[{sourceIds,reason}], notes }.
 * text is one ledger item's CONTENT, without '- ' or any newline. notes are
 * required strings (may be empty); suggestions never affect source ownership.
 * decisions: { removals:[{sourceId,reason}] } comes ONLY from explicit user UI.
 */
export function validateLedgerProposal(review, proposal, decisions = { removals: [] }) {
    const parsed = checkReview(review);
    if (!parsed.ok) return parsed;
    if (!exactKeys(proposal, ['version', 'reviewId', 'records', 'pruningSuggestions', 'notes']) ||
        proposal.version !== LEDGER_PROPOSAL_VERSION || proposal.reviewId !== review.reviewId ||
        !Array.isArray(proposal.records) || !Array.isArray(proposal.pruningSuggestions) || typeof proposal.notes !== 'string') return fail('Invalid proposal schema/version or stale review ID. Model removals are not permitted.');
    if (!exactKeys(decisions, ['removals']) || !Array.isArray(decisions.removals)) return fail('Invalid explicit user decisions.');
    const byId = new Map(review.sources.map(source => [source.id, source]));
    const owners = new Map();
    const recordIds = new Set();
    const warnings = [];
    for (const removal of decisions.removals) {
        if (!exactKeys(removal, ['sourceId', 'reason']) || !byId.has(removal.sourceId) || !nonempty(removal.reason) || owners.has(removal.sourceId)) return fail('Invalid or duplicate explicit user removal.');
        owners.set(removal.sourceId, 'removed');
    }
    for (const record of proposal.records) {
        if (!exactKeys(record, ['id', 'text', 'sourceIds', 'notes']) || !nonempty(record.id) || recordIds.has(record.id) ||
            !nonempty(record.text) || /[\r\n\u2028\u2029]/.test(record.text) || /^\s*- /.test(record.text) ||
            !Array.isArray(record.sourceIds) || !record.sourceIds.length || typeof record.notes !== 'string') return fail('Malformed record, duplicate record ID, or multiline/structural text.');
        recordIds.add(record.id);
        const sources = [];
        for (const sourceId of record.sourceIds) {
            if (!byId.has(sourceId)) return fail('A proposed record references an unknown source.');
            if (owners.has(sourceId)) return fail('Contradictory source ownership: each source must belong to exactly one record or user removal.');
            owners.set(sourceId, record.id);
            sources.push(byId.get(sourceId));
        }
        // Exact legacy originals may be kept without forcing a lossy rewrite.
        const exact = sources.length === 1 && sources[0].text.replace(/^\s*- /, '') === record.text;
        const structure = structuralRejection(record.text);
        if (structure) return fail(`Invalid ledger record: ${structure}.`);
        if (record.text.trim() === '(no entries yet)') return fail('An empty-ledger placeholder cannot represent source coverage. Use explicit removals instead.');
        if (!exact && record.text.length > LEDGER_ITEM_LIMITS.fact) return fail(`Ledger record exceeds the ${LEDGER_ITEM_LIMITS.fact}-character bound.`);
        // A line kept exactly as written changed nothing, so it has nothing to warn about.
        if (!exact) for (const warning of ledgerDetailWarnings(sources, record.text)) warnings.push({ recordId: record.id, ...warning });
    }
    for (const suggestion of proposal.pruningSuggestions) {
        if (!exactKeys(suggestion, ['sourceIds', 'reason']) || !Array.isArray(suggestion.sourceIds) || !suggestion.sourceIds.length ||
            new Set(suggestion.sourceIds).size !== suggestion.sourceIds.length || suggestion.sourceIds.some(id => !byId.has(id)) || !nonempty(suggestion.reason)) return fail('Malformed advisory pruning suggestion.');
    }
    const missing = review.sources.filter(source => !owners.has(source.id)).map(source => source.id);
    if (missing.length) return { ...fail('Missing source coverage. Absence is not consent to removal.'), missing };
    return { ok: true, warnings };
}

/** Start with exact originals, without any automatic merges or deletions. */
export function originalLedgerProposal(review) {
    const check = checkReview(review);
    if (!check.ok) throw new Error(check.reason);
    return {
        version: LEDGER_PROPOSAL_VERSION, reviewId: review.reviewId,
        records: review.sources.map(source => ({ id: `original:${source.id}`, text: source.text.replace(/^\s*- /, ''), sourceIds: [source.id], notes: '' })),
        pruningSuggestions: [], notes: '',
    };
}

function assertValid(review, proposal, decisions) {
    const check = validateLedgerProposal(review, proposal, decisions);
    if (!check.ok) throw new Error(check.reason);
    return check;
}

/** Text editing retains mappings; no full-text/mapping inference is supported. */
export function editLedgerRecord(review, proposal, recordId, text, decisions) {
    assertValid(review, proposal, decisions);
    if (!proposal.records.some(record => record.id === recordId)) throw new Error('Unknown record ID.');
    const edited = { ...proposal, records: proposal.records.map(record => record.id === recordId ? { ...record, text } : record) };
    assertValid(review, edited, decisions);
    return edited;
}

/**
 * Keep/restore complete ownership groups. Selecting one source of a merged
 * record restores ALL of its sources, rather than silently dropping siblings.
 * It also reverses explicit removals of the selected sources. Originals are
 * restored in captured source order. Returns new proposal + decisions.
 */
export function keepLedgerOriginals(review, proposal, sourceIds, decisions = { removals: [] }) {
    assertValid(review, proposal, decisions);
    const selected = new Set(sourceIds);
    if (!selected.size || [...selected].some(id => !review.sources.some(source => source.id === id))) throw new Error('Select known sources to keep.');
    for (const record of proposal.records) {
        if (record.sourceIds.some(id => selected.has(id))) record.sourceIds.forEach(id => selected.add(id));
    }
    const originals = originalLedgerProposal(review).records.filter(record => selected.has(record.sourceIds[0]));
    const records = [...proposal.records.filter(record => !record.sourceIds.some(id => selected.has(id))), ...originals];
    const order = new Map(review.sources.map(source => [source.id, source.order]));
    records.sort((a, b) => Math.min(...a.sourceIds.map(id => order.get(id))) - Math.min(...b.sourceIds.map(id => order.get(id))));
    const next = { proposal: { ...proposal, records }, decisions: { removals: decisions.removals.filter(removal => !selected.has(removal.sourceId)) } };
    assertValid(review, next.proposal, next.decisions);
    return next;
}

/** Explicit user removal only; partial removal of merged records is refused. */
export function removeLedgerSources(review, proposal, sourceIds, reason, decisions = { removals: [] }) {
    assertValid(review, proposal, decisions);
    const selected = new Set(sourceIds);
    if (!selected.size || !nonempty(reason) || [...selected].some(id => !review.sources.some(source => source.id === id))) throw new Error('Removal requires known sources and an explicit user reason.');
    for (const record of proposal.records) {
        if (record.sourceIds.some(id => selected.has(id)) && !record.sourceIds.every(id => selected.has(id))) throw new Error('Keep originals before removing only part of a merged record.');
    }
    const next = {
        proposal: { ...proposal, records: proposal.records.filter(record => !record.sourceIds.some(id => selected.has(id))) },
        decisions: { removals: [...decisions.removals.filter(removal => !selected.has(removal.sourceId)), ...[...selected].map(sourceId => ({ sourceId, reason }))] },
    };
    assertValid(review, next.proposal, next.decisions);
    return next;
}

/** Render only the owned body. Exact kept originals retain indentation/EOLs. */
export function patchLedgerProposal(review, proposal, decisions) {
    const check = validateLedgerProposal(review, proposal, decisions);
    if (!check.ok) return check;
    const parsed = parseLedger(review.original);
    const sources = new Map(review.sources.map(source => [source.id, source]));
    const parts = proposal.records.map(record => {
        const source = record.sourceIds.length === 1 ? sources.get(record.sourceIds[0]) : null;
        const exact = source && source.text.replace(/^\s*- /, '') === record.text;
        return { text: exact ? source.text : `- ${record.text}`, eol: exact ? source.eol : parsed.eol };
    });
    // The last item's original separator is outside the owned span. Empty
    // output is a placeholder, never a missing section or implicit deletion.
    let body = parts.map((part, i) => part.text + (i < parts.length - 1 ? part.eol || parsed.eol : '')).join('');
    const unchanged = proposal.records.length === review.sources.length && proposal.records.every((record, i) => record.sourceIds.length === 1 && record.sourceIds[0] === review.sources[i].id && record.text === review.sources[i].text.replace(/^\s*- /, ''));
    if (unchanged) body = parsed.body; // includes original inter-item blank lines
    if (!parts.length) body = '- (no entries yet)';
    const replacement = review.original.slice(0, parsed.start) + body + review.original.slice(parsed.end);
    const boundary = parseLedger(replacement);
    if (!boundary.ok) return boundary;
    return { ok: true, replacement, warnings: check.warnings };
}

/** Adapter for Phase 3's injected final-validation hook; validate the edited
 * proposal anew and require the exact generated patch, not an arbitrary entry.
 */
export function validateLedgerReplacement(review, proposal, decisions, { original, replacement }) {
    if (original !== review.original) return fail('Stale captured ledger revision.');
    const patch = patchLedgerProposal(review, proposal, decisions);
    if (!patch.ok) return patch;
    return patch.replacement === replacement ? { ok: true, warnings: patch.warnings } : fail('Replacement differs from the validated ledger-only patch.');
}