/**
 * test/stubs/core.js â€” Fake SillyTavern runtime for tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * Most modules in this extension import helpers from `../core/index.js` (the
 * "barrel" file). Those helpers read from the live SillyTavern context â€” the
 * current chat array, chat metadata, the context object, etc. None of that
 * exists when running tests in Node.
 *
 * This file is a lightweight replacement. `vitest.config.js` redirects every
 * `import ... from '../core/index.js'` (or `./core/index.js`) to THIS file,
 * so the code-under-test gets a controlled, in-memory fake instead of trying
 * to reach into SillyTavern.
 *
 * HOW TO USE IT IN A TEST
 * -----------------------
 * Tests call `resetCoreStubs()` at the top of each test (usually inside a
 * `beforeEach`) to start with a clean slate. Then they optionally seed state
 * with `setFakeChat([...])` or by mutating the metadata object returned by
 * `getChatMeta()`. Example:
 *
 *   import { resetCoreStubs, setFakeChat, getFakeMeta } from '../stubs/core.js';
 *
 *   beforeEach(() => resetCoreStubs());
 *
 *   test('something', () => {
 *       setFakeChat([{ mes: 'hello', send_date: '2024-01-01T00:00:00.000Z' }]);
 *       // ... call the function under test ...
 *       expect(getFakeMeta().someKey).toEqual(...);
 *   });
 *
 * The goal is fidelity to the *shape* of the real API, not to SillyTavern's
 * internal implementation. Anything not exercised by the tests can stay as a
 * no-op or a stub that throws "not implemented".
 */

// â”€â”€â”€ In-memory fake state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// These three variables ARE the "SillyTavern runtime" for our tests. The
// functions below are thin accessors over them. `resetCoreStubs()` clears
// them so tests don't leak state into one another.

// Direct import (NOT a re-export): resetCoreStubs() must clear the real
// diagnostics singleton so events/last-runs don't leak between tests once later
// phases call record() through the barrel. _resetDiagnostics stays out of the
// production barrel — only this test stub reaches it.
import { _resetDiagnostics, recordInjection } from '../../core/diagnostics.js';

let _chat = [];
let _meta = {};
let _contextExtras = {};
let _extSettings = {};
let _pickTextFileImpl = null;
let _apiImpl = null;
let _promptCalls = [];
const _notifications = [];
let _statusCalls = [];
let _downloadJsonCalls = [];

/**
 * Wipe all fake state. Call this in `beforeEach` so every test starts clean.
 */
export function resetCoreStubs() {
    _chat = [];
    _meta = {};
    _contextExtras = {};
    _extSettings = {};
    _pickTextFileImpl = null;
    _apiImpl = null;
    _promptCalls = [];
    _statusCalls = [];
    _downloadJsonCalls = [];
    // Clear the real diagnostics singleton (events + last-runs), since the stub
    // now re-exports it from core/diagnostics.js. Without this, record() calls
    // made through the barrel by later phases would leak across tests.
    _resetDiagnostics();
}

/**
 * Read-only peek at the fake extension_settings store (for assertions).
 */
export function getFakeExtSettings() {
    return _extSettings;
}

/**
 * Replace the fake chat array. Pass an array of message-shaped objects, e.g.
 * `[{ mes: 'hi', send_date: '...', name: 'Mara', is_user: false }]`.
 */
export function setFakeChat(messages) {
    _chat = Array.isArray(messages) ? messages : [];
}

/**
 * Read-only peek at the current fake chat (mostly for assertions in tests).
 */
export function getFakeChat() {
    return _chat;
}

/**
 * Read-only peek at the entire fake metadata object.
 */
export function getFakeMeta() {
    return _meta;
}

/**
 * Add extra fields to the fake SillyTavern context object (e.g. name1, name2,
 * saveMetadataDebounced). Tests that need those pass them here.
 */
export function setFakeContextExtras(extras) {
    _contextExtras = { ..._contextExtras, ...extras };
}

// â”€â”€â”€ Fake context object â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Several real helpers read from `getContextSafe()`. We build a minimal stand-in
// every time it's called, layering the in-memory chat + meta + extras on top.

