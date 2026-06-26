/**
 * chronicle/render.js — All UI rendering: sub-views, editor, stats,
 * settings modal, injection selector, main render, and event binding.
 */

import {
    escapeHtml, buildInlineDiff, estimateTokens,
    renderApiSettingsFields, readApiSettingsValues,
    getGlobalSettings,
    createModal, showModal, hideModal, setStatus,
} from '../core/index.js';

import { CHRONICLE_INJECTION_HEADER } from './prompts.js';

import {
    state,
    getSettings, saveSettings, hasValidSettings,
    getChronicleData, setChronicleData, getSnapshots,
    getContentEl, scSetStatus, getMessageCountSinceLastSnapshot,
    showConfirm,
} from './data.js';

import {
    isInjectionEnabled, getEntriesForInjection, getInjectionStats, applyInjection,
} from './injection.js';

import {
    generateSnapshot, regenerateSnapshot, consolidateEntries,
    createManualEntry, deleteEntry, bulkDeleteEntries, restoreDeletedEntry,
} from './snapshots.js';

import { exportChronicle, exportMarkdown, triggerImport } from './import-export.js';

// ─── Sub-views ───────────────────────────────────────────────────────────────

export function showRegenerateDiff(originalText, newText, onDecision) {
    const el = getContentEl();
    if (!el) { onDecision(false); return; }
    const diffHtml = buildInlineDiff(originalText, newText);
    el.innerHTML = `
        <div class="sc-regenerate-diff">
            <h3>Regeneration Preview</h3>
            <p>Compare original vs regenerated. Choose which to keep.</p>
            <div class="sc-diff-container"><div class="sc-diff-panel"><h4>Original</h4><pre class="sc-diff-original">${diffHtml.originalHtml}</pre></div><div class="sc-diff-panel"><h4>Regenerated</h4><pre class="sc-diff-new">${diffHtml.newHtml}</pre></div></div>
            <p><strong>Original:</strong> ${originalText.split(/\s+/).length} words · <strong>Regenerated:</strong> ${newText.split(/\s+/).length} words</p>
            <div class="mwt-flex mwt-gap-4"><button id="sc-diff-accept" class="mwt-btn mwt-btn-primary">Accept Regenerated</button><button id="sc-diff-keep" class="mwt-btn">Keep Original</button></div>
        </div>`;
    el.querySelector('#sc-diff-accept')?.addEventListener('click', () => onDecision(true));
    el.querySelector('#sc-diff-keep')?.addEventListener('click', () => onDecision(false));
}

export function showConsolidationPreview(selectedEntries, inputContent, onConfirm) {
    const el = getContentEl();
    if (!el) return;
    el.innerHTML = `
        <div class="sc-consolidate-preview">
            <p>Review content fed to consolidator. Edit if needed.</p>
            ${selectedEntries.map((e, i) => `<details ${i === 0 ? 'open' : ''}><summary>${i === 0 ? 'BASE' : `DELTA ${i}`} — ${escapeHtml(e.worldDate || e.createdAt)}</summary><pre>${escapeHtml((e.text || '').slice(0, 2000))}</pre></details>`).join('')}
            <textarea id="sc-consolidate-input" class="mwt-textarea" rows="12">${escapeHtml(inputContent)}</textarea>
            <div class="sc-status"><span class="sc-status"></span></div>
            <div class="mwt-flex mwt-gap-4"><button id="sc-consolidate-go" class="mwt-btn mwt-btn-primary" ${!hasValidSettings() ? 'disabled' : ''}>Consolidate</button><button id="sc-consolidate-cancel" class="mwt-btn">Cancel</button></div>
        </div>`;
    el.querySelector('#sc-consolidate-go')?.addEventListener('click', function () { this.disabled = true; onConfirm(el.querySelector('#sc-consolidate-input')?.value || inputContent); });
    el.querySelector('#sc-consolidate-cancel')?.addEventListener('click', () => renderContent());
}

