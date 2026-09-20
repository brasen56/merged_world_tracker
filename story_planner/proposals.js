/**
 * story_planner/proposals.js — Shared proposal revision, diff, and Apply guards.
 *
 * Both scoped generation and single-arc targeted generation use this layer so
 * their stale checks compare the same material arc shape and their reviews
 * describe a change the same way (V3 Phase 1: "do not duplicate targeted.js").
 *
 * The scoped review renders `planScopedApply`'s own output, so the diff a user
 * approves is computed by the function that performs the write. Rendering the
 * merge result instead showed changes Apply never makes: `mergeRegeneratedArcs`
 * returns `[...carried, ...merged]`, which moves every refreshed arc to the end
 * of the plan, while Apply replaces arcs in place.
 */

import { captureRevision, resolveSafeCharacterContextEntities, sameRevision } from '../core/index.js';
import { sanitizeStoryPlanRequest } from './schema.js';
import {
    getArcs, newArcId, sanitizeArc, sanitizeArcs, setArcsWithHistory,
} from './data.js';

function titleKey(value) {
    return String(value || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function materialArcShape(arc) {
    if (!arc) return null;
    const copy = JSON.parse(JSON.stringify(arc));
    delete copy.updatedAt;
    delete copy.turnsSinceAdvance;
    copy.beats = (copy.beats || []).map(beat => {
        const next = { ...beat };
        delete next.updatedAt;
        return next;
    });
    return copy;
}

export function captureArcRevision(arc) {
    return captureRevision(materialArcShape(arc));
}

export function captureTargetRevisions(targets) {
    return Object.fromEntries((targets || []).map(arc => [arc.id, captureArcRevision(arc)]));
}

export function findChangedProposalTargets(targetIds, revisions, current = getArcs()) {
    const liveById = new Map((current || []).map(arc => [arc.id, arc]));
    return (targetIds || []).filter(id => {
        const live = liveById.get(id);
        return !live || !revisions?.[id] || !sameRevision(revisions[id], materialArcShape(live));
    });
}

/**
 * Field and pending-beat diff for one arc. Shared by the targeted review and
 * the scoped review so a change is described identically on both paths.
 */
export function buildArcDiff(source, proposed, operation = '') {
    const before = source || { title: '', body: '', section: '', beats: [] };
    const fields = ['title', 'body', 'section', 'primarySubjectEntityId', 'supportingParticipantEntityIds']
        .filter(field => before[field] !== proposed[field])
        .filter(field => field !== 'supportingParticipantEntityIds'
            || JSON.stringify(before[field] || []) !== JSON.stringify(proposed[field] || []))
        .map(field => ({
            field: field === 'body' ? 'description'
                : field === 'primarySubjectEntityId' ? 'primary subject'
                    : field === 'supportingParticipantEntityIds' ? 'supporting participants' : field,
            before: Array.isArray(before[field]) ? before[field].join(', ') : before[field],
            after: Array.isArray(proposed[field]) ? proposed[field].join(', ') : proposed[field],
        }));
    const beforeBeats = (before.beats || []).filter(beat => beat.state === 'pending');
    const afterBeats = (proposed.beats || []).filter(beat => beat.state === 'pending');
    const beforeById = new Map(beforeBeats.map(beat => [beat.id, beat]));
    const afterById = new Map(afterBeats.map(beat => [beat.id, beat]));
    const beats = [
        ...beforeBeats.filter(beat => !afterById.has(beat.id)).map(beat => ({ kind: 'removed', id: beat.id, before: beat.text, after: '' })),
        ...afterBeats.map(beat => {
            const old = beforeById.get(beat.id);
            return old ? (old.text === beat.text ? null : { kind: 'changed', id: beat.id, before: old.text, after: beat.text })
                : { kind: 'added', id: beat.id, before: '', after: beat.text };
        }).filter(Boolean),
    ];
    const commonBefore = beforeBeats.filter(beat => afterById.has(beat.id)).map(beat => beat.id);
    const commonAfter = afterBeats.filter(beat => beforeById.has(beat.id)).map(beat => beat.id);
    if (commonBefore.some((id, index) => id !== commonAfter[index])) {
        const beforePositions = new Map(beforeBeats.map((beat, index) => [beat.id, index + 1]));
        afterBeats.forEach((beat, index) => {
            if (beforePositions.has(beat.id)) {
                beats.push({ kind: 'moved', id: beat.id, before: beforePositions.get(beat.id), after: index + 1 });
            }
        });
    }
    if (operation === 'alternate') fields.unshift({ field: 'arc', before: '(source remains unchanged)', after: proposed.title });
    return { fields, beats };
}

/**
 * Decide what a reviewed scoped proposal does to the live plan, without
 * writing. `mintId` lets the review keep review-local ids while Apply mints
 * collision-checked storage ids from the same decision.
 *
 * @returns {{ok: boolean, reason?: string, changedTargetIds?: string[],
 *   request?: object, live?: object[], next?: object[],
 *   additions?: object[], updates?: object[], excludedRecurrences?: object[]}}
 */
export function planScopedApply(proposal, current = getArcs(), { mintId = null } = {}) {
    if (!proposal || !Array.isArray(proposal.arcs) || !proposal.request) return { ok: false, reason: 'invalid-proposal' };
    const request = sanitizeStoryPlanRequest(proposal.request);
    const live = sanitizeArcs(current);
    const targetRevisions = proposal.targetRevisions || captureTargetRevisions(proposal.targetSnapshots || []);
    const changedTargets = request.operation === 'refresh'
        ? findChangedProposalTargets(request.targetArcIds, targetRevisions, live)
        : [];
    if (changedTargets.length) return { ok: false, reason: 'targets-changed', changedTargetIds: changedTargets };

    const defaultAcceptedIds = request.operation === 'add'
        ? (proposal.addedArcIds || [])
        : (proposal.reviewArcIds || proposal.matchedArcIds || request.targetArcIds);
    const acceptedIds = new Set(Array.isArray(proposal.acceptedProposalIds)
        ? proposal.acceptedProposalIds
        : defaultAcceptedIds);
    const excludedRecurrences = [];
    const additions = [];
    const updates = [];
    let next;
    if (request.operation === 'add') {
        const additionIds = new Set(proposal.addedArcIds || []);
        const liveTitles = new Map(live.map(arc => [titleKey(arc.title), arc]).filter(([key]) => key));
        const usedIds = new Set(live.map(arc => arc.id));
        const acceptedTitles = new Set();
        for (const arc of proposal.arcs.filter(item => additionIds.has(item.id) && acceptedIds.has(item.id))) {
            const key = titleKey(arc.title);
            const existing = key ? liveTitles.get(key) : null;
            if (existing || (key && acceptedTitles.has(key))) {
                excludedRecurrences.push({ title: arc.title, status: existing?.status || 'proposal', existingArcId: existing?.id || '' });
                continue;
            }
            if (key) acceptedTitles.add(key);
            let id = arc.id;
            if (mintId) { do { id = mintId(); } while (usedIds.has(id)); }
            usedIds.add(id);
            additions.push(sanitizeArc({ ...arc, id, createdAt: Date.now(), updatedAt: Date.now() }));
        }
        next = [...live, ...additions];
    } else {
        const liveById = new Map(live.map(arc => [arc.id, arc]));
        const replacements = new Map(proposal.arcs
            .filter(arc => request.targetArcIds.includes(arc.id) && acceptedIds.has(arc.id) && liveById.has(arc.id))
            .map(arc => [arc.id, arc]));
        for (const [id, after] of replacements) updates.push({ id, before: liveById.get(id), after });
        // Replaced in place: Apply never reorders the plan.
        next = live.map(arc => replacements.get(arc.id) || arc);
    }
    return { ok: true, request, live, next, additions, updates, excludedRecurrences };
}

/**
 * What Apply will do, for review. Additions keep their review-local ids so the
 * rendered rows match the proposal's own checkboxes.
 */
export function previewScopedApply(proposal, current = getArcs()) {
    return planScopedApply(proposal, current);
}

/** Apply a reviewed scoped proposal without clobbering unrelated live edits. */
export function applyScopedPlanProposal(proposal, current = getArcs()) {
    if (Array.isArray(proposal?.subjectIdentitySnapshot) && proposal.subjectIdentitySnapshot.length) {
        const captured = proposal.subjectIdentitySnapshot
            .map(item => ({
                requestedEntityId: item?.requestedEntityId || item?.entityId || '',
                entityId: item?.entityId || '',
                // Snapshots created before the explicit state field represented
                // only resolved identities, so a non-empty entityId is the safe
                // compatibility interpretation for those review objects.
                resolved: typeof item?.resolved === 'boolean' ? item.resolved : !!item?.entityId,
            }))
            .filter(item => item.requestedEntityId);
        const resolution = resolveSafeCharacterContextEntities(captured.map(item => item.requestedEntityId));
        const liveByRequestedId = new Map((resolution.resolved || []).map(item => [item.requestedEntityId, item.entityId]));
        const changedEntityIds = captured
            .filter(item => {
                const liveEntityId = liveByRequestedId.get(item.requestedEntityId) || '';
                const liveResolved = !!liveEntityId;
                return liveResolved !== item.resolved
                    || (item.resolved && liveEntityId !== item.entityId);
            })
            .map(item => item.requestedEntityId);
        if (changedEntityIds.length) {
            return { ok: false, reason: 'entity-mappings-changed', changedEntityIds };
        }
    }
    const plan = planScopedApply(proposal, current, { mintId: newArcId });
    if (!plan.ok) return plan;
    const { live, next, excludedRecurrences } = plan;
    const changed = JSON.stringify(next.map(materialArcShape)) !== JSON.stringify(live.map(materialArcShape));
    if (!changed) return { ok: false, reason: 'no-changes', arcs: live, excludedRecurrences };
    return { ...setArcsWithHistory(next, live), arcs: next, excludedRecurrences };
}