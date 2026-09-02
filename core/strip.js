/**
 * core/strip.js — Shared message-stripping utility.
 *
 * Removes non-narrative blocks from message text before it is fed to
 * scanner/LLM calls. This prevents preset tracker details and old chatter
 * blocks from "laundering" into world state, chronicle, knowledge, or
 * interiority contexts. [In-story time: …] tags are deliberately kept — they
 * are the canonical in-story clock and scanners need them (see below).
 *
 * EXCEPTION: Off-Screen Events module blocks (details blocks whose summary
 * says "Off-Screen Events") are preserved BY DEFAULT — they record completed
 * off-screen NPC actions, which are real in-world events the interiority
 * tracker needs as execution evidence (and world state / chronicle / story
 * planner ingest as history).
 *
 * The exception is an explicit per-consumer option (`preserveOffScreen`).
 * Consumers whose prompts carry no actor/witness partition rules for the
 * sealed block must opt OUT: every Knowledge call site passes
 * `{ preserveOffScreen: false }`, because its scan/update prompts would
 * otherwise record an unwitnessed off-screen event mentioning an NPC as
 * knowledge that NPC learned (ledger contamination).
 *
 * Used by:
 *   - world_state/refresh.js      (preserve — history ingest)
 *   - chronicle/data.js           (preserve — history ingest)
 *   - story_planner/generation.js (preserve — planning context)
 *   - interiority/generation.js   (preserve — execution evidence)
 *   - knowledge/lorebook.js       (STRIP — no actor/witness semantics)
 *   - knowledge/growth.js         (STRIP — no actor/witness semantics)
 *   - knowledge/relationships.js  (STRIP — no actor/witness semantics)
 */

/**
 * Strip non-narrative blocks from a message text string.
 *
 * Removes:
 *   - `<details>…</details>` blocks (preset trackers, old chatter)
 *     EXCEPTION: blocks whose `<summary>` identifies them as the Off-Screen
 *     Events module are preserved by default — completed off-screen NPC
 *     actions are real in-world events the trackers must see. Pass
 *     `{ preserveOffScreen: false }` to strip them too (Knowledge does).
 *   - `<!-- GFX_START -->…<!-- GFX_END -->` blocks
 *
 * Preserves `[In-story time: …]` tags (canonical in-story clock).
 *
 * Collapses excessive whitespace left behind by removals.
 *
 * @param {string} text — raw message text (e.g. `msg.mes`)
 * @param {object} [opts]
 * @param {boolean} [opts.preserveOffScreen=true] — keep Off-Screen Events
 *   module blocks (the actor/witness-sealed log). Consumers whose prompts
 *   carry no partition rules for that block (Knowledge) must pass false so a
 *   sealed event can never be recorded as knowledge an NPC never learned.
 * @returns {string} stripped text
 */
export function stripNonNarrative(text, { preserveOffScreen = true } = {}) {
    if (!text || typeof text !== 'string') return text || '';

    let out = text;

    // 1. Remove <details>…</details> blocks (non-greedy, case-insensitive).
    //    Preset trackers and old chatter live inside these collapsible blocks.
    //    EXCEPTION — Off-Screen Events module blocks are preserved (unless the
    //    consumer opts out via preserveOffScreen:false): they log completed
    //    off-screen NPC actions (real in-world events) that the interiority
    //    tracker must see to mark ledger intentions executed, and that world
    //    state / chronicle ingest as history. Consumers whose prompts don't
    //    understand the block's actor/witness semantics (Knowledge) strip it
    //    like any other details block, so an unwitnessed event mentioning an
    //    NPC can never be recorded as knowledge that NPC learned.
    //    The block is identified by its SUMMARY only, so a legacy Scene
    //    State tracker with an "Off-Screen:" body section still strips.
    out = out.replace(/<details\b[\s\S]*?<\/details>/gi, (block) => {
        if (!preserveOffScreen) return '';
        const summaryMatch = block.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
        return summaryMatch && /off[-\s]?screen/i.test(summaryMatch[1]) ? block : '';
    });

    // 2. Remove <!-- GFX_START -->…<!-- GFX_END --> blocks (image-gen markers).
    out = out.replace(/<!--\s*GFX_START\s*-->[\s\S]*?<!--\s*GFX_END\s*-->/gi, '');

    // NOTE: [In-story time: …] tags are intentionally preserved. They are the
    // only authoritative source of the in-story clock, and scanners (esp. the
    // world-state tracker) need them to populate time/date fields correctly.

    // Collapse 3+ consecutive newlines into 2, and trim.
    out = out.replace(/\n{3,}/g, '\n\n').trim();

    return out;
}

/**
 * Strip non-narrative blocks from a "Name: text" formatted message string.
 * Preserves the speaker name prefix; only strips the body.
 *
 * This is useful when the input comes from getRecentMessages() which
 * already formats messages as "Name: text" lines.
 *
 * @param {string} formattedLine — e.g. "Mara: Hello there <details>…</details>"
 * @param {object} [opts] — forwarded to stripNonNarrative (e.g.
 *   `{ preserveOffScreen: false }` for Knowledge consumers)
 * @returns {string} — e.g. "Mara: Hello there"
 */
export function stripNonNarrativeFromFormatted(formattedLine, opts = {}) {
    if (!formattedLine) return formattedLine || '';
    const colonIdx = formattedLine.indexOf(': ');
    if (colonIdx === -1) return stripNonNarrative(formattedLine, opts);
    const name = formattedLine.slice(0, colonIdx);
    const body = formattedLine.slice(colonIdx + 2);
    return `${name}: ${stripNonNarrative(body, opts)}`;
}