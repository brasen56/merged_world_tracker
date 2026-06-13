/**
 * knowledge/lorebook.js — Lorebook read/write, entry formatters, validation,
 * scan logic, and state/NPC update workflows.
 *
 * The world-info script is loaded as a side-effect (top-level await) so that
 * wiScript is available for all lorebook operations.
 */

import {
    getChat, getChatMeta, getPlayerNames,
    resolveApiCall, normaliseOutput,
    getCurrentWorldState, getLatestChronicleEntry,
    escapeRegex,
} from '../core/index.js';

import { SCAN_SYSTEM_PROMPT, STATE_UPDATE_PROMPT, NPC_UPDATE_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings } from './settings.js';
import {
    LOREBOOK_NAME, STATE_LOREBOOK_NAME, TRACKER_SENTINEL,
    HISTORY_KEY_PREFIX, RELATIONSHIP_BLOCK_START, RELATIONSHIP_BLOCK_END,
    state,
} from './state.js';
import { getRegistry } from './registry.js';
import { stripRelationshipBlock } from './relationships.js';

// ─── World-info import (side-effect) ────────────────────────────────────────

try {
    state.wiScript = await import('../../../../world-info.js');
    console.log('[MWT:Knowledge] world-info.js loaded.');
} catch (err) {
    console.warn('[MWT:Knowledge] Could not import world-info.js:', err?.message || err);
}

// ─── History ─────────────────────────────────────────────────────────────────

export function pushHistory(uid, content) {
    if (uid === null || uid === undefined) return;
    const key = HISTORY_KEY_PREFIX + uid;
    let history = [];
    try { history = JSON.parse(localStorage.getItem(key) || '[]'); } catch { history = []; }
    history.unshift({ ts: Date.now(), content, msgIdx: getChat()?.length || 0 });
    if (history.length > 50) history.length = 50;
    try { localStorage.setItem(key, JSON.stringify(history)); } catch { /* quota */ }
}

export function getHistory(uid) {
    if (uid === null || uid === undefined) return [];
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY_PREFIX + uid) || '[]'); } catch { return []; }
}

// ─── Message helpers ─────────────────────────────────────────────────────────

export function getRecentMessages(count = 30) {
    const chat = getChat();
    if (!chat || !chat.length) return null;
    const slice = chat.slice(-count);
    const filtered = slice.filter(m => m.mes && !m.is_system);
    if (!filtered.length) return null;
    return filtered.map(m => `${m.is_user ? (m.name || 'User') : (m.name || 'Assistant')}: ${m.mes}`).join('\n');
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
        pushHistory(uid, previousContent);
        return { success: true, uid };
    } catch (err) { return { success: false, error: err.message }; }
}

export async function writeToLorebook(name, content, keywords, existingUid) {
    if (!state.wiScript) return { success: false, content, keywords, error: 'world-info.js not loaded' };
    try {
        let wi = await state.wiScript.loadWorldInfo(LOREBOOK_NAME);
        // Auto-create the lorebook if it doesn't exist yet
        if (!wi || !wi.entries) {
            if (typeof state.wiScript.createNewWorldInfo === 'function') {
                wi = await state.wiScript.createNewWorldInfo(LOREBOOK_NAME);
            } else {
                wi = { name: LOREBOOK_NAME, entries: {} };
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
        if (item.type === 'minor') item.mergedContent = buildUpdatedMinorContent(existing, item.fields || {});
        else if (item.type === 'major') item.mergedContent = buildUpdatedMajorContent(existing, item.fields || {}, item.newKnowledge || []);
        else item.mergedContent = existing;
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
    const registry = getRegistry();
    const knownNames = Object.keys(registry).filter(name => registry[name].uid !== null && registry[name].uid !== undefined);
    const recentMessages = getRecentMessages();
    const worldState = getCurrentWorldState();
    const chronicle = getLatestChronicleEntry();
    if (!recentMessages) throw new Error('No recent messages to scan.');
    const knownSection = knownNames.length > 0 ? `### Already Tracked NPCs\n${knownNames.map(n => `- ${n} [${registry[n].type}]`).join('\n')}` : '### Already Tracked NPCs\nNone yet.';
    const playerNames = getPlayerNames({ lower: false, includeFirstChat: true });
    const playerSection = playerNames.size > 0 ? `### Player Names (EXCLUDE)\n${[...playerNames].map(n => `- ${n}`).join('\n')}` : '';
    const userContent = [knownSection, '', playerSection, '', worldState ? `### World State\n${worldState}` : '', '', chronicle ? `### Chronicle\n${chronicle}` : '', '', '### Recent Messages', recentMessages, '', '='.repeat(60), 'Scan for NPCs. Output only JSON.'].filter(s => s !== null && s !== '').join('\n');
    const raw = await ktFetchFromApi(SCAN_SYSTEM_PROMPT, userContent);
    let cleaned = normaliseOutput(raw);
    try {
        const result = JSON.parse(cleaned);
        const playerSet = new Set([...playerNames].map(n => n.toLowerCase()));
        const notPlayer = (entry) => entry && entry.name && !playerSet.has(String(entry.name).toLowerCase());
        return {
            new_minor: Array.isArray(result.new_minor) ? result.new_minor.filter(notPlayer) : [],
            new_major: Array.isArray(result.new_major) ? result.new_major.filter(notPlayer) : [],
            update_minor: Array.isArray(result.update_minor) ? result.update_minor.filter(notPlayer) : [],
            update_major: Array.isArray(result.update_major) ? result.update_major.filter(notPlayer) : [],
        };
    } catch (err) { throw new Error(`Model did not return valid JSON. Preview: "${cleaned.slice(0, 120)}"`); }
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
    const userContent = [`### NPC: ${name}`, `### Current Entry\n${currentContent}`, '', worldState ? `### World State\n${worldState}` : '', '', '### Recent Messages', recentMessages, '', '='.repeat(60), `Identify new info about ${name}. Output only JSON.`].filter(Boolean).join('\n');
    const raw = await ktFetchFromApi(NPC_UPDATE_PROMPT, userContent);
    let cleaned = normaliseOutput(raw);
    let result;
    try { result = JSON.parse(cleaned); } catch { throw new Error(`Model did not return valid JSON. Preview: "${cleaned.slice(0, 120)}"`); }
    const merged = buildUpdatedMajorContent(currentContent, result.fields || {}, result.new_knowledge || []);
    return { currentContent, merged, fields: result.fields || {}, newKnowledge: result.new_knowledge || [] };
}

export function queueTrackerWork(fn) { state.trackerQueue = state.trackerQueue.then(fn).catch(err => console.error('[MWT:Knowledge] Queued work failed:', err)); return state.trackerQueue; }