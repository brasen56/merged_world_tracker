/**
 * knowledge/index.js — Knowledge Tracker module (NPCs + State Trackers)
 *
 * Migrated from knowledge_tracker/index.js (3,193 lines).
 * Uses shared core for: context, api, diff, settings, modal.
 *
 * This module handles TWO merged tabs:
 *   - 'npcs' tab: NPC scanning, staging, minor/major NPC management
 *   - 'state-trackers' tab: State tracker registration and updates
 *
 * Public API: { init, render, renderStateTrackers, onMessageReceived, onChatChanged,
 *               getModuleRender, getModuleWireEvents, getModuleRefreshContent }
 */

import {
    getContextSafe, getChat, getChatMeta, setChatMeta, getSetExtensionPrompt, escapeRegex,
    resolveApiCall, normaliseOutput,
    escapeHtml, renderLineDiff, estimateTokens, // estimateTokens: used by refreshTotalTokens() — do not remove
    createSettingsManager,
} from '../core/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'mwt_knowledge';
const LOREBOOK_NAME = 'Knowledge Tracker';
const STATE_LOREBOOK_NAME = 'State Tracker';
const TRACKER_SENTINEL = '[Tracker]';
const REGISTRY_KEY = 'knowledge_tracker_registry';
const STATE_REGISTRY_KEY = 'state_tracker_registry';
const RELATIONSHIP_KEY = 'knowledge_tracker_relationships';
const HISTORY_KEY_PREFIX = 'kt_history_';
const RELATIONSHIP_TYPES = ['ally', 'enemy', 'neutral', 'friend', 'rival', 'family', 'lover', 'subordinate', 'superior', 'acquaintance', 'mentor', 'student', 'employer', 'employee'];

const RELATIONSHIP_BLOCK_START = '<!-- mwt:relationships:start -->';
const RELATIONSHIP_BLOCK_END = '<!-- mwt:relationships:end -->';

// ─── Settings ────────────────────────────────────────────────────────────────

const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    legacyKey: 'knowledge_tracker_settings',
    defaults: {
        connectionProfileId: '',
        apiUrl: '',
        apiKey: '',
        modelName: '',
        maxTokens: 2000,
        temperature: 0.1,
        topP: 1.0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        customHeaders: '',
        autoTriggerEnabled: false,
        autoTriggerEveryN: 5,
        trackerCooldownMsgs: 3,
    },
    logPrefix: '[MWT:Knowledge]',
});

// ─── Internal state ──────────────────────────────────────────────────────────

let modal = null;
let npcsContentEl = null;
let stateContentEl = null;
let activeSubTab = 'staging';
let stagingItems = [];
let activeItemId = null;
const selectedMajorNpcs = new Set();
let notificationEntries = {};
let notifActiveId = null;
let notifDragging = false, notifDragX = 0, notifDragY = 0;
let notifResizing = false, notifResizeX = 0, notifResizeY = 0, notifStartW = 0, notifStartH = 0;
let messageCounter = 0;
let isRunning = false;
let trackerQueue = Promise.resolve();
let _cachedTokenCount = 0;
let _refreshingTokens = false;
let _lastKtStatusMsg = '';
let _lastKtStatusLevel = '';

// ─── Notification Panel ────────────────────────────────────────────────────

function addNotificationEntry(item) {
    if (!item) return;
    const id = String(item.id);
    notificationEntries[id] = { item, created: Date.now() };
    notifActiveId = id;
    renderNotificationPanel();
    showNotificationPanel();
}

function removeNotificationEntry(id) {
    const strId = String(id);
    if (!notificationEntries[strId]) return;
    delete notificationEntries[strId];
    if (notifActiveId === strId) {
        const remaining = Object.keys(notificationEntries);
        notifActiveId = remaining.length > 0 ? remaining[0] : null;
    }
    if (Object.keys(notificationEntries).length === 0) hideNotificationPanel();
    else renderNotificationPanel();
}

function showNotificationPanel() {
    const panel = document.getElementById('kt-notification-panel');
    if (panel) panel.style.display = 'flex';
}

function hideNotificationPanel() {
    const panel = document.getElementById('kt-notification-panel');
    if (panel) panel.style.display = 'none';
}

function renderNotificationPanel() {
    const panel = document.getElementById('kt-notification-panel');
    if (!panel) return;
    const tabsEl = panel.querySelector('.kt-notif-tabs');
    const bodyEl = panel.querySelector('.kt-notif-body');
    const countEl = panel.querySelector('.kt-notif-count');
    const entryIds = Object.keys(notificationEntries);
    if (countEl) countEl.textContent = entryIds.length;

    if (entryIds.length === 0) { hideNotificationPanel(); return; }
    if (!notifActiveId || !notificationEntries[notifActiveId]) notifActiveId = entryIds[0];

    if (tabsEl) {
        tabsEl.innerHTML = entryIds.map(id => {
            const entry = notificationEntries[id];
            const name = entry.item.name || 'Unknown';
            const isActive = id === notifActiveId;
            return `<button class="kt-notif-tab${isActive ? ' kt-notif-tab--active' : ''}" data-id="${id}"><span class="kt-notif-dot"></span>${escapeHtml(name)}</button>`;
        }).join('');
        tabsEl.querySelectorAll('.kt-notif-tab').forEach(tab => {
            tab.addEventListener('click', () => { notifActiveId = tab.dataset.id; renderNotificationPanel(); });
        });
    }

    if (bodyEl) {
        const activeEntry = notificationEntries[notifActiveId];
        if (activeEntry) {
            const item = activeEntry.item;
            bodyEl.innerHTML = `<div class="kt-notif-detail">
                <div class="kt-detail-name">${escapeHtml(item.name)}</div>
                <div class="kt-detail-label">${item.type === 'state' ? 'State Tracker Update' : 'NPC Update'}</div>
                <div class="kt-diff"><pre style="font-size:11px;max-height:200px;overflow:auto;">${escapeHtml((item.proposedContent || '').slice(0, 500))}</pre></div>
                <div class="kt-detail-actions">
                    <button class="mwt-btn mwt-btn-primary" id="kt-notif-accept" style="font-size:12px;">✓ Accept</button>
                    <button class="mwt-btn" id="kt-notif-dismiss" style="font-size:12px;">✗ Dismiss</button>
                </div></div>`;

            bodyEl.querySelector('#kt-notif-accept')?.addEventListener('click', async () => {
                const btn = bodyEl.querySelector('#kt-notif-accept');
                if (btn) { btn.disabled = true; btn.textContent = 'Writing...'; }
                try {
                    const merged = item.mergedContent || item.proposedContent;
                    const keywords = item.keywords || [item.name];
                    const mockDetail = {
                        querySelector: (sel) => {
                            if (sel === '#kt-accept') return { disabled: false, textContent: 'Accept & Write' };
                            return { addEventListener: () => {}, style: {}, textContent: '', value: '' };
                        }
                    };
                    await handleAccept(item, merged, keywords, mockDetail);
                    removeNotificationEntry(item.id);
                } catch (err) {
                    console.warn('[MWT:Knowledge] Notif accept failed', err);
                    if (btn) { btn.disabled = false; btn.textContent = '✓ Accept'; }
                }
            });

            bodyEl.querySelector('#kt-notif-dismiss')?.addEventListener('click', () => {
                stagingItems = stagingItems.filter(i => i.id !== item.id);
                if (activeItemId === item.id) activeItemId = null;
                removeNotificationEntry(item.id);
                renderNpcsSubTab();
            });
        }
    }
}

function initNotificationPanel() {
    if (document.getElementById('kt-notification-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'kt-notification-panel';
    panel.style.display = 'none';
    panel.innerHTML = `<div class="kt-notif-header">
        <h3>🔔 Updates <span class="kt-notif-count">0</span></h3>
        <div class="kt-notif-header-actions">
            <button id="kt-notif-minimize" title="Minimize">─</button>
            <button id="kt-notif-close" title="Close">✕</button>
        </div></div>
        <div class="kt-notif-tabs"></div>
        <div class="kt-notif-body">
            <div style="color:#4b5563;font-size:13px;text-align:center;padding:24px;">No notifications</div>
        </div>`;
    document.body.appendChild(panel);

    panel.querySelector('#kt-notif-close')?.addEventListener('click', () => {
        notificationEntries = {};
        notifActiveId = null;
        hideNotificationPanel();
    });
    panel.querySelector('#kt-notif-minimize')?.addEventListener('click', () => hideNotificationPanel());

    // Drag support
    const header = panel.querySelector('.kt-notif-header');
    if (header) {
        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            notifDragging = true;
            const rect = panel.getBoundingClientRect();
            notifDragX = e.clientX - rect.left;
            notifDragY = e.clientY - rect.top;
            panel.style.transition = 'none';
            e.preventDefault();
        });
    }
    document.addEventListener('mousemove', (e) => {
        if (notifDragging) {
            panel.style.left = (e.clientX - notifDragX) + 'px';
            panel.style.top = (e.clientY - notifDragY) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }
    });
    document.addEventListener('mouseup', () => {
        if (notifDragging) { notifDragging = false; panel.style.transition = 'opacity 0.2s'; }
    });
}

// ─── Content helpers ──────────────────────────────────────────────────────────

function getNpcsContentEl() {
    if (npcsContentEl) return npcsContentEl;
    if (!modal) return null;
    // Knowledge tab contains NPCs + State Trackers merged together
    npcsContentEl = modal.querySelector('.mwt-tab-content[data-tab="knowledge"]')
        ?? modal.querySelector('#mwt-kt-npcs-content')?.closest('.mwt-tab-content');
    return npcsContentEl;
}

function getStateContentEl() {
    // State trackers are now a sub-section within the knowledge tab
    return getNpcsContentEl();
}

function ktSetStatus(text, type = 'info') {
    _lastKtStatusMsg = text || '';
    _lastKtStatusLevel = type || 'info';
    const el = getNpcsContentEl();
    if (!el) return;
    const statusEl = el.querySelector('#kt-status');
    if (statusEl) {
        statusEl.textContent = _lastKtStatusMsg;
        statusEl.className = `kt-status kt-status--${_lastKtStatusLevel}`;
    }
}

// ─── World-info import ───────────────────────────────────────────────────────

let wiScript = null;
try {
    wiScript = await import('../../../../world-info.js');
    console.log('[MWT:Knowledge] world-info.js loaded.');
} catch (err) {
    console.warn('[MWT:Knowledge] Could not import world-info.js:', err?.message || err);
}

// ─── Registry ────────────────────────────────────────────────────────────────

function getRegistry() {
    const meta = getChatMeta();
    if (!meta[REGISTRY_KEY]) meta[REGISTRY_KEY] = {};
    return meta[REGISTRY_KEY];
}

function saveRegistry(reg) {
    const ctx = getContextSafe();
    const meta = getChatMeta();
    meta[REGISTRY_KEY] = reg;
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
    else if (ctx?.saveChatDebounced) ctx.saveChatDebounced();
}

function registerEntry(name, uid, type, keywords) {
    const reg = getRegistry();
    reg[name] = { uid, type, keywords: keywords || [name], lastUpdated: Date.now() };
    saveRegistry(reg);
}

function isKnown(name) { return !!getRegistry()[name]; }

function findOrphans() {
    const reg = getRegistry();
    return Object.keys(reg).filter(name => reg[name].uid === null || reg[name].uid === undefined);
}

// ─── State Registry ──────────────────────────────────────────────────────────

function getStateRegistry() {
    const meta = getChatMeta();
    if (!meta[STATE_REGISTRY_KEY]) meta[STATE_REGISTRY_KEY] = {};
    return meta[STATE_REGISTRY_KEY];
}

function saveStateRegistry(reg) {
    const ctx = getContextSafe();
    const meta = getChatMeta();
    meta[STATE_REGISTRY_KEY] = reg;
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
    else if (ctx?.saveChatDebounced) ctx.saveChatDebounced();
}

function registerStateTracker(name, uid) {
    const reg = getStateRegistry();
    reg[name] = { uid, lastUpdatedMsg: 0, lastUpdatedAt: 0, enabled: true, alwaysUpdate: false };
    saveStateRegistry(reg);
}

function unregisterStateTracker(name) {
    const reg = getStateRegistry();
    delete reg[name];
    saveStateRegistry(reg);
}

