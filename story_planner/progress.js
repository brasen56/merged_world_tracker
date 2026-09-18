/**
 * story_planner/progress.js — Phase 5 evidence-backed progress proposals.
 *
 * This module never changes arc progress during generation. The model can only
 * nominate request-local item/message handles; current-chat identity, excerpt,
 * scope, and arc revision are verified again at the acceptance boundary.
 */
import {
    assertSameScope, captureRevision, captureScope, findQuoteMatch, getChat,
    getOrCreateReceiptIdentity, getStableHistoryEnd, isCancellation,
    normaliseOutput, normalizeForMatch, parseJsonLenient, resolveApiCall,
    sameRevision, stripNonNarrative, wrapTag,
} from '../core/index.js';
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { getSettings, hasValidSettings } from './settings.js';
import { MAX_PROGRESS_METADATA_ENTRIES, storyPlannerSchema } from './schema.js';
import {
    getArcs, getCurrentBeatRecord, getPlanData, isArcReady, setArcBeatState,
    setArcStatus, setPlanData, state,
} from './data.js';

export const PROGRESS_SYSTEM_PROMPT = `You review settled roleplay messages for explicit evidence that planned story progress already happened.

Return ONLY JSON: {"results":[{"item":"i1","verdict":"beat_planted|arc_resolved|no_evidence","source":"m1","excerpt":"short exact quote","reason":"brief explanation"}]}.

Rules:
- Return exactly one result for each item handle.
- beat_planted is allowed only for a beat item; arc_resolved only for a ready-arc item.
- Evidence must explicitly depict the planned event, not merely foreshadow it, discuss a possibility, repeat the plan, or resemble it thematically.
- If evidence is ambiguous, indirect, contradicted, or absent, use no_evidence with an empty source and excerpt.
- For a positive verdict, copy a short, distinctive excerpt verbatim from exactly one supplied message and return that message's handle.
- Never invent handles, excerpts, progress, outcomes, or resolution reasons.`;

const clone = value => JSON.parse(JSON.stringify(value));
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const materialArc = arc => {
    const copy = clone(arc);
    // Store validation/canonicalization may restamp bookkeeping while a
    // watermark is committed. Only user-authored/material state can stale a
    // reviewed suggestion; the check must not invalidate its own result.
    delete copy.updatedAt;
    delete copy.createdAt;
    delete copy.turnsSinceAdvance;
    copy.beats = copy.beats.map(beat => {
        const next = { ...beat };
        delete next.updatedAt;
        return next;
    });
    return copy;
};
const itemKey = item => item.kind === 'beat' ? `beat:${item.arcId}:${item.beatId}` : `arc:${item.arcId}`;
const evidenceKey = suggestion => `${suggestion.itemKey}\u0000${suggestion.messageIdentity}\u0000${normalizeForMatch(suggestion.excerpt)}`;
let chatMutationGeneration = 0;

function checkedItems(arcs = getArcs()) {
    const items = [];
    for (const arc of arcs) {
        if (arc.status !== 'active') continue;
        const beat = getCurrentBeatRecord(arc);
        if (beat) {
            items.push({ kind: 'beat', arcId: arc.id, beatId: beat.id, title: arc.title, text: beat.text });
        } else if (isArcReady(arc)) {
            items.push({ kind: 'arc', arcId: arc.id, title: arc.title, text: arc.body });
        }
    }
    return items;
}

function messageIndexByIdentity(chat, identity) {
    if (!identity) return -1;
    return chat.findIndex(message => getOrCreateReceiptIdentity(message) === identity);
}

function watermarkStartIndex(chat, watermark) {
    const identity = typeof watermark === 'string' ? watermark : watermark?.identity;
    const liveIndex = messageIndexByIdentity(chat, identity);
    if (liveIndex >= 0) return liveIndex + 1;
    // A deletion shifts the following message into the removed message's old
    // slot; a swipe replaces that slot. Resume there rather than reopening all
    // history. Legacy string-only watermarks retain their old fallback.
    if (Number.isInteger(watermark?.index) && watermark.index >= 0) {
        return Math.min(watermark.index, chat.length);
    }
    return 0;
}

