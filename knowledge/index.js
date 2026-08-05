/**
 * knowledge/index.js — Public API barrel for the Knowledge module.
 *
 * Re-exports lifecycle hooks, slash-command handlers, and macro helpers
 * consumed by the root index.js.  All implementation lives in sub-files.
 */

import { getChat, escapeRegex, estimateTokens, getChatMeta, patchChatMeta, captureScope, assertSameScope } from '../core/index.js';

import { state, COUNTERS_META_KEY } from './state.js';
import { getSettings, hasValidSettings, syncGlobalSettings } from './settings.js';
import { getRegistry, getRegistryEntry, getAllNpcNames, getStateRegistry, bumpStateTrackerTimestamp, adjustStateTrackerLastUpdatedMsg } from './registry.js';
import { loadEntryContent, loadStateTrackerEntry, runScan, runStateUpdate, queueTrackerWork, getRecentMessages, enrichStagingItem } from './lorebook.js';
import { buildStagingItems, mergeScanResults } from './staging.js';
import { resetStoreCache, hydrateCurrentBooks } from './store.js';
import { runContinuousCaptureAll } from './growth.js';
import { runRelationshipExtract, syncRelationshipsToLorebook } from './relationships.js';
import {
    renderNpcsSubTab,
    addNotificationEntry, removeNotificationEntry,
    initNotificationPanel, hideNotificationPanel,
} from './render.js';

// ─── Per-chat counter persistence ────────────────────────────────────────────
//
// World State, Chronicle, and Story Planner all persist their auto-trigger
// counters per chat (via chat metadata) and restore them in onChatChanged().
// Knowledge's messageCounter / npcMessageCounter used to be memory-only,
// silently resetting on reload or chat switch.  The helpers below mirror the
// pattern used by the other modules so behaviour is consistent.

export function persistCounters() {
    patchChatMeta(COUNTERS_META_KEY, {
        messageCounter: state.messageCounter,
        npcMessageCounter: state.npcMessageCounter,
        growthMessageCounter: state.growthMessageCounter,
        relationshipMessageCounter: state.relationshipMessageCounter,
    });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        state.modal = parentModal;
        state.npcsContentEl = null;
        state.stateContentEl = null;
    }
    initNotificationPanel();
    // Load the registry stores for whatever chat is already open. Without this,
    // a user who reloads (or upgrades) while sitting in a chat would have no
    // hydrated store until they switched chats, and every write would be
    // refused in the meantime. Safe to run before a chat exists: the scope
    // resolver falls back to the global books, and CHAT_CHANGED re-points them.
    reloadStores('init');
    console.log('[MWT:Knowledge] Module initialized');
}

export function render() {
    return '<div id="mwt-kt-npcs-content"></div>';
}

export function getModuleRender() { return render; }

export function getModuleWireEvents() {
    return () => {
        state.npcsContentEl = null;
        state.stateContentEl = null;
        renderNpcsSubTab();
    };
}

// ─── Event hooks ─────────────────────────────────────────────────────────────

