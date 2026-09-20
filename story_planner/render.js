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
    computeLcsDiff, renderDiffHtml,
    assertSameScope,
} from '../core/index.js';
// Modal helpers come from the module directly (not the barrel) so the real
// DOM implementation runs under the test barrel→stub alias — the
// dashboard/render.js and wireTablist precedents. The stub's modal helpers
// throw by design, and Phase 5's review modal is exercised in jsdom tests.
import { createModal, showModal, hideModal } from '../core/modal.js';
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
    getInjectMode, getEnforcement, getDirectionHint, getArcCount, getSectionMeta, getStoryPalette, getCharacterContextSelection,
    usesGlobalDefaults, setUsesGlobalDefaults, setPlanSetting,
    getStoryPlanRequestPreferences,
} from './data.js';
import { buildSafeCharacterContext, listSafeCharacterContextCandidates } from '../core/character_context.js';
import { sanitizeStoryPlanRequest, sanitizeStoryPlanRequestPreferences, getStoryPlanRequestError, MAX_CHARACTER_CONTEXT_IDS, MAX_STORY_PLAN_REQUEST_IDS } from './schema.js';
import { applyPlanInjection, getArcsForInjection, buildInjectionBody, getInjectedTokenCount, getInjectionHeader } from './injection.js';
import { generatePlan, MAX_JOURNEY_SUBJECT_CANDIDATES } from './generation.js';
import { applyScopedPlanProposal, buildArcDiff, previewScopedApply } from './proposals.js';
import {
    applyTargetedProposal,
    generateTargetedProposal,
    targetedOperationLabel,
} from './targeted.js';
import {
    acceptProgressSuggestion, checkProgress, findProgressSource,
    ignoreProgressSuggestion,
} from './progress.js';

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

function candidateForEntityId(candidates, entityId) {
    return candidates.find(candidate => candidate.entityId === entityId
        || candidate.mergedEntityIds?.includes(entityId));
}

/**
 * Keep persisted choices inside the bounded picker. A plain alphabetical
 * slice can hide a checked subject beyond row 30, making it appear selected
 * in the request while giving the user no checkbox with which to clear it.
 */
function visibleJourneySubjectCandidates(candidates, savedEntityIds) {
    const visible = [];
    const seen = new Set();
    const add = candidate => {
        if (!candidate || seen.has(candidate.entityId) || visible.length >= MAX_JOURNEY_SUBJECT_CANDIDATES) return;
        seen.add(candidate.entityId);
        visible.push(candidate);
    };
    for (const savedEntityId of savedEntityIds || []) {
        const candidate = candidateForEntityId(candidates, savedEntityId);
        add(candidate || {
            entityId: savedEntityId,
            name: `Unavailable saved subject: ${savedEntityId}`,
            mergedEntityIds: [],
            unavailable: true,
        });
    }
    for (const candidate of candidates) add(candidate);
    return visible;
}

function renderArcOwnershipEditor(arc) {
    if (arc.section !== 'character') return '';
    const candidates = listSafeCharacterContextCandidates();
    const primaryCandidate = candidateForEntityId(candidates, arc.primarySubjectEntityId);
    const primaryValue = primaryCandidate?.entityId || arc.primarySubjectEntityId || '';
    const primaryOptions = [
        '<option value="">Unassigned</option>',
        ...candidates.map(candidate => `<option value="${escapeHtml(candidate.entityId)}" ${candidate.entityId === primaryValue ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`),
        ...(primaryValue && !primaryCandidate
            ? [`<option value="${escapeHtml(primaryValue)}" selected>Unresolved identity: ${escapeHtml(primaryValue)}</option>`]
            : []),
    ].join('');
    const supportingValues = new Set((arc.supportingParticipantEntityIds || []).map(entityId => {
        const candidate = candidateForEntityId(candidates, entityId);
        return candidate?.entityId || entityId;
    }));
    const unresolvedSupporting = [...supportingValues].filter(entityId => !candidateForEntityId(candidates, entityId));
    const supportingOptions = [
        ...candidates.filter(candidate => candidate.entityId !== primaryValue).map(candidate =>
            `<option value="${escapeHtml(candidate.entityId)}" ${supportingValues.has(candidate.entityId) ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`),
        ...unresolvedSupporting.map(entityId => `<option value="${escapeHtml(entityId)}" selected>Unresolved identity: ${escapeHtml(entityId)}</option>`),
    ].join('');
    return `<fieldset class="sp-ownership" style="margin:8px 0">
        <legend class="mwt-label">Journey ownership</legend>
        <label for="sp-primary-${escapeHtml(arc.id)}">Primary subject</label>
        <select id="sp-primary-${escapeHtml(arc.id)}" class="mwt-input" data-action="primary-subject" data-id="${escapeHtml(arc.id)}">${primaryOptions}</select>
        <label for="sp-support-${escapeHtml(arc.id)}">Supporting participants</label>
        <select id="sp-support-${escapeHtml(arc.id)}" class="mwt-input" data-action="supporting-participants" data-id="${escapeHtml(arc.id)}" multiple size="${Math.min(5, Math.max(2, candidates.length || unresolvedSupporting.length || 2))}">${supportingOptions}</select>
        ${candidates.length ? '<p class="mwt-text-dim mwt-text-sm">Hold Ctrl/Cmd to select multiple supporting participants.</p>' : '<p class="mwt-text-dim mwt-text-sm">Knowledge is unavailable or has no tracked characters. Saved unresolved identities are retained.</p>'}
    </fieldset>`;
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
            ${renderArcOwnershipEditor(arc)}
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

const GENERATE_MODAL_ID = 'mwt-sp-generate-modal';
const SCOPED_REVIEW_MODAL_ID = 'mwt-sp-scoped-review-modal';

function eligibleRefreshArcs(request) {
    const sections = new Set(request.sectionKeys);
    const subjects = new Set(request.subjectEntityIds || []);
    const candidates = listSafeCharacterContextCandidates();
    return getArcs().filter(arc => arc.status === 'active' && sections.has(arc.section)
        && (arc.section !== 'character' || !!candidateForEntityId(candidates, arc.primarySubjectEntityId))
        && (request.subjectMode !== 'selected' || arc.section !== 'character'
            || subjects.has(candidateForEntityId(candidates, arc.primarySubjectEntityId)?.entityId)));
}

function requestSummary(request) {
    const labels = request.sectionKeys.map(key => getSectionMeta(key)?.label || key);
    const subjects = request.sectionKeys.includes('character')
        ? request.subjectMode === 'selected'
            ? ` Selected Journey subjects: ${request.subjectEntityIds.length}.`
            : ' Journey subjects: any tracked character.'
        : '';
    return request.operation === 'add'
        ? `Add up to ${request.requestedCount} new arc${request.requestedCount === 1 ? '' : 's'} in ${labels.join(', ')}.${subjects} Use the selected public context.`
        : `Refresh ${request.targetArcIds.length} selected active arc${request.targetArcIds.length === 1 ? '' : 's'} in ${labels.join(', ')}.${subjects} Use the selected public context.`;
}

const CHARACTER_COVERAGE_LABELS = Object.freeze({
    complete: 'Included — every populated supported field fit',
    partial: 'Partial — some public context was truncated',
    'omitted-for-budget': 'Omitted for context budget',
    'missing-dossier': 'Missing dossier',
    unavailable: 'Dossier unavailable',
    disabled: 'Safe Character Context disabled',
});

function renderCharacterContextCoverage(mode, coverage = [], contextStatus = '') {
    if ((mode === 'off' || contextStatus === 'disabled') && !coverage.length) {
        return '<p class="mwt-text-dim mwt-text-sm" data-coverage-status="disabled">Safe Character Context disabled for this request. No Knowledge data is requested or changed.</p>';
    }
    if (!coverage.length) {
        return '<p class="mwt-text-dim mwt-text-sm">No public character-context records were requested or available.</p>';
    }
    const disabledNotice = mode === 'off' || contextStatus === 'disabled'
        ? '<p class="mwt-text-dim mwt-text-sm" data-coverage-status="disabled">Safe Character Context disabled for this request. Journey subjects remain selected only as arc owners; no Knowledge data is requested or changed.</p>'
        : '';
    const coverageExplanation = '<p class="mwt-text-dim mwt-text-sm">Coverage uses stance, role, personality, background, and public location. Compact Knowledge entries fall back to their public identity, Tone/Perceived as, and First seen lines. Appearance, voice, agenda, secrets, and the Knowledge Ledger are excluded. “Included” means every populated supported field fit; it does not measure total entry size. Journey subjects own arcs; Context only entries come from Safe Character Context, not the subject picker.</p>';
    return `${disabledNotice}${coverageExplanation}<ul class="sp-context-coverage">${coverage.map(item => {
        const records = Number(item.records) || 0;
        const fields = Number(item.fields) || 0;
        const availableFields = Number.isFinite(Number(item.availableFields)) ? Number(item.availableFields) : fields;
        const supportedFields = Number(item.supportedFields) || 5;
        const statusLabel = item.status === 'partial' && records === 0 && availableFields === 0
            ? 'No supported public fields populated'
            : CHARACTER_COVERAGE_LABELS[item.status] || item.status || 'Unavailable';
        const name = item.name || item.entityId || 'Unknown character';
        const fieldCounts = availableFields > fields
            ? `${fields} of ${availableFields} populated public fields included (${supportedFields} supported)`
            : `${fields} populated public field${fields === 1 ? '' : 's'} included (${supportedFields} supported)`;
        const fieldLabels = Array.isArray(item.fieldLabels) ? item.fieldLabels.filter(Boolean) : [];
        const fieldDetail = fieldLabels.length ? `: ${fieldLabels.join(', ')}` : '';
        const counts = item.status === 'disabled'
            ? 'no public context requested; stored data unchanged'
            : `${records} record${records === 1 ? '' : 's'}, ${fieldCounts}${fieldDetail}, ${Number(item.tokens) || 0}${item.estimated ? ' estimated' : ''} tokens`;
        const role = item.isPrimarySubject ? 'Journey subject' : 'Context only';
        return `<li data-coverage-status="${escapeHtml(item.status || 'unavailable')}" data-coverage-role="${item.isPrimarySubject ? 'subject' : 'context-only'}"><strong>${escapeHtml(name)}</strong>: ${escapeHtml(statusLabel)} <span class="mwt-text-dim">(${escapeHtml(counts)}) — ${escapeHtml(role)}</span></li>`;
    }).join('')}</ul>`;
}

function proposalIdentityLabel(proposal, entityId) {
    if (!entityId) return '(none)';
    const candidate = (proposal.subjectCandidates || []).find(item => item.entityId === entityId
        || item.mergedEntityIds?.includes(entityId));
    return candidate?.name || `Unresolved identity: ${entityId}`;
}

function labelProposalDiffIdentities(proposal, diff) {
    return {
        ...diff,
        fields: diff.fields.map(change => {
            if (change.field === 'primary subject') {
                return { ...change, before: proposalIdentityLabel(proposal, change.before), after: proposalIdentityLabel(proposal, change.after) };
            }
            if (change.field === 'supporting participants') {
                const labels = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean)
                    .map(entityId => proposalIdentityLabel(proposal, entityId)).join(', ') || '(none)';
                return { ...change, before: labels(change.before), after: labels(change.after) };
            }
            return change;
        }),
    };
}

