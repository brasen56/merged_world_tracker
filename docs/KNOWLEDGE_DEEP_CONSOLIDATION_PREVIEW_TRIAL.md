# Knowledge Tracker — deep consolidation preview trial

**Status:** Build checklist for the first experiment; implements the review
response's point 2 (answer the core question before building the archive).
**Date:** 2026-11-03
**Companion doc:** [KNOWLEDGE_DEEP_CONSOLIDATION_SCOPE.md](./KNOWLEDGE_DEEP_CONSOLIDATION_SCOPE.md) — scope §3 and the appended response.
**Release boundary:** Private experimental branch; the shipped 🧹 Condense path stays byte-identical.

## 1. What the trial is

One new manual action per NPC — **Experimental: Deep Consolidate (preview)** —
next to 🧹 Condense in the NPC list (knowledge/render.js:669 pattern). It reads
one NPC's ledger, requests a subject-grouped consolidation proposal, checks it
deterministically, and shows an editable preview with measurements. It writes
nothing: no archive entry, no live-entry change, no staging, no recovery record.
Its only outputs are the on-screen preview and two downloads (the consolidated
entry text, and the trial packet).

The question it answers, from the response's point 2: can the model bring a
~15k-token ledger down to 3–5k active tokens without visible continuity loss?
If it cannot, the archive, restore, and re-promotion work in scope §5 is not
needed. If it can, the archive design (response point 5) starts from the
trial's outputs.

## 2. Not in this trial (build none of it)

- Archive persistence, restore, re-promotion, conflict-aware undo (§5 later).
- The model audit call — optional per the response's open-question 4 answer;
  the deterministic detail check is the mandatory guard.
- Retrieval, embeddings, date-triggered or background anything (§6).
- Any change to the public Condense pipeline: `CLEANUP_WIRE_VERSION` 2,
  `expandKeepListProposal`, `validateLedgerProposal`, and `LEDGER_CLEANUP_PROMPT`
  stay untouched, with tests pinning that an `archive` field is *refused* on
  the public path.

## 3. Build checklist

### A. Capture, boundary, pins

- [x] Reuse `captureCleanupTarget` + `parseLedger` + `captureLedgerReview`
      (knowledge/cleanup_commit.js, knowledge/ledger_cleanup.js); fresh review
      id for every request, regenerations included.
- [x] Boundary selection: the request payload contains ONLY the sources at or
      above the chosen line. Later lines are excluded entirely — they stay
      verbatim, unseen by the model, and count toward the budget.
- [x] Pin selection happens BEFORE the request; pinned lines are stated as
      pins in the prompt and pre-assigned to keep, so the model never merges them.

### B. Wire format and validation (fork, do not weaken)

- [x] A parallel deep-consolidation wire (version 3 or a separate module):
      `{ keep:[n], changed:[{s,t,n}], archive:[n], groups:[{s,label}] }` —
      every source exactly once across keep ∪ changed ∪ archive, preserving
      the coverage rule; groups per response point 1 (source numbers plus a
      label, "no group" a normal outcome).
- [x] Experimental validator: a sibling of `validateLedgerProposal` with a
      third ownership state (archived). The shipped validator is unchanged.
- [x] Decide and document the invariant wording: "Model JSON can never approve
      removals" (ledger_cleanup.js header) becomes, on the experimental path
      only, "model JSON can propose archiving; archive is a recoverable
      disposition, never a deletion."
- [x] Consolidated records obey the existing single-line, ≤800-character
      bound (`LEDGER_ITEM_LIMITS.fact`, field_contract.js:107); a subject group
      that needs more becomes multiple records.

#### A–B implementation contract (2026-11-05)

- `knowledge/deep_consolidation_capture.js` provides read-only
  `prepareDeepConsolidation({name, uid, throughSource, pins})`. Call it anew
  for each request/regeneration. Identity capture failures propagate; parser
  refusals/empty ledgers return eligibility without a review. This foundation
  does not yet dispatch a request or expose a UI (C–E remain pending).
- `knowledge/deep_consolidation.js` owns the pure capture, minimized user
  payload, wire expansion, and sibling proposal validator. `throughSource`
  and `pins` use **1-based ledger source numbers**, not physical file lines.
  The boundary is inclusive; omission selects the entire ledger. Pins must
  be unique eligible sources. Captures retain the complete exact entry and
  frozen source tables, including recent sources and their offsets/EOLs.
  The user payload contains only eligible lines, NPC name, review ID and pin
  instructions. Later lines never enter it; `recentSources` is reserved for
  verbatim preservation and active-budget counting in D–E.
- The strict wire is `{version:3, reviewId, keep:[n], changed:[{s:[n],t,n?}],
  archive:[n], groups:[{s:[n],label}], notes?}`. Parse JSON with the existing
  `parseLedgerProposal` before expanding. Pins are pre-assigned to keep and
  must be echoed there exactly once; omission is a coverage failure, not an
  inferred keep. Unknown fields, stale IDs, duplicate ownership and sources
  beyond the boundary fail closed.
- Groups are nonempty, disjoint subject annotations, not ownership. Empty
  `groups:[]` is valid when sources stay exact. Ungrouped sources must remain
  exact; a changed record cannot cross groups. A subject group may contain
  several records, but every source still has exactly one owner (no splitting
  one source among multiple records). New/merged records are single-line,
  structurally safe and at most 800 characters. Exact legacy originals retain
  the existing overlength exception rather than forcing a lossy rewrite.
- Experimental invariant: **model JSON can propose archiving; archive is a
  recoverable disposition, never a deletion.** In this read-only trial it is
  in-memory bookkeeping backed by the full captured original, not a persisted
  archive or a recovery guarantee across reloads. No write/apply API exists.
  The shipped version-2 wire, validator, and prompt remain unchanged; tests
  explicitly pin refusal of an `archive` field on both public validation seams.