export function onMessageReceived() {
    const settings = getSettings();
    const stateAuto = !!settings.autoTriggerEnabled;
    const npcAuto = !!settings.npcAutoScanEnabled;
    const growthAuto = !!settings.growthAutoCaptureEnabled;
    const relAuto = !!settings.relationshipAutoExtractEnabled;
    if (!stateAuto && !npcAuto && !growthAuto && !relAuto) return;
    if (!hasValidSettings()) return;

    // Track chat length so onMessageDeleted can compute the number of removed
    // messages during bulk deletes (e.g. "delete above/below").
    state.lastChatLength = getChat()?.length || 0;

    let doState = false;
    let doNpc = false;

    if (stateAuto) {
        const everyN = Math.max(1, Number(settings.autoTriggerEveryN) || 5);
        state.messageCounter++;
        if (state.messageCounter >= everyN) {
            state.messageCounter = 0;
            doState = true;
        }
    }

    if (npcAuto) {
        const everyN = Math.max(1, Number(settings.npcAutoScanEveryN) || 10);
        state.npcMessageCounter++;
        if (state.npcMessageCounter >= everyN) {
            state.npcMessageCounter = 0;
            doNpc = true;
        }
    }

    let doGrowth = false;
    if (growthAuto) {
        const everyN = Math.max(1, Number(settings.growthAutoCaptureEveryN) || 15);
        state.growthMessageCounter++;
        if (state.growthMessageCounter >= everyN) {
            state.growthMessageCounter = 0;
            doGrowth = true;
        }
    }

    let doRel = false;
    if (relAuto) {
        const everyN = Math.max(1, Number(settings.relationshipAutoExtractEveryN) || 10);
        state.relationshipMessageCounter++;
        if (state.relationshipMessageCounter >= everyN) {
            state.relationshipMessageCounter = 0;
            doRel = true;
        }
    }

    // Persist counters so they survive reloads and chat switches (mirrors World
    // State, Chronicle, and Story Planner behaviour).
    persistCounters();

    // Continuous growth capture (Part A) runs on its own cadence and does NOT
    // go through the staging queue — it appends silently to the evidence store
    // (no UI staging). Fire it independently so it doesn't block on scan/state
    // work, and guard against cross-chat contamination.
    if (doGrowth) {
        // KNOWLEDGE-04: Capture scope for the cross-chat guard. Uses the scope
        // guard (getCurrentChatId + epoch) instead of the old weak key.
        const scopeGrowth = captureScope();
        // Start toast is gated behind a debug setting. At the default cadence
        // (every 15 messages) firing a toast every cycle is noisy for normal
        // roleplay. Completion toasts fire only on actual results/errors.
        if (settings.growthDebugToasts) {
            import('../core/index.js').then(({ notify }) =>
                notify('Knowledge Tracker', '🌱 Auto-capturing growth evidence…', 'info')
            );
        }
        runContinuousCaptureAll().then(async ({ results, errors }) => {
            // KNOWLEDGE-04: Assert scope after the API call.
            if (!assertSameScope(scopeGrowth).ok) {
                console.log('[MWT:Knowledge] Continuous capture results discarded — chat changed during API call.');
                // If the start toast was shown (debug mode), resolve it so the
                // user isn't left with a dangling "Auto-capturing…" popup that
                // never completes. A quiet "cancelled" note explains the
                // disappearance.
                if (settings.growthDebugToasts) {
                    const { notify } = await import('../core/index.js');
                    notify('Knowledge Tracker', '🌱 Growth capture cancelled (chat changed).', 'info');
                }
                return;
            }
            const { notify } = await import('../core/index.js');
            const total = results.reduce((s, r) => s + r.added, 0);

            // Increment the unread growth evidence counter so the floating
            // button pulses green — a persistent, visible signal that new
            // evidence is waiting to be reviewed, even when the MWT modal is
            // closed. Mirrors the staging-proposal pulse (orange) already in
            // place for scan/state proposals.
            if (total > 0) {
                state.unreadGrowthEvidenceCount += total;
                document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
            }

            // Only notify on meaningful outcomes. Firing a "no new observations
            // found" toast every cadence cycle (default 15 msgs) is noisy in
            // normal roleplay — that's the no-op case, not a result the user
            // needs to know about.
            //
            // Failures are ALWAYS reported: runContinuousCaptureAll catches
            // per-NPC errors so one bad NPC doesn't stop the rest, which means
            // a failed run resolves with empty results. Reporting `errors`
            // explicitly stops a token-limit failure from being mistaken for a
            // clean "found nothing".
            if (errors.length > 0) {
                const lengthErrs = errors.filter(e => e.isLength);
                const detail = lengthErrs.length > 0
                    ? `token limit hit for ${lengthErrs.map(e => e.npc).join(', ')} — raise Max Tokens or lower the capture cadence`
                    : errors[0].message;
                const partial = total > 0 ? ` (+${total} captured for ${results.length} other NPC(s))` : '';
                notify('Knowledge Tracker', `🌱 Growth capture failed for ${errors.length} NPC(s): ${detail}.${partial}`, 'error');
            } else if (results.length > 0) {
                notify('Knowledge Tracker', `🌱 Growth capture done: +${total} observation(s) for ${results.length} NPC(s).`, 'success');
            }
            // No toast for "attempted but found nothing" — that's the quiet
            // no-op path. Errors (above) are the exception.
        }).catch(err => {
            console.warn('[MWT:Knowledge] Continuous capture pass failed:', err.message);
            import('../core/index.js').then(({ notify }) =>
                notify('Knowledge Tracker', `🌱 Growth capture failed: ${err.message}`, 'error')
            );
        });
    }

    if (!doState && !doNpc && !doRel) return;

    const cooldownMsgs = Math.max(0, Number(settings.trackerCooldownMsgs) || 3);

    // KNOWLEDGE-04: Capture scope before the async scan/update so we can
    // discard results if the user switched chats during the API call. Uses
    // the scope guard instead of the old weak key.
    const scopeBefore = captureScope();

    queueTrackerWork(async () => {
        if (state.isRunning) return;
        // Abort if the chat already changed while this was queued.
        if (!assertSameScope(scopeBefore).ok) {
            console.log('[MWT:Knowledge] Queued work aborted — chat changed before execution.');
            return;
        }
        state.isRunning = true;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        try {
            // ── State tracker auto-update ──
            if (doState) {
                const reg = getStateRegistry();
                const currentMsgIdx = getChat()?.length || 0;
                const recent = getRecentMessages(50);
                let staged = 0;
                for (const [name, info] of Object.entries(reg)) {
                    if (info.enabled === false) continue;
                    if (!info.alwaysUpdate) {
                        if (currentMsgIdx - (info.lastUpdatedMsg || 0) < cooldownMsgs) continue;
                        const nameRe = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i');
                        if (!nameRe.test(recent || '')) continue;
                    }
                    // KNOWLEDGE-04: Re-check scope before each NPC update. The
                    // state-update loop straddles multiple awaits, and a chat
                    // switch mid-loop must not stage results from the old chat
                    // into the new chat's staging area.
                    if (!assertSameScope(scopeBefore).ok) {
                        console.log('[MWT:Knowledge] State-update loop aborted — chat changed mid-loop.');
                        return;
                    }
                    try {
                        const result = await runStateUpdate(name, info.uid);
                        if (result.unchanged) { bumpStateTrackerTimestamp(name); continue; }
                        const stagingItem = {
                            id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'state', action: 'update', name, data: {},
                            proposedContent: result.merged, existingContent: result.currentContent,
                            mergedContent: result.merged, keywords: [name], uid: info.uid,
                        };
                        const existingIdx = state.stagingItems.findIndex(it => it.type === 'state' && it.uid === info.uid);
                        if (existingIdx >= 0) {
                            const existing = state.stagingItems[existingIdx];
                            removeNotificationEntry(existing.id);
                            if (existing.edited) {
                                // Preserve the user's manual edits; only refresh metadata.
                                stagingItem.id = existing.id;
                                stagingItem.edited = true;
                                stagingItem.mergedContent = existing.mergedContent;
                                stagingItem.proposedContent = existing.mergedContent || existing.proposedContent;
                                stagingItem.existingContent = existing.existingContent ?? stagingItem.existingContent;
                            } else {
                                // Preserve the outgoing proposal as superseded so
                                // nothing is silently lost on re-scan.
                                const priorSuperseded = Array.isArray(existing.supersededContent) ? existing.supersededContent : [];
                                const outgoingContent = existing.mergedContent || existing.proposedContent;
                                stagingItem.id = existing.id;
                                stagingItem.supersededContent = outgoingContent
                                    ? [...priorSuperseded, { content: outgoingContent, timestamp: Date.now() }]
                                    : priorSuperseded;
                            }
                            state.stagingItems[existingIdx] = stagingItem;
                        } else {
                            state.stagingItems.push(stagingItem);
                        }
                        addNotificationEntry(stagingItem);
                        staged++;
                    } catch (err) { console.warn(`[MWT:Knowledge] Auto-update "${name}" failed:`, err.message); }
                }
                if (staged > 0) {
                    console.log(`[MWT:Knowledge] Auto-trigger: ${staged} state proposal(s) staged.`);
                    const { notify } = await import('../core/index.js');
                    notify('Knowledge Tracker', `${staged} state tracker update(s) ready for review.`, 'info');
                }
            }

            // ── NPC auto-scan ──
            if (doNpc) {
                try {
                    const result = await runScan();
                    // Re-check chat identity after the long API await. A chat
                    // switch mid-scan means these results belong to the old
                    // chat and must not be written into the new chat's staging
                    // area (cross-chat contamination).
                    // KNOWLEDGE-04: Re-check scope after the long API await.
                    if (!assertSameScope(scopeBefore).ok) {
                        console.log('[MWT:Knowledge] Auto-scan results discarded — chat changed during API call.');
                        return;
                    }
                    const newItems = buildStagingItems(result);
                    const added = mergeScanResults(newItems, removeNotificationEntry);
                    // Enrich non-edited update proposals; edited ones keep their text.
                    await Promise.all(added.filter(it => it.action === 'update' && !it.edited).map(it => enrichStagingItem(it)));
                    // KNOWLEDGE-04: Re-check scope after the enrichment awaits.
                    // enrichStagingItem performs async lorebook reads; a chat
                    // switch during those reads could mix old-chat content into
                    // the new chat's staging proposals.
                    if (!assertSameScope(scopeBefore).ok) {
                        console.log('[MWT:Knowledge] Auto-scan results discarded — chat changed during enrichment.');
                        return;
                    }
                    added.forEach(item => addNotificationEntry(item));
                    if (added.length > 0) {
                        console.log(`[MWT:Knowledge] Auto-scan: ${added.length} NPC proposal(s) staged.`);
                        const { notify } = await import('../core/index.js');
                        notify('Knowledge Tracker', `Auto-scan found ${added.length} NPC proposal(s) ready for review.`, 'info');
                    }
                    renderNpcsSubTab();
                } catch (err) {
                    console.warn('[MWT:Knowledge] Auto-scan failed:', err.message);
                }
            }

            // ── Relationship auto-extract ──
            // Serialized inside queueTrackerWork so the per-entry lorebook re-sync
            // can't race a concurrent scan writing the same entry content. The
            // extract itself only writes the relationship/stance FIELDS (synchronous
            // store writes); the sync then injects the managed block into each
            // affected NPC's entry.
            if (doRel) {
                try {
                    const extract = await runRelationshipExtract();
                    // Re-check scope after the API round-trip.
                    if (!assertSameScope(scopeBefore).ok) {
                        console.log('[MWT:Knowledge] Relationship extract discarded — chat changed during API call.');
                        return;
                    }
                    const { affectedNpcs, edgesAdded, edgesUpdated, stancesSet, skippedManual, skippedNeutral } = extract;
                    // Re-sync only the affected NPCs so the managed block reflects the
                    // new edges/stances. Skips entries whose content didn't change.
                    let synced = 0;
                    for (const name of affectedNpcs) {
                        if (!assertSameScope(scopeBefore).ok) {
                            console.log('[MWT:Knowledge] Relationship sync aborted — chat changed mid-loop.');
                            break;
                        }
                        try {
                            const r = await syncRelationshipsToLorebook(name);
                            if (r.success && !r.unchanged) synced++;
                        } catch (err) { console.warn(`[MWT:Knowledge] Relationship sync for "${name}" failed:`, err.message); }
                    }
                    const changes = edgesAdded + edgesUpdated + stancesSet;
                    console.log(
                        `[MWT:Knowledge] Auto-relationships: +${edgesAdded} edge(s), ~${edgesUpdated} updated, ` +
                        `${stancesSet} stance(s); synced ${synced}/${affectedNpcs.size} entr(ies). ` +
                        `Protected ${skippedManual} hand-entered record(s); dropped ${skippedNeutral} "neutral" non-finding(s).`
                    );
                    if (changes > 0) {
                        // Refresh the open sub-tab so the Relationships list and
                        // graph show the new edges instead of going stale until
                        // the user navigates away and back.
                        renderNpcsSubTab();
                        const { notify } = await import('../core/index.js');
                        const parts = [];
                        if (edgesAdded) parts.push(`+${edgesAdded} relationship(s)`);
                        if (edgesUpdated) parts.push(`~${edgesUpdated} updated`);
                        if (stancesSet) parts.push(`${stancesSet} stance(s) toward {{user}}`);
                        notify('Knowledge Tracker', `🔗 Relationships logged: ${parts.join(', ')}.`, 'success');
                    }
                } catch (err) {
                    console.warn('[MWT:Knowledge] Relationship extract failed:', err.message);
                    const { notify } = await import('../core/index.js');
                    notify('Knowledge Tracker', `🔗 Relationship logging failed: ${err.message}`, 'error');
                }
            }
        } finally { state.isRunning = false; document.dispatchEvent(new CustomEvent('mwt:busy-changed')); }
    });
}

