/**
 * test/activation.test.js — the lorebook auto-activation write path.
 *
 * The properties worth protecting (design doc:
 * upcoming_work_misc/LOREBOOK_ACTIVATION_PLAN.md):
 *   1. The Knowledge book claims the chat's ONE bound-book slot, and only
 *      when it is empty or already ours — a foreign book is never replaced,
 *      only reported.
 *   2. The State book lands in the slot chosen by stateScope: global
 *      selection (additive, idempotent) or the card's ADDITIONAL books —
 *      never the primary slot, which re-saves the whole card.
 *   3. Unbind is surgical: exactly the ledgered writes are undone, foreign
 *      books in the same slots survive, and the chat-slot key is DELETED
 *      (ST's own unbind), not blanked.
 *   4. A missing API / null wiScript / hostile accessor degrades to
 *      skip + record — never a throw.
 *
 * The fake world-info namespace below mirrors ST 1.18.0 semantics: the
 * global selection is a live array set through updateWorldInfoSettings, and
 * charLore entries are keyed by the avatar filename WITHOUT its extension.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    resetCoreStubs, setFakeContextExtras, getFakeMeta, getFakeExtSettings, getEvents,
} from './stubs/core.js';
import { state } from '../knowledge/state.js';
import { getSettings, saveSettings as saveKnowledgeSettings } from '../knowledge/settings.js';
import {
    applyActivationBindings, removeActivationBindings, pruneStaleLedger,
} from '../knowledge/activation.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * Minimal stand-in for ST's world-info.js namespace, mirroring the parts
 * activation.js touches. `calls` counts setter invocations so tests can
 * assert idempotency and that the primary-book API is never reached.
 */
function makeFakeWorldInfo() {
    const calls = { updateSettings: 0, addAux: 0, setAux: 0, primary: 0 };
    const wi = {
        calls,
        selected_world_info: [],
        world_info: { charLore: [] },
        updateWorldInfoSettings(_settings, activeWorldInfo) {
            if (Array.isArray(activeWorldInfo)) {
                calls.updateSettings++;
                wi.selected_world_info = activeWorldInfo.slice();
            }
        },
        charUpdateAddAuxWorld(characterKey, nameOrNames) {
            calls.addAux++;
            const fileName = String(characterKey).replace(/\.[^/.]+$/, '');
            // Like ST's own setter: a MISSING charLore is treated as an empty
            // list (stock ST initializes world_info as {}).
            wi.world_info.charLore ??= [];
            const toAdd = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
            let entry = wi.world_info.charLore.find((e) => e.name === fileName);
            if (!entry) { entry = { name: fileName, extraBooks: [] }; wi.world_info.charLore.push(entry); }
            entry.extraBooks = [...new Set([...(entry.extraBooks || []), ...toAdd])];
        },
        charSetAuxWorlds(fileName, books) {
            calls.setAux++;
            const next = Array.isArray(books) ? books : [];
            // Like ST's own setter: a MISSING charLore is treated as an empty
            // list (stock ST initializes world_info as {}).
            wi.world_info.charLore ??= [];
            let entry = wi.world_info.charLore.find((e) => e.name === fileName);
            if (!entry && next.length) { entry = { name: fileName, extraBooks: next }; wi.world_info.charLore.push(entry); return; }
            if (entry) entry.extraBooks = next;
        },
        // Must remain at zero: the primary slot re-saves the whole card.
        charUpdatePrimaryWorld() { calls.primary++; },
    };
    return wi;
}

let wiFake;

/** Give the (stub) context a single identifiable character card. */
function useCharacterChat() {
    setFakeContextExtras({
        characterId: 0,
        characters: [{ name: 'Mara', avatar: 'mara.png' }],
    });
}

const ledgerOf = () => getSettings().activation;
const sawEvent = (name) => getEvents().some((e) => e?.event === name);

beforeEach(() => {
    resetCoreStubs();
    // Wire the fake extension_settings into the fake context so the Knowledge
    // settings manager actually persists across getSettings()/saveSettings()
    // calls (without this it silently falls back to unavailable localStorage).
    setFakeContextExtras({ extensionSettings: getFakeExtSettings() });
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    state.wiScript = null;
});

// ─── Knowledge book → the chat's bound-book slot ─────────────────────────────

