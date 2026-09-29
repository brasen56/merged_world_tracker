/** @vitest-environment jsdom */
/**
 * test/connection_profile_fields.test.js — the shared Connection Profile
 * select in core/ui.js.
 *
 * The reported bug: "Sync to Modules" writes the global Connection Profile
 * into every module, a module's own profile outranks its custom URL/Model in
 * resolveApiCall(), and no module panel rendered that profile. Editing a
 * module's Model and saving therefore persisted the new name while every
 * generation kept going through the profile's model. The fix renders the
 * profile in each module panel (renderApiSettingsFields' profileId option),
 * hides the fields it overrides, and reads it back on Save.
 */
import { afterEach, describe, expect, test } from 'vitest';

import {
    readApiSettingsValues,
    renderApiSettingsFields,
    renderConnectionProfileSelect,
    wireApiSettingsFields,
} from '../core/ui.js';

const IDS = {
    profileId: 't-profile',
    urlId: 't-url', keyId: 't-key', modelId: 't-model',
    maxTokensId: 't-max', tempId: 't-temp', topPId: 't-topp',
    freqId: 't-freq', presId: 't-pres', headersId: 't-headers',
};

/** The real getContextSafe() reads the SillyTavern global. */
function installProfiles(profiles, selectedProfile = '') {
    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings: { connectionManager: { profiles, selectedProfile } } }),
    };
}

function mount(html) {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    document.body.append(holder);
    return holder;
}

const hidden = (holder, id) => holder.querySelector(`#${id}`).style.display === 'none';

afterEach(() => {
    delete globalThis.SillyTavern;
    document.body.innerHTML = '';
});

describe('renderConnectionProfileSelect', () => {
    test('lists profiles by name, marks the active one, and selects the stored id', () => {
        installProfiles([{ id: 'p1', name: 'Claude' }, { id: 'p2', name: 'Local' }], 'p2');
        const holder = mount(renderConnectionProfileSelect('sel', 'p1', '— None —'));
        const select = holder.querySelector('#sel');

        expect(select.value).toBe('p1');
        expect([...select.options].map(o => o.textContent)).toEqual(['— None —', 'Claude', 'Local (active)']);
    });

    test('with nothing stored, None is selected', () => {
        installProfiles([{ id: 'p1', name: 'Claude' }]);
        const holder = mount(renderConnectionProfileSelect('sel', '', '— None —'));
        expect(holder.querySelector('#sel').value).toBe('');
        expect(holder.querySelectorAll('option')).toHaveLength(2);
    });

    test('a stored id that matches no profile keeps its own selected option', () => {
        // Deleted in ST, or Connection Manager unavailable. Falling back to
        // None would let an unrelated Save silently switch the module's API.
        installProfiles([{ id: 'p1', name: 'Claude' }]);
        const holder = mount(renderConnectionProfileSelect('sel', 'gone', '— None —'));
        const select = holder.querySelector('#sel');

        expect(select.value).toBe('gone');
        expect(select.selectedOptions[0].textContent).toBe('Missing profile (gone)');
    });

    test('with no Connection Manager at all, a stored id still survives', () => {
        const holder = mount(renderConnectionProfileSelect('sel', 'p1', '— None —'));
        expect(holder.querySelector('#sel').value).toBe('p1');
    });

    test('profile ids and names are escaped', () => {
        installProfiles([{ id: 'a"><img data-x="1', name: '<b>bold</b>' }]);
        const holder = mount(renderConnectionProfileSelect('sel', '', '— None —'));
        expect(holder.querySelector('img, b')).toBeNull();
        expect(holder.querySelectorAll('option')[1].value).toBe('a"><img data-x="1');
    });
});

