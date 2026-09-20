/**
 * test/beats.test.js — Beat-reminder bookkeeping.
 *
 * The property worth protecting: a beat that stalls must keep reminding the
 * user, and a beat that moves must stop. Both failures are silent — an arc that
 * stops reminding stalls forever with no signal, and one that reminds every turn
 * gets the whole feature switched off. The nudge marks are what keep those apart,
 * so this file pins their behaviour.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { resetCoreStubs, getFakeMeta, getFakeNotifications } from './stubs/core.js';
import {
    state, makeArc, setArcs, getArcs, advanceBeat, buildClosedMemoryProjection,
    getCurrentBeatRecord,
    incrementArcTurns, getArcsAwaitingBeat, getOverdueArcs,
    takeDueNudges, getNudgeTurns, OVERDUE_TURNS,
    setArcStatus,
} from '../story_planner/data.js';
import { V1_READY_ARC, cloneV1 } from './fixtures/story_planner_phase0.js';
import { createCommands } from '../core/commands.js';

beforeEach(() => resetCoreStubs());

/** Seed one arc and age it to `turns` without going through the message hook. */
function seedArc({ beats = ['step one', 'step two'], turns = 0, ...rest } = {}) {
    const arc = { ...makeArc({ title: 'Test Arc', beats, ...rest }), turnsSinceAdvance: turns };
    setArcs([arc]);
    return arc;
}

describe('getArcsAwaitingBeat', () => {

    test('counts only arcs with a beat the user could actually act on', () => {
        const waiting = makeArc({ title: 'Waiting', beats: ['a', 'b'] });
        const hook = makeArc({ title: 'Immediate Hook', beats: [] });
        const ready = makeArc({ title: 'Ready', beats: ['a'], beatIndex: 1 });
        const resolved = { ...makeArc({ title: 'Done', beats: ['a'] }), status: 'resolved' };
        setArcs([waiting, hook, ready, resolved]);

        // A hook has no beat, a ready arc has none LEFT, a resolved arc is out of
        // play. Counting any of them would inflate the badge with things clicking
        // "planted" cannot change.
        expect(getArcsAwaitingBeat().map(a => a.title)).toEqual(['Waiting']);
    });
});

describe('incrementArcTurns', () => {

    test('reports whether anything changed, so the caller can re-apply injection', () => {
        expect(incrementArcTurns()).toBe(false);   // no arcs at all

        seedArc();
        expect(incrementArcTurns()).toBe(true);
        expect(getArcs()[0].turnsSinceAdvance).toBe(1);
    });

    test('does not age arcs that are no longer active', () => {
        setArcs([{ ...makeArc({ title: 'Dropped', beats: ['a'] }), status: 'dropped' }]);
        expect(incrementArcTurns()).toBe(false);
        expect(getArcs()[0].turnsSinceAdvance).toBe(0);
    });
});

describe('takeDueNudges', () => {

    test('stays silent until a beat crosses the threshold', () => {
        seedArc({ turns: getNudgeTurns() - 1 });
        expect(takeDueNudges()).toEqual([]);
    });

    test('fires once on crossing, then stays quiet until the next multiple', () => {
        const threshold = getNudgeTurns();
        seedArc({ turns: threshold });

        expect(takeDueNudges()).toHaveLength(1);

        // Every turn from here to 2x is the spam case — the user already knows.
        for (let t = threshold + 1; t < threshold * 2; t++) {
            setArcs([{ ...getArcs()[0], turnsSinceAdvance: t }]);
            expect(takeDueNudges(), `turn ${t} should be quiet`).toEqual([]);
        }

        // Twice as stale is worth saying again.
        setArcs([{ ...getArcs()[0], turnsSinceAdvance: threshold * 2 }]);
        expect(takeDueNudges()).toHaveLength(1);
    });

    test('an advanced arc can nudge again on its NEXT beat', () => {
        // THE REGRESSION THIS FILE EXISTS FOR. advanceBeat() resets the wait to 0
        // but leaves the arc awaiting its next beat, so it stays in the live set.
        // Pruning only dead arcs would leave the mark at 1 and suppress the next
        // reminder until the arc was TWICE as stale as the threshold — the exact
        // silent stall the reminder is supposed to prevent.
        const threshold = getNudgeTurns();
        const arc = seedArc({ beats: ['step one', 'step two'], turns: threshold });
        expect(takeDueNudges()).toHaveLength(1);

        advanceBeat(arc.id);
        expect(getArcs()[0].turnsSinceAdvance).toBe(0);
        expect(getArcs()[0].beats.map(beat => beat.state)).toEqual(['planted', 'pending']);

        setArcs([{ ...getArcs()[0], turnsSinceAdvance: threshold }]);
        expect(takeDueNudges(), 'second beat must be able to nudge').toHaveLength(1);
    });

    test('marks for arcs that left the waiting set are pruned', () => {
        const threshold = getNudgeTurns();
        const arc = seedArc({ beats: ['only step'], turns: threshold });
        takeDueNudges();
        expect(Object.keys(getFakeMeta().story_planner_data.nudgeMarks)).toEqual([`${arc.id}#${getCurrentBeatRecord(arc).id}`]);

        // Planting the last beat makes the arc READY — nothing left to remind about.
        advanceBeat(arc.id);
        expect(takeDueNudges()).toEqual([]);
        expect(getFakeMeta().story_planner_data.nudgeMarks).toEqual({});
    });

    test('honours the disable switch', () => {
        seedArc({ turns: getNudgeTurns() * 3 });
        getFakeMeta().story_planner_data.nudgeEnabled = false;
        expect(takeDueNudges()).toEqual([]);
    });

    test('reminds for an overdue Ready arc without adding it to waiting beats', () => {
        const arc = seedArc({ beats: ['only step'] });
        advanceBeat(arc.id);
        setArcs([{ ...getArcs()[0], turnsSinceAdvance: getNudgeTurns() }]);
        expect(getArcsAwaitingBeat()).toEqual([]);
        expect(takeDueNudges().map(a => a.id)).toEqual([arc.id]);
        expect(takeDueNudges()).toEqual([]);
    });
});

