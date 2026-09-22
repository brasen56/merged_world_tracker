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

export function resolveSafeCharacterContextEntities(entityIds) {
    const requested = [...new Set((entityIds || []).map(String).filter(Boolean))];
    try {
        const values = provider?.resolveEntities?.(requested);
        if (values && typeof values === 'object') return values;
        // Keep the shared identity seam useful for lightweight providers (and
        // older adapters) that expose candidates but not a dedicated resolver.
        // Consumers still resolve aliases/merges through this service rather
        // than reimplementing identity matching in each feature module.
        const candidates = provider?.listCandidates?.();
        if (!Array.isArray(candidates)) return { resolved: [], missing: requested, available: false };
        const resolved = [];
        const missing = [];
        for (const entityId of requested) {
            const candidate = candidates.find(item => item?.entityId === entityId
                || (Array.isArray(item?.mergedEntityIds) && item.mergedEntityIds.includes(entityId)));
            if (candidate) resolved.push({ requestedEntityId: entityId, ...candidate });
            else missing.push(entityId);
        }
        return { resolved, missing, available: true };
    } catch (err) {
        console.warn('[MWT] Could not resolve safe character-context entities:', err);
        return { resolved: [], missing: requested, available: false };
    }
}

export async function buildSafeCharacterContext(selection) {
    if (selection?.mode === 'off' && !(selection?.primarySubjectEntityIds || []).length) {
        return { text: '', records: 0, requested: 0, omitted: 0, chars: 0, tokens: 0, coverage: [] };
    }
    try {
        const result = await provider?.buildContext?.(selection);
        const projection = result && typeof result === 'object'
            ? result
            : { text: '', records: 0, requested: 0, omitted: 0, chars: 0, tokens: 0, coverage: [] };
        // Off may still consult the provider so selected Journey subjects receive
        // visible disabled coverage. The shared boundary must nevertheless make
        // the projection empty even if an adapter accidentally returns content.
        return selection?.mode === 'off'
            ? { ...projection, text: '', records: 0, chars: 0, tokens: 0 }
            : projection;
    } catch (err) {
        console.warn('[MWT] Could not build safe character context:', err);
        return { text: '', records: 0, requested: 0, omitted: 0, chars: 0, tokens: 0, coverage: [] };
    }
}

/** Private planning context is a separate, opt-in capability. Never fall back to the public provider. */
export async function buildAuthorCharacterContext(selection) {
    if (!Array.isArray(selection?.entityIds) || !selection.entityIds.length
        || selection.entityIds.some(id => !(selection.npcFields?.[id] || selection.fields || []).length)) {
        throw new Error('Select at least one author-context field group for every selected NPC. No private context was sent.');
    }
    if (typeof provider?.buildAuthorContext !== 'function') throw new Error('Author character context is unavailable. No private context was sent.');
    // Unlike public context, errors must stop generation, not silently remove a constraint.
    return provider.buildAuthorContext(selection);
}

export function _resetSafeCharacterContextProvider() { provider = null; }