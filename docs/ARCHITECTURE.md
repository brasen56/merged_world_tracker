# MWT Architecture

Code-level map of the extension: the annotated file trees and how modules
communicate. End-user documentation (features, usage, settings, defaults)
lives in [USER_GUIDE.md](../USER_GUIDE.md); first-time setup lives in
[SETUP_GUIDE.md](../SETUP_GUIDE.md).

```
merged_world_tracker/
├── index.js              # Main entry — tabbed UI, event hooks, floating buttons, init
├── manifest.json         # SillyTavern extension manifest
├── style.css             # All styles (dark + light theme, responsive breakpoints)
├── core/                 # Shared infrastructure
│   ├── index.js          # Barrel re-exports for all core modules
│   ├── ambient_generator.js # Deterministic conditions engine — seed + clock + climate → qualitative weather, forecast
│   ├── ambient_pin.js    # Condition pins with story-time expiry + rewind support
│   ├── ambient_prompt.js # Shared read-only ambient projection for Story Planner context
│   ├── ambient_state.js  # Per-chat ambient settings/seed state
│   ├── ambient_time.js   # In-story time parsing + fallback ladder (tag → World State date → message count)
│   ├── api.js            # OpenAI-compatible + Connection Profile API client with retry
│   ├── budget.js         # Context/token budget engine — per-module soft/hard caps, global cap, drop-order planning
│   ├── commands.js       # Slash command and macro registration
│   ├── context.js        # SillyTavern context, chat, metadata, token helpers
│   ├── coordinator.js    # Cross-module generation coordinator + cancellation model
│   ├── diagnostics.js    # In-memory diagnostics ring buffer + last-run map (read-only, never persisted)
│   ├── diff.js           # LCS line/word diff computation and HTML rendering
│   ├── event_router.js   # SillyTavern message-event routing (pure dispatch decisions)
│   ├── file.js           # Download / file-pick helpers
│   ├── injection.js      # Extension prompt injection helpers + XML tag wrapping
│   ├── main_tabs.js      # Main modal tab shell — render + wireTablist seam (keyboard tab navigation)
│   ├── message_identity.js # Stable message UUIDs that survive swipes/regens (receipt dedup)
│   ├── metadata.js       # Chat metadata access (world state / chronicle / registry)
│   ├── modal.js          # Modal lifecycle, status bar, button bar helpers
│   ├── notifications.js  # Toast notifications
│   ├── prompt.js         # Prompt-boundary + payload-budget helpers
│   ├── quarantine.js     # Quarantine store — records refused by validation, kept whole for recovery
│   ├── redaction.js      # Secret redaction (API keys etc.) for diagnostics reports
│   ├── revision.js       # Revision digests — manual-edit detection and undo snapshots
│   ├── schema.js         # Shared validation vocabulary: issues, migrations, store preparation
│   ├── schema_status.js  # Schema event surfacing + per-store pause/banner state
│   ├── scope.js          # Chat/character identity resolution + operation epochs (scope guards)
│   ├── settings.js       # Settings manager factory (extension_settings + localStorage)
│   ├── settings_schema.js # Settings-record versioning + validation (fail-open, never destructive)
│   ├── strip.js          # Non-narrative content stripping for scanner contexts
│   ├── ui.js             # API field renderer, floating button bar, drawer, wand menu
│   └── version.js        # Extension version constant (kept in sync with manifest/package)
├── world_state/          # World State Tracker module
│   ├── index.js          # Orchestrator — public API and lifecycle hooks
│   ├── data.js           # Constants, state, data access (leaf)
│   ├── settings.js       # Settings manager and defaults (leaf)
│   ├── prompts.js        # System prompt template (leaf)
│   ├── injection.js      # Prompt injection + Plot Seeds hook-mode headers
│   ├── delta.js          # Delta refresh: patch protocol, document status bookkeeping, delta-vs-full planning
│   ├── provenance.js     # Entity provenance tracking, stale-entry expiry, grounding gate
│   ├── schema.js         # Store descriptor + record validators
│   ├── refresh.js        # Full + delta refresh, auto-refresh scheduling, auto-save timer
│   ├── sections.js       # Per-section regeneration
│   └── render.js         # UI rendering, events, archive/import, revert/diff, preview, status chip
├── chronicle/            # Session Chronicle module
│   ├── index.js          # Orchestrator — public API and lifecycle hooks
│   ├── data.js           # Constants, state, settings, data access, anchor helpers (leaf)
│   ├── prompts.js        # System prompts for snapshot + consolidation (leaf)
│   ├── injection.js      # Prompt injection logic
│   ├── snapshots.js      # Generation, validation, CRUD, world state sync
│   ├── import-export.js  # JSON / Markdown export and import
│   ├── schema.js         # Store descriptor + record validators
│   └── render.js         # All UI rendering
├── knowledge/            # Knowledge Tracker module (NPCs + State Trackers + Growth Profile)
│   ├── index.js          # Public API barrel — lifecycle, slash commands, macros
│   ├── state.js          # Constants, shared mutable state, content helpers (leaf)
│   ├── settings.js       # Settings manager + settings panel (leaf)
│   ├── schema.js         # Store descriptors + record validators (registry, counters, [MWT:store])
│   ├── scope.js          # Lorebook scope resolution (global / per-character / per-chat)
│   ├── store.js          # Per-lorebook [MWT:store] registry read/write
│   ├── activation.js     # Switch MWT's lorebooks on/off in SillyTavern's World Info slots
│   ├── reconcile.js      # Import/restore lorebook identity helpers (UID resolution)
│   ├── dossier_status.js # Per-field dossier staleness watermarks (🎯 Fields picker)
│   ├── prompts.js        # NPC scan, state-update, evidence, profile, and consolidation prompts
│   ├── registry.js       # NPC + State Tracker registry operations (chat metadata)
│   ├── lorebook.js       # Lorebook read/write, scan, state update, staging enrichment, profile persistence
│   ├── profiles_audit.js # Profile duplicate/relink audits + prune planning (shared by the console bridge and Overview 🧰)
│   ├── staging.js        # Build staging items from scan results
│   ├── relationships.js  # Relationship storage, change logging, and graph layout computation
│   ├── evidence.js       # Two-tier evidence store (raw/consolidated/archived), ILS watermark tracking, user overrides
│   ├── growth.js         # Evidence capture + quote verification, profile generation, continuous incremental capture, consolidation orchestrator
│   ├── ils_compat.js     # InlineSummary (ILS) de-summarize backfill — read-only ILS originals resolution for verbatim evidence capture
│   └── render.js         # All UI rendering (staging, minor/major, state, graph, growth, settings)
├── story_planner/        # Story Planner module (future plot arcs)
│   ├── index.js          # Thin orchestrator — public API and lifecycle hooks
│   ├── data.js           # Constants, shared mutable state, data access (leaf)
│   ├── settings.js       # Settings manager and defaults (leaf)
│   ├── prompts.js        # Story Architect system + user prompt templates (leaf)
│   ├── injection.js      # Prompt injection (depth, structural boundaries, header)
│   ├── generation.js     # LLM plan generation with chat-switch guards
│   └── render.js         # UI rendering, toolbar/stats, settings panel, event wiring
├── interiority/          # Interiority module (NPC thoughts & hidden intentions)
    ├── index.js          # Orchestrator — public API, event wiring, work queue
    ├── data.js           # Constants, chat-metadata storage, settings, ledger helpers
    ├── lifecycle.js      # Lifecycle history, cross-turn closure dedup, evidence boundaries, per-NPC controls
    ├── capture.js        # Opt-in, in-memory-only intentions generation diagnostics capture
    ├── prompts.js        # System prompt, JSON output contract, injection format
    ├── generation.js     # Context assembly, batched/strict API calls, validation
    ├── injection.js      # <mwt_npc_intentions> extension-prompt injection
    ├── schema.js         # Store descriptor + record validators
    └── render.js         # Settings UI + per-message thought block rendering
└── ambient/             # 🌦️ Ambient Conditions module (deterministic weather; engine lives in core/)
    ├── index.js          # Orchestrator — public API, generation interceptor, /wt-ambient command
    ├── injection.js      # <mwt_ambient> injection through the shared seam
    ├── settings.js       # Per-chat ambient settings + seed access
    └── render.js         # Inline settings section (this chat)
```

