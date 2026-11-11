/** Headless Growth dossier drafting. No staging, dossier writes, or history writes. */
import { validateFieldValue } from './field_contract.js';
import { GROWTH_DOSSIER_CEILINGS, GROWTH_DOSSIER_DEFAULT_LIMITS } from './growth_dossier_state.js';
import { getGrowthDossierSettings, getRegistryEntry } from './registry.js';
import { getEvidenceFile } from './evidence.js';
import { ktFetchFromApi, loadEntryContent, loadProfileContent } from './lorebook.js';
import { getActiveGrowthApproval, readGrowthHistoryContainer } from './growth_history.js';
import { getLorebookName } from './scope.js';
import { hasValidSettings } from './settings.js';
import { GROWTH_DOSSIER_PROMPT } from './prompts.js';
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { isModulePausedForCurrentScope } from '../core/schema_status.js';
import { splitGrowthSentences, growthEchoStatus } from './growth_lineage.js';
export { splitGrowthSentences } from './growth_lineage.js';

const FIELDS = ['personality', 'voice'];
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = reason => ({ ok: false, reason });
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));

/** Deliberately simple, shared sentence grammar, also disclosed in the prompt.
 * No locale-dependent segmentation: punctuation followed by whitespace ends a
 * sentence; a final fragment counts too. Semicolon-separated clauses stay one.
 */
export function extractGrowthDossierLines(content) {
    return Object.fromEntries(FIELDS.map(field => {
        const label = field === 'personality' ? 'Personality' : 'Voice';
        return [field, content.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'm'))?.[1].trim() || ''];
    }));
}

/** Whitelist evidence properties: receipts, quotes, source payloads never travel. */
export function growthDossierEvidence(file, { includeArchived = false } = {}) {
    return [
        ...(file?.consolidated || []).map(o => ({ id: o.id, category: o.category,
            claim: o.claim, firstSeen: o.firstSeen ?? null, canon: false, tier: 'consolidated' })),
        ...(file?.raw || []).map(o => ({ id: o.id, category: o.category,
            claim: o.claim, ts: o.ts ?? null, canon: !!o.canon, tier: 'raw' })),
        ...(includeArchived ? file?.archivedRaw || [] : []).map(o => ({ id: o.id, category: o.category,
            claim: o.claim, ts: o.ts ?? null, canon: !!o.canon, tier: 'raw' })),
    ];
}

/** Strict cleanup convention: one whole JSON fence allowed, no repairs. */
export function parseGrowthDossierProposal(text) {
    if (typeof text !== 'string') return fail('Growth draft must be JSON text.');
    let json = text.trim();
    const fence = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/i.exec(json);
    if (fence) json = fence[1];
    try {
        const proposal = JSON.parse(json);
        return object(proposal) ? { ok: true, proposal } : fail('Growth draft must be a JSON object.');
    } catch (_err) {
        return fail('Growth draft is not complete strict JSON; no repair was attempted.');
    }
}

