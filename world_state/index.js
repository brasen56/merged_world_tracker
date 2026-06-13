/**
 * world_state/index.js — World State Tracker module (thin orchestrator).
 *
 * Public API:  { init, render, getWorldStateText, applyInjection,
 *                onMessageReceived, onChatChanged, … }
 *
 * Sub-modules:
 *   settings.js  — settings manager and defaults (leaf)
 *   data.js      — shared constants, mutable state, data access (leaf)
 *   prompts.js   — system prompt templates (leaf)
 *   injection.js — prompt injection logic
 *   refresh.js   — full refresh, auto-refresh scheduling, auto-save timer
 *   sections.js  — per-section regeneration
 *   render.js    — UI rendering, event wiring, archive/import/clear, revert/diff
 */

import { syncSharedConnectionSettings, estimateTokens } from '../core/index.js';

import { getSettings, saveSettings } from './settings.js';
import {
    state, getWorldStateData, getWorldStateText, setWorldStateData,
    persistAutoRefreshCounter, resetAutoRefreshCounter,
    isAutoRefreshEnabled, getAutoRefreshInterval,
} from './data.js';
import {
    WORLD_STATE_INJECTION_HEADER, applyWorldStateInjection,
} from './injection.js';
import {
    refreshWorldState, onMessageReceived, restartAutoSaveTimer,
} from './refresh.js';
import { render, wireEvents } from './render.js';

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(parentModal) {
    state.modal = parentModal;
    applyWorldStateInjection();
    restartAutoSaveTimer();
    console.log('[MWT:WorldState] Module initialized');
}

export function getModuleRender() { return render; }
export function getModuleWireEvents() { return wireEvents; }

export { getWorldStateText, applyWorldStateInjection, onMessageReceived, resetAutoRefreshCounter };

export function onChatChanged() {
    state.isDirty = false;
    state.autoSaveLastText = getWorldStateText();
    state.autoRefreshQueued = false;
    if (state.autoRefreshDeferTimer) { clearTimeout(state.autoRefreshDeferTimer); state.autoRefreshDeferTimer = null; }
    const saved = getWorldStateData()?.autoRefreshCounter;
    state.autoRefreshCounter = (typeof saved === 'number' && Number.isFinite(saved)) ? saved : 0;
    persistAutoRefreshCounter();
    applyWorldStateInjection();
    console.log('[MWT:WorldState] Chat changed — state reset.');
}

/** Returns true if world state is currently refreshing */
export function isRefreshing() {
    return state.wstIsRefreshing;
}

/** Returns estimated token count for the currently injected world state text */
export function getTotalTokens() {
    const text = getWorldStateText();
    if (!text) return 0;
    const fullInjected = `${WORLD_STATE_INJECTION_HEADER}\n\n${text}`;
    return estimateTokens(fullInjected);
}

/** Returns true if the world state editor has unsaved changes */
export function isWorldStateDirty() {
    return state.isDirty;
}

/** Returns auto-refresh status for external display (floating button countdown) */
export function getAutoRefreshStatus() {
    if (!isAutoRefreshEnabled()) return null;
    return {
        counter: state.autoRefreshCounter,
        interval: getAutoRefreshInterval(),
    };
}

export function syncGlobalSettings(patch) {
    return syncSharedConnectionSettings(getSettings, saveSettings, patch, '[MWT:WorldState]');
}

/** Slash command: trigger a world state refresh */
export async function triggerRefresh() {
    const text = await refreshWorldState();
    return text;
}

/** Slash command / macro: set injection enabled/disabled */
export function setInjectionEnabled(enabled) {
    setWorldStateData({ injectEnabled: !!enabled });
    applyWorldStateInjection();
}