function buildFakeContext() {
    return {
        chat: _chat,
        chatMetadata: _meta,
        // Common ST context methods that tests may want to assert were called.
        // Defaults are inert no-ops; override via `setFakeContextExtras`.
        saveMetadataDebounced: () => {},
        saveChatDebounced: () => {},
        saveMetadata: async () => {},
        ..._contextExtras,
    };
}

// â”€â”€â”€ Mirrors of core/context.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function getContextSafe() {
    return buildFakeContext();
}

export function getChat() {
    return _chat;
}

export function getOrCreateReceiptIdentity(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.id != null && String(message.id).trim()) return `id:${message.id}`;
    if (message.extra?.mesid != null && String(message.extra.mesid).trim()) return `mesid:${message.extra.mesid}`;
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    if (!message.extra.mwt_uuid) message.extra.mwt_uuid = 'test-' + Math.random().toString(36).slice(2);
    return `uuid:${message.extra.mwt_uuid}`;
}

export function getChatMeta(key) {
    if (key !== undefined) return _meta[key];
    return _meta;
}

export function setChatMeta(key, patch) {
    if (!_meta[key]) _meta[key] = {};
    _meta[key] = { ..._meta[key], ...patch, lastUpdated: Date.now() };
}

export function getRecentMessages({
    maxMessages = 50,
    maxChars = 500000,
    filterSystem = false,
    excludeLast = 0,
    stableHistory = false,
} = {}) {
    const end = stableHistory ? getStableHistoryEnd(_chat) : Math.max(0, _chat.length - excludeLast);
    let slice = _chat.slice(Math.max(0, end - maxMessages), end);
    if (filterSystem) {
        slice = slice.filter(m => !m?.is_system && m?.extra?.type !== 'narrator');
    }
    const lines = [];
    let total = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
        const msg = slice[i];
        const name = msg?.name || (msg?.is_user ? 'User' : 'Assistant');
        const text = String(msg?.mes || '').trim();
        if (!text) continue;
        const line = `${name}: ${text}`;
        if (total + line.length > maxChars) break;
        lines.push(line);
        total += line.length + 1;
    }
    return lines.reverse().join('\n');
}

/** Mirror core/context.js's configurable stable-history cutoff for modules that
 * import the test-only core barrel. */
export function getRecentHistoryExclude() {
    const parsed = Number(getGlobalSettings().recentHistoryExclude);
    if (!Number.isFinite(parsed)) return 2;
    return Math.min(10, Math.max(0, Math.round(parsed)));
}

export function getStableHistoryEnd(chat = _chat) {
    return Math.max(0, (chat?.length || 0) - getRecentHistoryExclude());
}

export function getPlayerNames({ lower = true, includeFirstChat = false } = {}) {
    const names = new Set();
    const transform = lower ? (s) => s.toLowerCase() : (s) => s;
    const ctx = buildFakeContext();
    if (ctx?.name1) names.add(transform(String(ctx.name1).trim()));
    if (ctx?.name2) names.add(transform(String(ctx.name2).trim()));
    if (Array.isArray(ctx?.characters)) {
        for (const ch of ctx.characters) {
            if (ch?.name) names.add(transform(String(ch.name).trim()));
        }
    }
    if (includeFirstChat && _chat[0]?.name) {
        names.add(transform(_chat[0].name.trim()));
    }
    return names;
}

export function getUserNames({ lower = true } = {}) {
    const names = new Set();
    const transform = lower ? (s) => s.toLowerCase() : (s) => s;
    const ctx = buildFakeContext();
    if (ctx?.name1) names.add(transform(String(ctx.name1).trim()));
    return names;
}

export function getSetExtensionPrompt() {
    const ctx = buildFakeContext();
    return typeof ctx.setExtensionPrompt === 'function'
        ? ctx.setExtensionPrompt.bind(ctx)
        : null;
}

export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sendDateToMs(sendDate) {
    if (sendDate == null) return null;
    if (typeof sendDate === 'number' ||
        (typeof sendDate === 'string' && /^\d+$/.test(sendDate.trim()))) {
        const n = Number(sendDate);
        if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    }
    const parsed = Date.parse(sendDate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return null;
}

export function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    return Math.ceil(text.length / 4.5);
}

