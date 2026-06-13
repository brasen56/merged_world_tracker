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

export function applyExtensionPromptInjection({
    key,
    header,
    body,
    enabled,
    globalDepth,
    fallbackDepth,
    globalRole = 'system',
}) {
    const setEP = getSetExtensionPrompt();
    if (!setEP) return false;

    const role = roleToNumber(globalRole);
    const depth = Number.isFinite(Number(globalDepth)) ? Number(globalDepth) : fallbackDepth;

    if (!enabled || !body?.trim()) {
        setEP(key, '', 1, depth, undefined, role);
        return false;
    }

    setEP(key, `${header}\n\n${body}`, 1, depth, undefined, role);
    return true;
}