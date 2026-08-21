/**
 * test/last_request_tab.test.js — Diagnostics Phase 10 (Tab 5: Last request).
 *
 * Covers the layers of the Last request tab, mirroring the Phase 6–9 suites:
 *   1. diagnostics_panel/last_request.js — normaliseApiCall() shape rules;
 *      collectLastRequestSnapshot() with injected now/apiCalls/version deps
 *      (empty store, ordering + `last`, window stats, the failed-last
 *      warning, malformed-entry tolerance, per-field degradation);
 *      redactLastRequestSnapshot() (string scrub + no mutation);
 *      formatRequestAge() buckets.
 *   2. diagnostics_panel/render.js — renderLastRequestSnapshot() /
 *      renderLastRequestPane() string builders (stat header, the
 *      most-recent-call detail card, the history table newest first, the
 *      failure banner, the empty state, escaping) plus the pane switch that
 *      mounts the sub-tab and moves the placeholder line to Phase 11.
 *
 * The final smoke test exercises the DEFAULT wiring (real module graph under
 * the barrel→stub alias) — it exists to catch import-graph breakage, not to
 * assert live values.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    collectLastRequestSnapshot,
    normaliseApiCall,
    redactLastRequestSnapshot,
    formatRequestAge,
} from '../diagnostics_panel/last_request.js';
import {
    renderLastRequestPane,
    renderLastRequestSnapshot,
    renderDiagnosticsPanel,
} from '../diagnostics_panel/render.js';
import { recordApiCall, _resetDiagnostics } from '../core/diagnostics.js';
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
const NOW = 1_000_000;

/** One captured call in the exact captureApiCall() shape. */
const call = (over = {}) => ({
    module: 'world_state',
    mode: 'custom',
    model: 'gpt-test-1',
    durationMs: 830,
    retries: 0,
    status: 200,
    finish_reason: 'stop',
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    ok: true,
    at: NOW - 60_000,
    ...over,
});

/** Default deps: everything injected, nothing live. */
const deps = (over = {}) => ({
    now: () => NOW,
    version: '9.9.9-test',
    capacity: 20,
    ...over,
});

// ─── normaliseApiCall — one captured call, defensively reshaped ───────────────

describe('normaliseApiCall', () => {
    test('keeps the captured shape and decorates ageSec from the clock', () => {
        const c = normaliseApiCall(call(), NOW);
        expect(c).toEqual({
            module: 'world_state',
            mode: 'custom',
            model: 'gpt-test-1',
            durationMs: 830,
            retries: 0,
            status: 200,
            finish_reason: 'stop',
            usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
            errorClass: null,
            ok: true,
            at: NOW - 60_000,
            ageSec: 60,
        });
    });

    test('non-objects are dropped (null), never rendered as a row', () => {
        expect(normaliseApiCall(null, NOW)).toBeNull();
        expect(normaliseApiCall('nope', NOW)).toBeNull();
    });

    test('malformed values degrade their own fields, not the entry', () => {
        const c = normaliseApiCall({
            module: 123, mode: 7, model: 'm', durationMs: 'slow', retries: -3,
            status: 'x', finish_reason: '', usage: { prompt_tokens: 'n/a' },
            errorClass: '_noRetry', ok: 1, at: 'when?',
        }, NOW);
        expect(c.module).toBe('api');            // non-string module → the capture default
        expect(c.mode).toBeNull();
        expect(c.durationMs).toBeNull();         // unusable duration
        expect(c.retries).toBe(0);               // negative retries clamp to 0
        expect(c.status).toBeNull();
        expect(c.finish_reason).toBeNull();      // empty string → null
        expect(c.usage).toBeNull();              // no finite member → no usage
        expect(c.errorClass).toBe('_noRetry');
        expect(c.ok).toBe(false);                // strictly boolean
        expect(c.at).toBeNull();
        expect(c.ageSec).toBeNull();
    });
});

// ─── collectLastRequestSnapshot — the collector ───────────────────────────────

