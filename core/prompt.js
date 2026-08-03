/**
 * core/prompt.js — Prompt-boundary + payload-budget helpers.
 *
 * Tier 0.4 shared primitive. Provides three categories of helpers needed by
 * interiority, story planner, and world state prompt builders:
 *
 * 1. Escaping for values interpolated into XML-like prompt tags, including
 *    tag attributes. User-edited or model-generated text must be structurally
 *    delimited before it reaches a planner request or narrator injection.
 *
 * 2. Bounded text/array helpers that preserve a clear truncation marker
 *    so the model knows it received a slice, not the whole thing.
 *
 * 3. A total-payload budget helper that can fail closed when a
 *    safety-critical block cannot be represented without losing structure.
 *
 * Escaping is not a substitute for limits: user-edited or model-generated text
 * must be both structurally delimited and bounded before it reaches a planner
 * request or narrator injection.
 */

// ─── 1. Escaping ─────────────────────────────────────────────────────────────

// XML entity escape maps. We build these with Unicode escapes so the literal
// entity strings (&, <, etc.) are not stripped by tooling that processes
// HTML entities in file content. \u0026 is '&'.
const AMP = '\u0026';           // &
const AMP_AMP   = AMP + 'amp;';  // &
const AMP_LT    = AMP + 'lt;';   // <
const AMP_GT    = AMP + 'gt;';   // >
const AMP_QUOT  = AMP + 'quot;'; // "

/** Escape map for tag content: & and < */
const CONTENT_ESCAPES = {
    [AMP]:   AMP_AMP,
    ['<']:   AMP_LT,
};

/** Escape map for tag attributes: & " < > */
const ATTR_ESCAPES = {
    [AMP]:   AMP_AMP,
    ['"']:   AMP_QUOT,
    ['<']:   AMP_LT,
    ['>']:   AMP_GT,
};

