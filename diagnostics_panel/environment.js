/**
 * diagnostics_panel/environment.js — Tab 2: Environment, the fork-compat probe
 * (Diagnostics Phase 7).
 *
 * "Which SillyTavern is this, and which context APIs does it actually expose?"
 * (phases doc §II.4 Phase 7, design §I.5 Tab 2). Versions + feature detection:
 * `getCurrentChatId`, `getTokenCount`, `constructPrompt`,
 * `ConnectionManagerRequestService`, world-info module availability — plus the
 * raw context-field table `MWT.scope.diagnose()` already builds (index.js).
 *
 * This tab has a second job beyond user support (design §I.5 Tab 2): it is how
 * the `getCurrentChatId()` premise underpinning core/scope.js finally gets
 * validated on real forks, from tester reports, without a manual live-ST check
 * per fork. Every probe result is therefore designed to be PASTEABLE — the
 * premise verdict is a single row a tester can screenshot into a bug report,
 * and `MWT.diagnostics.environment()` returns the same snapshot as JSON.
 *
 * DOM-free by design (the Phase 6 health.js pattern): everything injectable,
 * every probe individually guarded — one throwing detection degrades its own
 * row plus an `errors` note, never the whole snapshot. The one genuinely async
 * probe — the `shared.js` import behind Connection Manager calls, the exact
 * path core/api.js uses — is split out (loadSharedModule /
 * inspectConnectionManager) so the sync snapshot can carry an unprobed
 * placeholder that the pane fills in once on open.
 *
 * Direct imports throughout for core singletons (NOT via core/index.js): the
 * barrel is aliased to test/stubs/core.js under Vitest, and this module must
 * read the real helpers + version regardless (the barrel→stub alias trap,
 * §II.3). The `'../../../shared.js'` specifier is byte-identical to
 * core/api.js's, so it resolves to the same host module in production and to
 * the same test/stubs/shared.js seam under Vitest.
 */

import { MWT_VERSION } from '../core/version.js';
import { getContextSafe } from '../core/context.js';
import { getChatIdentity } from '../core/scope.js';
import { state as knowledgeState } from '../knowledge/state.js';

// ─── ST version ("if exposed" — the probe itself is the finding) ─────────────

/**
 * Read SillyTavern's version out of the DOM, the way ST itself displays it.
 * `#version_display` (public/index.html) is filled on load from the `/version`
 * fetch with `displayVersion` = "SillyTavern <pkg> '<branch>' (<rev>)"
 * (public/script.js). The leading product name is dropped — the row label
 * already says "SillyTavern:" — leaving e.g. "1.18.0 'release' (abc1234)".
 *
 * Returns undefined (→ the probe treats it as absent, tries nothing else and
 * ends at null) when there is no document, no element, or the element is still
 * empty / the bare "SillyTavern" placeholder before the fetch resolves — so a
 * not-yet-populated element honestly reads as "not exposed", never as a stale
 * or half value.
 *
 * @param {Document} [doc]
 * @returns {string|undefined}
 */
function readVersionDisplay(doc) {
    const text = doc?.getElementById?.('version_display')?.textContent;
    const stripped = String(text ?? '').trim().replace(/^SillyTavern\s*/i, '').trim();
    return stripped || undefined;
}

/**
 * Where a version string might live, in probe order. The reference
 * SillyTavern exposes no client-side version FIELD for extensions
 * (`globalThis.SillyTavern` is just `{ libs, getContext }` and `getContext()`
 * carries no version), so the three field probes below return nothing on stock
 * ST — confirmed against a live 1.18.0 build. The DOM probe is the universal
 * fallback: `#version_display` is what ST paints for the user, present on every
 * build that renders the main UI. It is LAST so a fork that DOES expose a real
 * version field still wins (a field is cleaner than scraping); the absence of
 * every source is itself fork-compat data.
 */
