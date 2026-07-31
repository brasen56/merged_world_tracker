/**
 * story_planner/index.js — Story Planner module (thin orchestrator).
 *
 * Public API: { init, render, applyPlanInjection, onMessageReceived,
 *               onChatChanged, onMessageDeleted, … }
 *
 * Sub-modules:
 *   settings.js   — settings manager and defaults (leaf)
 *   data.js       — shared constants, mutable state, data access (leaf)
 *   prompts.js    — system prompt templates (leaf)
 *   injection.js  — prompt injection logic
 *   generation.js — LLM plan generation
 *   render.js     — UI rendering, event wiring
 */

import { syncSharedConnectionSettings, notify, getChat, getContextSafe } from '../core/index.js';

import { getSettings, saveSettings, hasValidSettings } from './settings.js';
import {
    state, getPlanData, setPlanData,
    getArcs, serializeArcsToText, incrementArcTurns,
    isInjectionEnabled, isAutoEnabled, getAutoInterval,
    persistAutoCounter, resetAutoCounter,
} from './data.js';
import { applyPlanInjection, getInjectedTokenCount } from './injection.js';
import { generatePlan } from './generation.js';
import { renderContent, wireEvents, renderArcs, refreshDisplay } from './render.js';

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        state.modal = parentModal;
        state.contentEl = null;
        renderContent();
    }
    applyPlanInjection();
    console.log('[MWT:StoryPlanner] Module initialized');
}

export function render() {
    // Placeholder — init() / getModuleWireEvents() will call renderContent()
    return '<div style="text-align:center;padding:20px;color:var(--mwt-text-dim)">Loading story planner…</div>';
}

export { applyPlanInjection };

export function getModuleRender() { return render; }
export function getModuleWireEvents() {
    return () => {
        // Modal body is rebuilt on open; re-query + re-render.
        state.contentEl = null;
        renderContent();
        // wireEvents references state.modal and binds via querySelector,
        // so it is safe to call again after re-render.
        wireEvents();
    };
}

// ─── Event hooks ─────────────────────────────────────────────────────────────

export async function onMessageReceived() {
    // Age every active arc's current beat. This runs BEFORE the auto-generate
    // early-return on purpose: beat ages drive the "still waiting after N
    // turns" nudge in the injection, and that has to work whether or not
    // auto-generate is enabled (it is off by default).
    incrementArcTurns();
    if (state.modal) refreshDisplay();

    if (!isAutoEnabled() || !hasValidSettings()) return;

    // Track chat length so onMessageDeleted can compute the number of removed
    // messages during bulk deletes (e.g. "delete above/below").
    state.lastChatLength = getChat()?.length || 0;

    state.autoCounter++;
    persistAutoCounter();

    const interval = getAutoInterval();
    console.log(`[MWT:StoryPlanner] MESSAGE_RECEIVED — counter ${state.autoCounter}/${interval}`);

    if (state.autoCounter < interval) return;

    console.log(`[MWT:StoryPlanner] Auto-generate at ${state.autoCounter} messages`);
    resetAutoCounter();
    // Capture the conditions at schedule time so the deferred closure can
    // detect if Auto was toggled off or the chat changed during the 1.5s delay
    // — otherwise a generatePlan(true) fires against the wrong chat (or after
    // the user disabled auto-generation). Mirrors the chat-key guard in
    // generation.js.
    const ctxBefore = getContextSafe();
    const chatKeyBefore = `${ctxBefore?.characterId ?? ''}|${ctxBefore?.groupId ?? ''}|${ctxBefore?.chatId ?? ''}`;
    try {
        // Delay slightly so ST finishes saving the chat first.
        setTimeout(async () => {
            try {
                if (!isAutoEnabled() || !hasValidSettings()) {
                    console.log('[MWT:StoryPlanner] Deferred auto-generate aborted — Auto disabled or API unset.');
                    return;
                }
                const ctxAtRun = getContextSafe();
                const chatKeyAtRun = `${ctxAtRun?.characterId ?? ''}|${ctxAtRun?.groupId ?? ''}|${ctxAtRun?.chatId ?? ''}`;
                if (chatKeyAtRun !== chatKeyBefore) {
                    console.log('[MWT:StoryPlanner] Deferred auto-generate aborted — chat changed during delay.');
                    return;
                }
                const arcs = await generatePlan(true);
                if (arcs) {
                    // Refresh the arc list if the modal is open. renderArcs()
                    // swaps only the #sp-arcs innerHTML, so the delegated
                    // listeners and any open <details> elsewhere survive.
                    if (state.modal) renderArcs();
                    notify('Story Planner', `Auto-generated a new story plan (${arcs.length} arcs).`, 'info');
                }
            } catch (err) {
                console.warn('[MWT:StoryPlanner] Auto-generate failed:', err.message);
            }
        }, 1500);
    } catch (err) {
        console.warn('[MWT:StoryPlanner] Auto-generate scheduling failed:', err.message);
    }
}

