/**
 * test/prompt_helpers.test.js — Tier 0.4: prompt-boundary + payload-budget helpers.
 *
 * Three categories:
 * 1. Escaping for XML-like tag content and attributes.
 * 2. Bounded text/array helpers with truncation markers.
 * 3. Total-payload budget helper that fails closed for required blocks.
 */

import { describe, test, expect } from 'vitest';

import {
    escapePromptText,
    escapePromptAttr,
    buildTag,
    wrapTag,
    truncateText,
    truncateTail,
    truncateArray,
    fitBudget,
    TRUNCATION_MARKER,
} from '../core/prompt.js';

// Build entity strings via char codes to avoid any entity-stripping tooling.
const AMP = String.fromCharCode(38);   // &
const LT  = String.fromCharCode(60);   // <
const GT  = String.fromCharCode(62);   // >
const QUOT = String.fromCharCode(34);  // "

const E_AMP  = AMP + 'amp;';   // &
const E_LT   = AMP + 'lt;';    // <
const E_GT   = AMP + 'gt;';    // >
const E_QUOT = AMP + 'quot;';  // "

// ─── Escaping ────────────────────────────────────────────────────────────────

describe('escapePromptText (tag content)', () => {
    test('escapes ampersand', () => {
        expect(escapePromptText('Tom ' + AMP + ' Jerry')).toBe('Tom ' + E_AMP + ' Jerry');
    });

    test('escapes less-than', () => {
        expect(escapePromptText('a' + LT + 'b')).toBe('a' + E_LT + 'b');
    });

    test('passes through ordinary text unchanged', () => {
        expect(escapePromptText('Hello, Mara!')).toBe('Hello, Mara!');
    });

    test('handles null and undefined as empty string', () => {
        expect(escapePromptText(null)).toBe('');
        expect(escapePromptText(undefined)).toBe('');
    });

    test('escapes multiple special characters in one string', () => {
        const input = AMP + ' ' + LT + ' text';
        const expected = E_AMP + ' ' + E_LT + ' text';
        expect(escapePromptText(input)).toBe(expected);
    });
});

describe('escapePromptAttr (tag attributes)', () => {
    test('escapes double quotes', () => {
        expect(escapePromptAttr('Mara ' + QUOT + 'May' + QUOT))
            .toBe('Mara ' + E_QUOT + 'May' + E_QUOT);
    });

    test('escapes ampersand, less-than, greater-than', () => {
        const input = AMP + LT + GT;
        const expected = E_AMP + E_LT + E_GT;
        expect(escapePromptAttr(input)).toBe(expected);
    });

    test('passes through safe attribute text', () => {
        expect(escapePromptAttr('Mara Vance')).toBe('Mara Vance');
    });
});

describe('buildTag', () => {
    test('builds a simple tag with no attributes', () => {
        expect(buildTag('recent_messages')).toBe('<recent_messages>');
    });

    test('builds a tag with one attribute, escaping the value', () => {
        const result = buildTag('npc', { name: 'Mara' });
        expect(result).toBe('<npc name="Mara">');
    });

    test('escapes special characters in attribute values', () => {
        const result = buildTag('npc', { name: 'Mara ' + QUOT + 'May' + QUOT });
        expect(result).toBe('<npc name="Mara ' + E_QUOT + 'May' + E_QUOT + '">');
    });

    test('builds a tag with multiple attributes', () => {
        const result = buildTag('item', { id: '42', type: 'note' });
        expect(result).toBe('<item id="42" type="note">');
    });
});

describe('wrapTag', () => {
    test('wraps text in open/close tags with escaped content', () => {
        expect(wrapTag('label', 'hello')).toBe('<label>hello</label>');
    });

    test('escapes special characters in the content', () => {
        const result = wrapTag('entry', 'a' + LT + 'b');
        expect(result).toBe('<entry>a' + E_LT + 'b</entry>');
    });
});

// ─── Bounded text / array helpers ────────────────────────────────────────────

describe('truncateText', () => {
    test('returns text unchanged when within budget', () => {
        expect(truncateText('hello', 100)).toBe('hello');
    });

    test('returns text unchanged when exactly at budget', () => {
        expect(truncateText('hello', 5)).toBe('hello');
    });

    test('truncates and adds marker when over budget', () => {
        // Use a budget large enough for the marker.
        const budget = 30;
        const result = truncateText('hello world this is a long text', budget);
        expect(result).toContain(TRUNCATION_MARKER);
        expect(result.length).toBeLessThanOrEqual(budget);
        // Keeps the beginning
        expect(result.startsWith('hello')).toBe(true);
    });

    test('handles tiny budget (just the marker)', () => {
        // Text longer than the marker, budget = marker length: only marker fits.
        const longText = 'x'.repeat(TRUNCATION_MARKER.length + 5);
        const result = truncateText(longText, TRUNCATION_MARKER.length);
        expect(result).toBe(TRUNCATION_MARKER);
    });

    test('budget smaller than marker produces just the marker', () => {
        // The marker is the minimum output; we don't truncate the marker itself.
        const result = truncateText('hello world', 5);
        expect(result).toBe(TRUNCATION_MARKER);
    });
});

