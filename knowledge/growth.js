/**
 * knowledge/growth.js — NPC Growth Profile: evidence capture + generation.
 *
 * Implements Slices 1–3 of NPC_GROWTH_BLUEPRINT.md: a user-initiated
 * "Generate growth profile" pass that:
 *
 *   1. Captures behavioral observations (with verbatim quote receipts) from
 *      recent chat messages about a target NPC.
 *   2. Generates an anti-textbook character profile FROM those observations
 *      — never from the prior profile or the existing Personality: line.
 *
 * Slice 2 adds persistence:
 *   - Captured observations are appended to the two-tier evidence store
 *     (`raw[]` in chat metadata via evidence.js).
 *   - The generated profile can be saved to the "NPC Profiles" lorebook (a
 *     separate, non-injected lorebook with `key: []`).
 *   - The registry gains a `profileUid` cross-referencing the profile entry.
 *   - `DOSSIER_UPDATE_PROMPT` is patched (in lorebook.js) to skip the
 *     `Personality:` line for profiled NPCs — the hard structural partition.
 *
 * Slice 3 adds consolidation + maturity:
 *   - User-initiated consolidation pass (raw → consolidated with back-
 *     references, consumed raw → archived).
 *   - Profile regeneration from existing evidence (no re-capture).
 *   - `userOverrides[]` for hand-edits that survive regeneration.
 *
 * The one rule everything obeys: **the profile is a LEAF, never a ROOT.**
 * Evidence flows one direction (messages → observations → profile). The
 * profile never feeds back into capture or synthesis.
 */

import {
    getChat, getChatMeta, stripNonNarrative, getCurrentWorldState,
    getLatestChronicleEntry, normaliseOutput, parseJsonLenient,
    persistChatMetaNow,
} from '../core/index.js';
import { hasValidSettings } from './settings.js';
import { getRegistry, getProfileUid, setProfileUid } from './registry.js';
import { loadEntryContent, loadProfileContent, writeProfileToLorebook, ktFetchFromApi } from './lorebook.js';
import {
    appendRawObservations, getEvidenceForProfile, stampProfileGenerated,
    hasEvidenceFile,
    getRawForConsolidation, applyConsolidation,
    getUserOverrides,
    getCaptureWatermark, setCaptureWatermark,
    getBackfillWatermark, setBackfillWatermark,
} from './evidence.js';
import { GROWTH_EVIDENCE_PROMPT, GROWTH_PROFILE_PROMPT, GROWTH_PSYCHOANALYZE_PROMPT, GROWTH_CONSOLIDATION_PROMPT } from './prompts.js';
import { expandIlsSummaries, isIlsSummary, normalizeSendDate } from './ils_compat.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Number of recent messages to scan for behavioral evidence. Broader than the
 *  scan window (50) because personality is built over many interactions. */
const EVIDENCE_MESSAGE_WINDOW = 80;

/** Field labels from DOSSIER_FIELDS that contain user-authored canon. We
 *  extract these from the existing entry to pass to the profile generator as
 *  authoritative context — but we NEVER extract the Personality: line. */
const CANON_FIELD_LABELS = ['Canon Lock', 'Background', 'Role', 'Where to Find'];

// ─── Truncation heuristic ────────────────────────────────────────────────────

/**
 * Heuristic: does this prose look cut off mid-sentence?
 *
 * This is a *suspicion* signal for the UI, complementary to the *confirmed*
 * `finish_reason === 'length'` throw in core/api.js. On connection profiles,
 * `extractData: true` hides the raw finish_reason, so a hidden response-length
 * cap can truncate output with no error — this catches that case.
 *
 * Complete prose ends in terminal punctuation (`. ! ? …`), optionally followed
 * by closing quotes/parens/emphasis. A hard cut can leave a balanced-but-empty
 * artifact like `…six months ago("")` — so we PEEL trailing closers first, then
 * check whether what remains actually ends a sentence. That tail ends in `)`,
 * which would fool a naive "ends with punctuation" check.
 *
 * @param {string} text
 * @returns {boolean} true if the text appears truncated
 */
export function looksTruncated(text) {
    const trimmed = (text || '').trimEnd();
    if (!trimmed) return false; // empty output is a separate error, handled upstream
    // Peel trailing closers that can legitimately follow a sentence end.
    const core = trimmed.replace(/[)\]}"'”’»*`_\s]+$/u, '');
    if (!core) return false; // was nothing but closers — treat as inconclusive
    return !/[.!?…]$/u.test(core);
}

// ─── Quote verification ──────────────────────────────────────────────────────

/**
 * Normalize text for lenient verbatim matching: lowercase, drop punctuation and
 * markdown, collapse whitespace. This lets a faithfully-copied quote match its
 * source across trivial reformatting (capitalization, wrapping quotes,
 * `*emphasis*`) while still rejecting a genuine paraphrase, which won't appear
 * as a substring.
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeForMatch(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** How far from the model's cited msgIdx to search. Its index is approximate —
 *  it miscounts across long or sparse windows (hidden/summary messages create
 *  index gaps), so a real quote can be cited one or two messages off. */
const VERIFY_WINDOW = 5;

/** Fraction of a quote's word-bigrams that must appear in a candidate message
 *  for a non-contiguous match. Tolerates an interposed dialogue tag
 *  (`"…," he said, "…"`), which only breaks bigrams locally, while still
 *  rejecting a paraphrase, whose different word choices break most bigrams. */
const BIGRAM_MATCH_THRESHOLD = 0.7;

function bigrams(tokens) {
    const out = [];
    for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
    return out;
}

/**
 * Does `quote` appear in a single message — either as an exact contiguous span
 * or, failing that, with enough bigram overlap to be the same words split by an
 * interposed tag/action? `needle`/`needleBigrams` are precomputed by the caller.
 */
function quoteMatchesMessage(needle, needleBigrams, msg) {
    if (!msg || !msg.mes) return false;
    const haystack = normalizeForMatch(stripNonNarrative(msg.mes));
    if (!haystack) return false;
    if (haystack.includes(needle)) return true; // exact contiguous span (fast path)
    if (needleBigrams.length === 0) return false;
    const haySet = new Set(bigrams(haystack.split(' ')));
    let hit = 0;
    for (const bg of needleBigrams) if (haySet.has(bg)) hit++;
    return hit / needleBigrams.length >= BIGRAM_MATCH_THRESHOLD;
}

/**
 * Find the chat message that actually contains an observation's quote and return
 * its index — or -1 if the quote can't be verified. The model is told to copy
 * dialogue OR action-narration word-for-word; this enforces it. A paraphrase
 * (what the model tends to do for actions) shares few words with the source and
 * returns -1.
 *
 * Two tolerances keep it from false-flagging *real* quotes:
 *   1. **Windowed** — the model's cited msgIdx is approximate, so we search a
 *      small neighborhood, expanding OUTWARD so the first hit is the NEAREST one.
 *   2. **Interposition-tolerant** — a quote split by a dialogue tag
 *      (`"…," he murmured, "…"`) isn't a contiguous substring, so we fall back to
 *      bigram overlap, which survives a local break but not a whole paraphrase.
 *
 * Returning the matched index (not just a boolean) lets the caller SNAP the
 * observation's msgIdx to the real source — fixing both the displayed `[msg N]`
 * and the evidence store's `ts` anchor (extractMsgTs reads chat[msgIdx].send_date).
 *
 * Matches against the SAME stripped text the evidence prompt was shown
 * (stripNonNarrative). Very short quotes are rejected as too spurious to trust.
 *
 * @param {string} quote
 * @param {number|null} msgIdx — cited chat-array index (approximate)
 * @param {Array} chat — the chat array
 * @returns {number} matched chat index, or -1 if unverifiable
 */
