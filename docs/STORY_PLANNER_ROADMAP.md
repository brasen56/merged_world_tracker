# Story Planner reliability and creative-control roadmap

**Status:** Canonical implementation roadmap
**Date:** 2026-09-14
**Sources:** `STORY_PLANNER_IMPROVEMENT_ROADMAP.md` and co-author review, 2026-09-14
**Area:** Story Planner, Knowledge context projection, backup/restore, schema migrations, Budget, and Injection diagnostics

The original improvement roadmap is retained as the historical design source. This
document incorporates its detailed contracts and phase work together with the
review findings, corrected sequencing, reproduced regressions, and additional
guardrails below.

## 1. Goal

Make Story Planner easier to maintain through a long roleplay and less likely to
repeat, lose, or prematurely force its ideas. The planner should preserve what
actually happened, remember what the user rejected, let useful ideas wait without
becoming noise, and provide fine-grained ways to develop an arc without replacing
the whole plan.

The current core idea remains unchanged: long-range arcs contain concrete setup
beats, the narrator sees only the current beat, and an arc becomes **Ready** once
its setup is complete. This roadmap strengthens the identity and lifecycle around
that mechanism rather than replacing it.

## 2. Current baseline

The module already provides:

- five time-horizon sections;
- structured arc cards with title, description, section, status, and pinning;
- ordered setup beats with planted/back controls and overdue reminders;
- Ready promotion after every beat is planted;
- All, Pinned, and Active injection modes plus Passive, Proactive, and Assertive push;
- continuity-aware full-plan regeneration;
- a per-chat direction hint and configurable arc count;
- manual arc creation, history/revert, injection preview, automatic generation,
  custom prompts, and shared prompt-budget enforcement;
- factual World State and latest-Chronicle grounding;
- scope/revision guards around asynchronous generation and schema-gated storage.

Relevant seams:

- `story_planner/schema.js` owns the canonical arc shape, parser, and store schema.
- `story_planner/data.js` owns arc mutations, beat progress, regeneration merge,
  settings resolution, reminders, and history.
- `story_planner/generation.js` owns context construction, output validation, and
  the full-plan generation commit.
- `story_planner/injection.js` owns selection and the narrator-facing projection.
- `story_planner/render.js` owns cards, settings, previews, and history UI.

The existing planner-focused regression set passed at review time: 136 tests in
`plan.test.js`, `beats.test.js`, `tier3_fixes.test.js`, `tier4_fixes.test.js`,
`tier5_regression_net.test.js`, and `world_state_phase5_bugs.test.js`.

## 3. Problems this roadmap addresses

### 3.1 Beat progress is positional

An arc currently stores `beats: string[]` and one `beatIndex`. During full-plan
regeneration, the new beat list replaces the old one while the numeric index is
retained and clamped. If the model rewrites or reorders the list, an unrelated new
beat can occupy an already-planted position and silently count as completed.

### 3.2 Closed ideas are not durable planning memory

Resolved and dropped arcs leave narrator injection, as intended, but a later
regeneration may remove them from storage. Dropped arcs are also omitted from the
generation context. The planner can therefore suggest the same rejected or paid-off
idea under a slightly different name.

### 3.3 Beat maintenance is incomplete in the UI

The card shows the current beat and supports planted/back. It does not expose the
full sequence for editing, insertion, deletion, reordering, or an explicit
"skipped/obsolete" result. A manually added long-range arc cannot be given a beat
sequence from the normal card UI.

### 3.4 Active is doing too many jobs

An arc may be good but irrelevant to the current scene. Today the choices are to
leave it Active, Resolve it, Drop it, delete it, or rely on Pinned-only injection.
There is no lifecycle state meaning "keep this idea, but stop aging, reminding,
and injecting it until I return to it."

The All and Active injection modes are also behaviorally equivalent: every
resolved and dropped arc is excluded before mode selection, so both modes select
the same active arcs.

### 3.5 Regeneration is too broad

A weak pending beat, underdeveloped character arc, or good premise with a poor
route currently requires manual editing or a full-plan generation. Full refreshes
increase churn and expose every arc to merge ambiguity when only one needs help.

