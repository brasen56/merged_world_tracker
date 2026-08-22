/**
 * test/log_tab.test.js — Diagnostics Phase 11 (Tab 6: Log).
 *
 * Covers the layers of the Log tab, mirroring the Phase 6–10 suites:
 *   1. diagnostics_panel/log.js — normaliseLogEvent() shape rules;
 *      collectLogSnapshot() with injected now/events/version deps (empty
 *      ring, ordering, whole-ring level/module counts, the data-side
 *      level/module filters, the error-events-present warning, malformed
 *      tolerance, per-field degradation); redactLogSnapshot() (content/error
 *      gating + Rule 1b scrub + no mutation, both content modes);
 *      scrubLogDetailForDisplay() (the opt-in reveal path — prose survives,
 *      secrets never do); formatLogAge() buckets; logEventKey() stability.
 *   2. diagnostics_panel/render.js — renderLogSnapshot() /
 *      renderLogPane() string builders (stat header, filter chips with
 *      counts, module select, the table newest first, gated detail markup,
 *      the warning banner, the empty state, escaping) plus the pane switch
 *      that mounts the sub-tab; and the two wiring helpers behind
 *      wireDiagnosticsPanel()'s Log glue —
 *      applyLogViewFilters() (the P1: value-less checkboxes read as "on"
 *      and blanked the table) and revealLogDetails() (the P2s: evicted rows
 *      keep their safe summary; seq disambiguates same-millisecond repeats).
 *
 * The final smoke test exercises the DEFAULT wiring (real module graph under
 * the barrel→stub alias) — it exists to catch import-graph breakage, not to
 * assert live values.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    collectLogSnapshot,
    normaliseLogEvent,
    redactLogSnapshot,
    scrubLogDetailForDisplay,
    formatLogAge,
    logEventKey,
    logLevelCount,
} from '../diagnostics_panel/log.js';
import {
    renderLogPane,
    renderLogSnapshot,
    renderDiagnosticsPanel,
    applyLogViewFilters,
    revealLogDetails,
} from '../diagnostics_panel/render.js';
import { record, getEvents, _resetDiagnostics } from '../core/diagnostics.js';
import { MWT_VERSION } from '../core/version.js';
import { resetCoreStubs } from './stubs/core.js';

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Deterministic snapshot clock. */
const NOW = 2_000_000;

/** One ring event in the exact record() shape. */
const event = (over = {}) => ({
    seq: 41,
    ts: NOW - 60_000,
    epoch: 3,
    level: 'info',
    module: 'api',
    event: 'api_call',
    detail: { chars: 12 },
    scopeKey: 'chat:abc',
    ...over,
});

/** Default deps: everything injected, nothing live. */
const deps = (over = {}) => ({
    now: () => NOW,
    version: '9.9.9-test',
    capacity: 200,
    ...over,
});

/** Deterministic time formatter for render tests. */
const T = () => '12:00:00';

// ─── normaliseLogEvent — one ring event, defensively reshaped ─────────────────

describe('normaliseLogEvent', () => {
    test('keeps the recorded shape and decorates ageSec from the clock', () => {
        const e = normaliseLogEvent(event(), NOW);
        expect(e).toEqual({
            seq: 41,
            ts: NOW - 60_000,
            epoch: 3,
            level: 'info',
            module: 'api',
            event: 'api_call',
            detail: { chars: 12 },
            scopeKey: 'chat:abc',
            ageSec: 60,
        });
    });

    test('non-objects are dropped (null)', () => {
        expect(normaliseLogEvent(null, NOW)).toBeNull();
        expect(normaliseLogEvent('nope', NOW)).toBeNull();
        expect(normaliseLogEvent(42, NOW)).toBeNull();
    });

    test('a non-canonical level degrades to info (the store default), never breaks the row', () => {
        expect(normaliseLogEvent(event({ level: 'verbose' }), NOW).level).toBe('info');
        expect(normaliseLogEvent(event({ level: 7 }), NOW).level).toBe('info');
    });

    test('missing module/event get placeholders; bad ts and seq degrade to null with no age', () => {
        const e = normaliseLogEvent(event({ seq: 'first', module: null, event: null, ts: 'yesterday' }), NOW);
        expect(e.seq).toBeNull();
        expect(e.module).toBe('(no module)');
        expect(e.event).toBe('(unnamed)');
        expect(e.ts).toBeNull();
        expect(e.ageSec).toBeNull();
    });

    test('detail passes through untouched — gating is the redaction layer’s job, not the normaliser’s', () => {
        const detail = { message: 'Mara confesses her plan', nested: { error: 'boom' } };
        expect(normaliseLogEvent(event({ detail }), NOW).detail).toBe(detail);
    });
});