function setStateTrackerEnabled(name, enabled) {
    const reg = getStateRegistry();
    if (reg[name]) { reg[name].enabled = enabled; saveStateRegistry(reg); }
}

function setStateTrackerAlwaysUpdate(name, always) {
    const reg = getStateRegistry();
    if (reg[name]) { reg[name].alwaysUpdate = always; saveStateRegistry(reg); }
}

function bumpStateTrackerTimestamp(name) {
    const reg = getStateRegistry();
    if (reg[name]) {
        reg[name].lastUpdatedMsg = getChat()?.length || 0;
        reg[name].lastUpdatedAt = Date.now();
        saveStateRegistry(reg);
    }
}

// ─── Relationships ───────────────────────────────────────────────────────────

function getRelationships() {
    const meta = getChatMeta();
    if (!meta[RELATIONSHIP_KEY]) meta[RELATIONSHIP_KEY] = {};
    return meta[RELATIONSHIP_KEY];
}

function saveRelationships(rels) {
    const ctx = getContextSafe();
    const meta = getChatMeta();
    meta[RELATIONSHIP_KEY] = rels;
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
    else if (ctx?.saveChatDebounced) ctx.saveChatDebounced();
}

function getNpcRelationships(name) { return getRelationships()[name] || []; }

function getAllNpcNames() { return Object.keys(getRegistry()); }

function addRelationship(from, to, type, notes) {
    const rels = getRelationships();
    if (!rels[from]) rels[from] = [];
    if (!rels[from].some(r => r.target === to)) {
        rels[from].push({ target: to, type, notes: notes || '' });
        saveRelationships(rels);
    }
}

function removeRelationship(from, to) {
    const rels = getRelationships();
    if (rels[from]) {
        rels[from] = rels[from].filter(r => r.target !== to);
        if (rels[from].length === 0) delete rels[from];
        saveRelationships(rels);
    }
}

function updateRelationship(from, to, type, notes) {
    const rels = getRelationships();
    if (!rels[from]) rels[from] = [];
    const existing = rels[from].find(r => r.target === to);
    if (existing) {
        existing.type = type;
        existing.notes = notes || '';
    } else {
        rels[from].push({ target: to, type, notes: notes || '' });
    }
    saveRelationships(rels);
}

function rekeyRelationships(oldName, newName) {
    if (oldName === newName) return;
    const rels = getRelationships();
    if (!rels) return;
    // 1) Re-point outgoing edges: oldName -> * becomes newName -> *
    if (rels[oldName]) {
        if (!rels[newName]) rels[newName] = [];
        for (const edge of rels[oldName]) {
            const existing = rels[newName].find(r => r.target === edge.target);
            if (existing) {
                existing.type = edge.type;
                if (edge.notes) existing.notes = edge.notes;
            } else {
                rels[newName].push({ ...edge });
            }
        }
        delete rels[oldName];
    }
    // 2) Re-point incoming edges: * -> oldName becomes * -> newName
    for (const [from, targets] of Object.entries(rels)) {
        for (let i = targets.length - 1; i >= 0; i--) {
            if (targets[i].target === oldName) {
                const existing = targets.find((r, idx) => idx !== i && r.target === newName);
                if (existing) {
                    existing.type = targets[i].type;
                    if (targets[i].notes) existing.notes = targets[i].notes;
                    targets.splice(i, 1);
                } else {
                    targets[i].target = newName;
                }
            }
        }
        if (targets.length === 0) delete rels[from];
    }
    saveRelationships(rels);
}

// ─── Managed block helpers ───────────────────────────────────────────────────

function stripRelationshipBlock(content) {
    if (!content) return content;
    const startIdx = content.indexOf(RELATIONSHIP_BLOCK_START);
    if (startIdx === -1) return content;
    const endIdx = content.indexOf(RELATIONSHIP_BLOCK_END, startIdx);
    if (endIdx === -1) return content;
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + RELATIONSHIP_BLOCK_END.length);
    return (before + after).replace(/\n{3,}/g, '\n\n').trim();
}

function injectRelationshipBlock(content, blockText) {
    const stripped = stripRelationshipBlock(content || '');
    const block = `${RELATIONSHIP_BLOCK_START}\n${blockText}\n${RELATIONSHIP_BLOCK_END}`;
    if (!stripped) return block;
    return `${stripped}\n\n${block}`;
}

function formatRelationshipBlock(name) {
    const rels = getNpcRelationships(name);
    if (!rels.length) return '';
    const lines = rels.map(r => {
        const note = r.notes ? ` (${r.notes})` : '';
        return `${r.type} of ${r.target}${note}`;
    });
    return `Relationships: ${lines.join('; ')}.`;
}

async function syncRelationshipsToLorebook(name) {
    const reg = getRegistry()[name];
    if (!reg || reg.uid === null || reg.uid === undefined) return { success: false, error: 'No lorebook entry' };
    const currentContent = await loadEntryContent(reg.uid);
    if (currentContent === null) return { success: false, error: 'Could not load entry' };
    const blockText = formatRelationshipBlock(name);
    const newContent = blockText ? injectRelationshipBlock(currentContent, blockText) : stripRelationshipBlock(currentContent);
    if (newContent === currentContent) return { success: true, unchanged: true };
    return writeToLorebook(name, newContent, reg.keywords || [name], reg.uid);
}

async function syncAllRelationshipsToLorebooks() {
    const registry = getRegistry();
    let synced = 0, failed = 0;
    for (const [name, info] of Object.entries(registry)) {
        if (info.uid === null || info.uid === undefined) continue;
        try {
            const result = await syncRelationshipsToLorebook(name);
            if (result.success && !result.unchanged) synced++;
            else if (!result.success) failed++;
        } catch (err) { console.warn(`[MWT:Knowledge] Sync relationships for "${name}" failed:`, err); failed++; }
    }
    return { synced, failed };
}

// ─── History ─────────────────────────────────────────────────────────────────

function pushHistory(uid, content) {
    if (uid === null || uid === undefined) return;
    const key = HISTORY_KEY_PREFIX + uid;
    let history = [];
    try { history = JSON.parse(localStorage.getItem(key) || '[]'); } catch { history = []; }
    history.unshift({ ts: Date.now(), content, msgIdx: getChat()?.length || 0 });
    if (history.length > 50) history.length = 50;
    try { localStorage.setItem(key, JSON.stringify(history)); } catch { /* quota */ }
}

function getHistory(uid) {
    if (uid === null || uid === undefined) return [];
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY_PREFIX + uid) || '[]'); } catch { return []; }
}

// ─── Message helpers ─────────────────────────────────────────────────────────

function getRecentMessages(count = 30) {
    const chat = getChat();
    if (!chat || !chat.length) return null;
    const slice = chat.slice(-count);
    const filtered = slice.filter(m => m.mes && !m.is_system);
    if (!filtered.length) return null;
    return filtered.map(m => `${m.is_user ? (m.name || 'User') : (m.name || 'Assistant')}: ${m.mes}`).join('\n');
}

function getPlayerNames() {
    const ctx = getContextSafe();
    const names = new Set();
    // ctx.name1 is the player's persona name in SillyTavern
    if (ctx?.name1) names.add(String(ctx.name1).trim());
    // ctx.name2 is the AI character name — include so it's excluded from NPC scans
    if (ctx?.name2) names.add(String(ctx.name2).trim());
    // Group-chat member names (array of character objects)
    if (Array.isArray(ctx?.characters)) {
        for (const ch of ctx.characters) {
            if (ch?.name) names.add(String(ch.name).trim());
        }
    }
    // Fallback: first message in chat (usually the AI character's greeting)
    const chat = getChat();
    if (chat) {
        const first = chat[0];
        if (first?.name) names.add(first.name.trim());
    }
    return [...names].filter(Boolean);
}

function getCurrentWorldState() {
    return getChatMeta()?.world_state_tracker_metadata?.text || '';
}

