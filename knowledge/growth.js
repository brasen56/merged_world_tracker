/**
 * knowledge/growth.js — NPC Growth Profile: evidence capture + generation.
 *
 * Implements Slice 1 of NPC_GROWTH_BLUEPRINT.md: a one-shot, user-initiated
 * "Generate growth profile" pass that:
 *
 *   1. Captures behavioral observations (with verbatim quote receipts) from
 *      recent chat messages about a target NPC.
 *   2. Generates an anti-textbook character profile FROM those observations
 *      — never from the prior profile or the existing Personality: line.
 *
 * The one rule everything obeys: **the profile is a LEAF, never a ROOT.**
 * Evidence flows one direction (messages → observations → profile). The
 * profile never feeds back into capture or synthesis.
 *
 * Slice 1 does NOT persist the evidence file — observations and profile are
 * returned for display in a modal. Slice 2 adds the two-tier evidence store
 * (raw + consolidated) in chat metadata.
 */

import {
    getChat, stripNonNarrative, getCurrentWorldState,
    getLatestChronicleEntry, normaliseOutput, parseJsonLenient,
} from '../core/index.js';
import { hasValidSettings } from './settings.js';
import { getRegistry } from './registry.js';
import { loadEntryContent, ktFetchFromApi } from './lorebook.js';
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

    // Validate: every observation must have a non-empty claim and quote.
    // Unanchored observations are inadmissible per the blueprint's anchoring
    // guardrail. Drop them rather than failing the whole pass.
    return observations.filter(o =>
        o && typeof o.claim === 'string' && o.claim.trim() &&
        typeof o.quote === 'string' && o.quote.trim()
    ).map(o => ({
        category: ['trait', 'value', 'speech'].includes(o.category) ? o.category : 'trait',
        claim: String(o.claim).trim(),
        quote: String(o.quote).trim(),
        msgIdx: typeof o.msgIdx === 'number' ? o.msgIdx : null,
    }));
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
    // quote receipt.
    const evidenceText = observations.map((o, i) =>
        `${i + 1}. [${o.category}] ${o.claim}\n   Quote: "${o.quote}"${o.msgIdx != null ? ` (msg ${o.msgIdx})` : ''}`
    ).join('\n');

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

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Run the full growth-profile pipeline for an NPC:
 *   1. Capture behavioral evidence (observations with quote receipts)
 *   2. Generate an anti-textbook profile from the evidence
 *
 * @param {string} name — NPC name (must exist in the registry)
 * @returns {Promise<{observations: Array, profile: string, canon: string}>}
 */
export async function runGrowthProfile(name) {
    const registry = getRegistry();
    const info = registry[name];
    if (!info) throw new Error(`"${name}" is not in the NPC registry.`);

    const uid = info.uid;
    if (uid === null || uid === undefined) {
        throw new Error(`"${name}" has no lorebook entry (orphan UID).`);
    }

    // Step 1: capture evidence
    const observations = await captureEvidence(name, uid);
    if (observations.length === 0) {
        throw new Error(
            `No behavioral observations found for "${name}" in recent messages. ` +
            `The NPC may not appear enough in the last ${EVIDENCE_MESSAGE_WINDOW} messages.`
        );
    }

    // Extract canon from the existing entry (NOT the Personality: line)
    let canon = '';
    try {
        const content = await loadEntryContent(uid);
        canon = extractCanonFromEntry(content);
    } catch { /* ignore */ }

    // Step 2: generate profile from evidence
    const profile = await generateProfile(name, observations, canon);

    return { observations, profile, canon };
}