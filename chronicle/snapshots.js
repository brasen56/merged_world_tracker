/**
 * chronicle/snapshots.js — Generation, validation, CRUD, and world state sync.
 *
 * Handles creating, regenerating, consolidating, deleting, and restoring
 * chronicle entries.
 */

import {
    getContextSafe, getChat,
    resolveApiCall, normaliseOutput,
    notify,
    getCurrentWorldState, getWorldStateFactual, getCurrentWorldStateScene,
    captureScope, assertSameScope, isCancellation,
    captureRevision,
    sameRevision,
} from '../core/index.js';

import { captureSceneAnchorBaseline, updateSceneAnchor } from '../world_state/scene.js';

// Part 6 (§7.4) pause guard. Direct import (not the barrel) so the REAL
// pause singleton is read even under the test barrel→stub alias.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { chronicleSchema } from './schema.js';

import { CHRONICLE_SYSTEM_PROMPT, CONSOLIDATE_SYSTEM_PROMPT } from './prompts.js';
import {
    state, MAX_ENTRY_WORD_COUNT, MAX_TRASH_SIZE,
    getSettings,
    getChronicleData, setChronicleData, setChronicleDataChecked, getSnapshots,
    getCharactersInRange, scSetStatus, getVisibleChronicleView,
    makeAnchor, resolveAnchor, resumeIndexByTime, buildMessageWindow,
    getReceiptIdentity,
    _render,
} from './data.js';

import { applyInjection, getInjectionSettings } from './injection.js';
import { retainChronicleTrash } from './trash.js';

// ─── World State sync ────────────────────────────────────────────────────────

