/**
 * core/ui.js — Shared UI helpers: API settings fields renderer and floating
 * button bar / extensions drawer / wand menu factory.
 *
 * The floating-button subsystem is created via `createFloatingButtonBar()`,
 * which accepts its runtime dependencies ({ getSettings, openModal, modules })
 * so it stays decoupled from index.js.
 */

import { escapeHtml } from './diff.js';
import { notify } from './notifications.js';

// ─── API Settings Field Renderer ────────────────────────────────────────────

function numberValue(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Render the common API settings fields used by the global and module panels.
 *
 * @param {object} s settings object
 * @param {object} opts field IDs/defaults
 */
export function renderApiSettingsFields(s, opts = {}) {
    const {
        urlId = 'api-url',
        keyId = 'api-key',
        modelId = 'model',
        maxTokensId = 'max-tokens',
        tempId = 'temp',
        topPId = 'top-p',
        freqId = 'freq-pen',
        presId = 'pres-pen',
        headersId = 'headers',
        maxTokensDefault = 2000,
        tempDefault = 0.3,
        includeAdvanced = true,
        includeHeaders = true,
    } = opts;

    const advanced = includeAdvanced ? `
        <label class="mwt-label">Top P</label>
        <input id="${topPId}" class="mwt-input" type="number"
               value="${numberValue(s.topP, 1.0)}" min="0" max="1" step="0.05">

        <label class="mwt-label">Freq Penalty</label>
        <input id="${freqId}" class="mwt-input" type="number"
               value="${numberValue(s.frequencyPenalty, 0)}" min="-2" max="2" step="0.1">

        <label class="mwt-label">Pres Penalty</label>
        <input id="${presId}" class="mwt-input" type="number"
               value="${numberValue(s.presencePenalty, 0)}" min="-2" max="2" step="0.1">
    ` : '';

    const headers = includeHeaders ? `
        <label class="mwt-label">Custom Headers</label>
        <textarea id="${headersId}" class="mwt-input" rows="2"
                  placeholder='{"X-Custom": "value"}'>${escapeHtml(s.customHeaders || '')}</textarea>
    ` : '';

    return `
        <label class="mwt-label">API URL</label>
        <input id="${urlId}" class="mwt-input" type="text"
               value="${escapeHtml(s.apiUrl || '')}"
               placeholder="https://api.openai.com/v1">

        <label class="mwt-label">API Key</label>
        <input id="${keyId}" class="mwt-input" type="password"
               value="${escapeHtml(s.apiKey || '')}"
               placeholder="sk-...">

        <label class="mwt-label">Model</label>
        <input id="${modelId}" class="mwt-input" type="text"
               value="${escapeHtml(s.modelName || '')}"
               placeholder="gpt-4o-mini">

        <label class="mwt-label">Max Tokens</label>
        <input id="${maxTokensId}" class="mwt-input" type="number"
               value="${numberValue(s.maxTokens, maxTokensDefault)}" min="100" max="32000">

        <label class="mwt-label">Temperature</label>
        <input id="${tempId}" class="mwt-input" type="number"
               value="${numberValue(s.temperature, tempDefault)}" min="0" max="2" step="0.05">
        ${advanced}
        ${headers}
    `;
}

/**
 * Read API settings values from a DOM container element.
 *
 * @param {Element} el — container to querySelect from
 * @param {object} opts — same ID map as renderApiSettingsFields
 * @returns {object} parsed settings values ready for saveSettings()
 */
export function readApiSettingsValues(el, opts = {}) {
    const {
        urlId = 'api-url',
        keyId = 'api-key',
        modelId = 'model',
        maxTokensId = 'max-tokens',
        tempId = 'temp',
        topPId = 'top-p',
        freqId = 'freq-pen',
        presId = 'pres-pen',
        headersId = 'headers',
        maxTokensDefault = 2000,
    } = opts;

    // Empty numeric fields must fall through to their defaults. The previous
    // `??` coalescing only caught null/undefined, so a cleared Temperature
    // input (value === '') passed through as `Number('') === 0` and got
    // persisted as 0. Treat the raw value as missing when it's an empty
    // string so the default applies. (maxTokens already used `||`.)
    const numericOr = (raw, fallback) => (raw === '' || raw == null ? fallback : Number(raw));
    const tempRaw = el.querySelector(`#${tempId}`)?.value;
    const topPRaw = el.querySelector(`#${topPId}`)?.value;
    const freqRaw = el.querySelector(`#${freqId}`)?.value;
    const presRaw = el.querySelector(`#${presId}`)?.value;

    return {
        apiUrl: el.querySelector(`#${urlId}`)?.value?.trim() || '',
        apiKey: el.querySelector(`#${keyId}`)?.value?.trim() || '',
        modelName: el.querySelector(`#${modelId}`)?.value?.trim() || '',
        maxTokens: Number(el.querySelector(`#${maxTokensId}`)?.value) || maxTokensDefault,
        temperature: numericOr(tempRaw, opts.tempDefault ?? 0.3),
        topP: numericOr(topPRaw, 1),
        frequencyPenalty: numericOr(freqRaw, 0),
        presencePenalty: numericOr(presRaw, 0),
        customHeaders: el.querySelector(`#${headersId}`)?.value || '',
    };
}

// ─── Floating Button Bar Factory ────────────────────────────────────────────

const FLOAT_BUTTONS = [
    { id: 'mwt-float-world',         label: '🌍', title: 'World State',   tab: 'world-state',   visibilityKey: 'showFloatWorld',         enableKey: 'enableWorldState' },
    { id: 'mwt-float-chronicle',     label: '📜', title: 'Chronicle',     tab: 'chronicle',     visibilityKey: 'showFloatChronicle',     enableKey: 'enableChronicle' },
    { id: 'mwt-float-knowledge',     label: '🧠', title: 'Knowledge',     tab: 'knowledge',     visibilityKey: 'showFloatKnowledge',     enableKey: 'enableKnowledge' },
    { id: 'mwt-float-story-planner', label: '🗺️', title: 'Story Planner', tab: 'story-planner', visibilityKey: 'showFloatStoryPlanner', enableKey: 'enableStoryPlanner' },
    { id: 'mwt-float-interiority',   label: '💭', title: 'Interiority',   tab: 'interiority',   visibilityKey: 'showFloatInteriority',   enableKey: 'enableInteriority' },
    { id: 'mwt-float-settings',      label: '⚙️', title: 'All Settings',  tab: 'settings',      visibilityKey: 'showFloatSettings',      masterKey: 'injectionMasterOff' },
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
 * Create the floating-button subsystem.
 *
 * @param {object} deps
 * @param {() => object} deps.getSettings   — returns current global settings
 * @param {(tabId: string|null) => void} deps.openModal — opens the MWT modal
 * @param {object} deps.modules — { WorldState, Chronicle, Knowledge }
 * @returns {object} UI helpers: applyButtonVisibility, applyButtonStyle,
 *                   setupButtonBar, setupExtensionsDrawer, setupWandMenu,
 *                   updateFloatTokenCounts, updateButtonStates
 */
export function createFloatingButtonBar({ getSettings, saveSettings, openModal, modules }) {
    const { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority } = modules;

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
                hub.addEventListener('click', () => openModal(null));
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

    /** Toggle body class and update classic button inner HTML */
    function applyButtonStyle() {
        const style = getSettings().buttonStyle || 'modern';
        if (style === 'classic') {
            document.body.classList.add('mwt-buttons--classic');
        } else {
            document.body.classList.remove('mwt-buttons--classic');
        }

        // Swap button inner HTML for classic mode labels
        for (const cfg of FLOAT_BUTTONS) {
            const btn = document.getElementById(cfg.id);
            if (!btn) continue;
            const iconEl = btn.querySelector('.mwt-float-btn-icon');
            if (style === 'classic') {
                // Classic labels: icon + text
                const classicLabels = {
                    'mwt-float-world': '🌍 World State',
                    'mwt-float-chronicle': '📜 Session Chronicle',
                    'mwt-float-knowledge': '🧠 Knowledge Tracker',
                    'mwt-float-story-planner': '🗺️ Story Planner',
                    'mwt-float-interiority': '💭 Interiority',
                    'mwt-float-settings': '⚙️ Settings',
                };
                if (iconEl && classicLabels[cfg.id]) {
                    iconEl.textContent = classicLabels[cfg.id];
                }
            } else {
                // Modern labels: icon only
                const modernLabels = {
                    'mwt-float-world': '🌍',
                    'mwt-float-chronicle': '📜',
                    'mwt-float-knowledge': '🧠',
                    'mwt-float-story-planner': '🗺️',
                    'mwt-float-interiority': '💭',
                    'mwt-float-settings': '⚙️',
                };
                if (iconEl && modernLabels[cfg.id]) {
                    iconEl.textContent = modernLabels[cfg.id];
                }
            }
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
                openModal(cfg.tab);
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

            // Right-click (desktop) / long-press (mobile) → quick toggle.
            // The browser fires `contextmenu` for both gestures natively.
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault(); // suppress the browser context menu
                const s = getSettings();

                if (cfg.masterKey) {
                    // ⚙️ button → flip the global panic switch
                    const nowOff = s.injectionMasterOff !== true;
                    saveSettings({ [cfg.masterKey]: nowOff });
                    try {
                        WorldState.applyWorldStateInjection?.();
                        Chronicle.applyInjection?.();
                        StoryPlanner.applyPlanInjection?.();
                        Interiority.applyIntentionsInjection?.();
                    } catch { /* modules may not be initialized yet */ }
                    updateButtonStates();
                    notify(
                        'Merged World Tracker',
                        nowOff ? 'All trackers disabled (panic switch).' : 'All trackers re-enabled.',
                        nowOff ? 'info' : 'success',
                    );
                } else if (cfg.enableKey) {
                    // Module button → flip per-module enable
                    const nowDisabled = s[cfg.enableKey] !== false; // currently enabled → disabling
                    saveSettings({ [cfg.enableKey]: !nowDisabled });
                    try {
                        WorldState.applyWorldStateInjection?.();
                        Chronicle.applyInjection?.();
                        StoryPlanner.applyPlanInjection?.();
                        Interiority.applyIntentionsInjection?.();
                    } catch { /* modules may not be initialized yet */ }
                    updateButtonStates();
                    notify(
                        cfg.title,
                        nowDisabled
                            ? `${cfg.title} disabled. Right-click to re-enable.`
                            : `${cfg.title} enabled.`,
                        nowDisabled ? 'info' : 'success',
                    );
                }
            });
        });

        applyButtonVisibility();
    }

    // ─── Extensions panel drawer ─────────────────────────────────────────────

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
                <button class="mwt-btn" id="mwt-drawer-story-planner" title="Open Story Planner tab">🗺️</button>
                <button class="mwt-btn" id="mwt-drawer-interiority" title="Open Interiority tab">💭</button>
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
        container.querySelector('#mwt-drawer-open')?.addEventListener('click', () => openModal(null));
        container.querySelector('#mwt-drawer-world')?.addEventListener('click', () => openModal('world-state'));
        container.querySelector('#mwt-drawer-chronicle')?.addEventListener('click', () => openModal('chronicle'));
        container.querySelector('#mwt-drawer-knowledge')?.addEventListener('click', () => openModal('knowledge'));
        container.querySelector('#mwt-drawer-story-planner')?.addEventListener('click', () => openModal('story-planner'));
        container.querySelector('#mwt-drawer-interiority')?.addEventListener('click', () => openModal('interiority'));
    }

    // ─── Wand menu entry ─────────────────────────────────────────────────────

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
            openModal(null);
            // Close the wand menu
            if (typeof $ !== 'undefined') {
                try { $('#extensionsMenu').dropdown('toggle'); } catch { /* not a bootstrap dropdown */ }
            }
        });
    }

    // ─── Periodic floating button updates ────────────────────────────────────

    /** Called every 5 s to refresh token counts and auto-refresh countdowns. */
    function updateFloatTokenCounts() {
        try {
            const mods = [
                { id: 'mwt-float-world', getTokens: WorldState.getTotalTokens },
                { id: 'mwt-float-chronicle', getTokens: Chronicle.getTotalTokens },
                { id: 'mwt-float-knowledge', getTokens: Knowledge.getTotalTokens },
                { id: 'mwt-float-story-planner', getTokens: StoryPlanner.getTotalTokens },
                { id: 'mwt-float-interiority', getTokens: Interiority.getTotalTokens },
            ];
            for (const m of mods) {
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

            // Update auto-scan countdown on Knowledge floating button
            // (Mirrors the World State / Chronicle countdown logic.)
            const knCountdownEl = document.getElementById('mwt-float-knowledge-countdown');
            if (knCountdownEl) {
                const knStatus = Knowledge.getAutoScanStatus?.();
                if (knStatus) {
                    const remaining = knStatus.interval - knStatus.counter;
                    knCountdownEl.textContent = `${remaining}`;
                    knCountdownEl.style.display = 'block';
                    knCountdownEl.title = `Auto-scan in ${remaining} message${remaining !== 1 ? 's' : ''} (${knStatus.counter}/${knStatus.interval})`;
                } else {
                    knCountdownEl.textContent = '';
                    knCountdownEl.style.display = 'none';
                    knCountdownEl.title = '';
                }
            }

            // Update auto-plan countdown on Story Planner floating button
            const spCountdownEl = document.getElementById('mwt-float-story-planner-countdown');
            if (spCountdownEl) {
                const spStatus = StoryPlanner.getAutoPlanStatus?.();
                if (spStatus) {
                    const remaining = spStatus.interval - spStatus.counter;
                    spCountdownEl.textContent = `${remaining}`;
                    spCountdownEl.style.display = 'block';
                    spCountdownEl.title = `Auto-plan in ${remaining} message${remaining !== 1 ? 's' : ''} (${spStatus.counter}/${spStatus.interval})`;
                } else {
                    spCountdownEl.textContent = '';
                    spCountdownEl.style.display = 'none';
                    spCountdownEl.title = '';
                }
            }

            // Classic button dynamic state classes
            updateButtonStates();
        } catch { /* ignore */ }
    }

    /** Standalone per-button state updater for classic-style buttons.
     *  Called from the 5s poll AND immediately when a module's busy flag flips. */
    function updateButtonStates() {
        const s = getSettings();

        // ── Disabled / master-off visual state (works in BOTH modern + classic) ──
        // Applied before the classic early-return so the red ✕ shows everywhere.
        const masterOff = s.injectionMasterOff === true;
        for (const cfg of FLOAT_BUTTONS) {
            const btn = document.getElementById(cfg.id);
            if (!btn) continue;
            if (cfg.masterKey) {
                btn.classList.toggle('mwt-btn--master-off', masterOff);
            } else if (cfg.enableKey) {
                btn.classList.toggle('mwt-btn--disabled', s[cfg.enableKey] === false || masterOff);
            }
        }

        // ── Knowledge staging + growth badges (works in BOTH modern + classic) ──
        // Two independent attention signals, both on the Knowledge button:
        //
        //   • staging (orange) — pending scan/state proposals awaiting review.
        //   • growth  (green)  — unread behavioral evidence captured in the
        //     background since the user last opened a Growth Profile modal.
        //
        // Both pulse so the user is drawn back even when the MWT modal is
        // closed. The growth badge is the persistent companion to the transient
        // toastr that fires once on capture completion.
        const knBtnAny = document.getElementById('mwt-float-knowledge');
        if (knBtnAny) {
            const stagingCount = Knowledge.getStagingCount?.() ?? 0;
            const growthCount = Knowledge.getGrowthEvidenceCount?.() ?? 0;
            knBtnAny.classList.toggle('mwt-btn--has-staging', stagingCount > 0);
            knBtnAny.classList.toggle('mwt-btn--has-growth', growthCount > 0);

            // Title shows whichever signal(s) are active. Staging takes
            // precedence in the wording since proposals need action; growth
            // evidence is informational (already saved to the evidence store).
            if (stagingCount > 0 && growthCount > 0) {
                knBtnAny.title = `Knowledge Tracker — ${stagingCount} proposal(s) + ${growthCount} new growth observation(s)`;
            } else if (stagingCount > 0) {
                knBtnAny.title = `Knowledge Tracker — ${stagingCount} proposal(s) awaiting review`;
            } else if (growthCount > 0) {
                knBtnAny.title = `Knowledge Tracker — ${growthCount} new growth observation(s) (open a Growth Profile to review)`;
            } else {
                knBtnAny.title = 'Knowledge';
            }
        }

        if (s.buttonStyle !== 'classic') return;

        // World State button state
        const wsBtn = document.getElementById('mwt-float-world');
        if (wsBtn) {
            wsBtn.classList.remove('mwt-btn--refreshing', 'mwt-btn--active', 'mwt-btn--inactive', 'mwt-btn--empty');
            const wsStatus = WorldState.getAutoRefreshStatus?.();
            const wsRefreshing = WorldState.isRefreshing?.() || false;
            if (wsRefreshing) {
                wsBtn.classList.add('mwt-btn--refreshing');
            } else if (wsStatus) {
                wsBtn.classList.add('mwt-btn--active');
            } else if (WorldState.getWorldStateText?.() && WorldState.getWorldStateText()) {
                wsBtn.classList.add('mwt-btn--inactive');
            } else {
                wsBtn.classList.add('mwt-btn--empty');
            }
        }

        // Chronicle button state
        const chBtn = document.getElementById('mwt-float-chronicle');
        if (chBtn) {
            chBtn.classList.remove('mwt-btn--refreshing', 'mwt-btn--active', 'mwt-btn--inactive', 'mwt-btn--empty');
            const chSnapping = Chronicle.isGeneratingSnapshot?.() || false;
            const chStatus = Chronicle.getAutoSnapshotStatus?.();
            if (chSnapping) {
                chBtn.classList.add('mwt-btn--refreshing');
            } else if (chStatus) {
                chBtn.classList.add('mwt-btn--active');
            } else if (Chronicle.getLastEntryText?.() && Chronicle.getLastEntryText()) {
                chBtn.classList.add('mwt-btn--inactive');
            } else {
                chBtn.classList.add('mwt-btn--empty');
            }
        }

        // Knowledge button state
        const knBtn = document.getElementById('mwt-float-knowledge');
        if (knBtn) {
            knBtn.classList.remove('mwt-btn--refreshing', 'mwt-btn--active', 'mwt-btn--inactive', 'mwt-btn--empty');
            const knScanning = Knowledge.isScanning?.() || false;
            if (knScanning) {
                knBtn.classList.add('mwt-btn--refreshing');
            } else if (Knowledge.getNpcCount?.() > 0) {
                knBtn.classList.add('mwt-btn--active');
            } else {
                knBtn.classList.add('mwt-btn--empty');
            }
        }

        // Story Planner button state
        const spBtn = document.getElementById('mwt-float-story-planner');
        if (spBtn) {
            spBtn.classList.remove('mwt-btn--refreshing', 'mwt-btn--active', 'mwt-btn--inactive', 'mwt-btn--empty');
            const spGenerating = StoryPlanner.isGenerating?.() || false;
            const spStatus = StoryPlanner.getAutoPlanStatus?.();
            if (spGenerating) {
                spBtn.classList.add('mwt-btn--refreshing');
            } else if (spStatus) {
                spBtn.classList.add('mwt-btn--active');
            } else if (StoryPlanner.getPlanTextForMacro?.()) {
                spBtn.classList.add('mwt-btn--inactive');
            } else {
                spBtn.classList.add('mwt-btn--empty');
            }
        }

        // Interiority button state
        const inBtn = document.getElementById('mwt-float-interiority');
        if (inBtn) {
            inBtn.classList.remove('mwt-btn--refreshing', 'mwt-btn--active', 'mwt-btn--inactive', 'mwt-btn--empty');
            const inGenerating = Interiority.isGenerating?.() || false;
            const inSettings = Interiority.getSettingsSummary?.();
            const inAuto = inSettings?.autoMode === true;
            const inLedgerCount = Interiority.getLedgerCount?.() ?? 0;
            if (inGenerating) {
                inBtn.classList.add('mwt-btn--refreshing');
            } else if (inAuto) {
                inBtn.classList.add('mwt-btn--active');
            } else if (inLedgerCount > 0) {
                inBtn.classList.add('mwt-btn--inactive');
            } else {
                inBtn.classList.add('mwt-btn--empty');
            }
        }
    }

    // ── Return public API ────────────────────────────────────────────────────

    return {
        FLOAT_BUTTONS,
        applyButtonVisibility,
        applyButtonStyle,
        setupButtonBar,
        setupExtensionsDrawer,
        setupWandMenu,
        updateFloatTokenCounts,
        updateButtonStates,
    };
}