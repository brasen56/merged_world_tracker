/**
 * knowledge/relationships.js — Relationship CRUD, managed-block helpers,
 * and lorebook sync.
 *
 * Uses dynamic import() for lorebook read/write functions to avoid a
 * circular dependency with lorebook.js (which imports stripRelationshipBlock
 * from here).
 */

import {
    RELATIONSHIP_BLOCK_START, RELATIONSHIP_BLOCK_END,
    RELATIONSHIP_TYPES, USER_STANCES, state,
} from './state.js';
import { getRegistry, getRegistryEntry, getAllNpcNames } from './registry.js';
import { getLorebookName } from './scope.js';
import { readField, writeField } from './store.js';
import { getRecentMessages, normaliseOutput, parseJsonLenient, captureScope, assertSameScope } from '../core/index.js';
import { hasValidSettings } from './settings.js';
import { RELATIONSHIP_EXTRACT_SYSTEM_PROMPT } from './prompts.js';

// ─── Relationship data CRUD ──────────────────────────────────────────────────
//
// Relationships describe edges between NPCs that have entries in the Knowledge
// book, so they live in that book's store rather than in chat metadata — same
// lifetime as the entries they reference.

export function getRelationships() {
    return readField(getLorebookName(), 'relationships', {});
}

export function saveRelationships(rels) {
    // A flat { npcName: Edge[] } map. Nothing may merge a `lastUpdated` sibling
    // into it — callers iterate the values as edge arrays.
    writeField(getLorebookName(), 'relationships', rels);
}

export function getNpcRelationships(name) { return getRelationships()[name] || []; }

/**
 * Stamp an edge's stable entity pointers from the registry (TODO §1 identity
 * service): the map-key NPC's `subjectEntityId` and the target NPC's
 * `targetEntityId`. Only fills ABSENT pointers — an id a previous write
 * stamped is the edge's identity anchor and must survive later renames (which
 * change the display names, never the ids). Unresolvable endpoints (a target
 * that left the registry) are left bare, exactly like legacy edges.
 */
function stampEdgeEntityIds(fromName, edge) {
    const reg = getRegistry();
    if (!edge.subjectEntityId && reg[fromName]?.entityId) {
        edge.subjectEntityId = reg[fromName].entityId;
    }
    if (!edge.targetEntityId && reg[edge.target]?.entityId) {
        edge.targetEntityId = reg[edge.target].entityId;
    }
}

// ─── Provenance ──────────────────────────────────────────────────────────────
//
// Auto-extraction and the manual editor write through the same CRUD helpers, so
// every record records who wrote it. The extractor may only modify what it owns:
// a hand-entered edge is the user's statement about their story, and a model
// that reads a quiet scene must not be able to overwrite it.
//
// The fail-safe DIRECTION is the part that matters. Only the exact string
// 'auto' counts as auto-managed. A record with no `source` predates provenance —
// and because auto-extraction shipped off by default, everything already sitting
// in a store was entered by hand. Missing therefore reads as MANUAL (locked),
// never as auto. Getting this backwards would let the first run after upgrading
// wipe exactly the data this guard exists to protect.

export const SOURCE_AUTO = 'auto';
export const SOURCE_MANUAL = 'manual';

/** True only when the extractor owns this edge and may overwrite it. */
export function isEdgeAutoManaged(edge) { return edge?.source === SOURCE_AUTO; }

export function addRelationship(from, to, type, notes, source = SOURCE_MANUAL) {
    const rels = getRelationships();
    if (!rels[from]) rels[from] = [];
    if (!rels[from].some(r => r.target === to)) {
        const edge = { target: to, type, notes: notes || '', source };
        stampEdgeEntityIds(from, edge);
        rels[from].push(edge);
        saveRelationships(rels);
    }
}

export function removeRelationship(from, to) {
    const rels = getRelationships();
    if (rels[from]) {
        rels[from] = rels[from].filter(r => r.target !== to);
        if (rels[from].length === 0) delete rels[from];
        saveRelationships(rels);
    }
}

export function removeAllRelationshipsFor(name) {
    const rels = getRelationships();
    let changed = false;

    // Remove outgoing edges from this NPC
    if (rels[name]) {
        delete rels[name];
        changed = true;
    }

    // Remove incoming edges pointing to this NPC.
    // Compute the filtered list *before* mutating/deleting so the `changed`
    // flag and the empty-bucket cleanup both rely on a concrete value rather
    // than reading `.length` from a property that may have just been deleted.
    for (const [from, targets] of Object.entries(rels)) {
        const before = targets.length;
        const filtered = targets.filter(r => r.target !== name);
        if (filtered.length !== before) {
            changed = true;
            if (filtered.length === 0) delete rels[from];
            else rels[from] = filtered;
        }
    }

    if (changed) saveRelationships(rels);
}

