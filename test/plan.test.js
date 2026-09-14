/**
 * test/plan.test.js — Story-plan serialize → parse round-trip.
 *
 * The property worth protecting: the annotated plan we hand the model on
 * regeneration must parse back to the arcs it came from. Every marker the
 * serializer adds for the model's benefit ([PINNED], [PLANTED], …) is text the
 * model can echo, and anything not stripped on the way back in becomes part of
 * the stored title — which is the merge key, so a polluted title silently
 * duplicates the arc instead of matching it.
 */

import { beforeEach, describe, test, expect } from 'vitest';
import {
    makeArc, parsePlanTextToArcs, serializeArcsToText, mergeRegeneratedArcs,
} from '../story_planner/data.js';
import {
    getInjectMode, getArcCount, getAutoInterval, isInjectionEnabled, isAutoEnabled,
    usesGlobalDefaults,
    setUsesGlobalDefaults, setPlanSetting,
} from '../story_planner/data.js';
import { resetCoreStubs, getFakeMeta, getFakeExtSettings } from './stubs/core.js';

describe('story planner settings scope', () => {
    beforeEach(() => resetCoreStubs());

    test('new chats resolve global defaults', () => {
        getFakeExtSettings().mwt_story_planner = {
            injectMode: 'pinned', arcCount: 6, autoInterval: 14,
        };
        expect(usesGlobalDefaults()).toBe(true);
        expect(getInjectMode()).toBe('pinned');
        expect(getArcCount()).toBe(6);
        expect(getAutoInterval()).toBe(14);
    });

    test('chat overrides remain isolated from global defaults', () => {
        getFakeExtSettings().mwt_story_planner = { injectMode: 'pinned', arcCount: 6 };
        setUsesGlobalDefaults(false);
        setPlanSetting('injectMode', 'active');
        setPlanSetting('arcCount', 18);
        expect(getInjectMode()).toBe('active');
        expect(getArcCount()).toBe(18);
        expect(getFakeExtSettings().mwt_story_planner.injectMode).toBe('pinned');
        expect(getFakeMeta().story_planner_data.settingsOverride).toMatchObject({ injectMode: 'active', arcCount: 18 });
    });

    test('entering local mode snapshots every effective setting', () => {
        getFakeExtSettings().mwt_story_planner = {
            injectMode: 'pinned', enforcement: 'assertive', arcCount: 6,
            autoInterval: 14, injectEnabled: false, autoEnabled: true,
        };
        setUsesGlobalDefaults(false);
        const overrides = getFakeMeta().story_planner_data.settingsOverride;
        expect(overrides).toEqual({
            injectMode: 'pinned', enforcement: 'assertive', arcCount: 6,
            autoInterval: 14, injectEnabled: false, autoEnabled: true,
        });
        getFakeExtSettings().mwt_story_planner.autoEnabled = false;
        expect(isAutoEnabled()).toBe(true);
        expect(isInjectionEnabled()).toBe(false);
    });

    test('legacy local records use historical defaults for missing keys', () => {
        getFakeExtSettings().mwt_story_planner = { autoEnabled: true, arcCount: 4 };
        getFakeMeta().story_planner_data = { useGlobalDefaults: false, autoEnabled: false };
        expect(isAutoEnabled()).toBe(false);
        expect(getInjectMode()).toBe('all');
        expect(getAutoInterval()).toBe(10);
    });

    test('re-entering local mode snapshots the current global value, not a stale one', () => {
        // A pre-existing chat left over from before this feature: it already
        // carries a per-chat injectMode from the old all-local-only storage.
        getFakeMeta().story_planner_data = { injectMode: 'pinned' };
        getFakeExtSettings().mwt_story_planner = { injectMode: 'all' };
        expect(usesGlobalDefaults()).toBe(false); // legacy heuristic
        expect(getInjectMode()).toBe('pinned');

        // Switch the chat to global defaults, then let the global value change
        // (e.g. edited from the Settings tab, or by another chat).
        setUsesGlobalDefaults(true);
        expect(getInjectMode()).toBe('all');
        getFakeExtSettings().mwt_story_planner.injectMode = 'active';
        expect(getInjectMode()).toBe('active');

        // Opt this chat back out of global defaults. The starting point must
        // be what was just in effect ('active'), not the old buried 'pinned'.
        setUsesGlobalDefaults(false);
        expect(getInjectMode()).toBe('active');
    });
});

