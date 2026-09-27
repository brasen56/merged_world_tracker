import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
    migrateStoryPlannerV1ToV2, migrateStoryPlannerV2ToV3,
    validateStoryPlannerData,
} from '../story_planner/schema.js';
import { getArcs, makeArc, pushPlanToHistory, updateArc } from '../story_planner/data.js';
import { getFakeMeta, resetCoreStubs } from './stubs/core.js';

const gate = vi.hoisted(() => ({ blocked: false }));
vi.mock('../core/schema_status.js', () => ({
    isStoreWriteBlocked: () => gate.blocked,
    isStorePausedForCurrentScope: () => gate.blocked,
}));

beforeEach(() => {
    resetCoreStubs();
    gate.blocked = false;
});

// Defect reproductions: these assert current behavior, not desired contracts —
// except the receipt-tuple test below, which now pins the FIXED SP4-05
// contract (quarantine + canonical data, fixed in 2.10.2; docs/TODO.md §0).
describe('Module 4 review defect reproductions', () => {
    test.each([migrateStoryPlannerV1ToV2, migrateStoryPlannerV2ToV3])(
        '%s discards a corrupt arc container without an issue', migrate => {
            const raw = { arcs: { recoverable: 'original content' } };
            const result = migrate(raw);
            expect(result.data.arcs).toEqual([]);
            expect(result.issues).toEqual([]);
            expect(validateStoryPlannerData(result.data).issues).toEqual([]);
        },
    );

    test('v2 migration turns a malformed record into an accepted blank arc', () => {
        const result = migrateStoryPlannerV2ToV3({ arcs: [null] });
        expect(result.data.arcs).toHaveLength(1);
        expect(result.data.arcs[0].title).toBe('');
        expect(validateStoryPlannerData(result.data).issues).toEqual([]);
    });

    test('a refused history write leaves the live store unchanged', () => {
        const arc = makeArc({ title: 'Original', body: 'Preserve me' });
        const store = { arcs: [arc], history: [] };
        getFakeMeta().story_planner_data = store;
        gate.blocked = true;
        pushPlanToHistory([arc]);
        expect(getFakeMeta().story_planner_data).toBe(store);
        expect(store.history).toHaveLength(0);
    });

    test('updateArc returns a successful-looking proposal after a refused write', () => {
        const arc = makeArc({ title: 'Original' });
        getFakeMeta().story_planner_data = { arcs: [arc] };
        gate.blocked = true;
        const result = updateArc(arc.id, { title: 'Unsaved' });
        expect(result.title).toBe('Unsaved');
        expect(getArcs()[0].title).toBe('Original');
    });

    // SP4-05 (fixed in 2.10.2): invalid receipt tuples are quarantined by the
    // schema instead of passing through to the destructuring restore path.
    test('schema quarantines malformed receipt tuples instead of passing them to hydration', () => {
        const result = validateStoryPlannerData({ arcs: [], countedReceiptEvents: [null, ['good', 2]] });
        expect(result.issues.some(issue => issue.code === 'receipt-invalid')).toBe(true);
        // Only well-formed tuples survive into the canonical data…
        expect(result.data.countedReceiptEvents).toEqual([['good', 2]]);
        // …so the destructuring the restore performs can never see a rejected one.
        expect(() => result.data.countedReceiptEvents.filter(([key, count]) =>
            typeof key === 'string' && key && Number.isInteger(count) && count > 0,
        )).not.toThrow();
    });
});