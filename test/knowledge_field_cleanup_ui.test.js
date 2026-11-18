// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';
import { _resetEpoch, captureScope, bumpEpoch } from '../core/scope.js';
import { releaseManagedInert } from '../core/modal.js';

vi.mock('../knowledge/cleanup_commit.js', () => ({ captureCleanupTarget: vi.fn() }));
vi.mock('../knowledge/field_cleanup_review.js', () => ({ prepareFieldCleanup: vi.fn(), requestFieldCleanup: vi.fn(), applyFieldCleanup: vi.fn() }));
vi.mock('../knowledge/field_ownership.js', () => ({ growthOwnsField: vi.fn(() => false) }));
import { captureCleanupTarget } from '../knowledge/cleanup_commit.js';
import { prepareFieldCleanup, requestFieldCleanup, applyFieldCleanup } from '../knowledge/field_cleanup_review.js';
import { captureFieldReview } from '../knowledge/field_cleanup.js';
import { openFieldCleanupModal } from '../knowledge/field_cleanup_ui.js';

const content = '[Dossier] Mara | Human | keeper\nRole: Harbourmaster, checked docks today\nVoice: Low and deliberate\nSecrets: Tier 2: hidden\nCanon Lock: born here\nImage Tags: dark hair\n\nKnowledge Ledger:\n- gate code 4812 via witness';
let prepared;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const modal = () => document.getElementById('kt-field-cleanup-modal');
const click = selector => modal().querySelector(selector).click();
const choose = (key, action) => {
    const input = modal().querySelector(`[data-key="${key}"] select`);
    input.value = action;
    input.dispatchEvent(new Event('input', { bubbles: true }));
};
async function generate() {
    await openFieldCleanupModal('Mara', 7);
    modal().querySelector('[data-field="role"]').checked = true;
    click('.kt-fc-prepare'); await tick();
    const consent = modal().querySelector('.kt-fc-consent');
    consent.checked = true; consent.dispatchEvent(new Event('change'));
    click('.kt-fc-generate'); await tick();
}

beforeEach(() => {
    resetCoreStubs(); _resetEpoch(); vi.clearAllMocks();
    const capture = { name: 'Mara', uid: 7, originalContent: content, scopeToken: captureScope() };
    prepared = { capture, review: captureFieldReview(content, ['role', 'voice'], 'r'), inputTokens: 200, minimumOutputTokens: 60,
        disclosure: { modelName: 'test-model', source: 'module-profile', maxTokens: 2000 } };
    captureCleanupTarget.mockResolvedValue(capture);
    prepareFieldCleanup.mockResolvedValue(prepared);
    requestFieldCleanup.mockImplementation(async () => ({ version: 1, reviewId: 'r', fields: [
        { key: 'role', value: 'Harbourmaster', explanation: 'Stable responsibility', displacedDetails: 'Dock inspection today', ambiguity: '' },
        { key: 'voice', value: 'Low voice', explanation: 'Shorter', displacedDetails: 'Deliberate cadence', ambiguity: '' },
    ] }));
    applyFieldCleanup.mockResolvedValue({ ok: true, actionId: 'a' });
});
afterEach(() => {
    modal()?._closeModal?.(); document.body.innerHTML = ''; releaseManagedInert(); vi.restoreAllMocks();
});

