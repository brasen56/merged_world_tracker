/**
 * story_planner/injection.js — Prompt injection for Story Plan.
 *
 * Depends on data.js, prompts.js and settings.js (leaf modules).
 */

import {
    getGlobalSettings, estimateTokens,
    applyExtensionPromptInjection, injectionAllowed,
} from '../core/index.js';
// Part 6 injection pause guard. Direct import (not the barrel) so the REAL
// pause singleton is read even under the test barrel→stub alias.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';

import { STORY_PLAN_INJECTION_HEADER, buildStoryPlanHeader } from './prompts.js';
import {
    EXTENSION_PROMPT_KEY, SECTIONS,
    getArcs, getInjectMode, isInjectionEnabled, getEnforcement,
    isArcReady, getCurrentBeat, getNudgeTurns,
} from './data.js';
import { getSettings } from './settings.js';

export { STORY_PLAN_INJECTION_HEADER };

/** The header actually injected, per the chat's enforcement setting. */
function currentHeader() {
    return buildStoryPlanHeader(getEnforcement());
}

// ─── Arc selection ───────────────────────────────────────────────────────────

/**
 * Which arcs reach the model, per the user's injection mode.
 *
 * Mirrors chronicle/injection.js's getEntriesForInjection(). Dropped arcs are
 * excluded in every mode — dropping is the user saying "not this one", so it
 * should hold regardless of which mode is selected. Resolved arcs are also
 * excluded in every mode: resolving means the arc has already paid off, so
 * injecting it again would treat it as actionable, contradicting the UI's
 * promise that resolving "stops it being suggested again."
 */
export function getArcsForInjection() {
    const arcs = getArcs().filter(a => a.status !== 'dropped' && a.status !== 'resolved');
    const mode = getInjectMode();
    if (mode === 'pinned') return arcs.filter(a => a.pinned);
    if (mode === 'active') return arcs.filter(a => a.status === 'active');
    return arcs;
}

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
            const overdue = waited >= getNudgeTurns() ? ` — still waiting after ${waited} turns; look for an opening` : '';
            out.push(`- ${title}${overdue}`);
            out.push(`  NOW: ${beat}`);
            if (arc.body) out.push(`  (building toward: ${arc.body})`);
        }
        out.push('');
    }

    return out.join('\n').trim();
}

// ─── Placement resolution (Phase 9 diagnostics) ──────────────────────────────

/**
 * Resolve the depth/role this module's injection will use, WITH provenance —
 * the exact precedence applyPlanInjection() hands to
 * applyExtensionPromptInjection():
 *   depth — this module's `injectionDepth` setting → built-in 4
 *   role  — built-in 'system' (no setting exists)
 *
 * The Story Planner deliberately has NO global depth/role pair in the Settings
 * tab (see applyPlanInjection — it stays self-contained), so the chain is
 * module-only. Phase 9 (diagnostics design §I.4.6, §I.5 Tab 4): the apply path
 * and the 💉 Injection tab call the SAME function, so what the tab reports and
 * what the applier registers cannot drift. `source` strings are stable API —
 * 'global' | 'module' | 'builtin' (rendered via PLACEMENT_SOURCE_LABELS,
 * diagnostics_panel/injection.js); do not rename.
 *
 * @returns {{depth: {value: number, source: string}, role: {value: string, source: string}}}
 */
export function resolveInjectionPlacement() {
    const moduleDepth = getSettings().injectionDepth;
    return {
        depth: {
            value: moduleDepth ?? 4,
            source: moduleDepth != null ? 'module' : 'builtin',
        },
        role: { value: 'system', source: 'builtin' },
    };
}

// ─── Core injection ──────────────────────────────────────────────────────────

export function applyPlanInjection() {
    // Part 6: a store paused by the runtime schema gate is never read — no
    // module injects an unprepared store (§7.4). Clearing the slot (the same
    // thing every disabled path does) also drops anything a pre-pause state
    // left registered, so nothing stale rides along.
    const paused = isStorePausedForCurrentScope('storyPlanner');
    if (paused) console.log('[MWT:StoryPlanner] Injection cleared — the store is paused for this chat (schema preparation).');
    const enabled = !paused && isInjectionEnabled() && injectionAllowed('StoryPlanner');
    const body = enabled ? buildInjectionBody() : '';
    const globalSettings = getGlobalSettings();

    // The Story Planner uses its own injectionDepth; there is no global
    // depth/role pair for it in the Settings tab (we keep it self-contained),
    // but we still honor structural-boundaries and injectionAllowed().
    // Placement comes fully resolved from resolveInjectionPlacement() (Phase 9)
    // — one resolver, two consumers (this apply + the 💉 Injection tab).
    const useTags = globalSettings.structuralBoundaries !== false;
    const placement = resolveInjectionPlacement();

    applyExtensionPromptInjection({
        key: EXTENSION_PROMPT_KEY,
        header: currentHeader(),
        body,
        enabled,
        fallbackDepth: placement.depth.value,
        globalRole: placement.role.value,
        wrapperTag: 'mwt_story_plan',
        useTags,
    });

    // When paused, do not even read the arc list for the log — a paused store
    // is never read (§7.4).
    const arcCount = paused ? 0 : getArcsForInjection().length;
    console.log(`[MWT:StoryPlanner] Injection ${enabled && body ? 'applied' : 'cleared'} — mode "${getInjectMode()}", push "${getEnforcement()}", ${arcCount} arcs, ${body.length} chars at depth ${placement.depth.value}`);
}

// ─── Token estimate ──────────────────────────────────────────────────────────

export function getInjectedTokenCount() {
    if (!isInjectionEnabled()) return 0;
    const body = buildInjectionBody();
    if (!body) return 0;
    // Must use the same header applyPlanInjection() sends — the assertive
    // block is markedly longer than the passive one.
    return estimateTokens(`${currentHeader()}\n\n${body}`);
}
