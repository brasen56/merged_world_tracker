/**
 * story_planner/index.js — Story Planner module (thin orchestrator).
 *
 * Public API: { init, render, applyPlanInjection, onMessageReceived,
 *               onChatChanged, onMessageDeleted, … }
 *
 * Sub-modules:
 *   settings.js   — settings manager and defaults (leaf)
 *   data.js       — shared constants, mutable state, data access (leaf)
 *   prompts.js    — system prompt templates (leaf)
 *   injection.js  — prompt injection logic
 *   generation.js — LLM plan generation
 *   render.js     — UI rendering, event wiring
 */

import { syncSharedConnectionSettings, notify, getChat, captureScope, assertSameScope, getOrCreateReceiptIdentity } from '../core/index.js';
// Part 6 (§7.4) pause guard. Direct import (not the barrel) so the REAL pause
// singleton is read even under the test barrel→stub alias — the same rule
// story_planner/generation.js follows.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { storyPlannerSchema } from './schema.js';

import { getSettings, saveSettings, hasValidSettings } from './settings.js';
import {
    state, getPlanData, getPhase7Metrics, setPlanSetting,
    getArcs, serializeArcsToText, incrementArcTurns,
    isInjectionEnabled, isAutoEnabled, getAutoInterval,
    persistAutoCounter, resetAutoCounter,
    getArcsAwaitingBeat, getOverdueReadyArcs, takeDueNudges, advanceBeat, getCurrentBeat, getCurrentBeatNumber, getBeatProgress, isArcReady, getNudgeTurns,
    setArcStatus,
} from './data.js';
import { applyPlanInjection, getArcsForInjection, getInjectedTokenCount } from './injection.js';
import { generatePlan } from './generation.js';
import { closeProgressReviewModal, closeTargetedReviewModal, refreshProgressReviewModal, renderContent, wireEvents, renderArcs, refreshDisplay } from './render.js';
import { clearProgressSuggestions, staleProgressSuggestionsAt, staleProgressSuggestionsFrom } from './progress.js';

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        state.modal = parentModal;
        state.contentEl = null;
        renderContent();
    }
    applyPlanInjection();
    console.log('[MWT:StoryPlanner] Module initialized');
}

export function render() {
    // Placeholder — init() / getModuleWireEvents() will call renderContent()
    return '<div style="text-align:center;padding:20px;color:var(--mwt-text-dim)">Loading story planner…</div>';
}

export { applyPlanInjection };

export function getModuleRender() { return render; }
export function getModuleWireEvents() {
    return () => {
        // Modal body is rebuilt on open; re-query + re-render.
        state.contentEl = null;
        renderContent();
        // wireEvents references state.modal and binds via querySelector,
        // so it is safe to call again after re-render.
        wireEvents();
    };
}

// ─── Event hooks ─────────────────────────────────────────────────────────────

