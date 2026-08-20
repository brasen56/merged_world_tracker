/**
 * diagnostics_panel/last_request.js — Tab 5: Last request (Diagnostics Phase 10).
 *
 * "What did MWT's last API call look like, and how have the recent ones been
 * going?" (phases doc §II.4 Phase 10, design §I.5 Tab 5): the Phase 1 capture
 * for the most recent call — one detail card: module · mode · model/profile ·
 * HTTP status · duration · retries · finish_reason · token usage · error class
 * — plus a short history table, newest first. All of it is TELEMETRY BY
 * CONSTRUCTION: `captureApiCall()` (core/api.js) records about a call, never
 * its prompt, API key, custom headers, or response body — so this tab has no
 * content to gate and needs no opt-in; what remains is scrubbing the strings
 * (model/profile ids are free text and could quote a secret) through the
 * shared redaction layer.
 *
 * DOM-free by design (the Phase 6 health.js pattern): the snapshot is a plain
 * object, the markup lives in diagnostics_panel/render.js, every dependency is
 * injectable, and every accessor call is individually guarded — a throwing
 * dependency degrades its own field plus an `errors` note, never the tab.
 *
 * Direct imports throughout for core singletons (NOT via core/index.js): the
 * barrel is aliased to test/stubs/core.js under Vitest, and this module must
 * read the real capture store + version regardless (the barrel→stub alias
 * trap, §II.3).
 */

import { MWT_VERSION } from '../core/version.js';
import { getApiCalls, API_CALL_CAPACITY } from '../core/diagnostics.js';
// The shared redaction layer — the ONE place secrets are scrubbed (Phase 5's
// hard gate: every diagnostics surface routes through it; no hand-rolled
// redaction anywhere else). redactSecretsDeep() is the includeContent:true
// shorthand, and its own docstring names THIS data shape as the sanctioned
// case: "telemetry by construction, no content fields to gate". The captured
// fields carry no CONTENT_KEYS/ERROR_KEYS members, so there is nothing for
// the opt-in to reveal — only Rule 1b string scrubbing applies (embedded
// URLs → scheme+host, key/bearer shapes, this install's known secret values).
import { redactSecretsDeep } from '../core/redaction.js';
// Live secret VALUES for the scrub list. report.js is a sibling collector
// (it does not import this module), so there is no cycle; the
// knownSecrets-??-collectKnownSecrets() "safe by default" pattern is lifted
// from buildReport() — collectKnownSecrets() is fully guarded and returns []
// with no SillyTavern runtime, keeping this unit-testable in Node.
import { collectKnownSecrets } from './report.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A finite number ≥ 0 — or null when the value is absent/unusable. */
function finiteNonNeg(v) {
    const n = Number(v);
    return (Number.isFinite(n) && n >= 0) ? n : null;
}

/**
 * Defensive shape check for one captured API call. The store only ever holds
 * what captureApiCall() (core/api.js) put there, but the collector still
 * normalises: a malformed entry (hand-written via MWT.diagnostics, a future
 * shape change) must degrade ITS OWN cells to null/em-dash, never break the
 * table. Age is decorated here so the pane and the console bridge can never
 * disagree about it.
 *
 * @param {object} raw — one getApiCalls() entry
 * @param {number} now — the snapshot's reference clock
 * @returns {object|null} the normalised call, or null when raw is not an object
 */
export function normaliseApiCall(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    const at = Number.isFinite(Number(raw.at)) ? Number(raw.at) : null;
    const rawUsage = raw.usage;
    const usage = (rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage))
        ? {
            prompt_tokens: finiteNonNeg(rawUsage.prompt_tokens),
            completion_tokens: finiteNonNeg(rawUsage.completion_tokens),
            total_tokens: finiteNonNeg(rawUsage.total_tokens),
        }
        : null;
    return {
        module: (typeof raw.module === 'string' && raw.module) ? raw.module : 'api',
        mode: (typeof raw.mode === 'string' && raw.mode) ? raw.mode : null,
        model: raw.model == null ? null : String(raw.model),
        durationMs: finiteNonNeg(raw.durationMs),
        retries: finiteNonNeg(raw.retries) ?? 0,
        status: raw.status == null ? null : (Number.isFinite(Number(raw.status)) ? Number(raw.status) : null),
        finish_reason: (typeof raw.finish_reason === 'string' && raw.finish_reason) ? raw.finish_reason : null,
        usage: usage && (usage.prompt_tokens != null || usage.completion_tokens != null || usage.total_tokens != null)
            ? usage
            : null,
        errorClass: (typeof raw.errorClass === 'string' && raw.errorClass) ? raw.errorClass : null,
        ok: raw.ok === true,
        at,
        ageSec: at != null ? Math.max(0, Math.round((now - at) / 1000)) : null,
    };
}

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect the Last request tab snapshot. Read-only by contract (design §I.1):
 * nothing here writes the diagnostics stores — it only READS the Phase 1
 * capture (getApiCalls(), newest first, capped at API_CALL_CAPACITY by the
 * store itself — that cap IS the "short history" the design asks for).
 *
 * Snapshot shape:
 *   {
 *     generatedAt, mwtVersion,
 *     capacity,            // the store's API_CALL_CAPACITY (context for `count`)
 *     count,               // retained calls
 *     last,                // the most recent call (normalised, ageSec), or null
 *     history,             // every retained call, newest first (normalised)
 *     stats: { ok, failed, retries, promptTokens, completionTokens, totalTokens,
 *              avgDurationMs, maxDurationMs },   // over the retained window
 *     warnings,            // e.g. last-call-failed (level warn)
 *     bannerLevel,         // 'ok' | 'warn' | 'fail'
 *     errors?,             // degradation notes when an accessor threw
 *   }
 *
 * @param {object} [deps]
 * @param {function(): number} [deps.now] — clock (defaults Date.now)
 * @param {string} [deps.version] — MWT_VERSION (defaults the real constant)
 * @param {function(): object[]} [deps.apiCalls] — getApiCalls (newest first)
 * @param {number} [deps.capacity] — API_CALL_CAPACITY
 * @returns {object} the snapshot
 */
