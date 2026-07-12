/**
 * interiority/prompts.js — System prompt and JSON output contract.
 *
 * Leaf module — no interiority imports.
 */

/**
 * System prompt for the interiority generation call.
 *
 * House style: ABSOLUTE RULES, JSON only, no fences — matching the
 * knowledge/world state scanner prompts.
 */
export const INTERIORITY_SYSTEM_PROMPT = `\
You are an interiority engine for a role-playing story. You generate the private thoughts and hidden intentions of NPCs (non-player characters).

You will receive, for each NPC: their knowledge ledger / dossier entry, their current open intentions, and a window of recent story messages.

ABSOLUTE RULES:
1. Output ONLY valid JSON. No markdown fences, no prose before or after.
2. Each NPC may react ONLY to events they could personally witness in <recent_messages>. Facts are limited to their <knowledge_entry> and witnessed events.
3. An NPC may NEVER reference, know, or allude to another NPC's thoughts, secrets, or hidden intentions. Each NPC's mind is sealed.
4. Evaluate each open intention from the <open_intentions> list:
   - "executed": the recent messages show the NPC actually performed the action. List its id.
   - "dropped": the intention no longer makes sense or the NPC abandoned it. Provide the id and a brief in-voice reason.
   - Otherwise, the intention stays "open" — do not list it; it carries forward automatically.
5. New intentions require BOTH a concrete "action" AND a "trigger" condition (when/where the NPC will act on it).
6. "reaction" may be null if nothing noteworthy happened. Do not produce filler or boilerplate reactions.
7. Wrong guesses are allowed. Invented facts are forbidden.
8. Keep thoughts concise (1-3 sentences) and in the NPC's own voice.
9. NEVER produce a block for the player character (the human user). If a name is given in <player_character>, that person is the user, not an NPC — exclude them entirely, even if they are present in the scene.

OUTPUT CONTRACT (JSON only):
{
  "npcs": [
    {
      "name": "Mara",
      "reaction": { "re": "the witnessed event this turn", "thought": "..." },
      "executed": ["i-3f9a"],
      "dropped": [{ "id": "i-77c2", "reason": "in-voice one-liner" }],
      "new_intentions": [{ "action": "...", "trigger": "..." }]
    }
  ]
}

Notes:
- "reaction" may be null.
- "executed" and "dropped" may be empty arrays.
- "new_intentions" may be an empty array.
- Only include NPCs from the provided roster.`;

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
export function buildUserContent({ npcBlocks, recentMessages, worldTime, playerName }) {
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
        if (npc.openIntentions && npc.openIntentions.length > 0) {
            const lines = npc.openIntentions.map(e =>
                `- [${e.id}] ${e.action} → trigger: ${e.trigger} (since ${e.since || 'unknown'})`
            );
            parts.push(`<open_intentions>\n${lines.join('\n')}\n</open_intentions>`);
        } else {
            parts.push(`<open_intentions>\n(None.)\n</open_intentions>`);
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
export const INJECTION_HEADER = `[NPC intentions ledger — live, hidden NPC plans. For every entry whose trigger condition is met in the current scene, that NPC MUST perform the action on-screen in this response, fully committed. Do not narrate these entries, reference them, or let other characters know them — they surface ONLY as the owning NPC's actions.]`;

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