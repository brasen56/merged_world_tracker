/**
 * diagnostics_panel/scope_storage.js — Tab 3: Scope & storage
 * (Diagnostics Phase 8).
 *
 * "Which lorebooks is this chat actually using, and WHY?" (phases doc §II.4
 * Phase 8, design §I.5 Tab 3): the resolved character/chat identity and the
 * current operation epoch, the three lorebook names this scope resolves to
 * with the reason each step of the resolution produced them, the saved
 * bindings, per-book hydration and store versions — and the loud warning when
 * scope silently fell back to the global books (fueled by Phase 3's site-4
 * `scope_fallback_global` counter in the event ring).
 *
 * ── Why resolution is RE-DERIVED, not resolved ───────────────────────────────
 * `knowledge/scope.js resolveBookNames()` is the authoritative resolver, but it
 * is also a WRITER: on first sight of an identity it saves a binding via
 * saveSettings(). The diagnostics panel is read-only by contract (design §I.1,
 * validation baseline §II.6) — opening a tab must never persist a binding.
 * So `explainBookResolution()` (defined in knowledge/scope.js beside the
 * resolver it mirrors, imported here downward and re-exported for established
 * import sites) mirrors resolveBookNames()'s decision tree using only the pure
 * helpers (`deriveBookNames`, `shortHash`) plus a settings SNAPSHOT, and
 * reports which mode production resolution would take — including that a
 * binding WOULD be saved on the next real resolve. The mirror is deliberately
 * kept branch-for-branch so the two cannot drift silently.
 *
 * DOM-free by design (the Phase 6 health.js pattern): the snapshot is a plain
 * object, the markup lives in diagnostics_panel/render.js, every dependency is
 * injectable, and every accessor call is individually guarded — one throwing
 * dependency degrades its own field plus an `errors` note, never the tab.
 *
 * Direct imports throughout for core singletons (NOT via core/index.js): the
 * barrel is aliased to test/stubs/core.js under Vitest, and this module must
 * read the real helpers + version regardless (the barrel→stub alias trap,
 * §II.3). knowledge/* are imported exactly the way index.js's MWT.scope
 * diagnostics reach them, so the tab and the console view one live graph.
 */

import { MWT_VERSION } from '../core/version.js';
import { getEpoch } from '../core/scope.js';
import { getEvents } from '../core/diagnostics.js';
import { getContextSafe } from '../core/context.js';

// The resolution explainer now lives in knowledge/scope.js, beside the
// resolver it mirrors — this tab imports it downward like every other
// consumer (see the file header and the re-export below).
import {
    explainBookResolution,
    getCharacterIdentity,
    getChatIdentity,
} from '../knowledge/scope.js';
import {
    LOREBOOK_NAME, STATE_LOREBOOK_NAME, PROFILE_LOREBOOK_NAME,
    state as knowledgeState,
} from '../knowledge/state.js';
import { getSettings } from '../knowledge/settings.js';
import { peekStore, STORE_VERSION } from '../knowledge/store.js';

// Re-exported from the one-owner home (knowledge/scope.js): the two-book
// read-only resolver and the explainer it builds on live beside
// resolveBookNames(), so backup/recovery.js's fail-closed §5.3 completeness
// guard, Integrity, and this panel all import DOWNWARD — backup/ must not
// reach into a UI module for a knowledge-scope rule the export refuses over.
// Established import sites keep working unchanged.
export { explainBookResolution, resolveKnowledgeBooks } from '../knowledge/scope.js';

// ─── Book specs ───────────────────────────────────────────────────────────────

/**
 * The three books a scope resolves to, in panel order. `hasStore` marks which
 * books carry a `[MWT:store]` entry: the Knowledge and State Tracker books
 * each keep a store inside the book (registry / state registry), while NPC
 * Profiles is plain entries with no store — hydration and store version only
 * exist where a store exists.
 *
 * `injectable` marks which books ST is expected to inject from, and therefore
 * which ones need to be switched on in the World Info panel to do anything.
 * The Knowledge and State Tracker books hold keyworded entries that ST injects
 * when the book is active; NPC Profiles entries carry NO keywords on purpose
 * (see knowledge/lorebook.js), so ST never injects them whether the book is
 * active or not — activation status is meaningless for it.
 */
