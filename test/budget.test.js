/**
 * test/budget.test.js — TODO §2: the cross-module context/token budget.
 *
 * Layers, mirroring test/coordinator.test.js (the other core-level subsystem
 * adopted at a shared seam):
 *   1. core/budget.js pure functions — settings normalization, context-limit
 *      resolution, structure-preserving truncation, drop-order modeling,
 *      planBudgetDecision (module hard cap / global displacement / soft-cap
 *      truncation), and the seam hook in both modes plus the
 *      never-break-injection contract.
 *   2. The SEAM integration — the REAL core/injection.js
 *      applyExtensionPromptInjection() against a fake SillyTavern context
 *      (the injection_diagnostics tier5 pattern): observe default = zero
 *      behavior change; enforce = truncate/drop/displace exactly as planned.
 *   3. budget/panel.js — the collector (row shapes, token kinds, modeled
 *      plans, degradation) and the renderer/wiring string builders.
 *
 * The engine's settings are driven through the real chat metadata via the
 * stub-core fake meta (getFakeMeta) — the per-chat record this feature
 * ships with — EXCEPT where a test injects deps directly.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    BUDGET_METADATA_KEY,
    BUDGET_MODULE_SPECS,
    BUDGET_LIMITS,
    normalizeBudgetSettings,
    getBudgetSettings,
    saveBudgetSettings,
    resolveContextLimit,
    truncatePayloadForTokens,
    modelDropOrder,
    planBudgetDecision,
    registeredOthersTokens,
    resetBudgetInjections,
    enforceInjectionBudget,
    _resetBudgetEnforcementState,
    _setBudgetSettingsReader,
} from '../core/budget.js';
import { estimateTokens as estimateTokensReal } from '../core/context.js';
import { applyExtensionPromptInjection } from '../core/injection.js';
import {
    collectBudgetSnapshot,
    renderBudgetSnapshot,
    renderBudgetPane,
    wireBudgetTab,
} from '../budget/panel.js';
import {
    _resetDiagnostics,
    getInjectedSnapshot,
    recordInjection,
    getEvents,
} from '../core/diagnostics.js';
import { resetCoreStubs } from './stubs/core.js';

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** A settings object for direct-injection tests. */
function settings(overrides = {}) {
    const s = normalizeBudgetSettings({});
    return {
        ...s,
        ...overrides,
        modules: {
            ...s.modules,
            ...(overrides.modules || {}),
        },
    };
}

/** A payload of roughly `tokens` tokens under the chars/4.5 fallback. */
function payloadOf(tokens) {
    return 'x'.repeat(Math.round(tokens * 4.5));
}

/**
 * Measure a payload with the REAL estimator the budget decision uses (the
 * live tokenizer or the chars/4.5 fallback) — so a regression test can assert
 * the budget's `tokensAfter` is the actual measured size of the returned
 * payload, not a hard-coded ratio.
 */
function estimateTokensOf(text) {
    return estimateTokensReal(text);
}

/** Install a fake SillyTavern context whose setExtensionPrompt records calls.
 * The context also carries a REAL chatMetadata object the budget settings
 * read through the production path (getChatMeta). */
function fakeSetExtensionPrompt() {
    const calls = [];
    const meta = {};
    globalThis.SillyTavern = {
        getContext: () => ({
            setExtensionPrompt: (...args) => calls.push(args),
            chatMetadata: meta,
            saveMetadataDebounced: () => {},
        }),
    };
    return { calls, meta };
}

beforeEach(() => {
    resetCoreStubs();
    _resetDiagnostics();
    _resetBudgetEnforcementState();
    _setBudgetSettingsReader(null);
    delete globalThis.SillyTavern;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.SillyTavern;
});

// ─── 1. Settings normalization ───────────────────────────────────────────────

describe('normalizeBudgetSettings', () => {
    test('defaults are observe-mode with all caps off', () => {
        const s = normalizeBudgetSettings(undefined);
        expect(s.enforce).toBe(false);
        expect(s.globalHardCap).toBe(0);
        expect(s.contextLimitOverride).toBe(0);
        expect(Object.keys(s.modules).sort()).toEqual(['chronicle', 'interiority', 'knowledge', 'story_planner', 'world_state']);
        for (const m of Object.values(s.modules)) {
            expect(m.softCap).toBe(0);
            expect(m.hardCap).toBe(0);
        }
    });

    test('default priorities encode the TODO §2 drop order', () => {
        const s = normalizeBudgetSettings({});
        // World State + Interiority first, Chronicle, Story Planner, Knowledge last.
        expect(s.modules.world_state.priority).toBe(1);
        expect(s.modules.interiority.priority).toBe(1);
        expect(s.modules.chronicle.priority).toBe(2);
        expect(s.modules.story_planner.priority).toBe(3);
        expect(s.modules.knowledge.priority).toBe(4);
    });

    test('every field is clamped; garbage falls back to defaults', () => {
        const s = normalizeBudgetSettings({
            enforce: 'yes',
            globalHardCap: -5,
            contextLimitOverride: 99e9,
            modules: {
                world_state: { priority: 99, softCap: 'not-a-number', hardCap: -1 },
            },
        });
        expect(s.enforce).toBe(false);          // only === true enables
        expect(s.globalHardCap).toBe(0);        // negative → clamped to off
        expect(s.contextLimitOverride).toBe(10_000_000); // clamped to the max, not reset
        expect(s.modules.world_state.priority).toBe(9); // clamped to max
        expect(s.modules.world_state.softCap).toBe(0);
        expect(s.modules.world_state.hardCap).toBe(0);
    });

    test('a foreign-shaped record never throws and yields defaults', () => {
        expect(() => normalizeBudgetSettings('garbage')).not.toThrow();
        expect(normalizeBudgetSettings(42).enforce).toBe(false);
        expect(normalizeBudgetSettings({ modules: 'nope' }).modules.world_state.priority).toBe(1);
    });
});

