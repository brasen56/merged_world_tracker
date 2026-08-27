/**
 * chronicle/data.js — Constants, state, settings, data access, and helpers.
 *
 * Leaf module — no imports from other chronicle modules.
 */

import {
    getContextSafe, getChat, getChatMeta,
    escapeHtml,
    createSettingsManager,
    persistChatMeta,
    preserveQuarantinedRecords,
    stripNonNarrative,
    getStableHistoryEnd,
    getOrCreateReceiptIdentity,
} from '../core/index.js';

import { backfillSnapshotIds, chronicleSchema } from './schema.js';
import { prepareNextStoreValue } from '../core/schema.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SETTINGS_KEY = 'mwt_chronicle';
export const CHRONICLE_KEY = 'session_chronicle_data';
export const EXTENSION_PROMPT_KEY = 'session_chronicle_injection';
export const SC_VERSION = '0.7.4-mwt';
export const AUTO_SUGGEST_AFTER = 40;
export const MAX_TRASH_SIZE = 50;
export const MAX_ENTRY_WORD_COUNT = 2000;
export const MAX_CHARACTERS = 20;

// ─── Settings ────────────────────────────────────────────────────────────────

export const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    legacyKey: 'session_chronicle_settings',
    defaults: {
        // Diagnostics (Phase 6): stamps this module's key onto API telemetry
        // (core/api.js apiModule() → captureApiCall) so per-module views — the
        // Health tab's last-run column, MWT.diagnostics.lastApiCall('chronicle')
        // — actually key on it instead of everything landing under 'api'.
        module: 'chronicle',
        connectionProfileId: '',
        apiUrl: '',
        apiKey: '',
        modelName: '',
        maxTokens: 8000,
        temperature: 0.3,
        topP: 1.0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        customHeaders: '',
        filterSystem: true,
        filterOoc: true,
        autoSnapshot: false,
        autoSnapshotThreshold: 40,
        syncWorldState: true,
    },
    logPrefix: '[MWT:Chronicle]',
});

// ─── Shared mutable state ────────────────────────────────────────────────────

export const state = {
    modal: null,
    contentEl: null,
    isGenerating: false,
    isMainGenerating: false,
    selectedSnapshotId: null,
    consolidateMode: false,
    // User-designated BASE entry for the next consolidation (null = auto, by
    // earliest createdAt). Lets the user pin an already-consolidated entry as
    // the foundation and treat fresher entries as deltas, instead of letting
    // pure timestamp ordering decide which entry is the base.
    consolidateBaseId: null,
    bulkDeleteMode: false,
    checkedForMerge: new Set(),
    pendingSearch: '',
    _lastStatusMsg: '',
    _lastStatusLevel: '',
    msgSinceSnapshot: 0,
    /** Last observed chat length, used by onMessageDeleted to compute how many
     *  messages were removed during bulk deletes (e.g. "delete above/below"). */
    lastChatLength: 0,
    /** Receipt-event counts by stable message identity. Only events that
     * actually advanced the current cadence are recorded, so deletion can
     * reverse precisely those events (including repeated regenerations). */
    countedReceiptEvents: new Map(),
};

// ─── Late-binding registry for render functions ──────────────────────────────
// Populated by index.js at module-load time, before any user interaction.

export const _render = {
    renderContent: null,
    showRegenerateDiff: null,
    showConsolidationPreview: null,
};

// ─── Initialize persisted counter ────────────────────────────────────────────

try {
    const saved = getChronicleData()?.msgSinceSnapshot;
    state.msgSinceSnapshot = (typeof saved === 'number' && Number.isFinite(saved)) ? saved : 0;
} catch { /* ignore */ }

export function persistMsgSinceSnapshot() {
    setChronicleData({
        msgSinceSnapshot: state.msgSinceSnapshot,
        countedReceiptEvents: [...state.countedReceiptEvents.entries()],
    });
}

