/**
 * interiority/capture.js — Opt-in, generation-scoped intentions diagnostics capture.
 *
 * Lifecycle plan Tier 1 item 4
 * (upcoming_work_misc/INTERIORITY_LIFECYCLE_IMPLEMENTATION_PLAN.md):
 * diagnosing the reported "completed action re-proposed as a plan" failure
 * class requires seeing a WHOLE intentions generation — every constituent
 * call (unified / split / strict modes issue different calls), the prompts
 * and raw responses, the ledger before and after, and the accept/reject/
 * ignore decision for each entry. The ordinary API-call telemetry is
 * deliberately bodies-free (core/diagnostics.js recordApiCall is
 * "telemetry only" by contract), so this module is a SEPARATE, dedicated,
 * bounded snapshot — the only place prompt and response bodies are retained.
 *
 * Hard contracts (all deliberate):
 *  - OPT-IN. Nothing is captured unless the Interiority setting
 *    `captureIntentionsDiagnostics` is on (temporary reporter-facing
 *    diagnostic, default off). Callers pass `enabled` at begin time.
 *  - IN-MEMORY ONLY. Never persisted to chat metadata, settings, or
 *    storage; gone on reload.
 *  - LATEST GENERATION ONLY. One committed snapshot; a new intentions-
 *    bearing generation replaces it. A thoughts-only (or dormant-poll-only)
 *    generation does NOT replace it — the stored intentions evidence
 *    survives, which is exactly what a reporter is asked to capture.
 *  - BOUNDED. Per-field character caps and per-generation call / attempt /
 *    decision / ledger caps. A pathological generation fills the caps and
 *    gets counted, not stored.
 *  - SCOPE-STAMPED. Stamped with the scope epoch (core/scope.js) at begin;
 *    committing or reading after a chat switch (epoch change) discards the
 *    stale data. Interiority's chat-change handlers clear it explicitly as
 *    well, so eviction never depends on the epoch alone.
 *  - RING GETS METADATA ONLY. Committing writes one metadata summary event
 *    into the ordinary diagnostics ring (counts + ids, never bodies).
 *    Bodies leave this module only through the report section
 *    (collectIntentionsCaptureSection), which nests them under a
 *    content-gated `payload` key for the shared redaction layer
 *    (core/redaction.js CONTENT_KEYS), so the Copy Report's explicit
 *    include-content opt-in governs them; secrets are still scrubbed inside
 *    included content.
 *
 * Self-contained on purpose: no imports from interiority/data.js — settings
 * and ledger snapshots are passed in by callers — so
 * diagnostics_panel/report.js can import this module directly without
 * dragging the interiority store (and, under Vitest, the barrel→stub alias)
 * into the report path. getEpoch / record are imported directly from the
 * leaf core modules, the same rule interiority/data.js applies to the
 * write seam.
 */

import { getEpoch } from '../core/scope.js';
import { record } from '../core/diagnostics.js';

// ─── Bounds ──────────────────────────────────────────────────────────────────

/** Max characters retained per prompt/response/error text field. */
export const CAPTURE_TEXT_CHAR_CAP = 20000;

/**
 * Max constituent calls per generation. Strict mode issues one call per
 * roster NPC (maxNpcs is capped at 20 in the UI) plus the split pair and/or
 * the dormant poll; 24 covers the worst case with headroom.
 */
export const CAPTURE_MAX_CALLS = 24;

/** Max recorded attempts per call (fetchAndParse retries once → 2). */
export const CAPTURE_MAX_ATTEMPTS_PER_CALL = 4;

/** Max recorded decisions per generation; overflow is counted, not stored. */
export const CAPTURE_MAX_DECISIONS = 120;

/** Max ledger entries serialized per before/after side. */
export const CAPTURE_MAX_LEDGER_ENTRIES = 50;

// ─── State (module singleton) ─────────────────────────────────────────────────

/** In-flight generation capture (between begin and complete). */
let _pending = null;

/** Latest committed snapshot — ONE, overwritten by the next intentions generation. */
let _committed = null;

