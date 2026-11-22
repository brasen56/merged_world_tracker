/** Session-only Settings navigation. Section changes never rebuild or save forms. */
import { wireTablist } from './ui.js';

export const SETTINGS_SECTIONS = [
    { id: 'connection', label: 'API & Connection' },
    { id: 'automation', label: 'Automation' },
    { id: 'injection', label: 'Injection' },
    { id: 'modules', label: 'Modules & Configuration' },
    { id: 'floating-buttons', label: 'Floating Buttons' },
    { id: 'ambient', label: 'Ambient Conditions — This chat' },
    { id: 'backup', label: 'Backup & Restore — This chat' },
];
const normalize = id => SETTINGS_SECTIONS.some(section => section.id === id) ? id : 'connection';
const bindings = new WeakMap();
const rootBindings = new WeakMap();

export function renderSettingsWorkspace(blocks, selectedSection) {
    const selected = normalize(selectedSection);
    return `<div class="mwt-settings-workspace">
        <div class="mwt-settings-mobile-nav"><label for="mwt-settings-picker">Settings section</label>
            <select id="mwt-settings-picker" class="mwt-select">${SETTINGS_SECTIONS.map(({ id, label }) =>
        `<option value="${id}"${id === selected ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
        <div class="mwt-settings-layout">
            <div class="mwt-settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
                ${SETTINGS_SECTIONS.map(({ id, label }) => `<button type="button" id="mwt-settings-tab-${id}"
                    class="mwt-btn mwt-settings-nav-tab" role="tab" aria-controls="mwt-settings-section-${id}"
                    aria-selected="${id === selected}" tabindex="${id === selected ? 0 : -1}" data-settings-section="${id}">${label}</button>`).join('')}
            </div>
            <div class="mwt-settings-panels">${SETTINGS_SECTIONS.map(({ id, label }) =>
        `<section id="mwt-settings-section-${id}" class="mwt-settings-section" role="tabpanel"
            aria-labelledby="mwt-settings-tab-${id}"${id === selected ? '' : ' hidden'}>
            <h3 tabindex="-1">${label}</h3>${blocks[id] || ''}</section>`).join('')}</div>
        </div>
        <div class="mwt-settings-actions">
            <button type="button" id="mwt-s-save" class="mwt-btn mwt-btn-primary" aria-describedby="mwt-settings-save-scope">Save Global Settings</button>
            <p id="mwt-settings-save-scope">Saves all global sections, including hidden fields. Does not save Ambient drafts, module forms, Calendar, Budget, or backups.</p>
        </div>
    </div>`;
}

export function wireSettingsWorkspace(root, { onSelect = () => {} } = {}) {
    const workspace = root.querySelector('.mwt-settings-workspace');
    if (!workspace) return null;
    const previous = bindings.get(workspace);
    if (previous) {
        previous.onSelect = onSelect;
        return previous.controller;
    }
    rootBindings.get(root)?.();
    const picker = workspace.querySelector('#mwt-settings-picker');
    const state = { onSelect };
    const controller = wireTablist(workspace.querySelector('.mwt-settings-nav'), {
        orientation: 'vertical', tabSelector: '.mwt-settings-nav-tab',
        panelSelector: '.mwt-settings-section', scope: workspace, idPrefix: 'mwt-settings',
        onActivate: tab => {
            picker.value = tab.dataset.settingsSection;
            state.onSelect(picker.value);
            const body = workspace.closest('.mwt-modal-body');
            if (body) body.scrollTop = 0;
        },
    });
    state.controller = controller;
    bindings.set(workspace, state);
    picker.addEventListener('change', () => selectSettingsSection(workspace, picker.value));
    // A breakpoint change must not leave focus in the now-hidden navigation.
    const media = globalThis.matchMedia?.('(max-width: 768px)');
    const moveFocus = () => {
        if (!workspace.isConnected) {
            media?.removeEventListener?.('change', moveFocus);
            return;
        }
        const active = workspace.ownerDocument.activeElement;
        if ((media.matches && active?.closest('.mwt-settings-nav')) || (!media.matches && active === picker)) {
            focusSettingsNavigation(workspace);
        }
    };
    media?.addEventListener?.('change', moveFocus);
    rootBindings.set(root, () => media?.removeEventListener?.('change', moveFocus));
    return controller;
}

/** Single ID-based entry point for picker, Overview and owner links. */
export function selectSettingsSection(root, id, focus = false) {
    const workspace = root.matches?.('.mwt-settings-workspace') ? root : root.querySelector('.mwt-settings-workspace');
    const state = workspace && bindings.get(workspace);
    if (!state) return;
    state.controller.select(SETTINGS_SECTIONS.findIndex(section => section.id === normalize(id)));
    if (focus) focusSettingsNavigation(workspace);
}

export function focusSettingsNavigation(root) {
    const mobile = globalThis.matchMedia?.('(max-width: 768px)').matches;
    root.querySelector(mobile ? '#mwt-settings-picker' : '.mwt-settings-nav-tab[aria-selected="true"]')?.focus();
}

/** Reject focus targets hidden by sections, profiles, disclosures or navigation. */
export function restoreSettingsFocus(modal, target) {
    const inSettings = target?.closest('.mwt-settings-workspace');
    const mobile = globalThis.matchMedia?.('(max-width: 768px)').matches;
    let visible = !!target && !target.disabled;
    for (let node = target; node && node !== modal; node = node.parentElement) {
        if (node.hidden || node.style?.display === 'none') visible = false;
        if (node.tagName === 'DETAILS' && !node.open && !node.querySelector('summary')?.contains(target)) visible = false;
    }
    if ((mobile && target?.closest('.mwt-settings-nav')) || (!mobile && target?.closest('.mwt-settings-mobile-nav'))) visible = false;
    if (visible) target.focus?.();
    else if (inSettings && !inSettings.closest('.mwt-tab-content')?.hidden) focusSettingsNavigation(inSettings);
    else (modal.querySelector('.mwt-tab-btn[aria-selected="true"]') || modal.querySelector('.mwt-modal-close'))?.focus();
}