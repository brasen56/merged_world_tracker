/**
 * interiority/index.js — Interiority module (thin orchestrator).
 *
 * Public API: { init, render, onMessageReceived, onChatChanged,
 *               onMessageSwiped, onMessageEdited, onMessageDeleted,
 *               applyIntentionsInjection, triggerGenerate,
 *               getModuleRender, getModuleWireEvents,
 *               syncGlobalSettings, getTotalTokens, isGenerating,
 *               getAutoStatus, getSettingsSummary, getLedgerCount }
 *
 * Sub-modules:
 *   data.js       — constants, state, settings, data access, helpers
 *   prompts.js    — system prompt, JSON output contract, injection format
 *   generation.js — context assembly, API call, validation, ledger mutation
 *   injection.js  — <mwt_npc_intentions> extension-prompt injection
 *   render.js     — settings UI + per-message thought display
 */

import {
    getChat, getContextSafe, estimateTokens,
    captureScope, assertSameScope,
    injectionAllowed, record,
} from '../core/index.js';

import {
    state, getSettings, hasValidSettings, syncGlobalSettings,
    getLedger,
    deletePerMessage, getPerMessageKeys, getMsgKeyForIndex,
    getOrCreateMsgKeyForIndex,
    buildKeyToIndexMap,
    purgeUserLedgerEntries,
    restoreLedgerSnapshot, restoreInnerStatesSnapshot,
    isChatHydrated,
    incrementTurnCounter, restoreTurnCounter, isDormantPollDue,
    getTurnCounter, getDormantLedger, getDormantPollInterval,
} from './data.js';
// Part 6 (§7.5): the privileged preparation path that owns the legacy-key
// conversion retries (onMoreMessagesLoaded). schema/runtime.js imports
// ./data.js for the converter itself; this file never feeds it back, so the
// dependency stays acyclic.
import { runSchemaPreparations } from '../schema/runtime.js';
// Part 6 (§7.4) pause guard + the store id it checks. Direct imports (not the
// barrel) so the REAL pause singleton is read even under the test
// barrel→stub alias — the same rule data.js applies to the write seam.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { interioritySchema } from './schema.js';

import {
    buildSceneRoster, runBatchedCall, runStrictCalls, validateAndApply,
    runSplitCall, mergeSplitResults, runDormantPoll, resolveUserNames, isUserName,
} from './generation.js';

import { applyIntentionsInjection } from './injection.js';

import {
    renderContent, renderAllThoughtBlocks, clearAllThoughtBlocks,
    renderThoughtBlockForMessage,
} from './render.js';

// ─── Generation triggers (diagnostics) ───────────────────────────────────────

/**
 * What caused a generation. Threaded from each entry point down to
 * captureApiCall (core/api.js), which stamps it onto the api_call telemetry
 * next to `panic` (the master switch's state when the request fired).
 *
 * This exists because the api_call row alone cannot answer the question a
 * "panic is on and it is STILL spending tokens" report actually asks. The
 * module has four automatic-looking entry points with different gating, and
 * two of them (`MANUAL`, `SLASH_COMMAND`) pass `force: true` and legitimately
 * bypass the panic gate — so "an interiority call happened during a panic
 * window" is not by itself a bug, and which trigger it was IS the diagnosis.
 *
 * Stable strings — they are read by users out of the diagnostics panel and
 * quoted in bug reports. Do not rename.
 */
export const TRIGGER = Object.freeze({
    MESSAGE_RECEIVED: 'message_received', // auto, gated (router + gate)
    SWIPE: 'swipe',                       // auto, gated (gate only)
    EDIT: 'edit',                         // auto, gated (gate only)
    MANUAL: 'manual',                     // 💭 Generate button — force, UNGATED
    SLASH_COMMAND: 'slash_command',       // /wt-thoughts — force, UNGATED
    UNKNOWN: 'unknown',                   // a caller that forgot to say
});

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        state.modal = parentModal;
        state.contentEl = null;
        renderContent();
    }
    // Part 6: the legacy numeric-index / send_date perMessage key conversion is
    // NOT queued here anymore. The runtime schema gate (schema/runtime.js) owns
    // it as privileged §7.5 orchestration — index.js runs the gate (and its
    // privileged preparation) BEFORE the module inits, so a deferred store is
    // paused (preparing) before this module ever reads it, and queueing the
    // conversion on the paused module's own work queue would deadlock its own
    // recovery. Init does not need to schedule anything for it.
    // Clean up any user-owned ledger entries the roster filter let through.
    purgeLeakedUserEntries();
    applyIntentionsInjection();
    // Render any existing thought blocks for the current chat
    setTimeout(() => renderAllThoughtBlocks(), 100);
    console.log('[MWT:Interiority] Module initialized');
}

