/**
 * core/schema_status.js — The visible paused-state surface (design §5.4) and
 * the schema diagnostic events (§9.3) of SCHEMA_VALIDATION_MIGRATIONS_PLAN.md.
 *
 * Part 5. A store that cannot be prepared blocks ONLY its own module, and that
 * block must never read as ordinary inactivity. This module is the ONE owner
 * of that state, so every surface reads the same reason and the surfaces can
 * never disagree:
 *
 *   - the affected module's own tab renders renderPausedStoresBanner() — a red
 *     banner with a Retry action and the recovery export (§5.4: "offers
 *     recovery export and a Retry action"; the Diagnostics panel is read-only
 *     by contract, so the ACTION lives in the module's tab, never there);
 *   - 🗂️ Scope & storage and ❤️ Health read getPauseState()/getPausedStores()
 *     and show the same message (design §9.1);
 *   - ONE user notification per chat/scope — never repeated toasts (§5.4).
 *
 * The registry is in-memory and session-scoped, exactly like the diagnostics
 * ring: a pause is derived state (the store on disk is untouched — that is the
 * point of pausing), so it is re-derived on every load rather than persisted.
 *
 * Purity is orchestration-level, not schema-level: this module deliberately
 * imports the diagnostics ring, the toast helper, and the scope resolver — the
 * things design §3.1 keeps OUT of the pure schema engine — because events,
 * notifications, and banners are orchestration. It must never be imported from
 * core/schema.js, core/quarantine.js, schema/*, or a module schema.
 *
 * Who calls pauseStore(): the preparation paths that can block a store. Today
 * that is Knowledge lorebook hydration (knowledge/store.js hydrateBook()) and
 * the Part 6 runtime chat-metadata gate (schema/runtime.js). resumeStore() is
 * called by the same paths when a later load clears the block, and by
 * retryStore() when a Retry handler succeeds.
 *
 * Part 6 also added the DECLINE checks every consumer asks of this registry —
 * isStorePausedForCurrentScope() / isModulePausedForCurrentScope() (events,
 * injection, generation) and isStoreWriteBlocked() (write seams) — plus the
 * §7.5 privileged-preparation window that lets the runtime gate's conversion
 * write pass the very pause it exists to clear.
 */

import { record } from './diagnostics.js';
import { notify } from './notifications.js';
import { getChatIdentity, getEpoch } from './scope.js';
import { escapeHtml } from './diff.js';
import { ISSUE_SEVERITIES } from './schema.js';

// ─── Store ↔ module mapping (the one shared mapping) ─────────────────────────
//
// Store ids are the schema/registry.js keys; module ids are the Health-tab /
// API-telemetry keys (HEALTH_MODULE_SPECS ids, underscore-spelled). The main
// modal's TABS ids are the hyphen spellings of the same ids; every consumer
// normalises via moduleId() so the two spellings cannot fork the mapping.

/** Registered store id → owning module id. */
export const STORE_MODULE_IDS = Object.freeze({
    worldState: 'world_state',
    chronicle: 'chronicle',
    knowledgeEvidence: 'knowledge',
    knowledgeCounters: 'knowledge',
    knowledgeStore: 'knowledge',
    storyPlanner: 'story_planner',
    interiority: 'interiority',
});

/** Owning module id → every registered store id that module owns. */
export const MODULE_STORE_IDS = Object.freeze(
    Object.entries(STORE_MODULE_IDS).reduce((acc, [storeId, modId]) => {
        (acc[modId] ??= []).push(storeId);
        return acc;
    }, {}),
);

/** Display labels for the module ids (banner + Health wording). */
export const MODULE_LABELS = Object.freeze({
    world_state: 'World State',
    chronicle: 'Chronicle',
    knowledge: 'Knowledge',
    story_planner: 'Story Planner',
    interiority: 'Interiority',
});

/**
 * Canonicalise a module id: the Health/API spelling ('world_state') and the
 * main-modal tab spelling ('world-state') are the same module.
 *
 * @param {string} id
 * @returns {string}
 */
export function moduleId(id) {
    return String(id ?? '').replace(/-/g, '_');
}

// ─── Schema diagnostic events (design §9.3) ──────────────────────────────────

/**
 * The Part 5 event names. Details carry store/version/count/error-class
 * metadata, never user prose — recordSchemaEvent() enforces that with an
 * allowlist, because a detail object assembled at a rejection site is one
 * refactor away from carrying the rejected record itself.
 */
