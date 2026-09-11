/**
 * interiority/lifecycle.js — persistent lifecycle substrate.
 *
 * Deferred lifecycle work (INTERIORITY_LIFECYCLE_IMPLEMENTATION_PLAN.md §4 /
 * TODO.md §3-F). Record shape, retention caps, rollback semantics, ownership
 * rules, and backup merge/replace behavior are specified in
 * archive/completed_plans/INTERIORITY_LIFECYCLE_V2_SPEC.md — this module is the
 * implementation of §2–§5 of that spec:
 *
 *   lifecycleHistory   — bounded, occurrence-specific engine/user lifecycle
 *                        event log (completion, drop, expiration, sleep,
 *                        wake, reopening, merge) — separate from user
 *                        deletion tombstones, which remain the permanent
 *                        refusal mechanism in interiority/data.js.
 *   cross-turn dedup   — conservative comparison of NEW proposals against
 *                        recent closures, keyed on canonical NPC identity +
 *                        outcome/occasion text. Bounded by a turn window so a
 *                        later independently motivated repetition stays legal.
 *   evidenceBoundaries — per-NPC watermark of the last successful intentions
 *                        evaluation commit.
 *   npcControls        — per-NPC privacy exclusion and creation-only cost
 *                        controls (pause / cooldown / active cap).
 *
 * Layering: imports interiority/data.js (never the reverse — data.js is the
 * leaf) and the leaf core modules directly, the same rule data.js applies to
 * the write seam, so the REAL diagnostics module is read even under the test
 * barrel→stub alias.
 */

import { record } from '../core/diagnostics.js';
import {
    getInteriorityData, saveInteriorityData,
    getLedger, addLedgerEntry, updateLedgerEntry, removeLedgerEntries,
    wakeLedgerEntry, setLedgerEntryDormant,
    getTurnCounter, getSettings, getWorldTime,
} from './data.js';
import { LIFECYCLE_OUTCOMES, LIFECYCLE_SOURCES, MAX_LIFECYCLE_EVENTS } from './schema.js';

// ─── Bounds & vocabulary ──────────────────────────────────────────────────────

/**
 * Retention cap for the lifecycle history (spec §2). Oldest trimmed first.
 *
 * Owned by interiority/schema.js — the leaf that also ENFORCES it in the
 * validator — and re-exported here so the panel reads the same definition the
 * writer and the validator use. A second literal would let the trim bound and
 * the validation bound drift apart silently.
 */
export { MAX_LIFECYCLE_EVENTS };

/** Default cross-turn closure dedup window (spec §2). 0 disables the guard. */
export const DEFAULT_LIFECYCLE_DEDUP_TURNS = 8;

/** Outcomes that CLOSE an occurrence (the dedup-relevant set). */
const CLOSURE_OUTCOMES = new Set(['completed', 'dropped', 'expired', 'merged']);

/** Conservative similarity thresholds (spec §2 item 4). */
const ACTION_SIMILARITY_THRESHOLD = 0.85;
const TRIGGER_SIMILARITY_STRICT = 0.7;
const TRIGGER_SIMILARITY_LOOSE = 0.5;

/** Replaces dossier-derived context for a privacy-excluded NPC (spec §5). */
export const PRIVACY_WITHHELD_NOTE = '(Dossier withheld by a privacy control — rely on recent messages and the intention lists only.)';

/**
 * Dice coefficient over token sets — the same conservative family as
 * data.js's inner-state drift check. 1.0 = identical token sets; 0 = disjoint.
 * Word-order changes score high; different word choices score low.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function tokenSimilarity(a, b) {
    const tokens = (text) => new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean));
    const setA = tokens(a);
    const setB = tokens(b);
    if (setA.size === 0 || setB.size === 0) return setA.size === setB.size ? 1 : 0;
    let shared = 0;
    for (const token of setA) {
        if (setB.has(token)) shared++;
    }
    return (2 * shared) / (setA.size + setB.size);
}


// ─── Lifecycle history (spec §2) ──────────────────────────────────────────────

/**
 * Read the lifecycle history (detached working copy from the store seam).
 * @returns {Array<object>}
 */
export function getLifecycleHistory() {
    return getInteriorityData().lifecycleHistory;
}

