/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getFakeStatusCalls, resetCoreStubs } from './stubs/core.js';
import { setWorldStateData, state } from '../world_state/data.js';
import { getSettings, saveSettings } from '../world_state/settings.js';
import { render, wireEvents } from '../world_state/render.js';

function mount() {
    state.modal.innerHTML = render();
    wireEvents();
}

const select = () => state.modal.querySelector('#ws-detail-level');
const customPrompt = () => state.modal.querySelector('#ws-custom-prompt');
const lastStatus = () => getFakeStatusCalls().at(-1)?.message ?? '';

const DOC = '## Current Scene\nDate: Unknown\nTime: Evening\nLocation: Dock\nPresent: Alex\nSituation: Waiting.';

describe('World State Detail Level control', () => {
    beforeEach(() => {
        resetCoreStubs();
        document.body.innerHTML = '<div id="world-state-modal"></div>';
        state.modal = document.getElementById('world-state-modal');
    });

    afterEach(() => {
        state.modal = null;
        document.body.innerHTML = '';
    });

    test('renders the three levels with the saved one selected', () => {
        saveSettings({ detailLevel: 'standard' });
        mount();

        expect([...select().options].map(option => option.value)).toEqual(['minimal', 'standard', 'detailed']);
        expect(select().value).toBe('standard');
        expect(select().disabled).toBe(false);
    });

    test('persists through the one Save button', () => {
        mount();
        select().value = 'minimal';
        state.modal.querySelector('#ws-save-settings').click();

        expect(getSettings().detailLevel).toBe('minimal');
    });

    test('tells the user a format change needs a full Refresh when a document exists', () => {
        setWorldStateData({ text: DOC });
        mount();
        select().value = 'minimal';
        state.modal.querySelector('#ws-save-settings').click();

        expect(lastStatus()).toContain('run 🔄 Refresh to rebuild');
    });

    test('a plain save without a format change says only that it saved', () => {
        setWorldStateData({ text: DOC });
        mount();
        state.modal.querySelector('#ws-save-settings').click();

        expect(lastStatus()).toBe('Settings saved.');
    });

    test('is greyed out while a Custom Prompt is set, live as the user types or resets', () => {
        saveSettings({ customPrompt: 'My format.' });
        mount();
        expect(select().disabled).toBe(true);

        customPrompt().value = '';
        customPrompt().dispatchEvent(new Event('input', { bubbles: true }));
        expect(select().disabled).toBe(false);

        customPrompt().value = 'Another format.';
        customPrompt().dispatchEvent(new Event('input', { bubbles: true }));
        expect(select().disabled).toBe(true);

        state.modal.querySelector('#ws-reset-prompt').click();
        expect(select().disabled).toBe(false);
    });

    test('Minimal disables the Recent Changes regenerate option', () => {
        saveSettings({ detailLevel: 'minimal' });
        mount();
        const option = state.modal.querySelector('#ws-section-select option[value="Recent Changes"]');
        expect(option.disabled).toBe(true);

        saveSettings({ detailLevel: 'standard' });
        mount();
        expect(state.modal.querySelector('#ws-section-select option[value="Recent Changes"]').disabled).toBe(false);
    });
});
