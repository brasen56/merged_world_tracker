/**
 * test/health_tab.test.js — Diagnostics Phase 6 (Tab 1: Health).
 *
 * Covers the three layers of the Health tab:
 *   1. diagnostics_panel/health.js — collectHealthSnapshot() with injected
 *      modules/settings/accessors (the DOM-free core), plus the
 *      normaliseAutoStatus / resolveLastRun helpers it leans on.
 *   2. diagnostics_panel/render.js — renderHealthSnapshot() /
 *      formatHealthDuration() string builders (panic banner, badges,
 *      escaping).
 *   3. The Phase 6 module-key stamping: each module's settings defaults now
 *      carry `module: '<id>'` so core/api.js captureApiCall() keys per-module
 *      telemetry (getLastApiCall('world_state') etc.) — without it every
 *      live call lands under 'api' and the tab's last-run column stays empty.
 *
 * The final smoke test exercises the DEFAULT wiring (real module namespaces
 * under the barrel→stub alias) — it exists to catch import-graph breakage,
 * not to assert live values.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    HEALTH_MODULE_SPECS,
    collectHealthSnapshot,
    normaliseAutoStatus,
    resolveLastRun,
} from '../diagnostics_panel/health.js';
import { renderHealthSnapshot, renderHealthPane, formatHealthDuration } from '../diagnostics_panel/render.js';
import { _resetDiagnostics, getLastApiCall } from '../core/diagnostics.js';
import { fetchFromApi } from '../core/api.js';
import { getSettings as getWsSettings } from '../world_state/settings.js';
import { getSettings as getChronicleSettings } from '../chronicle/data.js';
import { getSettings as getKnowledgeSettings } from '../knowledge/settings.js';
import { getSettings as getSpSettings } from '../story_planner/settings.js';
import { getSettings as getIntSettings } from '../interiority/data.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** A module namespace answering every accessor the Health tab reads. */
function fakeNamespace(overrides = {}) {
    return {
        isRefreshing: () => false,
        isGeneratingSnapshot: () => false,
        isScanning: () => false,
        isGenerating: () => false,
        getTotalTokens: () => 0,
        getAutoRefreshStatus: () => null,
        getAutoSnapshotStatus: () => null,
        getAutoScanStatus: () => null,
        getAutoPlanStatus: () => null,
        getAutoStatus: () => null,
        ...overrides,
    };
}

function fakeModules(overrides = {}) {
    return {
        world_state: fakeNamespace(overrides.world_state),
        chronicle: fakeNamespace(overrides.chronicle),
        knowledge: fakeNamespace(overrides.knowledge),
        story_planner: fakeNamespace(overrides.story_planner),
        interiority: fakeNamespace(overrides.interiority),
    };
}

const NO_RUN_DATA = { lastApiCall: () => undefined, lastRun: () => undefined };

/** Default deps: everything injected, nothing live. */
function deps(extra = {}) {
    return {
        modules: fakeModules(),
        settings: {},
        allowed: () => true,
        diagnostics: NO_RUN_DATA,
        version: '9.9.9-test',
        now: () => 1_700_000_000_000,
        ...extra,
    };
}

