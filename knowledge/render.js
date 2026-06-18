/**
 * knowledge/render.js — All UI rendering and DOM event wiring for the
 * Knowledge tab (NPC lists, staging, state trackers, relationships,
 * notification panel, settings panel).
 */

import {
    escapeHtml, renderLineDiff, notify,
} from '../core/index.js';

import {
    RELATIONSHIP_TYPES, TRACKER_SENTINEL, STATE_LOREBOOK_NAME,
    state, getNpcsContentEl, ktSetStatus,
} from './state.js';
import { getSettings, hasValidSettings, showKnowledgeSettings } from './settings.js';
import {
    getRegistry, saveRegistry, getAllNpcNames,
    getStateRegistry, registerStateTracker, unregisterStateTracker,
    setStateTrackerEnabled, setStateTrackerAlwaysUpdate, bumpStateTrackerTimestamp,
} from './registry.js';
import {
    loadEntryContent, loadStateTrackerEntry,
    runScan, runStateUpdate, runNpcUpdate, runNpcEnrich,
    buildUpdatedMinorContent,
    buildPromotedContent, buildDemotedContent,
    enrichStagingItem, writeToLorebook, writeStateTracker,
    isDossierEntry, countDossierFields, DOSSIER_FIELDS,
} from './lorebook.js';
import {
    getRelationships, updateRelationship, removeRelationship,
    removeAllRelationshipsFor,
    syncRelationshipsToLorebook, syncAllRelationshipsToLorebooks,
} from './relationships.js';
import {
    buildStagingItems, exportNpcs, importNpcs, importFromLorebooks,
} from './staging.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sortEntries(obj, key) {
    return Object.entries(obj).sort((a, b) => String(a[1][key] || a[0]).localeCompare(String(b[1][key] || b[0])));
}

// ─── Accept / reject staging item ────────────────────────────────────────────

async function handleAccept(item, text, keywords, el) {
    try {
        if (item.type === 'state') {
            const result = await writeStateTracker(item.uid, item.name, text);
            if (!result.success) { ktSetStatus(`Write failed: ${result.error}`, 'error'); return; }
            bumpStateTrackerTimestamp(item.name);
        } else {
            const result = await writeToLorebook(item.name, text, keywords, item.uid);
            if (!result.success) { ktSetStatus(`Write failed: ${result.error}`, 'error'); return; }
            getRegistry()[item.name] = {
                uid: result.uid,
                type: item.type === 'promote' ? 'major' : item.type === 'demote' ? 'minor' : item.type,
                keywords,
                lastUpdated: Date.now(),
            };
            saveRegistry(getRegistry());
        }
        state.stagingItems = state.stagingItems.filter(i => i.id !== item.id);
        if (state.activeItemId === item.id) state.activeItemId = null;
        removeNotificationEntry(item.id);
        ktSetStatus(`"${item.name}" written to lorebook.`, 'success');
        renderNpcsSubTab();
    } catch (err) {
        ktSetStatus(`Accept failed: ${err.message}`, 'error');
    }
}

// ─── Notification panel ──────────────────────────────────────────────────────

function addNotificationEntry(item) {
    state.notificationEntries[item.id] = { item, ts: Date.now(), read: false };
}

function removeNotificationEntry(id) {
    delete state.notificationEntries[id];
}

/**
 * Reconcile notification entries against staging items so the bell count
 * never references proposals that have already been accepted/dismissed.
 * Returns true if any entries were pruned.
 */
function reconcileNotifications() {
    const stagingIds = new Set(state.stagingItems.map(i => i.id));
    let pruned = false;
    for (const id of Object.keys(state.notificationEntries)) {
        if (!stagingIds.has(id)) {
            delete state.notificationEntries[id];
            pruned = true;
        }
    }
    return pruned;
}

function unreadCount() { return Object.values(state.notificationEntries).filter(n => !n.read).length; }

function showNotificationPanel() {
    // Navigate to the staging tab, where staged proposals can be reviewed.
    reconcileNotifications();
    state.activeSubTab = 'staging';
    // Mark all notifications as read since the user is now viewing them.
    for (const n of Object.values(state.notificationEntries)) n.read = true;
    renderNpcsSubTab();
}

function hideNotificationPanel() {
    state.notifActiveId = false;
}

function initNotificationPanel() {
    state.notificationEntries = {};
    state.notifActiveId = false;
}

// ─── Main render dispatcher ──────────────────────────────────────────────────

