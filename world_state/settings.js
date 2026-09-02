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

/** Parse the comma-separated pinnedEntities setting into a clean array. */
export function getPinnedEntities(settings) {
    const raw = settings?.pinnedEntities || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}