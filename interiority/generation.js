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

import { buildSystemPrompt, buildUserContent } from './prompts.js';
import {
    getSettings, hasValidSettings,
    getInteriorityData,
    getLedger, addLedgerEntry, removeLedgerEntries, hasDuplicateIntention,
    setPerMessage, getLedgerEntriesForNpc,
    getOrCreateMsgKeyForIndex,
    MAX_THOUGHT_LENGTH, getWorldTime, incrementLedgerAges,
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
    const wantThoughts = settings.generateThoughts !== false;
    const wantIntentions = settings.generateIntentions !== false;
    if (!wantThoughts && !wantIntentions) {
        console.warn('[MWT:Interiority] Both thoughts and intentions are disabled — skipping API call.');
        return null;
    }

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
    const systemPrompt = buildSystemPrompt({ thoughts: wantThoughts, intentions: wantIntentions });
    const userContent = buildUserContent({
        npcBlocks,
        recentMessages,
        worldTime,
        playerName,
        includeIntentions: wantIntentions,
    });

    return fetchAndParse(systemPrompt, userContent, settings);
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
    const wantThoughts = settings.generateThoughts !== false;
    const wantIntentions = settings.generateIntentions !== false;
    if (!wantThoughts && !wantIntentions) {
        console.warn('[MWT:Interiority] Both thoughts and intentions are disabled — skipping API call.');
        return null;
    }

    const windowSize = Math.max(1, settings.messageWindow || 8);
    const recentMessages = getStrippedRecentMessages(windowSize);
    if (!recentMessages) {
        console.warn('[MWT:Interiority] No recent messages to process.');
        return null;
    }

    const worldTime = getWorldTime();
    const playerName = [...getUserNames({ lower: false })][0] || '';
    const allNpcs = [];
    const systemPrompt = buildSystemPrompt({ thoughts: wantThoughts, intentions: wantIntentions });

    for (const name of roster) {
        const npcBlocks = await assembleNpcBlocks([name]);
        const userContent = buildUserContent({
            npcBlocks,
            recentMessages,
            worldTime,
            playerName,
            includeIntentions: wantIntentions,
        });

        const result = await fetchAndParse(systemPrompt, userContent, settings);
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
        let cleaned = '';
        try {
            const raw = await resolved.fetchFn({
                systemPrompt,
                userContent,
                settings: resolved.settings,
                retries: 1,
            });
            cleaned = normaliseOutput(raw);
            const result = parseJsonLenient(cleaned);
            return result;
        } catch (err) {
            console.warn(`[MWT:Interiority] API/parse attempt ${attempt} failed: ${err.message}`);
            if (cleaned) {
                console.warn(`[MWT:Interiority] Normalised output that failed to parse (first 800 chars):\n${cleaned.slice(0, 800)}`);
            }
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
 * @param {number} msgIdx - chat-array index of the message (for ledger
 *   entries' declaredMsgIdx metadata)
 * @returns {object} { reactions: [], ledgerChanged: boolean }
 */
export function validateAndApply(result, roster, msgIdx) {
    const data = getInteriorityData();
    const settings = getSettings();
    const wantThoughts = settings.generateThoughts !== false;
    const wantIntentions = settings.generateIntentions !== false;

    // Resolve the stable perMessage key for this message. We use the
    // create-or-get variant because this is a STORE path: stamping a UUID
    // here ensures all future reads (which use the read-only getMsgKeyForIndex)
    // resolve to the same key. perMessage is keyed by UUID (not chat index)
    // so thoughts survive chat-array shifts caused by summarisation tools
    // like Inline Summary.
    const msgKey = getOrCreateMsgKeyForIndex(msgIdx);

    // Take a snapshot of the ledger BEFORE mutations (for rollback)
    const ledgerSnapshot = JSON.parse(JSON.stringify(data.ledger));

    // Increment the age of every open intention. This is the first step
    // of the grace-period mechanism: intentions that haven't survived
    // enough turns since being declared are protected from premature
    // execution/dropping (see gracePeriod below).
    incrementLedgerAges();

    // Normalize roster for case-insensitive matching
    const rosterLower = new Set(roster.map(n => n.toLowerCase().trim()));

    // Defense-in-depth: also reject {{user}} even if it somehow made it into
    // the roster (e.g. stale ledger entry from before the getUserNames fix).
    const userNamesLower = getUserNames({ lower: true });

    // Build a map of ledger entry ids for quick lookup
    const ledgerIds = new Set(data.ledger.map(e => e.id));

    // Build a lookup from id → turnsOpen for grace-period enforcement.
    // The model frequently declares and executes/drops an intention in the
    // same turn — or one turn later — before the trigger has had a chance
    // to arrive. The grace period forces intentions to survive at least
    // N turns before they can be removed.
    const ledgerAgeMap = new Map(data.ledger.map(e => [e.id, e.turnsOpen || 0]));
    const gracePeriod = Math.max(0, settings.intentionGracePeriod || 0);

    // ── Grace-period design note ────────────────────────────────────────
    // The grace period trades "premature erasure" for "stale demands": if a
    // trigger fires the very next turn and the narrator performs the action
    // (because the injection demands it), the executed-mark is rejected as
    // in-grace, the entry stays open, and the injection keeps demanding an
    // action that already happened. The INJECTION_HEADER "stale bookkeeping
    // — ignore silently" line is the prompt-side mitigation (statistical).
    //
    // This is an acceptable trade at the default grace=2. Resist raising it.
    // If it ever misbehaves, the code-side alternative is: allow executed
    // during grace ONLY when the entry was declared before the current
    // message (age ≥ 1), rather than a blanket window.
    // ────────────────────────────────────────────────────────────────────

    const reactions = [];
    const worldTime = getWorldTime();
    let ledgerChanged = false;

    if (!result || !Array.isArray(result.npcs)) {
        console.warn(`[MWT:Interiority] Result has no "npcs" array — parsed keys: [${result ? Object.keys(result).join(', ') : 'null'}]. Nothing applied.`);
        // Store empty reactions but still snapshot
        if (msgKey) {
            setPerMessage(msgKey, {
                reactions: [],
                ledgerSnapshot,
                generatedAt: Date.now(),
            });
        }
        return { reactions: [], ledgerChanged: false };
    }

    const seenNpcs = new Set();
    for (const npcResult of result.npcs) {
        const name = String(npcResult.name || '').trim();
        if (!name || !rosterLower.has(name.toLowerCase())) {
            // Unknown name — discard
            console.warn(`[MWT:Interiority] Discarding NPC block "${name}" — not in roster [${roster.join(', ')}].`);
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
        // Skipped entirely when the thoughts feature is disabled.
        if (wantThoughts && npcResult.reaction && typeof npcResult.reaction === 'object') {
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

        // The executed/dropped/new_intentions blocks mutate the ledger, so
        // they are skipped entirely when the intentions feature is disabled.
        if (!wantIntentions) continue;

        // ── Executed intentions ──
        // Grace period: intentions that haven't survived enough turns are
        // protected from premature removal. The model often sees an NPC
        // talking about or preparing for an action and marks it executed
        // before the action is actually completed on-screen.
        if (Array.isArray(npcResult.executed)) {
            const validIds = npcResult.executed.filter(id => {
                if (!ledgerIds.has(id)) return false;
                const age = ledgerAgeMap.get(id) || 0;
                if (age < gracePeriod) {
                    console.log(`[MWT:Interiority] ${name}: intention ${id} executed but still in grace period (age ${age} < ${gracePeriod}) — kept open.`);
                    return false;
                }
                return true;
            });
            if (validIds.length > 0) {
                removeLedgerEntries(validIds);
                validIds.forEach(id => ledgerIds.delete(id));
                ledgerChanged = true;
                console.log(`[MWT:Interiority] ${name}: executed ${validIds.length} intention(s).`);
            }
        }

        // ── Dropped intentions ──
        // Same grace period applies — models drop intentions too eagerly
        // when a minor situation change occurs, before the trigger has
        // had a chance to arrive.
        if (Array.isArray(npcResult.dropped)) {
            const validIds = [];
            for (const drop of npcResult.dropped) {
                if (drop && drop.id && ledgerIds.has(drop.id)) {
                    const age = ledgerAgeMap.get(drop.id) || 0;
                    if (age < gracePeriod) {
                        console.log(`[MWT:Interiority] ${name}: intention ${drop.id} dropped but still in grace period (age ${age} < ${gracePeriod}) — kept open.`);
                        continue;
                    }
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
                if (!action || !trigger) {
                    console.warn(`[MWT:Interiority] ${name}: discarding new intention missing action/trigger — got keys: [${Object.keys(ni).join(', ')}].`);
                    continue;
                }

                // Dedup: never declare the same intention twice
                if (hasDuplicateIntention(name, action, trigger)) {
                    console.log(`[MWT:Interiority] ${name}: skipping duplicate intention "${action.slice(0, 60)}".`);
                    continue;
                }

                addLedgerEntry({ npc: name, action, trigger }, worldTime, msgIdx);
                ledgerChanged = true;
            }
        }
    }

    // Store per-message reactions + ledger snapshot (keyed by stable msgKey)
    if (msgKey) {
        setPerMessage(msgKey, {
            reactions,
            ledgerSnapshot,
            generatedAt: Date.now(),
        });
    }

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