export function updateRelationship(from, to, type, notes, source = SOURCE_MANUAL) {
    const rels = getRelationships();
    if (!rels[from]) rels[from] = [];
    const existing = rels[from].find(r => r.target === to);
    if (existing) {
        existing.type = type;
        existing.notes = notes || '';
        // An edit re-stamps ownership: a human touching an auto edge claims it
        // (locking it), and the extractor re-confirming its own stays auto.
        existing.source = source;
        stampEdgeEntityIds(from, existing);
    } else {
        const edge = { target: to, type, notes: notes || '', source };
        stampEdgeEntityIds(from, edge);
        rels[from].push(edge);
    }
    saveRelationships(rels);
}

/** Flip one edge between locked (manual) and auto-managed. Returns the new source. */
export function toggleEdgeSource(from, to) {
    const rels = getRelationships();
    const edge = (rels[from] || []).find(r => r.target === to);
    if (!edge) return null;
    edge.source = isEdgeAutoManaged(edge) ? SOURCE_MANUAL : SOURCE_AUTO;
    saveRelationships(rels);
    return edge.source;
}

// ─── Stance toward {{user}} ──────────────────────────────────────────────────
//
// A per-NPC scalar rather than an edge: {{user}} has no Knowledge entry to point
// at, and stance is disposition ("wary") where relationship types are structural
// ("employer") — an NPC can be a friend who has turned wary. Stored beside the
// edges in the same book store and emitted into the same managed block, so one
// sync writes both.

export function getStances() {
    return readField(getLorebookName(), 'stances', {});
}

export function saveStances(stances) {
    writeField(getLorebookName(), 'stances', stances);
}

export function getStance(name) { return getStances()[name] || ''; }

// Stance provenance rides in a PARALLEL map rather than turning each stance into
// an object. `getStance` returning a bare string is load-bearing — the managed
// block builder and the whole editor read it that way — so widening the value
// would ripple through every consumer to record one bit that only two callers
// care about. Same fail-safe rule as edges: absent means manual.

export function getStanceSources() { return readField(getLorebookName(), 'stanceSources', {}); }

export function saveStanceSources(sources) { writeField(getLorebookName(), 'stanceSources', sources); }

/** True only when the extractor owns this NPC's stance and may overwrite it. */
export function isStanceAutoManaged(name) { return getStanceSources()[name] === SOURCE_AUTO; }

/** Passing an empty stance clears it, which drops the line from the block. */
export function setStance(name, stance, source = SOURCE_MANUAL) {
    const stances = getStances();
    const sources = getStanceSources();
    if (stance) {
        stances[name] = stance;
        sources[name] = source;
    } else {
        delete stances[name];
        delete sources[name];
    }
    saveStances(stances);
    saveStanceSources(sources);
}

/** Flip one NPC's stance between locked (manual) and auto-managed. */
export function toggleStanceSource(name) {
    const sources = getStanceSources();
    if (!getStances()[name]) return null;
    sources[name] = isStanceAutoManaged(name) ? SOURCE_MANUAL : SOURCE_AUTO;
    saveStanceSources(sources);
    return sources[name];
}

/** Two edges collapsing into one stay auto-managed only if BOTH were. A rename
 *  must not be a laundering path that turns a locked edge back into a loose one. */
function mergedSource(a, b) {
    return (isEdgeAutoManaged(a) && isEdgeAutoManaged(b)) ? SOURCE_AUTO : SOURCE_MANUAL;
}

