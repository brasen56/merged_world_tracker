/** Configure routing is injectable: owners retain form and save ownership. */
import { selectSettingsSection } from './settings_workspace.js';
import { focusSettingsTarget } from './settings_targets.js';

const bindings = new WeakMap();
export function wireSettingsConfiguration(root, { openers = {} } = {}) {
    const workspace = root.querySelector('.mwt-settings-workspace');
    if (!workspace) return;
    const previous = bindings.get(workspace);
    if (previous) {
        previous.openers = openers;
        return;
    }
    const state = { openers };
    bindings.set(workspace, state);
    workspace.addEventListener('click', event => {
        const button = event.target.closest('[data-settings-configure]');
        if (!button || !workspace.contains(button)) return;
        const id = button.dataset.settingsConfigure;
        const tabId = id === 'ambient' ? 'settings' : id;
        root.querySelector(`.mwt-tab-btn[data-tab="${tabId}"]`)?.click();
        const body = workspace.closest('.mwt-modal-body');
        if (body) body.scrollTop = 0;
        if (id === 'ambient') {
            selectSettingsSection(root, 'ambient');
            focusSettingsTarget(root.querySelector('#mwt-settings-section-ambient h3'));
        } else if (state.openers[id]) {
            state.openers[id]();
        } else if (id === 'ledger' || id === 'calendar') {
            const panel = root.querySelector(`.mwt-tab-content[data-tab="${id}"]`);
            focusSettingsTarget(panel?.querySelector(id === 'ledger' ? '[data-ledger-setting]' : 'h3, h4, input, select, button') || panel);
        }
    });
}