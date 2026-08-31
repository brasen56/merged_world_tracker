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

// ─── Injection ───────────────────────────────────────────────────────────────

export function isInjectionEnabled() {
    return !!getChronicleData().injectEnabled;
}

export function getEntriesForInjection() {
    const data = getChronicleData();
    const snapshots = getSnapshots();
    const mode = data.injectMode || 'recent';
    const count = data.injectCount || 2;
    if (mode === 'recent') return snapshots.slice(-count);
    if (mode === 'selected') return snapshots.filter(s => (data.selectedForInjection || []).includes(s.id));
    if (mode === 'all') return [...snapshots];
    if (mode === 'range') {
        const { injectFromDate, injectToDate } = data;
        // CHRONICLE-06: Open-ended range semantics. A single bound now filters
        // one direction instead of silently returning nothing (the old code
        // required BOTH dates or injected zero entries while still reporting
        // Range mode as active). `from` only → everything after it; `to` only →
        // everything before it; neither → unbounded (all). A reversed pair is
        // normalised rather than producing an empty injection.
        const from = injectFromDate ? new Date(injectFromDate) : null;
        const to = injectToDate ? new Date(injectToDate) : null;
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

export function getInjectionStats() {
    const snapshots = getSnapshots();
    const data = getChronicleData();
    const injectMode = data.injectMode || 'recent';
    const injectCount = data.injectCount || 2;
    const totalEntries = snapshots.length;
    const manualCount = snapshots.filter(s => s.manual).length;
    const consolidatedCount = snapshots.filter(s => s.consolidated).length;
    const totalWords = snapshots.reduce((sum, s) => sum + (s.text?.split(/\s+/).length || 0), 0);
    const entriesToInject = getEntriesForInjection();
    const injectionText = entriesToInject.map(s => s.text || '').join('\n\n---\n\n');
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
    const chatDepth = getChronicleData().injectDepth;
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

    let body = '';
    if (enabled && snapshots.length > 0) {
        const entries = getEntriesForInjection();
        if (entries.length > 0) {
            entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            body = entries.map(s => {
                const num = snapshots.indexOf(s) + 1;
                const charInfo = s.characters?.length ? ` [${s.characters.join(', ')}]` : '';
                return `### Chronicle Entry ${num} — ${s.worldDate || s.createdAt}${charInfo}\n${s.text}`;
            }).join('\n\n---\n\n');
        }
    }

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
