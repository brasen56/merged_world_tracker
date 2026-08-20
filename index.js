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
import { bumpEpoch } from './core/scope.js';
import { createSettingsManager } from './core/settings.js';
import { createModal, showModal, setStatus } from './core/modal.js';
import { createFloatingButtonBar, renderApiSettingsFields, readApiSettingsValues } from './core/ui.js';
import { createCommands } from './core/commands.js';
import { routeMessageReceived, routeMessageDeleted, routeMessageSwiped, routeMessageEdited, extractMessageIndex } from './core/event_router.js';
// Diagnostics accessors (Phases 0–1). Read-only peek at the in-memory capture,
// exposed to testers as window.MWT.diagnostics near the bottom of this file.
// Imported directly (not via the core/index.js barrel) so the namespace reads
// the real singleton regardless of the test-only barrel→stub alias.
import { getEvents, getApiCalls, getLastApiCall, getAllLastApiCalls, getAllLastRuns, getInjectedSnapshot, getAllInjectedSnapshots, clearEvents, clearApiCalls, clearLastRuns, clearInjections } from './core/diagnostics.js';
// Diagnostics Phase 6 — Tab 1 Health: the snapshot collector behind the ❤️
// Health sub-tab (one row per module: enabled · gate · busy · tokens · auto ·
// last run). Same direct-import rule as above.
import { collectHealthSnapshot } from './diagnostics_panel/health.js';
// Diagnostics Phase 7 — Tab 2 Environment (fork-compat probe): the snapshot
// collector + shared.js loader behind the 🌐 Environment sub-tab (versions,
// feature detection, and the getCurrentChatId() premise behind core/scope.js,
// validated live on the running build). Same direct-import rule as above.
import { collectEnvironmentSnapshot, loadSharedModule } from './diagnostics_panel/environment.js';
import { collectScopeSnapshot } from './diagnostics_panel/scope_storage.js';
// Diagnostics Phase 9 — Tab 4 Injection: the snapshot collector behind the 💉
// Injection sub-tab (per module: on/off · gate · role/depth with provenance ·
// token estimate · the Phase 2 recorded payload). Same direct-import rule.
import { collectInjectionSnapshot, redactInjectionSnapshot, formatInjectionAge, ROLE_NUMBERS } from './diagnostics_panel/injection.js';
// Phase 4 (settings provenance, design §I.4.6): the two resolvers that can
// attribute a behavior setting to its precedence level, plus their key lists
// (single source of truth — no second key list here). Direct imports for the
// same singleton rule as above.
import { getEffectiveWorldSetting, GLOBAL_SETTING_KEYS as WS_GLOBAL_SETTING_KEYS } from './world_state/data.js';
import { getEffectivePlanSetting, GLOBAL_SETTING_KEYS as SP_GLOBAL_SETTING_KEYS } from './story_planner/data.js';

// ─── Feature module imports ─────────────────────────────────────────────────

import * as WorldState from './world_state/index.js';
import * as Chronicle from './chronicle/index.js';
import * as Knowledge from './knowledge/index.js';
import * as StoryPlanner from './story_planner/index.js';
import * as Interiority from './interiority/index.js';
import { exportBackup, previewRestore, restoreBackup, undoLastRestore, fingerprintPreview } from './backup/index.js';
import { renderBackupPanel, wireBackupEvents } from './backup/render.js';
// Diagnostics panel shell (Phase 5): the 🩺 tab inside this modal, its redaction
// layer (core/redaction.js), and the D1 copy-report shape.
import { renderDiagnosticsPanel, wireDiagnosticsPanel } from './diagnostics_panel/render.js';

// ─── Constants ───────────────────────────────────────────────────────────────

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

// Fallback: the Aikobots v4 fork (and some older ST versions) don't have
// scripts/macros/macro-system.js. They expose the legacy MacrosParser in
// scripts/macros.js with a different API: registerMacro(key, fn, description)
// instead of registerMacro(key, { handler, category, description }). Build a
// compatibility wrapper so commands.js can use the modern spec format on both.
if (!macroRegistry) {
    try {
        const macrosModule = await import('../../../../scripts/macros.js');
        if (macrosModule?.MacrosParser && typeof macrosModule.MacrosParser.registerMacro === 'function') {
            const legacyParser = macrosModule.MacrosParser;
            macroRegistry = {
                registerMacro: (key, spec) => {
                    // Accept both the modern spec object { handler, description }
                    // and the legacy bare-function form (key, fn, description).
                    const fn = typeof spec === 'function' ? spec : (spec?.handler || (() => ''));
                    const desc = (typeof spec === 'object' && spec?.description) ? spec.description : '';
                    return legacyParser.registerMacro(key, fn, desc);
                },
            };
            console.log('[MWT] Using legacy MacrosParser fallback for macro registration.');
        }
    } catch { /* scripts/macros.js not available either */ }
}

// ─── Shared settings ────────────────────────────────────────────────────────

