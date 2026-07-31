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
    EXTENSION_PROMPT_KEY, SECTIONS,
    getArcs, getInjectMode, isInjectionEnabled,
    isArcReady, getCurrentBeat,
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

/**
 * Turns after which a waiting beat is called out as overdue in the injection.
 * Purely presentational nudging — nothing branches on it.
 */
const OVERDUE_TURNS = 12;

/**
 * The exact markdown body that will be injected (also used for token counts).
 *
 * Narrator-facing shape, deliberately different from serializeArcsToText():
 *  - Arcs whose setup is complete are lifted OUT of their section into a
 *    "Ready Now" block. That block is the "now" signal the plan previously
 *    never produced — without it, long-range arcs defer forever.
 *  - Every other arc shows ONE beat (the current one), not its whole list and
 *    not its endpoint-only description. That is the actionable instruction.
 *  - Immediate Hooks have no beats and render as plain one-liners.
 */
export function buildInjectionBody() {
    const arcs = getArcsForInjection();
    if (!arcs.length) return '';

    const ready = arcs.filter(a => isArcReady(a));
    const pending = arcs.filter(a => !isArcReady(a));
    const out = [];

    if (ready.length) {
        out.push('## Ready Now — setup is already planted; bring these to a head when the scene allows');
        for (const arc of ready) {
            out.push(arc.body ? `- ${arc.title || '(untitled arc)'} — ${arc.body}` : `- ${arc.title || '(untitled arc)'}`);
        }
        out.push('');
    }

    for (const sec of SECTIONS) {
        const inSection = pending.filter(a => a.section === sec.key);
        if (!inSection.length) continue;
        out.push(`## ${sec.label}`);
        for (const arc of inSection) {
            const title = arc.title || '(untitled arc)';
            const beat = getCurrentBeat(arc);
            if (!beat) {
                // Immediate Hooks, or a long-range arc the model gave no beats.
                out.push(arc.body ? `- ${title} — ${arc.body}` : `- ${title}`);
                continue;
            }
            const waited = arc.turnsSinceAdvance || 0;
            const overdue = waited >= OVERDUE_TURNS ? ` — still waiting after ${waited} turns; look for an opening` : '';
            out.push(`- ${title}${overdue}`);
            out.push(`  NOW: ${beat}`);
            if (arc.body) out.push(`  (building toward: ${arc.body})`);
        }
        out.push('');
    }

    return out.join('\n').trim();
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