function getLatestChronicleEntry() {
    const chronicleData = getChatMeta()?.session_chronicle_data;
    if (!chronicleData?.snapshots?.length) return '';
    const sorted = [...chronicleData.snapshots].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sorted[0]?.text || '';
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SCAN_SYSTEM_PROMPT = `You are a scanner for an ongoing roleplay. Your sole job is to output a single JSON object listing NPCs found in recent messages.

ABSOLUTE RULES:
- Output ONLY valid JSON. Nothing before or after it. No code fences.
- Do NOT write narration, dialogue, or roleplay continuation.

OUTPUT FORMAT:
{
  "new_minor": [
    { "name": "Full Name", "species": "Human/Elf/etc", "tone": "2-3 word communication style", "perceived_as": "how they present", "descriptor": "3-5 word physical/role descriptor", "first_seen": "location and in-world date/time" }
  ],
  "new_major": [
    { "name": "Full Name", "species": "Human/Elf/etc", "tone": "2-3 word communication style", "perceived_as": "how they present", "descriptor": "3-5 word physical/role descriptor", "first_seen": "location and in-world date/time", "initial_knowledge": [{ "fact": "concrete fact", "source": "how they know it", "date": "in-world date" }] }
  ],
  "update_minor": [
    { "name": "must match an existing NPC name exactly", "fields": { "tone": "updated value or null if unchanged", "perceived_as": "updated value or null if unchanged", "descriptor": "updated value or null if unchanged" } }
  ],
  "update_major": [
    { "name": "must match an existing NPC name exactly", "fields": { "tone": "updated value or null if unchanged", "perceived_as": "updated value or null if unchanged", "descriptor": "updated value or null if unchanged" }, "new_knowledge": [{ "fact": "new concrete fact this NPC learned or now knows", "source": "how they know it", "date": "in-world date if known" }] }
  ]
}

Classification guide:
- MINOR NPC: background characters, one-scene appearances, unnamed roles.
- MAJOR NPC: named characters who have meaningful ongoing roles, relationships, or plot relevance.
- If uncertain, classify as minor.
- An NPC name MUST appear in the "Already Tracked NPCs" section to be classified as update. If not listed, classify as new.
- Only include NPCs who actually appeared or were meaningfully referenced.
- For update entries: only include NPCs whose information actually changed.
- If no NPCs qualify for a category, use an empty array [].
- The player character / protagonist is NOT an NPC — do not include them.`;

const STATE_UPDATE_PROMPT = `You are a state tracker for an ongoing roleplay. Your sole job is to output an updated version of the entry inside <current_entry>.

OUTPUT CONTRACT:
- Your ENTIRE response is the new entry text. Nothing else.
- Do NOT include code fences, markdown headings, commentary, prefaces, or framing.
- Do NOT echo or restate <recent_messages>, <current_entry>, <entity>, or any other tag from the input.

FIELD RULES:
- Preserve the EXACT structure of the original entry: same field names, casing, order, separators, blank lines.
- Do NOT add new fields. Do NOT remove existing fields.
- Facts apply to <entity> ONLY if <recent_messages> explicitly attributes them to <entity> by name.
- Update a field's value ONLY if <recent_messages> contains direct evidence of a change. Otherwise, copy the current value verbatim.
- A line may be removed ONLY if <recent_messages> contains direct evidence that the action, plan, or condition it describes is no longer applicable.
- If the entity does not appear or is not meaningfully referenced in <recent_messages>, output the original entry unchanged.`;

const NPC_UPDATE_PROMPT = `You are a continuity tracker for an ongoing roleplay. Your job is to identify new information about a specific NPC from recent messages.

ABSOLUTE RULES:
- Output ONLY valid JSON. Nothing before or after it. No code fences.
- Do NOT invent information not established in the messages.
- If no new information exists, return empty arrays.

OUTPUT FORMAT:
{
  "fields": {
    "tone": "updated communication style if it changed, else null",
    "perceived_as": "updated perception if it changed, else null",
    "descriptor": "updated descriptor if appearance/role changed, else null"
  },
  "new_knowledge": [
    { "fact": "concrete new fact this NPC learned or now knows", "source": "witness/told/document/rumor/institutional", "date": "in-world date if known" }
  ]
}`;

// ─── API fetch (delegates to shared core) ────────────────────────────────────

async function ktFetchFromApi(systemPrompt, userContent, { retries = 1 } = {}) {
    const resolved = resolveApiCall({ moduleSettings: getSettings() });
    return resolved.fetchFn({ systemPrompt, userContent, settings: resolved.settings, retries });
}

// ─── Lorebook operations ────────────────────────────────────────────────────

async function loadStateTrackerEntry(uid) {
    if (!wiScript) return null;
    try {
        const wi = await wiScript.loadWorldInfo(STATE_LOREBOOK_NAME);
        const entry = wi?.entries?.[uid];
        return entry ? { content: entry.content || '', comment: entry.comment || '' } : null;
    } catch (err) { console.warn('[MWT:Knowledge] Could not load state tracker entry:', err.message); return null; }
}

async function writeStateTracker(uid, name, content) {
    if (!wiScript) return { success: false, error: 'world-info.js not loaded' };
    try {
        const wi = await wiScript.loadWorldInfo(STATE_LOREBOOK_NAME);
        const entry = wi?.entries?.[uid];
        if (!entry) return { success: false, error: `UID ${uid} not found in "${STATE_LOREBOOK_NAME}".` };
        const comment = entry.comment || '';
        if (!comment.startsWith(TRACKER_SENTINEL)) return { success: false, error: `UID ${uid} missing ${TRACKER_SENTINEL} sentinel.` };
        const previousContent = entry.content || '';
        entry.content = content;
        await wiScript.saveWorldInfo(STATE_LOREBOOK_NAME, wi);
        pushHistory(uid, previousContent);
        return { success: true, uid };
    } catch (err) { return { success: false, error: err.message }; }
}

async function writeToLorebook(name, content, keywords, existingUid) {
    if (!wiScript) return { success: false, content, keywords, error: 'world-info.js not loaded' };
    try {
        let wi = await wiScript.loadWorldInfo(LOREBOOK_NAME);
        // Auto-create the lorebook if it doesn't exist yet
        if (!wi || !wi.entries) {
            if (typeof wiScript.createNewWorldInfo === 'function') {
                wi = await wiScript.createNewWorldInfo(LOREBOOK_NAME);
            } else {
                // Fallback: construct a minimal world-info object and save it
                wi = { name: LOREBOOK_NAME, entries: {} };
            }
        }
        const entries = wi.entries;
        if (existingUid !== null && existingUid !== undefined && entries[existingUid]) {
            const previousContent = entries[existingUid].content || '';
            pushHistory(existingUid, previousContent);
            entries[existingUid].content = content;
            entries[existingUid].key = keywords;
            entries[existingUid].comment = name;
            await wiScript.saveWorldInfo(LOREBOOK_NAME, wi);
            return { success: true, uid: existingUid };
        } else {
            const existingUids = Object.keys(entries).map(Number).filter(n => !isNaN(n));
            const newUid = existingUids.length > 0 ? existingUids.reduce((a, b) => a > b ? a : b, -1) + 1 : 0;
            entries[newUid] = {
                uid: newUid, key: keywords, keysecondary: [], comment: name, content, enabled: true,
                selective: false, constant: false, order: 100, position: 0, disable: false, addMemo: true,
                group: '', groupOverride: false, groupWeight: 100, sticky: null, cooldown: null, delay: null,
                probability: 100, useProbability: true, depth: 4, selectiveLogic: 0, excludeRecursion: false,
                preventRecursion: false, delayUntilRecursion: false, scanDepth: null, caseSensitive: null,
                matchWholeWords: null, useGroupScoring: null, automationId: '', role: null, vectorized: false,
                displayIndex: newUid,
            };
            await wiScript.saveWorldInfo(LOREBOOK_NAME, wi);
            return { success: true, uid: newUid };
        }
    } catch (err) { return { success: false, content, keywords, error: err.message }; }
}

async function loadEntryContent(uid) {
    if (!wiScript) return null;
    try {
        const wi = await wiScript.loadWorldInfo(LOREBOOK_NAME);
        return wi?.entries?.[uid]?.content ?? null;
    } catch (err) { return null; }
}

// ─── Entry formatters ────────────────────────────────────────────────────────

function formatMinorEntry(data) {
    return [`${data.name || 'Unknown'} | ${data.species || 'Unknown'} | ${data.descriptor || ''}`,
        `Tone: ${data.tone || 'unknown'}`, `Perceived as: ${data.perceived_as || 'unknown'}`,
        `First seen: ${data.first_seen || 'unknown'}`].join('\n');
}

function formatMajorEntry(data) {
    const lines = [`${data.name || 'Unknown'} | ${data.species || 'Unknown'} | ${data.descriptor || ''}`,
        `Tone: ${data.tone || 'unknown'}`, `Perceived as: ${data.perceived_as || 'unknown'}`,
        `First seen: ${data.first_seen || 'unknown'}`, '', 'Knowledge Ledger:'];
    const knowledge = data.initial_knowledge || data.new_knowledge || [];
    if (knowledge.length > 0) knowledge.forEach(k => lines.push(`- ${k.fact} via ${k.source || 'unknown'}${k.date ? ' — ' + k.date : ''}`));
    else lines.push('- (no entries yet)');
    return lines.join('\n');
}

function isHeaderLine(line) { return /\|/.test(line) && line.split('|').length >= 3 && !/^\s*-/.test(line); }
function findHeaderLineIdx(lines) { return lines.findIndex(isHeaderLine); }

function buildUpdatedMinorContent(existingContent, fields) {
    const lines = existingContent.split('\n');
    const headerIdx = findHeaderLineIdx(lines);
    return lines.map((line, idx) => {
        if (fields.tone != null && line.startsWith('Tone:')) return `Tone: ${fields.tone}`;
        if (fields.perceived_as != null && line.startsWith('Perceived as:')) return `Perceived as: ${fields.perceived_as}`;
        if (fields.descriptor != null && idx === headerIdx && headerIdx !== -1) { const parts = line.split('|').map(p => p.trim()); parts[2] = fields.descriptor; return parts.join(' | '); }
        return line;
    }).join('\n');
}

function buildUpdatedMajorContent(existingContent, fields, newKnowledge) {
    let lines = existingContent.split('\n');
    const headerIdx = findHeaderLineIdx(lines);
    lines = lines.map((line, idx) => {
        if (fields?.tone != null && line.startsWith('Tone:')) return `Tone: ${fields.tone}`;
        if (fields?.perceived_as != null && line.startsWith('Perceived as:')) return `Perceived as: ${fields.perceived_as}`;
        if (fields?.descriptor != null && idx === headerIdx && headerIdx !== -1) { const parts = line.split('|').map(p => p.trim()); parts[2] = fields.descriptor; return parts.join(' | '); }
        return line;
    });
    if (newKnowledge?.length > 0) newKnowledge.forEach(k => lines.push(`- ${k.fact} via ${k.source || 'unknown'}${k.date ? ' — ' + k.date : ''}`));
    return lines.join('\n');
}

function synthesizeMinorFromUpdate(name, fields) {
    return [`${name} | unknown | ${fields?.descriptor || 'unknown'}`, `Tone: ${fields?.tone || 'unknown'}`,
        `Perceived as: ${fields?.perceived_as || 'unknown'}`, `First seen: unknown`].join('\n');
}

function synthesizeMajorFromUpdate(name, fields, newKnowledge) {
    const lines = [`${name} | unknown | ${fields?.descriptor || 'unknown'}`, `Tone: ${fields?.tone || 'unknown'}`,
        `Perceived as: ${fields?.perceived_as || 'unknown'}`, `First seen: unknown`, '', 'Knowledge Ledger:'];
    if (newKnowledge?.length > 0) newKnowledge.forEach(k => lines.push(`- ${k.fact} via ${k.source || 'unknown'}${k.date ? ' — ' + k.date : ''}`));
    else lines.push('- (no entries yet)');
    return lines.join('\n');
}

async function enrichStagingItem(item) {
    // uid == null (not falsy!) — uid 0 is the first entry in a fresh lorebook
    if (!item || item.action !== 'update' || item.existingContent !== null || item.uid == null) return;
    const existing = await loadEntryContent(item.uid);
    if (existing !== null) {
        item.existingContent = existing;
        if (item.type === 'minor') item.mergedContent = buildUpdatedMinorContent(existing, item.fields || {});
        else if (item.type === 'major') item.mergedContent = buildUpdatedMajorContent(existing, item.fields || {}, item.newKnowledge || []);
        else item.mergedContent = existing;
        item.proposedContent = item.mergedContent || item.proposedContent;
    }
}

function buildPromotedContent(currentContent) {
    const lines = currentContent.split('\n');
    if (lines.some(l => l.trim().toLowerCase().startsWith('knowledge ledger:'))) return currentContent;
    const insertIdx = lines.findIndex(l => l.trim().toLowerCase().startsWith('first seen:'));
    if (insertIdx !== -1 && insertIdx + 1 < lines.length && lines[insertIdx + 1].trim() === '') lines.splice(insertIdx + 2, 0, '', 'Knowledge Ledger:', '- (no entries yet)');
    else lines.push('', 'Knowledge Ledger:', '- (no entries yet)');
    return lines.join('\n');
}

function buildDemotedContent(currentContent) {
    const lines = currentContent.split('\n');
    const filtered = [];
    let skipSection = false;
    for (const line of lines) {
        if (line.trim().toLowerCase().startsWith('knowledge ledger:')) { skipSection = true; continue; }
        if (skipSection && line.startsWith('- ')) continue;
        if (line.trim() !== '' && !line.startsWith('- ')) skipSection = false;
        filtered.push(line);
    }
    while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') filtered.pop();
    return filtered.join('\n');
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateStateOutput(originalEntry, output) {
    if (!output || !output.trim()) return { ok: false, reason: 'empty output' };
    const leakPatterns = [
        { re: /<recent_messages>/i, label: '<recent_messages> tag' }, { re: /<current_entry>/i, label: '<current_entry> tag' },
        { re: /<entity>/i, label: '<entity> tag' }, { re: /^#+\s*Recent\s+Messages/im, label: '"### Recent Messages" heading' },
        { re: /^#+\s*Current\s+Entry/im, label: '"### Current Entry" heading' },
    ];
    for (const { re, label } of leakPatterns) { if (re.test(output)) return { ok: false, reason: `output contains ${label}` }; }
    const lineHeaderRe = /^([^\s:#][^:]*?):/gm;
    const origHeaders = new Set([...originalEntry.matchAll(lineHeaderRe)].map(m => m[1].trim().toLowerCase()));
    const speakerLineRe = /^([A-Z][\w .'-]{0,30}):\s+\S.{40,}$/gm;
    const isUnknownPrefix = (m) => !origHeaders.has(m[1].trim().toLowerCase());
    const outputLines = output.split('\n');
    let maxRun = 0, currentRun = 0;
    for (const line of outputLines) {
        speakerLineRe.lastIndex = 0;
        const m = speakerLineRe.exec(line);
        if (m && isUnknownPrefix(m)) { currentRun++; if (currentRun > maxRun) maxRun = currentRun; } else currentRun = 0;
    }
    if (maxRun >= 3) return { ok: false, reason: 'output appears to contain a chat transcript' };
    const fieldRe = /^([A-Z][A-Z0-9_]+):/gm;
    const origFields = new Set([...originalEntry.matchAll(fieldRe)].map(m => m[1]));
    const newFields = new Set([...output.matchAll(fieldRe)].map(m => m[1]));
    if (origFields.size > 0) {
        const added = [...newFields].filter(f => !origFields.has(f));
        const dropped = [...origFields].filter(f => !newFields.has(f));
        if (added.length > 0) return { ok: false, reason: `added unauthorized fields: ${added.join(', ')}` };
        if (dropped.length > 0) return { ok: false, reason: `dropped required fields: ${dropped.join(', ')}` };
    }
    if (output.length > originalEntry.length * 4 + 2000) return { ok: false, reason: 'output too long' };
    return { ok: true };
}

// ─── Scan ────────────────────────────────────────────────────────────────────

async function runScan() {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    const registry = getRegistry();
    const knownNames = Object.keys(registry).filter(name => registry[name].uid !== null && registry[name].uid !== undefined);
    const recentMessages = getRecentMessages();
    const worldState = getCurrentWorldState();
    const chronicle = getLatestChronicleEntry();
    if (!recentMessages) throw new Error('No recent messages to scan.');
    const knownSection = knownNames.length > 0 ? `### Already Tracked NPCs\n${knownNames.map(n => `- ${n} [${registry[n].type}]`).join('\n')}` : '### Already Tracked NPCs\nNone yet.';
    const playerNames = getPlayerNames();
    const playerSection = playerNames.length > 0 ? `### Player Names (EXCLUDE)\n${playerNames.map(n => `- ${n}`).join('\n')}` : '';
    const userContent = [knownSection, '', playerSection, '', worldState ? `### World State\n${worldState}` : '', '', chronicle ? `### Chronicle\n${chronicle}` : '', '', '### Recent Messages', recentMessages, '', '='.repeat(60), 'Scan for NPCs. Output only JSON.'].filter(s => s !== null && s !== '').join('\n');
    const raw = await ktFetchFromApi(SCAN_SYSTEM_PROMPT, userContent);
    let cleaned = normaliseOutput(raw);
    try {
        const result = JSON.parse(cleaned);
        const playerSet = new Set(playerNames.map(n => n.toLowerCase()));
        const notPlayer = (entry) => entry && entry.name && !playerSet.has(String(entry.name).toLowerCase());
        return {
            new_minor: Array.isArray(result.new_minor) ? result.new_minor.filter(notPlayer) : [],
            new_major: Array.isArray(result.new_major) ? result.new_major.filter(notPlayer) : [],
            update_minor: Array.isArray(result.update_minor) ? result.update_minor.filter(notPlayer) : [],
            update_major: Array.isArray(result.update_major) ? result.update_major.filter(notPlayer) : [],
        };
    } catch (err) { throw new Error(`Model did not return valid JSON. Preview: "${cleaned.slice(0, 120)}"`); }
}

// ─── State update ────────────────────────────────────────────────────────────

async function runStateUpdate(name, uid) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    const loaded = await loadStateTrackerEntry(uid);
    if (!loaded) throw new Error(`Could not load state entry for "${name}".`);
    if (!loaded.comment.startsWith(TRACKER_SENTINEL)) throw new Error(`UID ${uid} missing sentinel.`);
    const recentMessages = getRecentMessages();
    if (!recentMessages) throw new Error('No recent messages.');
    let lastError = null, lastOutput = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const userContent = attempt === 1
            ? [`<entity>${name}</entity>`, '', '<current_entry>', loaded.content, '</current_entry>', '', '<recent_messages>', recentMessages, '</recent_messages>', '', 'Output the updated entry.'].join('\n')
            : [`<entity>${name}</entity>`, '', '<current_entry>', loaded.content, '</current_entry>', '', '<recent_messages>', recentMessages, '</recent_messages>', '', `<previous_attempt_rejected>Reason: ${lastError}</previous_attempt_rejected>`, '', 'Try again. Output ONLY the updated entry.'].join('\n');
        const raw = await ktFetchFromApi(STATE_UPDATE_PROMPT, userContent);
        let cleaned = normaliseOutput(raw);
        const validation = validateStateOutput(loaded.content, cleaned);
        if (validation.ok) return { currentContent: loaded.content, merged: cleaned, unchanged: cleaned.trim() === loaded.content.trim(), attempts: attempt };
        lastError = validation.reason; lastOutput = cleaned;
    }
    throw new Error(`Output validation failed: ${lastError}`);
}

async function runNpcUpdate(name, uid) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    const rawContent = await loadEntryContent(uid);
    if (!rawContent) throw new Error(`Could not load entry for "${name}".`);
    const currentContent = stripRelationshipBlock(rawContent);
    const recentMessages = getRecentMessages();
    const worldState = getCurrentWorldState();
    if (!recentMessages) throw new Error('No recent messages.');
    const userContent = [`### NPC: ${name}`, `### Current Entry\n${currentContent}`, '', worldState ? `### World State\n${worldState}` : '', '', '### Recent Messages', recentMessages, '', '='.repeat(60), `Identify new info about ${name}. Output only JSON.`].filter(Boolean).join('\n');
    const raw = await ktFetchFromApi(NPC_UPDATE_PROMPT, userContent);
    let cleaned = normaliseOutput(raw);
    let result;
    try { result = JSON.parse(cleaned); } catch { throw new Error(`Model did not return valid JSON. Preview: "${cleaned.slice(0, 120)}"`); }
    const merged = buildUpdatedMajorContent(currentContent, result.fields || {}, result.new_knowledge || []);
    return { currentContent, merged, fields: result.fields || {}, newKnowledge: result.new_knowledge || [] };
}

function queueTrackerWork(fn) { trackerQueue = trackerQueue.then(fn).catch(err => console.error('[MWT:Knowledge] Queued work failed:', err)); return trackerQueue; }

// ─── Staging ─────────────────────────────────────────────────────────────────

function buildStagingItems(scanResult) {
    const registry = getRegistry();
    const items = [];
    // Ids must be unique across scans — a plain per-scan counter collided with
    // items still staged from a previous scan (wrong detail shown, dismiss
    // removing two items, notification entries overwriting each other).
    const makeId = () => `kt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let misclassifiedCount = 0;

    scanResult.new_minor.forEach(data => {
        items.push({ id: makeId(), type: 'minor', action: 'create', name: data.name, data, proposedContent: formatMinorEntry(data), existingContent: null, keywords: [data.name] });
    });
    scanResult.new_major.forEach(data => {
        items.push({ id: makeId(), type: 'major', action: 'create', name: data.name, data, proposedContent: formatMajorEntry(data), existingContent: null, keywords: [data.name] });
    });
    scanResult.update_minor.forEach(data => {
        const reg = registry[data.name];
        const orphan = !reg || reg.uid === null || reg.uid === undefined;
        if (orphan) {
            misclassifiedCount++;
            items.push({ id: makeId(), type: 'minor', action: 'create', name: data.name, data, proposedContent: synthesizeMinorFromUpdate(data.name, data.fields), existingContent: null, keywords: [data.name], synthesized: true });
            return;
        }
        items.push({ id: makeId(), type: 'minor', action: 'update', name: data.name, data, proposedContent: '(Fetch to see changes)', existingContent: null, keywords: reg.keywords || [data.name], uid: reg.uid, fields: data.fields });
    });
    scanResult.update_major.forEach(data => {
        const reg = registry[data.name];
        const orphan = !reg || reg.uid === null || reg.uid === undefined;
        if (orphan) {
            misclassifiedCount++;
            items.push({ id: makeId(), type: 'major', action: 'create', name: data.name, data, proposedContent: synthesizeMajorFromUpdate(data.name, data.fields, data.new_knowledge || []), existingContent: null, keywords: [data.name], synthesized: true });
            return;
        }
        items.push({ id: makeId(), type: 'major', action: 'update', name: data.name, data, proposedContent: '(Fetch to see changes)', existingContent: null, keywords: reg.keywords || [data.name], uid: reg.uid, fields: data.fields, newKnowledge: data.new_knowledge || [] });
    });
    if (misclassifiedCount > 0) setTimeout(() => ktSetStatus(`${misclassifiedCount} misclassified entries converted to new proposals.`, 'info'), 800);
    return items;
}

function formatHistoryAge(ts) {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// ─── Handle accept ───────────────────────────────────────────────────────────

const STAGING_PLACEHOLDERS = ['(Fetch to see changes)', '(promoting)', '(demoting)'];

async function handleAccept(item, proposedText, keywords, detailEl) {
    const trimmed = typeof proposedText === 'string' ? proposedText.trim() : '';
    // Never write placeholder text — it would overwrite the real lorebook entry.
    const isPlaceholder = STAGING_PLACEHOLDERS.includes(trimmed);
    if (!trimmed || isPlaceholder) {
        ktSetStatus(isPlaceholder
            ? `Cannot write "${item.name}": content not loaded yet — open the proposal in Staging first.`
            : `Cannot write "${item.name}": no content to save.`, 'error');
        const acceptBtn = detailEl?.querySelector?.('#kt-accept');
        if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = '✓ Accept & Write'; }
        return;
    }
    const acceptBtn = detailEl?.querySelector?.('#kt-accept');
    if (acceptBtn) { acceptBtn.disabled = true; acceptBtn.textContent = '⏳ Writing…'; }
    ktSetStatus(`Writing "${item.name}"…`, 'info');
    try {
        let targetType = item.type;
        if (item.type === 'promote') targetType = 'major';
        else if (item.type === 'demote') targetType = 'minor';

        if (item.type === 'state') {
            const registryName = item.originalName || item.name;
            const result = await writeStateTracker(item.uid, registryName, proposedText);
            if (result.success) {
                bumpStateTrackerTimestamp(registryName);
                stagingItems = stagingItems.filter(i => i.id !== item.id);
                activeItemId = null;
                renderStagingList();
                renderStateContent();
                ktSetStatus(`State for "${item.name}" updated.`, 'success');
            } else {
                ktSetStatus(`State write failed: ${result.error}`, 'error');
            }
            return;
        }

        const lookupName = item.originalName || item.name;
        const reg = getRegistry()[lookupName];
        const uid = reg?.uid ?? item.uid ?? null;
        const result = await writeToLorebook(lookupName, proposedText, keywords, uid);
        if (result.success) {
            registerEntry(lookupName, result.uid, targetType, keywords);
            if (item.mergeSource) {
                const reg2 = getRegistry();
                delete reg2[item.mergeSource];
                saveRegistry(reg2);
                rekeyRelationships(item.mergeSource, lookupName);
            }
            // proposedText replaced the entire entry, wiping any managed relationship
            // block. Re-inject it so knowledge updates don't silently drop relationships.
            try { await syncRelationshipsToLorebook(lookupName); }
            catch (err) { console.warn('[MWT:Knowledge] Re-sync relationships after write failed:', err); }
            stagingItems = stagingItems.filter(i => i.id !== item.id);
            activeItemId = null;
            renderStagingList();
            renderNpcLists();
            ktSetStatus(`"${lookupName}" written successfully.`, 'success');
        } else {
            ktSetStatus(`Write failed: ${result.error || 'unknown'}`, 'error');
        }
    } catch (err) { console.error('[MWT:Knowledge] Write failed', err); ktSetStatus(`Write failed: ${err.message}`, 'error'); }
    finally { if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = '✓ Accept & Write'; } }
}

// ─── Render functions ────────────────────────────────────────────────────────
// These are all stubbed for now — they'll be filled in with the full UI logic.
// For Phase 4, we provide the structural skeleton and core operations.

function renderStagingList() {
    const el = getNpcsContentEl();
    if (!el) return;
    // Delegate to the sub-tab rendering
    renderNpcsSubTab();
}

function renderNpcLists() {
    const el = getNpcsContentEl();
    if (!el) return;
    // Refresh the minor/major lists if visible
    if (activeSubTab === 'minor' || activeSubTab === 'major') renderNpcsSubTab();
}

function sortEntries(entries, sortMode) {
    const sorted = [...entries];
    if (sortMode === 'name') sorted.sort(([a], [b]) => a.localeCompare(b));
    else if (sortMode === 'name-desc') sorted.sort(([a], [b]) => b.localeCompare(a));
    else if (sortMode === 'recent') sorted.sort(([, a], [, b]) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
    return sorted;
}

function renderNpcsSubTab() {
    const el = getNpcsContentEl();
    if (!el) return;
    const registry = getRegistry();
    const minor = Object.entries(registry).filter(([, v]) => v.type === 'minor');
    const major = Object.entries(registry).filter(([, v]) => v.type === 'major');

    const stagingCount = stagingItems.length;
    const stateReg = getStateRegistry();
    const stateCount = Object.keys(stateReg).length;
    const rels = getRelationships();
    const relCount = Object.values(rels).reduce((sum, arr) => sum + arr.length,0);
    const subTabBtns = ['staging', 'minor', 'major', 'state', 'relationships'].map(t =>
        `<button class="kt-subtab-btn ${activeSubTab === t ? 'kt-subtab-btn--active' : ''}" data-subtab="${t}">${t === 'staging' ? `Staging ${stagingCount >0 ? `(${stagingCount})` : ''}` : t === 'minor' ? `Minor (${minor.length})` : t === 'major' ? `Major (${major.length})` : t === 'state' ? `State (${stateCount})` : `Relationships (${relCount})`}</button>`
    ).join('');

    let content = '';
    if (activeSubTab === 'staging') content = renderStagingContent(stagingCount);
    else if (activeSubTab === 'minor') content = renderNpcListContent('minor', minor);
    else if (activeSubTab === 'major') content = renderNpcListContent('major', major);
    else if (activeSubTab === 'state') content = renderStateTrackerContent();
    else if (activeSubTab === 'relationships') content = renderRelationshipContent();

    el.innerHTML = `
        <div class="kt-npcs-container">
            <div class="kt-npcs-toolbar">
                ${isRunning ? '<button id="kt-scan" class="mwt-btn mwt-btn-primary" disabled>⏳ Scanning…</button>' : `<button id="kt-scan" class="mwt-btn mwt-btn-primary" ${!hasValidSettings() ? 'disabled' : ''}>🔍 Scan</button>`}
                <div class="kt-subtabs">${subTabBtns}</div>
                <button id="kt-npc-settings" class="mwt-btn" style="font-size:11px" title="Knowledge Tracker Settings">⚙ Settings</button>
                <button id="kt-npc-export" class="mwt-btn" style="font-size:11px">⬇ Export</button>
                <button id="kt-npc-import" class="mwt-btn" style="font-size:11px">⬆ Import</button>
                <button id="kt-npc-import-lorebook" class="mwt-btn" style="font-size:11px" title="Scan existing Knowledge Tracker & State Tracker lorebooks and register any entries not yet tracked in this chat">📚 From Lorebook</button>
            </div>
            <div id="kt-status" class="kt-status"></div>
            <div class="kt-subtab-content">${content}</div>
        </div>`;

    // Wire sub-tab clicks
    el.querySelectorAll('.kt-subtab-btn').forEach(btn => {
        btn.addEventListener('click', () => { activeSubTab = btn.dataset.subtab; renderNpcsSubTab(); });
    });

    // Wire settings button
    el.querySelector('#kt-npc-settings')?.addEventListener('click', () => showKnowledgeSettings());

    // Wire import/export buttons
    el.querySelector('#kt-npc-export')?.addEventListener('click', () => exportNpcs());
    el.querySelector('#kt-npc-import')?.addEventListener('click', () => importNpcs());
    el.querySelector('#kt-npc-import-lorebook')?.addEventListener('click', async () => {
        const btn = el.querySelector('#kt-npc-import-lorebook');
        try {
            btn.disabled = true; btn.textContent = '⏳…';
            ktSetStatus('Scanning lorebooks…', 'info');
            await importFromLorebooks();
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '📚 From Lorebook'; }
        }
    });

    // Wire scan button
    el.querySelector('#kt-scan')?.addEventListener('click', async () => {
        if (isRunning) return;
        isRunning = true;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        try {
            ktSetStatus('Scanning…', 'info');
            renderNpcsSubTab(); // Re-render to show "⏳ Scanning…" state
            activeSubTab = 'staging';
            const result = await runScan();
            const newItems = buildStagingItems(result);
            // Replace existing staging items with the same key instead of
            // silently dropping newer proposals from repeated scans.
            const added = [];
            for (const item of newItems) {
                const key = `${item.name}|${item.action}|${item.type}`;
                const existingIdx = stagingItems.findIndex(it => `${it.name}|${it.action}|${it.type}` === key);
                if (existingIdx >= 0) {
                    // Preserve the existing notification so the user isn't
                    // spammed with duplicate toasts for the same NPC.
                    removeNotificationEntry(stagingItems[existingIdx].id);
                    stagingItems[existingIdx] = item;
                } else {
                    stagingItems.push(item);
                }
                added.push(item);
            }
            activeItemId = null;
            await Promise.all(added.filter(it => it.action === 'update').map(it => enrichStagingItem(it)));
            added.forEach(item => addNotificationEntry(item));
            ktSetStatus(`Scan complete — ${added.length} proposal(s).`, 'success');
            try { if (typeof toastr !== 'undefined' && toastr?.[added.length ? 'info' : 'success']) toastr[added.length ? 'info' : 'success'](`Scan found ${added.length} proposal(s).`, 'Knowledge Tracker'); } catch { /* */ }
        } catch (err) {
            ktSetStatus(`Scan failed: ${err.message}`, 'error');
            try { if (typeof toastr !== 'undefined' && toastr?.error) toastr.error(`Scan failed: ${err.message}`, 'Knowledge Tracker'); } catch { /* */ }
        }
        finally { isRunning = false; document.dispatchEvent(new CustomEvent('mwt:busy-changed')); renderNpcsSubTab(); }
    });

    // Wire sub-tab specific events
    if (activeSubTab === 'staging') wireStagingEvents(el);
    else if (activeSubTab === 'minor' || activeSubTab === 'major') wireNpcListEvents(el, activeSubTab);
    else if (activeSubTab === 'state') wireStateTrackerEvents(el);
    else if (activeSubTab === 'relationships') wireRelationshipEvents(el);

    // Re-apply persisted status message — renderNpcsSubTab rebuilds #kt-status
    // as empty via innerHTML, so any status set before this call is lost.
    if (_lastKtStatusMsg) {
        const statusEl = el.querySelector('#kt-status');
        if (statusEl) {
            statusEl.textContent = _lastKtStatusMsg;
            statusEl.className = `kt-status kt-status--${_lastKtStatusLevel}`;
        }
    }
}

function renderStagingContent(count) {
    if (count === 0) return '<div class="kt-empty">No pending proposals.<br>Click <strong>🔍 Scan</strong> to analyse recent messages.</div>';
    return `
        <div class="kt-staging-toolbar">
            <button id="kt-batch-accept" class="mwt-btn mwt-btn-primary">✓ Accept All</button>
            <button id="kt-batch-dismiss" class="mwt-btn">✗ Dismiss All</button>
            <span>${count} proposal(s)</span>
        </div>
        <div class="kt-staging-layout">
            <div class="kt-staging-list" id="kt-staging-list">
                ${stagingItems.map(item => `
                    <div class="kt-staging-item ${activeItemId === item.id ? 'kt-staging-item--active' : ''}" data-id="${item.id}">
                        <span class="kt-staging-badge">${item.action === 'create' ? 'New' : 'Update'} ${item.type}</span>
                        <span class="kt-staging-name">${escapeHtml(item.name)}</span>
                    </div>`).join('')}
            </div>
            <div class="kt-staging-detail" id="kt-staging-detail">
                ${activeItemId ? renderDetailForItem(stagingItems.find(i => i.id === activeItemId)) : '<div class="kt-detail-empty">Select a proposal.</div>'}
            </div>
        </div>`;
}

function renderDetailForItem(item) {
    if (!item) return '<div class="kt-detail-empty">Select a proposal.</div>';
    const editorContent = item.mergedContent || item.proposedContent || '';

    // Build diff view when both existing and proposed content are available
    let diffHtml = '';
    if (item.existingContent && editorContent && item.existingContent !== editorContent) {
        const diff = renderLineDiff(item.existingContent, editorContent);
        if (diff) {
            diffHtml = `<div class="kt-detail-section">
                <div class="kt-detail-label">Changes (diff)</div>
                <div class="kt-detail-diff">${diff}</div>
            </div>`;
        }
    }

    return `<div class="kt-detail-inner">
        <div class="kt-detail-name">${escapeHtml(item.name)}</div>
        ${item.existingContent ? `<div class="kt-detail-section"><div class="kt-detail-label">Current</div><pre class="kt-detail-current">${escapeHtml(item.existingContent)}</pre></div>` : ''}
        ${diffHtml}
        <div class="kt-detail-section"><div class="kt-detail-label">Proposed</div><textarea class="kt-detail-editor" id="kt-proposal-editor">${escapeHtml(editorContent)}</textarea></div>
        ${item.type !== 'state' ? `<div class="kt-detail-section"><div class="kt-detail-label">Keywords</div><input class="kt-keyword-input" id="kt-keyword-input" type="text" value="${escapeHtml((item.keywords || [item.name]).join(', '))}" /></div>` : ''}
        <div class="kt-detail-actions"><button class="mwt-btn mwt-btn-primary" id="kt-accept">✓ Accept & Write</button><button class="mwt-btn" id="kt-dismiss">✗ Dismiss</button></div>
    </div>`;
}

function renderNpcListContent(type, entries) {
    if (entries.length === 0) return `<div class="kt-empty">No ${type} NPCs tracked yet.</div>`;
    const sorted = sortEntries(entries, 'name');
    return `<div class="kt-npc-list">${sorted.map(([name, info]) => {
        const isOrphan = info.uid === null || info.uid === undefined;
        return `<div class="kt-npc-card${isOrphan ? ' kt-npc-card--orphan' : ''}" data-name="${escapeHtml(name)}">
            <div class="kt-npc-card-header"><span class="kt-npc-name">${escapeHtml(name)}${isOrphan ? ' ⚠' : ''}</span><span class="kt-npc-meta">${(info.keywords || [name]).join(', ')}</span></div>
            <div class="kt-npc-actions">
                ${!isOrphan ? `
                    <button class="mwt-btn kt-npc-update" data-name="${escapeHtml(name)}" data-type="${type}">Update</button>
                    ${type === 'minor' ? `<button class="mwt-btn kt-npc-promote" data-name="${escapeHtml(name)}">⬆ Promote</button>` : ''}
                    ${type === 'major' ? `<button class="mwt-btn kt-npc-demote" data-name="${escapeHtml(name)}">⬇ Demote</button>` : ''}
                    <button class="mwt-btn kt-npc-view" data-name="${escapeHtml(name)}">📖 View</button>
                ` : ''}
                <button class="mwt-btn kt-npc-remove" data-name="${escapeHtml(name)}">Remove</button>
            </div></div>`;
    }).join('')}</div>`;
}

function wireStagingEvents(el) {
    // Click staging items
    el.querySelectorAll('.kt-staging-item').forEach(item => {
        item.addEventListener('click', async () => {
            activeItemId = item.dataset.id;
            const stagingItem = stagingItems.find(i => i.id === activeItemId);
            if (stagingItem && stagingItem.action === 'update' && stagingItem.existingContent === null && stagingItem.uid != null) {
                const existing = await loadEntryContent(stagingItem.uid);
                if (existing !== null) {
                    stagingItem.existingContent = existing;
                    if (stagingItem.type === 'minor') stagingItem.mergedContent = buildUpdatedMinorContent(existing, stagingItem.fields || {});
                    else if (stagingItem.type === 'major') stagingItem.mergedContent = buildUpdatedMajorContent(existing, stagingItem.fields || {}, stagingItem.newKnowledge || []);
                    else stagingItem.mergedContent = existing;
                }
            }
            renderNpcsSubTab();
        });
    });

    // Accept/dismiss buttons
    el.querySelector('#kt-accept')?.addEventListener('click', async () => {
        const item = stagingItems.find(i => i.id === activeItemId);
        if (!item) return;
        const editorVal = el.querySelector('#kt-proposal-editor')?.value;
        let text;
        if (editorVal) {
            text = editorVal;
        } else if (item.mergedContent && item.mergedContent !== '(promoting)' && item.mergedContent !== '(demoting)') {
            text = item.mergedContent;
        } else {
            text = item.proposedContent;
        }
        // Refuse to write placeholder text from promote/demote flow
        if (text === '(promoting)' || text === '(demoting)') {
            ktSetStatus('Click the staging item first to load full content before accepting.', 'error');
            return;
        }
        const keywordsRaw = el.querySelector('#kt-keyword-input')?.value || item.name;
        const keywords = item.type === 'state' ? [item.name] : keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);
        await handleAccept(item, text, keywords, el);
    });

    el.querySelector('#kt-dismiss')?.addEventListener('click', () => {
        stagingItems = stagingItems.filter(i => i.id !== activeItemId);
        activeItemId = null;
        renderNpcsSubTab();
    });

    // Batch buttons
    el.querySelector('#kt-batch-accept')?.addEventListener('click', async () => {
        if (!confirm(`Accept all ${stagingItems.length} proposals?`)) return;
        for (const item of [...stagingItems]) {
            try { await handleAccept(item, item.mergedContent || item.proposedContent, item.keywords || [item.name], el); } catch (e) { console.warn('[MWT:Knowledge] Batch accept failed:', e); }
        }
        renderNpcsSubTab();
    });

    el.querySelector('#kt-batch-dismiss')?.addEventListener('click', () => {
        if (!confirm(`Dismiss all ${stagingItems.length} proposals?`)) return;
        stagingItems = [];
        activeItemId = null;
        renderNpcsSubTab();
    });
}

function wireNpcListEvents(el, type) {
    el.querySelectorAll('.kt-npc-update').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const npcType = btn.dataset.type;
            const reg = getRegistry()[name];
            if (!reg?.uid && reg?.uid !== 0) { ktSetStatus(`No UID for "${name}".`, 'error'); return; }
            try {
                btn.disabled = true; btn.textContent = '⏳…';
                const result = await runNpcUpdate(name, reg.uid);
                const hasChanges = Object.values(result.fields).some(v => v !== null) || result.newKnowledge.length > 0;
                if (!hasChanges) { ktSetStatus(`No new info for "${name}".`, 'info'); return; }
                const mergedContent = npcType === 'minor'
                    ? buildUpdatedMinorContent(result.currentContent, result.fields || {})
                    : buildUpdatedMajorContent(result.currentContent, result.fields || {}, result.newKnowledge || []);
                stagingItems.push({
                    id: `npc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: npcType, action: 'update', name, data: {},
                    proposedContent: mergedContent, existingContent: result.currentContent,
                    mergedContent, keywords: reg.keywords || [name], uid: reg.uid,
                    fields: result.fields, newKnowledge: npcType === 'major' ? (result.newKnowledge || []) : [],
                });
                const stagedItem = stagingItems[stagingItems.length - 1];
                activeItemId = stagedItem.id;
                activeSubTab = 'staging';
                addNotificationEntry(stagedItem);
                renderNpcsSubTab();
                ktSetStatus(`Update for "${name}" staged.`, 'success');
            } catch (err) { ktSetStatus(`Update failed: ${err.message}`, 'error'); }
            finally { btn.disabled = false; btn.textContent = 'Update'; }
        });
    });

    el.querySelectorAll('.kt-npc-promote').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const reg = getRegistry()[name];
            if (reg?.uid == null) return; // uid 0 is valid — first entry in a fresh lorebook
            const existing = await loadEntryContent(reg.uid);
            const item = {
                id: `promote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'promote', action: 'update', name, data: {},
                proposedContent: '(promoting)', existingContent: existing,
                mergedContent: existing ? buildPromotedContent(existing) : '',
                keywords: reg.keywords || [name], uid: reg.uid, fromType: 'minor', toType: 'major',
            };
            stagingItems.push(item);
            addNotificationEntry(item);
            activeItemId = item.id;
            activeSubTab = 'staging';
            renderNpcsSubTab();
        });
    });

    el.querySelectorAll('.kt-npc-demote').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const reg = getRegistry()[name];
            if (reg?.uid == null) return; // uid 0 is valid — first entry in a fresh lorebook
            const existing = await loadEntryContent(reg.uid);
            const item = {
                id: `demote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'demote', action: 'update', name, data: {},
                proposedContent: '(demoting)', existingContent: existing,
                mergedContent: existing ? buildDemotedContent(existing) : '',
                keywords: reg.keywords || [name], uid: reg.uid, fromType: 'major', toType: 'minor',
            };
            stagingItems.push(item);
            addNotificationEntry(item);
            activeItemId = item.id;
            activeSubTab = 'staging';
            renderNpcsSubTab();
        });
    });

    el.querySelectorAll('.kt-npc-view').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const reg = getRegistry()[name];
            if (!reg?.uid && reg?.uid !== 0) return;
            const content = await loadEntryContent(reg.uid);
            if (content) {
                const viewModal = document.createElement('div');
                viewModal.id = 'kt-view-modal';
                viewModal.innerHTML = `<div class="kt-history-backdrop"></div><div class="kt-history-panel"><div class="kt-history-header"><h3>${escapeHtml(name)}</h3><button class="kt-history-close">✕</button></div><div class="kt-history-body"><pre>${escapeHtml(content)}</pre></div></div>`;
                document.body.appendChild(viewModal);
                viewModal.querySelector('.kt-history-close').addEventListener('click', () => viewModal.remove());
                viewModal.querySelector('.kt-history-backdrop').addEventListener('click', () => viewModal.remove());
            }
        });
    });

    el.querySelectorAll('.kt-npc-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.name;
            if (!confirm(`Remove "${name}" from registry? (Lorebook entry stays.)`)) return;
            // Clean up any staging items and notifications for this NPC
            stagingItems = stagingItems.filter(i => i.name !== name);
            if (activeItemId && !stagingItems.find(i => i.id === activeItemId)) activeItemId = null;
            for (const id of Object.keys(notificationEntries)) {
                if (notificationEntries[id]?.item?.name === name) removeNotificationEntry(id);
            }
            const reg = getRegistry();
            delete reg[name];
            saveRegistry(reg);
            renderNpcsSubTab();
        });
    });
}

