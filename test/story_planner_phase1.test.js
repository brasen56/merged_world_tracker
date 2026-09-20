import { beforeEach, describe, expect, test } from 'vitest';

import { prepareStore } from '../core/schema.js';
import {
    MAX_PROGRESS_METADATA_ENTRIES, storyPlannerSchema, validateStoryPlannerData,
} from '../story_planner/schema.js';
import {
    buildClosedMemoryProjection,
    getArcs,
    getBeatProgress,
    getCurrentBeat,
    getPlanHistory,
    incrementArcTurns,
    isArcReady,
    makeArc,
    mergeRegeneratedArcs,
    parsePlanTextToArcs,
    pushPlanToHistory,
    removeArc,
    retreatBeat,
    serializeArcsToText,
    setArcs,
    updateArc,
} from '../story_planner/data.js';
import { buildInjectionBody, getArcsForInjection } from '../story_planner/injection.js';
import { resetCoreStubs } from './stubs/core.js';
import { V1_PROGRESS_ARC, V1_READY_ARC, cloneV1, makeV1PlannerStore } from './fixtures/story_planner_phase0.js';

const texts = arc => arc.beats.map(beat => beat.text);

beforeEach(() => resetCoreStubs());

describe('Story Planner Phase 1 — store v2', () => {
    test('migrates v1 arcs and structured history to stable beat records without losing progress', () => {
        const result = prepareStore(storyPlannerSchema, makeV1PlannerStore(), { version: 1 });
        expect(result.status).toBe('migrated');
        const [progress, ready] = result.data.arcs;
        expect(progress).toMatchObject({ focused: false, closeReason: '', closedAt: null });
        expect(progress).not.toHaveProperty('beatIndex');
        expect(texts(progress)).toEqual(V1_PROGRESS_ARC.beats);
        expect(progress.beats.map(beat => beat.state)).toEqual(['planted', 'pending', 'pending']);
        expect(new Set(progress.beats.map(beat => beat.id)).size).toBe(3);
        expect(ready.beats.every(beat => beat.state === 'planted')).toBe(true);
        expect(isArcReady(ready)).toBe(true);
        expect(result.data.history[0].arcs[0].beats[0].state).toBe('planted');
    });

    test('repairs duplicate nested ids centrally while retaining every beat', () => {
        const arc = makeArc({ title: 'Duplicates', beats: ['one', 'two'] });
        arc.beats[1].id = arc.beats[0].id;
        const validation = validateStoryPlannerData({ arcs: [arc] });
        expect(validation.data.arcs[0].beats).toHaveLength(2);
        expect(new Set(validation.data.arcs[0].beats.map(beat => beat.id)).size).toBe(2);
        expect(validation.issues.map(issue => issue.code)).toContain('beat-id-duplicate');
    });

    test('canonicalizes bounded progress metadata and removes malformed or orphaned entries', () => {
        const arc = makeArc({ title: 'Tracked', beats: ['Current beat'] });
        const beatKey = `beat:${arc.id}:${arc.beats[0].id}`;
        const ignoredKey = `${beatKey}\u0000id:evidence\u0000exact quote`;
        const extraIgnored = Array.from({ length: MAX_PROGRESS_METADATA_ENTRIES + 2 }, (_, index) =>
            `${beatKey}\u0000id:${index}\u0000quote ${index}`);
        const validation = validateStoryPlannerData({
            arcs: [arc],
            progressWatermarks: {
                [beatKey]: { identity: 'id:evidence', index: 3 },
                [`arc:deleted`]: { identity: 'id:old', index: 1 },
                [`arc:${arc.id}`]: { identity: '', index: -1 },
            },
            ignoredProgressEvidence: [ignoredKey, ignoredKey, 'arc:deleted\u0000id:old\u0000old', ...extraIgnored],
        });

        expect(validation.data.progressWatermarks).toEqual({
            [beatKey]: { identity: 'id:evidence', index: 3 },
        });
        expect(validation.data.ignoredProgressEvidence).toHaveLength(MAX_PROGRESS_METADATA_ENTRIES);
        expect(validation.data.ignoredProgressEvidence.at(-1)).toContain(`id:${MAX_PROGRESS_METADATA_ENTRIES + 1}`);
        expect(validation.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
            'progress-watermarks-pruned', 'ignored-progress-evidence-pruned',
        ]));

        const malformed = validateStoryPlannerData({
            arcs: [arc], progressWatermarks: [], ignoredProgressEvidence: 42,
        });
        expect(malformed.data).toMatchObject({ progressWatermarks: {}, ignoredProgressEvidence: [] });
    });
});

