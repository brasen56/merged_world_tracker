# VectFox ↔ MWT Integration: Revised Phase Plan

Status: proposed revision for discussion

Based on `vectfox-mwt-phases.md` and a review of the current VectFox and MWT source. This document proposes the implementation boundaries; API names and shapes below remain provisional.

## Goal

Let users and MWT draw on VectFox's EventBase history through a small public API:

- Users can ask questions such as “How did Alex meet Ranger?” and receive answers with inspectable evidence.
- MWT dossier refresh can use relevant older history alongside recent messages.
- Growth can locate promising historical scenes, then capture behavioral evidence from their original messages.
- Later, MWT can propose Knowledge Ledger additions from events that explicitly establish what an NPC learned.

The shared foundation is structured event retrieval and reliable source references. Each consumer decides how to interpret and present that evidence.

## Ownership and boundaries

| VectFox owns | MWT owns |
|---|---|
| Event extraction, storage, retrieval | Dossiers, behavioral evidence, Knowledge Ledgers |
| Event provenance and source resolution | Profile generation and field rules |
| Its character roster and event chronology | Its NPC identities, aliases, and canon protections |
| Ask the Story UI and answer generation | Review, Accept, and lorebook writes |

The integration API returns structured records: stored event summaries, provenance, coverage information, and original-message snapshots when available. It does not generate answers or profiles as a side effect of an MWT history request. MWT does not query Qdrant or reach into VectFox UI or private modules.

Each extension remains usable independently. Missing, disabled, loading, and unsupported integration states are distinguishable from a successful search with no matches.

## Recommended delivery order

**Phase 0 → Phase 3 → Phase 1 → Phase 2 → Phase 4.**

Keep the original phase numbers for comparison. Bring Ask the Story forward because it directly addresses the original user need and exercises retrieval, chronology, citations, and coverage reporting before those results influence stored character information.

## Non-goals for the initial releases

- VectFox writing directly to MWT lorebooks.
- Replacing Growth's original-message evidence capture with event summaries.
- Injecting Ask the Story answers into roleplay context automatically.
- Removing either extension's existing NPC cards or dossiers.
- Automatically combining alternate story branches.
- Replacing MWT's scanner before the replacement covers its relevant responsibilities.

---

## Phase 0: Public event and source API — VectFox

This establishes the contract used by every later phase. History retrieval and source resolution make no generation calls. Semantic search can require embedding requests; query planning belongs to the explicitly enabled Ask workflow in Phase 3.

### Delivery split

Deliver Phase 0 in two parts so Phase 3 does not wait on the hardest piece:

- **0a: Status and history.** `getStatus()` and `findEvents()` for the current chat, with event citations and source references marked `unresolved` where resolution is not yet implemented.
- **0b: Source resolution.** `resolveSources()` and verified source statuses, including ILS originals, edits, swipes, deletions, and duplicates.

Phase 3 can begin on 0a, since an unresolved reference remains inspectable as an event citation. Phases 1 and 2 begin after 0b, because they act on stored character information and original messages.

### Proposed surface

```js
window.VectFoxAPI = {
  version: 1,
  getStatus(),
  findEvents(request),
  resolveSources(request),
};
```

`getStatus()` reports readiness, available capabilities, effective collections, and a scope token. Capabilities distinguish history retrieval, semantic search, and original-source resolution. Report a reason when a capability is unavailable.

`findEvents()` accepts:

```js
{
  subjects: [
    { name: 'Alex', aliases: [] },
    { name: 'Ranger', aliases: [] },
  ],
  match: 'all', // 'all' or 'any' subjects; aliases within a subject are alternatives
  types: [],
  question: '',
  mode: 'history', // 'history' or 'question'
  scope: { kind: 'current_chat' },
  limit: 100,
}
```

An explicitly selected-collections scope is also supported. All requests and limits are validated and bounded. Subject names and aliases are resolved against VectFox's roster; ambiguous matches are reported. MWT entity IDs remain MWT-owned and are not assumed to be VectFox roster IDs.

Each returned event includes:

- An opaque event reference, event ID, collection ID, and source chat ID when known.
- Summary, event type, importance, cause, result, characters, and locations.
- Available story-time fields and source-order fields, without inventing missing dates.
- Remaining threads, closed threads, resolution references, and fully resolved status from the continuity view.
- Source references and source-verification status.

