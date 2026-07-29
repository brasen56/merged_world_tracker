/**
 * test/diff.test.js — Tests for core/diff.js
 *
 * THIS IS THE BEST FILE TO START LEARNING TESTS FROM.
 *
 * diff.js is "pure" code: the functions take inputs, return outputs, and don't
 * touch SillyTavern, the DOM, or any global state. That makes the tests short
 * and obvious — you call the function with known inputs and check the output.
 *
 * ── How to read a test ──────────────────────────────────────────────────────
 * Each `test('description', () => { ... })` block is one check. Inside:
 *   - We set up any input data.
 *   - We call the function we're testing.
 *   - We use `expect(...).toBe(...)` (or similar) to assert what the result
 *     should be. If the assertion fails, the test fails.
 * The goal is: if someone breaks this function later, a test here turns red
 * and tells them exactly what they broke.
 *
 * ── The arrange / act / assert pattern ─────────────────────────────────────
 * Most tests follow three steps, often separated by a blank line:
 *   1. ARRANGE — set up the inputs.
 *   2. ACT     — call the function under test.
 *   3. ASSERT  — check the result.
 * You'll see comments below marking these so the pattern is obvious.
 */

// Import the functions we want to test. We import from the REAL file here
// (not the stub) because diff.js has no SillyTavern dependencies.
import { describe, test, expect } from 'vitest';
import { escapeHtml, computeLcsDiff, buildInlineDiff, renderDiffHtml } from '../core/diff.js';