export async function onMessageReceived({ countMessage = true } = {}) {
    // Track chat length so onMessageDeleted can compute the number of removed
    // messages during bulk deletes (e.g. "delete above/below"). This must run
    // every turn — it is NOT gated by the panic switch (countMessage) or by the
    // auto-generate setting — so onMessageDeleted always computes `removed`
    // from a live length instead of a frozen one. (Hoisted above the early
    // returns for PANIC-COUNTER-SYMMETRY.)
    const chat = getChat() || [];
    state.lastChatLength = chat.length;

    // Beat aging, due-beat nudges, counting, and generation are all gated by
    // the panic switch. Before the router started threading countMessage, these
    // never ran during a panic window anyway (the router bailed before calling
    // us), so gating them here preserves that behaviour exactly.
    if (!countMessage) return;

    // Age every active arc's current beat. This runs BEFORE the auto-generate
    // early-return on purpose: beat ages drive the "still waiting after N
    // turns" nudge in the injection, and that has to work whether or not
    // auto-generate is enabled (it is off by default).
    //
    // Re-applying the injection when an age changed is what makes that nudge
    // real. The injected payload is a snapshot string handed to ST's
    // setExtensionPrompt (core/injection.js), so it is frozen until something
    // calls applyPlanInjection() again — and nothing on the plain message path
    // used to. The overdue line was being computed from ages the model never saw.
    if (incrementArcTurns()) applyPlanInjection();
    if (state.modal) refreshDisplay();

    // Remind the user about beats that have been waiting too long, so tracking
    // progress does not depend on them remembering to open the modal.
    notifyDueBeats();

    if (!isAutoEnabled() || !hasValidSettings()) return;

    state.autoCounter++;
    const receipt = [...chat].reverse().find(msg => msg && !msg.is_user && !msg.is_system);
    if (receipt) {
        const key = getReceiptIdentity(receipt);
        state.countedReceiptEvents.set(key, (state.countedReceiptEvents.get(key) || 0) + 1);
    }
    persistAutoCounter();

    const interval = getAutoInterval();
    console.log(`[MWT:StoryPlanner] MESSAGE_RECEIVED — counter ${state.autoCounter}/${interval}`);

    if (state.autoCounter < interval) return;

    console.log(`[MWT:StoryPlanner] Auto-generate at ${state.autoCounter} messages`);
    resetAutoCounter();
    // STORY-PLANNER-01: Capture scope at schedule time so the deferred closure
    // can detect if the chat changed during the 1.5s delay. Uses the scope
    // guard (getCurrentChatId + epoch) instead of the old weak key.
    const scopeBefore = captureScope();
    try {
        // STORY-PLANNER-03: Use a single stored, cancellable timer instead of
        // a fire-and-forget setTimeout. Every qualifying MESSAGE_RECEIVED used
        // to call setTimeout independently — timers raced, a rejected run had
        // already reset the counter, and a chat-switch cancel had no handle to
        // clear. Clearing the previous timer before scheduling a new one keeps
        // the cadence aligned and guarantees only one generation can be queued.
        if (state.autoTimer) clearTimeout(state.autoTimer);
        // Delay slightly so ST finishes saving the chat first.
        state.autoTimer = setTimeout(async () => {
            state.autoTimer = null;
            try {
                if (!isAutoEnabled() || !hasValidSettings()) {
                    console.log('[MWT:StoryPlanner] Deferred auto-generate aborted — Auto disabled or API unset.');
                    return;
                }
                const scopeResult = assertSameScope(scopeBefore);
                if (!scopeResult.ok) {
                    console.log(`[MWT:StoryPlanner] Deferred auto-generate aborted — chat changed during delay (${scopeResult.reason}).`);
                    return;
                }
                const arcs = await generatePlan(true);
                if (arcs) {
                    // Refresh the arc list if the modal is open. renderArcs()
                    // swaps only the #sp-arcs innerHTML, so the delegated
                    // listeners and any open <details> elsewhere survive.
                    if (state.modal) renderArcs();
                    notify('Story Planner', `Auto-generated a new story plan (${arcs.length} arcs).`, 'info');
                }
            } catch (err) {
                console.warn('[MWT:StoryPlanner] Auto-generate failed:', err.message);
            }
        }, 1500);
    } catch (err) {
        console.warn('[MWT:StoryPlanner] Auto-generate scheduling failed:', err.message);
    }
}

export function onChatChanged() {
    closeTargetedReviewModal();
    closeProgressReviewModal();
    clearProgressSuggestions();
    // NOTE: do NOT unconditionally clear state.isGenerating here. A generation
    // in flight for the *previous* chat self-clears in its own finally; forcing
    // the flag false here lets a second generation start concurrently against
    // the new chat (double API calls, interleaved busy notifications). The
    // generate path also discards cross-chat results, so leaving the flag is
    // safe.
    // STORY-PLANNER-03: Cancel any pending auto-generate timer. The timer's
    // own scope check would discard its result, but leaving it running wastes
    // the API call and risks a generation kicking off for the new chat while
    // the old one's counter was just restored.
    if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
    // Restore the per-chat auto counter (each chat tracks its own progress)
    const saved = getPlanData()?.autoCounter;
    state.autoCounter = (typeof saved === 'number' && Number.isFinite(saved)) ? saved : 0;
    state.countedReceiptEvents = new Map((Array.isArray(getPlanData()?.countedReceiptEvents) ? getPlanData().countedReceiptEvents : [])
        .filter(([key, count]) => typeof key === 'string' && key && Number.isInteger(count) && count > 0));
    persistAutoCounter();
    // Track chat length for bulk-delete counter adjustment
    const chat = getChat() || [];
    state.lastChatLength = chat.length;
    applyPlanInjection();
    console.log('[MWT:StoryPlanner] Chat changed — state reset.');
}