// Advisory warnings mirror the prompts' ban lists in their typology senses
// only: "east wing", "an even temperament", "rated a 9 at archery", "a disc"
// and the crew’s apostrophes are ordinary prose, and noise trains reviewers
// to skip the real hits. Acronyms are case-sensitive; terms are not.
const TYPOLOGY_CODES = /\b(?:[IE][NS][TF][JP](?:-[AT])?|MBTI|DISC|DiSC)\b/;
const TYPOLOGY_TERMS = new RegExp(`\\b(?:${[
    'enneagram', 'type\\s*[1-9]', '[1-9]\\s?w\\s?[1-9]', '[1-9]\\s+wing', 'wing\\s+[1-9]',
    // "a 3." / "a 3 with a 4 wing", not "a 9 at the trials".
    'a\\s+[1-9](?=\\s*(?:[.,;:!?…]|$|(?:with|wing|type)\\b))',
    'big\\s+five', 'personality\\s+type', 'analytical\\s+type',
    '(?:sanguine|choleric|melancholic|phlegmatic)\\s+(?:temperament|type)', 'four\\s+temperaments', 'temperament\\s+type',
    'character\\s+archetype',
].join('|')})\\b`, 'i');
const isTypology = text => TYPOLOGY_CODES.test(text) || TYPOLOGY_TERMS.test(text);
// Double quotes, or a single quote opening a word. A ’ or ' after a letter is
// an apostrophe (doesn’t, crew’s, friends') or a closing mark.
const QUOTES = /["“”„«»‘‚‹›]|(?:^|[\s([{—–-])'(?=\p{L})/u;

/** Validate the entire proposal atomically; never salvage a partial field.
 * Changes: {field, action, before, after, evidenceIds, reason?}.
 * `approved` is the last approval's {personality, voice}, or null on first draft.
 * Returned warnings/labels are computed here, never trusted from model output.
 */
export function validateGrowthDossierProposal(proposal, {
    current, evidence = [], limits = GROWTH_DOSSIER_DEFAULT_LIMITS, approved = null,
} = {}) {
    if (!object(current) || FIELDS.some(key => typeof current[key] !== 'string')) return fail('Invalid current Growth lines.');
    if (!object(proposal) || !onlyKeys(proposal, [...FIELDS, 'changes']) || !Array.isArray(proposal.changes)) {
        return fail('Growth draft needs exactly two lines and a change list.');
    }
    const fields = {};
    const warnings = [];
    for (const field of FIELDS) {
        if (!Number.isInteger(limits[field]) || limits[field] < 1 || limits[field] > GROWTH_DOSSIER_CEILINGS[field]) {
            return fail(`Invalid ${field} target limit.`);
        }
        if (typeof proposal[field] !== 'string') return fail(`${field} must be a single-line string.`);
        const check = validateFieldValue(field, proposal[field], { ceilings: GROWTH_DOSSIER_CEILINGS });
        if (!check.ok) return fail(`${field}: ${check.reason}`);
        fields[field] = check.value || '';
        // Empty strings become null/no-change in the shared merger. Do not accept
        // removals that downstream application would silently fail to perform.
        if (current[field].trim() && !fields[field]) return fail(`${field}: clearing an existing line is not supported; keep or replace at least one sentence.`);
        if (fields[field].length > limits[field]) warnings.push({ field, code: 'over-target', message: `Over the ${limits[field]}-character target.` });
        if (QUOTES.test(fields[field])) warnings.push({ field, code: 'quotes', message: 'Quote characters present.' });
        if (isTypology(fields[field])) warnings.push({ field, code: 'typology', message: 'Typology vocabulary present.' });
    }
    const evidenceIds = new Set(evidence.map(o => o.id).filter(id => typeof id === 'string' && id));
    const remaining = Object.fromEntries(FIELDS.map(field => [field, splitGrowthSentences(current[field])]));
    const written = { personality: [], voice: [] };
    const changes = [];
    for (const item of proposal.changes) {
        if (!object(item) || !onlyKeys(item, ['field', 'action', 'before', 'after', 'evidenceIds', 'reason'])
            || !FIELDS.includes(item.field) || !['keep', 'edit', 'add', 'remove'].includes(item.action)
            || typeof item.before !== 'string' || typeof item.after !== 'string'
            || !Array.isArray(item.evidenceIds) || item.evidenceIds.some(id => typeof id !== 'string' || !id.trim())
            || new Set(item.evidenceIds).size !== item.evidenceIds.length) return fail('Invalid Growth change item.');
        const change = { ...item, evidenceIds: [...item.evidenceIds] };
        const { field, before, after } = change;
        if (change.action === 'keep' && before !== after) change.action = 'edit';
        if (change.action === 'add' ? before !== '' : !before) return fail(`${field}: invalid source sentence.`);
        if (change.action === 'remove' ? after !== '' : !after) return fail(`${field}: invalid proposed sentence.`);
        if (before) {
            const index = remaining[field].indexOf(before);
            if (index < 0) return fail(`${field}: source sentence missing, altered, or accounted for twice.`);
            remaining[field].splice(index, 1);
        }
        if (after) {
            if (splitGrowthSentences(after).length !== 1 || after.trim() !== after) return fail(`${field}: each change must describe one sentence.`);
            written[field].push(after);
        }
        if (change.action === 'remove') {
            if (!['length', 'evidence'].includes(change.reason)) return fail(`${field}: removal needs a reason.`);
            if (change.reason === 'length' && [fields[field], before].filter(Boolean).join(' ').length <= limits[field]) {
                return fail(`${field}: length removal would still fit the target.`);
            }
        } else if (change.reason !== undefined) return fail(`${field}: only removals may have a reason.`);
        const missing = change.evidenceIds.filter(id => !evidenceIds.has(id));
        if (missing.length) warnings.push({ field, code: 'unresolvable-evidence', ids: missing, message: 'Evidence no longer on file.' });
        const needsEvidence = ['edit', 'add'].includes(change.action) || (change.action === 'remove' && change.reason === 'evidence');
        if (needsEvidence && !change.evidenceIds.some(id => evidenceIds.has(id))) return fail(`${field}: ${change.action} must cite existing evidence.`);
        if (before && !splitGrowthSentences(approved?.[field] || '').includes(before)) {
            change.sourceLabel = approved == null ? 'from the original line, no evidence' : 'hand edit, no evidence';
            // Untested baseline text cannot acquire provenance just by keeping it.
            if (change.action === 'keep') change.evidenceIds = [];
        }
        changes.push(change);
    }
    for (const field of FIELDS) {
        if (remaining[field].length) return fail(`${field}: change list does not account for every current sentence.`);
        const sentences = splitGrowthSentences(fields[field]);
        if (written[field].join(' ') !== fields[field] || written[field].length !== sentences.length
            || written[field].some((sentence, index) => sentence !== sentences[index])) {
            return fail(`${field}: change list does not account for every proposed sentence in order.`);
        }
    }
    return { ok: true, proposal: { ...fields, changes }, warnings };
}

/** Explicit paid call, returning a proposal only. Throws with an actionable
 * reason on failure. Never mutates registry, evidence, dossier, or history.
 * The profile may be the unsaved generated text shown in the Growth window;
 * otherwise the saved profile pointer is used. Psychoanalyze is not an input.
 */
export async function draftGrowthDossier(name, { profile: generatedProfile } = {}) {
    const scope = captureScope();
    const book = getLorebookName();
    const match = getRegistryEntry(name);
    if (!match || match.info.uid == null) throw new Error('Growth draft needs an existing NPC dossier.');
    const { key, info } = match;
    // Registry records are live objects (reconciliation can mutate them in place).
    const { uid, entityId, profileUid } = info;
    const settings = getGrowthDossierSettings(key);
    const assertCurrent = () => {
        const live = getRegistryEntry(key);
        if (!scopeStillCurrent(scope).ok || getLorebookName() !== book || !live
            || live.info.entityId !== entityId || live.info.uid !== uid) throw new Error('Growth draft discarded: chat scope or NPC changed.');
        if (isModulePausedForCurrentScope('knowledge')) throw new Error('Knowledge is paused; Growth draft did not run or was discarded.');
        if (getGrowthDossierSettings(key).enabled !== true) throw new Error('Turn Use Growth in dossier on before preparing lines.');
    };
    assertCurrent();
    const profile = generatedProfile === undefined ? await loadProfileContent(profileUid) : generatedProfile;
    assertCurrent();
    if (typeof profile !== 'string' || !profile.trim()) throw new Error('Generate a Growth profile before preparing dossier lines.');
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    const content = await loadEntryContent(uid, key, { fresh: true });
    assertCurrent();
    if (typeof content !== 'string' || !content.trim()) throw new Error('Could not load the current NPC dossier.');
    const history = await readGrowthHistoryContainer(book);
    assertCurrent();
    if (!history.ok) throw new Error(`Growth draft cannot read approval history (${history.reason}).`);
    const previous = getActiveGrowthApproval(history.records[entityId]);
    const approved = previous?.approved ?? null;
    const current = extractGrowthDossierLines(content);
    const evidence = growthDossierEvidence(getEvidenceFile(key, false));
    const canonLock = content.match(/^Canon Lock:[ \t]*(.*)$/m)?.[1] || '';
    const input = { name: key, profile, current, currentSentences: Object.fromEntries(FIELDS.map(field => [field, splitGrowthSentences(current[field])])),
        canonLock, evidence, limits: settings.limits };
    const output = await ktFetchFromApi(GROWTH_DOSSIER_PROMPT, JSON.stringify(input), { retries: 1 });
    assertCurrent();
    const parsed = parseGrowthDossierProposal(output);
    if (!parsed.ok) throw new Error(parsed.reason);
    const result = validateGrowthDossierProposal(parsed.proposal, { current, evidence, limits: settings.limits, approved });
    if (!result.ok) throw new Error(`Growth draft rejected: ${result.reason}`);
    const lineage = previous?.changes || [];
    for (const change of result.proposal.changes) {
        if (!change.evidenceIds.length && !change.sourceLabel) {
            const ancestor = lineage.find(c => c.field === change.field && c.after === change.before);
            if (ancestor?.sourceLabel) change.sourceLabel = ancestor.sourceLabel;
        }
        change.echoStatus = growthEchoStatus(change, evidence, lineage);
    }
    return { ...result, lineage, name: key, entityId, uid, original: content, current, limits: settings.limits };
}