/**
 * world_state/refresh.js — Full World State refresh (LLM generation),
 * auto-refresh scheduling, and auto-save timer.
 *
 * Depends on data.js, settings.js, injection.js.
 */

import {
    getChat,
    getStableHistoryEnd,
    resolveApiCall, normaliseOutput, stripNonNarrative,
    captureScope, assertSameScope,
    captureRevision, sameRevision,
    getOrCreateReceiptIdentity,
    truncateText,
    setStatus,
} from '../core/index.js';

import { DEFAULT_SYSTEM_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings, DEFAULT_AUTO_SAVE_INTERVAL, getPinnedEntities } from './settings.js';
import {
    state, getWorldStateText, setWorldStateDataChecked,
    commitHistorySnapshot, pushAutoSave,
    isAutoRefreshEnabled, getAutoRefreshInterval,
    persistAutoRefreshCounter,
    getMaxScanMessages, setProvenance, getProvenance,
} from './data.js';
import { applyWorldStateInjection } from './injection.js';
import { buildProvenance, groundingGate, applyExpiry } from './provenance.js';

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
    const end = getStableHistoryEnd(chat);
    const slice = chat.slice(Math.max(0, end - max), end);
    const lines = [];
    let total = 0;
    const maxChars = 20000;
    for (let i = slice.length - 1; i >= 0; i--) {
        const msg = slice[i];
        const name = msg?.name || (msg?.is_user ? 'User' : 'Assistant');
        let text = String(msg?.mes || '').trim();
        // Strip non-narrative blocks (preset trackers, old chatter, time tags)
        text = stripNonNarrative(text);
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

    // "Name: "quoted..."" at line start signals leaked dialogue. Exclude the
    // template's own single-word field labels (Mood, Situation, Date, \u2026), which
    // legitimately carry quoted values like `Mood: "determined but frayed"` and
    // would otherwise trigger a false rejection.
    const FIELD_LABELS = 'Date|Time|Location|Present|Situation|Mood|Goal|Status|Notable|Current|Immediate|Key|Worn';
    const rpMarkers = [
        { pattern: new RegExp(`^(?!(?:${FIELD_LABELS})\\b)[A-Z][a-z]+:\\s*["\u201C\u201D]`, 'm'), label: 'dialogue formatting (Name: "...)' },
        { pattern: /\b(you see|you notice|you feel)\b/i, label: 'second-person narration' },
        { pattern: /^(Meanwhile|Suddenly|As you|The (?:air|room|silence|darkness))\b/im, label: 'narrative prose opener' },
    ];
    for (const { pattern, label } of rpMarkers) {
        if (pattern.test(text)) return { ok: false, reason: `RP marker detected: ${label}` };
    }

    return { ok: true };
}

// WORLD-STATE-03: Maximum character budget for the prior world state fed into
// the refresh prompt. The recent-messages scan is already capped at 20k chars,
// but the entire saved document went in as <previous> with no cap — a large
// imported state made every refresh oversized.
const PREV_STATE_BUDGET = 30000;

