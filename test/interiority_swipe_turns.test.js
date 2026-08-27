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
    getLedger, addLedgerEntry, wakeLedgerEntry, restoreLedgerSnapshot,
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
