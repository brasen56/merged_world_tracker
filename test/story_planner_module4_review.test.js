import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
    migrateStoryPlannerV1ToV2, migrateStoryPlannerV2ToV3,
    storyPlannerSchema, validateStoryPlannerData,
} from '../story_planner/schema.js';
import { prepareStore } from '../core/schema.js';
import { addArc, addArcBeat, getArcs, makeArc, pushPlanToHistory, removeArc, setArcsWithHistory, updateArc } from '../story_planner/data.js';
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

describe('Module 4 review regressions', () => {
    test.each([migrateStoryPlannerV1ToV2, migrateStoryPlannerV2ToV3])(
        '%s quarantines a corrupt arc container', migrate => {
            const raw = { arcs: { recoverable: 'original content' } };
            const result = migrate(raw);
            expect(result.data.arcs).toEqual([]);
            expect(result.issues).toEqual([expect.objectContaining({
                code: 'not-an-array', severity: 'quarantine', path: ['arcs'], record: raw.arcs,
            })]);
        },
    );

    test.each([1, 2])('preparing a v%i store retains rejected null arcs in quarantine', version => {
        const result = prepareStore(storyPlannerSchema, { arcs: [null], history: [{ arcs: [null] }] }, { version });
        expect(result.data.arcs).toEqual([]);
        expect(result.data.history[0].arcs).toEqual([]);
        expect(result.quarantined).toEqual([
            expect.objectContaining({ reasonCode: 'arc-not-object', raw: null }),
            expect.objectContaining({ reasonCode: 'arc-not-object', raw: null }),
        ]);
    });

    test.each([migrateStoryPlannerV1ToV2, migrateStoryPlannerV2ToV3])(
        '%s quarantines non-object arcs in live and history lists before sanitization', migrate => {
            const valid = { id: 'arc-1', title: 'Keep this', section: 'immediate', beats: [] };
            const result = migrate({ arcs: [null, valid, 'bad'], history: [{ arcs: [valid, null] }] });
            expect(result.data.arcs).toHaveLength(1);
            expect(result.data.arcs[0].title).toBe('Keep this');
            expect(result.data.history[0].arcs).toHaveLength(1);
            expect(result.issues).toEqual([
                expect.objectContaining({ code: 'arc-not-object', severity: 'quarantine', path: ['arcs', 0], record: null }),
                expect.objectContaining({ code: 'arc-not-object', severity: 'quarantine', path: ['arcs', 2], record: 'bad' }),
                expect.objectContaining({ code: 'arc-not-object', severity: 'quarantine', path: ['history', 0, 'arcs', 1], record: null }),
            ]);
            expect(validateStoryPlannerData(result.data).issues).toEqual([]);
        },
    );

    test('a refused history write leaves the live store unchanged', () => {
        const arc = makeArc({ title: 'Original', body: 'Preserve me' });
        const store = { arcs: [arc], history: [] };
        getFakeMeta().story_planner_data = store;
        gate.blocked = true;
        pushPlanToHistory([arc]);
        expect(getFakeMeta().story_planner_data).toBe(store);
        expect(store.history).toHaveLength(0);
    });

    test('a refused replacement leaves both plan and history unchanged', () => {
        const arc = makeArc({ title: 'Original' });
        const store = { arcs: [arc], history: [] };
        getFakeMeta().story_planner_data = store;
        gate.blocked = true;
        expect(setArcsWithHistory([makeArc({ title: 'Replacement' })], [arc]).ok).toBe(false);
        expect(getFakeMeta().story_planner_data).toBe(store);
        expect(store.arcs[0].title).toBe('Original');
        expect(store.history).toEqual([]);
    });

    test('updateArc refuses a proposal when its write is blocked', () => {
        const arc = makeArc({ title: 'Original' });
        getFakeMeta().story_planner_data = { arcs: [arc] };
        gate.blocked = true;
        const result = updateArc(arc.id, { title: 'Unsaved' });
        expect(result).toBeNull();
        expect(getArcs()[0].title).toBe('Original');
    });

    test('add and remove do not report success over a refused write', () => {
        const arc = makeArc({ title: 'Original' });
        getFakeMeta().story_planner_data = { arcs: [arc], history: [] };
        gate.blocked = true;
        expect(addArc({ title: 'Unsaved' })).toBeNull();
        expect(removeArc(arc.id)).toBe(false);
        expect(getArcs()).toEqual([arc]);
    });

    test('beat edit and deletion each commit history with their arc change, never separately', () => {
        const arc = makeArc({ title: 'Original', beats: ['First beat'] });
        getFakeMeta().story_planner_data = { arcs: [arc], history: [] };
        gate.blocked = true;
        expect(addArcBeat(arc.id, 'Second beat')).toBeNull();
        expect(removeArc(arc.id)).toBe(false);
        expect(getFakeMeta().story_planner_data.history).toEqual([]);
        expect(getArcs()).toEqual([arc]);
        gate.blocked = false;
        expect(addArcBeat(arc.id, 'Second beat')).not.toBeNull();
        expect(getFakeMeta().story_planner_data.history).toHaveLength(1);
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