// ─── State Trackers render ───────────────────────────────────────────────────

/** Returns HTML for the State Trackers sub-tab (rendered inside the Knowledge tab) */
function renderStateTrackerContent() {
    const reg = getStateRegistry();
    const entries = Object.entries(reg);

    return `
        <div class="kt-state-container">
            <div class="kt-state-toolbar">
                <button id="kt-state-export" class="mwt-btn">⬇ Export</button>
                <button id="kt-state-import" class="mwt-btn">⬆ Import</button>
                <input type="file" id="kt-state-import-file" accept=".json" style="display:none" />
            </div>
            <div class="kt-state-register">
                <h3>Register a State Tracker</h3>
                <p style="color:var(--mwt-text-dim);font-size:12px">Create a lorebook entry in <strong>${STATE_LOREBOOK_NAME}</strong> with comment starting with <code>${TRACKER_SENTINEL}</code>.</p>
                <div style="display:flex;gap:8px;margin-top:8px">
                    <input type="number" id="kt-state-uid" placeholder="UID" min="0" class="mwt-input" style="width:80px" />
                    <input type="text" id="kt-state-name" placeholder="Display name" class="mwt-input" style="flex:1" />
                    <button id="kt-state-register" class="mwt-btn mwt-btn-primary">Register</button>
                </div>
            </div>
            ${entries.length === 0 ? '<div class="kt-empty">No state trackers registered.</div>' : `
            <div class="kt-state-list">
                ${entries.map(([name, info]) => {
                    const enabled = info.enabled !== false;
                    const alwaysUpdate = !!info.alwaysUpdate;
                    return `<div class="kt-npc-card">
                        <div class="kt-npc-card-header"><span class="kt-npc-name">${escapeHtml(name)}</span><span class="kt-npc-meta">UID ${info.uid}${enabled ? '' : ' · off'}${alwaysUpdate ? ' · always' : ''}</span></div>
                        <div class="kt-npc-actions">
                            <label><input type="checkbox" class="kt-state-enabled" data-name="${escapeHtml(name)}" ${enabled ? 'checked' : ''} /> Auto</label>
                            <label><input type="checkbox" class="kt-state-always" data-name="${escapeHtml(name)}" ${alwaysUpdate ? 'checked' : ''} /> Always</label>
                            <button class="mwt-btn kt-state-update" data-name="${escapeHtml(name)}">Update</button>
                            <button class="mwt-btn kt-state-remove" data-name="${escapeHtml(name)}">Remove</button>
                            <button class="mwt-btn kt-state-view" data-name="${escapeHtml(name)}">📖 View</button>
                        </div></div>`;
                }).join('')}
            </div>`}
        </div>`;
}

