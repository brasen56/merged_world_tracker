# Growth profiles that describe the character now — scope and implementation plan

**Status:** Phase 1 implemented, 2026-11-14; real-model host check pending
(release gate, §10). Derived from Revision 2 of the review, which folds in the
co-author's review; the decisions recorded there are settled for this scope.
One implementation phase plus a host check (§10).
**Date:** 2026-11-14
**Source:** [GROWTH_PROFILE_TIME_ORDER_REVIEW.md](./GROWTH_PROFILE_TIME_ORDER_REVIEW.md) —
the request (verbatim), the diagnosis, the decisions on the four asks, and the
landmines. That file is the request and decision record; this doc is the
buildable version of its §5 design.
**Related:** [GROWTH_PROFILE_INJECTION_SCOPE.md](./GROWTH_PROFILE_INJECTION_SCOPE.md).
The Personality/Voice draft built there is the path the requester uses, and its
evidence view changes here (§4.7).
**Area:** Growth evidence read paths and prompts — `knowledge/evidence.js`,
`knowledge/growth.js`, `knowledge/growth_dossier.js`, `knowledge/prompts.js`,
plus a read-only helper out of `core/message_identity.js`. The only write-path
change is optional new-capture provenance (§4.5).
**Purpose:** fix the behavior contract, safety boundaries, and checks before
implementation, so work can start when the reply goes out.

## 1. Problem

Generated profiles blend early and current behavior into one conflicted
personality, so a profile used to update an NPC's Personality and Voice can
carry pre-growth traits into the next scene. Both model calls behind it are
time-blind, and neither ordering hint they get is story order:

- **Consolidate** lists unconsolidated observations in `raw[]` array order —
  capture order — and sends no timestamp (`knowledge/growth.js:754`, list from
  `getRawForConsolidation`, `knowledge/evidence.js:843`).
- **Generate Profile** lists consolidated claims in pass order, then raw
  observations in capture order, with no `ts`, `firstSeen` or `lastSeen`
  (`knowledge/growth.js:351`, `knowledge/evidence.js:1120`). The only ordering
  hint, `(msg N)`, is the live chat position — null for backfilled
  observations, which are exactly the oldest scenes.
- **Capture order is not story order.** When Catch Up or Backfill recovers old
  history after continuous capture, the oldest scenes sit at the *end* of both
  lists, where a model reads them as the most recent.
- **The prompts ask for the blend.** The profile prompt tells the model real
  people are contradictory and to close on a tension
  (`knowledge/prompts.js:386`, `:392`); the consolidation prompt's 40–60%
  reduction target (`knowledge/prompts.js:488`) rewards claims that fold a
  change into one trait.

The fix is **read-time only**: sort the evidence by message time, give each
item its position in the story, show each consolidated claim's own source
claims in order, count support by distinct source messages, rewrite the
prompts, and give the Personality/Voice draft the same ordered view. Nothing is
written back to the store, the profile is still only ever read from evidence
(the leaf rule holds), and there is no migration.

## 2. Settled decisions (from the review)

The four asks, and what was decided on each:

1. **Carry message order through Consolidate and Generate — the ordering half:
   do it.** Sort by `ts`, label each item with its story position, in both
   prompts. The other half — consolidation looking back at claims from earlier
   batches — is **deferred** (§6): Generate already sees every claim from every
   pass at once, and with chronology in its view it can recognize change,
   persistence and situational behavior itself. Look-back may still improve
   consolidation later; it does not block this fix, and `continues`/`replaces`
   links are not added unless re-emitted claims become a real problem.
2. **Preserve changes inside a consolidated claim — do it, at read time.**
   Each claim sends its first and last position, its phase spread, its count of
   distinct source messages, its earliest and latest quotes, and — for any
   claim with two or more distinct source messages — a bounded, ordered sample
   of its source *claims*, each with its position. That reveals "waits for
   permission" then "takes initiative" hiding inside one blended claim. Phases
   are labels only; samples do not depend on crossing a phase boundary.