The response also includes a scope token and coverage information: collections searched, matched and returned counts where known, truncation, sampling, and unavailable portions. An unsupported backend is not reported as an empty archive.

`resolveSources()` accepts scoped source references and returns read-only original-message snapshots where they can be resolved. An unresolved reference remains inspectable as an event citation; it does not acquire a fabricated original-message link.

### History and question behavior

- **History:** retrieve events by resolved subjects and requested types, without an embedding or generation call. Do not apply chat-injection importance floors or recency suppression.
- **Question:** semantic and structured search under the research policy defined in Phase 3. No planner is invoked implicitly by a history request.
- Preserve ordering within each source chat. Cross-chat chronology requires usable story dates or an explicit chapter order; unrelated message indices do not establish a shared timeline.
- Backend support follows capabilities. The standard backend's native hashes-only listing cannot supply the roster and provenance needed here. Metadata-capable configurations may support history retrieval; advertise only what is available.

### Source resolution

Current events store source message positions in ILS-expanded coordinates and message hashes. `prepareMessagesForEventBase(...).sourceIndices` helps locate the visible container, but it is not a stable message identity after edits, deletions, or changes to summarized history.

Each source reference must distinguish:

- Its source chat and collection.
- The original leaf message and its visible container, if different.
- The host's own message identifiers (`id`, `extra.mesid`) when present, returned read-only.
- The stored content fingerprint and the currently resolved content fingerprint.
- Whether it came from a recovered ILS original.
- A resolution status: `verified`, `changed`, `missing`, or `unresolved`, with a reason where useful.

Indices are location hints. A source is verified only when identity/content resolution establishes the match. Multiple originals beneath one summary must remain distinguishable. Identical text alone must not silently resolve an ambiguous duplicate.

Stored `source_message_hashes` are a 32-bit djb2 hash of the raw `name:mes` text, including tracker and other non-narrative blocks (`core/eventbase-extractor.js:436`). Two consequences:

- An edit confined to a non-narrative block reports the source as `changed` although the narrative is unchanged.
- A 32-bit hash can collide, so it cannot by itself prove a match.

The API therefore adds its own fingerprint, computed over normalized narrative text with a stronger hash, for newly extracted events and for resolved snapshots. Legacy hashes remain usable as a location aid, but a legacy hash match alone is not sufficient for `verified`.

VectFox never creates MWT receipt UUIDs. If MWT needs to assign one, it uses its own authoritative message/persistence path; mutating an API snapshot is insufficient.

VectFox also does not read MWT's private identity storage (`extra.mwt_uuid`) or reproduce MWT's identity precedence. Doing so would make VectFox depend on MWT internals, the reverse of the ownership boundary. The API returns host identifiers, location hints, and fingerprints; MWT maps those to its own receipt identities. If a shared identity becomes necessary later, MWT can register a resolver through the API rather than VectFox reading MWT fields.

Cross-chat events are resolved against their own chat. When its originals are unavailable, return `unresolved`; never map their positions into the currently loaded chat.

In API version 1, sources from any chat other than the currently loaded one are always returned as `unresolved`. Resolving them would require loading other chat files from the server, which adds cost, latency, and its own consistency questions. Cross-chat resolution can be added in a later version, advertised as a separate capability.

The current roster projection drops `source_message_ids` and `source_message_hashes`, as well as some full event fields. Preserve the required fields or load full records after candidate selection.

Source references initially identify extraction windows. They do not claim that an individual sentence has already been matched to an exact supporting quotation.

### Lifecycle

Expose readiness/scope-change notifications through the host event bus. Consumers also inspect current status when connecting, so they do not depend on catching a one-time event.

Capture chat identity, collection selection, and relevant revisions before asynchronous work. Recheck before returning or using results. Chat switches, collection-lock changes, and relevant content edits invalidate stale work. MWT also retains its existing scope, revision, and store-write guards.

### Done when

- Tests cover live messages, nested ILS originals, several originals beneath one summary, shifted indices, edits, swipes, deletions, duplicate content, and missing originals.
- Cross-chat references never resolve against current-chat messages.
- Subject matching distinguishes aliases of one person from two separate people.
- History retrieval returns the expected event set and order independently of injection settings.
- Disabled, loading, unsupported, empty, and partially available states behave distinctly.
- Switching scope during a pending request cannot return usable stale results.