export function rekeyRelationships(oldName, newName) {
    if (oldName === newName) return;
    // NOTE (TODO §1): a rename changes DISPLAY names only. The edges' stable
    // `subjectEntityId`/`targetEntityId` pointers ride along untouched (the
    // spread below copies them), which is exactly what lets
    // repairRelationshipEntityNames() heal a rekey that was ever missed.
    const stances = getStances();
    if (stances[oldName] !== undefined) {
        stances[newName] = stances[oldName];
        delete stances[oldName];
        saveStances(stances);
    }
    // Carry provenance across the rename too — a lock that silently evaporated
    // when an NPC was renamed would hand the entry straight back to the model.
    const stanceSources = getStanceSources();
    if (stanceSources[oldName] !== undefined) {
        stanceSources[newName] = stanceSources[oldName];
        delete stanceSources[oldName];
        saveStanceSources(stanceSources);
    }
    const rels = getRelationships();
    if (!rels) return;
    // 1) Re-point outgoing edges: oldName -> * becomes newName -> *
    if (rels[oldName]) {
        if (!rels[newName]) rels[newName] = [];
        for (const edge of rels[oldName]) {
            const existing = rels[newName].find(r => r.target === edge.target);
            if (existing) {
                existing.type = edge.type;
                if (edge.notes) existing.notes = edge.notes;
                existing.source = mergedSource(existing, edge);
            } else {
                rels[newName].push({ ...edge });
            }
        }
        delete rels[oldName];
    }
    // 2) Re-point incoming edges: * -> oldName becomes * -> newName
    for (const [from, targets] of Object.entries(rels)) {
        for (let i = targets.length - 1; i >= 0; i--) {
            if (targets[i].target === oldName) {
                const existing = targets.find((r, idx) => idx !== i && r.target === newName);
                if (existing) {
                    existing.type = targets[i].type;
                    if (targets[i].notes) existing.notes = targets[i].notes;
                    existing.source = mergedSource(existing, targets[i]);
                    targets.splice(i, 1);
                } else {
                    targets[i].target = newName;
                }
            }
        }
        if (targets.length === 0) delete rels[from];
    }
    saveRelationships(rels);
}

/**
 * Merge one NPC's relationship identity into another's (TODO §1 identity
 * service — the user-approved mergeEntities() calls this). Same discipline as
 * rekeyRelationships, but KEEP semantics:
 *   - the keep record's stance wins; the merged stance is adopted only when
 *     keep has none (with its provenance, so a lock travels);
 *   - outgoing edges of the merged NPC move under keep (overlaps collapse via
 *     mergedSource — a merged pair stays auto only if BOTH were);
 *   - incoming edges re-point at keep (same overlap collapse);
 *   - edges whose two endpoints the merge collapses onto the SURVIVOR are
 *     dropped, not moved: `merge → keep`, `keep → merge`, and a pre-existing
 *     self-edge on the absorbed record (`merge → merge`) would all render as
 *     `keep → keep` — a self-relationship in every managed block. (A
 *     pre-existing self-edge on the KEEP record predates the merge and is the
 *     user's own data, so it is left alone.);
 *   - every surviving/moved edge carries the keep record's entityId as its
 *     subject pointer where it can be resolved.
 *
 * @param {string} keepName — canonical name of the surviving NPC
 * @param {string} mergeName — canonical name of the NPC being absorbed
 * @returns {{edgesMoved:number, edgesMerged:number, incomingRepointed:number, edgesDropped:number, stanceAdopted:boolean}}
 */
export function mergeRelationshipIdentities(keepName, mergeName) {
    const result = { edgesMoved: 0, edgesMerged: 0, incomingRepointed: 0, edgesDropped: 0, stanceAdopted: false };

    const stances = getStances();
    if (stances[mergeName] !== undefined && stances[keepName] === undefined) {
        setStance(keepName, stances[mergeName], getStanceSources()[mergeName] ?? SOURCE_MANUAL);
        result.stanceAdopted = true;
    }
    // Clear whatever merged stance remains — keep's (possibly adopted) stance
    // is the surviving statement either way.
    setStance(mergeName, '');

    const rels = getRelationships();
    if (!rels) return result;

    // 1) Outgoing: mergeName -> * moves under keepName — except edges whose
    //    target collapses onto the survivor: mergeName -> keepName (the two
    //    identities ARE each other now) and a pre-existing self-edge
    //    mergeName -> mergeName. Both would become keepName -> keepName.
    if (rels[mergeName]) {
        if (!rels[keepName]) rels[keepName] = [];
        for (const edge of rels[mergeName]) {
            if (edge.target === keepName || edge.target === mergeName) {
                result.edgesDropped++;
                continue;
            }
            const existing = rels[keepName].find(r => r.target === edge.target);
            if (existing) {
                existing.type = edge.type;
                if (edge.notes) existing.notes = edge.notes;
                existing.source = mergedSource(existing, edge);
                result.edgesMerged++;
            } else {
                rels[keepName].push({ ...edge });
                result.edgesMoved++;
            }
        }
        delete rels[mergeName];
    }

    // 2) Incoming: * -> mergeName re-points at keepName — except keepName ->
    //    mergeName, which collapses into a self-edge and is dropped the same
    //    way instead of being repointed or merged into a self-relationship.
    for (const [from, targets] of Object.entries(rels)) {
        for (let i = targets.length - 1; i >= 0; i--) {
            if (targets[i].target !== mergeName) continue;
            if (from === keepName) {
                targets.splice(i, 1);
                result.edgesDropped++;
                continue;
            }
            const existing = targets.find((r, idx) => idx !== i && r.target === keepName);
            if (existing) {
                existing.type = targets[i].type;
                if (targets[i].notes) existing.notes = targets[i].notes;
                existing.source = mergedSource(existing, targets[i]);
                targets.splice(i, 1);
                result.edgesMerged++;
            } else {
                targets[i] = { ...targets[i], target: keepName };
                result.incomingRepointed++;
            }
        }
        if (targets.length === 0) delete rels[from];
    }

    // Re-point the survivors' ids at the keep record where the registry can
    // resolve them — moved edges still carry the merged NPC's subjectEntityId,
    // which the merge just retired.
    const reg = getRegistry();
    const keepId = reg[keepName]?.entityId;
    if (keepId && rels[keepName]) {
        for (const edge of rels[keepName]) {
            if (edge.subjectEntityId && edge.subjectEntityId !== keepId) edge.subjectEntityId = keepId;
        }
    }
    if (keepId) {
        for (const targets of Object.values(rels)) {
            for (const edge of targets) {
                if (edge.target === keepName && edge.targetEntityId && edge.targetEntityId !== keepId) {
                    edge.targetEntityId = keepId;
                }
            }
        }
    }

    saveRelationships(rels);
    return result;
}