export function renderNpcsSubTab() {
    const el = getNpcsContentEl();
    if (!el) return;

    // Keep the notification bell count in sync with staged proposals so it
    // never reports items that have been accepted/dismissed elsewhere.
    reconcileNotifications();

    const registry = getRegistry();
    const minorEntries = Object.fromEntries(Object.entries(registry).filter(([, v]) => v.type !== 'major'));
    const majorEntries = Object.fromEntries(Object.entries(registry).filter(([, v]) => v.type === 'major'));

    el.innerHTML = `
        <div class="kt-toolbar">
            <button id="kt-scan-btn" class="mwt-btn mwt-btn-primary" ${!hasValidSettings() ? 'disabled' : ''}>${state.isRunning ? '⏳ Scanning…' : '🔍 Scan'}</button>
            ${(() => {
                const s = getSettings();
                if (s.npcAutoScanEnabled) {
                    const everyN = Math.max(1, Number(s.npcAutoScanEveryN) || 10);
                    const remaining = Math.max(0, everyN - state.npcMessageCounter);
                    return `<span class="kt-autoscan-countdown" title="Auto-scan fires every ${everyN} messages (${state.npcMessageCounter}/${everyN})">⏱️ ${remaining} msg${remaining !== 1 ? 's' : ''} until auto-scan</span>`;
                }
                return '';
            })()}
            <button id="kt-export-btn" class="mwt-btn" title="Export NPC registry">📥 Export</button>
            <button id="kt-import-btn" class="mwt-btn" title="Import NPCs from JSON">📤 Import</button>
            <button id="kt-import-lb-btn" class="mwt-btn" title="Import from existing lorebooks">📚 From Lorebooks</button>
        </div>
        <div class="kt-sub-tabs">
            <button class="kt-sub-tab ${state.activeSubTab === 'staging' ? 'active' : ''} ${state.stagingItems.length > 0 && state.activeSubTab !== 'staging' ? 'kt-staging-pulse' : ''}" data-sub="staging">
                📋 Staging${state.stagingItems.length > 0 ? ` (${state.stagingItems.length})` : ''}
            </button>
            <button class="kt-sub-tab ${state.activeSubTab === 'minor' ? 'active' : ''}" data-sub="minor">👤 Minor (${Object.keys(minorEntries).length})</button>
            <button class="kt-sub-tab ${state.activeSubTab === 'major' ? 'active' : ''}" data-sub="major">🏛️ Major (${Object.keys(majorEntries).length})</button>
            <button class="kt-sub-tab ${state.activeSubTab === 'state' ? 'active' : ''}" data-sub="state">📊 State</button>
            <button class="kt-sub-tab ${state.activeSubTab === 'relationships' ? 'active' : ''}" data-sub="relationships">🔗 Relationships</button>
            <span class="kt-sub-spacer"></span>
            ${unreadCount() > 0 ? `<button class="kt-sub-tab kt-notif-badge" id="kt-notif-btn">🔔 ${unreadCount()}</button>` : ''}
            <button class="kt-sub-tab" id="kt-cog-btn" title="Settings">⚙️</button>
        </div>
        <div class="kt-sub-content" id="kt-sub-content">
            ${state.activeSubTab === 'staging' ? renderStagingContent(state.stagingItems.length) :
              state.activeSubTab === 'minor' ? renderNpcListContent('minor', minorEntries) :
              state.activeSubTab === 'major' ? renderNpcListContent('major', majorEntries) :
              state.activeSubTab === 'state' ? renderStateTrackerContent() :
              state.activeSubTab === 'relationships' ? renderRelationshipContent() :
              ''}
        </div>
        <div id="kt-status" class="kt-status"></div>`;

    // Wire sub-tab clicks
    el.querySelectorAll('.kt-sub-tab[data-sub]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.activeSubTab = btn.dataset.sub;
            renderNpcsSubTab();
        });
    });

    // Notification bell
    el.querySelector('#kt-notif-btn')?.addEventListener('click', () => showNotificationPanel());

    // Settings gear
    el.querySelector('#kt-cog-btn')?.addEventListener('click', () => showKnowledgeSettings());

    // Scan button
    el.querySelector('#kt-scan-btn')?.addEventListener('click', async () => {
        if (state.isRunning) return;
        state.isRunning = true;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        try {
            ktSetStatus('Scanning…', 'info');
            renderNpcsSubTab(); // Re-render to show "⏳ Scanning…" state
            state.activeSubTab = 'staging';
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
            state.activeItemId = null;
            await Promise.all(added.filter(it => it.action === 'update').map(it => enrichStagingItem(it)));
            added.forEach(item => addNotificationEntry(item));
            ktSetStatus(`Scan complete — ${added.length} proposal(s).`, 'success');
            notify('Knowledge Tracker', `Scan found ${added.length} proposal(s).`, added.length ? 'info' : 'success');
        } catch (err) {
            ktSetStatus(`Scan failed: ${err.message}`, 'error');
            notify('Knowledge Tracker', `Scan failed: ${err.message}`, 'error');
        }
        finally { state.isRunning = false; document.dispatchEvent(new CustomEvent('mwt:busy-changed')); renderNpcsSubTab(); }
    });

    // Export / Import / Import-from-Lorebooks buttons
    el.querySelector('#kt-export-btn')?.addEventListener('click', () => exportNpcs());
    el.querySelector('#kt-import-btn')?.addEventListener('click', () => importNpcs());
    el.querySelector('#kt-import-lb-btn')?.addEventListener('click', () => importFromLorebooks());

    // Wire sub-tab specific events
    if (state.activeSubTab === 'staging') wireStagingEvents(el);
    else if (state.activeSubTab === 'minor' || state.activeSubTab === 'major') wireNpcListEvents(el, state.activeSubTab);
    else if (state.activeSubTab === 'state') wireStateTrackerEvents(el);
    else if (state.activeSubTab === 'relationships') wireRelationshipEvents(el);

    // Re-apply persisted status message
    if (state._lastKtStatusMsg) {
        const statusEl = el.querySelector('#kt-status');
        if (statusEl) {
            statusEl.textContent = state._lastKtStatusMsg;
            statusEl.className = `kt-status kt-status--${state._lastKtStatusLevel}`;
        }
    }

    // Notify the floating-button subsystem that staging state may have changed
    // so the Knowledge button's attention pulse + countdown badge update
    // immediately (rather than waiting up to 5 s for the next poll).
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
}

// ─── Staging sub-tab ─────────────────────────────────────────────────────────

function renderStagingContent(count) {
    if (count === 0) return '<div class="kt-empty">No pending proposals.<br>Click <strong>🔍 Scan</strong> to analyse recent messages.</div>';
    return `
        <div class="kt-staging-alert">
            <span class="kt-staging-alert-icon">📬</span>
            <span class="kt-staging-alert-text"><strong>${count} proposal${count !== 1 ? 's' : ''}</strong> awaiting your review — Accept to write to the lorebook, or Dismiss to discard.</span>
        </div>
        <div class="kt-staging-toolbar">
            <button id="kt-batch-accept" class="mwt-btn mwt-btn-primary">✓ Accept All</button>
            <button id="kt-batch-dismiss" class="mwt-btn">✗ Dismiss All</button>
            <span>${count} proposal(s)</span>
        </div>
        <div class="kt-staging-layout">
            <div class="kt-staging-list" id="kt-staging-list">
                ${state.stagingItems.map(item => `
                    <div class="kt-staging-item ${state.activeItemId === item.id ? 'kt-staging-item--active' : ''}" data-id="${item.id}">
                        <span class="kt-staging-badge">${item.action === 'create' ? 'New' : 'Update'} ${item.type}</span>
                        <span class="kt-staging-name">${escapeHtml(item.name)}</span>
                    </div>`).join('')}
            </div>
            <div class="kt-staging-detail" id="kt-staging-detail">
                ${state.activeItemId ? renderDetailForItem(state.stagingItems.find(i => i.id === state.activeItemId)) : '<div class="kt-detail-empty">Select a proposal.</div>'}
            </div>
        </div>`;
}

function renderDetailForItem(item) {
    if (!item) return '<div class="kt-detail-empty">Select a proposal.</div>';
    const editorContent = item.mergedContent || item.proposedContent || '';

    // Skip the diff view for state tracker updates: they use the full entry text
    // as both existing and proposed content, which produces noisy, misleading diffs.
    let diffHtml = '';
    if (item.type !== 'state' && item.existingContent && editorContent && item.existingContent !== editorContent) {
        const diff = renderLineDiff(item.existingContent, editorContent);
        if (diff) {
            diffHtml = `<div class="kt-detail-section">
                <div class="kt-detail-label">Changes (diff)</div>
                <div class="kt-detail-diff">${diff}</div>
            </div>`;
        }
    }

    return `<div class="kt-detail-inner">
        <div class="kt-detail-name">${escapeHtml(item.name)}</div>
        ${item.existingContent ? `<div class="kt-detail-section"><div class="kt-detail-label">Current</div><pre class="kt-detail-current">${escapeHtml(item.existingContent)}</pre></div>` : ''}
        ${diffHtml}
        <div class="kt-detail-section"><div class="kt-detail-label">Proposed</div><textarea class="kt-detail-editor" id="kt-proposal-editor">${escapeHtml(editorContent)}</textarea></div>
        ${item.type !== 'state' ? `<div class="kt-detail-section"><div class="kt-detail-label">Keywords</div><input class="kt-keyword-input" id="kt-keyword-input" type="text" value="${escapeHtml((item.keywords || [item.name]).join(', '))}" /></div>` : ''}
        <div class="kt-detail-actions"><button class="mwt-btn mwt-btn-primary" id="kt-accept">✓ Accept & Write</button><button class="mwt-btn" id="kt-dismiss">✗ Dismiss</button></div>
    </div>`;
}

