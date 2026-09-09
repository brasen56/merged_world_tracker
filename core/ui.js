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
import { recordSchemaEvent, schemaEventForSeverity } from './schema_status.js';
import { validateFloatPositions } from '../schema/secondary.js';

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
    //
    // CORE-05: `Number(raw)` also persists NaN for non-numeric input (e.g.
    // letters pasted into the field), which JSON.stringify then serializes as
    // `null` — silently dropping the param from the API payload. The helper
    // now returns the fallback for any non-finite result, not just empty/null.
    const numericOr = (raw, fallback) => {
        if (raw === '' || raw == null) return fallback;
        const n = Number(raw);
        return Number.isFinite(n) ? n : fallback;
    };
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

// ─── Tablist wiring (accessibility plan §4.2, Slice 2) ───────────────────────

/**
 * Matches one leading decorative emoji: a pictographic optionally followed by
 * variation selectors / ZWJ-joined pictographics (🗺️, ❤️, 🏳️‍🌈), plus the
 * whitespace separating it from the real label. The whitespace is consumed
 * only to bound the match — ariaHideEmoji() preserves it in its output so the
 * visible label stays byte-identical. `\p{Extended_Pictographic}` needs the
 * `u` flag (ES2018+).
 */
const LEADING_EMOJI_RE = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;

/**
 * Hide a label's leading decorative emoji from assistive technology.
 *
 * Tab labels like `🌍 World State` are pronounced as the emoji character
 * followed by the name; the emoji carries no information the name doesn't.
 * Wrapping it in an `aria-hidden="true"` span leaves the visible label
 * untouched while the accessible name becomes just "World State"
 * (accessibility plan §4.4 / Slice 2 item 4).
 *
 * Labels without a leading emoji are returned unchanged, so this is safe to
 * run over any label list.
 *
 * @param {string} label — label text that may start with a decorative emoji
 * @returns {string} HTML string
 */
export function ariaHideEmoji(label) {
    if (typeof label !== 'string' || label === '') return label || '';
    const match = label.match(LEADING_EMOJI_RE);
    if (!match) return label;
    // Slice at the end of the emoji (match[1]), NOT the end of the whole
    // match: match[0] also swallowed the separator run (`\s*` in
    // LEADING_EMOJI_RE), so slicing there dropped the space between the
    // emoji and the label and every tab rendered as a cramped `🌍World
    // State`. The visible label must stay byte-identical — only the
    // accessible name loses the emoji.
    return `<span aria-hidden="true">${match[1]}</span>${label.slice(match[1].length)}`;
}

/**
 * Mark a control busy or idle for the duration of async work
 * (accessibility plan §4.4 / Slice 3 item 4).
 *
 * `disabled` stops double-submits; `aria-busy="true"` tells assistive
 * technology that work is in flight. The two must be set AND cleared
 * together — including on error and cancellation paths — which is why
 * handlers route through this helper instead of touching `disabled`
 * directly: with one call per state change, the clear side can never be
 * forgotten on one path.
 *
 * setStatus() owns the *result* announcement (a polite live region); it
 * cannot know which control is doing the work, so the busy flags stay with
 * the handler that owns the control.
 *
 * Null-tolerant by design: handlers resolve buttons with `?.` and may pass
 * a missing node straight through. setAttribute is feature-tested because
 * Node-suite element fakes implement `disabled` but not the attribute API.
 *
 * @param {Element|null|undefined} control — the control running the async work
 * @param {boolean} busy — true while the work is in flight, false when it ends
 */
export function setControlBusy(control, busy) {
    if (!control) return;
    control.disabled = busy === true;
    control.setAttribute?.('aria-busy', busy ? 'true' : 'false');
}

/**
 * Whether the user asked the OS/browser for reduced motion
 * (accessibility plan §4.5 / Slice 3 item 5).
 *
 * Only needed where JavaScript itself produces visual movement — the one
 * smooth scroll in the codebase (knowledge/render.js psychoanalyze). All
 * CSS-driven motion (pulses, transitions, the countdown badge) is
 * suppressed by the `@media (prefers-reduced-motion: reduce)` block in
 * core/style.css, which scopes past `.mwt-modal` to the `mwt-`/`kt-` class
 * prefixes. The force-directed relationship graph needs no JS gate: its
 * layout is computed synchronously (computeGraphLayout) and rendered in a
 * single static pass — there is no animated settle to suppress, and node
 * drag/pan is direct manipulation, not animation.
 *
 * Fail-open: no `matchMedia` (old embedders, the Node test environment)
 * reads as "no preference" — motion keeps working.
 *
 * @returns {boolean}
 */
