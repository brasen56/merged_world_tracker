/**
 * knowledge/activation.js — switch MWT's lorebooks ON in SillyTavern's World
 * Info, and cleanly switch them back off.
 *
 * MWT creates lorebook FILES (loadWorldInfo / saveWorldInfo) but historically
 * never touched any of SillyTavern's activation slots, so ST scanned nothing
 * the tracker wrote until the user enabled each book by hand in the World Info
 * panel. This module is the opt-in write side of that gap; the read side has
 * shipped for a while as the Scope & storage diagnostics tab
 * (`gatherActivationState` / `classifyBookActivation` in
 * diagnostics_panel/scope_storage.js — read its header for the four-slot
 * model this file mirrors).
 *
 * ── Which slot, which book ───────────────────────────────────────────────────
 *   Knowledge book  → the CHAT-BOUND slot (chat_metadata.world_info). ST
 *                     keeps exactly ONE bound book per chat — when the toggle
 *                     is on, MWT claims it, but ONLY when it is empty or
 *                     already holds an MWT book. Never clobbers a user's pick.
 *   State book      → the slot chosen by `stateScope`:
 *       'character' → the card's ADDITIONAL (aux) books
 *                     (world_info.charLore[].extraBooks) via ST's
 *                     charUpdateAddAuxWorld / charSetAuxWorlds. Additive and
 *                     settings-only: no card re-save, no editor DOM, and it
 *                     never fights the card's own primary lorebook. (The
 *                     primary slot — charUpdatePrimaryWorld — re-POSTs the
 *                     whole card through the character editor and strips
 *                     embedded lorebooks on unbind; deliberately NOT used.)
 *       'global'    → the global selection (selected_world_info) via ST's
 *                     updateWorldInfoSettings(), which assigns the array AND
 *                     persists it. Applies to every chat — the UI warns when
 *                     the underlying book is narrower than the slot.
 *       'chat'      → not auto-bound in v1: the single-entry chat slot is
 *                     reserved for the Knowledge book. Skipped with a note.
 *
 * ── The ledger & per-chat ownership ──────────────────────────────────────────
 * Every slot write MWT makes is recorded — the State book's writes in
 * settings.activation ({ chatSlot, global, charAux }) and the Knowledge book's
 * chat-slot claim in the chat's OWN metadata (chatMetadata.mwt_chat_world_info,
 * because that slot itself is per chat) — so removeActivationBindings() undoes
 * exactly OUR writes and nothing else; a foreign book in the same slot is
 * never touched. A slot that merely already holds the desired book is
 * deliberately NOT adopted: without a record of MWT's own write, a later
 * toggle-off must not remove a binding the user made themselves. Pre-marker
 * `chatSlot` shadow entries (written before per-chat markers existed) record
 * a book name but not WHICH chat held it — they are retired on sight, never
 * promoted into ownership and never used to unbind, because acting on a name
 * match alone could remove a binding the user made themselves.
 */

import { getContextSafe, record } from '../core/index.js';

import {
    LOREBOOK_NAME, STATE_LOREBOOK_NAME, PROFILE_LOREBOOK_NAME,
    state,
} from './state.js';
import { getSettings, saveSettings } from './settings.js';
import {
    getLorebookName, getStateLorebookName, getCharacterIdentity, resolveBookNames,
} from './scope.js';

const say = (level, event, detail) =>
    record({ level, module: 'knowledge', event, detail });

// ─── Ledger (settings.activation — the record of OUR slot writes) ────────────

function getLedger() {
    const a = getSettings().activation || {};
    return {
        chatSlot: Array.isArray(a.chatSlot) ? a.chatSlot.filter((n) => typeof n === 'string') : [],
        global: Array.isArray(a.global) ? a.global.filter((n) => typeof n === 'string') : [],
        charAux: (a.charAux && typeof a.charAux === 'object' && !Array.isArray(a.charAux)) ? a.charAux : {},
    };
}

function saveLedger(next) { saveSettings({ activation: next }); }

// ─── Chat-bound slot (chat_metadata.world_info — a single string) ────────────
//
// ST has no exported helper for this slot; its own UI (assignLorebookToChat)
// writes the string then calls saveMetadata(). Unbinding DELETES the key
// rather than writing '' — an empty string would render a blank selected
// option in ST's world list. We mirror both behaviours.

function hasChatMetadata(ctx) {
    return !!ctx && typeof ctx.chatMetadata === 'object' && ctx.chatMetadata !== null;
}

