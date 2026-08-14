/** Regression coverage for receipt provenance lifecycle boundaries. */

import { describe, test, expect, beforeEach } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';

describe('receipt provenance reset boundaries', () => {
    beforeEach(() => resetCoreStubs());

    test('World State reset starts a fresh cadence without prior receipts', async () => {
        const { state, resetAutoRefreshCounter } = await import('../world_state/data.js');
        state.autoRefreshCounter = 3;
        state.countedReceiptEvents = new Map([['uuid:prior-reply', 1]]);

        resetAutoRefreshCounter();

        expect(state.autoRefreshCounter).toBe(0);
        expect(state.countedReceiptEvents).toEqual(new Map());
    });
});