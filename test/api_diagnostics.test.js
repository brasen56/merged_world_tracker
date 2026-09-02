/** Phase 1 diagnostics coverage for both API telemetry and its bounded store. */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    API_CALL_CAPACITY,
    _resetDiagnostics,
    getApiCalls,
    getEvents,
    getLastApiCall,
    recordApiCall,
} from '../core/diagnostics.js';
import { fetchFromApi, fetchViaConnectionProfile } from '../core/api.js';

beforeEach(() => {
    _resetDiagnostics();
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
});

function response(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: `HTTP ${status}`,
        text: async () => typeof data === 'string' ? data : JSON.stringify(data),
        json: async () => data,
    };
}

describe('API call diagnostics store', () => {
    test('keeps calls newest-first and exposes the last call per module', () => {
        for (let i = 0; i < API_CALL_CAPACITY + 1; i++) {
            recordApiCall({ module: i % 2 ? 'world_state' : 'chronicle', mode: 'custom', model: `m${i}` });
        }

        expect(getApiCalls()).toHaveLength(API_CALL_CAPACITY);
        expect(getApiCalls()[0].model).toBe(`m${API_CALL_CAPACITY}`);
        expect(getLastApiCall('world_state').model).toBe(`m${API_CALL_CAPACITY - 1}`);
        expect(getEvents({ module: 'api' })[0].event).toBe('api_call');
    });
});

describe('fetchFromApi diagnostics', () => {
    test('captures successful custom calls with status, usage, finish reason, and duration', async () => {
        globalThis.fetch = vi.fn(async () => response({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }));

        await fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test/v1', modelName: 'test-model', module: 'world_state' },
            retries: 0,
        });

        const call = getLastApiCall('world_state');
        expect(call).toMatchObject({
            mode: 'custom',
            model: 'test-model',
            retries: 0,
            status: 200,
            finish_reason: 'stop',
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            ok: true,
        });
        expect(call.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('classifies HTML failures without retrying', async () => {
        globalThis.fetch = vi.fn(async () => response('<!DOCTYPE html><html>wrong route</html>', 404));

        await expect(fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test', modelName: 'test-model' },
            retries: 2,
        })).rejects.toThrow('returned HTML');

        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(getLastApiCall('api')).toMatchObject({
            status: 404,
            retries: 0,
            errorClass: 'HTML-response',
            ok: false,
        });
    });

    test('classifies an empty successful response as no-content', async () => {
        globalThis.fetch = vi.fn(async () => response({ choices: [{ message: {}, finish_reason: 'stop' }] }));

        await expect(fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test', modelName: 'test-model' },
            retries: 0,
        })).rejects.toThrow('no content');

        expect(getLastApiCall('api').errorClass).toBe('no-content');
    });
});

describe('trigger + panic capture', () => {
    // The telemetry end of the chain pinned by
    // test/interiority_trigger_telemetry.test.js. Together they answer the
    // question a "panic is on and it is STILL spending tokens" report asks:
    // WHAT started this call, and was the switch already on when it left?
    afterEach(() => {
        delete globalThis.SillyTavern;
    });

    function withPanic(on) {
        globalThis.SillyTavern = {
            getContext: () => ({ extensionSettings: { merged_world_tracker: { injectionMasterOff: on } } }),
        };
    }

    test('stamps the caller-supplied trigger onto the call summary', async () => {
        globalThis.fetch = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }));

        await fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test/v1', modelName: 'test-model', module: 'interiority' },
            retries: 0,
            trigger: 'swipe',
        });

        expect(getLastApiCall('interiority')).toMatchObject({ trigger: 'swipe', panic: false });
    });

    test('omits trigger entirely for modules that do not report one', async () => {
        globalThis.fetch = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }));

        await fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test/v1', modelName: 'test-model', module: 'world_state' },
            retries: 0,
        });

        // Absent, not null: a module that never reports a cause must not read
        // as "this call had no cause".
        expect(getLastApiCall('world_state')).not.toHaveProperty('trigger');
    });

    test('records the panic switch state at FIRE time, not completion time', async () => {
        withPanic(true);
        globalThis.fetch = vi.fn(async () => {
            // Flipped back off while the request is in flight — the capture
            // must still report the state the request LEFT under, which is
            // what says whether a gate leaked.
            withPanic(false);
            return response({ choices: [{ message: { content: 'ok' } }] });
        });

        await fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test/v1', modelName: 'test-model', module: 'interiority' },
            retries: 0,
            trigger: 'message_received',
        });

        expect(getLastApiCall('interiority')).toMatchObject({ trigger: 'message_received', panic: true });
    });

    test('a failed call still records its trigger and panic state', async () => {
        withPanic(true);
        globalThis.fetch = vi.fn(async () => response('<!DOCTYPE html><html>wrong route</html>', 404));

        await expect(fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test', modelName: 'test-model', module: 'interiority' },
            retries: 0,
            trigger: 'edit',
        })).rejects.toThrow('returned HTML');

        expect(getLastApiCall('interiority')).toMatchObject({ trigger: 'edit', panic: true, ok: false });
    });

    test('connection-profile calls carry the trigger too', async () => {
        await fetchViaConnectionProfile({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { connectionProfileId: 'profile-1', module: 'interiority', maxTokens: 100 },
            retries: 0,
            trigger: 'manual',
        });

        expect(getLastApiCall('interiority')).toMatchObject({ mode: 'cm', trigger: 'manual', panic: false });
    });
});

