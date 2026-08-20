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
 * So `explainBookResolution()` mirrors resolveBookNames()'s decision tree using
 * only the pure helpers (`deriveBookNames`, `shortHash`) plus a settings
 * SNAPSHOT, and reports which mode production resolution would take —
 * including that a binding WOULD be saved on the next real resolve. The mirror
 * is deliberately kept branch-for-branch so the two cannot drift silently.
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

import {
    SCOPES,
    deriveBookNames,
    shortHash,
    getCharacterIdentity,
    getChatIdentity,
} from '../knowledge/scope.js';
import {
    LOREBOOK_NAME, STATE_LOREBOOK_NAME, PROFILE_LOREBOOK_NAME,
} from '../knowledge/state.js';
import { getSettings } from '../knowledge/settings.js';
import { peekStore, STORE_VERSION } from '../knowledge/store.js';

// ─── Book specs ───────────────────────────────────────────────────────────────

/**
 * The three books a scope resolves to, in panel order. `hasStore` marks which
 * books carry a `[MWT:store]` entry: the Knowledge and State Tracker books
 * each keep a store inside the book (registry / state registry), while NPC
 * Profiles is plain entries with no store — hydration and store version only
 * exist where a store exists.
 */
export const SCOPE_BOOK_SPECS = [
    { id: 'knowledge', label: '🧠 Knowledge Tracker', nameKey: 'knowledge', hasStore: true },
    { id: 'state', label: '📜 State Tracker', nameKey: 'state', hasStore: true },
    { id: 'profiles', label: '👥 NPC Profiles', nameKey: 'profiles', hasStore: false },
];

/** The global (un-scoped) book names, for comparison and labels. */
export const GLOBAL_BOOK_NAMES = {
    knowledge: LOREBOOK_NAME,
    state: STATE_LOREBOOK_NAME,
    profiles: PROFILE_LOREBOOK_NAME,
};

// ─── Resolution explainer (the read-only mirror of resolveBookNames) ──────────

/**
 * Explain which lorebook names the current scope resolves to, and why —
 * WITHOUT resolving: no binding is saved, nothing is persisted (see the file
 * header). Branch-for-branch mirror of knowledge/scope.js resolveBookNames().
 *
 * @param {object} [parts]
 * @param {string} [parts.scope] — the raw `scope` setting value
 * @param {{ key: string, name: string, isGroup?: boolean }|null} [parts.character]
 * @param {{ key: string, name: string }|null} [parts.chat]
 * @param {object} [parts.bindings] — settings.bookBindings snapshot
 * @param {function(string|null): object} [parts.derive] — deriveBookNames (injectable)
 * @param {function(string): string} [parts.hash] — shortHash (injectable)
 * @returns {{ scope: string, valid: boolean, mode: string, identityKey: string|null,
 *            identityName: string|null, books: {knowledge: string, state: string,
 *            profiles: string}, note: string, wouldSaveBinding: boolean }}
 */
