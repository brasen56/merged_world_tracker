/**
 * core/index.js — Barrel re-export for all core modules.
 *
 * Feature modules import from '../core/index.js' to access shared utilities.
 */

export { getContextSafe, getChat, getChatMeta, setChatMeta, getSetExtensionPrompt, escapeRegex, estimateTokens } from './context.js';
export { normalizeApiBase, fetchFromApi, normaliseOutput } from './api.js';
export { escapeHtml, computeLcsDiff, buildInlineDiff, renderDiffHtml, renderLineDiff } from './diff.js';
export { createSettingsManager } from './settings.js';
export { createModal, showModal, hideModal, setStatus, injectButtonBar, formatDate } from './modal.js';