/**
 * Clear every lifecycle record (user panel action). Tombstones untouched —
 * they are a different mechanism with a different guarantee.
 * @returns {number} how many records were removed
 */
export function clearLifecycleHistory() {
    const data = getInteriorityData();
    const count = data.lifecycleHistory.length;
    if (count === 0) return 0;
    data.lifecycleHistory = [];
    saveInteriorityData(data);
    return count;
}

/** Generate a lifecycle record id: 'lc-' + base36 ts + seq + rand. */
let _lifecycleSeq = 0;
function generateLifecycleId() {
    _lifecycleSeq = (_lifecycleSeq + 1) % 1296;
    return `lc-${Date.now().toString(36)}${_lifecycleSeq.toString(36)}${Math.random().toString(16).slice(2, 6)}`;
}

/**
 * Append one lifecycle event to the bounded history.
 *
 * The one writer for the whole substrate — engine passes
 * (generation.validateAndApply) and user actions (interiority/render.js) both
 * land here, so bounding, vocabulary, and the diagnostics reason breadcrumb
 * can never drift between sources.
 *
 * @param {object} event
 * @param {string} event.npc - NPC name at event time
 * @param {string} event.action - entry action text at event time
 * @param {string} [event.trigger] - entry trigger text at event time
 * @param {string} event.outcome - one of LIFECYCLE_OUTCOMES
 * @param {string} [event.source='engine'] - 'engine' | 'user'
 * @param {string} [event.reason] - free-text reason (model drop reason, user note)
 * @param {string} [event.entryId] - ledger entry id at event time
 * @param {number} [event.turn] - generation turn (defaults to the live counter)
 * @param {string} [event.supersededBy] - kept entry id ('merged' only)
 * @param {string} [event.reopenedFrom] - reopened closure record id ('reopened' only)
 * @returns {object|null} the stored record, or null when inputs are invalid
 */
export function recordLifecycleEvent({
    npc, action, trigger = '', outcome, source = 'engine', reason = '',
    entryId = '', turn = null, supersededBy = '', reopenedFrom = '',
} = {}) {
    if (!LIFECYCLE_OUTCOMES.includes(outcome) || !LIFECYCLE_SOURCES.includes(source)) return null;
    const npcText = String(npc ?? '').trim();
    const actionText = String(action ?? '').trim();
    if (!npcText || !actionText) return null;

    const data = getInteriorityData();
    const stored = {
        id: generateLifecycleId(),
        entryId: String(entryId ?? ''),
        npc: npcText,
        action: actionText,
        trigger: String(trigger ?? ''),
        outcome,
        source,
        reason: String(reason ?? '').slice(0, 300),
        turn: Number.isFinite(turn) ? turn : getTurnCounter(),
        at: Date.now(),
    };
    if (supersededBy) stored.supersededBy = String(supersededBy);
    if (reopenedFrom) stored.reopenedFrom = String(reopenedFrom);

    data.lifecycleHistory.push(stored);
    if (data.lifecycleHistory.length > MAX_LIFECYCLE_EVENTS) {
        data.lifecycleHistory.splice(0, data.lifecycleHistory.length - MAX_LIFECYCLE_EVENTS);
    }
    saveInteriorityData(data);

    // Readable diagnostics reason (ring contract: metadata only — outcome,
    // source, ids, turn; the text stays in the store/panel, never the ring).
    record({
        level: 'info',
        module: 'interiority',
        event: 'intention_lifecycle',
        detail: { outcome, source, entryId: stored.entryId, id: stored.id, turn: stored.turn },
    });
    return stored;
}

/**
 * Is a closure record still ACTIVE for dedup purposes — i.e. does it close an
 * occurrence that has not been reopened since? A non-closure outcome (slept,
 * woken) is never a dedup key: the entry it describes is still open.
 *
 * @param {object} event - lifecycle record
 * @param {Array<object>} [history] - the history to search for a matching
 *   'reopened' event (defaults to the live history)
 * @returns {boolean}
 */
export function isClosureActive(event, history = null) {
    if (!event || !CLOSURE_OUTCOMES.has(event.outcome)) return false;
    const records = Array.isArray(history) ? history : getLifecycleHistory();
    return !records.some(other => other.outcome === 'reopened' && other.reopenedFrom === event.id);
}

