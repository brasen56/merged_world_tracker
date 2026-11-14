# Growth profiles that describe the character now — request review

**Status:** Revision 2, 2026-11-14. Nothing built, and no reply sent to the
requester yet. Revision 1 was our review of the request. Revision 2 folds in
the co-author's review of it (record in §8).
**Request received:** 2026-11-14 on GitHub (recorded verbatim in §1).
**Related:** [GROWTH_PROFILE_INJECTION_SCOPE.md](./GROWTH_PROFILE_INJECTION_SCOPE.md).
The requester uses profiles to update Personality and Voice through that
feature, so its draft step is part of this problem (§4.3).
**Scope:** [GROWTH_PROFILE_TIME_ORDER_SCOPE.md](./GROWTH_PROFILE_TIME_ORDER_SCOPE.md) —
the buildable version of §5.

## Summary

The request is sound and the diagnosis is right. Both model calls behind it
(Consolidate and Generate Profile) receive **no timing information at all**,
and the profile prompt actively tells the model to merge early and late
behavior into one "tension".

The fix happens when the evidence is read, so nothing is written back to the
store:
- sort the evidence by message time,
- give each item its position in the story,
- show each consolidated claim's own source claims in order,
- count support by distinct source messages,
- rewrite two prompts,
- give the Personality/Voice draft the same ordered view.

There is no migration, and the profile is still only ever read from evidence
(the leaf rule holds). The one write-side change is optional: new captures
also record which message they cite and where their timestamp came from.

Having Consolidate look back at claims from earlier batches is deferred
(§3, ask 1). It may still improve consolidation itself, but this symptom can be
fixed without it.

---

## 1. The request (verbatim)

> **The idea**
> When I click Generate Profile in MWT's Growth panel, I want the profile to
> describe how the character typically acts and speaks now. Earlier scenes
> should help MWT understand how the character changed, and sustained later
> behavior should establish their current defaults.
>
> For example, Character used to wait for permission. Later, he consistently
> takes initiative, handles household responsibilities, and states his
> boundaries. His generated profile should reflect those later patterns. If he
> still waits for permission in a specific situation, the profile should
> describe when that happens.
>
> **Why**
> I've captured my RP from the beginning and fully consolidated Growth
> evidence for five characters. The generated profiles sometimes blend early
> and current behavior into a single personality. When I use a profile to
> update an NPC's Personality and Voice, those older traits can carry into the
> next scene and make the character act as they did before their growth.
>
> **Requested behavior**
> - Carry source-message order through Consolidate and Generate Profile. Use
>   the order of the original messages even when older scenes were captured
>   later. When consolidating new observations, consider relevant claims from
>   earlier batches so MWT can recognize when a behavior changed, persisted, or
>   became specific to a situation.
> - Preserve changes within a consolidated claim. When a claim draws on
>   multiple phases of the story, use its linked source observations to
>   identify which behavior occurred when. A date range and a single
>   representative quote can miss the change.
> - Give sustained later behavior more weight in the current profile. Keep
>   traits that recur throughout the story, and interpret isolated recent
>   reactions in the context of the broader pattern. Include earlier behavior
>   in the written profile only where it helps explain how the character acts
>   or speaks today.
> - Support regeneration from evidence that is already consolidated. Use the
>   saved source references and archived observations so users can regenerate
>   without recapturing scenes or manually expanding claims.

---

## 2. Why profiles blend today

**Consolidate is time-blind.** `consolidateEvidence` lists the unconsolidated
observations in `raw[]` array order, which is *capture* order, as
`[n] [category] claim / Quote: "…"`. It sends no timestamp
(`knowledge/growth.js:754`, list built by `getRawForConsolidation`,
`knowledge/evidence.js:843`).

**Generate Profile is time-blind.** `generateProfile` formats
`getEvidenceForProfile`'s output (`knowledge/growth.js:351`,
`knowledge/evidence.js:1120`):
- consolidated claims come first, in the order their passes ran,
- then raw observations, in capture order,
- and there is no `ts`, `firstSeen` or `lastSeen`.

