# Auto-consolidation of the raw evidence backlog — scope and contract

**Status:** Implemented (code + automated checks). Host QA pending, like the
rest of this cycle's growth work.
**Date:** 2026-11-22
**Source:** internal follow-up to
[GROWTH_PROFILE_INJECTION_RESPONSE.md](./GROWTH_PROFILE_INJECTION_RESPONSE.md).
Since dossier injection shipped, a recurring pattern surfaced: users (and
authors) forget to press Consolidate, so raw observations pile up — 300+ in a
long-running chat is normal, not exceptional. A co-author reviewed the first
draft of this feature; their constraints are §2 verbatim in intent and are
all addressed (§5).
**Area:** the growth evidence store (`knowledge/evidence.js`), the
consolidation pipeline (`knowledge/growth.js`), and a new driver
(`knowledge/auto_consolidation.js`).
**Purpose:** pin the behavior contract before host QA, so the trigger
semantics can be audited rather than rediscovered from code.

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

## 3. What it is

An **opt-in** setting pair in Knowledge module settings:

| Setting | Default | Range |
|---|---|---|
| `growthAutoConsolidationEnabled` | `false` | — |
| `growthAutoConsolidationThreshold` | `100` | 10–1000 |

When enabled, after any capture completes — the auto-capture cadence, or the
manual Capture / Backfill / Catch Up buttons — `maybeRunAutoConsolidation()`
checks every evidence file against the gate (§4) and runs bounded drain
passes for the eligible NPCs. The check is cheap (chat-metadata reads only);
no API call happens unless an NPC is genuinely eligible. It fires even when
a capture added nothing, which is what drains a pre-existing backlog on the
first capture after the feature is enabled.

The preset table (docs/ONBOARDING_PRESET_PLAN.md §2.1) turns both keys on in
**Full** only.

## 4. The gate

A pass becomes eligible only when ALL hold, per NPC:

1. **Count**: non-canon raw count ≥ threshold. Canon claims never count —
   they are user-authored and excluded from consolidation entirely.
2. **Watermark**: ≥ `backoffRequired(failures)` raw observations with a
   numeric id above `meta.autoConsolidation.watermark`.
3. Not already in flight (§5.4), and the module not paused.

The watermark is the "new evidence since the previous attempt" marker, and
it is exact rather than heuristic: raw ids (`obs-NNN`) are minted from a
sequence that scans raw ∪ archivedRaw (`obsIdSequence`), so ids rise
monotonically as evidence arrives. A pass advances the watermark to the
highest id it **presented** — not merely the ones it cited — so uncited
stayers cannot re-arm the trigger. Ids without a numeric suffix count as
not-new (they cannot arm the trigger, only fail to).

**Backoff** is evidence-denominated, not wall-clock: after N consecutive
failed/zero-yield automatic passes, the NPC needs `min(20 × 2^(N−1), 80)`
new observations above the watermark. A retry means "enough has changed to
be worth another pass", mirroring Chronicle's message-denominated
auto-snapshot retry gate (`autoSnapshotRetryAt`). Time-based backoff was
rejected: sessions idle for days, and the wall clock says nothing about
whether a retry has better odds.

## 5. Behavior contract

### 5.1 Scope: the raw backlog only

Auto-consolidation manages `raw[]`. It never bounds `consolidated[]` or
`archivedRaw[]` (that is the separate, unimplemented
GROWTH_EVIDENCE_ARCHIVE_SCOPE.md proposal), never regenerates profiles,
never drafts dossier lines, and never deletes anything — cited raws move to
`archivedRaw`, and **Expand undoes a claim exactly as with manual passes**.

Why automating this pass is acceptable where automating dossier rewrites
would not be: consolidation is tier bookkeeping over machine-captured data
with per-claim provenance and a per-claim undo; the things that need human
judgment (what the character sheet says) still route through staging.

### 5.2 Outcome stamping (`meta.autoConsolidation`)

| Outcome | Watermark | `failures` |
|---|---|---|
| Pass distilled ≥1 claim (auto **or** manual) | advanced to max presented id | reset to 0 (auto driver) |
| Zero admissible claims | **not** advanced | +1 |
| Thrown error (API, parse, registry) | not advanced | +1 |
| Coordinator cancellation / chat-scope change / module paused | untouched | untouched |

