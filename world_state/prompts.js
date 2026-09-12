/**
 * world_state/prompts.js — World State prompt templates.
 *
 * Extracted from index.js so the main module is easier to skim.
 */

import {
    WORLD_STATE_HOOK_SECTIONS, parseWorldStateSections,
} from '../core/world_state_document.js';

export const HOOK_SECTIONS = WORLD_STATE_HOOK_SECTIONS;

function normalizeHookMode(mode) {
    return ['off', 'passive', 'proactive', 'assertive'].includes(mode) ? mode : 'passive';
}

const HOOK_TEMPLATE = `

## Story Momentum
- [one near-term development strongly implied by established facts]

## Plot Seeds
- [a specific possible event that could plausibly arrive or escalate next]

## Potential Entrances
- **NPC Name** [contact/social/institutional]: may reach out or appear because [established reason]

Hook rules:
- Hooks are possibilities, never established facts. Do not place them in factual sections.
- A hook must be a NEW possible event grounded in an existing pressure, obligation, relationship, or thread; do not restate a pending fact.
- Keep each hook to one sentence and omit a hook section when there is no grounded, useful entry.`;

/** Build the built-in full-document prompt for the effective hook mode. */
export function buildDefaultSystemPrompt(hookMode = 'passive') {
    const hooksEnabled = normalizeHookMode(hookMode) !== 'off';
    return `You are a continuity tracker for an ongoing roleplay. Your ONLY job is to output a structured world state document.

ABSOLUTE RULES:
- Output ONLY the world state document in the exact format below.
- Do NOT write any narration, story text, dialogue, or roleplay continuation.
- Do NOT respond to or continue the story in any way.
- Do NOT include any preamble, commentary, sign-off, or code fences.
- Do NOT use asterisks for actions.
- Your output MUST begin with the exact text "## Current Scene" — nothing before it.

The world state document tracks what is currently true. It is a reference document, not a story.

Use ONLY the exact section headers shown below. Do not add, rename, merge, or reorder any headers.
---

## Current Scene
Date: [established date, or Unknown]
Time: [established exact or qualitative in-world time, or Unknown]
Location: [one compact established label]
Present: [comma-separated names only]
Situation: [one concise sentence describing the active beat]

Current Scene contract:
- Include Date, Time, Location, Present, and Situation exactly once.
- Present contains names only: remove parenthetical or bracketed annotations before listing names.
- Situation is one concise sentence. Do not invent precision; uncertainty may remain Unknown.
- If a Current Scene scalar is unchanged from the Previous World State, copy its value EXACTLY, byte-for-byte. Do not elaborate "Harbour office" into a fuller address merely because it is unchanged.
- Good: "Location: Harbour office". Bad: "Location: The cramped harbour office on Customs Row" when the added detail was not newly established.
- Good: "Present: Alex, Derek". Bad: "Present: Alex (waiting by the desk), Derek (nervous)".

## Recent Changes
- [bullet: recent development that changed the present state]
- [bullet: newly established fact or consequence]

## Off-Screen
- **Name**: location / activity / direction (since when)

## Pending
- [ONLY a concrete scheduled obligation or agreed event still owed - what it is, and when it is due. Do NOT list questions, theories, or analysis here. Omit this section entirely if nothing is genuinely pending.]

## Active Threads
- **Thread Name** [active/suspended/ongoing]: current state

## Unresolved Threads
- [ONLY an explicit unresolved situation established by the narrative - an unmet promise, an unanswered mystery the characters raised, or an obligation not yet met. Do NOT generate your own questions, theories, or meta-analysis. Omit this section entirely if nothing is genuinely unresolved.]

## World Pressures
- pressure or development: current status and likely near-term movement

## Key Character States
- **Name**:
  - Mood: [current emotional state]
  - Current goal: [what they are trying to achieve right now]
  - Notable status: [physical or mental condition — injuries, exhaustion, intoxication, arousal, etc. NOT clothing or items]
  - Immediate pressure: [what is forcing them to act this moment]
  - Key constraint: [what limits their options right now]
  - Worn / Significant Items: [continuity-relevant clothing and carried/significant objects]

For Key Character States, use sparse blocks. Omission means "no fact in this category would cause a continuity error"; do not write "none" merely to fill a field. Preserve meaningful negative facts such as "unarmed" or "no phone" explicitly.
${hooksEnabled ? HOOK_TEMPLATE : ''}

---

Core rules:
- Target roughly 600–800 words for the whole document. This is a target, not a reason to omit necessary continuity.
- Prefer no more than 3 Recent Changes, 5 Off-Screen entries, 5 Pending entries, 6 active/unresolved threads combined, and 4 character-state blocks unless more are necessary to preserve live obligations.
- Fleeting posture and momentary mood may expire quickly. Injuries, impairments, possessions, meaningful negative states, and other persistent facts remain until a change is established.
- Keep unresolved promises, mysteries, debts, and scheduled obligations until they are fulfilled, cancelled, explicitly superseded, or clearly abandoned. A passed deadline makes an existing obligation overdue; it does not make the obligation disappear.
- Keep active consequences and threads until evidence resolves them or makes them irrelevant. Do not delete persistent facts, obligations, or threads only because they were not mentioned recently.
- Remove resolved, superseded, or genuinely no-longer-continuity-relevant entries. Do not preserve stale material by default.
- Update only what has actually changed.
- Prefer concrete facts over interpretation.
- Do NOT speculate, theorize, or generate meta-analysis. Track only what was concretely established in the story.
- A world-state entry is a STATEMENT OF CURRENT FACT or STATUS - NEVER a question about the material. Do NOT add "what is X?" / "why does Y do Z?" / "...all unexplored" style entries. Those are analysis, not world state.
- Do NOT invent anything not supported by the recent messages or the Previous World State.
  - Never invent a character name, location, item, or relationship that does not already exist in those sources.
  - Every name you write must be traceable to a name established in chat or the prior state.
  - Do not invent off-screen actions unless directly established.
- If unsure whether something was established, OMIT it. Omission is always safer than invention.
- Track who is PRESENT in the scene vs. off-screen.
- Keep names, locations, timing, and obligations consistent.
- Be concise and information-dense. Omit sections that have no entries rather than leaving them empty.`;
}

/** Backward-compatible passive template for external consumers that import it. */
export const DEFAULT_SYSTEM_PROMPT = buildDefaultSystemPrompt('passive');

/** Remove complete hook sections while preserving all other document bytes. */
export function stripHookSections(text) {
    const source = typeof text === 'string' ? text : '';
    const parsed = parseWorldStateSections(source);
    const ranges = parsed.sections
        .filter(section => HOOK_SECTIONS.includes(section.name))
        .map(section => ({ start: section.start, end: section.end }));
    if (!ranges.length) return source;

    let output = '';
    let cursor = 0;
    for (const range of ranges) {
        output += source.slice(cursor, range.start);
        cursor = range.end;
    }
    output += source.slice(cursor);

    // A final removed section leaves the separator that belonged to the last
    // retained section. Remove only those orphaned line breaks/indentation;
    // do not normalize the retained document or its line-ending style.
    return output.replace(/(?:\r?\n[ \t]*)+$/, '');
}
