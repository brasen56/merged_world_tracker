/**
 * knowledge/relationships.js — Relationship CRUD, managed-block helpers,
 * and lorebook sync.
 *
 * Uses dynamic import() for lorebook read/write functions to avoid a
 * circular dependency with lorebook.js (which imports stripRelationshipBlock
 * from here).
 */

import { getChatMeta, persistChatMeta } from '../core/index.js';

import {
    RELATIONSHIP_KEY,
    RELATIONSHIP_BLOCK_START, RELATIONSHIP_BLOCK_END,
} from './state.js';
import { getRegistry } from './registry.js';

// ─── Relationship data CRUD ──────────────────────────────────────────────────

export function getRelationships() {
    const meta = getChatMeta();
    if (!meta[RELATIONSHIP_KEY]) meta[RELATIONSHIP_KEY] = {};
    const rels = meta[RELATIONSHIP_KEY];
    // Migration / hardening: a previous saveRelationships() routed through
    // patchChatMeta(), which merged a `lastUpdated` timestamp into this flat
    // { npcName: Edge[] } map. That non-array value made
    // `for (const r of targets)` throw ("targets is not iterable"), breaking
    // the whole sub-tab and preventing navigation back to it. Strip any value
    // that isn't an array of edges; persist the cleaned map once.
    let dirty = false;
    for (const key of Object.keys(rels)) {
        if (!Array.isArray(rels[key])) {
            delete rels[key];
            dirty = true;
        }
    }
    if (dirty) {
        meta[RELATIONSHIP_KEY] = rels;
        persistChatMeta();
    }
    return rels;
}

export function saveRelationships(rels) {
    // Relationships are a flat { npcName: Edge[] } map. Set it directly rather
    // than going through patchChatMeta(), which would merge a `lastUpdated`
    // sibling into the map and corrupt iteration over edges.
    const meta = getChatMeta();
    meta[RELATIONSHIP_KEY] = rels;
    persistChatMeta();
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

export function rekeyRelationships(oldName, newName) {
    if (oldName === newName) return;
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
    const rels = getNpcRelationships(name);
    if (!rels.length) return '';
    const lines = rels.map(r => {
        const note = r.notes ? ` (${r.notes})` : '';
        return `${r.type} of ${r.target}${note}`;
    });
    return `Relationships: ${lines.join('; ')}.`;
}

export async function syncRelationshipsToLorebook(name) {
    const { loadEntryContent, writeToLorebook } = await import('./lorebook.js');
    const reg = getRegistry()[name];
    if (!reg || reg.uid === null || reg.uid === undefined) return { success: false, error: 'No lorebook entry' };
    const currentContent = await loadEntryContent(reg.uid);
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