/**
 * core/injection.js — Shared prompt injection helpers.
 */

import { getSetExtensionPrompt } from './context.js';
import { escapePromptBoundary } from './prompt.js';
import { recordInjection } from './diagnostics.js';
// TODO §2 context budget: the ONE seam every setExtensionPrompt injection
// funnels through consults the per-chat budget before registering. Direct
// import (never the barrel — the §II.3 alias trap); core/budget.js never
// imports this module back, so no cycle. The hook's contract is pass-through
// on ANY internal failure, so a budget bug cannot break injection itself.
import { enforceInjectionBudget, rebalanceBudgetInjections, clearDesiredBudgetInjection } from './budget.js';

export function roleToNumber(role) {
    switch (role) {
        case 'user': return 1;
        case 'assistant': return 2;
        default: return 0;
    }
}

/**
 * Wrap a body in open/close XML-style tags.
 *
 * Used to give small/mid-size models a hard structural boundary between
 * different injected reference blocks (world state, chronicle, plot seeds).
 * Frontier-class models don't need it, but 24–70B models bleed less when
 * each block has explicit delimiters.
 *
 * NEW-01: The body is escaped before interpolation. Without this, a chat
 * message, lorebook entry, imported chronicle entry, or generated state
 * containing a closing tag like `</mwt_world_state>` breaks the structural
 * boundary for every module that injects — the tag closes early and the
 * rest of the content leaks into the prompt as unstructured text.
 *
 * Boundary safety only needs `<`: neutralizing it stops any closing tag in
 * the body from closing the wrapper early. `&` is intentionally NOT escaped —
 * these blocks are narrator-facing prose where a literal ampersand is correct
 * ("Tom & Jerry"), and escaping it would deliver `&amp;` to the model on every
 * turn. (Uses escapePromptBoundary, not escapePromptText.)
 *
 * @param {string} tag  — tag name without angle brackets (e.g. 'mwt_world_state')
 * @param {string} body — inner content
 * @returns {string}    `<tag>\nbody\n</tag>`
 */
export function wrapInTag(tag, body) {
    if (!tag || !body?.trim()) return body || '';
    return `<${tag}>\n${escapePromptBoundary(body)}\n</${tag}>`;
}

/**
 * Apply (or clear) an extension-prompt injection.
 *
 * @param {object} opts
 * @param {string} opts.key            — setExtensionPrompt key
 * @param {string} opts.header         — bracket header text prepended to the body
 * @param {string} opts.body           — main injection content
 * @param {boolean} opts.enabled       — whether injection is active
 * @param {number} [opts.globalDepth]  — global depth override
 * @param {number} opts.fallbackDepth  — module-specific default depth
 * @param {string} [opts.globalRole]   — 'system' | 'user' | 'assistant'
 * @param {string} [opts.wrapperTag]   — when set AND structural boundaries are
 *                                        enabled, wraps the full payload in
 *                                        `<wrapperTag>…</wrapperTag>`
 * @param {boolean} [opts.useTags=true] — master switch for tag wrapping
 *
 * Phase 2 diagnostics: every apply that reaches setExtensionPrompt (including
 * clears) records a per-key snapshot `{ key, payload, role, depth, enabled, at }`
 * via recordInjection() in core/diagnostics.js — overwritten on each apply, so
 * `getInjectedSnapshot(key)` always reflects the last thing actually registered
 * with SillyTavern.
 */
export function applyExtensionPromptInjection({
    key,
    header,
    body,
    enabled,
    globalDepth,
    fallbackDepth,
    globalRole = 'system',
    wrapperTag,
    useTags = true,
}) {
    const setEP = getSetExtensionPrompt();
    if (!setEP) return false;

    const role = roleToNumber(globalRole);
    const depth = (globalDepth != null && Number.isFinite(Number(globalDepth))) ? Number(globalDepth) : fallbackDepth;

    if (!enabled || !body?.trim()) {
        setEP(key, '', 1, depth, undefined, role);
        // Phase 2 diagnostics: record the cleared state too — "it was cleared
        // at T" is exactly as diagnostic as what the slot contained before.
        recordInjection({ key, payload: '', role, depth, enabled: false });
        // Disabled/empty applies bypass enforceInjectionBudget entirely, so
        // explicitly forget this desired payload and let any other displaced
        // module reclaim the capacity it just freed (TODO §2 P2).
        clearDesiredBudgetInjection(key, { setEP });
        return false;
    }

    // Build the payload. When a header is provided it is prepended; otherwise
    // the body is treated as already fully assembled (e.g. World State builds
    // multiple independently-wrapped blocks and passes the final string here).
    const inner = header?.trim() ? `${header}\n\n${body}` : body;
    let payload = (useTags && wrapperTag) ? wrapInTag(wrapperTag, inner) : inner;

    // TODO §2 context budget. The per-chat budget gets the FINAL payload —
    // after header/wrapper assembly, before registration — and may return a
    // truncated version, a drop (cleared slot), or (observe mode, the
    // default) exactly what was passed in. `enabled` travels with the
    // decision: a dropped injection clears its slot like any disabled path.
    // depth/role travel too so the budget's desired-payload registry can
    // RE-INJECT a previously displaced module at its correct placement when
    // capacity is freed (TODO §2 P2 — displaced modules are no longer
    // one-way).
    const budgeted = enforceInjectionBudget({ key, payload, enabled: true, depth, role });
    payload = budgeted.payload;
    const finalEnabled = enabled && budgeted.enabled;

    setEP(key, payload, 1, depth, undefined, role);
    // Phase 2 diagnostics: snapshot exactly what was registered with
    // SillyTavern, after the handoff, so the recorded payload can never
    // drift from the registration (a fresh rebuild on panel open would lie —
    // see the stale-arc note at story_planner/index.js:85). This proves what
    // MWT registered, not that a generation ran afterwards or that
    // SillyTavern placed the payload in the final prompt — placement is not
    // observable from here (the panel design calls it Unverified).
    recordInjection({ key, payload, role, depth, enabled: finalEnabled });
    // TODO §2 P2 — now that this incoming payload's active snapshot exists,
    // safely re-admit any lower-priority module it previously displaced if
    // the current allocation has capacity again. This must occur AFTER the
    // record above because the rebalance planner reads live snapshots.
    rebalanceBudgetInjections({ setEP });
    return !!finalEnabled;
}