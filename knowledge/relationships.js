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
} from './state.js';
import { getRegistry } from './registry.js';
import { getLorebookName } from './scope.js';
import { readField, writeField } from './store.js';
import { captureScope, assertSameScope } from '../core/index.js';

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
    const reg = getRegistry()[name];
    if (!reg || reg.uid === null || reg.uid === undefined) return { success: false, error: 'No lorebook entry' };
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