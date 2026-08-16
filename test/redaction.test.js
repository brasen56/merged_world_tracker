/**
 * test/redaction.test.js — Phase 5 tests for core/redaction.js.
 *
 * The redaction layer is the hard gate for every later diagnostics tab: the
 * copy-report is the point of the feature and its biggest leak vector, so
 * these tests pin the one contract that must never regress — SECRETS NEVER
 * SURVIVE, in either content mode.
 *
 * Pure module: no stubs, no SillyTavern runtime.
 */

import { describe, test, expect } from 'vitest';

import {
    REDACTED,
    redactApiUrl,
    redactCustomHeaders,
    redactSecretsDeep,
    redactForReport,
} from '../core/redaction.js';

const SECRET_API_KEY = 'sk-super-secret-123';
const SECRET_HEADER_VALUE = 'hunter2';

// ─── redactApiUrl (host only) ────────────────────────────────────────────────

describe('redactApiUrl (host only)', () => {
    test('keeps scheme + host, drops path, query, and fragment', () => {
        expect(redactApiUrl('https://api.example.com/v1/chat?key=abc#frag'))
            .toBe('https://api.example.com');
    });

    test('keeps a non-default port (part of the host)', () => {
        expect(redactApiUrl('http://localhost:8080/v1')).toBe('http://localhost:8080');
    });

    test('drops embedded credentials', () => {
        expect(redactApiUrl('https://user:pass@proxy.example.com/v1')).toBe('https://proxy.example.com');
    });

    test('unparseable input is redacted wholesale, never echoed', () => {
        expect(redactApiUrl('api.example.com')).toBe(REDACTED);
        expect(redactApiUrl('not a url at all')).toBe(REDACTED);
    });

    test('empty input stays empty', () => {
        expect(redactApiUrl('')).toBe('');
        expect(redactApiUrl(null)).toBe('');
        expect(redactApiUrl(undefined)).toBe('');
    });
});

// ─── redactCustomHeaders (names kept, values redacted) ───────────────────────

describe('redactCustomHeaders', () => {
    test('redacts every value, keeps the names', () => {
        const out = redactCustomHeaders(`{"X-Api-Key": "${SECRET_HEADER_VALUE}", "X-Custom": "v"}`);
        const parsed = JSON.parse(out);
        expect(Object.keys(parsed).sort()).toEqual(['X-Api-Key', 'X-Custom']);
        expect(parsed['X-Api-Key']).toBe(REDACTED);
        expect(parsed['X-Custom']).toBe(REDACTED);
        expect(out).not.toContain(SECRET_HEADER_VALUE);
    });

    test('unparseable JSON is redacted wholesale (may carry auth in any shape)', () => {
        expect(redactCustomHeaders('Authorization: Bearer lol')).toBe(REDACTED);
    });

    test('non-object JSON (array / bare primitive) is redacted wholesale', () => {
        expect(redactCustomHeaders('["a","b"]')).toBe(REDACTED);
        expect(redactCustomHeaders('"just a string"')).toBe(REDACTED);
    });

    test('empty input stays empty', () => {
        expect(redactCustomHeaders('')).toBe('');
        expect(redactCustomHeaders('   ')).toBe('');
    });
});

// ─── redactForReport — the contract: secrets never survive in EITHER mode ────