export function prefersReducedMotion() {
    try {
        return typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    } catch {
        return false;
    }
}

/**
 * Wire a tab strip to the WAI-ARIA Tabs pattern (accessibility plan §4.2).
 *
 * Owns the whole keyboard/state contract so consumers only supply markup and
 * selectors:
 *
 * - stamps `role="tablist"` + `aria-orientation` on the container,
 *   `role="tab"` on buttons and `role="tabpanel"` on panels;
 * - pairs tabs and panels **in DOM order** (every consumer renders both from
 *   the same ordered list), giving each a stable id if the markup ships none
 *   and wiring `aria-controls` / `aria-labelledby` both ways;
 * - keeps exactly one tab selected (`aria-selected`, the consumer's active
 *   class, and `tabindex="0"`; every other tab gets `tabindex="-1"`), and
 *   exposes exactly one panel (inactive panels get the `hidden` attribute —
 *   out of the tab order, still in the DOM);
 * - Arrow keys follow the declared orientation (`horizontal` → Left/Right,
 *   `vertical` → Up/Down, for the future Settings navigation), wrap in both
 *   directions, Home/End work in both, and activation is automatic — moving
 *   focus selects the tab, no second keypress, because all panels render
 *   locally;
 * - activation never rebuilds anything: it toggles attributes and classes on
 *   the existing nodes only, so field values in any panel survive switching.
 *
 * Listeners bind **once per tablist element** (the `_mwtTablistWired` flag,
 * after the `_cleanupKeyHandler` precedent). Both current consumers re-render
 * the whole strip per `renderModal()` pass — a fresh element cannot carry
 * stale listeners — and the flag additionally makes wiring the same surviving
 * element twice a no-op for listeners.
 *
 * @param {Element} tablist — the tab bar container element
 * @param {object} [opts]
 * @param {'horizontal'|'vertical'} [opts.orientation='horizontal']
 * @param {string} [opts.tabSelector='[role="tab"]'] — tab buttons inside the container
 * @param {string} [opts.panelSelector='[role="tabpanel"]'] — panels; must not
 *        match a *nested* tablist's panels, so consumers with nesting pass an
 *        explicit class selector
 * @param {Element} [opts.scope=tablist.parentElement] — root searched for panels
 * @param {string|null} [opts.activeClass='active'] — CSS hook class kept in
 *        sync with `aria-selected`/`hidden`; pass null when the consumer has none
 * @param {string} [opts.idPrefix='mwt-tablist'] — prefix for generated ids
 * @param {Function} [opts.onActivate] — called with (tab, panel) after each
 *        user-driven activation (not after the initial normalization)
 * @returns {object|null} `{ tablist, select(index, focus), getSelectedIndex }`
 *          or null when there is nothing to wire
 */
