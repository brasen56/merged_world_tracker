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

import { syncSharedConnectionSettings, estimateTokens, getChat, getOrCreateReceiptIdentity } from '../core/index.js';

import { getSettings, saveSettings } from './settings.js';
import {
    state, getWorldStateData, getWorldStateText,
    persistAutoRefreshCounter, resetAutoRefreshCounter,
    isAutoRefreshEnabled, getAutoRefreshInterval,
    setProvenance,
    setWorldSetting,
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
    // Drop any pending editor-persist so edits typed against the previous chat
    // are not written into the newly-loaded one (editor.value still shows the
    // old text until renderModalContent runs).
    if (state.editorPersistTimer) { clearTimeout(state.editorPersistTimer); state.editorPersistTimer = null; }
    state.editSessionActive = false;
    const saved = getWorldStateData()?.autoRefreshCounter;
    state.autoRefreshCounter = (typeof saved === 'number' && Number.isFinite(saved)) ? saved : 0;
    state.countedReceiptEvents = new Map((Array.isArray(getWorldStateData()?.countedReceiptEvents) ? getWorldStateData().countedReceiptEvents : [])
        .filter(([key, count]) => typeof key === 'string' && key && Number.isInteger(count) && count > 0));
    persistAutoRefreshCounter();
    // Track chat length for bulk-delete counter adjustment
    const chat = getChat() || [];
    state.lastChatLength = chat.length;
    applyWorldStateInjection();
    console.log('[MWT:WorldState] Chat changed — state reset.');
}

/**
 * The scope-INDEPENDENT half of onChatChanged(), run by index.js's
 * CHAT_CHANGED handler while the worldState store is paused for this chat
 * (Part 6 §7.4/§5.4). The full handler is skipped because its hydration would
 * restore counters and bookkeeping from the BLOCKED store value, but skipping
 * it entirely used to leave the previous chat's cleanup undone: the old
 * injection stayed registered in the new chat, and pending refresh/editor
 * timers kept running against it. This path performs exactly that cleanup
 * without one read of the blocked store — the applier's paused branch clears
 * the slot, and the flags/timers below are module-internal state.
 */
export function onChatChangedWhilePaused() {
    state.isDirty = false;
    state.autoRefreshQueued = false;
    if (state.autoRefreshDeferTimer) { clearTimeout(state.autoRefreshDeferTimer); state.autoRefreshDeferTimer = null; }
    // Drop any pending editor-persist so edits typed against the previous chat
    // are not written into the newly-loaded one (same rule as onChatChanged).
    if (state.editorPersistTimer) { clearTimeout(state.editorPersistTimer); state.editorPersistTimer = null; }
    state.editSessionActive = false;
    // The paused branch of the applier clears the previous chat's injection.
    applyWorldStateInjection();
    console.log('[MWT:WorldState] Chat changed while paused — injection cleared, timers cancelled (store hydration skipped).');
}

// ─── Swipe / edit / delete awareness ─────────────────────────────────────────
// Keep the auto-refresh counter accurate when the user mutates chat history.
// NOTE: swipe/edit intentionally do NOT re-trigger a refresh — only the
// counter (delete) is adjusted, so editing/deleting messages never kicks off
// an unsolicited world-state generation.

/**
 * A message was deleted. Decrement the auto-refresh counter so the countdown
 * to the next refresh stays aligned with the (now shorter) chat, and invalidate
 * provenance (WORLD-STATE-05).
 *
 * @param {number} deletedIndex - The chat-array index of the removed message.
 * @param {{ adjustCounters?: boolean }} [opts] - When false (panic switch on),
 *   the counter decrement is skipped but bookkeeping + integrity still run.
 */
export function onMessageDeleted(deletedIndex, { adjustCounters = true } = {}) {
    if (typeof deletedIndex !== 'number') return;

    // SillyTavern fires a single MESSAGE_DELETED event for bulk deletes
    // ("delete above/below"), so compute the actual number removed by comparing
    // against the cached chat length. Falls back to 1 for single deletes.
    const currentLen = getChat()?.length || 0;
    const removed = state.lastChatLength > currentLen
        ? state.lastChatLength - currentLen
        : 1;
    const liveReceiptKeys = new Set((getChat() || []).filter(msg => msg && !msg.is_user && !msg.is_system).map(getReceiptIdentity));
    let removedReceipts = 0;
    let provenanceChanged = false;
    for (const [key, count] of state.countedReceiptEvents) {
        if (!liveReceiptKeys.has(key)) {
            removedReceipts += count;
            state.countedReceiptEvents.delete(key);
            provenanceChanged = true;
        }
    }
    // Bookkeeping — ALWAYS live. If this freezes during a panic window the real
    // chat keeps shrinking while lastChatLength stays put, so the first
    // post-panic delete computes a lumped `removed` and the drift is magnified
    // instead of avoided.
    state.lastChatLength = currentLen;

    if (adjustCounters && isAutoRefreshEnabled() && state.autoRefreshCounter > 0) {
        state.autoRefreshCounter = Math.max(0, state.autoRefreshCounter - removedReceipts);
        persistAutoRefreshCounter();
        console.log(`[MWT:WorldState] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed} entries / ${removedReceipts} receipts) — counter adjusted to ${state.autoRefreshCounter}`);
    }
    else if (provenanceChanged) persistAutoRefreshCounter();

    // WORLD-STATE-05: Provenance `lastTouchedMsg` is a chat-array index. A
    // deletion before a tracked mention shifts everything left, so stored
    // indices now point at the wrong message — entries look older than they
    // are and get quarantined/removed early by the expiry pass. This integrity
    // work runs ALWAYS — even when auto-refresh is off or the panic switch is
    // on — otherwise stale-index expiry bugs reopen inside those windows.
    if (removed > 0) {
        try {
            setProvenance({ entities: {}, lastBuiltAtMsgIndex: 0, schemaVersion: 1 });
            console.log('[MWT:WorldState] Provenance invalidated by message deletion — will rebuild on next refresh.');
        } catch (err) {
            console.warn('[MWT:WorldState] Could not invalidate provenance after delete:', err?.message || err);
        }
    }

    // Refresh the floating button countdown badge
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
}

function getReceiptIdentity(message) {
    return getOrCreateReceiptIdentity(message);
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
    setWorldSetting('injectEnabled', !!enabled);
    applyWorldStateInjection();
}