function extractSceneAnchor(text) {
    const timeMatch = text.match(/## Time Anchor[\s\S]*?In-world date and time at end of this period:\s*(.+)/i);
    const locMatch = text.match(/## Time Anchor[\s\S]*?Location at end of this period:\s*(.+)/i);
    return {
        dateTime: timeMatch?.[1]?.trim(),
        location: locMatch?.[1]?.trim(),
    };
}

// When an entry's coverage ends. A consolidated entry takes its EARLIEST
// source's createdAt (its display slot) but covers through its LATEST source,
// so it ranks by the newest source it merged. The trash keeps every live
// consolidation's sources, nested merges included (retainChronicleTrash).
function coveredThroughMs(entry, trashById, seen = new Set()) {
    const created = new Date(entry?.createdAt).getTime();
    let latest = Number.isFinite(created) ? created : -Infinity;
    for (const id of Array.isArray(entry?._consolidatedFrom) ? entry._consolidatedFrom : []) {
        const source = trashById.get(id);
        if (!source || seen.has(id)) continue;
        seen.add(id);
        latest = Math.max(latest, coveredThroughMs(source, trashById, seen));
    }
    return latest;
}

/**
 * Entries oldest first by when their coverage ends: the order World State
 * reads "newest" from. Message indices cannot order entries, because
 * condensing (ILS summaries) and bulk deletes renumber the chat, so every entry
 * written afterwards records lower indices than the older ones.
 */
function timelineOrder(snapshots) {
    const trash = getChronicleData()._deletedBin || [];
    const trashById = new Map(trash.map(entry => [entry?.id, entry]));
    return snapshots
        .map((entry, position) => ({ entry, position, at: coveredThroughMs(entry, trashById) }))
        // Ties keep list order. Compared explicitly: -Infinity - -Infinity is NaN.
        .sort((a, b) => (a.at === b.at ? a.position - b.position : a.at < b.at ? -1 : 1))
        .map(item => item.entry);
}

function acceptedSourceRanges() {
    return timelineOrder(getSnapshots()).map(entry => ({
        id: entry.id,
        range: { from: entry.fromIndex, to: entry.toIndex },
    }));
}

function syncWorldStateFromSnapshot(snapshot, {
    source, scope, expectedRevision, baselineStatusSignature, previousNewestRange,
} = {}) {
    const anchor = extractSceneAnchor(snapshot?.text || '');
    if (!anchor.dateTime && !anchor.location) return { status: 'no-change', applied: false };
    const outcome = updateSceneAnchor({
        ...anchor,
        source,
        sourceId: snapshot.id,
        sourceRange: { from: snapshot.fromIndex, to: snapshot.toIndex },
        acceptedSources: acceptedSourceRanges(),
        getAcceptedSources: () => acceptedSourceRanges(),
        previousNewestRange,
        expectedRevision,
        baselineStatusSignature,
        scope,
    });
    if (outcome.warnings?.length) {
        for (const warning of outcome.warnings) {
            console.warn(`[MWT:Chronicle] World State scene sync warning: ${warning.message}`);
        }
    }
    if (!['applied', 'no-change', 'deferred'].includes(outcome.status)) {
        console.log(`[MWT:Chronicle] World State scene sync skipped: ${outcome.status} (${outcome.reason || 'no reason'}).`);
    }
    return outcome;
}

// ─── Validate output ─────────────────────────────────────────────────────────

function validateSnapshotOutput(text) {
    if (!text.trim().startsWith('## Summary')) return { valid: false, reason: 'Output does not start with "## Summary".' };
    const sections = text.match(/^##\s/gm);
    if (!sections || sections.length < 2) return { valid: false, reason: 'Must contain at least two sections.' };
    const forbidden = ['narration', 'dialogue', 'roleplay', 'continue'];
    const lower = text.toLowerCase();
    const hit = forbidden.find(w => (lower.match(new RegExp(w, 'g')) || []).length > 2);
    if (hit) return { valid: false, reason: `Too many instances of "${hit}" — likely narrative text.` };
    const rpMarkers = text.match(/^(\*|_)/gm);
    if (rpMarkers && rpMarkers.length > 2) return { valid: false, reason: 'Contains roleplay formatting markers.' };
    const quoteLines = (text.match(/^["\u201C]/gm) || []).length;
    if (quoteLines > 1) return { valid: false, reason: 'Contains dialogue-like quoted lines.' };
    if (text.split(/\s+/).length > MAX_ENTRY_WORD_COUNT) return { valid: false, reason: `Too long (${text.split(/\s+/).length} words).` };
    return { valid: true };
}

function validateConsolidationOutput(text, baseEntry, deltaEntries) {
    // Guard against entries missing `text` (e.g. malformed imports). The word
    // counts feed the size ceiling below; an undefined `text` would previously
    // throw a TypeError on `.split`.
    const wordCount = (e) => (typeof e?.text === 'string' ? e.text.split(/\s+/).filter(Boolean).length : 0);
    const maxAllowed = Math.max(wordCount(baseEntry) + deltaEntries.reduce((s, e) => s + wordCount(e), 0), 600);
    if (wordCount({ text }) > maxAllowed * 1.5) return { valid: false, reason: 'Consolidated entry too long.' };
    return validateSnapshotOutput(text);
}

/**
 * Drop anything the model emitted before the entry proper.
 *
 * Both chronicle prompts require the output to begin with "## Summary", so if
 * leaked reasoning or a preamble precedes it (e.g. an unterminated <think> block
 * that normaliseOutput's strip couldn't match), slice from the first "## Summary".
 * This anchors to the format contract instead of trying to enumerate every
 * thinking syntax. Returns the text unchanged if no heading is present.
 */
function stripToEntry(text) {
    const i = text.indexOf('## Summary');
    return i > 0 ? text.slice(i).trim() : text;
}

/**
 * Part 6 (§7.4): manual/direct entry points (the Generate / Regenerate /
 * Consolidate buttons) bypass the event router's decline predicate, so every
 * API-spending choke point in this file must refuse while the chronicle store
 * is paused. Generating would read the unprepared store, spend an API call,
 * and then have setChronicleData()'s refused write hide that the "successful"
 * snapshot was never saved (the bookkeeping reset below would compound the
 * loss). Say the refusal out loud so the button never looks like a no-op.
 *
 * @returns {boolean} true when the entry point must stop right here
 */
function chroniclePaused() {
    if (!isStorePausedForCurrentScope(chronicleSchema.id)) return false;
    console.log('[MWT:Chronicle] Generation skipped — the store is paused for this chat (schema preparation).');
    scSetStatus('Chronicle is paused for this chat — its data could not be safely prepared, so nothing was generated. Use Retry in the banner after repairing the data.', 'error');
    return true;
}

/**
 * The resume point when the anchor message no longer resolves. Resuming past
 * already-covered history re-chronicles a little, which a summary tolerates;
 * resuming too late is unrecoverable loss, so every branch errs early.
 *
 * 1. The anchor recorded its send time: resume at the boundary's slot, found
 *    by time (resumeIndexByTime). Survives condensing and bulk deletes.
 * 2. An older anchor without one, while the entry's recorded boundary index
 *    is still inside the chat: resume AT that index. A deletion shifts the
 *    first uncovered message down into it (lastCovered + 1 would skip it
 *    forever); an edit re-chronicles the one covered message.
 * 3. That index is at or past the end of the chat: messages before it were
 *    condensed (ILS) or bulk-deleted, so it points at nothing, and resuming
 *    there refused with "No new messages" on every attempt. Resume after
 *    the last message sent before the entry was CREATED — nothing newer can
 *    be in it. The few in-flight messages the entry deliberately left out
 *    (sent just before it) count as covered here; case 1 has no such gap.
 *
 * @param {object[]} chat
 * @param {object} anchor chronicle.lastAnchor (known to be unresolvable)
 * @param {object} lastCoveredEntry newest snapshot with a real toIndex
 * @returns {number}
 */
function resumeAfterLostAnchor(chat, anchor, lastCoveredEntry) {
    if (Number.isFinite(anchor.sendDate)) {
        const byTime = resumeIndexByTime(chat, anchor.sendDate);
        if (byTime !== null) return byTime;
    }
    const lastCovered = lastCoveredEntry.toIndex;
    if (lastCovered < chat.length) return lastCovered;
    const createdMs = Date.parse(lastCoveredEntry.createdAt);
    if (Number.isFinite(createdMs)) {
        const byTime = resumeIndexByTime(chat, createdMs);
        if (byTime !== null) return byTime;
    }
    return lastCovered;
}

// ─── Generate snapshot ───────────────────────────────────────────────────────

export async function generateSnapshot(isAuto = false) {
    if (chroniclePaused()) return null;
    if (state.isGenerating) { scSetStatus('Generation already in progress.', 'error'); return null; }
    if (state.isMainGenerating) {
        // Verify against actual ST state — the event-tracked flag can get stale
        const ctx = getContextSafe();
        const actuallyBusy = ctx?.streamingProcessor && !ctx.streamingProcessor.isFinished;
        if (actuallyBusy) {
            scSetStatus('Wait for the current chat response to finish.', 'error');
            return null;
        }
        // Flag was stale, reset it
        console.log('[MWT:Chronicle] Resetting stale isMainGenerating flag');
        state.isMainGenerating = false;
    }
    const chat = getChat();
    const chronicle = getChronicleData();
    const { index, found } = resolveAnchor(chronicle.lastAnchor);
    const snapshotsBefore = getSnapshots();
    // Manual entries (and a consolidated entry whose latest source was manual)
    // carry toIndex: -1 — they record no chat coverage. Only a real recorded
    // range counts as a resume point, so scan back past the -1 markers; with
    // none there is no safe fallback on an anchor miss and the refusal below
    // fires instead of silently re-chronicling history from message zero.
    const lastCoveredEntry = [...snapshotsBefore].reverse()
        .find(s => Number.isInteger(s?.toIndex) && s.toIndex >= 0);
    const lastCovered = lastCoveredEntry ? lastCoveredEntry.toIndex : undefined;
    if (!found && chronicle.lastAnchor && !Number.isInteger(lastCovered)) {
        setChronicleData({ anchorStale: true });
        scSetStatus('Chronicle anchor changed and no snapshot range is available; review the history before generating.', 'error');
        return null;
    }
    let actualFrom = Math.max(0, !found && chronicle.lastAnchor
        ? resumeAfterLostAnchor(chat, chronicle.lastAnchor, lastCoveredEntry) : index);
    let startOffset = 0;
    // Oversized-message continuation: the newest recorded range may have ended
    // MID-MESSAGE (toCharOffset — buildMessageWindow cuts a single >100k
    // message at the budget instead of dropping its tail). chronicle.lastAnchor
    // is that same boundary message, so when it still resolves AND the recorded
    // range ends at it (the marker belongs to this message, not an older entry
    // whose snapshot was deleted), resume INSIDE it instead of past it;
    // otherwise the unseen remainder could never reach a later snapshot.
    if (found && chronicle.lastAnchor && lastCoveredEntry
        && Number.isInteger(lastCoveredEntry.toCharOffset) && lastCoveredEntry.toCharOffset >= 0
        && lastCoveredEntry.toIndex === index - 1) {
        actualFrom = Math.max(0, index - 1);
        startOffset = lastCoveredEntry.toCharOffset;
    }
    if (!found && chronicle.lastAnchor) {
        setChronicleData({ anchorStale: true });
        scSetStatus('Chronicle anchor changed (its message was edited, deleted, or condensed); resuming where the last entry ended. Review the new entry.', 'warning');
    }
    if (actualFrom >= chat.length) { scSetStatus('No new messages to chronicle.', 'error'); return null; }
    const { text, toIndex, toCharOffset } = buildMessageWindow(actualFrom, undefined, startOffset);
    if (!text.trim()) { scSetStatus('No filterable messages to chronicle.', 'error'); return null; }
    // Freeze the exact source interval used in the prompt. Same-chat edits
    // must not attach a newly built anchor/character list to old model output.
    const sourceRevision = captureRevision(chat.slice(actualFrom, toIndex + 1));
    const sourceAnchor = makeAnchor(chat[toIndex]);
    const sourceCharacters = getCharactersInRange(actualFrom, toIndex);

    // CHRONICLE-03 (part 2): Record what the counter was when the message
    // window was cut. onMessageReceived() now keeps counting while a snapshot
    // generates (part 1), but this function used to reset the counter to 0 on
    // success — which threw those messages away again. They are past `toIndex`
    // and therefore NOT in this snapshot, so they must still count toward the
    // next one. Subtracting the consumed amount instead of zeroing keeps the
    // auto-snapshot cadence honest across a long generation.
    const receiptEventsAtWindow = new Map(state.countedReceiptEvents);
    const counterAtWindow = state.msgSinceSnapshot;
    // The window now ends at `toIndex` (the last included message), not at the
    // end of chat: buildMessageWindow excludes the trailing in-flight pair. Those
    // excluded messages can have counted events in `receiptEventsAtWindow`, so they must
    // survive the consume below — otherwise the auto-snapshot cadence drifts by
    // the exclusion count on every snapshot.
    // msgSinceSnapshot counts MESSAGE_RECEIVED events, not raw chat entries.
    // The excluded user+assistant pair therefore preserves one assistant
    // receipt rather than two raw-array slots.
    const tailStart = Math.max(0, toIndex + 1);
    const tailReceiptKeys = new Set();
    for (const message of chat.slice(tailStart)) {
        if (!message || message.is_user || message.is_system) continue;
        const key = getReceiptIdentity(message);
        tailReceiptKeys.add(key);
    }
    // Only receipt EVENTS in the captured counter can be consumed. Chat rows
    // loaded from history (or suppressed by panic) have no counted event.

    // CHRONICLE-01/02: Capture scope before async API call. The old weak key
    // collapsed two different chats on the same character when chatId was
    // absent. The scope guard uses getCurrentChatId() + epoch.
    const scopeBefore = captureScope();
    const worldStateRevision = captureRevision(getCurrentWorldState());
    const worldStateBaseline = captureSceneAnchorBaseline();
    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    scSetStatus('Generating chronicle entry…', 'info');
    notify('Session Chronicle', 'Generating chronicle entry…', 'info');
    const worldState = getWorldStateFactual().trim();
    const scene = getCurrentWorldStateScene();
    const worldDate = scene?.date
        ? `${scene.date.trim()}${scene.time ? ` ${scene.time.trim()}` : ''}`
        : new Date().toLocaleDateString();
    const userContent = worldState ? `Current World State:\n${worldState}\n\nMessages to chronicle:\n${text}` : `Messages to chronicle:\n${text}`;

    try {
        const _scApi1 = resolveApiCall({ moduleSettings: getSettings() });
        // Coordinator classification (TODO §1): the message-counter auto
        // snapshot is background work; the Snapshot button is foreground.
        const _scTrigger = isAuto ? 'auto' : 'manual';
        let raw = await _scApi1.fetchFn({ systemPrompt: CHRONICLE_SYSTEM_PROMPT, userContent, settings: _scApi1.settings, retries: 3, trigger: _scTrigger });
        if (!assertSameScope(scopeBefore).ok) return null;
        raw = normaliseOutput(raw);
        raw = stripToEntry(raw);
        if (!raw.trim()) {
            if (!assertSameScope(scopeBefore).ok) return null;
            const _scApi1b = resolveApiCall({ moduleSettings: getSettings() });
            raw = await _scApi1b.fetchFn({ systemPrompt: CHRONICLE_SYSTEM_PROMPT, userContent: userContent + '\n\n[REMINDER: Your last response was empty. Produce the chronicle entry as specified.]', settings: _scApi1b.settings, retries: 3, trigger: _scTrigger });
            raw = normaliseOutput(raw);
            raw = stripToEntry(raw);
        }
        if (!assertSameScope(scopeBefore).ok) return null;
        if (!raw.trim()) throw new Error('Chronicle output was empty.');

        const validation = validateSnapshotOutput(raw);
        if (!validation.valid) { console.warn('[MWT:Chronicle] Validation:', validation.reason); scSetStatus(`May need review: ${validation.reason}`, 'error'); }

        // CHRONICLE-01/02: Assert scope before any writes. A chat switch during
        // the API call must discard the result to prevent cross-chat
        // contamination.
        const scopeResult = assertSameScope(scopeBefore);
        if (!scopeResult.ok) {
            console.warn(
                `[MWT:Chronicle] Chat switched during generation (${scopeResult.reason}) — ` +
                `discarding result to avoid cross-chat contamination.`
            );
            scSetStatus('Chat changed during generation — result discarded.', 'warning');
            return null;
        }
        if (!sameRevision(sourceRevision, (getChat() || []).slice(actualFrom, toIndex + 1))) {
            scSetStatus('Source messages changed during generation — result discarded.', 'warning');
            return null;
        }

        const newAnchor = sourceAnchor;
        const characters = sourceCharacters;
        const snapshot = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(), worldDate, anchor: newAnchor,
            fromIndex: actualFrom, toIndex: typeof toIndex === 'number' ? toIndex : actualFrom,
            text: raw, characters, note: '',
            // Present only when the window ended mid-message: the character
            // offset up to which chat[toIndex] is covered. The next generation
            // resumes inside the message instead of past it.
            ...(Number.isInteger(toCharOffset) && toCharOffset >= 0 ? { toCharOffset } : {}),
        };
        const snapshots = [...getSnapshots(), snapshot];
        // CHRONICLE-03 (part 2): Consume only counted events this snapshot
        // actually covers. Anything arriving after the window was cut
        // remains work, so it carries over. Clamped at 0 because a
        // deletion during generation can lower the counter below the captured
        // value.
        // A deletion during the API call may already have removed a covered
        // event from the live counter. Consume only the captured events still
        // present, or that deletion would subtract a newer arrival twice.
        const consumedAtWindow = [...receiptEventsAtWindow].reduce((sum, [key, count]) =>
            sum + (tailReceiptKeys.has(key) ? 0 : Math.min(count, state.countedReceiptEvents.get(key) || 0)), 0);
        // Consume receipt provenance with the counter. Keep only events that
        // belong to the uncovered tail, rather than relying on Map insertion
        // order (which is unrelated to chat position after regenerations).
        const remainingEvents = new Map(state.countedReceiptEvents);
        for (const [key, count] of receiptEventsAtWindow) {
            const liveCount = remainingEvents.get(key) || 0;
            const newlyArrived = Math.max(0, liveCount - count);
            const retain = (tailReceiptKeys.has(key) ? Math.min(count, liveCount) : 0) + newlyArrived;
            if (retain > 0) remainingEvents.set(key, retain);
            else remainingEvents.delete(key);
        }
        // The counter only drains through receipt events, so increments with
        // no event behind them (a count carried over from before receipt
        // provenance, or one whose event was lost) were never consumed: once
        // they alone reached the threshold, every later reply fired another
        // auto-snapshot. Drop the ones already counted when the window was
        // cut; anything arriving during generation still carries over.
        const eventsAtWindow = [...receiptEventsAtWindow.values()].reduce((sum, count) => sum + count, 0);
        const unaccountedAtWindow = Math.max(0, counterAtWindow - eventsAtWindow);
        const remainingCounter = Math.max(0, state.msgSinceSnapshot - consumedAtWindow - unaccountedAtWindow);
        const written = setChronicleDataChecked({ snapshots, lastAnchor: newAnchor,
            suggestSent: true, anchorStale: !found && !!chronicle.lastAnchor,
            msgSinceSnapshot: remainingCounter, countedReceiptEvents: [...remainingEvents.entries()] });
        if (!written.ok) { scSetStatus('Chronicle entry could not be saved.', 'error'); return null; }
        state.msgSinceSnapshot = remainingCounter;
        state.countedReceiptEvents = remainingEvents;
        state.autoSnapshotRetryAt = 0;
        applyInjection();
        // M2-18: finishing in the background must not replace the view the
        // user is working in. Only the entry list may be re-rendered; an open
        // editor, preview, or settings form keeps its unsaved state (the
        // status line reports the new entry). A manual Generate — clicked
        // from the list — still opens the new entry; an auto-snapshot never
        // navigates on the user's behalf.
        const view = getVisibleChronicleView();
        if (!isAuto && view !== 'other') state.selectedSnapshotId = snapshot.id;
        if (view === 'list') _render.renderContent();
        if (getSettings().syncWorldState) syncWorldStateFromSnapshot(snapshot, {
            source: 'generated', scope: scopeBefore,
            expectedRevision: worldStateRevision, baselineStatusSignature: worldStateBaseline,
        });
        scSetStatus('Chronicle entry generated.', 'success');
        return snapshot;
    } catch (err) {
        if (!assertSameScope(scopeBefore).ok) return null;
        // Coordinator cancellation (TODO §1): the chat changed mid-snapshot and
        // the coordinator aborted the call, or the queued job was retired
        // before it started. The scope guard would have discarded the result
        // anyway — return quietly instead of a failure status/notification.
        // isCancellation() covers both the marked JobCancelledError and the
        // native AbortError of a mid-wire abort.
        if (isCancellation(err)) {
            console.log('[MWT:Chronicle] Snapshot cancelled (coordinator) — discarded.');
            return null;
        }
        console.error('[MWT:Chronicle] Generate error:', err);
        scSetStatus(`Generation failed: ${err.message}`, 'error');
        notify('Session Chronicle', `Chronicle generation failed: ${err.message}`, 'error');
        return null;
    } finally {
        if (assertSameScope(scopeBefore).ok) {
            state.isGenerating = false;
            document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        }
    }
}

// ─── Regenerate snapshot ─────────────────────────────────────────────────────

export async function regenerateSnapshot(snapshotId) {
    if (chroniclePaused()) return;
    if (state.isGenerating || state.isMainGenerating) { scSetStatus('Wait for current generation to finish.', 'error'); return; }
    const snapshots = getSnapshots();
    const idx = snapshots.findIndex(s => s.id === snapshotId);
    if (idx === -1) return;
    const snapshot = snapshots[idx];
    const originalText = snapshot.text;
    const chat = getChat();
    // Clamp both bounds to >= 0 — manual entries use fromIndex: -1 and
    // consolidated entries can carry -1 toIndex, which previously shrank the
    // message window down to "just the final message". generateSnapshot
    // already clamps via Math.max(0, index); mirror that here.
    const from = Math.max(0, snapshot.fromIndex ?? 0);
    const rawTo = snapshot.toIndex !== undefined && snapshot.toIndex >= (snapshot.fromIndex ?? 0) ? snapshot.toIndex : Math.min(from + 200, Math.max(0, chat.length - 1));
    const to = Math.max(from, rawTo);
    const { text, toIndex: coveredTo, toCharOffset: regenToCharOffset, complete } = buildMessageWindow(from, to);
    if (!text.trim()) {
        scSetStatus('No messages for regeneration.', 'error');
        return;
    }
    // Regeneration keeps the entry's recorded range, so a window the budget
    // stopped before `to` would summarize only the start of that range and
    // silently drop its newest end (a consolidated entry, or one made before
    // windows were filled oldest-first). Refuse before spending a model call.
    // A window cut inside one oversized message that ends AT `to` is the
    // normal mid-message continuation, which toCharOffset records below.
    if (!complete && coveredTo < to) {
        scSetStatus(`This entry covers more chat than one regeneration can read (messages ${from}–${to}; only up to ${coveredTo} fits). Edit it by hand, or regenerate the original entries before consolidating.`, 'error');
        return;
    }
    const worldState = getWorldStateFactual().trim();
    const userContent = worldState ? `Current World State:\n${worldState}\n\nMessages to chronicle:\n${text}` : `Messages to chronicle:\n${text}`;

    // CHRONICLE-01: Regeneration needs the same scope guard as generation.
    const scopeBefore = captureScope();
    const sourceRevision = captureRevision(chat.slice(from, to + 1));
    const snapshotRevision = captureRevision(snapshot);

    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    scSetStatus('Regenerating…', 'info');

    try {
        const _scApi2 = resolveApiCall({ moduleSettings: getSettings() });
        let raw = await _scApi2.fetchFn({ systemPrompt: CHRONICLE_SYSTEM_PROMPT, userContent, settings: _scApi2.settings, retries: 3 });
        raw = normaliseOutput(raw);
        raw = stripToEntry(raw);
        if (!assertSameScope(scopeBefore).ok) return;
        if (!raw.trim()) throw new Error('Empty output.');
        // Anchor on the full chronicle label so the captured value is just the
        // date/time, not the "at end of this period:" prefix.
        const timeMatch = raw.match(/## Time Anchor[\s\S]*?In-world date and time at end of this period:\s*(.+)/i);
        const newWorldDate = timeMatch ? timeMatch[1].trim() : snapshot.worldDate;

        // CHRONICLE-01: Assert scope before showing the diff preview. A chat
        // switch during the API call must discard the result.
        const scopeResult = assertSameScope(scopeBefore);
        if (!scopeResult.ok) {
            console.warn(
                `[MWT:Chronicle] Chat switched during regeneration (${scopeResult.reason}) — ` +
                `discarding result to avoid cross-chat contamination.`
            );
            scSetStatus('Chat changed during regeneration — result discarded.', 'warning');
            return;
        }
        if (!sameRevision(sourceRevision, (getChat() || []).slice(from, to + 1))
            || !sameRevision(snapshotRevision, getSnapshots().find(entry => entry.id === snapshotId))) {
            scSetStatus('Source messages or entry changed during regeneration — result discarded.', 'warning');
            return;
        }

        _render.showRegenerateDiff(originalText, raw, async (acceptNew) => {
            if (acceptNew) {
                // CHRONICLE-01: Re-assert scope inside the accept callback too.
                // The diff preview stays open while the user decides; a chat
                // switch during that time must not commit old-chat data.
                if (!assertSameScope(scopeBefore).ok) {
                    console.warn('[MWT:Chronicle] Chat switched during regen preview — discarding result.');
                    scSetStatus('Chat changed during preview — result discarded.', 'warning');
                    _render.renderContent();
                    return;
                }
                // The preview can remain open while other World State work
                // completes. Capture this optimistic baseline only when the
                // user accepts, just as consolidation does.
                const worldStateRevision = captureRevision(getCurrentWorldState());
                const worldStateBaseline = captureSceneAnchorBaseline();
                // Re-fetch the snapshot list at accept time. The `snapshots`
                // array captured before the preview is stale: the busy lock is
                // released while the preview waits, so the user may have
                // generated, deleted, or consolidated entries in between —
                // writing the old array back would resurrect deleted entries
                // or drop new ones.
                const current = getSnapshots();
                const curIdx = current.findIndex(s => s.id === snapshotId);
                if (curIdx === -1 || !sameRevision(snapshotRevision, current[curIdx])
                    || !sameRevision(sourceRevision, (getChat() || []).slice(from, to + 1))) {
                    scSetStatus('Entry or source messages changed — regenerated text discarded.', 'warning');
                    _render.renderContent();
                    return;
                }
                const updated = [...current];
                // Regeneration rebuilds the window from the range START (char
                // offset 0), so the entry's mid-message cut marker must follow
                // the NEW window: kept if this regeneration itself had to cut
                // the first message, dropped when the message now fits whole.
                // A stale marker would make the next generation resume
                // mid-message and re-chronicle an already-covered chunk.
                updated[curIdx] = {
                    ...current[curIdx],
                    text: raw,
                    worldDate: newWorldDate,
                    ...(Number.isInteger(regenToCharOffset) && regenToCharOffset >= 0
                        ? { toCharOffset: regenToCharOffset }
                        : { toCharOffset: undefined }),
                };
                const written = setChronicleDataChecked({ snapshots: updated });
                if (!written.ok) {
                    scSetStatus('Could not save regenerated entry; original was kept.', 'error');
                    _render.renderContent();
                    return;
                }
                applyInjection();
                state.selectedSnapshotId = snapshot.id;
                _render.renderContent();
                if (getSettings().syncWorldState) syncWorldStateFromSnapshot(updated[curIdx], {
                    source: 'regenerated', scope: scopeBefore,
                    expectedRevision: worldStateRevision, baselineStatusSignature: worldStateBaseline,
                });
                scSetStatus('Entry regenerated.', 'success');
            } else {
                scSetStatus('Kept original.', 'info');
                state.selectedSnapshotId = snapshot.id;
                _render.renderContent();
            }
        });
    } catch (err) {
        if (isCancellation(err) || !assertSameScope(scopeBefore).ok) return;
        scSetStatus(`Regeneration failed: ${err.message}`, 'error');
        notify('Session Chronicle', `Chronicle regeneration failed: ${err.message}`, 'error');
    } finally {
        // Reset busy in `finally` so the flag is always released — even if the
        // diff preview is dismissed/replaced without the Accept/Keep callback
        // ever firing. The preview is shown synchronously, so by the time we
        // reach here the listeners are wired and no longer need the lock
        // (mirrors consolidateEntries, which does not hold the lock during its
        // preview either).
        if (assertSameScope(scopeBefore).ok) {
            state.isGenerating = false;
            document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        }
    }
}

// ─── Consolidate entries ─────────────────────────────────────────────────────

export async function consolidateEntries(ids, baseId = null) {
    if (chroniclePaused()) return;
    if (state.isGenerating) { scSetStatus('Generation in progress.', 'error'); return; }
    if (!ids || ids.length < 2) { scSetStatus('Select at least 2 entries.', 'error'); return; }
    const snapshots = getSnapshots();
    const selected = ids.map(id => snapshots.find(s => s.id === id)).filter(Boolean);
    if (selected.length < 2) { scSetStatus('Could not find all entries.', 'error'); return; }
    // Resolve the BASE entry.  By default this is the earliest by createdAt
    // (the historical behaviour).  The user can override via the "★ Set as
    // Base" control in consolidate mode — e.g. pinning an already-consolidated
    // entry as the foundation and treating fresher entries as deltas against
    // it, instead of letting pure timestamp ordering choose the base.
    const designatedBaseId = baseId || state.consolidateBaseId;
    let base;
    let deltas;
    if (designatedBaseId && selected.some(s => s.id === designatedBaseId)) {
        base = selected.find(s => s.id === designatedBaseId);
        deltas = selected.filter(s => s.id !== designatedBaseId);
        // Keep deltas in chronological order so the model reads them as a
        // coherent progression.
        deltas.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else {
        selected.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        base = selected[0];
        deltas = selected.slice(1);
    }
    const chronological = [...selected].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const baseSection = `=== BASE ENTRY (designated foundation; not necessarily earliest) ===\n${base.text}`;
    const deltaSections = deltas.map((d, i) => `=== SOURCE ENTRY ${i + 1} (chronological order among remaining entries) ===\n${d.text}`).join('\n\n');
    const userContent = `Timeline order (earliest to latest):\n${chronological.map((entry, i) =>
        `${i + 1}. ${entry.id} — ${entry.worldDate || entry.createdAt}${entry.id === base.id ? ' (designated foundation)' : ''}`).join('\n')}\n` +
        `The timeline endpoint is entry ${chronological.at(-1).id}; take the Time Anchor from that entry, even if it is BASE.\n\n${baseSection}\n\n${deltaSections}`;

    // Pass entries to the preview in base-first order so the preview's
    // index-0-is-BASE labelling matches the actual consolidation intent.
    const previewEntries = [base, ...deltas];
    // CHRONICLE-01: Capture scope before the preview callback. The consolidation
    // preview callback outlives onChatChanged() — it fires when the user clicks
    // accept, which can be much later. The callback must check scope before
    // committing anything.
    const scopeBefore = captureScope();
    const sourceRevisions = ids.map(id => captureRevision(selected.find(entry => entry.id === id)));

    _render.showConsolidationPreview(previewEntries, userContent, async (editedResult) => {
        if (state.isGenerating) return;
        // CHRONICLE-01: Assert scope at callback entry. A chat switch since the
        // preview was shown means the consolidation result would be written
        // into the wrong chat.
        if (!assertSameScope(scopeBefore).ok) {
            console.warn('[MWT:Chronicle] Chat changed during consolidation preview — discarding result.');
            scSetStatus('Chat changed during consolidation — result discarded.', 'warning');
            _render.renderContent();
            return;
        }
        const worldStateRevision = captureRevision(getCurrentWorldState());
        const worldStateBaseline = captureSceneAnchorBaseline();
        state.isGenerating = true;
        scSetStatus('Consolidating…', 'info');
        try {
            const _scApi3 = resolveApiCall({ moduleSettings: getSettings() });
            let raw = await _scApi3.fetchFn({ systemPrompt: CONSOLIDATE_SYSTEM_PROMPT, userContent: editedResult || userContent, settings: _scApi3.settings, retries: 3 });
            raw = normaliseOutput(raw);
            raw = stripToEntry(raw);
            if (!raw.trim()) throw new Error('Empty output.');
            if (!raw.startsWith('## Summary')) {
                // No recoverable entry — the model returned pure reasoning/prose
                // (often a thinking model overflowing max_tokens). Fail loudly
                // instead of saving the verbose blob.
                throw new Error('Model returned reasoning instead of an entry — raise Max Tokens or use a non-thinking model.');
            }
            const validation = validateConsolidationOutput(raw, base, deltas);
            if (!validation.valid) { console.warn('[MWT:Chronicle] Consolidation:', validation.reason); scSetStatus(`Review needed: ${validation.reason}`, 'error'); }
            // The preview leaves Chronicle unlocked. Re-read the list before
            // replacing entries so a snapshot created while it was open is not
            // lost, and so World State eligibility is checked against the
            // actual newest accepted range rather than the preview's stale one.
            if (!assertSameScope(scopeBefore).ok) {
                scSetStatus('Chat changed during consolidation — result discarded.', 'warning');
                return;
            }
            const currentSnapshots = getSnapshots();
            const currentSelected = ids.map(id => currentSnapshots.find(entry => entry.id === id)).filter(Boolean);
            if (currentSelected.length !== selected.length || currentSelected.some((entry, i) =>
                !sameRevision(sourceRevisions[i], entry))) {
                scSetStatus('One or more selected entries changed during consolidation — result discarded.', 'warning');
                _render.renderContent();
                return;
            }
            const currentChronological = [...currentSelected]
                .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            const currentEarliest = currentChronological[0];
            const currentLatest = currentChronological[currentChronological.length - 1];
            // Same timeline order World State checks newest by, not the highest
            // range: after condensing, an older entry can hold the larger indices.
            const previousNewest = timelineOrder(currentSnapshots)
                .filter(entry => Number.isInteger(entry?.toIndex) && entry.toIndex >= 0)
                .at(-1);
            const allCharacters = new Set();
            currentSelected.forEach(entry => { if (entry.characters) entry.characters.forEach(character => allCharacters.add(character)); });
            const consolidated = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                // Sort key = START of the merged range (earliest selected),
                // NOT "now" — stamping wall-clock time made the consolidated entry
                // leapfrog to the newest slot in both display and injection order.
                // The real merge time is preserved separately in consolidatedAt.
                // Uses the chronological bounds (not the designated base) so the
                // entry spans the full merged range even when the user pins a
                // non-earliest entry as the consolidation base.
                createdAt: currentEarliest.createdAt, consolidatedAt: new Date().toISOString(),
                worldDate: currentLatest.worldDate,
                anchor: currentLatest.anchor, fromIndex: currentEarliest.fromIndex ?? -1,
                toIndex: currentLatest.toIndex ?? -1, text: raw,
                characters: Array.from(allCharacters), consolidated: true, _consolidatedFrom: ids,
                // A partial newest entry (window ended mid-message) must keep
                // its cut marker through the merge, or the next generation
                // would anchor past the message's unseen remainder.
                ...(Number.isInteger(currentLatest.toCharOffset) && currentLatest.toCharOffset >= 0
                    ? { toCharOffset: currentLatest.toCharOffset } : {}),
            };
            const deletedBin = getChronicleData()._deletedBin || [];
            const originals = currentSnapshots.filter(entry => ids.includes(entry.id));
            // A merged entry must remain fully undoable even when its source
            // batch alone exceeds the ordinary trash retention limit.
            const remaining = currentSnapshots.filter(entry => !ids.includes(entry.id));
            const newSnapshots = [...remaining, consolidated];
            newSnapshots.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            const updatedBin = retainChronicleTrash([...deletedBin, ...originals], newSnapshots, MAX_TRASH_SIZE);
            const selectedForInjection = getInjectionSettings(getChronicleData()).selectedIds;
            const remappedSelection = [...new Set(selectedForInjection.map(id => ids.includes(id) ? consolidated.id : id))];
            const written = setChronicleDataChecked({ snapshots: newSnapshots, _deletedBin: updatedBin,
                selectedForInjection: remappedSelection, suggestSent: true });
            if (!written.ok) { scSetStatus('Consolidation could not be saved.', 'error'); return; }
            applyInjection();
            state.consolidateMode = false;
            state.checkedForMerge.clear();
            state.consolidateBaseId = null;
            state.selectedSnapshotId = consolidated.id;
            _render.renderContent();
            if (getSettings().syncWorldState) syncWorldStateFromSnapshot(consolidated, {
                source: 'consolidation',
                scope: scopeBefore,
                expectedRevision: worldStateRevision,
                baselineStatusSignature: worldStateBaseline,
                previousNewestRange: previousNewest
                    ? { from: previousNewest.fromIndex, to: previousNewest.toIndex }
                    : null,
            });
            scSetStatus(validation.valid ? 'Entries consolidated.' : `Entries consolidated — review needed: ${validation.reason}`, validation.valid ? 'success' : 'warning');
        } catch (err) {
            if (isCancellation(err) || !assertSameScope(scopeBefore).ok) return;
            scSetStatus(`Consolidation failed: ${err.message}`, 'error');
            notify('Session Chronicle', `Chronicle consolidation failed: ${err.message}`, 'error');
        } finally {
            if (assertSameScope(scopeBefore).ok) {
                state.isGenerating = false;
                document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
            }
        }
    });
}

// ─── Manual entry ────────────────────────────────────────────────────────────

export function createManualEntry() {
    const scene = getCurrentWorldStateScene();
    const worldDate = scene?.date
        ? `${scene.date.trim()}${scene.time ? ` ${scene.time.trim()}` : ''}`
        : new Date().toLocaleDateString();
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(), worldDate,
        anchor: getChronicleData().lastAnchor || null, fromIndex: -1, toIndex: -1,
        text: '## Summary\n- (write your entry here)\n\n## Relationship & Institutional Shifts\n\n## Open Loops Created\n\n## Open Loops Closed\n\n## Time Anchor\nIn-world date and time:\nLocation:',
        manual: true,
    };
    if (!setChronicleDataChecked({ snapshots: [...getSnapshots(), entry], suggestSent: false }).ok) {
        scSetStatus('New entry could not be saved.', 'error'); return null;
    }
    applyInjection();
    state.selectedSnapshotId = entry.id;
    _render.renderContent();
    scSetStatus('New blank entry created.', 'success');
    return entry;
}

// ─── Delete / Trash ──────────────────────────────────────────────────────────

export function deleteEntry(id) {
    const snapshots = getSnapshots();
    const idx = snapshots.findIndex(s => s.id === id);
    if (idx === -1) return;
    const removed = snapshots[idx];
    const remaining = snapshots.filter(s => s.id !== id);
    const deletedBin = getChronicleData()._deletedBin || [];
    const data = getChronicleData();
    const selectedIds = (data.selectedForInjection || []).filter(sid => sid !== id);
    const updatedBin = retainChronicleTrash([...deletedBin, removed], remaining, MAX_TRASH_SIZE);
    const lastAnchor = remaining.length > 0
        ? [...remaining].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).pop()?.anchor || null
        : null;
    if (!setChronicleDataChecked({ snapshots: remaining, _deletedBin: updatedBin, selectedForInjection: selectedIds, suggestSent: false, lastAnchor }).ok) {
        scSetStatus('Entry could not be deleted.', 'error'); return;
    }
    applyInjection();
    state.selectedSnapshotId = null;
    _render.renderContent();
    scSetStatus('Entry moved to trash.', 'success');
}

export function bulkDeleteEntries(ids) {
    if (!ids?.length) return;
    const snapshots = getSnapshots();
    const toRemove = snapshots.filter(s => ids.includes(s.id));
    const remaining = snapshots.filter(s => !ids.includes(s.id));
    const deletedBin = getChronicleData()._deletedBin || [];
    const updatedBin = retainChronicleTrash([...deletedBin, ...toRemove], remaining, MAX_TRASH_SIZE);
    const data = getChronicleData();
    const idSet = new Set(ids);
    const selectedIds = (data.selectedForInjection || []).filter(sid => !idSet.has(sid));
    const lastAnchor = remaining.length > 0
        ? [...remaining].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).pop()?.anchor || null
        : null;
    if (!setChronicleDataChecked({ snapshots: remaining, _deletedBin: updatedBin, selectedForInjection: selectedIds, suggestSent: false, lastAnchor }).ok) {
        scSetStatus('Entries could not be deleted.', 'error'); return;
    }
    applyInjection();
    state.bulkDeleteMode = false;
    state.consolidateMode = false;
    state.checkedForMerge.clear();
    state.selectedSnapshotId = null;
    _render.renderContent();
    scSetStatus(`${toRemove.length} entries moved to trash.`, 'success');
}

export function restoreDeletedEntry(entry) {
    const snapshots = [...(getChronicleData().snapshots || []), entry];
    snapshots.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const updatedBin = (getChronicleData()._deletedBin || []).filter(e => e.id !== entry.id);
    const lastAnchor = snapshots.length > 0
        ? snapshots[snapshots.length - 1]?.anchor || null
        : null;
    if (!setChronicleDataChecked({ snapshots, _deletedBin: updatedBin, suggestSent: false, lastAnchor }).ok) {
        scSetStatus('Entry could not be restored.', 'error'); return;
    }
    applyInjection();
    state.selectedSnapshotId = entry.id;
    _render.renderContent();
    scSetStatus('Entry restored.', 'success');
}