- Regression coverage: `test/knowledge_deep_consolidation.test.js`.

### C. Request and prompt

- [ ] Reuse the disclosure + budget pattern (`cleanupModelDisclosure`,
      `estimateCleanupRequest`, `checkCleanupBudget` in cleanup_review.js):
      whole-ledger request, clear refusal on known excess, honest
      unknown-capacity disclosure, Knowledge model config reused.
- [ ] New sibling prompt (do not edit `LEDGER_CLEANUP_PROMPT`): subject
      grouping with corrections kept with the lines they correct; belief vs
      fact; no psychological conclusions; per-fact provenance and dates kept
      inline; budget stated as a goal, never truncation permission; pins
      honored; archive list justified per line or group.
- [ ] Decide the consolidated-line grammar. Multi-fact lines do not fit
      `- fact via source — date` (lorebook.js:771); propose inline
      parenthetical provenance/date per clause. This choice affects scan
      regrowth recognition (see F) and must be recorded in the trial packet.

### D. Deterministic checks (mandatory guard — response point 4)

- [ ] Extended detail check: archived AND summarized sources compared against
      the WHOLE active result (all kept + changed text together), not
      per-record; numbers and codes listed before capitalized names
      (sentence-start false positives are numerous at this scale).
- [ ] Exact-by-default reporting (response open-question 2): lines with
      numbers, codes, or quoted text; rumor/belief lines; the latest version
      of corrected facts — surfaced in the preview with a one-click
      "keep exact instead."
- [ ] Budget panel shows: before/after active token estimates
      (`estimateTokens`), the deterministic floor (active tokens if every
      exact-by-default line were kept), pinned and ungrouped share, and
      warning counts. Floor > budget is a recorded outcome, not an error.

### E. Preview UI

- [ ] Reuse the review-modal skeleton (core/modal.js; cleanup_review_ui.js
      pattern), separate from staging and auto-approval.
- [ ] Groups visible and editable before accepting records: relabel, move a
      source between groups, ungroup (line stays exactly as written).
- [ ] Editable records; archive-only details listed; warnings from D
      attached to the lines they concern.
- [ ] Export buttons: (1) the consolidated entry text for pasting into the
      copy book; (2) the trial packet JSON — groups, dispositions, links from
      each summary record to its source numbers, warnings, measurements,
      prompt/model facts.
- [ ] No Apply button. No write path of any kind.

### F. Trial protocol (manual, on the testing RP)

- [ ] Baseline regrowth BEFORE consolidating (response point 7): run a few
      ordinary scans on recent chat and count lines the scan re-adds that
      already exist in the full ledger (the scan sees only recent lines —
      prompts.js:161). Classify each duplicate: already-viewable-but-restated
      vs hidden-by-abbreviation.
- [ ] Prep: duplicate the testing lorebook (host World Info → duplicate);
      duplicate the chat at the probe state; keep activation settings
      identical across both variants, and if vectorization is enabled,
      matched or off for both — asymmetric retrieval confounds the comparison.
- [ ] Choose 5–10 probe moments where OLD knowledge (lines that would be
      archived) should matter, covering scope §7's list — a secret, a
      corrected fact, a code/number, an unresolved promise, a
      relationship-changing event, a belief vs fact. Add at least 2 control
      moments where old knowledge should NOT matter, to catch the
      consolidated ledger over-triggering or inventing relevance.
- [ ] Run the preview on the real book (read-only); export the consolidated
      entry; paste it into the copy book's NPC entry.
- [ ] At each probe moment, generate both variants from the SAME chat state
      and message index — branch or swipe, never one after the other in the
      same branch (the first variant's reply would contaminate the second's
      context). Variant A: original book. Variant B: copy book.
- [ ] Blind the labels where practical (shuffle A/B before comparing).
- [ ] Record per moment: both replies, which checked details each preserved,
      lost, or distorted.
- [ ] After the comparison chat continues on the copy book for some turns,
      re-check regrowth and classify each duplicate as pre-existing baseline
      vs consolidation-caused (compare against the archived originals in the
      trial packet, not just the active text).
- [ ] One bounded re-run (response point 6): consolidate again on the copy
      after new acquisitions; input = new lines + existing summaries;
      originals consulted only for summaries actually changed. Record whether
      repeated-run quality differs from the first run.

### G. Verdict

- [ ] Record in §5 below: before/after tokens, floor, ungrouped share,
      probe-moment outcomes, control-moment outcomes, regrowth counts,
      review effort, and the go/no-go call.
- [ ] Go: proceed to archive design (response point 5 — sentinel entry,
      persist-and-verify, links outside ledger text).
- [ ] No-go: record why (floor unattainable, probe losses on
      secrets/corrections/codes, or review effort impractical) and stop; the
      archived work is not built.

## 4. Reuse map

| Need | Existing seam |
| --- | --- |
| Identity-bound capture | `captureCleanupTarget` (cleanup_commit.js) |
| Parse + source table | `parseLedger`, `captureLedgerReview` (ledger_cleanup.js) |
| Wire expand + coverage | `expandKeepListProposal` pattern (cleanup_review.js:94) |
| Budget/refusal/disclosure | `estimateCleanupRequest`, `checkCleanupBudget`, `cleanupModelDisclosure` (cleanup_review.js) |
| Prompt | sibling of `LEDGER_CLEANUP_PROMPT` (prompts.js) |
| Modal/review UI | `cleanup_review_ui.js` skeleton (core/modal.js) |
| Token estimates | `estimateTokens` (core/context.js) |
| Action wiring | per-NPC button pattern (render.js:669, dispatch :813) |

## 5. Trial results

(To be filled in when the trial runs.)