beforeEach(() => {
    _resetDiagnostics();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

// ─── collectHealthSnapshot — header ──────────────────────────────────────────

describe('collectHealthSnapshot — header', () => {
    test('carries version, generation time, panic switch, and the summed token load', () => {
        const snap = collectHealthSnapshot(deps({
            modules: fakeModules({
                world_state: { getTotalTokens: () => 100 },
                chronicle: { getTotalTokens: () => 200 },
                knowledge: { getTotalTokens: () => 50 },
                story_planner: { getTotalTokens: () => 0 },
                interiority: { getTotalTokens: () => 25 },
            }),
        }));
        expect(snap.mwtVersion).toBe('9.9.9-test');
        expect(snap.generatedAt).toBe(1_700_000_000_000);
        expect(snap.injectionMasterOff).toBe(false);
        // Knowledge's 50 is lorebook corpus, not prompt load: it is reported
        // separately and never folded into the injected total.
        expect(snap.injectedTokens).toBe(325);
        expect(snap.storedTokens).toBe(50);
    });

    test('a huge Knowledge library never inflates the injected total', () => {
        // The reference chat's ~36k lorebook corpus is the case this guards:
        // summed into one figure it reads as a 36k injection, which is false.
        const snap = collectHealthSnapshot(deps({
            modules: fakeModules({
                world_state: { getTotalTokens: () => 2_200 },
                knowledge: { getTotalTokens: () => 36_000 },
            }),
        }));
        expect(snap.injectedTokens).toBe(2_200);
        expect(snap.storedTokens).toBe(36_000);
        expect(snap).not.toHaveProperty('totalTokens'); // no addable-looking field survives
    });

    test('every row declares which kind of tokens it counted', () => {
        const byId = Object.fromEntries(collectHealthSnapshot(deps()).modules.map(r => [r.id, r]));
        expect(byId.knowledge.tokenKind).toBe('stored');
        for (const id of ['world_state', 'chronicle', 'story_planner', 'interiority']) {
            expect(byId[id].tokenKind).toBe('injected');
        }
    });

    test('flags injectionMasterOff from the global settings', () => {
        const snap = collectHealthSnapshot(deps({ settings: { injectionMasterOff: true } }));
        expect(snap.injectionMasterOff).toBe(true);
    });
});

// ─── collectHealthSnapshot — per-module rows ─────────────────────────────────

describe('collectHealthSnapshot — module rows', () => {
    test('yields one row per module, in panel order', () => {
        const snap = collectHealthSnapshot(deps());
        expect(snap.modules.map(m => m.id)).toEqual(HEALTH_MODULE_SPECS.map(s => s.id));
    });

    test('enabled mirrors the enable<ModuleKey> flag (absent = on)', () => {
        const snap = collectHealthSnapshot(deps({
            settings: { enableChronicle: false, enableInteriority: false },
        }));
        const byId = Object.fromEntries(snap.modules.map(m => [m.id, m]));
        expect(byId.chronicle.enabled).toBe(false);
        expect(byId.interiority.enabled).toBe(false);
        expect(byId.world_state.enabled).toBe(true);
        expect(byId.knowledge.enabled).toBe(true);
    });

    test('injection gate comes from injectionAllowed(moduleKey)', () => {
        const snap = collectHealthSnapshot(deps({
            allowed: (key) => key !== 'Knowledge',
        }));
        const byId = Object.fromEntries(snap.modules.map(m => [m.id, m]));
        expect(byId.knowledge.injectionAllowed).toBe(false);
        expect(byId.world_state.injectionAllowed).toBe(true);
    });

    test.each([
        ['world_state', 'isRefreshing'],
        ['chronicle', 'isGeneratingSnapshot'],
        ['knowledge', 'isScanning'],
        ['story_planner', 'isGenerating'],
        ['interiority', 'isGenerating'],
    ])('busy normalizes %s (%s) onto one boolean', (id, accessor) => {
        const snap = collectHealthSnapshot(deps({
            modules: fakeModules({ [id]: { [accessor]: () => true } }),
        }));
        const row = snap.modules.find(m => m.id === id);
        expect(row.busy).toBe(true);
        // …and only that module is busy.
        expect(snap.modules.filter(m => m.busy)).toHaveLength(1);
    });
});

});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
});