/**
 * Mirror ST's own bind/unbind side effect: the 📌 chat-lorebook button wears
 * `world_set` while the chat has a bound book. ST recomputes this on
 * CHAT_CHANGED, so skipping it is only ever cosmetic and self-heals on the
 * next chat switch — but the icon would otherwise contradict the binding MWT
 * just made for the rest of the current chat. Purely visual and fully
 * guarded: any DOM failure is irrelevant to the binding itself.
 */
function syncChatLorebookButton(bound) {
    try {
        document.querySelectorAll('.chat_lorebook_button')
            .forEach((el) => el.classList.toggle('world_set', !!bound));
    } catch { /* no DOM (tests) or a fork without the button — cosmetic only */ }
}

function readChatSlot(ctx) {
    try {
        const bound = ctx?.chatMetadata?.world_info;
        return (typeof bound === 'string' && bound) ? bound : null;
    } catch { return null; }
}

function writeChatSlot(ctx, name) {
    if (!hasChatMetadata(ctx)) return false;
    // A plain string write, NOT an object patch — do not use setChatMeta()
    // here, it {...}-merges and would corrupt a string-valued key.
    ctx.chatMetadata.world_info = name;
    try { ctx.saveMetadataDebounced?.(); } catch { /* fork without it — value is set */ }
    syncChatLorebookButton(true);
    return true;
}

function clearChatSlot(ctx) {
    if (!hasChatMetadata(ctx)) return false;
    delete ctx.chatMetadata.world_info; // DELETE the key, like ST's own unbind
    try { ctx.saveMetadataDebounced?.(); } catch { /* ignore */ }
    syncChatLorebookButton(false);
    return true;
}

// ─── Chat-slot ownership (per chat, in the chat's OWN metadata) ──────────────
//
// The chat-bound slot is the one activation slot that lives per chat, so
// ownership of it is recorded per chat too: next to the binding we write a
// marker inside the SAME chat's metadata. A single global ledger entry could
// only ever describe one chat — after MWT bound chat A and then chat B, B's
// record replaced A's, and a toggle-off in B stranded A's binding forever
// (active, but no longer ledgered). The marker travels with the chat, so:
//   • a toggle-off cleans the CURRENT chat now and each other chat the next
//     time it is opened (deferred cleanup in applyActivationBindings), and
//   • a slot whose value no longer matches the marker (the user rebound or
//     unbound it by hand) is instantly recognisable as no longer ours.

const CHAT_SLOT_OWNERSHIP_KEY = 'mwt_chat_world_info';

function readSlotOwnership(ctx) {
    try {
        const owned = ctx?.chatMetadata?.[CHAT_SLOT_OWNERSHIP_KEY];
        return (typeof owned === 'string' && owned) ? owned : null;
    } catch { return null; }
}

function writeSlotOwnership(ctx, name) {
    if (!hasChatMetadata(ctx)) return;
    ctx.chatMetadata[CHAT_SLOT_OWNERSHIP_KEY] = name;
    try { ctx.saveMetadataDebounced?.(); } catch { /* ignore */ }
}

function clearSlotOwnership(ctx) {
    if (!hasChatMetadata(ctx)) return;
    delete ctx.chatMetadata[CHAT_SLOT_OWNERSHIP_KEY];
    try { ctx.saveMetadataDebounced?.(); } catch { /* ignore */ }
}

/**
 * Bring the CURRENT chat's ownership marker in line with its slot, retiring
 * the legacy single-entry ledger on first sight. May mutate `ledger.chatSlot`
 * (the legacy array) when its ambiguous entries are dropped.
 *
 * @returns {{ owned: string|null, changed: boolean }} — `owned` is the book
 *   MWT owns in this chat's slot (guaranteed to equal the slot's current
 *   value) once reconciliation is done; `changed` marks any metadata/ledger
 *   write performed.
 */
function reconcileChatSlotOwnership(ctx, ledger) {
    const cur = readChatSlot(ctx);
    let owned = readSlotOwnership(ctx);
    let changed = false;
    if (owned && cur !== owned) {
        // The slot no longer holds the book we bound — the user rebound or
        // unbound it by hand, so our ownership ended the moment they did.
        clearSlotOwnership(ctx);
        owned = null;
        changed = true;
    }
    if (!owned && ledger.chatSlot.length) {
        // Pre-marker shadow ledger: a GLOBAL entry holding only a book name.
        // It cannot prove WHICH chat MWT bound — any chat whose slot happens
        // to hold that name (including one the user bound to the same book
        // by hand) would be claimed, and a later toggle-off would then remove
        // the user's own binding. Per-chat markers are the only authority, so
        // the ambiguous legacy entries are retired here — never converted
        // into ownership.
        ledger.chatSlot = [];
        changed = true;
    }
    return { owned, changed };
}