describe('fetchViaConnectionProfile diagnostics', () => {
    test('captures CM mode with profile id and usage', async () => {
        const result = await fetchViaConnectionProfile({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { connectionProfileId: 'profile-1', module: 'knowledge', maxTokens: 100 },
            retries: 0,
        });

        expect(result).toBe('stub response');
        expect(getLastApiCall('knowledge')).toMatchObject({
            mode: 'cm',
            model: 'profile-1',
            status: null,
            finish_reason: 'stop',
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
            ok: true,
        });
    });
});

// ─── Panic sampled at every outbound attempt ─────────────────────────────────
// [P1] Panic sampling: the panic sample used to be taken once at dispatch and
// reused across retries — and on the CM path it preceded the awaited shared.js
// module load, so panic could turn on before sendRequest or a later retry
// actually left while the summary still said panic:false. The summary now
// reports panic:true if the switch was on when the call was dispatched OR when
// ANY single outbound attempt left.

describe('panic sampling at each outbound attempt', () => {
    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.SillyTavern;
    });

    /** Install a SillyTavern context whose panic flag is read live, so a test
     *  can flip the switch mid-flight and later samples see it. */
    function installPanicSwitch() {
        let on = false;
        globalThis.SillyTavern = {
            getContext: () => ({ extensionSettings: { merged_world_tracker: { injectionMasterOff: on } } }),
        };
        return { flipOn: () => { on = true; } };
    }

    test('fetchFromApi: panic flipped on during a retry backoff latches to panic:true', async () => {
        vi.useFakeTimers();
        const sw = installPanicSwitch();
        let call = 0;
        globalThis.fetch = vi.fn(async () => {
            call += 1;
            return call === 1
                ? response('upstream exploded', 500)
                : response({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        });

        const pending = fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test/v1', modelName: 'test-model', module: 'interiority' },
            retries: 2,
            trigger: 'message_received',
        });
        // The user flips the master switch while the 1s backoff before
        // attempt 2 is pending. Attempt 1 legitimately left with panic off;
        // attempt 2 leaves with panic on — the summary must say so.
        sw.flipOn();
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toBe('ok');

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(getLastApiCall('interiority')).toMatchObject({
            trigger: 'message_received',
            panic: true,
            retries: 1,
            status: 200,
            ok: true,
        });
    });

    test('fetchViaConnectionProfile: panic flipped on before the first sendRequest leaves is captured', async () => {
        // The dispatch sample happens BEFORE the awaited shared.js module
        // load; the profile probe (which reads the context) happens after it.
        // Flipping the switch inside that probe reproduces the reported gap:
        // the switch turned on while the module load was in flight, before
        // any request had left. (The first getContext call is the dispatch
        // sample itself, so it still reads the switch as off.)
        let panicOn = false;
        globalThis.SillyTavern = {
            getContext: () => {
                const ctx = {
                    extensionSettings: {
                        merged_world_tracker: { injectionMasterOff: panicOn },
                        connectionManager: { selectedProfile: 'ctx-profile' },
                    },
                };
                panicOn = true;
                return ctx;
            },
        };

        // No connectionProfileId — forces the context-probe path.
        await fetchViaConnectionProfile({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { module: 'interiority', maxTokens: 100 },
            retries: 0,
            trigger: 'message_received',
        });

        expect(getLastApiCall('interiority')).toMatchObject({
            mode: 'cm',
            model: 'ctx-profile',
            trigger: 'message_received',
            panic: true,
            ok: true,
        });
    });

    test('panic never observed at dispatch or any attempt still reports panic:false', async () => {
        installPanicSwitch();
        globalThis.fetch = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }));

        await fetchFromApi({
            systemPrompt: 'system',
            userContent: 'user',
            settings: { apiUrl: 'https://example.test/v1', modelName: 'test-model', module: 'interiority' },
            retries: 1,
            trigger: 'swipe',
        });

        expect(getLastApiCall('interiority')).toMatchObject({ trigger: 'swipe', panic: false, retries: 0 });
    });
});