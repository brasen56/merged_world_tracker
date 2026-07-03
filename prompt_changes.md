<!-- ## Things that look like bugs (These are completed)

**1. Invalid JSON in the dossier examples.** The output-format examples in `DOSSIER_SCAN_SYSTEM_PROMPT` ([knowledge/prompts.js:129](knowledge/prompts.js:129)), `DOSSIER_UPDATE_PROMPT` ([knowledge/prompts.js:171](knowledge/prompts.js:171)), and `DOSSIER_ENRICH_PROMPT` ([knowledge/prompts.js:206](knowledge/prompts.js:206)) all have a trailing comma after the `"canon_lock"` line before the closing `}`. Models imitate examples closely — weaker models will reproduce the trailing comma and emit invalid JSON. `parseJsonLenient` may save you, but it's a free fix: delete the three commas.

**2. Orphaned `image_tags` instruction.** `DOSSIER_ENRICH_PROMPT` says "For image_tags, produce 12-20 comma-separated Booru-style physical-only tags" ([knowledge/prompts.js:188](knowledge/prompts.js:188)), but the OUTPUT FORMAT contains no `image_tags` field. Either the field went missing from the schema or the rule is leftover from an earlier version — right now it invites the model to invent a field your merger doesn't handle.

**3. Chronicle can absorb stale world-state facts.** In [snapshots.js:155](chronicle/snapshots.js:155) the user content is `Current World State:\n...\n\nMessages to chronicle:\n...`, but `CHRONICLE_SYSTEM_PROMPT` never says what the world-state block is *for*. A model can legitimately read it as part of "what happened" and chronicle facts that appear only in the world state (including its speculative sections like Story Momentum). One added line fixes it: -->

> The Current World State block, if present, is reference context for names, dates, and locations only. Chronicle ONLY events that occur in the messages themselves.

## World State ([world_state/prompts.js](world_state/prompts.js))

**Off-Screen decay is too aggressive as written.** The rule "drop a character if they have not appeared or been referenced in the recent messages" plus "when in doubt, DROP" means any off-screen character not name-checked in the last window gets deleted — but off-screen characters are precisely the ones who go unmentioned for stretches (someone traveling, someone awaiting a reply). Consider tying retention to the rest of the document instead: *drop an Off-Screen entry unless it was referenced recently OR is tied to an entry in Pending, Active Threads, or World Pressures.* I noticed the untracked `STALE_ENTRY_EXPIRY_DESIGN.md`, so you may already be heading toward age-based expiry — that would be the more robust fix (the model deciding staleness per-refresh is inherently noisy).

**Plot Seeds template reads as literal output.** The section shows seven category bullets that look like lines to reproduce, so literal-minded models pad out all seven categories every refresh even when only one seed is warranted. The `[pressure]` line is also formatted differently from its siblings (full sentence, no em-dash), which tends to leak into output. Restructure it as an instruction plus one example:

```
## Plot Seeds
- [category] — one sentence describing the event that could arrive

Categories: [contact], [entrance], [social], [institutional], [opportunity], [pressure], [threat].
Output 0–4 seeds. Only include a seed when an existing pressure genuinely suggests it.
```
Your excellent BAD/GOOD examples then follow as-is. (Same pattern applies to Potential Entrances, which currently shows three literal NPC bullets.)

**Two stances on carrying state forward coexist.** The core rules say both "treat the Previous World State as a starting point, carry forward only what's still relevant" (rebuild stance) and "Update only what has actually changed" (diff stance). Models resolve this inconsistently — some rewrite everything in new words, causing drift in facts that didn't change. Merging them into one sentence removes the ambiguity: *"Rebuild the document each refresh: copy still-true entries verbatim, revise entries with direct evidence of change, and drop entries no longer relevant."*

## Chronicle ([chronicle/prompts.js](chronicle/prompts.js))

These two are the tightest prompts in the extension. Two small ideas:

- **Pin the Time Anchor format.** Consolidation copies the anchor from the last delta, and [snapshots.js:152](chronicle/snapshots.js:152) regex-parses `Date:`/`Time:` lines from the world state for `worldDate`. Specifying a fixed anchor shape (e.g. `In-world date and time at end of this period: <Weekday, Month Day, Year — HH:MM>`) keeps entries mergeable and greppable instead of drifting between "that evening" and full dates.
- **Consolidation contradiction rule.** You cover "final state wins," but not what to do when a delta *contradicts* the base without obviously superseding it (common with model-generated deltas). One line — "If entries conflict, prefer the latest entry; do not attempt to reconcile both versions" — prevents the merged entry from hedging with both.

## Knowledge Tracker ([knowledge/prompts.js](knowledge/prompts.js))

**Alias handling is the biggest real-world gap.** The scan prompts require exact name matches against "Already Tracked NPCs," but roleplay text constantly switches between full name, first name, surname, title, and nickname ("Mikhail" → "Misha" → "Mr. Volkov"). As written, a nickname produces a duplicate `new_minor` NPC. Add to the classification guide:

> If a name plausibly refers to an already-tracked NPC (nickname, first/last name only, title, or role), classify it as an UPDATE using the tracked name exactly as listed — never create a second entry for the same person.

**Say "JSON null", not "null".** Every "else null" field description is ambiguous — models regularly emit the *string* `"null"` or `"unchanged"`. One rule line in each JSON prompt: *"For unchanged fields output JSON null, never the string 'null' or 'unchanged'."* An alternative worth considering: allow the model to **omit** unchanged fields entirely. It shrinks output (fewer max-token truncations, which your retry comment says is your main failure mode) and your mergers already treat missing/null the same if they use `result.fields || {}` semantics — worth checking `buildUpdatedDossierContent` handles absent keys before switching.

**Match the prompt's vocabulary to the actual context.** The prompts refer to a section called `"Already Tracked NPCs"` but the user content wraps it as `<already_tracked_npcs>` ([lorebook.js:484](knowledge/lorebook.js:484)). Models handle this fine most of the time, but exact referential match is free reliability: say "listed inside `<already_tracked_npcs>`".

`STATE_UPDATE_PROMPT` is excellent as-is — the "copy verbatim unless direct evidence" contract plus output-the-original-if-absent rule is exactly the right shape for that job.

## Story Planner ([story_planner/prompts.js](story_planner/prompts.js))

The `{{previousPlan}}` handling in [generation.js:58](story_planner/generation.js:58) (carry forward / evolve / drop) is well done. Two suggestions:

**"Minimum of 10" trades quality for count.** Hard minimums make models pad the tail with generic tropes (mysterious stranger arrives, hidden betrayal revealed) once grounded ideas run out. Consider "8–12 ideas, each grounded in a specific existing thread, relationship, or pressure — stop when ideas stop being distinct" — your validator only requires 3 bullets, so a shorter-but-grounded list still passes.

**Push for variety explicitly.** The single `[Arc]` example tends to make every bullet an "[Arc]". Naming a small tag vocabulary gives you a structurally varied menu: `[Arc]` (multi-chapter), `[Episode]` (self-contained), `[Introduction]` (new character/faction), `[Escalation]` (existing pressure worsens), `[Revelation]` (hidden fact surfaces) — and "spread your ideas across tags; no more than half in one category." Optionally require each bullet to end with a grounding note ("— builds on: <existing thread>"), which suppresses tropes and makes weak ideas visible to the user at a glance.
