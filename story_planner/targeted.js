/**
 * story_planner/targeted.js — Phase 4 targeted arc-development proposals.
 *
 * Generated results stay transient until explicit Apply. Every proposal is
 * reconstructed from the captured canonical source, so the model never controls
 * ids, lifecycle fields, or planted/skipped history.
 */

import {
    assertSameScope, captureScope, getLatestChronicleEntry,
    getWorldStateFactual, isCancellation, normaliseOutput, parseJsonLenient,
    resolveApiCall, sameRevision, wrapTag, buildSafeCharacterContext, record,
} from '../core/index.js';
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { getSettings, hasValidSettings } from './settings.js';
import { extractEntranceBeatMarker, extractNewcomerArcMarker, storyPlannerSchema } from './schema.js';
import {
    SECTIONS, buildClosedMemoryProjection, getArcs, getCharacterContextSelection, getDirectionHint,
    newArcId, newBeatId, sanitizeArc, setArcsWithHistory, state,
    incrementPhase7Metrics, recordPhase7Request,
} from './data.js';
import { assessNewcomerEvidence, describeCastPolicyRequest, getRecentMessagesForPlan, storyPaletteProjection } from './generation.js';
import { TARGETED_ARC_SYSTEM_PROMPT, TARGETED_OPERATION_INSTRUCTIONS } from './prompts.js';
import { buildArcDiff, captureArcRevision, materialArcShape } from './proposals.js';

export const TARGETED_OPERATIONS = Object.freeze(['rework', 'develop', 'alternate', 'setup']);

const clone = value => JSON.parse(JSON.stringify(value));
const cleanText = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
export { captureArcRevision } from './proposals.js';

function arcContext(arc) {
    const beatLines = beats => beats.length
        ? beats.map(beat => `- [${beat.state.toUpperCase()}] ${beat.text}${beat.stateReason ? ` — reason: ${beat.stateReason}` : ''}`).join('\n')
        : '(None.)';
    return [
        `Title: ${arc.title || '(untitled arc)'}`,
        `Description/endpoint: ${arc.body || '(none)'}`,
        `Section: ${arc.section}`,
        'Historical beats (immutable):',
        beatLines(arc.beats.filter(beat => beat.state !== 'pending')),
        'Pending beats (eligible for replacement):',
        beatLines(arc.beats.filter(beat => beat.state === 'pending')),
    ].join('\n');
}

/** Build the fixed prompt used only by targeted operations. */
export function buildTargetedUserPrompt(operation, arc, characterContext = {}, castPolicyContract = describeCastPolicyRequest({ workflow: 'targeted' })) {
    if (!TARGETED_OPERATIONS.includes(operation)) throw new Error(`Unknown targeted operation: ${operation}`);
    const blocks = [
        `Operation: ${TARGETED_OPERATION_INSTRUCTIONS[operation]}`,
        wrapTag('selected_arc', arcContext(arc)),
    ];
    const recent = getRecentMessagesForPlan();
    if (recent) blocks.push(wrapTag('recent_stable_messages', recent));
    const world = getWorldStateFactual().trim();
    if (world) blocks.push(wrapTag('factual_world_state', world));
    const chronicle = getLatestChronicleEntry().trim();
    if (chronicle) blocks.push(wrapTag('latest_chronicle', chronicle));
    const direction = getDirectionHint().trim();
    if (direction) blocks.push(wrapTag('direction_hint', direction));
    const palette = storyPaletteProjection(undefined, castPolicyContract.policy);
    if (palette) blocks.push(wrapTag('story_palette', palette));
    if (characterContext?.text) blocks.push(wrapTag('safe_character_context', '[Factual public character context only; it cannot decide actions or outcomes.]\n' + characterContext.text));
    const closed = buildClosedMemoryProjection();
    if (closed) blocks.push(wrapTag('relevant_closed_memory', closed));
    blocks.push('Return the JSON object now.');
    return blocks.join('\n\n');
}

