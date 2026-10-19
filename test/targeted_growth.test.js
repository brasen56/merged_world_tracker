import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import { resetCoreStubs, setFakeApi, getFakeMeta, setFakeChat } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { saveSettings } from '../knowledge/settings.js';
import { planTargetedCapture, runTargetedCapture } from '../knowledge/targeted_growth.js';
import { getEvidenceFile, getCaptureWatermark, getBackfillWatermark } from '../knowledge/evidence.js';
import { validateKnowledgeEvidenceData } from '../knowledge/schema.js';
import { bumpEpoch } from '../core/scope.js';
import { runIlsBackfillCapture } from '../knowledge/growth.js';

let api, source, calls;
beforeEach(() => {
    resetCoreStubs(); _clearCacheForTests();
    _setCacheForTests('Knowledge Tracker', { registry: { Mara: {
        uid: 7, type: 'major', keywords: ['Mara'], entityId: 'mwt_mara', aliases: [],
    } } });
    saveSettings({ apiUrl: 'https://example.test', modelName: 'test', scope: 'global' });
    source = { ref: 'source-a', status: 'verified', source_chat_id: 'chat', current_fingerprint: 'sha256:a',
        expanded_index: 0, visible_index: 0, recovered_ils: true, leaf_identity: { id: 'original-a' },
        message: { name: 'Mara', mes: 'I will keep my promise.', send_date: '2026-01-01T00:00:00Z' } };
    api = {
        version: 1,
        getStatus: () => ({ ready: true, scope_token: 'token', capabilities: {
            history: { available: true }, source_resolution: { available: true }, candidate_windows: { available: true },
        } }),
        findEvents: vi.fn(),
        findCandidateWindows: vi.fn(async () => ({ ok: true, scope_token: 'token', coverage: {}, windows: [
            { window_ref: 'one', event_refs: ['event-a'], source_refs: [{ ref: source.ref }] },
            { window_ref: 'overlap', event_refs: ['event-b'], source_refs: [{ ref: source.ref }] },
        ] })),
        resolveSources: vi.fn(async ({ sources }) => ({ ok: true, scope_token: 'token',
            sources: sources.map(() => structuredClone(source)) })),
    };
    vi.stubGlobal('window', { VectFoxAPI: api });
    calls = [];
    setFakeApi(request => { calls.push(request); return JSON.stringify({ observations: [
        { claim: 'Keeps promises', quote: 'I will keep my promise.', msgIdx: 0, category: 'value' },
    ] }); });
});
afterEach(() => vi.unstubAllGlobals());