export const SCHEMA_DIAGNOSTIC_EVENTS = Object.freeze({
    MIGRATED: 'schema_migrated',
    REPAIRED: 'schema_repaired',
    QUARANTINED: 'schema_quarantined',
    BLOCKED_FUTURE_VERSION: 'schema_blocked_future_version',
    MIGRATION_FAILED: 'schema_migration_failed',
    PERSIST_FAILED: 'schema_persist_failed',
    STORE_PAUSED: 'schema_store_paused',
    STORE_RESUMED: 'schema_store_resumed',
    QUARANTINE_CLEARED: 'schema_quarantine_cleared',
    // Part 7 (§2.2): a stored SETTINGS record was unreadable and its module
    // fell back to defaults (settings fail open — nothing is paused).
    SETTINGS_INVALID: 'schema_settings_invalid',
});

/**
 * The only detail fields a schema event may carry (§9.3: "store/version/count/
 * error-class metadata, not user prose"). `book` is a lorebook NAME — the same
 * identity class the Scope & storage tab displays. Everything else a caller
 * passes is dropped on the floor.
 */
const EVENT_DETAIL_ALLOWLIST = Object.freeze([
    'store', 'book', 'version', 'fromVersion', 'toVersion', 'count',
    'code', 'reasonCode', 'via', 'reason',
]);

/**
 * Record one schema diagnostic event with a content-safe detail. Never throws
 * (the record() contract): a diagnostics failure must never break the feature
 * it observes.
 *
 * @param {string} event — one of SCHEMA_DIAGNOSTIC_EVENTS
 * @param {object} [detail] — allowlisted fields only; extras are dropped
 * @param {{ level?: string, module?: string }} [options]
 * @returns {void}
 */
export function recordSchemaEvent(event, detail = {}, { level = 'info', module = 'schema' } = {}) {
    const safe = {};
    for (const key of EVENT_DETAIL_ALLOWLIST) {
        const value = detail?.[key];
        if (value === undefined || value === null) continue;
        safe[key] = typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
    }
    try {
        record({ level, module, event, detail: safe });
    } catch { /* never block the caller */ }
}

/**
 * Map a validation issue's SEVERITY to the §9.3 event that describes what
 * actually happened to the data.
 *
 * Part 7's secondary-persistence seams (core/ui.js float positions,
 * knowledge/lorebook.js edit history) report findings straight from the shared
 * core/schema.js vocabulary, where the severities do NOT all mean the same
 * thing to a reader of the Log tab:
 *
 *   - QUARANTINE — the record was dropped from the live view and the raw value
 *     is preserved (for these stores the untouched storage key IS the recovery
 *     copy), so `schema_quarantined` is exactly right;
 *   - FATAL — an unreadable ROOT: the whole record is dropped from the live
 *     view with the raw left in storage. Same contract, same event;
 *   - REFERENCE — structurally valid but dangling, and RETAINED. Reporting this
 *     as `schema_quarantined` would tell the user data was set aside for
 *     recovery when nothing was removed at all, so it reports as
 *     `schema_repaired`: a finding was recorded, the data is still there.
 *     (The same catch-all core/settings.js eventForIssueCode() applies.)
 *
 * @param {string} severity — an ISSUE_SEVERITIES value
 * @returns {string} a SCHEMA_DIAGNOSTIC_EVENTS value
 */
export function schemaEventForSeverity(severity) {
    if (severity === ISSUE_SEVERITIES.QUARANTINE || severity === ISSUE_SEVERITIES.FATAL) {
        return SCHEMA_DIAGNOSTIC_EVENTS.QUARANTINED;
    }
    return SCHEMA_DIAGNOSTIC_EVENTS.REPAIRED;
}

// ─── The paused-state registry ───────────────────────────────────────────────
// Module-level singleton state (the core/scope.js _epoch pattern). Cleared on
// page reload; reset between tests via _resetPausedStores().

/**
 * @type {Map<string, {
 *   store: string, module: string|null, reasonCode: string, message: string,
 *   scopeKey: string, since: number, version: number|null, count: number|null,
 * }>}
 */
const _paused = new Map();

/** `${store}::${scopeKey}` pairs that already fired their one notification. */
const _notifiedScopes = new Set();

/** Retry handlers per store id — the Part 6 seam (and Knowledge's today). */
const _retryHandlers = new Map();

