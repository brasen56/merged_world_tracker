/**
 * story_planner/render.js — UI rendering and event wiring.
 *
 * Depends on all leaf modules + generation.js + injection.js.
 */

import {
    escapeHtml, estimateTokens, notify,
    renderApiSettingsFields, readApiSettingsValues,
    createModal, showModal, hideModal,
    computeLcsDiff, renderDiffHtml,
} from '../core/index.js';

import { getSettings, saveSettings } from './settings.js';
import {
    state, getPlanData, setPlanData, getPlanText,
    getPlanHistory, pushPlanToHistory,
    isInjectionEnabled, isAutoEnabled, getAutoInterval,
} from './data.js';
import { applyPlanInjection } from './injection.js';
import { generatePlan } from './generation.js';

// ─── API field IDs ───────────────────────────────────────────────────────────
// One shared map for BOTH renderApiSettingsFields and readApiSettingsValues so
// every field round-trips (the two must use identical ids).
const SP_API_FIELD_IDS = {
    urlId: 'sp-api-url', keyId: 'sp-api-key', modelId: 'sp-model',
    maxTokensId: 'sp-max-tokens', tempId: 'sp-temp',
    topPId: 'sp-top-p', freqId: 'sp-freq-pen', presId: 'sp-pres-pen', headersId: 'sp-headers',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getContentEl() {
    if (state.contentEl) return state.contentEl;
    if (!state.modal) return null;
    state.contentEl = state.modal.querySelector('.mwt-tab-content[data-tab="story-planner"]');
    return state.contentEl;
}

// ─── Lightweight display updaters ────────────────────────────────────────────
// These update specific text/labels in-place WITHOUT replacing the DOM (which
// would destroy event listeners and collapse <details> elements). Use these
// instead of renderContent() after any user interaction.

/** Update the char/word/token stat line beneath the editor. */
function updateEditorStats() {
    if (!state.modal) return;
    const editor = state.modal.querySelector('#sp-editor');
    const stats = state.modal.querySelector('#sp-editor-stats');
    if (!editor || !stats) return;
    const text = editor.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const tokens = estimateTokens(text);
    stats.textContent = `${text.length} chars · ${words} words · ~${tokens} tokens`;
}

/** Update the word/token/auto-counter summary in the toolbar. */
function updateToolbarStats() {
    if (!state.modal) return;
    const editor = state.modal.querySelector('#sp-editor');
    const text = editor ? editor.value : getPlanText();
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const tokens = estimateTokens(text);
    const autoEnabled = isAutoEnabled();
    const autoInterval = getAutoInterval();
    const el = state.modal.querySelector('#sp-toolbar-stats');
    if (el) {
        el.textContent = `${words} words · ~${tokens} tokens${autoEnabled ? ` · Auto: ${state.autoCounter}/${autoInterval} msgs` : ''}`;
    }
}

/** Update the auto-generate status banner (shown only when auto is ON). */
function updateAutoBanner() {
    if (!state.modal) return;
    const el = state.modal.querySelector('#sp-auto-banner');
    if (!el) return;
    const autoEnabled = isAutoEnabled();
    const autoInterval = getAutoInterval();
    if (autoEnabled) {
        el.style.display = '';
        el.textContent = `🔄 Auto-generate: ON — generates a new plan every ${autoInterval} messages (${state.autoCounter}/${autoInterval} since last)`;
    } else {
        el.style.display = 'none';
    }
}

/** Update toggle button labels to reflect current persisted state. */
function refreshButtonLabels() {
    if (!state.modal) return;
    const injectBtn = state.modal.querySelector('#sp-toggle-inject');
    const autoBtn = state.modal.querySelector('#sp-toggle-auto');
    if (injectBtn) {
        injectBtn.textContent = isInjectionEnabled() ? '🔌 Injection: ON' : '🔌 Injection: OFF';
    }
    if (autoBtn) {
        const autoInterval = getAutoInterval();
        autoBtn.textContent = isAutoEnabled() ? `🔄 Auto: ON (${autoInterval})` : '🔄 Auto: OFF';
    }
}

/** Enable/disable the Revert button based on whether history exists. */
function refreshRevertButton() {
    if (!state.modal) return;
    const btn = state.modal.querySelector('#sp-revert');
    if (btn) btn.disabled = getPlanHistory().length === 0;
}

/**
 * Refresh all dynamic display elements in-place (no DOM replacement).
 * Called after save/clear/generate/toggle to keep stats and labels current
 * without destroying event listeners or collapsing <details> sections.
 */
export function refreshDisplay() {
    updateEditorStats();
    updateToolbarStats();
    updateAutoBanner();
    refreshButtonLabels();
    refreshRevertButton();
}

// ─── Render ──────────────────────────────────────────────────────────────────

export function render() {
    const s = getSettings();
    const data = getPlanData();
    const text = getPlanText();
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const tokens = estimateTokens(text);
    const autoEnabled = isAutoEnabled();
    const autoInterval = getAutoInterval();

    return `
        <div class="ws-toolbar mwt-flex mwt-gap-4 mwt-mb-8" style="flex-wrap:wrap">
            <button id="sp-generate" class="mwt-btn mwt-btn-primary">🎲 Generate Plan</button>
            <button id="sp-save" class="mwt-btn">💾 Save Plan</button>
            <button id="sp-revert" class="mwt-btn" ${getPlanHistory().length === 0 ? 'disabled' : ''}>⏪ Revert</button>
            <button id="sp-history" class="mwt-btn">📋 History</button>
            <button id="sp-clear" class="mwt-btn mwt-btn-danger">🗑️ Clear</button>
            <span id="sp-toolbar-stats" class="mwt-text-dim mwt-text-sm" style="margin-left:auto;line-height:28px">${words} words · ~${tokens} tokens${autoEnabled ? ` · Auto: ${state.autoCounter}/${autoInterval} msgs` : ''}</span>
        </div>

        <div class="mwt-form-row">
            <textarea id="sp-editor" class="mwt-textarea" style="min-height:300px" placeholder="Generated plot ideas will appear here. You can edit freely — your edits are injected as-is.">${escapeHtml(text)}</textarea>
            <div id="sp-editor-stats" class="mwt-text-dim mwt-text-sm mwt-mt-8">${text.length} chars · ${words} words · ~${tokens} tokens</div>
        </div>

        <div id="sp-auto-banner" style="color:var(--mwt-accent);font-size:12px;margin-bottom:4px;${autoEnabled ? '' : 'display:none'}">${autoEnabled ? `🔄 Auto-generate: ON — generates a new plan every ${autoInterval} messages (${state.autoCounter}/${autoInterval} since last)` : ''}</div>

        <details class="mwt-mt-8">
            <summary style="cursor:pointer;color:var(--mwt-accent);font-weight:500">⚙️ Story Planner Settings</summary>
            <div class="mwt-settings-grid mwt-mt-8">
                ${renderApiSettingsFields(s, { ...SP_API_FIELD_IDS, includeAdvanced: true, includeHeaders: true })}

                <label class="mwt-label">Injection Depth</label>
                <input id="sp-injection-depth" class="mwt-input" type="number" value="${s.injectionDepth ?? 4}" min="0" max="999">

                <label class="mwt-label">Custom System Prompt</label>
                <textarea id="sp-custom-system-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customSystemPrompt || '')}</textarea>
                <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Overrides the system prompt sent to the AI when generating a plan. Leave blank to use the built-in default.</p>

                <label class="mwt-label">Custom User Prompt</label>
                <div>
                    <textarea id="sp-custom-user-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customUserPrompt || '')}</textarea>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Overrides the user task prompt. Supports tokens: <code>{{chatHistory}}</code>, <code>{{worldState}}</code>, <code>{{lastChronicle}}</code>, <code>{{previousPlan}}</code>. Each resolves to empty if that data isn't available. Leave blank for default.</p>
                </div>

                <label class="mwt-label">Auto-Generate Interval</label>
                <div>
                    <input id="sp-auto-interval" class="mwt-input" type="number" value="${autoInterval}" min="1" max="100" style="max-width:100px">
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">When auto-generate is ON, a new plan is generated every N messages (counted on AI replies).</p>
                </div>

                <div></div>
                <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                    <button id="sp-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button>
                    <button id="sp-toggle-inject" class="mwt-btn">${isInjectionEnabled() ? '🔌 Injection: ON' : '🔌 Injection: OFF'}</button>
                    <button id="sp-toggle-auto" class="mwt-btn">${autoEnabled ? `🔄 Auto: ON (${autoInterval})` : '🔄 Auto: OFF'}</button>
                </div>
            </div>
        </details>

        <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:12px">
            The Story Planner generates a menu of future plot possibilities (arcs, chapters, episodes) from your story so far.
            The plan is injected into the prompt as inspiration for the AI. Toggle injection off to stop sending it without
            deleting the plan. <strong>Auto-generate</strong> refreshes the plan on a timer; <strong>injection</strong> controls whether it reaches the AI.
        </p>
    `;
}

// ─── Re-render helper ────────────────────────────────────────────────────────

export function renderContent() {
    const el = getContentEl();
    if (!el) return;
    el.innerHTML = render();
}

// ─── History / Revert ────────────────────────────────────────────────────────

/** Apply a snapshot as the current plan, syncing editor + injection. */
function restorePlan(text, { pushCurrent = true } = {}) {
    const current = getPlanText();
    if (pushCurrent && current.trim() && current !== text) pushPlanToHistory(current);
    setPlanData({ text });
    applyPlanInjection();
    const editor = state.modal?.querySelector('#sp-editor');
    if (editor) editor.value = text;
    refreshDisplay();
}

/** Diff the current plan against the most recent snapshot, with a Revert button. */
function showRevertDiff() {
    const history = getPlanHistory();
    if (history.length === 0) { alert('No history available to revert to.'); return; }

    const latest = history[history.length - 1];
    const diffHtml = renderDiffHtml(computeLcsDiff(getPlanText(), latest.text));

    const diffModal = createModal({
        id: 'mwt-sp-revert-modal',
        title: 'Revert Story Plan',
        content: `
            <p class="mwt-text-dim mwt-text-sm mwt-mb-8">
                Showing diff: <strong>Current</strong> → <strong>Previous snapshot</strong>
                (${new Date(latest.timestamp).toLocaleString()})
            </p>
            ${diffHtml}
            <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                <button id="mwt-sp-revert-confirm" class="mwt-btn mwt-btn-danger">Revert to This</button>
                <button id="mwt-sp-revert-cancel" class="mwt-btn">Cancel</button>
            </div>
        `,
    });

    diffModal.querySelector('#mwt-sp-revert-confirm')?.addEventListener('click', () => {
        restorePlan(latest.text);
        hideModal('mwt-sp-revert-modal');
        notify('Story Planner', 'Reverted to previous snapshot.', 'success');
    });
    diffModal.querySelector('#mwt-sp-revert-cancel')?.addEventListener('click', () => {
        hideModal('mwt-sp-revert-modal');
    });
    showModal('mwt-sp-revert-modal');
}

/** List all snapshots; clicking one shows a diff with a Restore button. */
function showPlanHistory() {
    const history = getPlanHistory();
    if (history.length === 0) { alert('No plan history yet.'); return; }

    const items = history.slice().reverse().map((h, i) => `
        <div class="mwt-history-item" style="padding:8px;border-bottom:1px solid var(--mwt-border);cursor:pointer" data-idx="${history.length - 1 - i}">
            <span class="mwt-text-dim mwt-text-sm">${new Date(h.timestamp).toLocaleString()}</span>
            <span class="mwt-text-dim mwt-text-sm"> — ${h.text.length} chars</span>
        </div>
    `).join('');

    const histModal = createModal({
        id: 'mwt-sp-history-modal',
        title: 'Story Plan History',
        content: `<div>${items}</div>`,
    });

    histModal.querySelectorAll('.mwt-history-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            const entry = history[idx];
            const diffHtml = renderDiffHtml(computeLcsDiff(getPlanText(), entry.text));
            const diffModal2 = createModal({
                id: 'mwt-sp-hist-diff-modal',
                title: `History: ${new Date(entry.timestamp).toLocaleString()}`,
                content: `
                    ${diffHtml}
                    <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                        <button id="mwt-sp-restore-hist" class="mwt-btn mwt-btn-primary">Restore This</button>
                        <button id="mwt-sp-close-hist" class="mwt-btn">Close</button>
                    </div>
                `,
            });
            diffModal2.querySelector('#mwt-sp-restore-hist')?.addEventListener('click', () => {
                restorePlan(entry.text);
                hideModal('mwt-sp-hist-diff-modal');
                hideModal('mwt-sp-history-modal');
                notify('Story Planner', 'Restored from history.', 'success');
            });
            diffModal2.querySelector('#mwt-sp-close-hist')?.addEventListener('click', () => {
                hideModal('mwt-sp-hist-diff-modal');
            });
            showModal('mwt-sp-hist-diff-modal');
        });
    });
    showModal('mwt-sp-history-modal');
}