/** Monotonic generation counter, for readable ids in reports. */
let _generationSeq = 0;

function _capText(value) {
    const text = String(value ?? '');
    if (text.length <= CAPTURE_TEXT_CHAR_CAP) return text;
    return `${text.slice(0, CAPTURE_TEXT_CHAR_CAP)}\n…[truncated — ${text.length} chars total]`;
}

/** Copy a ledger array into the bounded capture shape (no live references). */
function _capLedger(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const kept = list.slice(0, CAPTURE_MAX_LEDGER_ENTRIES).map(e => ({
        id: e?.id ?? null,
        npc: String(e?.npc ?? ''),
        action: _capText(e?.action).slice(0, 500),
        trigger: _capText(e?.trigger).slice(0, 500),
        status: e?.status ?? 'active',
        since: String(e?.since ?? ''),
        turnsOpen: e?.turnsOpen ?? 0,
        manual: e?.manual === true,
        declaredMsgIdx: e?.declaredMsgIdx ?? null,
    }));
    return { entries: kept, total: list.length, truncated: list.length > kept.length };
}

function _summarize(pending) {
    const callsByKind = {};
    for (const c of pending.calls) callsByKind[c.kind] = (callsByKind[c.kind] || 0) + 1;
    const decisionsByOutcome = {};
    const decisionsByReason = {};
    for (const d of pending.decisions) {
        decisionsByOutcome[d.outcome] = (decisionsByOutcome[d.outcome] || 0) + 1;
        if (d.reason) decisionsByReason[d.reason] = (decisionsByReason[d.reason] || 0) + 1;
    }
    return {
        calls: pending.calls.length + pending.droppedCalls,
        callsByKind,
        decisions: pending.decisions.length + pending.droppedDecisions,
        decisionsByOutcome,
        decisionsByReason,
    };
}

// ─── Generation lifecycle ─────────────────────────────────────────────────────

/**
 * Begin a generation capture. No-op (and no state change) unless enabled.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=false] - the module setting
 *   (`captureIntentionsDiagnostics`), resolved by the caller
 * @param {string} [opts.mode='unified'] - 'unified' | 'split' | 'strict'
 * @param {string|null} [opts.trigger] - generation trigger (TRIGGER.*)
 * @param {Array} [opts.ledgerBefore] - pre-mutation ledger (the orchestrator's
 *   pre-poll rollback snapshot — before every ledger mutation of the turn)
 */
export function beginIntentionsGenerationCapture({
    enabled = false, mode = 'unified', trigger = null, ledgerBefore = [],
} = {}) {
    if (!enabled) {
        // Not just skipped: any leftover pending capture from a superseded
        // generation is dropped so it can never commit later.
        _pending = null;
        return;
    }
    _pending = {
        id: `ig-${++_generationSeq}`,
        mode: String(mode || 'unified'),
        trigger: trigger ?? null,
        roster: [],
        epoch: getEpoch(),
        startedAt: Date.now(),
        completedAt: null,
        calls: [],
        droppedCalls: 0,
        decisions: [],
        droppedDecisions: 0,
        ledgerBefore: _capLedger(ledgerBefore),
        ledgerAfter: null,
    };
}

/** @returns {boolean} whether a generation capture is in flight */
export function isIntentionsCaptureActive() {
    return _pending != null;
}

/**
 * Record the turn's roster once it is built (the capture begins before the
 * dormant poll, which precedes roster building). No-op when inactive.
 * @param {string[]} roster
 */
export function noteIntentionsCaptureRoster(roster) {
    if (!_pending) return;
    _pending.roster = Array.isArray(roster) ? roster.map(String) : [];
}

// ─── Constituent calls ────────────────────────────────────────────────────────

/** Inert stand-in returned when nothing is being captured. */
const _noopCall = { attempt() {}, finish() {} };

