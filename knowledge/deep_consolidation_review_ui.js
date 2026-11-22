/** v2: setup → editable groups → resumable batches → Condense review. */
import { escapeHtml, downloadJson, isCancellation } from '../core/index.js';
import { createModal, showModal, setModalOpener, setStatus } from '../core/modal.js';
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { ktSetStatus } from './state.js';
import { prepareDeepConsolidation } from './deep_consolidation_capture.js';
import { selectDeepConsolidationSources } from './deep_consolidation.js';
import { estimateDeepGroupingRequest, requestDeepConsolidationGroups } from './deep_consolidation_groups_request.js';
import { deepGroupingSources, groupDeepSourcesByPosition, measureDeepGroup, moveDeepGroupingSource, normalizeDeepGroupLabel } from './deep_consolidation_groups.js';
import { createDeepConsolidationDraft, getDeepConsolidationDraft, clearDeepConsolidationDraft, deepDraftMatches } from './deep_consolidation_batches.js';
import { runDeepConsolidationBatches, estimateDeepBatchRequest } from './deep_consolidation_batch_request.js';
import { handoffDeepConsolidationDraft } from './deep_consolidation_handoff.js';
import { openLedgerCleanupReviewModal } from './cleanup_review_ui.js';
import { pickTextFile } from '../core/file.js';
import { exportDeepConsolidationDraft, importDeepConsolidationDraft } from './deep_consolidation_draft_io.js';

const ID = 'kt-deep-consolidation-modal';
const esc = value => escapeHtml(String(value ?? ''));
const button = (action, label, extra = '') => `<button type="button" class="mwt-btn" data-deep-action="${action}" ${extra}>${label}</button>`;
// A runner can outlive its modal while an aborted transport settles.
let activeDraftProgress = null;