export function onChatChanged() {
    // Restore per-chat counters from metadata (mirrors World State, Chronicle,
    // and Story Planner). Each chat tracks its own "every N messages" progress.
    const saved = getChatMeta()?.[COUNTERS_META_KEY];
    state.messageCounter = (typeof saved?.messageCounter === 'number' && Number.isFinite(saved.messageCounter)) ? saved.messageCounter : 0;
    state.npcMessageCounter = (typeof saved?.npcMessageCounter === 'number' && Number.isFinite(saved.npcMessageCounter)) ? saved.npcMessageCounter : 0;
    state.growthMessageCounter = (typeof saved?.growthMessageCounter === 'number' && Number.isFinite(saved.growthMessageCounter)) ? saved.growthMessageCounter : 0;
    state.relationshipMessageCounter = (typeof saved?.relationshipMessageCounter === 'number' && Number.isFinite(saved.relationshipMessageCounter)) ? saved.relationshipMessageCounter : 0;
    state.lastChatLength = getChat()?.length || 0;
    state.isRunning = false;
    state.stagingItems = [];
    state.activeItemId = null;
    state.activeSubTab = 'staging';
    state._cachedTokenCount = 0;
    state.notificationEntries = {};
    // Reset the growth evidence badge counter for the new chat — unread
    // evidence from the previous chat shouldn't follow the user here.
    state.unreadGrowthEvidenceCount = 0;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    hideNotificationPanel();
    document.querySelectorAll('#kt-view-modal').forEach(m => m.remove());

    // Re-point the registry stores at whatever lorebooks the new chat resolves
    // to. This is fire-and-forget because onChatChanged is synchronous, but it
    // is not optional: until it lands, the store is un-hydrated and any path
    // that would create an entry refuses to run (see store.assertHydrated) —
    // which is the intended behaviour, not a race to be ignored.
    reloadStores('chat change');
}