/**
 * Heal relationship display names from their stable entity ids (TODO §1).
 * The payoff of id-stamped edges: a rename that ever missed a surface (an
 * interrupted rename, imported data, a hand-rekeyed legacy store) leaves edges
 * whose names no longer resolve — and the ids still say exactly which entity
 * each endpoint was.
 *
 * Conservative by design:
 *   - a map key that names NO registry record is rekeyed to the record its
 *     edges' (single, agreeing) subjectEntityId points at — merged into any
 *     bucket already under that name;
 *   - an edge target that names no registry record is re-pointed to the record
 *     its targetEntityId points at (collapsing a duplicate if one appears);
 *   - a name that resolves to a DIFFERENT entity than the id claims is a
 *     genuine conflict, not rename residue — reported, never overwritten;
 *   - ids are stamped onto any edge that lacks them (legacy healing).
 *
 * @returns {{keysRekeyed:number, targetsRepointed:number, edgesMerged:number, idsStamped:number, conflicts:Array<{kind:string,detail:string}>}}
 */
export function repairRelationshipEntityNames() {
    const reg = getRegistry();
    const byId = new Map();
    for (const [name, record] of Object.entries(reg)) {
        if (record?.entityId && !byId.has(record.entityId)) byId.set(record.entityId, name);
    }
    const result = { keysRekeyed: 0, targetsRepointed: 0, edgesMerged: 0, idsStamped: 0, conflicts: [] };
    const rels = getRelationships();

    // 1) Map keys whose name no longer resolves — heal from the edges' single
    //    agreeing subject id. (Snapshot the keys: the loop re-keys buckets.)
    for (const [name, edges] of Object.entries({ ...rels })) {
        if (reg[name] || !Array.isArray(edges) || edges.length === 0) continue;
        const ids = new Set(edges.map(e => e?.subjectEntityId).filter(Boolean));
        if (ids.size !== 1) {
            result.conflicts.push({ kind: 'subject-unresolvable', detail: `Key "${name}" names no registry record and its edges agree on no single subjectEntityId.` });
            continue;
        }
        const canonical = byId.get([...ids][0]);
        if (!canonical) {
            result.conflicts.push({ kind: 'subject-unknown-id', detail: `Key "${name}" names no registry record and its subjectEntityId matches none either.` });
            continue;
        }
        if (rels[canonical]) {
            for (const edge of edges) {
                const existing = rels[canonical].find(r => r.target === edge.target);
                if (existing) {
                    existing.type = edge.type;
                    if (edge.notes) existing.notes = edge.notes;
                    existing.source = mergedSource(existing, edge);
                } else {
                    rels[canonical].push(edge);
                }
            }
        } else {
            rels[canonical] = edges;
        }
        delete rels[name];
        result.keysRekeyed++;
    }

    // 2) Edge targets whose name no longer resolves — heal from targetEntityId.
    for (const [from, targets] of Object.entries(rels)) {
        if (!Array.isArray(targets)) continue;
        for (let i = targets.length - 1; i >= 0; i--) {
            const edge = targets[i];
            if (!edge?.target || !edge.targetEntityId) continue;
            const current = reg[edge.target]?.entityId;
            if (current === edge.targetEntityId) continue;
            if (reg[edge.target]) {
                result.conflicts.push({ kind: 'target-conflict', detail: `Edge ${from} → ${edge.target}: the name resolves to a different entity than its targetEntityId claims.` });
                continue;
            }
            const canonical = byId.get(edge.targetEntityId);
            if (!canonical) {
                result.conflicts.push({ kind: 'target-unknown-id', detail: `Edge ${from} → ${edge.target}: the target names no record and its targetEntityId matches none either.` });
                continue;
            }
            const existing = targets.find((r, idx) => idx !== i && r.target === canonical);
            if (existing) {
                existing.type = edge.type;
                if (edge.notes) existing.notes = edge.notes;
                existing.source = mergedSource(existing, edge);
                targets.splice(i, 1);
                result.edgesMerged++;
            } else {
                edge.target = canonical;
                result.targetsRepointed++;
            }
        }
        if (targets.length === 0) delete rels[from];
    }

    // 3) Bulk-stamp ids the first two passes could not reach (legacy edges).
    let changed = false;
    for (const [from, targets] of Object.entries(rels)) {
        if (!Array.isArray(targets)) continue;
        for (const edge of targets) {
            const hadSubject = Boolean(edge.subjectEntityId);
            const hadTarget = Boolean(edge.targetEntityId);
            stampEdgeEntityIds(from, edge);
            if (!hadSubject && edge.subjectEntityId) { result.idsStamped++; changed = true; }
            if (!hadTarget && edge.targetEntityId) { result.idsStamped++; changed = true; }
        }
    }

    if (result.keysRekeyed || result.targetsRepointed || result.edgesMerged || changed) {
        saveRelationships(rels);
    }
    return result;
}