describe('redactForReport', () => {
    const settings = {
        apiUrl: 'https://api.example.com/v1',
        apiKey: SECRET_API_KEY,
        customHeaders: `{"X-Api-Key": "${SECRET_HEADER_VALUE}"}`,
        modelName: 'gpt-test',   // telemetry — must survive
        maxTokens: 2000,
    };

    test('content EXCLUDED: secrets gone, telemetry kept, content marked', () => {
        const out = redactForReport({
            settings,
            injections: [{ key: 'mwt_world_state_injection', payload: 'The princess is in another castle.', role: 0, depth: 4 }],
        }, { includeContent: false });

        expect(out.settings.apiKey).toBe(REDACTED);
        expect(out.settings.apiUrl).toBe('https://api.example.com');
        expect(JSON.parse(out.settings.customHeaders)['X-Api-Key']).toBe(REDACTED);
        expect(out.settings.modelName).toBe('gpt-test');
        expect(out.settings.maxTokens).toBe(2000);

        expect(out.injections[0].payload).toMatch(/^\[content excluded — \d+ chars\]$/);
        expect(out.injections[0].payload).not.toContain('princess');
        expect(out.injections[0].key).toBe('mwt_world_state_injection'); // key names are not content
    });

    test('content INCLUDED: payload passes through, but secrets are STILL redacted', () => {
        const out = redactForReport({
            settings,
            injections: [{ key: 'k', payload: 'visible now' }],
        }, { includeContent: true });

        expect(out.injections[0].payload).toBe('visible now');
        expect(out.settings.apiKey).toBe(REDACTED);
        expect(out.settings.apiUrl).toBe('https://api.example.com');
        expect(JSON.parse(out.settings.customHeaders)['X-Api-Key']).toBe(REDACTED);
    });

    test('the raw secrets appear nowhere in the serialized output of either mode', () => {
        const input = {
            apiUrl: 'https://api.example.com/secret-path',
            apiKey: SECRET_API_KEY,
            customHeaders: `{"X-Api-Key": "${SECRET_HEADER_VALUE}"}`,
            payload: 'some chat text',
        };
        for (const includeContent of [false, true]) {
            const serialized = JSON.stringify(redactForReport(input, { includeContent }));
            expect(serialized).not.toContain(SECRET_API_KEY);
            expect(serialized).not.toContain(SECRET_HEADER_VALUE);
            expect(serialized).not.toContain('secret-path');
        }
    });

    test('redacts secret keys at any depth, including per-module settings objects', () => {
        const out = redactForReport({
            modules: { chronicle: { settings: { apiKey: SECRET_API_KEY, note: 'keep' } } },
        });
        expect(out.modules.chronicle.settings.apiKey).toBe(REDACTED);
        expect(out.modules.chronicle.settings.note).toBe('keep');
    });

    test('Authorization key (any case) is redacted', () => {
        const out = redactForReport({ headers: { Authorization: 'Bearer x', authorization: 'Bearer y' } });
        expect(out.headers.Authorization).toBe(REDACTED);
        expect(out.headers.authorization).toBe(REDACTED);
    });

    test('does not mutate the input; handles arrays, cycles, and primitives', () => {
        const input = { apiKey: SECRET_API_KEY, list: [{ apiKey: 'k2' }] };
        const out = redactForReport(input);
        expect(input.apiKey).toBe(SECRET_API_KEY);      // untouched
        expect(out.list[0].apiKey).toBe(REDACTED);      // nested redacted
        expect(out).not.toBe(input);                    // a copy

        const cyclic = { a: 1 };
        cyclic.self = cyclic;
        expect(() => JSON.stringify(redactForReport(cyclic))).not.toThrow();

        expect(redactForReport(null)).toBe(null);
        expect(redactForReport(42)).toBe(42);
        expect(redactForReport('plain')).toBe('plain');
    });

    test('empty content stays empty rather than growing a marker', () => {
        expect(redactForReport({ payload: '' }).payload).toBe('');
        expect(redactForReport({ payload: null }).payload).toBe(null);
        expect(redactForReport({ messages: [] }).messages).toMatch(/0 item/);
    });

    // ── Fail-closed on shapes the key rules cannot inspect ──────────────────

    test('a non-plain object is described, never passed through with its fields', () => {
        class STSettings {
            constructor() {
                this.apiKey = SECRET_API_KEY;
                this.apiUrl = 'https://proxy.example.com/v1/KEY';
            }
        }
        const out = redactForReport({ settings: new STSettings() });
        expect(out.settings).toBe('[unserializable STSettings]');
        expect(JSON.stringify(out)).not.toContain(SECRET_API_KEY);
    });

    test('Map/Set carry no inspectable fields either', () => {
        const out = redactForReport({ m: new Map([['apiKey', SECRET_API_KEY]]), s: new Set([SECRET_API_KEY]) });
        expect(out.m).toBe('[unserializable Map]');
        expect(out.s).toBe('[unserializable Set]');
        expect(JSON.stringify(out)).not.toContain(SECRET_API_KEY);
    });

    test('Date is the one exception — kept as its ISO form (diagnostic, cannot hide a field)', () => {
        const out = redactForReport({ when: new Date('2026-08-16T00:00:00.000Z') });
        expect(out.when).toBe('2026-08-16T00:00:00.000Z');
        expect(redactForReport({ when: new Date(NaN) }).when).toBe('[Invalid Date]');
    });

    test('null-prototype objects are still walked (the diagnostics maps use them)', () => {
        const nullProto = Object.create(null);
        nullProto.apiKey = SECRET_API_KEY;
        nullProto.module = 'knowledge';
        const out = redactForReport({ runs: nullProto });
        expect(out.runs.apiKey).toBe(REDACTED);
        expect(out.runs.module).toBe('knowledge');
    });

    // ── Cycles vs. DAGs ─────────────────────────────────────────────────────

    test('an object referenced twice is rendered twice, not mislabelled [Circular]', () => {
        const shared = { chars: 12, module: 'world_state' };
        const out = redactForReport({ first: shared, second: shared });
        expect(out.first).toEqual({ chars: 12, module: 'world_state' });
        expect(out.second).toEqual({ chars: 12, module: 'world_state' });
        expect(out.second).not.toBe(out.first); // a copy each, sharing nothing
    });

    test('a real cycle is still cut', () => {
        const node = { name: 'a' };
        node.self = node;
        expect(redactForReport(node)).toEqual({ name: 'a', self: '[Circular]' });

        const a = { name: 'a' };
        const b = { name: 'b', a };
        a.b = b;
        expect(() => JSON.stringify(redactForReport(a))).not.toThrow();
    });
});