/**
 * The scope-INDEPENDENT half of onChatChanged(), run by index.js's
 * CHAT_CHANGED handler while the storyPlanner store is paused for this chat
 * (Part 6 §7.4/§5.4). Cancels the pending auto-generate timer (its own scope
 * check would discard the result, but the API call would still be spent) and
 * clears the previous chat's injection via the applier's paused branch —
 * without one read of the blocked store (no counter restore, no
 * persistAutoCounter(); the write seam would refuse anyway).
 */
export function onChatChangedWhilePaused() {
    closeTargetedReviewModal();
    closeProgressReviewModal();
    clearProgressSuggestions();
    if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
    applyPlanInjection();
    console.log('[MWT:StoryPlanner] Chat changed while paused — injection cleared, auto timer cancelled (store hydration skipped).');
}

// ─── Delete awareness ────────────────────────────────────────────────────────

/**
 * A message (or messages) was deleted. Decrement the auto counter so the
 * "every N messages" cadence stays aligned with the shorter chat.
 *
 * @param {number} deletedIndex - chat-array index of the removed message
 * @param {{ adjustCounters?: boolean }} [opts] - When false (panic switch on),
 *   the counter decrement is skipped but bookkeeping still runs.
 */
export function onMessageDeleted(deletedIndex, { adjustCounters = true } = {}) {
    staleProgressSuggestionsFrom(Number.isInteger(deletedIndex) ? deletedIndex : null, 'The cited message was deleted.');
    refreshProgressReviewModal();
    if (typeof deletedIndex !== 'number') return;

    // SillyTavern fires a single MESSAGE_DELETED event for bulk deletes
    // ("delete above/below"), so compute the actual number removed by comparing
    // against the cached chat length. Falls back to 1 for single deletes.
    const currentLen = getChat()?.length || 0;
    const removed = state.lastChatLength > currentLen
        ? state.lastChatLength - currentLen
        : 1;
    const liveReceiptKeys = new Set((getChat() || []).filter(msg => msg && !msg.is_user && !msg.is_system).map(getReceiptIdentity));
    let removedReceipts = 0;
    let provenanceChanged = false;
    for (const [key, count] of state.countedReceiptEvents) {
        if (!liveReceiptKeys.has(key)) {
            removedReceipts += count;
            state.countedReceiptEvents.delete(key);
            provenanceChanged = true;
        }
    }
    // Bookkeeping — ALWAYS live
    state.lastChatLength = currentLen;

    if (adjustCounters && isAutoEnabled() && state.autoCounter > 0) {
        state.autoCounter = Math.max(0, state.autoCounter - removedReceipts);
        persistAutoCounter();
        console.log(`[MWT:StoryPlanner] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed} entries / ${removedReceipts} receipts) — counter adjusted to ${state.autoCounter}`);
    }
    else if (provenanceChanged) persistAutoCounter();
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
}

export function onMessageSwiped(messageIndex) {
    staleProgressSuggestionsAt(messageIndex, 'The cited message was swiped.');
    refreshProgressReviewModal();
}

export function onMessageEdited(messageIndex) {
    staleProgressSuggestionsAt(messageIndex, 'The cited message was edited.');
    refreshProgressReviewModal();
}

function getReceiptIdentity(message) {
    return getOrCreateReceiptIdentity(message);
}

// ─── Beat reminders + chat-side confirmation ─────────────────────────────────

