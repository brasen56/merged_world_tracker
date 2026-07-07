/**
 * chronicle/index.js — Session Chronicle module (thin orchestrator).
 *
 * Public API: { init, render, onMessageReceived, onChatChanged,
 *               onGenerationStarted, onGenerationStopped }
 *
 * Re-exports additional helpers used by root index.js for slash commands,
 * macros, and the floating button bar.
 *
 * Sub-modules:
 *   data.js          — constants, state, settings, data access, helpers
 *   prompts.js       — prompt templates
 *   injection.js     — prompt injection logic
 *   snapshots.js     — generation, validation, CRUD, world state sync
 *   import-export.js — export/import
 *   render.js        — all UI rendering
 */

import {
    syncSharedConnectionSettings, estimateTokens, notify, getChat, getContextSafe,
} from '../core/index.js';

import {
    state, _render,
    getSettings, saveSettings, hasValidSettings,
    getChronicleData, setChronicleData, getSnapshots,
    persistMsgSinceSnapshot,
    isAnchorStale,
} from './data.js';

import { CHRONICLE_INJECTION_HEADER } from './prompts.js';

import {
    isInjectionEnabled, getEntriesForInjection, applyInjection,
} from './injection.js';

import { generateSnapshot } from './snapshots.js';

import { renderContent, showRegenerateDiff, showConsolidationPreview } from './render.js';

// ─── Wire late-binding render registry ───────────────────────────────────────
// This allows data.js and snapshots.js to call render functions without
// creating circular imports (data → render → data).

_render.renderContent = renderContent;
_render.showRegenerateDiff = showRegenerateDiff;
_render.showConsolidationPreview = showConsolidationPreview;

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        state.modal = parentModal;
        state.contentEl = null;  // Reset so it re-queries
        renderContent();
    }
    applyInjection();
    console.log('[MWT:Chronicle] Module initialized');
}

export function render() {
    // Return placeholder — init() will call renderContent() once modal is in DOM
    return '<div style="text-align:center;padding:20px;color:var(--mwt-text-dim)">Loading chronicle…</div>';
}

export { applyInjection };

export function getModuleRender() { return render; }
export function getModuleWireEvents() {
    return () => {
        // The modal body is rebuilt (innerHTML) on every open, so the cached
        // content element goes stale and init() only runs once. Re-query and
        // re-render here or the tab stays stuck on the "Loading…" placeholder.
        state.contentEl = null;
        renderContent();
    };
}

export async function onMessageReceived() {
    if (state.isGenerating) return;

    // Track chat length so onMessageDeleted can compute the number of removed
    // messages during bulk deletes (e.g. "delete above/below").
    state.lastChatLength = getChat()?.length || 0;

    state.msgSinceSnapshot++;
    persistMsgSinceSnapshot();

    const settings = getSettings();
    const threshold = settings.autoSnapshotThreshold || 40;

    console.log(`[MWT:Chronicle] MESSAGE_RECEIVED — counter ${state.msgSinceSnapshot}/${threshold}`);

    if (!settings.autoSnapshot || !hasValidSettings() || state.msgSinceSnapshot < threshold) {
        return;
    }

    console.log(`[MWT:Chronicle] Auto-snapshot at ${state.msgSinceSnapshot} messages`);
    // Capture chat identity so the failure-reset below can tell a genuine
    // failure apart from a mid-generation chat switch.
    const ctxBefore = getContextSafe();
    const chatKeyBefore = `${ctxBefore?.characterId ?? ''}|${ctxBefore?.groupId ?? ''}|${ctxBefore?.chatId ?? ''}`;
    const snapshot = await generateSnapshot();
    // On failure, reset the counter (success resets inside generateSnapshot).
    // Without this, a persistent failure (API down, empty output) left the
    // counter at ≥ threshold, causing every subsequent MESSAGE_RECEIVED to
    // immediately re-trigger an API call — a retry storm that flooded the
    // endpoint. BUT: if the null result is because the user switched chats
    // mid-generation, onChatChanged has already restored the *new* chat's
    // counter — resetting here would wipe it and persist 0 into the wrong
    // chat's metadata, so only reset when we're still on the same chat.
    if (!snapshot) {
        const ctxAfter = getContextSafe();
        const chatKeyAfter = `${ctxAfter?.characterId ?? ''}|${ctxAfter?.groupId ?? ''}|${ctxAfter?.chatId ?? ''}`;
        if (chatKeyAfter === chatKeyBefore) {
            state.msgSinceSnapshot = 0;
            persistMsgSinceSnapshot();
        }
    }
    // Only notify on success — generateSnapshot returns null on failure and
    // already shows its own error status/notification in that case.
    if (snapshot) {
        notify('Session Chronicle', 'A new chronicle snapshot has been generated and is ready to review.', 'info');
    }
}

