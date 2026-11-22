import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureCleanupTarget } from '../knowledge/cleanup_commit.js';
import { ktFetchFromApi } from '../knowledge/lorebook.js';
import { cleanupModelDisclosure } from '../knowledge/cleanup_review.js';
import { scopeStillCurrent } from '../core/scope.js';
import { _resetDiagnostics, getEvents, recordApiCall } from '../core/diagnostics.js';
import { hasValidSettings } from '../knowledge/settings.js';
import { requestDeepConsolidation, estimateDeepConsolidationRequest } from '../knowledge/deep_consolidation_request.js';
import { captureDeepConsolidationReview, expandDeepConsolidationProposal } from '../knowledge/deep_consolidation.js';
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
        _resetDiagnostics();
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

    it('previews a complete proposal after an unclosed Markdown opener with full ownership and identity validation', async () => {
        ktFetchFromApi.mockImplementation((...args) => '```json\n' + answer(...args));
        const result = await requestDeepConsolidation(options());
        expect(result.entryText).toBe(original);
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);

        ktFetchFromApi.mockImplementation((...args) => {
            const wire = JSON.parse(answer(...args));
            wire.keep = [1];
            return '```json\n' + JSON.stringify(wire);
        });
        await expect(requestDeepConsolidation(options())).rejects.toThrow('Missing source coverage');
        ktFetchFromApi.mockImplementation((...args) => {
            const wire = JSON.parse(answer(...args));
            wire.reviewId = 'stale';
            return '```json\n' + JSON.stringify(wire);
        });
        await expect(requestDeepConsolidation(options())).rejects.toThrow('reviewId did not match');
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

    it('retains malformed output for explicit download and logs only parser metadata', async () => {
        const raw = 'NOT_JSON_PRIVATE';
        ktFetchFromApi.mockResolvedValue(raw);
        const error = await requestDeepConsolidation(options()).catch(caught => caught);
        expect(error.message).toMatch(/malformed or truncated.*8000 tokens.*Download the failed response.*No automatic retry/);
        expect(error.deepConsolidationFailure).toMatchObject({
            rawResponse: raw, stage: 'parse', responseChars: raw.length, finishReason: null, completionTokens: null,
        });
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
        expect(getEvents({ module: 'knowledge' })[0]).toMatchObject({
            event: 'deep_consolidation_rejected', detail: { stage: 'parse', outputAllowance: 8000, responseChars: raw.length },
        });
        expect(JSON.stringify(getEvents({ module: 'knowledge' }))).not.toContain(raw);
        expect(JSON.stringify(error)).not.toContain(raw);
    });

    it('correlates parse failures with their API call when other calls finish concurrently', async () => {
        ktFetchFromApi.mockImplementation((_prompt, _payload, { requestDiagnostics }) => {
            recordApiCall({ module: 'knowledge', requestDiagnostics, finish_reason: 'stop',
                usage: { prompt_tokens: 12035, completion_tokens: 64952 } });
            recordApiCall({ module: 'knowledge', requestDiagnostics: { reviewId: 'other-request' },
                finish_reason: 'length', usage: { completion_tokens: 20 } });
            return '{\n"changed": [],\n}';
        });
        const error = await requestDeepConsolidation(options()).catch(caught => caught);
        expect(error.message).toContain('line 3, column 1');
        expect(error.deepConsolidationFailure).toMatchObject({
            finishReason: 'stop', completionTokens: 64952, jsonErrorLine: 3, jsonErrorColumn: 1,
        });
        expect(getEvents({ module: 'knowledge' })[0].detail).toMatchObject({ finishReason: 'stop', completionTokens: 64952 });
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

    it('explicitly guides multi-record grouping with complete disjoint source coverage', () => {
        const prompt = buildDeepConsolidationPrompt('fixture-id');
        expect(prompt).toContain('Grouping does not mean merging every source in the group into one record');
        expect(prompt).toContain('Aim for roughly 500–650 characters per record');
        expect(prompt).toContain('at most 1200 characters, including provenance and dates');
        expect(prompt).toContain('hard 1200-character limit');
        expect(prompt).not.toContain('800-character limit');
        expect(prompt).toContain('including provenance and dates');
        expect(prompt).toContain('Never merge additional sources if doing so would exceed the limit');
        expect(prompt).toContain('If a single source cannot be safely rewritten within the limit, put it in keep instead');
        expect(prompt).toContain('Complete source coverage matters more than minimizing record count or meeting the active token goal');
        const example = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"keep":[5]')));
        const selection = captureDeepConsolidationReview('Knowledge Ledger:\n- gate opens\n- Ezra enters\n- gate closes\n- night watch\n- exact detail');
        expect(example.changed).toHaveLength(2);
        expect(example.groups).toHaveLength(1);
        expect(expandDeepConsolidationProposal(selection, { version: 3, reviewId: selection.review.reviewId, ...example }).ok).toBe(true);
    });

    it('accepts a changed line above the normal fact cap through the request and preview', async () => {
        const text = 'x'.repeat(850);
        ktFetchFromApi.mockImplementation((...args) => {
            const wire = JSON.parse(answer(...args));
            wire.keep = [1];
            wire.changed = [{ s: [2], t: text }];
            wire.groups = [{ s: [2], label: 'Subject' }];
            return JSON.stringify(wire);
        });
        const result = await requestDeepConsolidation(options());
        expect(result.proposal.records[1].text).toBe(text);
        expect(result.entryText).toBe(original.replace('- old fact', `- ${text}`));
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
    });

    it('surfaces overlength details in the request error and diagnostics without logging text', async () => {
        ktFetchFromApi.mockImplementation((...args) => {
            const wire = JSON.parse(answer(...args));
            wire.keep = [1];
            wire.changed = [{ s: [2], t: 'PRIVATE-TEXT'.repeat(101) }];
            wire.groups = [{ s: [2], label: 'Subject' }];
            return JSON.stringify(wire);
        });
        await expect(requestDeepConsolidation(options())).rejects.toThrow('sources: 2) has 1212 characters; the limit is 1200 (12 over)');
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
        const events = getEvents({ module: 'knowledge' });
        expect(events[0].detail).toMatchObject({ stage: 'validation',
            reason: expect.stringContaining('Consolidated record 2'),
        });
        expect(JSON.stringify(events)).not.toContain('PRIVATE-TEXT');
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
