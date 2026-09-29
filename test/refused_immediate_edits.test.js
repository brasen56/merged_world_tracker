/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resetCoreStubs, getFakeMeta } from './stubs/core.js';
import { pauseStore, _resetPausedStores, _setScopeKeyResolver } from '../core/schema_status.js';
import { getInnerState, setInnerState, state as intState } from '../interiority/data.js';
import { renderContent } from '../interiority/render.js';
import {
    getInjectMode, getEnforcement, getPlanData, setUsesGlobalDefaults,
    usesGlobalDefaults, state as planState,
} from '../story_planner/data.js';
import { wireEvents } from '../story_planner/render.js';

beforeEach(() => {
    resetCoreStubs();
    _resetPausedStores();
    _setScopeKeyResolver(() => 'chat:refused-immediate-edits');
    document.body.innerHTML = '';
    if (!globalThis.CSS) globalThis.CSS = {};
    globalThis.CSS.escape ??= value => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
});

afterEach(() => {
    intState.contentEl = null;
    planState.modal = null;
    _resetPausedStores();
    document.body.innerHTML = '';
});

describe('refused immediate edits', () => {
    test('Interiority edit and removal retain the old line and announce failure', () => {
        document.body.innerHTML = '<div id="content"></div>';
        intState.contentEl = document.querySelector('#content');
        expect(setInnerState('Mara', 'calm')).toBe(true);
        renderContent();
        pauseStore('interiority', { reasonCode: 'future-version', message: 'blocked' });
        expect(setInnerState('Mara', 'unsaved', { manual: true })).toBe(false);
        const edit = document.querySelector('.mwt-int-state-edit-btn');
        expect(edit).toBeTruthy();
        edit.click();
        document.querySelector('.mwt-int-state-edit-line').value = 'unsaved';
        document.querySelector('.mwt-int-state-edit-save-btn').click();
        expect(getInnerState('Mara')).toBe('calm');
        expect(document.querySelector('#mwt-int-status').textContent).toMatch(/could not be saved/);
        document.querySelector('.mwt-int-state-remove-btn').click();
        expect(getInnerState('Mara')).toBe('calm');
        expect(document.querySelector('#mwt-int-status').textContent).toMatch(/could not be cleared/);
    });

    test('Story Planner restores unsaved immediate controls and scope', () => {
        document.body.innerHTML = `<div id="planner">
            <input name="sp-inject-mode" type="radio" value="all" checked>
            <input name="sp-inject-mode" type="radio" value="focused">
            <select id="sp-enforcement"><option value="proactive">Proactive</option><option value="subtle">Subtle</option></select>
            <span id="sp-enforcement-blurb"></span>
            <input id="sp-use-global-defaults" type="checkbox">
        </div>`;
        planState.modal = document.querySelector('#planner');
        expect(setUsesGlobalDefaults(false)).toBe(true);
        wireEvents();
        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'blocked' });
        const focused = document.querySelector('input[value="focused"]');
        focused.checked = true;
        focused.dispatchEvent(new Event('change', { bubbles: true }));
        expect(getInjectMode()).toBe('all');
        expect(document.querySelector('input[value="all"]').checked).toBe(true);
        const select = document.querySelector('#sp-enforcement');
        select.value = 'subtle';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(select.value).toBe(getEnforcement());
        const scope = document.querySelector('#sp-use-global-defaults');
        scope.checked = true;
        scope.dispatchEvent(new Event('change', { bubbles: true }));
        expect(scope.checked).toBe(false);
        expect(usesGlobalDefaults()).toBe(false);
        expect(setUsesGlobalDefaults(false)).toBe(false);
        expect(getPlanData().useGlobalDefaults).toBe(false);
        expect(getFakeMeta().story_planner_data.useGlobalDefaults).toBe(false);
    });
});