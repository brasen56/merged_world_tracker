/**
 * core/main_tabs.js — The main modal's tab shell: render + wire seam.
 *
 * The tab-bar markup and the wireTablist() call renderModal() uses live here
 * instead of inline in index.js, so the exact rendering/wiring path the main
 * tab bar goes through can be exercised under jsdom — index.js does its
 * SillyTavern integration work at module top level (event hooks, the MWT
 * bridge, slash-command registration), so it cannot be imported into Vitest
 * the way diagnostics_panel/render.js can. test/main_tabbar_adoption.test.js
 * drives this seam directly (accessibility plan §4.2 / §6.3).
 */

import { wireTablist, ariaHideEmoji } from './ui.js';

/**
 * Render the main modal's tab shell: the tab bar plus one panel per tab,
 * wrapped around per-tab content supplied by the caller.
 *
 * Ships the structural ARIA only (role=tablist/tab/tabpanel, the
 * aria-controls / aria-labelledby pairs through stable ids, the roving
 * tabindex, hidden on inactive panels) — wireTablist() re-stamps and
 * maintains the full contract at wire time (see wireMainTabBar).
 *
 * @param {Array<{id: string, label: string}>} tabs — ordered tab definitions
 * @param {(tab: {id: string}) => string} buildContent — returns one tab's
 *        panel HTML (index.js's buildTabContent)
 * @returns {string} HTML string for the modal body
 */
export function renderMainTabShell(tabs, buildContent) {
    const tabBarHtml = tabs.map((t, i) =>
        `<button id="mwt-tab-${t.id}" class="mwt-tab-btn ${i === 0 ? 'active' : ''}" role="tab"`
        + ` aria-selected="${i === 0}" aria-controls="mwt-tabpanel-${t.id}" tabindex="${i === 0 ? 0 : -1}"`
        + ` data-tab="${t.id}">${ariaHideEmoji(t.label)}</button>`
    ).join('');

    const tabContentsHtml = tabs.map((t, i) =>
        `<div id="mwt-tabpanel-${t.id}" class="mwt-tab-content ${i === 0 ? 'active' : ''}" role="tabpanel"`
        + ` aria-labelledby="mwt-tab-${t.id}"${i === 0 ? '' : ' hidden'} data-tab="${t.id}">${buildContent(t)}</div>`
    ).join('');

    return `
        <div class="mwt-tab-bar" role="tablist" aria-orientation="horizontal">${tabBarHtml}</div>
        ${tabContentsHtml}
    `;
}

/**
 * Wire a tab shell rendered by renderMainTabShell() through the shared
 * wireTablist() helper with the main modal's exact selectors.
 *
 * The modal body is rebuilt on every open and chat change, so this runs on
 * every render; the helper binds on the (fresh) tab bar itself behind a
 * once-per-element flag, so repeated renders can neither drop the handlers
 * nor stack duplicates.
 *
 * @param {Element} scope — element containing the .mwt-tab-bar (the modal)
 * @returns {object|null} wireTablist()'s select handle, or null when there is
 *          nothing to wire
 */
export function wireMainTabBar(scope) {
    return wireTablist(scope.querySelector('.mwt-tab-bar'), {
        orientation: 'horizontal',
        tabSelector: '.mwt-tab-btn',
        // Top-level panels only — the Diagnostics panel inside the
        // diagnostics tab runs its own strip (mwt-diag-tab-pane).
        panelSelector: '.mwt-tab-content',
        scope,
        activeClass: 'active',
        idPrefix: 'mwt-tablist',
    });
}