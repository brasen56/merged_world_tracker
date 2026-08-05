/**
 * test/strip.test.js — Tests for core/strip.js
 *
 * strip.js is another pure module — no SillyTavern dependencies. The two
 * functions remove "non-narrative" blocks (preset trackers, image-gen
 * markers) from message text before it's fed to scanners.
 *
 * These tests are slightly different in style from diff.test.js: they use
 * `beforeEach` to reset shared state (even though strip.js doesn't have any,
 * it's a good habit to demonstrate). They also show off `.toMatch()` for
 * regex assertions.
 */

import { describe, test, expect } from 'vitest';
import { stripNonNarrative, stripNonNarrativeFromFormatted } from '../core/strip.js';

// A module-level `describe` with a `beforeEach` inside it. The beforeEach runs
// before EACH `test` in this block. strip.js has no state to reset, but if it
// did, this is where we'd call a reset function.
describe('stripNonNarrative', () => {

    test('returns the input unchanged when there is nothing to strip', () => {
        // ARRANGE
        const text = 'Mara walked into the tavern.';
        // ACT
        const result = stripNonNarrative(text);
        // ASSERT: plain narrative text passes through untouched.
        expect(result).toBe('Mara walked into the tavern.');
    });

    test('removes a single details block', () => {
        // ARRANGE: a narrative sentence wrapping a collapsible tracker block.
        const text = 'Hello there.\n<details><summary>Tracker</summary>stuff</details>\nBye.';
        // ACT
        const result = stripNonNarrative(text);
        // ASSERT: the details block is gone, narrative text remains.
        expect(result).not.toContain('<details>');
        expect(result).not.toContain('Tracker');
        expect(result).toContain('Hello there.');
        expect(result).toContain('Bye.');
    });

    test('removes multiple details blocks', () => {
        const text = [
            '<details>block one</details>',
            'narrative',
            '<details class="x">block two</details>',
        ].join('\n');
        const result = stripNonNarrative(text);
        expect(result).not.toContain('block one');
        expect(result).not.toContain('block two');
        expect(result).toContain('narrative');
    });

    test('removes GFX image-gen marker blocks', () => {
        // ARRANGE: the special image-generation comment markers.
        const text = 'Story text\n<!-- GFX_START --><img src="x.png"><!-- GFX_END -->\nMore story';
        // ACT
        const result = stripNonNarrative(text);
        // ASSERT: the GFX block is stripped, story text stays.
        expect(result).not.toContain('GFX_START');
        expect(result).not.toContain('x.png');
        expect(result).toContain('Story text');
        expect(result).toContain('More story');
    });

    test('preserves in-story time tags', () => {
        // ARRANGE: [In-story time: ...] tags must survive stripping — they are
        // the canonical clock the world-state scanner reads.
        const text = 'They met at dawn. [In-story time: Day 3, 06:00]\n<details>tracker</details>';
        // ACT
        const result = stripNonNarrative(text);
        // ASSERT: the time tag is still there; the details block is gone.
        expect(result).toContain('[In-story time: Day 3, 06:00]');
        expect(result).not.toContain('<details>');
    });

    test('collapses excessive blank lines left by removals', () => {
        // ARRANGE: removing a block can leave big gaps of whitespace behind.
        const text = 'Before.\n\n\n\n\n<details>x</details>\n\n\n\nAfter.';
        // ACT
        const result = stripNonNarrative(text);
        // ASSERT: no run of 3+ newlines survives the collapse.
        expect(result).not.toMatch(/\n{3,}/);
    });

    test('handles null / undefined / non-string input gracefully', () => {
        // The guard clauses in stripNonNarrative return '' for falsy input
        // and pass through non-strings. Both edge cases are pinned here.
        expect(stripNonNarrative(null)).toBe('');
        expect(stripNonNarrative(undefined)).toBe('');
        expect(stripNonNarrative('')).toBe('');
    });
});

describe('stripNonNarrativeFromFormatted', () => {

    test('preserves the speaker name prefix while stripping the body', () => {
        // ARRANGE: a "Name: text" line with a details block in the body.
        const line = 'Mara: Hello there <details>secret tracker data</details>';
        // ACT
        const result = stripNonNarrativeFromFormatted(line);
        // ASSERT: the "Mara: " prefix is intact, the details block is gone.
        expect(result).toMatch(/^Mara:\s/);
        expect(result).toContain('Hello there');
        expect(result).not.toContain('<details>');
        expect(result).not.toContain('secret tracker data');
    });

    test('falls back to plain strip when no "Name: " prefix is present', () => {
        // ARRANGE: a line with no colon-space separator.
        const line = 'just some text <details>x</details>';
        // ACT
        const result = stripNonNarrativeFromFormatted(line);
        // ASSERT: the whole line is treated as the body and stripped.
        expect(result).not.toContain('<details>');
        expect(result).toContain('just some text');
    });

    test('only splits on the FIRST colon-space (names with colons)', () => {
        // ARRANGE: a speaker whose line body itself contains a colon.
        // The function should split at "Mara: " only, leaving the body's
        // colon intact.
        const line = 'Mara: Time: 12:00 <details>x</details>';
        // ACT
        const result = stripNonNarrativeFromFormatted(line);
        // ASSERT: "Mara:" prefix, then the body with its colons minus the block.
        expect(result.startsWith('Mara:')).toBe(true);
        expect(result).toContain('Time: 12:00');
        expect(result).not.toContain('<details>');
    });
});