describe('applyActivationBindings — Knowledge → chat slot', () => {
    test('binds the Knowledge book to an empty chat slot and records the ledger', async () => {
        saveKnowledgeSettings({ bindKnowledgeToChat: true });

        const res = await applyActivationBindings('test');

        expect(getFakeMeta().world_info).toBe('Knowledge Tracker');
        expect(ledgerOf().chatSlot).toEqual(['Knowledge Tracker']);
        expect(res.applied).toHaveLength(1);
    });

    test('is idempotent — a second apply writes nothing new', async () => {
        saveKnowledgeSettings({ bindKnowledgeToChat: true });
        await applyActivationBindings('test');

        const res2 = await applyActivationBindings('test');

        expect(getFakeMeta().world_info).toBe('Knowledge Tracker');
        expect(ledgerOf().chatSlot).toEqual(['Knowledge Tracker']);
        expect(res2.applied).toEqual([]);
    });

    test('never clobbers a foreign book in the chat slot', async () => {
        getFakeMeta().world_info = 'User Book';
        saveKnowledgeSettings({ bindKnowledgeToChat: true });

        const res = await applyActivationBindings('test');

        expect(getFakeMeta().world_info).toBe('User Book');
        expect(res.conflicts).toHaveLength(1);
        expect(ledgerOf().chatSlot).toEqual([]);
        expect(sawEvent('activation_conflict_chat_slot')).toBe(true);
    });

    test('does NOT adopt a slot the user bound by hand — no write, no record, no unbind', async () => {
        getFakeMeta().world_info = 'Knowledge Tracker'; // bound by hand earlier
        saveKnowledgeSettings({ bindKnowledgeToChat: true });

        const res = await applyActivationBindings('test');

        expect(res.applied).toEqual([]);         // nothing new to write
        expect(ledgerOf().chatSlot).toEqual([]); // and nothing recorded
        expect(getFakeMeta().mwt_chat_world_info).toBeUndefined();

        // A later toggle-off must not unbind the user's own binding.
        await removeActivationBindings({ chat: true });
        expect(getFakeMeta().world_info).toBe('Knowledge Tracker');
    });

    test('skips with a note when there is no chat metadata (no chat open)', async () => {
        setFakeContextExtras({ chatMetadata: undefined });
        saveKnowledgeSettings({ bindKnowledgeToChat: true });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_kt_no_chat')).toBe(true);
        expect(ledgerOf().chatSlot).toEqual([]);
    });
});

// ─── Per-chat chat-slot ownership ─────────────────────────────────────────────

