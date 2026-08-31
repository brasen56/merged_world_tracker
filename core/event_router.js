/**
 * core/event_router.js — SillyTavern message-event routing.
 *
 * Extracted from index.js so the per-module dispatch decision is a pure,
 * unit-testable function instead of inline event-handler glue (mirroring how
 * core/commands.js keeps slash-command routing testable).
 *
 * This is a LEAF module: it has no SillyTavern / core dependencies, so it can
 * be imported directly by tests (no stub needed).
 *
 * Two contract guarantees this module enforces:
 *
 *  1. PANIC-COUNTER-SYMMETRY — when the panic switch (injectionMasterOff) is
 *     on, the counter INCREMENT in MESSAGE_RECEIVED and the counter DECREMENT
 *     in MESSAGE_DELETED are BOTH suppressed by threading a flag into each
 *     module's handler — { countMessage } on receive, { adjustCounters } on
 *     delete — NOT by skipping the call. Both events always call through, so
 *     lastChatLength bookkeeping (and provenance / anchor invalidation on
 *     delete) stay live on both sides. This keeps the cadence symmetric
 *     (panic-window messages aren't counted on receive, un-counted messages
 *     aren't un-counted on delete) WITHOUT freezing lastChatLength or skipping
 *     integrity. Interiority is the exception on receive: it only generates,
 *     with no bookkeeping to preserve, so it stays gated by the panic switch.
 *
 *  2. INTERIORITY-04 — Interiority cleanup (delete/swipe/edit) is NEVER gated
 *     by the panic switch: rolling back the ledger and dropping orphaned
 *     per-message metadata must keep running during a panic-off window.
 *     Interiority owns no auto-trigger counter, so leaving it ungated cannot
 *     drift a cadence — it only ensures cleanup.
 */

/**
 * Normalize a SillyTavern event argument into a chat-array index.
 *
 * ST versions disagree on the payload shape: some pass a bare number, some
 * pass an object ({ messageId } / { index }), and older builds pass nothing.
 *
 * @param {*} arg — the raw event argument
 * @returns {number|null}
 */
export function extractMessageIndex(arg) {
    if (typeof arg === 'number') return arg;
    if (arg && typeof arg === 'object') {
        if (typeof arg.messageId === 'number') return arg.messageId;
        if (typeof arg.index === 'number') return arg.index;
    }
    return null;
}

// ─── Part 6: the schema-pause decline predicate ───────────────────────────────
//
// A module whose store is blocked by the runtime schema gate DECLINES its own
// message-event work and says so; every other module keeps running (design
// §7.4 — blocking is per store, never global, and message events are never
// queued or discarded). This module stays a pure leaf, so the decision is
// INJECTED: index.js wires `decline` to core/schema_status.js's
// isModulePausedForCurrentScope() against its own module keys; callers that
// pass nothing (every existing caller) behave exactly as before.

/**
 * @param {function(string): boolean} [decline] — optional per-module predicate
 *   on the router's module keys ('WorldState', 'Chronicle', 'Knowledge',
 *   'StoryPlanner', 'Interiority')
 * @returns {function(string): boolean}
 */
function declineGuard(decline) {
    if (typeof decline !== 'function') return () => false;
    return (key) => Boolean(decline(key));
}

/** Log one declined dispatch — "declines its own work and says so" (§7.4). */
function logDecline(eventName, moduleKey) {
    console.log(`[MWT] ${moduleKey} declined ${eventName} — its store is paused for this chat; the saved data was left unchanged.`);
}

