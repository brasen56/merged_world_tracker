import { beforeEach, expect, it, vi } from 'vitest';
import { captureCleanupTarget } from '../knowledge/cleanup_commit.js';
import { ktFetchFromApi } from '../knowledge/lorebook.js';
import { cleanupModelDisclosure } from '../knowledge/cleanup_review.js';
import { scopeStillCurrent } from '../core/scope.js';
import { _resetDiagnostics, getEvents, recordApiCall } from '../core/diagnostics.js';
import { requestDeepConsolidationGroups, estimateDeepGroupingRequest } from '../knowledge/deep_consolidation_groups_request.js';
import { captureDeepConsolidationReview } from '../knowledge/deep_consolidation.js';

vi.mock('../knowledge/cleanup_commit.js', () => ({ captureCleanupTarget: vi.fn() }));
vi.mock('../knowledge/lorebook.js', () => ({ ktFetchFromApi: vi.fn() }));
vi.mock('../knowledge/settings.js', () => ({ hasValidSettings: () => true }));
vi.mock('../core/scope.js', async original => ({ ...await original(), scopeStillCurrent: vi.fn() }));
vi.mock('../knowledge/cleanup_review.js', async original => ({ ...await original(), cleanupModelDisclosure: vi.fn() }));
const content = 'PRIVATE DOSSIER\nKnowledge Ledger:\n- PRIVATE PIN\n- gate\n- correction\n- PRIVATE RECENT';
const options = { name: 'Mara', uid: 7, throughSource: 3, pins: [1] };
const answer = (_p, payload) => JSON.stringify({ version: 1, reviewId: /<review_id>(.*?)<\/review_id>/.exec(payload)[1], groups: [{ label: 'Gate', s: [2, 3] }] });
beforeEach(() => {
    vi.clearAllMocks();
    _resetDiagnostics();
    scopeStillCurrent.mockReturnValue({ ok: true });
    captureCleanupTarget.mockResolvedValue({ name: 'Mara', uid: 7, originalContent: content, scopeToken: {} });
    cleanupModelDisclosure.mockReturnValue({ mode: 'custom', modelName: 'test', maxTokens: 8000 });
    ktFetchFromApi.mockImplementation(answer);
});

it('uses fresh identity, one manual attempt and privacy-safe matched diagnostics', async () => {
    ktFetchFromApi.mockImplementation((prompt, payload, transport) => {
        recordApiCall({ requestDiagnostics: transport.requestDiagnostics, finish_reason: 'stop', usage: { completion_tokens: 42 } });
        return answer(prompt, payload);
    });
    const first = await requestDeepConsolidationGroups(options);
    const second = await requestDeepConsolidationGroups(options);
    expect(first.selection.review.reviewId).not.toBe(second.selection.review.reviewId);
    const [, payload, transport] = ktFetchFromApi.mock.calls[0];
    expect(payload).not.toMatch(/PRIVATE|active_budget/);
    expect(transport).toMatchObject({ retries: 0, trigger: 'manual', requestDiagnostics: { operation: 'deep-consolidation-groups', sourceCount: 2 } });
    expect(first.requestFacts).toMatchObject({ completionTokens: 42, finishReason: 'stop', attempt: 1 });
    expect(JSON.stringify(getEvents({ module: 'knowledge' }))).not.toMatch(/PRIVATE|Gate/);
});

it('normalizes malformed group data instead of rejecting, including unknown versions', async () => {
    ktFetchFromApi.mockImplementation((p, u) => {
        const wire = JSON.parse(answer(p, u));
        return JSON.stringify({ ...wire, version: 8, groups: [{ label: 'Gate', s: [2, 2, 1, 4, 999] }] });
    });
    const result = await requestDeepConsolidationGroups(options);
    expect(result.groups[0].s).toEqual([2]);
    expect(result.ungrouped).toEqual([3]);
    expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
});

it.each(['not JSON PRIVATE', '{"reviewId":"wrong","groups":[]}'])('fails only parse/identity, retains raw privately and never retries: %s', async raw => {
    ktFetchFromApi.mockResolvedValue(raw);
    const error = await requestDeepConsolidationGroups(options).catch(e => e);
    expect(error.deepConsolidationFailure.rawResponse).toBe(raw);
    expect(error.message).toContain('No automatic retry');
    expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(getEvents({ module: 'knowledge' }))).not.toContain(raw);
});

it('blocks budget excess/all pins without dispatch and estimates every eligible number once', async () => {
    const selection = captureDeepConsolidationReview(content, options);
    const estimate = estimateDeepGroupingRequest({ name: 'Mara', selection });
    expect(estimate.estimate.sourceCount).toBe(2);
    expect(estimate.estimate.contextLimit.value).toBeNull();
    cleanupModelDisclosure.mockReturnValue({ maxTokens: 1 });
    await expect(requestDeepConsolidationGroups(options)).rejects.toThrow('Group by position');
    cleanupModelDisclosure.mockReturnValue({ maxTokens: 8000 });
    await expect(requestDeepConsolidationGroups({ ...options, pins: [1, 2, 3] })).rejects.toThrow('nothing to send');
    expect(ktFetchFromApi).not.toHaveBeenCalled();
});

it('guards consented snapshots and cancellation before and after dispatch', async () => {
    await expect(requestDeepConsolidationGroups({ ...options, expectedCapture: { originalContent: 'changed', scopeToken: {} } })).rejects.toThrow('Close and reopen');
    const controller = new AbortController();
    controller.abort();
    await expect(requestDeepConsolidationGroups({ ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ktFetchFromApi).not.toHaveBeenCalled();
    ktFetchFromApi.mockImplementation((...args) => {
        scopeStillCurrent.mockReturnValue({ ok: false });
        return answer(...args);
    });
    await expect(requestDeepConsolidationGroups(options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
});