const CONTENT_SPECIAL = /[&<]/g;
const ATTR_SPECIAL    = /[&"<>]/g;

/**
 * Escape a string for safe interpolation into XML-like tag content
 * (between <tag> and </tag>).
 *
 * @param {string} text
 * @returns {string}
 */
export function escapePromptText(text) {
    return String(text ?? '').replace(CONTENT_SPECIAL, (ch) => CONTENT_ESCAPES[ch] ?? ch);
}

/**
 * Escape a string for safe interpolation into an XML-like tag attribute
 * (inside name="...").
 *
 * @param {string} text
 * @returns {string}
 */
export function escapePromptAttr(text) {
    return String(text ?? '').replace(ATTR_SPECIAL, (ch) => ATTR_ESCAPES[ch] ?? ch);
}

/**
 * Build an opening tag with attributes, escaping all attribute values.
 *
 * Example:
 *   buildTag('npc', { name: 'Mara' })
 *   => '<npc name="Mara">'
 *
 * @param {string} tag — tag name (e.g. 'npc', 'recent_messages')
 * @param {Record<string, string>} [attrs] — attribute key-value pairs
 * @returns {string}
 */
export function buildTag(tag, attrs) {
    if (!attrs || Object.keys(attrs).length === 0) return `<${tag}>`;
    const attrStr = Object.entries(attrs)
        .map(([k, v]) => `${k}="${escapePromptAttr(v)}"`)
        .join(' ');
    return `<${tag} ${attrStr}>`;
}

/**
 * Wrap text in a tag pair, escaping the content.
 *
 * @param {string} tag
 * @param {string} content
 * @returns {string}
 */
export function wrapTag(tag, content) {
    return `<${tag}>${escapePromptText(content)}</${tag}>`;
}

// ─── 2. Bounded text / array helpers ─────────────────────────────────────────

/**
 * Standard truncation marker appended when content is cut by a budget.
 */
export const TRUNCATION_MARKER = '[\u2026truncated]';

/**
 * Truncate text to a maximum character budget, appending a clear marker if
 * truncation occurred so the model knows it received a slice.
 *
 * Prefers keeping the beginning of the text (most recent context is at the
 * end of chat histories, but for knowledge entries and plan items the top is
 * the most relevant). Callers needing tail-truncation can use truncateTail.
 *
 * @param {string} text
 * @param {number} maxChars — maximum characters (including the marker if added)
 * @returns {string}
 */
export function truncateText(text, maxChars) {
    const str = String(text ?? '');
    if (str.length <= maxChars) return str;
    const marker = TRUNCATION_MARKER;
    const budget = Math.max(0, maxChars - marker.length);
    return str.slice(0, budget) + marker;
}

/**
 * Truncate text from the tail end (keeping the most recent content), with a
 * marker at the start indicating earlier content was removed.
 *
 * Useful for chat histories where the latest messages are most important.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateTail(text, maxChars) {
    const str = String(text ?? '');
    if (str.length <= maxChars) return str;
    const marker = TRUNCATION_MARKER;
    const budget = Math.max(0, maxChars - marker.length);
    return marker + str.slice(str.length - budget);
}

/**
 * Truncate an array of items to a character budget, joining with a separator.
 * Each item is stringified; if the budget runs out mid-array, a truncation
 * marker is appended.
 *
 * @param {Array<*>} items
 * @param {number} maxChars — total character budget for the joined output
 * @param {string} [separator='\n']
 * @returns {string}
 */
export function truncateArray(items, maxChars, separator = '\n') {
    if (!Array.isArray(items) || items.length === 0) return '';
    const parts = [];
    let total = 0;
    for (const item of items) {
        const line = String(item);
        const cost = total === 0 ? line.length : separator.length + line.length;
        if (total + cost > maxChars) break;
        parts.push(line);
        total += cost;
    }
    if (parts.length < items.length) {
        const marker = TRUNCATION_MARKER;
        while (parts.length > 0 && total + separator.length + marker.length > maxChars) {
            const removed = parts.pop();
            total -= (parts.length === 0 ? 0 : separator.length) + removed.length;
        }
        return parts.join(separator) + separator + marker;
    }
    return parts.join(separator);
}

// ─── 3. Total-payload budget ─────────────────────────────────────────────────

/**
 * @typedef {Object} BudgetBlock
 * @property {string} key      — unique identifier for the block
 * @property {string} content  — the text content
 * @property {boolean} [required] — if true, the block cannot be dropped to
 *   fit the budget; if a required block doesn't fit, the whole budget fails
 */

/**
 * @typedef {Object} BudgetResult
 * @property {boolean} ok        — whether all blocks fit within the budget
 * @property {string} assembled  — the assembled text (may be empty if !ok)
 * @property {string[]} dropped  — keys of blocks that were dropped
 * @property {number} totalChars — total characters in the assembled text
 */

/**
 * Assemble a prompt from named blocks within a character budget.
 *
 * Required blocks are always included. Optional blocks are included in order
 * until the budget is exhausted. If any required block cannot fit, ok is
 * false and assembled is empty — fail closed for safety-critical content.
 *
 * @param {BudgetBlock[]} blocks
 * @param {number} maxChars — total character budget
 * @param {string} [separator='\n\n'] — separator between blocks
 * @returns {BudgetResult}
 */
export function fitBudget(blocks, maxChars, separator = '\n\n') {
    const dropped = [];
    const required = blocks.filter(b => b.required);
    const optional = blocks.filter(b => !b.required);

    const requiredText = required.map(b => b.content);
    const requiredJoined = requiredText.join(separator);
    if (requiredJoined.length > maxChars) {
        return { ok: false, assembled: '', dropped: blocks.map(b => b.key), totalChars: 0 };
    }

    const included = [...requiredText];
    let totalChars = requiredJoined.length;

    for (const block of optional) {
        const cost = included.length === 0
            ? block.content.length
            : separator.length + block.content.length;
        if (totalChars + cost > maxChars) {
            dropped.push(block.key);
            continue;
        }
        included.push(block.content);
        totalChars += cost;
    }

    return {
        ok: true,
        assembled: included.join(separator),
        dropped,
        totalChars,
    };
}