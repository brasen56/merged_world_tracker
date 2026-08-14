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

import { getSettings, saveSettings, hasValidSettings } from './settings.js';
import {
    state, getPlanData, setPlanSetting,
    getArcs, serializeArcsToText, incrementArcTurns,
    isInjectionEnabled, isAutoEnabled, getAutoInterval,
    persistAutoCounter, resetAutoCounter,
    getArcsAwaitingBeat, takeDueNudges, advanceBeat, getCurrentBeat, getNudgeTurns,
} from './data.js';
import { applyPlanInjection, getInjectedTokenCount } from './injection.js';
import { generatePlan } from './generation.js';
import { renderContent, wireEvents, renderArcs, refreshDisplay } from './render.js';

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
    notify(
        'Story Planner',
        `Waiting ${first.turnsSinceAdvance} turns: "${shortBeat(getCurrentBeat(first))}"${extra}. `
        + 'Type /wt-beat to review, /wt-beat <n> to mark one planted.',
        'info',
    );
}

/**
 * Beat progress summary for the floating button badge.
 * @returns {{awaiting: number, overdue: number}}
 */
export function getBeatStatus() {
    const awaiting = getArcsAwaitingBeat();
    const threshold = getNudgeTurns();
    return {
        awaiting: awaiting.length,
        overdue: awaiting.filter(a => (a.turnsSinceAdvance || 0) >= threshold).length,
    };
}

/**
 * The numbered beat list `/wt-beat` shows. The index is the number the user
 * types, so it must match the order {@link markBeatPlanted} resolves against —
 * both derive from getArcsAwaitingBeat() for exactly that reason.
 */
export function listBeats() {
    return getArcsAwaitingBeat().map((arc, i) => ({
        n: i + 1,
        id: arc.id,
        title: arc.title || '(untitled arc)',
        beat: getCurrentBeat(arc),
        waited: arc.turnsSinceAdvance || 0,
        step: `${(arc.beatIndex || 0) + 1}/${arc.beats?.length || 0}`,
    }));
}

/**
 * Mark the nth waiting beat planted, from the chat rather than the modal.
 *
 * @param {number} n — 1-based, as shown by {@link listBeats}
 * @returns {{ok: boolean, message: string}}
 */
export function markBeatPlanted(n) {
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

    const done = (updated.beatIndex || 0) >= (updated.beats?.length || 0);
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
 * this". core/ui.js also uses this as the "does a plan exist" check that drives
 * the floating button's state.
 */
export function getPlanTextForMacro() {
    if (!isInjectionEnabled()) return '';
    return serializeArcsToText(getArcs().filter(a => a.status !== 'dropped'));
}