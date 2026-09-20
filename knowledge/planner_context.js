/** Safe, planner-only Knowledge projection. Never exposes private material. */

import { getCurrentWorldStateScene, getGlobalSettings } from '../core/index.js';
import { DOSSIER_FIELDS, loadEntryContent, extractDossierFieldValues } from './lorebook.js';
import { getRegistry, resolveRegistryKey } from './registry.js';
import { getStances } from './relationships.js';
import { USER_STANCES } from './state.js';

export const SAFE_CHARACTER_CONTEXT_MAX_RECORDS = 6;
export const SAFE_CHARACTER_CONTEXT_MAX_RECORD_CHARS = 700;
export const SAFE_CHARACTER_CONTEXT_MAX_TOTAL_CHARS = SAFE_CHARACTER_CONTEXT_MAX_RECORDS * SAFE_CHARACTER_CONTEXT_MAX_RECORD_CHARS + (SAFE_CHARACTER_CONTEXT_MAX_RECORDS - 1) * 2;

const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const safe = value => text(value).slice(0, 280);

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
            chars: 0,
            tokens: 0,
            estimated: true,
        };
    });
}

function globallyDisabledCoverage(selection) {
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
            chars: 0,
            tokens: 0,
            estimated: true,
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
            chars: 0,
            tokens: 0,
            estimated: true,
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
    const entries = selectedEntries(selection, registry).sort((a, b) => {
        const aOrder = primaryOrder.get(a.info?.entityId);
        const bOrder = primaryOrder.get(b.info?.entityId);
        if (aOrder !== undefined || bOrder !== undefined) return (aOrder ?? Number.MAX_SAFE_INTEGER) - (bOrder ?? Number.MAX_SAFE_INTEGER);
        return a.name.localeCompare(b.name);
    });
    const requestedIds = selection?.mode === 'selected'
        ? [...new Set((selection?.entityIds || []).map(String).filter(Boolean))]
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
        if (records.length >= SAFE_CHARACTER_CONTEXT_MAX_RECORDS) {
            coverage.push({ entityId: info?.entityId || '', name, status: 'omitted-for-budget', records: 0, fields: 0, chars: 0, tokens: 0, estimated: true });
            continue;
        }
        if (!info?.entityId || !Number.isFinite(Number(info.uid))) {
            coverage.push({ entityId: info?.entityId || '', name, status: 'missing-dossier', records: 0, fields: 0, chars: 0, tokens: 0, estimated: true });
            continue;
        }
        const content = await loadEntryContent(info.uid, name);
        if (!content) {
            coverage.push({ entityId: info.entityId, name, status: 'unavailable', records: 0, fields: 0, chars: 0, tokens: 0, estimated: true });
            continue;
        }
        // Two independent guards, in order: the private sections are cut off
        // the content first, then an explicit allowlist picks from what is
        // left. Secrets, ledger, agenda, and read_on_pc are never read into the
        // projection; those fields can encode hidden motives or private
        // knowledge even when a dossier is otherwise public.
        const fields = extractDossierFieldValues(publicDossierSection(content));
        const lines = [];
        for (const [label, value] of [
            ['Stance toward the player character', USER_STANCES.includes(stances[name]) && stances[name] !== 'neutral' ? stances[name] : ''],
            ['Public role', fields.role],
            ['Personality', fields.personality],
            ['Background', fields.background],
            ['Public location', fields.where_to_find],
        ]) {
            const bounded = safe(value);
            if (bounded) lines.push(`${label}: ${bounded}`);
        }
        if (!lines.length) {
            coverage.push({ entityId: info.entityId, name, status: 'partial', records: 0, fields: 0, chars: 0, tokens: 0, estimated: true });
            continue;
        }
        const record = [`Character: ${safe(name)}`, ...lines].join('\n').slice(0, SAFE_CHARACTER_CONTEXT_MAX_RECORD_CHARS);
        records.push(record);
        coverage.push({
            entityId: info.entityId,
            name,
            status: lines.length >= 5 ? 'complete' : 'partial',
            records: 1,
            fields: lines.length,
            chars: record.length,
            tokens: Math.ceil(record.length / 4),
            estimated: true,
        });
    }
    for (const entityId of resolution.missing || []) {
        coverage.push({ entityId, name: '', status: 'unavailable', records: 0, fields: 0, chars: 0, tokens: 0, estimated: true });
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