function buildRequest(capturedItems, chat, stableEnd, watermarks) {
    const messageHandles = new Map();
    const handleMessages = new Map();
    const itemHandles = new Map();
    const itemLines = [];
    let messageNumber = 0;
    capturedItems.forEach((item, index) => {
        const handle = `i${index + 1}`;
        itemHandles.set(handle, item);
        const candidates = [];
        const startIndex = watermarkStartIndex(chat, watermarks[item.key]);
        for (let messageIndex = startIndex; messageIndex < stableEnd; messageIndex++) {
            const message = chat[messageIndex];
            if (!message || message.is_system) continue;
            const text = stripNonNarrative(message.mes, { preserveOffScreen: false }).trim();
            if (!text) continue;
            const identity = getOrCreateReceiptIdentity(message);
            let messageHandle = messageHandles.get(identity);
            if (!messageHandle) {
                messageHandle = `m${++messageNumber}`;
                messageHandles.set(identity, messageHandle);
                handleMessages.set(messageHandle, { identity, index: messageIndex, message, text });
            }
            candidates.push(messageHandle);
        }
        item.eligibleHandles = new Set(candidates);
        const label = item.kind === 'beat' ? 'CURRENT BEAT' : 'READY ARC PAYOFF';
        itemLines.push(`[${handle}] ${label}\nArc: ${item.title || '(untitled)'}\nTarget: ${item.text || '(no description)'}\nEligible messages: ${candidates.join(', ') || '(none)'}`);
    });
    const messages = [...handleMessages.entries()].map(([handle, entry]) => {
        const name = entry.message.name || (entry.message.is_user ? 'User' : 'Assistant');
        return `[${handle}] ${name}: ${entry.text}`;
    }).join('\n\n');
    return {
        itemHandles,
        handleMessages,
        userContent: [wrapTag('items', itemLines.join('\n\n')), wrapTag('eligible_messages', messages || '(none)'), 'Return the JSON object now.'].join('\n\n'),
    };
}

function parseResults(raw, request) {
    const parsed = parseJsonLenient(normaliseOutput(raw));
    if (!parsed || !Array.isArray(parsed.results)) throw new Error('Progress response did not contain a results array.');
    if (parsed.results.length !== request.itemHandles.size) {
        throw new Error('Progress response must contain exactly one result for every requested item.');
    }
    const seen = new Set();
    for (const result of parsed.results) {
        const handle = clean(result?.item, 20);
        const item = request.itemHandles.get(handle);
        if (!item || seen.has(handle)) throw new Error('Progress response contained an unknown or duplicate item.');
        seen.add(handle);
        const verdict = clean(result?.verdict, 30);
        const expected = item.kind === 'beat' ? 'beat_planted' : 'arc_resolved';
        if (verdict !== 'no_evidence' && verdict !== expected) throw new Error(`Progress response contained an invalid verdict for ${handle}.`);
        if (verdict === 'no_evidence' && (clean(result?.source, 20) || clean(result?.excerpt, 500))) {
            throw new Error(`Progress response supplied evidence for a no_evidence result (${handle}).`);
        }
    }
    return parsed.results;
}

