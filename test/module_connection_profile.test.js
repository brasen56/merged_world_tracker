/** @vitest-environment jsdom */
/**
 * test/module_connection_profile.test.js — every module panel shows, saves,
 * and lets the user clear the Connection Profile that outranks its custom
 * URL/Model.
 *
 * Reported against Story Planner: after "Sync to Modules" with a profile
 * selected, changing the planner's Model and saving did nothing — generation
 * kept using the profile's model, because the module's own profile wins in
 * resolveApiCall() and no module panel rendered it. All five modules shared
 * the bug. Each case drives the module's REAL settings panel and Save button
 * (useRealApiSettingsFields) and checks the result through the real
 * resolveApiCall(), i.e. what the next generation would actually use.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resetCoreStubs, useRealApiSettingsFields } from './stubs/core.js';
import { resolveApiCall } from '../core/api.js';

import { state as spState } from '../story_planner/data.js';
import * as spSettings from '../story_planner/settings.js';
import { render as spRender, wireEvents as spWireEvents } from '../story_planner/render.js';

import { state as wsState } from '../world_state/data.js';
import * as wsSettings from '../world_state/settings.js';
import { render as wsRender, wireEvents as wsWireEvents } from '../world_state/render.js';

import { state as scState, getSettings as scGetSettings, saveSettings as scSaveSettings } from '../chronicle/data.js';
import { renderContent as scRenderContent } from '../chronicle/render.js';

import { state as ktState } from '../knowledge/state.js';
import * as ktSettings from '../knowledge/settings.js';

import { state as intState, getSettings as intGetSettings, saveSettings as intSaveSettings } from '../interiority/data.js';
import { renderSettingsPanel as intRenderSettingsPanel } from '../interiority/render.js';

function host() {
    const el = document.createElement('div');
    document.body.append(el);
    return el;
}

const MODULES = [
    {
        name: 'Story Planner',
        prefix: 'sp', profileId: 'sp-connection-profile', save: '#sp-save-settings',
        getSettings: spSettings.getSettings, saveSettings: spSettings.saveSettings,
        mount() {
            const el = host();
            spState.modal = el;
            el.innerHTML = spRender();
            spWireEvents();
            return el;
        },
        unmount() { spState.modal = null; spState.contentEl = null; },
    },
    {
        name: 'World State',
        prefix: 'ws', profileId: 'ws-connection-profile', save: '#ws-save-settings',
        getSettings: wsSettings.getSettings, saveSettings: wsSettings.saveSettings,
        mount() {
            const el = host();
            wsState.modal = el;
            el.innerHTML = wsRender();
            wsWireEvents();
            return el;
        },
        unmount() { wsState.modal = null; },
    },
    {
        name: 'Chronicle',
        prefix: 'sc', profileId: 'sc-connection-profile', save: '#sc-save-settings',
        getSettings: scGetSettings, saveSettings: scSaveSettings,
        mount() {
            const el = host();
            scState.contentEl = el;
            scRenderContent();
            el.querySelector('#sc-settings-btn').click();
            return el;
        },
        unmount() { scState.contentEl = null; scState.modal = null; },
    },
    {
        name: 'Knowledge',
        prefix: 'kt-cfg', profileId: 'kt-cfg-connection-profile', save: '#kt-save-settings',
        getSettings: ktSettings.getSettings, saveSettings: ktSettings.saveSettings,
        mount() {
            const el = host();
            ktState.npcsContentEl = el;
            ktSettings.showKnowledgeSettings();
            return el;
        },
        unmount() { ktState.npcsContentEl = null; ktState.modal = null; },
    },
    {
        name: 'Interiority',
        prefix: 'mwt-int', profileId: 'mwt-int-connection-profile', save: '#mwt-int-save-settings',
        getSettings: intGetSettings, saveSettings: intSaveSettings,
        mount() {
            const el = host();
            el.innerHTML = '<div id="mwt-int-settings-panel"></div>';
            intState.contentEl = el;
            intRenderSettingsPanel();
            return el;
        },
        unmount() { intState.contentEl = null; intState.modal = null; },
    },
];

const resolve = (m) => resolveApiCall({ moduleSettings: m.getSettings(), globalSettings: {} });

beforeEach(() => {
    resetCoreStubs();
    useRealApiSettingsFields();
    // The real renderConnectionProfileSelect reads the real getContextSafe().
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { connectionManager: { profiles: [{ id: 'synced', name: 'Synced Profile' }] } },
        }),
    };
});

afterEach(() => {
    delete globalThis.SillyTavern;
    document.body.innerHTML = '';
});

describe.each(MODULES)('$name settings: Connection Profile', (m) => {
    let panel;
    const q = (sel) => panel.querySelector(sel);

    function seed(connectionProfileId) {
        m.saveSettings({ ...m.getSettings(), connectionProfileId, apiUrl: 'https://example.test/v1', modelName: 'old-model' });
    }

    afterEach(() => m.unmount());

    test('shows the synced profile and hides the fields it overrides', () => {
        seed('synced');
        panel = m.mount();
        expect(q(`#${m.profileId}`).value).toBe('synced');
        expect(q(`#${m.prefix}-model`).style.display).toBe('none');
        expect(q(`#${m.prefix}-api-url`).style.display).toBe('none');
    });

    test('choosing None and a new model saves a custom target that generation uses', () => {
        seed('synced');
        panel = m.mount();
        expect(resolve(m).source).toBe('module-profile');

        const select = q(`#${m.profileId}`);
        select.value = '';
        select.dispatchEvent(new Event('change'));
        expect(q(`#${m.prefix}-model`).style.display).toBe('');

        q(`#${m.prefix}-model`).value = 'new-model';
        q(m.save).click();

        expect(m.getSettings()).toMatchObject({ connectionProfileId: '', modelName: 'new-model' });
        const resolved = resolve(m);
        expect(resolved.source).toBe('module-custom');
        expect(resolved.settings.modelName).toBe('new-model');
    });

    test('saving without touching the profile keeps it', () => {
        seed('synced');
        panel = m.mount();
        q(m.save).click();
        expect(m.getSettings().connectionProfileId).toBe('synced');
        expect(resolve(m).source).toBe('module-profile');
    });

    test('a profile deleted in ST survives an unrelated save', () => {
        seed('deleted-in-st');
        panel = m.mount();
        expect(q(`#${m.profileId}`).selectedOptions[0].textContent).toBe('Missing profile (deleted-in-st)');
        q(m.save).click();
        expect(m.getSettings().connectionProfileId).toBe('deleted-in-st');
    });

    test('with no profile stored, the custom fields show and None is selected', () => {
        seed('');
        panel = m.mount();
        expect(q(`#${m.profileId}`).value).toBe('');
        expect(q(`#${m.prefix}-model`).style.display).toBe('');
    });
});

describe('World State partial-config guard', () => {
    const ws = MODULES.find(m => m.name === 'World State');
    afterEach(() => ws.unmount());

    test('a selected profile skips the URL/Model pairing check', () => {
        // The hidden custom fields may hold a half-filled pair from an old
        // config; with a profile selected they are not used, so Save proceeds.
        wsSettings.saveSettings({ ...wsSettings.getSettings(), connectionProfileId: 'synced', apiUrl: '', modelName: 'half' });
        const panel = ws.mount();
        expect(wsSettings.getSettings().deltaMode).toBe(false);
        panel.querySelector('#ws-delta-enabled').checked = true;
        panel.querySelector('#ws-save-settings').click();
        // A refused Save would leave deltaMode false.
        expect(wsSettings.getSettings()).toMatchObject({ connectionProfileId: 'synced', deltaMode: true });
    });

    test('with None selected, a URL-less model is still refused', () => {
        wsSettings.saveSettings({ ...wsSettings.getSettings(), connectionProfileId: 'synced', apiUrl: '', modelName: 'old' });
        const panel = ws.mount();
        const select = panel.querySelector('#ws-connection-profile');
        select.value = '';
        select.dispatchEvent(new Event('change'));
        panel.querySelector('#ws-model').value = 'new-model';
        panel.querySelector('#ws-delta-enabled').checked = true;
        panel.querySelector('#ws-save-settings').click();
        expect(wsSettings.getSettings()).toMatchObject({ connectionProfileId: 'synced', modelName: 'old', deltaMode: false });
    });
});