/** Wires events for the State Trackers sub-tab */
function wireStateTrackerEvents(el) {
    el.querySelector('#kt-state-register')?.addEventListener('click', async () => {
        const uid = parseInt(el.querySelector('#kt-state-uid')?.value, 10);
        const name = el.querySelector('#kt-state-name')?.value?.trim();
        if (Number.isNaN(uid) || !name) { ktSetStatus('Enter both UID and name.', 'error'); return; }
        const loaded = await loadStateTrackerEntry(uid);
        if (!loaded) { ktSetStatus(`UID ${uid} not found.`, 'error'); return; }
        if (!loaded.comment.startsWith(TRACKER_SENTINEL)) { ktSetStatus(`Missing ${TRACKER_SENTINEL} sentinel.`, 'error'); return; }
        registerStateTracker(name, uid);
        renderNpcsSubTab();
    });

    el.querySelectorAll('.kt-state-enabled').forEach(cb => {
        cb.addEventListener('change', () => { setStateTrackerEnabled(cb.dataset.name, cb.checked); renderNpcsSubTab(); });
    });

    el.querySelectorAll('.kt-state-always').forEach(cb => {
        cb.addEventListener('change', () => { setStateTrackerAlwaysUpdate(cb.dataset.name, cb.checked); renderNpcsSubTab(); });
    });

    el.querySelectorAll('.kt-state-update').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const info = getStateRegistry()[name];
            if (!info) return;
            try {
                btn.disabled = true; btn.textContent = '⏳…';
                const result = await runStateUpdate(name, info.uid);
                if (result.unchanged) { bumpStateTrackerTimestamp(name); renderNpcsSubTab(); ktSetStatus(`No change for "${name}".`, 'info'); return; }
                const stagingItem = {
                    id: `state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'state', action: 'update', name, data: {},
                    proposedContent: result.merged, existingContent: result.currentContent,
                    mergedContent: result.merged, keywords: [name], uid: info.uid,
                };
                const existingIdx = stagingItems.findIndex(it => it.type === 'state' && it.uid === info.uid);
                if (existingIdx >= 0) {
                    removeNotificationEntry(stagingItems[existingIdx].id);
                    stagingItems[existingIdx] = stagingItem;
                }
                else stagingItems.push(stagingItem);
                activeItemId = stagingItem.id;
                activeSubTab = 'staging';
                addNotificationEntry(stagingItem);
                renderNpcsSubTab();
                ktSetStatus(`State update for "${name}" staged.`, 'success');
            } catch (err) { ktSetStatus(`Update failed: ${err.message}`, 'error'); }
            finally { btn.disabled = false; btn.textContent = 'Update'; }
        });
    });

    el.querySelectorAll('.kt-state-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!confirm(`Remove "${btn.dataset.name}"? (Lorebook entry stays.)`)) return;
            unregisterStateTracker(btn.dataset.name);
            renderNpcsSubTab();
        });
    });

    el.querySelectorAll('.kt-state-view').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const info = getStateRegistry()[name];
            if (!info) return;
            const loaded = await loadStateTrackerEntry(info.uid);
            if (loaded) {
                const viewModal = document.createElement('div');
                viewModal.id = 'kt-view-modal';
                viewModal.innerHTML = `<div class="kt-history-backdrop"></div><div class="kt-history-panel"><div class="kt-history-header"><h3>${escapeHtml(name)}</h3><button class="kt-history-close">✕</button></div><div class="kt-history-body"><pre>${escapeHtml(loaded.content)}</pre></div></div>`;
                document.body.appendChild(viewModal);
                viewModal.querySelector('.kt-history-close').addEventListener('click', () => viewModal.remove());
                viewModal.querySelector('.kt-history-backdrop').addEventListener('click', () => viewModal.remove());
            }
        });
    });

    el.querySelector('#kt-state-export')?.addEventListener('click', async () => {
        const trackers = {};
        for (const [name, info] of Object.entries(getStateRegistry())) {
            const loaded = await loadStateTrackerEntry(info.uid);
            trackers[name] = { uid: info.uid, content: loaded?.content || null };
        }
        const blob = new Blob([JSON.stringify({ version: 1, trackers }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `state-trackers-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    el.querySelector('#kt-state-import')?.addEventListener('click', () => el.querySelector('#kt-state-import-file')?.click());
    el.querySelector('#kt-state-import-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        try {
            const text = await file.text();
            const snapshot = JSON.parse(text);
            if (!snapshot.trackers) throw new Error('Invalid format');
            for (const [name, data] of Object.entries(snapshot.trackers)) {
                if (data.uid !== undefined) registerStateTracker(name, data.uid);
            }
            renderNpcsSubTab();
            ktSetStatus('State trackers imported.', 'success');
        } catch (err) { ktSetStatus(`Import failed: ${err.message}`, 'error'); }
    });
}