/**
 * Attach a constituent API call to the in-flight generation capture.
 *
 * `kind` is the call's role and must stay stable — the commit rule reads it:
 *   - 'intentions'    — this call carries the intentions contract (the
 *                       unified call when intentions are on, the split
 *                       intentions call, each strict per-NPC call)
 *   - 'thoughts'      — thoughts-only call (the split thoughts side, or a
 *                       unified call with intentions disabled)
 *   - 'dormant_poll'  — the §20 lazy wake poll
 *
 * @returns {{ attempt(info?:object):void, finish(info?:object):void }} a
 *   recorder handle; inert when no capture is active
 */
export function noteIntentionsCaptureCall({
    kind = 'intentions', label = '', npc = null, systemPrompt = '', userContent = '',
} = {}) {
    if (!_pending) return _noopCall;
    if (_pending.calls.length >= CAPTURE_MAX_CALLS) {
        _pending.droppedCalls += 1;
        return _noopCall;
    }
    const call = {
        kind: String(kind || 'intentions'),
        label: String(label || ''),
        npc: npc == null ? null : String(npc),
        systemPrompt: _capText(systemPrompt),
        userContent: _capText(userContent),
        attempts: [],
        parsed: null,
        cancelled: false,
    };
    _pending.calls.push(call);
    return {
        attempt(info = {}) {
            if (call.attempts.length >= CAPTURE_MAX_ATTEMPTS_PER_CALL) return;
            call.attempts.push({
                ok: info.ok === true,
                rawResponse: _capText(info.rawResponse),
                normalisedResponse: _capText(info.normalisedResponse),
                error: info.error == null ? null : _capText(info.error),
            });
        },
        finish(info = {}) {
            call.parsed = info.parsed === true;
            call.cancelled = info.cancelled === true;
        },
    };
}

// ─── Validation decisions ─────────────────────────────────────────────────────

/**
 * Record one validateAndApply decision: accepted / rejected / ignored, with a
 * stable machine-readable reason. No-op when no capture is active.
 *
 * @param {object} decision
 * @param {string} decision.npc - roster spelling of the deciding block
 * @param {string} decision.kind - 'executed' | 'dropped' | 'new_intention' | 'block'
 * @param {string} decision.outcome - 'accepted' | 'rejected' | 'ignored'
 * @param {string|null} [decision.reason] - e.g. 'grace-period', 'wrong-owner',
 *   'unknown-id', 'dormant-id', 'duplicate', 'replayed-this-response',
 *   'cap-reached', 'missing-action-or-trigger', 'not-in-roster',
 *   'player-character', 'duplicate-block'
 */
export function noteIntentionsCaptureDecision(decision = {}) {
    if (!_pending) return;
    if (_pending.decisions.length >= CAPTURE_MAX_DECISIONS) {
        _pending.droppedDecisions += 1;
        return;
    }
    _pending.decisions.push({
        npc: String(decision.npc ?? ''),
        kind: String(decision.kind ?? ''),
        outcome: String(decision.outcome ?? ''),
        reason: decision.reason == null ? null : String(decision.reason),
        id: decision.id == null ? null : String(decision.id),
        action: decision.action == null ? null : _capText(decision.action).slice(0, 500),
        trigger: decision.trigger == null ? null : _capText(decision.trigger).slice(0, 500),
    });
}

// ─── Commit / clear / read ────────────────────────────────────────────────────

/**
 * Complete the in-flight generation capture. No pending capture → no-op.
 *
 * Commit rules:
 *  - the scope epoch changed mid-generation (chat switch) → discard, never
 *    commit another chat's evidence;
 *  - the generation attempted no 'intentions' call (thoughts-only or
 *    dormant-poll-only) → discard the pending capture, KEEP the previously
 *    committed snapshot — a thoughts-only split response must never
 *    overwrite intentions evidence;
 *  - otherwise → replace the stored snapshot (latest generation only) and
 *    echo one metadata-only summary into the ordinary diagnostics ring.
 *
 * @param {object} [opts]
 * @param {Array|null} [opts.ledgerAfter] - the live ledger after the turn's
 *   mutations (the caller passes getLedger())
 * @returns {object|null} a detached copy of the committed snapshot, or null
 */