// ─── Global selection (selected_world_info — exported live array) ────────────
//
// updateWorldInfoSettings(settings, activeArr) is ST's sanctioned setter: it
// assigns the array AND persists it (globalSelect sync + saveSettings). We
// pass `{}` for settings — ST only applies keys present in the object, so an
// empty object means "just set the selection". No export on a fork → skip +
// record; never mutate the array binding directly.

/**
 * Read the global selection as an EXPLICIT readable/error state — the same
 * contract as readAuxBooks(). A value we cannot positively read must never
 * be guessed as "empty": updateWorldInfoSettings() REPLACES the selection
 * wholesale, so addGlobal() acting on a guessed-empty list would hand the
 * setter an array holding only MWT's book and silently drop the user's
 * picks on a compatible fork, while removeGlobal() guessing "absent" would
 * retire ownership of a book that may still be selected. Stock ST always
 * exports selected_world_info as an array (empty when nothing is chosen),
 * so a missing, malformed, or throwing export is an ERROR — unlike
 * charLore, whose mere absence IS stock ST (world_info starts as {}).
 *
 * @returns {{ ok: true, books: string[] } | { ok: false, books: null }}
 */
function readGlobalSelection(wi) {
    try {
        const sel = wi?.selected_world_info;
        if (!Array.isArray(sel)) return { ok: false, books: null };
        return { ok: true, books: sel.filter((n) => typeof n === 'string') };
    } catch { return { ok: false, books: null }; }
}

function globalSetterAvailable(wi) {
    return typeof wi?.updateWorldInfoSettings === 'function';
}

/** @returns {'added'|'already'|'unreadable'|'unavailable'} */
function addGlobal(wi, name) {
    if (!globalSetterAvailable(wi)) return 'unavailable';
    // Fail CLOSED: while the selection cannot be positively read, the
    // setter's whole-array replace cannot be proven safe for the user's
    // picks — write nothing and let the caller skip with a note.
    const cur = readGlobalSelection(wi);
    if (!cur.ok) return 'unreadable';
    if (cur.books.includes(name)) return 'already';
    try { wi.updateWorldInfoSettings({}, [...cur.books, name]); } catch { return 'unavailable'; }
    return 'added';
}

/**
 * Remove one name from the global selection.
 *
 * @returns {'removed'|'absent'|'failed'} — 'removed' when OUR write landed;
 *   'absent' when the selection was READ and positively does not hold the
 *   name (nothing of ours to undo, so the ledger entry may be retired);
 *   'failed' when neither could be established — the setter is missing, the
 *   selection could not be read (missing, malformed, or throwing — a
 *   missing export proves nothing on a fork whose binding may be lazy), or
 *   the setter threw. A 'failed' removal leaves the book globally ACTIVE,
 *   so the caller must retain the ledger entry for a later retry; a boolean
 *   conflating "absent" with "could not remove" is exactly what used to
 *   orphan still-active bindings.
 */
function removeGlobal(wi, name) {
    if (!globalSetterAvailable(wi)) return 'failed';
    // Only a selection we could positively READ can confirm absence — the
    // explicit reader above never guesses an unreadable selection as empty.
    const cur = readGlobalSelection(wi);
    if (!cur.ok) return 'failed';
    if (!cur.books.includes(name)) return 'absent';
    try { wi.updateWorldInfoSettings({}, cur.books.filter((n) => n !== name)); } catch { return 'failed'; }
    return 'removed';
}

// ─── Character additional (aux) books (world_info.charLore[].extraBooks) ──────
//
// ST keys each card's aux list by the avatar filename WITHOUT its extension
// (getCharaFilename: 'mara.png' → 'mara'); charUpdateAddAuxWorld does that
// stripping internally from the avatar key, so callers pass the full avatar.
// charSetAuxWorlds takes the already-stripped fileName. Both exist on ST
// 1.18.0; on a fork without them → skip + record. NEVER fall back to the
// primary slot here (charUpdatePrimaryWorld re-saves the whole card).
//
// readAuxBooks returns an EXPLICIT readable/error state (never a bare array):
// a failed read must not be mistaken for "no books", because removeAuxNames
// REPLACES the card's whole list — guessing empty there would erase every
// user-added binding. When the list reads OK it lets us (a) skip the write
// when the book is already bound — stock ST dedupes via normalizeArray, but a
// fork might not, and the check also avoids arming a pointless debounced
// settings save — and (b) strip only OUR names on unbind, keeping the user's.
// A charLore that is merely MISSING is not a failed read — stock ST starts
// world_info as {} and its own aux setter treats an absent list as empty.

/** Avatar filename with the extension stripped — ST's charLore key. */
const fileNameOfAvatar = (avatarKey) => String(avatarKey ?? '').replace(/\.[^/.]+$/, '');

