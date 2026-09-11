/**
 * dashboard/render.js — the read-only Overview tab.
 *
 * Rendering is deliberately independent from the main entry point.  This
 * keeps the pane testable under jsdom and makes a failed status accessor a
 * local card error rather than a blank dashboard.
 */

import { escapeHtml } from '../core/diff.js';
import { collectOverviewSnapshot } from './status.js';

const EMOJI = '<span aria-hidden="true">';

function cellValue(cell, fallback = null) {
    return cell?.ok ? cell.value : fallback;
}

function errorCard(label, cell) {
    return `<div class="mwt-overview-card mwt-overview-error" role="status">
        <h3>${escapeHtml(label)}</h3>
        <p>Unavailable: ${escapeHtml(cell?.error || 'unknown error')}</p>
    </div>`;
}

function linkButton(tab, text) {
    return `<button type="button" class="mwt-overview-link" data-overview-tab="${escapeHtml(tab)}">${escapeHtml(text)}</button>`;
}

function card({ label, icon, body, tab, empty = false }) {
    return `<article class="mwt-overview-card${empty ? ' mwt-overview-empty' : ''}">
        <h3>${EMOJI}${icon}</span> ${escapeHtml(label)}</h3>
        <div class="mwt-overview-card-body">${body}</div>
        ${tab ? linkButton(tab, `Open ${label}`) : ''}
    </article>`;
}

function countText(count, singular, plural = `${singular}s`) {
    const n = Number(count) || 0;
    return `${n} ${n === 1 ? singular : plural}`;
}

function renderHealth(value) {
    const rows = Array.isArray(value?.modules) ? value.modules : [];
    if (!rows.length) return '<p role="status">No module health data available.</p>';
    return `<ul class="mwt-overview-health">${rows.map((row) => {
        const state = row.busy ? 'busy' : row.paused ? 'paused' : row.enabled === false ? 'off' : 'ready';
        const last = row.lastRun ? (row.lastRun.ok ? 'last run ok' : 'last run failed') : 'never run';
        return `<li><strong>${escapeHtml(row.label || row.id || 'Module')}</strong> — ${state}, ${row.auto ? 'auto' : 'manual'}, ${last}</li>`;
    }).join('')}</ul>`;
}

