/**
 * test/interiority_trigger_telemetry.test.js — every generation names its cause.
 *
 * WHY THIS EXISTS: a user reported "the panic switch is on and Interiority is
 * STILL spending tokens", and the diagnostics panel could not answer it. The
 * api_call row recorded module/mode/model/duration but not WHAT started the
 * call — and Interiority has five entry points with three different gating
 * rules, two of which (the 💭 Generate button and /wt-thoughts) pass
 * `force: true` and bypass the panic gate by design. So "an interiority call
 * fired during a panic window" is not by itself a bug, and the trigger IS the
 * diagnosis. Diagnosing it took reading `at` minus `durationMs` against
 * neighbouring injection_applied timestamps to infer the entry point.
 *
 * The trigger is threaded from each entry point → generateForCurrentMessage →
 * the run* helpers → fetchAndParse → the fetch function → captureApiCall. This
 * file pins the entry-point end of that chain (the request each path emits);
 * test/api_diagnostics.test.js pins the telemetry end.
 *
 * Behaviour must be unchanged — the trigger is a label, never a decision.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { getEvents } from '../core/diagnostics.js';
import { resetCoreStubs, setFakeChat, setFakeApi, setFakeContextExtras } from './stubs/core.js';
import {
    saveSettings, setPerMessage, addLedgerEntry, getOrCreateMsgKeyForIndex, state,
} from '../interiority/data.js';
import { runDormantPoll } from '../interiority/generation.js';
import {
    onMessageReceived, onMessageSwiped, onMessageEdited, triggerGenerate, TRIGGER,
} from '../interiority/index.js';

let apiCalls;

beforeEach(() => {
    resetCoreStubs();
    apiCalls = [];
    // The fake receives the SAME request object a real module hands to
    // fetchFn — so `trigger` is observable exactly where core/api.js reads it.
    setFakeApi(async (req) => {
        apiCalls.push(req);
        return '{"npcs": []}';
    });
    globalThis.document = {
        dispatchEvent: vi.fn(),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
    saveSettings({ apiUrl: 'http://example.test/v1', modelName: 'test-model' });
});

/** Two-message chat; the last (AI) message sits on an EXISTING swipe slot, so
 *  invalidateAndMaybeRegenerate regenerates instead of deferring. */
function makeChat() {
    return [
        { name: 'User', is_user: true, mes: 'What will you do at the festival?', extra: {} },
        {
            name: 'Mara', is_user: false, mes: 'Mara glances toward the square.',
            extra: {},
            swipes: ['Mara glances toward the square.', 'Mara turns away.'],
            swipe_id: 1,
        },
    ];
}

/** An active ledger entry is a roster source that needs no world state,
 *  registry, or ctx.name2 — active NPCs are always rostered. */
function seedRoster() {
    addLedgerEntry({ npc: 'Mara', action: 'visit the market', trigger: 'harvest festival' }, 'day 1', 0);
}

async function flushWorkQueue() {
    await state.workQueue.catch(() => {});
    await new Promise(r => setTimeout(r, 20));
}

describe('generation trigger telemetry', () => {
    test.each([
        ['MESSAGE_RECEIVED', () => onMessageReceived(1), TRIGGER.MESSAGE_RECEIVED],
        ['MESSAGE_SWIPED', () => onMessageSwiped(1), TRIGGER.SWIPE],
        ['MESSAGE_EDITED', () => onMessageEdited(1), TRIGGER.EDIT],
        ['the 💭 Generate button', () => triggerGenerate(), TRIGGER.MANUAL],
        ['/wt-thoughts', () => triggerGenerate({ trigger: TRIGGER.SLASH_COMMAND }), TRIGGER.SLASH_COMMAND],
    ])('%s stamps its own trigger on the outgoing request', async (_label, fire, expected) => {
        setFakeChat(makeChat());
        seedRoster();
        setPerMessage(getOrCreateMsgKeyForIndex(1), { reactions: [{ npc: 'Mara', thought: 'old' }] });

        await fire();
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(1);
        expect(apiCalls[0].trigger).toBe(expected);
    });

    test('the trigger is a label, not a decision — swipe and edit still both generate', async () => {
        setFakeChat(makeChat());
        seedRoster();
        // invalidateAndMaybeRegenerate bails before the gate on a message with
        // no stamped UUID, so stamp one or the path never runs at all.
        getOrCreateMsgKeyForIndex(1);

        onMessageSwiped(1);
        await flushWorkQueue();
        onMessageEdited(1);
        await flushWorkQueue();

        expect(apiCalls.map(c => c.trigger)).toEqual([TRIGGER.SWIPE, TRIGGER.EDIT]);
    });
});

describe('blocked generations leave a breadcrumb', () => {
    test('a gated swipe records generation_blocked naming the trigger', async () => {
        // The panic window used to produce NO interiority evidence at all, so
        // "the gate held" and "the module never ran" looked identical in a
        // user's screenshot. Now the block is visible in the log.
        setFakeChat(makeChat());
        seedRoster();
        getOrCreateMsgKeyForIndex(1);
        setFakeContextExtras({ globalSettings: { injectionMasterOff: true } });

        onMessageSwiped(1);
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(0);
        const blocked = getEvents({ module: 'interiority' })
            .filter(e => e.event === 'generation_blocked');
        expect(blocked).toHaveLength(1);
        expect(blocked[0].detail).toMatchObject({
            trigger: TRIGGER.SWIPE,
            reason: 'injection-disabled',
        });
    });

    test('a forced generation during panic is NOT recorded as blocked', async () => {
        setFakeChat(makeChat());
        seedRoster();
        setFakeContextExtras({ globalSettings: { injectionMasterOff: true } });

        await triggerGenerate();
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(1);
        expect(apiCalls[0].trigger).toBe(TRIGGER.MANUAL);
        expect(getEvents({ module: 'interiority' }).filter(e => e.event === 'generation_blocked')).toHaveLength(0);
    });
});

