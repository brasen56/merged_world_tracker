/**
 * Global Settings form render/read/wire seam. No host lifecycle or persistence
 * ownership lives here: index.js supplies Save, Sync and reset callbacks.
 * All controls remain mounted, including closed and profile-hidden fields.
 */
import { renderApiSettingsFields, readApiSettingsValues, renderConnectionProfileSelect } from './ui.js';

// ID opts for shared API settings helpers (renderApiSettingsFields / readApiSettingsValues)
export const GLOBAL_API_FIELD_IDS = {
    urlId: 'mwt-s-api-url',
    keyId: 'mwt-s-api-key',
    modelId: 'mwt-s-model',
    maxTokensId: 'mwt-s-max-tokens',
    tempId: 'mwt-s-temp',
    topPId: 'mwt-s-top-p',
    freqId: 'mwt-s-freq-pen',
    presId: 'mwt-s-pres-pen',
    headersId: 'mwt-s-headers',
};

export function renderGlobalSettingsForm(s) {
    const hasProfile = !!s.connectionProfileId;
    const apiFieldsStyle = hasProfile ? 'display:none' : '';

    // Accessibility plan §4.4 / Slice 4, in the markup below:
    //  - decorative leading emoji sit in aria-hidden spans, so a heading is
    //    "Injection Settings", not "wrench Injection Settings";
    //  - a `.mwt-label` that labels a whole grid section rather than one
    //    control is a <div> — a <label> with no control is not a label;
    //  - the float-button and per-tracker rows point BOTH cells' labels at the
    //    row's checkbox, so its name reads "World State Visible" rather than
    //    the six identical "Visible"s the right-hand cell alone would give.
    // Save writes EVERY section, so its row sits below the collapsible
    // sections rather than inside one — collapsing that section would hide it.
    return `
        <details class="mwt-settings-disclosure" open>
            <summary><span aria-hidden="true">🔌</span> API Connection</summary>
            <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
                These global API settings serve as defaults for all modules. Each module can override them in its own Settings panel.
            </p>
            <div class="mwt-settings-grid">
            <label class="mwt-label" style="grid-column:1/2" for="mwt-s-connection-profile">Connection Profile</label>
            ${renderConnectionProfileSelect('mwt-s-connection-profile', s.connectionProfileId, '— None (use custom API below) —')}
            <p style="font-size:11px;color:var(--mwt-text-dim);margin:0;grid-column:1/3">
                Select a Connection Manager profile to use with all backends (OpenAI, TextGen, etc.) with full preset/instruct support. Leave empty to configure a custom API URL/Key below. Profiles marked (active) are ST's currently selected profile.
            </p>

            <div id="mwt-s-api-fields" style="grid-column:1/3;${apiFieldsStyle}" class="mwt-settings-grid">
                ${renderApiSettingsFields(s, GLOBAL_API_FIELD_IDS)}
            </div>
            </div>
        </details>

        <details class="mwt-settings-disclosure">
            <summary><span aria-hidden="true">🕒</span> Stable History</summary>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            Defer the newest chat messages from World State, Chronicle, Knowledge, Relationships, Growth, and Story Planner scans. They are included on a later refresh instead of discarded. <strong>2</strong> usually means the latest user/assistant exchange. Interiority is intentionally excluded because it evaluates the current turn.
        </p>
            <div class="mwt-settings-grid">
            <label class="mwt-label" for="mwt-s-recent-history-exclude">Messages to defer</label>
            <input id="mwt-s-recent-history-exclude" class="mwt-input" type="number" value="${s.recentHistoryExclude ?? 2}" min="0" max="10" step="1">
            </div>
        </details>

        <details id="mwt-settings-generation-coordinator" class="mwt-settings-disclosure">
            <summary><span aria-hidden="true">🚦</span> Generation Coordinator</summary>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            All tracker API calls go through one central queue. Each module runs at most one generation at a time; this caps how many may run in parallel <em>across</em> modules, so a burst of tracker work cannot stampede your API endpoint (manual clicks always jump ahead of automatic work). Switching chats cancels queued tracker jobs from the old chat. See what's queued any time with <code>MWT.coordinator.status()</code> in the console.
        </p>
            <div class="mwt-settings-grid">
            <label class="mwt-label" for="mwt-s-api-max-concurrent">Max parallel API calls</label>
            <input id="mwt-s-api-max-concurrent" class="mwt-input" type="number" value="${s.apiMaxConcurrent ?? 2}" min="1" max="8" step="1">
            <label class="mwt-label" for="mwt-s-pause-background" style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="mwt-s-pause-background" ${s.pauseBackgroundJobsDuringGeneration ? 'checked' : ''}>
                Hold automatic tracker work while you generate
            </label>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin:0">
                When on, automatic calls (auto-refresh, auto-snapshot, NPC updates, auto-thoughts, …) wait until your own generation finishes. Button-pressed generations are never held.
            </p>
            </div>
        </details>

        <details class="mwt-settings-disclosure">
            <summary><span aria-hidden="true">🔧</span> Injection Settings</summary>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            Control how each module's entries are injected into the prompt. Depth = how far back from the bottom; Role = which message role. (Knowledge uses SillyTavern's built-in lorebook system and does not use extension prompt injection. Disabling the Knowledge tracker below only stops it from scanning/updating; existing lorebook entries will continue to be injected by SillyTavern's World Info until you disable them manually in the World Info panel.)
        </p>
            <div class="mwt-settings-grid">
            <div class="mwt-label" style="grid-column:1/3;font-weight:bold"><span aria-hidden="true">🌍</span> World State</div>
            <label class="mwt-label" for="mwt-s-ws-depth">Depth</label>
            <input id="mwt-s-ws-depth" class="mwt-input" type="number" value="${s.worldStateDepth ?? 4}" min="0" max="999">
            <label class="mwt-label" for="mwt-s-ws-role">Role</label>
            <select id="mwt-s-ws-role" class="mwt-input">
                <option value="system" ${s.worldStateRole === 'system' ? 'selected' : ''}>system</option>
                <option value="user" ${s.worldStateRole === 'user' ? 'selected' : ''}>user</option>
                <option value="assistant" ${s.worldStateRole === 'assistant' ? 'selected' : ''}>assistant</option>
            </select>

            <div class="mwt-label" style="grid-column:1/3;font-weight:bold"><span aria-hidden="true">📜</span> Chronicle</div>
            <label class="mwt-label" for="mwt-s-ch-depth">Depth</label>
            <input id="mwt-s-ch-depth" class="mwt-input" type="number" value="${s.chronicleDepth ?? 4}" min="0" max="999">
            <label class="mwt-label" for="mwt-s-ch-role">Role</label>
            <select id="mwt-s-ch-role" class="mwt-input">
                <option value="system" ${s.chronicleRole === 'system' ? 'selected' : ''}>system</option>
                <option value="user" ${s.chronicleRole === 'user' ? 'selected' : ''}>user</option>
                <option value="assistant" ${s.chronicleRole === 'assistant' ? 'selected' : ''}>assistant</option>
            </select>

            <div class="mwt-label" style="grid-column:1/3;font-weight:bold"><span aria-hidden="true">💭</span> Interiority</div>
            <label class="mwt-label" for="mwt-s-int-depth">Depth</label>
            <input id="mwt-s-int-depth" class="mwt-input" type="number" value="${s.interiorityDepth ?? 1}" min="0" max="999">
            <label class="mwt-label" for="mwt-s-int-role">Role</label>
            <select id="mwt-s-int-role" class="mwt-input">
                <option value="system" ${s.interiorityRole === 'system' ? 'selected' : ''}>system</option>
                <option value="user" ${s.interiorityRole === 'user' ? 'selected' : ''}>user</option>
                <option value="assistant" ${s.interiorityRole === 'assistant' ? 'selected' : ''}>assistant</option>
            </select>

            <div class="mwt-label" style="grid-column:1/3;font-weight:bold"><span aria-hidden="true">💰</span> Ledger</div>
            <label class="mwt-label" for="mwt-s-inject-ledger" style="display:flex;align-items:center;gap:6px;cursor:pointer;grid-column:1/3">
                <input type="checkbox" id="mwt-s-inject-ledger" ${s.injectLedger !== false ? 'checked' : ''}>
                <span>Inject money and carried items</span>
            </label>

            <div class="mwt-label" style="grid-column:1/3;font-weight:bold"><span aria-hidden="true">🏷️</span> Structural Boundaries</div>
            <label class="mwt-label" for="mwt-s-structural-boundaries" style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="mwt-s-structural-boundaries" ${s.structuralBoundaries !== false ? 'checked' : ''}>
                <span>Wrap injected blocks in XML tags</span>
            </label>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin:0">
                Wraps each injected reference block (World State, Plot Seeds, Chronicle) in tags like <code>&lt;mwt_world_state&gt;…&lt;/mwt_world_state&gt;</code>.
                Recommended for smaller / open models (24–70B) that bleed between sections. Frontier models don't need it; turn off to save a few tokens.
            </p>
        </div>
        </details>

        <details class="mwt-settings-disclosure">
            <summary><span aria-hidden="true">📍</span> Floating Buttons</summary>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            Show or hide individual floating buttons. You can also access the MWT modal from the Extensions panel drawer or the wand menu.
        </p>
        <div class="mwt-settings-grid">
            <label class="mwt-label" for="mwt-s-collapse-float" style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="mwt-s-collapse-float" ${s.collapseFloatButtons ? 'checked' : ''}>
                <span>Collapse into single button</span>
            </label>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Replace the 4 floating buttons with one that expands on tap/click.</p>

            <label class="mwt-label" for="mwt-s-show-world"><span aria-hidden="true">🌍</span> World State</label>
            <label for="mwt-s-show-world" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-world" ${s.showFloatWorld !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label" for="mwt-s-show-chronicle"><span aria-hidden="true">📜</span> Chronicle</label>
            <label for="mwt-s-show-chronicle" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-chronicle" ${s.showFloatChronicle !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label" for="mwt-s-show-knowledge"><span aria-hidden="true">🧠</span> Knowledge</label>
            <label for="mwt-s-show-knowledge" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-knowledge" ${s.showFloatKnowledge !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label" for="mwt-s-show-story-planner"><span aria-hidden="true">🗺️</span> Story Planner</label>
            <label for="mwt-s-show-story-planner" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-story-planner" ${s.showFloatStoryPlanner !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label" for="mwt-s-show-interiority"><span aria-hidden="true">💭</span> Interiority</label>
            <label for="mwt-s-show-interiority" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-interiority" ${s.showFloatInteriority !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label" for="mwt-s-show-ledger"><span aria-hidden="true">💰</span> Ledger</label>
            <label for="mwt-s-show-ledger" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-ledger" ${s.showFloatLedger !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label" for="mwt-s-show-settings"><span aria-hidden="true">⚙️</span> Settings</label>
            <label for="mwt-s-show-settings" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-show-settings" ${s.showFloatSettings !== false ? 'checked' : ''}> Visible</label>

            <label class="mwt-label" for="mwt-s-button-style"><span aria-hidden="true">🎨</span> Style</label>
            <select id="mwt-s-button-style" class="mwt-input" style="width:auto">
                <option value="modern" ${(s.buttonStyle || 'modern') === 'modern' ? 'selected' : ''}>Modern (icons-only)</option>
                <option value="classic" ${s.buttonStyle === 'classic' ? 'selected' : ''}>Classic (text + icon)</option>
            </select>

            <div></div>
            <div>
                <button id="mwt-s-reset-float-positions" class="mwt-btn" title="Restore all floating buttons to their default positions"><span aria-hidden="true">↩</span> Reset Button Positions</button>
                <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Dragged buttons return to the default right-edge stack. You can also use the <code>/wt-reset-buttons</code> slash command.</p>
            </div>
        </div>

        </details>

        <details class="mwt-settings-disclosure">
            <summary><span aria-hidden="true">🛑</span> Per-Tracker Enable</summary>
        <p style="color:var(--mwt-text-dim);font-size:12px;margin-bottom:12px">
            Disable a tracker you don't use: it stops injecting and scanning, and its floating button shows a red ✕
            (right-click it again to re-enable). To remove a button entirely, uncheck its "Visible" box in the
            Floating Buttons section above. You can also disable <em>everything</em> at once by right-clicking the ⚙️ button.
        </p>
        <div class="mwt-settings-grid">
            <label class="mwt-label" for="mwt-s-master-off" style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="mwt-s-master-off" ${s.injectionMasterOff ? 'checked' : ''}>
                <span>Disable all trackers (panic switch)</span>
            </label>
            <p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Stops injection and scanning for every module. Useful for testing or branching a chat. **Lorebook entries need to be manually disabled**.</p>

            <label class="mwt-label" for="mwt-s-enable-world"><span aria-hidden="true">🌍</span> World State</label>
            <label for="mwt-s-enable-world" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-world" ${s.enableWorldState !== false ? 'checked' : ''}> Use this tracker</label>

            <label class="mwt-label" for="mwt-s-enable-chronicle"><span aria-hidden="true">📜</span> Chronicle</label>
            <label for="mwt-s-enable-chronicle" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-chronicle" ${s.enableChronicle !== false ? 'checked' : ''}> Use this tracker</label>

            <label class="mwt-label" for="mwt-s-enable-knowledge"><span aria-hidden="true">🧠</span> Knowledge</label>
            <label for="mwt-s-enable-knowledge" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-knowledge" ${s.enableKnowledge !== false ? 'checked' : ''}> Use this tracker</label>

            <label class="mwt-label" for="mwt-s-enable-story-planner"><span aria-hidden="true">🗺️</span> Story Planner</label>
            <label for="mwt-s-enable-story-planner" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-story-planner" ${s.enableStoryPlanner !== false ? 'checked' : ''}> Use this tracker</label>

            <label class="mwt-label" for="mwt-s-enable-interiority"><span aria-hidden="true">💭</span> Interiority</label>
            <label for="mwt-s-enable-interiority" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-interiority" ${s.enableInteriority !== false ? 'checked' : ''}> Use this tracker</label>

            <label class="mwt-label" for="mwt-s-enable-ledger"><span aria-hidden="true">💰</span> Ledger</label>
            <label for="mwt-s-enable-ledger" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mwt-s-enable-ledger" ${s.enableLedger !== false ? 'checked' : ''}> Use this tracker</label>
        </div>

        </details>

        <div class="mwt-settings-actions mwt-flex mwt-gap-4" style="flex-wrap:wrap">
            <button id="mwt-s-save" class="mwt-btn mwt-btn-primary">Save Settings</button>
            <button id="mwt-s-sync" class="mwt-btn" title="Copy these API settings to all module-specific configs"><span aria-hidden="true">↓</span> Sync to Modules</button>
        </div>

        <hr style="border-color:var(--mwt-border);margin:16px 0">
        <p style="color:var(--mwt-text-dim);font-size:12px">
            <strong>Module-specific settings</strong> are available in each tab's ⚙ Settings button.
            Use "Sync to Modules" above to push the global API URL/Key/Model to all modules at once.
        </p>
    `;
}

