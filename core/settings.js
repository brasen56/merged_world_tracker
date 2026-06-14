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

/**
 * Access the global (merged_world_tracker) settings — useful for modules
 * that need to read global injection depth/role without relying on
 * window.__mwt_shared.
 */
export function getGlobalSettings() {
    try {
        const ctx = getContextSafe();
        if (ctx?.extensionSettings?.['merged_world_tracker']) {
            return ctx.extensionSettings['merged_world_tracker'];
        }
    } catch { /* ignore */ }
    return {};
}

/**
 * Is this module allowed to inject / scan right now?
 *
 * Single source of truth for the two-layer enable model:
 *   - injectionMasterOff === true  → nothing injects (panic switch)
 *   - enable<ModuleKey> === false  → that module is disabled
 *
 * @param {string} moduleKey — 'WorldState' | 'Chronicle' | 'Knowledge'
 * @returns {boolean}
 */
export function injectionAllowed(moduleKey) {
    const g = getGlobalSettings();
    if (g.injectionMasterOff) return false;               // "stop everything"
    if (g[`enable${moduleKey}`] === false) return false;  // per-tracker disable
    return true;
}

export function syncSharedConnectionSettings(getSettings, saveSettings, patch, logPrefix = '[MWT]') {
    if (!patch || (
        patch.apiUrl === undefined &&
        patch.apiKey === undefined &&
        patch.modelName === undefined &&
        patch.connectionProfileId === undefined
    )) return false;

    const current = getSettings();
    saveSettings({
        ...current,
        connectionProfileId: patch.connectionProfileId ?? current.connectionProfileId,
        apiUrl: patch.apiUrl ?? current.apiUrl,
        apiKey: patch.apiKey ?? current.apiKey,
        modelName: patch.modelName ?? current.modelName,
    });
    console.log(`${logPrefix} Synced global API settings`);
    return true;
}