/** Run the manual check and persist watermarks only after a scope-safe result. */
export async function checkProgress() {
    if (state.isGenerating) throw new Error('Story Planner is already generating.');
    if (isStorePausedForCurrentScope(storyPlannerSchema.id)) throw new Error('Story Planner is paused for this chat.');
    if (!hasValidSettings()) throw new Error('Configure an API URL/model or Connection Profile in Story Planner settings first.');
    const arcs = getArcs();
    const items = checkedItems(arcs);
    if (!items.length) throw new Error('No current beats or Ready arcs are available to check.');
    const chat = getChat();
    const stableEnd = getStableHistoryEnd(chat);
    if (stableEnd <= 0) throw new Error('No settled messages are available to check.');
    const scope = captureScope();
    const storedWatermarks = getPlanData().progressWatermarks;
    const storedIgnored = getPlanData().ignoredProgressEvidence;
    const watermarks = storedWatermarks && typeof storedWatermarks === 'object' && !Array.isArray(storedWatermarks)
        ? { ...storedWatermarks }
        : {};
    const ignored = new Set(Array.isArray(storedIgnored) ? storedIgnored : []);
    const capturedItems = items.map(item => {
        const arc = arcs.find(candidate => candidate.id === item.arcId);
        return { ...item, key: itemKey(item), revision: captureRevision(materialArc(arc)) };
    });
    const request = buildRequest(capturedItems, chat, stableEnd, watermarks);
    let finalIndex = stableEnd - 1;
    while (finalIndex >= 0 && (!chat[finalIndex] || chat[finalIndex].is_system)) finalIndex--;
    const finalMessage = chat[finalIndex];
    const finalIdentity = finalMessage ? getOrCreateReceiptIdentity(finalMessage) : '';
    const finalWatermark = finalIdentity ? { identity: finalIdentity, index: finalIndex } : null;
    const mutationAtRequest = chatMutationGeneration;

    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    try {
        const resolved = resolveApiCall({ moduleSettings: getSettings() });
        const raw = await resolved.fetchFn({
            systemPrompt: PROGRESS_SYSTEM_PROMPT,
            userContent: request.userContent,
            settings: resolved.settings,
            trigger: 'manual',
        });
        if (!assertSameScope(scope).ok) return { suggestions: [], noEvidence: 0, stale: true, staleReason: 'The chat changed while progress was checked.' };
        if (chatMutationGeneration !== mutationAtRequest) {
            return { suggestions: [], noEvidence: 0, stale: true, staleReason: 'A message changed while progress was checked.' };
        }
        const currentArcs = getArcs();
        const currentChat = getChat();
        const unchanged = new Map(capturedItems.map(item => {
            const arc = currentArcs.find(candidate => candidate.id === item.arcId);
            return [item.key, !!arc && sameRevision(item.revision, materialArc(arc))];
        }));
        const suggestions = [];
        let noEvidence = 0;
        const settledItems = new Set();
        for (const result of parseResults(raw, request)) {
            const item = request.itemHandles.get(clean(result?.item, 20));
            const verdict = clean(result.verdict, 30);
            if (verdict === 'no_evidence') {
                noEvidence++;
                if (unchanged.get(item.key)) settledItems.add(item.key);
                continue;
            }
            if (!unchanged.get(item.key)) continue;
            const sourceHandle = clean(result.source, 20);
            const source = request.handleMessages.get(sourceHandle);
            const excerpt = clean(result.excerpt, 500);
            if (!source || !item.eligibleHandles.has(sourceHandle) || !excerpt) {
                throw new Error(`Progress response supplied invalid evidence for ${clean(result?.item, 20)}.`);
            }
            const matchedIndex = findQuoteMatch(excerpt, source.index, currentChat, { allowInterposition: false });
            if (matchedIndex < 0) throw new Error(`Progress response supplied an unverifiable excerpt for ${clean(result?.item, 20)}.`);
            const matchedMessage = currentChat[matchedIndex];
            const messageIdentity = getOrCreateReceiptIdentity(matchedMessage);
            if (messageIdentity !== source.identity) throw new Error(`Progress response cited the wrong source for ${clean(result?.item, 20)}.`);
            const suggestion = {
                id: `${item.key}:${messageIdentity}:${normalizeForMatch(excerpt)}`,
                itemKey: item.key, kind: item.kind, arcId: item.arcId, beatId: item.beatId || '',
                arcTitle: item.title, itemText: item.text, verdict, excerpt,
                reason: clean(result.reason, 500), messageIdentity, sourceIndex: matchedIndex,
                scope, revision: item.revision, stale: false, staleReason: '',
                pendingWatermark: finalWatermark,
            };
            if (ignored.has(evidenceKey(suggestion))) settledItems.add(item.key);
            else suggestions.push(suggestion);
        }
        if (finalWatermark && settledItems.size) {
            for (const item of capturedItems) if (settledItems.has(item.key)) watermarks[item.key] = finalWatermark;
            setPlanData({ progressWatermarks: watermarks });
        }
        state.progressSuggestions = suggestions;
        return { suggestions, noEvidence, stale: false };
    } catch (error) {
        if (isCancellation(error)) return null;
        throw error;
    } finally {
        state.isGenerating = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    }
}

