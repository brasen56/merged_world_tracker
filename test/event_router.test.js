/**
 * test/event_router.test.js — Regression tests for the message-event router.
 *
 * These verify the two contracts documented in core/event_router.js:
 *
 *   1. PANIC-COUNTER-SYMMETRY — while the panic switch (injectionMasterOff)
 *      is on, the counter decrement is suppressed by threading an
 *      `adjustCounters: false` flag into each module's onMessageDeleted. The
 *      call itself is NOT skipped, so bookkeeping (lastChatLength) and
 *      integrity work (provenance / anchor invalidation) stay live
 *
 *   2. INTERIORITY-04 — Interiority cleanup stays ungated by the panic switch
 *      on every mutation event.
 *
 * The router is a pure function taking stub module objects with spy methods, so
 * no SillyTavern harness is required (unlike the Tier-5 module integration
 * tests). This mirrors test/scope_guard_contract.js for core/commands.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { resetCoreStubs, setFakeChat, getFakeChat } from './stubs/core.js';
import {
    routeMessageReceived,
    routeMessageDeleted,
    routeMessageSwiped,
    routeMessageEdited,
    extractMessageIndex,
} from '../core/event_router.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

/**
 * Build stub module objects whose methods record every call. Returns the stubs
 * plus `calls` (raw call log keyed by method id) and `called(id)` (call count).
 */
function makeStubModules() {
    const calls = {};
    const spy = (id) => (...args) => { (calls[id] ||= []).push(args); };
    return {
        modules: {
            WorldState: {
                onMessageReceived: spy('ws.recv'),
                onMessageDeleted: spy('ws.del'),
                onMessageSwiped: spy('ws.swipe'),
                onMessageEdited: spy('ws.edit'),
            },
            Chronicle: {
                onMessageReceived: spy('ch.recv'),
                onMessageDeleted: spy('ch.del'),
                onMessageSwiped: spy('ch.swipe'),
                onMessageEdited: spy('ch.edit'),
            },
            Knowledge: {
                onMessageReceived: spy('kn.recv'),
                onMessageDeleted: spy('kn.del'),
            },
            StoryPlanner: {
                onMessageReceived: spy('sp.recv'),
                onMessageDeleted: spy('sp.del'),
            },
            Interiority: {
                onMessageReceived: spy('in.recv'),
                onMessageDeleted: spy('in.del'),
                onMessageSwiped: spy('in.swipe'),
                onMessageEdited: spy('in.edit'),
            },
        },
        calls,
        called: (id) => (calls[id]?.length || 0),
    };
}

// ─── PANIC-COUNTER-SYMMETRY: MESSAGE_RECEIVED ────────────────────────────────

describe('PANIC-COUNTER-SYMMETRY — MESSAGE_RECEIVED gating', () => {
    test('panic ON: counter modules are still CALLED with countMessage:false; Interiority is skipped', () => {
        // Mirror of the MESSAGE_DELETED contract: the panic switch is threaded
        // as a flag ({ countMessage: false }), not by skipping the call, so
        // each counter module still runs and can do lastChatLength bookkeeping.
        // Only Interiority — which only generates, with no bookkeeping to
        // preserve — is genuinely skipped during a panic window.
        const { modules, called, calls } = makeStubModules();
        routeMessageReceived(modules, { injectionMasterOff: true }, 5);
        expect(called('ws.recv')).toBe(1);
        expect(called('ch.recv')).toBe(1);
        expect(called('kn.recv')).toBe(1);
        expect(called('sp.recv')).toBe(1);
        expect(called('in.recv')).toBe(0); // generation gated too
        expect(calls['ws.recv'][0]).toEqual([{ countMessage: false }]);
        expect(calls['ch.recv'][0]).toEqual([{ countMessage: false }]);
        expect(calls['kn.recv'][0]).toEqual([{ countMessage: false }]);
        expect(calls['sp.recv'][0]).toEqual([{ countMessage: false }]);
    });

    test('panic OFF: every enabled module receives the event', () => {
        const { modules, called } = makeStubModules();
        routeMessageReceived(modules, {}, 5); // injectionMasterOff is falsey
        expect(called('ws.recv')).toBe(1);
        expect(called('ch.recv')).toBe(1);
        expect(called('kn.recv')).toBe(1);
        expect(called('sp.recv')).toBe(1);
        expect(called('in.recv')).toBe(1);
    });

    test('panic OFF: counter modules receive countMessage: true', () => {
        const { modules, calls } = makeStubModules();
        routeMessageReceived(modules, {}, 5); // injectionMasterOff is falsey
        expect(calls['ws.recv'][0]).toEqual([{ countMessage: true }]);
        expect(calls['ch.recv'][0]).toEqual([{ countMessage: true }]);
        expect(calls['kn.recv'][0]).toEqual([{ countMessage: true }]);
        expect(calls['sp.recv'][0]).toEqual([{ countMessage: true }]);
    });

    test('Interiority onMessageReceived receives the message index; the others do not', () => {
        const { modules, calls } = makeStubModules();
        routeMessageReceived(modules, {}, 42);
        expect(calls['in.recv'][0]).toEqual([42]);
        expect(calls['ws.recv'][0]).toEqual([{ countMessage: true }]);
        expect(calls['sp.recv'][0]).toEqual([{ countMessage: true }]);
    });
});

