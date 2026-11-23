/** @vitest-environment jsdom */

/**
 * test/auto_consolidation_modal.test.js — refreshOpenGrowthModal, the Growth
 * window refresh the auto-consolidation driver fires after a pass lands.
 *
 * The refresh arrives unprompted (2026-11-22 review): rebuilding the content
 * area while the user is mid-action handed busy buttons back as clickable,
 * hid the Catch Up progress panel, and wiped a copy-only Psychoanalyze
 * portrait (an in-flight one landed in detached nodes). It must rebuild only
 * when nothing would be lost, and otherwise update the counts line and say
 * the list is out of date.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resetCoreStubs, setFakeChat } from './stubs/core.js';
import { saveSettings } from '../knowledge/settings.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { appendRawObservations } from '../knowledge/evidence.js';
import { refreshOpenGrowthModal } from '../knowledge/render.js';

function buildModal(npc, contentHtml) {
    const modal = document.createElement('div');
    modal.id = 'kt-growth-modal';
    modal.dataset.npc = npc;
    modal.innerHTML = `
        <div class="kt-growth-status"><span class="kt-growth-status-text">stale counts</span></div>
        <div class="kt-growth-content">${contentHtml}<div id="marker">original content</div></div>
        <div class="mwt-modal-statusbar"><span class="mwt-status" role="status"></span></div>`;
    document.body.appendChild(modal);
    return modal;
}

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveSettings({ scope: 'global' });
    _setCacheForTests('Knowledge Tracker', { registry: { Mara: { uid: 7, type: 'major', entityId: 'ent-mara', aliases: [] } } });
    setFakeChat([{ name: 'Mara', mes: 'x', send_date: 1000 }]);
    appendRawObservations('Mara', [
        { category: 'trait', claim: 'Keeps watch', quote: 'takes watch', msgIdx: 0 },
        { category: 'trait', claim: 'Speaks softly', quote: 'whispers', msgIdx: 0 },
    ]);
});
afterEach(() => {
    document.body.innerHTML = '';
    _clearCacheForTests();
});

describe('refreshOpenGrowthModal', () => {
    test('no modal, or a modal for another NPC → no-op', async () => {
        expect(await refreshOpenGrowthModal('Mara')).toBe(false);
        buildModal('Bob', '');
        expect(await refreshOpenGrowthModal('Mara')).toBe(false);
        expect(document.querySelector('#marker')).not.toBeNull();
        expect(document.querySelector('.kt-growth-status-text').textContent).toBe('stale counts');
    });

    test.each([
        ['an action is in flight (busy button)', '<button id="kt-growth-psychoanalyze" aria-busy="true" disabled>Analyzing…</button>'],
        ['a Psychoanalyze portrait is on screen', '<textarea id="kt-growth-psychoanalyze-text">portrait text</textarea>'],
    ])('keeps the content when %s, but updates the counts and says so', async (_label, html) => {
        const modal = buildModal('Mara', html);
        expect(await refreshOpenGrowthModal('Mara', 'Auto-consolidation: +1 claim.')).toBe(false);
        expect(modal.querySelector('#marker')).not.toBeNull();
        expect(modal.querySelector('.kt-growth-status-text').textContent).toMatch(/2 raw/);
        expect(modal.querySelector('.mwt-status').textContent).toMatch(/Auto-consolidation: \+1 claim\. .*out of date/);
    });

    test('keeps the content while focus is inside it (inline edit / keyboard position)', async () => {
        const modal = buildModal('Mara', '<div class="kt-growth-obs-claim" contenteditable="true" tabindex="0">editing</div>');
        modal.querySelector('.kt-growth-obs-claim').focus();
        expect(document.activeElement.classList.contains('kt-growth-obs-claim')).toBe(true);
        expect(await refreshOpenGrowthModal('Mara')).toBe(false);
        expect(modal.querySelector('#marker')).not.toBeNull();
    });

    test('rebuilds the content when nothing would be lost', async () => {
        const modal = buildModal('Mara', '<button id="kt-growth-capture" aria-busy="false">Capture</button>');
        expect(await refreshOpenGrowthModal('Mara', 'Auto-consolidation: +1 claim.')).toBe(true);
        expect(modal.querySelector('#marker')).toBeNull();
        expect(modal.querySelector('#kt-growth-consolidate')).not.toBeNull();
    });
});