// ─── logEventKey — the reveal fingerprint ─────────────────────────────────────

describe('logEventKey', () => {
    test('is stable for the same event and distinguishes different ones', () => {
        const e = event();
        expect(logEventKey(e)).toBe(logEventKey({ ...e }));
        expect(logEventKey(e)).not.toBe(logEventKey(event({ event: 'other' })));
        expect(logEventKey(e)).not.toBe(logEventKey(event({ ts: 1 })));
        expect(logEventKey(e)).not.toBe(logEventKey(event({ seq: 42 })));
    });

    test('seq disambiguates same-millisecond repeats (every other field shared)', () => {
        // The worst case the store can produce: two record() calls in one
        // millisecond from the same module — identical ts/epoch/module/event.
        // Without seq in the key, the reveal Map collapses them onto one
        // detail and both rows display the wrong content (review P2 #3).
        const first = event({ seq: 7 });
        const second = event({ seq: 8 });
        expect(logEventKey(first)).not.toBe(logEventKey(second));
    });

    test('tolerates missing fields (never throws)', () => {
        expect(typeof logEventKey({})).toBe('string');
        expect(logEventKey(null)).toBe('||||'); // five empties, four separators
    });
});

// ─── logLevelCount — the redaction-safe count lookup ──────────────────────────

describe('logLevelCount', () => {
    test('reads pair entries and degrades to 0 for absent/malformed input', () => {
        const levels = [
            { level: 'debug', count: 1 },
            { level: 'info', count: 2 },
            { level: 'warn', count: 0 },
            { level: 'error', count: 3 },
        ];
        expect(logLevelCount(levels, 'error')).toBe(3);
        expect(logLevelCount(levels, 'warn')).toBe(0);
        expect(logLevelCount(levels, 'nonesuch')).toBe(0);
        expect(logLevelCount(null, 'error')).toBe(0);
        expect(logLevelCount(undefined, 'error')).toBe(0);
    });

    test('counts survive redactLogSnapshot() — a count may never look like an error body (ERROR_KEYS)', () => {
        const snap = collectLogSnapshot(deps({ events: () => [event({ level: 'error' }), event()] }));
        const out = redactLogSnapshot(snap, { knownSecrets: [] });
        expect(logLevelCount(out.levels, 'error')).toBe(1);
        expect(logLevelCount(out.levels, 'info')).toBe(1);
    });
});

// ─── collectLogSnapshot — the guarded collector ───────────────────────────────