// ─── Managed block helpers ───────────────────────────────────────────────────

export function stripRelationshipBlock(content) {
    if (!content) return content;
    const startIdx = content.indexOf(RELATIONSHIP_BLOCK_START);
    if (startIdx === -1) return content;
    const endIdx = content.indexOf(RELATIONSHIP_BLOCK_END, startIdx);
    if (endIdx === -1) return content;
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + RELATIONSHIP_BLOCK_END.length);
    return (before + after).replace(/\n{3,}/g, '\n\n').trim();
}

export function injectRelationshipBlock(content, blockText) {
    const stripped = stripRelationshipBlock(content || '');
    const block = `${RELATIONSHIP_BLOCK_START}\n${blockText}\n${RELATIONSHIP_BLOCK_END}`;
    if (!stripped) return block;
    return `${stripped}\n\n${block}`;
}

export function formatRelationshipBlock(name) {
    const lines = [];

    // Fixed label — presets match on this exact prefix to gate NPC behaviour,
    // so it must not be reworded or merged into the Relationships line.
    const stance = getStance(name);
    if (stance) lines.push(`Stance toward {{user}}: ${stance}.`);

    const rels = getNpcRelationships(name);
    if (rels.length) {
        const edges = rels.map(r => {
            const note = r.notes ? ` (${r.notes})` : '';
            return `${r.type} of ${r.target}${note}`;
        });
        lines.push(`Relationships: ${edges.join('; ')}.`);
    }

    return lines.join('\n');
}

export async function syncRelationshipsToLorebook(name) {
    const { loadEntryContent, writeToLorebook } = await import('./lorebook.js');
    // KNOWLEDGE-03: Use getRegistryEntry so a given-name or alternate spelling
    // resolves to the canonical registry key instead of silently missing.
    const entry = getRegistryEntry(name);
    if (!entry || entry.info.uid == null) return { success: false, error: 'No lorebook entry' };
    const reg = entry.info;
    const canonicalName = entry.key;
    // KNOWLEDGE-04: Capture scope before the loadEntryContent await. The read
    // → await → write sequence straddles an async boundary, and the write
    // resolves the book dynamically — a chat/scope change between read and
    // write can target a different book, writing one character's relationship
    // block into another character's entry.
    const scopeBefore = captureScope();
    // Label-verified against the canonical key: a stale uid must not have
    // another NPC's relationship block injected into (or stripped from) it.
    const currentContent = await loadEntryContent(reg.uid, canonicalName);
    // KNOWLEDGE-04: Assert scope after the await and before the write. If the
    // chat changed during loadEntryContent, discard rather than risking a
    // cross-chat/cross-book write.
    if (!assertSameScope(scopeBefore).ok) {
        console.log(`[MWT:Knowledge] syncRelationshipsToLorebook("${name}") aborted — chat changed during loadEntryContent().`);
        return { success: false, error: 'chat changed during sync' };
    }
    if (currentContent === null) return { success: false, error: 'Could not load entry' };
    const blockText = formatRelationshipBlock(canonicalName);
    const newContent = blockText ? injectRelationshipBlock(currentContent, blockText) : stripRelationshipBlock(currentContent);
    if (newContent === currentContent) return { success: true, unchanged: true };
    return writeToLorebook(canonicalName, newContent, reg.keywords || [canonicalName], reg.uid);
}