/**
 * Conservative cross-turn duplicate comparison (spec §2): does `action` +
 * `trigger` for `npc` match a recent ACTIVE closure for the same canonical NPC?
 *
 * @param {string} npc - the proposal's NPC (roster spelling)
 * @param {string} action
 * @param {string} trigger
 * @param {object} [opts]
 * @param {function(string): (string|null)} [opts.resolveNpc] - roster resolver
 *   mapping stored npc spellings to the canonical roster name (the same
 *   resolver the executed/dropped owner check uses)
 * @param {number|null} [opts.turn] - current turn (defaults to the counter)
 * @param {number|null} [opts.windowTurns] - dedup window override (defaults to
 *   the lifecycleDedupTurns setting; 0 disables → always null)
 * @returns {{ record: object, actionSimilarity: number, triggerSimilarity: number }|null}
 */
export function findRecentClosureMatch(npc, action, trigger, { resolveNpc = null, turn = null, windowTurns = null } = {}) {
    const window = windowTurns !== null
        ? windowTurns
        : Math.max(0, Number(getSettings().lifecycleDedupTurns ?? DEFAULT_LIFECYCLE_DEDUP_TURNS) || 0);
    if (window === 0) return null;
    const turnNow = Number.isFinite(turn) ? turn : getTurnCounter();
    const proposalNpc = String(npc ?? '').trim().toLowerCase();
    const proposalAction = String(action ?? '').trim().toLowerCase();
    const proposalTrigger = String(trigger ?? '').trim().toLowerCase();
    if (!proposalNpc || !proposalAction) return null;

    const history = getLifecycleHistory();
    for (let i = history.length - 1; i >= 0; i--) {
        const closure = history[i];
        if (!CLOSURE_OUTCOMES.has(closure.outcome)) continue;
        // Occurrence window: only closures recorded within the window suppress.
        if (turnNow - (Number(closure.turn) || 0) > window) continue;
        // Canonical NPC identity through the caller's roster resolver.
        const closureNpcRaw = String(closure.npc ?? '').trim();
        const closureNpc = resolveNpc ? (resolveNpc(closureNpcRaw) ?? closureNpcRaw) : closureNpcRaw;
        if (closureNpc.trim().toLowerCase() !== proposalNpc) continue;
        // Reopened closures no longer suppress (the plan is live again).
        if (!isClosureActive(closure, history)) continue;

        const closureAction = String(closure.action ?? '').trim().toLowerCase();
        const closureTrigger = String(closure.trigger ?? '').trim().toLowerCase();
        const actionSim = tokenSimilarity(proposalAction, closureAction);
        const triggerSim = tokenSimilarity(proposalTrigger, closureTrigger);
        const exactAction = proposalAction === closureAction;
        const matches = (exactAction && triggerSim >= TRIGGER_SIMILARITY_LOOSE)
            || (actionSim >= ACTION_SIMILARITY_THRESHOLD && triggerSim >= TRIGGER_SIMILARITY_STRICT);
        if (matches) {
            return { record: closure, actionSimilarity: actionSim, triggerSimilarity: triggerSim };
        }
    }
    return null;
}

// ─── Evidence boundaries (spec §3) ────────────────────────────────────────────

/**
 * Read the evidence-boundaries map (detached working copy).
 * @returns {object} npcLower → { turn, msgIdx, msgKey, at }
 */
export function getEvidenceBoundaries() {
    return getInteriorityData().evidenceBoundaries;
}

/** Detached copy for a perMessage rollback record. */
export function getEvidenceBoundariesSnapshot() {
    return JSON.parse(JSON.stringify(getEvidenceBoundaries()));
}

/**
 * The boundary for one NPC (case-insensitive).
 * @param {string} npc
 * @returns {object|null}
 */
export function getEvidenceBoundary(npc) {
    const key = String(npc ?? '').trim().toLowerCase();
    if (!key) return null;
    return getEvidenceBoundaries()[key] ?? null;
}

