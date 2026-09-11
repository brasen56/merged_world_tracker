/**
 * dashboard/render.js — the Overview tab.
 *
 * Rendering is deliberately independent from the main entry point.  This
 * keeps the pane testable under jsdom and makes a failed status accessor a
 * local card error rather than a blank dashboard. The 🧰 maintenance tools
 * wired here change data — always behind a preview→confirm modal — while the
 * audits feeding the Findings list stay read-only.
 */

import { escapeHtml } from '../core/diff.js';
import { collectOverviewSnapshot } from './status.js';
import {
    applyPrunePlan,
    applyRelinkPlan,
    collectGuardedMaintenanceFindings,
    collectMaintenanceTools,
    maintenanceActions,
} from './maintenance.js';
import { createModal, setModalOpener, setStatus, showModal } from '../core/modal.js';
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
    // mwt-btn supplies the theme-aware chrome — without it the host's default
    // button background met the pane's inherited text color (white on white).
    return `<button type="button" class="mwt-btn mwt-overview-link" data-overview-tab="${escapeHtml(tab)}">${escapeHtml(text)}</button>`;
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
        // The console twin's wording (MWT.profiles.relink): relink does pick a
        // candidate automatically — largest entry, newest on ties — so the
        // honest warning is about otherCandidates, not about skipping.
        summary += ` ${countText(crowded, 'NPC')} also ${crowded === 1 ? 'has' : 'have'} duplicate entries — the preview auto-picks the largest entry (newest on ties). Check "otherCandidates" is 0 there: anything higher means duplicates exist and MWT.profiles.duplicates() is worth a look first.`;
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
 * Render the 🔎 Findings section from non-empty findings. An empty list
 * renders nothing at all — the Overview cards above already show the
 * healthy state, and a separate "clean" line would just repeat them.
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
            ? '<button type="button" class="mwt-btn" data-maintenance-action="prune">Preview profile prune</button>'
            : finding.kind === 'relink-candidates'
                ? '<button type="button" class="mwt-btn" data-maintenance-action="relink">Preview profile relink</button>'
                : '';
        return `<li class="mwt-overview-finding"><strong>${escapeHtml(label)}</strong> — ${escapeHtml(summary)} <code>${escapeHtml(finding.command || 'review manually')}</code>${action}${renderReview(review)}</li>`;
    }).join('');
    return `<section class="mwt-overview-maintenance" aria-label="Maintenance findings">
        <h3>${EMOJI}🔎</span> Findings</h3>
        <p>The audits are read-only; each finding names the console command with the full details. The Preview buttons open a confirmation before anything is applied.</p>
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
            <button type="button" class="mwt-btn" data-maintenance-action="clear-evidence" ${evidence.length ? '' : 'disabled'}>Clear all evidence (${countText(evidence.length, 'NPC')})</button>
            <button type="button" class="mwt-btn" data-maintenance-action="clear-deletions" ${deletions ? '' : 'disabled'}>Clear deleted intentions (${deletions})</button>
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
            <p>Status for this chat. Open a module for details.</p></div>
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
        // A failing inventory must not become an unhandled rejection with a
        // silently empty Tools section — render the failure locally.
        Promise.resolve().then(() => collectTools()).then((tools) => {
            if (!toolsHost.isConnected) return;
            toolsHost.innerHTML = renderToolsDisclosure(tools);
            // Bind ONLY inside the section that just rendered. Binding
            // pane-wide here AND again when Findings settles gave every
            // button two click handlers (doubled modals, doubled previews).
            wireMaintenanceActions(toolsHost, { pane, actions, collectTools });
        }).catch((error) => {
            if (toolsHost.isConnected) {
                toolsHost.innerHTML = `<p class="mwt-overview-tools-error" role="status">Tools unavailable: ${escapeHtml(String(error?.message ?? error))}</p>`;
            }
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
                wireMaintenanceActions(maintenanceHost, { pane, findings: result.value, actions, prune, relink });
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

const NO_ACTION_PREVIEW = '<p>No actionable changes found.</p>';
const CHAT_CHANGED_REASON = 'The chat changed. Review a fresh preview before applying.';
const EVIDENCE_LIST_CHANGED_REASON = 'The evidence list changed since this preview — background capture may have added an NPC. Preview again.';

/**
 * Accurate wording for a failed strict scope check on the clear tools. An
 * unknown identity did not "change" — the host simply never exposed a chat
 * id, so say that and point at the console twin that still works there.
 */
function clearScopeRefusal(check, isEvidence) {
    if (check.reason === 'identity-unknown') {
        const twin = isEvidence ? 'MWT.evidence.clearAll(true)' : 'MWT.interiority.clearDeletions()';
        return `This host does not expose a chat id, so this tool cannot verify which chat it would erase. The console twin (${twin}) still works there.`;
    }
    return 'The chat changed while the inventory loaded. Nothing was applied — reopen this tool from the refreshed pane.';
}

/** Order-insensitive name-list comparison for the confirm-time recheck. */
function sameNameList(left = [], right = []) {
    const a = [...left].sort();
    const b = [...right].sort();
    return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** The prune preview mirrors the console dry-run table: uids, size, preview. */
function renderPrunePreviewTable(rows) {
    const body = rows.map((row) => `<tr>` +
        `<td>${escapeHtml(row.npc || '(unnamed)')}</td>` +
        `<td>${escapeHtml(String(row.uid ?? ''))}</td>` +
        `<td>${escapeHtml(String(row.keptUid ?? ''))}</td>` +
        `<td>${escapeHtml(String(row.chars ?? ''))}</td>` +
        `<td>${escapeHtml(row.preview || '')}</td>` +
        `</tr>`).join('');
    return `<table><thead><tr><th>NPC</th><th>Delete uid</th><th>Keep uid</th><th>Size</th><th>Preview</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** The relink preview shows otherCandidates — the column the caveat is about. */
