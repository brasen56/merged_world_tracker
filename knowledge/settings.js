/**
 * knowledge/settings.js — Settings manager and settings panel for the Knowledge module.
 */

import { createSettingsManager, syncSharedConnectionSettings, renderApiSettingsFields, readApiSettingsValues } from '../core/index.js';

import { SETTINGS_KEY, state, getNpcsContentEl, ktSetStatus } from './state.js';

const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    legacyKey: 'knowledge_tracker_settings',
    defaults: {
        // Diagnostics (Phase 6): stamps this module's key onto API telemetry
        // (core/api.js apiModule() → captureApiCall) so per-module views — the
        // Health tab's last-run column, MWT.diagnostics.lastApiCall('knowledge')
        // — actually key on it instead of everything landing under 'api'.
        module: 'knowledge',
        connectionProfileId: '',
        apiUrl: '',
        apiKey: '',
        modelName: '',
        maxTokens: 8000,
        temperature: 0.1,
        topP: 1.0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        customHeaders: '',
        // Which lorebooks this module reads and writes:
        //   'global'    — one shared set of books (legacy behaviour)
        //   'character' — one set per character card, shared across their chats
        //   'chat'      — one set per chat file
        // Defaults to 'global' so existing installs are unchanged on upgrade.
        // See scope.js for how names are resolved and bound.
        scope: 'global',
        // Stable-key → resolved book names, so renaming a card does not orphan
        // its books. Written by scope.js; never edited by hand.
        bookBindings: {},
        autoTriggerEnabled: false,
        autoTriggerEveryN: 5,
        trackerCooldownMsgs: 3,
        npcAutoScanEnabled: false,
        npcAutoScanEveryN: 10,
        // Dossier Mode: when ON, scans produce richer NPC entries (role,
        // appearance, voice, background, secrets, agenda, etc.) stored in the
        // same lorebook entries. When OFF (default), uses the minimal format.
        dossierMode: false,
        // Continuous growth evidence capture (Part A — summary-proof by
        // construction). When ON, captures behavioral observations for major
        // profiled NPCs on a message cadence, appending to the raw evidence
        // tier. Uses a ts watermark so only the delta is processed.
        growthAutoCaptureEnabled: false,
        growthAutoCaptureEveryN: 15,
        // Debug: when ON, the auto-capture cadence shows a start toast in
        // addition to the completion toast. Off by default (noisy in normal
        // roleplay). Completion toasts for actual results/errors always fire.
        growthDebugToasts: false,
        // When ON, the AI-played cast is treated as trackable NPCs rather than
        // excluded as "player names". Lets non-scenario cards flow into the
        // registry so growth profiles and relationships apply to them. Only the
        // human user ({{user}} / name1) stays excluded.
        //
        // Scope note: this swaps getPlayerNames() for getUserNames(), and
        // getPlayerNames covers the whole cast — {{char}} / name2 AND every
        // group-chat member. So in a group chat this unlocks every member, not
        // just the card in focus. That is the intent (relationships between AI
        // cast members are the point), and the UI label says so.
        trackMainCharAsNpc: false,
        // Continuous relationship extraction (auto-log + auto-save). On a message
        // cadence, reads recent messages, proposes edges + stances toward {{user}},
        // applies them to the relationship store, and re-syncs the affected NPC
        // lorebook entries. Manual edits are preserved: extraction only ADDS or
        // UPDATES edges/stances; it never deletes.
        relationshipAutoExtractEnabled: false,
        relationshipAutoExtractEveryN: 10,
    },
    logPrefix: '[MWT:Knowledge]',
});

export { getSettings, saveSettings, hasValidSettings };

