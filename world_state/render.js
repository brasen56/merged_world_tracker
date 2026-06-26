/**
 * world_state/render.js — UI rendering, event wiring, archive/import/clear,
 * revert/diff, and preview for the World State module.
 *
 * Depends on all other world_state sub-modules.
 */

import {
    escapeHtml, computeLcsDiff, renderDiffHtml, estimateTokens,
    createModal, showModal, hideModal, setStatus,
    downloadJson, pickTextFile,
    renderApiSettingsFields, readApiSettingsValues,
} from '../core/index.js';

import { DEFAULT_AUTO_SAVE_INTERVAL, getSettings, saveSettings } from './settings.js';
import {
    state, SECTIONS, VARIETY_LABELS,
    getWorldStateText, getWorldStateData, setWorldStateData,
    getAutoSaveHistory, pushToHistory,
    isInjectionEnabled, isAutoRefreshEnabled, getAutoRefreshInterval,
    getMaxScanMessages,
} from './data.js';
import {
    applyWorldStateInjection, getHookMode, buildInjectionPreview,
} from './injection.js';
import { refreshWorldState, restartAutoSaveTimer } from './refresh.js';
import { regenerateSection } from './sections.js';

// ─── Editor stat helpers ─────────────────────────────────────────────────────

export function updateEditorStats() {
    if (!state.modal) return;
    const editor = state.modal.querySelector('#ws-editor');
    const stats = state.modal.querySelector('#ws-editor-stats');
    if (!editor || !stats) return;
    const text = editor.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    stats.textContent = `${text.length} chars · ${words} words · ${text.split('\n').length} lines`;
}

export function refreshRevertButton() {
    if (!state.modal) return;
    const btn = state.modal.querySelector('#ws-revert');
    if (btn) btn.disabled = getAutoSaveHistory().length === 0;
}

function updateArchiveButtonState() {
    if (!state.modal) return;
    const btn = state.modal.querySelector('#ws-archive');
    if (btn) btn.disabled = !getWorldStateText()?.trim();
}

export function refreshButtonLabels() {
    if (!state.modal) return;
    const injectBtn = state.modal.querySelector('#ws-toggle-inject');
    const autoBtn = state.modal.querySelector('#ws-toggle-auto');
    if (injectBtn) {
        injectBtn.textContent = isInjectionEnabled() ? '🔌 Injection: ON' : '🔌 Injection: OFF';
    }
    if (autoBtn) {
        if (isAutoRefreshEnabled()) {
            autoBtn.textContent = `🔄 Auto: ${state.autoRefreshCounter}/${getAutoRefreshInterval()}`;
        } else {
            autoBtn.textContent = '🔄 Auto: OFF';
        }
    }
}

export function renderModalContent() {
    if (!state.modal) return;
    const editor = state.modal.querySelector('#ws-editor');
    if (editor) editor.value = getWorldStateText();
    // The editor now reflects the persisted world state, so there are no
    // pending unsaved edits. Reset isDirty to avoid a stale "dirty" flag
    // from a previous editing session (e.g. user typed, closed without
    // saving, then reopened the modal).
    state.isDirty = false;
    updateEditorStats();
    refreshRevertButton();
    updateArchiveButtonState();
    refreshButtonLabels();
}

// ─── Archive / Import / Clear ────────────────────────────────────────────────

function downloadWorldStateArchive() {
    const data = getWorldStateData();
    const archive = {
        _meta: { type: 'world-state-archive', version: '1.0', exportedAt: new Date().toISOString() },
        data,
    };
    downloadJson(`worldstate_${Date.now()}.json`, archive);
}