// ─── Event wiring ────────────────────────────────────────────────────────────

export function wireEvents() {
    if (!state.modal) return;

    // Generate
    state.modal.querySelector('#sp-generate')?.addEventListener('click', async () => {
        const btn = state.modal.querySelector('#sp-generate');
        try {
            btn.disabled = true; btn.textContent = '⏳ Generating…';
            const text = await generatePlan(false);
            if (text) {
                const editor = state.modal.querySelector('#sp-editor');
                if (editor) editor.value = text;
                refreshDisplay();
                notify('Story Planner', 'Plan generated.', 'success');
            }
        } catch (err) {
            notify('Story Planner', `Generation failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false; btn.textContent = '🎲 Generate Plan';
        }
    });

    // Save (persist textarea edits)
    state.modal.querySelector('#sp-save')?.addEventListener('click', () => {
        const newText = state.modal.querySelector('#sp-editor')?.value || '';
        const current = getPlanText();
        if (newText !== current) {
            if (current.trim()) pushPlanToHistory(current);
            setPlanData({ text: newText });
            applyPlanInjection();
        }
        refreshDisplay();
        notify('Story Planner', 'Plan saved.', 'success');
    });

    // Clear
    state.modal.querySelector('#sp-clear')?.addEventListener('click', () => {
        if (!confirm('Clear the story plan? A snapshot will be saved to history.')) return;
        const current = getPlanText();
        if (current.trim()) pushPlanToHistory(current);
        setPlanData({ text: '' });
        applyPlanInjection();
        const editor = state.modal.querySelector('#sp-editor');
        if (editor) editor.value = '';
        refreshDisplay();
    });

    // Auto-save textarea on blur (saves silently without re-rendering)
    state.modal.querySelector('#sp-editor')?.addEventListener('blur', () => {
        const newText = state.modal.querySelector('#sp-editor')?.value || '';
        const current = getPlanText();
        if (newText !== current) {
            if (current.trim()) pushPlanToHistory(current);
            setPlanData({ text: newText });
            applyPlanInjection();
            refreshDisplay();
        }
    });

    // Revert (diff current → latest snapshot, confirm to restore)
    state.modal.querySelector('#sp-revert')?.addEventListener('click', () => showRevertDiff());

    // History (browse and restore any snapshot)
    state.modal.querySelector('#sp-history')?.addEventListener('click', () => showPlanHistory());

    // Save settings
    state.modal.querySelector('#sp-save-settings')?.addEventListener('click', () => {
        const apiValues = readApiSettingsValues(state.modal, SP_API_FIELD_IDS);
        const depthRaw = state.modal.querySelector('#sp-injection-depth')?.value;
        const depth = depthRaw === '' ? 4 : Number(depthRaw);
        const autoIntervalRaw = state.modal.querySelector('#sp-auto-interval')?.value;
        const autoInterval = autoIntervalRaw === '' ? 10 : Number(autoIntervalRaw);
        saveSettings({
            ...apiValues,
            customSystemPrompt: state.modal.querySelector('#sp-custom-system-prompt')?.value || '',
            customUserPrompt: state.modal.querySelector('#sp-custom-user-prompt')?.value || '',
            injectionDepth: isNaN(depth) ? 4 : depth,
        });
        setPlanData({ autoInterval: isNaN(autoInterval) ? 10 : Math.max(1, autoInterval) });
        refreshDisplay();
        applyPlanInjection();
        notify('Story Planner', 'Settings saved.', 'success');
    });

    // Toggle injection
    state.modal.querySelector('#sp-toggle-inject')?.addEventListener('click', () => {
        setPlanData({ injectEnabled: !isInjectionEnabled() });
        applyPlanInjection();
        refreshDisplay();
    });

    // Toggle auto-generate
    state.modal.querySelector('#sp-toggle-auto')?.addEventListener('click', () => {
        const now = !isAutoEnabled();
        setPlanData({ autoEnabled: now });
        if (now) {
            state.autoCounter = 0;
            setPlanData({ autoCounter: 0 });
        }
        refreshDisplay();
    });
}