describe('collectLogSnapshot', () => {
    test('empty ring: zero counts, no warning, no modules', () => {
        const snap = collectLogSnapshot(deps());
        expect(snap.count).toBe(0);
        expect(snap.total).toBe(0);
        expect(snap.levels).toEqual([
            { level: 'debug', count: 0 },
            { level: 'info', count: 0 },
            { level: 'warn', count: 0 },
            { level: 'error', count: 0 },
        ]);
        expect(snap.modules).toEqual([]);
        expect(snap.events).toEqual([]);
        expect(snap.warnings).toEqual([]);
        expect(snap.bannerLevel).toBe('ok');
        expect(snap.errors).toBeUndefined();
    });

    test('events come back newest first even if the dependency feeds oldest first', () => {
        const snap = collectLogSnapshot(deps({
            events: () => [event({ ts: 100, event: 'old' }), event({ ts: 300, event: 'new' }), event({ ts: 200, event: 'mid' })],
        }));
        expect(snap.events.map((e) => e.event)).toEqual(['new', 'mid', 'old']);
        expect(snap.total).toBe(3);
    });

    test('level counts and module list describe the whole ring, noisiest module first', () => {
        const snap = collectLogSnapshot(deps({
            events: () => [
                event({ level: 'warn', module: 'knowledge' }),
                event({ level: 'error', module: 'api' }),
                event({ level: 'info', module: 'api' }),
                event({ level: 'debug', module: 'api' }),
            ],
        }));
        expect(snap.levels).toEqual([
            { level: 'debug', count: 1 },
            { level: 'info', count: 1 },
            { level: 'warn', count: 1 },
            { level: 'error', count: 1 },
        ]);
        expect(snap.modules).toEqual([
            { name: 'api', count: 3 },
            { name: 'knowledge', count: 1 },
        ]);
    });

    test('the data-side level filter narrows events but not the whole-ring counts', () => {
        const snap = collectLogSnapshot(deps({
            level: 'error',
            events: () => [event({ level: 'error' }), event({ level: 'info' })],
        }));
        expect(snap.count).toBe(1);
        expect(snap.total).toBe(2);
        expect(logLevelCount(snap.levels, 'info')).toBe(1);
        expect(logLevelCount(snap.levels, 'error')).toBe(1);
    });

    test('level accepts an array and composes with the module filter (the events() shapes)', () => {
        const snap = collectLogSnapshot(deps({
            level: ['warn', 'error'],
            module: 'api',
            events: () => [
                event({ level: 'warn', module: 'api' }),
                event({ level: 'warn', module: 'knowledge' }),
                event({ level: 'error', module: 'api' }),
                event({ level: 'info', module: 'api' }),
            ],
        }));
        expect(snap.count).toBe(2);
        expect(snap.events.every((e) => e.module === 'api' && e.level !== 'info')).toBe(true);
    });

    test('error-level events produce the error-events-present warning (warns alone do not)', () => {
        const quiet = collectLogSnapshot(deps({ events: () => [event({ level: 'warn' })] }));
        expect(quiet.warnings).toEqual([]);
        expect(quiet.bannerLevel).toBe('ok');

        const loud = collectLogSnapshot(deps({ events: () => [event({ level: 'error', module: 'notify' })] }));
        expect(loud.warnings).toHaveLength(1);
        expect(loud.warnings[0].id).toBe('error-events-present');
        expect(loud.bannerLevel).toBe('warn');
    });

    test('malformed entries degrade their own row, never the table', () => {
        const snap = collectLogSnapshot(deps({
            events: () => [null, 'junk', event({ module: null, event: null, ts: NaN }), event()],
        }));
        expect(snap.total).toBe(2);
        expect(snap.events[1].module).toBe('(no module)');
        expect(snap.events[1].event).toBe('(unnamed)');
    });

    test('a throwing accessor degrades to an empty snapshot plus an errors note, never throws', () => {
        const snap = collectLogSnapshot(deps({
            events: () => { throw new Error('ring gone'); },
        }));
        expect(snap.count).toBe(0);
        expect(snap.errors).toEqual([expect.stringContaining('ring gone')]);
    });

    test('integration: reads the REAL Phase 0 ring (record() → getEvents)', () => {
        record({ level: 'warn', module: 'knowledge', event: 'scope_fallback_global', detail: { scope: 'chat' } });
        record({ level: 'info', module: 'api', event: 'api_call', detail: { ok: true } });
        const snap = collectLogSnapshot({ now: () => Date.now() });
        expect(snap.total).toBeGreaterThanOrEqual(2);
        expect(snap.events[0].event).toBe('api_call'); // newest first
        expect(logLevelCount(snap.levels, 'warn')).toBeGreaterThanOrEqual(1);
    });
});

