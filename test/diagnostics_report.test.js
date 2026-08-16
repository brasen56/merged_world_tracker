/**
 * test/diagnostics_report.test.js — Phase 5 tests for the copy-report shape
 * (diagnostics_panel/report.js — decision D1: Markdown + fenced JSON appendix).
 *
 * buildReport() is pure (sections are passed in), so no stubbing is needed.
 * The tests pin the shape contract: the header states whether content is
 * included, the appendix is valid JSON inside a fence that no payload content
 * can escape, and — the whole point of Phase 5 — secrets never survive in
 * either mode.
 *
 * collectReportSections() gets a smoke test only: it is a thin guarded pass
 * over the Phase 0–4 accessors, each of which already has its own coverage
 * (diagnostics / api_diagnostics / injection_diagnostics /
 * settings_provenance).
 */

import { describe, test, expect } from 'vitest';

import { buildReport, collectReportSections, collectKnownSecrets } from '../diagnostics_panel/report.js';

const SECRET_KEY = 'sk-report-secret';
const SECRET_HEADER = 'header-secret-value';
const PAYLOAD_TEXT = '```fence-breaking``` payload with "quotes"';

function sampleSections() {
    return [
        {
            id: 'settings',
            title: 'Global settings (secrets redacted)',
            data: {
                apiUrl: 'https://api.example.com/v1',
                apiKey: SECRET_KEY,
                customHeaders: `{"X-Api-Key": "${SECRET_HEADER}"}`,
                modelName: 'test-model',
            },
        },
        {
            id: 'injections',
            title: 'Injected payloads',
            data: {
                mwt_world_state_injection: {
                    key: 'mwt_world_state_injection',
                    payload: PAYLOAD_TEXT,
                    role: 0,
                    depth: 4,
                    enabled: true,
                },
            },
        },
    ];
}

