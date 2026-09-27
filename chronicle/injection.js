/**
 * chronicle/injection.js — Prompt injection logic.
 *
 * Handles which entries to inject, building the injection body,
 * and applying/removing the extension prompt.
 */

import {
    getGlobalSettings, estimateTokens,
    applyExtensionPromptInjection, injectionAllowed,
} from '../core/index.js';
// Part 6 injection pause guard. Direct import (not the barrel) so the REAL
// pause singleton is read even under the test barrel→stub alias.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';

import { CHRONICLE_INJECTION_HEADER } from './prompts.js';

import {
    EXTENSION_PROMPT_KEY,
    getChronicleData, getSnapshots,
} from './data.js';

// ─── Injection settings ──────────────────────────────────────────────────────

/** The modes the ⚙ Injection settings view offers. */
export const INJECT_MODES = Object.freeze(['recent', 'selected', 'all', 'range']);

// ISO 8601 dates: what the view's <input type="datetime-local"> writes (a
// date, optionally with a time), plus an optional zone designator so a full
// timestamp like "2026-01-03T00:00:00Z" keeps filtering as it always has.
// Date.parse() alone is not a sufficient check — V8 accepts
// "Tue Mar 01 2011 (<img>)" because it treats the parentheses as a comment.
const INJECT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function injectDateOrEmpty(value) {
    return typeof value === 'string' && INJECT_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value))
        ? value
        : '';
}

/**
 * This chat's injection selection settings, in a known-good shape.
 *
 * They live in chat metadata that the Chronicle schema passes through
 * unvalidated (it checks only the record lists), and that metadata can
 * arrive from outside MWT: a Chronicle import, a shared .jsonl chat
 * (SillyTavern copies its chat_metadata verbatim), or a backup restore.
 * Every consumer — selection, stats, the settings view — reads through here,
 * so a malformed value falls back to its default instead of reaching a
 * slice(), a date comparison, or the page. M2-07 (docs/TODO.md §0). Rendering
 * still escapes these values: this is a type check, not the XSS boundary.
 *
 * @param {object} [data] the Chronicle store (defaults to this chat's)
 * @returns {{ mode: string, count: number, fromDate: string, toDate: string, selectedIds: string[] }}
 */
export function getInjectionSettings(data = getChronicleData()) {
    const src = data && typeof data === 'object' ? data : {};
    const rawCount = src.injectCount;
    const count = (typeof rawCount === 'number' || typeof rawCount === 'string') ? Number(rawCount) : NaN;
    return {
        mode: INJECT_MODES.includes(src.injectMode) ? src.injectMode : 'recent',
        count: Number.isFinite(count) && count >= 1 ? Math.floor(count) : 2,
        fromDate: injectDateOrEmpty(src.injectFromDate),
        toDate: injectDateOrEmpty(src.injectToDate),
        selectedIds: Array.isArray(src.selectedForInjection)
            ? src.selectedForInjection.filter(id => typeof id === 'string')
            : [],
    };
}

// ─── Injection ───────────────────────────────────────────────────────────────

export function isInjectionEnabled() {
    return !!getChronicleData().injectEnabled;
}

export function getEntriesForInjection() {
    const data = getChronicleData();
    const snapshots = getSnapshots();
    const { mode, count, fromDate, toDate, selectedIds } = getInjectionSettings(data);
    if (mode === 'recent') return snapshots.slice(-count);
    if (mode === 'selected') return snapshots.filter(s => selectedIds.includes(s.id));
    if (mode === 'all') return [...snapshots];
    if (mode === 'range') {
        // CHRONICLE-06: Open-ended range semantics. A single bound now filters
        // one direction instead of silently returning nothing (the old code
        // required BOTH dates or injected zero entries while still reporting
        // Range mode as active). `from` only → everything after it; `to` only →
        // everything before it; neither → unbounded (all). A reversed pair is
        // normalised rather than producing an empty injection.
        const from = fromDate ? new Date(fromDate) : null;
        const to = toDate ? new Date(toDate) : null;
        let lo = from;
        let hi = to;
        if (from && to && from > to) { lo = to; hi = from; }
        return snapshots.filter(s => {
            const created = new Date(s.createdAt);
            if (lo && created < lo) return false;
            if (hi && created > hi) return false;
            return true;
        });
    }
    return [];
}

/** The one body used by the live prompt, the preview and token estimates. */
export function buildChronicleInjectionBody(entries = getEntriesForInjection(), snapshots = getSnapshots()) {
    return [...entries].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map(s => {
            const num = snapshots.indexOf(s) + 1;
            const charInfo = s.characters?.length ? ` [${s.characters.join(', ')}]` : '';
            return `### Chronicle Entry ${num} — ${s.worldDate || s.createdAt}${charInfo}\n${s.text}`;
        }).join('\n\n---\n\n');
}