/**
 * Dispatch a MESSAGE_RECEIVED event to the modules that should react to it.
 *
 * PANIC-COUNTER-SYMMETRY: the decision is THREADED as a flag (`countMessage`),
 * not made by skipping the call. Each counter module's onMessageReceived does
 * at least two jobs — lastChatLength bookkeeping (so onMessageDeleted can
 * compute the bulk-delete `removed` count from a live length) and counting +
 * generation. Only the counting + generation is gated by the panic switch;
 * bookkeeping must stay live, otherwise lastChatLength freezes during a panic
 * window and the first post-panic delete computes a lumped `removed`. This is
 * the mirror of routeMessageDeleted's `adjustCounters` flag.
 *
 * Interiority is the exception: it only generates on receive (no bookkeeping to
 * preserve), so it stays gated by the panic switch rather than receiving a flag.
 *
 * Part 6: a module whose store is paused by the runtime schema gate declines
 * the whole dispatch (§7.4) — the write seam would refuse its persist anyway,
 * and declining keeps the module from spending a generation on data it cannot
 * trust. Other modules are untouched.
 *
 * @param {object} modules — { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority }
 * @param {object} settings — the global settings object (read-only here)
 * @param {number|null} messageIndex — resolved index of the received message
 * @param {function(string): boolean} [decline] — optional schema-pause predicate
 *   on the module keys (see declineGuard above); absent = nobody declines
 */
export function routeMessageReceived(modules, settings, messageIndex, decline = null) {
    // Gate per-module: disabled trackers stop scanning / counting toward
    // auto-refresh & auto-snapshot thresholds (no silent background API calls).
    const declined = declineGuard(decline);
    const countMessage = !settings.injectionMasterOff;
    if (settings.enableWorldState !== false) {
        if (declined('WorldState')) logDecline('MESSAGE_RECEIVED', 'WorldState');
        else modules.WorldState.onMessageReceived({ countMessage });
    }
    if (settings.enableChronicle  !== false) {
        if (declined('Chronicle')) logDecline('MESSAGE_RECEIVED', 'Chronicle');
        else modules.Chronicle.onMessageReceived({ countMessage });
    }
    if (settings.enableKnowledge  !== false) {
        if (declined('Knowledge')) logDecline('MESSAGE_RECEIVED', 'Knowledge');
        else modules.Knowledge.onMessageReceived({ countMessage });
    }
    if (settings.enableStoryPlanner !== false) {
        if (declined('StoryPlanner')) logDecline('MESSAGE_RECEIVED', 'StoryPlanner');
        else modules.StoryPlanner.onMessageReceived({ countMessage });
    }
    // Interiority gets the message index so the generation targets the message
    // that fired the event, not whatever is last when the queued work runs. It
    // owns no counter and no lastChatLength bookkeeping, so it is the one
    // receive handler that genuinely SHOULD be skipped during a panic window.
    if (countMessage && settings.enableInteriority !== false) {
        if (declined('Interiority')) logDecline('MESSAGE_RECEIVED', 'Interiority');
        else modules.Interiority.onMessageReceived(messageIndex);
    }
}

/**
 * Dispatch a MESSAGE_DELETED event to the modules that should react to it.
 *
 * PANIC-COUNTER-SYMMETRY: the decision is THREADED as a flag
 * (`adjustCounters`), not made by skipping the call. Each counter module's
 * onMessageDeleted does three jobs — counter decrement, lastChatLength
 * bookkeeping, and integrity work (provenance / anchor invalidation). Only the
 * counter decrement is gated by the panic switch; bookkeeping and integrity
 * must stay live, otherwise the drift is deferred-and-lumped on the first
 * post-panic delete and stale-index bugs (WORLD-STATE-05) reopen inside the
 * panic window.
 *
 * Interiority cleanup is never gated (INTERIORITY-04) and receives no flag —
 * it owns no counter to adjust.
 *
 * @param {object} modules — { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority }
 * @param {object} settings — the global settings object (read-only here)
 * @param {number|null} deletedIndex — resolved index of the removed message
 * @param {function(string): boolean} [decline] — optional schema-pause predicate
 *   on the module keys (see declineGuard above); absent = nobody declines
 */