export const SCOPE_BOOK_SPECS = [
    { id: 'knowledge', label: '🧠 Knowledge Tracker', nameKey: 'knowledge', hasStore: true, injectable: true },
    { id: 'state', label: '📜 State Tracker', nameKey: 'state', hasStore: true, injectable: true },
    { id: 'profiles', label: '👥 NPC Profiles', nameKey: 'profiles', hasStore: false, injectable: false },
];

/** The global (un-scoped) book names, for comparison and labels. */
export const GLOBAL_BOOK_NAMES = {
    knowledge: LOREBOOK_NAME,
    state: STATE_LOREBOOK_NAME,
    profiles: PROFILE_LOREBOOK_NAME,
};

// ─── World-info activation probe (read-only) ──────────────────────────────────
//
// MWT creates the lorebook FILES (loadWorldInfo / saveWorldInfo) but has never
// touched any of SillyTavern's activation slots. ST only scans a book that is
// switched on in one of four places (world-info.js):
//
//   1. Global select      selected_world_info[]                 (applies to all)
//   2. Chat-bound         chat_metadata.world_info              (this chat)
//   3. Character primary  character.data.extensions.world       (this card)
//   4. Character extra    world_info.charLore[…].extraBooks     (this card)
//
// A book that is in none of these is inert: MWT keeps writing entries and ST
// injects nothing, with no error anywhere. That is invisible on 'global' scope
// (the name never changes, so a book switched on once stays on), but 'character'
// and 'chat' scope mint a brand-new book name that is guaranteed inactive on
// creation. This probe reads all four slots so the tab can say, per book,
// whether ST will actually scan it.

/**
 * Read SillyTavern's world-info activation state for the CURRENT chat/character,
 * defensively and READ-ONLY. Every slot is read under its own guard; a fork
 * that lacks one export degrades that slot to "unreadable" rather than throwing.
 *
 * `detectable` means EVERY applicable slot was read. A book that is absent
 * from the readable slots can only be proved inactive when nothing was
 * missed, so as soon as any slot is unreadable (world-info.js not imported
 * yet, a fork without an export, a hostile accessor) the classifier reports
 * such books as 'unknown' rather than risk a false 'inactive'.
 *
 * @param {object} [deps]
 * @param {object} [deps.wiScript] — the world-info.js namespace (live export bindings)
 * @param {object} [deps.ctx] — SillyTavern context
 * @returns {{ detectable: boolean, globalReadable: boolean, chatReadable: boolean,
 *            charReadable: boolean, global: string[], chat: string|null,
 *            charPrimary: string|null, charAdditional: string[], note: string }}
 */
export function gatherActivationState({
    wiScript = knowledgeState?.wiScript,
    ctx = getContextSafe(),
} = {}) {
    const out = {
        detectable: false,
        globalReadable: false, chatReadable: false, charReadable: false,
        global: [], chat: null, charPrimary: null, charAdditional: [],
        note: '',
    };

    // 1. Global select — `selected_world_info` (a live binding on the namespace).
    try {
        const sel = wiScript?.selected_world_info;
        if (Array.isArray(sel)) {
            out.global = sel.filter((n) => typeof n === 'string');
            out.globalReadable = true;
        }
    } catch { /* fork without the export — leave unreadable */ }

    // 2. Chat-bound — `chat_metadata.world_info` (ST's METADATA_KEY === 'world_info').
    //    An open chat always has a chatMetadata object; the key simply being
    //    absent is a definite "not chat-bound", not an unreadable slot.
    try {
        const meta = ctx?.chatMetadata;
        if (meta && typeof meta === 'object') {
            const bound = meta.world_info;
            out.chat = (typeof bound === 'string' && bound) ? bound : null;
            out.chatReadable = true;
        }
    } catch { /* ignore */ }

    // 3 + 4. Character primary + additional — scoped to the CURRENT character.
    try {
        const chid = ctx?.characterId;
        const card = (chid !== null && chid !== undefined && Array.isArray(ctx?.characters))
            ? ctx.characters[chid]
            : null;
        if (card) {
            const primary = card?.data?.extensions?.world;
            out.charPrimary = (typeof primary === 'string' && primary) ? primary : null;
            // charLore keys on the avatar filename WITHOUT its extension — the
            // exact transform ST's getCharaFilename() applies.
            const fileName = String(card?.avatar || '').replace(/\.[^/.]+$/, '');
            const charLore = wiScript?.world_info?.charLore;
            if (fileName && Array.isArray(charLore)) {
                const entry = charLore.find((e) => e?.name === fileName);
                if (entry && Array.isArray(entry.extraBooks)) {
                    out.charAdditional = entry.extraBooks.filter((n) => typeof n === 'string');
                }
            }
            // Readable only NOW: every character source above (primary world,
            // avatar, charLore) has been read without throwing. Setting the
            // flag earlier left it stuck on `true` when a later accessor
            // threw, letting the classifier report a definite 'inactive'
            // from what was actually a partial read.
            out.charReadable = true;
        } else if (ctx && (ctx.groupId === null || ctx.groupId === undefined || ctx.groupId === '')) {
            // Context present, not a group, but no character resolved (no card
            // open): there is simply no character slot to read, which is a
            // definite "not character-bound" — mark it readable so a book that
            // is otherwise absent can be reported 'inactive', not 'unknown'.
            out.charReadable = true;
        }
    } catch { /* ignore */ }

    // Detection needs every slot: absence from the readable ones proves
    // inactivity only when nothing applicable was missed.
    out.detectable = out.globalReadable && out.chatReadable && out.charReadable;
    const unread = [];
    if (!out.globalReadable) unread.push('global selection');
    if (!out.chatReadable) unread.push('chat metadata');
    if (!out.charReadable) unread.push('character books');
    out.note = unread.length
        ? `Could not read: ${unread.join(', ')}. Books absent from the readable slots are reported "unknown", not inactive.`
        : 'All four world-info activation slots read successfully.';
    return out;
}

