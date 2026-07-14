/**
 * interiority/render.js — Settings UI, ledger display, and per-message
 * thought display.
 *
 * Renders into the Interiority tab content area and into message DOM
 * (never into msg.mes — thoughts are display-only, rendered from
 * perMessage metadata on top of the message element).
 */

import { escapeHtml } from '../core/index.js';
import {
    renderApiSettingsFields, readApiSettingsValues,
} from '../core/index.js';

import {
    state, getSettings, saveSettings,
    getInteriorityData, getLedger, getPerMessage, getPerMessageKeys,
    getMsgKeyForIndex, buildKeyToIndexMap,
    removeLedgerEntries, setLedger, updateLedgerEntry,
    addManualLedgerEntry, hasDuplicateIntention,
} from './data.js';

// ─── Main render ─────────────────────────────────────────────────────────────

/**
 * Render the Interiority tab content.
 * Shows: settings panel toggle, current ledger, and recent thoughts.
 */
export function renderContent() {
    const el = getContentEl();
    if (!el) return;

    const data = getInteriorityData();
    const ledger = getLedger();
    const msgKeys = getPerMessageKeys();

    el.innerHTML = `
        <div class="mwt-interiority-tab">
            <div class="mwt-flex mwt-gap-4" style="margin-bottom:12px;flex-wrap:wrap">
                <button id="mwt-int-show-settings" class="mwt-btn">⚙ Settings</button>
                <button id="mwt-int-generate" class="mwt-btn mwt-btn-primary">💭 Generate Now</button>
                <button id="mwt-int-clear-ledger" class="mwt-btn" title="Remove all ledger entries">🗑 Clear Ledger</button>
            </div>
            <div id="mwt-int-status" class="mwt-int-status"></div>

            <div id="mwt-int-settings-panel" style="display:none;margin-bottom:16px"></div>

            <h3>📋 Intentions Ledger (${ledger.length})</h3>
            <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:8px">
                Persistent NPC intentions injected into the narrator prompt. These are hidden plans that surface only as NPC actions when their trigger condition is met. Click ✎ to edit an intention if the story changes its context.
            </p>
            <div id="mwt-int-ledger-list" class="mwt-int-ledger-list">
                ${renderLedgerList(ledger)}
            </div>
            <div id="mwt-int-add-form-container" style="margin-top:8px"></div>
            <button id="mwt-int-add-btn" class="mwt-btn" style="margin-top:8px">➕ Add Intention</button>

            <hr style="border-color:var(--mwt-border);margin:16px 0">

            <h3>💭 Recent Thoughts</h3>
            <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:8px">
                Display-only NPC reactions from recent turns. These are never injected into the narrator prompt.
            </p>
            <div id="mwt-int-thoughts-list" class="mwt-int-thoughts-list">
                ${renderThoughtsList(msgKeys)}
            </div>
        </div>
    `;

    wireEvents(el);
}

/**
 * Render the ledger list HTML.
 */
function renderLedgerList(ledger) {
    if (!ledger || ledger.length === 0) {
        return '<p style="color:var(--mwt-text-dim);font-size:12px">No active intentions.</p>';
    }
    return ledger.map((entry) => `
        <div class="mwt-int-ledger-entry${entry.manual ? ' mwt-int-ledger-entry--manual' : ''}" data-id="${escapeHtml(entry.id)}">
            <div class="mwt-int-ledger-entry-main">
                <span class="mwt-int-ledger-npc">${escapeHtml(entry.npc)}</span>
                <span class="mwt-int-arrow">→</span>
                <span class="mwt-int-ledger-action">${escapeHtml(entry.action)}</span>
                <span class="mwt-int-arrow">→</span>
                <span class="mwt-int-ledger-trigger">${escapeHtml(entry.trigger)}</span>
                ${entry.manual ? '<span class="mwt-int-manual-badge" title="User-authored intention">✋</span>' : ''}
            </div>
            <div class="mwt-int-ledger-meta">
                ${entry.since ? `<span style="color:var(--mwt-text-dim)">since ${escapeHtml(entry.since)}</span>` : ''}
                ${entry.turnsOpen != null ? `<span style="color:var(--mwt-text-dim);font-size:11px" title="Turns this intention has survived">${entry.turnsOpen} turn${entry.turnsOpen === 1 ? '' : 's'}</span>` : ''}
                <button class="mwt-int-edit-btn mwt-btn mwt-btn-sm" data-id="${escapeHtml(entry.id)}" title="Edit this intention">✎</button>
                <button class="mwt-int-remove-btn mwt-btn mwt-btn-sm" data-id="${escapeHtml(entry.id)}" title="Remove this intention">✕</button>
            </div>
        </div>
    `).join('');
}

