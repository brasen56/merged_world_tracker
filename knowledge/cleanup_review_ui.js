/**
 * Phase 4: the reviewed single-NPC ledger-condensation UI
 * (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md §Phase 4).
 *
 * Two modals live here:
 *   1. The "Condense knowledge" review modal — disclosure/consent → a
 *      cancellable proposal request (up to two attempts) → source-aware review →
 *      two-step explicit Apply through the Phase 3 commit service → undo.
 *      It is deliberately separate from Enrich / Fields / staging: proposals
 *      never enter auto-approval or bulk acceptance, and nothing is written
 *      to the live entry before the user's explicit confirmed Apply.
 *   2. The cleanup-recovery manager — list / restore / export / import /
 *      delete for the durable pre-cleanup originals (D2), previously only
 *      reachable through the window.MWT.cleanupRecovery console surface.
 *
 * Every model- or user-derived string is escaped; every control is a real
 * labeled button/input; the shared modal lifecycle (focus trap, Escape,
 * focus restore, live-region status bar) comes from core/modal.js. Review
 * drafts persist across modal close and chat sweeps in the in-memory,
 * origin-bound draft store (knowledge/cleanup_review.js) — they are UI
 * state, never prompt context.
 */

import { escapeHtml, renderLineDiff, downloadJson, pickTextFile, isCancellation } from '../core/index.js';
import { decorateModalShell, setStatus, setModalOpener } from '../core/modal.js';
import { setControlBusy } from '../core/ui.js';
import { BACKUP_TYPE } from '../backup/data.js';
import { validateBackupEnvelope } from '../backup/validate.js';
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { ktSetStatus } from './state.js';
import { getLorebookName } from './scope.js';
import {
    prepareLedgerCleanup,
    estimateLedgerCleanup,
    cleanupModelDisclosure,
    requestLedgerProposal,
    saveCleanupDraft,
    getCleanupDraft,
    stashPreviousCleanupDraft,
    getPreviousCleanupDrafts,
    PREVIOUS_DRAFT_LIMIT,
    clearCleanupDraft,
    exportCleanupDraftPayload,
    applyReviewedLedgerCleanup,
    restoreReviewedLedgerCleanup,
    reconcileReviewedLedgerCleanup,
} from './cleanup_review.js';
import {
    parseLedger,
    editLedgerRecord,
    keepLedgerOriginals,
    removeLedgerSources,
    patchLedgerProposal,
    originalLedgerProposal,
} from './ledger_cleanup.js';
import {
    listCleanupRecovery,
    cleanupRecoveryUsage,
    exportCleanupRecovery,
    importCleanupRecovery,
    deleteCleanupRecords,
    CLEANUP_RECOVERY_EXPORT_TYPE,
} from './cleanup_recovery.js';

const REVIEW_MODAL_ID = 'kt-ledger-review-modal';
const RECOVERY_MODAL_ID = 'kt-cleanup-recovery-modal';

const CONFIG_SOURCE_LABELS = {
    'module-profile': 'the Knowledge module\'s connection profile',
    'module-custom': 'the Knowledge module\'s custom API settings',
    'global-profile': 'the global connection profile',
    'global-custom': 'the global custom API settings',
};

const APPLY_REFUSAL_MESSAGES = {
    'in-progress': 'This cleanup is already being applied.',
    'bad-request': 'The apply request was incomplete.',
    'scope-changed': 'The chat scope changed since the proposal was generated — the review was detached. Your draft is retained; reopen it in the originating chat.',
    'book-changed': 'The resolved Knowledge lorebook changed mid-operation. Your draft is retained.',
    'store-not-hydrated': 'The store is not hydrated — reload the chat and retry. Your draft is retained.',
    'destination-missing': 'The destination entry no longer exists. Your draft is retained — export it if you still need it.',
    'identity-mismatch': 'The destination entry now belongs to a different NPC (rename or merge?). Your draft is retained.',
    'entity-changed': 'The NPC was renamed or merged since the proposal was generated. Your draft is retained.',
    'stale-source': 'The entry changed after the proposal was generated (a background update or manual edit). Your edited draft is retained — export it, or regenerate against the new content.',
    'validation-failed': 'The final draft failed validation and was NOT applied',
    'destination-ambiguous': 'The NPC no longer resolves to exactly one entry — resolve duplicates first. Your draft is retained.',
    'recovery-persist-failed': 'The recovery original could not be saved, so the entry was NOT changed. Your draft is retained.',
    'recheck-failed': 'The destination changed during the save and nothing was written. Your draft is retained.',
    'source-changed-during-persist': 'The entry changed during the save and nothing was written. Your draft is retained.',
    'target-save-failed': 'Saving the entry failed — the recovery original was preserved and the entry was NOT changed. Your draft is retained.',
    'outcome-uncertain': 'The save outcome is uncertain. Retry this draft, or open Recovery records… and choose Reconcile (also available after reload). Your draft and recovery original are retained.',
};

const fmt = n => Number(n || 0).toLocaleString();
const attrSel = (attr, value) => `[${attr}="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"')}"]`;

function fileStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function safeFilePart(name) {
    return String(name || 'npc').replace(/[^\w-]+/g, '_').slice(0, 40);
}

/**
 * Two-click confirm for single-button destructive actions: the first click
 * arms the button with an explicit warning label, the second (within 4s)
 * executes. Re-renders naturally disarm.
 */
function armButton(btn, armedLabel, onConfirm) {
    if (btn.dataset.armed === 'true') {
        onConfirm();
        return;
    }
    btn.dataset.armed = 'true';
    const previous = btn.innerHTML;
    btn.innerHTML = armedLabel;
    btn.classList.add('kt-condense-armed');
    setTimeout(() => {
        if (btn.isConnected && btn.dataset.armed === 'true') {
            btn.dataset.armed = 'false';
            btn.innerHTML = previous;
            btn.classList.remove('kt-condense-armed');
        }
    }, 4000);
}

function applyRefusalMessage(result) {
    if (!result) return 'The apply failed.';
    // A confirmed-applied duplicate is turned into success upstream, so any
    // duplicate that reaches here is NOT proof the entry changed.
    if (result.code === 'duplicate') {
        return `This draft already has a recovery record${result.status ? ` (status: ${result.status})` : ''}, so nothing was written again. Open Recovery records… to check it. Your draft is retained.`;
    }
    const mapped = APPLY_REFUSAL_MESSAGES[result.code];
    if (mapped) return mapped.endsWith('.') || mapped.endsWith('?') ? mapped : `${mapped}.`;
    return `Apply refused (${result.code || 'unknown'}): ${result.error || 'no reason given'}.`;
}

/** Re-render the NPC list after a successful write; re-anchor focus restore. */
function refreshNpcList(modal, name) {
    import('./render.js')
        .then(({ renderNpcsSubTab }) => {
            renderNpcsSubTab();
            const replacement = document.querySelector(`.kt-npc-card${attrSel('data-name', name)} .kt-npc-condense`);
            if (replacement) setModalOpener(modal, replacement);
        })
        .catch(() => { /* the list refresh is cosmetic; the write already landed */ });
}

// ─── Review modal ────────────────────────────────────────────────────────────

let reviewOpening = false;

/**
 * Open the Condense review for one NPC. Capture refusals (missing/renamed/
 * ambiguous entry) surface as a Knowledge status error before any modal;
 * an ineligible ledger opens the modal in an explain-only state — nothing is
 * ever rewritten to make an entry eligible.
 */
export async function openLedgerCleanupReviewModal(name, uid) {
    if (document.getElementById(REVIEW_MODAL_ID) || reviewOpening) return;
    reviewOpening = true;
    try {
        const scope = captureScope();
        const prepared = await prepareLedgerCleanup({ name, uid });
        // A chat switch during the awaited load detaches everything — the
        // sweep closes any open modal, so just drop this open.
        if (!scopeStillCurrent(scope).ok) return;
        openReviewModalShell(name, prepared);
    } catch (err) {
        ktSetStatus(`Condense unavailable for "${name}": ${err.message}`, 'error');
    } finally {
        reviewOpening = false;
    }
}

