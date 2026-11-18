/** Entry-only field cleanup. Raw value spans, never dossier normalization. */
import { FIELD_CONTRACT, validateFieldValue } from './field_contract.js';

// Secrets are deliberately unavailable until tier/lifecycle-aware patches exist.
// Descriptor is embedded in the identity header, not a standalone value span.
export const CLEANUP_FIELDS = FIELD_CONTRACT.filter(field => ![
    'descriptor', 'first_seen', 'secrets', 'canon_lock', 'image_tags',
].includes(field.key));

export function fieldCleanupSpans(content) {
    if (typeof content !== 'string' || !content.startsWith('[Dossier] ')) throw new Error('Field cleanup requires a dossier entry.');
    const lines = [...content.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)].filter(match => match[0]);
    const ledgers = lines.filter(line => /^Knowledge Ledger:\s*$/i.test(line[1]));
    if (ledgers.length !== 1) throw new Error('An unambiguous Knowledge Ledger boundary is required.');
    if (/<!--\s*mwt:relationships:/i.test(content.slice(0, ledgers[0].index))) throw new Error('Managed content before the ledger makes field boundaries unsupported.');
    const spans = {};
    for (const field of CLEANUP_FIELDS) {
        const matches = lines.filter(line => new RegExp(`^${field.label}:`, 'i').test(line[1]));
        if (!matches.length) continue;
        if (matches.length !== 1 || matches[0].index >= ledgers[0].index) continue;
        const line = matches[0];
        const index = lines.indexOf(line);
        const next = lines.slice(index + 1).find(candidate => candidate[1].trim())?.[1] || '';
        // Unsupported multiline values fail closed rather than leaving an orphan
        // continuation behind, even across blank lines. Managed blocks are not
        // interpreted as fields.
        if (next.trim() && !/^(?:Tone|Perceived as|First seen|Role|Where to Find|Appearance|Voice|Background|Personality|Read on PC|Current Agenda|Secrets|Canon Lock|Image Tags|Knowledge Ledger):/iu.test(next)) continue;
        const prefix = line[1].match(/^[^:]+:[ \t]*/)[0];
        const start = line.index + prefix.length;
        spans[field.key] = { start, end: line.index + line[1].length, value: content.slice(start, line.index + line[1].length) };
    }
    return spans;
}

export function captureFieldReview(content, keys, reviewId) {
    const spans = fieldCleanupSpans(content);
    if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length) throw new Error('Select distinct eligible fields.');
    const fields = keys.map(key => {
        const field = CLEANUP_FIELDS.find(item => item.key === key);
        if (!field || !spans[key] || !spans[key].value.trim()) throw new Error(`Field ${key} is protected, missing, empty, or ambiguous.`);
        return { key, label: field.label, ...spans[key] };
    });
    return { reviewId, originalContent: content, fields };
}

// Only an exact stored echo may exceed the default bound. The contract still
// checks structure; newly supplied wording always uses the normal ceiling.
function checkCleanupValue(field, value) {
    return validateFieldValue(field.key, value, {
        ceilings: value === field.value ? { [field.key]: value.length } : {},
    });
}

export function validateFieldProposal(review, proposal) {
    if (!proposal || proposal.version !== 1 || proposal.reviewId !== review.reviewId
        || Object.keys(proposal).some(key => !['version', 'reviewId', 'fields'].includes(key))
        || !Array.isArray(proposal.fields) || proposal.fields.length !== review.fields.length) throw new Error('Invalid or incomplete field proposal.');
    const seen = new Set();
    for (const item of proposal.fields) {
        if (!item || !review.fields.some(field => field.key === item.key) || seen.has(item.key)
            || Object.keys(item).some(key => !['key', 'value', 'explanation', 'displacedDetails', 'ambiguity'].includes(key))
            || !['value', 'explanation', 'displacedDetails', 'ambiguity'].every(key => typeof item[key] === 'string')) throw new Error('Invalid field mapping or review notes.');
        seen.add(item.key);
        const checked = checkCleanupValue(review.fields.find(field => field.key === item.key), item.value);
        if (!item.value.trim() || /[\r\n\u2028\u2029]/u.test(item.value) || !checked.ok) throw new Error(`Invalid ${item.key}: ${checked.reason || 'empty or multiline value'}`);
    }
    return proposal;
}

export function patchFieldProposal(review, proposal, decisions) {
    validateFieldProposal(review, proposal);
    let replacement = review.originalContent;
    for (const field of [...review.fields].sort((a, b) => b.start - a.start)) {
        const item = proposal.fields.find(candidate => candidate.key === field.key);
        const decision = decisions?.[field.key];
        if (!decision || !['keep', 'accept', 'edit'].includes(decision.action)) throw new Error(`Decide ${field.label} before Apply.`);
        if (decision.action === 'keep') continue;
        if (item.ambiguity.trim()) throw new Error(`${field.label} is ambiguous; keep the original.`);
        const value = decision.action === 'edit' ? decision.value : item.value;
        const checked = checkCleanupValue(field, value);
        if (typeof value !== 'string' || !value.trim() || /[\r\n\u2028\u2029]/u.test(value) || !checked.ok) throw new Error(`Invalid edited ${field.label}.`);
        if (value === field.value) continue;
        replacement = replacement.slice(0, field.start) + checked.value + replacement.slice(field.end);
    }
    return replacement;
}

/** Derive owned fields from persisted bytes; no new recovery schema needed. */
export function changedFieldKeys(original, replacement) {
    const before = fieldCleanupSpans(original);
    const after = fieldCleanupSpans(replacement);
    const keys = Object.keys(before).filter(key => after[key] && before[key].value !== after[key].value);
    let reconstructed = original;
    for (const key of [...keys].sort((a, b) => before[b].start - before[a].start)) {
        reconstructed = reconstructed.slice(0, before[key].start) + after[key].value + reconstructed.slice(before[key].end);
    }
    if (!keys.length || reconstructed !== replacement) throw new Error('Recovery is not a supported selected-field patch. Export for manual reconciliation.');
    return keys;
}