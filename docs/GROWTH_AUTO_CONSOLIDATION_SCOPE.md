# Auto-consolidation of the raw evidence backlog — scope and contract

**Status:** Implemented (code + automated checks), revision 2. Host QA
pending, like the rest of this cycle's growth work.
**Date:** 2026-11-22 (draft and revision 2, same day)
**Source:** internal follow-up to
[GROWTH_PROFILE_INJECTION_RESPONSE.md](./GROWTH_PROFILE_INJECTION_RESPONSE.md).
Since dossier injection shipped, a recurring pattern surfaced: users (and
authors) forget to press Consolidate, so raw observations pile up — 300+ in
a long-running chat is normal, not exceptional. A co-author reviewed the
first draft of this feature; their constraints are §2 verbatim in intent and
are all addressed (§5).
**Area:** the growth evidence store (`knowledge/evidence.js`), the
consolidation pipeline (`knowledge/growth.js`), a new driver
(`knowledge/auto_consolidation.js`), and the Growth window refresh
(`knowledge/render.js` `refreshOpenGrowthModal`).
**Purpose:** pin the behavior contract before host QA, so the trigger
semantics can be audited rather than rediscovered from code.

## Revision 2 — what the pre-QA review changed

The first draft passed its tests but failed the §2 constraints in the state
§2 itself calls normal (a major NPC carrying 200+ uncited raws). Each item
was reproduced with a probe before it was fixed, and each is pinned by a
regression test (`test/auto_consolidation.test.js` "review regressions",
`test/auto_consolidation_modal.test.js`):

1. **Starvation.** Batches were the oldest 150 raws in stored order — which
   are the uncited stayers earlier passes already saw. Past 150 stayers,
   every automatic pass re-sent the same 150 and new evidence was never
   presented. → Batches now take only unseen evidence, lowest id first (§4,
   §5.3).
2. **Fire-on-every-capture.** The count leg compared the WHOLE raw tier to
   the threshold, and one new observation re-armed the trigger, so stayers
   alone held it open: each capture of 3 observations fired a call
   re-sending all the stayers, and a low-yield pass re-fired with no new
   evidence at all. → The threshold counts unseen evidence only; backoff
   counts evidence since the last attempt (§4).
3. **Expand was auto-redone.** Expand lowered the watermark on purpose, so
   the next scan rebuilt the claim the user had just undone. → Restored raws
   are stamped and never presented to an automatic pass again (§5.1).
4. **No cross-NPC bound.** The 3-batch cap was per NPC: six NPCs with
   450-raw backlogs spent 18 calls in one scan. → One scan spends at most 3
   calls in total, round-robin (§5.3).
5. **Unprompted Growth window rebuilds.** The refresh after a pass rebuilt
   the whole content area mid-action: busy buttons came back clickable, the
   Catch Up progress panel vanished, and a Psychoanalyze portrait (saved
   nowhere else) was wiped or written into detached nodes. → The refresh
   rebuilds only when nothing would be lost (§5.5).

Smaller corrections in the same pass: a zero-claim answer now advances the
watermark (§5.2 explains why), a reply with no `consolidated` list is a
thrown error instead of a silent empty pass, a manual pass that distils
something resets the automatic failure count, and the "already running"
message says "running or queued" (an automatic pass holds the guard while
its call waits behind a user generation).

## 1. Problem

Consolidation is manual-only: a button in the Growth window, disabled below
two non-canon raw observations, presenting the whole raw pool in one API
call. Nobody presses it on a schedule. The raw tier grows without bound
while the consolidated tier — the thing profile generation reads first —
falls further and further behind. Users discover this only when evidence
counts get embarrassing or token costs rise.

## 2. Review constraints (co-author's words, addressed in §5)

> auto-consolidation would manage the raw backlog—not make the entire
> evidence store bounded

> There's also an important retry edge case: uncited observations remain raw.
> If a pass leaves the NPC above the threshold—or returns no useful claims—a
> simple `raw count >= threshold` check could trigger the same request
> repeatedly. I'd require **new evidence since the previous attempt**, plus
> failure backoff and protection against overlapping manual/automatic
> consolidation. Large existing backlogs would also need bounded batches.

