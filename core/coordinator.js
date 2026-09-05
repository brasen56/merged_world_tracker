/**
 * core/coordinator.js — Central generation coordinator + cancellation model.
 *
 * TODO §1 / Potential_Improvements §P1. Each module owns its busy flag
 * (`wstIsRefreshing`, `isGenerating`, `isRunning`, …) and those flags are
 * correct WITHIN their module — but nothing stops World State, Chronicle,
 * Knowledge, Story Planner, and Interiority from issuing simultaneous
 * outbound calls ACROSS modules: API rate-limit bursts, several expensive
 * calls after one message, overlapping notifications, and token pressure
 * from parallel refreshes.
 *
 * This module is the single place that knows what is in flight across all
 * modules. It provides:
 *
 *   1. Concurrency limits — per-module (one outbound generation at a time,
 *      matching every module's own busy-flag contract) and global
 *      (`apiMaxConcurrent`, default 2, from the global settings record).
 *   2. A priority queue — manual user actions outrank automatic/background
 *      work when slots free up (PRIORITY.MANUAL < AUTO < BACKGROUND).
 *   3. Deduplication — a submitted job may carry a `key`; while an equal-key
 *      job is still QUEUED, the new submission joins it (one handle, one
 *      run, both awaiters settle together) instead of queueing a duplicate.
 *   4. Cancellation — every job owns an AbortController. Cancelling a
 *      queued job prevents it from ever starting; cancelling a running job
 *      aborts the signal the run received (the transport maps that onto
 *      fetch() where the backend supports it). A chat switch retires every
 *      job captured at an older epoch (see onChatScopeChanged).
 *   5. A unified status — every job moves queued → running → ok | failed |
 *      cancelled, queryable via getCoordinatorSnapshot() and surfaced as
 *      diagnostics events (module 'coordinator') in the 📋 Log tab.
 *   6. An optional policy — "don't run background jobs while the user is
 *      generating" (global setting `pauseBackgroundJobsDuringGeneration`,
 *      default off). Depth-counted; index.js decrements on ONE canonical
 *      terminal event per build (GENERATION_ENDED when exposed, else
 *      GENERATION_STOPPED) so a STOPPED+ENDED double-fire cannot
 *      double-decrement, and onChatScopeChanged() hard-resets the depth —
 *      a chat switch is a lifecycle boundary that bounds any leak to the
 *      chat it happened in.
 *
 * Adoption seam: core/api.js routes BOTH transports (fetchFromApi and
 * fetchViaConnectionProfile) through submitJob(), so every module call is
 * coordinated without per-module restructuring.
 *
 * Whole-flow submission is NOT supported. A flow job whose run() awaits a
 * nested transport call for the SAME module id self-deadlocks: the outer job
 * occupies the module's only PER_MODULE_LIMIT slot while the inner job can
 * never satisfy canStart(), so neither settles. `key`/dedupe is a
 * transport-level concern only; a re-entrancy token/bypass for nested calls
 * must exist before any caller submits whole flows here.
 *
 * Purity: this module must stay importable under Node/Vitest (the
 * barrel→stub alias re-exports it). It imports only leaf-safe core modules
 * and wraps every host-dependent read in try/catch with a sane default.
 * Tests reset it via _resetCoordinator() (called from resetCoreStubs) and
 * pin behavior deterministically via _setCoordinatorResolvers().
 */

import { record } from './diagnostics.js';
import { getEpoch, getChatIdentity } from './scope.js';
import { getGlobalSettings } from './settings.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Job priorities. Lower numbers start first. Manual button presses and slash
 * commands (the user is watching) must outrank automatic counters, which must
 * outrank anything explicitly marked background work.
 */
export const PRIORITY = Object.freeze({
    MANUAL: 0,
    AUTO: 5,
    BACKGROUND: 10,
});

/**
 * One outbound generation per module at a time — matches every module's own
 * busy-flag contract, so coordination can never force a module to interleave
 * two of its own flows.
 */
export const PER_MODULE_LIMIT = 1;

/** Default for the global limit when the setting is absent/unusable. */
export const DEFAULT_GLOBAL_LIMIT = 2;

/** Upper bound for the global limit (a hand-edited absurd value must not
 *  silently become "unlimited"). */
export const MAX_GLOBAL_LIMIT = 8;

/** How many settled job records the snapshot keeps (status/diagnostics). */
export const SETTLED_HISTORY_CAP = 30;

// ─── Injectable resolvers (test seam) ─────────────────────────────────────────

