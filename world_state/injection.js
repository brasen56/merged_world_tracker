/**
 * world_state/injection.js — Prompt injection for World State.
 *
 * Depends on data.js and settings.js (leaf modules).
 */

import {
    applyExtensionPromptInjection, getGlobalSettings, wrapInTag, injectionAllowed, truncateText,
    estimateTokens, projectWorldStateSections, TRUNCATION_MARKER,
} from '../core/index.js';
// Part 6 injection pause guard. Direct import (not the barrel) so the REAL
// pause singleton is read even under the test barrel→stub alias.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';

import { getSettings } from './settings.js';
import { getWorldStateText, isInjectionEnabled } from './data.js';

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

// Keep optional narrative hooks from bypassing the factual-body budget. Hooks
// are useful context, but they must never turn a large imported document into
// an unbounded narrator injection.
const INJECTION_HOOK_BUDGET = 10000;

function joinProjection({ parts, separator }) {
    return parts.map(part => part.text).join(separator);
}

/**
 * Assemble the narrator payload from the shared core projections. No token
 * counting happens here: getTotalTokens() (the floating badge, every 5 s) and
 * the Preview build payloads through this path, and only a live apply needs
 * the per-section report (measureInjection).
 */
function assembleInjection(text) {
    const source = typeof text === 'string' ? text : getWorldStateText();
    const hookMode = getHookMode();
    const factual = projectWorldStateSections(source, { view: 'factual' });
    const hooks = projectWorldStateSections(source, { view: 'hooks' });
    const rawFactual = joinProjection(factual);
    const rawHooks = joinProjection(hooks);
    // WORLD-STATE-03: cap the injected body so a large imported state doesn't
    // dominate the narrator context window every turn. truncateText keeps the
    // beginning and appends TRUNCATION_MARKER so the model knows it got a slice.
    const factualText = truncateText(rawFactual, INJECTION_BODY_BUDGET);
    const hooksText = hookMode === 'off' ? '' : truncateText(rawHooks, INJECTION_HOOK_BUDGET);
    const useTags = structuralBoundariesEnabled();
    const seedsHeader = getPlotSeedsHeader();

    const wsInner = factualText ? `${WORLD_STATE_INJECTION_HEADER}\n\n${factualText}` : '';
    const wsBlock = wsInner && (useTags ? wrapInTag('mwt_world_state', wsInner) : wsInner);
    let payload = wsBlock || '';
    if (hooksText && seedsHeader) {
        const seedsInner = `${seedsHeader}\n\n${hooksText}`;
        const seedsBlock = useTags ? wrapInTag('mwt_plot_seeds', seedsInner) : seedsInner;
        payload = wsBlock
            ? `${wsBlock}\n\n${useTags ? '' : '---\n\n'}${seedsBlock}`
            : seedsBlock;
    }
    return { payload, hookMode, factual, hooks, rawFactual, rawHooks, factualText, hooksText };
}

function partLabel(part) {
    if (part.kind === 'preamble') return 'Preamble';
    if (part.kind === 'legacy') return 'Current Scene (legacy)';
    return part.name;
}

/**
 * Attribute a capped projection back to its parts. Offsets come from the same
 * parts and separator the projection was joined from, so they are exact.
 */
function measureParts(projection, fullText, projectedText, view, reason) {
    // truncateText returns the text untouched when it fits; otherwise a prefix
    // plus TRUNCATION_MARKER. Hook mode off projects nothing at all.
    const retainedChars = projectedText === fullText
        ? fullText.length
        : Math.max(0, projectedText.length - TRUNCATION_MARKER.length);
    let cursor = 0;
    return projection.parts.map((part) => {
        const start = cursor;
        const end = start + part.text.length;
        cursor = end + projection.separator.length;
        const kept = Math.max(0, Math.min(end, retainedChars) - start);
        const status = kept === 0 ? 'omitted' : (kept < part.text.length ? 'partial' : 'included');
        const storedTokens = estimateTokens(part.text);
        return {
            sectionName: partLabel(part),
            view,
            storedTokens,
            injectedTokens: status === 'included' ? storedTokens : estimateTokens(part.text.slice(0, kept)),
            status,
            ...(status !== 'included' ? { reason } : {}),
        };
    });
}

/**
 * Read-only Phase 6 measurements for an assembled payload. The report observes
 * the existing projection/caps; it does not select, rank, mutate, or otherwise
 * change stored World State content.
 */
