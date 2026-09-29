/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getArcs, makeArc, state } from '../story_planner/data.js';
import { renderContent, wireEvents } from '../story_planner/render.js';
import { releaseManagedInert } from '../core/modal.js';
import { getFakeMeta, getFakeNotifications, resetCoreStubs } from './stubs/core.js';

const gate = vi.hoisted(() => ({ paused: false, blocked: false }));
vi.mock('../core/schema_status.js', () => ({
    isStoreWriteBlocked: () => gate.paused || gate.blocked,
    isStorePausedForCurrentScope: () => gate.paused,
}));

beforeEach(() => {
    resetCoreStubs();
    gate.paused = false;
    gate.blocked = false;
    document.body.innerHTML = '<div id="planner"><div id="sp-arcs"></div><button id="sp-revert"></button><button id="sp-history"></button></div>';
    state.modal = document.getElementById('planner');
    state.contentEl = state.modal;
    const current = makeArc({ title: 'Current' });
    const previous = makeArc({ title: 'Previous' });
    getFakeMeta().story_planner_data = {
        arcs: [current], history: [{ arcs: [previous], timestamp: Date.now() }],
    };
    wireEvents();
    getFakeNotifications().length = 0;
});

afterEach(() => {
    gate.paused = false;
    gate.blocked = false;
    document.body.innerHTML = '';
    releaseManagedInert();
    state.modal = null;
    state.contentEl = null;
});

describe('Story Planner refusal feedback', () => {
    test.each([
        ['revert', '#sp-revert', '#mwt-sp-revert-confirm', 'mwt-sp-revert-modal'],
        ['history', '#sp-history', '#mwt-sp-restore-hist', 'mwt-sp-hist-diff-modal'],
    ])('%s reports a non-pause write refusal without closing or changing the plan', (_name, open, confirm, modalId) => {
        state.modal.querySelector(open).click();
        if (open === '#sp-history') document.querySelector('.mwt-history-item').click();
        gate.blocked = true;
        const modal = document.getElementById(modalId);
        modal.querySelector(confirm).click();
        expect(getArcs()[0].title).toBe('Current');
        expect(modal.style.display).not.toBe('none');
        expect(getFakeNotifications()).toContainEqual(expect.objectContaining({
            level: 'warning', message: expect.stringContaining('store refused the write'),
        }));
        expect(getFakeNotifications().some(item => item.message.includes('paused'))).toBe(false);
    });

    test('paused arc mutations report a refusal while disclosure remains usable', () => {
        renderContent();
        wireEvents();
        const host = state.modal.querySelector('#sp-arcs');
        const section = host.querySelector('.sp-section');
        gate.paused = true;
        section.open = false;
        section.querySelector('summary').click();
        expect(section.open).toBe(true);
        expect(getFakeNotifications()).toHaveLength(0);

        host.querySelector('[data-action="pin"]').click();
        expect(getArcs()[0].pinned).toBe(false);
        expect(getFakeNotifications()).toContainEqual(expect.objectContaining({
            level: 'warning', message: expect.stringContaining('paused'),
        }));
        expect(host.querySelector('.sp-section')).toBe(section);
    });
});

describe('Story Planner restore dialogs while paused', () => {
    test.each([
        ['revert', '#sp-revert', '#mwt-sp-revert-confirm', 'mwt-sp-revert-modal'],
        ['history', '#sp-history', '#mwt-sp-restore-hist', 'mwt-sp-hist-diff-modal'],
    ])('%s does not claim success or close until the restore succeeds', (_name, open, confirm, modalId) => {
        state.modal.querySelector(open).click();
        if (open === '#sp-history') document.querySelector('.mwt-history-item').click();
        const modal = document.getElementById(modalId);
        gate.paused = true;
        modal.querySelector(confirm).click();
        expect(getArcs()[0].title).toBe('Current');
        expect(getFakeMeta().story_planner_data.history).toHaveLength(1);
        expect(modal.style.display).not.toBe('none');
        expect(getFakeNotifications()).toContainEqual(expect.objectContaining({
            title: 'Story Planner', level: 'warning', message: expect.stringContaining('paused'),
        }));
        expect(getFakeNotifications().some(item => item.message === 'Restored from history.' || item.message === 'Reverted to previous snapshot.')).toBe(false);

        gate.paused = false;
        modal.querySelector(confirm).click();
        expect(getArcs()[0].title).toBe('Previous');
        expect(modal.style.display).toBe('none');
        expect(getFakeNotifications().some(item => item.message === (open === '#sp-history' ? 'Restored from history.' : 'Reverted to previous snapshot.'))).toBe(true);
    });
});