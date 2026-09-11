# World State Reliability and Compactness Roadmap

**Status:** Proposed implementation roadmap  
**Date:** 2026-09-11  
**Sources:** `WORLD_STATE_IMPROVEMENT_RECOMMENDATIONS.md` and `WORLD_STATE_RECOMMENDATIONS_RESPONSE.md`  
**Area:** World State, Chronicle, Interiority, Knowledge, Story Planner, and Injection diagnostics

## 1. Goal

Improve World State so it produces a compact and dependable account of current continuity without losing unresolved facts, inventing scene precision, or allowing speculative hooks to masquerade as established state.

The work should also close the unsafe Chronicle synchronization path, give every consumer the same interpretation of `Current Scene`, and reduce recurring prompt cost without adding an extra automatic generation call.

This roadmap preserves the current Markdown document format. It introduces shared parsing, validated write paths, and consumer-specific projections around that format rather than replacing the store with JSON.

## 2. Decisions this roadmap adopts

These decisions resolve the open questions from the two discussion documents.

1. **The saved document remains a human-readable continuity record.** It may be richer than any one prompt consumer needs. Consumers receive explicit projections from that record.
2. **`Current Scene` becomes a shared contract.** Pure parsing and normalization live in `core/`; World State owns mutations.
3. **Past Chronicle entries never update the present scene.** A sync is eligible only when its source range is the newest Chronicle range and is not older than the World State evidence already committed.
4. **Compactness limits begin as measured targets.** Structural violations are errors. Necessary complexity is preserved. Compactness does not become a user setting until measurements show that one policy does not fit normal use.
5. **Custom prompts retain their replacement behavior.** Universal structural checks and safe normalization still apply, but compactness alone does not reject or retry custom-prompt output.
6. **Hooks remain in the saved World State during this project.** Hook mode will control their generation and all consumers will distinguish them from factual state. Moving hooks to Story Planner is a later decision gate.
7. **Automatic refresh remains one model call per attempt.** Facts and hooks will not become separate automatic writers.
8. **Delta mode stays opt-in.** Whether it should become the default is decided only after Chronicle sync stops forcing false full refreshes and real usage has been measured.
9. **Grounding stays off by default.** Present-character grounding will extend the existing gate, but broader default enablement requires false-removal evidence.

## 3. Target contract

### 3.1 `Current Scene`

The canonical fields remain:

```text
## Current Scene
Date: Unknown
Time: Late afternoon
Location: Harbour office
Present: Alex, Derek, Mara
Situation: The group is waiting for the missing manifest to arrive.
```

Rules:

- `Date`, `Time`, `Location`, `Present`, and `Situation` occur exactly once inside `Current Scene`.
- `Date` and `Time` may express uncertainty. Exact precision is required only when the story establishes it.
- `Location` is one compact, established label that distinguishes the scene. There is no blanket ban on districts, cities, countries, or room numbers when they are necessary.
- `Present` contains comma-separated names only. Parenthetical and bracketed annotations are removed before splitting. Titles and epithets are valid names and are never rejected merely because they resemble ordinary phrases.
- `Situation` is one concise sentence describing the active beat.
- If a scalar field did not change, generation copies its previous value exactly.

### 3.2 Retention

Facts leave World State according to their meaning:

- fleeting posture and momentary mood may expire quickly;
- injury, impairment, possession, and other persistent state remain until change is established;
- obligations remain until fulfilled, cancelled, superseded, or clearly abandoned;
- a passed deadline becomes overdue when the obligation still exists;
- threads leave when resolved or made irrelevant by evidence, not merely through lack of mention.

Character-state fields become sparse only after this meaning is implemented: an omitted field means that no fact in that category would cause a continuity error. Meaningful negative facts such as `unarmed` or `no phone` remain explicit.

### 3.3 Factual and hook views

The factual view contains established continuity. The hook view contains possible future events.

For the first implementation, the existing section headers remain for compatibility:

- Factual: Current Scene, Recent Changes, Off-Screen, Pending, Active Threads, Unresolved Threads, World Pressures, and Key Character States.
- Hooks: Story Momentum, Plot Seeds, and Potential Entrances.

An established external pressure remains factual. A prediction about what it might cause belongs in the hook view.

## 4. Delivery plan

Each phase should land independently with its tests passing. A later phase may depend on an earlier one, but no phase should require a store migration or a second generation writer.

### Phase 0 — Baseline and regression fixtures

**Purpose:** Capture the failure cases before changing shared behavior.

Work:

- Add reusable World State documents for a minimal scene, a crowded scene, annotated `Present`, persistent injuries, overdue obligations, and unchanged scene refreshes.
- Add Chronicle anchors using `2:30pm`, `2pm`, `late afternoon`, `evening`, and `Unknown`.
- Reproduce an older-entry regeneration, an older-range consolidation, and a Chronicle snapshot completing during a World State refresh.
- Record current generated and injected token estimates for hook mode `off` and `passive`.
- Cover default and custom system prompts separately.

Primary tests:

- `test/world_state_delta.test.js`
- `test/remediation_followups.test.js`
- `test/generation_commit_races.test.js`
- `test/interiority.test.js`
- `test/prompt_helpers.test.js`

Exit criteria:

- Every reported failure has a deterministic fixture.
- Race tests prove which document and message range each operation started from.
- Baseline measurements are recorded in the test or roadmap notes without making unstable token counts exact assertions.

#### Phase 0 baseline notes (implemented 2026-09-11)

- Reusable fixtures live in `test/fixtures/world_state_phase0.js`; they cover the
  six requested continuity cases plus a hook-bearing measurement document.
- `test/world_state_phase0_baselines.test.js` characterizes the current unsafe
  Chronicle outcomes for older regeneration, older-range consolidation, and a
  snapshot completing during a World State refresh. The tests assert both the
  source ranges/documents and final stored World State so later phases can invert
  the unsafe outcomes rather than silently losing the reproductions.
- Token measurements use the deterministic test fallback estimator and assert
  tolerance bands/relationships, not exact counts. Approximate values recorded
  on 2026-09-11 are: built-in system prompt **1,565**, minimal custom replacement
  **16**, hook-bearing stored fixture **124**, injected fixture with hooks `off`
  **160**, and injected fixture with hooks `passive` **269** tokens. The generated
  fixture is **124** tokens in both modes, explicitly recording that hook mode
  currently changes injection but not the built-in generation prompt or output.
  Turning hooks off removes Plot Seeds but still leaves Story Momentum and
  Potential Entrances in the factual-looking World State block. These are
  characterization results, not compactness targets.
- Default and custom prompt measurements are separate. No production prompt,
  parser, synchronization, store, or injection behavior changes in Phase 0.

### Phase 1 — Shared World State document contract in `core/`

**Purpose:** Establish one pure interpretation of the Markdown document before changing writers and readers.

Add a module such as `core/world_state_document.js`, exported through `core/index.js`, with pure helpers along these lines:

```js
parseWorldStateSections(text)
parseCurrentScene(text)
normalizePresentValue(value)
patchCurrentScene(text, patch)
validateWorldStateDocument(text, options)
projectWorldState(text, options)
```

The precise API may be smaller if the implementation finds natural composition points. It must keep parsing separate from storage and UI state.

Requirements:

- Section matching is line-anchored and rejects duplicate known headers.
- `parseCurrentScene()` reads fields only from the `Current Scene` block.
- Parsing returns the raw field values, normalized `present` array, and structured issues.
- `normalizePresentValue()` strips bracketed annotations, trims whitespace, removes exact duplicates while preserving source order, and does not reject names based on linguistic shape.
- `patchCurrentScene()` changes only provided fields and preserves unchanged lines exactly.
- Legacy documents are read tolerantly; generated output is held to the new contract.
- Pure helpers do not read chat metadata, settings, module state, or the DOM.
- Test stubs re-export the same public core API.

Validation modes:

- **Structural:** universal; exactly one `Current Scene`, required scene fields, known non-duplicate headers, and no roleplay leakage.
- **Default-contract:** adds measurable field guidance and may trigger one retry for objective format violations.
- **Custom-prompt:** applies structural rules and safe normalization, but reports compactness as a warning rather than rejecting it.

Exit criteria:

- A valid `Current Scene`-only document passes.
- A document missing any required scene field fails with a field-specific issue.
- Duplicate scene fields or headers fail.
- Annotated names normalize without creating fragments.
- Names such as `The Vixen`, `Captain of the Guard`, and `Old Man Jenkins` remain valid.
- No existing stored document is rewritten merely because it was read.

### Phase 2 — Close the Chronicle synchronization boundary

**Purpose:** Prevent Chronicle from bypassing World State safety and from applying an old scene anchor to the present.

Add a World State-owned operation, for example in `world_state/scene.js`:

```js
updateSceneAnchor({
    date,
    time,
    location,
    source,
    sourceId,
    sourceRange,
    expectedRevision,
})
```

Chronicle remains responsible for extracting its Time Anchor and for identifying the candidate snapshot. The shared core helpers normalize its date, time, and location into the World State contract. World State remains responsible for eligibility, concurrency, and committing the patch.

Write rules:

- Never call `patchChatMeta(WORLD_STATE_METADATA_KEY, { text })` from Chronicle.
- Refuse writes while the World State store is paused.
- Refuse sources with no trustworthy range for automatic sync.
- A generated snapshot may sync only if it is the newest accepted Chronicle range.
- A regenerated entry may sync only if that entry remains the newest range.
- A consolidation may sync only if its merged range includes the previously newest range and becomes the newest remaining range.
- Refuse a candidate whose source ends before the World State's committed evidence watermark.
- Preserve an existing compact Location when Chronicle offers the same place with extra descriptive detail.
- Treat a sync that changes no field as a no-op.

Concurrency policy:

- A sync candidate arriving during full refresh, delta refresh, or section regeneration must not edit the document immediately.
- Keep at most the newest scoped candidate and re-evaluate it once the active World State operation settles.
- If that operation committed through the same or newer evidence, discard the candidate as redundant or stale.
- If the operation failed and the document revision is still the candidate's expected revision, the candidate may commit.
- If the user edited the document, discard the candidate. Chronicle must never make a user edit look like a refresh conflict.

Commit behavior:

- Use the checked World State write seam.
- Store the old text in history only when text actually changes.
- Commit text and delta status atomically.
- Treat the sync as a partial update and preserve the previous message watermark so changes in other sections remain scannable.
- Rebuild injection and provenance only after a successful write.
- Return a structured result such as `applied`, `no-change`, `stale-source`, `busy-superseded`, `user-edited`, or `store-refused` for diagnostics and UI messages.

Date/time rules:

- Recognize clock values with and without minutes when unambiguous (`2pm`, `2:30pm`, `14:30`).
- Recognize qualitative times (`dawn`, `morning`, `late afternoon`, `evening`) as `Time`, not as part of `Date`.
- Preserve `Unknown` without substituting the real-world date.
- When a combined anchor cannot be split safely, keep the existing scene values and report a warning instead of creating contradictory Date and Time lines.

Exit criteria:

- Chronicle has no direct World State metadata write.
- Paused stores remain untouched.
- Older regeneration and consolidation cannot alter the present scene.
- Qualitative time anchors produce coherent Date and Time values.
- A concurrent Chronicle snapshot cannot discard a paid World State refresh or be reported as a user edit.
- Delta status remains digest-consistent after a successful sync.

### Phase 3 — Prompt and settings behavior

**Purpose:** Stop rewarding verbose output and make hook mode affect generation.

Work:

