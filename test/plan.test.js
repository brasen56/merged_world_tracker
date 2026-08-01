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

import { describe, test, expect } from 'vitest';
import {
    makeArc, parsePlanTextToArcs, serializeArcsToText, mergeRegeneratedArcs,
} from '../story_planner/data.js';

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