function auxAvailable(wi) {
    return typeof wi?.charUpdateAddAuxWorld === 'function'
        && typeof wi?.charSetAuxWorlds === 'function';
}

/**
 * Read a card's current aux list as an explicit readable/error state.
 * @returns {{ ok: true, books: string[] } | { ok: false, books: null }} —
 *   `ok:false` when the read threw or the shape is unusable (charLore PRESENT
 *   but not an array, extraBooks corrupt). Callers must treat that as
 *   "unknown", never as "no books". A charLore that is merely missing is
 *   stock SillyTavern (world_info initializes as `{}`, and ST's own aux
 *   setter treats an absent list as empty), so it reads as
 *   `{ ok: true, books: [] }` — flagging it as an error would skip automatic
 *   character binding on every clean installation.
 */
function readAuxBooks(wi, avatarKey) {
    try {
        const charLore = wi?.world_info?.charLore;
        if (charLore === null || charLore === undefined) return { ok: true, books: [] };
        if (!Array.isArray(charLore)) return { ok: false, books: null };
        const entry = charLore.find((e) => e?.name === fileNameOfAvatar(avatarKey));
        if (entry && !Array.isArray(entry.extraBooks)) return { ok: false, books: null };
        return {
            ok: true,
            books: Array.isArray(entry?.extraBooks)
                ? entry.extraBooks.filter((n) => typeof n === 'string')
                : [],
        };
    } catch { return { ok: false, books: null }; }
}

/**
 * @returns {Promise<boolean>} whether the additive write actually succeeded.
 *   charUpdateAddAuxWorld is ASYNC (it persists settings): without the
 *   await, a rejected write sailed past this catch as an unhandled
 *   rejection while the caller recorded the book as applied and owned.
 */
async function addAux(wi, avatarKey, name) {
    try { await wi.charUpdateAddAuxWorld(avatarKey, name); return true; }
    catch { return false; }
}

/**
 * Strip our names from a card's aux list. REPLACES the whole list, so the
 * current list must be read first — and a failed read aborts the strip.
 * @returns {Promise<'removed'|'kept'>} — 'kept' when nothing was written
 *   (unreadable list, or a throwing OR rejecting setter — charSetAuxWorlds
 *   is async, so its promise must be awaited before reporting success); the
 *   caller retains the ledger entry so a later retry still knows what to
 *   undo.
 */
async function removeAuxNames(wi, avatarKey, oursToRemove) {
    const cur = readAuxBooks(wi, avatarKey);
    if (!cur.ok) return 'kept';
    const keep = cur.books.filter((n) => !oursToRemove.includes(n));
    try { await wi.charSetAuxWorlds(fileNameOfAvatar(avatarKey), keep); }
    catch { return 'kept'; }
    return 'removed';
}

/**
 * Drop the aux bindings this card holds from MWT's OWN earlier writes that the
 * current target has superseded, keeping only `keepBook`.
 *
 * Without this the aux list grows without bound in the one combination where
 * the State book's NAME changes but its SLOT does not: lorebook scope 'chat'
 * (a fresh `State Tracker - <chatid>` per chat) with the State target
 * 'character' (one card's aux list). Every chat added another book and left
 * the previous one switched on, so a card slowly accumulated a pile of dead
 * State books that all injected at once. `pruneStaleLedger()` cannot help —
 * it never touches ST, and those names stay "live" because scope.js saves a
 * binding for every chat it ever resolved.
 *
 * Only names the LEDGER holds for this card are removed, so this can never
 * strip the card's own books or a binding the user made by hand — the same
 * ownership rule the rest of the module follows.
 *
 * ASSUMPTION: the State book is the only book MWT binds to the aux slot, so
 * every other ledgered name for this card is a superseded State book. If a
 * second book type is ever bound here, the ledger must start recording which
 * module each name belongs to instead.
 *
 * @returns {Promise<{ changed: boolean, removed: string[] }>} `changed` marks a
 *   ledger edit (the caller owns the save); a failed strip reports
 *   `changed:false` and RETAINS the entries so a later apply retries.
 */
async function pruneSupersededAux(wi, avatarKey, keepBook, ledger) {
    const mine = Array.isArray(ledger.charAux[avatarKey]) ? ledger.charAux[avatarKey] : [];
    const superseded = mine.filter((n) => n !== keepBook);
    if (!superseded.length) return { changed: false, removed: [] };

    if ((await removeAuxNames(wi, avatarKey, superseded)) === 'kept') {
        // Unreadable list or a rejecting setter — the books stay switched on,
        // so their ledger entries must survive for the next attempt.
        say('warn', 'activation_aux_prune_failed', { avatarKey, superseded });
        return { changed: false, removed: [] };
    }

    const kept = mine.filter((n) => n === keepBook);
    const nextCharAux = { ...ledger.charAux };
    // Drop the key entirely when nothing of ours remains (the target book is
    // bound but was the user's own doing, so it was never ledgered).
    if (kept.length) nextCharAux[avatarKey] = kept;
    else delete nextCharAux[avatarKey];
    ledger.charAux = nextCharAux;

    say('info', 'activation_aux_superseded_pruned', { avatarKey, kept: keepBook, removed: superseded });
    return { changed: true, removed: superseded };
}

