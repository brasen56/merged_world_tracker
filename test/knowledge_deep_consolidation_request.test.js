import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureCleanupTarget } from '../knowledge/cleanup_commit.js';
import { ktFetchFromApi } from '../knowledge/lorebook.js';
import { cleanupModelDisclosure } from '../knowledge/cleanup_review.js';
import { scopeStillCurrent } from '../core/scope.js';
import { clearEvents, getEvents } from '../core/diagnostics.js';
import { hasValidSettings } from '../knowledge/settings.js';
import { requestDeepConsolidation, estimateDeepConsolidationRequest } from '../knowledge/deep_consolidation_request.js';
import { captureDeepConsolidationReview } from '../knowledge/deep_consolidation.js';
import { buildDeepConsolidationPrompt, DEEP_CONSOLIDATION_GRAMMAR } from '../knowledge/deep_consolidation_prompt.js';

vi.mock('../knowledge/cleanup_commit.js', () => ({ captureCleanupTarget: vi.fn() }));
vi.mock('../knowledge/lorebook.js', () => ({ ktFetchFromApi: vi.fn() }));
vi.mock('../knowledge/settings.js', () => ({ hasValidSettings: vi.fn() }));
vi.mock('../core/scope.js', async importOriginal => ({ ...await importOriginal(), scopeStillCurrent: vi.fn() }));
vi.mock('../knowledge/cleanup_review.js', async importOriginal => ({
    ...await importOriginal(), cleanupModelDisclosure: vi.fn(),
}));

const original = 'DOSSIER-PRIVATE\nKnowledge Ledger:\n- pin 7314\n- old fact\n- RECENT-PRIVATE';
const options = () => ({ name: 'Mara', uid: 7, throughSource: 2, pins: [1] });
function answer(_prompt, payload) {
    return JSON.stringify({ version: 3, reviewId: /<review_id>(.*?)<\/review_id>/.exec(payload)[1],
        keep: [1, 2], changed: [], archive: [], groups: [] });
}

