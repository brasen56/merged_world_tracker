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
// Part 6 (§7.4) pause guard + the store id it checks. Direct import (not the
// barrel) so the REAL pause singleton is read even under the test
// barrel→stub alias — the same rule the injection seam follows.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { worldStateSchema } from './schema.js';

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
import {
    DeltaPatchError, planAutoRefresh, getDeltaStatus, buildRefreshStatusDelta,
    buildPartialRefreshStatus, digestText, isDeltaModeEnabled,
    buildDeltaSystemPrompt, buildDeltaUserMessage, parseDeltaPatch, applyDeltaPatch,
} from './delta.js';

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

/** Shared per-message formatting for scan windows: display name + narrative
 *  text after stripNonNarrative and the user's regex filter. Null when the
 *  message contributes nothing to a scan (empty after filtering). */
function scanMessageLine(msg) {
    const name = msg?.name || (msg?.is_user ? 'User' : 'Assistant');
    let text = String(msg?.mes || '').trim();
    // Strip non-narrative blocks (preset trackers, old chatter, time tags)
    text = stripNonNarrative(text);
    text = applyMessageFilter(text);
    if (!text) return null;
    return `${name}: ${text}`;
}

const SCAN_MAX_CHARS = 20000;

// Explicit partial-coverage marker for a message whose scan line alone
// exceeds the budget (the catch-up oversized-message rule). The model (and
// the log) must be able to see the message was only partially scanned, so the
// watermark stamped past it stays honest. Appended by nextCatchUpChunk().
const OVERSIZED_SCAN_NOTE = ` […partial message — alone exceeds the ${SCAN_MAX_CHARS}-character scan budget; leading portion only]`;

export function getRecentMessagesForScan() {
    const max = getMaxScanMessages(getSettings());
    const chat = getChat();
    const end = getStableHistoryEnd(chat);
    const slice = chat.slice(Math.max(0, end - max), end);
    const lines = [];
    let total = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
        const line = scanMessageLine(slice[i]);
        if (!line) continue;
        if (total + line.length > SCAN_MAX_CHARS) break;
        lines.push(line);
        total += line.length + 1;
    }
    return lines.reverse().join('\n');
}

/**
 * Scan window for a DELTA refresh (TODO §3-F): every settled message since the
 * last refresh watermark — NOT just the latest maxScanMessages.
 *
 * getRecentMessagesForScan() slides a fixed-size window over the newest end of
 * history. That is correct for a full refresh (the whole document is rebuilt
 * anyway) but wrong for a delta: after a longer gap, the newest-N window would
 * silently skip the OLDEST unseen messages, the delta would then stamp the
 * document as freshly updated, and the gap would be hidden forever. The whole
 * unseen interval must therefore fit inside one scan budget; when it cannot,
 * this returns ok:false and the caller falls back to a full refresh — which
 * refreshWorldState upgrades to a chunked CATCH-UP
 * (runCatchUpWorldStateRefresh) so the whole interval is actually replayed,
 * never stamped over.
 *
 * @param {number} sinceMsg — watermark: the stable-history end index recorded
 *   by the last refresh (deltaStatus.lastRefreshAtMsg)
 * @returns {{ ok: true, text: string, from: number, to: number }
 *          | { ok: false, reason: string }}
 */
