/**
 * test/injection_tab.test.js — Diagnostics Phase 9 (Tab 4: Injection).
 *
 * Covers the four layers of the Injection tab, mirroring the Phase 6–8
 * suites:
 *   1. The module-local placement resolvers (world_state / chronicle /
 *      story_planner / interiority resolveInjectionPlacement()): every level
 *      of each module's own depth/role precedence chain, resolved against
 *      the stubbed barrel — plus PARITY tests driving the real appliers and
 *      asserting the registered snapshot's depth/role equal what the
 *      resolver reports (the whole point of sharing one function).
 *   2. diagnostics_panel/injection.js — collectInjectionSnapshot() with
 *      injected specs/modules/settings/allowed/injections/estimate deps:
 *      row shapes, recorded-vs-accessor-vs-stored token kinds, the warning
 *      set (Knowledge caveat always; panic escalation; flag/registration
 *      mismatches; placement drift), and per-field degradation.
 *   3. diagnostics_panel/render.js — renderInjectionSnapshot() /
 *      renderInjectionPane() string builders (panic banner, the mandatory
 *      Knowledge caveat in both tones, provenance labels, the collapsed
 *      content-gated payload blocks, escaping) plus the pane switch that
 *      mounts the sub-tab and moves the placeholder line to Phase 10.
 *
 * The final smoke test exercises the DEFAULT wiring (real module graph under
 * the barrel→stub alias) — it exists to catch import-graph breakage, not to
 * assert live values.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The four module-local placement resolvers + the real appliers (parity).
import {
    resolveInjectionPlacement as wsPlacement,
    applyWorldStateInjection,
} from '../world_state/injection.js';
import {
    resolveInjectionPlacement as chroniclePlacement,
    applyInjection as applyChronicleInjection,
} from '../chronicle/injection.js';
import { resolveInjectionPlacement as planPlacement } from '../story_planner/injection.js';
import { resolveInjectionPlacement as interiorityPlacement } from '../interiority/injection.js';

import {
    collectInjectionSnapshot,
    INJECTION_MODULE_SPECS,
    PLACEMENT_SOURCE_LABELS,
    roleNameToNumber,
    formatInjectionAge,
    scrubPayloadForDisplay,
    redactInjectionSnapshot,
} from '../diagnostics_panel/injection.js';
import {
    renderInjectionPane,
    renderInjectionSnapshot,
    renderDiagnosticsPanel,
    wireDiagnosticsPanel,
} from '../diagnostics_panel/render.js';
import { getInjectedSnapshot, recordInjection, _resetDiagnostics } from '../core/diagnostics.js';
import { MWT_VERSION } from '../core/version.js';
import {
    resetCoreStubs,
    setFakeContextExtras,
    getFakeExtSettings,
    getFakeMeta,
} from './stubs/core.js';

beforeEach(() => {
    resetCoreStubs();
    _resetDiagnostics();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ─── Placement resolvers — every level of each module-local chain ─────────────

describe('resolveInjectionPlacement — the four module chains', () => {
    test('World State: global depth/role win when set', () => {
        setFakeContextExtras({ globalSettings: { worldStateDepth: 9, worldStateRole: 'user' } });
        const p = wsPlacement();
        expect(p.depth).toEqual({ value: 9, source: 'global' });
        expect(p.role).toEqual({ value: 'user', source: 'global' });
    });

    test('World State: module injectionDepth and builtin role without globals', () => {
        getFakeExtSettings()['mwt_world_state'] = { injectionDepth: 7 };
        const p = wsPlacement();
        expect(p.depth).toEqual({ value: 7, source: 'module' });
        expect(p.role).toEqual({ value: 'system', source: 'builtin' });
    });

    test('World State: a non-finite global depth falls through to the module level', () => {
        setFakeContextExtras({ globalSettings: { worldStateDepth: 'not-a-number' } });
        const p = wsPlacement();
        // Module defaults merge injectionDepth: 1 under the stub.
        expect(p.depth).toEqual({ value: 1, source: 'module' });
    });

    test('Chronicle: global chronicleDepth beats this chat\u2019s injectDepth', () => {
        setFakeContextExtras({ globalSettings: { chronicleDepth: 8 } });
        getFakeMeta()['session_chronicle_data'] = { injectDepth: 7, injectEnabled: true, snapshots: [], injectCount: 2, injectMode: 'recent' };
        expect(chroniclePlacement().depth).toEqual({ value: 8, source: 'global' });
    });

    test('Chronicle: the chat\u2019s injectDepth is the module level', () => {
        getFakeMeta()['session_chronicle_data'] = { injectDepth: 7, injectEnabled: true, snapshots: [], injectCount: 2, injectMode: 'recent' };
        const p = chroniclePlacement();
        expect(p.depth).toEqual({ value: 7, source: 'module' });
        expect(p.role).toEqual({ value: 'system', source: 'builtin' });
    });

    test('Chronicle: role chain honors chronicleRole', () => {
        setFakeContextExtras({ globalSettings: { chronicleRole: 'assistant' } });
        expect(chroniclePlacement().role).toEqual({ value: 'assistant', source: 'global' });
    });

    test('Story Planner: module-only depth, fixed role — no global pair exists', () => {
        // Even with a global-looking field present, the planner ignores it.
        setFakeContextExtras({ globalSettings: { injectionDepth: 99, worldStateDepth: 99 } });
        getFakeExtSettings()['mwt_story_planner'] = { injectionDepth: 6 };
        const p = planPlacement();
        expect(p.depth).toEqual({ value: 6, source: 'module' });
        expect(p.role).toEqual({ value: 'system', source: 'builtin' });
    });

    test('Interiority: global pair or builtin 1/system', () => {
        setFakeContextExtras({ globalSettings: { interiorityDepth: 3, interiorityRole: 'user' } });
        expect(interiorityPlacement()).toEqual({
            depth: { value: 3, source: 'global' },
            role: { value: 'user', source: 'global' },
        });
        setFakeContextExtras({ globalSettings: {} });
        expect(interiorityPlacement()).toEqual({
            depth: { value: 1, source: 'builtin' },
            role: { value: 'system', source: 'builtin' },
        });
    });
});

// ─── Parity — the appliers register exactly what the resolvers resolve ────────

describe('parity — appliers register what their resolver reports', () => {
    test('World State apply → snapshot depth/role equal resolveInjectionPlacement()', () => {
        setFakeContextExtras({
            globalSettings: { worldStateDepth: 9, worldStateRole: 'user' },
            setExtensionPrompt: () => {},
        });
        getFakeMeta()['world_state_tracker_metadata'] = { text: '## Current Scene\nMara enters the tavern.' };
        applyWorldStateInjection();
        const snap = getInjectedSnapshot('mwt_world_state_injection');
        const p = wsPlacement();
        expect(snap.enabled).toBe(true);
        expect(snap.payload).toContain('Current Scene');
        expect(snap.depth).toBe(p.depth.value);
        expect(snap.depth).toBe(9);
        expect(snap.role).toBe(roleNameToNumber(p.role.value));
        expect(snap.role).toBe(1);
    });

    test('Chronicle apply → snapshot depth equals the resolver (chat level wins)', () => {
        setFakeContextExtras({ setExtensionPrompt: () => {} });
        getFakeMeta()['session_chronicle_data'] = {
            injectEnabled: true, injectDepth: 7, injectCount: 2, injectMode: 'recent',
            snapshots: [{ id: 's1', text: 'The party reached the coast.', createdAt: '2026-08-19T10:00:00Z', characters: ['Mara'] }],
        };
        applyChronicleInjection();
        const snap = getInjectedSnapshot('session_chronicle_injection');
        const p = chroniclePlacement();
        expect(snap.enabled).toBe(true);
        expect(snap.payload).toContain('The party reached the coast.');
        expect(snap.depth).toBe(p.depth.value);
        expect(snap.depth).toBe(7);
        expect(snap.role).toBe(0); // system
    });
});

// ─── collectInjectionSnapshot ─────────────────────────────────────────────────

/** A spec row with everything injectable, defaulting to an on/open module. */
function spec(over = {}) {
    return {
        id: 'world_state', label: '🌍 World State', moduleKey: 'WorldState',
        key: 'k-ws', mechanism: 'extension-prompt', tokenKind: 'injected',
        isEnabled: () => true,
        resolvePlacement: () => ({
            depth: { value: 4, source: 'global' },
            role: { value: 'system', source: 'builtin' },
        }),
        ...over,
    };
}

