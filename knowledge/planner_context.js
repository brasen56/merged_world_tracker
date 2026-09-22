/** Safe, planner-only Knowledge projection. Never exposes private material. */

import { getCurrentWorldStateScene, getGlobalSettings } from '../core/index.js';
import { DOSSIER_FIELDS, loadEntryContent, extractDossierFieldValues } from './lorebook.js';
import { getRegistry, resolveRegistryKey } from './registry.js';
import { getStances } from './relationships.js';
import { USER_STANCES } from './state.js';

export const SAFE_CHARACTER_CONTEXT_MAX_RECORDS = 6;
export const SAFE_CHARACTER_CONTEXT_MAX_RECORD_CHARS = 700;
export const SAFE_CHARACTER_CONTEXT_MAX_TOTAL_CHARS = SAFE_CHARACTER_CONTEXT_MAX_RECORDS * SAFE_CHARACTER_CONTEXT_MAX_RECORD_CHARS + (SAFE_CHARACTER_CONTEXT_MAX_RECORDS - 1) * 2;
export const SAFE_CHARACTER_CONTEXT_PUBLIC_FIELD_COUNT = 5;

const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const safe = value => text(value).slice(0, 280);
const meaningful = value => {
    const valueText = text(value);
    return valueText && valueText.toLowerCase() !== 'unknown' ? valueText : '';
};

// Where a dossier stops being public. extractDossierFieldValues matches one
// LINE at a time (^Label: value$), so a PRIVATE field whose own value contains
// a newline followed by "Role:" would be read straight back out as a public
// role — and formatDossierEntry omits empty fields, so there need not even be a
// genuine Role: line ahead of it to win the match. Cutting the content at the
// first private label closes that path before the allowlist ever runs.
// Canonical DOSSIER_FIELDS order puts every allowlisted field above these, so a
// well-formed dossier loses nothing; a hand-reordered one loses context rather
// than leaking it. Labels are derived from DOSSIER_FIELDS by KEY, so renaming a
// label cannot silently reopen the hole.
const PRIVATE_DOSSIER_KEYS = ['read_on_pc', 'agenda', 'secrets', 'canon_lock'];
const PRIVATE_SECTION_PREFIXES = [
    ...DOSSIER_FIELDS.filter(field => PRIVATE_DOSSIER_KEYS.includes(field.key)).map(field => field.label),
    'Knowledge Ledger',
].map(label => `${label.toLowerCase()}:`);

/**
 * The part of a dossier entry that precedes its first private section.
 *
 * Deliberately stricter than the extractor it feeds: it cuts on a leading-
 * whitespace-tolerant match, so an indented "  Secrets:" also ends the public
 * region even though `^Secrets:` would not have matched it.
 */
export function publicDossierSection(content) {
    if (typeof content !== 'string') return '';
    const lines = content.split('\n');
    const cut = lines.findIndex(line => {
        const probe = line.trimStart().toLowerCase();
        return PRIVATE_SECTION_PREFIXES.some(prefix => probe.startsWith(prefix));
    });
    return (cut === -1 ? lines : lines.slice(0, cut)).join('\n');
}

