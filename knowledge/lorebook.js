/**
 * knowledge/lorebook.js — Lorebook read/write, entry formatters, validation,
 * scan logic, and state/NPC update workflows.
 *
 * The world-info script is loaded as a side-effect (top-level await) so that
 * wiScript is available for all lorebook operations.
 */

import {
    getChat, getChatMeta, getPlayerNames,
    resolveApiCall, normaliseOutput, parseJsonLenient,
    getCurrentWorldState, getLatestChronicleEntry,
    escapeRegex, stripNonNarrative,
} from '../core/index.js';

import { SCAN_SYSTEM_PROMPT, STATE_UPDATE_PROMPT, NPC_UPDATE_PROMPT, DOSSIER_SCAN_SYSTEM_PROMPT, DOSSIER_UPDATE_PROMPT, DOSSIER_ENRICH_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings } from './settings.js';
import {
    LOREBOOK_NAME, STATE_LOREBOOK_NAME, TRACKER_SENTINEL,
    HISTORY_KEY_PREFIX, RELATIONSHIP_BLOCK_START, RELATIONSHIP_BLOCK_END,
    PROFILE_LOREBOOK_NAME,
    state,
} from './state.js';
import { getRegistry } from './registry.js';
import { hasEvidenceFile } from './evidence.js';
import { stripRelationshipBlock } from './relationships.js';

// ─── World-info import (side-effect) ────────────────────────────────────────

try {
    state.wiScript = await import('../../../../world-info.js');
    console.log('[MWT:Knowledge] world-info.js loaded.');
} catch (err) {
    console.warn('[MWT:Knowledge] Could not import world-info.js:', err?.message || err);
}

// ─── History ─────────────────────────────────────────────────────────────────
//
// History keys are namespaced by lorebook name (`kt_history_<lorebook>_<uid>`)
// so that entries in the "Knowledge Tracker" and "State Tracker" lorebooks —
// which independently assign UIDs starting at 0 — don't collide in
// localStorage.  The lorebook name is passed explicitly to every call.

export function pushHistory(uid, content, lorebook = LOREBOOK_NAME) {
    if (uid === null || uid === undefined) return;
    const key = HISTORY_KEY_PREFIX + lorebook + '_' + uid;
    let history = [];
    try { history = JSON.parse(localStorage.getItem(key) || '[]'); } catch { history = []; }
    history.unshift({ ts: Date.now(), content, msgIdx: getChat()?.length || 0 });
    if (history.length > 50) history.length = 50;
    try { localStorage.setItem(key, JSON.stringify(history)); } catch { /* quota */ }
}

export function getHistory(uid, lorebook = LOREBOOK_NAME) {
    if (uid === null || uid === undefined) return [];
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY_PREFIX + lorebook + '_' + uid) || '[]'); } catch { return []; }
}

// ─── Message helpers ─────────────────────────────────────────────────────────

export function getRecentMessages(count = 50) {
    const chat = getChat();
    if (!chat || !chat.length) return null;
    const slice = chat.slice(-count);
    const filtered = slice.filter(m => m.mes && !m.is_system);
    if (!filtered.length) return null;
    // Strip non-narrative blocks (preset trackers, old chatter, time tags)
    // so tracker secrets don't launder into knowledge scan context.
    return filtered.map(m => {
        const name = m.is_user ? (m.name || 'User') : (m.name || 'Assistant');
        return `${name}: ${stripNonNarrative(m.mes)}`;
    }).join('\n');
}

// ─── API fetch (delegates to shared core) ────────────────────────────────────

export async function ktFetchFromApi(systemPrompt, userContent, { retries = 1 } = {}) {
    const resolved = resolveApiCall({ moduleSettings: getSettings() });
    return resolved.fetchFn({ systemPrompt, userContent, settings: resolved.settings, retries });
}

// ─── Lorebook CRUD ───────────────────────────────────────────────────────────

export async function loadStateTrackerEntry(uid) {
    if (!state.wiScript) return null;
    try {
        const wi = await state.wiScript.loadWorldInfo(STATE_LOREBOOK_NAME);
        const entry = wi?.entries?.[uid];
        return entry ? { content: entry.content || '', comment: entry.comment || '' } : null;
    } catch (err) { console.warn('[MWT:Knowledge] Could not load state tracker entry:', err.message); return null; }
}

export async function writeStateTracker(uid, name, content) {
    if (!state.wiScript) return { success: false, error: 'world-info.js not loaded' };
    try {
        const wi = await state.wiScript.loadWorldInfo(STATE_LOREBOOK_NAME);
        const entry = wi?.entries?.[uid];
        if (!entry) return { success: false, error: `UID ${uid} not found in "${STATE_LOREBOOK_NAME}".` };
        const comment = entry.comment || '';
        if (!comment.startsWith(TRACKER_SENTINEL)) return { success: false, error: `UID ${uid} missing ${TRACKER_SENTINEL} sentinel.` };
        const previousContent = entry.content || '';
        entry.content = content;
        await state.wiScript.saveWorldInfo(STATE_LOREBOOK_NAME, wi);
        pushHistory(uid, previousContent, STATE_LOREBOOK_NAME);
        return { success: true, uid };
    } catch (err) { return { success: false, error: err.message }; }
}