export async function syncAllRelationshipsToLorebooks() {
    const registry = getRegistry();
    let synced = 0, failed = 0;
    for (const [name, info] of Object.entries(registry)) {
        if (info.uid === null || info.uid === undefined) continue;
        try {
            const result = await syncRelationshipsToLorebook(name);
            if (result.success && !result.unchanged) synced++;
            else if (!result.success) failed++;
        } catch (err) { console.warn(`[MWT:Knowledge] Sync relationships for "${name}" failed:`, err); failed++; }
    }
    return { synced, failed };
}

// ─── Automatic relationship extraction ───────────────────────────────────────
//
// Reads recent messages and proposes relationship edges (between tracked NPCs)
// plus each NPC's stance toward {{user}}, then applies them via the existing
// CRUD helpers. The caller (knowledge/index.js) re-syncs the affected lorebook
// entries afterwards.
//
// Design invariants:
// - Only ADDs or UPDATEs. It never deletes an edge or clears a stance, so manual
//   edits (and the "remove" actions in the relationship editor) always survive.
// - Both endpoints of an edge must resolve to a KNOWN registry entry (via
//   getRegistryEntry), so name variants ("Mara" vs "Mara Vance") canonicalize
//   and we never create an edge to an entity with no lorebook entry.
// - type/stance are validated against the canonical enums (RELATIONSHIP_TYPES /
//   USER_STANCES); anything outside is dropped, so the managed block format
//   stays stable and presets keep matching the stance label.

// "neutral" is a legal enum member but it is not a FINDING — it is the shape a
// model produces when it has nothing to report, and the prompt telling it to
// omit unclear entries is a request, not a constraint. Writing it back is how a
// quiet scene silently flattens a relationship graph, so the extractor treats it
// as no signal. The manual editor still offers it: a human choosing neutral is
// making a real statement.
const NO_SIGNAL = 'neutral';

/** The "nothing happened" result shape, shared by every no-op exit path. */
function emptyExtractResult() {
    return {
        affectedNpcs: new Set(),
        edgesAdded: 0, edgesUpdated: 0, stancesSet: 0,
        skipped: 0, skippedManual: 0, skippedNeutral: 0,
        changes: [],
    };
}

// ─── Recent-changes log (session-scoped) ─────────────────────────────────────
//
// The auto-extract cadence used to announce "+2 relationship(s), ~1 updated" —
// counts with no WHO or TO WHAT. The extract result now carries a `changes`
// array with one record per applied mutation, and those records land here so
// the Relationships tab can show "Recent Changes" with names and old → new
// values.
//
// Deliberately NOT persisted into the lorebook store: every store field is
// schema-validated, versioned, and carried by the backup/restore merge
// planner, and a session review list is not worth that surface. The log lives
// in shared runtime state — it survives sub-tab navigation and modal
// open/close, resets on chat change (changes belong to the chat they happened
// in), and is capped so a long session cannot grow it unboundedly.

/** Newest-first cap for the recent-changes log. */
export const REL_CHANGE_LOG_CAP = 40;

/** Stamp + prepend change records to the session log, newest first. */
export function recordRelationshipChanges(changes, origin = 'auto') {
    const list = Array.isArray(changes) ? changes : [];
    if (list.length === 0) return;
    const ts = Date.now();
    // Stamp the batch, then splice it in as ONE newest-first block so records
    // keep their emitted order within the batch (edge 1, edge 2, stance…).
    const stamped = [];
    for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        stamped.push({ ...c, ts, origin });
    }
    if (stamped.length === 0) return;
    state.relRecentChanges.unshift(...stamped);
    if (state.relRecentChanges.length > REL_CHANGE_LOG_CAP) {
        state.relRecentChanges.length = REL_CHANGE_LOG_CAP;
    }
}

export function getRecentRelationshipChanges() { return state.relRecentChanges; }

export function clearRecentRelationshipChanges() { state.relRecentChanges = []; }

/**
 * Format one change record as a human line, shared by the completion toast and
 * the Recent Changes panel so the two can never disagree about phrasing.
 *
 *   edge added:    "Mara → Jonah: friend (childhood friends)"
 *   edge updated:  "Mara → Jonah: rival (was friend)"
 *   notes-only:    "Mara → Jonah: friend (met at the docks)"
 *   edge removed:  "Mara → Jonah: removed (was friend)"
 *   stance set:    "Beck toward {{user}}: hostile (was wary)"
 *   stance cleared:"Beck toward {{user}}: cleared (was wary)"
 *
 * @param {object} c - a change record from applyExtractedRelationships or the
 *   manual editor logging sites
 * @returns {string}
 */
