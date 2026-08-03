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
    assertSameScope,
} from '../core/index.js';

import { REGISTRY_KEY } from '../knowledge/state.js';

import {
    buildSystemPrompt, buildUserContent,
    buildThoughtsSystemPrompt, buildThoughtsUserContent,
    buildDormantPollSystemPrompt, buildDormantPollUserContent,
} from './prompts.js';
import {
    getSettings, hasValidSettings,
    getInteriorityData,
    addLedgerEntry, removeLedgerEntries, hasDuplicateIntention,
    setPerMessage, getLedgerEntriesForNpc,
    getOrCreateMsgKeyForIndex,
    getRecentThoughtsForNpc,
    getInnerState, setInnerStateGuarded, getInnerStatesSnapshot,
    getActiveLedger, getDormantLedger, wakeLedgerEntry,
    getTurnCounter,
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
 * @returns {Promise<string[]>} NPC names
 */
/**
 * Load the knowledge registry's name canonicalizer, or a pass-through when the
 * knowledge module is unavailable.
 *
 * Roster names from `Present:` and from the model use different name forms
 * ("Mara" vs "Mara Vance"). Canonicalizing to the registry key at roster-build
 * time prevents forking the NPC's inner-state, recent-thoughts, and ledger
 * stores — each form would otherwise get its own independent line.
 *
 * @returns {Promise<(name: string) => string>}
 */
async function _getCanonicalizer() {
    let reg = null;
    let resolveKey = null;
    try {
        const knowledgeRegistry = await import('../knowledge/registry.js');
        reg = knowledgeRegistry.getRegistry();
        resolveKey = knowledgeRegistry.resolveRegistryKey;
    } catch { /* knowledge module unavailable — names stay as-is */ }

    return (name) => {
        const n = String(name || '').trim();
        if (!n || !reg || !resolveKey) return n;
        const key = resolveKey(reg, n);
        return key || n; // fall back to raw name when no registry entry
    };
}

/**
 * Every name form that refers to the human user, lower-cased.
 *
 * {{user}} alone is not enough. The roster canonicalizes each candidate through
 * the knowledge registry BEFORE testing it, and the registry is keyed on
 * whatever the knowledge tracker first recorded — often a fuller name. With
 * {{user}} = "Alex" and a registry entry "Alex Blackwell", `canonicalize("Alex")`
 * returned "Alex Blackwell", which matched nothing in the exclusion set, and
 * the player character walked onto the roster under their own canonical name.
 * From there they got intentions, and the injection started demanding the
 * narrator act for the player — which is exactly the hijack this filter exists
 * to prevent.
 *
 * Widening it through the SAME resolver the roster uses keeps the match
 * precise: it is not first-name guessing, it is "whatever entry the registry
 * says this person is". `resolveRegistryKey` already refuses ambiguous
 * given-name matches, so a different NPC who happens to share the user's given
 * name resolves to null and is left alone.
 *
 * @returns {Promise<Set<string>>} lower-cased user name forms
 */
export async function resolveUserNames() {
    const names = getUserNames({ lower: true });
    const canonicalize = await _getCanonicalizer();
    for (const n of [...names]) {
        const canon = canonicalize(n);
        if (canon) names.add(canon.toLowerCase().trim());
    }
    return names;
}

export async function buildSceneRoster() {
    const settings = getSettings();
    const maxNpcs = Math.max(1, settings.maxNpcs || 4);
    // Only exclude the human user. {{char}} and other AI characters are valid
    // NPC targets for interiority generation.
    const userNames = await resolveUserNames();
    const canonicalize = await _getCanonicalizer();

    // Test BOTH forms. Canonicalization can map a name INTO the user's registry
    // identity ("Alex" → "Alex Blackwell") or the scene can name the user in a
    // form the persona field never used; testing only one of them lets the
    // other through.
    const excluded = [];
    const exclude = (raw, canon) => {
        const a = String(raw || '').toLowerCase().trim();
        const b = String(canon || '').toLowerCase().trim();
        if (!a && !b) return true;
        if (userNames.has(a) || userNames.has(b)) {
            if (!excluded.includes(canon || raw)) excluded.push(canon || raw);
            return true;
        }
        return false;
    };

    const roster = [];
    const addUnique = (name) => {
        const n = canonicalize(name);
        if (exclude(name, n)) return;
        if (!roster.some(r => r.toLowerCase() === n.toLowerCase())) roster.push(n);
    };

    // Active ledger NPCs first — always included, never capped. Dormant-only
    // NPCs are exempt from injection and evaluation (§20), so they should not
    // consume a roster slot every turn (item 3 fix). They still join normally
    // via `Present:` when actually in scene, and the dormant poll wakes their
    // intentions on schedule regardless of roster membership.
    for (const entry of getActiveLedger()) addUnique(entry.npc);
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
                        if (exclude(name, canonicalize(name))) continue;
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

    // Say so when the player character was filtered out. This used to be
    // silent, so when the filter missed a name form there was nothing in the
    // log to explain how the PC ended up with intentions.
    if (excluded.length > 0) {
        console.log(
            `[MWT:Interiority] Excluded the player character from the roster: ${excluded.join(', ')}.`
        );
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
        const { getRegistry, resolveRegistryKey } = await import('../knowledge/registry.js');
        const { loadEntryContent } = await import('../knowledge/lorebook.js');
        const { stripRelationshipBlock } = await import('../knowledge/relationships.js');
        const reg = getRegistry();
        // Roster names come from the world state `Present:` line and need not
        // match the registry's key form. An exact lookup silently costs the NPC
        // their entire dossier on BOTH calls. registry.js owns the resolution
        // rules (one owner of the format).
        const key = resolveRegistryKey(reg, npcName);
        const info = key != null ? reg[key] : null;
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
 * Dormant entries (§20) stay out of `openIntentions`: that list is the
 * EVALUATION list, and the whole point of dormancy is that a scheduled
 * intention is not evaluated per turn.
 *
 * They are still sent, separately, as `scheduledIntentions`. The intentions
 * call does two jobs — it evaluates existing intentions AND proposes new ones —
 * and dropping dormant entries entirely was only correct for the first. For the
 * second it meant the model could not see that Ezra already plans to call
 * Dorothy on Monday, so it re-proposed that plan from unchanged story context
 * every single turn. Exact-string dedup caught the re-proposals that came back
 * word for word and nothing else, so the ledger accumulated near-duplicate
 * paraphrases of one intention — and deleting them just freed the slot to be
 * filled again next turn.
 *
 * The scheduled list carries NO ids, which is what keeps §20 intact: the model
 * can see these intentions but has no handle to mark them executed or dropped.
 * It is a "you already know about these" list, not an evaluable one.
 *
 * @param {string[]} roster
 * @returns {Promise<Array<{name, knowledgeEntry, openIntentions, scheduledIntentions}>>}
 */
export async function assembleNpcBlocks(roster) {
    const blocks = [];
    for (const name of roster) {
        const knowledgeEntry = await loadNpcKnowledge(name);
        const entries = getLedgerEntriesForNpc(name);
        // §20: only active entries go to the intentions evaluation list.
        const openIntentions = entries.filter(e => e.status !== 'dormant');
        const scheduledIntentions = entries.filter(e => e.status === 'dormant');
        blocks.push({ name, knowledgeEntry, openIntentions, scheduledIntentions });
    }
    return blocks;
}

// ─── Thoughts-call context assembly (v2 §17) ─────────────────────────────────

/**
 * Assemble the richer per-NPC context blocks for the dedicated thoughts call.
 *
 * Unlike the lean v1 {@link assembleNpcBlocks}, this loads interpretive layers
 * that the input-partition rule (§15) permits ONLY on the thoughts side:
 * growth profile, relationships from data, recent thoughts (interior memory).
 *
 * The intentions call NEVER sees these — it stays on {@link assembleNpcBlocks}.
 *
 * @param {string[]} roster
 * @returns {Promise<Array<object>>} rich blocks keyed by §17 block names
 */
async function _assembleThoughtsNpcBlocks(roster) {
    // Dynamic imports — knowledge module is an optional dependency. Cached by
    // the ES module system, so repeated calls resolve to the same namespace.
    const knowledgeLorebook = await import('../knowledge/lorebook.js').catch(() => null);
    const knowledgeGrowth = await import('../knowledge/growth.js').catch(() => null);
    const knowledgeRelationships = await import('../knowledge/relationships.js').catch(() => null);

    const blocks = [];
    for (const name of roster) {
        const block = {
            name,
            characterCore: '',
            knowledgeEntry: '',
            relationships: '',
            recentThoughts: '',
            innerState: getInnerState(name), // §18: prior mood line fed to the thoughts call
            openIntentions: getLedgerEntriesForNpc(name),
        };

        // Load raw knowledge entry (already relationship-stripped by loadNpcKnowledge)
        const rawKnowledge = await loadNpcKnowledge(name);

        // Partition identity fields from the remainder so <character_core>
        // and <knowledge_entry> carry different content (no overlap, per §17).
        let identityFields = {};
        let knowledgeRemainder = rawKnowledge || '';
        if (rawKnowledge && knowledgeLorebook?.extractIdentityFields) {
            const split = knowledgeLorebook.extractIdentityFields(rawKnowledge);
            identityFields = split.fields;
            knowledgeRemainder = split.remainder;
        }
        block.knowledgeEntry = knowledgeRemainder;

        // <character_core> — growth profile (primary), else identity fields (fallback)
        if (knowledgeGrowth?.loadProfile) {
            try {
                const profile = await knowledgeGrowth.loadProfile(name);
                if (profile) block.characterCore = profile;
            } catch { /* profile unavailable */ }
        }
        if (!block.characterCore && Object.keys(identityFields).length > 0) {
            block.characterCore = Object.entries(identityFields)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n');
        }

        // <relationships> — outbound edges filtered to roster (sealed minds)
        if (knowledgeRelationships?.getNpcRelationships) {
            block.relationships = _formatRelationshipsForRoster(
                name, roster, knowledgeRelationships.getNpcRelationships
            );
        }

        // <recent_thoughts> — interior memory (continue, don't repeat)
        const recent = getRecentThoughtsForNpc(name, 4);
        if (recent.length > 0) {
            block.recentThoughts = recent.map(r => {
                const label = r.msgIdx != null ? ` (msg ${r.msgIdx})` : '';
                return `- "${r.thought}"${label}`;
            }).join('\n');
        }

        blocks.push(block);
    }
    return blocks;
}

/**
 * Format an NPC's outbound relationships, filtered to roster members.
 *
 * Implements the sealed-minds rule structurally: Mara's block gets only
 * Mara→Jonah edges, never Jonah's edge about her.
 *
 * @param {string} npcName
 * @param {string[]} roster
 * @param {function} getNpcRelationships - from knowledge/relationships.js
 * @returns {string} formatted relationship lines, or '' if none
 */
function _formatRelationshipsForRoster(npcName, roster, getNpcRelationships) {
    try {
        const rels = getNpcRelationships(npcName);
        if (!rels || rels.length === 0) return '';
        const rosterLower = new Set(roster.map(n => String(n).toLowerCase()));
        const filtered = rels.filter(r => rosterLower.has(String(r.target).toLowerCase()));
        if (filtered.length === 0) return '';
        return filtered.map(r => {
            const note = r.notes ? ` (${r.notes})` : '';
            return `- ${npcName} → ${r.target}: ${r.type}${note}`;
        }).join('\n');
    } catch {
        return '';
    }
}

// ─── API call ────────────────────────────────────────────────────────────────

/**
 * Private shared implementation for all batched API calls.
 *
 * @param {string[]} roster
 * @param {object} [opts] - override which features are requested (used by split mode)
 * @param {boolean|null} [opts.thoughts] - force thoughts on/off; null = use settings
 * @param {boolean|null} [opts.intentions] - force intentions on/off; null = use settings
 * @param {string} [opts.label] - log label for the call
 * @returns {Promise<object|null>} parsed JSON result, or null on failure
 */
async function _runCall(roster, { thoughts = null, intentions = null, label = 'batched', useRichThoughtsContext = false } = {}) {
    if (!hasValidSettings()) {
        console.warn(`[MWT:Interiority] No API connection configured (${label}).`);
        return null;
    }

    const settings = getSettings();
    const wantThoughts = thoughts !== null ? thoughts : settings.generateThoughts !== false;
    const wantIntentions = intentions !== null ? intentions : settings.generateIntentions !== false;
    if (!wantThoughts && !wantIntentions) {
        console.warn(`[MWT:Interiority] Both thoughts and intentions are disabled — skipping ${label} call.`);
        return null;
    }

    // §21: thoughts connection profile — when set, route the (expensive)
    // thoughts call through a separate connection profile so a better model
    // can be pointed at voice without paying for it on bookkeeping. The
    // intentions call stays on the module connection. Only applies to the
    // rich-thoughts (split) call; the unified call uses the module connection.
    const apiSettings = useRichThoughtsContext && settings.thoughtsConnectionProfileId
        ? { ...settings, connectionProfileId: settings.thoughtsConnectionProfileId }
        : settings;

    // Rich thoughts context (v2 §17) uses the dedicated craft prompt + richer
    // per-NPC blocks. The v1 unified call and the intentions-side split call
    // stay on the lean blocks + unified prompt.
    const npcBlocks = useRichThoughtsContext
        ? await _assembleThoughtsNpcBlocks(roster)
        : await assembleNpcBlocks(roster);
    const windowSize = Math.max(1, settings.messageWindow || 8);

    // Get stripped recent messages
    const recentMessages = getStrippedRecentMessages(windowSize);
    if (!recentMessages) {
        console.warn(`[MWT:Interiority] No recent messages to process (${label}).`);
        return null;
    }

    const worldTime = getWorldTime();
    const playerName = [...getUserNames({ lower: false })][0] || '';

    let systemPrompt, userContent;
    if (useRichThoughtsContext) {
        systemPrompt = buildThoughtsSystemPrompt();
        userContent = buildThoughtsUserContent({
            npcBlocks,
            recentMessages,
            worldTime,
            playerName,
        });
    } else {
        systemPrompt = buildSystemPrompt({ thoughts: wantThoughts, intentions: wantIntentions });
        userContent = buildUserContent({
            npcBlocks,
            recentMessages,
            worldTime,
            playerName,
            includeIntentions: wantIntentions,
        });
    }

    return fetchAndParse(systemPrompt, userContent, apiSettings);
}

/**
 * Make a single batched interiority API call for all roster NPCs.
 * v1 path — reads feature flags from settings (thoughts + intentions together).
 *
 * @param {string[]} roster
 * @returns {Promise<object|null>} parsed JSON result, or null on failure
 */
export async function runBatchedCall(roster) {
    return _runCall(roster);
}

// ─── Split-call mode (v2 §16) ────────────────────────────────────────────────

/**
 * Run two parallel batched calls — one for intentions only, one for thoughts
 * only — and return both results. Each call is independently error-isolated:
 * a failure in one returns null without affecting the other.
 *
 * Both calls see the SAME message window and roster. The thoughts call sees
 * the pre-mutation ledger (including dormant entries once §20 ships); the
 * intentions call evaluates and mutates it. Because validation happens later
 * in validateAndApply (after both calls complete), neither call mutates
 * shared state during execution — parallel execution is safe.
 *
 * §21 cost dials apply to the thoughts side only (intentions always run):
 *  - `thoughtsInterval` (N): skip the thoughts call on turns where
 *    `turnCounter % N !== 0`. 1 = every turn (default).
 *  - `thoughtsProfiledOnly`: restrict the rich-thoughts roster to NPCs that
 *    have a growth profile; unprofiled NPCs are dropped for that turn.
 *
 * When thoughts are skipped, `thoughtsResult` is null — the caller runs the
 * intentions call alone and validateAndApply applies only ledger mutations
 * (no reactions), exactly as if the thoughts feature were disabled.
 *
 * @param {string[]} roster
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] - user-initiated generation: bypass the
 *   `thoughtsInterval` throttle. The interval throttles automatic per-turn
 *   thoughts; it must never refuse a generation the user explicitly asked for.
 *   `thoughtsProfiledOnly` is NOT bypassed — that dial is a scope choice about
 *   which NPCs get rich thoughts, not a cost throttle.
 * @returns {Promise<{intentionsResult: object|null, thoughtsResult: object|null}>}
 */
export async function runSplitCall(roster, { force = false } = {}) {
    const settings = getSettings();

    // Respect the feature toggles. Split mode runs two specialized calls, but
    // each call is still gated by the user's "generate thoughts" / "generate
    // intentions" panel setting. Forcing the flags into _runCall (which it
    // uses to pick a prompt) previously bypassed these toggles entirely,
    // burning API calls and grace-period budget on features the user turned off.
    const wantThoughts = settings.generateThoughts !== false;
    const wantIntentions = settings.generateIntentions !== false;

    // §21: thoughtsInterval — skip the thoughts call on off-turns (auto only).
    const interval = Math.max(1, Number(settings.thoughtsInterval) || 1);
    const turn = getTurnCounter();
    const skipThoughtsThisTurn = !force && interval > 1 && (turn % interval !== 0);
    if (skipThoughtsThisTurn) {
        console.log(`[MWT:Interiority] Thoughts call skipped this turn (${turn} % ${interval} !== 0) — running intentions only.`);
    } else if (force && interval > 1 && (turn % interval !== 0)) {
        console.log(`[MWT:Interiority] Thoughts call forced on an off-turn (user-initiated) — interval ${interval} bypassed.`);
    }

    // §21: thoughtsProfiledOnly — filter the thoughts roster to profiled NPCs.
    let thoughtsRoster = roster;
    if (!skipThoughtsThisTurn && wantThoughts && settings.thoughtsProfiledOnly === true) {
        // _filterToProfiledNpcs logs a detailed diagnostic when it empties the
        // roster — the bare "nobody has a profile" message can't distinguish
        // "no profiles saved yet" from "roster names don't match the registry".
        thoughtsRoster = await _filterToProfiledNpcs(roster);
    }
    const runThoughts = wantThoughts && !skipThoughtsThisTurn && thoughtsRoster.length > 0;

    const [intentionsRes, thoughtsRes] = await Promise.all([
        wantIntentions
            ? _runCall(roster, { thoughts: false, intentions: true, label: 'intentions' })
                .catch(err => {
                    console.error('[MWT:Interiority] Intentions call failed:', err);
                    return null;
                })
            : Promise.resolve(null),
        runThoughts
            ? _runCall(thoughtsRoster, { thoughts: true, intentions: false, label: 'thoughts', useRichThoughtsContext: true })
                .catch(err => {
                    console.error('[MWT:Interiority] Thoughts call failed:', err);
                    return null;
                })
            : Promise.resolve(null),
    ]);
    return { intentionsResult: intentionsRes, thoughtsResult: thoughtsRes };
}

/**
 * Filter a roster down to NPCs that have a growth profile in the knowledge
 * module's registry (`profileUid` set). Used by the §21 `thoughtsProfiledOnly`
 * dial. The knowledge module is an optional dependency; if unavailable, the
 * roster is returned unchanged (fail-open so a missing module never silently
 * kills the thoughts call).
 *
 * @param {string[]} roster
 * @returns {Promise<string[]>}
 */
async function _filterToProfiledNpcs(roster) {
    try {
        const { getRegistry, resolveRegistryKey } = await import('../knowledge/registry.js');
        const reg = getRegistry();
        if (!reg) return roster; // no registry — fail open
        const filtered = roster.filter(name => {
            const key = resolveRegistryKey(reg, name);
            return key != null && reg[key]?.profileUid != null;
        });

        // Diagnostic: an empty result has two very different causes, and the
        // fix differs. Name both the roster and the NPCs that actually carry a
        // profileUid so the log distinguishes "no profiles saved yet" from
        // "roster names don't match any registry entry".
        if (filtered.length === 0 && roster.length > 0) {
            const profiled = Object.keys(reg).filter(k => reg[k]?.profileUid != null);
            const known = Object.keys(reg);
            console.log(
                '[MWT:Interiority] "Profiled NPCs only" is ON but no roster NPC has a saved growth profile — skipping thoughts call.\n' +
                `  Roster this turn: ${roster.join(', ') || '(empty)'}\n` +
                `  Registry entries WITH a saved profile: ${profiled.join(', ') || '(none)'}\n` +
                `  Registry entries total: ${known.join(', ') || '(none)'}\n` +
                '  Note: profileUid is set only when a generated growth profile is SAVED to the ' +
                '"NPC Profiles" lorebook — generating or psychoanalyzing alone does not set it. ' +
                'Otherwise turn "Profiled NPCs only" off.'
            );
        }
        return filtered;
    } catch {
        return roster; // knowledge module unavailable — fail open
    }
}

/**
 * Merge the two split-call results into a single unified result object that
 * the EXISTING validateAndApply can process unchanged.
 *
 * The intentions result carries `executed`/`dropped`/`new_intentions` per NPC;
 * the thoughts result carries `reaction` per NPC. Neither carries the other's
 * fields (the prompt only asked for what was requested). Merge by NPC name,
 * combining fields from both sources.
 *
 * NPCs present in one result but not the other (e.g. an NPC that had no
 * reaction, so the thoughts call omitted it) are still included — the missing
 * side contributes nothing for that NPC.
 *
 * @param {object|null} intentionsResult
 * @param {object|null} thoughtsResult
 * @param {string[]} roster - canonical NPC name list (preserves order)
 * @returns {{npcs: Array<object>}} unified result; empty npcs if both inputs null
 */
export function mergeSplitResults(intentionsResult, thoughtsResult, roster) {
    // Build name → entry maps from both results (case-insensitive keys)
    const intentionsMap = new Map();
    const thoughtsMap = new Map();

    if (intentionsResult && Array.isArray(intentionsResult.npcs)) {
        for (const npc of intentionsResult.npcs) {
            const name = String(npc?.name || '').trim();
            if (name) intentionsMap.set(name.toLowerCase(), npc);
        }
    }
    if (thoughtsResult && Array.isArray(thoughtsResult.npcs)) {
        for (const npc of thoughtsResult.npcs) {
            const name = String(npc?.name || '').trim();
            if (name) thoughtsMap.set(name.toLowerCase(), npc);
        }
    }

    // Merge by roster name. validateAndApply discards non-roster NPCs anyway,
    // so we only emit roster members here (cleaner + avoids the discard log).
    const mergedNpcs = [];
    const seen = new Set();
    for (const name of roster) {
        const lower = name.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);

        const intEntry = intentionsMap.get(lower) || {};
        const thoughtEntry = thoughtsMap.get(lower) || {};

        const merged = { name };
        // v1 shape: reaction comes from the thoughts call only
        if (thoughtEntry.reaction !== undefined) merged.reaction = thoughtEntry.reaction;
        // v2 shape: thought + inner_state come from the thoughts call only
        if (thoughtEntry.thought !== undefined) merged.thought = thoughtEntry.thought;
        if (thoughtEntry.inner_state !== undefined) merged.inner_state = thoughtEntry.inner_state;
        // Intentions come from the intentions call only
        if (intEntry.executed !== undefined) merged.executed = intEntry.executed;
        if (intEntry.dropped !== undefined) merged.dropped = intEntry.dropped;
        if (intEntry.new_intentions !== undefined) merged.new_intentions = intEntry.new_intentions;

        mergedNpcs.push(merged);
    }

    return { npcs: mergedNpcs };
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

// ─── Dormant poll (v2 §20) ────────────────────────────────────────────────────

/**
 * Run the dormant-intentions lazy poll.
 *
 * Fires every {@link DORMANT_POLL_INTERVAL} turns when there are dormant
 * entries. Asks the model a cheap, focused question: is each dormant
 * intention's trigger near? If so, wake it (flip to active + stamp age).
 *
 * Wake semantics (§20): wake EARLY — when the event is "tomorrow," not when
 * it starts — so the NPC gets a turn or two of anticipatory behavior and the
 * narrator receives the demand while it's relevant.
 *
 * Failure isolation: the poll never blocks the main generation. A parse
 * failure or API error is logged and swallowed.
 *
 * @returns {Promise<number>} count of entries woken (0 if poll didn't fire)
 */
export async function runDormantPoll() {
    const dormant = getDormantLedger();
    if (dormant.length === 0) return 0;

    if (!hasValidSettings()) {
        console.warn('[MWT:Interiority] Dormant poll skipped — no API connection configured.');
        return 0;
    }

    const settings = getSettings();
    const windowSize = Math.max(1, settings.messageWindow || 8);
    const recentMessages = getStrippedRecentMessages(windowSize);
    if (!recentMessages) return 0;

    const worldTime = getWorldTime();
    const systemPrompt = buildDormantPollSystemPrompt();
    const userContent = buildDormantPollUserContent({
        dormantEntries: dormant,
        recentMessages,
        worldTime,
    });

    const result = await fetchAndParse(systemPrompt, userContent, settings);
    if (!result || !Array.isArray(result.intentions)) {
        console.warn('[MWT:Interiority] Dormant poll returned no valid result.');
        return 0;
    }

    const gracePeriod = Math.max(0, settings.intentionGracePeriod || 0);
    const validIds = new Set(dormant.map(e => e.id));
    let woken = 0;

    for (const item of result.intentions) {
        if (!item || typeof item.wake !== 'boolean') continue;
        const id = String(item.id || '').trim();
        if (!id || !validIds.has(id)) continue; // unknown id — ignore
        if (item.wake) {
            wakeLedgerEntry(id, gracePeriod);
            woken++;
            console.log(`[MWT:Interiority] Dormant intention ${id} woken by poll.`);
        }
    }

    if (woken > 0) {
        console.log(`[MWT:Interiority] Dormant poll woke ${woken} intention(s).`);
    }
    return woken;
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
 * @param {object} [scopeToken] - optional scope token captured before the API
 *   call. When provided, the validator asserts scope immediately after its
 *   `resolveUserNames()` await and before any persistent mutation (INTERIORITY-02).
 *   The caller still asserts after the return; this covers the gap inside.
 * @returns {Promise<object|null>} { reactions: [], ledgerChanged: boolean }, or
 *   null when the scope changed during the await (caller should discard).
 */
export async function validateAndApply(result, roster, msgIdx, scopeToken) {
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

    // Snapshot the inner-state store BEFORE this turn's thoughts call
    // rewrites it (§18 rollback). Without this, a swipe would roll back
    // Mara's intentions but leave her mood from the abandoned timeline.
    const innerStatesSnapshot = getInnerStatesSnapshot();

    // Normalize roster for case-insensitive matching
    const rosterLower = new Set(roster.map(n => n.toLowerCase().trim()));

    // Defense-in-depth: also reject the user even if they somehow made it into
    // the roster (e.g. a stale ledger entry from before this fix, which is
    // seeded back into the roster every turn by getActiveLedger).
    const userNamesLower = await resolveUserNames();

    // INTERIORITY-02: The resolveUserNames() await above can cross a chat
    // switch (it resolves the knowledge registry via dynamic import). Assert
    // scope immediately after it and BEFORE any persistent mutation. If the
    // chat changed, return null so the caller discards the result without
    // committing thoughts/intentions/ledger/inner-state to the wrong chat.
    if (scopeToken && !assertSameScope(scopeToken).ok) {
        console.log('[MWT:Interiority] validateAndApply aborted — chat changed during resolveUserNames().');
        return null;
    }

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
                innerStatesSnapshot,
                generatedAt: Date.now(),
            });
        }
        return { reactions: [], ledgerChanged: false };
    }

    // Increment the age of every open intention — AFTER the shape check so a
    // garbage parse doesn't burn a turn of grace period off every open
    // intention (item 8a fix). This is the first step of the grace-period
    // mechanism: intentions that haven't survived enough turns since being
    // declared are protected from premature execution/dropping.
    incrementLedgerAges();

    // Build a map of ledger entry ids for quick lookup.
    // §20: dormant entries are excluded from executed/dropped evaluation —
    // they never appear in the prompt's <open_intentions>, so any reference
    // to a dormant id is a hallucination that should be ignored.
    const ledgerIds = new Set(
        data.ledger.filter(e => e.status !== 'dormant').map(e => e.id)
    );

    // Build a lookup from id → turnsOpen for grace-period enforcement.
    // The model frequently declares and executes/drops an intention in the
    // same turn — or one turn later — before the trigger has had a chance
    // to arrive. The grace period forces intentions to survive at least
    // N turns before they can be removed.
    const ledgerAgeMap = new Map(
        data.ledger.filter(e => e.status !== 'dormant')
            .map(e => [e.id, e.turnsOpen || 0])
    );

    const seenNpcs = new Set();
    for (const npcResult of result.npcs) {
        const name = String(npcResult.name || '').trim();
        if (!name || !rosterLower.has(name.toLowerCase())) {
            // Unknown name — discard
            console.warn(`[MWT:Interiority] Discarding NPC block "${name}" — not in roster [${roster.join(', ')}].`);
            continue;
        }
        if (userNamesLower.has(name.toLowerCase())) {
            // The player character must never get thoughts or ledger entries.
            // Reaching here means the roster filter let them through, which is
            // worth saying out loud — an intention for the PC makes the
            // injection demand the narrator act for the player.
            console.warn(
                `[MWT:Interiority] Discarding block for "${name}" — that is the player character. ` +
                `They should not have been on the roster; please report this.`
            );
            continue;
        }
        if (seenNpcs.has(name.toLowerCase())) {
            // Model emitted the same NPC twice — first block wins
            continue;
        }
        seenNpcs.add(name.toLowerCase());

        // ── Thought / Reaction (display-only, max 1 per NPC per turn) ──
        // Skipped entirely when the thoughts feature is disabled.
        // Handles BOTH shapes:
        //   v1: reaction: { re, thought }
        //   v2: thought: { type, re?, text } + inner_state
        if (wantThoughts) {
            // ── Inner state (§18) — persist BEFORE building the reaction ──
            // The inner_state field is a sibling of `thought` in the v2
            // contract, so it must be persisted even when the thought itself
            // is dropped (boilerplate/null). setInnerStateGuarded applies the
            // drift backstop: if the returned line is near-identical to the
            // prior, the prior is kept verbatim. The return value is the line
            // now stored (prior or new), which the reaction entry should
            // display so the UI matches the persistent state.
            let storedInnerState = undefined;
            const isV2Shape = npcResult.thought !== undefined || npcResult.inner_state !== undefined;
            if (isV2Shape) {
                const rawInnerState = String(npcResult.inner_state || '').trim();
                if (rawInnerState) {
                    storedInnerState = setInnerStateGuarded(name, rawInnerState);
                }
            }

            let reactionEntry = null;

            if (npcResult.thought && typeof npcResult.thought === 'object') {
                // v2 thoughts-call shape — type taxonomy + optional re
                const t = npcResult.thought;
                const validTypes = ['reaction', 'rumination', 'memory', 'anticipation'];
                const type = validTypes.includes(t.type) ? t.type : 'reaction';
                const text = String(t.text || '').trim();
                const re = String(t.re || '').trim();
                // reaction requires re; rumination/memory/anticipation don't.
                // Drop empty/boilerplate (Omission Over Filler).
                if (text && !isBoilerplate(text) && (type !== 'reaction' || re)) {
                    reactionEntry = {
                        npc: name,
                        type,
                        re: re || undefined,
                        thought: text.slice(0, MAX_THOUGHT_LENGTH),
                        innerState: storedInnerState || undefined,
                    };
                }
            } else if (npcResult.reaction && typeof npcResult.reaction === 'object') {
                // v1 unified-call shape — implicitly type "reaction"
                const re = String(npcResult.reaction.re || '').trim();
                const thought = String(npcResult.reaction.thought || '').trim();
                if (re && thought && !isBoilerplate(thought)) {
                    reactionEntry = {
                        npc: name,
                        re: re.slice(0, 300),
                        thought: thought.slice(0, MAX_THOUGHT_LENGTH),
                    };
                }
            }

            if (reactionEntry) reactions.push(reactionEntry);
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

                // §20: classify horizon. Scheduled → dormant; immediate/event → active.
                // Unknown/missing horizon → active (safe default per §20).
                const horizon = String(ni.horizon || '').toLowerCase().trim();
                const wakeHint = String(ni.wake_hint || '').trim();
                let entryStatus = undefined;
                let entryWakeHint = undefined;
                if (horizon === 'scheduled') {
                    entryStatus = 'dormant';
                    entryWakeHint = wakeHint;
                }
                // No code-side guard against a scheduled event-conditional
                // trigger ("next time X"): the prompt forbids it, and a
                // misclassification is user-correctable from the panel
                // (⏰ wake / 💤 sleep) rather than silently overridden here.

                addLedgerEntry(
                    { npc: name, action, trigger, status: entryStatus, wakeHint: entryWakeHint },
                    worldTime,
                    msgIdx,
                );
                ledgerChanged = true;
            }
        }
    }

    // Store per-message reactions + ledger + inner-state snapshots
    // (keyed by stable msgKey). Both snapshots enable swipe/edit/delete
    // rollback — without innerStatesSnapshot, a swipe would roll back
    // Mara's intentions but leave her mood from the abandoned timeline.
    if (msgKey) {
        setPerMessage(msgKey, {
            reactions,
            ledgerSnapshot,
            innerStatesSnapshot,
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