/** Trim a beat to something that fits in a toast without wrapping forever. */
function shortBeat(text, max = 90) {
    const s = String(text || '').trim();
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Toast the user about beats that have been waiting too long.
 *
 * Deliberately does NOT open the modal or advance anything by itself — the
 * reminder exists so the user can decide, and `/wt-beat` lets them act on it
 * without leaving the chat.
 */
function notifyDueBeats() {
    let due = [];
    try {
        due = takeDueNudges();
    } catch (err) {
        console.warn('[MWT:StoryPlanner] Beat reminder check failed:', err.message);
        return;
    }
    if (!due.length) return;

    const [first] = due;
    const extra = due.length > 1 ? ` (and ${due.length - 1} more)` : '';
    const ready = isReadyArc(first);
    notify(
        'Story Planner',
        ready
            ? `Ready ${first.turnsSinceAdvance} turns: "${shortBeat(first.title)}"${extra}. Type /wt-beat to review, /wt-beat resolve R1 to resolve a Ready arc.`
            : `Waiting ${first.turnsSinceAdvance} turns: "${shortBeat(getCurrentBeat(first))}"${extra}. Type /wt-beat to review, /wt-beat <n> to mark one planted.`,
        'info',
    );
}

/**
 * Beat progress summary for the floating button badge.
 * Shared Story Planner status projection for Overview and floating UI.
 * @returns {{active: number, injected: number, focused: number, ready: number,
 *   parked: number, awaiting: number, overdue: number}}
 */
export function getBeatStatus() {
    const arcs = getArcs();
    const activeArcs = arcs.filter(arc => arc.status === 'active');
    const awaiting = getArcsAwaitingBeat();
    const threshold = getNudgeTurns();
    const observation = getPlannerObservation();
    return {
        active: activeArcs.length,
        injected: isInjectionEnabled() ? getArcsForInjection().length : 0,
        focused: activeArcs.filter(arc => arc.focused).length,
        ready: activeArcs.filter(isArcReady).length,
        parked: arcs.filter(arc => arc.status === 'parked').length,
        awaiting: awaiting.length,
        overdue: awaiting.filter(a => (a.turnsSinceAdvance || 0) >= threshold).length
            + getOverdueReadyArcs(threshold).length,
        lastProgressCheckAt: observation.lastProgressCheckAt,
        lastProgressSuggestions: observation.lastProgressSuggestions,
        progressChecks: observation.progressChecks,
        targetedGenerations: observation.targetedGenerations,
        fullGenerations: observation.fullGenerations,
    };
}

/** Content-free Phase 7 observation snapshot for Health, Overview, and QA. */
export function getPlannerObservation() {
    const metrics = getPhase7Metrics();
    return {
        ...metrics,
        averageRequestChars: metrics.requestCount
            ? Math.round(metrics.requestChars / metrics.requestCount)
            : 0,
        proposalDecisions: metrics.progressAccepted + metrics.progressIgnored,
    };
}

/**
 * The numbered beat list `/wt-beat` shows. The index is the number the user
 * types, so it must match the order {@link markBeatPlanted} resolves against —
 * both derive from getArcsAwaitingBeat() for exactly that reason.
 */
export function listBeats() {
    return getArcsAwaitingBeat().map((arc, i) => {
        const progress = getBeatProgress(arc);
        return {
            n: i + 1,
            id: arc.id,
            title: arc.title || '(untitled arc)',
            beat: getCurrentBeat(arc),
            waited: arc.turnsSinceAdvance || 0,
            step: `${getCurrentBeatNumber(arc)}/${progress.total}`,
        };
    });
}

function isReadyArc(arc) {
    return arc?.status === 'active' && isArcReady(arc);
}

/** Ready arcs use a separate namespace so numeric waiting-beat references stay stable. */
export function listReadyArcs() {
    return getArcs()
        .filter(isReadyArc)
        .sort((a, b) => Number(b.focused) - Number(a.focused))
        .map((arc, i) => ({
            n: i + 1,
            ref: `R${i + 1}`,
            id: arc.id,
            title: arc.title || '(untitled arc)',
            waited: arc.turnsSinceAdvance || 0,
        }));
}

export function resolveReadyArc(ref) {
    if (isStorePausedForCurrentScope(storyPlannerSchema.id)) {
        return { ok: false, message: 'Story Planner is paused for this chat — its data could not be safely prepared.' };
    }
    const match = String(ref || '').trim().toUpperCase().match(/^R(\d+)$/);
    if (!match) return { ok: false, message: 'Use a Ready reference such as R1.' };
    const target = listReadyArcs()[Number(match[1]) - 1];
    if (!target) return { ok: false, message: 'That Ready arc no longer exists.' };
    const updated = setArcStatus(target.id, 'resolved');
    if (!updated) return { ok: false, message: 'That arc no longer exists.' };
    applyPlanInjection();
    if (state.modal) refreshDisplay();
    return { ok: true, message: `"${target.title}" — resolved.` };
}

/**
 * Mark the nth waiting beat planted, from the chat rather than the modal.
 *
 * @param {number} n — 1-based, as shown by {@link listBeats}
 * @returns {{ok: boolean, message: string}}
 */
export function markBeatPlanted(n) {
    // Part 6 (§7.4): /wt-beat bypasses the event router's decline predicate,
    // and while paused the write seam (setPlanData) keeps the previous value
    // while updateArc still returns its merged arc — advanceBeat would look
    // successful and the command would reply "— planted." over a write that
    // never landed. Refuse before any state is read. (Non-throwing contract:
    // core/commands.js prints result.message verbatim.)
    if (isStorePausedForCurrentScope(storyPlannerSchema.id)) {
        console.warn('[MWT:StoryPlanner] Cannot mark a beat planted — the store is paused for this chat (schema preparation).');
        return {
            ok: false,
            message: 'Story Planner is paused for this chat — its data could not be safely prepared. Use ⬇ Download recovery data to repair it, then press Retry in the Story Planner tab.',
        };
    }
    const beats = listBeats();
    if (!beats.length) return { ok: false, message: 'No arcs are waiting on a setup beat.' };

    const idx = Number(n);
    if (!Number.isInteger(idx) || idx < 1 || idx > beats.length) {
        return { ok: false, message: `Pick a number between 1 and ${beats.length}.` };
    }

    const target = beats[idx - 1];
    const updated = advanceBeat(target.id);
    if (!updated) return { ok: false, message: 'That arc no longer exists.' };

    applyPlanInjection();
    if (state.modal) refreshDisplay();

    const done = isArcReady(updated);
    return {
        ok: true,
        message: done
            ? `"${target.title}" — all setup planted. It is now Ready.`
            : `"${target.title}" — planted. Next: ${shortBeat(getCurrentBeat(updated))}`,
    };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function isGenerating() {
    return state.isGenerating;
}

export function getTotalTokens() {
    return getInjectedTokenCount();
}

export function getAutoPlanStatus() {
    if (!isAutoEnabled()) return null;
    return {
        counter: state.autoCounter,
        interval: getAutoInterval(),
    };
}

export function syncGlobalSettings(patch) {
    return syncSharedConnectionSettings(getSettings, saveSettings, patch, '[MWT:StoryPlanner]');
}

// ─── Slash commands / macros ─────────────────────────────────────────────────

export async function triggerGenerate() {
    return generatePlan(false);
}

export function setInjectionEnabled(enabled) {
    setPlanSetting('injectEnabled', !!enabled);
    applyPlanInjection();
}

/**
 * Text for the `{{storyplan}}` macro.
 *
 * Deliberately NOT filtered by the injection mode: that selector governs the
 * automatic injection, whereas the macro is the user placing the plan by hand.
 * Dropped arcs are excluded regardless — dropping one means "stop showing me
 * this". Resolved and parked records are likewise excluded because closed or
 * inactive records must never enter narrator injection. core/ui.js also uses this as the "does a plan exist" check that drives
 * the floating button's state.
 */
export function getPlanTextForMacro() {
    if (!isInjectionEnabled()) return '';
    return serializeArcsToText(getArcs().filter(a => a.status === 'active'));
}

/** Whether this chat retains any planner records, including deliberately parked ones. */
export function hasPlanRecords() {
    return getArcs().length > 0;
}