describe('getBudgetSettings / saveBudgetSettings (chat metadata)', () => {
    // The real accessors read the REAL chat metadata through core/context.js
    // (no fake context exists under Node), so these tests drive the record
    // through the test seam — the same production read path, minus the host.
    afterEach(() => _setBudgetSettingsReader(null));

    test('reads the record from this chat\'s metadata', () => {
        const stored = { enforce: true, globalHardCap: 1234 };
        _setBudgetSettingsReader(() => stored);
        const s = getBudgetSettings();
        expect(s.enforce).toBe(true);
        expect(s.globalHardCap).toBe(1234);
    });

    test('save merges per-module patches and persists through the record', () => {
        let stored = undefined;
        _setBudgetSettingsReader(() => stored);
        const patchMeta = (key, value) => { stored = value; return true; };
        saveBudgetSettings({ modules: { chronicle: { softCap: 500 } } }, { patchMeta });
        saveBudgetSettings({ modules: { chronicle: { hardCap: 1200 } } }, { patchMeta });
        // The first patch's softCap survived the second write.
        expect(stored.modules.chronicle).toEqual({ priority: 2, softCap: 500, hardCap: 1200 });
    });

    test('save normalizes what it writes', () => {
        let stored = undefined;
        _setBudgetSettingsReader(() => stored);
        const patchMeta = (key, value) => { stored = value; return true; };
        saveBudgetSettings({ globalHardCap: '7000' }, { patchMeta });
        expect(stored.globalHardCap).toBe(7000);
    });
});

// ─── 2. Context-limit resolution ─────────────────────────────────────────────

describe('resolveContextLimit', () => {
    test('a manual override wins over every probe', () => {
        const r = resolveContextLimit({
            settings: settings({ contextLimitOverride: 32000 }),
            ctx: { maxContext: 4096 },
        });
        expect(r).toMatchObject({ value: 32000, source: 'override' });
    });

    test('ctx.maxContext is honored as a function and as a number', () => {
        expect(resolveContextLimit({ settings: settings(), ctx: { maxContext: () => 16384 } }).value).toBe(16384);
        expect(resolveContextLimit({ settings: settings(), ctx: { maxContext: 8192 } }).value).toBe(8192);
    });

    test('preset fields are the fallbacks, and unknown degrades honestly', () => {
        expect(resolveContextLimit({ settings: settings(), ctx: { chatCompletionSettings: { openai_max_context: 12000 } } }).source)
            .toBe('chatCompletionSettings.openai_max_context');
        expect(resolveContextLimit({ settings: settings(), ctx: { textCompletionSettings: { max_context: 6000 } } }).source)
            .toBe('textCompletionSettings.max_context');
        const unknown = resolveContextLimit({ settings: settings(), ctx: {} });
        expect(unknown.value).toBeNull();
        expect(unknown.source).toBe('unknown');
    });

    test('a throwing probe degrades to unknown, never throws', () => {
        const evil = { get maxContext() { throw new Error('boom'); } };
        expect(() => resolveContextLimit({ settings: settings(), ctx: evil })).not.toThrow();
        expect(resolveContextLimit({ settings: settings(), ctx: evil }).value).toBeNull();
    });
});

// ─── 3. Structure-preserving truncation ──────────────────────────────────────

