/**
 * interiority/prompts.js — System prompt and JSON output contract.
 *
 * Leaf module — no interiority imports.
 */

/**
 * Build the system prompt for the interiority generation call.
 *
 * The prompt is assembled dynamically so that only the requested features
 * (thoughts and/or intentions) are described to the model. When a feature
 * is disabled the model is never asked for it, which keeps responses lean
 * and avoids confusion.
 *
 * House style: ABSOLUTE RULES, JSON only, no fences — matching the
 * knowledge/world state scanner prompts.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.thoughts=true]  - include the reaction/thought contract
 * @param {boolean} [opts.intentions=true] - include the intention evaluation contract
 * @returns {string}
 */
export function buildSystemPrompt({ thoughts = true, intentions = true } = {}) {
    const wantThoughts = thoughts !== false;
    const wantIntentions = intentions !== false;

    const purposeLine = (() => {
        if (wantThoughts && wantIntentions) {
            return 'You are an interiority engine for a role-playing story. You generate the private thoughts and hidden intentions of NPCs (non-player characters).';
        }
        if (wantThoughts) {
            return 'You are an interiority engine for a role-playing story. You generate the private thoughts of NPCs (non-player characters).';
        }
        return 'You are an intention tracker for a role-playing story. You track and update the hidden intentions of NPCs (non-player characters).';
    })();

    const contextLine = wantIntentions
        ? 'You will receive, for each NPC: their knowledge ledger / dossier entry, their current open intentions, any plans they have already scheduled, and a window of recent story messages.'
        : 'You will receive, for each NPC: their knowledge ledger / dossier entry and a window of recent story messages.';

    // ── Rules ──
    const rules = [];
    let n = 0;

    rules.push(`${++n}. Output ONLY valid JSON. No markdown fences, no prose before or after.`);

    if (wantThoughts) {
        rules.push(`${++n}. Each NPC may react ONLY to events they could personally witness in <recent_messages>. Facts are limited to their <knowledge_entry> and witnessed events.`);
        rules.push(`${++n}. An NPC may NEVER reference, know, or allude to another NPC's thoughts, secrets, or hidden intentions. Each NPC's mind is sealed.`);
    }

    if (wantIntentions) {
        rules.push(`${++n}. Evaluate each open intention from the <open_intentions> list. The DEFAULT outcome is "open" (carry forward) — only mark "executed" or "dropped" when there is clear, unmistakable evidence:`);
        rules.push(`   - "executed": ONLY if the recent messages show the NPC has ALREADY COMPLETED the action in full, on-screen. Discussing, planning, preparing for, deciding to do, or beginning the action is NOT execution. The action must be done.`);
        rules.push(`   - "dropped": ONLY if the NPC has EXPLICITLY abandoned or cancelled the intention (said so, or clearly changed their mind). A changed situation, a delay, a new complication, or the trigger not arriving yet is NOT a drop — the intention waits.`);
        rules.push(`   - "open" (default): if there is ANY doubt whether the action is completed or the intention is truly abandoned, leave it open. Do not list it. It carries forward automatically.`);
        rules.push(`   - When in doubt between open and executed/dropped: choose open.`);
        rules.push(`${++n}. New intentions require BOTH a concrete "action" AND a specific "trigger" condition (the event or circumstance when the NPC will act). Vague triggers like "soon" or "when the time is right" are not acceptable — use concrete, verifiable conditions.`);
        rules.push(`${++n}. INTENTION HORIZON — for each new intention, classify when it will fire:`);
        rules.push(`   - "immediate": the trigger could be met any turn now (e.g. "next time Jonah leaves the house"). Use for event-conditional or situational triggers.`);
        rules.push(`   - "event": the trigger is tied to a specific upcoming event that is near (within a turn or two).`);
        rules.push(`   - "scheduled": the trigger is tied to a specific future date, festival, or scheduled occasion that is far off (many turns away). Requires a "wake_hint" — the event/date the scan should watch for (e.g. "harvest festival", "Day 12").`);
        rules.push(`   - When unsure or the horizon is unclear, use "immediate". Event-conditional triggers ("next time X") CANNOT be scheduled — you can't predict when they fire.`);
        rules.push(`${++n}. <already_scheduled> lists plans this NPC has ALREADY made. Do NOT propose a new intention that restates one of them, even in different words — a rephrasing of an existing plan is not a new plan. These have no ids on purpose: you cannot mark them executed or dropped. Treat them as settled and propose only genuinely NEW intentions.`);
        rules.push(`${++n}. SHARED PLANS are not intentions. A public, shared appointment ("we'll all go to the festival") is a calendar item — it belongs in world state, NOT the ledger. Only PRIVATE plans — an NPC's hidden intention to act — are intentions.`);
    }

    if (wantThoughts) {
        rules.push(`${++n}. "reaction" may be null if nothing noteworthy happened. Do not produce filler or boilerplate reactions.`);
    }

    rules.push(`${++n}. Wrong guesses are allowed. Invented facts are forbidden.`);

    if (wantThoughts) {
        rules.push(`${++n}. Keep thoughts concise (1-3 sentences) and in the NPC's own voice.`);
    }

    rules.push(`${++n}. NEVER produce a block for the player character (the human user). If a name is given in <player_character>, that person is the user, not an NPC — exclude them entirely, even if they are present in the scene.`);

    // ── Output contract ──
    const npcFields = [];
    npcFields.push('      "name": "Mara"');
    if (wantThoughts) {
        npcFields.push('      "reaction": { "re": "the witnessed event this turn", "thought": "..." }');
    }
    if (wantIntentions) {
        npcFields.push('      "executed": ["i-3f9a"]');
        npcFields.push('      "dropped": [{ "id": "i-77c2", "reason": "in-voice one-liner" }]');
        npcFields.push('      "new_intentions": [{ "action": "...", "trigger": "...", "horizon": "immediate|event|scheduled", "wake_hint": "required when scheduled" }]');
    }

    const notes = [];
    if (wantThoughts) notes.push('- "reaction" may be null.');
    if (wantIntentions) {
        notes.push('- "executed" and "dropped" may be empty arrays.');
        notes.push('- "new_intentions" may be an empty array.');
    }
    notes.push('- Only include NPCs from the provided roster.');

    return `\
${purposeLine}

${contextLine}

ABSOLUTE RULES:
${rules.join('\n')}

OUTPUT CONTRACT (JSON only):
{
  "npcs": [
    {
${npcFields.join(',\n')}
    }
  ]
}

Notes:
${notes.join('\n')}`;
}

