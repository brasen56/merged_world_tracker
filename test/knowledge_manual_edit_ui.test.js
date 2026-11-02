/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { releaseManagedInert } from '../core/modal.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { getRegistry } from '../knowledge/registry.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getHistory, pushHistory } from '../knowledge/lorebook.js';
import { renderNpcsSubTab } from '../knowledge/render.js';

const NAME = 'Mara Voss';
const BOOK = 'Knowledge Tracker';
const BODY = 'Mara Voss | Human | harbourmaster\nTone: brisk';
const BLOCK = '<!-- mwt:relationships:start -->\nStance toward {{user}}: friendly\n<!-- mwt:relationships:end -->';
let disk, host, fetchDisk;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const modal = () => document.querySelector('#kt-view-modal');
const control = selector => modal().querySelector(selector);
const click = selector => control(selector).click();
const draft = () => control('#kt-manual-body');
const status = () => control('.mwt-status').textContent;
function change(value) {
    draft().value = value;
    draft().dispatchEvent(new Event('input', { bubbles: true }));
}
async function open() {
    renderNpcsSubTab();
    state.npcsContentEl.querySelector('.kt-npc-view').click();
    await flush();
}
async function edit() { click('.kt-view-edit'); await flush(); }
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _clearCacheForTests();
    saveSettings({ scope: 'global' });
    _setCacheForTests(BOOK, { registry: { [NAME]: { uid: 0, entityId: 'ent-mara', type: 'minor', keywords: [NAME] } } });
    disk = { entries: { 0: { uid: 0, comment: NAME, content: BODY, key: [NAME] } } };
    host = {
        worldInfoCache: new Map(),
        loadWorldInfo: vi.fn(async () => structuredClone(disk)),
        saveWorldInfo: vi.fn(async (_name, wi) => { disk = structuredClone(wi); }),
    };
    state.wiScript = host;
    state.stagingItems = [];
    state.activeSubTab = 'minor';
    state.npcsContentEl = document.createElement('div');
    document.body.append(state.npcsContentEl);
    localStorage.clear();
    installCleanupFetch(host);
    fetchDisk = globalThis.fetch;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
    bumpEpoch();
    modal()?._closeModal();
    document.body.innerHTML = '';
    releaseManagedInert();
    _clearCacheForTests();
    _resetEpoch();
    state.wiScript = null;
    state.npcsContentEl = null;
    state.stagingItems = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('NPC Edit-in-View through the real modal and guarded service', () => {
    test('Restore is hidden without differing history, including block-only history', async () => {
        await open();
        expect(control('.kt-view-restore').hidden).toBe(true);
        click('.kt-history-close');
        pushHistory(0, `${BODY}\n\n${BLOCK}`, BOOK);
        await open();
        expect(control('.kt-view-restore').hidden).toBe(true);
    });

    test('Restore loads newest differing body without writing, preserves fresh keys and confirms discard', async () => {
        pushHistory(0, 'oldest', BOOK);
        pushHistory(0, `previous <script>bad()</script>\n\n${BLOCK}`, BOOK);
        const ts = getHistory(0, BOOK)[0].ts;
        pushHistory(0, `${BODY}\n\n${BLOCK}`, BOOK);
        pushHistory(0, BODY, BOOK);
        await open();
        disk.entries[0].key = ['fresh key'];
        click('.kt-view-restore'); await flush();
        expect(draft().value).toBe('previous <script>bad()</script>');
        expect(control('#kt-manual-keywords').value).toBe('fresh key');
        expect(control('.kt-manual-restored').textContent).toContain(new Date(ts).toLocaleString());
        expect(modal().querySelector('script')).toBeNull();
        expect(getHistory(0, BOOK)).toHaveLength(4);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        window.confirm.mockReturnValue(false);
        click('.kt-manual-cancel');
        expect(window.confirm).toHaveBeenCalledTimes(1);
        expect(control('.kt-manual-editor').hidden).toBe(false);
        window.confirm.mockReturnValue(true);
        click('.kt-manual-revert');
        expect(draft().value).toBe(BODY);
        expect(control('.kt-manual-restored').hidden).toBe(true);
    });

    test('two saved restores toggle bodies through existing history and preserve current keys', async () => {
        pushHistory(0, 'previous body', BOOK);
        disk.entries[0].key = ['current keyword'];
        await open();
        click('.kt-view-restore'); await flush();
        click('.kt-manual-save'); await flush();
        expect(disk.entries[0].content).toBe('previous body');
        expect(disk.entries[0].key).toEqual(['current keyword']);
        expect(getHistory(0, BOOK)[0].content).toBe(BODY);
        expect(control('.kt-view-restore').hidden).toBe(false);
        click('.kt-view-restore'); await flush();
        expect(draft().value).toBe(BODY);
        click('.kt-manual-save'); await flush();
        expect(disk.entries[0].content).toBe(BODY);
        expect(disk.entries[0].key).toEqual(['current keyword']);
        expect(host.saveWorldInfo).toHaveBeenCalledTimes(2);
        expect(getHistory(0, BOOK)).toHaveLength(3);
    });

    test('Restore uses fresh live baseline, then refuses an intervening body edit without losing draft', async () => {
        pushHistory(0, 'previous body', BOOK);
        await open();
        disk.entries[0].content = 'changed before Restore';
        click('.kt-view-restore'); await flush();
        disk.entries[0].content = 'changed after Restore';
        click('.kt-manual-save'); await flush();
        expect(status()).toContain('entry changed');
        expect(draft().value).toBe('previous body');
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(getHistory(0, BOOK)).toHaveLength(1);
    });

    test('Restore baseline is the fresh entry rather than the original View', async () => {
        pushHistory(0, 'previous body', BOOK);
        await open();
        disk.entries[0].content = 'fresh live entry';
        click('.kt-view-restore'); await flush();
        click('.kt-manual-save'); await flush();
        expect(disk.entries[0].content).toBe('previous body');
        expect(getHistory(0, BOOK)[0].content).toBe('fresh live entry');
    });

    test('Restore rechecks history against fresh content and stays in View if no version differs', async () => {
        pushHistory(0, 'previous body', BOOK);
        await open();
        disk.entries[0].content = 'previous body';
        click('.kt-view-restore'); await flush();
        expect(control('.kt-manual-editor').hidden).toBe(true);
        expect(control('.kt-view-restore').hidden).toBe(true);
        expect(control('.kt-history-body > pre').textContent).toBe('previous body');
        expect(status()).toContain('No differing previous version');
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('failed Restore load remains read-only and retryable', async () => {
        pushHistory(0, 'previous body', BOOK);
        await open();
        vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
        click('.kt-view-restore'); await flush();
        expect(control('.kt-manual-editor').hidden).toBe(true);
        expect(control('.kt-view-restore').disabled).toBe(false);
        expect(status()).toContain('offline');
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('warnings update live, clear on Revert, and do not prevent a malformed draft saving', async () => {
        await open(); await edit();
        expect(control('#kt-manual-warnings').hidden).toBe(true);
        change('malformed but intentional');
        expect(control('#kt-manual-warnings').textContent).toContain('first line');
        expect(control('.kt-manual-save').disabled).toBe(false);
        click('.kt-manual-revert');
        expect(control('#kt-manual-warnings').hidden).toBe(true);
        change('malformed but intentional');
        click('.kt-manual-save'); await flush();
        expect(disk.entries[0].content).toBe('malformed but intentional');
        expect(host.saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    test('View is read-only; Edit re-reads, strips managed text and renders stored text safely', async () => {
        await open();
        expect(control('.kt-manual-editor').hidden).toBe(true);
        disk.entries[0].content = `${BODY}\n<script>bad()</script>\n\n${BLOCK}`;
        await edit();
        expect(draft().value).toContain('<script>bad()</script>');
        expect(draft().value).not.toContain('mwt:relationships');
        expect(modal().querySelector('script')).toBeNull();
        expect(control('.kt-manual-relationships pre').textContent).toBe(BLOCK);
        expect(document.activeElement).toBe(draft());
        expect(control('#kt-manual-keywords').value).toBe(NAME);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('body save persists, records history, returns to View and re-renders cards', async () => {
        await open(); await edit();
        const oldCard = state.npcsContentEl.querySelector('.kt-npc-view');
        change(`${BODY}\nManual correction`);
        click('.kt-manual-save'); await flush();
        expect(disk.entries[0].content).toContain('Manual correction');
        expect(getHistory(0, BOOK)).toHaveLength(1);
        expect(control('.kt-history-body > pre').textContent).toBe(disk.entries[0].content);
        expect(control('.kt-manual-editor').hidden).toBe(true);
        expect(oldCard.isConnected).toBe(false);
        expect(status()).toContain('saved to lorebook');
        expect(document.activeElement).toBe(control('.kt-view-edit'));
    });

    test.each(['keywords', 'empty-keywords', 'no-op', 'CRLF'])('%s follows Phase 1 persistence rules', async kind => {
        if (kind === 'CRLF') disk.entries[0].content = BODY.replaceAll('\n', '\r\n');
        await open(); await edit();
        if (kind === 'keywords') control('#kt-manual-keywords').value = 'Mara, Harbour';
        if (kind === 'empty-keywords') control('#kt-manual-keywords').value = '';
        click('.kt-manual-save'); await flush();
        if (kind === 'keywords') {
            expect(disk.entries[0].key).toEqual(['Mara', 'Harbour']);
            expect(getRegistry()[NAME].keywords).toEqual(['Mara', 'Harbour']);
            expect(host.saveWorldInfo).toHaveBeenCalledTimes(1);
        } else {
            expect(host.saveWorldInfo).not.toHaveBeenCalled();
            expect(getHistory(0, BOOK)).toEqual([]);
        }
        expect(control('.kt-manual-editor').hidden).toBe(true);
    });

    test('empty content blocks Save without blocking nonempty malformed text', async () => {
        await open(); await edit();
        change('  \n');
        expect(control('.kt-manual-save').disabled).toBe(true);
        change('free-form correction');
        expect(control('.kt-manual-save').disabled).toBe(false);
    });

    test('clearing non-default keywords saves the NPC-name fallback', async () => {
        disk.entries[0].key = ['Harbour'];
        await open(); await edit();
        control('#kt-manual-keywords').value = '';
        click('.kt-manual-save'); await flush();
        expect(host.saveWorldInfo).toHaveBeenCalledTimes(1);
        expect(disk.entries[0].key).toEqual([NAME]);
    });

    test.each(['.kt-manual-revert', '.kt-manual-cancel', '.kt-history-close', '.kt-history-backdrop', 'Escape'])('dirty %s confirms and respects rejection', async action => {
        await open(); await edit(); change('draft to keep');
        window.confirm.mockReturnValue(false);
        const invoke = () => action === 'Escape'
            ? document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) : click(action);
        invoke();
        expect(window.confirm).toHaveBeenCalledTimes(1);
        expect(draft().value).toBe('draft to keep');
        window.confirm.mockReturnValue(true);
        invoke();
        if (action === '.kt-manual-revert') expect(draft().value).toBe(BODY);
        else if (action === '.kt-manual-cancel') expect(control('.kt-manual-editor').hidden).toBe(true);
        else expect(modal()).toBeNull();
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('parsed keyword and newline-equivalent drafts do not prompt on close', async () => {
        await open(); await edit();
        control('#kt-manual-keywords').value = ` , ${NAME}, `;
        click('.kt-history-close');
        expect(window.confirm).not.toHaveBeenCalled();
        expect(modal()).toBeNull();
    });

    test('keyword-only changes prompt on close', async () => {
        await open(); await edit();
        control('#kt-manual-keywords').value = 'new key';
        click('.kt-history-close');
        expect(window.confirm).toHaveBeenCalledTimes(1);
    });

    test('stale refusal keeps draft; reload is explicit and confirmable', async () => {
        await open(); await edit(); change('my draft');
        disk.entries[0].content = 'background edit';
        click('.kt-manual-save'); await flush();
        expect(draft().value).toBe('my draft');
        expect(control('.kt-manual-reload').hidden).toBe(false);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        window.confirm.mockReturnValue(false);
        click('.kt-manual-reload'); await flush();
        expect(draft().value).toBe('my draft');
        window.confirm.mockReturnValue(true);
        click('.kt-manual-reload'); await flush();
        expect(draft().value).toBe('background edit');
        expect(control('.kt-manual-reload').hidden).toBe(true);
    });

    test.each(['missing-host', 'read-failed'])('Edit %s stays read-only with feedback', async kind => {
        await open();
        if (kind === 'missing-host') state.wiScript = null;
        else vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        await edit();
        expect(control('.kt-manual-editor').hidden).toBe(true);
        expect(control('.kt-view-edit').disabled).toBe(false);
        expect(status()).toMatch(/not loaded|offline/);
    });

    test('failed save retains draft and permits retry', async () => {
        await open(); await edit(); change('retry me');
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        click('.kt-manual-save'); await flush();
        expect(draft().value).toBe('retry me');
        expect(control('.kt-manual-save').disabled).toBe(false);
        expect(status()).toContain('offline');
        vi.stubGlobal('fetch', fetchDisk);
        click('.kt-manual-save'); await flush();
        expect(disk.entries[0].content).toBe('retry me');
    });

    test('uncertain outcome keeps draft instead of claiming success', async () => {
        await open(); await edit(); change('possibly saved');
        let reads = 0;
        vi.stubGlobal('fetch', async (path, options) => {
            if (path === '/api/worldinfo/get' && ++reads > 1) throw new Error('verification offline');
            return fetchDisk(path, options);
        });
        click('.kt-manual-save'); await flush();
        expect(draft().value).toBe('possibly saved');
        expect(control('.kt-manual-editor').hidden).toBe(false);
        expect(status()).toContain('uncertain');
        expect(control('.kt-manual-save').disabled).toBe(false);
    });

    test('a failed stale reload does not consume the draft or session', async () => {
        await open(); await edit(); change('valuable draft');
        disk.entries[0].content = 'background';
        click('.kt-manual-save'); await flush();
        vi.stubGlobal('fetch', async () => { throw new Error('reload offline'); });
        click('.kt-manual-reload'); await flush();
        expect(draft().value).toBe('valuable draft');
        expect(control('.kt-manual-reload').hidden).toBe(false);
        expect(status()).toContain('reload offline');
    });

    test('double Edit and Save are single flight; close routes veto during save', async () => {
        await open();
        const gate = deferred();
        vi.stubGlobal('fetch', async (...args) => { await gate.promise; return fetchDisk(...args); });
        click('.kt-view-edit'); click('.kt-view-edit');
        expect(control('.kt-view-edit').getAttribute('aria-busy')).toBe('true');
        gate.resolve(); await flush();
        change('one save');
        const saveGate = deferred();
        vi.stubGlobal('fetch', async (...args) => { await saveGate.promise; return fetchDisk(...args); });
        click('.kt-manual-save'); click('.kt-manual-save');
        click('.kt-history-backdrop');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(modal()).not.toBeNull();
        expect(window.confirm).not.toHaveBeenCalled();
        expect(control('.kt-manual-save').getAttribute('aria-busy')).toBe('true');
        saveGate.resolve(); await flush();
        expect(host.saveWorldInfo).toHaveBeenCalledTimes(1);
        expect(control('.kt-manual-save').getAttribute('aria-busy')).not.toBe('true');
    });

    test.each(['view', 'edit', 'restore', 'save'])('scope change during %s ignores late results and cleans handlers', async stage => {
        if (stage === 'restore') pushHistory(0, 'previous body', BOOK);
        const gate = deferred();
        if (stage === 'view') host.loadWorldInfo.mockImplementation(async () => { await gate.promise; return structuredClone(disk); });
        if (stage === 'view') {
            renderNpcsSubTab(); state.npcsContentEl.querySelector('.kt-npc-view').click();
        } else {
            await open();
            if (stage === 'save') { await edit(); change('old chat draft'); }
            vi.stubGlobal('fetch', async (...args) => { await gate.promise; return fetchDisk(...args); });
            click(stage === 'edit' ? '.kt-view-edit' : stage === 'restore' ? '.kt-view-restore' : '.kt-manual-save');
        }
        const old = modal();
        bumpEpoch();
        old?._closeModal();
        if (old) expect(old._cleanupKeyHandler).toBeNull();
        const newContent = document.createElement('div');
        newContent.textContent = 'new chat';
        state.npcsContentEl = newContent;
        gate.resolve(); await flush();
        expect(modal()).toBeNull();
        expect(window.confirm).not.toHaveBeenCalled();
        expect(newContent.textContent).toBe('new chat');
    });

    test('State Tracker stays read-only and orphan NPCs have no View button', async () => {
        // Use the scope resolver rather than assuming the tracker book's suffix.
        const { getStateLorebookName } = await import('../knowledge/scope.js');
        _setCacheForTests(getStateLorebookName(), { stateRegistry: { Weather: { uid: 1 } } });
        disk.entries[1] = { uid: 1, comment: 'Weather tracker', content: 'State: raining' };
        state.activeSubTab = 'state'; renderNpcsSubTab();
        state.npcsContentEl.querySelector('.kt-state-view').click(); await flush();
        expect(control('.kt-view-edit')).toBeNull();
        click('.kt-history-close');
        getRegistry()[NAME].uid = null;
        state.activeSubTab = 'minor'; renderNpcsSubTab();
        expect(state.npcsContentEl.querySelector('.kt-npc-view')).toBeNull();
    });
});