describe('truncatePayloadForTokens', () => {
    test('an in-budget payload passes through byte-identical', () => {
        const p = payloadOf(100);
        expect(truncatePayloadForTokens(p, 200)).toBe(p);
    });

    test('a wrapper-tagged payload keeps its closing tag and gains a marker', () => {
        const inner = payloadOf(1000);
        const tagged = `<mwt_world_state>\n${inner}\n</mwt_world_state>`;
        const out = truncatePayloadForTokens(tagged, 100);
        expect(out.startsWith('<mwt_world_state>')).toBe(true);
        expect(out.endsWith('\n</mwt_world_state>')).toBe(true);
        expect(out).toContain('[…truncated ~');
        expect(out).toContain('tokens]');
        // The result is within the cap (chars = tokens × 4.5).
        expect(out.length).toBeLessThanOrEqual(100 * 4.5);
    });

    test('an untagged payload is cut with a marker', () => {
        const out = truncatePayloadForTokens(payloadOf(500), 100);
        expect(out).toContain('[…truncated ~');
        expect(out.length).toBeLessThanOrEqual(100 * 4.5);
    });

    test('a half-open wrapper (defensive) falls back to the plain cut', () => {
        const halfOpen = `<mwt_world_state>\n${payloadOf(500)}`;
        const out = truncatePayloadForTokens(halfOpen, 100);
        expect(out.endsWith('</mwt_world_state>')).toBe(false);
        expect(out).toContain('[…truncated ~');
    });

    test('a two-block World State payload never leaves either started tag half-open', () => {
        const payload = `<mwt_world_state>\n${payloadOf(700)}\n</mwt_world_state>\n\n<mwt_plot_seeds>\n${payloadOf(700)}\n</mwt_plot_seeds>`;
        const out = truncatePayloadForTokens(payload, 100);
        expect(out.startsWith('<mwt_world_state>\n')).toBe(true);
        expect(out).toContain('</mwt_world_state>');
        // The second sibling may be dropped entirely, but if it is emitted it
        // must be structurally complete too (TODO §2 P1).
        if (out.includes('<mwt_plot_seeds>')) {
            expect(out).toContain('</mwt_plot_seeds>');
        }
        expect(out).toContain('[…truncated ~');
        expect(estimateTokensOf(out)).toBeLessThanOrEqual(100);
    });

    test('a dropped trailing block is marked and never replaced by an over-cap empty wrapper', () => {
        const payload = `<mwt_world_state>\n${payloadOf(180)}\n</mwt_world_state>\n\n<mwt_plot_seeds>\n${payloadOf(180)}\n</mwt_plot_seeds>`;
        const firstBlock = `<mwt_world_state>\n${payloadOf(180)}\n</mwt_world_state>`;
        const cap = estimateTokensOf(firstBlock) + 8;
        const out = truncatePayloadForTokens(payload, cap);
        expect(out).toContain('[…truncated ~');
        expect(out).not.toContain('<mwt_plot_seeds>\n\n</mwt_plot_seeds>');
        expect(estimateTokensOf(out)).toBeLessThanOrEqual(cap);
    });

    test('a block whose delimiters cannot fit is omitted rather than emitted empty', () => {
        const payload = `<mwt_world_state>\n${payloadOf(100)}\n</mwt_world_state>\n\n<mwt_plot_seeds>\n${payloadOf(100)}\n</mwt_plot_seeds>`;
        const out = truncatePayloadForTokens(payload, 8);
        expect(out).toContain('[…truncated ~');
        expect(out).not.toContain('<mwt_world_state>\n\n</mwt_world_state>');
        expect(estimateTokensOf(out)).toBeLessThanOrEqual(8);
    });
});

// ─── 4. Drop-order model ─────────────────────────────────────────────────────

describe('modelDropOrder', () => {
    test('default actionable order excludes advisory Knowledge', () => {
        const order = modelDropOrder({ settings: settings() }).map((d) => d.id);
        // Dropped FIRST → kept LAST: older/reference material goes first.
        // Knowledge uses ST World Info rather than MWT's seam, so it cannot be
        // enforced and is deliberately outside this actionable model.
        expect(order).toEqual(['story_planner', 'chronicle', 'interiority', 'world_state']);
    });

    test('user priorities reorder it, and equal priorities tie-break by table order', () => {
        const s = settings({ modules: { chronicle: { priority: 1 } } });
        const order = modelDropOrder({ settings: s }).map((d) => d.id);
        // Chronicle joins the P1 tier; within it, the later table row drops
        // first (World State survives, then Interiority, then Chronicle).
        expect(order).toEqual(['story_planner', 'chronicle', 'interiority', 'world_state']);
    });
});

// ─── 5. planBudgetDecision ───────────────────────────────────────────────────

