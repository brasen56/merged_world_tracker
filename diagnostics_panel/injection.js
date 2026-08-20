/**
 * diagnostics_panel/injection.js — Tab 4: Injection (Diagnostics Phase 9).
 *
 * "What is MWT actually putting in the narrator's prompt right now, where, and
 * why there?" (phases doc §II.4 Phase 9, design §I.5 Tab 4): one row per
 * module — on/off · gate · resolved role and depth WITH PROVENANCE · token
 * estimate · the Phase 2 recorded payload (frozen snapshot + age, never a
 * rebuild — see the stale-arc note in core/injection.js) — plus the loud
 * Knowledge lorebook caveat the design makes mandatory: Knowledge injects
 * through lorebook entries, not setExtensionPrompt, so its entries stay
 * active in SillyTavern even when the panic switch kills injection
 * (closes `TODO.md` §4 "Panic switch UI clarity" as a side effect).
 *
 * Placement provenance (design §I.4.6's "depth chains are module-local"):
 * each injecting module now exports resolveInjectionPlacement() — the SAME
 * function its apply path calls — so the tab reports precedence
 * ('global' | 'module' | 'builtin') from the single source of truth instead
 * of mirroring it. Knowledge has no placement (lorebook mechanism) and no
 * injection flag; its two gates (enableKnowledge / panic switch) govern
 * SCANNING.
 *
 * DOM-free by design (the Phase 6 health.js pattern): the snapshot is a plain
 * object, the markup lives in diagnostics_panel/render.js, every dependency is
 * injectable, and every accessor call is individually guarded — one throwing
 * dependency degrades its own field plus an `errors` note, never the tab.
 *
 * Direct imports throughout for core singletons (NOT via core/index.js): the
 * barrel is aliased to test/stubs/core.js under Vitest, and this module must
 * read the real helpers + version regardless (the barrel→stub alias trap,
 * §II.3). Module files are imported exactly the way the appliers themselves
 * are, so the tab and the injection paths see one live graph.
 */

import { MWT_VERSION } from '../core/version.js';
import { getGlobalSettings, injectionAllowed } from '../core/settings.js';
import { getAllInjectedSnapshots } from '../core/diagnostics.js';
import { estimateTokens } from '../core/context.js';
// The shared redaction layer — the ONE place secrets are scrubbed (Phase 5's
// hard gate: every diagnostics surface routes through it; no hand-rolled
// redaction anywhere else). Payloads are chat-derived content that can quote
// secrets (an upstream error pasted into a state document, a token in a card),
// so what this tab SHOWS goes through it too.
import { redactForReport } from '../core/redaction.js';
// Live secret VALUES for the scrub list. report.js is a sibling collector
// (it does not import this module), so there is no cycle; the
// knownSecrets-??-collectKnownSecrets() "safe by default" pattern below is
// lifted from buildReport() — collectKnownSecrets() is fully guarded and
// returns [] with no SillyTavern runtime, keeping this unit-testable in Node.
import { collectKnownSecrets } from './report.js';

// Injection keys + enabled flags + placement resolvers — imported from the
// modules' own files so the tab can never redefine them (single source of
// truth). These are the same modules the live appliers use. World State's
// isInjectionEnabled lives in its data.js (the 3-level settings chain) — the
// same accessor applyWorldStateInjection() consults.
import {
    EXTENSION_PROMPT_KEY as WS_KEY,
    resolveInjectionPlacement as wsResolvePlacement,
} from '../world_state/injection.js';
import { isInjectionEnabled as wsIsInjectionEnabled } from '../world_state/data.js';
import { EXTENSION_PROMPT_KEY as CHRONICLE_KEY } from '../chronicle/data.js';
import {
    isInjectionEnabled as chronicleIsInjectionEnabled,
    resolveInjectionPlacement as chronicleResolvePlacement,
} from '../chronicle/injection.js';
import {
    EXTENSION_PROMPT_KEY as PLAN_KEY,
    isInjectionEnabled as planIsInjectionEnabled,
} from '../story_planner/data.js';
import { resolveInjectionPlacement as planResolvePlacement } from '../story_planner/injection.js';
import { INJECTION_KEY as INTERIORITY_KEY, getInteriorityData } from '../interiority/data.js';
import { resolveInjectionPlacement as interiorityResolvePlacement } from '../interiority/injection.js';