/** Default deps: everything injected, nothing live. */
function deps(extra = {}) {
    return {
        specs: [spec()],
        modules: { world_state: { getTotalTokens: () => 123 } },
        settings: {},
        allowed: () => true,
        injections: () => ({}),
        estimate: (t) => Math.ceil(String(t).length / 4),
        version: '9.9.9-test',
        now: () => 1_000_000,
        ...extra,
    };
}

const LIVE_SNAP = { key: 'k-ws', payload: 'hello world', role: 0, depth: 4, enabled: true, at: 940_000 };

describe('collectInjectionSnapshot — rows, provenance, tokens', () => {
    test('spec table keys match the real module constants (drift guard)', () => {
        const byId = Object.fromEntries(INJECTION_MODULE_SPECS.map((s) => [s.id, s]));
        expect(byId.world_state.key).toBe('mwt_world_state_injection');
        expect(byId.chronicle.key).toBe('session_chronicle_injection');
        expect(byId.story_planner.key).toBe('mwt_story_plan_injection');
        expect(byId.interiority.key).toBe('mwt_interiority_injection');
        expect(byId.knowledge.key).toBeNull();
        expect(byId.knowledge.mechanism).toBe('lorebook');
        expect(PLACEMENT_SOURCE_LABELS).toHaveProperty('global');
        expect(PLACEMENT_SOURCE_LABELS).toHaveProperty('module');
        expect(PLACEMENT_SOURCE_LABELS).toHaveProperty('builtin');
    });

    test('no snapshot yet → enabled/gate/placement passthrough + accessor-kind tokens', () => {
        const snap = collectInjectionSnapshot(deps());
        const row = snap.modules[0];
        expect(row.enabled).toBe(true);
        expect(row.gate).toBe(true);
        expect(row.placement).toEqual({
            depth: { value: 4, source: 'global' },
            role: { value: 'system', source: 'builtin' },
        });
        // Nothing registered this session → the module accessor estimate.
        expect(row.tokens).toEqual({ value: 123, kind: 'accessor' });
        expect(row.snapshot).toBeNull();
        expect(snap.livePayloads).toBe(0);
        expect(snap.registeredTokens).toBe(0);
        expect(snap.injectionMasterOff).toBe(false);
        expect(snap.structuralBoundaries).toBe(true);
        expect(snap.mwtVersion).toBe('9.9.9-test');
        expect(snap.generatedAt).toBe(1_000_000);
    });

    test('a recorded snapshot wins: payload tokens, chars, age', () => {
        const snap = collectInjectionSnapshot(deps({ injections: () => ({ 'k-ws': LIVE_SNAP }) }));
        const row = snap.modules[0];
        expect(row.snapshot).toEqual({
            present: true, enabled: true, payload: 'hello world', chars: 11,
            role: 0, depth: 4, at: 940_000, ageSec: 60,
        });
        expect(row.tokens).toEqual({ value: 3, kind: 'recorded' }); // ceil(11/4)
        expect(snap.livePayloads).toBe(1);
        expect(snap.registeredTokens).toBe(3);
    });

    test('a cleared snapshot is shown as a clear, not hidden', () => {
        const snap = collectInjectionSnapshot(deps({
            injections: () => ({ 'k-ws': { ...LIVE_SNAP, payload: '', enabled: false } }),
        }));
        const row = snap.modules[0];
        expect(row.snapshot.enabled).toBe(false);
        expect(row.snapshot.chars).toBe(0);
        expect(row.tokens).toEqual({ value: 0, kind: 'recorded' });
        expect(snap.livePayloads).toBe(0);
    });

    test('Knowledge-shaped spec: enabled null, stored tokens, no snapshot, note', () => {
        const snap = collectInjectionSnapshot(deps({
            specs: [spec({
                id: 'knowledge', moduleKey: 'Knowledge', key: null, mechanism: 'lorebook',
                tokenKind: 'stored', isEnabled: null, resolvePlacement: null,
                note: 'lorebook entries', moduleSourceLabel: undefined,
            })],
            modules: { knowledge: { getTotalTokens: () => 50_000 } },
        }));
        const row = snap.modules[0];
        expect(row.enabled).toBeNull();
        expect(row.placement).toBeNull();
        expect(row.snapshot).toBeNull();
        expect(row.tokens).toEqual({ value: 50_000, kind: 'stored' });
        expect(row.note).toBe('lorebook entries');
        // Stored corpus is never summed into registered prompt tokens.
        expect(snap.registeredTokens).toBe(0);
    });

    test('per-field degradation: throwing accessors degrade their own field only', () => {
        const snap = collectInjectionSnapshot(deps({
            specs: [spec({
                isEnabled: () => { throw new Error('flag boom'); },
                resolvePlacement: () => { throw new Error('placement boom'); },
            })],
            allowed: () => { throw new Error('gate boom'); },
        }));
        const row = snap.modules[0];
        expect(row.enabled).toBeNull();
        expect(row.gate).toBe(false); // fails closed
        expect(row.placement).toBeNull();
        expect(row.errors).toEqual([
            'enabled: flag boom',
            'gate: gate boom',
            'placement: placement boom',
        ]);
    });

    test('a throwing snapshot read degrades Registered cells, not the tab', () => {
        const snap = collectInjectionSnapshot(deps({ injections: () => { throw new Error('store boom'); } }));
        expect(snap.modules[0].snapshot).toBeNull();
        expect(snap.errors).toEqual(['injections: store boom']);
    });

    test('a malformed placement result normalises to null', () => {
        const snap = collectInjectionSnapshot(deps({
            specs: [spec({ resolvePlacement: () => ({ depth: { value: 'four', source: 'global' }, role: { value: 'system', source: 'builtin' } }) })],
        }));
        expect(snap.modules[0].placement).toBeNull();
    });
});

