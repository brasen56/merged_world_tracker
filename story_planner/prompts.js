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

Under each heading, use a bullet list. Each bullet is a short arc name, an em-dash, then 1-2 sentences naming the central shift it introduces.

For every arc EXCEPT those under "Immediate Hooks", follow the bullet with a numbered list of 2-4 SETUP BEATS: the small, concrete, in-scene steps that build toward the arc. A beat must be something a narrator can actually perform in a single scene — a line of dialogue, an object noticed, a character seen somewhere unexpected. Order them so each one only makes sense after the previous. Never write a beat that requires {{user}} to do a specific thing.

- The Rival's Gambit — a competitor who has only been hinted at makes a decisive move that forces a public confrontation.
  1. A servant mentions in passing that the competitor was seen leaving the east gate before dawn.
  2. A routine shipment arrives short, and the paperwork points somewhere inconvenient.
  3. The competitor's agent turns up at a social event, pointedly friendly.

Arcs under "Immediate Hooks" need no beats — they are already usable as-is.`;

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
 * TWO FRAMING BUGS FIXED HERE, IN ORDER:
 *
 * 1. The original said these were "not mandatory or predetermined", which
 *    combined with a flat list gave the narrator no reason to act on any of it.
 *    It read the plan and correctly ignored it.
 *
 * 2. The fix for (1) said the non-immediate sections were "longer-range
 *    groundwork — plant setup for them where it fits". That is a permanent
 *    deferral instruction with no graduation condition, and no definition of
 *    what planting setup looks like. Testing confirmed the model parsed it
 *    exactly as written ("I should be planting setup, not triggering them yet")
 *    and then deferred forever, because nothing ever said "now".
 *
 * The mechanism that actually fixes (2) is the beat: each long-range arc shows
 * ONE concrete next step, and the narrator is asked to work in that step —
 * not to invent setup, and not to jump to the arc's endpoint. Arcs whose beats
 * are all planted graduate into "Ready Now", which is the "now" signal that
 * was missing.
 */
export const STORY_PLAN_INJECTION_HEADER = `[Story Plan — planned directions for this story.

READY NOW and IMMEDIATE HOOKS are usable in this scene. When a scene needs somewhere to go, take one and let it play out.

Every other arc shows a single "NOW:" line — the one concrete setup step it is currently waiting on. Work that step into the scene when a natural opening appears. Plant only the current step; do not skip ahead to the arc's eventual payoff, and do not invent extra setup beyond it. If no opening appears this scene, leave it and carry on — but a step marked as waiting many turns should be looked for actively.

Never force any of this against the flow of the scene, never write actions or dialogue for {{user}}, and never announce or reference this plan in the narration.]`;