describe('renderApiSettingsFields with profileId', () => {
    test('without profileId: no select and no toggle markers (the global panel)', () => {
        const { profileId, ...noProfile } = IDS;
        const holder = mount(renderApiSettingsFields({ connectionProfileId: 'p1' }, noProfile));
        expect(holder.querySelector('select')).toBeNull();
        expect(holder.querySelector('[data-mwt-api-custom]')).toBeNull();
        expect(holder.querySelector(`#${profileId}`)).toBeNull();
    });

    test('the label targets the profile select', () => {
        const holder = mount(renderApiSettingsFields({}, IDS));
        const label = holder.querySelector('label[for="t-profile"]');
        expect(label.textContent).toBe('Connection Profile');
        expect(holder.querySelector('#t-profile').tagName).toBe('SELECT');
    });

    test('a stored profile hides every field it overrides, but not Max Tokens', () => {
        installProfiles([{ id: 'p1', name: 'Claude' }]);
        const holder = mount(renderApiSettingsFields({ connectionProfileId: 'p1' }, IDS));

        for (const id of ['t-url', 't-key', 't-model', 't-temp', 't-topp', 't-freq', 't-pres', 't-headers']) {
            expect(hidden(holder, id), id).toBe(true);
            expect(holder.querySelector(`label[for="${id}"]`).style.display, id).toBe('none');
        }
        // The Connection Manager transport still sends Max Tokens.
        expect(hidden(holder, 't-max')).toBe(false);
    });

    test('no stored profile leaves the custom fields visible', () => {
        const holder = mount(renderApiSettingsFields({ connectionProfileId: '' }, IDS));
        expect(hidden(holder, 't-url')).toBe(false);
        expect(hidden(holder, 't-model')).toBe(false);
    });

    test('the headers hint hides with the headers field, keeping its own style', () => {
        const holder = mount(renderApiSettingsFields({ connectionProfileId: 'p1' },
            { ...IDS, headersHintHtml: 'Headers <code>{}</code>' }));
        const hint = holder.querySelector('code').parentElement;
        expect(hint.style.display).toBe('none');
        expect(hint.style.fontSize).toBe('11px');
    });
});

describe('wireApiSettingsFields', () => {
    test('None shows the custom fields; a profile hides them again', () => {
        installProfiles([{ id: 'p1', name: 'Claude' }]);
        const holder = mount(renderApiSettingsFields({ connectionProfileId: 'p1' },
            { ...IDS, headersHintHtml: 'hint' }));
        wireApiSettingsFields(holder, IDS);
        const select = holder.querySelector('#t-profile');

        select.value = '';
        select.dispatchEvent(new Event('change'));
        expect(hidden(holder, 't-url')).toBe(false);
        expect(hidden(holder, 't-model')).toBe(false);
        expect(holder.querySelectorAll('[data-mwt-api-custom]:not([style*="none"])').length)
            .toBe(holder.querySelectorAll('[data-mwt-api-custom]').length);

        select.value = 'p1';
        select.dispatchEvent(new Event('change'));
        expect(hidden(holder, 't-url')).toBe(true);
        expect(hidden(holder, 't-max')).toBe(false);
    });

    test('is a no-op without profileId', () => {
        const { profileId: _omit, ...noProfile } = IDS;
        const holder = mount(renderApiSettingsFields({}, noProfile));
        expect(() => wireApiSettingsFields(holder, noProfile)).not.toThrow();
    });
});

describe('readApiSettingsValues', () => {
    test('reports connectionProfileId only when the select is rendered', () => {
        // A panel without the select must never clear a profile it cannot show.
        const { profileId: _omit, ...noProfile } = IDS;
        const without = mount(renderApiSettingsFields({ connectionProfileId: 'p1' }, noProfile));
        expect(readApiSettingsValues(without, noProfile)).not.toHaveProperty('connectionProfileId');

        installProfiles([{ id: 'p1', name: 'Claude' }]);
        const withSelect = mount(renderApiSettingsFields({ connectionProfileId: 'p1' }, IDS));
        expect(readApiSettingsValues(withSelect, IDS).connectionProfileId).toBe('p1');

        withSelect.querySelector('#t-profile').value = '';
        expect(readApiSettingsValues(withSelect, IDS).connectionProfileId).toBe('');
    });

    test('a missing profile round-trips unchanged', () => {
        const holder = mount(renderApiSettingsFields({ connectionProfileId: 'gone' }, IDS));
        expect(readApiSettingsValues(holder, IDS).connectionProfileId).toBe('gone');
    });
});