describe('collectInjectionSnapshot — warnings', () => {
    test('the Knowledge caveat is always present (TODO §4 closure)', () => {
        const snap = collectInjectionSnapshot(deps());
        const ids = snap.warnings.map((w) => w.id);
        expect(ids).toContain('knowledge-lorebook-caveat');
        expect(snap.warnings.find((w) => w.id === 'knowledge-lorebook-caveat').level).toBe('warn');
        expect(snap.bannerLevel).toBe('warn');
    });

    test('panic switch: fail-level panic warning + the caveat escalates', () => {
        const snap = collectInjectionSnapshot(deps({ settings: { injectionMasterOff: true } }));
        expect(snap.injectionMasterOff).toBe(true);
        const panic = snap.warnings.find((w) => w.id === 'panic-master-off');
        expect(panic.level).toBe('fail');
        const caveat = snap.warnings.find((w) => w.id === 'knowledge-lorebook-caveat');
        expect(caveat.level).toBe('fail');
        expect(caveat.text).toContain('NOT stopped by the panic switch');
        expect(snap.bannerLevel).toBe('fail');
    });

    test('flag on + gate open, but the last registration was a CLEAR', () => {
        const snap = collectInjectionSnapshot(deps({
            injections: () => ({ 'k-ws': { ...LIVE_SNAP, payload: '', enabled: false } }),
        }));
        expect(snap.warnings.map((w) => w.id)).toContain('flag-on-registered-empty:world_state');
    });

    test('module off but a live payload is STILL registered', () => {
        const snap = collectInjectionSnapshot(deps({
            specs: [spec({ isEnabled: () => false })],
            injections: () => ({ 'k-ws': LIVE_SNAP }),
        }));
        expect(snap.warnings.map((w) => w.id)).toContain('flag-off-registered-live:world_state');
    });

    test('gated module with a live payload also warns (the panic case)', () => {
        const snap = collectInjectionSnapshot(deps({
            allowed: () => false,
            injections: () => ({ 'k-ws': LIVE_SNAP }),
        }));
        expect(snap.warnings.map((w) => w.id)).toContain('flag-off-registered-live:world_state');
    });

    test('placement drift: settings now resolve differently than the registration', () => {
        const snap = collectInjectionSnapshot(deps({
            resolvePlacement: undefined,
            specs: [spec({
                resolvePlacement: () => ({
                    depth: { value: 9, source: 'global' },
                    role: { value: 'user', source: 'global' },
                }),
            })],
            injections: () => ({ 'k-ws': LIVE_SNAP }), // registered at 4/system
        }));
        const w = snap.warnings.find((x) => x.id === 'placement-drift:world_state');
        expect(w).toBeDefined();
        expect(w.text).toContain('depth 4');
        expect(w.text).toContain('depth 9');
        expect(w.text).toContain('user');
    });

    test('structuralBoundaries: false reads through', () => {
        const snap = collectInjectionSnapshot(deps({ settings: { structuralBoundaries: false } }));
        expect(snap.structuralBoundaries).toBe(false);
    });
});

