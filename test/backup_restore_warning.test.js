/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetCoreStubs, setPickTextFileStub } from './stubs/core.js';
import { releaseManagedInert } from '../core/modal.js';

vi.mock('../core/index.js', async () => {
    const stubs = await import('./stubs/core.js');
    const modal = await import('../core/modal.js');
    return { ...stubs, createModal: modal.createModal, showModal: modal.showModal,
        hideModal: modal.hideModal, setStatus: modal.setStatus };
});

vi.mock('../backup/index.js', () => ({
    exportBackup: vi.fn(), undoLastRestore: vi.fn(),
    previewRestore: vi.fn(async () => ({ ok: true, previewToken: 'confirmed-plan', sameChat: true,
        identityPolicy: { identityKnown: true, sameChat: true, exactAllowed: true, restrictions: [] },
        summary: { worldState: { added: 1, updated: 0, skipped: [], conflicts: 0 } } })),
    restoreBackup: vi.fn(),
}));

import { restoreBackup } from '../backup/index.js';
import { renderBackupPanel, wireBackupEvents } from '../backup/render.js';

beforeEach(() => {
    resetCoreStubs();
    vi.stubGlobal('confirm', vi.fn(() => true));
    document.body.innerHTML = `<div id="settings"><div class="mwt-status"></div>${renderBackupPanel()}</div>`;
    wireBackupEvents(document.getElementById('settings'));
    setPickTextFileStub(() => JSON.stringify({ _meta: { chatName: 'Story' }, sections: {} }));
});

afterEach(() => {
    document.body.innerHTML = '';
    releaseManagedInert();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

test.each([false, true])('committed restore handles recovery merge failure honestly (failure: %s)', async failed => {
    restoreBackup.mockResolvedValue({ ok: true, committed: true,
        cleanupRecovery: failed ? { ok: false, error: '<disk unavailable>' } : { ok: true } });
    document.getElementById('mwt-bk-restore').click();
    await vi.waitFor(() => expect(document.querySelector('.mwt-backup-confirm')?.disabled).toBe(false));
    const summary = document.getElementById('mwt-backup-summary-modal');
    const confirm = summary.querySelector('.mwt-backup-confirm');
    confirm.click();
    await vi.waitFor(() => expect(restoreBackup).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(document.querySelector('#settings .mwt-status').textContent).toContain(failed ? 'Store sections restored' : 'Restore complete'));
    if (failed) {
        expect(summary.style.display).not.toBe('none');
        expect(summary.querySelector('.mwt-status').textContent).toContain('cleanup recovery records were not imported');
        expect(summary.querySelector('.mwt-status').textContent).toContain('Keep the original backup file');
        expect(summary.querySelector('.mwt-status').textContent).toContain('Recovery records… → Import');
        expect(summary.querySelector('.mwt-status').textContent).toContain('<disk unavailable>');
        expect(summary.querySelector('disk')).toBeNull();
        expect(confirm.disabled).toBe(true);
        expect(confirm.getAttribute('aria-busy')).not.toBe('true');
        confirm.click();
        expect(restoreBackup).toHaveBeenCalledTimes(1);
    } else expect(summary.style.display).toBe('none');
});

test('rejected recovery originals leave a persistent partial-success warning with counts and reasons', async () => {
    restoreBackup.mockResolvedValue({ ok: true, committed: true,
        cleanupRecovery: { added: ['valid'], kept: ['existing'], rejected: ['bad (<invalid original>)', 'other (missing entity)'] } });
    document.getElementById('mwt-bk-restore').click();
    await vi.waitFor(() => expect(document.querySelector('.mwt-backup-confirm')?.disabled).toBe(false));
    const summary = document.getElementById('mwt-backup-summary-modal');
    const confirm = summary.querySelector('.mwt-backup-confirm');
    confirm.click();
    await vi.waitFor(() => expect(summary.querySelector('.mwt-status').textContent).toContain('2 rejected'));
    expect(summary.style.display).not.toBe('none');
    const warning = summary.querySelector('.mwt-status').textContent;
    expect(warning).toContain('1 added, 1 kept, 2 rejected');
    expect(warning).toContain('bad (<invalid original>)');
    expect(warning).toContain('other (missing entity)');
    expect(warning).toContain('Keep the original backup file');
    expect(summary.querySelector('invalid')).toBeNull();
    expect(document.querySelector('#settings .mwt-status').textContent).toBe(warning);
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('aria-busy')).not.toBe('true');
    confirm.click();
    expect(restoreBackup).toHaveBeenCalledTimes(1);
});