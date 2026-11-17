/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../core/index.js', async () => ({
    ...await import('./stubs/core.js'),
    createSettingsManager: (await import('../core/settings.js')).createSettingsManager,
}));

import { CURRENT_ONBOARDING_VERSION, shouldShowOnboarding, maybeShowOnboarding, openOnboarding, registerOnboardingStartup, refreshPresetPanes } from '../core/onboarding.js';
import { PRESETS } from '../core/presets.js';
import { GLOBAL_SETTINGS_DEFAULTS, _resetReportedSettingsIssues, getGlobalSettings, saveGlobalSettings } from '../core/settings.js';
import { hideModal } from '../core/modal.js';
import { getFakeExtSettings, getFakeMeta, resetCoreStubs } from './stubs/core.js';
import { renderGlobalSettingsForm, wireGlobalSettingsForm } from '../core/settings_form.js';
import source from '../index.js?raw';
import { renderMainTabShell } from '../core/main_tabs.js';
import { render as renderWorld, wireEvents as wireWorld } from '../world_state/render.js';
import { state as worldState } from '../world_state/data.js';
import { isWorldStateDirty, onPresetRefresh } from '../world_state/index.js';
import { state as chronicleState } from '../chronicle/data.js';
import { state as interiorityState } from '../interiority/data.js';
import { renderContent as renderChronicle, showSettingsModal } from '../chronicle/render.js';
import { renderContent as renderInteriority, openSettingsPanel } from '../interiority/render.js';

