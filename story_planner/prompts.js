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

import { MAX_CONTINUITY_BEATS_PER_ARC, SECTIONS } from './data.js';

// ─── Arc quality rules (V3 Phase 5) ──────────────────────────────────────────
// Shared by the full-plan and targeted prompts so the two cannot drift.
//
// Testers reported bland plans: four beats re-demonstrating one trait, or
// beats that were pure logistics (a fax, a pinned sheet, a rental meter). Both
// were BEAT failures — the destination language the Character Journey clause
// already carried did not catch them, because the only beat rule was "order
// them so each one only makes sense after the previous", which interchangeable
// demonstrations satisfy trivially.
//
// The turning point belongs in the description, never in a beat: the
// description is what Ready Now surfaces as the payoff once setup is complete.
// A beat that performs the climax leaves Ready nothing to do.
//
// Phase 5 follow-up (Direction Hint trials, 2026-10): plans still met the
// rules in form — "the pressure between gratitude and unease threatens to
// crack his composure" names a pressure and a turning point without naming an
// event. Two trial hints each produced NPC-driven beats. One that asked for "a
// scene you could stage" over-scripted the payoff (props, timer) and acted it
// out in the last beat, so the destination names the encounter but must not
// stage it. Beats are checked by what they change for someone, not by banning
// kinds of beat: a delivery or a document is fine when it changes something.

// Second trial (GLM 5.3, 2026-10-08): beats were NPC-driven, but both plans
// hedged — beats offering "a letter, a call, or a question" instead of one
// event, beats that were a choice someone "faces", and descriptions ending in
// "whether X or Y is the question". The stakes clause asks for something that
// can be won or lost, and the no-staging clause is limited to the turning
// point so it cannot be read as permission to leave beats vague.
export const ARC_DESTINATION_RULE = 'An arc proposes a new playable situation, not another illustration of an established trait. In one or two sentences (under 50 words), its description names what someone wants or what is unsettled, the specific person, problem, opportunity, or discovery that makes it newly consequential now, and the encounter it builds toward — a confrontation, revelation, offer, admission, boundary, or decision that could go more than one way — and what concretely could be gained or lost. Name the encounter but do not stage it: leave the setting details, props, and outcome of that encounter to the scene. "Trust is tested", "composure cracks", "must choose between X and Y", or "whether X or Y is the question" say what a scene would mean, not what happens in it. A quiet arc can turn on an admission, a boundary, a discovery, or a changed relationship; it does not need to escalate.';

export const BEAT_PROGRESSION_RULE = 'Build setup as a causal sequence: each beat changes the conditions for the next. Each beat commits to one specific event that happens, not a list of alternatives and not a choice someone faces. After a beat, someone should know, want, risk, owe, or have available something they did not before. Setup is not foreshadowing: a reminder, a mood, or the same emotion shown again does not count, and neither does moving paperwork, schedules, or equipment without consequence. An arrival, a document, or a discovery is fine when it changes something. Two strong beats are better than four padded ones. Stop short of the turning point itself: the payoff happens once setup is complete, not inside a beat.';

// ─── Player agency and grounding (shared) ────────────────────────────────────
// The prompt used to forbid writing for {{user}} five different ways and never
// said what NPCs MAY do with them. Models read that as "keep {{user}} out of
// the beats", so relationship journeys became an NPC alone with props. The
// permission is the point of this rule; the last sentence keeps it from
// turning into "{{user}} agreed" one beat later.
//
// The actor test was added after GLM 5.3 wrote player-performed beats ("Alex
// discovers the discrepancy herself", "Alex admits at a meal…"). A ban on
// writing for {{user}} did not stop those; a check on who performs each beat
// is one the model can apply sentence by sentence. The model is told who
// {{user}} is by the <player_character> block (generation.js).

export const PLAYER_AGENCY_RULE = '{{user}} is the player\'s character (named in <player_character> when given) and belongs to the player. Never write {{user}}\'s actions, words, thoughts, feelings, discoveries, or choices, and never suggest what {{user}} should do. Someone other than {{user}} performs every beat: if a beat needs {{user}} to do, notice, admit, or decide something, rewrite it as what an NPC does or what the world puts in front of {{user}}. NPCs may still initiate with {{user}}: ask questions, make offers or demands, disclose information, set boundaries, or try to influence them. That is often the strongest kind of beat. Describe the NPC\'s move and what is at stake, leave {{user}}\'s response and the outcome open, and never write a later beat that assumes {{user}} accepted, agreed, attended, or complied.';