/**
 * Purge ledger entries owned by the player character.
 *
 * Fire-and-forget: resolving the user's name forms needs the knowledge
 * registry, which is a dynamic import. The injection is re-applied only when
 * something was actually removed, so the common case costs nothing.
 *
 * That dynamic import is an await boundary (INTERIORITY-02): the scope is
 * captured before it and re-asserted after, so a chat switch during the
 * resolve discards this purge instead of letting an old chat's cleanup purge
 * the NEWLY active chat's ledger — the new chat's own init/onChatChanged
 * runs its own purge.
 *
 * A leaked entry is self-sustaining — `getActiveLedger()` seeds the roster from
 * the ledger every turn, so the PC would be re-admitted to the roster for the
 * rest of the chat. Purging it is what breaks that loop.
 *
 * Exported (and returned as a promise) so the scope-guard regression tests can
 * observe the guard deterministically; production callers fire and forget it.
 *
 * @returns {Promise<void>} settles when the cleanup has run (or been discarded)
 */
export function purgeLeakedUserEntries() {
    // Capture BEFORE the await — the INTERIORITY-02 contract:
    // capture → await → assert → discard-on-stale.
    const scope = captureScope();
    return resolveUserNames()
        .then(names => {
            // The user may have switched chats while the name forms resolved;
            // getLedger() below would then read the NEW chat. Discard quietly.
            if (!assertSameScope(scope).ok) return;
            // Widen the set to the name forms the ledger actually holds. A leak
            // that arrived as "Alex" is invisible to a set holding only
            // "alex hiro", so the entry survives every purge and re-admits the
            // PC to the roster forever. The ledger's own owners are the
            // population for the ambiguity test: if two of them answer to
            // "Alex", nothing is purged.
            const owners = [...new Set(getLedger().map(entry => entry.npc))];
            const leaked = new Set(names);
            for (const owner of owners) {
                if (isUserName(owner, names, owners)) leaked.add(String(owner).toLowerCase().trim());
            }
            if (purgeUserLedgerEntries(leaked)) applyIntentionsInjection();
        })
        .catch(err => console.warn('[MWT:Interiority] User-entry purge failed:', err?.message || err));
}

export function render() {
    return '<div id="mwt-int-content"></div>';
}

export { applyIntentionsInjection };

export function getModuleRender() { return render; }

export function getModuleWireEvents() {
    return () => {
        state.contentEl = null;
        renderContent();
    };
}

// ─── Turn flow (§5) ──────────────────────────────────────────────────────────

/**
 * Called on MESSAGE_RECEIVED (when gated by the main index.js).
 *
 * Hook is debounced/serialized through the work queue so it never races
 * the knowledge/world-state scans.
 *
 * @param {number|null} [msgIdx] - chat-array index of the received message,
 *   as reported by the event. Resolved to a stable key NOW: in group chats
 *   or fast turns, another message can land before the queued work runs, and
 *   an array index captured at event time could point at the wrong message
 *   by the time the work runs. A stable key (UUID or send_date) survives
 *   array shifts and is resolved to the current index when the work executes.
 */
export function onMessageReceived(msgIdx) {
    const settings = getSettings();
    if (!settings.autoMode) return;
    if (!hasValidSettings()) return;

    const targetIdx = typeof msgIdx === 'number' ? msgIdx : (getChat()?.length ?? 0) - 1;
    // Stamp a UUID NOW so two messages in the same minute (same send_date)
    // don't collide. This is a write path — the UUID is persisted with the
    // chat via saveChatDebounced and used to key the perMessage entry.
    const targetKey = getOrCreateMsgKeyForIndex(targetIdx);

    // Serialize through the work queue so generations never overlap.
    queueWork(() => generateForCurrentMessage(targetKey, { trigger: TRIGGER.MESSAGE_RECEIVED }));
}

/**
 * Manually trigger interiority generation for the current/last AI message.
 * Used by the "💭 Generate" button and the /wt-thoughts slash command.
 *
 * User-initiated generation bypasses the §21 `thoughtsInterval` throttle by
 * default. That dial exists to cut the cost of AUTOMATIC per-turn thoughts,
 * not to refuse a generation the user explicitly asked for — and this is also
 * the repair path after a swipe/edit regeneration lands on an off-turn, so it
 * has to be able to produce a thought on demand.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=true] - bypass the thoughtsInterval throttle
 * @param {string} [opts.trigger='manual'] - diagnostics label for the caller.
 *   Defaults to the 💭 Generate button; `/wt-thoughts` passes its own. Both
 *   bypass the panic gate (`force`), so the api_call telemetry has to name
 *   WHICH of them spent the tokens.
 */
export async function triggerGenerate({ force = true, trigger = TRIGGER.MANUAL } = {}) {
    return queueWork(() => generateForCurrentMessage(null, { force, trigger }));
}