// ─── redactLogSnapshot — the safe-by-default serialization ────────────────────

describe('redactLogSnapshot', () => {
    // The motivating ring shapes: a captured toast (chat content in
    // detail.message) and a wi_script_unavailable warn (raw error body).
    const ring = () => [
        event({
            level: 'info',
            module: 'notify',
            event: 'Knowledge Tracker',
            detail: { title: 'Knowledge Tracker', message: 'Mara confesses her plan with sk-live-abcdef123456' },
        }),
        event({
            level: 'warn',
            module: 'knowledge',
            event: 'wi_script_unavailable',
            detail: { stage: 'import-failed', error: 'world-info.js threw X' },
        }),
    ];

    test('default: toast message bodies are gated to size markers, titles survive', () => {
        const out = redactLogSnapshot(collectLogSnapshot(deps({ events: ring })), { knownSecrets: [] });
        const toast = out.events.find((e) => e.module === 'notify');
        expect(toast.detail.message).toMatch(/^\[content excluded — \d+ chars\]$/);
        expect(toast.detail.title).toBe('Knowledge Tracker');
    });

    test('default: error bodies get their own marker, adjacent telemetry does not', () => {
        const out = redactLogSnapshot(collectLogSnapshot(deps({ events: ring })), { knownSecrets: [] });
        const warn = out.events.find((e) => e.event === 'wi_script_unavailable');
        expect(warn.detail.error).toMatch(/^\[error excluded — \d+ chars\]$/);
        expect(warn.detail.stage).toBe('import-failed');
    });

    test('includeContent: true keeps the (still scrubbed) message — opting into content never opts into secrets', () => {
        const out = redactLogSnapshot(collectLogSnapshot(deps({ events: ring })), { includeContent: true, knownSecrets: [] });
        const toast = out.events.find((e) => e.module === 'notify');
        expect(toast.detail.message).toContain('Mara confesses her plan');
        expect(toast.detail.message).not.toContain('sk-live-abcdef123456');
    });

    test('Rule 1b: a known secret value is struck out of free-text event/module strings in BOTH modes', () => {
        const secretive = () => [event({ event: `echoed my-live-key-XYZ twice: my-live-key-XYZ` })];
        for (const includeContent of [false, true]) {
            const out = redactLogSnapshot(collectLogSnapshot(deps({ events: secretive })), { includeContent, knownSecrets: ['my-live-key-XYZ'] });
            expect(out.events[0].event).not.toContain('my-live-key-XYZ');
        }
    });

    test('the input is never mutated and the output shares no references with it', () => {
        const snap = collectLogSnapshot(deps({ events: ring }));
        const frozen = JSON.stringify(snap);
        const out = redactLogSnapshot(snap, { knownSecrets: [] });
        expect(JSON.stringify(snap)).toBe(frozen);
        expect(out.events[0].detail).not.toBe(snap.events[0].detail);
    });
});

// ─── scrubLogDetailForDisplay — the opt-in reveal path ─────────────────────────

describe('scrubLogDetailForDisplay — opting into content never opts into secrets', () => {
    // A detail quoting an authenticated URL and a key-shaped secret — the
    // shapes the shared redaction layer exists for.
    const SECRET_DETAIL = {
        message: 'Mara calls https://user:hunter2@proxy.example.com/v1/ with sk-live-abcdef123456',
        chars: 42,
    };

    test('prose survives; key shapes and authenticated URLs do not', () => {
        const out = scrubLogDetailForDisplay(SECRET_DETAIL, { knownSecrets: [] });
        expect(out).toContain('Mara calls');
        expect(out).toContain('42');
        expect(out).not.toContain('hunter2');
        expect(out).not.toContain('sk-live-abcdef123456');
        expect(out).toContain('https://proxy.example.com');
    });

    test('a knownSecrets value with no recognizable shape is still struck (exact match)', () => {
        const out = scrubLogDetailForDisplay(
            { message: 'backend echoed my-live-key-XYZ twice: my-live-key-XYZ' },
            { knownSecrets: ['my-live-key-XYZ'] },
        );
        expect(out).not.toContain('my-live-key-XYZ');
    });

    test('null / undefined detail degrades to the empty string; objects serialize', () => {
        expect(scrubLogDetailForDisplay(null)).toBe('');
        expect(scrubLogDetailForDisplay(undefined)).toBe('');
        expect(scrubLogDetailForDisplay({ a: 1 }, { knownSecrets: [] })).toBe('{"a":1}');
    });

    test('an event detail carrying an `error` key keeps its (scrubbed) text here — this is the reveal path', () => {
        const out = scrubLogDetailForDisplay({ stage: 'import-failed', error: 'proxy https://k:sekret@x.example/y said no' }, { knownSecrets: [] });
        expect(out).toContain('import-failed');
        expect(out).toContain('said no');
        expect(out).not.toContain('sekret');
    });
});

