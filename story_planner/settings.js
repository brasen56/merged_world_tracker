/**
 * story_planner/settings.js — Settings constants and manager.
 *
 * Leaf module — no imports from other story_planner modules.
 */

import { createSettingsManager } from '../core/index.js';

// ─── Settings ────────────────────────────────────────────────────────────────

export const SETTINGS_KEY = 'mwt_story_planner';

export const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    defaults: {
        // Diagnostics (Phase 6): stamps this module's key onto API telemetry
        // (core/api.js apiModule() → captureApiCall) so per-module views — the
        // Health tab's last-run column,
        // MWT.diagnostics.lastApiCall('story_planner') — actually key on it
        // instead of everything landing under 'api'.
        module: 'story_planner',
        connectionProfileId: '',
        apiUrl: '',
        apiKey: '',
        modelName: '',
        maxTokens: 2000,
        temperature: 0.6,
        topP: 1.0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        customHeaders: '',
        customSystemPrompt: '',
        customUserPrompt: '',
        injectionDepth: 4,
        injectMode: 'all',
        enforcement: 'proactive',
        arcCount: 10,
        autoInterval: 10,
        injectEnabled: true,
        autoEnabled: false,
    },
    logPrefix: '[MWT:StoryPlanner]',
});