/**
 * Per-arc rows describing exactly what Apply will do, built from
 * previewScopedApply so the shown change and the performed change cannot
 * disagree. The previous whole-plan text diff compared the merge result, which
 * appends refreshed arcs at the end of the plan — so it reported a reordering
 * that Apply, replacing in place, never performs.
 */
function scopedReviewRows(proposal, live = getArcs()) {
    const preview = previewScopedApply({ ...proposal, acceptedProposalIds: undefined }, live);
    if (!preview.ok) return { ok: false, reason: preview.reason, rows: [], excludedRecurrences: [] };
    const rows = [
        ...preview.additions.map(arc => ({
            id: arc.id, kind: 'added', title: arc.title, section: arc.section, arc, diff: null,
        })),
        ...preview.updates.map(update => ({
            id: update.id,
            kind: 'updated',
            title: update.after.title || update.before.title,
            section: update.after.section,
            arc: update.after,
            diff: labelProposalDiffIdentities(proposal, buildArcDiff(update.before, update.after)),
        })),
    ];
    return { ok: true, rows, excludedRecurrences: preview.excludedRecurrences };
}

/** A new arc has nothing to diff against, so show what would be stored. */
function renderScopedAddition(arc, proposal) {
    const beats = (arc.beats || []).filter(beat => beat.state === 'pending');
    const ownership = arc.section === 'character'
        ? `<dl class="sp-proposal-ownership"><dt>Primary subject</dt><dd>${escapeHtml(proposalIdentityLabel(proposal, arc.primarySubjectEntityId))}</dd><dt>Supporting participants</dt><dd>${escapeHtml((arc.supportingParticipantEntityIds || []).map(entityId => proposalIdentityLabel(proposal, entityId)).join(', ') || '(none)')}</dd></dl>`
        : '';
    return `
        ${ownership}
        ${arc.body ? `<p class="mwt-text-sm">${escapeHtml(arc.body)}</p>` : ''}
        ${beats.length ? `<h4>Setup beats</h4><ol class="sp-proposal-diff">${beats.map(beat => `<li>${escapeHtml(beat.text)}</li>`).join('')}</ol>` : '<p class="mwt-text-dim mwt-text-sm">No setup beats proposed.</p>'}`;
}

function finishScopedReview() {
    if (!state.scopedReviewOpen) return;
    state.scopedReviewOpen = false;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
}

export function closeScopedReviewModal() {
    finishScopedReview();
    const modal = typeof document !== 'undefined' && typeof document.getElementById === 'function'
        ? document.getElementById(SCOPED_REVIEW_MODAL_ID)
        : null;
    if (!modal) return;
    if (typeof modal._closeModal === 'function') modal._closeModal();
    else hideModal(SCOPED_REVIEW_MODAL_ID);
}