3. **Weight sustained later behavior — mostly a prompt change** (§4.6), riding
   on the chronology asks 1 and 2 supply. Support means **distinct source
   messages**, never observations: several observations captured from one
   message are one moment of evidence, not repeated support. The profile stays
   a mirror — if nothing changed, it says so and invents no arc.
4. **Regenerate from already-consolidated evidence — already how Generate
   works.** The 📝 button calls `regenerateProfile` (`knowledge/growth.js:818`),
   which never recaptures. With asks 1–3 done at read time, existing
   consolidated evidence produces better profiles with no extra steps. No work
   beyond the shared view.

## 3. Scope at a glance

| Workstream | Change | Boundary |
| --- | --- | --- |
| Timed evidence view | New pure view: positions 0–100 on distinct timestamps, phase labels, chronological list, per-claim spans and support (§4.1) | Read-time only; `getEvidenceForProfile`'s output and the evidence list UI are unchanged (§4.8) |
| Source-claim samples | Bounded, ordered source claims per multi-message claim (§4.2) | Per-claim cap and overall budget, spent on the widest claims first; the dossier variant carries no quotes or ids |
| Position-unknown rules | Saved provenance, `verified: false`, `ts` 0/non-finite, and a qualified legacy heuristic decide (§4.3) | Unknown items are listed last and never enter positions, spans or support counts |
| Message keys and ties | Support and ranking key on distinct source messages; equal timestamps share one position (§4.4) | ILS restored messages get a read-only identity; `ILS_Originals` is never written |
| Prompts | Profile, consolidation and Psychoanalyze rewritten for chronology (§4.6) | Anti-typology and evidence-only rules unchanged; prompts stay deterministic |
| Dossier draft | Same ordered view through a split projection (§4.7) | Draft validation and the echo check keep `ts`/`firstSeen`; samples carry no citable ids |
| New-capture provenance | Optional `tsSource` and `msgKey` on new captures (§4.5) | Older data falls back to the read-time rules; no migration |

Cost: no new model calls — the same Consolidate, Generate, Psychoanalyze and
draft calls run with reordered, annotated input. The sample budget (§4.2)
bounds only the samples; each claim's span, support and receipt lines grow
with the number of claims. Measured on the largest real store (409 claims,
532 raw observations): Generate input +28%, Personality/Voice draft input
+40% (§10).

## 4. Design

### 4.1 The timed evidence view

One pure function builds the view — for example `buildProfileEvidenceView(file)`
— in a new module (§9, working decision 1). Steps:

1. **Collect the dated observations.** Every raw observation, plus every
   archived observation that a *surviving* consolidated claim cites (§5).
   De-duplicate by raw id (Expand can move one raw into two places), and set
   aside position-unknown items (§4.3). One shared position domain per NPC, so
   Generate, Consolidate and the draft agree at the same store state (§9,
   working decision 2).
2. **Positions.** Rank the NPC's distinct timestamps from 0 to 100; ties share
   a position (§4.4). Phase words are labels on top: *early* below 34,
   *middle* 34–66, *late* above 66. Each item shows both, for example
   "late 84". Apply the order-unknown rule first (§4.4).
3. **Support.** Count distinct source-message keys (§4.4), never observations.
4. **For each consolidated claim**, from its dated sources: first and last
   position; phase spread by distinct messages (`early ×6, middle ×1, late
   ×0`); total distinct source messages; the latest quote, plus the earliest
   quote when the claim crosses a phase; and its source-claim samples (§4.2).
   A same-phase earliest receipt costs tokens without adding chronology; the
   samples carry change inside one phase.
5. **For each raw observation:** its position and phase.
6. **Order the list** chronologically by first position, so the model reads
   the story forward. Position-unknown items go last, marked as such.

Example of one claim in the prompt:

```
7. [trait] [consolidated] Defers to others before acting on household matters.
   Seen: early 4 → middle 58 · 7 source messages: early ×6, middle ×1, late ×0
   Earliest: "Should I—may I start the laundry?"  Latest: "I'll wait until you say."
   Source claims (equal positions do not imply order):
     early 4   asks permission before starting chores
     early 9   waits to be told before serving dinner
     early 21  apologizes for moving furniture unasked
     … 1 more …
     early 30  checks before answering the door
     middle 58 hesitates at the threshold until invited in
```

Positions rank by message order, not elapsed time: a two-month hiatus in the
RP must not squash everything before it into "early" (§6 of the review, §4.4
here). Real dates and epoch values are never shown to the model — it may
confuse them with in-story time from Chronicle or the calendar.

### 4.2 Source-claim samples

- **Who gets them:** any consolidated claim with two or more distinct source
  messages. Crossing a phase boundary is *not* required — a change can happen
  entirely within the last third.
- **One sample per source message.** When several observations share a
  message, use the one with the lowest id.
- **Per-claim cap:** the earliest *k* and latest *k* dated source messages,
  *k* = 3 to start. A claim with no more than 2*k* dated source messages
  shows all of them. Position-unknown sources (§4.3) follow the dated ones,
  at most *k* of them, so they never take the latest slots. Elided messages
  show as counts: "… N more …" between the dated halves, "… N more with
  unknown order …" after the undated ones.
- **Overall budget:** a fixed character budget for all samples — starting
  value about 8,000 characters each for the profile prompt and the dossier
  draft. Small local models struggle with large prompts; tune on one.
- **Deterministic allocation rule:** rank claims by span (last position minus
  first), widest first; ties go to more distinct source messages, then claim
  id; claims with no position rank last. Each claim in turn gets the largest
  *k* (3, 2, 1) whose samples still fit the remaining budget, or none. The
  span and the receipts (§4.1) always survive. The same evidence must always
  produce the same prompt.
- *Revision, 2026-11-14 review:* the first rule lowered *k* for every claim and
  then dropped samples from the claims with the fewest source messages. On a
  real 409-claim store it left 21 claims of 49–260 source messages with only
  their two endpoints — repeating the receipts — and nothing for the 71 claims
  whose sources span more than 30 positions, the claims most likely to hide a
  change.
- **The dossier draft** uses the same samples minus quotes and ids (§4.7).

### 4.3 Position-unknown rules (fallback timestamps)

`extractMsgTs` falls back to `Date.now()` — the capture time — when an
observation has no message index, an out-of-range one, or an unparseable
`send_date` (`knowledge/evidence.js:1312`). Unverified backfill observations
keep the index the model cited (`knowledge/growth.js:1382`), which for a
restored message is the summary's index, so they get the summary's
`send_date`. ILS originals with unreadable dates get `ts` 0
(`normalizeSendDate`, `knowledge/ils_compat.js:209`). Under recency weighting,
those fallbacks would become the character's "current self".

**Rule: position unknown.** Such items are listed after the dated items and
left out of positions, spans and support counts. Check in this order; the
first match decides:

1. **`verified: false`** always means position unknown — the heuristic below
   can't catch the summary-date case.
