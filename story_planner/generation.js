/**
 * story_planner/generation.js — Story Plan generation via LLM.
 *
 * Depends on data.js, settings.js, prompts.js (leaf modules) and injection.js.
 */

import {
    getContextSafe, getChat,
    resolveApiCall, normaliseOutput, notify,
} from '../core/index.js';

import { STORY_PLAN_SYSTEM_PROMPT, STORY_PLAN_USER_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings } from './settings.js';
import { state, setPlanData } from './data.js';
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

function buildUserPrompt(recentText) {
    const custom = getSettings().customUserPrompt?.trim();
    const template = custom || STORY_PLAN_USER_PROMPT;
    return template.replace(/\{\{chatHistory\}\}/g, recentText || 'No recent messages.');
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateOutput(text) {
    if (!text || !text.trim()) return { ok: false, reason: 'empty response' };
    // Soft check — prefer to accept; the format is flexible.
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
        const resolved = resolveApiCall({ moduleSettings: getSettings() });
        const result = await resolved.fetchFn({
            systemPrompt,
            userContent: buildUserPrompt(recent),
            settings: resolved.settings,
        });
        let text = normaliseOutput(result);
        const validation = validateOutput(text);
        if (!validation.ok) {
            throw new Error(`Model output rejected: ${validation.reason}`);
        }

        const ctxAfter = getContextSafe();
        const chatKeyAfter = `${ctxAfter?.characterId ?? ''}|${ctxAfter?.groupId ?? ''}|${ctxAfter?.chatId ?? ''}`;
        if (chatKeyAfter !== chatKeyBefore) {
            console.warn('[MWT:StoryPlanner] Chat switched during generation — discarding result.');
            return null;
        }

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