/**
 * Render the recent thoughts list HTML.
 *
 * @param {string[]} msgKeys - stable perMessage keys (sd-* format)
 */
function renderThoughtsList(msgKeys) {
    if (!msgKeys || msgKeys.length === 0) {
        return '<p style="color:var(--mwt-text-dim);font-size:12px">No thoughts generated yet.</p>';
    }

    // Build a key→index map so we can display the current message number.
    // After Inline Summary shrinks the chat, the index may differ from when
    // the thought was generated — but it correctly points to where the
    // message lives *now*.
    const keyToIndex = buildKeyToIndexMap();

    const shown = msgKeys.slice(0, 20); // Show last 20
    const parts = [];
    for (const key of shown) {
        const pm = getPerMessage(key);
        if (!pm || !pm.reactions || pm.reactions.length === 0) continue;
        const currentIdx = keyToIndex.get(key);
        const msgLabel = currentIdx != null ? `msg #${currentIdx}` : '';
        for (const r of pm.reactions) {
            parts.push(`
                <div class="mwt-int-thought-entry">
                    <div class="mwt-int-thought-header">
                        <span class="mwt-int-thought-npc">${escapeHtml(r.npc)}</span>
                        ${msgLabel ? `<span class="mwt-int-thought-msg">${msgLabel}</span>` : ''}
                    </div>
                    <div class="mwt-int-thought-re">${escapeHtml(r.re)}</div>
                    <div class="mwt-int-thought-text">"${escapeHtml(r.thought)}"</div>
                </div>
            `);
        }
    }
    return parts.length > 0 ? parts.join('') : '<p style="color:var(--mwt-text-dim);font-size:12px">No thoughts generated yet.</p>';
}

// ─── Settings panel ──────────────────────────────────────────────────────────

/**
 * Render the settings panel inside the Interiority tab.
 */