describe('truncateTail', () => {
    test('returns text unchanged when within budget', () => {
        expect(truncateTail('hello', 100)).toBe('hello');
    });

    test('keeps the tail and adds marker at the start', () => {
        // Use a budget large enough for the marker plus some text.
        const budget = 30;
        const result = truncateTail('hello world this is a long text', budget);
        expect(result.startsWith(TRUNCATION_MARKER)).toBe(true);
        // Keeps the end
        expect(result.endsWith('long text')).toBe(true);
        expect(result.length).toBeLessThanOrEqual(budget);
    });
});

describe('truncateArray', () => {
    test('joins all items when within budget', () => {
        const result = truncateArray(['a', 'b', 'c'], 100);
        expect(result).toBe('a\nb\nc');
    });

    test('truncates with marker when budget is exceeded', () => {
        const items = ['aaaa', 'bbbb', 'cccc', 'dddd'];
        // Budget is tight: allows first two items (4+1+4=9) + separator + marker
        const budget = TRUNCATION_MARKER.length + 5;
        const result = truncateArray(items, budget);
        expect(result).toContain(TRUNCATION_MARKER);
        expect(result.length).toBeLessThanOrEqual(budget);
    });

    test('returns empty string for empty array', () => {
        expect(truncateArray([], 100)).toBe('');
    });

    test('returns empty string for null', () => {
        expect(truncateArray(null, 100)).toBe('');
    });

    test('uses custom separator', () => {
        const result = truncateArray(['a', 'b', 'c'], 100, ', ');
        expect(result).toBe('a, b, c');
    });
});

// ─── Total-payload budget ────────────────────────────────────────────────────

describe('fitBudget', () => {
    test('includes all blocks when budget is sufficient', () => {
        const blocks = [
            { key: 'header', content: 'Header text' },
            { key: 'body', content: 'Body text' },
        ];
        const result = fitBudget(blocks, 1000);
        expect(result.ok).toBe(true);
        expect(result.assembled).toContain('Header text');
        expect(result.assembled).toContain('Body text');
        expect(result.dropped).toEqual([]);
    });

    test('drops optional blocks that exceed the budget', () => {
        const blocks = [
            { key: 'required', content: 'Must include', required: true },
            { key: 'optional1', content: 'A'.repeat(50) },
            { key: 'optional2', content: 'B'.repeat(50) },
        ];
        const result = fitBudget(blocks, 80);
        expect(result.ok).toBe(true);
        expect(result.dropped).toContain('optional2');
        expect(result.assembled).toContain('Must include');
        expect(result.assembled).toContain('A');
    });

    test('fails closed when required blocks exceed budget', () => {
        const blocks = [
            { key: 'critical', content: 'C'.repeat(200), required: true },
            { key: 'optional', content: 'small' },
        ];
        const result = fitBudget(blocks, 100);
        expect(result.ok).toBe(false);
        expect(result.assembled).toBe('');
        expect(result.dropped).toContain('critical');
        expect(result.dropped).toContain('optional');
    });

    test('includes required blocks and drops nothing when they fit', () => {
        const blocks = [
            { key: 'req', content: 'Required', required: true },
        ];
        const result = fitBudget(blocks, 100);
        expect(result.ok).toBe(true);
        expect(result.assembled).toBe('Required');
        expect(result.dropped).toEqual([]);
    });

    test('handles empty blocks array', () => {
        const result = fitBudget([], 100);
        expect(result.ok).toBe(true);
        expect(result.assembled).toBe('');
    });

    test('uses custom separator', () => {
        const blocks = [
            { key: 'a', content: 'AAA' },
            { key: 'b', content: 'BBB' },
        ];
        const result = fitBudget(blocks, 100, ' | ');
        expect(result.assembled).toBe('AAA | BBB');
    });

    test('totalChars reflects actual assembled size', () => {
        const blocks = [
            { key: 'a', content: 'hello' },
            { key: 'b', content: 'world' },
        ];
        const result = fitBudget(blocks, 100, '\n');
        expect(result.totalChars).toBe('hello\nworld'.length);
    });
});