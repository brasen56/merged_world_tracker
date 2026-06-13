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

// ─── Mutable shared state ────────────────────────────────────────────────────

export const state = {
    wstIsRefreshing: false,
    autoRefreshCounter: 0,
    autoRefreshQueued: false,
    autoSaveLastText: '',
    autoSaveTimer: null,
    autoRefreshDeferTimer: null,
    isDirty: false,
    modal: null,
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