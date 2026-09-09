/** @vitest-environment jsdom */

// Accessibility plan Slice 2 (§4.2, §6.3): the shared wireTablist() helper,
// its two consumers, and the decorative emoji hidden from assistive tech.
//
// The helper's contract is tested once here. The consumers get focused
// integration assertions instead of a duplicate contract: the Diagnostics
// strip is rendered and wired live, and the main tab bar — index.js performs
// its SillyTavern integration work at module top level, so it cannot be
// imported into Vitest — is exercised through the render/wire seam in
// core/main_tabs.js by test/main_tabbar_adoption.test.js (jsdom).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ariaHideEmoji, wireTablist } from '../core/ui.js';
import { DIAGNOSTICS_PANEL_TABS, renderDiagnosticsPanel, wireDiagnosticsPanel } from '../diagnostics_panel/render.js';

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

// ─── Fixture: a generic tab strip shaped like both consumers' ─────────────────

function buildStrip({ count = 3 } = {}) {
    const host = document.createElement('div');
    const buttons = Array.from({ length: count }, (_, i) =>
        `<button class="fx-tab ${i === 0 ? 'active' : ''}" data-tab="t${i}">Tab ${i + 1}</button>`)
        .join('');
    const panels = Array.from({ length: count }, (_, i) =>
        `<div class="fx-panel ${i === 0 ? 'active' : ''}" data-tab="t${i}"><input id="fx-field-${i}" value="original-${i}"></div>`)
        .join('');
    host.innerHTML = `<div class="fx-bar">${buttons}</div>${panels}`;
    document.body.append(host);
    return host;
}

function wireHost(host, opts = {}) {
    return wireTablist(host.querySelector('.fx-bar'), {
        tabSelector: '.fx-tab',
        panelSelector: '.fx-panel',
        scope: host,
        activeClass: 'active',
        idPrefix: 'fx',
        ...opts,
    });
}

function tabsOf(host) { return [...host.querySelectorAll('.fx-tab')]; }
function panelsOf(host) { return [...host.querySelectorAll('.fx-panel')]; }

// jsdom does not implement sequential focus navigation (§6.1), so keys are
// dispatched on the tab button and bubble to the tablist handler — the
// handler contract under test, not native traversal.
function press(key, el) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

// ─── wireTablist — markup contract ────────────────────────────────────────────

describe('wireTablist — markup contract', () => {
    test('stamps tablist/tab/tabpanel roles and pairs aria-controls both ways', () => {
        const host = buildStrip();
        const result = wireHost(host);
        expect(result).not.toBeNull();

        const bar = host.querySelector('.fx-bar');
        expect(bar.getAttribute('role')).toBe('tablist');
        expect(bar.getAttribute('aria-orientation')).toBe('horizontal');

        const tabs = tabsOf(host);
        const panels = panelsOf(host);
        tabs.forEach((tab, i) => {
            expect(tab.getAttribute('role')).toBe('tab');
            expect(tab.getAttribute('aria-controls')).toBe(panels[i].id);
            expect(panels[i].getAttribute('role')).toBe('tabpanel');
            expect(panels[i].getAttribute('aria-labelledby')).toBe(tab.id);
        });
    });

    test('generates stable ids when the markup ships none', () => {
        const host = buildStrip();
        wireHost(host);
        expect(tabsOf(host)[2].id).toBe('fx-tab-3');
        expect(panelsOf(host)[2].id).toBe('fx-panel-3');
        expect(panelsOf(host)[2].getAttribute('aria-labelledby')).toBe('fx-tab-3');
    });

    test('inactive tabs carry tabindex="-1" and inactive panels hidden; exactly one of each active', () => {
        const host = buildStrip();
        wireHost(host);
        const tabs = tabsOf(host);
        const panels = panelsOf(host);

        expect(tabs[0].getAttribute('tabindex')).toBe('0');
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
        expect(panels[0].hidden).toBe(false);
        for (let i = 1; i < tabs.length; i += 1) {
            expect(tabs[i].getAttribute('tabindex')).toBe('-1');
            expect(tabs[i].getAttribute('aria-selected')).toBe('false');
            expect(panels[i].hidden).toBe(true);
        }
        // The consumer's CSS hook class stays in sync with the ARIA state.
        expect(tabs[0].classList.contains('active')).toBe(true);
        expect(panels[0].classList.contains('active')).toBe(true);
        expect(tabs[1].classList.contains('active')).toBe(false);
    });
});

// ─── wireTablist — activation ─────────────────────────────────────────────────