export function getMessagesSinceForScan(sinceMsg) {
    const max = getMaxScanMessages(getSettings());
    const chat = getChat() || [];
    const end = getStableHistoryEnd(chat);
    // A watermark above the current stable end (the chat shrank, or a legacy
    // chat-length watermark from before this fix) clamps to "nothing new" —
    // never a negative window.
    const since = Number.isFinite(sinceMsg)
        ? Math.max(0, Math.min(Math.floor(sinceMsg), end))
        : end;
    if (end - since > max) {
        return { ok: false, reason: `the unseen interval is ${end - since} messages but the scan budget is ${max}` };
    }
    const lines = [];
    let total = 0;
    for (const msg of chat.slice(since, end)) {
        const line = scanMessageLine(msg);
        if (!line) continue;
        if (total + line.length > SCAN_MAX_CHARS) {
            // Same failure mode as the message-count overflow one layer up:
            // the character budget would drop the OLDEST unseen messages.
            return { ok: false, reason: `the unseen interval exceeds the ${SCAN_MAX_CHARS}-character scan budget` };
        }
        lines.push(line);
        total += line.length + 1;
    }
    return { ok: true, text: lines.join('\n'), from: since, to: end };
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

/**
 * @param {string} scanText — the scan window this generation is built from.
 *  Frozen by the caller before the first await so every attempt (initial,
 *  validation retry, grounding retry) and the grounding gate all see the
 *  EXACT evidence the model was given — never a re-read window that messages
 *  arriving mid-await may have shifted (the frozen-evidence rule).
 */
function buildUserMessage(scanText, reminderReason = '') {
    const prev = truncateText(getWorldStateText().trim(), PREV_STATE_BUDGET);
    const recent = scanText || 'No recent messages.';
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

// ─── Catch-up refresh (oversized-gap replay) ──────────────────────────────────

/** True while the chunked catch-up loop is running. Outside callers entering
 *  refreshWorldState see it as busy (their run is deferred or refused); the
 *  loop's own passes carry an explicit scanWindow and bypass this guard. */
let catchUpLoopActive = false;

/** Upper bound on LLM generation passes per catch-up run. Every pass is a
 *  full sequential generation, so however far the chat has run ahead, one
 *  click must never fan out into dozens of them. Stopping at the cap is
 *  honest — each pass stamps the watermark where its chunk ended — so the
 *  next refresh simply resumes the replay from there. */
const MAX_CATCH_UP_PASSES = 8;

/**
 * The next budget-sized chunk of the unseen interval [from, endLimit]:
 * forward-walk the settled messages, including every scan line while the
 * SCAN_MAX_CHARS budget allows and stopping before overflowing it. The chunk
 * covers [chunk.from, chunk.to) — `to` is the index after the last message
 * examined, so later passes never re-read them.
 *
 * A single message whose line alone exceeds the character budget can never be
 * scanned WHOLE by any window (the sliding full-refresh scan has the same
 * known limitation — see BUG_REPORTS/07 #1). Skipping it while advancing the
 * watermark past it would stamp the document reconciled over content no scan
 * ever saw (the oversized-message rule), so its leading portion is
 * included with the explicit OVERSIZED_SCAN_NOTE marker instead: the model
 * reconciles what fits and can see the coverage is partial, the log records
 * it, and the catch-up still makes progress instead of wedging every future
 * refresh on the message.
 *
 * @param {number} from — watermark where the previous pass ended
 * @param {number} [endLimit] — the catch-up loop's FROZEN target end; the
 *   walk never passes it, nor the live stable-history end (a chat that shrank
 *   mid-replay shortens the walk instead of scanning stale indices)
 */
function nextCatchUpChunk(from, endLimit) {
    const chat = getChat() || [];
    const end = Math.min(
        Number.isFinite(endLimit) ? Math.max(0, Math.floor(endLimit)) : Infinity,
        getStableHistoryEnd(chat),
    );
    const start = Number.isFinite(from) ? Math.max(0, Math.min(Math.floor(from), end)) : end;
    const lines = [];
    let total = 0;
    let to = start;
    for (let i = start; i < end; i++) {
        const line = scanMessageLine(chat[i]);
        if (!line) { to = i + 1; continue; } // examined; contributes nothing
        if (total + line.length > SCAN_MAX_CHARS) {
            if (lines.length === 0) {
                console.warn(`[MWT:WorldState] Catch-up truncated message ${i} — at ${line.length} characters it alone exceeds the ${SCAN_MAX_CHARS}-character scan budget, so only its leading portion (with an explicit marker) can be scanned.`);
                lines.push(line.slice(0, SCAN_MAX_CHARS - OVERSIZED_SCAN_NOTE.length) + OVERSIZED_SCAN_NOTE);
                total += SCAN_MAX_CHARS + 1;
                to = i + 1;
                continue;
            }
            break;
        }
        lines.push(line);
        total += line.length + 1;
        to = i + 1;
    }
    return { text: lines.join('\n'), from: start, to };
}

/**
 * Reconcile an unseen interval that no single scan window can cover, by
 * replaying it through the model in budget-sized FULL-refresh passes
 * (the oversized-gap fix): previously the oversized-gap fallback ran a plain full
 * refresh, which only reads the latest maxScanMessages and then stamps the
 * document reconciled through the current scan end — permanently hiding the
 * oldest unseen messages.
 *
 * Each pass sees the previous pass's document as its prev-state, so state
 * folds forward oldest→newest, and each pass's checked write stamps the
 * watermark where ITS chunk ended. Partial progress is therefore honest: a
 * mid-way failure (guard decline, refused write, chat switch between passes)
 * leaves the remaining interval scannable by the next refresh instead of
 * stamping over it. A chunk that holds nothing scannable at all spends no
 * generation — its watermark is carried forward by a no-op status write.
 *
 * The target end is FROZEN once, when the catch-up begins (the
 * moving-target rule): recomputing the stable-history end after every pass
 * let messages settling mid-replay extend the target and queue ever more
 * full-generation passes with no fixed upper bound. Messages that settle
 * after the freeze are simply not part of this replay — they stay beyond the
 * final watermark and are covered by the next (cheap) delta cycle. The live
 * end can only ever LOWER the target, when the chat shrank mid-replay.
 *
 * Returns the last committed document text, or null when nothing was committed.
 */
async function runCatchUpWorldStateRefresh(isAuto, since) {
    const scopeAtCatchUp = captureScope();
    let from = Number.isFinite(since) ? Math.max(0, Math.floor(since)) : 0;
    const targetEnd = getStableHistoryEnd();
    let lastCommitted = null;
    let generationPasses = 0;
    catchUpLoopActive = true;
    try {
        while (true) {
            const end = Math.min(targetEnd, getStableHistoryEnd());
            if (from >= end) break;
            // WORLD-STATE-01: a chat switch BETWEEN passes must stop the
            // replay — the remaining chunk indices belong to the old chat.
            const scopeNow = assertSameScope(scopeAtCatchUp);
            if (!scopeNow.ok) {
                console.warn(`[MWT:WorldState] Catch-up aborted — chat switched between passes (${scopeNow.reason}).`);
                break;
            }
            const chunk = nextCatchUpChunk(from, end);
            if (chunk.to <= from) {
                // Cannot make progress (pathological budget geometry) — refuse
                // WITHOUT advancing: the next refresh retries from here.
                console.warn('[MWT:WorldState] Catch-up stopped — the next chunk cannot fit the scan budget; the watermark is not advanced past this point.');
                break;
            }
            if (!chunk.text) {
                // Nothing scannable in this chunk (all filtered out): spend no
                // generation on it, just carry the watermark forward so the
                // interval counts as seen. buildPartialRefreshStatus semantics
                // apply: a digest-matched document keeps its reconciled
                // digest, a manually edited one keeps reporting as such.
                const current = getWorldStateText();
                if (current?.trim()) {
                    const written = setWorldStateDataChecked({ deltaStatus: buildPartialRefreshStatus(getDeltaStatus(), current, current, chunk.to) });
                    if (!written.ok) console.warn(`[MWT:WorldState] Catch-up watermark carry-forward refused (${written.reason ?? 'unknown reason'}).`);
                }
                from = chunk.to;
                continue;
            }
            if (generationPasses >= MAX_CATCH_UP_PASSES) {
                console.warn(`[MWT:WorldState] Catch-up paused after ${generationPasses} generation passes — the remaining interval stays scannable; run Refresh again to continue.`);
                setStatus(state.modal, `Catch-up paused after ${generationPasses} passes — run 🔄 Refresh again to continue replaying the older history.`, 'info', 8000);
                break;
            }
            console.log(`[MWT:WorldState] Catch-up pass: replaying messages [${chunk.from}, ${chunk.to}) of [0, ${end}).`);
            generationPasses += 1;
            const text = await refreshWorldState(isAuto, { scanWindow: chunk });
            if (text === null) {
                console.warn('[MWT:WorldState] Catch-up stopped — a pass declined; passes already committed keep their honest watermarks.');
                break;
            }
            lastCommitted = text;
            from = chunk.to;
        }
        return lastCommitted;
    } finally {
        catchUpLoopActive = false;
    }
}

// ─── Full refresh (generate via LLM) ─────────────────────────────────────────

export async function refreshWorldState(isAuto = false, { scanWindow = null } = {}) {
    // An explicit scanWindow marks an internal catch-up pass
    // (runCatchUpWorldStateRefresh): the caller owns coverage, so this run
    // scans exactly [scanWindow.from, scanWindow.to), stamps the watermark at
    // scanWindow.to, and skips the gap auto-detection below.
    const isCatchUpPass = !!(scanWindow && Number.isFinite(scanWindow.from) && Number.isFinite(scanWindow.to));
    if (state.wstIsRefreshing || (catchUpLoopActive && !isCatchUpPass)) {
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

    // Part 6 (§7.4): the manual refresh button, /wt-refresh, and the scheduled
    // auto-refresh all re-enter this API-spending choke point without the
    // event router's decline predicate. Refuse while the store is paused —
    // BEFORE reading the unprepared store or spending the API call (the
    // checked write would refuse afterwards anyway; declining here keeps
    // that refusal free). Auto runs decline silently (the router declines
    // those anyway); manual runs say why, mirroring the other modules.
    if (isStorePausedForCurrentScope(worldStateSchema.id)) {
        console.log('[MWT:WorldState] Refresh skipped — the store is paused for this chat (schema preparation).');
        if (isAuto) return null;
        throw new Error('World State is paused for this chat — its data could not be safely prepared, so nothing was generated. Use Retry in the banner after repairing the data.');
    }

    // ── Catch-up upgrade (delta mode only): a plain full refresh cannot cover
    // an oversized gap. The sliding scan window reaches only maxScanMessages
    // back; when the last refresh watermark sits before that point, the oldest
    // unseen settled messages cannot be part of any single scan. Regenerating
    // from the latest window and stamping reconciled-through-now would hide
    // them forever, so upgrade to the chunked catch-up, which replays the
    // whole interval in budget-sized passes.
    // The upgrade is GATED on delta mode: it turns one click into N sequential
    // generations, and only delta users opted into that incremental cost
    // model. With the shipped default (deltaMode off) the 🔄 button keeps its
    // plain one-click/one-generation behavior — maxScanMessages is the window
    // the user chose. (Only with a refresh baseline on record — a first
    // generation has no watermark semantics; everything older than the window
    // folds into the fresh document by design. Manual edits don't matter here:
    // the watermark records what the last SCAN covered, and each catch-up pass
    // reconciles the current document with its chunk regardless.)
    if (!isCatchUpPass && isDeltaModeEnabled()) {
        const st = getDeltaStatus();
        if (st.lastRefreshDigest) {
            const end = getStableHistoryEnd();
            const since = Math.max(0, Math.min(st.lastRefreshAtMsg, end));
            const windowFrom = Math.max(0, end - getMaxScanMessages(getSettings()));
            if (since < windowFrom) {
                console.warn(`[MWT:WorldState] Full refresh upgraded to catch-up — ${windowFrom - since} settled message(s) before the scan window were never seen by any refresh.`);
                return runCatchUpWorldStateRefresh(isAuto, since);
            }
        }
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
        // The scan window for THIS run, frozen before the first await:
        //   - a catch-up pass scans exactly the chunk its loop sized, and
        //     stamps the watermark where that chunk ends;
        //   - otherwise the usual sliding latest-N window, stamped at the
        //     stable-history end.
        // Delta-mode watermark (TODO §3-F): the status must record where the
        // scan actually ENDS — never chat length (the configurable in-flight
        // tail is not scanned). A later re-scan (validation retry / grounding)
        // can only have seen MORE, so stamping this point never over-claims
        // coverage.
        // The TEXT is frozen for the same reason (frozen-evidence rule): validation
        // and the grounding gate must check the exact evidence the model was
        // given, not a re-read window that messages arriving mid-await may
        // have shifted.
        let scanWindowText;
        let scanEnd;
        if (isCatchUpPass) {
            scanWindowText = typeof scanWindow.text === 'string' ? scanWindow.text : '';
            scanEnd = Math.max(0, Math.floor(scanWindow.to));
        } else {
            scanWindowText = getRecentMessagesForScan();
            scanEnd = getStableHistoryEnd();
        }
        const _wsApi1 = resolveApiCall({ moduleSettings: getSettings() });
        let result = await _wsApi1.fetchFn({
            systemPrompt,
            userContent: buildUserMessage(scanWindowText),
            settings: _wsApi1.settings,
        });
        let text = normaliseOutput(result);
        let validation = validateOutput(text);

        if (!validation.ok) {
            console.warn(`[MWT:WorldState] First attempt rejected: ${validation.reason} — retrying once`);
            const _wsApi2 = resolveApiCall({ moduleSettings: getSettings() });
            result = await _wsApi2.fetchFn({
                systemPrompt,
                userContent: buildUserMessage(scanWindowText, validation.reason),
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
        // scanWindowText — the exact text fed to the model — is the evidence
        // base (frozen-evidence rule): a re-read window after the API await could
        // have lost the oldest part of the generation window to newly arrived
        // messages, stripping names the model legitimately used.
        const gateSettings = getSettings();
        if (gateSettings.groundingEnabled) {
            const pinned = getPinnedEntities(gateSettings);
            let grounding = groundingGate(text, { scanText: scanWindowText, priorText: oldText, pinned, mode: gateSettings.groundingMode });
            if (!grounding.ok) {
                console.warn(`[MWT:WorldState] Grounding gate rejected: ${grounding.reason} — retrying once`);
                const _wsApi3 = resolveApiCall({ moduleSettings: getSettings() });
                result = await _wsApi3.fetchFn({
                    systemPrompt,
                    userContent: buildUserMessage(scanWindowText, grounding.reason),
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
                grounding = groundingGate(text, { scanText: scanWindowText, priorText: oldText, pinned, mode: gateSettings.groundingMode });
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
                    grounding = groundingGate(text, { scanText: scanWindowText, priorText: oldText, pinned, mode: 'soft' });
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
        // Delta-mode bookkeeping (TODO §3-F) rides the SAME patch: a separate
        // status write could be refused and leave a digest that misreports
        // the document as manually edited.
        const written = commitHistorySnapshot(oldText, {
            text,
            deltaStatus: buildRefreshStatusDelta('full', text, getDeltaStatus(), scanEnd),
        });
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

// ─── Delta refresh (TODO §3-F — low-cost incremental mode) ───────────────────

/**
 * Low-cost incremental refresh: ask the model ONLY for the sections that
 * changed since the last refresh and apply the validated patch (see
 * world_state/delta.js for the patch protocol, planning, and status
 * bookkeeping). Mirrors refreshWorldState's guard stack — busy flag, settings,
 * paused-store decline, scope capture/assert after every await, same-chat
 * revision guard, ONE checked write carrying text + history + status.
 *
 * Returns the (possibly patched) document text, or null when a guard declined
 * — same contract as refreshWorldState. Throws DeltaPatchError when the model
 * failed the patch protocol twice; runScheduledWorldStateRefresh escalates
 * that to a full refresh rather than leaving the document unfreshened.
 *
 * Manual ⚡ Delta clicks land here too (isAuto = false). They bypass
 * planAutoRefresh's cadence on purpose — the user explicitly asked for a
 * partial update — but the same baseline preconditions still apply.
 */
export async function refreshWorldStateDelta(isAuto = false) {
    // catchUpLoopActive mirrors refreshWorldState's guard. Today the catch-up
    // loop never yields to a macrotask before the flag is set, so a delta
    // cannot interleave with it — but one added `await` in that loop would
    // open the gap, and the flag is module-local to the whole loop either way.
    if (state.wstIsRefreshing || catchUpLoopActive) {
        if (isAuto) {
            scheduleAutoRefresh('world-state-refreshing');
            return null;
        }
        throw new Error('World State is already refreshing.');
    }
    if (!hasValidSettings()) {
        console.warn('[MWT:WorldState] Cannot delta-refresh — settings incomplete');
        return null;
    }
    // Part 6 (§7.4): API-spending choke point — decline while the store is
    // paused, before reading the unprepared store or spending the call.
    if (isStorePausedForCurrentScope(worldStateSchema.id)) {
        console.log('[MWT:WorldState] Delta refresh skipped — the store is paused for this chat (schema preparation).');
        if (isAuto) return null;
        throw new Error('World State is paused for this chat — its data could not be safely prepared, so nothing was generated. Use Retry in the banner after repairing the data.');
    }

    // Delta preconditions: a document to patch and a refresh baseline to build
    // on. Without them a delta is meaningless — the full refresh owns the
    // first generation and imported/legacy documents.
    const baselineText = getWorldStateText();
    if (!baselineText?.trim()) {
        if (isAuto) return refreshWorldState(isAuto);
        throw new DeltaPatchError('No world state yet — run a full Refresh first to create a baseline.');
    }
    const baselineStatus = getDeltaStatus();
    if (!baselineStatus.lastRefreshDigest) {
        if (isAuto) return refreshWorldState(isAuto);
        throw new DeltaPatchError('This document has no refresh baseline yet (imported or pre-delta). Run a full Refresh first.');
    }
    // Manual edits since the last refresh: the document no longer matches the
    // digest committed by that refresh. A delta would patch on top of
    // unverified content and stamp a fresh digest covering the WHOLE document,
    // silently clearing the manual-edit signal without the user's edits ever
    // being reconciled. The full refresh owns that reconciliation — same policy
    // as planAutoRefresh's 'manual-edits-since-refresh'. (The ⚡ Delta button
    // pre-persists live editor changes, so this check must compare digests,
    // not just test for the baseline's existence.)
    if (digestText(baselineText) !== baselineStatus.lastRefreshDigest) {
        console.warn('[MWT:WorldState] Delta declined — the document has manual edits since its last refresh; a full refresh must reconcile them.');
        if (isAuto) return refreshWorldState(isAuto);
        throw new DeltaPatchError('This document has manual edits since its last refresh — run a full Refresh first to reconcile them.');
    }
    // The delta scan must cover EVERY unseen message since the refresh
    // watermark, not just the latest maxScanMessages. When the whole interval
    // cannot fit inside one scan budget, fall back to the full refresh rather
    // than silently skipping the oldest unseen events and stamping over the
    // gap.
    const scanWindow = getMessagesSinceForScan(baselineStatus.lastRefreshAtMsg);
    if (!scanWindow.ok) {
        console.warn(`[MWT:WorldState] Delta declined — ${scanWindow.reason}; a full refresh is required to cover the whole interval.`);
        if (isAuto) return refreshWorldState(isAuto);
        throw new DeltaPatchError(`Too much unseen chat since the last refresh (${scanWindow.reason}) — run a full Refresh to catch up.`);
    }

    // WORLD-STATE-01/02: same scope + revision discipline as the full refresh.
    const scopeBefore = captureScope();
    const wsRevision = captureRevision(baselineText);
    state.wstIsRefreshing = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));

    try {
        const systemPrompt = buildDeltaSystemPrompt(buildSystemPrompt());
        const prevText = baselineText.trim();

        const _wsApiD1 = resolveApiCall({ moduleSettings: getSettings() });
        let result = await _wsApiD1.fetchFn({
            systemPrompt,
            userContent: buildDeltaUserMessage({ prevText, recentText: scanWindow.text }),
            settings: _wsApiD1.settings,
        });
        let parsed = parseDeltaPatch(normaliseOutput(result));

        if (!parsed.ok) {
            console.warn(`[MWT:WorldState] Delta patch rejected: ${parsed.reason} — retrying once`);
            const _wsApiD2 = resolveApiCall({ moduleSettings: getSettings() });
            result = await _wsApiD2.fetchFn({
                systemPrompt,
                userContent: buildDeltaUserMessage({ prevText, recentText: scanWindow.text, reminderReason: parsed.reason }),
                settings: _wsApiD2.settings,
            });
            parsed = parseDeltaPatch(normaliseOutput(result));
            if (!parsed.ok) throw new DeltaPatchError(`Model patch rejected after retry: ${parsed.reason}`);
        }

        // WORLD-STATE-01: assert scope after the awaits, before any write.
        const scopeResult = assertSameScope(scopeBefore);
        if (!scopeResult.ok) {
            console.warn(
                `[MWT:WorldState] Chat switched during delta generation (${scopeResult.reason}) — ` +
                `discarding result to avoid cross-chat contamination.`
            );
            return null;
        }

        // Nothing changed: no text write (no history snapshot of an unchanged
        // document — mirrors pushToHistory's no-op), but the bookkeeping still
        // advances so staleness resets and the no-op counts toward the
        // reconciliation cadence.
        if (parsed.noChanges) {
            // The watermark is scanWindow.to — where this delta's scan
            // actually ended (the stable-history cutoff), not chat length.
            const status = buildPartialRefreshStatus(baselineStatus, baselineText, baselineText, scanWindow.to);
            const written = setWorldStateDataChecked({ deltaStatus: status });
            if (!written.ok) {
                console.warn(`[MWT:WorldState] Delta refresh (no changes) refused at the store write (${written.reason ?? 'unknown reason'}).`);
                return null;
            }
            console.log('[MWT:WorldState] Delta refresh — model reported no changes.');
            setStatus(state.modal, 'Delta refresh: no changes since the last refresh.', 'info', 4000);
            return baselineText;
        }

        const applied = applyDeltaPatch(baselineText, parsed.ops);
        if (!applied.ok) throw new DeltaPatchError(`Patch failed to apply: ${applied.reason}`);
        let finalText = applied.text;

        // ── Grounding gate (§5.3) on the PATCHED document, same policy as the
        // full refresh. One deliberate difference: no second API retry on a
        // grounding failure — the whole point of delta mode is cost, and the
        // patch already had its parse-retry. Strict discards (fail closed,
        // two-honest-chances spirit: prompt + gate); soft strips and commits.
        const gateSettings = getSettings();
        if (gateSettings.groundingEnabled) {
            // Frozen-evidence rule: the patch was generated from scanWindow.text;
            // grounding must check that EXACT window. Re-reading the sliding
            // latest-N window after the API await lets messages that arrived
            // in the meantime push the oldest part of the original window out
            // of the re-read — and evidence that was valid for the model would
            // then strip or reject legitimate patch content.
            const scanText = scanWindow.text;
            let grounding = groundingGate(finalText, {
                scanText,
                priorText: baselineText,
                pinned: getPinnedEntities(gateSettings),
                mode: gateSettings.groundingMode,
            });
            if (!grounding.ok) {
                if (gateSettings.groundingMode === 'strict') {
                    console.warn(`[MWT:WorldState] Grounding gate rejected the delta patch (${grounding.reason}) — strict mode, discarding.`);
                    setStatus(state.modal, `Grounding gate rejected the delta: ${grounding.reason}. Discarded (strict mode).`, 'warning', 6000);
                    return null;
                }
                console.warn(`[MWT:WorldState] Grounding gate rejected the delta patch (${grounding.reason}) — soft mode, stripping.`);
                grounding = groundingGate(finalText, {
                    scanText,
                    priorText: baselineText,
                    pinned: getPinnedEntities(gateSettings),
                    mode: 'soft',
                });
            }
            for (const { label } of grounding.stripped) {
                console.warn(`[MWT:WorldState] Grounding gate stripped ungrounded name from delta patch: "${label}"`);
            }
            finalText = grounding.cleanedText;
        }
        // NOTE: expiry (§5.2) deliberately does NOT run here — it is a
        // whole-document concern owned by the periodic full refresh, exactly
        // as with per-section regeneration (§7).

        // WORLD-STATE-02: same-chat edit during generation discards the delta
        // instead of clobbering the user's change.
        const currentWs = getWorldStateText();
        if (!sameRevision(wsRevision, currentWs)) {
            console.warn('[MWT:WorldState] Document was edited during delta generation — discarding result to preserve user changes.');
            setStatus(state.modal, 'World State was edited during the delta refresh — result discarded.', 'warning', 6000);
            return null;
        }

        // Checked write (design §8): history snapshot + patched text + status
        // in ONE commit; a refusal keeps the previous world state intact.
        // buildPartialRefreshStatus stamps the digest of the PATCHED document
        // (the baseline digest-matched above, so every line is either
        // previously reconciled or covered by this patch) and the watermark
        // scanWindow.to — where the scan actually ended.
        const written = commitHistorySnapshot(baselineText, {
            text: finalText,
            deltaStatus: buildPartialRefreshStatus(baselineStatus, baselineText, finalText, scanWindow.to),
        });
        if (!written.ok) {
            console.warn(`[MWT:WorldState] Delta refresh refused at the store write (${written.reason ?? 'unknown reason'}) — the previous world state was kept.`);
            setStatus(state.modal, `Delta refresh failed: the world state store refused the write (${written.reason ?? 'unknown reason'}); the previous world state was kept.`, 'error', 6000);
            return null;
        }
        state.autoSaveLastText = finalText;
        state.isDirty = false;
        state.editSessionActive = false;
        applyWorldStateInjection();
        try { setProvenance(buildProvenance()); } catch (err) {
            console.warn('[MWT:WorldState] Provenance build failed (non-fatal):', err.message);
        }

        console.log(`[MWT:WorldState] Delta refresh complete (${parsed.ops.length} op(s), ${finalText.length} chars).`);
        return finalText;
    } catch (err) {
        console.error('[MWT:WorldState] Delta refresh failed:', err);
        throw err;
    } finally {
        state.wstIsRefreshing = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        if (state.autoRefreshQueued) {
            state.autoRefreshQueued = false;
            state.autoRefreshDeferTimer = setTimeout(() => {
                state.autoRefreshDeferTimer = null;
                scheduleAutoRefresh('follow-up-from-finally');
            }, 500);
        }
    }
}

/**
 * The scheduled auto-refresh entry point (TODO §3-F): plan the run with
 * planAutoRefresh() — cheap delta when possible, full refresh for the first
 * generation / imported documents / manual-edit reconciliation / the periodic
 * reconciliation cadence. A DeltaPatchError (the model failed the patch
 * protocol twice) escalates to a full refresh THIS cycle so the document is
 * still freshened; every other error propagates like a full-refresh failure.
 */
export async function runScheduledWorldStateRefresh(isAuto = true) {
    const plan = planAutoRefresh();
    if (plan.kind === 'delta') {
        try {
            return await refreshWorldStateDelta(isAuto);
        } catch (err) {
            if (!(err instanceof DeltaPatchError)) throw err;
            console.warn(`[MWT:WorldState] Scheduled delta rejected (${err.message}) — escalating to a full refresh this cycle.`);
            setStatus(state.modal, 'Delta patch rejected twice — running a full refresh instead.', 'warning', 6000);
        }
    } else {
        console.log(`[MWT:WorldState] Scheduled refresh will run FULL (${plan.reason}).`);
    }
    return refreshWorldState(isAuto);
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
            // TODO §3-F: when delta mode is on and a baseline exists, this
            // runs the cheap incremental patch instead of a full regeneration
            // (with periodic full reconciliation — see runScheduledWorldStateRefresh).
            const text = await runScheduledWorldStateRefresh(true);
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