// ─── formatLogAge — the shared age buckets ────────────────────────────────────

describe('formatLogAge', () => {
    test.each([
        [null, '—'],
        [undefined, '—'],
        [-5, '—'],
        [5, 'just now'],
        [45, '45s ago'],
        [125, '2m ago'],
        [7_325, '2h 02m ago'],
        [100_800, '1d 4h ago'],
    ])('%p → %p', (sec, expected) => {
        expect(formatLogAge(sec)).toBe(expected);
    });
});

// ─── renderLogSnapshot — the string builder ───────────────────────────────────

describe('renderLogSnapshot', () => {
    // The renderer is fed REDACTED snapshots, exactly like renderLogPane and
    // the console bridge produce them (the Phase 10 review rule: the pane
    // must not be the one surface without redaction).
    const render = (events, over = {}) =>
        renderLogSnapshot(redactLogSnapshot(collectLogSnapshot(deps({ events, ...over })), { knownSecrets: [] }), { formatTime: T });

    test('stat header: version, total vs ring capacity, error/warn counts, read-at', () => {
        const html = render(() => [
            event({ level: 'error' }),
            event({ level: 'warn' }),
            event(),
        ]);
        expect(html).toContain('MWT v9.9.9-test');
        expect(html).toContain('<strong>3</strong> event(s)');
        expect(html).toContain('ring keeps 200');
        expect(html).toContain('error <strong>1</strong> · warn <strong>1</strong>');
        expect(html).toContain('read at 12:00:00');
    });

    test('one chip per level with the whole-ring count, all checked by default', () => {
        const html = render(() => [event({ level: 'warn' }), event(), event()]);
        for (const lvl of ['debug', 'info', 'warn', 'error']) {
            expect(html).toContain(`data-diag-log-filter-level="${lvl}"`);
        }
        expect(html).toContain('<input type="checkbox" checked value="info" data-diag-log-filter-level="info">');
        // info count is 2 (two unmodified fixtures)
        expect(html).toContain('<span class="mwt-diag-log-chip-count">2</span>');
    });

    test('P1 pin: every chip carries its level as BOTH the value attribute and the data attribute', () => {
        // A checkbox with no value attribute reads as the string "on" in the
        // DOM, so a filter reading .value built Set('on') and no row level
        // ever matched — toggling any chip blanked the table. The markup must
        // keep value="<level>"; applyLogViewFilters() reads the dataset first
        // regardless.
        const html = render(() => [event()]);
        for (const lvl of ['debug', 'info', 'warn', 'error']) {
            expect(html).toContain(`value="${lvl}" data-diag-log-filter-level="${lvl}"`);
        }
    });

    test('the module select lists each module (noisiest first) plus the all-option', () => {
        const html = render(() => [
            event({ module: 'knowledge' }),
            event({ module: 'api' }),
            event({ module: 'api' }),
        ]);
        expect(html).toContain('<option value="all">all modules (3)</option>');
        expect(html.indexOf('value="api"')).toBeLessThan(html.indexOf('value="knowledge"'));
    });

    test('the table is newest first and stamps each row with its filter attributes and fingerprint key', () => {
        const html = render(() => [
            event({ ts: 100, event: 'old' }),
            event({ ts: 300, event: 'new' }),
        ]);
        expect(html).toContain('>new<');
        expect(html).toContain('data-diag-log-key');
        const rows = html.split('data-diag-log-row');
        expect(rows.length).toBe(3); // two rows + head/foot split
        expect(rows[1]).toContain('data-diag-log-level="info"');
        expect(rows[1]).toContain('data-diag-log-module="api"');
    });

    test('detail summaries are the safe markers: a toast body never renders in cleartext', () => {
        const html = render(() => [
            event({ module: 'notify', event: 'Knowledge Tracker', detail: { title: 'Knowledge Tracker', message: 'Mara confesses her plan' } }),
        ]);
        expect(html).not.toContain('Mara confesses her plan');
        expect(html).toContain('[content excluded — ');
    });

    test('the gated reveal body ships HIDDEN and EMPTY, carrying only the fingerprint key', () => {
        const html = render(() => [event({ detail: { message: 'secret-ish body' } })]);
        expect(html).toContain('data-diag-log-gate="body"');
        expect(html).toContain('<code data-diag-log-gate="body" data-diag-log-key="');
        // The summary ships visible…
        expect(html).toContain('data-diag-log-gate="summary"');
        // …and events with no detail render a dash, no reveal element.
        const noDetail = render(() => [event({ detail: null })]);
        expect(noDetail).not.toContain('data-diag-log-gate="body"');
    });

    test('the Chat column stamps the epoch and carries the scopeKey on hover', () => {
        const html = render(() => [event({ epoch: 7, scopeKey: 'chat:deadbeef' })]);
        expect(html).toContain('title="chat:deadbeef"');
        expect(html).toContain('>#7</td>');
    });

    test('the error-events banner renders when error-level events exist', () => {
        const html = render(() => [event({ level: 'error', module: 'notify' })]);
        expect(html).toContain('mwt-diag-scope-warnings');
        expect(html).toContain('<code>error-events-present</code>');
        expect(html).toContain('mwt-diag-badge--fail">error</span>');
    });

    test('empty ring: the empty state, no filter row, no table', () => {
        const html = render(() => []);
        expect(html).toContain('No diagnostics events captured yet this session');
        expect(html).not.toContain('mwt-diag-log-filters');
        expect(html).not.toContain('mwt-diag-log-table');
        expect(html).toContain('<strong>0</strong> event(s)');
    });

    test('hostile module/event strings are escaped, never parsed as HTML', () => {
        const hostile = '<script>alert(1)</script> & "quotes"';
        const html = render(() => [event({ module: hostile, event: hostile })]);
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;');
    });

    test('the visible-of counter ships its all-visible initial state', () => {
        const html = render(() => [event(), event()]);
        expect(html).toContain('showing 2 of 2');
    });
});