describe('wireTablist — activation', () => {
    test('click selects exactly one tab and exposes exactly one panel', () => {
        const host = buildStrip({ count: 4 });
        wireHost(host);
        tabsOf(host)[2].click();

        const tabs = tabsOf(host);
        const panels = panelsOf(host);
        tabs.forEach((tab, i) => expect(tab.getAttribute('aria-selected')).toBe(String(i === 2)));
        panels.forEach((panel, i) => expect(panel.hidden).toBe(i !== 2));
        expect(tabs[2].classList.contains('active')).toBe(true);
        expect(panels[2].classList.contains('active')).toBe(true);
    });

    test('activation does not rebuild panels or lose unrelated field values', () => {
        const host = buildStrip();
        wireHost(host);
        host.querySelector('#fx-field-1').value = 'edited';
        const panelBefore = panelsOf(host)[1];

        tabsOf(host)[1].click();
        tabsOf(host)[0].click();
        tabsOf(host)[1].click();

        expect(panelsOf(host)[1]).toBe(panelBefore);
        expect(host.querySelector('#fx-field-1').value).toBe('edited');
    });

    test('repeated wiring of the same element does not accumulate duplicate handlers', () => {
        // §6.3: repeated renderModal() passes must not stack handlers. The
        // strip is re-created per render, but a surviving element wired twice
        // is the guard's worst case.
        const onActivate = vi.fn();
        const host = buildStrip();
        wireHost(host, { onActivate });
        wireHost(host, { onActivate });

        tabsOf(host)[1].click();
        expect(onActivate).toHaveBeenCalledTimes(1);

        press('ArrowRight', tabsOf(host)[1]);
        expect(onActivate).toHaveBeenCalledTimes(2);
    });
});

// ─── wireTablist — keyboard contract ──────────────────────────────────────────

