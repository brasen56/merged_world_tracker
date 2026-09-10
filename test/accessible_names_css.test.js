/**
 * Accessibility plan Slice 4 — stylesheet source contracts.
 *
 * Runs in the default Node environment (no DOM needed), the same split as
 * test/focus_status_motion_css.test.js: CSS `?raw` imports come back as empty
 * stubs under jsdom, so the sr-only utility's contract is pinned here against
 * the shipped stylesheet text instead of in the jsdom Slice 4 tests in
 * test/accessible_names.test.js.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const read = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const coreCss = stripComments(read('core/style.css'));
const interiorityCss = stripComments(read('interiority/style.css'));
const budgetCss = stripComments(read('budget/style.css'));

describe('.mwt-sr-only (Slice 4 item 5)', () => {
    test('the utility exists and is hidden without display:none', () => {
        const rule = coreCss.match(/\.mwt-sr-only\s*\{([^}]*)\}/);
        expect(rule).not.toBeNull();
        const body = rule[1];
        // The clip pattern, not display:none/visibility:hidden: the text must
        // stay in the accessibility tree so the color/emoji-only indicators it
        // backs up remain announceable.
        expect(body).toMatch(/position:\s*absolute/);
        expect(body).toMatch(/clip(?:-path)?:/);
        expect(body).not.toMatch(/display:\s*none/);
        expect(body).not.toMatch(/visibility:\s*hidden/);
        // 1px box so it cannot affect layout of the rows it annotates.
        expect(body).toMatch(/width:\s*1px/);
        expect(body).toMatch(/height:\s*1px/);
    });
});

describe('visible edit-form help (Slice 4 item 3)', () => {
    test('interiority ships the .mwt-int-edit-help style for the former tooltip-only explanations', () => {
        const rule = interiorityCss.match(/\.mwt-int-edit-help\s*\{([^}]*)\}/);
        expect(rule).not.toBeNull();
        expect(rule[1]).toMatch(/font-size:\s*11px/);
    });
});

// Slice 4 scope-miss follow-up (budget/panel.js + the per-NPC help dedup):
// the new visible-help and structural styles the sweep relies on.

describe('budget pane help styles (Slice 4 scope-miss follow-up)', () => {
    test('the visible help block, plan reason, and bar note styles exist', () => {
        for (const selector of ['.mwt-budget-help', '.mwt-budget-help p', '.mwt-budget-plan-reason', '.mwt-budget-bar-note']) {
            const rule = budgetCss.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`));
            expect(rule, selector).not.toBeNull();
        }
    });

    test('the scope="row" module cell overrides the shared header-cell chrome', () => {
        // The shared .mwt-diag-health-table th rule styles column headers
        // (10px uppercase dim); a row header is data and must not inherit it.
        const rule = budgetCss.match(/\.mwt-budget-table th\[scope="row"\]\s*\{([^}]*)\}/);
        expect(rule).not.toBeNull();
        expect(rule[1]).toMatch(/text-transform:\s*none/);
        expect(rule[1]).toMatch(/font-size:\s*12px/);
        // The idle-row dimming covers the row header too (it is a th now).
        expect(budgetCss).toMatch(/\.mwt-budget-row--idle td,\s*\n?\s*\.mwt-budget-row--idle th\s*\{/);
    });
});

describe('interiority per-NPC fieldset and help-group styles (Slice 4 follow-up)', () => {
    test('the fieldset resets its user-agent chrome and the name line keeps the shared flex rule', () => {
        const reset = interiorityCss.match(/fieldset\.mwt-int-controls-row\s*\{([^}]*)\}/);
        expect(reset).not.toBeNull();
        // A fieldset's UA margin and min-width: min-content would both break
        // the row; border/padding/background come from .mwt-int-controls-row.
        expect(reset[1]).toMatch(/margin:\s*0/);
        expect(reset[1]).toMatch(/min-width:\s*0/);
        // No bespoke legend rule: the name line reuses .mwt-int-ledger-entry-main,
        // which is a real flex item (a rendered legend is not — see the
        // markup test in accessible_names.test.js).
        expect(interiorityCss).not.toMatch(/\.mwt-int-controls-legend\s*\{/);
        const nameLine = interiorityCss.match(/\.mwt-int-ledger-entry-main\s*\{([^}]*)\}/);
        expect(nameLine).not.toBeNull();
        expect(nameLine[1]).toMatch(/flex:\s*1 1 240px/);
    });

    test('the once-rendered help group exists and the per-snippet rule no longer flexes inside a row', () => {
        expect(interiorityCss).toMatch(/\.mwt-int-ctl-help-group\s*\{/);
        const help = interiorityCss.match(/\.mwt-int-ctl-help\s*\{([^}]*)\}/);
        expect(help).not.toBeNull();
        expect(help[1]).not.toMatch(/flex-basis/);
    });
});