export function showKnowledgeSettings() {
    const el = getNpcsContentEl();
    if (!el) return;
    const s = getSettings();
    const apiFieldOpts = {
        urlId: 'kt-cfg-api-url', keyId: 'kt-cfg-api-key', modelId: 'kt-cfg-model',
        maxTokensId: 'kt-cfg-max-tokens', tempId: 'kt-cfg-temp', topPId: 'kt-cfg-top-p',
        freqId: 'kt-cfg-freq-pen', presId: 'kt-cfg-pres-pen', headersId: 'kt-cfg-headers',
        maxTokensDefault: 8000, tempDefault: 0.1,
    };
    el.innerHTML = `<div class="kt-settings-form">
        <h3>Knowledge Tracker Settings</h3>
        <div class="mwt-settings-grid">
            ${renderApiSettingsFields(s, apiFieldOpts)}
            <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Custom Headers: JSON object of extra HTTP headers. Leave blank if unsure.</p>
        </div>
        <div style="margin-top:12px">
            <label class="mwt-label">Lorebook scope</label>
            <select id="kt-cfg-scope" class="mwt-input">
                <option value="global" ${s.scope === 'global' || !s.scope ? 'selected' : ''}>Global — one shared set of lorebooks</option>
                <option value="character" ${s.scope === 'character' ? 'selected' : ''}>Per character — one set per character card</option>
                <option value="chat" ${s.scope === 'chat' ? 'selected' : ''}>Per chat — one set per chat file</option>
            </select>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">Which lorebooks NPC entries are written to. <strong>Global</strong> shares one "Knowledge Tracker" book across every chat and character — two characters with an NPC of the same name will share (and both inject) the same entry. <strong>Per character</strong> gives each card its own books, kept across all chats with that card. <strong>Per chat</strong> gives every chat its own. Changing this does not move existing entries; the previous books are left untouched.</p>
        </div>
        <div style="margin-top:12px">
            <label><input type="checkbox" id="kt-cfg-auto-trigger" ${s.autoTriggerEnabled ? 'checked' : ''}> Auto-trigger state tracker updates</label>
            <div style="margin-top:6px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                <label style="font-size:12px;color:var(--mwt-text-dim)">Every <input type="number" id="kt-cfg-auto-every" class="mwt-input" style="width:60px;display:inline-block" value="${s.autoTriggerEveryN || 5}" min="1" max="100"> messages</label>
                <label style="font-size:12px;color:var(--mwt-text-dim)">Cooldown <input type="number" id="kt-cfg-cooldown" class="mwt-input" style="width:60px;display:inline-block" value="${s.trackerCooldownMsgs || 3}" min="0" max="50"> messages</label>
            </div>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">Auto-trigger scans state trackers every N user messages. Cooldown prevents re-updating recently changed trackers.</p>
        </div>
        <div style="margin-top:12px">
            <label><input type="checkbox" id="kt-cfg-npc-autoscan" ${s.npcAutoScanEnabled ? 'checked' : ''}> Auto-scan for NPCs (minor/major)</label>
            <div style="margin-top:6px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                <label style="font-size:12px;color:var(--mwt-text-dim)">Every <input type="number" id="kt-cfg-npc-every" class="mwt-input" style="width:60px;display:inline-block" value="${s.npcAutoScanEveryN || 10}" min="1" max="100"> messages</label>
            </div>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">Auto-scan analyses recent messages for new or updated NPCs every N user messages and stages proposals for review.</p>
        </div>
        <div style="margin-top:12px">
            <label><input type="checkbox" id="kt-cfg-dossier-mode" ${s.dossierMode ? 'checked' : ''}> 📋 Dossier Mode (richer NPC entries)</label>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">When ON, NPC scans capture detailed dossier fields (role, appearance, voice, background, personality, secrets, agenda, canon lock, etc.). Major NPCs gain an <strong>📋 Enrich</strong> button to fill in all dossier fields from chat history. Entries stay in the same lorebook. Off = the minimal format.</p>
        </div>
        <div style="margin-top:12px">
            <label><input type="checkbox" id="kt-cfg-growth-auto" ${s.growthAutoCaptureEnabled ? 'checked' : ''}> 🌱 Auto-capture growth evidence (continuous)</label>
            <div style="margin-top:6px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                <label style="font-size:12px;color:var(--mwt-text-dim)">Every <input type="number" id="kt-cfg-growth-every" class="mwt-input" style="width:60px;display:inline-block" value="${s.growthAutoCaptureEveryN || 15}" min="1" max="100"> messages</label>
            </div>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">When ON, captures behavioral observations for major profiled NPCs on a message cadence and appends them to the raw evidence tier. Uses a timestamp watermark so only the <em>delta</em> (new messages) is processed — summary-proof by construction (observations are distilled while raw messages are live). Only affects NPCs that already have a growth evidence file; run "Generate growth profile" once per NPC to enroll it.</p>
            <div style="margin-top:6px">
                <label><input type="checkbox" id="kt-cfg-growth-debug" ${s.growthDebugToasts ? 'checked' : ''}> Show "Auto-capturing…" start toast (debug)</label>
                <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">When ON, the auto-capture cadence fires a toast when it starts (useful for testing). Off by default — completion toasts for results/errors always fire regardless.</p>
            </div>
        </div>
        <div style="margin-top:12px">
            <label><input type="checkbox" id="kt-cfg-track-mainchar" ${s.trackMainCharAsNpc ? 'checked' : ''}> 🎭 Track AI characters ({{char}} + group members) as NPCs</label>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">When ON, the AI-played cast is no longer excluded from scans — the character card ({{char}}), <em>and every member of a group chat</em>, flow into the NPC registry like any other character, so growth profiles and relationships apply to them too. Only {{user}} stays excluded. Useful for non-scenario cards where the character itself is the focus, and for group chats where you want relationships tracked between the cast.</p>
        </div>
        <div style="margin-top:12px">
            <label><input type="checkbox" id="kt-cfg-rel-auto" ${s.relationshipAutoExtractEnabled ? 'checked' : ''}> 🔗 Auto-log relationships (extract + save)</label>
            <div style="margin-top:6px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                <label style="font-size:12px;color:var(--mwt-text-dim)">Every <input type="number" id="kt-cfg-rel-every" class="mwt-input" style="width:60px;display:inline-block" value="${s.relationshipAutoExtractEveryN || 10}" min="1" max="100"> messages</label>
            </div>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin-top:4px">When ON, scans recent messages on a cadence, extracts relationship edges (between tracked NPCs) and each NPC's stance toward {{user}}, saves them to the relationship store, and re-syncs the affected lorebook entries. Manual edits are preserved — extraction only adds or updates, never deletes.</p>
        </div>
        <div class="mwt-flex mwt-gap-4 mwt-mt-8" style="margin-top:12px">
            <button id="kt-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button>
            <button id="kt-cancel-settings" class="mwt-btn">Cancel</button>
        </div>
        <div id="kt-status" class="kt-status" style="margin-top:8px"></div>
    </div>`;

    el.querySelector('#kt-save-settings')?.addEventListener('click', () => {
        const apiValues = readApiSettingsValues(el, apiFieldOpts);
        // Cooldown 0 ("no cooldown") is a legitimate value (the input allows
        // min=0), so don't use `Number(...) || 3` — that clobbers 0 to 3.
        const cooldownN = parseInt(el.querySelector('#kt-cfg-cooldown')?.value, 10);
        // `s` was read when the panel rendered, so it holds the pre-edit value.
        const previousScope = s.scope || 'global';
        const chosenScope = el.querySelector('#kt-cfg-scope')?.value;
        saveSettings({
            ...apiValues,
            scope: ['global', 'character', 'chat'].includes(chosenScope) ? chosenScope : 'global',
            autoTriggerEnabled: el.querySelector('#kt-cfg-auto-trigger')?.checked ?? false,
            autoTriggerEveryN: Number(el.querySelector('#kt-cfg-auto-every')?.value) || 5,
            trackerCooldownMsgs: Number.isFinite(cooldownN) && cooldownN >= 0 ? cooldownN : 3,
            npcAutoScanEnabled: el.querySelector('#kt-cfg-npc-autoscan')?.checked ?? false,
            npcAutoScanEveryN: Number(el.querySelector('#kt-cfg-npc-every')?.value) || 10,
            dossierMode: el.querySelector('#kt-cfg-dossier-mode')?.checked ?? false,
            growthAutoCaptureEnabled: el.querySelector('#kt-cfg-growth-auto')?.checked ?? false,
            growthAutoCaptureEveryN: Number(el.querySelector('#kt-cfg-growth-every')?.value) || 15,
            growthDebugToasts: el.querySelector('#kt-cfg-growth-debug')?.checked ?? false,
            trackMainCharAsNpc: el.querySelector('#kt-cfg-track-mainchar')?.checked ?? false,
            relationshipAutoExtractEnabled: el.querySelector('#kt-cfg-rel-auto')?.checked ?? false,
            relationshipAutoExtractEveryN: Number(el.querySelector('#kt-cfg-rel-every')?.value) || 10,
        });
        state.activeSubTab = 'staging';
        // A scope change points the module at different lorebooks, so the
        // cached stores for the old books must be flushed and the new ones
        // loaded before anything reads the registry again.
        if (chosenScope !== previousScope) {
            import('./index.js')
                .then(({ reloadStores }) => reloadStores('scope change'))
                .then(() => import('./render.js'))
                .then(({ renderNpcsSubTab }) => renderNpcsSubTab());
        } else {
            import('./render.js').then(({ renderNpcsSubTab }) => renderNpcsSubTab());
        }
        ktSetStatus('Settings saved.', 'success');
    });
    el.querySelector('#kt-cancel-settings')?.addEventListener('click', () => {
        state.activeSubTab = 'staging';
        import('./render.js').then(({ renderNpcsSubTab }) => renderNpcsSubTab());
    });
}

export function syncGlobalSettings(patch) {
    return syncSharedConnectionSettings(getSettings, saveSettings, patch, '[MWT:Knowledge]');
}