The only ordering hint is `(msg N)`:
- That index is the live chat position, and it is null for backfilled
  observations, which are exactly the oldest scenes.
- For a consolidated claim it is the first *cited* source's index, and the
  model chooses the citation order.

**Capture order is not story order.** If continuous capture ran first and
Catch Up or Backfill recovered old history afterwards, the oldest scenes sit at
the **end** of both lists, where a model reads them as the most recent.

**The profile prompt asks for the blend.** `GROWTH_PROFILE_PROMPT` says to
report contradictory evidence honestly because "real people are
contradictory", and to close on a tension or contradiction
(`knowledge/prompts.js:386`, `:392`). Without timing, "used to wait for
permission" and "now takes initiative" read as a contradiction, so the model
writes one conflicted personality. That is the requester's symptom exactly.

**The consolidation prompt pushes merges across phases.** "Aim to reduce the
total count by 40-60%" (`knowledge/prompts.js:488`) rewards claims such as
"alternates between deference and initiative", which fold a change into one
trait. The requester ran a full consolidation over the whole RP, so their
batches almost certainly spanned phases.

**What is already right:** each raw observation's `ts` is the cited message's
`send_date`, not the capture time (`capturedAt` holds that). Backfilled
observations carry the original message's `send_date` through `ils_compat`.
So "use the order of the original messages even when older scenes were
captured later" is mostly a matter of sorting by `ts`. The limits are fallback
timestamps (§4.1) and equal timestamps (§4.6).

---

## 3. The four asks

### Ask 1 — carry message order through Consolidate and Generate

**Ordering half: do it.** Sort by `ts` and label each item with its story
position (§5.1). This applies to both prompts.

**"Consider earlier claims while consolidating": defer it.**
- **Cost.** Every pass would resend part of the consolidated tier. The model
  also has to be kept from re-emitting old claims as new ones, the same
  doubling problem Knowledge Enrich had with the restated ledger.
- **Possibly unnecessary for this symptom.** Generate already sees every claim
  from every pass at once. With chronology in its view, it can recognize
  "changed", "persisted" and "became situational" itself.
- **Still a possible improvement later.** Look-back may make consolidation
  itself better. It is a separate job, though, and it should not block this
  fix.
- Showing earlier claims read-only doesn't need any new output fields. Revision
  1 suggested `continues`/`replaces` links. Those are only worth adding if
  re-emitted claims turn out to be a real problem, and that can be decided when
  look-back is picked up.

### Ask 2 — keep changes inside a consolidated claim

**Do it, at read time.** Today a claim travels with one quote, from whichever
source the model happened to cite first (`knowledge/evidence.js:1133`). For
each consolidated claim, send:
- its first and last position, its phase spread, and its count of distinct
  source messages (§5.1),
- its earliest and latest quotes,
- **for any claim with two or more distinct source messages**, a bounded,
  ordered sample of its source *claims* (not their quotes), each with its
  position.

That last item reveals "waits for permission" and then "takes initiative"
hiding inside a claim like "has a complicated relationship with authority".

Phases are labels only. They are not the limit of the chronology: a change can
happen entirely within the last third, so samples do not depend on crossing a
phase boundary. Samples are capped per claim and overall (§5.2).

The consolidation prompt should also stop producing these claims in the first
place (§5.5).

### Ask 3 — weight sustained later behavior

**Mostly a prompt change** (§5.4). It only works once asks 1 and 2 supply the
chronology.

**Support means distinct source messages, not observations.** Several
observations captured from one message are one moment of evidence, not
repeated support (§4.6). That count is what separates "sustained" from "one
recent outburst", which the requester rightly worries about.

The profile must also stay a mirror: if nothing changed, it says so plainly
and does not invent an arc.

### Ask 4 — regenerate from already-consolidated evidence

**Already how Generate works.** The 📝 Generate Profile button calls
`regenerateProfile`, which never recaptures (`knowledge/growth.js:818`,
`knowledge/render.js:1904`). With asks 1–3 done at read time, the requester's
existing consolidated evidence produces better profiles with no extra steps,
no recapture and no manual Expand.