describe('applyActivationBindings — per-chat chat-slot ownership', () => {
    /** Swap in another chat's metadata: chats own independent metadata in ST. */
    const useChat = (meta) => {
        setFakeContextExtras({ chatMetadata: meta });
        return meta;
    };

    test('binding chat B does not orphan chat A — A is cleaned when revisited', async () => {
        const chatA = useChat({});
        const chatB = {};
        saveKnowledgeSettings({ bindKnowledgeToChat: true });

        await applyActivationBindings('test');
        expect(chatA.world_info).toBe('Knowledge Tracker');
        expect(chatA.mwt_chat_world_info).toBe('Knowledge Tracker');

        useChat(chatB);
        await applyActivationBindings('test');
        expect(chatB.world_info).toBe('Knowledge Tracker');

        // Toggle off while chat B is open: only B's slot is reachable now…
        saveKnowledgeSettings({ bindKnowledgeToChat: false });
        await removeActivationBindings({ chat: true });
        expect('world_info' in chatB).toBe(false);
        expect(chatA.world_info).toBe('Knowledge Tracker'); // untouched from here

        // …but revisiting A performs the deferred cleanup.
        useChat(chatA);
        const res = await applyActivationBindings('chat change');
        expect('world_info' in chatA).toBe(false);
        expect('mwt_chat_world_info' in chatA).toBe(false);
        expect(res.cleaned).toHaveLength(1);
        expect(sawEvent('activation_deferred_chat_slot_cleanup')).toBe(true);
    });

    test('a scope rename RECLAIMS the MWT-owned slot instead of conflicting with it', async () => {
        const chat = useChat({});
        useCharacterChat();
        saveKnowledgeSettings({ scope: 'character', bindKnowledgeToChat: true });
        await applyActivationBindings('test');
        const firstBook = chat.world_info;
        expect(firstBook).toBeTruthy();

        // The scope change saves a new binding → the resolved name changes.
        saveKnowledgeSettings({
            bookBindings: {
                'char:mara.png': {
                    knowledge: 'Knowledge Tracker - Mara v2',
                    state: 'State Tracker - Mara v2',
                    profiles: 'NPC Profiles - Mara v2',
                },
            },
        });
        const res = await applyActivationBindings('scope change');

        expect(chat.world_info).toBe('Knowledge Tracker - Mara v2');
        expect(chat.mwt_chat_world_info).toBe('Knowledge Tracker - Mara v2');
        expect(res.conflicts).toEqual([]);
        expect(res.applied[0]).toMatch(/replacing MWT's previous/);
        expect(sawEvent('activation_chat_slot_reclaimed')).toBe(true);
    });

    test('the user rebinding the slot by hand ends MWT ownership of it', async () => {
        const chat = useChat({});
        saveKnowledgeSettings({ bindKnowledgeToChat: true });
        await applyActivationBindings('test');

        chat.world_info = 'User Book'; // hand-rebound in ST's World Info panel
        const res = await applyActivationBindings('chat change');

        expect(res.conflicts).toHaveLength(1);              // reported, not replaced
        expect(chat.world_info).toBe('User Book');
        expect('mwt_chat_world_info' in chat).toBe(false);  // marker retired
    });

    test('a legacy pre-marker ledger entry is retired, never migrated into chat ownership', async () => {
        const chat = useChat({});
        chat.world_info = 'Knowledge Tracker'; // MWT 1.8's global ledger — or the user's own pick of the same book
        saveKnowledgeSettings({
            bindKnowledgeToChat: true,
            activation: { chatSlot: ['Knowledge Tracker'], global: [], charAux: {} },
        });

        const res = await applyActivationBindings('test');

        // The shadow ledger holds only a book name — it cannot prove THIS chat
        // was the one MWT bound, so it must not become an ownership marker.
        expect(chat.mwt_chat_world_info).toBeUndefined(); // NOT claimed
        expect(res.applied).toEqual([]);                  // nothing written
        expect(ledgerOf().chatSlot).toEqual([]);          // ambiguous entry retired

        // A later toggle-off therefore leaves the binding alone.
        await removeActivationBindings({ chat: true });
        expect(chat.world_info).toBe('Knowledge Tracker');
        expect('mwt_chat_world_info' in chat).toBe(false);
    });

    test("the shadow ledger left by a user-replaced slot never claims another chat's manual binding", async () => {
        const chatA = useChat({});
        saveKnowledgeSettings({ bindKnowledgeToChat: true });
        await applyActivationBindings('test'); // A: MWT binds, marks, and shadows

        chatA.world_info = 'User Book'; // user replaces MWT's slot by hand
        await applyActivationBindings('chat change');
        expect('mwt_chat_world_info' in chatA).toBe(false); // marker retired…

        // …and chat B — where the user bound the SAME book by hand — must not
        // be claimed through the stale shadow entry the replacement left.
        const chatB = useChat({ world_info: 'Knowledge Tracker' });
        const res = await applyActivationBindings('chat change');

        expect(chatB.mwt_chat_world_info).toBeUndefined();
        expect(res.applied).toEqual([]);
        expect(ledgerOf().chatSlot).toEqual([]);

        await removeActivationBindings({ chat: true });
        expect(chatB.world_info).toBe('Knowledge Tracker'); // user's binding intact
    });
});

// ─── State book → global selection ───────────────────────────────────────────

describe('applyActivationBindings — State → global', () => {
    test('adds the State book to the global selection once, leaving others untouched', async () => {
        wiFake.selected_world_info = ['User Book'];
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'global' });

        await applyActivationBindings('test');

        expect(wiFake.selected_world_info).toEqual(['User Book', 'State Tracker']);
        expect(ledgerOf().global).toEqual(['State Tracker']);

        const res2 = await applyActivationBindings('test');
        expect(wiFake.selected_world_info).toEqual(['User Book', 'State Tracker']);
        expect(res2.applied).toEqual([]);
    });

    test('skips and records when the setter API is absent', async () => {
        delete wiFake.updateWorldInfoSettings;
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'global' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_api_unavailable')).toBe(true);
    });

    test('skips (never replaces) when the selection accessor throws', async () => {
        Object.defineProperty(wiFake, 'selected_world_info', {
            configurable: true,
            get() { throw new Error('boom'); },
        });
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'global' });

        const res = await applyActivationBindings('test');

        // Fail closed: the setter REPLACES the whole selection, so an
        // unreadable one must not be guessed as empty — the user's picks on
        // a compatible fork would be replaced by only MWT's book.
        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_global_unreadable')).toBe(true);
        expect(wiFake.calls.updateSettings).toBe(0); // nothing written
        expect(ledgerOf().global).toEqual([]);
    });

    test('a MISSING selection is not read as empty — the setter never receives only our book', async () => {
        delete wiFake.selected_world_info; // fork: export not bound (yet)
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'global' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_global_unreadable')).toBe(true);
        expect(wiFake.calls.updateSettings).toBe(0);
        expect(ledgerOf().global).toEqual([]);
    });

    test('a MALFORMED selection (non-array) is not read as empty either', async () => {
        wiFake.selected_world_info = 'corrupt';
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'global' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_global_unreadable')).toBe(true);
        expect(wiFake.calls.updateSettings).toBe(0);
    });
});

// ─── State book → the card's additional (aux) books ──────────────────────────