export function renderSettingsPanel() {
    const panel = getContentEl()?.querySelector('#mwt-int-settings-panel');
    if (!panel) return;

    const s = getSettings();
    const apiFieldOpts = {
        urlId: 'mwt-int-api-url', keyId: 'mwt-int-api-key', modelId: 'mwt-int-model',
        maxTokensId: 'mwt-int-max-tokens', tempId: 'mwt-int-temp', topPId: 'mwt-int-top-p',
        freqId: 'mwt-int-freq-pen', presId: 'mwt-int-pres-pen', headersId: 'mwt-int-headers',
        maxTokensDefault: 1500, tempDefault: 0.4,
    };

    panel.innerHTML = `
        <div class="mwt-settings-form">
            <h3>Interiority Settings</h3>
            <div class="mwt-settings-grid">
                ${renderApiSettingsFields(s, apiFieldOpts)}
            </div>

            <div style="margin-top:12px">
                <label><input type="checkbox" id="mwt-int-auto-mode" ${s.autoMode ? 'checked' : ''}> Auto-generate on each AI message</label>
                <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">When ON, thoughts are generated automatically when an AI message lands. When OFF, use the 💭 Generate button per message.</p>
            </div>

            <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
                <label><input type="checkbox" id="mwt-int-gen-thoughts" ${s.generateThoughts !== false ? 'checked' : ''}> Generate thoughts (private NPC reactions)</label>
                <label><input type="checkbox" id="mwt-int-gen-intentions" ${s.generateIntentions !== false ? 'checked' : ''}> Generate intentions (persistent NPC plans injected into the narrator prompt)</label>
                <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">Toggle either feature off if you only want one. When both are off, no API call is made.</p>
            </div>

            <div style="margin-top:12px">
                <label>Mode</label>
                <select id="mwt-int-mode" class="mwt-input">
                    <option value="batched" ${s.mode !== 'strict' ? 'selected' : ''}>Batched (one call/turn — recommended)</option>
                    <option value="strict" ${s.mode === 'strict' ? 'selected' : ''}>Strict (one call per NPC — true partition at N× cost)</option>
                </select>
                <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">Batched mode makes one API call per turn containing all NPCs. Strict mode makes one call per NPC for true information partition.</p>
            </div>

            <div style="margin-top:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                <label style="font-size:12px;color:var(--mwt-text-dim)">Max NPCs <input type="number" id="mwt-int-max-npcs" class="mwt-input" style="width:60px;display:inline-block" value="${s.maxNpcs || 4}" min="1" max="20"></label>
                <label style="font-size:12px;color:var(--mwt-text-dim)">Message Window <input type="number" id="mwt-int-window" class="mwt-input" style="width:60px;display:inline-block" value="${s.messageWindow || 8}" min="1" max="50"></label>
                <label style="font-size:12px;color:var(--mwt-text-dim)" title="Minimum turns an intention must survive before it can be executed or dropped. Prevents models from erasing intentions too quickly.">Grace Period <input type="number" id="mwt-int-grace" class="mwt-input" style="width:60px;display:inline-block" value="${s.intentionGracePeriod ?? 2}" min="0" max="20"></label>
            </div>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">Grace Period: minimum turns an intention must survive before it can be executed or dropped. Higher values make intentions more persistent. Set to 0 to disable.</p>

            <div class="mwt-flex mwt-gap-4" style="margin-top:12px">
                <button id="mwt-int-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button>
            </div>
        </div>
    `;

    panel.querySelector('#mwt-int-save-settings')?.addEventListener('click', () => {
        const apiValues = readApiSettingsValues(panel, apiFieldOpts);
        saveSettings({
            ...apiValues,
            autoMode: panel.querySelector('#mwt-int-auto-mode')?.checked ?? true,
            generateThoughts: panel.querySelector('#mwt-int-gen-thoughts')?.checked ?? true,
            generateIntentions: panel.querySelector('#mwt-int-gen-intentions')?.checked ?? true,
            mode: panel.querySelector('#mwt-int-mode')?.value || 'batched',
            maxNpcs: Number(panel.querySelector('#mwt-int-max-npcs')?.value) || 4,
            messageWindow: Number(panel.querySelector('#mwt-int-window')?.value) || 8,
            intentionGracePeriod: Math.max(0, Number(panel.querySelector('#mwt-int-grace')?.value) || 0),
        });
        setIntStatus('Settings saved.', 'success');
        renderContent();
    });
}

// ─── Event wiring ────────────────────────────────────────────────────────────