function showEntryEditor(snapshot) {
    const el = getContentEl();
    if (!el) return;
    const charList = snapshot.characters?.length ? snapshot.characters.join(', ') : 'None';
    el.innerHTML = `
        <div class="sc-editor">
            <div class="sc-editor-meta"><span>ID: ${escapeHtml(snapshot.id)}</span><span>Created: ${escapeHtml(snapshot.createdAt)}</span><span>World Date: ${escapeHtml(snapshot.worldDate || '—')}</span>${snapshot.manual ? '<span class="sc-badge">Manual</span>' : ''}${snapshot.consolidated ? '<span class="sc-badge">Consolidated</span>' : ''}</div>
            <div><span>Characters:</span> ${escapeHtml(charList)}</div>
            <div><span>Note:</span> <input type="text" id="sc-note-input" class="mwt-input" value="${escapeHtml(snapshot.note || '')}" placeholder="Add a note..."></div>
            <textarea id="sc-editor-textarea" class="mwt-textarea" rows="20">${escapeHtml(snapshot.text)}</textarea>
            <div class="sc-status"><span class="sc-status"></span></div>
            <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                <button id="sc-save-edit" class="mwt-btn mwt-btn-primary">Save</button>
                <button id="sc-regenerate-btn" class="mwt-btn" ${!snapshot.manual && hasValidSettings() ? '' : 'disabled'}>Regenerate</button>
                ${snapshot._consolidatedFrom?.length ? '<button id="sc-undo-consolidate" class="mwt-btn">↩ Undo Consolidation</button>' : ''}
                <button id="sc-delete-btn" class="mwt-btn" style="background:var(--mwt-danger)">Delete</button>
                <button id="sc-back-btn" class="mwt-btn">← Back</button>
            </div>
        </div>`;

    const originalText = snapshot.text;
    el.querySelector('#sc-save-edit')?.addEventListener('click', () => {
        const newText = el.querySelector('#sc-editor-textarea')?.value || '';
        const newNote = el.querySelector('#sc-note-input')?.value || '';
        const snapshots = getSnapshots();
        const idx = snapshots.findIndex(s => s.id === snapshot.id);
        if (idx !== -1) {
            const updated = [...snapshots];
            updated[idx] = { ...snapshot, text: newText, note: newNote, _previousText: originalText };
            setChronicleData({ snapshots: updated });
            applyInjection();
            scSetStatus('Entry saved.', 'success');
        }
    });
    el.querySelector('#sc-regenerate-btn')?.addEventListener('click', () => { if (!snapshot.manual) regenerateSnapshot(snapshot.id); });
    el.querySelector('#sc-delete-btn')?.addEventListener('click', () => deleteEntry(snapshot.id));
    el.querySelector('#sc-back-btn')?.addEventListener('click', () => { state.selectedSnapshotId = null; renderContent(); });
    el.querySelector('#sc-undo-consolidate')?.addEventListener('click', () => {
        if (!snapshot._consolidatedFrom?.length) return;
        showConfirm('Undo consolidation?', 'Restores original entries.', () => {
            const snapshots = getSnapshots();
            const remaining = snapshots.filter(s => s.id !== snapshot.id);
            const deletedBin = getChronicleData()._deletedBin || [];
            const restored = [];
            for (const origId of snapshot._consolidatedFrom) {
                const fromTrash = deletedBin.find(e => e.id === origId);
                if (fromTrash) restored.push({ ...fromTrash, _restored: true });
            }
            if (!restored.length) { scSetStatus('Originals not found in trash.', 'error'); return; }
            const updatedTrash = deletedBin.filter(e => !restored.some(r => r.id === e.id));
            const newSnapshots = [...remaining, ...restored].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            setChronicleData({ snapshots: newSnapshots, _deletedBin: updatedTrash, suggestSent: false });
            applyInjection();
            state.selectedSnapshotId = null;
            renderContent();
            scSetStatus(`${restored.length} entries restored.`, 'success');
        });
    });
}

function showTrashModal() {
    const el = getContentEl();
    if (!el) return;
    const deletedBin = getChronicleData()._deletedBin || [];
    if (!deletedBin.length) {
        el.innerHTML = `<div><p>Trash is empty.</p><button id="sc-back-from-trash" class="mwt-btn">← Back</button></div>`;
    } else {
        el.innerHTML = `<div><h3>Recently Deleted (${deletedBin.length})</h3>
            ${deletedBin.map(e => `<div style="padding:8px;border-bottom:1px solid var(--mwt-border)"><span>${escapeHtml(e.worldDate || e.createdAt)}</span> <span>${escapeHtml((e.text || '').slice(0, 80))}…</span> <button class="mwt-btn sc-restore-btn" data-id="${escapeHtml(e.id)}">Restore</button></div>`).join('')}
            <div class="mwt-flex mwt-gap-4 mwt-mt-8"><button id="sc-empty-trash" class="mwt-btn" style="background:var(--mwt-danger)">Empty Trash</button><button id="sc-back-from-trash" class="mwt-btn">← Back</button></div></div>`;
        el.querySelectorAll('.sc-restore-btn').forEach(btn => {
            btn.addEventListener('click', () => { const entry = deletedBin.find(e => e.id === btn.dataset.id); if (entry) restoreDeletedEntry(entry); });
        });
        el.querySelector('#sc-empty-trash')?.addEventListener('click', () => {
            showConfirm('Permanently delete all trashed entries?', 'Cannot be undone.', () => { setChronicleData({ _deletedBin: [] }); renderContent(); scSetStatus('Trash emptied.', 'success'); });
        });
    }
    el.querySelector('#sc-back-from-trash')?.addEventListener('click', () => { state.selectedSnapshotId = null; renderContent(); });
}