function findQuoteMatch(quote, msgIdx, chat) {
    const needle = normalizeForMatch(quote);
    if (needle.length < 8) return -1; // too short to be a meaningful, non-spurious receipt
    const needleTokens = needle.split(' ');
    if (needleTokens.length < 3) return -1;
    const needleBigrams = bigrams(needleTokens);

    if (msgIdx != null && msgIdx >= 0 && msgIdx < chat.length) {
        // Expand outward from the cited index so the first hit is the nearest one.
        if (quoteMatchesMessage(needle, needleBigrams, chat[msgIdx])) return msgIdx;
        for (let d = 1; d <= VERIFY_WINDOW; d++) {
            const lo = msgIdx - d;
            const hi = msgIdx + d;
            if (lo >= 0 && quoteMatchesMessage(needle, needleBigrams, chat[lo])) return lo;
            if (hi < chat.length && quoteMatchesMessage(needle, needleBigrams, chat[hi])) return hi;
        }
        return -1;
    }
    // No usable cited index — scan the whole chat, return the first match.
    for (let i = 0; i < chat.length; i++) {
        if (quoteMatchesMessage(needle, needleBigrams, chat[i])) return i;
    }
    return -1;
}

// ─── Message formatting ──────────────────────────────────────────────────────

/**
 * Format recent chat messages with their array indices, so the evidence
 * prompt can cite `msgIdx` in observations.
 *
 * Indices are the actual chat-array positions (0-based), formatted as
 * bracketed prefixes: `[42] Kira: "I won't let them take you."`
 *
 * Non-narrative blocks (preset trackers, old chatter, time tags) are stripped
 * so tracker secrets don't launder into the evidence context.
 *
 * @param {number} count — max messages to include (from the end of the chat)
 * @returns {string|null} formatted messages, or null if the chat is empty
 */