describe('Story Planner Phase 1 — durable progress and lifecycle', () => {
    test('preserves historical beat objects exactly and never transfers state by position', () => {
        const stored = prepareStore(storyPlannerSchema, { arcs: [cloneV1(V1_PROGRESS_ARC)] }, { version: 1 }).data.arcs[0];
        const planted = stored.beats[0];
        const incoming = makeArc({
            title: stored.title,
            beats: ['A new event before everything.', ...V1_PROGRESS_ARC.beats],
        });
        const merged = mergeRegeneratedArcs([stored], [incoming]).arcs[0];
        expect(merged.beats[0]).toEqual(planted);
        expect(merged.beats.filter(beat => beat.state === 'planted')).toEqual([planted]);
        expect(merged.beats.find(beat => beat.text === 'A new event before everything.').state).toBe('pending');
    });

    test('exact pending text keeps its id; rewritten pending text receives a new id', () => {
        const stored = prepareStore(storyPlannerSchema, { arcs: [cloneV1(V1_PROGRESS_ARC)] }, { version: 1 }).data.arcs[0];
        const oldCurrent = stored.beats[1];
        const same = mergeRegeneratedArcs([stored], [makeArc({ title: stored.title, beats: V1_PROGRESS_ARC.beats })]).arcs[0];
        expect(same.beats.find(beat => beat.text === oldCurrent.text).id).toBe(oldCurrent.id);
        const changed = mergeRegeneratedArcs([stored], [makeArc({ title: stored.title, beats: ['Reworded current beat'] })]).arcs[0];
        expect(changed.beats.find(beat => beat.text === 'Reworded current beat').id).not.toBe(oldCurrent.id);
    });

    test.each(['resolved', 'dropped'])('%s arcs suppress an exact-title recurring suggestion', status => {
        const closed = makeArc({
            title: 'Rejected Route',
            body: 'Durable closed body',
            status,
            beats: ['Durable closed beat'],
        });
        const incoming = makeArc({
            title: closed.title,
            body: 'Replacement body',
            section: 'horizon',
            beats: ['Replacement beat'],
        });

        const result = mergeRegeneratedArcs([closed], [incoming]);

        expect(result).toMatchObject({ carried: 1, matched: 0, added: 0, suppressedClosed: 1 });
        expect(result.arcs).toHaveLength(1);
        expect(result.arcs.find(arc => arc.id === closed.id)).toEqual(closed);
    });

    test('near-match closed titles remain available as distinct proposals', () => {
        const closed = makeArc({ title: 'Rejected Route', status: 'resolved' });
        const incoming = makeArc({ title: 'Rejected Route Returns', body: 'A distinct continuation.' });

        const result = mergeRegeneratedArcs([closed], [incoming]);

        expect(result).toMatchObject({ carried: 1, matched: 0, added: 1, suppressedClosed: 0 });
        expect(result.arcs.map(arc => arc.title)).toEqual(['Rejected Route', 'Rejected Route Returns']);
    });

    test.each(['active', 'parked', 'resolved', 'dropped'])('scoped Add excludes an exact-title %s recurrence before review', status => {
        const existing = makeArc({ title: 'Existing route', status });
        const incoming = makeArc({ title: 'Existing route', body: 'Duplicate proposal' });

        const result = mergeRegeneratedArcs([existing], [incoming], { addOnly: true });

        expect(result.arcs).toEqual([existing]);
        expect(result.added).toBe(0);
        expect(result.excludedRecurrences).toEqual([
            expect.objectContaining({ title: 'Existing route', status, existingArcId: existing.id }),
        ]);
    });

    test('scoped Add keeps proposal-local ids until Apply', () => {
        const incoming = makeArc({ title: 'Review-only route' });
        const result = mergeRegeneratedArcs([], [incoming], { addOnly: true });

        expect(result.addedIds[0]).toMatch(/^proposal-/);
        expect(result.addedIds[0]).not.toBe(incoming.id);
    });

    test('remints a duplicate title fallback carrying a durable record id', () => {
        const active = makeArc({ title: 'Shared Route', beats: ['Active setup'] });
        const parked = makeArc({ title: 'Later Route', status: 'parked', beats: ['Parked setup'] });
        const first = makeArc({ title: active.title, body: 'First refresh', beats: ['First setup'] });
        const duplicate = { ...makeArc({
            title: active.title,
            body: 'Separate proposal',
            beats: ['Separate setup'],
        }), id: parked.id };

        const result = mergeRegeneratedArcs([active, parked], [first, duplicate]);
        const ids = result.arcs.map(arc => arc.id);

        expect(result.arcs.find(arc => arc.id === parked.id)).toEqual(parked);
        expect(result.arcs.find(arc => arc.body === 'Separate proposal').id).not.toBe(parked.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('skipped beat markers survive serialize, parse, and merge without duplicating the beat', () => {
        const stored = makeArc({ title: 'Old Detour', beats: ['Decline the ferry'] });
        stored.beats[0] = { ...stored.beats[0], state: 'skipped', stateReason: 'Route rejected' };

        const annotated = serializeArcsToText([stored], { annotateStatus: true, beats: 'all' });
        const parsed = parsePlanTextToArcs(annotated);
        const merged = mergeRegeneratedArcs([stored], parsed).arcs[0];

        expect(annotated).toContain('Decline the ferry [SKIPPED]');
        expect(parsed[0].beats[0].text).toBe('Decline the ferry');
        expect(merged.beats).toEqual([stored.beats[0]]);
    });

    test('text-only beat patches retain matching stable records and their progress', () => {
        const arc = makeArc({ title: 'Patched route', beats: ['planted', 'skipped', 'pending'] });
        arc.beats[0] = { ...arc.beats[0], state: 'planted', updatedAt: 10 };
        arc.beats[1] = { ...arc.beats[1], state: 'skipped', stateReason: 'Changed course', updatedAt: 11 };
        setArcs([arc]);

        updateArc(arc.id, { beats: ['planted', 'skipped', 'replacement'] });

        expect(getArcs()[0].beats).toEqual([
            arc.beats[0],
            arc.beats[1],
            expect.objectContaining({ text: 'replacement', state: 'pending' }),
        ]);
    });

    test('a text patch drops blank entries from the stored AND returned arc', () => {
        // markBeatPlanted() derives its "setup complete" message from the arc
        // updateArc() returns, so a blank row the store discards must not
        // survive in that return value as a phantom pending beat.
        const arc = makeArc({ title: 'Blank rows', beats: ['one'] });
        setArcs([arc]);

        const returned = updateArc(arc.id, { beats: ['one', '', '   '] });

        expect(texts(returned)).toEqual(['one']);
        expect(texts(getArcs()[0])).toEqual(['one']);
    });

    test('duplicating a planted beat adds a pending row instead of un-planting it', () => {
        const arc = makeArc({ title: 'Duplicated row', beats: ['setup', 'payoff'] });
        arc.beats[0] = { ...arc.beats[0], state: 'planted' };
        setArcs([arc]);

        updateArc(arc.id, { beats: ['setup', 'setup', 'payoff'] });

        expect(getArcs()[0].beats).toEqual([
            arc.beats[0],
            expect.objectContaining({ text: 'setup', state: 'pending' }),
            expect.objectContaining({ text: 'payoff', state: 'pending' }),
        ]);
        expect(getArcs()[0].beats[1].id).not.toBe(arc.beats[0].id);
    });

    test('a patch cannot move a pending beat ahead of a historical one', () => {
        const arc = makeArc({ title: 'Reordered route', beats: ['planted', 'skipped', 'pending'] });
        arc.beats[0] = { ...arc.beats[0], state: 'planted' };
        arc.beats[1] = { ...arc.beats[1], state: 'skipped' };
        setArcs([arc]);

        updateArc(arc.id, { beats: ['pending', 'planted', 'skipped'] });

        const stored = getArcs()[0];
        expect(stored.beats.map(beat => beat.state)).toEqual(['planted', 'skipped', 'pending']);
        expect(texts(stored)).toEqual(['planted', 'skipped', 'pending']);
        expect(getCurrentBeat(stored)).toBe('pending');
    });

    test('a Ready arc with nothing planted offers no undo control', async () => {
        const { render } = await import('../story_planner/render.js');

        const planted = makeArc({ title: 'Planted route', beats: ['done'] });
        planted.beats[0] = { ...planted.beats[0], state: 'planted' };
        setArcs([planted]);
        expect(isArcReady(getArcs()[0])).toBe(true);
        expect(render()).toContain('data-action="beat-back"');

        const skipped = makeArc({ title: 'Abandoned route', beats: ['never happened'] });
        skipped.beats[0] = { ...skipped.beats[0], state: 'skipped' };
        setArcs([skipped]);
        expect(isArcReady(getArcs()[0])).toBe(true);
        expect(render()).not.toContain('data-action="beat-back"');
    });

    test('skipped beats do not count as planted or enable a no-op retreat', () => {
        const arc = makeArc({ title: 'Skipped route', beats: ['skip', 'pending'] });
        arc.beats[0] = { ...arc.beats[0], state: 'skipped' };
        setArcs([arc]);

        expect(getBeatProgress(getArcs()[0])).toEqual({ done: 0, total: 2 });
        expect(retreatBeat(arc.id)).toEqual(getArcs()[0]);
        expect(getArcs()[0].beats[0].state).toBe('skipped');
    });

    test('history ignores timestamp-only changes while retaining beat-state changes', () => {
        const arc = makeArc({ title: 'Snapshot', beats: ['setup'] });
        pushPlanToHistory([arc]);
        pushPlanToHistory([{ ...arc, updatedAt: arc.updatedAt + 1, beats: [{ ...arc.beats[0], updatedAt: 99 }] }]);
        expect(getPlanHistory()).toHaveLength(1);

        pushPlanToHistory([{ ...arc, beats: [{ ...arc.beats[0], state: 'planted' }] }]);
        expect(getPlanHistory()).toHaveLength(2);
    });

    test('ambiguous regenerated titles retain every unmatched stored arc', () => {
        const first = makeArc({ title: 'Shared route', beats: ['first'] });
        const second = makeArc({ title: 'Shared route', beats: ['second'] });
        const incoming = makeArc({ title: 'Shared route', body: 'New proposal', beats: ['new'] });

        const result = mergeRegeneratedArcs([first, second], [incoming]);

        expect(result).toMatchObject({ carried: 2, matched: 0, added: 1 });
        expect(result.arcs.map(arc => arc.id)).toEqual(expect.arrayContaining([first.id, second.id, incoming.id]));
    });

    test('Parked arcs neither age nor inject, while closed memory uses close reasons only', () => {
        const parked = makeArc({ title: 'Sleeping', status: 'parked', beats: ['wait'] });
        const closed = { ...makeArc({ title: 'Paid off', body: 'Long route', status: 'resolved' }), closeReason: 'Already happened', closedAt: 5 };
        setArcs([parked, closed]);
        expect(incrementArcTurns()).toBe(false);
        expect(getArcsForInjection()).toEqual([]);
        expect(buildInjectionBody()).toBe('');
        expect(buildClosedMemoryProjection()).toContain('Already happened');
        expect(buildClosedMemoryProjection()).not.toContain('Long route');
    });

    test('deletion is deliberate forget and snapshots the complete pre-delete record', () => {
        const arc = makeArc({ title: 'Forget me', beats: ['setup'] });
        setArcs([arc]);
        expect(removeArc(arc.id)).toBe(true);
        expect(getArcs()).toEqual([]);
        expect(getPlanHistory()).toHaveLength(1);
        expect(getPlanHistory()[0].arcs[0].beats[0]).toEqual(arc.beats[0]);
    });

    test('prompt markers never enter portable markdown or narrator injection', () => {
        const ready = prepareStore(storyPlannerSchema, { arcs: [cloneV1(V1_READY_ARC)] }, { version: 1 }).data.arcs[0];
        setArcs([ready]);
        const portable = serializeArcsToText(getArcs());
        expect(portable).not.toMatch(/\[ARC:|\[PLANTED\]|\[CURRENT\]/);
        expect(buildInjectionBody()).not.toMatch(/\[ARC:|beat-/);
        expect(getCurrentBeat(ready)).toBe('');
    });
});