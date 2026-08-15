/**
 * test/recovery_diagnostics.test.js — Phase 3 tests for the silent-recovery
 * counters (design §I.4.5).
 *
 * Five quiet fallbacks that cause "why is my data weird" reports now record a
 * warn-level event into the Phase 0 ring:
 *
 *   1. json_repaired          — parseJsonLenient recovered JSON that strict
 *                                JSON.parse rejected (core/api.js)
 *   2. reasoning_content_fallback — content was empty, reasoning_content used
 *                                (core/api.js fetchFromApi)
 *   3. output_stripped        — normaliseOutput removed fences/preamble
 *                                (core/api.js)
 *   4. scope_fallback_global  — knowledge/scope.js fell back to global books
 *                                because identity did not resolve
 *   5. wi_script_unavailable  — knowledge/store.js getWiScript() has no
 *                                world-info module
 *
 * Recovery-only by design: the LOUD paths (repair that fails, empty output,
 * no-content errors) must NOT record these events — they already throw, and a
 * counter for a thrown error would be noise. The negative tests below pin that
 * boundary, including the two normaliseOutput cleanups that are deliberately
 * NOT counted (thinking-block stripping, line-ending normalisation).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import { fetchFromApi, normaliseOutput, parseJsonLenient } from '../core/api.js';
import { resolveBookNames } from '../knowledge/scope.js';
import { getSettings, saveSettings } from '../knowledge/settings.js';
import { hydrateBook } from '../knowledge/store.js';
import { state } from '../knowledge/state.js';
import { resetCoreStubs, setFakeContextExtras } from './stubs/core.js';

/** All warn-level events with the given event name, newest first. */
function warns(event) {
    return getEvents({ level: 'warn' }).filter((e) => e.event === event);
}

beforeEach(() => {
    _resetDiagnostics();
    resetCoreStubs();
    // Several of the sites under test warn deliberately — keep the console quiet.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
    // knowledge/state.js is a singleton across the module graph — never let one
    // test's wiScript simulation leak into another test's store behaviour.
    state.wiScript = undefined;
});

// ─── Site 1 — parseJsonLenient records json_repaired ─────────────────────────

describe('site 1 — parseJsonLenient records json_repaired', () => {
    test('strict-parseable JSON records nothing', () => {
        expect(parseJsonLenient('{"a":1}')).toEqual({ a: 1 });
        expect(warns('json_repaired')).toHaveLength(0);
    });

    test('prose/fence-wrapped JSON is recovered and recorded', () => {
        expect(parseJsonLenient('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
        const [evt] = warns('json_repaired');
        expect(evt).toBeDefined();
        expect(evt.module).toBe('api');
        expect(evt.detail.chars).toBe('Here you go:\n```json\n{"a":1}\n```'.length);
    });

    test('trailing commas and truncation repairs are recorded too', () => {
        expect(parseJsonLenient('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
        expect(warns('json_repaired')).toHaveLength(1);

        expect(parseJsonLenient('{"a":{"b":"trunc')).toEqual({ a: { b: 'trunc' } });
        expect(warns('json_repaired')).toHaveLength(2);
    });

    test('unrecoverable output throws and records nothing (loud path, not silent)', () => {
        expect(() => parseJsonLenient('no json here')).toThrow('no JSON object found');
        expect(warns('json_repaired')).toHaveLength(0);
    });
});


// ─── Site 2 — reasoning_content fallback ─────────────────────────────────────

describe('site 2 — fetchFromApi records reasoning_content_fallback', () => {
    function okResponse(data) {
        return {
            ok: true,
            status: 200,
            statusText: 'HTTP 200',
            text: async () => JSON.stringify(data),
            json: async () => data,
        };
    }

    test('empty content with reasoning_content records a warn tagged with the calling module', async () => {
        globalThis.fetch = vi.fn(async () => okResponse({
            choices: [{ message: { content: '', reasoning_content: 'the actual answer' }, finish_reason: 'stop' }],
        }));

        const out = await fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test', modelName: 'test-model', module: 'world_state' },
            retries: 0,
        });

        expect(out).toBe('the actual answer');
        const [evt] = warns('reasoning_content_fallback');
        expect(evt).toBeDefined();
        expect(evt.module).toBe('world_state');   // same convention as recordApiCall
        expect(evt.detail.chars).toBe('the actual answer'.length);
    });

    test('normal content records nothing', async () => {
        globalThis.fetch = vi.fn(async () => okResponse({
            choices: [{ message: { content: 'fine', reasoning_content: 'ignored' }, finish_reason: 'stop' }],
        }));

        const out = await fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test', modelName: 'test-model', module: 'chronicle' },
            retries: 0,
        });

        expect(out).toBe('fine');
        expect(warns('reasoning_content_fallback')).toHaveLength(0);
    });

    test('empty content with no reasoning still throws no-content and records nothing', async () => {
        globalThis.fetch = vi.fn(async () => okResponse({
            choices: [{ message: {}, finish_reason: 'stop' }],
        }));

        await expect(fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test', modelName: 'test-model' },
            retries: 0,
        })).rejects.toThrow('no content');

        expect(warns('reasoning_content_fallback')).toHaveLength(0);
    });
});

