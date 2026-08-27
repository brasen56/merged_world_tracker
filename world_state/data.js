/**
 * world_state/data.js — Shared constants, mutable state, and data access.
 *
 * Leaf module — no imports from other world_state modules.
 */

import {
    getChatMeta, persistChatMeta, preserveQuarantinedRecords, escapeRegex,
} from '../core/index.js';
import { getSettings, saveSettings } from './settings.js';
import { prepareNextStoreValue, prepareStore } from '../core/schema.js';
import { worldStateSchema } from './schema.js';

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
    /** Counted receipt events by stable message identity. */
    countedReceiptEvents: new Map(),
};

// ─── Chat data helpers ───────────────────────────────────────────────────────

export function getWorldStateData() {
    const meta = getChatMeta();
    return meta?.[CHAT_DATA_KEY] || {};
}

/**
 * The World State write seam (design §8, Part 3): the COMPLETE proposed next
 * store — current data with the patch applied — is validated by the
 * registered worldState schema before anything is persisted. The write either
 * commits CANONICAL data (invalid records quarantined out of the live value,
 * their issues reported) or, on a fatal root problem, leaves the previous
 * value intact. The canonical result REPLACES the stored value (a merge would
 * resurrect a field the validator just rejected).
 *
 * This checked variant is the one callers that CANNOT proceed on a refused
 * write should use (design §8: "commit canonical data or leave the previous
 * value intact" — the UI import path may only apply/render/report success
 * after the write is confirmed): the result is discriminated instead of
 * returning the new-or-previous value, so a refusal is never mistaken for a
 * commit.
 *
 * @param {object} patch fields to overlay on the current store value
 * @param {object} [options]
 * @param {object[]|{issues: object[], sourceVersion: number}} [options.preserveIssues]
 *   EXTRA schema findings whose rejected records must be preserved in this
 *   same commit (design §5.2) even though they did not come from validating
 *   the proposed value — e.g. an import archive's findings. They ride the seam
 *   so the DESTINATION is validated first: a refused write mutates neither the
 *   store value nor the quarantine container, instead of the caller merging
 *   the container beforehand and stranding quarantine records when the write
 *   refuses. Pass a `{ issues, sourceVersion }` group to stamp those records
 *   with the version their SOURCE was at (an unversioned standalone archive is
 *   prepared from legacy version 0) rather than the destination's current
 *   version; a bare array keeps the historical current-version stamping for
 *   callers with no source version to report. Mirrors
 *   chronicle/data.js setChronicleDataChecked().
 * @returns {{ ok: boolean, data, reason?: string, message?: string, issues?: object[] }}
 *   `ok: true` — `data` is the committed canonical value. `ok: false` —
 *   `data` is the PREVIOUS value that was kept, with `reason` naming the
 *   refusal ('metadata-unavailable', 'validation-refused', or the quarantine
 *   container's refusal reason from preserveQuarantinedRecords).
 */
