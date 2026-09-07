/**
 * core/budget.js — Cross-module context/token budget (TODO §2, PI §P1).
 *
 * The one seam every setExtensionPrompt injection already funnels through
 * (core/injection.js applyExtensionPromptInjection) now consults a shared,
 * per-chat budget BEFORE registering a payload:
 *
 *   - OBSERVE (default): nothing is modified. The panel shows what WOULD be
 *     truncated or dropped, so enforcement can never surprise a user who
 *     never opted in.
 *   - ENFORCE (explicit per-chat toggle):
 *       · module SOFT cap exceeded   → payload truncated with a visible
 *         `[…truncated ~N tokens]` marker (omitted count stated);
 *       · module HARD cap exceeded   → that injection dropped (cleared);
 *       · GLOBAL hard cap exceeded   → lowest-priority context goes first —
 *         already-registered WORSE-priority modules are displaced (their
 *         slots cleared through the same seam) before the incoming payload
 *         is shrunk; a payload never displaces an equal-or-better priority;
 *       · protected content whose payload ALONE exceeds the global cap is
 *         never silently shrunk — enforcement refuses for it and raises a
 *         loud error event instead of corrupting it (no MWT module is
 *         protected today; the guard is the spec-level `protected` flag).
 *
 * "Per project, not globally": the whole record lives in THIS CHAT's
 * metadata (BUDGET_METADATA_KEY), exactly like every other chat-local MWT
 * store — a new chat starts in observe mode regardless of other chats.
 *
 * What the budget does NOT own (stated on the panel, mirroring the Health /
 * Injection tabs' Knowledge caveat): SillyTavern's own prompt — system
 * prompt, chat history, author's note — and Knowledge's lorebook entries,
 * which inject through ST's World Info keyword activation, not through MWT's
 * seam. Those are reported (advisory), never managed, from here.
 *
 * Style notes (mirrors core/coordinator.js, the other core-level subsystem
 * adopted at a shared seam): direct imports only — this module must never
 * import core/index.js (the barrel is aliased to test/stubs/core.js under
 * Vitest; the §II.3 barrel→stub alias trap) and nothing it imports imports
 * core/injection.js back, so there is no cycle. Every dependency of the
 * enforcement hook is injectable for tests; every path is guarded so a
 * budget bug can never break injection itself — on ANY internal failure the
 * original payload passes through untouched.
 */

import { getChatMeta, getSetExtensionPrompt, estimateTokens, getContextSafe } from './context.js';
import { patchChatMeta } from './metadata.js';
import { record, recordInjection, getAllInjectedSnapshots, clearInjections } from './diagnostics.js';

// ─── The module table ─────────────────────────────────────────────────────────

/** Chat-metadata key the per-chat budget record lives under. */
export const BUDGET_METADATA_KEY = 'mwt_context_budget';

/**
 * The five modules the budget knows about, in drop-order tie-break order.
 *
 * `priority` semantics: LOWER number = kept longest. The defaults encode the
 * TODO §2 suggestion — current World State and triggered intentions first,
 * then recent Chronicle, then current Story Planner beats, older/reference
 * material last. Equal priorities tie-break by this table's order (an
 * earlier row survives an equal fight), which is why World State is listed
 * before Interiority: both default to 1.
 *
 * `key` is the setExtensionPrompt key from each module's injection file —
 * the single source of truth for the seam lookup (never redefined here).
 * Knowledge has `key: null` + `mechanism: 'lorebook'`: its entries reach the
 * prompt through SillyTavern's World Info activation, which MWT's seam never
 * sees, so it is ADVISORY only — reported on the panel, never enforced.
 */
export const BUDGET_MODULE_SPECS = Object.freeze([
    Object.freeze({ id: 'world_state', label: '🌍 World State', key: 'mwt_world_state_injection', mechanism: 'extension-prompt', defaultPriority: 1 }),
    Object.freeze({ id: 'interiority', label: '💭 Interiority', key: 'mwt_interiority_injection', mechanism: 'extension-prompt', defaultPriority: 1 }),
    Object.freeze({ id: 'chronicle', label: '📜 Chronicle', key: 'session_chronicle_injection', mechanism: 'extension-prompt', defaultPriority: 2 }),
    Object.freeze({ id: 'story_planner', label: '🗺️ Story Planner', key: 'mwt_story_plan_injection', mechanism: 'extension-prompt', defaultPriority: 3 }),
    Object.freeze({ id: 'knowledge', label: '🧠 Knowledge', key: null, mechanism: 'lorebook', defaultPriority: 4, advisory: true }),
]);

/** Lookup by setExtensionPrompt key. */
const SPEC_BY_KEY = new Map(BUDGET_MODULE_SPECS.filter((s) => s.key !== null).map((s) => [s.key, s]));

/** Hard numeric bounds for every stored field (the panel clamps the same way). */
export const BUDGET_LIMITS = Object.freeze({
    priorityMin: 1,
    priorityMax: 9,
    capMax: 2_000_000,
    overrideMax: 10_000_000,
});

/** The observe-mode defaults a fresh chat starts from (all caps off). */
export const DEFAULT_BUDGET_SETTINGS = Object.freeze({
    enforce: false,
    contextLimitOverride: 0,
    globalHardCap: 0,
    modules: Object.freeze({
        world_state: Object.freeze({ priority: 1, softCap: 0, hardCap: 0 }),
        interiority: Object.freeze({ priority: 1, softCap: 0, hardCap: 0 }),
        chronicle: Object.freeze({ priority: 2, softCap: 0, hardCap: 0 }),
        story_planner: Object.freeze({ priority: 3, softCap: 0, hardCap: 0 }),
        knowledge: Object.freeze({ priority: 4, softCap: 0, hardCap: 0 }),
    }),
});

// ─── Settings: read / normalize / save ────────────────────────────────────────

