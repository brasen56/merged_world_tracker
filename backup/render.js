/**
 * backup/render.js — UI for unified backup/restore (Phase 4).
 *
 * A "Backup / Restore" panel lives in the Settings tab. Export downloads a
 * versioned envelope via exportBackup(); Restore runs the two-step dry run
 * (previewRestore → confirm → restoreBackup) with a summary modal; Undo replays
 * the in-memory pre-restore snapshot via undoLastRestore().
 *
 * The pure summary/mode helpers are exported separately so they can be unit-
 * tested without a DOM. The DOM-coupled handlers follow the Chronicle/World
 * State conventions: createModal/showModal/hideModal/setStatus from
 * core/modal.js and downloadJson/pickTextFile from core/file.js.
 */

import {
    createModal,
    showModal,
    hideModal,
    setStatus,
    pickTextFile,
    escapeHtml,
} from '../core/index.js';
import {
    exportBackup,
    previewRestore,
    restoreBackup,
    undoLastRestore,
} from './index.js';

const SUMMARY_MODAL_ID = 'mwt-backup-summary-modal';

const state = {
    /** Parent MWT modal element (set by wireBackupEvents). */
    modal: null,
    /** True while an export/restore/undo is in flight; disables the buttons. */
    busy: false,
    /** Envelope of the file currently open in the summary modal. */
    pendingEnvelope: null,
    /** Last computed preview (with previewToken) for the open summary modal. */
    pendingPreview: null,
    /** Whether the open summary modal is in exact (replace) mode. */
    pendingExact: false,
};

// ─── Pure presenters (no DOM, unit-tested directly) ───────────────────────────

export const SECTION_LABELS = Object.freeze({
    worldState: '🌍 World State',
    chronicle: '📜 Chronicle',
    knowledgeEvidence: '🧠 Knowledge Evidence',
    knowledgeCounters: '🔢 Knowledge Counters',
    storyPlanner: '🗺️ Story Planner',
    interiority: '💭 Interiority',
    knowledgeStore: '📖 Registry & State Tracker',
});

export const SECTION_ORDER = Object.freeze([
    'worldState',
    'chronicle',
    'knowledgeEvidence',
    'knowledgeCounters',
    'storyPlanner',
    'interiority',
    'knowledgeStore',
]);

/**
 * Turn one section summary into a structured, display-ready object.
 *
 * Merge-mode sections carry {added, updated, skipped[], conflicts}. Exact-mode
 * sections (built by previewExactRestore) carry {mode, action, replaced,
 * removed, unchanged}. Either shape is normalised here.
 *
 * @returns {{label,kind,action?,added,updated,skippedCount,conflicts,skipped}|null}
 */
export function describeSectionSummary(name, sectionSummary) {
    if (!sectionSummary || typeof sectionSummary !== 'object') return null;
    const label = SECTION_LABELS[name] || name;
    const skipped = Array.isArray(sectionSummary.skipped) ? sectionSummary.skipped : [];
    if (sectionSummary.action) {
        return {
            label,
            kind: 'exact',
            action: sectionSummary.action,
            added: sectionSummary.replaced || 0,
            updated: 0,
            skippedCount: skipped.length,
            conflicts: Number(sectionSummary.conflicts) || 0,
            skipped,
        };
    }
    return {
        label,
        kind: 'merge',
        added: Number(sectionSummary.added) || 0,
        updated: Number(sectionSummary.updated) || 0,
        skippedCount: skipped.length,
        conflicts: Number(sectionSummary.conflicts) || 0,
        skipped,
    };
}

/**
 * Build a structured summary of an entire preview for display. Pure: it only
 * reads the preview/envelope objects the planner already returned.
 */