---

## Phase 3: Ask the Story — VectFox

### User-facing behavior

Add an Ask panel beside Debug Query. Users enter a question, inspect the selected story scope, and receive an answer or timeline with expandable citations. Keep Debug Query available for retrieval diagnostics.

Initial actions are Ask, inspect evidence, and Copy. Saving answers to lorebooks and injecting them into context are deferred.

### Research workflow

1. Resolve subjects against the roster, surfacing meaningful ambiguity.
2. Retrieve relevant events through the public research service.
3. Expand around relevant events when nearby context is needed, within a fixed budget.
4. Select evidence appropriate to the question and preserve useful chronology.
5. Make one bounded answer-generation call through the existing provider and rate limiter.

Optional deeper research may add a bounded planning call and targeted searches. Its cost and scope are explicit. The planner receives the research question and selected evidence; unrelated current-scene context must not redirect the question.

### Research-specific retrieval policy

Reuse retrieval components with explicit research settings. Do not inherit the normal injection pipeline unchanged:

- Disable recent-context suppression.
- Avoid recency and importance preferences that hide foundational interactions.
- Include resolved events when answering historical questions.
- Preserve duplicate-event handling while retaining genuinely distinct similar interactions.
- Apply research-specific candidate and evidence limits, rather than silently using injection Top-K.
- Use chronological coverage for timelines and remaining-thread state for unresolved-obligation questions.

Spine sampling is a bounded fallback for broad histories. Report when sampling or truncation limits the answer. Protect question-relevant evidence before using a generic history sample.

### Answer and citation contract

Return structured claims, for example `{ sentence, event_refs }`, then validate their shape, bounds, and references against the evidence actually shown to the model.

Reusing the NPC-card validation approach is useful, but an existing citation ID does not prove that the event supports the claim. Require conservative, evidence-based wording and make cited summaries inspectable. Original-message links are offered only when resolved; ILS citations can open the recovered original rather than pretending it is a separate visible message.

Distinguish:

- No relevant evidence found in the searched records.
- Partial evidence, with a stated gap.
- A limited search caused by sampling, truncation, or unavailable sources.
- A failed or malformed model response.

#### Failure diagnostics (implemented)

- Failures identify retrieval, provider, malformed JSON/answer structure, invalid citations, or output truncation. The underlying error detail remains visible.
- When retrieval succeeds but generation or validation fails, retain the bounded evidence, coverage, and available original-message inspections. Reject all generated claims; do not present failed output as an answer. Copy includes failure details, evidence references, stored records, and coverage.
- Cancellation, disablement, and scope changes still invalidate results; retained evidence must never bypass those safeguards.
- Ask requests JSON-object output through the existing provider helper, while retaining local structure, size, and citation validation. Unsupported endpoint/model controls surface as provider errors; there are no automatic retries.
- Coverage reports explicit counts for unknown-source-chat exclusions, other-chat exclusions, and active duplicates. Selected archives may instead include unknown-source entries, which are disclosed as included with unverified provenance. Counts describe the retrieved candidate pool, not unseen records beyond collection/search limits.

An earliest shared event is not automatically a first meeting. Say “earliest recorded interaction” unless the evidence establishes a meeting. Do not infer causation solely from chronological proximity.

### Settings and cost

Off by default and manually invoked. Show the selected model and scope. Bound planning, searches, evidence size, output length, retries, and total generation calls. Support cancellation through the normal request lifecycle.

### Done when

- A meeting fixture produces a sourced sequence while an earlier co-mention is not mistaken for the meeting.
- Explicitly requested old or resolved events remain retrievable under aggressive injection settings.
- Unsupported questions produce an appropriately limited answer without invented connecting events.
- Sampled histories disclose their coverage limits.
- Citations resolve correctly for live messages, ILS originals, and unavailable cross-chat originals.
- The total call cap includes planning and retries.

---

## Phase 1: Dossier field refresh with history — MWT

### Change

Add an optional “Include VectFox history” choice to selected-field refresh. Display the actual scope and selected event count. Default to current-chat history; additional collections require explicit selection as part of the same story continuity.

