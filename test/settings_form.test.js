/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    GLOBAL_API_FIELD_IDS, collectGlobalSettingsPatch, renderGlobalSettingsForm, wireGlobalSettingsForm,
} from '../core/settings_form.js';
import source from '../index.js?raw';

const api = {
    apiUrl: 'https://example.test/v1', apiKey: 'secret', modelName: 'custom-model',
    maxTokens: 3456, temperature: 0.65, topP: 0.75, frequencyPenalty: -0.4,
    presencePenalty: 0.8, customHeaders: '{"X-Test":"value"}', connectionProfileId: '',
};
const expected = {
    ...api, recentHistoryExclude: 7, apiMaxConcurrent: 5,
    pauseBackgroundJobsDuringGeneration: true,
    worldStateDepth: 0, worldStateRole: 'user', chronicleDepth: 9, chronicleRole: 'assistant',
    interiorityDepth: 3, interiorityRole: 'user', structuralBoundaries: false,
    showFloatWorld: true, showFloatChronicle: false, showFloatKnowledge: true,
    showFloatStoryPlanner: false, showFloatInteriority: true, showFloatSettings: false,
    showFloatLedger: false, collapseFloatButtons: true, buttonStyle: 'classic',
    enableWorldState: false, enableChronicle: true, enableKnowledge: false,
    enableStoryPlanner: true, enableInteriority: false, enableLedger: true,
    injectLedger: false, injectionMasterOff: true,
};
const values = {
    'api-url': ` ${api.apiUrl} `, 'api-key': ` ${api.apiKey} `, model: ` ${api.modelName} `,
    'max-tokens': '3456', temp: '0.65', 'top-p': '0.75', 'freq-pen': '-0.4', 'pres-pen': '0.8',
    headers: api.customHeaders, 'recent-history-exclude': '7', 'api-max-concurrent': '5',
    'ws-depth': '0', 'ws-role': 'user', 'ch-depth': '9', 'ch-role': 'assistant',
    'int-depth': '3', 'int-role': 'user', 'button-style': 'classic',
};
const checks = {
    'pause-background': true, 'structural-boundaries': false,
    'show-world': true, 'show-chronicle': false, 'show-knowledge': true,
    'show-story-planner': false, 'show-interiority': true, 'show-settings': false, 'show-ledger': false,
    'collapse-float': true, 'enable-world': false, 'enable-chronicle': true,
    'enable-knowledge': false, 'enable-story-planner': true, 'enable-interiority': false,
    'enable-ledger': true, 'inject-ledger': false, 'master-off': true,
};
function mount(settings = {}) {
    document.body.innerHTML = renderGlobalSettingsForm(settings);
    return document.body;
}
const control = (id) => document.querySelector(`#mwt-s-${id}`);
function populate() {
    for (const [id, value] of Object.entries(values)) control(id).value = value;
    for (const [id, checked] of Object.entries(checks)) control(id).checked = checked;
}
const callbacks = () => ({ onSave: vi.fn(), onSync: vi.fn(), onResetPositions: vi.fn() });

afterEach(() => {
    document.body.innerHTML = '';
    delete globalThis.SillyTavern;
});