export function restoreReceiptBookkeeping(data = getChronicleData()) {
    const entries = Array.isArray(data?.countedReceiptEvents) ? data.countedReceiptEvents : [];
    state.countedReceiptEvents = new Map(entries.filter(([key, count]) =>
        typeof key === 'string' && key && Number.isInteger(count) && count > 0
    ));
}

export function getReceiptIdentity(message) {
    return getOrCreateReceiptIdentity(message);
}

// ─── Content helper ──────────────────────────────────────────────────────────

export function getContentEl() {
    if (state.contentEl) return state.contentEl;
    if (!state.modal) return null;
    state.contentEl = state.modal.querySelector('.mwt-tab-content[data-tab="chronicle"]');
    return state.contentEl;
}

export function scSetStatus(msg, level = 'info') {
    state._lastStatusMsg = msg;
    state._lastStatusLevel = level;
    const el = getContentEl();
    if (!el) return;
    el.querySelectorAll('.sc-status-text').forEach(s => {
        s.textContent = msg;
        s.className = 'sc-status-text';
        if (level) s.classList.add(`sc-status--${level}`);
    });
}

// ─── Anchor helpers ──────────────────────────────────────────────────────────

export function makeAnchor(msg) {
    if (!msg) return null;
    const chat = getChat();
    const mes = String(msg.mes || '');
    return {
        id: msg.id ?? null,
        msgIndex: chat.indexOf(msg),
        name: msg.name || (msg.is_user ? 'User' : 'Assistant'),
        start: mes.slice(0, 80),
        end: mes.slice(-80),
        length: mes.length,
    };
}

export function resolveAnchor(anchor) {
    const chat = getChat();
    if (!anchor) return { index: 0, found: true };
    // Fast path: stored message index (validated against content/ID)
    if (typeof anchor.msgIndex === 'number' && anchor.msgIndex >= 0 && anchor.msgIndex < chat.length) {
        const candidate = chat[anchor.msgIndex];
        if (candidate) {
            const mes = String(candidate.mes || '');
            const name = candidate.name || (candidate.is_user ? 'User' : 'Assistant');
            if (anchor.id !== null && anchor.id !== undefined && candidate.id === anchor.id) {
                return { index: anchor.msgIndex + 1, found: true };
            }
            if (anchor.start && anchor.end && anchor.length) {
                if (name === anchor.name && mes.length === anchor.length && mes.slice(0, 80) === anchor.start && mes.slice(-80) === anchor.end) {
                    return { index: anchor.msgIndex + 1, found: true };
                }
            }
        }
    }
    // Fallback: ID-based lookup
    if (anchor.id !== null && anchor.id !== undefined) {
        const idx = chat.findIndex(m => m.id === anchor.id);
        if (idx !== -1) return { index: idx + 1, found: true };
    }
    // Fallback: content-based lookup. CHRONICLE-05: find the LAST matching
    // message, not the first. Duplicate messages (common in roleplay when the
    // model repeats a line) caused the anchor to resume before the wrong
    // instance — the earliest duplicate rather than the latest. The anchor
    // points at the boundary message (the last one already chronicled), so
    // finding the last match is correct.
    if (anchor.start || anchor.end || anchor.length) {
        let lastIdx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            const mes = String(chat[i].mes || '');
            const name = chat[i].name || (chat[i].is_user ? 'User' : 'Assistant');
            if (name === anchor.name && mes.length === anchor.length && (!anchor.start || mes.slice(0, 80) === anchor.start) && (!anchor.end || mes.slice(-80) === anchor.end)) {
                lastIdx = i;
                break;
            }
        }
        if (lastIdx !== -1) return { index: lastIdx + 1, found: true };
    }
    return { index: 0, found: false };
}

// ─── Anchor staleness detection ──────────────────────────────────────────────

/**
 * Returns true if the message referenced by `anchor` has changed or disappeared
 * (edited / swiped / deleted), making the anchor's stored content fingerprint
 * no longer match the actual chat message at that position.
 *
 * This is used by the swipe/edit/delete event hooks to flag staleness so the
 * user knows the chronicle may be out of sync with the edited chat.
 */