// Module namespaces for the getTotalTokens() accessors (the Phase 6 health.js
// pattern). The five accessors share a name but not a meaning — see
// TOKEN_KINDS in health.js; this tab re-states the distinction via `kind`.
import * as WorldState from '../world_state/index.js';
import * as Chronicle from '../chronicle/index.js';
import * as Knowledge from '../knowledge/index.js';
import * as StoryPlanner from '../story_planner/index.js';
import * as Interiority from '../interiority/index.js';

// ─── Spec tables ──────────────────────────────────────────────────────────────

/**
 * Human labels for the placement `source` strings (stable API — the four
 * resolveInjectionPlacement() helpers must not rename theirs). `module`
 * labels differ per module; specs may carry a `moduleSourceLabel` override.
 */
export const PLACEMENT_SOURCE_LABELS = {
    global: 'global override (Settings tab)',
    module: 'module setting',
    builtin: 'built-in default',
};

/** Numeric setExtensionPrompt roles → names (mirrors roleToNumber()). */
export const ROLE_NUMBERS = { 0: 'system', 1: 'user', 2: 'assistant' };

/** roleName('user') → 1; unknown names → 0 ('system'), like roleToNumber(). */
export function roleNameToNumber(role) {
    if (role === 'user') return 1;
    if (role === 'assistant') return 2;
    return 0;
}

/**
 * The five modules, in panel order (health.js order). Each row states:
 *   - `key`         — the setExtensionPrompt key Phase 2 snapshots land under
 *                     (null for Knowledge: no setExtensionPrompt path).
 *   - `mechanism`   — 'extension-prompt' | 'lorebook' (drives the caveat).
 *   - `isEnabled`   — that module's own injection flag accessor, or null when
 *                     no such flag exists (Knowledge).
 *   - `resolvePlacement` — the module's Phase 9 provenance resolver, or null.
 *   - `tokenKind`   — what its getTotalTokens() measures ('stored' for the
 *                     lorebook corpus; the others are prompt payload).
 */
export const INJECTION_MODULE_SPECS = [
    {
        id: 'world_state', label: '🌍 World State', moduleKey: 'WorldState',
        key: WS_KEY, mechanism: 'extension-prompt', tokenKind: 'injected',
        isEnabled: wsIsInjectionEnabled, resolvePlacement: wsResolvePlacement,
    },
    {
        id: 'chronicle', label: '📜 Chronicle', moduleKey: 'Chronicle',
        key: CHRONICLE_KEY, mechanism: 'extension-prompt', tokenKind: 'injected',
        // Chronicle's "module" depth level is THIS CHAT's injectDepth (chat
        // metadata, Chronicle tab) — not a settings store — so its provenance
        // label says so.
        moduleSourceLabel: "this chat's Chronicle setting",
        isEnabled: chronicleIsInjectionEnabled, resolvePlacement: chronicleResolvePlacement,
    },
    {
        id: 'knowledge', label: '🧠 Knowledge', moduleKey: 'Knowledge',
        key: null, mechanism: 'lorebook', tokenKind: 'stored',
        isEnabled: null, resolvePlacement: null,
        note: 'Injects through lorebook entries — SillyTavern World Info keyword activation — not setExtensionPrompt. The On/Gate columns govern SCANNING; see the caveat above the table.',
    },
    {
        id: 'story_planner', label: '🗺️ Story Planner', moduleKey: 'StoryPlanner',
        key: PLAN_KEY, mechanism: 'extension-prompt', tokenKind: 'injected',
        isEnabled: planIsInjectionEnabled, resolvePlacement: planResolvePlacement,
        note: 'No global depth/role pair exists for Story Planner (deliberately self-contained) — depth comes from its own tab, role is fixed.',
    },
    {
        id: 'interiority', label: '💭 Interiority', moduleKey: 'Interiority',
        key: INTERIORITY_KEY, mechanism: 'extension-prompt', tokenKind: 'injected',
        isEnabled: () => getInteriorityData().enabled !== false,
        resolvePlacement: interiorityResolvePlacement,
    },
];

