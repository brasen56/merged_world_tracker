/**
 * knowledge/index.js — Public API barrel for the Knowledge module.
 *
 * Re-exports lifecycle hooks, slash-command handlers, and macro helpers
 * consumed by the root index.js.  All implementation lives in sub-files.
 */

import { getChat, escapeRegex, estimateTokens, getChatMeta, persistChatMeta, preserveQuarantinedRecords, captureScope, assertSameScope, getOrCreateReceiptIdentity } from '../core/index.js';
import { prepareNextStoreValue } from '../core/schema.js';
import { knowledgeCountersSchema } from './schema.js';

import { state, COUNTERS_META_KEY } from './state.js';
import { getSettings, hasValidSettings, syncGlobalSettings } from './settings.js';
import { getRegistry, getRegistryEntry, getAllNpcNames, getStateRegistry, bumpStateTrackerTimestamp, adjustStateTrackerLastUpdatedMsg, saveRegistry, resolveRegistryKey } from './registry.js';
import { loadEntryContent, loadStateTrackerEntry, runScan, runStateUpdate, queueTrackerWork, getRecentMessages, enrichStagingItem } from './lorebook.js';
import { buildStagingItems, mergeScanResults } from './staging.js';
import { resetStoreCache, hydrateCurrentBooks } from './store.js';
// The §5.4 Retry seam: Knowledge's Retry action re-runs hydration (the one
// preparation path this module owns today). Direct import — see store.js's
// pause-wiring note about the test-only barrel→stub alias.
import { setStoreRetryHandler, getPauseState } from '../core/schema_status.js';
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

// A spent provenance marker (every cadence zeroed) exists only so a
// regeneration of an already-counted receipt stays a no-op. Only the tail of
// the chat can be regenerated, so a short recency window is enough — and it
// keeps the persisted map from growing one entry per message forever.
const SPENT_RECEIPT_WINDOW = 10;

/**
 * The Knowledge-counters write seam (design §8, Part 3): the COMPLETE proposed
 * next counters store — the persisted cadence counters plus the receipt-event
 * tuples rebuilt from live state — is validated by the registered
 * knowledgeCounters schema before anything is persisted. The write either
 * commits CANONICAL data (a malformed receipt tuple quarantined out of the
 * live value, its issue reported) or, on a fatal root problem, leaves the
 * previous value intact.
 */
export function persistCounters() {
    const meta = getChatMeta();
    if (!meta) return undefined;
    const next = prepareNextStoreValue(knowledgeCountersSchema, meta[COUNTERS_META_KEY], {
        messageCounter: state.messageCounter,
        npcMessageCounter: state.npcMessageCounter,
        growthMessageCounter: state.growthMessageCounter,
        relationshipMessageCounter: state.relationshipMessageCounter,
        countedReceiptEvents: [...state.countedReceiptEvents.entries()],
    });
    if (!next.ok) {
        console.warn('[MWT:Knowledge] Counter write refused — the proposed update failed schema validation; the previous value was kept.', next.issues);
        return meta[COUNTERS_META_KEY];
    }
    for (const issue of next.issues) {
        console.warn(`[MWT:Knowledge] ${issue.severity}: ${issue.message}`);
    }
    // §5.2: the canonical write is only allowed to commit if its rejected
    // records were preserved. A refused quarantine container means they cannot
    // be — leave the previous value intact instead.
    const preserved = preserveQuarantinedRecords(knowledgeCountersSchema.id, next.issues, { sourceVersion: knowledgeCountersSchema.currentVersion });
    if (!preserved.ok) {
        console.warn(`[MWT:Knowledge] Counter write refused — quarantined records could not be preserved (${preserved.reason}); the previous value was kept.`);
        return meta[COUNTERS_META_KEY];
    }
    meta[COUNTERS_META_KEY] = next.data;
    persistChatMeta();
    return next.data;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        state.modal = parentModal;
        state.npcsContentEl = null;
        state.stateContentEl = null;
    }
    initNotificationPanel();
    // The §5.4 Retry action for a paused knowledgeStore: re-run the current
    // books' hydration (privileged orchestration, not queued module work — a
    // queued job would be declined by the very pause it exists to clear, plan
    // §7.5). A successful re-hydration resumes the store inside
    // hydrateCurrentBooks(); the return value says whether the pause is gone.
    setStoreRetryHandler('knowledgeStore', async () => {
        await hydrateCurrentBooks();
        return getPauseState('knowledgeStore') === null;
    });
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

