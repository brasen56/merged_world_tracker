/**
 * knowledge/render.js — All UI rendering and DOM event wiring for the
 * Knowledge tab (NPC lists, staging, state trackers, relationships,
 * notification panel, settings panel).
 */

import {
    escapeHtml, renderLineDiff, escapeRegex, notify,
} from '../core/index.js';

import {
    RELATIONSHIP_TYPES, TRACKER_SENTINEL, STATE_LOREBOOK_NAME,
    state, getNpcsContentEl, getStateContentEl, ktSetStatus,
} from './state.js';
import { getSettings, hasValidSettings, showKnowledgeSettings } from './settings.js';
import {
    getRegistry, saveRegistry, getAllNpcNames,
    getStateRegistry, registerStateTracker, unregisterStateTracker,
    setStateTrackerEnabled, setStateTrackerAlwaysUpdate, bumpStateTrackerTimestamp,
} from './registry.js';
import {
    loadEntryContent, loadStateTrackerEntry, getHistory,
    runScan, runStateUpdate, runNpcUpdate,
    buildUpdatedMinorContent, buildUpdatedMajorContent,
    buildPromotedContent, buildDemotedContent,
    enrichStagingItem, writeToLorebook, writeStateTracker,
} from './lorebook.js';
import {
    getRelationships, updateRelationship, removeRelationship,
    syncRelationshipsToLorebook, syncAllRelationshipsToLorebooks,
} from './relationships.js';
import {
    buildStagingItems, STAGING_PLACEHOLDERS, exportNpcs, importNpcs, importFromLorebooks,
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

function unreadCount() { return Object.values(state.notificationEntries).filter(n => !n.read).length; }

function showNotificationPanel() {
    state.notifActiveId = true;
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

    const registry = getRegistry();
    const minorEntries = Object.fromEntries(Object.entries(registry).filter(([, v]) => v.type !== 'major'));
    const majorEntries = Object.fromEntries(Object.entries(registry).filter(([, v]) => v.type === 'major'));

    el.innerHTML = `
        <div class="kt-sub-tabs">
            <button class="kt-sub-tab ${state.activeSubTab === 'staging' ? 'active' : ''}" data-sub="staging">
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
}

// ─── Staging sub-tab ─────────────────────────────────────────────────────────

function renderStagingContent(count) {
    if (count === 0) return '<div class="kt-empty">No pending proposals.<br>Click <strong>🔍 Scan</strong> to analyse recent messages.</div>';
    return `
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

    let diffHtml = '';
    if (item.existingContent && editorContent && item.existingContent !== editorContent) {
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
            if (stagingItem && stagingItem.action === 'update' && stagingItem.existingContent === null && stagingItem.uid != null) {
                const existing = await loadEntryContent(stagingItem.uid);
                if (existing !== null) {
                    stagingItem.existingContent = existing;
                    if (stagingItem.type === 'minor') stagingItem.mergedContent = buildUpdatedMinorContent(existing, stagingItem.fields || {});
                    else if (stagingItem.type === 'major') stagingItem.mergedContent = buildUpdatedMajorContent(existing, stagingItem.fields || {}, stagingItem.newKnowledge || []);
                    else stagingItem.mergedContent = existing;
                }
            }
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
        state.stagingItems = [];
        state.activeItemId = null;
        renderNpcsSubTab();
    });
}

// ─── NPC list sub-tab ────────────────────────────────────────────────────────

function renderNpcListContent(type, entries) {
    if (Object.keys(entries).length === 0) return `<div class="kt-empty">No ${type} NPCs tracked yet.</div>`;
    const sorted = sortEntries(entries, 'name');
    return `<div class="kt-npc-list">${sorted.map(([name, info]) => {
        const isOrphan = info.uid === null || info.uid === undefined;
        return `<div class="kt-npc-card${isOrphan ? ' kt-npc-card--orphan' : ''}" data-name="${escapeHtml(name)}">
            <div class="kt-npc-card-header"><span class="kt-npc-name">${escapeHtml(name)}${isOrphan ? ' ⚠' : ''}</span><span class="kt-npc-meta">${(info.keywords || [name]).join(', ')}</span></div>
            <div class="kt-npc-actions">
                ${!isOrphan ? `
                    <button class="mwt-btn kt-npc-update" data-name="${escapeHtml(name)}" data-type="${type}">Update</button>
                    ${type === 'minor' ? `<button class="mwt-btn kt-npc-promote" data-name="${escapeHtml(name)}">⬆ Promote</button>` : ''}
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
                const mergedContent = npcType === 'minor'
                    ? buildUpdatedMinorContent(result.currentContent, result.fields || {})
                    : buildUpdatedMajorContent(result.currentContent, result.fields || {}, result.newKnowledge || []);
                state.stagingItems.push({
                    id: `npc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: npcType, action: 'update', name, data: {},
                    proposedContent: mergedContent, existingContent: result.currentContent,
                    mergedContent, keywords: reg.keywords || [name], uid: reg.uid,
                    fields: result.fields, newKnowledge: npcType === 'major' ? (result.newKnowledge || []) : [],
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

// ─── Relationship sub-tab ────────────────────────────────────────────────────

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

    return `
       <div class="kt-rel-container">
           <div class="kt-rel-toolbar">
               <button id="kt-rel-sync-all" class="mwt-btn mwt-btn-primary" title="Write relationship blocks to all NPC lorebook entries">💾 Sync to Lorebooks</button>
               <span style="font-size:12px;color:var(--mwt-text-dim)">${allEdges.length} relationship(s)</span>
            </div>
           <div class="kt-rel-add-row">
               <select id="kt-rel-from" class="mwt-input" style="min-width:120px"><option value="">From…</option>${npcOptions}</select>
               <select id="kt-rel-type" class="mwt-input" style="min-width:100px">${typeOptions}</select>
               <input id="kt-rel-type-custom" class="mwt-input" type="text" placeholder="Custom type…" style="display:none;min-width:100px" />
               <select id="kt-rel-to" class="mwt-input" style="min-width:120px"><option value="">To…</option>${npcOptions}</select>
               <input id="kt-rel-notes" class="mwt-input" type="text" placeholder="Notes (optional)" style="flex:1;min-width:120px" />
               <button id="kt-rel-add" class="mwt-btn mwt-btn-primary">+ Add</button>
            </div>
            ${allEdges.length === 0 ? '<div class="kt-empty">No relationships tracked yet.</div>' : `
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
            </div>`}
        </div>`;
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

    el.querySelector('#kt-rel-add')?.addEventListener('click', async () => {
        const from = el.querySelector('#kt-rel-from')?.value;
        const to = el.querySelector('#kt-rel-to')?.value;
        let type = el.querySelector('#kt-rel-type')?.value;
        if (type === '__other__') {
            type = customInput?.value?.trim() || '';
        }
        const notes = el.querySelector('#kt-rel-notes')?.value?.trim() || '';
        if (!from || !to || !type) { ktSetStatus('Select From, Type, and To.', 'error'); return; }
        if (from === to) { ktSetStatus('An NPC cannot have a relationship with themselves.', 'error'); return; }
        const npcNames = getAllNpcNames();
        if (!npcNames.includes(from)) { ktSetStatus(`"${from}" is not a known NPC.`, 'error'); return; }
        if (!npcNames.includes(to)) { ktSetStatus(`"${to}" is not a known NPC.`, 'error'); return; }
        updateRelationship(from, to, type, notes);
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