/**
 * Classify one resolved book name against the gathered activation state.
 *
 * @param {string} name — the resolved book name
 * @param {ReturnType<typeof gatherActivationState>} active
 * @param {{ injectable?: boolean }} [opts]
 * @returns {{ active: 'yes'|'no'|'unknown'|'n/a', activeIn: string[], note: string }}
 */
export function classifyBookActivation(name, active, { injectable = true } = {}) {
    if (injectable === false) {
        return {
            active: 'n/a',
            activeIn: [],
            note: 'Never injected — its entries carry no keywords, so World Info activation does not apply.',
        };
    }
    if (!name || name === '(unresolved)') {
        return { active: 'unknown', activeIn: [], note: 'Book name unresolved.' };
    }
    const a = active || {};
    const activeIn = [];
    if (Array.isArray(a.global) && a.global.includes(name)) activeIn.push('global selection');
    if (a.chat === name) activeIn.push('chat-bound');
    if (a.charPrimary === name) activeIn.push('character (primary)');
    if (Array.isArray(a.charAdditional) && a.charAdditional.includes(name)) activeIn.push('character (additional)');

    if (activeIn.length) {
        return { active: 'yes', activeIn, note: `ST will scan this book — switched on via ${activeIn.join(', ')}.` };
    }
    // Absence proves inactivity only when EVERY applicable slot was read: the
    // book may be active in a slot that could not be inspected, so a partial
    // read reports 'unknown' — never a false 'no'.
    const unread = [];
    if (!a.globalReadable) unread.push('global selection');
    if (!a.chatReadable) unread.push('chat');
    if (!a.charReadable) unread.push('character');
    if (unread.length) {
        return {
            active: 'unknown',
            activeIn: [],
            note: `Not found in the readable slots, but could not read: ${unread.join(', ')} — activation cannot be ruled out.`,
        };
    }
    return {
        active: 'no',
        activeIn: [],
        note: 'Not switched on in any World Info slot — ST will NOT inject its entries.',
    };
}

// ─── Snapshot collector ───────────────────────────────────────────────────────