/**
 * Resolver for the global settings record. Defaults to core/settings.js's
 * canonical accessor; never throws — coordination must not break because a
 * settings read failed (the documented defaults are the fail-open behavior).
 */
function defaultGetGlobalSettings() {
    try {
        return getGlobalSettings();
    } catch {
        return {};
    }
}

/**
 * Resolver for a display/scope key stamped on each job. Reporting only —
 * CANCELLATION keys on the epoch (see onChatScopeChanged), which is reliable
 * on every build; the scope key is what makes the status readable.
 */
function defaultResolveScopeKey() {
    try {
        return getChatIdentity()?.key ?? null;
    } catch {
        return null;
    }
}

let _resolvers = {
    getGlobalSettings: defaultGetGlobalSettings,
    resolveScopeKey: defaultResolveScopeKey,
};

/**
 * Replace the host-dependent resolvers. Exported for tests only — production
 * code must never call this (same contract as core/diagnostics.js's
 * _setScopeKeyResolver).
 * @internal
 */
export function _setCoordinatorResolvers({ getGlobalSettings: settingsGetter, resolveScopeKey: scopeKeyResolver } = {}) {
    _resolvers = {
        getGlobalSettings: settingsGetter ?? defaultGetGlobalSettings,
        resolveScopeKey: scopeKeyResolver ?? defaultResolveScopeKey,
    };
}

// ─── State (module singleton) ─────────────────────────────────────────────────

/** Insertion-ordered queue of not-yet-started jobs. */
const _queue = [];

/** Jobs currently running (their run() promise is pending). */
const _running = new Set();

/** Most recent settled jobs, oldest first, capped. */
const _recentSettled = [];

/** Monotonic job id. */
let _jobSeq = 0;

/**
 * Depth of "the user is generating" windows. GENERATION_STARTED increments;
 * the ONE canonical terminal event selected in index.js (GENERATION_ENDED on
 * builds that expose it, else GENERATION_STOPPED) decrements, floored at 0.
 * Because a single event cannot double-count, a build firing both stop
 * events for one generation is harmless by construction, nested windows
 * (group-queue bursts) hold the pause until the last one ends, and
 * interleaved terminals of two concurrent generations each unwind their own
 * window. onChatScopeChanged() hard-resets it (a chat switch bounds any
 * leak — e.g. a fork that aborts a generation without firing its terminal).
 */
let _userGenerationDepth = 0;

/** True when the most recent pump pass held at least one background job
 *  because of the user-generation pause (drives the resume event). */
let _lastHeldHadBackground = false;

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Build the error every cancelled job rejects with. Recognizable downstream
 * via isCancellation() so flows can discard quietly instead of surfacing a
 * scary "failed" toast for work the coordinator deliberately stopped.
 */
function makeCancelledError(reason) {
    const err = new Error(`Job cancelled (${reason})`);
    err.name = 'JobCancelledError';
    err._mwtCancelled = true;
    err.cancelReason = reason;
    return err;
}

/**
 * Is this error a coordinator cancellation? Covers our own marker, a native
 * AbortError (fetch()/AbortController), and a DOMException-style abort.
 * @param {*} err
 * @returns {boolean}
 */
export function isCancellation(err) {
    if (!err || typeof err !== 'object') return false;
    if (err._mwtCancelled === true) return true;
    return err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.aborted === true;
}

// ─── Settings reads ───────────────────────────────────────────────────────────

/** The effective global concurrency limit (≥1, ≤MAX_GLOBAL_LIMIT). */
function globalLimit() {
    let raw;
    try {
        raw = Number(_resolvers.getGlobalSettings()?.apiMaxConcurrent);
    } catch {
        raw = NaN;
    }
    if (!Number.isFinite(raw) || raw < 1) return DEFAULT_GLOBAL_LIMIT;
    return Math.min(MAX_GLOBAL_LIMIT, Math.floor(raw));
}
// ─── Signal composition ───────────────────────────────────────────────────────

/**
 * Compose several AbortSignals into one. The returned signal aborts when ANY
 * input aborts (or immediately if one already has). Used to hand a job's run
 * a single signal that fires on job cancellation OR on the caller's own
 * external signal.
 *
 * @param {...AbortSignal} signals
 * @returns {{ signal: AbortSignal|null, cleanup: (() => void)|null }}
 */
