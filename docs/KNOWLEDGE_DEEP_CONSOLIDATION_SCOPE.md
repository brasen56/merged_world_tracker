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