describe('field cleanup review presentation', () => {
    test('selection and consent are explicit; disclosure precedes model call', async () => {
        await openFieldCleanupModal('Mara', 7);
        expect(modal().querySelectorAll('[data-field]:checked')).toHaveLength(0);
        expect(modal().querySelector('[data-field="secrets"]')).toBeNull();
        click('.kt-fc-prepare'); await tick();
        expect(requestFieldCleanup).not.toHaveBeenCalled();
        expect(modal().textContent).toContain('test-model');
        expect(modal().textContent).toContain('One paid request');
        expect(modal().textContent).toContain('at least ~60 tokens');
        expect(modal().querySelector('.kt-fc-generate').disabled).toBe(true);
    });
    test('original/proposal/notes and per-field decisions; no preselected acceptance', async () => {
        await generate();
        expect(modal().textContent).toContain('Dock inspection today');
        expect(modal().textContent).toContain('Harbourmaster, checked docks today');
        expect(modal().querySelector('.kt-fc-apply').disabled).toBe(true);
        choose('role', 'accept');
        expect(modal().querySelector('.kt-fc-apply').disabled).toBe(true);
        choose('voice', 'keep');
        expect(modal().querySelector('.kt-fc-apply').disabled).toBe(false);
        click('.kt-fc-apply'); await tick();
        expect(applyFieldCleanup).toHaveBeenCalledWith(expect.objectContaining({ decisions: {
            role: { action: 'accept', value: 'Harbourmaster' }, voice: { action: 'keep', value: 'Low voice' },
        } }));
        expect(modal().textContent).toContain('ledger is unchanged');
        expect(modal().querySelector('.kt-fc-apply')).toBeNull();
    });
    test('an invalid proposed value only blocks Accept for that field and says why', async () => {
        requestFieldCleanup.mockImplementation(async () => ({ version: 1, reviewId: 'r', fields: [
            { key: 'role', value: 'y'.repeat(410), explanation: 'Shorter', displacedDetails: '', ambiguity: '' },
            { key: 'voice', value: 'Low voice', explanation: 'Shorter', displacedDetails: '', ambiguity: '' },
        ] }));
        await generate();
        expect(modal().querySelector('[data-key="role"] .kt-fc-invalid').textContent).toContain('400-character bound');
        expect(modal().querySelector('[data-key="role"] option[value="accept"]').disabled).toBe(true);
        expect(modal().querySelector('[data-key="role"] option[value="edit"]').disabled).toBe(false);
        expect(modal().querySelector('[data-key="voice"] .kt-fc-invalid')).toBeNull();
        choose('role', 'keep'); choose('voice', 'accept');
        expect(modal().querySelector('.kt-fc-apply').disabled).toBe(false);
    });
    test('disabled Apply explains why', async () => {
        await generate();
        choose('role', 'accept');
        expect(modal().querySelector('.kt-fc-apply-hint').textContent).toContain('Decide Voice');
        choose('role', 'keep'); choose('voice', 'keep');
        expect(modal().querySelector('.kt-fc-apply').disabled).toBe(true);
        expect(modal().querySelector('.kt-fc-apply-hint').textContent).toContain('Nothing to apply');
        choose('voice', 'accept');
        expect(modal().querySelector('.kt-fc-apply-hint').textContent).toBe('');
    });
    test('editing recomputes structural validation and exposes detail-review warning', async () => {
        await generate(); choose('role', 'edit'); choose('voice', 'keep');
        const editor = modal().querySelector('[data-key="role"] textarea');
        expect(editor.disabled).toBe(false);
        expect(modal().querySelector('[data-key="role"] .kt-fc-edit-warning').hidden).toBe(false);
        editor.value = 'Role\nKnowledge Ledger: injected'; editor.dispatchEvent(new Event('input'));
        expect(modal().querySelector('.kt-fc-apply').disabled).toBe(true);
    });
    test('save error retains edited review and export', async () => {
        applyFieldCleanup.mockResolvedValue({ ok: false, error: 'disk unavailable' });
        await generate(); choose('role', 'accept'); choose('voice', 'keep');
        click('.kt-fc-apply'); await tick();
        expect(modal().textContent).toContain('disk unavailable');
        expect(modal().querySelector('.kt-fc-export')).not.toBeNull();
        expect(modal().querySelector('.kt-fc-apply').disabled).toBe(false);
    });
    test('close during request aborts and late completion cannot apply', async () => {
        let finish;
        requestFieldCleanup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        await generate();
        const signal = requestFieldCleanup.mock.calls[0][1].signal;
        modal()._closeModal();
        expect(signal.aborted).toBe(true);
        finish({}); await tick();
        expect(modal()).toBeNull(); expect(applyFieldCleanup).not.toHaveBeenCalled();
    });
    test('scope switch permits teardown and aborts generation', async () => {
        await openFieldCleanupModal('Mara', 7);
        bumpEpoch('other-chat'); modal()._closeModal();
        expect(modal()).toBeNull(); expect(requestFieldCleanup).not.toHaveBeenCalled();
    });
});