function openReviewModalShell(name, { capture, eligibility }) {
    const modal = document.createElement('div');
    modal.id = REVIEW_MODAL_ID;
    modal.className = 'mwt-modal kt-condense-modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="mwt-modal-backdrop"></div>
        <div class="mwt-modal-panel">
            <div class="mwt-modal-header">
                <h3><span aria-hidden="true">🧹</span> Condense knowledge — ${escapeHtml(name)}</h3>
                <button class="mwt-modal-close" title="Close">&times;</button>
            </div>
            <div class="mwt-modal-body"><div class="kt-condense-content"></div></div>
            <div class="mwt-modal-statusbar">
                <span class="mwt-status" role="status" aria-live="polite" aria-atomic="true"></span>
            </div>
        </div>`;
    document.body.appendChild(modal);

    // Blocking close while a request is in flight keeps the cancel path the
    // only way out of "generating" — the controller belongs to this session.
    // A pending Apply/Undo blocks close too: it cannot be cancelled, and a
    // closed modal would hide its outcome (a reopened one could also lose
    // edits to the old Apply's draft clear). A scope change still detaches.
    decorateModalShell(modal, {
        title: `Condense knowledge — ${name}`,
        closeOnBackdrop: false,
        destroyOnClose: true,
        onClose: () => {
            if (!scopeStillCurrent(session.scope).ok) {
                session.controller?.abort();
                return true;
            }
            if (session.controller) {
                setStatus(modal, 'A request is in flight — cancel it before closing.', 'warning');
                return false;
            }
            if (session.saving) {
                setStatus(modal, `${session.saving} is still saving — wait for its result before closing.`, 'warning');
                return false;
            }
            return true;
        },
    });

    const session = {
        name,
        capture,
        eligibility,
        scope: capture.scopeToken,
        review: null,
        proposal: null,
        decisions: { removals: [] },
        controller: null,
        saving: null, // 'Apply' | 'Undo' while that write is pending
        keptOpen: false, // the "kept as written" group stays as the user left it across re-renders
        applied: null,
        restored: false,
        confirming: false,
    };
    const content = () => modal.querySelector('.kt-condense-content');

    if (!eligibility.ok || eligibility.empty) {
        renderExplain();
    } else {
        renderDisclose({ keepConsent: false });
    }

    // ── explain: ineligible ledger — explain, never rewrite ──
    function renderExplain() {
        const reason = eligibility.ok
            ? (eligibility.reason || 'The ledger is empty.')
            : eligibility.reason || 'The ledger could not be read safely.';
        content().innerHTML = `
            <div class="kt-condense-explain">
                <h4>This entry cannot be condensed</h4>
                <p class="kt-condense-explain-reason">${escapeHtml(reason)}</p>
                ${Array.isArray(eligibility.suspectLines) && eligibility.suspectLines.length
                    ? `<p class="kt-condense-explain-lines">Ambiguous lines: ${eligibility.suspectLines.map(l => escapeHtml(String(l))).join(', ')}</p>`
                    : ''}
                <p class="kt-condense-explain-note">Nothing was changed. Unsupported ledger shapes are refused rather than rewritten — fix the entry format by hand, or add ledger lines through normal tracking first.</p>
            </div>
            <div class="kt-condense-actions">
                <button class="mwt-btn kt-condense-recovery-open">Recovery records…</button>
                <span style="flex:1"></span>
                <button class="mwt-btn mwt-btn-primary kt-condense-close">Close</button>
            </div>`;
        content().querySelector('.kt-condense-close').addEventListener('click', () => modal._closeModal?.());
        content().querySelector('.kt-condense-recovery-open').addEventListener('click', () => { openCleanupRecoveryModal(); });
    }

    // ── disclose: consent panel, shown before ANY request ──
    function renderDisclose({ keepConsent }) {
        const model = cleanupModelDisclosure();
        const plan = estimateLedgerCleanup(capture);
        const estimate = plan?.estimate;
        const budget = plan?.budget || { ok: false, code: 'ineligible', reason: 'The ledger could not be read safely.', suggestion: '' };
        const draft = getCleanupDraft(capture);
        const draftResumable = !!draft && draft.review.original === capture.originalContent;
        const draftStale = !!draft && !draftResumable;
        const previous = getPreviousCleanupDrafts(capture);

        // Profile modes keep the model name inside the profile; the stable
        // `source` string (not `mode`, which the test stub reports uniformly)
        // is what both production and tests can agree on.
        const isProfile = /-profile$/.test(model.source);
        const modelLine = isProfile
            ? `connection profile <code>${escapeHtml(model.connectionProfileId || '(selected in Connection Manager)')}</code>`
            : `<code>${escapeHtml(model.modelName || '(no model name set)')}</code>`;
        const contextLine = estimate?.contextLimit?.value
            ? `${fmt(estimate.contextLimit.value)} tokens (${escapeHtml(estimate.contextLimit.source)})`
            : 'unknown on this build — not provider-verified';

        content().innerHTML = `
            <p class="kt-condense-hint">A reviewed model request proposes condensed ledger records, with up to two attempts. Nothing is written to the entry until you review the mapping and explicitly apply it — the exact original is saved to recovery first.</p>
            <dl class="kt-condense-disclosure">
                <dt>Model / profile</dt><dd>${modelLine} via ${CONFIG_SOURCE_LABELS[model.source] ? escapeHtml(CONFIG_SOURCE_LABELS[model.source]) : escapeHtml(model.source)}</dd>
                <dt>Data transmitted</dt><dd>Only this NPC's <strong>name</strong> and their <strong>${fmt(estimate?.sourceCount || 0)} Knowledge Ledger lines</strong> — no chat messages, no dossier fields, no recovery originals.</dd>
                <dt>Sizes (estimates)</dt><dd>Ledger ${fmt(estimate?.ledgerChars)} chars / ~${fmt(estimate?.ledgerTokens)} tokens · whole entry ${fmt(estimate?.entryChars)} chars / ~${fmt(estimate?.entryTokens)} tokens · request ~${fmt(estimate?.inputTokens)} tokens in</dd>
                <dt>Output allowance</dt><dd>${fmt(model.maxTokens)} tokens (Knowledge Max Tokens)</dd>
                <dt>Response size (estimates)</dt><dd>at least ~${fmt(estimate?.minimumOutputTokens)} tokens (every line kept verbatim) · ~${fmt(estimate?.rewriteAllOutputTokens)} if every line were rewritten — the real size depends on how much the model changes</dd>
                <dt>Context limit</dt><dd>${contextLine}</dd>
                <dt>Cost / privacy</dt><dd>Up to two billable requests per generation or regeneration: one initial attempt and one automatic retry after malformed output, validation failure, or a retryable request error. Each attempt sends the ledger text to the configured provider.</dd>
            </dl>
            ${budget.ok ? '' : `<div class="kt-condense-refusal" role="alert"><strong>Request refused before sending:</strong> ${escapeHtml(budget.reason)} <span class="kt-condense-suggestion">${escapeHtml(budget.suggestion || '')}</span></div>`}
            ${budget.ok && budget.warnings?.length ? `<ul class="kt-condense-warnings">${budget.warnings.map(w => `<li>⚠ ${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
            ${draftResumable ? `
                <div class="kt-condense-draft-offer">
                    <strong>A retained review draft exists for this NPC</strong> (saved ${escapeHtml(draft.savedAt)}), and the entry has not changed since. Requesting a new proposal instead keeps it below for export.
                    <div class="kt-condense-draft-actions">
                        <button class="mwt-btn kt-condense-resume">Resume previous draft</button>
                        <button class="mwt-btn kt-condense-draft-export" data-which="current">Export draft</button>
                    </div>
                </div>` : ''}
            ${draftStale ? `
                <div class="kt-condense-draft-offer kt-condense-draft-offer--stale">
                    <strong>A retained review draft exists, but the entry changed since it was generated.</strong> It cannot be resumed (its source mapping no longer matches); export remains available.
                    <div class="kt-condense-draft-actions">
                        <button class="mwt-btn kt-condense-draft-export" data-which="current">Export stale draft</button>
                    </div>
                </div>` : ''}
            ${previous.length ? `<p class="kt-condense-prev-draft">${previous.length === 1 ? 'A replaced draft was retained' : `${previous.length} replaced drafts were retained`} (the ${PREVIOUS_DRAFT_LIMIT} most recent stay exportable until reload) — ${previous.map((d, i) => `<button class="mwt-btn kt-condense-draft-export" data-which="previous" data-index="${i}">Export draft saved ${escapeHtml(d.savedAt)}</button>`).join(' ')}</p>` : ''}
            <div class="kt-condense-consent">
                <label for="kt-condense-consent">
                    <input type="checkbox" id="kt-condense-consent" class="kt-condense-consent-box" ${keepConsent ? 'checked' : ''} />
                    I understand this sends ${escapeHtml(name)}'s ledger lines to the configured model, and want one condensation proposal.
                </label>
            </div>
            <div class="kt-condense-actions">
                <button class="mwt-btn kt-condense-recovery-open">Recovery records…</button>
                <span style="flex:1"></span>
                <button class="mwt-btn mwt-btn-primary kt-condense-generate" ${budget.ok ? '' : 'disabled'} title="${budget.ok ? 'Request one condensation proposal from the configured model' : 'Request refused — see the refusal above'}">Request proposal</button>
            </div>`;
        wireCommonActions();

        const consentBox = content().querySelector('.kt-condense-consent-box');
        const generateBtn = content().querySelector('.kt-condense-generate');
        const updateGenerate = () => { generateBtn.disabled = !budget.ok || !consentBox.checked; };
        consentBox.addEventListener('change', updateGenerate);
        updateGenerate();
        generateBtn.addEventListener('click', () => runGeneration({ regenerate: false }));

        content().querySelectorAll('.kt-condense-draft-export').forEach(btn => btn.addEventListener('click', () => {
            const which = btn.dataset.which === 'previous' ? 'previous' : 'current';
            const entry = which === 'previous'
                ? getPreviousCleanupDrafts(capture)[Number(btn.dataset.index) || 0]
                : getCleanupDraft(capture);
            if (!entry) { setStatus(modal, 'No draft to export.', 'warning'); return; }
            try {
                downloadJson(`mwt-cleanup-draft-${safeFilePart(name)}-${fileStamp()}.json`, exportCleanupDraftPayload(entry));
                setStatus(modal, 'Draft exported.', 'success', 3000);
            } catch (err) {
                setStatus(modal, `Draft export failed: ${err.message}`, 'error');
            }
        }));
        content().querySelector('.kt-condense-resume')?.addEventListener('click', () => {
            const entry = getCleanupDraft(capture);
            if (!entry || entry.review.original !== capture.originalContent) {
                setStatus(modal, 'The draft can no longer be resumed — the entry changed.', 'warning');
                renderDisclose({ keepConsent: true });
                return;
            }
            session.review = entry.review;
            session.proposal = entry.proposal;
            session.decisions = entry.decisions || { removals: [] };
            setStatus(modal, 'Previous draft restored — review it again before applying.', 'info');
            renderReview();
        });
    }

    // ── generating: progress + cancel ──
    function renderGenerating(regenerate) {
        content().innerHTML = `
            <div class="kt-condense-generating" aria-busy="true">
                <p class="kt-condense-progress"><span aria-hidden="true">⏳</span> ${regenerate ? 'Requesting a fresh proposal' : 'Requesting one proposal'} from ${(() => { const d = cleanupModelDisclosure(); return /-profile$/.test(d.source) ? `connection profile ${escapeHtml(d.connectionProfileId || '')}`.trim() : escapeHtml(d.modelName || 'the configured model'); })()}…</p>
                <p class="kt-condense-progress-note">The ${fmt(session.review ? session.review.sources.length : eligibility.items?.length || 0)} ledger lines and the NPC name are the only data sent. The entry is not touched.</p>
            </div>
            <div class="kt-condense-actions">
                <span style="flex:1"></span>
                <button class="mwt-btn kt-condense-cancel-request">Cancel request</button>
            </div>`;
        content().querySelector('.kt-condense-cancel-request').addEventListener('click', () => {
            session.controller?.abort();
        });
    }

    async function runGeneration({ regenerate }) {
        if (session.controller) return;
        if (!scopeStillCurrent(session.scope).ok) { modal._closeModal?.(); return; }
        session.controller = new AbortController();
        renderGenerating(regenerate);
        try {
            if (regenerate) {
                const prepared = await prepareLedgerCleanup({ name: capture.name, uid: capture.uid });
                if (!scopeStillCurrent(session.scope).ok || !modal.isConnected) { modal._closeModal?.(); return; }
                const changed = prepared.capture.originalContent !== capture.originalContent
                    || prepared.capture.bookName !== capture.bookName
                    || prepared.capture.entityId !== capture.entityId;
                if (changed) {
                    // This is a new review, never a rebase of the user's edits.
                    // Retain the old draft for export and disclose the new source.
                    stashPreviousCleanupDraft(capture);
                    capture = prepared.capture;
                    eligibility = prepared.eligibility;
                    session.capture = capture;
                    session.eligibility = eligibility;
                    session.review = null;
                    session.proposal = null;
                    session.decisions = { removals: [] };
                    session.confirming = false;
                    if (!eligibility.ok || eligibility.empty) renderExplain();
                    else renderDisclose({ keepConsent: false });
                    setStatus(modal, 'The entry changed. Your previous draft is retained for export. Review the refreshed disclosure and consent to a new proposal; prior edits will not be rebased.', 'warning');
                    return;
                }
                if (session.controller.signal.aborted) {
                    const err = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    throw err;
                }
                capture = prepared.capture;
                session.capture = capture;
            }
            const result = await requestLedgerProposal({ capture, signal: session.controller.signal });
            if (!scopeStillCurrent(session.scope).ok || !modal.isConnected) { modal._closeModal?.(); return; }
            // Keep the active draft intact through cancellation/error. Only a
            // successfully generated replacement demotes it to export-only —
            // including a retained draft this session never resumed (a fresh
            // request from the disclosure must not overwrite it).
            stashPreviousCleanupDraft(capture);
            session.review = result.review;
            session.proposal = result.proposal;
            session.decisions = { removals: [] };
            saveCleanupDraft(capture, { review: session.review, proposal: session.proposal, decisions: session.decisions });
            session.confirming = false;
            renderReview();
            setStatus(modal, `Proposal ready: ${result.review.sources.length} sources → ${result.proposal.records.length} records. Nothing changes until you apply it.`, 'success');
        } catch (err) {
            if (!scopeStillCurrent(session.scope).ok || !modal.isConnected) { modal._closeModal?.(); return; }
            if (isCancellation(err)) {
                // Quiet discard; the modal stays usable. An in-session proposal
                // (regeneration cancelled) returns to review untouched.
                if (session.review) { renderReview(); } else { renderDisclose({ keepConsent: true }); }
                setStatus(modal, 'Request cancelled — nothing was sent to the entry.', 'info');
                return;
            }
            console.warn('[MWT:Knowledge] ledger cleanup request failed:', err?.message || err);
            if (session.review) {
                saveCleanupDraft(capture, { review: session.review, proposal: session.proposal, decisions: session.decisions });
                renderReview();
            } else {
                renderDisclose({ keepConsent: true });
            }
            setStatus(modal, `Proposal failed: ${err.message}`, 'error');
        } finally {
            session.controller = null;
        }
    }

    // ── review: the source-aware proposal editor ──
    function reviewModel() {
        const patch = session.review ? patchLedgerProposal(session.review, session.proposal, session.decisions) : { ok: false };
        const originalBody = parseLedger(session.review?.original || '');
        const proposedBody = patch.ok ? parseLedger(patch.replacement) : null;
        const removalCount = session.decisions.removals.length;
        return {
            patch,
            valid: !!patch.ok,
            changed: !!patch.ok && patch.replacement !== session.review.original,
            originalChars: originalBody.ok ? originalBody.body.length : 0,
            proposedChars: proposedBody?.ok ? proposedBody.body.length : 0,
            originalTokens: originalBody.ok ? Math.ceil(originalBody.body.length / 4.5) : 0,
            proposedTokens: proposedBody?.ok ? Math.ceil(proposedBody.body.length / 4.5) : 0,
            wholeOriginalChars: session.review.original.length,
            wholeProposedChars: patch.ok ? patch.replacement.length : session.review.original.length,
            removalCount,
            warnings: patch.ok ? patch.warnings : [],
        };
    }

    function renderReview(focusSelector = null, feedbackOnly = false) {
        if (!session.review) { renderDisclose({ keepConsent: true }); return; }
        const model = reviewModel();
        const byId = new Map(session.review.sources.map(s => [s.id, s]));
        const warningsFor = recordId => model.warnings.filter(w => w.recordId === recordId);
        const sourceLabel = id => `source ${String((byId.get(id)?.order ?? 0) + 1)}`;

        const renderSourceRow = (sourceId) => {
            const source = byId.get(sourceId);
            if (!source) return '';
            const removed = session.decisions.removals.some(r => r.sourceId === sourceId);
            return `
                <li class="kt-condense-source${removed ? ' kt-condense-source--removed' : ''}" data-source="${escapeHtml(sourceId)}">
                    <span class="kt-condense-source-id">${escapeHtml(sourceLabel(sourceId))}</span>
                    <code class="kt-condense-source-text">${escapeHtml(source.text)}</code>
                    ${removed ? '<span class="kt-condense-source-flag">removed by you</span>' : ''}
                    ${!removed ? `<button class="mwt-btn kt-condense-remove-src" data-source="${escapeHtml(sourceId)}">Remove…</button>` : ''}
                </li>`;
        };

        const lineNo = id => (byId.get(id)?.order ?? 0) + 1;
        const plainText = source => source.text.replace(/^\s*- /, '');
        // Same test the validator uses: one source, text identical to its line.
        const isKept = record => record.sourceIds.length === 1
            && byId.has(record.sourceIds[0]) && plainText(byId.get(record.sourceIds[0])) === record.text;
        const indexed = session.proposal.records.map((record, index) => ({ record, index }));
        const changed = indexed.filter(({ record }) => !isKept(record));
        const kept = indexed.filter(({ record }) => isKept(record));
        const changedLineCount = changed.reduce((sum, { record }) => sum + record.sourceIds.length, 0);

        // Live feedback: size change and warnings. Keyed by record id so a
        // blur-time refresh lands on the right card even if grouping moved.
        const recordFeedback = record => {
            if (isKept(record)) return '';
            const warns = warningsFor(record.id);
            const detailWarns = warns.filter(w => w.kind === 'detail-not-retained');
            const semantic = warns.filter(w => w.kind === 'semantic-review' || w.kind === 'legacy-intent');
            const before = record.sourceIds.reduce((sum, id) => sum + (byId.has(id) ? plainText(byId.get(id)).length : 0), 0);
            const after = record.text.length;
            const delta = before ? Math.round(((after - before) / before) * 100) : 0;
            return `
                    <p class="kt-condense-record-size">${fmt(before)} → ${fmt(after)} chars (${delta <= 0 ? `−${Math.abs(delta)}` : `+${delta}`}%)</p>
                    ${detailWarns.length ? `<ul class="kt-condense-record-warnings">${detailWarns.map(w => `<li>⚠ detail not retained: <code>${escapeHtml(w.detail)}</code></li>`).join('')}</ul>` : ''}
                    ${semantic.length ? `<ul class="kt-condense-record-warnings kt-condense-record-warnings--semantic">${semantic.map(w => `<li>⚠ ${escapeHtml(w.message)}</li>`).join('')}</ul>` : ''}`;
        };

        const changedCards = changed.map(({ record, index }, position) => {
            const what = record.sourceIds.length > 1
                ? `merges ${record.sourceIds.length} lines (${record.sourceIds.map(lineNo).join(', ')})`
                : `${record.text.length < plainText(byId.get(record.sourceIds[0]) || { text: '' }).length ? 'shortens' : 'rewrites'} line ${lineNo(record.sourceIds[0])}`;
            return `
                <article class="kt-condense-record" data-record="${escapeHtml(record.id)}">
                    <h4 class="kt-condense-record-title">Changed record ${position + 1} <span class="kt-condense-record-coverage">— ${escapeHtml(what)}</span></h4>
                    <label class="kt-condense-label" for="kt-condense-text-${index}">Condensed text (one line — editing keeps the source mapping)</label>
                    <textarea id="kt-condense-text-${index}" class="kt-condense-text" data-record="${escapeHtml(record.id)}" rows="2">${escapeHtml(record.text)}</textarea>
                    ${record.notes ? `<p class="kt-condense-record-notes">Merge note: ${escapeHtml(record.notes)}</p>` : ''}
                    <div class="kt-condense-record-feedback" data-record="${escapeHtml(record.id)}">${recordFeedback(record)}</div>
                    <details class="kt-condense-sources">
                        <summary>Originals (${record.sourceIds.length})</summary>
                        <ul class="kt-condense-source-list">${record.sourceIds.map(renderSourceRow).join('')}</ul>
                    </details>
                    <div class="kt-condense-record-actions">
                        <button class="mwt-btn kt-condense-keep" data-record="${escapeHtml(record.id)}" title="Discard this record's condensation and restore the exact original lines it covers">Keep originals instead</button>
                    </div>
                </article>`;
        }).join('');

        const keptCards = kept.map(({ record, index }) => {
            const sourceId = record.sourceIds[0];
            const removed = session.decisions.removals.some(r => r.sourceId === sourceId);
            return `
                <article class="kt-condense-record kt-condense-record--kept" data-record="${escapeHtml(record.id)}">
                    <label class="kt-condense-label" for="kt-condense-text-${index}">Line ${lineNo(sourceId)} — kept as written (edit it to change it)</label>
                    <textarea id="kt-condense-text-${index}" class="kt-condense-text" data-record="${escapeHtml(record.id)}" rows="2">${escapeHtml(record.text)}</textarea>
                    <div class="kt-condense-record-feedback" data-record="${escapeHtml(record.id)}"></div>
                    <div class="kt-condense-record-actions">
                        ${removed ? '' : `<button class="mwt-btn kt-condense-remove-src" data-source="${escapeHtml(sourceId)}">Remove…</button>`}
                    </div>
                </article>`;
        }).join('');

        const changedTitle = changed.length
            ? `Changed: ${fmt(changed.length)} record${changed.length !== 1 ? 's' : ''} covering ${fmt(changedLineCount)} line${changedLineCount !== 1 ? 's' : ''}`
            : 'Changed: none — every line is kept as written';
        const keptSummary = `Kept as written: ${fmt(kept.length)} line${kept.length !== 1 ? 's' : ''} (unchanged — open to edit or remove one)`;
        const recordSections = `
            <h4 class="kt-condense-section-title kt-condense-changed-title">${escapeHtml(changedTitle)}</h4>
            ${changedCards}
            <details class="kt-condense-kept"${session.keptOpen ? ' open' : ''}${kept.length ? '' : ' hidden'}>
                <summary class="kt-condense-kept-summary">${escapeHtml(keptSummary)}</summary>
                <div class="kt-condense-kept-list">${keptCards}</div>
            </details>`;

        const removalList = session.decisions.removals.length ? `
            <section class="kt-condense-removals">
                <h4>Your removals (${session.decisions.removals.length})</h4>
                <ul>${session.decisions.removals.map(r => `
                    <li><span class="kt-condense-source-id">${escapeHtml(sourceLabel(r.sourceId))}</span> — “${escapeHtml(r.reason)}”
                        <button class="mwt-btn kt-condense-removal-undo" data-source="${escapeHtml(r.sourceId)}">Undo (keep original)</button>
                    </li>`).join('')}</ul>
                <p class="kt-condense-removals-note">Removals are your explicit decisions with recorded reasons; the model can only suggest.</p>
            </section>` : '';

        const suggestions = session.proposal.pruningSuggestions.length ? `
            <section class="kt-condense-suggestions">
                <h4>Model pruning suggestions (advisory)</h4>
                <p class="kt-condense-suggestions-note">Nothing is removed unless YOU remove it above with an explicit reason. Suggestions must cite their matching source — verify the claim before acting.</p>
                <ul>${session.proposal.pruningSuggestions.map((s, i) => `
                    <li class="kt-condense-suggestion" data-suggestion="${i}">
                        <span class="kt-condense-suggestion-reason">${s.sourceIds.map(sourceLabel).map(escapeHtml).join(', ')}: ${escapeHtml(s.reason)}</span>
                        <details class="kt-condense-suggestion-sources"><summary>Cited sources</summary>
                            <ul class="kt-condense-source-list">${s.sourceIds.map(renderSourceRow).join('')}</ul>
                        </details>
                        <button class="mwt-btn kt-condense-suggest-remove" data-suggestion="${i}">Remove these sources…</button>
                    </li>`).join('')}</ul>
            </section>` : '';

        const diffBlock = `
            <details class="kt-condense-diff">
                <summary>Original / proposed ledger diff</summary>
                <div class="kt-condense-diff-body">${model.valid ? renderLineDiff(
            parseLedger(session.review.original).body || '',
            parseLedger(model.patch.replacement).body || '',
        ) : '<p class="kt-condense-diff-error">The current draft does not produce a valid patch.</p>'}</div>
            </details>`;

        const confirmBlock = session.confirming ? `
            <section class="kt-condense-confirm" role="alertdialog" aria-label="Apply confirmation">
                <h4>Apply this condensation?</h4>
                <ul>
                    <li>${fmt(session.review.sources.length)} ledger sources → <strong>${fmt(session.proposal.records.length)} records</strong> (${fmt(changed.length)} changed, ${fmt(kept.length)} kept as written)${model.removalCount ? `, ${model.removalCount} source${model.removalCount !== 1 ? 's' : ''} removed by you (reasons recorded)` : ''}.</li>
                    <li>Ledger ${fmt(model.originalChars)} → ${fmt(model.proposedChars)} chars · whole entry ${fmt(model.wholeOriginalChars)} → ${fmt(model.wholeProposedChars)} chars (token counts are estimates).</li>
                    <li>The exact original is saved to cleanup recovery <strong>before</strong> the entry is touched; restore is span-aware and preserves unrelated edits.</li>
                    <li>Every non-ledger byte of the entry stays identical.</li>
                </ul>
                ${model.warnings.length ? `<p class="kt-condense-confirm-warn">⚠ ${fmt(model.warnings.length)} advisory warning${model.warnings.length !== 1 ? 's' : ''} remain — review them above first.</p>` : ''}
                <div class="kt-condense-actions">
                    <button class="mwt-btn kt-condense-confirm-back">Back to review</button>
                    <span style="flex:1"></span>
                    <button class="mwt-btn mwt-btn-primary kt-condense-confirm-apply">Apply changes</button>
                </div>
            </section>` : '';

        const reviewHtml = `
            <div class="kt-condense-summary">
                <div class="kt-condense-counts"><strong>${fmt(session.review.sources.length)} sources → ${fmt(session.proposal.records.length)} records</strong> · ${fmt(changed.length)} changed, ${fmt(kept.length)} kept as written${model.removalCount ? ` (${fmt(model.removalCount)} removed by you)` : ''}</div>
                <div class="kt-condense-sizes">
                    Ledger ${fmt(model.originalChars)} → ${fmt(model.proposedChars)} chars (~${fmt(model.originalTokens)} → ~${fmt(model.proposedTokens)} tokens est.) · whole entry ${fmt(model.wholeOriginalChars)} → ${fmt(model.wholeProposedChars)} chars
                    <span class="kt-condense-est-note">token counts are estimates, not measurements</span>
                </div>
                ${model.warnings.length ? `<div class="kt-condense-summary-warnings">⚠ ${fmt(model.warnings.length)} advisory warning${model.warnings.length !== 1 ? 's' : ''} — see the changed records below</div>` : ''}
                ${model.valid && !model.changed ? '<div class="kt-condense-summary-warnings">The current decisions reproduce the original ledger exactly — there is nothing to apply.</div>' : ''}
                ${!model.valid ? `<div class="kt-condense-summary-warnings kt-condense-summary-warnings--error">The current draft does not validate: ${escapeHtml(model.patch.reason || 'unknown reason')}</div>` : ''}
            </div>
            ${session.proposal.notes ? `<p class="kt-condense-model-notes">Model notes: ${escapeHtml(session.proposal.notes)}</p>` : ''}
            ${diffBlock}
            <div class="kt-condense-records">${recordSections}</div>
            ${removalList}
            ${suggestions}
            ${confirmBlock}
            <div class="kt-condense-actions kt-condense-footer">
                <button class="mwt-btn kt-condense-restore-all" title="Discard the proposed condensation and map every source to its exact original line">Restore all originals</button>
                <button class="mwt-btn kt-condense-regenerate" title="Request a fresh proposal (new review id); your current draft is retained for export">Regenerate</button>
                <button class="mwt-btn kt-condense-draft-export-review">Export draft</button>
                <button class="mwt-btn kt-condense-recovery-open">Recovery records…</button>
                <span style="flex:1"></span>
                ${session.confirming
            ? ''
            : `<button class="mwt-btn mwt-btn-primary kt-condense-apply" ${model.valid && model.changed ? '' : 'disabled'} title="${model.valid && model.changed ? 'Review the final summary, then apply through the guarded commit' : 'Apply needs a valid draft that changes the ledger'}">Apply…</button>`}
            </div>`;
        if (feedbackOnly) {
            // A textarea change fires during blur: never disconnect its next
            // keyboard or pointer target. Refresh only non-interactive feedback.
            const template = document.createElement('template');
            template.innerHTML = reviewHtml;
            for (const selector of ['.kt-condense-summary', '.kt-condense-diff-body', '.kt-condense-changed-title', '.kt-condense-kept-summary']) {
                const update = template.content.querySelector(selector);
                const node = content().querySelector(selector);
                if (update && node) node.innerHTML = update.innerHTML;
            }
            // Per-record feedback by record id: an edit can move a record
            // between the changed and kept groups in the fresh markup, so a
            // positional match would paste one card's warnings onto another.
            content().querySelectorAll('.kt-condense-record-feedback').forEach(node => {
                const update = template.content.querySelector(`.kt-condense-record-feedback${attrSel('data-record', node.dataset.record)}`);
                node.innerHTML = update ? update.innerHTML : '';
            });
            content().querySelector('.kt-condense-confirm')?.remove();
            let applyBtn = content().querySelector('.kt-condense-apply');
            if (!applyBtn) {
                applyBtn = template.content.querySelector('.kt-condense-apply');
                content().querySelector('.kt-condense-footer').append(applyBtn);
                wireApplyButton(applyBtn);
            }
            applyBtn.disabled = !model.valid || !model.changed;
            applyBtn.title = model.valid && model.changed
                ? 'Review the final summary, then apply through the guarded commit'
                : 'Apply needs a valid draft that changes the ledger';
            return;
        }
        content().innerHTML = reviewHtml;
        wireCommonActions();
        wireReviewEvents();
        if (focusSelector) {
            const target = content().querySelector(focusSelector);
            // A focus target inside the collapsed kept group (e.g. after
            // "Keep originals") opens it, so focus never lands on a hidden control.
            const collapsed = target?.closest('details.kt-condense-kept:not([open])');
            if (collapsed) { collapsed.open = true; session.keptOpen = true; }
            target?.focus();
            if (target?.setSelectionRange && typeof target.value === 'string') {
                try { target.setSelectionRange(target.value.length, target.value.length); } catch { /* non-text inputs */ }
            }
        }
    }

    /**
     * Selector for a control of the record that now owns `sourceId` — its
     * edit box, or its "Keep originals" button. Decisions re-render the whole
     * review, so focus is re-anchored by source, not by the removed node.
     */
    function recordControlFor(sourceId, control = 'text') {
        const index = session.proposal.records.findIndex(r => r.sourceIds.includes(sourceId));
        if (index < 0) return null;
        return control === 'keep'
            ? `.kt-condense-keep${attrSel('data-record', session.proposal.records[index].id)}`
            : `#kt-condense-text-${index}`;
    }

    /** The one open inline removal control at a time. */
    function openRemovalBox(anchor, sourceIds, prefilledReason, confirmLabel, returnFocus = null) {
        if (!anchor) return;
        content().querySelector('.kt-condense-remove-box')?.remove();
        const box = document.createElement('div');
        box.className = 'kt-condense-remove-box';
        const inputId = `kt-condense-reason-${Date.now() % 100000}`;
        box.innerHTML = `
            <label class="kt-condense-label" for="${inputId}">Reason for removing ${sourceIds.length === 1 ? 'this source' : `these ${sourceIds.length} sources`} (required — recorded with the review)</label>
            <div class="kt-condense-remove-row">
                <input type="text" id="${inputId}" class="mwt-input kt-condense-reason-input" value="${escapeHtml(prefilledReason || '')}" />
                <button class="mwt-btn kt-condense-remove-confirm">${escapeHtml(confirmLabel || 'Remove')}</button>
                <button class="mwt-btn kt-condense-remove-cancel">Cancel</button>
            </div>`;
        anchor.after(box);
        box.querySelector('.kt-condense-reason-input').focus();
        box.querySelector('.kt-condense-remove-cancel').addEventListener('click', () => {
            box.remove();
            if (returnFocus?.isConnected) returnFocus.focus();
        });
        box.querySelector('.kt-condense-remove-confirm').addEventListener('click', () => {
            const reason = box.querySelector('.kt-condense-reason-input').value.trim();
            if (!reason) {
                setStatus(modal, 'An explicit reason is required to remove a source — absence is not consent.', 'warning');
                box.querySelector('.kt-condense-reason-input').focus();
                return;
            }
            // Success lands on the new removal's Undo; a refusal (part of a
            // merged record) lands on that record's "Keep originals" fix.
            applyDecision(() => removeLedgerSources(session.review, session.proposal, sourceIds, reason, session.decisions),
                `Removed ${sourceIds.length === 1 ? 'source' : `${sourceIds.length} sources`} with a recorded reason. Coverage recomputed.`,
                ok => (ok ? `.kt-condense-removal-undo${attrSel('data-source', sourceIds[0])}` : recordControlFor(sourceIds[0], 'keep')));
        });
    }

    /**
     * Run a Phase 2 decision, persist the draft, and re-render. `focusSelector`
     * may be a function of the outcome (true = applied) so focus lands on a
     * control that exists after the re-render instead of falling to <body>.
     */
    function applyDecision(fn, successMessage, focusSelector = null, feedbackOnly = false) {
        const focusFor = ok => (typeof focusSelector === 'function' ? focusSelector(ok) : focusSelector);
        try {
            const outcome = fn();
            session.proposal = outcome.proposal ?? session.proposal;
            session.decisions = outcome.decisions ?? session.decisions;
            session.confirming = false;
            saveCleanupDraft(capture, { review: session.review, proposal: session.proposal, decisions: session.decisions });
            renderReview(focusFor(true), feedbackOnly);
            if (successMessage) setStatus(modal, successMessage, 'success', 4000);
        } catch (err) {
            setStatus(modal, err.message, 'error');
            if (feedbackOnly) {
                // A rejected edit must not remain visible as though it were
                // accepted: restore the retained value without replacing nodes.
                content().querySelectorAll('.kt-condense-text').forEach(area => {
                    const record = session.proposal.records.find(r => r.id === area.dataset.record);
                    if (record) area.value = record.text;
                });
            }
            renderReview(focusFor(false), feedbackOnly);
        }
    }

    function wireReviewEvents() {
        // Commit on blur without replacing controls or redirecting focus.
        content().querySelectorAll('.kt-condense-text').forEach(area => {
            area.addEventListener('change', () => {
                const recordId = area.dataset.record;
                const text = area.value.replace(/\s*\r?\n\s*/g, ' ').trim();
                if (text !== area.value) area.value = text;
                applyDecision(
                    () => ({ proposal: editLedgerRecord(session.review, session.proposal, recordId, text, session.decisions), decisions: session.decisions }),
                    'Record text updated — source mapping kept.',
                    null, true,
                );
            });
        });

        content().querySelectorAll('.kt-condense-keep').forEach(btn => {
            btn.addEventListener('click', () => {
                const recordId = btn.dataset.record;
                const record = session.proposal.records.find(r => r.id === recordId);
                if (!record) return;
                applyDecision(
                    () => keepLedgerOriginals(session.review, session.proposal, [...record.sourceIds], session.decisions),
                    `Originals restored for all ${record.sourceIds.length} source${record.sourceIds.length !== 1 ? 's' : ''} of this record.`,
                    () => recordControlFor(record.sourceIds[0]),
                );
            });
        });

        content().querySelectorAll('.kt-condense-remove-src').forEach(btn => {
            btn.addEventListener('click', () => {
                const sourceId = btn.dataset.source;
                // Changed cards list sources; a kept line's card is its own anchor.
                openRemovalBox(btn.closest('.kt-condense-source') || btn.closest('.kt-condense-record'), [sourceId], '', 'Remove source', btn);
            });
        });

        content().querySelector('.kt-condense-kept')?.addEventListener('toggle', event => {
            session.keptOpen = event.currentTarget.open;
        });

        content().querySelectorAll('.kt-condense-suggest-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const suggestion = session.proposal.pruningSuggestions[Number(btn.dataset.suggestion)];
                if (!suggestion) return;
                // The model's reason only PREFILLS the control — the removal is
                // still an explicit user decision with a user-confirmed reason.
                openRemovalBox(btn.closest('.kt-condense-suggestion'), [...suggestion.sourceIds], suggestion.reason, 'Remove sources', btn);
            });
        });

        content().querySelectorAll('.kt-condense-removal-undo').forEach(btn => {
            btn.addEventListener('click', () => {
                const sourceId = btn.dataset.source;
                applyDecision(
                    () => keepLedgerOriginals(session.review, session.proposal, [sourceId], session.decisions),
                    'Removal undone — the exact original is represented again.',
                    () => recordControlFor(sourceId),
                );
            });
        });

        content().querySelector('.kt-condense-restore-all')?.addEventListener('click', (event) => {
            armButton(event.currentTarget, '⚠ Sure? Click again — this discards ALL proposed condensation', () => {
                session.proposal = originalLedgerProposal(session.review);
                session.decisions = { removals: [] };
                session.confirming = false;
                saveCleanupDraft(capture, { review: session.review, proposal: session.proposal, decisions: session.decisions });
                renderReview('.kt-condense-restore-all');
                setStatus(modal, 'Every source now maps to its exact original line — nothing to apply.', 'info');
            });
        });

        content().querySelector('.kt-condense-regenerate')?.addEventListener('click', () => runGeneration({ regenerate: true }));

        content().querySelector('.kt-condense-draft-export-review')?.addEventListener('click', () => {
            try {
                downloadJson(`mwt-cleanup-draft-${safeFilePart(name)}-${fileStamp()}.json`,
                    exportCleanupDraftPayload({ name, uid: capture.uid, bookName: capture.bookName, review: session.review, proposal: session.proposal, decisions: session.decisions }));
                setStatus(modal, 'Draft exported.', 'success', 3000);
            } catch (err) {
                setStatus(modal, `Draft export failed: ${err.message}`, 'error');
            }
        });

        wireApplyButton(content().querySelector('.kt-condense-apply'));

        content().querySelector('.kt-condense-confirm-back')?.addEventListener('click', () => {
            session.confirming = false;
            renderReview('.kt-condense-apply');
        });

        wireConfirmApply();
    }

    function wireApplyButton(applyBtn) {
        applyBtn?.addEventListener('click', () => {
            if (applyBtn.disabled) return;
            const check = reviewModel();
            if (!check.valid || !check.changed) {
                setStatus(modal, 'The draft must validate and actually change the ledger before Apply.', 'warning');
                renderReview();
                return;
            }
            session.confirming = true;
            renderReview('.kt-condense-confirm h4');
        });

    }

    function wireConfirmApply() {
        content().querySelector('.kt-condense-confirm-apply')?.addEventListener('click', async (event) => {
            const btn = event.currentTarget;
            if (btn.disabled) return;
            setControlBusy(btn, true); btn.textContent = '⏳ Applying…';
            // Freeze the submitted draft, including editors, removals, regeneration,
            // and Back. Failure renders fresh enabled controls with the draft intact.
            const pendingControls = document.createElement('fieldset');
            pendingControls.disabled = true;
            pendingControls.style.cssText = 'border:0;margin:0;padding:0;min-width:0';
            pendingControls.append(...content().childNodes);
            content().append(pendingControls);
            session.saving = 'Apply';
            setStatus(modal, 'Saving the recovery original and applying the reviewed condensation…', 'info');
            // After a refusal the confirm step is still open: land on its
            // non-destructive Back button, never on a retry the Enter key repeats.
            const refusalFocus = () => (session.confirming ? '.kt-condense-confirm-back' : '.kt-condense-apply');
            try {
                const result = await applyReviewedLedgerCleanup({
                    capture,
                    review: session.review,
                    proposal: session.proposal,
                    decisions: session.decisions,
                });
                if (!scopeStillCurrent(session.scope).ok) { modal._closeModal?.(); return; }
                if (result?.ok) {
                    clearCleanupDraft(capture);
                    session.applied = result;
                    session.confirming = false;
                    renderApplied();
                    content().querySelector('.kt-condense-close')?.focus();
                    setStatus(modal, `Applied: ${session.review.sources.length} sources → ${session.proposal.records.length} records. Recovery record saved — you can undo from here.`, 'success');
                    refreshNpcList(modal, name);
                    return;
                }
                console.warn('[MWT:Knowledge] ledger cleanup apply refused:', result?.code, result?.error);
                renderReview(refusalFocus());
                setStatus(modal, applyRefusalMessage(result), 'error');
            } catch (err) {
                if (!scopeStillCurrent(session.scope).ok || !modal.isConnected) { modal._closeModal?.(); return; }
                renderReview(refusalFocus());
                setStatus(modal, `Apply failed unexpectedly: ${err.message}`, 'error');
            } finally {
                session.saving = null;
                if (btn.isConnected) { setControlBusy(btn, false); btn.textContent = 'Apply changes'; }
            }
        });
    }

    // ── applied: post-apply summary + undo ──
    function renderApplied() {
        const actionId = session.applied?.actionId || '';
        content().innerHTML = `
            <div class="kt-condense-applied">
                <h4>✅ Condensation applied</h4>
                <p>${fmt(session.review.sources.length)} ledger sources → <strong>${fmt(session.proposal.records.length)} records</strong>. The exact pre-cleanup original was saved to cleanup recovery before the write${actionId ? ` (<code>${escapeHtml(actionId)}</code>)` : ''}.</p>
                <p class="kt-condense-applied-note">Only the ledger body changed — every other byte of the entry is identical. Restore puts the original ledger back and keeps unrelated edits made since.</p>
            </div>
            <div class="kt-condense-actions">
                <button class="mwt-btn kt-condense-undo">Undo — restore the original ledger</button>
                <button class="mwt-btn kt-condense-recovery-open">Recovery records…</button>
                <span style="flex:1"></span>
                <button class="mwt-btn mwt-btn-primary kt-condense-close">Close</button>
            </div>`;
        wireCommonActions();
        content().querySelector('.kt-condense-close').addEventListener('click', () => modal._closeModal?.());
        content().querySelector('.kt-condense-undo').addEventListener('click', async (event) => {
            const btn = event.currentTarget;
            if (btn.disabled || session.restored) return;
            setControlBusy(btn, true); btn.textContent = '⏳ Restoring…';
            session.saving = 'Undo';
            setStatus(modal, 'Restoring the original ledger span…', 'info');
            try {
                const result = await restoreReviewedLedgerCleanup(actionId);
                if (!scopeStillCurrent(session.scope).ok || !modal.isConnected) { modal._closeModal?.(); return; }
                if (result?.ok) {
                    setStatus(modal, 'Original ledger restored (span-aware — unrelated edits were preserved).', 'success');
                    renderAppliedRestored();
                    refreshNpcList(modal, name);
                    return;
                }
                if (result?.code === 'not-applied' && result.status === 'restored') {
                    // Restored elsewhere (e.g. Recovery records…) since this view rendered.
                    setStatus(modal, 'This cleanup was already restored — the original ledger is back in place. Nothing was written.', 'info');
                    renderAppliedRestored();
                    return;
                }
                setStatus(modal, result?.conflict
                    ? `Restore refused: ${result.error} Export the recovery record to reconcile manually.`
                    : `Restore refused: ${result.error || result.code}`, 'error');
                if (result?.conflict) offerConflictExport(result.conflict);
            } catch (err) {
                if (!scopeStillCurrent(session.scope).ok || !modal.isConnected) { modal._closeModal?.(); return; }
                setStatus(modal, `Restore failed: ${err.message}`, 'error');
            } finally {
                session.saving = null;
                if (btn.isConnected) { setControlBusy(btn, false); btn.innerHTML = 'Undo — restore the original ledger'; }
            }
        });
    }

    /** The undo is spent: retire its button so it cannot be re-run. */
    function renderAppliedRestored() {
        session.restored = true;
        content().querySelector('.kt-condense-undo')?.remove();
        if (!content().querySelector('.kt-condense-restored-note')) {
            const note = document.createElement('p');
            note.className = 'kt-condense-restored-note';
            note.textContent = '↩ The original ledger was put back; a restore-safeguard recovery record captured the condensed text first.';
            content().querySelector('.kt-condense-applied')?.append(note);
        }
        content().querySelector('.kt-condense-close')?.focus();
    }

    function offerConflictExport(conflict) {
        if (!conflict?.exportable || content().querySelector('.kt-condense-conflict-export')) return;
        const box = document.createElement('div');
        box.className = 'kt-condense-conflict-export';
        box.innerHTML = `<button class="mwt-btn kt-condense-conflict-export-btn">Export recovery record for manual reconciliation</button>`;
        box.querySelector('button').addEventListener('click', async () => {
            try {
                const payload = await exportCleanupRecovery([conflict.actionId]);
                downloadJson(`mwt-cleanup-recovery-${safeFilePart(name)}-${fileStamp()}.json`, payload);
                setStatus(modal, 'Recovery record exported.', 'success', 3000);
            } catch (err) {
                setStatus(modal, `Recovery export failed: ${err.message}`, 'error');
            }
        });
        content().querySelector('.kt-condense-actions')?.before(box);
    }

    function wireCommonActions() {
        content().querySelectorAll('.kt-condense-recovery-open').forEach(btn => {
            btn.addEventListener('click', () => { openCleanupRecoveryModal(); });
        });
    }
}