function getIndexedMessages(count = EVIDENCE_MESSAGE_WINDOW) {
    const chat = getChat();
    if (!chat || !chat.length) return null;

    const startIdx = Math.max(0, chat.length - count);
    const lines = [];
    for (let i = startIdx; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || !msg.mes || msg.is_system) continue;
        // Skip ILS summary messages — they contain paraphrased text, not
        // verbatim quotes. Extracting "verbatim" quotes from them would create
        // receipts that pass verification (findQuoteMatch matches them against
        // the same summary message) but quote something the character never
        // said. Backfill (Part B) owns that history — it expands summaries to
        // real originals first. (Item 1 fix.)
        if (isIlsSummary(msg)) continue;
        const name = msg.is_user ? (msg.name || 'User') : (msg.name || 'Assistant');
        const text = stripNonNarrative(msg.mes).trim();
        if (!text) continue;
        lines.push(`[${i}] ${name}: ${text}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
}

// ─── Canon extraction ────────────────────────────────────────────────────────

/**
 * Extract canon/context fields from an existing lorebook entry (dossier
 * format) to pass to the profile generator as authoritative context.
 *
 * CRITICAL: this NEVER extracts the `Personality:` line. The personality
 * line is the telephone-loop vector — the growth profile must be derived
 * from evidence, not from a prior personality description.
 *
 * @param {string} content — the existing lorebook entry content
 * @returns {string} canon facts as a formatted string, or '' if none found
 */
export function extractCanonFromEntry(content) {
    if (!content || typeof content !== 'string') return '';
    const lines = content.split('\n');
    const canonLines = [];
    for (const line of lines) {
        const trimmed = line.trim();
        for (const label of CANON_FIELD_LABELS) {
            if (trimmed.startsWith(`${label}:`)) {
                const val = trimmed.slice(label.length + 1).trim();
                if (val && val.toLowerCase() !== 'unknown') {
                    canonLines.push(`${label}: ${val}`);
                }
            }
        }
    }
    return canonLines.join('\n');
}

// ─── Evidence capture ────────────────────────────────────────────────────────

/**
 * Run the evidence-capture API call: extract distilled behavioral
 * observations (with verbatim quotes) from recent messages about a target NPC.
 *
 * @param {string} name — NPC name
 * @param {number|null} uid — lorebook UID (for loading existing context)
 * @returns {Promise<Array<{category:string, claim:string, quote:string, msgIdx:number}>>}
 */
export async function captureEvidence(name, uid) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');

    const messages = getIndexedMessages(EVIDENCE_MESSAGE_WINDOW);
    if (!messages) throw new Error('No recent messages to analyze.');

    // Load the existing entry as identity/context — NOT as a source of
    // observations. The evidence prompt explicitly instructs the model to
    // extract observations from <messages> only.
    let existingContext = '';
    if (uid != null) {
        try {
            const content = await loadEntryContent(uid);
            if (content) existingContext = content;
        } catch { /* ignore load errors */ }
    }

    const worldState = getCurrentWorldState();
    const chronicle = getLatestChronicleEntry();

    const userContent = [
        `<target_npc>${name}</target_npc>`,
        '',
        existingContext ? `<existing_context>\n${existingContext}\n</existing_context>` : '',
        worldState ? `<world_state>\n${worldState}\n</world_state>` : '',
        chronicle ? `<chronicle>\n${chronicle}\n</chronicle>` : '',
        '',
        '<messages>',
        messages,
        '</messages>',
        '',
        '='.repeat(60),
        `Extract behavioral observations about ${name}. Output only JSON.`,
    ].filter(Boolean).join('\n');

    const raw = await ktFetchFromApi(GROWTH_EVIDENCE_PROMPT, userContent, { retries: 1 });
    const cleaned = normaliseOutput(raw);
    const result = parseJsonLenient(cleaned);

    const observations = Array.isArray(result.observations) ? result.observations : [];
    const chat = getChat() || [];

    // Validate in two stages. First, drop truly unanchored items (no claim or no
    // quote) — inadmissible per the blueprint's anchoring guardrail. Then VERIFY
    // each surviving quote is a verbatim span of its cited message and FLAG (not
    // drop) the ones that aren't, so a paraphrased receipt is visible rather than
    // silently trusted. Flag-not-drop because the normalized match can produce
    // false negatives; the user can eyeball a flagged item via its msgIdx.
    const admitted = observations.filter(o =>
        o && typeof o.claim === 'string' && o.claim.trim() &&
        typeof o.quote === 'string' && o.quote.trim()
    ).map(o => {
        const quote = String(o.quote).trim();
        const citedIdx = typeof o.msgIdx === 'number' ? o.msgIdx : null;
        const matchIdx = findQuoteMatch(quote, citedIdx, chat);
        const verified = matchIdx !== -1;
        return {
            category: ['trait', 'value', 'speech'].includes(o.category) ? o.category : 'trait',
            claim: String(o.claim).trim(),
            quote,
            // Snap msgIdx to where the quote actually matched, so the display AND
            // the store's ts anchor (extractMsgTs → chat[msgIdx].send_date) point
            // at the real source. If unverified, keep the model's cited index so
            // the flagged item stays traceable.
            msgIdx: verified ? matchIdx : citedIdx,
            verified,
        };
    });

    const unverified = admitted.filter(o => !o.verified).length;
    if (unverified > 0) {
        console.warn(
            `[MWT:Knowledge] Growth evidence for "${name}": ${admitted.length - unverified}/${admitted.length} ` +
            `observations verbatim-verified. ${unverified} could not be matched word-for-word to their cited ` +
            `message (likely paraphrased) — kept but flagged "not verbatim".`
        );
    }
    return admitted;
}

// ─── Profile generation ──────────────────────────────────────────────────────

/**
 * Run the profile-generation API call: synthesize an anti-textbook character
 * profile FROM the captured evidence only.
 *
 * NEVER receives the prior profile or the existing Personality: line. Canon
 * facts extracted from the existing entry ARE passed (Canon Lock, Background,
 * Role, etc.) because they are user-authored authoritative context that
 * outranks inference.
 *
 * @param {string} name — NPC name
 * @param {Array} observations — from captureEvidence()
 * @param {string} canon — extracted canon facts from the existing entry
 * @returns {Promise<string>} profile prose
 */
export async function generateProfile(name, observations, canon) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    if (!observations || observations.length === 0) {
        throw new Error('No evidence observations to synthesize a profile from.');
    }

    // Format the evidence as a readable list for the generator. Each
    // observation includes its category, distilled claim, and the verbatim
    // quote receipt. Canon-flagged observations (user-promoted, authoritative)
    // are marked so the generator knows they outrank inference.
    const evidenceText = observations.map((o, i) => {
        const canonTag = o.canon ? ' [CANON]' : '';
        const tierTag = o.tier === 'consolidated' ? ' [consolidated]' : '';
        return `${i + 1}. [${o.category}]${canonTag}${tierTag} ${o.claim}\n   Quote: "${o.quote}"${o.msgIdx != null ? ` (msg ${o.msgIdx})` : ''}`;
    }).join('\n');

    const userContent = [
        `<target_npc>${name}</target_npc>`,
        '',
        '<evidence>',
        evidenceText,
        '</evidence>',
        '',
        canon ? `<canon>\n${canon}\n</canon>` : '',
        '',
        '='.repeat(60),
        `Write the character profile for ${name}.`,
    ].filter(Boolean).join('\n');

    const raw = await ktFetchFromApi(GROWTH_PROFILE_PROMPT, userContent, { retries: 1 });
    return normaliseOutput(raw);
}

// ─── Psychoanalyze profile generation (dead-end view) ────────────────────────

/**
 * Run the psychoanalyze-profile API call: synthesize a DEPTH-ORIENTED
 * psychoanalytic portrait FROM the captured evidence + the full curated entry.
 *
 * UNLIKE generateProfile(), this function receives the FULL lorebook entry
 * (including the Personality: line) as historical baseline. This is safe
 * because the output is a DEAD-END view — never injected, never saved to any
 * lorebook, never read by capture or synthesis. The firewall is structural:
 * there is no path back into live context.
 *
 * The evidence store remains primary; the curated entry fills the gap for
 * older characters whose messages have been summarized or lost.
 *
 * @param {string} name — NPC name
 * @param {Array} observations — from the evidence store (same as generateProfile)
 * @param {string} curatedEntry — the FULL lorebook entry content (historical baseline)
 * @param {string} [worldContext] — optional world state + chronicle context
 * @returns {Promise<string>} psychoanalyze portrait prose
 */
export async function generatePsychoanalyzeProfile(name, observations, curatedEntry, worldContext = '') {
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    if (!observations || observations.length === 0) {
        throw new Error('No evidence observations to synthesize a psychoanalyze profile from.');
    }

    // Format the evidence as a readable list (same format as generateProfile).
    const evidenceText = observations.map((o, i) => {
        const canonTag = o.canon ? ' [CANON]' : '';
        const tierTag = o.tier === 'consolidated' ? ' [consolidated]' : '';
        return `${i + 1}. [${o.category}]${canonTag}${tierTag} ${o.claim}\n   Quote: "${o.quote}"${o.msgIdx != null ? ` (msg ${o.msgIdx})` : ''}`;
    }).join('\n');

    const userContent = [
        `<target_npc>${name}</target_npc>`,
        '',
        '<evidence>',
        evidenceText,
        '</evidence>',
        '',
        curatedEntry ? `<curated_entry>\n${curatedEntry}\n</curated_entry>` : '',
        worldContext ? worldContext : '',
        '',
        '='.repeat(60),
        `Write the psychoanalytic portrait for ${name}.`,
    ].filter(Boolean).join('\n');

    const raw = await ktFetchFromApi(GROWTH_PSYCHOANALYZE_PROMPT, userContent, { retries: 1 });
    return normaliseOutput(raw);
}

/**
 * Run the full psychoanalyze-profile pipeline for an NPC:
 *   1. Load evidence from the store (no re-capture)
 *   2. Load the FULL lorebook entry (historical baseline — includes Personality:)
 *   3. Generate the psychoanalytic portrait
 *
 * This is a DEAD-END view. The result is never injected, never saved to any
 * lorebook, and never read by capture or synthesis. The caller (UI) displays
 * it for copy/external-save only.
 *
 * @param {string} name — NPC name (must exist in the registry)
 * @returns {Promise<{observations: Array, portrait: string, curatedEntry: string}>}
 */
export async function runPsychoanalyzeProfile(name) {
    const registry = getRegistry();
    const info = registry[name];
    if (!info) throw new Error(`"${name}" is not in the NPC registry.`);

    const uid = info.uid;
    if (uid === null || uid === undefined) {
        throw new Error(`"${name}" has no lorebook entry (orphan UID).`);
    }

    // Step 1: load evidence from the store (no re-capture needed)
    const observations = getEvidenceForProfile(name);
    if (observations.length === 0) {
        throw new Error(`No evidence available for "${name}". Run growth capture first.`);
    }

    // Step 2: load the FULL lorebook entry as historical baseline.
    // Unlike the regular profile (which extracts only canon fields and excludes
    // Personality:), this view receives the entire entry — safe because the
    // output is a dead-end with no path back to live context.
    let curatedEntry = '';
    try {
        curatedEntry = await loadEntryContent(uid);
    } catch { /* ignore load errors — proceed with evidence only */ }

    // Step 3: gather optional world context (same as captureEvidence)
    const worldState = getCurrentWorldState();
    const chronicle = getLatestChronicleEntry();
    const worldContext = [
        worldState ? `<world_state>\n${worldState}\n</world_state>` : '',
        chronicle ? `<chronicle>\n${chronicle}\n</chronicle>` : '',
    ].filter(Boolean).join('\n');

    // Step 4: generate the psychoanalytic portrait
    const portrait = await generatePsychoanalyzeProfile(name, observations, curatedEntry || '', worldContext);

    return { observations, portrait, curatedEntry: curatedEntry || '' };
}

// ─── Profile persistence ─────────────────────────────────────────────────────

/**
 * Write (or overwrite) an NPC's growth profile to the NPC Profiles lorebook.
 *
 * Uses the existing `profileUid` from the registry if present (overwrites the
 * same entry); otherwise creates a new entry and records the UID. This is the
 * "regeneratable while evidence survives" property: overwriting is safe because
 * the evidence file in chat metadata is the root of truth.
 *
 * @param {string} name — NPC name
 * @param {string} profileText — profile prose
 * @returns {Promise<{success:boolean, uid?:number, error?:string}>}
 */
export async function saveProfile(name, profileText) {
    const existingUid = getProfileUid(name);
    const result = await writeProfileToLorebook(name, profileText, existingUid);
    if (result.success) {
        const recorded = setProfileUid(name, result.uid);
        stampProfileGenerated(name);

        // The lorebook write above is awaited and durable. The registry write
        // that POINTS at it goes through a debounced metadata save, so a reload
        // or chat switch inside the debounce window loses the pointer while the
        // entry survives — and the next save, seeing no uid, creates a duplicate
        // entry instead of overwriting. Flush now so the two are durable
        // together. (setProfileUid already warned if it recorded nothing.)
        if (recorded) {
            try {
                await persistChatMetaNow();
            } catch (err) {
                console.warn('[MWT:Knowledge] Could not flush profileUid immediately:', err);
            }
        }
        result.uidRecorded = recorded;
    }
    return result;
}

/**
 * Load an NPC's existing profile from the NPC Profiles lorebook (if any).
 *
 * @param {string} name — NPC name
 * @returns {Promise<string|null>}
 */
export async function loadProfile(name) {
    const uid = getProfileUid(name);
    if (uid == null) return null;
    return loadProfileContent(uid);
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Run the full growth-profile pipeline for an NPC:
 *   1. Capture behavioral evidence (observations with quote receipts)
 *   2. Append observations to the two-tier evidence store (raw[])
 *   3. Generate an anti-textbook profile from ALL accumulated evidence
 *      (consolidated first, then raw — not just the fresh capture)
 *
 * The profile is NOT auto-saved to the lorebook in this function — the caller
 * (UI) decides whether to save via saveProfile(). This keeps the human in the
 * loop: the user reviews the profile before it's persisted.
 *
 * @param {string} name — NPC name (must exist in the registry)
 * @returns {Promise<{observations: Array, profile: string, canon: string, captureStats: {added:number, skipped:number}}>}
 */
export async function runGrowthProfile(name) {
    const registry = getRegistry();
    const info = registry[name];
    if (!info) throw new Error(`"${name}" is not in the NPC registry.`);

    const uid = info.uid;
    if (uid === null || uid === undefined) {
        throw new Error(`"${name}" has no lorebook entry (orphan UID).`);
    }

    // Step 1: capture fresh evidence
    const observations = await captureEvidence(name, uid);
    if (observations.length === 0 && !hasEvidenceFile(name)) {
        throw new Error(
            `No behavioral observations found for "${name}" in recent messages. ` +
            `The NPC may not appear enough in the last ${EVIDENCE_MESSAGE_WINDOW} messages.`
        );
    }

    // Step 2: append fresh observations to the raw tier (persisted).
    // Append-only — never overwrites. Duplicate observations are skipped.
    const captureStats = appendRawObservations(name, observations);

    // Seed the capture watermark so the first continuous pass doesn't re-scan
    // these same messages (Minor fix from the capture review). The initial
    // scan covers the most recent EVIDENCE_MESSAGE_WINDOW messages; stamp the
    // watermark at the newest send_date in that span.
    {
        const chatArr = getChat() || [];
        const scanStart = Math.max(0, chatArr.length - EVIDENCE_MESSAGE_WINDOW);
        let maxScanTs = 0;
        for (let i = scanStart; i < chatArr.length; i++) {
            const t = normalizeSendDate(chatArr[i]?.send_date);
            if (t > maxScanTs) maxScanTs = t;
        }
        if (maxScanTs > 0) setCaptureWatermark(name, maxScanTs);
    }

    // Extract canon from the existing entry (NOT the Personality: line)
    let canon = '';
    try {
        const content = await loadEntryContent(uid);
        canon = extractCanonFromEntry(content);
    } catch { /* ignore */ }

    // Step 3: generate profile from ALL accumulated evidence, not just the
    // fresh capture. This means re-running growth on an NPC with existing
    // evidence incorporates older observations too. Consolidated entries
    // (Slice 3) are read first when present.
    const allEvidence = getEvidenceForProfile(name);
    if (allEvidence.length === 0) {
        throw new Error(`No evidence available to generate a profile for "${name}".`);
    }

    const profile = await generateProfile(name, allEvidence, canon);

    // If user overrides exist, append them to the generated profile so hand-
    // edits survive regeneration. (Slice 3)
    const overrides = getUserOverrides(name);
    let finalProfile = profile;
    if (overrides.length > 0) {
        const overrideText = overrides.map(o => o.text).filter(Boolean).join('\n\n');
        if (overrideText) {
            finalProfile = `${profile}\n\n--- User Notes ---\n${overrideText}`;
        }
    }

    return { observations: allEvidence, profile: finalProfile, canon, captureStats };
}

// ─── Capture-only orchestrator ───────────────────────────────────────────────

/**
 * Run evidence capture ONLY (no profile generation), watermark-gated for
 * enrolled NPCs.
 *
 * Two paths:
 *
 *   1. **First-ever capture** (no watermark yet): full EVIDENCE_MESSAGE_WINDOW
 *      bootstrap scan via captureEvidence(). Seeds the watermark so subsequent
 *      captures only process the delta.
 *
 *   2. **Subsequent captures** (watermark exists): delta-gated via
 *      runContinuousCapture() — processes only messages newer than the
 *      watermark. This prevents near-duplicate accumulation: re-scanning the
 *      same messages gives the model a fresh chance to reword claims or pick
 *      alternate quotes, which slip past the string-based dedup in
 *      appendRawObservations and pile up in raw[].
 *
 * This is the "Capture" half of runGrowthProfile, split out so the UI can
 * offer Capture and Generate as separate user-initiated actions (fixing the
 * design flaw where both fired unconditionally on modal open). Nothing is
 * generated — the caller can follow up with regenerateProfile() to synthesize
 * a profile from the now-updated evidence.
 *
 * @param {string} name — NPC name (must exist in the registry)
 * @returns {Promise<{observations: Array, captureStats: {added:number, skipped:number, deltaTooSmall?:boolean}}>}
 *   `deltaTooSmall: true` signals that no new messages were found past the
 *   watermark (enrolled NPC, nothing to capture). The caller should surface
 *   this as "already up to date" rather than an error.
 */
export async function runCaptureOnly(name) {
    const registry = getRegistry();
    const info = registry[name];
    if (!info) throw new Error(`"${name}" is not in the NPC registry.`);

    const uid = info.uid;
    if (uid === null || uid === undefined) {
        throw new Error(`"${name}" has no lorebook entry (orphan UID).`);
    }

    if (!hasValidSettings()) throw new Error('No API connection configured.');

    // ── Delta-gated path for enrolled NPCs (watermark exists) ──────────────
    //
    // Once an NPC has been captured at least once, the manual Capture Evidence
    // button processes only the delta — messages newer than the watermark —
    // instead of re-scanning the full 80-message window. This is the same
    // buildDeltaWindow logic used by continuous capture, ensuring the manual
    // and automatic paths never re-process the same messages.
    //
    // minMessages is lowered to 1 (from continuous capture's DELTA_MIN_MESSAGES
    // of 4) because this is a deliberate user action — even a single new
    // message is worth capturing if the user clicked the button.
    if (getCaptureWatermark(name) != null) {
        const deltaResult = await runContinuousCapture(name, { minMessages: 1 });
        const allEvidence = getEvidenceForProfile(name);

        if (deltaResult === null) {
            // Delta empty or too small — nothing new to capture. This is a
            // valid, non-error outcome for a user-initiated action; surface it
            // via the deltaTooSmall flag rather than throwing.
            return {
                observations: allEvidence,
                captureStats: { added: 0, skipped: 0, deltaTooSmall: true },
            };
        }

        return {
            observations: allEvidence,
            captureStats: { added: deltaResult.added, skipped: deltaResult.skipped },
        };
    }

    // ── First-ever capture: full 80-message bootstrap scan ─────────────────
    //
    // No watermark exists yet, so this is the NPC's initial capture. Scan the
    // full window to build an evidence base, then seed the watermark so the
    // next press (and continuous capture) only process the delta going forward.
    //
    // Step 1: capture fresh evidence
    const observations = await captureEvidence(name, uid);
    if (observations.length === 0 && !hasEvidenceFile(name)) {
        throw new Error(
            `No behavioral observations found for "${name}" in recent messages. ` +
            `The NPC may not appear enough in the last ${EVIDENCE_MESSAGE_WINDOW} messages.`
        );
    }

    // Step 2: append fresh observations to the raw tier (persisted).
    // Append-only — never overwrites. Duplicate observations are skipped.
    const captureStats = appendRawObservations(name, observations);

    // Seed the capture watermark so continuous capture doesn't re-scan these
    // same messages. Same logic as runGrowthProfile.
    {
        const chatArr = getChat() || [];
        const scanStart = Math.max(0, chatArr.length - EVIDENCE_MESSAGE_WINDOW);
        let maxScanTs = 0;
        for (let i = scanStart; i < chatArr.length; i++) {
            const t = normalizeSendDate(chatArr[i]?.send_date);
            if (t > maxScanTs) maxScanTs = t;
        }
        if (maxScanTs > 0) setCaptureWatermark(name, maxScanTs);
    }

    // Return ALL accumulated evidence (not just the fresh capture) so the
    // caller can re-render the full evidence list.
    const allEvidence = getEvidenceForProfile(name);
    return { observations: allEvidence, captureStats };
}

// ─── Consolidation pass (Slice 3) ────────────────────────────────────────────

/**
 * Run the consolidation API call: distill raw observations into higher-level
 * consolidated claims with source back-references.
 *
 * This reads ONLY raw evidence (never the profile, never consolidated entries).
 * The leaf invariant is preserved: consolidated claims are evidence-derived.
 *
 * @param {string} name — NPC name
 * @returns {Promise<Array<{category:string, claim:string, sources:number[], confidence?:string}>>}
 */
export async function consolidateEvidence(name) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');

    const rawForCon = getRawForConsolidation(name);
    if (rawForCon.length === 0) {
        throw new Error(`No raw observations to consolidate for "${name}". (Canon-flagged observations are excluded from consolidation.)`);
    }

    // Capture the ordered id list NOW, before the API round-trip. The user can
    // delete an observation or toggle canon during the call, shifting every
    // position after it. Threading this snapshot into applyConsolidation lets
    // it resolve source positions against the list it actually presented,
    // instead of re-deriving from a possibly-changed raw[] (item 4 fix).
    const sourceIds = rawForCon.map(o => o.id);

    // Format raw observations with their numeric IDs for the consolidator.
    const rawText = rawForCon.map(o => {
        return `[${o.numericId}] [${o.category}] ${o.claim}\n   Quote: "${o.quote}"`;
    }).join('\n');

    const userContent = [
        `<target_npc>${name}</target_npc>`,
        '',
        '<raw_observations>',
        rawText,
        '</raw_observations>',
        '',
        '='.repeat(60),
        `Consolidate the raw observations for ${name}. Output only JSON.`,
    ].join('\n');

    const rawResponse = await ktFetchFromApi(GROWTH_CONSOLIDATION_PROMPT, userContent, { retries: 1 });
    const cleaned = normaliseOutput(rawResponse);
    const result = parseJsonLenient(cleaned);

    const consolidated = Array.isArray(result.consolidated) ? result.consolidated : [];
    return { consolidated, sourceIds };
}

/**
 * Run the full consolidation pipeline for an NPC:
 *   1. Gather raw observations (excluding canon)
 *   2. API call to consolidate them into distilled claims
 *   3. Apply: append to consolidated[], archive consumed raw observations
 *
 * Repeatable: each pass distills only the raw observations captured since the
 * last one and APPENDS its claims, so earlier eras of the character survive.
 *
 * @param {string} name — NPC name
 * @returns {Promise<{consolidatedCount:number, archivedCount:number, totalConsolidated:number, consolidated:Array}>}
 *   `consolidatedCount` counts the claims added by this pass; `totalConsolidated`
 *   is the size of the tier afterwards.
 */
export async function runConsolidation(name) {
    const registry = getRegistry();
    const info = registry[name];
    if (!info) throw new Error(`"${name}" is not in the NPC registry.`);

    const { consolidated, sourceIds } = await consolidateEvidence(name);
    const stats = applyConsolidation(name, consolidated, sourceIds);

    return { ...stats, consolidated };
}

// ─── Profile regeneration from existing evidence (Slice 3) ───────────────────

/**
 * Regenerate the profile from EXISTING evidence without re-capturing.
 *
 * This reads the evidence store (consolidated first, then raw) and generates
 * a new profile. No API call to capture evidence — the user-initiated capture
 * cadence is separate. This is useful after consolidation, after editing
 * evidence, or when the user wants a fresh profile from accumulated evidence.
 *
 * @param {string} name — NPC name
 * @returns {Promise<{observations: Array, profile: string, canon: string}>}
 */
export async function regenerateProfile(name) {
    const registry = getRegistry();
    const info = registry[name];
    if (!info) throw new Error(`"${name}" is not in the NPC registry.`);

    const uid = info.uid;
    if (uid === null || uid === undefined) {
        throw new Error(`"${name}" has no lorebook entry (orphan UID).`);
    }

    const allEvidence = getEvidenceForProfile(name);
    if (allEvidence.length === 0) {
        throw new Error(`No evidence available for "${name}". Run growth capture first.`);
    }

    // Extract canon from the existing entry (NOT the Personality: line)
    let canon = '';
    try {
        const content = await loadEntryContent(uid);
        canon = extractCanonFromEntry(content);
    } catch { /* ignore */ }

    const profile = await generateProfile(name, allEvidence, canon);

    // Apply user overrides (Slice 3)
    const overrides = getUserOverrides(name);
    let finalProfile = profile;
    if (overrides.length > 0) {
        const overrideText = overrides.map(o => o.text).filter(Boolean).join('\n\n');
        if (overrideText) {
            finalProfile = `${profile}\n\n--- User Notes ---\n${overrideText}`;
        }
    }

    return { observations: allEvidence, profile: finalProfile, canon };
}

// ─── Continuous incremental capture (Part A — the primary fix) ───────────────
//
// Implements NPC_GROWTH_BLUEPRINT.md §"(A) Continuous incremental capture".
//
// Moves capture from a one-shot 80-message rescan to an append-as-you-go
// stream keyed on a `ts` watermark. On a message cadence (reuse the existing
// COUNTERS_META_KEY / npcMessageCounter), we process only the delta — messages
// newer than the watermark — and append to raw[].
//
// Summary-proof by construction: observations (verbatim quote + real ts) are
// distilled while the raw messages are live, so later summarization can't
// touch them. Works for ILS, built-in Summarize, qvink — zero coupling to any
// summarizer. Also fixes the token cost: a delta window is small, versus the
// 53–87k-token full-window rescans observed in Slice 1 testing.

/** Minimum delta size (in messages) before a continuous capture fires. Avoids
 *  spamming the API on rapid-fire exchanges with little new material. */
const DELTA_MIN_MESSAGES = 4;

/** Maximum delta size (in messages) for a single continuous capture pass.
 *  Bounds the per-call token cost. If the delta is larger (e.g. the extension
 *  was offline for a while), we process the most recent DELTA_MAX_MESSAGES. */
const DELTA_MAX_MESSAGES = 40;

/**
 * Build a formatted message string from a delta window — only messages newer
 * than the watermark. Skips ILS summary messages (they are not verbatim text)
 * and system messages.
 *
 * Returns the formatted string, the max ts among the included messages, and
 * the count of included messages. If no messages qualify, returns null.
 *
 * @param {number} sinceTs — the watermark (only messages newer than this)
 * @returns {{text:string, maxTs:number, count:number}|null}
 */
function buildDeltaWindow(sinceTs, maxMessages = DELTA_MAX_MESSAGES, minMessages = DELTA_MIN_MESSAGES) {
    const chat = getChat();
    if (!chat || !chat.length) return null;

    // Collect live (non-summary) messages newer than the watermark.
    const candidates = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || !msg.mes || msg.is_system) continue;
        // Skip ILS summaries on the continuous path — they contain paraphrased
        // text, not verbatim quotes. Backfill (Part B) handles them separately.
        if (isIlsSummary(msg)) continue;
        const ts = normalizeSendDate(msg.send_date);
        if (sinceTs != null && ts <= sinceTs) continue;
        candidates.push({ msg, idx: i, ts });
    }

    if (candidates.length < minMessages) return null;

    // Process the OLDEST `maxMessages` of the delta (A2 fix). If more than
    // the cap accrued since the last cadence fire, processing the oldest batch
    // first and advancing the watermark to its max lets the next fire continue
    // forward — no un-processed messages are leapfrogged.
    const window = candidates.slice(0, maxMessages);

    const lines = [];
    let maxTs = sinceTs ?? 0;
    for (const { msg, idx, ts } of window) {
        const name = msg.is_user ? (msg.name || 'User') : (msg.name || 'Assistant');
        const text = stripNonNarrative(msg.mes).trim();
        if (!text) continue;
        lines.push(`[${idx}] ${name}: ${text}`);
        if (ts > maxTs) maxTs = ts;
    }

    if (lines.length === 0) return null;
    return { text: lines.join('\n'), maxTs, count: lines.length };
}

/**
 * Run a continuous (incremental) evidence capture pass for a single NPC.
 *
 * Processes only the delta — messages newer than the NPC's `lastCaptureTs`
 * watermark — and appends observations to raw[]. Advances the watermark.
 *
 * This is the everyday path (Part A). It is summary-proof: observations are
 * distilled while messages are live, so later summarization can't touch them.
 *
 * Returns null if there's nothing new to capture (delta too small). Never
 * throws on "no observations found" — continuous capture is best-effort and
 * runs silently in the background.
 *
 * @param {string} name — NPC name (must exist in the registry)
 * @returns {Promise<{added:number, skipped:number, maxTs:number}|null>}
 *   null = nothing to capture (delta too small or NPC not in recent messages)
 */
export async function runContinuousCapture(name, opts = {}) {
    if (!hasValidSettings()) return null;

    const registry = getRegistry();
    const info = registry[name];
    if (!info) return null;
    const uid = info.uid;
    // An NPC without a lorebook entry yet can't have evidence captured (no
    // context to load). Skip silently.
    if (uid === null || uid === undefined) return null;

    const sinceTs = getCaptureWatermark(name);
    const delta = buildDeltaWindow(sinceTs, opts.maxMessages, opts.minMessages);
    if (!delta) return null;

    // `_retries` lets the catch-up loop disable ktFetchFromApi's own retry so
    // the retry count doesn't multiply with adaptive halving (8 calls per
    // stuck batch). Default keeps the single retry for the auto-capture path.
    const retries = opts._retries ?? 1;

    // Load existing entry as context (same as captureEvidence).
    let existingContext = '';
    try {
        const content = await loadEntryContent(uid);
        if (content) existingContext = content;
    } catch { /* ignore */ }

    const worldState = getCurrentWorldState();
    const chronicle = getLatestChronicleEntry();

    const userContent = [
        `<target_npc>${name}</target_npc>`,
        '',
        existingContext ? `<existing_context>\n${existingContext}\n</existing_context>` : '',
        worldState ? `<world_state>\n${worldState}\n</world_state>` : '',
        chronicle ? `<chronicle>\n${chronicle}\n</chronicle>` : '',
        '',
        '<recent_messages>',
        delta.text,
        '</recent_messages>',
        '',
        '='.repeat(60),
        `Extract behavioral observations about ${name} from these recent messages. Output only JSON.`,
    ].filter(Boolean).join('\n');

    const rawResponse = await ktFetchFromApi(GROWTH_EVIDENCE_PROMPT, userContent, { retries });
    const cleaned = normaliseOutput(rawResponse);
    const result = parseJsonLenient(cleaned);

    const observations = Array.isArray(result.observations) ? result.observations : [];
    const chat = getChat() || [];

    // Validate quotes (same two-stage pipeline as captureEvidence).
    const admitted = observations.filter(o =>
        o && typeof o.claim === 'string' && o.claim.trim() &&
        typeof o.quote === 'string' && o.quote.trim()
    ).map(o => {
        const quote = String(o.quote).trim();
        const citedIdx = typeof o.msgIdx === 'number' ? o.msgIdx : null;
        const matchIdx = findQuoteMatch(quote, citedIdx, chat);
        const verified = matchIdx !== -1;
        return {
            category: ['trait', 'value', 'speech'].includes(o.category) ? o.category : 'trait',
            claim: String(o.claim).trim(),
            quote,
            msgIdx: verified ? matchIdx : citedIdx,
            verified,
        };
    });

    const stats = appendRawObservations(name, admitted);

    // Advance the watermark regardless of whether observations were found —
    // the messages were processed and we don't want to re-scan them.
    setCaptureWatermark(name, delta.maxTs);

    if (stats.added > 0) {
        console.log(`[MWT:Knowledge] Continuous capture for "${name}": +${stats.added} observation(s) from ${delta.count} delta message(s).`);
    }

    return { ...stats, maxTs: delta.maxTs };
}

/**
 * Run continuous capture for ALL major NPCs with evidence files, on a message
 * cadence. Called from the knowledge module's onMessageReceived when the growth
 * counter hits its threshold.
 *
 * This is the auto-trigger entry point for Part A. It iterates major NPCs that
 * already have evidence files (the registry gate — only profiled NPCs get
 * continuous capture) and runs a delta capture for each.
 *
 * Best-effort: errors for one NPC don't stop the others. Runs in the background
 * (no UI staging).
 *
 * Per-NPC failures are CAUGHT SO THE LOOP CONTINUES, but they are also
 * REPORTED back to the caller rather than swallowed — otherwise a failure
 * (e.g. a token-limit error) is indistinguishable from "found nothing", and the
 * caller would notify the user that a failed run completed cleanly.
 *
 * `attempted` lets the caller distinguish "ran and found nothing" from "no
 * eligible NPCs, nothing ran at all".
 *
 * @returns {Promise<{
 *   results: {npc:string, added:number}[],
 *   errors: {npc:string, message:string, isLength:boolean}[],
 *   attempted: number
 * }>}
 */
export async function runContinuousCaptureAll() {
    const registry = getRegistry();
    const results = [];
    const errors = [];
    let attempted = 0;

    for (const [name, info] of Object.entries(registry)) {
        // Only major NPCs with existing evidence files get continuous capture.
        // Minor NPCs or those without a profile yet are skipped (registry gate).
        if (info.type !== 'major') continue;
        if (!hasEvidenceFile(name)) continue;
        attempted++;
        try {
            const res = await runContinuousCapture(name);
            if (res && res.added > 0) results.push({ npc: name, added: res.added });
        } catch (err) {
            console.warn(`[MWT:Knowledge] Continuous capture for "${name}" failed:`, err.message);
            errors.push({
                npc: name,
                message: err?.message || String(err),
                isLength: !!err?._isLengthError,
            });
        }
    }

    if (results.length > 0) {
        const total = results.reduce((s, r) => s + r.added, 0);
        console.log(`[MWT:Knowledge] Continuous capture: +${total} observation(s) across ${results.length} NPC(s).`);
    }
    if (errors.length > 0) {
        console.warn(`[MWT:Knowledge] Continuous capture: ${errors.length} NPC(s) failed — ${errors.map(e => e.npc).join(', ')}.`);
    }
    return { results, errors, attempted };
}

// ─── ILS de-summarize backfill (Part B — bounded, one-time) ─────────────────
//
// Implements NPC_GROWTH_BLUEPRINT.md §"(B) ILS de-summarize backfill".
//
// Continuous capture (Part A) can't retroactively cover history summarized
// BEFORE it was active. For that, we expand ILS summary messages back to their
// originals and capture from the verbatim text.
//
// This is a BOUNDED, ONE-TIME op — never per-turn. Expansion re-inflates
// exactly the tokens ILS compressed; a full de-summarized scan is the 87k
// problem amplified. Continuous capture (A) is the everyday path; (B) is for
// backfilling old summarized history.

/**
 * Run a one-time ILS de-summarize backfill capture for a single NPC.
 *
 * Expands ILS summary messages to their verbatim originals (from
 * chatMetadata.ILS_Originals), then captures behavioral evidence from the
 * de-summarized window. Observations are appended to raw[] and the watermark
 * is advanced to cover the backfilled span.
 *
 * READ-ONLY with respect to ILS data: this never writes to or GCs
 * ILS_Originals. It only reads originals from chat metadata.
 *
 * Use this when:
 *   - A chat was summarized before continuous capture (Part A) was active
 *   - You want to recover evidence from the now-hidden original messages
 *
 * @param {string} name — NPC name (must exist in the registry)
 * @param {object} [opts]
 * @param {number} [opts.maxMessages=80] — cap on total de-summarized messages
 * @returns {Promise<{added:number, skipped:number, expandedSummaries:number, maxTs:number}|null>}
 */
export async function runIlsBackfillCapture(name, opts = {}) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');

    const registry = getRegistry();
    const info = registry[name];
    if (!info) throw new Error(`"${name}" is not in the NPC registry.`);
    const uid = info.uid;
    if (uid === null || uid === undefined) {
        throw new Error(`"${name}" has no lorebook entry (orphan UID).`);
    }

    const { maxMessages = EVIDENCE_MESSAGE_WINDOW, _retries = 1 } = opts;
    const chat = getChat();
    if (!chat || !chat.length) throw new Error('No chat messages.');

    const chatMeta = getChatMeta();

    // B1 fix: do NOT lower-bound the expansion by the capture watermark.
    // Backfill exists to recover OLD summarized history, which is *older* than
    // the watermark — filtering it out defeats the purpose. Expand the full
    // de-summarized history and rely on appendRawObservations' dedup
    // (normalizeKey on claim+quote) to skip overlap with already-captured
    // recent messages.
    const expanded = expandIlsSummaries(chat, chatMeta, { sinceTs: null });

    // Count how many summaries were expanded (for reporting).
    const summaryIndices = new Set();
    for (let i = 0; i < chat.length; i++) {
        if (isIlsSummary(chat[i])) summaryIndices.add(i);
    }

    if (expanded.length === 0) {
        return { added: 0, skipped: 0, expandedSummaries: summaryIndices.size, maxTs: getBackfillWatermark(name) ?? 0 };
    }

    // B2 fix: walk forward in bounded batches. Sort by the real send_date so
    // the forward walk is chronological (expanded originals carry their own ts,
    // which may predate their array position). Then advance from the backfill
    // watermark — a separate forward-walking cursor, NOT the capture watermark
    // (which is a high-water mark on recent messages and would freeze backfill
    // in place via setCaptureWatermark's monotonic-only rule).
    const sorted = [...expanded].sort((a, b) => a.ts - b.ts);
    const backfillWm = getBackfillWatermark(name);
    const pending = backfillWm != null
        ? sorted.filter(e => e.ts > backfillWm)
        : sorted;

    if (pending.length === 0) {
        return { added: 0, skipped: 0, expandedSummaries: summaryIndices.size, maxTs: backfillWm ?? 0 };
    }

    // Process the OLDEST `maxMessages` of the pending set. Advancing the
    // backfill watermark only across this batch means repeat runs continue
    // forward rather than leapfrogging the remainder.
    const window = pending.slice(0, maxMessages);

    // Build the formatted message string for the evidence prompt. We use the
    // ORIGINAL message text (verbatim), not the summary. The idx is synthetic
    // (points at the summary position, not the original array position) — this
    // is consistent with the blueprint's "ts canonical, msgIdx diagnostic" rule.
    //
    // Compute maxTs across ALL entries in the window (not just those that
    // produce non-empty lines) so a batch that's entirely OOC/empty after
    // stripping still advances the watermark. Otherwise the next run re-
    // selects the same batch, strips it to nothing again, and Catch Up's
    // phase 1 sees no watermark movement — a permanent hard stop (item 6 fix).
    const lines = [];
    let maxTs = backfillWm ?? 0;
    for (const entry of window) {
        // Advance the watermark across every entry in the batch, even those
        // that produce no line — they WERE processed, there was just nothing
        // quotable in them.
        if (entry.ts > maxTs) maxTs = entry.ts;
        const msg = entry.msg;
        if (!msg || !msg.mes || msg.is_system) continue;
        const name2 = msg.is_user ? (msg.name || 'User') : (msg.name || 'Assistant');
        const text = stripNonNarrative(msg.mes).trim();
        if (!text) continue;
        // Mark expanded originals so the user can distinguish them in logs.
        const tag = entry.fromSummary ? '[restored]' : '';
        lines.push(`${tag}[${entry.idx}] ${name2}: ${text}`);
    }

    if (lines.length === 0) {
        // No quotable text survived stripping — but the batch WAS processed.
        // Advance the watermark so the next run continues forward instead of
        // re-selecting and re-rejecting the same empty batch forever (item 6).
        setBackfillWatermark(name, maxTs);
        return { added: 0, skipped: 0, expandedSummaries: summaryIndices.size, maxTs };
    }

    // Load existing entry as context.
    let existingContext = '';
    try {
        const content = await loadEntryContent(uid);
        if (content) existingContext = content;
    } catch { /* ignore */ }

    const worldState = getCurrentWorldState();
    const chronicle = getLatestChronicleEntry();

    const userContent = [
        `<target_npc>${name}</target_npc>`,
        '',
        existingContext ? `<existing_context>\n${existingContext}\n</existing_context>` : '',
        worldState ? `<world_state>\n${worldState}\n</world_state>` : '',
        chronicle ? `<chronicle>\n${chronicle}\n</chronicle>` : '',
        '',
        '<messages>',
        lines.join('\n'),
        '</messages>',
        '',
        '='.repeat(60),
        `Extract behavioral observations about ${name} from these messages. Output only JSON.`,
    ].filter(Boolean).join('\n');

    const rawResponse = await ktFetchFromApi(GROWTH_EVIDENCE_PROMPT, userContent, { retries: _retries });
    const cleaned = normaliseOutput(rawResponse);
    const result = parseJsonLenient(cleaned);

    const observations = Array.isArray(result.observations) ? result.observations : [];

    // For backfill, quote verification searches both the live chat and the
    // expanded window (originals may not be at their cited indices — they came
    // from inside summaries).
    const expandedMessages = window.map(e => e.msg);
    const admitted = observations.filter(o =>
        o && typeof o.claim === 'string' && o.claim.trim() &&
        typeof o.quote === 'string' && o.quote.trim()
    ).map(o => {
        const quote = String(o.quote).trim();
        const citedIdx = typeof o.msgIdx === 'number' ? o.msgIdx : null;

        // Try the live chat first (the quote might be from a non-summary msg).
        const liveIdx = findQuoteMatch(quote, citedIdx, chat);
        if (liveIdx !== -1) {
            // Found in live chat — the index is valid, ts will be extracted
            // from chat[liveIdx].send_date by appendRawObservations.
            return {
                category: ['trait', 'value', 'speech'].includes(o.category) ? o.category : 'trait',
                claim: String(o.claim).trim(),
                quote,
                msgIdx: liveIdx,
                verified: true,
            };
        }

        // Not in live chat — search the expanded originals.
        const expandedIdx = findQuoteMatch(quote, null, expandedMessages);
        if (expandedIdx !== -1) {
            // B3 fix: the expanded-array index is meaningless as a live index.
            // Thread the real ts (entry.ts = the original's send_date, preserved
            // by ils_compat) and set msgIdx = null — exactly the "msgIdx
            // null/synthetic under expansion" constraint.
            return {
                category: ['trait', 'value', 'speech'].includes(o.category) ? o.category : 'trait',
                claim: String(o.claim).trim(),
                quote,
                msgIdx: null,
                ts: window[expandedIdx].ts,
                verified: true,
            };
        }

        // Unverified — keep the model's cited index for traceability.
        return {
            category: ['trait', 'value', 'speech'].includes(o.category) ? o.category : 'trait',
            claim: String(o.claim).trim(),
            quote,
            msgIdx: citedIdx,
            verified: false,
        };
    });

    const stats = appendRawObservations(name, admitted);
    // Advance the backfill watermark (not the capture watermark) across this
    // batch only, so repeat runs continue forward through the remaining history.
    setBackfillWatermark(name, maxTs);

    console.log(
        `[MWT:Knowledge] ILS backfill for "${name}": expanded ${summaryIndices.size} summary(ies) to ${lines.length} ` +
        `original(s), +${stats.added} observation(s).`
    );

    return { ...stats, expandedSummaries: summaryIndices.size, maxTs };
}

// ─── Catch-up: loop backfill + continuous capture until current ──────────────
//
// A user-initiated "read everything until caught up" pass. Loops the bounded
// backfill (Part B) through ALL summarized history, then loops continuous
// capture (Part A) through ALL live messages, until both watermarks can no
// longer advance. Each iteration is one API call; the loop terminates when a
// batch makes no forward progress (watermark unchanged) or a hard safety cap
// is reached.
//
// This complements the single-batch Backfill button: instead of clicking it
// repeatedly to walk through history 80 messages at a time, Catch Up does the
// whole walk in one action and fires a notification when done.

/** Hard safety cap on the number of API-call batches per phase. At 80 (backfill)
 *  or 40 (continuous) messages per batch this allows ~40k messages — far beyond
 *  any real chat — while guaranteeing the loop can never run away. */
const CATCHUP_MAX_BATCHES = 500;

/** Minimum batch size for adaptive halving. When a backfill or live batch fails
 *  with a token-limit error, the batch size is halved and retried. This floor
 *  prevents it from collapsing to 1 (which would be extremely slow). The halving
 *  sequence from 80 is: 80 → 40 → 20 → 10 (3 halvings), then it gives up. */
const ADAPTIVE_MIN_BATCH = 10;

/** Number of consecutive successful batches before the batch size grows back up
 *  (doubled, capped at the original max) after a shrink. Prevents a single rich
 *  patch from permanently crippling throughput for the rest of a long catch-up
 *  run — standard AIMD (additive increase, multiplicative decrease). */
const SUCCESSES_BEFORE_GROW = 3;

/**
 * Run a full catch-up pass for an NPC: loop backfill through all summarized
 * history, then loop continuous capture through all live messages, until both
 * watermarks have caught up to the current chat.
 *
 * Phase 1 (backfill) walks the `lastBackfillTs` cursor forward through ILS-
 * de-summarized history in bounded batches. Phase 2 (live) walks the
 * `lastCaptureTs` high-water mark forward through non-summarized messages.
 * The loop ends when a batch's watermark doesn't advance (nothing left to
 * process) or the delta drops below `DELTA_MIN_MESSAGES`.
 *
 * Best-effort across batches: if one batch throws, the loop stops but the
 * evidence captured so far (and the watermarks advanced so far) are retained —
 * partial progress is never lost.
 *
 * @param {string} name — NPC name (must exist in the registry)
 * @param {(progress:{phase:string, batch:number, added:number, skipped:number, batchAdded:number, maxTs:number, errors?:number})=>void} [onProgress]
 *   optional callback fired after each batch for UI progress reporting
 * @returns {Promise<{added:number, skipped:number, batches:number, backfillBatches:number, liveBatches:number, errors:string[], stoppedOnError:boolean, errorPhase:?string}>}
 *   `errorPhase` = 'backfill' | 'live' | null — names which phase stopped,
 *   so the UI can phrase the message chronologically (e.g. "error in
 *   backfill, then +N from live messages" vs the old "+N then stopped on
 *   error" which read backwards when Phase 1 failed but Phase 2 succeeded).
 */
export async function runCatchUpCapture(name, onProgress) {
    if (!hasValidSettings()) throw new Error('No API connection configured.');

    const registry = getRegistry();
    const info = registry[name];
    if (!info) throw new Error(`"${name}" is not in the NPC registry.`);
    const uid = info.uid;
    if (uid === null || uid === undefined) {
        throw new Error(`"${name}" has no lorebook entry (orphan UID).`);
    }

    let totalAdded = 0;
    let totalSkipped = 0;
    let backfillBatches = 0;
    let liveBatches = 0;
    const errors = [];
    let stoppedOnError = false;
    let errorPhase = null; // 'backfill' | 'live' | null — which phase stopped.

    // Adaptive halving is the ONLY retry mechanism inside catch-up. Each
    // underlying call passes `_retries: 0` to ktFetchFromApi so the API-level
    // retry doesn't multiply with halving (otherwise a stuck batch costs up to
    // 8 full-size calls — 2 retries × 4 halving steps — each carrying the full
    // constant overhead). Reasoning-model non-determinism is exploited by the
    // halving itself: a smaller batch is likelier to finish within budget.

    // ── Phase 1: Loop ILS backfill until the backfill watermark catches up ──
    //
    // Each call processes the oldest batch of summarized history and advances
    // the forward-walking `lastBackfillTs` cursor. The loop ends when the
    // watermark stops advancing (= no more pending history to process) or the
    // safety cap is hit.
    //
    // On a token-limit (length) error, the batch size is halved and retried
    // (adaptive halving). Reasoning models are non-deterministic — a batch of
    // 80 messages that spiraled past the token budget will often succeed as two
    // batches of 40. This lets catch-up push through rich content that would
    // otherwise dead-end the whole run.
    //
    // AIMD recovery: after SUCCESSES_BEFORE_GROW consecutive successes the
    // batch size doubles (capped at the original max). This stops a single
    // rich patch from permanently crippling throughput for the rest of a long
    // run — without it, a 1000-message backfill stuck at batch size 10 would
    // take ~100 calls instead of ~13.
    {
        let prevTs = getBackfillWatermark(name) ?? 0;
        let batchSize = EVIDENCE_MESSAGE_WINDOW;
        let successes = 0;
        for (let i = 0; i < CATCHUP_MAX_BATCHES; i++) {
            let result;
            try {
                result = await runIlsBackfillCapture(name, { maxMessages: batchSize, _retries: 0 });
            } catch (err) {
                // Length error → halve the batch and retry the SAME messages.
                // The watermark hasn't advanced (the error happens before
                // setBackfillWatermark), so a smaller batch re-attempts the
                // oldest pending messages.
                successes = 0; // reset AIMD success streak
                if (err._isLengthError && batchSize > ADAPTIVE_MIN_BATCH) {
                    const halved = Math.max(ADAPTIVE_MIN_BATCH, Math.floor(batchSize / 2));
                    console.warn(
                        `[MWT:Knowledge] Catch-up backfill batch ${i + 1} hit token limit at ${batchSize} msgs. ` +
                        `Halving to ${halved} and retrying.`
                    );
                    batchSize = halved;
                    i--; // don't consume a loop iteration for the retry
                    continue;
                }
                // Non-length error, or already at minimum batch size — record
                // and stop the phase. Partial progress (prior batches + their
                // watermark advances) is retained.
                console.warn(`[MWT:Knowledge] Catch-up backfill batch ${i + 1} failed:`, err.message);
                errors.push(`Backfill batch ${i + 1}: ${err.message}`);
                stoppedOnError = true;
                errorPhase = 'backfill';
                break;
            }
            totalAdded += result.added || 0;
            totalSkipped += result.skipped || 0;
            backfillBatches++;
            // AIMD: grow the batch back up after a streak of successes so a
            // one-off rich patch doesn't shrink the whole run.
            if (++successes >= SUCCESSES_BEFORE_GROW) {
                const grown = Math.min(EVIDENCE_MESSAGE_WINDOW, batchSize * 2);
                if (grown > batchSize) {
                    console.log(`[MWT:Knowledge] Catch-up backfill: ${successes} successes, growing batch ${batchSize} → ${grown}.`);
                    batchSize = grown;
                }
                successes = 0;
            }
            if (onProgress) onProgress({
                phase: 'backfill',
                batch: backfillBatches,
                added: totalAdded,
                skipped: totalSkipped,
                batchAdded: result.added || 0,
                maxTs: result.maxTs || 0,
                errors: errors.length,
            });
            // Watermark didn't advance → caught up (or no summaries exist).
            const curTs = result.maxTs || 0;
            if (curTs <= prevTs) break;
            prevTs = curTs;
        }
    }

    // ── Phase 2: Loop continuous capture until the live delta is exhausted ──
    //
    // runContinuousCapture returns null when the delta is too small
    // (< DELTA_MIN_MESSAGES) — that means we're within a few messages of "now"
    // and further batches would be noise. The remaining stragglers are picked
    // up by the next regular capture or the auto-capture cadence.
    //
    // Same adaptive-halving + AIMD strategy as Phase 1 on length errors.
    {
        let batchSize = DELTA_MAX_MESSAGES;
        let successes = 0;
        for (let i = 0; i < CATCHUP_MAX_BATCHES; i++) {
            let result;
            try {
                result = await runContinuousCapture(name, { maxMessages: batchSize, _retries: 0 });
            } catch (err) {
                successes = 0;
                if (err._isLengthError && batchSize > ADAPTIVE_MIN_BATCH) {
                    const halved = Math.max(ADAPTIVE_MIN_BATCH, Math.floor(batchSize / 2));
                    console.warn(
                        `[MWT:Knowledge] Catch-up live batch ${i + 1} hit token limit at ${batchSize} msgs. ` +
                        `Halving to ${halved} and retrying.`
                    );
                    batchSize = halved;
                    i--;
                    continue;
                }
                console.warn(`[MWT:Knowledge] Catch-up live batch ${i + 1} failed:`, err.message);
                errors.push(`Live batch ${i + 1}: ${err.message}`);
                stoppedOnError = true;
                errorPhase = 'live';
                break;
            }
            if (!result) break; // delta too small or nothing to capture
            totalAdded += result.added || 0;
            totalSkipped += result.skipped || 0;
            liveBatches++;
            // AIMD grow (same as Phase 1).
            if (++successes >= SUCCESSES_BEFORE_GROW) {
                const grown = Math.min(DELTA_MAX_MESSAGES, batchSize * 2);
                if (grown > batchSize) {
                    console.log(`[MWT:Knowledge] Catch-up live: ${successes} successes, growing batch ${batchSize} → ${grown}.`);
                    batchSize = grown;
                }
                successes = 0;
            }
            if (onProgress) onProgress({
                phase: 'live',
                batch: liveBatches,
                added: totalAdded,
                skipped: totalSkipped,
                batchAdded: result.added || 0,
                maxTs: result.maxTs || 0,
                errors: errors.length,
            });
        }
    }

    console.log(
        `[MWT:Knowledge] Catch-up for "${name}": ${backfillBatches} backfill batch(es), ` +
        `${liveBatches} live batch(es), +${totalAdded} observation(s), ${totalSkipped} duplicate(s)` +
        (errors.length > 0 ? `, ${errors.length} error(s).` : '.')
    );

    return {
        added: totalAdded,
        skipped: totalSkipped,
        batches: backfillBatches + liveBatches,
        backfillBatches,
        liveBatches,
        errors,
        stoppedOnError,
        errorPhase,
    };
}