/** Clamp any finite number into [min, max]; only non-numerics fall back. */
function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Normalize any stored/raw record onto the canonical settings shape.
 * Chat metadata is foreign-sourced data (imports, older builds, hand edits),
 * so every field is individually clamped and an unusable field falls back to
 * its default rather than poisoning enforcement.
 *
 * @returns {{enforce: boolean, contextLimitOverride: number, globalHardCap: number,
 *            modules: Record<string, {priority: number, softCap: number, hardCap: number}>}}
 */
export function normalizeBudgetSettings(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const modules = {};
    for (const spec of BUDGET_MODULE_SPECS) {
        const def = DEFAULT_BUDGET_SETTINGS.modules[spec.id];
        const m = (src.modules && typeof src.modules === 'object' && src.modules[spec.id]
            && typeof src.modules[spec.id] === 'object') ? src.modules[spec.id] : {};
        modules[spec.id] = {
            priority: clampInt(m.priority, BUDGET_LIMITS.priorityMin, BUDGET_LIMITS.priorityMax, def.priority),
            softCap: clampInt(m.softCap, 0, BUDGET_LIMITS.capMax, 0),
            hardCap: clampInt(m.hardCap, 0, BUDGET_LIMITS.capMax, 0),
        };
    }
    return {
        enforce: src.enforce === true,
        contextLimitOverride: clampInt(src.contextLimitOverride, 0, BUDGET_LIMITS.overrideMax, 0),
        globalHardCap: clampInt(src.globalHardCap, 0, BUDGET_LIMITS.capMax, 0),
        modules,
    };
}

/**
 * Test seam for the settings source (the core/diagnostics.js
 * _setScopeKeyResolver pattern): tests swap the reader to avoid needing a
 * live SillyTavern context; production reads this chat's metadata record.
 */
let _settingsReader = null;

/** @param {function|null} fn */
export function _setBudgetSettingsReader(fn) {
    _settingsReader = (typeof fn === 'function') ? fn : null;
}

// ─── Desired-payload registry + displaced set (TODO §2 P2) ────────────────────
//
// Displaced modules used to be one-way: when an incoming high-priority
// payload evicted a lower-priority module, the victim's slot was cleared and
// its snapshot overwritten with an empty payload. If the high-priority
// payload later shrank or cleared, nothing restored the displaced module —
// it stayed absent until an unrelated module-specific event rebuilt it.
//
// The registry keeps each managed module's LAST DESIRED payload + placement
// (what the module wanted to register, separate from what the budget let
// through). After every enforcement, a rebalance pass re-admits previously
// displaced modules (best priority first) into whatever capacity is now
// free, without further displacement. Allocation is no longer history-
// dependent — it represents the best current set of payloads.
//
// Module-level (singleton) state, cleared on page reload and by
// _resetBudgetEnforcementState() between tests.

/**
 * @typedef {{payload: string, enabled: boolean, depth: number, role: number}} DesiredEntry
 */

/** @type {Record<string, DesiredEntry>} module id → last desired payload */
const _desiredPayloads = Object.create(null);

/** @type {Set<string>} module ids currently displaced (slot cleared by budget) */
const _displacedIds = new Set();

/**
 * Wipe the desired-payload registry and displaced set. Test isolation only;
 * production code must not call this (the registry is rebuilt naturally as
 * modules re-apply).
 * @internal
 */
export function _resetBudgetEnforcementState() {
    for (const k of Object.keys(_desiredPayloads)) delete _desiredPayloads[k];
    _displacedIds.clear();
}

/**
 * The canonical, validated per-chat budget settings. Any read failure (no
 * context, corrupt record) resolves to the observe-mode defaults — a budget
 * that cannot be read never enforces.
 *
 * @returns {ReturnType<typeof normalizeBudgetSettings>}
 */
export function getBudgetSettings() {
    try {
        const raw = _settingsReader
            ? _settingsReader()
            : getChatMeta(BUDGET_METADATA_KEY);
        return normalizeBudgetSettings(raw);
    } catch {
        return normalizeBudgetSettings({});
    }
}

/**
 * Persist a patch into this chat's budget record (read-modify-write at the
 * top level; a `modules` patch is merged per module id, not wholesale).
 * Never throws — a failed save returns false and enforcement keeps using the
 * last readable settings.
 *
 * @param {object} patch — { enforce?, contextLimitOverride?, globalHardCap?, modules?: {<id>: {priority?, softCap?, hardCap?}} }
 * @param {object} [deps] — injectable for tests
 * @returns {boolean} whether the record was written
 */
export function saveBudgetSettings(patch, { patchMeta = patchChatMeta } = {}) {
    const current = getBudgetSettings();
    const next = { ...current, ...(patch || {}) };
    if (patch && patch.modules && typeof patch.modules === 'object') {
        next.modules = {};
        for (const spec of BUDGET_MODULE_SPECS) {
            next.modules[spec.id] = {
                ...(current.modules[spec.id] || {}),
                ...(patch.modules[spec.id] || {}),
            };
        }
    }
    try {
        patchMeta(BUDGET_METADATA_KEY, normalizeBudgetSettings(next));
        return true;
    } catch (err) {
        console.warn('[MWT:Budget] Could not save the budget settings:', err?.message || err);
        return false;
    }
}

// ─── Context-limit resolution ────────────────────────────────────────────────

/**
 * Resolve the model's context limit for the "total vs limit" display.
 *
 * Probe order, each guarded (the Environment tab's probe discipline — a
 * fork that lacks a field degrades that source, never the tab):
 *   1. the user's manual override (contextLimitOverride, 0 = auto);
 *   2. ctx.maxContext — a function (live ST exposes max_context through
 *      getContext()) or a plain number;
 *   3. chatCompletionSettings.openai_max_context (OpenAI-style presets);
 *   4. textCompletionSettings.max_context (text-completion presets).
 *
 * @param {object} [deps] — injectable for tests
 * @returns {{ value: number|null, source: string, note: string }}
 *   `value: null` means "unknown" — the panel renders an editable hint, never
 *   a fabricated number.
 */