let storage;
let save;
beforeEach(() => {
    resetCoreStubs();
    _resetReportedSettingsIssues();
    storage = new Map();
    save = vi.fn();
    vi.stubGlobal('localStorage', {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
    });
    vi.stubGlobal('SillyTavern', {
        getContext: () => ({ extensionSettings: getFakeExtSettings(), saveSettingsDebounced: save }),
    });
    vi.stubGlobal('toastr', { success: vi.fn(), info: vi.fn() });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    worldState.isDirty = false;
});
afterEach(() => {
    if (worldState.editorPersistTimer) clearTimeout(worldState.editorPersistTimer);
    worldState.editorPersistTimer = null;
    worldState.isDirty = false;
    worldState.editSessionActive = false;
    worldState.modal = null;
    hideModal('mwt-onboarding');
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('fresh-install detection', () => {
    test('absent stores and all six materialized empty objects count as fresh', () => {
        expect(GLOBAL_SETTINGS_DEFAULTS.onboardingVersion).toBe(0);
        expect(shouldShowOnboarding()).toBe(true);
        for (const key of Object.keys(PRESETS.standard)) getFakeExtSettings()[key] = {};
        expect(shouldShowOnboarding()).toBe(true);
        expect(save).not.toHaveBeenCalled();
    });
    test.each(Object.keys(PRESETS.standard))('persisted %s prevents auto-show', key => {
        getFakeExtSettings()[key] = { existing: true };
        expect(maybeShowOnboarding()).toBeNull();
        expect(document.getElementById('mwt-onboarding')).toBeNull();
    });
    test.each([...Object.keys(PRESETS.standard), 'world_state_settings', 'session_chronicle_settings', 'knowledge_tracker_settings'])(
        'localStorage record %s prevents auto-show, even if empty or malformed', key => {
            for (const value of ['{}', 'not-json', '']) {
                storage.set(key, value);
                expect(shouldShowOnboarding()).toBe(false);
            }
        },
    );
    test('saving API settings first exits the gate', () => {
        saveGlobalSettings({ apiUrl: 'https://example.test', apiKey: 'keep' });
        expect(shouldShowOnboarding()).toBe(false);
    });
    test.each([CURRENT_ONBOARDING_VERSION, CURRENT_ONBOARDING_VERSION + 1])('acknowledged version %s never auto-shows', version => {
        storage.set('merged_world_tracker', JSON.stringify({ onboardingVersion: version }));
        expect(shouldShowOnboarding()).toBe(false);
    });
    test('unavailable persistence fails closed', () => {
        localStorage.getItem = () => { throw new Error('blocked'); };
        expect(shouldShowOnboarding()).toBe(false);
    });
    test('missing host context or settings store fails closed', () => {
        for (const context of [null, {}]) {
            SillyTavern.getContext = () => context;
            expect(shouldShowOnboarding()).toBe(false);
        }
    });
    test('startup adoption follows all five module initializers', () => {
        const gate = source.indexOf('const onboardingStartup = registerOnboardingStartup({');
        for (const module of ['WorldState', 'Chronicle', 'Knowledge', 'StoryPlanner', 'Interiority']) {
            expect(gate).toBeGreaterThan(source.indexOf(`${module}.init(null)`));
        }
        expect(source).toContain('onRunSetup: () => openOnboarding({ beforeApply: confirmPresetApply, onApplied: refreshPresetControls })');
        expect(source).toContain('eventTypes: event_types, beforeApply: confirmPresetApply, onApplied: refreshPresetControls');
        expect(source).toContain('onboardingStartup.retry();');
        expect(source).toContain('refreshPresetPanes(modal, TABS, buildTabContent);');
    });
});

describe('host-ready startup lifecycle', () => {
    test.each([
        {},
        { eventTypes: { APP_READY: 'ready' } },
        { eventSource: { on: vi.fn() } },
    ])('missing readiness hooks log why automatic setup is unavailable', options => {
        const controller = registerOnboardingStartup(options);
        expect(controller.retry()).toBeNull();
        expect(document.getElementById('mwt-onboarding')).toBeNull();
        expect(console.info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('eventSource or APP_READY is unavailable'));
        expect(openOnboarding()?.isConnected).toBe(true);
    });
    function startup() {
        const listeners = new Map();
        const eventSource = { on: vi.fn((event, callback) => listeners.set(event, callback)) };
        const controller = registerOnboardingStartup({ eventSource, eventTypes: { APP_READY: 'ready' } });
        return { controller, ready: () => listeners.get('ready')?.(), eventSource };
    }
    function foreignDialog() {
        const dialog = document.createElement('dialog');
        dialog.open = true;
        dialog.innerHTML = '<button>Host popup</button>';
        document.body.append(dialog);
        dialog.querySelector('button').focus();
        return dialog;
    }
    test('does not open during splash or an early MWT open; opens on APP_READY', () => {
        const splash = foreignDialog();
        const { controller, ready } = startup();
        expect(controller.retry()).toBeNull();
        expect(document.getElementById('mwt-onboarding')).toBeNull();
        expect(toastr.info).not.toHaveBeenCalled();
        splash.remove();
        ready();
        expect(document.getElementById('mwt-onboarding')).not.toBeNull();
    });
    test('refused ready open is quiet, cleans up and retries even after settings are saved', () => {
        const popup = foreignDialog();
        const { controller, ready } = startup();
        ready();
        expect(document.getElementById('mwt-onboarding')).toBeNull();
        expect(toastr.info).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
        expect(getGlobalSettings().onboardingVersion).toBeUndefined();
        saveGlobalSettings({ apiKey: 'saved while waiting' });
        popup.remove();
        const picker = controller.retry();
        expect(picker?.isConnected).toBe(true);
        expect(controller.retry()).toBeNull();
        expect(document.querySelectorAll('#mwt-onboarding')).toHaveLength(1);
    });
    test('acknowledgement through Settings cancels a pending retry', () => {
        const popup = foreignDialog();
        const { controller, ready } = startup();
        ready();
        saveGlobalSettings({ onboardingVersion: CURRENT_ONBOARDING_VERSION });
        popup.remove();
        expect(controller.retry()).toBeNull();
    });
    test('existing installs never register an automatic open', () => {
        saveGlobalSettings({ apiKey: 'existing' });
        const { controller, eventSource } = startup();
        expect(eventSource.on).not.toHaveBeenCalled();
        expect(controller.retry()).toBeNull();
    });
    test('late-listener replay can open synchronously', () => {
        registerOnboardingStartup({
            eventSource: { on: (_event, callback) => callback() },
            eventTypes: { APP_READY: 'ready' },
        });
        expect(document.getElementById('mwt-onboarding')).not.toBeNull();
    });
});

describe('preset dialog', () => {
    test('startup opens an accessible dialog before the main MWT window exists', () => {
        const modal = maybeShowOnboarding();
        expect(document.getElementById('mwt-modal')).toBeNull();
        expect(modal.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
        expect(modal.querySelectorAll('[data-onboarding-preset]')).toHaveLength(3);
        expect(modal.textContent).toContain('Standard — Recommended');
        expect(modal.textContent).toContain('once per chat');
        expect(modal.querySelector('a').href).toContain('SETUP_GUIDE.md');
        expect(getGlobalSettings()).not.toHaveProperty('onboardingVersion');
        expect(openOnboarding()).toBe(modal);
    });
    test.each(['later', 'close', 'backdrop', 'escape', 'programmatic'])('%s closes, acknowledges, and restores focus without a preset', path => {
        const opener = document.createElement('button');
        document.body.append(opener);
        opener.focus();
        const modal = openOnboarding();
        if (path === 'later') modal.querySelector('#mwt-onboarding-later').click();
        if (path === 'close') modal.querySelector('.mwt-modal-close').click();
        if (path === 'backdrop') modal.querySelector('.mwt-modal-backdrop').click();
        if (path === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        if (path === 'programmatic') hideModal(modal.id);
        expect(document.getElementById(modal.id)).toBeNull();
        expect(document.activeElement).toBe(opener);
        expect(getGlobalSettings()).toEqual({ onboardingVersion: CURRENT_ONBOARDING_VERSION });
        expect(maybeShowOnboarding()).toBeNull();
        expect(toastr.info).toHaveBeenCalledWith(expect.stringContaining('Settings → Modules → Run setup'), 'MWT setup');
    });
    test.each(['lite', 'standard', 'full'])('%s applies exactly the engine patches and preserves chat state', name => {
        getFakeExtSettings().merged_world_tracker = { apiKey: 'keep', injectionMasterOff: true };
        const meta = JSON.stringify(getFakeMeta());
        const onApplied = vi.fn();
        const modal = openOnboarding({ onApplied });
        modal.querySelector(`[data-onboarding-preset="${name}"]`).click();
        for (const [key, patch] of Object.entries(PRESETS[name])) expect(getFakeExtSettings()[key]).toMatchObject(patch);
        expect(getGlobalSettings()).toMatchObject({ apiKey: 'keep', injectionMasterOff: true, onboardingVersion: 1 });
        expect(JSON.stringify(getFakeMeta())).toBe(meta);
        expect(onApplied).toHaveBeenCalledExactlyOnceWith(name);
        expect(document.getElementById(modal.id)).toBeNull();
        expect(toastr.success).toHaveBeenCalledWith(expect.stringContaining('applied'), 'MWT setup');
        expect(toastr.info).not.toHaveBeenCalled();
    });
    test('save failure keeps the dialog open with an honest partial-save warning and supports retry', () => {
        const onApplied = vi.fn();
        const modal = openOnboarding({ onApplied });
        save.mockImplementation(() => { throw new Error('disk'); });
        modal.querySelector('[data-onboarding-preset="standard"]').click();
        expect(modal.isConnected).toBe(true);
        expect(modal.querySelector('.mwt-status').textContent).toContain('Some settings may already have changed');
        expect(onApplied).not.toHaveBeenCalled();
        expect(toastr.success).not.toHaveBeenCalled();
        save.mockReset();
        modal.querySelector('[data-onboarding-preset="standard"]').click();
        expect(modal.isConnected).toBe(false);
    });
    test('failed acknowledgement prevents dismissal until retry', () => {
        const modal = openOnboarding();
        save.mockImplementation(() => { throw new Error('disk'); });
        modal.querySelector('#mwt-onboarding-later').click();
        expect(modal.isConnected).toBe(true);
        expect(modal.querySelector('.mwt-status').textContent).toContain('Could not save setup acknowledgement');
        save.mockReset();
        modal.querySelector('#mwt-onboarding-later').click();
        expect(modal.isConnected).toBe(false);
    });
    test('Settings re-entry bypasses the gate and rewiring does not duplicate handlers', () => {
        saveGlobalSettings({ onboardingVersion: 1, apiKey: 'keep' });
        document.body.innerHTML = renderGlobalSettingsForm(getGlobalSettings());
        const onRunSetup = vi.fn(() => openOnboarding());
        const callbacks = { onSave: vi.fn(), onSync: vi.fn(), onResetPositions: vi.fn(), onRunSetup };
        wireGlobalSettingsForm(document.body, callbacks);
        wireGlobalSettingsForm(document.body, callbacks);
        document.querySelector('#mwt-s-run-setup').click();
        expect(onRunSetup).toHaveBeenCalledTimes(1);
        expect(document.getElementById('mwt-onboarding')).not.toBeNull();
    });
    test('guide renders on GitHub and Ledger behavior is explicit', () => {
        const modal = openOnboarding();
        expect(modal.querySelector('a').href).toBe('https://github.com/brasen56/merged_world_tracker/blob/main/SETUP_GUIDE.md');
        for (const card of modal.querySelectorAll('[data-onboarding-preset]')) expect(card.textContent).toContain('Ledger');
        expect(modal.textContent).toContain('Ledger is unchanged by presets');
    });
});

describe('preset pane refresh', () => {
    test('declining discard preserves the editor, settings, and picker; confirming clears stale state', () => {
        const tabs = [{ id: 'world-state', module: {
            getModuleWireEvents: () => wireWorld, onPresetRefresh,
        } }];
        document.body.innerHTML = renderMainTabShell(tabs, () => renderWorld());
        worldState.modal = document.body;
        wireWorld();
        const editor = document.querySelector('#ws-editor');
        editor.value = 'Unsaved document';
        worldState.isDirty = true;
        worldState.editSessionActive = true;
        const pendingPersist = vi.fn();
        worldState.editorPersistTimer = setTimeout(pendingPersist, 60000);
        const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
        const guardSource = source.slice(source.indexOf('function confirmPresetApply()'), source.indexOf('\nfunction refreshPresetControls()'));
        const beforeApply = new Function('WorldState', 'confirm', `${guardSource}; return confirmPresetApply;`)({ isWorldStateDirty }, confirm);
        const onApplied = vi.fn(() => refreshPresetPanes(document.body, tabs, () => renderWorld()));
        const modal = openOnboarding({ beforeApply, onApplied });
        const stores = JSON.stringify(getFakeExtSettings());
        modal.querySelector('[data-onboarding-preset="lite"]').click();
        expect(confirm).toHaveBeenCalledWith(expect.stringContaining('discard'));
        expect(JSON.stringify(getFakeExtSettings())).toBe(stores);
        expect(onApplied).not.toHaveBeenCalled();
        expect(modal.isConnected).toBe(true);
        expect(document.querySelector('#ws-editor')).toBe(editor);
        expect(editor.value).toBe('Unsaved document');
        expect(isWorldStateDirty()).toBe(true);
        modal.querySelector('[data-onboarding-preset="lite"]').click();
        expect(onApplied).toHaveBeenCalledOnce();
        expect(document.querySelector('#ws-editor').value).not.toBe('Unsaved document');
        expect(isWorldStateDirty()).toBe(false);
        expect(worldState.editSessionActive).toBe(false);
        expect(worldState.editorPersistTimer).toBeNull();
        expect(pendingPersist).not.toHaveBeenCalled();
    });

    test('pause actions work after replacement and repeated wiring does not duplicate calls', async () => {
        const functionSource = source.slice(source.indexOf('function wirePausedStoreControls()'), source.indexOf('\nfunction renderModal()'));
        const retryStore = vi.fn().mockResolvedValue({ ok: true });
        const exportRecoveryData = vi.fn().mockResolvedValue({});
        const setStatus = vi.fn();
        const wire = new Function('modal', 'retryStore', 'exportRecoveryData', 'setControlBusy', 'describeRecoveryExportResult', 'setStatus', `${functionSource}; return wirePausedStoreControls;`)(
            document.body, retryStore, exportRecoveryData, vi.fn(), () => ({ message: 'Downloaded', tone: 'success' }), setStatus,
        );
        const tabs = [{ id: 'knowledge', module: {} }, { id: 'ledger' }];
        const renderPane = () => '<button data-mwt-pause-retry="knowledgeStore">Retry</button><button data-mwt-pause-export="1">Download</button>';
        document.body.innerHTML = renderMainTabShell(tabs, renderPane);
        wire();
        const old = document.querySelector('[data-mwt-pause-retry]');
        refreshPresetPanes(document.body, tabs, renderPane);
        wire();
        wire();
        expect(document.querySelector('[data-mwt-pause-retry]')).not.toBe(old);
        document.querySelector('#mwt-tabpanel-knowledge [data-mwt-pause-retry]').click();
        document.querySelector('#mwt-tabpanel-knowledge [data-mwt-pause-export]').click();
        document.querySelector('#mwt-tabpanel-ledger [data-mwt-pause-export]').click();
        await vi.waitFor(() => expect(setStatus).toHaveBeenCalledTimes(3));
        expect(retryStore).toHaveBeenCalledExactlyOnceWith('knowledgeStore');
        expect(exportRecoveryData).toHaveBeenCalledTimes(2);
        expect(source.match(/wirePausedStoreControls\(\);/g)).toHaveLength(2);
    });

    test('real module forms cannot save old detail or automatic modes after setup', () => {
        getFakeExtSettings().mwt_world_state = { detailLevel: 'detailed', autoRefresh: true };
        getFakeExtSettings().mwt_chronicle = { autoSnapshot: true };
        getFakeExtSettings().mwt_interiority = { autoMode: true };
        const tabs = [
            { id: 'world-state', module: { getModuleWireEvents: () => wireWorld } },
            { id: 'chronicle', module: { getModuleWireEvents: () => renderChronicle } },
            { id: 'interiority', module: { getModuleWireEvents: () => renderInteriority } },
            { id: 'settings' },
        ];
        const renderPane = tab => tab.id === 'world-state' ? renderWorld()
            : tab.id === 'settings' ? '<input id="global-draft" value="keep">' : '';
        document.body.innerHTML = renderMainTabShell(tabs, renderPane);
        worldState.modal = document.body;
        chronicleState.modal = document.body;
        chronicleState.contentEl = null;
        interiorityState.modal = document.body;
        interiorityState.contentEl = null;
        for (const tab of tabs) tab.module?.getModuleWireEvents()();
        showSettingsModal();
        openSettingsPanel();
        expect(document.querySelector('#ws-detail-level').value).toBe('detailed');
        expect(document.querySelector('#sc-auto-snapshot').checked).toBe(true);
        expect(document.querySelector('#mwt-int-auto-mode').checked).toBe(true);
        const draft = document.querySelector('#global-draft');
        const modal = openOnboarding({ onApplied: () => refreshPresetPanes(document.body, tabs, renderPane) });
        modal.querySelector('[data-onboarding-preset="lite"]').click();
        expect(document.querySelector('#global-draft')).toBe(draft);
        expect(document.querySelector('#ws-detail-level').value).toBe('minimal');
        showSettingsModal();
        openSettingsPanel();
        expect(document.querySelector('#sc-auto-snapshot').checked).toBe(false);
        expect(document.querySelector('#mwt-int-auto-mode').checked).toBe(false);
        for (const id of ['ws-save-settings', 'sc-save-settings', 'mwt-int-save-settings']) document.getElementById(id).click();
        expect(getFakeExtSettings().mwt_world_state.detailLevel).toBe('minimal');
        expect(getFakeExtSettings().mwt_chronicle.autoSnapshot).toBe(false);
        expect(getFakeExtSettings().mwt_interiority.autoMode).toBe(false);
        worldState.modal = null;
        chronicleState.modal = chronicleState.contentEl = null;
        interiorityState.modal = interiorityState.contentEl = null;
    });
});