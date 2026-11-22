/** @vitest-environment jsdom */

// The 2.8.9 collapsible sections must stay usable once collapsed:
//  - Interiority rebuilds its whole tab (renderContent) after nearly every
//    panel action, so the user's open/closed choices must survive the rebuild
//    or a section snaps shut on every click inside it;
//  - the Settings tab's one Save button saves EVERY section, so it must never
//    sit inside a section the user can collapse away.

import { beforeEach, describe, expect, test } from 'vitest';

import { getFakeMeta, resetCoreStubs } from './stubs/core.js';
import { state, addManualLedgerEntry, getLedger, setLedgerEntryDormant } from '../interiority/data.js';
import { renderContent } from '../interiority/render.js';

import { renderGlobalSettingsForm } from '../core/settings_form.js';

/** A fresh modal shell with the Interiority tab rendered into it. */
function mountInteriorityTab() {
    document.body.innerHTML = '<div id="mwt-modal"><div class="mwt-tab-content" data-tab="interiority"></div></div>';
    state.modal = document.getElementById('mwt-modal');
    state.contentEl = null;
    renderContent();
    return state.modal;
}

/** Look a section up by its title, so the lookup survives a rebuild. */
const section = (root, title) => [...root.querySelectorAll('details.mwt-int-disclosure')]
    .find((d) => d.querySelector('summary').textContent.includes(title));

describe('Interiority disclosures', () => {
    beforeEach(() => {
        resetCoreStubs();
        addManualLedgerEntry({ npc: 'Elena', action: 'Call Dorothy', trigger: 'when the bank opens' });
        addManualLedgerEntry({ npc: 'Marcus', action: 'Check the crates', trigger: 'at the full moon' });
        setLedgerEntryDormant(getLedger()[1].id, 'the full moon');
    });

    test('a fresh tab opens Active Intentions and collapses the rest, each under a stable id', () => {
        const root = mountInteriorityTab();
        const sections = [...root.querySelectorAll('details.mwt-int-disclosure')];
        expect(sections.map((d) => d.id)).toEqual([
            'mwt-int-active-intentions',
            'mwt-int-deleted-intentions',
            'mwt-int-scheduled-intentions',
            'mwt-int-inner-states',
            'mwt-int-npc-controls',
            'mwt-int-lifecycle-history',
            'mwt-int-recent-thoughts',
        ]);
        expect(sections.filter((d) => d.open).map((d) => d.id)).toEqual(['mwt-int-active-intentions']);
    });

    test('a panel action keeps the sections the user opened and closed', () => {
        const root = mountInteriorityTab();
        section(root, 'Scheduled Intentions').open = true;
        section(root, 'Active Intentions').open = false;

        // ⏰ Wake re-renders the whole tab, like most panel actions.
        root.querySelector('#mwt-int-dormant-list .mwt-int-wake-btn').click();

        expect(getLedger().some((e) => e.status === 'dormant')).toBe(false);
        expect(section(root, 'Scheduled Intentions').open).toBe(true);
        expect(section(root, 'Active Intentions').open).toBe(false);
    });

    test('malformed imported displayActions cannot break the deleted intentions panel', () => {
        const meta = getFakeMeta();
        meta.mwt_interiority = {
            enabled: true,
            ledger: [],
            deletedIntentions: [{
                id: 'deleted-1',
                npc: 'Mara',
                actions: ['open the gate'],
                triggers: ['at dusk'],
                displayNpc: 'Mara',
                displayActions: { invalid: true },
            }],
        };

        const root = mountInteriorityTab();
        expect(root.querySelector('.mwt-int-deleted-entry').textContent).toContain('open the gate');
    });
});

describe('Settings workspace replaces global disclosures', () => {
    test('all seven sections stay mounted and global Save sits outside them', () => {
        const host = document.createElement('div');
        host.innerHTML = renderGlobalSettingsForm({});
        expect(host.querySelectorAll('details.mwt-settings-disclosure')).toHaveLength(0);
        expect(host.querySelectorAll('.mwt-settings-section')).toHaveLength(7);
        expect(host.querySelectorAll('.mwt-settings-section:not([hidden])')).toHaveLength(1);
        expect(host.querySelector('#mwt-s-save').closest('.mwt-settings-section')).toBeNull();
        expect(host.querySelector('#mwt-s-sync').closest('.mwt-settings-section').id).toBe('mwt-settings-section-connection');
        for (const id of ['mwt-s-save', 'mwt-s-sync']) {
            const button = host.querySelector(`#${id}`);
            expect(button, id).not.toBeNull();
            expect(button.closest('details'), id).toBeNull();
        }
    });
});