/** Legacy — now delegates to renderNpcsSubTab which handles the state sub-tab */
function renderStateContent() {
    renderNpcsSubTab();
}

// ─── NPC Export / Import ─────────────────────────────────────────────────────

function exportNpcs() {
    const registry = getRegistry();
    const entries = {};
    for (const [name, info] of Object.entries(registry)) {
        entries[name] = {
            uid: info.uid ?? null,
            type: info.type || 'minor',
            keywords: info.keywords || [name],
            lastUpdated: info.lastUpdated || null,
            content: null,
            history: [],
        };
    }
    // Strip API key from export to avoid leaking credentials in plain text
    const { apiKey, ...safeSettings } = getSettings();
    const data = {
        version: 1,
        type: 'knowledge_tracker',
        exportedAt: new Date().toISOString(),
        lorebook: LOREBOOK_NAME,
        settings: safeSettings,
        entries,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `knowledge-tracker-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    ktSetStatus('NPC registry exported (API key excluded for security).', 'success');
}

async function importNpcs() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);

            // Support original format: { entries: { name: { uid, type, keywords, content, history } }, settings: {...} }
            // Also support merged format: same structure
            if (!data.entries || typeof data.entries !== 'object') {
                throw new Error('Invalid format: missing "entries" object.');
            }

            let imported = 0;
            let skipped = 0;
            let settingsImported = false;
            const registry = getRegistry();

            // Import settings if present
            if (data.settings && data.type === 'knowledge_tracker') {
                if (confirm('Import settings too? (API URL, key, model, etc.)')) {
                    saveSettings({ ...getSettings(), ...data.settings });
                    settingsImported = true;
                }
            }

            for (const [name, entry] of Object.entries(data.entries)) {
                if (registry[name] && registry[name].uid !== null && registry[name].uid !== undefined) {
                    // Already tracked — skip
                    skipped++;
                    continue;
                }

                // Register in metadata
                registry[name] = {
                    uid: entry.uid ?? null,
                    type: entry.type || 'minor',
                    keywords: entry.keywords || [name],
                    lastUpdated: entry.lastUpdated || Date.now(),
                };
                imported++;

                // If content provided and lorebook is available, try writing to lorebook
                if (entry.content && wiScript && entry.uid == null) {
                    try {
                        const result = await writeToLorebook(name, entry.content, entry.keywords || [name], null);
                        if (result.success) {
                            registry[name].uid = result.uid;
                        }
                    } catch (err) {
                        console.warn(`[MWT:Knowledge] Import write failed for "${name}":`, err.message);
                    }
                }

                // Restore history if present
                const finalUid = registry[name].uid;
                if (entry.history && Array.isArray(entry.history) && entry.history.length > 0 && finalUid != null) {
                    try {
                        const key = HISTORY_KEY_PREFIX + finalUid;
                        localStorage.setItem(key, JSON.stringify(entry.history));
                    } catch { /* quota */ }
                }
            }

            saveRegistry(registry);
            renderNpcsSubTab();

            let msg = `Imported ${imported} NPC(s).`;
            if (skipped > 0) msg += ` ${skipped} already tracked (skipped).`;
            if (settingsImported) msg += ' Settings restored.';
            ktSetStatus(msg, 'success');
        } catch (err) {
            ktSetStatus(`Import failed: ${err.message}`, 'error');
        }
    };
    input.click();
}

// ─── Lorebook scan (auto-discover existing entries) ─────────────────────────
//
// Scans the "Knowledge Tracker" and "State Tracker" lorebooks for entries
// that aren't yet registered in this chat, and registers them. Lets users
// who already populated their lorebooks skip the manual re-creation step.
//
// Detection rules:
//   - Knowledge Tracker: every entry whose `comment` is non-empty is treated
//     as an NPC, named by the comment. Major vs. minor is inferred from the
//     presence of "Knowledge Ledger:" in the content.
//   - State Tracker: only entries whose `comment` starts with the
//     `[Tracker]` sentinel are registered. The display name is whatever
//     follows the sentinel.

async function importFromLorebooks() {
    if (!wiScript) {
        ktSetStatus('World-info script not available.', 'error');
        return;
    }

    let imported = { npcs: 0, states: 0 };
    let skipped  = { npcs: 0, states: 0 };
    const errors = [];

    // ── Knowledge Tracker ───────────────────────────────────────────────
    try {
        const ktWi = await wiScript.loadWorldInfo(LOREBOOK_NAME);
        if (ktWi?.entries) {
            const registry = getRegistry();
            const playerSet = new Set(getPlayerNames().map(n => n.toLowerCase()));

            for (const [uidStr, entry] of Object.entries(ktWi.entries)) {
                const name = String(entry.comment || '').trim();
                if (!name) continue;
                if (playerSet.has(name.toLowerCase())) continue;
                const existing = registry[name];
                if (existing && existing.uid !== null && existing.uid !== undefined) {
                    skipped.npcs++;
                    continue;
                }
                const isMajor = /knowledge ledger\s*:/i.test(entry.content || '');
                const uid = entry.uid ?? Number(uidStr);
                const keywords = Array.isArray(entry.key) && entry.key.length ? entry.key : [name];
                registry[name] = {
                    uid: Number.isFinite(uid) ? uid : null,
                    type: isMajor ? 'major' : 'minor',
                    keywords,
                    lastUpdated: Date.now(),
                };
                imported.npcs++;
            }
            saveRegistry(registry);
        }
    } catch (err) {
        errors.push(`Knowledge Tracker: ${err.message}`);
    }

    // ── State Tracker ───────────────────────────────────────────────────
    try {
        const stWi = await wiScript.loadWorldInfo(STATE_LOREBOOK_NAME);
        if (stWi?.entries) {
            const stateReg = getStateRegistry();

            for (const [uidStr, entry] of Object.entries(stWi.entries)) {
                const comment = String(entry.comment || '').trim();
                if (!comment.startsWith(TRACKER_SENTINEL)) continue;
                const displayName = comment.slice(TRACKER_SENTINEL.length).trim() || `Tracker ${uidStr}`;
                if (stateReg[displayName]) {
                    skipped.states++;
                    continue;
                }
                const uid = entry.uid ?? Number(uidStr);
                stateReg[displayName] = {
                    uid: Number.isFinite(uid) ? uid : null,
                    lastUpdatedMsg: 0,
                    lastUpdatedAt: 0,
                    enabled: true,
                    alwaysUpdate: false,
                };
                imported.states++;
            }
            saveStateRegistry(stateReg);
        }
    } catch (err) {
        errors.push(`State Tracker: ${err.message}`);
    }

    // ── Report ──────────────────────────────────────────────────────────
    renderNpcsSubTab();

    const parts = [];
    if (imported.npcs)   parts.push(`${imported.npcs} NPC(s)`);
    if (imported.states) parts.push(`${imported.states} state tracker(s)`);
    let msg = parts.length ? `Imported ${parts.join(' and ')}.` : 'Nothing new to import.';
    if (skipped.npcs + skipped.states > 0) msg += ` (${skipped.npcs + skipped.states} already tracked.)`;
    if (errors.length) msg += ` Errors: ${errors.join('; ')}`;
    ktSetStatus(msg, errors.length ? 'error' : 'success');
    try {
        if (typeof toastr !== 'undefined' && toastr?.[parts.length ? 'success' : 'info']) {
            toastr[parts.length ? 'success' : 'info'](msg, 'Knowledge Tracker');
        }
    } catch { /* */ }
}

// ─── Knowledge Settings Panel ────────────────────────────────────────────────

function showKnowledgeSettings() {
    const el = getNpcsContentEl();
    if (!el) return;
    const s = getSettings();
    el.innerHTML = `<div class="kt-settings-form">
        <h3>Knowledge Tracker Settings</h3>
        <div class="mwt-settings-grid">
            <label class="mwt-label">API URL</label><input id="kt-cfg-api-url" class="mwt-input" value="${escapeHtml(s.apiUrl)}" placeholder="https://api.openai.com/v1">
            <label class="mwt-label">API Key</label><input id="kt-cfg-api-key" class="mwt-input" type="password" value="${escapeHtml(s.apiKey)}">
            <label class="mwt-label">Model</label><input id="kt-cfg-model" class="mwt-input" value="${escapeHtml(s.modelName)}" placeholder="gpt-4o">
            <label class="mwt-label">Max Tokens</label><input id="kt-cfg-max-tokens" class="mwt-input" type="number" value="${s.maxTokens || 2000}" min="100" max="32000">
            <label class="mwt-label">Temperature</label><input id="kt-cfg-temp" class="mwt-input" type="number" value="${s.temperature ?? 0.1}" min="0" max="2" step="0.1">
            <label class="mwt-label">Top P</label><input id="kt-cfg-top-p" class="mwt-input" type="number" value="${s.topP ?? 1.0}" min="0" max="1" step="0.05">
            <label class="mwt-label">Freq Penalty</label><input id="kt-cfg-freq-pen" class="mwt-input" type="number" value="${s.frequencyPenalty ?? 0}" min="-2" max="2" step="0.1">
            <label class="mwt-label">Pres Penalty</label><input id="kt-cfg-pres-pen" class="mwt-input" type="number" value="${s.presencePenalty ?? 0}" min="-2" max="2" step="0.1">
            <label class="mwt-label">Custom Headers</label><input id="kt-cfg-headers" class="mwt-input" value="${escapeHtml(s.customHeaders || '')}" placeholder='{"X-Custom":"value"}'>
            <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Custom Headers: JSON object of extra HTTP headers. Leave blank if unsure.</p>
        </div>
        <div style="margin-top:12px">
            <label><input type="checkbox" id="kt-cfg-auto-trigger" ${s.autoTriggerEnabled ? 'checked' : ''}> Auto-trigger state tracker updates</label>
            <div style="margin-top:6px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                <label style="font-size:12px;color:var(--mwt-text-dim)">Every <input type="number" id="kt-cfg-auto-every" class="mwt-input" style="width:60px;display:inline-block" value="${s.autoTriggerEveryN || 5}" min="1" max="100"> messages</label>
                <label style="font-size:12px;color:var(--mwt-text-dim)">Cooldown <input type="number" id="kt-cfg-cooldown" class="mwt-input" style="width:60px;display:inline-block" value="${s.trackerCooldownMsgs || 3}" min="0" max="50"> messages</label>
            </div>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">Auto-trigger scans state trackers every N user messages. Cooldown prevents re-updating recently changed trackers.</p>
        </div>
        <div class="mwt-flex mwt-gap-4 mwt-mt-8" style="margin-top:12px">
            <button id="kt-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button>
            <button id="kt-cancel-settings" class="mwt-btn">Cancel</button>
        </div>
        <div id="kt-status" class="kt-status" style="margin-top:8px"></div>
    </div>`;

    el.querySelector('#kt-save-settings')?.addEventListener('click', () => {
        saveSettings({
            apiUrl: el.querySelector('#kt-cfg-api-url')?.value || '',
            apiKey: el.querySelector('#kt-cfg-api-key')?.value || '',
            modelName: el.querySelector('#kt-cfg-model')?.value || '',
            maxTokens: Number(el.querySelector('#kt-cfg-max-tokens')?.value) || 2000,
            temperature: Number(el.querySelector('#kt-cfg-temp')?.value),
            topP: Number(el.querySelector('#kt-cfg-top-p')?.value),
            frequencyPenalty: Number(el.querySelector('#kt-cfg-freq-pen')?.value),
            presencePenalty: Number(el.querySelector('#kt-cfg-pres-pen')?.value),
            customHeaders: el.querySelector('#kt-cfg-headers')?.value || '',
            autoTriggerEnabled: el.querySelector('#kt-cfg-auto-trigger')?.checked ?? false,
            autoTriggerEveryN: Number(el.querySelector('#kt-cfg-auto-every')?.value) || 5,
            trackerCooldownMsgs: Number(el.querySelector('#kt-cfg-cooldown')?.value) || 3,
        });
        activeSubTab = 'staging';
        renderNpcsSubTab();
        ktSetStatus('Settings saved.', 'success');
    });
    el.querySelector('#kt-cancel-settings')?.addEventListener('click', () => {
        activeSubTab = 'staging';
        renderNpcsSubTab();
    });
}

// ─── Relationship sub-tab ────────────────────────────────────────────────────

function renderRelationshipContent() {
    const rels = getRelationships();
    const npcNames = getAllNpcNames();
    const allEdges = [];
    for (const [from, targets] of Object.entries(rels)) {
        for (const r of targets) {
            allEdges.push({ from, to: r.target, type: r.type, notes: r.notes || '' });
        }
    }

    const npcOptions = npcNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    const typeOptions = RELATIONSHIP_TYPES.map(t => `<option value="${t}">${t}</option>`).join('') + '<option value="__other__">Other…</option>';

    return `
       <div class="kt-rel-container">
           <div class="kt-rel-toolbar">
               <button id="kt-rel-sync-all" class="mwt-btn mwt-btn-primary" title="Write relationship blocks to all NPC lorebook entries">💾 Sync to Lorebooks</button>
               <span style="font-size:12px;color:var(--mwt-text-dim)">${allEdges.length} relationship(s)</span>
            </div>
           <div class="kt-rel-add-row">
               <select id="kt-rel-from" class="mwt-input" style="min-width:120px"><option value="">From…</option>${npcOptions}</select>
               <select id="kt-rel-type" class="mwt-input" style="min-width:100px">${typeOptions}</select>
               <input id="kt-rel-type-custom" class="mwt-input" type="text" placeholder="Custom type…" style="display:none;min-width:100px" />
               <select id="kt-rel-to" class="mwt-input" style="min-width:120px"><option value="">To…</option>${npcOptions}</select>
               <input id="kt-rel-notes" class="mwt-input" type="text" placeholder="Notes (optional)" style="flex:1;min-width:120px" />
               <button id="kt-rel-add" class="mwt-btn mwt-btn-primary">+ Add</button>
            </div>
            ${allEdges.length === 0 ? '<div class="kt-empty">No relationships tracked yet.</div>' : `
           <div class="kt-rel-list">
                ${allEdges.map(e => {
                    const reverse = (rels[e.to] || []).find(r => r.target === e.from);
                    const reverseLabel = reverse ? `<span class="kt-rel-reverse" title="${escapeHtml(e.to)} sees ${escapeHtml(e.from)} as: ${escapeHtml(reverse.type)}">↩ ${escapeHtml(reverse.type)}</span>` : '';
                    return `<div class="kt-rel-row" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}">
                       <span class="kt-rel-from">${escapeHtml(e.from)}</span>
                       <span class="kt-rel-type">${escapeHtml(e.type)}</span>
                       <span class="kt-rel-to">${escapeHtml(e.to)}</span>
                        ${e.notes ? `<span class="kt-rel-notes">${escapeHtml(e.notes)}</span>` : ''}
                        ${reverseLabel}
                       <button class="kt-rel-remove" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}" title="Remove">✕</button>
                    </div>`;
                }).join('')}
            </div>`}
        </div>`;
}

function wireRelationshipEvents(el) {
    // Show/hide custom type input when "Other…" is selected
    const typeSelect = el.querySelector('#kt-rel-type');
    const customInput = el.querySelector('#kt-rel-type-custom');
    if (typeSelect && customInput) {
        typeSelect.addEventListener('change', () => {
            customInput.style.display = typeSelect.value === '__other__' ? '' : 'none';
            if (typeSelect.value === '__other__') customInput.focus();
        });
    }

    el.querySelector('#kt-rel-add')?.addEventListener('click', async () => {
        const from = el.querySelector('#kt-rel-from')?.value;
        const to = el.querySelector('#kt-rel-to')?.value;
        let type = el.querySelector('#kt-rel-type')?.value;
        if (type === '__other__') {
            type = customInput?.value?.trim() || '';
        }
        const notes = el.querySelector('#kt-rel-notes')?.value?.trim() || '';
        if (!from || !to || !type) { ktSetStatus('Select From, Type, and To.', 'error'); return; }
        if (from === to) { ktSetStatus('An NPC cannot have a relationship with themselves.', 'error'); return; }
        const npcNames = getAllNpcNames();
        if (!npcNames.includes(from)) { ktSetStatus(`"${from}" is not a known NPC.`, 'error'); return; }
        if (!npcNames.includes(to)) { ktSetStatus(`"${to}" is not a known NPC.`, 'error'); return; }
        updateRelationship(from, to, type, notes);
        // Sync to lorebook for the "from" NPC
        try {
            const result = await syncRelationshipsToLorebook(from);
            if (result.success && !result.unchanged) {
                ktSetStatus(`Relationship added and synced to "${from}" lorebook.`, 'success');
            } else if (result.success) {
                ktSetStatus(`Relationship added (lorebook unchanged).`, 'success');
            } else {
                ktSetStatus(`Relationship added but lorebook sync failed: ${result.error}`, 'warning');
            }
        } catch (err) {
            ktSetStatus(`Relationship added but sync failed: ${err.message}`, 'warning');
        }
        renderNpcsSubTab();
    });

    el.querySelectorAll('.kt-rel-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
            const from = btn.dataset.from;
            const to = btn.dataset.to;
            if (!confirm(`Remove relationship: ${from} → ${to}?`)) return;
            removeRelationship(from, to);
            // Also strip the block from the lorebook entry
            try {
                await syncRelationshipsToLorebook(from);
            } catch (err) { /* ignore */ }
            renderNpcsSubTab();
        });
    });

    el.querySelector('#kt-rel-sync-all')?.addEventListener('click', async () => {
        const btn = el.querySelector('#kt-rel-sync-all');
        try {
            btn.disabled = true; btn.textContent = '⏳ Syncing…';
            const result = await syncAllRelationshipsToLorebooks();
            ktSetStatus(`Synced ${result.synced} lorebook(s). ${result.failed > 0 ? result.failed + ' failed.' : ''}`, result.failed > 0 ? 'warning' : 'success');
        } catch (err) {
            ktSetStatus(`Sync failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false; btn.textContent = '💾 Sync to Lorebooks';
        }
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(parentModal) {
    if (parentModal) {
        modal = parentModal;
        npcsContentEl = null;
        stateContentEl = null;
    }
    initNotificationPanel();
    console.log('[MWT:Knowledge] Module initialized');
}

