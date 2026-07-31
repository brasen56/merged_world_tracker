/**
 * story_planner/prompts.js — Story Planner prompt templates.
 *
 * Re-written from scratch for MWT (not derived from any third-party code).
 * The goal is a flexible "story architect" prompt that produces plot
 * possibilities sorted by how soon the story can actually use them.
 *
 * Section headings are generated from data.js's SECTIONS so the prompt, the
 * parser, and the UI can never disagree about what a section is called.
 */

import { SECTIONS } from './data.js';

// ─── Section format block (derived — do not hand-write headings) ─────────────

const SECTION_FORMAT_BLOCK = SECTIONS
    .map(s => `## ${s.label}\n${s.hint}`)
    .join('\n\n');

const SECTION_LIST_INLINE = SECTIONS.map(s => `"## ${s.label}"`).join(', ');

export const STORY_PLAN_SYSTEM_PROMPT = `You are a Story Architect. Your ONLY job is to brainstorm future plot possibilities for an ongoing roleplay.

ABSOLUTE RULES:
- Output ONLY the story plan document. No narration, dialogue, or roleplay continuation.
- Frame every idea as a future arc, chapter, or episode — never a time frame ("three days later", "next month").
- Sort ideas by how soon the story could use them. Immediate Hooks must be genuinely usable in the very next scene with no setup; Horizon Arcs are the ones the story still has to build toward.
- Focus on major plot shifts, new character introductions, and escalating conflicts.
- You are STRICTLY FORBIDDEN from writing dialogue, actions, thoughts, or emotional reactions for {{user}}. Never describe what {{user}} does, feels, or says.
- Do not predict or suggest what {{user}} should do next.
- Be punchy and plot-focused.

FORMAT:
Output these headings in this exact order, even if a section has only one idea: ${SECTION_LIST_INLINE}. Omit a heading entirely only if you genuinely have nothing for it.

${SECTION_FORMAT_BLOCK}

Under each heading, use a bullet list. Each bullet is a short arc name, an em-dash, then 1-2 sentences naming the central shift it introduces:

- The Rival's Gambit — a competitor who has only been hinted at makes a decisive move that forces a public confrontation.`;

export const STORY_PLAN_USER_PROMPT = `Based on the story so far, brainstorm {{arcCount}} theoretical plot developments, sorted into the sections defined in your instructions.

{{worldState}}

{{lastChronicle}}

<recent_story>
{{chatHistory}}
</recent_story>

{{previousPlan}}

{{directionHint}}

Output the story plan now. Begin immediately with the first section heading.`;

// ─── Injection header ────────────────────────────────────────────────────────

/**
 * Header prepended to the injected plan.
 *
 * DELIBERATE FRAMING: the previous version told the model these were "not
 * fixed events" and "not mandatory or predetermined" — which, combined with a
 * flat undifferentiated list, gave the narrator no reason to ever act on any of
 * it. The plan was being read and then correctly ignored. This version keeps
 * the "menu, not a script" spirit for the long-range sections but gives the
 * model explicit permission to actually use the immediate ones.
 */
export const STORY_PLAN_INJECTION_HEADER = `[Story Plan — planned directions for this story, ordered by how soon they can be used.

Immediate Hooks are ready now: when a scene needs somewhere to go, introduce one and let it play out naturally.
Emerging Arcs, Horizon Arcs, Character Journeys, and Unresolved Threads are longer-range groundwork — steer toward them gradually and plant setup for them where it fits.

Never force one in against the flow of the scene, and never announce or reference this plan in the narration.]`;