describe('the dormant poll names its cause with a :dormant_poll suffix', () => {
    // The poll is a SECOND call inside the same turn, so it carries the turn's
    // trigger with a suffix rather than a cause of its own — otherwise a turn
    // that polls looks like two unrelated spends in the telemetry (§20). These
    // pin the suffix at the entry-point end of the chain, where the request
    // object is handed to fetchFn (test/api_diagnostics.test.js pins the
    // telemetry end).

    /** A dormant (scheduled) ledger entry — the poll's subject. It is NOT a
     *  roster source: dormant NPCs are not evaluated, only polled. */
    function seedDormantEntry() {
        return addLedgerEntry(
            {
                npc: 'Jonas',
                action: 'sabotage the festival bell',
                trigger: 'the night before the harvest festival',
                status: 'dormant',
                wakeHint: 'harvest festival',
            },
            'day 1',
            0,
        );
    }

    test('a poll-due turn fires the suffixed poll call BEFORE the main call', async () => {
        setFakeChat(makeChat());
        seedRoster();
        seedDormantEntry();
        setPerMessage(getOrCreateMsgKeyForIndex(1), { reactions: [{ npc: 'Mara', thought: 'old' }] });
        // Interval 1 + the look-ahead-by-one scheduler ⇒ due on turn one.
        saveSettings({ apiUrl: 'http://example.test/v1', modelName: 'test-model', dormantPollInterval: 1 });

        await onMessageReceived(1);
        await flushWorkQueue();

        expect(apiCalls.map(c => c.trigger)).toEqual([
            `${TRIGGER.MESSAGE_RECEIVED}:dormant_poll`,
            TRIGGER.MESSAGE_RECEIVED,
        ]);
    });

    test('a turn that is not poll-due makes only the unsuffixed main call', async () => {
        setFakeChat(makeChat());
        seedRoster();
        seedDormantEntry(); // dormant entries exist, but the counter is not due
        setPerMessage(getOrCreateMsgKeyForIndex(1), { reactions: [{ npc: 'Mara', thought: 'old' }] });
        // Default interval 10 with turn counter 0 → (0+1)%10 ≠ 0 → not due.
        saveSettings({ apiUrl: 'http://example.test/v1', modelName: 'test-model' });

        await onMessageReceived(1);
        await flushWorkQueue();

        expect(apiCalls.map(c => c.trigger)).toEqual([TRIGGER.MESSAGE_RECEIVED]);
    });

    test('runDormantPoll with no trigger emits trigger:null, not a bare suffix', async () => {
        setFakeChat(makeChat());
        seedDormantEntry();

        const proposed = await runDormantPoll({ trigger: null });

        expect(proposed).toEqual([]);
        expect(apiCalls).toHaveLength(1);
        expect(apiCalls[0].trigger).toBe(null);
        // It really is the poll call, not a stray main call.
        expect(apiCalls[0].userContent).toContain('<dormant_intentions>');
    });
});

describe('a native AbortError is a cancellation, not a parse failure', () => {
    // The coordinator's composed signal aborts fetch() mid-wire, which
    // rejects with an UNMARKED native AbortError (no `_mwtCancelled`). Every
    // catch site must recognize it via isCancellation(): the marker-only
    // check used to mistake it for an API/parse failure — fetchAndParse then
    // spent a second, fresh-epoch attempt on the old chat's prompt, and the
    // dormant-poll catch swallowed it and continued into the MAIN call.

    /** Exactly what fetch() rejects with when the signal fires mid-wire. */
    function nativeAbort() {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return err;
    }

    /** A dormant (scheduled) ledger entry — the poll's subject. */
    function seedDormantEntry() {
        return addLedgerEntry(
            {
                npc: 'Jonas',
                action: 'sabotage the festival bell',
                trigger: 'the night before the harvest festival',
                status: 'dormant',
                wakeHint: 'harvest festival',
            },
            'day 1',
            0,
        );
    }

    test('the main call makes exactly ONE wire attempt and quiet-discards', async () => {
        setFakeChat(makeChat());
        seedRoster();
        setPerMessage(getOrCreateMsgKeyForIndex(1), { reactions: [{ npc: 'Mara', thought: 'old' }] });
        setFakeApi(async () => {
            apiCalls.push(true);
            throw nativeAbort();
        });

        // Must not throw: the orchestrator's catch quiet-discards it.
        await onMessageReceived(1);
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(1);
    });

    test('a cancelled dormant poll stops the whole flow — no main generation follows', async () => {
        setFakeChat(makeChat());
        seedRoster();
        seedDormantEntry();
        setPerMessage(getOrCreateMsgKeyForIndex(1), { reactions: [{ npc: 'Mara', thought: 'old' }] });
        // Interval 1 + the look-ahead-by-one scheduler ⇒ due on turn one.
        saveSettings({ apiUrl: 'http://example.test/v1', modelName: 'test-model', dormantPollInterval: 1 });
        setFakeApi(async (req) => {
            apiCalls.push(req);
            if (String(req.userContent).includes('<dormant_intentions>')) throw nativeAbort();
            return '{"npcs": []}';
        });

        await onMessageReceived(1);
        await flushWorkQueue();

        // Exactly ONE wire attempt total: the poll. The dormant-poll catch
        // used to swallow the cancellation and continue into the MAIN call —
        // a fresh-epoch job carrying the old chat's prompt.
        expect(apiCalls).toHaveLength(1);
        expect(String(apiCalls[0].userContent)).toContain('<dormant_intentions>');
    });
});