/**
 * Core generation logic — shared by auto and manual modes.
 *
 * Flow:
 *   1. Build scene roster
 *   2. Run API call (batched or strict)
 *   3. Validate JSON, apply ledger mutations
 *   4. Store reactions in perMessage (keyed by stable UUID)
 *   5. Render thought block on the message DOM
 *   6. Apply intentions injection
 *
 * @param {string|null} [targetKey] - stable perMessage key (mu-* or sd-*)
 *   captured when the work was queued. Resolved to the current chat-array
 *   index when the work runs, so a message deleted while queued skips the
 *   generation rather than mis-targeting another message. Omitted (null)
 *   for manual triggers, which target the current last message.
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] - user-initiated: bypass the §21
 *   `thoughtsInterval` throttle so an explicit request always runs thoughts.
 *   Automatic (MESSAGE_RECEIVED) generation leaves this false and stays throttled.
 * @param {string} [opts.trigger] - one of TRIGGER.*: what caused this
 *   generation. Rides down to captureApiCall (core/api.js) so every api_call
 *   row in diagnostics names its own cause. Never affects behaviour.
 */
async function generateForCurrentMessage(targetKey, { force = false, trigger = TRIGGER.UNKNOWN } = {}) {
    // Part 6 (§7.4): the pause is a data-integrity stop, not a preference —
    // even `force` (the 💭 Generate button / /wt-thoughts) may not spend an
    // API call against a store the runtime schema gate has not prepared:
    // validateAndApply's writes would be refused by the paused seam and the
    // turn's thoughts would be silently lost. Direct/manual entry points
    // bypass the router's decline predicate, so this choke point checks it.
    if (isStorePausedForCurrentScope(interioritySchema.id)) {
        console.log(`[MWT:Interiority] Generation skipped (trigger: ${trigger}) — the store is paused for this chat (schema preparation).`);
        // Breadcrumb in the diagnostics ring (same reason the panic gate
        // records one): without it "no api_call" is indistinguishable from
        // "the module never ran" when a user reports the button dead.
        record({
            level: 'info',
            module: 'interiority',
            event: 'generation_blocked',
            detail: { trigger, reason: 'store-paused' },
        });
        return null;
    }

    // PANIC GATE: every automatic entry point into this function must respect
    // the master panic switch (injectionMasterOff) and the per-module disable.
    // MESSAGE_RECEIVED is already gated in core/event_router.js, but the
    // swipe/edit handler (invalidateAndMaybeRegenerate) queues a regeneration
    // whenever the LAST message was swiped to an existing slot or edited — and
    // the router deliberately does NOT gate MESSAGE_SWIPED/MESSAGE_EDITED
    // (INTERIORITY-04 keeps rollback/cleanup running during a panic window),
    // so without this check that regeneration burned API calls while the user
    // believed everything was off. This is the single choke point for all
    // automatic API calls the module makes (batched/strict/split AND the
    // dormant poll). Only `force` — the 💭 Generate button / /wt-thoughts,
    // explicit user intent — may bypass it. Cleanup/rollback never flows
    // through here, so the INTERIORITY-04 contract is unaffected.
    if (!force && !injectionAllowed('Interiority')) {
        console.log(`[MWT:Interiority] Generation skipped (trigger: ${trigger}) — injection disabled (panic switch on or module off).`);
        // Breadcrumb in the diagnostics ring so the panel can show the gate
        // WORKING. Without it a panic window produces no interiority evidence
        // at all, and "no api_call" is indistinguishable from "module never
        // ran" — which is exactly the ambiguity that made the swipe-path leak
        // (1.8.3) so hard to pin down from a user's screenshot.
        record({
            level: 'info',
            module: 'interiority',
            event: 'generation_blocked',
            detail: { trigger, reason: 'injection-disabled' },
        });
        return null;
    }

    const ctx = getContextSafe();
    if (!ctx) return null;

    const chat = getChat();
    if (!chat || chat.length === 0) return null;

    let msgIdx;
    // Capture a stable key for this message NOW (before any API call) so we
    // can re-resolve the index after the await. The API call can take seconds;
    // if a message is deleted or Inline Summary collapses a range during it,
    // a chat-array index held across the await would point at a different
    // message — which would then receive this turn's thoughts and rollback
    // snapshot (item 5 fix).
    let resolvedKey;
    if (targetKey) {
        // Resolve the stable key → current index. If the message was deleted
        // while this work was queued, the key won't be in the map.
        resolvedKey = targetKey;
        const keyToIndex = buildKeyToIndexMap();
        msgIdx = keyToIndex.get(targetKey);
        if (msgIdx == null) {
            console.log(`[MWT:Interiority] Skipping generation — target message (key ${targetKey}) no longer exists.`);
            return null;
        }
    } else {
        // Manual trigger: generate for the last message. Stamp a key now so
        // we can re-resolve after the API call.
        msgIdx = chat.length - 1;
        resolvedKey = getOrCreateMsgKeyForIndex(msgIdx);
    }

    // INTERIORITY-02: Capture scope using the guard (getCurrentChatId + epoch)
    // instead of the weak key that collapsed same-character chats. Assert
    // before every commit point — after each API call AND after
    // validateAndApply (which itself awaits resolveUserNames).
    const scopeBefore = captureScope();

    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));

    try {
        // INTERIORITY-03: The turn counter used to increment BEFORE the API
        // call, so empty rosters, API failures, and discarded stale targets
        // all consumed a turn — shifting dormant-poll scheduling during an
        // outage. It now increments only after a result is successfully
        // applied (see below). isDormantPollDue() has been updated to look
        // ahead by 1 so the poll still fires at the *start* of the right
        // turn.

        // Capture the rollback ledger snapshot BEFORE the dormant poll runs.
        // The poll commits its wakes straight to the live ledger, and
        // validateAndApply used to capture the snapshot after that — so the
        // rollback record held the entry already woken, and a swipe could
        // never put it back to sleep. A wake justified by a message that then
        // gets swiped out of existence survived the swipe. The snapshot must
        // predate every ledger mutation of this turn, wakes included.
        // (Manual panel edits made mid-generation still survive rollback —
        // restoreLedgerSnapshot preserves manual entries and user-edited
        // fields regardless of what the snapshot contains.)
        const preTurnLedgerSnapshot = JSON.parse(JSON.stringify(getLedger()));

        // §20: Dormant poll (lazy wake). Runs BEFORE the main call so woken
        // entries are included in this turn's roster + injection. Fires only
        // when isDormantPollDue() is true (every DORMANT_POLL_INTERVAL turns
        // with dormant entries present).
        let proposedWakeIds = [];
        const settings = getSettings();
        const wantThoughts = settings.generateThoughts !== false;
        const wantIntentions = settings.generateIntentions !== false;
        if (wantIntentions && isDormantPollDue()) {
            try {
                proposedWakeIds = await runDormantPoll({ trigger });
                // INTERIORITY-02: The dormant poll awaits an API call. Assert
                // scope after it returns. The poll is proposal-only, so there
                // is no ledger write to leak if the chat changed.
                if (!assertSameScope(scopeBefore).ok) {
                    console.log('[MWT:Interiority] Dormant poll results discarded — chat changed during API call.');
                    proposedWakeIds = [];
                }
            } catch (err) {
                console.warn('[MWT:Interiority] Dormant poll failed (non-blocking):', err);
            }
        }

        // 1. Build roster
        const roster = await buildSceneRoster(proposedWakeIds);
        if (roster.length === 0) {
            console.log('[MWT:Interiority] No NPCs in scene — skipping.');
            return null;
        }

        console.log(`[MWT:Interiority] Generating for ${roster.length} NPC(s): ${roster.join(', ')}`);

        // 2. Run API call(s).
        //
        // Split mode (§16): when splitThoughts is ON and both features are
        // enabled, fire two parallel calls — one for intentions, one for
        // thoughts — then merge the results into a single object that the
        // unchanged validateAndApply can process. When OFF, or when only one
        // feature is enabled, run a single unified call (v1 behavior).
        const useSplit = settings.splitThoughts === true && wantThoughts && wantIntentions;

        let result;
        let intentionsEvaluatedRoster = [];
        if (useSplit) {
            console.log('[MWT:Interiority] Split mode ON — running parallel intentions + thoughts calls.');
            const { intentionsResult, thoughtsResult } = await runSplitCall(roster, { force, virtuallyActiveIds: proposedWakeIds, trigger });
            // INTERIORITY-02: Cross-chat guard after the parallel pair completes.
            if (!assertSameScope(scopeBefore).ok) {
                console.log('[MWT:Interiority] Results discarded — chat changed during split API call.');
                return null;
            }
            // Both null = total failure; bail like v1 does.
            if (!intentionsResult && !thoughtsResult) {
                console.warn('[MWT:Interiority] Both split calls returned no result. Skipping silently.');
                return null;
            }
            result = mergeSplitResults(intentionsResult, thoughtsResult, roster);
            intentionsEvaluatedRoster = getEvaluatedNpcNames(intentionsResult, roster);
        } else {
            if (settings.mode === 'strict') {
                result = await runStrictCalls(roster, proposedWakeIds, { trigger });
            } else {
                result = await runBatchedCall(roster, { virtuallyActiveIds: proposedWakeIds, trigger });
            }

            // INTERIORITY-02: Cross-chat guard: discard if the user switched
            // chats during the API call. Uses the scope guard instead of the
            // old weak key.
            if (!assertSameScope(scopeBefore).ok) {
                console.log('[MWT:Interiority] Results discarded — chat changed during API call.');
                return null;
            }

            if (!result) {
                console.warn('[MWT:Interiority] Generation returned no result (API/parse failure). Skipping silently.');
                return null;
            }
            if (wantIntentions) intentionsEvaluatedRoster = getEvaluatedNpcNames(result, roster, result.intentionsEvaluatedRoster);
        }

        // Re-resolve the message index AFTER the API call(s). The await can
        // take seconds; if a message was deleted or Inline Summary collapsed a
        // range during it, the pre-await index now points at a different
        // message. Re-derive from the stable key and bail if it's gone.
        // (Item 5 fix.)
        if (resolvedKey) {
            const keyToIndexAfter = buildKeyToIndexMap();
            const msgIdxAfter = keyToIndexAfter.get(resolvedKey);
            if (msgIdxAfter == null) {
                console.log(`[MWT:Interiority] Results discarded — target message (key ${resolvedKey}) no longer exists after API call.`);
                return null;
            }
            msgIdx = msgIdxAfter;
        }

        // 3-4. Validate and apply.
        // INTERIORITY-02: Pass the scope token into validateAndApply so it can
        // assert scope immediately after its own `resolveUserNames()` await,
        // BEFORE any persistent mutation. If the chat changed during that
        // await, it returns null and we bail without a second write attempt.
        const evaluatedNpcNames = new Set(intentionsEvaluatedRoster.map(name => String(name).toLowerCase().trim()));
        const confirmedWakeIds = proposedWakeIds.filter(id => {
            const entry = getLedger().find(candidate => candidate.id === id);
            return entry && evaluatedNpcNames.has(String(entry.npc).toLowerCase().trim());
        });
        const applyResult = await validateAndApply(result, roster, msgIdx, scopeBefore, preTurnLedgerSnapshot, confirmedWakeIds);

        // INTERIORITY-02: Re-assert scope AFTER validateAndApply as a
        // belt-and-suspenders guard. The in-function check covers the
        // resolveUserNames() gap; this covers any drift between the return
        // and the render/injection calls below.
        if (!applyResult || !assertSameScope(scopeBefore).ok) {
            console.log('[MWT:Interiority] Results discarded — chat changed during validateAndApply.');
            return null;
        }

        const { reactions, ledgerChanged } = applyResult;

        console.log(`[MWT:Interiority] Applied: ${reactions.length} reaction(s), ledger ${ledgerChanged ? 'changed' : 'unchanged'}.`);

        // INTERIORITY-03: Increment the turn counter only now — after a result
        // has been successfully validated and applied. Empty rosters, API
        // failures, and discarded stale targets all bail earlier and never
        // reach this line, so they no longer consume a turn. This keeps the
        // dormant-poll schedule aligned with actual successful generations.
        incrementTurnCounter();

        // 5. Render thought block on the message DOM
        renderThoughtBlockForMessage(msgIdx);

        // 6. Apply intentions injection
        applyIntentionsInjection();

        return { reactions, ledgerChanged };
    } catch (err) {
        console.error('[MWT:Interiority] Generation failed:', err);
        return null;
    } finally {
        state.isGenerating = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    }
}

