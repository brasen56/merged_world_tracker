/**
 * world_state/data.js — Shared constants, mutable state, and data access.
 *
 * Leaf module — no imports from other world_state modules.
 */

import {
    getChatMeta, patchChatMeta, escapeRegex,
} from '../core/index.js';
import { getSettings, saveSettings } from './settings.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const CHAT_DATA_KEY = 'world_state_tracker_metadata';

export const SECTIONS = [
    'Current Scene',
    'Recent Changes',
    'Off-Screen',
    'Pending',
    'Active Threads',
    'Unresolved Threads',
    'World Pressures',
    'Key Character States',
    'Story Momentum',
    'Plot Seeds',
    'Potential Entrances',
];

export const VARIETY_LABELS = {
    1: 'Conservative',
    2: 'Balanced',
    3: 'Varied',
    4: 'Wild',
    5: 'Chaotic',
};

// Lookahead marking where the CURRENT "## Section" block ends and the next one
// begins. Used when extracting/replacing or injecting a single section.
const NEXT_SECTION_LOOKAHEAD_SRC =
    '(?=\\s*\\n#{1,6}[ \\t]' +
    `|\\s*\\n[ \\t]*(?:#{1,6}[ \\t]+)?\\*{0,2}(?:${SECTIONS.map(escapeRegex).join('|')})\\*{0,2}[ \\t]*(?:\\n|$)` +
    '|\\s*$)';

/** Frozen string — safe to import and use in any RegExp constructor. */
export const NEXT_SECTION_LOOKAHEAD = NEXT_SECTION_LOOKAHEAD_SRC;

// ─── Section extraction / replacement ────────────────────────────────────────
// Lives here (not sections.js) so provenance.js can reuse it without a
// circular import (sections.js already imports provenance.js).

// `\b` requires a word char on (at least) one side of the boundary, which
// silently fails to match right after a section name ending in punctuation
// (e.g. "Archive (Stale)" ends in ")"). A negative lookahead for "still part
// of a longer word" works for both word- and punctuation-ending names.
const SECTION_NAME_BOUNDARY = '(?![A-Za-z0-9_])';

/**
 * Pull out exactly one "## Section\n...body..." block from a larger text.
 * Stops at the next "## " header or end of text.
 *
 * WORLD-STATE-06: The `## Section` pattern is now line-anchored (`^` / multiline)
 * so a body line containing that sequence is NOT read as a section boundary.
 * Without the anchor, a body line like "We discussed ## Plot Seeds in the
 * meeting" would be treated as a section header and truncate the extraction.
 */
export function extractOnlySection(text, sectionName) {
    const escaped = escapeRegex(sectionName);
    // WORLD-STATE-06: Anchor with `(?:^|\n)` so a body line containing the
    // section name mid-sentence is NOT read as a section header. We do NOT
    // use the `m` flag — that would make `$` in NEXT_SECTION_LOOKAHEAD match
    // at every line end, truncating sections to just their header line.
    const pattern = new RegExp(`(?:^|\\n)(## ${escaped}${SECTION_NAME_BOUNDARY}[\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`);
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
}

/**
 * Replace one "## Section" block in the document with newContent.
 * If the section doesn't already exist, append it.
 *
 * WORLD-STATE-06: Line-anchored so only a header line (not a body line
 * containing the section name) is replaced.
 */
export function replaceSection(text, sectionName, newContent) {
    const escaped = escapeRegex(sectionName);
    // WORLD-STATE-06: Same `(?:^|\n)` anchor as extractOnlySection.
    const pattern = new RegExp(`(?:^|\\n)## ${escaped}${SECTION_NAME_BOUNDARY}[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`);
    const trimmed = newContent.trim();
    if (pattern.test(text)) {
        // Replace including the leading newline so we don't leave a blank line.
        return text.replace(pattern, () => '\n' + trimmed);
    }
    return (text.trim() + '\n\n' + trimmed).trim();
}

// ─── Mutable shared state ────────────────────────────────────────────────────

