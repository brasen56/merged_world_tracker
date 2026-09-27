/** @vitest-environment jsdom */
/**
 * test/chronicle_injection_settings_xss.test.js — M2-07 (docs/TODO.md §0).
 *
 * Chronicle's injection settings (injectMode, injectCount, injectFromDate,
 * injectToDate, injectDepth) live in chat metadata that the Chronicle schema
 * passes through unvalidated, and that metadata can arrive from outside MWT:
 * a Chronicle import, a shared .jsonl chat (SillyTavern copies its
 * chat_metadata verbatim), or a backup restore. The settings view and the
 * stats view used to interpolate those values into HTML unescaped, so a
 * crafted value could inject markup into the page.
 *
 * The fix has two layers:
 *   1. every consumer reads the settings through getInjectionSettings() /
 *      resolveInjectionPlacement(), so a malformed value falls back to its
 *      default instead of reaching a slice(), a date comparison, the prompt
 *      placement, or the page (dates must be ISO 8601 — Date.parse() alone
 *      would not do: V8 accepts "Tue Mar 01 2011 (<img>)", treating the
 *      parentheses as a comment);
 *   2. every one of these values is still escaped where it is rendered.
 * The rendered-view tests pass through either layer, so each layer is also
 * pinned on its own: the normalizer by its unit tests, the escaping by the
 * source contract at the bottom.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import chronicleRenderSource from '../chronicle/render.js?raw';
import { getFakeMeta, resetCoreStubs } from './stubs/core.js';
import { state } from '../chronicle/data.js';
import { renderContent } from '../chronicle/render.js';
import {
    getEntriesForInjection,
    getInjectionSettings,
    resolveInjectionPlacement,
} from '../chronicle/injection.js';

// Closes the attribute it lands in, then plants a marked element.
const MARKUP = '"><img src="x" data-mwt-xss="1">';

function snapshot(n) {
    return { id: `s${n}`, text: `Entry ${n}`, createdAt: `2026-01-0${n}T00:00:00.000Z` };
}

function seedChronicle(fields, count = 1) {
    getFakeMeta().session_chronicle_data = {
        snapshots: Array.from({ length: count }, (_, i) => snapshot(i + 1)),
        _deletedBin: [],
        ...fields,
    };
}

function renderInto() {
    const host = document.createElement('div');
    document.body.append(host);
    state.contentEl = host;
    renderContent();
    return host;
}

beforeEach(() => {
    resetCoreStubs();
    document.body.innerHTML = '';
    state.contentEl = null;
    state.modal = null;
    state.selectedSnapshotId = null;
});

afterEach(() => {
    document.body.innerHTML = '';
    state.contentEl = null;
});

describe('M2-07: crafted injection settings render as inert text', () => {
    test('the ⚙ Injection settings view escapes count and range dates', () => {
        seedChronicle({
            injectMode: 'range',
            injectCount: MARKUP,
            injectFromDate: MARKUP,
            injectToDate: `Tue Mar 01 2011 (${MARKUP})`,
        });
        const host = renderInto();
        host.querySelector('#sc-inject-settings').click();

        expect(host.querySelector('#sc-inject-count')).toBeTruthy();
        expect(host.querySelector('[data-mwt-xss]')).toBeNull();
        // Malformed values fall back to their defaults in the form, too.
        expect(host.querySelector('#sc-inject-count').value).toBe('2');
        expect(host.querySelector('#sc-inject-from').value).toBe('');
        expect(host.querySelector('#sc-inject-to').value).toBe('');
        expect(host.querySelector('#sc-inject-mode-range').checked).toBe(true);
    });

    test('the 📊 Stats view escapes the injection mode', () => {
        seedChronicle({ injectMode: `recent${MARKUP}` });
        const host = renderInto();
        host.querySelector('#sc-stats-btn').click();

        expect(host.querySelector('[data-mwt-xss]')).toBeNull();
        const heading = [...host.querySelectorAll('h4')].find(h => h.textContent.startsWith('Injection ('));
        expect(heading?.textContent).toBe('Injection (recent)');
    });

    test('well-formed settings still render unchanged', () => {
        seedChronicle({ injectMode: 'range', injectCount: 3, injectFromDate: '2026-01-01T10:00', injectToDate: '2026-02-01T09:30' }, 3);
        const host = renderInto();
        host.querySelector('#sc-inject-settings').click();

        expect(host.querySelector('#sc-inject-count').value).toBe('3');
        expect(host.querySelector('#sc-inject-from').value).toBe('2026-01-01T10:00');
        expect(host.querySelector('#sc-inject-to').value).toBe('2026-02-01T09:30');
    });
});

describe('M2-07: getInjectionSettings() normalizes every field', () => {
    test('malformed values fall back to the defaults', () => {
        expect(getInjectionSettings({
            injectMode: 'bogus',
            injectCount: 'abc',
            injectFromDate: 'Tue Mar 01 2011 (<img>)',
            injectToDate: 42,
            selectedForInjection: 7,
        })).toEqual({ mode: 'recent', count: 2, fromDate: '', toDate: '', selectedIds: [] });
    });

    test('valid values pass through (numeric-string counts included)', () => {
        expect(getInjectionSettings({
            injectMode: 'range',
            injectCount: '3',
            injectFromDate: '2026-01-01T10:00',
            injectToDate: '2026-02-01',
            selectedForInjection: ['s1', 5, 's2'],
        })).toEqual({ mode: 'range', count: 3, fromDate: '2026-01-01T10:00', toDate: '2026-02-01', selectedIds: ['s1', 's2'] });
    });

    test('absent settings read as the historical defaults', () => {
        expect(getInjectionSettings({})).toEqual({ mode: 'recent', count: 2, fromDate: '', toDate: '', selectedIds: [] });
        expect(getInjectionSettings({ injectCount: 0 }).count).toBe(2);
    });

    test('a non-array selection list no longer throws in Selected mode', () => {
        // (7).includes is not a function — the old read crashed selection.
        seedChronicle({ injectMode: 'selected', selectedForInjection: 7 }, 2);
        expect(getEntriesForInjection()).toEqual([]);
    });

    test('a malformed count no longer injects every entry', () => {
        // slice(-'abc') is slice(NaN) === slice(0): the old read injected ALL.
        seedChronicle({ injectMode: 'recent', injectCount: 'abc' }, 5);
        expect(getEntriesForInjection().map(s => s.id)).toEqual(['s4', 's5']);
    });

    test('a malformed chat depth falls back to the built-in placement', () => {
        seedChronicle({ injectDepth: MARKUP });
        expect(resolveInjectionPlacement().depth).toEqual({ value: 2, source: 'builtin' });
        seedChronicle({ injectDepth: 0 });
        expect(resolveInjectionPlacement().depth).toEqual({ value: 0, source: 'module' });
    });
});

describe('M2-07: the rendered settings are escaped at the HTML boundary', () => {
    test.each([
        'escapeHtml(currentCount)',
        'escapeHtml(fromDate)',
        'escapeHtml(toDate)',
        'escapeHtml(stats.injectMode)',
        'escapeHtml(depth)',
        'escapeHtml(roleName)',
    ])('chronicle/render.js interpolates %s', expression => {
        expect(chronicleRenderSource).toContain(`\${${expression}}`);
    });

    test('no raw chat-metadata read remains in the settings view', () => {
        expect(chronicleRenderSource).not.toMatch(/\$\{data\.inject(Count|FromDate|ToDate|Mode)/);
        expect(chronicleRenderSource).not.toMatch(/getChronicleData\(\)\.injectDepth/);
    });
});