---

## 4. Landmines

### 4.1 Fallback timestamps sort as the newest behavior

- `extractMsgTs` falls back to `Date.now()` (the capture time) when an
  observation has no message index, an out-of-range one, or a `send_date` that
  can't be parsed (`knowledge/evidence.js:1312`).
- Unverified backfill observations keep the index the model cited
  (`knowledge/growth.js:1382`). For a restored message, the backfill prompt
  shows the *summary* message's live index, so `appendRawObservations` stamps
  the summary's `send_date` instead of the original's.
- ILS originals with unreadable dates get `ts` 0 (`normalizeSendDate`,
  `knowledge/ils_compat.js:208`).

Under recency weighting, the first two become the character's "current self".

**Rule: position unknown.** Such items are listed after the dated items and
left out of positions, spans and support counts. Check in this order:
1. **Saved provenance wins.** New captures record where the timestamp came
   from, for example `tsSource: 'message' | 'capture'`. When the field is
   present, it decides.
2. **`verified: false`** always means position unknown. The heuristic below
   can't catch the summary-date case.
3. **`ts` 0, or a non-finite `ts`,** means position unknown.
4. **Legacy heuristic.** With no saved provenance, treat the timestamp as a
   fallback when `ts` and `capturedAt` are both finite and
   `0 <= capturedAt - ts < 50`. Both values come from `Date.now()` within one
   call, while a real message is normally at least one API call older. This is
   a useful heuristic, not a guarantee. A negative difference means the
   message is dated after its capture (a clock or import oddity) and is *not*
   a fallback.

The evidence validator keeps unknown record fields (`checkObservation`,
`knowledge/schema.js:335`), so `tsSource` needs no schema change. Pin that
with a test anyway.

A stored `firstSeen`/`lastSeen` can include a fallback source, so **compute
spans at read time from the sources**, never from the stored fields.

### 4.2 `archivedRaw` is not "all valid evidence"

`deleteConsolidated` removes the claim and leaves its sources in
`archivedRaw` (`knowledge/evidence.js:998`). So the archive also holds
observations the user deliberately threw out. Reading `archivedRaw` directly,
which the request's wording invites, would bring them back.

**Rule:** reach archived observations **only through the `sources` of claims
that still exist**. Do not build a mutating "rebuild consolidation" action: it
would bring back deleted evidence and throw away hand-edited claim text
(`updateConsolidated`).

Expand on one claim moves a raw that a second claim also cites back into
`raw[]`, so the same raw can appear twice. De-duplicate by raw id before
counting anything.

### 4.3 The Personality/Voice draft needs the same ordered view

`GROWTH_DOSSIER_PROMPT` says "an old habit is a condition only if evidence
shows it recurring after the change" (`knowledge/prompts.js:365`). But
`growthDossierEvidence` sends consolidated claims with `firstSeen` only and no
`lastSeen` (`knowledge/growth_dossier.js:36`), so a trait that began early and
is still going looks old.

Adding `lastSeen` and phase counts isn't enough. A blended claim like
"complicated relationship with authority, early ×6, late ×6" still doesn't say
which behavior came later. The draft needs the same **ordered source-claim
samples** as Generate (§5.2), still with no quotes. This bug is already in the
shipped feature, and it is the path the requester uses.

Three constraints on that change:
- **Samples carry no citable ids.** Draft validation resolves cited ids
  against non-archived evidence only (`knowledge/growth_dossier.js:192`,
  `:200`). Samples come from archived sources, so if the model cites one, the
  draft fails with "must cite existing evidence". Nest the samples under their
  parent claim and have the model cite the parent's id.
- **Keep the times the echo check reads.** `growthEchoStatus` reads
  `firstSeen` (consolidated) and `ts` (raw) from the same projection
  (`knowledge/growth_lineage.js:75`). Revision 1 suggested replacing epoch
  values with labels, which would have broken echo. Split the projection
  instead: the model gets positions and phases (no real dates, §4.5), and the
  validator and echo keep the times.
