/**
 * test/stubs/core.js — Fake SillyTavern runtime for tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * Most modules in this extension import helpers from `../core/index.js` (the
 * "barrel" file). Those helpers read from the live SillyTavern context — the
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

// ─── In-memory fake state ────────────────────────────────────────────────────
// These three variables ARE the "SillyTavern runtime" for our tests. The
// functions below are thin accessors over them. `resetCoreStubs()` clears
// them so tests don't leak state into one another.

let _chat = [];
let _meta = {};
let _contextExtras = {};
let _extSettings = {};

/**
 * Wipe all fake state. Call this in `beforeEach` so every test starts clean.
 */
export function resetCoreStubs() {
    _chat = [];
    _meta = {};
    _contextExtras = {};
    _extSettings = {};
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

// ─── Fake context object ─────────────────────────────────────────────────────
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

// ─── Mirrors of core/context.js ──────────────────────────────────────────────

export function getContextSafe() {
    return buildFakeContext();
}

export function getChat() {
    return _chat;
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
} = {}) {
    let slice = _chat.slice(-maxMessages);
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
    return null;
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

// ─── Mirrors of core/metadata.js ─────────────────────────────────────────────

export const WORLD_STATE_METADATA_KEY = 'world_state_tracker_metadata';

export function persistChatMeta() { /* no-op in tests */ }

export async function persistChatMetaNow() { /* no-op in tests */ }

export function patchChatMeta(key, patch, persist = true, stamp = false) {
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

// ─── Re-exports of pure modules (so tests importing them via the barrel
//     still work without pulling in the ST-dependent originals) ───────────────
// These ARE safe to use as-is because they have no ST dependencies.

export { escapeHtml, computeLcsDiff, buildInlineDiff, renderDiffHtml, renderLineDiff } from '../../core/diff.js';
export { stripNonNarrative, stripNonNarrativeFromFormatted } from '../../core/strip.js';

// Tier 0 shared primitives — pure modules, safe to re-export directly.
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
    buildTag,
    wrapTag,
    truncateText,
    truncateTail,
    truncateArray,
    fitBudget,
    TRUNCATION_MARKER,
} from '../../core/prompt.js';

// ─── Not-implemented stubs for the remaining barrel exports ──────────────────
// These cover functions that tests could import but the current starter tests
// don't exercise. If a future test needs one, implement it here. Importing them
// won't fail — but calling them will throw, making it obvious what to fill in.

function notImplemented(name) {
    return () => { throw new Error(`[test/stubs/core.js] "${name}" is not implemented in the test stub. Add it to test/stubs/core.js.`); };
}

export const normalizeApiBase = notImplemented('normalizeApiBase');
export const fetchFromApi = notImplemented('fetchFromApi');
export const fetchViaConnectionProfile = notImplemented('fetchViaConnectionProfile');
export const resolveApiCall = notImplemented('resolveApiCall');
export const normaliseOutput = notImplemented('normaliseOutput');
export const retryAsync = notImplemented('retryAsync');
export const parseJsonLenient = notImplemented('parseJsonLenient');
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
export const getGlobalSettings = notImplemented('getGlobalSettings');
export const injectionAllowed = notImplemented('injectionAllowed');
export const createModal = notImplemented('createModal');
export const showModal = notImplemented('showModal');
export const hideModal = notImplemented('hideModal');
export const setStatus = notImplemented('setStatus');
export const formatDate = notImplemented('formatDate');
export const applyExtensionPromptInjection = notImplemented('applyExtensionPromptInjection');
export const roleToNumber = notImplemented('roleToNumber');
export const wrapInTag = notImplemented('wrapInTag');
export const notify = notImplemented('notify');
export const downloadBlob = notImplemented('downloadBlob');
export const downloadJson = notImplemented('downloadJson');
export const pickTextFile = notImplemented('pickTextFile');
/**
 * Minimal stand-in for the real API-settings field renderer.
 *
 * A module's render() calls this to fill in the shared connection block. Tests
 * that render a module are checking that module's OWN markup, so the block only
 * needs to be a string with the right field ids in it — reproducing the real
 * inputs would just couple these tests to core/ui.js's layout.
 */
export function renderApiSettingsFields(s = {}, opts = {}) {
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