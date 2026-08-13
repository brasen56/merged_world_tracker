/**
 * core/diagnostics.js — In-memory diagnostics ring buffer + last-run map.
 *
 * Phase 0 of the Diagnostics Panel. This is the keystone module every
 * later phase feeds: a cheap, synchronous, always-on event log plus a
 * per-module "last run" stamp. No SillyTavern runtime is required to test it.
 *
 * Hard contracts (design §3.1, §3.3; decision D3):
 *  - READ-ONLY + IN-MEMORY. Nothing here is persisted to chat_metadata,
 *    localStorage, or settings. The buffer clears on page reload.
 *  - ALWAYS-ON. record() never throws and never awaits, so instrumentation
 *    can never break the feature it observes — the first bug of a session is
 *    captured even if the panel was never opened.
 *  - GLOBAL across chat switches. Every entry is stamped with the resolved
 *    chat-identity key (from core/scope.js) AND the operation epoch; a scope
 *    bug is most visible *across* a switch, so the buffer is deliberately not
 *    partitioned per chat. The epoch is the stable correlation dimension that
 *    works on every build — including forks with no usable chat id, where the
 *    identity key mints a unique `unknown:N` per call and cannot group events
 *    by chat on its own.
 *
 * Barrel/stub note: this module is consumed through the core/index.js barrel,
 * which the test harness aliases to test/stubs/core.js. It is re-exported from
 * the stub for parity so barrel consumers see real state under test (see the
 * "barrel→stub alias trap" in the phases doc).
 */

import { getChatIdentity, getEpoch } from './scope.js';

// ─── Config ──────────────────────────────────────────────────────────────────

/** Maximum number of events retained; oldest are evicted once exceeded. */
export const RING_CAPACITY = 200;

/** Severity levels, low → high. Used for validation and filtering. */
export const LEVELS = ['debug', 'info', 'warn', 'error'];

// ─── State ───────────────────────────────────────────────────────────────────
// Module-level (singleton) state, mirroring the pattern in core/scope.js
// (_epoch). Cleared on page reload; reset between tests via
// _resetDiagnostics().

/** Insertion-ordered event list, oldest first. Capped at RING_CAPACITY. */
let _events = [];

/**
 * Per-module last-run stamp:
 *   { [module]: { startedAt, finishedAt, ok, error, tokensIn, tokensOut, trigger } }
 *
 * Null-prototype object so a module literally named "constructor" or
 * "__proto__" could never collide with inherited properties.
 */
const _lastRuns = Object.create(null);

/**
 * Resolver for the chat-identity key stamped on every record(). Defaults to
 * core/scope.js's getChatIdentity(); overridable via _setScopeKeyResolver() so
 * tests can stamp deterministically (the live resolver mints a unique nonce per
 * call when identity is unknown — correct, but non-deterministic).
 */
let _resolveScopeKey = defaultResolveScopeKey;

function defaultResolveScopeKey() {
    try {
        return getChatIdentity()?.key ?? null;
    } catch {
        // Identity resolution must never break instrumentation.
        return null;
    }
}

function normalizeLevel(level) {
    if (typeof level === 'string' && LEVELS.includes(level)) return level;
    return 'info';
}

// ─── Event ring ──────────────────────────────────────────────────────────────

/**
 * Record a diagnostics event. Always-on, synchronous, never throws.
 *
 * @param {object} [entry]
 * @param {string} [entry.level]  — debug|info|warn|error (default info)
 * @param {string} [entry.module] — origin module/tag (e.g. 'api', 'notify')
 * @param {string} [entry.event]  — short event identifier
 * @param {*}      [entry.detail] — arbitrary structured payload
 * @returns {void}
 */
export function record(entry = {}) {
    const { level, module, event, detail } = entry ?? {};

    _events.push({
        ts: Date.now(),
        epoch: getEpoch(),
        level: normalizeLevel(level),
        module: typeof module === 'string' ? module : null,
        event: typeof event === 'string' ? event : null,
        detail,
        scopeKey: _resolveScopeKey(),
    });

    if (_events.length > RING_CAPACITY) {
        _events.splice(0, _events.length - RING_CAPACITY);
    }
}

