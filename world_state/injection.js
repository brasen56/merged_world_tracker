/**
 * world_state/injection.js — Prompt injection for World State.
 *
 * Depends on data.js and settings.js (leaf modules).
 */

import { applyExtensionPromptInjection, getGlobalSettings, wrapInTag } from '../core/index.js';

import { getSettings } from './settings.js';
import {
    getWorldStateText, isInjectionEnabled, NEXT_SECTION_LOOKAHEAD,
} from './data.js';

// ─── Injection constants ─────────────────────────────────────────────────────

export const WORLD_STATE_INJECTION_HEADER = `[Rolling World State — current continuity reference.
Use this as background truth for the current scene.
Do not quote it directly.
Respect presence, pending obligations, character states, and knowledge boundaries.]`;

const PLOT_SEEDS_HEADERS = {
    passive: `[Narrative hooks available for this response — these are grounded story events that could plausibly arrive or escalate right now based on existing pressures.
You are encouraged to introduce one organically if the scene allows — as an interruption, arrival, message, or complication that the characters must react to.
Do not announce or explain the hook; simply have it happen.]`,

    proactive: `[Narrative hooks — these events are live and in motion based on existing pressures.
The player has opted into proactive hooks, which means they WANT autonomous world events to arrive without being prompted. You do not need to wait for the player to signal or request a hook — that signal is this setting itself.
Introduce one of these hooks in this response unless the scene is at an emotional climax that it would directly undercut.
These events do not require player initiative — they arrive on their own. Deliver it as an interruption, arrival, message, or complication. Do not announce or explain it; simply let it happen.]`,

    assertive: `[Narrative hooks — ACTIVE DIRECTIVES. These events are primed and should manifest now.
The player has explicitly enabled assertive hooks — they want the world to act on its own and expect you to introduce complications without waiting for them to ask. This IS their permission.
You must introduce at least one of these hooks in your response. The story world moves whether or not the player asks for it — do not wait for permission or an obvious opening.
Deliver the hook as an interruption, arrival, message, or complication. Do not announce or explain it; simply let it happen.]`,
};

export const EXTENSION_PROMPT_KEY = 'mwt_world_state_injection';

// ─── Hook mode helpers ───────────────────────────────────────────────────────

export function getHookMode() {
    return getSettings().hookMode || 'passive';
}

export function getPlotSeedsHeader() {
    const mode = getHookMode();
    if (mode === 'off') return null;
    return PLOT_SEEDS_HEADERS[mode] ?? PLOT_SEEDS_HEADERS.passive;
}

/**
 * Whether structural-boundary XML tags are enabled.
 * Reads the global setting (default: ON).
 */
export function structuralBoundariesEnabled() {
    const g = getGlobalSettings();
    return g.structuralBoundaries !== false;
}

/**
 * Split a world-state document into its body and the Plot Seeds section text.
 * Returns { worldStateBody, seedsText }.
 */
function splitWorldState(text) {
    const seedsPattern = new RegExp(`## Plot Seeds\\b[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`);
    const seedsMatch = text.match(seedsPattern);
    const seedsBlock = seedsMatch ? seedsMatch[0] : '';
    const seedsText = seedsBlock.replace(/^## Plot Seeds[^\n]*\n?/, '').trim();
    const worldStateBody = seedsMatch
        ? text.replace(seedsBlock, '').replace(/\n{3,}/g, '\n\n').trim()
        : text;
    return { worldStateBody, seedsText };
}

/**
 * Assemble the full World State injection payload (used both for live
 * injection and for the Preview modal).
 *
 * When structural boundaries are enabled, the world-state block is wrapped in
 * <mwt_world_state> and the Plot Seeds block (if present) in <mwt_plot_seeds>.
 * Both still carry their bracket header inside the tag so the model knows how
 * to treat each block.
 *
 * @param {string} text   — the raw world-state document
 * @returns {string}      — the fully assembled payload (headers + body + tags)
 */
export function buildInjectionPayload(text) {
    const { worldStateBody, seedsText } = splitWorldState(text);
    const useTags = structuralBoundariesEnabled();
    const seedsHeader = getPlotSeedsHeader();

    // World State block: header + body, optionally wrapped.
    const wsInner = `${WORLD_STATE_INJECTION_HEADER}\n\n${worldStateBody}`;
    const wsBlock = useTags ? wrapInTag('mwt_world_state', wsInner) : wsInner;

    // Plot Seeds block: only when seeds exist and hook mode is not 'off'.
    if (seedsText && seedsHeader) {
        const seedsInner = `${seedsHeader}\n\n${seedsText}`;
        const seedsBlock = useTags
            ? wrapInTag('mwt_plot_seeds', seedsInner)
            : seedsInner;
        return useTags
            ? `${wsBlock}\n\n${seedsBlock}`
            : `${wsBlock}\n\n---\n\n${seedsBlock}`;
    }

    return wsBlock;
}

// ─── Core injection ──────────────────────────────────────────────────────────

export function applyWorldStateInjection() {
    const text = getWorldStateText();
    const enabled = isInjectionEnabled();
    const s = getSettings();
    const globalSettings = getGlobalSettings();

    try {
        // The full payload (header(s) + body + optional tags) is built by
        // buildInjectionPayload. We pass it as the body with an empty header so
        // applyExtensionPromptInjection treats it as already fully assembled.
        const payload = buildInjectionPayload(text);

        applyExtensionPromptInjection({
            key: EXTENSION_PROMPT_KEY,
            header: '',
            body: payload,
            enabled,
            globalDepth: globalSettings.worldStateDepth,
            fallbackDepth: s.injectionDepth ?? 1,
            globalRole: globalSettings.worldStateRole || 'system',
            // Tag wrapping is handled locally per-block above; do not double-wrap.
            useTags: false,
        });
        const resolvedDepth = Number.isFinite(Number(globalSettings.worldStateDepth))
            ? Number(globalSettings.worldStateDepth)
            : (s.injectionDepth ?? 1);
        console.log(`[MWT:WorldState] Injected ${text.length} chars at depth ${resolvedDepth}`);
    } catch (err) {
        console.warn('[MWT:WorldState] Injection failed:', err);
    }
}

/** Build the full injected text preview (used by render.js preview button). */
export function buildInjectionPreview(text) {
    return buildInjectionPayload(text);
}
