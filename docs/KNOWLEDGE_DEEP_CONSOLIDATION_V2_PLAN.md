# Knowledge Tracker — deep consolidation v2 (batched, no archive)

**Status:** In progress; Phases 0–1 done 2026-11-22. Phase 1 is grouping-only; no batch execution or hand-off yet.
**Date:** 2026-11-22
**Replaces:** [KNOWLEDGE_DEEP_CONSOLIDATION_PREVIEW_TRIAL.md](./KNOWLEDGE_DEEP_CONSOLIDATION_PREVIEW_TRIAL.md) (the v1 build checklist; its §5 verdict was never reached).
**Background:** [KNOWLEDGE_DEEP_CONSOLIDATION_SCOPE.md](./KNOWLEDGE_DEEP_CONSOLIDATION_SCOPE.md) — the original problem statement and the appended response.
**Release boundary:** Private experimental branch. The shipped 🧹 Condense path stays byte-identical except for the one opt-in seam in Phase 3.

## 1. Why v1 is being replaced

As of 6b2e4aa, v1 has never produced a clean proposal on a large ledger. Runs
fail in one of two ways: the model overruns the response allowance (≈160k
tokens, mostly reasoning), or the validator rejects the answer, usually over
grouping. The causes:

1. **One call does four jobs.** It must group the whole ledger by subject,
   choose keep / changed / archive for every line, rewrite merged lines in the
   shared-tag grammar at a 500–650-character target, justify every archive,
   and list every source exactly once across four arrays. On a few hundred
   lines, reasoning models spend their budget re-checking that bookkeeping.
   `checkCleanupBudget` (knowledge/cleanup_review.js:274) cannot warn about
   this: it estimates the size of the JSON answer, not the reasoning.
2. **Group membership is written twice and must agree.** A source's group is
   in `groups[].s` and its owner is in `changed[].s` or `archive`. Any
   mismatch is a hard rejection (knowledge/deep_consolidation.js:180, :200,
   :201, :207). One slip among 300 sources discards the whole paid call.
3. **The archive adds rules with nothing behind it.** No archive store was
   built (trial §2). Yet the wire still makes the model justify each archived
   line and keep archived lines inside groups.

The trial's question — can a large ledger shrink without visible continuity
loss — is still open, because no large ledger got far enough to test it.

## 2. What v2 is

```
setup (boundary, pins, consent)
  → grouping call: subject groups only, normalized in code, never rejected
  → user reviews / adjusts groups
  → one Condense-format call per group (big groups split into batches)
  → each batch accepted or failed on its own; failed batches can be retried
  → accepted batches assembled into a Condense draft
  → existing Condense review modal: edit, keep originals, apply (recovery record)
```

Progress is a draft. Closing the modal, a failed batch, or a later scan does
not throw away accepted batches.

## 3. Decisions

| Decision | Why |
| --- | --- |
| **No archive.** Every source ends up in an active record or kept exactly. | The archive was the main source of extra rules. Without it, a deep run is just a rewrite of the entry, so the existing cleanup recovery record (the whole pre-apply entry, restorable) is the safety net. |
| **Per-batch calls use the Condense wire v2** (`keep` / `changed` / `pruningSuggestions` / `notes`). No new wire version. | `expandKeepListProposal` and `validateLedgerProposal` are hardened and tested. Because each call sees one group, the cross-group rule disappears. |
| **Records may be up to 1,200 characters** (`DEEP_CONSOLIDATION_MAX_CHARS`). | Kept from v1. The limit travels on the review object (Phase 3), so Condense keeps 800 unless a review opts in. |
| **No `<active_budget>` goal in any prompt.** | A model that sees one group cannot reason about a whole-ledger token goal, and the goal pushes it to over-compress. The before/after token count is shown in the UI instead. |
| **Keep pins and the boundary; keep the shared-tag grammar.** | Pins and the boundary already work. The grammar is where most of the real savings come from. |
| **One attempt per batch, run one batch at a time, no automatic retry.** | Matches v1's "one paid attempt" rule, avoids rate limits, and lets Cancel stop between batches. The user retries failed batches explicitly. |
| **Apply goes through the Condense review and `applyReviewedLedgerCleanup`.** | No new apply, restore, or recovery code. |
| **Per-record detail warnings are enough.** | v1's whole-ledger detail check existed because archived lines had no record of their own. Without an archive, Condense's per-record `ledgerDetailWarnings` covers every changed source. |

## 4. Not in v2

- Archive storage, restore from archive, re-promotion.
- A model audit call.
- Packing several small groups into one call (start with one group per call and measure the call count first).
- Salvaging individual batches from a stale draft (a stale draft is export-only, as in Condense).
- Durable autosave across page reloads (Phase 5, only if needed).
- Anything automatic or in the background; deep consolidation stays a manual action.