2. **`ts` 0, or a non-finite `ts`,** means position unknown.
3. **Saved provenance.** New captures record where the timestamp came from,
   `tsSource: 'message' | 'cited' | 'capture'` (§4.5). `cited` and `capture`
   are position unknown; `message` is dated and skips the heuristic.
   *Revision, 2026-11-14 review:* provenance came first in the first draft. It
   can't: a quote never matched in its cited message records that message's
   date (for ILS backfill, the summary's), so verification decides first, and
   such captures are stamped `cited` rather than `message`.
4. **Legacy heuristic.** With no saved provenance, treat the timestamp as a
   fallback when `ts` and `capturedAt` are both finite and
   `0 <= capturedAt - ts < 50`. Both values come from `Date.now()` within one
   call, while a real message is normally at least one API call older. This is
   a useful heuristic, not a guarantee. A negative difference (message dated
   after its capture — a clock or import oddity) is *not* a fallback.

A stored `firstSeen`/`lastSeen` can include a fallback source, so **compute
spans at read time from the sources**, never from the stored fields.

The evidence validator keeps unknown record fields (`checkObservation`,
`knowledge/schema.js:335`), so `tsSource` and `msgKey` need no schema change.
Pin that with a test anyway (§7).

### 4.4 Source-message keys and ties

Sorting by `ts` can't order messages that share a timestamp, and counting
observations would let one message masquerade as repeated support.

- **Source-message key.** New captures save the cited message's stable
  identity as `msgKey` (§4.5), using the same identity the capture cursor uses
  (`getOrCreateReceiptIdentity`, `core/message_identity.js:31`). Observations
  without one — legacy, or no identity — use `ts:<ts>`. Every message sharing
  a timestamp is then one moment: that undercounts slightly and never
  overcounts.
- **ILS landmine.** `getOrCreateReceiptIdentity` *creates* a UUID when a
  message has none — it writes `extra.mwt_uuid` and saves the chat. On a
  message restored from an ILS summary that would modify `ILS_Originals`,
  which MWT treats as strictly read-only. Restored messages use a **read-only**
  identity: an existing `id`, `mesid` or `mwt_uuid`, or nothing (so the `ts`
  key applies). The read-only form is already computed inline at
  `knowledge/growth.js:903-908`; extract it instead of calling the create
  path.
- **Tie policy.** Messages sharing a timestamp share one position, and nothing
  in the view claims one came before the other. Positions rank distinct
  timestamps, so one message can never fall on both sides of a phase boundary.
  Display order inside a tie (live `msgIdx` when both have one, then id) is
  cosmetic only.
- **Order-unknown rule.** If the timestamps don't separate the evidence, the
  view must say so, not imply an order — an imported chat where every message
  has the same date, or a host with coarse dates (the Aikobots fork stores
  minute precision). Starting rule: fewer than 3 distinct timestamps, or one
  timestamp holding more than a quarter of the dated observations → omit
  positions and phases and label the evidence "order unknown".

### 4.5 New-capture provenance (optional, small)

Live and backfill captures add two fields per observation, stamped in
`appendRawObservations` (`knowledge/evidence.js:696`):

- `tsSource` — where the timestamp came from (§4.3): `message` (the quote
  was verified in that message), `cited` (the quote was never matched; the
  date is the model-cited message's, kept for traceability only), or
  `capture` (no usable `send_date`, so the capture time);
- `msgKey` — the verified message's identity, read-only for ILS restored
  messages (§4.4); null for unverified captures, which never count as
  support.

Both are optional; older data falls back to the read-time rules. Mixed data
can count one message twice (a legacy `ts` key plus a new `msgKey`), which
affects only support counts around the upgrade and is accepted. This
workstream is droppable without touching the rest of the design.

### 4.6 Prompts

**Profile prompt** (`GROWTH_PROFILE_PROMPT`, replacing the contradiction and
tension guidance at `knowledge/prompts.js:386`, `:392`):

- The evidence is in story order with positions and phases. Describe the
  character **as they are in the latest part of the story**.
- A behavior seen earlier and replaced later is **change, not contradiction** —
  inside a single phase too. Mention earlier behavior only if it explains the
  present ("still asks first when a guest is present"), and only if late
  evidence shows it recurring in that situation.
- A real tension needs **both sides present in late evidence**.
- A behavior backed by one recent source message is a **reaction, not a new
  default**, unless it fits the broader pattern.
- Traits seen across the whole story are core. Keep them.
- If nothing changed, say so. Do not invent an arc.
- If the evidence is marked "order unknown", don't infer change from list
  order.

Keep the anti-typology and evidence-only rules unchanged.

**Consolidation prompt** (`GROWTH_CONSOLIDATION_PROMPT`): each raw observation
carries its position and phase, in story order. Tell it **not to merge
observations that show a behavior changing** — write the earlier and later
behavior as separate claims — and make the 40–60% target at
`knowledge/prompts.js:488` explicitly yield to that rule.

**Psychoanalyze** (`GROWTH_PSYCHOANALYZE_PROMPT`): it formats the same
evidence (`knowledge/growth.js:401`), so give it the timed view, and fix the
"recent behavioral observations" wording (`knowledge/prompts.js:413`), which
has not been true since backfill existed.

### 4.7 Dossier draft evidence

The Personality/Voice draft is the path the requester uses, and the bug is
already shipped there: `growthDossierEvidence` sends consolidated claims with
`firstSeen` only (`knowledge/growth_dossier.js:36`), so a trait that began
early and is still going looks old — while `GROWTH_DOSSIER_PROMPT` says an old
habit is a condition only if it recurred after the change
(`knowledge/prompts.js:365`).

**Split projection.** The model gets positions, phases, distinct-message
spreads and id-less source-claim samples (the §4.2 samples minus quotes and
ids). The validator and the echo check keep the times they read: draft
validation resolves cited ids (`knowledge/growth_dossier.js:192`, `:200`), and
`growthEchoStatus` reads `firstSeen`/`ts` from the same projection
(`knowledge/growth_lineage.js:73-75`). Neither changes behavior. The model
projection also drops keys that restate another or qualify quotes it never
gets — `orderUnknown` (a null position means order unknown, and the draft
prompt says so), `earliestTied`/`latestTied` — plus empty sample fields; on
the largest real store that saves about 43,000 characters.

Three constraints:

- **Samples carry no citable ids.** Draft validation resolves cited ids
  against non-archived evidence only, and samples come from archived sources —
  a cited sample id fails with "must cite existing evidence". Nest the samples
  under their parent claim; the model cites the parent's id.
- **Keep the times the echo check reads.** Don't replace epoch values with
  labels in the shared projection (a revision-1 idea, retracted): split the
  projection instead.
- **The whitelist test changes on purpose.** `test/growth_dossier.test.js:189`
  pins the projection's exact shape and the rule "no receipts/archive". Update
  it deliberately: archived source *claim text* may now travel inside samples;
  quotes and receipts still never do.

### 4.8 What does not change

- **`getEvidenceForProfile` stays as it is.** The Growth window renders its
  evidence list from the same function (`knowledge/render.js:1337`, `:1417`),
  a test pins its output (`test/knowledge_module3_review.test.js:84`), and so
  does the "Generated from N observations" count. The timed prompt view is a
  separate function.
- **The 📝 Generate Profile flow stays as it is** — same button, same
  `regenerateProfile`, no recapture (ask 4).
- **No UI changes.** Whether the evidence list should also show positions is
  an open item (§8), not this phase.
- **No evidence writes** beyond the optional §4.5 fields; no migration.

## 5. Invariants

- **Read-time only.** The fix changes what the model reads, never what is
  stored. Hand-edited claim text, deletions and receipts are untouched.
- **The leaf rule holds.** The profile is still read only from evidence (and
  canon); nothing generated feeds back into capture.
- **Archived is not "all valid evidence."** `deleteConsolidated` leaves deleted
  claims' sources in `archivedRaw` (`knowledge/evidence.js:998`), so archived
  observations are reached **only through the `sources` of claims that still
  exist**. No mutating "rebuild consolidation" action — it would resurrect
  deleted evidence and discard hand-edited claim text.
- **No real dates or epoch values reach the model.** Positions are ranks, not
  clock time.
- **Deterministic prompts.** Same evidence, same prompt — including the sample
  shrink rule.
- **`ILS_Originals` is never written.** Identity for restored messages is
  strictly read-only.
- **Spans and support are computed at read time from the sources**, never from
  stored `firstSeen`/`lastSeen`, which can include fallback timestamps.

## 6. Explicit exclusions and deferrals

- **Consolidation look-back** at claims from earlier batches (review §3, ask
  1) — deferred until the requester reports whether profiles still blend after
  this ships. `continues`/`replaces` links along with it.
- **Any write-back to existing evidence**, including a "rebuild consolidation"
  action and migration of old fallback timestamps — the latter is detected at
  read time (§4.3).
- **Evidence list UI changes** (positions or story-order sort) — open item
  (§8), not needed for the fix.
- **No new model setting, no new model calls, no new UI.**

## 7. Acceptance criteria

Automated (fixtures):

- **Reversed capture order:** early "waits for permission" scenes appended
  *after* late "takes initiative" scenes (Catch Up after continuous capture)
  — the prompt lists the early scenes first, labeled *early*.
- **Change within one phase:** a claim whose sources move from deference to
  initiative entirely inside the last third gets its ordered samples.
- **Several observations from one message:** counted as one source message,
  sharing one position.
- **Equal timestamps:** distinct messages sharing a `ts` share a position; the
  view never states an order between them; one message never straddles a phase
  boundary.
- **All-identical timestamps:** the view says "order unknown" and shows no
  phases.
- **Fallback detection:** saved `tsSource` wins over the heuristic;
  `verified: false`, `ts` 0, `tsSource: 'cited'` (even if verified) and a
  0–49 ms fallback are position unknown; a negative difference and a
  non-finite value are not fallbacks. An unmatched quote — live, or ILS
  backfill citing the summary — is stamped `cited` with no `msgKey`.
- **Deleted-claim sources:** an archived observation whose claim was deleted
  never reaches the prompt.
- **ILS read-only:** a backfill capture from a restored message leaves
  `ILS_Originals` unchanged (no `mwt_uuid` written).
- **Budget:** over budget, the widest claims keep samples first, each at the
  largest *k* that fits, ahead of narrower claims with more source messages;
  the same evidence produces the same prompt every time; spans and receipts
  always survive.
- **Undated sources:** position-unknown sources follow a claim's dated
  samples, capped at *k*, and never displace its latest dated samples.
- **Dossier draft:** samples carry no ids; a draft citing the parent claim
  passes validation with samples present; echo results are unchanged; the
  updated whitelist test still forbids quotes and receipts.
- **Unchanged outputs:** `getEvidenceForProfile` output, the evidence list UI
  and the "Generated from N observations" count are unchanged.
- **Hiatus:** a two-month gap in `ts` doesn't shift positions.
- **New fields kept:** an observation with `tsSource` and `msgKey` survives an
  evidence save.

Host check, on a real model: run a character whose arc matches the requester's
example. Fully consolidate, Generate, and confirm the profile describes the
later behavior with any old habit written as a condition. Then run the
Personality/Voice draft from that profile and confirm it does the same. Repeat
once on a small local model to tune the sample budget. This check is the
release gate.

## 8. Open items

1. Should the Growth window's evidence list also show positions, or sort by
   story order? Not needed for the fix; it would help users audit it.
2. Should the reply to the requester ask them to report back after this ships,
   before anyone commits to the consolidation look-back?
3. Starting values to confirm on the host check: *k* = 3, the 8,000-character
   sample budget, and the order-unknown thresholds (fewer than 3 distinct
   timestamps, or one holding over a quarter of the evidence). Also decide
   whether the budget should scale with the number of claims: at 8,000
   characters a 409-claim store gives samples to only its 8 widest claims
   (§10, review fixes).

## 9. Working decisions (ours, absent requester input)

1. **A new pure module** — proposed `knowledge/growth_timeline.js` — holds the
   view: collection, position ranking, phase labels, the order-unknown rule,
   fallback detection, message keys (with the read-only identity variant),
   support counts, per-claim spans/spreads/quotes, and samples with caps,
   budget and shrink. `evidence.js` keeps its read paths; consumers are
   `growth.js` (Generate, Psychoanalyze, Consolidate) and `growth_dossier.js`
   (the projection). Host-independent and testable headless, in the
   `growth_dossier.js` tradition.
2. **One shared position domain per NPC** — raw plus surviving-claim-cited
   archived, position-unknown set aside — used by all three prompt views, so
   positions agree between Generate, Consolidate and the draft at the same
   store state. The review defines the collection once (§5.1) and applies it
   to both prompts; this makes that explicit.
3. **New-capture provenance (§4.5) is in scope but droppable.** The read-time
   rules don't depend on it; the legacy heuristic covers old data either way.
4. **The Psychoanalyze fix rides along** — same view, same chronology bug, and
   its "recent" wording is wrong today.

## 10. Implementation orientation and phase plan

### Implementation record — 2026-11-14

- Added the pure shared timeline in `knowledge/growth_timeline.js`, consumed
  by Generate, Psychoanalyze, Consolidate and the dossier model projection.
- Included optional new-capture `tsSource` and read-only `msgKey` provenance;
  restored ILS originals never receive newly created identities.
- Kept `getEvidenceForProfile`, evidence-list UI/counts, consolidation's
  numeric-id snapshot, and the validator/echo timestamp projection unchanged.
  The model-only dossier projection excludes timestamps, quotes and receipts;
  nested archived source-claim samples have no citable ids.
- Defaults retained pending host tuning: *k* = 3; 8,000 characters of serialized
  sample payload (including elision counts); fewer than 3 distinct timestamps
  or any timestamp holding strictly more than 25% of dated observations marks
  order unknown. Both model projections use the same sample selection/budget.
- Added 25 timeline/projection/integration fixtures plus a full restored-ILS
  backfill regression, and deliberately updated dossier projection pins.
- **Automated gate passed:** `npm test -- --maxWorkers=2` — 186 files,
  4,723 tests passed; `npm run lint` and `git diff --check` passed.
- **Host check pending:** run the permission-to-initiative arc through full
  consolidation, Generate, and Personality/Voice drafting, then repeat on a
  small local model. Confirm current defaults and conditional old habits;
  record model names and any budget/threshold tuning here before release.

### Review fixes — 2026-11-14

A read-only run of the view over the real local stores (3 chats, 7 NPCs
each) found four problems; all are fixed in the same working tree. On that
data order-unknown never fired (the largest timestamp share was 10.7%), the
legacy heuristic never fired, and about 1% of observations were unverified.

1. **Samples went to the wrong claims** (§4.2). Replaced the global shrink
   with span-first allocation at the largest *k* that fits. Largest store
   (Derek, 409 claims): the 8 widest claims (span ≥ 46) now get full *k* = 3
   samples, where before 21 claims of 49–260 source messages got only their
   endpoints.
2. **Prompt growth was unbudgeted** (§3). The earliest receipt is now sent
   only for claims that cross a phase, span and support share one line, and
   the draft projection drops redundant keys (§4.7). Largest store, old
   format → first implementation → now: Generate 251k → 359k → 322k
   characters; Personality/Voice draft 205k → 330k → 288k.
3. **Undated sources took the latest sample slots** (§4.2): a fixture with
   three restored sources hid every "takes initiative" sample. Dated
   samples are now windowed alone, undated ones follow, capped at *k*.
4. **Unverified captures were stamped `tsSource: 'message'`**, with the
   summary's date and key for ILS backfill — safe only because
   `verified: false` was checked first, contrary to §4.3's order. They are
   now `cited` with no `msgKey`, `cited` is position unknown on its own, and
   §4.3 lists the order the code uses.

Regressions added for all four, and the affected pins updated on purpose.
**Automated gate passed:** `npm test -- --maxWorkers=2` — 186 files, 4,732
tests passed; `npm run lint` and `git diff --check` passed.

Still for the host check (§8.3): at 8,000 characters, only 8 of the largest
store's 376 multi-message claims get samples, and 79 claims spanning more than
30 positions get none. Decide whether the budget should scale with the
number of claims.

Line numbers verified 2026-11-14. **One phase, read-time only** (plus the host
check as the release gate); the deferred consolidation look-back is excluded
(§6).

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| 1 | Timed evidence view, sample budget, prompt rewrites, dossier split projection, optional provenance, fixtures | None |

### Phase 1 — read-time chronology

**Goal:** every Growth model call that reads evidence sees story order, and
the prompts use it.

Work items in rough order:

1. The timeline module (§9.1): collection and de-duplication, position
   ranking and phase labels, the order-unknown rule, fallback detection
   (§4.3), message keys with the extracted read-only identity (§4.4), support
   counts, per-claim stats, and samples with caps, budget and the shrink rule
   (§4.2).
2. `buildProfileEvidenceView`; `generateProfile` (`knowledge/growth.js:351`)
   and Psychoanalyze (`knowledge/growth.js:401`) format from it; the profile
   and Psychoanalyze prompts rewritten (§4.6).
3. Consolidation input gains positions and story order
   (`knowledge/growth.js:754`, list from `getRawForConsolidation`), and the
   consolidation prompt gets the no-merging-change rule with the reduction
   target yielding (§4.6).
4. The dossier split projection and id-less samples
   (`knowledge/growth_dossier.js:36`); the whitelist test updated deliberately
   (`test/growth_dossier.test.js:189`).
5. Optional: `tsSource` and `msgKey` stamped in `appendRawObservations`
   (`knowledge/evidence.js:696`), with the schema pin test.
6. The §7 fixtures, as a new headless suite for the timeline module plus the
   dossier and unchanged-output pins.

**Exit gate:** every §7 automated criterion passes; `npm test`, `npm run
lint` and `git diff --check` pass; the host check is scheduled but not
blocking merge — it gates release. Record completion here, including the tuned
values of *k*, the budget and the thresholds (§8.3).

Orientation by file (paths relative to the repository root):

- `knowledge/evidence.js` — `getRawForConsolidation` (:843) supplies the
  consolidation list; `getEvidenceForProfile` (:1120) is **unchanged** (UI +
  pinned test); `deleteConsolidated` (:998) is why archived ≠ valid evidence;
  `appendRawObservations` (:696) stamps the optional fields;
  `extractMsgTs` (:1312) is the `Date.now()` fallback; `firstSeen`/`lastSeen`
  (:925-935) are computed from sources but never trusted for spans.
- `knowledge/growth.js` — `generateProfile` evidence formatting (:351);
  Psychoanalyze formatting (:401); `consolidateEvidence` raw text (:754);
  `regenerateProfile` (:818) unchanged; unverified backfill keeps the cited
  index (:1382); the inline read-only identity at :903-908 is extracted, never
  the create path.
- `knowledge/prompts.js` — `GROWTH_PROFILE_PROMPT` (:386, :392);
  `GROWTH_CONSOLIDATION_PROMPT` (:488); `GROWTH_PSYCHOANALYZE_PROMPT` (:413);
  `GROWTH_DOSSIER_PROMPT` (:365) may need minor wording for the samples.
- `knowledge/growth_dossier.js` — `growthDossierEvidence` (:36) becomes the
  split projection; validation (:192, :200) resolves ids against non-archived
  evidence only, unchanged.
- `knowledge/growth_lineage.js` — `growthEchoStatus` (:73-75) keeps reading
  `ts`/`firstSeen`; unchanged.
- `knowledge/render.js` — evidence list (:1337, :1417) and the 📝 button
  (:1904) unchanged.
- `core/message_identity.js` — `getOrCreateReceiptIdentity` (:31) creates and
  persists `mwt_uuid`; only the extracted read-only form is used here.
- `knowledge/ils_compat.js` — `normalizeSendDate` (:209) returns 0 for
  unreadable dates (a §4.3 position-unknown input).
- `knowledge/schema.js` — `checkObservation` (:335) keeps unknown record
  fields; pin `tsSource`/`msgKey` survival with a test.
- Proposed new module `knowledge/growth_timeline.js` (§9.1) plus a
  `test/growth_timeline.test.js` suite.