- **The whitelist test changes on purpose.** `test/growth_dossier.test.js:189`
  pins the projection's exact shape with `toEqual` and the rule "no
  receipts/archive". Update it deliberately: archived source *claim text* may
  now travel inside samples, but quotes and receipts still never do.

### 4.4 `getEvidenceForProfile` also feeds the evidence list UI

The Growth window renders its evidence list from the same function
(`knowledge/render.js:1337`, `:1417`). A test pins its output
(`test/knowledge_module3_review.test.js:84`), and so does the "Generated from
N observations" count. **Build the timed prompt view in a separate function**
(for example `buildProfileEvidenceView(file)`). Leave `getEvidenceForProfile`'s
order and shape alone unless the UI is meant to change too.

Psychoanalyze formats the same evidence. Give it the new view as well, and fix
its prompt, which calls the evidence "recent behavioral observations"
(`knowledge/prompts.js:413`). That has not been true since backfill existed.

### 4.5 Clock time is the wrong scale

`send_date` is real-world time. A two-month break in the RP would squash
everything before it into "early". **Position by rank**, meaning the item's
place among the NPC's distinct timestamps, not by elapsed time. Never show
real dates or epoch values to the model either: it may confuse them with
in-story time from Chronicle or the calendar.

### 4.6 Equal timestamps and per-message support

Sorting by `ts` can't order messages that share a timestamp. Ranking single
observations would also count several observations from one message as
repeated support, and could even split one message across a phase boundary.

**Source-message key.** MWT already gives messages stable identities for the
capture cursor (`getOrCreateReceiptIdentity`, `core/message_identity.js`). New
captures should save the cited message's key on each observation, for example
as `msgKey`. Observations without one (legacy, or with no identity) use
`ts:<ts>` as their key. That treats every message sharing a timestamp as one
moment, which undercounts slightly and never overcounts.

**ILS landmine.** `getOrCreateReceiptIdentity` *creates* a UUID when a message
has none: it writes `extra.mwt_uuid` and saves the chat. Called on a message
restored from an ILS summary, it would modify `ILS_Originals`, which MWT
treats as strictly read-only. Restored messages must use a **read-only**
identity: an existing `id`, `mesid` or `mwt_uuid`, or nothing (so the `ts`
key applies). `knowledge/growth.js:907` already computes that read-only form
inline; extract it rather than calling the create path.

**Tie policy:**
- Messages sharing a timestamp share one position. Nothing in the view claims
  one came before the other.
- Positions rank distinct timestamps, so one message can never fall on both
  sides of a phase boundary.
- Display order inside a tie (live `msgIdx` when both have one, then id) is
  cosmetic only.

**When order is unknown.** If timestamps don't separate the evidence, the view
must say so, not imply an order. Examples: an imported chat where every
message has the same date, or a host with coarse dates (the Aikobots fork
stores minute precision). Starting rule: if there are fewer than 3 distinct
timestamps, or one timestamp holds more than a quarter of the dated
observations, omit positions and phases and label the evidence "order
unknown".

---

## 5. Suggested design (one phase, read-time only)

### 5.1 The timed evidence view

1. **Collect the dated observations.** Take every raw observation, plus every
   archived observation that a surviving consolidated claim cites (§4.2).
   De-duplicate by id, and set aside position-unknown items (§4.1).
2. **Positions.** Rank the NPC's distinct timestamps from 0 to 100. Ties share
   a position (§4.6). Phase words are labels on top: *early* below 34,
   *middle* from 34 to 66, *late* above 66. Each item shows both, for example
   "late 84". Apply the order-unknown rule first.
3. **Support.** Count distinct source-message keys (§4.6), never
   observations.
4. **For each consolidated claim**, from its dated sources:
   - first and last position,
   - phase spread by distinct messages, for example
     `early ×6, middle ×1, late ×0`,
   - total distinct source messages,
   - earliest and latest quotes,
   - its source-claim samples (§5.2).