## 5. Build phases

### Phase 0 — fix the floor measure (no model call)

- [x] `deepExactCandidates` (knowledge/deep_consolidation_checks.js:21) runs
      `/\p{N}/u` over the whole line. Every line ends in `— date`
      (`formatLedgerLine`, knowledge/lorebook.js:910), so almost every dated
      line is flagged "keep exact" and `floorTokens` comes out near the full
      ledger. Run the checks on the fact part only (the text before the last
      ` via `).
- [x] Record the testing ledger's numbers in §9: source count, ledger tokens,
      pins + recent tokens, exact-candidate tokens with the fixed check, the
      Knowledge model and its Max Tokens setting.

### Phase 1 — grouping call and group review

- [x] Grouping prompt + user content (new pure module, e.g.
      `knowledge/deep_consolidation_groups.js`). Input: the eligible sources
      above the boundary, minus pins, as `[sN]` lines. Output only:
      `{"version":1,"reviewId":"…","groups":[{"label":"…","s":[1,4,9]}]}`.
      Group by SUBJECT (person, faction, place, secret), keep corrections with
      what they correct, and leave lines ungrouped when nothing fits.
- [x] **Normalize, don't reject.** Only unparseable JSON or a wrong reviewId
      fails. Otherwise, in code:
      - drop unknown, non-integer, pinned, or post-boundary numbers;
      - a source listed in two groups stays in the first;
      - drop empty groups; trim labels to one line, capped at 80 characters;
      - anything unlisted is Ungrouped and stays exact.
      Show what normalization did ("3 unknown numbers ignored, 2 duplicates
      resolved") instead of failing.
- [x] **Fallback with no model call:** "Group by position" makes groups of
      `BATCH_MAX_SOURCES` consecutive lines. Useful when the grouping call
      itself fails or the ledger is too large for it.
- [x] Group review UI: label, line count, estimated tokens, and how many
      batches each group will need. Reuse the move control (`moveDeepSource`)
      adapted to groups only. Singleton groups are shown as "kept exact".
- [x] Budget check per call via `checkCleanupBudget`, with a minimum answer of
      every non-pinned source listed once in one group.
- [x] Diagnostics record with `operation: 'deep-consolidation-groups'` and its
      own review id.

Phase 1 implementation: `knowledge/deep_consolidation_groups.js` contains the
pure prompt, normalization, position fallback, group-only move helper, and batch
count projections. `knowledge/deep_consolidation_groups_request.js` owns the
identity-bound one-attempt request, budget verdict, and privacy-safe diagnostics.
The existing experimental modal now ends at group review. Projected batch counts
use the proposed 30-source / 3,000-token caps, not an executable batch plan; exact
splitting remains Phase 2. Groups are disposable on close until Phase 2 adds the
in-memory draft. Legacy v1 request/preview helpers remain isolated and tested but
are no longer used by the modal; remove them alongside the later migration.

### Phase 2 — batch runner (with in-memory progress)

- [ ] `planBatches(groups, { maxSources, maxTokens })`, pure: singleton groups
      make no call; a group within the caps is one batch; a larger group is
      split by ledger order into near-equal chunks. Starting caps:
      `BATCH_MAX_SOURCES = 30`, `BATCH_MAX_TOKENS = 3000` ledger tokens (tune
      from Phase 6 data).
- [ ] **Batch review = a synthetic mini-ledger.** Build
      `"Knowledge Ledger:\n" + batchSourceTexts.join('\n')` and capture it with
      `captureLedgerReview(content, batchReviewId, { maxRecordChars: 1200 })`.
      The model sees `[s1]…[sk]`. `expandKeepListProposal` and
      `validateLedgerProposal` then work unchanged on the batch, and results
      map back to ledger source numbers by position in the batch.
- [ ] Batch prompt: a sibling of `LEDGER_CLEANUP_PROMPT` (knowledge/prompts.js:547)
      with the same rules, plus: every line is about one subject
      (`<subject>label</subject>`); merge into as few records as fit; the
      shared-tag grammar; the 1,200 hard limit and the 500–650 target. Much
      shorter than the v1 prompt: no archive, groups, or budget text.
- [ ] Run batches one at a time with an AbortSignal. Check the scope after
      each call (v1's `assertCurrent` pattern). Statuses: pending / running /
      accepted / failed / skipped. A failed batch keeps its stage, reason, and
      raw response (downloadable, never logged), as v1 does now.
- [ ] Retry one failed batch, or all of them. Each retry captures a fresh
      batch review id.
- [ ] Each batch records finish reason and completion tokens in Diagnostics,
      matched by its own batch review id.
- [ ] Progress lives in a module-level draft map keyed like Condense drafts
      (`scopeKey|bookName|name|uid`, knowledge/cleanup_review.js:428). Closing
      the modal mid-run and reopening resumes at the next pending batch.

### Phase 3 — hand-off to the Condense review

- [ ] **One opt-in seam in knowledge/ledger_cleanup.js:**
      `captureLedgerReview(content, reviewId, { maxRecordChars } = {})` stores
      `maxRecordChars` on the frozen review. `validateLedgerProposal` uses
      `review.maxRecordChars ?? LEDGER_ITEM_LIMITS.fact` at line 235.
      `checkReview` accepts only an absent value or an integer between 800 and
      `DEEP_CONSOLIDATION_MAX_CHARS`. Because every Condense helper
      (`editLedgerRecord`, `keepLedgerOriginals`, `patchLedgerProposal`,
      `validateLedgerReplacement`) validates through the review, they all
      follow with no signature changes. Tests pin the default reviews and
      messages unchanged.
- [ ] Assemble: capture the entry fresh, build a full review with
      `maxRecordChars: 1200`, then make records. Accepted batch records map
      onto the fresh source ids. Every other source (pins, recent, ungrouped,
      singleton, failed, pending) becomes an exact original. Sort by earliest
      source and run `validateLedgerProposal` before handing off.
- [ ] `stashPreviousCleanupDraft(capture)`, then
      `saveCleanupDraft(capture, { review, proposal, decisions: { removals: [] } })`,
      then open the Condense review at its review step. Edit, keep originals,
      removals, apply, recovery, and restore are all existing code.
- [ ] Partial hand-off is allowed: any number of accepted batches.
- [ ] Clear the deep draft where Condense clears its own after a successful
      apply (knowledge/cleanup_review_ui.js:940).

### Phase 4 — resume across scans, export/import

- [ ] The draft stores source **numbers plus a text snapshot** of the
      eligible span, never review-scoped source ids (those change on every
      capture).
- [ ] Resume rule: a fresh capture's first `throughSource` ledger lines must
      equal the snapshot exactly. Scans only append after the last item
      (knowledge/lorebook.js:977), so a draft survives scans. Any other
      difference (Edit-in-View, a Condense apply, a removal) makes the draft
      stale and export-only.
- [ ] Export / import the draft as a versioned JSON file
      (`type: 'mwt-deep-consolidation-draft'`). Import never trusts a review
      object from the file: it reads the snapshot, groups and batch results,
      then applies the resume rule against a fresh capture and re-validates
      every batch.

### Phase 5 — durable autosave (only if reloads mid-run turn out to matter)

- [ ] Choose a store. Not localStorage: kt_history already pushes it near
      quota. Candidates: IndexedDB through ST's localforage, if the host
      exposes it (unverified), or a disabled, non-vectorized sentinel
      lorebook entry following the `[MWT:cleanup-recovery]`
      persist-and-verify pattern. That entry rides every whole-book save while
      it exists, so delete it on apply or discard.

### Phase 6 — trial on the testing book

- [ ] Run v2 on a COPY of the testing book and apply there (recovery exists
      now, so applying on a copy is safe).
- [ ] Use the v1 doc's §3F probe protocol: 5–10 probe moments where old
      knowledge matters, at least 2 control moments, A/B from the same chat
      state, blinded where practical, regrowth counted before and after.
- [ ] Record results in §9, including calls made, per-batch completion
      tokens, failure count by stage, and review time.

## 6. What happens to the v1 code

| File | Fate |
| --- | --- |
| knowledge/deep_consolidation.js | Keep capture, boundary and pins (`captureDeepConsolidationReview`, `selectDeepConsolidationSources`) and `DEEP_CONSOLIDATION_MAX_CHARS`. Remove the v3 wire, `expandDeepConsolidationProposal`, `validateDeepConsolidationProposal`, and `DEEP_CONSOLIDATION_WIRE_VERSION`. |
| knowledge/deep_consolidation_prompt.js | Rewrite as the grouping prompt + batch prompt. Keep the grammar v2 wording. |
| knowledge/deep_consolidation_request.js | Split into a grouping request and a batch request. Keep the scope checks, the failure object with the downloadable raw response, and the diagnostics matching. |
| knowledge/deep_consolidation_checks.js | Mostly removed (Condense per-record warnings replace it). `deepExactCandidates`, fixed in Phase 0, stays only if the measure proves useful. |
| knowledge/deep_consolidation_preview.js | Adapt `moveDeepSource` to groups only. Replace `exportDeepTrialPacket` with the draft export. |
| knowledge/deep_consolidation_review_ui.js | Rewrite with steps: setup → groups → batches → hand-off. Keep the modal id `kt-deep-consolidation-modal` (test/paused_chat_cleanup.test.js:226 lists it). |
| test/knowledge_deep_consolidation*.test.js | Rewrite alongside. The button test in test/knowledge_cleanup_review.test.js:150 stays if the button class stays. |

## 7. Landmines

1. **Review ids are per capture.** Drafts must store source numbers and a
   text snapshot. A stored source id never matches a fresh capture.
2. **The whole entry changes on scans, not just the ledger** (scans also
   update dossier fields). Condense's resume check compares the whole entry
   (knowledge/cleanup_review_ui.js:310, :389), so the hand-off must build its
   review from a capture taken at hand-off time, never from an older one.
3. **Resume depends on scans only appending.** If a future change inserts
   ledger lines elsewhere or trims old ones, resume fails safe (stale), but
   drafts stop surviving scans.
4. **Copy source text exactly into the synthetic batch ledger.** `parseLedger`
   keeps leading whitespace in item text, and the exact-keep check compares
   text byte for byte.
5. **Validate `maxRecordChars` in `checkReview`.** Otherwise any caller could
   raise the limit. Imported drafts never supply a review object (Phase 4).
6. **A later normal Condense can keep a 1,200-character line exactly, but
   cannot rewrite it above 800.** That is the existing exact-legacy rule
   (knowledge/ledger_cleanup.js:231), not a bug.
7. **Splitting a big group by order can separate a correction from the claim
   it corrects.** Accept this for v2: keep batch caps generous, and the user
   can move lines between groups before running.
8. **Reasoning cost is still invisible** to `checkCleanupBudget`. Size batches
   by input and tune the caps from the per-batch completion tokens recorded
   in Diagnostics.
9. **The hand-off must stash before saving.** Otherwise a Condense draft the
   user is working on is overwritten. Stashed drafts stay exportable (five
   kept, lost on reload).
10. **Recovery labels.** `applyReviewedLedgerCleanup` hard-codes the
    `ledger-condensation-` action id prefix (knowledge/cleanup_review.js:527),
    so deep runs look like Condense runs in the recovery list.

## 8. Open decisions

- Starting batch caps (30 sources / 3,000 ledger tokens proposed).
- Phase 5 store, if Phase 5 is needed at all.
- Whether the hand-off opens the Condense review directly (needs a small entry
  point on `openLedgerCleanupReviewModal`) or the user clicks its existing
  Resume button.
- Whether deep runs get their own recovery label (landmine 10).

## 9. Results

### Phase 0 — floor measure (2026-11-22)

Ledger: `temp_ledger_file/temporary_knowledge_ledger.md` (the testing ledger, exported verbatim; raw
measure output in `temp_ledger_file/phase0_floor_measure.json`). Token figures are `estimateTokens`
under its chars/4.5 fallback — the measurement run had no host tokenizer — so estimates, not
tokenizer counts. Whole-ledger boundary and no pins (the modal's defaults), so pins + recent are
empty.

| Measure | Value |
| --- | --- |
| Source count | 325 |
| Ledger tokens (`parseLedger` body) | ≈17,240 |
| Pins + recent tokens | 0 (no pins in the export; the whole-ledger default boundary leaves the recent pool empty) |
| Exact-candidate tokens, fixed check (fact part) | ≈11,436 across 185 sources (≈66% of ledger tokens); reasons: 132 number-or-code, 67 quoted-text, 17 correction-candidate, 5 belief-or-rumor, 1 code |
| Pre-fix whole-line check (comparison) | 324/325 sources flagged, ≈17,143 tokens (≈99% of the ledger — the floor was indistinguishable from "keep everything") |
| Knowledge model (testing) | GLM 5.2:thinking |
| Max Tokens setting (testing) | 160,000 (production preference: nothing larger than 60,000) |

Readings. The fix does what Phase 0 claimed: the floor is no longer the whole ledger by
construction (≈99% → ≈66%). But digit-bearing facts are common enough in this ledger that the
lexical exact floor still covers about two thirds of it — well over the 4,000-token default active
goal — so a single whole-ledger call remains hopeless and per-group batching (Phase 2) stays
necessary. Known residue: 61 lines carry no ` via ` separator (parenthetical provenance such as
`(via personal experience — Sunday July 2, 2000)`); those are still checked whole, and 60 of them
are flagged, mostly by their trailing dates. The residue is bounded and errs toward keep-exact,
never toward silent loss.

(To be appended by Phase 6: trial results — calls made, per-batch completion tokens, failure count
by stage, review time, probe outcomes.)