/**
 * The scope dimension of "one notification per chat/scope". Chat identity key
 * when the build can identify the chat; the character/group key when it cannot
 * (a fork without usable chat ids would otherwise mint a unique `unknown:N`
 * per call and re-notify on every detection); the operation epoch as the last
 * resort. Injectable for tests via _setScopeKeyResolver().
 */
let _resolveScopeKey = defaultResolveScopeKey;

function defaultResolveScopeKey() {
    try {
        const identity = getChatIdentity();
        if (identity && identity.isUnknown === false) return identity.key;
        if (identity?.characterKey) return identity.characterKey;
        if (identity?.groupKey) return identity.groupKey;
    } catch { /* fall through to the epoch */ }
    return `epoch:${getEpoch()}`;
}

/**
 * Pause a store: it stops its module's writes, the banner goes up, ONE toast
 * fires for this chat/scope.
 *
 * Idempotent per (store, scope, reasonCode): re-detecting the same block on a
 * retry keeps the original `since` and records no second event. A DIFFERENT
 * reasonCode for the same scope replaces the record and records a new
 * transition event (the registry state must describe the CURRENT block) — but
 * the toast is still not repeated: §5.4's rule is one notification per
 * chat/scope, full stop.
 *
 * @param {string} storeId registered store id (e.g. 'knowledgeStore')
 * @param {object} [info]
 * @param {string} [info.module] owning module id (defaults via the mapping)
 * @param {string} [info.reasonCode] stable machine code (e.g. 'future-version')
 * @param {string} [info.message] the plain-language banner text — MODULE-AUTHORED
 *        wording in the §5.4 style; the same string reaches the banner, Scope &
 *        storage, and Health. Never put quarantined record content in it.
 * @param {number|null} [info.version] the store version at the block, when known
 * @param {number|null} [info.count] record-count context (e.g. quarantined), when known
 * @returns {object|null} a copy of the stored pause state
 */
export function pauseStore(storeId, {
    module: moduleParam,
    reasonCode = 'paused',
    message = '',
    version = null,
    count = null,
} = {}) {
    if (typeof storeId !== 'string' || !storeId) return null;
    const scopeKey = _resolveScopeKey();
    const previous = _paused.get(storeId);
    const sameBlock = Boolean(previous)
        && previous.scopeKey === scopeKey
        && previous.reasonCode === reasonCode;

    const entry = {
        store: storeId,
        module: typeof moduleParam === 'string' && moduleParam
            ? moduleId(moduleParam)
            : (STORE_MODULE_IDS[storeId] ?? null),
        reasonCode: String(reasonCode),
        message: String(message ?? ''),
        scopeKey,
        since: sameBlock ? previous.since : Date.now(),
        version: typeof version === 'number' ? version : null,
        count: typeof count === 'number' ? count : null,
    };
    _paused.set(storeId, entry);
    // Every pause is a new "generation" for the resume-initializer run-once
    // memo (see runStoreResumeInitializer): the module may be re-initialized
    // once per pause, never twice for the same one.
    _pauseTransitions += 1;

    // The event is the in-session record of the TRANSITION; a repeated
    // detection of the same block is not news.
    if (!sameBlock) {
        recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.STORE_PAUSED, {
            store: storeId,
            reasonCode: entry.reasonCode,
            version: entry.version,
            count: entry.count,
        }, { level: 'warn' });
    }

    // ONE notification per chat/scope (§5.4): `${store}::${scopeKey}` is
    // remembered for the session, so retries and re-detections never repeat
    // the toast — whatever reason code they carry.
    const notifiedKey = `${storeId}::${scopeKey}`;
    if (!_notifiedScopes.has(notifiedKey)) {
        _notifiedScopes.add(notifiedKey);
        const label = MODULE_LABELS[entry.module] ?? entry.store;
        try {
            notify(
                `MWT: ${label} is paused`,
                entry.message || `The ${label} store for this chat could not be safely prepared. Its data was left unchanged.`,
                'error',
            );
        } catch { /* never block the pause on a toast */ }
    }

    return { ...entry };
}

/**
 * Clear a store's pause — a later load that succeeded, or a Retry that worked.
 * Records `schema_store_resumed` only when a pause actually existed.
 *
 * @param {string} storeId
 * @param {{ via?: string }} [options] — 'load' (default) or 'retry', for the event
 * @returns {boolean} whether a pause was cleared
 */