/** Read the whole global form, never just the visible disclosure. */
export function collectGlobalSettingsPatch(scope) {
    const apiValues = readApiSettingsValues(scope, GLOBAL_API_FIELD_IDS);
    // Depth 0 ("inject at the very bottom") is a legitimate value, so
    // don't use `Number(...) || fallback` — that clobbers 0 to the fallback.
    const depthOr = (sel, fallback) => {
        const n = parseInt(scope.querySelector(sel)?.value, 10);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    // A cleared field must fall back to its default, the same as a
    // missing control or garbage input. `Number('')` is 0, which is
    // finite, so it used to save "defer 0 messages" and (after the
    // clamp) "1 parallel call" instead — the same trap
    // readApiSettingsValues() closes for the API fields.
    const clampedOr = (sel, min, max, fallback) => {
        const raw = scope.querySelector(sel)?.value;
        if (raw == null || String(raw).trim() === '') return fallback;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
    };
    const recentHistoryExclude = clampedOr('#mwt-s-recent-history-exclude', 0, 10, 2);
    // Generation coordinator (TODO §1): clamp to the coordinator's
    // supported range; an empty/garbage field falls back to the default.
    const apiMaxConcurrent = clampedOr('#mwt-s-api-max-concurrent', 1, 8, 2);
    return {
        ...apiValues,
        connectionProfileId: scope.querySelector('#mwt-s-connection-profile')?.value || '',
        recentHistoryExclude,
        apiMaxConcurrent,
        pauseBackgroundJobsDuringGeneration: scope.querySelector('#mwt-s-pause-background')?.checked ?? false,
        // Per-module injection settings
        worldStateDepth: depthOr('#mwt-s-ws-depth', 4),
        worldStateRole: scope.querySelector('#mwt-s-ws-role')?.value || 'system',
        chronicleDepth: depthOr('#mwt-s-ch-depth', 4),
        chronicleRole: scope.querySelector('#mwt-s-ch-role')?.value || 'system',
        // Structural boundaries
        structuralBoundaries: scope.querySelector('#mwt-s-structural-boundaries')?.checked ?? true,
        // Button visibility
        showFloatWorld: scope.querySelector('#mwt-s-show-world')?.checked ?? true,
        showFloatChronicle: scope.querySelector('#mwt-s-show-chronicle')?.checked ?? true,
        showFloatKnowledge: scope.querySelector('#mwt-s-show-knowledge')?.checked ?? true,
        showFloatStoryPlanner: scope.querySelector('#mwt-s-show-story-planner')?.checked ?? true,
        showFloatInteriority: scope.querySelector('#mwt-s-show-interiority')?.checked ?? true,
        showFloatSettings: scope.querySelector('#mwt-s-show-settings')?.checked ?? true,
        collapseFloatButtons: scope.querySelector('#mwt-s-collapse-float')?.checked ?? false,
        buttonStyle: scope.querySelector('#mwt-s-button-style')?.value || 'modern',
        // Per-tracker enable + master panic switch
        enableWorldState: scope.querySelector('#mwt-s-enable-world')?.checked ?? true,
        enableChronicle: scope.querySelector('#mwt-s-enable-chronicle')?.checked ?? true,
        enableKnowledge: scope.querySelector('#mwt-s-enable-knowledge')?.checked ?? true,
        enableStoryPlanner: scope.querySelector('#mwt-s-enable-story-planner')?.checked ?? true,
        enableInteriority: scope.querySelector('#mwt-s-enable-interiority')?.checked ?? true,
        enableLedger: scope.querySelector('#mwt-s-enable-ledger')?.checked ?? true,
        injectLedger: scope.querySelector('#mwt-s-inject-ledger')?.checked ?? true,
        showFloatLedger: scope.querySelector('#mwt-s-show-ledger')?.checked ?? true,
        interiorityDepth: depthOr('#mwt-s-int-depth', 1),
        interiorityRole: scope.querySelector('#mwt-s-int-role')?.value || 'system',
        injectionMasterOff: scope.querySelector('#mwt-s-master-off')?.checked ?? false,
    };
}

/** Sync reads current (possibly unsaved) API values, not persisted settings. */
export function collectGlobalApiPatch(scope) {
    return {
        connectionProfileId: scope.querySelector('#mwt-s-connection-profile')?.value || '',
        ...readApiSettingsValues(scope, GLOBAL_API_FIELD_IDS),
    };
}

// One binding per surviving control. Rewiring replaces callbacks without
// stacking listeners; fresh controls after a body rebuild get fresh bindings.
const bindings = new WeakMap();
function bind(control, event, callback) {
    if (!control) return;
    const previous = bindings.get(control);
    if (previous) control.removeEventListener(previous.event, previous.callback);
    control.addEventListener(event, callback);
    bindings.set(control, { event, callback });
}

/** Host callbacks retain persistence, status messages and module side effects. */
export function wireGlobalSettingsForm(scope, { onSave, onSync, onResetPositions }) {
    const profile = scope.querySelector('#mwt-s-connection-profile');
    bind(profile, 'change', () => {
        const fields = scope.querySelector('#mwt-s-api-fields');
        if (fields) fields.style.display = profile.value ? 'none' : '';
    });
    bind(scope.querySelector('#mwt-s-save'), 'click', () => onSave(collectGlobalSettingsPatch(scope)));
    bind(scope.querySelector('#mwt-s-sync'), 'click', () => onSync(collectGlobalApiPatch(scope)));
    bind(scope.querySelector('#mwt-s-reset-float-positions'), 'click', onResetPositions);
}
