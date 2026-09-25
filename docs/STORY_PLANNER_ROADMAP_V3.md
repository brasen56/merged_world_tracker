# Story Planner V3: scoped generation, character journeys, and cast policy

**Status:** Phases 0 and 1 complete. Phase 2 and Phase 3A-3D **Implemented, not host
verified** — see the status blocks in §5. Phase 0 request-boundary samples are
synthetic and the consented targeted-develop sample remains a non-blocking
follow-up; the planner-output attribution required to exit Phase 0 is recorded.
Phase 3D automated implementation is complete; host/model evaluation remains pending.
Phase 4 is implemented in code, not host/model verified; human spoiler QA remains pending.
Phase 5 (arc quality) is **Implemented, not host verified** — the prompt edits
followed a positive Direction Hint trial; see §5.
**Date:** 2026-09-19 (Phase 1 status and Phase 2-3 handoff rules updated
2026-09-20; Phase 2 and Phase 3A-3D status recorded 2026-09-20; Phase 4 and Phase 5 status recorded 2026-09-22)
**This revision covers:** Phases 0-4. Phase 4 (opt-in author context) is
implemented but awaits host/model and human spoiler verification. Phase 5 (arc quality) is a
prompt-only slice added from tester bland-plan feedback. Independent arc
classification and execution prerequisites are deferred in §7.
**Audience:** Implementer, co-author, and roleplay testers
**Sources:** Tester feedback on the shipped Story Planner, plus a review of the
current implementation at the file references cited throughout §2.

V3 names the third Story Planner product/design revision. It does **not** name
the store schema version or extension release. The current store is schema v4;
each implementation slice must choose and register its own necessary migration.

This document extends [STORY_PLANNER_ROADMAP.md](./STORY_PLANNER_ROADMAP.md).
That document remains the baseline for identity, historical beat preservation,
lifecycle, closed memory, targeted proposals, and evidence-backed progress.
V3 changes the creative-control and context contracts only where stated below.
The outstanding host-runtime checks in
[STORY_PLANNER_PHASE7_DECISIONS.md](./STORY_PLANNER_PHASE7_DECISIONS.md) remain
pending; writing this roadmap does not complete them.

## 1. Outcome and scope

Users should be able to ask for a few ideas in a particular part of their story,
develop particular NPCs, and choose whether to expand the cast.

| Feedback or gap | Required outcome | Delivery phase |
| --- | --- | --- |
| Generate only Character Journeys or Horizon Arcs | Explicit section scope; unrelated arcs remain unchanged | 1 |
| Generate one or two useful ideas | Request-aware counts and validation; Add versus Refresh | 1 |
| Choose which NPCs receive journeys | Journey subjects distinct from context sources; stable ownership | 2 |
| Models never introduce new characters | Clear cast policy, explicit newcomer requirement, entrance beats | 3 |
| Growth becomes a predetermined improvement | Pressure, resistance, setbacks, and possible outcomes | 2 |
| Selected context can be omitted or truncated | Per-subject coverage and omission reasons | 2 |
| Custom templates can silently bypass controls | Compatibility feedback plus code-enforced mutation scope | 1 |
| Proposal success and narration success are confused | Separate what the planner proposed from what the narrator introduced | 0, 3 |
| Use full major-NPC dossiers | Opt-in author context with a reviewed-public output contract | 4 (implemented, not host verified) |
| Plans read as bland or repetitive | Dramatic question, causally progressing beats, concrete turning point | 5 |
| Character journeys are also near- or long-term arcs | Independent type and horizon | Deferred (§7) |
| Setup complete does not always mean usable now | Execution prerequisites separate from setup completion | Deferred (§7) |

First release is Phases 0-3. Phase 4 requires the projection inventory produced
in Phase 0 and is not a prerequisite for anything above it. Phase 5 is a
prompt-only quality pass, independent of Phase 4 and of the deferred work in §7.

## 2. Verified baseline

These observations describe the repository at this review, not every tester's
installed build or custom prompt. File references are the implementation seams.

- The full-plan prompt requests all five canonical headings, derived from
  `SECTIONS` so prompt, parser, and UI cannot disagree (`story_planner/prompts.js`).
  The parser already tolerates a partial response: a body containing only
  `## Character Journeys` parses to exactly those arcs (`schema.js:470`). Scoped
  generation therefore needs a prompt change and a merge boundary, **not** a new
  parser.
- **Two independent gates block a one- or two-arc request.** `getArcCount()`
  clamps with `Math.max(3, v)` (`data.js:1070`), and `validateOutput()` rejects
  `bulletCount < 3` (`generation.js:205`). Both must change together, or the fix
  appears not to work.
- **The merge deletes omitted arcs.** `mergeRegeneratedArcs` (`data.js:588`)
  carries an omitted active arc only when it is pinned, protected, closed,
  parked, ambiguous-titled, or holds at least one non-pending beat
  (`data.js:726`). A fresh Horizon Arc with no planted beats, omitted from a
  Character-Journeys-only response, is silently lost. That function already
  accepts an options bag (`protectedIds`, `deletedIds`, `deletedTitles`); the
  scope boundary belongs there as a further carry condition, not in a second
  merge implementation.
- **`targeted.js` is already the proposal engine this roadmap needs.** It
  captures scope and revision, generates without writing, detects staleness,
  rebuilds from the canonical source at Apply so the model never controls ids or
  lifecycle fields, builds a field/beat diff, and commits one
  `setArcsWithHistory`. Scoped Add is `alternate` without a source anchor;
  scoped Refresh is `develop` over N arcs. Generalise it from one arc to a
  captured set; do not write a second proposal flow.
- Safe Character Context supports Off, Active cast, and Selected characters.
  `listPlannerCharacterCandidates` (`planner_context.js:49`) already returns the
  whole registry, so **off-screen NPCs can already be selected as context**.
  What is missing is journey *ownership*, not candidate breadth.
- The Knowledge projection allows six records of 700 characters, with field
  values capped at 280 (`planner_context.js:9`). It excludes `read_on_pc`,
  `agenda`, `secrets`, `canon_lock`, and the Knowledge Ledger by cutting the
  entry at its first private label before an allowlist runs
  (`planner_context.js:26`).
- Dossier field extraction is **single-line only**: `extractDossierFieldValues`
  matches `^Label:\s*(.*)$` (`lorebook.js:890`). Secrets are specified as one
  string by the dossier prompt (`knowledge/prompts.js:108`), so a well-formed
  entry round-trips and a malformed multi-line value is truncated rather than
  leaked. A full-dossier projection needs a block-boundary parser that fails
  closed on an unrecognised boundary.
- The default system prompt always prefers established cast.
  `allowNewMajorCharacters` adds one permissive line when true
  (`generation.js:68`) and nothing when false. The old `false` was never a
  prohibition, which is a plausible contributor to conservative proposals but
  not a demonstrated diagnosis of every tester report — see Phase 0.
- Narrator injection emits the current beat **and** `arc.body` as
  "building toward" (`injection.js:148`); Ready arcs inject their body as the
  payoff. Title, body, and beat text therefore cannot double as private notes.
- Custom full-plan templates receive palette and character grounding only where
  their tokens occur (`generation.js:170`). Targeted prompts are fixed separately.
- API Last Request diagnostics are telemetry-only by construction. Keep this
  property; none of the work below justifies recording raw prompts there.

| Seam | Responsibilities in Phases 0-3 |
| --- | --- |
| `story_planner/schema.js` | Journey subject field, cast policy, bounded validation, migration |
| `story_planner/data.js` | Scoped merge carry rule, ownership, eligible-target derivation |
| `story_planner/generation.js` | Captured request specification, scoped context assembly, count-aware validation |
| `story_planner/targeted.js` | Generalised proposal/diff/Apply engine for a captured set |
| `story_planner/prompts.js` | Dynamic section headings, subject contract, cast-policy text |
| `story_planner/render.js` | Generate dialog, proposal review, subject selection, coverage display |

Read-mostly for these phases: `injection.js` (projection unchanged),
`knowledge/planner_context.js` (public projection retained as-is),
`knowledge/registry.js` (entity resolution), and the backup, import/export, and
schema-migration consumers, which must carry the new fields.