function wireEvents(el) {
    // Settings toggle
    el.querySelector('#mwt-int-show-settings')?.addEventListener('click', () => {
        const panel = el.querySelector('#mwt-int-settings-panel');
        if (panel) {
            const isHidden = panel.style.display === 'none';
            panel.style.display = isHidden ? 'block' : 'none';
            if (isHidden) renderSettingsPanel();
        }
    });

    // Generate now button
    el.querySelector('#mwt-int-generate')?.addEventListener('click', async () => {
        setIntStatus('Generating...', 'info');
        try {
            // Delegate to index.js via custom event
            document.dispatchEvent(new CustomEvent('mwt:interiority-generate', { detail: { manual: true } }));
        } catch (err) {
            setIntStatus(`Error: ${err.message}`, 'error');
        }
    });

    // Clear the "Generating..." status once the generation finishes.
    // The generation path dispatches mwt:busy-changed when isGenerating flips
    // false; we update the status pill so it doesn't read "Generating..." forever.
    if (!state._busyListenerWired) {
        state._busyListenerWired = true;
        document.addEventListener('mwt:busy-changed', () => {
            if (!state.isGenerating) {
                // Only clear if the status element still shows "Generating..."
                const statusEl = getContentEl()?.querySelector('#mwt-int-status');
                if (statusEl && statusEl.textContent === 'Generating...') {
                    setIntStatus('Ready.', 'info');
                }
            }
        });
    }

    // Clear ledger button
    el.querySelector('#mwt-int-clear-ledger')?.addEventListener('click', () => {
        if (!confirm('Remove all ledger entries? This cannot be undone.')) return;
        setLedger([]);
        renderContent();
        document.dispatchEvent(new CustomEvent('mwt:interiority-ledger-changed'));
    });

    // Add intention button — show inline add form
    el.querySelector('#mwt-int-add-btn')?.addEventListener('click', () => {
        showInlineAddForm();
    });

    // Add form container event delegation (save / cancel)
    el.querySelector('#mwt-int-add-form-container')?.addEventListener('click', (e) => {
        const saveBtn = e.target.closest('.mwt-int-add-save-btn');
        if (saveBtn) {
            handleInlineAddSave();
            return;
        }
        const cancelBtn = e.target.closest('.mwt-int-add-cancel-btn');
        if (cancelBtn) {
            cancelInlineAdd();
            return;
        }
    });

    // Per-entry edit and remove buttons (event delegation)
    el.querySelector('#mwt-int-ledger-list')?.addEventListener('click', (e) => {
        // Remove button
        const removeBtn = e.target.closest('.mwt-int-remove-btn');
        if (removeBtn) {
            const id = removeBtn.dataset.id;
            if (id) {
                removeLedgerEntries([id]);
                renderContent();
                document.dispatchEvent(new CustomEvent('mwt:interiority-ledger-changed'));
            }
            return;
        }

        // Edit button — transform the entry into an inline edit form
        const editBtn = e.target.closest('.mwt-int-edit-btn');
        if (editBtn) {
            const id = editBtn.dataset.id;
            if (id) {
                showInlineEditForm(id);
            }
            return;
        }

        // Save button (inside inline edit form)
        const saveBtn = e.target.closest('.mwt-int-edit-save-btn');
        if (saveBtn) {
            const id = saveBtn.dataset.id;
            if (id) {
                handleInlineEditSave(id);
            }
            return;
        }

        // Cancel button (inside inline edit form)
        const cancelBtn = e.target.closest('.mwt-int-edit-cancel-btn');
        if (cancelBtn) {
            const id = cancelBtn.dataset.id;
            if (id) {
                cancelInlineEdit(id);
            }
            return;
        }
    });
}

// ─── Inline edit form ────────────────────────────────────────────────────────

/**
 * Transform a ledger entry's display into an inline edit form.
 * Replaces the entry-main + entry-meta with editable inputs.
 * @param {string} id - ledger entry id
 */
function showInlineEditForm(id) {
    const listEl = getContentEl()?.querySelector('#mwt-int-ledger-list');
    if (!listEl) return;

    const entryEl = listEl.querySelector(`.mwt-int-ledger-entry[data-id="${CSS.escape(id)}"]`);
    if (!entryEl) return;

    const ledger = getLedger();
    const entry = ledger.find(e => e.id === id);
    if (!entry) return;

    entryEl.classList.add('mwt-int-ledger-entry--editing');
    entryEl.innerHTML = `
        <div class="mwt-int-edit-form">
            <div class="mwt-int-edit-row">
                <label class="mwt-label">NPC</label>
                <input type="text" class="mwt-input mwt-int-edit-npc" value="${escapeHtml(entry.npc)}" placeholder="NPC name">
            </div>
            <div class="mwt-int-edit-row">
                <label class="mwt-label">Action</label>
                <input type="text" class="mwt-input mwt-int-edit-action" value="${escapeHtml(entry.action)}" placeholder="What the NPC plans to do">
            </div>
            <div class="mwt-int-edit-row">
                <label class="mwt-label">Trigger</label>
                <input type="text" class="mwt-input mwt-int-edit-trigger" value="${escapeHtml(entry.trigger)}" placeholder="When/where the NPC will act">
            </div>
            <div class="mwt-int-edit-actions">
                <button class="mwt-btn mwt-btn-primary mwt-int-edit-save-btn" data-id="${escapeHtml(entry.id)}">💾 Save</button>
                <button class="mwt-btn mwt-int-edit-cancel-btn" data-id="${escapeHtml(entry.id)}">✕ Cancel</button>
            </div>
        </div>
    `;

    // Focus the action field (most commonly edited) and select its text
    const actionInput = entryEl.querySelector('.mwt-int-edit-action');
    if (actionInput) {
        actionInput.focus();
        actionInput.select();
    }

    // Keyboard shortcuts: Enter to save, Escape to cancel
    entryEl.querySelectorAll('.mwt-int-edit-npc, .mwt-int-edit-action, .mwt-int-edit-trigger').forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleInlineEditSave(id);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelInlineEdit(id);
            }
        });
    });
}