### 3.6 Manual confirmation is reliable but easy to forget

Only the user can currently confirm that a beat landed. When they forget, the same
NOW instruction remains injected and eventually becomes overdue even if the event
already happened on-screen.

### 3.7 The default creative brief favors escalation

The built-in prompt emphasizes major shifts, new character introductions, and
escalating conflict. That is useful for momentum, but repeated generations can
crowd out quiet character moments, consequences, relationship repair, discovery,
and alternate outcomes. The direction hint can compensate, but only through
free-form instructions the user has to rewrite for each chat.

### 3.8 Ready arcs can remain in the prompt indefinitely

Ready arcs age internally but do not currently receive an overdue reminder, appear
in `/wt-beat`, or have a command-level path to Resolve. If the payoff already
happened and the user missed the card action, the narrator can continue treating
the same Ready arc as available on every turn.

### 3.9 Lifecycle transitions are inconsistent

The data-layer status transition helper resets age and reminder state when an arc
is reopened, but the card status dropdown writes status directly. Reopening from
the UI can therefore preserve an old age and trigger an immediate reminder.

### 3.10 In-flight deletion can resurrect an arc

Regeneration rebases against current arcs, but a deleted arc returned by the model
can be added as a new arc. A user deletion made while generation is in flight must
be treated as an explicit forget action and must not be undone by the response.

## 4. Decisions this roadmap adopts

1. **User-confirmed story state remains authoritative.** Automatic progress
   checking may propose a change with evidence; it never plants a beat, resolves
   an arc, or drops an idea without acceptance.
2. **Completed setup is immutable during model regeneration.** A model may replace
   pending beats. It cannot rewrite history or transfer completion by position.
3. **Closed means remembered; delete means forgotten.** Resolved and dropped arcs
   stay in a collapsed archive view and a bounded generation-memory projection.
   Explicit deletion remains the way to remove the record entirely.
4. **Pin, park, and focus are separate concepts.** Pin controls survival through
   regeneration, Park controls lifecycle activity, and Focus controls present
   narrative attention.
5. **No extra automatic model call is enabled by default.** Progress checking is
   manual first. A later automatic cadence is opt-in and justified by measurements.
6. **Targeted generation always produces a reviewable proposal.** It does not
   commit directly after the API response.
7. **Planner grounding receives a purpose-built safe projection.** It never reads
   NPC secrets, Knowledge Ledgers, private intentions, or Interiority thoughts.
8. **Creative controls start small.** Add a compact story palette rather than a
   second settings workspace. Keep the direction hint as the escape hatch.
9. **The current Markdown full-plan format remains supported.** Built-in prompts
   can carry stable identity markers, while custom prompts retain a conservative
   title-match fallback.
10. **Stored history is complete; prompt projections are bounded.** Do not delete
    user planning records merely to save prompt tokens.

11. **Reminder age has one explicit meaning.** `turnsSinceAdvance` measures turns
    since the current beat became current, or since the arc became Ready. Editing
    the current beat or reopening an arc resets the age; merely regenerating or
    auto-generating does not. This keeps overdue reminders meaningful for users
    who use automatic generation.

## 5. Target data and behavior contract

### 5.1 Arc shape

The Story Planner store moves from schema v1 to v2. The exact property names may
change during implementation, but the semantics should remain:

```js
{
  id: "arc-...",
  title: "The Rival's Gambit",
  body: "A competitor makes a decisive public move.",
  section: "emerging",
  status: "active", // active | parked | resolved | dropped
  pinned: false,
  focused: true,
  closeReason: "",
  closedAt: null,
  beats: [
    {
      id: "beat-...",
      text: "A servant mentions the rival leaving before dawn.",
      state: "planted", // pending | planted | skipped
      stateReason: "",
      updatedAt: 0
    },
    {
      id: "beat-...",
      text: "A damaged shipment arrives.",
      state: "pending",
      stateReason: "",
      updatedAt: 0
    }
  ],
  turnsSinceAdvance: 0,
  createdAt: 0,
  updatedAt: 0
}
```

Rules:

- the first pending beat is the current beat;
- planted and skipped beats are historical records and never become current again
  unless the user explicitly changes their state;
