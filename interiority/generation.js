/**
 * interiority/generation.js — Context assembly, API call, roster building,
 * validation, and ledger mutation.
 *
 * Implements the "runScan" pattern from world_state/knowledge modules:
 *   resolveApiCall → fetchFn → normaliseOutput → parseJsonLenient → validate
 *
 * Strict mode is a loop around the same builder.
 */

import {
    getChatMeta, getContextSafe, getRecentMessages, getUserNames,
    resolveApiCall, normaliseOutput, parseJsonLenient,
    getCurrentWorldState, escapeRegex,
} from '../core/index.js';

import { REGISTRY_KEY } from '../knowledge/state.js';

import { INTERIORITY_SYSTEM_PROMPT, buildUserContent } from './prompts.js';
import {
    getSettings, hasValidSettings,
    getInteriorityData, saveInteriorityData,
    getLedger, addLedgerEntry, removeLedgerEntries, hasDuplicateIntention,
    setPerMessage, getLedgerEntriesForNpc,
    MAX_THOUGHT_LENGTH,
} from './data.js';

// ─── Scene roster (§6) ────────────────────────────────────────────────────────

/**
 * Build the NPC roster for this turn.
 *
 * NPCs with live ledger entries are added first and are EXEMPT from the
 * `maxNpcs` cap — their intentions must be evaluated (executed/dropped)
 * every turn, or they linger in the injection forever demanding actions
 * from NPCs the generator never processes.
 *
 * Scene NPCs then fill up to `maxNpcs` slots, resolved via priority chain:
 *   1. Parse `Present:` from the current world state document.
 *   2. Fallback: Knowledge Tracker registry names in recent messages.
 *   3. Fallback: `{{char}}` name only.
 *
 * Player names are always excluded. Only {{user}} (name1) is excluded —
 * {{char}} (name2) and group-chat members are valid NPC targets.
 *
 * @returns {string[]} NPC names
 */
export function buildSceneRoster() {
    const settings = getSettings();
    const maxNpcs = Math.max(1, settings.maxNpcs || 4);
    // Only exclude the human user. {{char}} and other AI characters are valid
    // NPC targets for interiority generation.
    const userNames = getUserNames({ lower: true });
    const exclude = (name) => !name || userNames.has(name.toLowerCase().trim());

    const roster = [];
    const addUnique = (name) => {
        const n = String(name || '').trim();
        if (exclude(n)) return;
        if (!roster.some(r => r.toLowerCase() === n.toLowerCase())) roster.push(n);
    };

    // Ledger NPCs first — always included, never capped.
    for (const entry of getLedger()) addUnique(entry.npc);
    const ledgerCount = roster.length;

    // 1. Parse `Present:` from world state. The world-state template emits
    //    comma-separated names — do not split on hyphens ("Jean-Luc") or
    //    other characters that can appear inside a single name.
    let sceneNames = [];
    const worldState = getCurrentWorldState();
    if (worldState) {
        const presentMatch = worldState.match(/^Present:\s*(.+)$/im);
        if (presentMatch) {
            sceneNames = presentMatch[1]
                .split(/[,;]|\band\b/i)
                .map(s => s.trim())
                .filter(Boolean);
        }
    }

    // 2. Fallback: Knowledge Tracker registry names in recent messages
    if (sceneNames.length === 0) {
        try {
            const registry = getChatMeta(REGISTRY_KEY);
            if (registry && Object.keys(registry).length > 0) {
                const recent = getRecentMessages({ maxMessages: 10, maxChars: 50000 });
                if (recent) {
                    for (const name of Object.keys(registry)) {
                        if (exclude(name)) continue;
                        const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i');
                        if (re.test(recent)) sceneNames.push(name);
                    }
                }
            }
        } catch { /* knowledge module data unavailable */ }
    }

    // 3. Fallback: {{char}} name only
    if (sceneNames.length === 0) {
        const ctx = getContextSafe();
        if (ctx?.name2) sceneNames.push(ctx.name2);
    }

    // Scene NPCs fill the capped slots (cap counts scene additions only).
    for (const n of sceneNames) {
        if (roster.length - ledgerCount >= maxNpcs) break;
        addUnique(n);
    }

    return roster;
}

// ─── Context assembly (§7) ───────────────────────────────────────────────────

/**
 * Load the knowledge entry for an NPC from the Knowledge Tracker registry.
 * Uses dynamic import to avoid a hard dependency on the knowledge module.
 *
 * @param {string} npcName
 * @returns {Promise<string|null>} stripped knowledge entry content, or null
 */
async function loadNpcKnowledge(npcName) {
    try {
        const { getRegistry } = await import('../knowledge/registry.js');
        const { loadEntryContent } = await import('../knowledge/lorebook.js');
        const { stripRelationshipBlock } = await import('../knowledge/relationships.js');
        const reg = getRegistry();
        const info = reg?.[npcName];
        if (!info || info.uid == null) return null;
        const content = await loadEntryContent(info.uid);
        if (!content) return null;
        return stripRelationshipBlock(content);
    } catch {
        return null;
    }
}