Add a new leaf module only if it removes duplication. The one clear candidate is
a shared request-specification helper; separate `proposals` and `projections`
modules are not justified while `targeted.js` already owns that behaviour.

## 3. Invariants

1. **Generation scope is a write boundary.** Context may be broader than the
   selected scope. Returned prose, section labels, or handles cannot expand it.
2. **Add and Refresh are different operations.** Add creates proposals. Refresh
   proposes edits to captured eligible records. Omission is not permission to
   delete an arc in the new scoped workflow.
3. **New manual scoped operations produce proposals.** Apply/Discard follows the
   existing targeted workflow. No persistent arc/history change occurs on failure,
   cancellation, stale output, or discarded proposals.
4. **Existing history is authoritative.** Preserve planted/skipped records,
   closed decisions, parked arcs, stable identities, and user edits. A model
   cannot mark progress, resolve dependencies, or disclose a secret by inference.
5. **Journey subjects and context sources are independent.** Supporting cast may
   inform an arc without becoming its owner. Generation selection never silently
   changes Focus, Pin, Park, or narrator injection mode.
6. **Cross-module state stays owned by its module.** Story Planner does not
   rewrite dossiers, facts, relationships, or Interiority intentions. Conflicts
   can be surfaced for review; planning is not authority to overwrite them.

Existing rules continue to apply unchanged and are not restated as new
invariants: no actions, dialogue, thoughts, or choices authored for `{{user}}`;
no new automatic model calls by default; telemetry stays content-free.

## 4. Product and data contracts

**Staging rule:** this section describes the finished V3 product after Phases
1-3. It is not permission to implement every field in the first phase that
touches the surrounding object or UI. Section 5 owns delivery order. Before a
field's owning phase, it may be accepted by a transient forward-compatible
canonicalizer, but it must remain behaviorally inert: do not persist it, render
a control for it, put it in a prompt, validate output against it, migrate it, or
claim its guarantee in review text.

| Request field or behavior | First live phase | Before that phase |
| --- | --- | --- |
| `operation`, `sectionKeys`, `requestedCount`, `targetArcIds`; scoped review/Apply | 1 | Not applicable; these are the Phase 1 slice |
| `subjectMode`, `subjectEntityIds`; ownership and context coverage | 2 | No stored preference, subject control, prompt clause, ownership validation, or coverage claim |
| `castPolicy`; newcomer and entrance-beat checks | 3 | `storyPalette.allowNewMajorCharacters` remains the only effective cast input; no second stored copy or policy claim |

The same rule applies to tests: a later-phase fixture may exist early as an
expected failure, but its production behavior does not move into an earlier
phase merely because an adjacent request object already has a placeholder for
it.

### 4.1 Generate dialog and request specification

At the end of Phase 3, the primary Generate action opens a compact dialog
containing:

- **Phase 1:** operation (**Add ideas** or **Refresh selected arcs**), section
  checkboxes initially all five, and requested count from 1 to 30 for Add;
- **Phase 2:** Journey subjects when Character Journeys is selected — Any
  subject or Selected NPCs — plus public-context coverage;
- **Phase 3:** cast policy; the existing palette and direction controls retain
  their existing ownership until explicitly migrated;
- existing context mode, without silently changing its saved selection; and
- a summary such as "Add 2 Character Journeys for Mara; use public context".

Remember ordinary manual choices per chat. Auto-generation keeps its own saved
scope; changing a manual dialog must not silently reconfigure automation. Retain
a clearly labeled legacy full-plan regeneration path during transition; its
behavior is not silently redefined by the scoped implementation. New dialogs
default to Add and Any subject, and preserve existing public-context selections
on upgrade.

The request specification grows by phase. Capture the applicable shape
immutably at dispatch; do not persist fields from a later shape early:

```js
// Phase 1
{
  operation: 'add',            // add | refresh
  sectionKeys: ['character'],
  requestedCount: 2,           // Add only
  targetArcIds: [],            // exact captured Refresh set
}

// Phase 2 adds
{
  subjectMode: 'selected',     // any | selected
  subjectEntityIds: ['entity-mara'], // canonical ids here; opaque handles on wire
}

// Phase 3 adds
{
  castPolicy: 'allowed',       // existing-only | allowed | propose
}
```

Capture chat scope, target revisions, and resolved subject IDs alongside it,
exactly as `captureScope` and `captureArcRevision` already do for targeted
operations. Names are illustrative; counts, ID lengths, and arrays need explicit
bounds in the schema, and no model-returned request metadata is persisted.

For Add, count means proposed new arcs across the selected scope — not per
section, and not the final plan size. Fewer proposals are reviewable with an
underfill notice; excess proposals are identified in review and never silently
applied beyond the requested count. Zero valid arcs is a failed operation. Do not
make unbounded repair calls to satisfy a quota.

For Refresh, the count is the number of existing eligible arcs selected; disable
the Add count control. New ideas returned during Refresh are not implicit
additions. Missing targets remain unchanged.

Empty section or required subject selections are invalid and never mean "all".
An unrestricted request uses the explicit Any subject mode, not an empty selected
list. In mixed-section requests the subject filter limits Character Journeys
only; other sections retain their independent scope, shown in the summary.
Refresh with no eligible targets explains why and offers Add without making a call.

### 4.2 Scope, identity, proposals, and Apply

At dispatch, derive eligible active target IDs from the section and subject
filters. An explicit subject filter matches the arc's primary journey subject; a
legacy arc with no subject is not guessed into the set by searching its title.
Parked and closed arcs remain read-only planning memory, not refresh targets.

Supply bounded summaries of other arcs as read-only continuity context. Issue
edit handles only for eligible targets, reusing the existing request-handle
mechanism. A returned handle for any other arc, a forged identity, or a
cross-scope title collision is rejected as an update.

The merge carry rule is the load-bearing change. Extend `mergeRegeneratedArcs`'s
options bag with the captured scope so every out-of-scope active arc is carried
unconditionally, alongside the existing pinned, protected, closed, parked, and
planted conditions. Do not route a partial response through the unrestricted
full-plan merge.

Scoped Add always mints fresh IDs at Apply and cannot replace a same-title
record. Surface duplicates and closed/parked recurrence through the existing
exact-match checks; near-duplicates may be review warnings, never fuzzy progress
transfer. Refresh retains source IDs and all historical beats; only allowed
future fields change. A returned section outside the selected set is not remapped.

Review shows additions, field/beat diffs, omitted targets, rejected output, and
unmet count/coverage/cast requirements. Apply operates on the explicitly accepted
valid proposals, in one checked write with one pre-Apply history snapshot.
Rejecting one valid suggestion need not prevent accepting another.

Before Apply, revalidate chat scope, target material revisions, and entity
mappings — the checks `applyTargetedProposal` already performs, extended to a
set. A changed target requires a rebuilt comparison and renewed review; never
silently rebase a shown diff. Unrelated live edits and newly created arcs survive
by merging against current storage. A change in age alone does not invalidate a
diff. Cancelled or stale requests consume no arc-history slot. All paths use the
central generation coordinator and the existing panic, disabled-tracker,
schema-pause, and chat-scope guards.

### 4.3 Journey ownership and character coverage

Add a bounded `primarySubjectEntityId` and optional supporting participant IDs to
arcs. IDs are canonical registry identities, never names returned by the model;
use request-local subject handles resolved against captured candidates.

Existing arcs migrate with no assigned subject. Provide manual assignment; do not
infer ownership from a name occurring in the body. Rename and merge resolve
through the shared identity service, including retained merge provenance. Missing
or deleted identities stay visibly unresolved and are never attached to a new
same-name NPC. A changed entity mapping invalidates the affected open proposal.

Primary subjects receive context priority ahead of supporting cast. The dialog
and proposal panel show each selected subject as included, partial, omitted for
budget, missing dossier, unavailable, or disabled, with field/record/token counts
and whether those limits are estimates. Do not silently substitute an active-cast
NPC for a missing selected one. If Knowledge is unavailable, retain saved
selections; a manual request may continue with clearly marked limited context or
reduce its selection. No automatic extra calls to fill missing context.