export const ST_VERSION_SOURCES = [
    { id: 'SillyTavern.version', read: (st, _ctx, _doc) => st?.version },
    { id: 'SillyTavern.manifest.version', read: (st, _ctx, _doc) => st?.manifest?.version },
    { id: 'context.version', read: (_st, ctx, _doc) => ctx?.version },
    { id: 'DOM #version_display', read: (_st, _ctx, doc) => readVersionDisplay(doc) },
];

/**
 * Detect the SillyTavern version, if this build exposes one anywhere.
 *
 * @param {object} [st] — the SillyTavern global namespace
 * @param {object} [ctx] — the context object from getContextSafe()
 * @param {Document} [doc] — the document, for the DOM #version_display fallback
 * @returns {{ value: string|null, source: string|null }}
 */
export function detectStVersion(st, ctx, doc) {
    for (const source of ST_VERSION_SOURCES) {
        let raw;
        try {
            raw = source.read(st, ctx, doc);
        } catch { /* unreadable on this build — try the next candidate */ }
        if (typeof raw === 'string' && raw.trim() !== '') {
            return { value: raw.trim(), source: source.id };
        }
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            return { value: String(raw), source: source.id };
        }
    }
    return { value: null, source: null };
}

// ─── Chat-ID premise (the fork-compat headline) ──────────────────────────────

/**
 * Validate the premise core/scope.js is built on: that `getCurrentChatId()` is
 * exposed and usable, so two chats on the same character still produce
 * different identity keys (core/scope.js getChatIdentity resolution order:
 * getCurrentChatId → ctx.chatId → unknown-with-nonce).
 *
 * Levels:
 *  - 'ok'          — getCurrentChatId() exists and returned a non-empty id.
 *  - 'fallback'    — getCurrentChatId() missing/unusable, but ctx.chatId
 *                    answers. Scope still resolves per-chat identity; THIS IS
 *                    THE ROW A FORK REPORT NEEDS (the premise holds only via
 *                    the documented fallback).
 *  - 'fail-closed' — neither source answers. getChatIdentity() issues a fresh
 *                    unknown-nonce per call, so every identity compare fails
 *                    closed and chat-switch detection leans entirely on the
 *                    epoch counter. Expected nowhere; report it.
 *  - 'unknown'     — no context object at all (the probe itself could not run).
 *
 * @param {object} [ctx]
 * @param {function(object=): object} [getIdentity] — core/scope.js getChatIdentity
 * @returns {{ level: 'ok'|'fallback'|'fail-closed'|'unknown', method: string|null,
 *            chatIdValue: string|null, getCurrentChatIdOutcome: string,
 *            identityKey: string|null, identityUnknown: boolean, note: string }}
 */