function wireStagingEvents(el) {
    // Click staging items
    el.querySelectorAll('.kt-staging-item').forEach(item => {
        item.addEventListener('click', async () => {
            state.activeItemId = item.dataset.id;
            const stagingItem = state.stagingItems.find(i => i.id === state.activeItemId);
            // enrichStagingItem loads the existing entry and builds the merged
            // content using the correct formatter (minor / major / dossier). It
            // self-guards on action==='update' && existingContent===null && uid.
            if (stagingItem) await enrichStagingItem(stagingItem);
            renderNpcsSubTab();
        });
    });

    // Accept/dismiss buttons
    el.querySelector('#kt-accept')?.addEventListener('click', async () => {
        const item = state.stagingItems.find(i => i.id === state.activeItemId);
        if (!item) return;
        const editorVal = el.querySelector('#kt-proposal-editor')?.value;
        let text;
        if (editorVal) {
            text = editorVal;
        } else if (item.mergedContent && item.mergedContent !== '(promoting)' && item.mergedContent !== '(demoting)') {
            text = item.mergedContent;
        } else {
            text = item.proposedContent;
        }
        if (text === '(promoting)' || text === '(demoting)') {
            ktSetStatus('Click the staging item first to load full content before accepting.', 'error');
            return;
        }
        const keywordsRaw = el.querySelector('#kt-keyword-input')?.value || item.name;
        const keywords = item.type === 'state' ? [item.name] : keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);
        await handleAccept(item, text, keywords, el);
    });

    el.querySelector('#kt-dismiss')?.addEventListener('click', () => {
        if (state.activeItemId) removeNotificationEntry(state.activeItemId);
        state.stagingItems = state.stagingItems.filter(i => i.id !== state.activeItemId);
        state.activeItemId = null;
        renderNpcsSubTab();
    });

    // Batch buttons
    el.querySelector('#kt-batch-accept')?.addEventListener('click', async () => {
        if (!confirm(`Accept all ${state.stagingItems.length} proposals?`)) return;
        for (const item of [...state.stagingItems]) {
            try { await handleAccept(item, item.mergedContent || item.proposedContent, item.keywords || [item.name], el); } catch (e) { console.warn('[MWT:Knowledge] Batch accept failed:', e); }
        }
        renderNpcsSubTab();
    });

    el.querySelector('#kt-batch-dismiss')?.addEventListener('click', () => {
        if (!confirm(`Dismiss all ${state.stagingItems.length} proposals?`)) return;
        for (const item of state.stagingItems) removeNotificationEntry(item.id);
        state.stagingItems = [];
        state.activeItemId = null;
        renderNpcsSubTab();
    });
}

// ─── NPC list sub-tab ────────────────────────────────────────────────────────

function renderNpcListContent(type, entries) {
    if (Object.keys(entries).length === 0) return `<div class="kt-empty">No ${type} NPCs tracked yet.</div>`;
    const sorted = sortEntries(entries, 'name');
    const dossierMode = getSettings().dossierMode === true;
    return `<div class="kt-npc-list">${sorted.map(([name, info]) => {
        const isOrphan = info.uid === null || info.uid === undefined;
        const showEnrich = type === 'major' && !isOrphan && dossierMode;
        return `<div class="kt-npc-card${isOrphan ? ' kt-npc-card--orphan' : ''}" data-name="${escapeHtml(name)}" data-uid="${info.uid ?? ''}">
            <div class="kt-npc-card-header"><span class="kt-npc-name">${escapeHtml(name)}${isOrphan ? ' ⚠' : ''}</span><span class="kt-npc-meta">${(info.keywords || [name]).join(', ')}</span></div>
            <div class="kt-npc-actions">
                ${!isOrphan ? `
                    <button class="mwt-btn kt-npc-update" data-name="${escapeHtml(name)}" data-type="${type}">Update</button>
                    ${type === 'minor' ? `<button class="mwt-btn kt-npc-promote" data-name="${escapeHtml(name)}">⬆ Promote</button>` : ''}
                    ${showEnrich ? `<button class="mwt-btn kt-npc-enrich" data-name="${escapeHtml(name)}" data-uid="${info.uid}" title="Fill in all dossier fields (appearance, voice, background, secrets, etc.)">📋 Enrich</button>` : ''}
                    ${type === 'major' ? `<button class="mwt-btn kt-npc-demote" data-name="${escapeHtml(name)}">⬇ Demote</button>` : ''}
                    <button class="mwt-btn kt-npc-view" data-name="${escapeHtml(name)}">📖 View</button>
                ` : ''}
                <button class="mwt-btn kt-npc-remove" data-name="${escapeHtml(name)}">Remove</button>
            </div></div>`;
    }).join('')}</div>`;
}

