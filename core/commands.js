/**
 * core/commands.js — Slash command and macro registration.
 *
 * Extracted from index.js to keep the entry point focused on UI and event hooks.
 * Macro registration uses only the modern macro-system.js registry
 * (SillyTavern 1.12+).
 */

/**
 * Create the command/macro subsystem.
 *
 * @param {object} deps
 * @param {Function|null} deps.registerSlashCommand — ST slash command registrar
 * @param {object|null} deps.macroRegistry — ST macro-system registry
 * @param {object} deps.modules — { WorldState, Chronicle, Knowledge }
 * @returns {{ setupSlashCommands: Function, setupMacros: Function }}
 */
export function createCommands({ registerSlashCommand, macroRegistry, modules, resetFloatPositions, saveSettings }) {
    const { WorldState, Chronicle, Knowledge, StoryPlanner, Interiority } = modules;

    // ─── Slash Commands ──────────────────────────────────────────────────────

    function setupSlashCommands() {
        if (!registerSlashCommand) {
            console.warn('[MWT] registerSlashCommand not available — slash commands disabled.');
            return;
        }

        try {
            // /wt-refresh — Trigger world state refresh
            registerSlashCommand('wt-refresh', async (_args, _command) => {
                try {
                    if (typeof WorldState.triggerRefresh === 'function') {
                        await WorldState.triggerRefresh();
                        return 'World state refreshed.';
                    }
                    return 'World state refresh not available.';
                } catch (err) {
                    return `Error: ${err.message}`;
                }
            }, ['mwt-refresh'], 'Refresh the MWT world state');

            // /wt-snapshot — Generate chronicle snapshot
            registerSlashCommand('wt-snapshot', async (_args, _command) => {
                try {
                    if (typeof Chronicle.triggerSnapshot === 'function') {
                        await Chronicle.triggerSnapshot();
                        return 'Chronicle snapshot generated.';
                    }
                    return 'Chronicle snapshot not available.';
                } catch (err) {
                    return `Error: ${err.message}`;
                }
            }, ['mwt-snapshot'], 'Generate a chronicle snapshot');

            // /wt-scan — Run knowledge NPC scan
            registerSlashCommand('wt-scan', async (_args, _command) => {
                try {
                    if (typeof Knowledge.triggerScan === 'function') {
                        await Knowledge.triggerScan();
                        return 'NPC scan complete.';
                    }
                    return 'NPC scan not available.';
                } catch (err) {
                    return `Error: ${err.message}`;
                }
            }, ['mwt-scan'], 'Run an NPC scan via Knowledge Tracker');

            // /wt-plan — Generate a story plan
            registerSlashCommand('wt-plan', async (_args, _command) => {
                try {
                    if (typeof StoryPlanner.triggerGenerate === 'function') {
                        await StoryPlanner.triggerGenerate();
                        return 'Story plan generated.';
                    }
                    return 'Story plan not available.';
                } catch (err) {
                    return `Error: ${err.message}`;
                }
            }, ['mwt-plan'], 'Generate a Story Planner plan');

            // /wt-beat [n] — Review or advance Story Planner setup beats.
            //
            // The point of this command is that marking a beat planted should
            // not require opening the modal: the user notices the setup land in
            // the narration and confirms it right where they are reading.
            registerSlashCommand('wt-beat', async (args, _command) => {
                try {
                    if (typeof StoryPlanner.listBeats !== 'function') {
                        return 'Story Planner not available.';
                    }
                    const arg = (args || '').toString().trim();

                    if (arg) {
                        const result = StoryPlanner.markBeatPlanted(Number(arg));
                        return result.message;
                    }

                    const beats = StoryPlanner.listBeats();
                    if (!beats.length) return 'No arcs are waiting on a setup beat.';
                    const lines = beats.map(b =>
                        `${b.n}. [${b.step}, ${b.waited} turn${b.waited === 1 ? '' : 's'}] ${b.title} — ${b.beat}`,
                    );
                    return `Setup beats waiting:\n${lines.join('\n')}\n\nMark one planted with /wt-beat <number>.`;
                } catch (err) {
                    return `Error: ${err.message}`;
                }
            }, ['mwt-beat'], 'List Story Planner setup beats, or mark one planted: /wt-beat 2');

            // /wt-thoughts — Generate interiority (NPC thoughts)
            registerSlashCommand('wt-thoughts', async (_args, _command) => {
                try {
                    if (typeof Interiority.triggerGenerate === 'function') {
                        const result = await Interiority.triggerGenerate();
                        if (result) return `Interiority generated: ${result.reactions.length} reaction(s).`;
                        return 'Interiority generated (no reactions this turn).';
                    }
                    return 'Interiority not available.';
                } catch (err) {
                    return `Error: ${err.message}`;
                }
            }, ['mwt-thoughts'], 'Generate NPC interiority (thoughts and intentions)');

            // /wt-inject on|off — Toggle injection for ALL modules
            // CORE-02: Previously only called WorldState and Chronicle, missing
            // Story Planner and Interiority entirely, and never set
            // injectionMasterOff. Now calls all five modules that inject AND
            // sets the master flag so Interiority/Knowledge are gated too —
            // matching the right-click panic switch on the ⚙️ floating button.
            registerSlashCommand('wt-inject', async (args, _command) => {
                const mode = (args || '').trim().toLowerCase();
                if (mode !== 'on' && mode !== 'off') {
                    return 'Usage: /wt-inject on|off';
                }
                const enabled = mode === 'on';
                if (typeof WorldState.setInjectionEnabled === 'function') {
                    WorldState.setInjectionEnabled(enabled);
                }
                if (typeof Chronicle.setInjectionEnabled === 'function') {
                    Chronicle.setInjectionEnabled(enabled);
                }
                if (typeof StoryPlanner.setInjectionEnabled === 'function') {
                    StoryPlanner.setInjectionEnabled(enabled);
                }
                // CORE-02: Set the master injection flag so Interiority and
                // Knowledge are also gated. Interiority's injection is driven
                // by the ledger and Knowledge uses SillyTavern's own World Info;
                // both are gated at the root level by injectionMasterOff (see
                // core/settings.js#injectionAllowed and index.js MESSAGE_RECEIVED).
                // Without this, /wt-inject off left Interiority/Knowledge
                // injecting — the UI panic switch and the command disagreed.
                if (typeof saveSettings === 'function') {
                    saveSettings({ injectionMasterOff: !enabled });
                    // Re-apply injection state immediately so the toggle takes
                    // effect without requiring a new message.
                    try {
                        WorldState.applyWorldStateInjection?.();
                        Chronicle.applyInjection?.();
                        StoryPlanner.applyPlanInjection?.();
                        Interiority.applyIntentionsInjection?.();
                    } catch { /* modules may not be initialized yet */ }
                }
                return `Injection ${mode} for all modules.`;
            }, ['mwt-inject'], 'Toggle injection for all MWT modules (on/off)');

            // /wt-state — Return world state text (pipeable)
            registerSlashCommand('wt-state', async (_args, _command) => {
                const text = typeof WorldState.getWorldStateText === 'function'
                    ? WorldState.getWorldStateText()
                    : '';
                return text || '(no world state)';
            }, ['mwt-state'], 'Output the current world state text (pipeable)');

            // /wt-reset-buttons — Reset floating-button positions to defaults
            registerSlashCommand('wt-reset-buttons', async (_args, _command) => {
                if (typeof resetFloatPositions === 'function') {
                    resetFloatPositions();
                    return 'Floating buttons reset to default positions.';
                }
                return 'Reset function not available.';
            }, ['mwt-reset-buttons'], 'Reset floating MWT buttons to their default positions');

            console.log('[MWT] Slash commands registered.');
        } catch (err) {
            console.warn('[MWT] Failed to register slash commands:', err);
        }
    }

    // ─── Macros ──────────────────────────────────────────────────────────────

    function setupMacros() {
        // Requires macro-system.js (available in SillyTavern 1.12+)
        if (macroRegistry && typeof macroRegistry.registerMacro === 'function') {
            try {
                macroRegistry.registerMacro('worldstate', {
                    handler: () => WorldState.getWorldStateText?.() || '',
                    category: 'state',
                    description: 'Returns the current merged world state text.',
                });
                macroRegistry.registerMacro('chronicle', {
                    handler: () => Chronicle.getChronicleText?.() || '',
                    category: 'state',
                    description: 'Returns the full chronicle text.',
                });
                macroRegistry.registerMacro('lastchronicle', {
                    handler: () => Chronicle.getLastEntryText?.() || '',
                    category: 'state',
                    description: 'Returns the most recent chronicle entry.',
                });
                macroRegistry.registerMacro('storyplan', {
                    handler: () => StoryPlanner.getPlanTextForMacro?.() || '',
                    category: 'state',
                    description: 'Returns the current story plan text.',
                });
                console.log('[MWT] Macros registered: {{worldstate}}, {{chronicle}}, {{lastchronicle}}, {{storyplan}}');
            } catch (err) {
                console.warn('[MWT] Failed to register macros:', err);
            }
            return;
        }

        console.warn('[MWT] macro-system.js registry not available — macros disabled.');
    }

    return { setupSlashCommands, setupMacros };
}