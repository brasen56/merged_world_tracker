# Story Planner Roadmap — Response

**Status:** Reply for discussion, not a roadmap
**Responds to:** `docs/STORY_PLANNER_IMPROVEMENT_ROADMAP.md` ("the roadmap")
**Checked against:** branch `main` at `2b2a29f`

## Summary

- Every problem in the roadmap's §3 checks out against the code, and the 136-test planner baseline it cites still passes. We reproduced both headline bugs. The beat-progress bug is more likely to trigger than §3.1 suggests (§2).
- We accept the direction and most of the §4 decisions as written (§1).
- The main adjustment is order. The progress fix fits the current v1 store, so it can ship as a patch instead of waiting for the v2 migration (§3.1).
- Keeping closed arcs needs bounds on more than the prompt. Unbounded, 100 resolved arcs add roughly 15,000 tokens to every regeneration and up to about 1.5 MB of plan history. Part of that growth already happens today (§3.2).
- The identity scheme can be simpler: short per-request arc handles, and no beat ids in the prompt (§3.3).
- One rule needs settling before Phase 1: when a beat's age resets. The natural reading of §5.1 silently disables overdue reminders for auto-generate users (§3.4).
- There are four findings the roadmap doesn't cover. The most serious is that a Ready arc never leaves the prompt on its own (§4.1). Two are existing bugs we reproduced: the card's status dropdown skips the reopen reset (§4.2), and an arc deleted during generation comes back (§4.3).

## 1. What we accept as written

- Decisions 1, 2, 5, 6, and 8: user-confirmed state is authoritative; completed setup is immutable during regeneration; no new automatic model call by default; targeted generation always produces a reviewable proposal; creative controls start small.
- With notes: Decisions 3 and 10 (closed means remembered; stored history is complete) in §3.2, Decision 9 (identity markers in the Markdown format) in §3.3, Decision 4 (Pin, Park, and Focus are separate) in §3.5, and Decision 7 (a purpose-built safe projection) in §3.7.
- Phase 0 first. Its fixtures are the red tests the §3.1 fix needs.
- Skip kept distinct from Delete, and never counted as planted.
- The injection-mode cleanup. `all` and `active` select the same arcs today (`story_planner/injection.js:43-47`), so mapping legacy `active` to `all` changes nothing for anyone.
- Phase 5 as manual, quote-verified suggestions behind a decision gate. That matches the beat-detector design from August (never built), which rejected both automatic advancement and in-band self-reporting.
- Phase 7's rule that optional automation is decided by measurement.

## 2. Reproduced

These cases were run against the real `story_planner` exports under the project's test stubs, from a scratch folder outside the repository.

**Beat progress (§3.1).** The likeliest trigger is not a reorder. The regeneration prompt asks the model to keep planted beats as-is and not to re-propose that setup (`story_planner/generation.js:82`). A model that follows only the second half lists just the remaining beats:

| | Beats | `beatIndex` | State |
|---|---|---|---|
| Stored | servant mentions the rival · shipment arrives short · agent appears at a party | 2 | first two planted, third current |
| Model returns | agent appears at a party · rival calls in a public debt | | |
| After merge | agent appears at a party · rival calls in a public debt | 2 | **Ready**, no current beat |

`mergeRegeneratedArcs` takes the model's list (`story_planner/data.js:452`) and keeps the old index, clamped to the new length (`:462`). Neither remaining beat has happened, but the arc moves under "Ready Now — setup is already planted; bring these to a head" (`story_planner/injection.js:70`). A model that repeats only the planted beats hits the same bug: two beats, index 2, Ready.

**Closed ideas (§3.2).** We stored a pinned Dropped arc and a Resolved Immediate Hook, then ran one regeneration that returned an unrelated arc. Only the new arc survived. The carry rule excludes Dropped arcs outright, even pinned ones, and keeps other omitted arcs only if they are pinned or part-planted (`data.js:469-473`).

## 3. Points we'd adjust

### 3.1 Ship the progress fix before the migration

The fix doesn't need the v2 store. It fits in `mergeRegeneratedArcs`:

1. Keep the planted beats (`beats.slice(0, beatIndex)`) exactly as stored.
2. The model's beats, minus copies of planted beats (normalized the way titles already are), become the remaining route.
3. If that route is empty, keep the stored remaining beats. Regeneration cannot complete an arc's setup.
4. If the stored arc is already Ready, ignore the model's beats. Regeneration cannot undo completed setup either.
5. Set `beatIndex` to the number of planted beats, and keep `turnsSinceAdvance` as it is today (§3.4).

This is the roadmap's own fallback for output without identifiers (§5.2, last paragraph), shipped early. The current prompt already asks models to repeat planted beats as-is, and step 2 absorbs those copies, so the patch needs no prompt change. The trade-off is that a model that rewords a planted beat produces a visible duplicate pending beat instead of a silent false Ready. That is the right direction to fail, and the user can correct it.

The migration is the riskiest part of the roadmap: backup merge and replace, imports, history restores, and quarantine. Once the fix has shipped, the migration can land with its first consumers (Skip and the beat editor), either as the UI-free step §9 proposes or together with Phase 2.

### 3.2 Closed memory: bound every surface, and don't rely on the prompt alone

Keeping closed arcs is a small change to the merge's carry rule. The roadmap's risk table bounds the generation prompt, but a retained arc appears in four places. For scale, we serialized 100 resolved arcs, each with a 30-word description and three 16-word beats:

| Surface | Today | With 100 resolved arcs kept |
|---|---|---|
| Regeneration prompt | Every non-Dropped arc is sent with its description and full beat list (`generation.js:73-74`) | About 61,000 characters (roughly 15,000 tokens) per regeneration. Title-only lines would be about 4,000 characters. |
| Plan history | Each of up to 20 snapshots copies every arc (`data.js:738`) | About 75 KB live; up to about 1.5 MB with 20 snapshots |
| `{{storyplan}}` | Excludes only Dropped arcs (`story_planner/index.js:398`) | All 100 with their beat lists, plus Parked arcs in v2 |
| Card list | Closed arcs render dimmed inside their sections (`story_planner/render.js:207`) | They pile up beside the actionable cards |

This growth already happens for Resolved arcs that had a planted beat, since the merge always carries those (`data.js:472`). Decision 3 extends it to every closed arc. Retention should therefore land together with its bounds:

- A capped list of closed titles in the prompt (the roadmap's `<closed_story_ideas>`), with reasons once v2 has them.
- Closed and Parked arcs filtered out of `{{storyplan}}`. The macro should keep ignoring the injection mode, as it deliberately does today. It is also the "does a plan exist" check behind the floating button (`index.js:393-395`), so an archive-only plan needs checking there.
- A collapsed Archive group in the card list.
- A decision about history. For example, snapshots could copy a closed arc only when it changed since the previous snapshot, or closed records could live outside the snapshotted list. Decision 10 rules out deleting planning records to save tokens, but it doesn't settle storing each one up to 21 times.

**A guard that doesn't depend on the prompt.** Showing Dropped ideas to the model reverses a deliberate choice. The code withholds them because "the user rejecting an idea should mean it stops coming back" (`generation.js:70-73`), and naming a rejected idea can prime weaker or local models to regenerate it. We think the roadmap's direction is right, but it shouldn't rely on the prompt alone:

- When a parsed arc's normalized title exactly matches a closed record, the merge absorbs it: no reopening, no rewrite, no new arc. The merge log and Diagnostics count it.
- That count is Phase 7's closed-memory recurrence measurement, available without manual QA. It can also decide whether sending Dropped titles helps, by comparing the count with the titles sent and withheld.
- Near-miss titles stay the prompt's job. A similarity hint in the UI is fine, as §5.2 says, but it never applies automatically.

The guard is also what makes the help text true. The panel currently promises that marking an arc Resolved or Dropped stops it "being suggested again" (`render.js:411-412`).

**Custom prompts.** Custom user prompts only receive blocks they have tokens for (`generation.js:121-127`). A prompt saved before closed memory or the story palette exists will silently get neither. Either append new blocks when their token is missing, or show a notice in settings. It is the same issue as §2.3 of the World State reply.

### 3.3 Arc handles only; no beat ids in the prompt

Once code owns planted history, the model never needs to repeat it. The v2 prompt can ask for the remaining steps only, and §3.1 step 2 covers models that repeat them anyway. Beat ids stay in storage for the editor and history, but no model ever sees one. That removes the beat half of the marker cases in the roadmap's §7.

For arcs, assign short handles when the prompt is built (`A1`, `A2`, …) and keep them with the arcs captured at request time (`generation.js:217-218` already captures that list):

- Models copy `A3` far more reliably than an id like `1726312345678-1a-x9f2`.
- Forged and cross-chat identifiers can't occur, because a handle means nothing outside its request. Unknown or repeated handles fall back to title matching.
- Names stop being the identity key. The "reproduce its name EXACTLY" instructions (`generation.js:77`, `story_planner/prompts.js:31`) can be relaxed, and a model that tidies a name no longer costs the arc its progress. On a handle match the stored title wins, which keeps today's behavior.
- The merge can tell when the user changed or deleted an arc after the request was built (§4.3).

Two format constraints:

- The previous plan passes through `escapePromptText`, which escapes `<` and `&` (`core/prompt.js:47`). HTML-comment markers would reach the model as `&lt;!--`, so use a bracket form.
- The parser already strips a leading `[Tag]` of up to 24 characters from arc bullets (`story_planner/schema.js:234`). A leading `[A1]` would be silently discarded today, so the new parser must read the handle before that cleanup.

Handles don't need the v2 store either. They are a prompt and parser change.

### 3.4 Settle when a beat's age resets

§5.1 says "changing the current beat resets `turnsSinceAdvance`", and the Phase 2 exit criteria repeat it. If a regeneration counts as a change:

- Auto-generate runs every 10 AI replies by default (`story_planner/settings.js:38`), and a beat becomes overdue at 12 turns (`data.js:82`). Both count the same event (`index.js:94`, `:103`).
- A model that rewords the current beat on each run resets its age before it reaches 12. The injection's "still waiting after N turns" line (`injection.js:90`) and the reminder toast never appear. This is the silent stall the reminder exists to catch, and a dead reminder has shipped once already (the missing re-apply described at `index.js:89-94`).

Proposal:

- **Age counts turns since the arc's last progress event:** planted, skipped, back, or a user edit of the current beat. Regeneration never resets it.
- **Reminder marks stay keyed by progress position**, as `arcId#beatIndex` is today (`data.js:674`). In v2 the position is the number of planted and skipped beats. If marks were keyed by beat id, a regeneration that mints a new pending beat would drop the mark and re-fire the reminder immediately for every overdue arc.

The cost is that a newly generated beat can inherit an overdue age. We think that's acceptable, because it pushes the narrator toward an arc that really has been stuck.

### 3.5 Decide what Pin protects

When a pinned arc's title matches, its description, section, and beats are replaced by the model's (`data.js:452-459`). Pinning only matters when the model leaves the arc out. The card promises "Pin — keeps this arc through regeneration" (`render.js:214`). Phase 0 records this behavior in a test, but no phase decides between:

- **Pin means survives.** Today's behavior.
- **Pin means survives unchanged.** The model can only propose changes to a pinned arc, through Phase 4's "Develop this arc".

We lean toward the second, because users often pin an arc right after editing it. The same question applies when the user has moved an arc to another section, and to Parked arcs. The roadmap says Parked arcs survive regeneration but not whether the model sees them. Proposal: send them as title-only `[PARKED]` lines, so the model doesn't re-propose them, and never rewrite them.

### 3.6 Budget truncation and Focus

The roadmap's §7 expects that "Budget truncation drops whole arcs". It doesn't: the truncator keeps a character prefix of the body (`core/budget.js:429-434`), which can leave an arc title without its `NOW:` line. No phase changes that.

Focus is affected too. Sorting focused arcs first protects them from a cut at the end only if they sit at the top of the whole payload. Sorted within sections, a focused arc in the last section is cut before an unfocused arc in the first.

This only matters once a user sets a Story Planner soft cap, which is off by default (`budget.js:97`, `:693`). If focused arcs are meant to survive truncation, either give them their own block after Ready Now, or make the budget cut between arcs.

### 3.7 Safe character context (Phase 6.2)

- **Core surface.** Story Planner imports nothing from other modules today, and the only edges between modules are chronicle → world_state and interiority → knowledge. Core has no Knowledge accessor, so this projection is new core surface, alongside `getWorldStateFactual`.
- **Field list.** The dossier fields have no public/private split (`knowledge/lorebook.js:800-812`). `agenda` is "their main agenda in the story right now" (`knowledge/prompts.js:107`), which is often the hidden motive. `read_on_pc` is "what this NPC currently thinks of the player character" (`knowledge/prompts.js:106`), and it isn't on the exclusion list. Both need an explicit decision, and an allowlist would be safer than an exclusion list.
- **Secrets.** The narrator already sees secrets, because every dossier field, Secrets included, is written into the lorebook entry (`knowledge/lorebook.js:850-853`). Excluding them from planning mostly keeps spoilers out of the arc cards the user reads. That's a good default, but "the secret comes out" is some of the best material a planner can work with, so an explicit opt-in may be worth adding later. This also reopens the July arc-rework decision to keep Knowledge relationships out of arc generation.

## 4. Findings the roadmap doesn't cover

### 4.1 A Ready arc never leaves the prompt on its own

Reproduced: a Ready arc that had waited 40 turns, left out of a regeneration by the model, was kept, got no reminder, and was still the first arc in the injection under "Ready Now".

- Reminders only consider arcs waiting on a beat (`data.js:319-323`), and the Ready Now block carries no age or overdue line (`injection.js:69-75`).
- `/wt-beat` lists only waiting beats (`index.js:299-307`). The only planner commands are `/wt-plan` and `/wt-beat` (`core/commands.js:70`, `:87`), so no command can resolve an arc.
- Regeneration carries Ready arcs even when the model leaves them out, because they have planted beats (`data.js:472`).
- The injection header tells the narrator that Ready arcs are "usable in this scene. When a scene needs somewhere to go, take one and let it play out" (`prompts.js:130`).

If the payoff already happened and the user didn't click Resolve, the narrator is invited to stage it again on every turn. This is the forgotten confirmation from the roadmap's §3.6, one step later, and regeneration can't clear it. Immediate Hooks get no reminder either. A regeneration does drop an unpinned hook the model leaves out, but auto-generate is off by default (`settings.js:40`), so a used hook stays on offer until the next manual generation.

The data for a fix with no API calls already exists. `advanceBeat` resets `turnsSinceAdvance` when the final beat is planted (`data.js:278`), and `incrementArcTurns` keeps ageing Ready arcs (`:300-304`), so a Ready arc's age already means "turns since it became Ready". Proposal for Phase 3, not Phase 5:

- A "did this happen?" reminder for Ready arcs past the threshold, with a Resolve action.
- `/wt-beat` lists Ready arcs as a separate group (for example `R1`, `R2`) with a way to resolve one, so `/wt-beat 2` still means the second waiting beat.

Phase 5 can still suggest resolutions later. This doesn't have to wait for it.

### 4.2 The card's status dropdown skips the reopen reset

`setArcStatus` resets an arc's age and clears its reminder marks when the arc is reopened (STORY-PLANNER-08, `data.js:566-580`), and `test/tier4_fixes.test.js:195-206` covers that. Nothing in production calls it. The card's status dropdown calls `updateArc(id, { status })` directly (`render.js:602-603`).

Reproduced with two arcs whose current beat had waited 30 turns. Each was resolved and reopened through one path, followed by one reply:

| Path | Age after reopening and one reply | Reminder |
|---|---|---|
| `updateArc` (what the dropdown calls) | 31 | fires immediately |
| `setArcStatus` | 1 | none |

The roadmap's reopen rule (§5.1), Park and Resume (Phase 3), and beat edits (Phase 2) all add transitions of this kind. They should all go through one transition function, and the tests should drive the handler the UI uses rather than the data function.

### 4.3 An arc deleted during generation comes back

The rebase comment says "pins/edits/deletes made during the call survive" (`generation.js:287-291`). Deletes don't. The merge runs against the current arcs (`:292-302`), where the deleted arc has no title match, so the model's copy of it (the model saw the arc in the previous plan) is added as a new arc.

Reproduced: an arc with one planted beat, deleted while the call was in flight, came back as a new active arc with a new id and no progress.

Reading the same merge, a description edited during the call is also lost: the model's copy matches by title, and its description replaces the user's. The roadmap's §7 test for mid-flight edits and deletes will catch both. The fix is to compare each parsed arc with the copy captured at request time (by handle once §3.3 lands, by title before that). If the user has deleted or changed that arc since, keep the user's version.

### 4.4 Phase 5 needs the quote checker moved to core first

`findQuoteMatch`, `quoteMatchesMessage`, and `normalizeForMatch` are private functions in `knowledge/growth.js` (`:147`, `:177`, `:218`), and no test calls them directly. Importing them from Story Planner would add a third edge between modules. Moving them to `core/`, with their own tests, is a prerequisite for Phase 5. Stable message identity already lives in core (`core/message_identity.js:31`).

### 4.5 Smaller items

- The "All" mode description says "Inject every arc that is not dropped" (`data.js:56`), but Resolved arcs are excluded too. Worth fixing now, even though Phase 3 replaces it.
- §6 Phase 1 bundles work that §9 splits into two steps. With §3.1 of this reply, the progress fix moves ahead of both.
- The palette's balanced default has to replace "Focus on major plot shifts, new character introductions, and escalating conflicts" in the default prompt (`prompts.js:28`). Custom system prompts keep their own wording, so the palette's effect on them should be measured separately.

## 5. Additions to the evaluation set

Phase 0 fixtures we'd add. Cases that describe current bugs should be run red against `2b2a29f` before any fix; the rest pin the new rules.

- The model returns only the remaining beats of a part-planted arc (§2).
- The model repeats only the planted beats of a part-planted arc. The arc must not become Ready.
- The model adds beats to a Ready arc. The arc must stay Ready.
- The model repeats planted beats with light rewording. A duplicate is acceptable; false progress is not.
- The model returns the exact title of a Resolved or Dropped arc. The merge absorbs and counts it.
- The user deletes an arc, or edits its description, while generation is in flight (§4.3).
- An arc is reopened through the card's status dropdown after a long wait (§4.2).
- Auto-generate at default settings, with a model that rewords the current beat on every run. The reminder must still fire by turn 12 (§3.4).
- A Ready arc left unresolved past the threshold. A reminder fires, and `/wt-beat` can resolve it (§4.1).
- A chat with 100 closed arcs: regeneration prompt size, history size, and `{{storyplan}}` output (§3.2).
- A Story Planner soft cap smaller than the plan, if focused arcs are meant to survive truncation (§3.6).

## 6. Proposed order for the roadmap discussion

This is a starting point for discussion, not a roadmap:

1. **Patch: the progress fix** (§3.1) and the mid-flight delete and edit guard (§4.3), with the bug fixtures run red first. No store or UI change.
2. **Patch: lifecycle fixes.** One transition function for status changes (§4.2), the Ready-arc reminder and a way to resolve from `/wt-beat` (§4.1), and the "All" description. Also cap the closed arcs already sent to the model and drop their beat lists, which shrinks growth that happens today (§3.2).
3. **Arc handles** in the full-plan prompt (§3.3), with the age and reminder-key rule settled (§3.4). Still on the v1 store.
4. **v2 store, Skip, and the beat editor** (Phases 1 and 2).
5. **Closed retention with its bounds** (§3.2): the Archive group, the macro filter, the history decision, and the guard with its count.
6. **Park, Focus, and the mode cleanup** (Phase 3), with the Pin decision (§3.5) and the Budget and Focus decision (§3.6).
7. **Targeted proposals** (Phase 4).
8. **Quote checker to core, then manual Check progress** (Phase 5).
9. **Story palette, then character context** once the core accessor and field list are settled (Phase 6).
10. **Documentation and measurement** (Phase 7), including the closed-idea count and the comparison of sending versus withholding Dropped titles.
