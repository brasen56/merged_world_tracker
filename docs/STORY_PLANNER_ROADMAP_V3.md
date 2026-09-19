# Story Planner V3: scoped generation, character journeys, and cast policy

**Status:** Proposed implementation roadmap; no V3 phases completed
**Date:** 2026-09-19
**This revision covers:** Phases 0-3. Phase 4 (opt-in author context) is a
sketch pending the Phase 0 projection inventory. Independent arc classification
and execution prerequisites are deferred in §7.
**Audience:** Implementer, co-author, and roleplay testers
**Sources:** Tester feedback on the shipped Story Planner, plus a review of the
current implementation at the file references cited throughout §2.

V3 names the third Story Planner product/design revision. It does **not** name
the store schema version or extension release. The current store is schema v2;
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
| Use full major-NPC dossiers | Opt-in author context with a reviewed-public output contract | 4 (sketch) |
| Character journeys are also near- or long-term arcs | Independent type and horizon | Deferred (§7) |
| Setup complete does not always mean usable now | Execution prerequisites separate from setup completion | Deferred (§7) |

First release is Phases 0-3. Phase 4 requires the projection inventory produced
in Phase 0 and is not a prerequisite for anything above it.

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

### 4.1 Generate dialog and request specification

The primary Generate action opens a compact dialog containing:

- operation: **Add ideas** or **Refresh selected arcs**;
- section checkboxes, initially all five;
- requested count, from 1 to 30, for Add;
- Journey subjects when Character Journeys is selected: Any subject or Selected NPCs;
- cast policy and the existing palette/direction controls;
- context mode and coverage summary;
- a summary such as "Add 2 Character Journeys for Mara; use public context".

Remember ordinary manual choices per chat. Auto-generation keeps its own saved
scope; changing a manual dialog must not silently reconfigure automation. Retain
a clearly labeled legacy full-plan regeneration path during transition; its
behavior is not silently redefined by the scoped implementation. New dialogs
default to Add and Any subject, and preserve existing public-context selections
on upgrade.

Capture one immutable request specification at dispatch:

```js
{
  operation: 'add',            // add | refresh
  sectionKeys: ['character'],
  subjectEntityIds: [],        // empty = Any subject
  requestedCount: 2,           // Add only
  targetArcIds: [],            // exact captured Refresh set
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

### 4.6 Phase 4 sketch: opt-in author context

Not designed in detail until the Phase 0 projection inventory exists. The shape:

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
    sample.
- Inventory which surfaces consume title, body, beats, history, and closed
  memory. This is the prerequisite for Phase 4 and takes an afternoon.
  **Done 2026-09-19:** [STORY_PLANNER_PROJECTION_INVENTORY.md](./STORY_PLANNER_PROJECTION_INVENTORY.md).
- Add fixtures for section-only requests, one- and two-arc output, selected
  subjects, a newcomer-free response under active-proposal policy, and omitted
  context.
- Pin current full-plan and custom-template behavior as compatibility fixtures.
- Add red tests for an out-of-scope response handle or title, omission of
  unrelated arcs, duplicate subjects, and a user edit between response and Apply.
- Use consented or synthetic fixtures; no private campaign content in the repo.

**Exit:** The intended scope failures reproduce without a live model, the
existing planner baseline still passes, and the newcomer complaint is attributed
to a specific stage.

### Phase 1 - Scoped Add/Refresh and count-aware proposals

**Depends on:** Phase 0.

Work:

- Raise the two count gates together: the `getArcCount()` clamp (`data.js:1070`)
  and the `validateOutput()` bullet minimum (`generation.js:205`). Validate
  against the captured requested count, not a fixed minimum.
- Emit only the selected section headings from the `SECTIONS`-derived prompt block.
- Add the scope carry condition to `mergeRegeneratedArcs`'s options bag so
  out-of-scope active arcs are never deleted by omission.
- Generalise `targeted.js` from one captured arc to a captured set: proposal,
  diff, staleness, revalidation, and one atomic Apply. Do not duplicate it.
- Build the dialog and review flow, including rejected output and omitted targets.
- Add custom-template compatibility feedback and preserve the legacy full path.
- Persist manual preferences separately from automatic scope. Existing automation
  stays public and full-plan until the user explicitly changes a supported
  setting; otherwise label scoped automation unavailable.

**Exit:** A request for one Horizon Arc produces a reviewable one-arc proposal,
and applying it cannot modify or delete another section. Refresh cannot delete
omitted targets or add unrequested arcs. Empty, stale, failed, and discarded
results change no arcs or history. Both built-in and supported custom paths
demonstrate these properties.

### Phase 2 - Journey subjects and context coverage

**Depends on:** Phase 1.

Work:

- Add the bounded ownership and participant fields with their migration,
  canonicalization, backup/import, history signature, and restore support.
- Add subject handles, primary-owner validation, manual assignment for legacy
  arcs, and per-character filtering and Refresh.
- Resolve selection through the shared entity/alias/merge services and explain
  missing or unavailable records. Candidate listing already spans off-screen NPCs.
- Prioritize subject context and show complete, partial, and omitted coverage in
  the dialog and proposal review. Preserve existing public-context exclusions.
- Revise character-journey prompts to support resistance, setbacks,
  deterioration, repair, and uncertain outcomes while protecting player agency.

**Exit:** Users can request one journey each for two named NPCs, and a third NPC
may appear as supporting cast without replacing either subject. Rename, merge,
removal, unavailable Knowledge, and an over-budget selection are handled visibly.
No title-based guess transfers ownership or progress.

### Phase 3 - Cast policy and newcomer proposals

**Depends on:** Phases 1-2 and the Phase 0 attribution result.

Work:

- Migrate the boolean to the explicit policy and make its effective behavior
  clear for full, scoped, targeted, custom, and automatic paths.
- Require and validate a concrete entrance beat on an actively-proposed newcomer.
- Check active-proposal coverage; show a missing-newcomer result rather than
  claiming success or silently re-calling the model.
- Include newcomers already present in the plan in bounded continuity context, so
  a refresh develops one rather than inventing another equivalent person.
- Keep additions genre-sensitive and distinguish novelty from escalation.

**Exit:** An accepted newcomer arc has a concrete entrance and creates no
canonical NPC automatically. Active-proposal mode reports whether a candidate was
returned. Existing-only rejects explicit newcomers; human review checks prose for
undeclared ones.

### Phase 4 - Opt-in author context (sketch)

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