The tree above lists the six user-facing modules; five more support directories keep the data-safety layer, the Overview dashboard, the Budget panel, and diagnostics running (see [Data safety in MWT 2.0](../USER_GUIDE.md#data-safety-in-mwt-20--validation-migrations-and-quarantine-explained), [🏠 Overview](../USER_GUIDE.md#-overview), [📊 Budget](../USER_GUIDE.md#-budget), and [🩺 Diagnostics](../USER_GUIDE.md#-diagnostics)):

```
├── schema/               # Schema validation & migrations engine
│   ├── registry.js       # One registry for every authoritative MWT store schema
│   ├── gate.js           # Synchronous O(stores) load classification (ready / prepare / blocked)
│   ├── runtime.js        # Chat-metadata load-gate orchestration (migrate, pause, persist atomically)
│   ├── manifest.js       # mwt_schema_manifest container schema + version helpers
│   └── secondary.js      # Pure validators for secondary persistence (button floats, edit history, message UUIDs)
├── backup/               # Unified backup/restore module (Settings tab panel)
│   ├── index.js          # Public backup API — binds the pure planner to live metadata/lorebooks
│   ├── collect.js        # Runtime collection of a chat's MWT data
│   ├── data.js           # Pure backup-envelope data model (no SillyTavern dependencies)
│   ├── restore.js        # Pure restore strategies + dry-run planner (plans only, never writes)
│   ├── validate.js       # Compatibility adapter over the schema registry
│   ├── recovery.js       # Quarantine recovery export/clear — refused records stay recoverable
│   └── render.js         # Backup / Restore panel UI
├── budget/               # 📊 Budget tab (enforcement engine lives in core/budget.js)
│   ├── panel.js          # Budget panel UI — shares the one planner the injection seam uses
│   └── style.css         # Budget panel styles
├── dashboard/            # 🏠 Overview tab (read-only status cards + 🧰 Maintenance)
│   ├── status.js         # Guarded status-snapshot collector (one cell per module signal)
│   ├── render.js         # Overview pane — cards, deep links, findings, preview/confirm modals
│   ├── maintenance.js    # Read-only maintenance findings + guarded apply wrappers
│   └── style.css         # Overview pane styles
└── diagnostics_panel/    # 🩺 Diagnostics tab (read-only, in-memory)
    ├── render.js         # Panel shell, sub-tab strip, Health/Environment panes, Copy Report
    ├── health.js         # ❤️ Health snapshot (per-module status)
    ├── environment.js    # 🌐 Environment snapshot (versions, feature detection)
    ├── scope_storage.js  # 🗂️ Scope & storage snapshot (lorebook resolution, store versions)
    ├── injection.js      # 💉 Injection snapshot (resolved placement + recorded payloads)
    ├── last_request.js   # 📡 Last-request snapshot (API telemetry)
    ├── log.js            # 📋 Log snapshot + redaction gate
    ├── integrity.js      # 🛡️ Integrity snapshot (schema/quarantine status)
    └── report.js         # Copy-report Markdown shape
```

## Module Communication

- Modules read shared global settings (injection depth/role, structural boundaries, enable flags) via `getGlobalSettings()` and `injectionAllowed()` in `core/settings.js`; the global Settings tab pushes API config to each module through their `syncGlobalSettings()`
- The Chronicle module can sync time/location data back to World State
- The Knowledge module reads World State and Chronicle data for richer scan context
- The Story Planner reads recent chat history to ground its suggestions
- The Interiority module reads the World State for the scene roster, the Knowledge Tracker for per-NPC dossiers, and injects `<mwt_npc_intentions>` back into the prompt
- All modules respond to SillyTavern events:
  - `CHAT_CHANGED` — reset module state for the new chat
  - `MESSAGE_RECEIVED` — advance auto-refresh / auto-snapshot / auto-trigger / auto-plan / auto-thoughts counters
  - `GENERATION_STARTED` / `GENERATION_STOPPED` — gate chronicle work during main generation
  - `MESSAGE_DELETED` — decrement counters and invalidate stale chronicle anchors; Interiority restores ledger snapshots
  - `MESSAGE_SWIPED` / `MESSAGE_EDITED` — schedule world state refresh (if auto-refresh enabled), flag stale chronicle anchors, and rollback Interiority ledger state