export const state = {
    wstIsRefreshing: false,
    autoRefreshCounter: 0,
    autoRefreshQueued: false,
    autoSaveLastText: '',
    autoSaveTimer: null,
    /** Debounce timer that persists live editor edits to metadata (see render.js). */
    editorPersistTimer: null,
    /** True once the current editing burst has snapshotted its baseline to
     *  history. Reset by any canonical state change (save/refresh/import/…) so
     *  the next burst snapshots again. */
    editSessionActive: false,
    autoRefreshDeferTimer: null,
    isDirty: false,
    modal: null,
    /** Last observed chat length, used by onMessageDeleted to compute how many
     *  messages were removed during bulk deletes (e.g. "delete above/below"). */
    lastChatLength: 0,
};

// ─── Chat data helpers ───────────────────────────────────────────────────────

export function getWorldStateData() {
    const meta = getChatMeta();
    return meta?.[CHAT_DATA_KEY] || {};
}

export function setWorldStateData(patch) {
    patchChatMeta(CHAT_DATA_KEY, patch);
}

const GLOBAL_SETTING_KEYS = ['injectEnabled', 'autoRefresh', 'autoRefreshInterval'];

// Historical per-chat defaults for legacy local records.
const LEGACY_LOCAL_DEFAULTS = { injectEnabled: true, autoRefresh: false, autoRefreshInterval: 5 };

export function usesGlobalDefaults() {
    const data = getWorldStateData();
    if (typeof data.useGlobalDefaults === 'boolean') return data.useGlobalDefaults;
    return !GLOBAL_SETTING_KEYS.some(key => Object.prototype.hasOwnProperty.call(data, key));
}

export function setUsesGlobalDefaults(useGlobal) {
    if (useGlobal === true) {
        setWorldStateData({ useGlobalDefaults: true });
        return;
    }
    // This only ever fires while the chat is currently on global defaults (the
    // checkbox can't be unchecked from an already-unchecked state), so the
    // snapshot must come from what's live right now — not from a stale
    // settingsOverride left by an earlier local session, or a stale top-level
    // field left by a pre-this-feature per-chat record. Preferring either of
    // those would silently resurrect a value the user isn't currently seeing.
    const globalSettings = getSettings();
    const overrides = {};
    for (const key of GLOBAL_SETTING_KEYS) {
        overrides[key] = globalSettings[key] ?? LEGACY_LOCAL_DEFAULTS[key];
    }
    setWorldStateData({ useGlobalDefaults: false, settingsOverride: overrides });
}

export function getEffectiveWorldSetting(key, fallback) {
    const data = getWorldStateData();
    if (!usesGlobalDefaults()) {
        const override = data.settingsOverride?.[key];
        if (override !== undefined) return override;
        if (data[key] !== undefined) return data[key];
        return LEGACY_LOCAL_DEFAULTS[key] ?? fallback;
    }
    return getSettings()[key] ?? fallback;
}

export function setWorldSetting(key, value) {
    if (usesGlobalDefaults()) saveSettings({ [key]: value });
    else setWorldStateData({ settingsOverride: { ...(getWorldStateData().settingsOverride || {}), [key]: value } });
}

// ─── Import validation (WORLD-STATE-07) ──────────────────────────────────────

/**
 * Maximum size (characters) of an imported world-state document. Applied to
 * BOTH plain-text and JSON imports so an enormous blob can't bloat chat
 * metadata and future prompts.
 */
export const MAX_IMPORT_CHARS = 200000;

const WS_ARCHIVE_TYPE = 'world-state-archive';
const WS_SETTINGS_TYPE = 'world-state-tracker-settings';

/**
 * Parse and validate imported world-state content.
 *
 * WORLD-STATE-07: the old importer accepted `data.data || data` with no shape
 * check, wrote `wsData.text || ''` with no type/size guard, and only capped
 * JSON imports — so a truthy non-string `text`, an unrelated archive that
 * merely happened to carry a string `text`, or an arbitrarily large plain-text
 * file could all land in metadata. This pure helper centralizes validation so
 * it is unit-testable; `render.js` consumes the result.
 *
 * Result shapes:
 *   { ok: true,  kind: 'text',     text }   — world-state text (capped), from
 *                                            a recognized archive or plain text
 *   { ok: true,  kind: 'settings', settings } — settings archive
 *   { ok: false, reason }                     — rejected with a reason string
 *
 * @param {string} rawText — the raw file contents
 * @returns {{ ok: boolean, kind?: string, text?: string, settings?: object, reason?: string }}
 */