export function resumeStore(storeId, { via = 'load' } = {}) {
    if (!_paused.has(storeId)) return false;
    _paused.delete(storeId);
    recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.STORE_RESUMED, {
        store: storeId,
        via,
    }, { level: 'info' });
    return true;
}

/**
 * @param {string} storeId
 * @returns {object|null} a copy of the pause state, or null when not paused
 */
export function getPauseState(storeId) {
    const entry = _paused.get(storeId);
    return entry ? { ...entry } : null;
}

/**
 * @returns {object[]} copies of every paused store's state, in pause order
 */
export function getPausedStores() {
    return [..._paused.values()].map((entry) => ({ ...entry }));
}

/**
 * Is a pause record about the CURRENT chat/scope? A pause recorded for another
 * chat must not paint this chat's banner — the store is re-derived on every
 * chat switch, so the other chat's state is not this surface's state.
 *
 * @param {object} pause — a getPauseState() record
 * @returns {boolean}
 */
export function isPauseForCurrentScope(pause) {
    if (!pause?.scopeKey) return false;
    return pause.scopeKey === _resolveScopeKey();
}

// ─── The Retry seam ──────────────────────────────────────────────────────────

/**
 * Register the store's Retry handler — the re-preparation path its module
 * owns. Knowledge registers its re-hydration today; the Part 6 cutover
 * registers the chat-metadata preparation. Registration is idempotent.
 *
 * @param {string} storeId
 * @param {function(): (boolean|Promise<boolean>)} handler — resolves whether
 *        the block cleared (a resumeStore() inside the handler is honoured too)
 */
export function setStoreRetryHandler(storeId, handler) {
    if (typeof storeId !== 'string' || !storeId) return;
    if (typeof handler === 'function') _retryHandlers.set(storeId, handler);
    else _retryHandlers.delete(storeId);
}

/**
 * Run the module's Retry action for a paused store. Without a registered
 * handler this reports `no-retry-path` and changes nothing — an honest answer
 * beats a button that silently does nothing.
 *
 * @param {string} storeId
 * @returns {Promise<{ ok: boolean, reason?: string, message?: string, resumed?: boolean }>}
 */
export async function retryStore(storeId) {
    const state = getPauseState(storeId);
    if (!state) return { ok: true, resumed: false, reason: 'not-paused' };
    const handler = _retryHandlers.get(storeId);
    if (typeof handler !== 'function') {
        return {
            ok: false,
            reason: 'no-retry-path',
            message: `No automatic retry path is registered for "${storeId}" in this build. The pause clears when the underlying data is fixed and the chat is reloaded.`,
        };
    }
    let handlerOk = false;
    try {
        handlerOk = (await handler()) === true;
    } catch (err) {
        return { ok: false, reason: 'retry-failed', message: String(err?.message || err) };
    }
    // The handler may clear the pause itself (a successful re-preparation
    // calls resumeStore()); honour that, and clear it here when it only
    // reported success.
    if (handlerOk && getPauseState(storeId) !== null) {
        resumeStore(storeId, { via: 'retry' });
    }
    const resumed = getPauseState(storeId) === null;
    if (resumed) {
        // Part 6: the paused module's chat-change hydration was skipped (its
        // onChatChanged would have read counters and bookkeeping out of the
        // blocked value); the first event after this resume would otherwise
        // persist that stale in-memory state over the repaired store.
        // Re-derive it now — once per pause generation.
        await runStoreResumeInitializer(storeId);
    }
    return resumed
        ? { ok: true, resumed: true }
        : { ok: false, resumed: false, reason: 'still-paused', message: 'The retry ran, but the store is still blocked. The banner above and Diagnostics → 🗂️ Scope & storage carry the reason.' };
}

// ─── The resume re-initialization seam (Part 6) ───────────────────────────────

/**
 * Resume initializers per store id: the owning module's chat-change
 * re-hydration. While a store is paused, index.js does NOT run the module's
 * onChatChanged() — it would hydrate counters and bookkeeping from the
 * blocked value and hold them stale in memory. When the pause clears OUT OF
 * BAND (a successful Retry, or the §7.5 privileged preparation landing long
 * after CHAT_CHANGED already passed), the store's initializer re-derives the
 * module's in-memory state from the now-canonical store.
 */
const _resumeInitializers = new Map();

/** Bumped by every pauseStore() — the pause "generation" the run-once memo below keys on. */
let _pauseTransitions = 0;