The trigger threshold discussion settled on a default of 100, configurable
per user. 30 (an earlier suggestion) is too low: in a 7,000+ message
session, a major NPC's raw tier routinely sits above 200 even with regular
manual consolidation, because uncited observations legitimately stay raw.
That observation is exactly why the threshold counts only evidence no pass
has seen (§4): those 200 stayers must not count toward anything.

## 3. What it is

An **opt-in** setting pair in Knowledge module settings:

| Setting | Default | Range |
|---|---|---|
| `growthAutoConsolidationEnabled` | `false` | — |
| `growthAutoConsolidationThreshold` | `100` | 10–1000 |

When enabled, after any capture completes — the auto-capture cadence, or the
manual Capture / Backfill / Catch Up buttons — `maybeRunAutoConsolidation()`
checks every evidence file against the gate (§4) and spends a bounded number
of passes (§5.3) on the eligible NPCs. The check is cheap (chat-metadata
reads only); no API call happens unless an NPC is genuinely eligible. It
fires even when a capture added nothing, which is what drains a pre-existing
backlog on the first capture after the feature is enabled (a file that
predates the feature has no watermark, so all of its raws count as unseen
once).

The preset table (docs/ONBOARDING_PRESET_PLAN.md §2.1) turns both keys on in
**Full** only.

## 4. The gate

Definitions (`evidence.js` `isUnseenForAuto`, `readAutoConsolidationState`):

- **Watermark** (`meta.autoConsolidation.watermark`): the highest raw-id
  sequence a pass has presented AND got an answer for. Raw ids (`obs-NNN`)
  are minted from a sequence that scans raw ∪ archivedRaw (`obsIdSequence`),
  so they rise monotonically as evidence arrives.
- **Unseen**: a non-canon raw with a numeric id above the watermark that the
  user never restored via Expand (`expandedAt` absent). Ids without a numeric
  suffix can't be ordered against the watermark and are left to manual
  passes.
- **Attempt high-water** (`meta.autoConsolidation.attemptHighWater`): the
  file's highest raw-id sequence (`rawSeqHighWater`) when the last automatic
  attempt started. A container written before this field existed falls back
  to the watermark.

A pass becomes eligible only when ALL hold, per NPC:

1. **Count**: unseen count ≥ threshold. Stayers (seen, uncited), canon
   claims and Expand-restored raws never count.
2. **Backoff**: after N consecutive failed/zero-yield automatic passes, ≥
   `backoffRequired(N)` = `min(20 × 2^(N−1), 80)` unseen raws newer than the
   attempt high-water. With no failures there is no backoff requirement —
   leg 1 already means "evidence no pass has seen".
3. Not already in flight (§5.4), and the module not paused.

Leg 1 is what makes "new evidence since the previous attempt" real: a
presented stayer sits at or below the watermark forever, so it can neither
fire the trigger nor fill a batch. Backoff is evidence-denominated, not
wall-clock, mirroring Chronicle's message-denominated auto-snapshot retry
gate (`autoSnapshotRetryAt`): a retry means "enough has changed to be worth
another pass". Time-based backoff was rejected: sessions idle for days, and
the wall clock says nothing about whether a retry has better odds. Backoff
needs its own marker because a thrown error leaves the watermark (and so the
unseen pool) untouched — measured against the watermark, the failed batch
would satisfy the bar on the very next capture.

## 5. Behavior contract

### 5.1 Scope: the raw backlog only

Auto-consolidation manages `raw[]`. It never bounds `consolidated[]` or
`archivedRaw[]` (that is the separate, unimplemented
GROWTH_EVIDENCE_ARCHIVE_SCOPE.md proposal), never regenerates profiles,
never drafts dossier lines, and never deletes anything — cited raws move to
`archivedRaw`, and **Expand undoes a claim exactly as with manual passes**.

Expand stamps each restored raw with `expandedAt`, and automatic passes
never present a stamped raw again: with the feature on, the next capture
would otherwise rebuild the claim the user just rejected. A manual
Consolidate still includes them. The stamp (not the watermark) is what
covers claims consolidated before this feature existed, whose sources sit
above a file's not-yet-stamped watermark of 0.

Why automating this pass is acceptable where automating dossier rewrites
would not be: consolidation is tier bookkeeping over machine-captured data
with per-claim provenance and a per-claim undo; the things that need human
judgment (what the character sheet says) still route through staging.

### 5.2 Outcome stamping (`meta.autoConsolidation`)

