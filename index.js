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
import { normalizeApiBase, fetchFromApi, fetchViaSTConnection, fetchViaConnectionProfile, resolveApiCall, normaliseOutput } from './core/api.js';
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
let registerSlashCommand = null;
let registerMacro = null;

try {
    const stScript = await import('../../../../script.js');
    setExtensionPrompt = stScript.setExtensionPrompt;
    eventSource = stScript.eventSource;
    event_types = stScript.event_types;
    // Slash command registration
    if (typeof stScript.registerSlashCommand === 'function') {
        registerSlashCommand = stScript.registerSlashCommand;
    }
    console.log('[MWT] SillyTavern script.js imports loaded.');
} catch (err) {
    console.warn('[MWT] Could not import from script.js:', err);
}

// Try to get registerSlashCommand from context as fallback
if (!registerSlashCommand) {
    const ctx = getContextSafe();
    if (ctx && typeof ctx.registerSlashCommand === 'function') {
        registerSlashCommand = ctx.registerSlashCommand.bind(ctx);
    }
}

// Try to load macro registration via the new macro system
let macroRegistry = null;
try {
    const macroSystem = await import('../../../../scripts/macros/macro-system.js');
    if (macroSystem?.macros?.registry && typeof macroSystem.macros.registry.registerMacro === 'function') {
        macroRegistry = macroSystem.macros.registry;
    }
} catch {
    // Fallback: try the deprecated context API
    const ctx = getContextSafe();
    if (ctx && typeof ctx.registerMacro === 'function') {
        registerMacro = ctx.registerMacro.bind(ctx);
    }
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
        connectionProfileId: '',
        // Per-module injection settings
        worldStateDepth: 4,
        worldStateRole: 'system',
        chronicleDepth: 4,
        chronicleRole: 'system',
        // Floating button visibility
        showFloatWorld: true,
        showFloatChronicle: true,
        showFloatKnowledge: true,
        showFloatSettings: true,
        collapseFloatButtons: false,
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
    fetchViaSTConnection,
    fetchViaConnectionProfile,
    resolveApiCall,
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
    const hasProfile = !!s.connectionProfileId;
    const apiFieldsStyle = hasProfile ? 'display:none' : '';

    // Build connection profile dropdown options from ST's Connection Manager
    let profileOptionsHtml = '<option value="">— None (use custom API below) —</option>';
    try {
        const ctx = getContextSafe();
        // connectionManager.profiles is an ARRAY of profile objects (each with a
        // real .id); iterate it directly — Object.entries() would yield array
        // indices as the "id" and store the wrong value.
        const profiles = ctx?.extensionSettings?.connectionManager?.profiles || [];
        const selectedId = ctx?.extensionSettings?.connectionManager?.selectedProfile || '';
        for (const profile of profiles) {
            const id = profile.id;
            if (!id) continue;
            const name = profile.name || id;
            const selected = id === s.connectionProfileId ? ' selected' : '';
            const isActive = id === selectedId ? ' (active)' : '';
            profileOptionsHtml += `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(name)}${isActive}</option>`;
        }
    } catch { /* ignore */ }

    return `
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            These global API settings serve as defaults for all modules. Each module can override them in its own Settings panel.
        </p>
        <div class="mwt-settings-grid">
            <label class="mwt-label" style="grid-column:1/2">Connection Profile</label>
            <select id="mwt-s-connection-profile" class="mwt-input" style="grid-column:2/3">
                ${profileOptionsHtml}
            </select>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin:0;grid-column:1/3">
                Select a Connection Manager profile to use with all backends (OpenAI, TextGen, etc.) with full preset/instruct support. Leave empty to configure a custom API URL/Key below. Profiles marked (active) are ST's currently selected profile.
            </p>

            <div id="mwt-s-api-fields" style="grid-column:1/3;${apiFieldsStyle}" class="mwt-settings-grid" >
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
            </div>

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
        <h3 style="margin-bottom:8px">🔘 Floating Buttons</h3>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            Show or hide individual floating buttons. You can also access the MWT modal from the Extensions panel drawer or the wand menu.
        </p>
        <div class="mwt-settings-grid">
            <label class="mwt-label" style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="mwt-s-collapse-float" ${s.collapseFloatButtons ? 'checked' : ''}>
                <span>Collapse into single button</span>
            </label>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Replace the 4 floating buttons with one that expands on tap/click.</p>

            <label class="mwt-label">🌍 World State</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-world" ${s.showFloatWorld !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label">📜 Chronicle</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-chronicle" ${s.showFloatChronicle !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label">🧠 Knowledge</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-knowledge" ${s.showFloatKnowledge !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label">⚙️ Settings</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-settings" ${s.showFloatSettings !== false ? 'checked' : ''}> Visible</label>
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
            onClose: () => {
                if (WorldState.isWorldStateDirty?.()
                    && !confirm('You have unsaved changes to the World State. Close anyway?')) {
                    return false;
                }
                console.log('[MWT] Modal closed.');
            },
        });
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
            const tabContent = modal.querySelector(`.mwt-tab-content[data-tab="${tabId}"]`);
            if (tabContent) tabContent.classList.add('active');
        });
    }

    // Init feature modules with modal reference and wire their events
    for (const tab of TABS) {
        const mod = tab.module;
        if (!mod) continue;
        if (!_initedModules.has(mod)) {
            _initedModules.add(mod);
            if (mod.init) mod.init(modal);
        }
        if (mod.getModuleWireEvents) mod.getModuleWireEvents()();
    }

    // Wire connection profile toggle (hide API fields when a profile is selected)
    const profileSelect = modal.querySelector('#mwt-s-connection-profile');
    if (profileSelect) {
        profileSelect.addEventListener('change', () => {
            const apiFields = modal.querySelector('#mwt-s-api-fields');
            if (apiFields) apiFields.style.display = profileSelect.value ? 'none' : '';
        });
    }

    // Wire settings save
    const saveBtn = modal.querySelector('#mwt-s-save');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const patch = {
                connectionProfileId: modal.querySelector('#mwt-s-connection-profile')?.value || '',
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
                // Button visibility
                showFloatWorld: modal.querySelector('#mwt-s-show-world')?.checked ?? true,
                showFloatChronicle: modal.querySelector('#mwt-s-show-chronicle')?.checked ?? true,
                showFloatKnowledge: modal.querySelector('#mwt-s-show-knowledge')?.checked ?? true,
                showFloatSettings: modal.querySelector('#mwt-s-show-settings')?.checked ?? true,
                collapseFloatButtons: modal.querySelector('#mwt-s-collapse-float')?.checked ?? false,
            };
            saveSettings(patch);
            applyButtonVisibility();
            setStatus(modal, 'Settings saved.', 'success', 3000);
        });
    }

    // Wire sync-to-modules button
    const syncBtn = modal.querySelector('#mwt-s-sync');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => {
            const patch = {
                connectionProfileId: modal.querySelector('#mwt-s-connection-profile')?.value || '',
                apiUrl: modal.querySelector('#mwt-s-api-url')?.value || '',
                apiKey: modal.querySelector('#mwt-s-api-key')?.value || '',
                modelName: modal.querySelector('#mwt-s-model')?.value || '',
            };
            if (WorldState.syncGlobalSettings) WorldState.syncGlobalSettings(patch);
            if (Chronicle.syncGlobalSettings) Chronicle.syncGlobalSettings(patch);
            if (Knowledge.syncGlobalSettings) Knowledge.syncGlobalSettings(patch);
            setStatus(modal, 'API settings synced to all modules.', 'success', 3000);
        });
    }
}

// ─── Open modal helper (shared by button bar, wand menu, drawer) ────────────

function openMwtModal(tabId) {
    const isOpen = modal && modal.style.display === 'flex';
    if (!isOpen) {
        renderModal();
        showModal('mwt-modal');
    }
    if (tabId) {
        const tabBtn = modal?.querySelector(`.mwt-tab-btn[data-tab="${tabId}"]`);
        if (tabBtn) tabBtn.click();
    }
}

// ─── Individual floating draggable buttons ──────────────────────────────────

const FLOAT_BUTTONS = [
    { id: 'mwt-float-world', label: '🌍', title: 'World State', tab: 'world-state', visibilityKey: 'showFloatWorld' },
    { id: 'mwt-float-chronicle', label: '📜', title: 'Chronicle', tab: 'chronicle', visibilityKey: 'showFloatChronicle' },
    { id: 'mwt-float-knowledge', label: '🧠', title: 'Knowledge', tab: 'knowledge', visibilityKey: 'showFloatKnowledge' },
    { id: 'mwt-float-settings', label: '⚙️', title: 'All Settings', tab: 'settings', visibilityKey: 'showFloatSettings' },
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

/**
 * Apply per-button visibility from settings.
 * Also handles the "collapse into one" mode.
 */
function applyButtonVisibility() {
    const s = getSettings();
    const collapsed = s.collapseFloatButtons ?? false;

    // Handle collapsed hub button
    let hub = document.getElementById('mwt-float-hub');
    if (collapsed) {
        if (!hub) {
            hub = document.createElement('div');
            hub.id = 'mwt-float-hub';
            hub.className = 'mwt-float-btn';
            hub.title = 'Merged World Tracker';
            hub.style.right = '16px';
            hub.style.bottom = '70px';
            hub.innerHTML = '<span class="mwt-float-btn-icon">🌐</span>';
            hub.addEventListener('click', () => openMwtModal(null));
            document.body.appendChild(hub);
        }
        hub.style.display = 'flex';
    } else if (hub) {
        hub.style.display = 'none';
    }

    // Individual button visibility
    for (const cfg of FLOAT_BUTTONS) {
        const btn = document.getElementById(cfg.id);
        if (!btn) continue;
        const visible = s[cfg.visibilityKey] !== false;
        btn.style.display = (collapsed || !visible) ? 'none' : 'flex';
    }
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
        btn.style.touchAction = 'none'; // Enable pointer events for touch
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
            openMwtModal(cfg.tab);
        });

        // Pointer-event-based drag (covers mouse + touch + pen)
        let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
        btn.addEventListener('pointerdown', (e) => {
            dragging = true;
            btn._dragged = false;
            btn.setPointerCapture(e.pointerId);
            startX = e.clientX; startY = e.clientY;
            const rect = btn.getBoundingClientRect();
            origX = rect.left; origY = rect.top;
            btn.style.transition = 'none';
            e.preventDefault();
        });
        btn.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX, dy = e.clientY - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) btn._dragged = true;
            btn.style.left = (origX + dx) + 'px';
            btn.style.top = (origY + dy) + 'px';
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        });
        btn.addEventListener('pointerup', (e) => {
            if (dragging) {
                dragging = false;
                btn.releasePointerCapture(e.pointerId);
                btn.style.transition = 'left 0.1s, top 0.1s';
                const rect = btn.getBoundingClientRect();
                saveFloatPosition(cfg.id, rect.left, rect.top);
            }
        });
        btn.addEventListener('pointercancel', () => {
            dragging = false;
        });
    });

    applyButtonVisibility();
}

// ─── Extensions panel drawer ─────────────────────────────────────────────────

function setupExtensionsDrawer() {
    const drawer = document.getElementById('mwt-extensions-drawer');
    if (drawer) return; // already created

    const container = document.createElement('div');
    container.id = 'mwt-extensions-drawer';
    container.className = 'mwt-extensions-drawer';
    container.innerHTML = `
        <div class="mwt-drawer-title">Merged World Tracker</div>
        <div class="mwt-drawer-buttons">
            <button class="mwt-btn mwt-btn-primary" id="mwt-drawer-open" title="Open the MWT modal">🌐 Open MWT</button>
            <button class="mwt-btn" id="mwt-drawer-world" title="Open World State tab">🌍</button>
            <button class="mwt-btn" id="mwt-drawer-chronicle" title="Open Chronicle tab">📜</button>
            <button class="mwt-btn" id="mwt-drawer-knowledge" title="Open Knowledge tab">🧠</button>
        </div>
    `;

    // Append to the Extensions panel
    const extPanel = document.getElementById('extensions_settings');
    if (extPanel) {
        extPanel.appendChild(container);
    } else {
        // Fallback: append after the settings drawer
        document.body.appendChild(container);
    }

    // Wire buttons
    container.querySelector('#mwt-drawer-open')?.addEventListener('click', () => openMwtModal(null));
    container.querySelector('#mwt-drawer-world')?.addEventListener('click', () => openMwtModal('world-state'));
    container.querySelector('#mwt-drawer-chronicle')?.addEventListener('click', () => openMwtModal('chronicle'));
    container.querySelector('#mwt-drawer-knowledge')?.addEventListener('click', () => openMwtModal('knowledge'));
}

// ─── Wand menu entry ─────────────────────────────────────────────────────────

function setupWandMenu() {
    const existing = document.getElementById('mwt-wand-entry');
    if (existing) return;

    // The wand menu is #extensionsMenu inside the input area
    const wandMenu = document.getElementById('extensionsMenu');
    if (!wandMenu) return;

    const entry = document.createElement('div');
    entry.id = 'mwt-wand-entry';
    entry.className = 'list-group-item';
    entry.innerHTML = `<a href="#" id="mwt-wand-link" title="Open Merged World Tracker"><span class="note-link-span fa-solid fa-globe"></span> MWT</a>`;

    wandMenu.appendChild(entry);

    entry.querySelector('#mwt-wand-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        openMwtModal(null);
        // Close the wand menu
        if (typeof $ !== 'undefined') {
            try { $('#extensionsMenu').dropdown('toggle'); } catch { /* not a bootstrap dropdown */ }
        }
    });
}

// ─── Slash Commands ──────────────────────────────────────────────────────────

function setupSlashCommands() {
    if (!registerSlashCommand) {
        console.warn('[MWT] registerSlashCommand not available — slash commands disabled.');
        return;
    }

    try {
        // /wt-refresh — Trigger world state refresh
        registerSlashCommand('wt-refresh', async (_args, _command) => {
            try {
                if (typeof WorldState.triggerRefresh === 'function') {
                    await WorldState.triggerRefresh();
                    return 'World state refreshed.';
                }
                return 'World state refresh not available.';
            } catch (err) {
                return `Error: ${err.message}`;
            }
        }, ['mwt-refresh'], 'Refresh the MWT world state');

        // /wt-snapshot — Generate chronicle snapshot
        registerSlashCommand('wt-snapshot', async (_args, _command) => {
            try {
                if (typeof Chronicle.triggerSnapshot === 'function') {
                    await Chronicle.triggerSnapshot();
                    return 'Chronicle snapshot generated.';
                }
                return 'Chronicle snapshot not available.';
            } catch (err) {
                return `Error: ${err.message}`;
            }
        }, ['mwt-snapshot'], 'Generate a chronicle snapshot');

        // /wt-scan — Run knowledge NPC scan
        registerSlashCommand('wt-scan', async (_args, _command) => {
            try {
                if (typeof Knowledge.triggerScan === 'function') {
                    await Knowledge.triggerScan();
                    return 'NPC scan complete.';
                }
                return 'NPC scan not available.';
            } catch (err) {
                return `Error: ${err.message}`;
            }
        }, ['mwt-scan'], 'Run an NPC scan via Knowledge Tracker');

        // /wt-inject on|off — Toggle injection for all modules
        registerSlashCommand('wt-inject', async (args, _command) => {
            const mode = (args || '').trim().toLowerCase();
            if (mode !== 'on' && mode !== 'off') {
                return 'Usage: /wt-inject on|off';
            }
            const enabled = mode === 'on';
            if (typeof WorldState.setInjectionEnabled === 'function') {
                WorldState.setInjectionEnabled(enabled);
            }
            if (typeof Chronicle.setInjectionEnabled === 'function') {
                Chronicle.setInjectionEnabled(enabled);
            }
            return `Injection ${mode} for all modules.`;
        }, ['mwt-inject'], 'Toggle injection for all MWT modules (on/off)');

        // /wt-state — Return world state text (pipeable)
        registerSlashCommand('wt-state', async (_args, _command) => {
            const text = typeof WorldState.getWorldStateText === 'function'
                ? WorldState.getWorldStateText()
                : '';
            return text || '(no world state)';
        }, ['mwt-state'], 'Output the current world state text (pipeable)');

        console.log('[MWT] Slash commands registered.');
    } catch (err) {
        console.warn('[MWT] Failed to register slash commands:', err);
    }
}

// ─── Macros ──────────────────────────────────────────────────────────────────

function setupMacros() {
    // Prefer the new macro system (macros/macro-system.js)
    if (macroRegistry && typeof macroRegistry.registerMacro === 'function') {
        try {
            macroRegistry.registerMacro('worldstate', {
                handler: () => WorldState.getWorldStateText?.() || '',
                category: 'state',
                description: 'Returns the current merged world state text.',
            });
            macroRegistry.registerMacro('chronicle', {
                handler: () => Chronicle.getChronicleText?.() || '',
                category: 'state',
                description: 'Returns the full chronicle text.',
            });
            macroRegistry.registerMacro('lastchronicle', {
                handler: () => Chronicle.getLastEntryText?.() || '',
                category: 'state',
                description: 'Returns the most recent chronicle entry.',
            });
            console.log('[MWT] Macros registered via new macro system: {{worldstate}}, {{chronicle}}, {{lastchronicle}}');
            return;
        } catch (err) {
            console.warn('[MWT] Failed to register macros via new system:', err);
        }
    }

    // Fallback: deprecated API or context-based registration
    const ctx = getContextSafe();
    const registerFn = registerMacro
        || ctx?.registerMacro
        || ctx?.macroApi?.registerMacro;

    if (registerFn) {
        try {
            registerFn('worldstate', () => WorldState.getWorldStateText?.() || '');
            registerFn('chronicle', () => Chronicle.getChronicleText?.() || '');
            registerFn('lastchronicle', () => Chronicle.getLastEntryText?.() || '');
            console.log('[MWT] Macros registered (deprecated API): {{worldstate}}, {{chronicle}}, {{lastchronicle}}');
            return;
        } catch (err) {
            console.warn('[MWT] Failed to register macros via deprecated API:', err);
        }
    }

    // Last resort: try the global MacroEngine directly
    try {
        const macroEngine = window.MacroEngine || ctx?.macroEngine;
        if (macroEngine?.register) {
            console.log('[MWT] Using MacroEngine fallback for macro registration.');
            macroEngine.register('worldstate', () => WorldState.getWorldStateText?.() || '');
            macroEngine.register('chronicle', () => Chronicle.getChronicleText?.() || '');
            macroEngine.register('lastchronicle', () => Chronicle.getLastEntryText?.() || '');
            console.log('[MWT] Macros registered via MacroEngine.');
            return;
        }
    } catch { /* fallback failed */ }

    console.warn('[MWT] No macro registration API available — macros disabled.');
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
setupExtensionsDrawer();
setupWandMenu();
setupSlashCommands();
setupMacros();

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