describe('formatInjectionAge', () => {
    test.each([
        [null, '—'],
        [5, 'just now'],
        [45, '45s ago'],
        [125, '2m ago'],
        [7_500, '2h 05m ago'],
        [100_800, '1d 4h ago'],
    ])('%s → %s', (sec, expected) => {
        expect(formatInjectionAge(sec)).toBe(expected);
    });
});

// ─── renderInjectionSnapshot — the pane markup ─────────────────────────────────

const T = () => '12:00:00';

/** Deps with three rows: a live hostile-payload row, a cleared row, Knowledge. */
function renderDeps(over = {}) {
    const hostile = '<script>alert(1)</script> & "quotes"';
    return deps({
        specs: [
            spec(),
            spec({
                id: 'chronicle', moduleKey: 'Chronicle', key: 'k-ch',
                moduleSourceLabel: "this chat's Chronicle setting",
                resolvePlacement: () => ({
                    depth: { value: 7, source: 'module' },
                    role: { value: 'assistant', source: 'global' },
                }),
            }),
            spec({
                id: 'knowledge', moduleKey: 'Knowledge', key: null, mechanism: 'lorebook',
                tokenKind: 'stored', isEnabled: null, resolvePlacement: null,
                note: 'Injects through lorebook entries.',
            }),
        ],
        modules: {
            world_state: { getTotalTokens: () => 123 },
            chronicle: { getTotalTokens: () => 55 },
            knowledge: { getTotalTokens: () => 50_000 },
        },
        injections: () => ({
            'k-ws': { ...LIVE_SNAP, payload: hostile, chars: hostile.length },
            'k-ch': { key: 'k-ch', payload: '', role: 0, depth: 7, enabled: false, at: 970_000 },
        }),
        ...over,
    });
}