export function onMessageReceived({ countMessage = true } = {}) {
    // Track chat length so onMessageDeleted can compute the number of removed
    // messages during bulk deletes (e.g. "delete above/below"). This must run
    // every turn — it is NOT gated by the panic switch (countMessage) or by
    // which auto-triggers are enabled — so onMessageDeleted always computes
    // `removed` from a live length instead of a frozen one. (Hoisted above the
    // early returns for PANIC-COUNTER-SYMMETRY.)
    const chat = getChat() || [];
    state.lastChatLength = chat.length;

    const settings = getSettings();
    const stateAuto = !!settings.autoTriggerEnabled;
    const npcAuto = !!settings.npcAutoScanEnabled;
    const growthAuto = !!settings.growthAutoCaptureEnabled;
    const relAuto = !!settings.relationshipAutoExtractEnabled;
    if (!countMessage) return;
    if (!stateAuto && !npcAuto && !growthAuto && !relAuto) return;
    if (!hasValidSettings()) return;

    // SillyTavern also emits MESSAGE_RECEIVED when an assistant reply is
    // swiped/regenerated.  Count a stable message receipt at most once for
    // each cadence so replacement generations cannot advance (or trigger)
    // Knowledge work that will immediately be discarded.
    //
    // A value of 1 means the receipt contributes to the current cadence. A
    // value of 0 means it was already counted in an earlier, completed
    // cadence. Keeping the zero-valued marker is important: deleting that
    // receipt must not roll back the current cadence, but regenerating it must
    // still remain a no-op.
    const receipt = [...chat].reverse().find(msg => msg && !msg.is_user && !msg.is_system);
    const receiptKey = receipt ? getReceiptIdentity(receipt) : null;
    const receiptCounts = receiptKey ? (state.countedReceiptEvents.get(receiptKey) || {}) : null;
    const isNewReceiptFor = type => !receiptCounts
        || !Object.prototype.hasOwnProperty.call(receiptCounts, type);
    const countState = stateAuto && isNewReceiptFor('state');
    const countNpc = npcAuto && isNewReceiptFor('npc');
    const countGrowth = growthAuto && isNewReceiptFor('growth');
    const countRelationship = relAuto && isNewReceiptFor('relationship');

    // Every enabled cadence has already seen this assistant message. This is
    // a swipe/regeneration receipt, so bookkeeping above stays current while
    // counters and background API work remain untouched.
    if (!countState && !countNpc && !countGrowth && !countRelationship) return;

    let doState = false;
    let doNpc = false;

    if (countState) {
        const everyN = Math.max(1, Number(settings.autoTriggerEveryN) || 5);
        state.messageCounter++;
        if (state.messageCounter >= everyN) {
            state.messageCounter = 0;
            doState = true;
        }
    }

    if (countNpc) {
        const everyN = Math.max(1, Number(settings.npcAutoScanEveryN) || 10);
        state.npcMessageCounter++;
        if (state.npcMessageCounter >= everyN) {
            state.npcMessageCounter = 0;
            doNpc = true;
        }
    }

    let doGrowth = false;
    if (countGrowth) {
        const everyN = Math.max(1, Number(settings.growthAutoCaptureEveryN) || 15);
        state.growthMessageCounter++;
        if (state.growthMessageCounter >= everyN) {
            state.growthMessageCounter = 0;
            doGrowth = true;
        }
    }

    let doRel = false;
    if (countRelationship) {
        const everyN = Math.max(1, Number(settings.relationshipAutoExtractEveryN) || 10);
        state.relationshipMessageCounter++;
        if (state.relationshipMessageCounter >= everyN) {
            state.relationshipMessageCounter = 0;
            doRel = true;
        }
    }

    if (receiptCounts) {
        if (countState) receiptCounts.state = 1;
        if (countNpc) receiptCounts.npc = 1;
        if (countGrowth) receiptCounts.growth = 1;
        if (countRelationship) receiptCounts.relationship = 1;
        if (Object.keys(receiptCounts).length) state.countedReceiptEvents.set(receiptKey, receiptCounts);
    }
    // Each counter that reached its interval starts a new cadence. Mark its
    // prior receipts as seen-but-not-contributing instead of forgetting them;
    // forgetting them would let a later regeneration of the trigger message
    // advance the new cadence again.
    for (const type of [doState && 'state', doNpc && 'npc', doGrowth && 'growth', doRel && 'relationship'].filter(Boolean)) {
        for (const [key, counts] of state.countedReceiptEvents) {
            if (!Object.prototype.hasOwnProperty.call(counts, type)) continue;
            counts[type] = 0;
            state.countedReceiptEvents.set(key, counts);
        }
    }
    // Release fully spent markers beyond the recency window. Entries still
    // carrying a live 1 are never dropped — onMessageDeleted needs them to
    // reverse the current cadence — and those are self-bounding, since a
    // counter resets once it reaches its interval.
    const spentKeys = [];
    for (const [key, counts] of state.countedReceiptEvents) {
        if (Object.values(counts).every(value => !value)) spentKeys.push(key);
    }
    for (const key of spentKeys.slice(0, -SPENT_RECEIPT_WINDOW)) state.countedReceiptEvents.delete(key);

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
    // Values are 1 (contributes to the current cadence) or 0 (seen, already
    // spent). Metadata written before the swipe fix stored raw receive counts,
    // which would over-decrement the counters when such a receipt is deleted —
    // normalise them to the two-state form on the way in.
    state.countedReceiptEvents = new Map((Array.isArray(saved?.countedReceiptEvents) ? saved.countedReceiptEvents : [])
        .filter(([key, counts]) => typeof key === 'string' && key && counts && typeof counts === 'object')
        .map(([key, counts]) => [key, Object.fromEntries(
            Object.entries(counts).map(([type, value]) => [type, value ? 1 : 0]),
        )]));
    const chat = getChat() || [];
    state.lastChatLength = chat.length;
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
        // Switch MWT's books on in ST's World Info when the user opted in
        // (knowledge/activation.js). Runs after hydration so the store is
        // loaded and the resolved book names are settled before any slot is
        // written. Note the book FILE may still not exist — it is created
        // lazily by the first write (flushBook / writeToLorebook), not by
        // hydration — but binding a not-yet-created name is harmless and
        // self-healing: ST ignores a chat-slot name missing from world_names
        // and drops unknown names from the global selection, and the next
        // apply re-adds them once the file is on disk.
        // A scope change first prunes ledger entries whose books the new
        // scope no longer targets (settings.js already removed the old
        // bindings before calling this). Fire-and-forget: activation is
        // fully guarded and must never block or fail the store load.
        import('./activation.js')
            .then((m) => {
                if (reason === 'scope change') m.pruneStaleLedger();
                return m.applyActivationBindings(reason);
            })
            .catch((err) => console.warn('[MWT:Knowledge] Lorebook activation failed:', err?.message || err));
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
    const liveReceiptKeys = new Set((getChat() || []).filter(msg => msg && !msg.is_user && !msg.is_system).map(getReceiptIdentity));
    const removedReceipts = { state: 0, npc: 0, growth: 0, relationship: 0 };
    let provenanceChanged = false;
    for (const [key, counts] of state.countedReceiptEvents) {
        if (!liveReceiptKeys.has(key)) {
            for (const type of Object.keys(removedReceipts)) removedReceipts[type] += Number.isInteger(counts[type]) ? counts[type] : 0;
            state.countedReceiptEvents.delete(key);
            provenanceChanged = true;
        }
    }
    // Bookkeeping — ALWAYS live
    state.lastChatLength = currentLen;

    let changed = false;
    if (adjustCounters) {
        if (settings.autoTriggerEnabled && state.messageCounter > 0) {
            state.messageCounter = Math.max(0, state.messageCounter - removedReceipts.state);
            changed = true;
            console.log(`[MWT:Knowledge] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed}) — state counter adjusted to ${state.messageCounter}`);
        }
        if (settings.npcAutoScanEnabled && state.npcMessageCounter > 0) {
            state.npcMessageCounter = Math.max(0, state.npcMessageCounter - removedReceipts.npc);
            changed = true;
            console.log(`[MWT:Knowledge] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed}) — NPC counter adjusted to ${state.npcMessageCounter}`);
        }
        if (settings.growthAutoCaptureEnabled && state.growthMessageCounter > 0) {
            state.growthMessageCounter = Math.max(0, state.growthMessageCounter - removedReceipts.growth);
            changed = true;
            console.log(`[MWT:Knowledge] MESSAGE_DELETED at index ${deletedIndex} (removed ${removed}) — growth counter adjusted to ${state.growthMessageCounter}`);
        }
        if (settings.relationshipAutoExtractEnabled && state.relationshipMessageCounter > 0) {
            state.relationshipMessageCounter = Math.max(0, state.relationshipMessageCounter - removedReceipts.relationship);
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

    if (changed || provenanceChanged) persistCounters();
}

function getReceiptIdentity(message) {
    return getOrCreateReceiptIdentity(message);
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
        for (const [name, info] of Object.entries(registry)) {
            if (info.uid === null || info.uid === undefined) continue;
            try {
                // Label-verified: a stale uid must not count another NPC's
                // entry toward this book's token total.
                const content = await loadEntryContent(info.uid, name);
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

/**
 * Scan and write every resulting proposal without user review.
 *
 * Unattended, so it must FAIL CLOSED. The interactive UI refuses to write a
 * proposal whose content is still a placeholder; this path did not, and the
 * consequence was worse than a no-op: when enrichStagingItem() refuses a
 * mismatched uid (the registry says "Mikhail", the entry is labelled
 * "Marcus"), the proposal keeps its "(Fetch to see changes)" placeholder, and
 * writing that detached the uid and created a fresh entry whose entire body
 * was the literal string "(Fetch to see changes)".
 *
 * Two guards, in order: an update that survived enrichment with no
 * existingContent is an unresolved identity and is never written; and any
 * remaining placeholder text is rejected exactly as the UI rejects it.
 *
 * @returns {Promise<Array>} the staging items, each tagged with `accepted`
 *   (true) or `skipReason` (string) so callers can report what happened
 */
export async function scanAndAccept() {
    const scanResult = await runScan();
    const items = buildStagingItems(scanResult);
    const { writeToLorebook, writeStateTracker } = await import('./lorebook.js');
    const { STAGING_PLACEHOLDERS } = await import('./staging.js');
    let accepted = 0;
    const skips = [];

    for (const item of items) {
        // May convert a create into an update when the entry already exists.
        await enrichStagingItem(item);

        const skip = (reason) => {
            item.skipReason = reason;
            skips.push(`"${item.name}" — ${reason}`);
        };

        // FAIL CLOSED #1: an update whose entry never loaded. loadEntryContent
        // returns null both when the uid is missing and when it points at a
        // differently-labelled entry; either way we do not know what we would
        // be merging into, and writing detaches the uid and creates an entry.
        if (item.action === 'update' && item.uid != null && item.existingContent === null) {
            skip('its lorebook entry could not be verified (stale uid or wrong NPC) — run MWT.npcs.auditDuplicates()');
            continue;
        }

        const merged = item.mergedContent || item.proposedContent;
        // FAIL CLOSED #2: unloaded placeholder text, same rule as the UI.
        if (!merged || STAGING_PLACEHOLDERS.includes(merged)) {
            skip('its content never loaded (placeholder text)');
            continue;
        }

        const keywords = item.keywords || [item.name];
        if (item.type === 'state') {
            const result = await writeStateTracker(item.uid, item.name, merged);
            if (result && result.success === false) { skip(result.error || 'state write failed'); continue; }
            item.accepted = true;
            accepted++;
            continue;
        }

        const result = await writeToLorebook(item.name, merged, keywords, item.uid);
        if (!result.success) { skip(result.error || 'lorebook write failed'); continue; }

        // Canonical registry key, mirroring handleAccept: for updates
        // (item.uid != null) resolve through the registry so the model's
        // spelling can't create a second identity. For creates,
        // buildStagingItems already set item.name to the canonical key when
        // one exists. (This path previously destructured a nonexistent
        // `localRegistry` export, which threw on the first NPC.)
        const reg = getRegistry();
        const regKey = item.uid != null
            ? (resolveRegistryKey(reg, item.name) ?? item.name)
            : item.name;
        // MERGE, never replace — preserves profileUid and any other field
        // this path does not manage. See the matching note in handleAccept.
        reg[regKey] = {
            ...(reg[regKey] || {}),
            uid: result.uid,
            type: item.type === 'promote' ? 'major' : item.type === 'demote' ? 'minor' : item.type,
            keywords,
            lastUpdated: Date.now(),
        };
        saveRegistry(reg);
        item.accepted = true;
        accepted++;
    }

    if (skips.length > 0) {
        console.warn(
            `[MWT:Knowledge] scanAndAccept wrote ${accepted} of ${items.length} proposal(s). ` +
            `Skipped ${skips.length}:\n  ${skips.join('\n  ')}`
        );
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
    // Label-verified against the canonical key: a stale uid must not hand out
    // another NPC's content under this name.
    const content = await loadEntryContent(entry.info.uid, entry.key);
    return content || '';
}
