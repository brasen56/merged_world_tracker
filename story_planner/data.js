/**
 * story_planner/data.js — Shared constants, mutable state, and data access.
 *
 * Leaf module — no imports from other story_planner modules.
 */

import { getChatMeta, patchChatMeta } from '../core/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const CHAT_DATA_KEY = 'story_planner_data';
export const EXTENSION_PROMPT_KEY = 'mwt_story_plan_injection';

// ─── Mutable shared state ────────────────────────────────────────────────────

export const state = {
    /** @type {HTMLElement|null} Parent modal element */
    modal: null,
    /** @type {HTMLElement|null} Cached story-planner-tab content element */
    contentEl: null,
    /** True while a generation is in flight */
    isGenerating: false,
    /** Auto-trigger countdown (messages since last plan generation) */
    autoCounter: 0,
    /** Last persisted chat length, used by onMessageDeleted */
    lastChatLength: 0,
};

// ─── Chat data helpers ───────────────────────────────────────────────────────

export function getPlanData() {
    const meta = getChatMeta();
    return meta?.[CHAT_DATA_KEY] || {};
}

export function setPlanData(patch) {
    patchChatMeta(CHAT_DATA_KEY, patch);
}

export function getPlanText() {
    return getPlanData().text || '';
}

// ─── History (snapshots for Revert / History) ────────────────────────────────

/** Max snapshots retained per chat. Kept modest to bound metadata growth. */
export const MAX_PLAN_HISTORY = 20;

export function getPlanHistory() {
    return getPlanData().history || [];
}

/**
 * Push a plan snapshot onto the per-chat history stack. No-ops on blank text
 * and on consecutive duplicates so revert steps stay meaningful.
 */
export function pushPlanToHistory(text) {
    if (!text?.trim()) return;
    const history = getPlanHistory();
    if (history.length && history[history.length - 1].text === text) return;
    history.push({ text, timestamp: Date.now() });
    if (history.length > MAX_PLAN_HISTORY) history.splice(0, history.length - MAX_PLAN_HISTORY);
    setPlanData({ history });
}

export function isInjectionEnabled() {
    return getPlanData().injectEnabled !== false;
}

// ─── Auto-trigger helpers ────────────────────────────────────────────────────

export function getAutoInterval() {
    const v = getPlanData().autoInterval;
    return Number.isFinite(Number(v)) ? Math.max(1, Number(v)) : 10;
}

export function isAutoEnabled() {
    return getPlanData().autoEnabled === true;
}

export function persistAutoCounter() {
    setPlanData({ autoCounter: state.autoCounter });
}

export function resetAutoCounter() {
    state.autoCounter = 0;
    persistAutoCounter();
}