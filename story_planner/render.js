/**
 * story_planner/render.js — UI rendering and event wiring.
 *
 * Depends on all leaf modules + generation.js + injection.js.
 */

import {
    escapeHtml, estimateTokens, notify,
    renderApiSettingsFields, readApiSettingsValues,
} from '../core/index.js';

import { getSettings, saveSettings } from './settings.js';
import {
    state, getPlanData, setPlanData, getPlanText,
    isInjectionEnabled, isAutoEnabled, getAutoInterval,
} from './data.js';
import { applyPlanInjection } from './injection.js';
import { generatePlan } from './generation.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getContentEl() {
    if (state.contentEl) return state.contentEl;
    if (!state.modal) return null;
    state.contentEl = state.modal.querySelector('.mwt-tab-content[data-tab="story-planner"]');
    return state.contentEl;
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
            <button id="sp-save" class="mwt-btn">💾 Save</button>
            <button id="sp-clear" class="mwt-btn mwt-btn-danger">🗑️ Clear</button>
            <span class="mwt-text-dim mwt-text-sm" style="margin-left:auto;line-height:28px">${words} words · ~${tokens} tokens${autoEnabled ? ` · Auto: ${state.autoCounter}/${autoInterval} msgs` : ''}</span>
        </div>

        <div class="mwt-form-row">
            <textarea id="sp-editor" class="mwt-textarea" style="min-height:300px" placeholder="Generated plot ideas will appear here. You can edit freely — your edits are injected as-is.">${escapeHtml(text)}</textarea>
            <div id="sp-editor-stats" class="mwt-text-dim mwt-text-sm mwt-mt-8">${text.length} chars · ${words} words · ~${tokens} tokens</div>
        </div>

        ${autoEnabled ? `<div style="color:var(--mwt-accent);font-size:12px;margin-bottom:4px">🔄 Auto-generate: ON — generates a new plan every ${autoInterval} messages (${state.autoCounter}/${autoInterval} since last)</div>` : ''}

        <details class="mwt-mt-8">
            <summary style="cursor:pointer;color:var(--mwt-accent);font-weight:500">⚙️ Story Planner Settings</summary>
            <div class="mwt-settings-grid mwt-mt-8">
                ${renderApiSettingsFields(s, { urlId: 'sp-api-url', keyId: 'sp-api-key', modelId: 'sp-model', maxTokensId: 'sp-max-tokens', tempId: 'sp-temp', includeAdvanced: true, includeHeaders: true })}

                <label class="mwt-label">Injection Depth</label>
                <input id="sp-injection-depth" class="mwt-input" type="number" value="${s.injectionDepth ?? 4}" min="0" max="999">

                <label class="mwt-label">Custom System Prompt</label>
                <textarea id="sp-custom-system-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customSystemPrompt || '')}</textarea>
                <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Overrides the system prompt sent to the AI when generating a plan. Leave blank to use the built-in default.</p>

                <label class="mwt-label">Custom User Prompt</label>
                <div>
                    <textarea id="sp-custom-user-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customUserPrompt || '')}</textarea>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Overrides the user task prompt. Supports the token <code>{{chatHistory}}</code>. Leave blank for default.</p>
                </div>

                <label class="mwt-label">Auto-Generate Interval</label>
                <div>
                    <input id="sp-auto-interval" class="mwt-input" type="number" value="${autoInterval}" min="1" max="100" style="max-width:100px">
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">When auto-generate is ON, a new plan is generated every N user messages.</p>
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
                renderContent(); // refresh stats
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
        setPlanData({ text: newText });
        applyPlanInjection();
        renderContent();
        notify('Story Planner', 'Plan saved.', 'success');
    });

    // Clear
    state.modal.querySelector('#sp-clear')?.addEventListener('click', () => {
        if (!confirm('Clear the story plan? This cannot be undone.')) return;
        setPlanData({ text: '' });
        applyPlanInjection();
        renderContent();
    });

    // Auto-save textarea on blur (mirrors world_state auto-save friendliness)
    state.modal.querySelector('#sp-editor')?.addEventListener('blur', () => {
        const newText = state.modal.querySelector('#sp-editor')?.value || '';
        if (newText !== getPlanText()) {
            setPlanData({ text: newText });
            applyPlanInjection();
            renderContent();
        }
    });

    // Save settings
    state.modal.querySelector('#sp-save-settings')?.addEventListener('click', () => {
        const apiValues = readApiSettingsValues(state.modal, {
            urlId: 'sp-api-url', keyId: 'sp-api-key', modelId: 'sp-model',
            maxTokensId: 'sp-max-tokens', tempId: 'sp-temp',
            topPId: 'sp-top-p', freqId: 'sp-freq-pen', presId: 'sp-pres-pen', headersId: 'sp-headers',
        });
        const depth = Number(state.modal.querySelector('#sp-injection-depth')?.value);
        const autoInterval = Number(state.modal.querySelector('#sp-auto-interval')?.value);
        saveSettings({
            ...apiValues,
            customSystemPrompt: state.modal.querySelector('#sp-custom-system-prompt')?.value || '',
            customUserPrompt: state.modal.querySelector('#sp-custom-user-prompt')?.value || '',
            injectionDepth: isNaN(depth) ? 4 : depth,
        });
        setPlanData({ autoInterval: isNaN(autoInterval) ? 10 : Math.max(1, autoInterval) });
        renderContent();
        applyPlanInjection();
        notify('Story Planner', 'Settings saved.', 'success');
    });

    // Toggle injection
    state.modal.querySelector('#sp-toggle-inject')?.addEventListener('click', () => {
        setPlanData({ injectEnabled: !isInjectionEnabled() });
        applyPlanInjection();
        renderContent();
    });

    // Toggle auto-generate
    state.modal.querySelector('#sp-toggle-auto')?.addEventListener('click', () => {
        const now = !isAutoEnabled();
        setPlanData({ autoEnabled: now });
        if (now) {
            state.autoCounter = 0;
            setPlanData({ autoCounter: 0 });
        }
        renderContent();
    });
}