export function detectChatIdPremise(ctx, getIdentity = getChatIdentity) {
    // getCurrentChatId() probe — mirrors MWT.scope.diagnose()'s call handling.
    let outcome = 'not-a-function';
    let fromGet = null;
    if (ctx && typeof ctx.getCurrentChatId === 'function') {
        try {
            const v = ctx.getCurrentChatId();
            if (v !== null && v !== undefined && String(v) !== '') {
                outcome = 'returned-value';
                fromGet = String(v);
            } else {
                outcome = 'returned-empty';
            }
        } catch (err) {
            outcome = `threw: ${String(err?.message || err)}`;
        }
    }

    const fromField = (ctx && ctx.chatId !== null && ctx.chatId !== undefined && String(ctx.chatId) !== '')
        ? String(ctx.chatId)
        : null;

    let level, method, chatIdValue;
    if (outcome === 'returned-value') {
        level = 'ok';
        method = 'getCurrentChatId';
        chatIdValue = fromGet;
    } else if (fromField !== null) {
        level = 'fallback';
        method = 'ctx.chatId';
        chatIdValue = fromField;
    } else if (ctx) {
        level = 'fail-closed';
        method = null;
        chatIdValue = null;
    } else {
        level = 'unknown';
        method = null;
        chatIdValue = null;
    }

    // The identity scope.js actually resolves with — the premise's conclusion,
    // not just its inputs. 'chat:<id>' proves per-chat separation; an
    // 'unknown:<nonce>' key is the fail-closed state (a fresh nonce per call,
    // never equal to a previous capture).
    let identity = null;
    try {
        identity = getIdentity(ctx) ?? null;
    } catch { /* identity resolution itself failed — report without it */ }

    const notes = {
        ok: 'getCurrentChatId() is exposed and usable — core/scope.js\'s premise HOLDS on this build.',
        fallback: `getCurrentChatId() is not usable here (${outcome}); core/scope.js is running on its ctx.chatId fallback. Per-chat identity still resolves — include this row when reporting from this fork.`,
        'fail-closed': 'No usable chat id on this build (getCurrentChatId() and ctx.chatId both unusable) — core/scope.js identity compares FAIL CLOSED and chat-switch detection leans entirely on the epoch counter. Include this row in any report from this fork.',
        unknown: 'No SillyTavern context object could be resolved, so the environment could not be probed.',
    };

    return {
        level,
        method,
        chatIdValue,
        getCurrentChatIdOutcome: outcome,
        identityKey: identity?.key ?? null,
        identityUnknown: identity?.isUnknown === true,
        note: notes[level],
    };
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

/**
 * The tokenizer sources estimateTokens() tries, in its exact order
 * (core/context.js): context → legacy global → SillyTavern.tokenizers. The tab
 * reports which one this build answers with, because every token count in MWT
 * (and the whole Health tab) silently degrades to the chars/4.5 estimate when
 * none of them do.
 *
 * Each source yields BOTH the function and the receiver estimateTokens() would
 * call it on: `ctx.getTokenCount(text)` and
 * `SillyTavern.tokenizers.getTokenCount(text)` are method calls, so a
 * tokenizer implemented as a method that uses `this` works fine in production.
 * Probing it detached (`const fn = ctx.getTokenCount; fn(text)`) makes the
 * same tokenizer throw — the probe would then report "present but threw" for a
 * tokenizer that is, in fact, working. On the one tab whose whole job is to be
 * trusted about fork compatibility, a false alarm is as costly as a miss.
 */
export const TOKENIZER_SOURCES = [
    { id: 'ctx.getTokenCount', pick: (ctx) => ({ fn: ctx?.getTokenCount, thisArg: ctx }) },
    // The legacy route is a bare identifier call in estimateTokens(), and this
    // module is strict-mode ESM, so its receiver is genuinely undefined.
    { id: 'global getTokenCount', pick: (_ctx, globalScope) => ({ fn: globalScope?.getTokenCount, thisArg: undefined }) },
    { id: 'SillyTavern.tokenizers.getTokenCount', pick: (_ctx, _globalScope, st) => ({ fn: st?.tokenizers?.getTokenCount, thisArg: st?.tokenizers }) },
];

/**
 * Detect a working tokenizer. Presence is not enough: the probe CALLS the
 * candidate with a one-word string and requires a number back, so a tokenizer
 * that exists but throws is reported as present-but-unusable (that fork state
 * is exactly what silently degrades every token figure MWT shows).
 *
 * The call is made through the source's own receiver (see TOKENIZER_SOURCES),
 * so the probe exercises the same call estimateTokens() makes — not a detached
 * copy of the function that would fail for a reason production never hits.
 *
 * Stopping at the first candidate that throws is deliberate and faithful:
 * estimateTokens() wraps all three sources in ONE try/catch, so a first source
 * that throws sends it straight to the chars/4.5 fallback — it never reaches
 * the later candidates either.
 *
 * @returns {{ available: boolean, source: string|null, detail: string }}
 */
export function detectTokenizer(ctx, globalScope = globalThis, st) {
    for (const source of TOKENIZER_SOURCES) {
        let picked;
        try {
            picked = source.pick(ctx, globalScope, st);
        } catch { /* unreadable — next candidate */ }
        const fn = picked?.fn;
        if (typeof fn !== 'function') continue;
        try {
            const n = Reflect.apply(fn, picked.thisArg, ['hello']);
            if (typeof n === 'number' && Number.isFinite(n)) {
                return { available: true, source: source.id, detail: `${source.id} — verified with a live call` };
            }
            return { available: false, source: source.id, detail: `${source.id} is present but did not return a number (${typeof n})` };
        } catch (err) {
            return { available: false, source: source.id, detail: `${source.id} is present but threw: ${String(err?.message || err)}` };
        }
    }
    return { available: false, source: null, detail: 'none exposed — estimateTokens() falls back to its chars/4.5 estimate for every token figure MWT shows' };
}

// ─── World-info module (the Knowledge dependency) ────────────────────────────

/**
 * Report the world-info module tri-state that knowledge/state.js `wiScript`
 * carries (`undefined` = not yet attempted, object = loaded, `null` = tried
 * and failed) plus which of the three functions Knowledge actually calls are
 * present. This is the same state the Phase 3 `wi_script_unavailable` warn
 * counter watches — without it, every Knowledge write path refuses to run.
 *
 * @returns {{ state: 'loaded'|'not-attempted'|'failed', available: boolean,
 *            loadWorldInfo: boolean, saveWorldInfo: boolean, createNewWorldInfo: boolean,
 *            note: string }}
 */
export function detectWorldInfo(wiState = knowledgeState) {
    const wi = wiState?.wiScript;
    if (wi === null) {
        return { state: 'failed', available: false, loadWorldInfo: false, saveWorldInfo: false, createNewWorldInfo: false,
            note: 'import attempted and failed (tri-state null) — Knowledge writes are blocked; see the wi_script_unavailable warns' };
    }
    if (wi === undefined) {
        return { state: 'not-attempted', available: false, loadWorldInfo: false, saveWorldInfo: false, createNewWorldInfo: false,
            note: 'not attempted yet (lorebook.js top-level import has not resolved)' };
    }
    return {
        state: 'loaded',
        available: true,
        loadWorldInfo: typeof wi.loadWorldInfo === 'function',
        saveWorldInfo: typeof wi.saveWorldInfo === 'function',
        createNewWorldInfo: typeof wi.createNewWorldInfo === 'function',
        note: 'world-info.js imported — Knowledge lorebook reads/writes can run',
    };
}

// ─── Connection Manager (shared.js — the core/api.js path) ───────────────────

/**
 * Inspect a loaded shared.js namespace for ConnectionManagerRequestService.
 * PURE and synchronous so the async import can happen elsewhere (the pane
 * fills its cell once on open; the console bridge awaits before collecting).
 *
 * `loaded` is a loadSharedModule() result: `{ ok: true, module }`,
 * `{ ok: false, error }`, or null/undefined = not probed.
 *
 * `constructPrompt` is its own line item because it is the one member the
 * Aikobots-4 fork removed (Completed_Roadmaps/porting_guide.md item 2):
 * core/api.js feature-detects around its absence, so "present but without
 * constructPrompt" is a working, reportable fork state — not a failure.
 *
 * @returns {{ probed: boolean, available?: boolean, constructPrompt?: boolean,
 *            sendRequest?: boolean, error?: string }}
 */
export function inspectConnectionManager(loaded) {
    if (!loaded) return { probed: false };
    if (loaded.ok === false) {
        return { probed: true, available: false, constructPrompt: false, sendRequest: false,
            error: String(loaded.error ?? 'shared.js import failed') };
    }
    const CMRS = loaded.module?.ConnectionManagerRequestService;
    return {
        probed: true,
        available: !!CMRS,
        constructPrompt: typeof CMRS?.constructPrompt === 'function',
        sendRequest: typeof CMRS?.sendRequest === 'function',
    };
}

/**
 * Load SillyTavern's shared.js through the same specifier core/api.js uses
 * (`'../../../shared.js'`), never throwing: the result states success or
 * carries the error for the report. Under Vitest the specifier is aliased to
 * test/stubs/shared.js, exactly like core/api.js's own import.
 *
 * @returns {Promise<{ ok: true, module: object } | { ok: false, error: string }>}
 */
export async function loadSharedModule() {
    try {
        return { ok: true, module: await import('../../../shared.js') };
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
}

/**
 * Convenience: load + inspect in one step (the console bridge's shape).
 * @returns {Promise<object>} an inspectConnectionManager() result
 */
export async function probeConnectionManager() {
    return inspectConnectionManager(await loadSharedModule());
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Collect the Environment snapshot — everything the 🌐 pane renders and
 * MWT.diagnostics.environment() returns. Synchronous: the shared.js probe is
 * the one async piece and is passed in pre-loaded via `sharedModule` (or left
 * null → `{ probed: false }` placeholder for the pane's deferred fill).
 *
 * Every probe is individually guarded (a throwing detection degrades to a
 * fallback + an `errors` entry), mirroring collectHealthSnapshot()'s rule that
 * one broken cell may never blank the tab.
 *
 * @param {object} [deps]
 * @param {object} [deps.st] — SillyTavern namespace (default: live global)
 * @param {object} [deps.globalScope] — global scope for the legacy tokenizer
 * @param {object} [deps.ctx] — context (default: getContextSafe())
 * @param {Document} [deps.doc] — document, for the DOM #version_display probe
 * @param {function} [deps.getIdentity] — core/scope.js getChatIdentity
 * @param {object} [deps.wiState] — knowledge/state.js state (wiScript tri-state)
 * @param {object|null} [deps.sharedModule] — a loadSharedModule() result or null
 * @param {string} [deps.version] — MWT_VERSION by default (direct import, §II.3)
 * @param {function(): number} [deps.now]
 * @returns {{ generatedAt: number, mwtVersion: string, stVersion: string|null,
 *            stVersionSource: string|null, contextAvailable: boolean,
 *            contextSource: string|null, features: Array<object>,
 *            connectionManager: object, chatIdPremise: object,
 *            contextFields: object, errors?: string[] }}
 */
export function collectEnvironmentSnapshot({
    st = (typeof SillyTavern !== 'undefined' ? SillyTavern : undefined),
    globalScope = globalThis,
    ctx = getContextSafe(),
    doc = (typeof document !== 'undefined' ? document : undefined),
    getIdentity = getChatIdentity,
    wiState = knowledgeState,
    sharedModule = null,
    version = MWT_VERSION,
    now = Date.now,
} = {}) {
    const errors = [];
    const call = (label, fn, fallback) => {
        try {
            const v = fn();
            return v === undefined ? fallback : v;
        } catch (err) {
            errors.push(`${label}: ${String(err?.message || err)}`);
            return fallback;
        }
    };

    // Which route produced the context object (getContextSafe's own order).
    const contextSource = call('contextSource', () => {
        if (typeof st?.getContext === 'function') return 'SillyTavern.getContext';
        if (typeof globalScope?.getContext === 'function') return 'getContext (legacy global)';
        return null;
    }, null);

    const stVersion = call('stVersion', () => detectStVersion(st, ctx, doc), { value: null, source: null });
    const premise = call('chatIdPremise', () => detectChatIdPremise(ctx, getIdentity), null) ?? {
        level: 'unknown', method: null, chatIdValue: null, getCurrentChatIdOutcome: 'not-a-function',
        identityKey: null, identityUnknown: true, note: 'premise probe failed — see errors',
    };
    const tokenizer = call('tokenizer', () => detectTokenizer(ctx, globalScope, st), null) ?? {
        available: false, source: null, detail: 'tokenizer probe failed — see errors',
    };
    const worldInfo = call('worldInfo', () => detectWorldInfo(wiState), null) ?? {
        state: 'failed', available: false, loadWorldInfo: false, saveWorldInfo: false, createNewWorldInfo: false,
        note: 'world-info probe failed — see errors',
    };
    const connectionManager = call('connectionManager', () => inspectConnectionManager(sharedModule), { probed: false });

    // The raw context-field table MWT.scope.diagnose() prints (index.js) —
    // same eleven rows, same '(absent)' sentinels, so a pasted pane and a
    // pasted diagnose() console dump can be compared line for line.
    const contextFields = call('contextFields', () => {
        const absent = '(absent)';
        const card = (Array.isArray(ctx?.characters) && ctx?.characterId !== null && ctx?.characterId !== undefined)
            ? (ctx.characters[ctx.characterId] ?? null)
            : null;
        const getCall = (() => {
            if (!ctx || typeof ctx.getCurrentChatId !== 'function') return '(not a function)';
            try {
                const v = ctx.getCurrentChatId();
                return (v === null || v === undefined || String(v) === '') ? '(empty)' : String(v);
            } catch (err) { return `(threw: ${String(err?.message || err)})`; }
        })();
        return {
            characterId: ctx?.characterId ?? absent,
            'characters is array': Array.isArray(ctx?.characters),
            'characters[characterId]': card ? 'resolved' : '(not resolved)',
            'card.avatar': card?.avatar || absent,
            'card.name': card?.name || absent,
            'name1 (user)': ctx?.name1 || absent,
            'name2 (char)': ctx?.name2 || absent,
            groupId: ctx?.groupId ?? absent,
            'groups is array': Array.isArray(ctx?.groups),
            'getCurrentChatId()': getCall,
            chatId: ctx?.chatId ?? absent,
        };
    }, {});

    // Feature rows, in design §I.5 Tab 2 order. The context-side
    // ConnectionManagerRequestService check is separate from the shared.js
    // probe below: the reference build exposes the service on the context
    // object itself, while core/api.js reaches it through the shared.js
    // import — a fork can answer yes to one and no to the other. Guarded as
    // a whole: a hostile context (a getter that throws) degrades to an empty
    // feature table + an errors note, never a broken snapshot.
    const features = call('features', () => {
        // Read INSIDE the guard: ConnectionManagerRequestService may be an
        // accessor, and a fork whose getter throws would otherwise take the
        // whole snapshot down from here — the one thing this collector
        // promises never to do.
        const cmrsOnContext = !!ctx?.ConnectionManagerRequestService;
        const constructPromptOnContext = typeof ctx?.ConnectionManagerRequestService?.constructPrompt === 'function';
        return [
            {
                id: 'getCurrentChatId',
                label: 'ctx.getCurrentChatId()',
                available: !!(ctx && typeof ctx.getCurrentChatId === 'function'),
                detail: ctx && typeof ctx.getCurrentChatId === 'function'
                    ? premise.getCurrentChatIdOutcome
                    : '(absent on this build)',
            },
            {
                id: 'chatId',
                label: 'ctx.chatId',
                available: premise.method === 'ctx.chatId' || (ctx?.chatId !== null && ctx?.chatId !== undefined && String(ctx.chatId) !== ''),
                detail: premise.chatIdValue ?? '(absent on this build)',
            },
            {
                id: 'getTokenCount',
                label: 'tokenizer (getTokenCount)',
                available: tokenizer.available === true,
                detail: tokenizer.detail,
            },
            {
                id: 'connectionManagerContext',
                label: 'ctx.ConnectionManagerRequestService',
                available: cmrsOnContext,
                detail: cmrsOnContext
                    ? (constructPromptOnContext ? 'exposed on the context object · constructPrompt: function' : 'exposed on the context object · constructPrompt: MISSING')
                    : '(not exposed on the context object — see the shared.js probe below)',
            },
            {
                id: 'worldInfo',
                label: 'world-info.js (Knowledge)',
                available: worldInfo.available === true,
                detail: worldInfo.note,
            },
        ];
    }, []);

    return {
        generatedAt: now(),
        mwtVersion: version,
        stVersion: stVersion?.value ?? null,
        stVersionSource: stVersion?.source ?? null,
        contextAvailable: !!ctx,
        contextSource,
        features,
        connectionManager,
        chatIdPremise: premise,
        contextFields,
        ...(errors.length ? { errors } : {}),
    };
}