/**
 * Handle Save from the inline edit form.
 * Reads the input values, validates, updates the ledger entry, and re-renders.
 * @param {string} id - ledger entry id
 */
function handleInlineEditSave(id) {
    const listEl = getContentEl()?.querySelector('#mwt-int-ledger-list');
    if (!listEl) return;

    const entryEl = listEl.querySelector(`.mwt-int-ledger-entry[data-id="${CSS.escape(id)}"]`);
    if (!entryEl) return;

    const npc = entryEl.querySelector('.mwt-int-edit-npc')?.value?.trim() || '';
    const action = entryEl.querySelector('.mwt-int-edit-action')?.value?.trim() || '';
    const trigger = entryEl.querySelector('.mwt-int-edit-trigger')?.value?.trim() || '';

    if (!npc || !action || !trigger) {
        setIntStatus('NPC, Action, and Trigger are all required.', 'error');
        return;
    }

    updateLedgerEntry(id, { npc, action, trigger });
    setIntStatus('Intention updated.', 'success');
    renderContent();
    document.dispatchEvent(new CustomEvent('mwt:interiority-ledger-changed'));
}

/**
 * Cancel the inline edit — re-render to restore the display view.
 * @param {string} id - ledger entry id
 */
function cancelInlineEdit(id) {
    renderContent();
}

// ─── Inline add form (user-authored intentions) ──────────────────────────────

/**
 * Show the inline add form below the ledger list.
 * Hides the "Add Intention" button while the form is open.
 */
function showInlineAddForm() {
    const container = getContentEl()?.querySelector('#mwt-int-add-form-container');
    const addBtn = getContentEl()?.querySelector('#mwt-int-add-btn');
    if (!container) return;

    if (addBtn) addBtn.style.display = 'none';

    container.innerHTML = `
        <div class="mwt-int-ledger-entry mwt-int-ledger-entry--editing">
            <div class="mwt-int-edit-form">
                <div class="mwt-int-edit-row">
                    <label class="mwt-label">NPC</label>
                    <input type="text" class="mwt-input mwt-int-add-npc" placeholder="NPC name">
                </div>
                <div class="mwt-int-edit-row">
                    <label class="mwt-label">Action</label>
                    <input type="text" class="mwt-input mwt-int-add-action" placeholder="What the NPC plans to do">
                </div>
                <div class="mwt-int-edit-row">
                    <label class="mwt-label">Trigger</label>
                    <input type="text" class="mwt-input mwt-int-add-trigger" placeholder="When/where the NPC will act">
                </div>
                <div class="mwt-int-edit-actions">
                    <button class="mwt-btn mwt-btn-primary mwt-int-add-save-btn">💾 Add</button>
                    <button class="mwt-btn mwt-int-add-cancel-btn">✕ Cancel</button>
                </div>
            </div>
        </div>
    `;

    // Focus the NPC field first
    const npcInput = container.querySelector('.mwt-int-add-npc');
    if (npcInput) npcInput.focus();

    // Keyboard shortcuts: Enter to save, Escape to cancel
    container.querySelectorAll('.mwt-int-add-npc, .mwt-int-add-action, .mwt-int-add-trigger').forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleInlineAddSave();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelInlineAdd();
            }
        });
    });
}

/**
 * Handle Save from the inline add form.
 * Reads the input values, validates, adds a manual ledger entry, and re-renders.
 */
function handleInlineAddSave() {
    const container = getContentEl()?.querySelector('#mwt-int-add-form-container');
    if (!container) return;

    const npc = container.querySelector('.mwt-int-add-npc')?.value?.trim() || '';
    const action = container.querySelector('.mwt-int-add-action')?.value?.trim() || '';
    const trigger = container.querySelector('.mwt-int-add-trigger')?.value?.trim() || '';

    if (!npc || !action || !trigger) {
        setIntStatus('NPC, Action, and Trigger are all required.', 'error');
        return;
    }

    // Dedup check — same as engine-generated entries
    if (hasDuplicateIntention(npc, action, trigger)) {
        setIntStatus('An identical intention already exists in the ledger.', 'error');
        return;
    }

    addManualLedgerEntry({ npc, action, trigger });
    setIntStatus('Manual intention added.', 'success');
    renderContent();
    document.dispatchEvent(new CustomEvent('mwt:interiority-ledger-changed'));
}