// â”€â”€â”€ Mirrors of core/metadata.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const WORLD_STATE_METADATA_KEY = 'world_state_tracker_metadata';

export function persistChatMeta() { /* no-op in tests */ }

export async function persistChatMetaNow({ strict = false } = {}) {
    const ctx = buildFakeContext();
    if (typeof ctx?.saveMetadata === 'function') {
        try {
            await ctx.saveMetadata();
            return;
        } catch (err) {
            // Mirrors core/metadata.js: strict callers must learn the durable
            // write failed; non-strict callers get the debounced fallback.
            if (strict) throw err;
        }
    } else if (strict) {
        // Mirrors core/metadata.js: a strict caller's
        // correctness depends on the write being awaited before it proceeds, so a
        // missing saveMetadata must refuse rather than silently downgrading to the
        // debounced fallback. Without this the stub diverged from production and a
        // restore could report committed:true on metadata a reload could still lose.
        throw new Error('Strict metadata persistence is not available: the host does not expose an immediate saveMetadata API.');
    }
    persistChatMeta();
}

export function patchChatMeta(key, patch, _persist = true, stamp = false) {
    if (!_meta[key]) _meta[key] = {};
    const next = stamp
        ? { ..._meta[key], ...patch, lastUpdated: Date.now() }
        : { ..._meta[key], ...patch };
    _meta[key] = next;
    return next;
}

export function getLatestChronicleEntry() {
    const data = _meta.session_chronicle_data;
    if (!data?.snapshots?.length) return '';
    const sorted = [...data.snapshots].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sorted[0]?.text || '';
}

export function getCurrentWorldState() {
    return _meta[WORLD_STATE_METADATA_KEY]?.text || '';
}

// â”€â”€â”€ Re-exports of pure modules (so tests importing them via the barrel
//     still work without pulling in the ST-dependent originals) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// These ARE safe to use as-is because they have no ST dependencies.

export { escapeHtml, computeLcsDiff, buildInlineDiff, renderDiffHtml, renderLineDiff } from '../../core/diff.js';
export { stripNonNarrative, stripNonNarrativeFromFormatted } from '../../core/strip.js';

// Tier 0 shared primitives â€” pure modules, safe to re-export directly.
export {
    getEpoch,
    bumpEpoch,
    _resetEpoch,
    getCharacterIdentity as getScopeCharacterIdentity,
    getChatIdentity,
    captureScope,
    assertSameScope,
    getChatScopeKey,
} from '../../core/scope.js';
export {
    defaultNormalize,
    captureRevision,
    sameRevision,
    createRevisionClock,
    decideCommit,
} from '../../core/revision.js';
export {
    escapePromptText,
    escapePromptAttr,
    escapePromptBoundary,
    buildTag,
    wrapTag,
    truncateText,
    truncateTail,
    truncateArray,
    fitBudget,
    TRUNCATION_MARKER,
} from '../../core/prompt.js';

// â”€â”€â”€ Not-implemented stubs for the remaining barrel exports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// These cover functions that tests could import but the current starter tests
// don't exercise. If a future test needs one, implement it here. Importing them
// won't fail â€” but calling them will throw, making it obvious what to fill in.

function notImplemented(name) {
    return () => { throw new Error(`[test/stubs/core.js] "${name}" is not implemented in the test stub. Add it to test/stubs/core.js.`); };
}

export const normalizeApiBase = notImplemented('normalizeApiBase');
export const fetchFromApi = notImplemented('fetchFromApi');
export const fetchViaConnectionProfile = notImplemented('fetchViaConnectionProfile');
/**
 * Install a fake module API for integration-style tests. The implementation
 * receives the same request object a real module would pass to fetchFn.
 */
