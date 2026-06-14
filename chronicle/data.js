/**
 * chronicle/data.js — Constants, state, settings, data access, and helpers.
 *
 * Leaf module — no imports from other chronicle modules.
 */

import {
    getContextSafe, getChat, getChatMeta,
    escapeHtml,
    createSettingsManager,
    patchChatMeta,
} from '../core/index.js';

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
    setChronicleData({ msgSinceSnapshot: state.msgSinceSnapshot });
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
    el.querySelectorAll('.sc-status').forEach(s => {
        s.textContent = msg;
        s.className = 'sc-status';
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
    // Fallback: content-based lookup (fragile — breaks on reload)
    if (anchor.start || anchor.end || anchor.length) {
        const idx = chat.findIndex(m => {
            const mes = String(m.mes || '');
            const name = m.name || (m.is_user ? 'User' : 'Assistant');
            return name === anchor.name && mes.length === anchor.length && (!anchor.start || mes.slice(0, 80) === anchor.start) && (!anchor.end || mes.slice(-80) === anchor.end);
        });
        if (idx !== -1) return { index: idx + 1, found: true };
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
    if (!meta) return { snapshots: [], lastAnchor: null, injectEnabled: false, injectCount: 2, injectDepth: 2, autoSuggestAfter: AUTO_SUGGEST_AFTER, suggestSent: false, msgSinceSnapshot: 0 };
    if (!meta[CHRONICLE_KEY]) {
        meta[CHRONICLE_KEY] = { snapshots: [], lastAnchor: null, injectEnabled: false, injectCount: 2, injectDepth: 2, autoSuggestAfter: AUTO_SUGGEST_AFTER, suggestSent: false, msgSinceSnapshot: 0 };
    }
    return meta[CHRONICLE_KEY];
}

export function setChronicleData(patch) {
    patchChatMeta(CHRONICLE_KEY, patch);
}

export function getSnapshots() {
    const raw = getChronicleData().snapshots || [];
    let mutated = false;
    const fixed = raw.map(s => {
        if (s.id === undefined || s.id === null || s.id === '') {
            mutated = true;
            return { ...s, id: `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
        }
        if (typeof s.id !== 'string') { mutated = true; return { ...s, id: String(s.id) }; }
        return s;
    });
    if (mutated) setChronicleData({ snapshots: fixed });
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
    let end = (toIndex !== undefined && toIndex !== null) ? Math.min(toIndex + 1, chat.length) : chat.length;
    while (end > start) {
        const last = chat[end - 1];
        const streaming = last?.extra?.streaming === true || (last?.extra?.gen_started && !last?.extra?.gen_finished);
        const emptyAssistant = last && !last.is_user && !String(last.mes || '').trim();
        if (streaming || emptyAssistant) { end--; } else break;
    }
    const slice = chat.slice(start, end);
    const filtered = slice.filter(shouldIncludeMessage);
    if (filtered.length === 0) return { text: '', lastMsg: null, fromIndex: start, toIndex: end - 1 };
    const lines = [];
    let total = 0;
    // Character budget for the assembled message window.  This is deliberately
    // smaller than the `maxChars = 400000` budget used by core/context.js's
    // getRecentMessages(): chronicle snapshots feed a focused window into a
    // summarisation prompt, whereas getRecentMessages() is used for raw
    // context-building where more history is desirable.  Keeping these
    // independent lets each caller tune its own cost/quality trade-off.
    const MAX = 100000;
    for (let i = filtered.length - 1; i >= 0; i--) {
        const msg = filtered[i];
        const name = msg?.name || (msg.is_user ? 'User' : 'Assistant');
        const text = String(msg.mes || '').trim();
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