/**
 * Assemble the per-NPC context blocks for the API call.
 *
 * @param {string[]} roster
 * @returns {Promise<Array<{name, knowledgeEntry, openIntentions}>>}
 */
export async function assembleNpcBlocks(roster) {
    const blocks = [];
    for (const name of roster) {
        const knowledgeEntry = await loadNpcKnowledge(name);
        const openIntentions = getLedgerEntriesForNpc(name);
        blocks.push({ name, knowledgeEntry, openIntentions });
    }
    return blocks;
}

/**
 * Extract the in-world time label from the world state document.
 * Looks for a `Time:` header.
 * @returns {string}
 */
function getWorldTime() {
    const ws = getCurrentWorldState();
    if (!ws) return '';
    const m = ws.match(/^Time:\s*(.+)$/im);
    return m ? m[1].trim() : '';
}

// ─── API call ────────────────────────────────────────────────────────────────

/**
 * Make a single batched interiority API call for all roster NPCs.
 *
 * @param {string[]} roster
 * @returns {Promise<object|null>} parsed JSON result, or null on failure
 */
export async function runBatchedCall(roster) {
    if (!hasValidSettings()) {
        console.warn('[MWT:Interiority] No API connection configured.');
        return null;
    }

    const settings = getSettings();
    const npcBlocks = await assembleNpcBlocks(roster);
    const windowSize = Math.max(1, settings.messageWindow || 8);

    // Get stripped recent messages
    const recentMessages = getStrippedRecentMessages(windowSize);
    if (!recentMessages) {
        console.warn('[MWT:Interiority] No recent messages to process.');
        return null;
    }

    const worldTime = getWorldTime();
    const playerName = [...getUserNames({ lower: false })][0] || '';
    const userContent = buildUserContent({
        npcBlocks,
        recentMessages,
        worldTime,
        playerName,
    });

    return fetchAndParse(INTERIORITY_SYSTEM_PROMPT, userContent, settings);
}

/**
 * Run one API call per NPC (strict mode).
 * Returns the merged result as if it were a single batched response.
 *
 * @param {string[]} roster
 * @returns {Promise<object|null>}
 */
export async function runStrictCalls(roster) {
    if (!hasValidSettings()) {
        console.warn('[MWT:Interiority] No API connection configured.');
        return null;
    }

    const settings = getSettings();
    const windowSize = Math.max(1, settings.messageWindow || 8);
    const recentMessages = getStrippedRecentMessages(windowSize);
    if (!recentMessages) {
        console.warn('[MWT:Interiority] No recent messages to process.');
        return null;
    }

    const worldTime = getWorldTime();
    const playerName = [...getUserNames({ lower: false })][0] || '';
    const allNpcs = [];

    for (const name of roster) {
        const npcBlocks = await assembleNpcBlocks([name]);
        const userContent = buildUserContent({
            npcBlocks,
            recentMessages,
            worldTime,
            playerName,
        });

        const result = await fetchAndParse(INTERIORITY_SYSTEM_PROMPT, userContent, settings);
        if (result && Array.isArray(result.npcs)) {
            allNpcs.push(...result.npcs);
        }
    }

    return { npcs: allNpcs };
}

// ─── Core fetch + parse with retry-once ──────────────────────────────────────

/**
 * Fetch from the API, normalise, parse JSON, and return the result.
 * Retries once on parse failure (the "runScan" pattern).
 *
 * @param {string} systemPrompt
 * @param {string} userContent
 * @param {object} settings
 * @returns {Promise<object|null>}
 */
async function fetchAndParse(systemPrompt, userContent, settings) {
    const resolved = resolveApiCall({ moduleSettings: settings });

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const raw = await resolved.fetchFn({
                systemPrompt,
                userContent,
                settings: resolved.settings,
                retries: 1,
            });
            const cleaned = normaliseOutput(raw);
            const result = parseJsonLenient(cleaned);
            return result;
        } catch (err) {
            console.warn(`[MWT:Interiority] API/parse attempt ${attempt} failed: ${err.message}`);
            if (attempt >= 2) {
                console.error('[MWT:Interiority] Giving up after 2 attempts.');
                return null;
            }
        }
    }
    return null;
}

// ─── Validation (§8) ─────────────────────────────────────────────────────────

/**
 * Validate and apply the interiority result to the ledger and per-message store.
 *
 * All validation is code-side, not prompt-side:
 *   - name must be in roster
 *   - executed/dropped ids must exist in ledger
 *   - new_intentions require both action + trigger
 *   - length caps on thoughts
 *   - dedup new intentions against open ones
 *   - max 1 reaction per NPC per turn
 *
 * @param {object} result - parsed JSON from the API
 * @param {string[]} roster - the NPC roster for this turn
 * @param {number} msgIdx - message index for this turn
 * @returns {object} { reactions: [], ledgerChanged: boolean }
 */