export function completeIntentionsGenerationCapture({ ledgerAfter = null } = {}) {
    if (!_pending) return null;
    const pending = _pending;
    _pending = null;

    // Chat-switch guard: this evidence belongs to another chat.
    if (pending.epoch !== getEpoch()) return null;

    pending.completedAt = Date.now();
    pending.ledgerAfter = _capLedger(ledgerAfter);

    if (!pending.calls.some(c => c.kind === 'intentions')) {
        // Thoughts-only / dormant-poll-only generation — see commit rules.
        return null;
    }

    _committed = { ...pending, counts: _summarize(pending) };

    // Metadata-only ring echo (the ordinary ring NEVER carries bodies):
    // the reference the ring gets is this event, not the snapshot itself.
    record({
        level: 'info',
        module: 'interiority',
        event: 'intentions_capture',
        detail: {
            generationId: _committed.id,
            mode: _committed.mode,
            calls: _committed.counts.calls,
            callsByKind: _committed.counts.callsByKind,
            decisions: _committed.counts.decisions,
            decisionsByOutcome: _committed.counts.decisionsByOutcome,
            ledgerBefore: _committed.ledgerBefore.total,
            ledgerAfter: _committed.ledgerAfter.total,
        },
    });

    return getIntentionsCaptureSnapshot();
}

/** Clear both the in-flight and committed captures (chat switch, tests). */
export function clearIntentionsCapture() {
    _pending = null;
    _committed = null;
}

/**
 * Read the committed snapshot as a detached copy. Stale-scope snapshots
 * (epoch changed since commit — e.g. a chat switch that somehow bypassed the
 * explicit clear) are lazily discarded.
 * @returns {object|null}
 */
export function getIntentionsCaptureSnapshot() {
    if (!_committed) return null;
    if (_committed.epoch !== getEpoch()) {
        _committed = null;
        return null;
    }
    return JSON.parse(JSON.stringify(_committed));
}

// ─── Report surface ───────────────────────────────────────────────────────────

/**
 * The Copy Report section shape: `meta` (telemetry-safe: counts, mode, ids —
 * visible even with the content opt-in off) + `payload` (prompts, raw
 * responses, roster names, ledger entries, decision text). `payload` is a
 * CONTENT_KEYS member (core/redaction.js), so the report's redaction layer
 * gates the whole evidence body behind the explicit include-content opt-in.
 * The roster is NAMES — chat-derived content — so it lives under `payload`
 * with the bodies; `meta` carries only its numeric size (`rosterCount`).
 *
 * @returns {object} `{ meta }` when nothing is captured, else `{ meta, payload }`
 */
export function collectIntentionsCaptureSection() {
    const snapshot = getIntentionsCaptureSnapshot();
    if (!snapshot) return { meta: { available: false } };
    return {
        meta: {
            available: true,
            generationId: snapshot.id,
            mode: snapshot.mode,
            trigger: snapshot.trigger,
            // The roster itself is content (NPC names) — only its SIZE is
            // telemetry. The names sit under `payload.roster`, behind the
            // include-content opt-in (plus the `roster` CONTENT_KEYS backstop).
            rosterCount: Array.isArray(snapshot.roster) ? snapshot.roster.length : 0,
            startedAt: snapshot.startedAt,
            completedAt: snapshot.completedAt,
            epoch: snapshot.epoch,
            counts: snapshot.counts,
        },
        payload: {
            roster: snapshot.roster,
            calls: snapshot.calls,
            ledgerBefore: snapshot.ledgerBefore,
            ledgerAfter: snapshot.ledgerAfter,
            decisions: snapshot.decisions,
            droppedCalls: snapshot.droppedCalls,
            droppedDecisions: snapshot.droppedDecisions,
        },
    };
}

// ─── Test-only seams ──────────────────────────────────────────────────────────

/**
 * Wipe all capture state. @internal — test isolation only; production code
 * must use clearIntentionsCapture().
 */
export function _resetIntentionsCapture() {
    clearIntentionsCapture();
    _generationSeq = 0;
}



