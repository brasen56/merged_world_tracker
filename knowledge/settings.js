/**
 * knowledge/settings.js — Settings manager and settings panel for the Knowledge module.
 */

import { createSettingsManager, syncSharedConnectionSettings, renderApiSettingsFields, readApiSettingsValues } from '../core/index.js';

import { SETTINGS_KEY, state, getNpcsContentEl, ktSetStatus } from './state.js';

const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    legacyKey: 'knowledge_tracker_settings',
    defaults: {
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
        autoTriggerEnabled: false,
        autoTriggerEveryN: 5,
        trackerCooldownMsgs: 3,
        npcAutoScanEnabled: false,
        npcAutoScanEveryN: 10,
        // Dossier Mode: when ON, scans produce richer NPC entries (role,
        // appearance, voice, background, secrets, agenda, etc.) stored in the
        // same lorebook entries. When OFF (default), uses the minimal format.
        dossierMode: false,
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
        maxTokensDefault: 4000, tempDefault: 0.1,
    };
    el.innerHTML = `<div class="kt-settings-form">
        <h3>Knowledge Tracker Settings</h3>
        <div class="mwt-settings-grid">
            ${renderApiSettingsFields(s, apiFieldOpts)}
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
        <div class="mwt-flex mwt-gap-4 mwt-mt-8" style="margin-top:12px">
            <button id="kt-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button>
            <button id="kt-cancel-settings" class="mwt-btn">Cancel</button>
        </div>
        <div id="kt-status" class="kt-status" style="margin-top:8px"></div>
    </div>`;

    el.querySelector('#kt-save-settings')?.addEventListener('click', () => {
        const apiValues = readApiSettingsValues(el, apiFieldOpts);
        saveSettings({
            ...apiValues,
            autoTriggerEnabled: el.querySelector('#kt-cfg-auto-trigger')?.checked ?? false,
            autoTriggerEveryN: Number(el.querySelector('#kt-cfg-auto-every')?.value) || 5,
            trackerCooldownMsgs: Number(el.querySelector('#kt-cfg-cooldown')?.value) || 3,
            npcAutoScanEnabled: el.querySelector('#kt-cfg-npc-autoscan')?.checked ?? false,
            npcAutoScanEveryN: Number(el.querySelector('#kt-cfg-npc-every')?.value) || 10,
            dossierMode: el.querySelector('#kt-cfg-dossier-mode')?.checked ?? false,
        });
        state.activeSubTab = 'staging';
        import('./render.js').then(({ renderNpcsSubTab }) => renderNpcsSubTab());
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