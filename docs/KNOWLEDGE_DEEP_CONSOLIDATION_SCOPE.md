# Knowledge Tracker — experimental deep consolidation

**Status:** Draft for co-author input; not an approved implementation plan.
**Date:** 2026-11-02
**Area:** Large NPC Knowledge Ledgers, active context, and archival storage.
**Release boundary:** Private experimental branch; no public release planned unless specifically requested.
**Purpose:** Agree on a small experiment before choosing storage, UI, or implementation details.

## 1. Problem and goal

The testing RP has some knowledge entries exceeding 15,000 tokens. Existing
reviewed Condense behavior deliberately preserves source coverage and concrete
details, so its conservative merges may not provide the desired reduction.

This experiment asks a different question: **how much historical detail can leave
active context without damaging continuity, provided the originals remain
recoverable?** API cost is not the primary constraint for this private experiment.

The proposal is model-assisted consolidation backed by a durable archive, not
permanent deletion or a promise of lossless summarization. Keep the existing
public Condense behavior unchanged.

## 2. Proposed memory model

| Layer | Contents | Normal prompt visibility |
| --- | --- | --- |
| Consolidated knowledge | Compact, durable takeaways supported by original records | Active when the NPC entry is included |
| Recent acquisitions | New ledger lines since the selected consolidation boundary | Active when the NPC entry is included |
| Archive | Exact original records, provenance, and links between sources and summaries | Excluded unless explicitly recalled |

For the first prototype, consolidated knowledge and recent acquisitions could
remain ordinary ledger bullets in the existing NPC entry. Archive storage is a
design decision, not settled by this scope. It must be separate from cleanup
recovery: the archive is ongoing knowledge storage; recovery is rollback support.

An archived fact is **not** automatically available to the model. Merely writing
an archive reference into a summary does not implement retrieval.

## 3. Small first experiment

Proposed manual action: **Experimental: Deep Consolidate**, for one NPC at a time.

1. Select a boundary such as “consolidate through this entry.” Keep later records
   verbatim. Allow important records to be pinned and retained exactly.
2. Choose an approximate active-ledger budget. A 3,000–5,000-token budget is a
   starting experiment for a 15,000-token ledger, not a guaranteed safe ratio or
   permission to truncate. Pinned and recent records count toward the budget;
   report when they make it unattainable.
3. Capture the exact source revision and disclose the model/profile, payload,
   estimated size, and privacy implications before generation. Reuse Knowledge
   model configuration initially; do not assume a separate model setting is needed.
4. Ask the model for compact active knowledge, exact records to retain, source
   mappings, details relegated to the archive, and unresolved ambiguities.
5. Run a separate audit call comparing the proposal with the original sources.
   Surface missing consequential knowledge, unsupported conclusions, attribution
   changes, uncertainty loss, and chronology errors. An audit is not proof.
6. Show an editable preview, estimated token reduction, and archive-only details.
   Apply only after explicit approval and successful archive persistence.

Prefer a whole-ledger request if the configured model's input and output capacity
permits it. Refuse clearly when it does not; chunking can be designed later rather
than silently clipping input or separating related facts and corrections.

## 4. Consolidation policy

- Consolidate related facts across a topic or story arc, rather than merely
  shortening each incident. Incidental examples and repeated observations may
  become archive-only detail, with that tradeoff visible in review.
- Preserve who knows what, how they learned it, uncertainty, corrections, and
  consequential chronology. An NPC's belief is not necessarily world truth.
- Do not invent psychological conclusions or resolve contradictions by guesswork.
  Several acts of trust do not automatically mean “trusts completely.”
- Keep secrets, exact codes, consequential promises, and other continuity-critical
  details active when needed; offer pins rather than relying only on model judgment.
- Account for every selected original as retained exactly, represented by a
  summary, or archive-only. These dispositions are bookkeeping, not evidence of
  semantic equivalence. No source is permanently deleted by consolidation.
- Use age as a candidate-selection aid, not an importance score. Current ledger
  dates are optional text; do not guess dates or treat unknown dates as old.

## 5. Safety and integration boundaries

- Generation and auditing do not modify live entries. Keep explicit review and
  Apply separate from ordinary staging, auto-approval, and bulk acceptance.
- Bind the operation to chat scope, resolved book, stable NPC identity, entry UID,
  and exact source revision. Refuse stale application while preserving the draft.
- Persist and verify the archive before replacing active knowledge. Partial or
  uncertain saves must be reported, not presented as successful consolidation.
- Exclude archive contents from ordinary host activation, extension prompt
  projections, and unrelated model requests. Treat stored text as untrusted data.
- Provide archive inspection, export, and conflict-aware restore/re-promotion.
  Do not blindly overwrite newer ledger changes when undoing a consolidation.
- Retain original-source links across repeated runs. Do not repeatedly summarize
  summaries without checking their underlying originals.
- Verify archive durability across reload and backup/export round trips. Reuse
  existing cleanup safety patterns where suitable without assuming its recovery
  schema or commit service already supports this new operation.
- Observe ledger regrowth: ordinary updates may re-add archived facts. Measure
  this first; archive-aware deduplication can follow without injecting the archive.

## 6. Out of scope for the first prototype

- Automatic/background consolidation or date-triggered archival.
- Automatic scene-relevant retrieval, embeddings, or a new retrieval dependency.
- Multi-NPC/global knowledge merging or full-chat re-analysis.
- Changes to dossier fields, relationship ownership, or the public Condense policy.
- Permanent pruning, a fixed compression guarantee, or public-release polish.

Manual archive search and restoring selected facts to active knowledge are enough
for the initial recall path. Any later automatic recall needs its own relevance,
token-budget, scope, and character-knowledge boundaries.

## 7. How we will judge the experiment

