/** Experimental §3E: disposable read-only review. Downloads are the only output. */
import { escapeHtml, downloadBlob, downloadJson, isCancellation } from '../core/index.js';
import { createModal, showModal, setModalOpener, setStatus } from '../core/modal.js';
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { ktSetStatus } from './state.js';
import { prepareDeepConsolidation } from './deep_consolidation_capture.js';
import { selectDeepConsolidationSources } from './deep_consolidation.js';
import { estimateDeepConsolidationRequest, requestDeepConsolidation } from './deep_consolidation_request.js';
import { inspectDeepConsolidation, keepDeepSourceExact } from './deep_consolidation_checks.js';
import { moveDeepSource, exportDeepTrialPacket } from './deep_consolidation_preview.js';

const ID = 'kt-deep-consolidation-modal';
const esc = value => escapeHtml(String(value ?? ''));
const button = (action, label, extra = '') => `<button type="button" class="mwt-btn" data-deep-action="${action}" ${extra}>${label}</button>`;

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
    let controller = null;
    let session = null;
    let validProposal = null;
    let acceptedGroups = false;
    let busy = false;
    const modal = createModal({ id: ID, title: `Experimental: Deep Consolidate (preview) — ${name}`,
        cssClass: 'kt-deep-preview', destroyOnClose: true,
        content: '<div class="kt-deep-content"></div>',
        onClose: () => { closed = true; controller?.abort(); },
    });
    const body = modal.querySelector('.kt-deep-content');
    const current = () => !closed && modal.isConnected && scopeStillCurrent(scope).ok;
    const fail = error => setStatus(modal, error.message, 'error');
    const intro = `<p><strong>Read-only experiment.</strong> Nothing is applied, staged, archived or saved. Closing discards this preview; download both files first. Paste the text only into your duplicate test book.</p>`;
    if (!prepared.selection) {
        body.innerHTML = `${intro}<p>${esc(prepared.eligibility.reason || 'No ledger lines to consolidate.')}</p>`;
        setModalOpener(modal, opener);
        showModal(ID);
        return modal;
    }
    const sources = prepared.selection.review.sources;
    body.innerHTML = `${intro}
        <fieldset class="kt-deep-config"><legend>Choose sources before requesting</legend>
            <label>Inclusive boundary (ledger source number)
                <input data-deep-boundary type="number" min="1" max="${sources.length}" value="${sources.length}"></label>
            <label>Active ledger token goal <input data-deep-budget type="number" min="1" step="1" value="4000"></label>
            <p>Only sources at or above the boundary are sent. Later lines stay verbatim and count toward the goal. Pins are pre-assigned to keep.</p>
            <details><summary>Source table and pins</summary>${sources.map(source => `<label class="kt-deep-source"><input type="checkbox" data-deep-pin="${source.order + 1}"> Pin s${source.order + 1}: <span>${esc(source.text)}</span></label>`).join('')}</details>
        </fieldset>
        <div class="kt-deep-disclosure"></div>
        <label><input type="checkbox" data-deep-consent> I consent to sending the selected lines and NPC name to the disclosed Knowledge endpoint (up to two billable attempts per generation).</label>
        <div class="kt-condense-actions">${button('generate', 'Generate preview')}${button('cancel', 'Cancel request', 'hidden')}</div>
        <div class="kt-deep-review"></div>`;
    const config = body.querySelector('.kt-deep-config');
    const disclosure = body.querySelector('.kt-deep-disclosure');
    const review = body.querySelector('.kt-deep-review');
    const generate = body.querySelector('[data-deep-action="generate"]');
    const cancel = body.querySelector('[data-deep-action="cancel"]');
    const consent = body.querySelector('[data-deep-consent]');
    const boundary = body.querySelector('[data-deep-boundary]');
    const budgetInput = body.querySelector('[data-deep-budget]');
    let options;
    let requestOK = false;

    function updateDisclosure() {
        requestOK = false;
        try {
            const throughSource = Number(boundary.value);
            body.querySelectorAll('[data-deep-pin]').forEach(input => {
                input.disabled = Number(input.dataset.deepPin) > throughSource;
                if (input.disabled) input.checked = false;
            });
            options = { name, uid, throughSource, activeBudget: Number(budgetInput.value),
                pins: [...body.querySelectorAll('[data-deep-pin]:checked')].map(input => Number(input.dataset.deepPin)) };
            const selection = selectDeepConsolidationSources(prepared.selection.review, options);
            const { estimate, budget } = estimateDeepConsolidationRequest({ name, selection, activeBudget: options.activeBudget });
            const model = estimate.disclosure;
            disclosure.innerHTML = `<p>Knowledge connection: ${esc(model.source)} · transport ${esc(model.mode)} · model ${esc(model.modelName || 'profile-resolved / unknown')} · profile ${esc(model.connectionProfileId || 'none')}.</p>
                <p>Estimated request: ${esc(estimate.inputTokens)} tokens; response allowance: ${esc(estimate.outputAllowance)}; minimum complete response: ${esc(estimate.minimumOutputTokens)}; rewrite-all planning estimate: ${esc(estimate.rewriteAllOutputTokens)} (not an upper bound). Endpoint context capacity is unknown; chat limits are not borrowed.</p>
                <p>${esc(budget.ok ? 'Request budget permits this experiment.' : `${budget.reason} ${budget.suggestion || ''}`)}</p>
                ${(budget.warnings || []).map(warning => `<p>${esc(typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning))}</p>`).join('')}`;
            requestOK = budget.ok;
        } catch (error) { disclosure.textContent = error.message; }
        generate.disabled = busy || !requestOK || !consent.checked;
    }

    function warningList(warnings) {
        return `<ul class="kt-condense-record-warnings">${warnings.map(warning => `<li>s${warning.sourceNumber}: ${esc(warning.message || `${warning.kind}: ${warning.detail}`)}</li>`).join('')}</ul>`;
    }

    function renderReview() {
        if (!session) return;
        const { selection, proposal } = session;
        let report;
        let error;
        try {
            report = inspectDeepConsolidation(selection, proposal, { activeBudget: session.activeBudget });
            validProposal = structuredClone(proposal);
        }
        catch (caught) { error = caught; }
        const number = id => selection.review.sources.find(source => source.id === id).order + 1;
        const warnings = report?.warnings || [];
        const m = report?.measurements;
        review.innerHTML = `<h4>1. Review subject groups</h4>
            <p>Relabel, move or ungroup before reviewing records. Moving a source restores its whole merged record to exact originals; ungrouped lines stay exact.</p>
            ${proposal.groups.map((group, index) => `<label>Group ${index + 1} label <input data-deep-label="${index}" value="${esc(group.label)}"></label>`).join('')}
            ${button('add-group', 'New group from s1 (keep originals)')}
            ${selection.eligibleSources.map(source => {
        const index = proposal.groups.findIndex(group => group.sourceIds.includes(source.id));
        return `<div class="kt-deep-source"><label>s${source.order + 1}: ${esc(source.text)}
                    <select data-deep-group="${esc(source.id)}"><option value="-1" ${index === -1 ? 'selected' : ''}>Ungrouped — exact</option>${proposal.groups.map((group, i) => `<option value="${i}" ${index === i ? 'selected' : ''}>${esc(group.label)}</option>`).join('')}</select></label></div>`;
    }).join('')}
            ${button('accept-groups', acceptedGroups ? 'Groups reviewed' : 'Review records with these groups', acceptedGroups || error ? 'disabled' : '')}
            ${error ? `<p role="alert">Draft invalid — exports disabled: ${esc(error.message)}</p>` : ''}
            ${m ? `<section class="kt-deep-measurements"><h4>Budget and continuity guard</h4>
                <p>Estimated active ledger tokens: ${m.beforeTokens} → ${m.afterTokens}; goal ${m.activeBudget}${m.overBudget ? ' — OVER GOAL (outcome, not refusal)' : ''}. Mandatory-exact floor: ${m.floorTokens}${m.floorExceedsBudget ? ' — floor exceeds goal' : ''}.</p>
                <p>${esc(m.floorPolicy)}</p>
                <ul>${['pinned', 'ungrouped', 'recent'].map(key => `<li>${key}: ${m[key].sourceCount} sources (${Math.round(m[key].sourceShare * 100)}%), ~${m[key].tokens} tokens (${Math.round(m[key].tokenShare * 100)}% of original)</li>`).join('')}</ul>
                <p>${m.warningCount} advisory warnings. Lexical retention is not semantic equivalence; implicit corrections and relationships still need manual review.</p></section>` : ''}
            ${acceptedGroups ? `<h4>2. Edit active records</h4>
                ${proposal.records.map((record, index) => `<section class="kt-deep-record"><label>Record ${index + 1} ← ${record.sourceIds.map(id => `s${number(id)}`).join(', ')}
                    <textarea rows="3" data-deep-record="${index}">${esc(record.text)}</textarea></label>
                    <p>${esc(record.notes)}</p>
                    <details><summary>Original sources</summary>${record.sourceIds.map(id => `<p>s${number(id)}: ${esc(selection.review.sources[number(id) - 1].text)}</p>`).join('')}</details>
                    ${warningList(warnings.filter(warning => warning.recordId === record.id))}
                    ${button('keep-record', 'Keep source originals exactly', `data-source="${esc(record.sourceIds[0])}"`)}</section>`).join('')}
                <h4>Archived dispositions (packet only; not persisted)</h4>
                ${proposal.archivedSourceIds.map(id => `<section class="kt-deep-record"><p>s${number(id)}: ${esc(selection.review.sources[number(id) - 1].text)}</p>${warningList(warnings.filter(warning => warning.sourceId === id))}${button('keep-record', 'Keep source exactly', `data-source="${esc(id)}" ${error ? 'disabled' : ''}`)}</section>`).join('') || '<p>None.</p>'}
                <h4>Archive-only lexical details</h4>${warningList(report?.archiveOnlyDetails || [])}<p>This list is not a complete inventory of archived meaning.</p>
                <h4>Exact-by-default candidates</h4>${(report?.exactCandidates || []).map(candidate => `<div class="kt-deep-source">s${candidate.sourceNumber}: ${esc(candidate.text)} — ${esc(candidate.reasons.join(', '))} ${button('keep-record', candidate.canKeepExact ? 'Keep exact' : 'Already exact / recent', `data-source="${esc(candidate.sourceId)}" ${candidate.canKeepExact ? '' : 'disabled'}`)}</div>`).join('')}
                <p>Model notes: ${esc(proposal.notes)}</p>
                <details><summary>Consolidated entry text</summary><pre>${esc(report?.entryText || 'Fix invalid records before exporting.')}</pre></details>
                <p>Trial packet includes full original text and prompt/model facts. Treat both downloads as private RP data.</p>
                <div class="kt-condense-actions">${button('export-text', 'Download consolidated entry text', error ? 'disabled' : '')}${button('export-packet', 'Download trial packet JSON', error ? 'disabled' : '')}</div>` : ''}`;
    }

    config.addEventListener('change', () => { consent.checked = false; updateDisclosure(); });
    consent.addEventListener('change', updateDisclosure);
    review.addEventListener('change', event => {
        if (busy || !current()) return;
        const target = event.target;
        try {
            if (target.hasAttribute('data-deep-record')) {
                session.proposal.records[Number(target.dataset.deepRecord)].text = target.value;
            } else if (target.hasAttribute('data-deep-label')) {
                const next = structuredClone(session.proposal);
                next.groups[Number(target.dataset.deepLabel)].label = target.value;
                inspectDeepConsolidation(session.selection, next);
                session.proposal = next;
                acceptedGroups = false;
            } else if (target.hasAttribute('data-deep-group')) {
                session.proposal = moveDeepSource(session.selection, session.proposal, target.dataset.deepGroup, Number(target.value));
                acceptedGroups = false;
            }
            renderReview();
        } catch (error) { renderReview(); fail(error); }
    });

    body.addEventListener('click', async event => {
        const control = event.target.closest('[data-deep-action]');
        if (!control || control.disabled || !current()) return;
        const action = control.dataset.deepAction;
        if (action === 'cancel') { controller?.abort(); return; }
        if (busy) return;
        try {
            if (action === 'generate') {
                updateDisclosure();
                if (!requestOK || !consent.checked) return;
                controller = new AbortController();
                busy = true;
                config.disabled = true;
                consent.disabled = true;
                generate.disabled = true;
                cancel.hidden = false;
                review.inert = true;
                generate.setAttribute('aria-busy', 'true');
                setStatus(modal, 'Requesting a read-only preview…');
                try {
                    const result = await requestDeepConsolidation({ ...options, signal: controller.signal, expectedCapture: prepared.capture });
                    if (!current() || controller.signal.aborted) return;
                    session = { ...result, activeBudget: options.activeBudget };
                    acceptedGroups = false;
                    renderReview();
                    setStatus(modal, 'Preview ready. Review groups before records. Nothing was saved.', 'success');
                } finally {
                    busy = false;
                    config.disabled = false;
                    consent.disabled = false;
                    cancel.hidden = true;
                    review.inert = false;
                    generate.removeAttribute('aria-busy');
                    generate.textContent = session ? 'Regenerate preview (replaces current draft)' : 'Generate preview';
                    updateDisclosure();
                }
            } else if (action === 'accept-groups') {
                acceptedGroups = true;
                renderReview();
            } else if (action === 'add-group') {
                // A legal group must own at least one source. Moving the first
                // eligible source is explicit and restores any merged owner.
                const sourceId = session.selection.eligibleSources[0].id;
                const next = keepDeepSourceExact(session.selection, session.proposal, sourceId);
                next.groups = next.groups.map(group => ({ ...group, sourceIds: group.sourceIds.filter(id => id !== sourceId) })).filter(group => group.sourceIds.length);
                next.groups.push({ label: 'New subject', sourceIds: [sourceId] });
                session.proposal = next;
                acceptedGroups = false;
                renderReview();
                setStatus(modal, 'New group created with s1, restored exactly. Move other sources into it as needed.');
            } else if (action === 'keep-record') {
                // Invalid text remains editable, but must not block recovery.
                // Restore from the last valid draft if validation currently fails.
                try { inspectDeepConsolidation(session.selection, session.proposal); }
                catch { session.proposal = structuredClone(validProposal); }
                session.proposal = keepDeepSourceExact(session.selection, session.proposal, control.dataset.source);
                renderReview();
            } else if (action === 'export-text') {
                const report = inspectDeepConsolidation(session.selection, session.proposal, { activeBudget: session.activeBudget });
                downloadBlob('mwt-deep-consolidated-entry.txt', new Blob([report.entryText], { type: 'text/plain;charset=utf-8' }));
            } else if (action === 'export-packet') {
                downloadJson('mwt-deep-consolidation-trial.json', exportDeepTrialPacket(session));
            }
        } catch (error) {
            if (current()) {
                if (isCancellation(error) || controller?.signal.aborted) setStatus(modal, 'Request cancelled. Nothing was saved.');
                else fail(error);
            }
        }
    });
    updateDisclosure();
    setModalOpener(modal, opener);
    showModal(ID);
    return modal;
}