/**
 * dashboard/render.js — the read-only Overview tab.
 *
 * Rendering is deliberately independent from the main entry point.  This
 * keeps the pane testable under jsdom and makes a failed status accessor a
 * local card error rather than a blank dashboard.
 */

import { escapeHtml } from '../core/diff.js';
import { collectOverviewSnapshot } from './status.js';
import { collectGuardedMaintenanceFindings } from './maintenance.js';
import { collectMaintenanceTools, maintenanceActions, applyPrunePlan, applyRelinkPlan } from './maintenance.js';
import { createModal, showModal, setStatus } from '../core/modal.js';
import { setControlBusy } from '../core/ui.js';
import { assertSameScope, captureScope } from '../core/scope.js';

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

// ─── 🧰 Maintenance ──────────────────────────────────────────────────────────

const IDENTITY_KINDS = [
    ['untracked-entry', 'untracked entry', 'untracked entries'],
    ['entry-not-linked', 'unlinked entry', 'unlinked entries'],
    ['registry-alias', 'alias record'],
    ['ambiguous-name', 'ambiguous name'],
];

// Longer lists stay in the console command's output.
const REVIEW_LIMIT = 5;

/** "A, B, C and 4 more" — keeps a finding to one scannable line. */
function nameList(names = [], max = 3) {
    const unique = [...new Set(names.filter(Boolean))];
    const shown = unique.slice(0, max).join(', ');
    return unique.length > max ? `${shown} and ${unique.length - max} more` : shown;
}

function describeDuplicates(finding) {
    const prune = Number(finding.pruneCount) || 0;
    const names = nameList(finding.prunableNpcs);
    return {
        summary: prune
            ? `${countText(prune, 'extra entry', 'extra entries')} can be pruned automatically${names ? ` (${names})` : ''}.`
            : 'nothing can be pruned automatically.',
        review: (finding.review || []).map((group) => (group.reason === 'unnamed'
            ? `${countText(group.count, 'entry', 'entries')} with no NPC name — they may belong to different characters.`
            : `${group.npc} — ${countText(group.count, 'entry', 'entries')} of identical size, none linked to the registry.`)),
    };
}

function describeRelink(finding) {
    const names = finding.relinkNpcs || [];
    const crowded = Number(finding.withOtherCandidates) || 0;
    let summary = names.length
        ? `${countText(names.length, 'profile')} can be relinked to ${names.length === 1 ? 'its' : 'their'} NPC (${nameList(names)}).`
        : 'nothing can be relinked automatically.';
    if (crowded) {
        summary += ` ${countText(crowded, 'NPC')} also ${crowded === 1 ? 'has' : 'have'} duplicate entries — check duplicates before relinking.`;
    }
    return {
        summary,
        review: (finding.unmatched || []).map(({ npc }) => `${npc} — no NPC registry record; scan the NPC into the Knowledge book first.`),
    };
}

function describeIdentities(finding) {
    const byKind = finding.byKind || {};
    const parts = IDENTITY_KINDS
        .filter(([kind]) => byKind[kind])
        .map(([kind, singular, plural]) => countText(byKind[kind], singular, plural));
    const sentences = [`${parts.join(' · ') || countText(finding.count, 'finding')}.`];
    const names = nameList((finding.rows || []).map((row) => row.npc));
    if (names) sentences.push(`Involves ${names}.`);
    if (byKind['ambiguous-name']) {
        sentences.push('Ambiguous short names are not proven to be one character — rename the short record instead of merging.');
    }
    if (finding.registryEmpty) {
        sentences.push('The NPC registry for this chat is empty: if these entries are real, the From Lorebooks button re-adopts them.');
    }
    sentences.push('Cleanup is manual, in the World Info editor — the console command prints the steps.');
    return { summary: sentences.join(' '), review: [] };
}

function describeGeneric(finding) {
    return { summary: `${countText(finding.count, 'finding')}.`, review: [] };
}

const MAINTENANCE_KINDS = {
    'duplicate-profiles': { label: 'Duplicate profiles', describe: describeDuplicates },
    'relink-candidates': { label: 'Profile links', describe: describeRelink },
    'npc-identity-audit': { label: 'NPC identities', describe: describeIdentities },
};

function renderReview(items) {
    if (!items.length) return '';
    const shown = items.slice(0, REVIEW_LIMIT).map((text) => `<li>Review by hand: ${escapeHtml(text)}</li>`);
    if (items.length > REVIEW_LIMIT) shown.push(`<li>…and ${items.length - REVIEW_LIMIT} more — see the console command.</li>`);
    return `<ul class="mwt-overview-review">${shown.join('')}</ul>`;
}

