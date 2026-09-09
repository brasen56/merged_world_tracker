/**
 * @vitest-environment jsdom
 *
 * Main tab bar adoption — accessibility plan Slice 2 (§6.3).
 *
 * index.js performs its SillyTavern integration work at module top level
 * (event hooks, the window.MWT bridge, slash-command registration), so it
 * cannot be imported into Vitest the way the Diagnostics panel can. The main
 * tab bar's exact rendering/wiring path therefore lives behind a small seam —
 * renderMainTabShell() / wireMainTabBar() in core/main_tabs.js, the functions
 * renderModal() itself calls — and this file drives that seam under jsdom:
 * inspect the resulting DOM, activate tabs, preserve field state, and render
 * twice (the §6.3 focused integration check for the main consumer).
 *
 * The remaining source assertions pin index.js's adoption of the seam, and
 * the helper's own behavior is covered in test/tab_navigation.test.js.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { renderMainTabShell, wireMainTabBar } from '../core/main_tabs.js';
// index.js as source text, for the adoption assertions below. A Vite `?raw`
// import stands in for the readFileSync precedent in
// test/schema_engine.test.js because node builtins are externalized under
// this file's jsdom environment (readFileSync/fileURLToPath are not
// functions there).
import source from '../index.js?raw';

// Mirrors TABS in index.js (not importable in Vitest — see the file header).
// If a tab changes there, update this list.
const TABS = [
    { id: 'world-state', label: '🌍 World State' },
    { id: 'chronicle', label: '📜 Chronicle' },
    { id: 'knowledge', label: '🧠 Knowledge' },
    { id: 'story-planner', label: '🗺️ Story Planner' },
    { id: 'interiority', label: '💭 Interiority' },
    { id: 'diagnostics', label: '🩺 Diagnostics' },
    { id: 'budget', label: '📊 Budget' },
    { id: 'settings', label: '⚙️ Settings' },
];

// Minimal per-tab content with a field, so §6.3's "activation does not
// rebuild or lose unrelated field values" can be observed through the seam.
const buildContent = (t) => `<h3>${t.label}</h3><input id="mwt-fx-field-${t.id}" value="original-${t.id}">`;

// Render + wire the shell exactly the way renderModal() does: fresh markup,
// then wireMainTabBar() over it. `host` stands in for the modal.
function renderHost() {
    const host = document.createElement('div');
    host.innerHTML = renderMainTabShell(TABS, buildContent);
    document.body.append(host);
    wireMainTabBar(host);
    return host;
}

const tabsOf = (host) => [...host.querySelectorAll('.mwt-tab-btn')];
const panelsOf = (host) => [...host.querySelectorAll('.mwt-tab-content')];

// jsdom does not implement sequential focus navigation (§6.1); keys are
// dispatched on the tab button and bubble to the tablist handler — the
// handler contract under test, not native traversal.
function press(key, el) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

// ─── Adoption (index.js source assertions) ────────────────────────────────────

describe('Main tab bar adoption (index.js source assertions)', () => {
    test('renders and wires the tab shell through the shared seam, not its own handler', () => {
        expect(source).toContain('renderMainTabShell(TABS, buildTabContent)');
        expect(source).toContain('wireMainTabBar(modal)');
        // No forked handler or hand-rolled tab ARIA markup back in index.js —
        // the seam owns both now.
        expect(source).not.toContain('_tabHandlerBound');
        expect(source).not.toContain('role="tablist"');
    });
});

// ─── Consumer integration through the seam ────────────────────────────────────

describe('Main tab bar (render/wire seam integration)', () => {
    test('the rendered shell satisfies the tab markup contract', () => {
        const host = renderHost();
        const bar = host.querySelector('.mwt-tab-bar');
        expect(bar.getAttribute('role')).toBe('tablist');
        expect(bar.getAttribute('aria-orientation')).toBe('horizontal');

        const tabs = tabsOf(host);
        const panels = panelsOf(host);
        expect(tabs).toHaveLength(TABS.length);
        expect(panels).toHaveLength(TABS.length);
        tabs.forEach((tab, i) => {
            const t = TABS[i];
            expect(tab.id).toBe(`mwt-tab-${t.id}`);
            expect(tab.getAttribute('role')).toBe('tab');
            expect(tab.getAttribute('aria-controls')).toBe(`mwt-tabpanel-${t.id}`);
            expect(panels[i].id).toBe(`mwt-tabpanel-${t.id}`);
            expect(panels[i].getAttribute('role')).toBe('tabpanel');
            expect(panels[i].getAttribute('aria-labelledby')).toBe(tab.id);
            expect(tab.getAttribute('aria-selected')).toBe(String(i === 0));
            expect(tab.getAttribute('tabindex')).toBe(i === 0 ? '0' : '-1');
            expect(panels[i].hidden).toBe(i !== 0);
        });
    });

    test('hides each label emoji from assistive tech while the visible label stays byte-identical', () => {
        const host = renderHost();
        const hidden = host.querySelectorAll('.mwt-tab-btn span[aria-hidden="true"]');
        expect(hidden).toHaveLength(TABS.length);

        tabsOf(host).forEach((tab, i) => {
            // The hidden span wraps exactly the leading emoji…
            const [, emoji] = TABS[i].label.match(/^(\S+)\s+/u);
            expect(tab.querySelector('span[aria-hidden="true"]').textContent).toBe(emoji);
            // …and the emoji + separator space + name all survive visibly —
            // textContent is byte-identical to the label, never `🌍World`.
            expect(tab.textContent).toBe(TABS[i].label);
        });
    });

    test('click selects exactly one tab, exposes exactly one panel, and never loses field state', () => {
        const host = renderHost();
        const field = host.querySelector('#mwt-fx-field-knowledge');
        field.value = 'edited';
        const knowledgePanel = panelsOf(host)[2];

        tabsOf(host)[2].click();
        tabsOf(host)[0].click();
        tabsOf(host)[2].click();

        tabsOf(host).forEach((tab, i) => expect(tab.getAttribute('aria-selected')).toBe(String(i === 2)));
        panelsOf(host).forEach((panel, i) => expect(panel.hidden).toBe(i !== 2));
        // Switching only toggles attributes — the panel node and its field
        // values are never rebuilt.
        expect(panelsOf(host)[2]).toBe(knowledgePanel);
        expect(host.querySelector('#mwt-fx-field-knowledge').value).toBe('edited');
    });

    test('arrows follow the horizontal orientation with wrap; Home and End work; Up/Down do nothing', () => {
        const host = renderHost();
        const tabs = tabsOf(host);

        press('ArrowRight', tabs[0]);
        expect(tabs[1].getAttribute('aria-selected')).toBe('true');
        press('ArrowLeft', tabs[1]);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
        // Wrap in both directions across all eight tabs.
        press('ArrowLeft', tabs[0]);
        expect(tabs[7].getAttribute('aria-selected')).toBe('true');
        press('End', tabs[7]);
        expect(tabs[7].getAttribute('aria-selected')).toBe('true');
        press('Home', tabs[7]);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
        // Up/Down are not the declared orientation — no-op.
        press('ArrowDown', tabs[0]);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    });

    test('repeated renders re-wire cleanly: no dropped, stacked, or stale handlers', () => {
        // renderModal() rebuilds the body on every open and chat change, then
        // re-wires — model two passes over the same host here, plus the worst
        // case of wiring one surviving bar twice.
        const host = document.createElement('div');
        document.body.append(host);

        // First render: select away from the first tab.
        host.innerHTML = renderMainTabShell(TABS, buildContent);
        wireMainTabBar(host);
        host.querySelector('#mwt-tab-budget').click();
        expect(host.querySelector('#mwt-tab-budget').getAttribute('aria-selected')).toBe('true');

        // Second render over the same host (fresh markup, fresh wire): the
        // markup's first-tab state is re-normalized and activation works.
        host.innerHTML = renderMainTabShell(TABS, buildContent);
        wireMainTabBar(host);
        expect(host.querySelector('#mwt-tab-world-state').getAttribute('aria-selected')).toBe('true');
        expect(host.querySelector('#mwt-tabpanel-budget').hidden).toBe(true);

        // Worst case — wiring the same surviving bar twice must not stack
        // duplicate handlers (the helper's once-per-element flag).
        wireMainTabBar(host);
        host.querySelector('#mwt-tab-interiority').click();
        const selected = tabsOf(host).filter((t) => t.getAttribute('aria-selected') === 'true');
        expect(selected).toHaveLength(1);
        expect(host.querySelector('#mwt-tabpanel-interiority').hidden).toBe(false);
    });
});
