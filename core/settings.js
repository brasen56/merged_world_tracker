/**
 * core/settings.js — Shared settings management
 *
 * Provides a factory that creates getSettings / saveSettings / hasValidSettings
 * for a given settings key and defaults.  Supports:
 *   - SillyTavern extension_settings (survives backup/restore)
 *   - localStorage fallback
 *   - One-time legacy key migration
 */

import { getContextSafe } from './context.js';

/**
 * Create a settings manager for a specific module.
 *
 * @param {object} opts
 * @param {string} opts.settingsKey    — localStorage + extension_settings key
 * @param {string} [opts.legacyKey]    — old key to migrate from (one-time)
 * @param {object} opts.defaults       — default settings object
 * @param {string} opts.logPrefix      — e.g. '[Knowledge Tracker]'
 * @returns {{ getSettings, saveSettings, hasValidSettings, getExtSettingsRef }}
 */
export function createSettingsManager({ settingsKey, legacyKey, defaults, logPrefix = '[MWT]' }) {

    function getExtSettingsRef() {
        try {
            const ctx = getContextSafe();
            if (ctx && ctx.extensionSettings) {
                if (!ctx.extensionSettings[settingsKey]) ctx.extensionSettings[settingsKey] = {};
                return ctx.extensionSettings[settingsKey];
            }
        } catch { /* ignore */ }
        return null;
    }

    function getSettings() {
        try {
            // Prefer SillyTavern extension_settings
            const extRef = getExtSettingsRef();
            if (extRef && Object.keys(extRef).length > 0) return { ...defaults, ...extRef };

            // Fall back to localStorage
            const raw = localStorage.getItem(settingsKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                // One-time migration into extension_settings if now available
                if (extRef && Object.keys(extRef).length === 0) Object.assign(extRef, parsed);
                return { ...defaults, ...parsed };
            }

            // Check legacy key
            if (legacyKey) {
                const legacy = localStorage.getItem(legacyKey);
                if (legacy) {
                    const parsed = JSON.parse(legacy);
                    const merged = { ...defaults, ...parsed };
                    if (extRef) Object.assign(extRef, merged);
                    else localStorage.setItem(settingsKey, JSON.stringify(merged));
                    console.log(`${logPrefix} Migrated settings from legacy key "${legacyKey}"`);
                    return merged;
                }
            }

            return { ...defaults };
        } catch (err) {
            console.warn(`${logPrefix} Failed to read settings:`, err);
            return { ...defaults };
        }
    }

    function saveSettings(patch) {
        try {
            const next = { ...getSettings(), ...patch };
            const extRef = getExtSettingsRef();
            if (extRef) {
                for (const key of Object.keys(extRef)) delete extRef[key];
                Object.assign(extRef, next);
                getContextSafe()?.saveSettingsDebounced?.();
            } else {
                // Only write to localStorage as a fallback when extension_settings
                // is unavailable — avoids persisting API keys in plaintext beyond
                // the extension's own storage scope (they survive uninstall otherwise).
                localStorage.setItem(settingsKey, JSON.stringify(next));
            }
            console.log(`${logPrefix} Settings saved`);
            return true;
        } catch (err) {
            console.warn(`${logPrefix} Failed to save settings:`, err);
            return false;
        }
    }

    function hasValidSettings() {
        const s = getSettings();
        // Connection profile bypasses custom API settings entirely.
        if (s.connectionProfileId) return true;
        // Only apiUrl + modelName are required; apiKey is optional for
        // keyless local backends (Ollama, LM Studio, llama.cpp, etc.)
        return !!(s.apiUrl && s.modelName);
    }

    return { getSettings, saveSettings, hasValidSettings, getExtSettingsRef };
}