/**
 * world_state/index.js — World State Tracker module
 *
 * Migrated from WorldState/index.js (2,293 lines) into a single cohesive
 * module that uses the shared core (context, api, diff, settings, modal).
 *
 * Public API:  { init, render, getWorldStateText, applyInjection }
 */

import {
    getContextSafe, getChat, getChatMeta, setChatMeta, getSetExtensionPrompt,
    fetchFromApi, normaliseOutput, normalizeApiBase,
    escapeHtml, escapeRegex, computeLcsDiff, renderDiffHtml, estimateTokens,
    createSettingsManager,
    createModal, showModal, hideModal, setStatus,
} from '../core/index.js';

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'mwt_world_state';
const CHAT_DATA_KEY = 'world_state_tracker_metadata';
const DEFAULT_AUTO_SAVE_INTERVAL = 120;

const { getSettings, saveSettings, hasValidSettings } = createSettingsManager({
    settingsKey: SETTINGS_KEY,
    legacyKey: 'world_state_settings',
    defaults: {
        apiUrl: '',
        apiKey: '',
        modelName: '',
        temperature: 0.3,
        maxTokens: 2000,
        autoSaveInterval: DEFAULT_AUTO_SAVE_INTERVAL,
        customPrompt: '',
        injectionDepth: 1,
        maxScanMessages: 20,
        hookMode: 'passive',
        messageFilter: '',
    },
    logPrefix: '[MWT:WorldState]',
});

// ─── Section & Variety constants (for per-section regeneration) ─────────────

const SECTIONS = [
    'Current Scene',
    'Recent Changes',
    'Off-Screen',
    'Pending',
    'Active Threads',
    'Unresolved Threads',
    'World Pressures',
    'Key Character States',
    'Story Momentum',
    'Plot Seeds',
    'Potential Entrances',
];

// Lookahead marking where the CURRENT "## Section" block ends and the next one
// begins. Used when extracting/replacing or injecting a single section.
//
// The original boundary only recognised an exact "\n## " header, so any
// heading-level drift the model produces on a full refresh (e.g. emitting
// "### Potential Entrances") left no boundary at all. A per-section regen of
// "Plot Seeds" would then match clear to end-of-document and erase every
// section below it — and since Potential Entrances is the only section that
// ever sits below Plot Seeds, it was the section that silently vanished.
//
// This boundary instead stops at: any markdown heading (## … ######), OR a
// known section label the model emitted as a bare/**bold** line without a clean
// "## " prefix, OR end-of-text. The leading "\s*" keeps trailing blank lines
// out of the captured block so inter-section spacing is preserved.
const NEXT_SECTION_LOOKAHEAD =
    '(?=\\s*\\n#{1,6}[ \\t]' +
    `|\\s*\\n[ \\t]*(?:#{1,6}[ \\t]+)?\\*{0,2}(?:${SECTIONS.map(escapeRegex).join('|')})\\*{0,2}[ \\t]*(?:\\n|$)` +
    '|\\s*$)';

const VARIETY_LABELS = {
    1: 'Conservative',
    2: 'Balanced',
    3: 'Varied',
    4: 'Wild',
    5: 'Chaotic',
};

// ─── Internal state ──────────────────────────────────────────────────────────

let wstIsRefreshing = false;
let autoRefreshCounter = (() => {
    try {
        const saved = getWorldStateData()?.autoRefreshCounter;
        return (typeof saved === 'number' && Number.isFinite(saved)) ? saved : 0;
    } catch { return 0; }
})();

function persistAutoRefreshCounter() {
    setWorldStateData({ autoRefreshCounter });
}
let autoRefreshQueued = false;
let autoSaveLastText = '';
let autoSaveTimer = null;
let autoRefreshDeferTimer = null;
let isDirty = false;
let modal = null;

// ─── Chat data helpers ───────────────────────────────────────────────────────

function getWorldStateData() {
    const meta = getChatMeta();
    return meta?.[CHAT_DATA_KEY] || {};
}

function setWorldStateData(patch) {
    const ctx = getContextSafe();
    const meta = getChatMeta();
    if (!meta[CHAT_DATA_KEY]) meta[CHAT_DATA_KEY] = {};
    Object.assign(meta[CHAT_DATA_KEY], patch);
    // Ensure metadata is persisted (don't rely solely on ST's auto-save)
    if (ctx) {
        if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
        else if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
    }
}

function getWorldStateText() {
    return getWorldStateData().text || '';
}

// ─── History (auto-save snapshots) ──────────────────────────────────────────

function getAutoSaveHistory() {
    return getWorldStateData().autoSaveHistory || [];
}

function pushToHistory(text) {
    if (!text?.trim()) return;
    const history = getAutoSaveHistory();
    history.push({ text, timestamp: Date.now() });
    if (history.length > 50) history.splice(0, history.length - 50);
    setWorldStateData({ autoSaveHistory: history });
}

function pushAutoSave(text) {
    if (text === autoSaveLastText) return;
    pushToHistory(text);
    autoSaveLastText = text;
}

// ─── Injection ───────────────────────────────────────────────────────────────

function isInjectionEnabled() {
    return getWorldStateData().injectEnabled !== false;
}

const WORLD_STATE_INJECTION_HEADER = `[Rolling World State — current continuity reference.
Use this as background truth for the current scene.
Do not quote it directly.
Respect presence, pending obligations, character states, and knowledge boundaries.]`;

const PLOT_SEEDS_HEADERS = {
    passive: `[Narrative hooks available for this response — these are grounded story events that could plausibly arrive or escalate right now based on existing pressures.
You are encouraged to introduce one organically if the scene allows — as an interruption, arrival, message, or complication that the characters must react to.
Do not announce or explain the hook; simply have it happen.]`,

    proactive: `[Narrative hooks — these events are live and in motion based on existing pressures.
The player has opted into proactive hooks, which means they WANT autonomous world events to arrive without being prompted. You do not need to wait for the player to signal or request a hook — that signal is this setting itself.
Introduce one of these hooks in this response unless the scene is at an emotional climax that it would directly undercut.
These events do not require player initiative — they arrive on their own. Deliver it as an interruption, arrival, message, or complication. Do not announce or explain it; simply let it happen.]`,

    assertive: `[Narrative hooks — ACTIVE DIRECTIVES. These events are primed and should manifest now.
The player has explicitly enabled assertive hooks — they want the world to act on its own and expect you to introduce complications without waiting for them to ask. This IS their permission.
You must introduce at least one of these hooks in your response. The story world moves whether or not the player asks for it — do not wait for permission or an obvious opening.
Deliver the hook as an interruption, arrival, message, or complication. Do not announce or explain it; simply let it happen.]`,
};

function getHookMode() {
    return getSettings().hookMode || 'passive';
}

function getPlotSeedsHeader() {
    const mode = getHookMode();
    if (mode === 'off') return null;
    return PLOT_SEEDS_HEADERS[mode] ?? PLOT_SEEDS_HEADERS.passive;
}

