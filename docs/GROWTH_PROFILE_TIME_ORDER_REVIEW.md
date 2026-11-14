# Growth profiles that describe the character now — request review

**Status:** Review for the co-author, 2026-11-14. Nothing built, and no reply
sent to the requester yet.
**Request received:** 2026-11-14 on GitHub (recorded verbatim in §1).
**Related:** [GROWTH_PROFILE_INJECTION_SCOPE.md](./GROWTH_PROFILE_INJECTION_SCOPE.md).
The requester uses profiles to update Personality and Voice through that
feature, so its draft step is part of this problem (§4.3).

## Summary

The request is sound and the diagnosis is right. Both model calls behind it
(Consolidate and Generate Profile) receive **no timing information at all**,
and the profile prompt actively tells the model to merge early and late
behavior into one "tension".

Most of the fix happens at read time and is cheap: sort the evidence by
message time, give each item its position in the story, and rewrite two
prompts. Nothing is written back to the evidence store, so there is no
migration, and the profile is still only ever read from evidence (the leaf
rule holds).

One part of the request, having Consolidate look back at claims from earlier
batches, is costly and mostly redundant once Generate can see timing. We
recommend deferring it (§3, ask 1).

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
`getEvidenceForProfile`'s output. That output lists consolidated claims in the
order their passes ran, then raw observations in capture order
(`knowledge/growth.js:351`, `knowledge/evidence.js:1120`). It sends no `ts`,
`firstSeen` or `lastSeen`. The only ordering hint is `(msg N)`:
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
captured later" needs only sorting by `ts`. Nothing has to be recaptured,
apart from the gaps in §4.1.

---

## 3. The four asks

### Ask 1 — carry message order through Consolidate and Generate

**Ordering half: do it.** Sort by `ts` and label each item with its story
position (see §5 for the label format). This applies to both prompts.

**"Consider earlier claims while consolidating": defer it.**
- **Cost.** Every pass would resend part of the consolidated tier, and the
  model has to be stopped from re-emitting old claims as new ones. That is the
  same doubling problem Knowledge Enrich had with the restated ledger.
- **Mostly redundant.** Generate already sees every claim from every pass at
  once. Once claims carry their spans, Generate can recognize "changed",
  "persisted" and "became situational" itself.
- **If it is ever built:** show earlier claims read-only, with their ids. Let
  the output *link* to one (for example `"continues": "con-012"` or
  `"replaces": "con-012"`), never rewrite it. The code must never re-cite the
  linked claim's sources.

### Ask 2 — keep changes inside a consolidated claim

**Do it, at read time.** Today a claim travels with one quote, from whichever
source the model happened to cite first (`knowledge/evidence.js:1133`). For
each consolidated claim, send:
- its span and the spread of its sources across the story (§5),
- its earliest and latest quotes, by `ts`,
- **only for claims whose sources span more than one phase**, the short
  source *claims* (not their quotes), each with its position.

That last item is what reveals "waits for permission" (early) and "takes
initiative" (late) hiding inside one claim like "has a complicated
relationship with authority". Cap it, for example at the first 3 and last 3
sources, so a 40-source claim cannot flood the prompt.

The consolidation prompt should also stop producing these claims in the first
place (§5.3).

### Ask 3 — weight sustained later behavior

**Mostly a prompt change** (§5.2), and it only works once asks 1 and 2 supply
the timing. Source counts per phase are what separate "sustained" from "one
recent outburst", which the requester rightly worries about.

It also has to keep the profile a mirror: if nothing changed, the profile says
so plainly and does not invent an arc.

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
  observation has no message index or an out-of-range one
  (`knowledge/evidence.js:1312`).
- Unverified backfill observations keep the index the model cited
  (`knowledge/growth.js:1382`). For a restored message, the backfill prompt
  shows the *summary* message's live index, so `appendRawObservations` stamps
  the summary's `send_date` instead of the original's. An out-of-range index
  gets the capture time.
- ILS originals with unreadable dates get `ts` 0 (`normalizeSendDate`,
  `knowledge/ils_compat.js:208`).

Under recency weighting, the first two become the character's "current self".

**Rule:** treat these as **position unknown**. List them after the dated items,
and leave them out of span and phase counts.
- **Legacy data:** a fallback `ts` is within a few milliseconds of
  `capturedAt`, because both are taken in the same function call. A real
  message is always at least one API call older. `capturedAt - ts < 50` is a
  safe test.
- **Unverified observations** (`verified: false`): position unknown, always.
- **`ts` 0:** position unknown.
- **New captures:** record where the timestamp came from (for example
  `tsSource: 'message' | 'capture'`) so later code doesn't have to guess. The
  evidence validator keeps unknown record fields (`checkObservation`,
  `knowledge/schema.js:335`), so no schema change is needed. Pin that with a
  test anyway.

Because a stored `firstSeen`/`lastSeen` can include a fallback source,
**compute spans at read time from the sources**, never from the stored fields.

### 4.2 `archivedRaw` is not "all valid evidence"

`deleteConsolidated` removes the claim and leaves its sources in
`archivedRaw` (`knowledge/evidence.js:998`). So the archive also holds
observations the user deliberately threw out. Reading `archivedRaw` directly,
which the request's wording invites, would bring them back.

**Rule:** reach archived observations **only through the `sources` of claims
that still exist**. Do not build a mutating "rebuild consolidation" action: it
would bring back deleted evidence and throw away hand-edited claim text
(`updateConsolidated`).

