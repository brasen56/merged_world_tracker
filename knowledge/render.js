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
    mergeScanResults, formatHistoryAge,
    STAGING_PLACEHOLDERS,
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
            const added = mergeScanResults(newItems, removeNotificationEntry);
            state.activeItemId = null;
            // Enrich non-edited update proposals; edited ones keep their text.
            await Promise.all(added.filter(it => it.action === 'update' && !it.edited).map(it => enrichStagingItem(it)));
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

    // Build a "superseded proposals" section if prior proposals were
    // replaced by a newer scan. This shows the user exactly what was
    // overwritten so nothing is lost silently — and lets them restore
    // an older version if the new scan went in the wrong direction.
    let supersededHtml = '';
    if (Array.isArray(item.supersededContent) && item.supersededContent.length > 0) {
        supersededHtml = `<div class="kt-detail-section">
            <div class="kt-detail-label">Previous proposal${item.supersededContent.length > 1 ? 's' : ''} (superseded by this scan)</div>
            ${item.supersededContent.map((entry, i) => `
                <div class="kt-superseded-entry" style="margin-bottom:8px">
                    <div class="kt-detail-superseded-meta" style="font-size:11px;color:var(--mwt-text-dim);margin-bottom:2px">
                        ${escapeHtml(formatHistoryAge(entry.timestamp))}
                        <button class="mwt-btn kt-superseded-restore" data-idx="${i}" style="margin-left:8px;padding:2px 8px;font-size:11px">↩ Restore</button>
                    </div>
                    <pre class="kt-detail-current" style="opacity:0.7">${escapeHtml(entry.content)}</pre>
                </div>
            `).join('')}
        </div>`;
    }

    return `<div class="kt-detail-inner">
        <div class="kt-detail-name">${escapeHtml(item.name)}</div>
        ${item.existingContent ? `<div class="kt-detail-section"><div class="kt-detail-label">Current</div><pre class="kt-detail-current">${escapeHtml(item.existingContent)}</pre></div>` : ''}
        ${diffHtml}
        <div class="kt-detail-section"><div class="kt-detail-label">Proposed</div><textarea class="kt-detail-editor" id="kt-proposal-editor">${escapeHtml(editorContent)}</textarea></div>
        ${item.type !== 'state' ? `<div class="kt-detail-section"><div class="kt-detail-label">Keywords</div><input class="kt-keyword-input" id="kt-keyword-input" type="text" value="${escapeHtml((item.keywords || [item.name]).join(', '))}" /></div>` : ''}
        ${supersededHtml}
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

    // Track manual edits to the proposal editor so a subsequent re-scan can
    // preserve the user's text instead of overwriting it wholesale.
    const editorEl = el.querySelector('#kt-proposal-editor');
    editorEl?.addEventListener('input', () => {
        const item = state.stagingItems.find(i => i.id === state.activeItemId);
        if (!item) return;
        item.edited = true;
        item.mergedContent = editorEl.value;
        if (!item.proposedContent || STAGING_PLACEHOLDERS.includes(item.proposedContent)) {
            item.proposedContent = editorEl.value;
        }
    });

    // Accept/dismiss buttons
    el.querySelector('#kt-accept')?.addEventListener('click', async () => {
        const item = state.stagingItems.find(i => i.id === state.activeItemId);
        if (!item) return;
        const editorVal = el.querySelector('#kt-proposal-editor')?.value;
        let text;
        if (editorVal && !STAGING_PLACEHOLDERS.includes(editorVal)) {
            text = editorVal;
        } else if (item.mergedContent && !STAGING_PLACEHOLDERS.includes(item.mergedContent)) {
            text = item.mergedContent;
        } else if (item.proposedContent && !STAGING_PLACEHOLDERS.includes(item.proposedContent)) {
            text = item.proposedContent;
        } else {
            text = '';
        }
        if (!text || STAGING_PLACEHOLDERS.includes(text)) {
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
        let accepted = 0;
        let skipped = 0;
        for (const item of [...state.stagingItems]) {
            const text = item.mergedContent || item.proposedContent;
            // Reject placeholders (Fetch to see changes / promoting / demoting)
            // so unloaded proposals are never written to the lorebook. The
            // single-accept path guards this; the batch path previously had no
            // guard at all.
            if (!text || STAGING_PLACEHOLDERS.includes(text)) { skipped++; continue; }
            try { await handleAccept(item, text, item.keywords || [item.name], el); accepted++; } catch (e) { console.warn('[MWT:Knowledge] Batch accept failed:', e); }
        }
        if (skipped > 0) ktSetStatus(`${accepted} accepted · ${skipped} skipped (click the item to load its content first).`, 'info');
        renderNpcsSubTab();
    });

    el.querySelector('#kt-batch-dismiss')?.addEventListener('click', () => {
        if (!confirm(`Dismiss all ${state.stagingItems.length} proposals?`)) return;
        for (const item of state.stagingItems) removeNotificationEntry(item.id);
        state.stagingItems = [];
        state.activeItemId = null;
        renderNpcsSubTab();
    });

    // Restore a superseded proposal — swap the current proposal text for the
    // older one the user clicked, so nothing a scan produced is ever truly
    // lost. The current text becomes the latest superseded entry.
    el.querySelectorAll('.kt-superseded-restore').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = state.stagingItems.find(i => i.id === state.activeItemId);
            if (!item || !Array.isArray(item.supersededContent)) return;
            const idx = parseInt(btn.dataset.idx, 10);
            const entry = item.supersededContent[idx];
            if (!entry) return;
            const currentContent = item.mergedContent || item.proposedContent || '';
            // Swap: old restored content becomes the active proposal; the
            // current proposal is pushed into the superseded stack at the
            // same position so the user can flip back if they change their mind.
            item.mergedContent = entry.content;
            item.proposedContent = entry.content;
            item.edited = true;
            const newSuperseded = [...item.supersededContent];
            newSuperseded.splice(idx, 1);
            if (currentContent) newSuperseded.push({ content: currentContent, timestamp: Date.now() });
            item.supersededContent = newSuperseded;
            renderNpcsSubTab();
            ktSetStatus('Previous proposal restored.', 'success');
        });
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
                    ${type === 'major' ? `<button class="mwt-btn kt-npc-growth" data-name="${escapeHtml(name)}" data-uid="${info.uid}" title="Generate an evidence-driven growth profile from behavioral observations">🌱 Growth</button>` : ''}
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

    // ── Growth Profile handler ──
    // Generates an evidence-driven character profile (anti-textbook) from
    // behavioral observations captured in recent messages. Two API calls:
    // evidence capture, then profile synthesis. See NPC_GROWTH_BLUEPRINT.md.
    el.querySelectorAll('.kt-npc-growth').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            openGrowthProfileModal(name, btn);
        });
    });

    el.querySelectorAll('.kt-npc-view').forEach(btn => {
        btn.addEventListener('click', () => openNpcViewModal(btn.dataset.name));
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
            // Clean up the evidence file (Slice 2) so chat metadata doesn't
            // accumulate orphaned evidence for removed NPCs.
            import('./evidence.js').then(({ deleteEvidenceFile }) => deleteEvidenceFile(name));
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

// ─── NPC Growth Profile modal ────────────────────────────────────────────────

/**
 * Open the Growth Profile modal and run the generation pipeline.
 *
 * The modal shows a spinner during the two-phase generation (evidence capture
 * → profile synthesis), then displays the observations with their quote
 * receipts and the generated profile in an editable textarea.
 *
 * Slice 2: observations are persisted to the two-tier evidence store (raw[])
 * in chat metadata on capture. The user can edit claims, promote to canon,
 * or delete observations in-place, and save the (possibly edited) profile to
 * the non-injected "NPC Profiles" lorebook via the Save button.
 *
 * @param {string} name — NPC name
 * @param {HTMLButtonElement} triggerBtn — the button that launched the modal
 */
async function openGrowthProfileModal(name, triggerBtn) {
    // Build the modal skeleton (empty body, filled in async)
    const modal = document.createElement('div');
    modal.id = 'kt-growth-modal';
    modal.className = 'mwt-modal kt-growth-modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="mwt-modal-backdrop"></div>
        <div class="mwt-modal-panel">
            <div class="mwt-modal-header">
                <h3>🌱 Growth Profile — ${escapeHtml(name)}</h3>
                <button class="mwt-modal-close" title="Close">&times;</button>
            </div>
            <div class="mwt-modal-body">
                <div class="kt-growth-status">
                    <span class="kt-growth-spinner"></span>
                    <span class="kt-growth-status-text">Capturing behavioral evidence…</span>
                </div>
                <div class="kt-growth-content"></div>
            </div>
            <div class="mwt-modal-statusbar">
                <span class="mwt-status"></span>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('.mwt-modal-close');
    const statusText = modal.querySelector('.kt-growth-status-text');
    const contentEl = modal.querySelector('.kt-growth-content');
    const statusEl = modal.querySelector('.mwt-status');
    const cleanup = () => modal.remove();
    closeBtn.addEventListener('click', cleanup);
    // Backdrop click intentionally does NOT close this modal — the generated
    // evidence/profile view is easy to dismiss by accident, so require the ×
    // button or Escape. (The evidence itself is persisted in the store; this is
    // just about not nuking the on-screen review pane mid-inspection.)
    // Escape key
    const onKey = (e) => { if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    try {
        triggerBtn.disabled = true;
        triggerBtn.textContent = '⏳…';

        // The orchestrator (runGrowthProfile) runs both phases: capture then
        // generate. It persists observations to the evidence store (raw[]) and
        // generates from ALL accumulated evidence. We can't interleave status
        // updates between the two API calls without instrumenting the
        // orchestrator, so we show a combined status here and the per-phase
        // counts in the final render.
        const { runGrowthProfile, looksTruncated, loadProfile } = await import('./growth.js');
        const { getUserOverrides } = await import('./evidence.js');

        // Load any existing profile so the user can see (and edit) the current
        // version rather than starting from blank if they've generated before.
        const existingProfile = await loadProfile(name);
        const overrides = getUserOverrides(name);

        statusText.textContent = 'Capturing evidence & synthesizing profile…';
        const { observations, profile, canon, captureStats } = await runGrowthProfile(name);

        // Render the results. Flag a suspected truncation so a half-profile is
        // surfaced with a warning rather than silently shown as if complete.
        const truncated = looksTruncated(profile);
        const addedText = captureStats.added > 0
            ? ` · ${captureStats.added} new observation${captureStats.added !== 1 ? 's' : ''} added${captureStats.skipped > 0 ? ` (${captureStats.skipped} duplicate${captureStats.skipped !== 1 ? 's' : ''} skipped)` : ''}`
            : (captureStats.skipped > 0 ? ` · ${captureStats.skipped} duplicate${captureStats.skipped !== 1 ? 's' : ''} (already captured)` : '');
        statusText.textContent = truncated
            ? '⚠️ Profile may be truncated — see warning below.'
            : `Generated from ${observations.length} observation${observations.length !== 1 ? 's' : ''}${addedText}.`;
        const spinner = modal.querySelector('.kt-growth-spinner');
        if (spinner) spinner.style.display = 'none';

        contentEl.innerHTML = renderGrowthProfileContent(name, observations, profile, canon, truncated, existingProfile, captureStats, overrides);
        wireGrowthProfileEvents(modal, name, profile, triggerBtn);
    } catch (err) {
        statusText.textContent = '';
        const spinner = modal.querySelector('.kt-growth-spinner');
        if (spinner) spinner.style.display = 'none';
        contentEl.innerHTML = `<div class="kt-growth-error">❌ ${escapeHtml(err.message)}</div>`;
        console.warn(`[MWT:Knowledge] Growth profile for "${name}" failed:`, err);
    } finally {
        triggerBtn.disabled = false;
        triggerBtn.textContent = '🌱 Growth';
    }
}

/**
 * Render the growth profile results: evidence observations + profile prose.
 *
 * Slice 2: the profile section now includes a "Save to Lorebook" button that
 * writes the (possibly edited) profile to the non-injected "NPC Profiles"
 * lorebook, and the evidence section is editable (claim text, delete, promote
 * to canon) so the user can correct the model before saving.
 */
function renderGrowthProfileContent(name, observations, profile, canon, truncated = false, existingProfile = null, captureStats = null, overrides = []) {
    const obsByCategory = { trait: [], value: [], speech: [] };
    for (const o of observations) {
        const cat = obsByCategory[o.category] ? o.category : 'trait';
        obsByCategory[cat].push(o);
    }

    // Count consolidated vs raw for the toolbar status
    const consolidatedCount = observations.filter(o => o.tier === 'consolidated').length;
    const rawCount = observations.filter(o => o.tier !== 'consolidated').length;
    const nonCanonRawCount = observations.filter(o => o.tier !== 'consolidated' && !o.canon).length;

    const renderObsList = (cat, label) => {
        const list = obsByCategory[cat];
        if (!list || list.length === 0) return '';
        return `<div class="kt-growth-obs-group">
            <div class="kt-growth-obs-cat">${escapeHtml(label)} (${list.length})</div>
            ${list.map(o => `
                <div class="kt-growth-obs" data-obs-id="${escapeHtml(o.id || '')}" data-tier="${escapeHtml(o.tier || 'raw')}">
                    <div class="kt-growth-obs-header">
                        ${o.canon ? '<span class="kt-growth-obs-canon" title="Canon: user-authored, authoritative, outranks inference">👑 canon</span>' : ''}
                        ${o.tier === 'consolidated' ? '<span class="kt-growth-obs-tier" title="Consolidated from raw observations">🔗 consolidated</span>' : ''}
                    </div>
                    <div class="kt-growth-obs-claim" contenteditable="true" data-field="claim">${escapeHtml(o.claim)}</div>
                    <div class="kt-growth-obs-quote">"${escapeHtml(o.quote)}"${o.msgIdx != null ? ` <span class="kt-growth-obs-msgidx">[msg ${o.msgIdx}]</span>` : ''}${o.verified === false ? ` <span class="kt-growth-obs-unverified" title="This quote could not be matched word-for-word to its cited message — it may be paraphrased. Trace the message to confirm.">⚠ not verbatim</span>` : ''}</div>
                    ${o.tier !== 'consolidated' ? `<div class="kt-growth-obs-tools">
                        <button class="mwt-btn kt-growth-obs-canon-btn" data-action="canon" data-id="${escapeHtml(o.id || '')}">${o.canon ? '👑 Remove canon' : '👑 Promote to canon'}</button>
                        <button class="mwt-btn kt-growth-obs-del-btn" data-action="delete" data-id="${escapeHtml(o.id || '')}" title="Delete this observation">🗑</button>
                    </div>` : `<div class="kt-growth-obs-tools">
                        <button class="mwt-btn kt-growth-con-del-btn" data-action="con-delete" data-id="${escapeHtml(o.id || '')}" title="Delete this consolidated claim">🗑</button>
                        <button class="mwt-btn kt-growth-con-expand-btn" data-action="con-expand" data-id="${escapeHtml(o.id || '')}" title="Undo consolidation — restore source observations to raw">↩ Expand</button>
                    </div>`}
                </div>
            `).join('')}
        </div>`;
    };

    const captureNote = captureStats
        ? (captureStats.added > 0
            ? `${captureStats.added} new observation${captureStats.added !== 1 ? 's' : ''} added to evidence${captureStats.skipped > 0 ? `, ${captureStats.skipped} duplicate${captureStats.skipped !== 1 ? 's' : ''} skipped` : ''}.`
            : (captureStats.skipped > 0 ? `${captureStats.skipped} duplicate${captureStats.skipped !== 1 ? 's' : ''} — all already captured.` : ''))
        : '';

    return `
        ${truncated ? `<div class="kt-growth-warning">⚠️ <strong>This profile looks cut off mid-sentence.</strong> The model's response was likely truncated by a response-length cap <em>below</em> your Max Tokens — most often the connection profile's own preset. Open the browser console for <code>finish_reason</code> / <code>completion_tokens</code>, raise the effective cap, then regenerate.</div>` : ''}
        ${existingProfile ? `<div class="kt-growth-existing-note">📝 An existing profile was found in the NPC Profiles lorebook. The generated profile below will replace it when you save.</div>` : ''}
        ${captureNote ? `<div class="kt-growth-capture-note">📊 ${escapeHtml(captureNote)}</div>` : ''}
        <div class="kt-growth-evidence">
            <div class="kt-growth-section-label">📊 Evidence (${observations.length} observation${observations.length !== 1 ? 's' : ''}${consolidatedCount > 0 ? `: ${consolidatedCount} consolidated, ${rawCount} raw` : ''}) <span class="kt-growth-hint">— click a claim to edit, 👑 to promote to canon, 🗑 to delete</span></div>
            ${nonCanonRawCount >= 2 ? `<div class="kt-growth-evidence-tools">
                <button class="mwt-btn" id="kt-growth-consolidate" title="Distill raw observations into consolidated claims (Slice 3). Consumed raw entries are archived, not deleted.">🔗 Consolidate Evidence</button>
                <button class="mwt-btn" id="kt-growth-regenerate" title="Regenerate the profile from existing evidence without re-capturing">🔄 Regenerate Profile</button>
                <button class="mwt-btn" id="kt-growth-backfill" title="Expand ILS summary messages back to their originals and capture evidence from the restored text (Part B). One-time/bounded op.">📦 Backfill from Summaries</button>
            </div>` : (observations.length > 0 ? `<div class="kt-growth-evidence-tools">
                <button class="mwt-btn" id="kt-growth-regenerate" title="Regenerate the profile from existing evidence without re-capturing">🔄 Regenerate Profile</button>
                <button class="mwt-btn" id="kt-growth-backfill" title="Expand ILS summary messages back to their originals and capture evidence from the restored text (Part B). One-time/bounded op.">📦 Backfill from Summaries</button>
            </div>` : `<div class="kt-growth-evidence-tools">
                <button class="mwt-btn" id="kt-growth-backfill" title="Expand ILS summary messages back to their originals and capture evidence from the restored text (Part B). One-time/bounded op.">📦 Backfill from Summaries</button>
            </div>`)}
            ${renderObsList('trait', 'Traits')}
            ${renderObsList('value', 'Values')}
            ${renderObsList('speech', 'Speech')}
        </div>
        <div class="kt-growth-profile-section">
            <div class="kt-growth-section-label">📝 Generated Profile <span class="kt-growth-hint">(edit freely before saving)</span></div>
            <textarea class="kt-growth-profile-editor" id="kt-growth-profile-text">${escapeHtml(profile)}</textarea>
            <div class="kt-growth-actions">
                <button class="mwt-btn mwt-btn-primary" id="kt-growth-save">💾 Save to Lorebook</button>
                <button class="mwt-btn" id="kt-growth-copy">📋 Copy Profile</button>
                <button class="mwt-btn" id="kt-growth-copy-evidence">📋 Copy Evidence</button>
                <button class="mwt-btn" id="kt-growth-psychoanalyze" title="Generate a depth-oriented psychoanalytic portrait (copy-only — NEVER injected or saved)">🧠 Psychoanalyze</button>
            </div>
        </div>
        <div class="kt-growth-psychoanalyze-section" id="kt-growth-psychoanalyze-container" style="display:none">
            <div class="kt-growth-section-label">🧠 Psychoanalytic Portrait <span class="kt-growth-hint">(copy-only · NEVER injected or saved to any lorebook)</span></div>
            <div class="kt-growth-psychoanalyze-warning">⚠️ <strong>This is a dead-end analytical view.</strong> It reads the full character entry including <code>Personality:</code> as historical baseline. It is never injected, never saved, and never read by any other system. Copy it externally (notepad, etc.) to compare against future portraits.</div>
            <div class="kt-growth-psychoanalyze-content"></div>
        </div>
        ${overrides.length > 0 ? `<div class="kt-growth-overrides-section">
            <div class="kt-growth-section-label">📌 User Notes (survive regeneration) <span class="kt-growth-hint">— hand-edits pinned to the profile</span></div>
            ${overrides.map(o => `
                <div class="kt-growth-override" data-override-id="${escapeHtml(o.id)}">
                    <div class="kt-growth-override-text" contenteditable="true">${escapeHtml(o.text)}</div>
                    <button class="mwt-btn kt-growth-override-del" data-id="${escapeHtml(o.id)}" title="Delete this user note">🗑</button>
                </div>
            `).join('')}
        </div>` : ''}
        <div class="kt-growth-overrides-add">
            <button class="mwt-btn" id="kt-growth-add-override" title="Add a user note that survives profile regeneration">📌 Add User Note</button>
        </div>
        <div class="kt-growth-explainer">
            <strong>How this works:</strong> The profile above is generated solely from the behavioral
            observations listed under Evidence — each backed by a verbatim quote. It does not read or
            refine any prior <code>Personality:</code> line, breaking the feedback loop where personality
            is re-derived from its own prose every cycle. Observations are now persisted in chat metadata
            (the two-tier evidence store); saving writes the profile to the <strong>NPC Profiles</strong>
            lorebook (a separate lorebook with no keywords, so it's never auto-injected). Once an NPC has
            a growth profile, the dossier updater stops touching its <code>Personality:</code> line.
        </div>
    `;
}

function wireGrowthProfileEvents(modal, name, profile, triggerBtn) {

    // Helper to flash a status message in the modal's status bar.
    const flash = (msg, type = 'success') => {
        const statusEl = modal.querySelector('.mwt-status');
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.className = `mwt-status mwt-status-${type}`;
        statusEl.style.opacity = '1';
        if (type === 'success') setTimeout(() => { statusEl.style.opacity = '0'; }, 3000);
    };

    // ── Save to Lorebook ──
    modal.querySelector('#kt-growth-save')?.addEventListener('click', async () => {
        const text = modal.querySelector('#kt-growth-profile-text')?.value || profile;
        if (!text.trim()) { flash('Profile is empty — nothing to save.', 'error'); return; }
        const btn = modal.querySelector('#kt-growth-save');
        try {
            btn.disabled = true; btn.textContent = '⏳ Saving…';
            const { saveProfile } = await import('./growth.js');
            const result = await saveProfile(name, text);
            if (result.success) {
                flash(`Profile saved to "NPC Profiles" lorebook (UID ${result.uid}).`, 'success');
            } else {
                flash(`Save failed: ${result.error}`, 'error');
            }
        } catch (err) {
            flash(`Save failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false; btn.textContent = '💾 Save to Lorebook';
        }
    });

    // ── Copy Profile ──
    modal.querySelector('#kt-growth-copy')?.addEventListener('click', async () => {
        const text = modal.querySelector('#kt-growth-profile-text')?.value || profile;
        try {
            await navigator.clipboard.writeText(text);
            flash('Profile copied to clipboard.');
        } catch (err) {
            flash(`Copy failed: ${err.message}`, 'error');
        }
    });

    // ── Copy Evidence ──
    modal.querySelector('#kt-growth-copy-evidence')?.addEventListener('click', async () => {
        const claims = [...modal.querySelectorAll('.kt-growth-obs-claim')].map(el => el.textContent);
        const quotes = [...modal.querySelectorAll('.kt-growth-obs-quote')].map(el => el.textContent);
        const evidenceText = claims.map((c, i) => `- ${c}\n  Quote: ${quotes[i] || ''}`).join('\n');
        try {
            await navigator.clipboard.writeText(`Evidence for ${name}:\n${evidenceText}`);
            flash('Evidence copied to clipboard.');
        } catch (err) {
            flash(`Copy failed: ${err.message}`, 'error');
        }
    });

    // ── Psychoanalyze (dead-end view) ──
    // Generates a depth-oriented psychoanalytic portrait from the existing
    // evidence + the FULL lorebook entry (including Personality:). This is a
    // DEAD-END view — never injected, never saved, never read back. The user
    // copies it externally to compare across generations. See the blueprint
    // discussion for why the full entry is safe here (no path back to context).
    modal.querySelector('#kt-growth-psychoanalyze')?.addEventListener('click', async () => {
        const btn = modal.querySelector('#kt-growth-psychoanalyze');
        const container = modal.querySelector('#kt-growth-psychoanalyze-container');
        const contentDiv = modal.querySelector('.kt-growth-psychoanalyze-content');
        if (!container || !contentDiv) return;

        try {
            btn.disabled = true; btn.textContent = '⏳ Analyzing…';
            flash('Generating psychoanalytic portrait…', 'info');

            const { runPsychoanalyzeProfile, looksTruncated } = await import('./growth.js');
            const { portrait } = await runPsychoanalyzeProfile(name);

            // Prepend a self-documenting header so a saved profile (copied to
            // notepad) records when it was generated and how much evidence it
            // was based on — essential for longitudinal comparison.
            const now = new Date();
            const ts = now.toLocaleString();
            const header = `=== Psychoanalytic Portrait: ${name} ===\nGenerated: ${ts}\n(This is a dead-end analytical view — never injected, never saved to any lorebook. Copy externally to compare across generations.)\n\n`;

            const truncated = looksTruncated(portrait);
            container.style.display = '';
            contentDiv.innerHTML = `
                ${truncated ? '<div class="kt-growth-warning" style="margin-bottom:8px">⚠️ <strong>This portrait looks cut off mid-sentence.</strong> The model may have hit a response-length cap below your Max Tokens. Raise the effective cap and regenerate.</div>' : ''}
                <textarea class="kt-growth-psychoanalyze-editor" id="kt-growth-psychoanalyze-text">${escapeHtml(header + portrait)}</textarea>
                <div class="kt-growth-actions">
                    <button class="mwt-btn mwt-btn-primary" id="kt-growth-copy-psychoanalyze">📋 Copy Portrait</button>
                    <span class="kt-growth-hint" style="margin-left:8px">⚠ NEVER injected or saved — copy externally only</span>
                </div>
            `;

            // Wire the copy button for the psychoanalyze portrait
            const copyBtn = contentDiv.querySelector('#kt-growth-copy-psychoanalyze');
            copyBtn?.addEventListener('click', async () => {
                const text = contentDiv.querySelector('#kt-growth-psychoanalyze-text')?.value || '';
                try {
                    await navigator.clipboard.writeText(text);
                    flash('Psychoanalytic portrait copied to clipboard.');
                } catch (err) {
                    flash(`Copy failed: ${err.message}`, 'error');
                }
            });

            flash('Psychoanalytic portrait generated.', 'success');
            // Scroll to the new section
            container.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
            flash(`Psychoanalyze failed: ${err.message}`, 'error');
            const contentDiv = modal.querySelector('.kt-growth-psychoanalyze-content');
            if (contentDiv) {
                contentDiv.innerHTML = `<div class="kt-growth-error">❌ ${escapeHtml(err.message)}</div>`;
            }
            const container = modal.querySelector('#kt-growth-psychoanalyze-container');
            if (container) container.style.display = '';
        } finally {
            btn.disabled = false; btn.textContent = '🧠 Psychoanalyze';
        }
    });

    // ── Evidence editor: claim editing (save on blur) ──
    modal.querySelectorAll('.kt-growth-obs-claim[contenteditable]').forEach(el => {
        const obsId = el.closest('.kt-growth-obs')?.dataset.obsId;
        if (!obsId) return;
        el.addEventListener('blur', async () => {
            const { updateRawObservation } = await import('./evidence.js');
            updateRawObservation(name, obsId, { claim: el.textContent.trim() });
        });
    });

    // ── Evidence editor: promote/remove canon ──
    modal.querySelectorAll('.kt-growth-obs-canon-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const obsId = btn.dataset.id;
            if (!obsId) return;
            const { toggleCanon } = await import('./evidence.js');
            const isCanon = toggleCanon(name, obsId);
            if (isCanon === null) return;
            // Update the UI in-place without a full re-render so the user's
            // scroll position and editing focus are preserved.
            const obsEl = btn.closest('.kt-growth-obs');
            if (obsEl) {
                const header = obsEl.querySelector('.kt-growth-obs-header');
                if (isCanon) {
                    if (!header.querySelector('.kt-growth-obs-canon')) {
                        header.innerHTML = '<span class="kt-growth-obs-canon" title="Canon: user-authored, authoritative, outranks inference">👑 canon</span>';
                    }
                    btn.textContent = '👑 Remove canon';
                } else {
                    header.querySelector('.kt-growth-obs-canon')?.remove();
                    btn.textContent = '👑 Promote to canon';
                }
            }
            flash(isCanon ? 'Promoted to canon.' : 'Canon removed.');
        });
    });

    // ── Evidence editor: delete observation ──
    modal.querySelectorAll('.kt-growth-obs-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const obsId = btn.dataset.id;
            if (!obsId) return;
            const obsEl = btn.closest('.kt-growth-obs');
            if (!obsEl) return;
            if (!confirm('Delete this observation from the evidence store?')) return;
            const { deleteRawObservation } = await import('./evidence.js');
            const deleted = deleteRawObservation(name, obsId);
            if (deleted) {
                obsEl.remove();
                flash('Observation deleted from evidence.');
            }
        });
    });

    // ── Consolidated evidence: delete ── (Slice 3)
    modal.querySelectorAll('.kt-growth-con-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const conId = btn.dataset.id;
            if (!conId) return;
            if (!confirm('Delete this consolidated claim? (Its source observations remain archived.)')) return;
            const { deleteConsolidated } = await import('./evidence.js');
            const deleted = deleteConsolidated(name, conId);
            if (deleted) {
                btn.closest('.kt-growth-obs')?.remove();
                flash('Consolidated claim deleted.');
            }
        });
    });

    // ── Consolidated evidence: expand (undo consolidation) ── (Slice 3)
    modal.querySelectorAll('.kt-growth-con-expand-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const conId = btn.dataset.id;
            if (!conId) return;
            if (!confirm('Expand this consolidated claim? Its source observations will be restored from the archive to raw evidence.')) return;
            const { expandConsolidated } = await import('./evidence.js');
            const expanded = expandConsolidated(name, conId);
            if (expanded) {
                btn.closest('.kt-growth-obs')?.remove();
                flash('Consolidated claim expanded — source observations restored to raw.');
            }
        });
    });

    // ── Consolidate Evidence (Slice 3) ──
    modal.querySelector('#kt-growth-consolidate')?.addEventListener('click', async () => {
        const btn = modal.querySelector('#kt-growth-consolidate');
        try {
            btn.disabled = true; btn.textContent = '⏳ Consolidating…';
            flash('Consolidating evidence…', 'info');
            const { runConsolidation } = await import('./growth.js');
            const { consolidatedCount, archivedCount } = await runConsolidation(name);

            // Close this modal and re-open it fresh to show the consolidated
            // state. We close first so we don't stack two modals, then trigger
            // the growth button (which re-runs capture+generate with the
            // updated evidence store — consolidated entries are read first).
            modal.remove();
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.textContent = '🌱 Growth';
                triggerBtn.click();
            }
        } catch (err) {
            flash(`Consolidation failed: ${err.message}`, 'error');
            btn.disabled = false; btn.textContent = '🔗 Consolidate Evidence';
        }
    });

    // ── Regenerate Profile (Slice 3) ──
    modal.querySelector('#kt-growth-regenerate')?.addEventListener('click', async () => {
        const btn = modal.querySelector('#kt-growth-regenerate');
        try {
            btn.disabled = true; btn.textContent = '⏳ Regenerating…';
            flash('Regenerating profile from existing evidence…', 'info');
            const { regenerateProfile, looksTruncated } = await import('./growth.js');
            const { observations, profile: newProfile } = await regenerateProfile(name);
            const truncated = looksTruncated(newProfile);
            const { getUserOverrides } = await import('./evidence.js');
            const overrides = getUserOverrides(name);

            // Update the status text
            const statusTextEl = modal.querySelector('.kt-growth-status-text');
            if (statusTextEl) {
                statusTextEl.textContent = truncated
                    ? '⚠️ Profile may be truncated — see warning below.'
                    : `Regenerated from ${observations.length} observation${observations.length !== 1 ? 's' : ''}.`;
            }

            // Re-render the content with the new profile + evidence
            const contentEl = modal.querySelector('.kt-growth-content');
            if (contentEl) {
                contentEl.innerHTML = renderGrowthProfileContent(name, observations, newProfile, '', truncated, null, null, overrides);
                wireGrowthProfileEvents(modal, name, newProfile, triggerBtn);
            }
            flash('Profile regenerated from existing evidence.', 'success');
        } catch (err) {
            flash(`Regeneration failed: ${err.message}`, 'error');
            btn.disabled = false; btn.textContent = '🔄 Regenerate Profile';
        }
    });

    // ── ILS Backfill (Part B) ──
    // Expands ILS summary messages to their verbatim originals (from
    // chatMetadata.ILS_Originals) and captures evidence from the restored
    // text. READ-ONLY with respect to ILS data. Bounded/one-time op.
    modal.querySelector('#kt-growth-backfill')?.addEventListener('click', async () => {
        const btn = modal.querySelector('#kt-growth-backfill');
        try {
            btn.disabled = true; btn.textContent = '⏳ Backfilling…';
            flash('Backfilling evidence from ILS summaries…', 'info');
            const { runIlsBackfillCapture } = await import('./growth.js');
            const result = await runIlsBackfillCapture(name);

            if (result.added > 0) {
                flash(`Backfill complete: expanded ${result.expandedSummaries} summary(ies), +${result.added} observation(s).`, 'success');
                // Close and re-open to show the updated evidence
                modal.remove();
                if (triggerBtn) {
                    triggerBtn.disabled = false;
                    triggerBtn.textContent = '🌱 Growth';
                    triggerBtn.click();
                }
            } else {
                flash(`Backfill: no new observations found (${result.expandedSummaries} summary(ies) expanded, ${result.skipped} duplicate(s)).`, 'info');
                btn.disabled = false; btn.textContent = '📦 Backfill from Summaries';
            }
        } catch (err) {
            flash(`Backfill failed: ${err.message}`, 'error');
            btn.disabled = false; btn.textContent = '📦 Backfill from Summaries';
        }
    });

    // ── User Overrides: add (Slice 3) ──
    modal.querySelector('#kt-growth-add-override')?.addEventListener('click', async () => {
        const text = prompt('Enter a user note that will survive profile regeneration:');
        if (!text || !text.trim()) return;
        const { addUserOverride } = await import('./evidence.js');
        const id = addUserOverride(name, text);
        if (id) {
            flash('User note added.');
            // Re-render to show the new override
            const { getUserOverrides } = await import('./evidence.js');
            const overrides = getUserOverrides(name);
            const editorText = modal.querySelector('#kt-growth-profile-text')?.value || '';
            const contentEl = modal.querySelector('.kt-growth-content');
            if (contentEl) {
                // We need observations for re-render; read from the current modal
                // state by extracting from existing DOM. For simplicity, just
                // reload the modal content via regeneration (no API call needed
                // since the evidence hasn't changed, but we DO need the evidence
                // array). The cleanest approach: trigger the regenerate button
                // which reads from the store.
                const obsEls = [...modal.querySelectorAll('.kt-growth-obs')];
                const observations = obsEls.map(el => ({
                    id: el.dataset.obsId || '',
                    tier: el.dataset.tier || 'raw',
                    category: 'trait',
                    claim: el.querySelector('.kt-growth-obs-claim')?.textContent || '',
                    quote: el.querySelector('.kt-growth-obs-quote')?.textContent?.replace(/^"|"$/g, '') || '',
                    canon: !!el.querySelector('.kt-growth-obs-canon'),
                }));
                contentEl.innerHTML = renderGrowthProfileContent(name, observations, editorText, '', false, null, null, overrides);
                wireGrowthProfileEvents(modal, name, editorText, triggerBtn);
            }
        }
    });

    // ── User Overrides: edit (save on blur) ── (Slice 3)
    modal.querySelectorAll('.kt-growth-override-text[contenteditable]').forEach(el => {
        const overrideEl = el.closest('.kt-growth-override');
        const overrideId = overrideEl?.dataset.overrideId;
        if (!overrideId) return;
        el.addEventListener('blur', async () => {
            const { updateUserOverride } = await import('./evidence.js');
            updateUserOverride(name, overrideId, el.textContent.trim());
        });
    });

    // ── User Overrides: delete ── (Slice 3)
    modal.querySelectorAll('.kt-growth-override-del').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!id) return;
            const { deleteUserOverride } = await import('./evidence.js');
            const deleted = deleteUserOverride(name, id);
            if (deleted) {
                btn.closest('.kt-growth-override')?.remove();
                flash('User note deleted.');
            }
        });
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
            if (aIdx == null || bIdx == null) continue;
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
    const svg = state.modal?.querySelector('#kt-rel-graph');
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
            if (!pt) return;
            dragStart = { x: pt.x, y: pt.y };
            didDrag = false;
            ev.stopPropagation();
            nodeG.setPointerCapture(ev.pointerId);
        };
        const onPointerMove = (ev) => {
            if (!dragNode || dragNode !== nodeG.getAttribute('data-name')) return;
            const pt = svgPoint(svg, ev);
            if (!pt) return;
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
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    return pt.matrixTransform(ctm.inverse());
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
    importNpcs,
    importFromLorebooks,
};