/** Render an already collected snapshot. Exported for jsdom and embedding callers. */
export function renderOverviewSnapshot(snapshot = {}) {
    const world = snapshot.worldState;
    const worldValue = cellValue(world, {});
    const worldBody = world?.ok
        ? `${escapeHtml(worldValue.kind || 'unknown')} · ${countText(worldValue.msgsSinceRefresh, 'message')} since refresh`
        : '';
    const beatsValue = cellValue(snapshot.beats, {});
    const intentionsValue = cellValue(snapshot.intentions, {});
    const budgetValue = cellValue(snapshot.budget, {});
    const coordinatorValue = cellValue(snapshot.coordinator, {});
    const staging = cellValue(snapshot.staging, 0);
    const growth = cellValue(snapshot.growthEvidence, 0);
    const awaiting = Number(beatsValue.awaiting) || 0;
    const overdue = Number(beatsValue.overdue) || 0;
    const active = Array.isArray(intentionsValue.active) ? intentionsValue.active.length : 0;
    const dormant = Array.isArray(intentionsValue.dormant) ? intentionsValue.dormant.length : 0;
    const running = Array.isArray(coordinatorValue.running) ? coordinatorValue.running.length : 0;
    const queued = Array.isArray(coordinatorValue.queued) ? coordinatorValue.queued.length : 0;
    const limit = Number(budgetValue.contextLimit) || 0;
    const injected = Number(budgetValue.injectedTokens) || 0;

    const renderCell = (key, label, render, options = {}) => {
        const cellValueForKey = snapshot[key];
        if (!cellValueForKey?.ok) return errorCard(label, cellValueForKey);
        return card({ ...options, label, body: render(cellValueForKey.value) });
    };
    const renderKnowledge = () => {
        if (!snapshot.growthEvidence?.ok) return errorCard('Knowledge', snapshot.growthEvidence);
        return card({
            label: 'Knowledge',
            icon: '🧠',
            tab: 'knowledge',
            empty: !staging && !growth,
            body: `${countText(staging, 'item')} pending staging · ${countText(growth, 'unread growth item')}`,
        });
    };

    return `<section class="mwt-overview" aria-label="Overview dashboard">
        <div class="mwt-overview-header"><div><h2>${EMOJI}🏠</span> Overview</h2>
            <p>Read-only status for this chat. Open a module for details.</p></div>
            <button type="button" id="mwt-overview-refresh" class="mwt-btn" title="Refresh Overview">🔄 Refresh</button>
        </div>
        <div class="mwt-overview-grid">
            ${renderCell('worldState', 'World State', () => worldBody, { icon: '🌍', tab: 'world-state' })}
            ${snapshot.staging?.ok ? renderKnowledge() : errorCard('Knowledge', snapshot.staging)}
            ${renderCell('beats', 'Story Planner', () => `${countText(awaiting, 'beat')} awaiting · ${countText(overdue, 'beat')} overdue`, { icon: '🗺️', tab: 'story-planner', empty: !awaiting && !overdue })}
            ${renderCell('intentions', 'Interiority', () => `${countText(active, 'active intention')} · ${countText(dormant, 'dormant intention')}`, { icon: '💭', tab: 'interiority', empty: !active && !dormant })}
            ${renderCell('budget', 'Budget', () => `${injected.toLocaleString()} injected${limit ? ` of ${limit.toLocaleString()} tokens` : ' tokens'}${budgetValue.enforce ? ' · enforce on' : ' · observe mode'}`, { icon: '📊', tab: 'budget' })}
            ${renderCell('coordinator', 'Coordinator', () => `${countText(running, 'running job')} · ${countText(queued, 'queued job')}${coordinatorValue.userGeneration?.backgroundPaused ? ' · background HELD' : ''}`, { icon: '🚦', tab: 'settings' })}
            ${renderCell('health', 'Health', renderHealth, { icon: '❤️', tab: 'diagnostics' })}
            ${renderCell('deletedIntentions', 'Deleted intentions', (value) => `${Array.isArray(value) ? value.length : Number(value) || 0} records`, { icon: '🗑️', tab: 'interiority', empty: !cellValue(snapshot.deletedIntentions, []).length })}
            ${renderCell('quarantine', 'Quarantine', (value) => `${Number(value?.total) || 0} quarantined records`, { icon: '🗂️', tab: 'diagnostics', empty: !(Number(cellValue(snapshot.quarantine, {})?.total) || 0) })}
        </div>
        <footer class="mwt-overview-footer">Something looks wrong? ${linkButton('diagnostics', 'Open Diagnostics')} · ${linkButton('budget', 'Open Budget')}</footer>
    </section>`;
}

/** Collect and render the pane. A collector can be injected by tests/embedders. */
export function renderOverviewPane({ collect = collectOverviewSnapshot } = {}) {
    try {
        return renderOverviewSnapshot(collect());
    } catch (error) {
        return `<section class="mwt-overview" role="status"><h2>${EMOJI}🏠</span> Overview unavailable</h2><p>${escapeHtml(error?.message || error)}</p></section>`;
    }
}

export function wireOverviewPane(root, { collect = collectOverviewSnapshot } = {}) {
    if (!root?.querySelector) return;
    const pane = root.querySelector('.mwt-tab-content[data-tab="overview"]');
    if (!pane) return;
    pane.querySelectorAll('[data-overview-tab]').forEach((button) => {
        button.addEventListener('click', () => root.querySelector(`#mwt-tab-${button.dataset.overviewTab}`)?.click());
    });
    pane.querySelector('#mwt-overview-refresh')?.addEventListener('click', () => {
        pane.innerHTML = renderOverviewPane({ collect });
        wireOverviewPane(root, { collect });
    });
}