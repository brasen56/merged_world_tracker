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
    syncSharedConnectionSettings, estimateTokens, notify,
} from '../core/index.js';

import {
    state, _render,
    getSettings, saveSettings, hasValidSettings,
    getChronicleData, setChronicleData, getSnapshots,
    persistMsgSinceSnapshot,
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
    const settings = getSettings();
    if (!settings.autoSnapshot || !hasValidSettings()) return;

    state.msgSinceSnapshot++;
    const threshold = settings.autoSnapshotThreshold || 40;

    console.log(`[MWT:Chronicle] MESSAGE_RECEIVED — counter ${state.msgSinceSnapshot}/${threshold}`);

    if (state.msgSinceSnapshot < threshold) { persistMsgSinceSnapshot(); return; }

    console.log(`[MWT:Chronicle] Auto-snapshot at ${state.msgSinceSnapshot} messages`);
    await generateSnapshot();
    // Notify the user that a snapshot was generated
    notify('Session Chronicle', 'A new chronicle snapshot has been generated and is ready to review.', 'info');
}

export function onChatChanged() {
    state.isGenerating = false;
    state.isMainGenerating = false;
    state.selectedSnapshotId = null;
    state.consolidateMode = false;
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
    applyInjection();
    console.log('[MWT:Chronicle] Chat changed — state reset.');
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