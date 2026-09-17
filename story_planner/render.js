/**
 * story_planner/render.js — UI rendering and event wiring.
 *
 * Depends on all leaf modules + generation.js + injection.js.
 *
 * Arc cards are rendered into a stable `#sp-arcs` container and driven by
 * delegated listeners bound to that container. Structural changes (add, delete,
 * pin, status, section) re-render only the container's innerHTML, so the
 * delegated handlers survive; text edits save on blur without re-rendering so
 * they never fight the caret.
 */

import {
    escapeHtml, estimateTokens, notify,
    renderApiSettingsFields, readApiSettingsValues,
    createModal, showModal, hideModal,
    computeLcsDiff, renderDiffHtml,
} from '../core/index.js';
// Direct import (not the barrel) so the real helper runs under the test
// barrel→stub alias — the wireTablist precedent (accessibility Slice 2).
// setControlBusy keeps `disabled` and `aria-busy` in step on async handlers
// (a11y plan §4.4).
import { setControlBusy } from '../core/ui.js';

import { getSettings, saveSettings } from './settings.js';
import {
    state, SECTIONS, ARC_STATUSES, INJECT_MODES, ENFORCEMENT_MODES,
    setPlanData,
    getArcs, setArcs, addArc, updateArc, setArcStatus, parkArc, resumeArc, removeArc, toggleArcPinned, toggleArcFocused,
    isArcReady, getCurrentBeat, getCurrentBeatNumber, getBeatProgress, advanceBeat, retreatBeat,
    addArcBeat, updateArcBeat, setArcBeatState, removeArcBeat, moveArcBeat,
    getNudgeTurns, isNudgeEnabled, OVERDUE_TURNS,
    getPlanHistory, pushPlanToHistory, historyEntryToDiffText, historyEntryToArcs,
    isInjectionEnabled, isAutoEnabled, getAutoInterval,
    getInjectMode, getEnforcement, getDirectionHint, getArcCount, getSectionMeta,
    usesGlobalDefaults, setUsesGlobalDefaults, setPlanSetting,
} from './data.js';
import { applyPlanInjection, getArcsForInjection, buildInjectionBody, getInjectedTokenCount, getInjectionHeader } from './injection.js';
import { generatePlan } from './generation.js';
import {
    applyTargetedProposal,
    generateTargetedProposal,
    targetedOperationLabel,
} from './targeted.js';

// ─── API field IDs ───────────────────────────────────────────────────────────
// One shared map for BOTH renderApiSettingsFields and readApiSettingsValues so
// every field round-trips (the two must use identical ids).
const SP_API_FIELD_IDS = {
    urlId: 'sp-api-url', keyId: 'sp-api-key', modelId: 'sp-model',
    maxTokensId: 'sp-max-tokens', tempId: 'sp-temp',
    topPId: 'sp-top-p', freqId: 'sp-freq-pen', presId: 'sp-pres-pen', headersId: 'sp-headers',
};

const STATUS_ICONS = { active: '◆', parked: '⏸', resolved: '✓', dropped: '✕' };

