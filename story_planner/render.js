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

import { getSettings, saveSettings } from './settings.js';
import {
    state, SECTIONS, ARC_STATUSES, INJECT_MODES,
    setPlanData, getPlanText,
    getArcs, setArcs, addArc, updateArc, removeArc, toggleArcPinned,
    isArcReady, getCurrentBeat, advanceBeat, retreatBeat,
    getPlanHistory, pushPlanToHistory, historyEntryToText, historyEntryToArcs,
    isInjectionEnabled, isAutoEnabled, getAutoInterval,
    getInjectMode, getDirectionHint, getArcCount, getSectionMeta,
} from './data.js';
import { applyPlanInjection, getArcsForInjection, buildInjectionBody } from './injection.js';
import { generatePlan } from './generation.js';

// ─── API field IDs ───────────────────────────────────────────────────────────
// One shared map for BOTH renderApiSettingsFields and readApiSettingsValues so
// every field round-trips (the two must use identical ids).
const SP_API_FIELD_IDS = {
    urlId: 'sp-api-url', keyId: 'sp-api-key', modelId: 'sp-model',
    maxTokensId: 'sp-max-tokens', tempId: 'sp-temp',
    topPId: 'sp-top-p', freqId: 'sp-freq-pen', presId: 'sp-pres-pen', headersId: 'sp-headers',
};

const STATUS_ICONS = { active: '◆', resolved: '✓', dropped: '✕' };

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
    const injected = getArcsForInjection().length;
    const ready = arcs.filter(a => a.status === 'active' && isArcReady(a)).length;
    const tokens = estimateTokens(buildInjectionBody());
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
    updateToolbarStats();
    updateAutoBanner();
    refreshButtonLabels();
    refreshRevertButton();
}

// ─── Arc rendering ───────────────────────────────────────────────────────────

/**
 * The beat strip: current setup step plus the controls that advance it.
 * Absent for arcs with no beats (Immediate Hooks are usable as-is).
 */
function renderBeatStrip(arc) {
    const total = arc.beats?.length || 0;
    if (total === 0) return '';
    const id = escapeHtml(arc.id);
    const done = Math.min(arc.beatIndex || 0, total);
    const waited = arc.turnsSinceAdvance || 0;

    if (isArcReady(arc)) {
        return `
            <div class="sp-beats sp-beats--ready">
                <div class="sp-beat-line">
                    <span class="sp-beat-badge sp-beat-badge--ready">READY</span>
                    <span class="sp-beat-text">All ${total} setup beats planted — this can happen now.</span>
                </div>
                <div class="sp-beat-actions">
                    <button class="mwt-btn sp-beat-back" data-action="beat-back" data-id="${id}" title="Undo the last '✓ planted'">↺ back</button>
                </div>
            </div>`;
    }

    const beat = getCurrentBeat(arc);
    const overdue = waited >= 12 ? ' sp-beat-badge--overdue' : '';
    return `
        <div class="sp-beats">
            <div class="sp-beat-line">
                <span class="sp-beat-badge${overdue}" title="${waited} turn${waited === 1 ? '' : 's'} on this beat">${done + 1}/${total}</span>
                <span class="sp-beat-text">${escapeHtml(beat)}</span>
            </div>
            <div class="sp-beat-actions">
                <button class="mwt-btn sp-beat-done" data-action="beat-done" data-id="${id}"
                        title="Mark this setup as planted and move to the next beat">✓ planted</button>
                ${done > 0 ? `<button class="mwt-btn sp-beat-back" data-action="beat-back" data-id="${id}" title="Go back a beat">↺</button>` : ''}
            </div>
        </div>`;
}