function wireNpcListEvents(el, type) {
    el.querySelectorAll('.kt-npc-update').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const npcType = btn.dataset.type;
            const reg = getRegistry()[name];
            if (!reg?.uid && reg?.uid !== 0) { ktSetStatus(`No UID for "${name}".`, 'error'); return; }
            try {
                btn.disabled = true; btn.textContent = '⏳…';
                const result = await runNpcUpdate(name, reg.uid);
                const hasChanges = Object.values(result.fields).some(v => v !== null) || result.newKnowledge.length > 0;
                if (!hasChanges) { ktSetStatus(`No new info for "${name}".`, 'info'); return; }
                // runNpcUpdate already computed the major/dossier merge (result.merged)
                // and flagged result.dossierMode. Minor entries need their own merge.
                const useDossier = result.dossierMode === true;
                const mergedContent = npcType === 'minor'
                    ? buildUpdatedMinorContent(result.currentContent, result.fields || {})
                    : result.merged;
                state.stagingItems.push({
                    id: `npc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: npcType, action: 'update', name, data: {},
                    proposedContent: mergedContent, existingContent: result.currentContent,
                    mergedContent, keywords: reg.keywords || [name], uid: reg.uid,
                    fields: result.fields, newKnowledge: npcType === 'major' ? (result.newKnowledge || []) : [],
                    dossierMode: useDossier,
                });
                const stagedItem = state.stagingItems[state.stagingItems.length - 1];
                state.activeItemId = stagedItem.id;
                state.activeSubTab = 'staging';
                addNotificationEntry(stagedItem);
                renderNpcsSubTab();
                ktSetStatus(`Update for "${name}" staged.`, 'success');
            } catch (err) { ktSetStatus(`Update failed: ${err.message}`, 'error'); }
            finally { btn.disabled = false; btn.textContent = 'Update'; }
        });
    });

    // ── Enrich (Dossier) handler ──
    // Fills in ALL missing dossier fields for a major NPC by drawing on full
    // chat history + the existing entry content. This is the primary way to
    // upgrade a compact-format entry to a full dossier.
    el.querySelectorAll('.kt-npc-enrich').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const uid = parseInt(btn.dataset.uid, 10);
            const reg = getRegistry()[name];
            if (!reg?.uid && reg?.uid !== 0) { ktSetStatus(`No UID for "${name}".`, 'error'); return; }
            try {
                btn.disabled = true; btn.textContent = '⏳…';
                const result = await runNpcEnrich(name, reg.uid);
                state.stagingItems.push({
                    id: `enrich-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    type: 'major', action: 'update', name, data: {},
                    proposedContent: result.merged,
                    existingContent: result.currentContent,
                    mergedContent: result.merged,
                    keywords: reg.keywords || [name], uid: reg.uid,
                    fields: result.fields, newKnowledge: result.newKnowledge || [],
                    dossierMode: true,
                });
                const stagedItem = state.stagingItems[state.stagingItems.length - 1];
                state.activeItemId = stagedItem.id;
                state.activeSubTab = 'staging';
                addNotificationEntry(stagedItem);
                renderNpcsSubTab();
                ktSetStatus(`Dossier enrichment for "${name}" staged for review.`, 'success');
            } catch (err) { ktSetStatus(`Enrich failed: ${err.message}`, 'error'); }
            finally { btn.disabled = false; btn.textContent = '📋 Enrich'; }
        });
    });

    el.querySelectorAll('.kt-npc-promote').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const reg = getRegistry()[name];
            if (reg?.uid == null) return;
            const existing = await loadEntryContent(reg.uid);
            const item = {
                id: `promote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'promote', action: 'update', name, data: {},
                proposedContent: '(promoting)', existingContent: existing,
                mergedContent: existing ? buildPromotedContent(existing) : '',
                keywords: reg.keywords || [name], uid: reg.uid, fromType: 'minor', toType: 'major',
            };
            state.stagingItems.push(item);
            addNotificationEntry(item);
            state.activeItemId = item.id;
            state.activeSubTab = 'staging';
            renderNpcsSubTab();
        });
    });

    el.querySelectorAll('.kt-npc-demote').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const reg = getRegistry()[name];
            if (reg?.uid == null) return;
            const existing = await loadEntryContent(reg.uid);
            const item = {
                id: `demote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'demote', action: 'update', name, data: {},
                proposedContent: '(demoting)', existingContent: existing,
                mergedContent: existing ? buildDemotedContent(existing) : '',
                keywords: reg.keywords || [name], uid: reg.uid, fromType: 'major', toType: 'minor',
            };
            state.stagingItems.push(item);
            addNotificationEntry(item);
            state.activeItemId = item.id;
            state.activeSubTab = 'staging';
            renderNpcsSubTab();
        });
    });

    el.querySelectorAll('.kt-npc-view').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const reg = getRegistry()[name];
            if (!reg?.uid && reg?.uid !== 0) return;
            const content = await loadEntryContent(reg.uid);
            if (content) {
                const viewModal = document.createElement('div');
                viewModal.id = 'kt-view-modal';
                viewModal.innerHTML = `<div class="kt-history-backdrop"></div><div class="kt-history-panel"><div class="kt-history-header"><h3>${escapeHtml(name)}</h3><button class="kt-history-close">✕</button></div><div class="kt-history-body"><pre>${escapeHtml(content)}</pre></div></div>`;
                document.body.appendChild(viewModal);
                viewModal.querySelector('.kt-history-close').addEventListener('click', () => viewModal.remove());
                viewModal.querySelector('.kt-history-backdrop').addEventListener('click', () => viewModal.remove());
            }
        });
    });

    el.querySelectorAll('.kt-npc-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.name;
            if (!confirm(`Remove "${name}" from registry? (Lorebook entry stays.)`)) return;
            state.stagingItems = state.stagingItems.filter(i => i.name !== name);
            if (state.activeItemId && !state.stagingItems.find(i => i.id === state.activeItemId)) state.activeItemId = null;
            for (const id of Object.keys(state.notificationEntries)) {
                if (state.notificationEntries[id]?.item?.name === name) removeNotificationEntry(id);
            }
            const reg = getRegistry();
            delete reg[name];
            saveRegistry(reg);
            removeAllRelationshipsFor(name);
            renderNpcsSubTab();
        });
    });
}

// ─── State Trackers sub-tab ──────────────────────────────────────────────────

function renderStateTrackerContent() {
    const reg = getStateRegistry();
    const entries = Object.entries(reg);

    return `
        <div class="kt-state-container">
            <div class="kt-state-toolbar">
                <button id="kt-state-export" class="mwt-btn">⬇ Export</button>
                <button id="kt-state-import" class="mwt-btn">⬆ Import</button>
                <input type="file" id="kt-state-import-file" accept=".json" style="display:none" />
            </div>
            <div class="kt-state-register">
                <h3>Register a State Tracker</h3>
                <p style="color:var(--mwt-text-dim);font-size:12px">Create a lorebook entry in <strong>${STATE_LOREBOOK_NAME}</strong> with comment starting with <code>${TRACKER_SENTINEL}</code>.</p>
                <div style="display:flex;gap:8px;margin-top:8px">
                    <input type="number" id="kt-state-uid" placeholder="UID" min="0" class="mwt-input" style="width:80px" />
                    <input type="text" id="kt-state-name" placeholder="Display name" class="mwt-input" style="flex:1" />
                    <button id="kt-state-register" class="mwt-btn mwt-btn-primary">Register</button>
                </div>
            </div>
            ${entries.length === 0 ? '<div class="kt-empty">No state trackers registered.</div>' : `
            <div class="kt-state-list">
                ${entries.map(([name, info]) => {
                    const enabled = info.enabled !== false;
                    const alwaysUpdate = !!info.alwaysUpdate;
                    return `<div class="kt-npc-card">
                        <div class="kt-npc-card-header"><span class="kt-npc-name">${escapeHtml(name)}</span><span class="kt-npc-meta">UID ${info.uid}${enabled ? '' : ' · off'}${alwaysUpdate ? ' · always' : ''}</span></div>
                        <div class="kt-npc-actions">
                            <label><input type="checkbox" class="kt-state-enabled" data-name="${escapeHtml(name)}" ${enabled ? 'checked' : ''} /> Auto</label>
                            <label><input type="checkbox" class="kt-state-always" data-name="${escapeHtml(name)}" ${alwaysUpdate ? 'checked' : ''} /> Always</label>
                            <button class="mwt-btn kt-state-update" data-name="${escapeHtml(name)}">Update</button>
                            <button class="mwt-btn kt-state-remove" data-name="${escapeHtml(name)}">Remove</button>
                            <button class="mwt-btn kt-state-view" data-name="${escapeHtml(name)}">📖 View</button>
                        </div></div>`;
                }).join('')}
            </div>`}
        </div>`;
}

