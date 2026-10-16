# Knowledge Tracker — concision and reviewed cleanup

**Status:** Draft for co-author review; not an implementation commitment.
**Date:** 2026-10-16
**Area:** Knowledge Tracker dossier generation, Knowledge Ledger, and review UI.
**Purpose:** Agree on behavior, safety boundaries, and first-release scope before implementation.

## 1. Problem

Users report that long-running sessions (3,000+ chat messages) accumulate very
large NPC entries; one reported entry was approximately 15,118 tokens. These are
user reports, not independently measured benchmarks. Users currently trim entries
by hand.

Two related problems need different remedies:

1. **Ledger growth:** verbose examples, overlapping observations, and repeated
   facts make durable knowledge expensive to retain.
2. **Field drift:** short dossier fields become event logs or miscellaneous
   catch-all fields, often repeating information already stored elsewhere.

Reported example:

> Role: Alex's boyfriend; Braun transmittal sent; co-signer of the amended weekend law; chock duty and photo-hanging at today's Kovach unload

This mixes a relationship, a completed event, an ambiguous status, and temporary
tasks. It does not provide a clear, compact role.

**Guiding principle:** A dossier is a compact reference, not a second transcript.
Concise does not mean incomplete, and misplaced does not mean disposable.

## 2. Proposed scope at a glance

| Workstream | Proposed behavior | Consent boundary |
| --- | --- | --- |
| Prevent future field drift | Shared field definitions, concise examples, and output checks across model-driven writes | Existing update approval behavior remains; no bulk rewrite of stored entries |
| Prevent future ledger verbosity | Capture durable takeaways rather than exhaustive retellings | No new automatic pruning or consolidation of existing records |
| Condense an existing ledger | Generate an editable, ledger-only proposal for one NPC | Explicit invocation and explicit approval; never auto-apply |
| Flag pruning candidates | Explain potentially low-value details separately | Advisory only; no automatic removal, including from the proposed ledger |
| Clean up existing dossier fields | Review selected fields for scope and brevity | Explicit invocation, selected fields only, reviewed application |

The two cleanup actions are separate. Users must be able to condense a ledger
without changing Role, or clean up Role without rewriting the ledger.

## 3. Field discipline

### 3.1 Shared contract

Use one consistent field contract across scans, single-NPC updates, enrichment,
and per-field refresh. Fixing only one prompt would allow another path to
reintroduce the same problem.

Suggested guidance below is **provisional**, not a set of hard truncation limits:

| Field | Belongs here | Does not belong here | Suggested shape |
| --- | --- | --- | --- |
| Descriptor | Recognizable physical or enduring role shorthand | Scene recap, task list | 3–5 words |
| Tone | Communication style | Dialogue history, current errands | 2–3 words |
| Perceived as | Outward impression | Secret motives, event history | One short phrase |
| Role | Established occupation, enduring responsibility, or primary story function | Today's chores, completed actions, agreement history, relationship inventory | One short phrase; usually 3–12 words |
| Where to Find | Established base, usual location, or reliable routine | Travel diary, each temporary movement | One short sentence |
| Appearance | Distinguishing physical traits and relevant lasting changes | Every outfit or incidental gesture | 1–3 short sentences |
| Voice | Stable cadence, accent, and distinctive verbal habits | Tone duplication, dialogue transcript | 1–2 short sentences |
| Background | Defining history and lasting consequences | Running session summary | 2–4 short sentences |
| Personality | Established behavioral traits within existing ownership rules | Recent-event recap or speculative diagnosis | 1–3 short sentences |
| Read on PC | Current assessment of the player character | Full relationship history | 1–2 short sentences |
| Current Agenda | Active overarching goal and meaningful constraint | Every small task or completed obligation | 1–2 short sentences |
| Secrets | Still-private information under existing tier/lifecycle rules | Public facts or unrelated history | Brief statements per applicable tier |
| Canon Lock | Existing protected continuity constraints | Automatic overflow destination for trimmed details | Preserve during cleanup |
| Image Tags | Existing visual-tag representation | Narrative prose or event history | Preserve during cleanup |