describe('applyActivationBindings — State → character aux', () => {
    test("adds the State book to the card's additional books, keyed by avatar", async () => {
        useCharacterChat();
        saveKnowledgeSettings({ scope: 'character', bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        // Character scope derives "State Tracker - Mara"; charLore is keyed
        // by the avatar WITHOUT its extension ('mara.png' → 'mara').
        expect(wiFake.world_info.charLore).toEqual([
            { name: 'mara', extraBooks: ['State Tracker - Mara'] },
        ]);
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker - Mara'] });
        expect(res.applied).toHaveLength(1);
        expect(wiFake.calls.primary).toBe(0);

        // Idempotent: the read-side check means no second write.
        await applyActivationBindings('test');
        expect(wiFake.calls.addAux).toBe(1);
    });

    test('does not re-add a book the user bound manually — and does not adopt it either', async () => {
        useCharacterChat();
        wiFake.world_info.charLore = [{ name: 'mara', extraBooks: ['State Tracker - Mara'] }];
        saveKnowledgeSettings({ scope: 'character', bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        expect(wiFake.calls.addAux).toBe(0);
        expect(res.applied).toEqual([]);
        // No write was performed, so nothing is ledgered — a later toggle-off
        // must not strip a binding MWT never made.
        expect(ledgerOf().charAux).toEqual({});
    });

    test('skips group chats without touching charLore', async () => {
        setFakeContextExtras({ groupId: 'g7', groups: [{ id: 'g7', name: 'The Crew' }] });
        saveKnowledgeSettings({ scope: 'character', bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        expect(wiFake.world_info.charLore).toEqual([]);
        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_state_no_card')).toBe(true);
    });

    test('never falls back to the primary-book API when aux is unavailable', async () => {
        useCharacterChat();
        delete wiFake.charUpdateAddAuxWorld;
        delete wiFake.charSetAuxWorlds;
        saveKnowledgeSettings({ scope: 'character', bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_aux_unavailable')).toBe(true);
        expect(wiFake.calls.primary).toBe(0);
    });
});

// ─── State book → chat target (v1) ───────────────────────────────────────────

describe('applyActivationBindings — State → chat target', () => {
    test('v1 skips with a note — the chat slot is reserved for Knowledge', async () => {
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'chat' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_state_chat_scope')).toBe(true);
        expect(getFakeMeta().world_info).toBeUndefined();
    });
});

// ─── Ownership is recorded only for writes MWT performs ──────────────────────

describe('applyActivationBindings — never adopts a binding it did not write', () => {
    test('a State book already in the global selection is not adopted', async () => {
        wiFake.selected_world_info = ['State Tracker'];
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'global' });

        const res = await applyActivationBindings('test');

        expect(res.applied).toEqual([]);
        expect(wiFake.calls.updateSettings).toBe(0);
        expect(ledgerOf().global).toEqual([]);

        // …and a later toggle-off must not remove the user's selection.
        await removeActivationBindings({ state: true });
        expect(wiFake.selected_world_info).toEqual(['State Tracker']);
    });

    test('an aux book the user already added to the card is not adopted', async () => {
        useCharacterChat();
        wiFake.world_info.charLore = [{ name: 'mara', extraBooks: ['State Tracker'] }];
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        expect(res.applied).toEqual([]);
        expect(wiFake.calls.addAux).toBe(0);
        expect(ledgerOf().charAux).toEqual({});
    });
});

describe('unreadable aux state — never guess, never erase', () => {
    test('apply skips when the card\'s aux list cannot be read', async () => {
        useCharacterChat();
        Object.defineProperty(wiFake.world_info, 'charLore', {
            configurable: true,
            get() { throw new Error('boom'); },
        });
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_aux_unreadable')).toBe(true);
        expect(ledgerOf().charAux).toEqual({});
        expect(wiFake.calls.addAux).toBe(0);
    });

    test('unbind RETAINS the ledger when the list is unreadable — a failed read must not erase user books', async () => {
        useCharacterChat();
        wiFake.world_info.charLore = [{ name: 'mara', extraBooks: ['User Book'] }];
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: [], charAux: { 'mara.png': ['State Tracker'] } },
        });
        Object.defineProperty(wiFake.world_info, 'charLore', {
            configurable: true,
            get() { throw new Error('boom'); },
        });

        const res = await removeActivationBindings({ state: true });

        expect(wiFake.calls.setAux).toBe(0); // no replace-with-our-guess
        expect(res.removed).toEqual([]);
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker'] }); // retry later
    });

    test('a throwing charSetAuxWorlds also retains the ledger for a later retry', async () => {
        wiFake.world_info.charLore = [{ name: 'mara', extraBooks: ['User Book', 'State Tracker'] }];
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: [], charAux: { 'mara.png': ['State Tracker'] } },
        });
        wiFake.charSetAuxWorlds = () => { throw new Error('boom'); };

        const res = await removeActivationBindings({ state: true });

        expect(res.removed).toEqual([]);
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker'] });
    });

    test('a REJECTED charSetAuxWorlds promise also retains the ledger — no false success', async () => {
        wiFake.world_info.charLore = [{ name: 'mara', extraBooks: ['User Book', 'State Tracker'] }];
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: [], charAux: { 'mara.png': ['State Tracker'] } },
        });
        wiFake.charSetAuxWorlds = () => { wiFake.calls.setAux++; return Promise.reject(new Error('boom')); };

        const res = await removeActivationBindings({ state: true });

        expect(wiFake.calls.setAux).toBe(1);    // the strip was attempted…
        expect(res.removed).toEqual([]);        // …and reported as failed
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker'] }); // retry later
    });

    test('a throwing charUpdateAddAuxWorld is skipped, never ledgered', async () => {
        useCharacterChat();
        wiFake.charUpdateAddAuxWorld = () => { throw new Error('boom'); };
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_aux_write_failed')).toBe(true);
        expect(ledgerOf().charAux).toEqual({});
    });

    test('a REJECTED charUpdateAddAuxWorld promise is a failure — skipped, never ledgered', async () => {
        useCharacterChat();
        // The real ST setter is async; a rejection must not be recorded as
        // a successful (and owned) write, nor surface as an unhandled one.
        wiFake.charUpdateAddAuxWorld = () => { wiFake.calls.addAux++; return Promise.reject(new Error('boom')); };
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        expect(wiFake.calls.addAux).toBe(1); // the write was attempted…
        expect(res.skipped).toHaveLength(1);  // …and reported as failed
        expect(sawEvent('activation_skip_aux_write_failed')).toBe(true);
        expect(ledgerOf().charAux).toEqual({});
        expect(wiFake.world_info.charLore).toEqual([]); // fake untouched
    });

    test('a MISSING charLore is stock ST — reads as empty, so binding proceeds', async () => {
        useCharacterChat();
        delete wiFake.world_info.charLore; // stock ST: world_info === {}
        saveKnowledgeSettings({ scope: 'character', bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toEqual([]);
        expect(res.applied).toHaveLength(1);
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker - Mara'] });
    });

    test('a MALFORMED charLore (present but not an array) is still an error', async () => {
        useCharacterChat();
        wiFake.world_info.charLore = 'corrupt';
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'character' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_skip_aux_unreadable')).toBe(true);
        expect(ledgerOf().charAux).toEqual({});
        expect(wiFake.calls.addAux).toBe(0);
    });

    test('unbind strips our names even when charLore is missing (clean install)', async () => {
        delete wiFake.world_info.charLore; // stock ST: world_info === {}
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: [], charAux: { 'mara.png': ['State Tracker'] } },
        });

        const res = await removeActivationBindings({ state: true });

        expect(res.removed).toHaveLength(1);
        expect(ledgerOf().charAux).toEqual({});
    });
});