/**
 * Collect the Scope & storage snapshot (DOM-free, side-effect-free).
 *
 * @param {object} [deps] — every dependency injectable for the Node suite
 * @param {object} [deps.scopeApi] — { getCharacterIdentity, getChatIdentity }
 * @param {object} [deps.storeApi] — { peekStore }
 * @param {object} [deps.activationApi] — { gather } → gatherActivationState()
 * @param {function(): object} [deps.getKnowledgeSettings]
 * @param {function(): number} [deps.epoch]
 * @param {function(object=): object[]} [deps.events] — core/diagnostics getEvents
 * @param {string} [deps.version]
 * @param {number} [deps.currentStoreVersion]
 * @param {function(): number} [deps.now]
 * @returns {{generatedAt: number, mwtVersion: string, epoch: number,
 *   scopeSetting: {value: string, valid: boolean}, character: object|null,
 *   chat: object|null, resolution: object, books: Array<object>,
 *   activation: {detectable: boolean, globalReadable: boolean, chatReadable: boolean,
 *     charReadable: boolean, globalCount: number, note: string},
 *   bindings: {count: number, rows: Array<object>},
 *   fallbackEvents: {count: number, last: object|null},
 *   bannerLevel: 'ok'|'warn'|'fail', warnings: Array<object>,
 *   errors?: string[]}}
 */
