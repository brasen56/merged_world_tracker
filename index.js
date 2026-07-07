/**
 * Merged World Tracker — Main Entry Point
 *
 * Loads core modules, creates a tabbed UI shell, registers SillyTavern
 * event hooks, and delegates floating-button / drawer / wand-menu UI to
 * core/ui.js. Slash commands and macros are handled by core/commands.js.
 */

// ─── Core imports ────────────────────────────────────────────────────────────

import { getContextSafe } from './core/context.js';
import { escapeHtml } from './core/diff.js';
import { createSettingsManager } from './core/settings.js';
import { createModal, showModal, setStatus } from './core/modal.js';
import { createFloatingButtonBar, renderApiSettingsFields, readApiSettingsValues } from './core/ui.js';
import { createCommands } from './core/commands.js';

// ─── Feature module imports ─────────────────────────────────────────────────

import * as WorldState from './world_state/index.js';
import * as Chronicle from './chronicle/index.js';
import * as Knowledge from './knowledge/index.js';
import * as StoryPlanner from './story_planner/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const EXT_PREFIX = 'mwt';                     // CSS / DOM id prefix
const SETTINGS_KEY = 'merged_world_tracker';   // localStorage key

// ID opts for shared API settings helpers (renderApiSettingsFields / readApiSettingsValues)
const GLOBAL_API_FIELD_IDS = {
    urlId: 'mwt-s-api-url',
    keyId: 'mwt-s-api-key',
    modelId: 'mwt-s-model',
    maxTokensId: 'mwt-s-max-tokens',
    tempId: 'mwt-s-temp',
    topPId: 'mwt-s-top-p',
    freqId: 'mwt-s-freq-pen',
    presId: 'mwt-s-pres-pen',
    headersId: 'mwt-s-headers',
};

// ─── SillyTavern imports ────────────────────────────────────────────────────

let eventSource = null;
let event_types = null;
let registerSlashCommand = null;

try {
    const stScript = await import('../../../../script.js');
    eventSource = stScript.eventSource;
    event_types = stScript.event_types;
    if (typeof stScript.registerSlashCommand === 'function') {
        registerSlashCommand = stScript.registerSlashCommand;
    }
    console.log('[MWT] SillyTavern script.js imports loaded.');
} catch (err) {
    console.warn('[MWT] Could not import from script.js:', err);
}

// Fallback: get registerSlashCommand from context
if (!registerSlashCommand) {
    const ctx = getContextSafe();
    if (ctx && typeof ctx.registerSlashCommand === 'function') {
        registerSlashCommand = ctx.registerSlashCommand.bind(ctx);
    }
}

// Load macro registration via the modern macro system (requires ST 1.12+)
let macroRegistry = null;
try {
    const macroSystem = await import('../../../../scripts/macros/macro-system.js');
    if (macroSystem?.macros?.registry && typeof macroSystem.macros.registry.registerMacro === 'function') {
        macroRegistry = macroSystem.macros.registry;
    }
} catch { /* macro-system.js not available */ }

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
        // Structural boundaries: wrap injected blocks in XML tags for clarity
        structuralBoundaries: true,
        // Floating button visibility
        showFloatWorld: true,
        showFloatChronicle: true,
        showFloatKnowledge: true,
        showFloatStoryPlanner: true,
        showFloatSettings: true,
        collapseFloatButtons: false,
        buttonStyle: 'modern', // 'modern' | 'classic'
        // Per-tracker enable (default on). When false, that tracker stops
        // injecting + scanning but its floating icon stays visible with a red ✕
        // so it can be re-enabled via right-click. The icon's *presence* is
        // controlled independently by the showFloatX settings above.
        enableWorldState: true,
        enableChronicle: true,
        enableKnowledge: true,
        enableStoryPlanner: true,
        // Global "stop injecting / scanning everything" panic switch.
        // Flipped by right-clicking the ⚙️ floating button.
        injectionMasterOff: false,
    },
    logPrefix: '[MWT]',
});

// ─── Tab definitions ─────────────────────────────────────────────────────────

