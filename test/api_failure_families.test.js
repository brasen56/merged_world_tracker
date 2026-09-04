/**
 * test/api_failure_families.test.js — TODO §6 "API fakes": the failure
 * families test/api_diagnostics.test.js leaves open (429 / 5xx / 4xx /
 * timeout / truncation / malformed).
 *
 * Each family is pinned on BOTH sides of the contract:
 *
 *   1. the wire behavior — which failures retry, which are fatal after a
 *      single attempt, what exhaustion looks like, and the exponential
 *      backoff between attempts; and
 *   2. the diagnostics capture — status / retries / errorClass / ok in the
 *      api-call ring (what the 📡 Last request tab reports about a failure).
 *
 * The success-capture, HTML-response, and empty-success families are already
 * pinned in test/api_diagnostics.test.js and are not duplicated here.
 *
 * Conventions mirror that file: the real core/api.js, the real diagnostics
 * store, and a local fetch() double.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { _resetDiagnostics, getLastApiCall } from '../core/diagnostics.js';
import { fetchFromApi, fetchViaConnectionProfile } from '../core/api.js';
// The host-module seam: vitest.config.js aliases core/api.js's
// '../../../shared.js' to this file, so importing it here yields the SAME
// module instance — a spy on its ConnectionManagerRequestService is the
// outbound-boundary double for the CM path (what fetch is for the custom one).
import { ConnectionManagerRequestService } from './stubs/shared.js';

beforeEach(() => {
    _resetDiagnostics();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete globalThis.fetch;
});

function response(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: `HTTP ${status}`,
        text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
        json: async () => data,
    };
}

const SETTINGS = { apiUrl: 'https://example.test/v1', modelName: 'test-model' };

/** fetchFromApi with the boilerplate filled in. */
function call(overrides = {}) {
    return fetchFromApi({ systemPrompt: 'system', userContent: 'user', settings: SETTINGS, ...overrides });
}