| Outcome | Watermark | `failures` | `attemptHighWater` |
|---|---|---|---|
| Pass distilled ≥1 claim (auto **or** manual) | advanced over what it presented | reset to 0 | stamped (auto only) |
| Model answered with zero admissible claims | advanced over what it presented | +1 (auto only) | stamped (auto only) |
| Thrown error (API, parse, missing `consolidated` list, registry, save) | **not** advanced | +1 | stamped |
| Coordinator cancellation / chat-scope change / module paused | untouched | untouched | untouched |

The zero-yield row changed in revision 2. The model looked at the batch and
found nothing; re-sending the identical batch gets the same answer, and with
a pool larger than one batch the retry would be the identical batch every
time — the starvation pattern again. So a zero-yield pass treats its batch
exactly like the uncited remainder of a productive pass: seen, still raw,
left to manual passes. It still counts as a failure, so the next automatic
attempt waits for more evidence. A malformed reply (no `consolidated` list)
is thrown rather than read as zero-yield, so it can never mark a batch as
seen that no model evaluated.

The advance is capped below any unseen raw the pass did NOT present, so
raising the watermark can never mark evidence as seen that was not in the
batch. Lowest-id-first batches make this a no-op except for duplicate
sequences (merged `tag::obs-NNN` ids share a number with native ones).

### 5.3 Bounded batches and the per-scan budget

| Constant | Value | Where |
|---|---|---|
| `AUTO_CONSOLIDATION_BATCH_LIMIT` | 150 | per API call |
| `AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN` | 3 | per scan, across ALL NPCs |
| `AUTO_CONSOLIDATION_BACKOFF_BASE` | 20 | `knowledge/auto_consolidation.js` |
| `AUTO_CONSOLIDATION_BACKOFF_CAP` | 80 | 〃 |

A batch presents the lowest-id 150 unseen raws (`getRawForConsolidation`
with `unseenOnly`; the formatter still re-orders for display). Stored order
is not used: Expand and merges append out of id order, and lowest-id-first
is what keeps the watermark advance exact.

Eligible NPCs are served round-robin, biggest unseen backlog first, one
batch per NPC per round, until the scan has spent 3 calls. Before each
batch the gate is re-evaluated against the current file (the previous batch
moved the watermark), so an NPC drops out once its unseen count is back
below the threshold, or after a failed or zero-yield pass. Whatever is left
waits for the next capture's scan. One scan therefore presents at most 450
observations in total; a 300-observation backlog on one NPC clears on the
first trigger, and several NPCs crossing the threshold together each get a
call. The manual button is unchanged: whole pool, one call.

### 5.4 Overlap protection

- `state.consolidationInFlight` (Set, per NPC name) is held by
  `runConsolidation` itself for the duration of a pass — manual and
  automatic callers alike. A manual click during an automatic pass gets an
  honest "already running or queued" error (queued: the guard is held while
  the background call waits behind a user generation); the driver treats an
  in-flight NPC as handled, not failed.
- `state.autoConsolidationScanInFlight` makes `maybeRunAutoConsolidation`
  a singleton — several seams can fire in quick succession (the cadence
  completing while a Catch Up finishes).
- Automatic API calls pass `trigger: 'auto'`, so the generation coordinator
  classifies them background: they queue behind user-facing work and are
  held while the user generates (`pauseBackgroundJobsDuringGeneration`).

### 5.5 Reporting and the Growth window

Auto-capture conventions: failures ALWAYS toast; successes toast counts
("＋N consolidated claims, M raw observations archived"); a zero-yield pass
gets an informational toast saying those observations stay raw and that a
manual Consolidate still includes them; the start toast is behind the
`growthDebugToasts` debug setting.