- Replace the fixed default prompt lookup with a builder that receives effective hook mode.
- Add the `Current Scene` contract, good/bad examples, and copy-exactly-if-unchanged rule.
- Reduce the requested whole-document target from 2,000 words to roughly 600–800 while retaining the 2,000-token API allowance.
- Add preferred item counts as targets, not unconditional truncation limits.
- Replace recency-only deletion rules with the retention rules in §3.2.
- Allow sparse Key Character States and remove mandatory `none` only after documenting omission as "no continuity-relevant fact in this category."
- When hook mode is `off`, remove Story Momentum, Plot Seeds, and Potential Entrances from the default generation template.
- Keep one automatic generation call when hooks are enabled.
- Restrict the Variety control to hook sections. Factual sections should not receive "bolder" instructions or a temperature boost.
- Change the strict grounding label to describe its actual discard behavior.

Custom prompt policy:

- Preserve the existing meaning of `customPrompt` as a complete base-prompt replacement.
- Append only the minimum output protocol required for safe operation, if one already exists for that generation mode.
- Do not add default compactness language to a custom prompt.
- Enforce hook mode at projection and post-processing boundaries even if a custom prompt generated a hook section. Token savings from hook mode `off` are guaranteed only for the built-in prompt.
- Update the help text so users understand which safeguards still apply.

Exit criteria:

- Repeating a refresh with no scene change copies Location and other unchanged scene fields exactly in the standard fixture set.
- Hook mode `off` causes the built-in generation request to omit all three hook sections.
- Default output becomes smaller without reducing the API token ceiling.
- Variety cannot raise temperature or add creative instructions for factual sections.
- Custom-prompt output is not rejected solely for exceeding compactness targets.

### Phase 4 — Integrate validation, normalization, and Present grounding

**Purpose:** Enforce the shared contract on every generated scene and close the grounding gap in `Present`.

Work:

- Move the private full-refresh validator onto the shared core validator.
- Validate full refresh output before grounding and commit.
- Validate the patched complete document after a delta update, not only the delta markers.
- Validate `Current Scene` section regeneration before it replaces the section.
- Run the same structural checks on Chronicle scene-anchor patches.
- Apply safe `Present` normalization only to generated or synchronized output. Manual editor and import writes remain byte-preserving unless the user explicitly normalizes them.
- Extend the grounding gate to receive the parsed `present` array.

Present grounding behavior:

- Use the existing evidence union: frozen scan window, prior state, pinned entities, and approved aliases.
- In soft mode, remove only ungrounded names from `Present`, preserve order, and log each removal.
- In strict mode, reject the generation according to the existing path's retry policy.
- Never infer that a name is invalid from its grammatical shape.
- If normalization or grounding leaves nobody present, serialize the project's chosen empty representation consistently rather than dropping the field.

The grounding retry policy should remain explicit by path. Full refresh and section regeneration currently allow a grounding retry; delta currently discards a strict grounding failure without an additional grounding retry. This phase should test and document that difference rather than silently changing cost behavior.

Exit criteria:

- Sparse but valid documents pass.
- Structurally invalid Current Scene blocks cannot commit through full, delta, section-regeneration, or Chronicle paths.
- The actual failure examples—long location, annotated names, multiline fields, unchanged elaboration, and missing fields—have regression coverage.
- An invented Present name is removed in soft mode and rejected in strict mode.
- Grounding remains disabled by default.

### Phase 5 — Route readers through shared parsing and factual projections

**Purpose:** Stop downstream modules from treating hook suggestions as established facts or maintaining conflicting scene parsers.

Work:

- Add core accessors for the raw document, factual projection, hook projection, and parsed current scene.
- Move Interiority roster construction and world-time lookup to `parseCurrentScene()` while preserving its Knowledge-registry fallback and alias handling.
- Move Chronicle's World State date/time reads to the parser.
- Give Knowledge's eight World State call sites the factual projection.
- Give Story Planner the factual projection; its own planning machinery already supplies future-facing material.
- Update narrator injection to place the factual view under the continuity header and all hook sections under the hook-mode header.
- Keep Archive (Stale) out of every prompt projection.

The saved Markdown document remains unchanged. This phase changes only what each consumer sees.

Exit criteria:

- Interiority no longer parses `Present:` or Time with its own regular expressions.
- Knowledge and Story Planner never receive Story Momentum, Plot Seeds, or Potential Entrances as factual context.
- Hook mode `off` injects no hook content.
- Passive, proactive, and assertive modes preserve their current narrator instructions while wrapping all hook sections consistently.
- Existing alias, group-chat, roster-cap, swipe, and dormant-intention tests stay green.

### Phase 6 — Section-aware injection and diagnostics

**Purpose:** Reduce repeated prompt cost based on meaning rather than blind character truncation.

First add measurement:

- Report stored and injected estimated tokens per section.
- Report which sections or entries a projection omitted.
- Show factual and hook totals separately.
- Extend the existing Injection diagnostics surface rather than introducing a second diagnostics system.

Then implement bounded selection only where measurements justify it:

1. Always retain the complete valid `Current Scene`.
2. Retain all due and overdue Pending items.
3. Retain continuity-relevant state for present characters.
4. Rank Active Threads and World Pressures next.
5. Include actionable Off-Screen entries after those.
6. Keep hooks in their separate hook budget.
7. Drop whole entries or sections from the tail of a priority ranking; never cut through a field, name, or bullet.

The cross-module Budget system remains the outer cap. The World State projection supplies a semantically ordered payload to that existing seam.

Exit criteria:

- The injection never contains a half section or truncated name.
- Required scene and obligation content survives ordinary soft-cap enforcement.
- Preview, live injection, and diagnostics use the same projection builder.
- A projection failure falls back to the last safe raw factual view or omits the injection; it never changes stored World State.
- Token reduction and omitted content are visible to the user.

### Phase 7 — Measurement gates and default decisions

**Purpose:** Make the remaining product choices from evidence rather than architecture preference.

Evaluate the fixture set and representative real chats using:

- facts retained;
- unsupported field changes;
- Present accuracy;
- saved and injected token counts by section;
- retry and rejection frequency;
- full versus delta refresh frequency;
- Chronicle sync applications and refusals;
- grounding removals, including user-corrected false removals.

Decision gates:

#### Gate A — How much injection projection is needed?

- If factual projection alone brings normal payloads within the desired budget with no continuity complaints, stop at section separation.
- If large factual documents still recur, retain the priority projection from Phase 6 and tune it from omission diagnostics.

#### Gate B — Should hooks move to Story Planner?

Move them only if separate cadence or creativity remains a demonstrated need after hook-aware prompting and projections. A move should transfer the hook-mode headers and Variety control, preserve one writer per store, and remove hook sections from World State in a compatibility-aware release.

#### Gate C — Should delta mode become the default?

Consider this only after a real-use period in which Chronicle no longer forces false manual status. Compare cost, continuity errors, reconciliation frequency, and failed patches. Default-on requires results at least as reliable as full refresh for the evaluation set.

#### Gate D — Should grounding default on?

Consider only if invented-name prevention clearly exceeds false-removal harm. Soft-mode removals need visible diagnostics and a recovery path before any default change.

## 5. Test matrix

| Concern | Required coverage |
| --- | --- |
| Shared parsing | Valid minimal scene, missing fields, duplicate fields, duplicate headers, multiline values, CRLF/LF, unknown date/time |
| Present normalization | Parenthetical commas, brackets, duplicates, aliases, titles, epithets, empty roster |
| Validation policy | Default prompt retry, custom prompt warning, sparse document acceptance, delta post-apply validation |
| Chronicle eligibility | Newest generation, older regeneration, newest regeneration, old consolidation, consolidation including newest, manual/no-range entry |
| Chronicle time parsing | `2pm`, `2:30pm`, `14:30`, dawn, late afternoon, evening, unknown, unparseable combined anchor |
| Race safety | Sync during full refresh, delta refresh, section regeneration, user edit, chat switch, and paused store |
| Delta bookkeeping | Digest consistency, watermark preservation, reconciliation cadence, no false manual status |
| Hook separation | All four hook modes, default and custom prompt, factual consumer views, narrator injection |
| Interiority | Multiple present NPCs, incomplete World State roster fallback, aliases, group chat, roster cap |
| Projection | Section priority, whole-entry omission, preview/live parity, Budget soft and hard caps |

