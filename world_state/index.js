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

// ─── Swipe / edit / delete awareness ─────────────────────────────────────────
// Keep the auto-refresh counter accurate when the user mutates chat history.
// NOTE: swipe/edit intentionally do NOT re-trigger a refresh — only the
// counter (delete) is adjusted, so editing/deleting messages never kicks off
// an unsolicited world-state generation.

/**
 * A message was deleted. Decrement the auto-refresh counter so the countdown
 * to the next refresh stays aligned with the (now shorter) chat.
 *
 * @param {number} deletedIndex - The chat-array index of the removed message.
 */
export function onMessageDeleted(deletedIndex) {
    if (!isAutoRefreshEnabled()) return;
    if (typeof deletedIndex !== 'number') return;
    if (state.autoRefreshCounter > 0) {
        state.autoRefreshCounter = Math.max(0, state.autoRefreshCounter - 1);
        persistAutoRefreshCounter();
        console.log(`[MWT:WorldState] MESSAGE_DELETED at index ${deletedIndex} — counter adjusted to ${state.autoRefreshCounter}`);
    }
    // Refresh the floating button countdown badge
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
}

/**
 * A message was swiped (its content replaced with an alternate generation).
 * Awareness only — no counter adjustment (chat length is unchanged) and no
 * refresh is scheduled. Editing/swiping never starts an unsolicited
 * world-state generation; the next scheduled auto-refresh will pick up any
 * content changes naturally.
 *
 * @param {number} swipedIndex - The chat-array index of the swiped message.
 */
export function onMessageSwiped(swipedIndex) {
    // Awareness only — do NOT re-trigger a refresh on swipe, so editing/
    // swiping messages never starts an unsolicited generation.
    console.log(`[MWT:WorldState] MESSAGE_SWIPED at index ${swipedIndex} — no refresh (counter awareness only).`);
}

/**
 * A message was edited. Awareness only — no counter adjustment and no
 * refresh is scheduled. Editing/swiping never starts an unsolicited
 * world-state generation; the next scheduled auto-refresh will pick up any
 * content changes naturally.
 *
 * @param {number} editedIndex - The chat-array index of the edited message.
 */
export function onMessageEdited(editedIndex) {
    // Awareness only — do NOT re-trigger a refresh on edit, so editing
    // messages never starts an unsolicited generation.
    console.log(`[MWT:WorldState] MESSAGE_EDITED at index ${editedIndex} — no refresh (counter awareness only).`);
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