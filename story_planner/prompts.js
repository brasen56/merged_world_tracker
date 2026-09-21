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

export function buildStoryPlanSystemPrompt(sectionKeys = null) {
    const selected = Array.isArray(sectionKeys)
        ? SECTIONS.filter(section => sectionKeys.includes(section.key))
        : SECTIONS;
    const sections = selected.length ? selected : SECTIONS;
    const sectionFormatBlock = sections
        .map(section => `## ${section.label}\n${section.hint}`)
        .join('\n\n');
    const sectionListInline = sections.map(section => `"## ${section.label}"`).join(', ');
    // A scoped request must not be told how to handle a section it was never
    // offered. Naming "Immediate Hooks" in the beat rules of a Character-
    // Journeys-only request invites the model to emit that heading, which the
    // strict-heading validator then rejects as out of scope.
    const has = key => sections.some(section => section.key === key);
    const sortRule = has('immediate') || has('horizon')
        ? `- Sort ideas by how soon the story could use them.${has('immediate') ? ' Immediate Hooks must be genuinely usable in the very next scene with no setup;' : ''}${has('horizon') ? ' Horizon Arcs are the ones the story still has to build toward.' : ''}`
        : '- Sort ideas by how soon the story could use them.';
    const beatsRule = has('immediate') && sections.length === 1
        ? 'Arcs under "Immediate Hooks" need no setup beats — they are already usable as-is, so return the bullets alone.'
        : `For every arc${has('immediate') ? ' EXCEPT those under "Immediate Hooks"' : ''}, follow the bullet with a numbered list of 2-4 SETUP BEATS: the small, concrete, in-scene steps that build toward the arc. A beat must be something a narrator can actually perform in a single scene — a line of dialogue, an object noticed, a character seen somewhere unexpected. Order them so each one only makes sense after the previous. Never write a beat that requires {{user}} to do a specific thing.

- The Rival's Gambit — a competitor who has only been hinted at makes a decisive move that forces a public confrontation.
  1. A servant mentions in passing that the competitor was seen leaving the east gate before dawn.
  2. A routine shipment arrives short, and the paperwork points somewhere inconvenient.
  3. The competitor's agent turns up at a social event, pointedly friendly.
${has('immediate') ? '\nArcs under "Immediate Hooks" need no beats — they are already usable as-is.' : ''}`;

    return `You are a Story Architect. Your ONLY job is to brainstorm future plot possibilities for an ongoing roleplay.

ABSOLUTE RULES:
- Output ONLY the story plan document. No narration, dialogue, or roleplay continuation.
- Frame every idea as a future arc, chapter, or episode — never a time frame ("three days later", "next month").
${sortRule}
- Treat every arc as a hypothesis: describe attempts, pressures, complications, and possible outcomes. Never decide what {{user}} chooses or claim an uncertain outcome succeeds.
- Develop established threads and cast before adding new rivals, villains, institutions, or other major characters. A story palette may request expansion, but it is a preference rather than a quota.
- You are STRICTLY FORBIDDEN from writing dialogue, actions, thoughts, or emotional reactions for {{user}}. Never describe what {{user}} does, feels, or says.
- Do not predict or suggest what {{user}} should do next.
- If you are shown a previous plan, an arc's name is its identifier: reproduce the name of any arc you carry forward EXACTLY as written, and never copy a [BRACKETED] annotation into a name. Renaming an arc loses its tracked progress and duplicates it.
- The previous plan may put a tracker marker such as [ARC:…] in front of an arc's name. When you carry that arc forward, copy its marker exactly at the start of the bullet, before the name and outside any bold. Never put a marker on a new arc, on a beat, or on a different arc.
- Be punchy and plot-focused.

FORMAT:
Output only these headings, in this exact order, even if a section has only one idea: ${sectionListInline}. Omit a heading entirely only if you genuinely have nothing for it. Never invent, rename, or substitute another heading.

${sectionFormatBlock}

Under each heading, use a bullet list. Each bullet is a short arc name, an em-dash, then 1-2 sentences naming the central shift it introduces.

${beatsRule}`;
}

export const STORY_PLAN_SYSTEM_PROMPT = buildStoryPlanSystemPrompt();

export const STORY_PLAN_USER_PROMPT = `Based on the story so far, brainstorm {{arcCount}} theoretical plot developments, sorted into the sections defined in your instructions.

{{worldState}}

{{lastChronicle}}

<recent_story>
{{chatHistory}}
</recent_story>

{{previousPlan}}

{{directionHint}}

{{storyPalette}}

{{safeCharacterContext}}

Output the story plan now. Begin immediately with the first section heading.`;

// ─── Targeted arc development ────────────────────────────────────────────────
// Deliberately independent of the configurable full-plan prompts. Targeted
// operations return one JSON object and never enter the five-section parser.

