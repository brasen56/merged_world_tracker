import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
    getPhase7Metrics, incrementPhase7Metrics, recordPhase7Request, recordPhase7Metrics,
} from '../story_planner/data.js';
import {
    sanitizePhase7Metrics, STORY_PLANNER_METRIC_COUNTER_MAX, validateStoryPlannerData,
} from '../story_planner/schema.js';
import { getPlannerObservation } from '../story_planner/index.js';
import { getFakeMeta, resetCoreStubs } from './stubs/core.js';

beforeEach(() => {
    resetCoreStubs();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
});

describe('Story Planner Phase 7 — bounded per-chat observation', () => {
    test('canonicalizes counters, timestamps, kinds, flags, and drops content fields', () => {
        const metrics = sanitizePhase7Metrics({
            startedAt: -1, updatedAt: 12.9,
            fullGenerations: STORY_PLANNER_METRIC_COUNTER_MAX + 5,
            scopedRequests: -2, scopedRequestChars: '55.9',
            targetedGenerations: -3, requestChars: '42.8',
            lastRequestKind: 'prompt text', lastRequestChars: Infinity,
            lastProgressUpToDate: true, lastProgressStale: 'yes',
            prompt: 'must not persist', story: 'must not persist',
        });

        expect(metrics).toMatchObject({
            startedAt: 0, updatedAt: 12,
            fullGenerations: STORY_PLANNER_METRIC_COUNTER_MAX,
            scopedRequests: 0, scopedRequestChars: 55,
            targetedGenerations: 0, requestChars: 42,
            lastRequestKind: '', lastRequestChars: 0,
            lastProgressUpToDate: true, lastProgressStale: false,
        });
        expect(metrics).not.toHaveProperty('prompt');
        expect(metrics).not.toHaveProperty('story');
    });

    test('schema validation persists only the canonical bounded metric shape', () => {
        const result = validateStoryPlannerData({
            phase7Metrics: { requestCount: -1, maxRequestChars: 99.9, lastRequestKind: 'scoped', scopedRequests: 2, scopedRequestChars: 500, secret: 'content' },
        });
        expect(result.data.phase7Metrics).toMatchObject({ requestCount: 0, maxRequestChars: 99, lastRequestKind: 'scoped', scopedRequests: 2, scopedRequestChars: 500 });
        expect(result.data.phase7Metrics).not.toHaveProperty('secret');
        expect(result.issues.map(issue => issue.code)).toContain('phase7-metrics-canonicalized');
    });

    test('helpers accumulate request sizes per chat and expose derived averages', () => {
        recordPhase7Metrics({ fullGenerations: 1 });
        incrementPhase7Metrics({ targetedGenerations: 2 });
        recordPhase7Request('full', 100);
        recordPhase7Request('scoped', 75);
        recordPhase7Request('scoped', 125); // Retry is a second outbound request, not a second generation.
        recordPhase7Request('progress', 250);

        expect(getFakeMeta().story_planner_data.phase7Metrics).toEqual(getPhase7Metrics());
        expect(getPhase7Metrics()).toMatchObject({
            startedAt: Date.now(), updatedAt: Date.now(),
            fullGenerations: 1, targetedGenerations: 2,
            requestCount: 4, requestChars: 550, maxRequestChars: 250,
            scopedRequests: 2, scopedRequestChars: 200,
            lastRequestKind: 'progress', lastRequestChars: 250,
        });
        expect(getPlannerObservation()).toMatchObject({ averageRequestChars: 138, proposalDecisions: 0 });

        resetCoreStubs();
        expect(getPhase7Metrics()).toMatchObject({ requestCount: 0, requestChars: 0 });
    });
});