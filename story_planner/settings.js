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
    },
    logPrefix: '[MWT:StoryPlanner]',
});