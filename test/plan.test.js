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