describe('closed regeneration memory', () => {
    test('is bounded and never includes closed beat lists', () => {
        const arcs = Array.from({ length: 100 }, (_, i) => makeArc({
            title: `Closed ${i}`,
            body: `Reason ${i}`,
            status: i % 2 ? 'dropped' : 'resolved',
            beats: [`private setup route ${i}`],
            updatedAt: i,
        }));
        const projection = buildClosedMemoryProjection(arcs);
        expect(projection.length).toBeLessThanOrEqual(6000);
        expect(projection.split('\n')).toHaveLength(20);
        expect(projection).toContain('[resolved]');
        expect(projection).not.toContain('private setup route');
    });
});

describe('getOverdueArcs', () => {

    test('is a pure query — repeated calls do not consume the nudge', () => {
        seedArc({ turns: getNudgeTurns() });
        expect(getOverdueArcs()).toHaveLength(1);
        expect(getOverdueArcs()).toHaveLength(1);
        // The badge polls this every 5s; if it recorded marks, the toast would
        // never fire because the badge would always have claimed it first.
        expect(getFakeMeta().story_planner_data?.nudgeMarks).toBeUndefined();
    });

    test('sorts longest-waiting first', () => {
        setArcs([
            { ...makeArc({ title: 'Recent', beats: ['a'] }), turnsSinceAdvance: 20 },
            { ...makeArc({ title: 'Ancient', beats: ['a'] }), turnsSinceAdvance: 99 },
        ]);
        expect(getOverdueArcs().map(a => a.title)).toEqual(['Ancient', 'Recent']);
    });
});

describe('getNudgeTurns', () => {

    test('defaults to the shared threshold and clamps absurd values', () => {
        expect(getNudgeTurns()).toBe(OVERDUE_TURNS);

        getFakeMeta().story_planner_data = { nudgeTurns: 0 };
        expect(getNudgeTurns()).toBe(3);

        getFakeMeta().story_planner_data = { nudgeTurns: 9999 };
        expect(getNudgeTurns()).toBe(60);
    });

    test('one threshold drives the injection, the card badge, and the reminder', async () => {
        // These three read the same setting from three different files. They used
        // to be a const in injection.js and a bare `12` in render.js, which is the
        // drift the SECTIONS comment in data.js warns about — a user raising the
        // reminder interval would have silently kept a 12-turn amber badge.
        const { buildInjectionBody } = await import('../story_planner/injection.js');
        const { render } = await import('../story_planner/render.js');

        setArcs([{ ...makeArc({ title: 'Slow Burn', beats: ['a beat'] }), turnsSinceAdvance: 20 }]);
        getFakeMeta().story_planner_data.nudgeTurns = 30;

        expect(getOverdueArcs()).toEqual([]);
        expect(buildInjectionBody()).not.toContain('still waiting');
        expect(render()).not.toContain('sp-beat-badge--overdue');

        getFakeMeta().story_planner_data.nudgeTurns = 10;

        expect(getOverdueArcs()).toHaveLength(1);
        expect(buildInjectionBody()).toContain('still waiting after 20 turns');
        expect(render()).toContain('sp-beat-badge--overdue');
    });
});