export function render() {
    // Returns the merged Knowledge tab container — NPCs + State Trackers + Staging
    // all in one tab with sub-tabs. renderNpcsSubTab() and renderStateContent()
    // populate the inner divs when getModuleWireEvents fires.
    return '<div id="mwt-kt-npcs-content"></div>';
}

export function renderStateTrackers() {
    // State trackers are now merged into the Knowledge tab as a sub-tab.
    // This export still exists for backwards compat but just delegates to render().
    return render();
}

export function getModuleRender() { return render; }
export function getModuleWireEvents() {
    return () => {
        // The modal body is rebuilt (innerHTML) on every open, so the cached
        // content element goes stale and init() only runs once. Re-query and
        // re-render here or the tab renders into detached DOM (appears blank).
        npcsContentEl = null;
        stateContentEl = null;
        renderNpcsSubTab();
    };
}
export function getModuleRefreshContent() { return renderNpcsSubTab; }

export function onMessageReceived() {
    const settings = getSettings();
    if (!settings.autoTriggerEnabled) return;
    if (!hasValidSettings()) return; // Don't auto-trigger without API config
    const everyN = Math.max(1, Number(settings.autoTriggerEveryN) || 5);
    const cooldownMsgs = Math.max(0, Number(settings.trackerCooldownMsgs) || 3);
    messageCounter++;
    if (messageCounter < everyN) return;
    messageCounter = 0;

    queueTrackerWork(async () => {
        if (isRunning) return;
        isRunning = true;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
        try {
            const reg = getStateRegistry();
            const currentMsgIdx = getChat()?.length || 0;
            const recent = getRecentMessages(30);
            let staged = 0;
            for (const [name, info] of Object.entries(reg)) {
                if (info.enabled === false) continue;
                if (!info.alwaysUpdate) {
                    if (currentMsgIdx - (info.lastUpdatedMsg || 0) < cooldownMsgs) continue;
                    const nameRe = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i');
                    if (!nameRe.test(recent || '')) continue;
                }
                try {
                    const result = await runStateUpdate(name, info.uid);
                    if (result.unchanged) { bumpStateTrackerTimestamp(name); continue; }
                    const stagingItem = {
                        id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'state', action: 'update', name, data: {},
                        proposedContent: result.merged, existingContent: result.currentContent,
                        mergedContent: result.merged, keywords: [name], uid: info.uid,
                    };
                    const existingIdx = stagingItems.findIndex(it => it.type === 'state' && it.uid === info.uid);
                    if (existingIdx >= 0) {
                        // Update notification for existing item
                        removeNotificationEntry(stagingItems[existingIdx].id);
                        stagingItems[existingIdx] = stagingItem;
                    } else {
                        stagingItems.push(stagingItem);
                    }
                    addNotificationEntry(stagingItem);
                    staged++;
                } catch (err) { console.warn(`[MWT:Knowledge] Auto-update "${name}" failed:`, err.message); }
            }
            if (staged > 0) {
                console.log(`[MWT:Knowledge] Auto-trigger: ${staged} state proposal(s) staged.`);
                try { if (typeof toastr !== 'undefined' && toastr?.info) toastr.info(`${staged} state tracker update(s) ready for review.`, 'Knowledge Tracker'); } catch { /* */ }
            }
        } finally { isRunning = false; document.dispatchEvent(new CustomEvent('mwt:busy-changed')); }
    });
}