function showStatsModal() {
    const el = getContentEl();
    if (!el) return;
    const stats = getInjectionStats();
    const snapshots = getSnapshots();
    const charMap = new Map();
    snapshots.forEach(s => { if (s.characters) s.characters.forEach(c => { charMap.set(c, (charMap.get(c) || 0) + 1); }); });
    const topChars = Array.from(charMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => `${n} (${c})`).join(', ') || 'None';
    const tokenWarning = stats.tokenEstimate > 4000 ? '⚠️ High token usage' : '✅ Within limits';
    const tokenWarningClass = stats.tokenEstimate > 4000 ? 'mwt-token-info--danger' : stats.tokenEstimate > 2000 ? 'mwt-token-info--warn' : '';
        el.innerHTML = `<div>
        <h3>📊 Statistics</h3>
        <div class="sc-stats-grid"><div><span>Total Entries:</span><strong>${stats.totalEntries}</strong></div><div><span>Generated:</span><strong>${stats.generatedCount}</strong></div><div><span>Manual:</span><strong>${stats.manualCount}</strong></div><div><span>Consolidated:</span><strong>${stats.consolidatedCount}</strong></div></div>
        <div class="sc-stats-grid"><div><span>Total Words:</span><strong>${stats.totalWords}</strong></div><div><span>Avg/Entry:</span><strong>${stats.totalEntries > 0 ? Math.round(stats.totalWords / stats.totalEntries) : 0}</strong></div></div>
        <h4>Injection (${stats.injectMode})</h4>
        <div class="sc-stats-grid"><div><span>Entries:</span><strong>${stats.entriesToInject}</strong></div><div><span>Est. Tokens:</span><strong class="${tokenWarningClass}">${stats.tokenEstimate}</strong></div><div><span>Status:</span><strong>${tokenWarning}</strong></div></div>
        <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px"><strong>Status</strong> compares estimated injection tokens against a ~4000 token soft limit. To reduce tokens: lower the entry count in <strong>⚙ Injection Settings</strong> (gear button below entry list), switch from "All" to "Recent" mode, or consolidate older entries.</p>
        <h4>Characters (${stats.characterCount})</h4><p>${escapeHtml(topChars)}</p>
        <button id="sc-stats-close" class="mwt-btn">← Back</button>
    </div>`;
    el.querySelector('#sc-stats-close')?.addEventListener('click', () => renderContent());
}

function showPreviewInjection() {
    const entries = getEntriesForInjection();
    if (entries.length === 0) {
        scSetStatus('No chronicle entries to preview — generate or enable injection first.', 'warning');
        return;
    }
    const snapshots = getSnapshots();
    entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const text = entries.map(s => {
        const num = snapshots.indexOf(s) + 1;
        const charInfo = s.characters?.length ? ` [${s.characters.join(', ')}]` : '';
        return `### Chronicle Entry ${num} — ${s.worldDate || s.createdAt}${charInfo}\n${s.text}`;
    }).join('\n\n---\n\n');

    const injected = `${CHRONICLE_INJECTION_HEADER}\n\n${text}`;
    const tokens = estimateTokens(injected);

    // Resolve depth/role for display
    const globalSettings = getGlobalSettings();
    const depth = Number.isFinite(globalSettings.chronicleDepth) ? globalSettings.chronicleDepth : (getChronicleData().injectDepth ?? 2);
    const roleName = globalSettings.chronicleRole || 'system';

    const previewModal = createModal({
        id: 'mwt-sc-injection-preview',
        title: 'Chronicle Injection Preview',
        content: `
            <p class="mwt-text-dim mwt-text-sm mwt-mb-8">
                This is exactly what gets injected into the prompt (${injected.length} chars, ~${tokens} tokens).
                Depth: <strong>${depth}</strong> · Role: <strong>${roleName}</strong>.
            </p>
            <pre style="white-space:pre-wrap;font-family:var(--mwt-font-mono);font-size:12px;line-height:1.5;background:var(--mwt-bg-light);padding:12px;border-radius:var(--mwt-radius);border:1px solid var(--mwt-border);max-height:60vh;overflow-y:auto">${escapeHtml(injected)}</pre>
            <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                <button id="mwt-sc-preview-copy" class="mwt-btn mwt-btn-primary">📋 Copy to Clipboard</button>
                <button id="mwt-sc-preview-close" class="mwt-btn">Close</button>
            </div>
        `,
    });

    previewModal.querySelector('#mwt-sc-preview-copy')?.addEventListener('click', () => {
        navigator.clipboard.writeText(injected).then(() => {
            setStatus(previewModal, 'Copied to clipboard.', 'success', 2000);
        }).catch(() => {
            setStatus(previewModal, 'Failed to copy.', 'error');
        });
    });

    previewModal.querySelector('#mwt-sc-preview-close')?.addEventListener('click', () => {
        hideModal('mwt-sc-injection-preview');
    });

    showModal('mwt-sc-injection-preview');
}