export function resolveContextLimit({ settings = getBudgetSettings(), ctx = getContextSafe() } = {}) {
    if (settings.contextLimitOverride > 0) {
        return {
            value: settings.contextLimitOverride,
            source: 'override',
            note: 'Your manual override (set on the Budget tab).',
        };
    }
    try {
        const mc = ctx?.maxContext;
        if (typeof mc === 'function') {
            const n = Number(mc.call(ctx));
            if (Number.isFinite(n) && n > 0) {
                return { value: Math.round(n), source: 'ctx.maxContext', note: 'SillyTavern context API (ctx.maxContext).' };
            }
        }
        if (typeof mc === 'number' && Number.isFinite(mc) && mc > 0) {
            return { value: Math.round(mc), source: 'ctx.maxContext', note: 'SillyTavern context API (ctx.maxContext).' };
        }
    } catch { /* guarded probe — fall through */ }
    try {
        const n = Number(ctx?.chatCompletionSettings?.openai_max_context);
        if (Number.isFinite(n) && n > 0) {
            return { value: Math.round(n), source: 'chatCompletionSettings.openai_max_context', note: 'The active chat-completion preset (openai_max_context).' };
        }
    } catch { /* guarded probe — fall through */ }
    try {
        const n = Number(ctx?.textCompletionSettings?.max_context);
        if (Number.isFinite(n) && n > 0) {
            return { value: Math.round(n), source: 'textCompletionSettings.max_context', note: 'The active text-completion preset (max_context).' };
        }
    } catch { /* guarded probe — fall through */ }
    return {
        value: null,
        source: 'unknown',
        note: 'No context limit could be read on this build — set a manual override on the Budget tab.',
    };
}

// ─── Truncation (structure-preserving) ───────────────────────────────────────

/**
 * Characters per token used as a STARTING POINT for the binary search when
 * the live tokenizer is unavailable. The cut is then MEASURED with
 * estimateTokens() (which may call SillyTavern's real tokenizer) and
 * refined, so the fixed ratio is only a seed — the final result honors the
 * same estimator the decision used, never a hard-coded density assumption.
 */
const CHARS_PER_TOKEN_SEED = 4.5;

/**
 * Build the truncation marker that states the omitted size.
 * @param {number} omittedTokens
 * @returns {string}
 */
function truncationMarker(omittedTokens) {
    return `[…truncated ~${Math.max(1, omittedTokens).toLocaleString()} tokens]`;
}

/**
 * Measure a string with the SAME estimator the budget decision uses (which
 * may be SillyTavern's live tokenizer, not the chars/4.5 fallback). Guarded
 * so a throwing tokenizer never breaks truncation.
 */
function measureTokens(text) {
    try {
        return estimateTokens(text);
    } catch {
        return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN_SEED);
    }
}

/**
 * Find, by bounded binary search, the largest `take` in [0, maxTake] such
 * that `build(take)` measures at most `capTokens`. `build` must be
 * non-decreasing in `take`. Returns the chosen `take` (0 if even the empty
 * build exceeds the cap).
 *
 * This is what makes the soft cap honor a REAL tokenizer: instead of cutting
 * at `capTokens * 4.5` characters and trusting the ratio, we cut and then
 * MEASURE the complete result (marker + closing tags included) with
 * estimateTokens(), narrowing until it fits. For CJK / emoji-heavy / code-like
 * text whose tokenizer density differs from 4.5 chars/token, the result now
 * actually respects the configured cap.
 *
 * @param {number} capTokens
 * @param {number} maxTake
 * @param {(take: number) => string} build
 * @returns {number}
 */
