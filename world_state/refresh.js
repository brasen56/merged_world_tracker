/**
 * world_state/refresh.js — Full World State refresh (LLM generation),
 * auto-refresh scheduling, and auto-save timer.
 *
 * Depends on data.js, settings.js, injection.js.
 */

import {
    getContextSafe, getChat,
    resolveApiCall, normaliseOutput,
} from '../core/index.js';

import { DEFAULT_SYSTEM_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings, DEFAULT_AUTO_SAVE_INTERVAL } from './settings.js';
import {
    state, getWorldStateText, setWorldStateData, getWorldStateData,
    pushToHistory, pushAutoSave,
    isAutoRefreshEnabled, getAutoRefreshInterval,
    persistAutoRefreshCounter,
    getMaxScanMessages,
} from './data.js';
import { applyWorldStateInjection } from './injection.js';

// ─── Message scan helpers ────────────────────────────────────────────────────

function applyMessageFilter(text) {
    const filterRaw = getSettings().messageFilter?.trim();
    if (!filterRaw) return text;
    const patterns = filterRaw.split('\n').map(p => p.trim()).filter(Boolean);
    for (const p of patterns) {
        try {
            const regex = new RegExp(p, 'gi');
            text = text.replace(regex, '');
        } catch (err) {
            console.warn(`[MWT:WorldState] Invalid regex filter skipped: "${p}" — ${err.message}`);
        }
    }
    return text.trim();
}