/**
 * Stamp a NPC's evidence boundary — the watermark of their last SUCCESSFUL
 * intentions evaluation commit (spec §3).
 *
 * Called by generation.validateAndApply AFTER its scope assertion and only for
 * roster NPCs whose intentions the validating pass actually evaluated, so
 * thoughts-only turns, disabled-intentions turns, strict partial failures, and
 * discarded (scope-changed) results never consume evidence.
 *
 * @param {string} npc - canonical roster spelling
 * @param {number} turn - the turn the evaluation consumed (pre-increment
 *   counter, matching turnCounterAtSnapshot)
 * @param {number} msgIdx - chat-array index of the evaluated message
 * @param {string|null} [msgKey] - stable per-message key
 * @returns {object|null} the stored boundary
 */
export function stampEvidenceBoundary(npc, turn, msgIdx, msgKey = null) {
    const key = String(npc ?? '').trim().toLowerCase();
    if (!key || !Number.isFinite(turn) || turn < 0) return null;
    const data = getInteriorityData();
    data.evidenceBoundaries[key] = {
        turn,
        msgIdx: Number.isFinite(msgIdx) ? msgIdx : null,
        msgKey: msgKey ? String(msgKey) : null,
        at: Date.now(),
    };
    saveInteriorityData(data);
    return data.evidenceBoundaries[key];
}

/**
 * Restore the boundaries map from a perMessage snapshot (swipe/edit/delete
 * rollback, spec §3). Wholesale replace: boundaries are pure engine stamps —
 * the caller gates this on the same wasNewest/newest-orphan conditions as the
 * ledger snapshot restore, so later surviving generations are never clobbered.
 *
 * @param {object} snapshot
 */
export function restoreEvidenceBoundariesSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    const data = getInteriorityData();
    data.evidenceBoundaries = JSON.parse(JSON.stringify(snapshot));
    saveInteriorityData(data);
}

/** Detached copy of the engine-owned cooldown watermarks. */
export function getNpcControlWatermarksSnapshot() {
    const controls = getInteriorityData().npcControls || {};
    return Object.fromEntries(Object.entries(controls).map(([key, value]) => [
        key,
        value?.lastAcceptedTurn ?? null,
    ]));
}

/** Restore only engine-owned watermarks; user control fields remain untouched. */
export function restoreNpcControlWatermarksSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    const data = getInteriorityData();
    for (const key of Object.keys(data.npcControls || {})) {
        data.npcControls[key].lastAcceptedTurn = key in snapshot && snapshot[key] != null
            ? snapshot[key]
            : null;
    }
    saveInteriorityData(data);
}

// ─── Lifecycle rollback (spec §2 ownership rule) ──────────────────────────────

/** Detached copy of the history for a perMessage rollback record. */
export function getLifecycleHistorySnapshot() {
    return JSON.parse(JSON.stringify(getLifecycleHistory()));
}

// ─── Per-NPC controls (spec §5) ───────────────────────────────────────────────

/** The normalized default control shape (spec §5). */
const DEFAULT_NPC_CONTROL = Object.freeze({
    privacyExcluded: false,
    pauseNewProposals: false,
    cooldownTurns: 0,
    activeCap: 0,
    lastAcceptedTurn: null,
});

/**
 * Read one NPC's controls, normalized against the defaults (never null).
 * @param {string} npc
 * @returns {object} { privacyExcluded, pauseNewProposals, cooldownTurns, activeCap, lastAcceptedTurn }
 */
export function getNpcControl(npc) {
    const key = String(npc ?? '').trim().toLowerCase();
    if (!key) return { ...DEFAULT_NPC_CONTROL };
    const stored = getInteriorityData().npcControls[key];
    return { ...DEFAULT_NPC_CONTROL, ...(stored || {}) };
}

/**
 * Merge a control patch for one NPC (user panel action). Records persist
 * until explicitly removed with the row's ✕ — an "Add control" that lands on
 * all-default values must survive its own creation, and a toggled-off control
 * stays visible (and editable) rather than silently vanishing.
 * @param {string} npc
 * @param {object} patch
 * @returns {object} the stored control
 */
