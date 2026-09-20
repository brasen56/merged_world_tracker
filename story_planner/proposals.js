/**
 * story_planner/proposals.js — Shared proposal revision and Apply guards.
 *
 * Both scoped generation and single-arc targeted generation use this layer so
 * their stale checks compare the same material arc shape. Scoped Apply also
 * lives here rather than in the general data store module.
 */

import { captureRevision, sameRevision } from '../core/index.js';
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

/** Apply a reviewed scoped proposal without clobbering unrelated live edits. */
export function applyScopedPlanProposal(proposal, current = getArcs()) {
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
    let next;
    const excludedRecurrences = [];
    if (request.operation === 'add') {
        const additionIds = new Set(proposal.addedArcIds || []);
        const liveTitles = new Map(live.map(arc => [titleKey(arc.title), arc]).filter(([key]) => key));
        const usedIds = new Set(live.map(arc => arc.id));
        const acceptedTitles = new Set();
        const additions = [];
        for (const arc of proposal.arcs.filter(item => additionIds.has(item.id) && acceptedIds.has(item.id))) {
            const key = titleKey(arc.title);
            const existing = key ? liveTitles.get(key) : null;
            if (existing || (key && acceptedTitles.has(key))) {
                excludedRecurrences.push({ title: arc.title, status: existing?.status || 'proposal', existingArcId: existing?.id || '' });
                continue;
            }
            if (key) acceptedTitles.add(key);
            let id;
            do { id = newArcId(); } while (usedIds.has(id));
            usedIds.add(id);
            additions.push(sanitizeArc({ ...arc, id, createdAt: Date.now(), updatedAt: Date.now() }));
        }
        next = [...live, ...additions];
    } else {
        const replacements = new Map(proposal.arcs
            .filter(arc => request.targetArcIds.includes(arc.id) && acceptedIds.has(arc.id))
            .map(arc => [arc.id, arc]));
        next = live.map(arc => replacements.get(arc.id) || arc);
    }
    const changed = JSON.stringify(next.map(materialArcShape)) !== JSON.stringify(live.map(materialArcShape));
    if (!changed) return { ok: false, reason: 'no-changes', arcs: live, excludedRecurrences };
    return { ...setArcsWithHistory(next, live), arcs: next, excludedRecurrences };
}