describe('arc flag round-trip', () => {

    test('a pinned arc echoed back verbatim keeps its clean title', () => {
        // ARRANGE: exactly what the model sees in <previous_plan>.
        const pinned = makeArc({
            title: 'Vocal Cord Relapse', body: 'Alex overuses her voice.',
            section: 'emerging', pinned: true,
        });
        const annotated = serializeArcsToText([pinned], { annotateStatus: true });
        expect(annotated).toContain('[PINNED]');

        // ACT: the model returns the block unchanged.
        const [parsed] = parsePlanTextToArcs(annotated);

        // ASSERT: the flag is a marker, not part of the name.
        expect(parsed.title).toBe('Vocal Cord Relapse');
    });

    test('an echoed flag no longer forks the arc on merge', () => {
        // ARRANGE
        const pinned = makeArc({ title: 'Vocal Cord Relapse', section: 'emerging', pinned: true });
        const echoed = parsePlanTextToArcs(
            serializeArcsToText([pinned], { annotateStatus: true }),
        );

        // ACT
        const { arcs, matched, added } = mergeRegeneratedArcs([pinned], echoed);

        // ASSERT: one arc, matched to the original — not a pinned/unpinned pair.
        expect(matched).toBe(1);
        expect(added).toBe(0);
        expect(arcs).toHaveLength(1);
        expect(arcs[0].id).toBe(pinned.id);
        expect(arcs[0].pinned).toBe(true);
    });

    test('combined flags are stripped, and real brackets in a title survive', () => {
        expect(parsePlanTextToArcs('- Foo [RESOLVED, PINNED] — body')[0].title).toBe('Foo');
        expect(parsePlanTextToArcs('- Foo [SETUP COMPLETE]')[0].title).toBe('Foo');
        // Not one of our flags — the model meant it, so keep it.
        expect(parsePlanTextToArcs('- The Hollow [Redacted] — body')[0].title)
            .toBe('The Hollow [Redacted]');
    });

    test('planted beat markers still round-trip clean', () => {
        const arc = makeArc({
            title: 'Ezra Confidence', section: 'emerging',
            beats: ['Ezra drafts the language', 'Ezra shows it'], beatIndex: 1,
        });
        const annotated = serializeArcsToText([arc], { annotateStatus: true });
        expect(annotated).toContain('[PLANTED]');

        const [parsed] = parsePlanTextToArcs(annotated);
        expect(parsed.beats).toEqual(['Ezra drafts the language', 'Ezra shows it']);
    });
});

describe('regeneration progress safety', () => {
    test('preserves the exact planted prefix and replaces only pending beats', () => {
        const previous = makeArc({
            title: 'Harbour Secret', section: 'emerging',
            beats: ['Stored setup wording', 'Await the tide', 'Open the sealed room'],
            beatIndex: 1, turnsSinceAdvance: 4,
        });
        const incoming = makeArc({
            title: 'Harbour Secret', section: 'emerging',
            beats: ['Stored setup wording', 'A model rewrite of the next step'],
        });

        const { arcs } = mergeRegeneratedArcs([previous], [incoming]);

        expect(arcs[0].beats).toEqual(['Stored setup wording', 'A model rewrite of the next step']);
        expect(arcs[0].beatIndex).toBe(1);
        expect(arcs[0].turnsSinceAdvance).toBe(0); // the current beat changed
    });

    test('keeps stored pending beats when the model returns only planted beats', () => {
        const previous = makeArc({
            title: 'The Ledger', beats: ['Plant the clue', 'Confront the witness'],
            beatIndex: 1, turnsSinceAdvance: 3,
        });
        // The parser removes [PLANTED] before merge; merge receives clean beat
        // strings even when the model echoed the annotation.
        const incoming = makeArc({ title: 'The Ledger', beats: ['Plant the clue'] });

        const { arcs } = mergeRegeneratedArcs([previous], [incoming]);

        expect(arcs[0].beats).toEqual(previous.beats);
        expect(arcs[0].beatIndex).toBe(1);
        expect(arcs[0].turnsSinceAdvance).toBe(3);
    });

    test('a Ready arc ignores model beat output and remains Ready', () => {
        const previous = makeArc({
            title: 'Ready Thread', beats: ['Already planted'], beatIndex: 1,
            turnsSinceAdvance: 8,
        });
        const incoming = makeArc({ title: 'Ready Thread', beats: ['Invented setup'] });

        const { arcs } = mergeRegeneratedArcs([previous], [incoming]);

        expect(arcs[0].beats).toEqual(previous.beats);
        expect(arcs[0].beatIndex).toBe(1);
        expect(arcs[0].turnsSinceAdvance).toBe(8);
    });

    test('deleted and materially edited arcs are not resurrected or overwritten', () => {
        const deleted = makeArc({ title: 'Deleted Arc' });
        const edited = makeArc({ title: 'Edited Arc', body: 'User version' });
        const incoming = [
            makeArc({ title: 'Deleted Arc', body: 'Stale response' }),
            makeArc({ title: 'Edited Arc', body: 'Model version' }),
            makeArc({ title: 'New Arc', body: 'Fresh idea' }),
        ];

        const { arcs } = mergeRegeneratedArcs([edited], incoming, {
            deletedIds: new Set([deleted.id]),
            deletedTitles: new Set(['deleted arc']),
            protectedIds: new Set([edited.id]),
        });

        expect(arcs.map(arc => arc.title)).toEqual(['Edited Arc', 'New Arc']);
        expect(arcs.find(arc => arc.title === 'Edited Arc').body).toBe('User version');
    });

    test('a deleted title re-added by the user during the call is not tombstoned', () => {
        // The user deleted the original 'Phoenix' arc and created a fresh one
        // with the same title while generation was in flight. The in-flight
        // tombstone must block the model's stale 'Phoenix' only when no live
        // arc bears that title; the re-added arc is live and should be refreshed,
        // not dropped.
        const deleted = makeArc({ title: 'Phoenix', beats: ['Old setup', 'Old payoff'], beatIndex: 1 });
        const readded = makeArc({ title: 'Phoenix', body: 'User recreated it' });
        const incoming = [makeArc({ title: 'Phoenix', beats: ['Fresh setup', 'Fresh payoff'] })];

        const { arcs } = mergeRegeneratedArcs([readded], incoming, {
            deletedIds: new Set([deleted.id]),
            deletedTitles: new Set(['phoenix']),
        });

        expect(arcs.map(arc => arc.title)).toEqual(['Phoenix']);
        expect(arcs[0].id).toBe(readded.id);
        expect(arcs[0].beats).toEqual(['Fresh setup', 'Fresh payoff']);
    });
});
