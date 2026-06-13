/**
 * core/index.js — Barrel re-export for all core modules.
 *
 * Feature modules import from '../core/index.js' to access shared utilities.
 */

export { getContextSafe, getChat, getChatMeta, setChatMeta, getSetExtensionPrompt, escapeRegex, estimateTokens, getPlayerNames, getRecentMessages } from './context.js';
export { normalizeApiBase, fetchFromApi, fetchViaConnectionProfile, resolveApiCall, normaliseOutput, retryAsync } from './api.js';
export { escapeHtml, computeLcsDiff, buildInlineDiff, renderDiffHtml, renderLineDiff } from './diff.js';
export { createSettingsManager, syncSharedConnectionSettings, getGlobalSettings } from './settings.js';
export { createModal, showModal, hideModal, setStatus, formatDate } from './modal.js';
export { applyExtensionPromptInjection, roleToNumber } from './injection.js';
export {
    getCurrentWorldState,
    getLatestChronicleEntry,
    patchChatMeta,
    persistChatMeta,
    WORLD_STATE_METADATA_KEY,
} from './metadata.js';
export { notify } from './notifications.js';
export { downloadBlob, downloadJson, pickTextFile } from './file.js';
export { renderApiSettingsFields, readApiSettingsValues, createFloatingButtonBar } from './ui.js';