// ─── PANIC-COUNTER-SYMMETRY: MESSAGE_DELETED (threaded flag, not skip) ───────

describe('PANIC-COUNTER-SYMMETRY — MESSAGE_DELETED threads adjustCounters', () => {
    test('panic ON: every module is still CALLED — no module is skipped', () => {
        // The audit's core point: skipping the call suppresses bookkeeping +
        // integrity. The fix threads the decision as a flag instead, so every
        // module still runs — only the counter decrement is gated.
        const { modules, called } = makeStubModules();
        routeMessageDeleted(modules, { injectionMasterOff: true }, 3);
        expect(called('ws.del')).toBe(1);
        expect(called('ch.del')).toBe(1);
        expect(called('kn.del')).toBe(1);
        expect(called('sp.del')).toBe(1);
        expect(called('in.del')).toBe(1);
    });

    test('panic ON: counter modules receive adjustCounters: false', () => {
        const { modules, calls } = makeStubModules();
        routeMessageDeleted(modules, { injectionMasterOff: true }, 3);
        expect(calls['ws.del'][0]).toEqual([3, { adjustCounters: false }]);
        expect(calls['ch.del'][0]).toEqual([3, { adjustCounters: false }]);
        expect(calls['kn.del'][0]).toEqual([3, { adjustCounters: false }]);
        expect(calls['sp.del'][0]).toEqual([3, { adjustCounters: false }]);
    });

    test('panic ON: Interiority receives NO flag (it has no counter to adjust)', () => {
        const { modules, calls } = makeStubModules();
        routeMessageDeleted(modules, { injectionMasterOff: true }, 3);
        expect(calls['in.del'][0]).toEqual([3]);
    });

    test('panic OFF: counter modules receive adjustCounters: true', () => {
        const { modules, calls } = makeStubModules();
        routeMessageDeleted(modules, {}, 3);
        expect(calls['ws.del'][0]).toEqual([3, { adjustCounters: true }]);
        expect(calls['ch.del'][0]).toEqual([3, { adjustCounters: true }]);
        expect(calls['sp.del'][0]).toEqual([3, { adjustCounters: true }]);
    });
});

// ─── Per-module enable flags ─────────────────────────────────────────────────

describe('per-module enable flags are respected', () => {
    test('enableWorldState:false skips only WorldState on receive', () => {
        const { modules, called } = makeStubModules();
        routeMessageReceived(modules, { enableWorldState: false }, 1);
        expect(called('ws.recv')).toBe(0);
        expect(called('ch.recv')).toBe(1);
        expect(called('kn.recv')).toBe(1);
    });

    test('enableChronicle:false skips only Chronicle on delete', () => {
        const { modules, called } = makeStubModules();
        routeMessageDeleted(modules, { enableChronicle: false }, 1);
        expect(called('ch.del')).toBe(0);
        expect(called('ws.del')).toBe(1);
        expect(called('in.del')).toBe(1);
    });

    test('enableInteriority:false skips Interiority even during cleanup', () => {
        const { modules, called } = makeStubModules();
        routeMessageDeleted(modules, { enableInteriority: false }, 1);
        expect(called('in.del')).toBe(0);
        expect(called('ws.del')).toBe(1); // counters still run when panic is off
    });
});

// ─── Swipe / edit: never gated by panic (cleanup only) ───────────────────────

describe('swipe/edit are never gated by the panic switch', () => {
    test('MESSAGE_SWIPED routes even with panic ON', () => {
        const { modules, called } = makeStubModules();
        routeMessageSwiped(modules, { injectionMasterOff: true }, 2);
        expect(called('ws.swipe')).toBe(1);
        expect(called('ch.swipe')).toBe(1);
        expect(called('in.swipe')).toBe(1);
    });

    test('MESSAGE_EDITED routes even with panic ON', () => {
        const { modules, called } = makeStubModules();
        routeMessageEdited(modules, { injectionMasterOff: true }, 2);
        expect(called('ws.edit')).toBe(1);
        expect(called('ch.edit')).toBe(1);
        expect(called('in.edit')).toBe(1);
    });
});