function measureInjection(assembled) {
    const { payload, hookMode, factual, hooks, rawFactual, rawHooks, factualText, hooksText } = assembled;
    const factualSections = measureParts(factual, rawFactual, factualText, 'factual', 'factual character cap');
    const hookSections = measureParts(
        hooks, rawHooks, hooksText, 'hooks', hookMode === 'off' ? 'hook mode off' : 'hook character cap',
    );
    const archiveSections = factual.archived.map(section => ({
        sectionName: section.name,
        view: 'archive',
        storedTokens: estimateTokens(section.text),
        injectedTokens: 0,
        status: 'omitted',
        reason: 'archive excluded from prompt projections',
    }));
    const sections = [...factualSections, ...hookSections, ...archiveSections];
    const factualStored = estimateTokens(rawFactual);
    const hooksStored = estimateTokens(rawHooks);
    const payloadTokens = estimateTokens(payload);

    return {
        kind: 'world-state-sections',
        sectionTokenStage: 'before-outer-budget',
        factual: {
            storedTokens: factualStored,
            injectedTokens: factualText === rawFactual ? factualStored : estimateTokens(factualText),
        },
        hooks: {
            storedTokens: hooksStored,
            injectedTokens: hooksText === rawHooks ? hooksStored : estimateTokens(hooksText),
        },
        payloadTokens,
        // The shared injection seam overwrites these two with the post-Budget
        // outcome; they only stand as-is for direct callers of the projection.
        registeredPayloadTokens: payloadTokens,
        outerBudgetAction: 'keep',
        sections,
        omitted: sections
            .filter(section => section.status !== 'included')
            .map(({ sectionName, view, status, reason }) => ({ kind: 'section', sectionName, view, status, reason })),
        entries: [],
    };
}

/** Build the exact narrator payload together with its Phase 6 measurements. */
export function buildInjectionProjection(text) {
    const assembled = assembleInjection(text);
    return { payload: assembled.payload, diagnostics: measureInjection(assembled) };
}

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
    return assembleInjection(text).payload;
}

// ─── Placement resolution (Phase 9 diagnostics) ──────────────────────────────

/**
 * Resolve the depth/role this module's injection will use, WITH provenance —
 * the exact precedence applyWorldStateInjection() hands to
 * applyExtensionPromptInjection():
 *   depth — global `worldStateDepth` (Settings tab; a present, finite value
 *           wins) → this module's `injectionDepth` setting → built-in 1
 *   role  — global `worldStateRole` (truthy wins) → built-in 'system'
 *
 * Phase 9 (diagnostics design §I.4.6, §I.5 Tab 4): the apply path and the 💉
 * Injection tab call the SAME function, so what the tab reports and what the
 * applier registers cannot drift. `source` strings are stable API —
 * 'global' | 'module' | 'builtin' (rendered via PLACEMENT_SOURCE_LABELS,
 * diagnostics_panel/injection.js); do not rename.
 *
 * @returns {{depth: {value: number, source: string}, role: {value: string, source: string}}}
 */
export function resolveInjectionPlacement() {
    const globalSettings = getGlobalSettings();
    const gd = globalSettings.worldStateDepth;
    const globalDepthWins = gd != null && Number.isFinite(Number(gd));
    const moduleDepth = getSettings().injectionDepth;
    return {
        depth: {
            value: globalDepthWins ? Number(gd) : (moduleDepth ?? 1),
            source: globalDepthWins ? 'global' : (moduleDepth != null ? 'module' : 'builtin'),
        },
        role: {
            value: globalSettings.worldStateRole || 'system',
            source: globalSettings.worldStateRole ? 'global' : 'builtin',
        },
    };
}

// ─── Core injection ──────────────────────────────────────────────────────────

export function applyWorldStateInjection() {
    // Part 6: a store paused by the runtime schema gate is never read — no
    // module injects an unprepared store (§7.4). Clearing the slot (the same
    // thing every disabled path does) also drops anything a pre-pause state
    // left registered, so nothing stale rides along.
    if (isStorePausedForCurrentScope('worldState')) {
        const placement = resolveInjectionPlacement();
        console.log('[MWT:WorldState] Injection cleared — the store is paused for this chat (schema preparation).');
        applyExtensionPromptInjection({
            key: EXTENSION_PROMPT_KEY,
            header: '',
            body: '',
            enabled: false,
            fallbackDepth: placement.depth.value,
            globalRole: placement.role.value,
            useTags: false,
        });
        return;
    }
    const text = getWorldStateText();
    const enabled = isInjectionEnabled() && injectionAllowed('WorldState');
    const placement = resolveInjectionPlacement();

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
        const projection = buildInjectionProjection(text);
        const payload = projection.payload;

        applyExtensionPromptInjection({
            key: EXTENSION_PROMPT_KEY,
            header: '',
            body: payload,
            enabled,
            // Placement comes fully resolved from resolveInjectionPlacement()
            // (Phase 9). It is passed as the fallback depth so the injector's
            // own globalDepth/fallbackDepth split stays inert — one resolver,
            // two consumers (this apply + the 💉 Injection diagnostics tab).
            fallbackDepth: placement.depth.value,
            globalRole: placement.role.value,
            // Content-layer wrapping is already applied per-block above; pass
            // false so the generic injector doesn't add an additional wrapper.
            useTags: false,
            diagnostics: projection.diagnostics,
        });
        console.log(`[MWT:WorldState] Injected ${payload.length} chars at depth ${placement.depth.value}`);
    } catch (err) {
        console.warn('[MWT:WorldState] Injection failed:', err);
    }
}

/** Build the full injected text preview (used by render.js preview button). */
export function buildInjectionPreview(text) {
    return buildInjectionPayload(text);
}