/**
 * Build the user-content message for the interiority API call.
 *
 * @param {object} opts
 * @param {Array<object>} opts.npcBlocks - per-NPC assembled context blocks
 *   [{ name, knowledgeEntry, openIntentions, scheduledIntentions }]
 * @param {string} opts.recentMessages - stripped recent message window
 * @param {string} [opts.worldTime] - in-world time label from world state
 * @param {string} [opts.playerName] - the human user's persona name, so the
 *   model can exclude them (they are never an NPC)
 * @returns {string} assembled user content
 */
export function buildUserContent({ npcBlocks, recentMessages, worldTime, playerName, includeIntentions = true }) {
    const parts = [];

    if (playerName) {
        parts.push(`<player_character>${playerName}</player_character>`);
        parts.push('');
    }

    for (const npc of npcBlocks) {
        parts.push(`<npc name="${npc.name}">`);
        if (npc.knowledgeEntry) {
            parts.push(`<knowledge_entry>\n${npc.knowledgeEntry}\n</knowledge_entry>`);
        } else {
            parts.push(`<knowledge_entry>\n(No knowledge tracker entry for this NPC.)\n</knowledge_entry>`);
        }
        if (includeIntentions !== false) {
            if (npc.openIntentions && npc.openIntentions.length > 0) {
                const lines = npc.openIntentions.map(e =>
                    `- [${e.id}] ${e.action} → trigger: ${e.trigger} (since ${e.since || 'unknown'})`
                );
                parts.push(`<open_intentions>\n${lines.join('\n')}\n</open_intentions>`);
            } else {
                parts.push(`<open_intentions>\n(None.)\n</open_intentions>`);
            }
            // Scheduled intentions, deliberately WITHOUT ids: the model needs
            // to know these plans already exist so it stops re-proposing them,
            // but it must not be able to mark them executed or dropped — a
            // scheduled intention is evaluated when it wakes, not every turn.
            if (npc.scheduledIntentions && npc.scheduledIntentions.length > 0) {
                const lines = npc.scheduledIntentions.map(e =>
                    `- ${e.action} → trigger: ${e.trigger}${e.wakeHint ? ` (watching for: ${e.wakeHint})` : ''}`
                );
                parts.push(`<already_scheduled>\n${lines.join('\n')}\n</already_scheduled>`);
            }
        }
        parts.push('</npc>');
        parts.push('');
    }

    parts.push(`<recent_messages>`);
    parts.push(recentMessages);
    parts.push(`</recent_messages>`);
    parts.push('');
    parts.push('='.repeat(60));
    parts.push('Generate interiority for each NPC. Output only JSON per the contract.');

    return parts.join('\n');
}

