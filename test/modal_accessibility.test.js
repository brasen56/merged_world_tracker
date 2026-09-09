/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createModal, decorateModalShell, hideModal, showModal } from '../core/modal.js';

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('modal accessibility lifecycle', () => {
    test('excludes hidden tab-panel controls from the focus trap', () => {
        const opener = document.createElement('button');
        document.body.append(opener);
        opener.focus();
        const modal = createModal({
            id: 'mwt-hidden-panel',
            title: 'Hidden panel',
            content: '<button id="visible-control">Visible</button><div hidden><button id="hidden-control">Hidden</button></div>',
            destroyOnClose: false,
        });
        showModal(modal.id);
        const visible = modal.querySelector('#visible-control');
        visible.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
        expect(document.activeElement).toBe(modal.querySelector('.mwt-modal-close'));
    });

    test('excludes controls in CSS-hidden inactive tab panels from the focus trap', () => {
        const modal = createModal({
            id: 'mwt-css-hidden-panel',
            title: 'CSS hidden panel',
            content: '<div class="mwt-tab-content active"><button id="active-control">Active</button></div><div class="mwt-tab-content"><button id="inactive-control">Inactive</button></div>',
            destroyOnClose: false,
        });
        showModal(modal.id);
        const active = modal.querySelector('#active-control');
        active.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
        expect(document.activeElement).toBe(modal.querySelector('.mwt-modal-close'));
    });

    test('marks a decorated Knowledge panel as the topmost modal', () => {
        const modal = document.createElement('div');
        modal.id = 'kt-view-modal';
        modal.className = 'mwt-modal';
        modal.innerHTML = '<div class="kt-history-panel"><h3>View</h3><button class="kt-history-close">Close</button></div>';
        document.body.append(modal);
        decorateModalShell(modal, { title: 'View', destroyOnClose: false });
        showModal(modal.id);
        expect(modal.querySelector('.kt-history-panel').getAttribute('aria-modal')).toBe('true');
    });

    test('gives a decorated panel dialog semantics with a real labelled heading', () => {
        const modal = document.createElement('div');
        modal.id = 'kt-labelled-modal';
        modal.className = 'mwt-modal';
        modal.innerHTML = '<div class="kt-history-panel"><h3>View</h3><button class="kt-history-close">Close</button></div>';
        document.body.append(modal);
        decorateModalShell(modal, { title: 'View', destroyOnClose: false });
        const panel = modal.querySelector('.kt-history-panel');
        const labelledBy = panel.getAttribute('aria-labelledby');
        expect(panel.getAttribute('role')).toBe('dialog');
        expect(labelledBy).toBeTruthy();
        expect(modal.querySelector(`#${labelledBy}`)).toBe(modal.querySelector('h3'));
    });

    test('destroys a decorated modal when it closes', () => {
        const modal = document.createElement('div');
        modal.id = 'kt-destroy-modal';
        modal.className = 'mwt-modal';
        modal.innerHTML = '<div class="kt-history-panel"><h3>Destroy</h3><button class="kt-history-close">Close</button></div>';
        document.body.append(modal);
        decorateModalShell(modal, { title: 'Destroy', destroyOnClose: true });
        modal.querySelector('.kt-history-close').click();
        expect(document.getElementById('kt-destroy-modal')).toBeNull();
    });

    test('does not close a decorated modal from its backdrop when disabled', () => {
        const modal = document.createElement('div');
        modal.id = 'kt-no-backdrop-close';
        modal.className = 'mwt-modal';
        modal.innerHTML = '<div class="kt-history-backdrop"></div><div class="kt-history-panel"><h3>Growth</h3><button class="kt-history-close">Close</button></div>';
        document.body.append(modal);
        decorateModalShell(modal, { title: 'Growth', closeOnBackdrop: false, destroyOnClose: false });
        modal.querySelector('.kt-history-backdrop').click();
        expect(modal.style.display).not.toBe('none');
    });

    test('reinstalls keyboard handling when a reusable modal is reopened', () => {
        const opener = document.createElement('button');
        document.body.append(opener);
        opener.focus();
        createModal({ id: 'mwt-reopen', title: 'Reopen', content: '<button>Action</button>', destroyOnClose: false });
        showModal('mwt-reopen');
        hideModal('mwt-reopen');
        showModal('mwt-reopen');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.getElementById('mwt-reopen').style.display).toBe('none');
    });

    test('restores focus to a valid opener and falls back when it is disabled', () => {
        const opener = document.createElement('button');
        document.body.append(opener);
        opener.focus();
        createModal({ id: 'mwt-focus', title: 'Focus', content: '<button>Action</button>' });
        showModal('mwt-focus');
        hideModal('mwt-focus');
        expect(document.activeElement).toBe(opener);

        opener.disabled = true;
        const replacement = document.createElement('button');
        document.body.append(replacement);
        replacement.focus();
        const modal = createModal({ id: 'mwt-focus-fallback', title: 'Fallback', content: '<button id="fallback-control">Action</button>' });
        showModal(modal.id);
        hideModal(modal.id);
        expect(document.activeElement).toBe(replacement);
    });

    test('uses the most recently shown modal as the stack top, not DOM order', () => {
        const olderInDom = createModal({ id: 'mwt-stack-b', title: 'B', content: '<button>B action</button>' });
        const newerInDom = createModal({ id: 'mwt-stack-a', title: 'A', content: '<button>A action</button>' });

        showModal(newerInDom.id);
        showModal(olderInDom.id);

        expect(olderInDom.querySelector('.mwt-modal-panel').getAttribute('aria-modal')).toBe('true');
        expect(newerInDom.querySelector('.mwt-modal-panel').getAttribute('aria-modal')).not.toBe('true');

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(olderInDom.style.display).toBe('none');
        expect(newerInDom.style.display).toBe('flex');
    });

    test('does not let a background modal trap Tab focus', () => {
        const background = createModal({ id: 'mwt-tab-background', title: 'Background', content: '<button id="background-first">First</button><button id="background-last">Last</button>' });
        const top = createModal({ id: 'mwt-tab-top', title: 'Top', content: '<button id="top-action">Top</button><button id="top-last">Last</button>' });

        showModal(background.id);
        showModal(top.id);
        background.querySelector('#background-last').focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));

        expect(document.activeElement).toBe(background.querySelector('#background-last'));
    });

    test('does not close for Escape while focus is inside a foreign dialog', () => {
        const modal = createModal({ id: 'mwt-foreign-dialog', title: 'MWT', content: '<button>Action</button>' });
        const foreign = document.createElement('div');
        foreign.setAttribute('role', 'dialog');
        foreign.innerHTML = '<button id="foreign-action">Foreign action</button>';
        document.body.append(foreign);
        showModal(modal.id);
        foreign.querySelector('#foreign-action').focus();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(modal.style.display).toBe('flex');
    });

    test('uses a genuinely focusable page target when the opener was detached', () => {
        const opener = document.createElement('button');
        document.body.append(opener);
        opener.focus();
        const modal = createModal({ id: 'mwt-detached-opener', title: 'Detached', content: '<button>Action</button>' });
        showModal(modal.id);
        opener.remove();
        hideModal(modal.id);

        expect(document.activeElement).not.toBe(modal.querySelector('.mwt-modal-close'));
        expect(document.activeElement).toBe(document.body);
    });
});