/**
 * Merged World Tracker — Main Entry Point
 *
 * Phase 1: Scaffold + Shared Core
 *   - Loads core modules (context, api, diff, settings, modal)
 *   - Creates a tabbed UI shell with placeholder tabs
 *   - Registers SillyTavern event hooks
 *   - Injects the floating button bar
 *
 * Later phases will import feature modules (world_state, chronicle, knowledge)
 * and wire them into the tab system.
 */

// ─── Core imports ────────────────────────────────────────────────────────────

import { getContextSafe, getChat, estimateTokens } from './core/context.js';
import { normalizeApiBase, fetchFromApi, normaliseOutput } from './core/api.js';
import { escapeHtml, computeLcsDiff, buildInlineDiff, renderDiffHtml, renderLineDiff } from './core/diff.js';
import { createSettingsManager } from './core/settings.js';
import { createModal, showModal, hideModal, setStatus, formatDate } from './core/modal.js';

// ─── Feature module imports ─────────────────────────────────────────────────

import * as WorldState from './world_state/index.js';
import * as Chronicle from './chronicle/index.js';
import * as Knowledge from './knowledge/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const EXT_PREFIX = 'mwt';                     // CSS / DOM id prefix
const SETTINGS_KEY = 'merged_world_tracker';   // localStorage key
const METADATA_KEY = 'merged_world_tracker';   // chat metadata key (future use)

// ─── SillyTavern imports ────────────────────────────────────────────────────

let setExtensionPrompt = null;
let eventSource = null;
let event_types = null;

try {
    const stScript = await import('../../../../script.js');
    setExtensionPrompt = stScript.setExtensionPrompt;
    eventSource = stScript.eventSource;
    event_types = stScript.event_types;
    console.log('[MWT] SillyTavern script.js imports loaded.');
} catch (err) {
    console.warn('[MWT] Could not import from script.js:', err);
}

// ─── Shared settings ────────────────────────────────────────────────────────

const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    defaults: {
        apiUrl: '',
        apiKey: '',
        modelName: '',
        maxTokens: 2000,
        temperature: 0.3,
        topP: 1.0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        customHeaders: '',
        // Per-module injection settings
        worldStateDepth: 4,
        worldStateRole: 'system',
        chronicleDepth: 4,
        chronicleRole: 'system',
    },
    logPrefix: '[MWT]',
});

// Export shared settings accessors so feature modules can use them
// (These will be imported by feature modules in later phases.)
const shared = {
    getSettings,
    saveSettings,
    hasValidSettings,
    getContextSafe,
    getChat,
    estimateTokens,
    fetchFromApi,
    normaliseOutput,
    normalizeApiBase,
    escapeHtml,
    computeLcsDiff,
    buildInlineDiff,
    renderDiffHtml,
    renderLineDiff,
    createModal,
    showModal,
    hideModal,
    setStatus,
    formatDate,
    setExtensionPrompt,
    eventSource,
    event_types,
};

// Make shared available globally for feature module imports
// (SillyTavern's ES module loading means we need this bridge)
window.__mwt_shared = shared;

// ─── Tab definitions ─────────────────────────────────────────────────────────
// Each tab corresponds to a feature module.  In Phase 1 they're placeholders.

const TABS = [
    { id: 'world-state', label: '🌍 World State', phase: 2, module: WorldState },
    { id: 'chronicle', label: '📜 Chronicle', phase: 3, module: Chronicle },
    { id: 'knowledge', label: '🧠 Knowledge', phase: 4, module: Knowledge },
    { id: 'settings', label: '⚙️ Settings', phase: 1, module: null },
];

// ─── UI ──────────────────────────────────────────────────────────────────────