Related: Expand on one claim moves a raw that a second claim also cites back
into `raw[]`. The same raw can then appear twice (once as a raw observation,
once as a source), so de-duplicate by raw id when counting phases.

### 4.3 The Personality/Voice draft can't apply its own "old habit" rule

`GROWTH_DOSSIER_PROMPT` says "an old habit is a condition only if evidence
shows it recurring after the change" (`knowledge/prompts.js:365`). But
`growthDossierEvidence` sends consolidated claims with `firstSeen` only and no
`lastSeen` (`knowledge/growth_dossier.js:36`). A trait that began early and is
still going therefore looks old.

This bug is already in the shipped feature, and it is the path the requester
uses, so it belongs in this work:
- Add `lastSeen` and the phase spread from §5.
- Prefer a story-position label over raw epoch milliseconds for raw items.

The echo check reads `firstSeen` for consolidated claims
(`knowledge/growth_lineage.js:75`), so adding fields does not change echo
behavior. Keep the whitelist strict: still no quotes or receipts.

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
place among the NPC's dated observations, not by elapsed time. Never show
real dates to the model either: it may confuse them with in-story time from
Chronicle or the calendar.

---

## 5. Suggested design (one phase, read-time only)

### 5.1 The timed evidence view

1. **Collect the dated observations.** Take every raw observation, plus every
   archived observation that a surviving consolidated claim cites (§4.2).
   De-duplicate by id, and drop position-unknown items (§4.1) from this set.
2. **Rank them by `ts`** and split them into thirds: *early*, *middle* and
   *late*, per NPC. Words are more reliable for a model than percentages.
3. **For each consolidated claim**, from its dated sources, show:
   - its span: first and last phase,
   - its phase spread, for example `early ×6, middle ×1, late ×0`,
   - its total source count,
   - its earliest and latest quotes,
   - and, if it spans more than one phase, its capped source claims with
     their phases (§3, ask 2).
4. **For each raw observation**, show its phase.
5. **Order the list** chronologically by first appearance, so the model reads
   the story forward. Position-unknown items go last, marked as such.

Example of one line in the prompt:

```
7. [trait] [consolidated] Defers to others before acting on household matters.
   Seen: early → middle · early ×6, middle ×1, late ×0 · 7 sources
   Earliest: "Should I—may I start the laundry?"  Latest: "I'll wait until you say."
```

### 5.2 Profile prompt

Replace the contradiction and tension guidance with rules along these lines:
- The evidence is in story order with phases. Describe the character **as they
  are in the late phase**.
- A behavior seen early and replaced later is **change, not contradiction**.
  Mention the earlier behavior only if it explains the present, for example
  "still asks first when a guest is present", and only if late evidence shows
  it recurring in that situation.
- A real tension needs **both sides present in late evidence**.
- A behavior with only one late source is a **reaction, not a new default**,
  unless it fits the broader pattern.
- Traits seen in every phase are core. Keep them.
- If nothing changed across phases, say so. Do not invent an arc.

Keep the anti-typology and evidence-only rules unchanged.

### 5.3 Consolidation prompt

- Send the phase for each raw observation, in story order.
- Tell it **not to merge observations that show a behavior changing**: write
  the earlier and later behavior as separate claims instead.
- Make the 40–60% reduction target explicitly yield to that rule.

### 5.4 Dossier draft evidence

Per §4.3: add `lastSeen` and the phase spread, and use phase labels instead of
epoch milliseconds.

### 5.5 Not in this phase

- Consolidation looking back at earlier claims (§3, ask 1), until the
  requester confirms the read-time fix leaves blending behind.
- Any write-back to the evidence store, including a "rebuild consolidation"
  action.
- Migrating old fallback timestamps. Detect them at read time instead (§4.1).

---

## 6. Checks

Automated:
- **Fixture with reversed capture order:** early "waits for permission" scenes
  appended *after* late "takes initiative" scenes, as Catch Up after
  continuous capture would. Assert that the prompt lists the early scenes
  first and labels them *early*.
- **Fallback timestamps:** an observation with `capturedAt - ts < 50`, one
  with `verified: false`, and one with `ts` 0 all show as position unknown and
  are left out of spans.
- **Deleted-claim sources:** an archived observation whose claim was deleted
  never reaches the prompt.
- **Cross-phase claim:** a consolidated claim with early and late sources gets
  its earliest and latest quotes and its capped source claims. A
  single-phase claim gets neither of the extra blocks.
- **Unchanged outputs:** `getEvidenceForProfile` output and the evidence list
  UI are unchanged (§4.4).
- **Dossier evidence:** `growthDossierEvidence` carries `lastSeen`, still
  carries no quotes, and echo results are unchanged.
- **Hiatus:** a two-month gap in `ts` doesn't shift the phase boundaries.

Host check, on a real model: run a character whose arc matches the
requester's example. Fully consolidate, Generate, and confirm the profile
describes the late behavior with any old habit written as a condition. Then
run the Personality/Voice draft from that profile and confirm it does the
same.

---

## 7. Open questions

1. Should the Growth window's evidence list also show phases, or sort by story
   order? Not needed for the fix; it would help users audit it.
2. Should the reply ask the requester to report back after this ships, before
   anyone commits to the consolidation look-back?
3. Are thirds enough, or should long RPs get more phases? Start with thirds
   and revisit only if real profiles show they're too coarse.