Relationships remain primarily owned by the relationship system. A relationship
may be a legitimate primary story function, so this is not a blanket ban on
phrases such as "Alex's boyfriend." Avoid repeating the relationship inventory.

If no role is established, preserve the existing unknown/empty convention rather
than invent an occupation. A temporary responsibility belongs in Role only if it
has genuinely become an enduring role, not merely because it happened recently.

### 3.2 Applying the contract to the reported example

A possible cleaned Role is **"Alex's boyfriend"**, if that is the established
primary story function and no more appropriate role is known. This example does
not establish any additional occupation.

The remaining clauses require review, not automatic relocation:

- **"Braun transmittal sent":** a completed event; potentially ledger material
  only if relevant to what this NPC knows and not already represented there.
- **"Co-signer of the amended weekend law":** ambiguous without context. It could
  be a lasting status, an agreement, or a one-time event. Do not classify from
  wording alone.
- **"Chock duty and photo-hanging...":** temporary tasks; not Role by default.
  Do not copy them into Current Agenda unless they express a meaningful active
  goal. Do not put the NPC's own unresolved plans into the ledger.

In reviewed cleanup, show displaced details separately with explanations and
whether a destination is merely suggested. Do not silently move them, promote
them into canon, or assert that they are duplicated without locating the match.

### 3.3 Generation rules

- Update a field only for a meaningful change in that field's subject.
- Prefer replacement with the current concise value over appending new clauses.
- Do not fill a short field with recent activity just because that activity is
  the only new information available.
- Keep stable fields unchanged when recent messages provide no relevant change.
- Preserve uncertainty and existing unknown values rather than inventing detail.
- Prefer one appropriate home per detail; allow useful overlap where fields have
  genuinely different purposes. Avoid a brittle global "no duplicate words" rule.
- Respect current Growth ownership and all existing write/scope protections.

Prompt guidance alone is not a guarantee. At implementation time, define shared
output-shape and oversized-value checks at the relevant merge seams. Invalid or
overlong proposed values must not be silently sliced; preserve the old value and
surface an actionable reason. Any retry must be bounded, not an unbounded paid loop.

## 4. Opt-in ledger condensation

### 4.1 User flow

1. Invoke **Review / condense knowledge** for one NPC.
2. Show the request scope, configured model, privacy/cost notice, and input size.
3. Send that NPC's ledger and minimal necessary identity context, not the entire
   chat or unrelated private dossier fields by default.
4. Generate a proposed ledger and a separate advisory list of pruning candidates.
5. Show an editable preview, original/proposed diff, whole-entry and ledger size
   comparisons, and any validation warnings. Label token counts as estimates
   unless an appropriate tokenizer is actually available.
6. Apply only after explicit confirmation, independently of normal auto-approval.
7. Preserve a recoverable original before committing the replacement.

The live entry remains unchanged during generation and review. Cancel, model
failure, malformed output, or failed validation must leave it unchanged.

### 4.2 What condensation may do

- Shorten wording without strengthening claims.
- Merge genuinely overlapping facts where provenance and chronology remain clear.
- Replace exhaustive examples with a faithful summary, showing the specificity
  tradeoff in review rather than calling the result lossless.
- Preserve distinct facts even when the model considers them low-value.

Example proposal:

> Alex demonstrated expert automotive knowledge, recalling detailed performance and tuning specifications for the GNX, LS1/Trans Am WS6, and 20B rotary swaps — witnessed July 2, 2000.

This is a proposed condensation of the reported automotive entry, not a rule that
vehicle names or technical specifications are always expendable.

### 4.3 Non-negotiable knowledge boundaries

- Keep each NPC's knowledge separate from objective world truth.
- Preserve witness/told/document/rumor/institutional distinctions and attribution.
- Do not turn a rumor into a fact, a reported claim into direct experience, or a
  promise into a completed action.
- Preserve meaningful dates, order, corrections, and uncertainty. Do not flatten
  an old belief and its correction into a timeless assertion.