export function onChatChanged() {
    state.isGenerating = false;
    state.isMainGenerating = false;
    state.selectedSnapshotId = null;
    state.consolidateMode = false;
    state.consolidateBaseId = null;
    state.bulkDeleteMode = false;
    state.checkedForMerge.clear();
    state.pendingSearch = '';
    state._lastStatusMsg = '';
    state._lastStatusLevel = '';
    // Restore counter from the incoming chat's metadata instead of zeroing,
    // so the counter survives chat switches and reloads.
    const saved = getChronicleData()?.msgSinceSnapshot;
    state.msgSinceSnapshot = (typeof saved === 'number' && Number.isFinite(saved)) ? saved : 0;
    persistMsgSinceSnapshot();
    // Track chat length for bulk-delete counter adjustment
    state.lastChatLength = getChat()?.length || 0;
    applyInjection();
    console.log('[MWT:Chronicle] Chat changed — state reset.');
}

// ─── Swipe / edit / delete awareness ─────────────────────────────────────────
// Keep the auto-snapshot counter and anchor in sync when the user mutates the
// chat history, so tracking doesn't drift after edits/deletes/swipes.

/**
 * A message was deleted. Decrement `msgSinceSnapshot` to reflect the shorter
 * chat, and invalidate the chronicle anchor if it pointed at or after the
 * deleted message.
 *
 * @param {number} deletedIndex - The chat-array index of the removed message.
 */
export function onMessageDeleted(deletedIndex) {
    if (typeof deletedIndex !== 'number') return;

    // SillyTavern fires a single MESSAGE_DELETED event for bulk deletes
    // ("delete above/below"), so compute the actual number removed by comparing
    // against the cached chat length. Falls back to 1 for single deletes.
    const currentLen = getChat()?.length || 0;
    const removed = state.lastChatLength > currentLen
        ? state.lastChatLength - currentLen
        : 1;
    state.lastChatLength = currentLen;

    if (state.msgSinceSnapshot > 0) {
        state.msgSinceSnapshot = Math.max(0, state.msgSinceSnapshot - removed);
        persistMsgSinceSnapshot();
        console.log(`[MWT:Chronicle] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed}) — counter adjusted to ${state.msgSinceSnapshot}`);
    }
    // If the anchor referenced the deleted message (or something after it),
    // mark it stale so the next snapshot re-anchors against the live chat.
    const data = getChronicleData();
    if (data.lastAnchor && typeof data.lastAnchor.msgIndex === 'number') {
        if (data.lastAnchor.msgIndex >= deletedIndex) {
            setChronicleData({ anchorStale: true });
            console.log('[MWT:Chronicle] lastAnchor invalidated by delete — flagged stale.');
        }
    }
    // Force the message-count badge to refresh
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
}

/**
 * A message was swiped (its content replaced with an alternate generation).
 * The auto-snapshot counter does not need adjustment (chat length is unchanged),
 * but if the swiped message is the chronicle anchor, its content fingerprint
 * no longer matches, so flag staleness.
 *
 * @param {number} swipedIndex - The chat-array index of the swiped message.
 */
export function onMessageSwiped(swipedIndex) {
    const data = getChronicleData();
    if (isAnchorStale(data.lastAnchor)) {
        setChronicleData({ anchorStale: true });
        console.log(`[MWT:Chronicle] MESSAGE_SWIPED at index ${swipedIndex} — anchor flagged stale.`);
    }
}

/**
 * A message was edited. Similar to swipe: if the edited message is the
 * chronicle anchor (or the anchor is otherwise unresolvable), flag it stale
 * so the user is aware the chronicle may be out of sync.
 *
 * @param {number} editedIndex - The chat-array index of the edited message.
 */
export function onMessageEdited(editedIndex) {
    const data = getChronicleData();
    if (isAnchorStale(data.lastAnchor)) {
        setChronicleData({ anchorStale: true });
        console.log(`[MWT:Chronicle] MESSAGE_EDITED at index ${editedIndex} — anchor flagged stale.`);
    }
}

export function onGenerationStarted() { state.isMainGenerating = true; }
export function onGenerationStopped() { state.isMainGenerating = false; }

/**
 * Returns auto-snapshot countdown status for the floating button badge,
 * or null if auto-snapshot is disabled.
 */
export function getAutoSnapshotStatus() {
    const settings = getSettings();
    if (!settings.autoSnapshot) return null;
    const threshold = settings.autoSnapshotThreshold || 40;
    return { threshold, counter: state.msgSinceSnapshot };
}

/** Returns true if a snapshot is currently being generated */
export function isGeneratingSnapshot() {
    return state.isGenerating;
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
    return syncSharedConnectionSettings(getSettings, saveSettings, patch, '[MWT:Chronicle]');
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