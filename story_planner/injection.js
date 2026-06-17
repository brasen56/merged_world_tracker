/**
 * story_planner/injection.js — Prompt injection for Story Plan.
 *
 * Depends on data.js and settings.js (leaf modules).
 */

import {
    getGlobalSettings, estimateTokens,
    applyExtensionPromptInjection, wrapInTag, injectionAllowed,
} from '../core/index.js';

import {
    EXTENSION_PROMPT_KEY,
    getPlanText, isInjectionEnabled,
} from './data.js';
import { getSettings } from './settings.js';

// ─── Injection header ────────────────────────────────────────────────────────

export const STORY_PLAN_INJECTION_HEADER = `[Story Plan — a menu of theoretical future plot developments.
These are branching possibilities for the AI to draw on, not fixed events.
Use them as inspiration; do not treat any single idea as mandatory or predetermined.]`;

// ─── Core injection ──────────────────────────────────────────────────────────

export function applyPlanInjection() {
    const text = getPlanText();
    const enabled = isInjectionEnabled() && injectionAllowed('StoryPlanner');
    const s = getSettings();
    const globalSettings = getGlobalSettings();

    // The Story Planner uses its own injectionDepth; there is no global
    // depth/role pair for it in the Settings tab (we keep it self-contained),
    // but we still honor structural-boundaries and injectionAllowed().
    const useTags = globalSettings.structuralBoundaries !== false;

    applyExtensionPromptInjection({
        key: EXTENSION_PROMPT_KEY,
        header: STORY_PLAN_INJECTION_HEADER,
        body: text,
        enabled,
        fallbackDepth: s.injectionDepth ?? 4,
        globalRole: 'system',
        wrapperTag: 'mwt_story_plan',
        useTags,
    });

    const depth = s.injectionDepth ?? 4;
    console.log(`[MWT:StoryPlanner] Injection ${enabled ? 'applied' : 'cleared'} (${text.length} chars) at depth ${depth}`);
}

// ─── Token estimate ──────────────────────────────────────────────────────────

export function getInjectedTokenCount() {
    if (!isInjectionEnabled()) return 0;
    const text = getPlanText();
    if (!text) return 0;
    return estimateTokens(`${STORY_PLAN_INJECTION_HEADER}\n\n${text}`);
}