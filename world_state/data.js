/**
 * world_state/data.js — Shared constants, mutable state, and data access.
 *
 * Leaf module — no imports from other world_state modules.
 */

import {
    getChatMeta, patchChatMeta, escapeRegex,
} from '../core/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const CHAT_DATA_KEY = 'world_state_tracker_metadata';

export const SECTIONS = [
    'Current Scene',
    'Recent Changes',
    'Off-Screen',
    'Pending',
    'Active Threads',
    'Unresolved Threads',
    'World Pressures',
    'Key Character States',
    'Story Momentum',
    'Plot Seeds',
    'Potential Entrances',
];

export const VARIETY_LABELS = {
    1: 'Conservative',
    2: 'Balanced',
    3: 'Varied',
    4: 'Wild',
    5: 'Chaotic',
};

// Lookahead marking where the CURRENT "## Section" block ends and the next one
// begins. Used when extracting/replacing or injecting a single section.
const NEXT_SECTION_LOOKAHEAD_SRC =
    '(?=\\s*\\n#{1,6}[ \\t]' +
    `|\\s*\\n[ \\t]*(?:#{1,6}[ \\t]+)?\\*{0,2}(?:${SECTIONS.map(escapeRegex).join('|')})\\*{0,2}[ \\t]*(?:\\n|$)` +
    '|\\s*$)';

/** Frozen string — safe to import and use in any RegExp constructor. */
export const NEXT_SECTION_LOOKAHEAD = NEXT_SECTION_LOOKAHEAD_SRC;

// ─── Section extraction / replacement ────────────────────────────────────────
// Lives here (not sections.js) so provenance.js can reuse it without a
// circular import (sections.js already imports provenance.js).

// `\b` requires a word char on (at least) one side of the boundary, which
// silently fails to match right after a section name ending in punctuation
// (e.g. "Archive (Stale)" ends in ")"). A negative lookahead for "still part
// of a longer word" works for both word- and punctuation-ending names.
const SECTION_NAME_BOUNDARY = '(?![A-Za-z0-9_])';

/**
 * Pull out exactly one "## Section\n...body..." block from a larger text.
 * Stops at the next "## " header or end of text.
 */
export function extractOnlySection(text, sectionName) {
    const escaped = escapeRegex(sectionName);
    const pattern = new RegExp(`(## ${escaped}${SECTION_NAME_BOUNDARY}[\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`);
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
}

/**
 * Replace one "## Section" block in the document with newContent.
 * If the section doesn't already exist, append it.
 */
export function replaceSection(text, sectionName, newContent) {
    const escaped = escapeRegex(sectionName);
    const pattern = new RegExp(`## ${escaped}${SECTION_NAME_BOUNDARY}[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`);
    const trimmed = newContent.trim();
    if (pattern.test(text)) {
        return text.replace(pattern, () => trimmed);
    }
    return (text.trim() + '\n\n' + trimmed).trim();
}

// ─── Mutable shared state ────────────────────────────────────────────────────

export const state = {
    wstIsRefreshing: false,
    autoRefreshCounter: 0,
    autoRefreshQueued: false,
    autoSaveLastText: '',
    autoSaveTimer: null,
    /** Debounce timer that persists live editor edits to metadata (see render.js). */
    editorPersistTimer: null,
    /** True once the current editing burst has snapshotted its baseline to
     *  history. Reset by any canonical state change (save/refresh/import/…) so
     *  the next burst snapshots again. */
    editSessionActive: false,
    autoRefreshDeferTimer: null,
    isDirty: false,
    modal: null,
    /** Last observed chat length, used by onMessageDeleted to compute how many
     *  messages were removed during bulk deletes (e.g. "delete above/below"). */
    lastChatLength: 0,
};

// ─── Chat data helpers ───────────────────────────────────────────────────────

export function getWorldStateData() {
    const meta = getChatMeta();
    return meta?.[CHAT_DATA_KEY] || {};
}

export function setWorldStateData(patch) {
    patchChatMeta(CHAT_DATA_KEY, patch);
}

export function getWorldStateText() {
    return getWorldStateData().text || '';
}

// ─── History (auto-save snapshots) ──────────────────────────────────────────

export function getAutoSaveHistory() {
    return getWorldStateData().autoSaveHistory || [];
}

export function pushToHistory(text) {
    if (!text?.trim()) return;
    const history = getAutoSaveHistory();
    history.push({ text, timestamp: Date.now() });
    if (history.length > 50) history.splice(0, history.length - 50);
    setWorldStateData({ autoSaveHistory: history });
}

export function pushAutoSave(text) {
    if (text === state.autoSaveLastText) return;
    pushToHistory(text);
    state.autoSaveLastText = text;
}

// ─── Auto-refresh data queries ──────────────────────────────────────────────

export function isAutoRefreshEnabled() {
    return getWorldStateData().autoRefresh === true;
}

export function getAutoRefreshInterval() {
    return getWorldStateData().autoRefreshInterval || 5;
}

export function persistAutoRefreshCounter() {
    setWorldStateData({ autoRefreshCounter: state.autoRefreshCounter });
}

export function resetAutoRefreshCounter() {
    state.autoRefreshCounter = 0;
    persistAutoRefreshCounter();
}

// ─── Injection flags ─────────────────────────────────────────────────────────

export function isInjectionEnabled() {
    return getWorldStateData().injectEnabled !== false;
}

// ─── Scan helpers ────────────────────────────────────────────────────────────

export function getMaxScanMessages(settings) {
    const raw = settings.maxScanMessages;
    if (!raw || isNaN(raw)) return 20;
    return Math.min(Math.max(1, Math.round(raw)), 30);
}

// ─── Provenance (see STALE_ENTRY_EXPIRY_DESIGN.md) ──────────────────────────
// Read-only tracking of when each entity was last mentioned. Phase 1 only:
// building + querying. Nothing currently mutates world-state text based on
// this data (no expiry, no grounding gate — see the design doc for those).

const EMPTY_PROVENANCE = Object.freeze({ entities: {}, lastBuiltAtMsgIndex: 0, schemaVersion: 1 });

export function getProvenance() {
    return getWorldStateData().provenance || EMPTY_PROVENANCE;
}

export function setProvenance(provenance) {
    setWorldStateData({ provenance });
}