The zero-yield row is the retry edge case: the watermark not advancing means
the next attempt (once backoff is satisfied) re-presents the same pool with
whatever new evidence has accumulated — which is the desired retry, under a
rising bar. Manual passes stamp the watermark (they *saw* the evidence) but
never touch `failures` — the failure count only gates the automatic trigger.

`expandConsolidated` lowers the watermark to `minRestoredSeq − 1` when any
restored source sits at/below it: undoing a consolidation must make the
restored evidence eligible again, not wait for evidence newer than the
pass that was just undone.

### 5.3 Bounded batches (drain-to-threshold, capped)

| Constant | Value | Where |
|---|---|---|
| `AUTO_CONSOLIDATION_BATCH_LIMIT` | 150 | per API call, oldest-first |
| `AUTO_CONSOLIDATION_MAX_BATCHES` | 3 | per NPC per scan |
| `AUTO_CONSOLIDATION_BACKOFF_BASE` | 20 | `knowledge/auto_consolidation.js` |
| `AUTO_CONSOLIDATION_BACKOFF_CAP` | 80 | 〃 |

A batch presents the oldest 150 non-canon raws (stored order = capture
order; the formatter still re-orders for display). After each batch the
gate is re-evaluated against the current file — the batch archived cited
raws and advanced the watermark, so both legs moved. The loop stops at the
cap, leaving the remainder for the next trigger. One scan presents at most
450 observations per NPC; a 300-observation backlog clears on the first
trigger, roughly what a manual pass does today, just split. The manual
button is unchanged: whole pool, one call.

### 5.4 Overlap protection

- `state.consolidationInFlight` (Set, per NPC name) is held by
  `runConsolidation` itself for the duration of a pass — manual and
  automatic callers alike. A manual click during an auto pass gets an
  honest "already running" error; the driver between batches treats an
  in-flight NPC as handled, not failed.
- `state.autoConsolidationScanInFlight` makes `maybeRunAutoConsolidation`
  a singleton — several seams can fire in quick succession (the cadence
  completing while a Catch Up finishes).
- Automatic API calls pass `trigger: 'auto'`, so the generation coordinator
  classifies them background: they queue behind user-facing work and are
  held while the user generates (`pauseBackgroundJobsDuringGeneration`).

### 5.5 Reporting

Auto-capture conventions: failures ALWAYS toast; successes toast counts
("＋N consolidated claims, M raw observations archived"); a zero-yield pass
gets an informational toast (its observations stay raw — the user should
know why); the start toast is behind the `growthDebugToasts` debug setting.
If a Growth window is open for an affected NPC it is refreshed in place
(`refreshOpenGrowthModal`, keyed by the modal's `data-npc`).

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
  `meta.autoConsolidation` container; the schema's meta check (object or
  absent) tolerates it, and every reader is defensive (absent container,
  non-finite fields) because every pre-feature file predates it.
- Off by default; an upgrade that doesn't touch settings changes nothing.

## 7. Explicit exclusions

- No automatic profile regeneration or dossier drafting after a pass (the
  user still reviews what their character sheet says).
- No time-based or wall-clock scheduling — the check runs where the data
  changes (capture completions), not on a timer.
- No bound on the consolidated/archived tiers.
- No per-NPC threshold configuration (global setting; per-NPC evidence
  files still gate themselves by count and watermark).

## 8. Acceptance criteria

Automated (test/auto_consolidation.test.js, 27 tests, all passing):

- backoff curve (1 / 20 / 40 / 80-cap) and threshold clamping (10–1000,
  default 100);
- gate: below-threshold blocked; watermark blocks re-trigger with uncited
  stayers above threshold; canon excluded from both legs; failures raise
  the new-evidence bar;
- batching: limit slices the oldest non-canon raws; whole pool without a
  limit;
- watermark: advances to the highest PRESENTED id on a successful pass; not
  advanced on zero-yield; `expandConsolidated` lowers it;
- in-flight guard rejects a concurrent pass and releases on throw;
- driver: disabled → null with no API call; drain works end-to-end; the
  retry edge case does not re-fire without new evidence and re-arms on one
  new observation; 500-raw backlog stops at 3 batches leaving 50; zero-yield
  stamps, backs off by new-evidence count, and succeeds after the bar is
  met; a thrown pass stamps and toasts; a registry-missing NPC fails
  honestly while another NPC still drains.

Host QA (pending, with the rest of v2.21): threshold 10, one Capture on an
NPC with ≥10 raw → pass fires after the capture toast, growth window counts
update, a second capture adding nothing does not re-fire.
