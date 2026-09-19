# Story Planner projection inventory (V3 Phase 0)

**Status:** Complete for the current implementation
**Date:** 2026-09-19
**Scope:** Every surface that consumes Story Planner arc `title`, `body`,
`beats`, history, and closed/parked memory, verified against the source at
commit `b034eaa` (MWT 2.9.0). This is the V3 roadmap Phase 0 work item
*"Inventory which surfaces consume title, body, beats, history, and closed
memory"* and the prerequisite for Phase 4 (opt-in author context): **any
author-only field must be provably absent from every surface listed here**
(the Phase 4 exit criteria name narrator payloads, public memory, macros,
exports, progress-check inputs, logs, and telemetry — §3 maps each).

## 1. The text projections

All model- and user-facing arc text is produced by six projections. There is
no other rendering path.

| Projection | Seam | Includes |
| --- | --- | --- |
| `serializeArcsToText` | `story_planner/data.js:489` | title, body, all beats; optional `[PLANTED]/[SKIPPED]/[CURRENT]`, status flags, `[ARC:handle]` markers |
| `buildInjectionBody` | `story_planner/injection.js:103` | narrator shape: Ready arcs → title + body; pending arcs → title + current beat + body as "building toward" |
| `buildClosedMemoryProjection` | `story_planner/data.js:432` | resolved/dropped arcs → title + (`closeReason` ‖ body); bounded 20 arcs / 6000 chars |
| `buildParkedMemoryProjection` | `story_planner/data.js:451` | parked arcs → title only; bounded 20 arcs / 3000 chars |
| Targeted arc brief | `story_planner/targeted.js:47-57` | title, body, **every beat** with state + `stateReason` |
| Progress items | `story_planner/progress.js:62-66,130-131` | title + current pending beat text; Ready arcs → title + body (payoff) |

## 2. Field-by-field consumer matrix

| Field | Narrator injection | `{{storyplan}}` macro | Regen `<previous_plan>` | Closed memory | Targeted brief | Progress check | UI | History | Export/backup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `title` | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| `body` | ● (payoff / "building toward") | ● | ● | ● (fallback for `closeReason`) | ● | ● (Ready arcs) | ● | ● | ● |
| current beat text | ● (`NOW:`) | ● | ● (`[CURRENT]`) | — | ● | ● | ● | ● | ● |
| all beats | — (current only) | ● | ● (with markers) | — | ● | — | ● | ● | ● |
| `stateReason` | — | — | — | — | ● | — | ● | ● | ● |
| `closeReason` | — | — | — | ● | — | — | ● | ● | ● |
| `activateWhen` | — (parked not injected) | — | — | — | — | — | ● | ● | ● |
| history snapshots | — | — | — | — | — | — | ● (view/revert) | ● (stored, ≤20) | ● |
| narration excerpts | — | — | — | — | — | — | ● (progress modal) | — | ◐ (content-derived evidence keys) |

● = consumed; ◐ = content-derived form; — = not consumed.

## 3. Surface-by-surface detail

### 3.1 Narrator injection (model-facing, every turn)

`applyPlanInjection()` (`injection.js:187`) registers header +
`buildInjectionBody()` with SillyTavern via `applyExtensionPromptInjection`
(`EXTENSION_PROMPT_KEY`, wrapper `mwt_story_plan`, module depth, role system).
Selection: active arcs only; dropped and resolved excluded in every mode;
parked excluded; mode `pinned`/`focused`/all (`getArcsForInjection`,
`injection.js:43`). Content: title, the **single current beat**, and `body`
("building toward"; Ready arcs inject `body` as the payoff) — so **title,
body, and beat text cannot double as private notes** (confirmed V3 §2).

### 3.2 `{{storyplan}}` macro (model-facing, user-placed)

Registered `core/commands.js:232`; text from `getPlanTextForMacro()`
(`story_planner/index.js:483`) = `serializeArcsToText(active arcs)` — full
title + body + all beats, no annotations. **Not filtered by injection mode**
(it is the user placing the plan by hand) and it can land in *any* prompt the
user types it into, not just narrator generation. `core/ui.js` also uses this
function's output as the floating button's "does a plan exist" check.

### 3.3 Full-plan regeneration prompt (model-facing)

`buildUserPrompt()` (`generation.js:72`): `<previous_plan>` from
`serializeArcsToText(active arcs, annotateStatus)` with request-local
`[ARC:handle]` markers; `<closed_story_ideas>` from the closed projection;
`<shelved_story_ideas>` from the parked projection; plus inbound World State /
Chronicle / Safe Character Context blocks (§5). Auto-generation and the slash
command use the same path. Custom templates substitute these blocks only
where their tokens occur (`generation.js:170`).

### 3.4 Targeted proposal prompt (model-facing)

`targeted.js` builds its own fixed brief per arc (`targeted.js:47-57`): title,
body, and **all** beats with state and `stateReason` (historical and pending
separated), plus the closed-memory projection (`targeted.js:79`). The review
diff (`renderTargetedDiff`, `render.js:1394`) and Apply
(`applyTargetedProposal`, `setArcsWithHistory`, `data.js:1275`) rebuild from
the canonical record; the model never controls ids or lifecycle.