const TABS = [
    { id: 'world-state', label: '🌍 World State', module: WorldState },
    { id: 'chronicle', label: '📜 Chronicle', module: Chronicle },
    { id: 'knowledge', label: '🧠 Knowledge', module: Knowledge },
    { id: 'story-planner', label: '🗺️ Story Planner', module: StoryPlanner },
    { id: 'settings', label: '⚙️ Settings', module: null },
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

            <div id="mwt-s-api-fields" style="grid-column:1/3;${apiFieldsStyle}" class="mwt-settings-grid">
                ${renderApiSettingsFields(s, GLOBAL_API_FIELD_IDS)}
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
            Control how each module's entries are injected into the prompt. Depth = how far back from the bottom; Role = which message role. (Knowledge uses SillyTavern's built-in lorebook system and does not use extension prompt injection. Disabling the Knowledge tracker below only stops it from scanning/updating; existing lorebook entries will continue to be injected by SillyTavern's World Info until you disable them manually in the World Info panel.)
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

            <label class="mwt-label" style="grid-column:1/3;font-weight:bold">🏷️ Structural Boundaries</label>
            <label class="mwt-label" style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="mwt-s-structural-boundaries" ${s.structuralBoundaries !== false ? 'checked' : ''}>
                <span>Wrap injected blocks in XML tags</span>
            </label>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin:0">
                Wraps each injected reference block (World State, Plot Seeds, Chronicle) in tags like <code><mwt_world_state>…</mwt_world_state></code>.
                Recommended for smaller / open models (24–70B) that bleed between sections. Frontier models don't need it; turn off to save a few tokens.
            </p>
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

            <label class="mwt-label">🗺️ Story Planner</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-story-planner" ${s.showFloatStoryPlanner !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label">⚙️ Settings</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-settings" ${s.showFloatSettings !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label">🎨 Style</label>
            <select id="mwt-s-button-style" class="mwt-input" style="width:auto">
                <option value="modern" ${(s.buttonStyle || 'modern') === 'modern' ? 'selected' : ''}>Modern (icons-only)</option>
                <option value="classic" ${s.buttonStyle === 'classic' ? 'selected' : ''}>Classic (text + icon)</option>
            </select>
        </div>

        <hr style="border-color:var(--mwt-border);margin:16px 0">
        <h3 style="margin-bottom:8px">🛑 Per-Tracker Enable</h3>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            Disable a tracker you don't use: it stops injecting and scanning, and its floating button shows a red ✕
            (right-click it again to re-enable). To remove a button entirely, uncheck its "Visible" box in the
            Floating Buttons section above. You can also disable <em>everything</em> at once by right-clicking the ⚙️ button.
        </p>
        <div class="mwt-settings-grid">
            <label class="mwt-label" style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="mwt-s-master-off" ${s.injectionMasterOff ? 'checked' : ''}>
                <span>Disable all trackers (panic switch)</span>
            </label>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Stops injection and scanning for every module. Useful for testing or branching a chat. **Lorebook entries need to be manually disabled**.</p>

            <label class="mwt-label">🌍 World State</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-world" ${s.enableWorldState !== false ? 'checked' : ''}> Use this tracker</label>

            <label class="mwt-label">📜 Chronicle</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-chronicle" ${s.enableChronicle !== false ? 'checked' : ''}> Use this tracker</label>

            <label class="mwt-label">🧠 Knowledge</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-knowledge" ${s.enableKnowledge !== false ? 'checked' : ''}> Use this tracker</label>

            <label class="mwt-label">🗺️ Story Planner</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-story-planner" ${s.enableStoryPlanner !== false ? 'checked' : ''}> Use this tracker</label>
        </div>

        <hr style="border-color:var(--mwt-border);margin:16px 0">
        <p style="color:var(--mwt-text-dim);font-size:12px">
            <strong>Module-specific settings</strong> are available in each tab's ⚙ Settings button.
            Use "Sync to Modules" above to push the global API URL/Key/Model to all modules at once.
        </p>
    `;
}

function buildTabContent(tab) {
    if (tab.id === 'settings') return renderSettingsTab();
    const renderFn = tab.module?.getModuleRender?.() || tab.module?.render;
    if (typeof renderFn === 'function') return renderFn();
    return '';
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
            const apiValues = readApiSettingsValues(modal, GLOBAL_API_FIELD_IDS);
            // Depth 0 ("inject at the very bottom") is a legitimate value, so
            // don't use `Number(...) || fallback` — that clobbers 0 to the fallback.
            const depthOr = (sel, fallback) => {
                const n = parseInt(modal.querySelector(sel)?.value, 10);
                return Number.isFinite(n) && n >= 0 ? n : fallback;
            };
            const patch = {
                ...apiValues,
                connectionProfileId: modal.querySelector('#mwt-s-connection-profile')?.value || '',
                // Per-module injection settings
                worldStateDepth: depthOr('#mwt-s-ws-depth', 4),
                worldStateRole: modal.querySelector('#mwt-s-ws-role')?.value || 'system',
                chronicleDepth: depthOr('#mwt-s-ch-depth', 4),
                chronicleRole: modal.querySelector('#mwt-s-ch-role')?.value || 'system',
                // Structural boundaries
                structuralBoundaries: modal.querySelector('#mwt-s-structural-boundaries')?.checked ?? true,
                // Button visibility
                showFloatWorld: modal.querySelector('#mwt-s-show-world')?.checked ?? true,
                showFloatChronicle: modal.querySelector('#mwt-s-show-chronicle')?.checked ?? true,
                showFloatKnowledge: modal.querySelector('#mwt-s-show-knowledge')?.checked ?? true,
                showFloatStoryPlanner: modal.querySelector('#mwt-s-show-story-planner')?.checked ?? true,
                showFloatSettings: modal.querySelector('#mwt-s-show-settings')?.checked ?? true,
                collapseFloatButtons: modal.querySelector('#mwt-s-collapse-float')?.checked ?? false,
                buttonStyle: modal.querySelector('#mwt-s-button-style')?.value || 'modern',
                // Per-tracker enable + master panic switch
                enableWorldState: modal.querySelector('#mwt-s-enable-world')?.checked ?? true,
                enableChronicle: modal.querySelector('#mwt-s-enable-chronicle')?.checked ?? true,
                enableKnowledge: modal.querySelector('#mwt-s-enable-knowledge')?.checked ?? true,
                enableStoryPlanner: modal.querySelector('#mwt-s-enable-story-planner')?.checked ?? true,
                injectionMasterOff: modal.querySelector('#mwt-s-master-off')?.checked ?? false,
            };
            // NOTE: enableX and showFloatX are deliberately decoupled. Toggling
            // "Use this tracker" here only flips enableX (button stays visible
            // with a red ✕), matching the right-click quick-toggle behavior.
            // The "Visible" checkboxes above are the sole control over presence.
            // This avoids the "button vanished after an unrelated save" surprise
            // that the previous one-way coupling created.

            saveSettings(patch);
            ui.applyButtonVisibility();
            ui.applyButtonStyle();
            ui.updateButtonStates();
            // Re-apply injections so the structural-boundaries toggle takes
            // effect immediately without requiring a new chat message.
            try {
                WorldState.applyWorldStateInjection?.();
                Chronicle.applyInjection?.();
                StoryPlanner.applyPlanInjection?.();
            } catch { /* modules may not be initialized yet */ }
            setStatus(modal, 'Settings saved.', 'success', 3000);
        });
    }

    // Wire sync-to-modules button
    const syncBtn = modal.querySelector('#mwt-s-sync');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => {
            const apiValues = readApiSettingsValues(modal, GLOBAL_API_FIELD_IDS);
            const patch = {
                connectionProfileId: modal.querySelector('#mwt-s-connection-profile')?.value || '',
                ...apiValues,
            };
            if (WorldState.syncGlobalSettings) WorldState.syncGlobalSettings(patch);
            if (Chronicle.syncGlobalSettings) Chronicle.syncGlobalSettings(patch);
            if (Knowledge.syncGlobalSettings) Knowledge.syncGlobalSettings(patch);
            if (StoryPlanner.syncGlobalSettings) StoryPlanner.syncGlobalSettings(patch);
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

// ─── Event hooks ─────────────────────────────────────────────────────────────

if (eventSource && event_types?.CHAT_CHANGED) {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('[MWT] Chat changed — resetting state.');
        WorldState.onChatChanged();
        Chronicle.onChatChanged();
        Knowledge.onChatChanged();
        StoryPlanner.onChatChanged();
    });
}

if (eventSource && event_types?.MESSAGE_RECEIVED) {
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        const s = getSettings();
        // Gate per-module: disabled trackers stop scanning / counting toward
        // auto-refresh & auto-snapshot thresholds (no silent background API calls).
        if (s.injectionMasterOff) return;
        if (s.enableWorldState !== false) WorldState.onMessageReceived();
        if (s.enableChronicle  !== false) Chronicle.onMessageReceived();
        if (s.enableKnowledge  !== false) Knowledge.onMessageReceived();
        if (s.enableStoryPlanner !== false) StoryPlanner.onMessageReceived();
    });
}

// Register generation lifecycle hooks — use every available event name for
// compatibility across SillyTavern versions.
function onAnyEvent(names, handler) {
    for (const name of names) {
        if (eventSource && event_types?.[name]) {
            eventSource.on(event_types[name], handler);
        }
    }
}

onAnyEvent(['GENERATION_STARTED'], () => Chronicle.onGenerationStarted());
onAnyEvent(['GENERATION_STOPPED', 'GENERATION_ENDED'], () => Chronicle.onGenerationStopped());

// ─── Swipe / edit / delete awareness (F2) ────────────────────────────────────
// Keep module counters and chronicle anchors in sync when the user mutates chat
// history, so tracking doesn't drift after edits/deletes/swipes.
//
// SillyTavern's event signatures vary across versions, so we normalize the
// argument to a chat-array index (number) before delegating to modules.

function extractMessageIndex(arg) {
    if (typeof arg === 'number') return arg;
    if (arg && typeof arg === 'object') {
        if (typeof arg.messageId === 'number') return arg.messageId;
        if (typeof arg.index === 'number') return arg.index;
    }
    return null;
}

if (eventSource && event_types?.MESSAGE_DELETED) {
    eventSource.on(event_types.MESSAGE_DELETED, (...args) => {
        const idx = extractMessageIndex(args[0]);
        console.log(`[MWT] MESSAGE_DELETED (index: ${idx}) — adjusting counters.`);
        const s = getSettings();
        if (s.injectionMasterOff) return;
        if (s.enableWorldState !== false) WorldState.onMessageDeleted(idx);
        if (s.enableChronicle  !== false) Chronicle.onMessageDeleted(idx);
        if (s.enableKnowledge  !== false) Knowledge.onMessageDeleted(idx);
        if (s.enableStoryPlanner !== false) StoryPlanner.onMessageDeleted(idx);
    });
}

if (eventSource && event_types?.MESSAGE_SWIPED) {
    eventSource.on(event_types.MESSAGE_SWIPED, (...args) => {
        const idx = extractMessageIndex(args[0]);
        console.log(`[MWT] MESSAGE_SWIPED (index: ${idx}) — checking anchor / scheduling refresh.`);
        const s = getSettings();
        if (s.injectionMasterOff) return;
        if (s.enableWorldState !== false) WorldState.onMessageSwiped(idx);
        if (s.enableChronicle  !== false) Chronicle.onMessageSwiped(idx);
    });
}

if (eventSource && event_types?.MESSAGE_EDITED) {
    eventSource.on(event_types.MESSAGE_EDITED, (...args) => {
        const idx = extractMessageIndex(args[0]);
        console.log(`[MWT] MESSAGE_EDITED (index: ${idx}) — checking anchor / scheduling refresh.`);
        const s = getSettings();
        if (s.injectionMasterOff) return;
        if (s.enableWorldState !== false) WorldState.onMessageEdited(idx);
        if (s.enableChronicle  !== false) Chronicle.onMessageEdited(idx);
    });
}

// ─── Floating button bar, drawer, wand menu (via core/ui.js) ────────────────

const ui = createFloatingButtonBar({
    getSettings,
    saveSettings,
    openModal: openMwtModal,
    modules: { WorldState, Chronicle, Knowledge, StoryPlanner },
});

// ─── Slash commands & macros (via core/commands.js) ──────────────────────────

const commands = createCommands({
    registerSlashCommand,
    macroRegistry,
    modules: { WorldState, Chronicle, Knowledge, StoryPlanner },
});

// ─── Initialize ──────────────────────────────────────────────────────────────

ui.setupButtonBar();
ui.applyButtonStyle();
ui.updateButtonStates(); // show disabled/red-X state immediately on load
ui.setupExtensionsDrawer();
ui.setupWandMenu();
commands.setupSlashCommands();
commands.setupMacros();

// Start module runtime (injection, auto-save timers, notification panels).
// Modules are re-initialized with a modal reference when the user opens the
// MWT modal for the first time.
WorldState.init(null);
Chronicle.init(null);
Knowledge.init(null);
StoryPlanner.init(null);

// Periodically update floating button token counts and auto-refresh countdown
setInterval(ui.updateFloatTokenCounts, 5000);
setTimeout(ui.updateFloatTokenCounts, 2000);

// Listen for busy-state changes from any module (decoupled via CustomEvent)
document.addEventListener('mwt:busy-changed', ui.updateButtonStates);

console.log('[MWT] Merged World Tracker extension loaded.');