/**
 * Flush the outgoing chat's stores, then load the incoming chat's.
 * Exported so the settings panel can call it after a scope change.
 * @returns {Promise<void>}
 */
export async function reloadStores(reason = 'reload') {
    try {
        await resetStoreCache();
        const { knowledge } = await hydrateCurrentBooks();
        // The reason label matters: `init` runs at page load using whatever
        // scope was persisted, then CHAT_CHANGED re-points it once ST has
        // restored the chat. Seeing two different books logged in a row is
        // expected, and without the label it reads like a bug.
        console.log(`[MWT:Knowledge] Store ready (${reason}) — lorebook "${knowledge}".`);
    } catch (err) {
        console.warn('[MWT:Knowledge] Store hydration failed:', err?.message || err);
    }
}

// ─── Delete awareness ────────────────────────────────────────────────────────
// Keep the knowledge auto-trigger counter in sync when messages are deleted so
// the "every N messages" cadence doesn't drift relative to the shorter chat.
//
// SillyTavern supports bulk deletes ("delete messages above/below") which remove
// many messages at once. A single MESSAGE_DELETED event fires, and by the time
// it reaches us the chat array already reflects the final (shorter) length. We
// compare against `state.lastChatLength` to compute how many messages were
// actually removed and decrement both counters proportionally.