// ─── apply ───────────────────────────────────────────────────────────────────

/**
 * Switch MWT's lorebooks on in SillyTavern's World Info, per the opt-in
 * settings. Idempotent and no-clobber; safe to call on every chat change —
 * which also makes it the deferred-cleanup pass for the CURRENT chat: a
 * chat-slot binding that outlived a toggle-off made in a DIFFERENT chat is
 * unbound here, the first moment this chat's metadata is writable again.
 *
 * @param {string} reason — diagnostics label ('init' | 'chat change' |
 *   'scope change' | 'settings-save' | …)
 * @param {object} [deps]
 * @param {object} [deps.wi] — the world-info.js namespace (defaults to
 *   state.wiScript, the live export bindings)
 * @param {object} [deps.ctx] — SillyTavern context
 * @returns {Promise<{applied: string[], conflicts: string[], skipped: string[],
 *                    cleaned: string[]}>} human-readable notes; callers surface
 *   conflicts/skips in the status line. `cleaned` holds the deferred
 *   cleanups — slot bindings from previous chats unbound on revisit.
 */
export async function applyActivationBindings(reason = 'apply', {
    wi = state.wiScript,
    ctx = getContextSafe(),
} = {}) {
    const out = { applied: [], conflicts: [], skipped: [], cleaned: [] };

    // world-info.js never loaded (or a fork where the import failed): nothing
    // in this module can work. Fail safe and visibly, never throw.
    if (!wi) {
        say('warn', 'activation_no_wiscript', { reason });
        out.skipped.push('World Info script unavailable — lorebooks not switched on.');
        return out;
    }

    const settings = getSettings();
    const ledger = getLedger();
    let dirty = false;

    // ── Knowledge book → this chat's bound-book slot ────────────────────────
    if (settings.bindKnowledgeToChat) {
        const book = getLorebookName();
        if (!hasChatMetadata(ctx)) {
            say('info', 'activation_skip_kt_no_chat', { reason, book });
            out.skipped.push(`No open chat — "${book}" will be bound on the next chat change.`);
        } else {
            const cur = readChatSlot(ctx);
            const rec = reconcileChatSlotOwnership(ctx, ledger);
            if (rec.changed) dirty = true;

            if (rec.owned) {
                // The ownership marker proves OUR write is in this slot.
                if (cur === book) {
                    // Idempotent re-apply — re-record the shadow only (a
                    // settings reset may have dropped it while the marker,
                    // which lives in the chat's own metadata, survived).
                    if (!ledger.chatSlot.includes(book)) { ledger.chatSlot = [book]; dirty = true; }
                } else if (writeChatSlot(ctx, book)) {
                    // Ours but stale — a scope change renamed the book. Reclaim
                    // the slot MWT owns instead of conflicting with itself.
                    writeSlotOwnership(ctx, book);
                    ledger.chatSlot = [book];
                    dirty = true;
                    say('info', 'activation_chat_slot_reclaimed', { reason, book, previous: cur });
                    out.applied.push(`Knowledge book "${book}" → this chat's World Info slot (replacing MWT's previous "${cur}").`);
                }
            } else if (cur === book) {
                // Already bound, but without the marker it may be the user's
                // own doing. Ownership is recorded ONLY for writes MWT
                // performs, so this is a deliberate no-op: a later toggle-off
                // will not unbind a book MWT never bound.
            } else if (cur) {
                say('warn', 'activation_conflict_chat_slot', { reason, book, current: cur });
                out.conflicts.push(
                    `This chat's World Info slot already holds "${cur}" — not replaced. ` +
                    `Unbind it in the World Info panel (📌 icon) if you want "${book}" there.`
                );
            } else if (writeChatSlot(ctx, book)) {
                writeSlotOwnership(ctx, book);
                ledger.chatSlot = [book];
                dirty = true;
                out.applied.push(`Knowledge book "${book}" → this chat's World Info slot.`);
            }
        }
    } else if (hasChatMetadata(ctx)) {
        // Toggle off: own nothing HERE. This is also the deferred-cleanup pass
        // for a chat whose slot binding outlived a toggle-off that happened
        // while a DIFFERENT chat was open — its metadata was not writable
        // then. reconcileChatSlotOwnership() retires any legacy shadow
        // entries too: they cannot be attributed to THIS chat, so they must
        // never unbind it.
        const rec = reconcileChatSlotOwnership(ctx, ledger);
        if (rec.owned) {
            clearChatSlot(ctx);
            clearSlotOwnership(ctx);
            ledger.chatSlot = [];
            dirty = true;
            say('info', 'activation_deferred_chat_slot_cleanup', { reason, book: rec.owned });
            out.cleaned.push(`Chat World Info slot freed — "${rec.owned}" was bound by MWT and auto-activation is off.`);
        }
        if (rec.changed) dirty = true;
    }

    // ── State book → the slot chosen by stateScope ──────────────────────────
    if (settings.bindStateBook) {
        const book = getStateLorebookName();
        const stateScope = ['global', 'character', 'chat'].includes(settings.stateScope)
            ? settings.stateScope : 'character';

        if (stateScope === 'global') {
            const res = addGlobal(wi, book);
            if (res === 'unavailable') {
                say('warn', 'activation_skip_api_unavailable', { reason, book, api: 'updateWorldInfoSettings' });
                out.skipped.push(`"${book}" not bound — this SillyTavern build lacks the global-selection API.`);
            } else if (res === 'unreadable') {
                // Fail CLOSED: an unreadable selection cannot prove the
                // setter's whole-array replace would keep the user's picks —
                // skip and retry on the next apply rather than risk them.
                say('warn', 'activation_skip_global_unreadable', { reason, book });
                out.skipped.push(`"${book}" not bound — the global World Info selection could not be read, so it was left untouched.`);
            } else if (res === 'added') {
                // Ledger ONLY the writes MWT performed: a book that was
                // already selected may be the user's own doing, and adopting
                // it would make a later toggle-off remove a binding MWT
                // never made.
                ledger.global = [...new Set([...ledger.global, book])];
                dirty = true;
                out.applied.push(`State book "${book}" → global World Info selection.`);
            }
            // res === 'already': nothing was written — record nothing.

        } else if (stateScope === 'character') {
            const idn = getCharacterIdentity();
            const avatarKey = idn?.key?.startsWith('char:') ? idn.key.slice(5) : null;
            if (idn?.isGroup || !avatarKey) {
                // Verified against ST: getCharacterLore() reads
                // characters[this_chid], which is empty for group chats —
                // character slots are inert there, so skipping is correct,
                // not merely conservative.
                say('info', 'activation_skip_state_no_card', { reason, book, group: !!idn?.isGroup });
                out.skipped.push(`"${book}" not bound — ${idn?.isGroup ? 'group chats have no single character card' : 'no character identified'}.`);
            } else if (!auxAvailable(wi)) {
                // NEVER fall back to charUpdatePrimaryWorld (card re-save).
                say('warn', 'activation_skip_aux_unavailable', { reason, book });
                out.skipped.push(`"${book}" not bound — this SillyTavern build lacks the character-books API.`);
            } else {
                const read = readAuxBooks(wi, avatarKey);
                if (!read.ok) {
                    // An unreadable aux list proves nothing — neither "already
                    // bound" nor "safe to add". Skip and retry on the next
                    // apply rather than risk a duplicate on a non-deduping fork.
                    say('warn', 'activation_skip_aux_unreadable', { reason, book });
                    out.skipped.push(`"${book}" not bound — the character's current World Info books could not be read.`);
                } else if (read.books.includes(book)) {
                    // Already bound, but possibly by the user: ownership is
                    // recorded ONLY for writes MWT performs — no adoption, so
                    // a later toggle-off will not strip this binding.
                    // Superseded MWT bindings are still swept: they are ours by
                    // ledger, and this is what heals a card that accumulated
                    // them before the prune existed.
                    const pruned = await pruneSupersededAux(wi, avatarKey, book, ledger);
                    if (pruned.changed) {
                        dirty = true;
                        out.cleaned.push(`Superseded State book(s) "${pruned.removed.join('", "')}" removed from ${idn.name}'s additional World Info books.`);
                    }
                } else if (await addAux(wi, avatarKey, book)) {
                    const mine = ledger.charAux[avatarKey] || [];
                    if (!mine.includes(book)) {
                        ledger.charAux = { ...ledger.charAux, [avatarKey]: [...mine, book] };
                        dirty = true;
                    }
                    out.applied.push(`State book "${book}" → ${idn.name}'s additional World Info books.`);
                    // Retire the previous target now that its replacement is
                    // actually bound — never before, or a failed add would
                    // leave the card with no State book at all.
                    const pruned = await pruneSupersededAux(wi, avatarKey, book, ledger);
                    if (pruned.changed) {
                        dirty = true;
                        out.cleaned.push(`Superseded State book(s) "${pruned.removed.join('", "')}" removed from ${idn.name}'s additional World Info books.`);
                    }
                } else {
                    say('warn', 'activation_skip_aux_write_failed', { reason, book });
                    out.skipped.push(`"${book}" not bound — the character-books API rejected the write.`);
                }
            }

        } else { // stateScope === 'chat' — v1: the slot belongs to Knowledge
            say('info', 'activation_skip_state_chat_scope', { reason, book });
            out.skipped.push(`"${book}" not auto-bound — the chat's World Info slot is single-entry and reserved for the Knowledge book.`);
        }
    }

    if (dirty) saveLedger(ledger);

    // ── Deferred retry for State unbinds that could not complete ────────────
    //
    // removeActivationBindings() deliberately RETAINS a ledger entry whenever
    // it could not prove the binding was gone (setter missing, selection or
    // aux list unreadable, a rejecting setter) — the book is still switched
    // on, so forgetting it would strand it. But that retry had no trigger:
    // the only caller is the settings panel, so a retained entry waited for
    // the user to toggle again. This is its counterpart to the chat slot's
    // deferred cleanup above — with the toggle off, any still-ledgered State
    // binding is retried here, on the next apply (init / chat change / scope
    // change).
    //
    // Runs AFTER the save above so the fresh read below sees this pass's
    // edits, and removeActivationBindings() owns its own ledger write —
    // holding both would have one clobber the other.
    if (!settings.bindStateBook) {
        const pending = getLedger();
        // Only retry what CAN succeed now: a permanently absent API would
        // otherwise re-record the same warn on every chat change forever.
        const retryable = (pending.global.length > 0 && globalSetterAvailable(wi))
            || (Object.keys(pending.charAux).length > 0 && auxAvailable(wi));
        if (retryable) {
            const res = await removeActivationBindings({ chat: false, state: true }, { wi, ctx });
            if (res.removed.length) {
                say('info', 'activation_deferred_state_cleanup', { reason, removed: res.removed.length });
                out.cleaned.push(...res.removed);
            }
        }
    }

    return out;
}