describe('collectLastRequestSnapshot', () => {
    test('empty store: zeroed snapshot, no warnings, bannerLevel ok', () => {
        const snap = collectLastRequestSnapshot(deps({ apiCalls: () => [] }));
        expect(snap.count).toBe(0);
        expect(snap.last).toBeNull();
        expect(snap.history).toEqual([]);
        expect(snap.capacity).toBe(20);
        expect(snap.mwtVersion).toBe('9.9.9-test');
        expect(snap.warnings).toEqual([]);
        expect(snap.bannerLevel).toBe('ok');
        expect(snap.stats).toEqual({
            ok: 0, failed: 0, retries: 0,
            promptTokens: 0, completionTokens: 0, totalTokens: 0,
            avgDurationMs: null, maxDurationMs: null,
        });
    });

    test('history is newest-first regardless of feed order, and `last` is the newest', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => [call({ at: NOW - 300_000 }), call({ at: NOW - 10_000 })],
        }));
        expect(snap.history.map((c) => c.at)).toEqual([NOW - 10_000, NOW - 300_000]);
        expect(snap.last.at).toBe(NOW - 10_000);
        expect(snap.last.ageSec).toBe(10);
    });

    test('window stats: ok/failed, retry sum, token sums, avg/max duration', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => [
                call({ durationMs: 1_000, retries: 1, usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }),
                call({ at: NOW - 5_000, durationMs: 3_000, ok: false, errorClass: '_noRetry', retries: 2, status: 401, usage: null }),
            ],
        }));
        expect(snap.stats.ok).toBe(1);
        expect(snap.stats.failed).toBe(1);
        expect(snap.stats.retries).toBe(3);
        expect(snap.stats.promptTokens).toBe(100);
        expect(snap.stats.completionTokens).toBe(40);
        expect(snap.stats.totalTokens).toBe(140); // the failed call reported no usage
        expect(snap.stats.avgDurationMs).toBe(2_000);
        expect(snap.stats.maxDurationMs).toBe(3_000);
    });

    test('the most recent FAILED call warns; a healthy last call does not', () => {
        const failed = collectLastRequestSnapshot(deps({
            apiCalls: () => [call({ ok: false, errorClass: '_isLengthError', status: 400 })],
        }));
        const w = failed.warnings.find((x) => x.id === 'last-call-failed');
        expect(w).toBeDefined();
        expect(w.level).toBe('warn');
        expect(w.text).toContain('world_state');
        expect(w.text).toContain('HTTP 400');
        expect(w.text).toContain('_isLengthError');
        expect(failed.bannerLevel).toBe('warn');

        const ok = collectLastRequestSnapshot(deps({ apiCalls: () => [call()] }));
        expect(ok.warnings).toEqual([]);
        expect(ok.bannerLevel).toBe('ok');
    });

    test('an OLDER failure with a healthy last call does not warn (readings, not verdicts)', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => [call({ at: NOW - 30_000 }), call({ at: NOW - 300_000, ok: false })],
        }));
        expect(snap.warnings).toEqual([]);
        expect(snap.stats.failed).toBe(1);
    });

    test('a throwing apiCalls accessor degrades to an empty snapshot + errors note', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => { throw new Error('store boom'); },
        }));
        expect(snap.count).toBe(0);
        expect(snap.history).toEqual([]);
        expect(snap.errors).toEqual(['apiCalls: store boom']);
    });

    test('malformed entries are skipped; usable ones survive in place', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => [null, 'junk', call({ at: NOW - 10_000 }), undefined],
        }));
        expect(snap.count).toBe(1);
        expect(snap.history[0].model).toBe('gpt-test-1');
    });

    test('capacity passes through for the header line (context for `count`)', () => {
        const snap = collectLastRequestSnapshot(deps({ apiCalls: () => [], capacity: 20 }));
        expect(snap.capacity).toBe(20);
    });
});

// ─── redactLastRequestSnapshot + formatRequestAge ─────────────────────────────