async function importWorldState() {
    const text = await pickTextFile('.json,.md,.txt');
    if (!text) return;
    try {
        const ext = text.trim().startsWith('{') ? 'json' : 'txt';

        if (ext === 'txt') {
            if (!confirm('Import this file as world state text? It will replace the current one.')) return;
            const oldText = getWorldStateText();
            if (oldText) pushToHistory(oldText);
            setWorldStateData({ text });
            applyWorldStateInjection();
            renderModalContent();
            setStatus(state.modal, 'Imported text.', 'success', 3000);
            return;
        }

        const data = JSON.parse(text);

        if (data._meta?.type === 'world-state-tracker-settings' && data.settings) {
            if (!confirm('Import world state settings? This will overwrite current API/model settings.')) return;
            saveSettings({ ...getSettings(), ...data.settings });
            renderModalContent();
            setStatus(state.modal, 'Settings imported.', 'success', 3000);
            return;
        }

        const wsData = data.data || data;
        if (!confirm('Import this world state? It will replace the current one.')) return;
        const oldText = getWorldStateText();
        if (oldText) pushToHistory(oldText);
        setWorldStateData({ text: wsData.text || '' });
        applyWorldStateInjection();
        renderModalContent();
        setStatus(state.modal, 'Imported.', 'success', 3000);
    } catch (err) {
        setStatus(state.modal, `Import failed: ${err.message}`, 'error');
    }
}

function clearWorldState() {
    if (!confirm('Clear the world state? A snapshot will be saved to history.')) return;
    const oldText = getWorldStateText();
    if (oldText) pushToHistory(oldText);
    setWorldStateData({ text: '' });
    state.isDirty = false;
    applyWorldStateInjection();
    renderModalContent();
}

// ─── Revert / Diff ──────────────────────────────────────────────────────────

function showRevertDiff() {
    const history = getAutoSaveHistory();
    if (history.length === 0) { alert('No history available to revert to.'); return; }

    const latest = history[history.length - 1];
    const currentText = getWorldStateText();
    const diffHtml = renderDiffHtml(computeLcsDiff(currentText, latest.text));

    const diffModal = createModal({
        id: 'mwt-ws-revert-modal',
        title: 'Revert World State',
        content: `
            <p class="mwt-text-dim mwt-text-sm mwt-mb-8">
                Showing diff: <strong>Current</strong> → <strong>Previous snapshot</strong>
                (${new Date(latest.timestamp).toLocaleString()})
            </p>
            ${diffHtml}
            <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                <button id="mwt-ws-revert-confirm" class="mwt-btn mwt-btn-danger">Revert to This</button>
                <button id="mwt-ws-revert-cancel" class="mwt-btn">Cancel</button>
            </div>
        `,
    });

    diffModal.querySelector('#mwt-ws-revert-confirm').addEventListener('click', () => {
        setWorldStateData({ text: latest.text });
        state.autoSaveLastText = latest.text;
        state.isDirty = false;
        applyWorldStateInjection();
        renderModalContent();
        hideModal('mwt-ws-revert-modal');
        setStatus(state.modal, 'Reverted.', 'success', 3000);
    });
    diffModal.querySelector('#mwt-ws-revert-cancel').addEventListener('click', () => {
        hideModal('mwt-ws-revert-modal');
    });
    showModal('mwt-ws-revert-modal');
}

function showAutoSaveHistory() {
    const history = getAutoSaveHistory();
    if (history.length === 0) { alert('No auto-save history yet.'); return; }

    const items = history.slice().reverse().map((h, i) => `
        <div class="mwt-history-item" style="padding:8px;border-bottom:1px solid var(--mwt-border);cursor:pointer" data-idx="${history.length - 1 - i}">
            <span class="mwt-text-dim mwt-text-sm">${new Date(h.timestamp).toLocaleString()}</span>
            <span class="mwt-text-dim mwt-text-sm"> — ${h.text.length} chars</span>
        </div>
    `).join('');

    const histModal = createModal({
        id: 'mwt-ws-history-modal',
        title: 'Auto-Save History',
        content: `<div>${items}</div>`,
    });

    histModal.querySelectorAll('.mwt-history-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx);
            const entry = history[idx];
            const currentText = getWorldStateText();
            const diffHtml = renderDiffHtml(computeLcsDiff(currentText, entry.text));
            const diffModal2 = createModal({
                id: 'mwt-ws-hist-diff-modal',
                title: `History: ${new Date(entry.timestamp).toLocaleString()}`,
                content: `
                    ${diffHtml}
                    <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                        <button id="mwt-ws-restore-hist" class="mwt-btn mwt-btn-primary">Restore This</button>
                        <button id="mwt-ws-close-hist" class="mwt-btn">Close</button>
                    </div>
                `,
            });
            diffModal2.querySelector('#mwt-ws-restore-hist').addEventListener('click', () => {
                const old = getWorldStateText();
                if (old) pushToHistory(old);
                setWorldStateData({ text: entry.text });
                state.autoSaveLastText = entry.text;
                state.isDirty = false;
                applyWorldStateInjection();
                renderModalContent();
                hideModal('mwt-ws-hist-diff-modal');
                hideModal('mwt-ws-history-modal');
                setStatus(state.modal, 'Restored from history.', 'success', 3000);
            });
            diffModal2.querySelector('#mwt-ws-close-hist').addEventListener('click', () => {
                hideModal('mwt-ws-hist-diff-modal');
            });
            showModal('mwt-ws-hist-diff-modal');
        });
    });
    showModal('mwt-ws-history-modal');
}

