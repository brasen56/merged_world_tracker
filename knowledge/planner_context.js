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
    if (getGlobalSettings().enableKnowledge === false) return [];
    const registry = getRegistry();
    return Object.entries(registry)
        .filter(([, info]) => info && typeof info.entityId === 'string' && info.entityId)
        .map(([name, info]) => ({ entityId: info.entityId, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function selectedNames(selection, registry) {
    const mode = selection?.mode;
    if (mode === 'active') {
        const present = getCurrentWorldStateScene()?.present || [];
        return [...new Set(present.map(name => resolveRegistryKey(registry, name)).filter(Boolean))];
    }
    if (mode !== 'selected') return [];
    const ids = new Set(Array.isArray(selection?.entityIds) ? selection.entityIds : []);
    return Object.entries(registry)
        .filter(([, info]) => ids.has(info?.entityId)
            || (Array.isArray(info?.mergedFrom) && info.mergedFrom.some(previous => ids.has(previous?.entityId))))
        .map(([name]) => name);
}

export async function buildPlannerCharacterContext(selection) {
    if (selection?.mode === 'off' || getGlobalSettings().enableKnowledge === false) {
        return { text: '', records: 0, requested: 0, omitted: 0, chars: 0, tokens: 0 };
    }
    const registry = getRegistry();
    const names = selectedNames(selection, registry);
    // Snapshot structured dispositions only; never project free-form notes or
    // private dossier reads on the player character.
    const stances = getStances();
    const records = [];
    for (const name of names) {
        if (records.length >= SAFE_CHARACTER_CONTEXT_MAX_RECORDS) break;
        const info = registry[name];
        if (!info?.entityId || !Number.isFinite(Number(info.uid))) continue;
        const content = await loadEntryContent(info.uid, name);
        if (!content) continue;
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
        if (!lines.length) continue;
        records.push([`Character: ${safe(name)}`, ...lines].join('\n').slice(0, SAFE_CHARACTER_CONTEXT_MAX_RECORD_CHARS));
    }
    const projection = records.join('\n\n').slice(0, SAFE_CHARACTER_CONTEXT_MAX_TOTAL_CHARS);
    return {
        text: projection, records: records.length, requested: names.length,
        omitted: Math.max(0, names.length - records.length),
        chars: projection.length,
        tokens: Math.ceil(projection.length / 4),
    };
}