5. **For each raw observation:** its position and phase.
6. **Order the list** chronologically by first position, so the model reads
   the story forward. Position-unknown items go last, marked as such.

Example of one claim in the prompt:

```
7. [trait] [consolidated] Defers to others before acting on household matters.
   Seen: early 4 → middle 58 · 7 source messages: early ×6, middle ×1, late ×0
   Earliest: "Should I—may I start the laundry?"  Latest: "I'll wait until you say."
   In order:
     early 4   asks permission before starting chores
     early 9   waits to be told before serving dinner
     early 21  apologizes for moving furniture unasked
     … 1 more …
     early 30  checks before answering the door
     middle 58 hesitates at the threshold until invited in
```

### 5.2 Source-claim samples

- **Who gets them:** any consolidated claim with two or more distinct source
  messages. Crossing a phase boundary is *not* required.
- **One sample per source message.** If several observations share a message,
  use the one with the lowest id.
- **Per-claim cap:** the earliest *k* and latest *k* source messages, with
  *k* = 3 to start. A claim with no more than 2*k* source messages shows all of
  them. Elided messages show as a count ("… N more …").
- **Overall budget:** a fixed character budget for all samples. Starting
  value: about 8,000 characters for each of the profile prompt and the dossier
  draft. Small local models struggle with large prompts, so tune it on one.
- **Deterministic shrink rule:** when the samples exceed the budget, lower *k*
  for every claim (3, then 2, then 1). If it's still over at *k* = 1, drop
  samples from the claims with the fewest distinct source messages first,
  breaking ties by claim id. The earliest and latest quotes and the span always
  stay. The same evidence must always produce the same prompt.
- **The dossier draft** uses the same samples, minus quotes and ids (§4.3).

### 5.3 New-capture provenance (optional, small)

Live and backfill captures add two fields per observation:
- `tsSource`, where the timestamp came from (§4.1);
- `msgKey`, the cited message's identity, read-only for ILS restored messages
  (§4.6).

Both are optional, and older data falls back to the rules above. Mixed data
can count one message twice (a legacy `ts` key plus a new `msgKey`). That
affects only support counts around the upgrade, so it is accepted.

### 5.4 Profile prompt

Replace the contradiction and tension guidance with rules along these lines:
- The evidence is in story order with positions and phases. Describe the
  character **as they are in the latest part of the story**.
- A behavior seen earlier and replaced later is **change, not
  contradiction**. That holds inside a single phase too. Mention the earlier
  behavior only if it explains the present, for example "still asks first
  when a guest is present", and only if late evidence shows it recurring in
  that situation.
- A real tension needs **both sides present in late evidence**.
- A behavior backed by only one recent source message is a **reaction, not a
  new default**, unless it fits the broader pattern.
- Traits seen across the whole story are core. Keep them.
- If nothing changed, say so. Do not invent an arc.
- If the evidence is marked "order unknown", don't infer change from list
  order.

Keep the anti-typology and evidence-only rules unchanged.

### 5.5 Consolidation prompt

- Send each raw observation's position and phase, in story order.
- Tell it **not to merge observations that show a behavior changing**: write
  the earlier and later behavior as separate claims instead.
- Make the 40–60% reduction target explicitly yield to that rule.

### 5.6 Dossier draft evidence

Per §4.3: a split projection. The model gets positions, phases, distinct-message
spreads and id-less source-claim samples. The validator and echo keep `ts` and
`firstSeen`.

### 5.7 Not in this phase

- Consolidation looking back at earlier claims (§3, ask 1), until the
  requester confirms whether profiles still blend after this ships.
- Any write-back to existing evidence, including a "rebuild consolidation"
  action.
- Migrating old fallback timestamps. Detect them at read time instead (§4.1).

---

## 6. Checks

Automated (fixtures):
- **Reversed capture order:** early "waits for permission" scenes appended
  *after* late "takes initiative" scenes, as Catch Up after continuous capture
  would. The prompt lists the early scenes first and labels them *early*.