// ─── Main render ─────────────────────────────────────────────────────────────

export function render() {
    const s = getSettings();
    const text = getWorldStateText();
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const tokens = estimateTokens(text);
    const autoEnabled = isAutoRefreshEnabled();
    const autoInterval = getAutoRefreshInterval();
    const maxScan = getMaxScanMessages(s);

    const sectionOptions = SECTIONS.map(sec =>
        `<option value="${escapeHtml(sec)}">${escapeHtml(sec)}</option>`
    ).join('');

    return `
        <div class="ws-toolbar mwt-flex mwt-gap-4 mwt-mb-8" style="flex-wrap:wrap">
            <button id="ws-refresh" class="mwt-btn mwt-btn-primary">🔄 Refresh</button>
            <button id="ws-save" class="mwt-btn">💾 Save</button>
            <button id="ws-revert" class="mwt-btn" ${getAutoSaveHistory().length === 0 ? 'disabled' : ''}>⏪ Revert</button>
            <button id="ws-history" class="mwt-btn">📋 History</button>
            <button id="ws-archive" class="mwt-btn" ${!text?.trim() ? 'disabled' : ''}>📦 Export</button>
            <button id="ws-import" class="mwt-btn">📥 Import</button>
            <button id="ws-clear" class="mwt-btn mwt-btn-danger">🗑️ Clear</button>
            <span class="mwt-text-dim mwt-text-sm" style="margin-left:auto;line-height:28px">${words} words · ~${tokens} tokens${autoEnabled ? ` · Auto: ${state.autoRefreshCounter}/${autoInterval} msgs` : ''}</span>
        </div>

        <div class="mwt-form-row">
            <textarea id="ws-editor" class="mwt-textarea" style="min-height:300px">${escapeHtml(text)}</textarea>
            <div id="ws-editor-stats" class="mwt-text-dim mwt-text-sm mwt-mt-8">${text.length} chars · ${words} words · ~${tokens} tokens</div>
        </div>

        ${autoEnabled ? `<div style="color:var(--mwt-accent);font-size:12px;margin-bottom:4px">🔄 Auto-refresh: ON — refreshes every ${autoInterval} messages (${state.autoRefreshCounter}/${autoInterval} since last)</div>` : ''}

        <details class="mwt-mt-8" open>
            <summary style="cursor:pointer;color:var(--mwt-accent);font-weight:500">🎯 Regenerate Section</summary>
            <div style="padding:8px 0">
                <div class="mwt-flex mwt-gap-4" style="align-items:center;flex-wrap:wrap">
                    <select id="ws-section-select" class="mwt-input" style="max-width:200px">
                        ${sectionOptions}
                    </select>
                    <div class="mwt-flex mwt-gap-4" style="align-items:center">
                        <label class="mwt-label" style="margin:0;white-space:nowrap">Variety:</label>
                        <input id="ws-variety-slider" type="range" min="1" max="5" value="2" style="width:120px">
                        <span id="ws-variety-label" style="font-size:11px;color:#c4b5fd;min-width:80px">${VARIETY_LABELS[2]}</span>
                    </div>
                    <button id="ws-regen-section" class="mwt-btn" style="background:#6d28d9;border-color:#7c3aed;color:#fff">🎲 Regenerate Section</button>
                </div>
                <p style="font-size:11px;color:var(--mwt-text-dim);margin:6px 0 0">Regenerate a single section with adjustable variety. Higher variety = bolder, more unexpected results.</p>
            </div>
        </details>

        <details class="mwt-mt-8">
            <summary style="cursor:pointer;color:var(--mwt-accent);font-weight:500">⚙️ World State Settings</summary>
            <div class="mwt-settings-grid mwt-mt-8">
                ${renderApiSettingsFields(s, { urlId: 'ws-api-url', keyId: 'ws-api-key', modelId: 'ws-model', maxTokensId: 'ws-max-tokens', tempId: 'ws-temp', includeAdvanced: false, includeHeaders: false })}

                <label class="mwt-label">Injection Depth</label>
                <input id="ws-injection-depth" class="mwt-input" type="number" value="${s.injectionDepth ?? 1}" min="0" max="999">

                <label class="mwt-label">Scan Messages</label>
                <div>
                    <input id="ws-max-scan-messages" class="mwt-input" type="number" value="${maxScan}" min="1" max="30" style="max-width:100px">
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">How many previous messages to scan (max 30). Auto-snapshot interval cannot exceed this.</p>
                </div>

                <label class="mwt-label">Auto-Save (sec)</label>
                <input id="ws-auto-save-interval" class="mwt-input" type="number" value="${s.autoSaveInterval || DEFAULT_AUTO_SAVE_INTERVAL}" min="30">

                <label class="mwt-label">Custom Prompt</label>
                <textarea id="ws-custom-prompt" class="mwt-input" rows="3" placeholder="Leave blank for default prompt">${escapeHtml(s.customPrompt || '')}</textarea>
                <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Custom Prompt: Overrides the system prompt sent to the AI. Must start with instructions to output "## Current Scene". Leave blank to use the built-in default prompt. Click "Reset Prompt" to clear.</p>

                <label class="mwt-label">Hook Mode</label>
                <div>
                    <select id="ws-hook-mode" class="mwt-input" style="max-width:180px">
                        <option value="off" ${s.hookMode === 'off' ? 'selected' : ''}>Off</option>
                        <option value="passive" ${(s.hookMode || 'passive') === 'passive' ? 'selected' : ''}>Passive</option>
                        <option value="proactive" ${s.hookMode === 'proactive' ? 'selected' : ''}>Proactive</option>
                        <option value="assertive" ${s.hookMode === 'assertive' ? 'selected' : ''}>Assertive</option>
                    </select>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0"><b>Off:</b> Plot Seeds are not injected into the prompt. <b>Passive:</b> Model is encouraged to use a hook if the scene allows. <b>Proactive:</b> Model should introduce a hook unless the scene is at a climax — player pre-approval is stated. <b>Assertive:</b> Model must introduce at least one hook — the world moves without player permission.</p>
                </div>

                <label class="mwt-label">Message Filter</label>
                <div>
                    <textarea id="ws-message-filter" class="mwt-input" rows="3" placeholder="One regex per line. Matching text is stripped from messages before scanning.&#10;Example: \\[NPC thoughts][\\s\\S]*?\\[/NPC thoughts]">${escapeHtml(s.messageFilter || '')}</textarea>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Each line is a separate regex pattern (case-insensitive). Matching content is removed from chat messages <i>before</i> the World State scanner sees them. Use this to strip out NPC thought blocks, OOC notes, or other content that shouldn't influence the world state.</p>
                </div>

                <div></div>
                <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                    <button id="ws-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button>
                    <button id="ws-test-connection" class="mwt-btn">Test Connection</button>
                    <button id="ws-toggle-inject" class="mwt-btn">${isInjectionEnabled() ? '🔌 Injection: ON' : '🔌 Injection: OFF'}</button>
                    <button id="ws-toggle-auto" class="mwt-btn">${isAutoRefreshEnabled() ? `🔄 Auto: ON (${getAutoRefreshInterval()})` : '🔄 Auto: OFF'}</button>
                    <button id="ws-reset-prompt" class="mwt-btn">Reset Prompt</button>
                    <button id="ws-preview-injection" class="mwt-btn">📄 Preview Injection</button>
                </div>
            </div>
        </details>
    `;
}

