/**
 * chronicle/snapshots.js — Generation, validation, CRUD, and world state sync.
 *
 * Handles creating, regenerating, consolidating, deleting, and restoring
 * chronicle entries.
 */

import {
    getContextSafe, getChat, getChatMeta,
    resolveApiCall, normaliseOutput,
    notify,
    getCurrentWorldState,
    WORLD_STATE_METADATA_KEY,
    patchChatMeta,
} from '../core/index.js';

import { applyWorldStateInjection } from '../world_state/index.js';

import { CHRONICLE_SYSTEM_PROMPT, CONSOLIDATE_SYSTEM_PROMPT } from './prompts.js';

import {
    state, MAX_ENTRY_WORD_COUNT, MAX_TRASH_SIZE,
    getSettings,
    getChronicleData, setChronicleData, getSnapshots,
    getCharactersInRange, scSetStatus, getContentEl,
    makeAnchor, resolveAnchor, buildMessageWindow,
    persistMsgSinceSnapshot,
    _render,
} from './data.js';

import { applyInjection } from './injection.js';

// ─── World State sync ────────────────────────────────────────────────────────

function updateWorldStateFromChronicle(text) {
    const meta = getChatMeta();
    if (!meta) return;
    const timeMatch = text.match(/## Time Anchor[\s\S]*?In-world date and time[:\s]*([^\n]+)/i);
    const locMatch = text.match(/## Time Anchor[\s\S]*?Location[:\s]*([^\n]+)/i);
    if (!timeMatch && !locMatch) return;
    const currentWs = meta[WORLD_STATE_METADATA_KEY]?.text || '';
    let newWs = currentWs;
    if (timeMatch) {
        const inferred = timeMatch[1].trim();
        const dateMatch = inferred.match(/(.+?),\s*(.+)/) || inferred.match(/(.+)/);
        if (dateMatch) {
            const datePart = dateMatch.length > 2 ? dateMatch[1].trim() : dateMatch[1].trim();
            const timePart = dateMatch.length > 2 ? dateMatch[2].trim() : '';
            newWs = newWs.replace(/^Date:\s*.*$/m, `Date: ${datePart}`);
            if (timePart && /\d/.test(timePart)) {
                if (/^Time:/m.test(newWs)) newWs = newWs.replace(/^Time:\s*.*$/m, `Time: ${timePart}`);
                else if (/^Date:/m.test(newWs)) newWs = newWs.replace(/^(Date:.*)$/m, `$1\nTime: ${timePart}`);
            }
        }
    }
    if (locMatch) {
        const loc = locMatch[1].trim();
        if (/^Location:/m.test(newWs)) newWs = newWs.replace(/^Location:\s*.*$/m, `Location: ${loc}`);
        else newWs += `\nLocation: ${loc}`;
    }
    if (newWs !== currentWs) {
        patchChatMeta(WORLD_STATE_METADATA_KEY, { text: newWs });
        // Re-trigger world state injection so the prompt stays in sync
        try { applyWorldStateInjection(); } catch (_) { /* module may not be loaded yet */ }
    }
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
    const maxAllowed = Math.max(baseEntry.text.split(/\s+/).length + deltaEntries.reduce((s, e) => s + e.text.split(/\s+/).length, 0), 600);
    if (text.split(/\s+/).length > maxAllowed * 1.5) return { valid: false, reason: 'Consolidated entry too long.' };
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

// ─── Generate snapshot ───────────────────────────────────────────────────────

export async function generateSnapshot() {
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
    const { index } = resolveAnchor(getChronicleData().lastAnchor);
    const actualFrom = Math.max(0, index);
    if (actualFrom >= chat.length) { scSetStatus('No new messages to chronicle.', 'error'); return null; }
    const { text, lastMsg, toIndex } = buildMessageWindow(actualFrom, undefined);
    if (!text.trim()) { scSetStatus('No filterable messages to chronicle.', 'error'); return null; }

    // Capture chat identity before async API call to detect mid-generation chat switches
    const ctxBefore = getContextSafe();
    const chatKeyBefore = `${ctxBefore?.characterId ?? ''}|${ctxBefore?.groupId ?? ''}|${ctxBefore?.chatId ?? ''}`;

    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    scSetStatus('Generating chronicle entry…', 'info');
    notify('Session Chronicle', 'Generating chronicle entry…', 'info');
    const worldState = getCurrentWorldState().trim();
    const wsDateMatch = worldState.match(/^Date:\s*(.+)$/m);
    const wsTimeMatch = worldState.match(/^Time:\s*(.+)$/m);
    const worldDate = wsDateMatch ? `${wsDateMatch[1].trim()}${wsTimeMatch ? ' ' + wsTimeMatch[1].trim() : ''}` : new Date().toLocaleDateString();
    const userContent = worldState ? `Current World State:\n${worldState}\n\nMessages to chronicle:\n${text}` : `Messages to chronicle:\n${text}`;

    try {
        const _scApi1 = resolveApiCall({ moduleSettings: getSettings() });
        let raw = await _scApi1.fetchFn({ systemPrompt: CHRONICLE_SYSTEM_PROMPT, userContent, settings: _scApi1.settings, retries: 3 });
        raw = normaliseOutput(raw);
        raw = stripToEntry(raw);
        if (!raw.trim()) {
            const _scApi1b = resolveApiCall({ moduleSettings: getSettings() });
            raw = await _scApi1b.fetchFn({ systemPrompt: CHRONICLE_SYSTEM_PROMPT, userContent: userContent + '\n\n[REMINDER: Your last response was empty. Produce the chronicle entry as specified.]', settings: _scApi1b.settings, retries: 3 });
            raw = normaliseOutput(raw);
            raw = stripToEntry(raw);
        }
        if (!raw.trim()) throw new Error('Chronicle output was empty.');

        const validation = validateSnapshotOutput(raw);
        if (!validation.valid) { console.warn('[MWT:Chronicle] Validation:', validation.reason); scSetStatus(`May need review: ${validation.reason}`, 'error'); }

        // If the user switched chat/character mid-generation, the result belongs to
        // the *previous* chat — saving now would write it into the wrong chat's data.
        const ctxAfter = getContextSafe();
        const chatKeyAfter = `${ctxAfter?.characterId ?? ''}|${ctxAfter?.groupId ?? ''}|${ctxAfter?.chatId ?? ''}`;
        if (chatKeyAfter !== chatKeyBefore) {
            console.warn('[MWT:Chronicle] Chat/character switched during generation — discarding result to avoid cross-chat contamination.');
            scSetStatus('Chat changed during generation — result discarded.', 'warning');
            return null;
        }

        const newAnchor = makeAnchor(lastMsg || chat[chat.length - 1]);
        const characters = getCharactersInRange(actualFrom, toIndex);
        const snapshot = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(), worldDate, anchor: newAnchor,
            fromIndex: actualFrom, toIndex: typeof toIndex === 'number' ? toIndex : actualFrom,
            text: raw, characters, note: '',
        };
        const snapshots = [...getSnapshots(), snapshot];
        setChronicleData({ snapshots, lastAnchor: newAnchor, suggestSent: true, anchorStale: false });
        applyInjection();
        state.msgSinceSnapshot = 0;
        persistMsgSinceSnapshot();
        state.selectedSnapshotId = snapshot.id;
        // Only update the UI when the Chronicle tab is actually visible —
        // auto-snapshot can fire while the modal is closed, in which case
        // there's nothing to render (and renderContent() would be a no-op).
        if (getContentEl()) _render.renderContent();
        if (getSettings().syncWorldState) updateWorldStateFromChronicle(raw);
        scSetStatus('Chronicle entry generated.', 'success');
        return snapshot;
    } catch (err) {
        console.error('[MWT:Chronicle] Generate error:', err);
        scSetStatus(`Generation failed: ${err.message}`, 'error');
        notify('Session Chronicle', `Chronicle generation failed: ${err.message}`, 'error');
        return null;
    } finally {
        state.isGenerating = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    }
}

// ─── Regenerate snapshot ─────────────────────────────────────────────────────

export async function regenerateSnapshot(snapshotId) {
    if (state.isGenerating || state.isMainGenerating) { scSetStatus('Wait for current generation to finish.', 'error'); return; }
    const snapshots = getSnapshots();
    const idx = snapshots.findIndex(s => s.id === snapshotId);
    if (idx === -1) return;
    const snapshot = snapshots[idx];
    const originalText = snapshot.text;
    state.isGenerating = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    scSetStatus('Regenerating…', 'info');
    const chat = getChat();
    const from = snapshot.fromIndex ?? 0;
    const to = snapshot.toIndex !== undefined && snapshot.toIndex > from ? snapshot.toIndex : Math.min(from + 200, chat.length - 1);
    const { text } = buildMessageWindow(from, to);
    if (!text.trim()) {
        scSetStatus('No messages for regeneration.', 'error');
        state.isGenerating = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        return;
    }
    const worldState = getCurrentWorldState().trim();
    const userContent = worldState ? `Current World State:\n${worldState}\n\nMessages to chronicle:\n${text}` : `Messages to chronicle:\n${text}`;

    try {
        const _scApi2 = resolveApiCall({ moduleSettings: getSettings() });
        let raw = await _scApi2.fetchFn({ systemPrompt: CHRONICLE_SYSTEM_PROMPT, userContent, settings: _scApi2.settings, retries: 3 });
        raw = normaliseOutput(raw);
        if (!raw.trim()) throw new Error('Empty output.');
        const timeMatch = raw.match(/## Time Anchor[\s\S]*?In-world date and time[:\s]*([^\n]+)/i);
        const newWorldDate = timeMatch ? timeMatch[1].trim() : snapshot.worldDate;
        _render.showRegenerateDiff(originalText, raw, async (acceptNew) => {
            if (acceptNew) {
                const updated = [...snapshots];
                updated[idx] = { ...snapshot, text: raw, worldDate: newWorldDate };
                setChronicleData({ snapshots: updated });
                applyInjection();
                state.selectedSnapshotId = snapshot.id;
                _render.renderContent();
                if (getSettings().syncWorldState) updateWorldStateFromChronicle(raw);
                scSetStatus('Entry regenerated.', 'success');
            } else {
                scSetStatus('Kept original.', 'info');
                state.selectedSnapshotId = snapshot.id;
                _render.renderContent();
            }
            state.isGenerating = false;
            document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        });
    } catch (err) {
        scSetStatus(`Regeneration failed: ${err.message}`, 'error');
        notify('Session Chronicle', `Chronicle regeneration failed: ${err.message}`, 'error');
        state.isGenerating = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    }
}

// ─── Consolidate entries ─────────────────────────────────────────────────────

export async function consolidateEntries(ids, baseId = null) {
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
    const baseSection = `=== BASE ENTRY (designated) ===\n${base.text}`;
    const deltaSections = deltas.map((d, i) => `=== DELTA ${i + 1} (later) ===\n${d.text}`).join('\n\n');
    const userContent = `${baseSection}\n\n${deltaSections}`;

    // Chronological bounds for metadata, computed from the FULL selected range
    // regardless of which entry was designated as the base.  The base choice
    // only affects how the model treats the entries (which is the foundation);
    // the resulting entry's timestamps/index must still span every entry that
    // was merged, so display order, injection order, and re-snapshot ranges
    // stay correct even when the user pins a non-earliest entry as the base.
    const chronological = [...selected].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const earliest = chronological[0];
    const latest = chronological[chronological.length - 1];

    // Pass entries to the preview in base-first order so the preview's
    // index-0-is-BASE labelling matches the actual consolidation intent.
    const previewEntries = [base, ...deltas];
    _render.showConsolidationPreview(previewEntries, userContent, async (editedResult) => {
        if (state.isGenerating) return;
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
            const allCharacters = new Set();
            selected.forEach(s => { if (s.characters) s.characters.forEach(c => allCharacters.add(c)); });
            const consolidated = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                // Sort key = START of the merged range (earliest selected),
                // NOT "now" — stamping wall-clock time made the consolidated entry
                // leapfrog to the newest slot in both display and injection order.
                // The real merge time is preserved separately in consolidatedAt.
                // Uses the chronological bounds (not the designated base) so the
                // entry spans the full merged range even when the user pins a
                // non-earliest entry as the consolidation base.
                createdAt: earliest.createdAt, consolidatedAt: new Date().toISOString(),
                worldDate: latest.worldDate,
                anchor: latest.anchor, fromIndex: earliest.fromIndex ?? -1,
                toIndex: latest.toIndex ?? -1, text: raw,
                characters: Array.from(allCharacters), consolidated: true, _consolidatedFrom: ids,
            };
            const deletedBin = getChronicleData()._deletedBin || [];
            const originals = snapshots.filter(s => ids.includes(s.id));
            const updatedBin = [...deletedBin, ...originals].slice(-MAX_TRASH_SIZE);
            const remaining = snapshots.filter(s => !ids.includes(s.id));
            const newSnapshots = [...remaining, consolidated];
            newSnapshots.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            setChronicleData({ snapshots: newSnapshots, _deletedBin: updatedBin, suggestSent: true });
            applyInjection();
            state.consolidateMode = false;
            state.checkedForMerge.clear();
            state.consolidateBaseId = null;
            state.selectedSnapshotId = consolidated.id;
            _render.renderContent();
            if (getSettings().syncWorldState) updateWorldStateFromChronicle(raw);
            scSetStatus('Entries consolidated.', 'success');
        } catch (err) {
            scSetStatus(`Consolidation failed: ${err.message}`, 'error');
            notify('Session Chronicle', `Chronicle consolidation failed: ${err.message}`, 'error');
        } finally {
            state.isGenerating = false;
            document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        }
    });
}

// ─── Manual entry ────────────────────────────────────────────────────────────

export function createManualEntry() {
    const worldState = getCurrentWorldState().trim();
    const wsDateMatch = worldState.match(/^Date:\s*(.+)$/m);
    const wsTimeMatch = worldState.match(/^Time:\s*(.+)$/m);
    const worldDate = wsDateMatch ? `${wsDateMatch[1].trim()}${wsTimeMatch ? ' ' + wsTimeMatch[1].trim() : ''}` : new Date().toLocaleDateString();
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(), worldDate,
        anchor: getChronicleData().lastAnchor || null, fromIndex: -1, toIndex: -1,
        text: '## Summary\n- (write your entry here)\n\n## Relationship & Institutional Shifts\n\n## Open Loops Created\n\n## Open Loops Closed\n\n## Time Anchor\nIn-world date and time:\nLocation:',
        manual: true,
    };
    setChronicleData({ snapshots: [...getSnapshots(), entry], suggestSent: false });
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
    const updatedBin = [...deletedBin, removed].slice(-MAX_TRASH_SIZE);
    const lastAnchor = remaining.length > 0
        ? [...remaining].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).pop()?.anchor || null
        : null;
    setChronicleData({ snapshots: remaining, _deletedBin: updatedBin, selectedForInjection: selectedIds, suggestSent: false, lastAnchor });
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
    const updatedBin = [...deletedBin, ...toRemove].slice(-MAX_TRASH_SIZE);
    const data = getChronicleData();
    const idSet = new Set(ids);
    const selectedIds = (data.selectedForInjection || []).filter(sid => !idSet.has(sid));
    const lastAnchor = remaining.length > 0
        ? [...remaining].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).pop()?.anchor || null
        : null;
    setChronicleData({ snapshots: remaining, _deletedBin: updatedBin, selectedForInjection: selectedIds, suggestSent: false, lastAnchor });
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
    setChronicleData({ snapshots, _deletedBin: updatedBin, suggestSent: false, lastAnchor });
    applyInjection();
    state.selectedSnapshotId = entry.id;
    _render.renderContent();
    scSetStatus('Entry restored.', 'success');
}