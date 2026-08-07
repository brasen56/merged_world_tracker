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

## [Unreleased]

_Nothing yet. New work lands here first, then moves under a version heading when
you tag a release._

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

[Unreleased]: https://github.com/brasen56/merged_world_tracker/compare/v1.4.23...HEAD
[1.4.23]: https://github.com/brasen56/merged_world_tracker/compare/v1.4.7...v1.4.23
[1.4.7]: https://github.com/brasen56/merged_world_tracker/compare/v1.4.0...v1.4.7
[1.4.0]: https://github.com/brasen56/merged_world_tracker/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/brasen56/merged_world_tracker/releases/tag/v1.3.0