// ─── Robustness ──────────────────────────────────────────────────────────────

describe('applyActivationBindings — robustness', () => {
    test('null wiScript is a clean no-op with a diagnostic', async () => {
        state.wiScript = null;
        saveKnowledgeSettings({ bindKnowledgeToChat: true, bindStateBook: true, stateScope: 'global' });

        const res = await applyActivationBindings('test');

        expect(res.skipped).toHaveLength(1);
        expect(sawEvent('activation_no_wiscript')).toBe(true);
        expect(getFakeMeta().world_info).toBeUndefined();
    });

    test('a hostile selected_world_info accessor never throws out', async () => {
        Object.defineProperty(wiFake, 'selected_world_info', {
            configurable: true,
            get() { throw new Error('boom'); },
        });
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'global' });

        await expect(applyActivationBindings('test')).resolves.toHaveProperty('skipped');
    });
});

// ─── removeActivationBindings ────────────────────────────────────────────────

describe('removeActivationBindings', () => {
    test('frees the chat slot by DELETING the key (not writing "")', async () => {
        saveKnowledgeSettings({ bindKnowledgeToChat: true });
        await applyActivationBindings('test');
        expect(getFakeMeta().world_info).toBe('Knowledge Tracker');

        await removeActivationBindings({ chat: true });

        expect('world_info' in getFakeMeta()).toBe(false);
        expect(ledgerOf().chatSlot).toEqual([]);
    });

    test('leaves a foreign chat-slot book alone even when the ledger disagrees', async () => {
        saveKnowledgeSettings({ bindKnowledgeToChat: true });
        await applyActivationBindings('test');
        // The user swapped the slot to their own book afterwards.
        getFakeMeta().world_info = 'User Book';

        await removeActivationBindings({ chat: true });

        expect(getFakeMeta().world_info).toBe('User Book');
        expect(ledgerOf().chatSlot).toEqual([]);
    });

    test('a legacy shadow-ledger match does NOT unbind the slot — the entry is retired only', async () => {
        getFakeMeta().world_info = 'Knowledge Tracker'; // may be the user's own binding of the same book
        saveKnowledgeSettings({
            activation: { chatSlot: ['Knowledge Tracker'], global: [], charAux: {} },
        });

        const res = await removeActivationBindings({ chat: true });

        // The global entry cannot prove THIS chat was the one MWT bound, so
        // the slot is left untouched and the ambiguous entry is discarded.
        expect(getFakeMeta().world_info).toBe('Knowledge Tracker');
        expect(getFakeMeta().mwt_chat_world_info).toBeUndefined();
        expect(ledgerOf().chatSlot).toEqual([]);
        expect(res.removed).toHaveLength(1); // explains the discard, reports no unbind
        expect(sawEvent('activation_legacy_chatslot_retired')).toBe(true);
    });

    test('removes our global entry but keeps foreign books', async () => {
        wiFake.selected_world_info = ['User Book'];
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'global' });
        await applyActivationBindings('test');

        await removeActivationBindings({ state: true });

        expect(wiFake.selected_world_info).toEqual(['User Book']);
        expect(ledgerOf().global).toEqual([]);
    });

    test('a failed global unbind (setter missing) retains the ledger for a later retry', async () => {
        wiFake.selected_world_info = ['State Tracker', 'User Book'];
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: ['State Tracker'], charAux: {} },
        });
        delete wiFake.updateWorldInfoSettings;

        const res = await removeActivationBindings({ state: true });

        expect(wiFake.selected_world_info).toEqual(['State Tracker', 'User Book']); // still active
        expect(res.removed).toEqual([]);
        expect(ledgerOf().global).toEqual(['State Tracker']); // ownership kept — retry later
        expect(sawEvent('activation_global_remove_failed')).toBe(true);
    });

    test('a throwing global setter retains the ledger entry — and a retry once it works removes it', async () => {
        wiFake.selected_world_info = ['State Tracker'];
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: ['State Tracker'], charAux: {} },
        });
        const realSetter = wiFake.updateWorldInfoSettings;
        wiFake.updateWorldInfoSettings = () => { throw new Error('boom'); };

        await removeActivationBindings({ state: true });
        expect(wiFake.selected_world_info).toEqual(['State Tracker']); // untouched
        expect(ledgerOf().global).toEqual(['State Tracker']); // retained

        // The retained entry is what makes the retry (API back) succeed.
        wiFake.updateWorldInfoSettings = realSetter;
        const res2 = await removeActivationBindings({ state: true });
        expect(wiFake.selected_world_info).toEqual([]);
        expect(res2.removed).toHaveLength(1);
        expect(ledgerOf().global).toEqual([]);
    });

    test('an unreadable global selection retains the ledger — absence was not confirmed', async () => {
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: ['State Tracker'], charAux: {} },
        });
        Object.defineProperty(wiFake, 'selected_world_info', {
            configurable: true,
            get() { throw new Error('boom'); },
        });

        await removeActivationBindings({ state: true });

        expect(ledgerOf().global).toEqual(['State Tracker']);
        expect(sawEvent('activation_global_remove_failed')).toBe(true);
    });

    test('a null/undefined global selection is NOT confirmed absence — the ledger is retained', async () => {
        wiFake.selected_world_info = null; // fork: export present but not initialized
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: ['State Tracker'], charAux: {} },
        });

        const res = await removeActivationBindings({ state: true });

        expect(wiFake.calls.updateSettings).toBe(0); // no blind write
        expect(res.removed).toEqual([]);
        expect(ledgerOf().global).toEqual(['State Tracker']); // absence not proven — retry later
        expect(sawEvent('activation_global_remove_failed')).toBe(true);

        // Once the selection reads again, the retained entry removes cleanly.
        wiFake.selected_world_info = ['State Tracker', 'User Book'];
        const res2 = await removeActivationBindings({ state: true });
        expect(wiFake.selected_world_info).toEqual(['User Book']);
        expect(res2.removed).toHaveLength(1);
        expect(ledgerOf().global).toEqual([]);
    });

    test('a positively absent global entry is retired without calling the setter', async () => {
        wiFake.selected_world_info = ['User Book'];
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: ['State Tracker'], charAux: {} },
        });

        const res = await removeActivationBindings({ state: true });

        expect(res.removed).toEqual([]); // it was already gone — nothing to remove
        expect(ledgerOf().global).toEqual([]); // absence confirmed → entry retired
        expect(wiFake.calls.updateSettings).toBe(0);
    });

    test("strips only our names from a card's aux books", async () => {
        wiFake.world_info.charLore = [{ name: 'mara', extraBooks: ['User Book', 'State Tracker - Mara'] }];
        saveKnowledgeSettings({
            activation: { chatSlot: [], global: [], charAux: { 'mara.png': ['State Tracker - Mara'] } },
        });

        await removeActivationBindings({ state: true });

        expect(wiFake.world_info.charLore).toEqual([{ name: 'mara', extraBooks: ['User Book'] }]);
        expect(ledgerOf().charAux).toEqual({});
    });

    test('chat-slot removal still works when wiScript is null (context-only)', async () => {
        saveKnowledgeSettings({ bindKnowledgeToChat: true });
        await applyActivationBindings('test');

        state.wiScript = null;
        await removeActivationBindings({ chat: true });

        expect('world_info' in getFakeMeta()).toBe(false);
    });
});