/**
 * Cancel the inline add form — re-render to restore the button.
 */
function cancelInlineAdd() {
    renderContent();
}

// ─── Per-message thought display (§9) ────────────────────────────────────────

/**
 * Render the thought block into the message DOM.
 *
 * This injects a display element into the message's DOM element — NEVER
 * into msg.mes. The thoughts are not part of chat history and are never
 * seen by the narrator model.
 *
 * @param {number} msgIdx - chat-array index of the message
 */
export function renderThoughtBlockForMessage(msgIdx) {
    // Resolve the stable perMessage key for this index, then look up the data.
    // perMessage is keyed by send_date, so the lookup survives chat shifts.
    const msgKey = getMsgKeyForIndex(msgIdx);
    if (!msgKey) return;
    const pm = getPerMessage(msgKey);
    if (!pm || !pm.reactions || pm.reactions.length === 0) return;

    // Find the message element in the DOM. ST stamps each message element
    // with its chat-array index in the `mesid` attribute — positional
    // indexing breaks because ST only renders a window of recent messages.
    const chat = document.getElementById('chat');
    if (!chat) return;

    const msgEl = chat.querySelector(`.mes[mesid="${msgIdx}"]`);
    if (!msgEl) return;

    // Remove any existing thought block
    const existing = msgEl.querySelector('.mwt-int-msg-thoughts');
    if (existing) existing.remove();

    // Build the thought block
    const block = document.createElement('div');
    block.className = 'mwt-int-msg-thoughts';
    block.innerHTML = pm.reactions.map(r => `
        <div class="mwt-int-msg-thought">
            <span class="mwt-int-msg-thought-npc">${escapeHtml(r.npc)}</span>
            <span class="mwt-int-msg-thought-text">💭 ${escapeHtml(r.thought)}</span>
        </div>
    `).join('');

    // Insert after the message text, before any existing elements
    const mesText = msgEl.querySelector('.mes_text');
    if (mesText && mesText.nextSibling) {
        mesText.parentNode.insertBefore(block, mesText.nextSibling);
    } else if (mesText) {
        mesText.parentNode.appendChild(block);
    } else {
        msgEl.appendChild(block);
    }
}

/**
 * Re-render all thought blocks for the current chat.
 * Called on CHAT_CHANGED.
 *
 * Iterates over stable perMessage keys, resolves each to its current
 * chat-array index via buildKeyToIndexMap(), and renders the thought
 * block on the matching DOM element. Thoughts whose messages have been
 * removed entirely (not in the chat array) are silently skipped.
 */
export function renderAllThoughtBlocks() {
    const keys = getPerMessageKeys();
    const keyToIndex = buildKeyToIndexMap();
    for (const key of keys) {
        const idx = keyToIndex.get(key);
        if (idx != null) {
            renderThoughtBlockForMessage(idx);
        }
    }
}

/**
 * Remove all thought blocks from the DOM.
 * Called before re-rendering or when the module is disabled.
 */
export function clearAllThoughtBlocks() {
    document.querySelectorAll('.mwt-int-msg-thoughts').forEach(el => el.remove());
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getContentEl() {
    if (state.contentEl) return state.contentEl;
    if (!state.modal) return null;
    state.contentEl = state.modal.querySelector('.mwt-tab-content[data-tab="interiority"]')
        ?? state.modal.querySelector('#mwt-int-content')?.closest('.mwt-tab-content');
    return state.contentEl;
}

export function setIntStatus(text, type = 'info') {
    const el = getContentEl();
    if (!el) return;
    const statusEl = el.querySelector('#mwt-int-status');
    if (statusEl) {
        statusEl.textContent = text || '';
        statusEl.className = `mwt-int-status mwt-int-status--${type}`;
    }
}