export function setWorldStateDataChecked(patch, { preserveIssues = [] } = {}) {
    const meta = getChatMeta();
    if (!meta) return { ok: false, data: undefined, reason: 'metadata-unavailable' };
    const next = prepareNextStoreValue(worldStateSchema, meta[CHAT_DATA_KEY], patch);
    if (!next.ok) {
        console.warn('[MWT:WorldState] Write refused — the proposed update failed schema validation; the previous value was kept.', next.issues);
        return { ok: false, data: meta[CHAT_DATA_KEY], reason: 'validation-refused', issues: next.issues };
    }
    for (const issue of next.issues) {
        console.warn(`[MWT:WorldState] ${issue.severity}: ${issue.message}`);
    }
    // §5.2: the canonical write is only allowed to commit if its rejected
    // records were preserved. A refused quarantine container means they cannot
    // be — leave the previous value intact instead. preserveIssues fold in
    // here — AFTER the destination validated — so a caller's external records
    // are preserved by (and only by) a write that actually commits. The
    // external group carries the version its SOURCE was at: stamping an
    // unversioned legacy archive's rejected records with the destination's
    // current version would misreport where they came from. Tagging each
    // external issue keeps this ONE preservation call — one refusal point.
    const external = Array.isArray(preserveIssues)
        ? { issues: preserveIssues, sourceVersion: worldStateSchema.currentVersion }
        : {
            issues: preserveIssues?.issues ?? [],
            sourceVersion: preserveIssues?.sourceVersion ?? worldStateSchema.currentVersion,
        };
    const externalIssues = external.issues.map(issue => ({ ...issue, sourceVersion: external.sourceVersion }));
    const preserved = preserveQuarantinedRecords(worldStateSchema.id, [...next.issues, ...externalIssues], { sourceVersion: worldStateSchema.currentVersion });
    if (!preserved.ok) {
        console.warn(`[MWT:WorldState] Write refused — quarantined records could not be preserved (${preserved.reason}); the previous value was kept.`);
        return { ok: false, data: meta[CHAT_DATA_KEY], reason: preserved.reason, message: preserved.message };
    }
    meta[CHAT_DATA_KEY] = next.data;
    persistChatMeta();
    return { ok: true, data: next.data };
}

/**
 * Historical unchecked wrapper over setWorldStateDataChecked(): returns the
 * written value on success and the KEPT previous value on refusal (so callers
 * that re-read the store afterwards stay correct), exactly as before the
 * checked seam existed.
 */
export function setWorldStateData(patch) {
    return setWorldStateDataChecked(patch).data;
}

// Exported (Phase 4 diagnostics, §I.4.6) so the settings-provenance surfaces —
// MWT.diagnostics.settingsProvenance() now, the panel Health/Injection tabs
// later — iterate the single source of truth instead of a second key list.
export const GLOBAL_SETTING_KEYS = ['injectEnabled', 'autoRefresh', 'autoRefreshInterval'];

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

/**
 * Resolve a behavior setting through the 3-level chain: per-chat override →
 * legacy top-level chat field → global (see usesGlobalDefaults).
 *
 * Phase 4 provenance (diagnostics design §I.4.6): pass `{ provenance: true }`
 * to get `{ value, source }` instead of the bare value, so a surface can show
 * WHERE a value came from — the value alone looks correct even when the
 * user's mental model of its origin is wrong ("Depth 4 (this chat)" vs
 * "Depth 4 (global default)"). Existing callers are unaffected.
 *
 * Stable `source` strings — consumed by MWT.diagnostics.settingsProvenance()
 * and later the panel; do not rename:
 *   'per-chat-override' — this chat's settingsOverride (Settings Scope
 *                        unchecked, value edited for this chat)
 *   'per-chat-legacy'   — a legacy top-level field on a pre-scope-feature
 *                        per-chat record (the usesGlobalDefaults heuristic)
 *   'builtin-default'   — local mode, key absent: the historical per-chat
 *                        default (LEGACY_LOCAL_DEFAULTS)
 *   'global'            — the shared module settings (Settings tab)
 *   'fallback'          — key absent everywhere: the caller's fallback
 *
 * @param {string} key
 * @param {*} [fallback]
 * @param {{ provenance?: boolean }} [opts]
 * @returns {*|{ value: *, source: string }}
 */
