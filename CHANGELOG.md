# Changelog

All notable changes to **Merged World Tracker** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **About the older entries.** MWT did not keep a dedicated changelog before
> v1.4.23. The summaries for **v1.3.0**, **v1.4.0**, and **v1.4.7** below were
> *reconstructed* from the git history (the commits between each pair of tags)
> after the fact, so they describe themes rather than every change. Entries from
> **v1.4.23** onward are written as releases happen. For commit-level detail,
> browse `git log` or the GitHub compare links at the bottom of this file.

## [2.4.1]

### Added

- **The alias list now reaches World State's grounding gate and Interiority's
  matchers** (TODO §1 identity-service follow-up, the `[NEXT]` seam).
  `knowledge/identity.js` (v2.3.0) ships user-approved `aliases[]` that
  `resolveRegistryKey()` honors — but these consumers were still alias-blind:
  - **World State grounding** (`world_state/provenance.js`):
    `groundingGate()` accepts `aliasGroups` and grounds bolded names two ways
    — an approved alias spelling passes outright (user-vouched, exactly like
    a pinned entity, which is also what keeps a rename's old spelling
    grounded), and a canonical name passes when one of its aliases is
    phrase-grounded in the evidence (the alias itself appears — the scan
    window said "The Vixen", the model wrote "Mara Vance" — one person per
    the user's own alias decision).
    Canonical names with aliases but no evidence of any form stay phantoms,
    so the anti-invention gate keeps its teeth. New
    `collectRegistryAliasGroups()` reads the live lorebook-store registry
    (the alias list lives only there — the legacy chat-metadata mirror
    predates the identity service) through a dynamic import, fail-soft, and
    is wired into the full refresh, delta patches, and per-section
    regeneration, collected once per gate pass.
  - **Interiority roster matcher** (`buildSceneRoster`): the registry union
    that rescues in-scene NPCs missing from an incomplete `Present:` line now
    matches each record's aliases as well as its canonical key, and reads the
    live store registry in addition to the legacy chat-metadata mirror — an
    NPC whose scene presence is only ever spelled "The Vixen" reaches the
    roster under "Mara Vance" instead of never getting thoughts/intentions.
  - **Interiority model-output matcher** (`resolveRosterName`): an optional
    alias index adds an explicit-alias step (exact match against the aliases
    the user approved for each roster member; two claimants fail closed,
    mirroring `resolveRegistryKey`) — the step titles and nicknames need,
    since "The Vixen" shares no token with "Mara Vance" and the given-name
    heuristic could never prove it. The orchestrator builds the index once
    per turn (`collectRosterAliases()`) and threads it through
    `mergeSplitResults`, `validateAndApply`, `runStrictCalls`, and
    `getEvaluatedNpcNames` (which now resolves through `resolveRosterName`
    altogether, so fuller heuristic spellings count as evaluated there too).
  - Pinned by `test/alias_matchers.test.js` (35 tests).

### Changed

- Version bump to 2.4.1 (`manifest.json`, `package.json`, `core/version.js`).

### Fixed

- **The alias bridge demands the whole alias phrase, not a word of it**
  (`world_state/provenance.js`). The bridge from a canonical name to its
  alias evidence delegated to the canonical-name word rule ("Aboud"
  grounding "Dr. Aboud") — but nicknames are built out of ordinary words, so
  an alias like "Red Fox" grounded its owner's canonical name off any
  mention of "red" in the evidence, permanently exempting exactly the NPCs
  the user cared enough about to nickname from the anti-invention gate. The
  bridge now matches the alias as a whole phrase (whitespace-flexible,
  case-insensitive), the same phrase-level treatment the outright path
  always had. Pinned by the multi-word-alias fixture in
  `test/alias_matchers.test.js`.
- **Per-section regeneration collects aliases above the guards**
  (`world_state/sections.js`). The gate's alias consultation sat between the
  WORLD-STATE-02 target-section revision check and the write, so an edit to
  the target section landing in that (cold first-load) window was silently
  overwritten. It is now collected with the other pre-flight captures, next
  to the frozen scan window — no await remains between the section guard
  and the write on the first-try path.
- **Both alias collectors fail audibly**
  (`collectRegistryAliasGroups`, `collectRosterAliases`). A bare `catch` and
  the unhydrated store's empty registry read made "the user has no aliases",
  "the knowledge module failed to load", and "the store hasn't hydrated yet
  on this chat switch" indistinguishable — the first refresh after a chat
  switch could silently run alias-blind with nothing in the console to
  explain it. Both failure paths and the empty-registry read now warn.
- **Interiority leftovers**: `_formatRelationshipsForRoster` resolves edge
  targets through `resolveRosterName` instead of an exact lowercase lookup,
  so a legacy or un-repaired edge spelling the old name no longer drops that
  relationship line from the thoughts prompt (lines are emitted under the
  roster's spelling); and `runStrictCalls` threads the turn's alias index
  from `generateForCurrentMessage` instead of rebuilding it — a duplicate
  dynamic import + registry scan per strict turn removed.
- **The full refresh and the delta patch collect aliases above the guards**
  (`world_state/refresh.js`). Per-section regeneration had already moved its
  alias consultation pre-flight, but the full refresh and the delta path
  still collected the alias groups inside the grounding block — AFTER the
  post-generation scope assert. A chat switch while that (cold first-load)
  dynamic import resolved sailed past the assert, and the later revision
  check is not a cross-chat guard when the two chats' documents happen to
  match: the old chat's generated document or patch was committed into the
  new chat. Both paths now collect with the other pre-flight captures
  (gated on the grounding setting), so the await is covered by the existing
  post-generation assert and the registry read is the same chat's as the
  scan window. Pinned by the alias-load chat-switch races in
  `test/generation_commit_races.test.js`.
- **Strict-mode evaluation counting resolves against the full roster**
  (`interiority/generation.js`). The per-NPC evaluation check in
  `runStrictCalls` resolved each answer against its singleton `[name]`
  slice, which defeated the duplicate-alias ambiguity rule: with two roster
  members importing the same alias, each singleton counted the ambiguous
  answer as its own successful evaluation, so both dormant entries could be
  confirmed and awakened even though full-roster validation rejects the
  ambiguous blocks. The answer now resolves against the whole roster and
  counts only when it lands on that loop's member. Pinned in
  `test/alias_matchers.test.js`.
- **Punctuation-edged aliases match again** (`core/context.js`,
  `world_state/provenance.js`, `interiority/generation.js`). Wrapping the
  escaped alias in unconditional `\b`s never matches when the alias begins
  or ends with punctuation — no word boundary exists beside the outer
  non-word character — so approved aliases like "A.J." or "(Vixen)" failed
  both the grounding bridge and scene detection, and the canonical name
  behind them was stripped as a phantom. A new shared `wholePhraseRegex()`
  derives the boundaries from the phrase's actual edge characters (a
  punctuation edge keeps its literal match and accepts a longer neighbour,
  so "A.J." matches inside "A.J.'s"); both the grounding bridge and the
  roster union matcher use it. Pinned by the punctuation-alias fixtures in
  `test/alias_matchers.test.js`.

## [2.4.0]

### Added

- **Central generation coordinator + cancellation model** (`core/coordinator.js`,
  TODO §1 / PI §P1). The five modules each kept their own busy flag — correct
  *within* a module, but nothing stopped World State, Chronicle, Knowledge,
  Story Planner, and Interiority from issuing simultaneous outbound calls
  *across* modules: API rate-limit bursts, several expensive calls after one
  message, overlapping notifications, token pressure. One coordinator now owns
  what is in flight:
  - **Concurrency limits.** Per-module 1 (matching every module's own
    busy-flag contract) + a global cap (`apiMaxConcurrent`, default 2, 1–8,
    read live from the global settings). No head-of-line blocking: a job that
    cannot start never stops an unrelated module's job.
  - **Adopted at the transport seam.** Both `fetchFromApi()` and
    `fetchViaConnectionProfile()` (core/api.js) submit through the coordinator,
    so every module call — including Knowledge's dossier/growth fetches and
    every retry/backoff sequence — is coordinated with zero per-module
    restructuring. A whole fetch-with-retries is one job, so retry storms are
    throttled too.
  - **Priorities + trigger classification.** Manual button/slash-command work
    outranks automatic work when slots free up. The main generation call sites
    now thread `trigger: 'auto' | 'manual'` (World State full/delta refresh,
    Story Planner, Chronicle auto-snapshots via `generateSnapshot(isAuto)`,
    Knowledge state updates via `ktFetchFromApi({ trigger })`; Interiority
    already threaded its triggers).
  - **Dedupe of pending jobs.** A submit carrying a `key` joins an equal-key
    QUEUED job (one run, all awaiters settle together); running work is never
    joined — the module busy flags own that refusal.
  - **Cancellation via AbortController, where the backend supports it.**
    Cancelled queued jobs never start; cancelled running calls abort mid-wire
    in custom-API mode (`fetch(..., { signal })`) and at every
    dispatch/backoff boundary in Connection-Manager mode (`sendRequest` has no
    signal parameter). `retryAsync` never retries an abort. A chat switch
    (`bumpEpoch()` → `onChatScopeChanged()`) retires every stale-epoch job —
    queued copies never spend, running ones stop early — using a three-pass
    sweep so a settle-triggered pump can never start a stale job mid-sweep.
    Cancellations surface to flows as `_mwtCancelled` and are quietly
    discarded (logged, no failure toast/status); the Last-request tab records
    them as `errorClass: 'cancelled'`, not failed.
  - **Unified busy/queued/cancelled/failed status.** `getCoordinatorSnapshot()`
    (JSON-safe job records with wait/duration timings), `coordinator` events
    in the 📋 Log tab ring, `mwt:busy-changed` dispatch on transitions, and a
    console bridge: `MWT.coordinator.status()` (tables running+queued, returns
    the snapshot), `.jobs()` (settled history), `.cancel(module?)` (emergency
    stop).
  - **Optional "hold automatic tracker work while you generate" policy.**
    Global setting `pauseBackgroundJobsDuringGeneration` (default off),
    driven by ST `GENERATION_STARTED` plus ONE canonical terminal event
    (`GENERATION_ENDED` when the build exposes it, else
    `GENERATION_STOPPED`) and depth-counted, so a build that fires both stop
    events for one generation (BUG REPORTS/01_core.md #4) cannot
    double-decrement. Manual work is never held.
  - **Settings UI** (Settings tab → 🚦 Generation Coordinator): the parallel
    cap + the hold-during-generation toggle; saving re-runs the scheduler so a
    raised cap releases queued jobs immediately.
  - **Test seam parity.** The coordinator is a pure module with injectable
    resolvers (`_setCoordinatorResolvers`), re-exported through the
    core/index.js barrel and mirrored in `test/stubs/core.js`
    (`resetCoreStubs()` now clears the singleton). Pinned end-to-end by the
    new `test/coordinator.test.js` (limits, priorities, dedupe, every
    cancellation path, the epoch-based chat-switch retirement, and the
    transport adoption contract). Suite: 76 files / 1947 tests → **77 / 1983**.

### Fixed

- **Coordinator cancellation leaked into stale retries and user-facing
  failures** — three gaps in the adoption of the coordinator above, all
  violating its "cancellation is a quiet discard, never a failure" contract:
  - **Knowledge JSON-recovery retry loops** (`runNpcUpdate`, `runNpcEnrich`,
    `runDossierFieldRefresh` in `knowledge/lorebook.js`) caught the
    coordinator's cancellation errors like parse failures and retried —
    spending a FRESH job at the new epoch (which the chat-scope retirement
    can no longer cancel) on the OLD chat's prompt. Cancellation is now
    rethrown immediately via the shared `isCancellation()` (recognizes both
    the marked `JobCancelledError` and the native mid-wire `AbortError`).
    Pinned by new tests in `test/dossier_field_refresh.test.js`.
  - **World State section regeneration** (`world_state/sections.js`) had no
    cancellation catch, so a chat switch mid-regen rejected through to the UI
    as "Section regen failed". It now quietly returns `null` like
    `refreshWorldState()` / `refreshWorldStateDelta()`, and the 🎲 handler
    reports a neutral "Section regen aborted." info status for every null
    discard. Pinned by a new test in `test/world_state_delta.test.js`.
  - **Knowledge workflow boundaries** (the manual Scan / NPC-Update / Enrich /
    State-Update / Field-Refresh handlers in `knowledge/render.js`, and the
    auto state-update / auto-scan / relationship-extract catches in
    `knowledge/index.js`) reported cancellation as error toasts, statuses, or
    warnings. Each boundary now discards cancellation quietly and stops the
    surrounding auto run (its remaining steps would submit fresh stale-context
    jobs); real errors still surface unchanged.

## [2.3.1]

### Added
- Defense-in-depth tests

### Fixed

- **[P1] Standalone NPC import persisted conflicting identity claims**
  (`knowledge/staging.js` `importNpcs`). The import validated each incoming
  record's *shape* (`checkRegistryRecord`) but never the *combined* registry,
  so an imported record claiming a tracked NPC's `entityId`, or an alias equal
  to another record's canonical name/alias, was committed as-is — both
  conflicting records stayed persisted until the next store hydration
  repaired them. The entity-identity cross-checks (duplicate entity ids,
  alias collisions, malformed merge trails) moved out of
  `validateKnowledgeStoreData` into an exported
  `canonicalizeRegistryIdentityClaims()`
  (`knowledge/schema.js`, same repair semantics: first claim wins, later
  claims are dropped and re-stamped fresh by `saveRegistry`), and the import
  now runs it on the combined registry BEFORE committing, warns per repair,
  and reports the count in the status message. Pinned by new tests in
  `test/import_export_roundtrip.test.js`.
- **[P1] The Growth Profile modal could open into the wrong chat**
  (`knowledge/render.js` `openGrowthProfileModal`). A chat could change while
  the opening awaits (module imports + the profile lorebook read) were
  pending: the chat-change sweeps remove `#kt-growth-modal`, but the modal is
  not in the DOM yet, so the OLD chat's modal was appended into the NEW chat
  and its evidence-editing / Save-to-Lorebook handlers then acted on the new
  chat's stores. The opener now captures the chat scope before the first
  await (`core/scope.js captureScope`) and rechecks it after each await
  (`scopeStillCurrent`), discarding the open on drift. An in-flight singleton
  guard plus a DOM check also stop rapid clicks from stacking duplicate
  `#kt-growth-modal` nodes during the same await window. Pinned by new tests
  in `test/growth_modal_scope.test.js`.


## [2.3.0]

### Added

- **Entity identity + alias management service** (`knowledge/identity.js`, TODO §1 /
  PI §4). Registry names are display state; this adds the stable identity layer
  underneath so renames and merges stop losing history:
  - **Canonical entity ids.** Every registry record now carries an `entityId`
    (`mwt_<time36>_<rand>`), stamped by a lorebook-store schema **v1 → v2
    migration** on load and by `saveRegistry()` on every runtime write, so all
    creation paths converge without code changes. Relationship edges carry the
    same stability: `addRelationship`/`updateRelationship` stamp
    `subjectEntityId`/`targetEntityId`, and a new
    `repairRelationshipEntityNames()` heals drifted edge/map-key names from
    those ids (`MWT.npcs.repairLinks()`).
  - **Aliases & nicknames.** Records carry a user-approved `aliases[]` that
    `resolveRegistryKey()` honors as a new exact-match step — "The Vixen"
    resolves to "Mara Vance" without touching the given-name heuristic.
    Ambiguous aliases fail closed (no entry rather than the wrong dossier);
    the write-time guards and the store validator (repair-severity
    `registry-alias-collision`) keep aliases collision-free.
  - **User-approved renames** (`renameEntity`): rekeys the registry, the
    relationship map + edge targets (ids unchanged — that's the point),
    stances/sources, the evidence map, and per-field dossier watermarks; swaps
    the old spelling out of keywords; and relabels the lorebook + profile
    entries through a new label-verified `relabelLorebookEntry()` seam
    (`writeToLorebook` would have detached a genuine rename as a "stale uid").
    The old name stays as an alias, so existing references keep resolving.
  - **User-approved merges** (`mergeEntities`): folds a duplicate identity into
    another with KEEP semantics (survivor's uid/type/stance win, pointers
    adopted only where absent), a `mergedFrom` audit trail on the record,
    evidence merged under namespaced ids so consolidated → raw quote-receipt
    links survive verbatim, relationship edges re-pointed with the existing
    provenance discipline, and the absorbed name kept as an alias. The
    absorbed lorebook entry is reported for manual deletion, never
    auto-deleted.
  - **UI + console surface.** A ✏️ **Identity** button on every NPC card opens
    a panel showing the entity id, alias chips (add/remove), rename, and
    merge-into with confirmation. Console: `MWT.npcs.rename(npc, newName)`,
    `.merge(keep, merge)`, `.addAlias`, `.removeAlias`, `.entityId`,
    `.repairLinks()`.
  - **Schema v2 validation.** `entityId`/`aliases`/`mergedFrom` and edge entity
    ids are optional-but-validated; duplicate entity ids and alias collisions
    repair with the raw values preserved; the v1 → v2 migration also carries
    the `[MWT:store]` ghost scrub forward (v1-era books reach the chain without
    running v0 → v1). Tests in `test/entity_identity.test.js` (28 tests); the
    affected hydration/migration/backup assertions were updated to the stamped
    v2 shapes.

### Changed

- Version bump to 2.3.0 (`manifest.json`, `package.json`, `core/version.js`).

## [2.2.0]

### Added

- **Relationship "Recent Changes" tracking + detailed toast, and a collapsible
  stances list** (Knowledge → Relationships tab). Automatic relationship
  extraction used to announce counts only ("+2 relationship(s), ~1 updated") —
  the toast never said WHO changed or TO WHAT, and there was no way to review
  what the cadence had done after the toast faded. `applyExtractedRelationships`
  (`knowledge/relationships.js`) now returns a `changes` array with one record
  per applied mutation (edge added/updated with from→to, type, and previous
  type; stance set with the NPC, stance, and previous stance), and the
  completion toast names the first three changes with a "+N more" tail. The
  records also land in a new **🕘 Recent Changes** collapsible section on the
  Relationships tab (newest first, 🤖 auto / ✍️ you origin badges, ages, Clear
  log) — manual edits there (add/update edge, set/clear stance, remove edge) are
  logged too, so the panel is a full session audit. The log is session-scoped
  runtime state (`relRecentChanges` in `knowledge/state.js`, capped at 40,
  cleared on chat change) and deliberately NOT persisted: every lorebook-store
  field is schema-validated and carried by the backup/restore merge planner,
  which a review list doesn't justify. Formatting lives in one shared
  `describeRelationshipChange()` so the toast and the panel can't disagree.
  The per-NPC **stance rows are now behind a "Stances toward {{user}} (N)"
  collapsible header** (collapsed by default, count badge, remembered per
  session) — with a large NPC cast they previously pushed the graph and edge
  list far down the tab. Tests in `test/relationship_extract.test.js`.

- **Per-field / partial dossier refresh for Knowledge NPCs** (TODO §3 "F —
  Per-field / partial dossier refresh"; source: user ticket, cross-ref PI §3
  World State delta mode). Dossier fields go stale individually — an NPC's
  agenda moves on, their appearance changes — but until now the Update path
  always re-examined the whole entry. Major NPCs in Dossier Mode now have a
  **🎯 Fields** button that opens a per-field picker: each dossier section
  (Role, Where to Find, Appearance, Voice, Background, Personality, Read on PC,
  Current Agenda, Secrets, Canon Lock, Image Tags) is listed with its current
  value and a staleness chip driven by a new per-field watermark
  (last-updated timestamp + message count, stored in the
  `knowledge_tracker_counters` chat-metadata store value the same way World
  State's `deltaStatus` rides its store — no schema change). "Select stale"
  pre-checks every stale field (the bulk "refresh stale fields" action) and
  "Refresh selected" asks the model to re-derive ONLY the chosen fields
  (new `DOSSIER_FIELD_REFRESH_PROMPT` + `runDossierFieldRefresh`), staging the
  merged result in the normal review pipeline — everything not selected is
  preserved byte-for-byte. Both ownership boundaries are enforced in the
  sanitizer AND on the response: `canon_lock` is user-authored canon and is
  never model-refreshed, and `personality` is excluded for NPCs with a growth
  evidence file (`hasEvidenceFile`) so the evidence/growth "split-brain"
  partition (NPC_GROWTH_BLUEPRINT.md) is preserved. Accepting any dossier-mode
  proposal (update, enrich, scan merge, field refresh) now stamps field
  watermarks, so staleness stays honest; removing an NPC cleans them up; the
  picker modal is dropped on chat switch like the view/growth modals. New
  module `knowledge/dossier_status.js`; tests in
  `test/dossier_field_refresh.test.js`.

### Fixed

- **Identity service hardening — four fixes pinned by new tests in
  `test/entity_identity.test.js` and `test/canonical_identity.test.js`:**
  - **Lorebook identity checks now recognize explicit registry aliases.** The
    label checks in `writeToLorebook` (KNOWLEDGE-01), `writeProfileToLorebook`,
    `relabelLorebookEntry`, `loadEntryContent`, and the adopt-before-create
    backstop (`findEntryUidByNpcIdentity`) compared labels through the
    given-name heuristic only — so after an arbitrary rename ("Mara" →
    "The Vixen"), a staged update still spelled "Mara" treated the correctly
    relabelled uid as a stranger's and minted a duplicate entry, and a failed
    relabel left the old-labelled entry unreachable despite the alias. A new
    registry-backed tier (`registry.js resolvesToSameRegistryRecord` /
    `isSameNpcByName`) accepts user-approved explicit links (key or alias)
    ahead of the heuristic; given-name matches keep being judged against the
    caller's population (book labels), so same-given-name strangers still fail
    closed. `reconcileRegistry`'s verification uses the same rule, so
    "verified here" still means "loadable there".
  - **Rename/merge can no longer cross chat scopes.** The registry,
    relationships, evidence, and dossier watermarks are rekeyed synchronously,
    but the lorebook relabels and the relationship-block sync crossed awaits
    and re-resolved the book names afterward — a chat switch mid-flight let
    the remaining work target the newly active chat's books. Both operations
    now capture the scope and BOTH book names before any mutation, relabel
    the captured names only, and re-verify the scope
    (`core/scope.js scopeStillCurrent`) after every await, dropping the
    remaining lorebook work with an explanatory warning on drift.
  - **Refused evidence writes are no longer reported as successes.**
    `saveEvidenceMap()` now returns a checked result for every refusal
    (`store-paused` / `invalid-store` / `store-replaced` / `validation-fatal`
    / `quarantine-refused`), and `renameEvidenceFile()` / `mergeEvidenceFiles()`
    propagate it (`save-refused:<why>`) so a rename/merge warns that the
    evidence stayed under its old name instead of silently stranding it. A new
    `canRekeyEvidence()` preflight also refuses the rename/merge BEFORE the
    registry is rekeyed when the evidence store cannot accept writes —
    evidence-less NPCs are never blocked.
  - **Merges no longer create self-relationships.** Edges between the two
    merged identities (`Sophie → Sophie Simpson` and the reverse) and a
    pre-existing self-edge on the absorbed record used to become
    `survivor → survivor` edges in every managed block;
    `mergeRelationshipIdentities()` drops them (counted as `edgesDropped`).
    A pre-existing self-edge on the SURVIVOR predates the merge and is kept.

- **Per-field dossier refresh + paused-chat follow-ups** (each pinned by new
  tests in `test/dossier_field_refresh.test.js`): the 🎯 Fields picker's
  "nothing new" detection borrowed the Update path's null-check idiom, but
  `DOSSIER_FIELD_REFRESH_PROMPT` *echoes* unchanged values instead of
  returning null — so an ordinary no-change refresh staged a byte-identical
  diff and the nicer "marked re-verified" branch (the one that stamps the
  watermarks fresh) almost never fired; change detection now compares the
  merged entry against the current one. The run flow's two shortcut exits
  called `modal.remove()` directly, leaking one document-level Escape listener
  per refresh run — they now go through the opener's `cleanup()`, the modal
  carries `_cleanupKeyHandler` (the core/modal.js convention), and both
  chat-change sweeps detach it too. `deleteDossierFieldStatus` skipped the
  Part 6 pause guard its stamp sibling has, so removing an NPC while the
  counters store was paused would validate and commit an unprepared store
  value — deletes are write seams too (same contract as `saveEvidenceMap`),
  and that refusal branch now has test coverage. Double-clicking 🎯 Fields
  before its awaited lorebook read resolved stacked two picker modals with
  the same id (button disabling for the open, plus a singleton guard).
  `onChatChangedWhilePaused` also reset everything except the session
  relationship-change log — the one thing `onChatChanged` flags as
  "actively misleading" when stale — it is cleared with the same stroke now.

- **Relationship change-log polish** (tests in
  `test/relationship_extract.test.js`): a notes-only edge update (same
  relationship type, new notes) rendered as "Mara → Jonah: friend (was
  friend)" — the "(was X)" tail now only appears when the type actually
  changed, letting the notes fall through instead. Removing an NPC from the
  registry silently wiped its relationship edges and stance with no entry in
  the 🕘 Recent Changes panel, against its "full session audit" claim — the
  wipe (and the stance clear beside it) is now logged like every other manual
  mutation, and the per-field watermark cleanup beside it is wrapped so a
  bookkeeping throw can never fail the removal itself.

## [2.1.1]

### Fixed

- **Off-Screen Events cross-module fallout** (the three v2.1.1
  items; each pinned by new tests in `test/strip.test.js`,
  `test/interiority.test.js`, and `test/recent_scan_exclude.test.js`):
  - **[P1] Invisible execution has no receipt and will repeat**
    (`interiority/prompts.js` `INJECTION_HEADER`). When no Off-Screen Events
    module existed, the narrator was told to "let it happen invisibly
    off-screen" — nothing entered chat history, Interiority had no evidence
    to mark the intention executed, and the injection demanded it again every
    turn. The header now requires the narrator to CREATE the details block
    ("Off-Screen Events") when absent and log the completed action in it:
    the log line is the machine-readable execution receipt the evaluation
    prompt already recognizes, so the execute → evidence → close loop always
    closes. Invisible execution is now explicitly forbidden.
  - **[P1] Rich Thoughts can read sealed off-screen events**
    (`interiority/prompts.js` `buildThoughtsSystemPrompt`). Preserving
    Off-Screen Events blocks changed what the split-thoughts call sees, but
    its prompt still treated all of `<recent_messages>` as shared witnessed
    history — every roster NPC could react to sealed events. The INPUT
    PARTITION rule now states the block is sealed: a logged line happened
    only for the acting NPC and any NPCs the line explicitly names as
    witnesses. The unified prompt's witness rule was aligned to permit the
    acting NPC as well (the old "named as witnesses" wording sealed the
    actor's own action from the actor).
  - **[P1] Shared preservation can contaminate Knowledge ledgers**
    (`core/strip.js`). The shared sanitizer's off-screen exception exposed
    the sealed block to Knowledge, whose scan/update/enrichment prompts have
    no actor/witness semantics — an unwitnessed event mentioning another NPC
    could be recorded as knowledge that NPC learned. Preservation is now an
    explicit per-consumer option (`preserveOffScreen`, default `true`), and
    every Knowledge call site (lorebook scan/update/enrich windows, growth
    evidence capture + quote verification) passes `false` so the sealed block
    strips like any other details block. World State, Chronicle, Story
    Planner, and Interiority keep ingesting the block by default.
- **Manual 🔄 Refresh no longer fans out into N sequential LLM calls for users
  who never enabled delta mode** (`world_state/refresh.js`). The chunked
  catch-up upgrade (v2.1.1) fired for EVERYONE whose refresh watermark had an
  uncovered gap — with shipped defaults (deltaMode off, autoRefresh off), one
  🔄 click after a long roleplay session could chain 8–12 uncapped full
  generations with no opt-out and no per-pass progress. The upgrade is now
  gated on `isDeltaModeEnabled()`: delta users keep the honest gap replay,
  while the default profile keeps the plain one-click/one-generation refresh
  over the `maxScanMessages` window it configured. Catch-up runs are
  additionally capped at 8 generation passes per run (delta users included) —
  the stop is honest (each pass stamps the watermark where its chunk ended)
  and a status message says to click Refresh again to continue the replay.
  Pinned by new tests in `test/world_state_delta.test.js`.
- **The intentions-only split-call prompt now carries the off-screen
  partition rule** (`interiority/prompts.js`). The actor/witness rule lived
  only in the thoughts branch, but `runSplitCall` runs intentions as its own
  call whose message window still preserves the sealed Off-Screen Events
  block — so "NEW INTENTIONS REQUIRE CURRENT EVIDENCE" could read an
  unwitnessed off-screen log line as a valid motivating event for any roster
  NPC (the same leak class the thoughts side sealed). The partition rule is
  now shared by both branches. Pinned by a new test in
  `test/interiority.test.js`.
- **Automatic relationship extraction now strips its evidence window**
  (`knowledge/relationships.js`). It read the last 50 settled messages raw —
  every `<details>` block included, sealed off-screen log included — making
  it the one Knowledge call site that did not pass
  `{ preserveOffScreen: false }` (an unwitnessed off-screen meeting could
  seed a false relationship edge). It now strips like every other Knowledge
  call site, `core/strip.js`'s consumer list reflects it, and the test stub
  mirrors `getRecentMessages`'s `strip`/`preserveOffScreen` options. Pinned
  by a new test in `test/relationship_extract.test.js`.
- **Delta patch protocol round-out** (`world_state/delta.js`):
  - `buildRefreshStatusDelta`'s JSDoc no longer claims `msgIndex` is "current
    chat length" — it is the stable-history end (the whole point of the
    watermark fix).
  - `parseDeltaPatch` matches every marker regex against the trimmed line: an
    indented `### UPDATE:` used to die as a preamble error while an indented
    `### NO CHANGES` parsed fine. Indented unknown ALL-CAPS markers are still
    rejected.
  - `applyDeltaPatch` re-inserts a previously-omitted section at its canonical
    `SECTIONS` position instead of appending it at the document's end, so
    patched documents no longer drift from template order until the next full
    reconciliation.
- **Guard + UI polish**: `refreshWorldStateDelta` also refuses while a
  catch-up loop is active, mirroring `refreshWorldState`'s guard (defensive:
  the loop currently never yields between passes, but one added `await` would
  open the gap). The ⚡ Delta button's `finally` re-derives its disabled state
  via `updateArchiveButtonState()` instead of unconditionally enabling — the
  editor-pre-sync refusal early return no longer leaves it clickable on an
  empty document.

### Changed

- All references to a temporary bug-list working file were removed from code
  comments, test titles, and this changelog — the file was never part of the
  repository, so every citation was a dead pointer. Each comment now carries
  its rationale inline (e.g. "the frozen-evidence rule", "the
  watermark-preservation rule").

## [2.1.0]

### Fixed

- **Delta mode hardening** (bugs found in the §3-F review pass):
  - **The delta scan is now built from the refresh watermark, not the latest
    `maxScanMessages`** (`getMessagesSinceForScan()` in
    `world_state/refresh.js`). Previously an on-demand ⚡ Delta after a longer
    gap silently omitted the oldest unseen events and then stamped the
    document as freshly updated — hiding the gap forever. When the whole
    unseen interval cannot fit inside one scan budget (message count OR the
    20k-character cap), the delta declines BEFORE spending a call: scheduled
    runs fall back to a full refresh in the same cycle, manual runs get a
    `DeltaPatchError` pointing at 🔄 Refresh.
  - **Refresh watermarks record where the scan actually ends.**
    `deltaStatus.lastRefreshAtMsg` now stamps the stable-history end
    (`getStableHistoryEnd()`) for full refreshes, deltas, and section regens —
    not chat length, which includes the configurable in-flight tail that is
    never scanned. `deriveDocumentStatus()`/`getDocumentStatus()` compare
    like-for-like, so the in-flight tail no longer counts toward staleness.
  - **Manual edits keep their status.** `refreshWorldStateDelta()` previously
    only checked that a baseline digest existed; since the ⚡ Delta button
    pre-persists live editor changes, an edited document could pass, get
    patched, and receive a fresh digest covering the whole document —
    appearing merely delta-updated although its manual content was never
    reconciled. The precondition now compares digests: manual runs are
    rejected with a pointer to the full Refresh, auto runs escalate to one
    (same policy as `planAutoRefresh`'s `manual-edits-since-refresh`).
  - **Partial updates no longer clear the manual signal.** New
    `buildPartialRefreshStatus()` (`world_state/delta.js`), used by both the
    delta writes and section regeneration, stamps a fresh digest ONLY when the
    incoming document still matched its previous refresh digest. When other
    sections carry manual edits (or the document is a legacy import with no
    baseline), the old digest is kept — the document keeps reporting ✏️
    manually edited until a full refresh reconciles it — while the refresh
    kind, watermark, and reconciliation cadence still advance.
  - **Patch markers can no longer leak into section content.**
    `parseDeltaPatch()` recognizes protocol-looking ALL-CAPS markers BEFORE
    body accumulation (inside operations too, not just in preamble position),
    rejects `### NO CHANGES` mixed with any operation (before, between, or
    inside one), rejects content attached to `### REMOVE`, and rejects
    duplicate operations for the same section. The delta OVERRIDE prompt now
    states those rules explicitly so first-attempt compliance improves.
- **Delta mode + refresh follow-up fixes** (each pinned
  by new tests in `test/world_state_delta.test.js`):
  - **[P1] Section regeneration no longer advances the global watermark**
    (`world_state/sections.js`). It reconciled exactly ONE section but stamped
    `lastRefreshAtMsg` at the stable-history end, so the next delta started
    after that point and permanently skipped messages that had changed OTHER
    sections. A partial update now re-stamps the PREVIOUS watermark; the next
    delta re-scans the intervening messages cheaply (at worst answering
    "### NO CHANGES" for the already-regenerated section), and a full refresh
    or catch-up advances the watermark as usual.
  - **[P1] The oversized-gap fallback now actually covers the skipped
    interval** (`world_state/refresh.js`). It used to call a plain full
    refresh, which reads only the latest `maxScanMessages` and then stamps the
    document reconciled through the current scan end — permanently hiding the
    oldest unseen messages. A full refresh now detects when the last watermark
    sits before the sliding window's start and upgrades itself to a chunked
    CATCH-UP (`runCatchUpWorldStateRefresh`): the unseen interval is replayed
    through the model oldest→newest in budget-sized passes (each ≤20k
    characters, each pass building on the previous document), and every pass's
    checked write stamps the watermark where ITS chunk ended — partial
    progress is honest, and a failed later pass never stamps over the
    remaining gap. A message too large for any window is handled by the
    truncation-with-marker rule of the round 3 group below.
  - **[P2] Grounding now checks the exact window the model saw**
    (`world_state/refresh.js`). The delta patch was generated from the
    watermark-derived scan window, but the grounding gate re-read the sliding
    latest-N window after the API await — messages arriving mid-await could
    push the oldest evidence out of the re-read, stripping or rejecting
    legitimate patch content. Validation now uses the generation window
    verbatim (the full refresh and section regeneration freeze their scan
    text before the first await for the same reason — retries, grounding,
    and catch-up passes all reuse it).
  - **[P2] A valid zero watermark goes stale again** (`world_state/delta.js`).
    A full refresh in a short chat legitimately records stable-history end 0;
    treating 0 as "no watermark" left `msgsSinceRefresh` null forever, so the
    document never reported stale as settled messages accumulated. The
    missing-digest branch already distinguishes never-refreshed documents, so
    the difference is now computed from zero normally.
- **Catch-up honesty fixes** (each pinned by new tests
  in `test/world_state_delta.test.js`):
  - **[P1] A message too large for any window is scanned truncated, never
    skipped-and-stamped** (`world_state/refresh.js` `nextCatchUpChunk()`).
    When one message's scan line alone exceeded the 20k-character budget, the
    catch-up advanced `to` past it without including any of its content — the
    following pass/status write then stamped a watermark beyond that message,
    and the document could report fully reconciled despite never processing
    it (a console warning is not coverage). The chunk now carries the
    message's leading portion with an explicit partial-coverage marker
    (`[…partial message — … leading portion only]`), so the model reconciles
    what fits and can see the coverage was partial; progress no longer
    depends on stamping over unscanned content.
  - **[P1] Catch-up replays a frozen target, not a moving one**
    (`world_state/refresh.js` `runCatchUpWorldStateRefresh()`). The loop
    recomputed the stable-history end after every API pass, so messages that
    kept settling while a long catch-up ran extended the target and queued
    additional full-generation passes with no fixed upper bound. The target
    end is now captured once when the catch-up begins (the live end can only
    ever LOWER it, if the chat shrank mid-replay); messages settling
    afterwards stay beyond the final watermark and are covered by the next
    (cheap) delta cycle.

### Added

- **Low-cost delta mode for World State** (TODO §3-F; source:
  `Audit_Reports/Potential_Improvements.md` §3). Full refreshes are expensive —
  auto-refresh now has an incremental mode that asks the model ONLY for the
  sections that changed and applies a strictly validated patch.
  - **New module `world_state/delta.js`** (leaf, mirrors provenance.js):
    the patch protocol (`### UPDATE: <Section>` / `### REMOVE: <Section>` /
    `### NO CHANGES` — parsed and validated against the canonical section
    list; unknown sections/markers, empty bodies, and any tampering with
    `## Current Scene` are rejected), the delta prompts (strict OVERRIDE block
    on the normal system prompt, `### Previous World State` + recent messages
    user message), and the document-status bookkeeping.
  - **Document status surfaced in the UI** (PI §3's ask): a chip next to the
    toolbar word count shows 🟢 fully reconciled / 🟡 delta-updated (×N since
    full) / ✏️ manually edited / 🔴 stale relative to chat / ⚪ empty. Manual
    edits are detected by digest comparison (`captureRevision`) against the
    last refresh's committed digest — every out-of-band write path (manual
    Save, import, revert, editor debounce persist) is covered without hook
    calls. `getDocumentStatus()` is exported from `world_state/index.js` for
    the diagnostics console / future dashboard.
  - **Periodic full reconciliation**: after `deltaReconcileEvery` (default 5)
    consecutive partial updates — deltas AND section regens, which now stamp
    the status too — the next scheduled refresh is a full one. Scheduled runs
    also route to full when there is no document yet, no refresh baseline
    (imported/legacy), or manual edits are pending. A patch that fails
    validation twice escalates to a full refresh in the same cycle instead of
    leaving the document unfreshened.
  - **Same guard discipline as the full refresh** (`refreshWorldStateDelta` /
    `runScheduledWorldStateRefresh` in `world_state/refresh.js`): busy flag,
    settings check, paused-store decline, scope assert after every await,
    same-chat revision guard, grounding gate on the patched document (strict
    discards / soft strips; no extra retry — cost is the point), and ONE
    checked write carrying text + history snapshot + status atomically.
    Status rides the store as `deltaStatus` (unknown-key passthrough — no
    schema change; backup/restore carries it automatically). New `removeSection()`
    in `world_state/data.js` (twin of `replaceSection`) backs `### REMOVE`.
  - **Settings + UI**: `deltaMode` (off by default), `deltaReconcileEvery`,
    `deltaStaleAfterMsgs` in a new "⚡ Delta Refresh (Low-cost Mode)" settings
    block, plus a ⚡ Delta toolbar button for on-demand incremental updates.
    Tests: `test/world_state_delta.test.js` (52 tests).


## [2.0.0]

### Fixed

- **Five Part 7 follow-up bugs** (found in post-Part 7 review; each pinned by
  new tests in `test/settings_schema.test.js` and
  `test/secondary_persistence.test.js`):
  - **[P1] Duplicate `mwt_uuid` stamps no longer alias messages**
    (`interiority/data.js`). A non-empty stamp was trusted without checking
    whether another message already owned it, so `getOrCreateMsgKeyForIndex()`
    handed two messages the same `mu-*` key and `buildKeyToIndexMap()`
    silently kept the last one — exactly the collision UUIDs exist to prevent
    (`validateMessageUuids()` detected it with no production caller). The
    seams now enforce first-owner-wins: the first occurrence keeps the stamp,
    a later duplicate is restamped with a fresh UUID at the write seam and
    reported once per session (`schema_repaired`, code
    `message-uuid-duplicate`); reads (`getMsgKeyForIndex`) fall back to
    `send_date` for a non-owner duplicate, and `buildKeyToIndexMap()` maps a
    duplicate `mu-*` key to its first occurrence only.
  - **[P2] Invalid JSON in a settings record now produces its diagnostic
    event** (`core/settings.js`). `JSON.parse` ran before validation and the
    outer catch only logged a console warning, so a truncated localStorage
    record fell back to defaults with no `schema_settings_invalid` event.
    Parse failures are now converted into a content-safe structured finding
    (new `settings-record-unparseable` code in `core/settings_schema.js`),
    deduplicated once per session per code like every validator finding —
    on both the main-key and the legacy-key paths.
  - **[P2] Legacy reads no longer silently downgrade future-version
    settings** (`core/settings.js`). The one-time legacy migration stamped the
    current version and wrote the record merely because `getSettings()` ran —
    a v99 record could become v1 on a read. The migration is now skipped
    entirely for `future-version` results, matching the main-key path's
    §12 no-silent-downgrade guarantee (a deliberate save remains the ordinary
    downgrade path).
  - **[P2] Global settings reads are validated** (`core/settings.js`).
    `getGlobalSettings()` returned the raw persisted object — unvalidated, and
    leaking the persistence-internal `schemaVersion` marker to injection
    placement, panic gating, API fallback, and diagnostics. It now routes
    through a dedicated settings manager (the shared canonical accessor):
    root/version validated, fail-open findings, marker stripped. Its defaults
    catalog is deliberately empty — consumers distinguish "user set a global
    value" from "not set" (the global-wins depth precedence), so the accessor
    must not materialize type-defaults; the field-level catalog stays with the
    manager index.js uses to save.
  - **[P2] Knowledge edit-history findings are reported**
    (`knowledge/lorebook.js`). `validateHistoryRecords()` findings were discarded
    (`getHistory()`/`pushHistory()` kept only `.data`), so no
    `schema_quarantined` event ever fired despite the Part 7 diagnostics
    claims. Findings now surface once per session per store+code, and an
    unparseable key reports the root finding instead of vanishing into a bare
    catch. The dedup is keyed on the STORE as well as the code because history
    keys are namespaced per book AND per uid (`kt_history_<lorebook>_<uid>`) —
    deduping on the code alone (the single-key float-position pattern) would
    let the first malformed record silence every other corrupted key for the
    session, reinstating most of the gap this fix closes.
- **The all-message thought render no longer re-scans the chat per key**
  (`interiority/render.js`). The duplicate-stamp guard added to
  `getMsgKeyForIndex()` made it O(chat) per call, and
  `renderAllThoughtBlocks()` invoked it once per perMessage key after
  having already resolved key → index through `buildKeyToIndexMap()` —
  O(keys × chat) per CHAT_CHANGED render (~14ms at 5000 messages / 1500
  keys). The loop now hands the key it already resolved to
  `renderThoughtBlockForMessage(idx, key)` (new optional second parameter;
  omitted → resolved from the index exactly as before). One deliberate
  display-only semantic: a legacy `sd-*` entry whose message also owns a
  stamped uuid now renders under the key that resolved it instead of being
  hidden by the re-resolve preferring the (possibly empty) `mu-*` key. The
  one-time migration loop (`migrateIndexKeys`) keeps resolving per legacy
  key — it runs once per chat and only pays the scan for messages that
  already carry stamps.
- **`getGlobalSettings()` JSDoc no longer overstates the copy**
  (`core/settings.js`). It claimed "a fresh copy — never the live persisted
  reference", true at the top level only: `validateStoredSettings` assigns
  non-scalar values by reference and the manager's spreads are shallow, so
  nested objects (`bookBindings`, `activation`) are shared references into
  the persisted record. The doc now says so and tells callers to copy a
  nested object before writing to it — nothing relied on the old wording.
- **Three second-round review bugs** (re-review of the fixes above; pinned by
  new tests in `test/settings_schema.test.js` and
  `test/secondary_persistence.test.js`):
  - **[P1] Global settings field types are now validated**
    (`core/settings.js`). The canonical accessor's deliberately-empty
    defaults catalog left `validateStoredSettings` with no scalar type
    catalog, so malformed present fields passed through unchanged — a
    hand-edited `injectionMasterOff: "false"` (a truthy string) silently
    stopped every module via `injectionAllowed()`, with no finding.
    Validation defaults are now separated from public default-merging: the
    real field-level catalog (new exported `GLOBAL_SETTINGS_DEFAULTS`, now
    also the single source of the Settings tab's defaults in `index.js`)
    validates present fields through two new `createSettingsManager` options
    (`validationDefaults` + `resetToAbsent` in `core/settings_schema.js`:
    numeric strings coerce, an unusable value is treated as *not set* — so
    nothing materializes and the absent-field precedence contract holds).
    Schema-event dedup also moved from per-manager to per-STORE, so the two
    managers reading `merged_world_tracker` no longer double-report the
    same store+code.
  - **[P2] Invalid float-position JSON now reports its finding**
    (`core/ui.js`). `JSON.parse` failures bypassed `validateFloatPositions()`
    and returned `{}` from a bare catch — `mwt_float_positions` was the one
    secondary store still silently swallowing an unparseable record. A parse
    failure now reads as the fatal root result
    (`float-positions-root-not-object`, surfaced once per session through
    the severity-mapped event) before the empty live view is returned —
    the same promise settings and Knowledge edit-history already make.
  - **DATA_SAFETY_GUIDE recovery steps corrected.** The backup `sections`
    entries are wrappers, so a recovered record's `path` applies beneath
    `sections[store].data` (`knowledgeStore` uses `storeVersion`) — the old
    wording could lead users to place the record next to `data`, where
    restore silently ignores it. The recovery-clear commands are also now
    documented as chat-local only: Knowledge records embedded in lorebooks
    need `includeKnowledgeStore: true`, which empties every currently
    hydrated book's embedded container (un-hydrated books keep theirs).

### Added

- **Schema validation + migrations — Part 7 (final): secondary persistence,
  documentation, and the 2.0 release** (design §2.2/§11 of the schema
  validation plan — the coverage pass over everything MWT owns that is NOT
  a chat-metadata/lorebook store, plus the release decision).
  - **Settings schema/version support — `core/settings_schema.js`** (pure,
    same structured-issue vocabulary as the store validators). Every
    settings record read through `createSettingsManager()` — global and all
    five module managers, automatically — is now validated and versioned:
    the persisted copy carries an internal `schemaVersion` marker stamped
    on save (never leaked into `getSettings()`, whose
    `{ ...defaults, ...saved }` contract is unchanged); reads are
    non-destructive (the stored record is the recovery copy) and repairs
    converge on the next save. Policy is deliberately FAIL-OPEN where a
    store would fail CLOSED: settings are config, not chat data — an
    unreadable record falls back to defaults with a finding, a
    future-version record is read as-is and never rewritten by a read
    (§12's no-silent-downgrade rule; a deliberate save on the older build
    is the ordinary, field-preserving downgrade path), type mismatches
    repair (numeric strings coerce, unusable values reset to default,
    booleans are never coerced from strings), and unknown keys are
    retained. No raw record is embedded in issues — settings can carry API
    keys, and the storage itself is the recovery copy. A manager can
    override via the new `schema: { version, validate }` option.
  - **Secondary local-storage + message-UUID validation —
    `schema/secondary.js`** (pure; the one owner of §2.2's remaining
    bullets: `mwt_float_positions`, `kt_history_*`, and `msg.extra.mwt_uuid`
    stamps). Policy is read-side repair in the same issue vocabulary:
    validators return the canonical live view, the stored raw value is
    left untouched, and no prose is embedded in findings (edit-history
    content is user prose). Wired at the seams: `core/ui.js
    loadFloatPositions()` drops invalid entries and retains
    unknown-button ones (the next drag rewrite converges the key);
    Knowledge edit history (`knowledge/lorebook.js getHistory()/
    pushHistory()`) filters malformed records on read and stops copying
    them forward on the next push; and Interiority's UUID seams
    (`getMsgKeyForIndex` / `getOrCreateMsgKeyForIndex` /
    `buildKeyToIndexMap`) now validate stamps before trusting them — a
    malformed `mwt_uuid` is treated as absent (send_date fallback) or
    restamped, so garbage keys like `mu-123` can no longer address a
    message. `validateMessageUuids(chat)` is the read-only diagnostic for
    malformed/duplicate stamps.
  - **Diagnostics visibility** — the §9.3 event set gained
    `schema_settings_invalid` (a stored settings record was unreadable and
    its module fell back to defaults; settings fail open, nothing pauses)
    and the Part 7 seams reuse `schema_repaired`,
    `schema_blocked_future_version`, and `schema_quarantined`. Which event a
    secondary-persistence finding reports as follows its SEVERITY, via the
    shared `schemaEventForSeverity()` in `core/schema_status.js`: a
    QUARANTINE or a FATAL root drops the record from the live view with the
    raw left in storage (`schema_quarantined`), but a REFERENCE finding — a
    dangling entry that is RETAINED, like a saved position for a button id
    this build no longer has — reports as `schema_repaired`, because logging
    it as a quarantine would tell the user data was set aside for recovery
    when nothing was removed. Every finding is reported ONCE per session per
    store+code — `getSettings()` is a hot path and history reads are frequent,
    so the ring is never flooded — and all of them surface in the 📋 Log tab /
    Copy Report like every other schema event.
  - **Documentation** — README's "Data safety in MWT 2.0" section and
    DATA_SAFETY_GUIDE.md updated from "planned" to shipping (including the
    new settings/local-storage coverage); the Diagnostics guides note the
    new log events; BACKUP_RESTORE_DESIGN.md notes that the
    not-backed-up browser-local records now carry validation coverage; the
    main TODO ticks the schema subsystem off.
  - Coverage: `test/settings_schema.test.js` (32 tests — the pure
    validator, version stamping/refusal, the no-leak contract, event
    dedupe, legacy migration) + `test/secondary_persistence.test.js`
    (22 tests — the three validators, float/history convergence, and the
    UUID seams), plus `core/settings_schema.js` and `schema/secondary.js`
    added to the static purity guard in `test/schema_engine.test.js`.
- **The 2.0 version decision** — per the plan's versioning note ("Only
  Part 6 changes runtime behavior… decide the version at Part 7"), the
  Part 6 runtime cutover earns the major bump: `package.json`,
  `manifest.json`, and `core/version.js` move to **2.0.0** together. What
  the 2.0 data layer means for users, in plain language, is
  DATA_SAFETY_GUIDE.md.

## [1.8.6]

### Added

- **Schema validation + migrations — Part 6: the runtime chat-metadata cutover**
  (design §7 of the schema validation plan — the step that makes the schema
  manifest authoritative at runtime; the risky part everything before it made
  survivable).
  - **`schema/runtime.js applySchemaLoadGate()`** — the §7.4 synchronous flow,
    run on EVERY startup (before the five `init(null)` calls) and chat change
    (inside the `CHAT_CHANGED` handler, after `bumpEpoch()`, adding **no
    await**): the pure fast gate classifies every present chat-metadata store,
    `prepareStore()` runs the migrations for prepare stores, and the migrated
    data, the manifest version stamp, and any quarantine additions land in the
    SAME `chat_metadata` object behind ONE persist call (§7.3 — a dropped
    debounced save re-runs idempotently and can never leave "manifest says v1,
    data is v0"; a throwing persist is recorded via `schema_persist_failed`,
    never fatal). A READY chat writes nothing — the §7.2 fast path adds no
    save. Blocked stores (future version, unreadable root, quarantine
    container refusal, manifest from a NEWER MWT) pause ONLY their module and
    keep the untouched original as the recoverable state; a healthy later load
    clears a stale pause.
  - **A paused module declines its own work (§7.4)** — `core/event_router.js`
    takes an injected decline predicate (events are never globally queued or
    discarded; the declined module logs why); the World State / Chronicle /
    Story Planner / Interiority injection seams clear the slot instead of
    reading unprepared data; and the six write seams (World State, Chronicle,
    Story Planner, Interiority, Knowledge counters, Knowledge evidence) refuse
    while paused, so no module write validates an unprepared value at the
    current version and silently replaces it (the §12 downgrade).
  - **`core/schema_status.js`** gained the Part 6 decline checks —
    `isStorePausedForCurrentScope()`, `isModulePausedForCurrentScope()` (the
    router's predicate, handling every module-key spelling), and
    `isStoreWriteBlocked()` — plus the §7.5 privileged-preparation window that
    lets exactly the runtime gate's conversion write pass the pause it exists
    to clear.
  - **`runSchemaPreparations()`** — the §7.5 privileged path for deferred
    stores: Interiority's chat-dependent legacy per-message key conversion
    moved off its own `queueWork` (`init()`/`onChatChanged()`/
    `onMoreMessagesLoaded()` — a queued recovery job would be declined by the
    very pause it exists to clear) into orchestration that opens the
    privileged window, runs the conversion, and re-runs the gate — a clean
    result commits data + manifest atomically and resumes the module; a
    surviving deferral stays a visible **preparing** state. Scope-guarded with
    Knowledge's epoch-first semantics, so a chat switch mid-conversion
    discards the re-gate and the new chat re-derives.
  - **`registerSchemaGateRetryHandlers()`** — the §5.4 Retry button now works
    for every chat-metadata store: Retry re-runs the gate and the privileged
    preparations, and keeps the banner up when the block survives.
  - **Lazy compatibility writes retired**: Chronicle's `getSnapshots()` and
    Story Planner's `getArcs()` never persist from a read path anymore (the
    gate owns the persisted repair); both keep their in-memory read fallbacks.
  - Coverage: `test/schema_runtime_gate.test.js` (22 tests — startup,
    chat-switch sync, §7.3 one-save atomicity, per-store blocking, deferral +
    privileged conversion, chat-switch discard, persistence failure,
    idempotent re-runs, decline/write-seam guards, Retry) and the static
    purity guard extension in `test/schema_engine.test.js` (no pure schema
    module may import the runtime orchestration).

### Fixed
- **A paused module's chat-change handler was skipped ENTIRELY, leaving the
  previous chat's prompt injection active in the blocked chat** (the CHAT_CHANGED
  dispatch in `index.js`). Those handlers also perform scope-independent
  cleanup — clearing the old injection, cancelling auto-refresh/auto-generate
  and editor-persist timers, dropping Interiority's DOM thought blocks, and
  resetting transient UI state — so switching from a healthy chat to a blocked
  one kept the healthy chat's World State / Chronicle / Story Planner /
  Interiority prompt riding along. Each module now exposes
  `onChatChangedWhilePaused()`: exactly that safe half (the injection
  appliers' paused branch clears the slot), with zero reads of the blocked
  store — the hydration half stays skipped exactly as before, and the resume
  initializers still own the post-Retry re-hydration. Coverage:
  `test/paused_chat_cleanup.test.js`.
- **A Retry could resume stores whose owning modules were never
  re-initialized** (`schema/runtime.js`). One `applySchemaLoadGate()` run can
  resume several stores at once (repairing a future-version manifest makes
  every affected store ready), but the Retry wrapper only re-ran the resume
  initializer for the store whose button was clicked — the other modules
  stayed unpaused with the stale in-memory state their skipped chat-change
  hydration left behind, and their next event persisted it over the repaired
  data. The retry handler and the §7.5 re-gate now snapshot the paused set
  before the run and run every resumed store's initializer afterwards (the
  run-once-per-pause-generation memo keeps each owning module to a single
  re-hydration). Coverage: the multi-resume Retry test in
  `test/schema_runtime_gate.test.js`.
- **Resuming several stores of ONE module re-initialized it once per store id,
  overlapping the same re-hydration** (`core/schema_status.js`). The run-once
  memo for resume initializers was keyed by store id, but index.js registers
  the module's `onChatChanged()` for every store the module owns — so a gate
  run resuming Knowledge's two chat-metadata stores (with `knowledgeStore`
  resuming in the same window through its own path) invoked the same
  asynchronous reset/hydration once per store id, and the overlapping starts
  raced to rebuild the same in-memory state. The memo is now keyed by the
  OWNING module — once per pause generation per module — so whichever store
  ids a resume reports, and however many paths observe it, the module
  re-hydrates exactly once. Coverage: the same-module resume tests in
  `test/schema_runtime_gate.test.js` and `test/schema_status_surface.test.js`.
- **Manual World State generation still bypassed the pause**
  (`world_state/refresh.js`, `world_state/sections.js`). The Refresh button,
  `/wt-refresh`, and `regenerateSection()` reach their API-spending choke
  points without the event router's decline predicate, so a paused store was
  read and one or more API calls spent before the checked write finally
  refused. Both choke points now refuse first — auto refresh declines
  silently, manual paths throw the same repairable "paused for this chat"
  error the other modules use. Coverage: `test/schema_pause_bypass.test.js`.
- **Manual Knowledge scans still ran while the module was paused**
  (`knowledge/index.js`). `/wt-scan` (`triggerScan()`) and `scanAndAccept()`
  bypass the router without checking any of the module's three pause states:
  a blocked lorebook store was scanned through its blank placeholder, and a
  counters/evidence-only pause still let `scanAndAccept()` modify lorebook
  entries. Both entry points now refuse up front — `triggerScan()` throws the
  repairable error, `scanAndAccept()` returns its empty "nothing happened"
  array — before reading state or spending the API call. Coverage:
  `test/schema_pause_bypass.test.js`.
- **A PARTIAL module resume consumed the resume-initializer run-once memo too
  early** (`core/schema_status.js runStoreResumeInitializer()`). One Knowledge
  store resuming while a sibling stayed paused for the same chat ran the
  module's `onChatChanged()` initializer immediately — re-hydrating against
  the still-blocked sibling — and marked the module-keyed run-once memo, so
  when the final store later resumed WITHOUT a new pause transition the memo
  suppressed the required re-hydration and the module kept stale in-memory
  state (its next event would persist it over the repaired store). The
  initializer now runs — and the memo is only consumed — when NO store of that
  module remains paused for the current scope; a sibling paused for another
  chat/scope never defers (the pause registry is per chat/scope). Coverage:
  the partial-resume tests in `test/schema_status_surface.test.js`.
- **The NPC Growth modal survived a chat switch** (`knowledge/index.js`).
  Both chat-change paths removed only `#kt-view-modal`; `#kt-growth-modal` is
  independently appended to `document.body` and kept displaying the previous
  chat's evidence and profile — and on an unpaused destination chat its
  still-live handlers could save that old profile or edit evidence against
  the new chat's stores. Both `onChatChanged()` and
  `onChatChangedWhilePaused()` now remove it (pure DOM removal — the paused
  half still performs no store read). Coverage: the modal-drop tests in
  `test/paused_chat_cleanup.test.js`.
- **Continuous capture still bypassed the pause guard**
  (`knowledge/growth.js runContinuousCapture()`). The lower-level choke point
  every capture path flows through (Capture's delta pass, the auto cadence,
  Catch Up) was exported without `refuseIfGrowthPaused()`, so a direct caller
  could read the paused stores and spend the API call before the evidence
  write seam refused the result — the same false-success
  ("Capture complete: +1 observation" over a write that never landed) these
  guards exist to prevent. The guard now fires first, before the
  settings/registry reads; the automatic path is still declined by the router
  before it ever gets there. Coverage: `test/schema_pause_bypass.test.js`.

## [1.8.5]

### Added

- **Schema validation + migrations — Part 5: the visible paused state, diagnostics,
  and recovery export** (design §5.3/§5.4/§9 of the schema validation plan; lands
  before the Part 6 runtime cutover so the state the cutover can produce is
  already visible when it first occurs).
  - **`core/schema_status.js`** — the ONE owner of the paused-store state
    (§5.4): `pauseStore()`/`resumeStore()` plus a per-store Retry seam, so the
    module banner, 🗂️ Scope & storage, ❤️ Health, and the console can never
    disagree about the reason. ONE user notification per chat/scope — never
    repeated toasts. §9.3 schema events (`schema_store_paused`,
    `schema_store_resumed`, `schema_quarantine_cleared`, …) go through
    `recordSchemaEvent()`, whose detail allowlist makes "store/version/count
    metadata, never user prose" a structural guarantee.
  - **Knowledge lorebook hydration now pauses visibly** (`knowledge/store.js`):
    a blocked hydration (future store version, corrupt store JSON, failed book
    load, unpersistable migration) pauses `knowledgeStore`; the red banner in
    Knowledge's own tab carries the reason plus **↻ Retry** (re-runs hydration —
    privileged orchestration, not queued module work) and **⬇ Download recovery
    data**. A later load of BOTH books resumes the store — one book hydrating
    can never clear the other book's pause. New read-only accessors
    `peekStoreData()` / `getHydratedBooks()` / `clearStoreQuarantine()`.
  - **🗂️ Scope & storage** gained a **Schema status** section (§9.1): per
    registered store — stored vs. current version, the pure fast-gate
    classification (ready / will-migrate / blocked / unknown), whether a
    migration was persisted, the quarantined-record count, the Knowledge
    lorebook store's hydration + version, and the SAME pause reason the module
    banner shows. Read-only by contract. Console twin:
    `MWT.diagnostics.schemaStatus()`.
  - **🛡️ Integrity** enumerates its per-store rows from **`schema/registry.js`**
    (§9.2 — never a second list), validates the **Knowledge lorebook store when
    reliably hydrated** (a dim not-checked row otherwise — never a finding), and
    reports structured **issue codes × count @ path** alongside the reason
    strings (`backup/validate.js validateSectionWithIssues()` — one validation
    pass feeds both shapes).
  - **❤️ Health** rows carry a ⛔ PAUSED badge with the banner's exact message,
    and a paused-module banner leads the pane.
  - **Recovery export + confirmed clear** (§5.3, `backup/recovery.js`):
    **"⬇ Download recovery data"** in the Settings → Backup panel (and on every
    paused-module banner) exports every quarantined record — chat-local
    container plus each hydrated book's embedded container, deduplicated — as a
    `mwt-quarantine-export` JSON with store/path/reasonCode/raw
    record/sourceVersion/detectedAt/fingerprint: enough metadata to repair a
    record externally and re-import it through the validated Backup → Restore
    path. The clear is console-only by design, with a literal confirmation
    token: `MWT.recovery.clear({ confirm: 'CLEAR' })` (per-store filter and
    embedded-container clearing opt-in); `MWT.recovery.status()` /
    `MWT.recovery.export()` complete the namespace.
  - The 📋 Copy Report gained a **Schema status** section (safe output: metadata
    by construction, redaction-gated). Coverage:
    `test/schema_status_surface.test.js` (65 tests).

### Fixed
- **Character/chat scopes resolved the WRONG books in Schema status,
  Integrity, and the recovery export** (the `resolveKnowledgeBooks()`
  identity source, now in `knowledge/scope.js`). The two-book resolver was
  fed the `core/scope.js` identity flavours — whose `getCharacterIdentity(ctx)`
  requires a context argument (called with none it ALWAYS returned null →
  character scope fell back to inspecting the GLOBAL books) and whose
  `getChatIdentity()` returns `{ chatId, characterKey, groupKey }` with no
  `.key`/`.name` the explainer reads (chat scope mis-resolved the same way).
  Schema status and Integrity therefore inspected the global books under a
  character/chat scope, and — once the recovery export's fail-closed §5.3
  guard consumed the same resolver — every export under a non-global scope
  would have blocked forever on global books the chat never hydrates. The
  resolver and the `explainBookResolution()` mirror it builds on now live in
  `knowledge/scope.js` beside `resolveBookNames()` (so `backup/` no longer
  imports from a UI panel module — diagnostics and backup both import
  downward), using knowledge/scope.js's zero-arg `{ key, name }` identity
  helpers. Coverage: the character-scope export test in
  `test/schema_status_surface.test.js` (every suite previously exported only
  under `scope: 'global'`).
- **Schema status banner: healthy Knowledge books never counted as ready**
  (`diagnostics_panel/schema_status.js`). `totals.ready` summed only the
  chat-metadata store rows, so two loaded books rendered beside "✅ Schema
  status: 0 ready · 0 to migrate · 0 blocked" while `blocked` DID count a
  failed book — a book could appear on the blocked side of the banner but
  never the ready side. A loaded book now counts as ready; it is at the
  current version by construction (hydration migrates and persists before the
  slot hydrates — an un-persistable migration blocks the load), which is also
  why "to migrate" deliberately gains no book term.


## [1.8.4]

### Added
- Diagnostics: every captured API call now records **what caused it**. The
  `api_call` telemetry carries a `trigger` (`message_received` / `swipe` /
  `edit` / `manual` / `slash_command`, plus a `:dormant_poll` suffix for the
  §20 poll's second call in the same turn) and `panic` — the state of the
  master switch at the moment the request *fired*, not when it returned. The
  Last-request tab shows both, with ⛔ next to a trigger whose request left
  while the panic switch was already on.
  Why: a "panic is on and Interiority is still spending tokens" report could
  only be diagnosed by subtracting `durationMs` from `at` and lining the result
  up against neighbouring `injection_applied` timestamps to infer the entry
  point. Interiority has five entry points with three gating rules, and two of
  them (💭 Generate and `/wt-thoughts`) pass `force: true` and bypass the panic
  gate *by design* — so "a call fired during a panic window" is not by itself a
  bug, and the trigger is the whole diagnosis. `panic` separates a gate leak
  (request left after the switch was on) from a call that was merely still in
  flight when the user flipped it.
- Interiority: a gated generation now records a `generation_blocked`
  diagnostics event naming its trigger. Previously a panic window produced no
  interiority evidence at all, so "the gate held" and "the module never ran"
  were indistinguishable in a user's screenshot.
- Covered by `test/interiority_trigger_telemetry.test.js` (every entry point
  stamps its own trigger, and the trigger never changes behaviour) and new
  cases in `test/api_diagnostics.test.js` (fire-time panic capture, trigger
  absent for modules that don't report one).
- Prompt for Knowledge Tracker enforcement: plans/intentions were being entered as knowledge ledger items
- Prompt for Interiority enforcement: Regards knowledge_ledger as background information, not to be reused as intentions


## [1.8.3]

### Fixed
- Added a panic gate for interiority to stop it from making API calls on swipe. Note: The Generate button CAN still make calls while panic is active.
- Knowledge Tracker: relationship graph "Scroll to zoom" (and background-drag
  panning) never visibly worked. `wireRelationshipGraphInteractions` seeded its
  pan/zoom state from `svg.viewBox.baseVal.w/.h`, but `SVGRect` exposes
  `width`/`height` — there are no `w`/`h` properties — so the state started as
  `{w: undefined, h: undefined}` and the first wheel/pan event wrote an invalid
  `NaN NaN NaN NaN` viewBox that browsers silently discard, leaving the graph
  stuck at its previous zoom. The state is now parsed from the viewBox
  attribute (`x y w h`) instead. Covered by
  `test/relationship_graph_zoom.test.js`, whose fake `SVGRect` faithfully
  exposes only `x/y/width/height`.


## [1.8.2]

### Added

- Schema Validation (Part 4) — the Knowledge lorebook store's hydration is
  now schema-owned and fail-closed (design §6.7 of the schema validation
  plan). `hydrateBook()` runs parse → version gate → migration → validation
  through the same `prepareStore()` runner backup/import uses, and only then
  sets `hydrated = true`; a store written by a NEWER MWT is refused untouched
  (previously any non-number version was silently re-stamped, and a future
  version loaded writable). Legacy `chat_metadata` seeds are validated BEFORE
  adoption — rejected records land in the book's embedded quarantine
  container, persisted by the same save as the migrated data — and the
  commit, quarantine merge, and flush run as one critical section under the
  store lock: a failed flush rolls the cache back wholesale, so the untouched
  on-disk store stays the recoverable state, the book stays un-writable, and
  the idempotent migration simply retries on the next load. The §6.7 record
  contract is complete: `profileUid` null-or-non-negative-integer checks,
  relationship-edge and stance-source provenance enums, NPC-registry
  normalized-name collision pruning (first key wins, colliders preserved
  whole in quarantine — the State Tracker registry is exempt, since its
  accessors are exact-key lookups and two case-differing names are two real
  trackers), relationship-target reference findings (retained, not
  rejected), and the `[MWT:store]` ghost removal recorded as a repair inside
  the 0 → 1 migration instead of a silent in-place scrub. A cache reset that
  lands between hydration's read and its commit retires the slot and the
  commit abandons quietly, rather than reporting a persistence failure the
  store was never in. Coverage: `test/knowledge_store_hydration.test.js`.

## [1.8.1]

### Fixed

- **A future schema manifest aborts the export visibly instead of relabelling
  future-format stores as legacy data** (`backup/collect.js`, `backup/index.js`).
  `getStoredStoreVersion()` deliberately reads a manifest from a newer MWT as
  "legacy 0" so defensive displays stay usable — but `collectBackup()` used that
  same reading to stamp the backup's section wrappers, so a chat whose manifest
  declares `manifestVersion: 99` exported successfully with every section
  stamped `schemaVersion: 0`. Restoring that file made this build run the legacy
  0 → 1 migration over future-format data instead of refusing the unknown
  version, potentially discarding fields or records. The collector now detects
  `isFutureManifest()` and cancels the export with an explicit error, exactly as
  it already does for unreadable future quarantine containers, and the restore's
  `manifest-version-future` refusal now runs before its pre-restore snapshot
  export so a refused restore reports the designed refusal rather than the
  export's abort (and downloads no snapshot for a restore that cannot proceed).

Eight fixes from the fifth audit pass over Parts 1–3 (regression coverage in
`test/schema_audit_round5.test.js`):

- **A backup taken from a legacy chat no longer restores empty**
  (`backup/collect.js`, `backup/data.js`, `backup/validate.js`). The export
  stamped each section wrapper with its descriptor's `currentVersion` while
  `collectBackup()` read the stores RAW — but the runtime cutover that stamps
  the manifest is Part 6, so every live chat's stores are still at legacy 0.
  The wrapper therefore told the importer "already migrated", `prepareStore()`
  skipped the 0 → 1 step, and the v1 validator refused exactly what that
  migration exists to repair: a legacy Chronicle round-tripped with **zero**
  snapshots (every id-less record quarantined) and a legacy Story Planner with
  no arcs at all. The collector now reports the version each store is actually
  at, read from the chat's manifest through `getStoredStoreVersion()` (missing
  ⇒ 0), and `validateBackupEnvelope()` accepts 0 for chat-metadata sections —
  it previously refused it as "not a positive integer", which made the entire
  legacy path unreachable across the backup wire even though the migrations
  had shipped in Part 2. The lorebook store keeps a floor of 1 (its version
  lives inside the store, not the manifest). **Compatibility note:** a backup
  containing legacy sections is refused by an older MWT with a per-section
  version error rather than silently mis-restored; backups from already-stamped
  chats are unchanged and stay readable.
- **A deferred store no longer drops the records its canonical value removed**
  (`core/schema.js`). `prepareStore()` returned before collecting quarantine
  items whenever a DEFER finding was present. That is right for the default
  `pause` policy — the original is kept untouched — but the import/restore
  boundary passes `deferPolicy: 'canonicalize'` and commits the canonical
  value, which has already dropped everything the validator rejected. So an
  import of an Interiority store with legacy per-message keys (the exact
  population deferral exists for) plus any invalid ledger entry, tombstone, or
  `turnCounter` listed those records in `summary.skipped` and then lost them:
  canonical data committed, quarantine list empty. Both exits now run one
  shared `preserveDetected()` helper, so a deferral suspends the version stamp
  and nothing else — the §5.2 preservation, and the storage-ceiling refusal
  that blocks rather than dropping, apply identically.
- **Interiority reads stage their working copy instead of deep-cloning per
  call** (`interiority/data.js`). The fourth pass's detach fix made
  `getInteriorityData()` clone the whole store on every read, and every read
  accessor goes through it. On a 400-message chat whose `perMessage` entries
  carry the usual per-message `ledgerSnapshot` (~3 MB store) that measured
  ~46 ms for a single `getLedger()`, 564 ms to open the Interiority tab (20 ×
  `getPerMessage`) and 334 ms to build a generation prompt (one
  `getRecentThoughtsForNpc` per roster NPC) — and `core/ui.js` calls
  `getTotalTokens()` + `getLedgerCount()`, two full clones, on a 5-second
  interval, so the extension blocked the main thread for ~90 ms every 5 seconds
  while the user typed. The whole §7.2 budget, spent on copying. The copy is
  now staged once against the live object's identity and reused until the next
  commit (the model `knowledge/evidence.js` already used, and the shared-view
  semantics callers had when reads returned the live object): 564 ms → 46 ms,
  334 ms → 10 ms, and ten `getLedger()` calls → 0.1 ms. The commit also writes
  a DETACHED clone, closing the aliasing hole that let a caller mutate a
  returned ledger entry straight into metadata after the save.
- **A refused write drops the staged copy** (`interiority/data.js`,
  `knowledge/evidence.js`). Callers mutate the working copy in place and hand
  it to the seam; on a refusal both seams returned without clearing it, so the
  refused mutation stayed in the cached copy every later read returns and was
  re-proposed on every subsequent save. "The previous value was kept" now
  holds for what the module reads next, not only for what is in metadata.
- **The standalone World State import prepares from legacy version 0**
  (`world_state/data.js`, `world_state/render.js`). It was the one import path
  that never ran `prepareStore()` — `parseWorldStateImport()` validated at the
  current version — and `setWorldStateDataChecked()` stamped ALL external
  findings with the destination's `currentVersion`. Both are the bugs the
  fourth pass fixed for the Chronicle importer, unfixed in its twin: an
  unversioned legacy archive's rejected records were recorded as current-version
  data. The parser now prepares from a shared `LEGACY_IMPORT_VERSION`, and the
  checked seam accepts a `{ issues, sourceVersion }` group exactly like
  `setChronicleDataChecked()` (a bare array keeps the historical stamping).
- **A legacy chat's Chronicle Trash survives its migration**
  (`chronicle/schema.js`). `migrateChronicleV0ToV1()` backfilled ids on
  `snapshots` but not `_deletedBin`, while the v1 validator checks both with
  the same per-record rule — so structurally identical records got opposite
  outcomes and every id-less trash entry was quarantined out of the store,
  emptying the user's Trash on migration. §6.2 asks this step to re-cap the
  trash, not evict it. `backfillSnapshotIds()` takes a `prefix` so the two
  lists get separate id namespaces (restore-from-trash matches on id, so a
  cross-list collision would alias two records).
- **`collectCurrentVersions()` reads the manifest through its owner**
  (`backup/index.js`). It re-derived the version map by indexing
  `normalizeManifest()`'s output — which returns a FUTURE manifest UNCHANGED by
  design, so its `sections` may be a shape this build has never seen, or absent.
  Indexing it threw a TypeError out of `previewRestore()` before
  `preflightDestinationContainers()` could report the refusal the design calls
  for. It now calls the exported, guarded `getStoredStoreVersion()`.
- **Quarantine preserves its own rejected records whole** (`core/quarantine.js`).
  `item-missing-fields` / `item-unrecoverable` / `item-not-object` findings put
  only the item's id (or index) in `record`, so re-quarantining a malformed
  recovery item preserved a bare string — §5.2's "the complete invalid record,
  not merely its ID" applied to quarantine itself. The complete item now rides
  in `record` with the display identity separate, so summaries still print an
  identifier rather than a raw payload.

Also hardened, without a reproducible failure behind it:
`commitHistorySnapshot()`'s corrupt-history branch (`world_state/data.js`) used
to commit the caller's patch together with the container repair and then append
into the LIVE array before the second write validated it. The repair now commits
alone — carrying no caller data, so a refused snapshot write means the patch
genuinely did not land — and the append runs on a detached copy.

Three more integrity fixes from the fourth audit pass (regression coverage in
`test/restore_quarantine_integrity.test.js`):

- **Interiority no longer hands out the live store** (`interiority/data.js`).
  When the containers had valid shapes, `getInteriorityData()` returned the
  LIVE metadata object, so callers mutated chat metadata before
  `saveInteriorityData()` validated — an invalid stored scalar (e.g. a
  `turnCounter` of `"RAW-BAD"`) was overwritten in place by
  `incrementTurnCounter()`, validation then saw only the repaired `1`, and no
  quarantine record was ever created. Reads now return a fully DETACHED deep
  working copy (invalid containers still sanitized on the copy), so anything
  a proposal displaces stays in the live value for the same commit's
  quarantine preservation (§5.2). `validateAndApply()`
  (`interiority/generation.js`) re-reads the ledger after the wake/age
  mutators commit — the pre-turn copy it held used to alias the live array —
  so post-wake statuses and ages are evaluated exactly as before.
- **Evidence now actually fails closed** (`knowledge/evidence.js`).
  `getEvidenceMap()` returned the live metadata map and invited callers to
  mutate it before `saveEvidenceMap()`, so a refused write (validation or
  quarantine preservation) could not restore the promised previous value —
  the mutation was already in metadata — and invalid nested evidence could be
  overwritten before validation saw it. The seam is now a staged clone /
  checked commit: reads hand out a stable DETACHED copy (mutations never
  touch metadata), `saveEvidenceMap()` validates the staged value, and only a
  fully accepted validation replaces the live map wholesale — with a fully
  DETACHED clone of the canonical value, because the validator's output still
  shares its nested objects (file meta containers, accepted records,
  pass-through fields) with the staged input it validated: committing it
  as-is, or syncing it back into the staged map, would have re-aliased the
  staged graph into metadata, letting later held-reference edits (a
  `touch()` meta stamp, a raw-record change, a tier push) land in metadata
  before the next validation could see or refuse them. Refusals leave
  the previous stored value intact by construction; a commit is also refused
  when the live map was replaced underneath an uncommitted edit (chat switch
  / restore) rather than clobbering the replacement, and committed findings
  quarantine the invalid tiers they displace in the same write.
- **Imported Chronicle findings keep their own source version**
  (`chronicle/data.js`, `chronicle/import-export.js`, `core/schema.js`).
  `setChronicleDataChecked()` combined the current store's findings with the
  caller's external `preserveIssues` and stamped them ALL with Chronicle's
  current version — but the standalone importer prepares an unversioned
  legacy file as version 0, so its rejected snapshots were stored with
  `sourceVersion: 1`. `collectQuarantineItems()` now honors a per-issue
  integer `sourceVersion` override (one preservation call, one refusal
  point), and the checked seam accepts an external group as
  `{ issues, sourceVersion }` — a bare array keeps the historical
  current-version stamping. The import passes its `LEGACY_IMPORT_VERSION`
  constant (shared with the `prepareStore` version) so recovery metadata
  always names the version the record actually came from.

Two more integrity fixes from the third audit pass (regression coverage in
`test/restore_quarantine_integrity.test.js`):

- **The Chronicle import commits through a checked write**
  (`chronicle/import-export.js`, `chronicle/data.js`). The standalone import
  merged its rejected snapshots into the quarantine container BEFORE the
  destination store was validated and then committed through the unchecked
  setter, so with an unreadable current Chronicle the store kept its old
  value while `msgSinceSnapshot` moved, injection was re-applied, the view
  rerendered, the import reported success, and the quarantine records
  stranded in a chat whose import never landed. The import now uses the new
  `setChronicleDataChecked()` (a discriminated twin of the World State
  checked seam that accepts external `preserveIssues`): the destination is
  validated first, the file's findings ride the same commit, and
  module/UI state only moves — with a success report — after the write is
  confirmed. A refusal reports failure and mutates neither the store nor
  the container.
- **Interiority reads no longer erase invalid data before its write seam
  sees it** (`interiority/data.js`). `getInteriorityData()` replaced a
  falsey invalid root with defaults and overwrote invalid
  `ledger`/`perMessage`/`deletedIntentions` containers in live metadata
  while merely reading, so `saveInteriorityData()` validation received the
  already-sanitized object and could never quarantine the rejected raw
  values. Reads now return a safe working view (a detached canonical
  default for an absent/unreadable root; a detached sanitized copy when a
  container is invalid; the live object otherwise) and never write; the
  store is created only by a committed write. `saveInteriorityData()`
  validates against the LIVE value — an unreadable root fails closed — and
  a sanitized proposal's displaced live containers ride the same commit's
  quarantine preservation (§5.2), so the raw values stay recoverable.
  Chronicle's `getChronicleData()` and Knowledge evidence's
  `getEvidenceMap()` were audited under the same rule: both now initialize
  only a genuinely absent root and hand a detached default back over a
  present-but-invalid one instead of destroying it on read.

Eight more integrity fixes from the second audit pass (regression coverage in
`test/restore_quarantine_integrity.test.js`):

- **The destination is migrated before merging** (`backup/restore.js`,
  `backup/index.js`). The planner prepared only the imported half of each
  section at its declared version and revalidated the completed value at the
  current version — so a legacy Chronicle snapshot without an id was
  quarantined by the v1 validator even though its v0 → v1 migration would have
  backfilled a deterministic id, leaving valid legacy data inactive with the
  wrong `sourceVersion`. The current half is now prepared from the version the
  destination manifest actually declares (`planRestore`'s new
  `currentVersions`, missing ⇒ legacy 0) before the merge, and records
  quarantined out of the current half ride the commit's preservation (§5.2).
  A migration the write persists is stamped (§7.7).
- **Keep/skip restores no longer modify the kept section**
  (`backup/restore.js`). A keep/skip value was revalidated and — when
  canonicalization changed it — written, quarantined into, and stamped, even
  though the preview said the section was not replaced (keeping World State
  with an invalid `autoSaveHistory` removed and quarantined that field). A
  keep/skip section is now omitted from the write plan entirely; integrity
  repair is a separate operation.
- **Quarantine refusal aborts the write** (`core/metadata.js`). A refused
  quarantine merge returned 0 while every write-seam caller proceeded to
  commit its canonical value — the rejected records were removed from the
  store yet absent from quarantine. `preserveQuarantinedRecords()` now returns
  an explicit `{ ok, stored, reason }` and every caller (World State,
  Chronicle, Interiority, Story Planner, Knowledge counters/evidence, the
  standalone imports) leaves the previous store intact when `ok` is false. A
  present-but-malformed container is refused too (merging would canonicalize
  its rejected records away); an absent container still merges normally, and
  the test stub mirrors the contract.
- **Clean restores are no longer blocked by unrelated quarantine**
  (`backup/index.js`). The destination quarantine container was preflighted
  unconditionally, so a future container blocked a clean restore that had no
  quarantine additions and would never modify it. The refusal now applies only
  when the plan actually merges chat-local quarantine; the manifest preflight
  and the Knowledge books' own container checks are unchanged.
- **Legacy Knowledge recovery data is store-owned again** (`backup/restore.js`,
  `backup/index.js`). Top-level recovery items were appended wholesale to the
  chat-local container, so a recovery export (or a backup written by the
  earlier implementation) re-assigned `store:'knowledgeStore'` records to the
  wrong owner. Recovery items are now partitioned by store alongside the
  section findings: Knowledge records ride the lorebook flush into the
  affected book(s), and the commit resolves the store plan for them even when
  the backup carries no `knowledgeStore` section.
- **Future book quarantine no longer disappears from exports**
  (`backup/collect.js`, `knowledge/store.js`). `getStoreQuarantineItems()`
  reads a refused (future/malformed) embedded container as "no items", so a
  backup silently omitted all such recovery data while claiming to carry every
  quarantined record. Exports now inspect each book's container status (new
  `getStoreQuarantineContainerStatus()`) and abort visibly instead of emitting
  an incomplete backup — including the pre-restore snapshot inside a restore.
- **Malformed embedded recovery data is never overwritten**
  (`knowledge/store.js`). The embedded-container merge refused only future
  versions; for any other validation finding it merged into the canonical form
  and overwrote the original container, silently deleting malformed existing
  recovery items. Any non-repair finding that cannot itself be preserved is
  now a failed merge, and the book is left untouched.
- **Quarantined records are no longer reported as already tracked**
  (`knowledge/staging.js`). The NPC import counted a refused record in
  `skipped`, so an import with one invalid NPC reported both "1 already
  tracked" and "1 invalid record quarantined" for the same entry. Refused
  records are now reported once, as quarantined.

Nine integrity fixes across the schema/quarantine/restore subsystem (regression
coverage in `test/restore_quarantine_integrity.test.js`):
- **The completed restore plan is revalidated** (`backup/restore.js`). Only the
  incoming half of each section was ever prepared: merge functions could copy
  malformed records out of the *current* store, and keep/skip returned the
  current value wholesale — yet the commit wrote and stamped it current-version.
  Every planned section now runs through `prepareStore()`: invalid records are
  quarantined (riding the commit's quarantine merge, §5.2), a fatal result
  leaves the section unwritten and unstamped, and the manifest is stamped only
  for sections whose canonical value actually changed (`plan.canonicalSections`).
- **Restore bookkeeping exceptions can no longer bypass rollback**
  (`backup/index.js`). The destination manifest is preflighted (`isFutureManifest`
  now exported) before any transaction write, and all metadata mutation and
  manifest/quarantine bookkeeping runs inside the rollback-guarded block —
  `stampStoreVersion()`'s deliberate throw on a future manifest used to leave
  metadata mutated and a durable Knowledge flush un-rolled-back.
- **A corrupt store root fails closed at the write seam** (`core/schema.js`).
  `prepareNextStoreValue()` substituted the canonical default for any non-object
  current value, so a World State root of `"CORRUPT ROOT"` plus a text patch
  committed a fresh store and destroyed the unreadable original with `ok: true`.
  Only a genuinely absent store starts from the default now; a present invalid
  root fails closed preserving the previous value.
- **Future quarantine containers are never downgraded** (`core/metadata.js`).
  `preserveQuarantinedRecords()` used the tolerant normalizer on the write path,
  so the first write with a quarantine finding could re-stamp a newer release's
  container as v1. It now validates first and refuses a future container
  unchanged (warns; nothing merged). The test stub mirrors the new behavior.
- **Knowledge quarantine is owned by the affected lorebook store** (§5.1).
  Flattening every section's findings into chat metadata wrongly claimed
  `knowledgeStore` records for one chat even though global/scoped books are
  shared. The Knowledge lorebook store now carries an embedded, schema-validated
  `quarantine` container (`knowledge/schema.js`/`knowledge/store.js`); restore
  findings are partitioned per book (`stateRegistry`-path items → the State
  book) and merged atomically inside the store flush, backups carry the embedded
  container with the `knowledgeStore` section, and only chat-metadata-store
  findings reach the chat-local container. A future container inside a
  destination book refuses the restore before any write.
- **A future chat quarantine container refuses the restore unchanged**
  (`backup/index.js`). The restore used to normalize-and-overwrite the
  destination container directly, silently downgrading one written by a newer
  MWT as soon as a single recovery item imported. It now preflights the
  container and aborts (`quarantine-version-future`) before any transaction
  write.
- **World State imports no longer drop rejected recovery data**
  (`world_state/data.js`, `world_state/render.js`). The archive validation
  quarantined invalid records (e.g. a non-array `autoSaveHistory`) and then
  discarded the findings, losing the raw values permanently.
  `parseWorldStateImport()` returns its issues and the import handler preserves
  the rejected records via `preserveQuarantinedRecords()` in the same commit.
- **Refused Knowledge NPC imports are quarantined, not discarded**
  (`knowledge/staging.js`). Invalid staging records were warned about and
  dropped — the schema-owned check ran but the recovery guarantee did not hold.
  Refused records are now quarantined inside the affected Knowledge lorebook
  store (validated up front, before any registry mutation), and the import
  blocks entirely if preserving them fails.
- **The §7.2 migration budget is enforced on the tail, not the median**
  (`test/schema_perf_harness.test.js`). A median-of-7 assertion could pass while
  several measured migrations exceeded the 50 ms synchronous boundary. The
  harness now asserts p95 over 20 runs (tolerating exactly one environment
  outlier) and records median/p95/worst; baselines re-recorded in
  `upcoming_work_misc/SCHEMA_PERF_BASELINES.md`.

Three more integrity fixes (regression coverage in
`test/restore_quarantine_integrity.test.js` and
`test/remediation_followups.test.js`):
- **Failed imports can no longer mutate quarantine state**
  (`world_state/render.js`, `world_state/data.js`). The World State import
  merged the archive's rejected records into the live quarantine container
  *before* the checked write validated the destination, so a refused write (an
  unreadable current store) kept the old World State but had already changed
  its container. The archive's schema findings now ride the checked commit
  itself (`commitHistorySnapshot()`/`setWorldStateDataChecked()` gained a
  `preserveIssues` option): the destination is validated first, so a refused
  import mutates neither the store nor the container, and a committed one
  preserves the records in the same write.
- **Section regeneration uses the checked commit path**
  (`world_state/sections.js`). `regenerateSection()` still called
  `pushToHistory()` and `setWorldStateData()` separately and ignored both
  results, so a store that refused after the awaited generation/retry got the
  injection applied, a success logged, and the uncommitted text returned (the
  UI then reported the section as regenerated). The outgoing snapshot and the
  updated document now commit through one `commitHistorySnapshot()`, and a
  refusal returns null before any injection/provenance work.
- **Removal-only blocked sections keep their refusal reason**
  (`backup/index.js`). For a section present only in the destination, exact
  planning's helper returned a bare boolean, discarding `prepareStore()`'s
  fatal issue or future-version error — the exact preview said "destination
  store refused" with an empty skipped-details list. The helper now returns
  the refusal as a display-safe `{ record, reason }` entry (the same §10.3
  shape the merge planner records), attached to that section's exact summary.

## [1.8.0]

### Added

- **Lorebook auto-activation (opt-in)** — MWT creates its lorebook files but
  never switched them on in SillyTavern's World Info, so ST scanned nothing
  the trackers wrote until each book was enabled by hand. Two toggles in
  Knowledge → Settings now let MWT claim activation slots itself:
  - **Knowledge Tracker → the chat's bound-book slot** (`chat_metadata.world_info`,
    single-entry by ST design). No-clobber: the slot is only claimed when empty
    or already holding an MWT book; a foreign book produces a visible conflict
    note instead. Unbinding deletes the key exactly like ST's own UI.
  - **State Tracker → a `stateScope`-chosen slot**: `character` (default) adds
    the book to the card's *additional* books (`charLore[].extraBooks` via ST's
    `charUpdateAddAuxWorld`/`charSetAuxWorlds` — settings-only, no card re-save,
    never touches the card's primary lorebook), or `global`
    (`updateWorldInfoSettings()` — active in every chat). `chat` targets and
    group chats are skipped with a note (the chat slot belongs to Knowledge;
    ST's character scan is inert in group chats).
  - Every slot write is recorded in a ledger (`settings.activation`), so
    toggle-off removes **exactly** MWT's entries and nothing else, and a
    lorebook-scope change unbinds the old books before binding the new ones.
  - Bindings re-apply after book hydration on init, chat change, and scope
    change (`reloadStores`); the Scope & storage diagnostics warnings now point
    at the toggles; the settings panel warns when the State target is wider
    than the underlying book's scope. Design doc:
    `upcoming_work_misc/LOREBOOK_ACTIVATION_PLAN.md`; implementation:
    `knowledge/activation.js` (+ suite `test/activation.test.js`).

- **Lorebook auto-activation — safety rules** — the guarantees the feature
  above is built on, each covered by `test/activation.test.js`:
  - **Nothing is adopted.** A slot that merely already holds the target book
    is never recorded as MWT's, so turning a toggle off can never remove a
    binding you made yourself — for the chat slot, the global selection, and
    character books alike.
  - **Never guess, never erase.** Both setters replace a whole list, so an
    unreadable global selection or character aux list is treated as unknown,
    never as empty: binding skips with a visible note and unbinding keeps its
    ledger entry to retry later, rather than writing a list that would drop
    your own books. A merely *missing* `charLore` is stock SillyTavern and
    still reads as empty, so character binding works on a clean install.
  - **A failed unbind is remembered.** If a book cannot be switched off
    (missing setter, unreadable selection, a rejected write) it stays in the
    ledger and is retried automatically on the next init / chat change,
    instead of being forgotten while still active.
  - **Chat-slot ownership is per chat**, marked in that chat's own metadata
    (`mwt_chat_world_info`). Binding a second chat cannot orphan the first:
    each chat is cleaned when revisited, a stale MWT-owned slot is reclaimed
    on a scope change rather than reported as a conflict, and a slot you
    rebound by hand instantly stops counting as MWT's.
  - **One State book per card.** With lorebook scope `chat` and the State
    target `character`, each chat's State book superseded the last but left it
    switched on, so a card slowly accumulated dead books that all injected at
    once. Superseded bindings MWT itself made are now swept when the
    replacement is bound (never before, so a failed write cannot leave a card
    with no State book) — books you added yourself are untouched, and a card
    that already accumulated them is healed on the next activation.

- **Diagnostics: Scope & storage tab** (`diagnostics_panel/scope_storage.js`) —
  a book absent from the readable activation slots was reported "inactive"
  even when the chat or character slot could not be inspected. Partial reads
  now report "unknown" (never a false "inactive"), and `detectable` requires
  every applicable slot to have been read. A hostile character accessor
  (card fields, `charLore`) no longer leaves the character slot falsely
  marked readable after a failed read.

- Schema Validation (Part 2) — per-store schema version manifest (`mwt_schema_manifest`),
  pure 0 → 1 migrations for all seven authoritative stores, structured issue
  policies, and quarantine container validation plus recovery export/import
  shapes. All dry-run only: no live persistence behavior changes until Part 6.

- Schema Validation (Part 3) — backup/import integration and the performance
  harness. Backup section wrappers now carry their store's `currentVersion`
  from the schema registry (replacing the one global `SECTION_SCHEMA_VERSION`);
  every unified-backup import migrates each section from its declared version
  through `prepareStore()` BEFORE validation and merge planning, so a restore
  plan is always built against current-version canonical data (`migrated` /
  `deferred` appear in summaries only when they apply); an unreadable or
  future-versioned section now refuses the import instead of smuggling in an
  empty replacement. The restore COMMIT is one transaction: section data, the
  `mwt_schema_manifest` stamp for every restored section, and any quarantine
  additions land in the same `chat_metadata` object and are flushed by the same
  save — a failed persist rolls all three back together, so the manifest can
  never end up ahead of its data. Quarantine recovery data now rides with every
  backup export (top-level `quarantine` container) and MERGES into the
  destination chat's container on restore, deduplicated by content
  fingerprint — and records an import refuses are persisted to quarantine in
  the same commit instead of being dropped. Module write seams (World State,
  Chronicle, Story Planner, Interiority, Knowledge counters, Knowledge
  evidence) now validate the COMPLETE proposed next store — commit canonical
  data or leave the previous value intact — with rejected records preserved in
  `mwt_schema_quarantine` via `preserveQuarantinedRecords()`; the live-object
  evidence map is canonicalized in place so held references stay attached.
  Standalone imports (Chronicle JSON with deterministic legacy-id backfill,
  World State archives, Knowledge NPC staging) route through the same module
  schemas. The pure O(stores) fast load gate landed as
  `schema/gate.js runFastLoadGate()` (ready for the Part 6 runtime cutover),
  and §7.2's budgets are now ENFORCED by `test/schema_perf_harness.test.js`
  against a ~1,925-record reference fixture — fast gate p95 ≤ 5 ms, every 0 → 1
  migration < 50 ms — with recorded baselines in
  `upcoming_work_misc/SCHEMA_PERF_BASELINES.md` (all migrations pass with an
  order of magnitude of headroom; none needs a module-local preparation state
  on performance grounds). Merge/replace previews now include import-time
  quarantine results in their skipped counts (§10.3).

### Fixed
- **Interiority's preparation deferral no longer leaks into live user surfaces
  as a fatal.** Interiority's legacy `perMessage` keys (numeric / `sd-*`,
  pending the chat-dependent conversion) were reported through the FATAL
  channel, so `toBackupSummary()` counted them as *skipped* while the same
  entries were also counted as *added*, ❤️ Health rendered them as
  "quarantined record(s) … records a backup import would refuse" when nothing
  was quarantined and an import accepts them, and the reason string named the
  internal `migrateIndexKeys()` function. Deferral now has its own
  disposition (design §7.5): a `defer` issue severity + policy category,
  `prepareStore()` returning `status: 'deferred'` (original untouched,
  nothing quarantined or stamped, no error), backup summaries limited to
  quarantine and genuine fatal findings with deferrals in a separate
  `deferred` list, and the Diagnostics Integrity tab rendering deferred
  stores as **"preparing"** (own badge, sampled reasons, one
  `store-preparing` warning) instead of counting them toward quarantined
  records or findings. The message is now user-facing: "Interiority needs a
  one-time compatibility update before it can be used (N legacy message
  key(s) still to convert); the saved data was left unchanged." The Part 6
  ordering rule — preparation runs as privileged orchestration, never through
  the paused module's own `queueWork` (it would deadlock its own recovery at
  `interiority/index.js` init) — is written into plan §7.5.
- **`createDefault()` is now canonical for every store.** World State's
  default lacked `autoSaveHistory: []` and Interiority's lacked
  `turnCounter: 0` — both existed only after the 0 → 1 migration ran, so a
  freshly created store and a just-migrated empty one had different shapes.
  Both defaults now match what the migrations converge on, pinned by a new
  generic invariant test (migrating a store's own default must converge on
  the default itself, for all seven stores).
- **Renamed `checkUniqueRecordList()` → `checkPlainRecordList()`** — the name
  read backwards: it never deduplicated (`checkRecordList()` is the one that
  quarantines duplicate ids). Story Planner keeps the non-deduplicating check
  deliberately (`sanitizeArcs()` mints a fresh id for a repeat, per
  STORY-PLANNER-09), now documented at the call site; the rename stops the
  name from misleading whoever implements §6.5's quarantine-on-duplicate.
- The store-schema policy authoring error now names all five categories it
  actually requires (`repair/record/reference/fatal/defer`); it previously
  omitted `repair` (and, with this release, `defer`).
- **A migration no longer replaces a corrupt container.** Two 0 → 1 migrations
  destroyed a present-but-invalid container instead of leaving it for the
  validator to quarantine — the exact loss the subsystem exists to prevent.
  Chronicle routed `snapshots` through `backfillSnapshotIds()`, which coerces
  any non-array to `[]`; Story Planner treated a non-array `arcs` as "legacy"
  and overwrote it with the text-parse result. Both then reported
  `changed: true` with an EMPTY quarantine list, so the Part 6 cutover would
  have persisted the loss with nothing to recover from. Chronicle now
  backfills only an actual array, and Story Planner quarantines the raw
  container before converting (so a corrupt `arcs` alongside legacy plan text
  still yields the parsed plan AND a recoverable copy). Both stores now
  quarantine exactly what the validate-only path quarantines.
- **The migration path is now tested, not just the validators.** The Part 2
  policy batteries only ever called `validate()` directly, so nothing drove a
  corrupt container through `prepareStore()` at version 0 — which is why
  neither bug above surfaced. A table of corrupt containers across all seven
  stores now pins the rule: migrating a legacy chat can never lose more than
  opening an already-current one.
- Backup summaries render **display identities again, not rejected prose**.
  The Phase 1 adapter in `backup/validate.js` exported each issue's complete
  raw record as the skipped-entry `record`, changing the long-standing
  `{ record, reason }` contract from ids/labels to whole objects — so the
  restore preview and Diagnostics summaries showed the full rejected payload
  (potentially quoting the chat) instead of the snapshot id, NPC key, or field
  label. The adapter now uses `issue.identity ?? issue.record`, restoring the
  pre-adapter display value; quarantine creation still consumes the complete
  `issue.record`, and the validator-parity tests pin the legacy expectations
  again instead of blessing the regression.
- **Future quarantine containers are refused unchanged.**
  `validateQuarantineStoreData()` ignored a persisted container's `version`,
  so a container written by a newer MWT was silently re-stamped as version 1 —
  potentially discarding fields that release introduced. An integer version
  above `QUARANTINE_SCHEMA_VERSION` now returns a fatal `future-version`
  finding with the original container untouched (same guardrail as quarantine
  imports and the schema manifest); garbage versions still converge on the
  canonical shape.
- **Quarantine items must be recoverable.** `checkQuarantineItems()` accepted
  `{ store, reasonCode }`-only objects, which have no raw record to recover,
  no message to display, and no fingerprint/id to deduplicate on. Items now
  need their `raw` record and a non-empty `message`; everything safely
  derivable (fingerprint from `raw`, id as `store:fingerprint`, default
  path/detectedAt/sourceVersion) is canonicalized instead of demanded. The
  container validator and imports share one check so the two paths cannot
  drift, with export/import tests added for incomplete objects.
- **Imported fingerprints are recomputed from the raw record.** Quarantine
  canonicalization trusted a supplied non-empty fingerprint, so a hand-edited
  recovery export could stamp one fingerprint onto two DIFFERENT raw records
  and have `mergeQuarantineItems()` silently discard the second as a duplicate
  — losing recovery data to a forged field. The canonical fingerprint is now
  always computed from `item.raw`; a supplied fingerprint that disagrees is
  replaced and reported as a `fingerprint-mismatch` repair finding while the
  item itself stays recoverable.

## [1.7.11]

### Added
- Schema Validation (Part 1)

## [1.7.10]

### Added
- Environment tab — SillyTavern **version now resolved from the DOM** when no
  API field exposes it. Live testing on stock ST 1.18.0 confirmed the three
  field probes (`SillyTavern.version`, `SillyTavern.manifest.version`,
  `context.version`) genuinely find nothing — `globalThis.SillyTavern` is only
  `{ libs, getContext }` and `getContext()` carries no version — so the tab had
  read "version not exposed on this build", which reads like a fault. A fourth,
  last-resort source reads `#version_display` (what ST paints for the user,
  filled from its `/version` fetch), drops the redundant "SillyTavern " prefix,
  and reports e.g. `1.18.0 'release' (abc1234)` with source `DOM
  #version_display`. It is LAST in probe order, so a fork that exposes a real
  version field still wins; the bare "SillyTavern" placeholder before the fetch
  resolves still reads as not-exposed. `environment.js` gains an injectable
  `doc` dependency to keep the probe unit-testable.

## [1.7.9]

### Added
- Diagnostics Phase 13 — **Copy-report finalize + redaction sweep** (the last
  v1 phase): the 📋 Copy Report button now serializes the **tab accessors**
  alongside the Phase 0–4 accessors — `collectReportSections()`
  (`diagnostics_panel/report.js`) gained `health`, `environment` (shared.js
  Connection-Manager probe awaited up front, exactly like
  `MWT.diagnostics.environment()`), `scope`, `injection`, and `integrity`
  sections, so a pasted report, a console dump, and the panel can never
  disagree. The 📡 Last request and 📋 Log tabs deliberately get **no** extra
  section: their stores were already serialized as `apiCalls` (Phase 1) and
  `events` (Phase 0); their snapshots only add derived digest lines over the
  same rows, so a report reader loses no data. The collect is **async** (the
  Integrity section reads a lorebook) and the button press is the Phase 12
  "on demand only" trigger for it — one press = one collect, never on
  tab/modal open, never a render loop (decision D2 untouched).
- The copy flow was extracted into the exported, injectable
  `runCopyReport()` (`diagnostics_panel/render.js`, the `runIntegrityChecks`
  precedent): the button disables + relabels ("⏳ Building report…") while the
  async collect runs and is restored in `finally`; the content opt-in is
  still read live and never persisted; the clipboard still goes through
  `copyTextToClipboard()` (async API → legacy `execCommand` fallback →
  console-dump escape hatch).
- Console bridge `MWT.diagnostics.report({ includeContent })` — **async**,
  returns the paste-ready D1 Markdown STRING the button copies (so
  `copy(await MWT.diagnostics.report())` works even where the clipboard API
  is missing), logging the section count + content mode. One
  `collectReportSections()` backs the button and the bridge, so they can
  never disagree.

### Fixed
- **Phase 13 redaction sweep (QA):** the new sections route through the same
  single `redactForReport()` gate in `buildReport()` — pinned by a new
  tab-shaped sweep suite (`test/diagnostics_report.test.js`): the Phase 9
  rows' `snapshot.payload` and the Scope tab's captured
  `scope_fallback_global` toast body are content-gated to size-only markers
  by default (returning, still secret-scrubbed, on opt-in); keys interpolated
  into free text (warning strings, last-run model names) and URL paths are
  struck in BOTH modes; identity strings (character/chat names in scope keys
  and context fields) deliberately survive — the header still says to skim
  before pasting. A collector that throws now degrades to a `collectionError`
  section via the async guard (an ERROR_KEY: size-only marker with the opt-in
  off) instead of breaking the report. The module cycle this phase creates
  (`report.js` ↔ `injection.js` / `integrity.js` over `collectKnownSecrets`)
  is function-reference-only and documented on both sides.

## [1.7.8]

### Added
- Diagnostics Phase 12 — 🛡️ Integrity tab: the Diagnostics panel's seventh
  and final v1 sub-tab answers "do my stores reference things that exist?"
  — on-demand read-only checks over lorebooks and chat metadata: duplicate
  profile entries (the visible half of lost `profileUid` pointers), dangling
  `profileUid` pointers (the duplicate-generating state
  `MWT.profiles.relink()` recovers), evidence↔profile orphans in both
  directions, `validateSection()` per store (reused as-is from
  backup/validate.js over the chat-metadata sections — the same records a
  backup import would refuse are quarantined with the validator's own
  reasons), and Interiority ledger reference integrity (duplicate ledger
  ids, tombstoned-but-still-live intentions via the real
  `isIntentionDeleted` rule, duplicate tombstone ids). Every check reports a
  count + a top-5 sample, with a **📋 Copy full JSON** escape hatch for the
  complete lists. No repair actions in v1 — the mutating console tools
  (`MWT.profiles.*`, `MWT.evidence.*`, `MWT.interiority.*`) stay where they
  have dry-run guards.
- Unlike Tabs 1–6 this pane is **on demand only**: every check is O(entries)
  and one is an async lorebook read, so the pane renders an idle state + a
  **▶ Run integrity checks** button (`runIntegrityChecks()`, extracted and
  injectable for the Node suite) and nothing runs on tab/modal open — one
  collect per press, never a render loop (decision D2 untouched).
- Two judgment calls are pinned by tests: an empty NPC-Profiles read over
  SET registry pointers flags the affected checks `unreliable` + a
  `profile-book-unreadable` warning instead of flooding false findings
  (evidence alone does not trip the guard — an empty book over pointer-less
  evidence is the ordinary young-chat state, so "evidence with no profile"
  stays a counted READING, never a warning); and the snapshot carries **no
  chat prose by construction** — no profile previews, evidence quotes, or
  quarantined records, only names/uids/counts and the validators' own
  reason strings — while both surfaces still route through
  `redactIntegritySnapshot()` (= `redactForReport()`), so every string is
  Rule-1b secret-scrubbed. As a backstop, the redaction layer now also gates
  the `preview` field name (the profile-body snippet `listProfileEntries()`
  returns) as content, so the shared helper's chat prose is protected even if
  a future tab surfaces a whole entry row rather than picking fields by hand.
  Evidence↔profile joins go through canonical registry names
  (`resolveRegistryKey`), so alias spellings join through the real identity
  rules.
- Console bridge `MWT.diagnostics.integrity()` — **async** (awaits the
  profile-book read), warns on every finding, tables the per-check counts
  and the per-store validation rows, and returns the redacted snapshot.
  Console bridge and tab share one collector
  (`diagnostics_panel/integrity.js`), so they can never disagree.
- With all seven v1 tabs live, the "later tabs still show their
  placeholders" assertions in the environment + scope + injection +
  last-request + log suites retired in favour of "no placeholder remains".

## [1.7.7]

### Added
- Diagnostics Phase 11 — 📋 Log tab: the Diagnostics panel's sixth live sub-tab
  answers "what has MWT been doing this session?" — the Phase 0 event ring
  (every captured toast, API-call echo, and silent-recovery warn), newest
  first, with per-level and per-module counts in the stat header. The level
  chips and module select are **view toggles over the rendered rows** — they
  never re-read the store, so decision D2's open-and-read model is untouched
  (re-open the tab to refresh). A **Chat** column stamps each event with the
  operation epoch (resolved chat identity on hover), the correlation dimension
  that survives forks where identity cannot group events on its own. A warn
  banner fires when error-level events are in the ring (warn-level silent
  recoveries stay rows, not verdicts).
- Redaction on this tab is strict by default and follows the Phase 9/10
  precedent on both surfaces: the ring CAN carry content (toast bodies quote
  the chat; `wi_script_unavailable` records a raw `detail.error`), so the pane
  renders `redactLogSnapshot()` output — message/error bodies collapse to
  size-only markers, every string is secret-scrubbed — and the content opt-in
  checkbox reveals the full (still scrubbed) detail per row via
  `wireDiagnosticsPanel()`: deferred insertion (the `<code>` ships hidden and
  EMPTY carrying only a fingerprint key `seq|ts|epoch|module|event`; the raw
  detail enters the DOM only on opt-in, as `textContent`, and leaves it on
  un-tick) + secret scrubbing (`scrubLogDetailForDisplay()`). The reveal
  matches rows against the LIVE ring by fingerprint, not array index — a row
  whose event was evicted keeps its safe summary. One review find is pinned
  by tests: the snapshot's level counts ship as `{ level, count }` pairs
  (never a map keyed `error`) because the shared redaction layer gates any
  field literally named `error` (ERROR_KEYS), which would have replaced the
  error COUNT with an exclusion marker the moment the snapshot was redacted.
- Console bridge `MWT.diagnostics.log({ level, module, includeContent })` —
  so named because Phase 0 already took `events()` (the RAW ring). Takes the
  same filter shapes `events()` accepts (data-side filtering, unlike the
  tab's view toggles). Synchronous; warns on every finding; tables the rows.
  **Safe by default:** what it RETURNS is `redactLogSnapshot()` output —
  toast bodies gated to size markers, error bodies to error markers, every
  string secret-scrubbed — so the return value pastes without auditing it;
  `log({ includeContent: true })` includes the (still scrubbed) full details.
  Console bridge and tab share one collector (`diagnostics_panel/log.js`),
  so they can never disagree.
- Collector `diagnostics_panel/log.js` is DOM-free with every dependency
  injectable and every accessor individually guarded (a throwing store
  degrades to an empty snapshot + an `errors` note), and normalises each
  event defensively — a malformed entry degrades its own cells, never the
  table. Tests: `test/log_tab.test.js` (63). Maintenance: the "later tabs
  still show their placeholders" assertions in the environment + scope +
  injection + last-request suites moved from Phase 11 to Phase 12.

### Fixed
- Three review finds in the new 📋 Log tab (post-implementation pass), all
  pinned by new wiring tests that drive the real logic with element-like
  fakes (the `copyTextToClipboard()` precedent):
  - **Level filters hid every row (P1).** The level chips shipped without a
    `value` attribute, so each checkbox's DOM `value` read as the default
    string `"on"` — the active-level set became `{'on'}`, no row level ever
    matched, and toggling ANY chip blanked the ENTIRE table. The chips now
    carry `value="<level>"`, and the filter logic was extracted into the
    exported `applyLogViewFilters()` (called by `wireDiagnosticsPanel()`),
    which reads `data-diag-log-filter-level` first and filters on `.checked`
    itself rather than delegating to a `:checked` selector.
  - **Evicted rows lost their safe summary (P2).** On opt-in, a row whose
    event had already been evicted from the live ring had its safe summary
    hidden and an EMPTY detail body shown — the opposite of the documented
    fallback. The reveal (extracted into the exported `revealLogDetails()`)
    now consults the fingerprint map with `has()` before revealing: an
    unknown key keeps the summary visible and the body hidden and empty
    until the tab is re-opened.
  - **The event fingerprint could select the wrong detail (P2).**
    `ts|epoch|module|event` is not unique — `record()` stamps `ts` at
    millisecond resolution, so repeated events from one module in one
    millisecond share all four fields, and the reveal Map collapsed them
    onto one detail (several rows displayed the wrong event content).
    `record()` now stamps every ring event with a monotonic `seq` (reset
    only by `_resetDiagnostics()`), carried through `normaliseLogEvent()`
    and leading the fingerprint: `logEventKey()` =
    `seq|ts|epoch|module|event`. Pinned at the store level in
    `test/diagnostics.test.js` and at the tab level in `test/log_tab.test.js`.

## [1.7.6]

### Added
- Diagnostics Phase 10 — 📡 Last request tab: the Diagnostics panel's fifth
  live sub-tab answers "what did MWT's last API call look like, and how have
  the recent ones been going?" — a detail card for the most recent captured
  call (module · mode with an inline explanation of `custom` vs `cm` ·
  model/profile · HTTP status · duration · retries · `finish_reason` · token
  usage · error class), the short history table (every retained call, newest
  first — the store's `API_CALL_CAPACITY = 20` cap **is** the "short
  history"), and window stats (ok/failed, retries, token totals, avg/max
  duration) in the stat header. A warn banner fires when the most recent call
  FAILED — an older failure stays a reading in the table, not a verdict.
  Telemetry by construction (`captureApiCall()` records ABOUT a call — never
  the prompt, API key, custom headers, or response body), so there is no
  content to gate and the report opt-in changes nothing on this tab.
- Console bridge `MWT.diagnostics.lastRequest()` — so named because Phase 1
  already took `apiCalls()` / `lastApiCall()` / `lastApiCalls()`.
  Synchronous; warns on every finding; tables the history. **Safe by
  default:** what it RETURNS is `redactLastRequestSnapshot()` output — the
  shared layer's sanctioned telemetry-only mode (`redactSecretsDeep()`), with
  Rule 1b string scrubbing (this install's live secret values, embedded URLs
  → scheme+host, key/bearer shapes) applied to every model/profile id,
  finish reason, and error class, so the return value pastes without
  auditing it; raw telemetry-only copies stay on the Phase 1 paths.
  Console bridge and tab share one collector
  (`diagnostics_panel/last_request.js`), so they can never disagree.
- Collector `diagnostics_panel/last_request.js` is DOM-free with every
  dependency injectable and every accessor individually guarded (a throwing
  store degrades to an empty snapshot + an `errors` note), and normalises
  each captured call defensively — a malformed entry degrades its own cells,
  never the table. Tests: `test/last_request_tab.test.js` (29). Maintenance:
  the "later tabs still show their placeholders" assertions in the
  environment + scope + injection suites moved from Phase 10 to Phase 11.

### Fixed
- Interiority no longer generates thoughts and intentions for the player
  character when the scene uses a shorter form of their name. `{{user}}` =
  "Alex Hiro" with a `Present:` line saying "Alex" put the PC on the roster,
  and the injection then instructed the narrator to act for the player. This is
  the inverse of the v1.5.x fix and that fix could not reach it: the exclusion
  widened `{{user}}` in one direction only — through the knowledge registry,
  which turns a short persona into the fuller name the tracker recorded. Here
  the persona *is* the fuller name and the scene holds the shorthand, and no
  registry entry can bridge them, because the knowledge tracker deliberately
  never records the player. The one bridge the filter had is the one the PC
  structurally cannot have. The exclusion now applies the registry's
  unambiguous-alias rule directly (`isUserName`), keeping its refusal: if
  another character in the scene also answers to "Alex", the shorthand is
  ambiguous and nobody is excluded, so a real NPC is never silently denied
  interiority. Applied at all three gates — roster build, result validation,
  and the leaked-entry purge. The purge matters most: a leak entered the ledger
  as "Alex", `getActiveLedger()` re-seeds the roster from the ledger every
  turn, and a purge matching only "alex hiro" could never remove it — so one
  slipped turn became permanent for the chat. Existing leaks are cleaned up on
  the next chat load. Regression tests in `test/interiority.test.js`.



## [1.7.5]

### Fixed
- Knowledge auto-trigger countdowns no longer advance on swipes and
  regenerations. SillyTavern emits `MESSAGE_RECEIVED` again for every
  replacement generation of the same reply, so each swipe consumed a step of
  the World State / NPC scan / growth / relationship cadences — and once a
  countdown landed on a discarded generation, the run spent tokens analysing a
  reply that was about to disappear. Each cadence now counts a given assistant
  *message slot* at most once, keyed by the message's stable receipt identity
  (`extra.mwt_uuid`), which survives regeneration because ST mutates a swiped
  message's `extra` in place rather than replacing it. A receipt that has
  already been counted is a no-op for that cadence, and stays one after the
  cadence completes, so regenerating the message that triggered a run cannot
  re-trigger it. Deletes still reverse exactly the contribution a receipt made
  to the cadence in progress. The per-receipt bookkeeping is bounded: markers
  spent by a completed cadence are released beyond a short recency window
  (only the tail of a chat can be regenerated), so the map persisted to chat
  metadata no longer grows one entry per message for the life of the chat.
  Regression tests in `test/knowledge_countdown.test.js`.


## [1.7.4]

### Added
- Diagnostics Phase 9 — 💉 Injection tab: the Diagnostics panel's fourth live
  sub-tab answers "what is MWT actually putting in the narrator's prompt right
  now, where, and why there?" — one row per module showing on/off · gate ·
  **resolved role and depth with provenance** · a token estimate · and the
  Registered column (time + age of the exact `setExtensionPrompt`
  registration, a "cleared" badge when the last apply emptied the slot).
  The recorded payloads render below the table as collapsed `<details>`
  blocks, age-stamped — and, because payloads are chat-derived content that
  can quote secrets (an upstream error pasted into a state document, a token
  in a card), two guards stack on them: the payload text is **not in the DOM
  at all** until the content opt-in checkbox is ticked (the `<pre>` ships
  empty carrying only the snapshot key; a one-shot listener in
  `wireDiagnosticsPanel()` fills it on opt-in and clears it again on un-tick
  — not a render loop), and what gets inserted is first scrubbed through the
  shared redaction layer (`core/redaction.js` via `scrubPayloadForDisplay()`:
  embedded URLs cut to scheme+host — which removes `user:pass@` credentials
  and key-bearing paths — vendor key/bearer shapes redacted, and this
  install's live secret values struck via `collectKnownSecrets()`), then
  assigned as `textContent`, so payload text is never parsed as HTML either.
  Opting into content never opts into secrets.
  Token columns state their kind: *recorded* (tokens of the exact registered
  payload), *est.* (module accessor estimate, only while nothing is
  registered this session), and *stored* (Knowledge's lorebook corpus —
  never prompt load, never summed into the registered total).
- **Per-module injection placement provenance** (the design's §I.4.6 "small
  provenance helpers"): `resolveInjectionPlacement()` is now exported from
  World State, Chronicle, Story Planner, and Interiority `injection.js` — and
  each applier CALLS its own helper, so the tab reports precedence
  (global override → module setting → built-in default; Chronicle's "module"
  level is this chat's `injectDepth`) from the same function the apply path
  uses. Parity is pinned by tests that drive the real appliers and compare
  the registered snapshot against the resolver. Story Planner's missing
  global pair is stated in its row.
- **Injection warning set** (tab + console both surface these): the Knowledge
  lorebook caveat is now ALWAYS visible on this tab — amber normally, red
  with "NOT stopped by the panic switch" wording when the switch is on —
  closing `TODO.md` §4 "Panic switch UI clarity"; a panic-switch banner
  (SillyTavern keeps whatever was registered before the flip);
  `flag-on-registered-empty` (flag on, gate open, but the last registration
  was a CLEAR — usually "nothing to inject yet");
  `flag-off-registered-live` (module off/gated yet a live payload is STILL
  registered — the missed re-apply, e.g. the panic switch flipped without a
  re-apply event); and `placement-drift` (settings now resolve to a
  different depth/role than the live registration — the stale-registration
  case made actionable).
- Console bridge `MWT.diagnostics.injectionStatus()` — so named because
  Phase 2 already took `injections()` (all keys) and `injection(key)` (one
  raw snapshot). Synchronous; warns on every finding; tables the rows plus
  the registered depth/role per key. **Safe by default:** what it RETURNS is
  `redactInjectionSnapshot()` output — payload text gated to
  `[content excluded — N chars]` markers and every string secret-scrubbed
  (same shared layer, same live `collectKnownSecrets()` list as Copy
  Report) — so the return value pastes without auditing.
  `injectionStatus({ includeContent: true })` includes (still scrubbed)
  payloads, and one key's byte-EXACT text stays on the deliberate
  single-key path, `injection(key)`. Console bridge and tab share one
  collector (`diagnostics_panel/injection.js`), so they can never disagree.
  Tests: `test/injection_tab.test.js` (52).
- **Post-landing review fix (same release):** the payload display originally
  shipped the (HTML-escaped) payload in the markup behind `hidden`. That met
  the content gate but not the redaction contract — escapeHtml() stops HTML
  injection, not secrets. The payload body is now DEFERRED (empty `<pre>` +
  snapshot key in the markup; `wireDiagnosticsPanel()` inserts it only on
  opt-in, as `textContent`, and clears it on un-tick) and SCRUBBED through
  the shared layer (`scrubPayloadForDisplay()` → `redactForReport()` with
  `collectKnownSecrets()`), pinned by tests carrying a key-shaped secret and
  an authenticated `user:pass@` URL. The same review closed the console
  side: `MWT.diagnostics.injectionStatus()` now returns
  `redactInjectionSnapshot()` output (payloads gated to size markers, all
  strings secret-scrubbed) by default, with `{ includeContent: true }` for
  scrubbed payloads and `injection(key)` as the deliberate exact-text path.

## [1.7.3]

### Added
- Diagnostics Phase 8 — 🗂️ Scope & storage tab: the Diagnostics panel's third
  live sub-tab answers "which lorebooks is this chat actually using, and
  WHY?" — the resolved character/chat identity and the current operation
  epoch (core/scope.js), the three lorebook names this scope resolves to
  with the reason each step of the resolution produced them, the saved
  bindings (stable identity key → book names, with the current one
  marked), per-book hydration and store versions, and the loud warning
  when scope silently fell back to the global books (fueled by Phase 3's
  `scope_fallback_global` counter: the banner names a LIVE fallback, and a
  footer line counts every fallback already recorded this session, so a
  fallback on a chat the user has since switched away from still shows).
  Resolution modes mirror `resolveBookNames()` branch-for-branch — global,
  saved-binding, newly-derived (flagged as save-on-next-resolve),
  collision-disambiguated (the shared-display-name case),
  sanitize-fallback-global (a name like "???" cannot become a filename),
  and fallback-global — but are RE-DERIVED read-only: the real resolver
  persists a binding on first sight of an identity, and the diagnostics
  panel is read-only by contract, so opening the tab never writes anything.
  That needed one new read-only accessor, `peekStore()` in
  `knowledge/store.js` (hydration · dirty · version per cached book; the
  existing `readField()` was unusable because it installs its fallback
  INTO the store). A Knowledge store whose load FAILED is the one
  red-level banner state ("writes blocked — the deliberate duplicate
  guard"); a store that simply has not been hydrated yet is amber and says
  so, because hydration is asynchronous and runs on chat change — the
  ordinary early state is not a fault. Amber also covers the other
  safe-but-silent recoveries. Same snapshot available to
  testers as `MWT.diagnostics.scope()` (synchronous), which warns on
  every finding; console bridge and tab share one collector
  (`diagnostics_panel/scope_storage.js`), so they can never disagree.
  `MWT.scope.diagnose()` remains the deeper dump (raw context fields).
  Read-only and open-and-read like every tab.

- Diagnostics Phase 7 — 🌐 Environment tab (the fork-compat probe): the
  Diagnostics panel's second live sub-tab answers "which SillyTavern is this,
  and which context APIs does it actually expose?" — MWT + SillyTavern
  versions (probing `SillyTavern.version`, `SillyTavern.manifest.version`,
  and the context's `version` field; "(not exposed)" is itself reported,
  since no client-side version field is documented for extensions), a
  feature-detection table for `getCurrentChatId`, `ctx.chatId`, the
  tokenizer (`estimateTokens()`'s exact three-source order, verified with a
  live call — a tokenizer that exists but throws is the state that silently
  degrades every token figure MWT shows), `ConnectionManagerRequestService`
  both on the context object and via the `shared.js` import core/api.js uses
  (with `constructPrompt` as its own line item, the member the Aikobots-4
  fork removed), and the world-info module tri-state behind Knowledge's
  reads/writes — plus the eleven raw context fields `MWT.scope.diagnose()`
  prints, with the same sentinels, so a pasted pane and a console dump
  compare line for line. The tab's headline is a banner verdict on the
  `getCurrentChatId()` premise underpinning `core/scope.js`, validated live
  on the running build: **ok** (quiet footnote), **fallback** (amber — scope
  is running on its `ctx.chatId` fallback; include the row when reporting
  from that fork), or **fail-closed** (red — no usable chat id, identity
  compares fail closed and chat-switch detection leans on the epoch counter
  alone). This is how the scope premise finally gets validated on real forks
  from tester reports, without a manual live-ST check per fork. Read-only and
  open-and-read like every tab; the one async probe (shared.js) renders as a
  "probing…" cell filled in once on open. The same snapshot is available to
  testers as the async `MWT.diagnostics.environment()`, which warns on any
  non-ok premise. Console bridge and tab share one collector
  (`diagnostics_panel/environment.js`), so they can never disagree.

## [1.7.2]

### Added
- Diagnostics Phase 6 — ❤️ Health tab (first live panel tab): the 🩺
  Diagnostics panel's Health sub-tab answers "is anything broken right now?"
  in one table — a row per module showing enabled · injection gate · busy ·
  tokens · auto-countdown · last run (time · ok/failed · duration; hover for
  model / HTTP status / retries) — under a header with the MWT version, the
  injected token load, and an unmissable red banner whenever the
  ⛔ panic switch (`injectionMasterOff`) is on. **Token counts state what they
  are counting.** Four modules report what they are injecting into the prompt
  right now; Knowledge reports the size of the lorebook it has written, which
  is a library, not prompt load — it has no injection path at all, and
  SillyTavern activates only the entries whose keywords match recent chat. The
  two are shown separately and never summed (`injecting: 4,651 tokens · +
  36,412 stored in lorebook (not injected)`), because a single combined figure
  reads as though the extension were sending its entire knowledge base every
  turn. Read-only and open-and-read:
  the snapshot is collected when the modal is built (re-open to refresh).
  Inconsistent per-module accessors are normalized (Chronicle's
  `threshold`-shaped countdown; Interiority's per-turn schedule with its
  dormant-poll state; negative countdowns clamp at 0), every accessor call is
  individually guarded so one broken cell can never blank the tab, and the
  same snapshot is available to testers as `MWT.diagnostics.health()`. To make
  the "last run" column real, all five modules' settings now stamp their key
  (`module: '<id>'`) onto API telemetry — previously every live call was
  recorded under module `'api'`, so `MWT.diagnostics.lastApiCall('<module>')`
  and the per-module `reasoning_content_fallback` warns never keyed
  correctly. Console bridge and tab share one collector
  (`diagnostics_panel/health.js`), so they can never disagree.
- Diagnostics Phase 5 — panel shell + redaction core + report shape: a new
  **🩺 Diagnostics** tab in the main MWT modal mounts the diagnostics panel
  with placeholders for the seven v1 tabs (Health, Environment, Scope &
  storage, Injection, Last request, Log, Integrity). The shared redaction
  layer (`core/redaction.js`) redacts `apiKey`, `customHeaders` values, and
  `apiUrl` (host only) unconditionally, and gates prompt / injected-payload
  content behind an explicit opt-in checkbox (default off, consequence stated
  in the label, never persisted). Because MWT interpolates the resolved
  endpoint and the upstream error body into its own error messages — and
  `core/notifications.js` captures every toast into the event ring — matching
  on field names alone was not enough: every string in a report is also
  scrubbed for this install's live key values, embedded URLs (reduced to
  scheme + host), and recognizable key/bearer-token shapes, and captured toast
  bodies are gated as content alongside payloads. **📋 Copy Report** produces the support-ready
  Markdown report — fenced JSON appendix (fence length adapts so payload
  content can never break out), header states whether content is included —
  serialized from the Phase 0–4 accessors, i.e. the same data the
  `MWT.diagnostics` console bridge shows. Still read-only, in-memory only;
  the redaction gate for Phases 6–12 is now in place.
- Diagnostics Phase 4 — settings provenance + Interiority auto-status (no UI
  yet): `resolveApiCall()` now reports which of its four config levels won
  (`module-profile → module-custom → global-profile → global-custom`) as a
  `source` field, and World State's `getEffectiveWorldSetting()` plus Story
  Planner's `getEffectivePlanSetting()` accept `{ provenance: true }` to
  return `{ value, source }` for their 3-level chain (per-chat override →
  legacy chat field → global) — making "the value is right but came from
  somewhere else" visible. Interiority gains `getAutoStatus()`, the auto-run
  accessor the other four modules already expose (null when autoMode is off;
  otherwise the §20 dormant-poll schedule). Console bridge:
  `MWT.diagnostics.settingsProvenance()` also surfaces that Chronicle,
  Knowledge, and Interiority have no per-chat/global settings split at all —
  see `DIAGNOSTICS_CONSOLE_GUIDE.md`. Instrumentation for the diagnostics
  panel is now complete; panel work (Phase 5) begins.

### Fixed
- Chronicle world-state sync: the trailing-time split of the Time Anchor line
  ("June 4, 2024 2:30pm" → Date + Time) now matches against a short bounded
  tail of the model-generated line instead of an end-anchored `\s+…$` pattern
  over the whole string. The old form rescanned an unusually long
  whitespace-heavy line once per start position (quadratic in the worst
  case); the cost is now constant regardless of line length. The same audit
  pass found the twin of that pattern in the World State injection rebuild:
  `splitWorldState()`'s archive-section pattern led with an unanchored `\s*`
  before its literal and rescanned whitespace runs the same way — and the
  chronicle sync feeds the parsed Date line straight into that rebuild, so
  the sync path stayed quadratic even with the split bounded. It is now
  line-anchored (`(?:^|\n)\s*`, the WORLD-STATE-06 convention already used
  by `extractOnlySection`/`replaceSection`), which also means a body line
  that merely mentions "## Archive (Stale)" mid-sentence no longer triggers
  removal. Regression tests in `test/remediation_followups.test.js` (audit P3).
- Dev tooling: refreshed `package-lock.json` so the transitive `nanoid`
  dependency (dev-only, via Vitest/Vite/PostCSS) resolves to 3.3.18,
  clearing GHSA-2v37-7h3g-55p8 — extension users were never exposed. Verified
  with a clean `npm audit` and the full test suite (audit P2).
- Pinned CI actions immutably (Taverany.org unpinned-action finding)

## [1.7.1]

### Fixed: Knowledge Tracker duplicate entries; mismatch UIDs

## [1.7.0]

### Added
- Diagnostics Phase 3 — silent-recovery counters (no UI yet): five quiet
  fallbacks now record `warn` events into the diagnostics ring, so "why is my
  data weird" reports arrive with evidence instead of guesswork:
  `json_repaired` (lenient parse recovered JSON that strict `JSON.parse`
  rejected), `reasoning_content_fallback` (empty `content`, reasoning channel
  used instead), `output_stripped` (markdown fences / "Here is…" preamble
  removed from an output), `scope_fallback_global` (Knowledge scope fell back
  to the shared global lorebooks), and `wi_script_unavailable` (ST world-info
  module missing — reads empty, writes blocked). Sizes and flags only, never
  content. See `DIAGNOSTICS_CONSOLE_GUIDE.md` → "Reading the output".
- Diagnostics Phase 2 — injected-payload snapshots (no UI yet):
  `applyExtensionPromptInjection()` now records exactly what it registered
  with SillyTavern via `setExtensionPrompt` — one snapshot per injection key,
  overwritten on each apply (`{ key, payload, role, depth, enabled, at }`,
  in-memory only), so a future panel can show the payload actually registered
  (placement in the final prompt stays unverified) instead of a misleading
  rebuild. Console bridge:
  `MWT.diagnostics.injections()` / `MWT.diagnostics.injection(key)` — see
  `DIAGNOSTICS_CONSOLE_GUIDE.md`.


## [1.6.1] - 2026-08-14

### Fixed
- **Interiority produced nothing on every turn** for the batched (default) and
  split generation modes. `getEvaluatedNpcNames` built its fallback candidate
  list as a `Set`, which fails the `Array.isArray` guard directly above it and
  then throws `candidates.map is not a function`. Only strict mode passed the
  optional `reportedNames` array that routed around the fallback, so it was the
  one unaffected path. The throw was swallowed by the `generateForCurrentMessage`
  try/catch, so the failure was silent: no thoughts, no intentions, and no ledger
  write, with only a console error to show for it. Introduced in v1.6.0.

## [1.6.0] - 2026-08-13

### Added
- Setting to change how many recent messages to ignore (Does NOT apply to interiority)

### Fixed
- Trackers should now ignore last 2 messages (except interiority)
- Swipes advancing the dormant-poll schedule
- Wake-survival leak for intentions

## [1.5.2] - 2026-08-13

### Fixed
- Interiority roster: strip parenthetical location/status annotations from the
  World State `Present:` line before parsing, so names like
  `Simon (living room, unpacking)` are no longer shattered into garbage NPC
  tokens (`Simon (living room`, `unpacking)`, …) (commit eb345fb).
- Corrected shared-module import paths in `core/api.js` and the Vitest config
  (commit 2fadb30).

## [1.5.1]

### Added
- Diagnostics (partial; Phase 1 no UI);  please see DIAGNOSTICS_CONSOLE_GUIDE.md to use it!

### Fixed
- Potential bug with Intentions/Thoughts not picking up second NPC Card (changed the fallback to include last few messages instead of only Present field in World State (commit ccd72239b74ff5999147deae9b46fac07b51423e))


## [1.5.0]

### Added
- CHANGELOG.md
- Phase 1 - 3 of unified backup/restore
- **Phase 4 — unified backup/restore UI** (`backup/render.js`): a "Backup /
  Restore" panel in the Settings tab plus a dry-run summary modal. Export
  downloads a versioned backup; Restore runs the two-step preview → confirm flow
  (with per-section added/updated/skipped/conflict counts, identity warnings, and
  per-message resolve counts), auto-downloads a pre-restore backup before
  writing, and supports merge vs exact (replace) modes and undo-last-restore.
  Backed by new pure-presenter unit tests (`test/backup_ui.test.js`). Phases
  2–3 of the engine (`collect.js`, `restore.js` lorebook-store round trip,
  preview fingerprint) are now user-reachable rather than console-only.

### Changed
- Added more lint rules: eqeqeq; prefer-const; no-shadow

### Fixed
- world-info.js warning in Vitest
- Intention resurection: tightened a guard to prevent deleted intentions from reappearing

## [1.4.23] - 2026-08-07

The reliability release. It closes the full 2026-08-02 audit baseline (every
flagged code finding and test-coverage gap), hardens async and chat-switch
behavior across all modules, and introduces the project's first lint gate and CI.

### Added
- **Lint + CI:** an ESLint correctness-only gate, plus a GitHub Actions workflow
  that runs lint + tests on every push (Node 20 & 22, with concurrency
  cancellation).
- **Shared core primitives** built and wired into production: `core/scope.js`,
  `core/revision.js`, `core/prompt.js`, and `core/api.js`.
- **Stable chat identity + operation-epoch guard** that underpins the new
  cross-chat contamination protections.
- **Relationship & stance provenance** tracking, with automatic and manual
  management.
- **Automatic relationship extraction** across the Knowledge Tracker.
- `finiteNumber` guard and safer API payload handling for non-finite values.
- `escapePromptBoundary` for safe narrator-facing text.
- Test suite expanded from 165 tests (9 files) to **430 tests (21 files)**,
  adding Tier 4 and Tier 5 regression tests, integration contracts, and a
  chat-switch harness.

### Changed
- Refactored message-event handling into a dedicated `core/event_router.js`;
  `onMessageDeleted` now accepts an `adjustCounters` option.
- `onMessageReceived` gained a `countMessage` flag for panic-counter symmetry.

### Fixed
- **Cross-chat contamination** during async operations: scope capturing and
  validation across world-state refresh, section regeneration, chronicle
  snapshots, interiority generation, and plan generation. In-flight scope tokens
  are now invalidated on chat change.
- **Auto-generate races:** replaced with a single cancellable timer and aligned
  cadence scheduling.
- **Chronicle:** no longer drops messages that arrive mid-snapshot, and message
  counting during snapshot generation is corrected.
- **World State:** provenance invalidation and character-budget limits on
  injected state; grounding-gate logic for strict and soft section regen;
  editor persist debounce is now scoped to its own chat; the document is re-read
  before a section-regeneration write; corrected an undefined `setStatus` call.
- **Knowledge:** NPC-registry access and cycle detection to prevent data loss
  and improve name resolution; entry-identity verification before overwrite;
  registry-name normalization to prevent stale-UID issues (case/whitespace); the
  store no longer hydrates erroneously on load failure.
- **Interiority:** key-migration collisions resolved; ledger field lengths
  capped to prevent payload bloat; turn-counter logic now aligns dormant-poll
  scheduling with successful generations and cleans stale thought blocks.
- **Presets:** the "YIELD RULE" no longer fires on ordinary disagreement.

## [1.4.7] - 2026-08-02 *(reconstructed)*

A stability pass focused on Interiority and store persistence.

### Fixed
- **Interiority:** now respects user settings for generating thoughts vs.
  intentions in split calls; hand-edited intentions survive rollbacks and are no
  longer re-added as duplicates; deleted intentions use a tombstone mechanism to
  prevent re-proposals; the player character no longer appears in the NPC roster
  during entry purging.
- **Store / Knowledge:** immediate saves to avoid lost profile pointers; the
  store stays dirty until its save actually lands.
- **World State:** a stale editor is no longer synced into a newly-loaded chat.

### Changed
- NPC behavior and simulation-mechanics enhancements.

## [1.4.0] - 2026-08-01 *(reconstructed)*

Story Planner feature work plus styling refinements.

### Added
- **Story Planner:** beat reminders and user notifications for overdue beats.
- **Story Planner:** arc-flag handling, with serialization round-trip tests.

### Changed
- Improved chat-message layout (better text wrapping and visibility).
- Updated preset content structure for clearer narrative handling.

## [1.3.0] - 2026-08-01 *(reconstructed — covers initial v1.0 → v1.3.0 development)*

The first tagged release, encompassing the initial build-out of all five modules
and the shared core. Summarized here by theme rather than by individual commit.

### Added
- **💭 Interiority module** (NPC private thoughts and persistent hidden
  intentions), including manual intention entries with inline editing, intention
  age tracking / grace periods, UUID-based per-message identifiers, and Aikobots
  v4 fork compatibility (hydration checks + fallbacks).
- **NPC Growth Profiles:** evidence capture and review (with quote
  verification), a consolidation pass with user overrides, profile generation
  with truncation detection, continuous incremental capture, ILS backfill, and a
  "Catch Up" action.
- **🗺️ Story Planner:** arc management and UI rendering, with enforcement modes
  for narrative control.
- **🧠 Knowledge Tracker:** NPC profile handling, quote verification for
  observations, and immediate metadata persistence.
- **Per-lorebook store** (`[MWT:store]`) with a stale-UID guard and scope-aware
  hydration, plus lorebook-resolution diagnostics.
- **Floating quick-access buttons** with viewport-clamped positioning and a
  reset-to-defaults action, including a mobile fixed-positioning fix.
- MIT license and a full-featured README; comprehensive core tests with
  SillyTavern-runtime stubs.

### Fixed
- Snapshot, proposal, and superseded-content handling to prevent data loss
  during rescans; message-window character-budget and chat-metadata handling for
  counter persistence; snapshot and chat-context validation to prevent data
  corruption.

---

[1.6.1]: https://github.com/brasen56/merged_world_tracker/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/brasen56/merged_world_tracker/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/brasen56/merged_world_tracker/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/brasen56/merged_world_tracker/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/brasen56/merged_world_tracker/compare/v1.4.23...v1.5.0
[1.4.23]: https://github.com/brasen56/merged_world_tracker/compare/v1.4.7...v1.4.23
[1.4.7]: https://github.com/brasen56/merged_world_tracker/compare/v1.4.0...v1.4.7
[1.4.0]: https://github.com/brasen56/merged_world_tracker/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/brasen56/merged_world_tracker/releases/tag/v1.3.0