Every race or persistence regression should assert both the returned status and the final stored document. A test that checks only a warning message is insufficient for these paths.

## 6. Compatibility and migration

- Keep the World State metadata key and text schema unchanged.
- Parse existing Markdown tolerantly and apply stricter rules only to new generated or synchronized output.
- Do not rewrite saved documents on load.
- Do not normalize manual editor or imported text silently.
- Keep current section headers through this roadmap. Any future merge into `Narrative Hooks` needs a separate compatibility plan.
- Preserve custom prompts and document the new universal structural boundary.
- Add no API call to normal refresh. Retry counts remain bounded by their existing paths.
- Keep expiry, grounding, and delta defaults unchanged until their measurement gates pass.

No schema migration should be necessary unless implementation adds persisted field-level provenance or sync receipts. If that later becomes desirable, it should be planned as a separate versioned store change.

## 7. Risks and controls

| Risk | Control |
| --- | --- |
| Parser damages unusual names | Normalize annotations and exact duplicates only; never reject by name shape; keep raw values available |
| Chronicle overwrites newer continuity | Require newest source range, compare evidence watermark, and fail closed on ambiguous chronology |
| Concurrent sync discards paid generation | Defer candidate inside World State ownership, then re-check revision and evidence after the active operation |
| Compactness drops live obligations | Treat limits as targets; give due and overdue obligations priority; omit whole low-priority entries only |
| Custom prompts break under new validation | Separate structural validity from compactness; warn rather than reject on compactness |
| Hooks leak into factual reasoning | Use one shared projection helper for Knowledge, Story Planner, Chronicle, and narrator injection |
| New helpers create module cycles | Keep pure parsing/projection in `core/`; keep writes in `world_state/`; do not add Interiority → World State imports |
| Split generation adds races and cost | Keep one call and one commit per automatic refresh |
| Grounding removes real characters | Preserve default-off behavior, log removals, test aliases and epithets, and require measurement before default changes |

## 8. Suggested implementation slices

The phases can be reviewed in these commit-sized slices:

1. Add failure fixtures and baseline measurements.
2. Add pure core parser, patcher, and structural validator with tests.
3. Add World State-owned scene-anchor write and replace direct Chronicle metadata writes.
4. Add Chronicle chronology, qualitative-time, and concurrency coverage.
5. Revise the default prompt, hook-aware builder, Variety scope, and grounding label.
6. Integrate validation and Present grounding across full, delta, section, and sync paths.
7. Route Interiority and Chronicle reads through the shared scene parser.
8. Add factual and hook projections and move Knowledge, Story Planner, and narrator injection onto them.
9. Add per-section injection diagnostics and collect real-use measurements.
10. Implement or tune priority compaction only if the measurement gate calls for it.

Each slice should pass `npm test` and `npm run lint`. Cross-module slices should also include a manual SillyTavern check for refresh, Chronicle sync, injection preview, hook mode, and chat switching before release.

## 9. Project completion criteria

The roadmap is complete when:

- every World State writer uses a checked World State-owned path;
- every scene reader uses the shared parser or an accessor built on it;
- old Chronicle material cannot alter the present scene;
- a valid sparse state is accepted and a malformed Current Scene is rejected;
- unchanged scene fields remain byte-for-byte stable across generation;
- Present contains normalized, optionally grounded names without annotations;
- unresolved persistent facts survive lack of recent mention;
- factual consumers do not receive possible future events as established state;
- hook mode affects generation as well as injection;
- injection omits content by section or entry rather than cutting semantic units;
- custom-prompt behavior remains usable and documented;
- no additional automatic model call has been introduced;
- tests, lint, and the manual cross-module checklist pass.

At that point, the Gate A–D results should be recorded in a short decision note. That note, rather than this roadmap alone, should govern any later move of hooks to Story Planner or changes to the defaults for delta, grounding, and compactness.
