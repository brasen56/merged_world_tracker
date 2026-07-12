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
    getInteriorityData, getLedger, getPerMessage, getPerMessageIndices,
    removeLedgerEntries, setLedger,
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
    const msgIndices = getPerMessageIndices();

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
                Persistent NPC intentions injected into the narrator prompt. These are hidden plans that surface only as NPC actions when their trigger condition is met.
            </p>
            <div id="mwt-int-ledger-list" class="mwt-int-ledger-list">
                ${renderLedgerList(ledger)}
            </div>

            <hr style="border-color:var(--mwt-border);margin:16px 0">

            <h3>💭 Recent Thoughts</h3>
            <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:8px">
                Display-only NPC reactions from recent turns. These are never injected into the narrator prompt.
            </p>
            <div id="mwt-int-thoughts-list" class="mwt-int-thoughts-list">
                ${renderThoughtsList(msgIndices)}
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
    return ledger.map((entry, i) => `
        <div class="mwt-int-ledger-entry" data-id="${escapeHtml(entry.id)}">
            <div class="mwt-int-ledger-entry-main">
                <span class="mwt-int-ledger-npc">${escapeHtml(entry.npc)}</span>
                <span class="mwt-int-arrow">→</span>
                <span class="mwt-int-ledger-action">${escapeHtml(entry.action)}</span>
                <span class="mwt-int-arrow">→</span>
                <span class="mwt-int-ledger-trigger">${escapeHtml(entry.trigger)}</span>
            </div>
            <div class="mwt-int-ledger-meta">
                ${entry.since ? `<span style="color:var(--mwt-text-dim)">since ${escapeHtml(entry.since)}</span>` : ''}
                <button class="mwt-int-remove-btn mwt-btn" data-id="${escapeHtml(entry.id)}" title="Remove this intention">✕</button>
            </div>
        </div>
    `).join('');
}

/**
 * Render the recent thoughts list HTML.
 */
function renderThoughtsList(msgIndices) {
    if (!msgIndices || msgIndices.length === 0) {
        return '<p style="color:var(--mwt-text-dim);font-size:12px">No thoughts generated yet.</p>';
    }

    const shown = msgIndices.slice(0, 20); // Show last 20
    const parts = [];
    for (const idx of shown) {
        const pm = getPerMessage(idx);
        if (!pm || !pm.reactions || pm.reactions.length === 0) continue;
        for (const r of pm.reactions) {
            parts.push(`
                <div class="mwt-int-thought-entry">
                    <div class="mwt-int-thought-header">
                        <span class="mwt-int-thought-npc">${escapeHtml(r.npc)}</span>
                        <span class="mwt-int-thought-msg">msg #${idx}</span>
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
            </div>

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
            mode: panel.querySelector('#mwt-int-mode')?.value || 'batched',
            maxNpcs: Number(panel.querySelector('#mwt-int-max-npcs')?.value) || 4,
            messageWindow: Number(panel.querySelector('#mwt-int-window')?.value) || 8,
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

    // Per-entry remove buttons (event delegation)
    el.querySelector('#mwt-int-ledger-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.mwt-int-remove-btn');
        if (!btn) return;
        const id = btn.dataset.id;
        if (id) {
            removeLedgerEntries([id]);
            renderContent();
            document.dispatchEvent(new CustomEvent('mwt:interiority-ledger-changed'));
        }
    });
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
    const pm = getPerMessage(msgIdx);
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
 */
export function renderAllThoughtBlocks() {
    const indices = getPerMessageIndices();
    for (const idx of indices) {
        renderThoughtBlockForMessage(idx);
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