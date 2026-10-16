# Knowledge Tracker — concision implementation phases

**Status:** Proposed implementation plan; no phases implemented by this document.  
**Date:** 2026-10-16  
**Source:** `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/docs/KNOWLEDGE_CONCISION_SCOPE.md`, including the co-author response.  
**Area:** Knowledge generation, single-NPC cleanup review, persistence, and recovery.

## 1. Goal and delivery boundary

Make dossiers compact references rather than second transcripts, and give users
with existing large entries a safe, practical cleanup workflow. Concision must
not silently become deletion, stronger claims, or a competing ownership system.

The initial release target is **prevention plus reviewed ledger condensation**.
Selected-field cleanup is a separate follow-up phase; it may join that release
only if it meets its own gates without delaying ledger review. Neither cleanup
action runs automatically, on upgrade, or when an entry crosses a size threshold.

This plan translates the scope discussion into implementation work. Decisions
below are proposed defaults, not a claim that every open question already has
co-author approval. Phase 0 resolves the remaining design gates before feature
implementation starts. The source document remains the discussion record.

## 2. Working decisions and invariants

1. **Role is stable until a meaningful change**, not necessarily permanent. An
   established occupation, responsibility, or primary story function belongs;
   today's chores do not. “Alex's boyfriend” can be legitimate. Preserve unknown
   values rather than inventing a profession.
2. **Field shapes are guidance, not truncation thresholds.** Use the complete
   field table in the scope, with generous structural/size checks chosen from
   fixtures. A valid 13-word Role does not fail merely for exceeding 12 words.
3. **Ordinary generation remains incremental.** Stable fields stay unchanged
   without meaningful evidence. Ledger capture adds durable, genuinely new
   knowledge, not recaps or rewrites of existing records.
4. **Enrichment's append-only fix is already present in v2.12.1.** Preserve the
   prompt/merger regression coverage; do not schedule that fix again or change
   enrichment into an unreviewed consolidation path.
5. **Use the existing Knowledge model configuration.** Disclose the resolved
   model/profile, payload scope, estimated size, and cost/privacy implications
   before requesting cleanup. Do not add another model setting in v1.
6. **Ledger cleanup sends only the ledger and minimal identity context.** No
   full-chat re-analysis, unrelated private dossier fields, or recovery originals
   enter its model request. Treat stored text as untrusted data.
7. **Condensation and pruning are distinct.** The model may suggest pruning, but
   every original remains represented until the user explicitly removes it.
   No preselected deletion, hidden omission stage, or “apply all pruning.”
8. **Source coverage is mandatory but is not a semantic proof.** Every original
   is retained, mapped into a proposed record, or explicitly removed by the user.
   Summaries must expose specificity tradeoffs, not advertise lossless compression.
9. **Application is separate from ordinary approval.** Cleanup proposals cannot
   enter auto-approval or generic bulk acceptance. Generation and editing never
   modify the live entry. Revalidate the final user-edited proposal before Apply.
10. **Fail closed on stale, ambiguous, or unsafe input.** Bind the operation to
    chat scope/epoch, resolved book, stable entity, entry UID, and exact source
    content. Recheck at commit, including after asynchronous recovery work.
11. **Recovery is a launch requirement.** Persist the exact pre-cleanup original
    durably before replacement; a failure blocks Apply. Ordinary history is not
    sufficient. Restore must preserve newer work and show conflicts.
12. **Refusal is acceptable; silent clipping is not.** Budget both input and
    output, including mappings and suggestions. Automatic chunking is deferred.
    Reject repaired or truncated cleanup JSON rather than presenting it as valid.

## 3. Current code and reuse boundaries

All locations below are absolute paths in the working repository. New modules
listed later are proposed seams, not existing APIs.

| Location | Implementation relevance |
| --- | --- |
| `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/prompts.js` | Scan, update, enrichment, and selected-field refresh prompts. Enrichment now requests new knowledge only; other field wording still needs alignment. |
| `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/lorebook.js` | Formatters, ledger append logic, dossier merge, model calls, identity-verified loads, and writes. Existing general merge helpers are not automatically safe ledger replacement helpers. |
| `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/field_ownership.js` | Shared Growth ownership filter. It does not globally forbid Canon Lock updates; do not broaden that authority as an incidental change. |
| `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/render.js` and `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/staging.js` | Existing review and field-picker patterns. Reuse presentation where suitable, not automatic/bulk acceptance routes. |
| `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/identity.js` and `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/reconcile.js` | Stable entity IDs and UID/identity reconciliation. Display names alone cannot identify cleanup destinations. |
| `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/core/scope.js`, `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/core/revision.js`, and `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/core/coordinator.js` | Existing scope/epoch, revision, cancellation, and coordinated-generation primitives. |
| `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/store.js` | Hydration/schema protections, embedded store projection, immediate book saves, and dirty-state handling. |
| `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/backup/data.js`, `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/backup/collect.js`, `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/backup/restore.js`, and `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/backup/recovery.js` | Evaluate versioned backup/export and recovery conventions. Existing quarantine recovery is not a cleanup undo facility. |
| `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/core/api.js` | Known truncation rejection and lenient JSON repair. Cleanup needs strict parsing without changing other consumers' repair behavior. |