- Do not infer skills or conclusions beyond what the existing ledger establishes.
- Do not silently drop legacy plan-shaped or otherwise questionable records;
  flag them for manual review instead.
- Leave every non-ledger section unchanged, including managed relationship blocks.

### 4.4 Pruning suggestions

For each suggestion, show the exact affected original record/detail and a short
reason, such as "repeated elsewhere" or "possibly incidental technical detail."
If claiming duplication, identify the matching record or field.

Suggestions are subjective and may be wrong. Flagged content stays represented
in the proposed ledger unless the user manually removes it. No preselected delete
checkboxes, hidden omission stage, or "apply all pruning" behavior in v1.

For reviewability, associate proposed merged records with their original record
IDs or review-local indexes. Require every original record to be accounted for;
this assists review but does not prove semantic equivalence or prevent subtle loss.

## 5. Opt-in existing-field cleanup

- Separate **Review field cleanup** action, with an explicit field selection.
- Propose changes only to selected, eligible fields; do not mutate unselected
  fields or use this action to consolidate the ledger.
- Show original and proposed values plus an explanation for each changed field.
- List displaced details as review notes, never silently discard or relocate them.
- Offer keep-original/edit/accept decisions per field; no preselected acceptance.
- Keep Canon Lock, Image Tags, managed relationships, and Growth-owned content
  out of scope. Reuse existing ownership checks rather than establishing a new
  competing authority.
- Do not inspect unrelated chat history by default. If the entry does not support
  a safe rewrite, flag the ambiguity instead of guessing.

## 6. Safety, persistence, and large inputs

- Bind proposals to the originating chat scope, resolved lorebook, stable entity,
  entry UID, and source content revision/fingerprint.
- Recheck those bindings before saving. If the entry changed, refuse the stale
  proposal and offer regeneration; do not overwrite background or manual edits.
- Use existing guarded write paths. Reject missing, mismatched, ambiguous, or
  structurally unparseable entries instead of guessing section boundaries.
- Save the exact original durably before replacement. If recovery persistence
  fails, do not apply. Recovery data must not be injected into model context.
- Surface persistence failures honestly; a successful model response is not a
  successful save. Recovery must not blindly overwrite intervening edits either.
- Treat ledger text as data, not instructions to the cleanup model. Enforce output
  scope in code rather than relying only on a prompt.
- Preflight input and output capacity. Never silently clip the ledger. For v1,
  clearly refuse oversized requests with an explanation; automatic chunking and
  cross-chunk consolidation are deferred.

**Before implementation:** choose recovery storage, retention, restore UX, and
backup/export behavior. Reuse existing infrastructure if it meets these needs;
this draft does not assume that ordinary backups already provide per-action undo.

## 7. Delivery slices and explicit exclusions

1. **Prevention:** agree on the field contract; align all generation paths; add
   concise ledger guidance and regression fixtures. No mass cleanup on upgrade.
2. **Ledger review:** single-NPC condensation, advisory pruning flags, editable
   diff, source coverage, durable recovery, and guarded explicit application.
3. **Field review:** selected-field cleanup with per-field decisions and displaced
   detail notes. This can follow slice 2 if needed to keep the initial release small.

Not included: scheduled compression, automatic deletion, whole-lorebook batch
rewrites, aggressive compression targets, full-chat re-analysis, a new memory
retrieval system, relationship-system redesign, Growth evidence consolidation,
or changes to secret lifecycle/Canon Lock authority outside these cleanup actions.

Prevention does not introduce a new automatic cleanup mode. All existing-entry
rewrites remain opt-in; no feature runs merely because an entry crosses a size threshold.

## 8. Acceptance criteria and validation

- The reported Role example does not recur as a generated task/event inventory
  across scan, update, enrichment, and refresh fixtures.
- Existing entries are untouched on upgrade; prevention does not rewrite unrelated
  fields during ordinary updates.
- Concise capture fixtures preserve meaningful facts without exhaustive retellings
  or duplication of facts visible in the supplied ledger context.