/**
 * Resolve which roster NPCs actually had their intentions evaluated this turn.
 *
 * `reportedNames` is authoritative when the caller has it — only runStrictCalls
 * tracks per-NPC evaluation, so the batched and split paths pass nothing and we
 * fall back to inferring from the names present in the response. Both branches
 * must be plain arrays: a Set here silently satisfies `Array.isArray === false`
 * and then throws on `.map`, which is what broke every non-strict path in 1.6.0.
 *
 * @param {object|null} result parsed API result ({ npcs: [...] })
 * @param {string[]} roster canonical roster names (returned casing wins)
 * @param {string[]} [reportedNames] names the call reported as evaluated
 * @returns {string[]} deduped roster names, in canonical casing
 */
export function getEvaluatedNpcNames(result, roster, reportedNames) {
    const rosterByLower = new Map(roster.map(name => [String(name).toLowerCase().trim(), name]));
    const responseNames = (Array.isArray(result?.npcs) ? result.npcs : [])
        .map(npc => String(npc?.name || '').toLowerCase().trim()).filter(Boolean);
    const candidates = Array.isArray(reportedNames) ? reportedNames : responseNames;
    return [...new Set(candidates.map(name => rosterByLower.get(String(name).toLowerCase().trim())).filter(Boolean))];
}