function showInjectionSelector() {
    const el = getContentEl();
    if (!el) return;
    const data = getChronicleData();
    const snapshots = getSnapshots();
    const currentMode = data.injectMode || 'recent';
    const currentCount = data.injectCount || 2;
    const selectedForInjection = data.selectedForInjection || [];
    el.innerHTML = `<div>
        <h3>Injection Settings</h3>
        <div><label><input type="radio" name="sc-inject-mode" value="recent" ${currentMode === 'recent' ? 'checked' : ''}> Recent</label><label><input type="radio" name="sc-inject-mode" value="selected" ${currentMode === 'selected' ? 'checked' : ''}> Selected</label><label><input type="radio" name="sc-inject-mode" value="all" ${currentMode === 'all' ? 'checked' : ''}> All</label><label><input type="radio" name="sc-inject-mode" value="range" ${currentMode === 'range' ? 'checked' : ''}> Range</label></div>
        <div id="sc-inject-mode-options">
            <div id="sc-recent-options" style="display:${currentMode === 'recent' ? 'block' : 'none'}"><label>Count: <input type="number" id="sc-inject-count" value="${currentCount}" min="1" max="${snapshots.length}"></label></div>
            <div id="sc-selected-options" style="display:${currentMode === 'selected' ? 'block' : 'none'}">${snapshots.map(s => `<label><input type="checkbox" class="sc-inject-select-cb" data-id="${escapeHtml(s.id)}" ${selectedForInjection.includes(s.id) ? 'checked' : ''}> ${escapeHtml(s.worldDate || s.createdAt)} — ${escapeHtml((s.text || '').slice(0, 50))}</label>`).join('<br>')}</div>
            <div id="sc-range-options" style="display:${currentMode === 'range' ? 'block' : 'none'}"><label>From: <input type="datetime-local" id="sc-inject-from" value="${data.injectFromDate || ''}"></label><label>To: <input type="datetime-local" id="sc-inject-to" value="${data.injectToDate || ''}"></label></div>
        </div>
        <div class="mwt-flex mwt-gap-4 mwt-mt-8"><button id="sc-apply-injection" class="mwt-btn mwt-btn-primary">Apply</button><button id="sc-cancel-injection" class="mwt-btn">Cancel</button></div>
    </div>`;
    el.querySelectorAll('input[name="sc-inject-mode"]').forEach(r => {
        r.addEventListener('change', () => {
            const mode = r.value;
            const ro = el.querySelector('#sc-recent-options'); if (ro) ro.style.display = mode === 'recent' ? 'block' : 'none';
            const so = el.querySelector('#sc-selected-options'); if (so) so.style.display = mode === 'selected' ? 'block' : 'none';
            const rao = el.querySelector('#sc-range-options'); if (rao) rao.style.display = mode === 'range' ? 'block' : 'none';
        });
    });
    el.querySelector('#sc-apply-injection')?.addEventListener('click', () => {
        const mode = el.querySelector('input[name="sc-inject-mode"]:checked')?.value || 'recent';
        let newData = { injectMode: mode };
        if (mode === 'recent') { newData.injectCount = parseInt(el.querySelector('#sc-inject-count')?.value) || 2; newData.selectedForInjection = []; }
        else if (mode === 'selected') { const sel = []; el.querySelectorAll('.sc-inject-select-cb:checked').forEach(cb => sel.push(cb.dataset.id)); newData.selectedForInjection = sel; }
        else if (mode === 'range') { newData.injectFromDate = el.querySelector('#sc-inject-from')?.value || ''; newData.injectToDate = el.querySelector('#sc-inject-to')?.value || ''; }
        setChronicleData(newData);
        applyInjection();
        renderContent();
        scSetStatus(`Injection set to "${mode}".`, 'success');
    });
    el.querySelector('#sc-cancel-injection')?.addEventListener('click', () => renderContent());
}