const EXTENSION_PROMPT_KEY = 'mwt_world_state_injection';

function roleToNumber(role) {
    switch (role) {
        case 'user': return 1;
        case 'assistant': return 2;
        default: return 0; // system
    }
}

function applyWorldStateInjection() {
    const setEP = getSetExtensionPrompt();
    if (!setEP) return;

    const text = getWorldStateText();
    const enabled = isInjectionEnabled();

    // Read per-module depth/role from global settings
    const globalSettings = (typeof window !== 'undefined' && window.__mwt_shared?.getSettings)
        ? window.__mwt_shared.getSettings()
        : {};
    const depth = Number.isFinite(globalSettings.worldStateDepth) ? globalSettings.worldStateDepth : (getSettings().injectionDepth ?? 1);
    const role = roleToNumber(globalSettings.worldStateRole);

    try {
        // Remove existing injection — ST signature: (key, value, position, depth, scan, role)
        setEP(EXTENSION_PROMPT_KEY, '', 0, depth, undefined, role);

        if (enabled && text?.trim()) {
            // Split out Plot Seeds section (matching original WorldState behavior).
            // Uses the shared section boundary so heading drift in the following
            // section (e.g. "### Potential Entrances") can't pull it into the
            // narrative-hooks block.
            const seedsPattern = new RegExp(`## Plot Seeds\\b[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`);
            const seedsMatch = text.match(seedsPattern);
            const seedsBlock = seedsMatch ? seedsMatch[0] : '';
            const seedsText = seedsBlock.replace(/^## Plot Seeds[^\n]*\n?/, '').trim();
            const worldStateBody = seedsMatch
                ? text.replace(seedsBlock, '').replace(/\n{3,}/g, '\n\n').trim()
                : text;

            let injected = `${WORLD_STATE_INJECTION_HEADER}\n\n${worldStateBody}`;

            const seedsHeader = getPlotSeedsHeader();
            if (seedsText && seedsHeader) {
                injected += `\n\n---\n\n${seedsHeader}\n\n${seedsText}`;
            }

            // ST signature: setExtensionPrompt(key, value, position, depth, scan, role)
            setEP(EXTENSION_PROMPT_KEY, injected, 0, depth, undefined, role);
            console.log(`[MWT:WorldState] Injected ${text.length} chars at depth ${depth} role ${role}`);
        }
    } catch (err) {
        console.warn('[MWT:WorldState] Injection failed:', err);
    }
}

// ─── Auto-refresh (deferred scheduling like the original) ────────────────────

function isAutoRefreshEnabled() {
    return getWorldStateData().autoRefresh === true;
}

function getAutoRefreshInterval() {
    return getWorldStateData().autoRefreshInterval || 5;
}

function resetAutoRefreshCounter() {
    autoRefreshCounter = 0;
    persistAutoRefreshCounter();
}

/**
 * Schedule a delayed auto-refresh. Never refresh directly inside the
 * MESSAGE_RECEIVED call stack — give SillyTavern time to finish
 * saving/rendering/unlocking its own state.
 */
function scheduleAutoRefresh(reason = 'scheduled') {
    if (autoRefreshDeferTimer) clearTimeout(autoRefreshDeferTimer);

    autoRefreshQueued = true;

    autoRefreshDeferTimer = setTimeout(async () => {
        autoRefreshDeferTimer = null;

        if (!autoRefreshQueued) return;
        if (wstIsRefreshing) {
            console.log('[MWT:WorldState] Auto-refresh deferred — still refreshing.');
            scheduleAutoRefresh('retry-after-busy');
            return;
        }

        autoRefreshQueued = false;

        try {
            // If the modal is open and the editor has unsaved edits, persist
            // them to metadata first so refreshWorldState uses them.
            const editorEl = modal?.querySelector('#ws-editor');
            if (editorEl && editorEl.value && editorEl.value !== getWorldStateText()) {
                setWorldStateData({ text: editorEl.value });
            }

            console.log(`[MWT:WorldState] Running delayed auto-refresh (${reason}).`);
            const text = await refreshWorldState(true);
            if (!text) return;

            if (modal) {
                const editor = modal.querySelector('#ws-editor');
                if (editor) {
                    editor.value = text;
                    autoSaveLastText = text;
                    isDirty = false;
                    updateEditorStats();
                    refreshRevertButton();
                }
            }
        } catch (err) {
            console.warn('[MWT:WorldState] Auto-refresh failed:', err.message);
        }
    }, 2500);
}

function onMessageReceived() {
    if (!isAutoRefreshEnabled()) return;

    autoRefreshCounter++;
    const interval = getAutoRefreshInterval();

    console.log(`[MWT:WorldState] MESSAGE_RECEIVED — counter ${autoRefreshCounter}/${interval}`);

    if (autoRefreshCounter < interval) { persistAutoRefreshCounter(); return; }

    autoRefreshCounter = 0;
    persistAutoRefreshCounter();

    // Never refresh directly inside MESSAGE_RECEIVED — queue a delayed refresh.
    scheduleAutoRefresh('message-interval');
}

// ─── Auto-save timer ────────────────────────────────────────────────────────

function startAutoSaveTimer() {
    stopAutoSaveTimer();
    const interval = getSettings().autoSaveInterval || DEFAULT_AUTO_SAVE_INTERVAL;
    autoSaveTimer = setInterval(() => {
        const text = getWorldStateText();
        if (text?.trim()) pushAutoSave(text);
    }, interval * 1000);
}

function stopAutoSaveTimer() {
    if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null; }
}

// ─── Refresh (generate via LLM) ─────────────────────────────────────────────

/**
 * Apply user-defined regex filters to strip unwanted content from a message.
 * Each line in the `messageFilter` setting is treated as a separate regex pattern.
 * Matching content is removed from the text before it reaches the World State scanner.
 */
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

function getMaxScanMessages() {
    const raw = getSettings().maxScanMessages;
    if (!raw || isNaN(raw)) return 20;
    return Math.min(Math.max(1, Math.round(raw)), 30);
}

function getRecentMessagesForScan() {
    const max = getMaxScanMessages();
    const chat = getChat();
    const slice = chat.slice(-max);
    const lines = [];
    let total = 0;
    const maxChars = 20000;
    // Iterate newest-to-oldest so the char limit never cuts off recent messages.
    for (let i = slice.length - 1; i >= 0; i--) {
        const msg = slice[i];
        const name = msg?.name || (msg?.is_user ? 'User' : 'Assistant');
        let text = String(msg?.mes || '').trim();
        text = applyMessageFilter(text);
        if (!text) continue;
        const line = `${name}: ${text}`;
        if (total + line.length > maxChars) break;
        lines.push(line);
        total += line.length + 1;
    }
    return lines.reverse().join('\n');
}

