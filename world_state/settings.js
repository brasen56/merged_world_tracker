/**
 * world_state/settings.js — Settings constants and manager.
 *
 * Leaf module — no imports from other world_state modules.
 */

import { createSettingsManager } from '../core/index.js';

// ─── Settings ────────────────────────────────────────────────────────────────

export const SETTINGS_KEY = 'mwt_world_state';
export const DEFAULT_AUTO_SAVE_INTERVAL = 120;

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
    },
    logPrefix: '[MWT:WorldState]',
});