// ─── Pane mounting + default-wiring smoke ─────────────────────────────────────

describe('renderLogPane (default wiring)', () => {
    test('collects and renders against the real diagnostics store without throwing', () => {
        record({ level: 'warn', module: 'api', event: 'json_repaired', detail: { chars: 10 } });
        const html = renderLogPane();
        expect(html).toContain('mwt-diag-log');
        expect(html).toContain('json_repaired');
        // The real version constant flows through (direct core/version.js
        // import — the §II.3 alias trap).
        expect(html).toContain(`MWT v${MWT_VERSION}`);
    });

    test('renders redacted output — a secret in a toast body never reaches the pane', () => {
        // The Phase 10 review gap, pinned for this tab too: the pane must
        // render redactLogSnapshot() output, so a message quoting a secret
        // displays as a marker / [REDACTED], never cleartext.
        record({
            level: 'error',
            module: 'notify',
            event: 'Fetch failed',
            detail: { title: 'Fetch failed', message: 'proxy https://user:hunter2@proxy.example.com/ said sk-live-abcdef123456 invalid' },
        });
        const html = renderLogPane();
        expect(html).not.toContain('hunter2');
        expect(html).not.toContain('sk-live-abcdef123456');
        expect(html).toContain('[content excluded — ');
    });

    test('the panel shell mounts the Log pane instead of its placeholder', () => {
        const html = renderDiagnosticsPanel();
        expect(html).toContain('data-diag-tab="log"');
        // The real pane rendered (not the Phase 11 placeholder card)…
        expect(html).toContain('mwt-diag-log');
        expect(html).not.toContain('Phase 11 — not built yet');
        // …and with Phase 12 (Integrity) landed 2026-08-21, every one of the
        // seven v1 tabs renders a real pane — no placeholder remains.
        expect(html).toContain('mwt-diag-int-run');
        expect(html).not.toContain('— not built yet');
    });
});