export function setFakeApi(fn) {
    _apiImpl = fn;
}
export function resolveApiCall({ moduleSettings = {}, globalSettings } = {}) {
    // Phase 4 provenance parity: report which level of core/api.js's 4-level
    // chain would have won, using the same precedence and source strings. The
    // fetch behavior is unchanged (the stub's simple fake — see setFakeApi);
    // only the `source` field is new.
    const globals = globalSettings ?? getGlobalSettings();
    const source = moduleSettings.connectionProfileId
        ? 'module-profile'
        : (moduleSettings.apiUrl && moduleSettings.modelName)
            ? 'module-custom'
            : globals?.connectionProfileId
                ? 'global-profile'
                : 'global-custom';
    return {
        mode: 'custom',
        settings: moduleSettings,
        source,
        fetchFn: async (request) => {
            if (typeof _apiImpl !== 'function') {
                throw new Error('[test/stubs/core.js] No fake API installed. Call setFakeApi().');
            }
            return _apiImpl(request);
        },
    };
}
export function normaliseOutput(value) {
    return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}
export const retryAsync = notImplemented('retryAsync');
export function parseJsonLenient(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch { return null; }
}
/**
 * In-memory stand-in for core/settings.js's factory.
 *
 * Mirrors the real contract that matters to callers: `getSettings()` returns
 * defaults merged with whatever has been saved, and `saveSettings(patch)`
 * merges a patch over the current values (so an unrelated save never drops
 * another key). Backed by `_extSettings`, which `resetCoreStubs()` clears.
 */
export function createSettingsManager({ settingsKey, defaults = {} }) {
    function getExtSettingsRef() {
        if (!_extSettings[settingsKey]) _extSettings[settingsKey] = {};
        return _extSettings[settingsKey];
    }
    function getSettings() {
        return { ...defaults, ..._extSettings[settingsKey] };
    }
    function saveSettings(patch) {
        _extSettings[settingsKey] = { ...getSettings(), ...patch };
        return true;
    }
    function hasValidSettings() {
        const s = getSettings();
        return !!(s.connectionProfileId || (s.apiUrl && s.modelName));
    }
    return { getSettings, saveSettings, hasValidSettings, getExtSettingsRef };
}
export const syncSharedConnectionSettings = notImplemented('syncSharedConnectionSettings');
export function getGlobalSettings() {
    return buildFakeContext().globalSettings || {};
}
export function injectionAllowed(moduleKey) {
    const settings = getGlobalSettings();
    return settings.injectionMasterOff !== true && settings[`enable${moduleKey}`] !== false;
}
export const createModal = notImplemented('createModal');
export const showModal = notImplemented('showModal');
export const hideModal = notImplemented('hideModal');
/**
 * Records status messages instead of touching the DOM. The real setStatus
 * returns early when the modal is null, so calling it with a closed modal is
 * legitimate â€” tests still see the call here, which is what lets them assert
 * that a discard path reported itself to the user.
 */
export function setStatus(modalIdOrEl, message, type = 'info', clearAfterMs = 0) {
    _statusCalls.push({ message, type, clearAfterMs });
}
export function getFakeStatusCalls() { return _statusCalls; }
export const formatDate = notImplemented('formatDate');
export function applyExtensionPromptInjection({
    key, header = '', body = '', enabled, globalDepth, fallbackDepth,
    globalRole = 'system', wrapperTag, useTags = true,
}) {
    const role = globalRole === 'user' ? 1 : globalRole === 'assistant' ? 2 : 0;
    // Finite-depth guard, mirroring the real core/injection.js: a
    // present-but-non-finite globalDepth falls back to the module depth —
    // never NaN.
    const depth = (globalDepth != null && Number.isFinite(Number(globalDepth))) ? Number(globalDepth) : fallbackDepth;
    const active = !!(enabled && body?.trim());
    // Payload construction, mirroring the real core/injection.js: header
    // prepended, then wrapInTag() (which boundary-escapes '<') when tags are
    // on and a wrapper is configured. A fake that skipped wrapping/escaping
    // would let feature-level diagnostics tests pass while asserting
    // snapshots production never registers — so this must stay faithful.
    // (wrapInTag below is this stub's mirror of the real one.)
    const inner = header?.trim() ? `${header}\n\n${body}` : body;
    const payload = active ? ((useTags && wrapperTag) ? wrapInTag(wrapperTag, inner) : inner) : '';
    _promptCalls.push({ key, payload, enabled: !!enabled, depth, role, wrapperTag, useTags });
    const ctx = buildFakeContext();
    ctx.setExtensionPrompt?.(key, payload, 1, depth, undefined, role);
    // Phase 2 parity with the real core/injection.js: record a diagnostics
    // snapshot whenever setExtensionPrompt is available (the real module
    // returns early — and records nothing — when it is not).
    if (typeof ctx.setExtensionPrompt === 'function') {
        recordInjection({ key, payload, role, depth, enabled: active });
    }
    return active;
}
export const roleToNumber = notImplemented('roleToNumber');
export function wrapInTag(tag, body) {
    if (!tag || !body?.trim()) return body || '';
    // Boundary-only escape: '<' is neutralized so a body cannot inject a
    // closing tag; '&' is preserved as legitimate prose. Mirrors the real
    // core/injection.js wrapInTag (escapePromptBoundary).
    const escaped = String(body).replace(/</g, '&lt;');
    return `<${tag}>\n${escaped}\n</${tag}>`;
}
export function notify(title, message, level = 'info') {
    _notifications.push({ title, message, level });
}
export function getFakePromptCalls() { return _promptCalls; }
export function getFakeNotifications() { return _notifications; }
export const downloadBlob = notImplemented('downloadBlob');
export function downloadJson(filename, data) {
    _downloadJsonCalls.push({ filename, data });
}
export function getFakeDownloadJsonCalls() { return _downloadJsonCalls; }
/**
 * Install a fake implementation of pickTextFile() for the duration of one test.
 * Pass a function (sync or async) that returns the file text, returns '' for a
 * quiet cancellation, or throws/rejects to simulate a read failure. Pass `null`
 * to restore the default not-implemented stub.
 */