function showSettingsModal() {
    const el = getContentEl();
    if (!el) return;
    const s = getSettings();
    const apiFieldOpts = {
        urlId: 'sc-api-url', keyId: 'sc-api-key', modelId: 'sc-model',
        maxTokensId: 'sc-max-tokens', tempId: 'sc-temp', topPId: 'sc-top-p',
        freqId: 'sc-freq-pen', presId: 'sc-pres-pen', headersId: 'sc-headers',
        maxTokensDefault: 8000,
    };
    el.innerHTML = `<div>
        <h3>Chronicle Settings</h3>
        <div class="mwt-settings-grid">
            ${renderApiSettingsFields(s, apiFieldOpts)}
            <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Custom Headers: JSON object of extra HTTP headers sent with each API request. Example: <code>{"X-Organization":"my-org"}</code>. Leave blank if unsure.</p>
        </div>
        <div style="margin-top:12px">
            <label><input type="checkbox" id="sc-filter-system" ${s.filterSystem !== false ? 'checked' : ''}> Filter system messages <span style="font-size:11px;color:var(--mwt-text-dim)">(hides SillyTavern system prompts, jailbreaks, etc.)</span></label><br>
            <label><input type="checkbox" id="sc-filter-ooc" ${s.filterOoc !== false ? 'checked' : ''}> Filter OOC messages <span style="font-size:11px;color:var(--mwt-text-dim)">(hides messages starting with <code>(</code>, <code>[OOC]</code>, or <code>OOC:</code>)</span></label><br>
            <label><input type="checkbox" id="sc-auto-snapshot" ${s.autoSnapshot ? 'checked' : ''}> Auto-snapshot</label><br>
            <label><input type="checkbox" id="sc-sync-ws" ${s.syncWorldState !== false ? 'checked' : ''}> Sync World State</label>
        </div>
        <div style="margin-top:8px"><label>Auto-snapshot threshold: <input type="number" id="sc-auto-threshold" class="mwt-input" style="width:80px;display:inline-block" value="${s.autoSnapshotThreshold || 40}" min="5" max="500"></label> <span style="font-size:11px;color:var(--mwt-text-dim)">messages between auto-generations</span></div>
        <div class="mwt-flex mwt-gap-4 mwt-mt-8"><button id="sc-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button><button id="sc-cancel-settings" class="mwt-btn">Cancel</button></div>
    </div>`;
    el.querySelector('#sc-save-settings')?.addEventListener('click', () => {
        const apiValues = readApiSettingsValues(el, apiFieldOpts);
        saveSettings({
            ...apiValues,
            filterSystem: el.querySelector('#sc-filter-system')?.checked ?? true,
            filterOoc: el.querySelector('#sc-filter-ooc')?.checked ?? true,
            autoSnapshot: el.querySelector('#sc-auto-snapshot')?.checked ?? false,
            autoSnapshotThreshold: Number(el.querySelector('#sc-auto-threshold')?.value) || 40,
            syncWorldState: el.querySelector('#sc-sync-ws')?.checked ?? true,
        });
        renderContent();
        scSetStatus('Settings saved.', 'success');
    });
    el.querySelector('#sc-cancel-settings')?.addEventListener('click', () => renderContent());
}

// ─── Main render ─────────────────────────────────────────────────────────────