export function describeRelationshipChange(c) {
    if (!c || typeof c !== 'object') return '';
    const notes = c.notes ? ` (${String(c.notes).slice(0, 40)})` : '';
    // "(was X)" only when the type ACTUALLY changed: applyExtractedRelationships
    // records notes-only updates too, and those would otherwise read as
    // "friend (was friend)" — the notes fall through in the tail instead.
    const was = (c.previousType && c.previousType !== c.type) ? ` (was ${c.previousType})` : '';
    if (c.kind === 'edge') {
        if (c.action === 'removed') return `${c.from} → ${c.to}: removed${was}`;
        return `${c.from} → ${c.to}: ${c.type}${was || notes}`;
    }
    if (c.kind === 'stance') {
        const label = `toward {{user}}`;
        if (c.action === 'cleared') {
            return `${c.npc} ${label}: cleared${c.previousStance ? ` (was ${c.previousStance})` : ''}`;
        }
        return `${c.npc} ${label}: ${c.stance}${c.previousStance ? ` (was ${c.previousStance})` : ''}`;
    }
    return '';
}

/**
 * Extract relationships + stances from recent messages and apply them.
 *
 * @param {object} [opts]
 * @param {string} [opts.trigger=null] — cause of the call; threaded down so
 *   the coordinator classifies cadence-driven auto extracts as background
 *   work (trigger-less manual paths stay foreground by design)
 * @returns {Promise<{affectedNpcs:Set<string>, edgesAdded:number, edgesUpdated:number, stancesSet:number, skipped:number}>}
 */
export async function runRelationshipExtract({ trigger = null } = {}) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');

    // KNOWLEDGE-04: Capture scope before the API round-trip. See the assert
    // below for why this one matters more than the caller's own check.
    const scopeBefore = captureScope();

    const knownNames = getAllNpcNames();
    if (knownNames.length < 1) {
        // Nothing to relate. Returning a no-op (rather than throwing) lets the
        // cadence fire harmlessly before the user has scanned any NPCs.
        return emptyExtractResult();
    }

    // Knowledge prompt — no actor/witness partition rules for the sealed
    // Off-Screen Events log (unlike interiority), so this call site must
    // strip: an unwitnessed off-screen meeting must never seed a relationship
    // edge. `strip: true` also removes preset trackers/old chatter from the
    // evidence window, and `preserveOffScreen: false` opts the sealed log out
    // of the strip exception — the same policy as every other Knowledge call
    // site (see core/strip.js).
    const recentMessages = getRecentMessages({ maxMessages: 50, stableHistory: true, strip: true, preserveOffScreen: false });
    if (!recentMessages) throw new Error('No recent messages to scan for relationships.');

    const rosterSection = `<known_npcs>\n${knownNames.map(n => `- ${n}`).join('\n')}\n</known_npcs>`;
    const userContent = [
        rosterSection, '',
        '<recent_messages>', recentMessages, '</recent_messages>', '',
        '='.repeat(60),
        'Extract relationships. Output only JSON.',
    ].join('\n');

    // Dynamic import avoids a circular dependency with lorebook.js (which imports
    // stripRelationshipBlock from here).
    const { ktFetchFromApi } = await import('./lorebook.js');

    // Retry once on parse failure (mirrors runScan's two-attempt loop).
    let lastErr = null;
    let lastPreview = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        const raw = await ktFetchFromApi(RELATIONSHIP_EXTRACT_SYSTEM_PROMPT, userContent, { trigger });
        // KNOWLEDGE-04: Assert scope BEFORE applying, not just in the caller.
        // applyExtractedRelationships writes through writeField(getLorebookName(),
        // …), and getLorebookName() resolves per chat/character under non-global
        // scope — so a chat switch during the API call would read-merge-and-write
        // this chat's edges into a DIFFERENT chat's book. The caller re-checks
        // scope too, but that check runs after these writes have already landed,
        // so it can only discard the return value, not undo the contamination.
        // Abort outright rather than retrying: the results belong to the old chat.
        if (!assertSameScope(scopeBefore).ok) {
            console.log('[MWT:Knowledge] Relationship extract discarded — chat changed during API call.');
            return emptyExtractResult();
        }
        const cleaned = normaliseOutput(raw);
        try {
            const result = parseJsonLenient(cleaned);
            return applyExtractedRelationships(result);
        } catch (err) {
            lastErr = err;
            lastPreview = cleaned.slice(0, 120);
            console.warn(`[MWT:Knowledge] Relationship extract parse failed (attempt ${attempt}): ${err.message}. Preview: "${lastPreview}"`);
            if (attempt < 2) continue;
        }
    }
    throw new Error(`Model did not return valid JSON after 2 attempts. Last error: ${lastErr?.message || 'unknown'}. Preview: "${lastPreview}"`);
}

