/**
 * core/quote_match.js — Shared, DOM-free source-excerpt verification.
 *
 * Knowledge and Story Planner both accept model-proposed evidence only when the
 * quoted words can be found in one current chat message. Keep that trust
 * boundary here rather than allowing feature modules to depend on one another's
 * private helpers.
 */
import { stripNonNarrative } from './strip.js';

export const QUOTE_VERIFY_WINDOW = 5;
export const BIGRAM_MATCH_THRESHOLD = 0.7;

/** ILS summaries are paraphrases, not verbatim evidence sources. */
export function isIlsSummary(message) {
    return !!message?.extra?.ILS_Data;
}

export function normalizeForMatch(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function bigrams(tokens) {
    const result = [];
    for (let index = 0; index + 1 < tokens.length; index++) {
        result.push(`${tokens[index]} ${tokens[index + 1]}`);
    }
    return result;
}

/**
 * Test a normalized excerpt against one message. Knowledge defaults to its
 * established interposition-tolerant contract: a dialogue tag may split an
 * otherwise verbatim quote. Strict consumers such as Story Planner can disable
 * that fallback with `allowInterposition: false`.
 */
export function quoteMatchesMessage(needle, needleBigrams, message, { allowInterposition = true } = {}) {
    const normalizedNeedle = normalizeForMatch(needle);
    const tokens = normalizedNeedle.split(' ').filter(Boolean);
    if (!message?.mes || isIlsSummary(message) || normalizedNeedle.length < 8 || tokens.length < 3) return false;
    const haystack = normalizeForMatch(stripNonNarrative(message.mes, { preserveOffScreen: false }));
    if (!haystack) return false;
    if (haystack.includes(normalizedNeedle)) return true;
    if (!allowInterposition) return false;
    const expected = Array.isArray(needleBigrams) && needleBigrams.length
        ? needleBigrams
        : bigrams(tokens);
    if (!expected.length) return false;
    const available = new Set(bigrams(haystack.split(' ').filter(Boolean)));
    const hits = expected.reduce((count, pair) => count + (available.has(pair) ? 1 : 0), 0);
    return hits / expected.length >= BIGRAM_MATCH_THRESHOLD;
}

export const QUOTE_CONTEXT_CHAR_LIMIT = 300;

/** Sentences end at terminal punctuation (plus closing quotes, brackets or
 * emphasis marks) followed by whitespace, and at line breaks. */
function splitSentences(value) {
    return String(value || '')
        .replace(/([.!?…]+["'”’»)\]*_~]*)\s+/gu, '$1\u0000')
        .split(/\u0000|\r?\n+/)
        .map(part => part.replace(/\s+/g, ' ').trim())
        .filter(part => normalizeForMatch(part));
}

/**
 * Verbatim context for a quote that matched `source` strictly: the sentences
 * containing it, widened by whole neighbouring sentences (earlier first) while
 * the excerpt fits `limit`. Null when the quote cannot be located contiguously,
 * its own sentences exceed the limit, or the excerpt would add nothing.
 */
export function excerptAroundQuote(source, quote, { limit = QUOTE_CONTEXT_CHAR_LIMIT } = {}) {
    const needle = normalizeForMatch(quote);
    if (!needle) return null;
    const parts = splitSentences(stripNonNarrative(source, { preserveOffScreen: false }));
    const normalized = parts.map(normalizeForMatch);
    const contains = (from, to) => normalized.slice(from, to + 1).join(' ').includes(needle);
    const length = (from, to) => parts.slice(from, to + 1).join(' ').length;
    let end = 0;
    while (end < parts.length && !contains(0, end)) end++;
    if (end === parts.length) return null;
    let start = end;
    while (start > 0 && !contains(start, end)) start--;
    if (length(start, end) > limit) return null;
    for (let grew = true; grew;) {
        grew = false;
        if (start > 0 && length(start - 1, end) <= limit) { start--; grew = true; }
        if (end < parts.length - 1 && length(start, end + 1) <= limit) { end++; grew = true; }
    }
    const excerpt = parts.slice(start, end + 1).join(' ');
    return normalizeForMatch(excerpt) === needle ? null : excerpt;
}

/** Return the matching chat-array index, or -1 when the excerpt is unverifiable. */
export function findQuoteMatch(quote, messageIndex, chat, options = {}) {
    if (!Array.isArray(chat)) return -1;
    const needle = normalizeForMatch(quote);
    const tokens = needle.split(' ').filter(Boolean);
    if (needle.length < 8 || tokens.length < 3) return -1;
    const needleBigrams = bigrams(tokens);
    const matches = message => quoteMatchesMessage(needle, needleBigrams, message, options);
    if (Number.isInteger(messageIndex) && messageIndex >= 0 && messageIndex < chat.length) {
        if (matches(chat[messageIndex])) return messageIndex;
        for (let distance = 1; distance <= QUOTE_VERIFY_WINDOW; distance++) {
            const before = messageIndex - distance;
            const after = messageIndex + distance;
            if (before >= 0 && matches(chat[before])) return before;
            if (after < chat.length && matches(chat[after])) return after;
        }
        return -1;
    }
    for (let index = 0; index < chat.length; index++) {
        if (matches(chat[index])) return index;
    }
    return -1;
}