describe('story planner render', () => {

    test('exposes the reminder controls and escapes arc text', async () => {
        const { render } = await import('../story_planner/render.js');
        setArcs([makeArc({ title: '<img src=x onerror=alert(1)>', beats: ['a beat & more'] })]);
        const html = render();

        expect(html).toContain('sp-nudge-enabled');
        expect(html).toContain('sp-nudge-turns');
        expect(html).toContain('/wt-beat');
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img src=x');
        expect(html).toContain('a beat &amp; more');
    });
});

describe('Phase 0 — overdue Ready lifecycle', () => {
    test('/wt-plan opens the review-first scoped flow instead of reporting an immediate commit', async () => {
        let planCommand;
        let description = '';
        const triggerGenerate = vi.fn(async () => ({ reviewOpened: true }));
        createCommands({
            registerSlashCommand: (name, handler, _aliases, help) => {
                if (name === 'wt-plan') {
                    planCommand = handler;
                    description = help;
                }
            },
            macroRegistry: null,
            modules: { WorldState: {}, Chronicle: {}, Knowledge: {}, StoryPlanner: { triggerGenerate }, Interiority: {} },
        }).setupSlashCommands();

        await expect(planCommand('')).resolves.toContain('review before applying');
        expect(triggerGenerate).toHaveBeenCalledTimes(1);
        expect(description).toContain('for review');
    });

    test('an overdue Ready arc is remindable and /wt-beat resolves its Ready reference', async () => {
        const ready = cloneV1(V1_READY_ARC);
        ready.turnsSinceAdvance = getNudgeTurns() - 1;
        setArcs([ready]);

        const StoryPlanner = await import('../story_planner/index.js');
        await StoryPlanner.onMessageReceived();
        expect(getArcs()[0].turnsSinceAdvance).toBe(getNudgeTurns());
        expect(getFakeNotifications()).toContainEqual(expect.objectContaining({
            title: 'Story Planner',
            message: expect.stringContaining(`Ready ${getNudgeTurns()} turns: "${ready.title}"`),
        }));
        expect(getFakeMeta().story_planner_data.nudgeMarks).toHaveProperty(`${ready.id}#ready`);
        expect(StoryPlanner.listBeats()).toEqual([]);
        expect(StoryPlanner.listReadyArcs()).toEqual([expect.objectContaining({ ref: 'R1', id: ready.id })]);

        let beatCommand;
        createCommands({
            registerSlashCommand: (name, handler) => { if (name === 'wt-beat') beatCommand = handler; },
            macroRegistry: null,
            modules: { WorldState: {}, Chronicle: {}, Knowledge: {}, StoryPlanner, Interiority: {} },
        }).setupSlashCommands();

        await expect(beatCommand('')).resolves.toContain(`R1. [Ready, ${getNudgeTurns()} turns] ${ready.title}`);
        await expect(beatCommand('resolve R1')).resolves.toBe(`"${ready.title}" — resolved.`);
        expect(getArcs()[0].status).toBe('resolved');
        expect(getArcs()[0].beats.every(beat => beat.state === 'planted')).toBe(true);
    });

    test('the card status dropdown reopens after a long wait through the shared transition', async () => {
        const ready = cloneV1(V1_READY_ARC);
        ready.turnsSinceAdvance = getNudgeTurns() * 3;
        setArcs([ready]);
        expect(takeDueNudges()).toHaveLength(1);
        expect(getFakeMeta().story_planner_data.nudgeMarks).toHaveProperty(`${ready.id}#ready`);

        setArcStatus(ready.id, 'resolved');
        const listeners = {};
        const arcsHost = {
            innerHTML: '',
            addEventListener: (type, handler) => { listeners[type] = handler; },
            querySelectorAll: () => [],
        };
        state.modal = {
            querySelector: selector => selector === '#sp-arcs' ? arcsHost : null,
            querySelectorAll: () => [],
        };
        const { wireEvents } = await import('../story_planner/render.js');
        wireEvents();
        listeners.change({
            target: {
                closest: () => ({ dataset: { action: 'status', id: ready.id }, value: 'active' }),
            },
        });
        const reopened = getArcs()[0];

        expect(reopened).toMatchObject({ status: 'active', turnsSinceAdvance: 0 });
        expect(getFakeMeta().story_planner_data.nudgeMarks).toEqual({});
        expect(takeDueNudges()).toEqual([]);
        state.modal = null;
    });
});