- an arc with at least one beat and no pending beats is Ready;
- changing the current beat resets `turnsSinceAdvance`;
- Active arcs age and may inject; Parked, Resolved, and Dropped arcs do neither;
- pinning does not override lifecycle exclusion from injection;
- focus does not imply pinning and does not prevent regeneration;
- resolving or dropping records a reason when provided;
- reactivating a closed arc clears its close timestamp, resets its current-beat
  age, and preserves the close/reopen event in history.

### 5.2 Stable identity during generation

The default full-plan prompt should carry short, opaque per-request arc handles in
machine-readable annotations that are absent from user and narrator projections.
Beat identifiers do not need to be exposed in the Markdown prompt. The captured
arc handle establishes the merge boundary; stored planted/skipped beat objects are
preserved exactly and pending output is matched conservatively within that arc.
On merge, identity resolution follows this order:

1. a valid arc handle emitted from the built-in prompt;
2. an unambiguous exact normalized title match for compatibility;
3. a new arc identifier.

Within a matched arc, pending beats use an unambiguous exact normalized text match
when possible. Otherwise they receive new identifiers and cannot inherit planted
or skipped state.

Do not use fuzzy semantic matching to transfer planted state automatically. A
similarity match may be shown in a proposal UI, but ambiguity must never rewrite
history or award progress.

If the model omits every handle, the existing title fallback keeps custom and less
compliant models usable. Missing, forged, duplicated, or cross-chat handles must
fail safely; fuzzy semantic matching must never transfer progress automatically.
Planted/skipped beats from the stored arc are still preserved exactly; only the
pending suffix is eligible for replacement.

### 5.3 Closed memory

Resolved and dropped arcs remain ordinary canonical records with their status,
reason, and timestamps. The UI presents them in a collapsed Archive view rather
than intermixing them with actionable cards.

Generation receives a bounded `<closed_story_ideas>` projection containing the
most recently closed titles and concise reasons. The projection is bounded by
whole records, with separate limits for record count and characters/tokens. It
communicates:

- resolved: this payoff already happened; do not propose it again;
- dropped: the user rejected this direction; do not rephrase it as a new idea.

Pinned closed records rank first, then recently closed records. Closed beat lists
are not sent in the generation-memory projection. Omitted records stay stored and
visible. The injection preview and narrator prompt never include this archive.

### 5.4 Pacing and selection

Replace the redundant selection choices with:

- **All active** — every Active arc;
- **Pinned only** — Active and pinned arcs;
- **Focused only** — Active and focused arcs.

The legacy stored `active` mode resolves as `all` and may be normalized during
the v2 migration. Focused arcs sort before non-focused arcs in generation and in
All-active injection. Recommend one to three focused arcs in help text, but do not
hard-cap the user's selection.

Parked arcs survive full regeneration without entering narrator injection, beat
aging, overdue counts, or reminders. An optional `activateWhen` note may be added
for the user's memory, but automatic wake-up is outside the initial phase.

## 6. Delivery plan

Each phase should land independently. The pre-phase patches and Phases 0–2 are
the reliability foundation; later phases can be scheduled according to user
demand.

### Pre-phase patch 1 — Progress and commit-race safety

Ship these fixes against the existing v1 store before migration:

- Preserve the stored planted beat prefix exactly during regeneration.
- Remove normalized copies of planted beats from model output before replacing
  the pending route.
- If the model returns no usable pending route, retain the stored pending beats;
  regeneration can never complete setup or mark an arc Ready by omission.
- If the stored arc is already Ready, ignore model beat output for its setup.
- Preserve the existing age unless the current beat actually changes.
- Capture deletion and edit revisions at generation start. If an arc was deleted
  while the request was in flight, do not recreate it from the response. If it was
  materially edited, keep the user version rather than silently overwriting it.

Run the new regression fixtures red before the fix. This patch intentionally makes
no store or UI change.

Exit criteria:

- the two reproduced positional-progress cases cannot produce false Ready state;
- deleted or materially edited arcs cannot be resurrected or overwritten by an
  in-flight response;
- existing v1 fixtures and the full planner regression set remain green.