export async function writeToLorebook(name, content, keywords, existingUid) {
    if (!state.wiScript) return { success: false, content, keywords, error: 'world-info.js not loaded' };
    try {
        let wi = await state.wiScript.loadWorldInfo(LOREBOOK_NAME);
        // Auto-create the lorebook if it doesn't exist yet.
        // createNewWorldInfo returns a boolean on the Aikobots v4 fork (and some
        // ST versions), not the world-info object. Always re-load after creating
        // and fall back to { entries: {} } if that still fails.
        if (!wi || !wi.entries) {
            if (typeof state.wiScript.createNewWorldInfo === 'function') {
                await state.wiScript.createNewWorldInfo(LOREBOOK_NAME);
            }
            wi = await state.wiScript.loadWorldInfo(LOREBOOK_NAME);
            if (!wi || !wi.entries) {
                wi = { entries: {} };
            }
        }
        const entries = wi.entries;
        if (existingUid !== null && existingUid !== undefined && entries[existingUid]) {
            const previousContent = entries[existingUid].content || '';
            pushHistory(existingUid, previousContent);
            entries[existingUid].content = content;
            entries[existingUid].key = keywords;
            entries[existingUid].comment = name;
            await state.wiScript.saveWorldInfo(LOREBOOK_NAME, wi);
            return { success: true, uid: existingUid };
        } else {
            const existingUids = Object.keys(entries).map(Number).filter(n => !isNaN(n));
            const newUid = existingUids.length > 0 ? existingUids.reduce((a, b) => a > b ? a : b, -1) + 1 : 0;
            entries[newUid] = {
                uid: newUid, key: keywords, keysecondary: [], comment: name, content, enabled: true,
                selective: false, constant: false, order: 100, position: 0, disable: false, addMemo: true,
                group: '', groupOverride: false, groupWeight: 100, sticky: null, cooldown: null, delay: null,
                probability: 100, useProbability: true, depth: 4, selectiveLogic: 0, excludeRecursion: false,
                preventRecursion: false, delayUntilRecursion: false, scanDepth: null, caseSensitive: null,
                matchWholeWords: null, useGroupScoring: null, automationId: '', role: null, vectorized: false,
                displayIndex: newUid,
            };
            await state.wiScript.saveWorldInfo(LOREBOOK_NAME, wi);
            return { success: true, uid: newUid };
        }
    } catch (err) { return { success: false, content, keywords, error: err.message }; }
}

export async function loadEntryContent(uid) {
    if (!state.wiScript) return null;
    try {
        const wi = await state.wiScript.loadWorldInfo(LOREBOOK_NAME);
        return wi?.entries?.[uid]?.content ?? null;
    } catch (err) { return null; }
}

// ─── NPC Profiles lorebook (Slice 2 — non-injected growth profiles) ──────────
//
// The "NPC Profiles" lorebook holds evidence-derived personality profiles.
// Its entries have the NPC name as `comment` (label) and NO keywords
// (`key: []`), so ST's world-info system never keyword-matches them — they
// are never injected. This is the "default OFF" position, achieved
// structurally (empty keywords) rather than via a toggle. If a user later
// wants the profile injected, they can add keywords manually; the module
// does not do it for them.
//
// See NPC_GROWTH_BLUEPRINT.md §"Profile storage & injection".

/**
 * Write (or overwrite) an NPC's growth profile in the NPC Profiles lorebook.
 *
 * @param {string} name — NPC name (used as entry comment/label)
 * @param {string} content — profile prose
 * @param {number|null} [existingUid] — existing profile UID to overwrite
 * @returns {Promise<{success:boolean, uid?:number, error?:string}>}
 */
export async function writeProfileToLorebook(name, content, existingUid) {
    if (!state.wiScript) return { success: false, error: 'world-info.js not loaded' };
    try {
        let wi = await state.wiScript.loadWorldInfo(PROFILE_LOREBOOK_NAME);
        // Auto-create the lorebook if it doesn't exist yet (same pattern as
        // writeToLorebook — createNewWorldInfo may return boolean, so re-load).
        if (!wi || !wi.entries) {
            if (typeof state.wiScript.createNewWorldInfo === 'function') {
                await state.wiScript.createNewWorldInfo(PROFILE_LOREBOOK_NAME);
            }
            wi = await state.wiScript.loadWorldInfo(PROFILE_LOREBOOK_NAME);
            if (!wi || !wi.entries) {
                wi = { entries: {} };
            }
        }
        const entries = wi.entries;
        if (existingUid !== null && existingUid !== undefined && entries[existingUid]) {
            entries[existingUid].content = content;
            entries[existingUid].comment = name;
            entries[existingUid].key = []; // no keywords → never injected
            await state.wiScript.saveWorldInfo(PROFILE_LOREBOOK_NAME, wi);
            return { success: true, uid: existingUid };
        } else {
            const existingUids = Object.keys(entries).map(Number).filter(n => !isNaN(n));
            const newUid = existingUids.length > 0 ? existingUids.reduce((a, b) => a > b ? a : b, -1) + 1 : 0;
            entries[newUid] = {
                uid: newUid,
                key: [],           // no keywords → ST world-info never injects this
                keysecondary: [],
                comment: name,
                content,
                enabled: true,
                selective: false, constant: false, order: 100, position: 0,
                disable: false, addMemo: true, group: '', groupOverride: false,
                groupWeight: 100, sticky: null, cooldown: null, delay: null,
                probability: 100, useProbability: true, depth: 4, selectiveLogic: 0,
                excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false,
                scanDepth: null, caseSensitive: null, matchWholeWords: null,
                useGroupScoring: null, automationId: '', role: null, vectorized: false,
                displayIndex: newUid,
            };
            await state.wiScript.saveWorldInfo(PROFILE_LOREBOOK_NAME, wi);
            return { success: true, uid: newUid };
        }
    } catch (err) { return { success: false, error: err.message }; }
}