describe('planBudgetDecision', () => {
    const ws = BUDGET_MODULE_SPECS.find((s) => s.id === 'world_state');

    test('keep: everything within caps', () => {
        const plan = planBudgetDecision({ spec: ws, payload: payloadOf(100), settings: settings(), others: {} });
        expect(plan.action).toBe('keep');
        expect(plan.payload).toBe(payloadOf(100));
        expect(plan.displaced).toEqual([]);
    });

    test('module hard cap exceeded → drop', () => {
        const s = settings({ enforce: true, modules: { world_state: { hardCap: 200 } } });
        const plan = planBudgetDecision({ spec: ws, payload: payloadOf(500), settings: s, others: {} });
        expect(plan.action).toBe('drop');
        expect(plan.payload).toBe('');
        expect(plan.capTokens).toBe(200);
        expect(plan.dropSource).toBe('module-hard-cap');
    });

    test('module soft cap exceeded → truncate with a marker, tokensAfter MEASURED ≤ cap', () => {
        const s = settings({ enforce: true, modules: { world_state: { softCap: 200 } } });
        const plan = planBudgetDecision({ spec: ws, payload: payloadOf(500), settings: s, others: {} });
        expect(plan.action).toBe('truncate');
        expect(plan.payload).toContain('[…truncated ~');
        // Bug 3 fix: tokensAfter is the MEASURED result (marker + closing tags
        // included), not the cap value, so it is at most the cap and is a
        // real count of the returned payload.
        expect(plan.tokensAfter).toBeLessThanOrEqual(200);
        expect(plan.tokensAfter).toBeGreaterThan(0);
        expect(plan.tokensAfter).toBe(estimateTokensOf(plan.payload));
    });

    test('a soft-capped candidate is admitted when it fits the global cap beside protected context', () => {
        const intSpec = BUDGET_MODULE_SPECS.find((s) => s.id === 'interiority');
        const s = settings({
            enforce: true,
            globalHardCap: 1000,
            modules: { interiority: { softCap: 400 } },
        });
        // World State is equal priority but earlier in the table, so it is
        // protected from Interiority. Raw Interiority (800) would not fit with
        // WS (600), but its configured soft-capped candidate does.
        const plan = planBudgetDecision({
            spec: intSpec,
            payload: payloadOf(800),
            settings: s,
            others: { world_state: 600 },
        });
        expect(plan.action).toBe('truncate');
        expect(plan.displaced).toEqual([]);
        expect(plan.tokensAfter).toBeLessThanOrEqual(400);
        expect(plan.tokensAfter + 600).toBeLessThanOrEqual(1000);
    });

    test('global hard cap: the incoming payload displaces strictly-worse modules first', () => {
        // Chronicle (P2, worse than WS P1) holds 1000; Interiority (P1, equal) holds 500.
        const s = settings({ enforce: true, globalHardCap: 1500 });
        const plan = planBudgetDecision({
            spec: ws,
            payload: payloadOf(1000),
            settings: s,
            others: { chronicle: 1000, interiority: 500 },
        });
        // Chronicle (1000) is displaced; WS (1000) + Interiority (500) = 1500 fits exactly.
        expect(plan.action).toBe('keep');
        expect(plan.displaced).toEqual(['chronicle']);
    });

    test('global hard cap: an equal-or-better priority module is never displaced', () => {
        const intSpec = BUDGET_MODULE_SPECS.find((s) => s.id === 'interiority');
        const s = settings({ enforce: true, globalHardCap: 1200 });
        const plan = planBudgetDecision({
            spec: intSpec,                     // P1, later row than World State
            payload: payloadOf(1000),
            settings: s,
            others: { world_state: 500 },       // equal priority, EARLIER row
        });
        // World State is not strictly worse (equal priority, earlier row), so
        // it is never displaced; Interiority alone cannot fit → dropped, and
        // nothing was displaced (clearing victims to not admit would waste them).
        expect(plan.action).toBe('drop');
        expect(plan.displaced).toEqual([]);
        expect(plan.reason).toContain('global hard cap');
        expect(plan.dropSource).toBe('global-hard-cap');
    });

    test('global hard cap: the newcomer drops (not truncates) when it cannot fit after displacement', () => {
        const s = settings({ enforce: true, globalHardCap: 1500 });
        const plan = planBudgetDecision({
            spec: ws,
            payload: payloadOf(2000),        // alone over the cap
            settings: s,
            others: { chronicle: 1000 },
        });
        // A payload that alone exceeds the global cap is dropped — the hard
        // cap never truncates (that is the soft cap's job).
        expect(plan.action).toBe('drop');
        expect(plan.displaced).toEqual([]);
        expect(plan.reason).toContain('global hard cap');
    });

    test('global hard cap: newcomer fits after displacing worse modules — keep', () => {
        const s = settings({ enforce: true, globalHardCap: 1500 });
        const plan = planBudgetDecision({
            spec: ws,
            payload: payloadOf(1400),
            settings: s,
            others: { chronicle: 400 },  // chronicle is worse → displaced
        });
        expect(plan.action).toBe('keep');
        expect(plan.displaced).toEqual(['chronicle']);
    });

    test('module hard cap beats the global step', () => {
        const s = settings({ enforce: true, globalHardCap: 100000, modules: { world_state: { hardCap: 50 } } });
        const plan = planBudgetDecision({ spec: ws, payload: payloadOf(500), settings: s, others: {} });
        expect(plan.action).toBe('drop');
        expect(plan.reason).toContain('module hard cap');
    });
});

// ─── 6. The seam hook — observe / enforce / never-break ──────────────────────