function composeSignals(...signals) {
    const live = signals.filter(s => s && typeof s.addEventListener === 'function');
    if (live.length === 0) return { signal: null, cleanup: null };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    let alreadyAborted = false;
    for (const s of live) {
        if (s.aborted) {
            alreadyAborted = true;
            break;
        }
        s.addEventListener('abort', onAbort, { once: true });
    }
    if (alreadyAborted) {
        controller.abort();
        return { signal: controller.signal, cleanup: null };
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            for (const s of live) s.removeEventListener('abort', onAbort);
        },
    };
}

// ─── Busy notification ────────────────────────────────────────────────────────

/**
 * Tell the UI a module busy-state changed. Same decoupled CustomEvent the
 * modules already dispatch; guarded so the pure module stays usable in Node
 * (tests that care install a fake `document`).
 */
function dispatchBusyChanged() {
    if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
    try {
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    } catch { /* never let a UI notify break coordination */ }
}

// ─── Job records ──────────────────────────────────────────────────────────────

/** Public, JSON-safe view of a job record (no promises, no controllers). */
function publicJob(job) {
    return {
        id: job.id,
        module: job.module,
        kind: job.kind,
        key: job.key,
        priority: job.priority,
        background: job.background,
        state: job.state,
        scopeKey: job.scopeKey,
        epoch: job.epoch,
        enqueuedAt: job.enqueuedAt,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        waitedMs: job.startedAt != null ? job.startedAt - job.enqueuedAt : null,
        durationMs: job.endedAt != null && job.startedAt != null ? job.endedAt - job.startedAt : null,
        error: job.error,
    };
}


/** Is the "pause background jobs while the user is generating" policy on? */
function backgroundPauseEnabled() {
    try {
        return _resolvers.getGlobalSettings()?.pauseBackgroundJobsDuringGeneration === true;
    } catch {
        return false;
    }
}