/**
 * Load an NPC's profile content from the NPC Profiles lorebook.
 *
 * @param {number} uid — profile lorebook UID
 * @returns {Promise<string|null>}
 */
export async function loadProfileContent(uid) {
    if (!state.wiScript || uid == null) return null;
    try {
        const wi = await state.wiScript.loadWorldInfo(PROFILE_LOREBOOK_NAME);
        return wi?.entries?.[uid]?.content ?? null;
    } catch (err) { return null; }
}

/**
 * List every entry in the NPC Profiles lorebook.
 *
 * Read-only. Used by the duplicate audit: a lost `profileUid` pointer makes the
 * next save create a second entry for the same NPC instead of overwriting, so
 * the lorebook is the only place those orphans are visible.
 *
 * @returns {Promise<Array<{uid:number, name:string, chars:number, preview:string}>>}
 */
export async function listProfileEntries() {
    if (!state.wiScript) return [];
    try {
        const wi = await state.wiScript.loadWorldInfo(PROFILE_LOREBOOK_NAME);
        const entries = wi?.entries || {};
        return Object.keys(entries).map(k => {
            const e = entries[k];
            const content = String(e?.content || '');
            return {
                uid: Number(e?.uid ?? k),
                name: String(e?.comment || '').trim(),
                chars: content.length,
                preview: content.slice(0, 80).replace(/\s+/g, ' '),
            };
        }).sort((a, b) => a.name.localeCompare(b.name) || a.uid - b.uid);
    } catch (err) {
        console.warn('[MWT:Knowledge] Could not list profile entries:', err);
        return [];
    }
}

/**
 * Delete entries from the NPC Profiles lorebook by uid.
 *
 * Destructive and deliberately dumb: it deletes exactly the uids it is given
 * and decides nothing on its own. Callers are responsible for never passing a
 * uid the registry still points at.
 *
 * @param {number[]} uids — profile lorebook UIDs to delete
 * @returns {Promise<{success:boolean, deleted:number[], error?:string}>}
 */
export async function deleteProfileEntries(uids) {
    if (!state.wiScript) return { success: false, deleted: [], error: 'world-info.js not loaded' };
    if (!Array.isArray(uids) || uids.length === 0) return { success: true, deleted: [] };
    try {
        const wi = await state.wiScript.loadWorldInfo(PROFILE_LOREBOOK_NAME);
        if (!wi || !wi.entries) return { success: false, deleted: [], error: 'profile lorebook not found' };
        const deleted = [];
        for (const uid of uids) {
            if (wi.entries[uid] !== undefined) {
                delete wi.entries[uid];
                deleted.push(uid);
            }
        }
        if (deleted.length > 0) await state.wiScript.saveWorldInfo(PROFILE_LOREBOOK_NAME, wi);
        return { success: true, deleted };
    } catch (err) {
        return { success: false, deleted: [], error: err.message };
    }
}

// ─── Entry formatters ────────────────────────────────────────────────────────

export function formatMinorEntry(data) {
    return [`${data.name || 'Unknown'} | ${data.species || 'Unknown'} | ${data.descriptor || ''}`,
        `Tone: ${data.tone || 'unknown'}`, `Perceived as: ${data.perceived_as || 'unknown'}`,
        `First seen: ${data.first_seen || 'unknown'}`].join('\n');
}

export function formatMajorEntry(data) {
    const lines = [`${data.name || 'Unknown'} | ${data.species || 'Unknown'} | ${data.descriptor || ''}`,
        `Tone: ${data.tone || 'unknown'}`, `Perceived as: ${data.perceived_as || 'unknown'}`,
        `First seen: ${data.first_seen || 'unknown'}`, '', 'Knowledge Ledger:'];
    const knowledge = data.initial_knowledge || data.new_knowledge || [];
    if (knowledge.length > 0) knowledge.forEach(k => lines.push(`- ${k.fact} via ${k.source || 'unknown'}${k.date ? ' — ' + k.date : ''}`));
    else lines.push('- (no entries yet)');
    return lines.join('\n');
}

export function isHeaderLine(line) { return /\|/.test(line) && line.split('|').length >= 3 && !/^\s*-/.test(line); }
export function findHeaderLineIdx(lines) { return lines.findIndex(isHeaderLine); }

export function buildUpdatedMinorContent(existingContent, fields) {
    const lines = existingContent.split('\n');
    const headerIdx = findHeaderLineIdx(lines);
    return lines.map((line, idx) => {
        if (fields.tone != null && line.startsWith('Tone:')) return `Tone: ${fields.tone}`;
        if (fields.perceived_as != null && line.startsWith('Perceived as:')) return `Perceived as: ${fields.perceived_as}`;
        if (fields.descriptor != null && idx === headerIdx && headerIdx !== -1) { const parts = line.split('|').map(p => p.trim()); parts[2] = fields.descriptor; return parts.join(' | '); }
        return line;
    }).join('\n');
}