Important reuse limits:

- `pushHistory` keeps at most 50 localStorage snapshots and swallows write
  failures. It cannot satisfy fail-closed cleanup recovery.
- `buildUpdatedDossierContent` appends knowledge and can normalize headers and
  line endings. Do not use it to claim byte-for-byte ledger-only replacement.
- `runDossierFieldRefresh` already selects fields and excludes Canon Lock and
  Growth-owned Personality, but reads recent messages and does not implement
  per-field cleanup decisions or displaced-detail notes. Cleanup must additionally
  exclude Image Tags and managed relationships.

## 4. Delivery sequence

| Phase | Outcome | Depends on | Release role |
| --- | --- | --- | --- |
| 0 | Baselines and closed design gates | — | Required before implementation |
| 1 | Shared field discipline and concise future capture | 0 | Initial release |
| 2 | Pure ledger parsing, proposals, coverage, and detail warnings | 0 | Initial release |
| 3 | Durable recovery and guarded apply/restore service | 0, 2 | Initial release |
| 4 | Explicit single-NPC ledger review UI | 2, 3 | Initial release |
| 5 | Large-entry, host, and release validation | 1–4 | Initial release gate |
| 6 | Selected-field cleanup, preferably reusing Fields UI | 1, 3, 4 | Follow-up unless independently ready |

Phases 1 and 2 may proceed independently after Phase 0. Pure proposal work may
land before the write/UI work, but do not expose an Apply action before recovery
and commit safety are complete. Each implementation change lands with its tests.

### Phase 0 — Baselines, fixtures, and design decisions

**Purpose:** Make the remaining choices explicit and capture failures before
changing generation or persistence.

Work:

- Inventory every model-driven field/ledger mutation: compact and dossier scans,
  staged scan enrichment, single-NPC updates, Enrich, selected-field refresh,
  formatters, and acceptance paths. Record where shared validation must run.
- Add reusable fixtures covering the reported Role, unknown Role, an enduring
  relationship role, becoming mayor, and temporary tasks that should not change
  Role or inflate Current Agenda.
- Add ledgers with duplicate and overlapping observations, mixed provenance,
  rumor, corrections, meaningful dates, another person's promise, legacy own-plan
  lines, gate code `7314`, and technical details that remain useful knowledge.
- Add CRLF/LF, trailing newline, managed relationship blocks, empty placeholders,
  compact entries, duplicate/missing ledger headings, and malformed boundaries.
  Decide supported formats; explicitly refuse unsupported/ambiguous ones.
- Build a synthetic representative entry around the reported 15,000-token size
  and a deliberately oversized one. Record estimator/model/configuration used;
  user-reported sizes are not measured project benchmarks.

**Decisions to record before leaving this phase:**

1. Recovery storage, schema versioning, verified persistence, and failure behavior.
   First evaluate a dedicated non-injected recovery container using existing
   lorebook-store infrastructure. Do not assume it is suitable: demonstrate that
   originals never enter any prompt/injection projection, survive reload, and are
   exportable. If unsuitable, document an alternative and its portability before
   implementing it; no new storage dependency is assumed by this plan.
2. Retention policy and user controls. Proposed v1 default: no silent age/count
   eviction of cleanup originals; show storage usage, export, and explicit deletion
   with consequences stated. Quota/capacity exhaustion blocks new cleanup rather
   than discarding recovery. Define handling of deleted/renamed entities/books.
3. Backup behavior. Include recovery in the versioned unified backup if compatible;
   otherwise provide a clearly labeled versioned recovery export/import with
   validation. Launch requires a tested round trip, not an export-only promise.
4. Generous per-field validation bounds and a documented request-capacity policy,
   including unknown provider context limits and output overhead. Unknown capacity
   must be disclosed; do not advertise guessed limits as provider-verified.
5. Field-refresh reuse assessment: list the changes needed for a separate
   entry-only cleanup mode and whether Phase 6 joins the initial release.