/**
 * A message (or messages) was deleted. Decrement the auto-trigger counters by
 * the number of messages actually removed, so the "every N messages" cadence
 * stays aligned with the shorter chat.
 *
 * @param {number} deletedIndex - The chat-array index of the removed message
 *   (from the event payload). For bulk deletes this is typically the boundary
 *   index; the actual count removed is derived from `state.lastChatLength`.
 * @param {{ adjustCounters?: boolean }} [opts] - When false (panic switch on),
 *   the counter decrements are skipped but bookkeeping + registry-timestamp
 *   integrity still run.
 */
export function onMessageDeleted(deletedIndex, { adjustCounters = true } = {}) {
    const settings = getSettings();
    if (typeof deletedIndex !== 'number') return;

    // Compute how many messages were removed. After a delete, getChat() reflects
    // the new (shorter) length. The delta vs lastChatLength tells us the count;
    // it is clamped to >= 1 as a safety net when the delta isn't available or
    // the event fired before the chat array updated (single-message delete).
    const currentLen = getChat()?.length || 0;
    const removed = state.lastChatLength > currentLen
        ? state.lastChatLength - currentLen
        : 1;
    // Bookkeeping — ALWAYS live
    state.lastChatLength = currentLen;

    let changed = false;
    if (adjustCounters) {
        if (settings.autoTriggerEnabled && state.messageCounter > 0) {
            state.messageCounter = Math.max(0, state.messageCounter - removed);
            changed = true;
            console.log(`[MWT:Knowledge] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed}) — state counter adjusted to ${state.messageCounter}`);
        }
        if (settings.npcAutoScanEnabled && state.npcMessageCounter > 0) {
            state.npcMessageCounter = Math.max(0, state.npcMessageCounter - removed);
            changed = true;
            console.log(`[MWT:Knowledge] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed}) — NPC counter adjusted to ${state.npcMessageCounter}`);
        }
        if (settings.growthAutoCaptureEnabled && state.growthMessageCounter > 0) {
            state.growthMessageCounter = Math.max(0, state.growthMessageCounter - removed);
            changed = true;
            console.log(`[MWT:Knowledge] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed}) — growth counter adjusted to ${state.growthMessageCounter}`);
        }
        if (settings.relationshipAutoExtractEnabled && state.relationshipMessageCounter > 0) {
            state.relationshipMessageCounter = Math.max(0, state.relationshipMessageCounter - removed);
            changed = true;
            console.log(`[MWT:Knowledge] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed}) — relationship counter adjusted to ${state.relationshipMessageCounter}`);
        }
    }

    // The state registry's `lastUpdatedMsg` is stored as a raw chat length.
    // After a bulk delete the stored length points past the end of the shorter
    // chat, freezing every tracker whose cooldown check now sees a negative
    // delta. Adjust those watermarks in lock-step with the counters. This is
    // integrity work, so it runs ALWAYS — not gated by adjustCounters.
    if (settings.autoTriggerEnabled) {
        try {
            adjustStateTrackerLastUpdatedMsg(removed);
        } catch (err) {
            console.warn('[MWT:Knowledge] Could not adjust state tracker lastUpdatedMsg after delete:', err?.message || err);
        }
    }

    if (changed) persistCounters();
}