export function explainBookResolution({
    scope,
    character = null,
    chat = null,
    bindings = {},
    derive = deriveBookNames,
    hash = shortHash,
} = {}) {
    const valid = SCOPES.includes(scope);
    const normalized = valid ? scope : 'global';

    if (!valid) {
        return {
            scope: normalized,
            valid: false,
            mode: 'global',
            identityKey: null,
            identityName: null,
            books: derive(null),
            note: `Scope setting "${String(scope)}" is not one of global|character|chat — resolveBookNames() treats it as 'global' (the safe fallback). Fix it in Knowledge → Settings.`,
            wouldSaveBinding: false,
        };
    }

    if (normalized === 'global') {
        return {
            scope: normalized,
            valid: true,
            mode: 'global',
            identityKey: null,
            identityName: null,
            books: derive(null),
            note: "Scope is 'global' — one shared set of books for every chat and character (the legacy behaviour, and the default).",
            wouldSaveBinding: false,
        };
    }

    const identity = normalized === 'chat' ? chat : character;
    if (!identity) {
        return {
            scope: normalized,
            valid: true,
            mode: 'fallback-global',
            identityKey: null,
            identityName: null,
            books: derive(null),
            note: `Scope is "${normalized}" but the current ${normalized} could not be identified — resolveBookNames() silently falls back to the GLOBAL books (Phase 3 site 4). Everything keeps working, but data lands in the SHARED books instead of this ${normalized}'s own.`,
            wouldSaveBinding: false,
        };
    }

    const existing = bindings[identity.key];
    if (existing?.knowledge && existing?.state && existing?.profiles) {
        return {
            scope: normalized,
            valid: true,
            mode: 'saved-binding',
            identityKey: identity.key,
            identityName: identity.name ?? null,
            books: { knowledge: existing.knowledge, state: existing.state, profiles: existing.profiles },
            note: `Identity ${identity.key} has a saved binding — the books were resolved when this ${normalized} was first seen and survive a card rename (bindings key on the stable identity, never the display name).`,
            wouldSaveBinding: false,
        };
    }

    let names = derive(identity.name);

    // A name that sanitises to nothing (e.g. a card called "???") would collide
    // with the global books. resolveBookNames() falls back explicitly rather
    // than silently sharing — and deliberately does NOT bind, so the global
    // names are used until the identity becomes nameable.
    if (names.knowledge === LOREBOOK_NAME) {
        return {
            scope: normalized,
            valid: true,
            mode: 'sanitize-fallback-global',
            identityKey: identity.key,
            identityName: identity.name ?? null,
            books: names,
            note: `"${identity.name}" sanitises to nothing usable in a lorebook filename, so resolveBookNames() uses the GLOBAL books for this ${normalized} — deliberately unbound (a binding would collide with the global names).`,
            wouldSaveBinding: false,
        };
    }

    // Two different cards can share a display name; both would derive the same
    // book name and silently share one book. resolveBookNames() disambiguates
    // with a stable discriminator drawn from the identity key.
    const takenByOthers = new Set(
        Object.entries(bindings)
            .filter(([key]) => key !== identity.key)
            .map(([, value]) => value?.knowledge)
            .filter(Boolean)
    );
    if (takenByOthers.has(names.knowledge)) {
        names = derive(`${identity.name} (${hash(identity.key)})`);
        return {
            scope: normalized,
            valid: true,
            mode: 'collision-disambiguated',
            identityKey: identity.key,
            identityName: identity.name ?? null,
            books: names,
            note: `"${identity.name}" collides with another binding's book name — resolveBookNames() appends a stable discriminator from the identity key, so this card gets its own books despite the shared display name.`,
            wouldSaveBinding: true,
        };
    }

    return {
        scope: normalized,
        valid: true,
        mode: 'newly-derived',
        identityKey: identity.key,
        identityName: identity.name ?? null,
        books: names,
        note: `No binding saved for ${identity.key} yet — these book names are what the next resolve will derive from "${identity.name}" and SAVE. This tab derives them read-only: nothing was persisted by looking.`,
        wouldSaveBinding: true,
    };
}

// ─── Snapshot collector ───────────────────────────────────────────────────────

/**
 * Collect the Scope & storage snapshot (DOM-free, side-effect-free).
 *
 * @param {object} [deps] — every dependency injectable for the Node suite
 * @param {object} [deps.scopeApi] — { getCharacterIdentity, getChatIdentity }
 * @param {object} [deps.storeApi] — { peekStore }
 * @param {function(): object} [deps.getKnowledgeSettings]
 * @param {function(): number} [deps.epoch]
 * @param {function(object=): object[]} [deps.events] — core/diagnostics getEvents
 * @param {string} [deps.version]
 * @param {number} [deps.currentStoreVersion]
 * @param {function(): number} [deps.now]
 * @returns {{generatedAt: number, mwtVersion: string, epoch: number,
 *   scopeSetting: {value: string, valid: boolean}, character: object|null,
 *   chat: object|null, resolution: object, books: Array<object>,
 *   bindings: {count: number, rows: Array<object>},
 *   fallbackEvents: {count: number, last: object|null},
 *   bannerLevel: 'ok'|'warn'|'fail', warnings: Array<object>,
 *   errors?: string[]}}
 */
export function collectScopeSnapshot({
    scopeApi = { getCharacterIdentity, getChatIdentity },
    storeApi = { peekStore },
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
        return {
            id: spec.id,
            label: spec.label,
            name: name ?? '(unresolved)',
            hasStore: spec.hasStore,
            storeState,
            hydrated: peek?.hydrated === true,
            dirty: peek?.dirty === true,
            storeVersion: typeof peek?.version === 'number' ? peek.version : null,
            currentStoreVersion,
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
        bindings: bindingsInfo,
        fallbackEvents,
        bannerLevel,
        warnings,
        ...(errors.length ? { errors } : {}),
    };
}