/**
 * Owning MODULE id → the _pauseTransitions value at that module's last
 * initializer run. Keyed by module, not store id: index.js registers the
 * module's onChatChanged() for EVERY store the module owns (Knowledge owns
 * three store ids), so a store-keyed memo would let one resume generation
 * start the same asynchronous re-hydration once per store id, overlapping
 * itself.
 */
const _resumeInitRunAt = new Map();

/**
 * Register (or, with any non-function, clear) the owning module's resume
 * initializer for one store. Idempotent.
 *
 * @param {string} storeId
 * @param {(function(): (void|Promise<void>))|null} fn
 */
export function setStoreResumeInitializer(storeId, fn) {
    if (typeof storeId !== 'string' || !storeId) return;
    if (typeof fn === 'function') _resumeInitializers.set(storeId, fn);
    else _resumeInitializers.delete(storeId);
}

/**
 * Run the store's resume initializer, at most once per pause generation AND at
 * most once per owning module — and only once the WHOLE module has resumed:
 * the Retry flow and the §7.5 re-gate can both observe one resume, and one
 * resume can report several store ids of the SAME module — Knowledge's three
 * share one onChatChanged initializer — so the module's onChatChanged must
 * not run twice for the same pause, whichever store id the resume path
 * reports. Nor may it run while a sibling store of the same module is still
 * paused for this scope: the initializer is the MODULE's re-hydration, and
 * running it against a still-blocked sibling would both re-derive state from
 * unprepared data and consume the run-once memo, so the sibling's later
 * resume — which starts no new pause generation — would find the memo spent
 * and skip the one re-hydration the module still owes (stale in-memory state
 * outliving the final resume). A failing initializer is logged, never thrown —
 * the resume itself already succeeded.
 *
 * @param {string} storeId
 * @returns {Promise<void>}
 */
export async function runStoreResumeInitializer(storeId) {
    const fn = _resumeInitializers.get(storeId);
    if (typeof fn !== 'function') return;
    // The memo key is the OWNING module (the store id only for unmapped
    // stores): the initializer registered per store IS the module's
    // onChatChanged, so its identity — and the run-once dedupe with it — is
    // the module's, not each store's.
    const memoKey = STORE_MODULE_IDS[storeId] ?? storeId;
    // Wait until the whole module has resumed: while ANY store of that module
    // is still paused for the CURRENT scope, return WITHOUT running the
    // initializer and WITHOUT marking the memo — the module's last
    // current-scope resume then finds the memo still armed and re-hydrates
    // exactly once. (A sibling paused for ANOTHER chat/scope never defers:
    // the registry is per chat/scope, and that pause is not this surface's
    // state.)
    const moduleStoreIds = MODULE_STORE_IDS[memoKey] ?? [storeId];
    if (moduleStoreIds.some((id) => isStorePausedForCurrentScope(id))) {
        console.log(`[MWT:schema] Resume re-initialization for "${storeId}" deferred — another store of module "${memoKey}" is still paused for this chat.`);
        return;
    }
    if (_resumeInitRunAt.get(memoKey) === _pauseTransitions) return;
    _resumeInitRunAt.set(memoKey, _pauseTransitions);
    try {
        await fn();
    } catch (err) {
        console.warn(`[MWT:schema] Resume re-initialization for "${storeId}" failed:`, err?.message || err);
    }
}

// ─── The module banner (§5.4 — the module's own tab) ─────────────────────────

/**
 * The unmissable banner for a module's own tab: one row per paused store that
 * belongs to THIS chat/scope, each with its Retry button and the recovery
 * export. Returns '' when nothing is paused — a healthy tab renders exactly as
 * before (an always-visible empty banner would train users to ignore banners).
 *
 * Buttons carry data-mwt-pause-* attributes; index.js wires them once per
 * modal render (the modal body is rebuilt on every open). They are the §5.4
 * actions and they live HERE, in the module's tab — never in Diagnostics,
 * which is read-only by contract.
 *
 * @param {string} rawModuleId — a HEALTH_MODULE_SPECS id or a TABS id
 * @returns {string} HTML, '' when no store of that module is paused
 */