// ─── Token tracking ──────────────────────────────────────────────────────────

export function getTotalTokens() {
    return state._cachedTokenCount;
}

export async function refreshTotalTokens() {
    if (state._refreshingTokens) return state._cachedTokenCount;
    state._refreshingTokens = true;
    try {
        const registry = getRegistry();
        let total = 0;
        for (const [, info] of Object.entries(registry)) {
            if (info.uid === null || info.uid === undefined) continue;
            try {
                const content = await loadEntryContent(info.uid);
                if (content) total += estimateTokens(content);
            } catch { /* skip */ }
        }
        const stateReg = getStateRegistry();
        for (const [, info] of Object.entries(stateReg)) {
            if (info.uid === null || info.uid === undefined) continue;
            try {
                const loaded = await loadStateTrackerEntry(info.uid);
                if (loaded?.content) total += estimateTokens(loaded.content);
            } catch { /* skip */ }
        }
        state._cachedTokenCount = total;
        return total;
    } catch (err) {
        console.error('[MWT:Knowledge] Token refresh failed:', err);
        return state._cachedTokenCount;
    } finally {
        state._refreshingTokens = false;
    }
}

// ─── Settings sync ───────────────────────────────────────────────────────────

export { syncGlobalSettings };

// ─── Slash commands & macros ─────────────────────────────────────────────────

