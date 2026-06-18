/**
 * core/context.js — Shared SillyTavern context helpers
 *
 * Provides safe access to the SillyTavern context object, chat metadata,
 * message retrieval, and player name resolution.  Used by every module
 * in the merged extension.
 */

/**
 * Returns the SillyTavern context object, or null if unavailable.
 * Tries both the modern namespace and the legacy global.
 */
export function getContextSafe() {
    try {
        if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
            return SillyTavern.getContext();
        }
    } catch { /* ignore */ }
    try {
        if (typeof getContext === 'function') return getContext();
    } catch { /* ignore */ }
    return null;
}

/**
 * Returns the chat array from the current context, or an empty array.
 *
 * ⚠️ This returns the **live reference** to SillyTavern's internal chat array,
 * not a copy.  Callers must treat it as read-only — mutating the returned
 * array (push/splice/sort/etc.) will modify SillyTavern's state directly.
 * If a mutable copy is needed, use `getChat().slice()` or spread `[...getChat()]`.
 */
export function getChat() {
    return getContextSafe()?.chat || [];
}

/**
 * Retrieve recent chat messages as formatted text.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxMessages=100]  — max messages to include
 * @param {number} [opts.maxChars=4000000] — character budget
 * @param {boolean} [opts.filterSystem=false] — exclude system messages
 * @returns {string} newline-separated "Name: text" lines, oldest-first
 */
export function getRecentMessages({
    maxMessages = 100,
    maxChars = 4000000,
    filterSystem = false,
} = {}) {
    const chat = getChat();
    let slice = chat.slice(-maxMessages);
    if (filterSystem) {
        slice = slice.filter(m => !m?.is_system && m?.extra?.type !== 'narrator');
    }
    const lines = [];
    let total = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
        const msg = slice[i];
        const name = msg?.name || (msg?.is_user ? 'User' : 'Assistant');
        const text = String(msg?.mes || '').trim();
        if (!text) continue;
        const line = `${name}: ${text}`;
        if (total + line.length > maxChars) break;
        lines.push(line);
        total += line.length + 1;
    }
    return lines.reverse().join('\n');
}

/**
 * Returns a Set of player / co-protagonist names (lower-cased).
 * Useful for filtering out non-NPCs during scans.
 */
export function getPlayerNames({ lower = true, includeFirstChat = false } = {}) {
    const ctx = getContextSafe();
    const names = new Set();
    const transform = lower ? (s) => s.toLowerCase() : (s) => s;
    if (ctx?.name1) names.add(transform(String(ctx.name1).trim()));
    if (ctx?.name2) names.add(transform(String(ctx.name2).trim()));
    // Group-chat member names
    if (Array.isArray(ctx?.characters)) {
        for (const ch of ctx.characters) {
            if (ch?.name) names.add(transform(String(ch.name).trim()));
        }
    }
    // Fallback: first message in chat (usually the AI character's greeting)
    if (includeFirstChat) {
        const chat = getChat();
        if (chat) {
            const first = chat[0];
            if (first?.name) names.add(transform(first.name.trim()));
        }
    }
    return names;
}

/**
 * Access the current chat's metadata object.
 *
 * If key is provided, returns that specific sub-key.
 * If key is omitted, returns the entire chatMetadata object
 * (creating it on the context if it doesn't exist yet).
 *
 * @param {string} [key] — optional metadata key
 * @returns {*} the stored value, or the whole metadata object
 */
export function getChatMeta(key) {
    const ctx = getContextSafe();
    if (!ctx) return key ? undefined : {};
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    if (key !== undefined) return ctx.chatMetadata[key];
    return ctx.chatMetadata;
}

/**
 * Write a patch into the current chat's metadata and trigger a save.
 *
 * @param {string} key   — metadata key
 * @param {object} patch — object to merge into the existing metadata value
 */
export function setChatMeta(key, patch) {
    const ctx = getContextSafe();
    if (!ctx) return;
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    const prev = ctx.chatMetadata[key] || {};
    ctx.chatMetadata[key] = { ...prev, ...patch, lastUpdated: Date.now() };
    if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
    else if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
}

/**
 * Get the context's setExtensionPrompt function for injection.
 * Returns null if unavailable.
 */
export function getSetExtensionPrompt() {
    const ctx = getContextSafe();
    if (ctx && typeof ctx.setExtensionPrompt === 'function') return ctx.setExtensionPrompt.bind(ctx);
    // Try global (some ST versions export it directly)
    if (typeof window !== 'undefined' && typeof window.setExtensionPrompt === 'function') return window.setExtensionPrompt;
    return null;
}

/**
 * Escape a string for use in a RegExp.
 */
export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rough characters-per-token ratio used by the fallback estimator.
 *
 * Empirical data for English text on common BPE tokenizers (GPT-2, Llama,
 * Claude) places the average around 4–5 chars/token.  We use 4.5 as a
 * middle-ground that avoids the systematic overestimation of the previous
 * `length / 4` heuristic while still erring slightly high for safety in
 * budget/usage displays.
 */
const FALLBACK_CHARS_PER_TOKEN = 4.5;

/**
 * Estimate token count for a string.
 * Tries SillyTavern's built-in tokenizer first, falls back to a length-based
 * heuristic (see `FALLBACK_CHARS_PER_TOKEN`).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;

    // Try SillyTavern's tokenizer
    try {
        if (typeof window !== 'undefined') {
            // SillyTavern exposes getTokenCount globally or via context
            const ctx = getContextSafe();
            if (ctx && typeof ctx.getTokenCount === 'function') {
                return ctx.getTokenCount(text);
            }
            if (typeof getTokenCount === 'function') {
                return getTokenCount(text);
            }
            // Try the tokenizers module
            if (typeof SillyTavern !== 'undefined' && SillyTavern?.tokenizers?.getTokenCount) {
                return SillyTavern.tokenizers.getTokenCount(text);
            }
        }
    } catch { /* fallback */ }

    // Fallback: rough length-based estimate (see FALLBACK_CHARS_PER_TOKEN).
    return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}