describe('renderInjectionSnapshot — banners, provenance, payloads', () => {
    test('stat header + all three rows render', () => {
        const html = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps()), { formatTime: T });
        expect(html).toContain('MWT v9.9.9-test');
        expect(html).toContain('read at 12:00:00');
        expect(html).toContain('data-module="world_state"');
        expect(html).toContain('data-module="chronicle"');
        expect(html).toContain('data-module="knowledge"');
        expect(html).toContain('1</strong> live payload(s)');
    });

    test('panic banner appears only when the switch is on', () => {
        const quiet = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps()), { formatTime: T });
        expect(quiet).not.toContain('PANIC SWITCH ON');
        const panic = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps({ settings: { injectionMasterOff: true } })), { formatTime: T });
        expect(panic).toContain('mwt-diag-panic');
        expect(panic).toContain('PANIC SWITCH ON');
    });

    test('the Knowledge caveat banner is always shown, and escalates under panic', () => {
        const normal = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps()), { formatTime: T });
        expect(normal).toContain('Knowledge caveat');
        expect(normal).toContain('mwt-diag-scope-banner--warn');
        expect(normal).toContain('keyword activation');
        const panic = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps({ settings: { injectionMasterOff: true } })), { formatTime: T });
        expect(panic).toContain('mwt-diag-scope-banner--fail');
        expect(panic).toContain('NOT stopped by the panic switch');
        // …and the caveat never renders twice (excluded from the warnings list).
        expect(panic.split('Knowledge caveat').length - 1).toBe(1);
    });

    test('depth/role cells show the provenance label, incl. the Chronicle override', () => {
        const html = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps()), { formatTime: T });
        expect(html).toContain('(global override (Settings tab))');
        expect(html).toContain('(built-in default)');
        // escapeHtml() escapes the apostrophe in the Chronicle override label.
        expect(html).toContain('(this chat&#39;s Chronicle setting)');
        expect(html).toContain('assistant');
        // Knowledge has no placement: dim em-dash cells.
        expect(html).toContain('<span class="mwt-diag-dim">—</span>');
    });

    test('Registered cell variants: never · applied+age · cleared', () => {
        const html = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps()), { formatTime: T });
        expect(html).toContain('>never<');
        expect(html).toContain('12:00:00');
        // now=1,000,000: the live snapshot (at 940,000) is 60s old; the
        // cleared one (at 970,000) is 30s old.
        expect(html).toContain('1m ago');
        expect(html).toContain('30s ago');
        expect(html).toContain('cleared');
    });

    test('payloads render collapsed + fully DEFERRED: no payload text in the markup at all', () => {
        const html = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps()), { formatTime: T });
        // Collapsed by default — no open attribute on any details block.
        expect(html).not.toContain('<details class="mwt-diag-inj-details" open');
        expect(html).toContain('<details class="mwt-diag-inj-details">');
        // The gated placeholder ships visible; the payload <pre> ships EMPTY,
        // carrying only the snapshot KEY (redaction contract §I.6 — the text
        // enters the DOM only on opt-in, scrubbed, via wireDiagnosticsPanel).
        expect(html).toContain('data-diag-inj-gate="placeholder"');
        expect(html).toContain('[content excluded');
        expect(html).toContain('secrets stay redacted even then');
        expect(html).toContain('<pre class="mwt-diag-inj-payload" data-diag-inj-gate="body" data-diag-inj-key="k-ws" hidden></pre>');
        // The hostile payload text is nowhere in the markup — neither raw…
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).not.toContain('alert(1)');
        // …nor escaped: the reveal inserts textContent later, so the string
        // builder never carries payload text at all.
        expect(html).not.toContain('&lt;script&gt;');
    });

    test('token kinds are stated: bare recorded · est. · stored', () => {
        const html = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps()), { formatTime: T });
        expect(html).toContain('>est.<'); // world_state? no — ws has a snapshot; knowledge stored; chronicle cleared
        expect(html).toContain('stored');
        expect(html).toContain('50,000');
    });

    test('Knowledge row: n/a On cell + its lorebook note', () => {
        const html = renderInjectionSnapshot(collectInjectionSnapshot(renderDeps()), { formatTime: T });
        expect(html).toContain('>n/a<');
        expect(html).toContain('Injects through lorebook entries.');
    });
});