function renderRelinkPreviewTable(rows) {
    const body = rows.map((row) => `<tr>` +
        `<td>${escapeHtml(row.npc || '')}</td>` +
        `<td>${escapeHtml(String(row.linkUid ?? ''))}</td>` +
        `<td>${escapeHtml(String(row.was ?? ''))}</td>` +
        `<td>${escapeHtml(String(row.otherCandidates ?? 0))}</td>` +
        `</tr>`).join('');
    return `<table><thead><tr><th>NPC</th><th>Link to uid</th><th>Was</th><th>Other candidates</th></tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Open the shared preview→confirm modal. `{ refusal }` shows a visible,
 * accurate refusal instead of an actionable preview: confirm starts disabled
 * and the reason lands in the status bar. Returns the modal element.
 */
function openActionModal(pane, title, preview, apply, consequence, scopeToken, { refusal = '' } = {}) {
    const id = 'mwt-overview-tool-modal';
    const modal = createModal({
        id, title,
        content: `<div class="mwt-overview-tool-preview">${preview}</div>
            <p class="mwt-overview-tool-consequence"><strong>Before continuing:</strong> ${escapeHtml(consequence)}</p>
            <button type="button" class="mwt-btn" data-tool-confirm disabled>Confirm and apply</button>`,
    });
    const confirm = modal.querySelector('[data-tool-confirm]');
    const ready = !refusal && preview && preview !== NO_ACTION_PREVIEW;
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
            // Surface the orphan consequence here too: the clear action knows
            // which profiles it actually left unbacked.
            const orphanNote = Array.isArray(result?.orphaned) && result.orphaned.length
                ? ` ${countText(result.orphaned.length, 'generated profile')} now unbacked by evidence: ${result.orphaned.join(', ')}.`
                : '';
            setStatus(modal, `Applied.${orphanNote} The pane has been refreshed — findings are re-checked automatically.`, 'success');
            confirm.disabled = true;
            modal._mwtActionCompleted = true;
            const root = pane._mwtRoot;
            pane.innerHTML = renderOverviewPane({ collect: pane._mwtWireOptions?.collect });
            wireOverviewPane(root, pane._mwtWireOptions || {});
            // The re-render destroyed the button that opened this modal, so
            // closing it would drop focus to <body>. Retarget the restore at
            // the Refresh control — its fresh twin — to keep focus in the pane.
            setModalOpener(modal, pane.querySelector('#mwt-overview-refresh'));
        } catch (error) {
            setStatus(modal, error?.message || String(error), 'error');
        } finally {
            setControlBusy(confirm, false);
            if (modal._mwtActionCompleted) confirm.disabled = true;
        }
    });
    showModal(id);
    if (refusal) setStatus(modal, refusal, 'error');
    return modal;
}

/** Open a modal that only states a refusal/error — confirm stays disabled. */
function openRefusalModal(pane, title, message) {
    return openActionModal(pane, title, `<p>${escapeHtml(message)}</p>`,
        () => ({ ok: false, reason: message }), 'Nothing will be applied from this preview.', null, { refusal: message });
}

/** The two clear tools: inventory → strict scope → preview naming consequences. */
async function openClearActionModal(pane, isEvidence, { actions, collectTools }) {
    const title = isEvidence ? 'Clear all evidence' : 'Clear deleted intentions';
    const scopeToken = captureScope();
    const tools = await collectTools();
    // Strict identity is deliberate here — a clear erases this chat's data —
    // but a refusal must be visible and accurate, never a silent no-op.
    const scopeCheck = assertSameScope(scopeToken);
    if (!scopeCheck.ok) {
        openRefusalModal(pane, title, clearScopeRefusal(scopeCheck, isEvidence));
        return;
    }
    const names = tools.evidenceNames || [];
    const count = isEvidence ? names.length : Number(tools.deletionCount) || 0;
    if (!count) return;
    const body = isEvidence
        ? `<p>${countText(count, 'NPC evidence file')} will be cleared.</p>`
            + (names.length ? `<p>Affected NPCs: ${escapeHtml(names.join(', '))}</p>` : '')
            + (tools.orphanWarning ? `<p class="mwt-overview-tool-consequence">${escapeHtml(tools.orphanWarning)}</p>` : '')
        : `<p>${countText(count, 'deletion record')} will be cleared.</p>`;
    openActionModal(pane, title, body, async () => {
        if (!assertSameScope(scopeToken).ok) return { ok: false, reason: CHAT_CHANGED_REASON };
        if (isEvidence) {
            // Background capture can enroll an NPC while the modal sat open;
            // never clear a list the user was not shown.
            const fresh = await collectTools();
            // Check the scope again AFTER the await (core/scope.js: after each
            // await, before every commit). Two chats with one character often
            // share an NPC list, so the name comparison alone can't catch a switch.
            if (!assertSameScope(scopeToken).ok) return { ok: false, reason: CHAT_CHANGED_REASON };
            if (!sameNameList(fresh.evidenceNames, names)) return { ok: false, reason: EVIDENCE_LIST_CHANGED_REASON };
            return actions.clearAllEvidence();
        }
        return actions.clearDeletedIntentions();
    }, isEvidence ? 'This cannot be undone and rebuilding evidence costs API calls.' : 'These intentions may be proposed again.', scopeToken);
}

/** The two plan tools: finding rows → labelled preview table → guarded apply. */
function openPlanActionModal(pane, kind, { findings, prune, relink }) {
    const finding = (findings || []).find((item) => item.kind === (kind === 'prune' ? 'duplicate-profiles' : 'relink-candidates'));
    if (!finding) return;
    const isPrune = kind === 'prune';
    const rows = isPrune ? (finding.toDelete || []) : (finding.rows || []);
    const table = rows.length
        ? (isPrune ? renderPrunePreviewTable(rows) : renderRelinkPreviewTable(rows))
        : NO_ACTION_PREVIEW;
    openActionModal(pane, isPrune ? 'Preview profile prune' : 'Preview profile relink', table,
        (scopeToken) => (isPrune ? prune : relink)({ previewRows: rows, scopeToken }),
        isPrune
            ? 'Only automatically safe duplicate entries are deleted; unnamed and tied-size groups remain manual. Deleted profiles are regeneratable from evidence, but only if the evidence is still there.'
            : 'The registry pointers will be changed; each link targets the largest entry (newest on ties). Check "otherCandidates" is 0: anything higher means duplicates exist and MWT.profiles.duplicates() is worth a look first.',
        captureScope());
}

/**
 * Bind the maintenance action buttons inside ONE freshly rendered section —
 * never pane-wide, or buttons alive when two sections settle get double
 * listeners (doubled modals on one click).
 */
function wireMaintenanceActions(section, {
    pane,
    findings = [],
    actions = maintenanceActions,
    prune = applyPrunePlan,
    relink = applyRelinkPlan,
    collectTools = collectMaintenanceTools,
} = {}) {
    section.querySelectorAll('[data-maintenance-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            const kind = button.dataset.maintenanceAction;
            const title = kind === 'clear-evidence' ? 'Clear all evidence'
                : kind === 'clear-deletions' ? 'Clear deleted intentions'
                    : kind === 'prune' ? 'Preview profile prune' : 'Preview profile relink';
            try {
                if (kind === 'clear-deletions' || kind === 'clear-evidence') {
                    await openClearActionModal(pane, kind === 'clear-evidence', { actions, collectTools });
                    return;
                }
                openPlanActionModal(pane, kind, { findings, prune, relink });
            } catch (error) {
                // e.g. the tools inventory itself failed — visible, not an
                // unhandled rejection with a click that did nothing.
                openRefusalModal(pane, title, `The tool could not load its data: ${error?.message ?? error}`);
            }
        });
    });
}