describe('enforceInjectionBudget (the seam hook)', () => {
    test('OBSERVE (default): payload passes through unchanged, would-actions recorded', () => {
        const s = settings({ modules: { world_state: { softCap: 100 } } });  // enforce stays false
        const p = payloadOf(500);
        const out = enforceInjectionBudget(
            { key: 'mwt_world_state_injection', payload: p, enabled: true },
            { settings: s },
        );
        expect(out.payload).toBe(p);
        expect(out.enabled).toBe(true);
        const events = getEvents({ module: 'budget' });
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('budget_would_truncate');
        expect(events[0].detail.mode).toBe('observe');
    });

    test('OBSERVE: a displacement-only plan is logged as budget_would_displace, not truncate', () => {
        recordInjection({ key: 'session_chronicle_injection', payload: payloadOf(800), role: 0, depth: 2, enabled: true });
        const s = settings({ globalHardCap: 1000 });
        const out = enforceInjectionBudget(
            { key: 'mwt_world_state_injection', payload: payloadOf(400), enabled: true },
            { settings: s },
        );
        expect(out.payload).toBe(payloadOf(400));
        const events = getEvents({ module: 'budget' });
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('budget_would_displace');
        expect(events[0].detail.displaced).toEqual(['chronicle']);
    });

    test('ENFORCE + soft cap → truncated payload', () => {
        const s = settings({ enforce: true, modules: { world_state: { softCap: 100 } } });
        const out = enforceInjectionBudget(
            { key: 'mwt_world_state_injection', payload: payloadOf(500), enabled: true },
            { settings: s },
        );
        expect(out.payload).toContain('[…truncated ~');
        expect(out.decision.action).toBe('truncate');
        expect(getEvents({ module: 'budget' })[0].event).toBe('budget_truncated');
    });

    test('ENFORCE + hard cap → dropped (empty + disabled)', () => {
        const s = settings({ enforce: true, modules: { world_state: { hardCap: 100 } } });
        const out = enforceInjectionBudget(
            { key: 'mwt_world_state_injection', payload: payloadOf(500), enabled: true },
            { settings: s },
        );
        expect(out.payload).toBe('');
        expect(out.enabled).toBe(false);
        expect(getEvents({ module: 'budget' })[0].event).toBe('budget_dropped');
    });

    test('ENFORCE + global cap → displacement clears the victim\'s slot through setExtensionPrompt', () => {
        // Chronicle registered and live (Phase 2 snapshot drives `others`).
        recordInjection({ key: 'session_chronicle_injection', payload: payloadOf(1000), role: 0, depth: 2, enabled: true });
        const setEPCalls = [];
        const s = settings({ enforce: true, globalHardCap: 1500 });
        const out = enforceInjectionBudget(
            { key: 'mwt_world_state_injection', payload: payloadOf(1000), enabled: true },
            { settings: s, setEP: (...args) => setEPCalls.push(args) },
        );
        expect(out.decision.displaced).toEqual(['chronicle']);
        // The victim's slot was cleared through the seam surface.
        expect(setEPCalls[0][0]).toBe('session_chronicle_injection');
        expect(setEPCalls[0][1]).toBe('');
        // And the Injection-tab snapshot reflects the clear.
        expect(getInjectedSnapshot('session_chronicle_injection').enabled).toBe(false);
    });

    test('unknown keys are never budget-managed', () => {
        const s = settings({ enforce: true, globalHardCap: 10 });
        const out = enforceInjectionBudget(
            { key: 'mwt_some_future_module', payload: payloadOf(500), enabled: true },
            { settings: s },
        );
        expect(out.payload).toBe(payloadOf(500));
        expect(out.decision).toBeNull();
    });

    test('NEVER THROWS: an internal failure passes the payload through', () => {
        // A settings reader that throws mid-flight is simulated with a
        // poisoned settings object whose modules getter throws.
        const poisoned = { enforce: true, get modules() { throw new Error('boom'); } };
        const p = payloadOf(500);
        const out = enforceInjectionBudget(
            { key: 'mwt_world_state_injection', payload: p, enabled: true },
            { settings: poisoned },
        );
        expect(out.payload).toBe(p);
        expect(out.enabled).toBe(true);
    });
});

describe('registeredOthersTokens', () => {
    test('counts ONLY enabled seam modules from the Phase 2 snapshots; Knowledge never', () => {
        recordInjection({ key: 'mwt_world_state_injection', payload: payloadOf(300), role: 0, depth: 4, enabled: true });
        recordInjection({ key: 'session_chronicle_injection', payload: payloadOf(200), role: 0, depth: 2, enabled: true });
        const others = registeredOthersTokens(null);
        expect(others).toEqual({ world_state: 300, chronicle: 200 });
        expect(others.knowledge).toBeUndefined();   // lorebook — never this seam
        // The excluded key is never counted as an "other".
        expect(registeredOthersTokens('mwt_world_state_injection')).toEqual({ chronicle: 200 });
        // A cleared Chronicle (re-cleared) drops out entirely.
        recordInjection({ key: 'session_chronicle_injection', payload: '', role: 0, depth: 2, enabled: false });
        expect(registeredOthersTokens(null)).toEqual({ world_state: 300 });
    });
});

describe('resetBudgetInjections', () => {
    test('clears every managed seam slot and wipes the global snapshots before chat reapply', () => {
        recordInjection({ key: 'mwt_world_state_injection', payload: payloadOf(300), role: 0, depth: 4, enabled: true });
        recordInjection({ key: 'mwt_interiority_injection', payload: payloadOf(700), role: 0, depth: 2, enabled: true });
        const calls = [];
        resetBudgetInjections({ setEP: (...args) => calls.push(args) });
        expect(calls.map((args) => args[0]).sort()).toEqual([
            'mwt_interiority_injection',
            'mwt_story_plan_injection',
            'mwt_world_state_injection',
            'session_chronicle_injection',
        ]);
        expect(calls.every((args) => args[1] === '')).toBe(true);
        expect(registeredOthersTokens()).toEqual({});
    });
});

// ─── 7. SEAM integration — the REAL core/injection.js ────────────────────────