Subject selection and context selection remain independent. A selected subject's
request-local handle and display label are always sent so the model can identify
the requested owner, but that selection does not opt the dossier into Safe
Character Context. With context Off, send no dossier fields. With Selected
context, a subject omitted from the saved context selection remains omitted and
is reported as disabled; it is not silently added. "Priority" means ordering
records that are already eligible under the saved context mode when the budget
cannot fit them all. Coverage is proposal diagnostics captured for review, not a
new durable fact on the arc.

Journey prompts describe a pressure on a value, relationship, fear, habit, or
obligation, an observable opportunity for response, and possible consequences.
Growth may include resistance, relapse, deterioration, repair, or no resolution;
a positive transformation is not required. This is the section where a model is
most tempted to author the player's reaction, so the existing `{{user}}`
prohibition must be restated in the journey prompt itself. Dossier and canon
constraints remain context, not model-editable output.

### 4.4 Cast policy and proposed newcomers

Replace the ambiguous boolean with an explicit policy:

| Policy | Prompt and review contract |
| --- | --- |
| Established cast only | Use established named story participants; no proposed recurring/major newcomer. Incidental unnamed service/background characters are allowed. |
| New characters allowed | Prefer useful established threads while permitting a newcomer when appropriate; no newcomer quota. |
| Actively propose new characters | For Add, request at least one distinct newcomer and an arc/entrance that uses them; show a visible unmet requirement if absent. |

For Refresh or single-arc development, "propose" requests an optional newcomer
within that arc's scope. It cannot create unrelated arcs or force expansion into
a route that cannot use one. Report "no suitable newcomer proposed" explicitly.

A proposed newcomer needs a working name or role, story function, distinction
from the existing cast, a genre-appropriate connection, and **a concrete entrance
beat**. The entrance beat is the deliverable: it is what turns a proposal into
something the narrator can actually perform. A newcomer can be a friend, client,
witness, colleague, or relative; expansion does not automatically mean another
antagonist.

"Established" includes characters evidenced in the story even without a Knowledge
record — absence from the registry does not prove novelty. Structured participant
references can be checked deterministically; invented people hidden in prose
still require human review. Document that limit rather than claiming the enum
makes all model prose enforceable.

Both values of the old `allowNewMajorCharacters` flag migrate to **allowed**,
which preserves conditional expansion with an established-cast preference; the
old false was not a hard ban. Retire the legacy field after migration. Only a new
explicit user selection enables existing-only or active-proposal behavior.

Cast policy has one authoritative source for each workflow; do not create two
stored fields that both purport to control the same call:

| Workflow | Authoritative input in Phase 3 |
| --- | --- |
| Manual scoped Add/Refresh | `storyPlanRequestPreferences.castPolicy`, captured into the immutable request |
| Legacy full-plan, targeted develop/alternate, and automatic full-plan | `storyPalette.castPolicy`, replacing `allowNewMajorCharacters` |
| Custom full-plan template containing `{{storyPalette}}` | `storyPalette.castPolicy` through that token, with the effective policy shown before dispatch |
| Custom full-plan template without `{{storyPalette}}` | Policy unsupported: say so and offer the built-in path; do not claim enforcement or silently rewrite the template |

Both new stored policy locations migrate/default to `allowed`. Changing the
manual scoped choice does not alter legacy or automatic behavior, and changing
the palette does not rewrite the manual choice. Every call captures exactly one
effective policy and review displays which source supplied it.

Newcomer validation uses transient response markers rather than a new durable
candidate collection. A newcomer arc uses a bounded proposal-local handle on the
arc and on one concrete entrance beat, for example:

```md
- [NEWCOMER:n1] The Outside Auditor — Ilyra is an independent auditor whose mandate conflicts with the established team.
  1. [ENTRANCE:n1] Ilyra arrives during the records handoff and freezes the transfer.
```

The parser strips both markers before review or persistence and retains their
association only in proposal diagnostics. Handles must be unique, bounded, and
paired within the same arc. `propose` on Add requires at least one valid pair;
`propose` on Refresh or targeted development may return none but must display
"no suitable newcomer proposed." `existing-only` rejects a marked newcomer and
`allowed` accepts a valid pair without imposing a quota. An invented person
hidden in unmarked prose remains a documented human-review limitation; do not
pretend a name heuristic enforces the policy.

Newcomers stay hypothetical. Applying an arc does not create a Knowledge dossier
or assert that the NPC exists on-screen. In this release a newcomer lives in its
own arc's text; a separate candidate collection with planner-local IDs is
deferred to §7, where linking candidates to Knowledge dossiers makes it earn its
migration and backup cost.

### 4.5 Custom prompt compatibility

Legacy full-plan Markdown and its supported tokens keep working, and the scoped
workflow is built-in only for this release: a custom template can still run the
legacy full-plan path but cannot drive scoped Add/Refresh. Show which template
lacks relevant tokens or conflicts with the requested workflow, offer the
built-in scoped path as an explicit choice, and never silently replace a saved
custom prompt or imply an omitted block was sent. Operation and format
constraints live in an application-owned envelope validated in code, so custom
prose can never widen write scope or mark progress.

### 4.6 Phase 4: opt-in author context

The Phase 0 projection inventory informed the implemented slice:

For selected major NPCs, offer field groups — public profile, agenda, secrets,
knowledge and beliefs, read-on-PC, and user-authored canon constraints — opt-in
per chat and per NPC, never globally. Add an explicit author-context provider
method through `core/character_context.js`; do not weaken
`buildSafeCharacterContext` into returning secrets. Treat Knowledge ledgers as
attributed records that preserve the owning NPC: one NPC's knowledge is not
another's, nor the player's. Canon Lock is an immutable constraint input. Budget
by complete records rather than truncating the end of a secret, where a negation
could invert its meaning. The opt-in text must say the selected private fields
are sent to the configured planning model — this is fictional spoiler control,
not a promise of on-device processing.

**The output contract is the whole feature, and it is small.** Private context
goes in; only text the user has reviewed as revealable *now* comes out. Apply
shows the exact narrator-facing title, premise, beats, and payoff for editing or
rejection before anything is stored, which is what `applyTargetedProposal`
already does. Withheld details stay author-only and cannot auto-promote. Because
`arc.body` is injected to the narrator (§2), author-only material must never land
in title, body, or beat text — that is a schema separation verified by fixtures
with a distinct sentinel secret in each field, not a prose filter.

Staged-but-unreleased narrator text, release flags bound to a reviewed text
revision, and author-inclusive export modes are **deferred** (§7). They are the
right eventual design and the wrong first slice.

## 5. Delivery plan

### Phase authority and test discipline

The active phase's Work, Non-goals, and Exit blocks are the implementation
authority. The finished-product contracts in §4 explain where the design is
going; they do not pull later fields, controls, migrations, prompt clauses, or
validation into an earlier phase. If adjacent code exposes a future-shaped
transient object, leave the future fields inert as §4 requires.

Expected-failure tests are executable future contracts, not expendable scaffolding:

1. At phase start, run the focused file and record which `test.fails` cases fail
   as intended. If the owned case is only a placeholder that does not call
   production code, replace its body with the intended public-boundary assertion
   **while keeping `test.fails`**, and prove it still fails for the intended reason
   before implementation. It may not become a tautology that merely describes
   its fixture.
2. In Vitest, a `test.fails` case that starts passing is reported as a suite
   failure; that is the signal that its owning behavior has landed. At that point
   remove `fails` without weakening or inverting the semantic assertion.
3. Convert only a specification owned by the active phase. Leave later-phase red
   specifications red and present. Do not delete, invert,
   weaken, or opportunistically rewrite them while making the current suite green.
4. When an intentional production change invalidates a source-grep assertion,
   update the assertion to the new real contract. Never retain an unreachable or
   commented-out production string solely so a source scan continues to find it.
5. In the phase status, list every pre-existing red specification or cross-cutting
   source assertion changed, why its owning behavior changed, and which focused
   test now proves the replacement contract.

The Phase 0 red-spec ownership is:

| Original contract | Owning phase | Current state |
| --- | --- | --- |
| Omitted unrelated active arc survives scoped response | 1 | Converted to a passing behavior test |
| Returned section/identity outside captured scope is rejected | 1 | Converted to a passing behavior test |
| User edit between response and Apply requires renewed review | 1 | Converted to a passing public Apply-boundary test |
| Duplicate journey-subject selection cannot reach persistence | 2 | Still `test.fails`; Phase 2 alone owns its conversion |

