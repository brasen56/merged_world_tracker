/**
 * knowledge/state.js — Shared constants and mutable state for the Knowledge module.
 *
 * All sub-modules import from here to read/write shared runtime state.
 * Constants that are used across multiple sub-files live here too.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const SETTINGS_KEY = 'mwt_knowledge';
export const LOREBOOK_NAME = 'Knowledge Tracker';
export const STATE_LOREBOOK_NAME = 'State Tracker';
export const TRACKER_SENTINEL = '[Tracker]';
export const REGISTRY_KEY = 'knowledge_tracker_registry';
export const STATE_REGISTRY_KEY = 'state_tracker_registry';
export const RELATIONSHIP_KEY = 'knowledge_tracker_relationships';
export const HISTORY_KEY_PREFIX = 'kt_history_';
export const RELATIONSHIP_TYPES = [
    'ally', 'enemy', 'neutral', 'friend', 'rival', 'family', 'lover',
    'subordinate', 'superior', 'acquaintance', 'mentor', 'student',
    'employer', 'employee',
];

export const RELATIONSHIP_BLOCK_START = '<!-- mwt:relationships:start -->';
export const RELATIONSHIP_BLOCK_END = '<!-- mwt:relationships:end -->';

// ─── Shared mutable state ────────────────────────────────────────────────────

export const state = {
    /** @type {HTMLElement|null} Parent modal element */
    modal: null,
    /** @type {HTMLElement|null} Cached knowledge-tab content element */
    npcsContentEl: null,
    /** @type {HTMLElement|null} Cached state content element (same as npcsContentEl after merge) */
    stateContentEl: null,

    /** Active sub-tab: 'staging' | 'minor' | 'major' | 'state' | 'relationships' */
    activeSubTab: 'staging',
    /** Relationship sub-tab view mode: 'graph' | 'list' */
    relViewMode: 'graph',
    /** Cached graph layout data for drag interactions */
    _graphData: null,
    /** Current staging proposals */
    stagingItems: [],
    /** ID of the currently selected staging item */
    activeItemId: null,
    /** Set of NPC names selected as major */
    selectedMajorNpcs: new Set(),

    // ── Notification panel state ──
    notificationEntries: {},
    notifActiveId: null,

    // ── Runtime state ──
    messageCounter: 0,
    isRunning: false,
    trackerQueue: Promise.resolve(),

    // ── Token tracking ──
    _cachedTokenCount: 0,
    _refreshingTokens: false,

    // ── Status persistence ──
    _lastKtStatusMsg: '',
    _lastKtStatusLevel: '',

    // ── World-info script reference (loaded in lorebook.js) ──
    wiScript: null,
};

// ─── Content helpers (used by settings.js and render.js) ─────────────────────

export function getNpcsContentEl() {
    if (state.npcsContentEl) return state.npcsContentEl;
    if (!state.modal) return null;
    state.npcsContentEl = state.modal.querySelector('.mwt-tab-content[data-tab="knowledge"]')
        ?? state.modal.querySelector('#mwt-kt-npcs-content')?.closest('.mwt-tab-content');
    return state.npcsContentEl;
}

export function getStateContentEl() {
    return getNpcsContentEl();
}

export function ktSetStatus(text, type = 'info') {
    state._lastKtStatusMsg = text || '';
    state._lastKtStatusLevel = type || 'info';
    const el = getNpcsContentEl();
    if (!el) return;
    const statusEl = el.querySelector('#kt-status');
    if (statusEl) {
        statusEl.textContent = state._lastKtStatusMsg;
        statusEl.className = `kt-status kt-status--${state._lastKtStatusLevel}`;
    }
}