/** Is the background pause currently holding jobs? */
function backgroundPaused() {
    return _userGenerationDepth > 0 && backgroundPauseEnabled();
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

/** May this job start right now? */
function canStart(job) {
    if (_running.size >= globalLimit()) return false;
    for (const r of _running) {
        if (r.module === job.module) return false; // per-module serialization
    }
    if (job.background && backgroundPaused()) return false;
    return true;
}

/**
 * Start every queued job that can start, in (priority, id) order. Skipped
 * jobs (module busy / no global slot / held background) are left queued; the
 * scan continues past them so an unrelated module's job is never blocked by
 * an unstartable one (no head-of-line blocking).
 */
function pump() {
    const order = _queue
        .slice()
        .sort((a, b) => (a.priority - b.priority) || (a.id - b.id));
    let heldBackground = false;
    for (const job of order) {
        if (job.background && backgroundPaused()) {
            heldBackground = true;
            if (!job.heldNotified) {
                job.heldNotified = true;
                record({
                    level: 'info',
                    module: 'coordinator',
                    event: 'job_held',
                    detail: { id: job.id, module: job.module, kind: job.kind, reason: 'user-generating' },
                });
            }
            continue;
        }
        if (canStart(job)) startJob(job);
    }
    _lastHeldHadBackground = heldBackground;
}

/** Remove a job from the pending queue (it is starting or being cancelled). */
function dequeue(job) {
    const idx = _queue.indexOf(job);
    if (idx !== -1) _queue.splice(idx, 1);
}

/** Settle a job and hand its outcome to the submitter. */
function settleJob(job, state, value, err) {
    _running.delete(job);
    dequeue(job);
    job.state = state;
    job.endedAt = Date.now();
    job.error = state === 'ok' ? null : String(err?.message ?? err ?? state);
    _recentSettled.push(job);
    while (_recentSettled.length > SETTLED_HISTORY_CAP) _recentSettled.shift();
    if (typeof job.offExternal === 'function') {
        try { job.offExternal(); } catch { /* listener cleanup must not throw */ }
        job.offExternal = null;
    }
    if (state === 'ok') job.deferred.resolve(value);
    else job.deferred.reject(err ?? makeCancelledError(state));
    dispatchBusyChanged();
    // Freed a slot — give the next eligible job its turn.
    pump();
}

/** Begin executing a queued job. */
async function startJob(job) {
    dequeue(job);
    _running.add(job);
    job.state = 'running';
    job.startedAt = Date.now();
    const waitedMs = job.startedAt - job.enqueuedAt;
    if (waitedMs > 0 || job.heldNotified) {
        // A job that ran immediately is already visible via the API-call
        // capture; only queue/held delay is coordinator-specific news.
        record({
            level: 'debug',
            module: 'coordinator',
            event: 'job_started_after_wait',
            detail: { id: job.id, module: job.module, kind: job.kind, waitedMs, held: job.heldNotified === true },
        });
    }
    dispatchBusyChanged();
    const composed = composeSignals(job.controller?.signal, job.externalSignal);
    try {
        const value = await job.run({ signal: composed.signal });
        // A run that cannot observe its signal (the Connection Manager
        // transport's sendRequest has no signal parameter) may still RESOLVE
        // after the coordinator aborted the job. The composed signal is the
        // authority: a value produced under an aborted signal belongs to a job
        // the coordinator already cancelled, so it is discarded and the
        // submitter sees a cancellation rejection — never a stale success
        // recorded as `ok`.
        if (composed.signal?.aborted) {
            settleJob(job, 'cancelled', null, makeCancelledError(job.cancelReason ?? 'resolved after abort'));
        } else {
            settleJob(job, 'ok', value, null);
        }
    } catch (err) {
        if (isCancellation(err)) settleJob(job, 'cancelled', null, err);
        else settleJob(job, 'failed', null, err);
    } finally {
        if (typeof composed.cleanup === 'function') {
            try { composed.cleanup(); } catch { /* see composeSignals */ }
        }
    }
}

/**
 * Cancel one job.
 *
 * - queued → it never starts; its promise rejects with a cancellation error.
 * - running → its AbortController fires (the run's fetch rejects where the
 *   backend supports it); the job settles as cancelled when the run unwinds.
 * - settled → no-op (returns false).
 *
 * @returns {boolean} true when this call caused (or triggered) a cancellation
 */
function cancelJob(job, reason) {
    if (job.state === 'queued') {
        record({
            level: 'info',
            module: 'coordinator',
            event: 'job_cancelled',
            detail: { id: job.id, module: job.module, kind: job.kind, phase: 'queued', reason },
        });
        settleJob(job, 'cancelled', null, makeCancelledError(reason));
        return true;
    }
    if (job.state === 'running') {
        record({
            level: 'info',
            module: 'coordinator',
            event: 'job_cancelled',
            detail: { id: job.id, module: job.module, kind: job.kind, phase: 'running', reason },
        });
        // Remember why the run's signal aborted — startJob reuses it when the
        // run resolves anyway (a signal-ignoring run) so the eventual
        // JobCancelledError names the real cause.
        job.cancelReason = reason;
        if (job.controller && !job.controller.signal.aborted) job.controller.abort();
        return true;
    }
    return false;
}


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Submit a job to the coordinator.
 *
 * @param {object} opts
 * @param {string} opts.module — owning module id ('world_state', 'chronicle',
 *   'knowledge', 'story_planner', 'interiority', or 'api' for unattributed
 *   transport calls). Drives the per-module limit.
 * @param {string} [opts.kind] — short label for status/diagnostics
 *   (e.g. 'api-call', 'refresh').
 * @param {*} [opts.key] — dedupe key. While an equal-key job is QUEUED, the
 *   new submission returns that job's handle instead of queueing a second.
 *   Jobs are never deduped against RUNNING work (the module busy flags own
 *   that refusal). The join is by identity ONLY: the joining submission's
 *   priority, background flag, module, and run() are ignored (the FIRST
 *   submission's parameters win), and the joining caller's external signal
 *   is NOT wired — it cannot cancel the joined job. Callers that need their
 *   own cancellation semantics must not share a key.
 * @param {number} [opts.priority=PRIORITY.AUTO] — lower starts first.
 * @param {boolean} [opts.background=false] — may be held while the
 *   user-generation pause is active (policy-gated).
 * @param {AbortSignal} [opts.signal] — external signal; aborting it cancels
 *   this job like an explicit cancel().
 * @param {function({ signal: AbortSignal|null }): Promise<*>} opts.run — the
 *   work. Receives ONE composed signal (job cancellation ∥ external signal).
 * @returns {{
 *   id: number,
 *   promise: Promise<*>,
 *   state: 'queued'|'running'|'ok'|'failed'|'cancelled',
 *   cancel: (reason?: string) => boolean,
 * }}
 */
export function submitJob({
    module,
    kind = 'job',
    key = null,
    priority = PRIORITY.AUTO,
    background = false,
    signal = null,
    run,
}) {
    if (typeof run !== 'function') {
        throw new TypeError('submitJob: run must be a function');
    }
    const moduleId = (typeof module === 'string' && module) ? module : 'api';

    // Dedupe: join an equal-key job that is still waiting to start.
    if (key !== null) {
        const existing = _queue.find(j => j.state === 'queued' && j.key === key);
        if (existing) {
            record({
                level: 'info',
                module: 'coordinator',
                event: 'job_deduped',
                detail: { module: moduleId, kind, key: String(key), joinedId: existing.id },
            });
            return existing.handle;
        }
    }

    const id = ++_jobSeq;
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const deferred = {};
    const promise = new Promise((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
    });
    let scopeKey = null;
    try { scopeKey = _resolvers.resolveScopeKey(); } catch { scopeKey = null; }
    const job = {
        id,
        module: moduleId,
        kind,
        key,
        priority: Number.isFinite(Number(priority)) ? priority : PRIORITY.AUTO,
        background: background === true,
        state: 'queued',
        scopeKey,
        epoch: getEpoch(),
        enqueuedAt: Date.now(),
        startedAt: null,
        endedAt: null,
        error: null,
        heldNotified: false,
        controller,
        externalSignal: signal ?? null,
        offExternal: null,
        run,
        deferred,
    };
    job.handle = {
        id,
        promise,
        get state() { return job.state; },
        cancel: (reason = 'cancelled') => cancelJob(job, reason),
    };
    job.promise = promise;

    // Wire the external signal: aborting it cancels this job from outside.
    if (job.externalSignal && typeof job.externalSignal.addEventListener === 'function') {
        if (job.externalSignal.aborted) {
            // Already dead — settle through the normal cancellation path
            // (visible `cancelled` state, endedAt, settled history, marked
            // rejection) without ever queueing it. A bare deferred.reject
            // would leave a ghost `queued` handle that appears in no snapshot
            // and contradicts the documented queued → … → cancelled model.
            record({
                level: 'info',
                module: 'coordinator',
                event: 'job_cancelled',
                detail: { id, module: moduleId, kind, phase: 'pre-queue', reason: 'external-signal' },
            });
            settleJob(job, 'cancelled', null, makeCancelledError('external-signal'));
            return job.handle;
        }
        const onExternalAbort = () => cancelJob(job, 'external-signal');
        job.externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        job.offExternal = () => job.externalSignal.removeEventListener('abort', onExternalAbort);
    }

    _queue.push(job);
    pump();
    return job.handle;
}

/**
 * Cancel every job matching the filter (queued jobs never start; running
 * jobs are aborted). Omitted fields match everything.
 *
 * @param {object} [filter]
 * @param {string} [filter.module] — exact module id.
 * @param {number} [filter.epoch] — only jobs captured at THIS epoch.
 * @returns {{ queued: number, running: number }} counts of jobs affected.
 */
export function cancelWhere({ module, epoch } = {}) {
    let queued = 0;
    let running = 0;
    const matches = (job) =>
        (module === undefined || job.module === module) &&
        (epoch === undefined || job.epoch === epoch);
    for (const job of [..._queue, ..._running]) {
        if (job.state !== 'queued' && job.state !== 'running') continue;
        if (!matches(job)) continue;
        if (job.state === 'queued') queued += 1;
        else running += 1;
        cancelJob(job, `cancelWhere(${module ?? 'all'})`);
    }
    if (queued + running > 0) {
        record({
            level: 'info',
            module: 'coordinator',
            event: 'jobs_cancelled',
            detail: { module: module ?? null, queued, running },
        });
    }
    return { queued, running };
}

/**
 * Retire stale jobs after a chat switch. The root CHAT_CHANGED handler calls
 * this right AFTER bumpEpoch(): every job captured at an OLDER epoch belongs
 * to the outgoing chat — its results would be discarded by the scope guards
 * anyway, so queued copies never start (saves the API call) and running
 * copies are aborted (saves the tokens).
 *
 * The EPOCH — not the scope key — is the filter because chat identity can be
 * UNKNOWN on some builds and two unknown keys must never compare equal
 * (core/scope.js contract); the epoch is bumped synchronously on every chat
 * change, so it is the one signal that is reliable everywhere.
 *
 * @returns {{ queued: number, running: number }} counts of jobs cancelled.
 */
export function onChatScopeChanged() {
    const current = getEpoch();
    // A chat switch is a hard lifecycle boundary for the user's generation
    // windows too: the outgoing chat's START/terminal balance is unknowable
    // (a fork can abort a generation on switch and never fire its terminal
    // pair), so any leaked depth — which would hold background jobs in the
    // NEW chat forever under the pause policy — is cleared here. A leak can
    // no longer outlive the chat it happened in.
    if (_userGenerationDepth !== 0) {
        record({
            level: 'info',
            module: 'coordinator',
            event: 'user_generation_depth_reset',
            detail: { reason: 'chat-changed', depth: _userGenerationDepth },
        });
        _userGenerationDepth = 0;
        _lastHeldHadBackground = false;
    }
    // Pass 1: retire stale QUEUED jobs by dequeueing them directly — a plain
    // cancel would settle→pump and could START a stale job mid-sweep.
    const staleQueued = _queue.filter(j => j.epoch !== current);
    for (const job of staleQueued) dequeue(job);
    // Pass 2: abort stale RUNNING jobs (each settles cancelled as its run
    // unwinds; the settle-pump can no longer start anything stale because
    // every stale queued job is already out of the queue).
    let running = 0;
    for (const job of [..._running]) {
        if (job.epoch === current) continue;
        running += 1;
        cancelJob(job, 'chat-changed');
    }
    // Pass 3: settle the retired queued jobs (visible states + rejections),
    // then pump once so fresh-epoch work inherits the freed slots.
    for (const job of staleQueued) {
        record({
            level: 'info',
            module: 'coordinator',
            event: 'job_cancelled',
            detail: { id: job.id, module: job.module, kind: job.kind, phase: 'queued', reason: 'chat-changed' },
        });
        settleJob(job, 'cancelled', null, makeCancelledError('chat-changed'));
    }
    const queued = staleQueued.length;
    if (queued + running > 0) {
        record({
            level: 'info',
            module: 'coordinator',
            event: 'jobs_cancelled_chat_changed',
            detail: { queued, running },
        });
    }
    // The depth reset above may have unheld background jobs that nothing in
    // the sweep will pump (no job settled); give them their turn explicitly.
    // Safe after the sweep: every stale queued job is already out of the
    // queue, so this can only start current-epoch work.
    pump();
    return { queued, running };
}


/**
 * The user's own generation started (ST GENERATION_STARTED). With the
 * optional policy on, background jobs hold until endUserGeneration().
 */
export function beginUserGeneration() {
    const was = _userGenerationDepth;
    _userGenerationDepth += 1;
    if (was === 0 && backgroundPauseEnabled()) {
        record({
            level: 'info',
            module: 'coordinator',
            event: 'queue_paused',
            detail: { reason: 'user-generating' },
        });
    }
    pump();
}

/**
 * The user's own generation ended (ST GENERATION_STOPPED and/or ENDED —
 * depth-counted so a double fire is harmless). Releases held background
 * jobs.
 */
export function endUserGeneration() {
    _userGenerationDepth = Math.max(0, _userGenerationDepth - 1);
    if (_userGenerationDepth === 0 && _lastHeldHadBackground) {
        record({
            level: 'info',
            module: 'coordinator',
            event: 'queue_resumed',
            detail: { reason: 'user-generating-ended' },
        });
        _lastHeldHadBackground = false;
    }
    pump();
}

/**
 * Re-run the scheduler. Needed after the global limit is raised (queued
 * jobs otherwise only start on the next submit/settle). Called by the
 * Settings-tab save handler.
 */
export function pumpCoordinator() {
    pump();
}

/**
 * The unified busy/queued/cancelled/failed status: everything the
 * coordinator knows, JSON-safe, settled history newest last.
 *
 * Surfaced via `MWT.coordinator.status()` and designed to be consumable by a
 * future diagnostics row without another shape change.
 */
export function getCoordinatorSnapshot() {
    return {
        limits: { global: globalLimit(), perModule: PER_MODULE_LIMIT },
        userGeneration: {
            depth: _userGenerationDepth,
            backgroundPaused: backgroundPaused(),
        },
        running: [..._running].map(publicJob),
        queued: _queue.map(publicJob),
        recentSettled: _recentSettled.map(publicJob),
    };
}

/**
 * Wipe all coordinator state. Exported for test isolation only — production
 * code must never call this. Abandoned job promises simply never settle.
 * @internal
 */
export function _resetCoordinator() {
    _queue.length = 0;
    _running.clear();
    _recentSettled.length = 0;
    _jobSeq = 0;
    _userGenerationDepth = 0;
    _lastHeldHadBackground = false;
    _resolvers = {
        getGlobalSettings: defaultGetGlobalSettings,
        resolveScopeKey: defaultResolveScopeKey,
    };
}