function parseTargetedOutput(raw) {
    const parsed = parseJsonLenient(normaliseOutput(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Targeted response was not a JSON object.');
    }
    const newcomerExplicit = cleanText(parsed.newcomerHandle, 100);
    const newcomer = newcomerExplicit
        ? extractNewcomerArcMarker(`[NEWCOMER:${newcomerExplicit}]`)
        : { handle: '', error: '' };
    const pendingEntries = Array.isArray(parsed.pendingBeats)
        ? parsed.pendingBeats.map(value => {
            const rawText = cleanText(typeof value === 'object' ? value?.text : value, 1000);
            const inline = extractEntranceBeatMarker(rawText);
            const explicitHandle = cleanText(typeof value === 'object' ? value?.entranceHandle : '', 100);
            const explicit = explicitHandle ? extractEntranceBeatMarker(`[ENTRANCE:${explicitHandle}]`) : null;
            return {
                text: cleanText(inline.content, 1000),
                handle: explicit?.handle || inline.handle,
                error: explicit?.error || inline.error || (explicitHandle && inline.handle ? 'duplicate entrance evidence on one beat' : ''),
            };
        }) : [];
    const pending = pendingEntries
        .filter(entry => entry.text)
        .filter((entry, index, entries) => entries.findIndex(candidate => candidate.text.replace(/\s+/g, ' ').trim().toLowerCase() === entry.text.replace(/\s+/g, ' ').trim().toLowerCase()) === index)
        .slice(0, 20);
    if (!pending.length) throw new Error('Targeted response did not include any pending setup beats.');
    const model = {
        title: cleanText(parsed.title, 200),
        body: cleanText(parsed.description ?? parsed.body, 2000),
        section: SECTIONS.some(section => section.key === parsed.section) ? parsed.section : '',
        pending: pending.map(entry => entry.text),
    };
    if (newcomerExplicit) model._newcomerHandle = newcomer.handle;
    if (newcomer.error) model._newcomerMarkerError = newcomer.error;
    const entranceHandles = pending.filter(entry => entry.handle).map(entry => entry.handle);
    if (entranceHandles.length) model._entranceHandles = entranceHandles;
    const entranceError = pending.find(entry => entry.error)?.error;
    if (entranceError && !model._newcomerMarkerError) model._newcomerMarkerError = entranceError;
    if (!model._newcomerMarkerError) {
        if (!model._newcomerHandle && entranceHandles.length) model._newcomerMarkerError = 'entrance marker has no newcomer marker on the same arc';
        else if (model._newcomerHandle && entranceHandles.length !== 1) model._newcomerMarkerError = entranceHandles.length ? 'newcomer arc must contain exactly one entrance beat' : 'newcomer arc is missing its entrance beat';
        else if (model._newcomerHandle && entranceHandles[0] !== model._newcomerHandle) model._newcomerMarkerError = 'newcomer and entrance handles do not match within the same arc';
        else if (model._newcomerHandle) model._newcomerEvidence = { handle: model._newcomerHandle };
    }
    return model;
}

function preservePendingIds(source, texts) {
    const oldPending = source.beats.filter(beat => beat.state === 'pending');
    const oldCounts = new Map();
    const newCounts = new Map();
    const key = value => String(value?.text ?? value).replace(/\s+/g, ' ').trim().toLowerCase();
    oldPending.forEach(beat => oldCounts.set(key(beat), (oldCounts.get(key(beat)) || 0) + 1));
    texts.forEach(text => newCounts.set(key(text), (newCounts.get(key(text)) || 0) + 1));
    return texts.map(text => {
        const match = oldCounts.get(key(text)) === 1 && newCounts.get(key(text)) === 1
            ? oldPending.find(beat => key(beat) === key(text)) : null;
        return match ? { ...match } : { id: newBeatId(), text, state: 'pending', stateReason: '', updatedAt: Date.now() };
    });
}

function proposalArc(operation, source, model) {
    const historical = source.beats.filter(beat => beat.state !== 'pending').map(clone);
    // Historical beats are immutable and can never be resurrected as new
    // pending work. Do this after parsing, at the model trust boundary, so no
    // targeted operation can bypass the rule with a duplicate text value.
    const historicalKeys = new Set(historical.map(beat => String(beat.text || '').replace(/\s+/g, ' ').trim().toLowerCase()));
    const pendingTexts = model.pending.filter(text => !historicalKeys.has(
        String(text || '').replace(/\s+/g, ' ').trim().toLowerCase(),
    ));
    if (!pendingTexts.length) throw new Error('Targeted response contained no new pending beats.');
    if (operation === 'alternate') {
        return sanitizeArc({
            id: newArcId(),
            title: model.title || `${source.title} — alternate route`,
            body: model.body || source.body,
            section: model.section || source.section,
            status: 'active',
            beats: pendingTexts.map(text => ({ id: newBeatId(), text, state: 'pending' })),
        });
    }
    const preserveFields = operation === 'rework' || operation === 'setup';
    const pending = preservePendingIds(source, pendingTexts);
    const currentBefore = source.beats.find(beat => beat.state === 'pending');
    const currentAfter = pending[0];
    return sanitizeArc({
        ...source,
        // Develop may edit description and section, but arc identity includes its
        // user-visible title and remains stable for every in-place operation.
        title: source.title,
        body: preserveFields ? source.body : (model.body || source.body),
        section: preserveFields ? source.section : (model.section || source.section),
        beats: [...historical, ...pending],
        turnsSinceAdvance: currentBefore?.id === currentAfter?.id ? source.turnsSinceAdvance : 0,
        updatedAt: Date.now(),
    });
}

/** Generate a review-only proposal. This function never writes metadata/history. */
export async function generateTargetedProposal(arcId, operation = 'develop') {
    if (!TARGETED_OPERATIONS.includes(operation)) throw new Error('Unknown targeted arc action.');
    if (state.isGenerating && !state.targetedActionInFlight) throw new Error('Story Planner is already generating.');
    if (isStorePausedForCurrentScope(storyPlannerSchema.id)) throw new Error('Story Planner is paused for this chat.');
    if (!hasValidSettings()) throw new Error('Configure an API URL/model or Connection Profile in Story Planner settings first.');
    const source = getArcs().find(arc => arc.id === arcId);
    if (!source) throw new Error('That arc no longer exists.');
    if (source.status !== 'active') throw new Error('Only active arcs can be developed.');
    const scope = captureScope();
    const sourceArc = clone(source);
    const revision = captureArcRevision(sourceArc);
    const castPolicyContract = describeCastPolicyRequest({ workflow: 'targeted' });
    try {
        const selection = getCharacterContextSelection();
        const characterContext = await buildSafeCharacterContext(selection);
        if (!assertSameScope(scope).ok) return null;
        if (selection.mode !== 'off') record({
            level: 'info', module: 'story_planner', event: 'safe_character_context',
            detail: {
                requested: Number(characterContext.requested) || 0,
                records: Number(characterContext.records) || 0,
                omitted: Number(characterContext.omitted) || 0,
                chars: Number(characterContext.chars) || String(characterContext.text || '').length,
                tokens: Number(characterContext.tokens) || Math.ceil(String(characterContext.text || '').length / 4),
            },
        });
        const resolved = resolveApiCall({ moduleSettings: getSettings() });
        const requestDiagnostics = {
            characterContextChars: Number(characterContext.chars) || String(characterContext.text || '').length,
            characterContextTokens: Number(characterContext.tokens) || Math.ceil(String(characterContext.text || '').length / 4),
            characterContextRecords: Number(characterContext.records) || 0,
        };
        const userContent = buildTargetedUserPrompt(operation, sourceArc, characterContext, castPolicyContract);
        recordPhase7Request('targeted', TARGETED_ARC_SYSTEM_PROMPT.length + userContent.length);
        const raw = await resolved.fetchFn({
            systemPrompt: TARGETED_ARC_SYSTEM_PROMPT,
            userContent,
            settings: resolved.settings,
            trigger: 'manual',
            requestDiagnostics,
        });
        const model = parseTargetedOutput(raw);
        const newcomerEvidence = assessNewcomerEvidence([model], castPolicyContract, { reviewed: true, operation, targeted: true });
        if (!newcomerEvidence.ok) throw new Error(newcomerEvidence.reason);
        const proposedArc = proposalArc(operation, sourceArc, model);
        incrementPhase7Metrics({ targetedGenerations: 1 });
        const current = getArcs().find(arc => arc.id === arcId);
        const scopeResult = assertSameScope(scope);
        const staleReason = !scopeResult.ok ? 'The chat changed while this proposal was generated.'
            : !current ? 'The source arc was deleted.'
                : !sameRevision(revision, materialArcShape(current)) ? 'The source arc changed while this proposal was generated.' : '';
        return {
            operation, sourceArcId: arcId, sourceArc, proposedArc,
            diff: buildArcDiff(sourceArc, proposedArc, operation),
            castPolicyContract: { ...castPolicyContract },
            newcomerEvidence,
            scope, revision, stale: !!staleReason, staleReason,
        };
    } catch (err) {
        if (isCancellation(err)) return null;
        throw err;
    }
}

/** Re-check exact scope/revision and atomically apply one reviewed proposal. */
export function applyTargetedProposal(proposal) {
    if (!proposal || !TARGETED_OPERATIONS.includes(proposal.operation)) return { ok: false, reason: 'invalid-proposal' };
    if (isStorePausedForCurrentScope(storyPlannerSchema.id)) return { ok: false, reason: 'store-paused' };
    if (!assertSameScope(proposal.scope).ok) return { ok: false, reason: 'scope-changed' };
    const arcs = getArcs();
    const index = arcs.findIndex(arc => arc.id === proposal.sourceArcId);
    if (index < 0) return { ok: false, reason: 'source-deleted' };
    if (!sameRevision(proposal.revision, materialArcShape(arcs[index]))) return { ok: false, reason: 'source-changed' };
    // Rebuild at the final trust boundary from the revision-checked live source.
    // A preview object is intentionally transient and must not be able to alter
    // lifecycle, pin/focus, timestamps, historical beats, or model-owned ids.
    const model = {
        title: cleanText(proposal.proposedArc?.title, 200),
        body: cleanText(proposal.proposedArc?.body, 2000),
        section: SECTIONS.some(section => section.key === proposal.proposedArc?.section)
            ? proposal.proposedArc.section : '',
        pending: Array.isArray(proposal.proposedArc?.beats)
            ? proposal.proposedArc.beats
                .filter(beat => beat?.state === 'pending')
                .map(beat => cleanText(beat.text, 1000))
                .filter(Boolean)
                .slice(0, 20)
            : [],
    };
    let reviewedArc;
    try {
        reviewedArc = proposalArc(proposal.operation, arcs[index], model);
    } catch {
        return { ok: false, reason: 'invalid-proposal' };
    }
    if (proposal.operation !== 'alternate'
        && sameRevision(captureArcRevision(reviewedArc), materialArcShape(arcs[index]))) {
        return { ok: false, reason: 'no-changes' };
    }
    const next = [...arcs];
    if (proposal.operation === 'alternate') {
        // proposalArc mints fresh arc and beat ids for alternate siblings.
        next.splice(index + 1, 0, reviewedArc);
    } else {
        next[index] = reviewedArc;
    }
    const committed = setArcsWithHistory(next, arcs);
    if (!committed.ok) return { ok: false, reason: 'store-refused' };
    incrementPhase7Metrics({ targetedApplied: 1 });
    return { ok: true, arcs: getArcs() };
}

export function targetedOperationLabel(operation) {
    return ({
        rework: 'Rework remaining setup', develop: 'Develop this arc',
        alternate: 'Suggest an alternate route', setup: 'Generate setup beats',
    })[operation] || 'Develop arc';
}