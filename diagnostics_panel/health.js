/**
 * diagnostics_panel/health.js — Tab 1: Health (Diagnostics Phase 6).
 *
 * The default answer to "is anything broken right now?" (phases doc §II.4
 * Phase 6, design §I.5 Tab 1): one row per module — enabled · injection gate ·
 * busy · tokens · auto-countdown · last run (time, ok/failed, duration) — plus
 * a header with `MWT_VERSION`, the total token load across modules, and the
 * panic-switch state (`injectionMasterOff`) for the pane to render
 * unmissably when on.
 *
 * DOM-free by design so it is unit-testable with no SillyTavern runtime: the
 * snapshot is a plain object, the markup lives in diagnostics_panel/render.js,
 * and every dependency (module namespaces, settings, accessors, clock) is
 * injectable. Every accessor call is individually guarded — one broken module
 * degrades its own row's cells, never the tab.
 *
 * Direct imports throughout for core singletons (NOT via core/index.js): the
 * barrel is aliased to test/stubs/core.js under Vitest, and the snapshot must
 * read the real singletons + version regardless (the barrel→stub alias trap,
 * §II.3). The five module namespaces are the SAME instances index.js imports,
 * so the tab reads live state.
 */

import { MWT_VERSION } from '../core/version.js';
import { getGlobalSettings, injectionAllowed } from '../core/settings.js';
import { getLastApiCall, getLastRun } from '../core/diagnostics.js';
import * as WorldState from '../world_state/index.js';
import * as Chronicle from '../chronicle/index.js';
import * as Knowledge from '../knowledge/index.js';
import * as StoryPlanner from '../story_planner/index.js';
import * as Interiority from '../interiority/index.js';

// The five modules, in panel order. Each row normalizes that module's
// INCONSISTENT accessor names onto the Health tab's one shape (design §I.3.a:
// "Naming is inconsistent per module; the panel normalizes"):
//   - `id`          — the module key API telemetry is stamped with
//                     (core/api.js apiModule()); also the settings-defaults
//                     `module:` value added in Phase 6.
//   - `moduleKey`   — the PascalCase key behind `enable<ModuleKey>` and
//                     injectionAllowed(moduleKey) (core/settings.js).
//   - `isBusy`/`autoStatus` — that module's busy / auto-countdown accessor.
//   - `tokenKind`   — WHAT that module's getTotalTokens() actually counts. The
//                     five accessors share a name but not a meaning, and the
//                     difference is the one a tester will misread (see below).
export const HEALTH_MODULE_SPECS = [
    { id: 'world_state', label: '🌍 World State', moduleKey: 'WorldState', isBusy: 'isRefreshing', autoStatus: 'getAutoRefreshStatus', tokenKind: 'injected' },
    { id: 'chronicle', label: '📜 Chronicle', moduleKey: 'Chronicle', isBusy: 'isGeneratingSnapshot', autoStatus: 'getAutoSnapshotStatus', tokenKind: 'injected' },
    { id: 'knowledge', label: '🧠 Knowledge', moduleKey: 'Knowledge', isBusy: 'isScanning', autoStatus: 'getAutoScanStatus', tokenKind: 'stored' },
    { id: 'story_planner', label: '🗺️ Story Planner', moduleKey: 'StoryPlanner', isBusy: 'isGenerating', autoStatus: 'getAutoPlanStatus', tokenKind: 'injected' },
    { id: 'interiority', label: '💭 Interiority', moduleKey: 'Interiority', isBusy: 'isGenerating', autoStatus: 'getAutoStatus', tokenKind: 'injected' },
];

/**
 * What each `tokenKind` means, and why the distinction has to reach the UI.
 *
 * Four of the five getTotalTokens() accessors measure the payload the module
 * hands to setExtensionPrompt right now:
 *   - World State  → header + world state text (world_state/index.js)
 *   - Chronicle    → 0 when injection is off, else the joined entries
 *   - Story Planner→ getInjectedTokenCount()
 *   - Interiority  → the ACTIVE ledger lines only (dormant excluded, §20)
 *
 * Knowledge measures something else entirely: `state._cachedTokenCount` is the
 * sum over every NPC profile and state-tracker entry it has written to the
 * LOREBOOK. Knowledge has no setExtensionPrompt call anywhere — its entries
 * are created with `constant: false` (knowledge/lorebook.js), so SillyTavern's
 * World Info engine activates only the entries whose keywords match recent
 * chat, inside its own WI budget. On the reference chat that number is ~36k,
 * and printed in the same column as four injection sizes it reads as "this
 * extension is stuffing 36k tokens into my prompt" — which is not what happens.
 *
 * So: the column reports the kind, and the header total sums ONLY the injected
 * kinds. A stored corpus and an injected payload are not addable quantities.
 */