/**
 * Read events, newest first, optionally filtered. Filters compose — every
 * supplied filter must match.
 *
 * @param {object} [filter]
 * @param {string|string[]} [filter.level] — single level or list of levels
 * @param {string} [filter.module]         — exact module match
 * @param {number} [filter.since]          — inclusive lower bound on ts (ms)
 * @returns {object[]}
 */
export function getEvents({ level, module, since } = {}) {
    const levelSet = level === undefined
        ? null
        : new Set(Array.isArray(level) ? level : [level]);

    const out = [];
    for (let i = _events.length - 1; i >= 0; i--) {
        const e = _events[i];
        if (levelSet && !levelSet.has(e.level)) continue;
        if (module !== undefined && e.module !== module) continue;
        if (since !== undefined && e.ts < since) continue;
        out.push(e);
    }
    return out;
}

/**
 * Clear the event ring. Last-run stamps are unaffected (see clearLastRuns()).
 */
export function clearEvents() {
    _events = [];
}

// ─── Last-run map ────────────────────────────────────────────────────────────

/**
 * Mark a module run as started. Resets any prior result so a stale "ok" from a
 * previous run never lingers into an in-progress one.
 *
 * @param {string} module    — origin module
 * @param {string} [trigger] — what initiated the run (e.g. 'manual'|'auto')
 * @returns {void}
 */
export function setRunStart(module, trigger) {
    if (typeof module !== 'string' || !module) return;
    _lastRuns[module] = {
        startedAt: Date.now(),
        finishedAt: null,
        ok: null,
        error: null,
        tokensIn: null,
        tokensOut: null,
        trigger: typeof trigger === 'string' ? trigger : null,
    };
}

/**
 * Record the outcome of a module run, preserving startedAt/trigger from a
 * prior setRunStart() (defaulting startedAt to now if none was set).
 *
 * @param {string} module
 * @param {object} [result]
 * @param {boolean} [result.ok]
 * @param {string}  [result.error]
 * @param {number}  [result.tokensIn]
 * @param {number}  [result.tokensOut]
 * @returns {void}
 */
export function setRunResult(module, { ok, error, tokensIn, tokensOut } = {}) {
    if (typeof module !== 'string' || !module) return;
    const prev = _lastRuns[module];
    _lastRuns[module] = {
        startedAt: prev?.startedAt ?? Date.now(),
        trigger: prev?.trigger ?? null,
        finishedAt: Date.now(),
        ok: typeof ok === 'boolean' ? ok : null,
        error: error == null ? null : String(error),
        tokensIn: typeof tokensIn === 'number' ? tokensIn : null,
        tokensOut: typeof tokensOut === 'number' ? tokensOut : null,
    };
}

/**
 * @param {string} module
 * @returns {object|undefined} a copy of the last-run stamp, or undefined
 */
export function getLastRun(module) {
    const run = _lastRuns[module];
    return run ? { ...run } : undefined;
}

/**
 * @returns {object} a per-module shallow copy of the full last-run map
 */
export function getAllLastRuns() {
    const out = {};
    for (const key of Object.keys(_lastRuns)) out[key] = { ..._lastRuns[key] };
    return out;
}

/**
 * Clear the last-run map. The event ring is unaffected (see clearEvents()).
 */
export function clearLastRuns() {
    for (const key of Object.keys(_lastRuns)) delete _lastRuns[key];
}

// ─── Test-only seams ─────────────────────────────────────────────────────────

/**
 * Override the scope-key resolver stamped on each event. Pass a function, or
 * null/omit to restore the default (core/scope.js getChatIdentity).
 * @internal — deterministic test stamping only.
 */
export function _setScopeKeyResolver(fn) {
    _resolveScopeKey = typeof fn === 'function' ? fn : defaultResolveScopeKey;
}

/**
 * Wipe all diagnostics state (events, last-runs, resolver). Mirrors
 * core/scope.js's _resetEpoch().
 * @internal — test isolation only; production code must not call this.
 */
export function _resetDiagnostics() {
    _events = [];
    clearLastRuns();
    _resolveScopeKey = defaultResolveScopeKey;
}
