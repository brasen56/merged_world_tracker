/** Growth staging helpers. No model calls, dossier writes, or history writes. */
import { buildUpdatedDossierContent } from './lorebook.js';
import { extractGrowthDossierLines } from './growth_dossier.js';
import { GROWTH_DOSSIER_CEILINGS } from './growth_dossier_state.js';
import { validateFieldValue } from './field_contract.js';
import { growthOwnsField } from './field_ownership.js';
import { getRegistryEntry, getGrowthDossierSettings } from './registry.js';
import { stripRelationshipBlock } from './relationships.js';

export const GROWTH_ITEM_TYPE = 'growth-dossier';
const labels = { personality: 'Personality', voice: 'Voice' };

export function assertGrowthReviewCurrent(item) {
    const live = getRegistryEntry(item.name);
    if (!live || live.info.uid !== item.uid || live.info.entityId !== item.entityId) {
        throw new Error('Growth proposal NPC changed. Dismiss it and prepare a new draft.');
    }
    if (getGrowthDossierSettings(item.name).enabled !== true) {
        throw new Error('Turn Use Growth in dossier on before accepting this proposal.');
    }
    return live;
}

export function buildGrowthReviewContent(current, proposed) {
    const fields = extractGrowthDossierLines(proposed);
    const before = extractGrowthDossierLines(current);
    for (const key of Object.keys(labels)) {
        // Reject duplicate labels rather than silently selecting one of them.
        if ((proposed.match(new RegExp(`^${labels[key]}:`, 'gm')) || []).length !== 1) {
            throw new Error(`Growth review needs exactly one ${labels[key]} line.`);
        }
        const check = validateFieldValue(key, fields[key], { ceilings: GROWTH_DOSSIER_CEILINGS });
        if (!check.ok) throw new Error(`${labels[key]}: ${check.reason}`);
        if (before[key] && !check.value) throw new Error(`Cannot clear ${labels[key]}; keep or replace its text.`);
    }
    return buildUpdatedDossierContent(current, fields, [], { ceilings: GROWTH_DOSSIER_CEILINGS });
}

export function createGrowthStagingItem(draft) {
    const live = assertGrowthReviewCurrent(draft);
    const proposed = buildUpdatedDossierContent(draft.original, draft.proposal, [], { ceilings: GROWTH_DOSSIER_CEILINGS });
    return {
        id: `growth-dossier-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: GROWTH_ITEM_TYPE, action: 'update', name: live.key,
        uid: draft.uid, entityId: draft.entityId,
        existingContent: draft.original, mergedContent: proposed, proposedContent: proposed,
        keywords: [...(live.info.keywords || [live.key])],
        changes: draft.proposal.changes, warnings: draft.warnings,
    };
}

/** Reapply owned lines verbatim, unless the reviewer changed that very line.
 * Do not send live lines through the scan contract: hand edits may exceed it.
 * The baseline is the original PROPOSED text, not the old Current entry.
 */
export function preserveGrowthOwnedLines(name, current, proposed, baseline) {
    const draft = extractGrowthDossierLines(proposed);
    const original = extractGrowthDossierLines(baseline);
    let result = proposed;
    for (const [key, label] of Object.entries(labels)) {
        if (!growthOwnsField(name, key) || draft[key] !== original[key]) continue;
        const liveLine = current.split('\n').find(line => line.startsWith(`${label}:`));
        const pattern = new RegExp(`^${label}:[^\\n]*`, 'm');
        if (liveLine !== undefined) {
            result = pattern.test(result) ? result.replace(pattern, () => liveLine) : `${result}\n${liveLine}`;
        } else {
            result = result.replace(new RegExp(`^${label}:[^\\n]*(?:\\n|$)`, 'm'), '');
        }
    }
    return result;
}

export function growthEditsOutsideLines(current, proposed) {
    const body = text => stripRelationshipBlock(text).split('\n')
        .filter(line => !/^(?:Personality|Voice):/.test(line)).join('\n').trim();
    return body(current) !== body(proposed);
}