export const TOKEN_KINDS = Object.freeze({
    injected: {
        label: 'injected',
        title: 'Estimated tokens this module is injecting into the prompt right now.',
    },
    stored: {
        label: 'stored',
        title: 'Lorebook corpus — NOT an injection. MWT writes these entries to a lorebook and never '
            + 'sends them as a block; SillyTavern activates only the entries whose keywords match recent '
            + 'chat, within its own World Info budget. This is the size of the library, not the prompt.',
    },
});

/** Live module namespaces by id — the instances index.js itself imports. */
export const DEFAULT_HEALTH_MODULES = {
    world_state: WorldState,
    chronicle: Chronicle,
    knowledge: Knowledge,
    story_planner: StoryPlanner,
    interiority: Interiority,
};

// ─── Normalizers ─────────────────────────────────────────────────────────────

/**
 * Normalize a module's auto-run status onto one shape.
 *
 * The four countdown modules disagree on the interval field name — World
 * State / Knowledge / Story Planner return `{ counter, interval }`, Chronicle
 * `{ counter, threshold }` — and their counters can exceed the interval
 * (BUG_REPORTS: "Countdown can go negative"), so `remaining` is clamped at 0.
 * Interiority (Phase 4 `getAutoStatus()`) has no main-generation countdown at
 * all: `perTurn: true` means it fires on every AI message, and the counter /
 * interval describe the §20 dormant-intentions poll instead — those extras
 * are passed through so the row can say so.
 *
 * @param {object|null} status — the module accessor's return (null = off)
 * @returns {object|null} `{ counter, interval, remaining,
 *   perTurn?, dormantCount?, pollDue? }` or null when auto-run is off
 */
export function normaliseAutoStatus(status) {
    if (!status || typeof status !== 'object') return null;
    const interval = Number(status.interval ?? status.threshold) || 0;
    const counter = Number(status.counter) || 0;
    const out = { counter, interval, remaining: Math.max(0, interval - counter) };
    if (status.perTurn === true) {
        out.perTurn = true;
        out.dormantCount = typeof status.dormantCount === 'number' ? status.dormantCount : null;
        out.pollDue = status.pollDue === true;
    }
    return out;
}


/**
 * Resolve a module's "last run" row: the freshest of the Phase 1 per-module
 * API-call pointer (built explicitly "for the Health tab", and carrying
 * time / ok / duration) and the Phase 0 last-run map stamp (trigger + wall
 * clock, but nothing populates it in v1). Both are in-memory, so "never" is a
 * legitimate answer early in a session — and after every reload.
 *
 * Error TEXT is deliberately omitted from the row (backend errors can quote
 * the chat and interpolate the resolved endpoint — core/api.js): the tab shows
 * ok/failed only; the Log tab (Phase 11) and the redacted report carry detail.
 *
 * @param {string} id — module key
 * @param {object} refs — { lastApiCall, lastRun } accessors
 * @returns {object|null} `{ at, ok, durationMs, source, model?, status?,
 *   retries?, trigger? }` or null when neither source has a stamp
 */