// ─── v2 Thoughts-call prompt + user content (§17, §19) ───────────────────────

/**
 * Build the system prompt for the dedicated THOUGHTS call (split mode only).
 *
 * This is the craft prompt — it replaces the v1 one-liner thought section with
 * real voice guidance, a type taxonomy, and the input-partition rule (§15) that
 * binds facts to <knowledge_entry> and voice to <character_core>.
 *
 * Only used when splitThoughts is ON and this is the thoughts-side call. The
 * v1 unified call (splitThoughts off) is untouched — see buildSystemPrompt.
 *
 * House style: ABSOLUTE RULES, JSON only, no fences.
 *
 * @returns {string}
 */
export function buildThoughtsSystemPrompt() {
    const rules = [];
    let n = 0;

    rules.push(`${++n}. Output ONLY valid JSON. No markdown fences, no prose before or after.`);

    rules.push(`${++n}. INPUT PARTITION (load-bearing):`);
    rules.push(`   - Facts may come ONLY from <knowledge_entry> and events the NPC personally witnessed in <recent_messages>.`);
    rules.push(`   - Voice, tone, and disposition come ONLY from <character_core>.`);
    rules.push(`   - An NPC may NEVER reference, know, or allude to another NPC's thoughts, secrets, hidden intentions, or inner state. Each NPC's mind is sealed.`);

    rules.push(`${++n}. Each NPC gets at most ONE thought. "thought" may be null if nothing noteworthy is happening inside them (Omission Over Filler — silence beats a caption).`);

    rules.push(`${++n}. THOUGHT TYPES — choose the one that fits what is actually happening inside them:`);
    rules.push(`   - "reaction": a direct response to something they witnessed THIS turn. Requires "re" (the witnessed event).`);
    rules.push(`   - "rumination": turning something over — a worry, a grudge, a question with no immediate answer. No "re" needed.`);
    rules.push(`   - "memory": the past surfacing — something they are reminded of. No "re" needed.`);
    rules.push(`   - "anticipation": looking forward or dreading — a plan, a coming event, a reckoning. No "re" needed.`);

    rules.push(`${++n}. CRAFT — the thought must sound like THIS NPC, not a narrator:`);
    rules.push(`   - Free indirect style, first person, present tense ("Third night he can't look at me." — not "She thought that he couldn't look at her.").`);
    rules.push(`   - Concrete and specific — a sensory detail, a name, a bodily sensation. Never a summary.`);
    rules.push(`   - The thought must REVEAL something the narration does not — a hidden fear, a private calculation, an unspoken grudge. If the thought only restates what happened, omit it (null).`);
    rules.push(`   - Never summarize the scene or caption the action.`);
    rules.push(`   - BANNED OPENINGS (filler — the code drops these, so do not write them): "I wonder...", "I need to be careful...", "Something feels off...", "Only time will tell...".`);

    rules.push(`${++n}. INNER STATE — one line (max ~200 chars) capturing this NPC's current mood/disposition:`);
    rules.push(`   - If an <inner_state> block is provided: update it ONLY based on this turn's events. If nothing material changed, output the prior line VERBATIM (do not reword — rewording is drift).`);
    rules.push(`   - If no <inner_state> block is provided: produce a fresh one-line state from the current context.`);

    rules.push(`${++n}. WRONG GUESSES are allowed. INVENTED FACTS are forbidden. Never state a fact that is not in <knowledge_entry> or witnessed on-screen.`);

    rules.push(`${++n}. NEVER produce a block for the player character (named in <player_character>). They are the user, not an NPC.`);

    return `\
You are an interiority engine for a role-playing story. You write the private thoughts of NPCs (non-player characters) — the inner life the narration never shows.

You will receive, for each NPC:
- <character_core>: WHO they are — voice, disposition, personality. The authority for HOW they think and sound.
- <knowledge_entry>: WHAT they know — background, secrets, agenda, facts. The ONLY source of facts you may use.
- <relationships>: WHERE they stand — this NPC's outbound feelings toward others in the scene.
- <recent_thoughts>: their own last few thoughts — continue this inner life; let worries evolve and suspicions build.
- <inner_state>: their current one-line mood/state (when provided).
- <open_intentions>: their active plans (anticipation material).
- <recent_messages>: the shared story window — what they could personally witness.

ABSOLUTE RULES:
${rules.join('\n')}

OUTPUT CONTRACT (JSON only):
{
  "npcs": [
    {
      "name": "Mara",
      "thought": { "type": "rumination", "re": "optional — the witnessed event (required only for reaction)", "text": "Third night he can't look at me." },
      "inner_state": "wary of Jonah since the dinner; the guilt about the letter is getting louder"
    }
  ]
}

Notes:
- "thought" may be null (Omission Over Filler — prefer silence over a caption).
- "re" is required ONLY for type "reaction"; omit it for rumination/memory/anticipation.
- "inner_state" is always present (one line).
- Only include NPCs from the provided roster.`;
}

