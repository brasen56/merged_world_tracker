/**
 * world_state/settings.js — Settings constants and manager.
 *
 * Leaf module — no imports from other world_state modules.
 */

import { createSettingsManager } from '../core/index.js';

// ─── Settings ────────────────────────────────────────────────────────────────

export const SETTINGS_KEY = 'mwt_world_state';
export const DEFAULT_AUTO_SAVE_INTERVAL = 120;

// ─── Stale-entry expiry & grounding (see STALE_ENTRY_EXPIRY_DESIGN.md §5) ────

export const EXPIRY_SECTIONS_DEFAULT = ['Off-Screen', 'Pending', 'Unresolved Threads', 'Active Threads'];

// ─── Detail level (built-in prompt preset) ───────────────────────────────────
//
// How much the built-in prompt writes per entry, smallest first. All three
// share the section names, parser, and validators; 'detailed' is the original
// template, so it stays the default and existing users see no change.

export const DETAIL_LEVELS = Object.freeze(['minimal', 'standard', 'detailed']);
export const DEFAULT_DETAIL_LEVEL = 'detailed';

/** Every value getPromptProfile() can return — what deltaStatus may record. */
export const PROMPT_PROFILES = Object.freeze([...DETAIL_LEVELS, 'custom']);

export function normalizeDetailLevel(level) {
    return DETAIL_LEVELS.includes(level) ? level : DEFAULT_DETAIL_LEVEL;
}

export const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    legacyKey: 'world_state_settings',
    defaults: {
        // Diagnostics (Phase 6): stamps this module's key onto API telemetry
        // (core/api.js apiModule() → captureApiCall) and the
        // reasoning_content_fallback warn, so per-module views — the Health
        // tab's last-run column, MWT.diagnostics.lastApiCall('world_state') —
        // actually key on it instead of everything landing under 'api'.
        module: 'world_state',
        connectionProfileId: '',
        apiUrl: '',
        apiKey: '',
        modelName: '',
        temperature: 0.3,
        maxTokens: 2000,
        autoSaveInterval: DEFAULT_AUTO_SAVE_INTERVAL,
        customPrompt: '',
        injectionDepth: 1,
        maxScanMessages: 20,
        hookMode: 'passive',
        detailLevel: DEFAULT_DETAIL_LEVEL,
        messageFilter: '',
        // Expiry (§5.2) — off by default, non-destructive mode when enabled.
        expiryEnabled: false,
        expiryStaleAfterMsgs: 40,
        expirySections: EXPIRY_SECTIONS_DEFAULT,
        expiryMode: 'mark', // 'mark' | 'quarantine' | 'remove'
        // Grounding gate (§5.3) — off by default, non-destructive mode when enabled.
        groundingEnabled: false,
        groundingMode: 'soft', // 'soft' | 'strict'
        // Delta refresh (TODO §3-F / PI §3) — off by default. When on, the
        // scheduled auto-refresh asks the model only for changed sections and
        // applies a validated patch; a full refresh runs when there is no
        // baseline, after manual edits, and every `deltaReconcileEvery`
        // consecutive partial updates.
        deltaMode: false,
        deltaReconcileEvery: 5,
        // When the document chip reports "stale relative to chat": messages
        // since the last refresh of any kind (full or delta).
        deltaStaleAfterMsgs: 15,
        // Comma-separated names that never expire and are never flagged as
        // ungrounded (e.g. the protagonist/POV character).
        pinnedEntities: '',
        injectEnabled: true,
        autoRefresh: false,
        autoRefreshInterval: 5,
    },
    logPrefix: '[MWT:WorldState]',
});

/**
 * Which prompt shapes generated documents: a built-in detail level, or
 * 'custom' when a Custom Prompt replaces the built-in template wholesale.
 * A full refresh records it in deltaStatus so a later delta can tell that the
 * document it would patch was written in a different format (delta.js).
 */
export function getPromptProfile(settings = getSettings()) {
    return settings?.customPrompt?.trim() ? 'custom' : normalizeDetailLevel(settings?.detailLevel);
}

/** Parse the comma-separated pinnedEntities setting into a clean array. */
export function getPinnedEntities(settings) {
    const raw = settings?.pinnedEntities || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Does generated output owe the built-in prompt's Plot Seeds line contract?
 *
 * Only when the built-in prompt actually produced it. A custom prompt replaces
 * that contract wholesale, and Hook Mode Off removes Plot Seeds at the
 * persistence boundary, so neither may have its output rewritten to it. Shared
 * by all three generation paths — full refresh, delta patch, and section regen
 * (refresh.js, sections.js) — so they cannot drift into three near-identical
 * guards that disagree at the edges.
 */
export function usesBuiltInPlotSeedContract() {
    const settings = getSettings();
    return !settings.customPrompt?.trim() && settings.hookMode !== 'off';
}