/**
 * Render the 🧰 Maintenance section, or a one-line clean state naming the
 * console audits when no audit found anything (plan §4.3.3).
 */
export function renderMaintenanceFindings(findings = []) {
    if (!Array.isArray(findings)) return '';
    if (findings.length === 0) return '';
    const rows = findings.map((finding) => {
        if (finding.kind === 'maintenance-error') {
            return `<li class="mwt-overview-finding"><strong>${escapeHtml(finding.source || 'Maintenance audit')}</strong> — unavailable: ${escapeHtml(finding.error || 'unknown error')}</li>`;
        }
        const { label, describe } = MAINTENANCE_KINDS[finding.kind] || { label: 'Maintenance finding', describe: describeGeneric };
        const { summary, review } = describe(finding);
        const action = finding.kind === 'duplicate-profiles'
            ? '<button type="button" data-maintenance-action="prune">Preview profile prune</button>'
            : finding.kind === 'relink-candidates'
                ? '<button type="button" data-maintenance-action="relink">Preview profile relink</button>'
                : '';
        return `<li class="mwt-overview-finding"><strong>${escapeHtml(label)}</strong> — ${escapeHtml(summary)} <code>${escapeHtml(finding.command || 'review manually')}</code>${action}${renderReview(review)}</li>`;
    }).join('');
    return `<section class="mwt-overview-maintenance" aria-label="Maintenance findings">
        <h3>${EMOJI}🔎</span> Findings</h3>
        <p>These checks are read-only — each finding names the console command with the full details.</p>
        <ul>${rows}</ul>
    </section>`;
}

