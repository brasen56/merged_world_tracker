/**
 * chronicle/injection.js — Prompt injection logic.
 *
 * Handles which entries to inject, building the injection body,
 * and applying/removing the extension prompt.
 */

import {
    getGlobalSettings, estimateTokens,
    applyExtensionPromptInjection, wrapInTag, injectionAllowed,
} from '../core/index.js';

import { CHRONICLE_INJECTION_HEADER } from './prompts.js';

import {
    state, EXTENSION_PROMPT_KEY,
    getChronicleData, getSnapshots, getSettings,
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

export function applyInjection() {
    const enabled = isInjectionEnabled() && injectionAllowed('Chronicle');
    const snapshots = getSnapshots();

    const globalSettings = getGlobalSettings();

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
        globalDepth: globalSettings.chronicleDepth,
        fallbackDepth: getChronicleData().injectDepth ?? 2,
        globalRole: globalSettings.chronicleRole || 'system',
        wrapperTag: 'mwt_chronicle',
        useTags: globalSettings.structuralBoundaries !== false,
    });
}