/**
 * Build the user-content message for the THOUGHTS call (split mode).
 *
 * Emits the richer per-NPC block set from §17: <character_core>,
 * <knowledge_entry>, <relationships>, <recent_thoughts>, <inner_state>,
 * <open_intentions>. Each block is omitted when empty so the prompt stays lean.
 *
 * @param {object} opts
 * @param {Array<object>} opts.npcBlocks - per-NPC assembled rich blocks:
 *   [{ name, characterCore, knowledgeEntry, relationships, recentThoughts,
 *      innerState, openIntentions }]
 * @param {string} opts.recentMessages - stripped recent message window
 * @param {string} [opts.worldTime]
 * @param {string} [opts.playerName]
 * @returns {string}
 */
export function buildThoughtsUserContent({ npcBlocks, recentMessages, worldTime, playerName }) {
    const parts = [];

    if (playerName) {
        parts.push(`<player_character>${playerName}</player_character>`);
        parts.push('');
    }
    if (worldTime) {
        parts.push(`<world_time>${worldTime}</world_time>`);
        parts.push('');
    }

    for (const npc of npcBlocks) {
        parts.push(`<npc name="${npc.name}">`);

        // <character_core> — who they are (profile or identity fields)
        if (npc.characterCore) {
            parts.push(`<character_core>\n${npc.characterCore}\n</character_core>`);
        }

        // <knowledge_entry> — what they know (remainder after identity split)
        if (npc.knowledgeEntry) {
            parts.push(`<knowledge_entry>\n${npc.knowledgeEntry}\n</knowledge_entry>`);
        } else {
            parts.push(`<knowledge_entry>\n(No knowledge tracker entry for this NPC.)\n</knowledge_entry>`);
        }

        // <relationships> — outbound edges filtered to roster (sealed minds)
        if (npc.relationships) {
            parts.push(`<relationships>\n${npc.relationships}\n</relationships>`);
        }

        // <recent_thoughts> — interior memory (continue, don't repeat)
        if (npc.recentThoughts) {
            parts.push(`<recent_thoughts>\n${npc.recentThoughts}\n</recent_thoughts>`);
        }

        // <inner_state> — prior mood line (when available)
        if (npc.innerState) {
            parts.push(`<inner_state>\n${npc.innerState}\n</inner_state>`);
        }

        // <open_intentions> — anticipation material
        if (npc.openIntentions && npc.openIntentions.length > 0) {
            const lines = npc.openIntentions.map(e =>
                `- ${e.action} → trigger: ${e.trigger} (since ${e.since || 'unknown'})`
            );
            parts.push(`<open_intentions>\n${lines.join('\n')}\n</open_intentions>`);
        }

        parts.push('</npc>');
        parts.push('');
    }

    parts.push(`<recent_messages>`);
    parts.push(recentMessages);
    parts.push(`</recent_messages>`);
    parts.push('');
    parts.push('='.repeat(60));
    parts.push('Write each NPC\'s thought and inner_state. Output only JSON per the contract.');

    return parts.join('\n');
}

/**
 * Build the injection header for the narrator-facing intentions block.
 * This is the bracket header that goes inside the <mwt_npc_intentions> tag.
 */
