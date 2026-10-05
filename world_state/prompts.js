/**
 * world_state/prompts.js — World State prompt templates.
 *
 * Extracted from index.js so the main module is easier to skim.
 */

import {
    WORLD_STATE_HOOK_SECTIONS, WORLD_STATE_PLOT_SEED_CATEGORIES,
    isWorldStateHookSection, parseWorldStateSections,
} from '../core/world_state_document.js';
import { DEFAULT_DETAIL_LEVEL, normalizeDetailLevel } from './settings.js';

export const HOOK_SECTIONS = WORLD_STATE_HOOK_SECTIONS;

function normalizeHookMode(mode) {
    return ['off', 'passive', 'proactive', 'assertive'].includes(mode) ? mode : 'passive';
}

const HOOK_TEMPLATE = `

## Story Momentum
- [one near-term development strongly implied by established facts]

## Plot Seeds
- [category] [a specific NEW event that could plausibly arrive or escalate next]

## Potential Entrances
- **NPC Name** [pick one: contact, social, institutional]: may reach out or appear because [established reason]

Hook rules:
- Hooks are possibilities, never established facts. Do not place them in factual sections.
- A hook must be a NEW possible event grounded in an existing pressure, obligation, relationship, or thread; do not restate a pending fact.
- Keep each hook to one sentence and omit a hook section when there is no grounded, useful entry.

Plot Seeds rules:
- category is exactly one of: ${WORLD_STATE_PLOT_SEED_CATEGORIES.join(', ')}. Always keep the brackets. "[event]" is not a category.
- A seed is a WHAT IF — something that has NOT happened yet. Never a recap, quote, or paraphrase of Recent Chat, and never a restatement of a known pending fact.
- Prefer 2–4 seeds and omit the section entirely when nothing is grounded.
- BAD:  - [event] "I am the manager now" is said tonight.
- GOOD: - [institutional] The guild auditor arrives before Alex can file the delayed manifest.`;

// ─── Detail levels ───────────────────────────────────────────────────────────
//
// Each level supplies its own factual section templates (everything after
// Current Scene, which is shared) and its own size targets. The rules that
// keep continuity safe — retention, one home per fact, the item rule, the
// overflow priority, no invention — are shared, so a smaller level means less
// repetition, never less memory.

const PENDING_TEMPLATE = `## Pending
- [ONLY a concrete scheduled obligation or agreed event still owed - what it is, and when it is due. Do NOT list questions, theories, or analysis here. Omit this section entirely if nothing is genuinely pending.]`;

const UNRESOLVED_TEMPLATE = `## Unresolved Threads
- [ONLY an explicit unresolved situation established by the narrative - an unmet promise, an unanswered mystery the characters raised, or an obligation not yet met. Do NOT generate your own questions, theories, or meta-analysis. Omit this section entirely if nothing is genuinely unresolved.]`;

const NEGATIVE_FACTS_RULE = 'Preserve meaningful negative facts such as "unarmed" or "no phone" explicitly.';