function renderToolsDisclosure(tools = {}) {
    const evidence = tools.evidenceNames || [];
    const deletions = Number(tools.deletionCount) || 0;
    return `<details class="mwt-overview-tools">
        <summary>${EMOJI}🧰</span> Tools</summary>
        <p>Destructive maintenance actions are hidden here until you deliberately open them.</p>
        <div class="mwt-overview-tool-grid">
            <button type="button" data-maintenance-action="clear-evidence" ${evidence.length ? '' : 'disabled'}>Clear all evidence (${evidence.length} NPCs)</button>
            <button type="button" data-maintenance-action="clear-deletions" ${deletions ? '' : 'disabled'}>Clear deleted intentions (${deletions})</button>
        </div>
    </details>`;
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
        <div data-overview-maintenance></div>
        <div data-overview-tools></div>
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

export function wireOverviewPane(root, {
    collect = collectOverviewSnapshot,
    collectMaintenance = collectGuardedMaintenanceFindings,
    collectTools = collectMaintenanceTools,
    actions = maintenanceActions,
    prune = applyPrunePlan,
    relink = applyRelinkPlan,
} = {}) {
    if (!root?.querySelector) return;
    const pane = root.querySelector('.mwt-tab-content[data-tab="overview"]');
    if (!pane) return;
    pane._mwtRoot = root;
    pane._mwtWireOptions = { collect, collectMaintenance, collectTools, actions, prune, relink };
    const maintenanceHost = pane.querySelector('[data-overview-maintenance]');
    const toolsHost = pane.querySelector('[data-overview-tools]');
    if (toolsHost) {
        Promise.resolve().then(() => collectTools()).then((tools) => {
            if (toolsHost.isConnected) toolsHost.innerHTML = renderToolsDisclosure(tools);
            if (toolsHost.isConnected) wireMaintenanceActions(pane, { actions, prune, relink, collectTools });
        });
    }
    if (maintenanceHost) {
        // A refresh or close detaches this host before a slow audit settles,
        // so a superseded result can never overwrite a newer one.
        collectMaintenance().then((result) => {
            if (!maintenanceHost.isConnected) return;
            maintenanceHost.innerHTML = result.ok
                ? renderMaintenanceFindings(result.value)
                : `<p class="mwt-overview-maintenance-error" role="status">Maintenance audit unavailable: ${escapeHtml(result.error)}</p>`;
            if (result.ok) {
                pane._mwtFindings = result.value;
                wireMaintenanceActions(pane, { actions, prune, relink, collectTools });
            }
        });
    }
    pane.querySelectorAll('[data-overview-tab]').forEach((button) => {
        button.addEventListener('click', () => root.querySelector(`#mwt-tab-${button.dataset.overviewTab}`)?.click());
    });
    pane.querySelector('#mwt-overview-refresh')?.addEventListener('click', () => {
        pane.innerHTML = renderOverviewPane({ collect });
        wireOverviewPane(root, { collect, collectMaintenance, collectTools, actions, prune, relink });
        // The clicked button was just replaced; keep keyboard focus on its twin.
        pane.querySelector('#mwt-overview-refresh')?.focus();
    });
}

function openActionModal(pane, title, preview, apply, consequence, scopeToken) {
    const id = 'mwt-overview-tool-modal';
    const modal = createModal({
        id, title,
        content: `<div class="mwt-overview-tool-preview">${preview}</div>
            <p class="mwt-overview-tool-consequence"><strong>Before continuing:</strong> ${escapeHtml(consequence)}</p>
            <button type="button" class="mwt-btn" data-tool-confirm disabled>Confirm and apply</button>`,
    });
    const confirm = modal.querySelector('[data-tool-confirm]');
    const ready = preview && preview !== '<p>No actionable changes found.</p>';
    confirm.disabled = !ready;
    confirm.addEventListener('click', async () => {
        setControlBusy(confirm, true);
        setStatus(modal, 'Applying…', 'info');
        try {
            const result = await apply(scopeToken);
            if (result?.ok === false || result?.success === false) {
                setStatus(modal, result.reason || result.error || 'The action could not be applied.', 'error');
                return;
            }
            setStatus(modal, 'Applied. Refresh Overview to re-check findings.', 'success');
            confirm.disabled = true;
            modal._mwtActionCompleted = true;
            const root = pane._mwtRoot;
            pane.innerHTML = renderOverviewPane({ collect: pane._mwtWireOptions?.collect });
            wireOverviewPane(root, pane._mwtWireOptions || {});
        } catch (error) {
            setStatus(modal, error?.message || String(error), 'error');
        } finally {
            setControlBusy(confirm, false);
            if (modal._mwtActionCompleted) confirm.disabled = true;
        }
    });
    showModal(id);
}

function wireMaintenanceActions(pane, { actions, prune, relink, collectTools }) {
    pane.querySelectorAll('[data-maintenance-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            const kind = button.dataset.maintenanceAction;
            if (kind === 'clear-deletions' || kind === 'clear-evidence') {
                const scopeToken = captureScope();
                const tools = await collectTools();
                if (!assertSameScope(scopeToken).ok) return;
                const isEvidence = kind === 'clear-evidence';
                const names = tools.evidenceNames || [];
                const count = isEvidence ? names.length : tools.deletionCount;
                if (!count) return;
                openActionModal(pane, isEvidence ? 'Clear all evidence' : 'Clear deleted intentions',
                    `<p>${count} ${isEvidence ? 'NPC evidence files' : 'deletion records'} will be cleared.</p>${isEvidence ? `<p>Affected NPCs: ${escapeHtml(names.join(', '))}</p>` : ''}`,
                    () => {
                        if (!assertSameScope(scopeToken).ok) return { ok: false, reason: 'The chat changed. Review a fresh preview before applying.' };
                        return isEvidence ? actions.clearAllEvidence() : actions.clearDeletedIntentions();
                    },
                    isEvidence ? 'This cannot be undone and rebuilding evidence costs API calls.' : 'These intentions may be proposed again.', scopeToken);
                return;
            }
            const finding = (pane._mwtFindings || []).find((item) => item.kind === (kind === 'prune' ? 'duplicate-profiles' : 'relink-candidates'));
            if (!finding) return;
            const rows = kind === 'prune' ? (finding.toDelete || []) : (finding.rows || []);
            const table = rows.length
                ? `<table><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.npc || '')}</td><td>${escapeHtml(String(row.uid ?? row.linkUid ?? ''))}</td><td>${escapeHtml(String(row.keptUid ?? row.was ?? ''))}</td></tr>`).join('')}</tbody></table>`
                : '<p>No actionable changes found.</p>';
            const apply = kind === 'prune'
                ? (scopeToken) => prune({ previewRows: rows, scopeToken })
                : (scopeToken) => relink({ previewRows: rows, scopeToken });
            const scopeToken = captureScope();
            openActionModal(pane, kind === 'prune' ? 'Preview profile prune' : 'Preview profile relink', table, apply, kind === 'prune'
                ? 'Only automatically safe duplicate entries are deleted; unnamed and tied-size groups remain manual.'
                : 'The registry pointers will be changed, and ambiguous candidates are not automatically selected.', scopeToken);
        });
    });
}