function renderSettingsTab() {
    const s = getSettings();
    return `
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            These global API settings serve as defaults for all modules. Each module can override them in its own Settings panel.
        </p>
        <div class="mwt-settings-grid">
            <label class="mwt-label">API URL</label>
            <input id="mwt-s-api-url" class="mwt-input" type="text"
                   value="${escapeHtml(s.apiUrl)}"
                   placeholder="https://api.openai.com/v1">

            <label class="mwt-label">API Key</label>
            <input id="mwt-s-api-key" class="mwt-input" type="password"
                   value="${escapeHtml(s.apiKey)}"
                   placeholder="sk-...">

            <label class="mwt-label">Model</label>
            <input id="mwt-s-model" class="mwt-input" type="text"
                   value="${escapeHtml(s.modelName)}"
                   placeholder="gpt-4o-mini">

            <label class="mwt-label">Max Tokens</label>
            <input id="mwt-s-max-tokens" class="mwt-input" type="number"
                   value="${s.maxTokens || 2000}" min="100" max="32000">

            <label class="mwt-label">Temperature</label>
            <input id="mwt-s-temp" class="mwt-input" type="number"
                   value="${s.temperature ?? 0.3}" min="0" max="2" step="0.05">

            <label class="mwt-label">Top P</label>
            <input id="mwt-s-top-p" class="mwt-input" type="number"
                   value="${s.topP ?? 1.0}" min="0" max="1" step="0.05">

            <label class="mwt-label">Freq Penalty</label>
            <input id="mwt-s-freq-pen" class="mwt-input" type="number"
                   value="${s.frequencyPenalty ?? 0}" min="-2" max="2" step="0.1">

            <label class="mwt-label">Pres Penalty</label>
            <input id="mwt-s-pres-pen" class="mwt-input" type="number"
                   value="${s.presencePenalty ?? 0}" min="-2" max="2" step="0.1">

            <label class="mwt-label">Custom Headers</label>
            <textarea id="mwt-s-headers" class="mwt-input" rows="2"
                      placeholder='{"X-Custom": "value"}'>${escapeHtml(s.customHeaders || '')}</textarea>

            <div></div>
            <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                <button id="mwt-s-save" class="mwt-btn mwt-btn-primary">Save Settings</button>
                <button id="mwt-s-sync" class="mwt-btn" title="Copy these API settings to all module-specific configs">↓ Sync to Modules</button>
            </div>
        </div>

        <hr style="border-color:var(--mwt-border);margin:16px 0">
        <h3 style="margin-bottom:8px">🔧 Injection Settings</h3>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            Control how each module's entries are injected into the prompt. Depth = how far back from the bottom; Role = which message role. (Knowledge uses SillyTavern's built-in lorebook system and does not use extension prompt injection.)
        </p>
        <div class="mwt-settings-grid">
            <label class="mwt-label" style="grid-column:1/3;font-weight:bold">🌍 World State</label>
            <label class="mwt-label">Depth</label>
            <input id="mwt-s-ws-depth" class="mwt-input" type="number" value="${s.worldStateDepth ?? 4}" min="0" max="999">
            <label class="mwt-label">Role</label>
            <select id="mwt-s-ws-role" class="mwt-input">
                <option value="system" ${s.worldStateRole === 'system' ? 'selected' : ''}>system</option>
                <option value="user" ${s.worldStateRole === 'user' ? 'selected' : ''}>user</option>
                <option value="assistant" ${s.worldStateRole === 'assistant' ? 'selected' : ''}>assistant</option>
            </select>

            <label class="mwt-label" style="grid-column:1/3;font-weight:bold">📜 Chronicle</label>
            <label class="mwt-label">Depth</label>
            <input id="mwt-s-ch-depth" class="mwt-input" type="number" value="${s.chronicleDepth ?? 4}" min="0" max="999">
            <label class="mwt-label">Role</label>
            <select id="mwt-s-ch-role" class="mwt-input">
                <option value="system" ${s.chronicleRole === 'system' ? 'selected' : ''}>system</option>
                <option value="user" ${s.chronicleRole === 'user' ? 'selected' : ''}>user</option>
                <option value="assistant" ${s.chronicleRole === 'assistant' ? 'selected' : ''}>assistant</option>
            </select>
        </div>

        <hr style="border-color:var(--mwt-border);margin:16px 0">
        <p style="color:var(--mwt-text-dim);font-size:12px">
            <strong>Module-specific settings</strong> are available in each tab's ⚙ Settings button.
            Use "Sync to Modules" above to push the global API URL/Key/Model to all modules at once.
        </p>
    `;
}

function renderPlaceholderTab(tab) {
    return `
        <div style="text-align:center; padding:40px 20px;">
            <p style="font-size:18px; margin-bottom:8px;">🚧 ${tab.label}</p>
            <p style="color:var(--mwt-text-dim);">This module will be available in <strong>Phase ${tab.phase}</strong>.</p>
            <p style="color:var(--mwt-text-dim); font-size:12px; margin-top:12px;">
                The standalone extension for this feature is still active and can be used normally.
            </p>
        </div>
    `;
}

