/**
 * Shared read/planning logic for the Knowledge maintenance tools.
 *
 * The console bridge and the Overview dashboard both consume these functions.
 * Planning is intentionally separate from applying: this module never writes
 * a registry or lorebook unless an explicit caller performs the returned plan.
 */

import {
    auditRegistryAliases as readRegistryAliases,
    getProfileUid as readProfileUid,
    resolveRegistryKey as resolveKey,
} from './registry.js';
import { listKnowledgeEntries as readKnowledgeEntries, listProfileEntries as readProfileEntries } from './lorebook.js';

// listProfileEntries() reports a comment-less entry as name ''. All of them
// share the '(unnamed)' bucket, which is NOT one NPC — planners must route
// that bucket to manual review, never treat it as a duplicate set.
function nameKey(name) {
    return String(name || '').toLowerCase().trim() || '(unnamed)';
}

/** Return every NPC Profiles entry annotated with its registry relationship. */
export async function auditProfiles({
    listProfileEntries = readProfileEntries,
    getProfileUid = readProfileUid,
} = {}) {
    const entries = await listProfileEntries();
    const groups = new Map();
    for (const entry of entries) {
        const key = nameKey(entry.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
    }
    const rows = [];
    for (const [, list] of groups) {
        const referenced = getProfileUid(list[0].name);
        for (const entry of list) {
            rows.push({
                npc: entry.name,
                uid: entry.uid,
                referenced: entry.uid === referenced,
                duplicate: list.length > 1,
                chars: entry.chars,
                preview: entry.preview,
            });
        }
    }
    return rows;
}

/**
 * Build the exact dry-run deletion plan used by pruneDuplicates().
 *
 * Groups the heuristic must not decide come back in `needsReview`, tagged
 * with why: 'unnamed' (comment-less entries share one bucket but may be
 * different NPCs) or 'tied' (nothing referenced and the largest entries are
 * the same size).
 *
 * @returns {{toDelete: object[], needsReview: Array<{reason: 'unnamed'|'tied', npc: string, rows: object[]}>}}
 */
export function planProfilePrune(rows = []) {
    const byNpc = new Map();
    for (const row of rows) {
        const key = nameKey(row.npc);
        if (!byNpc.has(key)) byNpc.set(key, []);
        byNpc.get(key).push(row);
    }

    // Per NPC: keep the registry-referenced entry; if none is referenced,
    // keep the LARGEST (a truncated/failed generation is the likelier
    // orphan) and break ties on the highest uid (most recent). Never
    // auto-delete when nothing is referenced AND sizes tie — that case
    // needs eyes, not a heuristic.
    const toDelete = [];
    const needsReview = [];
    for (const [key, list] of byNpc) {
        if (list.length < 2) continue;
        // Pruning across the unnamed bucket could delete a different
        // character's profile. Never automate.
        if (key === '(unnamed)') {
            needsReview.push({ reason: 'unnamed', npc: '', rows: list });
            continue;
        }
        const referenced = list.find((row) => row.referenced);
        let keep = referenced;
        if (!keep) {
            const sorted = [...list].sort((a, b) => b.chars - a.chars || b.uid - a.uid);
            if (sorted[0].chars === sorted[1].chars) {
                needsReview.push({ reason: 'tied', npc: list[0].npc, rows: list });
                continue;
            }
            keep = sorted[0];
        }
        for (const row of list) {
            if (row.uid !== keep.uid) toDelete.push({ ...row, keptUid: keep.uid });
        }
    }
    return { toDelete, needsReview };
}

/**
 * Build the plan for restoring missing/dangling profileUid pointers.
 *
 * Named entries with no registry record come back in `unmatched` — they
 * cannot be relinked until the NPC is scanned into the Knowledge book.
 * Unnamed entries are skipped outright (nothing identifies their NPC), and an
 * empty registry plans nothing, matching the console's refusal to relink
 * against one.
 *
 * @returns {Promise<{planned: object[], unmatched: Array<{npc: string, entries: object[]}>}>}
 */
export async function planProfileRelink({
    registry,
    listProfileEntries = readProfileEntries,
    resolveRegistryKey = resolveKey,
} = {}) {
    const reg = registry || {};
    if (Object.keys(reg).length === 0) return { planned: [], unmatched: [] };
    const grouped = new Map();
    for (const entry of await listProfileEntries()) {
        const key = String(entry.name || '').toLowerCase().trim();
        if (!key) continue; // unnamed entries can't be matched to an NPC
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(entry);
    }
    const planned = [];
    const unmatched = [];
    for (const [, list] of grouped) {
        const npc = list[0].name;
        const registryKey = resolveRegistryKey(reg, npc);
        if (registryKey == null) {
            unmatched.push({ npc, entries: list });
            continue;
        }
        const current = reg[registryKey]?.profileUid;
        // Already pointing at an entry that really exists: leave it be.
        if (current != null && list.some((entry) => entry.uid === current)) continue;
        // Largest first, newest to break ties — same heuristic as
        // planProfilePrune, for the same reason: a truncated generation is
        // the likelier orphan.
        const pick = [...list].sort((a, b) => b.chars - a.chars || b.uid - a.uid)[0];
        planned.push({
            npc,
            registryKey,
            linkUid: pick.uid,
            chars: pick.chars,
            was: current == null ? '(none)' : `${current} (dangling)`,
            otherCandidates: list.length - 1,
        });
    }
    return { planned, unmatched };
}

/** Read-only identity audit shared by the console and Overview. */
export async function auditNpcIdentities({
    registry = {},
    auditRegistryAliases = readRegistryAliases,
    listKnowledgeEntries = readKnowledgeEntries,
    resolveRegistryKey = resolveKey,
} = {}) {
    const rows = [];

    // 1) Registry identities that alias each other, or collide.
    for (const group of auditRegistryAliases(registry)) {
        for (const entry of group.entries) {
            rows.push({
                kind: group.kind === 'ambiguous' ? 'ambiguous-name' : 'registry-alias',
                npc: entry.name,
                uid: entry.uid,
                type: entry.type,
                detail: group.kind === 'ambiguous'
                    ? `shorthand collision: ${group.names.join(' / ')} — NOT proven to be one NPC`
                    : `aliases: ${group.names.join(' / ')}`,
            });
        }
    }

    // 2) Physical lorebook entries whose label is NOT the entry their
    //    canonical registry identity points at — the visible half of a
    //    duplicate (or an entry the registry never tracked at all).
    for (const entry of await listKnowledgeEntries()) {
        const canonical = resolveRegistryKey(registry, entry.name);
        if (canonical == null) {
            rows.push({
                kind: 'untracked-entry', npc: entry.name || '(unlabelled)', uid: entry.uid,
                type: '—', detail: `in book, no registry record (${entry.chars} chars: "${entry.preview}")`,
            });
        } else if (registry[canonical]?.uid !== entry.uid) {
            rows.push({
                kind: 'entry-not-linked', npc: entry.name, uid: entry.uid,
                type: registry[canonical]?.type ?? '—',
                detail: `canonical identity "${canonical}" points at uid ${registry[canonical]?.uid ?? '(none)'} (${entry.chars} chars: "${entry.preview}")`,
            });
        }
    }
    return rows;
}