// ─── Event wiring ────────────────────────────────────────────────────────────

export function wireEvents() {
    if (!state.modal) return;

    // Save
    state.modal.querySelector('#ws-save')?.addEventListener('click', () => {
        const newText = state.modal.querySelector('#ws-editor')?.value || '';
        const currentText = getWorldStateText();
        if (newText !== currentText) {
            pushToHistory(currentText);
            state.autoSaveLastText = newText;
        }
        state.isDirty = false;
        setWorldStateData({ text: newText });
        applyWorldStateInjection();
        refreshRevertButton();
        updateArchiveButtonState();
        updateEditorStats();
        setStatus(state.modal, 'Saved.', 'success', 3000);
    });

    // Refresh
    state.modal.querySelector('#ws-refresh')?.addEventListener('click', async () => {
        const btn = state.modal.querySelector('#ws-refresh');
        try {
            const editorEl = state.modal.querySelector('#ws-editor');
            if (editorEl && editorEl.value && editorEl.value !== getWorldStateText()) {
                setWorldStateData({ text: editorEl.value });
            }
            btn.disabled = true; btn.textContent = '⏳ Refreshing…';
            setStatus(state.modal, 'Generating world state…', 'info');
            const text = await refreshWorldState();
            if (text === null) { setStatus(state.modal, 'Refresh aborted.', 'info'); return; }
            const editor = state.modal.querySelector('#ws-editor');
            if (editor) editor.value = text;
            state.autoSaveLastText = text; state.isDirty = false;
            updateArchiveButtonState();
            updateEditorStats();
            refreshRevertButton();
            setStatus(state.modal, 'Refresh complete.', 'success', 3000);
        } catch (err) {
            setStatus(state.modal, `Error: ${err.message}`, 'error');
        } finally {
            btn.disabled = false; btn.textContent = '🔄 Refresh';
        }
    });

    // Revert
    state.modal.querySelector('#ws-revert')?.addEventListener('click', () => showRevertDiff());

    // History
    state.modal.querySelector('#ws-history')?.addEventListener('click', () => showAutoSaveHistory());

    // Archive
    state.modal.querySelector('#ws-archive')?.addEventListener('click', () => downloadWorldStateArchive());

    // Import
    state.modal.querySelector('#ws-import')?.addEventListener('click', () => importWorldState());

    // Clear
    state.modal.querySelector('#ws-clear')?.addEventListener('click', () => clearWorldState());

    // Editor input
    state.modal.querySelector('#ws-editor')?.addEventListener('input', () => {
        state.isDirty = true;
        updateArchiveButtonState();
        updateEditorStats();
    });

    // Variety slider
    state.modal.querySelector('#ws-variety-slider')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        const label = state.modal.querySelector('#ws-variety-label');
        if (label) label.textContent = VARIETY_LABELS[val] || `Level ${val}`;
    });

    // Regenerate section
    state.modal.querySelector('#ws-regen-section')?.addEventListener('click', async () => {
        const sectionSelect = state.modal.querySelector('#ws-section-select');
        const varietySlider = state.modal.querySelector('#ws-variety-slider');
        const regenBtn = state.modal.querySelector('#ws-regen-section');
        const sectionName = sectionSelect?.value;
        const variety = parseInt(varietySlider?.value || '2', 10);

        if (!sectionName) { setStatus(state.modal, 'Select a section first.', 'error'); return; }

        try {
            regenBtn.disabled = true; regenBtn.textContent = '⏳ Regenerating…';
            setStatus(state.modal, `Regenerating "${sectionName}" (variety: ${VARIETY_LABELS[variety]})…`, 'info');

            // Preserve unsaved editor edits. regenerateSection() rebuilds the
            // entry from the *persisted* world state (getWorldStateText()),
            // not the live textarea, so typing that hasn't been Saved would be
            // silently dropped. Sync the editor into state first — and push the
            // live text into history so it stays recoverable. Mirrors #ws-refresh.
            const editorBefore = state.modal.querySelector('#ws-editor');
            if (editorBefore && editorBefore.value && editorBefore.value !== getWorldStateText()) {
                pushToHistory(getWorldStateText());
                state.autoSaveLastText = editorBefore.value;
                setWorldStateData({ text: editorBefore.value });
            }

            const updated = await regenerateSection(sectionName, variety);
            if (updated) {
                const editor = state.modal.querySelector('#ws-editor');
                if (editor) editor.value = updated;
                state.autoSaveLastText = updated;
                state.isDirty = false;
                updateEditorStats();
                updateArchiveButtonState();
                refreshRevertButton();
                setStatus(state.modal, `Section "${sectionName}" regenerated (${VARIETY_LABELS[variety]}).`, 'success', 3000);
            }
        } catch (err) {
            setStatus(state.modal, `Section regen failed: ${err.message}`, 'error');
        } finally {
            regenBtn.disabled = false; regenBtn.textContent = '🎲 Regenerate Section';
        }
    });

    const wsApiFieldOpts = { urlId: 'ws-api-url', keyId: 'ws-api-key', modelId: 'ws-model', maxTokensId: 'ws-max-tokens', tempId: 'ws-temp', includeAdvanced: false, includeHeaders: false };

    // Save settings
    state.modal.querySelector('#ws-save-settings')?.addEventListener('click', () => {
        const apiValues = readApiSettingsValues(state.modal, wsApiFieldOpts);
        const autoSaveSec = parseInt(state.modal.querySelector('#ws-auto-save-interval')?.value, 10) || DEFAULT_AUTO_SAVE_INTERVAL;
        const customPrompt = state.modal.querySelector('#ws-custom-prompt')?.value.trim() || '';
        const depth = parseInt(state.modal.querySelector('#ws-injection-depth')?.value, 10);
        const maxScan = parseInt(state.modal.querySelector('#ws-max-scan-messages')?.value, 10);
        const hookMode = state.modal.querySelector('#ws-hook-mode')?.value || 'passive';
        const messageFilter = state.modal.querySelector('#ws-message-filter')?.value || '';

        if (!apiValues.apiUrl || !apiValues.modelName) {
            setStatus(state.modal, 'API URL and Model are required.', 'error');
            return;
        }

        saveSettings({
            ...apiValues,
            autoSaveInterval: Math.max(30, autoSaveSec),
            customPrompt,
            injectionDepth: isNaN(depth) ? 1 : depth,
            maxScanMessages: Math.min(Math.max(1, isNaN(maxScan) ? 20 : maxScan), 30),
            hookMode,
            messageFilter,
        });
        applyWorldStateInjection();
        restartAutoSaveTimer();
        setStatus(state.modal, 'Settings saved.', 'success', 3000);
    });

    // Test connection
    state.modal.querySelector('#ws-test-connection')?.addEventListener('click', async () => {
        const btn = state.modal.querySelector('#ws-test-connection');
        const url = state.modal.querySelector('#ws-api-url')?.value.trim();
        const key = state.modal.querySelector('#ws-api-key')?.value.trim();
        const model = state.modal.querySelector('#ws-model')?.value.trim();
        if (!url || !model) { setStatus(state.modal, 'Fill URL and Model first.', 'error'); return; }

        try {
            btn.disabled = true; btn.textContent = 'Testing…';
            setStatus(state.modal, 'Testing connection…', 'info');
            const headers = { 'Content-Type': 'application/json' };
            if (key) headers['Authorization'] = `Bearer ${key}`;
            const resp = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with: OK' }], max_tokens: 10, temperature: 0 }),
            });
            if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
            const data = await resp.json();
            setStatus(state.modal, `OK — model replied: "${data?.choices?.[0]?.message?.content?.trim()}"`, 'success', 5000);
        } catch (err) {
            setStatus(state.modal, `Failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false; btn.textContent = 'Test Connection';
        }
    });

    // Toggle injection
    state.modal.querySelector('#ws-toggle-inject')?.addEventListener('click', () => {
        const next = !isInjectionEnabled();
        setWorldStateData({ injectEnabled: next });
        applyWorldStateInjection();
        refreshButtonLabels();
        setStatus(state.modal, `Injection ${next ? 'enabled' : 'disabled'}.`, 'info', 3000);
    });

    // Toggle auto-refresh
    state.modal.querySelector('#ws-toggle-auto')?.addEventListener('click', () => {
        if (!isAutoRefreshEnabled()) {
            const raw = prompt(`Auto-refresh every N messages:`, String(getAutoRefreshInterval()));
            if (!raw) return;
            const n = parseInt(raw, 10);
            if (isNaN(n) || n < 1) { setStatus(state.modal, 'Invalid interval.', 'error'); return; }
            let maxScan = getMaxScanMessages(getSettings());
            let interval = n;
            if (n > maxScan) {
                if (n > 30) {
                    // 30 is the hard cap for maxScanMessages; clamp and explain.
                    interval = 30;
                    maxScan = 30;
                    setStatus(state.modal, `Auto-refresh interval set to 30 (maximum scan messages).`, 'warning', 5000);
                } else if (confirm(`The auto-refresh interval (${n}) exceeds the current "Scan Messages" limit (${maxScan}).\n\nIncrease "Scan Messages" to ${n} to allow the full interval?`)) {
                    // Raise maxScanMessages to match the desired interval so the
                    // scanner can actually see enough messages to refresh on.
                    maxScan = n;
                    saveSettings({ ...getSettings(), maxScanMessages: n });
                    const maxScanInput = state.modal.querySelector('#ws-max-scan-messages');
                    if (maxScanInput) maxScanInput.value = String(n);
                } else {
                    // User declined to raise the limit — clamp the interval.
                    interval = maxScan;
                    setStatus(state.modal, `Auto-refresh interval clamped to ${maxScan} (max scan messages).`, 'warning', 5000);
                }
            }
            setWorldStateData({ autoRefresh: true, autoRefreshInterval: interval });
            state.autoRefreshCounter = 0;
            if (n <= maxScan) setStatus(state.modal, `Auto-refresh: every ${interval} messages.`, 'success', 3000);
        } else {
            setWorldStateData({ autoRefresh: false });
            setStatus(state.modal, 'Auto-refresh disabled.', 'info', 3000);
        }
        refreshButtonLabels();
    });

    // Reset prompt
    state.modal.querySelector('#ws-reset-prompt')?.addEventListener('click', () => {
        const ta = state.modal.querySelector('#ws-custom-prompt');
        if (ta) ta.value = '';
        setStatus(state.modal, 'Custom prompt cleared.', 'info', 3000);
    });

    // Preview injection
    state.modal.querySelector('#ws-preview-injection')?.addEventListener('click', () => {
        const text = getWorldStateText();
        if (!text?.trim()) {
            setStatus(state.modal, 'No world state text to preview.', 'warning');
            return;
        }

        const injected = buildInjectionPreview(text);
        const tokens = estimateTokens(injected);

        const previewModal = createModal({
            id: 'mwt-ws-injection-preview',
            title: 'Injection Preview',
            content: `
                <p class="mwt-text-dim mwt-text-sm mwt-mb-8">
                    This is exactly what gets injected into the prompt (${injected.length} chars, ~${tokens} tokens).
                    Hook mode: <strong>${getHookMode()}</strong>.
                </p>
                <pre style="white-space:pre-wrap;font-family:var(--mwt-font-mono);font-size:12px;line-height:1.5;background:var(--mwt-bg-light);padding:12px;border-radius:var(--mwt-radius);border:1px solid var(--mwt-border);max-height:60vh;overflow-y:auto">${escapeHtml(injected)}</pre>
                <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                    <button id="mwt-ws-preview-copy" class="mwt-btn mwt-btn-primary">📋 Copy to Clipboard</button>
                    <button id="mwt-ws-preview-close" class="mwt-btn">Close</button>
                </div>
            `,
        });

        previewModal.querySelector('#mwt-ws-preview-copy')?.addEventListener('click', () => {
            navigator.clipboard.writeText(injected).then(() => {
                setStatus(previewModal, 'Copied to clipboard.', 'success', 2000);
            }).catch(() => {
                setStatus(previewModal, 'Failed to copy.', 'error');
            });
        });

        previewModal.querySelector('#mwt-ws-preview-close')?.addEventListener('click', () => {
            hideModal('mwt-ws-injection-preview');
        });

        showModal('mwt-ws-injection-preview');
    });
}