- **Change within one phase:** a claim whose sources move from deference to
  initiative entirely within the last third gets its ordered samples.
- **Several observations from one message:** count as one source message, and
  share one position.
- **Equal timestamps:** distinct messages sharing a `ts` share a position. The
  view never states an order between them, and one message never straddles a
  phase boundary.
- **All-identical timestamps:** the view says "order unknown" and shows no
  phases.
- **Fallback detection:** saved `tsSource` wins over the heuristic. `verified:
  false`, `ts` 0 and a 0–49 ms fallback are position unknown. A negative
  difference and a non-finite value are not treated as fallbacks by the
  heuristic.
- **Deleted-claim sources:** an archived observation whose claim was deleted
  never reaches the prompt.
- **ILS read-only:** a backfill capture from a restored message leaves
  `ILS_Originals` unchanged (no `mwt_uuid` written).
- **Budget:** over budget, the shrink rule produces the same prompt every
  time, and the earliest and latest quotes always survive.
- **Dossier draft:** samples have no ids. A draft citing the parent claim
  passes validation with samples present. Echo results are unchanged. The
  updated whitelist test still forbids quotes and receipts.
- **Unchanged outputs:** `getEvidenceForProfile` output and the evidence list
  UI are unchanged (§4.4).
- **Hiatus:** a two-month gap in `ts` doesn't shift positions.
- **New fields kept:** an observation with `tsSource` and `msgKey` survives an
  evidence save.

Host check, on a real model: run a character whose arc matches the
requester's example. Fully consolidate, Generate, and confirm the profile
describes the later behavior with any old habit written as a condition. Then
run the Personality/Voice draft from that profile and confirm it does the
same. Repeat once on a small local model to tune the sample budget.

---

## 7. Open questions

1. Should the Growth window's evidence list also show positions, or sort by
   story order? Not needed for the fix; it would help users audit it.
2. Should the reply ask the requester to report back after this ships, before
   anyone commits to the consolidation look-back?
3. Starting values to confirm on a real model: *k* = 3, the 8,000-character
   sample budget, and the order-unknown thresholds (fewer than 3 distinct
   timestamps, or one holding over a quarter of the evidence).

---

## 8. Revision record

**Revision 1 (2026-11-14):** our review of the request.

**Revision 2 (2026-11-14):** folds in the co-author's review. All four of its
points were checked against the code and accepted.

| Co-author point | Decision | Where |
| --- | --- | --- |
| Thirds should be labels, not the limit of chronology. Keep finer positions, and sample source claims regardless of phase boundaries. | Accepted. Positions 0–100 plus phase words. Samples go to any claim with 2+ distinct source messages. **Added:** a per-claim cap, an overall budget and a deterministic shrink rule. | §3 ask 2, §5.1, §5.2 |
| The Personality/Voice draft needs to see what changed, so give it the same bounded, ordered source claims, without quotes. | Accepted. **Added:** samples carry no citable ids (draft validation can't resolve archived ids), a split projection so echo keeps its times, and a deliberate update to the whitelist test. | §4.3, §5.6 |
| Observation counts don't establish sustained behavior. Count distinct source messages, and set an equal-timestamp policy. | Accepted. **Added:** `msgKey` from the existing message identity helper, a read-only identity for ILS restored messages, the tie policy and the order-unknown rule. | §3 ask 3, §4.6, §5.3 |
| Qualify the fallback heuristic: finite values, non-negative difference, saved provenance first. | Accepted. Revision 1 called the heuristic "safe", which overstated it. | §4.1 |
| Soften "mostly redundant" for the look-back; `continues`/`replaces` links aren't needed for read-only context. | Accepted. Look-back may still improve consolidation itself, but it shouldn't block this fix. | §3 ask 1 |
| Add fixtures for a change within one third, several observations from one message, and equal timestamps. | Accepted, plus fixtures for the additions above. | §6 |

Also corrected in revision 2: revision 1 suggested replacing epoch times with
labels in the dossier projection. That would have broken the echo check, which
reads those times (§4.3).