function buildTabContent(tab) {
    if (tab.id === 'settings') return renderSettingsTab();
    if (tab.module) {
        const renderFn = tab.module.getModuleRender?.() || tab.module.render;
        if (typeof renderFn === 'function') return renderFn();
    }
    return renderPlaceholderTab(tab);
}

let modal = null;
const _initedModules = new Set();
let _modalEscapeHandler = null;

function renderModal() {
    const tabBarHtml = TABS.map((t, i) =>
        `<button class="mwt-tab-btn ${i === 0 ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`
    ).join('');

    const tabContentsHtml = TABS.map((t, i) =>
        `<div class="mwt-tab-content ${i === 0 ? 'active' : ''}" data-tab="${t.id}">${buildTabContent(t)}</div>`
    ).join('');

    const content = `
        <div class="mwt-tab-bar">${tabBarHtml}</div>
        ${tabContentsHtml}
    `;

    if (!modal) {
        modal = createModal({
            id: 'mwt-modal',
            title: 'Merged World Tracker',
            content,
            onClose: () => { console.log('[MWT] Modal closed.'); },
        });

        // Add unsaved-changes warning for World State tab
        const closeBtn = modal.querySelector('.mwt-modal-close');
        const backdrop = modal.querySelector('.mwt-modal-backdrop');
        const safeClose = () => {
            if (WorldState.isWorldStateDirty?.()) {
                if (!confirm('You have unsaved changes to the World State. Close anyway?')) return;
            }
            hideModal('mwt-modal');
        };
        // Replace existing close handlers (createModal binds them inline)
        closeBtn?.addEventListener('click', safeClose);
        backdrop?.addEventListener('click', safeClose);
        // Also handle Escape key — attach once only
        if (!_modalEscapeHandler) {
            _modalEscapeHandler = (e) => {
                if (e.key === 'Escape' && modal?.style.display === 'flex') {
                    safeClose();
                }
            };
            document.addEventListener('keydown', _modalEscapeHandler);
        }
    } else {
        const body = modal.querySelector('.mwt-modal-body');
        if (body) body.innerHTML = content;
    }

    // Wire tab clicks via event delegation
    const tabBar = modal.querySelector('.mwt-tab-bar');
    if (tabBar) {
        tabBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.mwt-tab-btn');
            if (!btn) return;
            const tabId = btn.dataset.tab;
            modal.querySelectorAll('.mwt-tab-btn').forEach(b => b.classList.remove('active'));
            modal.querySelectorAll('.mwt-tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const content = modal.querySelector(`.mwt-tab-content[data-tab="${tabId}"]`);
            if (content) content.classList.add('active');
        });
    }

    // Init feature modules with modal reference and wire their events
    // (deduplicate — same module may back multiple tabs)
    for (const tab of TABS) {
        const mod = tab.module;
        if (!mod) continue;
        if (mod.init) mod.init(modal);
        if (mod.getModuleWireEvents) mod.getModuleWireEvents()();
    }

    // Wire settings save
    const saveBtn = modal.querySelector('#mwt-s-save');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const patch = {
                apiUrl: modal.querySelector('#mwt-s-api-url')?.value || '',
                apiKey: modal.querySelector('#mwt-s-api-key')?.value || '',
                modelName: modal.querySelector('#mwt-s-model')?.value || '',
                maxTokens: Number(modal.querySelector('#mwt-s-max-tokens')?.value) || 2000,
                temperature: (() => { const v = Number(modal.querySelector('#mwt-s-temp')?.value); return Number.isFinite(v) ? v : 0.3; })(),
                topP: (() => { const v = Number(modal.querySelector('#mwt-s-top-p')?.value); return Number.isFinite(v) ? v : 1.0; })(),
                frequencyPenalty: (() => { const v = Number(modal.querySelector('#mwt-s-freq-pen')?.value); return Number.isFinite(v) ? v : 0; })(),
                presencePenalty: (() => { const v = Number(modal.querySelector('#mwt-s-pres-pen')?.value); return Number.isFinite(v) ? v : 0; })(),
                customHeaders: modal.querySelector('#mwt-s-headers')?.value || '',
                // Per-module injection settings
                worldStateDepth: Number(modal.querySelector('#mwt-s-ws-depth')?.value) || 4,
                worldStateRole: modal.querySelector('#mwt-s-ws-role')?.value || 'system',
                chronicleDepth: Number(modal.querySelector('#mwt-s-ch-depth')?.value) || 4,
                chronicleRole: modal.querySelector('#mwt-s-ch-role')?.value || 'system',
            };
            saveSettings(patch);
            setStatus(modal, 'Settings saved.', 'success', 3000);
        });
    }

    // Wire sync-to-modules button
    const syncBtn = modal.querySelector('#mwt-s-sync');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => {
            const patch = {
                apiUrl: modal.querySelector('#mwt-s-api-url')?.value || '',
                apiKey: modal.querySelector('#mwt-s-api-key')?.value || '',
                modelName: modal.querySelector('#mwt-s-model')?.value || '',
            };
            // Push to each module's settings
            if (WorldState.syncGlobalSettings) WorldState.syncGlobalSettings(patch);
            if (Chronicle.syncGlobalSettings) Chronicle.syncGlobalSettings(patch);
            if (Knowledge.syncGlobalSettings) Knowledge.syncGlobalSettings(patch);
            setStatus(modal, 'API settings synced to all modules.', 'success', 3000);
        });
    }
}