// ─── Rule 1b: secrets hiding in free text ───────────────────────────────────
//
// The key-name rules cannot see these. Each case below is a string MWT
// actually produces today (core/api.js error construction, captured by
// core/notifications.js into the event ring).

describe('string scrubbing (secrets embedded in free text)', () => {
    // Error bodies now require the content opt-in (see the error-gating
    // describe below), so tests that assert what the SCRUBBED body looks like
    // pass includeContent: true — that is the mode where the text is visible.
    test('an endpoint URL inside an error message is reduced to its host', () => {
        // core/api.js:200 — the HTML-response error quotes the resolved endpoint,
        // which is exactly the key-in-path URL redactApiUrl() exists to strip.
        const out = redactForReport({
            error: 'API URL returned HTML instead of JSON (404). Check the API URL — resolved to: '
                + '"https://proxy.example.com/v1/sk-live-abcdef123456/chat/completions".',
        }, { includeContent: true });
        expect(out.error).not.toContain('sk-live-abcdef123456');
        expect(out.error).toContain('https://proxy.example.com');
        expect(out.error).toContain('returned HTML instead of JSON (404)'); // still diagnostic
    });

    test('a vendor-prefixed key inside an upstream error body is redacted', () => {
        // core/api.js:210 — `API error ${status}: ${errText}`, errText being the
        // raw upstream body. This is OpenAI's literal 401 response.
        const out = redactForReport({
            error: 'API error 401: {"error":{"message":"Incorrect API key provided: sk-live-abcdef123456"}}',
        }, { includeContent: true });
        expect(out.error).not.toContain('sk-live-abcdef123456');
        expect(out.error).toContain(REDACTED);
        expect(out.error).toContain('API error 401');
    });

    test('bearer tokens and other vendor key shapes are redacted', () => {
        const out = redactForReport({
            a: 'sent header Authorization: Bearer abcdef1234567890xyz',
            b: 'groq said gsk_ABCDEFGHIJKLMNOPQRST failed',
            c: 'google key AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6',
        });
        expect(out.a).not.toContain('abcdef1234567890xyz');
        expect(out.b).not.toContain('gsk_ABCDEFGHIJKLMNOPQRST');
        expect(out.c).not.toContain('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6');
    });

    test('knownSecrets strikes out a key with no recognizable shape', () => {
        // No vendor prefix and no 'Bearer/Token' lead-in, so nothing but an
        // exact-value match can catch this one.
        const bare = 'q7Wm3Zx9Lp2Rv8Tk';
        const message = `upstream rejected ${bare} for this account`;
        expect(redactForReport({ note: message }).note).toBe(message);   // pattern rules: invisible
        expect(redactForReport({ note: message }, { knownSecrets: [bare] }).note)
            .toBe(`upstream rejected ${REDACTED} for this account`);
        // The same scrub reaches inside an opted-in error body.
        expect(redactForReport({ error: message }, { knownSecrets: [bare], includeContent: true }).error)
            .toBe(`upstream rejected ${REDACTED} for this account`);
    });

    test('a value introduced as a token/bearer is caught even without knownSecrets', () => {
        const out = redactForReport({ note: 'proxy rejected token q7Wm3Zx9Lp2Rv8Tk for user' });
        expect(out.note).not.toContain('q7Wm3Zx9Lp2Rv8Tk');
    });

    test('knownSecrets ignores empty/whitespace/non-string entries — those would shred every string', () => {
        const out = redactForReport(
            { note: 'a perfectly ordinary diagnostic line' },
            { knownSecrets: ['', '   ', null, undefined, 42] },
        );
        expect(out.note).toBe('a perfectly ordinary diagnostic line');
    });

    test('a SHORT configured secret is scrubbed regardless of length', () => {
        // Phase 5 review follow-up: the original 8-char floor let a configured
        // key like 'abc123', echoed by a backend notification, survive into a
        // report. The unconditional secret guarantee wins over possible
        // over-redaction — no length floor.
        const short = 'abc123';
        expect(redactForReport({ note: `backend notification: key ${short} rejected` }, { knownSecrets: [short] }).note)
            .toBe(`backend notification: key ${REDACTED} rejected`);
        // The motivating report path: even an opted-IN report strikes it.
        const out = redactForReport(
            { detail: { message: `upstream says ${short} is invalid` } },
            { includeContent: true, knownSecrets: [short] },
        );
        expect(out.detail.message).not.toContain(short);
        // Longest first: the 9-char known value is replaced WHOLE — a
        // shortest-first order would shatter it into 'abc123' + a leftover
        // '456' fragment. Nothing but the two markers may remain.
        expect(redactForReport({ note: 'key: abc123456; pin: abc123' }, { knownSecrets: ['abc123456', 'abc123'] }).note)
            .toBe(`key: ${REDACTED}; pin: ${REDACTED}`);
    });

    test('scrubbing applies in BOTH content modes', () => {
        const input = { payload: 'prompt text mentioning sk-live-abcdef123456' };
        for (const includeContent of [false, true]) {
            const serialized = JSON.stringify(redactForReport(input, { includeContent }));
            expect(serialized).not.toContain('sk-live-abcdef123456');
        }
    });

    test('ordinary diagnostic strings are left alone (no false positives)', () => {
        const out = redactForReport({
            module: 'mwt_world_state_injection',
            model: 'gpt-4o-mini',
            scopeKey: 'char:Mira|chat:2026-08-16@14h30m',
            uid: '3f8a1c2e-9b4d-4e7a-8c1f-2d5b6a9e0c34',
            note: 'skipped: no changes detected',
        });
        expect(out.module).toBe('mwt_world_state_injection');
        expect(out.model).toBe('gpt-4o-mini');
        expect(out.scopeKey).toBe('char:Mira|chat:2026-08-16@14h30m');
        expect(out.uid).toBe('3f8a1c2e-9b4d-4e7a-8c1f-2d5b6a9e0c34');
        expect(out.note).toBe('skipped: no changes detected');
    });
});

