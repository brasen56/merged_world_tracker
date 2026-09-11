/**
 * test/dashboard_status.test.js — Phase 1 Overview snapshot collector.
 */

import { describe, expect, test, vi } from 'vitest';

import { collectOverviewSnapshot } from '../dashboard/status.js';

const EXPECTED_KEYS = [
    'worldState',
    'staging',
    'growthEvidence',
    'beats',
    'intentions',
    'budget',
    'coordinator',
    'health',
    'deletedIntentions',
    'quarantine',
];

function stubDeps(overrides = {}) {
    return {
        getDocumentStatus: vi.fn(() => ({ kind: 'stale', msgsSinceRefresh: 7 })),
        getStagingCount: vi.fn(() => 3),
        getGrowthEvidenceCount: vi.fn(() => 2),
        getBeatStatus: vi.fn(() => ({ awaiting: 4, overdue: 1 })),
        getActiveLedger: vi.fn(() => [{ id: 'active-1' }]),
        getDormantLedger: vi.fn(() => [{ id: 'dormant-1' }]),
        collectBudgetSnapshot: vi.fn(() => ({ injectedTokens: 120, enforce: false })),
        getCoordinatorSnapshot: vi.fn(() => ({ running: [], queued: [{ id: 1 }] })),
        collectHealthSnapshot: vi.fn(() => ({ modules: [{ id: 'world_state' }] })),
        getDeletedIntentions: vi.fn(() => [{ id: 'deleted-1' }]),
        collectQuarantineStatus: vi.fn(() => ({ total: 1, stores: [] })),
        ...overrides,
    };
}

describe('collectOverviewSnapshot', () => {
    test('collects one successful cell per §2.1 status row', () => {
        const deps = stubDeps();
        const snapshot = collectOverviewSnapshot(deps);

        expect(Object.keys(snapshot)).toEqual(EXPECTED_KEYS);
        expect(snapshot).toEqual({
            worldState: { ok: true, value: { kind: 'stale', msgsSinceRefresh: 7 } },
            staging: { ok: true, value: 3 },
            growthEvidence: { ok: true, value: 2 },
            beats: { ok: true, value: { awaiting: 4, overdue: 1 } },
            intentions: {
                ok: true,
                value: {
                    active: [{ id: 'active-1' }],
                    dormant: [{ id: 'dormant-1' }],
                },
            },
            budget: { ok: true, value: { injectedTokens: 120, enforce: false } },
            coordinator: { ok: true, value: { running: [], queued: [{ id: 1 }] } },
            health: { ok: true, value: { modules: [{ id: 'world_state' }] } },
            deletedIntentions: { ok: true, value: [{ id: 'deleted-1' }] },
            quarantine: { ok: true, value: { total: 1, stores: [] } },
        });

        for (const read of Object.values(deps)) expect(read).toHaveBeenCalledOnce();
    });

    test('a throwing accessor errors only its own cell and leaves every other cell intact', () => {
        const deps = stubDeps({
            getBeatStatus: vi.fn(() => { throw new Error('beat store unavailable'); }),
        });

        const snapshot = collectOverviewSnapshot(deps);

        expect(snapshot.beats).toEqual({ ok: false, error: 'beat store unavailable' });
        for (const statusKey of EXPECTED_KEYS.filter(candidate => candidate !== 'beats')) {
            expect(snapshot[statusKey].ok, statusKey).toBe(true);
        }
        expect(snapshot.staging.value).toBe(3);
        expect(snapshot.health.value.modules).toEqual([{ id: 'world_state' }]);
        expect(deps.collectQuarantineStatus).toHaveBeenCalledOnce();
    });

    test('groups active and dormant reads in one guarded intentions cell', () => {
        const deps = stubDeps({
            getDormantLedger: vi.fn(() => { throw 'dormant read failed'; }),
        });

        const snapshot = collectOverviewSnapshot(deps);

        expect(snapshot.intentions).toEqual({ ok: false, error: 'dormant read failed' });
        expect(snapshot.worldState.ok).toBe(true);
        expect(snapshot.quarantine.ok).toBe(true);
    });

    test('normalizes undefined and unusual thrown values into a stable JSON shape', () => {
        const hostileThrow = {};
        Object.defineProperty(hostileThrow, 'message', {
            get() { throw new Error('message getter failed'); },
        });
        hostileThrow.toString = () => { throw new Error('string conversion failed'); };

        const snapshot = collectOverviewSnapshot(stubDeps({
            getStagingCount: vi.fn(() => undefined),
            collectQuarantineStatus: vi.fn(() => { throw hostileThrow; }),
        }));

        expect(snapshot.staging).toEqual({ ok: true, value: null });
        expect(snapshot.quarantine).toEqual({ ok: false, error: 'Unknown error' });
        expect(() => JSON.stringify(snapshot)).not.toThrow();
        expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    });

    test('the production defaults are callable without a browser host', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const snapshot = collectOverviewSnapshot();

        expect(Object.keys(snapshot)).toEqual(EXPECTED_KEYS);
        expect(() => JSON.stringify(snapshot)).not.toThrow();
        for (const cell of Object.values(snapshot)) {
            expect(typeof cell.ok).toBe('boolean');
            expect(cell.ok ? cell : { ...cell, error: String(cell.error) }).toEqual(cell);
        }
        warn.mockRestore();
    });
});