describe('collectHealthSnapshot — row details (auto, last run, guards)', () => {
    test('auto normalizes each module\'s status shape inside the row', () => {
        const snap = collectHealthSnapshot(deps({
            modules: fakeModules({
                world_state: { getAutoRefreshStatus: () => ({ counter: 2, interval: 5 }) },
                chronicle: { getAutoSnapshotStatus: () => ({ counter: 45, threshold: 40 }) },
                knowledge: { getAutoScanStatus: () => ({ counter: 3, interval: 10 }) },
                story_planner: { getAutoPlanStatus: () => null },
                interiority: { getAutoStatus: () => ({ perTurn: true, counter: 1, interval: 20, dormantCount: 3, pollDue: true }) },
            }),
        }));
        const byId = Object.fromEntries(snap.modules.map(m => [m.id, m]));
        expect(byId.world_state.auto).toEqual({ counter: 2, interval: 5, remaining: 3 });
        // Chronicle names it `threshold`, and its counter can overshoot —
        // remaining clamps at 0 instead of going negative.
        expect(byId.chronicle.auto).toEqual({ counter: 45, interval: 40, remaining: 0 });
        expect(byId.knowledge.auto).toEqual({ counter: 3, interval: 10, remaining: 7 });
        expect(byId.story_planner.auto).toBeNull();
        // Interiority's per-turn schedule passes its poll extras through.
        expect(byId.interiority.auto).toMatchObject({ perTurn: true, remaining: 19, dormantCount: 3, pollDue: true });
    });

    test('last run prefers whichever source is fresher', () => {
        const snap = collectHealthSnapshot(deps({
            diagnostics: {
                lastApiCall: (id) => id === 'knowledge'
                    ? { at: 5_000, ok: true, durationMs: 1_200, model: 'm', status: 200, retries: 1 }
                    : undefined,
                lastRun: (id) => id === 'knowledge'
                    ? { startedAt: 9_000, finishedAt: 9_100, ok: false, error: 'boom', tokensIn: 1, tokensOut: 2, trigger: 'manual' }
                    : undefined,
            },
        }));
        const kn = snap.modules.find(m => m.id === 'knowledge');
        expect(kn.lastRun).toMatchObject({ at: 9_100, ok: false, durationMs: 100, source: 'run-map', trigger: 'manual' });
        // Modules with no stamp at all read as "never", not as an error.
        const ws = snap.modules.find(m => m.id === 'world_state');
        expect(ws.lastRun).toBeNull();
    });

    test('a throwing accessor degrades its own cells and is reported, never the tab', () => {
        const snap = collectHealthSnapshot(deps({
            modules: fakeModules({
                world_state: { getTotalTokens: () => { throw new Error('boom'); } },
                chronicle: { isGeneratingSnapshot: () => { throw new Error('nope'); } },
            }),
            allowed: () => { throw new Error('gate down'); },
        }));
        const byId = Object.fromEntries(snap.modules.map(m => [m.id, m]));
        expect(byId.world_state.tokens).toBe(0);
        expect(byId.world_state.errors.some(e => e.includes('tokens'))).toBe(true);
        expect(byId.chronicle.busy).toBe(false);
        expect(byId.chronicle.errors.some(e => e.includes('busy'))).toBe(true);
        // The gate guard fails CLOSED — an unreadable gate must never claim open.
        expect(byId.world_state.injectionAllowed).toBe(false);
        // …and the snapshot still has all five rows.
        expect(snap.modules).toHaveLength(5);
    });

    test('an absent module namespace yields a zeroed row, not a crash', () => {
        const snap = collectHealthSnapshot(deps({ modules: {} }));
        expect(snap.modules).toHaveLength(5);
        for (const row of snap.modules) {
            expect(row.busy).toBe(false);
            expect(row.tokens).toBe(0);
            expect(row.auto).toBeNull();
        }
    });
});

// ─── normaliseAutoStatus / resolveLastRun (unit) ─────────────────────────────

describe('normaliseAutoStatus', () => {
    test('null / non-object statuses mean auto-run is off', () => {
        expect(normaliseAutoStatus(null)).toBeNull();
        expect(normaliseAutoStatus(undefined)).toBeNull();
        expect(normaliseAutoStatus('nope')).toBeNull();
    });

    test('missing or non-numeric counters default to 0 rather than NaN', () => {
        expect(normaliseAutoStatus({ interval: 5 })).toEqual({ counter: 0, interval: 5, remaining: 5 });
        expect(normaliseAutoStatus({})).toEqual({ counter: 0, interval: 0, remaining: 0 });
    });
});