export function setNpcControl(npc, patch = {}) {
    const key = String(npc ?? '').trim().toLowerCase();
    if (!key) return { ...DEFAULT_NPC_CONTROL };
    const data = getInteriorityData();
    const current = { ...DEFAULT_NPC_CONTROL, ...(data.npcControls[key] || {}), ...patch };
    // Normalize: booleans coerce; numbers clamp to finite non-negative ints.
    current.privacyExcluded = current.privacyExcluded === true;
    current.pauseNewProposals = current.pauseNewProposals === true;
    for (const field of ['cooldownTurns', 'activeCap']) {
        const value = Number(current[field]);
        current[field] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }
    current.lastAcceptedTurn = current.lastAcceptedTurn == null
        ? null
        : (Number.isFinite(Number(current.lastAcceptedTurn)) ? Math.floor(Number(current.lastAcceptedTurn)) : null);

    data.npcControls[key] = current;
    saveInteriorityData(data);
    return current;
}

/**
 * Remove one NPC's control record entirely.
 * @param {string} npc
 */
export function removeNpcControl(npc) {
    const key = String(npc ?? '').trim().toLowerCase();
    if (!key) return;
    const data = getInteriorityData();
    if (!(key in data.npcControls)) return;
    delete data.npcControls[key];
    saveInteriorityData(data);
}

/**
 * Is a NEW ENGINE proposal allowed for this NPC right now (spec §5)?
 *
 * Creation-only gate: never consulted for executed/dropped evaluation, manual
 * panel entries, or anything else — an NPC whose proposals are paused still
 * has their existing plans evaluated every turn, and nothing is ever evicted
 * to satisfy a cap.
 *
 * @param {string} npc - canonical roster spelling
 * @param {object} [opts]
 * @param {number|null} [opts.turn] - current turn (defaults to the counter)
 * @returns {{ allowed: boolean, reason: null|'paused'|'cooldown'|'active-cap', detail: string }}
 */
export function checkProposalAllowed(npc, { turn = null } = {}) {
    const key = String(npc ?? '').trim().toLowerCase();
    if (!key) return { allowed: true, reason: null, detail: '' };
    const control = getNpcControl(key);
    const turnNow = Number.isFinite(turn) ? turn : getTurnCounter();

    if (control.pauseNewProposals) {
        return { allowed: false, reason: 'paused', detail: 'new proposals paused for this NPC' };
    }
    if (control.cooldownTurns > 0 && control.lastAcceptedTurn != null
        && turnNow - control.lastAcceptedTurn < control.cooldownTurns) {
        return {
            allowed: false,
            reason: 'cooldown',
            detail: `proposal cooldown: ${control.cooldownTurns - (turnNow - control.lastAcceptedTurn)} turn(s) remain`,
        };
    }
    if (control.activeCap > 0) {
        const activeEngine = getLedger().filter(
            entry => String(entry.npc ?? '').trim().toLowerCase() === key
                && entry.status !== 'dormant'
                && entry.manual !== true,
        ).length;
        if (activeEngine >= control.activeCap) {
            return {
                allowed: false,
                reason: 'active-cap',
                detail: `active engine intention cap reached (${activeEngine}/${control.activeCap})`,
            };
        }
    }
    return { allowed: true, reason: null, detail: '' };
}

/**
 * Note that an engine proposal was ACCEPTED for this NPC — arms the cooldown.
 * Manual panel entries never call this (user additions are never throttled).
 * @param {string} npc
 * @param {number|null} [turn]
 */
export function noteProposalAccepted(npc, turn = null) {
    const key = String(npc ?? '').trim().toLowerCase();
    if (!key) return;
    const turnNow = Number.isFinite(turn) ? turn : getTurnCounter();
    const control = getNpcControl(key);
    if (control.cooldownTurns <= 0 && !control.privacyExcluded && !control.pauseNewProposals && control.activeCap <= 0) {
        return; // no control record would exist — nothing to arm
    }
    setNpcControl(key, { lastAcceptedTurn: turnNow });
}

// ─── User lifecycle actions (spec §2/§4) ─────────────────────────────────────

/**
 * Close a ledger entry with an explicit USER lifecycle outcome and record the
 * audit event. No tombstone: mark-done/dismiss/expired close THIS occurrence —
 * a later independently motivated repetition stays legal (the permanent
 * refusal remains the panel ✕ delete with its tombstone).
 *
 * @param {string} id - ledger entry id
 * @param {string} outcome - 'completed' | 'dropped' | 'expired'
 * @param {string} reason - readable reason for the audit trail
 * @returns {object|null} the lifecycle record, or null when not closable
 */