// ─── Pane mounting + default-wiring smoke ─────────────────────────────────────

describe('renderInjectionPane (default wiring)', () => {
    test('collects and renders against the real module graph without throwing', () => {
        const html = renderInjectionPane();
        // Not asserting live values (state depends on stubbed context) — only
        // that the default wiring resolves end-to-end and renders the table.
        expect(html).toContain('mwt-diag-inj');
        expect(html).toContain('Knowledge caveat');
        // The real version constant flows through (direct core/version.js
        // import — the §II.3 alias trap).
        expect(html).toContain(`MWT v${MWT_VERSION}`);
    });

    test('the panel shell mounts the Injection pane instead of its placeholder', () => {
        const html = renderDiagnosticsPanel();
        expect(html).toContain('data-diag-tab="injection"');
        // The real pane rendered (not the Phase 9 placeholder card)…
        expect(html).toContain('mwt-diag-inj');
        expect(html).not.toContain('Phase 9 — not built yet');
        // …while later tabs still show their placeholders (Phase 10 owns the
        // line now — it moves again when Last request lands).
        expect(html).toContain('Phase 10 — not built yet');
    });
});

// ─── scrubPayloadForDisplay — the redaction gate on displayed payloads ────────

describe('scrubPayloadForDisplay — opting into content never opts into secrets', () => {
    // A payload quoting an authenticated URL, a key-shaped secret, and a
    // bearer token — the shapes the shared redaction layer (core/redaction.js
    // Rule 1b) exists to catch inside free text.
    const SECRET_PAYLOAD = [
        'Mara calls https://user:hunter2@proxy.example.com/v1/sk-live-abcdef123456/completions',
        'with pasted key sk-live-abcdef123456 and header Bearer abcdef1234567890xyz.',
    ].join(' ');

    test('a key-shaped secret and an authenticated URL are scrubbed, prose survives', () => {
        const out = scrubPayloadForDisplay(SECRET_PAYLOAD);
        // The prose that makes the payload diagnostic survives…
        expect(out).toContain('Mara calls');
        expect(out).toContain('with pasted key');
        // …the authenticated URL is cut to scheme + host (userinfo, the
        // key-bearing path, everything after the host: gone)…
        expect(out).toContain('https://proxy.example.com');
        expect(out).not.toContain('user:');
        expect(out).not.toContain('hunter2');
        expect(out).not.toContain('/v1/');
        // …the bare key-shaped secret and the bearer token are redacted.
        expect(out).not.toContain('sk-live-abcdef123456');
        expect(out).not.toContain('Bearer abcdef');
        expect(out).toContain('[REDACTED]');
    });

    test('a knownSecrets value with no recognizable shape is still struck (exact match)', () => {
        const out = scrubPayloadForDisplay(
            'backend echoed my-live-key-XYZ twice: my-live-key-XYZ',
            { knownSecrets: ['my-live-key-XYZ'] },
        );
        expect(out).not.toContain('my-live-key-XYZ');
        expect(out).toContain('[REDACTED]');
    });

    test('non-string / empty input degrades safely; clean text passes through', () => {
        expect(scrubPayloadForDisplay('')).toBe('');
        expect(scrubPayloadForDisplay(null)).toBe('');
        expect(scrubPayloadForDisplay(undefined)).toBe('');
        expect(scrubPayloadForDisplay('plain world state line')).toBe('plain world state line');
    });
});