### Pre-phase patch 2 — Lifecycle and bounded-memory safety

Before the v2 migration, fix the lifecycle paths that do not require new storage:

- Route the card status dropdown through one transition function so reopening
  resets age and reminder marks consistently.
- Add a Ready-arc reminder after its threshold and expose Ready arcs through
  `/wt-beat`, with a Resolve path that does not disturb waiting-beat numbering.
- Correct the All-mode description to say that resolved and dropped arcs are
  excluded.
- Bound closed arcs already sent to regeneration and omit their beat lists from
  that projection, reducing prompt and history growth that occurs today.

The Ready reminder is not an automatic model call. `turnsSinceAdvance` continues
to age through auto-generation and resets only when the current beat changes or
the arc is reopened.

Exit criteria:

- an overdue Ready arc is visible, remindable, and resolvable without narrator
  injection becoming a hidden state mutation;
- every UI status transition uses the same reset rules;
- closed-memory prompt size is bounded and measured with a 100-closed-arc fixture.

### Pre-phase patch 3 — Request handles

Add short per-request arc handles to the built-in full-plan prompt while retaining
the v1 store. Do not expose beat IDs in Markdown. Validate handles against the
captured arc set and use only unambiguous exact title/text fallback when handles
are absent. This makes the later v2 migration safer without coupling prompt
compatibility to nested beat identifiers.

### Phase 0 — Pin the current failure cases

**Purpose:** Establish the invariants before changing the store.

Work:

- Add a regression where a regenerated beat list changes before a retained
  `beatIndex`; prove the new event cannot inherit planted status.
- Add a regression where the model returns only the remaining beats, or only the
  planted beats, and prove the arc does not become Ready incorrectly.
- Add a regression where a Ready arc receives new setup beats and prove it stays
  Ready.
- Add a regression for light rewording of planted beats: duplication may be
  visible, but progress must never transfer silently.
- Add resolved and dropped arcs, omit them from a subsequent generation, and
  prove the planner retains their records.
- Pin the existing equivalence between All and Active as the reason for the mode
  cleanup.
- Cover pinned arcs whose model-generated body or pending beats change.
- Cover a Ready arc left unresolved past the threshold, including reminder and
  `/wt-beat` resolution behavior.
- Cover reopening through the card status dropdown after a long wait.
- Cover deleting an arc or editing its description while generation is in flight.
- Record current full-plan parsing behavior when identifiers are absent, malformed,
  duplicated, or refer to an arc from another chat.
- Record history, backup merge/replace, and import behavior for v1 string beats.

Primary tests:

- `test/plan.test.js`
- `test/beats.test.js`
- `test/generation_commit_races.test.js`
- `test/schema_migrations.test.js`
- `test/backup_schema_roundtrip.test.js`
- `test/import_export_roundtrip.test.js`

Exit criteria:

- every data-loss or incorrect-progress case has a deterministic failing fixture;
- fixtures distinguish user-confirmed state from model-authored proposals;
- the pre-migration v1 records used by tests are preserved as compatibility fixtures.

### Phase 1 — Store v2, durable identity, and closed memory

**Purpose:** Remove positional progress transfer and make prior decisions durable.

Work:

- Add the v1 → v2 Story Planner migration.
- Convert every legacy beat string to a canonical beat object with a new stable id.
- Mark beats before `beatIndex` planted and the remainder pending; clamp exactly as
  the current v1 reader does so existing plans retain their visible progress.
- Add Parked status, focus, close reason, and close timestamp defaults.
- Update schema validation, canonicalization, history restores, backup merge/replace,
  and recovery exports for nested beat records and duplicate beat ids.
- Preserve unknown future-version stores through the existing schema gate.
- Add built-in prompt identity annotations and tolerant parsing.
- Rewrite regeneration merge so planted/skipped beat objects are preserved exactly
  and only pending beats can be replaced.
- Retain omitted Resolved and Dropped arcs and build the bounded closed-memory
  generation projection.
- Treat explicit deletion as a deliberate forget action; history still captures
  the pre-delete state.

Implementation seams:

- `story_planner/schema.js`: v2 types, migration, validation, marker parser.
- `story_planner/data.js`: current-beat derivation, safe merge, closed projection.
- `story_planner/generation.js`: identity-bearing previous plan and closed memory.
- `backup/restore.js`: nested beat and closed-record merge behavior.

Exit criteria:

- no model output can transfer planted/skipped state solely by list position;
- v1 plans, history snapshots, imports, and backups migrate without losing an arc
  or its planted progress;
- malformed/duplicate nested ids are quarantined or repaired according to the
  central schema policy and remain recoverable;
- resolved/dropped arcs survive any number of full-plan generations;
- closed records never enter narrator injection or beat reminders;
- prompt identity annotations are absent from cards, macros, previews, and injection.

### Phase 2 — Full beat editor

**Purpose:** Make every part of an arc maintainable without editing metadata.

Work:

- Add a collapsible **Setup beats** editor to every arc card.
- Show planted, current, upcoming, and skipped states distinctly.
- Support add, edit, delete, reorder, mark planted, mark skipped, undo, and restore
  to pending.
- Keep destructive deletion separate from Skip. Skip retains the beat and an
  optional reason; Delete removes it after a specific confirmation.
- Prevent pending beats from being moved before historical beats unless the user
  explicitly changes those historical states.
- Add **Generate setup beats** for a manual long-range arc with no beats; route it
  through the targeted proposal flow from Phase 4 when that phase exists.
- Snapshot once per completed edit operation rather than once per keystroke.
- Reapply injection only when the current narrator-facing projection changes.
- Preserve focus and expanded editor state when the card list re-renders.

Exit criteria:

- a user can create and maintain a complete long-range arc from the UI;
- Skip never claims that an event happened;
- changing a future beat does not reset or rewrite earlier progress;
- changing the current beat resets its age and reminder high-water mark;
- keyboard, screen-reader, touch, and narrow-layout behavior match the existing
  accessibility contract;
- history can restore beat order, text, ids, states, and reasons exactly.

### Phase 3 — Parked arcs, focus, and injection-mode cleanup

**Purpose:** Give the user control over when a good idea receives attention.

Work:

- Add Park/Resume actions and the Parked lifecycle state.
- Keep the Ready-arc reminder and `/wt-beat` Resolve path from the pre-phase
  lifecycle patch integrated with the new lifecycle presentation.
- Add a lightweight Focus toggle separate from Pin.
- Present Active/Ready sections first and Parked/Archive groups collapsed below.
- Replace the Active injection radio with Focused only; relabel All as All active.
- Resolve legacy `injectMode: "active"` to `all` and test global/per-chat setting
  provenance through the migration.
- Put focused arcs first in full-plan context and All-active injection.
- Make push language focus-aware: Assertive advances at least one injected arc,
  preferring a focused arc when one is available.
- Add an optional `activateWhen` note to parked cards for human reference.
- Update Overview counts so parked arcs are not awaiting/overdue and focused/ready
  counts remain meaningful.

Exit criteria:

- Parked arcs survive regeneration but never age, remind, or inject;
- Pin cannot accidentally reactivate a Parked/Resolved/Dropped arc;
- Focused-only injection is empty and clearly explained when nothing is focused;
- the Preview, Diagnostics, Budget panel, floating badge, and Overview agree on
  which arcs are active, injected, focused, ready, and overdue;
- old global and per-chat mode settings keep their prior behavior after migration.

### Phase 4 — Targeted arc development

**Purpose:** Improve one weak part of the plan without churning everything else.

Add three card actions:

1. **Rework remaining setup** — preserve arc identity, title, endpoint, and every
   planted/skipped beat; propose a replacement pending route.
2. **Develop this arc** — propose edits to the description, section, and pending
   beats while preserving historical progress.
3. **Suggest an alternate route** — create a new sibling proposal and leave the
   source arc unchanged.

Work:

- Give targeted generation a small dedicated prompt contract rather than passing a
  single arc through the full five-section parser.
- Ground the call with the arc, its historical and pending beats, recent stable
  messages, factual World State, latest Chronicle, direction hint, story palette,
  and relevant closed memory.