**Exit gate:** Baseline fixtures, writer inventory, and these decisions are
recorded in this document or a named decision record. No recovery/capacity choice
is left implicit for the implementation author.

### Phase 1 — Shared prevention contract

**Purpose:** Stop future drift without bulk-rewriting existing entries.

Work:

- Introduce one shared field contract, preferably a pure module at
  `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/field_contract.js`.
  Cover Descriptor, Tone, Perceived as, and all applicable dossier fields; do not
  restrict the contract to the existing dossier-field picker list.
- Use it consistently in scan/update/enrichment/refresh prompt construction and
  at the mutation seams identified in Phase 0. Remove scene-duty Role wording and
  reconcile “fill every field” inference instructions with grounded unknowns.
- Require meaningful field-specific change, concise current values rather than
  appended event clauses, and durable ledger takeaways rather than retellings.
- Validate type, structure, and generous size bounds before merging or formatting.
  Reject section/header injection and malformed values without silently slicing.
  Existing entries keep their old value; new entries use their unknown/empty
  convention. Surface a field-specific reason and retain unrelated valid updates.
- Preserve existing Growth/secret lifecycle behavior and ownership. This phase
  does not redesign Canon Lock authority or prune legacy plan-shaped ledger lines.
- Keep retries bounded and disclosed; no extra unbounded paid correction loop.
  Do not promise semantic deduplication against ledger text absent from a bounded
  ordinary-generation context projection.

**Validation:** Extend prompt and merger tests, including
`c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/test/knowledge_ledger_prompt.test.js`,
`c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/test/knowledge_scan_ledger.test.js`, and
`c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/test/dossier_field_refresh.test.js`.
Test every inventoried path, overlong/structured values, unchanged stable fields,
and the v2.12.1 append-only enrichment contract.

**Exit gate:** No upgrade rewrite or new automatic cleanup; invalid proposals
cannot corrupt entry structure; configured-model samples demonstrate the Role
and concise-capture behavior. Prompt-string assertions alone are insufficient.

### Phase 2 — Ledger-only proposal contract and pure validation

**Purpose:** Define exactly what can be reviewed and applied before adding writes.

Work:

- Add pure parsing/patching and proposal validation, with seams such as
  `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/knowledge/ledger_cleanup.js`.
  Preserve raw source spans and line endings; replace only the unambiguously
  identified ledger body. Do not rebuild the entire entry through a formatter.
- Assign review-local source IDs from the captured revision; retain each original's
  exact text and order. IDs must not silently carry across a regenerated source.
- Define a versioned proposal with proposed records, original source IDs per
  record, advisory pruning suggestions with exact affected sources/reasons, and
  explanation/specificity notes. New records must have known source IDs; reject
  unknown IDs, missing coverage, contradictory ownership, and malformed mappings.
- Initially assign each source to one proposed record; merged records may own
  multiple sources. If a source must split, require an explicit supported mapping
  rather than duplicating ownership accidentally. “Keep these originals” replaces
  the corresponding proposal and restores their exact text in source order.
- Represent explicit user removals separately from model suggestions. A model
  cannot create an approved removal. Recompute coverage after every edit, keep,
  removal, or restore decision; never infer user consent from an absent line.
- Keep editing source-aware: record text edits retain their mappings. If a full
  text editor is offered, unresolved record/mapping changes block Apply until
  reconciled; editing cannot bypass source accounting.
- Compute advisory “detail not retained” warnings by comparing merged sources
  with proposed text: numbers/codes/dates and candidate names or identifiers.
  Use a conservative documented heuristic for names; expect false positives.
  Recompute after edits. Warnings do not prove factual equivalence or authorize
  deletion, and lexical preservation does not prove a claim stayed unchanged.
- Preserve provenance, attribution, uncertainty, chronology, and correction
  distinctions. When a safe merge is unsupported, keep records separate. Legacy
  questionable records stay represented and receive advisory flags.
- Use strict JSON parsing for cleanup after any explicitly permitted wrapper
  normalization. Do not use truncation repair or change shared lenient parsing
  for other workflows. Validate complete coverage even when JSON parses cleanly.

**Exit gate:** Pure tests cover malformed/truncated/repaired output, unknown or
missing sources, user removals, keep-original behavior, edited warnings, gate-code
loss, prompt-injection text, and boundary refusal. Applying a valid ledger patch
leaves every non-ledger byte unchanged, including managed relationship blocks.

### Phase 3 — Durable recovery and guarded commits

**Purpose:** Make Apply and Restore honest, recoverable operations.

Work:

- Implement the Phase 0 recovery decision with schema validation and explicit
  statuses: original saved, application pending, applied, failed, or outcome
  uncertain. Store action ID, timestamp, identity bindings, exact original,
  approved replacement/fingerprint, and action type. Keep recovery out of context.