The existing files named `test/story_planner_phase1.test.js` through
`story_planner_phase7.test.js` belong to the earlier Story Planner roadmap; their
numbers are not V3 delivery ownership. New V3 work uses feature-named suites from
§6.1 or an explicit `V3 Phase N` describe label. Do not infer that V3 Phase 2 has
shipped because a legacy file is named `story_planner_phase2.test.js`.

### Phase 0 - Diagnosis, fixtures, and request boundaries

**Purpose:** Confirm what testers actually hit, and pin invariants before adding
controls.

Work:

- **First, and before any Phase 3 work:** obtain one tester's actual plan and
  effective prompts. Determine whether a missing newcomer occurs *in the plan* or
  only in subsequent *narration*. These have entirely different fixes — planner
  prompt and palette versus the injection header and enforcement mode — and the
  current evidence does not distinguish them. **ANSWER** Missing newcomer *in the plan*
  - Evidence recorded 2026-09-19 from author side testing (consented). Default
    built-in prompts only — no tester so far uses a custom template, which also
    removes the custom-template confound. Palette: escalation `escalating` and
    `allowNewMajorCharacters` on, so the effective prompt carried *both* the
    built-in preference line ("Develop established threads and cast before
    adding new … major characters … a preference rather than a quota") *and* the
    single permissive palette line (`generation.js:68`). Safe Character Context:
    Active cast from Current Scene. The returned plan ("The First Monthly")
    develops only established participants — Rob, the Vanguard stack, the Tier
    Two paper — with unnamed incidental auditors; no named newcomer anywhere,
    while escalation surfaced as deepening existing threads (a possible audit
    finding, a scope argument) rather than cast expansion. Attribution holds:
    missing newcomer is planner-output behavior; fix direction is the Phase 3
    cast policy, not the injection header. Recorded 2026-09-19: build
    SillyTavern 1.19.0 / MWT 2.9.0; model GLM-5.3 via Z.AI directly; the arc
    was newly minted in a clean generation — no prior plan existed in that
    chat, so no carry-forward could suppress new proposals. The original
    generation produced 10 arcs; the tester's recollection is that none
    included a newcomer, but the original full plan was not retained. Available
    on request to verify: a fresh clean-chat regeneration (preserving the
    current generation), a targeted-develop sample, and an alternate-model
    sample. These are useful follow-up evidence, not Phase 0 exit blockers: the
    required stage attribution is already answered above.
- Inventory which surfaces consume title, body, beats, history, and closed
  memory. This is the prerequisite for Phase 4 and takes an afternoon.
  **Done 2026-09-19:** [STORY_PLANNER_PROJECTION_INVENTORY.md](./STORY_PLANNER_PROJECTION_INVENTORY.md).
- **Done 2026-09-19:** Add synthetic fixtures for section-only requests,
  one- and two-arc output, selected subjects, a newcomer-free response under
  active-proposal policy, and omitted context (`test/fixtures/story_planner_phase0.js`).
- **Done 2026-09-19:** Pin current full-plan and custom-template behavior as
  compatibility fixtures (`test/story_planner_phase0_v3.test.js`).
- **Done 2026-09-19:** Add expected-failure red specifications for an out-of-scope
  response handle or title, omission of unrelated arcs, duplicate subjects, and
  a user edit between response and Apply. These stay expected failures until the
  scoped request and ownership contracts land in Phases 1-3.
- Use consented or synthetic fixtures; no private campaign content in the repo.

**Exit:** The intended scope failures reproduce without a live model, the
existing planner baseline still passes, and the newcomer complaint is attributed
to a specific stage.

### Phase 1 - Scoped Add/Refresh and count-aware proposals

**Depends on:** Phase 0.

Work:

- **Done:** Raise the two count gates together: the `getArcCount()` clamp
  (`data.js:1070`) and the `validateOutput()` bullet minimum
  (`generation.js:205`). Validate against the captured requested count, not a
  fixed minimum. Overflow is measured from the parsed arcs by
  `selectScopedParsedArcs`, not from a bullet count — a bullet count also counts
  the beat bullets a model writes when it ignores the numbered beat format.
- **Done:** Emit only the selected section headings from the `SECTIONS`-derived
  prompt block. This covers the beat and sort rules too: naming a section in
  prose invites a heading the strict-heading validator then rejects.
- **Done:** Add the scope carry condition to `mergeRegeneratedArcs`'s options bag
  so out-of-scope active arcs are never deleted by omission. Note the resulting
  contract: `options.scope` does **not** filter. A scoped request carries every
  active arc it did not consume, in scope or out — out-of-scope arcs because the
  response was never allowed to address them, in-scope targets because omission
  is not permission to delete. Do not treat it as a selector in Phase 2/3.
- **Done, deliberately narrowed:** Generalise `targeted.js` from one captured arc
  to a captured set: proposal, diff, staleness, revalidation, and one atomic
  Apply. Do not duplicate it. `proposals.js` now owns the revision helpers,
  `buildArcDiff`, and `planScopedApply` — the single decision function that both
  the review preview and the write run, so a shown diff cannot drift from the
  change performed. The two Apply *entry points* stay separate on purpose:
  scoped Apply rebases a set against live storage, targeted Apply rebuilds one
  arc from its revision-checked source. Sharing the revision, diff, and decision
  layers is what this instruction was protecting; collapsing the two entry
  points would not have been.
- **Done:** Build the dialog and review flow, including rejected output and
  omitted targets. The review renders per-arc rows — a field/beat diff for a
  refreshed arc, the description and setup beats for a new one — rather than a
  whole-plan text diff, which made an ordering claim Apply never honours.
- **Done:** Add custom-template compatibility feedback and preserve the legacy
  full path. These are two requirements, not one: the whole-plan path is offered
  unconditionally, and the custom-template notice is what varies. Gating the
  path on a saved template leaves the default configuration — which is what
  every tester runs — with no whole-plan entry point at all.
- **Done:** Persist manual preferences separately from automatic scope. Existing
  automation stays public and full-plan until the user explicitly changes a
  supported setting; otherwise label scoped automation unavailable. Only the
  choices the dialog can make are persisted (`operation`, `sectionKeys`,
  `requestedCount`, `targetArcIds`); `subjectMode`/`subjectEntityIds` (Phase 2)
  and `castPolicy` (Phase 3) land with the phase that makes them real, each with
  its own migration. Until then `storyPalette.allowNewMajorCharacters` remains
  the only field driving cast expansion, and a second stored copy of that
  decision would be silently ignored.

**Exit — met by automated checks; live behavior unverified.**

- *A request for one Horizon Arc produces a reviewable one-arc proposal, and
  applying it cannot modify or delete another section* — met. Scoped Add is
  append-only and mints storage ids only at Apply
  (`test/story_planner_phase1.test.js`, `test/story_planner_phase0_v3.test.js`).
- *Refresh cannot delete omitted targets or add unrequested arcs* — met. Omitted
  targets are carried and unrequested rows are rejected before the merge; a
  Refresh that resolves to none of its targets is a failed operation rather than
  an empty review (`test/story_planner_phase0_v3.test.js`,
  `test/generation_commit_races.test.js`).
- *Empty, stale, failed, and discarded results change no arcs or history* — met.
  `reviewOnly` takes no history snapshot, and Apply revalidates chat scope and
  every captured target revision (`test/generation_commit_races.test.js`,
  `test/story_planner_phase2.test.js`).
- *Both built-in and supported custom paths demonstrate these properties* — met
  as §4.5 defines "supported": scoped generation is built-in only this release,
  so the custom path is the legacy full-plan path, pinned unchanged by the Phase
  0 compatibility fixtures. The built-in full-plan system prompt is asserted
  byte-identical to its pre-Phase-1 text.

**Phase 1 status (§8 record)**

- **State:** Implemented; not host verified.
- **Change reference:** `74ffa1b` (scoped generation engine, dialog, review),
  `8b75547` (scope and correctness fixes), `47f65e5` (shared diff/Apply
  decision).
- **Automated checks:** full suite green. Phase 1 behavior is pinned in
  `test/story_planner_phase0_v3.test.js`, `test/story_planner_phase1.test.js`,
  `test/story_planner_phase2.test.js`, `test/generation_commit_races.test.js`.
- **Known limitations at Phase 1 handoff:** no journey subjects (Phase 2) and
  no enforceable cast policy (Phase 3) — the dialog stated both at that time.
  **Later Phase 7 observation update (2026-09-24):** scoped requests are recorded
  as `scoped` by `recordPhase7Request`; their count and size are distinguished
  from legacy full-plan calls. This does not constitute Phase 1 host QA.
  Auto-generation remains full-plan and commits without review; this is now
  labeled in the dialog and in the Auto-Generate Interval help text rather than
  left for a user to infer from the manual path.
- **Manual results:** pending. The host-runtime checks in §6.2 and
  `STORY_PLANNER_PHASE7_DECISIONS.md` are unaffected by this phase's status.

**Carried into Phase 2 from the Phase 1 review:** one of the four Phase 0 red
specifications was flipped by this phase's behavior; the other three were
rewritten anyway, two into assertions that could not fail and one (duplicate
journey subjects, a Phase 2 contract) deleted outright. It is now restored to
`test.fails`. In vitest a `test.fails` that starts passing is reported as a
failure, so a phase landing will break exactly the specifications it satisfies —
convert those, and leave the rest red. The standing rules above govern that
conversion; this paragraph records why they were added.

### Phase 2 - Journey subjects and context coverage

**Depends on:** Phase 1.

**Purpose:** make journey ownership explicit and make public-context coverage
honest, without beginning cast-policy or private-author-context work.

Order within the phase is mandatory:

1. **2A — pin the real red boundary before code.** Replace the raw-array body of
   `duplicate journey subjects are rejected before persistence` in
   `test/story_planner_phase0_v3.test.js` with an assertion through the planned
   request/store canonicalization boundary, but keep `test.fails`. Run it once to
   prove the expected unique persisted-subject contract is not yet met for the
   reason Phase 2 intends to fix. Do not touch Phase 3 fixtures.
2. **2B — durable ownership.** Add bounded `primarySubjectEntityId` and
   `supportingParticipantEntityIds` fields with one versioned migration,
   canonicalization, validation, history signature, revert, backup/import
   merge-and-replace remapping, recovery, and manual editor support. Existing
   arcs migrate unassigned. Repeated raw participant IDs are deduplicated with a
   validation issue and never reach persisted preferences or arcs. Rename and
   merge use the shared identity service; deletion leaves a visibly unresolved
   reference. No prose or title inference fills a missing owner.
3. **2C — define and test the wire contract.** Issue bounded opaque handles for
   the captured registry candidates. A Character Journey response line carries
   exactly one primary marker and may carry supporting markers:

   ```md
   - [SUBJECT:s1] [SUPPORT:s2,s3] The Borrowed Seal — Mara's confidence is tested by Derek and the clerk.
   ```

   Resolve markers only through the captured handle map, strip them before title
   and body reach review, and persist only canonical entity IDs at Apply. A
   missing, unknown, duplicate, or non-captured primary handle rejects that row;
   duplicate supporting handles are collapsed and a primary repeated as support
   is removed with a visible diagnostic. Non-character sections may not carry
   these markers. In Selected mode a primary must be one of the selected IDs; in
   Any mode it may be any candidate in the bounded captured table. If that table
   is empty, explain that no assignable journey subject is available and do not
   make a Character Journey call.
4. **2D — selection and Refresh.** Keep Add count semantics global across the
   selected sections. When Selected mode contains N subjects, an Add request that
   promises one for each requires `requestedCount >= N`; every selected subject
   must appear at least once before extra valid proposals may repeat a subject.
   Missing coverage is an underfill diagnostic, not permission to substitute a
   different owner. Refresh eligibility matches the stored primary owner. A
   returned Refresh marker must match that captured owner; generation cannot
   reassign it. Manual assignment is the only way to set or change a legacy
   arc's primary owner. Supporting participants may change through a reviewed
   proposal when every returned handle resolves against the captured map.
5. **2E — context and prompt behavior.** Resolve selection through the shared
   entity/alias/merge services and explain missing or unavailable records;
   candidate listing already spans off-screen NPCs. Apply the subject/context
   independence rule in §4.3, prioritize only eligible public records, and show
   complete, partial, omitted-for-budget, missing-dossier, unavailable, and
   disabled coverage in both dialog and review. Preserve every existing
   public-context exclusion. Revise Character Journey prompts to support
   resistance, setbacks, deterioration, repair, and uncertain outcomes while
   restating the `{{user}}` agency prohibition.
6. **2F — close the owned red contract.** When the public-boundary assertion from
   2A begins passing and Vitest flags the unexpected pass, remove `test.fails`
   without changing its claim. Run the focused subject, schema, backup, identity,
   proposal, UI, and accessibility suites before the full suite and lint.

**Non-goals:** do not migrate `allowNewMajorCharacters`, persist or read
`castPolicy`, add newcomer/entrance markers, send private dossier fields, create
Knowledge records, redesign automatic generation, infer owners from prose, or
change an owner's canonical identity through model output.

**Exit:** Users can request one journey each for two named NPCs, and a third NPC
may appear as supporting cast without replacing either subject. Rename, merge,
removal, unavailable Knowledge, and an over-budget selection are handled visibly.
No title-based guess transfers ownership or progress. The Phase 2 red
specification is now a passing public-boundary test, while Phase 3 behavior
remains absent and unclaimed.

**Phase 2 status (§8 record)**

- **State:** Implemented; not host verified.
- **Change reference:** `a7ddd1f` (ownership fields, migration, wire contract,
  coverage), `1df9442` and `3471778` (coverage visibility and per-request
  context sources, from live testing), `HEAD` (review fixes below).
- **Automated checks:** full suite green; lint clean. Phase 2 behavior is pinned
  in `test/story_planner_phase0_v3.test.js`, `test/story_planner_phase2.test.js`,
  `test/story_planner_phase6.test.js`, `test/generation_commit_races.test.js`,
  `test/backup.test.js`, `test/schema_migrations.test.js`, and `test/plan.test.js`.
- **Red specifications and source assertions changed:** exactly one —
  `duplicate journey subjects are rejected before persistence`, which Phase 2
  owns. Its placeholder array body was replaced with an assertion through
  `validateStoryPlannerData`, checking both the deduplicated persisted arc and
  the `arc-participant-ids-deduplicated` repair issue; `fails` was removed only
  once that boundary passed. No Phase 3 fixture was touched, and no
  cross-cutting source assertion was changed.
- **Known limitations:**
  - An omitted `[SUPPORT:…]` marker means "unchanged", because the prompt states
    the marker is optional. Clearing an arc's supporting cast is a manual edit.
    A model cannot remove a supporting participant through a refresh.
  - With no tracked characters, Character Journeys is dropped from a
    multi-section request and reported in review; only a Journeys-only request
    fails. §5 2C's "do not make a Character Journey call" is read as dropping
    that call, not the whole request.
  - `listPlannerCharacterCandidates` no longer returns `[]` when Knowledge is
    globally disabled, so the subject picker and ownership editor list registry
    names in that state. Dossier content stays blocked in
    `buildPlannerCharacterContext`, and coverage reports every row as
    `disabled`. This is required to name a disabled row and is deliberate.
  - `renderArcOwnershipEditor` re-lists registry candidates once per Character
    Journey card per render, and the dialog's coverage panel rebuilds without a
    debounce — one `loadEntryContent` per selected character per toggle. Both
    are correctness-neutral and unmeasured; neither is a Phase 3 prerequisite.
  - Scoped requests are still recorded as `full` by `recordPhase7Request`
    (carried from Phase 1).
- **Manual results:** live testing found the coverage-visibility and
  per-request-context gaps fixed in `1df9442`/`3471778`. Host-runtime checks in
  §6.2 remain pending.

### Phase 3 - Cast policy and newcomer proposals

**Depends on:** Phases 1-2 and the Phase 0 attribution result.

**Purpose:** make cast expansion an explicit, observable request contract without
turning a proposed person into a canonical character or claiming prose-level
enforcement the application cannot perform.

Order within the phase is mandatory:

1. **3A — migrate policy ownership.** Replace `allowNewMajorCharacters` with the
   two deliberately workflow-scoped sources in §4.4. Both old boolean values
   migrate to `allowed` in `storyPalette.castPolicy`; existing manual scoped
   preferences also default to `allowed`. Remove the legacy boolean only after
   every built-in, targeted, custom-token, automatic, import, backup, and settings
   consumer uses its designated source. Tests must prove that changing the manual
   preference does not alter legacy/automatic behavior and vice versa.
2. **3B — construct each request explicitly.** Pin the effective behavior for
   manual scoped, legacy full, targeted, custom, and automatic paths. Built-in
   calls receive an application-owned policy clause. A custom full template gets
   it only through `{{storyPalette}}`; without that token, show incompatibility
   and do not claim the policy ran. Automatic generation with a non-`allowed`
   policy requires the built-in prompt or a compatible custom template; otherwise
   skip the call and explain the unsupported configuration.
3. **3C — parse and validate proposal-local evidence.** Implement the paired
   `[NEWCOMER:*]`/`[ENTRANCE:*]` contract from §4.4, including bounded handles,
   same-arc pairing, marker stripping, and review diagnostics. For reviewed paths,
   missing active-proposal coverage remains reviewable with an unmet-requirement
   warning. For direct-commit legacy or automatic paths, a required but missing
   pair, a malformed pair, or an `existing-only` marked newcomer fails before any
   arc/history write; report it once and make no repair call.
4. **3D — continuity and evaluation.** Include the ordinary title/body/beats of
   accepted newcomer arcs in bounded continuity so later refreshes see the person
   already proposed. Do not reconstruct stripped markers, invent a durable
   candidate ID, or claim exact deduplication from prose. Keep additions
   genre-sensitive, distinguish novelty from escalation, and exercise the
   established-but-unregistered and unmarked-prose limitations in human review.

**Non-goals:** do not create or update a Knowledge dossier, mark a newcomer as
introduced on-screen, add the deferred proposed-cast collection, infer novelty by
registry absence or name matching, enable private author context, add repair
calls, or change Phase 2 ownership semantics.

**Exit:** An accepted newcomer arc has a concrete entrance and creates no
canonical NPC automatically. Active-proposal mode reports whether a candidate was
returned. Existing-only rejects explicit newcomers; human review checks prose for
undeclared ones. Every generation path names its effective policy source and
either proves the paired-marker contract or reports that the path is unsupported.

**Phase 3A-3D status (§8 record)**

- **State:** Phase 3A, Phase 3B, Phase 3C, and Phase 3D implemented; not host
  verified.
- **Change reference:** `65b82e3` (3A), `1bccab9` (3B), `0c379ca` (3C), and
  current working tree (3D: newcomer continuity, novelty/escalation guidance, and
  planner-versus-narration attribution).
  Together these cover store v4 policy migration, independent
  scoped/palette controls, explicit per-workflow request contracts, custom-template
  compatibility reporting, automatic incompatibility skip, and focused regression
  coverage.
- **Automated checks:** the ten suites listed below green at 355/355; full suite
  green at 3,025/3,025; lint clean. Phase 3A-3D are
  pinned in `test/story_planner_cast_policy.test.js`,
  `test/story_planner_phase3c.test.js`, `test/story_planner_phase3d.test.js`,
  `test/story_planner_phase0_v3.test.js`, `test/story_planner_phase4.test.js`,
  `test/story_planner_phase6.test.js`, `test/schema_migrations.test.js`,
  `test/backup.test.js`, `test/backup_schema_roundtrip.test.js`, and
  `test/accessible_names.test.js`.
- **Migration result:** Story Planner store v3 migrates to v4. Both legacy boolean
  values become `storyPalette.castPolicy: allowed`; manual scoped preferences gain
  an independent `castPolicy: allowed`; the retired boolean is removed.
- **Request-construction result:** Manual scoped generation captures its dialog
  policy into the immutable request and always uses the built-in scoped envelope.
  Legacy full-plan and automatic generation capture Story Palette policy; built-in
  full prompts receive the application-owned clause, while custom full user prompts
  receive it only through `{{storyPalette}}`. Targeted operations use their fixed
  built-in prompt and Story Palette policy. The Generate dialog names the effective
  whole-plan source and reports an omitted token as unsupported. Automatic
  generation skips a non-`allowed` unsupported configuration before dispatch and
  reports why.
- **Proposal-evidence result:** Markdown generation and targeted JSON accept bounded
  proposal-local newcomer handles paired with exactly one concrete entrance beat in
  the same arc. Markers are stripped before review and persistence. Scoped reviewed
  Add requests show an unmet-requirement warning when active-proposal coverage is
  absent; Refresh and targeted review report that no suitable newcomer was proposed.
  Direct-commit legacy/automatic calls reject malformed pairs, missing required
  active-proposal coverage, and explicit newcomers under `existing-only` before any
  arc/history write, with no repair call. Overflow-only evidence does not satisfy a
  bounded scoped request.
- **Phase 3D continuity/evaluation result:** bounded read-only continuity now carries
  each active arc's ordinary title, body, and up to four ordinary beat texts, so an
  accepted newcomer arc and its concrete entrance remain visible to later scoped
  requests after proposal markers are stripped. The projection keeps complete arcs
  under a 16,000-character total cap and reports how many later arcs were omitted;
  the four displayed beats are a projection policy separate from the four-beat
  newcomer entrance validation contract. No candidate ID or newcomer field is
  reconstructed or persisted. Cast guidance separates novelty from escalation,
  explicitly permits genre-appropriate non-antagonist roles, and treats story-evidenced
  characters without Knowledge records as established. Proposal diagnostics and
  privacy-safe request outcome telemetry distinguish a planner-returned hypothetical
  newcomer from narration, which remains not evaluated or asserted.
- **Review fixes:** five defects found reviewing the four Phase 3 commits are
  closed. (1) The Markdown parser minted an entrance index for a marker-only beat
  before deciding whether that beat had any text, so `1. [ENTRANCE:n1]` on its own
  dropped the beat and transferred the entrance claim to the beat after it — a
  `propose` Add then reported "a paired concrete entrance beat" with no entrance
  beat at all, and a direct-commit path wrote it. A marked beat with no prose is
  now malformed. (2) Targeted JSON `title`/`description` were never marker-
  stripped, so a model that inlined `[NEWCOMER:n1]` alongside the field persisted
  it into a stored title — the merge key — and into narrator-visible text. Both
  fields now go through the arc-row extractor, which strips the markers and still
  evaluates an inline declaration rather than discarding it. (3) The same-arc
  pairing rules existed twice, verbatim, in the Markdown and targeted parsers;
  both now call one exported `newcomerPairingError` helper. Pinned by eight cases
  in `test/story_planner_phase3c.test.js`, seven of which fail against the
  pre-fix source; the eighth asserts both formats report one shared contract.
  (4) Generation now captures one immutable Story Palette snapshot before any
  awaited context work and reuses it for both the first request and retry. (5) An
  unmet active-proposal cast requirement is a dedicated `role="alert"` warning in
  scoped review rather than an undifferentiated diagnostics-list item.
- **Test-discipline record:** Phase 3A intentionally removed the Phase 0 boundary
  assertion that scoped preferences had no `castPolicy`, because Phase 3A owns that
  field. It also intentionally inverted the Phase 6 expectation that the built-in
  default palette emitted no `<story_palette>` block, because every built-in full
  and targeted request now receives the effective cast-policy clause.
- **Known limitations:** An invented person hidden in unmarked prose remains a
  documented human-review limitation; registry absence is not treated as proof of
  novelty, and exact prose deduplication is not claimed. Accepted arcs create no
  Knowledge record and do not assert that a newcomer has appeared on-screen.
- **Manual results:** Pending. Host checks should confirm dialog compatibility text,
  scoped and targeted review policy/source/evidence text, direct-commit rejection
  notices, marker-free reviewed content, and the automatic skip notice.

### Phase 4 - Opt-in author context (implemented, not host verified)

**Status (2026-09-22):** Separate opt-in Knowledge provider and per-NPC field
selection are implemented for reviewed scoped generation only. The major-NPC
picker is collapsed by default and bounded by scrolling; legacy whole-plan
regeneration does not use the selection. Private context is placed before the
prompt's closing format instruction on both attempts. The existing v4 store
retains the consent selection without a schema bump. Automated author-context
boundary, dossier-format, and review tests exist. Host/model testing and human
semantic-spoiler QA are still pending; no automated filter can guarantee that
a model draft contains only revealable text.

**Depends on:** Phases 1-2 and the completed Phase 0 projection inventory.

Order within the phase is mandatory: separate the author and public schema fields
and update every consumer *first*; prove with sentinel fixtures that private
values cannot reach a public serializer; only then add the Knowledge
author-context provider and field opt-in; only then enable generation through the
reviewed workflow, disabled for legacy, unstructured, and unattended automatic
paths. A full-dossier projection needs the block-boundary parser noted in §2 and
must fail closed on an unrecognised boundary.

**Exit:** Dossier secrets can inform a reviewed character proposal while
author-only values stay out of narrator payloads, public memory, macros, exports,
progress-check inputs, logs, and telemetry. Human QA verifies semantic spoilers
that structural tests cannot prove absent.

### Phase 5 - Arc quality: dramatic question, causal beats, concrete turning point

**Depends on:** Phases 1-3 — it tightens the shared full-plan prompt, the
targeted `develop`/`rework` instructions, and the Character Journey and cast
clauses those phases shipped. Independent of Phase 4; it touches prompt prose
only and needs no author-context work.

**Purpose:** Phases 0-3 answer *what* a request covers and *who* owns it. Tester
feedback exposed a separate axis: whether the returned proposal contains a
satisfying story to develop. Reported plans were bland or repetitive — setup
beats that re-demonstrate one trait, or list routine logistics, under a
destination too loose to build toward.

Two observed examples fix the target. A Character Journey ("Derek Holds Still")
whose four beats each show the same restraint with a different prop — reorderable,
so none of them changes the situation. A Horizon Arc ("Old Chem Breaks Ground")
whose beats are procurement logistics — a fax, a pinned sheet, a chalked name, a
rental meter — with no dramatic question. Both are **beat** failures, not
destination failures: "Derek Holds Still" even names its pressure in the body.

This matters because the destination-quality language already shipped and did not
catch them. The Character Journey clause in `generation.js` already asks the model
to "pressure a value… possible consequences. Resistance, relapse, deterioration,
repair…"; that governs `arc.body`, which was not the weak point. Nothing yet
governs beat-to-beat causal progression. The single beat rule in
`buildStoryPlanSystemPrompt` (`prompts.js`) — "Order them so each one only makes
sense after the previous" — is satisfiable by four interchangeable demonstrations.

**Prerequisite evidence, before any prompt edit (mirrors Phase 0):** obtain at
least one plan generated on the *current* build, because the reported screenshots
may predate the Phase 2/3 journey and cast revisions. The zero-code probe is the
Direction Hint, which is user-editable free text (`{{directionHint}}` in
`prompts.js`): have testers paste the trial paragraph below and regenerate, then
attribute the residual weakness to the destination (body) or the beats before
promoting any language into the prompt files.

Trial Direction Hint (the experiment that preceded the code change):

> Give each developed arc a clear dramatic question, a concrete turning point, and
> meaningful possible consequences. Establish what it builds toward before choosing
> its setup beats. Each beat should change the situation through new information,
> pressure, opportunity, or consequence; avoid repeated demonstrations of the same
> trait and routine logistics without narrative effect. Quiet arcs may culminate in
> an admission, boundary, discovery, or changed relationship. Preserve player agency
> and leave uncertain outcomes open.

Work (promote only what the evidence supports; all are writing requirements, no
fields):

- **Strengthen the shared beat rule** (the `beatsRule` string in
  `buildStoryPlanSystemPrompt`, `prompts.js`). Require each beat to change the
  situation — add new information, a cost, a complication, a pressure, or an
  opportunity — and explicitly reject another instance of the same behavior and
  routine logistics with no narrative effect. This is the single lever that
  addresses both example failures, and it covers every section because the rule is
  shared.
- **Strengthen the destination spec** (the bullet-format line, currently "1-2
  sentences naming the central shift"). Ask for the dramatic question, a concrete
  turning point, and possible consequences. The turning point maps to `arc.body`,
  which the Ready mechanism already surfaces as the payoff (`injection.js`). **Do
  not move the payoff into a setup beat** — the existing Ready boundary is what
  keeps a climax out of the `NOW:` line, and collapsing it would leave Ready
  nothing to do.
- **Carry the same vocabulary into the targeted instructions**
  (`TARGETED_OPERATION_INSTRUCTIONS.develop` and `.rework`, `prompts.js`). "Develop
  this arc" currently says "improve its description/endpoint" without defining
  *better*; give it the dramatic-question/turning-point/consequence language so the
  action has purchase. `rework` preserves the endpoint, so its beat replacement
  must obey the strengthened beat rule.
- Restate, do not duplicate. The journey clause in `generation.js` keeps ownership
  of the pressure/consequence language for Character Journeys; Phase 5 adds the
  *beat-progression* requirement the shared rule now owns and does not fork a second
  copy of the destination language into the journey clause.

**Non-goals:**

- **Two-pass generation** — naming the turning point in a first call and building
  setup toward it in a second. It is the right eventual design and the wrong first
  slice: it complicates the single-call flow deliberately kept cheap. Deferred to
  §7, gated on evidence that the writing requirements above were insufficient.
- No new schema field, migration, UI control, or per-arc quality score, and no
  model self-evaluation pass. The five questions are writing requirements this
  release, not five stored fields.
- No change to the Ready/payoff boundary, injection framing, or enforcement modes.

**Exit (evaluated on real examples, not prompt-contains-phrase tests):** across
quiet-character, relationship, mystery, and adventure arcs, a generated plan shows
a clear dramatic question, setup beats that each change the situation rather than
re-demonstrating a trait or listing logistics, and a turning point distinct from
its setup. Automated tests may pin only that the clauses are wired into the correct
prompts and stay within scope (no beat-rule text leaking into an Immediate-Hooks-
only request, per the existing strict-heading discipline); §6.1's own caveat
applies — a prompt-phrase assertion is not behavior. The behavioral acceptance is
the existing §6.2 rows "Quiet or restrained character journey" and "Four genres,
allowed versus actively-propose," which this phase gives content to.

**Phase 5 status (§8 record)**

- **State:** Implemented; not host verified.
- **Prerequisite evidence (recorded 2026-09-22; author-side trial plus tester
  reports on the current build):** the trial Direction Hint improved plans both
  before and after Phase 4 landed. Before Phase 4, hinted beats were much improved
  but still leaned toward logistics. After Phase 4, the unhinted baseline improved
  only for NPCs with author context opted in (every field group except the
  Knowledge Ledger); with the hint, every character and plan improved, matching the
  pre-Phase 4 hinted result. Attribution: author context and the writing
  requirements are independent levers. Context gives the model stakes to build from
  where it exists; the writing requirements help every plan. All three Work items
  were promoted. The logistics clause is more concrete than the hint's ("only moves
  paperwork, schedules, or equipment without consequence") because hinted beats
  still drifted toward logistics. Further tester screenshots are being collected.
- **Change reference:** current working tree. `ARC_DESTINATION_RULE` and
  `BEAT_PROGRESSION_RULE` are exported from `prompts.js` and are the single owner of
  the wording for both the full-plan builder and `TARGETED_ARC_SYSTEM_PROMPT`.
  `TARGETED_OPERATION_INSTRUCTIONS.develop` now defines a stronger arc. `rework`,
  `setup`, and `alternate` are unchanged: the shared system rules already govern
  their beats, and `targeted.js` rebuilds a preserved description from the source
  arc whatever the model returns. The worked example's description now models a
  want and a turning point that could go either way; its beats were already
  consequential and are unchanged. A Hooks-only request keeps its previous one-line
  description rule and receives neither shared rule; a mixed request exempts hooks
  explicitly.
- **Automated checks:** `test/story_planner_arc_quality.test.js`, seven wiring and
  scope tests. Two planted bugs (an unconditional hook exemption and a dropped
  targeted beat rule) each failed the suite before being reverted. Full suite green
  at 3,076/3,076; lint clean.
- **Red specifications and source assertions changed:** none. The existing prompt
  pins (`story_planner_phase0_v3.test.js` scope and Hooks-only cases,
  `story_planner_phase4.test.js` targeted request) pass unchanged.
- **Known limitations:** wiring tests cannot show model behavior; the effect is
  confirmed only on live generations. A saved custom full-plan system prompt still
  replaces the built-in one on the whole-plan path and receives none of these
  rules; scoped and targeted requests always use the built-in rules. Testers who
  pasted the trial paragraph into Direction Hint should clear it, or the request
  carries the same instructions twice.
- **Manual results:** Direction Hint trial positive (above). A post-change
  regeneration without the hint, checked against the §6.2 "Quiet or restrained
  character journey" and genre rows, is pending.

## 6. Acceptance and test plan

### 6.1 Deterministic tests

| Area | Required cases |
| --- | --- |
| Scope and counts | One/two arcs; both count gates; multiple sections; empty selection; underfill and overflow; wrong section; Refresh omission; returned unrelated handle or title; Add cannot replace an existing arc |
| Merge boundary | Out-of-scope arc with no planted beats survives omission; pinned, parked, and closed carry unchanged; scoped Add cannot delete; legacy full-plan merge behavior unchanged |
| Concurrency | Chat switch; target edit or delete; unrelated edit or new arc; focus and park change; entity merge; panic and cancellation; source deleted after proposal but before Apply |
| Identity and progress | Historical beats immutable; no false Ready on omitted setup; duplicate handles and IDs; closed recurrence; legacy unassigned subject |
| Subjects and context | Duplicate and missing subjects; supporting cast; off-screen selection; Knowledge unavailable; record and field budget; long canon constraint |
| Cast policy | Policy migration from both old boolean values; explicitly forbidden newcomer; active-proposal underfill; untracked but established character; missing entrance beat |
| Storage and recovery | Versioned migrations idempotent; bounded fields; future-version schema gate; history signatures; revert; backup merge/replace ID remaps |
| Custom and API | Missing tokens; mandatory scope validation; parsed count; bounded retries; no hidden fan-out; telemetry contains no content |
| UI and accessibility | Keyboard and touch selection; labeled NPC controls; modal focus trap and restore; clear busy and stale state; narrow layout; non-color status |

Baseline coverage lives in `test/story_planner_phase1.test.js` through
`story_planner_phase7.test.js`. Relevant shared suites:
`generation_commit_races.test.js`, `schema_migrations.test.js`,
`backup_schema_roundtrip.test.js`, `import_export_roundtrip.test.js`,
`injection_diagnostics.test.js`, `budget.test.js`,
`modal_accessibility.test.js`, and `accessible_names.test.js`.

Suggested new suites: `story_planner_scoped_generation.test.js`,
`story_planner_journey_subjects.test.js`, and `story_planner_cast_policy.test.js`.

Run focused tests per slice, then `npm test` and `npm run lint` before handoff.
A test asserting that a prompt contains a phrase does not demonstrate model
behavior; pair request-construction tests with malformed-response fixtures.

### 6.2 Host-runtime and model evaluation matrix

All results start **Pending**. Record build, model/provider/settings, custom
versus built-in prompt, fixture, outcome, and privacy-safe diagnostic counts.

| Scenario | Observe | Result |
| --- | --- | --- |
| Short chat, one selected section | Add 1-2 arcs, preview/apply/discard, unrelated plan unchanged | Pending |
| Long campaign | Context omissions, old closed ideas, refresh stability, request size | Pending |
| Two selected NPCs plus supporting cast | Ownership, off-screen subject, rename and merge | Pending |
| Four genres, allowed versus actively-propose | Distinct roles, actionable entrances, genre fit | Pending |
| Quiet or restrained character journey | Pressure without forced escalation, forced improvement, or player-authored response | Pending |
| Migrated v1/v2 history and restored backup | Stable IDs and progress; new fields round-trip | Pending |

Also exercise swipes, message edits and deletes, chat switching, disabled
trackers, the panic switch, and Budget enforce/observe with a proposal dialog
open. Inspect the actual post-Budget narrator payload, not the pre-Budget preview.

## 7. Migration, compatibility, and deferred work

Migration rules:

- Pick schema versions from what actually ships when each phase lands; do not
  reserve "schema v3" for every slice because the document is called V3.
- Update canonicalization, validation, defaults, history signatures,
  import/export, backup merge/replace, recovery, and the manual arc editor together.
- Preserve unknown future-version stores through the existing schema gate.
- **No migration reads prose to invent subjects, satisfied prerequisites,
  disclosed secrets, introduced candidates, or confirmed events.**
- Remap all arc and entity references consistently on restore or import;
  unresolved references stay explicit and non-executable.
- Existing automatic full generation cannot erase new ownership fields. Every old
  path must preserve them, or protect the record and show the limitation.
- Preserve the existing public-only context tests. Later author-mode tests
  supplement them and must not weaken their expectations.

Deferred, with a decision gate rather than a schedule:

- **Independent type and horizon.** Add a type (plot, character, callback) and an
  independent horizon (immediate, emerging, horizon, unspecified) as one record
  with a legacy section adapter, so "long-range character journeys" becomes a
  supported query without duplicating or double-injecting an arc. Migrate
  conservatively; never infer a horizon from prose. *Gate:* users asking for it
  after Phase 2 ships.
- **Execution prerequisites.** Separate setup completion from permission to
  execute, with user-confirmed conditions and resolved-arc references,
  all-execution versus payoff-only gates, and cycle rejection, so a setup-complete
  arc can wait without injecting its payoff. *Gate:* observed frequency of
  premature Ready arcs.
- **Release flags and staged disclosure.** Release permission bound to a reviewed
  text revision, author-inclusive export modes, and author memory in later private
  calls. *Gate:* Phase 4 shipping, plus users wanting to stage a reveal.
- **A proposed-cast collection.** Planner-local candidate IDs preserved through
  rename, history, and backup, with explicit linking to a Knowledge NPC.
  *Gate:* wanting to promote a newcomer into a dossier.
- **Turning-point-first (two-pass) generation.** A first call names each arc's
  dramatic turning point; a second builds setup toward it. *Gate:* evidence from
  Phase 5 that single-call writing requirements did not remove bland or repetitive
  beats.
- Automatic interpretation of free-text prerequisites; automatic secret release,
  dossier creation, or introduction confirmation; automatic private-author refresh
  or unattended application of proposals; a second model call to summarize every
  dossier or repair every unmet quota; a branching story graph; fuzzy identity or
  progress transfer.

Observe before extending: newcomer proposal rate versus introduction rate,
subject coverage failures, stale and rejected proposal rates, request cost,
accepted useful arcs, and whether users repeatedly need unsupported custom
formats. Record the evidence and the decision rather than changing defaults on a
prompt fixture alone.

## 8. Handoff and completion criteria

Start with Phase 0 — especially the newcomer attribution, which may change Phase
3's content. Then deliver scoped Add/Refresh, then subject ownership and
coverage, then cast policy. Agree the public/author record contract before
enabling any private field.

For each phase record **Not started / In progress / Implemented / Host verified**
with its change reference, automated checks, known limitations, and manual
results. "Implemented" is not evidence that live model behavior or host UI passed.

Phases 0-3 are complete when:

- users can generate or refresh only their chosen sections and subjects;
- one- and two-arc requests work without accidental whole-plan mutation, and no
  out-of-scope arc is lost to omission;
- journey ownership is explicit, survives rename and merge, and is never guessed;
- character journeys support resistance and uncertain outcomes without authoring
  the player's response;
- cast policy has visible, tested behavior, actively-proposed newcomers carry a
  concrete entrance beat, and they remain hypothetical until explicitly established;
- custom prompts, context omissions, and unsupported paths are understandable;
- identity, historical progress, migrations, backups, accessibility, diagnostics,
  and cross-chat protections cover all new records;
- automated checks and the applicable host matrix have recorded results.