function buildUserMessage(reminderReason = '') {
    const prev = truncateText(getWorldStateText().trim(), PREV_STATE_BUDGET);
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

    // WORLD-STATE-01: Capture the scope before any async operation. The old
    // weak key `${characterId}|${groupId}|${chatId}` collapsed two different
    // chats on the same character when chatId was absent. The scope guard uses
    // getCurrentChatId() + epoch for a reliable check.
    const scopeBefore = captureScope();
    // WORLD-STATE-02: Capture the document revision at start so we can detect
    // same-chat edits made during the API call.
    const wsRevision = captureRevision(getWorldStateText());
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

        // WORLD-STATE-01: Assert scope immediately before any writes. A chat
        // switch during the API call must discard the result to prevent
        // cross-chat contamination.
        const scopeResult = assertSameScope(scopeBefore);
        if (!scopeResult.ok) {
            console.warn(
                `[MWT:WorldState] Chat switched during generation (${scopeResult.reason}) — ` +
                `discarding result to avoid cross-chat contamination.`
            );
            return null;
        }

        if (getChat()?.length !== chatLenBefore) {
            console.log('[MWT:WorldState] Chat grew during generation — saving result anyway.');
        }

        const oldText = getWorldStateText();

        // ── Grounding gate (§5.3) — strip/reject bolded names the model invented
        // that don't appear in the scan window, the prior state, or pinnedEntities.
        const gateSettings = getSettings();
        if (gateSettings.groundingEnabled) {
            const scanText = getRecentMessagesForScan();
            const pinned = getPinnedEntities(gateSettings);
            let grounding = groundingGate(text, { scanText, priorText: oldText, pinned, mode: gateSettings.groundingMode });
            if (!grounding.ok) {
                console.warn(`[MWT:WorldState] Grounding gate rejected: ${grounding.reason} — retrying once`);
                const _wsApi3 = resolveApiCall({ moduleSettings: getSettings() });
                result = await _wsApi3.fetchFn({
                    systemPrompt,
                    userContent: buildUserMessage(grounding.reason),
                    settings: _wsApi3.settings,
                });
                text = normaliseOutput(result);
                validation = validateOutput(text);
                if (!validation.ok) throw new Error(`Model output rejected after grounding retry: ${validation.reason}`);
                // WORLD-STATE-01: Re-assert scope after the grounding retry await.
                // A chat switch during the retry must discard the result before
                // any write — the initial check does not cover this gap.
                const scopeAfterRetry = assertSameScope(scopeBefore);
                if (!scopeAfterRetry.ok) {
                    console.warn(
                        `[MWT:WorldState] Chat switched during grounding retry (${scopeAfterRetry.reason}) — ` +
                        `discarding result to avoid cross-chat contamination.`
                    );
                    return null;
                }
                grounding = groundingGate(text, { scanText, priorText: oldText, pinned, mode: gateSettings.groundingMode });
                if (!grounding.ok) {
                    // WORLD-STATE-04: Strict mode fails closed — the model had
                    // two honest chances and still produced ungrounded names.
                    // Discard rather than silently downgrading to soft.
                    if (gateSettings.groundingMode === 'strict') {
                        console.warn(`[MWT:WorldState] Grounding gate still rejected after retry (${grounding.reason}) — strict mode, discarding.`);
                        setStatus(state.modal, `Grounding gate rejected: ${grounding.reason}. Refresh discarded (strict mode).`, 'warning', 6000);
                        return null;
                    }
                    // Soft mode strips the offending names and commits.
                    console.warn(`[MWT:WorldState] Grounding gate still rejected after retry (${grounding.reason}) — soft mode, stripping.`);
                    grounding = groundingGate(text, { scanText, priorText: oldText, pinned, mode: 'soft' });
                }
            }
            text = grounding.cleanedText;
        }

        // ── Expiry (§5.2) — drop/quarantine/mark entries stale beyond the
        // configured message-age threshold. Whole-document concern; only runs
        // on a full refresh, not per-section regen (§7).
        if (gateSettings.expiryEnabled) {
            const expiry = applyExpiry(text, getProvenance(), {
                staleAfterMsgs: gateSettings.expiryStaleAfterMsgs,
                sections: gateSettings.expirySections,
                mode: gateSettings.expiryMode,
                pinned: getPinnedEntities(gateSettings),
                currentMsgIndex: getChat()?.length || 0,
            });
            text = expiry.text;
        }

        // WORLD-STATE-02: Verify the document wasn't edited during the API
        // call. If the user changed the world state text while generation was
        // in flight, discard the result rather than clobbering their edit.
        const currentWs = getWorldStateText();
        if (!sameRevision(wsRevision, currentWs)) {
            console.warn('[MWT:WorldState] Document was edited during generation — discarding result to preserve user changes.');
            setStatus(state.modal, 'World State was edited during generation — refresh discarded.', 'warning', 6000);
            return null;
        }

        // Checked write (design §8): one patch carries BOTH the outgoing
        // text's history snapshot and the generated text. A refusal keeps the
        // previous world state — history included — intact, aborts before any
        // injection/provenance work, and the null return tells every caller
        // the refresh produced nothing.
        const written = commitHistorySnapshot(oldText, { text });
        if (!written.ok) {
            console.error(`[MWT:WorldState] Refresh refused at the store write (${written.reason ?? 'unknown reason'}) — the previous world state was kept.`);
            setStatus(state.modal, `Refresh failed: the world state store refused the write (${written.reason ?? 'unknown reason'}); the previous world state was kept.`, 'error', 6000);
            return null;
        }
        state.autoSaveLastText = text;
        state.isDirty = false;
        state.editSessionActive = false;
        applyWorldStateInjection();
        try { setProvenance(buildProvenance()); } catch (err) {
            console.warn('[MWT:WorldState] Provenance build failed (non-fatal):', err.message);
        }

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
            // WORLD-STATE-08/09: store this follow-up in autoRefreshDeferTimer
            // (previously a raw, untracked setTimeout) so a chat switch or a
            // subsequent scheduleAutoRefresh can cancel it instead of leaving a
            // dangling timer that re-arms a refresh after the user left.
            state.autoRefreshDeferTimer = setTimeout(() => {
                state.autoRefreshDeferTimer = null;
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

    // WORLD-STATE-08/09: Capture the scope (epoch + chat identity) at schedule
    // time. The deferred callback asserts it is unchanged BEFORE any write, so
    // a chat switch (or any bumpEpoch) between scheduling and the 2.5s callback
    // cannot fire a stale refresh — and critically cannot persist a stale
    // editor value into the now-current chat. onChatChanged() clears this timer
    // and bumps the epoch; this assert is the guard for any path that does not.
    const scopeAtSchedule = captureScope();

    state.autoRefreshDeferTimer = setTimeout(async () => {
        state.autoRefreshDeferTimer = null;

        // WORLD-STATE-08: Re-check that auto-refresh is still enabled at
        // callback time. The timer may have been queued before the user
        // disabled auto-refresh (or switched chats), in which case the
        // queued follow-up must NOT fire. The old code only checked the
        // `autoRefreshQueued` flag, which onChatChanged() does clear — but
        // a settings change between scheduling and callback left it set.
        if (!isAutoRefreshEnabled()) {
            state.autoRefreshQueued = false;
            return;
        }
        // WORLD-STATE-08/09: scope/epoch guard — discard if the chat changed
        // (or any other bumpEpoch) since this refresh was scheduled.
        if (!assertSameScope(scopeAtSchedule).ok) {
            state.autoRefreshQueued = false;
            return;
        }
        if (!state.autoRefreshQueued) return;
        if (state.wstIsRefreshing) {
            console.log('[MWT:WorldState] Auto-refresh deferred — still refreshing.');
            scheduleAutoRefresh('retry-after-busy');
            return;
        }

        state.autoRefreshQueued = false;

        try {
            // Capture an in-progress edit before the refresh overwrites the
            // editor — but ONLY during a live edit session in THIS chat.
            //
            // Without the editSessionActive guard this reads whatever is sitting
            // in the textarea, which after a chat change is still the PREVIOUS
            // chat's text: hideModal() only sets display:none, so the element and
            // its stale value survive both closing the modal and switching chats.
            // The result was chat A's world state being written into chat B.
            // onChatChanged() clears this flag for exactly this reason, and it is
            // only set when the user actually types (render.js), so the case this
            // capture exists for is unaffected.
            const editorEl = state.editSessionActive ? state.modal?.querySelector('#ws-editor') : null;
            if (editorEl && editorEl.value && editorEl.value !== getWorldStateText()) {
                // Checked write (design §8): a refused pre-sync must not begin
                // the dependent auto-refresh over an editor value that never
                // landed — skip this cycle and retry on the next one.
                const written = setWorldStateDataChecked({ text: editorEl.value });
                if (!written.ok) {
                    console.warn(`[MWT:WorldState] Auto-refresh skipped: the store refused the editor pre-sync (${written.reason ?? 'unknown reason'}); the previous world state was kept.`);
                    return;
                }
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
                    state.editSessionActive = false;
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

export function onMessageReceived({ countMessage = true } = {}) {
    // Track chat length so onMessageDeleted can compute the number of removed
    // messages during bulk deletes (e.g. "delete above/below"). This must run
    // every turn — it is NOT gated by the panic switch (countMessage) or by the
    // auto-refresh setting — so onMessageDeleted always computes `removed` from
    // a live length instead of a frozen one. (Hoisted above the early returns
    // for PANIC-COUNTER-SYMMETRY.)
    const chat = getChat() || [];
    state.lastChatLength = chat.length;

    // Counting toward the auto-refresh threshold, and the refresh itself, are
    // gated: by the per-module auto setting and by the panic flag (countMessage).
    if (!isAutoRefreshEnabled() || !countMessage) return;

    state.autoRefreshCounter++;
    const receipt = [...chat].reverse().find(msg => msg && !msg.is_user && !msg.is_system);
    if (receipt) {
        const key = getOrCreateReceiptIdentity(receipt);
        state.countedReceiptEvents.set(key, (state.countedReceiptEvents.get(key) || 0) + 1);
    }
    const interval = getAutoRefreshInterval();

    console.log(`[MWT:WorldState] MESSAGE_RECEIVED — counter ${state.autoRefreshCounter}/${interval}`);

    if (state.autoRefreshCounter < interval) { persistAutoRefreshCounter(); return; }

    state.autoRefreshCounter = 0;
    state.countedReceiptEvents.clear();
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