export function isAnchorStale(anchor) {
    if (!anchor || typeof anchor.msgIndex !== 'number') return false;
    const chat = getChat();
    const candidate = chat[anchor.msgIndex];
    // Message gone (deleted) or index out of bounds
    if (!candidate) return true;
    const mes = String(candidate.mes || '');
    // If we tracked content, verify it still matches
    if (anchor.start && anchor.end && anchor.length) {
        if (mes.length !== anchor.length
            || mes.slice(0, 80) !== anchor.start
            || mes.slice(-80) !== anchor.end) {
            return true;
        }
    }
    return false;
}

// ─── Chronicle data ──────────────────────────────────────────────────────────

export function getChronicleData() {
    const meta = getChatMeta();
    if (!meta) return chronicleReadDefaults();
    const stored = meta[CHRONICLE_KEY];
    // Only a GENUINELY ABSENT root (undefined/null — the values the write seam
    // also treats as absent) is initialized with the canonical defaults; that
    // write is lossless. A PRESENT-but-invalid root ('' / 0 / false, or any
    // non-object) must survive the read untouched: replacing it here would
    // destroy the raw value before the write seam could fail closed on it
    // (prepareNextStoreValue refuses a present non-object), so the reader gets
    // a DETACHED default while the stored value stays recoverable.
    if (stored === undefined || stored === null) {
        meta[CHRONICLE_KEY] = chronicleReadDefaults();
    } else if (typeof stored !== 'object' || Array.isArray(stored)) {
        return chronicleReadDefaults();
    }
    return meta[CHRONICLE_KEY];
}

/** Runtime read defaults (injection/suggestion settings owned here, not by the
 *  schema — chronicle/schema.js createDefault covers the record containers). */
function chronicleReadDefaults() {
    return { snapshots: [], lastAnchor: null, injectEnabled: false, injectCount: 2, injectDepth: 2, autoSuggestAfter: AUTO_SUGGEST_AFTER, suggestSent: false, msgSinceSnapshot: 0 };
}

/**
 * The Chronicle write seam (design §8, Part 3): the COMPLETE proposed next
 * store — current data with the patch applied — is validated by the
 * registered chronicle schema before anything is persisted. The write either
 * commits CANONICAL data (invalid snapshots quarantined out of the live
 * value, their issues reported) or, on a fatal root problem, leaves the
 * previous value intact. The canonical result REPLACES the stored value (a
 * merge would resurrect a container the validator just rejected).
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
 *   the proposed value — e.g. a standalone import file's findings. They ride
 *   the seam so the DESTINATION is validated first: a refused write mutates
 *   neither the store value nor the quarantine container, instead of the
 *   caller merging the container beforehand and stranding quarantine records
 *   when the write refuses. Pass a `{ issues, sourceVersion }` group to stamp
 *   those records with the version their SOURCE was at (an unversioned
 *   standalone export is prepared from legacy version 0, design §6.2) rather
 *   than the destination's current version; a bare array keeps the historical
 *   current-version stamping for callers with no source version to report.
 * @returns {{ ok: boolean, data, reason?: string, message?: string, issues?: object[] }}
 *   `ok: true` — `data` is the committed canonical value. `ok: false` —
 *   `data` is the PREVIOUS value that was kept, with `reason` naming the
 *   refusal ('metadata-unavailable', 'validation-refused', or the quarantine
 *   container's refusal reason from preserveQuarantinedRecords).
 */