export async function triggerScan() {
    return runScan();
}

export async function scanAndAccept() {
    const scanResult = await runScan();
    const items = buildStagingItems(scanResult);
    for (const item of items) {
        await enrichStagingItem(item);
        const merged = item.mergedContent || item.proposedContent;
        const keywords = item.keywords || [item.name];
        // Minimal el stub for handleAccept
        const { writeToLorebook, writeStateTracker } = await import('./lorebook.js');
        const { getRegistry, saveRegistry } = await import('./registry.js');
        if (item.type === 'state') {
            await writeStateTracker(item.uid, item.name, merged);
        } else {
            const result = await writeToLorebook(item.name, merged, keywords, item.uid);
            if (result.success) {
                getRegistry()[item.name] = {
                    uid: result.uid,
                    type: item.type === 'promote' ? 'major' : item.type === 'demote' ? 'minor' : item.type,
                    keywords,
                    lastUpdated: Date.now(),
                };
                saveRegistry(getRegistry());
            }
        }
    }
    return items;
}

export function getTrackedNpcNames() {
    return getAllNpcNames();
}

export function isScanning() {
    return state.isRunning;
}

export function getNpcCount() {
    return Object.keys(getRegistry()).length;
}

/** Returns auto-scan status for external display (floating button countdown).
 *  Mirrors World State's getAutoRefreshStatus() so core/ui.js can populate the
 *  countdown badge on the Knowledge floating button. */
export function getAutoScanStatus() {
    const settings = getSettings();
    if (!settings.npcAutoScanEnabled) return null;
    return {
        counter: state.npcMessageCounter,
        interval: Math.max(1, Number(settings.npcAutoScanEveryN) || 10),
    };
}

/** Returns the count of pending staging items so the floating button can show
 *  an attention badge when there are proposals awaiting review. */
export function getStagingCount() {
    return state.stagingItems.length;
}

/** Returns the count of unread growth observations captured in the background
 *  since the user last opened a Growth Profile modal. Drives a green pulse on
 *  the floating button so new evidence is visible even when the modal is
 *  closed — the transient toastr fires once and is easy to miss. */
export function getGrowthEvidenceCount() {
    return state.unreadGrowthEvidenceCount;
}

export async function getNpcContent(name) {
    // KNOWLEDGE-03: Use getRegistryEntry so given-name ("Mara") resolves to
    // the full registry key ("Mara Vance") instead of silently missing.
    const entry = getRegistryEntry(name);
    if (!entry || entry.info.uid == null) return '';
    const content = await loadEntryContent(entry.info.uid);
    return content || '';
}
