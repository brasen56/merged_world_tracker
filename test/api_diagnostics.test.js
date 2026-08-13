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