// ─── Chat lifecycle ──────────────────────────────────────────────────────────

export function onChatChanged() {
    // NOTE: do NOT unconditionally clear state.isGenerating here. A generation
    // in flight for the *previous* chat self-clears in its own finally; forcing
    // the flag false here shows stale "idle" UI and (if the work queue were
    // ever removed) could allow overlapping calls. Mirrors story_planner.
    state.contentEl = null;
    // Part 6: the legacy key conversion for the new chat is NOT queued here —
    // the root CHAT_CHANGED handler runs the runtime schema gate (and its
    // privileged §7.5 preparation) BEFORE this handler, so the store is either
    // already prepared or paused (preparing) by the time Interiority runs.
    // Clear DOM thought blocks from the previous chat
    clearAllThoughtBlocks();
    // Re-render thought blocks for the new chat
    setTimeout(() => renderAllThoughtBlocks(), 200);
    // Purge leaked user-owned ledger entries before re-injecting this chat's ledger
    purgeLeakedUserEntries();
    // Re-apply injection from the new chat's ledger
    applyIntentionsInjection();
    // Re-render the tab content
    if (state.modal) renderContent();
    console.log('[MWT:Interiority] Chat changed — state reset.');
}

/**
 * The scope-INDEPENDENT half of onChatChanged(), run by index.js's
 * CHAT_CHANGED handler while the interiority store is paused for this chat
 * (Part 6 §7.4/§5.4). Clears the previous chat's DOM thought blocks and
 * injection (the applier's paused branch) without one read of the blocked
 * store — no ledger purge (its write seam would refuse), and no re-render of
 * thought blocks from a store that was never prepared. The index.js modal
 * re-render shows the pause banner in the tab.
 */