- Return a proposal with a field-level/beat-level diff and explicit Apply/Discard.
- Preserve the captured chat scope and exact arc revision. If either changes while
  the call is in flight, do not overwrite; rebuild the comparison against current
  state or ask the user to generate again.
- Push a history snapshot only when the proposal is applied.
- Route the call through the central generation coordinator as a foreground manual
  Story Planner job.
- Add **Generate setup beats** as a special case of Rework remaining setup.

Exit criteria:

- no targeted operation changes an unrelated arc;
- completed/skipped beats are immutable in model proposals;
- Apply is disabled when the source arc was deleted or materially changed;
- alternate route always receives fresh arc and beat ids;
- cancelled, failed, rejected, or stale proposals make no persistent change and
  consume no history slot;
- custom full-plan prompts remain unaffected.

### Phase 5 — Evidence-backed progress suggestions

**Purpose:** Reduce repeated NOW instructions without turning inference into fact.

**Prerequisite:** Move `findQuoteMatch`, `quoteMatchesMessage`, and
`normalizeForMatch` from `knowledge/growth.js` into a tested `core/` seam before
Story Planner consumes them. Stable message identity already lives in
`core/message_identity.js`; Story Planner must not add a direct dependency on
Knowledge's private helpers.

Start with a manual **Check progress** action. Automatic checks remain behind a
later decision gate.

Work:

- Inspect current beats and Ready arc payoffs against messages newer than each
  item's last check watermark.
- Require every suggestion to include a stable message identity and a short source
  excerpt that can be verified against the current chat.
- Return only proposals: **Beat appears planted**, **Arc may be resolved**, or
  **No clear evidence**.
- Show suggestions in one review panel with Accept, Ignore, and Open source.
- Accepting a beat proposal performs the normal user-authored planted mutation.
- Accepting a resolution proposal uses the normal Resolve flow and lets the user
  enter or edit its reason.
- Ignore suppresses only that evidence/item combination; it does not permanently
  block later evidence.
- On swipe/edit/delete, mark affected pending suggestions stale. Never silently
  roll back a progress change the user already accepted.
- Record last-checked watermarks only after a successful, scope-safe result.

Decision gate for automatic checks:

- enable an opt-in cadence only if manual use shows forgotten beats are common;
- reuse an already-running full-plan refresh when possible;
- expose call frequency and last result in Health/Diagnostics;
- default remains off, and disabling it cancels queued checks.

Exit criteria:

- no unverified excerpt can be accepted as evidence;
- ambiguous narration produces no proposed state change;
- the model cannot directly mutate beat or arc status;
- duplicate checks do not repeat an ignored or already-applied suggestion;
- chat switch, retry, swipe, edit, delete, and concurrent card-edit cases are covered;
- the initial manual feature adds no automatic API cost.

### Phase 6 — Creative palette and safe character grounding

**Purpose:** Broaden planning quality while keeping established facts, private
knowledge, and hypothetical outcomes clearly separated.

#### 6.1 Compact story palette

Add a small per-chat control with:

- emphasis chips: conflict, mystery, discovery, consequences, relationships,
  character growth, quiet moments, and repair/reconciliation;
- an escalation preference: restrained, balanced, or escalating;
- an **allow new major characters** toggle;
- the existing free-form Direction Hint.

Rules:

- no selection means balanced behavior and keeps current users near the existing
  output;
- chips are preferences, not quotas;
- generated arcs describe attempts, pressures, and possible outcomes rather than
  deciding what the user character will choose or whether an uncertain outcome
  succeeds;
- the prompt should prefer developing established threads and cast before adding
  new rivals, villains, or institutions unless the user asks for expansion.

#### 6.2 Safe character context

Add an opt-in compact Knowledge projection for selected NPCs or the active cast.
The projection may include stable identity, public role, established personality
or profile traits, current public agenda, and concise relationship stances useful
to the selected arc.

It must exclude:

- Secrets;
- Knowledge Ledger contents;
- Interiority thoughts and private intentions;
- raw evidence quotes not explicitly selected for sharing;
- any field hidden by the Planner's own context-selection control.