export function closeLedgerEntryAs(id, outcome, reason) {
    if (!['completed', 'dropped', 'expired'].includes(outcome)) return null;
    const entry = getLedger().find(item => item.id === id);
    if (!entry) return null;
    const recorded = recordLifecycleEvent({
        npc: entry.npc,
        action: entry.action,
        trigger: entry.trigger,
        entryId: entry.id,
        outcome,
        source: 'user',
        reason,
    });
    if (!recorded) return null;
    removeLedgerEntries([id], { tombstone: false });
    return recorded;
}

/**
 * Mark an intention DONE — the user asserts it was completed on-screen.
 * @param {string} id
 * @returns {object|null}
 */
export function markLedgerEntryDone(id) {
    return closeLedgerEntryAs(id, 'completed', 'Marked done by the user.');
}

/**
 * Dismiss an intention as NO LONGER RELEVANT — the in-world "no longer
 * plausible" close (spec §4's user half of the expiry distinction).
 * @param {string} id
 * @param {string} [reason] - optional user note; default explains the close
 * @returns {object|null}
 */
export function dismissLedgerEntry(id, reason = '') {
    return closeLedgerEntryAs(id, 'dropped', String(reason || '').trim() || 'Dismissed by the user — no longer plausible.');
}

/**
 * Close an intention as EXPIRED (turn aging / story-time lapsed).
 * @param {string} id
 * @param {string} [reason]
 * @returns {object|null}
 */
export function expireLedgerEntry(id, reason = '') {
    return closeLedgerEntryAs(id, 'expired', String(reason || '').trim() || 'Expired by the user.');
}

/**
 * Merge two entries the user has confirmed describe the same plan: keep one,
 * close the other as 'merged' with a supersession link to the keeper (spec §2).
 *
 * @param {string} keepId
 * @param {string} dropId
 * @returns {object|null} the merge lifecycle record, or null
 */
export function mergeLedgerEntries(keepId, dropId) {
    if (!keepId || !dropId || keepId === dropId) return null;
    const ledger = getLedger();
    const keep = ledger.find(item => item.id === keepId);
    const drop = ledger.find(item => item.id === dropId);
    if (!keep || !drop) return null;
    const recorded = recordLifecycleEvent({
        npc: drop.npc,
        action: drop.action,
        trigger: drop.trigger,
        entryId: drop.id,
        outcome: 'merged',
        source: 'user',
        reason: 'Merged with a duplicate intention by the user.',
        supersededBy: keep.id,
    });
    if (!recorded) return null;
    removeLedgerEntries([drop.id], { tombstone: false });
    return recorded;
}

/**
 * Explicitly REOPEN a closed plan: create a fresh ACTIVE ledger entry from a
 * lifecycle closure record and mark that closure reopened (which also clears
 * it as a dedup key — the plan is live again).
 *
 * The reopened entry is user-owned (`manual: true`): the user vouched for it,
 * so it survives rollback and is never auto-expired by the global turn cap.
 *
 * @param {string} historyId - lifecycle record id
 * @returns {object|null} the new ledger entry, or null when not reopenable
 */
export function reopenFromLifecycle(historyId) {
    const history = getLifecycleHistory();
    const closure = history.find(item => item.id === historyId);
    if (!closure || !CLOSURE_OUTCOMES.has(closure.outcome)) return null;
    if (!isClosureActive(closure, history)) return null; // already reopened

    const created = addLedgerEntry({
        npc: closure.npc,
        action: closure.action,
        trigger: closure.trigger,
        reopenedFrom: closure.id,
    }, getWorldTime(), null);
    // addLedgerEntry's committed value is a detached clone — mark the STORED
    // copy user-owned through the update seam (empty patch = manual + save).
    updateLedgerEntry(created.id, {});
    const entry = getLedger().find(item => item.id === created.id) || created;

    recordLifecycleEvent({
        npc: closure.npc,
        action: closure.action,
        trigger: closure.trigger,
        entryId: entry.id,
        outcome: 'reopened',
        source: 'user',
        reason: `Reopened by the user (${closure.outcome} at turn ${closure.turn}).`,
        reopenedFrom: closure.id,
    });
    return entry;
}