// ─── applyLogViewFilters — the P1 wiring, driven with element-like fakes ──────

describe('applyLogViewFilters (live wiring)', () => {
    /** A rendered row fake: dataset carries the row's level/module stamps. */
    const row = (level, module) => ({ dataset: { diagLogLevel: level, diagLogModule: module }, hidden: false });

    /** A chip input fake shaped like the real markup (value + data attr). */
    const chip = (lvl, checked) => ({ checked, value: lvl, dataset: { diagLogFilterLevel: lvl } });

    const ALL = () => [chip('debug', true), chip('info', true), chip('warn', true), chip('error', true)];

    test('P1 regression: unchecking one level hides only that level, never the table', () => {
        // Against the shipped bug (checkbox .value === 'on', filter set
        // {'on'}) every row vanished; the fix reads the dataset first.
        const rows = [row('info', 'api'), row('warn', 'api'), row('error', 'notify')];
        const chips = ALL().map((c) => (c.value === 'info' ? chip('info', false) : c));
        const counter = { textContent: '' };
        const visible = applyLogViewFilters(rows, chips, { value: 'all' }, counter);
        expect(visible).toBe(2);
        expect(rows.map((r) => r.hidden)).toEqual([true, false, false]);
        expect(counter.textContent).toBe('showing 2 of 3');
    });

    test('unchecking every level chip leaves zero rows (an explicit empty view)', () => {
        const rows = [row('info', 'api'), row('warn', 'api')];
        const counter = { textContent: '' };
        const visible = applyLogViewFilters(rows, ALL().map((c) => chip(c.value, false)), { value: 'all' }, counter);
        expect(visible).toBe(0);
        expect(rows.every((r) => r.hidden)).toBe(true);
        expect(counter.textContent).toBe('showing 0 of 2');
    });

    test('the module select narrows and composes with the level chips', () => {
        const rows = [row('info', 'api'), row('info', 'knowledge'), row('warn', 'api')];
        // info-only + module api → exactly the first row.
        const chips = [chip('info', true), chip('warn', false)];
        const visible = applyLogViewFilters(rows, chips, { value: 'api' }, null);
        expect(visible).toBe(1);
        expect(rows.map((r) => r.hidden)).toEqual([false, true, true]);
    });

    test('a chip with NO data attribute still filters via its value attribute (the fallback read)', () => {
        // Hand-written or degraded markup: dataset absent, .value correct.
        const rows = [row('warn', 'api'), row('info', 'api')];
        const chips = [{ checked: true, value: 'warn' }, { checked: false, value: 'info' }];
        applyLogViewFilters(rows, chips, { value: 'all' }, null);
        expect(rows.map((r) => r.hidden)).toEqual([false, true]);
    });

    test('unchecked chips are excluded even when their value is present (checked-ness is honoured)', () => {
        const rows = [row('info', 'api')];
        applyLogViewFilters(rows, [chip('info', false)], { value: 'all' }, null);
        expect(rows[0].hidden).toBe(true);
    });

    test('a missing module select degrades to "all"; a missing counter is tolerated', () => {
        const rows = [row('info', 'api')];
        const visible = applyLogViewFilters(rows, ALL(), null, null);
        expect(visible).toBe(1);
        expect(rows[0].hidden).toBe(false);
    });
});

