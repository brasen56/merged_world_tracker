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
        // Comma-separated names that never expire and are never flagged as
        // ungrounded (e.g. the protagonist/POV character).
        pinnedEntities: '',
    },
    logPrefix: '[MWT:WorldState]',
});

/** Parse the comma-separated pinnedEntities setting into a clean array. */
export function getPinnedEntities(settings) {
    const raw = settings?.pinnedEntities || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}