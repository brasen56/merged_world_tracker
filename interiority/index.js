/**
 * interiority/index.js — Interiority module (thin orchestrator).
 *
 * Public API: { init, render, onMessageReceived, onChatChanged,
 *               onMessageSwiped, onMessageEdited, onMessageDeleted,
 *               applyIntentionsInjection, triggerGenerate,
 *               getModuleRender, getModuleWireEvents,
 *               syncGlobalSettings, getTotalTokens, isGenerating }
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
} from '../core/index.js';

import {
    state, getSettings, hasValidSettings, syncGlobalSettings,
    getLedger,
    deletePerMessage, getPerMessageKeys, getMsgKeyForIndex,
    getOrCreateMsgKeyForIndex,
    buildKeyToIndexMap,
    purgeUserLedgerEntries,
    restoreLedgerSnapshot, restoreInnerStatesSnapshot,
    migrateIndexKeys,
    isChatHydrated,
    incrementTurnCounter, isDormantPollDue,
} from './data.js';

import {
    buildSceneRoster, runBatchedCall, runStrictCalls, validateAndApply,
    runSplitCall, mergeSplitResults, runDormantPoll,
} from './generation.js';

import { applyIntentionsInjection } from './injection.js';

import {
    renderContent, renderAllThoughtBlocks, clearAllThoughtBlocks,
    renderThoughtBlockForMessage, setIntStatus,
} from './render.js';

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        state.modal = parentModal;
        state.contentEl = null;
        renderContent();
    }
    // Migrate legacy numeric-index and send_date perMessage keys to stable
    // UUID keys. This runs once per chat (guarded by data.keyMigrationDone)
    // and is essential for Inline Summary compatibility — old keys reference
    // positions that no longer match the (possibly shrunk) chat array.
    // migrateIndexKeys is now async (defers on sparse-chat forks until hydrated)
    queueWork(migrateIndexKeys);
    // Clean up any stale user-owned ledger entries from before the roster fix.
    purgeUserLedgerEntries();
    applyIntentionsInjection();
    // Render any existing thought blocks for the current chat
    setTimeout(() => renderAllThoughtBlocks(), 100);
    console.log('[MWT:Interiority] Module initialized');
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
    queueWork(() => generateForCurrentMessage(targetKey));
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
 */