// ─── redactInjectionSnapshot — the safe-by-default console-bridge return ──────

describe('redactInjectionSnapshot — what injectionStatus() returns', () => {
    const SECRET_PAYLOAD = 'Mara calls https://user:hunter2@proxy.example.com/v1/sk-live-abcdef123456/completions with key sk-live-abcdef123456.';

    /** A collected snapshot carrying the secret payload + a secret-bearing error note. */
    function secretSnapshot() {
        return collectInjectionSnapshot(deps({
            specs: [
                spec(),
                spec({
                    id: 'chronicle', moduleKey: 'Chronicle', key: 'k-ch',
                    // An accessor whose failure text quotes a key — errors are
                    // strings too, and Rule 1b must reach them.
                    isEnabled: () => { throw new Error('flag blew up with sk-live-abcdef123456'); },
                }),
            ],
            modules: { world_state: { getTotalTokens: () => 1 }, chronicle: {} },
            injections: () => ({ 'k-ws': { ...LIVE_SNAP, payload: SECRET_PAYLOAD, chars: SECRET_PAYLOAD.length } }),
        }));
    }

    test('DEFAULT: payloads gate to size markers; the rest of the snapshot survives', () => {
        const snap = secretSnapshot();
        const out = redactInjectionSnapshot(snap);
        const ws = out.modules.find((m) => m.id === 'world_state');
        // `payload` is a CONTENT_KEYS member: replaced by the size-only
        // marker — no payload text at all in the default return value.
        expect(ws.snapshot.payload).toBe(`[content excluded — ${SECRET_PAYLOAD.length} chars]`);
        // The diagnostic metadata around it survives untouched.
        expect(ws.snapshot.chars).toBe(SECRET_PAYLOAD.length);
        expect(ws.snapshot.enabled).toBe(true);
        expect(ws.snapshot.ageSec).toBe(60);
        expect(ws.tokens).toEqual({ value: Math.ceil(SECRET_PAYLOAD.length / 4), kind: 'recorded' });
        expect(out.warnings.map((w) => w.id)).toContain('knowledge-lorebook-caveat');
        expect(out.mwtVersion).toBe('9.9.9-test');
    });

    test('DEFAULT: secrets are scrubbed from EVERY string, including error notes', () => {
        const out = redactInjectionSnapshot(secretSnapshot());
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain('sk-live-abcdef123456');
        expect(serialized).not.toContain('hunter2');
        // The throwing accessor's error note survives as a note, scrubbed.
        const ch = out.modules.find((m) => m.id === 'chronicle');
        expect(ch.errors[0]).toContain('flag blew up');
        expect(ch.errors[0]).toContain('[REDACTED]');
    });

    test('includeContent: true — payloads INCLUDED but still secret-scrubbed', () => {
        const out = redactInjectionSnapshot(secretSnapshot(), { includeContent: true });
        const payload = out.modules.find((m) => m.id === 'world_state').snapshot.payload;
        expect(payload).toContain('Mara calls');
        expect(payload).toContain('https://proxy.example.com');
        expect(payload).not.toContain('user:');
        expect(payload).not.toContain('hunter2');
        expect(payload).not.toContain('sk-live-abcdef123456');
        expect(payload).toContain('[REDACTED]');
    });

    test('knownSecrets: a no-shape live secret value is struck (exact match)', () => {
        const snap = collectInjectionSnapshot(deps({
            injections: () => ({ 'k-ws': { ...LIVE_SNAP, payload: 'echoed my-live-key-XYZ twice' } }),
        }));
        const out = redactInjectionSnapshot(snap, { includeContent: true, knownSecrets: ['my-live-key-XYZ'] });
        expect(out.modules[0].snapshot.payload).not.toContain('my-live-key-XYZ');
        expect(out.modules[0].snapshot.payload).toContain('[REDACTED]');
    });

    test('the input snapshot is never mutated (the raw text stays only in the store)', () => {
        const snap = secretSnapshot();
        redactInjectionSnapshot(snap);
        redactInjectionSnapshot(snap, { includeContent: true });
        expect(snap.modules.find((m) => m.id === 'world_state').snapshot.payload).toBe(SECRET_PAYLOAD);
    });
});