/**
 * Sleep/wake with lifecycle recording — the user-action wrappers the panel
 * uses. Engine wake commitments (validateAndApply) call wakeLedgerEntry
 * directly and record their own 'woken' events with the turn context.
 */
export function sleepLedgerEntryTracked(id, wakeHint = undefined) {
    const entry = setLedgerEntryDormant(id, wakeHint);
    if (!entry) return null;
    recordLifecycleEvent({
        npc: entry.npc, action: entry.action, trigger: entry.trigger, entryId: entry.id,
        outcome: 'slept', source: 'user',
        reason: wakeHint ? `Scheduled by the user — watching for: ${String(wakeHint).slice(0, 200)}` : 'Scheduled by the user.',
    });
    return entry;
}

// ─── Turn-aging expiry pass (spec §4) ─────────────────────────────────────────

/**
 * Close entries whose generation-turn age reached their expiry (engine pass).
 *
 * The global `intentionMaxTurnsOpen` cap applies to ENGINE entries only — a
 * user-authored plan is never auto-evicted (spec §5's ownership rule). A
 * per-entry `expiresTurn` set from the panel applies to that entry regardless
 * of authorship: setting it was an explicit user decision. Dormant entries
 * never accrue age (data.js incrementLedgerAges) and are skipped here too.
 *
 * Called from validateAndApply immediately after incrementLedgerAges, so the
 * comparison already includes the current turn.
 *
 * @param {number} msgIdx - evaluated message index (audit stamp)
 * @returns {Array<object>} the expiry lifecycle records created this pass
 */
export function expireOverdueEngineEntries(msgIdx) {
    const cap = Math.max(0, Number(getSettings().intentionMaxTurnsOpen ?? 0) || 0);
    const expired = [];
    const ledger = getLedger();
    for (const entry of ledger) {
        if (entry.status === 'dormant') continue;
        const limit = Number.isFinite(Number(entry.expiresTurn)) && Number(entry.expiresTurn) >= 1
            ? Math.floor(Number(entry.expiresTurn))
            : (entry.manual === true ? 0 : cap);
        if (limit === 0) continue;
        if ((Number(entry.turnsOpen) || 0) < limit) continue;
        const recorded = recordLifecycleEvent({
            npc: entry.npc,
            action: entry.action,
            trigger: entry.trigger,
            entryId: entry.id,
            outcome: 'expired',
            source: 'engine',
            reason: entry.expiresTurn
                ? `Reached its per-entry turn limit (${limit}).`
                : `Aged out after ${limit} open turns (max-turns setting).`,
        });
        if (recorded) {
            expired.push(recorded);
            console.log(`[MWT:Interiority] Intention ${entry.id} (${entry.npc}) expired — turn ${recorded.turn}, msg ${msgIdx}.`);
        }
    }
    if (expired.length > 0) {
        removeLedgerEntries(expired.map(evt => evt.entryId), { tombstone: false });
    }
    return expired;
}

// ─── Conflict detection (spec §2 / TODO §3-F) ─────────────────────────────────

/**
 * Deterministic potential-conflict pairs among a NPC's ACTIVE intentions.
 *
 * Two shapes, both advisory (panel display + merge offer — nothing is
 * auto-closed):
 *  - 'duplicate': action AND trigger both near-identical — the same plan
 *    recorded twice (the merge candidate).
 *  - 'occasion': actions clearly DIFFERENT but triggers near-identical — two
 *    plans competing for the same story moment.
 *
 * Comparison is within same-lowercased-NPC groups only, so roster-size is the
 * bound (the ledger stays small; O(n²) inside a group is trivially cheap).
 *
 * @param {Array<object>} [ledger] - defaults to the live ledger
 * @returns {Array<{ type: 'duplicate'|'occasion', npc: string, keepId: string, dropId: string }>}
 *   keep/drop ids are unordered (display decides); ids are entry ids
 */