export function buildChronicleInjectionText() {
    const body = buildChronicleInjectionBody();
    return body ? `${CHRONICLE_INJECTION_HEADER}\n\n${body}` : '';
}

export function getInjectionStats() {
    const snapshots = getSnapshots();
    const { mode: injectMode, count: injectCount } = getInjectionSettings();
    const totalEntries = snapshots.length;
    const manualCount = snapshots.filter(s => s.manual).length;
    const consolidatedCount = snapshots.filter(s => s.consolidated).length;
    const totalWords = snapshots.reduce((sum, s) => sum + (s.text?.split(/\s+/).length || 0), 0);
    const entriesToInject = getEntriesForInjection();
    const injectionText = entriesToInject.length ? buildChronicleInjectionText() : '';
    const tokenEstimate = estimateTokens(injectionText);
    const allCharacters = new Set();
    snapshots.forEach(s => { if (s.characters) s.characters.forEach(c => allCharacters.add(c)); });
    return { totalEntries, manualCount, consolidatedCount, generatedCount: totalEntries - manualCount, totalWords, entriesToInject: entriesToInject.length, tokenEstimate, characterCount: allCharacters.size, characters: Array.from(allCharacters), injectMode, injectCount };
}

/**
 * Resolve the depth/role Chronicle's injection will use, WITH provenance —
 * the exact precedence applyInjection() hands to applyExtensionPromptInjection():
 *   depth — global `chronicleDepth` (Settings tab; a present, finite value
 *           wins) → THIS CHAT's `injectDepth` (Chronicle tab, chat metadata)
 *           → built-in 2
 *   role  — global `chronicleRole` (truthy wins) → built-in 'system'
 *
 * Phase 9 (diagnostics design §I.4.6, §I.5 Tab 4): the apply path and the 💉
 * Injection tab call the SAME function, so what the tab reports and what the
 * applier registers cannot drift. `source` strings are stable API —
 * 'global' | 'module' | 'builtin' (rendered via PLACEMENT_SOURCE_LABELS,
 * diagnostics_panel/injection.js); do not rename. For Chronicle the 'module'
 * level is per-chat data, not a settings store — the tab labels it so.
 *
 * @returns {{depth: {value: number, source: string}, role: {value: string, source: string}}}
 */
export function resolveInjectionPlacement() {
    const globalSettings = getGlobalSettings();
    const gd = globalSettings.chronicleDepth;
    const globalDepthWins = gd != null && Number.isFinite(Number(gd));
    // Chat metadata (M2-07): only a finite, non-negative number (or numeric
    // string) is a depth — anything else reads as absent and falls through to
    // the built-in 2, exactly like a missing value.
    const rawChatDepth = getChronicleData().injectDepth;
    const chatDepthNum = typeof rawChatDepth === 'number'
        || (typeof rawChatDepth === 'string' && rawChatDepth.trim() !== '')
        ? Number(rawChatDepth)
        : NaN;
    const chatDepth = Number.isFinite(chatDepthNum) && chatDepthNum >= 0 ? Math.floor(chatDepthNum) : null;
    return {
        depth: {
            value: globalDepthWins ? Number(gd) : (chatDepth ?? 2),
            source: globalDepthWins ? 'global' : (chatDepth != null ? 'module' : 'builtin'),
        },
        role: {
            value: globalSettings.chronicleRole || 'system',
            source: globalSettings.chronicleRole ? 'global' : 'builtin',
        },
    };
}

export function applyInjection() {
    // Part 6: a store paused by the runtime schema gate is never read — no
    // module injects an unprepared store (§7.4). Clearing the slot (the same
    // thing every disabled path does) also drops anything a pre-pause state
    // left registered, so nothing stale rides along.
    const paused = isStorePausedForCurrentScope('chronicle');
    if (paused) console.log('[MWT:Chronicle] Injection cleared — the store is paused for this chat (schema preparation).');
    const enabled = !paused && isInjectionEnabled() && injectionAllowed('Chronicle');
    const snapshots = paused ? [] : getSnapshots();

    const globalSettings = getGlobalSettings();
    // Placement comes fully resolved from resolveInjectionPlacement() (Phase 9).
    // It is passed as the fallback depth so the injector's own
    // globalDepth/fallbackDepth split stays inert — one resolver, two consumers
    // (this apply + the 💉 Injection diagnostics tab).
    const placement = resolveInjectionPlacement();

    const body = enabled && snapshots.length > 0 ? buildChronicleInjectionBody() : '';

    applyExtensionPromptInjection({
        key: EXTENSION_PROMPT_KEY,
        header: CHRONICLE_INJECTION_HEADER,
        body,
        enabled,
        fallbackDepth: placement.depth.value,
        globalRole: placement.role.value,
        wrapperTag: 'mwt_chronicle',
        useTags: globalSettings.structuralBoundaries !== false,
    });
}