export function setChronicleDataChecked(patch, { preserveIssues = [] } = {}) {
    const meta = getChatMeta();
    if (!meta) return { ok: false, data: undefined, reason: 'metadata-unavailable' };
    const next = prepareNextStoreValue(chronicleSchema, meta[CHRONICLE_KEY], patch);
    if (!next.ok) {
        console.warn('[MWT:Chronicle] Write refused — the proposed update failed schema validation; the previous value was kept.', next.issues);
        return { ok: false, data: meta[CHRONICLE_KEY], reason: 'validation-refused', issues: next.issues };
    }
    for (const issue of next.issues) {
        console.warn(`[MWT:Chronicle] ${issue.severity}: ${issue.message}`);
    }
    // §5.2: the canonical write is only allowed to commit if its rejected
    // records were preserved. A refused quarantine container means they cannot
    // be — leave the previous value intact instead. preserveIssues fold in
    // here — AFTER the destination validated — so a caller's external records
    // are preserved by (and only by) a write that actually commits. The
    // external group carries the version its SOURCE was at (an unversioned
    // legacy export is version 0, design §6.2): stamping its records with the
    // destination's current version would misreport where they came from.
    // Tagging each external issue keeps this ONE preservation call — one
    // refusal point — for both groups.
    const external = Array.isArray(preserveIssues)
        ? { issues: preserveIssues, sourceVersion: chronicleSchema.currentVersion }
        : {
            issues: preserveIssues?.issues ?? [],
            sourceVersion: preserveIssues?.sourceVersion ?? chronicleSchema.currentVersion,
        };
    const externalIssues = external.issues.map(issue => ({ ...issue, sourceVersion: external.sourceVersion }));
    const preserved = preserveQuarantinedRecords(chronicleSchema.id, [...next.issues, ...externalIssues], { sourceVersion: chronicleSchema.currentVersion });
    if (!preserved.ok) {
        console.warn(`[MWT:Chronicle] Write refused — quarantined records could not be preserved (${preserved.reason}); the previous value was kept.`);
        return { ok: false, data: meta[CHRONICLE_KEY], reason: preserved.reason, message: preserved.message };
    }
    meta[CHRONICLE_KEY] = next.data;
    persistChatMeta();
    return { ok: true, data: next.data };
}

/**
 * Historical unchecked wrapper over setChronicleDataChecked(): returns the
 * written value on success and the KEPT previous value on refusal (so callers
 * that re-read the store afterwards stay correct), exactly as before the
 * checked seam existed.
 */
export function setChronicleData(patch) {
    return setChronicleDataChecked(patch).data;
}

export function getSnapshots() {
    const raw = getChronicleData().snapshots || [];
    // Part 2 (schema plan): the repair logic moved to chronicle/schema.js
    // backfillSnapshotIds() — the single owner shared with the v0 -> v1
    // migration. This compatibility call site stays for now and still
    // persists the fix on read; the runtime cutover (Part 6) retires it.
    const { snapshots: fixed, changed } = backfillSnapshotIds(raw);
    if (changed) setChronicleData({ snapshots: fixed });
    return fixed;
}

// ─── Character extraction ────────────────────────────────────────────────────

export function extractCharacters(chatSlice) {
    const names = new Set();
    chatSlice.forEach(msg => {
        if (msg.name && !msg.is_system) {
            const name = msg.name.trim();
            if (name && name !== 'User' && name !== 'Assistant') names.add(name);
        }
    });
    const ctx = getContextSafe();
    if (ctx?.character?.name?.trim()) names.add(ctx.character.name.trim());
    return Array.from(names).slice(0, MAX_CHARACTERS);
}

export function getCharactersInRange(fromIndex, toIndex) {
    return extractCharacters(getChat().slice(fromIndex, toIndex + 1));
}

// ─── Message filtering ───────────────────────────────────────────────────────