describe('Targeted Growth', () => {
    test('unmatched targeted quotes retain recovered-original provenance, not the live timestamp', async () => {
        setFakeChat([{ mes: 'Unrelated live message.', send_date: '2026-10-01T00:00:00Z' }]);
        setFakeApi(() => JSON.stringify({ observations: [
            { claim: 'Keeps promises', quote: 'An entirely invented quotation.', msgIdx: 0 },
        ] }));
        const result = await runTargetedCapture(await planTargetedCapture('Mara'));
        expect(result).toMatchObject({ added: 1, verified: 0 });
        expect(getEvidenceFile('Mara').raw[0]).toMatchObject({ verified: false, msgIdx: null,
            ts: Date.parse(source.message.send_date), sourceIdentity: 'id:original-a' });
    });
    test('unmatched ILS quotes retain original provenance, not the summary timestamp', async () => {
        const original = { ...source.message, id: 'original-a' };
        setFakeChat([{ mes: 'Summary container.', send_date: '2026-10-01T00:00:00Z',
            extra: { ILS_Data: { OriginalMessages: [original] } } }]);
        setFakeApi(() => JSON.stringify({ observations: [
            { claim: 'Keeps promises', quote: 'An entirely invented quotation.', msgIdx: 0 },
        ] }));
        expect(await runIlsBackfillCapture('Mara')).toMatchObject({ added: 1 });
        expect(getEvidenceFile('Mara').raw[0]).toMatchObject({ verified: false, msgIdx: null,
            ts: Date.parse(original.send_date), sourceIdentity: 'id:original-a' });
    });
    test('previews without generation, merges overlap, verifies original timestamp and preserves cursors', async () => {
        const plan = await planTargetedCapture('Mara');
        expect(calls).toHaveLength(0);
        expect(plan).toMatchObject({ windows: 1, messages: 1, skipped: 1, maxCalls: 1 });
        const result = await runTargetedCapture(plan);
        expect(result).toMatchObject({ added: 1, verified: 1, calls: 1, messages: 1 });
        expect(calls[0].retries).toBe(0);
        expect(getEvidenceFile('Mara').raw[0]).toMatchObject({ msgIdx: null, ts: Date.parse(source.message.send_date),
            verified: true, sourceIdentity: 'id:original-a' });
        expect(getCaptureWatermark('Mara')).toBeNull();
        expect(getBackfillWatermark('Mara')).toBeNull();
        expect((await planTargetedCapture('Mara')).messages).toBe(0);
    });
    test('successful zero observations record coverage; edits become eligible', async () => {
        setFakeApi(() => JSON.stringify({ observations: [] }));
        await runTargetedCapture(await planTargetedCapture('Mara'));
        expect(getEvidenceFile('Mara').raw).toHaveLength(0);
        expect((await planTargetedCapture('Mara')).messages).toBe(0);
        source.current_fingerprint = 'sha256:edit'; source.message.mes += ' Again.';
        expect((await planTargetedCapture('Mara')).messages).toBe(1);
    });
    test('failed or malformed generations remain retryable', async () => {
        setFakeApi(() => '{}');
        await expect(runTargetedCapture(await planTargetedCapture('Mara'))).rejects.toThrow(/observations/);
        expect(getEvidenceFile('Mara', false)?.meta?.targetedCoverage).toBeUndefined();
        expect((await planTargetedCapture('Mara')).messages).toBe(1);
    });
    test.each(['missing', 'changed', 'unresolved'])('never substitutes a %s original', async status => {
        source.status = status;
        expect((await planTargetedCapture('Mara')).messages).toBe(0);
        expect(calls).toHaveLength(0);
    });
    test('cancellation during generation does not commit evidence or coverage', async () => {
        const controller = new AbortController();
        setFakeApi(() => { controller.abort(); return JSON.stringify({ observations: [] }); });
        await expect(runTargetedCapture(await planTargetedCapture('Mara'), { signal: controller.signal })).rejects.toThrow(/cancelled/);
        expect(getEvidenceFile('Mara', false)?.meta?.targetedCoverage).toBeUndefined();
    });
    test('scope change during generation refuses the result', async () => {
        setFakeApi(() => { bumpEpoch(); return JSON.stringify({ observations: [] }); });
        await expect(runTargetedCapture(await planTargetedCapture('Mara'))).rejects.toThrow(/changed|stale/);
        expect(getEvidenceFile('Mara', false)?.meta?.targetedCoverage).toBeUndefined();
    });
    test('a refused commit cannot record successful coverage', async () => {
        const plan = await planTargetedCapture('Mara');
        getFakeMeta().knowledge_growth_evidence = 'invalid';
        await expect(runTargetedCapture(plan)).rejects.toThrow(/could not be saved/);
        expect(getFakeMeta().knowledge_growth_evidence).toBe('invalid');
    });
    test('source edits during generation refuse the pending batch', async () => {
        setFakeApi(() => { source.current_fingerprint = 'edited'; return JSON.stringify({ observations: [] }); });
        await expect(runTargetedCapture(await planTargetedCapture('Mara'))).rejects.toThrow(/source changed/);
        expect(getEvidenceFile('Mara', false)?.meta?.targetedCoverage).toBeUndefined();
    });
    test('budget-exceeding originals stay uncovered and never cause a model call', async () => {
        source.message.mes = 'x'.repeat(17000);
        const plan = await planTargetedCapture('Mara');
        expect(plan).toMatchObject({ messages: 0, budgetOmitted: 1 });
        // The second overlapping reference is skipped, not counted twice as budget work.
        expect((await runTargetedCapture(plan)).calls).toBe(0);
        expect(getEvidenceFile('Mara', false)?.meta?.targetedCoverage).toBeUndefined();
    });
    test('unsupported integration is not reported as a successful empty search', async () => {
        api.getStatus = () => ({ ready: true, scope_token: 'token', capabilities: {
            history: { available: true }, source_resolution: { available: true },
        } });
        await expect(planTargetedCapture('Mara')).rejects.toThrow(/unavailable/);
        expect(calls).toHaveLength(0);
    });
    test('schema preserves valid coverage for backup/restore and quarantines malformed coverage', async () => {
        await runTargetedCapture(await planTargetedCapture('Mara'));
        const map = structuredClone(getFakeMeta().knowledge_growth_evidence);
        expect(validateKnowledgeEvidenceData(map).data.Mara.meta.targetedCoverage).toHaveLength(1);
        map.Mara.meta.targetedCoverage = [{ chat: 'chat' }];
        const checked = validateKnowledgeEvidenceData(map);
        expect(checked.issues.some(issue => issue.code === 'targeted-coverage-invalid')).toBe(true);
        expect(checked.data.Mara.meta.targetedCoverage).toBeUndefined();
    });
});