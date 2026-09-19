/**
 * core/character_context.js — Optional, safe character-context provider seam.
 *
 * Consumers never import Knowledge directly. Knowledge registers an adapter at
 * startup; if it is disabled or unavailable, planner calls receive an empty
 * projection and continue with their normal factual context.
 */

let provider = null;

export function registerSafeCharacterContextProvider(nextProvider) {
    provider = nextProvider && typeof nextProvider === 'object' ? nextProvider : null;
}

export function listSafeCharacterContextCandidates() {
    try {
        const values = provider?.listCandidates?.();
        return Array.isArray(values) ? values : [];
    } catch (err) {
        console.warn('[MWT] Could not list safe character-context candidates:', err);
        return [];
    }
}

export async function buildSafeCharacterContext(selection) {
    if (selection?.mode === 'off') return { text: '', records: 0, requested: 0, omitted: 0, chars: 0, tokens: 0 };
    try {
        const result = await provider?.buildContext?.(selection);
        return result && typeof result === 'object'
            ? result
            : { text: '', records: 0, requested: 0, omitted: 0 };
    } catch (err) {
        console.warn('[MWT] Could not build safe character context:', err);
        return { text: '', records: 0, requested: 0, omitted: 0 };
    }
}

export function _resetSafeCharacterContextProvider() { provider = null; }