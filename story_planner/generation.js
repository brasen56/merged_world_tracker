/**
 * story_planner/generation.js — Story Plan generation via LLM.
 *
 * Depends on data.js, settings.js, prompts.js (leaf modules) and injection.js.
 */

import {
    getChat,
    resolveApiCall, normaliseOutput, notify,
    getWorldStateFactual, getLatestChronicleEntry,
    stripNonNarrative, getStableHistoryEnd,
    captureScope, assertSameScope, isCancellation,
    captureRevision, sameRevision,
    wrapTag, escapePromptText, buildSafeCharacterContext, listSafeCharacterContextCandidates,
    resolveSafeCharacterContextEntities, record,
    buildAuthorCharacterContext,
} from '../core/index.js';

import { STORY_PLAN_SYSTEM_PROMPT, STORY_PLAN_USER_PROMPT, buildStoryPlanSystemPrompt } from './prompts.js';
import { getSettings, hasValidSettings } from './settings.js';
// Part 6 (§7.4) pause guard. Direct import (not the barrel) so the REAL
// pause singleton is read even under the test barrel→stub alias.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { MAX_CONTINUITY_BEATS_PER_ARC, SECTIONS, storyPlannerSchema, sanitizeStoryPlanRequest, sanitizeCharacterContextSelection, getStoryPlanRequestError, strictSectionKeyFromLabel } from './schema.js';
import {
    state, getArcs, setArcs, pushPlanToHistory,
    parsePlanTextToArcs, serializeArcsToText, mergeRegeneratedArcs,
    getDirectionHint, getArcCount, buildClosedMemoryProjection, buildParkedMemoryProjection,
    getStoryPalette, getCharacterContextSelection,
    incrementPhase7Metrics, recordPhase7Request,
} from './data.js';
import { applyPlanInjection } from './injection.js';
import { captureTargetRevisions, findChangedProposalTargets } from './proposals.js';

// ─── Message scan helper ─────────────────────────────────────────────────────