export function setPickTextFileStub(fn) {
    _pickTextFileImpl = fn;
}
export async function pickTextFile(accept) {
    if (typeof _pickTextFileImpl === 'function') return _pickTextFileImpl(accept);
    return notImplemented('pickTextFile')();
}
/**
 * Minimal stand-in for the real API-settings field renderer.
 *
 * A module's render() calls this to fill in the shared connection block. Tests
 * that render a module are checking that module's OWN markup, so the block only
 * needs to be a string with the right field ids in it â€” reproducing the real
 * inputs would just couple these tests to core/ui.js's layout.
 */
export function renderApiSettingsFields(_s = {}, opts = {}) {
    const ids = Object.entries(opts)
        .filter(([k, v]) => k.endsWith('Id') && typeof v === 'string')
        .map(([, v]) => `<input id="${v}" value="">`)
        .join('');
    return `<div class="mwt-stub-api-fields">${ids}</div>`;
}

export function readApiSettingsValues() {
    return {};
}
export const createFloatingButtonBar = notImplemented('createFloatingButtonBar');
// Pure shared bounds — re-exported from the real module so production and test
// barrel consumers agree on the supported setting range.
export { DEFAULT_RECENT_HISTORY_EXCLUDE, MAX_RECENT_HISTORY_EXCLUDE } from '../../core/context.js';
export { MWT_VERSION } from '../../core/version.js';
// Diagnostics accessors (Phases 0–2). Re-exported from the REAL module so
// feature code reaching record()/getEvents()/... through the barrel sees the
// SAME singleton state under test as in production (the barrel→stub alias trap
// — see the phases doc, "Repo-specific traps"). diagnostics.js is a pure
// in-memory module with no SillyTavern dependency, so no faking is needed.
export {
    record,
    getEvents,
    clearEvents,
    setRunStart,
    setRunResult,
    getLastRun,
    getAllLastRuns,
    clearLastRuns,
    recordApiCall,
    getApiCalls,
    getLastApiCall,
    getAllLastApiCalls,
    clearApiCalls,
    recordInjection,
    getInjectedSnapshot,
    getAllInjectedSnapshots,
    clearInjections,
} from '../../core/diagnostics.js';
// Phase 5 redaction layer (core/redaction.js). Re-exported from the REAL
// module — it is pure, with no SillyTavern dependency — so barrel consumers
// see identical redaction behavior under test. The report tests pin this
// contract: secrets never survive in either content mode.
export {
    REDACTED,
    SECRET_KEYS,
    CONTENT_KEYS,
    redactApiUrl,
    redactCustomHeaders,
    redactSecretsDeep,
    redactForReport,
} from '../../core/redaction.js';