describe('applyExtensionPromptInjection × budget (the real seam)', () => {
    test('observe default: byte-identical registration — zero behavior change', () => {
        const { calls } = fakeSetExtensionPrompt();
        const body = payloadOf(500);
        const ok = applyExtensionPromptInjection({
            key: 'mwt_world_state_injection',
            header: '[H]',
            body,
            enabled: true,
            fallbackDepth: 4,
            wrapperTag: 'mwt_world_state',
        });
        expect(ok).toBe(true);
        expect(calls).toHaveLength(1);
        // The payload is exactly the pre-budget construction (wrapped, header
        // included) — the budget (observe default) touched nothing.
        const snap = getInjectedSnapshot('mwt_world_state_injection');
        expect(snap.payload).toBe(calls[0][1]);
        expect(snap.payload).toContain(payloadOf(100).slice(0, 50));
        expect(snap.enabled).toBe(true);
    });

    test('enforce + soft cap: setExtensionPrompt receives the truncated payload', () => {
        const { calls, meta } = fakeSetExtensionPrompt();
        meta[BUDGET_METADATA_KEY] = {
            enforce: true,
            modules: { world_state: { softCap: 100 } },
        };
        const ok = applyExtensionPromptInjection({
            key: 'mwt_world_state_injection',
            header: '',
            body: payloadOf(500),
            enabled: true,
            fallbackDepth: 4,
        });
        expect(ok).toBe(true);
        expect(calls[0][1]).toContain('[…truncated ~');
        // The recorded snapshot matches what was sent (Phase 2's core
        // promise holds through the budget).
        expect(getInjectedSnapshot('mwt_world_state_injection').payload).toBe(calls[0][1]);
    });

    test('enforce + hard cap: the slot is cleared and the return is false', () => {
        const { calls, meta } = fakeSetExtensionPrompt();
        meta[BUDGET_METADATA_KEY] = {
            enforce: true,
            modules: { world_state: { hardCap: 100 } },
        };
        const ok = applyExtensionPromptInjection({
            key: 'mwt_world_state_injection',
            header: '',
            body: payloadOf(500),
            enabled: true,
            fallbackDepth: 4,
        });
        expect(ok).toBe(false);
        expect(calls[0][1]).toBe('');
        expect(getInjectedSnapshot('mwt_world_state_injection').enabled).toBe(false);
    });

    test('a displaced module is restored when the payload that displaced it clears', () => {
        const { calls, meta } = fakeSetExtensionPrompt();
        meta[BUDGET_METADATA_KEY] = { enforce: true, globalHardCap: 1000 };

        // Chronicle first occupies 600 tokens at its own resolved placement.
        expect(applyExtensionPromptInjection({
            key: 'session_chronicle_injection',
            header: '',
            body: payloadOf(600),
            enabled: true,
            fallbackDepth: 7,
            globalRole: 'user',
        })).toBe(true);

        // Higher-priority World State (700) displaces Chronicle to fit.
        expect(applyExtensionPromptInjection({
            key: 'mwt_world_state_injection',
            header: '',
            body: payloadOf(700),
            enabled: true,
            fallbackDepth: 4,
        })).toBe(true);
        expect(getInjectedSnapshot('session_chronicle_injection').enabled).toBe(false);

        // Clearing World State frees 700 tokens. The shared seam's disabled
        // path triggers a rebalance, which restores Chronicle without any
        // Chronicle-specific module event (TODO §2 P2).
        expect(applyExtensionPromptInjection({
            key: 'mwt_world_state_injection',
            header: '',
            body: '',
            enabled: false,
            fallbackDepth: 4,
        })).toBe(false);
        const chronicle = getInjectedSnapshot('session_chronicle_injection');
        expect(chronicle.enabled).toBe(true);
        expect(chronicle.payload).toBe(payloadOf(600));
        expect(chronicle.depth).toBe(7);
        expect(chronicle.role).toBe(1);
        expect(calls.at(-1)[0]).toBe('session_chronicle_injection');
        expect(getEvents({ module: 'budget' }).some((e) => e.event === 'budget_restored')).toBe(true);
    });

    test('a global-cap-dropped module is restored after protected context shrinks', () => {
        const { meta } = fakeSetExtensionPrompt();
        meta[BUDGET_METADATA_KEY] = { enforce: true, globalHardCap: 1000 };
        expect(applyExtensionPromptInjection({ key: 'mwt_world_state_injection', header: '', body: payloadOf(800), enabled: true, fallbackDepth: 4 })).toBe(true);
        expect(applyExtensionPromptInjection({ key: 'session_chronicle_injection', header: '', body: payloadOf(400), enabled: true, fallbackDepth: 7 })).toBe(false);
        expect(getInjectedSnapshot('session_chronicle_injection').enabled).toBe(false);
        expect(applyExtensionPromptInjection({ key: 'mwt_world_state_injection', header: '', body: payloadOf(100), enabled: true, fallbackDepth: 4 })).toBe(true);
        expect(getInjectedSnapshot('session_chronicle_injection').payload).toBe(payloadOf(400));
    });
});

// ─── 8. The panel — collector ────────────────────────────────────────────────