// ─── Site 3 — normaliseOutput records output_stripped ────────────────────────

describe('site 3 — normaliseOutput records output_stripped', () => {
    test('a fully fenced output is unwrapped and recorded', () => {
        expect(normaliseOutput('```json\n{"a":1}\n```')).toBe('{"a":1}');
        const [evt] = warns('output_stripped');
        expect(evt).toBeDefined();
        expect(evt.module).toBe('api');
        expect(evt.detail).toEqual({ fenced: true, preamble: false, chars: '{"a":1}'.length });
    });

    test('a preamble-only output is recorded as preamble', () => {
        expect(normaliseOutput("Here's the updated world state:\nhello")).toBe('hello');
        const [evt] = warns('output_stripped');
        expect(evt).toBeDefined();
        expect(evt.detail).toEqual({ fenced: false, preamble: true, chars: 'hello'.length });
    });

    test('plain text records nothing — even with CRLF, which is routine cleanup', () => {
        expect(normaliseOutput('plain\r\ntext')).toBe('plain\ntext');
        expect(warns('output_stripped')).toHaveLength(0);

// ─── Site 4 — knowledge scope fell back to global books ──────────────────────

describe('site 4 — resolveBookNames records scope_fallback_global', () => {
    test('unresolvable identity falls back to the global books and records a warn', () => {
        saveSettings({ scope: 'character' });
        // No character context installed → identity cannot resolve.
        expect(getSettings().scope).toBe('character');
        expect(resolveBookNames().knowledge).toBe('Knowledge Tracker');

        const [evt] = warns('scope_fallback_global');
        expect(evt).toBeDefined();
        expect(evt.module).toBe('knowledge');
        expect(evt.detail).toEqual({ scope: 'character' });
    });

    test('explicit global scope is a choice, not a fallback — records nothing', () => {
        saveSettings({ scope: 'global' });
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara', avatar: 'mara.png' }],
        });
        expect(resolveBookNames().knowledge).toBe('Knowledge Tracker');
        expect(warns('scope_fallback_global')).toHaveLength(0);
    });

    test('a successfully resolved identity records nothing', () => {
        saveSettings({ scope: 'character' });
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Mara', avatar: 'mara.png' }],
        });
        expect(resolveBookNames().knowledge).toBe('Knowledge Tracker - Mara');
        expect(warns('scope_fallback_global')).toHaveLength(0);
    });
});

// ─── Site 5 — world-info module unavailable ──────────────────────────────────

describe('site 5 — getWiScript records wi_script_unavailable', () => {
    test('a tried-and-failed wiScript (tri-state null) records a warn on use', async () => {
        state.wiScript = null;   // the documented way tests simulate "unavailable"

        const data = await hydrateBook('Knowledge Tracker');

        // Un-hydrated on purpose: writes blocked, reads see a blank store.
        expect(data).toBeDefined();
        const [evt] = warns('wi_script_unavailable');
        expect(evt).toBeDefined();
        expect(evt.module).toBe('knowledge');
        expect(evt.detail.stage).toBe('previous-attempt-failed');
    });

    test('a failing world-info import records the import-failed stage', async () => {
        // Same specifier string store.js uses — resolves through the vitest
        // alias, so doMock intercepts store.js's dynamic import. The fresh
        // dynamic import of store.js re-evaluates the module against the mock
        // (its own state instance starts at wiScript: undefined).
        vi.doMock('../../../../world-info.js', () => {
            throw new Error('module gone');
        });
        try {
            const store = await import('../knowledge/store.js');
            await store.hydrateBook('Knowledge Tracker');

            const [evt] = warns('wi_script_unavailable');
            expect(evt).toBeDefined();
            expect(evt.module).toBe('knowledge');
            expect(evt.detail.stage).toBe('import-failed');
            expect(typeof evt.detail.error).toBe('string');
        } finally {
            vi.doUnmock('../../../../world-info.js');
        }
    });

    test('an available world-info module records nothing', async () => {
        // The vitest alias maps the specifier to test/stubs/world-info.js, so
        // the fallback import succeeds.
        state.wiScript = undefined;

        await hydrateBook('Knowledge Tracker');

        expect(warns('wi_script_unavailable')).toHaveLength(0);
    });
});

    });

    test('thinking-block stripping alone records nothing (not one of the five sites)', () => {
        expect(normaliseOutput('<think>chain of thought</think>\npayload')).toBe('payload');
        expect(warns('output_stripped')).toHaveLength(0);
    });
});
