/**
 * knowledge/growth.js — NPC Growth Profile: evidence capture + generation.
 *
 * Implements Slices 1 & 2 of NPC_GROWTH_BLUEPRINT.md: a user-initiated
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
 * The one rule everything obeys: **the profile is a LEAF, never a ROOT.**
 * Evidence flows one direction (messages → observations → profile). The
 * profile never feeds back into capture or synthesis.
 */

import {
    getChat, stripNonNarrative, getCurrentWorldState,
    getLatestChronicleEntry, normaliseOutput, parseJsonLenient,
} from '../core/index.js';
import { hasValidSettings } from './settings.js';
import { getRegistry, getProfileUid, setProfileUid } from './registry.js';
import { loadEntryContent, loadProfileContent, writeProfileToLorebook, ktFetchFromApi } from './lorebook.js';
import {
    appendRawObservations, getEvidenceForProfile, stampProfileGenerated,
    hasEvidenceFile,
} from './evidence.js';
import { GROWTH_EVIDENCE_PROMPT, GROWTH_PROFILE_PROMPT } from './prompts.js';

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
        setProfileUid(name, result.uid);
        stampProfileGenerated(name);
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

    return { observations: allEvidence, profile, canon, captureStats };
}