export async function triggerGenerate({ force = true } = {}) {
    return queueWork(() => generateForCurrentMessage(null, { force }));
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
 */
async function generateForCurrentMessage(targetKey, { force = false } = {}) {
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

    // Capture chat identity for cross-chat guard
    const chatKeyBefore = `${ctx?.characterId ?? ''}|${ctx?.groupId ?? ''}|${ctx?.chatId ?? ''}`;

    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));

    try {
        // §20: increment the generation turn counter BEFORE the main call so
        // the dormant poll scheduler sees the correct turn number. The poll
        // fires when counter % DORMANT_POLL_INTERVAL === 0 and there are
        // dormant entries — it runs after generation, waking any entries
        // whose trigger is near so they're active for the NEXT turn.
        incrementTurnCounter();

        // §20: Dormant poll (lazy wake). Runs BEFORE the main call so woken
        // entries are included in this turn's roster + injection. Fires only
        // when isDormantPollDue() is true (every DORMANT_POLL_INTERVAL turns
        // with dormant entries present).
        if (isDormantPollDue()) {
            try {
                const woken = await runDormantPoll();
                if (woken > 0) {
                    console.log(`[MWT:Interiority] Dormant poll woke ${woken} intention(s) — they are now active.`);
                    // Re-apply injection immediately so woken entries appear
                    // in this turn's narrator prompt.
                    applyIntentionsInjection();
                }
            } catch (err) {
                console.warn('[MWT:Interiority] Dormant poll failed (non-blocking):', err);
            }
        }

        // 1. Build roster
        const roster = await buildSceneRoster();
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
        const settings = getSettings();
        const wantThoughts = settings.generateThoughts !== false;
        const wantIntentions = settings.generateIntentions !== false;
        const useSplit = settings.splitThoughts === true && wantThoughts && wantIntentions;

        let result;
        if (useSplit) {
            console.log('[MWT:Interiority] Split mode ON — running parallel intentions + thoughts calls.');
            const { intentionsResult, thoughtsResult } = await runSplitCall(roster, { force });
            // Cross-chat guard after the parallel pair completes.
            const ctxAfter = getContextSafe();
            const chatKeyAfter = `${ctxAfter?.characterId ?? ''}|${ctxAfter?.groupId ?? ''}|${ctxAfter?.chatId ?? ''}`;
            if (chatKeyAfter !== chatKeyBefore) {
                console.log('[MWT:Interiority] Results discarded — chat changed during API call.');
                return null;
            }
            // Both null = total failure; bail like v1 does.
            if (!intentionsResult && !thoughtsResult) {
                console.warn('[MWT:Interiority] Both split calls returned no result. Skipping silently.');
                return null;
            }
            result = mergeSplitResults(intentionsResult, thoughtsResult, roster);
        } else {
            if (settings.mode === 'strict') {
                result = await runStrictCalls(roster);
            } else {
                result = await runBatchedCall(roster);
            }

            // Cross-chat guard: discard if the user switched chats during the API call
            const ctxAfter = getContextSafe();
            const chatKeyAfter = `${ctxAfter?.characterId ?? ''}|${ctxAfter?.groupId ?? ''}|${ctxAfter?.chatId ?? ''}`;
            if (chatKeyAfter !== chatKeyBefore) {
                console.log('[MWT:Interiority] Results discarded — chat changed during API call.');
                return null;
            }

            if (!result) {
                console.warn('[MWT:Interiority] Generation returned no result (API/parse failure). Skipping silently.');
                return null;
            }
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

        // 3-4. Validate and apply
        const { reactions, ledgerChanged } = validateAndApply(result, roster, msgIdx);
        console.log(`[MWT:Interiority] Applied: ${reactions.length} reaction(s), ledger ${ledgerChanged ? 'changed' : 'unchanged'}.`);

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

// ─── Chat lifecycle ──────────────────────────────────────────────────────────

export function onChatChanged() {
    // NOTE: do NOT unconditionally clear state.isGenerating here. A generation
    // in flight for the *previous* chat self-clears in its own finally; forcing
    // the flag false here shows stale "idle" UI and (if the work queue were
    // ever removed) could allow overlapping calls. Mirrors story_planner.
    state.contentEl = null;
    // Migrate legacy keys for this chat (no-op if already done).
    // migrateIndexKeys is async — fire-and-forget; it defers on sparse-chat forks.
    queueWork(migrateIndexKeys);
    // Clear DOM thought blocks from the previous chat
    clearAllThoughtBlocks();
    // Re-render thought blocks for the new chat
    setTimeout(() => renderAllThoughtBlocks(), 200);
    // Purge stale user-owned ledger entries before re-injecting this chat's ledger
    purgeUserLedgerEntries();
    // Re-apply injection from the new chat's ledger
    applyIntentionsInjection();
    // Re-render the tab content
    if (state.modal) renderContent();
    console.log('[MWT:Interiority] Chat changed — state reset.');
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

    // Capture the newest orphan's snapshots BEFORE deleting (needed for
    // rollback of both ledger and inner states). allKeys is sorted by
    // generatedAt descending, so the first orphan matching allKeys[0] is
    // the newest generation.
    let snapshotToRestore = null;
    let innerStatesSnapshotToRestore = null;
    const newestKey = allKeys[0];

    for (const keyToDelete of orphaned) {
        const deleted = deletePerMessage(keyToDelete);
        if (keyToDelete === newestKey && deleted) {
            if (Array.isArray(deleted.ledgerSnapshot)) snapshotToRestore = deleted.ledgerSnapshot;
            if (deleted.innerStatesSnapshot) innerStatesSnapshotToRestore = deleted.innerStatesSnapshot;
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
            queueWork(() => generateForCurrentMessage(msgKey));
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
 * blocks for newly-visible messages and retry deferred key migration.
 *
 * On upstream ST this is never called (the event doesn't exist).
 */
export function onMoreMessagesLoaded() {
    // Retry key migration (it defers if chat wasn't hydrated — now it may be)
    queueWork(migrateIndexKeys);
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

// ─── Settings sync ───────────────────────────────────────────────────────────

export { syncGlobalSettings };