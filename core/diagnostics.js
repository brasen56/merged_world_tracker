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

/** Maximum number of API call summaries retained separately from log events. */
export const API_CALL_CAPACITY = 20;

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

/** API call summaries, oldest first. The event ring also receives each summary. */
let _apiCalls = [];

/** Most recent API call per module key. Values are copies of entries in _apiCalls. */
const _lastApiCalls = Object.create(null);

/**
 * Injected-payload snapshots (Phase 2):
 *   { [key]: { key, payload, role, depth, enabled, at } }
 *
 * ONE snapshot per setExtensionPrompt key, OVERWRITTEN on each apply — the
 * injected payload is a frozen snapshot until something re-applies it, so the
 * panel must show this recorded value, never a fresh rebuild (design §I.4.4).
 * Null-prototype for the same reason as _lastRuns.
 */
const _injections = Object.create(null);

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

/**
 * Record a completed API call summary. This intentionally stores telemetry only;
 * callers must redact or omit prompts, keys, headers, and response bodies.
 *
 * @param {object} [call]
 * @param {string} [call.module] feature/module key, defaulting to "api"
 * @returns {object|undefined} the stored summary
 */
export function recordApiCall(call = {}) {
    if (!call || typeof call !== 'object') return undefined;
    const module = typeof call.module === 'string' && call.module ? call.module : 'api';
    const summary = { ...call, module };
    _apiCalls.push(summary);
    if (_apiCalls.length > API_CALL_CAPACITY) {
        _apiCalls.splice(0, _apiCalls.length - API_CALL_CAPACITY);
    }
    _lastApiCalls[module] = { ...summary };
    record({
        level: summary.errorClass ? 'error' : 'info',
        module: 'api',
        event: 'api_call',
        detail: summary,
    });
    return { ...summary };
}

/** @returns {object[]} API calls newest first */
export function getApiCalls() {
    return _apiCalls.slice().reverse().map(call => ({ ...call }));
}

/** @param {string} [module] @returns {object|undefined} */
export function getLastApiCall(module = 'api') {
    const call = _lastApiCalls[module];
    return call ? { ...call } : undefined;
}

/** @returns {object} per-module last API call copies */
export function getAllLastApiCalls() {
    const out = {};
    for (const key of Object.keys(_lastApiCalls)) out[key] = { ..._lastApiCalls[key] };
    return out;
}

/** Clear API call summaries without affecting ordinary log events. */
export function clearApiCalls() {
    _apiCalls = [];
    for (const key of Object.keys(_lastApiCalls)) delete _lastApiCalls[key];
}

// ─── Injected-payload snapshots (Phase 2) ─────────────────────────────────────

/**
 * Record what applyExtensionPromptInjection (core/injection.js) actually sent
 * to SillyTavern's setExtensionPrompt: `{ key, payload, role, depth, enabled,
 * at }`. One snapshot per key, OVERWRITTEN on each apply — including applies
 * that CLEAR the slot (enabled:false, payload:''), because "it was cleared at
 * T" is exactly as diagnostic as what it contained before.
 *
 * Unlike recordApiCall this store keeps the payload BODY (that is its whole
 * purpose), but it is still in-memory only; the future panel (Phase 5+) routes
 * it through the redaction layer before display. The event-ring echo
 * deliberately carries metadata + payload length ONLY, so the ring never
 * duplicates full payloads.
 *
 * Never throws (always-on contract, decision D3): bad input is a no-op.
 *
 * @param {object}  [snapshot]
 * @param {string}  [snapshot.key]     — setExtensionPrompt key (required)
 * @param {string}  [snapshot.payload] — exact string passed to setExtensionPrompt
 * @param {number}  [snapshot.role]    — numeric role actually sent (0|1|2)
 * @param {number}  [snapshot.depth]   — resolved depth actually sent
 * @param {boolean} [snapshot.enabled] — false when this apply cleared the slot
 * @returns {object|undefined} a copy of the stored snapshot, or undefined on bad input
 */
export function recordInjection(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object') return undefined;
    const { key } = snapshot;
    if (typeof key !== 'string' || !key) return undefined;
    const payload = typeof snapshot.payload === 'string' ? snapshot.payload : String(snapshot.payload ?? '');
    const snap = {
        key,
        payload,
        role: typeof snapshot.role === 'number' ? snapshot.role : null,
        depth: typeof snapshot.depth === 'number' ? snapshot.depth : null,
        enabled: snapshot.enabled === true,
        at: Date.now(),
    };
    _injections[key] = snap;
    record({
        level: 'info',
        module: 'injection',
        event: 'injection_applied',
        detail: {
            key,
            enabled: snap.enabled,
            role: snap.role,
            depth: snap.depth,
            chars: payload.length,
            at: snap.at,
        },
    });
    return { ...snap };
}

/**
 * @param {string} key — setExtensionPrompt key
 * @returns {object|undefined} a copy of the last snapshot applied for that key
 */
export function getInjectedSnapshot(key) {
    const snap = _injections[key];
    return snap ? { ...snap } : undefined;
}

/**
 * @returns {object} per-key copies of every recorded injection snapshot
 */
export function getAllInjectedSnapshots() {
    const out = {};
    for (const k of Object.keys(_injections)) out[k] = { ..._injections[k] };
    return out;
}

/**
 * Clear injection snapshots without affecting events, API calls, or last runs.
 */
export function clearInjections() {
    for (const k of Object.keys(_injections)) delete _injections[k];
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
    clearApiCalls();
    clearLastRuns();
    clearInjections();
    _resolveScopeKey = defaultResolveScopeKey;
}