export function validateAndApply(result, roster, msgIdx) {
    const data = getInteriorityData();
    const settings = getSettings();

    // Take a snapshot of the ledger BEFORE mutations (for rollback)
    const ledgerSnapshot = JSON.parse(JSON.stringify(data.ledger));

    // Normalize roster for case-insensitive matching
    const rosterLower = new Set(roster.map(n => n.toLowerCase().trim()));

    // Defense-in-depth: also reject {{user}} even if it somehow made it into
    // the roster (e.g. stale ledger entry from before the getUserNames fix).
    const userNamesLower = getUserNames({ lower: true });

    // Build a map of ledger entry ids for quick lookup
    const ledgerIds = new Set(data.ledger.map(e => e.id));

    const reactions = [];
    const worldTime = getWorldTime();
    let ledgerChanged = false;

    if (!result || !Array.isArray(result.npcs)) {
        // Store empty reactions but still snapshot
        setPerMessage(msgIdx, {
            reactions: [],
            ledgerSnapshot,
            generatedAt: Date.now(),
        });
        return { reactions: [], ledgerChanged: false };
    }

    const seenNpcs = new Set();
    for (const npcResult of result.npcs) {
        const name = String(npcResult.name || '').trim();
        if (!name || !rosterLower.has(name.toLowerCase())) {
            // Unknown name — discard
            continue;
        }
        if (userNamesLower.has(name.toLowerCase())) {
            // {{user}} must never get thoughts or ledger entries — discard
            continue;
        }
        if (seenNpcs.has(name.toLowerCase())) {
            // Model emitted the same NPC twice — first block wins
            continue;
        }
        seenNpcs.add(name.toLowerCase());

        // ── Reaction (display-only, max 1 per NPC per turn) ──
        if (npcResult.reaction && typeof npcResult.reaction === 'object') {
            const re = String(npcResult.reaction.re || '').trim();
            const thought = String(npcResult.reaction.thought || '').trim();

            // Drop empty/boilerplate reactions (Omission Over Filler)
            if (re && thought && !isBoilerplate(thought)) {
                reactions.push({
                    npc: name,
                    re: re.slice(0, 300),
                    thought: thought.slice(0, MAX_THOUGHT_LENGTH),
                });
            }
        }

        // ── Executed intentions ──
        if (Array.isArray(npcResult.executed)) {
            const validIds = npcResult.executed.filter(id => ledgerIds.has(id));
            if (validIds.length > 0) {
                removeLedgerEntries(validIds);
                validIds.forEach(id => ledgerIds.delete(id));
                ledgerChanged = true;
                console.log(`[MWT:Interiority] ${name}: executed ${validIds.length} intention(s).`);
            }
        }

        // ── Dropped intentions ──
        if (Array.isArray(npcResult.dropped)) {
            const validIds = [];
            for (const drop of npcResult.dropped) {
                if (drop && drop.id && ledgerIds.has(drop.id)) {
                    validIds.push(drop.id);
                    ledgerIds.delete(drop.id);
                    console.log(`[MWT:Interiority] ${name}: dropped intention ${drop.id} (${String(drop.reason || '').slice(0, 80)}).`);
                }
            }
            if (validIds.length > 0) {
                removeLedgerEntries(validIds);
                ledgerChanged = true;
            }
        }

        // ── New intentions ──
        if (Array.isArray(npcResult.new_intentions)) {
            for (const ni of npcResult.new_intentions) {
                if (!ni) continue;
                const action = String(ni.action || '').trim();
                const trigger = String(ni.trigger || '').trim();
                if (!action || !trigger) continue;

                // Dedup: never declare the same intention twice
                if (hasDuplicateIntention(name, action, trigger)) {
                    continue;
                }

                addLedgerEntry({ npc: name, action, trigger }, worldTime, msgIdx);
                ledgerChanged = true;
            }
        }
    }

    // Store per-message reactions + ledger snapshot
    setPerMessage(msgIdx, {
        reactions,
        ledgerSnapshot,
        generatedAt: Date.now(),
    });

    return { reactions, ledgerChanged };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if a thought is boilerplate/filler that should be dropped.
 */
function isBoilerplate(thought) {
    const lower = thought.toLowerCase().trim();
    if (lower.length < 10) return true;
    const fillers = [
        'i wonder what will happen',
        'i should keep an eye',
        'something feels off',
        'only time will tell',
    ];
    return fillers.some(f => lower.includes(f));
}

/**
 * Get recent messages, stripped of non-narrative blocks.
 *
 * Stripping must happen per-message BEFORE the window is joined —
 * `<details>` tracker blocks span many lines, so line-by-line stripping
 * of the joined text never matches them. core/context.js handles this
 * via the `strip` option.
 *
 * @param {number} windowSize
 * @returns {string}
 */
function getStrippedRecentMessages(windowSize) {
    return getRecentMessages({
        maxMessages: windowSize,
        maxChars: 100000,
        filterSystem: true,
        strip: true,
    }) || '';
}
