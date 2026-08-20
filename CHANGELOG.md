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