export function collectLastRequestSnapshot({
    now = Date.now,
    version = MWT_VERSION,
    apiCalls = getApiCalls,
    capacity = API_CALL_CAPACITY,
} = {}) {
    const errors = [];

    /** Guarded accessor call — a throwing dependency degrades to `fallback`
     *  plus an `errors` note naming the field, never the whole tab. */
    const call = (field, fn, fallback) => {
        try {
            return fn();
        } catch (err) {
            errors.push(`${field}: ${err?.message || err}`);
            return fallback;
        }
    };

    const generatedAt = call('now', () => now(), Date.now());
    const rawCalls = call('apiCalls', () => apiCalls(), []);

    // Newest-first is the store's contract; a defensive re-sort costs nothing
    // and pins the history order even against a hand-fed dependency.
    const history = (Array.isArray(rawCalls) ? rawCalls : [])
        .map((c) => normaliseApiCall(c, generatedAt))
        .filter((c) => c !== null)
        .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));

    const last = history.length ? history[0] : null;

    // ── Window stats — the "how have the recent ones been going" answer,
    //    summed over exactly what the tab shows (the retained window).
    const okCount = history.filter((c) => c.ok).length;
    const durations = history.map((c) => c.durationMs).filter((d) => d != null);
    const sumTokens = (field) => history.reduce(
        (sum, c) => sum + (c.usage?.[field] ?? 0),
        0,
    );
    const stats = {
        ok: okCount,
        failed: history.length - okCount,
        retries: history.reduce((sum, c) => sum + (c.retries ?? 0), 0),
        promptTokens: sumTokens('prompt_tokens'),
        completionTokens: sumTokens('completion_tokens'),
        totalTokens: sumTokens('total_tokens'),
        avgDurationMs: durations.length
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
            : null,
        maxDurationMs: durations.length ? Math.max(...durations) : null,
    };

    // ── Warnings — ordered by how loudly they must be seen. Only one exists
    //    today: the most recent call failed (the tab's one at-a-glance red
    //    flag). Retry counts, 4xx/5xx status, and slow calls stay in the
    //    table — they are readings, not verdicts.
    const warnings = [];
    if (last && !last.ok) {
        const bits = [`module ${last.module}`];
        if (last.status != null) bits.push(`HTTP ${last.status}`);
        if (last.errorClass) bits.push(`error class ${last.errorClass}`);
        warnings.push({
            id: 'last-call-failed',
            level: 'warn',
            text: `The most recent captured API call FAILED (${bits.join(', ')}). Timings, retries, and token usage around it are still visible below; the capture is telemetry by construction, so no error TEXT was ever recorded — pair this with the ❤️ Health tab's last-run column or MWT.diagnostics.events({ module: 'api' }) for the surrounding ring.`,
        });
    }
    const bannerLevel = warnings.some((w) => w.level === 'fail') ? 'fail' : (warnings.length ? 'warn' : 'ok');

    return {
        generatedAt,
        mwtVersion: String(version ?? MWT_VERSION),
        capacity: Number(capacity) || API_CALL_CAPACITY,
        count: history.length,
        last,
        history,
        stats,
        warnings,
        bannerLevel,
        ...(errors.length ? { errors } : {}),
    };
}

// ─── Formatting / redaction (shared by the pane + the console bridge) ─────────

/**
 * Serialize a Last-request snapshot for SAFE return/copy-paste — what
 * `MWT.diagnostics.lastRequest()` returns and what any future report section
 * for this tab must go through (the Phase 5 contract: every surface routes
 * through core/redaction.js; no hand-rolled redaction).
 *
 * redactSecretsDeep() rather than redactForReport(): the captured calls are
 * telemetry by construction (core/api.js records ABOUT a call — never the
 * prompt, key, headers, or body), so there are no content fields to gate and
 * no opt-in to honour; what the shared layer still does here is Rule 1b —
 * EVERY string (model/profile ids, finish reasons, error classes) is scrubbed
 * for this install's known secret values, embedded URLs (→ scheme+host), and
 * recognizable key/bearer shapes. Raw (still telemetry-only) copies remain
 * on the Phase 1 paths: MWT.diagnostics.apiCalls() / lastApiCall(module).
 *
 * The input is never mutated; the output shares no references with it.
 *
 * @param {object} snapshot — collectLastRequestSnapshot() output
 * @param {object} [opts]
 * @param {string[]} [opts.knownSecrets] — live secret VALUES; defaults to
 *        collectKnownSecrets() (guarded; [] with no SillyTavern runtime)
 * @returns {object} a redacted deep copy
 */
export function redactLastRequestSnapshot(snapshot, { knownSecrets } = {}) {
    return redactSecretsDeep(snapshot, {
        knownSecrets: knownSecrets ?? collectKnownSecrets(),
    });
}

/**
 * Format a snapshot age in seconds for humans: `just now`, `45s ago`, `3m
 * ago`, `2h 05m ago`, `1d 4h ago`. The same buckets as the Injection tab's
 * formatInjectionAge() (each tab owns its formatter, the health.js
 * formatHealthDuration precedent) so the two can never disagree.
 *
 * @param {number|null} sec
 * @returns {string}
 */
export function formatRequestAge(sec) {
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