// ─── CONSEQUENCE — bookkeeping + integrity stay live through a panic window ──
// The router tests above prove the flag is THREADED. These prove the
// CONSEQUENCE the audit asked for ("one test pinning lastChatLength after a
// panic-window delete would catch the drift directly"): lastChatLength keeps
// tracking the live chat during a panic window, so the first post-panic delete
// does NOT compute a lumped `removed`. Uses the real Chronicle module (stubbed
// core), not spies.

describe('CONSEQUENCE — lastChatLength stays live during a panic window', () => {
    let chronicleState, chronicleRecv, chronicleDelete, chronicleGetData, chronicleSetData;

    beforeEach(async () => {
        resetCoreStubs();
        globalThis.document = { dispatchEvent: vi.fn() };
        const chronicle = await import('../chronicle/index.js');
        const chronicleData = await import('../chronicle/data.js');
        chronicleState = chronicleData.state;
        chronicleRecv = chronicle.onMessageReceived;
        chronicleDelete = chronicle.onMessageDeleted;
        chronicleGetData = chronicleData.getChronicleData;
        chronicleSetData = chronicleData.setChronicleData;
        chronicleState.msgSinceSnapshot = 0;
        chronicleState.lastChatLength = 0;
        chronicleState.countedReceiptEvents = new Map();
    });

    const chatOf = (n) => Array.from({ length: n }, () => ({ mes: 'x' }));

    test('a panic-window RECEIVE updates lastChatLength but leaves the counter alone', async () => {
        // The router now threads { countMessage: false } during a panic window
        // instead of skipping the call, so lastChatLength bookkeeping stays
        // live while counting + generation are suppressed. This is the receive
        // mirror of the delete test below it.
        setFakeChat(chatOf(100));
        chronicleState.lastChatLength = 50; // deliberately stale
        chronicleState.msgSinceSnapshot = 5;

        await chronicleRecv({ countMessage: false });

        // Bookkeeping ran → lastChatLength tracks the live chat (100), and the
        // counter was NOT incremented (still 5).
        expect(chronicleState.lastChatLength).toBe(100);
        expect(chronicleState.msgSinceSnapshot).toBe(5);
    });

    test('a panic-window delete updates lastChatLength but leaves the counter alone', () => {
        // Chat at 100, counter at 5, lastChatLength in sync.
        setFakeChat(chatOf(100));
        chronicleState.lastChatLength = 100;
        chronicleState.msgSinceSnapshot = 5;

        // Panic ON: 20 messages deleted → chat shrinks to 80.
        setFakeChat(chatOf(80));
        chronicleDelete(79, { adjustCounters: false });

        // Bookkeeping stayed live …
        expect(chronicleState.lastChatLength).toBe(80);
        // … but the counter was NOT decremented (the fix).
        expect(chronicleState.msgSinceSnapshot).toBe(5);
    });

    test('deleting a user/assistant pair reverses one received-message counter unit', () => {
        // MESSAGE_RECEIVED fires for the assistant reply only. A bulk delete of
        // its user prompt plus reply removes two raw entries but only one unit
        // from the Chronicle cadence.
        setFakeChat([
            { is_user: true, mes: 'prompt' },
            { mes: 'reply' },
        ]);
        chronicleState.lastChatLength = 2;
        chronicleState.countedReceiptEvents = new Map([['fallback::reply:1', 1]]);
        chronicleState.msgSinceSnapshot = 1;

        setFakeChat([]);
        chronicleDelete(0);

        expect(chronicleState.msgSinceSnapshot).toBe(0);
        expect(chronicleState.countedReceiptEvents.size).toBe(0);
    });

    test('the first post-panic delete computes removed from the LIVE length, not a frozen one', () => {
        // Start: chat 100, lastChatLength 100, counter 5.
        setFakeChat(chatOf(100));
        chronicleState.lastChatLength = 100;
        chronicleState.msgSinceSnapshot = 5;

        // Panic ON: delete 20 → chat 80. lastChatLength tracks to 80.
        setFakeChat(chatOf(80));
        chronicleDelete(79, { adjustCounters: false });
        expect(chronicleState.lastChatLength).toBe(80);

        // Panic OFF: delete 1 more → chat 79.
        setFakeChat(chatOf(79));
        chronicleDelete(78, { adjustCounters: true });

        // The removed message was never recorded as a counted receipt (it was
        // received/deleted during panic), so it must not subtract from a
        // counter whose provenance is unknown. No lumped or false reversal.
        expect(chronicleState.msgSinceSnapshot).toBe(5);
    });

    test('deleting an old receipt that predates this cadence does not decrement it', () => {
        setFakeChat([{ id: 'old', mes: 'old reply' }, { id: 'new', mes: 'new reply' }]);
        chronicleState.lastChatLength = 2;
        chronicleState.msgSinceSnapshot = 1;
        chronicleState.countedReceiptEvents = new Map([['id:new', 1]]);

        setFakeChat([{ id: 'new', mes: 'new reply' }]);
        chronicleDelete(0);

        expect(chronicleState.msgSinceSnapshot).toBe(1);
    });

    test('an edited receipt keeps its UUID provenance when an earlier message is deleted', () => {
        setFakeChat([
            { mes: 'old reply', name: 'Mara', send_date: '2026-01-01T00:00:00.000Z' },
            { mes: 'current reply', name: 'Mara', send_date: '2026-01-01T00:01:00.000Z' },
        ]);
        // Record a real receipt so the test covers UUID stamping rather than a
        // hand-constructed key, then mutate its content as a swipe/edit would.
        chronicleState.msgSinceSnapshot = 0;
        chronicleState.lastChatLength = 0;
        chronicleState.countedReceiptEvents = new Map();
        return chronicleRecv().then(() => {
            const retained = getFakeChat()[1];
            const key = [...chronicleState.countedReceiptEvents.keys()][0];
            retained.mes = 'swiped replacement reply';
            chronicleState.lastChatLength = 2;
            setFakeChat([retained]);
            chronicleDelete(0);

            expect(chronicleState.msgSinceSnapshot).toBe(1);
            expect(chronicleState.countedReceiptEvents).toEqual(new Map([[key, 1]]));
            expect(retained.extra.mwt_uuid).toBeTruthy();
        });
    });

    test('persists receipt provenance with its counter for reload restoration', async () => {
        setFakeChat([{ id: 'reply', mes: 'current reply' }]);
        await chronicleRecv();
        chronicleState.countedReceiptEvents = new Map(); // emulate a fresh runtime
        const { onChatChanged } = await import('../chronicle/index.js');
        onChatChanged();

        expect(chronicleState.msgSinceSnapshot).toBe(1);
        expect(chronicleState.countedReceiptEvents).toEqual(new Map([['id:reply', 1]]));
    });

    test('multiple received events for one regenerated receipt reverse together', async () => {
        setFakeChat([{ id: 'reply', mes: 'first generation' }]);
        await chronicleRecv();
        // SillyTavern can emit another receipt event while replacing the same
        // message object with a regenerated reply.
        setFakeChat([{ id: 'reply', mes: 'regenerated reply' }]);
        await chronicleRecv();
        expect(chronicleState.msgSinceSnapshot).toBe(2);

        setFakeChat([]);
        chronicleDelete(0);
        expect(chronicleState.msgSinceSnapshot).toBe(0);
    });

    test('the first deletion after initialization does not guess from raw history', async () => {
        setFakeChat([{ id: 'old', mes: 'existing assistant reply' }]);
        chronicleState.msgSinceSnapshot = 1;
        chronicleState.lastChatLength = 1;
        chronicleState.countedReceiptEvents = new Map();

        setFakeChat([]);
        chronicleDelete(0);

        expect(chronicleState.msgSinceSnapshot).toBe(1);
    });

    test('anchor staleness is flagged during a panic-window delete (integrity stays live)', () => {
        // Set up a chronicle anchor at index 50, then delete at index 40 (before
        // the anchor). The anchor must still be flagged stale even though
        // adjustCounters is false — integrity is not gated by the panic switch.
        chronicleSetData({ lastAnchor: { msgIndex: 50 } });
        setFakeChat(chatOf(100));
        chronicleState.lastChatLength = 100;

        setFakeChat(chatOf(99));
        chronicleDelete(40, { adjustCounters: false });

        expect(chronicleGetData().anchorStale).toBe(true);
    });
});

// ─── extractMessageIndex ─────────────────────────────────────────────────────

describe('extractMessageIndex', () => {
    test('passes a bare number through', () => {
        expect(extractMessageIndex(7)).toBe(7);
    });

    test('reads messageId from an object payload', () => {
        expect(extractMessageIndex({ messageId: 9 })).toBe(9);
    });

    test('reads index from an object payload', () => {
        expect(extractMessageIndex({ index: 4 })).toBe(4);
    });

    test('returns null for unknown / missing shapes', () => {
        expect(extractMessageIndex(undefined)).toBeNull();
        expect(extractMessageIndex(null)).toBeNull();
        expect(extractMessageIndex({})).toBeNull();
        expect(extractMessageIndex('not-a-number')).toBeNull();
    });
});