- Provide a dedicated cleanup commit service, not a generic staging acceptance
  shortcut. Require explicit user approval tied to the final validated draft.
- Capture scope/epoch, resolved book, stable entity ID, UID, and original content
  before generation. At Apply, re-read and verify hydration/schema status,
  identity, unique destination, boundaries, revision, coverage, and ownership.
- Persist and verify the original before mutating the target. Recheck destination
  and source after that asynchronous step. Use existing coordinated/serialized
  write patterns and immediate persistence; make the final guard/write interval
  explicit. Audit overlapping writers and acknowledge host external-write limits
  rather than pretending a read-then-write is server-side compare-and-swap.
- Preserve the latest loaded book's unrelated entries and embedded store. Do not
  write a whole-book snapshot retained from generation time.
- Surface save failures; preserve recovery and the edited proposal. Reconcile
  ambiguous outcomes by reloading before retrying, so a retry cannot duplicate
  an operation or blindly roll back newer work. Mark success only after the
  persistence contract succeeds; test false/error/throw behavior where applicable.
- Implement restore preview for only the cleanup-owned span/fields. If current
  values match the applied replacement, restore those originals while preserving
  newer unrelated edits. If touched values changed, show a conflict and refuse
  blind overwrite; offer export/manual reconciliation. Validate scope/identity
  and save a recovery copy of the current content before a restore write.
- Add visible recovery listing, restore/export/import, and retention controls;
  recovery must remain available after closing review or reloading the host.

**Exit gate:** Integration tests prove storage failure blocks target mutation;
scope switches, stale data, rename/merge mismatches, deletion, and ambiguous UIDs
cannot write. Test failures before/after recovery persistence and during target
save, reload reconciliation, duplicate Apply, recovery round trips, and restore
with both newer unrelated work and touched-field conflicts.

### Phase 4 — Single-NPC ledger review UI and request orchestration

**Purpose:** Make review substantially easier than manually auditing a huge diff.

Work:

- Add **Review / condense knowledge** for one eligible NPC, clearly separate from
  Enrich and field cleanup. Explain unsupported/empty entries without rewriting.
- Before the request, disclose model/profile, transmitted data, estimated ledger
  and whole-entry size, output allowance, and privacy/cost. Budget the complete
  request and response envelope; refuse known excess without clipping. State what
  configuration change could help. The current 8,000-token Knowledge default is
  not evidence that a 15,000-token source can produce a complete mapped result.
- Run through the existing coordinator/cancellation conventions. Generation has
  no live-entry write and never submits to normal auto-approval/bulk acceptance.
- Show each proposed record beside expandable original records, merge explanation,
  “keep these originals,” mapped editing, and advisory pruning/detail-loss notes.
  Duplication claims must identify the matching source or field, not just assert it.
- Offer a supplementary original/proposed diff and ledger/whole-entry size
  comparisons. Label token estimates accurately; show size growth honestly and
  do not force a compression percentage.
- Keep Apply disabled until final validation succeeds and the user explicitly
  confirms. No suggested pruning deletion is preselected. Cancel changes nothing.
- On stale source or failed save, retain the user's edited draft. Offer draft
  export and regeneration without automatically rebasing or discarding edits.
  On scope change, detach/close the active review so it cannot target the new chat;
  any retained draft remains bound to its origin and is not model context.
- Use shared modal lifecycle, escaped rendering, keyboard navigation, labeled
  controls, focus restore, and accessible progress/error announcements. Expose
  recovery controls as part of this feature, not only through a console command.

**Exit gate:** DOM/handler tests cover explicit invocation, payload minimization,
cancel, keyboard review, source decisions, no auto/bulk acceptance, stale draft
preservation, duplicate clicks, and truthful save status. Manually verify the
complete host flow, not only isolated rendering helpers.

### Phase 5 — Representative-size validation and initial release gate

**Purpose:** Demonstrate utility for the long-session users who motivated this work.

Work and evidence:

- Run a successful complete cleanup of a representative roughly 15,000-token
  entry using a documented supported configuration. Record model/profile, source
  size, input/output allowance, response size, mapping overhead, and result.
  Include a high-distinct-fact case that cannot safely shrink much.
- Test known oversize refusal, insufficient output allowance, explicit provider
  truncation, and profile responses without finish metadata. Parse repair must
  never turn a partial ledger into a successful preview.
- Compare original/proposed ledger and whole-entry sizes, factual fidelity,
  detail warnings, merge decisions, and reviewer effort. Report limitations;
  no promised reduction percentage or automated semantic-preservation claim.