export function getRecentMessagesForScan() {
    const max = getMaxScanMessages(getSettings());
    const chat = getChat();
    const slice = chat.slice(-max);
    const lines = [];
    let total = 0;
    const maxChars = 20000;
    for (let i = slice.length - 1; i >= 0; i--) {
        const msg = slice[i];
        const name = msg?.name || (msg?.is_user ? 'User' : 'Assistant');
        let text = String(msg?.mes || '').trim();
        text = applyMessageFilter(text);
        if (!text) continue;
        const line = `${name}: ${text}`;
        if (total + line.length > maxChars) break;
        lines.push(line);
        total += line.length + 1;
    }
    return lines.reverse().join('\n');
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildSystemPrompt() {
    const custom = getSettings().customPrompt?.trim();
    return custom || DEFAULT_SYSTEM_PROMPT;
}

function validateOutput(text) {
    if (!text) return { ok: false, reason: 'empty response' };

    if (!text.startsWith('## Current Scene')) {
        const preview = text.slice(0, 100).replace(/\n/g, ' ');
        return { ok: false, reason: `output does not start with "## Current Scene". First 100 chars: "${preview}"` };
    }

    const expectedSections = [
        '## Recent Changes',
        '## Key Character States',
        '## Active Threads',
        '## Pending',
        '## Off-Screen',
        '## World Pressures',
    ];
    const found = expectedSections.filter(s => text.includes(s)).length;
    if (found < 2) {
        return { ok: false, reason: `only ${found} expected section(s) found — model may have summarised instead of generating a world state` };
    }

    const rpMarkers = [
        { pattern: /^[A-Z][a-z]+:\s*["""\u201C\u201D]/m, label: 'dialogue formatting (Name: "...)' },
        { pattern: /\b(you see|you notice|before you|you feel)\b/i, label: 'second-person narration' },
        { pattern: /^(Meanwhile|Suddenly|As you|The (?:air|room|silence|darkness))\b/im, label: 'narrative prose opener' },
    ];
    for (const { pattern, label } of rpMarkers) {
        if (pattern.test(text)) return { ok: false, reason: `RP marker detected: ${label}` };
    }

    return { ok: true };
}

function buildUserMessage(reminderReason = '') {
    const prev = getWorldStateText().trim();
    const recent = getRecentMessagesForScan() || 'No recent messages.';
    const isFirstRun = !prev;
    const lines = [
        isFirstRun ? '### Previous World State\n(none — this is the first generation)' : `### Previous World State\n${prev}`,
        '',
        '### Recent Chat Messages',
        recent,
        '',
        '='.repeat(60),
        'Output the world state document now.',
        'Begin immediately with "## Current Scene" — no preamble.',
        'Use ONLY the exact section headers from the system prompt. Do not invent new sections.',
    ];
    if (isFirstRun) {
        lines.push('This is a NEW document — extract the current state of the world from the recent messages. Do NOT narrate, summarize the story, or continue the roleplay.');
    }
    if (reminderReason) {
        lines.push('');
        lines.push(`[REMINDER: Your previous attempt was rejected — ${reminderReason}. Output ONLY the structured document.]`);
    }
    return lines.join('\n');
}

// ─── Full refresh (generate via LLM) ─────────────────────────────────────────

export async function refreshWorldState(isAuto = false) {
    if (state.wstIsRefreshing) {
        if (isAuto) {
            scheduleAutoRefresh('world-state-refreshing');
            return null;
        }
        throw new Error('World State is already refreshing.');
    }
    if (!hasValidSettings()) {
        console.warn('[MWT:WorldState] Cannot refresh — settings incomplete');
        return null;
    }

    const ctxBefore = getContextSafe();
    const chatKeyBefore = `${ctxBefore?.characterId ?? ''}|${ctxBefore?.groupId ?? ''}|${ctxBefore?.chatId ?? ''}`;
    const chatLenBefore = getChat()?.length;
    state.wstIsRefreshing = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));

    try {
        const chat = getChat();
        if (!chat || chat.length === 0) return null;

        const systemPrompt = buildSystemPrompt();
        const _wsApi1 = resolveApiCall({ moduleSettings: getSettings() });
        let result = await _wsApi1.fetchFn({
            systemPrompt,
            userContent: buildUserMessage(),
            settings: _wsApi1.settings,
        });
        let text = normaliseOutput(result);
        let validation = validateOutput(text);

        if (!validation.ok) {
            console.warn(`[MWT:WorldState] First attempt rejected: ${validation.reason} — retrying once`);
            const _wsApi2 = resolveApiCall({ moduleSettings: getSettings() });
            result = await _wsApi2.fetchFn({
                systemPrompt,
                userContent: buildUserMessage(validation.reason),
                settings: _wsApi2.settings,
            });
            text = normaliseOutput(result);
            validation = validateOutput(text);
            if (!validation.ok) {
                throw new Error(`Model output rejected after retry: ${validation.reason}`);
            }
        }

        const ctxAfter = getContextSafe();
        const chatKeyAfter = `${ctxAfter?.characterId ?? ''}|${ctxAfter?.groupId ?? ''}|${ctxAfter?.chatId ?? ''}`;
        if (chatKeyAfter !== chatKeyBefore) {
            console.warn('[MWT:WorldState] Chat/character switched during generation — discarding result to avoid cross-chat contamination.');
            return null;
        }

        if (getChat()?.length !== chatLenBefore) {
            console.log('[MWT:WorldState] Chat grew during generation — saving result anyway.');
        }

        const oldText = getWorldStateText();
        if (oldText?.trim()) pushToHistory(oldText);

        setWorldStateData({ text });
        state.autoSaveLastText = text;
        state.isDirty = false;
        applyWorldStateInjection();

        console.log(`[MWT:WorldState] Refresh complete (${text.length} chars)`);
        return text;
    } catch (err) {
        console.error('[MWT:WorldState] Refresh failed:', err);
        throw err;
    } finally {
        state.wstIsRefreshing = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        if (state.autoRefreshQueued) {
            state.autoRefreshQueued = false;
            setTimeout(() => {
                scheduleAutoRefresh('follow-up-from-finally');
            }, 500);
        }
    }
}

// ─── Auto-refresh scheduling ─────────────────────────────────────────────────

/**
 * Schedule a delayed auto-refresh. Never refresh directly inside the
 * MESSAGE_RECEIVED call stack — give SillyTavern time to finish
 * saving/rendering/unlocking its own state.
 */
export function scheduleAutoRefresh(reason = 'scheduled') {
    if (state.autoRefreshDeferTimer) clearTimeout(state.autoRefreshDeferTimer);

    state.autoRefreshQueued = true;

    state.autoRefreshDeferTimer = setTimeout(async () => {
        state.autoRefreshDeferTimer = null;

        if (!state.autoRefreshQueued) return;
        if (state.wstIsRefreshing) {
            console.log('[MWT:WorldState] Auto-refresh deferred — still refreshing.');
            scheduleAutoRefresh('retry-after-busy');
            return;
        }

        state.autoRefreshQueued = false;

        try {
            const editorEl = state.modal?.querySelector('#ws-editor');
            if (editorEl && editorEl.value && editorEl.value !== getWorldStateText()) {
                setWorldStateData({ text: editorEl.value });
            }

            console.log(`[MWT:WorldState] Running delayed auto-refresh (${reason}).`);
            const text = await refreshWorldState(true);
            if (!text) return;

            if (state.modal) {
                const editor = state.modal.querySelector('#ws-editor');
                if (editor) {
                    editor.value = text;
                    state.autoSaveLastText = text;
                    state.isDirty = false;
                    // Lazy-load render helpers to avoid circular deps
                    const { updateEditorStats, refreshRevertButton } = await import('./render.js');
                    updateEditorStats();
                    refreshRevertButton();
                }
            }
        } catch (err) {
            console.warn('[MWT:WorldState] Auto-refresh failed:', err.message);
        }
    }, 2500);
}

export function onMessageReceived() {
    if (!isAutoRefreshEnabled()) return;

    // Track chat length so onMessageDeleted can compute the number of removed
    // messages during bulk deletes (e.g. "delete above/below").
    state.lastChatLength = getChat()?.length || 0;

    state.autoRefreshCounter++;
    const interval = getAutoRefreshInterval();

    console.log(`[MWT:WorldState] MESSAGE_RECEIVED — counter ${state.autoRefreshCounter}/${interval}`);

    if (state.autoRefreshCounter < interval) { persistAutoRefreshCounter(); return; }

    state.autoRefreshCounter = 0;
    persistAutoRefreshCounter();

    scheduleAutoRefresh('message-interval');
}

// ─── Auto-save timer ────────────────────────────────────────────────────────

export function restartAutoSaveTimer() {
    stopAutoSaveTimer();
    const interval = getSettings().autoSaveInterval || DEFAULT_AUTO_SAVE_INTERVAL;
    state.autoSaveTimer = setInterval(() => {
        const text = getWorldStateText();
        if (text?.trim()) pushAutoSave(text);
    }, interval * 1000);
}

export function stopAutoSaveTimer() {
    if (state.autoSaveTimer) { clearInterval(state.autoSaveTimer); state.autoSaveTimer = null; }
}