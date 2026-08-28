/**
 * test/interiority_panic_switch.test.js — the panic switch must stop Interiority
 * GENERATION while leaving cleanup alive.
 *
 * THE BUG (reported from live use): with the "disable all trackers" panic switch
 * (`injectionMasterOff`) on, Interiority kept making API calls — visible in the
 * diagnostics panel (Health tab / API log) while the panic banner showed ON.
 *
 * MESSAGE_RECEIVED generation was already gated in core/event_router.js, and a
 * fresh-slot swipe defers to MESSAGE_RECEIVED (also gated). But the swipe/edit
 * handler `invalidateAndMaybeRegenerate` queues a regeneration whenever the LAST
 * message is swiped to an EXISTING slot (swipe navigation) or edited — and the
 * event router deliberately does not gate MESSAGE_SWIPED / MESSAGE_EDITED
 * (INTERIORITY-04 keeps ledger rollback/cleanup running during a panic window),
 * so that regeneration ran with no panic check at all.
 *
 * The fix: `generateForCurrentMessage` — the single choke point every automatic
 * API call flows through (batched/strict/split AND the dormant poll) — refuses
 * automatic (non-`force`) generations when `injectionAllowed('Interiority')` is
 * false. Manual triggers (💭 Generate button / /wt-thoughts, `force: true`) are
 * explicit user intent and still allowed; cleanup/rollback never flows through
 * it, so the INTERIORITY-04 contract (cleanup never gated) is preserved.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { resetCoreStubs, setFakeChat, setFakeApi, setFakeContextExtras } from './stubs/core.js';
import {
    saveSettings, getInteriorityData, setPerMessage, addLedgerEntry,
    getOrCreateMsgKeyForIndex, state,
} from '../interiority/data.js';
import {
    onMessageSwiped, onMessageEdited, onMessageReceived, triggerGenerate,
} from '../interiority/index.js';

let apiCalls;

beforeEach(() => {
    resetCoreStubs();
    apiCalls = [];
    // Any path that reaches a fetch lands here and is counted. Tests in this
    // file mostly assert it was NEVER reached; the panic-off control test
    // asserts exactly one call. `{"npcs": []}` parses cleanly enough for the
    // post-call pipeline either way.
    setFakeApi(async (req) => {
        apiCalls.push(req);
        return '{"npcs": []}';
    });
    // node env: interiority dispatches busy-changed events and the swipe path
    // re-renders thought blocks — stub the DOM surface they touch (mirrors
    // interiority_swipe_turns.test.js; getElementById→null makes
    // renderThoughtBlockForMessage return early).
    globalThis.document = {
        dispatchEvent: vi.fn(),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
    // autoMode defaults ON; give the module a valid connection so
    // hasValidSettings() is never the reason a generation is skipped.
    saveSettings({ apiUrl: 'http://example.test/v1', modelName: 'test-model' });
});

/** Two-message chat; the last (AI) message carries two existing swipes. */
function makeChat() {
    return [
        { name: 'User', is_user: true, mes: 'What will you do at the festival?', extra: {} },
        {
            name: 'Mara', is_user: false, mes: 'Mara glances toward the square.',
            extra: {},
            // swipe_id 1 of 2 existing slots — navigation, NOT a fresh slot:
            // invalidateAndMaybeRegenerate regenerates immediately instead of
            // deferring to MESSAGE_RECEIVED.
            swipes: ['Mara glances toward the square.', 'Mara turns away.'],
            swipe_id: 1,
        },
    ];
}

async function flushWorkQueue() {
    // The queue chains microtasks plus dynamic imports (buildSceneRoster
    // resolves the knowledge registry); awaiting the tail settles them all.
    await state.workQueue.catch(() => {});
    await new Promise(r => setTimeout(r, 20));
}

describe('panic switch (injectionMasterOff) vs Interiority generation', () => {
    test('swipe navigation on the last message: NO API call, cleanup still runs', async () => {
        setFakeChat(makeChat());
        setFakeContextExtras({ globalSettings: { injectionMasterOff: true } });

        const lastIdx = 1;
        const key = getOrCreateMsgKeyForIndex(lastIdx);
        setPerMessage(key, { reactions: [{ npc: 'Mara', thought: 'old thought' }] });

        onMessageSwiped(lastIdx);
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(0);
        // INTERIORITY-04: cleanup is NOT gated — the invalidated perMessage
        // record must be gone even during the panic window.
        expect(getInteriorityData().perMessage[key]).toBeUndefined();
    });

    test('editing the last message: NO API call while panic is ON', async () => {
        setFakeChat(makeChat());
        setFakeContextExtras({ globalSettings: { injectionMasterOff: true } });

        const lastIdx = 1;
        const key = getOrCreateMsgKeyForIndex(lastIdx);
        setPerMessage(key, { reactions: [{ npc: 'Mara', thought: 'old thought' }] });

        onMessageEdited(lastIdx);
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(0);
        expect(getInteriorityData().perMessage[key]).toBeUndefined();
    });

    test('MESSAGE_RECEIVED: NO API call while panic is ON (choke point, not just the router)', async () => {
        // The event router already skips Interiority during panic; this
        // verifies the in-module gate independently, so the contract cannot
        // regress if the router's dispatch ever changes shape.
        setFakeChat(makeChat());
        setFakeContextExtras({ globalSettings: { injectionMasterOff: true } });

        onMessageReceived(1);
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(0);
    });

    test('per-module disable (enableInteriority: false) also stops the regeneration', async () => {
        // Defense in depth: the router skips the module entirely when
        // enableInteriority is false, but the choke point must hold even if a
        // handler is invoked directly (mirrors injectionAllowed's contract).
        setFakeChat(makeChat());
        setFakeContextExtras({ globalSettings: { enableInteriority: false } });

        const key = getOrCreateMsgKeyForIndex(1);
        setPerMessage(key, { reactions: [{ npc: 'Mara', thought: 'old thought' }] });

        onMessageSwiped(1);
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(0);
        expect(getInteriorityData().perMessage[key]).toBeUndefined();
    });

    test('panic OFF: swipe navigation on the last message DOES regenerate (no over-gating)', async () => {
        setFakeChat(makeChat());
        // No injectionMasterOff — generation must still happen. An active
        // ledger entry is the roster source that needs no world state,
        // registry, or ctx.name2 (active NPCs are always rostered).
        addLedgerEntry({ npc: 'Mara', action: 'visit the market', trigger: 'harvest festival' }, 'day 1', 0);
        const key = getOrCreateMsgKeyForIndex(1);
        setPerMessage(key, { reactions: [{ npc: 'Mara', thought: 'old thought' }] });

        onMessageSwiped(1);
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(1);
    });

    test('manual trigger (force) still runs while panic is ON — explicit user intent', async () => {
        // The 💭 Generate button / /wt-thoughts pass force: true. The panic
        // switch stops AUTOMATIC injection/scanning; an explicitly requested
        // generation (also the documented repair path after a swipe/edit
        // landing on an off-turn) is not silently swallowed.
        setFakeChat(makeChat());
        setFakeContextExtras({ globalSettings: { injectionMasterOff: true } });
        // Roster source for the manual path (no world state/registry/name2).
        addLedgerEntry({ npc: 'Mara', action: 'visit the market', trigger: 'harvest festival' }, 'day 1', 0);

        await triggerGenerate();
        await flushWorkQueue();

        expect(apiCalls).toHaveLength(1);
    });
});