// Testers saw two unrelated threads merged because they sat near each other in
// the context, and a character given a skill their canon says they lack.
export const STORY_GROUNDING_RULE = 'Stay inside established canon. Keep existing relationships between people, projects, and obligations as the story has them, and never invent past events or a character\'s skills, history, or relationships. Two threads that appear near each other in the context are not connected unless the story says so. A new connection or fact must arrive through a future event in the arc, not be asserted as existing history.';

// ─── World-pressure lens (scoped planning lens) ──────────────────────────────
//
// The base prompt frames every idea as something a person wants or unsettles:
// the destination rule's encounter list is interpersonal (confrontation,
// revelation, offer, admission), the cast rule asks for threads and cast, and
// both worked examples are someone's scheme. "Let the world itself act on the
// characters" — weather, scarcity, infrastructure, money, institutions — has
// no lane in that framing, so a scoped request can carry the world-pressure
// lens. The lens swaps those framings; PLAYER_AGENCY and STORY_GROUNDING
// apply unchanged (the world puts things in front of {{user}} without ever
// deciding their reaction, and a complication must be one the established
// setting can actually produce — grounding works for this lens, not against
// it).

export const WORLD_PRESSURE_RULE = 'A world complication is the setting acting on the story: weather and seasons, natural events, scarcity and abundance, infrastructure and utilities, money and markets, law and institutions, public celebrations, discoveries, illness, public mood, or a distant event that reaches this place. The initiating development must be general: an external condition, or a decision by an institution or group that applies to everyone it reaches — a toll, a ration, a festival, a new law. A plan by a particular person or group to get something from particular people is a scheme, not a world development, even when the cast is not its target; leave it out. Characters may pursue their own interests in response. Read the recent story for the routine that has set in — the same place, the same activity loop, the comfortable rhythm — and propose developments that break that routine, not the story\'s premise. Developments may be adverse, beneficial, or mixed: an opening route, a bumper harvest, a public celebration, or a discovery can make the world active without a crisis. Do not turn every opportunity into a hidden threat or require a hardship quota. Every development must be one the established setting can actually produce: derive it from the place, season, economy, or dependencies already in the context, never from a genre the story has not claimed. It earns its place by changing what someone can do, keep, reach, afford, or safely assume — name what it opens, enables, threatens, takes away, or reorders. Scale it to the escalation preference, if one is given: a restrained story gets a closed road or a small windfall, not a catastrophe or a fortune.';

export const ARC_DESTINATION_RULE_WORLD = 'An arc proposes a new playable situation, not another illustration of an established trait. In one or two sentences (under 50 words), its description names the routine or expectations the development changes, the specific external condition or systemic change that makes it newly consequential now, and the playable opening or disruption it builds toward — an arrival, discovery, public event, new access, offer, deadline, shortage, or changed arrangement that could go more than one way — and what concretely could be gained, lost, or made possible. Name the opening or disruption but do not stage it: leave the details and the outcome to the scene. "Tension rises", "times get harder", "things become difficult", "must choose between X and Y", or "whether X or Y is the question" say what a scene would mean, not what happens in it. A beneficial development needs consequential options, not an invented danger to justify it. A small development that changes real options beats a spectacle that changes nothing.';

// ─── Section format block (derived — do not hand-write headings) ─────────────