// ─── Rule 2: the event ring is chat content ─────────────────────────────────

describe('captured notification bodies (core/notifications.js event shape)', () => {
    /** The exact shape record() stores for every toast. */
    const notifyEvent = (title, message) => ({
        ts: 1_755_300_000_000,
        epoch: 3,
        level: 'info',
        module: 'notify',
        event: title,
        detail: { title, message },
        scopeKey: 'chat:abc',
    });

    test('a story beat quoted in a toast does not survive with the opt-in off', () => {
        // story_planner/index.js:253 quotes the beat text into the toast body.
        const beat = 'Mira confesses she poisoned the duke';
        const out = redactForReport(
            [notifyEvent('Story Planner', `Waiting 6 turns: "${beat}". Type /wt-beat to review.`)],
            { includeContent: false },
        );
        expect(JSON.stringify(out)).not.toContain(beat);
        expect(out[0].detail.message).toMatch(/^\[content excluded — \d+ chars\]$/);
    });

    test('the diagnostic envelope survives — only the body is gated', () => {
        const out = redactForReport([notifyEvent('Knowledge Tracker', 'Catch-up finished for Mira Vance: +3 observation(s).')], {
            includeContent: false,
        });
        expect(JSON.stringify(out)).not.toContain('Mira Vance');
        expect(out[0].detail.title).toBe('Knowledge Tracker');
        expect(out[0].event).toBe('Knowledge Tracker');
        expect(out[0].module).toBe('notify');
        expect(out[0].level).toBe('info');
        expect(out[0].ts).toBe(1_755_300_000_000);
        expect(out[0].epoch).toBe(3);
    });

    test('opting in returns the body — but still scrubbed of secrets', () => {
        const out = redactForReport(
            [notifyEvent('Knowledge Tracker', 'Catch-up failed for Mira Vance: API error 401 (key sk-live-abcdef123456)')],
            { includeContent: true },
        );
        expect(out[0].detail.message).toContain('Mira Vance');
        expect(out[0].detail.message).not.toContain('sk-live-abcdef123456');
    });

    test('user-authored customPrompt is treated as a prompt body', () => {
        const custom = 'Always track the tavern cellar and Mira’s debt to the duke.';
        const out = redactForReport({ settings: { customPrompt: custom } }, { includeContent: false });
        expect(JSON.stringify(out)).not.toContain('Mira');
        expect(redactForReport({ settings: { customPrompt: custom } }, { includeContent: true }).settings.customPrompt)
            .toBe(custom);
    });

    test('Story Planner’s real prompt setting names are content (customSystemPrompt / customUserPrompt)', () => {
        // story_planner/settings.js — buildSystemPrompt()/buildUserPrompt() read
        // these; the Phase 5 review caught the content-key list missing them.
        const sys = 'You plan arcs for the tavern cellar conspiracy.';
        const user = 'Plan the next beats grounded in {{chatHistory}}.';
        const off = redactForReport({ settings: { customSystemPrompt: sys, customUserPrompt: user } }, { includeContent: false });
        expect(off.settings.customSystemPrompt).toMatch(/^\[content excluded — \d+ chars\]$/);
        expect(off.settings.customUserPrompt).toMatch(/^\[content excluded — \d+ chars\]$/);
        const on = redactForReport({ settings: { customSystemPrompt: sys, customUserPrompt: user } }, { includeContent: true });
        expect(on.settings.customSystemPrompt).toBe(sys);
        expect(on.settings.customUserPrompt).toBe(user);
    });

    test('pinnedEntities is chat-derived content (comma-separated character names)', () => {
        // world_state/settings.js — names that never expire; names ARE the
        // chat-derived part.
        const names = 'Mira Vance, Duke Aboud';
        const off = redactForReport({ settings: { pinnedEntities: names } }, { includeContent: false });
        expect(JSON.stringify(off)).not.toContain('Mira');
        expect(off.settings.pinnedEntities).toMatch(/^\[content excluded — \d+ chars\]$/);
        expect(redactForReport({ settings: { pinnedEntities: names } }, { includeContent: true }).settings.pinnedEntities)
            .toBe(names);
    });
});