describe('global Settings production form seam', () => {
    test('retains the shared global API IDs', () => {
        expect(GLOBAL_API_FIELD_IDS).toEqual({
            urlId: 'mwt-s-api-url', keyId: 'mwt-s-api-key', modelId: 'mwt-s-model',
            maxTokensId: 'mwt-s-max-tokens', tempId: 'mwt-s-temp', topPId: 'mwt-s-top-p',
            freqId: 'mwt-s-freq-pen', presId: 'mwt-s-pres-pen', headersId: 'mwt-s-headers',
        });
    });

    test('round-trips every saved global value through the current rendering', () => {
        expect(collectGlobalSettingsPatch(mount(expected))).toEqual(expected);
        const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('Save reads a complete expected patch from closed disclosures exactly once', () => {
        const root = mount();
        const handlers = callbacks();
        wireGlobalSettingsForm(root, handlers);
        populate();
        root.querySelectorAll('details').forEach(el => { el.open = false; });
        expect(handlers.onSave).not.toHaveBeenCalled();
        control('save').click();
        expect(handlers.onSave).toHaveBeenCalledExactlyOnceWith(expected);
        expect(handlers.onSync).not.toHaveBeenCalled();
        expect(handlers.onResetPositions).not.toHaveBeenCalled();
    });

    test.each(['existing', 'deleted-profile'])('profile %s hides but retains custom drafts through Save and Sync', (id) => {
        globalThis.SillyTavern = { getContext: () => ({ extensionSettings: {
            connectionManager: { profiles: [{ id: 'existing', name: 'Existing' }] },
        } }) };
        const root = mount({ connectionProfileId: id });
        const handlers = callbacks();
        wireGlobalSettingsForm(root, handlers);
        populate();
        const field = control('api-url');
        expect(control('connection-profile').value).toBe(id);
        expect(control('api-fields').style.display).toBe('none');
        control('save').click();
        expect(handlers.onSave).toHaveBeenCalledExactlyOnceWith({ ...expected, connectionProfileId: id });
        control('sync').click();
        expect(handlers.onSync).toHaveBeenCalledExactlyOnceWith({ ...api, connectionProfileId: id });
        control('connection-profile').value = '';
        control('connection-profile').dispatchEvent(new Event('change'));
        expect(control('api-fields').style.display).toBe('');
        control('connection-profile').value = id;
        control('connection-profile').dispatchEvent(new Event('change'));
        expect(control('api-fields').style.display).toBe('none');
        expect(control('api-url')).toBe(field);
        expect(field.value).toBe(values['api-url']);
        expect(handlers.onSave).toHaveBeenCalledTimes(1);
    });

    test('Sync uses unsaved API drafts only and reset does not save', () => {
        const root = mount();
        const handlers = callbacks();
        wireGlobalSettingsForm(root, handlers);
        populate();
        control('sync').click();
        expect(handlers.onSync).toHaveBeenCalledExactlyOnceWith(api);
        control('reset-float-positions').click();
        expect(handlers.onResetPositions).toHaveBeenCalledTimes(1);
        expect(handlers.onSave).not.toHaveBeenCalled();
        expect(collectGlobalSettingsPatch(root)).toEqual(expected);
    });

    test('rewiring replaces callbacks without duplicates, including after body rebuilds', () => {
        const root = mount();
        const stale = callbacks();
        const current = callbacks();
        wireGlobalSettingsForm(root, stale);
        wireGlobalSettingsForm(root, current);
        wireGlobalSettingsForm(root, current);
        for (let rebuild = 0; rebuild < 2; rebuild++) {
            if (rebuild) {
                mount();
                wireGlobalSettingsForm(root, current);
            }
            control('save').click();
            control('sync').click();
            control('reset-float-positions').click();
        }
        for (const key of Object.keys(current)) {
            expect(current[key]).toHaveBeenCalledTimes(2);
            expect(stale[key]).not.toHaveBeenCalled();
        }
    });

    test('does not read or trigger separately owned forms', () => {
        const root = mount();
        root.insertAdjacentHTML('beforeend', '<input id="ambient-draft" value="unsaved"><button id="ambient-save">Save Ambient</button>');
        const ambientSave = vi.fn();
        document.querySelector('#ambient-save').addEventListener('click', ambientSave);
        const handlers = callbacks();
        wireGlobalSettingsForm(root, handlers);
        populate();
        control('save').click();
        expect(handlers.onSave).toHaveBeenCalledExactlyOnceWith(expected);
        expect(ambientSave).not.toHaveBeenCalled();
        expect(document.querySelector('#ambient-draft').value).toBe('unsaved');
    });
});

describe('global form numeric reader contracts', () => {
    test.each([
        ['', 2, 2], ['garbage', 2, 2], ['-9', 0, 1], ['99', 10, 8],
        ['0', 0, 1], ['3.6', 4, 4], ['2.4', 2, 2],
    ])('automation inputs %j retain defaults and clamps', (value, recent, concurrent) => {
        const root = mount();
        // Text permits malformed imported/pasted data; number inputs in a real
        // browser sanitize it to '', which is also covered above.
        for (const id of ['recent-history-exclude', 'api-max-concurrent']) {
            control(id).type = 'text';
            control(id).value = value;
        }
        const patch = collectGlobalSettingsPatch(root);
        expect(patch.recentHistoryExclude).toBe(recent);
        expect(patch.apiMaxConcurrent).toBe(concurrent);
    });

    test.each(['', '-1', 'garbage'])('depth %j falls back without changing parseInt semantics', value => {
        const root = mount();
        for (const id of ['ws-depth', 'ch-depth', 'int-depth']) {
            control(id).type = 'text';
            control(id).value = value;
        }
        expect(collectGlobalSettingsPatch(root)).toMatchObject({ worldStateDepth: 4, chronicleDepth: 4, interiorityDepth: 1 });
        control('ws-depth').value = '2.9';
        expect(collectGlobalSettingsPatch(root).worldStateDepth).toBe(2);
    });

    test('cleared and missing numeric controls use existing defaults', () => {
        const root = mount();
        const ids = ['recent-history-exclude', 'api-max-concurrent', 'max-tokens', 'temp', 'top-p', 'freq-pen', 'pres-pen'];
        for (const id of ids) control(id).value = '';
        const defaults = {
            recentHistoryExclude: 2, apiMaxConcurrent: 2, maxTokens: 2000,
            temperature: 0.3, topP: 1, frequencyPenalty: 0, presencePenalty: 0,
        };
        expect(collectGlobalSettingsPatch(root)).toMatchObject(defaults);
        for (const id of ids) control(id).remove();
        expect(collectGlobalSettingsPatch(root)).toMatchObject(defaults);
    });

    test('API zero values and existing non-clamping behavior remain intact', () => {
        const root = mount();
        for (const id of ['max-tokens', 'temp', 'top-p', 'freq-pen', 'pres-pen']) control(id).value = '0';
        expect(collectGlobalSettingsPatch(root)).toMatchObject({
            maxTokens: 2000, temperature: 0, topP: 0, frequencyPenalty: 0, presencePenalty: 0,
        });
        control('max-tokens').value = '50000';
        control('temp').value = '3';
        expect(collectGlobalSettingsPatch(root)).toMatchObject({ maxTokens: 50000, temperature: 3 });
    });
});

describe('host adoption (index.js cannot be imported under jsdom)', () => {
    test('uses the production seam and leaves side effects with the host', () => {
        expect(source).toContain('renderGlobalSettingsForm(getSettings()) + renderAmbientSettings() + renderBackupPanel()');
        expect(source).toContain('wireGlobalSettingsForm(modal, {');
        expect(source).not.toContain("addEventListener('click', () => {\n            const apiValues");
        const save = source.slice(source.indexOf('onSave: (patch) => {'), source.indexOf('onResetPositions: () => {'));
        for (const effect of ['saveSettings(patch)', '[data-ledger-setting]', 'ui.applyButtonVisibility()',
            'ui.applyButtonStyle()', 'ui.updateButtonStates()', 'pumpCoordinator()',
            'WorldState.applyWorldStateInjection?.()', 'Chronicle.applyInjection?.()',
            'StoryPlanner.applyPlanInjection?.()', 'Interiority.applyIntentionsInjection?.()',
            "Ledger.refreshInjection('settings-saved')", "clearReason: 'panic-settings-save'", "'Settings saved.'"]) {
            expect(save).toContain(effect);
        }
        expect(save).toContain('clearAmbientInjection(');
        expect(save).toContain('clearCalendarInjection(');
        const sync = source.slice(source.indexOf('onSync: (patch) => {'), source.indexOf('// ─── Open modal helper'));
        expect([...sync.matchAll(/(\w+)\.syncGlobalSettings\(patch\)/g)].map(match => match[1]))
            .toEqual(['WorldState', 'Chronicle', 'Knowledge', 'StoryPlanner', 'Interiority']);
        expect(sync).not.toContain('saveSettings(');
        expect(source).toContain('ui.resetFloatPositions();');
    });
});