describe('redactLastRequestSnapshot — what lastRequest() returns', () => {
    // A model/profile string quoting an authenticated URL and a key-shaped
    // secret — the shapes Rule 1b exists to catch inside free text (telemetry
    // never carries the fields themselves, but ids are free text).
    const SECRET_MODEL = 'proxy→https://user:hunter2@proxy.example.com/v1/sk-live-abcdef123456 key sk-live-abcdef123456';

    const secretSnapshot = () => collectLastRequestSnapshot(deps({
        apiCalls: () => [call({ model: SECRET_MODEL, ok: false, errorClass: '_noRetry' })],
    }));

    test('DEFAULT: every string is secret-scrubbed; numbers survive untouched', () => {
        const out = redactLastRequestSnapshot(secretSnapshot());
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain('sk-live-abcdef123456');
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain('user:');
        expect(serialized).toContain('[REDACTED]');
        // The telemetry IS the diagnostics — numbers and flags survive.
        expect(out.count).toBe(1);
        expect(out.last.durationMs).toBe(830);
        expect(out.last.status).toBe(200);
        expect(out.last.usage.total_tokens).toBe(140);
        expect(out.warnings[0].id).toBe('last-call-failed');
    });

    test('knownSecrets: a no-shape live secret value is struck (exact match)', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => [call({ model: 'model at my-live-key-XYZ endpoint' })],
        }));
        const out = redactLastRequestSnapshot(snap, { knownSecrets: ['my-live-key-XYZ'] });
        expect(out.last.model).not.toContain('my-live-key-XYZ');
        expect(out.last.model).toContain('[REDACTED]');
    });

    test('the input snapshot is never mutated (the raw telemetry stays in the store)', () => {
        const snap = secretSnapshot();
        redactLastRequestSnapshot(snap);
        expect(snap.last.model).toBe(SECRET_MODEL);
    });
});

describe('formatRequestAge', () => {
    test.each([
        [null, '—'],
        [5, 'just now'],
        [45, '45s ago'],
        [125, '2m ago'],
        [7_500, '2h 05m ago'],
        [100_800, '1d 4h ago'],
    ])('%s → %s', (sec, expected) => {
        expect(formatRequestAge(sec)).toBe(expected);
    });
});

// ─── renderLastRequestSnapshot — the pane markup ──────────────────────────────

const T = () => '12:00:00';