Use a representative large ledger and record before/after active token estimates,
review effort, audit findings, and details deliberately moved out of context.
Check continuity against the original ledger: secrets, beliefs versus facts,
corrections, codes, relationship-changing events, and unresolved commitments.

Also test reload/export/restore, stale proposals, failed or uncertain persistence,
archive exclusion from prompts, and a second consolidation after new acquisitions.
Observe later RP turns for forgotten details and duplicate ledger growth.

Success means useful context savings with acceptable continuity and practical
recall—not simply hitting the smallest token count. Agreement on scope should
precede a phased implementation plan.

## 8. Open Questions

1. Is the active-memory/archive split the right experiment, or should we first
   try a more aggressive reviewed rewrite without ongoing archive management?
2. What must stay exact or active by default, beyond user-pinned records?
3. Is an entry boundary sufficient initially, or is calendar-aware selection
   essential? How should unknown or ambiguous dates be handled?
4. Is the proposed budget useful, and should an independent audit be mandatory?
5. Where should permanent archives live, and what export, retention, and restore
   behavior do we need before using this on a valued RP?
6. Is manual recall enough to evaluate the idea, or would lack of automatic
   retrieval make the experiment unrepresentative?
7. Which concrete continuity checks and acceptable tradeoffs should decide
   whether the experiment is worth keeping?



### Response:
I agree with the active/archive split and with keeping this on the experimental branch. Before implementation I would change these things:

1. Group by subject, not by scene or arc.
   No data ties a ledger line to a scene. A line is `- fact via source — date` (formatLedgerLine, knowledge/lorebook.js:771), and the date is optional in-world text the model writes "if known". Chronicle snapshots record message ranges, but a ledger line doesn't record which scan batch added it, so nothing joins the two. The only time signal is the order lines were added. Arc grouping would therefore be the model guessing, and many lines won't obviously belong to any one scene.
   Grouping by subject (who or what the fact is about: the PC, a faction, a place, a secret) works from the text itself. It also avoids a trap in scene grouping: a correction usually happens in a later scene than the fact it corrects, so scene groups split them apart. Subject groups keep them together, which §4's rule on corrections needs.
   Make grouping a visible step. The model returns groups as source numbers plus a label, the user can adjust them, and "no group" is a normal outcome that keeps the line exactly as written. If too many lines stay ungrouped to meet the budget, record that as an experiment result.
2. Answer the core question before building the archive.
   The first question is whether the model can bring a ~15k-token ledger down to 3–5k without visible continuity loss. A preview that writes nothing, run on a copy of the testing book, answers that. Pick 5–10 moments in the RP where old knowledge should matter, generate replies with the original ledger and with the consolidated one, and compare them. If the model can't do it, the archive, restore and re-promotion work isn't needed. This is the same measure-first order we used for the diagnostics panel and World State Phase 6.
3. Extend the existing Condense pipeline rather than starting a new one.
   The keep-list response format (expandKeepListProposal, knowledge/cleanup_review.js:94) already has `keep` and `changed`, and validation already requires every source line to be accounted for exactly once. A third list, `archive`, gives §4's bookkeeping directly. Today validateLedgerProposal (knowledge/ledger_cleanup.js) rejects model removals, so the new disposition is the change to make, and only for the experimental action.
4. Extend the detail-not-retained check to archived lines.
   ledgerDetailWarnings (knowledge/ledger_cleanup.js:140) already flags numbers, codes and capitalized names that a merged record drops, but it compares each record only with its own sources. Archive-only lines have no record, and consolidating across a subject can move a detail into a different record. For this action, check archived and summarized sources against the whole active result. At this scale the capitalized-word false positives (sentence starts) will be numerous, so list numbers and codes first. This is the deterministic guard. The model audit shares the blind spots of the model that wrote the proposal, so I would treat it as a supplement.
5. Archive storage and links.
   Follow the `[MWT:cleanup-recovery]` pattern: a dedicated disabled, non-vectorized sentinel entry in the Knowledge book, saved and verified before the live entry changes (knowledge/cleanup_recovery.js). There are two costs. The archive rides every whole-book save, and a deep run would also write a whole-entry recovery record, so the originals are stored twice. That is acceptable for a prototype but worth measuring on the testing book.
   Keep the links from summaries to their originals outside the ledger text. Any later Edit-in-View or Condense changes a summary's text, so a link based on matching text goes stale. Show that as "summary edited since consolidation" rather than letting it fail silently.
6. Bound later runs.
   If every later run must re-read all underlying originals (§5), its input grows back to the full history. A narrower rule would work: a later run consolidates new acquisitions plus the existing summaries, and checks originals only for the summaries it changes.
7. Regrowth already has a baseline.
   The scan already sees only the most recent ledger lines (knowledge/prompts.js:161, "<existing_entry> IS ABBREVIATED"), so it can re-add old facts today with or without an archive. Measure regrowth on the testing book before consolidating, so the experiment can tell new duplicates from existing ones. Some regrowth is also correct: when recent chat brings an archived fact up again, that fact is active again.

For the open questions:
- 1 — The archive split.
- 2 — Exact by default: lines with numbers, codes or quoted text; rumor and belief lines (never merged into facts); and the latest version of anything that was corrected.
- 3 — An entry boundary is enough. Dates are optional model text, so selecting by calendar would be unreliable.
- 4 — The budget is useful. Make the deterministic detail check mandatory and the model audit optional.
- 5 — In the Knowledge book, as in point 5, with the export and backup round trip tested before it is used on a valued RP.
- 6 — Manual recall is enough to judge the idea. Users notice only obvious forgetting, though, so the side-by-side comparison in point 2 matters more than recall does.
- 7 — The probe moments from point 2, checked against §7's list: secrets, beliefs versus facts, corrections, codes, relationship-changing events and unresolved commitments.