export function shouldIncludeMessage(msg) {
    const s = getSettings();
    const text = String(msg?.mes || '').trim();
    if (!text) return false;
    if (s.filterSystem && (msg.is_system || msg.extra?.type === 'system')) return false;
    if (s.filterOoc) {
        if (/^\s*\(/.test(text) || /^\s*OOC:/i.test(text) || /^\s*\[OOC\]/i.test(text)) return false;
    }
    return true;
}

// ─── Build message window ────────────────────────────────────────────────────

export function buildMessageWindow(fromIndex, toIndex) {
    const chat = getChat();
    const start = fromIndex ?? (() => { const { index } = resolveAnchor(getChronicleData().lastAnchor); return index; })();
    const explicitTo = toIndex !== undefined && toIndex !== null;
    let end = explicitTo ? Math.min(toIndex + 1, chat.length) : chat.length;
    while (end > start) {
        const last = chat[end - 1];
        const streaming = last?.extra?.streaming === true || (last?.extra?.gen_started && !last?.extra?.gen_finished);
        const emptyAssistant = last && !last.is_user && !String(last.mes || '').trim();
        if (streaming || emptyAssistant) { end--; } else break;
    }
    // When the caller didn't pin an explicit range (auto/manual snapshots up to
    // "now"), also drop the trailing in-flight user+assistant pair. A snapshot
    // is a frozen, persistent summary, so capturing a message that may still be
    // swiped/discarded would bake the misrepresented turn in permanently — and
    // the just-arrived AI reply is the single most likely message to be swiped.
    // Chronicle is anchor-based, so the exclusion is lossless: the pair simply
    // falls into the next snapshot's range. Regenerate/consolidate pass explicit
    // bounds and keep them unchanged.
    if (!explicitTo) end = Math.max(start, Math.min(end, getStableHistoryEnd(chat)));
    const slice = chat.slice(start, end);
    const filtered = slice.filter(shouldIncludeMessage);
    if (filtered.length === 0) return { text: '', lastMsg: null, fromIndex: start, toIndex: end - 1 };
    const lines = [];
    let total = 0;
    // Character budget for the assembled message window.  This is deliberately
    // smaller than the `maxChars = 500000` budget used by core/context.js's
    // getRecentMessages(): chronicle snapshots feed a focused window into a
    // summarisation prompt, whereas getRecentMessages() is used for raw
    // context-building where more history is desirable.  Keeping these
    // independent lets each caller tune its own cost/quality trade-off.
    const MAX = 100000;
    for (let i = filtered.length - 1; i >= 0; i--) {
        const msg = filtered[i];
        const name = msg?.name || (msg.is_user ? 'User' : 'Assistant');
        const text = stripNonNarrative(String(msg.mes || '').trim());
        const line = `${name}: ${text}`;
        if (total + line.length > MAX) break;
        lines.push(line);
        total += line.length + 1;
    }
    return { text: lines.reverse().join('\n'), lastMsg: filtered[filtered.length - 1], fromIndex: start, toIndex: end - 1 };
}

// ─── Message count ───────────────────────────────────────────────────────────

export function getMessageCountSinceLastSnapshot() {
    const chat = getChat();
    const anchor = getChronicleData().lastAnchor;
    const resolved = resolveAnchor(anchor);
    if (!resolved.found && anchor) return null;
    return Math.max(0, chat.length - resolved.index);
}

// ─── Confirmation dialog ─────────────────────────────────────────────────────

export function showConfirm(message, detail, onConfirm) {
    const el = getContentEl();
    if (!el) return;
    // Prevent stacking: if a confirmation dialog is already open, ignore
    // additional triggers (e.g. double-clicking "Consolidate" or pressing it
    // repeatedly while a confirm is still showing).
    if (el.querySelector('.sc-confirm-overlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'sc-confirm-overlay';
    overlay.innerHTML = `<div class="sc-confirm-box"><p>${escapeHtml(message)}</p>${detail ? `<p class="sc-confirm-detail">${escapeHtml(detail)}</p>` : ''}<div class="sc-confirm-actions"><button class="sc-confirm-yes sc-btn sc-btn--danger">Yes</button><button class="sc-confirm-no sc-btn">Cancel</button></div></div>`;
    el.style.position = 'relative';
    el.appendChild(overlay);
    const cleanup = () => { overlay.remove(); document.removeEventListener('keydown', handleKey); };
    const handleKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } };
    document.addEventListener('keydown', handleKey);
    overlay.querySelector('.sc-confirm-yes').addEventListener('click', () => { cleanup(); onConfirm(); });
    overlay.querySelector('.sc-confirm-no').addEventListener('click', () => cleanup());
}