export function onChatChangedWhilePaused() {
    state.contentEl = null;
    clearAllThoughtBlocks();
    applyIntentionsInjection();
    console.log('[MWT:Interiority] Chat changed while paused — injection cleared, thought blocks cleared (store hydration skipped).');
}

// ─── Swipe / edit / delete rollback (§9) ─────────────────────────────────────

/**
 * A message was deleted. Delete its perMessage entry, restore ledgerSnapshot
 * (newest generation only), and re-render.
 *
 * Because perMessage keys are now stable UUID identifiers (not chat indices),
 * deleting a message no longer requires re-keying other entries — their keys
 * remain valid regardless of the array shift. This also means Inline Summary's
 * batch summarisation won't corrupt the key→message mapping.
 *
 * @param {number} deletedIndex
 */
export async function onMessageDeleted(deletedIndex) {
    if (typeof deletedIndex !== 'number') return;

    // Aikobots v4 sparse-chat guard: the orphan cleanup below iterates the
    // full chat array to find perMessage keys whose messages no longer exist.
    // On the fork, unhydrated message slots are holes — they'd ALL look like
    // missing messages, causing mass-deletion of thoughts/snapshots. Defer
    // cleanup until the chat is fully hydrated. On upstream ST,
    // isChatHydrated() always returns true.
    if (!(await isChatHydrated())) {
        console.log('[MWT:Interiority] MESSAGE_DELETED cleanup deferred — chat not fully hydrated.');
        return;
    }

    // SillyTavern fires MESSAGE_DELETED *after* removing the message from the
    // chat array. That means getMsgKeyForIndex(deletedIndex) would resolve to
    // the key of whatever message shifted into that position — the WRONG key.
    // Instead, we find the orphaned perMessage key: the one whose message no
    // longer exists in the (now-shrunk) chat array.
    //
    // This approach is timing-agnostic: it works whether ST fires before or
    // after the actual array mutation, because it relies on the *current*
    // state of the chat, not on the deleted index.
    const allKeys = getPerMessageKeys();
    if (allKeys.length === 0) return;

    // Build the set of keys that currently exist in the chat array.
    // A message can produce both a 'mu-*' (UUID) key and a 'sd-*'
    // (send_date) key, so we use buildKeyToIndexMap which handles both.
    const currentKeys = new Set(buildKeyToIndexMap().keys());

    // Find perMessage keys that don't map to any current message
    const orphaned = allKeys.filter(k => !currentKeys.has(k));

    if (orphaned.length === 0) {
        // The deleted message had no perMessage entry — nothing to clean up
        return;
    }

    if (orphaned.length > 1) {
        // Multiple orphans can happen if Inline Summary or a bulk-delete tool
        // removed several messages in one operation. In that case we can't
        // know which orphan corresponds to deletedIndex, but they all need
        // cleanup — they reference messages that no longer exist.
        console.log(`[MWT:Interiority] MESSAGE_DELETED: ${orphaned.length} orphaned perMessage entries found — cleaning up all.`);
    }

    // Roll back the complete deleted generation suffix. allKeys is newest
    // first: if its newest entry is orphaned, every consecutive orphan after it
    // belongs to abandoned turns, and the OLDEST snapshot in that suffix is the
    // state from before all of them. A later surviving generation is a boundary
    // that must never be crossed.
    let snapshotToRestore = null;
    let innerStatesSnapshotToRestore = null;
    let turnCounterToRestore = null;
    const orphanedSet = new Set(orphaned);
    const rollbackKeys = [];
    for (const key of allKeys) {
        if (!orphanedSet.has(key)) break;
        rollbackKeys.push(key);
    }
    const rollbackKey = rollbackKeys.at(-1);

    for (const keyToDelete of orphaned) {
        const deleted = deletePerMessage(keyToDelete);
        if (keyToDelete === rollbackKey && deleted) {
            if (Array.isArray(deleted.ledgerSnapshot)) snapshotToRestore = deleted.ledgerSnapshot;
            if (deleted.innerStatesSnapshot) innerStatesSnapshotToRestore = deleted.innerStatesSnapshot;
            if (typeof deleted.turnCounterAtSnapshot === 'number') turnCounterToRestore = deleted.turnCounterAtSnapshot;
        }
    }

    // Restore snapshots only if the newest generation was deleted.
    // Restoring older snapshots would wipe mutations made after them.
    if (snapshotToRestore) {
        restoreLedgerSnapshot(snapshotToRestore);
    }
    // §18: roll back inner states too, or a swipe reverts Mara's intentions
    // but leaves her mood from the abandoned timeline.
    if (innerStatesSnapshotToRestore) {
        restoreInnerStatesSnapshot(innerStatesSnapshotToRestore);
    }
    // Un-consume the deleted turn (see restoreTurnCounter) so the dormant-poll
    // schedule tracks generations that still exist in the timeline.
    if (turnCounterToRestore !== null) {
        restoreTurnCounter(turnCounterToRestore);
    }
    if (snapshotToRestore || innerStatesSnapshotToRestore) {
        console.log(`[MWT:Interiority] MESSAGE_DELETED — snapshots restored (manual ledger entries preserved).`);
    }

    applyIntentionsInjection();
    renderAllThoughtBlocks();
}