export function buildUpdatedMajorContent(existingContent, fields, newKnowledge) {
    let lines = existingContent.split('\n');
    const headerIdx = findHeaderLineIdx(lines);
    lines = lines.map((line, idx) => {
        if (fields?.tone != null && line.startsWith('Tone:')) return `Tone: ${fields.tone}`;
        if (fields?.perceived_as != null && line.startsWith('Perceived as:')) return `Perceived as: ${fields.perceived_as}`;
        if (fields?.descriptor != null && idx === headerIdx && headerIdx !== -1) { const parts = line.split('|').map(p => p.trim()); parts[2] = fields.descriptor; return parts.join(' | '); }
        return line;
    });
    if (newKnowledge?.length > 0) newKnowledge.forEach(k => lines.push(`- ${k.fact} via ${k.source || 'unknown'}${k.date ? ' — ' + k.date : ''}`));
    return lines.join('\n');
}

export function synthesizeMinorFromUpdate(name, fields) {
    return [`${name} | unknown | ${fields?.descriptor || 'unknown'}`, `Tone: ${fields?.tone || 'unknown'}`,
        `Perceived as: ${fields?.perceived_as || 'unknown'}`, `First seen: unknown`].join('\n');
}

export function synthesizeMajorFromUpdate(name, fields, newKnowledge) {
    const lines = [`${name} | unknown | ${fields?.descriptor || 'unknown'}`, `Tone: ${fields?.tone || 'unknown'}`,
        `Perceived as: ${fields?.perceived_as || 'unknown'}`, `First seen: unknown`, '', 'Knowledge Ledger:'];
    if (newKnowledge?.length > 0) newKnowledge.forEach(k => lines.push(`- ${k.fact} via ${k.source || 'unknown'}${k.date ? ' — ' + k.date : ''}`));
    else lines.push('- (no entries yet)');
    return lines.join('\n');
}

export async function enrichStagingItem(item) {
    if (!item || item.action !== 'update' || item.existingContent !== null || item.uid == null) return;
    const existing = await loadEntryContent(item.uid);
    if (existing !== null) {
        item.existingContent = existing;
        if (item.type === 'minor') {
            item.mergedContent = buildUpdatedMinorContent(existing, item.fields || {});
        } else if (item.type === 'major') {
            // Use the dossier merger if the existing entry is a dossier OR the
            // scan produced dossier fields (item.dossierMode / result.dossierMode).
            const useDossier = isDossierEntry(existing) || item.dossierMode === true || item.fromDossierScan === true;
            item.mergedContent = useDossier
                ? buildUpdatedDossierContent(existing, item.fields || {}, item.newKnowledge || [])
                : buildUpdatedMajorContent(existing, item.fields || {}, item.newKnowledge || []);
        } else {
            item.mergedContent = existing;
        }
        item.proposedContent = item.mergedContent || item.proposedContent;
    }
}

export function buildPromotedContent(currentContent) {
    const lines = currentContent.split('\n');
    if (lines.some(l => l.trim().toLowerCase().startsWith('knowledge ledger:'))) return currentContent;
    const insertIdx = lines.findIndex(l => l.trim().toLowerCase().startsWith('first seen:'));
    if (insertIdx !== -1 && insertIdx + 1 < lines.length && lines[insertIdx + 1].trim() === '') lines.splice(insertIdx + 2, 0, '', 'Knowledge Ledger:', '- (no entries yet)');
    else lines.push('', 'Knowledge Ledger:', '- (no entries yet)');
    return lines.join('\n');
}

export function buildDemotedContent(currentContent) {
    const lines = currentContent.split('\n');
    const filtered = [];
    let skipSection = false;
    for (const line of lines) {
        if (line.trim().toLowerCase().startsWith('knowledge ledger:')) { skipSection = true; continue; }
        if (skipSection && line.startsWith('- ')) continue;
        if (line.trim() !== '' && !line.startsWith('- ')) skipSection = false;
        filtered.push(line);
    }
    while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') filtered.pop();
    return filtered.join('\n');
}

// ─── Dossier formatters (Dossier Mode) ───────────────────────────────────────
// Rich-field entry formatters used when Knowledge Tracker Dossier Mode is ON.

/** Ordered list of dossier fields for consistent formatting. */
export const DOSSIER_FIELDS = [
    { key: 'role',         label: 'Role' },
    { key: 'where_to_find', label: 'Where to Find' },
    { key: 'appearance',   label: 'Appearance' },
    { key: 'voice',        label: 'Voice' },
    { key: 'background',   label: 'Background' },
    { key: 'personality',  label: 'Personality' },
    { key: 'read_on_pc',   label: 'Read on PC' },
    { key: 'agenda',       label: 'Current Agenda' },
    { key: 'secrets',      label: 'Secrets' },
    { key: 'canon_lock',   label: 'Canon Lock' },
    { key: 'image_tags',   label: 'Image Tags' },
];

/** Marker prepended to dossier-format entries so we can detect the format. */
export const DOSSIER_MARKER = '[Dossier]';

/**
 * Coerce a dossier field value to a readable string. Some models return
 * structured values (e.g. secrets as {tier1: "...", tier2: "..."} or canon_lock
 * as an array of facts) instead of plain strings. Without this, template
 * interpolation produces "[object Object]".
 */
