/** @vitest-environment jsdom */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { renderGlobalSettingsForm, collectGlobalSettingsPatch } from '../core/settings_form.js';
import { wireSettingsWorkspace, selectSettingsSection } from '../core/settings_workspace.js';
import { wireSettingsConfiguration } from '../core/settings_configuration.js';
import { renderMainTabShell, wireMainTabBar } from '../core/main_tabs.js';
import { resetCoreStubs, useRealApiSettingsFields } from './stubs/core.js';
import { state as wsState } from '../world_state/data.js';
import { render as renderWorld, openSettings as openWorld } from '../world_state/render.js';
import { state as spState } from '../story_planner/data.js';
import { render as renderPlanner, openSettings as openPlanner } from '../story_planner/render.js';
import { state as scState } from '../chronicle/data.js';
import { showSettingsModal, renderContent as renderChronicle } from '../chronicle/render.js';
import { state as ktState } from '../knowledge/state.js';
import { showKnowledgeSettings } from '../knowledge/settings.js';
import { state as intState } from '../interiority/data.js';
import { openSettingsPanel } from '../interiority/render.js';

beforeEach(() => {
    resetCoreStubs();
    useRealApiSettingsFields();
    document.body.innerHTML = '';
    vi.spyOn(window, 'confirm').mockReturnValue(false);
});
afterEach(() => {
    wsState.modal = null;
    spState.modal = null;
    spState.contentEl = null;
    scState.contentEl = null;
    ktState.npcsContentEl = null;
    intState.contentEl = null;
    vi.restoreAllMocks();
});

function host(html = '') {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    return root;
}

describe('Modules Configure routing', () => {
    test('all eight destinations activate their owner without saving or enabling; rewiring replaces callbacks', () => {
        const ids = ['world-state', 'chronicle', 'knowledge', 'story-planner', 'interiority', 'ledger', 'calendar', 'settings'];
        const root = host(`<div class="mwt-modal-body">${renderMainTabShell(ids.map(id => ({ id, label: id })), tab => {
            if (tab.id === 'settings') return renderGlobalSettingsForm({ enableWorldState: false, enableChronicle: false,
                enableKnowledge: false, enableStoryPlanner: false, enableInteriority: false, enableLedger: false });
            if (tab.id === 'ledger') return '<input data-ledger-setting="enableLedger" type="checkbox">';
            return '<h3>Owner</h3>';
        })}</div>`);
        wireMainTabBar(root);
        wireSettingsWorkspace(root);
        const first = vi.fn();
        const openers = Object.fromEntries(ids.slice(0, 5).map(id => [id, vi.fn(() => {
            expect(root.querySelector(`.mwt-tab-content[data-tab="${id}"]`).hidden).toBe(false);
        })]));
        wireSettingsConfiguration(root, { openers: { 'world-state': first } });
        wireSettingsConfiguration(root, { openers });
        const before = collectGlobalSettingsPatch(root);
        for (const id of [...ids.slice(0, 7), 'ambient']) {
            root.querySelector('.mwt-tab-btn[data-tab="settings"]').click();
            selectSettingsSection(root, 'modules');
            const button = root.querySelector(`[data-settings-configure="${id}"]`);
            expect(button.disabled).toBe(false);
            button.click();
            button.click();
            if (openers[id]) expect(openers[id]).toHaveBeenCalledTimes(2);
            else if (id === 'ambient') {
                expect(root.querySelector('#mwt-settings-section-ambient').hidden).toBe(false);
                expect(document.activeElement).toBe(root.querySelector('#mwt-settings-section-ambient h3'));
            } else expect(document.activeElement.closest('.mwt-tab-content').dataset.tab).toBe(id);
        }
        expect(first).not.toHaveBeenCalled();
        expect(collectGlobalSettingsPatch(root)).toEqual(before);
    });
});

describe('real owner openers', () => {
    test.each([
        ['World State', wsState, renderWorld, openWorld, '#ws-settings'],
        ['Story Planner', spState, renderPlanner, openPlanner, '#sp-settings'],
    ])('%s opens and focuses its disclosure twice without replacing drafts', (_label, state, render, open, selector) => {
        const root = host();
        state.modal = root;
        root.innerHTML = render();
        const disclosure = root.querySelector(selector);
        const input = disclosure.querySelector('input');
        input.value = 'draft';
        open();
        open();
        expect(disclosure.open).toBe(true);
        expect(document.activeElement).toBe(disclosure.querySelector('summary'));
        expect(disclosure.querySelector('input')).toBe(input);
        expect(input.value).toBe('draft');
    });

    test('Interiority lazily opens once, preserving drafts even after hiding', () => {
        const root = host('<div id="mwt-int-settings-panel" style="display:none"></div>');
        intState.contentEl = root;
        openSettingsPanel();
        const input = root.querySelector('#mwt-int-model');
        input.value = 'draft';
        openSettingsPanel();
        root.firstElementChild.style.display = 'none';
        openSettingsPanel();
        expect(root.firstElementChild.style.display).toBe('block');
        expect(root.querySelector('#mwt-int-model')).toBe(input);
        expect(input.value).toBe('draft');
        expect(root.contains(document.activeElement)).toBe(true);
    });

    test.each(['Chronicle', 'Knowledge'])('%s preserves open settings and confirms before discarding an editor', name => {
        const root = host('<textarea>original</textarea>');
        const open = name === 'Chronicle' ? showSettingsModal : showKnowledgeSettings;
        if (name === 'Chronicle') scState.contentEl = root;
        else ktState.npcsContentEl = root;
        const editor = root.querySelector('textarea');
        editor.value = 'draft';
        open();
        expect(window.confirm).toHaveBeenCalledOnce();
        expect(root.querySelector('textarea')).toBe(editor);
        expect(document.activeElement).toBe(editor);
        window.confirm.mockReturnValue(true);
        open();
        const heading = root.querySelector('h3');
        expect(document.activeElement).toBe(heading);
        const input = root.querySelector('input');
        input.value = 'settings draft';
        open();
        expect(root.querySelector('input')).toBe(input);
        expect(input.value).toBe('settings draft');
        expect(window.confirm).toHaveBeenCalledTimes(2);
    });

    test('Chronicle list opens directly but pending preview is protected', () => {
        const root = host();
        scState.contentEl = root;
        renderChronicle();
        showSettingsModal();
        expect(root.querySelector('#sc-save-settings')).not.toBeNull();
        expect(window.confirm).not.toHaveBeenCalled();
        root.innerHTML = '<div class="sc-regenerate-diff"><button>Keep Original</button></div>';
        const preview = root.firstElementChild;
        showSettingsModal();
        expect(root.firstElementChild).toBe(preview);
        expect(window.confirm).toHaveBeenCalledOnce();
    });

    test('Knowledge protects an untouched proposal preview, without requiring a sub-tab', () => {
        const root = host('<textarea id="kt-proposal-editor">Pending proposal</textarea>');
        ktState.npcsContentEl = root;
        ktState.activeSubTab = 'relationships';
        const preview = root.firstElementChild;
        showKnowledgeSettings();
        expect(root.firstElementChild).toBe(preview);
        expect(window.confirm).toHaveBeenCalledOnce();
        window.confirm.mockReturnValue(true);
        showKnowledgeSettings();
        expect(root.querySelector('.kt-settings-form')).not.toBeNull();
        expect(ktState.activeSubTab).toBe('relationships');
    });
});