function verifySuggestion(suggestion) {
    if (!suggestion || suggestion.stale) return { ok: false, reason: 'stale' };
    if (!assertSameScope(suggestion.scope).ok) return { ok: false, reason: 'scope-changed' };
    const arc = getArcs().find(candidate => candidate.id === suggestion.arcId);
    if (!arc) return { ok: false, reason: 'source-deleted' };
    if (!sameRevision(suggestion.revision, materialArc(arc))) return { ok: false, reason: 'source-changed' };
    const chat = getChat();
    const index = messageIndexByIdentity(chat, suggestion.messageIdentity);
    if (index < 0 || findQuoteMatch(suggestion.excerpt, index, chat, { allowInterposition: false }) !== index) return { ok: false, reason: 'evidence-changed' };
    if (suggestion.kind === 'beat') {
        const beat = arc.beats.find(candidate => candidate.id === suggestion.beatId);
        if (!beat || beat.state !== 'pending') return { ok: false, reason: 'source-changed' };
    } else if (arc.status !== 'active' || !isArcReady(arc)) return { ok: false, reason: 'source-changed' };
    return { ok: true };
}

/** Accept through the ordinary user-authored mutation seams. */
export function acceptProgressSuggestion(suggestion, closeReason = '') {
    if (isStorePausedForCurrentScope(storyPlannerSchema.id)) return { ok: false, reason: 'store-paused' };
    const verified = verifySuggestion(suggestion);
    if (!verified.ok) return verified;
    const updated = suggestion.kind === 'beat'
        ? setArcBeatState(suggestion.arcId, suggestion.beatId, 'planted')
        : setArcStatus(suggestion.arcId, 'resolved', clean(closeReason, 2000));
    if (!updated) return { ok: false, reason: 'store-refused' };
    commitSuggestionWatermark(suggestion);
    state.progressSuggestions = (state.progressSuggestions || []).filter(candidate => candidate !== suggestion);
    return { ok: true, arc: updated };
}

export function ignoreProgressSuggestion(suggestion) {
    if (isStorePausedForCurrentScope(storyPlannerSchema.id)) return { ok: false, reason: 'store-paused' };
    const verified = verifySuggestion(suggestion);
    if (!verified.ok) return verified;
    const storedIgnored = getPlanData().ignoredProgressEvidence;
    const storedWatermarks = getPlanData().progressWatermarks;
    const ignored = [...new Set([...(Array.isArray(storedIgnored) ? storedIgnored : []), evidenceKey(suggestion)])]
        .slice(-MAX_PROGRESS_METADATA_ENTRIES);
    const progressWatermarks = storedWatermarks && typeof storedWatermarks === 'object' && !Array.isArray(storedWatermarks)
        ? { ...storedWatermarks }
        : {};
    if (suggestion.pendingWatermark) progressWatermarks[suggestion.itemKey] = suggestion.pendingWatermark;
    setPlanData({ ignoredProgressEvidence: ignored, progressWatermarks });
    state.progressSuggestions = (state.progressSuggestions || []).filter(candidate => candidate !== suggestion);
    return { ok: true };
}

function commitSuggestionWatermark(suggestion) {
    if (!suggestion?.pendingWatermark) return;
    const stored = getPlanData().progressWatermarks;
    setPlanData({
        progressWatermarks: {
            ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}),
            [suggestion.itemKey]: suggestion.pendingWatermark,
        },
    });
}

/** Mark transient evidence affected by a chat mutation; accepted progress stays. */
export function staleProgressSuggestionsFrom(messageIndex = null, reason = 'The source message changed.') {
    return staleProgressSuggestions(messageIndex, reason, { exact: false });
}

/** Edit/swipe replace one slot; unlike deletion they do not shift later slots. */
export function staleProgressSuggestionsAt(messageIndex = null, reason = 'The source message changed.') {
    return staleProgressSuggestions(messageIndex, reason, { exact: true });
}

function staleProgressSuggestions(messageIndex, reason, { exact }) {
    chatMutationGeneration++;
    for (const suggestion of state.progressSuggestions || []) {
        const affected = !Number.isInteger(messageIndex)
            || (exact ? suggestion.sourceIndex === messageIndex : suggestion.sourceIndex >= messageIndex);
        if (affected) Object.assign(suggestion, { stale: true, staleReason: reason });
    }
}

export function clearProgressSuggestions() {
    state.progressSuggestions = [];
}

export function findProgressSource(suggestion) {
    const chat = getChat();
    const index = messageIndexByIdentity(chat, suggestion?.messageIdentity);
    if (index < 0 || findQuoteMatch(suggestion?.excerpt, index, chat, { allowInterposition: false }) !== index) return null;
    return { index, message: chat[index] };
}