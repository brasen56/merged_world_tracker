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

import { syncSharedConnectionSettings, notify } from '../core/index.js';

import { getSettings, saveSettings, hasValidSettings } from './settings.js';
import {
    state, getPlanData, setPlanData, getPlanText,
    isInjectionEnabled, isAutoEnabled, getAutoInterval,
    persistAutoCounter, resetAutoCounter,
} from './data.js';
import { STORY_PLAN_INJECTION_HEADER, applyPlanInjection, getInjectedTokenCount } from './injection.js';
import { generatePlan } from './generation.js';
import { renderContent, wireEvents } from './render.js';

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
    if (!isAutoEnabled() || !hasValidSettings()) return;

    state.autoCounter++;
    persistAutoCounter();

    const interval = getAutoInterval();
    console.log(`[MWT:StoryPlanner] MESSAGE_RECEIVED — counter ${state.autoCounter}/${interval}`);

    if (state.autoCounter < interval) return;

    console.log(`[MWT:StoryPlanner] Auto-generate at ${state.autoCounter} messages`);
    resetAutoCounter();
    try {
        // Delay slightly so ST finishes saving the chat first.
        setTimeout(async () => {
            try {
                const text = await generatePlan(true);
                if (text) {
                    // Refresh the editor if the modal is open
                    if (state.modal) {
                        const editor = state.modal.querySelector('#sp-editor');
                        if (editor) editor.value = text;
                        renderContent();
                    }
                    notify('Story Planner', 'Auto-generated a new story plan.', 'info');
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
    state.isGenerating = false;
    // Restore the per-chat auto counter (each chat tracks its own progress)
    const saved = getPlanData()?.autoCounter;
    state.autoCounter = (typeof saved === 'number' && Number.isFinite(saved)) ? saved : 0;
    persistAutoCounter();
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
    if (state.autoCounter > 0) {
        state.autoCounter = Math.max(0, state.autoCounter - 1);
        persistAutoCounter();
        console.log(`[MWT:StoryPlanner] MESSAGE_DELETED at index ${deletedIndex} — counter adjusted to ${state.autoCounter}`);
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

export function getPlanTextForMacro() {
    if (!isInjectionEnabled()) return '';
    return getPlanText();
}