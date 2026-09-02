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

    test('preserves Off-Screen Events module blocks (execution evidence)', () => {
        // ARRANGE: the off-screen module records completed off-screen NPC
        // actions; the interiority tracker must see those lines to mark the
        // matching ledger intentions "executed", so the block survives.
        const text = 'Mara waved.\n<details>\n    <summary>📡 <b>Off-Screen Events</b></summary>\n\n    - Tomas → moved the ledger to the safe (office; 9:40 PM; unwitnessed)\n\n    </details>\n[In-story time: 9:45 PM, Friday, June 6, 2025]';
        // ACT
        const result = stripNonNarrative(text);
        // ASSERT: the off-screen block and its log line survive; narrative
        // and time tag also survive.
        expect(result).toContain('Off-Screen Events');
        expect(result).toContain('moved the ledger to the safe');
        expect(result).toContain('Mara waved.');
        expect(result).toContain('[In-story time:');
    });

    test('still removes ordinary tracker blocks alongside a preserved off-screen block', () => {
        // ARRANGE: one work-progress dashboard + one off-screen module.
        const text = 'Story.\n<details><summary>🗂️ <b>Work In Progress</b></summary>dashboard</details>\n<details><summary>📡 <b>Off-Screen Events</b></summary>- Tomas → burned the letters</details>';
        // ACT
        const result = stripNonNarrative(text);
        // ASSERT: the dashboard is stripped, the off-screen log survives.
        expect(result).not.toContain('dashboard');
        expect(result).not.toContain('Work In Progress');
        expect(result).toContain('burned the letters');
    });

    test('strips a tracker that only mentions off-screen in its body, not its summary', () => {
        // ARRANGE: legacy Scene State format — an "Off-Screen:" SECTION in
        // the body. Only the summary identifies the off-screen module, so
        // this block must still be stripped.
        const text = 'Story.\n<details>\n<summary>📌 <b>Scene State</b></summary>\n📡 Off-Screen:\n- Tomas — plotting at home\n</details>';
        // ACT
        const result = stripNonNarrative(text);
        // ASSERT: the whole block is gone.
        expect(result).not.toContain('<details>');
        expect(result).not.toContain('plotting at home');
    });

    test('preserveOffScreen:false strips the off-screen block too (Knowledge opt-out)', () => {
        // ARRANGE: v2.1.1 — Knowledge prompts carry no
        // actor/witness semantics for the sealed log, so they must be able
        // to strip it like any other details block.
        const text = 'Story.\n<details><summary>📡 <b>Off-Screen Events</b></summary>- Tomas → burned the letters (unwitnessed)</details>';
        // ACT
        const result = stripNonNarrative(text, { preserveOffScreen: false });
        // ASSERT: the sealed log is gone; narrative survives.
        expect(result).not.toContain('<details>');
        expect(result).not.toContain('burned the letters');
        expect(result).toContain('Story.');
    });

    test('preserveOffScreen:false keeps stripping ordinary trackers and keeps time tags', () => {
        // ARRANGE: the opt-out must not change any other stripping rule.
        const text = 'They met at dawn. [In-story time: Day 3, 06:00]\n<details><summary>Tracker</summary>secret</details>';
        // ACT
        const result = stripNonNarrative(text, { preserveOffScreen: false });
        // ASSERT
        expect(result).toContain('[In-story time: Day 3, 06:00]');
        expect(result).not.toContain('secret');
    });

    test('an explicit preserveOffScreen:true behaves like the default', () => {
        // ARRANGE / ACT / ASSERT: history-ingest consumers (world state,
        // chronicle, story planner, interiority) keep the block by default.
        const text = 'Story.\n<details><summary>Off-Screen Events</summary>- Mara → hid the key</details>';
        expect(stripNonNarrative(text, { preserveOffScreen: true })).toContain('hid the key');
        expect(stripNonNarrative(text)).toContain('hid the key');
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

    test('preserves an off-screen block inside a formatted "Name: text" line', () => {
        // ARRANGE: a narrator message carrying an off-screen module block.
        const line = 'Narrator: Prose here <details><summary>📡 <b>Off-Screen Events</b></summary>- Mara → hid the key</details>';
        // ACT
        const result = stripNonNarrativeFromFormatted(line);
        // ASSERT: prefix intact, off-screen log line intact.
        expect(result.startsWith('Narrator:')).toBe(true);
        expect(result).toContain('Prose here');
        expect(result).toContain('hid the key');
    });

    test('forwards preserveOffScreen:false to the body strip', () => {
        // ARRANGE: same line, but the Knowledge-style opt-out.
        const line = 'Narrator: Prose here <details><summary>📡 <b>Off-Screen Events</b></summary>- Mara → hid the key</details>';
        // ACT
        const result = stripNonNarrativeFromFormatted(line, { preserveOffScreen: false });
        // ASSERT: prefix intact, sealed log stripped.
        expect(result.startsWith('Narrator:')).toBe(true);
        expect(result).toContain('Prose here');
        expect(result).not.toContain('hid the key');
    });
});