// ─── Recovery manager modal ──────────────────────────────────────────────────

let recoveryOpening = false;

/**
 * The reviewed recovery surface (D2/Phase 3 leftovers): list, usage, restore,
 * export, import, and explicit deletion of durable cleanup originals. Kept
 * reachable from every review-modal state — recovery must not live only in a
 * console command.
 */
export async function openCleanupRecoveryModal() {
    if (document.getElementById(RECOVERY_MODAL_ID) || recoveryOpening) return;
    recoveryOpening = true;
    const modal = document.createElement('div');
    modal.id = RECOVERY_MODAL_ID;
    modal.className = 'mwt-modal kt-cleanup-recovery-modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="mwt-modal-backdrop"></div>
        <div class="mwt-modal-panel">
            <div class="mwt-modal-header">
                <h3><span aria-hidden="true">🗄️</span> Cleanup recovery records</h3>
                <button class="mwt-modal-close" title="Close">&times;</button>
            </div>
            <div class="mwt-modal-body"><div class="kt-cleanup-recovery-content"></div></div>
            <div class="mwt-modal-statusbar">
                <span class="mwt-status" role="status" aria-live="polite" aria-atomic="true"></span>
            </div>
        </div>`;
    document.body.appendChild(modal);
    decorateModalShell(modal, { title: 'Cleanup recovery records', destroyOnClose: true });
    const content = () => modal.querySelector('.kt-cleanup-recovery-content');

    try {
        const scope = captureScope();
        const bookName = getLorebookName();
        await refreshList();
        // A scope switch while listing detaches the manager — its restore path
        // is scope-bound, so close instead of showing another scope's records.
        if (!scopeStillCurrent(scope).ok) { modal._closeModal?.(); return; }

        async function refreshList() {
            setStatus(modal, 'Loading recovery records…', 'info');
            const list = await listCleanupRecovery();
            if (!list.ok) {
                content().innerHTML = `
                    <div class="kt-condense-explain">
                        <h4>The recovery container cannot be read safely</h4>
                        <p class="kt-condense-explain-reason">${escapeHtml(list.reason || 'unknown reason')}</p>
                        <p class="kt-condense-explain-note">Records are preserved on disk and never dropped — resolve the container issue (or import a known-good export) before retrying.</p>
                    </div>
                    <div class="kt-condense-actions"><span style="flex:1"></span><button class="mwt-btn mwt-btn-primary kt-crec-close">Close</button></div>`;
                content().querySelector('.kt-crec-close').addEventListener('click', () => modal._closeModal?.());
                setStatus(modal, 'Recovery container unreadable — refusing to act on it.', 'error');
                return;
            }
            const usage = await cleanupRecoveryUsage();
            const records = list.records || [];
            const rows = records.map(r => `
                <tr class="kt-crec-row" data-action="${escapeHtml(r.actionId)}">
                    <td>${escapeHtml(r.entityName || '?')}</td>
                    <td>${escapeHtml(r.actionType || '')}</td>
                    <td><span class="kt-crec-status kt-crec-status--${escapeHtml(String(r.status || '').replace(/[^a-z-]/g, ''))}">${escapeHtml(r.status || '')}</span></td>
                    <td>${escapeHtml(String(r.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
                    <td>~${fmt(r.estimatedTokens)}</td>
                    <td class="kt-crec-actions">
                        ${r.status === 'applied' && r.actionType === 'ledger-condensation'
                ? `<button class="mwt-btn kt-crec-restore" data-action="${escapeHtml(r.actionId)}">Restore</button>`
                : ''}
                        ${['application-pending', 'outcome-uncertain'].includes(r.status) && r.actionType === 'ledger-condensation'
                ? `<button class="mwt-btn kt-crec-reconcile" data-action="${escapeHtml(r.actionId)}">Reconcile</button>`
                : ''}
                        <button class="mwt-btn kt-crec-export" data-action="${escapeHtml(r.actionId)}">Export</button>
                        <button class="mwt-btn kt-crec-delete" data-action="${escapeHtml(r.actionId)}">Delete…</button>
                    </td>
                </tr>`).join('');
            content().innerHTML = `
                <p class="kt-condense-hint">Durable originals saved before every applied cleanup. Retention is manual: nothing is evicted by age or count, and deletion is permanent — after it, that condensation can no longer be restored.</p>
                <p class="kt-crec-usage">${fmt(usage.count)} record${usage.count !== 1 ? 's' : ''} · ~${fmt(usage.estimatedTokens)} tokens (est.) stored in this book's recovery container.</p>
                ${list.issues?.length ? `<div class="kt-condense-warnings"><ul>${list.issues.map(i => `<li>⚠ unreadable record ${escapeHtml(i.actionId || '?')} (${escapeHtml(i.reason || '?')}) — preserved on disk, never dropped</li>`).join('')}</ul></div>` : ''}
                ${records.length ? `
                    <table class="kt-crec-table">
                        <thead><tr><th scope="col">NPC</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Saved</th><th scope="col">Size</th><th scope="col">Actions</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>` : '<p class="kt-crec-empty">No recovery records yet — they appear here after you apply a condensation.</p>'}
                <div class="kt-condense-actions">
                    <button class="mwt-btn kt-crec-import">Import from file…</button>
                    <button class="mwt-btn kt-crec-export-all" ${records.length ? '' : 'disabled'}>Export all</button>
                    <button class="mwt-btn kt-crec-refresh">Refresh</button>
                    <span style="flex:1"></span>
                    <button class="mwt-btn mwt-btn-primary kt-crec-close">Close</button>
                </div>`;
            setStatus(modal, `${fmt(records.length)} recovery record${records.length !== 1 ? 's' : ''} loaded.`, 'info', 2500);
            wireList();
        }

        function wireList() {
            content().querySelector('.kt-crec-close').addEventListener('click', () => modal._closeModal?.());
            content().querySelector('.kt-crec-refresh').addEventListener('click', () => refreshList().catch(err => setStatus(modal, `Refresh failed: ${err.message}`, 'error')));
            content().querySelector('.kt-crec-export-all')?.addEventListener('click', async () => {
                try {
                    downloadJson(`mwt-cleanup-recovery-${fileStamp()}.json`, await exportCleanupRecovery());
                    setStatus(modal, 'Recovery export downloaded.', 'success', 3000);
                } catch (err) { setStatus(modal, `Export failed: ${err.message}`, 'error'); }
            });
            content().querySelector('.kt-crec-import').addEventListener('click', async () => {
                let text;
                try { text = await pickTextFile('application/json,.json'); }
                catch (err) { setStatus(modal, `Import failed: ${err.message}`, 'error'); return; }
                if (!scopeStillCurrent(scope).ok || !modal.isConnected) { modal._closeModal?.(); return; }
                if (!text) return;
                try {
                    let payload = JSON.parse(text);
                    if (payload?._meta?.type === BACKUP_TYPE) {
                        const validated = validateBackupEnvelope(payload);
                        if (!validated.ok || !validated.cleanupRecovery) throw new Error('Backup has no readable cleanup recovery container.');
                        payload = { type: CLEANUP_RECOVERY_EXPORT_TYPE, ...validated.cleanupRecovery };
                    }
                    const result = await importCleanupRecovery(payload, { bookName, scopeToken: scope });
                    if (!scopeStillCurrent(scope).ok || !modal.isConnected) { modal._closeModal?.(); return; }
                    setStatus(modal, `Import: ${result.added.length} added, ${result.kept.length} kept (current wins), ${result.rejected.length} rejected.`, result.rejected.length ? 'warning' : 'success');
                    await refreshList();
                } catch (err) {
                    setStatus(modal, `Import refused: ${err.message}`, 'error');
                }
            });
            content().querySelectorAll('.kt-crec-export').forEach(btn => btn.addEventListener('click', async () => {
                try {
                    downloadJson(`mwt-cleanup-recovery-${btn.dataset.action}-${fileStamp()}.json`, await exportCleanupRecovery([btn.dataset.action]));
                    setStatus(modal, 'Record exported.', 'success', 3000);
                } catch (err) { setStatus(modal, `Export failed: ${err.message}`, 'error'); }
            }));
            content().querySelectorAll('.kt-crec-delete').forEach(btn => btn.addEventListener('click', (event) => {
                armButton(event.currentTarget, '⚠ Delete forever', async () => {
                    try {
                        const result = await deleteCleanupRecords([btn.dataset.action]);
                        setStatus(modal, result.deleted.length ? 'Record deleted — that cleanup can no longer be restored.' : 'Record not found (already deleted?).', result.deleted.length ? 'success' : 'warning');
                        await refreshList();
                    } catch (err) { setStatus(modal, `Delete failed: ${err.message}`, 'error'); }
                });
            }));
            content().querySelectorAll('.kt-crec-reconcile').forEach(btn => btn.addEventListener('click', async () => {
                setControlBusy(btn, true);
                try {
                    const result = await reconcileReviewedLedgerCleanup(btn.dataset.action);
                    if (!scopeStillCurrent(scope).ok || !modal.isConnected) { modal._closeModal?.(); return; }
                    await refreshList();
                    const message = result.status === 'applied'
                        ? 'Cleanup confirmed applied. Restore is now available.'
                        : result.status === 'failed'
                            ? 'The replacement did not land; the original is unchanged. The recovery record is retained.'
                            : `Reconciliation unresolved (${result.status}): ${result.detail || 'Export the record for manual recovery; no entry was changed.'}`;
                    setStatus(modal, message, ['applied', 'failed'].includes(result.status) ? 'success' : 'warning');
                } catch (err) {
                    setStatus(modal, `Reconciliation failed: ${err.message}. Keep or export the recovery record and retry.`, 'error');
                } finally {
                    if (btn.isConnected) setControlBusy(btn, false);
                }
            }));
            content().querySelectorAll('.kt-crec-restore').forEach(btn => btn.addEventListener('click', async (event) => {
                const restoreBtn = event.currentTarget;
                setControlBusy(restoreBtn, true); restoreBtn.textContent = '⏳…';
                setStatus(modal, 'Restoring the original ledger span…', 'info');
                try {
                    const result = await restoreReviewedLedgerCleanup(btn.dataset.action);
                    if (result?.ok) {
                        await refreshList();
                        setStatus(modal, `Original restored for this record${result.reconciled ? ' (reconciled from an uncertain outcome)' : ''}. Unrelated edits were preserved.`, 'success');
                        return;
                    }
                    setStatus(modal, result?.conflict
                        ? `Restore refused: ${result.error} Export the record to reconcile manually.`
                        : `Restore refused: ${result.error || result.code}`, 'error');
                } catch (err) {
                    setStatus(modal, `Restore failed: ${err.message}`, 'error');
                } finally {
                    if (restoreBtn.isConnected) { setControlBusy(restoreBtn, false); restoreBtn.textContent = 'Restore'; }
                }
            }));
        }
    } catch (err) {
        content().innerHTML = `<div class="kt-condense-explain"><h4>Recovery listing failed</h4><p class="kt-condense-explain-reason">${escapeHtml(err.message)}</p></div>
            <div class="kt-condense-actions"><span style="flex:1"></span><button class="mwt-btn mwt-btn-primary kt-crec-close">Close</button></div>`;
        content().querySelector('.kt-crec-close').addEventListener('click', () => modal._closeModal?.());
        setStatus(modal, `Recovery listing failed: ${err.message}`, 'error');
    } finally {
        recoveryOpening = false;
    }
}
