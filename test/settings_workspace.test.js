// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderGlobalSettingsForm } from '../core/settings_form.js';
import { SETTINGS_SECTIONS, wireSettingsWorkspace, selectSettingsSection, restoreSettingsFocus } from '../core/settings_workspace.js';
import { renderMainTabShell, wireMainTabBar } from '../core/main_tabs.js';
import { renderAmbientSettings, wireAmbientSettings } from '../ambient/render.js';
import { renderBackupPanel, wireBackupEvents } from '../backup/render.js';

function mount(selectedSection = 'connection', active = true) {
    document.body.innerHTML = `<div id="modal"><div class="mwt-modal-body">${renderMainTabShell([
        { id: 'overview', label: 'Overview' }, { id: 'settings', label: 'Settings' },
    ], tab => tab.id === 'settings' ? renderGlobalSettingsForm({}, { selectedSection }) : '')}</div></div>`;
    const root = document.querySelector('#modal');
    wireMainTabBar(root).select(active ? 1 : 0);
    return root;
}
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('Settings workspace navigation', () => {
    test('owner forms omit duplicate chrome, retain nested disclosures and wire once', () => {
        const root = mount();
        root.querySelector('.mwt-settings-workspace').outerHTML = renderGlobalSettingsForm({}, {
            ambient: renderAmbientSettings({ omitChrome: true }),
            backup: renderBackupPanel({ omitChrome: true }),
        });
        wireSettingsWorkspace(root);
        const ambient = root.querySelector('#mwt-ambient-settings');
        const backup = root.querySelector('#mwt-backup-panel');
        expect(ambient.tagName).toBe('DIV');
        expect(ambient.querySelectorAll('details').length).toBeGreaterThan(0);
        expect(root.querySelectorAll('#mwt-settings-section-ambient h3')).toHaveLength(1);
        expect(root.querySelectorAll('#mwt-settings-section-backup h3')).toHaveLength(1);
        const ambientBind = vi.spyOn(ambient.querySelector('#mwt-a-enabled'), 'addEventListener');
        const backupBind = vi.spyOn(backup.querySelector('#mwt-bk-export'), 'addEventListener');
        wireAmbientSettings(root);
        wireBackupEvents(root);
        selectSettingsSection(root, 'backup');
        wireAmbientSettings(root);
        wireBackupEvents(root);
        expect(ambientBind).toHaveBeenCalledTimes(1);
        expect(backupBind).toHaveBeenCalledTimes(1);
        expect(root.querySelector('#mwt-ambient-settings')).toBe(ambient);
        expect(root.querySelector('#mwt-backup-panel')).toBe(backup);
    });

    test('vertical keys wrap, Home/End and picker synchronize without replacing drafts', () => {
        const root = mount();
        const onSelect = vi.fn();
        wireSettingsWorkspace(root, { onSelect });
        const input = root.querySelector('#mwt-s-api-url');
        input.value = 'unsaved';
        const tabs = [...root.querySelectorAll('.mwt-settings-nav-tab')];
        const picker = root.querySelector('#mwt-settings-picker');
        const key = value => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
        tabs[0].focus();
        key('ArrowUp');
        expect(document.activeElement).toBe(tabs[6]);
        expect(picker.value).toBe('backup');
        key('ArrowDown');
        expect(document.activeElement).toBe(tabs[0]);
        key('End');
        expect(document.activeElement).toBe(tabs[6]);
        key('Home');
        expect(document.activeElement).toBe(tabs[0]);
        picker.value = 'injection';
        picker.dispatchEvent(new Event('change'));
        expect(tabs[2].getAttribute('aria-selected')).toBe('true');
        expect(root.querySelectorAll('.mwt-settings-nav-tab[tabindex="0"]')).toHaveLength(1);
        expect(root.querySelectorAll('.mwt-settings-section:not([hidden])')).toHaveLength(1);
        expect(input).toBe(root.querySelector('#mwt-s-api-url'));
        expect(input.value).toBe('unsaved');
        expect(root.querySelector('#mwt-tab-settings').getAttribute('aria-selected')).toBe('true');
        expect(onSelect).toHaveBeenCalledTimes(5);
    });

    test('rewiring replaces callbacks, resets body scroll once and unknown IDs fall back', () => {
        const root = mount();
        const old = vi.fn(), current = vi.fn();
        wireSettingsWorkspace(root, { onSelect: old });
        wireSettingsWorkspace(root, { onSelect: current });
        const body = root.querySelector('.mwt-modal-body');
        body.scrollTop = 500;
        selectSettingsSection(root, 'ambient');
        expect(body.scrollTop).toBe(0);
        expect(current).toHaveBeenCalledExactlyOnceWith('ambient');
        expect(old).not.toHaveBeenCalled();
        selectSettingsSection(root, 'unknown');
        expect(root.querySelector('#mwt-settings-picker').value).toBe('connection');
    });

    test.each([true, false])('rebuild restores section before focus (Settings active: %s)', active => {
        const root = mount('automation', active);
        wireSettingsWorkspace(root);
        const field = root.querySelector('#mwt-s-api-max-concurrent');
        restoreSettingsFocus(root, field);
        expect(document.activeElement).toBe(active ? field : root.querySelector('#mwt-tab-overview'));
        if (active) {
            restoreSettingsFocus(root, root.querySelector('#mwt-s-api-url'));
            expect(document.activeElement.id).toBe('mwt-settings-tab-automation');
        }
        const rebuilt = mount('automation', active);
        wireSettingsWorkspace(rebuilt);
        expect(rebuilt.querySelector('#mwt-settings-picker').value).toBe('automation');
        expect(rebuilt.querySelector('#mwt-s-api-max-concurrent').value).toBe('2');
    });

    test('breakpoint changes transfer only navigation focus to visible controls', () => {
        const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
        vi.stubGlobal('matchMedia', () => media);
        const root = mount('ambient');
        wireSettingsWorkspace(root);
        const change = media.addEventListener.mock.calls[0][1];
        root.querySelector('#mwt-settings-tab-ambient').focus();
        media.matches = true;
        change();
        expect(document.activeElement.id).toBe('mwt-settings-picker');
        media.matches = false;
        change();
        expect(document.activeElement.id).toBe('mwt-settings-tab-ambient');
        for (const { id } of SETTINGS_SECTIONS) {
            selectSettingsSection(root, id);
            expect(root.querySelector(`#mwt-settings-section-${id}`).hidden).toBe(false);
        }
    });
});