function wireStateTrackerEvents(el) {
    el.querySelector('#kt-state-register')?.addEventListener('click', async () => {
        const uid = parseInt(el.querySelector('#kt-state-uid')?.value, 10);
        const name = el.querySelector('#kt-state-name')?.value?.trim();
        if (Number.isNaN(uid) || !name) { ktSetStatus('Enter both UID and name.', 'error'); return; }
        const loaded = await loadStateTrackerEntry(uid);
        if (!loaded) { ktSetStatus(`UID ${uid} not found.`, 'error'); return; }
        if (!loaded.comment.startsWith(TRACKER_SENTINEL)) { ktSetStatus(`Missing ${TRACKER_SENTINEL} sentinel.`, 'error'); return; }
        registerStateTracker(name, uid);
        renderNpcsSubTab();
    });

    el.querySelectorAll('.kt-state-enabled').forEach(cb => {
        cb.addEventListener('change', () => { setStateTrackerEnabled(cb.dataset.name, cb.checked); renderNpcsSubTab(); });
    });

    el.querySelectorAll('.kt-state-always').forEach(cb => {
        cb.addEventListener('change', () => { setStateTrackerAlwaysUpdate(cb.dataset.name, cb.checked); renderNpcsSubTab(); });
    });

    el.querySelectorAll('.kt-state-update').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const info = getStateRegistry()[name];
            if (!info) return;
            try {
                btn.disabled = true; btn.textContent = '⏳…';
                const result = await runStateUpdate(name, info.uid);
                if (result.unchanged) { bumpStateTrackerTimestamp(name); renderNpcsSubTab(); ktSetStatus(`No change for "${name}".`, 'info'); return; }
                const stagingItem = {
                    id: `state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'state', action: 'update', name, data: {},
                    proposedContent: result.merged, existingContent: result.currentContent,
                    mergedContent: result.merged, keywords: [name], uid: info.uid,
                };
                const existingIdx = state.stagingItems.findIndex(it => it.type === 'state' && it.uid === info.uid);
                if (existingIdx >= 0) {
                    removeNotificationEntry(state.stagingItems[existingIdx].id);
                    state.stagingItems[existingIdx] = stagingItem;
                }
                else state.stagingItems.push(stagingItem);
                state.activeItemId = stagingItem.id;
                state.activeSubTab = 'staging';
                addNotificationEntry(stagingItem);
                renderNpcsSubTab();
                ktSetStatus(`State update for "${name}" staged.`, 'success');
            } catch (err) { ktSetStatus(`Update failed: ${err.message}`, 'error'); }
            finally { btn.disabled = false; btn.textContent = 'Update'; }
        });
    });

    el.querySelectorAll('.kt-state-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!confirm(`Remove "${btn.dataset.name}"? (Lorebook entry stays.)`)) return;
            unregisterStateTracker(btn.dataset.name);
            renderNpcsSubTab();
        });
    });

    el.querySelectorAll('.kt-state-view').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const info = getStateRegistry()[name];
            if (!info) return;
            const loaded = await loadStateTrackerEntry(info.uid);
            if (loaded) {
                const viewModal = document.createElement('div');
                viewModal.id = 'kt-view-modal';
                viewModal.innerHTML = `<div class="kt-history-backdrop"></div><div class="kt-history-panel"><div class="kt-history-header"><h3>${escapeHtml(name)}</h3><button class="kt-history-close">✕</button></div><div class="kt-history-body"><pre>${escapeHtml(loaded.content)}</pre></div></div>`;
                document.body.appendChild(viewModal);
                viewModal.querySelector('.kt-history-close').addEventListener('click', () => viewModal.remove());
                viewModal.querySelector('.kt-history-backdrop').addEventListener('click', () => viewModal.remove());
            }
        });
    });

    el.querySelector('#kt-state-export')?.addEventListener('click', async () => {
        const trackers = {};
        for (const [name, info] of Object.entries(getStateRegistry())) {
            const loaded = await loadStateTrackerEntry(info.uid);
            trackers[name] = { uid: info.uid, content: loaded?.content || null };
        }
        const { downloadJson } = await import('../core/index.js');
        downloadJson(`state-trackers-${Date.now()}.json`, { version: 1, trackers });
    });

    el.querySelector('#kt-state-import')?.addEventListener('click', async () => {
        const { pickTextFile } = await import('../core/index.js');
        const text = await pickTextFile('.json');
        if (!text) return;
        try {
            const snapshot = JSON.parse(text);
            if (!snapshot.trackers) throw new Error('Invalid format');
            for (const [name, data] of Object.entries(snapshot.trackers)) {
                if (data.uid !== undefined) registerStateTracker(name, data.uid);
            }
            renderNpcsSubTab();
            ktSetStatus('State trackers imported.', 'success');
        } catch (err) { ktSetStatus(`Import failed: ${err.message}`, 'error'); }
    });
}

// ─── NPC view modal (shared) ─────────────────────────────────────────────────

async function openNpcViewModal(name) {
    const reg = getRegistry()[name];
    if (!reg?.uid && reg?.uid !== 0) return;
    const content = await loadEntryContent(reg.uid);
    if (!content) return;
    const viewModal = document.createElement('div');
    viewModal.id = 'kt-view-modal';
    viewModal.innerHTML = `<div class="kt-history-backdrop"></div><div class="kt-history-panel"><div class="kt-history-header"><h3>${escapeHtml(name)}</h3><button class="kt-history-close">✕</button></div><div class="kt-history-body"><pre>${escapeHtml(content)}</pre></div></div>`;
    document.body.appendChild(viewModal);
    viewModal.querySelector('.kt-history-close').addEventListener('click', () => viewModal.remove());
    viewModal.querySelector('.kt-history-backdrop').addEventListener('click', () => viewModal.remove());
}

// ─── Relationship sub-tab ────────────────────────────────────────────────────

const REL_EDGE_COLORS = {
    ally: '#4ade80', friend: '#22c55e', family: '#f59e0b', lover: '#ec4899',
    rival: '#f97316', enemy: '#ef4444', neutral: '#9ca3af', acquaintance: '#6b7280',
    subordinate: '#3b82f6', superior: '#8b5cf6', mentor: '#06b6d4', student: '#0ea5e9',
    employer: '#a855f7', employee: '#d946ef',
};
function relEdgeColor(type) {
    return REL_EDGE_COLORS[(type || '').toLowerCase()] || '#6366f1';
}

function renderRelationshipContent() {
    const rels = getRelationships();
    const npcNames = getAllNpcNames();
    const allEdges = [];
    for (const [from, targets] of Object.entries(rels)) {
        for (const r of targets) {
            allEdges.push({ from, to: r.target, type: r.type, notes: r.notes || '' });
        }
    }

    const npcOptions = npcNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    const typeOptions = RELATIONSHIP_TYPES.map(t => `<option value="${t}">${t}</option>`).join('') + '<option value="__other__">Other…</option>';

    const viewMode = state.relViewMode || 'graph';

    // Collect unique types present for the legend
    const presentTypes = [...new Set(allEdges.map(e => e.type))];

    return `
       <div class="kt-rel-container">
           <div class="kt-rel-toolbar">
               <button id="kt-rel-sync-all" class="mwt-btn mwt-btn-primary" title="Write relationship blocks to all NPC lorebook entries">💾 Sync to Lorebooks</button>
               <span style="font-size:12px;color:var(--mwt-text-dim)">${allEdges.length} relationship(s)</span>
               <span class="kt-rel-view-toggle">
                   <button class="kt-rel-view-btn ${viewMode === 'graph' ? 'active' : ''}" data-view="graph" title="Graph view">🕸️ Graph</button>
                   <button class="kt-rel-view-btn ${viewMode === 'list' ? 'active' : ''}" data-view="list" title="List view">📋 List</button>
               </span>
            </div>
           <div class="kt-rel-add-row">
               <select id="kt-rel-from" class="mwt-input" style="min-width:120px"><option value="">From…</option>${npcOptions}</select>
               <select id="kt-rel-type" class="mwt-input" style="min-width:100px">${typeOptions}</select>
               <input id="kt-rel-type-custom" class="mwt-input" type="text" placeholder="Custom type…" style="display:none;min-width:100px" />
               <select id="kt-rel-to" class="mwt-input" style="min-width:120px"><option value="">To…</option>${npcOptions}</select>
               <input id="kt-rel-notes" class="mwt-input" type="text" placeholder="Notes (optional)" style="flex:1;min-width:120px" />
               <button id="kt-rel-add" class="mwt-btn mwt-btn-primary">+ Add</button>
            </div>
            ${allEdges.length === 0 ? '<div class="kt-empty">No relationships tracked yet.</div>' : (viewMode === 'graph' ? `
                <div class="kt-rel-graph-wrap">
                    <svg id="kt-rel-graph" class="kt-rel-graph" xmlns="http://www.w3.org/2000/svg"></svg>
                    <div class="kt-rel-graph-legend">
                        ${presentTypes.map(t => `<span class="kt-rel-legend-item"><span class="kt-rel-legend-swatch" style="background:${relEdgeColor(t)}"></span>${escapeHtml(t)}</span>`).join('')}
                    </div>
                    <div class="kt-rel-graph-hint">Click a node to view • Drag to rearrange • Scroll to zoom</div>
                </div>
            ` : `
           <div class="kt-rel-list">
                 ${allEdges.map(e => {
                     const reverse = (rels[e.to] || []).find(r => r.target === e.from);
                     const reverseLabel = reverse ? `<span class="kt-rel-reverse" title="${escapeHtml(e.to)} sees ${escapeHtml(e.from)} as: ${escapeHtml(reverse.type)}">↩ ${escapeHtml(reverse.type)}</span>` : '';
                     return `<div class="kt-rel-row" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}">
                       <span class="kt-rel-from">${escapeHtml(e.from)}</span>
                       <span class="kt-rel-type">${escapeHtml(e.type)}</span>
                       <span class="kt-rel-to">${escapeHtml(e.to)}</span>
                         ${e.notes ? `<span class="kt-rel-notes">${escapeHtml(e.notes)}</span>` : ''}
                         ${reverseLabel}
                       <button class="kt-rel-remove" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}" title="Remove">✕</button>
                     </div>`;
                 }).join('')}
             </div>`)}
        </div>`;
}

// ─── Relationship graph (force-directed SVG) ─────────────────────────────────

/**
 * Compute node positions for the relationship graph using a lightweight
 * Fruchterman–Reingold-style force-directed layout.
 *
 * @param {Array<{from:string,to:string,type:string}>} edges
 * @returns {{nodes:Map<string,{x:number,y:number}>, edges:Array, pairs:Map}}
 */
function computeGraphLayout(edges) {
    // Build node set
    const nodeNames = new Set();
    for (const e of edges) { nodeNames.add(e.from); nodeNames.add(e.to); }

    const W = 600, H = 400;
    const n = nodeNames.size;
    if (n === 0) return { nodes: new Map(), edges, pairs: new Map() };

    // Initial placement: circle
    const nodes = new Map();
    const cx = W / 2, cy = H / 2;
    const radius = Math.min(W, H) * 0.35;
    let i = 0;
    for (const name of nodeNames) {
        const angle = (i / Math.max(1, n)) * Math.PI * 2;
        nodes.set(name, {
            x: cx + radius * Math.cos(angle) + (Math.random() - 0.5) * 20,
            y: cy + radius * Math.sin(angle) + (Math.random() - 0.5) * 20,
        });
        i++;
    }

    // Group bidirectional edges into pairs for curved rendering
    const pairs = new Map(); // key "a|b" (sorted) -> { a, b, forward:edge, reverse:edge }
    for (const e of edges) {
        const key = [e.from, e.to].sort().join('|');
        if (!pairs.has(key)) pairs.set(key, { a: e.from, b: e.to, forward: null, reverse: null });
        const p = pairs.get(key);
        if (e.from === p.a) p.forward = e; else p.reverse = e;
    }

    // Simulate
    const idealLen = Math.max(60, Math.min(W, H) / Math.sqrt(Math.max(1, n)) * 0.8);
    const k = idealLen;
    const iterations = 200;
    const posArr = Array.from(nodes.values());

    // Precompute node-name → array-index lookup once (outside the hot loop).
    // The previous code called `Array.from(nodes.keys()).indexOf(p.a/b)` inside
    // the 200-iteration simulation for every edge — O(200 × E × N) linear
    // searches that dominated layout time for large graphs.
    const nodeIndex = new Map([...nodes.keys()].map((key, idx) => [key, idx]));
    const edgeList = Array.from(pairs.values());

    for (let iter = 0; iter < iterations; iter++) {
        const t = 1 - iter / iterations; // cooling
        const disp = posArr.map(() => ({ x: 0, y: 0 }));

        // Repulsive forces (all pairs)
        for (let a = 0; a < posArr.length; a++) {
            for (let b = 0; b < posArr.length; b++) {
                if (a === b) continue;
                let dx = posArr[a].x - posArr[b].x;
                let dy = posArr[a].y - posArr[b].y;
                let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                const force = (k * k) / dist;
                disp[a].x += (dx / dist) * force;
                disp[a].y += (dy / dist) * force;
            }
        }

        // Attractive forces (edges)
        for (const p of edgeList) {
            const aIdx = nodeIndex.get(p.a);
            const bIdx = nodeIndex.get(p.b);
            if (aIdx < 0 || bIdx < 0) continue;
            let dx = posArr[aIdx].x - posArr[bIdx].x;
            let dy = posArr[aIdx].y - posArr[bIdx].y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const force = (dist * dist) / k;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            disp[aIdx].x -= fx;
            disp[aIdx].y -= fy;
            disp[bIdx].x += fx;
            disp[bIdx].y += fy;
        }

        // Apply displacement with cooling and frame clamping
        const maxDisp = Math.max(4, 40 * t);
        for (let a = 0; a < posArr.length; a++) {
            let dx = disp[a].x, dy = disp[a].y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const limited = Math.min(dist, maxDisp);
            posArr[a].x += (dx / dist) * limited;
            posArr[a].y += (dy / dist) * limited;
            posArr[a].x = Math.max(30, Math.min(W - 30, posArr[a].x));
            posArr[a].y = Math.max(30, Math.min(H - 30, posArr[a].y));
        }
    }

    return { nodes, edges, pairs };
}

function drawSelfLoopEdge(ns, edgeGroup, pos, edge) {
    // Draw a self-relationship as a small loop offset up-right of the node.
    const r = 14;
    const cx = pos.x + 20;
    const cy = pos.y - 20;
    // Direction from loop center back toward the node; place arc endpoints
    // near the node so the loop visually attaches to it.
    const nodeAng = Math.atan2(pos.y - cy, pos.x - cx);
    const spread = 0.45; // radians between start/end points
    const sx = cx + r * Math.cos(nodeAng + spread);
    const sy = cy + r * Math.sin(nodeAng + spread);
    const ex = cx + r * Math.cos(nodeAng - spread);
    const ey = cy + r * Math.sin(nodeAng - spread);
    const color = relEdgeColor(edge.type);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', `url(#arrow-${edge.type.replace(/[^a-z0-9]/gi, '')})`);
    path.setAttribute('opacity', '0.85');
    path.setAttribute('class', 'kt-rel-graph-edge');
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${edge.from} → ${edge.to}: ${edge.type}${edge.notes ? ` (${edge.notes})` : ''}`;
    path.appendChild(title);
    edgeGroup.appendChild(path);
}

function renderRelationshipGraph() {
    const svg = document.getElementById('kt-rel-graph');
    if (!svg) return;

    const rels = getRelationships();
    const allEdges = [];
    for (const [from, targets] of Object.entries(rels)) {
        for (const r of targets) {
            allEdges.push({ from, to: r.target, type: r.type, notes: r.notes || '' });
        }
    }
    if (allEdges.length === 0) { svg.innerHTML = ''; return; }

    // Use cached layout if available (preserves drag), else compute
    if (!state._graphData || state._graphData._edgeSig !== JSON.stringify(allEdges.map(e => [e.from, e.to, e.type]).sort())) {
        state._graphData = computeGraphLayout(allEdges);
        state._graphData._edgeSig = JSON.stringify(allEdges.map(e => [e.from, e.to, e.type]).sort());
    }
    const data = state._graphData;

    const W = 600, H = 400;
    const ns = 'http://www.w3.org/2000/svg';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Clear
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // <defs> for arrowheads per type color
    const defs = document.createElementNS(ns, 'defs');
    const typeColors = new Map();
    for (const e of allEdges) typeColors.set(e.type, relEdgeColor(e.type));
    for (const [type, color] of typeColors) {
        const marker = document.createElementNS(ns, 'marker');
        marker.setAttribute('id', `arrow-${type.replace(/[^a-z0-9]/gi, '')}`);
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '18');
        marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '7');
        marker.setAttribute('markerHeight', '7');
        marker.setAttribute('orient', 'auto-start-reverse');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
        path.setAttribute('fill', color);
        marker.appendChild(path);
        defs.appendChild(marker);
    }
    svg.appendChild(defs);

    // Edges (as a group beneath nodes)
    const edgeGroup = document.createElementNS(ns, 'g');
    edgeGroup.setAttribute('class', 'kt-rel-graph-edges');
    for (const p of data.pairs.values()) {
        const aPos = data.nodes.get(p.a);
        const bPos = data.nodes.get(p.b);
        if (!aPos || !bPos) continue;
        if (p.a === p.b) {
            const edge = p.forward || p.reverse;
            if (edge) drawSelfLoopEdge(ns, edgeGroup, aPos, edge);
            continue;
        }
        const isBidirectional = !!(p.forward && p.reverse);
        const drawCurve = (fromPos, toPos, edge, offset) => {
            const mx = (fromPos.x + toPos.x) / 2;
            const my = (fromPos.y + toPos.y) / 2;
            const dx = toPos.x - fromPos.x;
            const dy = toPos.y - fromPos.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            // perpendicular unit vector for curve control point
            const px = -dy / len;
            const py = dx / len;
            const cxp = mx + px * offset;
            const cyp = my + py * offset;
            const color = relEdgeColor(edge.type);
            const path = document.createElementNS(ns, 'path');
            path.setAttribute('d', `M ${fromPos.x} ${fromPos.y} Q ${cxp} ${cyp} ${toPos.x} ${toPos.y}`);
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', '1.8');
            path.setAttribute('fill', 'none');
            path.setAttribute('marker-end', `url(#arrow-${edge.type.replace(/[^a-z0-9]/gi, '')})`);
            path.setAttribute('opacity', '0.85');
            path.setAttribute('class', 'kt-rel-graph-edge');
            const title = document.createElementNS(ns, 'title');
            title.textContent = `${edge.from} → ${edge.to}: ${edge.type}${edge.notes ? ` (${edge.notes})` : ''}`;
            path.appendChild(title);
            edgeGroup.appendChild(path);
        };
        if (isBidirectional) {
            // Offset the two edges so both arrows are visible
            drawCurve(aPos, bPos, p.forward, 25);
            drawCurve(bPos, aPos, p.reverse, 25);
        } else {
            const single = p.forward || p.reverse;
            if (single) drawCurve(data.nodes.get(single.from), data.nodes.get(single.to), single, 0);
        }
    }
    svg.appendChild(edgeGroup);

    // Nodes
    const nodeGroup = document.createElementNS(ns, 'g');
    nodeGroup.setAttribute('class', 'kt-rel-graph-nodes');
    for (const [name, pos] of data.nodes) {
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'kt-rel-graph-node');
        g.setAttribute('data-name', name);
        g.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
        g.style.cursor = 'pointer';

        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('r', '14');
        circle.setAttribute('class', 'kt-rel-graph-node-circle');
        g.appendChild(circle);

        const text = document.createElementNS(ns, 'text');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dy', '0.35em');
        text.setAttribute('class', 'kt-rel-graph-node-label');
        text.textContent = name.length > 10 ? name.slice(0, 9) + '…' : name;
        text.setAttribute('font-size', '11');
        text.setAttribute('fill', 'currentColor');
        g.appendChild(text);

        const title = document.createElementNS(ns, 'title');
        title.textContent = name;
        g.appendChild(title);

        nodeGroup.appendChild(g);
    }
    svg.appendChild(nodeGroup);

    wireRelationshipGraphInteractions(svg, data);
}