// ─── remove ──────────────────────────────────────────────────────────────────

/**
 * Toggle-off / cleanup. Undoes ONLY what MWT actually wrote: frees THIS chat's
 * slot iff the chat's ownership marker says the binding is ours (legacy
 * pre-marker ledger entries cannot prove which chat MWT bound, so they are
 * retired without touching any slot), drops our names from the global
 * selection, and strips our names from each card's aux books (keeping the
 * card's own and the user's).
 * Then forgets the ledger entries it acted on — and ONLY those: entries it
 * could not act on (global setter missing or throwing, selection unreadable,
 * aux list unreadable, no chat open) are retained for a later retry, and
 * OTHER chats' slot bindings are left to the deferred cleanup in
 * applyActivationBindings(), which runs when each chat is opened.
 *
 * Uses recorded names, never a fresh resolve — after a scope change the
 * current names differ from the ones that were actually bound.
 *
 * @param {{ chat?: boolean, state?: boolean }} [which] — which module's
 *   bindings to remove (default: both)
 * @param {object} [deps]
 * @param {object} [deps.wi] — world-info.js namespace (defaults to state.wiScript)
 * @param {object} [deps.ctx] — SillyTavern context
 * @returns {Promise<{removed: string[]}>} human-readable notes
 */
export async function removeActivationBindings(which = { chat: true, state: true }, {
    wi = state.wiScript,
    ctx = getContextSafe(),
} = {}) {
    const out = { removed: [] };
    const ledger = getLedger();
    let dirty = false;

    // Chat slot needs only the context — works even when wiScript is null.
    if (which.chat) {
        if (hasChatMetadata(ctx)) {
            const cur = readChatSlot(ctx);
            const owned = readSlotOwnership(ctx);
            if (owned) {
                // Free THIS chat's slot only. Every other chat keeps its own
                // ownership marker inside its own metadata (not reachable from
                // here) and is cleaned the next time it is opened — the
                // deferred-cleanup pass in applyActivationBindings().
                if (cur === owned) {
                    clearChatSlot(ctx);
                    out.removed.push(`Chat World Info slot no longer holds "${cur}".`);
                }
                clearSlotOwnership(ctx);
                ledger.chatSlot = [];
                dirty = true;
            } else if (ledger.chatSlot.length) {
                // Legacy pre-marker shadow entry: a GLOBAL record of a book
                // name that cannot prove THIS chat was the one MWT bound —
                // the slot may equally hold the user's own manual binding of
                // the same book. Retire the entry WITHOUT touching the slot;
                // if a pre-marker MWT binding lingers, it is unbound by hand
                // in ST's World Info panel (📌).
                say('info', 'activation_legacy_chatslot_retired', { names: [...ledger.chatSlot] });
                out.removed.push(
                    `Legacy chat-slot ledger entry (${ledger.chatSlot.join(', ')}) discarded without unbinding — ` +
                    'it cannot prove which chat MWT bound.',
                );
                ledger.chatSlot = [];
                dirty = true;
            }
        }
        // No open chat → nothing is reachable now; the per-chat ownership
        // markers drive their own cleanup when each chat is revisited.
    }

    if (which.state) {
        // Drop our names from the global selection. Tri-state: an entry is
        // retired ONLY when the removal succeeded or the selection was READ
        // and positively does not hold the name. A 'failed' removal (setter
        // missing, selection unreadable, setter threw) leaves the book
        // globally active, so its ledger entry must survive for a later
        // retry — the same retention rule as the aux books below.
        if (ledger.global.length) {
            const nextGlobal = [];
            for (const name of ledger.global) {
                const res = removeGlobal(wi, name);
                if (res === 'removed') {
                    out.removed.push(`"${name}" removed from the global World Info selection.`);
                } else if (res === 'failed') {
                    nextGlobal.push(name); // still active — retry on the next remove
                    say('warn', 'activation_global_remove_failed', { name });
                }
                // 'absent': positively confirmed not in the selection — retire.
            }
            if (nextGlobal.length !== ledger.global.length) {
                ledger.global = nextGlobal;
                dirty = true;
            }
        }

        // Strip our names per card. If the aux API is unavailable, or the
        // card's current list cannot be READ, we cannot safely edit charLore —
        // keep those ledger entries so a later retry (API back / list
        // readable) still knows what to undo. A failed read must never be
        // treated as "no books": removeAuxNames REPLACES the whole list, so
        // guessing empty there would erase every user-added binding.
        const nextCharAux = {};
        for (const [avatarKey, names] of Object.entries(ledger.charAux)) {
            if (!Array.isArray(names) || !names.length) continue; // drop empties
            if (!auxAvailable(wi)) { nextCharAux[avatarKey] = names; continue; }
            if ((await removeAuxNames(wi, avatarKey, names)) === 'kept') {
                nextCharAux[avatarKey] = names; // unreadable now — retry later
                continue;
            }
            out.removed.push(`"${names.join('", "')}" removed from a character's additional World Info books.`);
        }
        if (JSON.stringify(nextCharAux) !== JSON.stringify(ledger.charAux)) {
            ledger.charAux = nextCharAux;
            dirty = true;
        }
    }

    if (dirty) saveLedger(ledger);
    return out;
}