export function onChatChanged() {
    messageCounter = 0;
    isRunning = false;
    stagingItems = [];
    activeItemId = null;
    activeSubTab = 'staging';
    _cachedTokenCount = 0;
    notificationEntries = {};
    hideNotificationPanel();
    // Clean up any orphaned view modals
    document.querySelectorAll('#kt-view-modal').forEach(m => m.remove());
}

export function getTotalTokens() {
    // Return the last cached token count (updated asynchronously).
    // Lorebook content requires async API calls that can't be awaited here.
    return _cachedTokenCount;
}

/**
 * Recomputes the total token count for all tracked NPC and State Tracker entries.
 * This is async because it needs to load lorebook entries from disk.
 */
export async function refreshTotalTokens() {
    // Guard against overlapping refreshes: a slow run can otherwise finish
    // after a newer one and write a stale count, causing the badge to flicker.
    if (_refreshingTokens) return _cachedTokenCount;
    _refreshingTokens = true;
    try {
        const registry = getRegistry();
        let total = 0;
        // Count NPC entries
        for (const [name, info] of Object.entries(registry)) {
            if (info.uid === null || info.uid === undefined) continue;
            try {
                const content = await loadEntryContent(info.uid);
                if (content) total += estimateTokens(content);
            } catch { /* skip */ }
        }
        // Count State Tracker entries
        const stateReg = getStateRegistry();
        for (const [name, info] of Object.entries(stateReg)) {
            if (info.uid === null || info.uid === undefined) continue;
            try {
                const loaded = await loadStateTrackerEntry(info.uid);
                if (loaded?.content) total += estimateTokens(loaded.content);
            } catch { /* skip */ }
        }
        _cachedTokenCount = total;
        return total;
    } catch (err) {
        // Logged loudly on purpose: a silent failure here previously masked a
        // missing estimateTokens import for a long time. Keep it visible.
        console.error('[MWT:Knowledge] Token refresh failed:', err);
        return _cachedTokenCount;
    } finally {
        _refreshingTokens = false;
    }
}

export function syncGlobalSettings(patch) {
    if (patch?.apiUrl !== undefined || patch?.apiKey !== undefined || patch?.modelName !== undefined) {
        saveSettings({
            ...getSettings(),
            connectionProfileId: patch.connectionProfileId ?? getSettings().connectionProfileId,
            apiUrl: patch.apiUrl ?? getSettings().apiUrl,
            apiKey: patch.apiKey ?? getSettings().apiKey,
            modelName: patch.modelName ?? getSettings().modelName,
        });
        console.log('[MWT:Knowledge] Synced global API settings');
    }
}

/** Slash command: trigger an NPC scan */
export async function triggerScan() {
    return runScan();
}

/** Slash command / macro: scan and auto-accept all */
export async function scanAndAccept() {
    const scanResult = await runScan();
    const items = buildStagingItems(scanResult);
    for (const item of items) {
        await enrichStagingItem(item);
        const merged = item.mergedContent || item.proposedContent;
        const keywords = item.keywords || [item.name];
        await handleAccept(item, merged, keywords, { querySelector: () => ({ disabled: false, textContent: '' }) });
    }
    return items;
}

/** Macro: return all tracked NPC names */
export function getTrackedNpcNames() {
    return getAllNpcNames();
}

/** Returns true if an NPC scan is currently in progress */
export function isScanning() {
    return isRunning;
}

/** Returns the total count of tracked NPCs (major + minor) */
export function getNpcCount() {
    return Object.keys(getRegistry()).length;
}

/** Macro: return a specific NPC's lorebook content */
export async function getNpcContent(name) {
    const reg = getRegistry()[name];
    if (!reg || reg.uid == null) return '';
    return loadEntryContent(reg.uid) || '';
}
