/**
 * world_state/injection.js — Prompt injection for World State.
 *
 * Depends on data.js and settings.js (leaf modules).
 */

import { applyExtensionPromptInjection, getGlobalSettings, wrapInTag, injectionAllowed, truncateText } from '../core/index.js';

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

/**
 * WORLD-STATE-03: Maximum character budget for the injected world-state body
 * (after the header, before the plot seeds). The recent-messages scan is
 * already capped at 20k chars, but the *entire* saved document went into the
 * injection with no cap — so a large imported state made every narrator turn
 * oversized. 30k chars (~7.5k tokens) is generous for a full state document
 * while preventing pathological bloat from dominating the context window.
 */
const INJECTION_BODY_BUDGET = 30000;

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
 * Also strips the "## Archive (Stale)" section (quarantine-mode expiry, see
 * STALE_ENTRY_EXPIRY_DESIGN.md §5.2) — it's kept in the saved document for the
 * user to review/purge, but never injected into the prompt.
 * Returns { worldStateBody, seedsText }.
 */
function splitWorldState(text) {
    // Line-anchored like extractOnlySection/replaceSection (WORLD-STATE-06),
    // with the same quadratic-rescan consequence in mind: an unanchored
    // `\s*` before the literal is retried at EVERY position inside a long
    // whitespace run, rescanning the rest of the run each time — quadratic
    // in the worst case. The `(?:^|\n)` gate fails in O(1) at non-newline
    // positions, so the leading `\s*` only ever runs right after a line
    // break. This matters here because the chronicle world-state sync can
    // feed a whitespace-heavy model-generated Date line straight into this
    // injection rebuild (audit P3 follow-up). Note: the section-name
    // boundary stays a negative lookahead, not `\b` — "Archive (Stale)"
    // ends in punctuation, and `\b` (which requires a word char on at
    // least one side) never matches there.
    const archivePattern = new RegExp(`(?:^|\\n)\\s*## Archive \\(Stale\\)(?![A-Za-z0-9_])[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`);
    const withoutArchive = text.replace(archivePattern, '');

    const seedsPattern = new RegExp(`## Plot Seeds\\b[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`);
    const seedsMatch = withoutArchive.match(seedsPattern);
    const seedsBlock = seedsMatch ? seedsMatch[0] : '';
    const seedsText = seedsBlock.replace(/^## Plot Seeds[^\n]*\n?/, '').trim();
    const worldStateBody = seedsMatch
        ? withoutArchive.replace(seedsBlock, '').replace(/\n{3,}/g, '\n\n').trim()
        : withoutArchive.trim();
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
    const { worldStateBody: rawBody, seedsText } = splitWorldState(text);
    // WORLD-STATE-03: Cap the injected body so a large imported state doesn't
    // dominate the narrator context window every turn. truncateText keeps the
    // beginning (the most structured/important sections) and appends a clear
    // truncation marker so the model knows it received a slice.
    const worldStateBody = truncateText(rawBody, INJECTION_BODY_BUDGET);
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
    const enabled = isInjectionEnabled() && injectionAllowed('WorldState');
    const s = getSettings();
    const globalSettings = getGlobalSettings();

    try {
        // Tag handling is intentionally two layers:
        //  (1) buildInjectionPayload() above already wraps each semantic block
        //      (world state, plot seeds) in its own <mwt_*> tag when
        //      structural boundaries are on. That is the *content* layer.
        //  (2) Here we hand the fully-assembled payload to the generic injector
        //      with `useTags: false` so it does NOT add an outer wrapper on top —
        //      that would double-wrap the blocks. applyExtensionPromptInjection's
        //      own `useTags` is a separate, generic mechanism unrelated to the
        //      per-block tags built above.
        const payload = buildInjectionPayload(text);

        applyExtensionPromptInjection({
            key: EXTENSION_PROMPT_KEY,
            header: '',
            body: payload,
            enabled,
            globalDepth: globalSettings.worldStateDepth,
            fallbackDepth: s.injectionDepth ?? 1,
            globalRole: globalSettings.worldStateRole || 'system',
            // Content-layer wrapping is already applied per-block above; pass
            // false so the generic injector doesn't add an additional wrapper.
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
