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
    RELATIONSHIP_TYPES, USER_STANCES,
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

export function addRelationship(from, to, type, notes) {
    const rels = getRelationships();
    if (!rels[from]) rels[from] = [];
    if (!rels[from].some(r => r.target === to)) {
        rels[from].push({ target: to, type, notes: notes || '' });
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

export function updateRelationship(from, to, type, notes) {
    const rels = getRelationships();
    if (!rels[from]) rels[from] = [];
    const existing = rels[from].find(r => r.target === to);
    if (existing) {
        existing.type = type;
        existing.notes = notes || '';
    } else {
        rels[from].push({ target: to, type, notes: notes || '' });
    }
    saveRelationships(rels);
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

/** Passing an empty stance clears it, which drops the line from the block. */
export function setStance(name, stance) {
    const stances = getStances();
    if (stance) stances[name] = stance;
    else delete stances[name];
    saveStances(stances);
}

export function rekeyRelationships(oldName, newName) {
    if (oldName === newName) return;
    const stances = getStances();
    if (stances[oldName] !== undefined) {
        stances[newName] = stances[oldName];
        delete stances[oldName];
        saveStances(stances);
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
    const currentContent = await loadEntryContent(reg.uid);
    // KNOWLEDGE-04: Assert scope after the await and before the write. If the
    // chat changed during loadEntryContent, discard rather than risking a
    // cross-chat/cross-book write.
    if (!assertSameScope(scopeBefore).ok) {
        console.log(`[MWT:Knowledge] syncRelationshipsToLorebook("${name}") aborted — chat changed during loadEntryContent().`);
        return { success: false, error: 'chat changed during sync' };
    }
    if (currentContent === null) return { success: false, error: 'Could not load entry' };
    const blockText = formatRelationshipBlock(name);
    const newContent = blockText ? injectRelationshipBlock(currentContent, blockText) : stripRelationshipBlock(currentContent);
    if (newContent === currentContent) return { success: true, unchanged: true };
    return writeToLorebook(name, newContent, reg.keywords || [name], reg.uid);
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

/** The "nothing happened" result shape, shared by every no-op exit path. */
function emptyExtractResult() {
    return { affectedNpcs: new Set(), edgesAdded: 0, edgesUpdated: 0, stancesSet: 0, skipped: 0 };
}

/**
 * Extract relationships + stances from recent messages and apply them.
 *
 * @returns {Promise<{affectedNpcs:Set<string>, edgesAdded:number, edgesUpdated:number, stancesSet:number, skipped:number}>}
 */
export async function runRelationshipExtract() {
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

    const recentMessages = getRecentMessages({ maxMessages: 50 });
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
        const raw = await ktFetchFromApi(RELATIONSHIP_EXTRACT_SYSTEM_PROMPT, userContent);
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
 * @returns {{affectedNpcs:Set<string>, edgesAdded:number, edgesUpdated:number, stancesSet:number, skipped:number}}
 */
export function applyExtractedRelationships(result) {
    const affected = new Set();
    const typeSet = new Set(RELATIONSHIP_TYPES);
    const stanceSet = new Set(USER_STANCES);
    let edgesAdded = 0, edgesUpdated = 0, stancesSet = 0, skipped = 0;

    // ── Edges ──
    const edges = Array.isArray(result?.edges) ? result.edges : [];
    for (const e of edges) {
        if (!e || typeof e !== 'object') { skipped++; continue; }
        const from = typeof e.from === 'string' ? e.from.trim() : '';
        const to = typeof e.to === 'string' ? e.to.trim() : '';
        const type = typeof e.type === 'string' ? e.type.trim().toLowerCase() : '';
        if (!from || !to) { skipped++; continue; }
        if (!typeSet.has(type)) { skipped++; continue; }
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
            // Only mutate + count when something actually changes.
            if (existing.type !== type || existing.notes !== notes) {
                updateRelationship(fromName, toName, type, notes);
                edgesUpdated++;
                affected.add(fromName);
            }
        } else {
            addRelationship(fromName, toName, type, notes);
            edgesAdded++;
            affected.add(fromName);
        }
    }

    // ── Stances toward {{user}} ──
    const stances = Array.isArray(result?.stances) ? result.stances : [];
    for (const s of stances) {
        if (!s || typeof s !== 'object') { skipped++; continue; }
        const npc = typeof s.npc === 'string' ? s.npc.trim() : '';
        const stance = typeof s.stance === 'string' ? s.stance.trim().toLowerCase() : '';
        if (!npc || !stanceSet.has(stance)) { skipped++; continue; }
        const entry = getRegistryEntry(npc);
        if (!entry) { skipped++; continue; }
        const name = entry.key;
        if (getStance(name) !== stance) {
            setStance(name, stance);
            stancesSet++;
            affected.add(name);
        }
    }

    return { affectedNpcs: affected, edgesAdded, edgesUpdated, stancesSet, skipped };
}