describe('retryable failures recover on the next attempt', () => {
    test('429 (rate limit) is retried; the eventual success is what lands in the ring', async () => {
        globalThis.fetch = vi.fn()
            .mockImplementationOnce(async () => response('rate limited, back off', 429))
            .mockImplementationOnce(async () => response({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));

        await expect(call({ retries: 2 })).resolves.toBe('ok');

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(getLastApiCall('api')).toMatchObject({ retries: 1, status: 200, ok: true });
    });

    test('5xx is retried; the eventual success is what lands in the ring', async () => {
        globalThis.fetch = vi.fn()
            .mockImplementationOnce(async () => response('upstream exploded', 503))
            .mockImplementationOnce(async () => response({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));

        await expect(call({ retries: 2 })).resolves.toBe('ok');

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(getLastApiCall('api')).toMatchObject({ retries: 1, status: 200, ok: true });
    });

    test('a network rejection (timeout-shaped) is retried and then succeeds', async () => {
        // Node's fetch fails with a TypeError on network errors/aborts — the
        // family a real timeout lands in. It carries no _noRetry marker, so
        // the shared retry loop must treat it as transient.
        globalThis.fetch = vi.fn()
            .mockImplementationOnce(async () => { throw new TypeError('fetch failed'); })
            .mockImplementationOnce(async () => response({ choices: [{ message: { content: 'ok' } }] }));

        await expect(call({ retries: 1 })).resolves.toBe('ok');

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(getLastApiCall('api')).toMatchObject({ retries: 1, ok: true });
    });

    test('truncation (finish_reason "length") is retried; a complete retry succeeds', async () => {
        // The truncated body is a partial the caller must never see; the call
        // is retryable because reasoning models are non-deterministic.
        globalThis.fetch = vi.fn()
            .mockImplementationOnce(async () => response({
                choices: [{ message: { content: '{"npcs": [{"n' }, finish_reason: 'length' }],
                usage: { total_tokens: 10 },
            }))
            .mockImplementationOnce(async () => response({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));

        await expect(call({ retries: 1 })).resolves.toBe('ok');

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(getLastApiCall('api')).toMatchObject({ retries: 1, status: 200, finish_reason: 'stop', ok: true });
    });
});

describe('fatal failures do not retry', () => {
    test('a plain 4xx is fatal after exactly one attempt even with retries available', async () => {
        globalThis.fetch = vi.fn(async () => response('{"error":{"message":"bad request"}}', 400));

        await expect(call({ retries: 3 })).rejects.toThrow('API error 400');

        // Only 5xx and 429 are retryable — a 4xx is a permanent client error.
        // errorClass reports the _noRetry marker (it outranks err.name), which
        // is what tells the Last-request tab this failure was deliberately
        // not retried rather than retried-and-failed.
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(getLastApiCall('api')).toMatchObject({ status: 400, retries: 0, ok: false, errorClass: '_noRetry' });
    });
});

describe('retry exhaustion', () => {
    test('a persistent 429 exhausts the retries and surfaces the last status', async () => {
        globalThis.fetch = vi.fn(async () => response('rate limited, back off', 429));

        await expect(call({ retries: 2 })).rejects.toThrow('API error 429');

        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
        expect(getLastApiCall('api')).toMatchObject({ status: 429, retries: 2, ok: false });
    });

    test('persistent truncation rejects with the actionable message, classified _isLengthError', async () => {
        globalThis.fetch = vi.fn(async () => response({
            choices: [{ message: { content: 'half a JSON object' }, finish_reason: 'length' }],
        }));

        await expect(call({ retries: 1 })).rejects.toThrow(/Response truncated/);

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(getLastApiCall('api')).toMatchObject({ retries: 1, errorClass: '_isLengthError', ok: false });
    });

    test('a malformed success body (invalid JSON) retries and finally rejects as a SyntaxError', async () => {
        const malformed = () => ({
            ok: true,
            status: 200,
            statusText: 'HTTP 200',
            text: async () => '{not json',
            json: async () => { throw new SyntaxError('Unexpected token'); },
        });
        globalThis.fetch = vi.fn(async () => malformed());

        await expect(call({ retries: 1 })).rejects.toBeInstanceOf(SyntaxError);

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(getLastApiCall('api')).toMatchObject({ status: 200, retries: 1, errorClass: 'SyntaxError', ok: false });
    });
});

describe('backoff between attempts', () => {
    test('the second attempt waits out the exponential delay (1s floor) before firing', async () => {
        vi.useFakeTimers();
        globalThis.fetch = vi.fn()
            .mockImplementationOnce(async () => response('upstream exploded', 503))
            .mockImplementationOnce(async () => response({ choices: [{ message: { content: 'ok' } }] }));

        const pending = call({ retries: 2 });
        await vi.advanceTimersByTimeAsync(0); // attempt 1 settles; backoff timer scheduled
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);

        // Still inside the first backoff window (1000 * 2^0 = 1000ms).
        await vi.advanceTimersByTimeAsync(999);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toBe('ok');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
});

// ─── The Connection-Manager half of the contract ──────────────────────────────

describe('fetchViaConnectionProfile — failure families on the parallel CM path', () => {
    // fetchViaConnectionProfile implements the same contract as fetchFromApi
    // a second time over: its own truncation probe, its own _noRetry marking,
    // and no HTTP-status retry gating at all. Drift between the two copies is
    // exactly how a future feature slips past review, so the families above
    // are pinned here too — same fixtures, different entry point.

    // An explicit profile id skips the context probe; panicNow tolerates the
    // absent SillyTavern context (panic stays false).
    const CM_SETTINGS = { connectionProfileId: 'profile-1', maxTokens: 500 };

    function cmCall(overrides = {}) {
        return fetchViaConnectionProfile({ systemPrompt: 'system', userContent: 'user', settings: CM_SETTINGS, retries: 1, ...overrides });
    }

    function stubSendRequest(impl) {
        return vi.spyOn(ConnectionManagerRequestService, 'sendRequest').mockImplementation(impl);
    }

    test('truncation under the extractData shape (no choices array) is still caught', async () => {
        // The shape whose own code comment warns the naive choices-only check
        // "silently misses truncation": with extractData:true the fork returns
        // { content, reasoning } and NO choices — the bug that already
        // happened once. The multi-shape probe must catch finish_reason here.
        stubSendRequest(async () => ({ content: 'half a JSON object', finish_reason: 'length' }));

        await expect(cmCall()).rejects.toThrow(/Response truncated/);

        expect(ConnectionManagerRequestService.sendRequest).toHaveBeenCalledTimes(2); // retried once, then exhausted
        expect(getLastApiCall('api')).toMatchObject({
            mode: 'cm',
            model: 'profile-1',
            retries: 1,
            errorClass: '_isLengthError',
            ok: false,
        });
    });

    test('the camelCase finishReason shape is caught too', async () => {
        stubSendRequest(async () => ({ content: 'cut off mid-sentence', finishReason: 'length' }));

        await expect(cmCall({ retries: 0 })).rejects.toThrow(/Response truncated/);

        expect(getLastApiCall('api')).toMatchObject({ mode: 'cm', retries: 0, errorClass: '_isLengthError', ok: false });
    });

    test.each([
        ['a bare string', 'raw text', 'raw text'],
        ['{ content: string } (Aikobots v4 fork)', { content: 'fork shape' }, 'fork shape'],
        ['{ content: object } (json_schema)', { content: { a: 1 } }, '{"a":1}'],
        ['{ text }', { text: 'text shape' }, 'text shape'],
        ['{ choices[0].message.content }', { choices: [{ message: { content: 'message shape' } }] }, 'message shape'],
        ['{ choices[0].text }', { choices: [{ text: 'completion shape' }] }, 'completion shape'],
    ])('text extraction: %s resolves to the text', async (_label, result, expected) => {
        stubSendRequest(async () => result);

        await expect(cmCall({ retries: 0 })).resolves.toBe(expected);
        expect(getLastApiCall('api')).toMatchObject({ mode: 'cm', model: 'profile-1', ok: true });
    });

    test('a shape nothing recognizes is fatal after exactly one attempt', async () => {
        stubSendRequest(async () => ({ weird: true }));

        await expect(cmCall()).rejects.toThrow(/Unable to extract text from API response/);

        // _noRetry outranks the retries budget — one attempt, no backoff.
        expect(ConnectionManagerRequestService.sendRequest).toHaveBeenCalledTimes(1);
        expect(getLastApiCall('api')).toMatchObject({ mode: 'cm', retries: 0, errorClass: '_noRetry', ok: false });
    });

    test('a rejecting sendRequest is retried to exhaustion — this path has no HTTP-status gating', async () => {
        stubSendRequest(async () => { throw new Error('socket hang up'); });

        await expect(cmCall()).rejects.toThrow('socket hang up');

        expect(ConnectionManagerRequestService.sendRequest).toHaveBeenCalledTimes(2);
        expect(getLastApiCall('api')).toMatchObject({ mode: 'cm', retries: 1, errorClass: 'Error', ok: false });
    });
});