describe('deep consolidation request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearEvents();
        captureCleanupTarget.mockResolvedValue({ name: 'Mara', uid: 7, originalContent: original, scopeToken: {} });
        hasValidSettings.mockReturnValue(true);
        scopeStillCurrent.mockReturnValue({ ok: true });
        cleanupModelDisclosure.mockReturnValue({ mode: 'custom', source: 'module-custom', modelName: 'test', maxTokens: 8000 });
        ktFetchFromApi.mockImplementation(answer);
    });

    it('uses Knowledge disclosure and v3 estimates, honest unknown capacity, one whole eligible payload', async () => {
        const result = await requestDeepConsolidation(options());
        expect(captureCleanupTarget).toHaveBeenCalledWith({ name: 'Mara', uid: 7 });
        const [prompt, payload, transport] = ktFetchFromApi.mock.calls[0];
        expect(prompt).toContain(`"reviewId":"${result.selection.review.reviewId}"`);
        expect(result.requestFacts.prompt).toBe(prompt);
        expect(payload).toContain('<pinned_keep>[1]</pinned_keep>');
        expect(payload).toContain('[s2] - old fact');
        expect(payload).not.toMatch(/DOSSIER-PRIVATE|RECENT-PRIVATE|\[s3\]/);
        expect(transport).toMatchObject({ trigger: 'manual', retries: 0, requestDiagnostics: {
            operation: 'deep-consolidation', reviewId: result.selection.review.reviewId, sourceCount: 2, outputAllowance: 8000,
        } });
        expect(result.requestFacts.estimate.disclosure.modelName).toBe('test');
        expect(result.requestFacts.budget.warnings.join(' ')).toContain('unknown');
        expect(result.requestFacts.grammar.name).toBe('shared-clause-provenance');
        expect(result.entryText).toBe(original);
    });

    it('captures fresh review ids on manual regeneration', async () => {
        const first = await requestDeepConsolidation(options());
        const second = await requestDeepConsolidation(options());
        const ids = ktFetchFromApi.mock.calls.map(([, payload]) => /<review_id>(.*?)<\/review_id>/.exec(payload)[1]);
        expect(new Set(ids).size).toBe(2);
        expect(captureCleanupTarget).toHaveBeenCalledTimes(2);
        expect(first.requestFacts.attempt).toBe(1);
        expect(first.selection.review.reviewId).not.toBe(second.selection.review.reviewId);
    });

    it.each(['originalContent', 'bookName', 'entityId', 'uid', 'name'])('refuses a changed %s before dispatch', async key => {
        const expectedCapture = { name: 'Mara', uid: 7, bookName: 'Book', entityId: 'npc-id', originalContent: original, scopeToken: {} };
        captureCleanupTarget.mockResolvedValue({ ...expectedCapture, [key]: key === 'uid' ? 8 : 'changed' });
        await expect(requestDeepConsolidation({ ...options(), expectedCapture })).rejects.toThrow('Close and reopen');
        expect(ktFetchFromApi).not.toHaveBeenCalled();
        expect(captureCleanupTarget).toHaveBeenCalledTimes(1);
    });

    it('does not retry against different sources after an invalid answer', async () => {
        ktFetchFromApi.mockImplementationOnce(() => {
            captureCleanupTarget.mockResolvedValue({ name: 'Mara', uid: 7, originalContent: original + '\n- new fact', scopeToken: {} });
            return '{"version":';
        });
        await expect(requestDeepConsolidation(options())).rejects.toThrow('No automatic retry');
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
        expect(captureCleanupTarget).toHaveBeenCalledTimes(1);
    });

    it('does not plan to rewrite pinned sources', () => {
        const selection = captureDeepConsolidationReview(original, { throughSource: 2, pins: [1, 2] });
        const { estimate } = estimateDeepConsolidationRequest({ name: 'Mara', selection });
        expect(estimate.rewriteAllOutputTokens).toBe(estimate.minimumOutputTokens);
    });

    it('refuses known excess before dispatch and never clips or chunks', async () => {
        cleanupModelDisclosure.mockReturnValue({ maxTokens: 1 });
        await expect(requestDeepConsolidation(options())).rejects.toMatchObject({ code: 'output-envelope-exceeds-allowance' });
        expect(ktFetchFromApi).not.toHaveBeenCalled();
    });

    it('identifies a stale review ID without logging the returned value', async () => {
        ktFetchFromApi.mockResolvedValue(JSON.stringify({ version: 3, reviewId: 'MODEL-PRIVATE', keep: [1, 2], changed: [], archive: [], groups: [] }));
        await expect(requestDeepConsolidation(options())).rejects.toThrow('reviewId did not match');
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
        const event = getEvents({ module: 'knowledge' })[0];
        expect(event).toMatchObject({ event: 'deep_consolidation_rejected', level: 'warn',
            detail: { stage: 'validation', reviewId: ktFetchFromApi.mock.calls[0][2].requestDiagnostics.reviewId,
                reason: expect.stringContaining('reviewId did not match') } });
        expect(JSON.stringify(event.detail)).not.toMatch(/MODEL-PRIVATE|DOSSIER-PRIVATE|Mara|old fact/);
    });

    it('shows missing and unexpected fields locally and keeps model-supplied keys out of diagnostics', async () => {
        ktFetchFromApi.mockImplementation((...args) => {
            const wire = JSON.parse(answer(...args));
            delete wire.archive;
            wire['MODEL-PRIVATE'] = 'VALUE-PRIVATE';
            return JSON.stringify(wire);
        });
        await expect(requestDeepConsolidation(options())).rejects.toThrow(/missing archive.*1 unexpected top-level field.*"MODEL-PRIVATE"/);
        const events = getEvents({ module: 'knowledge' });
        expect(events).toHaveLength(1);
        expect(events[0].detail.reason).toContain('missing archive');
        expect(JSON.stringify(events[0].detail)).not.toMatch(/MODEL-PRIVATE|VALUE-PRIVATE/);
    });

    it('explains malformed JSON and response allowance without repair or retry', async () => {
        ktFetchFromApi.mockResolvedValue('{"version":3,"changed":[');
        await expect(requestDeepConsolidation(options())).rejects.toThrow(/malformed or truncated.*8000 tokens.*boundary.*No automatic retry/);
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
        expect(getEvents({ module: 'knowledge' })[0]).toMatchObject({
            event: 'deep_consolidation_rejected', detail: { stage: 'parse', outputAllowance: 8000 },
        });
    });

    it('does not retry transport errors', async () => {
        ktFetchFromApi.mockRejectedValueOnce(new Error('Endpoint unavailable'));
        await expect(requestDeepConsolidation(options())).rejects.toThrow('Endpoint unavailable');
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
    });

    it('instructs shared tags only for identical provenance and dates, and safe JSON strings', () => {
        const prompt = buildDeepConsolidationPrompt('fixture-id');
        expect(DEEP_CONSOLIDATION_GRAMMAR.version).toBe(2);
        expect(prompt).toContain('share ONE trailing tag');
        expect(prompt).toContain('If provenance OR date differs');
        expect(prompt).toContain('escape double quotes and backslashes');
        expect(prompt).toContain('omit optional notes');
    });

    it('accepts complex quoted content with one shared tag and preserves source mappings', async () => {
        const tag = '(via witness — August 21, 2000)';
        captureCleanupTarget.mockResolvedValue({ name: 'Mara', uid: 7, scopeToken: {},
            originalContent: `Knowledge Ledger:\n- Saw the gate open ${tag}\n- Heard Ezra say "enter" ${tag}\n- Saw the gate close ${tag}` });
        const text = `Saw the gate open; heard Ezra say "enter"; saw the gate close ${tag}`;
        ktFetchFromApi.mockImplementation((_prompt, payload) => JSON.stringify({ version: 3,
            reviewId: /<review_id>(.*?)<\/review_id>/.exec(payload)[1], keep: [],
            changed: [{ s: [1, 2, 3], t: text }], archive: [], groups: [{ s: [1, 2, 3], label: 'Gate' }] }));
        const result = await requestDeepConsolidation({ name: 'Mara', uid: 7 });
        expect(result.entryText).toBe(`Knowledge Ledger:\n- ${text}`);
        expect(result.entryText.split(tag)).toHaveLength(2);
        expect(result.proposal.records[0].sourceIds).toHaveLength(3);
    });

    it('cancels before dispatch and after response without retry', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(requestDeepConsolidation({ ...options(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(ktFetchFromApi).not.toHaveBeenCalled();
        ktFetchFromApi.mockImplementation((...args) => {
            scopeStillCurrent.mockReturnValue({ ok: false });
            return answer(...args);
        });
        await expect(requestDeepConsolidation(options())).rejects.toMatchObject({ name: 'AbortError' });
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
    });

    it('fails ineligible ledgers and missing API config without dispatch', async () => {
        hasValidSettings.mockReturnValue(false);
        await expect(requestDeepConsolidation(options())).rejects.toThrow('No API');
        hasValidSettings.mockReturnValue(true);
        captureCleanupTarget.mockResolvedValue({ originalContent: 'not a ledger', scopeToken: {} });
        await expect(requestDeepConsolidation(options())).rejects.toThrow('heading');
        expect(ktFetchFromApi).not.toHaveBeenCalled();
    });

    it('estimates only eligible sources and validates the token goal', () => {
        const selection = captureDeepConsolidationReview(original, { throughSource: 2, pins: [1] });
        const result = estimateDeepConsolidationRequest({ name: 'Mara', selection });
        expect(result.estimate.sourceCount).toBe(2);
        expect(result.estimate.contextLimit.value).toBeNull();
        expect(() => estimateDeepConsolidationRequest({ name: 'Mara', selection, activeBudget: NaN })).toThrow('positive integer');
    });
});