export function parseWorldStateImport(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
        return { ok: false, reason: 'File is empty.' };
    }

    const looksJson = rawText.trim().startsWith('{');
    if (!looksJson) {
        // Plain-text import. Previously plain text bypassed the size cap that
        // only JSON imports received — apply it here too.
        const text = rawText.slice(0, MAX_IMPORT_CHARS);
        if (!text.trim()) return { ok: false, reason: 'File has no world state text.' };
        return { ok: true, kind: 'text', text };
    }

    let data;
    try {
        data = JSON.parse(rawText);
    } catch (err) {
        return { ok: false, reason: `Invalid JSON: ${err.message}` };
    }
    if (data == null || typeof data !== 'object') {
        return { ok: false, reason: 'JSON is not an object.' };
    }

    // Settings archive — handled separately by the caller.
    if (data._meta?.type === WS_SETTINGS_TYPE && data.settings) {
        return { ok: true, kind: 'settings', settings: data.settings };
    }

    // When an archive _meta is present, require a recognized type/version.
    // This stops an unrelated archive (a character card, preset, etc.) that
    // merely happens to carry a string `text` from silently wiping the state.
    if (data._meta && data._meta.type && data._meta.type !== WS_ARCHIVE_TYPE) {
        return { ok: false, reason: `Unrecognized archive type "${data._meta.type}".` };
    }

    const wsData = (data.data && typeof data.data === 'object' && data.data !== null) ? data.data : data;
    const importText = (wsData && typeof wsData.text === 'string') ? wsData.text : '';
    if (!importText.trim()) {
        return { ok: false, reason: 'File has no valid world state text.' };
    }
    return { ok: true, kind: 'text', text: importText.slice(0, MAX_IMPORT_CHARS) };
}

export function getWorldStateText() {
    return getWorldStateData().text || '';
}

// ─── History (auto-save snapshots) ──────────────────────────────────────────

export function getAutoSaveHistory() {
    return getWorldStateData().autoSaveHistory || [];
}

export function pushToHistory(text) {
    if (!text?.trim()) return;
    const history = getAutoSaveHistory();
    history.push({ text, timestamp: Date.now() });
    if (history.length > 50) history.splice(0, history.length - 50);
    setWorldStateData({ autoSaveHistory: history });
}

export function pushAutoSave(text) {
    if (text === state.autoSaveLastText) return;
    pushToHistory(text);
    state.autoSaveLastText = text;
}

// ─── Auto-refresh data queries ──────────────────────────────────────────────

export function isAutoRefreshEnabled() {
    return getEffectiveWorldSetting('autoRefresh', false) === true;
}

export function getAutoRefreshInterval() {
    return getEffectiveWorldSetting('autoRefreshInterval', 5) || 5;
}

export function persistAutoRefreshCounter() {
    setWorldStateData({ autoRefreshCounter: state.autoRefreshCounter });
}

export function resetAutoRefreshCounter() {
    state.autoRefreshCounter = 0;
    persistAutoRefreshCounter();
}

// ─── Injection flags ─────────────────────────────────────────────────────────

export function isInjectionEnabled() {
    return getEffectiveWorldSetting('injectEnabled', true) !== false;
}

// ─── Scan helpers ────────────────────────────────────────────────────────────

export function getMaxScanMessages(settings) {
    const raw = settings.maxScanMessages;
    if (!raw || isNaN(raw)) return 20;
    return Math.min(Math.max(1, Math.round(raw)), 30);
}

// ─── Provenance (see STALE_ENTRY_EXPIRY_DESIGN.md) ──────────────────────────
// Read-only tracking of when each entity was last mentioned. Phase 1 only:
// building + querying. Nothing currently mutates world-state text based on
// this data (no expiry, no grounding gate — see the design doc for those).

const EMPTY_PROVENANCE = Object.freeze({ entities: {}, lastBuiltAtMsgIndex: 0, schemaVersion: 1 });

export function getProvenance() {
    return getWorldStateData().provenance || EMPTY_PROVENANCE;
}

export function setProvenance(provenance) {
    setWorldStateData({ provenance });
}