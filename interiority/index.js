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
    purgeUserLedgerEntries, restoreLedgerSnapshot, migrateIndexKeys,
} from './data.js';

import {
    buildSceneRoster, runBatchedCall, runStrictCalls, validateAndApply,
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
    // Migrate legacy numeric-index perMessage keys to stable send_date keys.
    // This runs once per chat (guarded by data.keyMigrationDone) and is
    // essential for Inline Summary compatibility — old keys reference
    // positions that no longer match the (possibly shrunk) chat array.
    migrateIndexKeys();
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
 *   as reported by the event. Captured NOW: in group chats or fast turns,
 *   another message can land before the queued work runs, and recomputing
 *   chat.length-1 at run time would double-generate for the newest message
 *   while the one that fired this event gets nothing.
 */
export function onMessageReceived(msgIdx) {
    const settings = getSettings();
    if (!settings.autoMode) return;
    if (!hasValidSettings()) return;

    state.lastChatLength = getChat()?.length || 0;

    const targetIdx = typeof msgIdx === 'number' ? msgIdx : (getChat()?.length ?? 0) - 1;

    // Serialize through the work queue so generations never overlap.
    queueWork(() => generateForCurrentMessage(targetIdx));
}

/**
 * Manually trigger interiority generation for the current/last AI message.
 * Used by the "💭 Generate" button and slash command.
 */
export async function triggerGenerate() {
    return queueWork(() => generateForCurrentMessage());
}

/**
 * Core generation logic — shared by auto and manual modes.
 *
 * Flow:
 *   1. Build scene roster
 *   2. Run API call (batched or strict)
 *   3. Validate JSON, apply ledger mutations
 *   4. Store reactions in perMessage (keyed by stable send_date)
 *   5. Render thought block on the message DOM
 *   6. Apply intentions injection
 *
 * @param {number} [targetIdx] - chat-array index captured when the work was
 *   queued. Omitted for manual triggers, which target the current last
 *   message. A captured index that no longer exists (message deleted while
 *   queued) skips the generation rather than mis-targeting another message.
 */
async function generateForCurrentMessage(targetIdx) {
    const ctx = getContextSafe();
    if (!ctx) return null;

    const chat = getChat();
    if (!chat || chat.length === 0) return null;

    let msgIdx;
    if (typeof targetIdx === 'number') {
        if (targetIdx < 0 || targetIdx >= chat.length) {
            console.log(`[MWT:Interiority] Skipping generation — target message ${targetIdx} no longer exists.`);
            return null;
        }
        msgIdx = targetIdx;
    } else {
        // Manual trigger: generate for the last message
        msgIdx = chat.length - 1;
    }

    // Capture chat identity for cross-chat guard
    const chatKeyBefore = `${ctx?.characterId ?? ''}|${ctx?.groupId ?? ''}|${ctx?.chatId ?? ''}`;

    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));

    try {
        // 1. Build roster
        const roster = buildSceneRoster();
        if (roster.length === 0) {
            console.log('[MWT:Interiority] No NPCs in scene — skipping.');
            return null;
        }

        console.log(`[MWT:Interiority] Generating for ${roster.length} NPC(s): ${roster.join(', ')}`);

        // 2. Run API call
        const settings = getSettings();
        let result;
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
    state.lastChatLength = getChat()?.length || 0;
    state.contentEl = null;
    // Migrate legacy keys for this chat (no-op if already done).
    migrateIndexKeys();
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
 * Whether msgIdx maps to the newest generation we have a record for.
 *
 * Ledger snapshots are only a valid rollback target for the NEWEST
 * generation — restoring an older snapshot would wipe every ledger
 * mutation (new/executed/dropped intentions) made after it.
 *
 * @param {number} msgIdx
 * @returns {boolean}
 */
function isNewestGeneration(msgIdx) {
    const keys = getPerMessageKeys(); // sorted by generatedAt descending
    if (keys.length === 0) return false;
    const newestKey = keys[0];
    const msgKey = getMsgKeyForIndex(msgIdx);
    return msgKey === newestKey;
}

/**
 * A message was deleted. Delete its perMessage entry, restore ledgerSnapshot
 * (newest generation only), and re-render.
 *
 * Because perMessage keys are now stable send_date identifiers (not chat
 * indices), deleting a message no longer requires re-keying other entries —
 * their keys remain valid regardless of the array shift. This also means
 * Inline Summary's batch summarisation won't corrupt the key→message mapping.
 *
 * @param {number} deletedIndex
 */
export function onMessageDeleted(deletedIndex) {
    if (typeof deletedIndex !== 'number') return;

    // SillyTavern fires MESSAGE_DELETED *after* removing the message from the
    // chat array. That means getMsgKeyForIndex(deletedIndex) would resolve to
    // the send_date of whatever message shifted into that position — the WRONG
    // key. Instead, we find the orphaned perMessage key: the one whose
    // send_date no longer exists in the (now-shrunk) chat array.
    //
    // This approach is timing-agnostic: it works whether ST fires before or
    // after the actual array mutation, because it relies on the *current*
    // state of the chat, not on the deleted index.
    const allKeys = getPerMessageKeys();
    if (allKeys.length === 0) return;

    const chat = getChat();
    const currentKeys = new Set();
    for (const msg of chat) {
        if (msg?.send_date) currentKeys.add(`sd-${msg.send_date}`);
    }

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

    // Capture the newest orphan's snapshot BEFORE deleting (needed for
    // ledger rollback). allKeys is sorted by generatedAt descending, so
    // the first orphan that matches allKeys[0] is the newest generation.
    let snapshotToRestore = null;
    const newestKey = allKeys[0];

    for (const keyToDelete of orphaned) {
        const deleted = deletePerMessage(keyToDelete);
        if (keyToDelete === newestKey && deleted && Array.isArray(deleted.ledgerSnapshot)) {
            snapshotToRestore = deleted.ledgerSnapshot;
        }
    }

    // Restore the ledger snapshot only if the newest generation was deleted.
    // Restoring an older snapshot would wipe ledger mutations made after it.
    if (snapshotToRestore) {
        restoreLedgerSnapshot(snapshotToRestore);
        console.log(`[MWT:Interiority] MESSAGE_DELETED — ledger snapshot restored (manual entries preserved).`);
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

    if (wasNewest && deleted && Array.isArray(deleted.ledgerSnapshot)) {
        restoreLedgerSnapshot(deleted.ledgerSnapshot);
        console.log(`[MWT:Interiority] ${eventName} at index ${msgIdx} — ledger snapshot restored (manual entries preserved).`);
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
        const msg = getChat()?.[msgIdx];
        const isFreshSwipeSlot = Array.isArray(msg?.swipes)
            && (msg.swipe_id ?? 0) >= msg.swipes.length;
        if (isFreshSwipeSlot) {
            console.log(`[MWT:Interiority] ${eventName} opened a fresh swipe slot — deferring generation to MESSAGE_RECEIVED.`);
        } else {
            queueWork(() => generateForCurrentMessage(msgIdx));
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
    const ledger = getLedger();
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