// ─── wireDiagnosticsPanel — the deferred, scrubbed payload reveal ─────────────

/**
 * Minimal fake panel root: enough surface for wireDiagnosticsPanel() to find
 * the content opt-in checkbox and the Injection payload gate elements (and
 * nothing else — the tab bar / copy button / CMRS cell return null, which the
 * wiring already tolerates). Node has no DOM; this pins the reveal logic.
 */
function fakePanelRoot() {
    const bodies = [{ dataset: { diagInjKey: 'k-ws' }, hidden: true, textContent: '' }];
    const placeholders = [{ dataset: {}, hidden: false, textContent: 'gate' }];
    const checkbox = {
        checked: false,
        listeners: {},
        addEventListener(evt, fn) { this.listeners[evt] = fn; },
    };
    const root = {
        querySelector(sel) {
            if (typeof sel === 'string' && sel.includes('mwt-diag-include-content')) return checkbox;
            return null;
        },
        querySelectorAll(sel) {
            if (typeof sel === 'string' && sel.includes('diag-inj-gate="body"')) return bodies;
            if (typeof sel === 'string' && sel.includes('diag-inj-gate="placeholder"')) return placeholders;
            return [];
        },
    };
    return { root, checkbox, bodies, placeholders };
}

describe('wireDiagnosticsPanel — payload reveal (deferred + scrubbed)', () => {
    test('opt-in inserts the payload SCRUBBED — key secret and authenticated URL never reach the DOM', () => {
        // Seed the REAL Phase 2 store: the reveal reads it live by key.
        recordInjection({
            key: 'k-ws',
            payload: 'Mara calls https://user:hunter2@proxy.example.com/v1/x/completions with key sk-live-abcdef123456.',
            role: 0, depth: 4, enabled: true,
        });
        const { root, checkbox, bodies, placeholders } = fakePanelRoot();
        wireDiagnosticsPanel(root);

        // Pre-opt-in: the body element is empty — no payload text is hiding
        // anywhere in the DOM behind `hidden`.
        expect(bodies[0].textContent).toBe('');

        checkbox.checked = true;
        checkbox.listeners.change();
        const text = bodies[0].textContent;
        expect(text).toContain('Mara calls');
        expect(text).toContain('https://proxy.example.com');
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain('user:');
        expect(text).not.toContain('sk-live-abcdef123456');
        expect(text).toContain('[REDACTED]');
        // Visibility flipped with the fill.
        expect(bodies[0].hidden).toBe(false);
        expect(placeholders[0].hidden).toBe(true);
    });

    test('un-ticking clears the payload text back out of the DOM', () => {
        recordInjection({ key: 'k-ws', payload: 'ordinary world state text', role: 0, depth: 4, enabled: true });
        const { root, checkbox, bodies, placeholders } = fakePanelRoot();
        wireDiagnosticsPanel(root);
        checkbox.checked = true;
        checkbox.listeners.change();
        expect(bodies[0].textContent).toContain('ordinary world state text');
        checkbox.checked = false;
        checkbox.listeners.change();
        expect(bodies[0].textContent).toBe('');
        expect(bodies[0].hidden).toBe(true);
        expect(placeholders[0].hidden).toBe(false);
    });

    test('a body whose key has no snapshot fills empty, never throws', () => {
        const { root, checkbox, bodies } = fakePanelRoot(); // 'k-ws' never recorded
        wireDiagnosticsPanel(root);
        checkbox.checked = true;
        expect(() => checkbox.listeners.change()).not.toThrow();
        expect(bodies[0].textContent).toBe('');
    });
});