export function resolveLastRun(id, { lastApiCall, lastRun }) {
    const call = lastApiCall(id);
    const run = lastRun(id);
    const callAt = typeof call?.at === 'number' ? call.at : -Infinity;
    const runAt = typeof run?.finishedAt === 'number'
        ? run.finishedAt
        : (typeof run?.startedAt === 'number' ? run.startedAt : -Infinity);
    if (callAt === -Infinity && runAt === -Infinity) return null;

    if (callAt >= runAt) {
        return {
            at: call.at,
            ok: call.ok === true,
            durationMs: typeof call.durationMs === 'number' ? call.durationMs : null,
            source: 'api-call',
            model: call.model ?? null,
            status: call.status ?? null,
            retries: call.retries ?? null,
        };
    }
    const durationMs = (typeof run.finishedAt === 'number' && typeof run.startedAt === 'number')
        ? Math.max(0, run.finishedAt - run.startedAt)
        : null;
    return {
        at: run.finishedAt ?? run.startedAt,
        ok: run.ok === true,
        durationMs,
        source: 'run-map',
        trigger: run.trigger ?? null,
    };
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Collect the Health snapshot (header + one row per module).
 *
 * @param {object} [deps] — all injectable for tests; defaults read the live
 *   modules / settings / diagnostics singletons.
 * @param {object} [deps.modules] — map of module id → module namespace
 * @param {object} [deps.settings] — the global settings object
 * @param {function(string): boolean} [deps.allowed] — injectionAllowed
 * @param {object} [deps.diagnostics] — { lastApiCall, lastRun } accessors
 * @param {string} [deps.version]
 * @param {function(): number} [deps.now]
 * @returns {{generatedAt: number, mwtVersion: string, injectionMasterOff:
 *   boolean, injectedTokens: number, storedTokens: number,
 *   modules: Array<object>}} — `injectedTokens` is prompt load right now;
 *   `storedTokens` is lorebook corpus. Deliberately two fields: adding them
 *   would state something untrue about the prompt (see TOKEN_KINDS).
 */
export function collectHealthSnapshot({
    modules = DEFAULT_HEALTH_MODULES,
    settings = getGlobalSettings(),
    allowed = injectionAllowed,
    diagnostics = { lastApiCall: getLastApiCall, lastRun: getLastRun },
    version = MWT_VERSION,
    now = Date.now,
} = {}) {
    const rows = HEALTH_MODULE_SPECS.map((spec) => {
        const errors = [];
        // Per-field guard: call() degrades one cell to a fallback value and
        // notes the failure, so a throwing accessor can never blank the tab.
        const call = (label, fn, fallback) => {
            try {
                const v = fn();
                return v === undefined ? fallback : v;
            } catch (err) {
                errors.push(`${label}: ${String(err?.message || err)}`);
                return fallback;
            }
        };

        const mod = modules[spec.id] || {};
        const busy = call('busy', () => mod[spec.isBusy]?.() ?? null, null);
        const tokens = call('tokens', () => mod.getTotalTokens?.() ?? 0, 0);
        const auto = call('auto', () => normaliseAutoStatus(mod[spec.autoStatus]?.() ?? null), null);
        const lastRun = call('lastRun', () => resolveLastRun(spec.id, diagnostics), null);
        const gate = call('gate', () => allowed(spec.moduleKey), false);

        return {
            id: spec.id,
            label: spec.label,
            // Two-layer enable model (core/settings.js): the per-module flag
            // lives here, the panic switch in the header. `enabled` mirrors
            // the floating buttons' enableKey semantics (absent = on).
            enabled: settings?.[`enable${spec.moduleKey}`] !== false,
            // NB: only chronicle/injection.js consults injectionAllowed()
            // directly; for Knowledge the same two flags gate SCANNING via
            // core/event_router.js, since Knowledge has no injection path at
            // all. The computed value is right for every module — the word
            // "inject" is what would be wrong, so the pane says "act".
            injectionAllowed: gate === true,
            busy: busy === true,
            tokens: typeof tokens === 'number' ? tokens : 0,
            // What that number counts. Never sum across kinds — see TOKEN_KINDS.
            tokenKind: spec.tokenKind,
            auto,
            lastRun,
            ...(errors.length ? { errors } : {}),
        };
    });

    // Injected and stored tokens are reported separately and never added: one
    // is prompt load this turn, the other is library size on disk (TOKEN_KINDS).
    const sumKind = (kind) => rows.reduce((sum, r) => sum + (r.tokenKind === kind ? (r.tokens || 0) : 0), 0);

    return {
        generatedAt: now(),
        mwtVersion: version,
        injectionMasterOff: settings?.injectionMasterOff === true,
        injectedTokens: sumKind('injected'),
        storedTokens: sumKind('stored'),
        modules: rows,
    };
}