export function getRecentMessagesForPlan() {
    const chat = getChat();
    if (!chat || !chat.length) return '';
    const max = 40;
    const end = getStableHistoryEnd(chat);
    const slice = chat.slice(Math.max(0, end - max), end);
    const lines = [];
    let total = 0;
    const maxChars = 30000;
    for (let i = slice.length - 1; i >= 0; i--) {
        const msg = slice[i];
        if (msg?.is_system) continue;
        const name = msg?.name || (msg?.is_user ? 'User' : 'Assistant');
        const text = stripNonNarrative(String(msg?.mes || '').trim());
        if (!text) continue;
        const line = `${name}: ${text}`;
        if (total + line.length > maxChars) break;
        lines.push(line);
        total += line.length + 1;
    }
    return lines.reverse().join('\n');
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

export function buildSystemPrompt(requestSpec = null, settings = getSettings()) {
    const custom = settings.customSystemPrompt?.trim();
    // Scoped requests must keep their format and mutation envelope application-
    // owned. Custom system prompts remain supported by the legacy full-plan path.
    if (!requestSpec) return custom || STORY_PLAN_SYSTEM_PROMPT;
    const request = sanitizeStoryPlanRequest(requestSpec);
    return buildStoryPlanSystemPrompt(request.sectionKeys);
}

// Bounded, but wide enough to cover a legal plan (getArcCount caps at 30). For
// scoped Add this projection is the model's ONLY view of the existing plan, so
// a tighter cap would hide arcs it could then re-propose — those come back as
// excluded title recurrences and underfill the request for no visible reason.
const MAX_CONTINUITY_ARCS = 30;
// Prompt projection policy only. Keep this independent from
// MAX_CONTINUITY_BEATS_PER_ARC, which is the response-validation contract for
// where a newcomer entrance marker may appear.
export const MAX_CONTINUITY_BEATS_SHOWN = 4;
// A complete-arc budget: continuity rows are never sliced mid-arc. This bounds
// long-campaign prompt growth while preserving the most useful arcs in their
// existing priority/order and making omitted context explicit to the model.
export const MAX_CONTINUITY_CHARS = 16000;
export const MAX_JOURNEY_SUBJECT_CANDIDATES = 30;

function subjectCandidateForEntityId(candidates, entityId) {
    return candidates.find(candidate => candidate.entityId === entityId
        || candidate.mergedEntityIds?.includes(entityId));
}

/**
 * Capture the bounded subject table while reserving identities that the request
 * must be able to address. Refresh owners come first because a returned row is
 * invalid unless its subject handle resolves to the target's canonical owner;
 * selected Add subjects follow so registry growth/reordering cannot strand a
 * choice made in the dialog before generation starts.
 */
export function captureJourneySubjectCandidates(candidates, request, capturedArcs = []) {
    const available = Array.isArray(candidates) ? candidates : [];
    const priorityIds = [
        ...(request?.operation === 'refresh'
            ? capturedArcs.filter(arc => arc.section === 'character')
                .flatMap(arc => [arc.primarySubjectEntityId, ...(arc.supportingParticipantEntityIds || [])])
            : []),
        ...(request?.subjectMode === 'selected' ? request.subjectEntityIds || [] : []),
    ].filter(Boolean);
    const reserved = [];
    const reservedIds = new Set();
    const missingOwnerIds = [];
    const refreshOwnerIds = new Set(request?.operation === 'refresh'
        ? capturedArcs.filter(arc => arc.section === 'character').map(arc => arc.primarySubjectEntityId).filter(Boolean)
        : []);

    for (const entityId of priorityIds) {
        const candidate = subjectCandidateForEntityId(available, entityId);
        if (!candidate) {
            if (refreshOwnerIds.has(entityId) && !missingOwnerIds.includes(entityId)) missingOwnerIds.push(entityId);
            continue;
        }
        if (!reservedIds.has(candidate.entityId)) {
            reservedIds.add(candidate.entityId);
            reserved.push(candidate);
        }
    }
    const remaining = available.filter(candidate => !reservedIds.has(candidate.entityId));
    return {
        candidates: [...reserved, ...remaining].slice(0, MAX_JOURNEY_SUBJECT_CANDIDATES),
        missingOwnerIds,
    };
}

export function buildReadOnlyContinuityProjection(arcs) {
    if (!Array.isArray(arcs) || !arcs.length) return '';
    const candidates = arcs.slice(0, MAX_CONTINUITY_ARCS);
    const rows = candidates.map(arc => {
        const section = SECTIONS.find(item => item.key === arc.section)?.label || arc.section;
        const summary = String(arc.body || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        const storedBeats = Array.isArray(arc.beats) ? arc.beats : [];
        // Keep pending beats visible even when an arc has already accumulated
        // enough historical setup to fill the projection. Entrance evidence is
        // validated against the first pending beats, so showing only the stored
        // prefix can hide the very beat the next scoped request needs to see.
        const pendingBeats = storedBeats.filter(beat => beat?.state === 'pending');
        const historicalBeats = storedBeats.filter(beat => beat?.state !== 'pending');
        const beats = [
            ...pendingBeats.slice(0, MAX_CONTINUITY_BEATS_SHOWN),
            ...historicalBeats.slice(0, Math.max(0, MAX_CONTINUITY_BEATS_SHOWN - pendingBeats.length)),
        ].map(beat => {
            const stateLabel = beat?.state === 'planted' ? 'PLANTED'
                : beat?.state === 'skipped' ? 'SKIPPED' : 'PENDING';
            const text = String(beat?.text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
            return text ? `  - [${stateLabel}] ${text}` : '';
        }).filter(Boolean);
        const text = [
            `- [${section}] ${String(arc.title || 'Untitled arc').slice(0, 90)}${summary ? ` — ${summary}` : ''}`,
            ...beats,
        ].join('\n');
        return { text, escapedChars: escapePromptText(text).length };
    });
    const included = [];
    let chars = 0;
    for (const row of rows) {
        const cost = row.escapedChars + (included.length ? 1 : 0);
        if (chars + cost > MAX_CONTINUITY_CHARS) break;
        included.push(row);
        chars += cost;
    }
    if (included.length < candidates.length) {
        let omitted = candidates.length - included.length;
        let marker = `[${omitted} additional active arc${omitted === 1 ? '' : 's'} omitted by the ${MAX_CONTINUITY_CHARS}-character continuity budget.]`;
        while (included.length && chars + 1 + marker.length > MAX_CONTINUITY_CHARS) {
            const removed = included.pop();
            chars -= removed.escapedChars + (included.length ? 1 : 0);
            omitted = candidates.length - included.length;
            marker = `[${omitted} additional active arc${omitted === 1 ? '' : 's'} omitted by the ${MAX_CONTINUITY_CHARS}-character continuity budget.]`;
        }
        if (marker.length <= MAX_CONTINUITY_CHARS) included.push({ text: marker, escapedChars: marker.length });
    }
    return included.map(row => row.text).join('\n');
}

export function storyPaletteProjection(palette = getStoryPalette(), castPolicy = palette.castPolicy) {
    const lines = [];
    if (palette.emphases.length) lines.push(`Emphasis preferences (not quotas): ${palette.emphases.join(', ')}.`);
    if (palette.escalation !== 'balanced') lines.push(`Escalation preference: ${palette.escalation}.`);
    lines.push('Cast novelty and plot escalation are separate choices: a newcomer need not raise the stakes, and escalation need not add a newcomer. Keep any addition genre-appropriate and useful to the requested arc; friends, clients, witnesses, colleagues, relatives, and other non-antagonist roles are valid.');
    lines.push('A character already evidenced in the story is established even without a Knowledge record. Registry absence is not proof that someone is new.');
    if (castPolicy === 'existing-only') {
        lines.push('Cast policy — established cast only: use established named story participants. Do not propose a new recurring or major character. Incidental unnamed service or background characters are allowed.');
        lines.push('Do not emit [NEWCOMER:*] or [ENTRANCE:*] proposal markers.');
    } else if (castPolicy === 'propose') {
        lines.push('Cast policy — actively propose new characters: for an Add request, include at least one distinct recurring or major newcomer in an arc that gives them a concrete on-screen entrance. For Refresh or single-arc development, a newcomer is optional and must fit that arc rather than creating an unrelated route.');
        lines.push(`Mark each proposed newcomer arc with one bounded proposal-local handle, for example [NEWCOMER:n1], and mark exactly one concrete setup beat within the first ${MAX_CONTINUITY_BEATS_PER_ARC} beats of that same arc [ENTRANCE:n1]. Reuse neither handle on another arc.`);
    } else {
        lines.push('Cast policy — new characters allowed: the user allows new major characters when expansion genuinely serves the story. Prefer useful established threads and cast; there is no newcomer quota.');
        lines.push(`If you propose a recurring or major newcomer, mark its arc [NEWCOMER:n1] and exactly one concrete entrance beat within the first ${MAX_CONTINUITY_BEATS_PER_ARC} beats of that same arc [ENTRANCE:n1]. Do not mark established characters.`);
    }
    return lines.join('\n');
}

export const CAST_POLICY_LABELS = Object.freeze({
    'existing-only': 'Established cast only',
    allowed: 'New characters allowed',
    propose: 'Actively propose new characters',
});

/** Describe the effective cast policy, its owner, and template compatibility. */
export function describeCastPolicyRequest({ workflow = 'legacy-full', requestSpec = null, settings = getSettings(), palette = getStoryPalette() } = {}) {
    if (workflow === 'manual-scoped') {
        const request = sanitizeStoryPlanRequest(requestSpec);
        return {
            policy: request.castPolicy,
            policyLabel: CAST_POLICY_LABELS[request.castPolicy],
            source: 'manual-request',
            sourceLabel: 'Generate dialog request',
            supported: true,
            template: 'built-in-scoped',
            message: 'The built-in scoped request applies this policy through an application-owned clause.',
        };
    }
    const policy = palette.castPolicy;
    const targeted = workflow === 'targeted';
    const customUser = String(settings.customUserPrompt || '').trim();
    const supported = targeted || !customUser || customUser.includes('{{storyPalette}}');
    const template = targeted ? 'built-in-targeted'
        : !customUser ? 'built-in-full'
            : supported ? 'custom-compatible' : 'custom-incompatible';
    return {
        policy,
        policyLabel: CAST_POLICY_LABELS[policy],
        source: 'story-palette',
        sourceLabel: 'Story Palette',
        supported,
        template,
        message: supported
            ? (targeted
                ? 'The built-in targeted request applies this policy through an application-owned clause.'
                : template === 'custom-compatible'
                    ? 'The custom full-plan template receives this policy through {{storyPalette}}.'
                    : 'The built-in full-plan request applies this policy through an application-owned clause.')
            : 'The custom full-plan user template omits {{storyPalette}}, so cast policy is unsupported for this call. Use scoped generation, restore the built-in user prompt, or add the token.',
    };
}

export function buildUserPrompt(recentText, reminderReason = '', requestContext = {}) {
    const settings = requestContext.settings || getSettings();
    const custom = settings.customUserPrompt?.trim();
    // Scoped generation is application-owned. A legacy custom template may still
    // be used for the unrestricted full-plan path, but it cannot silently bypass
    // the selected sections/count envelope.
    const request = requestContext.requestSpec
        ? sanitizeStoryPlanRequest(requestContext.requestSpec)
        : null;
    const template = request ? STORY_PLAN_USER_PROMPT : (custom || STORY_PLAN_USER_PROMPT);

    // Continuity: feed the existing plan back so regeneration refines it instead
    // of starting from a blank menu. Templates that omit {{previousPlan}} simply
    // don't get the block (the token resolves to empty).
    //
    // Closed arcs are retained as a small memory projection. Their beat routes
    // are historical detail and must not inflate every regeneration prompt.
    const allArcs = getArcs();
    const kept = Array.isArray(requestContext.capturedArcs)
        ? [...requestContext.capturedArcs]
        : allArcs.filter(a => a.status === 'active');
    // Handles are deliberately request-local: they are useful to the model for
    // identity, but are never persisted and never expose v1 arc/beat IDs.
    const requestHandles = requestContext.handles instanceof Map
        ? requestContext.handles
        : mintRequestHandles(kept);
    const prevPlan = serializeArcsToText(kept, {
        annotateStatus: true, beats: 'all', handles: requestHandles, prioritizeFocused: true,
    }).trim();
    const continuity = buildReadOnlyContinuityProjection(requestContext.continuityArcs);
    const continuityBlock = continuity
        ? `<read_only_continuity>\n[These unrelated active arcs are continuity context only. Do not return, rename, refresh, or otherwise edit them. Avoid duplicate or contradictory proposals.]\n${escapePromptText(continuity)}\n</read_only_continuity>`
        : '';
    const closedMemory = buildClosedMemoryProjection(allArcs);
    const closedBlock = closedMemory
        ? `<closed_story_ideas>\n[These ideas are closed. Do not propose a resolved payoff again or rephrase a dropped direction.]\n${escapePromptText(closedMemory)}\n</closed_story_ideas>`
        : '';
    const parkedTitles = buildParkedMemoryProjection(allArcs);
    const parkedBlock = parkedTitles
        ? `<shelved_story_ideas>\n[These ideas are parked for later. Do not propose, rename, or reactivate them.]\n${escapePromptText(parkedTitles)}\n</shelved_story_ideas>`
        : '';
    const prevBlock = [closedBlock, parkedBlock, continuityBlock, prevPlan
        ? `<previous_plan>\n[The plan below was generated earlier. Carry forward arcs still in play, evolve those the story is now moving toward, and drop any it has already resolved or contradicted. Refine this against what has since happened — do not simply repeat it.\n\n`
          + `NAMES ARE IDENTIFIERS. An arc's name is how its progress is tracked between generations. If you carry an arc forward, reproduce its name EXACTLY, character for character — do not rename, reword, shorten or otherwise improve it. A renamed arc is read as a brand-new one: its progress is lost and the original is left behind beside it as a duplicate. Only give a name you have not been shown to an arc that is genuinely new.\n\n`
          + `The [BRACKETED] tags are annotations from the tracker, not part of any name — never copy one into a name you write:\n`
          + `- [PINNED] — matters to the user; keep it unless the story has made it impossible.\n`
          + `- [SETUP COMPLETE] — ready to happen; do not add more setup to it.\n`
          + `- [ARC:…] in front of a name — the tracker's marker for that arc. When you carry the arc forward, copy its marker exactly at the start of the bullet, before the name and outside any bold, even if the story has changed the arc. Never put a marker on a new arc, on a beat, or on a different arc.\n`
          + `- Beats marked [PLANTED] have already happened on-screen: keep them as-is so they stay part of the record, and do not re-propose that setup. Beats marked [SKIPPED] did not happen: do not describe them as completed or re-add them as setup. Beats marked [CURRENT] are in progress.]\n${escapePromptText(prevPlan)}\n</previous_plan>`
        : ''].filter(Boolean).join('\n\n');

    // Cross-module grounding. Both getters return '' when the user isn't using
    // that module (no World State document / no Chronicle snapshots), in which
    // case the block is simply omitted — generation still proceeds normally.
    const ws = getWorldStateFactual().trim();
    const wsBlock = ws
        ? wrapTag('current_world_state',
            '[The current tracked state of the story. Ground your arcs in these threads, pressures, obligations, and character states.]\n' + ws)
        : '';

    const chron = getLatestChronicleEntry().trim();
    const chronBlock = chron
        ? wrapTag('recent_chronicle',
            '[The most recent chronicle summary of events so far. Use it for longer-range continuity than the recent messages alone provide.]\n' + chron)
        : '';

    // User steering — free-text nudge ("more political intrigue", "ease off the
    // romance"). Omitted entirely when blank.
    const hint = getDirectionHint().trim();
    const hintBlock = hint
        ? wrapTag('direction',
            '[The user wants the plan steered this way. Honour it unless the story makes it impossible.]\n' + hint)
        : '';
    const savedPalette = requestContext.palette || getStoryPalette();
    const castPolicyContract = requestContext.castPolicyContract || describeCastPolicyRequest({
        workflow: request ? 'manual-scoped' : 'legacy-full',
        requestSpec: request,
        palette: savedPalette,
    });
    const palette = storyPaletteProjection(savedPalette, castPolicyContract.policy);
    const paletteBlock = palette ? wrapTag('story_palette', palette) : '';
    const characterContext = requestContext.characterContext || { text: '' };
    const characterBlock = characterContext.text
        ? wrapTag('safe_character_context',
            '[Factual public character context only. It is not private knowledge and does not determine choices or outcomes.]\n' + characterContext.text)
        : '';
    const subjectCandidates = Array.isArray(requestContext.subjectCandidates) ? requestContext.subjectCandidates : [];
    const selectedSubjectIds = new Set(request?.subjectEntityIds || []);
    const subjectRows = subjectCandidates.map((candidate, index) => {
        const handle = `s${index + 1}`;
        const selected = selectedSubjectIds.has(candidate.entityId) ? ' [SELECTED]' : '';
        const name = String(candidate.name || 'Unnamed character').replace(/\s+/g, ' ').trim().slice(0, 120);
        return `- ${handle}: ${escapePromptText(name)}${selected}`;
    });
    const targetOwnership = request?.operation === 'refresh'
        ? kept.filter(arc => arc.section === 'character').map(arc => {
            const arcHandle = requestHandles.get(arc.id);
            const subjectIndex = subjectCandidates.findIndex(candidate => candidate.entityId === arc.primarySubjectEntityId
                || candidate.mergedEntityIds?.includes(arc.primarySubjectEntityId));
            return arcHandle && subjectIndex >= 0 ? `- ARC:${arcHandle} must keep SUBJECT:s${subjectIndex + 1}.` : '';
        }).filter(Boolean)
        : [];
    const subjectBlock = request?.sectionKeys.includes('character') ? [
        '<journey_subjects>',
        '[Opaque request-local handles. Use these handles in markers; never invent a handle or return an entity id.]',
        ...subjectRows,
        request.subjectMode === 'selected'
            ? 'Selected mode: every Character Journey primary must use a [SELECTED] handle, and each selected handle must be primary at least once before any repeat.'
            : 'Any mode: every Character Journey primary may use any captured handle.',
        'Every Character Journey bullet must begin with exactly one [SUBJECT:sN] marker and may add one [SUPPORT:sN,sN] marker. Do not put these markers on other sections.',
        'A Journey should pressure a value, relationship, fear, habit, or obligation; provide an observable opportunity to respond and possible consequences. Resistance, relapse, deterioration, repair, or no resolution are all valid. Never decide what {{user}} thinks, chooses, or does.',
        ...targetOwnership,
        '</journey_subjects>',
    ].join('\n') : '';

    // Use replacement FUNCTIONS (not strings) so that `$` sequences in the
    // replacement text are treated literally. With a replacement string,
    // `String.prototype.replace` interprets `$&`, `$1`, `$$`, etc. as special
    // patterns — so chat text containing "$100" would become "$1" (empty
    // capture group) + "0" = "0", corrupting the user's history.
    // STORY-PLANNER-07: Escape user/model content before interpolation. The
    // recent story and previous plan are the two blocks still interpolated
    // raw into <recent_story>/<previous_plan>, and both can contain `<`,
    // `&`, or closing-tag sequences that would break the structural boundary.
    // (The world-state/chronicle/direction blocks above already go through
    // wrapTag().) Replacement FUNCTIONS are still used so `$` sequences in the
    // content are treated literally rather than interpreted by replace().
    const recentBlock = escapePromptText(recentText || 'No recent messages.');
    let out = template
        .replace(/\{\{chatHistory\}\}/g, () => recentBlock)
        .replace(/\{\{previousPlan\}\}/g, () => prevBlock)
        .replace(/\{\{worldState\}\}/g, () => wsBlock)
        .replace(/\{\{lastChronicle\}\}/g, () => chronBlock)
        .replace(/\{\{directionHint\}\}/g, () => hintBlock)
        // The Phase 6 blocks are ordinary context tokens, and they sit with
        // the other grounding blocks ABOVE the template's closing instruction.
        // They must never be appended after the rendered template: the
        // built-in prompt ends with "Begin immediately with the first section
        // heading", and a tag trailing that line invites exactly the preamble
        // validateOutput() rejects — turning a palette into a silent second
        // API call. A custom template that omits the token simply gets no
        // block, the same contract as {{worldState}}.
        .replace(/\{\{storyPalette\}\}/g, () => paletteBlock)
        .replace(/\{\{safeCharacterContext\}\}/g, () => characterBlock)
        .replace(/\{\{arcCount\}\}/g, () => String(request?.requestedCount ?? getArcCount()));

    if (request) {
        const labels = request.sectionKeys.map(key => SECTIONS.find(section => section.key === key)?.label || key);
        const operationText = request.operation === 'add'
            ? `Propose exactly up to ${request.requestedCount} new arc${request.requestedCount === 1 ? '' : 's'} across the selected sections.`
            : `Refresh only the captured existing arcs. Do not add new arcs; omitted targets remain unchanged.`;
        const scopeBlock = [
            '<application_request>',
            `Operation: ${request.operation === 'add' ? 'Add ideas' : 'Refresh selected arcs'}.`,
            `Selected sections: ${labels.join(', ')}.`,
            operationText,
            'Return only arcs in the selected sections. Never use another section as a fallback.',
            '</application_request>',
        ].join('\n');
        out = `${scopeBlock}${subjectBlock ? `\n\n${subjectBlock}` : ''}\n\n${out}`;
    }

    if (reminderReason) {
        out += `\n\n[REMINDER: Your previous attempt was rejected — ${reminderReason}. Output ONLY the story plan document (section headings with bulleted arcs beneath them). No narration, apology, or preamble.]`;
    }
    return out;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a generated plan. Rejects empty output, refusals/apologies, obvious
 * roleplay narration, and responses with too few bulleted arcs to be a plan.
 *
 * @param {string}  text
 * @param {boolean} expectHeader — require a Markdown "## " heading (default true;
 *   relaxed when a custom system prompt may define a different format)
 */
export function validateOutput(text, expectHeader = true, requestSpec = null) {
    if (!text || !text.trim()) return { ok: false, reason: 'empty response' };
    const trimmed = text.trim();

    // Refusal / apology — model declined instead of planning.
    if (/^\s*(I'm sorry|I am sorry|Sorry[,.]|I cannot|I can't|I won't|I'm unable|I am unable|As an AI|Unfortunately[,.])/i.test(trimmed)) {
        return { ok: false, reason: 'response looks like a refusal or apology, not a plan' };
    }

    // Roleplay narration leaked in instead of a structured plan.
    if (/\b(you see|you notice|you feel)\b/i.test(trimmed)) {
        return { ok: false, reason: 'second-person narration detected — model continued the story instead of planning' };
    }

    // A plan is a list of arcs — require a few bullets so prose replies are caught.
    const bulletCount = (trimmed.match(/^[ \t]*[-*][ \t]+/gm) || []).length;
    const request = requestSpec ? sanitizeStoryPlanRequest(requestSpec) : null;
    const minimum = request ? 1 : 3;
    if (bulletCount < minimum) {
        return { ok: false, reason: `only ${bulletCount} bulleted arc(s) found — expected a list of plot developments` };
    }

    if (expectHeader && !/^##[ \t]+\S/m.test(trimmed)) {
        return { ok: false, reason: 'no Markdown "## " section heading found' };
    }

    if (request) {
        const selected = new Set(request.sectionKeys);
        const headings = [...trimmed.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)]
            .map(match => strictSectionKeyFromLabel(match[1]));
        if (headings.some(key => !key)) {
            return { ok: false, reason: 'response contains an unrecognized section heading' };
        }
        if (headings.some(key => !selected.has(key))) {
            return { ok: false, reason: 'response contains a section outside the requested scope' };
        }
        // Overflow is NOT checked here. `bulletCount` counts every dash bullet,
        // including the beat bullets a model writes when it ignores the numbered
        // beat format, so a single arc with three beats reads as four arcs.
        // selectScopedParsedArcs computes overflow from the parsed arcs and the
        // review surfaces it as diagnostics.overflow.
    }
    return { ok: true };
}

/** Evaluate transient newcomer/entrance evidence before merge sanitization drops it. */
export function assessNewcomerEvidence(arcs, castPolicyContract, { reviewed = false, operation = 'add', targeted = false } = {}) {
    const policy = castPolicyContract?.policy || 'allowed';
    const rows = (arcs || []).map(arc => ({
        title: arc.title || 'Untitled arc',
        marked: !!(arc._newcomerHandle || arc._newcomerMarkerError || arc._entranceHandles?.length),
        valid: !!arc._newcomerEvidence && !arc._newcomerMarkerError,
        handle: arc._newcomerEvidence?.handle || arc._newcomerHandle || '',
        error: arc._newcomerMarkerError || '',
    }));
    const marked = rows.filter(row => row.marked);
    const valid = rows.filter(row => row.valid);
    const malformed = rows.filter(row => row.error);
    if (castPolicyContract?.supported === false) {
        return {
            ok: true,
            rows,
            validCount: 0,
            message: 'Newcomer evidence was not evaluated because this custom template does not support the cast-policy contract.',
            unsupported: true,
            attribution: {
                plannerOutcome: 'not-evaluated', proposedCount: 0, narrationOutcome: 'not-evaluated',
                message: 'Planner newcomer outcome: not evaluated on this unsupported path. Narration introduction: not evaluated.',
            },
        };
    }
    if (malformed.length) {
        return { ok: false, reason: `${malformed[0].title}: ${malformed[0].error}.`, rows, validCount: valid.length };
    }
    if (policy === 'existing-only' && marked.length) {
        return { ok: false, reason: 'The response explicitly marked a newcomer while the effective cast policy was Established cast only.', rows, validCount: valid.length };
    }
    const required = policy === 'propose' && operation === 'add' && !targeted;
    if (required && valid.length === 0 && !reviewed) {
        return { ok: false, reason: 'The active-proposal cast policy required a newcomer arc with one paired concrete entrance beat, but none was returned.', rows, validCount: 0 };
    }
    let message = '';
    if (required && valid.length === 0) message = 'Unmet cast requirement: no suitable newcomer with a paired concrete entrance beat was proposed.';
    else if (policy === 'propose' && valid.length === 0) message = 'No suitable newcomer proposed for this arc request.';
    else if (valid.length) message = `${valid.length} newcomer proposal${valid.length === 1 ? '' : 's'} include${valid.length === 1 ? 's' : ''} a paired concrete entrance beat.`;
    const attribution = {
        plannerOutcome: valid.length ? 'proposed' : 'none-explicitly-marked',
        proposedCount: valid.length,
        narrationOutcome: 'not-evaluated',
        message: valid.length
            ? `Planner outcome: ${valid.length} hypothetical newcomer proposal${valid.length === 1 ? '' : 's'} returned. Narration introduction: not evaluated or asserted.`
            : 'Planner outcome: no explicitly marked newcomer proposal returned. Unmarked prose still requires human review; narration introduction was not evaluated or asserted.',
    };
    return { ok: true, rows, validCount: valid.length, message, attribution, unmetRequirement: required && valid.length === 0 };
}

/** Enforce the immutable scoped request after parsing. Refresh accepts only
 * identities resolved inside the captured target set; Add accepts only selected
 * sections and caps the reviewable suggestions to the requested count. */
export function selectScopedParsedArcs(parsed, requestSpec, capturedArcs = [], subjectCandidates = []) {
    const request = sanitizeStoryPlanRequest(requestSpec);
    const selectedSections = new Set(request.sectionKeys);
    const selectedSubjects = new Set(request.subjectEntityIds);
    const canonicalSubjectId = entityId => subjectCandidates.find(candidate => candidate.entityId === entityId
        || candidate.mergedEntityIds?.includes(entityId))?.entityId || entityId;
    const validOwnership = arc => {
        if (arc._subjectMarkerError) return false;
        if (arc.section !== 'character') return !arc.primarySubjectEntityId && !arc.supportingParticipantEntityIds?.length;
        if (!arc._subjectContractActive) return true;
        if (!arc.primarySubjectEntityId) return false;
        return request.subjectMode !== 'selected' || selectedSubjects.has(arc.primarySubjectEntityId);
    };
    const inSections = parsed.filter(arc => selectedSections.has(arc.section) && validOwnership(arc));
    const rejectedOutsideScope = parsed.filter(arc => !selectedSections.has(arc.section) || !validOwnership(arc));
    if (request.operation === 'refresh') {
        const targetIds = new Set(capturedArcs.map(arc => arc.id));
        const accepted = [];
        const rejected = [...rejectedOutsideScope];
        const acceptedIds = new Set();
        for (const arc of inSections) {
            const target = capturedArcs.find(item => item.id === arc.id);
            const crossesCharacterBoundary = !!target
                && (arc.section === 'character') !== (target.section === 'character');
            if (!targetIds.has(arc.id) || acceptedIds.has(arc.id) || crossesCharacterBoundary
                || (target?.section === 'character'
                    && canonicalSubjectId(target?.primarySubjectEntityId) !== canonicalSubjectId(arc.primarySubjectEntityId))) {
                rejected.push(arc);
                continue;
            }
            acceptedIds.add(arc.id);
            accepted.push(arc);
        }
        return { accepted, rejected, overflow: 0, underfill: 0, deferredForCoverage: 0 };
    }
    const accepted = (() => {
        if (request.subjectMode !== 'selected' || !request.sectionKeys.includes('character')) {
            return inSections.slice(0, request.requestedCount);
        }
        const selected = [];
        const used = new Set();
        for (const entityId of request.subjectEntityIds) {
            const match = inSections.find(arc => arc.primarySubjectEntityId === entityId && !used.has(arc));
            if (match) { selected.push(match); used.add(match); }
        }
        if (selected.length < request.subjectEntityIds.length) return selected;
        for (const arc of inSections) {
            if (selected.length >= request.requestedCount) break;
            if (!used.has(arc)) selected.push(arc);
        }
        return selected;
    })();
    const overflow = Math.max(0, inSections.length - request.requestedCount);
    return {
        accepted,
        rejected: rejectedOutsideScope,
        overflow,
        // Valid, in-scope arcs held back purely by the coverage rule — a second
        // arc for an already-covered subject while another selected subject has
        // none. They are neither overflow nor rejected output, so without their
        // own count they would disappear from review with no explanation.
        deferredForCoverage: Math.max(0, inSections.length - accepted.length - overflow),
        underfill: Math.max(
            0,
            request.requestedCount - accepted.length,
            request.subjectMode === 'selected' && request.sectionKeys.includes('character')
                ? request.subjectEntityIds.filter(id => !inSections.some(arc => arc.primarySubjectEntityId === id)).length
                : 0,
        ),
    };
}

// ─── Generate ────────────────────────────────────────────────────────────────

/**
 * Generate a fresh story plan via the LLM and store it in chat metadata.
 *
 * @param {boolean} [isAuto=false] — true when triggered automatically
 * @param {{reviewOnly?: boolean, characterContextSelection?: object|null}} [options]
 * @returns {Promise<object[]|null>} the new arc list, or null if skipped/failed
 */
export async function generatePlan(isAuto = false, requestSpec = null, { reviewOnly = false, characterContextSelection = null, authorContextSelection = null } = {}) {
    if (authorContextSelection && (isAuto || !requestSpec || !reviewOnly)) throw new Error('Private context requires a reviewed scoped request.');
    // Part 6 (§7.4): the pause gate is a data-integrity stop — generation
    // would read the unprepared store, spend an API call, and have its
    // refused write (setArcs under the paused seam) mask the loss. Manual
    // entry points (the Generate button, /wt-plan) bypass the event router's
    // decline predicate, so the choke point itself must refuse.
    if (isStorePausedForCurrentScope(storyPlannerSchema.id)) {
        console.warn('[MWT:StoryPlanner] Cannot generate — the store is paused for this chat (schema preparation).');
        // Stay silent for auto-runs (the router declines those anyway), but
        // tell the user when they clicked Generate.
        if (isAuto) return null;
        throw new Error('Story Planner is paused for this chat — its data could not be safely prepared. Use ⬇ Download recovery data to repair it, then press Retry in the Story Planner tab.');
    }
    if (state.isGenerating) {
        if (isAuto) return null;
        throw new Error('Story plan is already generating.');
    }
    if (!hasValidSettings()) {
        console.warn('[MWT:StoryPlanner] Cannot generate — settings incomplete');
        // Stay silent for auto-runs, but tell the user when they clicked Generate
        // (otherwise the button just appears to do nothing).
        if (!isAuto) {
            throw new Error('No API connection configured. Open ⚙️ Story Planner Settings, enter your API URL + Model, then click "Save Settings".');
        }
        return null;
    }

    // STORY-PLANNER-01: Capture scope before any async operation. The old
    // weak key collapsed two different chats on the same character when
    // chatId was absent. The scope guard uses getCurrentChatId() + epoch.
    const scopeBefore = captureScope();
    let request = requestSpec ? sanitizeStoryPlanRequest(requestSpec) : null;
    // Prompt compatibility, rendering, and transport resolution must describe
    // one immutable request. In particular, character-context construction can
    // await a provider; settings changed during that wait belong to the next
    // request, not this one (and must not invalidate the captured policy claim).
    const settingsSnapshot = Object.freeze({ ...getSettings() });
    const capturedPalette = getStoryPalette();
    const paletteSnapshot = Object.freeze({
        ...capturedPalette,
        emphases: Object.freeze([...capturedPalette.emphases]),
    });
    const castPolicyContract = describeCastPolicyRequest({
        workflow: request ? 'manual-scoped' : 'legacy-full',
        requestSpec: request,
        settings: settingsSnapshot,
        palette: paletteSnapshot,
    });
    if (isAuto && castPolicyContract.policy !== 'allowed' && !castPolicyContract.supported) {
        console.warn(`[MWT:StoryPlanner] Automatic generation skipped — ${castPolicyContract.message}`);
        notify('Story Planner', `Automatic generation skipped: ${castPolicyContract.message}`, 'warning');
        return null;
    }
    if (request?.sectionKeys.includes('character') && request.subjectMode === 'selected') {
        const resolution = resolveSafeCharacterContextEntities(request.subjectEntityIds);
        if (resolution.missing?.length) {
            throw new Error(`${resolution.missing.length} selected Journey subject${resolution.missing.length === 1 ? ' is' : 's are'} no longer available. Reopen Generate and choose tracked characters again.`);
        }
        request = sanitizeStoryPlanRequest({
            ...request,
            subjectEntityIds: resolution.resolved.map(item => item.entityId),
        });
    }
    const requestError = request ? getStoryPlanRequestError(request) : '';
    if (requestError) throw new Error(requestError);

    // STORY-PLANNER-02: Capture the arc revision at START so we can detect
    // user edits/pins/deletes made during the API call. The old code read
    // `getArcs()` AFTER the call returned, which meant user changes during
    // the call were silently overwritten and the history snapshot recorded
    // the already-modified state as "previous."
    const arcsBeforeCall = getArcs();

    // §5 2C: with no assignable subject there is no valid Character Journey
    // call to make. Drop that one section and answer the rest — failing a
    // five-section request because Knowledge has no tracked characters yet
    // makes the planner unusable on a fresh chat. Only a request that has
    // nothing left to ask for is an error.
    const allSubjectCandidates = request?.sectionKeys.includes('character')
        ? listSafeCharacterContextCandidates()
        : [];
    const droppedSections = [];
    if (request?.sectionKeys.includes('character') && allSubjectCandidates.length === 0) {
        if (request.sectionKeys.length === 1) {
            throw new Error('No assignable Journey subject is available. Enable Knowledge and add at least one tracked character, or choose a different section.');
        }
        droppedSections.push('character');
        request = sanitizeStoryPlanRequest({
            ...request,
            sectionKeys: request.sectionKeys.filter(key => key !== 'character'),
            subjectMode: 'any',
            subjectEntityIds: [],
            // A Character Journey target cannot be refreshed without its owner,
            // so it leaves the captured set with the section rather than being
            // silently reported as omitted by the model.
            targetArcIds: request.targetArcIds.filter(id =>
                arcsBeforeCall.find(arc => arc.id === id)?.section !== 'character'),
        });
        if (request.operation === 'refresh' && !request.targetArcIds.length) {
            throw new Error('Every selected arc is a Character Journey, and no assignable Journey subject is available. Enable Knowledge and add at least one tracked character.');
        }
    }

    if (request?.operation === 'refresh') {
        const unassignedTargets = arcsBeforeCall.filter(arc => request.targetArcIds.includes(arc.id)
            && arc.section === 'character' && !arc.primarySubjectEntityId);
        if (unassignedTargets.length) {
            throw new Error('Assign a primary subject to every selected Character Journey before refreshing it. Journey ownership can only be changed manually.');
        }
    }
    const arcRevision = captureRevision(arcsBeforeCall);
    // The parser must use the same request snapshot that was shown to the
    // model. Closed arcs are intentionally absent from the prompt and therefore
    // cannot be addressed by a returned handle or fallback.
    //
    // §4.2: edit handles are issued ONLY for eligible targets. Scoped Add has
    // no edit targets — it is append-only — so it captures nothing and sees the
    // existing plan as bounded read-only continuity instead. Handing Add the
    // editable previous-plan block would both mint handles for arcs it may not
    // touch and contradict its own "propose N new arcs" envelope with the
    // full-plan "carry forward / drop resolved" instructions.
    const activeArcs = arcsBeforeCall.filter(a => a.status === 'active');
    const capturedArcs = !request
        ? activeArcs
        : request.operation === 'refresh'
            ? activeArcs.filter(a => request.targetArcIds.includes(a.id)
                && request.sectionKeys.includes(a.section))
            : [];
    const continuityArcs = request
        ? activeArcs.filter(a => !capturedArcs.some(target => target.id === a.id))
        : [];
    const targetSnapshots = request?.operation === 'refresh'
        ? capturedArcs.map(arc => JSON.parse(JSON.stringify(arc)))
        : [];
    const targetRevisions = captureTargetRevisions(targetSnapshots);
    const requestHandles = mintRequestHandles(capturedArcs);
    const arcsByHandle = new Map(capturedArcs.map(arc => [requestHandles.get(arc.id), arc]));
    const subjectCapture = request?.sectionKeys.includes('character')
        ? captureJourneySubjectCandidates(allSubjectCandidates, request, capturedArcs)
        : { candidates: [], missingOwnerIds: [] };
    const subjectCandidates = subjectCapture.candidates;
    if (subjectCapture.missingOwnerIds.length) {
        throw new Error(`${subjectCapture.missingOwnerIds.length} selected Character Journey owner${subjectCapture.missingOwnerIds.length === 1 ? ' is' : 's are'} unavailable in Knowledge. Reopen Generate or manually assign an available primary subject before refreshing.`);
    }
    if (request?.subjectMode === 'selected') {
        const capturedSubjectIds = new Set(subjectCandidates.map(candidate => candidate.entityId));
        const omittedSelections = request.subjectEntityIds.filter(entityId => !capturedSubjectIds.has(entityId));
        if (omittedSelections.length) {
            throw new Error(`${omittedSelections.length} selected Journey subject${omittedSelections.length === 1 ? ' is' : 's are'} outside the ${MAX_JOURNEY_SUBJECT_CANDIDATES}-character request limit. Reopen Generate and choose from the visible subject list.`);
        }
    }
    const subjectHandles = new Map(subjectCandidates.map((candidate, index) => [`s${index + 1}`, candidate.entityId]));

    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));

    try {
        const chat = getChat();
        if (!chat || chat.length === 0) return null;

        const recent = getRecentMessagesForPlan();
        if (!recent || recent.length < 100) {
            throw new Error('Not enough chat history to generate a plan.');
        }

        const systemPrompt = buildSystemPrompt(request, settingsSnapshot);
        // A custom system prompt may define its own format, so only enforce the
        // "## " heading check when we're using the built-in default prompt.
        const expectHeader = !!request || !settingsSnapshot.customSystemPrompt?.trim();

        // The scoped Generate dialog may narrow Selected context for this one
        // request without rewriting the user's saved Story Planner setting.
        // Legacy/full-plan and automatic calls continue to read the saved
        // selection exactly as before.
        const selection = request && characterContextSelection
            ? {
                ...sanitizeCharacterContextSelection(characterContextSelection),
                excludedEntityIds: sanitizeCharacterContextSelection({
                    mode: 'selected', entityIds: characterContextSelection.excludedEntityIds,
                }).entityIds,
            }
            : getCharacterContextSelection();
        const requestedPrimarySubjectIds = request?.sectionKeys.includes('character')
            ? request.subjectMode === 'selected'
                ? request.subjectEntityIds
                : capturedArcs.filter(arc => arc.section === 'character').map(arc => arc.primarySubjectEntityId).filter(Boolean)
            : [];
        const characterContext = await buildSafeCharacterContext({
            ...selection,
            primarySubjectEntityIds: requestedPrimarySubjectIds,
        });
        const authorContext = authorContextSelection
            ? await buildAuthorCharacterContext(authorContextSelection) : null;
        if (authorContextSelection && !authorContext?.text) throw new Error('Author context returned no complete records; no planning request was sent.');
        const contextScope = assertSameScope(scopeBefore);
        if (!contextScope.ok) {
            console.warn(`[MWT:StoryPlanner] Chat switched while building character context (${contextScope.reason}) — discarding request.`);
            return null;
        }
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
        const resolved = resolveApiCall({ moduleSettings: settingsSnapshot });
        const requestDiagnostics = {
            characterContextChars: Number(characterContext.chars) || String(characterContext.text || '').length,
            characterContextTokens: Number(characterContext.tokens) || Math.ceil(String(characterContext.text || '').length / 4),
            characterContextRecords: Number(characterContext.records) || 0,
        };
        const firstUserContent = buildUserPrompt(recent, '', {
            capturedArcs, handles: requestHandles,
            continuityArcs, characterContext, requestSpec: request, subjectCandidates, castPolicyContract,
            settings: settingsSnapshot, palette: paletteSnapshot,
        });
        const authorInstruction = authorContext?.text
            ? '\n\n<author_context>\nPrivate planning context, sent only for this reviewed request. Canon Lock is immutable. Use it to avoid contradictions; do not copy hidden facts to public title, premise, beats, or payoff. Include only facts the user wants revealable now. Never determine {{user}} actions.\n'
                + escapePromptText(authorContext.text) + '\n</author_context>' : '';
        const reviewedUserContent = firstUserContent + authorInstruction;
        recordPhase7Request('full', systemPrompt.length + reviewedUserContent.length);
        let result = await resolved.fetchFn({
            systemPrompt,
            userContent: reviewedUserContent,
            settings: resolved.settings,
            // Coordinator classification (TODO §1): scheduled auto-plans are
            // background work; the Generate button is foreground.
            trigger: isAuto ? 'auto' : 'manual',
            requestDiagnostics,
        });
        let text = normaliseOutput(result);
        let validation = validateOutput(text, expectHeader, request);

        if (!validation.ok) {
            console.warn(`[MWT:StoryPlanner] First attempt rejected: ${validation.reason} — retrying once`);
            const resolved2 = resolveApiCall({ moduleSettings: settingsSnapshot });
            if (!assertSameScope(scopeBefore).ok) return null;
            const retryUserContent = buildUserPrompt(recent, validation.reason, {
                capturedArcs, handles: requestHandles,
                continuityArcs, characterContext, requestSpec: request, subjectCandidates, castPolicyContract,
                settings: settingsSnapshot, palette: paletteSnapshot,
            });
            recordPhase7Request('full', systemPrompt.length + retryUserContent.length + authorInstruction.length);
            result = await resolved2.fetchFn({
                systemPrompt,
                userContent: retryUserContent + authorInstruction,
                settings: resolved2.settings,
                trigger: isAuto ? 'auto' : 'manual',
                requestDiagnostics,
            });
            text = normaliseOutput(result);
            validation = validateOutput(text, expectHeader, request);
            if (!validation.ok) {
                throw new Error(`Model output rejected after retry: ${validation.reason}`);
            }
        }

        // STORY-PLANNER-01: Assert scope before any writes.
        const scopeResult = assertSameScope(scopeBefore);
        if (!scopeResult.ok) {
            console.warn(
                `[MWT:StoryPlanner] Chat switched during generation (${scopeResult.reason}) — ` +
                `discarding result to avoid cross-chat contamination.`
            );
            return null;
        }

        const parsed = parsePlanTextToArcs(text, {
            handles: arcsByHandle,
            capturedArcs,
            strictHeadings: !!request,
            subjectHandles: request?.sectionKeys.includes('character') ? subjectHandles : undefined,
        });
        // Malformed evidence and existing-only violations invalidate the whole
        // response, including overflow rows. Active-proposal coverage, however,
        // is measured only from the accepted scoped set: a newcomer hidden on an
        // excluded overflow suggestion must not satisfy a one-arc request.
        const responseNewcomerEvidence = assessNewcomerEvidence(parsed, castPolicyContract, {
            reviewed: true,
            operation: request ? 'refresh' : 'add',
        });
        if (!responseNewcomerEvidence.ok) throw new Error(responseNewcomerEvidence.reason);
        const scopedSelection = request ? selectScopedParsedArcs(parsed, request, capturedArcs, subjectCandidates) : null;
        const limitedParsed = scopedSelection ? scopedSelection.accepted : parsed;
        const newcomerEvidence = assessNewcomerEvidence(limitedParsed, castPolicyContract, {
            reviewed: reviewOnly && !!request,
            operation: request?.operation || 'add',
        });
        if (!newcomerEvidence.ok) throw new Error(newcomerEvidence.reason);
        record({
            level: 'info', module: 'story_planner', event: 'newcomer_outcome',
            detail: {
                workflow: request ? 'scoped' : isAuto ? 'automatic' : 'legacy-full',
                policy: castPolicyContract.policy,
                supported: castPolicyContract.supported !== false,
                plannerOutcome: newcomerEvidence.attribution?.plannerOutcome || 'not-evaluated',
                proposedCount: newcomerEvidence.attribution?.proposedCount || 0,
                narrationOutcome: 'not-evaluated',
            },
        });
        const rejectedSuggestions = scopedSelection?.rejected.map(arc => arc.title) || [];
        const participantDiagnostics = limitedParsed
            .filter(arc => arc._participantDiagnostic)
            .map(arc => `${arc.title || 'Untitled Character Journey'}: ${arc._participantDiagnostic}.`);
        // §4.1: zero valid arcs is a failed operation, for both operations. A
        // Refresh whose output resolved to none of the captured targets has
        // nothing to review, so it must fail rather than open an empty modal
        // over a live Apply button.
        if (request && limitedParsed.length === 0) {
            throw new Error(request.operation === 'add'
                ? 'No valid arcs were returned inside the requested scope.'
                : 'The response did not return any of the selected arcs — they remain unchanged.');
        }
        if (parsed.length === 0) {
            // Validation passed (bullets were present) but nothing survived the
            // parse — bail rather than wiping a good plan with an empty one.
            throw new Error('Could not parse any arcs out of the model response.');
        }

        // STORY-PLANNER-02: Detect same-chat edits. If the user changed the
        // plan during the API call, the current arcs differ from the revision
        // captured at start. Rebase against the CURRENT state (which includes
        // user changes) rather than the stale snapshot, so pins/edits/deletes
        // made during the call survive.
        const currentArcs = getArcs();
        const changedTargetIds = request?.operation === 'refresh'
            ? findChangedProposalTargets(request.targetArcIds, targetRevisions, currentArcs)
            : [];
        const arcsUnchanged = sameRevision(arcRevision, currentArcs);
        const mergeBase = arcsUnchanged ? arcsBeforeCall : currentArcs;
        const currentById = new Map(currentArcs.map(arc => [arc.id, arc]));
        const deletedIds = new Set(arcsBeforeCall
            .filter(arc => !currentById.has(arc.id))
            .map(arc => arc.id));
        const deletedTitles = new Set(arcsBeforeCall
            .filter(arc => deletedIds.has(arc.id))
            .map(arc => normaliseArcTitleForRace(arc.title)));
        const protectedIds = new Set(currentArcs
            .filter(current => {
                const before = arcsBeforeCall.find(arc => arc.id === current.id);
                // Protect both edits to captured arcs and arcs created after the
                // request began. The latter have no captured identity, but must
                // not disappear merely because the stale response omitted them.
                return !before || !sameArcForGeneration(before, current);
            })
            .map(arc => arc.id));
        if (!arcsUnchanged) {
            console.log('[MWT:StoryPlanner] Plan changed during generation — rebasing against current state.');
        }

        // Merge rather than replace: arcs matched by name keep their id and
        // their planted-beat progress, and pinned / part-planted arcs the model
        // dropped are carried forward rather than lost.
        const { arcs: mergedArcs, carried, matched, added, suppressedClosed, excludedRecurrences = [], matchedIds = [], addedIds = [] } = mergeRegeneratedArcs(mergeBase, limitedParsed, {
            deletedIds,
            deletedTitles,
            protectedIds,
            scope: request ? new Set(request.operation === 'refresh' ? request.targetArcIds : []) : null,
            scopeSections: request?.operation === 'add' ? new Set(request.sectionKeys) : null,
            addOnly: request?.operation === 'add',
            preserveSupportingParticipants: !request,
        });
        // mergeRegeneratedArcs preserves an existing primary owner verbatim so
        // ordinary regeneration cannot reassign it. Scoped Refresh has already
        // verified the returned owner is the same identity through the captured
        // alias/merge table, so upgrade only those accepted targets to the
        // canonical id carried by the opaque subject handle.
        const canonicalRefreshOwners = request?.operation === 'refresh'
            ? new Map(limitedParsed
                .filter(arc => arc.section === 'character' && arc.primarySubjectEntityId)
                .map(arc => [arc.id, arc.primarySubjectEntityId]))
            : new Map();
        const newArcs = canonicalRefreshOwners.size
            ? mergedArcs.map(arc => canonicalRefreshOwners.has(arc.id)
                ? { ...arc, primarySubjectEntityId: canonicalRefreshOwners.get(arc.id) }
                : arc)
            : mergedArcs;

        // Evidence is first checked on the raw response because merge metadata
        // is intentionally transient. Check it again on the reconstructed arcs
        // before history is written: Add may exclude an exact-title recurrence,
        // and merge may otherwise remove the beat paired with a newcomer.
        const reviewedMergeIds = request?.operation === 'add'
            ? new Set(addedIds)
            : request?.operation === 'refresh'
                ? new Set(matchedIds)
                : null;
        const survivingEvidence = limitedParsed.map(parsedArc => {
            const entranceIndex = parsedArc._newcomerEvidence?.entranceBeatIndex;
            const entranceText = Number.isInteger(entranceIndex) ? parsedArc.beats?.[entranceIndex]?.text : '';
            const candidate = newArcs.find(arc => (!reviewedMergeIds || reviewedMergeIds.has(arc.id))
                && (arc.id === parsedArc.id
                || (normaliseArcTitleForRace(arc.title) === normaliseArcTitleForRace(parsedArc.title)
                    && (!entranceText || arc.beats?.some(beat => normaliseArcTitleForRace(beat.text) === normaliseArcTitleForRace(entranceText))))));
            if (!candidate || !parsedArc._newcomerEvidence) return candidate ? { ...parsedArc, _newcomerMarkerError: parsedArc._newcomerMarkerError } : null;
            const finalEntranceIndex = candidate.beats.findIndex(beat => beat.state === 'pending'
                && normaliseArcTitleForRace(beat.text) === normaliseArcTitleForRace(entranceText));
            if (finalEntranceIndex < 0) return { ...parsedArc, _newcomerMarkerError: 'the paired entrance beat did not survive merging' };
            return {
                ...candidate,
                _newcomerHandle: parsedArc._newcomerHandle,
                _entranceHandles: [parsedArc._newcomerEvidence.handle],
                _entranceBeatIndex: finalEntranceIndex,
                _newcomerEvidence: { handle: parsedArc._newcomerEvidence.handle, entranceBeatIndex: finalEntranceIndex },
            };
        }).filter(Boolean);
        const mergedNewcomerEvidence = assessNewcomerEvidence(survivingEvidence, castPolicyContract, {
            reviewed: reviewOnly && !!request,
            operation: request?.operation || 'add',
        });
        if (!mergedNewcomerEvidence.ok) throw new Error(mergedNewcomerEvidence.reason);
        if (newcomerEvidence.validCount > mergedNewcomerEvidence.validCount
            && !(reviewOnly && request?.operation === 'add')) {
            throw new Error('A marked newcomer entrance did not survive the final plan merge.');
        }

        // STORY-PLANNER-02: Snapshot the PRE-OPERATION arcs for history, not
        // whatever is current after the API returned. This is what makes
        // Revert restore the pre-generation plan. Do this only after all
        // post-merge validation has passed.
        if (arcsBeforeCall.length && !reviewOnly) pushPlanToHistory(arcsBeforeCall);
        const finalNewcomerEvidence = mergedNewcomerEvidence;

        if (reviewOnly && request) {
            const omittedTargetIds = request.operation === 'refresh'
                ? request.targetArcIds.filter(id => !matchedIds.includes(id))
                : [];
            const reviewedArcIds = new Set(request.operation === 'add' ? addedIds : matchedIds);
            const referencedSubjectIds = new Set([
                ...(request.subjectMode === 'selected' ? request.subjectEntityIds : []),
                ...targetSnapshots.flatMap(arc => [arc.primarySubjectEntityId, ...(arc.supportingParticipantEntityIds || [])]),
                ...newArcs.filter(arc => reviewedArcIds.has(arc.id))
                    .flatMap(arc => [arc.primarySubjectEntityId, ...(arc.supportingParticipantEntityIds || [])]),
            ].filter(Boolean));
            const reviewSubjectCandidates = [...subjectCandidates];
            const reviewCandidateIds = new Set(reviewSubjectCandidates.map(candidate => candidate.entityId));
            for (const entityId of referencedSubjectIds) {
                const candidate = subjectCandidateForEntityId(allSubjectCandidates, entityId);
                if (candidate && !reviewCandidateIds.has(candidate.entityId)) {
                    reviewCandidateIds.add(candidate.entityId);
                    reviewSubjectCandidates.push(candidate);
                }
            }
            return {
                arcs: newArcs,
                previousArcs: mergeBase,
                scope: scopeBefore,
                request,
                castPolicyContract: { ...castPolicyContract },
                stats: { carried, matched, added, suppressedClosed },
                targetSnapshots,
                targetRevisions,
                stale: changedTargetIds.length > 0,
                staleReason: changedTargetIds.length
                    ? 'A selected target changed or was deleted while this proposal was generated.'
                    : '',
                changedTargetIds,
                addedArcIds: addedIds,
                matchedArcIds: matchedIds,
                reviewArcIds: request.operation === 'add' ? addedIds : matchedIds,
                subjectCandidates: reviewSubjectCandidates.map(candidate => ({
                    entityId: candidate.entityId,
                    name: candidate.name,
                    mergedEntityIds: [...(candidate.mergedEntityIds || [])],
                })),
                subjectIdentitySnapshot: [...referencedSubjectIds].map(requestedEntityId => {
                    const candidate = subjectCandidateForEntityId(allSubjectCandidates, requestedEntityId);
                    return {
                        requestedEntityId,
                        resolved: !!candidate,
                        entityId: candidate?.entityId || '',
                    };
                }),
                diagnostics: {
                    authorContextCoverage: authorContext?.coverage || [],
                    authorContextUsed: !!authorContext?.text,
                    droppedSections,
                    deferredForCoverage: scopedSelection?.deferredForCoverage || 0,
                    overflow: scopedSelection?.overflow || 0,
                    underfill: request.operation === 'add'
                        ? Math.max(scopedSelection?.underfill || 0, request.requestedCount - added)
                        : 0,
                    omittedTargetIds,
                    rejectedSuggestions,
                    participantDiagnostics,
                    excludedRecurrences,
                    validationWarning: validation.warning || '',
                    newcomerEvidence: finalNewcomerEvidence.rows,
                    newcomerPolicyMessage: finalNewcomerEvidence.message,
                    newcomerOutcomeAttribution: finalNewcomerEvidence.attribution,
                    newcomerRequirementUnmet: finalNewcomerEvidence.unmetRequirement === true,
                    characterContextMode: selection.mode,
                    characterContextStatus: characterContext.status || '',
                    characterContextCoverage: Array.isArray(characterContext.coverage)
                        ? characterContext.coverage.map(item => ({ ...item }))
                        : [],
                },
            };
        }

        setArcs(newArcs);
        incrementPhase7Metrics({
            fullGenerations: 1,
            closedRecurrencesSuppressed: suppressedClosed,
        });
        applyPlanInjection();
        console.log(`[MWT:StoryPlanner] Plan generated — ${matched} arcs kept with progress, ${added} new, ${carried} carried forward, ${suppressedClosed} closed recurrence(s) suppressed (${newArcs.length} total)`);
        return newArcs;
    } catch (err) {
        // Coordinator cancellation (TODO §1): the chat changed mid-generation
        // and the coordinator aborted the call. The scope guard would have
        // discarded the result anyway — return quietly. isCancellation()
        // covers both the marked JobCancelledError and the native AbortError
        // of a mid-wire abort.
        if (isCancellation(err)) {
            console.log('[MWT:StoryPlanner] Generation cancelled (coordinator) — discarded.');
            return null;
        }
        console.error('[MWT:StoryPlanner] Generation failed:', err);
        if (!isAuto) notify('Story Planner', `Generation failed: ${err.message}`, 'error');
        throw err;
    } finally {
        state.isGenerating = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    }
}

// Consonant–digit–consonant (`k7q`): never a word the model reads as prose, and
// none of the characters that are easy to confuse when copied back (0/o, 1/l/i).
const HANDLE_LETTERS = 'bcdfghjkmnpqrstvwxz';
const HANDLE_DIGITS = '23456789';

/**
 * Mint a short, unique handle for each arc shown to the model in one request.
 *
 * Handles are random rather than sequential: an `a1, a2, …` series reads as
 * list numbering, which invites the model to renumber the markers in its own
 * output order or to continue the series onto new arcs — both of which would
 * hand one arc's progress to another.
 *
 * @param {object[]} arcs
 * @returns {Map<string, string>} arc id → lowercase handle
 */
function mintRequestHandles(arcs) {
    const pick = chars => chars[Math.floor(Math.random() * chars.length)];
    const handles = new Map();
    const used = new Set();
    for (const arc of arcs) {
        let handle;
        do {
            handle = pick(HANDLE_LETTERS) + pick(HANDLE_DIGITS) + pick(HANDLE_LETTERS);
            // 2,888 three-character handles; lengthen rather than loop if a
            // plan ever holds a meaningful fraction of them.
            if (used.size > 500) handle += pick(HANDLE_DIGITS) + pick(HANDLE_LETTERS);
        } while (used.has(handle));
        used.add(handle);
        handles.set(arc.id, handle);
    }
    return handles;
}

function normaliseArcTitleForRace(title) {
    return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,;_*#]/g, '');
}

function sameArcForGeneration(before, current) {
    const comparable = arc => {
        const copy = { ...arc };
        delete copy.updatedAt;
        delete copy.turnsSinceAdvance;
        copy.beats = (copy.beats || []).map(beat => {
            const beatCopy = { ...beat };
            delete beatCopy.updatedAt;
            return beatCopy;
        });
        return JSON.stringify(copy);
    };
    return comparable(before) === comparable(current);
}