export function getEffectiveWorldSetting(key, fallback, { provenance = false } = {}) {
    const data = getWorldStateData();
    if (!usesGlobalDefaults()) {
        const override = data.settingsOverride?.[key];
        if (override !== undefined) {
            return provenance ? { value: override, source: 'per-chat-override' } : override;
        }
        if (data[key] !== undefined) {
            return provenance ? { value: data[key], source: 'per-chat-legacy' } : data[key];
        }
        const builtin = LEGACY_LOCAL_DEFAULTS[key];
        if (builtin != null) {
            return provenance ? { value: builtin, source: 'builtin-default' } : builtin;
        }
        return provenance ? { value: fallback, source: 'fallback' } : fallback;
    }
    const global = getSettings()[key];
    if (global != null) {
        return provenance ? { value: global, source: 'global' } : global;
    }
    return provenance ? { value: fallback, source: 'fallback' } : fallback;
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

// Standalone world-state archives predate the data-schema version marker, so
// the import always prepares from legacy version 0. One constant feeds BOTH
// the prepareStore version AND the quarantine sourceVersion the caller passes
// to the checked seam, so a rejected record's recovery metadata always names
// the version it actually came from. Twin of chronicle/import-export.js.
export const LEGACY_IMPORT_VERSION = 0;

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
 *   { ok: true,  kind: 'text',     text, issues } — world-state text (capped),
 *                                            from a recognized archive or
 *                                            plain text; `issues` are the
 *                                            schema findings against the
 *                                            archive's data section (empty
 *                                            for clean archives) so the
 *                                            caller can preserve rejected
 *                                            records in the same import
 *                                            commit (design §5.2)
 *   { ok: true,  kind: 'settings', settings } — settings archive
 *   { ok: false, reason }                     — rejected with a reason string
 *
 * @param {string} rawText — the raw file contents
 * @returns {{ ok: boolean, kind?: string, text?: string, settings?: object, issues?: object[], reason?: string }}
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
    // Part 3 (design §8): the recognized archive's data section runs through
    // the registered World State schema — the same owner as runtime loading,
    // backup imports, and the setWorldStateData write seam. A non-string
    // `text` is quarantined by the schema rather than silently coerced; only
    // the canonical text may proceed (the archive format carries `text` plus
    // optional history, and the import takes the text alone).
    //
    // Full PREPARATION, not a bare validate: standalone archives carry no
    // schema version, so they are prepared from LEGACY 0 exactly like the
    // Chronicle standalone import (chronicle/import-export.js). Validating at
    // the current version instead skipped the 0 -> 1 migration and — because
    // the findings were then stamped with the destination's current version —
    // recorded an unversioned legacy archive's rejected records as if they had
    // come from current-version data.
    const prepared = prepareStore(worldStateSchema, wsData, {
        version: LEGACY_IMPORT_VERSION,
        deferPolicy: 'canonicalize',
    });
    if (prepared.status === 'blocked') {
        return { ok: false, reason: prepared.error?.message ?? 'World state archive failed schema validation.' };
    }
    const importText = typeof prepared.data.text === 'string' ? prepared.data.text : '';
    if (!importText.trim()) {
        return { ok: false, reason: 'File has no valid world state text.' };
    }
    // The schema findings ride along so the caller can preserve the rejected
    // raw values (e.g. an invalid autoSaveHistory) in the SAME import commit
    // (§5.2), tagged with the version they actually came from. Previously they
    // were discarded here and the rejected data was lost permanently even
    // though the comment above promised a quarantine.
    return {
        ok: true,
        kind: 'text',
        text: importText.slice(0, MAX_IMPORT_CHARS),
        issues: prepared.issues,
        sourceVersion: LEGACY_IMPORT_VERSION,
    };
}

export function getWorldStateText() {
    return getWorldStateData().text || '';
}

// ─── History (auto-save snapshots) ──────────────────────────────────────────

export function getAutoSaveHistory() {
    return getWorldStateData().autoSaveHistory || [];
}

/**
 * Snapshot one outgoing text into the auto-save history and (optionally) commit
 * a store patch in the SAME checked write (design §8).
 *
 * The stored history is CLONED before anything is added: it is the live
 * metadata value, so mutating it in place would corrupt the "previous value
 * kept" guarantee the moment the checked setter refuses. A malformed stored
 * history (present but not an array) no longer throws at `.push` either — it
 * is routed through the checked seam first so the schema preserves its raw
 * value in quarantine (§5.2) instead of the clone silently discarding it.
 *
 * @param {string}  [snapshotText] outgoing text to append to history (skipped
 *   when empty/blank — same no-op the old pushToHistory had)
 * @param {object}  [patch]        additional fields (e.g. `{ text }`) committed
 *   atomically with the history snapshot
 * @param {object}  [options]
 * @param {object[]} [options.preserveIssues] extra schema findings preserved in
 *   the same commit (see setWorldStateDataChecked) — e.g. an import archive's
 *   findings, so the rejected records ride the write that lands them
 * @returns {{ ok: boolean, data, reason?: string, message?: string, issues?: object[] }}
 *   the checked-setter result — `ok: false` means NOTHING was written
 */
