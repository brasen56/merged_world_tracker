/**
 * knowledge/index.js — Public API barrel for the Knowledge module.
 *
 * Re-exports lifecycle hooks, slash-command handlers, and macro helpers
 * consumed by the root index.js.  All implementation lives in sub-files.
 */

import { getChat, escapeRegex, estimateTokens } from '../core/index.js';

import { state, getNpcsContentEl, ktSetStatus } from './state.js';
import { getSettings, hasValidSettings, syncGlobalSettings } from './settings.js';
import { getRegistry, getAllNpcNames, getStateRegistry, bumpStateTrackerTimestamp } from './registry.js';
import { loadEntryContent, loadStateTrackerEntry, runScan, runStateUpdate, queueTrackerWork, getRecentMessages, enrichStagingItem } from './lorebook.js';
import { buildStagingItems } from './staging.js';
import {
    renderNpcsSubTab,
    addNotificationEntry, removeNotificationEntry,
    initNotificationPanel, hideNotificationPanel,
    exportNpcs, importNpcs, importFromLorebooks,
} from './render.js';

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        state.modal = parentModal;
        state.npcsContentEl = null;
        state.stateContentEl = null;
    }
    initNotificationPanel();
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
    if (!stateAuto && !npcAuto) return;
    if (!hasValidSettings()) return;

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

    if (!doState && !doNpc) return;

    const cooldownMsgs = Math.max(0, Number(settings.trackerCooldownMsgs) || 3);

    queueTrackerWork(async () => {
        if (state.isRunning) return;
        state.isRunning = true;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        try {
            // ── State tracker auto-update ──
            if (doState) {
                const reg = getStateRegistry();
                const currentMsgIdx = getChat()?.length || 0;
                const recent = getRecentMessages(30);
                let staged = 0;
                for (const [name, info] of Object.entries(reg)) {
                    if (info.enabled === false) continue;
                    if (!info.alwaysUpdate) {
                        if (currentMsgIdx - (info.lastUpdatedMsg || 0) < cooldownMsgs) continue;
                        const nameRe = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i');
                        if (!nameRe.test(recent || '')) continue;
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
                            removeNotificationEntry(state.stagingItems[existingIdx].id);
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
                    const newItems = buildStagingItems(result);
                    const added = [];
                    for (const item of newItems) {
                        const key = `${item.name}|${item.action}|${item.type}`;
                        const existingIdx = state.stagingItems.findIndex(it => `${it.name}|${it.action}|${it.type}` === key);
                        if (existingIdx >= 0) {
                            removeNotificationEntry(state.stagingItems[existingIdx].id);
                            state.stagingItems[existingIdx] = item;
                        } else {
                            state.stagingItems.push(item);
                        }
                        added.push(item);
                    }
                    await Promise.all(added.filter(it => it.action === 'update').map(it => enrichStagingItem(it)));
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
        } finally { state.isRunning = false; document.dispatchEvent(new CustomEvent('mwt:busy-changed')); }
    });
}

export function onChatChanged() {
    state.messageCounter = 0;
    state.npcMessageCounter = 0;
    state.isRunning = false;
    state.stagingItems = [];
    state.activeItemId = null;
    state.activeSubTab = 'staging';
    state._cachedTokenCount = 0;
    state.notificationEntries = {};
    hideNotificationPanel();
    document.querySelectorAll('#kt-view-modal').forEach(m => m.remove());
}

// ─── Delete awareness ────────────────────────────────────────────────────────
// Keep the knowledge auto-trigger counter in sync when messages are deleted so
// the "every N messages" cadence doesn't drift relative to the shorter chat.

/**
 * A message was deleted. Decrement `messageCounter` if positive so the
 * auto-trigger countdown stays aligned with the chat length.
 *
 * @param {number} deletedIndex - The chat-array index of the removed message.
 */
export function onMessageDeleted(deletedIndex) {
    const settings = getSettings();
    if (!settings.autoTriggerEnabled && !settings.npcAutoScanEnabled) return;
    if (typeof deletedIndex !== 'number') return;
    if (settings.autoTriggerEnabled && state.messageCounter > 0) {
        state.messageCounter = Math.max(0, state.messageCounter - 1);
        console.log(`[MWT:Knowledge] MESSAGE_DELETED at index ${deletedIndex} — state counter adjusted to ${state.messageCounter}`);
    }
    if (settings.npcAutoScanEnabled && state.npcMessageCounter > 0) {
        state.npcMessageCounter = Math.max(0, state.npcMessageCounter - 1);
        console.log(`[MWT:Knowledge] MESSAGE_DELETED at index ${deletedIndex} — NPC counter adjusted to ${state.npcMessageCounter}`);
    }
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
                const content = await loadEntryContent(info.uid);
                if (content) total += estimateTokens(content);
            } catch { /* skip */ }
        }
        const stateReg = getStateRegistry();
        for (const [name, info] of Object.entries(stateReg)) {
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

export async function getNpcContent(name) {
    const reg = getRegistry()[name];
    if (!reg || reg.uid == null) return '';
    const content = await loadEntryContent(reg.uid);
    return content || '';
}