- Condensation preserves source, uncertainty, meaningful dates, and corrections;
  pruning flags never remove content automatically.
- Non-ledger text remains byte-for-byte unchanged during ledger-only application.
- Field cleanup cannot alter unselected/protected fields or move displaced details.
- Cancel, invalid output, incomplete source coverage, oversized input, scope switch,
  rename/merge mismatch, deleted entry, and stale preview cannot modify the entry.
- Backup failure blocks application; save failures and recovery conflicts are visible.
- Review remains keyboard accessible and makes cost, scope, and approval explicit.
- Test with a synthetic oversized ledger and anonymized long-session examples if
  users consent. Compare size, factual fidelity, and reviewer effort; no promised
  reduction percentage or claim that automated checks prove semantic preservation.
- Unit-test pure parsing/validation/merge logic, integration-test guarded writes,
  and manually verify the host UI and representative configured-model responses.

## 9. Co-author decisions requested

1. Do we agree that Role should mean an enduring occupation/responsibility/story
   function rather than "current job or function in the scene"?
2. Are the proposed field shapes appropriate, and which need enforceable bounds
   rather than advisory prompt guidance?
3. Should existing-field cleanup ship with ledger review or in a follow-up slice?
4. Can v1 use the existing Knowledge model configuration, with a visible per-request
   disclosure, rather than introducing another dedicated model setting?
5. What recovery storage and retention policy are acceptable, and how will users
   restore an original without overwriting newer work?
6. Is explicit refusal of inputs beyond model capacity acceptable for v1?

## 10. Implementation orientation (not a finalized design)

Paths below are relative to the repository root:

- `knowledge/prompts.js`: current scan/update/enrichment/refresh wording. Several
  prompts encourage filling missing fields through inference; the Role description
  currently invites scene-level duties. Align these with the agreed contract.
- `knowledge/lorebook.js`: dossier field definitions, parsing/building/merging,
  model calls, and entry writes. Verify every applicable mutation seam.
- `knowledge/field_ownership.js`: existing Growth ownership filtering. Cleanup
  must respect this; broader Canon Lock ownership is not being redesigned here.
- `knowledge/render.js` and `knowledge/staging.js`: existing review/staging
  affordances. Reuse where suitable, but explicitly prevent cleanup proposals
  from entering an ordinary auto-approval path.
- `knowledge/schema.js`, `knowledge/store.js`, and existing scope/safety helpers:
  assess whether durable recovery needs new persisted state and schema coverage.

The current enrichment prompt mentions consolidation, but it also updates the
whole dossier. It is not a substitute for a narrowly scoped, reviewed cleanup action.



### Response:
There are four things I would tighten before implementation:
1. Explicitly fix an existing source of ledger growth.
   Enrichment currently asks for knowledge from the “existing ledger + new,” but its result goes through a merger that appends those records. The prompt is written as though its output replaces the ledger (it even says to drop the NPC’s plan-shaped lines “when consolidating the existing ledger”), while the merger only appends, with no deduplication. Each Enrich can therefore add a reworded copy of the entire ledger, and the plan-line drop never takes effect because the originals remain. This is visible in DOSSIER_ENRICH_PROMPT (knowledge/prompts.js:231 and :251) and runNpcEnrich (knowledge/lorebook.js:1447). The test at test/knowledge_ledger_prompt.test.js:61 encodes the same mistaken assumption: its comment says Enrich “rewrites the whole ledger.”
   I haven’t measured this against a model, but if users run Enrich even occasionally, it may be one of the main causes of the reported entry sizes. I would fix it now as a standalone bug fix rather than wait for slice 1: enrichment should return only genuinely new knowledge, with existing-record condensation handled by the reviewed action. That also resolves a conflict with §4.3, which says to flag legacy plan-shaped records for review, while the current Enrich prompt says to drop them. **Found and fixed in 2.12.1**