If a Growth window is open for an affected NPC (`refreshOpenGrowthModal`,
keyed by the modal's `data-npc`), it is rebuilt in place only when nothing
in it would be lost: no control marked busy (every action button sets
`aria-busy` via `setControlBusy`), no Psychoanalyze portrait on screen, and
focus not inside the content area. Otherwise only the counts line is
updated and the status bar says the evidence list is out of date and to
reopen the window. Unlike the refreshes that follow the user's own clicks,
this one arrives unprompted, and a rebuild mid-action hands busy buttons
back as clickable (Catch Up's own comment warns concurrent actions race the
watermarks), hides the Catch Up progress, and wipes a copy-only portrait.

### 5.6 Chat-switch and pause safety

The driver captures scope before the scan and classifies thrown errors with
`scopeStillCurrent` (the lenient variant — see growth.js's note on
unknown-identity hosts): a chat switch discards the rest of the scan
quietly with no failure stamp (the new chat has its own evidence state).
A paused module stops the scan between batches rather than spending a call
the write seam would refuse.

## 6. Invariants

- Capture is unchanged; the driver only ever runs the existing
  `runConsolidation` pipeline with a bounded input.
- "Accumulate, don't overwrite" holds: `applyConsolidation` still appends to
  the consolidated tier, still archives only cited raws, still validates
  sources against the presented snapshot.
- Evidence store shape unchanged apart from the optional
  `meta.autoConsolidation` container and the optional `expandedAt` stamp on
  Expand-restored raws; the schema passes both through (meta must be an
  object or absent; observation records keep extra fields), and every
  reader is defensive (absent container, non-finite fields) because every
  pre-feature file predates them.
- Off by default; an upgrade that doesn't touch settings changes nothing.

## 7. Explicit exclusions

- No automatic profile regeneration or dossier drafting after a pass (the
  user still reviews what their character sheet says).
- No time-based or wall-clock scheduling — the check runs where the data
  changes (capture completions), not on a timer.
- No bound on the consolidated/archived tiers.
- No automatic second look at stayers: once a pass has seen an observation,
  only a manual Consolidate presents it again.
- No per-record "seen" tracking for identity merges: raws merged in from
  another NPC's file (`tag::obs-NNN`) are presented automatically only when
  their number is above the surviving file's watermark; the rest stay raw
  until a manual Consolidate. Nothing is lost, it just isn't automated.
- No per-NPC threshold configuration (global setting; per-NPC evidence
  files still gate themselves by unseen count and backoff).

## 8. Acceptance criteria

Automated (`test/auto_consolidation.test.js`, 38 tests;
`test/auto_consolidation_modal.test.js`, 5 tests; all passing):

- backoff curve (0 / 20 / 40 / 80-cap) and threshold clamping (10–1000,
  default 100);
- gate: below-threshold blocked; stayers, canon and Expand-restored raws
  never count; backoff measured from the attempt high-water, with the
  legacy-container fallback to the watermark;
- selection: unseen-only, lowest id first regardless of stored order, canon
  excluded before the slice; whole pool without options;
- watermark: advances over what was presented on a productive or zero-claim
  answer; capped below an unpresented unseen raw; not advanced by a thrown
  pass or a reply with no `consolidated` list; a productive manual pass
  resets failures; Expand stamps restored raws and the stamp survives the
  checked commit;
- in-flight guard rejects a concurrent pass ("running or queued") and
  releases on throw;
- driver: disabled → null with no API call; drain works end-to-end; stayers
  never re-trigger and the next pass presents only new evidence; a 500-raw
  backlog spends 3 calls lowest-ids-first and the rest drains next scan;
  four 400-raw NPCs share the 3-call budget round-robin; zero-yield stamps,
  advances, backs off, and retries over newer evidence only; a thrown pass
  stamps, keeps the watermark, and retries the same batch once the bar is
  met; a registry-missing NPC fails honestly while another NPC still drains;
- review regressions (each fails on the first draft): no starvation behind
  160 stayers; no call per small capture with 120 stayers; no re-fire
  without new evidence after a low-yield scan; an expanded claim is not
  rebuilt, including one consolidated before the feature existed;
- Growth window: no-op for another NPC; content kept (counts updated, "out
  of date" note) while an action is busy, a portrait is showing, or focus
  is inside; rebuilt when nothing would be lost.

Host QA (pending, with the rest of v2.21):

- threshold 10, one Capture on an NPC with ≥10 raw → pass fires after the
  capture toast, Growth window counts update, a second capture adding
  nothing does not re-fire;
- a long chat with 150+ uncited raws on one NPC: a capture adding a few
  observations fires nothing; once a threshold's worth of new evidence
  arrives, the pass presents only that (check the request in the API log);
- Expand a claim with the feature on, capture again → the claim is not
  rebuilt;
- click Psychoanalyze (or Catch Up) right after a Capture that triggers a
  pass → the portrait / progress survives, and the status bar says the list
  is out of date.