export function summarizePreview(preview, envelope) {
    if (!preview || preview.ok === false) {
        return { ok: false, reason: preview?.reason || 'invalid', sections: [] };
    }
    const sections = [];
    for (const name of SECTION_ORDER) {
        const raw = preview.summary?.[name];
        if (!raw) continue;
        const desc = describeSectionSummary(name, raw);
        if (!desc) continue;
        if (name === 'interiority' && raw.perMessage) {
            desc.perMessage = {
                imported: raw.perMessage.imported || 0,
                resolved: raw.perMessage.resolved || 0,
                sameChat: raw.perMessage.sameChat === true,
            };
        }
        sections.push(desc);
    }
    const policy = preview.identityPolicy || {};
    const meta = envelope?._meta || {};
    return {
        ok: true,
        sameChat: preview.sameChat === true,
        sections,
        warning: policy.warning || null,
        restrictions: Array.isArray(policy.restrictions) ? policy.restrictions : [],
        identityKnown: policy.identityKnown !== false,
        exactAllowed: policy.exactAllowed !== false,
        chatName: meta.chatName || null,
        createdAt: meta.createdAt || null,
        messageCount: typeof meta.messageCount === 'number' ? meta.messageCount : null,
        identity: meta.identity || null,
        previewToken: preview.previewToken || null,
    };
}

/**
 * Turn a described section (describeSectionSummary output) into display
 * "change bits": [{text, tone}] with tone 'normal' | 'warning' | 'danger'.
 * Pure so the destructive cases are unit-testable — in exact mode a section
 * absent from the backup is DELETED at commit, and that must surface as
 * "will be removed", never as "0 replaced".
 */
export function formatSectionChangeBits(desc) {
    const bits = [];
    if (desc.kind === 'exact') {
        if (desc.action === 'removed') bits.push({ text: 'will be removed', tone: 'danger' });
        else if (desc.action === 'blocked') bits.push({ text: 'left unchanged (destination store refused)', tone: 'warning' });
        else if (desc.action === 'unchanged') bits.push({ text: 'unchanged', tone: 'normal' });
        else bits.push({ text: `${desc.added} replaced`, tone: 'normal' });
    } else {
        if (desc.added) bits.push({ text: `+${desc.added}`, tone: 'normal' });
        if (desc.updated) bits.push({ text: `~${desc.updated}`, tone: 'normal' });
        if (!desc.added && !desc.updated && !desc.skippedCount) bits.push({ text: 'no change', tone: 'normal' });
    }
    if (desc.skippedCount) bits.push({ text: `${desc.skippedCount} skipped`, tone: 'warning' });
    if (desc.conflicts) bits.push({ text: `${desc.conflicts} conflict${desc.conflicts === 1 ? '' : 's'}`, tone: 'warning' });
    return bits;
}

/**
 * Explain a failed preview. Environment problems (lorebook store not loaded,
 * chat switched mid-preview) must not be reported as "invalid backup file" —
 * the file is fine and the user needs to fix the environment, not the backup.
 * Validation failures surface the validator's own error sentences.
 *
 * @returns {{kind: 'environment'|'invalid', message: string}}
 */
export function describePreviewFailure(preview) {
    const reason = preview?.reason;
    if (reason === 'knowledge-store-unavailable') {
        return {
            kind: 'environment',
            message: 'The Knowledge lorebook store is not loaded, so the registry cannot be previewed. '
                + 'The backup file itself may be fine — reopen the chat, check the console for a '
                + 'store-load error, then try again.',
        };
    }
    if (reason === 'stale-scope') {
        return {
            kind: 'environment',
            message: `The chat changed while previewing (${preview?.staleReason || 'scope changed'}). `
                + 'Reopen the restore dialog in the target chat.',
        };
    }
    const errors = preview?.validation?.errors;
    if (Array.isArray(errors) && errors.length) {
        return { kind: 'invalid', message: `This file is not a valid MWT backup: ${errors.join(' ')}` };
    }
    return { kind: 'invalid', message: `This file is not a valid MWT backup (${reason || 'rejected'}).` };
}

/**
 * Translate the summary-modal control values into the `modes` object the
 * planner/commit APIs expect. Pure: takes plain values, returns a plain object.
 *
 * A control left at its default (empty string) yields NO entry, so the planner
 * applies its own identity-policy fallback (e.g. world state defaults to 'keep'
 * on unverified-identity builds). Only an explicit Replace/Keep/Skip overrides
 * that — the user can never silently coerce the policy default.
 */