2. Clarify where condensation ends and pruning begins.
   The draft permits replacing detailed examples with summaries, while also requiring distinct facts to remain. Those rules can conflict. For example, replacing “knows the gate code is 7314” with “knows the gate code” preserves the general statement but loses the useful knowledge.
   I would require the review to identify specific details that the proposed summary no longer retains, so those losses cannot hide behind a “condensed” label. Part of this can be enforced in code rather than left to the prompt: if a number, proper name, code, or date appears in a merged record’s source records but not in the merged record, list it as “detail not retained.” That check is cheap and deterministic, and false positives are acceptable because the list is advisory. Similarly, the automotive example should call Alex an “expert” only if the original actually establishes expertise.
3. Make review substantially easier than manual cleanup.
   A huge text diff could replace exhausting editing with exhausting auditing. Show each proposed merged record alongside its original records, with expandable sources and an easy “keep these originals” option. Also clarify that source coverage means every original is accounted for as retained, merged, or explicitly removed by the user. Otherwise, the requirement for complete coverage could accidentally block the manual pruning the draft permits. If a background update makes a proposal stale, preserve the user’s edited draft even though application is blocked.
4. Test whether it helps the users who prompted this feature.
   Explicit refusal beyond model capacity is reasonable, but v1 should demonstrate successful cleanup of a representative entry around the reported 15,000-token size. Input capacity alone isn’t sufficient: the rewritten ledger, source mapping, and suggestions also need output space. The current default output allowance is 8k tokens (knowledge/settings.js:22).
   Truncation needs explicit handling. The API layer rejects a response when the provider reports finish_reason="length", but connection profiles don’t always report it. When they don’t, parseJsonLenient (core/api.js:1012) repairs the cut-off JSON by closing its brackets and records only a json_repaired warning. For condensation, a truncated ledger would then look like a successful, shorter one. The source-coverage check is the only guard against that, so it should stay mandatory, and a repaired parse should count as a failed condensation rather than a proposal to review.

For the open questions, my preferences would be:
- 1 — Role should describe an established occupation, responsibility, or story function. I would phrase it as “stable until a meaningful change”, rather than permanent. Someone becoming mayor should change Role; someone hanging pictures that afternoon generally shouldn’t. The allowance for “Alex’s boyfriend” as a primary story function also makes sense.
- 2 — Field shapes: Use the proposed word/sentence lengths as guidance, with generous enforceable size and structural checks. A valid 13-word Role shouldn’t fail merely because the suggestion says 3–12 words.
- 3 — I support shipping prevention and ledger condensation together. Users with months of accumulated entries need the cleanup tool alongside the prevention improvements. Before building field cleanup as a new action, though, check whether the existing 🎯 Fields refresh covers most of it once slice 1 aligns its prompt with the field contract. It already stages changes for review, touches only the selected fields, and excludes Canon Lock and Growth-owned Personality (sanitizeDossierRefreshFields, knowledge/lorebook.js:1479). What it lacks is displaced-detail notes, per-field keep/edit/accept decisions, and a mode that doesn’t pull recent chat activity into the rewrite (it currently reads recent messages, which §5 avoids). If those fit there cheaply, field cleanup can ship in the same release; if not, I’d let it follow rather than delay ledger review. A Role line that has drifted into an event log takes seconds to fix by hand; a 15,000-token ledger doesn’t.
- 4 — Model configuration: Reuse the Knowledge model configuration for v1, with the proposed disclosure. A dedicated setting doesn’t seem necessary yet.
- 5 — Recovery: Require durable cleanup originals, visible restore/export controls, and a defined retention policy at launch. Ordinary history is insufficient as currently implemented: it keeps 50 snapshots and silently ignores storage failures in pushHistory (knowledge/lorebook.js:93). That gap is worst for exactly these users. History stores full copies of the entry in localStorage, so 50 snapshots of a ~15,000-token entry come to roughly 3 million characters, against a budget of about 5 MB per site that is shared with ST and every other extension. The users with the largest entries are the most likely to have history writes failing without notice. Restoration should preserve newer work and show conflicts.
- 6 — Oversized requests: Accept refusal for v1, provided it explains which limit was exceeded and what configuration change could help.
