/** Growth capture must transition from its one-time bootstrap to a delta-only scan. */

import { beforeEach, describe, expect, test } from 'vitest';

import { resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { saveSettings } from '../knowledge/settings.js';
import { getCaptureWatermark } from '../knowledge/evidence.js';
import { runCaptureOnly } from '../knowledge/growth.js';

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
        setFakeChat([
            { name: 'Mara', mes: 'Mara steadies her breathing.', send_date: '2026-01-01T00:00:00.000Z' },
            { name: 'Mara', mes: 'Mara says, "I can handle this."', send_date: '2026-01-01T00:01:00.000Z' },
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
            { name: 'Mara', mes: 'Mara steadies her breathing.', send_date: '2026-01-01T00:00:00.000Z' },
            { name: 'Mara', mes: 'Mara says, "I can handle this."', send_date: '2026-01-01T00:01:00.000Z' },
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
});