// ─── Rule 2 (error bodies): errors can quote the chat ────────────────────────

describe('error bodies are gated like content', () => {
    test('a chat-quoted error does not survive with the opt-in off', () => {
        // The exact shape the Phase 5 review caught shipping in a
        // content-EXCLUDED report: core/api.js interpolates the model's own
        // output into the error string.
        const err = 'API returned no content. Response: Mara confesses she poisoned the duke.';
        const out = redactForReport({ knowledge: { ok: false, error: err } });
        expect(JSON.stringify(out)).not.toContain('Mara confesses');
        expect(out.knowledge.ok).toBe(false);   // the failure itself stays visible
        expect(out.knowledge.error).toMatch(/^\[error excluded — \d+ chars\]$/);
    });

    test('the raw body returns with the opt-in on — the separately gated raw error', () => {
        const err = 'API returned no content. Response: Mara confesses she poisoned the duke.';
        expect(redactForReport({ knowledge: { ok: false, error: err } }, { includeContent: true }).knowledge.error)
            .toBe(err);
    });

    test('an opted-in error body is STILL scrubbed of secrets', () => {
        const out = redactForReport(
            { error: 'API error 401: {"error":{"message":"Incorrect API key provided: sk-live-abcdef123456"}}' },
            { includeContent: true },
        );
        expect(out.error).not.toContain('sk-live-abcdef123456');
        expect(out.error).toContain('API error 401');
    });

    test('a null error means "no error" and stays null (last-run success stamps)', () => {
        const out = redactForReport({ knowledge: { ok: true, error: null, tokensIn: 120 } });
        expect(out.knowledge.error).toBeNull();
        expect(out.knowledge.ok).toBe(true);
    });

    test('collectionError (a guarded collector that threw) is gated too', () => {
        // V8 SyntaxError messages quote a snippet of the text that failed to
        // parse — which can be chat data.
        const msg = 'Unexpected token } in JSON at position 42';
        expect(redactForReport({ collectionError: msg }).collectionError)
            .toMatch(/^\[error excluded — \d+ chars\]$/);
        expect(redactForReport({ collectionError: msg }, { includeContent: true }).collectionError).toBe(msg);
    });

    test('an error key in an event detail (any case) is gated; adjacent telemetry is not', () => {
        const out = redactForReport({
            events: [{ level: 'warn', event: 'wi_script_unavailable', detail: { stage: 'import-failed', error: 'world-info.js threw X' } }],
        });
        expect(out.events[0].detail.error).toMatch(/^\[error excluded — \d+ chars\]$/);
        expect(out.events[0].detail.stage).toBe('import-failed');
        expect(out.events[0].event).toBe('wi_script_unavailable');
    });

    test('an unknown shape under an error key never passes through', () => {
        expect(redactForReport({ error: { nested: 'text' } }).error).toBe(REDACTED);
        expect(redactForReport({ error: ['a', 'b'] }).error).toBe('[error excluded — 2 item(s)]');
        expect(redactForReport({ error: '' }).error).toBe('');
    });
});

