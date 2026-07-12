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
    getInteriorityData, saveInteriorityData, getLedger, setLedger,
    deletePerMessage, getPerMessageIndices,
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
 */
export function onMessageReceived() {
    const settings = getSettings();
    if (!settings.autoMode) return;
    if (!hasValidSettings()) return;

    state.lastChatLength = getChat()?.length || 0;

    // Serialize through the work queue so generations never overlap.
    queueWork(() => generateForCurrentMessage());
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
 *   4. Store reactions in perMessage[msgIdx]
 *   5. Render thought block on the message DOM
 *   6. Apply intentions injection
 */
async function generateForCurrentMessage() {
    const ctx = getContextSafe();
    if (!ctx) return null;

    const chat = getChat();
    if (!chat || chat.length === 0) return null;

    // Generate for the last message (the most recent AI message)
    const msgIdx = chat.length - 1;

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
    state.isGenerating = false;
    state.lastChatLength = getChat()?.length || 0;
    state.contentEl = null;
    // Clear DOM thought blocks from the previous chat
    clearAllThoughtBlocks();
    // Re-render thought blocks for the new chat
    setTimeout(() => renderAllThoughtBlocks(), 200);
    // Re-apply injection from the new chat's ledger
    applyIntentionsInjection();
    // Re-render the tab content
    if (state.modal) renderContent();
    console.log('[MWT:Interiority] Chat changed — state reset.');
}

// ─── Swipe / edit / delete rollback (§9) ─────────────────────────────────────

/**
 * Whether msgIdx is the newest generation we have a record for.
 *
 * Ledger snapshots are only a valid rollback target for the NEWEST
 * generation — restoring an older snapshot would wipe every ledger
 * mutation (new/executed/dropped intentions) made after it.
 *
 * @param {number} msgIdx
 * @returns {boolean}
 */
function isNewestGeneration(msgIdx) {
    const indices = getPerMessageIndices(); // sorted descending
    return indices.length > 0 && msgIdx === indices[0];
}

/**
 * A message was deleted. Delete perMessage[idx], restore ledgerSnapshot
 * (newest generation only), and adjust subsequent perMessage keys.
 *
 * @param {number} deletedIndex
 */
export function onMessageDeleted(deletedIndex) {
    if (typeof deletedIndex !== 'number') return;

    const wasNewest = isNewestGeneration(deletedIndex);
    const deleted = deletePerMessage(deletedIndex);

    if (wasNewest && deleted && Array.isArray(deleted.ledgerSnapshot)) {
        setLedger(deleted.ledgerSnapshot);
        console.log(`[MWT:Interiority] MESSAGE_DELETED at index ${deletedIndex} — ledger snapshot restored.`);
    }

    // Re-key perMessage entries: any index > deletedIndex needs to shift down by 1
    const indices = getPerMessageIndices().sort((a, b) => a - b); // ascending
    const data = getInteriorityData();
    const newPerMessage = {};
    for (const idx of indices) {
        if (idx === deletedIndex) continue; // already deleted
        const newIdx = idx > deletedIndex ? idx - 1 : idx;
        newPerMessage[String(newIdx)] = data.perMessage[String(idx)];
    }
    data.perMessage = newPerMessage;
    saveInteriorityData(data);

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

    const wasNewest = isNewestGeneration(msgIdx);
    const deleted = deletePerMessage(msgIdx);

    if (wasNewest && deleted && Array.isArray(deleted.ledgerSnapshot)) {
        setLedger(deleted.ledgerSnapshot);
        console.log(`[MWT:Interiority] ${eventName} at index ${msgIdx} — ledger snapshot restored.`);
    }

    applyIntentionsInjection();
    renderAllThoughtBlocks();

    // Re-generate only when the last chat message was affected — editing an
    // older message shouldn't spend an API call re-reading the same scene.
    const isLastMessage = msgIdx === (getChat()?.length ?? 0) - 1;
    const settings = getSettings();
    if (isLastMessage && settings.autoMode && hasValidSettings()) {
        queueWork(() => generateForCurrentMessage());
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

// ─── Settings sync ───────────────────────────────────────────────────────────

export { syncGlobalSettings };