describe('wireTablist — keyboard contract', () => {
    test('horizontal: ArrowRight/ArrowLeft move with wrap and automatic activation; Up/Down do nothing', () => {
        const host = buildStrip();
        wireHost(host);
        const [t0, t1, t2] = tabsOf(host);

        t0.focus();
        press('ArrowRight', t0);
        expect(t1.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(t1); // focus follows the roving tabindex
        expect(panelsOf(host)[0].hidden).toBe(true); // activation is automatic
        expect(panelsOf(host)[1].hidden).toBe(false);

        press('ArrowLeft', t1);
        expect(t0.getAttribute('aria-selected')).toBe('true');

        press('ArrowLeft', t0); // wraps first → last
        expect(t2.getAttribute('aria-selected')).toBe('true');

        press('ArrowRight', t2); // wraps last → first
        expect(t0.getAttribute('aria-selected')).toBe('true');

        press('ArrowDown', t0); // wrong axis for a horizontal strip
        expect(t0.getAttribute('aria-selected')).toBe('true');
        press('ArrowUp', t0);
        expect(t0.getAttribute('aria-selected')).toBe('true');
    });

    test('vertical: ArrowDown/ArrowUp navigate; Left/Right do nothing', () => {
        const host = buildStrip();
        wireHost(host, { orientation: 'vertical' });
        expect(host.querySelector('.fx-bar').getAttribute('aria-orientation')).toBe('vertical');

        const [t0, t1] = tabsOf(host);
        press('ArrowDown', t0);
        expect(t1.getAttribute('aria-selected')).toBe('true');

        press('ArrowUp', t1);
        expect(t0.getAttribute('aria-selected')).toBe('true');

        press('ArrowRight', t0); // wrong axis for a vertical strip
        expect(t0.getAttribute('aria-selected')).toBe('true');
    });

    test('Home and End work in both orientations', () => {
        for (const orientation of ['horizontal', 'vertical']) {
            const host = buildStrip();
            wireHost(host, { orientation });
            const tabs = tabsOf(host);

            press('End', tabs[0]);
            expect(tabs[2].getAttribute('aria-selected')).toBe('true');
            expect(document.activeElement).toBe(tabs[2]);

            press('Home', tabs[2]);
            expect(tabs[0].getAttribute('aria-selected')).toBe('true');
            expect(document.activeElement).toBe(tabs[0]);
            document.body.innerHTML = '';
        }
    });
});

// ─── ariaHideEmoji — decorative emoji in tab labels ───────────────────────────

describe('ariaHideEmoji', () => {
    test('hides the leading emoji of all eight main tab labels', () => {
        // Mirrors TABS in index.js (not importable in Vitest — see the file
        // header). If a label changes there, update this list.
        const labels = [
            '🌍 World State',
            '📜 Chronicle',
            '🧠 Knowledge',
            '🗺️ Story Planner',
            '💭 Interiority',
            '🩺 Diagnostics',
            '📊 Budget',
            '⚙️ Settings',
        ];
        for (const label of labels) {
            const [, emoji, rest] = label.match(/^(\S+)\s+(.*)$/u);
            // The separator space survives after the hidden span — the
            // visible label stays byte-identical to `label`.
            expect(ariaHideEmoji(label)).toBe(`<span aria-hidden="true">${emoji}</span> ${rest}`);
        }
        // The variation-selector cases (🗺️ = pictographic + FE0F) must survive
        // intact inside the hidden span, not be split — and the separator
        // space survives after the span too.
        expect(ariaHideEmoji('🗺️ Story Planner')).toBe('<span aria-hidden="true">🗺️</span> Story Planner');
    });

    test('hides the leading emoji of all seven diagnostics sub-tab labels, space intact', () => {
        for (const t of DIAGNOSTICS_PANEL_TABS) {
            // Hidden emoji span, then the preserved separator, then the name.
            expect(ariaHideEmoji(t.label)).toMatch(/^<span aria-hidden="true">\S+<\/span> \S/);
        }
    });

    test('leaves emoji-free labels unchanged', () => {
        expect(ariaHideEmoji('Settings')).toBe('Settings');
        expect(ariaHideEmoji('')).toBe('');
    });
});

// ─── Consumer: Diagnostics sub-tab strip ──────────────────────────────────────

describe('Diagnostics sub-tab strip (integration)', () => {
    const setup = () => {
        const host = document.createElement('div');
        host.innerHTML = renderDiagnosticsPanel();
        document.body.append(host);
        wireDiagnosticsPanel(host);
        return host;
    };

    test('the rendered strip satisfies the tab markup contract', () => {
        const host = setup();
        const bar = host.querySelector('.mwt-diag-tab-bar');
        expect(bar.getAttribute('role')).toBe('tablist');
        expect(bar.getAttribute('aria-orientation')).toBe('horizontal');

        const tabs = [...host.querySelectorAll('.mwt-diag-tab-btn')];
        const panes = [...host.querySelectorAll('.mwt-diag-tab-pane')];
        expect(tabs).toHaveLength(DIAGNOSTICS_PANEL_TABS.length);
        expect(panes).toHaveLength(DIAGNOSTICS_PANEL_TABS.length);

        tabs.forEach((tab, i) => {
            expect(tab.getAttribute('role')).toBe('tab');
            expect(tab.getAttribute('aria-controls')).toBe(panes[i].id);
            expect(panes[i].getAttribute('role')).toBe('tabpanel');
            expect(panes[i].getAttribute('aria-labelledby')).toBe(tab.id);
            expect(tab.getAttribute('aria-selected')).toBe(String(i === 0));
            expect(tab.getAttribute('tabindex')).toBe(i === 0 ? '0' : '-1');
            expect(panes[i].hidden).toBe(i !== 0);
        });
    });

    test('sub-tab label emoji are hidden from assistive technology', () => {
        const host = setup();
        const hidden = host.querySelectorAll('.mwt-diag-tab-btn span[aria-hidden="true"]');
        expect(hidden).toHaveLength(DIAGNOSTICS_PANEL_TABS.length);
    });

    test('click and arrow keys switch sub-tabs without rebuilding panes', () => {
        const host = setup();
        const envBtn = host.querySelector('.mwt-diag-tab-btn[data-diag-tab="environment"]');
        const envPane = host.querySelector('.mwt-diag-tab-pane[data-diag-tab="environment"]');

        envBtn.click();
        expect(envBtn.getAttribute('aria-selected')).toBe('true');
        expect(envPane.hidden).toBe(false);
        expect(host.querySelector('.mwt-diag-tab-pane[data-diag-tab="health"]').hidden).toBe(true);

        // Environment (index 1) → ArrowRight → scope (index 2).
        press('ArrowRight', envBtn);
        const scopeBtn = host.querySelector('.mwt-diag-tab-btn[data-diag-tab="scope"]');
        expect(scopeBtn.getAttribute('aria-selected')).toBe('true');
        expect(host.querySelector('.mwt-diag-tab-pane[data-diag-tab="scope"]').hidden).toBe(false);
        expect(envPane.hidden).toBe(true);

        // Switching never rebuilds pane nodes.
        envBtn.click();
        expect(host.querySelector('.mwt-diag-tab-pane[data-diag-tab="environment"]')).toBe(envPane);
    });
});