// ─── pruneStaleLedger ────────────────────────────────────────────────────────

describe('pruneStaleLedger', () => {
    test('keeps every live binding, drops dead names, and never touches ST', () => {
        saveKnowledgeSettings({
            bookBindings: {
                'char:mara.png': { knowledge: 'Knowledge Tracker - Mara', state: 'State Tracker - Mara', profiles: 'NPC Profiles - Mara' },
                'char:kira.png': { knowledge: 'Knowledge Tracker - Kira', state: 'State Tracker - Kira', profiles: 'NPC Profiles - Kira' },
            },
            activation: {
                chatSlot: [],
                global: ['State Tracker - Old'],
                charAux: { 'mara.png': ['State Tracker - Mara'], 'ghost.png': ['Dead Book'] },
            },
        });

        pruneStaleLedger();

        // 'State Tracker - Old' and 'Dead Book' are no longer targetable by
        // any binding; Mara's and the global names stay live (multi-card fix:
        // a prune against only the CURRENT identity would have dropped Kira).
        expect(ledgerOf().global).toEqual([]);
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker - Mara'] });
        expect(wiFake.calls.updateSettings).toBe(0); // prune is ledger-only
        expect(wiFake.calls.addAux).toBe(0);
    });

    test('is a no-op when the ledger is already live', () => {
        saveKnowledgeSettings({
            activation: { chatSlot: ['Knowledge Tracker'], global: [], charAux: {} },
        });
        const before = ledgerOf();

        pruneStaleLedger();

        expect(ledgerOf()).toEqual(before);
    });
});