export function renderContent() {
    const el = getContentEl();
    if (!el) return;
    const snapshots = getSnapshots();
    const hasApi = hasValidSettings();

    if (state.selectedSnapshotId) {
        const snapshot = snapshots.find(s => s.id === state.selectedSnapshotId);
        if (snapshot) { showEntryEditor(snapshot); return; }
        state.selectedSnapshotId = null;
    }

    if (!snapshots.length) {
        el.innerHTML = `<div style="text-align:center;padding:40px"><p>No chronicle entries yet.</p><p>Entries build over time as you generate snapshots.</p>${!hasApi ? '<p style="color:var(--mwt-danger)">⚠ API not configured</p>' : ''}<div class="mwt-flex mwt-gap-4" style="justify-content:center"><button id="sc-settings-btn" class="mwt-btn">⚙ Settings</button><button id="sc-new-entry-btn" class="mwt-btn mwt-btn-primary">+ New Blank Entry</button></div></div>`;
        bindMainEvents();
        return;
    }

    let sorted = [...snapshots].map((s, i) => ({ ...s, originalIndex: i })).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (state.pendingSearch?.trim()) {
        const q = state.pendingSearch.trim().toLowerCase();
        sorted = sorted.filter(s => `${s.worldDate || ''} ${s.text || ''} ${s.note || ''}`.toLowerCase().includes(q));
    }

    const getSnapshotClass = (s) => {
        const classes = ['sc-entry'];
        if (s.id === state.selectedSnapshotId) classes.push('sc-entry--selected');
        if (s.manual) classes.push('sc-entry--manual');
        if (s.consolidated) classes.push('sc-entry--consolidated');
        if (state.consolidateMode && state.checkedForMerge.has(s.id)) classes.push('sc-entry--merge-checked');
        if (state.bulkDeleteMode && state.checkedForMerge.has(s.id)) classes.push('sc-entry--delete-checked');
        if (state.consolidateMode && state.consolidateBaseId === s.id) classes.push('sc-entry--base');
        return classes.join(' ');
    };

    const autoSettings = getSettings();

    const _injStats = getInjectionStats();
    el.innerHTML = `
        <div class="sc-toolbar">
            ${!hasApi ? '<p style="color:var(--mwt-danger)">⚠ API not configured — <button id="sc-open-settings-btn" class="mwt-btn" style="display:inline">Open Settings</button></p>' : ''}
            <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                <button id="sc-generate-btn" class="mwt-btn mwt-btn-primary" ${!hasApi ? 'disabled' : ''}>Generate Entry</button>
                <button id="sc-new-entry-btn" class="mwt-btn">+ Blank Entry</button>
                <button id="sc-consolidate-mode-btn" class="mwt-btn ${state.consolidateMode ? 'mwt-btn-primary' : ''}" ${snapshots.length < 2 ? 'disabled' : ''}>${state.consolidateMode ? '✓ Selecting' : 'Consolidate'}</button>
                <button id="sc-bulk-delete-btn" class="mwt-btn" ${snapshots.length < 1 ? 'disabled' : ''}>${state.bulkDeleteMode ? '✓ Selecting' : 'Bulk Delete'}</button>
                <button id="sc-trash-btn" class="mwt-btn">🗑 Trash (${(getChronicleData()._deletedBin || []).length})</button>
            </div>
            <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap;margin-top:8px">
                <input type="text" id="sc-search-input" class="mwt-input" placeholder="Search entries…" value="${escapeHtml(state.pendingSearch)}" style="flex:1">
                ${autoSettings.autoSnapshot ? `<span style="color:var(--mwt-text-dim)">Msgs until auto: ${Math.max(0, (autoSettings.autoSnapshotThreshold || 40) - state.msgSinceSnapshot)}</span>` : `<span style="color:var(--mwt-text-dim)">Msgs since last: ${(() => { const v = getMessageCountSinceLastSnapshot(); return v ?? '?'; })()}</span>`}
            </div>
            ${autoSettings.autoSnapshot ? `<div style="color:var(--mwt-accent);margin-top:4px">Auto-snapshot: ON (~${autoSettings.autoSnapshotThreshold} msgs)</div>` : ''}
            ${state.consolidateMode ? '<div style="color:var(--mwt-accent)">📦 Select 2+ entries. Optionally pin one as the BASE (foundation) with ★ — otherwise the earliest is used. Then click Consolidate.</div>' : ''}
            ${state.bulkDeleteMode ? '<div style="color:var(--mwt-danger)">⚠ Select entries to delete</div>' : ''}
        </div>
        <div class="sc-entries">${sorted.map((s, i) => {
            const label = s.manual ? '[Manual]' : s.consolidated ? '[Consolidated]' : `#${i + 1}`;
            const isChecked = state.consolidateMode && state.checkedForMerge.has(s.id);
            const isBase = state.consolidateMode && state.consolidateBaseId === s.id;
            const baseBtn = isChecked
                ? `<button class="mwt-btn sc-base-toggle" data-id="${escapeHtml(s.id)}" style="font-size:11px;padding:2px 8px;${isBase ? 'background:var(--mwt-accent);color:#fff' : ''}">${isBase ? '★ BASE' : '☆ Set as Base'}</button>`
                : '';
            return `<div class="${getSnapshotClass(s)}" data-id="${escapeHtml(s.id)}" style="padding:8px;border:1px solid var(--mwt-border);margin:4px 0;cursor:pointer;border-radius:4px">
                <div style="display:flex;justify-content:space-between;align-items:center"><span>${(state.consolidateMode || state.bulkDeleteMode) ? `<input type="checkbox" class="sc-checkbox" data-id="${escapeHtml(s.id)}" ${state.checkedForMerge.has(s.id) ? 'checked' : ''} style="margin-right:8px">` : ''}<strong>${label}</strong></span><span style="color:var(--mwt-text-dim);display:flex;align-items:center;gap:8px">${escapeHtml(s.worldDate || s.createdAt)}${baseBtn}</span></div>
                <div style="color:var(--mwt-text-dim);font-size:12px;margin-top:4px">${escapeHtml((s.text || '').slice(0, 120).replace(/\n/g, ' '))}${s.text?.length > 120 ? '…' : ''}</div>
            </div>`;
        }).join('')}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;flex-wrap:wrap;gap:4px">
            <div class="sc-status"><span class="sc-status"></span></div>
            <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                <button id="sc-inject-toggle" class="mwt-btn" style="font-size:12px">${isInjectionEnabled() ? '📥 Injection ON' : '📤 Injection OFF'}</button>
                <button id="sc-preview-injection" class="mwt-btn" style="font-size:12px">📄 Preview</button>
                <span class="mwt-token-info${_injStats.tokenEstimate > 4000 ? ' mwt-token-info--danger' : _injStats.tokenEstimate > 2000 ? ' mwt-token-info--warn' : ''}" style="font-size:11px">~${_injStats.tokenEstimate} tokens (${_injStats.entriesToInject} entries)</span>
                <button id="sc-inject-settings" class="mwt-btn" style="font-size:12px">⚙</button>
                <button id="sc-stats-btn" class="mwt-btn" style="font-size:12px">📊 Stats</button>
                <button id="sc-export-json" class="mwt-btn" style="font-size:12px">Export JSON</button>
                <button id="sc-export-md" class="mwt-btn" style="font-size:12px">Export MD</button>
                <button id="sc-import-btn" class="mwt-btn" style="font-size:12px">Import</button>
                <button id="sc-settings-btn" class="mwt-btn" style="font-size:12px">⚙ Settings</button>
                <button id="sc-reset-btn" class="mwt-btn" style="font-size:12px;color:var(--mwt-danger)">Clear All</button>
            </div>
        </div>`;

    // Consolidate / Bulk delete action button
    if (state.consolidateMode && state.checkedForMerge.size >= 2) {
        const btn = document.createElement('button');
        btn.className = 'mwt-btn mwt-btn-primary';
        const baseLabel = state.consolidateBaseId && state.checkedForMerge.has(state.consolidateBaseId)
            ? ' (★ base set)'
            : ' (earliest = base)';
        btn.textContent = `Consolidate ${state.checkedForMerge.size} entries${baseLabel}`;
        // Pass the designated base id explicitly so the consolidation logic
        // doesn't have to rely on the state field alone (defensive: state is
        // cleared on success, but this makes the intent unambiguous at the
        // call site).
        const baseId = (state.consolidateBaseId && state.checkedForMerge.has(state.consolidateBaseId)) ? state.consolidateBaseId : null;
        btn.addEventListener('click', () => showConfirm(`Consolidate ${state.checkedForMerge.size} entries?`, 'Originals moved to trash.', () => consolidateEntries([...state.checkedForMerge], baseId)));
        el.querySelector('.sc-entries')?.after(btn);
    }
    if (state.bulkDeleteMode && state.checkedForMerge.size >= 1) {
        const btn = document.createElement('button');
        btn.className = 'mwt-btn';
        btn.style.background = 'var(--mwt-danger)';
        btn.textContent = `Delete ${state.checkedForMerge.size} entries`;
        btn.addEventListener('click', () => showConfirm(`Delete ${state.checkedForMerge.size} entries?`, 'Moved to trash.', () => bulkDeleteEntries([...state.checkedForMerge])));
        el.querySelector('.sc-entries')?.after(btn);
    }

    bindMainEvents();
    if (state._lastStatusMsg) scSetStatus(state._lastStatusMsg, state._lastStatusLevel);
}

function bindMainEvents() {
    const el = getContentEl();
    if (!el) return;

    // Entry clicks
    el.querySelectorAll('.sc-entry').forEach(entry => {
        entry.addEventListener('click', (e) => {
            // Let the checkbox and base-toggle handle their own clicks.
            if (e.target.closest('.sc-checkbox')) return;
            if (e.target.closest('.sc-base-toggle')) return;
            const id = entry.dataset.id;
            if (state.consolidateMode || state.bulkDeleteMode) {
                if (state.checkedForMerge.has(id)) {
                    state.checkedForMerge.delete(id);
                    // Clear base designation if the base entry was unchecked.
                    if (state.consolidateBaseId === id) state.consolidateBaseId = null;
                } else {
                    state.checkedForMerge.add(id);
                }
                renderContent();
            } else {
                state.selectedSnapshotId = id;
                renderContent();
            }
        });
    });

    // Checkboxes
    el.querySelectorAll('.sc-checkbox').forEach(cb => {
        cb.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = cb.dataset.id;
            if (cb.checked) {
                state.checkedForMerge.add(id);
            } else {
                state.checkedForMerge.delete(id);
                // Clear base designation if the base entry was unchecked.
                if (state.consolidateBaseId === id) state.consolidateBaseId = null;
            }
            renderContent();
        });
    });

    // Base-toggle buttons (consolidate mode only)
    el.querySelectorAll('.sc-base-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            // Toggle: clicking the current base clears it; clicking another
            // checked entry makes it the base.
            state.consolidateBaseId = (state.consolidateBaseId === id) ? null : id;
            renderContent();
        });
    });

    // Toolbar buttons
    el.querySelector('#sc-generate-btn')?.addEventListener('click', () => generateSnapshot());
    el.querySelector('#sc-new-entry-btn')?.addEventListener('click', () => createManualEntry());
    el.querySelector('#sc-settings-btn')?.addEventListener('click', () => showSettingsModal());
    el.querySelector('#sc-open-settings-btn')?.addEventListener('click', () => showSettingsModal());
    el.querySelector('#sc-trash-btn')?.addEventListener('click', () => showTrashModal());
    el.querySelector('#sc-stats-btn')?.addEventListener('click', () => showStatsModal());
    el.querySelector('#sc-inject-toggle')?.addEventListener('click', () => {
        const next = !isInjectionEnabled();
        setChronicleData({ injectEnabled: next });
        applyInjection();
        renderContent();
        scSetStatus(`Injection ${next ? 'enabled' : 'disabled'}.`, 'success');
    });
    el.querySelector('#sc-preview-injection')?.addEventListener('click', () => showPreviewInjection());
    el.querySelector('#sc-inject-settings')?.addEventListener('click', () => showInjectionSelector());
    el.querySelector('#sc-export-json')?.addEventListener('click', () => exportChronicle());
    el.querySelector('#sc-export-md')?.addEventListener('click', () => exportMarkdown());
    el.querySelector('#sc-import-btn')?.addEventListener('click', () => triggerImport());
    el.querySelector('#sc-consolidate-mode-btn')?.addEventListener('click', () => {
        state.consolidateMode = !state.consolidateMode;
        if (state.consolidateMode) state.bulkDeleteMode = false;
        state.checkedForMerge.clear();
        state.consolidateBaseId = null;
        renderContent();
    });
    el.querySelector('#sc-bulk-delete-btn')?.addEventListener('click', () => {
        state.bulkDeleteMode = !state.bulkDeleteMode;
        if (state.bulkDeleteMode) state.consolidateMode = false;
        state.checkedForMerge.clear();
        state.consolidateBaseId = null;
        renderContent();
    });
    el.querySelector('#sc-reset-btn')?.addEventListener('click', () => {
        showConfirm('Clear all chronicle data?', 'Everything will be deleted.', () => {
            state.msgSinceSnapshot = 0;
            setChronicleData({ snapshots: [], _deletedBin: [], injectEnabled: false, injectCount: 2, injectDepth: 2, msgSinceSnapshot: 0 });
            applyInjection();
            renderContent();
            scSetStatus('Chronicle cleared.', 'success');
        });
    });

    // Search
    const searchInput = el.querySelector('#sc-search-input');
    let debounce = null;
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.pendingSearch = e.target.value;
            clearTimeout(debounce);
            debounce = setTimeout(() => renderContent(), 200);
        });
    }
}