export function findLifecycleConflicts(ledger = null) {
    const entries = (ledger ?? getLedger()).filter(entry => entry.status !== 'dormant');
    const byNpc = new Map();
    for (const entry of entries) {
        const key = String(entry.npc ?? '').trim().toLowerCase();
        if (!key) continue;
        if (!byNpc.has(key)) byNpc.set(key, []);
        byNpc.get(key).push(entry);
    }

    const conflicts = [];
    for (const [npcKey, group] of byNpc) {
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                const a = group[i];
                const b = group[j];
                const actionSim = tokenSimilarity(a.action, b.action);
                const triggerSim = tokenSimilarity(a.trigger, b.trigger);
                if (actionSim >= 0.85 && triggerSim >= 0.85) {
                    conflicts.push({ type: 'duplicate', npc: npcKey, keepId: a.id, dropId: b.id });
                } else if (actionSim < 0.5 && triggerSim >= 0.8) {
                    conflicts.push({ type: 'occasion', npc: npcKey, keepId: a.id, dropId: b.id });
                }
            }
        }
    }
    return conflicts;
}

export function wakeLedgerEntryTracked(id, gracePeriod = 0) {
    const before = getLedger().find(item => item.id === id);
    if (!before || before.status !== 'dormant') return wakeLedgerEntry(id, gracePeriod);
    const entry = wakeLedgerEntry(id, gracePeriod);
    if (!entry) return null;
    recordLifecycleEvent({
        npc: entry.npc, action: entry.action, trigger: entry.trigger, entryId: entry.id,
        outcome: 'woken', source: 'user', reason: 'Woken manually by the user.',
    });
    return entry;
}

/**
 * Restore the history from a perMessage snapshot (swipe/edit/delete rollback).
 *
 * Ownership rule: USER records written after the snapshot survive (the user's
 * explicit lifecycle statement must outlive the timeline it was made in — the
 * same principle as manual ledger entries in restoreLedgerSnapshot); ENGINE
 * records written after the snapshot are truncated with the rolled-back
 * generation, keeping the audit line consistent with the restored ledger.
 *
 * Surviving user records are re-appended in their original relative order at
 * the end of the restored prefix — record order is chronological by
 * construction, and a rollback is exactly the case where wall-clock order and
 * story order diverge.
 *
 * Post-snapshot records are identified by SET DIFFERENCE on the record ids,
 * never by comparing lengths: once the history reaches MAX_LIFECYCLE_EVENTS
 * every push trims an older record, so the length is pinned at the cap and a
 * length-derived count reads 0 for a turn that really did write records. That
 * is the steady state for any long chat, so a length comparison would make
 * every later swipe silently keep its engine records.
 *
 * @param {Array<object>} snapshot
 * @returns {number} how many engine records were removed
 */
export function restoreLifecycleHistorySnapshot(snapshot) {
    if (!Array.isArray(snapshot)) return 0;
    const data = getInteriorityData();
    const snapshotIds = new Set(snapshot.map(evt => evt.id));
    const post = data.lifecycleHistory.filter(evt => !snapshotIds.has(evt.id));
    // Nothing was written since the snapshot — and trimming only ever happens
    // on a push, so an empty post-set also means nothing was trimmed away.
    if (post.length === 0) return 0;
    const survivors = post.filter(evt => evt.source === 'user');
    const removed = post.length - survivors.length;
    data.lifecycleHistory = [...JSON.parse(JSON.stringify(snapshot)), ...survivors]
        .slice(-MAX_LIFECYCLE_EVENTS);
    saveInteriorityData(data);
    return removed;
}

/** Reapply user lifecycle decisions after the ledger itself is rolled back. */
export function reapplyUserLifecycleTransitions() {
    const data = getInteriorityData();
    const userEvents = data.lifecycleHistory.filter(event => event.source === 'user');
    const closed = new Set(userEvents
        .filter(event => ['completed', 'dropped', 'expired', 'merged'].includes(event.outcome))
        .map(event => event.entryId)
        .filter(Boolean));
    data.ledger = data.ledger.filter(entry => !closed.has(entry.id));
    for (const event of userEvents) {
        const entry = data.ledger.find(item => item.id === event.entryId);
        if (!entry) continue;
        if (event.outcome === 'slept') entry.status = 'dormant';
        if (event.outcome === 'woken') entry.status = 'active';
    }
    saveInteriorityData(data);
}
