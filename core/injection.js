/**
 * core/injection.js — Shared prompt injection helpers.
 */

import { getSetExtensionPrompt } from './context.js';

export function roleToNumber(role) {
    switch (role) {
        case 'user': return 1;
        case 'assistant': return 2;
        default: return 0;
    }
}

/**
 * Wrap a body in open/close XML-style tags.
 *
 * Used to give small/mid-size models a hard structural boundary between
 * different injected reference blocks (world state, chronicle, plot seeds).
 * Frontier-class models don't need it, but 24–70B models bleed less when
 * each block has explicit delimiters.
 *
 * @param {string} tag  — tag name without angle brackets (e.g. 'mwt_world_state')
 * @param {string} body — inner content
 * @returns {string}    `<tag>\nbody\n</tag>`
 */
export function wrapInTag(tag, body) {
    if (!tag || !body?.trim()) return body || '';
    return `<${tag}>\n${body}\n</${tag}>`;
}

/**
 * Apply (or clear) an extension-prompt injection.
 *
 * @param {object} opts
 * @param {string} opts.key            — setExtensionPrompt key
 * @param {string} opts.header         — bracket header text prepended to the body
 * @param {string} opts.body           — main injection content
 * @param {boolean} opts.enabled       — whether injection is active
 * @param {number} [opts.globalDepth]  — global depth override
 * @param {number} opts.fallbackDepth  — module-specific default depth
 * @param {string} [opts.globalRole]   — 'system' | 'user' | 'assistant'
 * @param {string} [opts.wrapperTag]   — when set AND structural boundaries are
 *                                        enabled, wraps the full payload in
 *                                        `<wrapperTag>…</wrapperTag>`
 * @param {boolean} [opts.useTags=true] — master switch for tag wrapping
 */
export function applyExtensionPromptInjection({
    key,
    header,
    body,
    enabled,
    globalDepth,
    fallbackDepth,
    globalRole = 'system',
    wrapperTag,
    useTags = true,
}) {
    const setEP = getSetExtensionPrompt();
    if (!setEP) return false;

    const role = roleToNumber(globalRole);
    const depth = (globalDepth != null && Number.isFinite(Number(globalDepth))) ? Number(globalDepth) : fallbackDepth;

    if (!enabled || !body?.trim()) {
        setEP(key, '', 1, depth, undefined, role);
        return false;
    }

    // Build the payload. When a header is provided it is prepended; otherwise
    // the body is treated as already fully assembled (e.g. World State builds
    // multiple independently-wrapped blocks and passes the final string here).
    const inner = header?.trim() ? `${header}\n\n${body}` : body;
    const payload = (useTags && wrapperTag) ? wrapInTag(wrapperTag, inner) : inner;

    setEP(key, payload, 1, depth, undefined, role);
    return true;
}