export function showScopedReview(proposal) {
    const diagnostics = proposal.diagnostics || {};
    const diagnosticItems = [
        diagnostics.underfill ? `Underfilled by ${diagnostics.underfill}.` : '',
        diagnostics.overflow ? `${diagnostics.overflow} overflow suggestion${diagnostics.overflow === 1 ? '' : 's'} excluded.` : '',
        diagnostics.omittedTargetIds?.length ? `${diagnostics.omittedTargetIds.length} selected target${diagnostics.omittedTargetIds.length === 1 ? '' : 's'} omitted and left unchanged.` : '',
        diagnostics.rejectedSuggestions?.length ? `${diagnostics.rejectedSuggestions.length} unrequested suggestion${diagnostics.rejectedSuggestions.length === 1 ? '' : 's'} rejected.` : '',
        ...(diagnostics.participantDiagnostics || []),
        diagnostics.validationWarning || '',
    ].filter(Boolean);
    const coverageHtml = renderCharacterContextCoverage(
        diagnostics.characterContextMode,
        diagnostics.characterContextCoverage,
        diagnostics.characterContextStatus,
    );
    // Recurrences are reported from the Apply preview rather than from the
    // merge, so the exclusions shown are the ones Apply will actually make
    // against live storage — which may differ from the merge-time set if the
    // plan changed while the proposal was open.
    const preview = scopedReviewRows(proposal);
    for (const item of preview.excludedRecurrences) {
        diagnosticItems.push(`Excluded exact-title recurrence “${item.title || 'Untitled arc'}” (${item.status}).`);
    }
    const modal = createModal({
        id: SCOPED_REVIEW_MODAL_ID,
        title: 'Generate Story Plan — Review',
        destroyOnClose: true,
        onClose: finishScopedReview,
        content: `
            <p class="mwt-text-dim mwt-text-sm">Review the scoped changes below. Nothing is saved until you choose Apply.</p>
            ${proposal.stale ? `<p class="sp-proposal-stale" role="alert">${escapeHtml(proposal.staleReason || 'A selected target changed while this proposal was generated. Generate again to review the current plan.')}</p>` : ''}
            <p><strong>${escapeHtml(requestSummary(proposal.request))}</strong></p>
            <p class="mwt-text-dim mwt-text-sm">${proposal.stats.added} new · ${proposal.stats.matched} refreshed · ${proposal.stats.carried} carried forward</p>
            <details class="sp-context-coverage-review"><summary>Safe Character Context coverage</summary>${coverageHtml}</details>
            ${diagnosticItems.length ? `<ul class="sp-proposal-diagnostics">${diagnosticItems.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
            <fieldset class="sp-proposal-selection">
                <legend class="mwt-label">Changes to apply</legend>
                ${preview.rows.length ? preview.rows.map(row => `
                <div class="sp-proposal-item">
                    <label class="sp-proposal-choice" for="mwt-sp-proposal-${escapeHtml(row.id)}">
                        <input id="mwt-sp-proposal-${escapeHtml(row.id)}" type="checkbox" name="mwt-sp-proposal" value="${escapeHtml(row.id)}" checked>
                        <span><strong>${escapeHtml(row.title || 'Untitled arc')}</strong><small>${escapeHtml(getSectionMeta(row.section)?.label || row.section)} · ${row.kind === 'added' ? 'new arc' : 'refreshed'}</small></span>
                    </label>
                    ${row.kind === 'added' ? renderScopedAddition(row.arc, proposal) : renderArcDiff(row.diff)}
                </div>`).join('') : '<p class="mwt-text-dim mwt-text-sm">No material proposal was returned. Diagnostics are preserved below.</p>'}
            </fieldset>
            <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                <button id="mwt-sp-scoped-apply" class="mwt-btn mwt-btn-primary">Apply changes</button>
                <button id="mwt-sp-scoped-discard" class="mwt-btn">Discard</button>
            </div>`,
    });
    const apply = modal.querySelector('#mwt-sp-scoped-apply');
    if (apply && proposal.stale) apply.disabled = true;
    apply?.addEventListener('click', () => {
        if (!assertSameScope(proposal.scope).ok) {
            apply.disabled = true;
            apply.insertAdjacentHTML('beforebegin', '<p class="sp-proposal-stale" role="alert">The chat or plan changed while this proposal was open. Generate again to review the current plan.</p>');
            return;
        }
        const acceptedProposalIds = [...modal.querySelectorAll('input[name="mwt-sp-proposal"]:checked')].map(input => input.value);
        const result = applyScopedPlanProposal({ ...proposal, acceptedProposalIds }, getArcs());
        if (!result.ok) {
            if (result.reason === 'targets-changed') {
                apply.disabled = true;
                apply.insertAdjacentHTML('beforebegin', '<p class="sp-proposal-stale" role="alert">A selected target changed while this proposal was open. Generate again for those targets; unrelated plan edits were preserved.</p>');
            } else if (result.reason === 'entity-mappings-changed') {
                apply.disabled = true;
                apply.insertAdjacentHTML('beforebegin', '<p class="sp-proposal-stale" role="alert">A Journey subject was merged or removed while this proposal was open. Generate again to review the current identity mapping.</p>');
            } else if (result.reason === 'no-changes') {
                notify('Story Planner', 'No selected changes were applied. Review diagnostics are still available.', 'info');
            } else notify('Story Planner', 'The reviewed plan could not be saved.', 'error');
            return;
        }
        finishScopedReview();
        hideModal(SCOPED_REVIEW_MODAL_ID);
        applyPlanInjection();
        renderArcs();
        const skipped = result.excludedRecurrences?.length || 0;
        notify('Story Planner', skipped
            ? `Scoped story plan applied; ${skipped} exact-title recurrence${skipped === 1 ? ' was' : 's were'} skipped because the live plan changed.`
            : 'Scoped story plan applied.', 'success');
    });
    modal.querySelector('#mwt-sp-scoped-discard')?.addEventListener('click', closeScopedReviewModal);
    state.scopedReviewOpen = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    if (!showModal(SCOPED_REVIEW_MODAL_ID)) closeScopedReviewModal();
}

export function openGenerateDialog() {
    if (state.isGenerating || state.scopedReviewOpen) {
        notify('Story Planner', 'Finish the current Story Planner operation first.', 'info');
        return;
    }
    const context = getCharacterContextSelection();
    const preferences = getStoryPlanRequestPreferences();
    const allSubjectCandidates = listSafeCharacterContextCandidates();
    const savedSubjectIds = new Set(preferences.subjectEntityIds || []);
    const subjectCandidates = visibleJourneySubjectCandidates(allSubjectCandidates, savedSubjectIds);
    const savedContextIds = new Set(context.entityIds || []);
    const selectedContextSources = context.mode === 'selected'
        ? visibleJourneySubjectCandidates(allSubjectCandidates, [...savedContextIds, ...savedSubjectIds])
        : [];
    const activeContextSources = new Map();
    const excludedContextSourceIds = new Set();
    const visibleCandidateIds = new Set(subjectCandidates.filter(candidate => !candidate.unavailable).map(candidate => candidate.entityId));
    const hiddenSubjectCandidateCount = allSubjectCandidates.filter(candidate => !visibleCandidateIds.has(candidate.entityId)).length;
    const configuredCustomTemplates = !!(getSettings().customSystemPrompt?.trim() || getSettings().customUserPrompt?.trim());
    const sectionChecks = SECTIONS.map(section => `
        <label class="sp-mode-label" for="sp-generate-section-${section.key}">
            <input id="sp-generate-section-${section.key}" type="checkbox" name="sp-generate-section" value="${section.key}" ${preferences.sectionKeys.includes(section.key) ? 'checked' : ''}> ${escapeHtml(section.label)}
        </label>`).join('');
    const modal = createModal({
        id: GENERATE_MODAL_ID,
        title: 'Generate Story Plan',
        destroyOnClose: true,
        content: `
            <fieldset class="mwt-settings-grid" style="border:0;padding:0;margin:0">
                <legend class="mwt-label">Operation</legend>
                <label class="sp-mode-label" for="sp-generate-add"><input id="sp-generate-add" type="radio" name="sp-generate-operation" value="add" ${preferences.operation === 'add' ? 'checked' : ''}> Add ideas</label>
                <label class="sp-mode-label" for="sp-generate-refresh"><input id="sp-generate-refresh" type="radio" name="sp-generate-operation" value="refresh" ${preferences.operation === 'refresh' ? 'checked' : ''}> Refresh selected arcs</label>
            </fieldset>
            <fieldset style="border:0;padding:0;margin:12px 0 0">
                <legend class="mwt-label">Sections</legend>
                <div class="mwt-flex mwt-gap-8" style="flex-wrap:wrap">${sectionChecks}</div>
            </fieldset>
            <div class="mwt-settings-grid mwt-mt-8">
                <label class="mwt-label" for="sp-generate-count">Requested count</label>
                <input id="sp-generate-count" class="mwt-input" type="number" min="1" max="30" value="${preferences.requestedCount || getArcCount()}" style="max-width:100px">
            </div>
            <fieldset id="sp-generate-subjects" style="border:0;padding:0;margin:12px 0 0">
                <legend class="mwt-label">Character Journey subjects</legend>
                <label class="sp-mode-label" for="sp-subject-any"><input id="sp-subject-any" type="radio" name="sp-generate-subject-mode" value="any" ${preferences.subjectMode !== 'selected' ? 'checked' : ''}> Any tracked character</label>
                <label class="sp-mode-label" for="sp-subject-selected"><input id="sp-subject-selected" type="radio" name="sp-generate-subject-mode" value="selected" ${preferences.subjectMode === 'selected' ? 'checked' : ''}> Selected characters</label>
                <div id="sp-generate-subject-list" class="mwt-mt-8">${subjectCandidates.map((candidate, index) => `
                    <label for="sp-generate-subject-${index}"><input id="sp-generate-subject-${index}" type="checkbox" name="sp-generate-subject" value="${escapeHtml(candidate.entityId)}" ${savedSubjectIds.has(candidate.entityId) || candidate.mergedEntityIds?.some(id => savedSubjectIds.has(id)) ? 'checked' : ''}> ${escapeHtml(candidate.name)}</label>`).join('')
                    || '<span class="mwt-text-dim mwt-text-sm">No assignable tracked characters are currently available.</span>'}</div>
                ${hiddenSubjectCandidateCount ? `<p class="mwt-text-dim mwt-text-sm">Showing up to ${MAX_JOURNEY_SUBJECT_CANDIDATES} tracked characters. Saved selections stay visible at the top so they can always be cleared; ${hiddenSubjectCandidateCount} other character${hiddenSubjectCandidateCount === 1 ? ' is' : 's are'} outside this request.</p>` : ''}
                <p class="mwt-text-dim mwt-text-sm">Subject selection assigns ownership only. It does not add dossier fields to Safe Character Context.</p>
            </fieldset>
            ${context.mode !== 'off' ? `<fieldset id="sp-generate-context-sources" style="border:0;padding:0;margin:12px 0 0">
                <legend class="mwt-label">Safe Character Context sources for this request${context.mode === 'selected' ? ` (select up to ${MAX_CHARACTER_CONTEXT_IDS})` : ''}</legend>
                <div id="sp-generate-context-source-list">${context.mode === 'selected'
                    ? selectedContextSources.map((source, index) => `<label for="sp-generate-context-source-${index}"><input id="sp-generate-context-source-${index}" type="checkbox" name="sp-generate-context-source" value="${escapeHtml(source.entityId)}" ${savedContextIds.has(source.entityId) || source.mergedEntityIds?.some(id => savedContextIds.has(id)) ? 'checked' : ''}> ${escapeHtml(source.name)}</label>`).join('') || '<span class="mwt-text-dim mwt-text-sm">No tracked characters are available as context sources.</span>'
                    : '<span class="mwt-text-dim mwt-text-sm">Checking the active cast…</span>'}</div>
                <p class="mwt-text-dim mwt-text-sm">Journey ownership and public context are separate. Check the characters whose public context should be sent, or clear a source to omit it. Your saved Story Planner context mode and selection are unchanged.</p>
            </fieldset>` : ''}
            <details class="mwt-mt-8" open>
                <summary>Safe Character Context coverage</summary>
                <div id="sp-generate-context-coverage" aria-live="polite"><p class="mwt-text-dim mwt-text-sm">Checking public-context coverage…</p></div>
            </details>
            <fieldset id="sp-generate-targets" style="border:0;padding:0;margin:12px 0 0"><legend class="mwt-label">Eligible arcs (select up to ${MAX_STORY_PLAN_REQUEST_IDS})</legend><div id="sp-generate-target-list"></div></fieldset>
            <p class="${configuredCustomTemplates ? 'sp-proposal-diagnostics' : 'mwt-text-dim mwt-text-sm'}">${configuredCustomTemplates
                ? 'Scoped generation uses the built-in safe request format, so your saved custom templates are not used here.'
                : 'Regenerating the whole plan rewrites every section at once and saves without a review step. It keeps pinned arcs and planted beats.'}
                <button id="sp-generate-legacy" class="mwt-btn" type="button">Regenerate the whole plan${configuredCustomTemplates ? ' with custom templates' : ''}</button></p>
            <p id="sp-generate-context-summary" class="mwt-text-dim mwt-text-sm">Public context: ${context.mode === 'off' ? 'off' : context.mode === 'active' ? 'active cast' : `${context.entityIds.length} selected character${context.entityIds.length === 1 ? '' : 's'}`}. Existing context settings are unchanged by this dialog.</p>
            <p id="sp-generate-summary" class="sp-proposal-change" role="status"></p>
            <div class="mwt-flex mwt-gap-8 mwt-mt-8"><button id="sp-generate-submit" class="mwt-btn mwt-btn-primary">Generate for review</button><button id="sp-generate-cancel" class="mwt-btn">Cancel</button></div>`,
    });
    const syncActiveContextSourceControls = coverage => {
        if (context.mode !== 'active') return;
        for (const item of coverage || []) {
            if (item?.isContextSource && item.entityId) {
                activeContextSources.set(item.entityId, item.name || item.entityId);
            }
        }
        const host = modal.querySelector('#sp-generate-context-source-list');
        if (!host) return;
        host.innerHTML = activeContextSources.size
            ? [...activeContextSources].map(([entityId, name], index) => `<label for="sp-generate-context-source-${index}"><input id="sp-generate-context-source-${index}" type="checkbox" name="sp-generate-context-source" value="${escapeHtml(entityId)}" ${excludedContextSourceIds.has(entityId) ? '' : 'checked'}> ${escapeHtml(name)}</label>`).join('')
            : '<span class="mwt-text-dim mwt-text-sm">No active-cast context sources are available.</span>';
    };
    const getRequestContextSelection = () => context.mode === 'selected'
        ? {
            ...context,
            entityIds: [...modal.querySelectorAll('input[name="sp-generate-context-source"]:checked')].map(input => input.value),
        }
        : context.mode === 'active'
            ? { ...context, excludedEntityIds: [...excludedContextSourceIds] }
            : context;
    const getRequest = () => {
        const operation = modal.querySelector('input[name="sp-generate-operation"]:checked')?.value || 'add';
        const sectionKeys = [...modal.querySelectorAll('input[name="sp-generate-section"]:checked')].map(input => input.value);
        const targetArcIds = [...modal.querySelectorAll('input[name="sp-generate-target"]:checked')].map(input => input.value);
        const subjectMode = modal.querySelector('input[name="sp-generate-subject-mode"]:checked')?.value || 'any';
        const subjectEntityIds = [...modal.querySelectorAll('input[name="sp-generate-subject"]:checked')].map(input => input.value);
        return sanitizeStoryPlanRequest({ operation, sectionKeys, subjectMode, subjectEntityIds, requestedCount: modal.querySelector('#sp-generate-count')?.value, castPolicy: 'allowed', targetArcIds });
    };
    // Once the user has touched the target list, their selection is
    // authoritative — including an empty one. Falling back to the saved
    // preference whenever nothing is checked makes the last checkbox
    // impossible to clear: unchecking it re-checks the whole stored set.
    let targetSelectionTouched = false;
    let renderedTargetIds = null;

    // The eligible set only changes when the selected sections change, so the
    // list is rebuilt on that signature alone. Rebuilding it on every change
    // event would replace the checkbox the user just toggled and drop focus to
    // the body — the same reason arc text edits below never re-render.
    const rebuildTargetList = () => {
        const list = modal.querySelector('#sp-generate-target-list');
        if (!list) return;
        const sectionKeys = [...modal.querySelectorAll('input[name="sp-generate-section"]:checked')].map(input => input.value);
        const request = getRequest();
        const eligible = eligibleRefreshArcs(request);
        const unassigned = getArcs().filter(arc => arc.status === 'active' && sectionKeys.includes(arc.section)
            && arc.section === 'character' && !arc.primarySubjectEntityId);
        const unavailableOwners = getArcs().filter(arc => arc.status === 'active' && sectionKeys.includes(arc.section)
            && arc.section === 'character' && arc.primarySubjectEntityId
            && !candidateForEntityId(allSubjectCandidates, arc.primarySubjectEntityId));
        const signature = JSON.stringify([
            ...eligible.map(arc => arc.id),
            ...unassigned.map(arc => `unassigned:${arc.id}`),
            ...unavailableOwners.map(arc => `unavailable-owner:${arc.id}`),
        ]);
        if (renderedTargetIds === signature) return;
        const selected = new Set([...list.querySelectorAll('input:checked')].map(input => input.value));
        renderedTargetIds = signature;
        list.innerHTML = [
            ...eligible.map(arc => {
                const inputId = `sp-generate-target-${arc.id}`;
                const checked = targetSelectionTouched
                    ? selected.has(arc.id)
                    : preferences.targetArcIds.includes(arc.id);
                return `<label class="sp-generate-target" for="${escapeHtml(inputId)}"><input id="${escapeHtml(inputId)}" type="checkbox" name="sp-generate-target" value="${escapeHtml(arc.id)}" ${checked ? 'checked' : ''}> <span>${escapeHtml(arc.title || 'Untitled arc')}</span></label>`;
            }),
            ...unassigned.map(arc => `<div class="sp-generate-target mwt-text-dim mwt-text-sm"><span>${escapeHtml(arc.title || 'Untitled arc')} — assign a primary subject first.</span></div>`),
            ...unavailableOwners.map(arc => `<div class="sp-generate-target mwt-text-dim mwt-text-sm"><span>${escapeHtml(arc.title || 'Untitled arc')} — primary subject is unavailable in Knowledge; assign an available subject before refreshing.</span></div>`),
        ].join('') || '<span class="mwt-text-dim mwt-text-sm">No eligible active arcs in the selected sections.</span>';
    };

    const syncSummary = () => {
        const request = getRequest();
        const requestError = getStoryPlanRequestError(request);
        const summary = modal.querySelector('#sp-generate-summary');
        if (summary) summary.textContent = requestError || requestSummary(request);
        const requestContext = getRequestContextSelection();
        const contextSummary = modal.querySelector('#sp-generate-context-summary');
        if (contextSummary) contextSummary.textContent = `Public context: ${requestContext.mode === 'off' ? 'off' : requestContext.mode === 'active' ? `active cast${requestContext.excludedEntityIds.length ? `, ${requestContext.excludedEntityIds.length} omitted for this request` : ''}` : `${requestContext.entityIds.length} selected character${requestContext.entityIds.length === 1 ? '' : 's'} for this request`}. Existing context settings are unchanged by this dialog.`;
        const count = modal.querySelector('#sp-generate-count');
        if (count) count.disabled = request.operation !== 'add';
        const targets = modal.querySelector('#sp-generate-targets');
        if (targets) targets.hidden = request.operation !== 'refresh';
        const subjects = modal.querySelector('#sp-generate-subjects');
        if (subjects) subjects.hidden = !request.sectionKeys.includes('character');
        modal.querySelectorAll('input[name="sp-generate-subject"]').forEach(input => {
            input.disabled = request.subjectMode !== 'selected';
        });
        if (requestContext.mode === 'selected') {
            const checkedContextSources = modal.querySelectorAll('input[name="sp-generate-context-source"]:checked').length;
            modal.querySelectorAll('input[name="sp-generate-context-source"]').forEach(input => {
                input.disabled = !input.checked && checkedContextSources >= MAX_CHARACTER_CONTEXT_IDS;
            });
        }
        const checkedTargets = modal.querySelectorAll('input[name="sp-generate-target"]:checked').length;
        modal.querySelectorAll('input[name="sp-generate-target"]').forEach(input => {
            input.disabled = !input.checked && checkedTargets >= MAX_STORY_PLAN_REQUEST_IDS;
        });
    };

    const refresh = () => { rebuildTargetList(); syncSummary(); };

    // Delegated, so a rebuild never has to re-bind and a toggle never rebuilds.
    modal.querySelector('#sp-generate-target-list')?.addEventListener('change', () => {
        targetSelectionTouched = true;
        syncSummary();
    });
    modal.querySelectorAll('input[name="sp-generate-section"]').forEach(input => input.addEventListener('change', refresh));
    modal.querySelectorAll('input[name="sp-generate-operation"], input[name="sp-generate-subject-mode"], input[name="sp-generate-subject"], input[name="sp-generate-context-source"], #sp-generate-count').forEach(input => input.addEventListener('change', refresh));
    modal.querySelector('#sp-generate-cancel')?.addEventListener('click', () => hideModal(GENERATE_MODAL_ID));
    modal.querySelector('#sp-generate-legacy')?.addEventListener('click', async () => {
        hideModal(GENERATE_MODAL_ID);
        try {
            const arcs = await generatePlan(false);
            // generatePlan commits and re-injects, but nothing re-renders the
            // open panel: `mwt:busy-changed` only refreshes button states.
            // Without this the list keeps showing the pre-generation plan.
            if (arcs) {
                renderArcs();
                notify('Story Planner', `Plan regenerated — ${arcs.length} arcs.`, 'success');
            }
        } catch (error) { notify('Story Planner', `Generation failed: ${error.message}`, 'error'); }
    });
    modal.querySelector('#sp-generate-submit')?.addEventListener('click', async () => {
        const request = getRequest();
        const button = modal.querySelector('#sp-generate-submit');
        const requestError = getStoryPlanRequestError(request);
        if (requestError) {
            notify('Story Planner', requestError, 'warning');
            return;
        }
        // Persisted only once the request is valid: remembering a rejected
        // request reopens the dialog in the state that could not be submitted.
        setPlanData({ storyPlanRequestPreferences: sanitizeStoryPlanRequestPreferences(request) });
        try {
            setControlBusy(button, true);
            const proposal = await generatePlan(false, request, {
                reviewOnly: true,
                characterContextSelection: getRequestContextSelection(),
            });
            if (proposal) {
                hideModal(GENERATE_MODAL_ID);
                showScopedReview(proposal);
            }
        } catch (error) {
            notify('Story Planner', `Generation failed: ${error.message}`, 'error');
        } finally {
            if (button?.isConnected) setControlBusy(button, false);
        }
    });
    refresh();
    if (!showModal(GENERATE_MODAL_ID)) hideModal(GENERATE_MODAL_ID);
    let coverageRequestRevision = 0;
    const refreshContextCoverage = () => {
        const revision = ++coverageRequestRevision;
        const request = getRequest();
        const requestContext = getRequestContextSelection();
        const primarySubjectEntityIds = request.sectionKeys.includes('character') && request.subjectMode === 'selected'
            ? request.subjectEntityIds
            : [];
        Promise.resolve(buildSafeCharacterContext({ ...requestContext, primarySubjectEntityIds })).then(result => {
            const host = modal.querySelector('#sp-generate-context-coverage');
            if (revision === coverageRequestRevision && host?.isConnected) {
                syncActiveContextSourceControls(result?.coverage || []);
                host.innerHTML = renderCharacterContextCoverage(requestContext.mode, result?.coverage || [], result?.status || '');
            }
        }).catch(() => {
            const host = modal.querySelector('#sp-generate-context-coverage');
            if (revision === coverageRequestRevision && host?.isConnected) host.innerHTML = renderCharacterContextCoverage(requestContext.mode, []);
        });
    };
    modal.querySelectorAll('input[name="sp-generate-section"], input[name="sp-generate-subject-mode"], input[name="sp-generate-subject"], input[name="sp-generate-context-source"]').forEach(input => input.addEventListener('change', refreshContextCoverage));
    modal.querySelector('#sp-generate-context-source-list')?.addEventListener('change', event => {
        const input = event.target.closest('input[name="sp-generate-context-source"]');
        if (!input || context.mode !== 'active') return;
        if (input.checked) excludedContextSourceIds.delete(input.value);
        else excludedContextSourceIds.add(input.value);
        syncSummary();
        refreshContextCoverage();
    });
    refreshContextCoverage();
}

// ─── Render ──────────────────────────────────────────────────────────────────

export function render() {
    const s = getSettings();
    const autoEnabled = isAutoEnabled();
    const autoInterval = getAutoInterval();
    const mode = getInjectMode();
    const enforcement = getEnforcement();
    const palette = getStoryPalette();
    const characterContext = getCharacterContextSelection();
    const characterCandidates = listSafeCharacterContextCandidates();

    return `
        <div class="ws-toolbar mwt-flex mwt-gap-4 mwt-mb-8" style="flex-wrap:wrap">
            <button id="sp-generate" class="mwt-btn mwt-btn-primary"><span aria-hidden="true">🎲</span> Generate Plan</button>
            <button id="sp-check-progress" class="mwt-btn"><span aria-hidden="true">🔎</span> Check progress</button>
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

                <div class="mwt-label">Story Palette</div>
                <div>
                    <div class="mwt-flex mwt-gap-8" style="flex-wrap:wrap" role="group" aria-label="Story palette emphasis">
                        ${['conflict', 'mystery', 'discovery', 'consequences', 'relationships', 'character growth', 'quiet moments', 'repair/reconciliation'].map((value, index) => `<label class="sp-mode-label" for="sp-palette-emphasis-${index}"><input id="sp-palette-emphasis-${index}" type="checkbox" name="sp-palette-emphasis" value="${value}" ${palette.emphases.includes(value) ? 'checked' : ''}> ${escapeHtml(value)}</label>`).join('')}
                    </div>
                    <label class="mwt-text-sm" for="sp-palette-escalation">Escalation: <select id="sp-palette-escalation" class="sp-enforcement"><option value="restrained" ${palette.escalation === 'restrained' ? 'selected' : ''}>Restrained</option><option value="balanced" ${palette.escalation === 'balanced' ? 'selected' : ''}>Balanced</option><option value="escalating" ${palette.escalation === 'escalating' ? 'selected' : ''}>Escalating</option></select></label>
                    <label class="sp-mode-label" for="sp-palette-new-major" style="margin-left:8px"><input id="sp-palette-new-major" type="checkbox" ${palette.allowNewMajorCharacters ? 'checked' : ''}> Allow new major characters</label>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Optional preferences, not quotas. With no chips selected, planning stays balanced and favors the established cast.</p>
                </div>

                <label class="mwt-label" for="sp-character-context-mode">Safe Character Context</label>
                <div>
                    <select id="sp-character-context-mode" class="sp-enforcement"><option value="off" ${characterContext.mode === 'off' ? 'selected' : ''}>Off</option><option value="active" ${characterContext.mode === 'active' ? 'selected' : ''}>Active cast from Current Scene</option><option value="selected" ${characterContext.mode === 'selected' ? 'selected' : ''}>Selected characters</option></select>
                    <div id="sp-character-context-selected" class="mwt-flex mwt-gap-4 mwt-mt-8" style="flex-wrap:wrap" role="group" aria-label="Currently selected safe character context"></div>
                    <select id="sp-character-context-ids" class="mwt-input" multiple size="${Math.min(5, Math.max(2, characterCandidates.length))}" aria-label="Available safe character context" style="display:block;margin-top:4px;max-width:360px">${characterCandidates.map(candidate => `<option value="${escapeHtml(candidate.entityId)}" ${characterContext.entityIds.includes(candidate.entityId) || candidate.mergedEntityIds?.some(id => characterContext.entityIds.includes(id)) ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`).join('')}</select>
                    ${characterCandidates.length ? '' : `<p style="font-size:11px;color:var(--mwt-text-warn, var(--mwt-text-dim));margin:4px 0 0">No Knowledge characters are loaded right now, so the list above is empty. Any saved selection is kept — open the Knowledge tab to see and change it.</p>`}
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Use the selected chips above to remove distant entries without scrolling. The list adds characters. Opt-in public projection only: identity, role, traits, background, and public location. It excludes appearance, voice, agenda, secrets, ledgers, private intentions, and thoughts.</p>
                </div>

                <label class="mwt-label" for="sp-arc-count">Arcs Per Generation</label>
                <div>
                    <input id="sp-arc-count" class="mwt-input" type="number" value="${getArcCount()}" min="1" max="30" style="max-width:100px">
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">How many arcs to ask for (1–30). Fewer, tighter arcs vs. a sprawling menu.</p>
                </div>

                <label class="mwt-label" for="sp-injection-depth">Injection Depth</label>
                <input id="sp-injection-depth" class="mwt-input" type="number" value="${s.injectionDepth ?? 4}" min="0" max="999">

                <label class="mwt-label" for="sp-custom-system-prompt">Custom System Prompt</label>
                <textarea id="sp-custom-system-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customSystemPrompt || '')}</textarea>
                <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Overrides the system prompt sent to the AI when generating a plan. Leave blank to use the built-in default. Note: the default prompt defines the section headings the plan is parsed into — a custom prompt that uses different headings will have its arcs filed under "${escapeHtml(getSectionMeta('emerging').label)}".</p>

                <label class="mwt-label" for="sp-custom-user-prompt">Custom User Prompt</label>
                <div>
                    <textarea id="sp-custom-user-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customUserPrompt || '')}</textarea>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Overrides the user task prompt. Supports tokens: <code>{{chatHistory}}</code>, <code>{{worldState}}</code>, <code>{{lastChronicle}}</code>, <code>{{previousPlan}}</code>, <code>{{directionHint}}</code>, <code>{{storyPalette}}</code>, <code>{{safeCharacterContext}}</code>, <code>{{arcCount}}</code>. Each resolves to empty if that data isn't available. Leave blank for default.</p>
                </div>

                <label class="mwt-label" for="sp-auto-interval">Auto-Generate Interval</label>
                <div>
                    <input id="sp-auto-interval" class="mwt-input" type="number" value="${autoInterval}" min="1" max="100" style="max-width:100px">
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">When auto-generate is ON, a new plan is generated every N messages (counted on AI replies). Automatic generation always regenerates the whole plan and saves without review — it does not use the scope you pick in Generate Plan.</p>
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

        <details class="sp-help" style="margin-top:12px">
            <summary><strong>How Story Planner states and controls work</strong></summary>
            <div class="mwt-text-dim mwt-text-sm" style="margin-top:8px">
                <p><strong>Pin vs Focus vs Park:</strong> Pin protects an arc through full regeneration. Focus is a separate spotlight: focused arcs sort first and are the only arcs sent in Focused-only mode. Park keeps an idea for later but removes it from narrator injection, reminders, and aging until you Resume it.</p>
                <p><strong>Planted vs Skipped:</strong> Planted means the setup beat actually happened and counts as completed evidence. Skipped records an honest route change; it stays in history but never counts as planted. Only the current pending beat is sent as <code>NOW:</code>.</p>
                <p><strong>Ready vs Resolved:</strong> Ready is derived automatically when no pending setup beats remain; the payoff is available now, but the arc is still active. Resolved means the payoff happened and closes the arc.</p>
                <p><strong>Archive vs Delete:</strong> Resolved and Dropped cards remain in the Archive and act as closed planning memory, suppressing exact-title recurrence during regeneration. Delete is the explicit forget action and removes that durable record.</p>
                <p><strong>Progress review:</strong> Check progress is manual and evidence-backed. It proposes verified excerpts for review and never changes a beat or arc until you accept. No automatic progress API cadence is enabled.</p>
                <p><code>/wt-beat</code> lists waiting beats and Ready arcs; <code>/wt-beat 2</code> plants item 2; <code>/wt-beat resolve R1</code> resolves Ready item R1.</p>
            </div>
        </details>
    `;
}

function progressFailureMessage(reason) {
    return ({
        stale: 'This suggestion is stale.',
        'scope-changed': 'The chat changed after this review opened.',
        'source-deleted': 'The source arc was deleted.',
        'source-changed': 'The arc or beat changed after this review opened.',
        'evidence-changed': 'The cited source message was edited, swiped, or deleted.',
        'store-paused': 'Story Planner is paused for this chat.',
    })[reason] || 'This suggestion can no longer be accepted.';
}

/** One review panel for all evidence-backed suggestions. */
export function showProgressSuggestions(result) {
    const suggestions = result?.suggestions || [];
    const suggestionById = new Map(suggestions.map(suggestion => [suggestion.id, suggestion]));
    const rows = suggestions.map((suggestion, index) => `
        <article class="sp-progress-suggestion" data-progress-id="${escapeHtml(suggestion.id)}">
            <h4>${suggestion.kind === 'beat' ? 'Beat appears planted' : 'Arc may be resolved'} — ${escapeHtml(suggestion.arcTitle || '(untitled arc)')}</h4>
            <p>${escapeHtml(suggestion.itemText || '')}</p>
            <blockquote>“${escapeHtml(suggestion.excerpt)}”</blockquote>
            ${suggestion.reason ? `<p class="mwt-text-dim mwt-text-sm">${escapeHtml(suggestion.reason)}</p>` : ''}
            ${suggestion.stale ? `<p class="sp-proposal-stale" role="alert">${escapeHtml(suggestion.staleReason)}</p>` : ''}
            ${suggestion.kind === 'arc' ? `<label class="mwt-label" for="sp-progress-reason-${index}">Resolution reason (optional)</label><textarea id="sp-progress-reason-${index}" class="mwt-input" rows="2">${escapeHtml(suggestion.reason || '')}</textarea>` : ''}
            <div class="mwt-flex mwt-gap-8 sp-proposal-actions">
                <button class="mwt-btn mwt-btn-primary" data-progress-action="accept" ${suggestion.stale ? 'disabled' : ''}>Accept</button>
                <button class="mwt-btn" data-progress-action="ignore">Ignore</button>
                <button class="mwt-btn" data-progress-action="source">Open source</button>
            </div>
        </article>`).join('');
    // A stale check was invalidated (chat switch, or an edit/swipe/delete
    // mid-call) — explain that instead of implying the evidence was reviewed
    // and found absent. Same pattern as the targeted-proposal dialog.
    const content = rows || (result?.stale
        ? `<p class="sp-proposal-stale" role="alert">${escapeHtml(result.staleReason || 'The chat or a message changed while progress was checked.')} Run Check progress again.</p>`
        : result?.upToDate
            ? '<p><strong>Already up to date.</strong> No new settled messages are available since the last check.</p>'
            : `<p><strong>No clear evidence.</strong> No beat or resolution change was proposed.</p>`);
    const modal = createModal({
        id: 'mwt-sp-progress-modal', title: 'Check progress — Review', destroyOnClose: true,
        content: `<p class="mwt-text-dim mwt-text-sm">Suggestions are not facts. Verify each excerpt before accepting.</p>${content}<div class="mwt-flex mwt-mt-8"><button id="mwt-sp-progress-close" class="mwt-btn">Close</button></div>`,
    });
    modal.addEventListener('click', event => {
        const button = event.target.closest('[data-progress-action]');
        if (!button) return;
        const article = button.closest('[data-progress-id]');
        const suggestion = suggestionById.get(article?.dataset.progressId || '');
        if (!suggestion) return;
        if (button.dataset.progressAction === 'source') {
            const source = findProgressSource(suggestion);
            if (!source) {
                button.disabled = true;
                article.insertAdjacentHTML('afterbegin', '<p class="sp-proposal-stale" role="alert">The cited source is no longer verifiable.</p>');
                return;
            }
            const messageElement = document.getElementById('chat')?.querySelector(`.mes[mesid="${source.index}"]`);
            if (!messageElement) {
                notify('Story Planner', `Source message ${source.index + 1} is not currently rendered in the chat.`, 'info');
                return;
            }
            messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (button.dataset.progressAction === 'ignore') {
            const ignored = ignoreProgressSuggestion(suggestion);
            if (!ignored.ok) {
                button.disabled = true;
                article.insertAdjacentHTML('afterbegin', `<p class="sp-proposal-stale" role="alert">${escapeHtml(progressFailureMessage(ignored.reason))}</p>`);
                return;
            }
            article.remove();
        } else {
            const reason = article.querySelector('textarea')?.value || '';
            const accepted = mutateWithProjectionCheck(() => acceptProgressSuggestion(suggestion, reason));
            if (!accepted.ok) {
                button.disabled = true;
                article.insertAdjacentHTML('afterbegin', `<p class="sp-proposal-stale" role="alert">${escapeHtml(progressFailureMessage(accepted.reason))}</p>`);
                return;
            }
            article.remove();
            renderArcs();
            notify('Story Planner', suggestion.kind === 'beat' ? 'Beat marked planted.' : 'Arc resolved.', 'success');
        }
    });
    modal.querySelector('#mwt-sp-progress-close')?.addEventListener('click', () => hideModal('mwt-sp-progress-modal'));
    showModal('mwt-sp-progress-modal');
}

/** Close the outgoing chat's disposable progress-review shell. */
export function closeProgressReviewModal() {
    const modal = typeof document !== 'undefined' && typeof document.getElementById === 'function'
        ? document.getElementById('mwt-sp-progress-modal')
        : null;
    if (!modal) return;
    if (typeof modal._closeModal === 'function') modal._closeModal();
    else hideModal('mwt-sp-progress-modal');
}

/** Reflect chat-mutation staleness in an already-open review immediately. */
export function refreshProgressReviewModal() {
    const modal = typeof document !== 'undefined'
        ? document.getElementById('mwt-sp-progress-modal')
        : null;
    if (!modal) return;
    for (const suggestion of state.progressSuggestions || []) {
        if (!suggestion.stale) continue;
        const article = [...modal.querySelectorAll('[data-progress-id]')]
            .find(candidate => candidate.dataset.progressId === suggestion.id);
        if (!article) continue;
        let alert = article.querySelector('.sp-proposal-stale');
        if (!alert) {
            alert = document.createElement('p');
            alert.className = 'sp-proposal-stale';
            alert.setAttribute('role', 'alert');
            article.querySelector('.sp-proposal-actions')?.before(alert);
        }
        alert.textContent = suggestion.staleReason || 'The source message changed.';
        const accept = article.querySelector('[data-progress-action="accept"]');
        if (accept) accept.disabled = true;
    }
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
    return renderArcDiff(proposal.diff);
}

/** Render one buildArcDiff result. Shared by the targeted and scoped reviews. */
function renderArcDiff(diff) {
    const fieldRows = diff.fields.map(change => `
        <li><strong>${escapeHtml(change.field)}</strong><div class="sp-proposal-change">
            <del>${escapeHtml(change.before || '(empty)')}</del>
            <ins>${escapeHtml(change.after || '(empty)')}</ins>
        </div></li>`).join('');
    const beatRows = diff.beats.map(change => {
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

function finishTargetedReview() {
    if (!state.targetedReviewOpen) return;
    state.targetedReviewOpen = false;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
}

export function closeTargetedReviewModal() {
    const modal = typeof document !== 'undefined' && typeof document.getElementById === 'function'
        ? document.getElementById('mwt-sp-targeted-modal')
        : null;
    finishTargetedReview();
    if (!modal) return;
    if (typeof modal._closeModal === 'function') modal._closeModal();
    else hideModal('mwt-sp-targeted-modal');
}

function showTargetedProposal(proposal) {
    const stale = proposal.stale;
    const modal = createModal({
        id: 'mwt-sp-targeted-modal',
        title: `${targetedOperationLabel(proposal.operation)} — Review`,
        destroyOnClose: true,
        onClose: finishTargetedReview,
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
        finishTargetedReview();
        hideModal('mwt-sp-targeted-modal');
        renderArcs();
        notify('Story Planner', `${targetedOperationLabel(proposal.operation)} applied.`, 'success');
    });
    modal.querySelector('#mwt-sp-targeted-discard')?.addEventListener('click', () => {
        finishTargetedReview();
        hideModal('mwt-sp-targeted-modal');
    });
    if (!showModal('mwt-sp-targeted-modal')) {
        // createModal() leaves the proposal hidden when another dialog owns
        // focus. Do not leave the generation/review guards set in that case.
        finishTargetedReview();
        hideModal('mwt-sp-targeted-modal');
    }
}

async function runTargetedAction(button, arcId, operation) {
    if (state.isGenerating) {
        notify('Story Planner', 'Story Planner is already generating.', 'info');
        return;
    }
    if (state.targetedReviewOpen) {
        notify('Story Planner', 'Review or discard the open targeted proposal first.', 'info');
        return;
    }
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
            state.isGenerating = false;
            state.targetedReviewOpen = true;
            document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
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
        mutateWithProjectionCheck(() => updateArc(id, el.value === 'character'
            ? { section: el.value }
            : { section: el.value, primarySubjectEntityId: '', supportingParticipantEntityIds: [] }));
    } else if (action === 'status') {
        mutateWithProjectionCheck(() => setArcStatus(id, el.value));
    } else if (action === 'primary-subject') {
        const supporting = (getArcs().find(arc => arc.id === id)?.supportingParticipantEntityIds || [])
            .filter(entityId => entityId !== el.value);
        mutateWithProjectionCheck(() => updateArc(id, { primarySubjectEntityId: el.value, supportingParticipantEntityIds: supporting }));
    } else if (action === 'supporting-participants') {
        mutateWithProjectionCheck(() => updateArc(id, { supportingParticipantEntityIds: [...el.selectedOptions].map(option => option.value) }));
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

/**
 * Read the Safe Character Context controls back out of the settings form.
 *
 * The id list is rendered from listSafeCharacterContextCandidates(), which is
 * empty whenever Knowledge is disabled OR its store has not hydrated yet — and
 * the Story Planner panel does not wait on that hydration. A plain read of
 * selectedOptions would then write [] over a real selection the moment the user
 * saves an unrelated setting on this panel, silently reducing the feature to a
 * no-op with `mode` still set and nothing on screen to explain it. With no
 * options rendered there is nothing the user could have chosen, so the stored
 * ids are carried through untouched (render() says so in that state).
 */
function readCharacterContextSelection(modal) {
    const mode = modal.querySelector('#sp-character-context-mode')?.value || 'off';
    const select = modal.querySelector('#sp-character-context-ids');
    if (!select || select.options.length === 0) {
        return { mode, entityIds: getCharacterContextSelection().entityIds };
    }
    return { mode, entityIds: [...select.selectedOptions].map(option => option.value) };
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

    // A native multi-select makes deselecting an off-screen item depend on
    // scrolling plus a platform-specific modifier key. Mirror its selected
    // options as explicit remove buttons so a large cast remains manageable.
    const contextSelect = state.modal.querySelector('#sp-character-context-ids');
    const contextSelected = state.modal.querySelector('#sp-character-context-selected');
    const syncSelectedContextShortcuts = () => {
        if (!contextSelect || !contextSelected) return;
        const selected = [...contextSelect.selectedOptions];
        contextSelected.innerHTML = selected.length
            ? selected.map(option => `<button type="button" class="mwt-btn" data-remove-context-id="${escapeHtml(option.value)}" aria-label="Remove ${escapeHtml(option.textContent)} from Safe Character Context">${escapeHtml(option.textContent)} ×</button>`).join('')
            : '<span class="mwt-text-dim mwt-text-sm">No characters selected.</span>';
    };
    contextSelect?.addEventListener('change', syncSelectedContextShortcuts);
    contextSelected?.addEventListener('click', event => {
        const button = event.target.closest('[data-remove-context-id]');
        if (!button || !contextSelect) return;
        const option = [...contextSelect.options].find(item => item.value === button.dataset.removeContextId);
        if (option) option.selected = false;
        syncSelectedContextShortcuts();
    });
    syncSelectedContextShortcuts();

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

    // Generate — the manual path is scoped and review-first, so this button
    // only opens the dialog and never runs a busy/label cycle of its own; the
    // dialog's own submit button owns that. Auto-generation continues to use
    // the legacy direct-commit path in index.js.
    state.modal.querySelector('#sp-generate')?.addEventListener('click', openGenerateDialog);

    state.modal.querySelector('#sp-check-progress')?.addEventListener('click', async () => {
        const button = state.modal.querySelector('#sp-check-progress');
        const oldHtml = button.innerHTML;
        try {
            setControlBusy(button, true);
            button.innerHTML = '<span aria-hidden="true">⏳</span> Checking…';
            const result = await checkProgress();
            if (result) showProgressSuggestions(result);
        } catch (error) {
            notify('Story Planner', `Progress check failed: ${error.message}`, 'error');
        } finally {
            setControlBusy(button, false);
            button.innerHTML = oldHtml;
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
        setPlanSetting('arcCount', isNaN(arcCount) ? 10 : Math.min(30, Math.max(1, arcCount)));
        setPlanData({
            directionHint: state.modal.querySelector('#sp-direction-hint')?.value || '',
            storyPalette: {
                emphases: [...state.modal.querySelectorAll('input[name="sp-palette-emphasis"]:checked')].map(input => input.value),
                escalation: state.modal.querySelector('#sp-palette-escalation')?.value || 'balanced',
                allowNewMajorCharacters: state.modal.querySelector('#sp-palette-new-major')?.checked === true,
            },
            characterContext: readCharacterContextSelection(state.modal),
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
