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
        ? 'You will receive, for each NPC: their knowledge ledger / dossier entry, their current open intentions, and a window of recent story messages.'
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
        npcFields.push('      "new_intentions": [{ "action": "...", "trigger": "..." }]');
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
 *   [{ name, knowledgeEntry, openIntentions }]
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

/**
 * Build the injection header for the narrator-facing intentions block.
 * This is the bracket header that goes inside the <mwt_npc_intentions> tag.
 */
export const INJECTION_HEADER = `[NPC intentions ledger — live, hidden NPC plans. For every entry whose trigger condition is met in the current scene, that NPC MUST perform the action on-screen in this response, fully committed. Do not narrate these entries, reference them, or let other characters know them — they surface ONLY as the owning NPC's actions. If an entry describes something that has already occurred in the story, treat it as stale bookkeeping — ignore it silently; never mention, re-perform, or correct it.]`;

/**
 * Format the ledger into the flat arrow-notation lines for injection.
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
    const lines = ledger.map(e => {
        const since = e.since ? ` (since ${e.since})` : '';
        return `- ${e.npc} → ${e.action} → ${e.trigger}${since}`;
    });
    return lines.join('\n');
}