// ─── revealLogDetails — the P2 wiring, driven with element-like fakes ─────────

describe('revealLogDetails (live wiring)', () => {
    /** A detail-cell fake: the hidden body <code> + its sibling summary span. */
    const cell = (key) => {
        const summary = { hidden: false };
        const body = {
            dataset: { diagLogKey: key },
            hidden: true,
            textContent: '',
            parentElement: {
                querySelector: (sel) => (sel === '[data-diag-log-gate="summary"]' ? summary : null),
            },
        };
        return { body, summary };
    };

    test('opt-in reveals the scrubbed LIVE detail and hides the safe summary', () => {
        record({ level: 'info', module: 'api', event: 'e1', detail: { message: 'Mara waits by the gate' } });
        const { body, summary } = cell(logEventKey(getEvents()[0]));
        revealLogDetails([body], true, { knownSecrets: () => [] });
        expect(body.hidden).toBe(false);
        expect(body.textContent).toContain('Mara waits');
        expect(summary.hidden).toBe(true);
    });

    test('un-tick clears the body and restores the summary (no content stays in the DOM)', () => {
        record({ level: 'info', module: 'api', event: 'e2', detail: { message: 'Mara waits' } });
        const { body, summary } = cell(logEventKey(getEvents()[0]));
        revealLogDetails([body], true, { knownSecrets: () => [] });
        revealLogDetails([body], false, { knownSecrets: () => [] });
        expect(body.hidden).toBe(true);
        expect(body.textContent).toBe('');
        expect(summary.hidden).toBe(false);
    });

    test('P2 regression: a key the live ring no longer holds keeps the summary, never an empty body', () => {
        // The event was evicted after the pane was built: detailByKey.has()
        // is false, so the row must fall back to its safe summary rather
        // than hiding it and showing a blank detail.
        const { body, summary } = cell('9999|1|ghost|evicted');
        revealLogDetails([body], true, { knownSecrets: () => [] });
        expect(body.hidden).toBe(true);
        expect(body.textContent).toBe('');
        expect(summary.hidden).toBe(false);
    });

    test('P2 regression: same-millisecond repeats each reveal their OWN detail (seq disambiguates)', () => {
        // Identical except seq — what record() produces for two calls in one
        // millisecond. The old ts|epoch|module|event key collapsed the Map to
        // one entry and both rows showed the same (wrong) content.
        const first = { seq: 1, ts: 500, epoch: 2, module: 'api', event: 'burst', detail: { message: 'first burst' } };
        const second = { seq: 2, ts: 500, epoch: 2, module: 'api', event: 'burst', detail: { message: 'second burst' } };
        const a = cell(logEventKey(first));
        const b = cell(logEventKey(second));
        expect(a.body.dataset.diagLogKey).not.toBe(b.body.dataset.diagLogKey);
        revealLogDetails([a.body, b.body], true, { events: () => [second, first], knownSecrets: () => [] });
        expect(a.body.textContent).toContain('first burst');
        expect(b.body.textContent).toContain('second burst');
        expect(a.body.textContent).not.toContain('second burst');
        expect(b.body.textContent).not.toContain('first burst');
    });

    test('the revealed text is scrubbed — a known secret never enters the DOM', () => {
        record({ level: 'warn', module: 'api', event: 'e3', detail: { message: 'echoed my-live-key-XYZ twice: my-live-key-XYZ' } });
        const { body } = cell(logEventKey(getEvents()[0]));
        revealLogDetails([body], true, { knownSecrets: () => ['my-live-key-XYZ'] });
        expect(body.textContent).not.toContain('my-live-key-XYZ');
    });

    test('an empty body list is a no-op (never throws)', () => {
        expect(() => revealLogDetails([], true)).not.toThrow();
        expect(() => revealLogDetails(null, true)).not.toThrow();
    });
});