describe('collectBudgetSnapshot', () => {
    test('row shapes: five modules, Knowledge advisory/stored, the seam modules injected', () => {
        const snap = collectBudgetSnapshot({
            settings: settings(),
            injections: {},
            knowledgeTokens: () => 36000,
            contextLimit: { value: 8192, source: 'ctx.maxContext', note: 'x' },
        });
        expect(snap.modules).toHaveLength(5);
        const byId = Object.fromEntries(snap.modules.map((m) => [m.id, m]));
        expect(byId.knowledge.tokenKind).toBe('stored');
        expect(byId.knowledge.advisory).toBe(true);
        expect(byId.knowledge.tokens).toBe(36000);
        expect(byId.world_state.tokenKind).toBe('injected');
        expect(byId.world_state.plan).toBeNull();  // nothing registered
        // Totals never sum across kinds.
        expect(snap.injectedTokens).toBe(0);
        expect(snap.storedTokens).toBe(36000);
        expect(snap.contextLimit.value).toBe(8192);
    });

    test('registered payloads drive both the tokens and the modeled plan', () => {
        recordInjection({ key: 'mwt_world_state_injection', payload: payloadOf(900), role: 0, depth: 4, enabled: true });
        const snap = collectBudgetSnapshot({
            settings: settings({ modules: { world_state: { softCap: 500 } } }),
            knowledgeTokens: () => 0,
            contextLimit: { value: null, source: 'unknown', note: 'n' },
        });
        const ws = snap.modules.find((m) => m.id === 'world_state');
        expect(ws.tokens).toBe(900);
        expect(ws.registered).toBe(true);
        expect(ws.plan.action).toBe('truncate');
        // Bug 3 fix: tokensAfter is the MEASURED result, at most the cap.
        expect(ws.plan.tokensAfter).toBeLessThanOrEqual(500);
        expect(ws.plan.tokensAfter).toBeGreaterThan(0);
    });

    test('a throwing Knowledge accessor degrades its own row, never the snapshot', () => {
        const snap = collectBudgetSnapshot({
            settings: settings(),
            injections: {},
            knowledgeTokens: () => { throw new Error('boom'); },
            contextLimit: { value: null, source: 'unknown', note: 'n' },
        });
        const k = snap.modules.find((m) => m.id === 'knowledge');
        expect(k.tokens).toBe(0);
        expect(snap.errors).toBeDefined();
        expect(snap.errors[0]).toContain('tokens:knowledge');
    });

    test('the pre-send summary aggregates the per-module plans', () => {
        // WS over its soft cap (truncated), Chronicle over its hard cap (dropped).
        recordInjection({ key: 'mwt_world_state_injection', payload: payloadOf(900), role: 0, depth: 4, enabled: true });
        recordInjection({ key: 'session_chronicle_injection', payload: payloadOf(300), role: 0, depth: 2, enabled: true });
        const snap = collectBudgetSnapshot({
            settings: settings({ modules: { world_state: { softCap: 500 }, chronicle: { hardCap: 100 } } }),
            knowledgeTokens: () => 0,
            contextLimit: { value: null, source: 'unknown', note: 'n' },
        });
        const wsKept = snap.modules.find((m) => m.id === 'world_state').plan.tokensAfter;
        // Bug 3 fix: keptTokens is the MEASURED truncated size (≤ the soft cap),
        // not the cap value itself.
        expect(snap.projected).toEqual({ dropped: 1, truncated: 1, keptTokens: wsKept, totalBefore: 1200 });
        const html = renderBudgetSnapshot(snap, { formatTime: () => '12:00:00' });
        expect(html).toContain('At current sizes with these caps');
        expect(html).toContain('<strong>1 dropped</strong>');
        expect(html).toContain('<strong>1 truncated</strong>');
        expect(html).toContain(`~${wsKept.toLocaleString()} of 1,200 tokens kept`);
        expect(html).toContain('would be, if enforcement were on');
    });
});

describe('renderBudgetSnapshot / renderBudgetPane', () => {
    test('renders the mode banners, usage bar, table, and the scope notes', () => {
        const snap = collectBudgetSnapshot({
            settings: settings({ enforce: true }),
            injections: {},
            knowledgeTokens: () => 1200,
            contextLimit: { value: 8192, source: 'ctx.maxContext', note: 'probe note' },
        });
        const html = renderBudgetSnapshot(snap, { formatTime: () => '12:00:00' });
        expect(html).toContain('ENFORCE is ON');
        expect(html).toContain('8,192');
        expect(html).toContain('1,200');
        expect(html).toContain('stored');
        expect(html).toContain('advisory only');
        expect(html).toContain('Actionable drop order');
        expect(html).toContain('outside the actionable drop order');
        // Knowledge's priority/cap fields are explicitly non-editable because
        // its World Info path is advisory and not enforceable.
        expect(html).toContain('data-module="knowledge" type="number"');
        expect(html).toContain('Advisory only — Knowledge is not managed by MWT budget enforcement');
        // The note's apostrophe is literal (template text, not escaped input).
        expect(html).toContain(`THIS CHAT's metadata`);
        expect(html).toContain('mwt-budget-save');
    });

    test('observe mode renders the observe banner and the unknown-limit note', () => {
        const html = renderBudgetSnapshot(collectBudgetSnapshot({
            settings: settings(),
            injections: {},
            knowledgeTokens: () => 0,
            contextLimit: { value: null, source: 'unknown', note: 'No context limit could be read.' },
        }), { formatTime: () => '12:00:00' });
        expect(html).toContain('Observe mode (default)');
        expect(html).toContain('context limit unknown');
    });

    test('renderBudgetPane: a poisoned settings reader still renders (defaults), never throws', () => {
        // getBudgetSettings catches its own read failure and yields the
        // observe-mode defaults, so the pane renders normally — the
        // never-blank-the-tab rule.
        _setBudgetSettingsReader(() => { throw new Error('boom'); });
        const html = renderBudgetPane();
        expect(html).toContain('Observe mode (default)');
    });
});