Use Knowledge `entityId` values so selections survive rename/merge. Resolve the
active cast through the shared Current Scene/alias service planned by the World
State roadmap; do not import Interiority's generation module or require Interiority
to be enabled.

Keep this factual context inside a clearly labeled tag. Generated arcs remain
hypotheses and must never flow back into Knowledge or World State as facts.

Exit criteria:

- restrained and quiet palettes measurably reduce forced escalation/new-cast churn
  in fixed prompt fixtures;
- no palette weakens the existing prohibition on writing actions, dialogue,
  thoughts, or decisions for `{{user}}`;
- selected characters survive approved renames and merges;
- no secret, ledger entry, private intention, or thought appears in captured
  requests, previews, logs, or generated plan context;
- disabling Knowledge or safe character context yields the current factual
  World State/Chronicle path without errors;
- context is capped by whole character records and reported in request diagnostics.

### Phase 7 — Documentation, observation, and default decisions

**Implementation status (2026-09-19):** Code instrumentation, diagnostics,
panel help, README workflow documentation, exact-title closed recurrence
suppression, and the initial decision record are implemented. The host-runtime
manual QA matrix remains pending and is tracked in
`docs/STORY_PLANNER_PHASE7_DECISIONS.md`; it is not represented as completed by
the automated suite.

**Purpose:** Finish the feature as a coherent user workflow and measure whether
the optional automation is justified.

Work:

- Update the README Story Planner feature and usage sections.
- Explain Pin vs Focus vs Park, Planted vs Skipped, Ready vs Resolved, and Archive
  vs Delete in the panel's help text.
- Update slash commands or add equivalents only where they shorten common actions;
  keep `/wt-beat` backward compatible.
- Extend Injection diagnostics with focused/parked/closed omission reasons and the
  post-Budget payload.
- Extend Health/Overview with last progress check and proposal counts if Phase 5
  ships.
- Record manual QA on a short chat, a long campaign, group chat, custom prompt,
  narrow/mobile layout, and a chat containing migrated v1 history.
- Measure false positive/negative progress suggestions, closed-memory recurrence,
  planner request size, injection size, and targeted-vs-full generation use.

Decision records:

- whether progress checking deserves an opt-in automatic cadence;
- whether `activateWhen` needs automatic wake evaluation;
- whether the story palette should affect auto-generation defaults;
- whether closed-memory ranking needs anything beyond pin + recency.

Do not add those behaviors on intuition alone; record the observed trigger and
result here or in a short follow-up decision note.

## 7. Cross-cutting test plan

### Pure data and schema

- v1 → v2 migration is idempotent;
- string beats map to stable objects with correct planted/pending states;
- duplicate arc and beat ids never alias UI mutations;
- current beat and Ready state derive from beat states, not array position;
- skipped beats are historical but never treated as planted evidence;
- nested length/type limits prevent metadata growth;
- future schema versions remain untouched and pause only Story Planner;
- history restores and backup/import paths preserve all new fields.

### Generation and merge

- compliant identity markers retain the correct arc and pending beat ids;
- missing, forged, cross-chat, malformed, and duplicate markers fail safely;
- title fallback never transfers progress between two ambiguous arcs;
- model rewrites cannot alter planted/skipped records;
- closed and parked records survive omission;
- mid-flight edits, deletes, focus changes, parking, and chat switches do not get
  overwritten;
- targeted generation touches exactly one captured arc revision.

### Injection and lifecycle

- only Active arcs can inject or age;
- All-active, Pinned-only, and Focused-only select exactly their documented sets;
- Ready, current, overdue, and focus annotations agree across data, cards,
  previews, diagnostics, and the registered prompt;
- closed memory reaches generation only and never narrator injection;
- Budget truncation drops whole arcs and keeps wrapper tags valid;
- panic switch and tracker disable clear every new prompt surface.

### UI and accessibility

- full beat editing works with keyboard and touch;
- icon controls have names that include the target arc/beat;
- focus remains predictable after add/delete/reorder/re-render;
- proposal dialogs trap/restore focus and expose a readable diff;
- state is not communicated by color alone;
- live status and busy states remain non-spamming;
- reduced-motion and narrow-screen styles cover new controls.

Likely test files to extend or add:

- `test/plan.test.js`
- `test/beats.test.js`
- `test/story_planner_migration.test.js` (new)
- `test/story_planner_targeted_generation.test.js` (new)
- `test/story_planner_progress_check.test.js` (new)
- `test/generation_commit_races.test.js`
- `test/backup_schema_roundtrip.test.js`
- `test/import_export_roundtrip.test.js`
- `test/injection_diagnostics.test.js`
- `test/budget.test.js`
- `test/modal_accessibility.test.js`
- `test/accessible_names.test.js`

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| v2 migration mislabels progress | Map exactly from the clamped v1 `beatIndex`; keep v1 fixtures and recovery export coverage |
| Model drops or invents identity markers | Validate against the captured arc set; fall back to unambiguous exact matching; otherwise mint new ids without progress |
| Full regeneration rewrites history | Preserve stored planted/skipped objects verbatim and replace pending beats only |
| Closed memory grows indefinitely | Keep full storage, but rank and cap the generation projection by whole records |
| Parked ideas never return | Make parked count visible and add explicit Resume; defer automatic wake until evidence justifies it |
| Focus becomes another confusing status | Keep it as a separate star/spotlight control and explain it beside Pin/Park in one compact legend |
| Beat editor overwhelms each card | Collapse the full sequence; keep the current beat and main actions visible by default |
| Progress checker hallucinates completion | Require verified source excerpts and user acceptance; no evidence means no proposal |
| Targeted proposal overwrites a live edit | Capture scope + exact arc revision and fail closed on mismatch |
| Character grounding leaks secrets | Use a dedicated allowlist projection with explicit exclusions and request-capture tests |
| Story palette becomes settings clutter | Start with a few chips, one escalation choice, and the existing direction hint |
| More context increases request cost | Bound closed/character projections by whole records and report their sizes in Diagnostics |
| New automation competes for API capacity | Manual first; coordinator-managed and opt-in only if the decision gate passes |

## 9. Recommended implementation order

1. Add the Phase 0 regression fixtures, including the reproduced positional,
   lifecycle, Ready-arc, and in-flight deletion/edit cases.
2. Ship the v1 progress/merge and commit-race patch; no store or UI change.
3. Ship the v1 lifecycle fixes, Ready reminder/Resolve path, All-mode wording,
   and bounded closed-memory projection.
4. Add short per-request arc handles and settle the reminder-age rule on v1.
5. Ship the v2 migration, stable beat objects, Skip, and the full beat editor.
6. Add durable closed-memory retention, Archive presentation, macro filtering,
   and import/export/history coverage with whole-record bounds.
7. Add Park/Resume, Focus, and injection-mode cleanup.
8. Add targeted arc proposals and Generate setup beats.
9. Move quote verification to the tested `core/` seam, then add manual,
   evidence-backed progress checking.
10. Add the compact story palette.
11. Add safe, opt-in Knowledge character grounding after the shared cast/scene
    seam is available.
12. Complete documentation, manual QA, measurements, and the optional-automation
    decision records.

Every slice should run `npm test` and `npm run lint`. Schema, merge, targeted
generation, and progress-check slices should also run the relevant focused tests
before the full suite. Cross-module slices need a manual SillyTavern check for
chat switching, swipes, message edits/deletes, backup restore, injection preview,
Budget enforcement, panic switch, and disabled trackers.

## 10. Completion criteria

This roadmap is complete when:

- planted progress can never transfer to a different beat through regeneration;
- closed decisions remain durable and suppress straightforward recurrence;
- users can fully maintain a beat sequence, including an honest Skip action;
- good ideas can be parked without aging or prompt cost;
- users can focus present attention independently of pinning;
- one arc can be developed or rerouted through a previewed, scope-safe proposal;
- progress checks are evidence-backed suggestions and never hidden writes;
- creative controls can ask for quieter or less escalatory planning;
- optional character grounding is useful, bounded, and demonstrably free of
  private Knowledge/Interiority material;
- history, migration, import/export, backup/restore, diagnostics, Budget,
  accessibility, and cross-chat safety cover every new field and workflow;
- the full test suite, lint, and manual integration checklist pass.