### 3.5 Progress check (model-facing) and suggestion review (UI/persistence)

`progress.js` sends the current pending beat (title + text) and Ready-arc
payoffs (title + body) against settled narration (window 80 messages /
30 000 chars) using `PROGRESS_SYSTEM_PROMPT`. Verdicts must quote the
narration (`findQuoteMatch`); accepted suggestions mutate beats/status only
through the ordinary user seams (`acceptProgressSuggestion`,
`progress.js:316`). Suggestions (in-memory `state.progressSuggestions`; review
modal `render.js:667`) carry `arcTitle`, `itemText`, narration `excerpt`,
`reason`. Persisted per chat: `progressWatermarks` and
`ignoredProgressEvidence` (content-derived evidence keys, bounded) —
**content-derived strings already persist today**; Phase 4 sentinel tests
should cover this store too.

### 3.6 Plan UI (user-facing)

Cards and edit modal (`renderArcs`/`render.js`): title, body, beats, status,
`closeReason`, `activateWhen`. Injection preview pane (`render.js:881-920`)
renders the exact `buildInjectionBody()` output and token count. History view
uses `historyEntryToDiffText` (§3.7). Targeted review modal shows field/beat
diffs.

### 3.7 History snapshots (persistence, per chat)

`pushPlanToHistory` (`data.js:1257`) stores full structured-cloned arc lists
(≤ `MAX_PLAN_HISTORY` 20). `historyEntryToDiffText` (`data.js:1198`) exposes
title, body, flags, `activateWhen`, `closeReason`, and every beat with state +
`stateReason`; `historyEntryToText` reuses `serializeArcsToText`.
`historyEntrySignature` (`data.js:1229`) hashes every durable field.
`setArcsWithHistory` commits reviewed replacements with one pre-Apply
snapshot.

### 3.8 Chat metadata store (persistence)

Everything above lives in the chat-scoped `story_planner_data` store
(`core/metadata.js`; `backup/data.js:37`): arcs, history, palette/settings,
auto counters, Phase 7 metrics (**content-free counters only**,
`data.js:131-143`), progress watermarks/evidence keys. Schema-gated by
`story_planner/schema.js` (future-version stores preserved, not migrated).

### 3.9 Export and backup (persistence, leaves the chat)

- **Backup envelope:** full-fidelity `story_planner_data` collected by
  `backup/collect.js`, validated via the schema registry, and merged on
  restore through `mergeStoryPlanner` (`backup/restore.js:604`) with id
  remapping.
- **Portable Markdown:** `serializeArcsToText` output — title, body, all
  beats; **deliberately no ids and no progress** (round-trip contract in
  `test/import_export_roundtrip.test.js:52`).

### 3.10 Diagnostics and logs (content-free by design)

💉 Injection tab shows the exact registered payload but **deferred and
secret-scrubbed** (`diagnostics_panel/injection.js`); `getInjectionDiagnostics`
(`injection.js:52`) is counters only. `applyPlanInjection` logs counts and
character lengths, never content. API Last Request telemetry never held the
prompt (V3 §2). Keep all of these content-free — none of the V3 work
justifies changing that.

## 4. Consequences for Phase 4

1. **Title, body, and beat text are narrator-visible** (§3.1). Author-only
   material must never land in them — a schema separation verified with
   sentinel fixtures, not a prose filter (as the V3 Phase 4 sketch already
   requires).
2. **`serializeArcsToText` is one function with four consumers** (macro,
   `<previous_plan>`, history text view, portable export) with different
   exposure needs. Author-only filtering belongs at or above the serializer —
   per-consumer filtering will drift.
3. **The `{{storyplan}}` macro is fully public**: it can be pasted into any
   prompt anywhere. Treat everything it can emit as published.
4. **The progress-check pipeline already persists content-derived strings**
   (evidence keys) and shows narration excerpts in its modal — include it in
   the Phase 4 sentinel matrix ("progress-check inputs").
5. **`closeReason` is model-facing** via closed memory; **`activateWhen` is
   UI/persistence-only today** — if Phase 4 adds author notes near arcs, they
   follow `activateWhen`'s consumer set, not `body`'s.
6. **Backup and portable export both leave the chat**: the envelope is
   full-fidelity (private fields round-trip inside the store, correct for
   restore but relevant to the deferred author-inclusive export modes, V3
   §7), while portable Markdown must stay public-only.

## 5. Inbound context (not projections, listed to bound the inventory)

These feed *into* planner generation and are not arc-data consumers: World
State factual view, latest Chronicle entry, Safe Character Context
(`planner_context.js`, public-only projection, six records/700 chars, field
cap 280), palette (`storyPaletteProjection`, `generation.js:64`), direction
hint, and the generation coordinator's guards (panic, disabled, schema-pause,
chat scope).

## 6. Maintenance

This inventory must be re-checked when a new consumer of arc text is added.
The checklist: serializer changes, new macros/slash commands, new model calls
that receive arc text, new export modes, new diagnostics that display
payloads, and new persisted fields on the plan store.