/** Extract the fenced JSON appendix back out of a built report. */
function appendixFrom(markdown) {
    const match = markdown.match(/(`{3,})json\n([\s\S]*?)\n\1(?:\n|$)/);
    expect(match, 'report must contain a fenced json appendix').not.toBeNull();
    return JSON.parse(match[2]);
}

// ─── Header (content flag) ───────────────────────────────────────────────────

describe('buildReport — header', () => {
    test('content EXCLUDED is stated in the header', () => {
        const { markdown } = buildReport({ includeContent: false, sections: sampleSections() });
        expect(markdown).toContain('# MWT Diagnostics Report');
        expect(markdown).toContain('**Content: EXCLUDED**');
        expect(markdown).not.toContain('**Content: INCLUDED**');
    });

    test('content INCLUDED is stated in the header (with the warning)', () => {
        const { markdown } = buildReport({ includeContent: true, sections: sampleSections() });
        expect(markdown).toContain('**Content: INCLUDED**');
    });

    test('header carries the MWT version and generation timestamp', () => {
        const { markdown } = buildReport({
            includeContent: false,
            sections: [],
            meta: { mwtVersion: '9.9.9-test', generatedAt: '2026-08-16T00:00:00.000Z' },
        });
        expect(markdown).toContain('**MWT version:** 9.9.9-test');
        expect(markdown).toContain('2026-08-16T00:00:00.000Z');
    });
});

// ─── Appendix (fenced JSON) ──────────────────────────────────────────────────

describe('buildReport — appendix', () => {
    test('appendix is parseable JSON inside a fence, with meta + sections', () => {
        const { markdown, data } = buildReport({ includeContent: false, sections: sampleSections() });
        const parsed = appendixFrom(markdown);
        expect(parsed.meta.includeContent).toBe(false);
        expect(parsed.sections.settings.apiKey).toBe('[REDACTED]');
        // The returned data object is the same (already-redacted) appendix.
        expect(data).toEqual(parsed);
    });

    test('a payload containing triple backticks cannot escape the fence', () => {
        const { markdown } = buildReport({ includeContent: true, sections: sampleSections() });
        // Opt-in is ON, so the payload (with its ```) IS in the appendix —
        // the fence must be strictly longer than any backtick run inside.
        const fenceMatch = markdown.match(/(`{3,})json\n/);
        expect(fenceMatch).not.toBeNull();
        expect(fenceMatch[1].length).toBeGreaterThanOrEqual(4);
        expect(markdown).toContain('fence-breaking');
        // And it still parses back out cleanly.
        expect(() => appendixFrom(markdown)).not.toThrow();
    });

    test('secrets never survive the full report in either mode', () => {
        for (const includeContent of [false, true]) {
            const { markdown } = buildReport({ includeContent, sections: sampleSections() });
            expect(markdown).not.toContain(SECRET_KEY);
            expect(markdown).not.toContain(SECRET_HEADER);
            expect(markdown).not.toContain('api.example.com/v1');  // path dropped
            expect(markdown).toContain('api.example.com');          // host survives
            const parsed = appendixFrom(markdown);
            expect(parsed.sections.settings.apiKey).toBe('[REDACTED]');
            expect(parsed.sections.settings.customHeaders).toBe('{"X-Api-Key":"[REDACTED]"}');
        }
    });

    test('content gating reaches the report: excluded by default, included on opt-in', () => {
        const excluded = buildReport({ includeContent: false, sections: sampleSections() });
        expect(excluded.markdown).not.toContain('fence-breaking');
        expect(excluded.markdown).toMatch(/\[content excluded — \d+ chars\]/);

        const included = buildReport({ includeContent: true, sections: sampleSections() });
        expect(included.markdown).toContain('fence-breaking');
    });

    test('returned data shares no reference with the section inputs', () => {
        const sections = sampleSections();
        const { data } = buildReport({ includeContent: true, sections });
        expect(data.sections.settings).not.toBe(sections[0].data);
        expect(sections[0].data.apiKey).toBe(SECRET_KEY); // input untouched
    });
});

// ─── Free-text secrets reaching the report (event ring / last runs) ──────────

describe('buildReport — secrets that arrive as free text', () => {
    /** The two sections that carry MWT's own error strings verbatim. */
    function freeTextSections() {
        return [
            {
                id: 'events',
                title: 'Event log',
                data: [{
                    ts: 1_755_300_000_000,
                    level: 'error',
                    module: 'notify',
                    event: 'Knowledge Tracker',
                    detail: {
                        title: 'Knowledge Tracker',
                        message: 'Catch-up failed for Mira Vance: API URL returned HTML instead of JSON (404). '
                            + 'Check the API URL — resolved to: "https://proxy.example.com/v1/sk-live-abcdef123456/chat/completions".',
                    },
                }],
            },
            {
                id: 'lastRuns',
                title: 'Last run per module',
                data: {
                    knowledge: {
                        ok: false,
                        error: 'API error 401: {"error":{"message":"Incorrect API key provided: sk-live-abcdef123456"}}',
                    },
                },
            },
        ];
    }

    test('an endpoint key and an echoed key never reach the Markdown, in either mode', () => {
        for (const includeContent of [false, true]) {
            const { markdown } = buildReport({ includeContent, sections: freeTextSections() });
            expect(markdown).not.toContain('sk-live-abcdef123456');
            expect(markdown).not.toContain('proxy.example.com/v1');
        }
    });

    test('with the opt-in off, the captured toast body AND the error body are gated', () => {
        const { markdown } = buildReport({ includeContent: false, sections: freeTextSections() });
        expect(markdown).not.toContain('Mira Vance');
        expect(markdown).toContain('Knowledge Tracker');       // envelope survives
        expect(markdown).not.toContain('API error 401');       // error body gated — it can quote the chat
        expect(markdown).toMatch(/\[error excluded — \d+ chars\]/);
    });

    test('with the opt-in on, the raw error body returns — still scrubbed of secrets', () => {
        const { markdown } = buildReport({ includeContent: true, sections: freeTextSections() });
        expect(markdown).toContain('API error 401');
        expect(markdown).toContain('Incorrect API key provided');
        expect(markdown).not.toContain('sk-live-abcdef123456');
    });

    test('knownSecrets threads through to the sections', () => {
        // Shapeless value in a sentence with no 'token'/'Bearer' lead-in — only
        // an exact-value match can catch it, so this pins the threading itself.
        // includeContent: the carrier is an error body, which the opt-in gates.
        const bare = 'q7Wm3Zx9Lp2Rv8Tk';
        const sections = [{ id: 'lastRuns', title: 'Last runs', data: { knowledge: { error: `upstream rejected ${bare}` } } }];
        expect(buildReport({ includeContent: true, sections, knownSecrets: [bare] }).markdown).not.toContain(bare);
        // Opting out explicitly is possible, and then only the pattern rules apply.
        expect(buildReport({ includeContent: true, sections, knownSecrets: [] }).markdown).toContain(bare);
    });

    test('the header no longer promises the report is safe to paste unread', () => {
        const { markdown } = buildReport({ includeContent: false, sections: [] });
        expect(markdown).not.toContain('Safe to paste anywhere');
        expect(markdown).toMatch(/skim it before pasting/i);
    });
});

// ─── Live collectors (smoke) ─────────────────────────────────────────────────

describe('collectReportSections (smoke)', () => {
    test('returns guarded sections that build into a report', () => {
        const sections = collectReportSections();
        expect(Array.isArray(sections)).toBe(true);
        for (const s of sections) {
            expect(typeof s.id).toBe('string');
            expect(typeof s.title).toBe('string');
            expect('data' in s).toBe(true);
        }
        const ids = sections.map(s => s.id);
        expect(ids).toEqual(expect.arrayContaining(['settings', 'settingsProvenance', 'lastRuns', 'apiCalls', 'events', 'injections']));

        for (const includeContent of [false, true]) {
            const { markdown } = buildReport({ includeContent, sections });
            expect(markdown).toContain('# MWT Diagnostics Report');
            expect(() => appendixFrom(markdown)).not.toThrow();
        }
    });

    test('collectKnownSecrets degrades to an empty list with no SillyTavern runtime', () => {
        expect(collectKnownSecrets()).toEqual([]);
    });
});