export function stringifyDossierValue(val) {
    if (val == null) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) {
        // Arrays of strings → join with semicolons; arrays of objects →
        // stringify each element recursively and join.
        return val.map(v => stringifyDossierValue(v)).filter(Boolean).join('; ');
    }
    if (typeof val === 'object') {
        // Objects with tier keys → "Tier 1: ... | Tier 2: ... | Tier 3: ..."
        // General objects → "key: value; key: value"
        const entries = Object.entries(val)
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => `${k}: ${stringifyDossierValue(v)}`);
        return entries.join(' | ');
    }
    return String(val);
}

export function formatDossierEntry(data) {
    const lines = [
        `${DOSSIER_MARKER} ${data.name || 'Unknown'} | ${data.species || 'Unknown'} | ${data.descriptor || ''}`,
        `Tone: ${data.tone || 'unknown'}`,
        `Perceived as: ${data.perceived_as || 'unknown'}`,
        `First seen: ${data.first_seen || 'unknown'}`,
    ];
    for (const f of DOSSIER_FIELDS) {
        const val = stringifyDossierValue(data[f.key]);
        if (val) lines.push(`${f.label}: ${val}`);
    }
    lines.push('', 'Knowledge Ledger:');
    const knowledge = data.initial_knowledge || data.new_knowledge || [];
    if (knowledge.length > 0) knowledge.forEach(k => lines.push(`- ${k.fact} via ${k.source || 'unknown'}${k.date ? ' — ' + k.date : ''}`));
    else lines.push('- (no entries yet)');
    return lines.join('\n');
}

/** Is this lorebook content in dossier format? */
export function isDossierEntry(content) {
    return typeof content === 'string' && content.startsWith(DOSSIER_MARKER);
}

/**
 * Count how many dossier fields are present (non-empty) in an entry.
 * Used by the UI to show whether an entry needs enrichment.
 */
export function countDossierFields(content) {
    if (!content) return 0;
    let count = 0;
    for (const f of DOSSIER_FIELDS) {
        const re = new RegExp(`^${f.label}:\\s*(.+)$`, 'im');
        const m = content.match(re);
        if (m && m[1].trim() && m[1].trim().toLowerCase() !== 'unknown') count++;
    }
    return count;
}

/**
 * Apply a partial dossier update (from DOSSIER_UPDATE_PROMPT result) to existing
 * content. Only non-null fields are replaced; unknown fields are ignored.
 */
export function buildUpdatedDossierContent(existingContent, fields, newKnowledge) {
    let lines = existingContent.split('\n');
    const headerIdx = findHeaderLineIdx(lines);

    lines = lines.map((line, idx) => {
        if (fields?.tone != null && line.startsWith('Tone:')) return `Tone: ${fields.tone}`;
        if (fields?.perceived_as != null && line.startsWith('Perceived as:')) return `Perceived as: ${fields.perceived_as}`;
        if (fields?.descriptor != null && idx === headerIdx && headerIdx !== -1) {
            const parts = line.split('|').map(p => p.trim());
            // Preserve the dossier marker if present
            const markerMatch = parts[0].match(/^\[Dossier\]\s*(.*)$/);
            parts[0] = markerMatch ? `${DOSSIER_MARKER} ${markerMatch[1]}` : parts[0];
            parts[2] = fields.descriptor;
            return parts.join(' | ');
        }
        // Dossier fields — match by label prefix
        for (const f of DOSSIER_FIELDS) {
            if (fields?.[f.key] != null && line.startsWith(`${f.label}:`)) {
                return `${f.label}: ${stringifyDossierValue(fields[f.key])}`;
            }
        }
        return line;
    });

    // Ensure the header carries the [Dossier] marker so future updates keep
    // using the dossier format — an entry first created in the compact format
    // and later updated under Dossier Mode would otherwise lose its identity.
    if (headerIdx !== -1 && !lines[headerIdx].startsWith(DOSSIER_MARKER)) {
        lines[headerIdx] = `${DOSSIER_MARKER} ${lines[headerIdx]}`;
    }

    // Append any new dossier fields that don't yet exist in the entry
    // (insert them before the Knowledge Ledger section). Increment the splice
    // index after each insert so the fields land in canonical DOSSIER_FIELDS
    // order rather than reverse.
    const ledgerIdx = lines.findIndex(l => l.trim().toLowerCase().startsWith('knowledge ledger:'));
    let insertIdx = ledgerIdx !== -1 ? ledgerIdx : lines.length;
    for (const f of DOSSIER_FIELDS) {
        const rawVal = fields?.[f.key];
        if (rawVal == null) continue;
        const val = stringifyDossierValue(rawVal);
        if (!val) continue;
        const prefix = `${f.label}:`;
        const exists = lines.some(l => l.startsWith(prefix));
        if (!exists) { lines.splice(insertIdx, 0, `${f.label}: ${val}`); insertIdx++; }
    }

    if (newKnowledge?.length > 0) {
        // Ensure there's a Knowledge Ledger section, then append.
        const ledgerLineIdx = lines.findIndex(l => l.trim().toLowerCase().startsWith('knowledge ledger:'));
        if (ledgerLineIdx === -1) {
            lines.push('', 'Knowledge Ledger:');
            newKnowledge.forEach(k => lines.push(`- ${k.fact} via ${k.source || 'unknown'}${k.date ? ' — ' + k.date : ''}`));
        } else {
            newKnowledge.forEach(k => lines.push(`- ${k.fact} via ${k.source || 'unknown'}${k.date ? ' — ' + k.date : ''}`));
        }
    }
    return lines.join('\n');
}