export function routeMessageDeleted(modules, settings, deletedIndex, decline = null) {
    const declined = declineGuard(decline);
    const adjustCounters = !settings.injectionMasterOff;
    if (settings.enableWorldState !== false) {
        if (declined('WorldState')) logDecline('MESSAGE_DELETED', 'WorldState');
        else modules.WorldState.onMessageDeleted(deletedIndex, { adjustCounters });
    }
    if (settings.enableChronicle  !== false) {
        if (declined('Chronicle')) logDecline('MESSAGE_DELETED', 'Chronicle');
        else modules.Chronicle.onMessageDeleted(deletedIndex, { adjustCounters });
    }
    if (settings.enableKnowledge  !== false) {
        if (declined('Knowledge')) logDecline('MESSAGE_DELETED', 'Knowledge');
        else modules.Knowledge.onMessageDeleted(deletedIndex, { adjustCounters });
    }
    if (settings.enableStoryPlanner !== false) {
        if (declined('StoryPlanner')) logDecline('MESSAGE_DELETED', 'StoryPlanner');
        else modules.StoryPlanner.onMessageDeleted(deletedIndex, { adjustCounters });
    }
    // INTERIORITY-04: ledger / per-message cleanup must keep running while
    // injection is off, so a delete during a panic-off window never leaves
    // orphaned thought metadata or an un-rolled-back ledger. A SCHEMA pause is
    // the one thing that outranks it: the per-message map IS the unprepared
    // store (Part 6 §7.4), and a paused module declines its own work.
    if (settings.enableInteriority !== false) {
        if (declined('Interiority')) logDecline('MESSAGE_DELETED', 'Interiority');
        else modules.Interiority.onMessageDeleted(deletedIndex);
    }
}

/**
 * Dispatch a MESSAGE_SWIPED event. Cleanup always runs — never gated by the
 * panic switch (no counter to drift; INTERIORITY-04 keeps ledger rollback
 * live). Interiority MAY follow its cleanup with a regeneration (swipe
 * navigation on the last message); that GENERATION is gated inside
 * generateForCurrentMessage (interiority/index.js), not here, so the panic
 * switch stops the API call without suppressing rollback.
 *
 * @param {object} modules — { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority }
 *   (only WorldState, Chronicle, and Interiority have swipe handlers)
 * @param {object} settings — the global settings object (read-only here)
 * @param {number|null} swipedIndex — resolved index of the swiped message
 * @param {function(string): boolean} [decline] — optional schema-pause predicate
 *   on the module keys (see declineGuard above); absent = nobody declines
 */
export function routeMessageSwiped(modules, settings, swipedIndex, decline = null) {
    const declined = declineGuard(decline);
    if (settings.enableWorldState !== false) {
        if (declined('WorldState')) logDecline('MESSAGE_SWIPED', 'WorldState');
        else modules.WorldState.onMessageSwiped(swipedIndex);
    }
    if (settings.enableChronicle  !== false) {
        if (declined('Chronicle')) logDecline('MESSAGE_SWIPED', 'Chronicle');
        else modules.Chronicle.onMessageSwiped(swipedIndex);
    }
    if (settings.enableInteriority !== false) {
        if (declined('Interiority')) logDecline('MESSAGE_SWIPED', 'Interiority');
        else modules.Interiority.onMessageSwiped(swipedIndex);
    }
}

/**
 * Dispatch a MESSAGE_EDITED event. Cleanup always runs — never gated by the
 * panic switch (no counter to drift; INTERIORITY-04 keeps ledger rollback
 * live). Interiority MAY follow its cleanup with a regeneration (edit of the
 * last message); that GENERATION is gated inside generateForCurrentMessage
 * (interiority/index.js), not here, so the panic switch stops the API call
 * without suppressing rollback.
 *
 * @param {object} modules — { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority }
 *   (only WorldState, Chronicle, and Interiority have edit handlers)
 * @param {object} settings — the global settings object (read-only here)
 * @param {number|null} editedIndex — resolved index of the edited message
 * @param {function(string): boolean} [decline] — optional schema-pause predicate
 *   on the module keys (see declineGuard above); absent = nobody declines
 */
export function routeMessageEdited(modules, settings, editedIndex, decline = null) {
    const declined = declineGuard(decline);
    if (settings.enableWorldState !== false) {
        if (declined('WorldState')) logDecline('MESSAGE_EDITED', 'WorldState');
        else modules.WorldState.onMessageEdited(editedIndex);
    }
    if (settings.enableChronicle  !== false) {
        if (declined('Chronicle')) logDecline('MESSAGE_EDITED', 'Chronicle');
        else modules.Chronicle.onMessageEdited(editedIndex);
    }
    if (settings.enableInteriority !== false) {
        if (declined('Interiority')) logDecline('MESSAGE_EDITED', 'Interiority');
        else modules.Interiority.onMessageEdited(editedIndex);
    }
}
