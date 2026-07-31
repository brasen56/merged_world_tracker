/**
 * story_planner/injection.js — Prompt injection for Story Plan.
 *
 * Depends on data.js, prompts.js and settings.js (leaf modules).
 */

import {
    getGlobalSettings, estimateTokens,
    applyExtensionPromptInjection, injectionAllowed,
} from '../core/index.js';

import { STORY_PLAN_INJECTION_HEADER } from './prompts.js';
import {
    EXTENSION_PROMPT_KEY,
    getArcs, getInjectMode, serializeArcsToText, isInjectionEnabled,
} from './data.js';
import { getSettings } from './settings.js';

export { STORY_PLAN_INJECTION_HEADER };

// ─── Arc selection ───────────────────────────────────────────────────────────

/**
 * Which arcs reach the model, per the user's injection mode.
 *
 * Mirrors chronicle/injection.js's getEntriesForInjection(). Dropped arcs are
 * excluded in every mode — dropping is the user saying "not this one", so it
 * should hold regardless of which mode is selected.
 */
export function getArcsForInjection() {
    const arcs = getArcs().filter(a => a.status !== 'dropped');
    const mode = getInjectMode();
    if (mode === 'pinned') return arcs.filter(a => a.pinned);
    if (mode === 'active') return arcs.filter(a => a.status === 'active');
    return arcs;
}

/** The exact markdown body that will be injected (also used for token counts). */
export function buildInjectionBody() {
    return serializeArcsToText(getArcsForInjection());
}

// ─── Core injection ──────────────────────────────────────────────────────────

export function applyPlanInjection() {
    const enabled = isInjectionEnabled() && injectionAllowed('StoryPlanner');
    const body = enabled ? buildInjectionBody() : '';
    const s = getSettings();
    const globalSettings = getGlobalSettings();

    // The Story Planner uses its own injectionDepth; there is no global
    // depth/role pair for it in the Settings tab (we keep it self-contained),
    // but we still honor structural-boundaries and injectionAllowed().
    const useTags = globalSettings.structuralBoundaries !== false;

    applyExtensionPromptInjection({
        key: EXTENSION_PROMPT_KEY,
        header: STORY_PLAN_INJECTION_HEADER,
        body,
        enabled,
        fallbackDepth: s.injectionDepth ?? 4,
        globalRole: 'system',
        wrapperTag: 'mwt_story_plan',
        useTags,
    });

    const depth = s.injectionDepth ?? 4;
    console.log(`[MWT:StoryPlanner] Injection ${enabled && body ? 'applied' : 'cleared'} — mode "${getInjectMode()}", ${getArcsForInjection().length} arcs, ${body.length} chars at depth ${depth}`);
}

// ─── Token estimate ──────────────────────────────────────────────────────────

export function getInjectedTokenCount() {
    if (!isInjectionEnabled()) return 0;
    const body = buildInjectionBody();
    if (!body) return 0;
    return estimateTokens(`${STORY_PLAN_INJECTION_HEADER}\n\n${body}`);
}
