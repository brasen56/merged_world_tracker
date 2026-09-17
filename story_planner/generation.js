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
    wrapTag, escapePromptText,
} from '../core/index.js';

import { STORY_PLAN_SYSTEM_PROMPT, STORY_PLAN_USER_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings } from './settings.js';
// Part 6 (§7.4) pause guard. Direct import (not the barrel) so the REAL
// pause singleton is read even under the test barrel→stub alias.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { storyPlannerSchema } from './schema.js';
import {
    state, getArcs, setArcs, pushPlanToHistory,
    parsePlanTextToArcs, serializeArcsToText, mergeRegeneratedArcs,
    getDirectionHint, getArcCount, buildClosedMemoryProjection, buildParkedMemoryProjection,
} from './data.js';
import { applyPlanInjection } from './injection.js';

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

function buildSystemPrompt() {
    const custom = getSettings().customSystemPrompt?.trim();
    return custom || STORY_PLAN_SYSTEM_PROMPT;
}

export function buildUserPrompt(recentText, reminderReason = '', requestContext = {}) {
    const custom = getSettings().customUserPrompt?.trim();
    const template = custom || STORY_PLAN_USER_PROMPT;

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
    const closedMemory = buildClosedMemoryProjection(allArcs);
    const closedBlock = closedMemory
        ? `<closed_story_ideas>\n[These ideas are closed. Do not propose a resolved payoff again or rephrase a dropped direction.]\n${escapePromptText(closedMemory)}\n</closed_story_ideas>`
        : '';
    const parkedTitles = buildParkedMemoryProjection(allArcs);
    const parkedBlock = parkedTitles
        ? `<shelved_story_ideas>\n[These ideas are parked for later. Do not propose, rename, or reactivate them.]\n${escapePromptText(parkedTitles)}\n</shelved_story_ideas>`
        : '';
    const prevBlock = [closedBlock, parkedBlock, prevPlan
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
        .replace(/\{\{arcCount\}\}/g, () => String(getArcCount()));

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
function validateOutput(text, expectHeader = true) {
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
    if (bulletCount < 3) {
        return { ok: false, reason: `only ${bulletCount} bulleted arc(s) found — expected a list of plot developments` };
    }

    if (expectHeader && !/^##[ \t]+\S/m.test(trimmed)) {
        return { ok: false, reason: 'no Markdown "## " section heading found' };
    }

    return { ok: true };
}

// ─── Generate ────────────────────────────────────────────────────────────────

/**
 * Generate a fresh story plan via the LLM and store it in chat metadata.
 *
 * @param {boolean} [isAuto=false] — true when triggered automatically
 * @returns {Promise<object[]|null>} the new arc list, or null if skipped/failed
 */
export async function generatePlan(isAuto = false) {
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

    // STORY-PLANNER-02: Capture the arc revision at START so we can detect
    // user edits/pins/deletes made during the API call. The old code read
    // `getArcs()` AFTER the call returned, which meant user changes during
    // the call were silently overwritten and the history snapshot recorded
    // the already-modified state as "previous."
    const arcsBeforeCall = getArcs();
    const arcRevision = captureRevision(arcsBeforeCall);
    // The parser must use the same request snapshot that was shown to the
    // model. Closed arcs are intentionally absent from the prompt and therefore
    // cannot be addressed by a returned handle or fallback.
    const capturedArcs = arcsBeforeCall.filter(a => a.status === 'active');
    const requestHandles = mintRequestHandles(capturedArcs);
    const arcsByHandle = new Map(capturedArcs.map(arc => [requestHandles.get(arc.id), arc]));

    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));

    try {
        const chat = getChat();
        if (!chat || chat.length === 0) return null;

        const recent = getRecentMessagesForPlan();
        if (!recent || recent.length < 100) {
            throw new Error('Not enough chat history to generate a plan.');
        }

        const systemPrompt = buildSystemPrompt();
        // A custom system prompt may define its own format, so only enforce the
        // "## " heading check when we're using the built-in default prompt.
        const expectHeader = !getSettings().customSystemPrompt?.trim();

        const resolved = resolveApiCall({ moduleSettings: getSettings() });
        let result = await resolved.fetchFn({
            systemPrompt,
            userContent: buildUserPrompt(recent, '', { capturedArcs, handles: requestHandles }),
            settings: resolved.settings,
            // Coordinator classification (TODO §1): scheduled auto-plans are
            // background work; the Generate button is foreground.
            trigger: isAuto ? 'auto' : 'manual',
        });
        let text = normaliseOutput(result);
        let validation = validateOutput(text, expectHeader);

        if (!validation.ok) {
            console.warn(`[MWT:StoryPlanner] First attempt rejected: ${validation.reason} — retrying once`);
            const resolved2 = resolveApiCall({ moduleSettings: getSettings() });
            result = await resolved2.fetchFn({
                systemPrompt,
                userContent: buildUserPrompt(recent, validation.reason, { capturedArcs, handles: requestHandles }),
                settings: resolved2.settings,
                trigger: isAuto ? 'auto' : 'manual',
            });
            text = normaliseOutput(result);
            validation = validateOutput(text, expectHeader);
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

        const parsed = parsePlanTextToArcs(text, { handles: arcsByHandle, capturedArcs });
        if (parsed.length === 0) {
            // Validation passed (bullets were present) but nothing survived the
            // parse — bail rather than wiping a good plan with an empty one.
            throw new Error('Could not parse any arcs out of the model response.');
        }

        // STORY-PLANNER-02: Snapshot the PRE-OPERATION arcs for history, not
        // whatever is current after the API returned. This is what makes
        // Revert restore the pre-generation plan.
        if (arcsBeforeCall.length) pushPlanToHistory(arcsBeforeCall);

        // STORY-PLANNER-02: Detect same-chat edits. If the user changed the
        // plan during the API call, the current arcs differ from the revision
        // captured at start. Rebase against the CURRENT state (which includes
        // user changes) rather than the stale snapshot, so pins/edits/deletes
        // made during the call survive.
        const currentArcs = getArcs();
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
        const { arcs: newArcs, carried, matched, added } = mergeRegeneratedArcs(mergeBase, parsed, {
            deletedIds,
            deletedTitles,
            protectedIds,
        });

        setArcs(newArcs);
        applyPlanInjection();
        console.log(`[MWT:StoryPlanner] Plan generated — ${matched} arcs kept with progress, ${added} new, ${carried} carried forward (${newArcs.length} total)`);
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