/**
 * A message was swiped or edited: invalidate its thoughts, roll back the
 * ledger when (and only when) the affected message holds the newest
 * generation, and re-generate if the LAST chat message was affected.
 *
 * @param {number} msgIdx
 * @param {string} eventName - for logging
 */
function invalidateAndMaybeRegenerate(msgIdx, eventName) {
    if (typeof msgIdx !== 'number') return;

    const msgKey = getMsgKeyForIndex(msgIdx);
    if (!msgKey) return;

    const allKeys = getPerMessageKeys();
    const wasNewest = allKeys.length > 0 && msgKey === allKeys[0];
    const deleted = deletePerMessage(msgKey);

    if (wasNewest && deleted) {
        // §18: roll back BOTH snapshots, so a swipe reverts Mara's intentions
        // and her mood together — not just the ledger.
        if (Array.isArray(deleted.ledgerSnapshot)) {
            restoreLedgerSnapshot(deleted.ledgerSnapshot);
        }
        if (deleted.innerStatesSnapshot) {
            restoreInnerStatesSnapshot(deleted.innerStatesSnapshot);
        }
        // Un-consume the invalidated turn (see restoreTurnCounter): without
        // this, every swipe cycle advanced the dormant-poll schedule by one
        // phantom turn, so intentions woke ahead of real story time. Absent
        // on records from before this field existed — skip, don't guess.
        if (typeof deleted.turnCounterAtSnapshot === 'number') {
            restoreTurnCounter(deleted.turnCounterAtSnapshot);
        }
        if (Array.isArray(deleted.ledgerSnapshot) || deleted.innerStatesSnapshot) {
            console.log(`[MWT:Interiority] ${eventName} at index ${msgIdx} — snapshots restored (manual ledger entries preserved).`);
        }
    }

    applyIntentionsInjection();
    renderAllThoughtBlocks();

    // Re-generate only when the last chat message was affected — editing an
    // older message shouldn't spend an API call re-reading the same scene.
    const isLastMessage = msgIdx === (getChat()?.length ?? 0) - 1;
    const settings = getSettings();
    if (isLastMessage && settings.autoMode && hasValidSettings()) {
        // Swipe into a fresh (not-yet-generated) slot: ST sets
        // swipe_id === swipes.length BEFORE emitting MESSAGE_SWIPED, then runs
        // its own generation, whose saveReply emits MESSAGE_RECEIVED (type
        // 'swipe') — onMessageReceived generates then, against the NEW
        // content. Queueing here too would double-generate (the visible
        // "bubble changed twice" bug) and burn an API call reading the old
        // content that's about to be replaced. Navigation between existing
        // swipes (swipe_id < swipes.length) never fires MESSAGE_RECEIVED, so
        // it still regenerates here.
        //
        // Pass the stable msgKey (not msgIdx) so the queued work targets the
        // correct message even if the array shifts before it runs.
        const msg = getChat()?.[msgIdx];
        const isFreshSwipeSlot = Array.isArray(msg?.swipes)
            && (msg.swipe_id ?? 0) >= msg.swipes.length;
        if (isFreshSwipeSlot) {
            console.log(`[MWT:Interiority] ${eventName} opened a fresh swipe slot — deferring generation to MESSAGE_RECEIVED.`);
        } else {
            queueWork(() => generateForCurrentMessage(msgKey, {
                trigger: eventName === 'MESSAGE_SWIPED' ? TRIGGER.SWIPE : TRIGGER.EDIT,
            }));
        }
    }
}

