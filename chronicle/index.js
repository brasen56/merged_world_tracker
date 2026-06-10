/**
 * chronicle/index.js — Session Chronicle module
 *
 * Migrated from session_chronicle/index.js (2,857 lines).
 * Uses shared core for: context, api, diff, settings, modal.
 *
 * Public API: { init, render, onMessageReceived, onChatChanged,
 *               onGenerationStarted, onGenerationStopped }
 */

import {
    getContextSafe, getChat, getChatMeta, getSetExtensionPrompt,
    resolveApiCall, normaliseOutput,
    escapeHtml, buildInlineDiff, estimateTokens,
    createSettingsManager,
    createModal, showModal, hideModal, setStatus,
} from '../core/index.js';

import { applyWorldStateInjection } from '../world_state/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'mwt_chronicle';
const CHRONICLE_KEY = 'session_chronicle_data';
const EXTENSION_PROMPT_KEY = 'session_chronicle_injection';
const WS_METADATA_KEY = 'world_state_tracker_metadata';
const SC_VERSION = '0.7.4-mwt';
const AUTO_SUGGEST_AFTER = 40;
const MAX_TRASH_SIZE = 50;
const MAX_ENTRY_WORD_COUNT = 2000;
const MAX_CHARACTERS = 20;

// ─── Prompts ─────────────────────────────────────────────────────────────────

const CONSOLIDATE_SYSTEM_PROMPT = `You are a continuity recorder for an ongoing roleplay. Your job is to merge multiple chronicle entries into a single consolidated entry.

ABSOLUTE RULES:
- Output ONLY the consolidated chronicle entry in the exact format below.
- Do NOT write narration, dialogue, or roleplay continuation.
- Do NOT include preamble, commentary, or code fences.
- Your output MUST begin with the exact text "## Summary" — nothing before it.
- Write in past tense. These are things that already happened.
- Be factual and concrete. No emotional language or dramatic phrasing.

You will receive a BASE entry (the earliest selected snapshot) and one or more DELTA entries (subsequent snapshots showing changes since the base).

Consolidation rules:
- The base entry establishes the starting state. Treat it as the foundation.
- Delta entries show what changed. Each delta only needs to be read for changes.
- If a fact changed multiple times across deltas, only the FINAL state matters.
- If an open loop was created and then closed within the selected entries, omit it entirely.
- Relationship shifts should reflect the NET change from base to final delta, not intermediate steps.
- Do not pad with detail from the base that the deltas did not touch.
- The Time Anchor should reflect the END of the LAST delta entry, not the base.
- The result should be approximately the same length as the base entry or shorter.

---

## Summary
- [3–6 bullet points of durable outcomes that are still true after all deltas are applied]
- Omit anything resolved or superseded within the selected range.

## Relationship & Institutional Shifts
- [NPC or Institution]: [net change across the full selected range]
- Only include the final state of any relationship that changed.
- Omit this section if nothing meaningful shifted across the full range.

## Open Loops Created
- [obligations or questions that were OPENED and are still UNRESOLVED at the end of the range]
- Omit loops that opened and closed within the range.
- Omit this section if none remain open.

## Open Loops Closed
- [obligations or questions resolved across the full range]
- Omit this section if none were closed.

## Time Anchor
In-world date and time at end of this period: [from the LAST delta entry]
Location at end of this period: [from the LAST delta entry]

---

Rules:
- Each bullet should be a single concrete sentence.
- Prefer the final state over the journey.
- Keep the total entry under 600 words.
- Omit any section that has no entries rather than leaving it empty.`;

const CHRONICLE_INJECTION_HEADER = `[Session Chronicle — recent history reference.
This is a record of what has already happened, in the order it occurred.
Use it to maintain continuity with past events, completed obligations, and established outcomes.
Do not re-introduce resolved events as if they are still pending.]`;

const CHRONICLE_SYSTEM_PROMPT = `You are a continuity recorder for an ongoing roleplay. Your job is to write a compact chronicle entry capturing what happened in the provided messages.

ABSOLUTE RULES:
- Output ONLY the chronicle entry in the exact format below.
- Do NOT write narration, dialogue, or roleplay continuation.
- Do NOT include preamble, commentary, or code fences.
- Your output MUST begin with the exact text "## Summary" — nothing before it.
- Write in past tense. These are things that already happened.
- Be factual and concrete. No emotional language or dramatic phrasing.

---

## Summary
- [3–6 bullet points of durable outcomes — decisions made, facts established, obligations created or closed]
- Focus on things that will still matter in future scenes.
- Omit moment-to-moment action unless it produced a lasting consequence.

## Relationship & Institutional Shifts
- [NPC or Institution]: [what changed and why — trust gained/lost, stance shift, new dynamic]
- Only include genuine changes, not neutral interactions.
- Omit this section if nothing meaningful shifted.

## Open Loops Created
- [obligation, unanswered question, pending decision, or unresolved offer created during this period]
- Omit this section if none were created.

## Open Loops Closed
- [obligation, question, or thread that was resolved or abandoned during this period]
- Omit this section if none were closed.

## Time Anchor
In-world date and time at end of this period: [date and time]
Location at end of this period: [location]

---

Rules:
- Each bullet should be a single concrete sentence.
- Prefer outcomes over events. "Alex agreed to meet Mikhail Thursday" not "Alex and Mikhail had a conversation."
- Keep the total entry under 600 words.
- Omit any section that has no entries rather than leaving it empty.`;

// ─── Settings ────────────────────────────────────────────────────────────────

const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    legacyKey: 'session_chronicle_settings',
    defaults: {
        apiUrl: '',
        apiKey: '',
        modelName: '',
        maxTokens: 8000,
        temperature: 0.3,
        topP: 1.0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        customHeaders: '',
        filterSystem: true,
        filterOoc: true,
        autoSnapshot: false,
        autoSnapshotThreshold: 40,
        syncWorldState: true,
    },
    logPrefix: '[MWT:Chronicle]',
});

// ─── Internal state ──────────────────────────────────────────────────────────

let modal = null;
let contentEl = null;  // The tab content container
let isGenerating = false;
let isMainGenerating = false;
let selectedSnapshotId = null;
let consolidateMode = false;
let bulkDeleteMode = false;
const checkedForMerge = new Set();
let pendingSearch = '';
let _lastStatusMsg = '';
let _lastStatusLevel = '';

// ─── Content helper ──────────────────────────────────────────────────────────

function getContentEl() {
    if (contentEl) return contentEl;
    if (!modal) return null;
    contentEl = modal.querySelector('.mwt-tab-content[data-tab="chronicle"]');
    return contentEl;
}

function scSetStatus(msg, level = 'info') {
    _lastStatusMsg = msg;
    _lastStatusLevel = level;
    const el = getContentEl();
    if (!el) return;
    el.querySelectorAll('.sc-status').forEach(s => {
        s.textContent = msg;
        s.className = 'sc-status';
        if (level) s.classList.add(`sc-status--${level}`);
    });
}

// ─── Anchor helpers ──────────────────────────────────────────────────────────

function makeAnchor(msg) {
    if (!msg) return null;
    const mes = String(msg.mes || '');
    return { id: msg.id ?? null, name: msg.name || (msg.is_user ? 'User' : 'Assistant'), start: mes.slice(0, 80), end: mes.slice(-80), length: mes.length };
}

function resolveAnchor(anchor) {
    const chat = getChat();
    if (!anchor) return { index: 0, found: true };
    if (anchor.id !== null && anchor.id !== undefined) {
        const idx = chat.findIndex(m => m.id === anchor.id);
        if (idx !== -1) return { index: idx + 1, found: true };
    }
    if (anchor.start || anchor.end || anchor.length) {
        const idx = chat.findIndex(m => {
            const mes = String(m.mes || '');
            const name = m.name || (m.is_user ? 'User' : 'Assistant');
            return name === anchor.name && mes.length === anchor.length && (!anchor.start || mes.slice(0, 80) === anchor.start) && (!anchor.end || mes.slice(-80) === anchor.end);
        });
        if (idx !== -1) return { index: idx + 1, found: true };
    }
    return { index: 0, found: false };
}

// ─── Chronicle data ──────────────────────────────────────────────────────────

function getChronicleData() {
    const meta = getChatMeta();
    if (!meta) return { snapshots: [], lastAnchor: null, injectEnabled: false, injectCount: 2, injectDepth: 2, autoSuggestAfter: AUTO_SUGGEST_AFTER, suggestSent: false };
    if (!meta[CHRONICLE_KEY]) {
        meta[CHRONICLE_KEY] = { snapshots: [], lastAnchor: null, injectEnabled: false, injectCount: 2, injectDepth: 2, autoSuggestAfter: AUTO_SUGGEST_AFTER, suggestSent: false };
    }
    return meta[CHRONICLE_KEY];
}

function setChronicleData(patch) {
    const ctx = getContextSafe();
    const meta = getChatMeta();
    if (!meta[CHRONICLE_KEY]) meta[CHRONICLE_KEY] = {};
    const prev = meta[CHRONICLE_KEY];
    Object.assign(prev, patch, { lastUpdated: Date.now() });
    // Ensure metadata is persisted (don't rely solely on ST's auto-save)
    if (ctx) {
        if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
        else if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
    }
}