/**
 * Extract identity fields (Tone, Perceived as, Voice, Personality) from a
 * dossier entry, returning them separately from the remainder of the content.
 *
 * Used by the Interiority thoughts call (v2 §17) to build a `<character_core>`
 * block for non-profiled NPCs — lifting personality/voice/tone out of the
 * dossier without duplicating format parsing. One owner of the dossier format
 * (this module), riding the already-sanctioned interiority→knowledge import.
 *
 * The fields and remainder PARTITION the entry: extracted fields do NOT appear
 * in `remainder`, so `<character_core>` and `<knowledge_entry>` carry different
 * content rather than overlapping.
 *
 * @param {string} content — lorebook entry content (dossier or compact format)
 * @returns {{fields: Object<string,string>, remainder: string}}
 *   `fields` is a label→value map (e.g. `{ Tone: '...', Voice: '...' }`);
 *   `remainder` is the entry text with identity-field lines removed.
 */
export function extractIdentityFields(content) {
    if (!content || typeof content !== 'string') return { fields: {}, remainder: '' };
    const identityLabels = ['Tone', 'Perceived as', 'Voice', 'Personality'];
    const lines = content.split('\n');
    const fields = {};
    const remainderLines = [];

    for (const line of lines) {
        let matched = false;
        for (const label of identityLabels) {
            if (line.startsWith(`${label}:`)) {
                const val = line.slice(label.length + 1).trim();
                if (val && val.toLowerCase() !== 'unknown') fields[label] = val;
                matched = true;
                break;
            }
        }
        if (!matched) remainderLines.push(line);
    }

    // Collapse multiple blank lines left by extraction
    const remainder = remainderLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { fields, remainder };
}