export function wireTablist(tablist, opts = {}) {
    if (!tablist || typeof tablist.querySelectorAll !== 'function') return null;
    const {
        orientation = 'horizontal',
        tabSelector = '[role="tab"]',
        panelSelector = '[role="tabpanel"]',
        scope = tablist.parentElement,
        activeClass = 'active',
        idPrefix = 'mwt-tablist',
        onActivate = null,
    } = opts;
    if (!scope || typeof scope.querySelectorAll !== 'function') return null;

    const vertical = orientation === 'vertical';
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');

    // Handlers re-query on every activation so a re-wire against changed
    // markup can never act on a stale tab list.
    const getTabs = () => Array.from(tablist.querySelectorAll(tabSelector));
    const getPanels = () => Array.from(scope.querySelectorAll(panelSelector));

    // 1) Static bookkeeping: pair tabs and panels by DOM order and stamp the
    //    id / aria-controls / aria-labelledby contract.
    const tabs = getTabs();
    const panels = getPanels();
    const count = Math.min(tabs.length, panels.length);
    if (!count) return null;
    for (let i = 0; i < count; i += 1) {
        const tab = tabs[i];
        const panel = panels[i];
        tab.setAttribute('role', 'tab');
        panel.setAttribute('role', 'tabpanel');
        if (!tab.id) tab.id = `${idPrefix}-tab-${i + 1}`;
        if (!panel.id) panel.id = `${idPrefix}-panel-${i + 1}`;
        tab.setAttribute('aria-controls', panel.id);
        panel.setAttribute('aria-labelledby', tab.id);
    }

    // (selection state + activation + listeners continue below)

    // 2) Selection state lives on the tablist element so re-wiring and the
    //    once-per-element listeners below always share one source of truth.
    const state = tablist._mwtTablist || (tablist._mwtTablist = {});
    if (typeof state.selected !== 'number' || state.selected < 0 || state.selected >= count) {
        const marked = tabs.findIndex((t) =>
            t.getAttribute('aria-selected') === 'true'
            || (activeClass && t.classList.contains(activeClass)));
        state.selected = marked >= 0 ? marked : 0;
    }

    const select = (index, { focus = false, announce = true } = {}) => {
        const currentTabs = getTabs();
        const currentPanels = getPanels();
        const n = Math.min(currentTabs.length, currentPanels.length);
        if (!n) return;
        const wrapped = ((index % n) + n) % n;
        state.selected = wrapped;
        for (let i = 0; i < n; i += 1) {
            const active = i === wrapped;
            const tab = currentTabs[i];
            const panel = currentPanels[i];
            tab.setAttribute('aria-selected', String(active));
            tab.setAttribute('tabindex', active ? '0' : '-1');
            if (activeClass) {
                tab.classList.toggle(activeClass, active);
                panel.classList.toggle(activeClass, active);
            }
            panel.hidden = !active;
        }
        if (focus && typeof currentTabs[wrapped].focus === 'function') {
            currentTabs[wrapped].focus();
        }
        if (announce && typeof onActivate === 'function') {
            onActivate(currentTabs[wrapped], currentPanels[wrapped]);
        }
    };
    state.select = select;

    // Normalize whatever the markup claimed — exactly one selected tab, one
    // exposed panel, coherent roving tabindex — without announcing it.
    select(state.selected, { announce: false });

    // 3) Listeners bind once per element; see the doc comment.
    if (!tablist._mwtTablistWired) {
        tablist._mwtTablistWired = true;
        tablist.addEventListener('click', (e) => {
            const target = e.target?.closest?.(tabSelector);
            if (!target || !tablist.contains(target)) return;
            const index = getTabs().indexOf(target);
            if (index < 0) return;
            state.select(index);
        });
        tablist.addEventListener('keydown', (e) => {
            const forwardKey = vertical ? 'ArrowDown' : 'ArrowRight';
            const backKey = vertical ? 'ArrowUp' : 'ArrowLeft';
            const n = Math.min(getTabs().length, getPanels().length);
            if (!n) return;
            let target = null;
            if (e.key === forwardKey) target = state.selected + 1;
            else if (e.key === backKey) target = state.selected - 1;
            else if (e.key === 'Home') target = 0;
            else if (e.key === 'End') target = n - 1;
            else return;
            e.preventDefault();
            state.select(target, { focus: true });
        });
    }

    return {
        tablist,
        select: (index, focus) => state.select(index, { focus }),
        getSelectedIndex: () => state.selected,
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

// Part 7 (schema plan §2.2): the saved positions are validated through
// schema/secondary.js before use. Findings are surfaced once per session in
// the diagnostics ring (§9.3) — loadFloatPositions() runs at setup. One key,
// so per-code dedup is per-record dedup here (knowledge/lorebook.js, whose
// history keys are per-book-per-uid, must additionally key on the store).
//
// The event follows the finding's SEVERITY: an unknown-button-id entry is
// RETAINED, and reporting that as schema_quarantined would claim data was set
// aside for recovery when nothing was removed.
const _reportedFloatIssues = new Set();
function reportFloatPositionIssues(issues) {
    for (const issue of issues) {
        if (_reportedFloatIssues.has(issue.code)) continue;
        _reportedFloatIssues.add(issue.code);
        recordSchemaEvent(schemaEventForSeverity(issue.severity), {
            store: FLOAT_POSITIONS_KEY,
            code: issue.code,
            reasonCode: String(issue.path?.[0] ?? issue.code),
        });
    }
}

/**
 * Load + validate the saved float-button positions (schema plan §2.2/Part 7).
 * Invalid entries are dropped from the live view only — the stored raw value
 * is left untouched, and the next drag rewrite converges the key. Entries for
 * button ids this build no longer has are retained (with a finding).
 * Exported for the secondary-persistence wiring tests.
 */
export function loadFloatPositions() {
    let raw;
    try {
        const text = localStorage.getItem(FLOAT_POSITIONS_KEY);
        if (!text) return {};
        try {
            raw = JSON.parse(text);
        } catch {
            // An unparseable record (truncated quota write, disk corruption)
            // reads as the FATAL root result — an empty live view with a
            // reported finding — instead of vanishing into a bare catch:
            // the same promise settings and Knowledge edit-history make for
            // this exact case. The stored raw value stays untouched (it is
            // the recovery copy); the next drag rewrite converges the key.
            raw = null;
        }
    } catch { return {}; }
    const validated = validateFloatPositions(raw, {
        allowedIds: FLOAT_BUTTONS.map(cfg => cfg.id),
    });
    reportFloatPositionIssues(validated.issues);
    return validated.data;
}

/**
 * Save one button's position, rewriting the whole key from the validated
 * live view (so dropped-invalid entries stay dropped). Exported alongside
 * loadFloatPositions() for the wiring tests.
 */
export function saveFloatPosition(btnId, left, top) {
    try {
        const positions = loadFloatPositions();
        positions[btnId] = { left, top };
        localStorage.setItem(FLOAT_POSITIONS_KEY, JSON.stringify(positions));
    } catch { /* ignore */ }
}

// Keeps a floating button's top-left corner within the visible viewport
// (with a small margin) so an erratic drag — or a browser window that got
// smaller since the position was saved — can't push a button somewhere the
// user can no longer see or reach.
const FLOAT_BTN_EDGE_MARGIN = 4;
function clampFloatPosition(left, top, width, height) {
    const maxLeft = Math.max(FLOAT_BTN_EDGE_MARGIN, window.innerWidth - width - FLOAT_BTN_EDGE_MARGIN);
    const maxTop = Math.max(FLOAT_BTN_EDGE_MARGIN, window.innerHeight - height - FLOAT_BTN_EDGE_MARGIN);
    return {
        left: Math.min(Math.max(left, FLOAT_BTN_EDGE_MARGIN), maxLeft),
        top: Math.min(Math.max(top, FLOAT_BTN_EDGE_MARGIN), maxTop),
    };
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

            // Re-clamp a restored position against the current viewport. Covers
            // a saved position that's now off-screen because the window/screen
            // shrank since it was saved (e.g. resize, rotation, different device).
            //
            // IMPORTANT: this is a *visual-only* clamp — we never overwrite the
            // saved position.  Otherwise a temporarily shrunken viewport (e.g.
            // DevTools console opened) would permanently destroy the user's
            // intended position, stranding buttons mid-screen when the viewport
            // returns to full size.  See the matching logic in the resize handler
            // below.  Only an explicit drag updates the saved position.
            if (saved) {
                const clamped = clampFloatPosition(saved.left, saved.top, btn.offsetWidth, btn.offsetHeight);
                btn.style.left = clamped.left + 'px';
                btn.style.top = clamped.top + 'px';
            }

            // Click to open modal on that tab
            btn.addEventListener('click', () => {
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
                const clamped = clampFloatPosition(origX + dx, origY + dy, btn.offsetWidth, btn.offsetHeight);
                btn.style.left = clamped.left + 'px';
                btn.style.top = clamped.top + 'px';
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

        // Re-clamp on viewport resize.  Visual-only — NEVER overwrites saved
        // positions.  We always re-derive the on-screen position from the
        // user's *saved* (intended) position and clamp that against the current
        // viewport.  This is critical for the DevTools-console scenario:
        //
        //   • Console opens  → viewport shrinks → saved pos clamps inward.
        //   • Console closes → viewport grows  → saved pos is re-clamped to a
        //     larger area, so the button springs back to where the user put it.
        //
        // If we instead read the live DOM rect (which may already be clamped
        // from a previous shrink) and persisted it, the original position would
        // be lost on the first shrink — exactly the "stranded mid-screen" bug.
        // Only an explicit drag (pointerup handler above) updates the saved pos.
        window.addEventListener('resize', () => {
            const positions = loadFloatPositions();
            FLOAT_BUTTONS.forEach((cfg) => {
                const btn = document.getElementById(cfg.id);
                if (!btn || !btn.style.left) return; // not dragged, uses right/bottom
                const saved = positions[cfg.id];
                if (!saved) return;
                const clamped = clampFloatPosition(saved.left, saved.top, btn.offsetWidth, btn.offsetHeight);
                btn.style.left = clamped.left + 'px';
                btn.style.top = clamped.top + 'px';
            });
        });
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

            // Story Planner badge — shares one slot between the auto-plan
            // countdown and the waiting-setup-beat count.
            //
            // Priority is overdue beats > countdown > waiting beats. An overdue
            // beat outranks the countdown because it is the only one of the
            // three the user can act on: a countdown just reports that a timer
            // is running, whereas an overdue beat means an arc has stalled and
            // is waiting on a decision only they can make.
            const spCountdownEl = document.getElementById('mwt-float-story-planner-countdown');
            if (spCountdownEl) {
                const spStatus = StoryPlanner.getAutoPlanStatus?.();
                const beats = StoryPlanner.getBeatStatus?.() || { awaiting: 0, overdue: 0 };
                const countdownText = spStatus
                    ? `Auto-plan in ${spStatus.interval - spStatus.counter} message${(spStatus.interval - spStatus.counter) !== 1 ? 's' : ''} (${spStatus.counter}/${spStatus.interval})`
                    : '';
                const beatText = beats.awaiting
                    ? `${beats.awaiting} setup beat${beats.awaiting !== 1 ? 's' : ''} waiting`
                      + (beats.overdue ? `, ${beats.overdue} overdue — /wt-beat to review` : '')
                    : '';

                spCountdownEl.classList.toggle('mwt-float-badge--overdue', beats.overdue > 0);

                if (beats.overdue > 0) {
                    spCountdownEl.textContent = `${beats.overdue}`;
                } else if (spStatus) {
                    spCountdownEl.textContent = `${spStatus.interval - spStatus.counter}`;
                } else if (beats.awaiting > 0) {
                    spCountdownEl.textContent = `${beats.awaiting}`;
                } else {
                    spCountdownEl.textContent = '';
                }

                const show = !!spCountdownEl.textContent;
                spCountdownEl.style.display = show ? 'block' : 'none';
                spCountdownEl.title = [beatText, countdownText].filter(Boolean).join(' · ');
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

    // ── Reset floating-button positions ──────────────────────────────────────
    //
    // Clears the saved drag positions from localStorage and restores each
    // floating button to its default stacked layout (right edge, bottom-up).
    // Also repositions the collapsed hub button if it exists. Exposed so a
    // settings button and the `/wt-reset-buttons` slash command can share it.

    function resetFloatPositions() {
        // 1) Drop persisted positions so setupButtonBar()/future reloads use defaults.
        try { localStorage.removeItem(FLOAT_POSITIONS_KEY); } catch { /* ignore */ }

        // 2) Live-reset existing buttons in the DOM to the default stack so the
        //    change is visible immediately without a page reload. This mirrors
        //    the default-position branch in setupButtonBar().
        FLOAT_BUTTONS.forEach((cfg, idx) => {
            const btn = document.getElementById(cfg.id);
            if (!btn) return;
            btn.style.left = '';
            btn.style.top = '';
            btn.style.right = '16px';
            btn.style.bottom = `${70 + idx * 48}px`;
            btn.style.transition = 'left 0.2s, top 0.2s, right 0.2s, bottom 0.2s';
        });

        // 3) Reset the collapsed hub button to its default spot too.
        const hub = document.getElementById('mwt-float-hub');
        if (hub) {
            hub.style.left = '';
            hub.style.top = '';
            hub.style.right = '16px';
            hub.style.bottom = '70px';
            hub.style.transition = 'left 0.2s, top 0.2s, right 0.2s, bottom 0.2s';
        }
    }

    // ── Return public API ────────────────────────────────────────────────────

    return {
        FLOAT_BUTTONS,
        applyButtonVisibility,
        applyButtonStyle,
        resetFloatPositions,
        setupButtonBar,
        setupExtensionsDrawer,
        setupWandMenu,
        updateFloatTokenCounts,
        updateButtonStates,
    };
}