function renderArcCard(arc) {
    const dimmed = arc.status !== 'active' ? ' sp-arc--muted' : '';
    const pinnedCls = arc.pinned ? ' sp-arc--pinned' : '';
    const readyCls = isArcReady(arc) && arc.status === 'active' ? ' sp-arc--ready' : '';
    return `
        <div class="sp-arc${dimmed}${pinnedCls}${readyCls}" data-id="${escapeHtml(arc.id)}">
            <div class="sp-arc-head">
                <button class="sp-pin" data-action="pin" data-id="${escapeHtml(arc.id)}"
                        title="${arc.pinned ? 'Unpin' : 'Pin — keeps this arc through regeneration'}">${arc.pinned ? '📌' : '📍'}</button>
                <input type="text" class="sp-arc-title" data-action="title" data-id="${escapeHtml(arc.id)}"
                       value="${escapeHtml(arc.title)}" placeholder="Arc name">
                <button class="sp-arc-del" data-action="delete" data-id="${escapeHtml(arc.id)}" title="Delete arc">🗑</button>
            </div>
            <textarea class="sp-arc-body" data-action="body" data-id="${escapeHtml(arc.id)}" rows="2"
                      placeholder="What shift does this arc introduce?">${escapeHtml(arc.body)}</textarea>
            ${renderBeatStrip(arc)}
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

    return SECTIONS.map(sec => {
        const inSection = arcs.filter(a => a.section === sec.key);
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
}

/**
 * Re-render just the arc list. The `#sp-arcs` container element itself is
 * preserved, so the delegated listeners bound to it in wireEvents() survive.
 */
function renderArcs() {
    if (!state.modal) return;
    const host = state.modal.querySelector('#sp-arcs');
    if (!host) return;
    // Preserve which sections the user had collapsed across the re-render.
    const collapsed = new Set(
        [...host.querySelectorAll('.sp-section')].filter(d => !d.open).map(d => d.dataset.section),
    );
    host.innerHTML = renderArcsInner();
    host.querySelectorAll('.sp-section').forEach(d => {
        if (collapsed.has(d.dataset.section)) d.open = false;
    });
    refreshDisplay();
}

// ─── Render ──────────────────────────────────────────────────────────────────

export function render() {
    const s = getSettings();
    const autoEnabled = isAutoEnabled();
    const autoInterval = getAutoInterval();
    const mode = getInjectMode();

    return `
        <div class="ws-toolbar mwt-flex mwt-gap-4 mwt-mb-8" style="flex-wrap:wrap">
            <button id="sp-generate" class="mwt-btn mwt-btn-primary">🎲 Generate Plan</button>
            <button id="sp-revert" class="mwt-btn" ${getPlanHistory().length === 0 ? 'disabled' : ''}>⏪ Revert</button>
            <button id="sp-history" class="mwt-btn">📋 History</button>
            <button id="sp-preview" class="mwt-btn">👁 Preview Injection</button>
            <button id="sp-clear" class="mwt-btn mwt-btn-danger">🗑️ Clear</button>
            <span id="sp-toolbar-stats" class="mwt-text-dim mwt-text-sm" style="margin-left:auto;line-height:28px">${escapeHtml(toolbarStatsText())}</span>
        </div>

        <div class="sp-inject-modes mwt-flex mwt-gap-8 mwt-mb-8" style="flex-wrap:wrap;align-items:center">
            <span class="mwt-text-dim mwt-text-sm">Inject:</span>
            ${INJECT_MODES.map(m => `
                <label class="sp-mode-label" title="${escapeHtml(m.blurb)}">
                    <input type="radio" name="sp-inject-mode" value="${m.key}" ${m.key === mode ? 'checked' : ''}> ${escapeHtml(m.label)}
                </label>`).join('')}
        </div>

        <div id="sp-arcs" class="sp-arcs">${renderArcsInner()}</div>

        <div id="sp-auto-banner" style="color:var(--mwt-accent);font-size:12px;margin:8px 0 4px;${autoEnabled ? '' : 'display:none'}">${autoEnabled ? `🔄 Auto-generate: ON — generates a new plan every ${autoInterval} messages (${state.autoCounter}/${autoInterval} since last)` : ''}</div>

        <details class="mwt-mt-8">
            <summary style="cursor:pointer;color:var(--mwt-accent);font-weight:500">⚙️ Story Planner Settings</summary>
            <div class="mwt-settings-grid mwt-mt-8">
                ${renderApiSettingsFields(s, { ...SP_API_FIELD_IDS, includeAdvanced: true, includeHeaders: true })}

                <label class="mwt-label">Direction Hint</label>
                <div>
                    <textarea id="sp-direction-hint" class="mwt-input" rows="2" placeholder="e.g. more political intrigue, ease off the romance, I want a villain arc">${escapeHtml(getDirectionHint())}</textarea>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Steers the next generation. Leave blank for none. Saved per chat.</p>
                </div>

                <label class="mwt-label">Arcs Per Generation</label>
                <div>
                    <input id="sp-arc-count" class="mwt-input" type="number" value="${getArcCount()}" min="3" max="30" style="max-width:100px">
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">How many arcs to ask for (3–30). Fewer, tighter arcs vs. a sprawling menu.</p>
                </div>

                <label class="mwt-label">Injection Depth</label>
                <input id="sp-injection-depth" class="mwt-input" type="number" value="${s.injectionDepth ?? 4}" min="0" max="999">

                <label class="mwt-label">Custom System Prompt</label>
                <textarea id="sp-custom-system-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customSystemPrompt || '')}</textarea>
                <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Overrides the system prompt sent to the AI when generating a plan. Leave blank to use the built-in default. Note: the default prompt defines the section headings the plan is parsed into — a custom prompt that uses different headings will have its arcs filed under "${escapeHtml(getSectionMeta('emerging').label)}".</p>

                <label class="mwt-label">Custom User Prompt</label>
                <div>
                    <textarea id="sp-custom-user-prompt" class="mwt-input" rows="4" placeholder="Leave blank for default prompt">${escapeHtml(s.customUserPrompt || '')}</textarea>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Overrides the user task prompt. Supports tokens: <code>{{chatHistory}}</code>, <code>{{worldState}}</code>, <code>{{lastChronicle}}</code>, <code>{{previousPlan}}</code>, <code>{{directionHint}}</code>, <code>{{arcCount}}</code>. Each resolves to empty if that data isn't available. Leave blank for default.</p>
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
            Long-range arcs carry <strong>setup beats</strong> — small concrete steps toward the arc. Only the
            <em>current</em> beat is sent to the AI, as a "NOW:" instruction, so it plants one thing at a time instead of
            being told to vaguely "build toward" something. When you see that setup land in the story, click
            <strong>✓ planted</strong> to move to the next beat. Once every beat is planted the arc becomes
            <strong>Ready</strong> and is offered to the AI as usable immediately.
            <br><br>
            Edit any arc directly; changes save automatically. <strong>Pin</strong> an arc to keep it through regeneration
            (arcs with planted beats are kept automatically). Mark one <strong>Resolved</strong> or <strong>Dropped</strong>
            to stop it being suggested again. <strong>Auto-generate</strong> refreshes the plan on a timer;
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
    const diffHtml = renderDiffHtml(computeLcsDiff(getPlanText(), historyEntryToText(latest)));

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
            const diffHtml = renderDiffHtml(computeLcsDiff(getPlanText(), historyEntryToText(entry)));
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
function showInjectionPreview() {
    const body = buildInjectionBody();
    const enabled = isInjectionEnabled();
    const previewModal = createModal({
        id: 'mwt-sp-preview-modal',
        title: 'Story Plan — Injection Preview',
        content: `
            <p class="mwt-text-dim mwt-text-sm mwt-mb-8">
                Mode: <strong>${escapeHtml(getInjectMode())}</strong> ·
                ${getArcsForInjection().length} arcs ·
                ~${estimateTokens(body)} tokens ·
                Injection is <strong>${enabled ? 'ON' : 'OFF'}</strong>
            </p>
            <pre class="mwt-textarea" style="white-space:pre-wrap;max-height:50vh;overflow:auto">${escapeHtml(body || '(nothing would be injected)')}</pre>
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

/** Structural card actions: pin, delete, add. */
function handleArcsClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'TEXTAREA' || btn.tagName === 'SELECT') return;
    const action = btn.dataset.action;

    if (action === 'add') {
        const arc = addArc({ section: btn.dataset.section || 'emerging' });
        applyPlanInjection();
        renderArcs();
        // Focus the new card so the user can type straight away.
        const input = state.modal?.querySelector(`.sp-arc[data-id="${CSS.escape(arc.id)}"] .sp-arc-title`);
        input?.focus();
        return;
    }

    const id = btn.dataset.id;
    if (!id) return;

    if (action === 'beat-done') {
        advanceBeat(id);
        applyPlanInjection();
        renderArcs();
    } else if (action === 'beat-back') {
        retreatBeat(id);
        applyPlanInjection();
        renderArcs();
    } else if (action === 'pin') {
        toggleArcPinned(id);
        applyPlanInjection();
        renderArcs();
    } else if (action === 'delete') {
        const arc = getArcs().find(a => a.id === id);
        const name = arc?.title ? `"${arc.title}"` : 'this arc';
        if (!confirm(`Delete ${name}? This cannot be undone (use Resolved or Dropped to keep it out of the prompt without deleting).`)) return;
        removeArc(id);
        applyPlanInjection();
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
        updateArc(id, { section: el.value });
    } else if (action === 'status') {
        updateArc(id, { status: el.value });
    } else {
        return;
    }
    applyPlanInjection();
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
    if (!id || (action !== 'title' && action !== 'body')) return;

    const arc = getArcs().find(a => a.id === id);
    if (!arc) return;
    const value = el.value.trim();
    if (arc[action] === value) return;

    updateArc(id, { [action]: value });
    applyPlanInjection();
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
            setPlanData({ injectMode: radio.value });
            applyPlanInjection();
            renderArcs();
        });
    });

    // Generate
    state.modal.querySelector('#sp-generate')?.addEventListener('click', async () => {
        const btn = state.modal.querySelector('#sp-generate');
        try {
            btn.disabled = true; btn.textContent = '⏳ Generating…';
            const arcs = await generatePlan(false);
            if (arcs) {
                renderArcs();
                notify('Story Planner', `Plan generated — ${arcs.length} arcs.`, 'success');
            }
        } catch (err) {
            notify('Story Planner', `Generation failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false; btn.textContent = '🎲 Generate Plan';
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
        setPlanData({
            autoInterval: isNaN(autoInterval) ? 10 : Math.max(1, autoInterval),
            directionHint: state.modal.querySelector('#sp-direction-hint')?.value || '',
            arcCount: isNaN(arcCount) ? 10 : Math.min(30, Math.max(3, arcCount)),
        });
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

// Re-exported so index.js can refresh the list after an auto-generate.
export { renderArcs };