export function renderPausedStoresBanner(rawModuleId) {
    const id = moduleId(rawModuleId);
    const storeIds = MODULE_STORE_IDS[id] ?? [];
    const paused = storeIds
        .map((storeId) => getPauseState(storeId))
        .filter((pause) => pause && isPauseForCurrentScope(pause));
    if (paused.length === 0) return '';

    const label = MODULE_LABELS[id] ?? id;
    const rows = paused.map((pause) => {
        const reason = pause.message
            || `its saved data could not be safely prepared (${pause.reasonCode}).`;
        return `
        <div class="mwt-pause-banner-row" data-mwt-pause-row="${escapeHtml(pause.store)}">
            <div class="mwt-pause-banner-reason">
                <strong>${escapeHtml(label)} is paused for this chat</strong> — ${escapeHtml(reason)}
                <span class="mwt-pause-banner-note">Your original data was not changed, and other modules are unaffected. This is not ordinary inactivity: the module stopped itself rather than use data it cannot trust.</span>
            </div>
            <div class="mwt-pause-banner-actions">
                <button type="button" class="mwt-btn" data-mwt-pause-retry="${escapeHtml(pause.store)}" title="Re-run this store's preparation">↻ Retry</button>
                <button type="button" class="mwt-btn" data-mwt-pause-export="1" title="Download every quarantined record as JSON, so it can be repaired outside MWT and re-imported through the checked path">⬇ Download recovery data</button>
            </div>
        </div>`;
    }).join('');

    return `
    <div class="mwt-pause-banner" data-mwt-pause-banner="${escapeHtml(id)}" role="alert">
        <div class="mwt-pause-banner-head">⛔ Paused store — action needed</div>
        ${rows}
    </div>`;
}

// ─── Part 6: the decline checks + the privileged-preparation window ──────────
//
// The runtime chat-metadata cutover (schema/runtime.js) pauses stores BEFORE
// module handlers run. Those pauses are only honest if the paused module
// actually declines work, so the two questions every consumer asks live HERE,
// beside the registry they read:

/**
 * Is this store paused for the CURRENT chat/scope? The one read surface for
 * "should this module decline its own work (events, injection, generation)
 * for this store right now?" — a pause recorded for another chat is not this
 * surface's state (the store is re-derived on every chat switch).
 *
 * @param {string} storeId registered store id
 * @returns {boolean}
 */
export function isStorePausedForCurrentScope(storeId) {
    const pause = getPauseState(storeId);
    return Boolean(pause) && isPauseForCurrentScope(pause);
}

/**
 * Is ANY store of this module paused for the current chat/scope? The
 * message-event router's decline predicate (Part 6): a module whose store is
 * blocked declines its own work while every other module keeps running
 * (design §7.4 — blocking is per store, never global).
 *
 * @param {string} rawModuleId a HEALTH_MODULE_SPECS id, a TABS id, or a router
 *        module key ('WorldState', 'Chronicle', …) — normalised like
 *        renderPausedStoresBanner() does
 * @returns {boolean}
 */
const ROUTER_MODULE_KEY_ALIASES = Object.freeze({
    worldstate: 'world_state',
    storyplanner: 'story_planner',
});

export function isModulePausedForCurrentScope(rawModuleId) {
    const normalized = moduleId(rawModuleId).toLowerCase();
    const id = ROUTER_MODULE_KEY_ALIASES[normalized] ?? normalized;
    const storeIds = MODULE_STORE_IDS[id];
    if (!storeIds) return false;
    return storeIds.some((storeId) => isStorePausedForCurrentScope(storeId));
}

/**
 * The §7.5 privileged-preparation registry: while a deferred store's
 * chat-dependent conversion runs, the ORCHESTRATION (schema/runtime.js) — not
 * the paused module — performs the one write that clears the deferral. The
 * module's write seam stays declined for everyone else; this window is the
 * only way the conversion's own save passes it. Without it the privileged
 * path would deadlock against the very pause it exists to clear (the same
 * deadlock §7.5 warns about for queueWork).
 *
 * The window is a CAPABILITY, not a flag: beginPrivilegedPreparation() hands
 * the orchestration a scope-bound token, and only the single commit write
 * that presents that exact token passes isStoreWriteBlocked(). While the
 * converter is awaiting hydration the window is therefore CLOSED to every
 * other write to the store — UI work, cleanup, or a newly switched chat —
 * and overlapping conversions each keep their own privilege (releasing one
 * never closes the other's).
 */
const _privilegedPreparations = new Map(); // storeId → Set<capability token>

let _privilegeTokenNonce = 0;

