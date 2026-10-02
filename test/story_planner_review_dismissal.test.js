/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getArcs, makeArc, setArcs, state } from '../story_planner/data.js';
import {
    closeScopedReviewModal, closeTargetedReviewModal, renderContent, showScopedReview, wireEvents,
} from '../story_planner/render.js';
import { saveSettings } from '../story_planner/settings.js';
import {
    captureScope, resetCoreStubs, setFakeApi, setFakeChat, setFakeContextExtras,
} from './stubs/core.js';

beforeEach(() => {
    resetCoreStubs();
    document.body.innerHTML = '<div data-tab="story-planner"></div>';
    setFakeContextExtras({ getCurrentChatId: () => 'review-dismissal' });
    vi.stubGlobal('SillyTavern', {
        getContext: () => ({ getCurrentChatId: () => 'review-dismissal' }),
    });
    state.modal = document.body;
    state.contentEl = document.querySelector('[data-tab="story-planner"]');
    state.scopedReviewOpen = false;
    state.targetedReviewOpen = false;
    state.isGenerating = false;
});

afterEach(() => {
    closeScopedReviewModal();
    closeTargetedReviewModal();
    state.modal = null;
    state.contentEl = null;
    vi.unstubAllGlobals();
});

function openScopedReview() {
    const arcs = [makeArc({ title: 'First draft', section: 'horizon' }),
        makeArc({ title: 'Second draft', section: 'horizon' })];
    showScopedReview({
        request: { operation: 'add', sectionKeys: ['horizon'], requestedCount: 2 },
        scope: captureScope(), previousArcs: [], arcs,
        addedArcIds: arcs.map(arc => arc.id), reviewArcIds: arcs.map(arc => arc.id),
        stats: { added: 2, matched: 0, carried: 0, suppressedClosed: 0 }, diagnostics: {},
    });
    return document.getElementById('mwt-sp-scoped-review-modal');
}

describe('Story Planner review backdrop safety', () => {
    test('outside clicks preserve the scoped draft and acceptance choices until Apply', () => {
        const modal = openScopedReview();
        const choices = modal.querySelectorAll('input[name="mwt-sp-proposal"]');
        choices[0].checked = false;

        modal.querySelector('.mwt-modal-backdrop').click();
        modal.querySelector('.mwt-modal-backdrop').click();

        expect(modal.isConnected).toBe(true);
        expect(modal.style.display).toBe('flex');
        expect(state.scopedReviewOpen).toBe(true);
        expect(choices[0].checked).toBe(false);
        expect(choices[1].checked).toBe(true);
        expect(getArcs()).toEqual([]);

        modal.querySelector('#mwt-sp-scoped-apply').click();
        expect(getArcs().map(arc => arc.title)).toEqual(['Second draft']);
        expect(modal.isConnected).toBe(false);
        expect(state.scopedReviewOpen).toBe(false);
    });

    test.each(['discard', 'close', 'escape'])('intentional scoped %s still dismisses without saving', method => {
        const modal = openScopedReview();
        if (method === 'escape') {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } else {
            modal.querySelector(method === 'discard'
                ? '#mwt-sp-scoped-discard' : '.mwt-modal-close').click();
        }
        expect(modal.isConnected).toBe(false);
        expect(state.scopedReviewOpen).toBe(false);
        expect(getArcs()).toEqual([]);
    });

    test('outside clicks preserve a targeted draft until explicit Discard', async () => {
        const source = makeArc({ title: 'Harbour pact', section: 'horizon', beats: ['Inspect the seal.'] });
        setArcs([source]);
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setFakeChat([
            { is_user: true, name: 'User', mes: 'We inspect the harbour records.' },
            { is_user: false, name: 'Mara', mes: 'The seals do not match.' },
            { is_user: true, name: 'User', mes: 'We question the clerk.' },
        ]);
        setFakeApi(() => JSON.stringify({
            title: source.title, description: 'The clerk reveals a forgery.',
            section: 'horizon', pendingBeats: ['Compare the original manifest.'],
        }));
        renderContent();
        wireEvents();
        document.querySelector(`[data-id="${source.id}"] [data-action="target-develop"]`).click();
        await vi.waitFor(() => expect(document.getElementById('mwt-sp-targeted-modal')).not.toBeNull());
        const modal = document.getElementById('mwt-sp-targeted-modal');

        modal.querySelector('.mwt-modal-backdrop').click();
        expect(modal.isConnected).toBe(true);
        expect(modal.style.display).toBe('flex');
        expect(state.targetedReviewOpen).toBe(true);
        expect(getArcs()).toEqual([source]);

        modal.querySelector('#mwt-sp-targeted-discard').click();
        expect(modal.isConnected).toBe(false);
        expect(state.targetedReviewOpen).toBe(false);
        expect(getArcs()).toEqual([source]);
    });
});