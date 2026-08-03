/**
 * story_planner/generation.js — Story Plan generation via LLM.
 *
 * Depends on data.js, settings.js, prompts.js (leaf modules) and injection.js.
 */

import {
    getContextSafe, getChat,
    resolveApiCall, normaliseOutput, notify,
    getCurrentWorldState, getLatestChronicleEntry,
    stripNonNarrative,
    captureScope, assertSameScope,
} from '../core/index.js';

import { STORY_PLAN_SYSTEM_PROMPT, STORY_PLAN_USER_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings } from './settings.js';
import {
    state, getArcs, setArcs, pushPlanToHistory,
    parsePlanTextToArcs, serializeArcsToText, mergeRegeneratedArcs,
    getDirectionHint, getArcCount,
} from './data.js';
import { applyPlanInjection } from './injection.js';

// ─── Message scan helper ─────────────────────────────────────────────────────

function getRecentMessagesForPlan() {
    const chat = getChat();
    if (!chat || !chat.length) return '';
    const max = 40;
    const slice = chat.slice(-max);
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

function buildUserPrompt(recentText, reminderReason = '') {
    const custom = getSettings().customUserPrompt?.trim();
    const template = custom || STORY_PLAN_USER_PROMPT;

    // Continuity: feed the existing plan back so regeneration refines it instead
    // of starting from a blank menu. Templates that omit {{previousPlan}} simply
    // don't get the block (the token resolves to empty).
    //
    // Dropped arcs are withheld entirely — the user rejecting an idea should
    // mean it stops coming back. Resolved/pinned arcs ARE sent, annotated, so
    // the model knows what has already paid off and what the user cares about.
    const kept = getArcs().filter(a => a.status !== 'dropped');
    const prevPlan = serializeArcsToText(kept, { annotateStatus: true, beats: 'all' }).trim();
    const prevBlock = prevPlan
        ? `<previous_plan>\n[The plan below was generated earlier. Carry forward arcs still in play, evolve those the story is now moving toward, and drop any it has already resolved or contradicted. Refine this against what has since happened — do not simply repeat it.\n\n`
          + `NAMES ARE IDENTIFIERS. An arc's name is how its progress is tracked between generations. If you carry an arc forward, reproduce its name EXACTLY, character for character — do not rename, reword, shorten or otherwise improve it. A renamed arc is read as a brand-new one: its progress is lost and the original is left behind beside it as a duplicate. Only give a name you have not been shown to an arc that is genuinely new.\n\n`
          + `The [BRACKETED] tags are annotations from the tracker, not part of any name — never copy one into a name you write:\n`
          + `- [PINNED] — matters to the user; keep it unless the story has made it impossible.\n`
          + `- [RESOLVED] — already paid off; do not resurface it.\n`
          + `- [SETUP COMPLETE] — ready to happen; do not add more setup to it.\n`
          + `- Beats marked [PLANTED] have already happened on-screen: keep them as-is so they stay part of the record, and do not re-propose that setup. Beats marked [CURRENT] are in progress.]\n${prevPlan}\n</previous_plan>`
        : '';

    // Cross-module grounding. Both getters return '' when the user isn't using
    // that module (no World State document / no Chronicle snapshots), in which
    // case the block is simply omitted — generation still proceeds normally.
    const ws = getCurrentWorldState().trim();
    const wsBlock = ws
        ? `<current_world_state>\n[The current tracked state of the story. Ground your arcs in these threads, pressures, obligations, and character states.]\n${ws}\n</current_world_state>`
        : '';

    const chron = getLatestChronicleEntry().trim();
    const chronBlock = chron
        ? `<recent_chronicle>\n[The most recent chronicle summary of events so far. Use it for longer-range continuity than the recent messages alone provide.]\n${chron}\n</recent_chronicle>`
        : '';

    // User steering — free-text nudge ("more political intrigue", "ease off the
    // romance"). Omitted entirely when blank.
    const hint = getDirectionHint().trim();
    const hintBlock = hint
        ? `<direction>\n[The user wants the plan steered this way. Honour it unless the story makes it impossible.]\n${hint}\n</direction>`
        : '';

    // Use replacement FUNCTIONS (not strings) so that `$` sequences in the
    // replacement text are treated literally. With a replacement string,
    // `String.prototype.replace` interprets `$&`, `$1`, `$$`, etc. as special
    // patterns — so chat text containing "$100" would become "$1" (empty
    // capture group) + "0" = "0", corrupting the user's history.
    let out = template
        .replace(/\{\{chatHistory\}\}/g, () => recentText || 'No recent messages.')
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
            userContent: buildUserPrompt(recent),
            settings: resolved.settings,
        });
        let text = normaliseOutput(result);
        let validation = validateOutput(text, expectHeader);

        if (!validation.ok) {
            console.warn(`[MWT:StoryPlanner] First attempt rejected: ${validation.reason} — retrying once`);
            const resolved2 = resolveApiCall({ moduleSettings: getSettings() });
            result = await resolved2.fetchFn({
                systemPrompt,
                userContent: buildUserPrompt(recent, validation.reason),
                settings: resolved2.settings,
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

        const parsed = parsePlanTextToArcs(text);
        if (parsed.length === 0) {
            // Validation passed (bullets were present) but nothing survived the
            // parse — bail rather than wiping a good plan with an empty one.
            throw new Error('Could not parse any arcs out of the model response.');
        }

        // Snapshot the plan we're about to replace so a regeneration is
        // recoverable via History/Revert.
        const previous = getArcs();
        if (previous.length) pushPlanToHistory(previous);

        // Merge rather than replace: arcs matched by name keep their id and
        // their planted-beat progress, and pinned / part-planted arcs the model
        // dropped are carried forward rather than lost.
        const { arcs: newArcs, carried, matched, added } = mergeRegeneratedArcs(previous, parsed);

        setArcs(newArcs);
        applyPlanInjection();
        console.log(`[MWT:StoryPlanner] Plan generated — ${matched} arcs kept with progress, ${added} new, ${carried} carried forward (${newArcs.length} total)`);
        return newArcs;
    } catch (err) {
        console.error('[MWT:StoryPlanner] Generation failed:', err);
        if (!isAuto) notify('Story Planner', `Generation failed: ${err.message}`, 'error');
        throw err;
    } finally {
        state.isGenerating = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    }
}
