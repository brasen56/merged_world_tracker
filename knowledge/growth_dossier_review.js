/** Growth staging helpers. No model calls, dossier writes, or history writes. */
import { extractGrowthDossierLines } from './growth_dossier.js';
import { GROWTH_DOSSIER_CEILINGS } from './growth_dossier_state.js';
import { validateFieldValue } from './field_contract.js';
import { growthOwnsField } from './field_ownership.js';
import { getRegistryEntry, getGrowthDossierSettings } from './registry.js';
import { stripRelationshipBlock } from './relationships.js';
import { buildGrowthApproval, splitGrowthSentences } from './growth_lineage.js';

export const GROWTH_ITEM_TYPE = 'growth-dossier';
const labels = { personality: 'Personality', voice: 'Voice' };

/** Growth owns only these lines, not the entry's format or header. */
function applyGrowthLines(current, fields) {
    let result = current;
    for (const [key, label] of Object.entries(labels)) {
        const pattern = new RegExp(`^${label}:[^\\n]*`, 'm');
        if (pattern.test(result)) result = result.replace(pattern, () => `${label}: ${fields[key] || ''}`);
        else if (fields[key]) {
            const lines = result.split('\n');
            const ledger = lines.findIndex(line => /^Knowledge Ledger:/i.test(line));
            lines.splice(ledger < 0 ? lines.length : ledger, 0, `${label}: ${fields[key]}`);
            result = lines.join('\n');
        }
    }
    return result;
}

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
        const count = (proposed.match(new RegExp(`^${labels[key]}:`, 'gm')) || []).length;
        if (count !== 1 && !(count === 0 && !before[key] && !fields[key])) {
            throw new Error(`Growth review needs exactly one ${labels[key]} line.`);
        }
        const check = validateFieldValue(key, fields[key], { ceilings: GROWTH_DOSSIER_CEILINGS });
        if (!check.ok) throw new Error(`${labels[key]}: ${check.reason}`);
        if (before[key] && !check.value) throw new Error(`Cannot clear ${labels[key]}; keep or replace its text.`);
        fields[key] = check.value;
    }
    return applyGrowthLines(current, fields);
}

/** A pending model draft must not silently undo a later hand-edited line. */
export function refreshGrowthReview(item, current, proposed) {
    const before = extractGrowthDossierLines(item.existingContent);
    const live = extractGrowthDossierLines(current);
    const reviewed = extractGrowthDossierLines(proposed);
    const model = extractGrowthDossierLines(item.proposedContent);
    const changed = Object.keys(labels).filter(key => before[key] !== live[key]);
    for (const key of changed) {
        if (reviewed[key] === model[key]) reviewed[key] = live[key];
    }
    const content = applyGrowthLines(current, reviewed);
    const preserved = changed.flatMap(field => {
        const remaining = splitGrowthSentences(live[field]);
        return splitGrowthSentences(reviewed[field]).flatMap(sentence => {
            const index = remaining.indexOf(sentence);
            if (index < 0) return [];
            remaining.splice(index, 1);
            return [{ field, action: 'keep', before: sentence, after: sentence, evidenceIds: [], sourceLabel: 'hand edit, no evidence' }];
        });
    });
    item.changes = buildGrowthApproval({ current: live, approved: reviewed,
        changes: [...(item.changes || []).filter(change => !changed.includes(change.field)), ...preserved],
    }).changes;
    return { content, changed };
}

export function createGrowthStagingItem(draft) {
    const live = assertGrowthReviewCurrent(draft);
    const fields = {};
    for (const [key, label] of Object.entries(labels)) {
        const check = validateFieldValue(key, draft.proposal[key], { ceilings: GROWTH_DOSSIER_CEILINGS });
        if (!check.ok) throw new Error(`${label}: ${check.reason}`);
        fields[key] = check.value;
    }
    const proposed = applyGrowthLines(draft.original, fields);
    return {
        id: `growth-dossier-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: GROWTH_ITEM_TYPE, action: 'update', name: live.key,
        uid: draft.uid, entityId: draft.entityId,
        existingContent: draft.original, mergedContent: proposed, proposedContent: proposed,
        keywords: [...(live.info.keywords || [live.key])],
        changes: draft.proposal.changes, warnings: draft.warnings,
        lineage: draft.lineage || [],
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