export function listPlannerCharacterCandidates() {
    const registry = getRegistry();
    return Object.entries(registry)
        .filter(([, info]) => info && typeof info.entityId === 'string' && info.entityId)
        .map(([name, info]) => ({
            entityId: info.entityId,
            name,
            mergedEntityIds: Array.isArray(info.mergedFrom) ? info.mergedFrom.map(item => item?.entityId).filter(Boolean) : [],
            dossierAvailable: Number.isFinite(Number(info.uid)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolvePlannerCharacterEntities(entityIds) {
    const requested = [...new Set((entityIds || []).map(String).filter(Boolean))];
    const candidates = listPlannerCharacterCandidates();
    const resolved = [];
    const missing = [];
    for (const entityId of requested) {
        const candidate = candidates.find(item => item.entityId === entityId || item.mergedEntityIds.includes(entityId));
        if (candidate) resolved.push({ requestedEntityId: entityId, ...candidate });
        else missing.push(entityId);
    }
    return { resolved, missing, available: true };
}

function selectedEntries(selection, registry) {
    const mode = selection?.mode;
    if (mode === 'active') {
        const present = getCurrentWorldStateScene()?.present || [];
        return [...new Set(present.map(name => resolveRegistryKey(registry, name)).filter(Boolean))]
            .map(name => ({ name, info: registry[name] }));
    }
    if (mode !== 'selected') return [];
    const resolution = resolvePlannerCharacterEntities(selection?.entityIds || []);
    const seen = new Set();
    return resolution.resolved.flatMap(item => {
        if (seen.has(item.entityId)) return [];
        seen.add(item.entityId);
        return [{ name: item.name, info: registry[item.name], requestedEntityId: item.requestedEntityId }];
    });
}

function primarySubjectCoverage(selection, candidates, status) {
    return [...new Set((selection?.primarySubjectEntityIds || []).map(String).filter(Boolean))].map(entityId => {
        const candidate = candidates.find(item => item.entityId === entityId || item.mergedEntityIds.includes(entityId));
        return {
            entityId: candidate?.entityId || entityId,
            name: candidate?.name || '',
            status,
            records: 0,
            fields: 0,
            availableFields: 0,
            supportedFields: SAFE_CHARACTER_CONTEXT_PUBLIC_FIELD_COUNT,
            chars: 0,
            tokens: 0,
            estimated: true,
            isPrimarySubject: true,
            isContextSource: false,
        };
    });
}

/**
 * Public fallbacks shared by compact Knowledge entries and dossiers.
 *
 * Pre-dossier major NPCs store useful public identity in the pipe-delimited
 * header plus Tone / Perceived as / First seen lines. Their Knowledge Ledger
 * can make the entry look much larger than a dossier while the dossier-only
 * extractor returns no fields at all. Parse only single lines above the same
 * private boundary; never read ledger content as a fallback.
 */
function extractCompactPublicValues(publicContent) {
    const lines = String(publicContent || '').split('\n');
    const header = meaningful(lines.find(line => line.trim()) || '').replace(/^\[Dossier\]\s*/i, '');
    const headerParts = header.split('|').map(meaningful);
    const lineValue = label => {
        const prefix = `${label.toLowerCase()}:`;
        const line = lines.find(candidate => candidate.trimStart().toLowerCase().startsWith(prefix));
        return line ? meaningful(line.trimStart().slice(prefix.length)) : '';
    };
    const descriptor = headerParts.length >= 3 ? headerParts.slice(2).filter(Boolean).join(' | ') : '';
    const identity = descriptor ? [headerParts[1], descriptor].filter(Boolean).join('; ') : '';
    const traits = [lineValue('Tone'), lineValue('Perceived as')].filter(Boolean).join('; ');
    return { identity, traits, firstSeen: lineValue('First seen') };
}

function globallyDisabledCoverage(selection) {
    const candidates = listPlannerCharacterCandidates();
    const primaryEntityIds = new Set((selection?.primarySubjectEntityIds || []).map(String).filter(Boolean).map(entityId => {
        const candidate = candidates.find(item => item.entityId === entityId || item.mergedEntityIds.includes(entityId));
        return candidate?.entityId || entityId;
    }));
    const requestedIds = [
        ...(selection?.mode === 'selected' ? selection?.entityIds || [] : []),
        ...(selection?.primarySubjectEntityIds || []),
    ];
    const resolution = resolvePlannerCharacterEntities(requestedIds);
    const coverage = [];
    const seen = new Set();
    for (const item of resolution.resolved || []) {
        if (seen.has(item.entityId)) continue;
        seen.add(item.entityId);
        coverage.push({
            entityId: item.entityId,
            name: item.name || '',
            status: 'disabled',
            records: 0,
            fields: 0,
            availableFields: 0,
            supportedFields: SAFE_CHARACTER_CONTEXT_PUBLIC_FIELD_COUNT,
            chars: 0,
            tokens: 0,
            estimated: true,
            isPrimarySubject: primaryEntityIds.has(item.entityId),
            isContextSource: selection?.mode === 'selected',
        });
    }
    for (const entityId of resolution.missing || []) {
        if (seen.has(entityId)) continue;
        seen.add(entityId);
        coverage.push({
            entityId,
            name: '',
            status: 'disabled',
            records: 0,
            fields: 0,
            availableFields: 0,
            supportedFields: SAFE_CHARACTER_CONTEXT_PUBLIC_FIELD_COUNT,
            chars: 0,
            tokens: 0,
            estimated: true,
            isPrimarySubject: primaryEntityIds.has(entityId),
            isContextSource: selection?.mode === 'selected',
        });
    }
    return coverage;
}

export async function buildPlannerCharacterContext(selection) {
    const candidates = listPlannerCharacterCandidates();
    if (selection?.mode === 'off') {
        const coverage = primarySubjectCoverage(selection, candidates, 'disabled');
        return { text: '', records: 0, requested: coverage.length, omitted: coverage.length, chars: 0, tokens: 0, status: 'disabled', coverage };
    }
    if (getGlobalSettings().enableKnowledge === false) {
        const coverage = globallyDisabledCoverage(selection);
        return { text: '', records: 0, requested: coverage.length, omitted: coverage.length, chars: 0, tokens: 0, status: 'disabled', coverage };
    }
    const registry = getRegistry();
    const primaryIds = [...new Set((selection?.primarySubjectEntityIds || []).map(String).filter(Boolean))];
    const primaryOrder = new Map(primaryIds.map((entityId, index) => {
        const candidate = candidates.find(item => item.entityId === entityId || item.mergedEntityIds.includes(entityId));
        return [candidate?.entityId || entityId, index];
    }));
    const excludedEntityIds = new Set((selection?.excludedEntityIds || []).map(String).filter(Boolean).map(entityId => {
        const candidate = candidates.find(item => item.entityId === entityId || item.mergedEntityIds.includes(entityId));
        return candidate?.entityId || entityId;
    }));
    const entries = selectedEntries(selection, registry).filter(item => !excludedEntityIds.has(item.info?.entityId)).sort((a, b) => {
        const aOrder = primaryOrder.get(a.info?.entityId);
        const bOrder = primaryOrder.get(b.info?.entityId);
        if (aOrder !== undefined || bOrder !== undefined) return (aOrder ?? Number.MAX_SAFE_INTEGER) - (bOrder ?? Number.MAX_SAFE_INTEGER);
        return a.name.localeCompare(b.name);
    });
    const requestedIds = selection?.mode === 'selected'
        ? [...new Set((selection?.entityIds || []).map(String).filter(Boolean))].filter(entityId => {
            const candidate = candidates.find(item => item.entityId === entityId || item.mergedEntityIds.includes(entityId));
            return !excludedEntityIds.has(candidate?.entityId || entityId);
        })
        : [];
    const resolution = selection?.mode === 'selected'
        ? resolvePlannerCharacterEntities(requestedIds)
        : { missing: [] };
    // Snapshot structured dispositions only; never project free-form notes or
    // private dossier reads on the player character.
    const stances = getStances();
    const records = [];
    const coverage = [];
    for (const { name, info } of entries) {
        const coverageIdentity = {
            entityId: info?.entityId || '',
            name,
            supportedFields: SAFE_CHARACTER_CONTEXT_PUBLIC_FIELD_COUNT,
            isPrimarySubject: primaryOrder.has(info?.entityId),
            isContextSource: true,
        };
        if (records.length >= SAFE_CHARACTER_CONTEXT_MAX_RECORDS) {
            coverage.push({ ...coverageIdentity, status: 'omitted-for-budget', records: 0, fields: 0, availableFields: 0, chars: 0, tokens: 0, estimated: true });
            continue;
        }
        if (!info?.entityId || !Number.isFinite(Number(info.uid))) {
            coverage.push({ ...coverageIdentity, status: 'missing-dossier', records: 0, fields: 0, availableFields: 0, chars: 0, tokens: 0, estimated: true });
            continue;
        }
        const content = await loadEntryContent(info.uid, name);
        if (!content) {
            coverage.push({ ...coverageIdentity, status: 'unavailable', records: 0, fields: 0, availableFields: 0, chars: 0, tokens: 0, estimated: true });
            continue;
        }
        // Two independent guards, in order: the private sections are cut off
        // the content first, then an explicit allowlist picks from what is
        // left. Secrets, ledger, agenda, and read_on_pc are never read into the
        // projection; those fields can encode hidden motives or private
        // knowledge even when a dossier is otherwise public.
        const publicContent = publicDossierSection(content);
        const fields = extractDossierFieldValues(publicContent);
        const compact = extractCompactPublicValues(publicContent);
        const publicValues = [
            ['Stance toward the player character', USER_STANCES.includes(stances[name]) && stances[name] !== 'neutral' ? stances[name] : ''],
            [fields.role ? 'Public role' : 'Public identity', fields.role || compact.identity],
            [fields.personality ? 'Personality' : 'Public traits', fields.personality || compact.traits],
            ['Background', fields.background],
            [fields.where_to_find ? 'Public location' : 'First seen', fields.where_to_find || compact.firstSeen],
        ].map(([label, value]) => [label, text(value)]).filter(([, value]) => value);
        const header = `Character: ${safe(name)}`;
        const lines = [];
        const fieldLabels = [];
        let truncated = false;
        for (const [label, value] of publicValues) {
            const bounded = value.slice(0, 280);
            if (bounded.length < value.length) truncated = true;
            const line = `${label}: ${bounded}`;
            if ([header, ...lines, line].join('\n').length > SAFE_CHARACTER_CONTEXT_MAX_RECORD_CHARS) {
                truncated = true;
                continue;
            }
            lines.push(line);
            fieldLabels.push(label);
        }
        if (!lines.length) {
            coverage.push({ ...coverageIdentity, status: 'partial', records: 0, fields: 0, availableFields: publicValues.length, chars: 0, tokens: 0, estimated: true });
            continue;
        }
        const record = [header, ...lines].join('\n');
        records.push(record);
        coverage.push({
            ...coverageIdentity,
            // Complete means the bounded projection contains every populated
            // allowlisted value. It deliberately does not mean that all five
            // possible fields are populated, or that the whole dossier is
            // public. Those were the source of misleading 1-field "Partial"
            // and 5-field "Complete" labels in the generation dialog.
            status: truncated || lines.length < publicValues.length ? 'partial' : 'complete',
            records: 1,
            fields: lines.length,
            availableFields: publicValues.length,
            fieldLabels,
            chars: record.length,
            tokens: Math.ceil(record.length / 4),
            estimated: true,
        });
    }
    for (const entityId of resolution.missing || []) {
        coverage.push({
            entityId, name: '', status: 'unavailable', records: 0, fields: 0, availableFields: 0,
            supportedFields: SAFE_CHARACTER_CONTEXT_PUBLIC_FIELD_COUNT, chars: 0, tokens: 0, estimated: true,
            isPrimarySubject: primaryOrder.has(entityId),
            isContextSource: !excludedEntityIds.has(entityId),
        });
    }
    const coveredIds = new Set(coverage.map(item => item.entityId));
    for (const item of primarySubjectCoverage(selection, candidates, 'disabled')) {
        if (!coveredIds.has(item.entityId)) coverage.push(item);
    }
    const projection = records.join('\n\n').slice(0, SAFE_CHARACTER_CONTEXT_MAX_TOTAL_CHARS);
    const requestedCoverageIds = new Set([
        ...entries.map(item => item.info?.entityId).filter(Boolean),
        ...primaryIds.map(entityId => candidates.find(item => item.entityId === entityId
            || item.mergedEntityIds.includes(entityId))?.entityId || entityId),
        ...(selection?.mode === 'selected' ? requestedIds : []),
    ]);
    const requested = requestedCoverageIds.size;
    return {
        text: projection, records: records.length, requested,
        omitted: Math.max(0, requested - records.length),
        chars: projection.length,
        tokens: Math.ceil(projection.length / 4),
        coverage,
    };
}

// Author-only projection: intentionally unrelated to buildPlannerCharacterContext.
// A malformed or unfamiliar dossier is refused, never guessed at or clipped.
export const AUTHOR_CONTEXT_FIELDS = Object.freeze(['public_profile', 'agenda', 'secrets', 'knowledge', 'read_on_pc', 'canon_lock']);
const AUTHOR_MAX_CHARS = 12000;
const AUTHOR_LABELS = new Map(DOSSIER_FIELDS.map(field => [field.label.toLowerCase(), field.key]));
const PUBLIC_PROFILE_FIELDS = ['role', 'where_to_find', 'appearance', 'voice', 'background', 'personality'];

export function parseAuthorDossier(content) {
    if (typeof content !== 'string' || !content.trim()) throw new Error('Dossier is empty.');
    const fields = {};
    const ledger = [];
    let section = '';
    let seenLedger = false;
    let lastFieldIndex = -1;
    let headerSeen = false;
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (!headerSeen && /^\[Dossier\]\s+[^\n|]+\s*\|/.test(line)) { headerSeen = true; continue; }
        if (headerSeen && !section && /^(Tone|Perceived as|First seen):\s*[^\n]*$/i.test(line)) continue;
        if (/^knowledge ledger\s*:/i.test(line)) {
            if (seenLedger) throw new Error('Repeated Knowledge Ledger boundary.');
            seenLedger = true;
            section = 'ledger';
            continue;
        }
        const label = line.match(/^([^:]{1,60}):\s*(.*)$/);
        if (label && AUTHOR_LABELS.has(label[1].toLowerCase())) {
            const fieldIndex = DOSSIER_FIELDS.findIndex(field => field.key === AUTHOR_LABELS.get(label[1].toLowerCase()));
            if (seenLedger || fieldIndex <= lastFieldIndex) throw new Error('Repeated or out-of-order dossier field.');
            lastFieldIndex = fieldIndex;
            section = AUTHOR_LABELS.get(label[1].toLowerCase());
            fields[section] = label[2];
            continue;
        }
        if (section === 'ledger' && line.startsWith('- ')) {
            if (line !== '- (no entries yet)') ledger.push(line);
            continue;
        }
        // No continuation or foreign section can be classified safely. In
        // particular, a spoofed label inside a multiline secret must not become
        // another character's public field or a fabricated ledger boundary.
        throw new Error('Unrecognised dossier block boundary.');
    }
    if (!headerSeen || !seenLedger) throw new Error('Unrecognised dossier block boundary.');
    return { fields, ledger };
}

export async function buildPlannerAuthorContext(selection) {
    if (getGlobalSettings().enableKnowledge === false) throw new Error('Knowledge is disabled; private character context was not sent.');
    const requestedIds = [...new Set(selection?.entityIds || [])];
    if (!requestedIds.length || requestedIds.length > 24) throw new Error('Select at least one NPC for author context.');
    const resolution = resolvePlannerCharacterEntities(requestedIds);
    if (resolution.missing.length) throw new Error('An author-context NPC is unavailable; no private context was sent.');
    const records = [];
    const coverage = [];
    const seen = new Set();
    let length = 0;
    for (const item of resolution.resolved) {
        if (seen.has(item.entityId)) continue;
        seen.add(item.entityId);
        const requestedFields = [...new Set(selection?.npcFields?.[item.requestedEntityId] || selection?.fields || [])];
        if (!requestedFields.length || requestedFields.some(field => !AUTHOR_CONTEXT_FIELDS.includes(field))) throw new Error('Each selected author-context NPC needs valid field groups.');
        if (!item.dossierAvailable || getRegistry()[item.name]?.type !== 'major') throw new Error('A selected NPC has no major-NPC dossier; no private context was sent.');
        const content = await loadEntryContent(getRegistry()[item.name]?.uid, item.name);
        if (!content) throw new Error('A selected NPC dossier could not be verified; no private context was sent.');
        const { fields, ledger } = parseAuthorDossier(content);
        if (requestedFields.includes('canon_lock') && !fields.canon_lock) throw new Error('A selected NPC has no Canon Lock; no private context was sent.');
        const values = requestedFields.flatMap(field => field === 'public_profile'
            ? PUBLIC_PROFILE_FIELDS.map(key => [key, fields[key]])
            : field === 'knowledge' ? [['knowledge', ledger.join('\n')]] : [[field, fields[field]]])
            .filter(([, value]) => value && value.toLowerCase() !== 'unknown');
        if (!values.length) throw new Error('A selected NPC has no values in the requested author-context field groups.');
        const record = [`NPC: ${item.name}`, `Entity: ${item.entityId}`, ...values.map(([key, value]) => `${key}: ${value}`)].join('\n');
        if (length + record.length + (records.length ? 2 : 0) > AUTHOR_MAX_CHARS) {
            // Canon constraints cannot be omitted without changing the request's meaning.
            if (requestedFields.includes('canon_lock')) throw new Error('Author context exceeds the record budget; Canon Lock cannot be omitted.');
            coverage.push({ entityId: item.entityId, name: item.name, status: 'omitted-for-budget' });
            continue;
        }
        records.push(record);
        length += record.length + (records.length > 1 ? 2 : 0);
        coverage.push({ entityId: item.entityId, name: item.name, status: 'complete', fields: values.length });
    }
    if (!records.length) throw new Error('No complete author-context records fit the budget.');
    return { text: records.join('\n\n'), coverage };
}
