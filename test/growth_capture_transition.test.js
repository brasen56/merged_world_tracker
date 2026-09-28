/** Growth capture must transition from its one-time bootstrap to a delta-only scan. */

import { beforeEach, describe, expect, test } from 'vitest';

import { resetCoreStubs, setFakeApi, setFakeChat, getFakeMeta } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { saveSettings } from '../knowledge/settings.js';
import { appendRawObservations, getCaptureWatermark, getCaptureCursor, setCaptureWatermark } from '../knowledge/evidence.js';
import { runCaptureOnly, runContinuousCapture } from '../knowledge/growth.js';

describe('Growth capture bootstrap → incremental transition', () => {
    beforeEach(() => {
        resetCoreStubs();
        _clearCacheForTests();
        _setCacheForTests('Knowledge Tracker', {
            registry: { Mara: { uid: 7, type: 'major', keywords: ['Mara'] } },
        });
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
    });

    test('seeds the bootstrap watermark, then sends only newer messages', async () => {
        const original = [
            { name: 'Mara', mes: 'Mara steadies her breathing.', send_date: '2026-01-01T00:00:00.000Z' },
            { name: 'Mara', mes: 'Mara says, "I can handle this."', send_date: '2026-01-01T00:01:00.000Z' },
        ];
        setFakeChat([
            ...original,
            { is_system: true, mes: 'in-flight placeholder', send_date: '2026-01-01T00:01:00.000Z' },
            { is_system: true, mes: 'in-flight placeholder', send_date: '2026-01-01T00:01:00.000Z' },
        ]);
        const requests = [];
        setFakeApi(({ userContent }) => {
            requests.push(userContent);
            const quote = userContent.includes('I can handle this')
                ? 'I can handle this'
                : 'I will not run';
            return JSON.stringify({
                observations: [{ category: 'trait', claim: 'She remains composed under pressure.', quote, msgIdx: 1 }],
            });
        });

        await runCaptureOnly('Mara');
        const bootstrapWatermark = getCaptureWatermark('Mara');
        expect(bootstrapWatermark).toBe(Date.parse('2026-01-01T00:01:00.000Z'));
        expect(requests[0]).toContain('steadies her breathing');
        expect(requests[0]).toContain('I can handle this');

        setFakeChat([
            ...original,
            { name: 'Mara', mes: 'Mara says, "I will not run."', send_date: '2026-01-01T00:02:00.000Z' },
            { is_system: true, mes: 'in-flight placeholder', send_date: '2026-01-01T00:02:00.000Z' },
            { is_system: true, mes: 'in-flight placeholder', send_date: '2026-01-01T00:02:00.000Z' },
        ]);

        await runCaptureOnly('Mara');

        expect(requests).toHaveLength(2);
        expect(requests[1]).toContain('I will not run');
        expect(requests[1]).not.toContain('steadies her breathing');
        expect(requests[1]).not.toContain('I can handle this');
        expect(getCaptureWatermark('Mara')).toBe(Date.parse('2026-01-01T00:02:00.000Z'));
    });

    test('bootstrap does not consume a message appended while its API request is pending', async () => {
        const chat = [{ name: 'Mara', mes: 'Before the request', send_date: '2026-01-01T00:00:00.000Z' },
            { name: 'Mara', mes: 'Still before the request', send_date: '2026-01-01T00:01:00.000Z' }];
        setFakeChat([...chat, { is_system: true, mes: 'in flight' }, { is_system: true, mes: 'in flight' }]);
        let finish;
        const requested = new Promise(resolve => { finish = resolve; });
        setFakeApi(() => requested);
        const capture = runCaptureOnly('Mara');
        // Wait for the asynchronous lorebook context load and API submission.
        for (let i = 0; i < 20 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 0));
        expect(finish).toBeTypeOf('function');
        setFakeChat([...chat, { name: 'Mara', mes: 'After the request', send_date: '2026-01-01T00:02:00.000Z' },
            { is_system: true, mes: 'in flight' }, { is_system: true, mes: 'in flight' }]);
        finish(JSON.stringify({ observations: [{ claim: 'Earlier', quote: 'Before the request', msgIdx: 0 }] }));
        await capture;
        expect(getCaptureCursor('Mara')).toMatchObject({ ts: Date.parse('2026-01-01T00:01:00.000Z'), index: 1, identity: expect.any(String) });
        expect(getCaptureWatermark('Mara')).toBe(Date.parse('2026-01-01T00:01:00.000Z'));
    });

    test('tied timestamps resume after the last captured index without replaying the batch', async () => {
        const chat = [0, 1, 2, 3].map(i => ({ name: 'Mara', mes: `Line ${i}`, send_date: '2026-01-01T00:01:00.000Z' }));
        setFakeChat([...chat, { is_system: true, mes: 'in flight' }, { is_system: true, mes: 'in flight' }]);
        setCaptureWatermark('Mara', Date.parse('2026-01-01T00:00:00.000Z'), 0);
        const requests = [];
        setFakeApi(({ userContent }) => { requests.push(userContent); return JSON.stringify({ observations: [] }); });
        await runContinuousCapture('Mara', { minMessages: 1, maxMessages: 2 });
        expect(getCaptureCursor('Mara')).toMatchObject({ ts: Date.parse('2026-01-01T00:01:00.000Z'), index: 1, identity: expect.any(String) });
        await runContinuousCapture('Mara', { minMessages: 1, maxMessages: 2 });
        expect(requests[1]).toContain('Line 2');
        expect(requests[1]).not.toContain('Line 1');
        expect(getCaptureCursor('Mara')).toMatchObject({ ts: Date.parse('2026-01-01T00:01:00.000Z'), index: 3, identity: expect.any(String) });
        expect(await runContinuousCapture('Mara', { minMessages: 1 })).toBeNull();
    });

    test('forty stripped messages advance the cursor so later narrative is reachable', async () => {
        const stripped = Array.from({ length: 40 }, (_, i) => ({
            name: 'Mara', mes: '<details><summary>tracker</summary>hidden</details>', send_date: 1000 + i,
        }));
        setFakeChat([...stripped, { name: 'Mara', mes: 'Mara returns.', send_date: 1040 },
            { is_system: true, mes: 'in flight' }, { is_system: true, mes: 'in flight' }]);
        setCaptureWatermark('Mara', 999000, 0);
        const requests = [];
        setFakeApi(({ userContent }) => { requests.push(userContent); return JSON.stringify({ observations: [] }); });
        expect(await runContinuousCapture('Mara')).toMatchObject({ added: 0, maxTs: 1039000 });
        expect(getCaptureCursor('Mara')).toMatchObject({ ts: 1039000, index: 39, identity: expect.any(String) });
        expect(requests).toHaveLength(0);
        await runContinuousCapture('Mara', { minMessages: 1 });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain('Mara returns.');
    });

    test('a refused evidence commit never reports observations as added', () => {
        getFakeMeta().knowledge_growth_evidence = 'invalid existing store';
        expect(() => appendRawObservations('Mara', [{ claim: 'Stays calm', quote: 'Mara returns.', msgIdx: 0 }]))
            .toThrow(/could not be saved/);
        expect(getFakeMeta().knowledge_growth_evidence).toBe('invalid existing store');
    });

    test('reanchors equal timestamps after earlier history is deleted', async () => {
        const ts = '2026-01-01T00:01:00.000Z';
        const chat = [0, 1, 2, 3].map(i => ({ id: `line-${i}`, name: 'Mara', mes: `Line ${i}`, send_date: ts }));
        const tail = [{ is_system: true, mes: 'in flight' }, { is_system: true, mes: 'in flight' }];
        setFakeChat([...chat, ...tail]);
        const requests = [];
        setFakeApi(({ userContent }) => { requests.push(userContent); return JSON.stringify({ observations: [] }); });
        await runContinuousCapture('Mara', { minMessages: 1, maxMessages: 4 });
        setFakeChat([...chat.slice(3), { id: 'new', name: 'Mara', mes: 'New after deletion', send_date: ts }, ...tail]);
        await runContinuousCapture('Mara', { minMessages: 1 });
        expect(requests).toHaveLength(2);
        expect(requests[1]).toContain('New after deletion');
        expect(requests[1]).not.toContain('Line 3');
        expect(getCaptureCursor('Mara')).toMatchObject({ index: 1, identity: 'id:new' });
        expect(await runContinuousCapture('Mara', { minMessages: 1 })).toBeNull();
    });

    test('replays equal-time survivors when the boundary itself was summarized away', async () => {
        const ts = '2026-01-01T00:01:00.000Z';
        const originals = [0, 1, 2].map(i => ({ id: `old-${i}`, name: 'Mara', mes: `Old ${i}`, send_date: ts }));
        const tail = [{ is_system: true, mes: 'in flight' }, { is_system: true, mes: 'in flight' }];
        setFakeChat([...originals, ...tail]);
        const requests = [];
        setFakeApi(({ userContent }) => { requests.push(userContent); return JSON.stringify({ observations: [] }); });
        await runContinuousCapture('Mara', { minMessages: 1 });
        setFakeChat([originals[1], { id: 'new', name: 'Mara', mes: 'New equal-time line', send_date: ts }, ...tail]);
        await runContinuousCapture('Mara', { minMessages: 1 });
        expect(requests[1]).toContain('New equal-time line');
        expect(getCaptureCursor('Mara')).toMatchObject({ index: 1, identity: 'id:new' });
        expect(await runContinuousCapture('Mara', { minMessages: 1 })).toBeNull();
    });
});