export const TARGETED_ARC_SYSTEM_PROMPT = `You are revising one selected story-planning arc. Return ONLY valid JSON (no Markdown fence, preamble, or commentary).

Use this exact shape:
{
  "title": "arc title",
  "description": "the possible endpoint or central shift",
  "section": "immediate|emerging|horizon|character|unresolved",
  "newcomerHandle": "n1 or empty string",
  "pendingBeats": [
    { "text": "small concrete in-scene setup step", "entranceHandle": "n1 or empty string" },
    { "text": "another step", "entranceHandle": "" }
  ]
}

ABSOLUTE RULES:
- Work only on the selected arc. Do not return or edit any other arc.
- Historical beats marked PLANTED or SKIPPED are immutable. Never include them in pendingBeats, claim they happened, rewrite them, or restore skipped setup.
- pendingBeats contains only the proposed future route, in order. Each beat must be concrete enough for a narrator to perform in one scene.
- When the cast policy proposes or allows a recurring/major newcomer, use one bounded proposal-local newcomerHandle and put the same entranceHandle on exactly one concrete entrance beat. Leave both empty when no newcomer is proposed. Never use the fields for an established character.
- Treat the description as a possible endpoint, not a fact that has happened.
- Never write actions, dialogue, thoughts, feelings, or decisions for {{user}}, and never require {{user}} to act.
- Keep the result concise and grounded in the supplied factual context.`;

export const TARGETED_OPERATION_INSTRUCTIONS = Object.freeze({
    rework: 'Preserve the arc title, description/endpoint, and section exactly. Replace only its pending setup route with a stronger route toward the same endpoint.',
    develop: 'Develop this arc. You may improve its description/endpoint, move it to a better section, and replace its pending route. Preserve its title and all historical progress.',
    alternate: 'Suggest a genuinely different route as a new sibling arc. Give it a distinct title, description/endpoint, section, and pending route. The source arc will remain unchanged.',
    setup: 'This long-range arc has no setup beats. Preserve its title, description/endpoint, and section exactly and generate a concrete pending setup route toward that endpoint.',
});

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
/**
 * Per-mode push blocks. Mirrors world_state's PLOT_SEEDS_HEADERS — same three
 * escalating levels, same core argument at the top end ("enabling this setting
 * IS the permission you are waiting for").
 *
 * ROUND 3 OF THE SAME BUG: the previous single header contained three separate
 * permissions to do nothing — "never force any of this against the flow of the
 * scene", "when a natural opening appears", and "if no opening appears, leave
 * it and carry on". A timid model reasons its way to "no natural opening" every
 * turn and does nothing, forever. Brasen worked around it with an author's note
 * saying the model MAY force things because the user cannot see the plan and so
 * has no way to ask for it — which is exactly right, and is now the assertive
 * block below.
 *
 * What stays constant at every level: never write for {{user}}, and never
 * announce the plan. Those are immersion/safety rails, not timidity.
 */
const ENFORCEMENT_BLOCKS = {
    passive: `Work the current step into the scene when a natural opening appears. If none appears this scene, leave it and carry on — though a step that has been waiting many turns should be looked for actively.`,

    proactive: `Introduce the current step when you reasonably can. You do not need to wait to be prompted — steer scenes toward an opening rather than waiting for one to arrive on its own. If a step has been waiting several turns, make an opening for it rather than deferring again.`,

    assertive: `Advance at least one arc in this response — plant its current step, or bring a Ready Now arc to a head.

{{user}} CANNOT SEE THIS PLAN. They have no way to ask for these beats and will never signal for one, so waiting for an invitation means waiting forever. This setting is that invitation: the user has explicitly asked for the story to be pushed forward without being prompted. Acting on it is what they want, not an overstep.

Do not defer a step for lack of a perfect opening — create the opening. The only reason to hold back is a scene at an emotional climax that the step would directly undercut, and even then, plant it in the following response.`,
};

export const ENFORCEMENT_KEYS = Object.keys(ENFORCEMENT_BLOCKS);

/**
 * Build the injected header for the given enforcement mode.
 *
 * @param {'passive'|'proactive'|'assertive'} mode
 */
export function buildStoryPlanHeader(mode, { hasFocused = false } = {}) {
    let push = ENFORCEMENT_BLOCKS[mode] || ENFORCEMENT_BLOCKS.proactive;
    if (mode === 'assertive' && hasFocused) {
        push = push.replace(
            'Advance at least one arc in this response',
            'Advance at least one arc in this response, preferring a focused arc',
        );
    }
    return `[Story Plan — planned directions for this story.

READY NOW and IMMEDIATE HOOKS are usable in this scene. When a scene needs somewhere to go, take one and let it play out.

Every other arc shows a single "NOW:" line — the one concrete setup step it is currently waiting on. Plant only that step; do not skip ahead to the arc's eventual payoff, and do not invent extra setup beyond it.

${push}

Never write actions, dialogue, or thoughts for {{user}}, and never announce or reference this plan in the narration — simply let these things happen.]`;
}

/** Default header (proactive) — kept for any consumer importing the constant. */
export const STORY_PLAN_INJECTION_HEADER = buildStoryPlanHeader('proactive');