/**
 * Validate and apply a parsed extraction result. Exported separately so it can be
 * unit-tested without an API call.
 *
 * @param {{edges?:Array, stances?:Array}} result
 * @returns {{affectedNpcs:Set<string>, edgesAdded:number, edgesUpdated:number, stancesSet:number, skipped:number, changes:Array<object>}}
 */
export function applyExtractedRelationships(result) {
    const affected = new Set();
    const typeSet = new Set(RELATIONSHIP_TYPES);
    const stanceSet = new Set(USER_STANCES);
    let edgesAdded = 0, edgesUpdated = 0, stancesSet = 0;
    let skipped = 0, skippedManual = 0, skippedNeutral = 0;
    // One record per APPLIED mutation (who, what, and what it used to be) —
    // feeds the completion toast and the Recent Changes panel.
    const changes = [];

    // ── Edges ──
    const edges = Array.isArray(result?.edges) ? result.edges : [];
    for (const e of edges) {
        if (!e || typeof e !== 'object') { skipped++; continue; }
        const from = typeof e.from === 'string' ? e.from.trim() : '';
        const to = typeof e.to === 'string' ? e.to.trim() : '';
        const type = typeof e.type === 'string' ? e.type.trim().toLowerCase() : '';
        if (!from || !to) { skipped++; continue; }
        if (!typeSet.has(type)) { skipped++; continue; }
        if (type === NO_SIGNAL) { skippedNeutral++; continue; }
        // Both endpoints must be known NPCs. Canonicalize through the resolver so
        // given-name variants match the full registry key.
        const fromEntry = getRegistryEntry(from);
        const toEntry = getRegistryEntry(to);
        if (!fromEntry || !toEntry) { skipped++; continue; }
        const fromName = fromEntry.key;
        const toName = toEntry.key;
        const notes = (typeof e.notes === 'string' ? e.notes.trim() : '').slice(0, 280);

        const existing = getNpcRelationships(fromName).find(r => r.target === toName);
        if (existing) {
            // The extractor may only overwrite what it wrote. A hand-entered edge
            // is the user's statement about their story; the model re-reading a
            // scene does not get to overrule it.
            if (!isEdgeAutoManaged(existing)) { skippedManual++; continue; }
            // Only mutate + count when something actually changes.
            if (existing.type !== type || existing.notes !== notes) {
                const previousType = existing.type;
                updateRelationship(fromName, toName, type, notes, SOURCE_AUTO);
                edgesUpdated++;
                affected.add(fromName);
                changes.push({ kind: 'edge', action: 'updated', from: fromName, to: toName, type, previousType, notes });
            }
        } else {
            addRelationship(fromName, toName, type, notes, SOURCE_AUTO);
            edgesAdded++;
            affected.add(fromName);
            changes.push({ kind: 'edge', action: 'added', from: fromName, to: toName, type, notes });
        }
    }

    // ── Stances toward {{user}} ──
    const stances = Array.isArray(result?.stances) ? result.stances : [];
    for (const s of stances) {
        if (!s || typeof s !== 'object') { skipped++; continue; }
        const npc = typeof s.npc === 'string' ? s.npc.trim() : '';
        const stance = typeof s.stance === 'string' ? s.stance.trim().toLowerCase() : '';
        if (!npc || !stanceSet.has(stance)) { skipped++; continue; }
        if (stance === NO_SIGNAL) { skippedNeutral++; continue; }
        const entry = getRegistryEntry(npc);
        if (!entry) { skipped++; continue; }
        const name = entry.key;
        // An unset stance is not a user statement, so the extractor may fill it.
        // An existing hand-set one is, and is off-limits.
        const current = getStance(name);
        if (current && !isStanceAutoManaged(name)) { skippedManual++; continue; }
        if (current !== stance) {
            setStance(name, stance, SOURCE_AUTO);
            stancesSet++;
            affected.add(name);
            changes.push({ kind: 'stance', action: 'set', npc: name, stance, previousStance: current });
        }
    }

    return { affectedNpcs: affected, edgesAdded, edgesUpdated, stancesSet, skipped, skippedManual, skippedNeutral, changes };
}