describe('wireBudgetTab', () => {
    /** Minimal fake element: value/checked + dataset. */
    function field(value, dataset = {}) {
        return { value, checked: value === 'on', dataset };
    }

    /** Minimal fake root with a query map + listener capture. */
    function fakeRoot(fields) {
        const listeners = {};
        const root = {
            querySelector: (sel) => fields[sel] ?? null,
            querySelectorAll: (sel) => (fields.__all?.[sel] ?? []),
        };
        // The Save button is special: capture its click listener.
        root.addEventListener = (evt, fn) => { listeners[evt] = fn; };
        root.__click = () => listeners.click?.();
        return root;
    }

    test('Save reads every field, clamps, and persists through saveBudgetSettings', () => {
        const saved = [];
        const priorityRows = [field('2', { module: 'chronicle' }), field('1', { module: 'world_state' })];
        const softRows = [field('500', { module: 'chronicle' })];
        const hardRows = [field('1200', { module: 'chronicle' })];
        let clickFn = null;
        const root = fakeRoot({
            // The Save BUTTON carries the listener (wireBudgetTab binds to it,
            // not to the root).
            '#mwt-budget-save': { addEventListener: (evt, fn) => { clickFn = fn; } },
            '#mwt-budget-enforce': field('on'),
            '#mwt-budget-global-hard': field('4000'),
            '#mwt-budget-limit-override': field('16000'),
            __all: {
                '.mwt-budget-priority': priorityRows,
                '.mwt-budget-soft': softRows,
                '.mwt-budget-hard': hardRows,
            },
            '.mwt-budget-soft[data-module="chronicle"]': softRows[0],
            '.mwt-budget-hard[data-module="chronicle"]': hardRows[0],
        });
        wireBudgetTab(root, { save: (patch) => { saved.push(patch); return true; } });
        clickFn();
        expect(saved).toHaveLength(1);
        expect(saved[0].enforce).toBe(true);
        expect(saved[0].globalHardCap).toBe(4000);
        expect(saved[0].contextLimitOverride).toBe(16000);
        expect(saved[0].modules.chronicle).toEqual({ priority: 2, softCap: 500, hardCap: 1200 });
        expect(saved[0].modules.world_state).toEqual({ priority: 1 });
    });

    test('Save ignores advisory Knowledge controls even if a stale DOM exposes them', () => {
        const saved = [];
        let clickFn = null;
        const root = fakeRoot({
            '#mwt-budget-save': { addEventListener: (evt, fn) => { clickFn = fn; } },
            '#mwt-budget-enforce': field('on'),
            '#mwt-budget-global-hard': field('0'),
            '#mwt-budget-limit-override': field('0'),
            __all: {
                '.mwt-budget-priority': [field('4', { module: 'knowledge' })],
                '.mwt-budget-soft': [field('500', { module: 'knowledge' })],
                '.mwt-budget-hard': [field('900', { module: 'knowledge' })],
            },
            '.mwt-budget-soft[data-module="knowledge"]': field('500', { module: 'knowledge' }),
            '.mwt-budget-hard[data-module="knowledge"]': field('900', { module: 'knowledge' }),
        });
        wireBudgetTab(root, { save: (patch) => { saved.push(patch); return true; } });
        clickFn();
        expect(saved).toHaveLength(1);
        expect(saved[0].modules.knowledge).toBeUndefined();
    });

    test('Save clamps out-of-range caps instead of silently disabling them', () => {
        const saved = [];
        let clickFn = null;
        const soft = field('3000000', { module: 'chronicle' });
        const hard = field('-5', { module: 'chronicle' });
        const root = fakeRoot({
            '#mwt-budget-save': { addEventListener: (evt, fn) => { clickFn = fn; } },
            '#mwt-budget-enforce': field('on'),
            '#mwt-budget-global-hard': field('3000000'),
            '#mwt-budget-limit-override': field('-5'),
            __all: { '.mwt-budget-priority': [], '.mwt-budget-soft': [soft], '.mwt-budget-hard': [hard] },
            '.mwt-budget-soft[data-module="chronicle"]': soft,
            '.mwt-budget-hard[data-module="chronicle"]': hard,
        });
        wireBudgetTab(root, { save: (patch) => { saved.push(patch); return true; } });
        clickFn();
        expect(saved[0].globalHardCap).toBe(BUDGET_LIMITS.capMax);
        expect(saved[0].contextLimitOverride).toBe(0);
        expect(saved[0].modules.chronicle).toEqual({ softCap: BUDGET_LIMITS.capMax, hardCap: 0 });
    });

    test('a missing Save button wires nothing (rebind-every-render safe)', () => {
        expect(() => wireBudgetTab(fakeRoot({}))).not.toThrow();
    });
});






