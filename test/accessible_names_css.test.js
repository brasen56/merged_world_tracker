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
