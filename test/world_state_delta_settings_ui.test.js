/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { state } from '../world_state/data.js';
import { getSettings } from '../world_state/settings.js';
import { render, wireEvents } from '../world_state/render.js';

describe('World State settings save boundary', () => {
    beforeEach(() => {
        resetCoreStubs();
        document.body.innerHTML = '<div id="world-state-modal"></div>';
        state.modal = document.getElementById('world-state-modal');
        state.modal.innerHTML = render();
        wireEvents();
    });

    afterEach(() => {
        state.modal = null;
        document.body.innerHTML = '';
    });

    // The reported bug: Save Settings lived inside the collapsed "⚙️ World
    // State Settings" disclosure, so ticking a box in "⚡ Delta Refresh" (or
    // "🧹 Stale-Entry Expiry & Grounding") looked successful and was silently
    // discarded on close. Save must sit outside every disclosure.
    test('Save Settings is not inside any disclosure', () => {
        const save = state.modal.querySelector('#ws-save-settings');
        expect(save).not.toBeNull();
        expect(save.closest('details')).toBeNull();
    });

    test.each([
        ['#ws-delta-enabled', 'deltaMode'],
        ['#ws-expiry-enabled', 'expiryEnabled'],
        ['#ws-grounding-enabled', 'groundingEnabled'],
    ])('persists %s through the one Save button', (selector, settingKey) => {
        const checkbox = state.modal.querySelector(selector);
        expect(getSettings()[settingKey]).toBe(false);

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        state.modal.querySelector('#ws-save-settings').click();

        expect(getSettings()[settingKey]).toBe(true);
    });

    test('persists the delta tuning fields alongside the checkbox above them', () => {
        state.modal.querySelector('#ws-delta-enabled').checked = true;
        state.modal.querySelector('#ws-delta-reconcile-every').value = '10';
        state.modal.querySelector('#ws-delta-stale-after').value = '25';
        state.modal.querySelector('#ws-save-settings').click();

        expect(getSettings()).toMatchObject({
            deltaMode: true,
            deltaReconcileEvery: 10,
            deltaStaleAfterMsgs: 25,
        });
    });
});