// ─── Settings defaults ───────────────────────────────────────────────────────

describe('activation settings defaults', () => {
    test('expose the toggles, off by default, with an empty ledger', () => {
        const s = getSettings();
        expect(s.bindKnowledgeToChat).toBe(false);
        expect(s.bindStateBook).toBe(false);
        expect(s.stateScope).toBe('character');
        expect(s.activation).toEqual({ chatSlot: [], global: [], charAux: {} });
    });
});

// ─── Superseded aux bindings — the unbounded-accumulation fix ────────────────
//
// The one combination where the State book's NAME changes but its SLOT does
// not: lorebook scope 'chat' (a fresh book per chat) + State target
// 'character' (one card's aux list). Every chat used to add another book and
// leave the previous one switched on.

describe('superseded aux prune — one State book per card, not one per chat', () => {
    /** Point the scope resolver at a named chat, with fresh chat metadata. */
    const useChat = (id) => setFakeContextExtras({
        getCurrentChatId: () => id,
        chatMetadata: {},
    });
    const auxOf = (fileName = 'mara') =>
        wiFake.world_info.charLore.find((e) => e.name === fileName)?.extraBooks ?? [];
    const USER_BOOK = 'Lore The User Picked';

    test('lorebook scope "chat" + State target "character" keeps exactly ONE book', async () => {
        useCharacterChat();
        saveKnowledgeSettings({ scope: 'chat', bindStateBook: true, stateScope: 'character' });

        for (const id of ['chatA', 'chatB', 'chatC']) {
            useChat(id);
            await applyActivationBindings('chat change');
        }

        // Before the prune this accumulated all three, every one still active.
        expect(auxOf()).toEqual(['State Tracker - chatC']);
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker - chatC'] });
        expect(sawEvent('activation_aux_superseded_pruned')).toBe(true);
    });

    test('reports the sweep so the settings panel can surface it', async () => {
        useCharacterChat();
        saveKnowledgeSettings({ scope: 'chat', bindStateBook: true, stateScope: 'character' });
        useChat('chatA');
        await applyActivationBindings('chat change');
        useChat('chatB');
        const res = await applyActivationBindings('chat change');

        expect(res.cleaned.join(' ')).toContain('State Tracker - chatA');
    });

    test('heals a card that accumulated books BEFORE the prune existed', async () => {
        useCharacterChat();
        // A pre-fix ledger: three of our books piled onto one card, plus a
        // book the user added by hand that must survive.
        wiFake.world_info.charLore = [{
            name: 'mara',
            extraBooks: ['State Tracker - chatA', 'State Tracker - chatB', USER_BOOK, 'State Tracker - chatC'],
        }];
        saveKnowledgeSettings({
            scope: 'chat', bindStateBook: true, stateScope: 'character',
            activation: {
                chatSlot: [], global: [],
                charAux: { 'mara.png': ['State Tracker - chatA', 'State Tracker - chatB', 'State Tracker - chatC'] },
            },
        });

        useChat('chatC'); // the current target is already bound — no add needed
        await applyActivationBindings('chat change');

        expect(auxOf()).toEqual([USER_BOOK, 'State Tracker - chatC']);
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker - chatC'] });
    });

    test('never strips a book the user bound by hand, even on the same card', async () => {
        useCharacterChat();
        wiFake.world_info.charLore = [{ name: 'mara', extraBooks: [USER_BOOK] }];
        saveKnowledgeSettings({ scope: 'chat', bindStateBook: true, stateScope: 'character' });

        useChat('chatA');
        await applyActivationBindings('chat change');
        useChat('chatB');
        await applyActivationBindings('chat change');

        expect(auxOf()).toEqual([USER_BOOK, 'State Tracker - chatB']);
    });

    test('a FAILED add leaves the previous book bound — never prunes into nothing', async () => {
        useCharacterChat();
        saveKnowledgeSettings({ scope: 'chat', bindStateBook: true, stateScope: 'character' });
        useChat('chatA');
        await applyActivationBindings('chat change');
        expect(auxOf()).toEqual(['State Tracker - chatA']);

        // The next chat's add rejects: the card must keep chatA's book rather
        // than being left with no State book at all.
        wiFake.charUpdateAddAuxWorld = () => Promise.reject(new Error('nope'));
        useChat('chatB');
        await applyActivationBindings('chat change');

        expect(auxOf()).toEqual(['State Tracker - chatA']);
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker - chatA'] });
    });

    test('a failed strip RETAINS the ledger so the next apply retries', async () => {
        useCharacterChat();
        saveKnowledgeSettings({ scope: 'chat', bindStateBook: true, stateScope: 'character' });
        useChat('chatA');
        await applyActivationBindings('chat change');

        // Add still works, but the strip rejects — both books stay bound, so
        // both must stay ledgered or the old one is stranded active.
        const realSet = wiFake.charSetAuxWorlds.bind(wiFake);
        wiFake.charSetAuxWorlds = () => Promise.reject(new Error('locked'));
        useChat('chatB');
        await applyActivationBindings('chat change');

        expect(ledgerOf().charAux['mara.png']).toEqual(['State Tracker - chatA', 'State Tracker - chatB']);
        expect(sawEvent('activation_aux_prune_failed')).toBe(true);

        // Once the setter works again the next apply sweeps the leftover.
        wiFake.charSetAuxWorlds = realSet;
        await applyActivationBindings('chat change');
        expect(auxOf()).toEqual(['State Tracker - chatB']);
        expect(ledgerOf().charAux).toEqual({ 'mara.png': ['State Tracker - chatB'] });
    });

    test('a stable book name (scope "character") prunes nothing', async () => {
        useCharacterChat();
        saveKnowledgeSettings({ scope: 'character', bindStateBook: true, stateScope: 'character' });
        useChat('chatA');
        await applyActivationBindings('chat change');
        useChat('chatB');
        await applyActivationBindings('chat change');

        expect(auxOf()).toEqual(['State Tracker - Mara']);
        expect(sawEvent('activation_aux_superseded_pruned')).toBe(false);
    });
});