// ─── Individual floating draggable buttons ──────────────────────────────────

const FLOAT_BUTTONS = [
    { id: 'mwt-float-world', label: '🌍', title: 'World State', tab: 'world-state' },
    { id: 'mwt-float-chronicle', label: '📜', title: 'Chronicle', tab: 'chronicle' },
    { id: 'mwt-float-knowledge', label: '🧠', title: 'Knowledge', tab: 'knowledge' },
    { id: 'mwt-float-settings', label: '⚙️', title: 'All Settings', tab: 'settings' },
];

const FLOAT_POSITIONS_KEY = 'mwt_float_positions';

function loadFloatPositions() {
    try {
        const raw = localStorage.getItem(FLOAT_POSITIONS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function saveFloatPosition(btnId, left, top) {
    try {
        const positions = loadFloatPositions();
        positions[btnId] = { left, top };
        localStorage.setItem(FLOAT_POSITIONS_KEY, JSON.stringify(positions));
    } catch { /* ignore */ }
}

function setupButtonBar() {
    // Remove old button bar if it exists
    const old = document.getElementById('mwt-button-bar');
    if (old) old.remove();

    const savedPositions = loadFloatPositions();

    FLOAT_BUTTONS.forEach((cfg, idx) => {
        let btn = document.getElementById(cfg.id);
        if (btn) return; // already created

        btn = document.createElement('div');
        btn.id = cfg.id;
        btn.className = 'mwt-float-btn';
        btn.title = cfg.title;
        btn.innerHTML = `<span class="mwt-float-btn-icon">${cfg.label}</span><span class="mwt-float-btn-tokens" id="${cfg.id}-tokens"></span><span class="mwt-float-btn-countdown" id="${cfg.id}-countdown"></span>`;

        // Restore saved position or use default
        const saved = savedPositions[cfg.id];
        if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
            btn.style.left = saved.left + 'px';
            btn.style.top = saved.top + 'px';
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        } else {
            btn.style.right = '16px';
            btn.style.bottom = `${70 + idx * 48}px`;
        }
        document.body.appendChild(btn);

        // Click to open modal on that tab
        btn.addEventListener('click', (e) => {
            if (btn._dragged) { btn._dragged = false; return; }
            renderModal();
            showModal('mwt-modal');
            // Activate the correct tab
            const tabBtn = modal?.querySelector(`.mwt-tab-btn[data-tab="${cfg.tab}"]`);
            if (tabBtn) tabBtn.click();
        });

        // Drag support
        let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
        btn.addEventListener('mousedown', (e) => {
            dragging = true;
            btn._dragged = false;
            startX = e.clientX; startY = e.clientY;
            const rect = btn.getBoundingClientRect();
            origX = rect.left; origY = rect.top;
            btn.style.transition = 'none';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX, dy = e.clientY - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) btn._dragged = true;
            btn.style.left = (origX + dx) + 'px';
            btn.style.top = (origY + dy) + 'px';
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                btn.style.transition = 'left 0.1s, top 0.1s';
                // Persist the final position
                const rect = btn.getBoundingClientRect();
                saveFloatPosition(cfg.id, rect.left, rect.top);
            }
        });
    });
}