describe('resolveLastRun', () => {
    const refs = (call, run) => ({ lastApiCall: () => call, lastRun: () => run });

    test('null when neither the API pointer nor the run map has a stamp', () => {
        expect(resolveLastRun('world_state', refs(undefined, undefined))).toBeNull();
    });

    test('API-call source carries time, ok, duration, and telemetry context', () => {
        const run = resolveLastRun('chronicle', refs(
            { at: 500, ok: true, durationMs: 900, model: 'profile-1', status: 200, retries: 0 },
            undefined,
        ));
        expect(run).toMatchObject({ at: 500, ok: true, durationMs: 900, source: 'api-call', model: 'profile-1', status: 200 });
    });

    test('a run-map stamp newer than the API call wins and derives its duration', () => {
        const run = resolveLastRun('interiority', refs(
            { at: 500, ok: true, durationMs: 400 },
            { startedAt: 800, finishedAt: 1010, ok: true, trigger: 'auto' },
        ));
        expect(run).toMatchObject({ at: 1010, durationMs: 210, source: 'run-map', trigger: 'auto' });
    });

    test('an unfinished run-map entry still resolves (startedAt, no duration)', () => {
        const run = resolveLastRun('world_state', refs(undefined, { startedAt: 700, finishedAt: null, ok: null, trigger: 'manual' }));
        expect(run).toMatchObject({ at: 700, ok: false, durationMs: null, source: 'run-map', trigger: 'manual' });
    });
});


// ─── renderHealthSnapshot / formatHealthDuration ─────────────────────────────

describe('formatHealthDuration', () => {
    test.each([
        [830, '830ms'],
        [0, '0ms'],
        [999, '999ms'],
        [1_200, '1.2s'],
        [64_000, '1m 04s'],
        [null, ''],
        [undefined, ''],
        [NaN, ''],
        [-5, ''],
    ])('%p → %p', (ms, expected) => {
        expect(formatHealthDuration(ms)).toBe(expected);
    });
});

describe('renderHealthSnapshot', () => {
    const T = () => '12:41:03';

    test('renders the header stat strip (version + injected token load)', () => {
        const html = renderHealthSnapshot(collectHealthSnapshot(deps()), { formatTime: T });
        expect(html).toContain('MWT v9.9.9-test');
        expect(html).toContain('injecting: <strong>0</strong> tokens');
        expect(html).toContain('12:41:03');
        // Nothing stored, nothing to explain.
        expect(html).not.toContain('stored in lorebook');
    });

    test('a stored count is labelled in its cell and kept out of the injected total', () => {
        const snap = collectHealthSnapshot(deps({
            modules: fakeModules({
                world_state: { getTotalTokens: () => 2_200 },
                knowledge: { getTotalTokens: () => 36_000 },
            }),
        }));
        const html = renderHealthSnapshot(snap, { formatTime: T });
        expect(html).toContain('injecting: <strong>2,200</strong> tokens');
        expect(html).toContain('36,000');
        expect(html).toContain('mwt-diag-tokens-stored');
        expect(html).toContain('stored in lorebook (not injected)');
        // The alarming reading — one 38,200 figure presented as prompt load.
        expect(html).not.toContain('38,200');
        expect(html).not.toContain('38200');
    });

    test('the stored explanation names the mechanism, not just the word', () => {
        const snap = collectHealthSnapshot(deps({ modules: fakeModules({ knowledge: { getTotalTokens: () => 36_000 } }) }));
        const html = renderHealthSnapshot(snap, { formatTime: T });
        expect(html).toMatch(/never injected as a block/i);
        expect(html).toMatch(/keywords match recent chat/i);
    });

    test('renders the panic banner ONLY when the panic switch is on', () => {
        const off = renderHealthSnapshot(collectHealthSnapshot(deps()), { formatTime: T });
        expect(off).not.toContain('mwt-diag-panic');
        const on = renderHealthSnapshot(collectHealthSnapshot(deps({ settings: { injectionMasterOff: true } })), { formatTime: T });
        expect(on).toContain('mwt-diag-panic');
        expect(on).toContain('PANIC SWITCH ON');
    });

    test('renders one row per module with data-module ids', () => {
        const html = renderHealthSnapshot(collectHealthSnapshot(deps()), { formatTime: T });
        for (const spec of HEALTH_MODULE_SPECS) {
            expect(html).toContain(`data-module="${spec.id}"`);
        }
    });

    test('badges and row classes reflect enabled / gate / busy', () => {
        const snap = collectHealthSnapshot(deps({
            settings: { enableChronicle: false },
            allowed: (key) => key !== 'Knowledge',
            modules: fakeModules({ interiority: { isGenerating: () => true } }),
        }));
        const html = renderHealthSnapshot(snap, { formatTime: T });
        expect(html).toContain('mwt-diag-health-row--off');
        expect(html).toContain('mwt-diag-health-row--gated');
        expect(html).toContain('mwt-diag-health-row--busy');
        expect(html).toContain('>blocked<');
        expect(html).toContain('>idle<');
        expect(html).toContain('>busy<');
    });

    test('auto cells: off, countdown, due-now, and Interiority\'s per-turn wording', () => {
        const snap = collectHealthSnapshot(deps({
            modules: fakeModules({
                world_state: { getAutoRefreshStatus: () => ({ counter: 4, interval: 5 }) },
                chronicle: { getAutoSnapshotStatus: () => ({ counter: 40, threshold: 40 }) },
                knowledge: { getAutoScanStatus: () => null },
                interiority: { getAutoStatus: () => ({ perTurn: true, counter: 0, interval: 10, dormantCount: 0, pollDue: false }) },
            }),
        }));
        const html = renderHealthSnapshot(snap, { formatTime: T });
        expect(html).toContain('in 1 msg<');
        expect(html).toContain('due now');
        expect(html).toContain('>off<');
        expect(html).toContain('every turn');
    });
});