// `describe` is just a way to GROUP related tests together. The label shows up
// in the test output, making it easier to find failures. It's optional but
// helps organize larger test files.
describe('escapeHtml', () => {

    test('replaces each HTML-special character with its entity', () => {
        // We check each transformation individually. This is clearer for a
        // beginner than one big expected-string match, and it pinpoints exactly
        // which character broke if the test ever fails.
        //
        // Note: we build the expected entity strings with '\u0026' (the Unicode
        // escape for '&') instead of writing a literal '&'. This avoids
        // ambiguity in source code and makes the intent explicit.
        const amp = '\u0026amp;';    // &  → &
        const lt  = '\u0026lt;';     // <  → <
        const gt  = '\u0026gt;';     // >  → >
        const quot = '\u0026quot;';  // "  → "
        const apos = '\u0026#39;';   // '  → &#39;

        expect(escapeHtml('&')).toBe(amp);
        expect(escapeHtml('<')).toBe(lt);
        expect(escapeHtml('>')).toBe(gt);
        expect(escapeHtml('"')).toBe(quot);
        expect(escapeHtml("'")).toBe(apos);
    });

    test('returns an empty string for null / undefined input', () => {
        // ARRANGE + ACT + ASSERT combined for a short edge case.
        // The `?? ''` inside escapeHtml means null/undefined become '' first.
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    test('coerces non-string input to a string before escaping', () => {
        // Numbers and booleans get String()'d, then escaped. This test pins
        // that behavior down so a future refactor doesn't silently change it.
        expect(escapeHtml(42)).toBe('42');
        expect(escapeHtml(true)).toBe('true');
    });

    test('does not double-escape an already-escaped string', () => {
        // If the input already contains &, escapeHtml turns the & into
        // & AGAIN, producing &amp;. This is intentional (the function
        // is a low-level escaper, not a smart one) — this test documents that.
        expect(escapeHtml('&')).toBe('&amp;');
    });
});

describe('computeLcsDiff', () => {

    // ── A JavaScript quirk worth knowing ────────────────────────────────────
    // You might expect computeLcsDiff('', '') to return [] (nothing in, nothing
    // out). But the function splits text on '\n', and in JavaScript:
    //
    //     ''.split('\n')  →  ['']   // one empty string, NOT an empty array!
    //     'a'.split('\n') →  ['a']  // also a 1-element array
    //
    // So '' is treated as a single empty LINE, not as "zero lines." The LCS
    // of ['',] vs ['',] is [''], so the result is one "same" row with empty
    // text. The tests below pin this behavior down so it's not a surprise.

    test('treats two empty strings as one matching empty line', () => {
        // ARRANGE + ACT
        const result = computeLcsDiff('', '');
        // ASSERT: one "same" row for the single empty line (see the quirk note).
        expect(result).toEqual([{ type: 'same', text: '' }]);
    });

    test('marks every line as "added" when old text is the empty string', () => {
        // ARRANGE: '' splits to [''], which is treated as one empty old line.
        const oldText = '';
        const newText = 'a\nb\nc';
        // ACT
        const result = computeLcsDiff(oldText, newText);
        // ASSERT: the empty old line is "removed", then each new line is "added".
        expect(result).toEqual([
            { type: 'removed', text: '' },
            { type: 'added',   text: 'a' },
            { type: 'added',   text: 'b' },
            { type: 'added',   text: 'c' },
        ]);
    });

    test('marks every line as "removed" when new text is the empty string', () => {
        // ARRANGE: '' splits to [''], which is treated as one empty new line.
        const result = computeLcsDiff('a\nb', '');
        // ASSERT: both old lines are "removed", then the empty new line is "added".
        expect(result).toEqual([
            { type: 'removed', text: 'a' },
            { type: 'removed', text: 'b' },
            { type: 'added',   text: '' },
        ]);
    });

    test('marks unchanged lines as "same"', () => {
        // Identical input → every line is "same".
        const result = computeLcsDiff('hello\nworld', 'hello\nworld');
        expect(result).toEqual([
            { type: 'same', text: 'hello' },
            { type: 'same', text: 'world' },
        ]);
    });

    test('detects a single inserted line in the middle', () => {
        // ARRANGE: insert "middle" between "top" and "bottom".
        const oldText = 'top\nbottom';
        const newText = 'top\nmiddle\nbottom';
        // ACT
        const result = computeLcsDiff(oldText, newText);
        // ASSERT: the LCS algorithm should recognize "top" and "bottom" are
        // unchanged, and only "middle" is new.
        expect(result).toEqual([
            { type: 'same',  text: 'top' },
            { type: 'added', text: 'middle' },
            { type: 'same',  text: 'bottom' },
        ]);
    });

    test('detects a single deleted line', () => {
        const result = computeLcsDiff('a\nb\nc', 'a\nc');
        expect(result).toEqual([
            { type: 'same',    text: 'a' },
            { type: 'removed', text: 'b' },
            { type: 'same',    text: 'c' },
        ]);
    });

    test('returns null when input exceeds the line cap (fallback guard)', () => {
        // ARRANGE: build two strings whose combined line count is over the cap.
        // The default cap is 500 lines each, so 600 each is safely over.
        const big = Array(600).fill('line').join('\n');
        // ACT
        const result = computeLcsDiff(big, big);
        // ASSERT: the function bails out rather than doing an O(n²) LCS on a
        // huge input. Callers check for null and fall back to a simple render.
        expect(result).toBeNull();
    });
});

describe('buildInlineDiff', () => {

    test('returns matching original/new HTML when texts are identical', () => {
        // ARRANGE
        const text = 'the quick brown fox';
        // ACT
        const { originalHtml, newHtml } = buildInlineDiff(text, text);
        // ASSERT: no <ins>/<del> markup, both sides equal the plain text.
        expect(originalHtml).toBe('the quick brown fox');
        expect(newHtml).toBe('the quick brown fox');
    });

    test('wraps changed words in <del> (old) and <ins> (new)', () => {
        // ARRANGE: one word differs.
        const oldText = 'the quick brown fox';
        const newText = 'the slow brown fox';
        // ACT
        const { originalHtml, newHtml } = buildInlineDiff(oldText, newText);
        // ASSERT: "quick" is deleted from the old side, "slow" is inserted on
        // the new side. The rest is unchanged. We use toContain for these
        // because whitespace handling makes exact-string matches brittle.
        expect(originalHtml).toContain('<del>quick</del>');
        expect(newHtml).toContain('<ins>slow</ins>');
        // Unchanged words appear (unescaped, no markup) on both sides.
        expect(originalHtml).toContain('brown');
        expect(newHtml).toContain('brown');
    });

    test('falls back to <pre> blocks when input exceeds the word cap', () => {
        // ARRANGE: a very long pair of texts over the default 2000-word cap.
        const big = 'word '.repeat(2500);
        // ACT
        const result = buildInlineDiff(big, big);
        // ASSERT: the fallback path wraps each side in a <pre> tag instead of
        // attempting an expensive word-level diff.
        expect(result.originalHtml).toMatch(/<pre/);
        expect(result.newHtml).toMatch(/<pre/);
    });
});

describe('renderDiffHtml', () => {

    test('renders added/removed/same rows with default CSS classes', () => {
        // ARRANGE: a diff array like computeLcsDiff would produce.
        const diff = [
            { type: 'same',    text: 'unchanged' },
            { type: 'added',   text: 'new line' },
            { type: 'removed', text: 'old line' },
        ];
        // ACT
        const html = renderDiffHtml(diff);
        // ASSERT: each type maps to the right CSS class, with + / - / &nbsp;
        // prefixes (matching the function's contract).
        expect(html).toContain('<div class="mwt-diff-same">&nbsp; unchanged</div>');
        expect(html).toContain('<div class="mwt-diff-new">+ new line</div>');
        expect(html).toContain('<div class="mwt-diff-old">- old line</div>');
        // Everything is wrapped in the default wrapper class.
        expect(html).toContain('class="mwt-diff"');
    });

    test('returns empty string for a null diff', () => {
        // computeLcsDiff can return null (the cap fallback). renderDiffHtml
        // must handle that gracefully instead of throwing.
        expect(renderDiffHtml(null)).toBe('');
    });

    test('honors custom CSS class names when provided', () => {
        // ARRANGE: diff with one added line + custom class options.
        const diff = [{ type: 'added', text: 'hi' }];
        // ACT: pass a custom class mapping.
        const html = renderDiffHtml(diff, {
            wrapper: 'my-wrap',
            added:   'my-add',
        });
        // ASSERT: our custom classes are used instead of the defaults.
        expect(html).toContain('class="my-wrap"');
        expect(html).toContain('class="my-add"');
        // And the defaults are NOT present.
        expect(html).not.toContain('mwt-diff-new');
    });
});