function binarySearchTake(capTokens, maxTake, build) {
    if (maxTake <= 0) return 0;
    let lo = 0;
    let hi = maxTake;
    let best = 0;
    // Bounded: ~log2(maxTake) iterations, capped at 40 for safety.
    let guard = 40;
    while (lo <= hi && guard-- > 0) {
        const mid = Math.floor((lo + hi) / 2);
        if (measureTokens(build(mid)) <= capTokens) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

/**
 * Truncate a single wrapper block's INNER body so the WHOLE block (open tag
 * + body + marker + close tag) measures at most `capTokens`. The closing
 * tag is ALWAYS re-emitted — the model never receives a half-open tag.
 *
 * @param {string} openTag  — the leading `<tag>\n`
 * @param {string} inner    — the body between the tags
 * @param {string} closeTag — the trailing `\n</tag>`
 * @param {number} capTokens
 * @returns {string} an empty string when even the wrapper delimiters do not fit
 */
function truncateBlock(openTag, inner, closeTag, capTokens) {
    const fullOpen = measureTokens(openTag);
    const fullClose = measureTokens(closeTag);
    // If the wrapper delimiters alone exceed the cap, do not emit an empty
    // block. An empty announced section is both misleading and over budget;
    // the caller will retain its visible truncation marker instead.
    if (fullOpen + fullClose > capTokens) {
        return '';
    }
    // First try WITHOUT a marker: the whole body might fit, in which case the
    // block passes through unmarked (a partial-body cut is not a truncation).
    if (measureTokens(`${openTag}${inner}${closeTag}`) <= capTokens) {
        return `${openTag}${inner}${closeTag}`;
    }
    // Otherwise cut the body. The marker's omitted count is an estimate
    // (the marker says "~") based on the seed ratio over the dropped chars.
    const omittedEstimate = Math.max(1, Math.ceil(inner.length / CHARS_PER_TOKEN_SEED));
    const marker = truncationMarker(omittedEstimate);
    const markerNewlines = '\n\n';
    const fixed = `${openTag}${marker}${markerNewlines}${closeTag}`;
    const fixedTokens = measureTokens(fixed);
    if (fixedTokens > capTokens) {
        // Even the marker-and-wrapper representation cannot fit. Let the
        // caller omit this block and use its own standalone marker.
        return '';
    }
    if (capTokens - fixedTokens <= 0) {
        // Only the marker + wrapper fit; keep the boundary + marker, no body.
        return fixed;
    }
    const take = binarySearchTake(
        capTokens,
        inner.length,
        (n) => `${openTag}${inner.slice(0, n)}${markerNewlines}${marker}${closeTag}`,
    );
    return `${openTag}${inner.slice(0, take)}${markerNewlines}${marker}${closeTag}`;
}

/**
 * A parsed segment of the payload: either a complete wrapper block
 * (`<tag>\n…\n</tag>`) or a raw (untagged) text run.
 * @typedef {{kind: 'block', open: string, inner: string, close: string, raw: string}
 *           | {kind: 'raw', raw: string}} Segment
 */

/**
 * Split a payload into a sequence of wrapper blocks and raw text runs.
 *
 * World State deliberately passes a fully-assembled, unwrapped payload that
 * may contain two sibling blocks (`<mwt_world_state>…</mwt_world_state>`
 * followed by `<mwt_plot_seeds>…</mwt_plot_seeds>`), separated by raw text
 * (typically `\n\n`). The generic truncator must understand that SEQUENCE:
 * dropping/truncating from block bodies while ALWAYS re-emitting each
 * started block's closing tag, so the rest of the prompt never lands inside
 * a half-open MWT tag.
 *
 * Only the `wrapInTag` shape (`<tag>\n…\n</tag>`) is treated as a block;
 * a half-open wrapper (no matching close) is kept as raw text so the legacy
 * "defensive fallback to a plain cut" behavior is preserved.
 *
 * @param {string} str
 * @returns {Segment[]}
 */
function parseSegments(str) {
    const segments = [];
    let i = 0;
    const openRe = /<([A-Za-z0-9_]+)>\n/g;
    let m;
    while ((m = openRe.exec(str)) !== null) {
        const openStart = m.index;
        if (openStart > i) segments.push({ kind: 'raw', raw: str.slice(i, openStart) });
        const tag = m[1];
        const open = m[0];
        const close = `\n</${tag}>`;
        const closeStart = str.indexOf(close, openStart + open.length);
        if (closeStart === -1) {
            // Half-open wrapper: treat the rest (including the open tag) as
            // raw text — no closing tag to preserve.
            segments.push({ kind: 'raw', raw: str.slice(openStart) });
            return segments;
        }
        const inner = str.slice(openStart + open.length, closeStart);
        const raw = str.slice(openStart, closeStart + close.length);
        segments.push({ kind: 'block', open, inner, close, raw });
        i = closeStart + close.length;
        openRe.lastIndex = i;
    }
    if (i < str.length) segments.push({ kind: 'raw', raw: str.slice(i) });
    return segments;
}

/**
 * Truncate a raw (untagged) text run to a token cap with a visible marker.
 * @param {string} raw
 * @param {number} capTokens
 * @returns {string}
 */
function truncateRaw(raw, capTokens) {
    const str = String(raw ?? '');
    const cap = Math.max(0, Math.floor(capTokens));
    if (measureTokens(str) <= cap) return str;
    const omitted = Math.max(1, Math.ceil(str.length / CHARS_PER_TOKEN_SEED));
    const marker = truncationMarker(omitted);
    const build = (n) => `${str.slice(0, n)}\n${marker}`;
    const markerTokens = measureTokens(`\n${marker}`);
    if (cap - markerTokens <= 0) {
        // The marker alone is the whole budget: emit just the marker.
        return marker;
    }
    const take = binarySearchTake(cap, str.length, build);
    return build(take);
}

/**
 * Truncate a payload to a token cap, preserving structure and stating the
 * omitted size. Rules:
 *   - The cut is MEASURED with estimateTokens() (the same estimator the
 *     decision uses, which may be SillyTavern's live tokenizer) via a bounded
 *     binary search — never a hard-coded chars/token ratio. The complete
 *     result (marker + closing tags) is re-measured, so the configured cap is
 *     actually honored for CJK / emoji-heavy / code-like text too.
 *   - The payload is parsed into a sequence of wrapper blocks
 *     (`<tag>\n…\n</tag>`, the wrapInTag shape) and raw text runs. Blocks are
 *     greedily included whole from the front; when a block does not fit, its
 *     INNER body is cut and its closing tag is ALWAYS re-emitted, so the
 *     model never receives a half-open tag. Later blocks that never start
 *     contribute no dangling open tag. This is what makes a World State soft
 *     cap safe across its two sibling `<mwt_world_state>` / `<mwt_plot_seeds>`
 *     blocks.
 *   - The marker states the omitted size: `[…truncated ~N tokens]`.
 *   - A payload with no wrapper is cut directly.
 *
 * @param {string} payload
 * @param {number} capTokens — maximum tokens for the RESULT (marker + tags
 *   included)
 * @returns {string}
 */
export function truncatePayloadForTokens(payload, capTokens) {
    const str = String(payload ?? '');
    const cap = Math.max(0, Math.floor(capTokens));
    if (measureTokens(str) <= cap) return str;

    const segments = parseSegments(str);

    // Fast path: a single block (the common one-module case) or a single raw
    // run — no inter-block separator accounting needed.
    if (segments.length === 1) {
        const seg = segments[0];
        if (seg.kind === 'block') {
            return truncateBlock(seg.open, seg.inner, seg.close, cap);
        }
        return truncateRaw(seg.raw, cap);
    }

    // Multi-segment path: greedily include whole leading segments, reserving
    // room for a visible marker before each one. That reservation matters when
    // a complete later sibling is omitted: dropping it must not silently turn
    // a structured payload into an apparently complete one.
    let out = '';
    for (let idx = 0; idx < segments.length; idx++) {
        const seg = segments[idx];
        const omitted = Math.max(1, Math.ceil(str.slice(out.length + seg.raw.length).length / CHARS_PER_TOKEN_SEED));
        const marker = truncationMarker(omitted);
        const markerSuffix = `${out ? '\n' : ''}${marker}`;
        if (measureTokens(`${out}${seg.raw}${markerSuffix}`) <= cap) {
            out += seg.raw;
            continue;
        }

        const remaining = cap - measureTokens(out);
        const partial = seg.kind === 'block'
            ? truncateBlock(seg.open, seg.inner, seg.close, remaining)
            : truncateRaw(seg.raw, remaining);
        if (partial) return `${out}${partial}`;

        // The next block cannot even announce itself. Earlier complete
        // segments were admitted only with this suffix reserved, so this is
        // still measured within the cap and visibly reports the omission.
        return `${out}${markerSuffix}`;
    }
    // The source was over cap, so reaching here can only be an estimator edge
    // case. Keep the established measured raw fallback rather than returning
    // an unmarked over-cap payload.
    return truncateRaw(out || str, cap);
}

// ─── Enforcement engine ──────────────────────────────────────────────────────

/**
 * Rank a module for drop-order purposes: LOWER rank = dropped FIRST.
 * Priority is primary (a priority-4 module drops before a priority-1 one);
 * the spec table's index is the tie-break (earlier row survives).
 */
function dropRank(spec, settings) {
    const m = settings.modules[spec.id];
    const priority = (m && Number.isFinite(m.priority)) ? m.priority : spec.defaultPriority;
    return { priority, index: BUDGET_MODULE_SPECS.indexOf(spec) };
}

/** True when module A would be dropped before module B (strictly worse to keep). */
function dropsBefore(a, b, settings) {
    const ra = dropRank(a, settings);
    const rb = dropRank(b, settings);
    if (ra.priority !== rb.priority) return ra.priority > rb.priority;  // worse (higher) priority drops first
    return ra.index > rb.index;                                          // later in the table drops first
}

/**
 * Compute the drop order for the CURRENT settings — what the panel shows and
 * what enforcement displaces by. Listed FIRST = dropped FIRST (lowest
 * priority to keep). Advisory Knowledge is excluded: enforcement never
 * touches it (its payload never reaches MWT's seam), so showing it in the
 * actionable drop order implied a no-op configuration could be enforced.
 *
 * @param {object} [deps] — injectable for tests
 * @returns {Array<{id: string, label: string, priority: number, advisory: boolean}>}
 */
export function modelDropOrder({ settings = getBudgetSettings() } = {}) {
    return BUDGET_MODULE_SPECS.filter((spec) => spec.advisory !== true)
        .sort((a, b) => (dropsBefore(a, b, settings) ? -1 : (dropsBefore(b, a, settings) ? 1 : 0)))
        .map((spec) => ({
            id: spec.id,
            label: spec.label,
            priority: settings.modules[spec.id]?.priority ?? spec.defaultPriority,
            advisory: spec.advisory === true,
        }));
}

/**
 * Plan (without executing) the budget decision for one incoming payload.
 *
 * The pure brain of enforceInjectionBudget — split out so the panel can
 * model "what WOULD happen" for every module without touching any
 * registered slot (the observe mode every chat starts in). Execution stays
 * with the seam because displacement must go through the REAL
 * setExtensionPrompt clear path.
 *
 * Decision order (the enforcement rules the user opted into):
 *   1. module hard cap exceeded              → drop (clear);
 *   2. module soft cap exceeded              → derive the soft-capped
 *      candidate (truncated with a marker stating the omitted token count);
 *   3. global hard cap exceeded              → displace strictly-worse-priority
 *      modules (their slots clear through the seam) so the CANDIDATE fits;
 *      if it still cannot fit, drop it — the budget protects what is already
 *      registered over what is new.
 *
 * The soft cap is applied BEFORE the global cap (TODO §2 P1): a payload is
 * never dropped because its RAW size does not fit beside an equal/higher-
 * priority module when its configured soft-capped size would. The candidate
 * the global step evaluates is the soft-capped payload, measured with the
 * same estimator the decision uses — so the global allocation accounts for
 * the truncated size, not the raw one. The final action is `truncate` when a
 * soft cap was applied and the candidate is admitted, `keep` otherwise.
 *
 * @param {object} p
 * @param {object} p.spec — the BUDGET_MODULE_SPECS row for the payload's key
 * @param {string} p.payload — the payload the module wants to register
 * @param {object} p.settings — normalized budget settings
 * @param {object} [p.others] — other modules' live registered tokens, keyed
 *   by module id (advisory Knowledge's stored total included for context)
 * @returns {{action: 'keep'|'truncate'|'drop', payload: string,
 *            tokensBefore: number, tokensAfter: number, capTokens: number|null,
 *            reason: string, displaced: string[], dropSource: string|null}}
 */
export function planBudgetDecision({ spec, payload, settings, others = {} }) {
    const tokensBefore = estimateTokens(payload);
    const m = settings.modules[spec.id] || { priority: spec.defaultPriority, softCap: 0, hardCap: 0 };
    const displaced = [];

    // 1. Module hard cap — the module's own ceiling. Exceeding it drops the
    //    payload outright (a clear, not a shrink).
    if (m.hardCap > 0 && tokensBefore > m.hardCap) {
        return {
            action: 'drop',
            payload: '',
            tokensBefore,
            tokensAfter: 0,
            capTokens: m.hardCap,
            reason: `module hard cap ${m.hardCap.toLocaleString()} exceeded (${tokensBefore.toLocaleString()} tokens) — injection dropped`,
            displaced,
            dropSource: 'module-hard-cap',
        };
    }

    // 2. Module soft cap — derive the soft-capped CANDIDATE first. The global
    //    step below evaluates this candidate's measured size, not the raw
    //    payload's, so a user who configured a module to shrink to a safe
    //    size does not lose the whole injection when its raw size does not
    //    fit beside an equal/higher-priority module (TODO §2 P1). The
    //    candidate is MEASURED (the marker + closing tags included), so
    //    tokensAfter is the real size, not the cap value.
    let candidate = payload;
    let candidateTokens = tokensBefore;
    let softCapTokens = null;
    if (m.softCap > 0 && tokensBefore > m.softCap) {
        softCapTokens = m.softCap;
        candidate = truncatePayloadForTokens(payload, m.softCap);
        candidateTokens = estimateTokens(candidate);
    }

    // 3. Global hard cap. The enforcement rule: DROP lowest-priority first.
    //    The CANDIDATE (soft-capped) displaces STRICTLY-worse registered
    //    modules (equal-or-better are protected — the tie-break makes "equal"
    //    fully ordered: an earlier spec row survives an equal fight). If it
    //    still cannot fit, the incoming is dropped and NOTHING is displaced —
    //    clearing victims to not admit the newcomer would waste them. The
    //    global cap never truncates further; truncation is the soft cap's job.
    if (settings.globalHardCap > 0) {
        const othersTokens = Object.values(others).reduce((s, n) => s + (Number(n) || 0), 0);
        if (candidateTokens + othersTokens > settings.globalHardCap) {
            const ranked = BUDGET_MODULE_SPECS
                .filter((s) => s !== spec && s.key !== null && (others[s.id] || 0) > 0
                    && dropsBefore(s, spec, settings))
                .sort((a, b) => (dropsBefore(a, b, settings) ? -1 : (dropsBefore(b, a, settings) ? 1 : 0)));
            let remainingOthers = othersTokens;
            const wouldDisplace = [];
            for (const victim of ranked) {
                if (candidateTokens + remainingOthers <= settings.globalHardCap) break;
                remainingOthers -= (others[victim.id] || 0);
                wouldDisplace.push(victim.id);
            }
            if (candidateTokens + remainingOthers > settings.globalHardCap) {
                return {
                    action: 'drop',
                    payload: '',
                    tokensBefore,
                    tokensAfter: 0,
                    capTokens: settings.globalHardCap,
                    reason: `global hard cap ${settings.globalHardCap.toLocaleString()} exceeded even after displacing ${wouldDisplace.length} lower-priority module(s) — injection dropped`,
                    displaced: [],
                    dropSource: 'global-hard-cap',
                };
            }
            displaced.push(...wouldDisplace);
        }
    }

    // The candidate (soft-capped or raw) fits within the global cap. Preserve
    // the final action as `truncate` when a soft cap was applied, `keep`
    // otherwise (TODO §2 P1). tokensAfter is the MEASURED candidate size.
    if (softCapTokens !== null) {
        return {
            action: 'truncate',
            payload: candidate,
            tokensBefore,
            tokensAfter: candidateTokens,
            capTokens: softCapTokens,
            reason: `over cap ${softCapTokens.toLocaleString()} tokens — truncated with a marker`,
            displaced,
            dropSource: null,
        };
    }

    return {
        action: 'keep',
        payload,
        tokensBefore,
        tokensAfter: candidateTokens,
        capTokens: null,
        reason: 'within all caps',
        displaced,
        dropSource: null,
    };
}

// ─── The seam hook ───────────────────────────────────────────────────────────

/**
 * Registered tokens of every OTHER seam module right now — the `others` map
 * the planner needs, sourced from the Phase 2 recorded snapshots (what each
 * module ACTUALLY registered, never a rebuild). Knowledge is deliberately
 * absent: its lorebook reaches the prompt through ST's keyword activation,
 * not this seam, so counting its stored library here would over-count the
 * global cap (the Health tab's never-sum-across-kinds rule).
 *
 * @param {string} [excludeKey] — the incoming payload's key (its own tokens
 *   are not "others")
 * @returns {Record<string, number>} module id → registered tokens
 */
export function registeredOthersTokens(excludeKey = null) {
    const out = {};
    try {
        const snaps = getAllInjectedSnapshots();
        for (const spec of BUDGET_MODULE_SPECS) {
            if (spec.key === null || spec.key === excludeKey) continue;
            const snap = snaps[spec.key];
            if (snap?.enabled && typeof snap.payload === 'string' && snap.payload) {
                out[spec.id] = estimateTokens(snap.payload);
            }
        }
    } catch { /* guarded — enforcement treats "unreadable" as "no others" */ }
    return out;
}

/**
 * Clear every budget-managed module's injection slot AND diagnostics snapshot
 * at the start of a chat change — the two-phase budget lifecycle's reset
 * phase (TODO §2 P1).
 *
 * WHY: the Phase 2 injection snapshots are intentionally GLOBAL (they carry
 * no scope — see core/diagnostics.js), and the chat-change reapply runs the
 * module handlers SEQUENTIALLY (World State, Chronicle, Knowledge, Story
 * Planner, Interiority). Without a reset, modules later in that order still
 * see the PREVIOUS chat's snapshots through registeredOthersTokens(), so an
 * old-chat payload can reject a new-chat injection purely because of the
 * order the handlers ran in. Calling this first means every module sees an
 * empty `others` map at the start of the new chat, then registers only the
 * new chat's desired payloads.
 *
 * Never throws — a reset failure keeps the last readable snapshots (the
 * never-break-injection contract). Advisory Knowledge (no seam key) is
 * skipped: its lorebook never reaches MWT's seam, so there is no slot to
 * clear.
 *
 * @param {object} [deps] — injectable for tests
 * @param {Function} [deps.setEP] — the setExtensionPrompt accessor
 * @returns {void}
 */
export function resetBudgetInjections({ setEP = getSetExtensionPrompt() } = {}) {
    try {
        if (typeof setEP === 'function') {
            for (const spec of BUDGET_MODULE_SPECS) {
                if (spec.key === null) continue;
                try {
                    // Clear at depth 0/role system — the same clear shape every
                    // disabled path uses. A real re-apply overwrites these with
                    // the new chat's placement moments later.
                    setEP(spec.key, '', 1, 0, undefined, 0);
                } catch (err) {
                    console.warn(`[MWT:Budget] Could not clear ${spec.id} slot on chat change:`, err?.message || err);
                }
            }
        }
        // Reset the Phase 2 snapshots the planner reads (registeredOthersTokens)
        // so the new chat starts from an empty `others` map. clearInjections is
        // the whole-snapshot wipe; the seam re-records as modules re-apply.
        clearInjections();
        // Desired payloads belong to the previous chat just as much as the
        // snapshots do. Never let a destination chat restore a module from
        // source-chat state after its own capacity later changes.
        _resetBudgetEnforcementState();
        record({
            level: 'debug',
            module: 'budget',
            event: 'budget_injections_reset',
            detail: { reason: 'chat_change' },
        });
    } catch (err) {
        console.warn('[MWT:Budget] Reset of injections on chat change failed (non-fatal):', err?.message || err);
    }
}

/**
 * Pick the OBSERVE-mode diagnostics event for a plan, accounting for both the
 * planned action AND displacement (TODO §2 P2 / bug report [P2]).
 *
 * A global-cap plan can return `action: 'keep'` plus one or more `displaced`
 * modules (the incoming fits after evicting lower-priority context), or
 * `action: 'truncate'` plus displacement (a soft-capped payload that still
 * needed to evict context). Mapping every non-drop plan to
 * `budget_would_truncate` reported the wrong operation exactly when users
 * are validating drop priority before enabling enforcement. The distinct
 * events make observe mode truthful.
 *
 * @param {{action: string, displaced: string[]}} plan
 * @returns {string}
 */
function observeEventFor(plan) {
    const hasDisplaced = Array.isArray(plan.displaced) && plan.displaced.length > 0;
    if (plan.action === 'drop') return 'budget_would_drop';
    if (plan.action === 'truncate' && hasDisplaced) return 'budget_would_truncate_and_displace';
    if (hasDisplaced) return 'budget_would_displace';
    return 'budget_would_truncate';
}

/**
 * Re-admit displaced modules after the shared injection seam has recorded a
 * newly active payload. This is deliberately a POST-registration hook: the
 * planner reads diagnostics snapshots, and the incoming snapshot does not
 * exist until core/injection.js has completed its setExtensionPrompt call.
 *
 * Candidates are considered best-priority first. A restoration is admitted
 * only when it fits the CURRENT active set without displacing anything else;
 * this prevents a rebalance from starting an eviction loop. A candidate's own
 * soft cap is still honored by planBudgetDecision().
 *
 * @param {object} [deps] — injectable for tests
 * @param {object} [deps.settings]
 * @param {Function} [deps.setEP]
 * @returns {void}
 */
export function rebalanceBudgetInjections({
    settings = getBudgetSettings(),
    setEP = getSetExtensionPrompt(),
} = {}) {
    if (!settings?.enforce || _displacedIds.size === 0) return;
    try {
        const candidates = BUDGET_MODULE_SPECS
            .filter((spec) => spec.key !== null && _displacedIds.has(spec.id))
            .sort((a, b) => (dropsBefore(a, b, settings) ? 1 : (dropsBefore(b, a, settings) ? -1 : 0)));

        for (const spec of candidates) {
            const desired = _desiredPayloads[spec.id];
            if (!desired?.enabled || !desired.payload) {
                _displacedIds.delete(spec.id);
                continue;
            }
            const plan = planBudgetDecision({
                spec,
                payload: desired.payload,
                settings,
                others: registeredOthersTokens(spec.key),
            });
            // Restoration must not evict another active module. A module that
            // still cannot fit remains displaced and will be retried after a
            // later managed payload changes.
            if (plan.action === 'drop' || plan.displaced.length > 0) continue;

            if (typeof setEP === 'function') {
                setEP(spec.key, plan.payload, 1, desired.depth, undefined, desired.role);
            }
            recordInjection({
                key: spec.key,
                payload: plan.payload,
                role: desired.role,
                depth: desired.depth,
                enabled: true,
            });
            _displacedIds.delete(spec.id);
            record({
                level: 'info',
                module: 'budget',
                event: 'budget_restored',
                detail: {
                    module: spec.id,
                    action: plan.action,
                    tokens: plan.tokensAfter,
                },
            });
        }
    } catch (err) {
        console.warn('[MWT:Budget] Rebalance skipped (non-fatal):', err?.message || err);
    }
}

/**
 * Forget a module's desired payload when its shared injection seam is
 * explicitly cleared/disabled, then try to restore other displaced modules
 * into the newly-freed capacity. This is separate from enforceInjectionBudget
 * because core/injection.js returns early for disabled/empty applies.
 *
 * @param {string} key — setExtensionPrompt key being cleared
 * @param {object} [deps]
 * @param {Function} [deps.setEP]
 * @returns {void}
 */
export function clearDesiredBudgetInjection(key, { setEP = getSetExtensionPrompt() } = {}) {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) return;
    delete _desiredPayloads[spec.id];
    _displacedIds.delete(spec.id);
    rebalanceBudgetInjections({ setEP });
}

/**
 * THE seam hook. core/injection.js applyExtensionPromptInjection() calls this
 * with the fully-built payload before registering it, and registers what
 * comes back. Contract:
 *
 *   - NEVER THROWS. On any internal failure the original payload and enabled
 *     flag pass through untouched — the budget can observe, advise, and (when
 *     opted in) enforce, but a budget bug can never break injection itself.
 *   - OBSERVE mode (default): returns the payload unchanged. A non-'keep'
 *     plan is recorded as a diagnostics event so the Log tab shows what
 *     enforcement WOULD have done.
 *   - ENFORCE mode: returns the planned payload ('' + enabled:false for a
 *     drop; the truncated string for a truncate), clears displaced modules'
 *     slots through the same seam surface (setExtensionPrompt clear +
 *     recordInjection so the 💉 Injection tab stays truthful), and records
 *     the decision.
 *
 * @param {object} opts
 * @param {string} opts.key — setExtensionPrompt key
 * @param {string} opts.payload — the payload about to be registered
 * @param {boolean} opts.enabled — whether the apply is active
 * @param {number} [opts.depth] — the placement depth the apply will use
 * @param {number} [opts.role] — the placement role number the apply will use
 * @param {object} [opts.deps] — injectable for tests: { settings, setEP, now }
 * @returns {{payload: string, enabled: boolean, decision: object|null}}
 *   `decision` is the plan actually applied (null = no decision was needed
 *   or the budget was unavailable).
 */
export function enforceInjectionBudget({ key, payload, enabled, depth = 0, role = 0 }, {
    settings = getBudgetSettings(),
    setEP = getSetExtensionPrompt(),
} = {}) {
    const passThrough = { payload, enabled, decision: null };
    try {
        const spec = SPEC_BY_KEY.get(key);
        // Unknown keys (a future module, a test key) are not budget-managed.
        if (!spec) return passThrough;

        // Record the module's DESIRED payload + placement (TODO §2 P2). This
        // is what the module WANTED to register, kept separate from what the
        // budget lets through, so a rebalance pass can re-admit it later if it
        // was displaced. A drop still records the desired payload — the module
        // wanted to inject it; the budget refused this turn.
        _desiredPayloads[spec.id] = { payload: String(payload ?? ''), enabled: !!enabled, depth: Number(depth) || 0, role: Number(role) || 0 };

        const plan = planBudgetDecision({
            spec,
            payload,
            settings,
            others: registeredOthersTokens(key),
        });

        if (plan.action === 'keep' && plan.displaced.length === 0) {
            // The incoming payload is admitted unchanged; it is no longer
            // displaced (it has a live slot again).
            _displacedIds.delete(spec.id);
            return { payload, enabled, decision: plan };
        }

        // Observe mode (the default): plan only — record what enforcement
        // WOULD have done (one event per over-cap apply, the same rate the
        // injection_applied event already contributes) and change nothing.
        if (!settings.enforce) {
            // Bug 6 fix: derive the event name from BOTH plan.action and
            // plan.displaced. A global-cap plan can return action:'keep' plus
            // one or more displaced modules (the incoming fits after evicting
            // lower-priority context) — that is a displacement, not a
            // truncation, so it must not be logged as budget_would_truncate.
            // The Log tab and any console/debug consumers rely on this being
            // the operation enforcement would actually perform.
            const event = observeEventFor(plan);
            record({
                level: plan.action === 'drop' ? 'warn' : 'info',
                module: 'budget',
                event,
                detail: {
                    module: spec.id,
                    reason: plan.reason,
                    tokens: plan.tokensBefore,
                    displaced: plan.displaced,
                    mode: 'observe',
                },
            });
            return passThrough;
        }

        // ENFORCE mode. Execute displacement first: clear each victim's slot
        // exactly the way a disabled apply does, and record the cleared state
        // so the Injection tab's snapshot never shows a payload the budget
        // already removed. Each victim is marked displaced (TODO §2 P2) so the
        // rebalance pass below can re-admit it when capacity frees.
        for (const id of plan.displaced) {
            const victim = BUDGET_MODULE_SPECS.find((s) => s.id === id);
            if (!victim?.key) continue;
            try {
                if (typeof setEP === 'function') {
                    setEP(victim.key, '', 1, 0, undefined, 0);
                }
                recordInjection({ key: victim.key, payload: '', role: 0, depth: 0, enabled: false });
                _displacedIds.add(victim.id);
                record({
                    level: 'warn',
                    module: 'budget',
                    event: 'budget_displaced',
                    detail: { module: victim.id, by: spec.id, cap: plan.capTokens },
                });
            } catch (err) {
                console.warn(`[MWT:Budget] Could not displace ${victim.id}:`, err?.message || err);
            }
        }

        if (plan.action === 'drop') {
            // A global-cap drop is the same recoverable state as an evicted
            // lower-priority module: its desired payload is retained and may
            // fit after another injection shrinks. A module-hard-cap drop is
            // intentionally excluded because re-planning cannot admit it.
            if (plan.dropSource === 'global-hard-cap') _displacedIds.add(spec.id);
            record({
                level: 'warn',
                module: 'budget',
                event: 'budget_dropped',
                detail: { module: spec.id, reason: plan.reason, tokens: plan.tokensBefore },
            });
            return { payload: '', enabled: false, decision: plan };
        }
        if (plan.action === 'truncate') {
            record({
                level: 'info',
                module: 'budget',
                event: 'budget_truncated',
                detail: { module: spec.id, reason: plan.reason, tokensBefore: plan.tokensBefore, tokensAfter: plan.tokensAfter },
            });
            return { payload: plan.payload, enabled, decision: plan };
        }
        return { payload, enabled, decision: plan };
    } catch (err) {
        // The never-break-injection contract.
        console.warn('[MWT:Budget] Enforcement skipped (internal error):', err?.message || err);
        return passThrough;
    }
}