Retrieve history using the NPC's canonical name and aliases as one subject. Add a separately bounded `<history_events>` block to the existing refresh request. No separate MWT generation pass is required.

### Field selection

Use event types as ranking hints, with selection governed by the existing field contract:

| Field | Useful evidence | Required distinction |
|---|---|---|
| Background | Introductions, revelations, defining events, lasting consequences | Relevant revelations may occur late |
| Role | Established occupations, responsibilities, faction or state changes | A recent task does not establish an enduring role |
| Where to Find | Established bases and reliable routines | Travel and temporary presence do not establish a usual location |
| Read on PC | Interactions and relationship changes involving the PC | Describe supported current stance, not an interaction log |
| Current Agenda | Goals and constraints supported by remaining unresolved threads | A promise or open thread does not automatically define the NPC's agenda |
| Secrets | Deferred pending an adequate knowledge/privacy model | A fact being recorded does not establish who knows it |

Appearance, Voice, Image Tags, Personality, and Canon Lock keep their existing behavior in this phase. “No history input” does not disable their existing refresh paths or ownership rules.

Use the continuity view's remaining threads and supporting resolution references. A partially resolved event must not reactivate a closed obligation.

### Evidence precedence and review

- Explicit user canon and protected fields retain their authority.
- Recent direct evidence can establish changes to earlier state.
- Previously generated dossier text is not automatically canon and can be corrected by supported evidence.
- Historical summaries are evidence, never instructions or behavioral quote receipts.

Preserve the existing staging, diff, field validation, and Accept workflow. Keep supporting event references with the proposal for review without filling lorebook fields with citation machinery. Recheck scope, source validity, NPC identity, and relevant entry revision before applying a proposal.

### Done when

- With the integration off or unavailable, the existing refresh prompt and behavior are preserved.
- History selection respects its budget and requested field meanings.
- Early history can fill Background; later evidence can correct stale generated content.
- Temporary travel does not replace an established home or routine.
- Closed parts of partially resolved events do not return as current agenda.
- Canon protections and staging remain effective.

---

## Phase 2: Targeted Growth capture — MWT

### Change

Add a separate Targeted Capture action alongside Catch Up. Catch Up keeps its existing chronological behavior and watermarks.

VectFox proposes promising source windows based on relevant events, behavior-heavy types, importance, and temporal coverage. Avoid spending the entire budget on several overlapping high-event-count windows. Event summaries select scenes; they do not become Growth observations.

Extend the API with bounded candidate-window retrieval. Results contain source references, event references, ranking information, scope tokens, and availability status. Bare start/end positions are insufficient identifiers.

### Shared original-message capture

Refactor a shared capture-and-verification helper that accepts the actual source messages and their references. Use it from ordinary capture, ILS backfill, and targeted capture while preserving their existing behavior.

The ordinary `captureEvidence()` currently verifies against visible chat, while backfill also searches recovered originals. Targeted capture cannot simply pass expanded text to the ordinary function unchanged.

Verification must resolve observations to the actual permitted source messages, preserving original identity and timestamp. Do not use a summary container's index or timestamp as if it belonged to the original. Unavailable originals are skipped or reported as unavailable, not substituted with summaries.

### Coverage and persistence

Track successfully processed content using source chat, NPC identity, original-message identities or unambiguous fallback references, and content fingerprints.

- Unchanged, successfully processed content is not charged again by targeted capture.
- Failed or cancelled work remains retryable.
- Edited content can be reconsidered.
- Successful processing with zero observations can still record coverage.
- Commit coverage together with the evidence result so failed writes do not mark work complete.
- Targeted coverage does not advance `lastCaptureTs` or `lastBackfillTs`.

Overlapping candidates are merged or reduced before calling the model, with bounded surrounding context. Existing observation deduplication remains in effect when Catch Up later reaches the same material.

Bound windows, messages, input size, and total API calls, including retries. Show the planned work before starting and support cancellation.

### Done when

- Quotes from recovered originals verify through the same rules as backfill.
- Successful unchanged content is skipped on repeat runs; failures retry and edits are eligible again.
- Overlapping candidates do not repeatedly spend the same evidence budget.
- Cancellation, scope changes, and refused commits leave coverage consistent.
- Chronological watermarks remain unchanged.
- Representative long-chat comparisons record verified observations, useful coverage, calls, and token usage against Catch Up. Fewer observations or repeated variants are not counted as an efficiency improvement.