export function synthesizeDossierFromUpdate(name, fields, newKnowledge) {
    const data = {
        name,
        species: 'Unknown',
        tone: fields?.tone || 'unknown',
        perceived_as: fields?.perceived_as || 'unknown',
        descriptor: fields?.descriptor || 'unknown',
        first_seen: 'unknown',
        initial_knowledge: newKnowledge || [],
    };
    for (const f of DOSSIER_FIELDS) {
        if (fields?.[f.key] != null) data[f.key] = fields[f.key];
    }
    return formatDossierEntry(data);
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateStateOutput(originalEntry, output) {
    if (!output || !output.trim()) return { ok: false, reason: 'empty output' };
    const leakPatterns = [
        { re: /<recent_messages>/i, label: '<recent_messages> tag' }, { re: /<current_entry>/i, label: '<current_entry> tag' },
        { re: /<entity>/i, label: '<entity> tag' }, { re: /^#+\s*Recent\s+Messages/im, label: '"### Recent Messages" heading' },
        { re: /^#+\s*Current\s+Entry/im, label: '"### Current Entry" heading' },
    ];
    for (const { re, label } of leakPatterns) { if (re.test(output)) return { ok: false, reason: `output contains ${label}` }; }
    const lineHeaderRe = /^([^\s:#][^:]*?):/gm;
    const origHeaders = new Set([...originalEntry.matchAll(lineHeaderRe)].map(m => m[1].trim().toLowerCase()));
    const speakerLineRe = /^([A-Z][\w .'-]{0,30}):\s+\S.{40,}$/gm;
    const isUnknownPrefix = (m) => !origHeaders.has(m[1].trim().toLowerCase());
    const outputLines = output.split('\n');
    let maxRun = 0, currentRun = 0;
    for (const line of outputLines) {
        speakerLineRe.lastIndex = 0;
        const m = speakerLineRe.exec(line);
        if (m && isUnknownPrefix(m)) { currentRun++; if (currentRun > maxRun) maxRun = currentRun; } else currentRun = 0;
    }
    if (maxRun >= 3) return { ok: false, reason: 'output appears to contain a chat transcript' };
    const fieldRe = /^([A-Z][A-Z0-9_]+):/gm;
    const origFields = new Set([...originalEntry.matchAll(fieldRe)].map(m => m[1]));
    const newFields = new Set([...output.matchAll(fieldRe)].map(m => m[1]));
    if (origFields.size > 0) {
        const added = [...newFields].filter(f => !origFields.has(f));
        const dropped = [...origFields].filter(f => !newFields.has(f));
        if (added.length > 0) return { ok: false, reason: `added unauthorized fields: ${added.join(', ')}` };
        if (dropped.length > 0) return { ok: false, reason: `dropped required fields: ${dropped.join(', ')}` };
    }
    if (output.length > originalEntry.length * 4 + 2000) return { ok: false, reason: 'output too long' };
    return { ok: true };
}

// ─── Scan ────────────────────────────────────────────────────────────────────

export async function runScan() {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    const settings = getSettings();
    const dossierMode = settings.dossierMode === true;
    const registry = getRegistry();
    const knownNames = Object.keys(registry).filter(name => registry[name].uid !== null && registry[name].uid !== undefined);
    const recentMessages = getRecentMessages();
    const worldState = getCurrentWorldState();
    const chronicle = getLatestChronicleEntry();
    if (!recentMessages) throw new Error('No recent messages to scan.');

    // Build the "Already Tracked NPCs" section. In Dossier Mode, include the
    // existing entry content (truncated) so the model can see which dossier
    // fields are missing and fill them in rather than returning all-null.
    let knownSection;
    if (knownNames.length > 0) {
        const lines = [];
        for (const name of knownNames) {
            const info = registry[name];
            lines.push(`- ${name} [${info.type}]`);
            // In dossier mode, include existing content for major NPCs so the
            // scan can detect and fill missing dossier fields.
            if (dossierMode && info.type === 'major' && info.uid != null) {
                try {
                    const existing = await loadEntryContent(info.uid);
                    if (existing) {
                        // Truncate to keep the prompt manageable (we only need
                        // enough for the model to see which fields exist).
                        const trimmed = existing.length > 800
                            ? existing.slice(0, 800) + '\n…(truncated)'
                            : existing;
                        lines.push(`<existing_entry>\n${trimmed}\n</existing_entry>`);
                    }
                } catch { /* ignore load errors */ }
            }
        }
        knownSection = `<already_tracked_npcs>\n${lines.join('\n')}\n</already_tracked_npcs>`;
    } else {
        knownSection = '<already_tracked_npcs>\nNone yet.\n</already_tracked_npcs>';
    }

    const playerNames = getPlayerNames({ lower: false, includeFirstChat: true });
    const playerSection = playerNames.size > 0 ? `<player_names_exclude>\n${[...playerNames].map(n => `- ${n}`).join('\n')}\n</player_names_exclude>` : '';
    const userContent = [knownSection, '', playerSection, '', worldState ? `<world_state>\n${worldState}\n</world_state>` : '', '', chronicle ? `<chronicle>\n${chronicle}\n</chronicle>` : '', '', '<recent_messages>', recentMessages, '</recent_messages>', '', '='.repeat(60), 'Scan for NPCs. Output only JSON.'].filter(s => s !== null && s !== '').join('\n');
    const systemPrompt = dossierMode ? DOSSIER_SCAN_SYSTEM_PROMPT : SCAN_SYSTEM_PROMPT;

    // Attempt the scan up to two times. If the first response fails to parse
    // (typically because it was truncated by max_tokens), retry once — the
    // model often succeeds on a second pass, and parseJsonLenient will salvage
    // many truncated responses anyway.
    let lastErr = null;
    let lastPreview = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        const raw = await ktFetchFromApi(systemPrompt, userContent);
        const cleaned = normaliseOutput(raw);
        try {
            const result = parseJsonLenient(cleaned);
            const playerSet = new Set([...playerNames].map(n => n.toLowerCase()));
            const notPlayer = (entry) => entry && entry.name && !playerSet.has(String(entry.name).toLowerCase());
            return {
                dossierMode,
                new_minor: Array.isArray(result.new_minor) ? result.new_minor.filter(notPlayer) : [],
                new_major: Array.isArray(result.new_major) ? result.new_major.filter(notPlayer) : [],
                update_minor: Array.isArray(result.update_minor) ? result.update_minor.filter(notPlayer) : [],
                update_major: Array.isArray(result.update_major) ? result.update_major.filter(notPlayer) : [],
            };
        } catch (err) {
            lastErr = err;
            lastPreview = cleaned.slice(0, 120);
            console.warn(`[MWT:Knowledge] Scan JSON parse failed (attempt ${attempt}): ${err.message}. Preview: "${lastPreview}"`);
            if (attempt < 2) continue;
        }
    }
    throw new Error(`Model did not return valid JSON after 2 attempts. Last error: ${lastErr?.message || 'unknown'}. Preview: "${lastPreview}"`);
}

// ─── State update ────────────────────────────────────────────────────────────

export async function runStateUpdate(name, uid) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    const loaded = await loadStateTrackerEntry(uid);
    if (!loaded) throw new Error(`Could not load state entry for "${name}".`);
    if (!loaded.comment.startsWith(TRACKER_SENTINEL)) throw new Error(`UID ${uid} missing sentinel.`);
    const recentMessages = getRecentMessages();
    if (!recentMessages) throw new Error('No recent messages.');
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const userContent = attempt === 1
            ? [`<entity>${name}</entity>`, '', '<current_entry>', loaded.content, '</current_entry>', '', '<recent_messages>', recentMessages, '</recent_messages>', '', 'Output the updated entry.'].join('\n')
            : [`<entity>${name}</entity>`, '', '<current_entry>', loaded.content, '</current_entry>', '', '<recent_messages>', recentMessages, '</recent_messages>', '', `<previous_attempt_rejected>Reason: ${lastError}</previous_attempt_rejected>`, '', 'Try again. Output ONLY the updated entry.'].join('\n');
        const raw = await ktFetchFromApi(STATE_UPDATE_PROMPT, userContent);
        let cleaned = normaliseOutput(raw);
        const validation = validateStateOutput(loaded.content, cleaned);
        if (validation.ok) return { currentContent: loaded.content, merged: cleaned, unchanged: cleaned.trim() === loaded.content.trim(), attempts: attempt };
        lastError = validation.reason;
    }
    throw new Error(`Output validation failed: ${lastError}`);
}

export async function runNpcUpdate(name, uid) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    const rawContent = await loadEntryContent(uid);
    if (!rawContent) throw new Error(`Could not load entry for "${name}".`);
    const currentContent = stripRelationshipBlock(rawContent);
    const recentMessages = getRecentMessages();
    const worldState = getCurrentWorldState();
    if (!recentMessages) throw new Error('No recent messages.');
    const userContent = [`<entity>${name}</entity>`, `<current_entry>\n${currentContent}\n</current_entry>`, '', worldState ? `<world_state>\n${worldState}\n</world_state>` : '', '', '<recent_messages>', recentMessages, '</recent_messages>', '', '='.repeat(60), `Identify new info about ${name}. Output only JSON.`].filter(Boolean).join('\n');
    // Use the dossier update prompt when the existing entry is a dossier, or
    // when dossier mode is enabled in settings (so new fields get captured).
    const settings = getSettings();
    const useDossier = isDossierEntry(currentContent) || settings.dossierMode === true;
    const systemPrompt = useDossier ? DOSSIER_UPDATE_PROMPT : NPC_UPDATE_PROMPT;
    const raw = await ktFetchFromApi(systemPrompt, userContent);
    const cleaned = normaliseOutput(raw);
    const result = parseJsonLenient(cleaned);

    // Slice 2 guardrail: if this NPC has an evidence file (growth profile
    // exists), the personality field is OWNED by the growth profile system,
    // not DOSSIER_UPDATE_PROMPT. Null it out here so the two systems never
    // touch the same field — the hard structural partition from
    // NPC_GROWTH_BLUEPRINT.md §"The split-brain resolution". This prevents
    // DOSSIER_UPDATE_PROMPT from re-deriving personality from its own prior
    // prose (the telephone loop) for profiled NPCs.
    if (useDossier && result.fields && hasEvidenceFile(name)) {
        result.fields.personality = null;
    }

    const merged = useDossier
        ? buildUpdatedDossierContent(currentContent, result.fields || {}, result.new_knowledge || [])
        : buildUpdatedMajorContent(currentContent, result.fields || {}, result.new_knowledge || []);
    return { currentContent, merged, fields: result.fields || {}, newKnowledge: result.new_knowledge || [], dossierMode: useDossier };
}

// ─── Dossier enrichment ──────────────────────────────────────────────────────

/**
 * Enrich a single NPC's entry to a complete dossier. Loads the existing entry,
 * sends it with full chat history to DOSSIER_ENRICH_PROMPT, and produces a
 * staging item with the fully-filled dossier content.
 *
 * Unlike runNpcUpdate (which only captures *changes*), this function asks the
 * model to fill in ALL missing dossier fields, making it the primary way to
 * upgrade a compact-format entry to a full dossier or to complete a partial one.
 *
 * @param {string} name - NPC name
 * @param {number} uid - Lorebook UID
 * @returns {Promise<{currentContent: string, merged: string, fields: object, newKnowledge: array, dossierMode: boolean}>}
 */
export async function runNpcEnrich(name, uid) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    const rawContent = await loadEntryContent(uid);
    if (!rawContent) throw new Error(`Could not load entry for "${name}".`);
    const currentContent = stripRelationshipBlock(rawContent);
    const recentMessages = getRecentMessages(50);
    const worldState = getCurrentWorldState();
    const chronicle = getLatestChronicleEntry();
    if (!recentMessages) throw new Error('No recent messages.');

    const userContent = [
        `<entity>${name}</entity>`,
        `<current_entry>\n${currentContent}\n</current_entry>`,
        '',
        worldState ? `<world_state>\n${worldState}\n</world_state>` : '',
        chronicle ? `<chronicle>\n${chronicle}\n</chronicle>` : '',
        '',
        '<recent_messages>',
        recentMessages,
        '</recent_messages>',
        '',
        '='.repeat(60),
        `Write a COMPLETE dossier for ${name}. Fill every field. Output only JSON.`,
    ].filter(Boolean).join('\n');

    const raw = await ktFetchFromApi(DOSSIER_ENRICH_PROMPT, userContent);
    const cleaned = normaliseOutput(raw);
    const result = parseJsonLenient(cleaned);

    // Build the complete dossier content from the enrich result. We use the
    // dossier merger which will replace existing fields and add missing ones.
    const merged = buildUpdatedDossierContent(currentContent, result.fields || {}, result.new_knowledge || []);
    return {
        currentContent,
        merged,
        fields: result.fields || {},
        newKnowledge: result.new_knowledge || [],
        dossierMode: true,
    };
}

/**
 * Serialise asynchronous tracker work onto a single promise chain.
 *
 * Returns a promise that resolves specifically to `fn`'s own result (or
 * `undefined` if `fn` throws).  We capture this fn-local promise in a local
 * variable rather than returning `state.trackerQueue` directly: the queue
 * field is reassigned by every subsequent call, so returning it would make an
 * `await` of *this* call resolve to the result of a *later* queued item.
 *
 * Errors are logged and swallowed so a single failure can't permanently break
 * the serialisation chain.
 *
 * @param {() => (Promise<*>|*)} fn
 * @returns {Promise<*>} resolves to fn's return value, or undefined on error
 */
export function queueTrackerWork(fn) {
    const result = state.trackerQueue
        .catch(() => {})              // a prior failure must not block fn
        .then(() => fn())
        .catch(err => console.error('[MWT:Knowledge] Queued work failed:', err));
    state.trackerQueue = result;
    return result;
}