/** Escape a value for use inside a quoted CSS attribute selector. */
function selectorEscape(value) {
    return globalThis.CSS?.escape
        ? globalThis.CSS.escape(String(value))
        : String(value).replace(/["\\]/g, '\\$&');
}

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

/**
 * Toolbar summary text. Single owner of this format — render() writes it into
 * the initial HTML and updateToolbarStats() rewrites it in place afterwards,
 * and the two drifting apart is exactly how the ready count went missing once.
 */
function toolbarStatsText() {
    const arcs = getArcs();
    const injected = isInjectionEnabled() ? getArcsForInjection().length : 0;
    const ready = arcs.filter(a => a.status === 'active' && isArcReady(a)).length;
    const tokens = getInjectedTokenCount();
    const auto = isAutoEnabled() ? ` · Auto: ${state.autoCounter}/${getAutoInterval()} msgs` : '';
    return `${arcs.length} arcs · ${injected} injected${ready ? ` · ${ready} ready` : ''} · ~${tokens} tokens${auto}`;
}

/** Update the arc-count / token summary in the toolbar. */
function updateToolbarStats() {
    if (!state.modal) return;
    const el = state.modal.querySelector('#sp-toolbar-stats');
    if (el) el.textContent = toolbarStatsText();
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
        // innerHTML (never a raw textContent write) so the 🔄 stays inside its
        // aria-hidden span — the initial markup in render() hides the glyph,
        // and this update must not un-hide it (Slice 4 item 2).
        el.innerHTML = `<span aria-hidden="true">🔄</span> Auto-generate: ON — generates a new plan every ${autoInterval} messages (${state.autoCounter}/${autoInterval} since last)`;
    } else {
        el.style.display = 'none';
    }
}

/**
 * Update toggle button labels to reflect current persisted state. Labels are
 * rebuilt with innerHTML so the decorative 🔌/🔄 glyphs stay inside their
 * aria-hidden spans — a textContent write would fold them into the buttons'
 * accessible names (Slice 4 item 2; must match the initial markup in render()).
 */
function refreshButtonLabels() {
    if (!state.modal) return;
    const injectBtn = state.modal.querySelector('#sp-toggle-inject');
    const autoBtn = state.modal.querySelector('#sp-toggle-auto');
    if (injectBtn) {
        injectBtn.innerHTML = isInjectionEnabled() ? '<span aria-hidden="true">🔌</span> Injection: ON' : '<span aria-hidden="true">🔌</span> Injection: OFF';
    }
    if (autoBtn) {
        const autoInterval = getAutoInterval();
        autoBtn.innerHTML = isAutoEnabled() ? `<span aria-hidden="true">🔄</span> Auto: ON (${autoInterval})` : '<span aria-hidden="true">🔄</span> Auto: OFF';
    }
}

/** Synchronize controls whose values come from the global/local scope layer. */
function refreshScopedControls() {
    if (!state.modal) return;
    const mode = getInjectMode();
    state.modal.querySelectorAll('input[name="sp-inject-mode"]').forEach(radio => {
        radio.checked = radio.value === mode;
    });
    const enforcement = getEnforcement();
    const push = state.modal.querySelector('#sp-enforcement');
    if (push) push.value = enforcement;
    const blurb = state.modal.querySelector('#sp-enforcement-blurb');
    if (blurb) blurb.textContent = ENFORCEMENT_MODES.find(m => m.key === enforcement)?.blurb || '';

    const arcCount = state.modal.querySelector('#sp-arc-count');
    if (arcCount) arcCount.value = String(getArcCount());
    const interval = state.modal.querySelector('#sp-auto-interval');
    if (interval) interval.value = String(getAutoInterval());
    const scope = state.modal.querySelector('#sp-use-global-defaults');
    if (scope) scope.checked = usesGlobalDefaults();
    const help = state.modal.querySelector('#sp-inject-mode-help');
    if (help) help.innerHTML = injectionModeHelpHtml();
}

function injectionModeHelpHtml() {
    const base = INJECT_MODES.map(m => `<strong>${escapeHtml(m.label)}:</strong> ${escapeHtml(m.blurb)}`).join(' · ');
    return `${base}${getInjectMode() === 'focused' && getArcsForInjection().length === 0
        ? ' <strong>No active arcs are focused, so nothing will be injected. Resume a focused parked arc, focus an active arc, or choose another mode.</strong>'
        : ''}`;
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
    updateToolbarStats();
    updateAutoBanner();
    refreshButtonLabels();
    refreshScopedControls();
    refreshRevertButton();
}

// ─── Arc rendering ───────────────────────────────────────────────────────────

/**
 * The beat strip: current setup step plus the controls that advance it.
 * Absent for arcs with no beats (Immediate Hooks are usable as-is).
 */
function renderBeatStrip(arc) {
    const total = arc.beats?.length || 0;
    if (total === 0 || arc.status !== 'active') return '';
    const id = escapeHtml(arc.id);
    const { done } = getBeatProgress(arc);
    const waited = arc.turnsSinceAdvance || 0;

    if (isArcReady(arc)) {
        return `
            <div class="sp-beats sp-beats--ready">
                <div class="sp-beat-line">
                    <span class="sp-beat-badge sp-beat-badge--ready">READY</span>
                    <span class="sp-beat-text">${done === total ? `All ${total} setup beats planted` : 'No setup beats are pending'} — this can happen now.</span>
                </div>
                ${done > 0 ? `<div class="sp-beat-actions">
                    <button class="mwt-btn sp-beat-back" data-action="beat-back" data-id="${id}" title="Undo the last '✓ planted'"><span aria-hidden="true">↺</span> back</button>
                </div>` : ''}
            </div>`;
    }

    const beat = getCurrentBeat(arc);
    const overdue = waited >= getNudgeTurns() ? ' sp-beat-badge--overdue' : '';
    return `
        <div class="sp-beats">
            <div class="sp-beat-line">
                <span class="sp-beat-badge${overdue}" title="${waited} turn${waited === 1 ? '' : 's'} on this beat">${getCurrentBeatNumber(arc)}/${total}</span>
                <span class="sp-beat-text">${escapeHtml(beat)}</span>
            </div>
            <div class="sp-beat-actions">
                <button class="mwt-btn sp-beat-done" data-action="beat-done" data-id="${id}"
                        title="Mark this setup as planted and move to the next beat"><span aria-hidden="true">✓</span> planted</button>
                ${done > 0 ? `<button class="mwt-btn sp-beat-back" data-action="beat-back" data-id="${id}" title="Go back a beat" aria-label="Go back a beat">↺</button>` : ''}
            </div>
        </div>`;
}

function renderBeatEditorRow(arc, beat, index) {
    const arcId = escapeHtml(arc.id);
    const currentId = arc.beats.find(candidate => candidate.state === 'pending')?.id;
    const beatId = escapeHtml(beat.id);
    const label = beat.state === 'planted' ? 'Planted'
        : beat.state === 'skipped' ? 'Skipped'
            : beat.id === currentId ? 'Current' : 'Upcoming';
    const isHistorical = beat.state !== 'pending';
    const canMoveUp = index > 0
        && (beat.state !== 'pending') === (arc.beats[index - 1].state !== 'pending');
    const canMoveDown = index < arc.beats.length - 1
        && (beat.state !== 'pending') === (arc.beats[index + 1].state !== 'pending');
    const target = escapeHtml(beat.text || `beat ${index + 1}`);
    return `
        <li class="sp-beat-row sp-beat-row--${beat.state}${beat.id === currentId ? ' sp-beat-row--current' : ''}" data-beat-id="${beatId}">
            <span class="sp-beat-state">${label}</span>
            <div class="sp-beat-edit-fields">
                <label class="mwt-sr-only" for="sp-beat-${beatId}">Setup beat ${index + 1} for ${escapeHtml(arc.title || 'untitled arc')}</label>
                <textarea id="sp-beat-${beatId}" class="sp-beat-input" rows="2" data-action="beat-text" data-id="${arcId}" data-beat-id="${beatId}">${escapeHtml(beat.text)}</textarea>
                ${beat.state === 'skipped' ? `
                    <label class="mwt-sr-only" for="sp-beat-reason-${beatId}">Optional skip reason for ${target}</label>
                    <input id="sp-beat-reason-${beatId}" class="sp-beat-reason" type="text" data-action="beat-reason" data-id="${arcId}" data-beat-id="${beatId}" value="${escapeHtml(beat.stateReason)}" placeholder="Optional skip reason">` : ''}
            </div>
            <div class="sp-beat-row-actions" role="group" aria-label="Actions for ${target}">
                <button class="mwt-btn sp-beat-icon" data-action="beat-up" data-id="${arcId}" data-beat-id="${beatId}" aria-label="Move ${target} up" ${canMoveUp ? '' : 'disabled'}>↑</button>
                <button class="mwt-btn sp-beat-icon" data-action="beat-down" data-id="${arcId}" data-beat-id="${beatId}" aria-label="Move ${target} down" ${canMoveDown ? '' : 'disabled'}>↓</button>
                ${beat.state === 'pending' ? `
                    <button class="mwt-btn" data-action="beat-plant" data-id="${arcId}" data-beat-id="${beatId}"><span aria-hidden="true">✓</span> Planted</button>
                    <button class="mwt-btn" data-action="beat-skip" data-id="${arcId}" data-beat-id="${beatId}">Skip</button>` : `
                    <button class="mwt-btn" data-action="beat-pending" data-id="${arcId}" data-beat-id="${beatId}">${isHistorical && beat.state === 'planted' ? 'Undo' : 'Restore to pending'}</button>`}
                <button class="mwt-btn mwt-btn-danger" data-action="beat-delete" data-id="${arcId}" data-beat-id="${beatId}" aria-label="Delete setup beat ${target}">Delete</button>
            </div>
        </li>`;
}

/** Expanded, maintainable sequence. State text is explicit, never color-only. */
function renderBeatEditor(arc) {
    const arcId = escapeHtml(arc.id);
    const rows = arc.beats.map((beat, index) => renderBeatEditorRow(arc, beat, index)).join('');
    const canGenerate = arc.status === 'active' && arc.section !== 'immediate' && arc.beats.length === 0;
    return `
        <details class="sp-beat-editor" data-beat-editor-id="${arcId}">
            <summary><span>Setup beats</span><span class="sp-beat-editor-count">${arc.beats.length}</span></summary>
            <p class="sp-beat-editor-help">Historical beats (Planted or Skipped) stay before pending beats. Skip records that an event did not happen; Delete permanently removes the record.</p>
            ${rows ? `<ol class="sp-beat-list">${rows}</ol>` : '<p class="sp-beat-empty">No setup beats yet.</p>'}
            <div class="sp-beat-editor-actions">
                <button class="mwt-btn" data-action="beat-add" data-id="${arcId}">+ Add setup beat</button>
                ${canGenerate ? `<button class="mwt-btn" data-action="target-setup" data-id="${arcId}" aria-describedby="sp-generate-beats-help-${arcId}">Generate setup beats</button>` : ''}
            </div>
            ${canGenerate ? `<p id="sp-generate-beats-help-${arcId}" class="sp-beat-editor-help">Generates a reviewable route without changing this arc until you apply it.</p>` : ''}
        </details>`;
}

function renderArcCard(arc) {
    const dimmed = arc.status !== 'active' ? ' sp-arc--muted' : '';
    const pinnedCls = arc.pinned ? ' sp-arc--pinned' : '';
    const readyCls = isArcReady(arc) && arc.status === 'active' ? ' sp-arc--ready' : '';
    return `
        <div class="sp-arc sp-arc--${escapeHtml(arc.status)}${dimmed}${pinnedCls}${readyCls}" data-id="${escapeHtml(arc.id)}">
            <div class="sp-arc-head">
                <button class="sp-pin" data-action="pin" data-id="${escapeHtml(arc.id)}"
                        title="${arc.pinned ? 'Unpin' : 'Pin — keeps this arc through regeneration'}" aria-label="${arc.pinned ? `Unpin arc ${escapeHtml(arc.title || 'untitled')}` : `Pin arc ${escapeHtml(arc.title || 'untitled')}`}">${arc.pinned ? '📌' : '📍'}</button>
                <button class="sp-focus" data-action="focus" data-id="${escapeHtml(arc.id)}"
                        title="${arc.focused ? 'Remove focus' : 'Focus this arc for focused-only injection'}" aria-label="${arc.focused ? `Unfocus arc ${escapeHtml(arc.title || 'untitled')}` : `Focus arc ${escapeHtml(arc.title || 'untitled')}`}">${arc.focused ? '🎯' : '○'}</button>
                <input type="text" class="sp-arc-title" data-action="title" data-id="${escapeHtml(arc.id)}"
                       value="${escapeHtml(arc.title)}" placeholder="Arc name" aria-label="Arc name">
                ${arc.status === 'active'
                    ? `<button class="mwt-btn sp-lifecycle" data-action="park" data-id="${escapeHtml(arc.id)}" title="Park this arc without deleting it">Park</button>`
                    : arc.status === 'parked'
                        ? `<button class="mwt-btn sp-lifecycle" data-action="resume" data-id="${escapeHtml(arc.id)}" title="Resume this parked arc">Resume</button>`
                        : ''}
                <button class="sp-arc-del" data-action="delete" data-id="${escapeHtml(arc.id)}" title="Delete arc" aria-label="Delete arc">🗑</button>
            </div>
            <textarea class="sp-arc-body" data-action="body" data-id="${escapeHtml(arc.id)}" rows="2"
                      placeholder="What shift does this arc introduce?" aria-label="Arc description for ${escapeHtml(arc.title || 'untitled arc')}">${escapeHtml(arc.body)}</textarea>
            ${arc.status === 'parked' ? `<div class="sp-activate-when">
                <label for="sp-activate-when-${escapeHtml(arc.id)}">Resume when</label>
                <input id="sp-activate-when-${escapeHtml(arc.id)}" type="text" class="mwt-input" data-action="activateWhen" data-id="${escapeHtml(arc.id)}"
                       value="${escapeHtml(arc.activateWhen || '')}" placeholder="Optional note for your future self"
                       aria-label="Resume when note for ${escapeHtml(arc.title || 'untitled arc')}">
            </div>` : ''}
            ${renderBeatStrip(arc)}
            ${renderBeatEditor(arc)}
            ${arc.status === 'active' ? `<div class="sp-target-actions" role="group" aria-label="Targeted development for ${escapeHtml(arc.title || 'this arc')}">
                <button class="mwt-btn" data-action="target-rework" data-id="${escapeHtml(arc.id)}">Rework remaining setup</button>
                <button class="mwt-btn" data-action="target-develop" data-id="${escapeHtml(arc.id)}">Develop this arc</button>
                <button class="mwt-btn" data-action="target-alternate" data-id="${escapeHtml(arc.id)}">Suggest an alternate route</button>
            </div>` : ''}
            <div class="sp-arc-foot">
                <select class="sp-arc-section" data-action="section" data-id="${escapeHtml(arc.id)}" title="Move to another section">
                    ${SECTIONS.map(s => `<option value="${s.key}" ${s.key === arc.section ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
                </select>
                <select class="sp-arc-status" data-action="status" data-id="${escapeHtml(arc.id)}" title="Arc status">
                    ${ARC_STATUSES.map(st => `<option value="${st}" ${st === arc.status ? 'selected' : ''}>${STATUS_ICONS[st]} ${st[0].toUpperCase()}${st.slice(1)}</option>`).join('')}
                </select>
            </div>
        </div>`;
}

/**
 * Label for a section header's arc count.
 *
 * Only mentions injection when some arcs are being HELD BACK — "1 · 1 injected"
 * is pure noise and reads like a warning. Silence means "all of these are
 * reaching the AI", which is the normal case.
 */
function sectionCountLabel(total, injected) {
    if (total === 0) return 'empty';
    const arcs = `${total} arc${total === 1 ? '' : 's'}`;
    if (injected === total) return arcs;
    if (injected === 0) return `${arcs} · none injected`;
    return `${arcs} · only ${injected} injected`;
}

function renderArcsInner() {
    const arcs = getArcs();
    if (arcs.length === 0) {
        return `<div class="sp-empty">
            <p>No arcs yet.</p>
            <p class="mwt-text-dim mwt-text-sm">Click <strong>🎲 Generate Plan</strong> to brainstorm from your story so far, or add one manually below.</p>
            <button class="mwt-btn sp-add" data-action="add" data-section="emerging">+ Add Arc</button>
        </div>`;
    }

    const injectedIds = new Set(getArcsForInjection().map(a => a.id));

    const active = arcs.filter(arc => arc.status === 'active');
    const ready = active.filter(isArcReady);
    const pending = active.filter(arc => !isArcReady(arc));
    const parked = arcs.filter(arc => arc.status === 'parked');
    const archived = arcs.filter(arc => arc.status === 'resolved' || arc.status === 'dropped');
    const focusedFirst = list => [...list].sort((a, b) => (b.focused === true) - (a.focused === true));
    const group = ({ key, title, blurb, list, open = false }) => {
        const injectedHere = list.filter(a => injectedIds.has(a.id)).length;
        return `<details class="sp-section sp-section--lifecycle" data-section="${key}" ${open ? 'open' : ''}>
            <summary class="sp-section-head">
                <span class="sp-section-title">${escapeHtml(title)}</span>
                <span class="sp-section-count">${sectionCountLabel(list.length, injectedHere)}</span>
            </summary>
            <p class="sp-section-blurb">${escapeHtml(blurb)}</p>
            <div class="sp-section-arcs">${focusedFirst(list).map(renderArcCard).join('')}</div>
        </details>`;
    };

    const readyGroup = ready.length ? group({
        key: 'ready', title: 'Ready Now',
        blurb: 'Setup is complete; these arcs can pay off when the scene allows.',
        list: ready, open: true,
    }) : '';
    const activeSections = SECTIONS.map(sec => {
        const inSection = pending.filter(a => a.section === sec.key);
        const injectedHere = inSection.filter(a => injectedIds.has(a.id)).length;
        return `
        <details class="sp-section" data-section="${sec.key}" ${inSection.length ? 'open' : ''}>
            <summary class="sp-section-head">
                <span class="sp-section-title">${escapeHtml(sec.label)}</span>
                <span class="sp-section-count">${sectionCountLabel(inSection.length, injectedHere)}</span>
            </summary>
            <p class="sp-section-blurb">${escapeHtml(sec.blurb)}</p>
            <div class="sp-section-arcs">${inSection.map(renderArcCard).join('')}</div>
            <button class="mwt-btn sp-add" data-action="add" data-section="${sec.key}">+ Add Arc</button>
        </details>`;
    }).join('');
    const parkedGroup = parked.length ? group({
        key: 'parked', title: 'Parked',
        blurb: 'Saved for later. Parked arcs do not age, remind, regenerate, or inject.',
        list: parked,
    }) : '';
    const archiveGroup = archived.length ? group({
        key: 'archive', title: 'Archive',
        blurb: 'Resolved and dropped arcs are retained as planning memory but never injected.',
        list: archived,
    }) : '';
    return readyGroup + activeSections + parkedGroup + archiveGroup;
}

/**
 * Re-render just the arc list. The `#sp-arcs` container element itself is
 * preserved, so the delegated listeners bound to it in wireEvents() survive.
 */
function renderArcs({ openSection = '', focusArcId = '', focusAction = 'resume' } = {}) {
    if (!state.modal) return;
    const host = state.modal.querySelector('#sp-arcs');
    if (!host) return;
    // Preserve disclosure state only for populated groups. An empty section's
    // stale closed state must not hide the first card later moved into it.
    const sectionState = new Map(
        [...host.querySelectorAll('.sp-section')]
            .filter(d => d.querySelector('.sp-arc'))
            .map(d => [d.dataset.section, d.open]),
    );
    const openEditors = new Set(
        [...host.querySelectorAll('.sp-beat-editor[open]')].map(d => d.dataset.beatEditorId),
    );
    const active = typeof document !== 'undefined' && host.contains(document.activeElement)
        ? {
            action: document.activeElement.dataset?.action,
            id: document.activeElement.dataset?.id,
            beatId: document.activeElement.dataset?.beatId,
            value: ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
                ? document.activeElement.value : undefined,
            valueAction: ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
                ? document.activeElement.dataset?.action : undefined,
            selectionStart: typeof document.activeElement.selectionStart === 'number' ? document.activeElement.selectionStart : null,
            selectionEnd: typeof document.activeElement.selectionEnd === 'number' ? document.activeElement.selectionEnd : null,
        }
        : null;
    // Where the focused control's beat row sits, captured before the swap
    // removes it: a deleted beat has no row left to restore, so focus should
    // move to the surviving row that takes its place (or the last one).
    const activeRow = active?.beatId
        ? host.querySelector(`.sp-beat-row[data-beat-id="${selectorEscape(active.beatId)}"]`)
        : null;
    const activeRowIndex = activeRow
        ? [...activeRow.parentElement.children].filter(el => el.classList.contains('sp-beat-row')).indexOf(activeRow)
        : -1;
    host.innerHTML = renderArcsInner();
    host.querySelectorAll('.sp-section').forEach(d => {
        if (sectionState.has(d.dataset.section)) d.open = sectionState.get(d.dataset.section);
        if (d.dataset.section === openSection) d.open = true;
    });
    host.querySelectorAll('.sp-beat-editor').forEach(d => {
        if (openEditors.has(d.dataset.beatEditorId)) d.open = true;
    });
    if (active?.action && active.id) {
        const arcSel = `[data-id="${selectorEscape(active.id)}"]`;
        const exact = host.querySelector(`[data-action="${active.action}"]${arcSel}${active.beatId ? `[data-beat-id="${selectorEscape(active.beatId)}"]` : ''}`);
        const beatText = active.beatId
            ? host.querySelector(`[data-action="beat-text"]${arcSel}[data-beat-id="${selectorEscape(active.beatId)}"]`)
            : null;
        // The beat row itself is gone (delete): hand focus to the surviving
        // neighbor that now occupies its slot, preferring the same action so
        // repeated deletes stay on one key.
        const rows = host.querySelectorAll(`.sp-beat-editor[data-beat-editor-id="${selectorEscape(active.id)}"] .sp-beat-row`);
        const neighborRow = activeRowIndex >= 0 ? rows[Math.min(activeRowIndex, rows.length - 1)] : null;
        const neighbor = neighborRow
            ? (neighborRow.querySelector(`[data-action="${active.action}"]${arcSel}:not([disabled])`) || neighborRow.querySelector('[data-action="beat-text"]'))
            : null;
        // Last landmark: the arc's Setup-beats summary, which survives every
        // beat mutation — e.g. ✓ planted on the final pending beat from the
        // compact strip removes its own initiating control.
        const summary = host.querySelector(`.sp-beat-editor[data-beat-editor-id="${selectorEscape(active.id)}"] > summary`);
        const focusTarget = exact && !exact.disabled ? exact : beatText || neighbor || summary;
        focusTarget?.focus();
        if (focusTarget === exact && active.value !== undefined && active.action === active.valueAction
            && focusTarget.dataset?.action === active.valueAction && 'value' in focusTarget) {
            focusTarget.value = active.value;
            if (active.selectionStart !== null && typeof focusTarget.setSelectionRange === 'function') {
                focusTarget.setSelectionRange(active.selectionStart, active.selectionEnd);
            }
        }
    }
    if (focusArcId) {
        host.querySelector(`[data-action="${focusAction}"][data-id="${selectorEscape(focusArcId)}"]`)?.focus();
    }
    refreshDisplay();
}

/** Update the compact beat strip without replacing the editor DOM. */
function refreshBeatStrip(arc) {
    if (!state.modal || !arc) return;
    const card = state.modal.querySelector(`.sp-arc[data-id="${selectorEscape(arc.id)}"]`);
    const strip = card?.querySelector('.sp-beats');
    const beat = getCurrentBeat(arc);
    if (!strip || !beat || isArcReady(arc)) return;

    const { total } = getBeatProgress(arc);
    const waited = arc.turnsSinceAdvance || 0;
    const badge = strip.querySelector('.sp-beat-badge');
    const text = strip.querySelector('.sp-beat-text');
    if (text) text.textContent = beat;
    if (badge) {
        badge.textContent = `${getCurrentBeatNumber(arc)}/${total}`;
        badge.classList.toggle('sp-beat-badge--overdue', waited >= getNudgeTurns());
        badge.title = `${waited} turn${waited === 1 ? '' : 's'} on this beat`;
    }
}

// ─── Render ──────────────────────────────────────────────────────────────────

export function render() {
    const s = getSettings();
    const autoEnabled = isAutoEnabled();
    const autoInterval = getAutoInterval();
    const mode = getInjectMode();
    const enforcement = getEnforcement();

    return `
        <div class="ws-toolbar mwt-flex mwt-gap-4 mwt-mb-8" style="flex-wrap:wrap">
            <button id="sp-generate" class="mwt-btn mwt-btn-primary"><span aria-hidden="true">🎲</span> Generate Plan</button>
            <button id="sp-revert" class="mwt-btn" ${getPlanHistory().length === 0 ? 'disabled' : ''}><span aria-hidden="true">⏪</span> Revert</button>
            <button id="sp-history" class="mwt-btn"><span aria-hidden="true">📋</span> History</button>
            <button id="sp-preview" class="mwt-btn"><span aria-hidden="true">👁</span> Preview Injection</button>
            <button id="sp-clear" class="mwt-btn mwt-btn-danger"><span aria-hidden="true">🗑️</span> Clear</button>
            <span id="sp-toolbar-stats" class="mwt-text-dim mwt-text-sm" style="margin-left:auto;line-height:28px">${escapeHtml(toolbarStatsText())}</span>
        </div>

        <div class="sp-inject-modes mwt-flex mwt-gap-8 mwt-mb-8" style="flex-wrap:wrap;align-items:center">
            <span class="mwt-text-dim mwt-text-sm">Inject:</span>
            ${INJECT_MODES.map(m => `
                <label class="sp-mode-label" for="sp-inject-mode-${m.key}">
                    <input type="radio" id="sp-inject-mode-${m.key}" name="sp-inject-mode" value="${m.key}" aria-describedby="sp-inject-mode-help" ${m.key === mode ? 'checked' : ''}> ${escapeHtml(m.label)}
                </label>`).join('')}

            <span class="mwt-text-dim mwt-text-sm" style="margin-left:12px">Push:</span>
            <select id="sp-enforcement" class="sp-enforcement" title="How hard the AI is pushed to act on the plan" aria-label="Push (enforcement)">
                ${ENFORCEMENT_MODES.map(m => `<option value="${m.key}" ${m.key === enforcement ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
            </select>
            <span id="sp-enforcement-blurb" class="mwt-text-dim mwt-text-sm">${escapeHtml(ENFORCEMENT_MODES.find(m => m.key === enforcement)?.blurb || '')}</span>
        </div>
        <p id="sp-inject-mode-help" class="mwt-text-dim mwt-text-sm" style="margin:0 0 8px">${injectionModeHelpHtml()}</p>

        <div id="sp-arcs" class="sp-arcs">${renderArcsInner()}</div>

        <div id="sp-auto-banner" style="color:var(--mwt-accent);font-size:12px;margin:8px 0 4px;${autoEnabled ? '' : 'display:none'}">${autoEnabled ? `<span aria-hidden="true">🔄</span> Auto-generate: ON — generates a new plan every ${autoInterval} messages (${state.autoCounter}/${autoInterval} since last)` : ''}</div>

        <details class="mwt-mt-8">
            <summary style="cursor:pointer;color:var(--mwt-accent);font-weight:500"><span aria-hidden="true">⚙️</span> Story Planner Settings</summary>
            <div class="mwt-settings-grid mwt-mt-8">
                ${renderApiSettingsFields(s, { ...SP_API_FIELD_IDS, includeAdvanced: true, includeHeaders: true })}

                <div class="mwt-label">Settings Scope</div>
                <div>
                    <label class="sp-mode-label" for="sp-use-global-defaults"><input id="sp-use-global-defaults" type="checkbox" ${usesGlobalDefaults() ? 'checked' : ''}> Use global defaults</label>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">When checked, Inject, Push, Arcs Per Generation, Auto, and its interval are shared by new and existing chats. Uncheck to override them for this chat.</p>
                </div>

                <label class="mwt-label" for="sp-direction-hint">Direction Hint</label>
                <div>
                    <textarea id="sp-direction-hint" class="mwt-input" rows="2" placeholder="e.g. more political intrigue, ease off the romance, I want a villain arc">${escapeHtml(getDirectionHint())}</textarea>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Steers the next generation. Leave blank for none. Saved per chat.</p>
                </div>

                <label class="mwt-label" for="sp-arc-count">Arcs Per Generation</label>
                <div>
                    <input id="sp-arc-count" class="mwt-input" type="number" value="${getArcCount()}" min="3" max="30" style="max-width:100px">
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">How many arcs to ask for (3–30). Fewer, tighter arcs vs. a sprawling menu.</p>
                </div>

                <label class="mwt-label" for="sp-injection-depth">Injection Depth</label>
                <input id="sp-injection-depth" class="mwt-input" type="number" value="${s.injectionDepth ?? 4}" min="0" max="999">

                <label class="mwt-label" for="sp-custom-system-prompt">Custom System Prompt</label>
                <textarea id="sp-custom-system-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customSystemPrompt || '')}</textarea>
                <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Overrides the system prompt sent to the AI when generating a plan. Leave blank to use the built-in default. Note: the default prompt defines the section headings the plan is parsed into — a custom prompt that uses different headings will have its arcs filed under "${escapeHtml(getSectionMeta('emerging').label)}".</p>

                <label class="mwt-label" for="sp-custom-user-prompt">Custom User Prompt</label>
                <div>
                    <textarea id="sp-custom-user-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customUserPrompt || '')}</textarea>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Overrides the user task prompt. Supports tokens: <code>{{chatHistory}}</code>, <code>{{worldState}}</code>, <code>{{lastChronicle}}</code>, <code>{{previousPlan}}</code>, <code>{{directionHint}}</code>, <code>{{arcCount}}</code>. Each resolves to empty if that data isn't available. Leave blank for default.</p>
                </div>

                <label class="mwt-label" for="sp-auto-interval">Auto-Generate Interval</label>
                <div>
                    <input id="sp-auto-interval" class="mwt-input" type="number" value="${autoInterval}" min="1" max="100" style="max-width:100px">
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">When auto-generate is ON, a new plan is generated every N messages (counted on AI replies).</p>
                </div>

                <div class="mwt-label">Beat Reminder</div>
                <div>
                    <label class="sp-mode-label" for="sp-nudge-enabled">
                        <input id="sp-nudge-enabled" type="checkbox" ${isNudgeEnabled() ? 'checked' : ''}> Remind me after
                    </label>
                    <input id="sp-nudge-turns" class="mwt-input" type="number" value="${getNudgeTurns()}" min="3" max="60" style="max-width:80px" aria-label="Remind me after this many turns">
                    <span class="mwt-text-dim mwt-text-sm">turns</span>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">
                        Uses no API calls. When a setup beat has gone this many turns without being marked planted,
                        you get a toast — type <code>/wt-beat</code> in chat to see the waiting beats and
                        <code>/wt-beat 2</code> to mark one planted, without opening this panel. The same threshold
                        marks a beat overdue on its card and tells the AI it has been waiting.
                    </p>
                </div>

                <div></div>
                <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                    <button id="sp-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button>
                    <button id="sp-toggle-inject" class="mwt-btn">${isInjectionEnabled() ? '<span aria-hidden="true">🔌</span> Injection: ON' : '<span aria-hidden="true">🔌</span> Injection: OFF'}</button>
                    <button id="sp-toggle-auto" class="mwt-btn">${autoEnabled ? `<span aria-hidden="true">🔄</span> Auto: ON (${autoInterval})` : '<span aria-hidden="true">🔄</span> Auto: OFF'}</button>
                </div>
            </div>
        </details>

        <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:12px">
            Long-range arcs carry <strong>setup beats</strong> — small concrete steps toward the arc. Only the
            <em>current</em> beat is sent to the AI, as a "NOW:" instruction, so it plants one thing at a time instead of
            being told to vaguely "build toward" something. When you see that setup land in the story, click
            <strong>✓ planted</strong> to move to the next beat. Once every beat is planted the arc becomes
            <strong>Ready</strong> and is offered to the AI as usable immediately.
            <br><br>
            You do not have to come back here to do that: <code>/wt-beat</code> lists the waiting beats in chat and
            <code>/wt-beat 2</code> marks one planted. If a beat sits unmarked too long you get a reminder, and the
            🗺️ floating button shows how many are waiting (amber once any is overdue).
            <br><br>
            Edit any arc directly; changes save automatically. <strong>Pin</strong> an arc to keep it through regeneration
            (arcs with planted beats are kept automatically). <strong>Focus</strong> an arc to prioritize it and include it in Focused-only injection.
            <strong>Park</strong> an arc to keep it without injecting or aging it. Mark one <strong>Resolved</strong> or <strong>Dropped</strong>
            to close it. <strong>Auto-generate</strong> refreshes the plan on a timer;
            <strong>injection</strong> controls whether it reaches the AI.
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

/** Apply a snapshot as the current plan, syncing UI + injection. */
function restorePlan(arcs, { pushCurrent = true } = {}) {
    const current = getArcs();
    if (pushCurrent && current.length) pushPlanToHistory(current);
    setArcs(arcs);
    applyPlanInjection();
    renderArcs();
}

/** Diff the current plan against the most recent snapshot, with a Revert button. */
function showRevertDiff() {
    const history = getPlanHistory();
    if (history.length === 0) { alert('No history available to revert to.'); return; }

    const latest = history[history.length - 1];
    const diffHtml = renderDiffHtml(computeLcsDiff(historyEntryToDiffText({ arcs: getArcs() }), historyEntryToDiffText(latest)));

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
        restorePlan(historyEntryToArcs(latest));
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

    const items = history.slice().reverse().map((h, i) => {
        const idx = history.length - 1 - i;
        const count = Array.isArray(h.arcs) ? `${h.arcs.length} arcs` : `${(h.text || '').length} chars`;
        return `
        <div class="mwt-history-item" style="padding:8px;border-bottom:1px solid var(--mwt-border);cursor:pointer" data-idx="${idx}">
            <span class="mwt-text-dim mwt-text-sm">${new Date(h.timestamp).toLocaleString()}</span>
            <span class="mwt-text-dim mwt-text-sm"> — ${count}</span>
        </div>`;
    }).join('');

    const histModal = createModal({
        id: 'mwt-sp-history-modal',
        title: 'Story Plan History',
        content: `<div>${items}</div>`,
    });

    histModal.querySelectorAll('.mwt-history-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            const entry = history[idx];
            const diffHtml = renderDiffHtml(computeLcsDiff(historyEntryToDiffText({ arcs: getArcs() }), historyEntryToDiffText(entry)));
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
                restorePlan(historyEntryToArcs(entry));
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

/** Show exactly what the current settings would inject. */
export function injectionPreviewEmptyText() {
    return getInjectMode() === 'focused'
        ? 'Nothing would be injected because no active arcs are focused.'
        : 'Nothing would be injected.';
}

function showInjectionPreview() {
    const body = buildInjectionBody();
    const enabled = isInjectionEnabled();
    const modeLabel = INJECT_MODES.find(mode => mode.key === getInjectMode())?.label || getInjectMode();
    const tokens = enabled && body ? estimateTokens(`${getInjectionHeader()}\n\n${body}`) : 0;
    const previewModal = createModal({
        id: 'mwt-sp-preview-modal',
        title: 'Story Plan — Injection Preview',
        content: `
            <p class="mwt-text-dim mwt-text-sm mwt-mb-8">
                Mode: <strong>${escapeHtml(modeLabel)}</strong> ·
                ${enabled ? getArcsForInjection().length : 0} arcs ·
                ~${tokens} tokens ·
                Injection is <strong>${enabled ? 'ON' : 'OFF'}</strong>
            </p>
            <pre class="mwt-textarea" style="white-space:pre-wrap;max-height:50vh;overflow:auto">${escapeHtml(body || injectionPreviewEmptyText())}</pre>
            <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                <button id="mwt-sp-preview-close" class="mwt-btn">Close</button>
            </div>
        `,
    });
    previewModal.querySelector('#mwt-sp-preview-close')?.addEventListener('click', () => {
        hideModal('mwt-sp-preview-modal');
    });
    showModal('mwt-sp-preview-modal');
}

// ─── Arc interaction (delegated) ─────────────────────────────────────────────

/** Persist a UI mutation and re-register when any narrator-facing text changes. */
function mutateWithProjectionCheck(mutate) {
    const before = `${getInjectionHeader()}\n\n${buildInjectionBody()}`;
    const result = mutate();
    if (`${getInjectionHeader()}\n\n${buildInjectionBody()}` !== before) applyPlanInjection();
    return result;
}

function renderTargetedDiff(proposal) {
    const fieldRows = proposal.diff.fields.map(change => `
        <li><strong>${escapeHtml(change.field)}</strong><div class="sp-proposal-change">
            <del>${escapeHtml(change.before || '(empty)')}</del>
            <ins>${escapeHtml(change.after || '(empty)')}</ins>
        </div></li>`).join('');
    const beatRows = proposal.diff.beats.map(change => {
        // A "moved" beat only changes position, not content — strike-through
        // styling (<del>/<ins>) implies removal, so render it as a plain
        // "Position N → M" line instead. Other kinds (added/removed/changed)
        // are genuine content edits and keep the del/ins treatment.
        if (change.kind === 'moved') {
            return `
        <li><strong>${escapeHtml(change.kind)}</strong><div class="sp-proposal-change">
            <span class="sp-proposal-move">Position ${escapeHtml(change.before)} → ${escapeHtml(change.after)}</span>
        </div></li>`;
        }
        return `
        <li><strong>${escapeHtml(change.kind)}</strong><div class="sp-proposal-change">
            ${change.before ? `<del>${escapeHtml(change.before)}</del>` : ''}
            ${change.after ? `<ins>${escapeHtml(change.after)}</ins>` : ''}
        </div></li>`;
    }).join('');
    const noChanges = !fieldRows && !beatRows
        ? '<p class="mwt-text-dim">The proposal is identical to the current arc.</p>' : '';
    return `${noChanges}
        ${fieldRows ? `<h4>Fields</h4><ul class="sp-proposal-diff">${fieldRows}</ul>` : ''}
        ${beatRows ? `<h4>Pending beats</h4><ul class="sp-proposal-diff">${beatRows}</ul>` : ''}`;
}

function showTargetedProposal(proposal) {
    const stale = proposal.stale;
    const finishReview = () => {
        if (!state.targetedReviewOpen && !state.isGenerating) return;
        state.isGenerating = false;
        state.targetedReviewOpen = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    };
    const modal = createModal({
        id: 'mwt-sp-targeted-modal',
        title: `${targetedOperationLabel(proposal.operation)} — Review`,
        destroyOnClose: true,
        onClose: finishReview,
        content: `
            <p class="mwt-text-dim mwt-text-sm">Review this proposal. Nothing changes until you choose Apply.</p>
            ${stale ? `<p class="sp-proposal-stale" role="alert">${escapeHtml(proposal.staleReason)} Generate again to apply changes.</p>` : ''}
            ${renderTargetedDiff(proposal)}
            <div class="mwt-flex mwt-gap-8 mwt-mt-8 sp-proposal-actions">
                <button id="mwt-sp-targeted-apply" class="mwt-btn mwt-btn-primary" ${stale ? 'disabled' : ''}>Apply</button>
                <button id="mwt-sp-targeted-discard" class="mwt-btn">Discard</button>
            </div>`,
    });
    modal.querySelector('#mwt-sp-targeted-apply')?.addEventListener('click', () => {
        const result = mutateWithProjectionCheck(() => applyTargetedProposal(proposal));
        if (!result.ok) {
            const apply = modal.querySelector('#mwt-sp-targeted-apply');
            if (apply) apply.disabled = true;
            const message = result.reason === 'source-deleted' ? 'The source arc was deleted.'
                : result.reason === 'source-changed' ? 'The source arc changed after this review opened.'
                    : result.reason === 'scope-changed' ? 'The chat changed after this review opened.'
                        : result.reason === 'no-changes' ? 'There is nothing to apply; the arc is already up to date.'
                            : result.reason === 'store-paused' ? 'Story Planner is paused for this chat. No changes were applied.'
                        : 'This proposal can no longer be applied.';
            modal.querySelector('.mwt-modal-body')?.insertAdjacentHTML('afterbegin', `<p class="sp-proposal-stale" role="alert">${escapeHtml(message)} Generate again.</p>`);
            return;
        }
        finishReview();
        hideModal('mwt-sp-targeted-modal');
        renderArcs();
        notify('Story Planner', `${targetedOperationLabel(proposal.operation)} applied.`, 'success');
    });
    modal.querySelector('#mwt-sp-targeted-discard')?.addEventListener('click', () => {
        finishReview();
        hideModal('mwt-sp-targeted-modal');
    });
    if (!showModal('mwt-sp-targeted-modal')) {
        // createModal() leaves the proposal hidden when another dialog owns
        // focus. Do not leave the generation/review guards set in that case.
        finishReview();
        hideModal('mwt-sp-targeted-modal');
    }
}

async function runTargetedAction(button, arcId, operation) {
    if (state.isGenerating || state.targetedReviewOpen) return;
    const oldHtml = button.innerHTML;
    state.isGenerating = true;
    state.targetedActionInFlight = true;
    state.targetedReviewOpen = false;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    try {
        setControlBusy(button, true);
        button.innerHTML = '<span aria-hidden="true">⏳</span> Generating…';
        const proposal = await generateTargetedProposal(arcId, operation);
        if (proposal) {
            state.targetedActionInFlight = false;
            state.targetedReviewOpen = true;
            showTargetedProposal(proposal);
        } else {
            state.targetedActionInFlight = false;
            state.isGenerating = false;
            document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        }
    } catch (err) {
        state.targetedActionInFlight = false;
        state.isGenerating = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        notify('Story Planner', `${targetedOperationLabel(operation)} failed: ${err.message}`, 'error');
    } finally {
        setControlBusy(button, false);
        button.innerHTML = oldHtml;
    }
}

/** Structural card actions: pin, focus, delete, add. */
function handleArcsClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'TEXTAREA' || btn.tagName === 'SELECT') return;
    const action = btn.dataset.action;

    if (action === 'add') {
        const arc = mutateWithProjectionCheck(() => addArc({ section: btn.dataset.section || 'emerging' }));
        renderArcs();
        // Focus the new card so the user can type straight away.
        const input = state.modal?.querySelector(`.sp-arc[data-id="${selectorEscape(arc.id)}"] .sp-arc-title`);
        input?.focus();
        return;
    }

    const id = btn.dataset.id;
    if (!id) return;
    const beatId = btn.dataset.beatId;

    if (action.startsWith('target-')) {
        runTargetedAction(btn, id, action.slice('target-'.length));
    } else if (action === 'beat-done') {
        mutateWithProjectionCheck(() => advanceBeat(id));
        renderArcs();
    } else if (action === 'beat-back') {
        mutateWithProjectionCheck(() => retreatBeat(id));
        renderArcs();
    } else if (action === 'beat-add') {
        const editor = btn.closest('.sp-beat-editor');
        const list = editor?.querySelector('.sp-beat-list')
            || (() => {
                const created = document.createElement('ol');
                created.className = 'sp-beat-list';
                editor?.querySelector('.sp-beat-empty')?.replaceWith(created);
                return created;
            })();
        if (!editor || !list || editor.querySelector('[data-action="beat-new"]')) return;
        const row = document.createElement('li');
        const draftId = `sp-beat-new-${id}`;
        row.className = 'sp-beat-row sp-beat-row--pending sp-beat-row--current';
        row.innerHTML = `<span class="sp-beat-state">New</span><div class="sp-beat-edit-fields"><label class="mwt-sr-only" for="${escapeHtml(draftId)}">New setup beat</label><textarea id="${escapeHtml(draftId)}" class="sp-beat-input" rows="2" data-action="beat-new" data-id="${escapeHtml(id)}" placeholder="Describe the setup beat"></textarea></div>`;
        list.appendChild(row);
        editor.open = true;
        btn.disabled = true;
        row.querySelector('textarea')?.focus();
    } else if (action === 'beat-up' || action === 'beat-down') {
        mutateWithProjectionCheck(() => moveArcBeat(id, beatId, action === 'beat-up' ? 'up' : 'down'));
        renderArcs();
    } else if (action === 'beat-plant') {
        mutateWithProjectionCheck(() => setArcBeatState(id, beatId, 'planted'));
        renderArcs();
    } else if (action === 'beat-pending') {
        mutateWithProjectionCheck(() => setArcBeatState(id, beatId, 'pending'));
        renderArcs();
    } else if (action === 'beat-skip') {
        const reason = prompt('Why skip this setup beat? (Optional — leave blank if no reason is needed.)', '');
        if (reason === null) return;
        mutateWithProjectionCheck(() => setArcBeatState(id, beatId, 'skipped', reason));
        renderArcs();
    } else if (action === 'beat-delete') {
        const beat = getArcs().find(arc => arc.id === id)?.beats.find(candidate => candidate.id === beatId);
        if (!beat || !confirm(`Delete the setup beat "${beat.text}" permanently? This is different from Skip, which keeps the beat as history.`)) return;
        mutateWithProjectionCheck(() => removeArcBeat(id, beatId));
        renderArcs();
    } else if (action === 'pin') {
        mutateWithProjectionCheck(() => toggleArcPinned(id));
        renderArcs();
    } else if (action === 'focus') {
        mutateWithProjectionCheck(() => toggleArcFocused(id));
        renderArcs();
    } else if (action === 'park') {
        mutateWithProjectionCheck(() => parkArc(id));
        renderArcs({ openSection: 'parked', focusArcId: id });
    } else if (action === 'resume') {
        const resumed = mutateWithProjectionCheck(() => resumeArc(id));
        renderArcs({
            openSection: resumed && isArcReady(resumed) ? 'ready' : resumed?.section,
            focusArcId: id,
            focusAction: 'park',
        });
    } else if (action === 'delete') {
        const arc = getArcs().find(a => a.id === id);
        const name = arc?.title ? `"${arc.title}"` : 'this arc';
        if (!confirm(`Delete ${name}? You can restore it with Revert (use Resolved, Dropped, or Parked to retain it without injecting).`)) return;
        mutateWithProjectionCheck(() => removeArc(id));
        renderArcs();
    }
}

/** Section / status dropdowns — both restructure the list, so re-render. */
function handleArcsChange(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    if (!id) return;

    if (action === 'section') {
        mutateWithProjectionCheck(() => updateArc(id, { section: el.value }));
    } else if (action === 'status') {
        mutateWithProjectionCheck(() => setArcStatus(id, el.value));
    } else {
        return;
    }
    renderArcs();
}

/**
 * Text edits save on blur — never re-render here, or the caret is lost mid-edit.
 * Mirrors the blur-autosave the single textarea used before the arc rework.
 */
function handleArcsBlur(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    const beatId = el.dataset.beatId;
    if (!id || !['title', 'body', 'activateWhen', 'beat-new', 'beat-text', 'beat-reason'].includes(action)) return;

    const arc = getArcs().find(a => a.id === id);
    if (!arc) return;
    const value = el.value.trim();
    if (action === 'beat-new') {
        if (!value) {
            const editor = el.closest('.sp-beat-editor');
            el.closest('.sp-beat-row')?.remove();
            editor?.querySelector('[data-action="beat-add"]')?.removeAttribute('disabled');
            if (!editor?.querySelector('.sp-beat-row')) {
                editor?.querySelector('.sp-beat-list')?.remove();
                editor?.querySelector('.sp-beat-editor-help')?.insertAdjacentHTML('afterend', '<p class="sp-beat-empty">No setup beats yet.</p>');
            }
            return;
        }
        const updated = mutateWithProjectionCheck(() => addArcBeat(id, value));
        if (!updated) return;
        // Adding a beat can change the arc's Ready state and therefore its
        // lifecycle group, compact strip, and generate-beats controls. A row-
        // only update leaves those card-level projections stale.
        renderArcs({ openSection: isArcReady(updated) ? 'ready' : updated.section });
        return;
    }
    if (action === 'beat-text' || action === 'beat-reason') {
        const beat = arc.beats.find(candidate => candidate.id === beatId);
        if (!beat) return;
        const field = action === 'beat-text' ? 'text' : 'stateReason';
        if (beat[field] === value) return;
        if (field === 'text' && !value) {
            el.value = beat.text;
            notify('Story Planner', 'A setup beat cannot be blank. Use Delete to remove it.', 'warning');
            return;
        }
        const wasCurrentBeat = field === 'text' && getCurrentBeat(arc) === beat.text;
        const updated = mutateWithProjectionCheck(() => updateArcBeat(id, beatId, { [field]: value }));
        if (wasCurrentBeat) refreshBeatStrip(updated);
        refreshDisplay();
        return;
    }
    if (arc[action] === value) return;

    mutateWithProjectionCheck(() => updateArc(id, { [action]: value }));
    refreshDisplay();
}

// ─── Event wiring ────────────────────────────────────────────────────────────

export function wireEvents() {
    if (!state.modal) return;

    // Arc cards — delegated on the stable container so handlers survive the
    // innerHTML swaps done by renderArcs().
    const arcsHost = state.modal.querySelector('#sp-arcs');
    if (arcsHost) {
        arcsHost.addEventListener('click', handleArcsClick);
        arcsHost.addEventListener('change', handleArcsChange);
        // 'blur' does not bubble — capture phase is required for delegation.
        arcsHost.addEventListener('blur', handleArcsBlur, true);
    }

    // Injection mode — applies immediately, no separate Apply step.
    state.modal.querySelectorAll('input[name="sp-inject-mode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            setPlanSetting('injectMode', radio.value);
            applyPlanInjection();
            renderArcs();
        });
    });

    // Enforcement ("Push") — applies immediately, like the inject-mode radios.
    state.modal.querySelector('#sp-enforcement')?.addEventListener('change', (e) => {
        setPlanSetting('enforcement', e.target.value);
        applyPlanInjection();
        const blurb = state.modal.querySelector('#sp-enforcement-blurb');
        if (blurb) blurb.textContent = ENFORCEMENT_MODES.find(m => m.key === getEnforcement())?.blurb || '';
        refreshDisplay();
    });

    // Generate
    state.modal.querySelector('#sp-generate')?.addEventListener('click', async () => {
        const btn = state.modal.querySelector('#sp-generate');
        try {
            setControlBusy(btn, true); btn.innerHTML = '<span aria-hidden="true">⏳</span> Generating…';
            const arcs = await generatePlan(false);
            if (arcs) {
                renderArcs();
                notify('Story Planner', `Plan generated — ${arcs.length} arcs.`, 'success');
            }
        } catch (err) {
            notify('Story Planner', `Generation failed: ${err.message}`, 'error');
        } finally {
            // Restore through innerHTML with the hidden span so the treatment
            // survives the busy cycle (Slice 4 item 2; matches the toolbar
            // markup above).
            setControlBusy(btn, false); btn.innerHTML = '<span aria-hidden="true">🎲</span> Generate Plan';
        }
    });

    // Clear
    state.modal.querySelector('#sp-clear')?.addEventListener('click', () => {
        if (!confirm('Clear every arc? A snapshot will be saved to history.')) return;
        const current = getArcs();
        if (current.length) pushPlanToHistory(current);
        setArcs([]);
        applyPlanInjection();
        renderArcs();
    });

    // Revert (diff current → latest snapshot, confirm to restore)
    state.modal.querySelector('#sp-revert')?.addEventListener('click', () => showRevertDiff());

    // History (browse and restore any snapshot)
    state.modal.querySelector('#sp-history')?.addEventListener('click', () => showPlanHistory());

    // Preview exactly what gets injected
    state.modal.querySelector('#sp-preview')?.addEventListener('click', () => showInjectionPreview());

    // Save settings
    state.modal.querySelector('#sp-save-settings')?.addEventListener('click', () => {
        const apiValues = readApiSettingsValues(state.modal, SP_API_FIELD_IDS);
        const depthRaw = state.modal.querySelector('#sp-injection-depth')?.value;
        const depth = depthRaw === '' ? 4 : Number(depthRaw);
        const autoIntervalRaw = state.modal.querySelector('#sp-auto-interval')?.value;
        const autoInterval = autoIntervalRaw === '' ? 10 : Number(autoIntervalRaw);
        const arcCountRaw = state.modal.querySelector('#sp-arc-count')?.value;
        const arcCount = arcCountRaw === '' ? 10 : Number(arcCountRaw);
        saveSettings({
            ...apiValues,
            customSystemPrompt: state.modal.querySelector('#sp-custom-system-prompt')?.value || '',
            customUserPrompt: state.modal.querySelector('#sp-custom-user-prompt')?.value || '',
            injectionDepth: isNaN(depth) ? 4 : depth,
        });
        const nudgeTurnsRaw = state.modal.querySelector('#sp-nudge-turns')?.value;
        const nudgeTurns = nudgeTurnsRaw === '' ? OVERDUE_TURNS : Number(nudgeTurnsRaw);
        setPlanSetting('autoInterval', isNaN(autoInterval) ? 10 : Math.max(1, autoInterval));
        setPlanSetting('arcCount', isNaN(arcCount) ? 10 : Math.min(30, Math.max(3, arcCount)));
        setPlanData({
            directionHint: state.modal.querySelector('#sp-direction-hint')?.value || '',
            nudgeEnabled: state.modal.querySelector('#sp-nudge-enabled')?.checked !== false,
            nudgeTurns: isNaN(nudgeTurns) ? OVERDUE_TURNS : Math.min(60, Math.max(3, nudgeTurns)),
        });
        refreshDisplay();
        applyPlanInjection();
        notify('Story Planner', 'Settings saved.', 'success');
    });

    // Toggle injection
    state.modal.querySelector('#sp-toggle-inject')?.addEventListener('click', () => {
        setPlanSetting('injectEnabled', !isInjectionEnabled());
        applyPlanInjection();
        refreshDisplay();
    });

    // Toggle auto-generate
    state.modal.querySelector('#sp-toggle-auto')?.addEventListener('click', () => {
        const now = !isAutoEnabled();
        setPlanSetting('autoEnabled', now);
        if (now) {
            state.autoCounter = 0;
            setPlanData({ autoCounter: 0 });
        }
        refreshDisplay();
    });

    state.modal.querySelector('#sp-use-global-defaults')?.addEventListener('change', (e) => {
        setUsesGlobalDefaults(e.target.checked);
        refreshDisplay();
        applyPlanInjection();
        notify('Story Planner', e.target.checked ? 'Using global defaults.' : 'Using settings for this chat.', 'info');
    });
}

// Re-exported so index.js can refresh the list after an auto-generate.
export { renderArcs };

// Exported for jsdom / embedding callers so the targeted-diff markup can be
// tested without standing up the full proposal modal.
export { renderTargetedDiff };