export function onChatChanged() {
    // NOTE: do NOT unconditionally clear state.isGenerating here. A generation
    // in flight for the *previous* chat self-clears in its own finally; forcing
    // the flag false here lets a second generation start concurrently against
    // the new chat (double API calls, interleaved busy notifications). The
    // generate path also discards cross-chat results, so leaving the flag is
    // safe.
    // Restore the per-chat auto counter (each chat tracks its own progress)
    const saved = getPlanData()?.autoCounter;
    state.autoCounter = (typeof saved === 'number' && Number.isFinite(saved)) ? saved : 0;
    persistAutoCounter();
    // Track chat length for bulk-delete counter adjustment
    state.lastChatLength = getChat()?.length || 0;
    applyPlanInjection();
    console.log('[MWT:StoryPlanner] Chat changed — state reset.');
}

// ─── Delete awareness ────────────────────────────────────────────────────────

/**
 * A message (or messages) was deleted. Decrement the auto counter so the
 * "every N messages" cadence stays aligned with the shorter chat.
 *
 * @param {number} deletedIndex - chat-array index of the removed message
 */
export function onMessageDeleted(deletedIndex) {
    if (!isAutoEnabled()) return;
    if (typeof deletedIndex !== 'number') return;

    // SillyTavern fires a single MESSAGE_DELETED event for bulk deletes
    // ("delete above/below"), so compute the actual number removed by comparing
    // against the cached chat length. Falls back to 1 for single deletes.
    const currentLen = getChat()?.length || 0;
    const removed = state.lastChatLength > currentLen
        ? state.lastChatLength - currentLen
        : 1;
    state.lastChatLength = currentLen;

    if (state.autoCounter > 0) {
        state.autoCounter = Math.max(0, state.autoCounter - removed);
        persistAutoCounter();
        console.log(`[MWT:StoryPlanner] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed}) — counter adjusted to ${state.autoCounter}`);
    }
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function isGenerating() {
    return state.isGenerating;
}

export function getTotalTokens() {
    return getInjectedTokenCount();
}

export function getAutoPlanStatus() {
    if (!isAutoEnabled()) return null;
    return {
        counter: state.autoCounter,
        interval: getAutoInterval(),
    };
}

export function syncGlobalSettings(patch) {
    return syncSharedConnectionSettings(getSettings, saveSettings, patch, '[MWT:StoryPlanner]');
}

// ─── Slash commands / macros ─────────────────────────────────────────────────

export async function triggerGenerate() {
    return generatePlan(false);
}

export function setInjectionEnabled(enabled) {
    setPlanData({ injectEnabled: !!enabled });
    applyPlanInjection();
}

/**
 * Text for the `{{storyplan}}` macro.
 *
 * Deliberately NOT filtered by the injection mode: that selector governs the
 * automatic injection, whereas the macro is the user placing the plan by hand.
 * Dropped arcs are excluded regardless — dropping one means "stop showing me
 * this". core/ui.js also uses this as the "does a plan exist" check that drives
 * the floating button's state.
 */
export function getPlanTextForMacro() {
    if (!isInjectionEnabled()) return '';
    return serializeArcsToText(getArcs().filter(a => a.status !== 'dropped'));
}