/**
 * Open the privileged-preparation window for one store and receive its
 * capability. Only the §7.5 orchestration calls this; the capability must
 * reach {@link endPrivilegedPreparation} in a finally (so the window can never
 * leak) and be handed to the conversion's single commit write.
 *
 * @param {string} storeId
 * @returns {object|null} the scope-bound capability ({ store, token, scopeKey,
 *   epoch }), or null for an invalid store id
 */
export function beginPrivilegedPreparation(storeId) {
    if (typeof storeId !== 'string' || !storeId) return null;
    const token = `privileged-preparation:${++_privilegeTokenNonce}`;
    let tokens = _privilegedPreparations.get(storeId);
    if (!tokens) {
        tokens = new Set();
        _privilegedPreparations.set(storeId, tokens);
    }
    tokens.add(token);
    return { store: storeId, token, scopeKey: _resolveScopeKey(), epoch: getEpoch() };
}

/**
 * Release one privileged-preparation capability (the §7.5 orchestration's
 * finally). Also accepts a bare store id as the legacy close-everything form:
 * that closes every window the store still has open.
 *
 * @param {object|string} capability the value beginPrivilegedPreparation()
 *   returned, or a store id
 */
export function endPrivilegedPreparation(capability) {
    if (capability === null || capability === undefined) return;
    const storeId = typeof capability === 'string' ? capability : capability.store;
    const tokens = _privilegedPreparations.get(storeId);
    if (!tokens) return;
    if (typeof capability === 'string') {
        _privilegedPreparations.delete(storeId);
        return;
    }
    tokens.delete(capability.token);
    if (tokens.size === 0) _privilegedPreparations.delete(storeId);
}

/**
 * Does this capability still open one store's privileged window? It must be a
 * live token (never released), captured at the CURRENT epoch, and bound to the
 * CURRENT scope key — a chat switch retires it, so a conversion left over
 * from the outgoing chat can never unlock the newly switched chat's seam.
 *
 * @param {object} capability
 * @returns {boolean}
 */
function isPrivilegedPreparationWrite(capability) {
    if (!capability || typeof capability !== 'object') return false;
    const tokens = _privilegedPreparations.get(capability.store);
    if (!tokens || !tokens.has(capability.token)) return false;
    if (capability.epoch !== getEpoch()) return false;
    return capability.scopeKey === _resolveScopeKey();
}

/**
 * The WRITE-SEAM guard (Part 6): may this store be written right now? A store
 * paused for the current scope keeps its untouched original as the
 * recoverable state — a module write would validate the unprepared value at
 * the current version and replace it (for a future-version store, a silent
 * downgrade, exactly what §12 forbids) — so the seam refuses. The ONLY
 * exception is the §7.5 privileged-preparation capability: the conversion's
 * own commit presents the capability the orchestration handed it, and nothing
 * else — no capability, a released one, or one captured before a chat switch
 * — passes.
 *
 * @param {string} storeId registered store id
 * @param {object} [capability] the §7.5 capability presented by the privileged
 *   commit (schema/runtime.js → the converter → the module write seam).
 *   Ordinary module writes pass nothing and stay refused for the whole
 *   window, including while the converter is awaiting hydration.
 * @returns {boolean} true when the write must be refused
 */
export function isStoreWriteBlocked(storeId, capability = null) {
    if (!isStorePausedForCurrentScope(storeId)) return false;
    return !isPrivilegedPreparationWrite(capability);
}

// ─── Test-only seams ─────────────────────────────────────────────────────────

/**
 * Override the pause scope-key resolver (the core/diagnostics.js
 * _setScopeKeyResolver pattern). Pass a function, or null/omit to restore the
 * default.
 * @internal — deterministic test stamping only.
 */
export function _setScopeKeyResolver(fn) {
    _resolveScopeKey = typeof fn === 'function' ? fn : defaultResolveScopeKey;
}

/**
 * Wipe the paused-state registry and the notification ledger. Mirrors
 * core/diagnostics.js _resetDiagnostics().
 * @internal — test isolation only; production code must not call this.
 */
export function _resetPausedStores() {
    _paused.clear();
    _notifiedScopes.clear();
    _retryHandlers.clear();
    _privilegedPreparations.clear();
    _resumeInitializers.clear();
    _resumeInitRunAt.clear();
    _pauseTransitions = 0;
    _resolveScopeKey = defaultResolveScopeKey;
}


