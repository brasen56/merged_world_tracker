/**
 * core/index.js — Barrel re-export for all core modules.
 *
 * Feature modules import from '../core/index.js' to access shared utilities.
 */

export { getContextSafe, getChat, getChatMeta, setChatMeta, getSetExtensionPrompt, escapeRegex, estimateTokens, getPlayerNames, getUserNames, getRecentMessages, sendDateToMs } from './context.js';
export { normalizeApiBase, fetchFromApi, fetchViaConnectionProfile, resolveApiCall, normaliseOutput, retryAsync, parseJsonLenient } from './api.js';
export { escapeHtml, computeLcsDiff, buildInlineDiff, renderDiffHtml, renderLineDiff } from './diff.js';
export { createSettingsManager, syncSharedConnectionSettings, getGlobalSettings, injectionAllowed } from './settings.js';
export { createModal, showModal, hideModal, setStatus, formatDate } from './modal.js';
export { applyExtensionPromptInjection, roleToNumber, wrapInTag } from './injection.js';
export {
    getCurrentWorldState,
    getLatestChronicleEntry,
    patchChatMeta,
    persistChatMeta,
    persistChatMetaNow,
    WORLD_STATE_METADATA_KEY,
} from './metadata.js';
export { notify } from './notifications.js';
// Phase 0 diagnostics — in-memory ring buffer + last-run map
// (core/diagnostics.js). Pure module; re-exported through the barrel so feature
// code can import it alongside the other core helpers. Mirrored in
// test/stubs/core.js for the barrel→stub alias.
export {
    record,
    getEvents,
    clearEvents,
    setRunStart,
    setRunResult,
    getLastRun,
    getAllLastRuns,
    clearLastRuns,
} from './diagnostics.js';
export { downloadBlob, downloadJson, pickTextFile } from './file.js';
export { renderApiSettingsFields, readApiSettingsValues, createFloatingButtonBar } from './ui.js';
export { stripNonNarrative, stripNonNarrativeFromFormatted } from './strip.js';
export { MWT_VERSION } from './version.js';

// Tier 0 shared primitives (scope, revision, prompt helpers).
export {
    getEpoch,
    bumpEpoch,
    _resetEpoch,
    getCharacterIdentity as getScopeCharacterIdentity,
    getChatIdentity,
    captureScope,
    assertSameScope,
    getChatScopeKey,
} from './scope.js';
export {
    defaultNormalize,
    captureRevision,
    sameRevision,
    createRevisionClock,
    decideCommit,
} from './revision.js';
export {
    escapePromptText,
    escapePromptAttr,
    escapePromptBoundary,
    buildTag,
    wrapTag,
    truncateText,
    truncateTail,
    truncateArray,
    fitBudget,
    TRUNCATION_MARKER,
} from './prompt.js';