const DETAIL_PROFILES = Object.freeze({
    minimal: {
        omits: ['Recent Changes'],
        sections: `## Off-Screen
- **Name**: where they are and what they are doing

${PENDING_TEMPLATE}

## Active Threads
- **Thread Name** [active/suspended/ongoing]: current state in one short clause

${UNRESOLVED_TEMPLATE}

## World Pressures
- pressure: current status

## Key Character States
- **Name**: [condition and limits; continuity-critical items; a mood or relationship ONLY when it changes what happens next]

For Key Character States, write ONE line per character. Combine an item and its consequence into one phrase ("Wrists bound; cannot use hands") rather than repeating it. Omit routine mood, posture, clothing, and inferred goals. Omit a character entirely when nothing about them would cause a continuity error. ${NEGATIVE_FACTS_RULE}`,
        sizeRules: `- Target roughly 250–400 words for the whole document. This is a target, not a reason to omit necessary continuity.
- Prefer no more than 3 Off-Screen entries, 3 Pending entries, 3 active/unresolved threads combined, and 2 World Pressures unless more are necessary to preserve live obligations.
- Keep every bullet and every character entry to one line. Add a clause only when leaving it out would cause a continuity error.
- Minimal means less repetition, not less memory: never drop an injury, debt, possession, obligation, or meaningful negative fact to save space.`,
    },
    standard: {
        omits: [],
        sections: `## Recent Changes
- [bullet: recent development that changed the present state]

## Off-Screen
- **Name**: location / activity / direction (since when)

${PENDING_TEMPLATE}

## Active Threads
- **Thread Name** [active/suspended/ongoing]: current state in one short clause

${UNRESOLVED_TEMPLATE}

## World Pressures
- pressure or development: current status and likely near-term movement

## Key Character States
- **Name**:
  - Mood: [one or two words]
  - Goal: [what they want right now, under 10 words]
  - Condition: [injuries, impairments, restraints, or other hard limits on what they can do]
  - Items: [up to 4 continuity-critical items — see the item rule]

For Key Character States, use sparse blocks: omit a field when nothing in it would cause a continuity error, and do not write "none" merely to fill it. Condition holds both the physical state and the limit it causes — write "Wrists bound; cannot use hands" once, not again under Items. ${NEGATIVE_FACTS_RULE}`,
        sizeRules: `- Target roughly 400–550 words for the whole document. This is a target, not a reason to omit necessary continuity.
- Prefer no more than 2 Recent Changes, 3 Off-Screen entries, 4 Pending entries, 4 active/unresolved threads combined, 2 World Pressures, and 4 character-state blocks unless more are necessary to preserve live obligations.
- Keep every bullet to one line.`,
    },
    detailed: {
        omits: [],
        sections: `## Recent Changes
- [bullet: recent development that changed the present state]
- [bullet: newly established fact or consequence]

## Off-Screen
- **Name**: location / activity / direction (since when)

${PENDING_TEMPLATE}

## Active Threads
- **Thread Name** [active/suspended/ongoing]: current state

${UNRESOLVED_TEMPLATE}

## World Pressures
- pressure or development: current status and likely near-term movement

## Key Character States
- **Name**:
  - Mood: [current emotional state]
  - Current goal: [what they are trying to achieve right now]
  - Notable status: [physical or mental condition — injuries, exhaustion, intoxication, arousal, etc. NOT clothing or items]
  - Immediate pressure: [what is forcing them to act this moment]
  - Key constraint: [what limits their options right now]
  - Worn / Significant Items: [continuity-critical clothing and carried objects only — see the item rule]

For Key Character States, use sparse blocks. Omission means "no fact in this category would cause a continuity error"; do not write "none" merely to fill a field. State each fact under one field only. ${NEGATIVE_FACTS_RULE}`,
        sizeRules: `- Target roughly 600–800 words for the whole document. This is a target, not a reason to omit necessary continuity.
- Prefer no more than 3 Recent Changes, 5 Off-Screen entries, 5 Pending entries, 6 active/unresolved threads combined, and 4 character-state blocks unless more are necessary to preserve live obligations.`,
    },
});

function detailProfile(level) {
    return DETAIL_PROFILES[normalizeDetailLevel(level)];
}

/**
 * Does this detail level's template define the section? Minimal drops Recent
 * Changes: the narrator already has the recent chat, so the section is mostly
 * a recap. Only meaningful for the built-in prompt — a Custom Prompt defines
 * its own sections.
 */
export function detailLevelIncludesSection(level, sectionName) {
    return !detailProfile(level).omits.includes(sectionName);
}

const ITEM_RULE = 'Item rule: list an item only if forgetting it would cause a continuity error — weapons, keys, phones, money, documents, restraints, disguises, or clothing that was removed, damaged, or made plot-relevant. Never list ordinary clothing, accessories, or incidental props.';

function buildOneHomeRules(profile) {
    const recentChanges = profile.omits.includes('Recent Changes')
        ? ''
        : '\n- Recent Changes records what just happened in a few words; its lasting result belongs in its home section.';
    return `- Each fact has ONE home. Do not restate an obligation, thread, or condition in a second section.
- Route each fact to the FIRST home that fits: due at a specific time or agreed date → Pending. An unmet promise, debt, or mystery the story raised → Unresolved Threads. An ongoing storyline → Active Threads. An outside force or development bearing down → World Pressures. A character's condition, limits, or possessions → Key Character States.${recentChanges}
- When a section is over its limit: first remove resolved or stale entries, then merge related entries. Never drop an unresolved obligation, injury, possession, or meaningful negative fact just to fit.`;
}

/** Build the built-in full-document prompt for the effective hook mode and detail level. */
export function buildDefaultSystemPrompt(hookMode = 'passive', detailLevel = DEFAULT_DETAIL_LEVEL) {
    const hooksEnabled = normalizeHookMode(hookMode) !== 'off';
    const profile = detailProfile(detailLevel);
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

${profile.sections}

${ITEM_RULE}
${hooksEnabled ? HOOK_TEMPLATE : ''}

---

Core rules:
${profile.sizeRules}
${buildOneHomeRules(profile)}
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
        .filter(section => isWorldStateHookSection(section.name))
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
