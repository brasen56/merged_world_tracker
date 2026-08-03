/**
 * test/trailing_commas.test.js — CORE-01: string-safe trailing-comma repair.
 *
 * The previous `removeTrailingCommas` used a naive regex
 * (`/,\s*([}\]])/g`) with no string-state tracking. A generated *value*
 * containing `,}` or `,]` was silently edited — the parse succeeded, so no
 * downstream validation could ever catch it.
 *
 * The fix is a character-by-character scanner that only strips commas found
 * at structural depth (outside any string literal) followed by `}` or `]`.
 *
 * Since `removeTrailingCommas` is a private function, we test it through
 * `parseJsonLenient`, which is the public API that calls it.
 */

import { describe, test, expect } from 'vitest';
import { parseJsonLenient } from '../core/api.js';

describe('CORE-01: string-safe trailing-comma repair', () => {

    // ── Regression: commas inside string values must be preserved ───────────

    test('preserves ",}" inside a string value', () => {
        // The old regex would strip the comma, producing {"a":"she said}"}
        // — silent corruption of dialogue.
        const result = parseJsonLenient('{"a": "she said,}"}');
        expect(result.a).toBe('she said,}');
    });

    test('preserves ",]" inside a string value', () => {
        const result = parseJsonLenient('{"a": "list,]"}');
        expect(result.a).toBe('list,]');
    });

    test('preserves ",}" inside an array element string', () => {
        const result = parseJsonLenient('{"arr": ["ok", "boom,}", "fine"]}');
        expect(result.arr[1]).toBe('boom,}');
    });

    test('preserves escaped quotes inside a value containing ,}', () => {
        // The scanner must track escape state: \" inside a string is not a
        // string terminator.
        const input = '{"a": "he said \\"hi,}\\"" }';
        const result = parseJsonLenient(input);
        expect(result.a).toBe('he said "hi,}"');
    });

    test('preserves comma-brace patterns in nested string values', () => {
        const input = '{"outer": {"inner": "val,}"}, "b": 1}';
        const result = parseJsonLenient(input);
        expect(result.outer.inner).toBe('val,}');
        expect(result.b).toBe(1);
    });

    // ── Genuine trailing commas must still be stripped ──────────────────────

    test('strips a genuine trailing comma before }', () => {
        const result = parseJsonLenient('{"a": 1,}');
        expect(result).toEqual({ a: 1 });
    });

    test('strips a genuine trailing comma before ]', () => {
        const result = parseJsonLenient('{"arr": [1, 2, 3,]}');
        expect(result.arr).toEqual([1, 2, 3]);
    });

    test('strips trailing commas with whitespace between comma and brace', () => {
        const result = parseJsonLenient('{"a": 1  ,  }');
        expect(result).toEqual({ a: 1 });
    });

    test('strips multiple trailing commas in nested structures', () => {
        const result = parseJsonLenient('{"a": [1, 2,], "b": {"c": 3,},}');
        expect(result).toEqual({ a: [1, 2], b: { c: 3 } });
    });

    test('strips trailing comma after the last string value', () => {
        const result = parseJsonLenient('{"name": "Mara",}');
        expect(result).toEqual({ name: 'Mara' });
    });

    // ── Edge cases ──────────────────────────────────────────────────────────

    test('does not strip a non-trailing comma (value follows)', () => {
        const result = parseJsonLenient('{"a": 1, "b": 2}');
        expect(result).toEqual({ a: 1, b: 2 });
    });

    test('handles empty arrays and objects with trailing commas', () => {
        expect(parseJsonLenient('{"a": [], "b": {,}}')).toEqual({ a: [], b: {} });
    });

    test('handles strings containing escaped backslashes before quotes', () => {
        // \\ inside a string is a literal backslash, not an escape.
        // The next " is a real string terminator.
        const input = '{"a": "path\\\\", "b": "next,}"}';
        const result = parseJsonLenient(input);
        expect(result.a).toBe('path\\');
        expect(result.b).toBe('next,}');
    });

    test('handles truncated input without false-matching (no closing brace)', () => {
        // A truncated document has no closing brace, so there's nothing to
        // falsely strip. The repair pipeline should still produce a parseable
        // result.
        const result = parseJsonLenient('{"a": 1, "b": [1, 2');
        expect(result.a).toBe(1);
        expect(result.b).toEqual([1, 2]);
    });
});