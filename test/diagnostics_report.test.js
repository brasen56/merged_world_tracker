/**
 * test/diagnostics_report.test.js — Phase 5 + Phase 13 tests for the
 * copy-report shape (diagnostics_panel/report.js — decision D1: Markdown +
 * fenced JSON appendix).
 *
 * buildReport() is pure (sections are passed in), so no stubbing is needed.
 * The tests pin the shape contract: the header states whether content is
 * included, the appendix is valid JSON inside a fence that no payload content
 * can escape, and — the whole point of Phase 5 — secrets never survive in
 * either mode.
 *
 * Phase 13 (copy-report finalize) adds the tab-accessor coverage: the
 * redaction sweep over TAB-SHAPED sections (health / environment / scope /
 * injection / integrity — payload fields gated by the opt-in, identity
 * strings deliberately surviving, secrets scrubbed in both modes) and the
 * async collectReportSections() contract (all eleven section ids, guarded
 * degradation when a collector throws, default wiring under the stub barrel).
 *
 * collectReportSections() gets a smoke test only beyond that: it is a thin
 * guarded pass over accessors that each already have their own coverage
 * (diagnostics / api_diagnostics / injection_diagnostics /
 * settings_provenance / *_tab).
 */

import { describe, test, expect, vi } from 'vitest';

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
    test('returns guarded sections that build into a report', async () => {
        const sections = await collectReportSections();
        expect(Array.isArray(sections)).toBe(true);
        for (const s of sections) {
            expect(typeof s.id).toBe('string');
            expect(typeof s.title).toBe('string');
            expect('data' in s).toBe(true);
        }
        // Phase 0–4 accessors (the Phase 5 shape) + the Phase 13 tab accessors.
        const ids = sections.map(s => s.id);
        expect(ids).toEqual(expect.arrayContaining([
            'settings', 'settingsProvenance', 'lastRuns', 'apiCalls', 'events', 'injections',
            'health', 'environment', 'scope', 'injection', 'integrity',
        ]));

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

// ─── Phase 13: tab-shaped sections (redaction sweep) ─────────────────────────

/** Live-secret shape reused across the tab fixtures below. */
const SECRET = 'sk-live-abcdef123456';
/** Recorded injection payload (fence-breaking backticks + chat prose). */
const TAB_PAYLOAD_TEXT = '```World State``` — Mira Vance trusts the crew';
/** Captured toast body as the scope tab surfaces it (chat content). */
const TOAST_TEXT = 'Knowledge capture fell back to the global scope for this chat';

/**
 * Sections shaped exactly like the five tab collectors' snapshots, carrying
 * the fields the Phase 13 sweep must reason about: a recorded payload
 * (injection), a captured toast body (scope fallback detail), free-text
 * warnings quoting a URL-with-key, and identity strings (names in scope keys
 * and context fields) that are DELIBERATELY allowed to survive — the header
 * says so ("skim it before pasting").
 */
function tabSections() {
    return [
        {
            id: 'health',
            title: 'Health (Phase 6 — one row per module)',
            data: {
                generatedAt: 1, mwtVersion: 'test', injectionMasterOff: false,
                injectedTokens: 10, storedTokens: 5000,
                modules: [{
                    id: 'knowledge', label: 'Knowledge', enabled: true, injectionAllowed: true,
                    busy: false, tokens: 5000, tokenKind: 'stored', auto: null,
                    // lastRun has no error field by construction; the model
                    // string is free text and gets the Rule-1b scrub.
                    lastRun: { at: 123, ok: false, durationMs: 500, source: 'api-call', model: `model-${SECRET}`, status: 500, retries: 1 },
                }],
            },
        },
        {
            id: 'environment',
            title: 'Environment (Phase 7 — fork-compat probe)',
            data: {
                generatedAt: 1, mwtVersion: 'test', stVersion: null, stVersionSource: null,
                contextAvailable: true, contextSource: 'getContext (legacy global)',
                features: [{ id: 'getContext', available: true, detail: 'legacy global' }],
                connectionManager: { probed: true, available: true, constructPrompt: true },
                chatIdPremise: { level: 'ok', method: 'ctx.getCurrentChatId', chatIdValue: 'chats/Mira Vance/2026-08-21.jsonl' },
                // Identity strings (card/chat names) — deliberately not gated.
                contextFields: { 'card.name': 'Mira Vance', 'getCurrentChatId()': 'chats/Mira Vance/2026-08-21.jsonl' },
            },
        },
        {
            id: 'scope',
            title: 'Scope & storage (Phase 8 — which lorebooks, and why)',
            data: {
                generatedAt: 1, mwtVersion: 'test', epoch: 3,
                scopeSetting: { value: 'global', valid: true },
                character: { key: 'mira.png', name: 'Mira Vance' },
                chat: { key: 'chats/Mira Vance/2026-08-21.jsonl' },
                resolution: { scope: 'global', valid: true, mode: 'global', identityKey: null, identityName: null, books: {}, note: '', wouldSaveBinding: false },
                books: [], bindings: { count: 0, rows: [] },
                fallbackEvents: {
                    count: 1,
                    // A Phase 3 event as the tab surfaces it — detail.message
                    // is the captured toast body (chat content, CONTENT_KEYS).
                    last: { ts: 2, level: 'warn', module: 'knowledge', event: 'scope_fallback_global', detail: { title: 'Scope fallback', message: TOAST_TEXT } },
                },
                warnings: [{ id: 'scope-fallback', level: 'warn', text: `fell back to global — endpoint https://proxy.example.com/v1/${SECRET}/chat/completions` }],
                bannerLevel: 'warn',
            },
        },
        {
            id: 'injection',
            title: 'Injection status (Phase 9 — content-gated)',
            data: {
                generatedAt: 1, mwtVersion: 'test', injectionMasterOff: false, structuralBoundaries: true,
                livePayloads: 1, registeredTokens: 42,
                modules: [{
                    id: 'world_state', key: 'mwt_world_state_injection', enabled: true, gate: true,
                    placement: null,
                    // The Phase 9 row nests the Phase 2 payload under
                    // snapshot.payload — same CONTENT_KEY, same opt-in gate.
                    snapshot: { present: true, enabled: true, payload: TAB_PAYLOAD_TEXT, chars: TAB_PAYLOAD_TEXT.length, role: 0, depth: 4, at: 1, ageSec: 0 },
                    tokens: { value: 42, kind: 'recorded' }, warnings: [],
                }],
                warnings: [], bannerLevel: 'ok',
            },
        },
        {
            id: 'integrity',
            title: 'Integrity (Phase 12 — on-demand checks)',
            data: {
                generatedAt: 1, mwtVersion: 'test',
                totals: { findings: 1, profileEntries: 2, registryRecords: 1, evidenceFiles: 0, ledgerEntries: 0, sectionsPresent: 0 },
                duplicateProfiles: { count: 1, sample: [{ npc: 'Boris', count: 2, entries: [{ npc: 'Boris', uid: 1, chars: 900, referenced: false }] }], more: 0 },
                danglingProfileUids: { count: 0, sample: [], more: 0 },
                evidenceWithoutProfile: { count: 0, sample: [], more: 0 },
                profilesWithoutEvidence: { count: 0, sample: [], more: 0 },
                bannerLevel: 'warn',
            },
        },
    ];
}

describe('buildReport — Phase 13 tab sections (redaction sweep)', () => {
    test('secrets and embedded URL paths never survive, in either mode', () => {
        for (const includeContent of [false, true]) {
            const { markdown } = buildReport({ includeContent, sections: tabSections() });
            expect(markdown).not.toContain(SECRET);
            // URL-in-free-text is cut to scheme + host — the path (where proxy
            // keys ride) never survives.
            expect(markdown).not.toContain('proxy.example.com/v1');
        }
    });

    test('tab payloads and captured toast bodies are content-gated; identity strings survive', () => {
        const off = buildReport({ includeContent: false, sections: tabSections() });
        expect(off.markdown).not.toContain('trusts the crew');          // injection payload
        expect(off.markdown).not.toContain(TOAST_TEXT);                 // scope fallback detail.message
        expect(off.markdown).toMatch(/\[content excluded — \d+ chars\]/);
        // Identity strings are deliberately allowed (the header says to skim).
        expect(off.markdown).toContain('Mira Vance');
        // The gated fields are size-only markers in the appendix too.
        const appendix = appendixFrom(off.markdown);
        const injRow = appendix.sections.injection.modules[0].snapshot.payload;
        expect(injRow).toMatch(/^\[content excluded — \d+ chars\]$/);
        const fallback = appendix.sections.scope.fallbackEvents.last.detail.message;
        expect(fallback).toMatch(/^\[content excluded — \d+ chars\]$/);
    });

    test('with the opt-in on, gated tab fields return — still scrubbed of secrets', () => {
        const on = buildReport({ includeContent: true, sections: tabSections() });
        expect(on.markdown).toContain('trusts the crew');
        expect(on.markdown).toContain(TOAST_TEXT);
        expect(on.markdown).not.toContain(SECRET);
    });

    test('readings that are not content survive ungated (integrity names, last-run facts)', () => {
        const { markdown, data } = buildReport({ includeContent: false, sections: tabSections() });
        expect(markdown).toContain('Boris');                            // duplicate-profile sample
        const lastRun = data.sections.health.modules[0].lastRun;
        expect(lastRun.ok).toBe(false);                                 // the verdict stays readable
        expect(lastRun.status).toBe(500);
        expect(String(lastRun.model)).not.toContain(SECRET);            // …but the model string is scrubbed
    });
});

// ─── Phase 13: guarded async collection ──────────────────────────────────────

describe('collectReportSections — collector degradation', () => {
    test('a throwing collector degrades to a collectionError section, never a broken report', async () => {
        // Re-import report.js against a health.js mock whose collector throws
        // SYNC — pinning that the guarded helper still awaits around each
        // collector (an async Integrity throw takes the same path).
        vi.resetModules();
        vi.doMock('../diagnostics_panel/health.js', () => ({
            collectHealthSnapshot: () => { throw new Error('collector exploded'); },
        }));
        try {
            const { collectReportSections: collect } = await import('../diagnostics_panel/report.js');
            const sections = await collect();
            const health = sections.find((s) => s.id === 'health');
            expect(health).toBeTruthy();
            expect(String(health.data.collectionError)).toContain('collector exploded');
            // The failed section still builds a report. collectionError is an
            // ERROR_KEY: size-only marker with the opt-in off, raw (still
            // scrubbed) with it on — the parse-failed-text rationale in
            // core/redaction.js.
            const off = buildReport({ includeContent: false, sections });
            expect(off.markdown).toMatch(/\[error excluded — \d+ chars\]/);
            const on = buildReport({ includeContent: true, sections });
            expect(on.markdown).toContain('collector exploded');
        } finally {
            vi.doUnmock('../diagnostics_panel/health.js');
            vi.resetModules();
        }
    });
});