export function commitHistorySnapshot(snapshotText, patch = {}, { preserveIssues = [] } = {}) {
    const stored = getWorldStateData().autoSaveHistory;
    if (stored !== undefined && !Array.isArray(stored)) {
        // §5.2: a malformed (non-array) stored history must reach the schema
        // itself so its raw value is preserved in quarantine — substituting an
        // empty array here would silently discard it. It cannot travel in the
        // same patch as the snapshot (one field, two values), so the container
        // repair goes first, ALONE: it carries no caller data, so if the
        // snapshot write below refuses, `ok: false` is still honest — the
        // patch never landed, and all that persisted is a repair the store
        // owed itself. (Committing the caller's patch here too made the
        // refusal a lie: the text had already moved.)
        const canonicalized = setWorldStateDataChecked({ autoSaveHistory: stored });
        if (!canonicalized.ok) return canonicalized;
        // Append on a DETACHED copy: canonicalized.data is now the live stored
        // value, so pushing into its array would mutate chat metadata before
        // the checked write below validates it.
        return appendHistorySnapshot(
            cloneStoredHistory(canonicalized.data.autoSaveHistory), snapshotText, patch, { preserveIssues },
        );
    }
    return appendHistorySnapshot(cloneStoredHistory(stored), snapshotText, patch, { preserveIssues });
}

/** History entries are flat { text, timestamp } records, so a per-entry
 * shallow clone detaches the array from the stored value; invalid entries are
 * kept for the schema to quarantine inside the checked write itself. */
function cloneStoredHistory(stored) {
    return Array.isArray(stored)
        ? stored.map(entry => (entry && typeof entry === 'object' ? { ...entry } : entry))
        : [];
}

function appendHistorySnapshot(history, snapshotText, patch = {}, { preserveIssues = [] } = {}) {
    if (typeof snapshotText === 'string' && snapshotText.trim()) {
        history.push({ text: snapshotText, timestamp: Date.now() });
        if (history.length > 50) history.splice(0, history.length - 50);
    }
    return setWorldStateDataChecked({ ...patch, autoSaveHistory: history }, { preserveIssues });
}

export function pushToHistory(text) {
    // Nothing to snapshot: no write is needed (the historical no-op). The
    // synthetic result keeps the checked contract for callers that consume it.
    if (!text?.trim()) return { ok: true, data: getWorldStateData() };
    return commitHistorySnapshot(text);
}

export function pushAutoSave(text) {
    if (text === state.autoSaveLastText) return;
    const written = pushToHistory(text);
    // Advance the watermark only after a committed write: a refused snapshot
    // (unsafe store, quarantine preservation refused) must retry on the next
    // tick instead of being marked done while nothing was recorded.
    if (written.ok) state.autoSaveLastText = text;
}

// ─── Auto-refresh data queries ──────────────────────────────────────────────

export function isAutoRefreshEnabled() {
    return getEffectiveWorldSetting('autoRefresh', false) === true;
}

export function getAutoRefreshInterval() {
    return getEffectiveWorldSetting('autoRefreshInterval', 5) || 5;
}

export function persistAutoRefreshCounter() {
    setWorldStateData({
        autoRefreshCounter: state.autoRefreshCounter,
        countedReceiptEvents: [...state.countedReceiptEvents.entries()],
    });
}

export function resetAutoRefreshCounter() {
    state.autoRefreshCounter = 0;
    state.countedReceiptEvents.clear();
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