function wireRelationshipGraphInteractions(svg, data) {
    const ns = 'http://www.w3.org/2000/svg';
    let viewBox = svg.viewBox.baseVal;
    // Clone to make mutable if baseVal is read-only (some engines)
    const vbState = { x: viewBox.x, y: viewBox.y, w: viewBox.w, h: viewBox.h };

    // Node dragging
    let dragNode = null;
    let dragStart = null;
    let didDrag = false;

    const nodes = svg.querySelectorAll('.kt-rel-graph-node');

    nodes.forEach(nodeG => {
        const onPointerDown = (ev) => {
            const name = nodeG.getAttribute('data-name');
            dragNode = name;
            const pt = svgPoint(svg, ev);
            dragStart = { x: pt.x, y: pt.y };
            didDrag = false;
            ev.stopPropagation();
            nodeG.setPointerCapture(ev.pointerId);
        };
        const onPointerMove = (ev) => {
            if (!dragNode || dragNode !== nodeG.getAttribute('data-name')) return;
            const pt = svgPoint(svg, ev);
            const pos = data.nodes.get(dragNode);
            if (pos) {
                const dx = pt.x - dragStart.x;
                const dy = pt.y - dragStart.y;
                if (Math.abs(dx) + Math.abs(dy) > 3) didDrag = true;
                pos.x = Math.max(20, Math.min(580, pos.x + dx));
                pos.y = Math.max(20, Math.min(380, pos.y + dy));
                dragStart = { x: pt.x, y: pt.y };
                nodeG.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
                updateEdges(svg, data);
            }
        };
        const onPointerUp = (ev) => {
            if (dragNode === nodeG.getAttribute('data-name')) {
                try { nodeG.releasePointerCapture(ev.pointerId); } catch { /* */ }
                if (!didDrag) {
                    const name = nodeG.getAttribute('data-name');
                    openNpcViewModal(name);
                }
                dragNode = null;
            }
        };
        nodeG.addEventListener('pointerdown', onPointerDown);
        nodeG.addEventListener('pointermove', onPointerMove);
        nodeG.addEventListener('pointerup', onPointerUp);
        nodeG.addEventListener('pointercancel', onPointerUp);
    });

    // Pan via background drag
    let panStart = null;
    svg.addEventListener('pointerdown', (ev) => {
        if (ev.target === svg || ev.target.tagName === 'rect') {
            panStart = { x: ev.clientX, y: ev.clientY, vbx: vbState.x, vby: vbState.y };
            svg.setPointerCapture(ev.pointerId);
        }
    });
    svg.addEventListener('pointermove', (ev) => {
        if (!panStart) return;
        const rect = svg.getBoundingClientRect();
        const scale = vbState.w / rect.width;
        const dx = (ev.clientX - panStart.x) * scale;
        const dy = (ev.clientY - panStart.y) * scale;
        vbState.x = panStart.vbx - dx;
        vbState.y = panStart.vby - dy;
        svg.setAttribute('viewBox', `${vbState.x} ${vbState.y} ${vbState.w} ${vbState.h}`);
    });
    svg.addEventListener('pointerup', (ev) => {
        panStart = null;
        try { svg.releasePointerCapture(ev.pointerId); } catch { /* */ }
    });

    // Zoom on wheel (cursor-centered)
    svg.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const rect = svg.getBoundingClientRect();
        const mx = (ev.clientX - rect.left) / rect.width;
        const my = (ev.clientY - rect.top) / rect.height;
        const zoomFactor = ev.deltaY > 0 ? 1.1 : 0.9;
        const newW = Math.max(150, Math.min(2400, vbState.w * zoomFactor));
        const newH = newW * (vbState.h / vbState.w);
        // Keep the point under cursor stable
        vbState.x += (vbState.w - newW) * mx;
        vbState.y += (vbState.h - newH) * my;
        vbState.w = newW;
        vbState.h = newH;
        svg.setAttribute('viewBox', `${vbState.x} ${vbState.y} ${vbState.w} ${vbState.h}`);
    }, { passive: false });
}