describe('renderHealthSnapshot — last-run cells', () => {
    const T = () => '12:41:03';

    test('never, ok with duration, FAILED with retry marker', () => {
        const snap = collectHealthSnapshot(deps({
            diagnostics: {
                lastApiCall: (id) => (id === 'chronicle')
                    ? { at: 500, ok: false, durationMs: 2_500, model: 'm-x', status: 503, retries: 2 }
                    : (id === 'knowledge'
                        ? { at: 400, ok: true, durationMs: 800, model: 'm-y', status: 200, retries: 0 }
                        : undefined),
                lastRun: () => undefined,
            },
        }));
        const html = renderHealthSnapshot(snap, { formatTime: T });
        expect(html).toContain('>never<');
        expect(html).toContain('>FAILED<');
        expect(html).toContain('2.5s');
        expect(html).toContain('+2 retry');
        expect(html).toContain('>ok<');
        expect(html).toContain('800ms');
    });

    test('escapes model/profile text interpolated into the hover title', () => {
        const snap = collectHealthSnapshot(deps({
            diagnostics: {
                lastApiCall: () => ({ at: 1, ok: true, durationMs: 1, model: '<script>alert(1)</script>', status: 200, retries: 0 }),
                lastRun: () => undefined,
            },
        }));
        const html = renderHealthSnapshot(snap, { formatTime: T });
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;');
    });
});

// ─── Module-key stamping (Phase 6 wiring) ────────────────────────────────────

describe('module settings carry their diagnostics module key', () => {
    test.each([
        ['world_state', getWsSettings],
        ['chronicle', getChronicleSettings],
        ['knowledge', getKnowledgeSettings],
        ['story_planner', getSpSettings],
        ['interiority', getIntSettings],
    ])('%s settings default module: %s', (key, getSettings) => {
        expect(getSettings().module).toBe(key);
    });

    test('API telemetry keyed through a module\'s real settings object lands under that module', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'HTTP 200',
            text: async () => '{}',
            json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        }));

        // resolveApiCall() passes the module's settings through to fetchFn —
        // the same object shape every module's run flow hands over.
        const moduleSettings = { ...getWsSettings(), apiUrl: 'https://example.test/v1', modelName: 'test-model' };
        await fetchFromApi({ systemPrompt: 's', userContent: 'u', settings: moduleSettings, retries: 0 });

        const call = getLastApiCall('world_state');
        expect(call).toMatchObject({ module: 'world_state', model: 'test-model', ok: true });
        expect(getLastApiCall('api')).toBeUndefined();
    });
});

// ─── Default-wiring smoke test ───────────────────────────────────────────────

describe('renderHealthPane (default wiring)', () => {
    test('collects and renders against the real module graph without throwing', () => {
        const html = renderHealthPane();
        // Not asserting live values (state depends on stubbed context) — only
        // that the default wiring resolves end-to-end and renders the table.
        expect(html).toContain('mwt-diag-health-table');
        for (const spec of HEALTH_MODULE_SPECS) {
            expect(html).toContain(`data-module="${spec.id}"`);
        }
        // The real version constant flows through (direct core/version.js
        // import — the §II.3 alias trap).
        expect(html).toMatch(/MWT v\d+\.\d+\.\d+/);
    });
});

