/** Explicit field decisions, separate from ordinary recent-message refresh. */
import { createModal, showModal, setStatus } from '../core/modal.js';
import { escapeHtml } from '../core/diff.js';
import { scopeStillCurrent } from '../core/scope.js';
import { downloadJson } from '../core/index.js';
import { captureCleanupTarget } from './cleanup_commit.js';
import { CLEANUP_FIELDS, fieldCleanupSpans, patchFieldProposal, proposalValueIssues } from './field_cleanup.js';
import { growthOwnsField } from './field_ownership.js';
import { prepareFieldCleanup, requestFieldCleanup, applyFieldCleanup } from './field_cleanup_review.js';

export async function openFieldCleanupModal(name, uid) {
    if (document.getElementById('kt-field-cleanup-modal')) return;
    const capture = await captureCleanupTarget({ name, uid });
    if (!scopeStillCurrent(capture.scopeToken).ok || document.getElementById('kt-field-cleanup-modal')) return;
    const spans = fieldCleanupSpans(capture.originalContent);
    const controller = new AbortController();
    let prepared = null;
    let proposal = null;
    let decisions = {};
    let busy = false;
    let committing = false;
    const modal = createModal({ id: 'kt-field-cleanup-modal', title: `Review field cleanup — ${name}`,
        destroyOnClose: true, onClose: () => {
            if (committing && scopeStillCurrent(capture.scopeToken).ok) return false;
            controller.abort();
        }, content: `<p>Entry-only cleanup, not a refresh from recent messages. The ledger and unselected text stay unchanged.
        Reviews are session-only: export before closing if you want to keep a proposal. Applied originals remain in durable Cleanup recovery.
        Canon Lock, Image Tags, Secrets (tier/lifecycle protected), header identity and Growth-owned fields are unavailable.</p>
        <div class="kt-fc-fields">${CLEANUP_FIELDS.map(field => {
            const eligible = !!spans[field.key]?.value.trim() && !growthOwnsField(name, field.key);
            return `<label style="display:block"><input type="checkbox" data-field="${field.key}" ${eligible ? '' : 'disabled'}>
                ${escapeHtml(field.label)}${eligible ? '' : ' — missing, ambiguous or Growth-owned'}</label>`;
        }).join('')}</div>
        <button class="mwt-btn kt-fc-prepare">Review selected fields…</button>
        <div class="kt-fc-review"></div>` });
    showModal(modal.id);
    const active = () => modal.isConnected && scopeStillCurrent(capture.scopeToken).ok;
    const status = message => setStatus(modal, message, 'info');
    const area = modal.querySelector('.kt-fc-review');
    const report = error => { if (active()) setStatus(modal, error.message, 'error'); };
    modal.querySelector('.kt-fc-prepare').addEventListener('click', async () => {
        if (busy || proposal || !active()) return;
        busy = true;
        try {
            const keys = [...modal.querySelectorAll('[data-field]:checked')].map(input => input.dataset.field);
            prepared = await prepareFieldCleanup({ name, uid, keys });
            if (!active()) return;
            modal.querySelectorAll('[data-field]').forEach(input => { input.disabled = true; });
            modal.querySelector('.kt-fc-prepare').disabled = true;
            const info = prepared.disclosure;
            area.innerHTML = `<p>Resolved Knowledge connection: ${escapeHtml(info.modelName || info.connectionProfileId || info.mode)}
                (${escapeHtml(info.source)}). Sends the NPC name and selected stored values only; no chat, ledger, unrelated fields or recovery originals.
                Estimated input: ~${prepared.inputTokens} tokens; response needs at least ~${prepared.minimumOutputTokens} tokens (every field echoed, notes empty); output allowance: ${info.maxTokens}.
                Endpoint context capacity is unknown and not provider-verified. Provider cost/privacy policies apply.
                One paid request; no automatic correction retries. Invalid or truncated responses are refused.</p>
                <label><input class="kt-fc-consent" type="checkbox"> I approve sending this payload.</label>
                <button class="mwt-btn kt-fc-generate" disabled>Generate proposal</button>`;
            const generate = area.querySelector('.kt-fc-generate');
            area.querySelector('.kt-fc-consent').addEventListener('change', event => { generate.disabled = !event.target.checked; });
            generate.addEventListener('click', async () => {
                if (busy || !active() || !area.querySelector('.kt-fc-consent').checked) return;
                busy = true; generate.disabled = true;
                try {
                    proposal = await requestFieldCleanup(prepared, { signal: controller.signal });
                    if (active()) renderProposal();
                } catch (error) { report(error); }
                finally { busy = false; if (generate.isConnected) generate.disabled = false; }
            });
        } catch (error) { report(error); }
        finally { busy = false; }
    });

    function renderProposal() {
        decisions = {};
        const issues = proposalValueIssues(prepared.review, proposal);
        area.innerHTML = `<p>No changes are accepted yet. Review specificity, attribution and uncertainty; notes and lexical similarity are not proof of equivalence.
            Suggested destinations are notes only; no details are relocated. Keep ambiguous rewrites.</p>
            ${prepared.review.fields.map(field => {
                const item = proposal.fields.find(candidate => candidate.key === field.key);
                const issue = issues[field.key];
                return `<fieldset data-key="${field.key}"><legend>${escapeHtml(field.label)}</legend>
                    <p>Original:</p><pre>${escapeHtml(field.value)}</pre>
                    <p>Proposed:</p><pre>${escapeHtml(item.value)}</pre>
                    ${issue ? `<p class="kt-fc-invalid">Proposal refused: ${escapeHtml(issue)}. Keep the original, or edit it to fit.</p>` : ''}
                    <p>Explanation: ${escapeHtml(item.explanation)}</p>
                    <p>Displaced details: ${escapeHtml(item.displacedDetails || '(none reported)')}</p>
                    <p>Ambiguity: ${escapeHtml(item.ambiguity || '(none reported)')}</p>
                    <label>Decision <select class="kt-fc-decision"><option value="">Choose…</option><option value="keep">Keep original</option>
                    <option value="accept" ${item.ambiguity || issue ? 'disabled' : ''}>Accept proposal</option><option value="edit" ${item.ambiguity ? 'disabled' : ''}>Edit</option></select></label>
                    <label>Edited value <textarea class="kt-fc-edit" disabled>${escapeHtml(item.value)}</textarea></label>
                    <p class="kt-fc-edit-warning" hidden>Editing may displace additional details not covered by model notes. Compare with the original again.</p></fieldset>`;
            }).join('')}
            <button class="mwt-btn kt-fc-export">Export review</button>
            <p>Apply saves a verified recovery original first. Recovery / Restore remains available after closing or reloading.</p>
            <button class="mwt-btn mwt-btn-primary kt-fc-apply" disabled>Apply reviewed field changes</button>
            <p class="kt-fc-apply-hint"></p>`;
        const apply = area.querySelector('.kt-fc-apply');
        const hint = area.querySelector('.kt-fc-apply-hint');
        const update = () => {
            for (const row of area.querySelectorAll('fieldset')) {
                const action = row.querySelector('select').value;
                const editor = row.querySelector('textarea');
                editor.disabled = action !== 'edit';
                row.querySelector('.kt-fc-edit-warning').hidden = action !== 'edit';
                decisions[row.dataset.key] = { action, value: editor.value };
            }
            // Say why Apply is unavailable instead of leaving a silent disabled button.
            try {
                const replacement = patchFieldProposal(prepared.review, proposal, decisions);
                const unchanged = replacement === prepared.capture.originalContent;
                apply.disabled = busy || unchanged;
                hint.textContent = unchanged ? 'Nothing to apply: every decision leaves the stored text as it is.' : '';
            } catch (error) {
                apply.disabled = true;
                hint.textContent = error.message;
            }
        };
        area.querySelectorAll('select, textarea').forEach(input => input.addEventListener('input', update));
        area.querySelector('.kt-fc-export').addEventListener('click', () => downloadJson(`mwt-field-cleanup-${Date.now()}.json`, {
            type: 'mwt-field-cleanup-review', version: 1, review: prepared.review, proposal, decisions,
        }));
        apply.addEventListener('click', async () => {
            if (busy || !active()) return;
            busy = true; committing = true; apply.disabled = true;
            area.querySelectorAll('select, textarea').forEach(input => { input.disabled = true; });
            try {
                const result = await applyFieldCleanup({ ...prepared, proposal, decisions });
                if (!active()) return;
                if (!result.ok) throw new Error(result.error || result.code);
                status('Field cleanup applied. The ledger is unchanged. Use Cleanup recovery to restore or export this action.');
                apply.textContent = 'Applied';
                // Keep the successful review exportable, but never enable Apply again.
                apply.remove();
            } catch (error) { report(error); }
            finally {
                busy = false; committing = false;
                if (apply.isConnected) {
                    area.querySelectorAll('select').forEach(input => { input.disabled = false; });
                    update();
                }
            }
        });
    }
}