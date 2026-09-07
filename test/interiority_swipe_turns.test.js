/**
 * test/interiority_swipe_turns.test.js — swipes must not leak dormancy state.
 *
 * THE BUG (reported from live use): intentions were "waking up" sooner than
 * they should. Two leaks, both swipe-shaped:
 *
 *   1. The dormant-poll turn counter increments after every APPLIED generation
 *      — and swipes cause generations (fresh-slot swipes via the deferred
 *      MESSAGE_RECEIVED, swipe-navigation and last-message edits via the
 *      direct regenerate path). Nothing ever rolled the counter back, so five
 *      swipes on one message looked like five story turns to the scheduler
 *      and the poll (hence wakes) fired ahead of real story time.
 *
 *   2. The dormant poll runs BEFORE validateAndApply, but the rollback ledger
 *      snapshot used to be captured INSIDE validateAndApply — after the
 *      poll's wakes were already committed. The rollback record therefore
 *      held the entry as active, and a swipe faithfully "restored" the woken
 *      state: a wake justified by a message that no longer exists survived.
 *
 * The fix: validateAndApply stamps `turnCounterAtSnapshot` (pre-turn value)
 * into the perMessage record and accepts a pre-poll ledger snapshot from the
 * caller; the swipe/edit/delete rollback paths restore both. A swipe cycle
 * now nets to zero turns, and because isDormantPollDue() looks ahead by one,
 * a poll that fired on the discarded turn re-fires against the new content.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { resetCoreStubs, setFakeChat } from './stubs/core.js';
import {
    getLedger, addLedgerEntry, addManualLedgerEntry, updateLedgerEntry,
    wakeLedgerEntry, restoreLedgerSnapshot,
    getTurnCounter, incrementTurnCounter, restoreTurnCounter,
    setPerMessage, getOrCreateMsgKeyForIndex, getInteriorityData,
    patchInteriorityData,
    saveSettings,
} from '../interiority/data.js';
import { validateAndApply, runStrictCalls } from '../interiority/generation.js';

beforeEach(() => {
    resetCoreStubs();
    // node env: interiority paths dispatch UI events and the swipe path
    // re-renders thought blocks — stub the DOM surface they touch.
    globalThis.document = {
        dispatchEvent: vi.fn(),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
});

const CHAT = [
    { name: 'User', is_user: true, mes: 'What will you do at the festival?', extra: {} },
    { name: 'Mara', mes: 'Mara glances toward the square.', extra: {} },
];

function addDormantEntry() {
    return addLedgerEntry({
        npc: 'Mara', action: 'visit the market', trigger: 'harvest festival',
        status: 'dormant', wakeHint: 'harvest festival',
    }, 'day 1', 0);
}

describe('restoreTurnCounter', () => {
    test('restores the counter to the captured value', () => {
        incrementTurnCounter();
        incrementTurnCounter();
        incrementTurnCounter();
        expect(getTurnCounter()).toBe(3);
        restoreTurnCounter(1);
        expect(getTurnCounter()).toBe(1);
    });

    test('invalid values are a no-op', () => {
        incrementTurnCounter();
        for (const bad of [undefined, null, NaN, -1, Infinity, '2']) {
            restoreTurnCounter(bad);
            expect(getTurnCounter()).toBe(1);
        }
    });
});

describe('validateAndApply records the pre-turn counter', () => {
    test('turnCounterAtSnapshot is the counter value BEFORE the caller increments', async () => {
        setFakeChat(CHAT);
        for (let i = 0; i < 4; i++) incrementTurnCounter();

        await validateAndApply({ npcs: [] }, ['Mara'], 1);

        const key = getOrCreateMsgKeyForIndex(1);
        const record = getInteriorityData().perMessage[key];
        expect(record).toBeTruthy();
        // The caller (generateForCurrentMessage) increments only after
        // validateAndApply returns, so the record must hold the pre-turn value.
        expect(record.turnCounterAtSnapshot).toBe(4);
    });
});

describe('dormant wake proposal commitment', () => {
    test('does not wake a proposal when the successful result came from thoughts only', async () => {
        setFakeChat(CHAT);
        const entry = addDormantEntry();

        await validateAndApply({ npcs: [{ name: 'Mara', thought: { type: 'rumination', text: 'The festival draws near.' } }] }, ['Mara'], 1, undefined, undefined, []);

        expect(getLedger().find(item => item.id === entry.id).status).toBe('dormant');
    });

    test('wakes only IDs confirmed after an intentions evaluation', async () => {
        setFakeChat(CHAT);
        const entry = addDormantEntry();

        await validateAndApply({ npcs: [] }, ['Mara'], 1, undefined, undefined, [entry.id]);

        expect(getLedger().find(item => item.id === entry.id).status).toBe('active');
    });

    test('includes a proposed dormant-only NPC in the roster', async () => {
        setFakeChat([{ name: 'User', is_user: true, mes: 'A quiet evening.', extra: {} }]);
        const entry = addDormantEntry();

        const { buildSceneRoster } = await import('../interiority/generation.js');
        expect(await buildSceneRoster([entry.id])).toContain('Mara');
    });
});

describe('a same-turn wake rolls back with the swipe', () => {
    test('a virtually active poll proposal can be executed in the current validation pass', async () => {
        setFakeChat(CHAT);
        const entry = addDormantEntry();

        await validateAndApply({
            npcs: [{ name: 'Mara', executed: [entry.id] }],
        }, ['Mara'], 1, undefined, undefined, [entry.id]);

        // The proposal was committed before the active-ledger ID lookup, so an
        // action already completed in this message is not injected next turn.
        expect(getLedger()).toHaveLength(0);
    });

    test('validateAndApply prefers the pre-poll snapshot passed by the caller', async () => {
        setFakeChat(CHAT);
        const entry = addDormantEntry();

        // The orchestrator captures this BEFORE the dormant poll runs…
        const prePoll = JSON.parse(JSON.stringify(getLedger()));
        // …then the poll wakes the entry on the live ledger.
        wakeLedgerEntry(entry.id, 2);
        expect(getLedger()[0].status).toBe('active');

        await validateAndApply({ npcs: [] }, ['Mara'], 1, undefined, prePoll);

        const key = getOrCreateMsgKeyForIndex(1);
        const record = getInteriorityData().perMessage[key];
        expect(record.ledgerSnapshot[0].status).toBe('dormant');

        // The swipe rollback puts the entry back to sleep — wake stamp
        // (status AND the turnsOpen grace floor) rolled back together.
        restoreLedgerSnapshot(record.ledgerSnapshot);
        expect(getLedger()[0].status).toBe('dormant');
        expect(getLedger()[0].turnsOpen).toBe(0);
    });

    test('without the parameter it still captures its own snapshot (legacy callers)', async () => {
        setFakeChat(CHAT);
        const entry = addDormantEntry();
        wakeLedgerEntry(entry.id, 2);

        await validateAndApply({ npcs: [] }, ['Mara'], 1);

        const key = getOrCreateMsgKeyForIndex(1);
        const record = getInteriorityData().perMessage[key];
        // Captured at call time — after the wake — matching old behaviour.
        expect(record.ledgerSnapshot[0].status).toBe('active');
    });
});

describe('strict intentions evaluation', () => {
    test('does not mark an NPC evaluated when its strict response has no NPC entry', async () => {
        setFakeChat(CHAT);
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test', generateThoughts: false, generateIntentions: true });
        const { setFakeApi } = await import('./stubs/core.js');
        setFakeApi(async () => JSON.stringify({ npcs: [] }));

        const result = await runStrictCalls(['Mara']);

        expect(result.intentionsEvaluatedRoster).toEqual([]);
    });
});

// ─── Lifecycle plan Tier 1 — owner-checked executed/dropped ids ──────────────

describe('executed/dropped ids are owner-checked (lifecycle Tier 1 item 2)', () => {
    // THE BUG: executed/dropped ids were validated against the SHARED ledger
    // id set, so in a multi-NPC response one NPC's block could close another
    // NPC's entry — Derek "completing" Mara's plan silently removed her
    // demand from the injection while her own block said nothing about it.
    // Candidates are now restricted per resolved block to entries the SAME
    // roster rules attribute to that NPC.

    const TWO_NPC_CHAT = [
        { name: 'User', is_user: true, mes: 'What happens at the depot tonight?', extra: {} },
        { name: 'Narrator', mes: 'Mara locks the depot while Derek watches the road.', extra: {} },
    ];

    test("one NPC's block cannot execute another NPC's entry", async () => {
        setFakeChat(TWO_NPC_CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const mara = addLedgerEntry({ npc: 'Mara', action: 'burn the ledgers', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({ npcs: [{ name: 'Derek', executed: [mara.id] }] }, ['Mara', 'Derek'], 1);

        expect(getLedger().some(e => e.id === mara.id)).toBe(true);
    });

    test("one NPC's block cannot drop another NPC's entry", async () => {
        setFakeChat(TWO_NPC_CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const mara = addLedgerEntry({ npc: 'Mara', action: 'burn the ledgers', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{ name: 'Derek', dropped: [{ id: mara.id, reason: 'no longer needed' }] }],
        }, ['Mara', 'Derek'], 1);

        expect(getLedger().some(e => e.id === mara.id)).toBe(true);
    });

    test('the owner block can still execute and drop its own entries', async () => {
        setFakeChat(TWO_NPC_CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        addLedgerEntry({ npc: 'Mara', action: 'burn the ledgers', trigger: 'nightfall' }, 'day 1', 0);
        addLedgerEntry({ npc: 'Mara', action: 'copy the shipping manifest', trigger: 'the watch change' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [getLedger()[0].id],
                dropped: [{ id: getLedger()[1].id, reason: 'changed her mind' }],
            }],
        }, ['Mara', 'Derek'], 1);

        expect(getLedger()).toHaveLength(0);
    });

    test('an entry whose owner is not on this roster is closable by no block', async () => {
        setFakeChat(TWO_NPC_CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const ghost = addLedgerEntry({ npc: 'Rowan', action: 'slip away', trigger: 'the bell' }, 'day 1', 0);

        await validateAndApply({
            npcs: [
                { name: 'Mara', executed: [ghost.id] },
                { name: 'Derek', executed: [ghost.id] },
            ],
        }, ['Mara', 'Derek'], 1);

        expect(getLedger().some(e => e.id === ghost.id)).toBe(true);
    });

    test('a ledger owner spelled with a fuller form still resolves to the roster member', async () => {
        // Legacy entries can pre-date roster canonicalization and carry a
        // fuller spelling than the roster member. Ownership resolution uses
        // the same unambiguous-alias rules as response names, so the entry
        // must remain closable by its owner's block.
        setFakeChat(TWO_NPC_CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const entry = addLedgerEntry({ npc: 'Mara Vance', action: 'scout the pass', trigger: 'first light' }, 'day 1', 0);

        await validateAndApply({ npcs: [{ name: 'Mara', executed: [entry.id] }] }, ['Mara Vance', 'Derek'], 1);

        expect(getLedger()).toHaveLength(0);
    });
});

// ─── Lifecycle plan Tier 1 — per-NPC accepted-proposal cap ───────────────────

describe('per-NPC accepted-proposal cap (lifecycle Tier 1 item 3)', () => {
    // Default cap: TWO accepted new intentions per NPC per call, enforced
    // AFTER field validation and dedup (malformed/duplicate proposals never
    // consume a slot) and limiting CREATION only — executed/dropped handling
    // runs before new-intention acceptance for the same block.

    test('accepts at most two valid new intentions per NPC per call', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                new_intentions: [
                    { action: 'stash the coin', trigger: 'sundown', horizon: 'immediate' },
                    { action: 'copy the key', trigger: 'the watch change', horizon: 'immediate' },
                    { action: 'scope the vault', trigger: 'midnight', horizon: 'immediate' },
                ],
            }],
        }, ['Mara'], 1);

        expect(getLedger().map(e => e.action)).toEqual(['stash the coin', 'copy the key']);
    });

    test('malformed and duplicate proposals do not consume the cap', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        addLedgerEntry({ npc: 'Mara', action: 'stash the coin', trigger: 'sundown' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                new_intentions: [
                    { trigger: 'no action supplied' },                        // missing action → rejected
                    { action: 'stash the coin', trigger: 'sundown' },         // duplicate of live entry → rejected
                    { action: 'copy the key', trigger: 'the watch change' },  // accepted (slot 1)
                    { action: 'scope the vault', trigger: 'midnight' },       // accepted (slot 2)
                    { action: 'forge the signature', trigger: 'next market day' }, // cap → rejected
                ],
            }],
        }, ['Mara'], 1);

        expect(getLedger().map(e => e.action))
            .toEqual(['stash the coin', 'copy the key', 'scope the vault']);
    });

    test('a same-batch exact duplicate is suppressed after its first acceptance', async () => {
        // The first acceptance lands on the live ledger immediately, so the
        // second copy trips the dedup — one entry, not two.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                new_intentions: [
                    { action: 'stash the coin', trigger: 'sundown' },
                    { action: 'stash the coin', trigger: 'sundown' },
                ],
            }],
        }, ['Mara'], 1);

        expect(getLedger()).toHaveLength(1);
    });

    test('the cap is per NPC, not per response', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });

        await validateAndApply({
            npcs: [
                { name: 'Mara', new_intentions: [
                    { action: 'm1', trigger: 't1' }, { action: 'm2', trigger: 't2' }, { action: 'm3', trigger: 't3' },
                ] },
                { name: 'Derek', new_intentions: [
                    { action: 'd1', trigger: 't1' }, { action: 'd2', trigger: 't2' },
                ] },
            ],
        }, ['Mara', 'Derek'], 1);

        const byNpc = { Mara: 0, Derek: 0 };
        for (const e of getLedger()) byNpc[e.npc] += 1;
        expect(byNpc).toEqual({ Mara: 2, Derek: 2 });
    });

    test('completion and drop evaluation still run after the cap is reached', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const done = addLedgerEntry({ npc: 'Mara', action: 'old errand', trigger: 'the bell' }, 'day 1', 0);

        const result = await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [done.id],
                new_intentions: [
                    { action: 'a1', trigger: 't1' },
                    { action: 'a2', trigger: 't2' },
                    { action: 'a3', trigger: 't3' },
                ],
            }],
        }, ['Mara'], 1);

        expect(result.ledgerChanged).toBe(true);
        // Executed despite the additions hitting the cap.
        expect(getLedger().some(e => e.id === done.id)).toBe(false);
        // …and the additions were still capped.
        expect(getLedger().filter(e => e.npc === 'Mara')).toHaveLength(2);
    });

    test('a cap of zero accepts nothing but still evaluates existing entries', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0, maxNewIntentionsPerNpc: 0 });
        const done = addLedgerEntry({ npc: 'Mara', action: 'old errand', trigger: 'the bell' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{ name: 'Mara', executed: [done.id], new_intentions: [{ action: 'a1', trigger: 't1' }] }],
        }, ['Mara'], 1);

        expect(getLedger().some(e => e.id === done.id)).toBe(false);
        expect(getLedger()).toHaveLength(0);
    });
});

// ─── Lifecycle plan Tier 2 — same-response replay guard ──────────────────────

describe('same-response replay guard (lifecycle Tier 2)', () => {
    // The executed/dropped handlers run BEFORE new_intentions inside one
    // validateAndApply pass and remove entries from the LIVE ledger without a
    // tombstone (a later, independently motivated re-declaration must stay
    // possible). Until Tier 2 the live-only dedup could not see an entry
    // removed moments earlier in the same response, so a model that executed
    // an intention and re-proposed it verbatim landed it straight back as
    // brand-new. The guard dedups new proposals against the pre-mutation
    // ledgerSnapshot (captured before the wake, the age increment, and every
    // removal) in addition to the live ledger.

    test('execute then exact recreate in one response is rejected', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const done = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [done.id],
                new_intentions: [{ action: 'finish the installation', trigger: 'nightfall' }],
            }],
        }, ['Mara'], 1);

        // Executed, and the verbatim recreate was blocked by the pre-removal
        // snapshot — not re-added under a fresh id.
        expect(getLedger()).toHaveLength(0);
    });

    test('drop then exact recreate in one response is rejected', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const gone = addLedgerEntry({ npc: 'Mara', action: 'burn the ledgers', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                dropped: [{ id: gone.id, reason: 'the depot burned down' }],
                new_intentions: [{ action: 'burn the ledgers', trigger: 'nightfall' }],
            }],
        }, ['Mara'], 1);

        expect(getLedger()).toHaveLength(0);
    });

    test('the guard also consults a caller-supplied preTurnLedgerSnapshot', async () => {
        // The production path: generateForCurrentMessage captures the snapshot
        // BEFORE the dormant poll and passes it in, so the guard must use that
        // array — not a fresh copy taken inside validateAndApply.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const done = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);
        const preTurn = JSON.parse(JSON.stringify(getLedger()));

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [done.id],
                new_intentions: [{ action: 'finish the installation', trigger: 'nightfall' }],
            }],
        }, ['Mara'], 1, undefined, preTurn);

        expect(getLedger()).toHaveLength(0);
    });

    test('a genuinely different new intention still lands after an execution', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const done = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [done.id],
                new_intentions: [{ action: 'stash the blueprints', trigger: 'sundown' }],
            }],
        }, ['Mara'], 1);

        expect(getLedger().map(e => e.action)).toEqual(['stash the blueprints']);
    });

    test('a reworded recreate is not blocked — the guard is exact-match only', async () => {
        // Pinned deliberately: the snapshot guard is deterministic string
        // matching, not semantic paraphrase detection (plan non-goal — the
        // new-intentions prompt contract and the Tier 1 capture carry the
        // paraphrase burden). This asserts the guard does not overreach.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const done = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [done.id],
                new_intentions: [{ action: 'complete the installation', trigger: 'nightfall' }],
            }],
        }, ['Mara'], 1);

        expect(getLedger().map(e => e.action)).toEqual(['complete the installation']);
    });

    test('a same-text proposal for a DIFFERENT NPC is not this guard\'s concern', async () => {
        // Dedup keys on the NPC: Derek executing Derek's plan says nothing
        // about Mara proposing the same action wording for herself — the live
        // check has always allowed that, and the snapshot check must not
        // tighten it into a cross-NPC suppression.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const done = addLedgerEntry({ npc: 'Derek', action: 'watch the road', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({
            npcs: [
                { name: 'Derek', executed: [done.id] },
                { name: 'Mara', new_intentions: [{ action: 'watch the road', trigger: 'nightfall' }] },
            ],
        }, ['Mara', 'Derek'], 1);

        expect(getLedger().map(e => e.npc)).toEqual(['Mara']);
    });

    test('a replay rejection does not consume a Tier 1 cap slot', async () => {
        // Tier 1 item 3: the cap is enforced after validation AND dedup, so a
        // replayed proposal must not eat a slot a genuine candidate could use.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const done = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [done.id],
                new_intentions: [
                    { action: 'finish the installation', trigger: 'nightfall' }, // replay — no slot
                    { action: 'stash the coin', trigger: 'sundown' },            // slot 1
                    { action: 'copy the key', trigger: 'the watch change' },     // slot 2
                ],
            }],
        }, ['Mara'], 1);

        expect(getLedger().map(e => e.action)).toEqual(['stash the coin', 'copy the key']);
    });

    test('an entry protected by the grace period is not removed, so its duplicate is the ordinary live one', async () => {
        // If the executed mark is rejected (age < grace), the entry is still
        // live when new_intentions run — the LIVE dedup rejects the proposal
        // and the snapshot check never gets to see a removal at all. The
        // entry is declared at the SAME message index being evaluated (an
        // earlier validation pass of this message — a regeneration), the
        // case lifecycle Tier 3's declaration gate still protects; declared
        // one message earlier, Tier 3 would (correctly) let the completion
        // through and this test would exercise the snapshot path instead.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 2 });
        const entry = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 1);

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [entry.id],
                new_intentions: [{ action: 'finish the installation', trigger: 'nightfall' }],
            }],
        }, ['Mara'], 1);

        // Survived the grace-period rejection AND no duplicate was added.
        expect(getLedger().map(e => e.id)).toEqual([entry.id]);
    });

    test('a replayed alias-owned entry is not recreated by its canonical owner', async () => {
        // The executed/dropped owner check resolves entries through the
        // roster (alias-aware), so a block named "Mara Vance" may close an
        // entry stored under its alias "The Vixen". The replay guard must
        // resolve the snapshot's ownership the SAME way — an exact-string
        // npc compare would let the verbatim re-proposal of that executed
        // alias entry slip through and be re-created.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const entry = addLedgerEntry({ npc: 'The Vixen', action: 'rob the vault', trigger: 'the eclipse' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{
                name: 'Mara Vance',
                executed: [entry.id],
                new_intentions: [{ action: 'rob the vault', trigger: 'the eclipse' }],
            }],
        }, ['Mara Vance'], 1, null, null, [], { 'mara vance': ['The Vixen'] });

        // Executed (alias ownership resolved) AND the replay blocked —
        // nothing left in the ledger.
        expect(getLedger()).toHaveLength(0);
    });
});

// ─── Lifecycle plan Tier 3 — completion vs. abandonment grace ────────────────

describe('completion is separated from abandonment grace (lifecycle Tier 3)', () => {
    // THE BUG: the grace period rejected `executed` marks exactly like
    // `dropped` marks, so a genuinely completed entry survived as an active
    // demand and the injection kept requiring an action the story had
    // already performed. Tier 3: an executed mark may close an in-grace
    // entry ONLY when the entry is engine-created and was declared before
    // the evaluated story message (`declaredMsgIdx !== null &&
    // declaredMsgIdx < msgIdx`). Dropped marks keep blanket grace, and age
    // (`turnsOpen`) is never the test — regeneration pumps it without a new
    // story message elapsing.

    test('an executed mark closes a pre-existing engine entry declared before the evaluated message', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 2 });
        // Declared at message 0; message 1 is being evaluated — one message
        // of story elapsed with the plan live. Age after this pass's
        // increment is 1 < grace 2, so only the declaration gate admits it.
        const done = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({ npcs: [{ name: 'Mara', executed: [done.id] }] }, ['Mara'], 1);

        expect(getLedger()).toHaveLength(0);
    });

    test('an entry declared in the CURRENT validation pass is not closable during grace', async () => {
        // Guessed-id guard: the entry is declared at the SAME message index
        // being evaluated (created this pass, or by an earlier validation
        // pass of this message — what a regeneration re-evaluates), so no
        // story message elapsed since declaration and the gate keeps it
        // protected for as long as the grace window lasts — and beyond it:
        // the same-message guard is age-independent, so grace 0 protects
        // too (pinned by the grace-0 test below).
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 2 });
        const fresh = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 1);

        await validateAndApply({ npcs: [{ name: 'Mara', executed: [fresh.id] }] }, ['Mara'], 1);

        expect(getLedger().some(e => e.id === fresh.id)).toBe(true);
    });

    test('regeneration cannot manufacture gate eligibility by pumping age', async () => {
        // An entry declared by message 1's first validation pass is
        // re-evaluated by regenerations of message 1: the age counter rises
        // with every call, but no new story message elapsed, so the executed
        // mark must stay rejected at every pass — including the passes where
        // the pumped counter has reached the grace threshold and the in-grace
        // gate alone would no longer run.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 5 });
        const entry = addLedgerEntry({ npc: 'Mara', action: 'stash the coin', trigger: 'sundown' }, 'day 1', 1);

        // Five regeneration passes of the SAME message: ages 1–5. Passes
        // 1–4 sit inside grace (rejected by the declaration gate); pass 5 is
        // AT the threshold (age 5 >= grace 5) and is rejected by the
        // age-independent same-message guard instead.
        for (let i = 0; i < 5; i++) {
            await validateAndApply({ npcs: [{ name: 'Mara', executed: [entry.id] }] }, ['Mara'], 1);
        }

        expect(getLedger().some(e => e.id === entry.id)).toBe(true);
        expect(getLedger()[0].turnsOpen).toBe(5);
    });

    test('a same-message entry stays protected even at grace 0, past the age threshold', async () => {
        // Grace 0 empties the grace window on the very first pass — if the
        // same-message guard depended on age, the first re-evaluation of the
        // declaring message would close an entry no story message has ever
        // elapsed on.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const entry = addLedgerEntry({ npc: 'Mara', action: 'stash the coin', trigger: 'sundown' }, 'day 1', 1);

        for (let i = 0; i < 2; i++) {
            await validateAndApply({ npcs: [{ name: 'Mara', executed: [entry.id] }] }, ['Mara'], 1);
        }

        expect(getLedger().some(e => e.id === entry.id)).toBe(true);
    });

    test('a dropped mark keeps full grace even when the declaration gate would pass', async () => {
        // Same entry shape as the first test, but a drop: elapsed story
        // time cannot prove the NPC's resolve lapsed, so blanket grace
        // stays the drop policy.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 2 });
        const entry = addLedgerEntry({ npc: 'Mara', action: 'burn the ledgers', trigger: 'nightfall' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{ name: 'Mara', dropped: [{ id: entry.id, reason: 'changed her mind' }] }],
        }, ['Mara'], 1);

        expect(getLedger().some(e => e.id === entry.id)).toBe(true);
    });

    test('out-of-grace by age: executed and dropped marks behave as before', async () => {
        // Tier 3 is narrow — age-based expiry of the grace window is
        // untouched for both marks. Entries declared one message earlier
        // are incremented to age 1 by this pass; with grace 1 they are out
        // of grace regardless of the declaration gate. (Declared-before
        // matters now: a same-message entry stays protected by the
        // age-independent guard at ANY age — re-evaluating one message can
        // no longer pump turnsOpen into manufactured expiry.)
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 1 });
        const done = addLedgerEntry({ npc: 'Mara', action: 'scout the pass', trigger: 'first light' }, 'day 1', 0);
        const gone = addLedgerEntry({ npc: 'Mara', action: 'copy the manifest', trigger: 'the watch change' }, 'day 1', 0);

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [done.id],
                dropped: [{ id: gone.id, reason: 'no longer needed' }],
            }],
        }, ['Mara'], 1);

        expect(getLedger()).toHaveLength(0);
    });

    test('a manual entry is not engine-executable through the grace exception', async () => {
        // Panel-authored entries carry declaredMsgIdx: null — the Tier 3
        // exception cannot apply, so the grace period protects them like
        // before.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 2 });
        const plan = addManualLedgerEntry({ npc: 'Mara', action: 'bribe the harbor master', trigger: 'next shipment' });

        await validateAndApply({ npcs: [{ name: 'Mara', executed: [plan.id] }] }, ['Mara'], 5);

        expect(getLedger().some(e => e.id === plan.id)).toBe(true);
    });

    test('a manual entry is still closable once genuinely out of grace by age', async () => {
        // The policy bars manual entries from the grace EXCEPTION only —
        // age-based expiry still applies, so the engine can complete a
        // user-authored plan the story has demonstrably moved past.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 1 });
        const plan = addManualLedgerEntry({ npc: 'Mara', action: 'bribe the harbor master', trigger: 'next shipment' });

        await validateAndApply({ npcs: [{ name: 'Mara', executed: [plan.id] }] }, ['Mara'], 5);

        expect(getLedger()).toHaveLength(0);
    });

    test('a woken scheduled entry may complete on its evaluated wake turn through the gate itself', async () => {
        // Pin the POLICY, not the age-stamp accident: wake with a floor of
        // 0 so the entry is still in grace by age, leaving the declaration
        // gate as the only thing that can admit the executed mark. The
        // entry retains its original declaration index (message 0), which
        // predates the evaluated message 1 — the wake certified the
        // occasion arrived.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 2 });
        const entry = addLedgerEntry({
            npc: 'Mara', action: 'visit the market', trigger: 'harvest festival',
            status: 'dormant', wakeHint: 'harvest festival',
        }, 'day 1', 0);
        wakeLedgerEntry(entry.id, 0);

        await validateAndApply({ npcs: [{ name: 'Mara', executed: [entry.id] }] }, ['Mara'], 1);

        expect(getLedger()).toHaveLength(0);
    });

    test('a woken scheduled entry in grace is NOT droppable on its wake turn', async () => {
        // The wake turn's exception is completion-only. (Production stamps
        // turnsOpen = max(turnsOpen, gracePeriod) on wake, which usually
        // puts woken entries out of grace entirely; waking with a floor of
        // 0 isolates the Tier 3 policy from that stamp.)
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 2 });
        const entry = addLedgerEntry({
            npc: 'Mara', action: 'visit the market', trigger: 'harvest festival',
            status: 'dormant', wakeHint: 'harvest festival',
        }, 'day 1', 0);
        wakeLedgerEntry(entry.id, 0);

        await validateAndApply({
            npcs: [{ name: 'Mara', dropped: [{ id: entry.id, reason: 'lost interest' }] }],
        }, ['Mara'], 1);

        expect(getLedger().some(e => e.id === entry.id)).toBe(true);
    });

    test('a user-edited engine entry keeps its declaration evidence', async () => {
        // updateLedgerEntry marks the entry manual: true but cannot change
        // when the plan was declared; correcting the wording must not lock
        // a genuinely completed plan inside the grace window.
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 2 });
        const entry = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);
        updateLedgerEntry(entry.id, { action: 'finish the wiring' });

        await validateAndApply({ npcs: [{ name: 'Mara', executed: [entry.id] }] }, ['Mara'], 1);

        expect(getLedger()).toHaveLength(0);
    });

    test('strict path: a strict-mode result closes a declared-before entry inside grace', async () => {
        // validateAndApply is the single shared validator (unified, split,
        // and strict results all funnel through it); this drives the real
        // strict-mode seam end to end to prove the gate applies there too.
        const { setFakeApi } = await import('./stubs/core.js');
        setFakeChat(CHAT);
        saveSettings({
            apiUrl: 'https://example.test', modelName: 'test',
            generateThoughts: false, generateIntentions: true,
            intentionGracePeriod: 2,
        });
        const done = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);
        setFakeApi(async () => JSON.stringify({ npcs: [{ name: 'Mara', executed: [done.id] }] }));

        const merged = await runStrictCalls(['Mara']);
        await validateAndApply(merged, ['Mara'], 1);

        expect(getLedger()).toHaveLength(0);
    });
});

describe('onMessageSwiped — the full rollback', () => {
    test('a swipe restores both the dormant status and the turn counter', async () => {
        setFakeChat(CHAT);
        // Keep the swipe handler from queueing a live regeneration.
        saveSettings({ autoMode: false });

        const entry = addDormantEntry();
        const prePoll = JSON.parse(JSON.stringify(getLedger()));

        // Simulate the turn exactly as generateForCurrentMessage runs it:
        // poll wakes the entry, the record stores the PRE-poll snapshot and
        // pre-turn counter, then the counter increments.
        wakeLedgerEntry(entry.id, 2);
        const key = getOrCreateMsgKeyForIndex(1);
        setPerMessage(key, {
            reactions: [],
            ledgerSnapshot: prePoll,
            turnCounterAtSnapshot: getTurnCounter(),
            generatedAt: Date.now(),
        });
        incrementTurnCounter();
        expect(getTurnCounter()).toBe(1);
        expect(getLedger()[0].status).toBe('active');

        const { onMessageSwiped } = await import('../interiority/index.js');
        onMessageSwiped(1);

        // The turn is un-consumed and the wake is undone — the regenerated
        // turn will re-increment and (if due) re-run the poll against the
        // NEW message content.
        expect(getTurnCounter()).toBe(0);
        expect(getLedger()).toHaveLength(1);
        expect(getLedger()[0].status).toBe('dormant');
    });

    test('a record from before the field existed leaves the counter alone', async () => {
        setFakeChat(CHAT);
        saveSettings({ autoMode: false });

        addDormantEntry();
        const snapshot = JSON.parse(JSON.stringify(getLedger()));
        const key = getOrCreateMsgKeyForIndex(1);
        // Legacy record: no turnCounterAtSnapshot.
        setPerMessage(key, {
            reactions: [],
            ledgerSnapshot: snapshot,
            generatedAt: Date.now(),
        });
        incrementTurnCounter();

        const { onMessageSwiped } = await import('../interiority/index.js');
        onMessageSwiped(1);

        expect(getTurnCounter()).toBe(1);
    });

    test('swiping a message that is not the newest generation restores nothing', async () => {
        setFakeChat(CHAT);
        saveSettings({ autoMode: false });

        const entry = addDormantEntry();
        wakeLedgerEntry(entry.id, 2);

        // Older record on message 0, newer on message 1 (newest by generatedAt).
        const oldKey = getOrCreateMsgKeyForIndex(0);
        const newKey = getOrCreateMsgKeyForIndex(1);
        setPerMessage(oldKey, {
            reactions: [],
            ledgerSnapshot: [],
            turnCounterAtSnapshot: 0,
            generatedAt: Date.now() - 1000,
        });
        setPerMessage(newKey, {
            reactions: [],
            ledgerSnapshot: JSON.parse(JSON.stringify(getLedger())),
            turnCounterAtSnapshot: 1,
            generatedAt: Date.now(),
        });
        incrementTurnCounter();
        incrementTurnCounter();

        const { onMessageSwiped } = await import('../interiority/index.js');
        onMessageSwiped(0);

        // Only the newest generation's snapshot may roll anything back.
        expect(getTurnCounter()).toBe(2);
        expect(getLedger()[0].status).toBe('active');
    });
});

describe('onMessageDeleted — bulk generated-turn rollback', () => {
    test('uses the oldest snapshot when the newest generated suffix is deleted together', async () => {
        setFakeChat([
            { name: 'Mara', mes: 'First surviving turn.', extra: {} },
            { name: 'Mara', mes: 'First deleted turn.', extra: {} },
            { name: 'Mara', mes: 'Second deleted turn.', extra: {} },
        ]);
        saveSettings({ autoMode: false });

        const base = addDormantEntry();
        const oldestSnapshot = JSON.parse(JSON.stringify(getLedger()));
        const firstKey = getOrCreateMsgKeyForIndex(1);
        wakeLedgerEntry(base.id, 0);
        incrementTurnCounter();
        setPerMessage(firstKey, {
            reactions: [], ledgerSnapshot: oldestSnapshot, turnCounterAtSnapshot: 0, generatedAt: 1,
        });

        const newestSnapshot = JSON.parse(JSON.stringify(getLedger()));
        const secondKey = getOrCreateMsgKeyForIndex(2);
        // Reads hand out a detached working copy now, so the new demand is
        // added through an explicit committed write instead of pushing into
        // the (formerly live) ledger array. The entry keeps the same shape it
        // always had here — schema-quarantined at this commit — so the
        // observable end state (nothing survives the final rollback) is
        // unchanged.
        patchInteriorityData({
            ledger: [...getLedger(), { id: 'i-new', npc: 'Mara', action: 'new demand', trigger: '', turnsOpen: 0 }],
        });
        incrementTurnCounter();
        setPerMessage(secondKey, {
            reactions: [], ledgerSnapshot: newestSnapshot, turnCounterAtSnapshot: 1, generatedAt: 2,
        });
        expect(getTurnCounter()).toBe(2);

        // One delete event arrives after both generated messages are gone.
        setFakeChat([{ name: 'Mara', mes: 'First surviving turn.', extra: {} }]);
        const { onMessageDeleted } = await import('../interiority/index.js');
        await onMessageDeleted(1);

        expect(getTurnCounter()).toBe(0);
        expect(getLedger()).toEqual(oldestSnapshot);
    });
});
