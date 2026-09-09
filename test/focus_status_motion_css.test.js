/**
 * Accessibility plan Slice 3 (§4.3 / §4.5) — stylesheet source contracts.
 *
 * Runs in the default Node environment (no DOM needed): these assertions
 * read the shipped stylesheets as text and pin the source contracts the
 * §6.5 manual QA depends on — no bare-element :focus-visible selectors
 * (they would restyle SillyTavern's host page), an outline-restoring pair
 * for every `outline: none`, and the reduced-motion block scoped past
 * .mwt-modal to the mwt-/kt- class prefixes.
 *
 * readFileSync + fileURLToPath is the test/schema_engine.test.js precedent;
 * the same reads do NOT work under jsdom (node builtins are externalized),
 * and CSS `?raw` imports come back as empty stubs there — which is why this
 * file exists separately from the jsdom Slice 3 tests in
 * test/focus_status_motion.test.js.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const read = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

// Strip /* … */ comments first: comments legitimately MENTION `outline: none`
// and selectors (this slice added several), and only real declarations count.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const sheets = {
    'core/style.css': stripComments(read('core/style.css')),
    'knowledge/style.css': stripComments(read('knowledge/style.css')),
    'chronicle/style.css': stripComments(read('chronicle/style.css')),
    'story_planner/style.css': stripComments(read('story_planner/style.css')),
};

describe('reduced-motion CSS (§4.5)', () => {
    test('ships the block scoped past the modal', () => {
        const block = sheets['core/style.css'].match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
        expect(block).not.toBeNull();
        const body = block[1];
        // Scope must reach the floating buttons, the countdown badge and the
        // kt- pulses — all outside .mwt-modal — via the class prefixes.
        for (const scope of [
            '[class^="mwt-"]', '[class*=" mwt-"]',
            '[class^="kt-"]', '[class*=" kt-"]',
            '.mwt-modal *', '.mwt-modal *::before', '.mwt-modal *::after',
        ]) {
            expect(body, `reduced-motion scope ${scope}`).toContain(scope);
        }
        for (const decl of [
            'animation-duration: 0.01ms !important',
            'animation-iteration-count: 1 !important',
            'scroll-behavior: auto !important',
            'transition-duration: 0.01ms !important',
        ]) {
            expect(body).toContain(decl);
        }
    });
});

describe('focus-visible scoping and pairing (§4.3)', () => {
    test('no MWT stylesheet ships a bare-element :focus-visible selector', () => {
        // A selector list entry that is a bare element (button:, input:, …)
        // would restyle focus across the whole host application.
        for (const [name, sheet] of Object.entries(sheets)) {
            expect(sheet, name).not.toMatch(/(^|\n)\s*(button|input|textarea|select|a|summary|details):focus-visible/);
        }
    });

    test('every outline: none declaration has at least one :focus-visible pair in its sheet', () => {
        const count = (s, re) => (s.match(re) || []).length;
        // The verified plan baseline: core 1, knowledge 10, chronicle 4, story 4.
        const expected = {
            'core/style.css': 1,
            'knowledge/style.css': 10,
            'chronicle/style.css': 4,
            'story_planner/style.css': 4,
        };
        for (const [name, sheet] of Object.entries(sheets)) {
            const suppressed = count(sheet, /outline:\s*none/g);
            expect(suppressed, `${name} outline:none count drifted from the plan baseline`)
                .toBe(expected[name]);
            const pairs = count(sheet, /:focus-visible/g);
            expect(pairs, `${name}: every suppressed outline needs a pair`)
                .toBeGreaterThanOrEqual(suppressed);
        }
    });

    test('the shared rule is scoped to MWT surfaces only', () => {
        for (const selector of [
            '.mwt-modal button:focus-visible',
            '.mwt-input:focus-visible',
            '.mwt-btn:focus-visible',
            '.mwt-float-btn:focus-visible',
            '[class^="kt-"]:focus-visible',
        ]) {
            expect(sheets['core/style.css']).toContain(selector);
        }
    });
});