// ─── Event hooks ─────────────────────────────────────────────────────────────

if (eventSource && event_types?.CHAT_CHANGED) {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('[MWT] Chat changed — resetting state.');
        WorldState.onChatChanged();
        Chronicle.onChatChanged();
        Knowledge.onChatChanged();
    });
}

if (eventSource && event_types?.MESSAGE_RECEIVED) {
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        WorldState.onMessageReceived();
        Chronicle.onMessageReceived();
        Knowledge.onMessageReceived();
    });
}

if (eventSource && event_types?.GENERATION_STARTED) {
    eventSource.on(event_types.GENERATION_STARTED, () => {
        Chronicle.onGenerationStarted();
    });
}

if (eventSource && event_types?.GENERATION_STOPPED) {
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        Chronicle.onGenerationStopped();
    });
}

// Also hook GENERATION_ENDED for redundancy
if (eventSource && event_types?.GENERATION_ENDED) {
    eventSource.on(event_types.GENERATION_ENDED, () => {
        Chronicle.onGenerationStopped();
    });
}

// ─── Initialize ──────────────────────────────────────────────────────────────

setupButtonBar();
WorldState.init(null);  // Will be re-initialized with modal reference on first open
Chronicle.init(null);
Knowledge.init(null);

// Periodically update floating button token counts and auto-refresh countdown
function updateFloatTokenCounts() {
    try {
        const modules = [
            { id: 'mwt-float-world', getTokens: WorldState.getTotalTokens },
            { id: 'mwt-float-chronicle', getTokens: Chronicle.getTotalTokens },
            { id: 'mwt-float-knowledge', getTokens: Knowledge.getTotalTokens },
        ];
        for (const m of modules) {
            const el = document.getElementById(`${m.id}-tokens`);
            if (!el) continue;
            if (typeof m.getTokens === 'function') {
                const count = m.getTokens();
                if (count > 0) {
                    el.textContent = `${count}t`;
                    el.style.display = 'inline';
                } else {
                    el.textContent = '';
                    el.style.display = 'none';
                }
            }
        }

        // Async token refresh for Knowledge (cached)
        if (typeof Knowledge.refreshTotalTokens === 'function') {
            Knowledge.refreshTotalTokens().catch(() => {});
        }

        // Update auto-refresh countdown on World State floating button
        const countdownEl = document.getElementById('mwt-float-world-countdown');
        if (countdownEl) {
            const status = WorldState.getAutoRefreshStatus?.();
            if (status) {
                const remaining = status.interval - status.counter;
                countdownEl.textContent = `${remaining}`;
                countdownEl.style.display = 'block';
                countdownEl.title = `Auto-refresh in ${remaining} message${remaining !== 1 ? 's' : ''} (${status.counter}/${status.interval})`;
            } else {
                countdownEl.textContent = '';
                countdownEl.style.display = 'none';
                countdownEl.title = '';
            }
        }

        // Update auto-snapshot countdown on Chronicle floating button
        const chCountdownEl = document.getElementById('mwt-float-chronicle-countdown');
        if (chCountdownEl) {
            const chStatus = Chronicle.getAutoSnapshotStatus?.();
            if (chStatus) {
                const remaining = chStatus.threshold - chStatus.counter;
                chCountdownEl.textContent = `${remaining}`;
                chCountdownEl.style.display = 'block';
                chCountdownEl.title = `Auto-snapshot in ${remaining} message${remaining !== 1 ? 's' : ''} (${chStatus.counter}/${chStatus.threshold})`;
            } else {
                chCountdownEl.textContent = '';
                chCountdownEl.style.display = 'none';
                chCountdownEl.title = '';
            }
        }
    } catch { /* ignore */ }
}
setInterval(updateFloatTokenCounts, 5000);
setTimeout(updateFloatTokenCounts, 2000);

console.log('[MWT] Merged World Tracker extension loaded (Phase 4 — Knowledge Tracker integrated).');
console.log('[MWT] Shared API available at window.__mwt_shared');