export async function openDeepConsolidationPreviewModal(name, uid) {
    if (document.getElementById(ID)) return;
    const scope = captureScope();
    const opener = document.activeElement;
    let prepared;
    try {
        prepared = await prepareDeepConsolidation({ name, uid });
        if (!scopeStillCurrent(scope).ok || document.getElementById(ID)) return;
    } catch (error) {
        if (scopeStillCurrent(scope).ok) ktSetStatus(`No deep consolidation preview: ${error.message}`, 'error');
        return;
    }
    let closed = false;
    let busy = false;
    let controller = null;
    let session = null;
    let draft = getDeepConsolidationDraft(prepared.capture);
    let failedResponse = null;
    const modal = createModal({ id: ID, title: `Experimental: Deep Consolidate — ${name}`,
        cssClass: 'kt-deep-preview', destroyOnClose: true,
        content: '<div class="kt-deep-content"></div>',
        onClose: () => {
            closed = true;
            controller?.abort();
            failedResponse = null;
            if (activeDraftProgress === refreshDraftProgress) activeDraftProgress = null;
        },
    });
    const body = modal.querySelector('.kt-deep-content');
    const current = () => !closed && modal.isConnected && scopeStillCurrent(scope).ok;
    const intro = '<p><strong>Experimental batches (v2 Phase 4).</strong> Batch results stay in memory when this modal closes and survive appended scans. Export a private JSON backup before page reload; there is no autosave. Imported results are revalidated locally. Hand off completed work to Condense to edit or explicitly apply with recovery. Nothing is written to the Knowledge entry before Apply.</p>';
    body.innerHTML = `${intro}<p>Draft files contain private source text, accepted records, and retained failed responses. Store them securely. Discard the current draft before importing another.</p>${button('import-draft', 'Import draft JSON')}
        <fieldset class="kt-deep-config"></fieldset>
        <div class="kt-deep-disclosure"></div>
        <label><input type="checkbox" data-deep-consent> I consent to sending the selected non-pinned lines and NPC name to the disclosed Knowledge endpoint (one billable attempt per generation; no automatic retry).</label>
        <div class="kt-condense-actions">${button('generate', 'Generate subject groups')}${button('position', 'Group by position (no model call)')}${button('cancel', 'Cancel request', 'hidden')}</div>
        <div class="kt-deep-failure" hidden><p data-deep-parser-error></p><p>The failed response may contain private RP details. Download it before generating again or closing.</p>${button('export-failure', 'Download failed response')}</div>
        <div class="kt-deep-review"></div><div class="kt-deep-batches"></div>`;
    const config = body.querySelector('.kt-deep-config');
    const disclosure = body.querySelector('.kt-deep-disclosure');
    const review = body.querySelector('.kt-deep-review');
    const batchView = body.querySelector('.kt-deep-batches');
    const generate = body.querySelector('[data-deep-action="generate"]');
    const position = body.querySelector('[data-deep-action="position"]');
    const cancel = body.querySelector('[data-deep-action="cancel"]');
    const failure = body.querySelector('.kt-deep-failure');
    const consent = body.querySelector('[data-deep-consent]');
    let boundary;
    let options;
    let selected;
    let requestOK = false;

    function renderSourceControls() {
        const sources = prepared.selection?.review.sources || [];
        config.innerHTML = `<legend>1. Choose sources</legend>
            <label>Inclusive boundary (ledger source number)<input class="mwt-input" data-deep-boundary type="number" min="1" max="${sources.length}" value="${sources.length}"></label>
            <p>Only sources at or above the boundary, minus pins, are sent. Pins and later lines stay exact.</p>
            <details><summary>Source table and pins</summary>${sources.map(source => `<label class="kt-deep-source"><input type="checkbox" data-deep-pin="${source.order + 1}"> Pin s${source.order + 1}: <span>${esc(source.text)}</span></label>`).join('')}</details>`;
        boundary = config.querySelector('[data-deep-boundary]');
    }

    function refreshDraftProgress(changedDraft) {
        if (draft === changedDraft && current()) renderBatches();
    }

    function updateDisclosure() {
        requestOK = false;
        selected = null;
        try {
            if (draft) {
                boundary.value = draft.throughSource;
                body.querySelectorAll('[data-deep-pin]').forEach(input => { input.checked = draft.pins.includes(Number(input.dataset.deepPin)); });
            }
            const throughSource = Number(boundary.value);
            body.querySelectorAll('[data-deep-pin]').forEach(input => {
                input.disabled = Number(input.dataset.deepPin) > throughSource;
                if (input.disabled) input.checked = false;
            });
            options = { name, uid, throughSource,
                pins: [...body.querySelectorAll('[data-deep-pin]:checked')].map(input => Number(input.dataset.deepPin)) };
            selected = selectDeepConsolidationSources(prepared.selection.review, options);
            const { estimate, budget } = estimateDeepGroupingRequest({ name, selection: selected });
            const model = estimate.disclosure;
            disclosure.innerHTML = `<p>Knowledge connection: ${esc(model.source)} · transport ${esc(model.mode)} · model ${esc(model.modelName || 'profile-resolved / unknown')} · profile ${esc(model.connectionProfileId || 'none')}.</p>
                <p>Estimated grouping request: ${estimate.inputTokens} tokens for ${estimate.sourceCount} sources; response allowance: ${esc(estimate.outputAllowance)}; minimum complete grouping: ${estimate.minimumOutputTokens}; separate-group estimate: ${estimate.rewriteAllOutputTokens} (not an upper bound). Endpoint context capacity is unknown.</p>
                <p>${esc(budget.ok ? 'Request budget permits grouping.' : `${budget.reason} ${budget.suggestion}`)}</p>
                ${(budget.warnings || []).map(warning => `<p>${esc(warning)}</p>`).join('')}`;
            requestOK = budget.ok && estimate.sourceCount > 0;
        } catch (error) { disclosure.textContent = error.message; }
        generate.disabled = busy || !!draft || !requestOK || !consent.checked;
        position.disabled = busy || !!draft || !selected;
        if (draft) renderBatches();
    }

    function renderBatches() {
        if (!draft) { batchView.innerHTML = ''; return; }
        const matches = deepDraftMatches(draft, prepared.capture);
        config.disabled = true;
        review.inert = true;
        const disabled = busy || draft.running || !matches || !consent.checked;
        batchView.innerHTML = `<h4>3. Batch progress</h4>
            <p>${draft.batches.filter(b => b.status === 'accepted').length} accepted / ${draft.batches.length} planned. Calls run sequentially; failures are never retried automatically. Closing cancels the current call and retains completed work.</p>
            <p>Protected snapshot: s1–s${draft.throughSource}; ${draft.pins.length} pins. Later sources stay exact.</p>
            ${!matches ? '<p>This entry changed within the protected snapshot or destination. The draft cannot resume and is export-only.</p>' : ''}
            ${button('run-batches', 'Run / resume pending batches', disabled || !draft.batches.some(b => b.status === 'pending') ? 'disabled' : '')}
            ${button('retry-failed', 'Retry all failed batches', disabled || !draft.batches.some(b => b.status === 'failed') ? 'disabled' : '')}
            ${button('discard-draft', 'Discard in-memory batch draft', busy || draft.running ? 'disabled' : '')}
            ${button('export-draft', 'Export draft JSON')}
            <h4>4. Hand off to Condense</h4><p>Accepted batches become review records. Every other source stays exact, including pending and failed batches. No additional model call is made; any previous Condense draft stays exportable.</p>
            ${button('handoff', 'Review in Condense', busy || draft.running || !matches ? 'disabled' : '')}
            ${draft.batches.map(batch => {
        const request = estimateDeepBatchRequest(name, batch);
        return `<section><h5>${esc(batch.id)} · ${esc(batch.label)} · ${esc(batch.status)}</h5>
                <p>${batch.s.length} sources · ~${batch.tokens} ledger tokens · ~${request.estimate.inputTokens} input tokens · ${request.estimate.outputAllowance ?? 'unknown'} response allowance · minimum answer ~${request.estimate.minimumOutputTokens}. Context capacity is unknown.</p>
                <p>${esc(batch.reason)}</p>
                ${batch.status === 'failed' ? button('retry-batch', 'Retry this batch', `data-batch-id="${batch.id}" ${disabled ? 'disabled' : ''}`) + button('export-batch-failure', 'Download failed response', `data-batch-id="${batch.id}"`) : ''}
                ${batch.status === 'accepted' ? `<details><summary>${batch.result.records.length} accepted records · ${batch.warnings.length} detail warnings (review required)</summary>${batch.result.records.map(record => `<p>s${record.s.join(', s')}: ${esc(record.text)}</p>`).join('')}</details>` : ''}
            </section>`;
    }).join('')}`;
    }

    function renderReview() {
        if (!session) { review.innerHTML = ''; return; }
        const { selection, groups, normalization: n } = session;
        review.innerHTML = `<h4>2. Review subject groups</h4>
            <p>Ungrouped and singleton sources stay exact. These estimated batches use 30 sources / 3,000 ledger tokens; planning freezes the groups and shows exact splitting before any paid batch call.</p>
            <p>${n.ignoredNumbers} unknown, non-integer or excluded numbers ignored; ${n.duplicates} duplicates resolved; ${n.emptyGroups} empty groups dropped; ${n.labelsAdjusted} labels adjusted; ${n.malformedGroups} malformed groups ignored.</p>
            ${groups.map((group, index) => {
        const m = measureDeepGroup(selection, group);
        return `<section class="kt-deep-source"><label>Group ${index + 1} label <input class="mwt-input" maxlength="80" data-deep-label="${index}" value="${esc(group.label)}"></label><p>${m.sourceCount} lines · ~${m.tokens} tokens · ${m.estimatedBatches} estimated batches${m.keptExact ? ' · kept exact (singleton)' : ''}</p></section>`;
    }).join('')}
            ${button('add-group', 'New group from first available source', deepGroupingSources(selection).length ? '' : 'disabled')}
            ${deepGroupingSources(selection).map(source => {
        const number = source.order + 1;
        const index = groups.findIndex(group => group.s.includes(number));
        return `<div class="kt-deep-source"><label>s${number}: ${esc(source.text)}<select class="mwt-input" data-deep-group="${number}" aria-describedby="kt-deep-group-description-${number}"><option value="-1" ${index === -1 ? 'selected' : ''}>Ungrouped — exact</option>${groups.map((_group, i) => `<option value="${i}" ${index === i ? 'selected' : ''}>Group ${i + 1}</option>`).join('')}</select></label><p class="kt-deep-group-description" id="kt-deep-group-description-${number}">${index === -1 ? 'Ungrouped — kept exactly.' : `Group ${index + 1}: ${esc(groups[index].label)}`}</p></div>`;
    }).join('')}
            <p>${session.ungrouped.length} Ungrouped sources kept exact; ${selection.pinnedSourceIds.length} pins and ${selection.recentSources.length} recent sources excluded.</p>
            ${button('plan-batches', 'Plan batches (no model call)')}`;
    }

    config.addEventListener('change', () => {
        if (draft) return;
        consent.checked = false;
        session = null;
        renderReview();
        updateDisclosure();
    });
    consent.addEventListener('change', updateDisclosure);
    review.addEventListener('change', event => {
        if (busy || draft || !current() || !session) return;
        const target = event.target;
        try {
            if (target.hasAttribute('data-deep-label')) {
                session.groups[Number(target.dataset.deepLabel)].label = normalizeDeepGroupLabel(target.value);
            } else if (target.hasAttribute('data-deep-group')) {
                const next = moveDeepGroupingSource(session.selection, session.groups, Number(target.dataset.deepGroup), Number(target.value));
                session = { ...session, groups: next.groups, ungrouped: next.ungrouped };
            }
            renderReview();
        } catch (error) { setStatus(modal, error.message, 'error'); }
    });
    body.addEventListener('click', async event => {
        const control = event.target.closest('[data-deep-action]');
        if (!control || control.disabled || !current()) return;
        const action = control.dataset.deepAction;
        if (action === 'cancel') { controller?.abort(); return; }
        if (busy) return;
        try {
            if (action === 'export-draft' && draft) {
                downloadJson('mwt-deep-consolidation-draft.json', exportDeepConsolidationDraft(draft));
            } else if (action === 'import-draft') {
                if (draft) throw new Error('Discard or export the existing deep draft before importing another.');
                busy = true;
                updateDisclosure();
                try {
                    const text = await pickTextFile('.json');
                    if (!text || !current()) return;
                    const refreshed = await prepareDeepConsolidation({ name, uid });
                    const { capture } = refreshed;
                    if (!current() || !scopeStillCurrent(capture.scopeToken).ok) return;
                    const imported = importDeepConsolidationDraft(text, capture);
                    prepared = refreshed;
                    draft = imported.draft;
                    session = null;
                    renderSourceControls();
                    renderReview();
                    consent.checked = false;
                    setStatus(modal, imported.matches ? 'Draft imported and revalidated. Consent again before any model call.' : 'Draft imported as stale: export-only; no model call or Apply is allowed.');
                } finally {
                    busy = false;
                    if (current()) updateDisclosure();
                }
            } else if (action === 'handoff' && draft) {
                if (document.getElementById('kt-ledger-review-modal')) throw new Error('Close the existing Condense review before handing off.');
                controller = new AbortController();
                busy = true;
                updateDisclosure();
                try {
                    const result = await handoffDeepConsolidationDraft(draft, { signal: controller.signal });
                    if (!current()) return;
                    modal._closeModal?.();
                    await openLedgerCleanupReviewModal(result.capture.name, result.capture.uid, { resumeDraft: true });
                } finally {
                    busy = false;
                    if (current()) updateDisclosure();
                }
            } else if (action === 'plan-batches' && session && !draft) {
                draft = createDeepConsolidationDraft(prepared.capture, session);
                consent.checked = false;
                updateDisclosure();
                setStatus(modal, 'Batch plan saved in memory. Review the per-batch estimates and consent before running.');
            } else if (['run-batches', 'retry-failed', 'retry-batch'].includes(action) && draft) {
                if (!consent.checked || !deepDraftMatches(draft, prepared.capture)) return;
                controller = new AbortController();
                busy = true;
                consent.disabled = true;
                cancel.hidden = false;
                updateDisclosure();
                try {
                    await runDeepConsolidationBatches(draft, { signal: controller.signal,
                        mode: action === 'run-batches' ? 'pending' : 'failed', batchId: control.dataset.batchId,
                        onProgress: changedDraft => activeDraftProgress?.(changedDraft) });
                    if (current()) setStatus(modal, 'Batch run finished. Accepted work is retained in memory; nothing was applied.', 'success');
                } finally {
                    busy = false;
                    consent.disabled = false;
                    cancel.hidden = true;
                    if (current()) updateDisclosure();
                }
            } else if (action === 'export-batch-failure' && draft) {
                const batch = draft.batches.find(b => b.id === control.dataset.batchId);
                if (batch?.failure) downloadJson(`mwt-deep-${batch.id}-failed-response.json`, batch.failure);
            } else if (action === 'discard-draft' && draft && !draft.running) {
                clearDeepConsolidationDraft(prepared.capture);
                draft = null;
                session = null;
                config.disabled = false;
                review.inert = false;
                renderReview(); renderBatches(); updateDisclosure();
            } else if (action === 'generate' && !draft) {
                updateDisclosure();
                if (!requestOK || !consent.checked) return;
                failedResponse = null;
                failure.hidden = true;
                controller = new AbortController();
                busy = true;
                config.disabled = consent.disabled = true;
                cancel.hidden = false;
                review.inert = true;
                generate.setAttribute('aria-busy', 'true');
                updateDisclosure();
                setStatus(modal, 'Requesting subject groups…');
                try {
                    const result = await requestDeepConsolidationGroups({ ...options, signal: controller.signal, expectedCapture: prepared.capture });
                    if (!current() || controller.signal.aborted) return;
                    session = result;
                    renderReview();
                    setStatus(modal, 'Groups ready. Nothing was rewritten or saved.', 'success');
                } finally {
                    busy = false;
                    config.disabled = consent.disabled = false;
                    cancel.hidden = true;
                    review.inert = false;
                    generate.removeAttribute('aria-busy');
                    updateDisclosure();
                }
            } else if (action === 'position' && !draft) {
                updateDisclosure();
                if (!selected) return;
                session = { selection: selected, ...groupDeepSourcesByPosition(selected) };
                renderReview();
                setStatus(modal, 'Grouped by position locally. No model call was made.', 'success');
            } else if (action === 'add-group' && session && !draft) {
                const numbers = deepGroupingSources(session.selection).map(source => source.order + 1);
                const number = session.ungrouped[0] ?? numbers[0];
                const groups = [...session.groups, { label: 'New subject', s: [] }];
                const next = moveDeepGroupingSource(session.selection, groups, number, groups.length - 1);
                session = { ...session, groups: next.groups, ungrouped: next.ungrouped };
                renderReview();
            } else if (action === 'export-failure' && failedResponse) {
                downloadJson('mwt-deep-consolidation-failed-response.json', failedResponse);
            }
        } catch (error) {
            if (!current()) return;
            if (isCancellation(error) || controller?.signal.aborted) setStatus(modal, 'Request cancelled. Accepted batches were retained in memory; nothing was applied.');
            else {
                if (error.deepConsolidationFailure) {
                    failedResponse = error.deepConsolidationFailure;
                    body.querySelector('[data-deep-parser-error]').textContent = failedResponse.error || '';
                    failure.hidden = false;
                }
                setStatus(modal, error.message, 'error');
            }
        }
    });
    activeDraftProgress = refreshDraftProgress;
    renderSourceControls();
    updateDisclosure();
    setModalOpener(modal, opener);
    showModal(ID);
    return modal;
}