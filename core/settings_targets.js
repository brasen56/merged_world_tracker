/** Shared mechanics for owner-facing settings openers; no persistence. */
export function focusSettingsTarget(target) {
    if (!target) return;
    if (!target.matches('button, input, select, textarea, summary, [tabindex]')) target.tabIndex = -1;
    target.focus();
    target.scrollIntoView?.({ block: 'start' });
    return target;
}

/** Native-control drafts must not be silently discarded by an in-place view. */
export function hasSettingsDraft(root) {
    return [...root.querySelectorAll('input, textarea, select')].some(control => {
        if (control.matches('input[type="checkbox"], input[type="radio"]')) return control.checked !== control.defaultChecked;
        if (control.tagName === 'SELECT') return [...control.options].some(option => option.selected !== option.defaultSelected)
            && control.value !== ([...control.options].find(option => option.defaultSelected) || control.options[0])?.value;
        return control.value !== control.defaultValue;
    });
}