export function collectScopeSnapshot({
    scopeApi = { getCharacterIdentity, getChatIdentity },
    storeApi = { peekStore },
    activationApi = { gather: gatherActivationState },
    getKnowledgeSettings = getSettings,
    epoch = getEpoch,
    events = getEvents,
    version = MWT_VERSION,
    currentStoreVersion = STORE_VERSION,
    now = Date.now,
} = {}) {
    const errors = [];
    // Per-field guard (health.js pattern): one throwing accessor degrades its
    // own field and notes the failure — the tab must never blank.
    const call = (label, fn, fallback) => {
        try {
            const v = fn();
            return v === undefined ? fallback : v;
        } catch (err) {
            errors.push(`${label}: ${String(err?.message || err)}`);
            return fallback;
        }
    };

    // Settings snapshot — read ONCE, never written back. The read-only rule is
    // structural here: no saveSettings reference even exists in this module.
    const settings = call('settings', () => getKnowledgeSettings() || {}, {});
    const rawScope = settings?.scope;
    const bindings = (settings?.bookBindings && typeof settings.bookBindings === 'object')
        ? settings.bookBindings
        : {};

    const character = call('characterIdentity', () => scopeApi.getCharacterIdentity?.() ?? null, null);
    const chat = call('chatIdentity', () => scopeApi.getChatIdentity?.() ?? null, null);

    const resolution = call('resolution', () => explainBookResolution({
        scope: rawScope, character, chat, bindings,
    }), null) ?? {
        scope: 'global',
        valid: true,
        mode: 'global',
        identityKey: null,
        identityName: null,
        books: { ...GLOBAL_BOOK_NAMES },
        note: '(resolution explainer failed — see errors)',
        wouldSaveBinding: false,
    };

    // Books — hydration + store version per resolved name, via the read-only
    // peek. peekStore() distinguishes two states the tab must NOT conflate:
    //   null       → no cache slot at all: hydration has not been ATTEMPTED for
    //                this name. hydrateBook() creates the slot synchronously
    //                before its first await, so "no slot" can only mean
    //                not-yet-tried — normal early in a session, and guaranteed
    //                right after resetStoreCache() clears the cache on a chat
    //                change (knowledge/index.js reloadStores is fire-and-forget
    //                while index.js re-renders an open modal synchronously).
    //   { hydrated: false } → the slot exists and the load FAILED (no
    //                world-info.js, a load error, corrupt JSON). This is the
    //                state assertHydrated() blocks writes on.
    // Only the second is a fault. Reporting the first in red would paint
    // "writes are blocked" over a panel that is simply early.
    //
    // Activation is read ONCE for all three books — the four World Info slots
    // (see gatherActivationState) are the same regardless of which book we ask
    // about. Guarded like every other accessor so a probe failure degrades to
    // an undetectable state, never a blank tab.
    const activation = call('activation', () => activationApi.gather?.() ?? null, null) ?? {
        detectable: false, globalReadable: false, chatReadable: false, charReadable: false,
        global: [], chat: null, charPrimary: null, charAdditional: [],
        note: '(activation probe failed — see errors)',
    };

    const books = SCOPE_BOOK_SPECS.map((spec) => {
        const name = resolution.books?.[spec.nameKey];
        const peek = (spec.hasStore && name)
            ? call(`peekStore:${spec.id}`, () => storeApi.peekStore?.(name) ?? null, null)
            : null;
        const storeState = !spec.hasStore
            ? 'no-store'
            : (peek === null || peek === undefined
                ? 'not-attempted'
                : (peek.hydrated === true ? 'loaded' : 'failed'));
        const act = call(`activation:${spec.id}`,
            () => classifyBookActivation(name ?? '(unresolved)', activation, { injectable: spec.injectable !== false }),
            { active: 'unknown', activeIn: [], note: '' });
        return {
            id: spec.id,
            label: spec.label,
            name: name ?? '(unresolved)',
            hasStore: spec.hasStore,
            injectable: spec.injectable !== false,
            storeState,
            hydrated: peek?.hydrated === true,
            dirty: peek?.dirty === true,
            // A FAILED slot's `version` is the blank placeholder's — hydrateBook
            // never adopts a blocked source into the cache — so an on-disk v99
            // store would render "v1" beside its load-failed badge. The slot
            // preserves the version observed on disk at the failure
            // (peekStore's observedVersion, null when it could not be read);
            // that — or null — is what a failed book reports, matching the §9.1
            // schema-status collector so the two tables can never disagree.
            storeVersion: peek !== null && peek.hydrated !== true
                ? (typeof peek.observedVersion === 'number' ? peek.observedVersion : null)
                : (typeof peek?.version === 'number' ? peek.version : null),
            currentStoreVersion,
            active: act.active,
            activeIn: Array.isArray(act.activeIn) ? act.activeIn : [],
            activeNote: act.note ?? '',
        };
    });

    // Saved bindings — one row per stable identity key ever bound.
    const bindingRows = Object.entries(bindings)
        .map(([key, v]) => ({
            key,
            knowledge: v?.knowledge ?? null,
            state: v?.state ?? null,
            profiles: v?.profiles ?? null,
            isCurrent: key === resolution.identityKey,
        }));
    const bindingsInfo = { count: bindingRows.length, rows: bindingRows };

    // Phase 3's site-4 counter, read from the event ring: every
    // scope_fallback_global warn this session, newest first. The live
    // resolution above says what would happen NOW; these say what already DID
    // — including fallbacks on chats the user has since switched away from.
    const knowledgeEvents = call('events', () => events({ module: 'knowledge' }) || [], []);
    const fallbacks = (Array.isArray(knowledgeEvents) ? knowledgeEvents : [])
        .filter((e) => e?.event === 'scope_fallback_global');
    const fallbackEvents = {
        count: fallbacks.length,
        last: fallbacks[0]
            ? {
                ts: fallbacks[0].ts ?? null,
                epoch: fallbacks[0].epoch ?? null,
                scopeKey: fallbacks[0].scopeKey ?? null,
                scope: fallbacks[0].detail?.scope ?? null,
            }
            : null,
    };

    // Warnings drive the pane banner. Levels: 'fail' renders red (the state a
    // tester must act on), 'warn' amber (safe-but-silent recoveries this tab
    // exists to surface). Absence of both → the quiet 'ok' footnote.
    const warnings = [];
    if (resolution.mode === 'fallback-global') {
        warnings.push({
            id: 'scope-fallback-live',
            level: 'warn',
            text: `Scope is "${resolution.scope}" but the current ${resolution.scope} could not be identified — this chat is using the GLOBAL lorebooks right now. The classic "why is my data weird across chats" cause.`,
        });
    }
    if (resolution.mode === 'sanitize-fallback-global') {
        warnings.push({
            id: 'scope-name-unusable',
            level: 'warn',
            text: `This ${resolution.scope}'s name sanitises to nothing usable in a lorebook filename — the GLOBAL books are in use, deliberately unbound.`,
        });
    }
    if (fallbackEvents.count > 0) {
        const last = fallbackEvents.last;
        warnings.push({
            id: 'scope-fallback-events',
            level: 'warn',
            text: `Scope fell back to the global books ${fallbackEvents.count}× this session (scope_fallback_global warns)${last?.epoch != null ? ` — last at epoch ${last.epoch}` : ''}${last?.ts != null ? `, ${new Date(last.ts).toLocaleTimeString()}` : ''}. Check the identity rows below for which lookup came back absent.`,
        });
    }
    if (resolution.valid === false) {
        warnings.push({
            id: 'scope-setting-invalid',
            level: 'warn',
            text: `The Knowledge scope setting is invalid ("${String(rawScope)}") and is being treated as 'global'.`,
        });
    }
    // The Knowledge store gets TWO distinct findings, because "not loaded"
    // has two very different causes (see the storeState comment above).
    const knowledgeBook = books.find((b) => b.id === 'knowledge');
    if (knowledgeBook?.storeState === 'failed') {
        warnings.push({
            id: 'knowledge-store-load-failed',
            level: 'fail',
            text: `The Knowledge store for "${knowledgeBook.name}" was loaded and FAILED, so creating entries is blocked (deliberate — it prevents duplicate entries). Look for an earlier store-load error in the console: a missing world-info.js, an unreadable book, or corrupt store JSON.`,
        });
    } else if (knowledgeBook?.storeState === 'not-attempted') {
        warnings.push({
            id: 'knowledge-store-not-attempted',
            level: 'warn',
            text: `The Knowledge store for "${knowledgeBook.name}" has not been loaded yet this session. Hydration runs on chat change and is asynchronous, so this is expected right after a reload or a chat switch — re-open this tab in a moment. If it persists, writes stay blocked and the console will carry the reason.`,
        });
    }

    const mismatched = books.filter((b) => b.hasStore && b.hydrated && b.storeVersion != null && b.storeVersion !== currentStoreVersion);
    if (mismatched.length > 0) {
        warnings.push({
            id: 'store-version-mismatch',
            level: 'warn',
            text: `Store version mismatch: ${mismatched.map((b) => `"${b.name}" is v${b.storeVersion}, code expects v${b.currentStoreVersion}`).join('; ')}. Data still reads; a migration is pending.`,
        });
    }

    // World Info activation — the silent-injection gap. MWT creates a book file
    // but never switches it on in ST; an inactive injectable book means the
    // tracker keeps writing and ST scans nothing, with no error. The Knowledge
    // book is the documented keyword-injection path, so an inactive one is
    // always worth surfacing. The State book is user-created, so only flag it
    // once its store is loaded (the book is real and MWT is using it) — that
    // avoids a false alarm for users who never set up state trackers.
    if (knowledgeBook?.injectable && knowledgeBook.active === 'no') {
        warnings.push({
            id: 'knowledge-book-inactive',
            level: 'warn',
            text: `The Knowledge Tracker book "${knowledgeBook.name}" is NOT switched on in SillyTavern's World Info — not in the global selection, this chat's bound book, or the character's books. MWT keeps writing NPC entries to it, but ST will not inject them until the book is activated. Enable it in the World Info panel, or turn on "Switch the Knowledge Tracker lorebook on automatically" in Knowledge → Settings and MWT will claim this chat's slot itself (per-character and per-chat scope each mint a new book that starts inactive).`,
        });
    }
    const stateBook = books.find((b) => b.id === 'state');
    if (stateBook?.injectable && stateBook.active === 'no' && stateBook.storeState === 'loaded') {
        warnings.push({
            id: 'state-book-inactive',
            level: 'warn',
            text: `The State Tracker book "${stateBook.name}" is NOT switched on in SillyTavern's World Info. MWT still updates its tracker entries, but ST will not inject them until the book is activated in the World Info panel, or you turn on the State Tracker auto-activation toggle in Knowledge → Settings.`,
        });
    }

    const bannerLevel = warnings.some((w) => w.level === 'fail')
        ? 'fail'
        : (warnings.length > 0 ? 'warn' : 'ok');

    return {
        generatedAt: now(),
        mwtVersion: version,
        // Guarded like every other accessor: getEpoch() is trivial today, but
        // the collector's contract is that NO single dependency can blank the
        // tab, and an unguarded call in the return statement is exactly the
        // hole that let a hostile getter take down the Environment snapshot.
        epoch: call('epoch', () => (typeof epoch === 'function' ? epoch() : null), null),
        scopeSetting: { value: resolution.scope, valid: resolution.valid === true },
        character,
        chat,
        resolution,
        books,
        activation: {
            detectable: activation.detectable === true,
            globalReadable: activation.globalReadable === true,
            chatReadable: activation.chatReadable === true,
            charReadable: activation.charReadable === true,
            globalCount: Array.isArray(activation.global) ? activation.global.length : 0,
            note: activation.note ?? '',
        },
        bindings: bindingsInfo,
        fallbackEvents,
        bannerLevel,
        warnings,
        ...(errors.length ? { errors } : {}),
    };
}