export function buildRestoreModes({
    worldState = '',
    knowledgeCounters = '',
    restoreSessionConfig = false,
} = {}) {
    const modes = {};
    // An empty value means "let the planner apply its identity-policy default"
    // (e.g. world state defaults to 'keep' on unverified-identity builds). Only
    // an explicit Replace/Keep/Skip from the user overrides that.
    if (worldState === 'replace' || worldState === 'keep' || worldState === 'skip') {
        modes.worldState = worldState;
    }
    if (knowledgeCounters === 'replace' || knowledgeCounters === 'keep' || knowledgeCounters === 'skip') {
        modes.knowledgeCounters = knowledgeCounters;
    }
    if (restoreSessionConfig) modes.restoreSessionConfig = true;
    return modes;
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function setBackupStatus(message, type = 'info', clearAfterMs = 0) {
    if (state.modal) setStatus(state.modal, message, type, clearAfterMs);
}

function setBusy(busy) {
    state.busy = busy;
    const panel = state.modal?.querySelector('#mwt-backup-panel');
    if (!panel) return;
    panel.querySelectorAll('button[data-backup-action]').forEach(btn => {
        btn.disabled = busy;
    });
}

/**
 * Read the restore-mode control values from the summary-modal DOM into the
 * plain-values shape buildRestoreModes consumes. Split from buildRestoreModes so
 * the translation is unit-testable without a DOM.
 */
export function readRestoreControlValues(root) {
    const el = root || (typeof document !== 'undefined' ? document.getElementById(SUMMARY_MODAL_ID) : null);
    if (!el) return {};
    const val = (sel, fallback) => {
        const node = el.querySelector(sel);
        return node ? node.value : fallback;
    };
    const checked = sel => el.querySelector(sel)?.checked === true;
    return {
        worldState: val('#mwt-bk-ws-mode', ''),
        knowledgeCounters: val('#mwt-bk-counters-mode', ''),
        restoreSessionConfig: checked('#mwt-bk-session-config'),
        exact: checked('#mwt-bk-exact'),
    };
}

// ─── Settings-tab panel ───────────────────────────────────────────────────────

/**
 * The Backup / Restore control rendered inside the Settings tab. Buttons are
 * tagged with data-backup-action so wireBackupEvents can bind them by intent.
 */
export function renderBackupPanel() {
    return `
        <hr style="border-color:var(--mwt-border);margin:16px 0">
        <h3 style="margin-bottom:8px">💾 Backup / Restore</h3>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            Export a single versioned backup of <em>this chat's</em> MWT data (world state, chronicle, knowledge
            evidence/counters/registry, story planner, interiority), or restore one. Restore always shows a dry-run
            preview first and auto-downloads a pre-restore backup before writing anything. Lorebook-resident text
            (NPC dossiers/profiles) is not included — use the Knowledge tab's export for those.
        </p>
        <div id="mwt-backup-panel" class="mwt-backup-panel">
            <div class="mwt-flex mwt-gap-8" style="flex-wrap:wrap;align-items:center">
                <button id="mwt-bk-export" class="mwt-btn" data-backup-action="export">⬇ Export Backup</button>
                <button id="mwt-bk-restore" class="mwt-btn" data-backup-action="restore">⬆ Restore from File…</button>
                <button id="mwt-bk-undo" class="mwt-btn" data-backup-action="undo" title="Replay the pre-restore snapshot captured this session">↩ Undo Last Restore</button>
            </div>
        </div>
    `;
}

// ─── Export ───────────────────────────────────────────────────────────────────

async function handleExport() {
    if (state.busy) return;
    setBusy(true);
    setBackupStatus('Exporting backup…');
    try {
        await exportBackup();
        setBackupStatus('Backup exported.', 'success', 5000);
    } catch (err) {
        setBackupStatus(`Export failed: ${err?.message || err}`, 'error');
    } finally {
        setBusy(false);
    }
}

// ─── Restore: pick file ───────────────────────────────────────────────────────

async function handleRestorePick() {
    if (state.busy) return;
    let text;
    try {
        text = await pickTextFile('.json');
    } catch (err) {
        setBackupStatus(`Restore failed: could not read file (${err?.message || err}).`, 'error');
        return;
    }
    if (!text) return; // quiet cancellation from the native picker
    let envelope;
    try {
        envelope = JSON.parse(text);
    } catch {
        setBackupStatus('Restore failed: file is not valid JSON.', 'error');
        return;
    }
    await openRestoreSummary(envelope);
}

// ─── Restore: undo ────────────────────────────────────────────────────────────

async function handleUndo() {
    if (state.busy) return;
    if (!confirm('Undo the last restore? This replays the pre-restore snapshot captured this session.')) return;
    setBusy(true);
    setBackupStatus('Undoing last restore…');
    try {
        const result = await undoLastRestore({ confirm: true });
        if (result.ok && result.committed) {
            setBackupStatus('Last restore undone.', 'success', 5000);
        } else if (result.reason === 'no-restore-to-undo') {
            setBackupStatus('Nothing to undo — no restore has been performed this session.', 'info', 5000);
        } else if (result.reason === 'restore-origin-mismatch') {
            setBackupStatus('Cannot undo: the active chat differs from the one the restore targeted.', 'warning', 6000);
        } else {
            setBackupStatus(`Undo failed: ${result.reason || 'unknown error'}`, 'error');
        }
    } catch (err) {
        setBackupStatus(`Undo failed: ${err?.message || err}`, 'error');
    } finally {
        setBusy(false);
    }
}

// ─── Restore: dry-run summary modal ───────────────────────────────────────────

function buildSummaryModalContent() {
    return `
        <div id="mwt-bk-summary-meta" class="mwt-backup-meta"></div>
        <div id="mwt-bk-summary-warning"></div>
        <div class="mwt-backup-section-title">Per-section plan (preview — nothing is written yet)</div>
        <div id="mwt-bk-summary-table" class="mwt-backup-summary-table"></div>
        <details class="mwt-backup-skipped" style="margin-top:8px">
            <summary style="cursor:pointer;color:var(--mwt-accent)">Skipped / conflicting records</summary>
            <div id="mwt-bk-summary-skipped" style="margin-top:6px"></div>
        </details>
        <hr style="border-color:var(--mwt-border);margin:12px 0">
        <div class="mwt-backup-section-title">Restore options</div>
        <div class="mwt-settings-grid" style="grid-template-columns:auto 1fr;align-items:center;gap:6px 12px">
            <label class="mwt-label" for="mwt-bk-ws-mode" style="margin:0;text-align:left">🌍 World State</label>
            <select id="mwt-bk-ws-mode" class="mwt-input" style="width:auto">
                <option value="">Default (recommended)</option>
                <option value="replace">Replace with backup</option>
                <option value="keep">Keep current</option>
            </select>
            <label class="mwt-label" for="mwt-bk-counters-mode" style="margin:0;text-align:left">🔢 Counters</label>
            <select id="mwt-bk-counters-mode" class="mwt-input" style="width:auto">
                <option value="">Default (recommended)</option>
                <option value="replace">Replace with backup</option>
                <option value="keep">Keep current</option>
            </select>
            <label class="mwt-label" style="margin:0;text-align:left;display:flex;align-items:center;gap:6px;cursor:pointer;grid-column:1/3">
                <input type="checkbox" id="mwt-bk-session-config">
                <span>Also restore session settings (Chronicle injection, Interiority enabled/turn counter)</span>
            </label>
            <label class="mwt-label" style="margin:0;text-align:left;display:flex;align-items:center;gap:6px;cursor:pointer;grid-column:1/3">
                <input type="checkbox" id="mwt-bk-exact">
                <span><strong>Exact (replace) mode</strong> — overwrite this chat's data entirely instead of merging. Same-chat only.</span>
            </label>
        </div>
        <p id="mwt-bk-exact-note" class="mwt-backup-exact-note" style="display:none;color:var(--mwt-danger);font-size:12px;margin-top:6px"></p>
        <div class="mwt-backup-footer mwt-flex mwt-gap-8" style="margin-top:14px;justify-content:flex-end">
            <button class="mwt-btn mwt-backup-cancel">Cancel</button>
            <button class="mwt-btn mwt-btn-primary mwt-backup-confirm" disabled>Confirm Restore</button>
        </div>
    `;
}

function formatBackupMeta(summary) {
    const bits = [];
    if (summary.chatName) bits.push(`<strong>${escapeHtml(summary.chatName)}</strong>`);
    if (summary.createdAt) {
        try { bits.push(new Date(summary.createdAt).toLocaleString()); }
        catch { bits.push(escapeHtml(String(summary.createdAt))); }
    }
    if (typeof summary.messageCount === 'number') bits.push(`${summary.messageCount} messages`);
    if (summary.sameChat) bits.push('<span style="color:var(--mwt-accent)">✓ same chat</span>');
    else if (summary.identityKnown) bits.push('<span style="color:var(--mwt-warning)">different chat</span>');
    else bits.push('<span style="color:var(--mwt-warning)">unverified identity</span>');
    return bits.length ? `<p class="mwt-text-dim mwt-text-sm" style="margin:0 0 8px">${bits.join(' · ')}</p>` : '';
}

const CHANGE_BIT_STYLES = Object.freeze({
    warning: 'color:var(--mwt-warning)',
    danger: 'color:var(--mwt-danger);font-weight:600',
});

function renderSummaryTable(container, sections) {
    if (!sections.length) {
        container.innerHTML = '<p class="mwt-text-dim mwt-text-sm">No sections in this backup.</p>';
        return;
    }
    const rows = sections.map(s => {
        const changeBits = formatSectionChangeBits(s).map(bit => {
            const style = CHANGE_BIT_STYLES[bit.tone];
            const text = escapeHtml(bit.text);
            return style ? `<span style="${style}">${text}</span>` : text;
        });
        let pm = '';
        if (s.perMessage) {
            const note = s.perMessage.sameChat
                ? `${s.perMessage.resolved}/${s.perMessage.imported} resolve in this chat`
                : 'different chat — skipped';
            pm = `<div class="mwt-text-dim" style="font-size:11px;margin-top:2px">per-message thoughts: ${note}</div>`;
        }
        return `<div class="mwt-backup-row">
            <span class="mwt-backup-row-label">${escapeHtml(s.label)}</span>
            <span class="mwt-backup-row-change">${changeBits.join(' · ') || '—'}</span>
        </div>${pm}`;
    });
    container.innerHTML = rows.join('');
}

function renderSkipped(container, sections) {
    const items = [];
    for (const s of sections) {
        for (const skip of s.skipped) {
            const rec = skip?.record;
            const recStr = rec === undefined || rec === null
                ? '(none)'
                : (typeof rec === 'object' ? escapeHtml(JSON.stringify(rec)) : escapeHtml(String(rec)));
            items.push(`<li><strong>${escapeHtml(s.label)}:</strong> ${escapeHtml(skip.reason || 'skipped')} <code style="color:var(--mwt-text-dim)">${recStr}</code></li>`);
        }
    }
    container.innerHTML = items.length
        ? `<ul style="margin:0;padding-left:18px;font-size:12px">${items.join('')}</ul>`
        : '<p class="mwt-text-dim mwt-text-sm" style="margin:0">None.</p>';
}

async function openRestoreSummary(envelope) {
    state.pendingEnvelope = envelope;
    state.pendingPreview = null;
    state.pendingExact = false;

    createModal({
        id: SUMMARY_MODAL_ID,
        title: 'Restore Backup — Dry Run',
        content: buildSummaryModalContent(),
        cssClass: 'mwt-backup-summary-modal',
    });
    showModal(SUMMARY_MODAL_ID);

    const modal = document.getElementById(SUMMARY_MODAL_ID);
    // Re-preview whenever a mode option changes so the table always reflects
    // the plan the user will confirm.
    const onChange = () => { refreshSummary(); };
    modal.querySelector('#mwt-bk-ws-mode')?.addEventListener('change', onChange);
    modal.querySelector('#mwt-bk-counters-mode')?.addEventListener('change', onChange);
    modal.querySelector('#mwt-bk-session-config')?.addEventListener('change', onChange);
    modal.querySelector('#mwt-bk-exact')?.addEventListener('change', onChange);
    modal.querySelector('.mwt-backup-confirm')?.addEventListener('click', () => { commitRestore(); });
    modal.querySelector('.mwt-backup-cancel')?.addEventListener('click', () => { hideModal(SUMMARY_MODAL_ID); });

    await refreshSummary();
}

/**
 * Re-run the dry-run preview against the current control values and repaint
 * the summary. Disables Confirm while previewing / when the preview is invalid.
 */
async function refreshSummary() {
    const modal = document.getElementById(SUMMARY_MODAL_ID);
    if (!modal) return;
    const tableEl = modal.querySelector('#mwt-bk-summary-table');
    const confirmBtn = modal.querySelector('.mwt-backup-confirm');
    const exactCheckbox = modal.querySelector('#mwt-bk-exact');
    const exactNote = modal.querySelector('#mwt-bk-exact-note');

    const values = readRestoreControlValues(modal);
    const modes = buildRestoreModes(values);
    const exact = values.exact === true;

    setStatus(modal, 'Previewing…', 'info');
    if (confirmBtn) confirmBtn.disabled = true;

    let preview;
    try {
        preview = await previewRestore(state.pendingEnvelope, { modes, exact });
    } catch (err) {
        tableEl.innerHTML = `<p style="color:var(--mwt-danger)">Preview failed: ${escapeHtml(err?.message || String(err))}</p>`;
        setStatus(modal, 'Preview failed.', 'error');
        return;
    }

    state.pendingPreview = preview;
    state.pendingExact = exact;
    const summary = summarizePreview(preview, state.pendingEnvelope);

    // Exact mode is only meaningful for a verifiable same-chat identity.
    if (exactCheckbox) {
        const blocked = exact && !summary.exactAllowed;
        if (blocked) {
            exactCheckbox.checked = false;
            state.pendingExact = false;
            // Re-preview in merge mode so the table matches the unchecked state.
            return refreshSummary();
        }
    }

    if (!preview.ok) {
        // Environment failures (store not loaded, chat switched) are not file
        // problems; validation failures surface the validator's own errors.
        // Written into the table container (not inserted before it) so repeated
        // refreshes never stack duplicate error paragraphs.
        const failure = describePreviewFailure(preview);
        modal.querySelector('#mwt-bk-summary-meta').innerHTML = '';
        modal.querySelector('#mwt-bk-summary-warning').innerHTML = '';
        modal.querySelector('#mwt-bk-summary-skipped').innerHTML = '';
        if (exactNote) exactNote.style.display = 'none';
        tableEl.innerHTML = `<p style="color:var(--mwt-danger)">${escapeHtml(failure.message)}</p>`;
        setStatus(modal, failure.kind === 'environment'
            ? 'Preview unavailable — fix the issue above, then try again.'
            : 'Cannot restore this file.', 'error');
        return;
    }
    if (exactNote) {
        exactNote.style.display = exact ? 'block' : 'none';
        exactNote.textContent = exact
            ? 'Exact mode overwrites this chat entirely. A pre-restore backup is downloaded automatically before anything is written.'
            : '';
    }

    modal.querySelector('#mwt-bk-summary-meta').innerHTML = formatBackupMeta(summary);
    const warnEl = modal.querySelector('#mwt-bk-summary-warning');
    const warns = [];
    if (summary.warning) warns.push(summary.warning);
    if (summary.restrictions.length) warns.push(summary.restrictions.join('; '));
    warnEl.innerHTML = warns.length
        ? `<p style="color:var(--mwt-warning);font-size:12px;margin:0 0 8px">⚠ ${escapeHtml(warns.join(' '))}</p>`
        : '';

    renderSummaryTable(tableEl, summary.sections);
    renderSkipped(modal.querySelector('#mwt-bk-summary-skipped'), summary.sections);

    setStatus(modal, 'Preview ready. Review the plan above, then confirm.', 'info');
    if (confirmBtn) confirmBtn.disabled = false;
}

/**
 * Commit the confirmed preview. The engine re-plans against live state and, if
 * the plan drifted from the preview the user saw (e.g. another update landed),
 * refuses with `reconfirmation-required` — we then refresh the summary so the
 * user can confirm the new plan.
 */
async function commitRestore() {
    const modal = document.getElementById(SUMMARY_MODAL_ID);
    if (!modal || !state.pendingPreview?.ok) return;
    const values = readRestoreControlValues(modal);
    const modes = buildRestoreModes(values);
    const exact = state.pendingExact;
    const previewToken = state.pendingPreview.previewToken;
    const confirmBtn = modal.querySelector('.mwt-backup-confirm');

    const verb = exact ? 'Replacing' : 'Restoring';
    if (exact) {
        if (!confirm('Confirm EXACT (replace) restore? This overwrites this chat\'s MWT data entirely. A pre-restore backup will download first.')) return;
    } else {
        if (!confirm('Confirm restore? A pre-restore backup will download automatically before anything is written.')) return;
    }

    if (confirmBtn) confirmBtn.disabled = true;
    setStatus(modal, `${verb}…`, 'info');
    setBusy(true);
    let result;
    try {
        result = await restoreBackup(state.pendingEnvelope, { confirm: true, exact, modes, previewToken });
    } catch (err) {
        setStatus(modal, `Restore failed: ${err?.message || err}`, 'error');
        if (confirmBtn) confirmBtn.disabled = false;
        setBusy(false);
        return;
    }

    if (result.ok && result.committed) {
        hideModal(SUMMARY_MODAL_ID);
        setBackupStatus(exact ? 'Exact restore complete.' : 'Restore complete.', 'success', 6000);
        setBusy(false);
        return;
    }
    setBusy(false);
    if (confirmBtn) confirmBtn.disabled = false;

    const reason = result.reason;
    if (reason === 'reconfirmation-required') {
        // The plan drifted between confirm and commit. Re-show the fresh preview.
        state.pendingPreview = result.preview;
        state.pendingExact = exact;
        const summary = summarizePreview(result.preview, state.pendingEnvelope);
        renderSummaryTable(modal.querySelector('#mwt-bk-summary-table'), summary.sections);
        renderSkipped(modal.querySelector('#mwt-bk-summary-skipped'), summary.sections);
        setStatus(modal, 'The plan changed since the preview (e.g. another update landed). Review and confirm again.', 'warning', 8000);
        return;
    }
    if (reason === 'stale-scope') {
        setStatus(modal, `Restore cancelled — the chat changed mid-restore (${result.staleReason || 'scope changed'}). No data was written.`, 'warning');
        return;
    }
    if (reason === 'exact-identity-required') {
        setStatus(modal, 'Exact (replace) restore needs a verifiable chat identity, which this build cannot provide. Use merge mode instead.', 'warning', 8000);
        return;
    }
    if (reason === 'exact-cross-chat-blocked') {
        setStatus(modal, 'Exact (replace) restore is blocked across different chats.', 'warning');
        return;
    }
    if (reason === 'confirmation-required') {
        setStatus(modal, 'Restore was not confirmed.', 'warning');
        return;
    }
    if (reason === 'knowledge-store-unavailable') {
        setStatus(modal, describePreviewFailure(result).message, 'error');
        return;
    }
    const detail = result.warning || result.error || reason || 'unknown error';
    setStatus(modal, `Restore did not complete: ${detail}`, 'error');
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

/**
 * Bind the Settings-tab Backup/Restore buttons. Called from the main modal's
 * render flow (the body is rebuilt on every open, so rebind each render).
 */
export function wireBackupEvents(modal) {
    state.modal = modal;
    const panel = modal?.querySelector('#mwt-backup-panel');
    if (!panel) return;
    panel.querySelector('#mwt-bk-export')?.addEventListener('click', () => { handleExport(); });
    panel.querySelector('#mwt-bk-restore')?.addEventListener('click', () => { handleRestorePick(); });
    panel.querySelector('#mwt-bk-undo')?.addEventListener('click', () => { handleUndo(); });
}
