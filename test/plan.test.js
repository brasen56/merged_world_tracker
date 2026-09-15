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

import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';
import {
    state, makeArc, getArcs, setArcs, parsePlanTextToArcs, serializeArcsToText, mergeRegeneratedArcs,
} from '../story_planner/data.js';
import {
    getInjectMode, getArcCount, getAutoInterval, isInjectionEnabled, isAutoEnabled,
    usesGlobalDefaults,
    setUsesGlobalDefaults, setPlanSetting,
} from '../story_planner/data.js';
import { buildUserPrompt, generatePlan } from '../story_planner/generation.js';
import { saveSettings } from '../story_planner/settings.js';
import { _resetEpoch } from '../core/scope.js';
import { _resetPausedStores } from '../core/schema_status.js';
import {
    resetCoreStubs, getFakeMeta, getFakeExtSettings, setFakeChat, setFakeApi,
} from './stubs/core.js';

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

    test('closed-memory content stays inside its prompt boundary', () => {
        setArcs([{ ...makeArc({ title: 'Closed </closed_story_ideas>', status: 'resolved' }), body: 'reason & detail' }]);
        const prompt = buildUserPrompt('recent');
        expect(prompt).toContain('&lt;/closed_story_ideas>');
        expect((prompt.match(/<\/closed_story_ideas>/g) || [])).toHaveLength(1);
        expect(prompt).toContain('reason &amp; detail');
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

describe('request-local arc handles', () => {
    const stored = (title, id, extra = {}) => ({ ...makeArc({ title, section: 'horizon', ...extra }), id });
    const parse = (lines, captured, handles) => parsePlanTextToArcs(
        ['## Horizon Arcs', ...lines].join('\n'),
        { capturedArcs: captured, handles: new Map(Object.entries(handles || {})) },
    );

    test('a handle round-trips without exposing stored ids', () => {
        const arc = stored('The Ledger', 'stored-arc-id', { body: 'A debt comes due.' });
        const text = serializeArcsToText([arc], { handles: new Map([[arc.id, 'k7q']]) });

        expect(text).toContain('- [ARC:k7q] The Ledger — A debt comes due.');
        expect(text).not.toContain('stored-arc-id');

        const [parsed] = parsePlanTextToArcs(text, { handles: new Map([['k7q', arc]]), capturedArcs: [arc] });
        expect(parsed.id).toBe('stored-arc-id');
        expect(parsed.title).toBe('The Ledger');
    });

    test('a handle carries a renamed arc', () => {
        const arc = stored('The Ledger', 'ledger-id');
        const [parsed] = parse(['- [ARC:k7q] The Unpaid Debt — renamed'], [arc], { k7q: arc });
        expect(parsed.id).toBe('ledger-id');
        expect(parsed.title).toBe('The Unpaid Debt');
    });

    test('a marker anywhere on the line is stripped from the stored text and still binds', () => {
        const ledger = stored('The Ledger', 'ledger-id');
        const rival = stored('The Rival', 'rival-id');
        const heir = stored('The Heir', 'heir-id');
        const parsed = parse([
            '- **[ARC:k7q] The Ledger** — bolded together with the name',
            '- The Rival [ARC:m4t] — moved after the name like an annotation',
            '- [ ARC: X9Z ] The Heir — spaced and uppercased [ARC:x9z]',
            '  1. A beat that picked up a marker [ARC:x9z]',
        ], [ledger, rival, heir], { k7q: ledger, m4t: rival, x9z: heir });

        expect(parsed.map(arc => arc.title)).toEqual(['The Ledger', 'The Rival', 'The Heir']);
        expect(parsed.map(arc => arc.id)).toEqual(['ledger-id', 'rival-id', 'heir-id']);
        expect(parsed[2].body).toBe('spaced and uppercased');
        expect(parsed[2].beats).toEqual(['A beat that picked up a marker']);
        expect(JSON.stringify(parsed)).not.toMatch(/ARC/);
    });

    test('an unambiguous title binds without a handle; a duplicated title does not', () => {
        const arc = stored('The Ledger', 'ledger-id');
        const [exact] = parse(['- The Ledger! — A refined description.'], [arc]);
        expect(exact.id).toBe('ledger-id');

        const twin = stored('The Ledger', 'twin-id');
        const [ambiguous] = parse(['- The Ledger — A debt comes due.'], [arc, twin]);
        expect(['ledger-id', 'twin-id']).not.toContain(ambiguous.id);
    });

    test('an unknown or mis-copied handle falls back to the title', () => {
        const arc = stored('The Ledger', 'ledger-id');
        const [parsed] = parse(['- [ARC:a1] The Ledger — the prompt example, copied'], [arc], { k7q: arc });
        expect(parsed.id).toBe('ledger-id');
    });

    test('swapped markers never move an arc onto another arc that its title names', () => {
        const ledger = stored('The Ledger', 'ledger-id');
        const rival = stored('The Rival', 'rival-id');
        const [one, two] = parse([
            '- [ARC:m4t] The Ledger — carries the rival marker',
            '- [ARC:k7q] The Rival — carries the ledger marker',
        ], [ledger, rival], { k7q: ledger, m4t: rival });
        expect(one.id).toBe('ledger-id');
        expect(two.id).toBe('rival-id');
    });

    test('a handle on two lines identifies neither line; titles still resolve', () => {
        const first = stored('First', 'first-id');
        const second = stored('Second', 'second-id');
        const [one, two, three] = parse([
            '- [ARC:k7q] First — revised',
            '- [ARC:k7q] Second — revised',
            '- [ARC:k7q] Renamed Beyond Recognition — revised',
        ], [first, second], { k7q: first });
        expect(one.id).toBe('first-id');
        expect(two.id).toBe('second-id');
        expect(['first-id', 'second-id']).not.toContain(three.id);
    });

    test('the line that kept its marker wins over an earlier marker-less copy', () => {
        const arc = stored('The Ledger', 'ledger-id', { beats: ['b1', 'b2', 'b3'], beatIndex: 1 });
        const parsed = parse([
            '- The Ledger — a marker-less copy',
            '- [ARC:k7q] The Ledger — the carried arc',
            '  1. b1',
            '  2. b2',
        ], [arc], { k7q: arc });
        expect(parsed[0].id).not.toBe('ledger-id');
        expect(parsed[1].id).toBe('ledger-id');

        const { arcs } = mergeRegeneratedArcs([arc], parsed);
        const kept = arcs.filter(a => a.id === 'ledger-id');
        expect(kept).toHaveLength(1);
        expect(kept[0].body).toBe('the carried arc');
        expect(kept[0].beatIndex).toBe(1);
        expect(new Set(arcs.map(a => a.id)).size).toBe(arcs.length);
    });
});

describe('merge identity', () => {
    test('a title match cannot take an arc that a later incoming id claims', () => {
        const arc = makeArc({ title: 'The Ledger', beats: ['b1', 'b2'], beatIndex: 1 });
        const copy = makeArc({ title: 'The Ledger', body: 'title-only copy' });
        const carried = { ...makeArc({ title: 'The Ledger', body: 'carried', beats: ['b1', 'b2'] }), id: arc.id };

        const { arcs } = mergeRegeneratedArcs([arc], [copy, carried]);

        expect(arcs.find(a => a.id === arc.id).body).toBe('carried');
        expect(arcs.find(a => a.id === copy.id).beatIndex).toBe(0);
    });

    test('two incoming arcs naming one id never leave the merge sharing it', () => {
        const arc = makeArc({ title: 'The Ledger' });
        const incoming = [
            { ...makeArc({ title: 'The Ledger', body: 'first' }), id: arc.id },
            { ...makeArc({ title: 'The Ledger', body: 'second' }), id: arc.id },
        ];

        const { arcs } = mergeRegeneratedArcs([arc], incoming);

        expect(arcs.find(a => a.id === arc.id).body).toBe('first');
        expect(new Set(arcs.map(a => a.id)).size).toBe(2);
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

describe('generatePlan request identity', () => {
    let requests;
    let respond;

    // Read the handle the prompt gave an arc, the way a model would.
    const handleOf = (request, title) =>
        request.userContent.match(new RegExp(`\\[ARC:([a-z0-9]+)\\] ${title}`))[1];

    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        _resetPausedStores();
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-plan' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(Array.from({ length: 8 }, (_, i) => ({
            name: i % 2 ? 'Mara' : 'User', is_user: i % 2 === 0,
            mes: `Message number ${i} of the scene, long enough for the history gate.`,
        })));
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        state.isGenerating = false;
        requests = [];
        setFakeApi(async (request) => {
            requests.push(request);
            return respond(request);
        });
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        state.isGenerating = false;
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.document;
    });

    function seed() {
        setArcs([
            makeArc({ title: 'The Ledger', body: 'A debt comes due.', section: 'horizon', beats: ['b1', 'b2', 'b3'], beatIndex: 1 }),
            makeArc({ title: 'The Rival', body: 'A rival moves.', section: 'horizon', beats: ['r1', 'r2'], beatIndex: 1 }),
            makeArc({ title: 'Filler', body: 'Background.', section: 'horizon' }),
        ]);
        const [ledger, rival, filler] = getArcs();
        return { ledger, rival, filler };
    }

    test('the prompt carries short unique handles and never a stored id', async () => {
        const { ledger, rival, filler } = seed();
        respond = () => '## Horizon Arcs\n- The Ledger — a\n- The Rival — b\n- Filler — c';

        await generatePlan();

        const handles = [...requests[0].userContent.matchAll(/^- \[ARC:([^\]…]+)\]/gm)].map(match => match[1]);
        expect(handles).toHaveLength(3);
        expect(new Set(handles).size).toBe(3);
        handles.forEach(handle => expect(handle).toMatch(/^[a-z][2-9][a-z]$/));
        for (const arc of [ledger, rival, filler]) expect(requests[0].userContent).not.toContain(arc.id);
    });

    test('an arc the model renames but keeps the marker on keeps its progress', async () => {
        const { ledger } = seed();
        respond = request => [
            '## Horizon Arcs',
            `- [ARC:${handleOf(request, 'The Ledger')}] The Unpaid Debt — the debt, renamed`,
            '  1. b1',
            '  2. b2',
            '- The Rival — b',
            '- Filler — c',
        ].join('\n');

        await generatePlan();

        const arcs = getArcs();
        expect(arcs.map(arc => arc.title)).toEqual(['The Unpaid Debt', 'The Rival', 'Filler']);
        const renamed = arcs.find(arc => arc.id === ledger.id);
        expect(renamed.title).toBe('The Unpaid Debt');
        expect(renamed.beatIndex).toBe(1);
    });

    test('a marker bolded with the name or moved after it neither leaks nor forks the arc', async () => {
        const { ledger, rival } = seed();
        respond = request => [
            '## Horizon Arcs',
            `- **[ARC:${handleOf(request, 'The Ledger')}] The Ledger** — refined`,
            '  1. b1',
            '  2. b2 rewritten',
            `- The Rival [ARC:${handleOf(request, 'The Rival')}] — refined`,
            '  1. r1',
            '  2. r2',
            '- Filler — c',
        ].join('\n');

        await generatePlan();

        const arcs = getArcs();
        expect(arcs.map(arc => arc.title)).toEqual(['The Ledger', 'The Rival', 'Filler']);
        expect(arcs.find(arc => arc.id === ledger.id).beats).toEqual(['b1', 'b2 rewritten']);
        expect(arcs.find(arc => arc.id === rival.id).beatIndex).toBe(1);
        expect(serializeArcsToText(arcs)).not.toContain('ARC');
    });

    test('swapped markers do not move planted progress between arcs', async () => {
        const { ledger, rival } = seed();
        respond = request => [
            '## Horizon Arcs',
            `- [ARC:${handleOf(request, 'The Rival')}] The Ledger — refined`,
            '  1. b1',
            '  2. b2',
            `- [ARC:${handleOf(request, 'The Ledger')}] The Rival — refined`,
            '  1. r1',
            '  2. r2',
            '- Filler — c',
        ].join('\n');

        await generatePlan();

        const arcs = getArcs();
        expect(arcs.find(arc => arc.id === ledger.id).beats).toEqual(['b1', 'b2']);
        expect(arcs.find(arc => arc.id === rival.id).beats).toEqual(['r1', 'r2']);
    });

    test('an arc the user adds while generation is in flight survives the commit', async () => {
        seed();
        respond = () => {
            setArcs([...getArcs().map(arc => ({ ...arc })), makeArc({ title: 'Added mid-flight', section: 'horizon' })]);
            return '## Horizon Arcs\n- The Ledger — a\n- The Rival — b\n- Filler — c';
        };

        await generatePlan();

        expect(getArcs().map(arc => arc.title)).toContain('Added mid-flight');
    });

    test('an arc deleted in flight is not resurrected when the model renames it', async () => {
        const { ledger } = seed();
        respond = request => {
            const handle = handleOf(request, 'The Ledger');
            setArcs(getArcs().filter(arc => arc.id !== ledger.id).map(arc => ({ ...arc })));
            return `## Horizon Arcs\n- [ARC:${handle}] The Unpaid Debt — renamed\n- The Rival — b\n- Filler — c`;
        };

        await generatePlan();

        expect(getArcs().map(arc => arc.title)).toEqual(['The Rival', 'Filler']);
    });
});