---

## Phase 4: Fact-specific knowledge acquisition, then ledger proposals

### Why this remains last

An event's character list mixes participants and mentions. Even confirmed presence does not establish knowledge of every fact in its summary.

Example: Ranger sees Alex deliver a sealed letter containing the king's confession. Ranger can know the delivery occurred without knowing the contents.

### 4a: Extend VectFox extraction

Add optional presence and fact-specific knowledge records. The exact schema should be agreed before extraction changes, but each acquisition must identify:

- The character who learned something.
- The particular fact or claim they learned.
- How they learned it: witnessed, told, document, rumor, institutional access, or another supported basis.
- Supporting source references and any stated uncertainty.

“Ranger heard a rumor that X” is distinct from “X is established.” Neither general presence nor institutional affiliation automatically grants knowledge. Off-screen material grants knowledge only when the text establishes that acquisition.

Version and validate the new fields consistently across extraction, storage, public API records, and import. Legacy events remain usable history with unknown knowledge attribution; do not infer witnesses retroactively from `characters`.

Apply the schema to new extractions by default. Offer an explicitly scoped backfill/re-extraction option later, preserving existing user edits, continuity links, and the ability to review changes.

### 4b: MWT ledger proposals

Offer an Import from VectFox proposal per NPC. Map only that NPC's supported fact-specific acquisitions into candidate ledger items, retaining provenance and deduplicating against accepted knowledge.

Use the existing field contract, review, and Accept path. Facts, beliefs, and rumors must retain their meaning through that mapping. If the current ledger format cannot preserve a required distinction, extend its contract or defer that item.

After representative comparisons establish adequate coverage, consider suppressing redundant ledger extraction work. Do not skip MWT's entire scanner merely because VectFox is present; NPC discovery and other outputs need separate accounting.

### Done when

- Fixtures cover sealed information, mention-only characters, off-screen scenes, lies, rumors, and partial disclosure.
- A character receives only the specific knowledge the source supports.
- Legacy events with no acquisition records cannot silently populate ledgers.
- Imported proposals retain source and uncertainty distinctions through review and persistence.
- Side-by-side evaluation records both correct additions and missed knowledge before any extraction replacement is enabled.

---

## Cross-cutting requirements

### Compatibility

MWT checks API version and capabilities. Breaking contract changes require a version bump. API results are snapshots, not mutable handles into another extension's state. Structured failures distinguish unavailable features from empty results.

New persisted targeted-coverage fields participate in MWT's schema validation, backup/restore, and existing write guards. API scope tokens supplement rather than replace MWT's current safety checks.

### Cost accounting

| Operation | Expected cost behavior |
|---|---|
| History retrieval and source resolution | Database/local reads; no generation or embedding calls |
| Semantic search | May require embedding requests |
| Dossier history refresh | Existing generation call receives a larger, bounded input |
| Targeted Growth capture | Explicit additional MWT capture calls, capped per run |
| Ask the Story | One answer call; optional planning and bounded retries count toward the total |
| Knowledge-aware extraction | Enlarges existing extraction requests; does not inherently require a separate call |
| Ledger import | Deterministic mapping/review where possible; any model-assisted reconciliation is separately gated |

### Trust and coverage

Treat retrieved text as data in every model-facing prompt. Preserve the distinction between stored summaries, verified original-message observations, explicit canon, and generated interpretations.

Report meaningful coverage limits. Citation existence is structural validation, not proof of support. Prefer visible uncertainty to unsupported connective facts.

## Decisions proposed for agreement

1. Deliver in the order **0 → 3 → 1 → 2 → 4**.
2. Default MWT history use to the current chat; include other collections only through explicit same-continuity selection.
3. Keep Growth limited to resolvable originals from its current chat in the initial integration.
4. Apply knowledge-acquisition fields to new events first; make historical backfill an explicit later action.
5. Defer saving Ask answers to lorebooks. A later design can let users select supported claims through review.
6. Keep VectFox NPC cards and MWT dossiers alongside each other initially.
7. Confirm where VectFox changes will be reviewed and delivered before implementation begins.
8. Deliver Phase 0 as 0a (status and history) and 0b (source resolution), with Phase 3 starting on 0a.