const DEFAULT_SYSTEM_PROMPT = `You are a continuity tracker for an ongoing roleplay. Your ONLY job is to output a structured world state document.

ABSOLUTE RULES:
- Output ONLY the world state document in the exact format below.
- Do NOT write any narration, story text, dialogue, or roleplay continuation.
- Do NOT respond to or continue the story in any way.
- Do NOT include any preamble, commentary, sign-off, or code fences.
- Do NOT use asterisks for actions.
- Your output MUST begin with the exact text "## Current Scene" — nothing before it.

The world state document tracks what is currently true. It is a reference document, not a story.

Use ONLY the exact section headers shown below. Do not add, rename, merge, or reorder any headers.
---

## Current Scene
Date: [calendar date with year]
Time: [exact in-world time; track elapsed time between updates]
Present: [names of characters physically in the scene — names only, e.g. "Alex, Derek, Ranger"]
Situation: [1-2 sentences: what is actively happening right now and the immediate tension or purpose]

## Recent Changes
- [bullet: recent development that changed the present state]
- [bullet: newly established fact or consequence]

## Off-Screen
- **Name**: location / activity / direction (since when)

## Pending
- event or obligation (when)

## Active Threads
- **Thread Name** [active/suspended/ongoing]: current state

## Unresolved Threads
- loose end or open question still potentially relevant

## World Pressures
- pressure or development: current status and likely near-term movement

## Key Character States
- **Name**:
  - Mood:
  - Current goal:
  - Notable status:
  - Immediate pressure:
  - Key constraint:
  - Worn / Significant Items:

## Story Momentum
- near-term development strongly implied by established facts

## Plot Seeds
- [contact] — calls, texts, messages, delayed replies
- [entrance] — off-screen NPC enters or reaches into the scene
- [social] — relationship pressure, gossip, confrontation
- [institutional] — authority, school, employer, group structure
- [opportunity] — helpful lead, chance encounter, useful opening
- [pressure] A pending issue worsens before the protagonists can address it.
- [threat] — hostile complication or risk

[A plot seed is a WHAT IF — a specific event or intrusion that could happen next, derived
from combining or escalating existing pressures. It is NOT a restatement of something already
known or pending.

BAD (restatement): "Alex still needs to speak with Mikhail about the Kade situation."
GOOD (seed): "Mikhail approaches Alex first, having already drawn his own conclusions about Kade — and they may not match what Alex was planning to say."

BAD (restatement): "The investigation is ongoing."
GOOD (seed): "A preliminary finding from the investigation leaks to someone who shouldn't have it yet."

Rules for each seed:
- Must describe a NEW EVENT that could plausibly occur, not a fact already established.
- Must be triggered by or escalate something already in Active Threads, Pending, Off-Screen, or World Pressures.
- Must leave the outcome open — it is an opportunity, not a resolution.
- Write as a single sentence describing what happens or arrives, not what the character should do.
- If no compelling escalation suggests itself from current pressures, omit this section entirely rather than restating known facts.]

## Potential Entrances
- **NPC Name** [contact]: has standing reason to reach out because [...]
- **NPC Name** [social]: may insert themselves if they learn [...]
- **NPC Name** [institutional]: may appear due to obligation / hierarchy / oversight

[Potential Entrances and Plot Seeds may describe plausible incoming actions or interruptions, but they must be grounded in current obligations, relationships, knowledge states, or world pressures. Do not present them as already occurred facts.]

---

Core rules:
- Preserve stable facts unless the recent chat clearly changes them.
- Update only what has actually changed.
- Prefer concrete facts over interpretation.
- Do not invent off-screen actions unless directly established.
- Track who is PRESENT in the scene vs. off-screen.
- Keep names, locations, timing, and obligations consistent.
- Be concise and information-dense. Under 2000 words.
- Omit sections that have no entries rather than leaving them empty.`;

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

    const rpMarkers = [
        { pattern: /^[A-Z][a-z]+:\s*["""\u201C\u201D]/m, label: 'dialogue formatting (Name: "...)' },
        { pattern: /\b(you see|you notice|before you|you feel)\b/i, label: 'second-person narration' },
        { pattern: /^(Meanwhile|Suddenly|As you|The (?:air|room|silence|darkness))\b/im, label: 'narrative prose opener' },
    ];
    for (const { pattern, label } of rpMarkers) {
        if (pattern.test(text)) return { ok: false, reason: `RP marker detected: ${label}` };
    }

    return { ok: true };
}

function buildUserMessage(reminderReason = '') {
    const prev = getWorldStateText().trim();
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

async function refreshWorldState(isAuto = false) {
    if (wstIsRefreshing) {
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

    const chatIdBefore = getChat()?.length;
    wstIsRefreshing = true;

    try {
        const chat = getChat();
        if (!chat || chat.length === 0) return null;

        const systemPrompt = buildSystemPrompt();
        let result = await fetchFromApi({
            systemPrompt,
            userContent: buildUserMessage(),
            settings: getSettings(),
        });
        let text = normaliseOutput(result);
        let validation = validateOutput(text);

        // One-shot retry with explicit reminder if the model drifted
        if (!validation.ok) {
            console.warn(`[MWT:WorldState] First attempt rejected: ${validation.reason} — retrying once`);
            result = await fetchFromApi({
                systemPrompt,
                userContent: buildUserMessage(validation.reason),
                settings: getSettings(),
            });
            text = normaliseOutput(result);
            validation = validateOutput(text);
            if (!validation.ok) {
                throw new Error(`Model output rejected after retry: ${validation.reason}`);
            }
        }

        // Verify chat hasn't changed during generation
        if (getChat()?.length !== chatIdBefore) return null;

        const oldText = getWorldStateText();

        // Save old to history before updating
        if (oldText?.trim()) pushToHistory(oldText);

        setWorldStateData({ text });
        autoSaveLastText = text;
        isDirty = false;
        applyWorldStateInjection();

        console.log(`[MWT:WorldState] Refresh complete (${text.length} chars)`);
        return text;
    } catch (err) {
        console.error('[MWT:WorldState] Refresh failed:', err);
        throw err;
    } finally {
        wstIsRefreshing = false;
        if (autoRefreshQueued) {
            autoRefreshQueued = false;
            // Use setTimeout instead of direct recursive call to avoid
            // deep call-stack chaining if the queued refresh also fails.
            setTimeout(() => {
                scheduleAutoRefresh('follow-up-from-finally');
            }, 500);
        }
    }
}

// ─── Per-section regeneration ────────────────────────────────────────────────

/**
 * Pull out exactly one "## Section\n...body..." block from a larger text.
 * Stops at the next "## " header or end of text.
 */
function extractOnlySection(text, sectionName) {
    const escaped = escapeRegex(sectionName);
    const pattern = new RegExp(`(## ${escaped}\\b[\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`);
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
}

/**
 * Replace one "## Section" block in the document with newContent.
 * If the section doesn't already exist, append it.
 */
function replaceSection(text, sectionName, newContent) {
    const escaped = escapeRegex(sectionName);
    const pattern = new RegExp(`## ${escaped}\\b[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`);
    const trimmed = newContent.trim();
    if (pattern.test(text)) {
        // Function replacement: regenerated content may contain "$" sequences
        // ($&, $1, …) that a string replacement would otherwise interpret.
        return text.replace(pattern, () => trimmed);
    }
    return (text.trim() + '\n\n' + trimmed).trim();
}

function buildSectionSystemPrompt(sectionName, variety) {
    const baseSystem = buildSystemPrompt();

    let extra = '';
    if (sectionName === 'Plot Seeds') {
        if (variety >= 4) {
            extra = `

VARIETY MODE (level ${variety}/5 — ${VARIETY_LABELS[variety]}):
- Lean toward bold, unexpected, or destabilizing seeds. Avoid the safest interpretation.
- At least one seed should introduce a disruption, twist, or escalation that hasn't been telegraphed yet.
- Diversify categories: try to hit at least 4 different ones from [contact, entrance, social, institutional, opportunity, pressure, threat].
- Consider tangential connections — characters, threads, or pressures that haven't been combined before.
- Still: every seed must be a NEW EVENT, not a restatement of established facts.`;
        } else if (variety === 3) {
            extra = `

VARIETY MODE (level ${variety}/5 — ${VARIETY_LABELS[variety]}):
- Cover more categories than usual: aim for at least 3 different ones from [contact, entrance, social, institutional, opportunity, pressure, threat].
- Mix safer and bolder seeds.
- Consider less obvious escalations of existing pressures.`;
        }
    } else if (variety >= 4) {
        extra = `

VARIETY MODE (level ${variety}/5 — ${VARIETY_LABELS[variety]}):
- Prefer bolder, more vivid, less default interpretations where the section allows it.`;
    }

    const override = `

---

OVERRIDE FOR THIS GENERATION:
- Output ONLY the "## ${sectionName}" section. No other sections.
- Your output MUST begin with the exact header "## ${sectionName}" — nothing before it.
- Use the formatting and rules defined above for that section.
- The rest of the existing world state is provided as context (do NOT include it in your output).${extra}`;

    return baseSystem + override;
}

function buildSectionUserMessage(sectionName) {
    const fullState = getWorldStateText().trim() || 'None yet.';
    const recent = getRecentMessagesForScan() || 'No recent messages.';
    return [
        '### Full Current World State (for context only — do not include in output)',
        fullState,
        '',
        '### Recent Chat Messages',
        recent,
        '',
        '='.repeat(60),
        `Output ONLY the regenerated "## ${sectionName}" section now.`,
        `Begin with the header "## ${sectionName}" — nothing before it.`,
    ].join('\n');
}

function validateSectionOutput(text, sectionName) {
    if (!text) return { ok: false, reason: 'empty response' };

    const escaped = escapeRegex(sectionName);
    const headerPattern = new RegExp(`^##\\s*${escaped}\\b`, 'm');
    if (!headerPattern.test(text)) {
        const preview = text.slice(0, 100).replace(/\n/g, ' ');
        return { ok: false, reason: `missing "## ${sectionName}" header. First 100 chars: "${preview}"` };
    }

    // Light RP-marker check — section bodies are factual, not narrative.
    const rpMarkers = [
        { pattern: /\b(you see|you notice|before you|you feel)\b/i, label: 'second-person narration' },
    ];
    for (const { pattern, label } of rpMarkers) {
        if (pattern.test(text)) return { ok: false, reason: `RP marker detected: ${label}` };
    }

    return { ok: true };
}

async function regenerateSection(sectionName, variety = 2) {
    if (!hasValidSettings()) {
        throw new Error('No API connection configured. Open ⚙ Settings in the World State panel.');
    }
    if (!SECTIONS.includes(sectionName)) {
        throw new Error(`Unknown section: ${sectionName}`);
    }
    if (wstIsRefreshing) {
        throw new Error('World State is already refreshing.');
    }

    wstIsRefreshing = true;

    try {
        // Build API settings with variety-boosted temperature
        const s = getSettings();
        const baseTemp = isNaN(Number(s.temperature)) ? 0.3 : Number(s.temperature);
        const tempBoost = { 1: 0, 2: 0.05, 3: 0.3, 4: 0.55, 5: 0.85 }[variety] || 0;
        const temperature = Math.min(1.4, baseTemp + tempBoost);

        const sectionSettings = { ...s, temperature };

        const raw = await fetchFromApi({
            systemPrompt: buildSectionSystemPrompt(sectionName, variety),
            userContent: buildSectionUserMessage(sectionName),
            settings: sectionSettings,
            retries: 1,
        });

        const text = normaliseOutput(raw);
        const check = validateSectionOutput(text, sectionName);
        if (!check.ok) {
            throw new Error(`Section regen validation failed: ${check.reason}`);
        }

        // Keep only the requested section if the model added neighbours.
        const cleaned = extractOnlySection(text, sectionName) || text.trim();

        const currentText = getWorldStateText();
        const updated = replaceSection(currentText, sectionName, cleaned);

        if (currentText?.trim()) pushToHistory(currentText);
        setWorldStateData({ text: updated });
        applyWorldStateInjection();

        console.log(`[MWT:WorldState] Section "${sectionName}" regenerated (variety ${variety}).`);
        return updated;
    } finally {
        wstIsRefreshing = false;
    }
}

// ─── Archive / Import / Clear ───────────────────────────────────────────────

function downloadWorldStateArchive() {
    const data = getWorldStateData();
    const archive = {
        _meta: { type: 'world-state-archive', version: '1.0', exportedAt: new Date().toISOString() },
        data,
    };
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `worldstate_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importWorldState() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.md,.txt';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const ext = file.name.split('.').pop().toLowerCase();

            // Plain text / markdown import — treat as raw world state text
            if (ext === 'md' || ext === 'txt') {
                if (!confirm('Import this file as world state text? It will replace the current one.')) return;
                const oldText = getWorldStateText();
                if (oldText) pushToHistory(oldText);
                setWorldStateData({ text });
                applyWorldStateInjection();
                renderModalContent();
                setStatus(modal, 'Imported text.', 'success', 3000);
                return;
            }

            // JSON import
            const data = JSON.parse(text);

            // Detect original settings-only export
            if (data._meta?.type === 'world-state-tracker-settings' && data.settings) {
                if (!confirm('Import world state settings? This will overwrite current API/model settings.')) return;
                saveSettings({ ...getSettings(), ...data.settings });
                renderModalContent();
                setStatus(modal, 'Settings imported.', 'success', 3000);
                return;
            }

            // Standard archive import
            const wsData = data.data || data;
            if (!confirm('Import this world state? It will replace the current one.')) return;
            const oldText = getWorldStateText();
            if (oldText) pushToHistory(oldText);
            setWorldStateData({ text: wsData.text || '' });
            applyWorldStateInjection();
            renderModalContent();
            setStatus(modal, 'Imported.', 'success', 3000);
        } catch (err) {
            setStatus(modal, `Import failed: ${err.message}`, 'error');
        }
    };
    input.click();
}

function clearWorldState() {
    if (!confirm('Clear the world state? A snapshot will be saved to history.')) return;
    const oldText = getWorldStateText();
    if (oldText) pushToHistory(oldText);
    setWorldStateData({ text: '' });
    isDirty = false;
    applyWorldStateInjection();
    renderModalContent();
}

// ─── Revert / Diff ──────────────────────────────────────────────────────────

function showRevertDiff() {
    const history = getAutoSaveHistory();
    if (history.length === 0) { alert('No history available to revert to.'); return; }

    const latest = history[history.length - 1];
    const currentText = getWorldStateText();
    const diffHtml = renderDiffHtml(computeLcsDiff(currentText, latest.text));

    const diffModal = createModal({
        id: 'mwt-ws-revert-modal',
        title: 'Revert World State',
        content: `
            <p class="mwt-text-dim mwt-text-sm mwt-mb-8">
                Showing diff: <strong>Current</strong> → <strong>Previous snapshot</strong>
                (${new Date(latest.timestamp).toLocaleString()})
            </p>
            ${diffHtml}
            <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                <button id="mwt-ws-revert-confirm" class="mwt-btn mwt-btn-danger">Revert to This</button>
                <button id="mwt-ws-revert-cancel" class="mwt-btn">Cancel</button>
            </div>
        `,
    });

    diffModal.querySelector('#mwt-ws-revert-confirm').addEventListener('click', () => {
        setWorldStateData({ text: latest.text });
        autoSaveLastText = latest.text;
        isDirty = false;
        applyWorldStateInjection();
        renderModalContent();
        hideModal('mwt-ws-revert-modal');
        setStatus(modal, 'Reverted.', 'success', 3000);
    });
    diffModal.querySelector('#mwt-ws-revert-cancel').addEventListener('click', () => {
        hideModal('mwt-ws-revert-modal');
    });
    showModal('mwt-ws-revert-modal');
}

function showAutoSaveHistory() {
    const history = getAutoSaveHistory();
    if (history.length === 0) { alert('No auto-save history yet.'); return; }

    const items = history.slice().reverse().map((h, i) => `
        <div class="mwt-history-item" style="padding:8px;border-bottom:1px solid var(--mwt-border);cursor:pointer" data-idx="${history.length - 1 - i}">
            <span class="mwt-text-dim mwt-text-sm">${new Date(h.timestamp).toLocaleString()}</span>
            <span class="mwt-text-dim mwt-text-sm"> — ${h.text.length} chars</span>
        </div>
    `).join('');

    const histModal = createModal({
        id: 'mwt-ws-history-modal',
        title: 'Auto-Save History',
        content: `<div>${items}</div>`,
    });

    histModal.querySelectorAll('.mwt-history-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx);
            const entry = history[idx];
            const currentText = getWorldStateText();
            const diffHtml = renderDiffHtml(computeLcsDiff(currentText, entry.text));
            // Show diff in a new modal
            const diffModal2 = createModal({
                id: 'mwt-ws-hist-diff-modal',
                title: `History: ${new Date(entry.timestamp).toLocaleString()}`,
                content: `
                    ${diffHtml}
                    <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                        <button id="mwt-ws-restore-hist" class="mwt-btn mwt-btn-primary">Restore This</button>
                        <button id="mwt-ws-close-hist" class="mwt-btn">Close</button>
                    </div>
                `,
            });
            diffModal2.querySelector('#mwt-ws-restore-hist').addEventListener('click', () => {
                const old = getWorldStateText();
                if (old) pushToHistory(old);
                setWorldStateData({ text: entry.text });
                autoSaveLastText = entry.text;
                isDirty = false;
                applyWorldStateInjection();
                renderModalContent();
                hideModal('mwt-ws-hist-diff-modal');
                hideModal('mwt-ws-history-modal');
                setStatus(modal, 'Restored from history.', 'success', 3000);
            });
            diffModal2.querySelector('#mwt-ws-close-hist').addEventListener('click', () => {
                hideModal('mwt-ws-hist-diff-modal');
            });
            showModal('mwt-ws-hist-diff-modal');
        });
    });
    showModal('mwt-ws-history-modal');
}

// ─── UI rendering ────────────────────────────────────────────────────────────

function updateEditorStats() {
    if (!modal) return;
    const editor = modal.querySelector('#ws-editor');
    const stats = modal.querySelector('#ws-editor-stats');
    if (!editor || !stats) return;
    const text = editor.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    stats.textContent = `${text.length} chars · ${words} words · ${text.split('\n').length} lines`;
}

function refreshRevertButton() {
    if (!modal) return;
    const btn = modal.querySelector('#ws-revert');
    if (btn) btn.disabled = getAutoSaveHistory().length === 0;
}

function updateArchiveButtonState() {
    if (!modal) return;
    const btn = modal.querySelector('#ws-archive');
    if (btn) btn.disabled = !getWorldStateText()?.trim();
}

function refreshButtonLabels() {
    if (!modal) return;
    const injectBtn = modal.querySelector('#ws-toggle-inject');
    const autoBtn = modal.querySelector('#ws-toggle-auto');
    if (injectBtn) {
        injectBtn.textContent = isInjectionEnabled() ? '🔌 Injection: ON' : '🔌 Injection: OFF';
    }
    if (autoBtn) {
        if (isAutoRefreshEnabled()) {
            autoBtn.textContent = `🔄 Auto: ${autoRefreshCounter}/${getAutoRefreshInterval()}`;
        } else {
            autoBtn.textContent = '🔄 Auto: OFF';
        }
    }
}

function renderModalContent() {
    if (!modal) return;
    const editor = modal.querySelector('#ws-editor');
    if (editor) editor.value = getWorldStateText();
    updateEditorStats();
    refreshRevertButton();
    updateArchiveButtonState();
    refreshButtonLabels();
}

function render() {
    const s = getSettings();
    const text = getWorldStateText();
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const tokens = estimateTokens(text);
    const autoEnabled = isAutoRefreshEnabled();
    const autoInterval = getAutoRefreshInterval();
    const maxScan = getMaxScanMessages();

    const sectionOptions = SECTIONS.map(sec =>
        `<option value="${escapeHtml(sec)}">${escapeHtml(sec)}</option>`
    ).join('');

    return `
        <div class="ws-toolbar mwt-flex mwt-gap-4 mwt-mb-8" style="flex-wrap:wrap">
            <button id="ws-refresh" class="mwt-btn mwt-btn-primary">🔄 Refresh</button>
            <button id="ws-save" class="mwt-btn">💾 Save</button>
            <button id="ws-revert" class="mwt-btn" ${getAutoSaveHistory().length === 0 ? 'disabled' : ''}>⏪ Revert</button>
            <button id="ws-history" class="mwt-btn">📋 History</button>
            <button id="ws-archive" class="mwt-btn" ${!text?.trim() ? 'disabled' : ''}>📦 Export</button>
            <button id="ws-import" class="mwt-btn">📥 Import</button>
            <button id="ws-clear" class="mwt-btn mwt-btn-danger">🗑️ Clear</button>
            <span class="mwt-text-dim mwt-text-sm" style="margin-left:auto;line-height:28px">${words} words · ~${tokens} tokens${autoEnabled ? ` · Auto: ${autoRefreshCounter}/${autoInterval} msgs` : ''}</span>
        </div>

        <div class="mwt-form-row">
            <textarea id="ws-editor" class="mwt-textarea" style="min-height:300px">${escapeHtml(text)}</textarea>
            <div id="ws-editor-stats" class="mwt-text-dim mwt-text-sm mwt-mt-8">${text.length} chars · ${words} words · ~${tokens} tokens</div>
        </div>

        ${autoEnabled ? `<div style="color:var(--mwt-accent);font-size:12px;margin-bottom:4px">🔄 Auto-refresh: ON — refreshes every ${autoInterval} messages (${autoRefreshCounter}/${autoInterval} since last)</div>` : ''}

        <details class="mwt-mt-8" open>
            <summary style="cursor:pointer;color:var(--mwt-accent);font-weight:500">🎯 Regenerate Section</summary>
            <div style="padding:8px 0">
                <div class="mwt-flex mwt-gap-4" style="align-items:center;flex-wrap:wrap">
                    <select id="ws-section-select" class="mwt-input" style="max-width:200px">
                        ${sectionOptions}
                    </select>
                    <div class="mwt-flex mwt-gap-4" style="align-items:center">
                        <label class="mwt-label" style="margin:0;white-space:nowrap">Variety:</label>
                        <input id="ws-variety-slider" type="range" min="1" max="5" value="2" style="width:120px">
                        <span id="ws-variety-label" style="font-size:11px;color:#c4b5fd;min-width:80px">${VARIETY_LABELS[2]}</span>
                    </div>
                    <button id="ws-regen-section" class="mwt-btn" style="background:#6d28d9;border-color:#7c3aed;color:#fff">🎲 Regenerate Section</button>
                </div>
                <p style="font-size:11px;color:var(--mwt-text-dim);margin:6px 0 0">Regenerate a single section with adjustable variety. Higher variety = bolder, more unexpected results.</p>
            </div>
        </details>

        <details class="mwt-mt-8">
            <summary style="cursor:pointer;color:var(--mwt-accent);font-weight:500">⚙️ World State Settings</summary>
            <div class="mwt-settings-grid mwt-mt-8">
                <label class="mwt-label">API URL</label>
                <input id="ws-api-url" class="mwt-input" value="${escapeHtml(s.apiUrl)}" placeholder="https://api.openai.com/v1">

                <label class="mwt-label">API Key</label>
                <input id="ws-api-key" class="mwt-input" type="password" value="${escapeHtml(s.apiKey)}">

                <label class="mwt-label">Model</label>
                <input id="ws-model" class="mwt-input" value="${escapeHtml(s.modelName)}" placeholder="gpt-4o-mini">

                <label class="mwt-label">Temperature</label>
                <input id="ws-temp" class="mwt-input" type="number" value="${s.temperature ?? 0.3}" min="0" max="2" step="0.05">

                <label class="mwt-label">Max Tokens</label>
                <input id="ws-max-tokens" class="mwt-input" type="number" value="${s.maxTokens || 2000}" min="100" max="32000">

                <label class="mwt-label">Injection Depth</label>
                <input id="ws-injection-depth" class="mwt-input" type="number" value="${s.injectionDepth ?? 1}" min="0" max="999">

                <label class="mwt-label">Scan Messages</label>
                <div>
                    <input id="ws-max-scan-messages" class="mwt-input" type="number" value="${maxScan}" min="1" max="30" style="max-width:100px">
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">How many previous messages to scan (max 30). Auto-snapshot interval cannot exceed this.</p>
                </div>

                <label class="mwt-label">Auto-Save (sec)</label>
                <input id="ws-auto-save-interval" class="mwt-input" type="number" value="${s.autoSaveInterval || DEFAULT_AUTO_SAVE_INTERVAL}" min="30">

                <label class="mwt-label">Custom Prompt</label>
                <textarea id="ws-custom-prompt" class="mwt-input" rows="3" placeholder="Leave blank for default prompt">${escapeHtml(s.customPrompt || '')}</textarea>
                <div></div><p style="font-size:11px;color:var(--mwt-text-dim);margin:0">Custom Prompt: Overrides the system prompt sent to the AI. Must start with instructions to output "## Current Scene". Leave blank to use the built-in default prompt. Click "Reset Prompt" to clear.</p>

                <label class="mwt-label">Hook Mode</label>
                <div>
                    <select id="ws-hook-mode" class="mwt-input" style="max-width:180px">
                        <option value="off" ${s.hookMode === 'off' ? 'selected' : ''}>Off</option>
                        <option value="passive" ${(s.hookMode || 'passive') === 'passive' ? 'selected' : ''}>Passive</option>
                        <option value="proactive" ${s.hookMode === 'proactive' ? 'selected' : ''}>Proactive</option>
                        <option value="assertive" ${s.hookMode === 'assertive' ? 'selected' : ''}>Assertive</option>
                    </select>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0"><b>Off:</b> Plot Seeds are not injected into the prompt. <b>Passive:</b> Model is encouraged to use a hook if the scene allows. <b>Proactive:</b> Model should introduce a hook unless the scene is at a climax — player pre-approval is stated. <b>Assertive:</b> Model must introduce at least one hook — the world moves without player permission.</p>
                </div>

                <label class="mwt-label">Message Filter</label>
                <div>
                    <textarea id="ws-message-filter" class="mwt-input" rows="3" placeholder="One regex per line. Matching text is stripped from messages before scanning.&#10;Example: [NPC thoughts][\\s\\S]*?[/NPC thoughts]">${escapeHtml(s.messageFilter || '')}</textarea>
                    <p style="font-size:11px;color:var(--mwt-text-dim);margin:4px 0 0">Each line is a separate regex pattern (case-insensitive). Matching content is removed from chat messages <i>before</i> the World State scanner sees them. Use this to strip out NPC thought blocks, OOC notes, or other content that shouldn't influence the world state.</p>
                </div>

                <div></div>
                <div class="mwt-flex mwt-gap-4" style="flex-wrap:wrap">
                    <button id="ws-save-settings" class="mwt-btn mwt-btn-primary">Save Settings</button>
                    <button id="ws-test-connection" class="mwt-btn">Test Connection</button>
                    <button id="ws-toggle-inject" class="mwt-btn">${isInjectionEnabled() ? '🔌 Injection: ON' : '🔌 Injection: OFF'}</button>
                    <button id="ws-toggle-auto" class="mwt-btn">${isAutoRefreshEnabled() ? `🔄 Auto: ON (${getAutoRefreshInterval()})` : '🔄 Auto: OFF'}</button>
                    <button id="ws-reset-prompt" class="mwt-btn">Reset Prompt</button>
                    <button id="ws-preview-injection" class="mwt-btn">📄 Preview Injection</button>
                </div>
            </div>
        </details>
    `;
}

function wireEvents() {
    if (!modal) return;

    // Save
    modal.querySelector('#ws-save')?.addEventListener('click', () => {
        const newText = modal.querySelector('#ws-editor')?.value || '';
        const currentText = getWorldStateText();
        if (newText !== currentText) {
            pushToHistory(currentText);
            autoSaveLastText = newText;
        }
        isDirty = false;
        setWorldStateData({ text: newText });
        applyWorldStateInjection();
        refreshRevertButton();
        updateArchiveButtonState();
        updateEditorStats();
        setStatus(modal, 'Saved.', 'success', 3000);
    });

    // Refresh
    modal.querySelector('#ws-refresh')?.addEventListener('click', async () => {
        const btn = modal.querySelector('#ws-refresh');
        try {
            const editorEl = modal.querySelector('#ws-editor');
            if (editorEl && editorEl.value && editorEl.value !== getWorldStateText()) {
                setWorldStateData({ text: editorEl.value });
            }
            btn.disabled = true; btn.textContent = '⏳ Refreshing…';
            setStatus(modal, 'Generating world state…', 'info');
            const text = await refreshWorldState();
            if (text === null) { setStatus(modal, 'Refresh aborted.', 'info'); return; }
            const editor = modal.querySelector('#ws-editor');
            if (editor) editor.value = text;
            autoSaveLastText = text; isDirty = false;
            updateArchiveButtonState();
            updateEditorStats();
            refreshRevertButton();
            setStatus(modal, 'Refresh complete.', 'success', 3000);
        } catch (err) {
            setStatus(modal, `Error: ${err.message}`, 'error');
        } finally {
            btn.disabled = false; btn.textContent = '🔄 Refresh';
        }
    });

    // Revert
    modal.querySelector('#ws-revert')?.addEventListener('click', () => showRevertDiff());

    // History
    modal.querySelector('#ws-history')?.addEventListener('click', () => showAutoSaveHistory());

    // Archive
    modal.querySelector('#ws-archive')?.addEventListener('click', () => downloadWorldStateArchive());

    // Import
    modal.querySelector('#ws-import')?.addEventListener('click', () => importWorldState());

    // Clear
    modal.querySelector('#ws-clear')?.addEventListener('click', () => clearWorldState());

    // Editor input
    modal.querySelector('#ws-editor')?.addEventListener('input', () => {
        isDirty = true;
        updateArchiveButtonState();
        updateEditorStats();
    });

    // Variety slider
    modal.querySelector('#ws-variety-slider')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        const label = modal.querySelector('#ws-variety-label');
        if (label) label.textContent = VARIETY_LABELS[val] || `Level ${val}`;
    });

    // Regenerate section
    modal.querySelector('#ws-regen-section')?.addEventListener('click', async () => {
        const sectionSelect = modal.querySelector('#ws-section-select');
        const varietySlider = modal.querySelector('#ws-variety-slider');
        const regenBtn = modal.querySelector('#ws-regen-section');
        const sectionName = sectionSelect?.value;
        const variety = parseInt(varietySlider?.value || '2', 10);

        if (!sectionName) { setStatus(modal, 'Select a section first.', 'error'); return; }

        try {
            regenBtn.disabled = true; regenBtn.textContent = '⏳ Regenerating…';
            setStatus(modal, `Regenerating "${sectionName}" (variety: ${VARIETY_LABELS[variety]})…`, 'info');
            const updated = await regenerateSection(sectionName, variety);
            if (updated) {
                const editor = modal.querySelector('#ws-editor');
                if (editor) editor.value = updated;
                autoSaveLastText = updated;
                isDirty = false;
                updateEditorStats();
                updateArchiveButtonState();
                refreshRevertButton();
                setStatus(modal, `Section "${sectionName}" regenerated (${VARIETY_LABELS[variety]}).`, 'success', 3000);
            }
        } catch (err) {
            setStatus(modal, `Section regen failed: ${err.message}`, 'error');
        } finally {
            regenBtn.disabled = false; regenBtn.textContent = '🎲 Regenerate Section';
        }
    });

    // Save settings
    modal.querySelector('#ws-save-settings')?.addEventListener('click', () => {
        const url = modal.querySelector('#ws-api-url')?.value.trim();
        const key = modal.querySelector('#ws-api-key')?.value.trim();
        const model = modal.querySelector('#ws-model')?.value.trim();
        const temp = parseFloat(modal.querySelector('#ws-temp')?.value);
        const tokens = parseInt(modal.querySelector('#ws-max-tokens')?.value, 10);
        const autoSaveSec = parseInt(modal.querySelector('#ws-auto-save-interval')?.value, 10) || DEFAULT_AUTO_SAVE_INTERVAL;
        const customPrompt = modal.querySelector('#ws-custom-prompt')?.value.trim() || '';
        const depth = parseInt(modal.querySelector('#ws-injection-depth')?.value, 10);
        const maxScan = parseInt(modal.querySelector('#ws-max-scan-messages')?.value, 10);
        const hookMode = modal.querySelector('#ws-hook-mode')?.value || 'passive';
        const messageFilter = modal.querySelector('#ws-message-filter')?.value || '';

        if (!url || !key || !model) {
            setStatus(modal, 'API URL, Key, and Model are required.', 'error');
            return;
        }

        saveSettings({
            apiUrl: url, apiKey: key, modelName: model,
            temperature: isNaN(temp) ? 0.3 : temp,
            maxTokens: isNaN(tokens) ? 2000 : tokens,
            autoSaveInterval: Math.max(30, autoSaveSec),
            customPrompt,
            injectionDepth: isNaN(depth) ? 1 : depth,
            maxScanMessages: Math.min(Math.max(1, isNaN(maxScan) ? 20 : maxScan), 30),
            hookMode,
            messageFilter,
        });
        applyWorldStateInjection();
        startAutoSaveTimer();
        setStatus(modal, 'Settings saved.', 'success', 3000);
    });

    // Test connection
    modal.querySelector('#ws-test-connection')?.addEventListener('click', async () => {
        const btn = modal.querySelector('#ws-test-connection');
        const url = modal.querySelector('#ws-api-url')?.value.trim();
        const key = modal.querySelector('#ws-api-key')?.value.trim();
        const model = modal.querySelector('#ws-model')?.value.trim();
        if (!url || !key || !model) { setStatus(modal, 'Fill URL, Key, Model first.', 'error'); return; }

        try {
            btn.disabled = true; btn.textContent = 'Testing…';
            setStatus(modal, 'Testing connection…', 'info');
            const resp = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with: OK' }], max_tokens: 10, temperature: 0 }),
            });
            if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
            const data = await resp.json();
            setStatus(modal, `OK — model replied: "${data?.choices?.[0]?.message?.content?.trim()}"`, 'success', 5000);
        } catch (err) {
            setStatus(modal, `Failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false; btn.textContent = 'Test Connection';
        }
    });

    // Toggle injection
    modal.querySelector('#ws-toggle-inject')?.addEventListener('click', () => {
        const next = !isInjectionEnabled();
        setWorldStateData({ injectEnabled: next });
        applyWorldStateInjection();
        refreshButtonLabels();
        setStatus(modal, `Injection ${next ? 'enabled' : 'disabled'}.`, 'info', 3000);
    });

    // Toggle auto-refresh
    modal.querySelector('#ws-toggle-auto')?.addEventListener('click', () => {
        if (!isAutoRefreshEnabled()) {
            const raw = prompt(`Auto-refresh every N messages:`, String(getAutoRefreshInterval()));
            if (!raw) return;
            const n = parseInt(raw, 10);
            if (isNaN(n) || n < 1) { setStatus(modal, 'Invalid interval.', 'error'); return; }
            const maxScan = getMaxScanMessages();
            const clamped = Math.min(n, maxScan);
            if (n > maxScan) {
                setStatus(modal, `Auto-refresh interval clamped to ${maxScan} (max scan messages).`, 'warning', 5000);
            }
            setWorldStateData({ autoRefresh: true, autoRefreshInterval: clamped });
            autoRefreshCounter = 0;
            setStatus(modal, `Auto-refresh: every ${clamped} messages.`, 'success', 3000);
        } else {
            setWorldStateData({ autoRefresh: false });
            setStatus(modal, 'Auto-refresh disabled.', 'info', 3000);
        }
        refreshButtonLabels();
    });

    // Reset prompt
    modal.querySelector('#ws-reset-prompt')?.addEventListener('click', () => {
        const ta = modal.querySelector('#ws-custom-prompt');
        if (ta) ta.value = '';
        setStatus(modal, 'Custom prompt cleared.', 'info', 3000);
    });

    // Preview injection
    modal.querySelector('#ws-preview-injection')?.addEventListener('click', () => {
        const text = getWorldStateText();
        if (!text?.trim()) {
            setStatus(modal, 'No world state text to preview.', 'warning');
            return;
        }

        const seedsPattern = new RegExp(`## Plot Seeds\\b[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`);
        const seedsMatch = text.match(seedsPattern);
        const seedsBlock = seedsMatch ? seedsMatch[0] : '';
        const seedsText = seedsBlock.replace(/^## Plot Seeds[^\n]*\n?/, '').trim();
        const worldStateBody = seedsMatch
            ? text.replace(seedsBlock, '').replace(/\n{3,}/g, '\n\n').trim()
            : text;

        let injected = `${WORLD_STATE_INJECTION_HEADER}\n\n${worldStateBody}`;

        const seedsHeader = getPlotSeedsHeader();
        if (seedsText && seedsHeader) {
            injected += `\n\n---\n\n${seedsHeader}\n\n${seedsText}`;
        }

        const tokens = estimateTokens(injected);
        const previewModal = createModal({
            id: 'mwt-ws-injection-preview',
            title: 'Injection Preview',
            content: `
                <p class="mwt-text-dim mwt-text-sm mwt-mb-8">
                    This is exactly what gets injected into the prompt (${injected.length} chars, ~${tokens} tokens).
                    Hook mode: <strong>${getHookMode()}</strong>.
                </p>
                <pre style="white-space:pre-wrap;font-family:var(--mwt-font-mono);font-size:12px;line-height:1.5;background:var(--mwt-bg-light);padding:12px;border-radius:var(--mwt-radius);border:1px solid var(--mwt-border);max-height:60vh;overflow-y:auto">${escapeHtml(injected)}</pre>
                <div class="mwt-flex mwt-gap-8 mwt-mt-8">
                    <button id="mwt-ws-preview-copy" class="mwt-btn mwt-btn-primary">📋 Copy to Clipboard</button>
                    <button id="mwt-ws-preview-close" class="mwt-btn">Close</button>
                </div>
            `,
        });

        previewModal.querySelector('#mwt-ws-preview-copy')?.addEventListener('click', () => {
            navigator.clipboard.writeText(injected).then(() => {
                setStatus(previewModal, 'Copied to clipboard.', 'success', 2000);
            }).catch(() => {
                setStatus(previewModal, 'Failed to copy.', 'error');
            });
        });

        previewModal.querySelector('#mwt-ws-preview-close')?.addEventListener('click', () => {
            hideModal('mwt-ws-injection-preview');
        });

        showModal('mwt-ws-injection-preview');
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(parentModal) {
    modal = parentModal;
    applyWorldStateInjection();
    startAutoSaveTimer();
    console.log('[MWT:WorldState] Module initialized');
}

export function getModuleRender() { return render; }
export function getModuleWireEvents() { return wireEvents; }
export function getModuleRefreshContent() { return renderModalContent; }
export { getWorldStateText, applyWorldStateInjection, onMessageReceived, resetAutoRefreshCounter };

export function onChatChanged() {
    isDirty = false;
    autoSaveLastText = '';
    autoRefreshQueued = false;
    if (autoRefreshDeferTimer) { clearTimeout(autoRefreshDeferTimer); autoRefreshDeferTimer = null; }
    // Don't reset wstIsRefreshing — an in-flight API call should finish naturally
    resetAutoRefreshCounter();
    applyWorldStateInjection();
    console.log('[MWT:WorldState] Chat changed — state reset.');
}

/** Returns estimated token count for the currently injected world state text */
export function getTotalTokens() {
    const text = getWorldStateText();
    if (!text) return 0;
    // Include injection headers in count
    const fullInjected = `${WORLD_STATE_INJECTION_HEADER}\n\n${text}`;
    return estimateTokens(fullInjected);
}

/** Returns true if the world state editor has unsaved changes */
export function isWorldStateDirty() {
    return isDirty;
}

/** Returns auto-refresh status for external display (floating button countdown) */
export function getAutoRefreshStatus() {
    if (!isAutoRefreshEnabled()) return null;
    return {
        counter: autoRefreshCounter,
        interval: getAutoRefreshInterval(),
    };
}

export function syncGlobalSettings(patch) {
    if (patch?.apiUrl !== undefined || patch?.apiKey !== undefined || patch?.modelName !== undefined) {
        saveSettings({
            ...getSettings(),
            apiUrl: patch.apiUrl ?? getSettings().apiUrl,
            apiKey: patch.apiKey ?? getSettings().apiKey,
            modelName: patch.modelName ?? getSettings().modelName,
        });
        console.log('[MWT:WorldState] Synced global API settings');
    }
}