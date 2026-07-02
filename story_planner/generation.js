/**
 * story_planner/generation.js — Story Plan generation via LLM.
 *
 * Depends on data.js, settings.js, prompts.js (leaf modules) and injection.js.
 */

import {
    getContextSafe, getChat,
    resolveApiCall, normaliseOutput, notify,
    getCurrentWorldState, getLatestChronicleEntry,
} from '../core/index.js';

import { STORY_PLAN_SYSTEM_PROMPT, STORY_PLAN_USER_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings } from './settings.js';
import { state, setPlanData, getPlanText, pushPlanToHistory } from './data.js';
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
        const text = String(msg?.mes || '').trim();
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
    const prevPlan = getPlanText().trim();
    const prevBlock = prevPlan
        ? `<previous_plan>\n[The plan below was generated earlier. Carry forward arcs still in play, evolve those the story is now moving toward, and drop any it has already resolved or contradicted. Refine it against what has since happened — do not simply repeat it.]\n${prevPlan}\n</previous_plan>`
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

    let out = template
        .replace(/\{\{chatHistory\}\}/g, recentText || 'No recent messages.')
        .replace(/\{\{previousPlan\}\}/g, prevBlock)
        .replace(/\{\{worldState\}\}/g, wsBlock)
        .replace(/\{\{lastChronicle\}\}/g, chronBlock);

    if (reminderReason) {
        out += `\n\n[REMINDER: Your previous attempt was rejected — ${reminderReason}. Output ONLY the story plan document (a bulleted list of future arcs). No narration, apology, or preamble.]`;
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
    if (/\b(you see|you notice|before you|you feel)\b/i.test(trimmed)) {
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
 * @returns {Promise<string|null>} the plan text, or null if skipped/failed
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

    const ctxBefore = getContextSafe();
    const chatKeyBefore = `${ctxBefore?.characterId ?? ''}|${ctxBefore?.groupId ?? ''}|${ctxBefore?.chatId ?? ''}`;
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

        const ctxAfter = getContextSafe();
        const chatKeyAfter = `${ctxAfter?.characterId ?? ''}|${ctxAfter?.groupId ?? ''}|${ctxAfter?.chatId ?? ''}`;
        if (chatKeyAfter !== chatKeyBefore) {
            console.warn('[MWT:StoryPlanner] Chat switched during generation — discarding result.');
            return null;
        }

        // Snapshot the plan we're about to overwrite so a regeneration is
        // recoverable via History/Revert.
        const oldText = getPlanText();
        if (oldText?.trim()) pushPlanToHistory(oldText);

        setPlanData({ text });
        applyPlanInjection();
        console.log(`[MWT:StoryPlanner] Plan generated (${text.length} chars)`);
        return text;
    } catch (err) {
        console.error('[MWT:StoryPlanner] Generation failed:', err);
        if (!isAuto) notify('Story Planner', `Generation failed: ${err.message}`, 'error');
        throw err;
    } finally {
        state.isGenerating = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    }
}