describe('renderLastRequestSnapshot — header, card, history', () => {
    test('stat header + detail card + history table render', () => {
        const snap = collectLastRequestSnapshot(deps({ apiCalls: () => [call()] }));
        const html = renderLastRequestSnapshot(snap, { formatTime: T });
        expect(html).toContain('MWT v9.9.9-test');
        expect(html).toContain('read at 12:00:00');
        expect(html).toContain('1</strong> captured call(s)');
        expect(html).toContain('store keeps 20');
        expect(html).toContain('ok <strong>1</strong> · failed <strong>0</strong>');
        expect(html).toContain('mwt-diag-lr-detail');
        expect(html).toContain('Most recent call — 12:00:00 (1m ago)');
        expect(html).toContain('History — newest first');
    });

    test('the card carries every captured field, with the mode label explained inline', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => [call({ mode: 'cm', model: 'my-profile' })],
        }));
        const html = renderLastRequestSnapshot(snap, { formatTime: T });
        expect(html).toContain('cm — cm (SillyTavern connection profile)');
        expect(html).toContain('<code>my-profile</code>');
        expect(html).toContain('HTTP status');
        expect(html).toContain('200');
        expect(html).toContain('830ms');
        expect(html).toContain('finish_reason');
        expect(html).toContain('stop');
        expect(html).toContain('<strong>140</strong>');
        expect(html).toContain('(in 100 · out 40)');
    });

    test('a failed last call: FAILED badge + error class + the warning banner', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => [call({ ok: false, status: 401, errorClass: '_noRetry', retries: 2 })],
        }));
        const html = renderLastRequestSnapshot(snap, { formatTime: T });
        expect(html).toContain('mwt-diag-badge--fail">FAILED');
        expect(html).toContain('error class: <code>_noRetry</code>');
        expect(html).toContain('mwt-diag-scope-warnings');
        expect(html).toContain('last-call-failed');
        expect(html).toContain('ok <strong>0</strong> · failed <strong>1</strong>');
        expect(html).toContain('2 retries');
        expect(html).toContain('+2'); // the history row's retry cell
    });

    test('history rows are newest first', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => [
                call({ at: NOW - 300_000, model: 'older-model' }),
                call({ at: NOW - 10_000, model: 'newer-model' }),
            ],
        }));
        const html = renderLastRequestSnapshot(snap, { formatTime: T });
        expect(html.indexOf('newer-model')).toBeLessThan(html.indexOf('older-model'));
    });

    test('hostile model text is escaped, never parsed as HTML', () => {
        const hostile = '<script>alert(1)</script> & "quotes"';
        const snap = collectLastRequestSnapshot(deps({ apiCalls: () => [call({ model: hostile })] }));
        const html = renderLastRequestSnapshot(snap, { formatTime: T });
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;');
    });

    test('empty store: the empty state, no card, no history section', () => {
        const html = renderLastRequestSnapshot(collectLastRequestSnapshot(deps()), { formatTime: T });
        expect(html).toContain('No API calls captured yet this session');
        expect(html).not.toContain('mwt-diag-lr-detail');
        expect(html).not.toContain('History — newest first');
        expect(html).toContain('0</strong> captured call(s)');
    });

    test('fields the backend did not report render as dim dashes, never as "null"/"undefined"', () => {
        const snap = collectLastRequestSnapshot(deps({
            apiCalls: () => [call({ finish_reason: null, usage: null, status: undefined })],
        }));
        const html = renderLastRequestSnapshot(snap, { formatTime: T });
        expect(html).not.toContain('>null<');
        expect(html).not.toContain('>undefined<');
        expect(html).toContain('mwt-diag-dim">—');
    });
});

// ─── Pane mounting + default-wiring smoke ─────────────────────────────────────

describe('renderLastRequestPane (default wiring)', () => {
    test('collects and renders against the real diagnostics store without throwing', () => {
        // Give the real store one call so the card path runs too.
        recordApiCall({ module: 'world_state', mode: 'custom', model: 'm-live', durationMs: 500, status: 200, ok: true });
        const html = renderLastRequestPane();
        expect(html).toContain('mwt-diag-lr');
        expect(html).toContain('Most recent call');
        // The real version constant flows through (direct core/version.js
        // import — the §II.3 alias trap).
        expect(html).toContain(`MWT v${MWT_VERSION}`);
    });

    test('renders redacted strings — a secret-shaped model value never reaches the pane', () => {
        // The Phase 10 review gap this pins: the pane used to render
        // collectLastRequestSnapshot() output raw, so a model/profile string
        // quoting a secret displayed in cleartext despite the tab's stated
        // redaction guarantee. The pane must render the SAME
        // redactLastRequestSnapshot() output the console bridge returns.
        recordApiCall({
            module: 'world_state', mode: 'custom',
            model: 'proxy→https://user:hunter2@proxy.example.com/v1/ sk-live-abcdef123456',
            durationMs: 500, status: 200, ok: true,
        });
        const html = renderLastRequestPane();
        expect(html).not.toContain('sk-live-abcdef123456');
        expect(html).not.toContain('hunter2');
        expect(html).toContain('[REDACTED]');
    });

    test('the panel shell mounts the Last request pane instead of its placeholder', () => {
        const html = renderDiagnosticsPanel();
        expect(html).toContain('data-diag-tab="last-request"');
        // The real pane rendered (not the Phase 10 placeholder card)…
        expect(html).toContain('mwt-diag-lr');
        expect(html).not.toContain('Phase 10 — not built yet');
        // …while later tabs still show their placeholders (Phase 11 landed
        // 2026-08-21 — its suite owns the log-pane assertion now).
        expect(html).toContain('Phase 12 — not built yet');
    });
});