export function buildStoryPlanSystemPrompt(sectionKeys = null, lens = 'open') {
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
    const hooksOnly = has('immediate') && sections.length === 1;
    // World-pressure lens: swap the NPC-centric framings (destination
    // language, beat actor, worked examples, cast-development rule) while
    // every structural rule — agency, grounding, beats, format, headings —
    // stays exactly as the open lens has it.
    const worldPressure = lens === 'world-pressure';
    const sortRule = has('immediate') || has('horizon')
        ? `- Sort ideas by how soon the story could use them.${has('immediate') ? ' Immediate Hooks must be genuinely usable in the very next scene with no setup;' : ''}${has('horizon') ? ' Horizon Arcs are the ones the story still has to build toward.' : ''}`
        : '- Sort ideas by how soon the story could use them.';
    // Hooks need no setup and have no turning point to build toward, so a
    // Hooks-only request keeps the plain one-line description.
    const destinationRule = worldPressure ? ARC_DESTINATION_RULE_WORLD : ARC_DESTINATION_RULE;
    const bulletRule = hooksOnly
        ? 'Each bullet is a short arc name, an em-dash, then 1-2 sentences naming the central shift it introduces.'
        : `Each bullet is a short arc name, an em-dash, then its description. ${destinationRule}${has('immediate') ? ' An Immediate Hook can simply name a live opening the next scene can use.' : ''}`;
    // The worked examples are invented and deliberately unlike each other (an
    // external plot, a quiet relationship) so no single beat shape gets copied.
    // The previous single example's beats (a servant mentions something, a
    // shipment arrives with paperwork, an agent turns up) reappeared almost
    // verbatim in tester plans. The second example shows an NPC acting toward
    // {{user}} without a later beat assuming the answer. Under the
    // world-pressure lens the examples are world-driven instead — the same
    // copy-protection argument says a lens asking for complications must not
    // show two NPC schemes, and the two world examples must not share one
    // shape either: one builds to a community allocation meeting under
    // scarcity, while the other is a household-scale opportunity (a new ferry
    // route) with a real cost attached. Opportunity must be a valid initiating
    // event, not just a workaround midway through a hardship ladder — but a
    // stakeless one ("a nice market opens") resolves itself on arrival, so the
    // example shows a limited, time-bound window that can go either way. The
    // two also differ in setting and scale and share no posted-notice beats,
    // which an earlier pair had in common.
    const beatActorRule = worldPressure
        ? 'A beat must be something a narrator can actually perform in a single scene — the world moves: something arrives, opens, flourishes, is discovered, fails, runs short, or changes how ordinary life works. People and institutions may act, react, and adapt inside a beat, but the initiating development applies to everyone it reaches, never a plan aimed at particular people.'
        : 'A beat must be something a narrator can actually perform in a single scene — someone asks, offers, refuses, or reveals something; something arrives or is discovered; a deadline moves.';
    const examples = worldPressure
        ? `- The Long Dry — The valley's farms depend on a shared water rotation, but this year's thin snowpack cannot sustain it; the arc builds toward the emergency allocation meeting where the valley must rewrite the rotation, and the farm that planted late could come away with no summer water at all.
  1. Low river flow makes the watermaster cancel the spring flush, leaving one farm's seedbeds too dry to sow.
  2. The watermaster's clerk posts a rationing notice on the canal-house door: households that register their fields before the deadline keep first draw when the summer cuts come.
  3. The canal keeper's posted marks show the reservoir lower than any year in living memory, and meeting notices go up along the whole canal.

- The Night Ferry — A new pre-dawn ferry puts the island bakery, which has only sold to its village, within reach of the mainland market; it builds toward a trial stall there, where a good Saturday could win a standing café order and a slow one could make the crossing a loss.
  1. A mainland café owner riding the ferry's first run buys the bakery's last loaves on the dock and asks whether there is more where those came from.
  2. The mainland dock market's manager hears about the loaves and offers the bakery a stall for three Saturdays, the first one rent-free.
  3. The week before the first Saturday, the ferry adds a freight charge for crated goods, and the bakery's trays count as crates.`
        : `- The Harbor Lease — The dockmaster wants the guild's warehouse back before the autumn fleet arrives, and a damning inspection report gives her the grounds; it builds toward a hearing before the harbor council where the guild must answer the report, and losing it could cost them the warehouse.
  1. The dockmaster's clerk posts an inspection notice on the warehouse door, citing rot no one on the crew has seen.
  2. A carpenter hired to check the beams finds them sound and points out that the notice was signed by an inspector who retired last spring.
  3. The dockmaster moves the hearing up a week, before anyone can find the retired inspector.

- The Spare Room — Mira wants to stop being her brother's rescuer, and his plan to move in "just for a month" makes it urgent; it builds toward Mira telling him what she will and won't do, which could end with him leaving angry or her giving him a key on her terms.
  1. Mira's brother asks {{user}} to help talk her round, saying she always listens to them.
  2. Mira finds out he went to {{user}} before asking her, and calls off the dinner where she had planned to say yes.
  3. Her brother arrives with his bags a week early, before she has given him an answer.`;
    const beatsRule = hooksOnly
        ? 'Arcs under "Immediate Hooks" need no setup beats — they are already usable as-is, so return the bullets alone.'
        : `For every arc${has('immediate') ? ' EXCEPT those under "Immediate Hooks"' : ''}, follow the bullet with a numbered list of 2-4 SETUP BEATS: concrete, in-scene events that build toward the arc's turning point. ${beatActorRule} ${BEAT_PROGRESSION_RULE}

Two examples of the format, from unrelated stories. Do not reuse their events or beat patterns.

${examples}
${has('immediate') ? '\nArcs under "Immediate Hooks" need no beats — they are already usable as-is.' : ''}`;

    // The intro and the cast-development rule are the two remaining NPC-centric
    // framings. Under the lens, "develop established threads and cast" would
    // pull every arc back toward a person's wants, so it is replaced by the
    // world-pressure rule itself.
    const introRule = worldPressure
        ? 'You are a Story Architect. Your ONLY job is to brainstorm future plot possibilities for an ongoing roleplay. This request asks for developments driven by the setting — the setting acting on the characters, not a plan aimed at particular people. The world can open opportunities as well as create difficulties.'
        : 'You are a Story Architect. Your ONLY job is to brainstorm future plot possibilities for an ongoing roleplay.';
    const castDevelopmentRule = worldPressure
        ? `- ${WORLD_PRESSURE_RULE}`
        : '- Develop established threads and cast before adding new rivals, villains, institutions, or other major characters. A story palette may request expansion, but it is a preference rather than a quota.';

    return `${introRule}

ABSOLUTE RULES:
- Output ONLY the story plan document. Never continue the roleplay or write any part of it as a scene. Summarizing what an NPC asks, offers, or reveals is planning, not dialogue.
- Frame every idea as a future arc, chapter, or episode — never a time frame ("three days later", "next month").
${sortRule}
- Treat every arc as a hypothesis: describe attempts, pressures, complications, and possible outcomes, and never claim an uncertain outcome succeeds.
- ${PLAYER_AGENCY_RULE}
- ${STORY_GROUNDING_RULE}
${castDevelopmentRule}
- If you are shown a previous plan, an arc's name is its identifier: reproduce the name of any arc you carry forward EXACTLY as written, and never copy a [BRACKETED] annotation into a name. Renaming an arc loses its tracked progress and duplicates it.
- The previous plan may put a tracker marker such as [ARC:…] in front of an arc's name. When you carry that arc forward, copy its marker exactly at the start of the bullet, before the name and outside any bold. Never put a marker on a new arc, on a beat, or on a different arc.
- Be punchy and plot-focused.

FORMAT:
Output only these headings, in this exact order, even if a section has only one idea: ${sectionListInline}. Omit a heading entirely only if you genuinely have nothing for it. Never invent, rename, or substitute another heading.

${sectionFormatBlock}

Under each heading, use a bullet list. ${bulletRule}

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

{{authorContext}}

Output the story plan now. Begin immediately with the first section heading.`;

// ─── Targeted arc development ────────────────────────────────────────────────
// Deliberately independent of the configurable full-plan prompts. Targeted
// operations return one JSON object and never enter the five-section parser.

export const TARGETED_ARC_SYSTEM_PROMPT = `You are revising one selected story-planning arc. Return ONLY valid JSON (no Markdown fence, preamble, or commentary).

Use this exact shape:
{
  "title": "arc title",
  "description": "what is wanted or unsettled, what pressures it, and the turning point it builds toward",
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
- pendingBeats contains only the proposed future route, in order. Each beat must be concrete enough for a narrator to perform in one scene. ${BEAT_PROGRESSION_RULE}
- When the cast policy proposes or allows a recurring/major newcomer, use one bounded proposal-local newcomerHandle and put the same entranceHandle on exactly one concrete entrance beat within the first ${MAX_CONTINUITY_BEATS_PER_ARC} pending beats. Leave both empty when no newcomer is proposed. Never use the fields for an established character.
- ${ARC_DESTINATION_RULE}
- Treat the description as a possible endpoint, not a fact that has happened.
- ${PLAYER_AGENCY_RULE}
- ${STORY_GROUNDING_RULE}
- Keep the result concise and grounded in the supplied factual context.`;

export const TARGETED_OPERATION_INSTRUCTIONS = Object.freeze({
    rework: 'Preserve the arc title, description/endpoint, and section exactly. Replace only its pending setup route with a stronger route toward the same endpoint.',
    develop: 'Develop this arc into a stronger story: sharpen its description so it names what someone wants or what is unsettled, what makes it consequential now, and a concrete turning point, and replace its pending route so each beat changes the situation. You may move it to a better section. Preserve its title and all historical progress.',
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