const { getSettings, saveSettings } = createSettingsManager({
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
        // Newest messages to defer from ordinary tracker history scans. The
        // current user/assistant exchange can still be swiped or discarded.
        recentHistoryExclude: 2,
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
        showFloatInteriority: true,
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
        enableInteriority: true,
        // Interiority injection depth/role (same neighborhood as world state)
        interiorityDepth: 1,
        interiorityRole: 'system',
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
    { id: 'interiority', label: '💭 Interiority', module: Interiority },
    // Diagnostics Phase 5: the panel shell (7 placeholder sub-tabs + content
    // opt-in + Copy Report). Read-only; rendered/wired by
    // diagnostics_panel/render.js, not by a feature module.
    { id: 'diagnostics', label: '🩺 Diagnostics', module: null },
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
        <h3 style="margin-bottom:8px">🕒 Stable History</h3>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            Defer the newest chat messages from World State, Chronicle, Knowledge, Relationships, Growth, and Story Planner scans. They are included on a later refresh instead of discarded. <strong>2</strong> usually means the latest user/assistant exchange. Interiority is intentionally excluded because it evaluates the current turn.
        </p>
        <div class="mwt-settings-grid">
            <label class="mwt-label" for="mwt-s-recent-history-exclude">Messages to defer</label>
            <input id="mwt-s-recent-history-exclude" class="mwt-input" type="number" value="${s.recentHistoryExclude ?? 2}" min="0" max="10" step="1">
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

            <label class="mwt-label" style="grid-column:1/3;font-weight:bold">💭 Interiority</label>
            <label class="mwt-label">Depth</label>
            <input id="mwt-s-int-depth" class="mwt-input" type="number" value="${s.interiorityDepth ?? 1}" min="0" max="999">
            <label class="mwt-label">Role</label>
            <select id="mwt-s-int-role" class="mwt-input">
                <option value="system" ${s.interiorityRole === 'system' ? 'selected' : ''}>system</option>
                <option value="user" ${s.interiorityRole === 'user' ? 'selected' : ''}>user</option>
                <option value="assistant" ${s.interiorityRole === 'assistant' ? 'selected' : ''}>assistant</option>
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

            <label class="mwt-label">💭 Interiority</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-interiority" ${s.showFloatInteriority !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label">⚙️ Settings</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-settings" ${s.showFloatSettings !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label">🎨 Style</label>
            <select id="mwt-s-button-style" class="mwt-input" style="width:auto">
                <option value="modern" ${(s.buttonStyle || 'modern') === 'modern' ? 'selected' : ''}>Modern (icons-only)</option>
                <option value="classic" ${s.buttonStyle === 'classic' ? 'selected' : ''}>Classic (text + icon)</option>
            </select>

            <div></div>
            <div>
                <button id="mwt-s-reset-float-positions" class="mwt-btn" title="Restore all floating buttons to their default positions">↩ Reset Button Positions</button>
                <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Dragged buttons return to the default right-edge stack. You can also use the <code>/wt-reset-buttons</code> slash command.</p>
            </div>
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

            <label class="mwt-label">💭 Interiority</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-interiority" ${s.enableInteriority !== false ? 'checked' : ''}> Use this tracker</label>
        </div>

        <hr style="border-color:var(--mwt-border);margin:16px 0">
        <p style="color:var(--mwt-text-dim);font-size:12px">
            <strong>Module-specific settings</strong> are available in each tab's ⚙ Settings button.
            Use "Sync to Modules" above to push the global API URL/Key/Model to all modules at once.
        </p>
        ${renderBackupPanel()}
    `;
}

function buildTabContent(tab) {
    if (tab.id === 'settings') return renderSettingsTab();
    // Diagnostics Phase 5 — the panel shell (placeholders for tabs 1–7).
    if (tab.id === 'diagnostics') return renderDiagnosticsPanel();
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

    // Wire the Backup/Restore control (lives in the Settings tab). The body is
    // rebuilt on every open, so rebind each render like the module wire-events.
    wireBackupEvents(modal);

    // Wire the Diagnostics panel shell (lives in the 🩺 Diagnostics tab).
    // Same rebind-every-render rule as the backup control above.
    wireDiagnosticsPanel(modal);

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
            const rawRecentHistoryExclude = Number(modal.querySelector('#mwt-s-recent-history-exclude')?.value);
            const recentHistoryExclude = Number.isFinite(rawRecentHistoryExclude)
                ? Math.min(10, Math.max(0, Math.round(rawRecentHistoryExclude)))
                : 2;
            const patch = {
                ...apiValues,
                connectionProfileId: modal.querySelector('#mwt-s-connection-profile')?.value || '',
                recentHistoryExclude,
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
                showFloatInteriority: modal.querySelector('#mwt-s-show-interiority')?.checked ?? true,
                showFloatSettings: modal.querySelector('#mwt-s-show-settings')?.checked ?? true,
                collapseFloatButtons: modal.querySelector('#mwt-s-collapse-float')?.checked ?? false,
                buttonStyle: modal.querySelector('#mwt-s-button-style')?.value || 'modern',
                // Per-tracker enable + master panic switch
                enableWorldState: modal.querySelector('#mwt-s-enable-world')?.checked ?? true,
                enableChronicle: modal.querySelector('#mwt-s-enable-chronicle')?.checked ?? true,
                enableKnowledge: modal.querySelector('#mwt-s-enable-knowledge')?.checked ?? true,
                enableStoryPlanner: modal.querySelector('#mwt-s-enable-story-planner')?.checked ?? true,
                enableInteriority: modal.querySelector('#mwt-s-enable-interiority')?.checked ?? true,
                interiorityDepth: depthOr('#mwt-s-int-depth', 1),
                interiorityRole: modal.querySelector('#mwt-s-int-role')?.value || 'system',
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
                Interiority.applyIntentionsInjection?.();
            } catch { /* modules may not be initialized yet */ }
            setStatus(modal, 'Settings saved.', 'success', 3000);
        });
    }

    // Wire reset-floating-button-positions button
    const resetBtn = modal.querySelector('#mwt-s-reset-float-positions');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            ui.resetFloatPositions();
            setStatus(modal, 'Floating buttons reset to default positions.', 'success', 3000);
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
            if (Interiority.syncGlobalSettings) Interiority.syncGlobalSettings(patch);
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

// ─── Shared module registry (used by the message-event routers below) ───────

const modules = { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority };

// ─── Event hooks ─────────────────────────────────────────────────────────────

if (eventSource && event_types?.CHAT_CHANGED) {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        bumpEpoch(); // Tier 0.2 — invalidate all in-flight scope tokens BEFORE module handlers
        console.log('[MWT] Chat changed — resetting state.');
        const activeTab = modal?.querySelector('.mwt-tab-btn.active')?.dataset.tab;
        WorldState.onChatChanged();
        Chronicle.onChatChanged();
        Knowledge.onChatChanged();
        StoryPlanner.onChatChanged();
        Interiority.onChatChanged();
        if (modal?.style.display === 'flex') {
            renderModal();
            if (activeTab) modal.querySelector(`.mwt-tab-btn[data-tab="${activeTab}"]`)?.click();
        }
    });
}

if (eventSource && event_types?.MESSAGE_RECEIVED) {
    eventSource.on(event_types.MESSAGE_RECEIVED, (...args) => {
        routeMessageReceived(modules, getSettings(), extractMessageIndex(args[0]));
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
// argument to a chat-array index (number) before delegating to modules. The
// normalization + per-module dispatch lives in core/event_router.js.

if (eventSource && event_types?.MESSAGE_DELETED) {
    eventSource.on(event_types.MESSAGE_DELETED, (...args) => {
        const idx = extractMessageIndex(args[0]);
        console.log(`[MWT] MESSAGE_DELETED (index: ${idx}) — routing to modules.`);
        routeMessageDeleted(modules, getSettings(), idx);
    });
}

if (eventSource && event_types?.MESSAGE_SWIPED) {
    eventSource.on(event_types.MESSAGE_SWIPED, (...args) => {
        const idx = extractMessageIndex(args[0]);
        console.log(`[MWT] MESSAGE_SWIPED (index: ${idx}) — checking anchor / scheduling refresh.`);
        routeMessageSwiped(modules, getSettings(), idx);
    });
}

// ─── Sparse-chat: MORE_MESSAGES_LOADED (Aikobots v4 fork) ─────────────────────
// When older chat ranges are hydrated, re-render thought blocks for newly
// visible messages and retry deferred key migration. On upstream ST this event
// doesn't exist, so the guard skips silently.

if (eventSource && event_types?.MORE_MESSAGES_LOADED) {
    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
        console.log('[MWT] MORE_MESSAGES_LOADED — re-rendering interiority thought blocks.');
        Interiority.onMoreMessagesLoaded?.();
    });
}

if (eventSource && event_types?.MESSAGE_EDITED) {
    eventSource.on(event_types.MESSAGE_EDITED, (...args) => {
        const idx = extractMessageIndex(args[0]);
        console.log(`[MWT] MESSAGE_EDITED (index: ${idx}) — checking anchor / scheduling refresh.`);
        routeMessageEdited(modules, getSettings(), idx);
    });
}

// ─── Interiority custom event listeners ──────────────────────────────────────
// The render.js "Generate Now" button dispatches these custom events.

document.addEventListener('mwt:interiority-generate', () => {
    Interiority.triggerGenerate?.();
});

document.addEventListener('mwt:interiority-ledger-changed', () => {
    Interiority.applyIntentionsInjection?.();
});

// ─── Floating button bar, drawer, wand menu (via core/ui.js) ────────────────

const ui = createFloatingButtonBar({
    getSettings,
    saveSettings,
    openModal: openMwtModal,
    modules,
});

// ─── Slash commands & macros (via core/commands.js) ──────────────────────────

const commands = createCommands({
    registerSlashCommand,
    macroRegistry,
    modules,
    resetFloatPositions: ui.resetFloatPositions,
    saveSettings,
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
Interiority.init(null);

// Periodically update floating button token counts and auto-refresh countdown
setInterval(ui.updateFloatTokenCounts, 5000);
setTimeout(ui.updateFloatTokenCounts, 2000);

// Listen for busy-state changes from any module (decoupled via CustomEvent)
document.addEventListener('mwt:busy-changed', ui.updateButtonStates);

// ─── Console debugging API ───────────────────────────────────────────────────
//
// Expose a small, stable API on `window.MWT` so users (and developers) can
// inspect and reset growth evidence from the browser console without digging
// through chat metadata by hand. The evidence store lives in
// chat_metadata.knowledge_growth_evidence, keyed by NPC name.
//
// Usage examples:
//   MWT.evidence.list()                  // list NPCs with evidence + counts
//   MWT.evidence.clear('Kira')           // wipe one NPC's evidence (start over)
//   MWT.evidence.clearAll(true)          // wipe ALL NPCs' evidence in this chat
//   MWT.evidence.summary('Kira')         // show tiers + last-profile time
//   MWT.evidence.inspect('Kira')         // dump the full evidence file object
//   MWT.scope.diagnose()                 // which books this chat resolves to, and why
//   MWT.scope.bindings()                 // every saved character/chat → lorebook binding
//   MWT.scope.reload()                   // flush + re-hydrate the registry stores
//
// NOTE ON CLEARING: evidence is the ROOT, a generated profile is a LEAF. Clearing
// evidence does NOT delete the NPC's entry in the "NPC Profiles" lorebook, which
// would leave a profile with nothing backing it — the unfalsifiable state this
// feature exists to prevent. Both clear operations warn when that applies.
try {
    const evidenceApi = await import('./knowledge/evidence.js');
    const registryApi = await import('./knowledge/registry.js');
    const scopeApi = await import('./knowledge/scope.js');
    const storeApi = await import('./knowledge/store.js');
    const ktSettingsApi = await import('./knowledge/settings.js');

    /**
     * Warn when cleared NPCs still have a profile entry in the NPC Profiles
     * lorebook — it is now unbacked by any evidence.
     */
    const warnOrphanedProfiles = (names) => {
        const orphaned = names.filter(n => {
            try { return registryApi.getProfileUid(n) !== null; } catch { return false; }
        });
        if (orphaned.length === 0) return;
        console.warn(
            `[MWT] ⚠ ${orphaned.length} generated profile(s) are now UNBACKED by evidence: ` +
            `${orphaned.join(', ')}.\n` +
            `Their entries still exist in the "NPC Profiles" lorebook but nothing supports them ` +
            `anymore. Re-capture and regenerate, or delete those entries manually.`
        );
    };

    window.MWT = window.MWT || {};
    window.MWT.evidence = {
        list: () => {
            const map = evidenceApi.getEvidenceMap();
            const out = [];
            for (const [name, file] of Object.entries(map)) {
                out.push({
                    npc: name,
                    raw: (file.raw || []).length,
                    consolidated: (file.consolidated || []).length,
                    archivedRaw: (file.archivedRaw || []).length,
                    overrides: (file.userOverrides || []).length,
                    lastProfileAt: file.meta?.lastProfileAt || null,
                });
            }
            console.table(out);
            return out;
        },
        summary: (name) => {
            const s = evidenceApi.getEvidenceSummary(name);
            console.log('Evidence summary for', name, ':', s);
            return s;
        },
        inspect: (name) => {
            const file = evidenceApi.getEvidenceFile(name, false);
            if (!file) { console.log(`No evidence file for "${name}".`); return; }
            console.log(`Evidence file for "${name}":`, file);
            return file;
        },
        clear: (name) => {
            const ok = evidenceApi.clearEvidence(name);
            if (!ok) { console.log(`No evidence file found for "${name}".`); return false; }
            console.log(`Cleared all evidence for "${name}". The NPC remains enrolled in continuous capture.`);
            warnOrphanedProfiles([name]);
            return true;
        },
        clearAll: (confirm) => {
            // Guarded: this wipes every NPC's evidence for the chat, including the
            // archivedRaw audit trail. Rebuilding it means re-running capture over
            // the whole history — real API cost — so a bare clearAll() (or a typo
            // where clear('Name') was meant) must not be destructive.
            if (confirm !== true) {
                const names = Object.keys(evidenceApi.getEvidenceMap());
                console.warn(
                    `[MWT] clearAll() would wipe evidence for ${names.length} NPC(s) in THIS chat: ` +
                    `${names.join(', ') || '(none)'}.\n` +
                    `This cannot be undone and re-capturing costs API calls. ` +
                    `Call MWT.evidence.clearAll(true) to confirm, or MWT.evidence.clear('Name') for one NPC.`
                );
                return 0;
            }
            const names = Object.keys(evidenceApi.getEvidenceMap());
            const count = evidenceApi.clearAllEvidence();
            console.log(count > 0 ? `Cleared evidence for ${count} NPC(s) in this chat.` : 'No evidence found to clear.');
            if (count > 0) warnOrphanedProfiles(names);
            return count;
        },
    };

    // ── Profile entry audit (NPC Profiles lorebook ↔ registry consistency) ──
    //
    // A lost `profileUid` pointer makes the next save create a SECOND lorebook
    // entry for the same NPC instead of overwriting. The pointer loss is fixed
    // going forward (immediate flush + loud setProfileUid), but chats that
    // already accumulated duplicates need a way to see and prune them.
    const profileLorebookApi = await import('./knowledge/lorebook.js');

    /** Group profile entries by NPC name and mark which uid the registry points at. */
    const auditProfiles = async () => {
        const entries = await profileLorebookApi.listProfileEntries();
        const groups = new Map();
        for (const e of entries) {
            const key = e.name.toLowerCase().trim() || '(unnamed)';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(e);
        }
        const rows = [];
        for (const [, list] of groups) {
            const referenced = registryApi.getProfileUid(list[0].name);
            for (const e of list) {
                rows.push({
                    npc: e.name,
                    uid: e.uid,
                    referenced: e.uid === referenced,
                    duplicate: list.length > 1,
                    chars: e.chars,
                    preview: e.preview,
                });
            }
        }
        return rows;
    };

    // ── Lorebook scope diagnostics ──────────────────────────────────────────
    //
    // The scope resolver reads SillyTavern context fields whose names vary
    // across ST versions and forks. Every read is defensive and falls back to
    // the global lorebooks, which is safe but SILENT — so this exists to make
    // the fallback visible. `MWT.scope.diagnose()` reports which fields the
    // running build actually exposes, what identity they resolve to, and which
    // books that produces. Run it first whenever scoping misbehaves.
    window.MWT.scope = {
        diagnose: () => {
            const ctx = (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function')
                ? SillyTavern.getContext() : null;
            if (!ctx) { console.error('[MWT] No SillyTavern context available.'); return null; }

            const card = (Array.isArray(ctx.characters) && ctx.characterId !== null && ctx.characterId !== undefined)
                ? ctx.characters[ctx.characterId] : null;

            let currentChatId = '(not a function)';
            if (typeof ctx.getCurrentChatId === 'function') {
                try { currentChatId = String(ctx.getCurrentChatId()); }
                catch (err) { currentChatId = `(threw: ${err?.message})`; }
            }

            console.log('[MWT] Context fields the scope resolver reads:');
            console.table({
                'characterId': ctx.characterId ?? '(absent)',
                'characters is array': Array.isArray(ctx.characters),
                'characters[characterId]': card ? 'resolved' : '(not resolved)',
                '  card.avatar': card?.avatar || '(absent)',
                '  card.name': card?.name || '(absent)',
                'name1 (user)': ctx.name1 || '(absent)',
                'name2 (char)': ctx.name2 || '(absent)',
                'groupId': ctx.groupId ?? '(absent)',
                'groups is array': Array.isArray(ctx.groups),
                'getCurrentChatId()': currentChatId,
                'chatId': ctx.chatId ?? '(absent)',
            });

            const charIdentity = scopeApi.getCharacterIdentity();
            const chatIdentity = scopeApi.getChatIdentity();
            const scope = ktSettingsApi.getSettings().scope || 'global';
            const books = scopeApi.resolveBookNames();

            console.log('[MWT] Resolution:');
            console.table({
                'scope setting': scope,
                'character identity': charIdentity
                    ? `${charIdentity.key} → "${charIdentity.name}"${charIdentity.isGroup ? ' (group)' : ''}`
                    : '(unresolved)',
                'chat identity': chatIdentity ? chatIdentity.key : '(unresolved)',
                'Knowledge book': books.knowledge,
                'State book': books.state,
                'Profiles book': books.profiles,
                'Knowledge store loaded': storeApi.isHydrated(books.knowledge),
                'State store loaded': storeApi.isHydrated(books.state),
            });

            const usedIdentity = scope === 'chat' ? chatIdentity : charIdentity;
            if (scope !== 'global' && !usedIdentity) {
                console.warn(
                    `[MWT] ⚠ scope is "${scope}" but the current ${scope} could not be identified, ` +
                    `so this is silently using the GLOBAL lorebooks. The field table above shows ` +
                    `which lookup came back absent.`
                );
            }
            if (!storeApi.isHydrated(books.knowledge)) {
                console.warn(
                    '[MWT] ⚠ The Knowledge store is not loaded, so creating entries is blocked ' +
                    '(this is deliberate — it prevents duplicate entries). Switch chats to retry, ' +
                    'or look for an earlier store error above.'
                );
            }
            return { scope, books, charIdentity, chatIdentity };
        },
        bindings: () => {
            const saved = ktSettingsApi.getSettings().bookBindings || {};
            const rows = Object.entries(saved).map(([key, v]) => ({
                key, knowledge: v?.knowledge, state: v?.state, profiles: v?.profiles,
            }));
            if (rows.length === 0) { console.log('[MWT] No lorebook bindings saved yet.'); return []; }
            console.table(rows);
            console.log('[MWT] "key" is the stable identity (avatar filename), which is why renaming a card keeps its books.');
            return rows;
        },
        reload: async () => {
            const knowledgeApi = await import('./knowledge/index.js');
            await knowledgeApi.reloadStores();
            console.log('[MWT] Stores flushed and reloaded.');
            return scopeApi.resolveBookNames();
        },
    };

    window.MWT.profiles = {
        list: async () => {
            const rows = await auditProfiles();
            if (rows.length === 0) { console.log('[MWT] No entries in the "NPC Profiles" lorebook.'); return []; }
            console.table(rows);
            return rows;
        },
        duplicates: async () => {
            const rows = (await auditProfiles()).filter(r => r.duplicate);
            if (rows.length === 0) { console.log('[MWT] No duplicate profile entries found.'); return []; }
            console.table(rows);
            console.log(
                '[MWT] "referenced: true" is the entry the registry points at — that one is live. ' +
                'The rest are orphans from lost pointers. MWT.profiles.pruneDuplicates() previews a cleanup.'
            );
            return rows;
        },
        pruneDuplicates: async (confirm) => {
            const rows = await auditProfiles();
            const byNpc = new Map();
            for (const r of rows) {
                const key = r.npc.toLowerCase().trim();
                if (!byNpc.has(key)) byNpc.set(key, []);
                byNpc.get(key).push(r);
            }

            // Per NPC: keep the registry-referenced entry; if none is referenced,
            // keep the LARGEST (a truncated/failed generation is the likelier
            // orphan) and break ties on the highest uid (most recent). Never
            // auto-delete when nothing is referenced AND sizes tie — that case
            // needs eyes, not a heuristic.
            const toDelete = [];
            const needsReview = [];
            for (const [key, list] of byNpc) {
                if (list.length < 2) continue;
                // Entries with no comment/name all collapse into one bucket, so
                // they are not necessarily the same NPC — pruning across them
                // could delete a different character's profile. Never automate.
                if (key === '(unnamed)') {
                    console.warn(
                        `[MWT] ${list.length} profile entries have no NPC name (uids ` +
                        `${list.map(r => r.uid).join(', ')}). They cannot be grouped reliably — ` +
                        `skipped. Inspect with MWT.profiles.list() and handle by hand.`
                    );
                    continue;
                }
                const referenced = list.find(r => r.referenced);
                let keep = referenced;
                if (!keep) {
                    const sorted = [...list].sort((a, b) => b.chars - a.chars || b.uid - a.uid);
                    if (sorted[0].chars === sorted[1].chars) { needsReview.push(list); continue; }
                    keep = sorted[0];
                }
                for (const r of list) if (r.uid !== keep.uid) toDelete.push({ ...r, keptUid: keep.uid });
            }

            for (const list of needsReview) {
                console.warn(
                    `[MWT] "${list[0].npc}" has ${list.length} entries, none referenced by the registry ` +
                    `and identical in size (uids ${list.map(r => r.uid).join(', ')}). Skipped — ` +
                    `inspect them and delete by hand.`
                );
            }
            if (toDelete.length === 0) { console.log('[MWT] Nothing to prune.'); return []; }

            if (confirm !== true) {
                console.table(toDelete.map(r => ({ npc: r.npc, deleteUid: r.uid, keepUid: r.keptUid, chars: r.chars, preview: r.preview })));
                console.warn(
                    `[MWT] DRY RUN — nothing deleted. The ${toDelete.length} entr${toDelete.length === 1 ? 'y' : 'ies'} above ` +
                    `would be removed from the "NPC Profiles" lorebook. Review the previews first: ` +
                    `profiles are regeneratable from evidence, but only if the evidence is still there. ` +
                    `Call MWT.profiles.pruneDuplicates(true) to actually delete.`
                );
                return toDelete;
            }

            const result = await profileLorebookApi.deleteProfileEntries(toDelete.map(r => r.uid));
            if (!result.success) { console.error('[MWT] Prune failed:', result.error); return []; }
            console.log(`[MWT] Deleted ${result.deleted.length} duplicate profile entr${result.deleted.length === 1 ? 'y' : 'ies'}: uids ${result.deleted.join(', ')}.`);
            return result.deleted;
        },
        relink: async (confirm) => {
            // Recovery for pointers lost BEFORE saves became durable: the
            // profile entry sits in the "NPC Profiles" lorebook while the
            // registry has no profileUid for it, so the profile reads as
            // "never generated" everywhere — the growth modal shows an empty
            // box, and Interiority's "Profiled NPCs only" filters the NPC out.
            // Nothing regenerates it, because the evidence is intact and the
            // lorebook entry is right there; only the pointer is missing.
            const reg = registryApi.getRegistry();
            if (Object.keys(reg).length === 0) {
                console.warn(
                    '[MWT] The NPC registry is empty for this scope — nothing to relink against. ' +
                    'Run MWT.scope.diagnose() to check which books this chat resolves to.'
                );
                return [];
            }

            const grouped = new Map();
            for (const e of await profileLorebookApi.listProfileEntries()) {
                const key = e.name.toLowerCase().trim();
                if (!key) continue; // unnamed entries can't be matched to an NPC
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key).push(e);
            }

            const planned = [];
            for (const [, list] of grouped) {
                const npc = list[0].name;
                const regKey = registryApi.resolveRegistryKey(reg, npc);
                if (regKey == null) {
                    console.warn(
                        `[MWT] Profile entry "${npc}" has no matching NPC registry entry — skipped. ` +
                        `Scan that NPC into the Knowledge book first, then re-run.`
                    );
                    continue;
                }
                const current = reg[regKey]?.profileUid;
                // Already pointing at an entry that really exists: leave it be.
                if (current != null && list.some(e => e.uid === current)) continue;
                // Largest first, newest to break ties — same heuristic as
                // pruneDuplicates, for the same reason: a truncated generation
                // is the likelier orphan.
                const pick = [...list].sort((a, b) => b.chars - a.chars || b.uid - a.uid)[0];
                planned.push({
                    npc, registryKey: regKey, linkUid: pick.uid, chars: pick.chars,
                    was: current == null ? '(none)' : `${current} (dangling)`,
                    otherCandidates: list.length - 1,
                });
            }

            if (planned.length === 0) {
                console.log('[MWT] Every named profile entry is already linked to its registry entry.');
                return [];
            }
            if (confirm !== true) {
                console.table(planned);
                console.warn(
                    `[MWT] DRY RUN — nothing written. The ${planned.length} link(s) above would be recorded ` +
                    `in the NPC registry. Check "otherCandidates" is 0: anything higher means duplicates ` +
                    `exist and MWT.profiles.duplicates() is worth a look first. ` +
                    `Call MWT.profiles.relink(true) to apply.`
                );
                return planned;
            }

            const applied = planned.filter(p => registryApi.setProfileUid(p.npc, p.linkUid));
            await storeApi.flushBook(scopeApi.getLorebookName());
            console.log(
                `[MWT] Relinked ${applied.length} profile(s): ` +
                `${applied.map(p => `${p.npc} → uid ${p.linkUid}`).join(', ')}.`
            );
            return applied;
        },
    };

    // ── Knowledge Tracker duplicate audit (registry alias identities) ──────
    //
    // The knowledge scan/import/staging paths used to accept the model's
    // spelling verbatim, so one NPC could accumulate several registry
    // identities ("Sophie" and "Sophie Simpson"), each with its own lorebook
    // entry. Those paths now canonicalize through resolveRegistryKey, which
    // stops NEW duplicates — but existing ones are deliberately NOT auto-
    // merged: entries under alias spellings may contain different facts, so
    // which copy is authoritative is a human decision. This audit is
    // READ-ONLY; it reports and explains, it never mutates.
    window.MWT.npcs = {
        auditDuplicates: async () => {
            const reg = registryApi.getRegistry();
            // An EMPTY registry is the most important case to audit, not a
            // reason to stop: an empty (or wiped) registry over a populated
            // book is exactly the state that makes every scan re-propose every
            // NPC as new. Warn, then fall through to the physical sweep below,
            // which will report each entry as untracked.
            if (Object.keys(reg).length === 0) {
                console.warn(
                    '[MWT] The NPC registry is empty for this scope. If the book below holds entries, ' +
                    'the registry has lost its pointers — "From Lorebooks" will re-adopt them. ' +
                    'Run MWT.scope.diagnose() to confirm which books this chat resolves to.'
                );
            }

            const rows = [];

            // 1) Registry identities that alias each other, or collide.
            for (const group of registryApi.auditRegistryAliases(reg)) {
                for (const e of group.entries) {
                    rows.push({
                        kind: group.kind === 'ambiguous' ? 'ambiguous-name' : 'registry-alias',
                        npc: e.name,
                        uid: e.uid,
                        type: e.type,
                        detail: group.kind === 'ambiguous'
                            ? `shorthand collision: ${group.names.join(' / ')} — NOT proven to be one NPC`
                            : `aliases: ${group.names.join(' / ')}`,
                    });
                }
            }

            // 2) Physical lorebook entries whose label is NOT the entry their
            //    canonical registry identity points at — the visible half of a
            //    duplicate (or an entry the registry never tracked at all).
            for (const e of await profileLorebookApi.listKnowledgeEntries()) {
                const canon = registryApi.resolveRegistryKey(reg, e.name);
                if (canon == null) {
                    rows.push({
                        kind: 'untracked-entry',
                        npc: e.name || '(unlabelled)',
                        uid: e.uid,
                        type: '—',
                        detail: `in book, no registry record (${e.chars} chars: "${e.preview}")`,
                    });
                    continue;
                }
                const regUid = reg[canon]?.uid;
                if (regUid !== e.uid) {
                    rows.push({
                        kind: 'entry-not-linked',
                        npc: e.name,
                        uid: e.uid,
                        type: reg[canon]?.type ?? '—',
                        detail: `canonical identity "${canon}" points at uid ${regUid ?? '(none)'} (${e.chars} chars: "${e.preview}")`,
                    });
                }
            }

            if (rows.length === 0) {
                console.log('[MWT] No duplicate NPC identities found in the registry or lorebook.');
                return [];
            }
            console.table(rows);
            console.log(
                '[MWT] READ-ONLY audit — nothing was merged or deleted.\n' +
                '• registry-alias: one NPC under several registry identities; each row is a separate lorebook entry that may hold different facts.\n' +
                '• ambiguous-name: a short name (e.g. "Mara") that could belong to two different full names. These are NOT proven to be the same character — do not merge them. Rename the short record to the full name it belongs to.\n' +
                '• entry-not-linked: a physical entry whose label aliases a tracked NPC but is not the entry the registry points at.\n' +
                '• untracked-entry: an entry no registry record owns (the "From Lorebooks" import would adopt it).\n' +
                '\nCLEANUP — two different operations, do not confuse them:\n' +
                '1. Delete the redundant LOREBOOK ENTRY in SillyTavern\'s World Info editor, by its uid above. ' +
                'This is what actually removes the duplicate text from your prompts.\n' +
                '2. The ✕ button in the MWT NPC list does NOT do that. It deletes the registry record, ' +
                'relationships, stance and evidence for that name, and deliberately leaves the lorebook entry in place.\n' +
                'So: merge the facts you want into the entry you are keeping, delete the other entry in the World Info editor, ' +
                'then use ✕ only to clear the leftover registry identity. Automatic deletion is not offered because ' +
                'duplicate entries routinely hold different facts.'
            );
            return rows;
        },

        // Repair pass — the console twin of the "📚 From Lorebooks" button.
        // Validates every registry uid against its physical entry and relinks
        // crossed ones, detaches dead ones, and adopts untracked entries. It
        // rewrites ONLY registry pointers — no lorebook entry is edited, merged,
        // or deleted — so it is safe to run on a live chat that is throwing
        // "Refusing to load uid … points at a different NPC" warnings.
        reconcile: async () => {
            const { reconcileRegistry } = await import('./knowledge/staging.js');
            const r = await reconcileRegistry();
            if (r.report.length) {
                console.table(r.report.map(row => ({
                    action: row.action, npc: row.npc, uid: row.to ?? row.from ?? '', detail: row.detail,
                })));
            }
            console.log(
                `[MWT] Reconcile complete (registry pointers only — no entry edited/merged/deleted): ` +
                `${r.verified} already linked, ${r.relinked} relinked, ${r.adopted} adopted, ` +
                `${r.detached} detached, ${r.ambiguous + r.duplicates} to review.` +
                (r.detached ? ' Detached NPCs get a fresh entry on the next scan.' : '') +
                (r.ambiguous + r.duplicates ? ' Review flagged rows with MWT.npcs.auditDuplicates().' : '') +
                ' Reopen the NPCs tab to refresh the list.'
            );
            return r;
        },
    };

    // ── Interiority deletion tombstones ─────────────────────────────────────
    //
    // Deleting an intention records a tombstone so the engine cannot re-propose
    // it and a swipe cannot restore it. That is deliberately sticky, so there
    // has to be a way back for a deletion the user regrets.
    const interiorityData = await import('./interiority/data.js');

    window.MWT.interiority = {
        deletions: () => {
            const rows = interiorityData.getDeletedIntentions().map(d => ({
                npc: d.npc,
                action: (d.actions || [])[0] || '',
                trigger: (d.triggers || [])[0] || '',
                deletedAt: d.at ? new Date(d.at).toLocaleString() : '(unknown)',
            }));
            if (rows.length === 0) { console.log('[MWT] No deleted intentions recorded in this chat.'); return []; }
            console.table(rows);
            console.log('[MWT] These will not be re-proposed. MWT.interiority.clearDeletions() forgets them all.');
            return rows;
        },
        clearDeletions: () => {
            const count = interiorityData.clearDeletedIntentions();
            console.log(count > 0
                ? `[MWT] Cleared ${count} deletion record(s) — these intentions may be proposed again.`
                : '[MWT] Nothing to clear.');
            return count;
        },
    };

    console.log('[MWT] Console API ready: MWT.evidence.{list,summary,inspect,clear,clearAll}, MWT.profiles.{list,duplicates,pruneDuplicates,relink}, MWT.npcs.{auditDuplicates,reconcile}, MWT.interiority.{deletions,clearDeletions}');
} catch (err) {
    console.warn('[MWT] Could not load console evidence API:', err.message);
}

// Phase 2b binds preview and commit to the live metadata/identity/message UUIDs.
// Phase 3 adds the lorebook-store section; hardening adds a
// preview fingerprint (confirm→commit reconfirmation) and the identity policy.
window.MWT = window.MWT || {};
window.MWT.backup = {
    export: exportBackup,
    preview: previewRestore,
    restore: restoreBackup,
    undo: undoLastRestore,
    fingerprintPreview,
};

// ── Diagnostics console namespace (Phases 0–4) ──────────────────────────────
//
// Read-only, in-memory peek at the capture the diagnostics panel will later
// show. See DIAGNOSTICS_CONSOLE_GUIDE.md (repo root) for the tester guide.
// API-call capture is TELEMETRY ONLY — no prompts, API keys, custom headers,
// or response bodies. Injection snapshots (Phase 2) DO include the injected
// payload text by design — that is the exact string sent to
// setExtensionPrompt — but like everything here they stay in-memory only and
// nothing is written to chat_metadata, localStorage, or settings. The buffer
// resets on page reload. Settings provenance (Phase 4) resolves only the
// World State / Story Planner BEHAVIOR keys (inject/auto toggles, intervals,
// modes) — never apiKey, customHeaders, or apiUrl.
//
// Usage examples:
//   MWT.diagnostics.events()                    // event ring, newest first
//   MWT.diagnostics.events({ level: 'error' })  // only errors
//   MWT.diagnostics.events({ module: 'api' })   // only one module
//   MWT.diagnostics.apiCalls()                  // last ~20 API calls, newest first
//   MWT.diagnostics.lastApiCall('world_state')  // most recent call for one module
//   MWT.diagnostics.lastApiCalls()              // last call per module
//   MWT.diagnostics.lastRuns()                  // per-module last-run stamps
//   MWT.diagnostics.injections()                // last snapshot per injection key
//   MWT.diagnostics.injection('mwt_world_state_injection')  // one key's payload
//   MWT.diagnostics.settingsProvenance()        // where each WS/SP setting resolves from
//   MWT.diagnostics.health()                    // the ❤️ Health tab snapshot (one row per module)
//   MWT.diagnostics.environment()               // the 🌐 Environment tab snapshot (fork-compat probe)
//   MWT.diagnostics.scope()                     // the 🗂️ Scope & storage tab snapshot (which books + why)
//   MWT.diagnostics.clear()                     // wipe the in-memory buffer
//
// Each method prints a console.table(...) and RETURNS the full data, so the
// return value can be copied for the complete JSON (the table hides nested
// fields like usage/detail).
window.MWT.diagnostics = {
    events: (filter = {}) => {
        const events = getEvents(filter);
        console.table(events.map(e => ({
            time: new Date(e.ts).toLocaleTimeString(),
            level: e.level,
            module: e.module,
            event: e.event,
        })));
        console.log(events.length
            ? `[MWT] ${events.length} event(s) shown (newest first). The return value carries full detail for copy-paste.`
            : '[MWT] No diagnostics events captured yet — the buffer is in-memory and resets on reload.');
        return events;
    },

    apiCalls: () => {
        const calls = getApiCalls();
        console.table(calls.map(c => ({
            time: new Date(c.at).toLocaleTimeString(),
            module: c.module,
            mode: c.mode,
            model: c.model,
            status: c.status,
            ok: c.ok,
            durationMs: c.durationMs,
            retries: c.retries,
            errorClass: c.errorClass ?? null,
            finish_reason: c.finish_reason ?? null,
        })));
        console.log(calls.length
            ? `[MWT] ${calls.length} API call(s) shown (newest first). The return value carries full usage for copy-paste.`
            : '[MWT] No API calls captured yet.');
        return calls;
    },

    lastApiCall: (module = 'api') => {
        const call = getLastApiCall(module);
        if (!call) { console.log(`[MWT] No API call captured for module "${module}".`); return undefined; }
        console.log(`[MWT] Last API call (${module}):`, call);
        return call;
    },

    lastApiCalls: () => {
        const byModule = getAllLastApiCalls();
        const rows = Object.entries(byModule).map(([module, c]) => ({
            module,
            mode: c.mode,
            model: c.model,
            status: c.status,
            ok: c.ok,
            durationMs: c.durationMs,
            errorClass: c.errorClass ?? null,
            time: new Date(c.at).toLocaleTimeString(),
        }));
        console.table(rows);
        if (rows.length === 0) console.log('[MWT] No API calls captured yet.');
        return byModule;
    },

    lastRuns: () => {
        const runs = getAllLastRuns();
        const rows = Object.entries(runs).map(([module, r]) => ({
            module,
            startedAt: r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : null,
            finishedAt: r.finishedAt ? new Date(r.finishedAt).toLocaleTimeString() : null,
            ok: r.ok,
            error: r.error,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
            trigger: r.trigger,
        }));
        console.table(rows);
        if (rows.length === 0) console.log('[MWT] No module runs recorded yet.');
        return runs;
    },

    injections: () => {
        const snaps = getAllInjectedSnapshots();
        const rows = Object.entries(snaps).map(([key, s]) => ({
            key,
            enabled: s.enabled,
            role: s.role,           // 0 system · 1 user · 2 assistant
            depth: s.depth,
            chars: s.payload.length,
            appliedAt: s.at ? new Date(s.at).toLocaleTimeString() : null,
            ageSec: s.at ? Math.round((Date.now() - s.at) / 1000) : null,
        }));
        console.table(rows);
        if (rows.length === 0) console.log('[MWT] No injection snapshots recorded yet — they appear once a module applies its prompt.');
        else console.log('[MWT] Snapshots are the exact strings last registered with SillyTavern via setExtensionPrompt (frozen until re-applied; registration only — final prompt placement is not verified). NOTE: the return value includes full payload text, unlike apiCalls() which is telemetry-only.');
        return snaps;
    },

    injection: (key) => {
        const snap = getInjectedSnapshot(key);
        if (!snap) {
            console.log(`[MWT] No injection snapshot recorded for key "${key}". Known keys appear in MWT.diagnostics.injections().`);
            return undefined;
        }
        console.log(`[MWT] Injection snapshot (${key}):`, snap);
        return snap;
    },

    // Phase 4 — settings provenance (design §I.4.6). Two jobs: show WHERE each
    // World State / Story Planner behavior setting resolves from, and surface
    // the asymmetry that Chronicle, Knowledge, and Interiority have no
    // per-chat/global split at all — that asymmetry is itself diagnostic.
    // Read-only; resolves live on every call.
    settingsProvenance: () => {
        const worldStateKeys = {};
        for (const key of WS_GLOBAL_SETTING_KEYS) {
            worldStateKeys[key] = getEffectiveWorldSetting(key, undefined, { provenance: true });
        }
        const storyPlannerKeys = {};
        for (const key of SP_GLOBAL_SETTING_KEYS) {
            storyPlannerKeys[key] = getEffectivePlanSetting(key, undefined, { provenance: true });
        }
        const rows = [
            ...Object.entries(worldStateKeys).map(([key, r]) => ({ module: 'world_state', key, value: r.value, source: r.source })),
            ...Object.entries(storyPlannerKeys).map(([key, r]) => ({ module: 'story_planner', key, value: r.value, source: r.source })),
            ...['chronicle', 'knowledge', 'interiority'].map(m => ({
                module: m, key: '(all behavior settings)', value: '', source: 'module-only — no per-chat/global split',
            })),
        ];
        console.table(rows);
        console.log(
            '[MWT] World State and Story Planner behavior settings resolve through a 3-level chain ' +
            '(per-chat override → legacy chat field → global). Chronicle, Knowledge, and Interiority ' +
            'settings live only in their module tabs — that asymmetry is itself diagnostic. ' +
            'API-config provenance (module profile → module custom → global profile → global custom) ' +
            'is reported by resolveApiCall() as `source` on every resolved call.'
        );
        return {
            world_state: { settingsScope: 'global-with-per-chat-override', keys: worldStateKeys },
            story_planner: { settingsScope: 'global-with-per-chat-override', keys: storyPlannerKeys },
            chronicle: { settingsScope: 'module-only' },
            knowledge: { settingsScope: 'module-only' },
            interiority: { settingsScope: 'module-only' },
        };
    },

    // Phase 6 — Tab 1 Health (design §I.5 Tab 1): the same snapshot the ❤️
    // Health sub-tab renders — one row per module (enabled · gate · busy ·
    // tokens · auto-countdown · last run) plus the header (version, total
    // token load, panic switch). Read-only; resolves live on every call.
    health: () => {
        const snap = collectHealthSnapshot();
        if (snap.injectionMasterOff) {
            console.warn('[MWT] ⛔ PANIC SWITCH IS ON (injectionMasterOff) — injection & scanning are stopped for every module.');
        }
        console.table(snap.modules.map(m => ({
            module: m.id,
            on: m.enabled,
            gate: m.injectionAllowed,
            busy: m.busy,
            // Kind matters: 'stored' is lorebook corpus, not prompt load.
            tokens: m.tokenKind === 'stored' ? `${m.tokens} (stored)` : m.tokens,
            auto: m.auto
                ? (m.auto.perTurn ? `every turn${m.auto.pollDue ? ' (dormant poll due)' : ''}` : `in ${m.auto.remaining} msg(s)`)
                : 'off',
            lastRun: m.lastRun
                ? `${new Date(m.lastRun.at).toLocaleTimeString()} ${m.lastRun.ok ? 'ok' : 'FAILED'}${m.lastRun.durationMs != null ? ` ${(m.lastRun.durationMs / 1000).toFixed(1)}s` : ''}`
                : 'never',
        })));
        console.log(
            `[MWT] Health snapshot for MWT v${snap.mwtVersion} — injecting ${snap.injectedTokens} tokens` +
            (snap.storedTokens > 0
                ? `, plus ${snap.storedTokens} stored in the Knowledge lorebook (NOT injected — SillyTavern activates `
                  + 'only the entries whose keywords match recent chat). '
                : '. ') +
            'The return value carries the full rows (auto schedule, last-run source/model/HTTP status, per-field errors) for copy-paste.'
        );
        return snap;
    },

    // Phase 7 — Tab 2 Environment, the fork-compat probe (design §I.5 Tab 2):
    // the same snapshot the 🌐 Environment sub-tab renders — MWT + SillyTavern
    // versions, feature detection, the raw context fields, and the banner
    // verdict on the getCurrentChatId() premise behind core/scope.js. Async
    // because the shared.js Connection Manager probe (the exact import
    // core/api.js uses) can only settle through a dynamic import. Read-only;
    // resolves live on every call.
    environment: async () => {
        const loaded = await loadSharedModule();
        const snap = collectEnvironmentSnapshot({ sharedModule: loaded });
        const premise = snap.chatIdPremise;
        if (premise.level === 'fallback' || premise.level === 'fail-closed' || premise.level === 'unknown') {
            console.warn(`[MWT] ⚠ chat-ID premise: ${premise.level} — ${premise.note}`);
        }
        console.table(snap.features.map(f => ({
            feature: f.id,
            available: f.available,
            detail: f.detail,
        })));
        console.table({
            'MWT version': snap.mwtVersion,
            'SillyTavern version': snap.stVersion ?? `(not exposed${snap.stVersionSource ? ` via ${snap.stVersionSource}` : ''})`,
            'context': snap.contextAvailable ? (snap.contextSource ?? 'resolved') : '(none)',
            'chat-ID premise': `${premise.level}${premise.method ? ` via ${premise.method}` : ''}`,
            'identity key': premise.identityKey ?? '(none)',
            'CMRS (shared.js)': snap.connectionManager.probed
                ? (snap.connectionManager.error
                    ? `import failed: ${snap.connectionManager.error}`
                    : `${snap.connectionManager.available ? 'available' : 'missing'} · constructPrompt ${snap.connectionManager.constructPrompt ? '✓' : 'MISSING'}`)
                : 'not probed',
        });
        console.table(snap.contextFields);
        console.log(
            '[MWT] Environment probe — when reporting from a non-reference build or fork, copy the returned object ' +
            '(or screenshot the 🌐 Environment tab) into the report. The chat-ID premise row is core/scope.js\'s ' +
            'getCurrentChatId() assumption, validated live on this build; the context fields are the same table ' +
            'MWT.scope.diagnose() prints. Context field values can contain your character\'s name — skim before pasting.'
        );
        return snap;
    },

    // Phase 8 — Tab 3 Scope & storage (design §I.5 Tab 3): the same snapshot
    // the 🗂️ Scope & storage sub-tab renders — resolved identity + epoch,
    // which lorebooks this chat resolves to and WHY (re-derived read-only:
    // calling this never saves a binding), per-book hydration + store
    // version, saved bindings, and every scope_fallback_global warn Phase 3
    // recorded this session. Synchronous; read-only; resolves live per call.
    // MWT.scope.diagnose() remains the deeper dump (raw context fields); this
    // is the pasteable one-table answer.
    scope: () => {
        const snap = collectScopeSnapshot();
        const r = snap.resolution;
        for (const w of snap.warnings || []) {
            console.warn(`[MWT] ${w.level === 'fail' ? '⛔' : '⚠'} [${w.id}] ${w.text}`);
        }
        console.table({
            'scope setting': `${r.scope}${r.valid ? '' : ' (INVALID — treated as global)'}`,
            'resolution mode': r.mode,
            'character identity': snap.character
                ? `${snap.character.key} → "${snap.character.name}"${snap.character.isGroup ? ' (group)' : ''}`
                : '(unresolved)',
            'chat identity': snap.chat ? snap.chat.key : '(unresolved)',
            'identity used': r.identityKey ?? '(none — global books)',
            'Knowledge book': r.books.knowledge,
            'State book': r.books.state,
            'Profiles book': r.books.profiles,
            'epoch': snap.epoch,
            'bindings saved': snap.bindings.count,
            'scope_fallback_global events': snap.fallbackEvents.count,
        });
        console.table(snap.books.map((b) => ({
            book: b.id,
            name: b.name,
            // 'not attempted yet' is the ordinary early state (hydration is
            // async, on chat change); only 'LOAD FAILED' blocks writes.
            store: {
                'no-store': 'no store',
                loaded: b.dirty ? 'loaded (dirty)' : 'loaded',
                failed: 'LOAD FAILED — writes blocked',
                'not-attempted': 'not attempted yet',
            }[b.storeState] ?? 'unknown',
            version: b.hasStore ? (b.storeVersion != null ? `v${b.storeVersion}` : '—') : '—',
        })));
        if (snap.bindings.rows.length > 0) {
            console.table(snap.bindings.rows.map((row) => ({
                key: row.key,
                current: row.isCurrent,
                knowledge: row.knowledge,
                state: row.state,
                profiles: row.profiles,
            })));
            console.log('[MWT] "key" is the stable identity (avatar filename), which is why renaming a card keeps its books.');
        }
        console.log(
            '[MWT] Scope & storage snapshot for MWT v' + snap.mwtVersion + ' — read-only, re-derived live; nothing was ' +
            'saved by looking. The return value carries the full rows (resolution note, per-book dirty/version, ' +
            'fallback-event details, per-field errors) for copy-paste. For scoping/identity bug reports pair it with ' +
            'MWT.scope.diagnose() (raw context fields) or the 🌐 Environment tab.'
        );
        return snap;
    },

    // Phase 9 — Tab 4 Injection (design §I.5 Tab 4): the same snapshot the 💉
    // Injection sub-tab renders — per module: on/off · gate · resolved
    // role/depth WITH provenance · token estimate · the Phase 2 registered
    // payload (with its age) — plus the mandatory Knowledge lorebook caveat.
    // Named injectionStatus() because Phase 2 already took injections() (all
    // keys) and injection(key) (one key's raw snapshot). Read-only; resolves
    // live on every call. Synchronous.
    //
    // SAFE BY DEFAULT (the redaction contract): what this RETURNS is
    // redactInjectionSnapshot() output — payload text gated to size markers
    // and every string secret-scrubbed — so a tester can paste the return
    // value without auditing it. `injectionStatus({ includeContent: true })`
    // includes (still scrubbed) payloads; the EXACT recorded text is only
    // available through the deliberate single-key path, injection(key).
    injectionStatus: ({ includeContent = false } = {}) => {
        const snap = redactInjectionSnapshot(collectInjectionSnapshot(), { includeContent });
        for (const w of snap.warnings || []) {
            console.warn(`[MWT] ${w.level === 'fail' ? '⛔' : '⚠'} [${w.id}] ${w.text}`);
        }
        console.table(snap.modules.map(m => ({
            module: m.id,
            on: m.enabled === null ? 'n/a' : m.enabled,
            gate: m.gate,
            depth: m.placement ? `${m.placement.depth.value} (${m.placement.depth.source})` : '—',
            role: m.placement ? `${m.placement.role.value} (${m.placement.role.source})` : '—',
            // Kind matters: 'stored' is lorebook corpus, 'accessor' is only an
            // estimate while nothing is registered this session.
            tokens: m.tokens.kind === 'stored'
                ? `${m.tokens.value} (stored)`
                : (m.tokens.kind === 'accessor' ? `${m.tokens.value} (est.)` : m.tokens.value),
            registered: m.snapshot
                ? (m.snapshot.enabled
                    ? `${new Date(m.snapshot.at).toLocaleTimeString()} · ${formatInjectionAge(m.snapshot.ageSec)} · ${m.snapshot.chars} chars`
                    : `cleared ${new Date(m.snapshot.at).toLocaleTimeString()} · ${formatInjectionAge(m.snapshot.ageSec)}`)
                : 'never',
        })));
        if (snap.modules.some(m => m.snapshot?.enabled && m.snapshot.role != null)) {
            console.table(snap.modules
                .filter(m => m.snapshot?.enabled)
                .map(m => ({
                    key: m.key,
                    registeredDepth: m.snapshot.depth,
                    registeredRole: `${ROLE_NUMBERS[m.snapshot.role] ?? '?'} (${m.snapshot.role})`,
                })));
        }
        console.log(
            `[MWT] Injection snapshot for MWT v${snap.mwtVersion} — ${snap.livePayloads} live payload(s), ~${snap.registeredTokens} registered tokens` +
            (snap.injectionMasterOff ? '. ⛔ PANIC SWITCH IS ON — nothing new can register via setExtensionPrompt, and Knowledge lorebook entries are NOT stopped (see the warning above).' : '.') +
            (includeContent
                ? ' Payloads are INCLUDED but secret-scrubbed (URLs cut to scheme+host, key/bearer shapes redacted). Registration only — final-prompt placement is unverified.'
                : ' Payload text is content-gated OUT of this return value (size markers only). For scrubbed payloads: MWT.diagnostics.injectionStatus({ includeContent: true }). For one key\u2019s EXACT recorded text — the deliberate path when you truly need it: MWT.diagnostics.injection(key).')
        );
        return snap;
    },

    clear: () => {
        clearEvents();
        clearApiCalls();
        clearLastRuns();
        clearInjections();
        console.log('[MWT] Diagnostics buffer cleared (events + API calls + last runs + injection snapshots). In-memory only — nothing persisted.');
    },
};

console.log('[MWT] Diagnostics console API ready: MWT.diagnostics.{events,apiCalls,lastApiCall,lastApiCalls,lastRuns,injections,injection,settingsProvenance,health,environment,scope,injectionStatus,clear}');

console.log('[MWT] Merged World Tracker extension loaded.');