// ─── Deferred retry for State unbinds ────────────────────────────────────────
//
// removeActivationBindings() retains a ledger entry whenever it cannot prove
// the binding is gone — but its only caller is the settings panel, so that
// retry had no trigger. These cover its counterpart to the chat slot's
// deferred cleanup.

describe('deferred State cleanup — the retry that had no trigger', () => {
    test('a global unbind that failed at toggle-off is retried on the next apply', async () => {
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'global' });
        await applyActivationBindings('test');
        expect(wiFake.selected_world_info).toContain('State Tracker');

        // Toggle off while the setter is broken: the book stays active and
        // the ledger entry is deliberately retained.
        const realUpdate = wiFake.updateWorldInfoSettings.bind(wiFake);
        wiFake.updateWorldInfoSettings = () => { throw new Error('locked'); };
        saveKnowledgeSettings({ bindStateBook: false });
        await removeActivationBindings({ state: true });
        expect(ledgerOf().global).toEqual(['State Tracker']);
        expect(wiFake.selected_world_info).toContain('State Tracker');

        // Next apply (init / chat change) retries it — no user action needed.
        wiFake.updateWorldInfoSettings = realUpdate;
        const res = await applyActivationBindings('chat change');

        expect(wiFake.selected_world_info).not.toContain('State Tracker');
        expect(ledgerOf().global).toEqual([]);
        expect(res.cleaned.length).toBeGreaterThan(0);
        expect(sawEvent('activation_deferred_state_cleanup')).toBe(true);
    });

    test('an aux unbind that failed at toggle-off is retried on the next apply', async () => {
        useCharacterChat();
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'character' });
        await applyActivationBindings('test');

        const realSet = wiFake.charSetAuxWorlds.bind(wiFake);
        wiFake.charSetAuxWorlds = () => Promise.reject(new Error('locked'));
        saveKnowledgeSettings({ bindStateBook: false });
        await removeActivationBindings({ state: true });
        expect(ledgerOf().charAux['mara.png']).toBeTruthy();

        wiFake.charSetAuxWorlds = realSet;
        await applyActivationBindings('chat change');

        expect(ledgerOf().charAux).toEqual({});
        expect(wiFake.world_info.charLore.find((e) => e.name === 'mara')?.extraBooks ?? []).toEqual([]);
    });

    test('does not churn when the API is permanently absent — no retry, no warn', async () => {
        saveKnowledgeSettings({
            bindStateBook: false,
            activation: { chatSlot: [], global: ['State Tracker'], charAux: {} },
        });
        delete wiFake.updateWorldInfoSettings; // a fork without the setter

        await applyActivationBindings('chat change');

        // Nothing to gain from retrying an absent API: the entry is kept for
        // a build that has it, and no warn is recorded on every chat change.
        expect(ledgerOf().global).toEqual(['State Tracker']);
        expect(sawEvent('activation_global_remove_failed')).toBe(false);
    });

    test('leaves the ledger alone while the toggle is still ON', async () => {
        useCharacterChat();
        saveKnowledgeSettings({ bindStateBook: true, stateScope: 'character' });
        await applyActivationBindings('test');
        const before = ledgerOf().charAux['mara.png'];

        await applyActivationBindings('chat change');

        expect(ledgerOf().charAux['mara.png']).toEqual(before);
    });
});