/** Default module namespaces (overridable per collectInjectionSnapshot()). */
export const DEFAULT_INJECTION_MODULES = {
    world_state: WorldState,
    chronicle: Chronicle,
    knowledge: Knowledge,
    story_planner: StoryPlanner,
    interiority: Interiority,
};

/** The Knowledge caveat, in the two tones the pane/bridge render. */
export const KNOWLEDGE_CAVEAT = {
    normal: 'Knowledge injects through lorebook entries (SillyTavern World Info keyword activation), not setExtensionPrompt — the panic switch and the per-module gates do NOT stop those entries. This is the one MWT injection path no MWT switch controls.',
    panic: 'Knowledge lorebook entries are NOT stopped by the panic switch: they live in SillyTavern World Info books and stay active through keyword activation while every setExtensionPrompt injection is blocked. To stop them, disable the entries/book in SillyTavern\u2019s World Info screen or delete them.',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Coerce a maybe-number to a finite non-negative integer (0 otherwise). */
function toCount(v) {
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? Math.round(n) : 0;
}

/**
 * Defensive shape check for a placement resolver's output: the renderer wants
 * {depth:{value,source}, role:{value,source}} or null — never a half-shape.
 */
function normalisePlacement(p) {
    if (!p || typeof p !== 'object') return null;
    const d = p.depth;
    const r = p.role;
    if (!d || !r) return null;
    if (typeof d.value !== 'number' || !Number.isFinite(d.value)) return null;
    if (typeof r.value !== 'string' || !r.value) return null;
    return {
        depth: { value: d.value, source: String(d.source ?? 'builtin') },
        role: { value: r.value, source: String(r.source ?? 'builtin') },
    };
}

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect the Injection tab snapshot. Read-only by contract (design §I.1):
 * nothing here writes settings, chat metadata, or the diagnostics stores —
 * it only READS the Phase 2 snapshot store, the modules' flags/resolvers,
 * and the global settings.
 *
 * @param {object} [deps]
 * @param {Array<object>} [deps.specs] — INJECTION_MODULE_SPECS (injectable)
 * @param {object} [deps.modules] — id → module namespace (getTotalTokens)
 * @param {object} [deps.settings] — global settings snapshot
 * @param {function(string): boolean} [deps.allowed] — injectionAllowed
 * @param {function(): object} [deps.injections] — getAllInjectedSnapshots
 * @param {function(string): number} [deps.estimate] — estimateTokens
 * @param {string} [deps.version]
 * @param {function(): number} [deps.now]
 * @returns {{generatedAt: number, mwtVersion: string, injectionMasterOff:
 *   boolean, structuralBoundaries: boolean, livePayloads: number,
 *   registeredTokens: number, modules: Array<object>,
 *   warnings: Array<{id: string, level: 'warn'|'fail', text: string}>,
 *   bannerLevel: 'ok'|'warn'|'fail'}} — `registeredTokens` counts ONLY
 *   recorded setExtensionPrompt payloads (Knowledge's stored corpus is never
 *   prompt load and is never summed in — the TOKEN_KINDS rule).
 */
export function collectInjectionSnapshot({
    specs = INJECTION_MODULE_SPECS,
    modules = DEFAULT_INJECTION_MODULES,
    settings = getGlobalSettings(),
    allowed = injectionAllowed,
    injections = getAllInjectedSnapshots,
    estimate = estimateTokens,
    version = MWT_VERSION,
    now = Date.now,
} = {}) {
    const errors = [];
    // Per-field guard (health.js pattern): one throwing accessor degrades its
    // own field and notes the failure — the tab must never blank.
    const call = (label, fn, fallback) => {
        try {
            const v = fn();
            return v === undefined ? fallback : v;
        } catch (err) {
            errors.push(`${label}: ${String(err?.message || err)}`);
            return fallback;
        }
    };

    const masterOff = settings?.injectionMasterOff === true;
    const structuralBoundaries = settings?.structuralBoundaries !== false;

    // The Phase 2 store is read ONCE; rows index into the copy. A throwing
    // read degrades every Registered cell, not the tab.
    const allSnaps = call('injections', () => injections() || {}, {});
    const generatedAt = now();

    const rows = specs.map((spec) => {
        const rowErrors = [];
        const rowCall = (label, fn, fallback) => {
            try {
                const v = fn();
                return v === undefined ? fallback : v;
            } catch (err) {
                rowErrors.push(`${label}: ${String(err?.message || err)}`);
                return fallback;
            }
        };

        const mod = modules?.[spec.id] || {};
        const enabled = spec.isEnabled
            ? rowCall('enabled', () => spec.isEnabled() === true, null)
            : null;
        const gate = rowCall('gate', () => allowed(spec.moduleKey) === true, false);
        const placement = spec.resolvePlacement
            ? rowCall('placement', () => normalisePlacement(spec.resolvePlacement()), null)
            : null;

        // The recorded Phase 2 snapshot — the frozen truth of what is
        // registered with SillyTavern right now (design §I.4.4: show this,
        // never a rebuild).
        const raw = spec.key ? (allSnaps[spec.key] ?? null) : null;
        const payloadStr = raw && typeof raw.payload === 'string'
            ? raw.payload
            : (raw ? String(raw.payload ?? '') : '');
        const snapshot = raw ? {
            present: true,
            enabled: raw.enabled === true,
            payload: payloadStr,
            chars: payloadStr.length,
            // Numeric role/depth exactly as registered (role 0|1|2).
            role: typeof raw.role === 'number' ? raw.role : null,
            depth: typeof raw.depth === 'number' ? raw.depth : null,
            at: typeof raw.at === 'number' ? raw.at : null,
            ageSec: typeof raw.at === 'number' ? Math.max(0, Math.round((generatedAt - raw.at) / 1000)) : null,
        } : null;

        // Token estimate, with the KIND stated (a bare number invites the
        // stored-vs-injected misreading the Health tab already guards):
        //   'recorded' — tokens of the exact registered payload (the truth)
        //   'accessor' — module getTotalTokens() estimate (what the NEXT apply
        //                would roughly send; shown only when nothing is
        //                registered yet this session)
        //   'stored'   — Knowledge's lorebook corpus (never prompt load)
        const accessorTokens = toCount(rowCall('tokens', () => mod.getTotalTokens?.() ?? 0, 0));
        let tokens;
        if (spec.tokenKind === 'stored') {
            tokens = { value: accessorTokens, kind: 'stored' };
        } else if (snapshot) {
            tokens = { value: toCount(rowCall('payloadTokens', () => estimate(payloadStr), 0)), kind: 'recorded' };
        } else {
            tokens = { value: accessorTokens, kind: 'accessor' };
        }

        return {
            id: spec.id,
            label: spec.label,
            moduleKey: spec.moduleKey,
            mechanism: spec.mechanism,
            key: spec.key ?? null,
            enabled,
            gate,
            placement,
            tokens,
            snapshot,
            ...(spec.moduleSourceLabel ? { moduleSourceLabel: spec.moduleSourceLabel } : {}),
            ...(spec.note ? { note: spec.note } : {}),
            ...(rowErrors.length ? { errors: rowErrors } : {}),
        };
    });

    // ── Warnings ──────────────────────────────────────────────────────────────
    // Ordered by how loudly they must be seen: panic switch, the Knowledge
    // caveat (mandatory per design §I.5 Tab 4), then per-module drift.
    const warnings = [];
    if (masterOff) {
        warnings.push({
            id: 'panic-master-off',
            level: 'fail',
            text: 'PANIC SWITCH IS ON (injectionMasterOff) — no module can register injections via setExtensionPrompt while this is on, and SillyTavern keeps whatever was registered before it was flipped (see any "still registered" rows below).',
        });
    }
    warnings.push({
        id: 'knowledge-lorebook-caveat',
        level: masterOff ? 'fail' : 'warn',
        text: masterOff ? KNOWLEDGE_CAVEAT.panic : KNOWLEDGE_CAVEAT.normal,
    });
    for (const r of rows) {
        if (r.mechanism !== 'extension-prompt' || !r.snapshot) continue;
        // Flag says inject, but the last registration was a CLEAR. Usually
        // "nothing to inject yet"; if data exists, a toggle event was missed.
        if (r.enabled === true && r.gate && !r.snapshot.enabled) {
            warnings.push({
                id: `flag-on-registered-empty:${r.id}`,
                level: 'warn',
                text: `${r.label}: the module's flag is on and the gate is open, but the last thing registered for this key was a CLEAR — usually "nothing to inject yet" (empty data). If data exists, a toggle or re-apply was missed.`,
            });
        }
        // Module off/gated, but a live payload is still registered — the
        // narrator keeps seeing it until the next apply or reload.
        if ((r.enabled === false || !r.gate) && r.snapshot.enabled && r.snapshot.payload) {
            warnings.push({
                id: `flag-off-registered-live:${r.id}`,
                level: 'warn',
                text: `${r.label}: the module is off or gated, but a live payload is STILL REGISTERED with SillyTavern for this key — the toggle did not re-apply, so the narrator keeps seeing this content until the next apply or a reload.`,
            });
        }
        // Placement drift: settings resolve differently than what the current
        // payload was registered with (the §I.4.4 stale-registration theme).
        if (r.snapshot.enabled && r.placement
            && (r.snapshot.depth !== r.placement.depth.value
                || r.snapshot.role !== roleNameToNumber(r.placement.role.value))) {
            warnings.push({
                id: `placement-drift:${r.id}`,
                level: 'warn',
                text: `${r.label}: placement changed since the last apply — the registered payload sits at depth ${r.snapshot.depth ?? '?'} / role ${ROLE_NUMBERS[r.snapshot.role] ?? '?'}, but the settings now resolve to depth ${r.placement.depth.value} / role ${r.placement.role.value}. Re-apply (toggle the module, or trigger a refresh) to move it.`,
            });
        }
    }

    const bannerLevel = warnings.some((w) => w.level === 'fail')
        ? 'fail'
        : (warnings.length > 0 ? 'warn' : 'ok');

    // Header stats: ONLY recorded setExtensionPrompt payloads are prompt load.
    const liveRows = rows.filter((r) => r.snapshot?.enabled && r.snapshot?.payload);
    const registeredTokens = rows
        .filter((r) => r.tokens.kind === 'recorded')
        .reduce((sum, r) => sum + r.tokens.value, 0);

    return {
        generatedAt,
        mwtVersion: version,
        injectionMasterOff: masterOff,
        structuralBoundaries,
        livePayloads: liveRows.length,
        registeredTokens,
        modules: rows,
        warnings,
        bannerLevel,
        ...(errors.length ? { errors } : {}),
    };
}

// ─── Formatting (shared by the pane + the console bridge) ─────────────────────

/**
 * Scrub a recorded payload for on-screen display: the shared redaction
 * layer's Rule 1b string scrub applied to one payload string — this install's
 * known secret values (knownSecrets), embedded URLs (reduced to scheme+host,
 * which also removes user:pass@ credentials and key-bearing paths/query), and
 * recognizable key/bearer shapes (sk-…, Bearer …, ghp_…, AIza…, …) are all
 * replaced with '[REDACTED]' / the bare origin, while the surrounding prose
 * survives.
 *
 * WHY this exists as a named export: the redaction contract (design §I.6,
 * redaction.js header) says opting into CONTENT never opts into SECRETS — the
 * checkbox that reveals a payload reveals the scrubbed string, and the raw
 * payload is never inserted into the DOM at all (the pane's <pre> ships empty
 * and is filled only on opt-in, via textContent). DOM-free so the Node suite
 * can pin it with key-shaped fixtures directly.
 *
 * @param {string} text — the raw recorded payload
 * @param {{ knownSecrets?: string[] }} [opts] — live secret VALUES (see
 *        collectKnownSecrets() in ./report.js); pass [] to test shape-scrubbing
 * @returns {string} the scrubbed payload, safe to display once content is opted in
 */
export function scrubPayloadForDisplay(text, { knownSecrets } = {}) {
    // includeContent is irrelevant for a bare string (the content gate works on
    // field NAMES); passing it documents this call's purpose — content display,
    // already behind the opt-in — and secrets are scrubbed in either mode.
    return redactForReport(String(text ?? ''), { includeContent: true, knownSecrets });
}

/**
 * Serialize an Injection snapshot for SAFE return/copy-paste — what
 * `MWT.diagnostics.injectionStatus()` returns and what any future report
 * section for this tab must go through (the Phase 5 contract: every surface
 * routes through core/redaction.js; no hand-rolled redaction).
 *
 * Wraps redactForReport() over the whole snapshot, so the shared rules apply:
 *   - `payload` is a CONTENT_KEYS member: gated to a size-only
 *     `[content excluded — N chars]` marker unless `{ includeContent: true }`;
 *   - EVERY string (payloads, warning text, notes, error notes) is Rule-1b
 *     scrubbed in BOTH modes — known secret values, embedded URLs (→
 *     scheme+host, which drops user:pass@ and key-bearing paths), and
 *     recognizable key/bearer shapes. Opting into content never opts into
 *     secrets.
 * The input is never mutated; the output shares no references with it.
 *
 * The EXACT recorded text stays available only through the deliberate
 * single-key path — `MWT.diagnostics.injection(key)` — which the bridge's
 * log line points exact-text seekers to.
 *
 * @param {object} snapshot — collectInjectionSnapshot() output
 * @param {object} [opts]
 * @param {boolean} [opts.includeContent=false] — include (scrubbed) payload
 *        text instead of size markers
 * @param {string[]} [opts.knownSecrets] — live secret VALUES; defaults to
 *        collectKnownSecrets() (guarded; [] with no SillyTavern runtime)
 * @returns {object} a redacted deep copy
 */
export function redactInjectionSnapshot(snapshot, { includeContent = false, knownSecrets } = {}) {
    return redactForReport(snapshot, {
        includeContent,
        knownSecrets: knownSecrets ?? collectKnownSecrets(),
    });
}

/**
 * Format a snapshot age in seconds for humans: `just now`, `45s ago`, `3m
 * ago`, `2h 05m ago`, `1d 4h ago`. Shared by the pane's Registered column and
 * payload summaries and by MWT.diagnostics.injectionStatus(), so the two can
 * never disagree.
 *
 * @param {number|null} sec
 * @returns {string}
 */
export function formatInjectionAge(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—';
    if (sec < 10) return 'just now';
    if (sec < 60) return `${Math.round(sec)}s ago`;
    if (sec < 3_600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86_400) {
        const h = Math.floor(sec / 3_600);
        const m = Math.floor((sec % 3_600) / 60);
        return `${h}h ${String(m).padStart(2, '0')}m ago`;
    }
    return `${Math.floor(sec / 86_400)}d ${Math.floor((sec % 86_400) / 3_600)}h ago`;
}