function svgPoint(svg, ev) {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function updateEdges(svg, data) {
    const ns = 'http://www.w3.org/2000/svg';
    const edgeGroup = svg.querySelector('.kt-rel-graph-edges');
    if (!edgeGroup) return;
    edgeGroup.innerHTML = '';
    const typeColors = new Map();
    for (const e of data.edges) typeColors.set(e.type, relEdgeColor(e.type));
    for (const p of data.pairs.values()) {
        const aPos = data.nodes.get(p.a);
        const bPos = data.nodes.get(p.b);
        if (!aPos || !bPos) continue;
        if (p.a === p.b) {
            const edge = p.forward || p.reverse;
            if (edge) drawSelfLoopEdge(ns, edgeGroup, aPos, edge);
            continue;
        }
        const isBidirectional = !!(p.forward && p.reverse);
        const drawCurve = (fromPos, toPos, edge, offset) => {
            const mx = (fromPos.x + toPos.x) / 2;
            const my = (fromPos.y + toPos.y) / 2;
            const dx = toPos.x - fromPos.x;
            const dy = toPos.y - fromPos.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const px = -dy / len;
            const py = dx / len;
            const cxp = mx + px * offset;
            const cyp = my + py * offset;
            const color = relEdgeColor(edge.type);
            const path = document.createElementNS(ns, 'path');
            path.setAttribute('d', `M ${fromPos.x} ${fromPos.y} Q ${cxp} ${cyp} ${toPos.x} ${toPos.y}`);
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', '1.8');
            path.setAttribute('fill', 'none');
            path.setAttribute('marker-end', `url(#arrow-${edge.type.replace(/[^a-z0-9]/gi, '')})`);
            path.setAttribute('opacity', '0.85');
            path.setAttribute('class', 'kt-rel-graph-edge');
            const title = document.createElementNS(ns, 'title');
            title.textContent = `${edge.from} → ${edge.to}: ${edge.type}${edge.notes ? ` (${edge.notes})` : ''}`;
            path.appendChild(title);
            edgeGroup.appendChild(path);
        };
        if (isBidirectional) {
            drawCurve(aPos, bPos, p.forward, 25);
            drawCurve(bPos, aPos, p.reverse, 25);
        } else {
            const single = p.forward || p.reverse;
            if (single) drawCurve(data.nodes.get(single.from), data.nodes.get(single.to), single, 0);
        }
    }
}

function wireRelationshipEvents(el) {
    const typeSelect = el.querySelector('#kt-rel-type');
    const customInput = el.querySelector('#kt-rel-type-custom');
    if (typeSelect && customInput) {
        typeSelect.addEventListener('change', () => {
            customInput.style.display = typeSelect.value === '__other__' ? '' : 'none';
            if (typeSelect.value === '__other__') customInput.focus();
        });
    }

    // View toggle (graph ↔ list)
    el.querySelectorAll('.kt-rel-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.relViewMode = btn.dataset.view;
            renderNpcsSubTab();
        });
    });

    // Render the graph SVG now that the container is in the DOM
    if (state.relViewMode === 'graph') {
        requestAnimationFrame(() => renderRelationshipGraph());
    }

    el.querySelector('#kt-rel-add')?.addEventListener('click', async () => {
        const from = el.querySelector('#kt-rel-from')?.value;
        const to = el.querySelector('#kt-rel-to')?.value;
        let type = el.querySelector('#kt-rel-type')?.value;
        if (type === '__other__') {
            type = customInput?.value?.trim() || '';
        }
        const notes = el.querySelector('#kt-rel-notes')?.value?.trim() || '';
        if (!from || !to || !type) { ktSetStatus('Select From, Type, and To.', 'error'); return; }
        // Self-relationships (e.g. "their own worst enemy") are allowed.
        const npcNames = getAllNpcNames();
        if (!npcNames.includes(from)) { ktSetStatus(`"${from}" is not a known NPC.`, 'error'); return; }
        if (!npcNames.includes(to)) { ktSetStatus(`"${to}" is not a known NPC.`, 'error'); return; }
        updateRelationship(from, to, type, notes);
        state._graphData = null; // invalidate cached layout
        try {
            const result = await syncRelationshipsToLorebook(from);
            if (result.success && !result.unchanged) {
                ktSetStatus(`Relationship added and synced to "${from}" lorebook.`, 'success');
            } else if (result.success) {
                ktSetStatus(`Relationship added (lorebook unchanged).`, 'success');
            } else {
                ktSetStatus(`Relationship added but lorebook sync failed: ${result.error}`, 'warning');
            }
        } catch (err) {
            ktSetStatus(`Relationship added but sync failed: ${err.message}`, 'warning');
        }
        renderNpcsSubTab();
    });

    el.querySelectorAll('.kt-rel-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
            const from = btn.dataset.from;
            const to = btn.dataset.to;
            if (!confirm(`Remove relationship: ${from} → ${to}?`)) return;
            removeRelationship(from, to);
            state._graphData = null; // invalidate cached layout
            try { await syncRelationshipsToLorebook(from); } catch (err) { /* ignore */ }
            renderNpcsSubTab();
        });
    });

    el.querySelector('#kt-rel-sync-all')?.addEventListener('click', async () => {
        const btn = el.querySelector('#kt-rel-sync-all');
        try {
            btn.disabled = true; btn.textContent = '⏳ Syncing…';
            const result = await syncAllRelationshipsToLorebooks();
            ktSetStatus(`Synced ${result.synced} lorebook(s). ${result.failed > 0 ? result.failed + ' failed.' : ''}`, result.failed > 0 ? 'warning' : 'success');
        } catch (err) {
            ktSetStatus(`Sync failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false; btn.textContent = '💾 Sync to Lorebooks';
        }
    });
}

export {
    addNotificationEntry,
    removeNotificationEntry,
    initNotificationPanel,
    hideNotificationPanel,
    exportNpcs,
    importNpcs,
    importFromLorebooks,
};