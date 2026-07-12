/**
 * core/strip.js — Shared message-stripping utility.
 *
 * Removes non-narrative blocks from message text before it is fed to
 * scanner/LLM calls. This prevents preset tracker details, old chatter
 * blocks, and in-story time tags from "laundering" into world state,
 * chronicle, knowledge, or interiority contexts.
 *
 * Used by:
 *   - world_state/refresh.js
 *   - chronicle/data.js
 *   - knowledge/lorebook.js
 *   - story_planner/generation.js
 *   - interiority/generation.js
 */

/**
 * Strip non-narrative blocks from a message text string.
 *
 * Removes:
 *   - `<details>…</details>` blocks (preset trackers, old chatter)
 *   - `<!-- GFX_START -->…<!-- GFX_END -->` blocks
 *   - `[In-story time: …]` tags
 *
 * Collapses excessive whitespace left behind by removals.
 *
 * @param {string} text — raw message text (e.g. `msg.mes`)
 * @returns {string} stripped text
 */
export function stripNonNarrative(text) {
    if (!text || typeof text !== 'string') return text || '';

    let out = text;

    // 1. Remove <details>…</details> blocks (non-greedy, case-insensitive).
    //    Preset trackers and old chatter live inside these collapsible blocks.
    out = out.replace(/<details\b[\s\S]*?<\/details>/gi, '');

    // 2. Remove <!-- GFX_START -->…<!-- GFX_END --> blocks (image-gen markers).
    out = out.replace(/<!--\s*GFX_START\s*-->[\s\S]*?<!--\s*GFX_END\s*-->/gi, '');

    // 3. Remove [In-story time: …] tags (bracketed time markers).
    out = out.replace(/\[In-story time:\s*[^\]]*\]/gi, '');

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
 * @returns {string} — e.g. "Mara: Hello there"
 */
export function stripNonNarrativeFromFormatted(formattedLine) {
    if (!formattedLine) return formattedLine || '';
    const colonIdx = formattedLine.indexOf(': ');
    if (colonIdx === -1) return stripNonNarrative(formattedLine);
    const name = formattedLine.slice(0, colonIdx);
    const body = formattedLine.slice(colonIdx + 2);
    return `${name}: ${stripNonNarrative(body)}`;
}