/**
 * A message was swiped (content replaced with alternate generation).
 * @param {number} swipedIndex
 */
export function onMessageSwiped(swipedIndex) {
    invalidateAndMaybeRegenerate(swipedIndex, 'MESSAGE_SWIPED');
}

/**
 * A message was edited. Same rollback as swipe.
 * @param {number} editedIndex
 */
export function onMessageEdited(editedIndex) {
    invalidateAndMaybeRegenerate(editedIndex, 'MESSAGE_EDITED');
}

// ─── Sparse-chat: MORE_MESSAGES_LOADED hook ──────────────────────────────────

/**
 * Older chat ranges were hydrated (Aikobots v4 fork event). Re-render thought
 * blocks for newly-visible messages and re-run the privileged preparation —
 * a deferral that survived because the chat was not fully hydrated now has
 * its precondition.
 *
 * The retry goes through schema/runtime.js runSchemaPreparations() (the §7.5
 * privileged path), NOT this module's own work queue: a deferred store is
 * paused, and a queued recovery job would be declined by the very pause it
 * exists to clear.
 *
 * On upstream ST this is never called (the event doesn't exist).
 */
export function onMoreMessagesLoaded() {
    // Retry the privileged preparation (it defers if chat wasn't hydrated — now it may be)
    runSchemaPreparations();
    // Re-render thought blocks for newly hydrated messages
    renderAllThoughtBlocks();
    console.log('[MWT:Interiority] MORE_MESSAGES_LOADED — re-rendered thought blocks for newly hydrated messages.');
}

// ─── Work queue (serialization) ──────────────────────────────────────────────

/**
 * Serialise asynchronous interiority work onto a single promise chain,
 * mirroring the knowledge/lorebook.js#queueTrackerWork pattern.
 *
 * @param {() => (Promise<*>|*)} fn
 * @returns {Promise<*>}
 */
function queueWork(fn) {
    const result = state.workQueue
        .catch(() => {})
        .then(() => fn())
        .catch(err => console.error('[MWT:Interiority] Queued work failed:', err));
    state.workQueue = result;
    return result;
}

// ─── Token tracking ──────────────────────────────────────────────────────────

export function getTotalTokens() {
    // §20: only active entries are injected, so only they count toward tokens.
    const ledger = getLedger().filter(e => e.status !== 'dormant');
    if (!ledger.length) return 0;
    // Rough estimate of the injection payload
    const lines = ledger.map(e => `- ${e.npc} → ${e.action} → ${e.trigger} (since ${e.since || 'unknown'})`);
    return estimateTokens(lines.join('\n'));
}

export function isGenerating() {
    return state.isGenerating;
}

/**
 * Return a minimal summary of interiority settings for the floating button
 * state logic. Only fields relevant to the button (autoMode) are included.
 * @returns {{autoMode: boolean}}
 */
export function getSettingsSummary() {
    try {
        return { autoMode: getSettings().autoMode !== false };
    } catch {
        return { autoMode: false };
    }
}

/**
 * Return the current ledger entry count (for button state display).
 * @returns {number}
 */
export function getLedgerCount() {
    try {
        return getLedger().length;
    } catch {
        return 0;
    }
}

/**
 * Returns auto-run status for external display — the Phase 4 diagnostics
 * accessor (design §I.4.7) that closes the one gap in the Health tab's
 * per-module row. Mirrors the null-when-disabled contract of the other four
 * modules' countdown accessors (getAutoRefreshStatus / getAutoSnapshotStatus /
 * getAutoScanStatus / getAutoPlanStatus).
 *
 * Interiority is the one module whose auto-run has no countdown: when
 * autoMode is ON it evaluates every AI message. The only scheduled cadence is
 * the §20 dormant-intentions poll, so `counter`/`interval` describe THAT
 * cycle — the poll fires on a turn where (turnCounter + 1) % interval === 0
 * and dormant entries exist (isDormantPollDue's look-ahead-by-one), i.e.
 * `pollDue` is the direct answer and `counter` is turnCounter % interval.
 *
 * @returns {{perTurn: boolean, counter: number, interval: number,
 *            dormantCount: number, pollDue: boolean}|null} null when autoMode
 *          is off
 */
export function getAutoStatus() {
    try {
        const settings = getSettings();
        if (settings.autoMode === false) return null;
        const interval = getDormantPollInterval();
        return {
            // Auto fires on every AI message — there is no "next run in N
            // messages" countdown for the main generation.
            perTurn: true,
            counter: getTurnCounter() % interval,
            interval,
            dormantCount: getDormantLedger().length,
            pollDue: isDormantPollDue(),
        };
    } catch {
        return null;
    }
}

// ─── Settings sync ───────────────────────────────────────────────────────────

export { syncGlobalSettings };