- Use synthetic examples by default and anonymized user examples only with
  consent. Manually inspect provenance, codes, names, dates, corrections, and
  unsupported expertise claims in actual configured-model responses.
- Exercise concurrent ordinary updates, manual edits, scope switch during model
  generation and recovery save, rename/merge/delete, reload, quota/storage errors,
  target-save errors, recovery export/import, and conflicted restore in the host.
- Run focused suites, then `npm test` and `npm run lint` from
  `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker`.
- Update user-facing instructions and release notes with explicit consent,
  model cost/privacy, supported size/configuration, recovery location/retention,
  restore conflicts, and the distinction between condensation and pruning.

**Release gate:** Phases 1–4 pass their exit criteria; the representative-size
success, deliberate refusals, recovery round trip, and keyboard host review are
recorded. Automated tests cannot substitute for model fidelity or host QA. If the
representative case only refuses, ledger cleanup is not ready for its target use.

### Phase 6 — Reviewed existing-field cleanup

**Purpose:** Clean selected stored fields without refreshing from recent activity
or rewriting the ledger.

Work:

- Prefer extending the existing Fields picker/review presentation with a clearly
  named **Review field cleanup** mode. Keep ordinary recent-message refresh intact;
  the cleanup mode reads the entry only by default and has separate semantics.
- Explicitly select eligible fields. Reuse ownership checks and additionally
  exclude Canon Lock, Image Tags, managed relationships, and Growth-owned content.
  Recheck ownership at Apply, since it can change after proposal generation.
- Show original/proposed values, explanation, and displaced-detail notes for each
  field. Require keep-original/edit/accept per field with no preselected acceptance.
  Refuse unsupported ambiguous rewrites rather than inventing missing context.
- Do not relocate displaced details into the ledger, Current Agenda, Canon Lock,
  or other fields. Suggested destinations are notes only; duplication claims must
  locate a match. Preserve existing secret tiers/lifecycle, not infer disclosure.
- Reuse Phase 3 recovery and guarded commit service with selected-field patches.
  Preserve unselected text and the entire ledger exactly; do not pass cleanup
  through general-purpose dossier normalization without byte-preservation tests.

**Exit gate:** Selected/unselected/protected field tests, changed ownership,
entry-only payload tests, per-field decisions, ambiguity notes, cancel/stale/error
paths, and recovery/restore tests pass. Host QA confirms users can clean Role
without touching knowledge and condense knowledge without touching Role.

## 5. Suggested test organization

Add focused suites as the seams become real; these are proposed files, not tests
that already exist:

- `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/test/fixtures/knowledge_concision.js`
  — source fixtures, malformed boundaries, and representative-size builders.
- `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/test/knowledge_field_contract.test.js`
  — shared contract, bounds, and mutation-path integration.
- `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/test/knowledge_ledger_cleanup.test.js`
  — raw spans, proposals, coverage, manual removals, and detail warnings.
- `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/test/knowledge_cleanup_recovery.test.js`
  — persistence failures, retention, reload, export/import, and restore conflicts.
- `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/test/knowledge_cleanup_commit.test.js`
  — identity/scope/revision races and guarded writes using fake world-info storage.
- `c:/Users/brase/Desktop/extensions_wip/merged_world_tracker/test/knowledge_cleanup_review.test.js`
  — source-aware review, consent, stale drafts, and keyboard/DOM contracts.

Follow existing Vitest, host-stub, and opt-in jsdom conventions. Retain existing
ledger append, Growth ownership, scope, hydration, backup, and modal regressions.
Add field-cleanup-specific tests in Phase 6 rather than claiming ordinary refresh
coverage proves the new workflow safe.

## 6. Explicit exclusions

No scheduled compression, automatic deletion, batch lorebook rewrites, aggressive
size targets, full-chat re-analysis, automatic chunking, new retrieval system,
relationship redesign, Growth evidence consolidation, or broader secret/Canon
Lock authority changes. No store migration rewrites existing NPC prose.

## 7. Implementation tracking

- [ ] Phase 0 — baselines and decisions recorded
- [ ] Phase 1 — prevention contract and regression coverage
- [ ] Phase 2 — pure ledger proposals and validation
- [ ] Phase 3 — durable recovery and guarded apply/restore
- [ ] Phase 4 — explicit ledger review UI
- [ ] Phase 5 — representative-size/model/host validation and initial release
- [ ] Phase 6 — selected-field cleanup and its independent release gate

When a phase lands, record its date, changed seams, automated results, remaining
manual QA, and any accepted deviation here. Do not mark a phase complete solely
because its prompt or UI exists.