export const INJECTION_HEADER = `[NPC intentions ledger — live, hidden NPC plans. For every entry whose trigger condition is met in the current scene, that NPC MUST perform the action on-screen in this response, fully committed. Do not narrate these entries, reference them, or let other characters know them — they surface ONLY as the owning NPC's actions. If an entry describes something that has already occurred in the story, treat it as stale bookkeeping — ignore it silently; never mention, re-perform, or correct it.]`;

/**
 * Format the ledger into the flat arrow-notation lines for injection.
 *
 * Dormant entries (§20) are filtered out — the narrator never spends
 * attention on a trigger that cannot be met yet.
 *
 * Example output:
 *   - Mara → search the study drawer → next time Jonah leaves the house (since Tue evening)
 *   - Tomas → move the ledger → tonight (since Wed noon)
 *
 * @param {Array<object>} ledger
 * @returns {string}
 */
export function formatLedgerForInjection(ledger) {
    if (!ledger || !ledger.length) return '';
    // §20: dormant entries excluded from narrator injection
    const active = ledger.filter(e => e.status !== 'dormant');
    if (active.length === 0) return '';
    const lines = active.map(e => {
        const since = e.since ? ` (since ${e.since})` : '';
        return `- ${e.npc} → ${e.action} → ${e.trigger}${since}`;
    });
    return lines.join('\n');
}

// ─── Dormant poll prompt (v2 §20) ────────────────────────────────────────────

/**
 * Build the system prompt for the dormant-intentions lazy poll.
 *
 * Fires every {@link DORMANT_POLL_INTERVAL} turns when there are dormant
 * entries. A cheap, focused question: is the trigger near? The poll wakes
 * entries early — when the event is "tomorrow," not when it starts — so the
 * NPC gets a turn or two of anticipatory behavior and the narrator receives
 * the demand while it's relevant.
 *
 * @returns {string}
 */
export function buildDormantPollSystemPrompt() {
    return `\
You are a scheduling assistant for a role-playing story. You decide whether scheduled (dormant) NPC intentions should wake — i.e., whether their trigger condition is near enough that the intention should become active.

For each dormant intention, you receive:
- The NPC's action and trigger.
- The wake_hint (the event/date to watch for).
- The current in-world time (when available).
- A window of recent story messages.

DECIDE for each intention:
- "wake": the trigger's time is near (within a turn or two) or the event has started appearing in the story.
- "sleep": the trigger is still far off or has not surfaced yet.

ABSOLUTE RULES:
1. Output ONLY valid JSON. No markdown fences, no prose before or after.
2. Wake EARLY — when the event is "tomorrow," not when it starts.
3. When unsure, choose "sleep" (false alarms are cheap; a missed wake is not).
4. Never invent events. If the wake_hint hasn't surfaced in time or messages, keep sleeping.

OUTPUT CONTRACT (JSON only):
{
  "intentions": [
    { "id": "i-3f9a", "wake": false }
  ]
}`;
}

/**
 * Build the user-content message for the dormant poll.
 *
 * @param {Array<object>} dormantEntries - ledger entries with status 'dormant'
 * @param {string} recentMessages - stripped recent message window
 * @param {string} [worldTime] - current in-world time
 * @returns {string}
 */
export function buildDormantPollUserContent({ dormantEntries, recentMessages, worldTime }) {
    const parts = [];

    if (worldTime) {
        parts.push(`<world_time>${worldTime}</world_time>`);
        parts.push('');
    }

    const lines = dormantEntries.map(e => {
        const lineParts = [`- [${e.id}] ${e.npc} → ${e.action} → trigger: ${e.trigger}`];
        if (e.wakeHint) lineParts.push(`  wake_hint: ${e.wakeHint}`);
        if (e.since) lineParts.push(`  since: ${e.since}`);
        return lineParts.join('\n');
    });
    parts.push(`<dormant_intentions>`);
    parts.push(lines.join('\n'));
    parts.push(`</dormant_intentions>`);
    parts.push('');

    parts.push(`<recent_messages>`);
    parts.push(recentMessages);
    parts.push(`</recent_messages>`);
    parts.push('');
    parts.push('='.repeat(60));
    parts.push('For each dormant intention, decide wake or sleep. Output only JSON per the contract.');

    return parts.join('\n');
}