// ─── stale prune ─────────────────────────────────────────────────────────────

/**
 * Drop ledger entries whose book the current settings can no longer target —
 * WITHOUT touching ST: a slot may still legitimately hold that book (another
 * scope's chats, a book the user adopted). Callers that want the old book
 * switched off call removeActivationBindings() first; this only stops the
 * ledger from accumulating dead names forever.
 *
 * "Still targetable" is the union of the global book names, EVERY saved
 * binding in settings.bookBindings, and the names the current scope resolves
 * to. The union matters: pruning against only the CURRENT identity would
 * drop every other card's ledger entry in a multi-card character-scope setup
 * (card B's aux binding is very much alive while card A's chat is open).
 *
 * @param {object} [deps]
 * @param {object} [deps.settings] — settings snapshot (defaults to live)
 */
export function pruneStaleLedger({ settings = getSettings() } = {}) {
    const live = new Set([LOREBOOK_NAME, STATE_LOREBOOK_NAME, PROFILE_LOREBOOK_NAME]);
    for (const binding of Object.values(settings.bookBindings || {})) {
        for (const name of Object.values(binding || {})) {
            if (typeof name === 'string' && name) live.add(name);
        }
    }
    // resolveBookNames() may save a first-time binding — the same side effect
    // every getLorebookName() call already performs, so nothing new here.
    for (const name of Object.values(resolveBookNames())) {
        if (typeof name === 'string' && name) live.add(name);
    }

    const ledger = getLedger();
    const next = {
        chatSlot: ledger.chatSlot.filter((n) => live.has(n)),
        global: ledger.global.filter((n) => live.has(n)),
        charAux: Object.fromEntries(
            Object.entries(ledger.charAux)
                .map(([k, v]) => [k, (Array.isArray(v) ? v : []).filter((n) => live.has(n))])
                .filter(([, v]) => v.length),
        ),
    };
    if (JSON.stringify(next) !== JSON.stringify(ledger)) saveLedger(next);
}
