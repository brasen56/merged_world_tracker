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
 * @param {object} modules — { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority }
 * @param {object} settings — the global settings object (read-only here)
 * @param {number|null} messageIndex — resolved index of the received message
 */
export function routeMessageReceived(modules, settings, messageIndex) {
    // Gate per-module: disabled trackers stop scanning / counting toward
    // auto-refresh & auto-snapshot thresholds (no silent background API calls).
    const countMessage = !settings.injectionMasterOff;
    if (settings.enableWorldState !== false) modules.WorldState.onMessageReceived({ countMessage });
    if (settings.enableChronicle  !== false) modules.Chronicle.onMessageReceived({ countMessage });
    if (settings.enableKnowledge  !== false) modules.Knowledge.onMessageReceived({ countMessage });
    if (settings.enableStoryPlanner !== false) modules.StoryPlanner.onMessageReceived({ countMessage });
    // Interiority gets the message index so the generation targets the message
    // that fired the event, not whatever is last when the queued work runs. It
    // owns no counter and no lastChatLength bookkeeping, so it is the one
    // receive handler that genuinely SHOULD be skipped during a panic window.
    if (countMessage && settings.enableInteriority !== false) modules.Interiority.onMessageReceived(messageIndex);
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
 */
export function routeMessageDeleted(modules, settings, deletedIndex) {
    const adjustCounters = !settings.injectionMasterOff;
    if (settings.enableWorldState !== false) modules.WorldState.onMessageDeleted(deletedIndex, { adjustCounters });
    if (settings.enableChronicle  !== false) modules.Chronicle.onMessageDeleted(deletedIndex, { adjustCounters });
    if (settings.enableKnowledge  !== false) modules.Knowledge.onMessageDeleted(deletedIndex, { adjustCounters });
    if (settings.enableStoryPlanner !== false) modules.StoryPlanner.onMessageDeleted(deletedIndex, { adjustCounters });
    // INTERIORITY-04: ledger / per-message cleanup must keep running while
    // injection is off, so a delete during a panic-off window never leaves
    // orphaned thought metadata or an un-rolled-back ledger.
    if (settings.enableInteriority !== false) modules.Interiority.onMessageDeleted(deletedIndex);
}

/**
 * Dispatch a MESSAGE_SWIPED event. Awareness / cleanup only — never gated by
 * the panic switch (no counter to drift; swipe never starts a generation).
 *
 * @param {object} modules — { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority }
 *   (only WorldState, Chronicle, and Interiority have swipe handlers)
 * @param {object} settings — the global settings object (read-only here)
 * @param {number|null} swipedIndex — resolved index of the swiped message
 */
export function routeMessageSwiped(modules, settings, swipedIndex) {
    if (settings.enableWorldState !== false) modules.WorldState.onMessageSwiped(swipedIndex);
    if (settings.enableChronicle  !== false) modules.Chronicle.onMessageSwiped(swipedIndex);
    if (settings.enableInteriority !== false) modules.Interiority.onMessageSwiped(swipedIndex);
}

/**
 * Dispatch a MESSAGE_EDITED event. Awareness / cleanup only — never gated by
 * the panic switch (no counter to drift; edit never starts a generation).
 *
 * @param {object} modules — { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority }
 *   (only WorldState, Chronicle, and Interiority have edit handlers)
 * @param {object} settings — the global settings object (read-only here)
 * @param {number|null} editedIndex — resolved index of the edited message
 */
export function routeMessageEdited(modules, settings, editedIndex) {
    if (settings.enableWorldState !== false) modules.WorldState.onMessageEdited(editedIndex);
    if (settings.enableChronicle  !== false) modules.Chronicle.onMessageEdited(editedIndex);
    if (settings.enableInteriority !== false) modules.Interiority.onMessageEdited(editedIndex);
}