// ─── Auth header names beyond Authorization ─────────────────────────────────

describe('auth header names', () => {
    test('vendor auth headers are redacted in a structured headers object', () => {
        const out = redactForReport({
            headers: {
                'api-key': 'azure-secret-value',
                'X-Api-Key': 'anthropic-secret-value',
                'x-goog-api-key': 'google-secret-value',
                'Proxy-Authorization': 'Basic c2VjcmV0OnBhaXI=',
                'Content-Type': 'application/json',  // not a secret — must survive
            },
        });
        expect(out.headers['api-key']).toBe(REDACTED);
        expect(out.headers['X-Api-Key']).toBe(REDACTED);
        expect(out.headers['x-goog-api-key']).toBe(REDACTED);
        expect(out.headers['Proxy-Authorization']).toBe(REDACTED);
        expect(out.headers['Content-Type']).toBe('application/json');
    });
});

// ─── redactSecretsDeep (telemetry-only surfaces) ─────────────────────────────

describe('redactSecretsDeep', () => {
    test('redacts secrets without gating content fields', () => {
        const out = redactSecretsDeep({ apiKey: SECRET_API_KEY, payload: 'telemetry-ish text' });
        expect(out.apiKey).toBe(REDACTED);
        expect(out.payload).toBe('telemetry-ish text');
    });
});