function getSnapshots() {
    const raw = getChronicleData().snapshots || [];
    let mutated = false;
    const fixed = raw.map(s => {
        if (s.id === undefined || s.id === null || s.id === '') {
            mutated = true;
            return { ...s, id: `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
        }
        if (typeof s.id !== 'string') { mutated = true; return { ...s, id: String(s.id) }; }
        return s;
    });
    if (mutated) setChronicleData({ snapshots: fixed });
    return fixed;
}

// ─── Character extraction ────────────────────────────────────────────────────

function extractCharacters(chatSlice) {
    const names = new Set();
    chatSlice.forEach(msg => {
        if (msg.name && !msg.is_system) {
            const name = msg.name.trim();
            if (name && name !== 'User' && name !== 'Assistant') names.add(name);
        }
    });
    const ctx = getContextSafe();
    if (ctx?.character?.name?.trim()) names.add(ctx.character.name.trim());
    return Array.from(names).slice(0, MAX_CHARACTERS);
}

function getCharactersInRange(fromIndex, toIndex) {
    // slice end is exclusive but toIndex is inclusive, so add 1
    return extractCharacters(getChat().slice(fromIndex, toIndex + 1));
}

// ─── Token estimation ────────────────────────────────────────────────────────
// (uses shared estimateTokens from core)
function getInjectionStats() {
    const snapshots = getSnapshots();
    const data = getChronicleData();
    const injectMode = data.injectMode || 'recent';
    const injectCount = data.injectCount || 2;
    const totalEntries = snapshots.length;
    const manualCount = snapshots.filter(s => s.manual).length;
    const consolidatedCount = snapshots.filter(s => s.consolidated).length;
    const totalWords = snapshots.reduce((sum, s) => sum + (s.text?.split(/\s+/).length || 0), 0);
    const entriesToInject = getEntriesForInjection();
    const injectionText = entriesToInject.map(s => s.text || '').join('\n\n---\n\n');
    const tokenEstimate = estimateTokens(injectionText);
    const allCharacters = new Set();
    snapshots.forEach(s => { if (s.characters) s.characters.forEach(c => allCharacters.add(c)); });
    return { totalEntries, manualCount, consolidatedCount, generatedCount: totalEntries - manualCount, totalWords, entriesToInject: entriesToInject.length, tokenEstimate, characterCount: allCharacters.size, characters: Array.from(allCharacters), injectMode, injectCount };
}

// ─── Injection ───────────────────────────────────────────────────────────────

function isInjectionEnabled() { return !!getChronicleData().injectEnabled; }

function getEntriesForInjection() {
    const data = getChronicleData();
    const snapshots = getSnapshots();
    const mode = data.injectMode || 'recent';
    const count = data.injectCount || 2;
    if (mode === 'recent') return snapshots.slice(-count);
    if (mode === 'selected') return snapshots.filter(s => (data.selectedForInjection || []).includes(s.id));
    if (mode === 'all') return [...snapshots];
    if (mode === 'range') {
        const { injectFromDate, injectToDate } = data;
        if (injectFromDate && injectToDate) return snapshots.filter(s => new Date(s.createdAt) >= new Date(injectFromDate) && new Date(s.createdAt) <= new Date(injectToDate));
    }
    return [];
}

function roleToNumber(role) {
    switch (role) {
        case 'user': return 1;
        case 'assistant': return 2;
        default: return 0; // system
    }
}

function applyInjection() {
    const setEP = getSetExtensionPrompt();
    if (!setEP) return;
    const enabled = isInjectionEnabled();
    
    // Resolve depth/role before early return so we can clear the prompt with consistent settings
    const globalSettings = (typeof window !== 'undefined' && window.__mwt_shared?.getSettings)
        ? window.__mwt_shared.getSettings()
        : {};
    const depth = Number.isFinite(globalSettings.chronicleDepth) ? globalSettings.chronicleDepth : (getChronicleData().injectDepth ?? 2);
    const role = roleToNumber(globalSettings.chronicleRole);
    
    const snapshots = getSnapshots();
    if (!enabled || snapshots.length === 0) { setEP(EXTENSION_PROMPT_KEY, '', 1, depth, undefined, role); return; }
    const entries = getEntriesForInjection();
    if (entries.length === 0) { setEP(EXTENSION_PROMPT_KEY, '', 1, depth, undefined, role); return; }
    entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const text = entries.map(s => {
        const num = snapshots.indexOf(s) + 1;
        const charInfo = s.characters?.length ? ` [${s.characters.join(', ')}]` : '';
        return `### Chronicle Entry ${num} — ${s.worldDate || s.createdAt}${charInfo}\n${s.text}`;
    }).join('\n\n---\n\n');

    setEP(EXTENSION_PROMPT_KEY, `${CHRONICLE_INJECTION_HEADER}\n\n${text}`, 1, depth, undefined, role);
}

// ─── World State sync ────────────────────────────────────────────────────────

function updateWorldStateFromChronicle(text) {
    const meta = getChatMeta();
    if (!meta) return;
    const timeMatch = text.match(/## Time Anchor[\s\S]*?In-world date and time[:\s]*([^\n]+)/i);
    const locMatch = text.match(/## Time Anchor[\s\S]*?Location[:\s]*([^\n]+)/i);
    if (!timeMatch && !locMatch) return;
    const currentWs = meta[WS_METADATA_KEY]?.text || '';
    let newWs = currentWs;
    if (timeMatch) {
        const inferred = timeMatch[1].trim();
        const dateMatch = inferred.match(/(.+?),\s*(.+)/) || inferred.match(/(.+)/);
        if (dateMatch) {
            const datePart = dateMatch.length > 2 ? dateMatch[1].trim() : dateMatch[1].trim();
            const timePart = dateMatch.length > 2 ? dateMatch[2].trim() : '';
            newWs = newWs.replace(/^Date:\s*.*$/m, `Date: ${datePart}`);
            if (timePart && /\d/.test(timePart)) {
                if (/^Time:/m.test(newWs)) newWs = newWs.replace(/^Time:\s*.*$/m, `Time: ${timePart}`);
                else if (/^Date:/m.test(newWs)) newWs = newWs.replace(/^(Date:.*)$/m, `$1\nTime: ${timePart}`);
            }
        }
    }
    if (locMatch) {
        const loc = locMatch[1].trim();
        if (/^Location:/m.test(newWs)) newWs = newWs.replace(/^Location:\s*.*$/m, `Location: ${loc}`);
        else newWs += `\nLocation: ${loc}`;
    }
    if (newWs !== currentWs) {
        if (!meta[WS_METADATA_KEY]) meta[WS_METADATA_KEY] = {};
        meta[WS_METADATA_KEY].text = newWs;
        // Persist metadata so the synced world state survives reload
        const ctx = getContextSafe();
        if (ctx) {
            if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
            else if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
        }
        // Re-trigger world state injection so the prompt stays in sync
        try { applyWorldStateInjection(); } catch (_) { /* module may not be loaded yet */ }
    }
}

function getCurrentWorldState() {
    return getChatMeta()?.[WS_METADATA_KEY]?.text || '';
}

function getMessageCountSinceLastSnapshot() {
    const chat = getChat();
    const anchor = getChronicleData().lastAnchor;
    const resolved = resolveAnchor(anchor);
    if (!resolved.found && anchor) return null;
    return Math.max(0, chat.length - resolved.index);
}

// ─── Message filtering ───────────────────────────────────────────────────────

function shouldIncludeMessage(msg) {
    const s = getSettings();
    const text = String(msg?.mes || '').trim();
    if (!text) return false;
    if (s.filterSystem && (msg.is_system || msg.extra?.type === 'system')) return false;
    if (s.filterOoc) {
        if (/^\s*\(/.test(text) || /^\s*OOC:/i.test(text) || /^\s*\[OOC\]/i.test(text)) return false;
    }
    return true;
}

// ─── Build message window ────────────────────────────────────────────────────

function buildMessageWindow(fromIndex, toIndex) {
    const chat = getChat();
    const start = fromIndex ?? (() => { const { index } = resolveAnchor(getChronicleData().lastAnchor); return index; })();
    let end = (toIndex !== undefined && toIndex !== null) ? Math.min(toIndex + 1, chat.length) : chat.length;
    while (end > start) {
        const last = chat[end - 1];
        const streaming = last?.extra?.streaming === true || (last?.extra?.gen_started && !last?.extra?.gen_finished);
        const emptyAssistant = last && !last.is_user && !String(last.mes || '').trim();
        if (streaming || emptyAssistant) { end--; } else break;
    }
    const slice = chat.slice(start, end);
    const filtered = slice.filter(shouldIncludeMessage);
    if (filtered.length === 0) return { text: '', lastMsg: null, fromIndex: start, toIndex: end - 1 };
    const lines = [];
    let total = 0;
    const MAX = 100000;
    for (let i = filtered.length - 1; i >= 0; i--) {
        const msg = filtered[i];
        const name = msg?.name || (msg.is_user ? 'User' : 'Assistant');
        const text = String(msg.mes || '').trim();
        const line = `${name}: ${text}`;
        if (total + line.length > MAX) break;
        lines.push(line);
        total += line.length + 1;
    }
    return { text: lines.reverse().join('\n'), lastMsg: filtered[filtered.length - 1], fromIndex: start, toIndex: end - 1 };
}

// ─── Validate output ─────────────────────────────────────────────────────────

function validateSnapshotOutput(text) {
    if (!text.trim().startsWith('## Summary')) return { valid: false, reason: 'Output does not start with "## Summary".' };
    const sections = text.match(/^##\s/gm);
    if (!sections || sections.length < 2) return { valid: false, reason: 'Must contain at least two sections.' };
    const forbidden = ['narration', 'dialogue', 'roleplay', 'continue'];
    const lower = text.toLowerCase();
    const hit = forbidden.find(w => (lower.match(new RegExp(w, 'g')) || []).length > 2);
    if (hit) return { valid: false, reason: `Too many instances of "${hit}" — likely narrative text.` };
    const rpMarkers = text.match(/^(\*|_)/gm);
    if (rpMarkers && rpMarkers.length > 2) return { valid: false, reason: 'Contains roleplay formatting markers.' };
    const quoteLines = (text.match(/^["\u201C]/gm) || []).length;
    if (quoteLines > 1) return { valid: false, reason: 'Contains dialogue-like quoted lines.' };
    if (text.split(/\s+/).length > MAX_ENTRY_WORD_COUNT) return { valid: false, reason: `Too long (${text.split(/\s+/).length} words).` };
    return { valid: true };
}

function validateConsolidationOutput(text, baseEntry, deltaEntries) {
    const maxAllowed = Math.max(baseEntry.text.split(/\s+/).length + deltaEntries.reduce((s, e) => s + e.text.split(/\s+/).length, 0), 600);
    if (text.split(/\s+/).length > maxAllowed * 1.5) return { valid: false, reason: 'Consolidated entry too long.' };
    return validateSnapshotOutput(text);
}

// ─── Generate snapshot ───────────────────────────────────────────────────────

async function generateSnapshot() {
    if (isGenerating) { scSetStatus('Generation already in progress.', 'error'); return null; }
    if (isMainGenerating) {
        // Verify against actual ST state — the event-tracked flag can get stale
        const ctx = getContextSafe();
        const actuallyBusy = ctx?.streamingProcessor && !ctx.streamingProcessor.isFinished;
        if (actuallyBusy) {
            scSetStatus('Wait for the current chat response to finish.', 'error');
            return null;
        }
        // Flag was stale, reset it
        console.log('[MWT:Chronicle] Resetting stale isMainGenerating flag');
        isMainGenerating = false;
    }
    const chat = getChat();
    const { index } = resolveAnchor(getChronicleData().lastAnchor);
    const actualFrom = Math.max(0, index);
    if (actualFrom >= chat.length) { scSetStatus('No new messages to chronicle.', 'error'); return null; }
    const { text, lastMsg, toIndex } = buildMessageWindow(actualFrom, undefined);
    if (!text.trim()) { scSetStatus('No filterable messages to chronicle.', 'error'); return null; }

    isGenerating = true;
    scSetStatus('Generating chronicle entry…', 'info');
    try {
        if (typeof toastr !== 'undefined' && toastr?.info) {
            toastr.info('Generating chronicle entry…', 'Session Chronicle');
        }
    } catch { /* toastr may not be available */ }
    const worldState = getCurrentWorldState().trim();
    const wsDateMatch = worldState.match(/^Date:\s*(.+)$/m);
    const wsTimeMatch = worldState.match(/^Time:\s*(.+)$/m);
    const worldDate = wsDateMatch ? `${wsDateMatch[1].trim()}${wsTimeMatch ? ' ' + wsTimeMatch[1].trim() : ''}` : new Date().toLocaleDateString();
    const userContent = worldState ? `Current World State:\n${worldState}\n\nMessages to chronicle:\n${text}` : `Messages to chronicle:\n${text}`;

    try {
        const _scApi1 = resolveApiCall({ moduleSettings: getSettings() });
        let raw = await _scApi1.fetchFn({ systemPrompt: CHRONICLE_SYSTEM_PROMPT, userContent, settings: _scApi1.settings, retries: 3 });
        raw = normaliseOutput(raw);
        if (!raw.trim()) {
            const _scApi1b = resolveApiCall({ moduleSettings: getSettings() });
            raw = await _scApi1b.fetchFn({ systemPrompt: CHRONICLE_SYSTEM_PROMPT, userContent: userContent + '\n\n[REMINDER: Your last response was empty. Produce the chronicle entry as specified.]', settings: _scApi1b.settings, retries: 3 });
            raw = normaliseOutput(raw);
        }
        if (!raw.trim()) throw new Error('Chronicle output was empty.');

        const validation = validateSnapshotOutput(raw);
        if (!validation.valid) { console.warn('[MWT:Chronicle] Validation:', validation.reason); scSetStatus(`May need review: ${validation.reason}`, 'error'); }

        const newAnchor = makeAnchor(lastMsg || chat[chat.length - 1]);
        const characters = getCharactersInRange(actualFrom, toIndex);
        const snapshot = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(), worldDate, anchor: newAnchor,
            fromIndex: actualFrom, toIndex: typeof toIndex === 'number' ? toIndex : actualFrom,
            text: raw, characters, note: '',
        };
        const snapshots = [...getSnapshots(), snapshot];
        setChronicleData({ snapshots, lastAnchor: newAnchor, suggestSent: true });
        applyInjection();
        selectedSnapshotId = snapshot.id;
        renderContent();
        if (getSettings().syncWorldState) updateWorldStateFromChronicle(raw);
        scSetStatus('Chronicle entry generated.', 'success');
        return snapshot;
    } catch (err) {
        console.error('[MWT:Chronicle] Generate error:', err);
        scSetStatus(`Generation failed: ${err.message}`, 'error');
        try {
            if (typeof toastr !== 'undefined' && toastr?.error) {
                toastr.error(`Chronicle generation failed: ${err.message}`, 'Session Chronicle');
            }
        } catch { /* toastr may not be available */ }
        return null;
    } finally {
        isGenerating = false;
    }
}

// ─── Regenerate snapshot ─────────────────────────────────────────────────────

async function regenerateSnapshot(snapshotId) {
    if (isGenerating || isMainGenerating) { scSetStatus('Wait for current generation to finish.', 'error'); return; }
    const snapshots = getSnapshots();
    const idx = snapshots.findIndex(s => s.id === snapshotId);
    if (idx === -1) return;
    const snapshot = snapshots[idx];
    const originalText = snapshot.text;
    isGenerating = true;
    scSetStatus('Regenerating…', 'info');
    const chat = getChat();
    const from = snapshot.fromIndex ?? 0;
    const to = snapshot.toIndex !== undefined && snapshot.toIndex > from ? snapshot.toIndex : Math.min(from + 200, chat.length - 1);
    const { text } = buildMessageWindow(from, to);
    if (!text.trim()) { scSetStatus('No messages for regeneration.', 'error'); isGenerating = false; return; }
    const worldState = getCurrentWorldState().trim();
    const userContent = worldState ? `Current World State:\n${worldState}\n\nMessages to chronicle:\n${text}` : `Messages to chronicle:\n${text}`;

    try {
        const _scApi2 = resolveApiCall({ moduleSettings: getSettings() });
        let raw = await _scApi2.fetchFn({ systemPrompt: CHRONICLE_SYSTEM_PROMPT, userContent, settings: _scApi2.settings, retries: 3 });
        raw = normaliseOutput(raw);
        if (!raw.trim()) throw new Error('Empty output.');
        const timeMatch = raw.match(/## Time Anchor[\s\S]*?In-world date and time[:\s]*([^\n]+)/i);
        const newWorldDate = timeMatch ? timeMatch[1].trim() : snapshot.worldDate;
        showRegenerateDiff(originalText, raw, async (acceptNew) => {
            if (acceptNew) {
                const updated = [...snapshots];
                updated[idx] = { ...snapshot, text: raw, worldDate: newWorldDate };
                setChronicleData({ snapshots: updated });
                applyInjection();
                selectedSnapshotId = snapshot.id;
                renderContent();
                if (getSettings().syncWorldState) updateWorldStateFromChronicle(raw);
                scSetStatus('Entry regenerated.', 'success');
            } else {
                scSetStatus('Kept original.', 'info');
                selectedSnapshotId = snapshot.id;
                renderContent();
            }
            isGenerating = false;
        });
    } catch (err) {
        scSetStatus(`Regeneration failed: ${err.message}`, 'error');
        try {
            if (typeof toastr !== 'undefined' && toastr?.error) {
                toastr.error(`Chronicle regeneration failed: ${err.message}`, 'Session Chronicle');
            }
        } catch { /* toastr may not be available */ }
        isGenerating = false;
    }
}

// ─── Consolidate entries ─────────────────────────────────────────────────────

async function consolidateEntries(ids) {
    if (isGenerating) { scSetStatus('Generation in progress.', 'error'); return; }
    if (!ids || ids.length < 2) { scSetStatus('Select at least 2 entries.', 'error'); return; }
    const snapshots = getSnapshots();
    const selected = ids.map(id => snapshots.find(s => s.id === id)).filter(Boolean);
    if (selected.length < 2) { scSetStatus('Could not find all entries.', 'error'); return; }
    selected.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const base = selected[0];
    const deltas = selected.slice(1);
    const baseSection = `=== BASE ENTRY (earliest) ===\n${base.text}`;
    const deltaSections = deltas.map((d, i) => `=== DELTA ${i + 1} (later) ===\n${d.text}`).join('\n\n');
    const userContent = `${baseSection}\n\n${deltaSections}`;

    showConsolidationPreview(selected, userContent, async (editedResult) => {
        if (isGenerating) return;
        isGenerating = true;
        scSetStatus('Consolidating…', 'info');
        try {
            const _scApi3 = resolveApiCall({ moduleSettings: getSettings() });
            let raw = await _scApi3.fetchFn({ systemPrompt: CONSOLIDATE_SYSTEM_PROMPT, userContent: editedResult || userContent, settings: _scApi3.settings, retries: 3 });
            raw = normaliseOutput(raw);
            if (!raw.trim()) throw new Error('Empty output.');
            const validation = validateConsolidationOutput(raw, base, deltas);
            if (!validation.valid) { console.warn('[MWT:Chronicle] Consolidation:', validation.reason); scSetStatus(`Review needed: ${validation.reason}`, 'error'); }
            const allCharacters = new Set();
            selected.forEach(s => { if (s.characters) s.characters.forEach(c => allCharacters.add(c)); });
            const consolidated = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                createdAt: new Date().toISOString(), worldDate: selected[selected.length - 1].worldDate,
                anchor: selected[selected.length - 1].anchor, fromIndex: base.fromIndex ?? -1,
                toIndex: selected[selected.length - 1].toIndex ?? -1, text: raw,
                characters: Array.from(allCharacters), consolidated: true, _consolidatedFrom: ids,
            };
            const deletedBin = getChronicleData()._deletedBin || [];
            const originals = snapshots.filter(s => ids.includes(s.id));
            const updatedBin = [...deletedBin, ...originals].slice(-MAX_TRASH_SIZE);
            const remaining = snapshots.filter(s => !ids.includes(s.id));
            const newSnapshots = [...remaining, consolidated];
            newSnapshots.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            setChronicleData({ snapshots: newSnapshots, _deletedBin: updatedBin, suggestSent: true });
            applyInjection();
            consolidateMode = false;
            checkedForMerge.clear();
            selectedSnapshotId = consolidated.id;
            renderContent();
            if (getSettings().syncWorldState) updateWorldStateFromChronicle(raw);
            scSetStatus('Entries consolidated.', 'success');
        } catch (err) {
            scSetStatus(`Consolidation failed: ${err.message}`, 'error');
            try {
                if (typeof toastr !== 'undefined' && toastr?.error) {
                    toastr.error(`Chronicle consolidation failed: ${err.message}`, 'Session Chronicle');
                }
            } catch { /* toastr may not be available */ }
        } finally {
            isGenerating = false;
        }
    });
}

// ─── Manual entry ────────────────────────────────────────────────────────────

function createManualEntry() {
    const worldState = getCurrentWorldState().trim();
    const wsDateMatch = worldState.match(/^Date:\s*(.+)$/m);
    const wsTimeMatch = worldState.match(/^Time:\s*(.+)$/m);
    const worldDate = wsDateMatch ? `${wsDateMatch[1].trim()}${wsTimeMatch ? ' ' + wsTimeMatch[1].trim() : ''}` : new Date().toLocaleDateString();
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(), worldDate,
        anchor: getChronicleData().lastAnchor || null, fromIndex: -1, toIndex: -1,
        text: '## Summary\n- (write your entry here)\n\n## Relationship & Institutional Shifts\n\n## Open Loops Created\n\n## Open Loops Closed\n\n## Time Anchor\nIn-world date and time:\nLocation:',
        manual: true,
    };
    setChronicleData({ snapshots: [...getSnapshots(), entry], suggestSent: false });
    applyInjection();
    selectedSnapshotId = entry.id;
    renderContent();
    scSetStatus('New blank entry created.', 'success');
    return entry;
}

// ─── Delete / Trash ──────────────────────────────────────────────────────────

function deleteEntry(id) {
    const snapshots = getSnapshots();
    const idx = snapshots.findIndex(s => s.id === id);
    if (idx === -1) return;
    const removed = snapshots[idx];
    const remaining = snapshots.filter(s => s.id !== id);
    const deletedBin = getChronicleData()._deletedBin || [];
    const data = getChronicleData();
    const selectedIds = (data.selectedForInjection || []).filter(sid => sid !== id);
    const updatedBin = [...deletedBin, removed].slice(-MAX_TRASH_SIZE);
    // Compute lastAnchor from remaining snapshots in the same call to avoid
    // two debounced saves racing against each other.
    const lastAnchor = remaining.length > 0
        ? [...remaining].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).pop()?.anchor || null
        : null;
    setChronicleData({ snapshots: remaining, _deletedBin: updatedBin, selectedForInjection: selectedIds, suggestSent: false, lastAnchor });
    applyInjection();
    selectedSnapshotId = null;
    renderContent();
    scSetStatus('Entry moved to trash.', 'success');
}

function bulkDeleteEntries(ids) {
    if (!ids?.length) return;
    const snapshots = getSnapshots();
    const toRemove = snapshots.filter(s => ids.includes(s.id));
    const remaining = snapshots.filter(s => !ids.includes(s.id));
    const deletedBin = getChronicleData()._deletedBin || [];
    const updatedBin = [...deletedBin, ...toRemove].slice(-MAX_TRASH_SIZE);
    const data = getChronicleData();
    const idSet = new Set(ids);
    const selectedIds = (data.selectedForInjection || []).filter(sid => !idSet.has(sid));
    // Merge into a single setChronicleData call to avoid two debounced saves
    // racing against each other.
    const lastAnchor = remaining.length > 0
        ? [...remaining].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).pop()?.anchor || null
        : null;
    setChronicleData({ snapshots: remaining, _deletedBin: updatedBin, selectedForInjection: selectedIds, suggestSent: false, lastAnchor });
    applyInjection();
    bulkDeleteMode = false;
    consolidateMode = false;
    checkedForMerge.clear();
    selectedSnapshotId = null;
    renderContent();
    scSetStatus(`${toRemove.length} entries moved to trash.`, 'success');
}

function restoreDeletedEntry(entry) {
    const snapshots = [...(getChronicleData().snapshots || []), entry];
    snapshots.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const updatedBin = (getChronicleData()._deletedBin || []).filter(e => e.id !== entry.id);
    // Recompute lastAnchor from all snapshots (including the restored one)
    const lastAnchor = snapshots.length > 0
        ? snapshots[snapshots.length - 1]?.anchor || null
        : null;
    setChronicleData({ snapshots, _deletedBin: updatedBin, suggestSent: false, lastAnchor });
    applyInjection();
    selectedSnapshotId = entry.id;
    renderContent();
    scSetStatus('Entry restored.', 'success');
}

// ─── Confirmation dialog ─────────────────────────────────────────────────────

function showConfirm(message, detail, onConfirm) {
    const el = getContentEl();
    if (!el) return;
    const overlay = document.createElement('div');
    overlay.className = 'sc-confirm-overlay';
    overlay.innerHTML = `<div class="sc-confirm-box"><p>${escapeHtml(message)}</p>${detail ? `<p class="sc-confirm-detail">${escapeHtml(detail)}</p>` : ''}<div class="sc-confirm-actions"><button class="sc-confirm-yes sc-btn sc-btn--danger">Yes</button><button class="sc-confirm-no sc-btn">Cancel</button></div></div>`;
    el.style.position = 'relative';
    el.appendChild(overlay);
    const cleanup = () => { overlay.remove(); document.removeEventListener('keydown', handleKey); };
    const handleKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } };
    document.addEventListener('keydown', handleKey);
    overlay.querySelector('.sc-confirm-yes').addEventListener('click', () => { cleanup(); onConfirm(); });
    overlay.querySelector('.sc-confirm-no').addEventListener('click', () => cleanup());
}

// ─── Export / Import ─────────────────────────────────────────────────────────

function exportChronicle() {
    const data = { snapshots: getSnapshots(), lastAnchor: getChronicleData().lastAnchor, injectEnabled: isInjectionEnabled(), injectCount: getChronicleData().injectCount || 2, injectDepth: getChronicleData().injectDepth || 2, exportedAt: new Date().toISOString(), version: SC_VERSION };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chronicle-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Delay revocation so the browser has time to start the download
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    scSetStatus('Exported.', 'success');
}

function exportMarkdown() {
    const snapshots = getSnapshots().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let md = `# Session Chronicle\n\n*Exported: ${new Date().toLocaleString()}*\n\n---\n\n`;
    snapshots.forEach((s, i) => {
        md += `## ${s.manual ? 'Manual' : s.consolidated ? 'Consolidated' : `#${i + 1}`}: ${s.worldDate || s.createdAt}\n\n${s.text}\n\n---\n\n`;
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chronicle-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Delay revocation so the browser has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    scSetStatus('Exported as Markdown.', 'success');
}

function importChronicle(jsonString) {
    try {
        const parsed = JSON.parse(jsonString);
        if (!parsed.snapshots || !Array.isArray(parsed.snapshots)) throw new Error('Invalid: missing snapshots.');
        const existing = getSnapshots();
        const existingIds = new Set(existing.map(s => s.id));
        let added = 0;
        const merged = [...existing];
        for (const snap of parsed.snapshots) {
            if (!existingIds.has(snap.id)) { merged.push({ ...snap, id: snap.id || `imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }); added++; }
        }
        merged.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        // Restore lastAnchor (data), but skip injection settings (session config)
        // to avoid silently overwriting the user's current injection preferences
        const patch = { snapshots: merged, suggestSent: false };
        if (parsed.lastAnchor) patch.lastAnchor = parsed.lastAnchor;
        if (parsed.injectEnabled !== undefined || parsed.injectCount !== undefined || parsed.injectDepth !== undefined) {
            const restoreInjection = confirm('Import contains injection settings (enabled/count/depth). Restore those too?');
            if (restoreInjection) {
                if (parsed.injectEnabled !== undefined) patch.injectEnabled = parsed.injectEnabled;
                if (parsed.injectCount !== undefined) patch.injectCount = parsed.injectCount;
                if (parsed.injectDepth !== undefined) patch.injectDepth = parsed.injectDepth;
            }
        }

        setChronicleData(patch);
        applyInjection();
        selectedSnapshotId = null;
        renderContent();
        scSetStatus(`Imported ${added} entries (${merged.length} total).`, 'success');
    } catch (err) {
        scSetStatus(`Import failed: ${err.message}`, 'error');
    }
}

// ─── Sub-views ───────────────────────────────────────────────────────────────

function showRegenerateDiff(originalText, newText, onDecision) {
    const el = getContentEl();
    if (!el) { onDecision(false); return; }
    const diffHtml = buildInlineDiff(originalText, newText);
    el.innerHTML = `
        <div class="sc-regenerate-diff">
            <h3>Regeneration Preview</h3>
            <p>Compare original vs regenerated. Choose which to keep.</p>
            <div class="sc-diff-container"><div class="sc-diff-panel"><h4>Original</h4><pre class="sc-diff-original">${diffHtml.originalHtml}</pre></div><div class="sc-diff-panel"><h4>Regenerated</h4><pre class="sc-diff-new">${diffHtml.newHtml}</pre></div></div>
            <p><strong>Original:</strong> ${originalText.split(/\s+/).length} words · <strong>Regenerated:</strong> ${newText.split(/\s+/).length} words</p>
            <div class="mwt-flex mwt-gap-4"><button id="sc-diff-accept" class="mwt-btn mwt-btn-primary">Accept Regenerated</button><button id="sc-diff-keep" class="mwt-btn">Keep Original</button></div>
        </div>`;
    el.querySelector('#sc-diff-accept')?.addEventListener('click', () => onDecision(true));
    el.querySelector('#sc-diff-keep')?.addEventListener('click', () => onDecision(false));
}

function showConsolidationPreview(selectedEntries, inputContent, onConfirm) {
    const el = getContentEl();
    if (!el) return;
    el.innerHTML = `
        <div class="sc-consolidate-preview">
            <p>Review content fed to consolidator. Edit if needed.</p>
            ${selectedEntries.map((e, i) => `<details ${i === 0 ? 'open' : ''}><summary>${i === 0 ? 'BASE' : `DELTA ${i}`} — ${escapeHtml(e.worldDate || e.createdAt)}</summary><pre>${escapeHtml(e.text.slice(0, 2000))}</pre></details>`).join('')}
            <textarea id="sc-consolidate-input" class="mwt-textarea" rows="12">${escapeHtml(inputContent)}</textarea>
            <div class="sc-status"><span class="sc-status"></span></div>
            <div class="mwt-flex mwt-gap-4"><button id="sc-consolidate-go" class="mwt-btn mwt-btn-primary" ${!hasValidSettings() ? 'disabled' : ''}>Consolidate</button><button id="sc-consolidate-cancel" class="mwt-btn">Cancel</button></div>
        </div>`;
    el.querySelector('#sc-consolidate-go')?.addEventListener('click', function () { this.disabled = true; onConfirm(el.querySelector('#sc-consolidate-input')?.value || inputContent); });
    el.querySelector('#sc-consolidate-cancel')?.addEventListener('click', () => renderContent());
}

function showEntryEditor(snapshot) {
    const el = getContentEl();
    if (!el) return;
    const charList = snapshot.characters?.length ? snapshot.characters.join(', ') : 'None';
    el.innerHTML = `
        <div class="sc-editor">
            <div class="sc-editor-meta"><span>ID: ${escapeHtml(snapshot.id)}</span><span>Created: ${escapeHtml(snapshot.createdAt)}</span><span>World Date: ${escapeHtml(snapshot.worldDate || '—')}</span>${snapshot.manual ? '<span class="sc-badge">Manual</span>' : ''}${snapshot.consolidated ? '<span class="sc-badge">Consolidated</span>' : ''}</div>
            <div><span>Characters:</span> ${escapeHtml(charList)}</div>
            <div><span>Note:</span> <input type="text" id="sc-note-input" class="mwt-input" value="${escapeHtml(snapshot.note || '')}" placeholder="Add a note..."></div>
            <textarea id="sc-editor-textarea" class="mwt-textarea" rows="20">${escapeHtml(snapshot.text)}</textarea>
            <div class="sc-status"><span class="sc-status"></span></div>
            <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                <button id="sc-save-edit" class="mwt-btn mwt-btn-primary">Save</button>
                <button id="sc-regenerate-btn" class="mwt-btn" ${!snapshot.manual && hasValidSettings() ? '' : 'disabled'}>Regenerate</button>
                ${snapshot._consolidatedFrom?.length ? '<button id="sc-undo-consolidate" class="mwt-btn">↩ Undo Consolidation</button>' : ''}
                <button id="sc-delete-btn" class="mwt-btn" style="background:var(--mwt-danger)">Delete</button>
                <button id="sc-back-btn" class="mwt-btn">← Back</button>
            </div>
        </div>`;

    const originalText = snapshot.text;
    el.querySelector('#sc-save-edit')?.addEventListener('click', () => {
        const newText = el.querySelector('#sc-editor-textarea')?.value || '';
        const newNote = el.querySelector('#sc-note-input')?.value || '';
        const snapshots = getSnapshots();
        const idx = snapshots.findIndex(s => s.id === snapshot.id);
        if (idx !== -1) {
            const updated = [...snapshots];
            updated[idx] = { ...snapshot, text: newText, note: newNote, _previousText: originalText };
            setChronicleData({ snapshots: updated });
            applyInjection();
            scSetStatus('Entry saved.', 'success');
        }
    });
    el.querySelector('#sc-regenerate-btn')?.addEventListener('click', () => { if (!snapshot.manual) regenerateSnapshot(snapshot.id); });
    el.querySelector('#sc-delete-btn')?.addEventListener('click', () => deleteEntry(snapshot.id));
    el.querySelector('#sc-back-btn')?.addEventListener('click', () => { selectedSnapshotId = null; renderContent(); });
    el.querySelector('#sc-undo-consolidate')?.addEventListener('click', () => {
        if (!snapshot._consolidatedFrom?.length) return;
        showConfirm('Undo consolidation?', 'Restores original entries.', () => {
            const snapshots = getSnapshots();
            const remaining = snapshots.filter(s => s.id !== snapshot.id);
            const deletedBin = getChronicleData()._deletedBin || [];
            const restored = [];
            for (const origId of snapshot._consolidatedFrom) {
                const fromTrash = deletedBin.find(e => e.id === origId);
                if (fromTrash) restored.push({ ...fromTrash, _restored: true });
            }
            if (!restored.length) { scSetStatus('Originals not found in trash.', 'error'); return; }
            const updatedTrash = deletedBin.filter(e => !restored.some(r => r.id === e.id));
            const newSnapshots = [...remaining, ...restored].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            setChronicleData({ snapshots: newSnapshots, _deletedBin: updatedTrash, suggestSent: false });
            applyInjection();
            selectedSnapshotId = null;
            renderContent();
            scSetStatus(`${restored.length} entries restored.`, 'success');
        });
    });
}

function showTrashModal() {
    const el = getContentEl();
    if (!el) return;
    const deletedBin = getChronicleData()._deletedBin || [];
    if (!deletedBin.length) {
        el.innerHTML = `<div><p>Trash is empty.</p><button id="sc-back-from-trash" class="mwt-btn">← Back</button></div>`;
    } else {
        el.innerHTML = `<div><h3>Recently Deleted (${deletedBin.length})</h3>
            ${deletedBin.map(e => `<div style="padding:8px;border-bottom:1px solid var(--mwt-border)"><span>${escapeHtml(e.worldDate || e.createdAt)}</span> <span>${escapeHtml((e.text || '').slice(0, 80))}…</span> <button class="mwt-btn sc-restore-btn" data-id="${escapeHtml(e.id)}">Restore</button></div>`).join('')}
            <div class="mwt-flex mwt-gap-4 mwt-mt-8"><button id="sc-empty-trash" class="mwt-btn" style="background:var(--mwt-danger)">Empty Trash</button><button id="sc-back-from-trash" class="mwt-btn">← Back</button></div></div>`;
        el.querySelectorAll('.sc-restore-btn').forEach(btn => {
            btn.addEventListener('click', () => { const entry = deletedBin.find(e => e.id === btn.dataset.id); if (entry) restoreDeletedEntry(entry); });
        });
        el.querySelector('#sc-empty-trash')?.addEventListener('click', () => {
            showConfirm('Permanently delete all trashed entries?', 'Cannot be undone.', () => { setChronicleData({ _deletedBin: [] }); renderContent(); scSetStatus('Trash emptied.', 'success'); });
        });
    }
    el.querySelector('#sc-back-from-trash')?.addEventListener('click', () => { selectedSnapshotId = null; renderContent(); });
}

function showStatsModal() {
    const el = getContentEl();
    if (!el) return;
    const stats = getInjectionStats();
    const snapshots = getSnapshots();
    const charMap = new Map();
    snapshots.forEach(s => { if (s.characters) s.characters.forEach(c => { charMap.set(c, (charMap.get(c) || 0) + 1); }); });
    const topChars = Array.from(charMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => `${n} (${c})`).join(', ') || 'None';
    const tokenWarning = stats.tokenEstimate > 4000 ? '⚠️ High token usage' : '✅ Within limits';
    const tokenWarningClass = stats.tokenEstimate > 4000 ? 'mwt-token-info--danger' : stats.tokenEstimate > 2000 ? 'mwt-token-info--warn' : '';
        el.innerHTML = `<div>
        <h3>📊 Statistics</h3>
        <div class="sc-stats-grid"><div><span>Total Entries:</span><strong>${stats.totalEntries}</strong></div><div><span>Generated:</span><strong>${stats.generatedCount}</strong></div><div><span>Manual:</span><strong>${stats.manualCount}</strong></div><div><span>Consolidated:</span><strong>${stats.consolidatedCount}</strong></div></div>
        <div class="sc-stats-grid"><div><span>Total Words:</span><strong>${stats.totalWords}</strong></div><div><span>Avg/Entry:</span><strong>${stats.totalEntries > 0 ? Math.round(stats.totalWords / stats.totalEntries) : 0}</strong></div></div>
        <h4>Injection (${stats.injectMode})</h4>
        <div class="sc-stats-grid"><div><span>Entries:</span><strong>${stats.entriesToInject}</strong></div><div><span>Est. Tokens:</span><strong class="${tokenWarningClass}">${stats.tokenEstimate}</strong></div><div><span>Status:</span><strong>${tokenWarning}</strong></div></div>
        <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px"><strong>Status</strong> compares estimated injection tokens against a ~4000 token soft limit. To reduce tokens: lower the entry count in <strong>⚙ Injection Settings</strong> (gear button below entry list), switch from "All" to "Recent" mode, or consolidate older entries.</p>
        <h4>Characters (${stats.characterCount})</h4><p>${escapeHtml(topChars)}</p>
        <button id="sc-stats-close" class="mwt-btn">← Back</button>
    </div>`;
    el.querySelector('#sc-stats-close')?.addEventListener('click', () => renderContent());
}

function showPreviewInjection() {
    const entries = getEntriesForInjection();
    if (entries.length === 0) {
        scSetStatus('No chronicle entries to preview — generate or enable injection first.', 'warning');
        return;
    }
    const snapshots = getSnapshots();
    entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const text = entries.map(s => {
        const num = snapshots.indexOf(s) + 1;
        const charInfo = s.characters?.length ? ` [${s.characters.join(', ')}]` : '';
        return `### Chronicle Entry ${num} — ${s.worldDate || s.createdAt}${charInfo}\n${s.text}`;
    }).join('\n\n---\n\n');

    const injected = `${CHRONICLE_INJECTION_HEADER}\n\n${text}`;
    const tokens = estimateTokens(injected);

    // Resolve depth/role for display
    const globalSettings = (typeof window !== 'undefined' && window.__mwt_shared?.getSettings)
        ? window.__mwt_shared.getSettings()
        : {};
    const depth = Number.isFinite(globalSettings.chronicleDepth) ? globalSettings.chronicleDepth : (getChronicleData().injectDepth ?? 2);
    const roleName = globalSettings.chronicleRole || 'system';

    const previewModal = createModal({
        id: 'mwt-sc-injection-preview',
        title: 'Chronicle Injection Preview',
        content: `
            <p class="mwt-text-dim mwt-text-sm mwt-mb-8">
                This is exactly what gets injected into the prompt (${injected.length} chars, ~${tokens} tokens).
                Depth: <strong>${depth}</strong> · Role: <strong>${roleName}</strong>.
            </p>
            <pre style="white-space:pre-wrap;font-family:var(--mwt-font-mono);font-size:12px;line-height:1.5;background:var(--mwt-bg-light);padding:12px;border-radius:var(--mwt-radius);border:1px solid var(--mwt-border);max-height:60vh;overflow-y:auto">${escapeHtml(injected)}</pre>
            <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                <button id="mwt-sc-preview-copy" class="mwt-btn mwt-btn-primary">📋 Copy to Clipboard</button>
                <button id="mwt-sc-preview-close" class="mwt-btn">Close</button>
            </div>
        `,
    });

    previewModal.querySelector('#mwt-sc-preview-copy')?.addEventListener('click', () => {
        navigator.clipboard.writeText(injected).then(() => {
            setStatus(previewModal, 'Copied to clipboard.', 'success', 2000);
        }).catch(() => {
            setStatus(previewModal, 'Failed to copy.', 'error');
        });
    });

    previewModal.querySelector('#mwt-sc-preview-close')?.addEventListener('click', () => {
        hideModal('mwt-sc-injection-preview');
    });

    showModal('mwt-sc-injection-preview');
}

function showInjectionSelector() {
    const el = getContentEl();
    if (!el) return;
    const data = getChronicleData();
    const snapshots = getSnapshots();
    const currentMode = data.injectMode || 'recent';
    const currentCount = data.injectCount || 2;
    const selectedForInjection = data.selectedForInjection || [];
    el.innerHTML = `<div>
        <h3>Injection Settings</h3>
        <div><label><input type="radio" name="sc-inject-mode" value="recent" ${currentMode === 'recent' ? 'checked' : ''}> Recent</label><label><input type="radio" name="sc-inject-mode" value="selected" ${currentMode === 'selected' ? 'checked' : ''}> Selected</label><label><input type="radio" name="sc-inject-mode" value="all" ${currentMode === 'all' ? 'checked' : ''}> All</label><label><input type="radio" name="sc-inject-mode" value="range" ${currentMode === 'range' ? 'checked' : ''}> Range</label></div>
        <div id="sc-inject-mode-options">
            <div id="sc-recent-options" style="display:${currentMode === 'recent' ? 'block' : 'none'}"><label>Count: <input type="number" id="sc-inject-count" value="${currentCount}" min="1" max="${snapshots.length}"></label></div>
            <div id="sc-selected-options" style="display:${currentMode === 'selected' ? 'block' : 'none'}">${snapshots.map(s => `<label><input type="checkbox" class="sc-inject-select-cb" data-id="${escapeHtml(s.id)}" ${selectedForInjection.includes(s.id) ? 'checked' : ''}> ${escapeHtml(s.worldDate || s.createdAt)} — ${escapeHtml((s.text || '').slice(0, 50))}</label>`).join('<br>')}</div>
            <div id="sc-range-options" style="display:${currentMode === 'range' ? 'block' : 'none'}"><label>From: <input type="datetime-local" id="sc-inject-from" value="${data.injectFromDate || ''}"></label><label>To: <input type="datetime-local" id="sc-inject-to" value="${data.injectToDate || ''}"></label></div>
        </div>
        <div class="mwt-flex mwt-gap-4 mwt-mt-8"><button id="sc-apply-injection" class="mwt-btn mwt-btn-primary">Apply</button><button id="sc-cancel-injection" class="mwt-btn">Cancel</button></div>
    </div>`;
    el.querySelectorAll('input[name="sc-inject-mode"]').forEach(r => {
        r.addEventListener('change', () => {
            const mode = r.value;
            const ro = el.querySelector('#sc-recent-options'); if (ro) ro.style.display = mode === 'recent' ? 'block' : 'none';
            const so = el.querySelector('#sc-selected-options'); if (so) so.style.display = mode === 'selected' ? 'block' : 'none';
            const rao = el.querySelector('#sc-range-options'); if (rao) rao.style.display = mode === 'range' ? 'block' : 'none';
        });
    });
    el.querySelector('#sc-apply-injection')?.addEventListener('click', () => {
        const mode = el.querySelector('input[name="sc-inject-mode"]:checked')?.value || 'recent';
        let newData = { injectMode: mode };
        if (mode === 'recent') { newData.injectCount = parseInt(el.querySelector('#sc-inject-count')?.value) || 2; newData.selectedForInjection = []; }
        else if (mode === 'selected') { const sel = []; el.querySelectorAll('.sc-inject-select-cb:checked').forEach(cb => sel.push(cb.dataset.id)); newData.selectedForInjection = sel; }
        else if (mode === 'range') { newData.injectFromDate = el.querySelector('#sc-inject-from')?.value || ''; newData.injectToDate = el.querySelector('#sc-inject-to')?.value || ''; }
        setChronicleData(newData);
        applyInjection();
        renderContent();
        scSetStatus(`Injection set to "${mode}".`, 'success');
    });
    el.querySelector('#sc-cancel-injection')?.addEventListener('click', () => renderContent());
}

function showSettingsModal() {
    const el = getContentEl();
    if (!el) return;
    const s = getSettings();
    el.innerHTML = `<div>
        <h3>Chronicle Settings</h3>
        <div class="mwt-settings-grid">
            <label class="mwt-label">API URL</label><input id="sc-api-url" class="mwt-input" value="${escapeHtml(s.apiUrl)}" placeholder="https://api.openai.com/v1">
            <label class="mwt-label">API Key</label><input id="sc-api-key" class="mwt-input" type="password" value="${escapeHtml(s.apiKey)}">
            <label class="mwt-label">Model</label><input id="sc-model" class="mwt-input" value="${escapeHtml(s.modelName)}" placeholder="gpt-4o">
            <label class="mwt-label">Max Tokens</label><input id="sc-max-tokens" class="mwt-input" type="number" value="${s.maxTokens || 8000}" min="100" max="32000">
            <label class="mwt-label">Temperature</label><input id="sc-temp" class="mwt-input" type="number" value="${s.temperature ?? 0.3}" min="0" max="2" step="0.1">
            <label class="mwt-label">Top P</label><input id="sc-top-p" class="mwt-input" type="number" value="${s.topP ?? 1.0}" min="0" max="1" step="0.05">
            <label class="mwt-label">Freq Penalty</label><input id="sc-freq-pen" class="mwt-input" type="number" value="${s.frequencyPenalty ?? 0}" min="-2" max="2" step="0.1">
            <label class="mwt-label">Pres Penalty</label><input id="sc-pres-pen" class="mwt-input" type="number" value="${s.presencePenalty ?? 0}" min="-2" max="2" step="0.1">
            <label class="mwt-label">Custom Headers</label><input id="sc-headers" class="mwt-input" value="${escapeHtml(s.customHeaders || '')}" placeholder='{"X-Custom":"value"}'>
            <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Custom Headers: JSON object of extra HTTP headers sent with each API request. Example: <code>{"X-Organization":"my-org"}</code>. Leave blank if unsure.</p>
        </div>
        <div style="margin-top:12px">
            <label><input type="checkbox" id="sc-filter-system" ${s.filterSystem !== false ? 'checked' : ''}> Filter system messages <span style="font-size:11px;color:var(--mwt-text-dim)">(hides SillyTavern system prompts, jailbreaks, etc.)</span></label><br>
            <label><input type="checkbox" id="sc-filter-ooc" ${s.filterOoc !== false ? 'checked' : ''}> Filter OOC messages <span style="font-size:11px;color:var(--mwt-text-dim)">(hides messages starting with <code>(</code>, <code>[OOC]</code>, or <code>OOC:</code>)</span></label><br>
            <label><input type="checkbox" id="sc-auto-snapshot" ${s.autoSnapshot ? 'checked' : ''}> Auto-snapshot</label><br>
            <label><input type="checkbox" id="sc-sync-ws" ${s.syncWorldState !== false ? 'checked' : ''}> Sync World State</label>
        </div>
        <div style="margin-top:8px"><label>Auto-snapshot threshold: <input type="number" id="sc-auto-threshold" class="mwt-input" style="width:80px;display:inline-block" value="${s.autoSnapshotThreshold || 40}" min="5" max="500"></label> <span style="font-size:11px;color:var(--mwt-text-dim)">messages between auto-generations</span></div>
        <div class="mwt-flex mwt-gap-4 mwt-mt-8"><button id="sc-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button><button id="sc-cancel-settings" class="mwt-btn">Cancel</button></div>
    </div>`;
    el.querySelector('#sc-save-settings')?.addEventListener('click', () => {
        saveSettings({
            apiUrl: el.querySelector('#sc-api-url')?.value || '', apiKey: el.querySelector('#sc-api-key')?.value || '',
            modelName: el.querySelector('#sc-model')?.value || '', maxTokens: Number(el.querySelector('#sc-max-tokens')?.value) || 8000,
            temperature: Number(el.querySelector('#sc-temp')?.value), topP: Number(el.querySelector('#sc-top-p')?.value),
            frequencyPenalty: Number(el.querySelector('#sc-freq-pen')?.value), presencePenalty: Number(el.querySelector('#sc-pres-pen')?.value),
            customHeaders: el.querySelector('#sc-headers')?.value || '',
            filterSystem: el.querySelector('#sc-filter-system')?.checked ?? true,
            filterOoc: el.querySelector('#sc-filter-ooc')?.checked ?? true,
            autoSnapshot: el.querySelector('#sc-auto-snapshot')?.checked ?? false,
            autoSnapshotThreshold: Number(el.querySelector('#sc-auto-threshold')?.value) || 40,
            syncWorldState: el.querySelector('#sc-sync-ws')?.checked ?? true,
        });
        renderContent();
        scSetStatus('Settings saved.', 'success');
    });
    el.querySelector('#sc-cancel-settings')?.addEventListener('click', () => renderContent());
}

// ─── Main render ─────────────────────────────────────────────────────────────

function renderContent() {
    const el = getContentEl();
    if (!el) return;
    const snapshots = getSnapshots();
    const hasApi = hasValidSettings();

    if (selectedSnapshotId) {
        const snapshot = snapshots.find(s => s.id === selectedSnapshotId);
        if (snapshot) { showEntryEditor(snapshot); return; }
        selectedSnapshotId = null;
    }

    if (!snapshots.length) {
        el.innerHTML = `<div style="text-align:center;padding:40px"><p>No chronicle entries yet.</p><p>Entries build over time as you generate snapshots.</p>${!hasApi ? '<p style="color:var(--mwt-danger)">⚠ API not configured</p>' : ''}<div class="mwt-flex mwt-gap-4" style="justify-content:center"><button id="sc-settings-btn" class="mwt-btn">⚙ Settings</button><button id="sc-new-entry-btn" class="mwt-btn mwt-btn-primary">+ New Blank Entry</button></div></div>`;
        bindMainEvents();
        return;
    }

    let sorted = [...snapshots].map((s, i) => ({ ...s, originalIndex: i })).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (pendingSearch?.trim()) {
        const q = pendingSearch.trim().toLowerCase();
        sorted = sorted.filter(s => `${s.worldDate || ''} ${s.text || ''} ${s.note || ''}`.toLowerCase().includes(q));
    }

    const getSnapshotClass = (s) => {
        const classes = ['sc-entry'];
        if (s.id === selectedSnapshotId) classes.push('sc-entry--selected');
        if (s.manual) classes.push('sc-entry--manual');
        if (s.consolidated) classes.push('sc-entry--consolidated');
        if (consolidateMode && checkedForMerge.has(s.id)) classes.push('sc-entry--merge-checked');
        if (bulkDeleteMode && checkedForMerge.has(s.id)) classes.push('sc-entry--delete-checked');
        return classes.join(' ');
    };

    const msgSince = getMessageCountSinceLastSnapshot();
    const autoSettings = getSettings();

    const _injStats = getInjectionStats();
    el.innerHTML = `
        <div class="sc-toolbar">
            ${!hasApi ? '<p style="color:var(--mwt-danger)">⚠ API not configured — <button id="sc-open-settings-btn" class="mwt-btn" style="display:inline">Open Settings</button></p>' : ''}
            <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                <button id="sc-generate-btn" class="mwt-btn mwt-btn-primary" ${!hasApi ? 'disabled' : ''}>Generate Entry</button>
                <button id="sc-new-entry-btn" class="mwt-btn">+ Blank Entry</button>
                <button id="sc-consolidate-mode-btn" class="mwt-btn ${consolidateMode ? 'mwt-btn-primary' : ''}" ${snapshots.length < 2 ? 'disabled' : ''}>${consolidateMode ? '✓ Selecting' : 'Consolidate'}</button>
                <button id="sc-bulk-delete-btn" class="mwt-btn" ${snapshots.length < 1 ? 'disabled' : ''}>${bulkDeleteMode ? '✓ Selecting' : 'Bulk Delete'}</button>
                <button id="sc-trash-btn" class="mwt-btn">🗑 Trash (${(getChronicleData()._deletedBin || []).length})</button>
            </div>
            <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap;margin-top:8px">
                <input type="text" id="sc-search-input" class="mwt-input" placeholder="Search entries…" value="${escapeHtml(pendingSearch)}" style="flex:1">
                <span style="color:var(--mwt-text-dim)">Msgs since last: ${msgSince ?? '?'}</span>
            </div>
            ${autoSettings.autoSnapshot ? `<div style="color:var(--mwt-accent);margin-top:4px">Auto-snapshot: ON (~${autoSettings.autoSnapshotThreshold} msgs)</div>` : ''}
            ${consolidateMode ? '<div style="color:var(--mwt-accent)">📦 Select 2+ entries then click Consolidate</div>' : ''}
            ${bulkDeleteMode ? '<div style="color:var(--mwt-danger)">⚠ Select entries to delete</div>' : ''}
        </div>
        <div class="sc-entries">${sorted.map((s, i) => {
            const label = s.manual ? '[Manual]' : s.consolidated ? '[Consolidated]' : `#${i + 1}`;
            return `<div class="${getSnapshotClass(s)}" data-id="${escapeHtml(s.id)}" style="padding:8px;border:1px solid var(--mwt-border);margin:4px 0;cursor:pointer;border-radius:4px">
                <div style="display:flex;justify-content:space-between"><span>${(consolidateMode || bulkDeleteMode) ? `<input type="checkbox" class="sc-checkbox" data-id="${escapeHtml(s.id)}" ${checkedForMerge.has(s.id) ? 'checked' : ''} style="margin-right:8px">` : ''}<strong>${label}</strong></span><span style="color:var(--mwt-text-dim)">${escapeHtml(s.worldDate || s.createdAt)}</span></div>
                <div style="color:var(--mwt-text-dim);font-size:12px;margin-top:4px">${escapeHtml((s.text || '').slice(0, 120).replace(/\n/g, ' '))}${s.text?.length > 120 ? '…' : ''}</div>
            </div>`;
        }).join('')}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;flex-wrap:wrap;gap:4px">
            <div class="sc-status"><span class="sc-status"></span></div>
            <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                <button id="sc-inject-toggle" class="mwt-btn" style="font-size:12px">${isInjectionEnabled() ? '📥 Injection ON' : '📤 Injection OFF'}</button>
                <button id="sc-preview-injection" class="mwt-btn" style="font-size:12px">📄 Preview</button>
                <span class="mwt-token-info${_injStats.tokenEstimate > 4000 ? ' mwt-token-info--danger' : _injStats.tokenEstimate > 2000 ? ' mwt-token-info--warn' : ''}" style="font-size:11px">~${_injStats.tokenEstimate} tokens (${_injStats.entriesToInject} entries)</span>
                <button id="sc-inject-settings" class="mwt-btn" style="font-size:12px">⚙</button>
                <button id="sc-stats-btn" class="mwt-btn" style="font-size:12px">📊 Stats</button>
                <button id="sc-export-json" class="mwt-btn" style="font-size:12px">Export JSON</button>
                <button id="sc-export-md" class="mwt-btn" style="font-size:12px">Export MD</button>
                <button id="sc-import-btn" class="mwt-btn" style="font-size:12px">Import</button>
                <button id="sc-settings-btn" class="mwt-btn" style="font-size:12px">⚙ Settings</button>
                <button id="sc-reset-btn" class="mwt-btn" style="font-size:12px;color:var(--mwt-danger)">Clear All</button>
            </div>
        </div>`;

    // Consolidate / Bulk delete action button
    if (consolidateMode && checkedForMerge.size >= 2) {
        const btn = document.createElement('button');
        btn.className = 'mwt-btn mwt-btn-primary';
        btn.textContent = `Consolidate ${checkedForMerge.size} entries`;
        btn.addEventListener('click', () => showConfirm(`Consolidate ${checkedForMerge.size} entries?`, 'Originals moved to trash.', () => consolidateEntries([...checkedForMerge])));
        el.querySelector('.sc-entries')?.after(btn);
    }
    if (bulkDeleteMode && checkedForMerge.size >= 1) {
        const btn = document.createElement('button');
        btn.className = 'mwt-btn';
        btn.style.background = 'var(--mwt-danger)';
        btn.textContent = `Delete ${checkedForMerge.size} entries`;
        btn.addEventListener('click', () => showConfirm(`Delete ${checkedForMerge.size} entries?`, 'Moved to trash.', () => bulkDeleteEntries([...checkedForMerge])));
        el.querySelector('.sc-entries')?.after(btn);
    }

    bindMainEvents();
    if (_lastStatusMsg) scSetStatus(_lastStatusMsg, _lastStatusLevel);
}

function bindMainEvents() {
    const el = getContentEl();
    if (!el) return;

    // Entry clicks
    el.querySelectorAll('.sc-entry').forEach(entry => {
        entry.addEventListener('click', (e) => {
            if (e.target.closest('.sc-checkbox')) return;
            const id = entry.dataset.id;
            if (consolidateMode || bulkDeleteMode) {
                if (checkedForMerge.has(id)) checkedForMerge.delete(id); else checkedForMerge.add(id);
                renderContent();
            } else {
                selectedSnapshotId = id;
                renderContent();
            }
        });
    });

    // Checkboxes
    el.querySelectorAll('.sc-checkbox').forEach(cb => {
        cb.addEventListener('click', (e) => {
            e.stopPropagation();
            if (cb.checked) checkedForMerge.add(cb.dataset.id); else checkedForMerge.delete(cb.dataset.id);
            renderContent();
        });
    });

    // Toolbar buttons
    el.querySelector('#sc-generate-btn')?.addEventListener('click', () => generateSnapshot());
    el.querySelector('#sc-new-entry-btn')?.addEventListener('click', () => createManualEntry());
    el.querySelector('#sc-settings-btn')?.addEventListener('click', () => showSettingsModal());
    el.querySelector('#sc-open-settings-btn')?.addEventListener('click', () => showSettingsModal());
    el.querySelector('#sc-trash-btn')?.addEventListener('click', () => showTrashModal());
    el.querySelector('#sc-stats-btn')?.addEventListener('click', () => showStatsModal());
    el.querySelector('#sc-inject-toggle')?.addEventListener('click', () => {
        const next = !isInjectionEnabled();
        setChronicleData({ injectEnabled: next });
        applyInjection();
        renderContent();
        scSetStatus(`Injection ${next ? 'enabled' : 'disabled'}.`, 'success');
    });
    el.querySelector('#sc-preview-injection')?.addEventListener('click', () => showPreviewInjection());
    el.querySelector('#sc-inject-settings')?.addEventListener('click', () => showInjectionSelector());
    el.querySelector('#sc-export-json')?.addEventListener('click', () => exportChronicle());
    el.querySelector('#sc-export-md')?.addEventListener('click', () => exportMarkdown());
    el.querySelector('#sc-import-btn')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => { const file = e.target.files?.[0]; if (file) { const reader = new FileReader(); reader.onload = (ev) => importChronicle(ev.target.result); reader.readAsText(file); } };
        input.click();
    });
    el.querySelector('#sc-consolidate-mode-btn')?.addEventListener('click', () => {
        consolidateMode = !consolidateMode;
        if (consolidateMode) bulkDeleteMode = false;
        checkedForMerge.clear();
        renderContent();
    });
    el.querySelector('#sc-bulk-delete-btn')?.addEventListener('click', () => {
        bulkDeleteMode = !bulkDeleteMode;
        if (bulkDeleteMode) consolidateMode = false;
        checkedForMerge.clear();
        renderContent();
    });
    el.querySelector('#sc-reset-btn')?.addEventListener('click', () => {
        showConfirm('Clear all chronicle data?', 'Everything will be deleted.', () => {
            setChronicleData({ snapshots: [], _deletedBin: [], injectEnabled: false, injectCount: 2, injectDepth: 2 });
            applyInjection();
            renderContent();
            scSetStatus('Chronicle cleared.', 'success');
        });
    });

    // Search
    const searchInput = el.querySelector('#sc-search-input');
    let debounce = null;
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            pendingSearch = e.target.value;
            clearTimeout(debounce);
            debounce = setTimeout(() => renderContent(), 200);
        });
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        modal = parentModal;
        contentEl = null;  // Reset so it re-queries
        renderContent();
    }
    applyInjection();
    console.log('[MWT:Chronicle] Module initialized');
}

export function render() {
    // Return placeholder — init() will call renderContent() once modal is in DOM
    return '<div style="text-align:center;padding:20px;color:var(--mwt-text-dim)">Loading chronicle…</div>';
}

export function getModuleRender() { return render; }
export function getModuleWireEvents() {
    return () => {
        // The modal body is rebuilt (innerHTML) on every open, so the cached
        // content element goes stale and init() only runs once. Re-query and
        // re-render here or the tab stays stuck on the "Loading…" placeholder.
        contentEl = null;
        renderContent();
    };
}
export function getModuleRefreshContent() { return renderContent; }

export async function onMessageReceived() {
    if (isGenerating) return;
    const settings = getSettings();
    if (!settings.autoSnapshot || !hasValidSettings()) return;
    const msgSince = getMessageCountSinceLastSnapshot();
    if (msgSince !== null && msgSince >= settings.autoSnapshotThreshold) {
        console.log(`[MWT:Chronicle] Auto-snapshot at ${msgSince} messages`);
        await generateSnapshot();
        // Notify the user that a snapshot was generated
        try {
            if (typeof toastr !== 'undefined' && toastr?.info) {
                toastr.info('A new chronicle snapshot has been generated and is ready to review.', 'Session Chronicle');
            }
        } catch { /* toastr may not be available */ }
    }
}

export function onChatChanged() {
    isGenerating = false;
    isMainGenerating = false;
    selectedSnapshotId = null;
    consolidateMode = false;
    bulkDeleteMode = false;
    checkedForMerge.clear();
    pendingSearch = '';
    _lastStatusMsg = '';
    _lastStatusLevel = '';
    applyInjection();
}

export function onGenerationStarted() { isMainGenerating = true; }
export function onGenerationStopped() { isMainGenerating = false; }

/**
 * Returns auto-snapshot countdown status for the floating button badge,
 * or null if auto-snapshot is disabled.
 */
export function getAutoSnapshotStatus() {
    const settings = getSettings();
    if (!settings.autoSnapshot) return null;
    const threshold = settings.autoSnapshotThreshold || 40;
    const msgSince = getMessageCountSinceLastSnapshot();
    if (msgSince === null) return { threshold, counter: 0 };
    return { threshold, counter: msgSince };
}
export function getTotalTokens() {
    if (!isInjectionEnabled()) return 0;
    const entries = getEntriesForInjection();
    if (entries.length === 0) return 0;
    const text = entries.map(s => s.text || '').join('\n\n---\n\n');
    const fullInjected = `${CHRONICLE_INJECTION_HEADER}\n\n${text}`;
    return estimateTokens(fullInjected);
}

export function syncGlobalSettings(patch) {
    if (patch?.apiUrl !== undefined || patch?.apiKey !== undefined || patch?.modelName !== undefined) {
        saveSettings({
            ...getSettings(),
            apiUrl: patch.apiUrl ?? getSettings().apiUrl,
            apiKey: patch.apiKey ?? getSettings().apiKey,
            modelName: patch.modelName ?? getSettings().modelName,
            useSTConnection: patch.useSTConnection ?? getSettings().useSTConnection,
        });
        console.log('[MWT:Chronicle] Synced global API settings');
    }
}

/** Slash command: trigger a chronicle snapshot */
export async function triggerSnapshot() {
    return generateSnapshot();
}

/** Slash command / macro: set injection enabled/disabled */
export function setInjectionEnabled(enabled) {
    setChronicleData({ injectEnabled: !!enabled });
    applyInjection();
}

/** Macro: return the full chronicle injection text */
export function getChronicleText() {
    if (!isInjectionEnabled()) return '';
    const entries = getEntriesForInjection();
    if (!entries.length) return '';
    return entries.map(s => s.text || '').join('\n\n---\n\n');
}

/** Macro: return only the most recent chronicle entry */
export function getLastEntryText() {
    const snapshots = getSnapshots();
    if (!snapshots.length) return '';
    const sorted = [...snapshots].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sorted[0]?.text || '';
}
